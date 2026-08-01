#!/usr/bin/env node
/**
 * Core-side vCard importer (`npm run import:contacts`) — not a connector, despite parsing an
 * external file format. Contacts are the spine of the entity graph (design §2.2): each contact
 * seeds a person `entity` + its `entity_aliases` (name/email/phone) via insertEntityStmt.run(...)
 * directly, and a `type='contact'` artifact so the person is semantically searchable and
 * everything else can hard-link to them later. Doc 04 §1.2 forbids exactly that direct
 * entity-graph write from a connector ("connectors never see or assert entity IDs... one buggy
 * community connector can therefore never corrupt the contacts spine") — this file IS the
 * authoritative writer of that spine, so it sits on core's side of the who-writes-the-graph line
 * (doc 04 §1.2a documents this as the one deliberate exception to "core holds no source-specific
 * knowledge"). It is not a loophole; it is the same line, viewed from the entity-graph side.
 *
 * Isolated, restartable script (design §3): idempotent via (source, source_id=UID) or
 * content_hash, and it merges a contact into an existing entity when an alias already
 * resolves — accepting the occasional manual merge over chasing full auto-resolution.
 *   Run:  npm run import:contacts <file.vcf>
 *
 * Hand-rolled minimal vCard parser (built-ins over deps): RFC line-unfolding plus a
 * connector-agnostic contact superset (docs/03-ob2-design.md §2.2) that Apple/Google/Android
 * exports map onto. Apple 3.0 groups labeled properties under an `itemN.` prefix and carries
 * an `X-ABLabel` sibling (e.g. `item1.X-ABDATE` + `item1.X-ABLabel:_$!<Anniversary>!$_`); we
 * split the group prefix off the property name and pair each value with its label after the
 * whole card is read (order-independent). vCard 4.0 equivalents (ANNIVERSARY/RELATED/NICKNAME)
 * are read by property name too, so both versions land in the same shape.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  db, storeArtifactTxn, upsertArtifactTxn, getArtifactBySource, getSelfEntityId, sha256, logEvent,
  insertEntityStmt, insertAliasUnlessTombstoned, resolveEntityIds, normalizeName, normalizePhone, nameVariants,
  canonicalRelationType, upsertEntityRelation, stageRelationHint, resolveRelationHints,
  resolveStagedArtifactHints, ensureOrgEntity, reconcileHandleAliases,
} from './db.js';
import { embedToFloat32 } from './embeddings.js';
import { log } from './logger.js';
import { CONTACTS_RAW_DIR } from './config.js';

const findByHash = db.prepare('SELECT id FROM artifacts WHERE content_hash = ? LIMIT 1');

// RFC 2426 §3.2.1: an ADR value is exactly 7 semicolon-separated components
// (pobox;ext;street;locality;region;postal;country). Anything past the 7th is an exporter extension,
// not part of the address — see the ADR case in finalizeCard (#493).
const ADR_COMPONENTS = 7;
// The separator the surviving ADR components are flattened with. Single-sourced because the #493
// repair detector below has to split on exactly what the parser joined with.
const ADDRESS_JOIN = ', ';
// The separator contactTextRepr joins SEVERAL addresses with (chosen in #92 to avoid colliding with
// the ', ' inside one flattened address). Exported because the #493 repair has to recognise it when
// collapsing a duplicate the repair itself created in already-embedded prose.
export const ADDRESS_LIST_JOIN = '; ';

// Legacy single-property IM extensions (pre-IMPP). service = the tag after `X-`.
const LEGACY_IM_PROPS = new Set([
  'X-AIM', 'X-MSN', 'X-YAHOO', 'X-ICQ', 'X-JABBER', 'X-SKYPE', 'X-SKYPE-USERNAME', 'X-GTALK', 'X-GADUGADU', 'X-GROUPWISE',
]);

// Single-pass unescape: decode each escape once so a literal escaped backslash (\\n) isn't
// re-interpreted by a later pass.
const unescape = (v) => v.replace(/\\([nN,;\\])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));

// Apple wraps its built-in label tokens as `_$!<Anniversary>!$_`; custom labels are stored
// verbatim. Decode the wrapper, pass everything else through unchanged.
export function decodeAppleLabel(label) {
  if (!label) return label;
  const m = label.match(/^_\$!<(.*)>!\$_$/);
  return m ? m[1] : label;
}

// Split a vCard property head into an optional `itemN` group, the uppercased property name,
// and its params ([{key, value}], keys uppercased; keys may repeat, e.g. TYPE=HOME;TYPE=CELL).
function splitProp(head) {
  const tokens = head.split(';');
  let name = tokens[0];
  let group = null;
  const gm = name.match(/^(item\d+)\.(.+)$/i);
  if (gm) { group = gm[1].toLowerCase(); name = gm[2]; }
  const params = tokens.slice(1).map((t) => {
    const eq = t.indexOf('=');
    return eq === -1
      ? { key: t.toUpperCase(), value: '' }
      : { key: t.slice(0, eq).toUpperCase(), value: t.slice(eq + 1) };
  });
  return { group, prop: name.toUpperCase(), params };
}

const paramValue = (params, key) => {
  const p = params.find((x) => x.key === key.toUpperCase());
  return p ? p.value : null;
};

// vCard date encodings vary (19930808, 1993-08-08, --0808); normalize a full YYYYMMDD/
// YYYY-MM-DD to dashed form for the embedded text, pass anything else through untouched.
// The raw value is kept in the structured `dates[]` field — this is display-only.
function formatVcardDate(v) {
  const m = String(v).match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
}

// An IMPP value is a URI (`xmpp:user@host`, `aim:goim?screenname=foo`); the service comes from
// the X-SERVICE-TYPE param when present, else the URI scheme. handle = the part after the scheme.
function parseImpp(value, params) {
  const colon = value.indexOf(':');
  const scheme = colon === -1 ? null : value.slice(0, colon);
  const handle = colon === -1 ? value : value.slice(colon + 1);
  return { service: paramValue(params, 'X-SERVICE-TYPE') || scheme, handle };
}

const PHOTO_EXT_BY_MEDIA = [[/PNG/i, 'png'], [/GIF/i, 'gif'], [/JPE?G/i, 'jpg']];
// Falls back to the MIME subtype itself (e.g. "image/heic" -> "heic") when it isn't one of the
// three canonicalized aliases above, rather than defaulting every unrecognized type to '.jpg' —
// a HEIC/WEBP/etc. photo's file extension should match what its bytes actually are.
function extForPhotoType(t) {
  const known = PHOTO_EXT_BY_MEDIA.find(([re]) => re.test(t ?? ''))?.[1];
  if (known) return known;
  const subtype = String(t ?? '').match(/^image\/([a-z0-9.+-]+)$/i)?.[1];
  return subtype ? subtype.toLowerCase().replace(/[^a-z0-9]/g, '') || null : null;
}

// Parse a vCard PHOTO property into a pure descriptor — no I/O here (finalizeCard stays a
// pure parser; decode/write happens in persistContactPhoto). Three shapes: vCard 4.0 inline
// `data:` URI (tolerating extra ;param=value segments per RFC 2397, e.g. ";charset=binary"
// before ";base64,"), an external http(s) URI (never fetched — see persistContactPhoto), and
// vCard 3.0 `ENCODING=b`/`BASE64` + `TYPE=`. Unrecognized shapes return null (photo silently
// absent, same as no PHOTO property at all — this is optional data, not a required field).
export function parsePhoto(value, params) {
  const typeParam = paramValue(params, 'TYPE');
  const mediaTypeParam = paramValue(params, 'MEDIATYPE');
  const dataUri = value.match(/^data:([^;,]*)(?:;[a-zA-Z0-9.-]+=[^;,]*)*;base64,(.*)$/is);
  if (dataUri) {
    const mediaType = dataUri[1] || mediaTypeParam || 'image/jpeg';
    return { kind: 'base64', data: dataUri[2], mediaType, ext: extForPhotoType(mediaType) || extForPhotoType(typeParam) || 'jpg' };
  }
  if (/^https?:\/\//i.test(value)) {
    return { kind: 'uri', url: value, mediaType: mediaTypeParam || (typeParam ? `image/${typeParam.toLowerCase()}` : null) };
  }
  const encoding = (paramValue(params, 'ENCODING') || '').toUpperCase();
  if (encoding === 'B' || encoding === 'BASE64') {
    const mediaType = mediaTypeParam || (typeParam ? `image/${typeParam.toLowerCase()}` : 'image/jpeg');
    return { kind: 'base64', data: value, mediaType, ext: extForPhotoType(typeParam) || extForPhotoType(mediaTypeParam) || 'jpg' };
  }
  return null;
}

// Strict base64 decode: rejects anything containing non-base64 characters, or a length that
// isn't a multiple of 4 (a truncated/corrupted payload), rather than Node's lenient
// Buffer.from (which silently skips invalid chars and decodes a truncated group anyway,
// returning non-empty-but-corrupt bytes). A vCard PHOTO worth keeping should decode cleanly;
// garbage or truncated input becomes a logged skip, not a corrupt image file.
function decodeBase64Strict(raw) {
  const cleaned = raw.replace(/\s+/g, '');
  if (!cleaned || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  return Buffer.from(cleaned, 'base64');
}

// Decode/write a photo descriptor (I/O layer — called before the transaction, like the embed
// call). Inline base64 -> content-addressed file under CONTACTS_RAW_DIR (idempotent: same
// bytes -> same path, skip-if-exists). External URI -> record the URL only, never fetched
// (contacts import must not make arbitrary network requests). Returns null (and logs) on any
// decode/write failure so one bad photo never aborts the rest of the import.
export function persistContactPhoto(photo) {
  if (!photo) return null;
  try {
    if (photo.kind === 'uri') return { photo_url: photo.url, media_type: photo.mediaType ?? null };
    if (photo.kind === 'base64') {
      const bytes = decodeBase64Strict(photo.data);
      if (!bytes || !bytes.length) throw new Error('undecodable or empty PHOTO data');
      // This function is exported and takes a raw descriptor — never trust photo.ext as a
      // filename fragment even though the only current caller (parsePhoto) already sanitizes
      // it: a short alnum-only allowlist is what stands between this and a path-traversal
      // write outside CONTACTS_RAW_DIR (e.g. ext="../../x") for any future/direct caller.
      const safeExt = /^[a-z0-9]{1,10}$/i.test(photo.ext ?? '') ? photo.ext : 'jpg';
      // path.resolve, not path.join: CONTACTS_RAW_DIR defaults to a relative value, and this
      // path gets read back by a LATER process (the server, possibly started from a different
      // cwd, or a connector on another machine) — resolving to absolute NOW, against this
      // import's own cwd, is the only time the correct base directory is unambiguous. Storing a
      // relative path would leave every future reader guessing which cwd it was relative to.
      const rawPath = path.resolve(CONTACTS_RAW_DIR, `${sha256(bytes)}.${safeExt}`);
      mkdirSync(path.dirname(rawPath), { recursive: true });
      try {
        // Exclusive create, not existsSync-then-write: avoids a check-then-act race under
        // concurrent imports. Content-addressed by sha256, so EEXIST always means identical
        // bytes are already there — safe to treat as success, not a real conflict.
        writeFileSync(rawPath, bytes, { flag: 'wx' });
      } catch (writeErr) {
        if (writeErr.code !== 'EEXIST') throw writeErr;
      }
      return { raw_path: rawPath, media_type: photo.mediaType ?? null };
    }
  } catch (err) {
    log.error('contacts.photo.failed', 'could not persist a contact photo', err);
  }
  return null;
}

// Persist already-decoded image bytes to the same content-addressed store persistContactPhoto's
// base64 branch uses — the contacts-UI upload path (#96). sha256-named file under
// CONTACTS_RAW_DIR, exclusive 'wx' write (identical bytes -> EEXIST -> no-op, never overwrites).
// Returns the bare basename (never a path): the caller records it in attrs.photoFile and the
// photo route resolves it back under CONTACTS_RAW_DIR, so a traversal-y name can't escape. The
// ext is derived from the declared media type (same allowlist as persistContactPhoto). Async
// (fs/promises) because the only caller is the server's upload route — coding-standards.md bans
// blocking sync I/O on the request path (persistContactPhoto stays sync: it runs in the import
// script, off the request path). Throws on empty input or a real write error; the route maps that
// to a 4xx/5xx.
export async function savePhotoBytes(bytes, mediaType) {
  // The one filesystem write on the request path, so it is an outbound span (#328). Neither the
  // basename (a content hash of the user's photo) nor the path is logged — only size and format.
  return log.span('fs.photo.saved', async () => {
    if (!bytes || !bytes.length) throw new Error('empty photo bytes');
    const ext = extForPhotoType(mediaType);
    const safeExt = /^[a-z0-9]{1,10}$/i.test(ext ?? '') ? ext : 'jpg';
    const basename = `${sha256(bytes)}.${safeExt}`;
    const rawPath = path.resolve(CONTACTS_RAW_DIR, basename);
    await mkdir(path.dirname(rawPath), { recursive: true });
    try {
      await writeFile(rawPath, bytes, { flag: 'wx' });
    } catch (writeErr) {
      if (writeErr.code !== 'EEXIST') throw writeErr;
    }
    return basename;
  }, { bytes: bytes?.length ?? 0, ext: extForPhotoType(mediaType) ?? null });
}

// Build the connector-agnostic contact object from a card's parsed property lines. Labels are
// resolved first (a group's X-ABLabel may precede OR follow its value line), then each line is
// routed. New list fields default to []; scalar fields are absent unless present. `address`,
// `org` (scalars) are kept as before for back-compat; `addresses[]` carries the full list.
function finalizeCard(lines, raw) {
  const c = {
    emails: [], phones: [], addresses: [], urls: [], dates: [], relatedNames: [],
    categories: [], nicknames: [], im: [], socialProfiles: [], raw,
  };
  const groupLabels = {};
  for (const l of lines) {
    if (l.group && l.prop === 'X-ABLABEL') groupLabels[l.group] = decodeAppleLabel(l.value);
  }
  for (const { group, prop, params, value } of lines) {
    const label = group ? groupLabels[group] : null;
    switch (prop) {
      case 'FN': c.fn = value; break;
      case 'N': {
        const [family, given, additional, prefix, suffix] = value.split(';');
        c.name = { family, given, additional, prefix, suffix };
        if (!c.fn) c.fn = [given, family].filter(Boolean).join(' ').trim() || value;
        break;
      }
      case 'EMAIL': c.emails.push(value); break;
      case 'TEL': c.phones.push(value); break;
      case 'BDAY': c.birthday = value; break;
      // An RFC 2426 ADR has exactly 7 components (pobox;ext;street;locality;region;postal;country).
      // Some exporters append an 8th: the whole address again, pre-formatted as a mailing label — and
      // an unbounded join folded it into the same string, storing the address twice (#493). slice(0, 7)
      // runs BEFORE filter(Boolean): slicing after would let a trailing label slide into a slot vacated
      // by the empty pobox/ext of the near-universal 'ADR:;;street;…' shape, keeping the bug. A newline
      // inside one of the 7 (an apartment line) is preserved.
      case 'ADR': { const a = value.split(';').slice(0, ADR_COMPONENTS).filter(Boolean).join(ADDRESS_JOIN); c.address = a; c.addresses.push(a); break; }
      case 'ORG': { const parts = value.split(';'); c.org = parts.filter(Boolean).join(', '); const name = parts[0]?.trim(); if (name) c.orgName = name; if (parts[1]) c.department = parts[1]; break; }
      case 'TITLE': c.title = value; break;
      case 'ROLE': c.role = value; break;
      case 'NOTE': c.note = value; break;
      case 'UID': c.uid = value; break;
      case 'NICKNAME': for (const n of value.split(',').map((s) => s.trim()).filter(Boolean)) c.nicknames.push(n); break;
      case 'URL': c.urls.push(value); break;
      case 'CATEGORIES': for (const g of value.split(',').map((s) => s.trim()).filter(Boolean)) c.categories.push(g); break;
      case 'X-ABDATE': c.dates.push({ type: label || 'Other', value }); break;
      case 'ANNIVERSARY': c.dates.push({ type: 'Anniversary', value }); break; // vCard 4.0
      case 'X-ABRELATEDNAMES': c.relatedNames.push({ type: label || 'Other', name: value }); break;
      case 'RELATED': c.relatedNames.push({ type: paramValue(params, 'TYPE') || label || 'Other', name: value }); break; // vCard 4.0
      // Google/Android single-property relationship extensions (#93): the relation type is the
      // tag after `X-`, lowercased (canonicalRelationType maps spouse/child/parent/manager/etc.).
      case 'X-SPOUSE': case 'X-PARTNER': case 'X-CHILD': case 'X-PARENT':
      case 'X-MOTHER': case 'X-FATHER': case 'X-BROTHER': case 'X-SISTER':
      case 'X-FRIEND': case 'X-MANAGER': case 'X-ASSISTANT':
        c.relatedNames.push({ type: prop.replace(/^X-/, '').toLowerCase(), name: value }); break;
      case 'IMPP': c.im.push(parseImpp(value, params)); break;
      case 'X-SOCIALPROFILE': c.socialProfiles.push({ service: paramValue(params, 'TYPE'), url: value }); break;
      case 'X-PHONETIC-FIRST-NAME': (c.phonetic ??= {}).given = value; break;
      case 'X-PHONETIC-LAST-NAME': (c.phonetic ??= {}).family = value; break;
      case 'X-ABSHOWAS': if (value.toUpperCase() === 'COMPANY') c.isCompany = true; break;
      case 'KIND': if (value.toLowerCase() === 'org') c.isCompany = true; break;
      // A card with more than one PHOTO line (e.g. a full photo plus a thumbnail variant) keeps
      // only the last one successfully parsed — deliberate, not a bug: `c` is a scalar `photo`
      // field (one preserved image per contact), matching every other scalar vCard field here.
      case 'PHOTO': { const p = parsePhoto(value, params); if (p) c.photo = p; break; }
      default:
        if (LEGACY_IM_PROPS.has(prop)) c.im.push({ service: prop.replace(/^X-/, '').replace(/-USERNAME$/, ''), handle: value });
        break;
    }
  }
  return c;
}

/**
 * Parse vCard text into structured contact objects. Exported for unit testing.
 * Handles RFC line-folding (continuation lines begin with space/tab), the Apple `itemN.` group
 * prefix, and multi-valued properties. Returns the connector-agnostic superset objects
 * (see finalizeCard): { fn, name, emails[], phones[], addresses[], address, org, title, role,
 * birthday, dates[], relatedNames[], categories[], nicknames[], urls[], im[], socialProfiles[],
 * phonetic, isCompany, note, uid, photo, raw }.
 */
export function parseVCards(text) {
  // Unfold folded lines, then normalize line endings.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  const cards = [];
  let lines = null;    // parsed property lines of the current card
  let raw = null;      // trimmed raw lines, joined at END for content_hash
  for (const line of unfolded.split('\n')) {
    const trimmed = line.trim();
    if (/^BEGIN:VCARD$/i.test(trimmed)) { lines = []; raw = [trimmed]; continue; }
    if (lines == null) continue;
    raw.push(trimmed);
    if (/^END:VCARD$/i.test(trimmed)) { cards.push(finalizeCard(lines, raw.join('\n'))); lines = null; raw = null; continue; }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const value = unescape(line.slice(colon + 1).trim());
    if (!value) continue;
    const { group, prop, params } = splitProp(line.slice(0, colon)); // strip group + params
    lines.push({ group, prop, params, value });
  }
  return cards.filter((c) => c.fn || c.emails.length || c.phones.length);
}

// #493 repair detector — exported for scripts/fix-duplicated-addresses.js and its tests. Rows written
// before the ADR bound above hold the component list followed by the exporter's pre-formatted label:
// "<street>, <city>, <region>, <postal>, <country>, <all of that again>". Detection is structural
// rather than pattern-guessed: split on the separator the parser joined with, then look for a split
// point where everything AFTER it is — ignoring all punctuation, whitespace, and case — the same
// characters as everything before it. That normalization is what lets one check cover every stored
// variant, since the appended label arrives with real newlines, with escaped ones, or (unfolded) with
// its separators gone entirely. A genuine second address does not repeat the first's characters, so it
// never matches; a value with nothing to strip is returned unchanged.
// Unicode letter/number classes, NOT [^a-z0-9]: an ASCII-only class strips every Cyrillic/CJK/Greek
// character, so two genuinely different non-Latin addresses would key down to their digits alone,
// compare equal, and the second would be silently deleted by a write with no undo — the exact outcome
// this function promises cannot happen.
const addressKey = (s) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

export function stripRedundantAddressLabel(address) {
  if (typeof address !== 'string') return address;
  const segs = address.split(ADDRESS_JOIN);
  for (let k = 1; k < segs.length; k++) {
    const head = addressKey(segs.slice(0, k).join(''));
    // An all-punctuation head would key to '' and match an equally empty tail — never a real
    // duplicate, so require something substantive on the left before collapsing.
    if (!head) continue;
    // A single-segment head with no digit is not a mailing label restatement — it is a legitimately
    // repeated component. `ADR:;;;Singapore;;;Singapore` (locality + country for a city-state; also
    // Hong Kong, Monaco, Luxembourg, Macau) flattens to "Singapore, Singapore", and collapsing that
    // would delete a real component and count the row as repaired. A real label restatement always
    // carries either the street number or the postal code, hence the digit escape hatch — so
    // "123 Main St, 123 Main St" is still repaired.
    if (k < 2 && !/\p{N}/u.test(head)) continue;
    if (head === addressKey(segs.slice(k).join(''))) return segs.slice(0, k).join(ADDRESS_JOIN);
  }
  return address;
}

// A key shorter than this is too small for containment to mean anything ("us" is inside almost
// everything). Only used by the report-only check below, never by the write path.
const MIN_SUSPECT_KEY = 12;

/**
 * #493, report-only: does this value look like an appended label that stripRedundantAddressLabel will
 * NOT repair? The strip above demands an EXACT key match, but a real exporter can restate the address
 * inexactly — Apple omits the country from a formatted label when it matches the locale, and others
 * truncate ZIP+4 or spell the state out. Those rows stay corrupted, and without this the repair run
 * would print a byte-identical "0 repaired" for a clean store and for one with a residual population.
 * Deliberately NOT wired into the strip itself: a fuzzy match must never authorize a write with no
 * undo. Containment-based, so a genuine second address (whose key contains neither side of the other)
 * does not trip it; a false positive here only inflates a reported count.
 */
export function suspectsRedundantAddressLabel(address) {
  if (typeof address !== 'string') return false;
  // Delegate "is this repairable?" to the one authority rather than re-deriving it. Checking
  // containment first would misreport every exactly-doubled value as a suspect too: at k=1 the tail of
  // "<street>, <city>, …, <street><city>…" trivially contains the head, long before the split point
  // where the two keys are actually equal.
  if (stripRedundantAddressLabel(address) !== address) return false;
  const segs = address.split(ADDRESS_JOIN);
  for (let k = 1; k < segs.length; k++) {
    const head = addressKey(segs.slice(0, k).join(''));
    const tail = addressKey(segs.slice(k).join(''));
    if (head.length < MIN_SUSPECT_KEY || tail.length < MIN_SUSPECT_KEY) continue;
    if (head.includes(tail) || tail.includes(head)) return true;
  }
  return false;
}

// Assemble the natural-language text_repr that gets embedded. Every superset field that carries
// recall value is folded in as a labeled line so keyword + semantic search can reach it.
// Exported for unit testing alongside parseVCards.
export function contactTextRepr(c) {
  const parts = [c.fn || c.emails[0] || 'Unnamed contact'];
  if (c.title || c.org) parts.push([c.title, c.org].filter(Boolean).join(' at '));
  if (c.nicknames.length) parts.push(`Nickname: ${c.nicknames.join(', ')}`);
  if (c.emails.length) parts.push(`Email: ${c.emails.join(', ')}`);
  if (c.phones.length) parts.push(`Phone: ${c.phones.join(', ')}`);
  if (c.birthday) parts.push(`Birthday: ${c.birthday}`);
  for (const d of c.dates) parts.push(`${d.type}: ${formatVcardDate(d.value)}`);
  // All addresses, not just the last-parsed scalar `c.address` (#92): a contact with several
  // mailing addresses must be recallable by any of them. filter(Boolean) drops an empty ADR
  // (a component-only line like `ADR:;;;;;;` flattens to '') so we don't emit a bare "Address: ",
  // matching the old `if (c.address)` skip; de-dup (vCard/CSV often carry near-identical variants);
  // the '; ' separator avoids collision with the ', ' inside one flattened address (the ADR join
  // above). c.addresses is always defined ([] default in finalizeCard).
  const uniqueAddresses = [...new Set(c.addresses.filter(Boolean))];
  if (uniqueAddresses.length) parts.push(`Address: ${uniqueAddresses.join(ADDRESS_LIST_JOIN)}`);
  for (const r of c.relatedNames) parts.push(`${r.type}: ${r.name}`);
  if (c.urls.length) parts.push(`URL: ${c.urls.join(', ')}`);
  if (c.im.length) parts.push(`IM: ${c.im.map((i) => (i.service ? `${i.service}:${i.handle}` : i.handle)).join(', ')}`);
  if (c.socialProfiles.length) parts.push(`Social: ${c.socialProfiles.map((s) => (s.service ? `${s.service} ${s.url}` : s.url)).join(', ')}`);
  if (c.categories.length) parts.push(`Categories: ${c.categories.join(', ')}`);
  if (c.note) parts.push(c.note);
  return parts.join('. ') + '.';
}

// The structured superset fields, shared by the entity attrs and the artifact extra_json.
function structuredFields(c) {
  return {
    emails: c.emails, phones: c.phones, addresses: c.addresses,
    nicknames: c.nicknames, dates: c.dates, relatedNames: c.relatedNames,
    categories: c.categories, urls: c.urls, im: c.im, socialProfiles: c.socialProfiles,
  };
}

// The Anniversary entry of dates[] — finalizeCard normalizes both vCard-4 ANNIVERSARY and an
// X-ABDATE whose X-ABLabel is "Anniversary" into dates[], so one lookup covers both (#304). The
// label is user-typed in Apple Contacts, hence the case-insensitive compare. null when absent.
const anniversaryOf = (c) => (c.dates ?? []).find((d) => String(d?.type ?? '').toLowerCase() === 'anniversary')?.value ?? null;

// The entity-profile attrs shape (attrs_json), shared by the contact importer and the side-directory
// loader (#304) so the two cannot drift — a field the importer stores must be a field a promoted
// directory card can supply. `anniversary` is DERIVED here and was previously UI-only: importOneTxn
// never built the key, so a vCard ANNIVERSARY line could not reach the UI's Anniversary field.
export function contactAttrs(c) {
  return {
    ...structuredFields(c),
    birthday: c.birthday ?? null, anniversary: anniversaryOf(c), address: c.address ?? null,
    org: c.org ?? null, department: c.department ?? null,
    title: c.title ?? null, role: c.role ?? null, note: c.note ?? null,
    phonetic: c.phonetic ?? null, isCompany: c.isCompany ?? false,
  };
}

// The display (canonical) name for a person (#156): given+family when a middle name is present, so
// the contacts UI and search show "Amy Fenwick", not "Amy Margaret Fenwick". The full FN is
// still emitted as a name alias by nameVariants, so resolution by the middle-name form keeps
// working. Mirrors nameVariants' derive cutoff (structured `additional`, or exactly a 3-token FN;
// 2- and 4+-token names are left unchanged — a 4+ compound surname can't be reduced safely).
// Orgs keep their full name. Case is preserved (this is a display string, unlike the aliases).
export function preferredDisplayName(c) {
  if (c.isCompany || !c.fn) return c.fn || '';
  const toks = c.fn.trim().split(/\s+/);
  const given = c.name?.given || toks[0];
  const family = c.name?.family || (toks.length === 3 ? toks[toks.length - 1] : null);
  const hasMiddle = Boolean(c.name?.additional) || toks.length === 3;
  return hasMiddle && given && family ? `${given} ${family}` : c.fn;
}

// Reuse an existing entity if any email or the name already resolves to one.
function resolveExistingEntity(c) {
  for (const email of c.emails) { const ids = resolveEntityIds(email); if (ids.length) return ids[0]; }
  if (c.fn) { const ids = resolveEntityIds(c.fn); if (ids.length) return ids[0]; }
  return null;
}

// Turn parsed relatedNames[] into person<->person edges (issue #37). A related name that
// already resolves to an entity becomes an edge now; one that doesn't is staged on this
// contact's artifact and formed later when that person is imported. Then resolve any relations
// that earlier imports staged pointing at THIS person (the reverse import order).
function linkRelations(fromEntityId, artifactId, relatedNames) {
  for (const rel of relatedNames) {
    if (!rel?.name) continue;
    const relationType = canonicalRelationType(rel.type);
    const targets = resolveEntityIds(rel.name).filter((id) => id !== fromEntityId);
    if (targets.length) {
      for (const toId of targets) {
        upsertEntityRelation({ from_entity_id: fromEntityId, to_entity_id: toId, relation_type: relationType, raw_label: rel.type, confidence: 1.0, source: 'vcard' });
      }
    } else if (relationType === 'worksAt') {
      // The employer named on a person's card has no matching org contact yet: mint the org now
      // (#125) instead of only staging. Trusted contact data, so NOT gated by the proposed-entities
      // queue. ONLY worksAt auto-creates its target — a person named as someone's sister must stay
      // staged (below), never mint a stub person. Idempotent via ensureOrgEntity's resolve-first.
      const orgId = ensureOrgEntity(rel.name);
      if (orgId !== fromEntityId) {
        upsertEntityRelation({ from_entity_id: fromEntityId, to_entity_id: orgId, relation_type: relationType, raw_label: rel.type, confidence: 1.0, source: 'vcard' });
      }
    } else {
      stageRelationHint(artifactId, rel.name, rel.type);
    }
  }
  resolveRelationHints(fromEntityId);
}

// One contact -> entity(+aliases) + contact artifact + self link, atomically. `photo` is the
// already-persisted-to-disk result of persistContactPhoto (or null) — I/O happens before this
// transaction opens, same as the embed call.
const importOneTxn = db.transaction((c, textRepr, contentHash, vec, photo) => {
  let entityId = resolveExistingEntity(c);
  let entityCreated = false;
  if (entityId == null) {
    const attrs = contactAttrs(c);
    entityId = insertEntityStmt.run(c.isCompany ? 'org' : 'person', preferredDisplayName(c) || c.emails[0] || 'Unnamed', JSON.stringify(attrs)).lastInsertRowid;
    entityCreated = true;
  }
  // Name aliases: full FN + nickname(s) + the derived given+family and nickname+family variants
  // (#93) so a related-name reference that drops the middle name or pairs a nickname with the
  // surname still resolves. INSERT OR IGNORE makes the (nick-only) overlap with the base case safe.
  // `derive` is off for orgs — a company name has no given/family to reduce (#93 review).
  // Through the tombstone guard (#111) so a re-import can't resurrect an alias the user deliberately
  // removed in the UI. INSERT OR IGNORE inside the helper keeps the nick-only overlap safe.
  for (const alias of nameVariants({ fn: c.fn, given: c.name?.given, family: c.name?.family, additional: c.name?.additional, nicknames: c.nicknames, derive: !c.isCompany }))
    insertAliasUnlessTombstoned(entityId, alias, 'name');
  // #409: the one email/phone alias writer (set-based, tombstone-respecting) — shared with the UI
  // and every other attrs_json writer, so import and profile edits can't define "aliased" differently.
  reconcileHandleAliases(entityId, { emails: c.emails, phones: c.phones }, { explicit: false });
  // Retroactively link artifacts whose hints were staged before this person's aliases existed
  // (#102). Unconditional (a dedup-merge can pool new aliases too); idempotent, so a re-import
  // forms 0 new links. This is the automatic steady-state path — not a scheduled job.
  const linksFormed = resolveStagedArtifactHints(entityId);

  const extra = photo ? { ...structuredFields(c), photo } : structuredFields(c);
  const res = storeArtifactTxn(
    { type: 'contact', source: 'vcard', source_id: c.uid ?? null, content_hash: contentHash,
      text_repr: textRepr, raw_path: photo?.raw_path ?? null, extra_json: JSON.stringify(extra) },
    vec,
    [{ entity_id: entityId, role: 'self', confidence: 1.0 }]
  );
  // Relations need the self-link (just written) to derive the "from" side of a staged hint.
  // Skip on a dedup hit — the first import already formed/staged them (all steps are idempotent).
  // A person's ORG name rides the same machinery as a synthetic worksAt relation (#88): it forms
  // a person->org edge when a matching org contact exists, else stages until one is imported.
  // Guarded by !isCompany so an org card never self-links via its own ORG line.
  if (!res.deduped) {
    const relations = c.orgName && !c.isCompany
      ? [...c.relatedNames, { type: 'worksAt', name: c.orgName }]
      : c.relatedNames;
    linkRelations(entityId, res.id, relations);
  }
  return { entityCreated, artifactId: res.id, deduped: res.deduped, linksFormed };
});

// Re-import of a CHANGED, already-imported card (#94): update the derived searchable artifact in
// place via upsertArtifactTxn — text_repr + embedding + extra_json — while it freezes the originals
// (raw_path/content_hash/ingested_at) and logs ingest_update. The entity PROFILE (attrs_json/
// canonical_name) is deliberately NOT touched: the contacts UI owns it (#97). Aliases + relations
// refresh additively against the self-linked entity, through the tombstone guard (#111) so a
// UI-removed alias isn't resurrected. Photo stays frozen — carry the existing extra_json.photo
// forward rather than re-persisting the card's PHOTO. Caller embeds `vec` before this txn opens.
const updateOneTxn = db.transaction((c, existing, textRepr, vec) => {
  const entityId = getSelfEntityId(existing.id);
  // Guard the parse: extra_json is our own JSON, but a manual edit / older-version / partial write
  // could be malformed — a raw JSON.parse throw would abort the whole import. Treat it as empty
  // (log, never swallow) so the re-import still refreshes text_repr; only the carried-forward photo
  // metadata is lost in that (rare) case.
  let existingExtra = {};
  try { if (existing.extra_json) existingExtra = JSON.parse(existing.extra_json); }
  catch (err) { log.warn('contacts.extra_json.malformed', 'malformed extra_json on re-import, treating as empty', { artifact_id: existing.id, err_type: err?.name ?? null }); }
  const extra = existingExtra.photo ? { ...structuredFields(c), photo: existingExtra.photo } : structuredFields(c);
  upsertArtifactTxn(
    { type: 'contact', source: 'vcard', source_id: c.uid, text_repr: textRepr, extra_json: JSON.stringify(extra) },
    vec, [],
  );
  let linksFormed = 0;
  if (entityId != null) {
    for (const alias of nameVariants({ fn: c.fn, given: c.name?.given, family: c.name?.family, additional: c.name?.additional, nicknames: c.nicknames, derive: !c.isCompany }))
      insertAliasUnlessTombstoned(entityId, alias, 'name');
    for (const e of c.emails) insertAliasUnlessTombstoned(entityId, normalizeName(e), 'email');
    for (const p of c.phones) { const d = normalizePhone(p); if (d) insertAliasUnlessTombstoned(entityId, d, 'phone'); }
    const relations = c.orgName && !c.isCompany ? [...c.relatedNames, { type: 'worksAt', name: c.orgName }] : c.relatedNames;
    linkRelations(entityId, existing.id, relations);
    linksFormed = resolveStagedArtifactHints(entityId);
  }
  return { linksFormed };
});

export async function importContacts(text) {
  const cards = parseVCards(text);
  let entitiesCreated = 0, artifacts = 0, updated = 0, skipped = 0, photos = 0, linksFormed = 0;
  for (const c of cards) {
    const textRepr = contactTextRepr(c);
    const contentHash = sha256(c.raw);
    // UID-bearing card: look up the existing artifact and compare its derived text_repr (#94).
    // Unchanged → skip with no embed. Changed → update in place. New UID → fall through to create.
    // (content_hash can't be the change signal: upsertArtifactTxn freezes it to first-seen bytes.)
    const existing = c.uid ? getArtifactBySource('vcard', c.uid) : null;
    if (existing) {
      if (existing.text_repr === textRepr) { skipped++; continue; } // unchanged — no Ollama call, no write
      const vec = await embedToFloat32(textRepr); // enrich BEFORE the transaction
      const r = updateOneTxn(c, existing, textRepr, vec); // photo frozen — not re-persisted
      updated++; linksFormed += r.linksFormed;
      continue;
    }
    // No UID (or a UID not seen before): dedup by content_hash — an exact-content dup is skipped; a
    // changed no-UID card has a new hash and inserts as new (documented caveat: no stable identity).
    if (!c.uid && findByHash.get(contentHash)) { skipped++; continue; }

    const vec = await embedToFloat32(textRepr); // enrich BEFORE the transaction
    const photo = persistContactPhoto(c.photo); // I/O BEFORE the transaction, same reasoning
    const r = importOneTxn(c, textRepr, contentHash, vec, photo);
    if (r.deduped) skipped++; else artifacts++;
    if (r.entityCreated) entitiesCreated++;
    linksFormed += r.linksFormed;
    // Only count a photo actually attached to a newly-stored artifact — on the rare dedup race
    // (a concurrent import commits the same (source, source_id) between this loop's pre-check
    // and the transaction), storeArtifactTxn returns the pre-existing row untouched and the
    // file persistContactPhoto just wrote is orphaned, not attached; don't claim it as counted.
    if (photo && !r.deduped) photos++;
  }
  const summary = { cards: cards.length, entitiesCreated, artifacts, updated, skipped, photos, linksFormed };
  logEvent('import_contacts', 'contacts.js', summary);
  return summary;
}

// --- CLI ---
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run import:contacts <file.vcf>');
    process.exit(1);
  }
  const summary = await importContacts(readFileSync(file, 'utf8'));
  console.log(
    `Contacts import complete: ${summary.artifacts} added, ${summary.updated} updated ` +
    `(${summary.entitiesCreated} new entities, ${summary.photos} photos preserved), ` +
    `${summary.skipped} skipped, of ${summary.cards} vCards.`
  );
  db.close();
}

// Run only as a CLI, not when imported for tests. pathToFileURL handles spaces, non-ASCII,
// and Windows paths that a hand-built file:// string would mismatch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Contacts import failed:', err); process.exit(1); });
}
