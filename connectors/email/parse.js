// Pure, I/O-free header parsing for the email connector. No network, no fs, no LifeContext —
// everything here is a function of the bytes of one RFC 5322 message, so the whole surface is
// unit-testable against a fixture without a mailbox or a running server.
//
// The one rule worth stating up front: `source_id` must be reproducible from the message itself and
// identical to what the private companion repo's Stage 5 sink derives, or a message that is both sent
// recently (that path) and backfilled (this one) lands as two artifacts instead of upserting to one.
import { createHash } from 'node:crypto';
import { stripSignature } from './signature.js';
import { stripQuotedReply } from './quotes.js';

export const SNIPPET_MAX_CHARS = 1000; // bounded so a 50-item batch stays under the 256kb body cap
const MAX_NAMED_RECIPIENTS = 3;        // beyond this the text_repr says "+N more" instead of listing

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Node understands a few charset spellings; everything else is decoded as UTF-8, which is right far
// more often than it is wrong and never throws (a mojibake subject beats a crashed backfill).
const nodeCharset = (charset) => {
  const c = charset.toLowerCase();
  if (c === 'utf-8' || c === 'utf8') return 'utf8';
  if (c === 'iso-8859-1' || c === 'latin1' || c === 'us-ascii' || c === 'ascii') return 'latin1';
  return 'utf8';
};

// RFC 2047 encoded-words: `=?UTF-8?B?...?=` / `=?UTF-8?Q?...?=`. Real subjects and display names are
// full of these, and without decoding them every non-ASCII name lands in the entity graph as
// gibberish — so this is correctness, not polish. An undecodable word is left verbatim.
export function decodeEncodedWords(input) {
  if (!input) return '';
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString(nodeCharset(charset));
      const bytes = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(text[i] === '_' ? 0x20 : text.charCodeAt(i));
      }
      return Buffer.from(bytes).toString(nodeCharset(charset));
    } catch {
      return match; // an encoded word we cannot decode is still better shown than dropped
    }
  });
}

// Split an address list on commas that are NOT inside a quoted display name or angle brackets —
// `"Cole, Chris" <c@x.com>, d@y.com` is two addresses, not three. A naive split on ',' is the
// classic bug here, which is why this is hand-rolled rather than a regex.
export function splitAddressList(raw) {
  if (!raw) return [];
  const parts = [];
  let current = '';
  let inQuote = false;
  let angleDepth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && raw[i - 1] !== '\\') inQuote = !inQuote;
    else if (!inQuote && ch === '<') angleDepth++;
    else if (!inQuote && ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === ',' && !inQuote && angleDepth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const unquote = (name) => {
  const trimmed = name.trim().replace(/,+$/, '').trim();
  const quoted = /^"(.*)"$/s.exec(trimmed);
  return (quoted ? quoted[1].replace(/\\"/g, '"') : trimmed).trim();
};

// One address → {email, name}. Returns null for anything without an `@` — which is how RFC 5322
// group syntax (`undisclosed-recipients:;`) and malformed entries get dropped rather than becoming
// bogus entity hints.
export function parseAddress(part) {
  if (!part) return null;
  let work = part.trim().replace(/;+$/, '').trim();
  const angle = /<([^>]*)>/.exec(work);
  let email;
  let name;
  if (angle) {
    email = angle[1].trim();
    name = work.slice(0, angle.index);
  } else {
    // A bare `Group name: addr` label with no angle brackets — keep only the address side.
    const label = /^[^<>@"]+:\s*(.+)$/.exec(work);
    if (label) work = label[1].trim();
    email = work;
    name = '';
  }
  email = email.trim().toLowerCase();
  if (!email.includes('@') || /\s/.test(email)) return null;
  const display = unquote(decodeEncodedWords(name));
  // A display name that is just the address again carries no extra signal — drop it so the caller
  // does not emit a redundant `name` hint that duplicates the `email` one.
  return { email, name: display && display.toLowerCase() !== email ? display : null };
}

export const parseAddressList = (raw) => splitAddressList(raw).map(parseAddress).filter(Boolean);

// `References:` (and, incidentally, any other bracketed message-id list) → an array of bracketed
// message-ids, e.g. "<root@x> <parent@x>" -> ["<root@x>", "<parent@x>"]. Kept in bracket form,
// un-normalized — same convention as `extra.message_id` below, which is also stored raw. An absent
// or unparseable header yields [], which the caller (index.js) treats as "omit the key", never `[]`
// on the wire (#386's own rule: never fabricate a thread header that was not actually present).
export function parseMessageIdList(raw) {
  if (!raw) return [];
  return raw.match(/<[^<>]+>/g) || [];
}

// Split a raw message at the first blank line. A message with no blank line is all headers (a
// truncated export entry), which is still parseable metadata — better than discarding it.
export function splitMessage(raw) {
  const match = /\r?\n\r?\n/.exec(raw ?? '');
  if (!match) return { headerText: raw ?? '', body: '' };
  return { headerText: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

// Header block → a lowercased-key lookup, with RFC 5322 folded lines (a continuation begins with
// space or tab) joined back together first. A repeated header keeps the FIRST occurrence, which is
// what every mail client displays and what a forged duplicate header must not be able to override.
export function parseHeaders(headerText) {
  const headers = {};
  const lines = (headerText ?? '').split(/\r?\n/);
  let current = null;
  const commit = () => {
    if (!current) return;
    const key = current.name.toLowerCase();
    if (!(key in headers)) headers[key] = current.value.trim();
    current = null;
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) { current.value += ` ${line.trim()}`; continue; }
    commit();
    const colon = line.indexOf(':');
    if (colon > 0) current = { name: line.slice(0, colon).trim(), value: line.slice(colon + 1) };
  }
  commit();
  return headers;
}

// `<abc@host>` → `abc@host`. Lowercased and bracket-stripped so the same message yields the same key
// no matter which client wrote the header. MUST stay identical to bs#220's derivation.
export const normalizeMessageId = (raw) => {
  if (!raw) return '';
  return raw.trim().replace(/^<|>$/g, '').trim().toLowerCase();
};

// The reader-independent artifact key. A present Message-ID wins (so the backfill and the
// going-forward sink converge on one artifact); when the header is absent or unusable — legal, it is
// only a SHOULD in RFC 5322, and exports mangle it — fall back to a hash of the canonical fields so
// the id is still stable across runs rather than random.
export function sourceIdFor({ messageId, from, date, subject, body }) {
  const normalized = normalizeMessageId(messageId);
  if (normalized) return `email:msg:${normalized}`;
  const canonical = [from ?? '', date ?? '', subject ?? '', body ?? ''].join('\n');
  return `email:msg:sha256:${sha256(canonical)}`;
}

// `Date:` → ISO-8601, or null. Null is deliberate: the connector omits occurred_at and accepts
// core's warning rather than guessing, because a wrong occurred_at silently mis-sorts the timeline
// (connector-conventions rule 5).
export function parseDateHeader(raw) {
  if (!raw) return null;
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  // A date the parser accepts but that cannot be real (year 0, or a far-future clock-skew artifact)
  // is treated as missing — same reasoning as an unparseable one.
  const year = Number(iso.slice(0, 4));
  return year >= 1970 && year <= 2100 ? iso : null;
}

export const truncateSnippet = (body) => {
  if (!body) return '';
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length <= SNIPPET_MAX_CHARS ? collapsed : `${collapsed.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
};

const describeRecipients = (recipients) => {
  if (!recipients.length) return 'no recipients';
  const shown = recipients.slice(0, MAX_NAMED_RECIPIENTS).map((r) => r.name || r.email);
  const extra = recipients.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
};

// signature.js and quotes.js each cut independently from the top of the SAME body, at their own
// earliest confidently-identified boundary (or return it unchanged if they find none). Because both
// slice from line 0 of the identical `text.split(/\r?\n/)`, a smaller cut line index is always a
// strict prefix of — and therefore never longer than — a larger one; so whichever stripper actually
// found the EARLIER boundary is simply the one whose result is no longer than the other's. This lets
// the two modules stay independently tunable (#368 owns signature markers, #386 owns quote markers)
// without either needing to know the other's internal cut index.
function stripToEarliestBoundary(body) {
  const bySignature = stripSignature(body);
  const byQuote = stripQuotedReply(body);
  return bySignature.length <= byQuote.length ? bySignature : byQuote;
}

// What gets embedded. Sent mail only, so the subject and snippet are the owner's own words — the
// asymmetry with inbound (structured fields only) is the whole safety argument, and it lives in the
// caller: this function is given whatever the caller decided to include.
//
// Signature and quote stripping both run BEFORE truncateSnippet (#368, #386) so the SNIPPET_MAX_CHARS
// window is spent on content, not on a footer or a re-quoted thread tail that would otherwise eat
// most of it. This only ever touches the decoded body passed in here — never rawBody, which still
// feeds sourceIdFor's hash fallback (see that function's comment; #362's duplicate hazard).
export function buildTextRepr({ recipients = [], subject = '', body = '' }) {
  const head = `Email to ${describeRecipients(recipients)}`;
  const subjectPart = subject ? `: ${subject}` : '';
  const snippet = truncateSnippet(stripToEarliestBoundary(body));
  return snippet ? `${head}${subjectPart} — ${snippet}` : `${head}${subjectPart}`;
}
