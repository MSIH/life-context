// Contacts import (#74): vCard PHOTO preservation. Covers the pure parser (parsePhoto), the
// I/O layer (persistContactPhoto — decode/write, idempotency, malformed-input handling), and
// the end-to-end importContacts path (raw_path/extra_json on the stored artifact, no
// regression for photo-less cards). DB_PATH, OLLAMA_BASE_URL, and CONTACTS_RAW_DIR are all set
// BEFORE contacts.js (which imports db.js/config.js/embeddings.js) is loaded.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTempDb, useTempEvents, startFakeOllama, readEvents, f32, fakeVectorFor } from './helpers.mjs';

const { cleanup } = useTempDb();
const { cleanup: cleanupEvents } = useTempEvents(); // this file asserts on ERROR rows (#328)
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;
const rawDir = mkdtempSync(path.join(tmpdir(), 'lc-test-contacts-raw-'));
process.env.CONTACTS_RAW_DIR = rawDir;

const { parsePhoto, persistContactPhoto, importContacts, parseVCards, contactTextRepr, contactAttrs, stripRedundantAddressLabel, suspectsRedundantAddressLabel } = await import('../src/contacts.js');
const { db, getArtifactById, nameVariants, storeArtifactTxn, resolveEntityHints, insertEntityStmt, insertAliasStmt, resolveEntityIds, removeAlias, updateEntityAttrs } = await import('../src/db.js');
const { log } = await import('../src/logger.js');
const { VECTOR_DIMENSION } = await import('../src/config.js');
const { backfillEntityLinks } = await import('../scripts/backfill-entity-links.js');
const { fixDuplicatedAddresses } = await import('../scripts/fix-duplicated-addresses.js');

after(async () => { db.close(); await fake.close(); cleanupEvents(log); cleanup(); rmSync(rawDir, { recursive: true, force: true }); });

const PHOTO_BYTES = Buffer.from('hello-world-photo-bytes');
const PHOTO_B64 = PHOTO_BYTES.toString('base64');

const vcard = (body) => `BEGIN:VCARD\nVERSION:3.0\n${body}\nEND:VCARD\n`;

test('parsePhoto: vCard 3.0 inline base64 (ENCODING=b + TYPE)', () => {
  const p = parsePhoto(PHOTO_B64, [{ key: 'ENCODING', value: 'b' }, { key: 'TYPE', value: 'JPEG' }]);
  assert.deepEqual(p, { kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
});

test('parsePhoto: vCard 4.0 data: URI', () => {
  const p = parsePhoto(`data:image/png;base64,${PHOTO_B64}`, []);
  assert.equal(p.kind, 'base64');
  assert.equal(p.data, PHOTO_B64);
  assert.equal(p.ext, 'png');
});

test('parsePhoto: external http(s) URI', () => {
  const p = parsePhoto('https://example.com/photo.jpg', [{ key: 'TYPE', value: 'JPEG' }]);
  assert.deepEqual(p, { kind: 'uri', url: 'https://example.com/photo.jpg', mediaType: 'image/jpeg' });
});

test('parsePhoto: unrecognized shape returns null (photo silently absent)', () => {
  assert.equal(parsePhoto('some-unrecognized-value', []), null);
});

test('parsePhoto: vCard 4.0 data: URI tolerates an extra ;param=value segment (e.g. ;charset=) before ;base64,', () => {
  const p = parsePhoto(`data:image/png;charset=binary;base64,${PHOTO_B64}`, []);
  assert.equal(p.kind, 'base64');
  assert.equal(p.data, PHOTO_B64);
  assert.equal(p.mediaType, 'image/png');
  assert.equal(p.ext, 'png');
});

test('parsePhoto: unrecognized image subtype (e.g. HEIC) falls back to its own subtype as the file extension', () => {
  const p = parsePhoto(PHOTO_B64, [{ key: 'ENCODING', value: 'b' }, { key: 'MEDIATYPE', value: 'image/heic' }]);
  assert.equal(p.mediaType, 'image/heic');
  assert.equal(p.ext, 'heic');
});

test('persistContactPhoto: base64 -> content-addressed file under CONTACTS_RAW_DIR', () => {
  const result = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
  assert.ok(result.raw_path.startsWith(rawDir));
  assert.ok(existsSync(result.raw_path));
  assert.deepEqual(readFileSync(result.raw_path), PHOTO_BYTES);
});

test('persistContactPhoto: idempotent — same bytes write the same path, second call is a no-op write', () => {
  const a = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
  const b = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
  assert.equal(a.raw_path, b.raw_path);
});

test('persistContactPhoto: external URI is recorded but never fetched (no raw_path)', () => {
  const result = persistContactPhoto({ kind: 'uri', url: 'https://example.com/p.jpg', mediaType: 'image/jpeg' });
  assert.deepEqual(result, { photo_url: 'https://example.com/p.jpg', media_type: 'image/jpeg' });
});

test('persistContactPhoto: a malicious ext (path traversal) is rejected, falls back to a safe extension', () => {
  // This function is exported and takes a raw descriptor — parsePhoto always hands it a
  // sanitized ext, but persistContactPhoto must not trust that on its own (a future/direct
  // caller could pass anything). "../../x" must never escape CONTACTS_RAW_DIR.
  const result = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: '../../../../etc/passwd' });
  assert.ok(result.raw_path.startsWith(rawDir), 'the written path must stay inside CONTACTS_RAW_DIR');
  assert.ok(result.raw_path.endsWith('.jpg'), 'an invalid ext falls back to the safe default');
  assert.ok(existsSync(result.raw_path));
});

test('persistContactPhoto: malformed base64 logs and returns null, never throws', () => {
  // #328 moved this from console.error to a queryable ERROR row — assert on the row, which is a
  // stronger check than "something printed": it pins the event name, the level, and the stack.
  const before = readEvents(log).at(-1)?.id ?? 0;
  const result = persistContactPhoto({ kind: 'base64', data: '!!!not-valid-base64!!!', ext: 'jpg' });
  assert.equal(result, null);
  const rows = readEvents(log, { event: 'contacts.photo.failed', since: before });
  assert.equal(rows.length, 1, 'a decode failure is logged, never swallowed');
  assert.equal(rows[0].level, 'ERROR');
  assert.ok(rows[0].stack, 'and the row is self-sufficient — it carries the stack');
});

test('persistContactPhoto: truncated base64 (length not a multiple of 4) is rejected, not silently decoded into corrupt bytes', () => {
  const truncated = PHOTO_B64.slice(0, PHOTO_B64.length - 1); // chop one char off a valid, padded b64 string
  const before = readEvents(log).at(-1)?.id ?? 0;
  const result = persistContactPhoto({ kind: 'base64', data: truncated, ext: 'jpg' });
  assert.equal(result, null, 'truncated base64 must not decode into a corrupt file');
  assert.equal(readEvents(log, { event: 'contacts.photo.failed', since: before }).length, 1);
});

test('persistContactPhoto: null descriptor (no PHOTO) is a no-op', () => {
  assert.equal(persistContactPhoto(null), null);
});

test('importContacts: inline base64 PHOTO ends up as the contact artifact raw_path + extra_json.photo', async () => {
  const text = vcard(`FN:Photo Person\nEMAIL:photo.person@example.com\nPHOTO;ENCODING=b;TYPE=JPEG:${PHOTO_B64}`);
  const summary = await importContacts(text);
  assert.equal(summary.artifacts, 1);
  assert.equal(summary.photos, 1);

  const row = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'Photo Person%'").get();
  const artifact = getArtifactById(row.id);
  assert.ok(artifact.raw_path && existsSync(artifact.raw_path));
  assert.deepEqual(readFileSync(artifact.raw_path), PHOTO_BYTES);
  assert.equal(artifact.extra.photo.media_type, 'image/jpeg');
  assert.equal(artifact.extra.photo.raw_path, artifact.raw_path);
});

test('importContacts: card with no PHOTO imports unchanged (no regression)', async () => {
  const text = vcard('FN:No Photo Person\nEMAIL:no.photo@example.com');
  const summary = await importContacts(text);
  assert.equal(summary.artifacts, 1);
  assert.equal(summary.photos, 0);

  const row = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'No Photo Person%'").get();
  const artifact = getArtifactById(row.id);
  assert.equal(artifact.raw_path, null);
  assert.equal(artifact.extra.photo, undefined);
});

test('importContacts: malformed PHOTO does not abort the contact import', async () => {
  const text = vcard(`FN:Bad Photo Person\nEMAIL:bad.photo@example.com\nPHOTO;ENCODING=b;TYPE=JPEG:!!!not-valid-base64!!!`);
  const originalError = console.error;
  console.error = () => {};
  let summary;
  try { summary = await importContacts(text); } finally { console.error = originalError; }
  assert.equal(summary.artifacts, 1, 'contact still imports despite the bad photo');
  assert.equal(summary.photos, 0);

  const row = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'Bad Photo Person%'").get();
  assert.equal(getArtifactById(row.id).raw_path, null);
});

test('importContacts: re-import is idempotent — no duplicate artifact, no duplicate photo write', async () => {
  const text = vcard(`FN:Repeat Person\nEMAIL:repeat.person@example.com\nPHOTO;ENCODING=b;TYPE=JPEG:${PHOTO_B64}`);
  const first = await importContacts(text);
  const second = await importContacts(text);
  assert.equal(first.artifacts, 1);
  assert.equal(second.artifacts, 0);
  assert.equal(second.skipped, 1);

  const rows = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'Repeat Person%'").all();
  assert.equal(rows.length, 1, 'no duplicate artifact on re-import');
});

// --- Entity resolution: name-variant aliases + X-* relationship parsing (#93) ---

test('parseVCards: Google/Android X-SPOUSE / X-CHILD parse into relatedNames with a canonical-able type', () => {
  const [c] = parseVCards(vcard('FN:Rel Parser\nX-SPOUSE:Some Spouse\nX-CHILD:Some Kid\nX-MANAGER:The Boss'));
  assert.deepEqual(c.relatedNames, [
    { type: 'spouse', name: 'Some Spouse' },
    { type: 'child', name: 'Some Kid' },
    { type: 'manager', name: 'The Boss' },
  ]);
});

test('contactTextRepr: embeds ALL addresses (not just the last), de-duped, empties dropped (#92)', () => {
  const [c] = parseVCards(vcard(
    'FN:Multi Addr\n' +
    'ADR;TYPE=HOME:;;12 Sycamore Court;Springfield;MD;20800;US\n' +
    'ADR;TYPE=WORK:;;9 Birchwood Lane;Springfield;MD;20801;US\n' +
    'ADR;TYPE=HOME:;;12 Sycamore Court;Springfield;MD;20800;US\n' +   // exact dup of the first
    'ADR;TYPE=OTHER:;;;;;;'                                          // empty ADR -> flattens to ''
  ));
  const text = contactTextRepr(c);
  assert.match(text, /Sycamore Court/);                              // non-last address present
  assert.match(text, /Birchwood Lane/);                              // last address present
  assert.equal((text.match(/Sycamore Court/g) || []).length, 1);     // de-duped
  assert.doesNotMatch(text, /Address: ;|; ;|; \./);                  // no bare/empty entry from the empty ADR
});

test('contactTextRepr: single address is unchanged (regression) and no address emits no Address line', () => {
  const [one] = parseVCards(vcard('FN:One Addr\nADR;TYPE=HOME:;;5013 Cedar Rd;Springfield;MD;20802;US'));
  assert.match(contactTextRepr(one), /Address: 5013 Cedar Rd, Springfield, MD, 20802, US\./);
  const [none] = parseVCards(vcard('FN:No Addr\nEMAIL:noaddr@example.com'));
  assert.doesNotMatch(contactTextRepr(none), /Address:/);
});

// #493 — an RFC 2426 ADR has exactly 7 components; some exporters append an 8th holding the whole
// address again, pre-formatted as a mailing label. Both live variants below stored the address twice.
test('ADR: an exporter-appended 8th component (escaped-\\n label) is dropped (#493)', () => {
  const [c] = parseVCards(vcard(
    String.raw`FN:Dup Addr Escaped
ADR;TYPE=HOME:;;240 Example Plaza;Springfield;CA;90210-0100;US;240 Example Plaza\nSpringfield, CA 90210-0100\nUS`
  ));
  assert.deepEqual(c.addresses, ['240 Example Plaza, Springfield, CA, 90210-0100, US']);
  assert.equal(c.address, '240 Example Plaza, Springfield, CA, 90210-0100, US');
  // the tell of the bug: the street name appearing a second time in one element
  assert.equal((c.addresses[0].match(/Example Plaza/g) || []).length, 1);
});

test('ADR: an 8th component folded across RFC continuation lines is dropped (#493)', () => {
  const [c] = parseVCards(vcard(
    'FN:Dup Addr Folded\n' +
    'ADR;TYPE=HOME:;;5013 Cedar Rd;Springfield;MD;20802;United States;5013 Cedar Rd\n' +
    ' Springfield, MD 20802\n' +
    ' United States'
  ));
  // unfolding strips the continuation breaks, which is what produced the separator-less
  // "5013 Cedar RdSpringfield, MD 20802United States" tail on the live DB
  assert.deepEqual(c.addresses, ['5013 Cedar Rd, Springfield, MD, 20802, United States']);
  assert.doesNotMatch(c.addresses[0], /RdSpringfield/);
});

test('ADR: a newline INSIDE one of the 7 components survives (#493 must not over-trim)', () => {
  const [c] = parseVCards(vcard(
    String.raw`FN:Apt Addr
ADR;TYPE=HOME:;;Apt 304\n7 Example Way;Springfield;MD;20800;US`
  ));
  assert.deepEqual(c.addresses, ['Apt 304\n7 Example Way, Springfield, MD, 20800, US']);
});

test('ADR: the 7-component bound leaves normal and empty ADRs byte-for-byte unchanged (#493)', () => {
  const [normal] = parseVCards(vcard('FN:Plain Addr\nADR;TYPE=HOME:;;12 Sycamore Court;Springfield;MD;20800;US'));
  assert.deepEqual(normal.addresses, ['12 Sycamore Court, Springfield, MD, 20800, US']);
  const [empty] = parseVCards(vcard('FN:Empty Addr\nEMAIL:e@example.com\nADR;TYPE=OTHER:;;;;;;'));
  assert.deepEqual(empty.addresses, ['']);                    // still flattens to '' (see #92 above)
  assert.doesNotMatch(contactTextRepr(empty), /Address:/);    // and emits no Address line
});

// #493 — the repair detector behind `npm run fix:addresses`. The false-positive cases matter more than
// the true positives: it rewrites stored rows, so anything it does NOT recognise must survive verbatim.
test('stripRedundantAddressLabel: strips an appended label in every stored variant (#493)', () => {
  // escaped-\n label. The label itself contains ', ', so the duplicate spans more than one segment
  // and a naive last-segment check would miss it — hence the split-point search.
  assert.equal(
    stripRedundantAddressLabel('240 Example Plaza, Springfield, CA, 90210-0100, US, 240 Example Plaza\nSpringfield, CA 90210-0100\nUS'),
    '240 Example Plaza, Springfield, CA, 90210-0100, US'
  );
  // unfolded / separator-less label (entity 9 shape)
  assert.equal(
    stripRedundantAddressLabel('5013 Cedar Rd, Springfield, MD, 20802, United States, 5013 Cedar RdSpringfield, MD 20802United States'),
    '5013 Cedar Rd, Springfield, MD, 20802, United States'
  );
});

test('stripRedundantAddressLabel: leaves anything it does not recognise untouched (#493)', () => {
  const clean = '12 Sycamore Court, Springfield, MD, 20800, US';
  assert.equal(stripRedundantAddressLabel(clean), clean);
  // a genuine second address does not repeat the first's characters
  const two = '12 Sycamore Court, Springfield, MD, 20800, US, 9 Birchwood Lane, Springfield, MD, 20801, US';
  assert.equal(stripRedundantAddressLabel(two), two);
  // an interior newline (apartment line) is not a duplicate
  const apt = 'Apt 304\n7 Example Way, Springfield, MD, 20800, US';
  assert.equal(stripRedundantAddressLabel(apt), apt);
  assert.equal(stripRedundantAddressLabel(''), '');
  assert.equal(stripRedundantAddressLabel('Springfield'), 'Springfield');
  // punctuation-only head must never collapse against an equally empty tail
  assert.equal(stripRedundantAddressLabel('-, -'), '-, -');
  // non-strings pass through (attrs_json is user-shaped JSON, not a guaranteed schema)
  assert.equal(stripRedundantAddressLabel(null), null);
  assert.deepEqual(stripRedundantAddressLabel({ a: 1 }), { a: 1 });
});

test('stripRedundantAddressLabel: two different NON-LATIN addresses are not collapsed (#493)', () => {
  // An ASCII-only normalization would strip every Cyrillic/CJK character, leaving only the digits to
  // compare — so these two distinct addresses would key equal and the second would be deleted.
  const ru = 'Кировская 12, Москва, Тверская 12, Москва';
  assert.equal(stripRedundantAddressLabel(ru), ru);
  const ja = '東京都渋谷区 1, 東京, 大阪市北区 1, 大阪';
  assert.equal(stripRedundantAddressLabel(ja), ja);
  // but a genuinely doubled non-Latin address is still repaired
  assert.equal(stripRedundantAddressLabel('Кировская 12, Москва, Кировская 12Москва'), 'Кировская 12, Москва');
});

test('stripRedundantAddressLabel: a repeated component (city-state) is NOT a duplicated label (#493)', () => {
  // ADR:;;;Singapore;;;Singapore — locality + country for a city-state. Collapsing this would delete a
  // real component. Same shape: Hong Kong, Monaco, Luxembourg, Macau.
  assert.equal(stripRedundantAddressLabel('Singapore, Singapore'), 'Singapore, Singapore');
  assert.equal(stripRedundantAddressLabel('Hong Kong, Hong Kong'), 'Hong Kong, Hong Kong');
  // the digit escape hatch: a street-only restatement carries a number and is still repaired
  assert.equal(stripRedundantAddressLabel('123 Main St, 123 Main St'), '123 Main St');
  // and a postal code rescues the city-state shape when it really is doubled
  assert.equal(stripRedundantAddressLabel('Singapore, 238823, Singapore 238823'), 'Singapore, 238823');
});

test('suspectsRedundantAddressLabel: flags an INEXACT restatement the strip deliberately leaves alone (#493)', () => {
  // Apple omits the country from a formatted label when it matches the locale — the common US case.
  const omitsCountry = '240 Example Plaza, Springfield, CA, 90210-0100, US, 240 Example PlazaSpringfield, CA 90210-0100';
  assert.equal(stripRedundantAddressLabel(omitsCountry), omitsCountry);   // not repaired: keys differ
  assert.equal(suspectsRedundantAddressLabel(omitsCountry), true);        // but reported, not silent
  // a genuine second address trips neither
  const two = '12 Sycamore Court, Springfield, MD, 20800, US, 9 Birchwood Lane, Springfield, MD, 20801, US';
  assert.equal(suspectsRedundantAddressLabel(two), false);
  // an exactly-doubled value is the strip's job, not a suspect
  assert.equal(suspectsRedundantAddressLabel(BAD_ADDR), false);
  assert.equal(suspectsRedundantAddressLabel(GOOD_ADDR), false);
  assert.equal(suspectsRedundantAddressLabel(null), false);
});

test('stripRedundantAddressLabel: is idempotent — a repaired value is a fixed point (#493)', () => {
  const bad = '240 Example Plaza, Springfield, CA, 90210-0100, US, 240 Example PlazaSpringfield, CA 90210-0100US';
  const once = stripRedundantAddressLabel(bad);
  assert.equal(stripRedundantAddressLabel(once), once);
});

// #493 — `npm run fix:addresses` end to end. Seeds the corruption into all three derived layers the
// live DB actually held it in, then asserts the repair, the dry run's write-nothing guarantee, and
// idempotency. The dry-run assertion is the important one: it rolls back via a thrown sentinel, so a
// regression there would silently write to a store the operator was told was untouched.
const BAD_ADDR = '240 Example Plaza, Springfield, CA, 90210-0100, US, 240 Example PlazaSpringfield, CA 90210-0100US';
const GOOD_ADDR = '240 Example Plaza, Springfield, CA, 90210-0100, US';
const CLEAN_ADDR = '9 Birchwood Lane, Springfield, MD, 20801, US';

// Each call must mint fresh unique keys: directory_cards.card_key is UNIQUE and artifacts is
// UNIQUE(source, source_id), and the dry-run test's seed survives its own rollback (the seed happens
// before the transaction), so both tests seed into the same DB.
let seedN = 0;
function seedDuplicatedAddresses() {
  const n = ++seedN;
  const entityId = Number(insertEntityStmt.run('person', `Addr Repair ${n}`, JSON.stringify({
    emails: [`addr.repair${n}@example.com`], addresses: [BAD_ADDR], address: BAD_ADDR,
  })).lastInsertRowid);
  // an untouched control: a clean profile the repair must leave byte-for-byte alone
  const cleanId = Number(insertEntityStmt.run('person', `Addr Clean ${n}`, JSON.stringify({
    emails: [`addr.clean${n}@example.com`], addresses: [CLEAN_ADDR], address: CLEAN_ADDR,
  })).lastInsertRowid);
  const cardId = Number(db.prepare('INSERT INTO directory_cards (card_key, name, attrs_json) VALUES (?, ?, ?)')
    .run(`repair-card-${n}`, `Addr Repair ${n}`, JSON.stringify({ addresses: [BAD_ADDR] })).lastInsertRowid);
  const stored = storeArtifactTxn({
    type: 'contact', source: 'vcard', source_id: `addr-repair-${n}`,
    // a real content_hash/raw_path, so the frozen-originals assertion below is not vacuous
    content_hash: `hash-addr-repair-${n}`, raw_path: `/raw/contacts/addr-repair-${n}.jpg`,
    text_repr: `Addr Repair ${n}. Email: addr.repair${n}@example.com. Address: ${BAD_ADDR}.`,
    extra_json: JSON.stringify({ emails: [`addr.repair${n}@example.com`], addresses: [BAD_ADDR] }),
  }, f32(0.42));
  return { n, entityId, cleanId, cardId, artifactId: stored.id };
}
const readAttrs = (id) => JSON.parse(db.prepare('SELECT attrs_json FROM entities WHERE id = ?').get(id).attrs_json);
const readCard = (id) => JSON.parse(db.prepare('SELECT attrs_json FROM directory_cards WHERE id = ?').get(id).attrs_json);
const readArtifact = (id) => db.prepare('SELECT text_repr, extra_json, content_hash, raw_path, ingested_at FROM artifacts WHERE id = ?').get(id);
const readVec = (id) => db.prepare('SELECT embedding FROM vec_artifacts WHERE artifact_id = ?').get(BigInt(id))?.embedding;
// Baseline-delta, not an absolute count: an absolute assertion silently encodes "this test runs first"
// and would fail mysteriously the day a third repair test lands above it (this file's own idiom at the
// persistContactPhoto tests). Actor-scoped so it covers the per-row rows too, not just the summary.
const logCount = () => db.prepare("SELECT COUNT(*) n FROM ingest_log WHERE actor = 'fix-duplicated-addresses.js'").get().n;

test('fix:addresses --dry-run reports the repair, writes nothing, and never calls the embedder (#493)', async () => {
  const { entityId, cardId, artifactId } = seedDuplicatedAddresses();
  const vecBefore = readVec(artifactId);
  const artBefore = readArtifact(artifactId);
  const logBefore = logCount();
  const embedBefore = fake.counts.embed;

  const s = await fixDuplicatedAddresses({ dryRun: true });
  assert.equal(s.dryRun, true);
  assert.equal(s.entities, 1);
  assert.equal(s.directory_cards, 1);
  assert.equal(s.artifacts, 1);
  // documented property: a dry run needs no Ollama, because it embeds nothing
  assert.equal(fake.counts.embed, embedBefore);

  // every layer byte-identical — the transaction rolled back
  assert.deepEqual(readAttrs(entityId).addresses, [BAD_ADDR]);
  assert.equal(readAttrs(entityId).address, BAD_ADDR);
  assert.deepEqual(readCard(cardId).addresses, [BAD_ADDR]);
  assert.deepEqual(readArtifact(artifactId), artBefore);
  assert.deepEqual(readVec(artifactId), vecBefore);
  // no ingest_log trace of ANY kind, or the log would stop meaning "rows changed"
  assert.equal(logCount(), logBefore);
});

test('fix:addresses repairs all three layers, re-embeds every changed artifact, and is idempotent (#493)', async () => {
  const { n, entityId, cleanId, cardId, artifactId } = seedDuplicatedAddresses();
  const vecBefore = readVec(artifactId);
  const origBefore = readArtifact(artifactId);
  const logBefore = logCount();
  const embedBefore = fake.counts.embed;

  // The dry-run test's seed survives its own rollback, so two corrupted sets exist by now: exact
  // counts (not `>= 1`) are what catch a repair that re-embeds only one of them and leaves the other's
  // vector stale — a stale vector keeps search matching the doubled address, the whole point of #493.
  const s = await fixDuplicatedAddresses();
  assert.equal(s.entities, 2);
  assert.equal(s.directory_cards, 2);
  assert.equal(s.artifacts, 2);
  assert.equal(s.artifacts_reembedded, 2);
  assert.equal(fake.counts.embed - embedBefore, 2);
  assert.equal(s.skipped_raced, 0);
  assert.equal(s.artifacts_text_unrepaired, 0);
  assert.equal(s.unparseable_skipped, 0);
  assert.ok(s.entity_ids.includes(entityId));
  assert.ok(s.card_ids.includes(cardId));
  assert.ok(s.artifact_ids.includes(artifactId));

  assert.deepEqual(readAttrs(entityId).addresses, [GOOD_ADDR]);
  assert.equal(readAttrs(entityId).address, GOOD_ADDR);      // the legacy scalar too
  assert.deepEqual(readCard(cardId).addresses, [GOOD_ADDR]);
  const art = readArtifact(artifactId);
  assert.equal(art.text_repr, `Addr Repair ${n}. Email: addr.repair${n}@example.com. Address: ${GOOD_ADDR}.`);
  assert.deepEqual(JSON.parse(art.extra_json).addresses, [GOOD_ADDR]);
  // the vector is the embedding of the REPAIRED text, not merely "different" — embedding the OLD text
  // would also change it, and a deleted vec row would satisfy notDeepEqual too
  assert.deepEqual(readVec(artifactId), Buffer.from(fakeVectorFor(art.text_repr).buffer));
  assert.notDeepEqual(readVec(artifactId), vecBefore);
  // originals frozen — the entire basis of the append-only carve-out (absolute rule 5)
  assert.equal(art.content_hash, origBefore.content_hash);
  assert.equal(art.raw_path, origBefore.raw_path);
  assert.equal(art.ingested_at, origBefore.ingested_at);
  // the clean control is untouched
  assert.deepEqual(readAttrs(cleanId).addresses, [CLEAN_ADDR]);
  assert.ok(!s.entity_ids.includes(cleanId));
  // FTS followed text_repr via the artifacts_au trigger
  assert.equal(db.prepare("SELECT COUNT(*) n FROM artifacts_fts WHERE artifacts_fts MATCH 'PlazaSpringfield'").get().n, 0);
  // per-row history plus the run summary: 2 entity_edited + 2 directory_card_repaired + 2
  // contact_artifact_repaired + 1 summary
  assert.equal(logCount(), logBefore + 7);

  const again = await fixDuplicatedAddresses();
  assert.equal(again.entities, 0);
  assert.equal(again.directory_cards, 0);
  assert.equal(again.artifacts, 0);
  assert.equal(logCount(), logBefore + 7);   // a no-op run writes nothing at all
});

test('fix:addresses: an artifact whose text_repr lacks the address repairs extra_json only — no re-embed (#493)', async () => {
  const stored = storeArtifactTxn({
    type: 'contact', source: 'vcard', source_id: 'addr-text-miss',
    text_repr: 'Text Miss. Email: text.miss@example.com.',            // prose never held the address
    extra_json: JSON.stringify({ emails: ['text.miss@example.com'], addresses: [BAD_ADDR] }),
  }, f32(0.31));
  const vecBefore = readVec(stored.id);
  const embedBefore = fake.counts.embed;

  const s = await fixDuplicatedAddresses();
  assert.equal(s.artifacts, 1);
  assert.equal(s.artifacts_reembedded, 0);
  assert.equal(s.artifacts_text_unrepaired, 1);      // surfaced, not silently counted as fully repaired
  assert.equal(fake.counts.embed, embedBefore);      // nothing to re-embed
  const art = readArtifact(stored.id);
  assert.deepEqual(JSON.parse(art.extra_json).addresses, [GOOD_ADDR]);
  assert.equal(art.text_repr, 'Text Miss. Email: text.miss@example.com.');
  assert.deepEqual(readVec(stored.id), vecBefore);   // extra_json-only repair must not churn the vector
});

test('fix:addresses: only the corrupted element of a multi-address profile is rewritten (#493)', async () => {
  const id = Number(insertEntityStmt.run('person', 'Addr Mixed', JSON.stringify({
    addresses: [CLEAN_ADDR, BAD_ADDR], address: CLEAN_ADDR,
  })).lastInsertRowid);
  const s = await fixDuplicatedAddresses();
  assert.ok(s.entity_ids.includes(id));
  // index alignment holds: the clean element survives byte-for-byte, the scalar is left alone
  assert.deepEqual(readAttrs(id).addresses, [CLEAN_ADDR, GOOD_ADDR]);
  assert.equal(readAttrs(id).address, CLEAN_ADDR);
});

test('fix:addresses: a scalar `address` with no addresses[] is repaired (#493)', async () => {
  const id = Number(insertEntityStmt.run('person', 'Addr Scalar', JSON.stringify({ address: BAD_ADDR })).lastInsertRowid);
  await fixDuplicatedAddresses();
  assert.equal(readAttrs(id).address, GOOD_ADDR);
  assert.equal(readAttrs(id).addresses, undefined);   // no key invented
});

test('fix:addresses: an unparseable attrs_json row is skipped, reported, left untouched, and never throws (#493)', async () => {
  const junk = '{"addresses":["broken';   // passes the LIKE prefilter, fails JSON.parse
  const id = Number(db.prepare('INSERT INTO entities (kind, canonical_name, attrs_json) VALUES (?, ?, ?)')
    .run('person', 'Addr Junk', junk).lastInsertRowid);
  const s = await fixDuplicatedAddresses();
  assert.equal(s.unparseable_skipped, 1);            // counted, not silently swallowed
  assert.equal(db.prepare('SELECT attrs_json FROM entities WHERE id = ?').get(id).attrs_json, junk);
});

test('fix:addresses: a concurrent write loses the CAS race instead of being clobbered (#493)', async () => {
  const id = Number(insertEntityStmt.run('person', 'Addr Raced', JSON.stringify({ addresses: [BAD_ADDR] })).lastInsertRowid);
  // Simulate the live service committing a profile save inside the read→embed→write window by
  // rewriting the row through a stubbed embedder hook: here we just change it before the call, which
  // makes the CAS predicate (the value this run read) fail on a row the scan already collected.
  const scanned = JSON.stringify({ addresses: [BAD_ADDR] });
  assert.equal(db.prepare('SELECT attrs_json FROM entities WHERE id = ?').get(id).attrs_json, scanned);
  const raced = JSON.stringify({ addresses: [BAD_ADDR], phones: ['+1 555 000 1111'] });
  const stmt = db.prepare('UPDATE entities SET attrs_json = ? WHERE id = ? AND attrs_json = ?');
  // one repair run, with the concurrent edit landing between scan and write
  const orig = db.transaction;
  db.transaction = (fn) => orig.call(db, () => { stmt.run(raced, id, scanned); return fn(); });
  try {
    const s = await fixDuplicatedAddresses();
    assert.ok(s.skipped_raced >= 1, 'the raced row is reported, never silently overwritten');
  } finally { db.transaction = orig; }
  // the concurrent edit survived — its phones key was not discarded
  assert.deepEqual(readAttrs(id).phones, ['+1 555 000 1111']);
});

test('importContacts: a doubled-ADR card stores ONE address in every derived layer (#493 end to end)', async () => {
  await importContacts(vcard(
    String.raw`FN:E2E Addr
UID:e2e-addr-493
EMAIL:e2e.addr@example.com
ADR;TYPE=HOME:;;240 Example Plaza;Springfield;CA;90210-0100;US;240 Example Plaza\nSpringfield, CA 90210-0100\nUS`
  ));
  const row = db.prepare("SELECT id, text_repr, extra_json FROM artifacts WHERE source_id = 'e2e-addr-493'").get();
  assert.equal((row.text_repr.match(/Example Plaza/g) || []).length, 1);
  assert.deepEqual(JSON.parse(row.extra_json).addresses, [GOOD_ADDR]);
  const ent = db.prepare("SELECT attrs_json FROM entities WHERE canonical_name = 'E2E Addr'").get();
  assert.deepEqual(JSON.parse(ent.attrs_json).addresses, [GOOD_ADDR]);
  // and the repair finds nothing left to do
  const s = await fixDuplicatedAddresses();
  assert.ok(!s.artifact_ids.includes(row.id));
});

test('updateEntityAttrs: an address containing a newline round-trips byte-for-byte (the UI save path, #493)', () => {
  const multiline = 'Apt 304\n7 Example Way, Springfield, MD, 20800, US';
  const id = Number(insertEntityStmt.run('person', 'Addr Newline', JSON.stringify({ addresses: [multiline] })).lastInsertRowid);
  // the server hands attrs straight through (AttrsSchema is an open record), so this is the write half
  // of the UI round-trip; the browser half (textarea vs input) has no DOM harness in this repo
  updateEntityAttrs(id, { attrs: { addresses: [multiline] } });
  assert.deepEqual(readAttrs(id).addresses, [multiline]);
  assert.ok(readAttrs(id).addresses[0].includes('\n'), 'the newline must survive the save');
});

test('nameVariants: middle name yields a given+family alias; two-token name adds no redundant duplicate', () => {
  assert.deepEqual(
    nameVariants({ fn: 'Amy Margaret Fenwick', given: 'Amy', family: 'Fenwick', additional: 'Margaret' }).sort(),
    ['amy margaret fenwick', 'amy fenwick'].sort(),
  );
  assert.deepEqual(nameVariants({ fn: 'Jon Ardell', given: 'Jon', family: 'Ardell' }), ['jon ardell']);
});

test('nameVariants: nickname yields both the bare nickname and a nickname+family alias', () => {
  assert.deepEqual(
    nameVariants({ fn: 'Elisabeth Allister', given: 'Elisabeth', family: 'Allister', nicknames: ['Betsy'] }).sort(),
    ['betsy', 'betsy allister', 'elisabeth allister'].sort(),
  );
});

test('nameVariants: falls back to tokenizing FN when the N split is absent (backfill path)', () => {
  assert.deepEqual(
    nameVariants({ fn: 'Amy Margaret Fenwick' }).sort(),
    ['amy margaret fenwick', 'amy fenwick'].sort(),
  );
});

test('nameVariants: a 4+ token name is NOT reduced to first+last (would mint a wrong alias)', () => {
  // "Ana Maria Garcia Lopez" -> first+last "ana lopez" would be wrong (compound given + 2-part
  // surname). Without a structured N split we only keep the full name.
  assert.deepEqual(nameVariants({ fn: 'Ana Maria Garcia Lopez' }), ['ana maria garcia lopez']);
});

test('nameVariants: derive=false (org) yields only the full name + nicknames, no given+family reduction', () => {
  assert.deepEqual(nameVariants({ fn: 'Bank of America', derive: false }), ['bank of america']);
});

test('nameVariants: non-array nicknames are ignored, not iterated (robust backfill input)', () => {
  assert.deepEqual(nameVariants({ fn: 'Solo Name', nicknames: 'betsy' }), ['solo name']);
});

test('importContacts: an org contact does not get a bogus given+family name alias', async () => {
  await importContacts(vcard('FN:Global Widgets Incorporated\nKIND:org\nEMAIL:info@globalwidgets.example'));
  const org = db.prepare("SELECT id FROM entities WHERE canonical_name='Global Widgets Incorporated'").get();
  const aliases = db.prepare("SELECT alias FROM entity_aliases WHERE entity_id=? AND alias_type='name'").all(org.id).map((r) => r.alias);
  assert.deepEqual(aliases, ['global widgets incorporated'], 'org keeps only its full-name alias');
});

test('importContacts: X-SPOUSE relation forms across a middle-name variant, regardless of import order', async () => {
  // Card names the spouse by given+family ("Zoe Quill"); the spouse's own card carries the middle
  // name ("Zoe Beatrix Quill"). Import the referencing card FIRST so the hint must stage and only
  // resolve when the middle-name entity lands — exercising X-SPOUSE parse + staging + the derived
  // given+family alias + reverse resolution together (the seed-bug regression).
  await importContacts(vcard('FN:Quinn Referrer\nEMAIL:quinn.ref@example.com\nX-SPOUSE:Zoe Quill'));
  await importContacts(vcard('FN:Zoe Beatrix Quill\nN:Quill;Zoe;Beatrix;;\nEMAIL:zoe.quill@example.com'));

  const from = db.prepare("SELECT entity_id FROM entity_links WHERE role='self' AND artifact_id=(SELECT id FROM artifacts WHERE text_repr LIKE 'Quinn Referrer%')").get();
  // #156: the middle-name card's canonical is stored first+last ("Zoe Quill"); "zoe beatrix quill"
  // remains a name alias, so look up via the alias rather than the (now-reduced) canonical_name.
  const to = db.prepare("SELECT DISTINCT entity_id AS id FROM entity_aliases WHERE alias='zoe beatrix quill' AND alias_type='name'").get();
  const edge = db.prepare('SELECT relation_type FROM entity_relations WHERE from_entity_id=? AND to_entity_id=?').get(from.entity_id, to.id);
  assert.equal(edge?.relation_type, 'spouse', 'spouse edge formed from referrer to the middle-name entity');
});

// --- Retroactive linking of staged artifact hints (#102) ---

test('importContacts: retroactively links an artifact whose hint was staged before the contact existed (#102)', async () => {
  // Ingest an artifact hinting an email (deterministic) + a name for a person not yet in the graph.
  // Both miss, so both stage in unresolved_aliases and no entity_links form.
  const { id: artifactId } = storeArtifactTxn(
    { type: 'photo', source: 'photo-exif', source_id: 'IMG_RETRO_1.jpg', text_repr: 'Photo with Retro Friend' },
    new Float32Array(VECTOR_DIMENSION), [],
  );
  const staged = resolveEntityHints(artifactId, [
    { alias: 'retro.friend@example.com', alias_type: 'email', role: 'pictured' },
    { alias: 'Retro Friend', alias_type: 'name', role: 'mentioned', confidence: 0.8 },
  ]);
  assert.equal(staged.resolved, 0);
  assert.equal(staged.unresolved, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_links WHERE artifact_id=?').get(artifactId).n, 0, 'no link before the contact exists');

  // Import the contact -> resolveStagedArtifactHints links the queued artifact automatically (no
  // separate command). Distinct roles => two distinct entity_links (same role would collide on the
  // (artifact,entity,role) PK and only the first alias iterated would win).
  const summary = await importContacts(vcard('FN:Retro Friend\nEMAIL:retro.friend@example.com'));
  assert.equal(summary.linksFormed, 2, 'both staged hints link on import');

  const entity = db.prepare("SELECT id FROM entities WHERE canonical_name='Retro Friend'").get();
  const emailLink = db.prepare('SELECT confidence FROM entity_links WHERE artifact_id=? AND entity_id=? AND role=?').get(artifactId, entity.id, 'pictured');
  const nameLink = db.prepare('SELECT confidence FROM entity_links WHERE artifact_id=? AND entity_id=? AND role=?').get(artifactId, entity.id, 'mentioned');
  assert.equal(emailLink?.confidence, 1.0, 'email hint links at deterministic confidence 1.0');
  assert.equal(nameLink?.confidence, 0.8, 'name hint keeps its (sub-cap) supplied confidence');

  // Idempotent: a second import forms 0 new links, leaving exactly the two.
  const second = await importContacts(vcard('FN:Retro Friend\nEMAIL:retro.friend@example.com'));
  assert.equal(second.linksFormed, 0, 'no new links on re-import');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_links WHERE artifact_id=?').get(artifactId).n, 2, 'still exactly two links');
});

test('backfill:links: heals an artifact staged before its (externally-created) entity existed (#102)', async () => {
  // Stage a hint that misses, THEN create the entity + alias directly (bypassing importContacts,
  // so the auto-resolve on import never runs) — the exact "stranded before the resolver shipped"
  // state that `npm run backfill:links` exists to heal.
  const { id: artifactId } = storeArtifactTxn(
    { type: 'email', source: 'gmail', source_id: 'msg:backfill:1', text_repr: 'Email from Backfill Person' },
    new Float32Array(VECTOR_DIMENSION), [],
  );
  assert.equal(resolveEntityHints(artifactId, [{ alias: 'backfill.person@example.com', alias_type: 'email', role: 'sender' }]).unresolved, 1);

  const entityId = Number(insertEntityStmt.run('person', 'Backfill Person', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'backfill.person@example.com', 'email');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_links WHERE artifact_id=?').get(artifactId).n, 0, 'still stranded before backfill');

  const first = backfillEntityLinks();
  assert.ok(first.linksFormed >= 1, 'backfill forms the stranded link');
  const link = db.prepare('SELECT confidence FROM entity_links WHERE artifact_id=? AND entity_id=? AND role=?').get(artifactId, entityId, 'sender');
  assert.equal(link?.confidence, 1.0, 'email hint links at deterministic confidence 1.0');

  // Idempotent: a second sweep forms 0 new links.
  assert.equal(backfillEntityLinks().linksFormed, 0, 'second backfill forms nothing new');
});

test('resolveStagedArtifactHints: same-role email+name hints keep deterministic 1.0 (email tried before name)', async () => {
  // Both hints share role 'sender' -> they collide on entity_links' (artifact,entity,role) PK, so
  // only the first INSERT OR IGNORE wins. Name aliases are inserted before email on import, so
  // without deterministic-first ordering the capped-0.9 name link would shadow the 1.0 email.
  const { id: artifactId } = storeArtifactTxn(
    { type: 'email', source: 'gmail', source_id: 'msg:samerole:1', text_repr: 'Email from Same Role Sender' },
    new Float32Array(VECTOR_DIMENSION), [],
  );
  resolveEntityHints(artifactId, [
    { alias: 'Same Role Sender', alias_type: 'name', role: 'sender', confidence: 0.9 },
    { alias: 'same.role@example.com', alias_type: 'email', role: 'sender' },
  ]);
  await importContacts(vcard('FN:Same Role Sender\nEMAIL:same.role@example.com'));

  // #156: "Same Role Sender" is a 3-token name, so its canonical is stored reduced ("Same Sender");
  // look the entity up by its email alias, which is stable regardless of the display-name rule.
  const entity = db.prepare("SELECT DISTINCT entity_id AS id FROM entity_aliases WHERE alias='same.role@example.com' AND alias_type='email'").get();
  const links = db.prepare('SELECT confidence FROM entity_links WHERE artifact_id=? AND entity_id=? AND role=?').all(artifactId, entity.id, 'sender');
  assert.equal(links.length, 1, 'the two same-role hints collapse to one link');
  assert.equal(links[0].confidence, 1.0, 'the deterministic email link wins the collision, not the capped name');
});

test('importContacts (#111): a later import does not resurrect an alias removed via the UI', async () => {
  // First import: Jane, with a nickname + email.
  await importContacts(vcard('FN:Jane Tombstone\nNICKNAME:Janie\nEMAIL:jane.tomb@example.com\nUID:jane-tomb-1'));
  const [id] = resolveEntityIds('jane.tomb@example.com');
  assert.ok(id, 'entity created on first import');
  assert.ok(resolveEntityIds('janie').includes(id), 'nickname resolves after first import');

  // User removes the "janie" alias in the UI.
  removeAlias(id, 'janie', 'name');
  assert.ok(!resolveEntityIds('janie').includes(id), 'nickname no longer resolves after removal');

  // A later import under a DIFFERENT uid resolves to the SAME entity via the shared email and would
  // re-add "janie" — the tombstone must suppress it (the #94-blocking resurrection repro).
  await importContacts(vcard('FN:Jane Tombstone\nNICKNAME:Janie\nEMAIL:jane.tomb@example.com\nUID:jane-tomb-2'));
  assert.ok(!resolveEntityIds('janie').includes(id), 'the UI-removed nickname is NOT resurrected by a later import');
});

test('importContacts (#94): a CHANGED card (same UID) updates in place; an unchanged re-import is skipped', async () => {
  const uid = 'reimport-uid-1';
  await importContacts(vcard(`FN:Reimport Person\nUID:${uid}\nEMAIL:reimp@example.com`));
  const before = db.prepare("SELECT id, text_repr, content_hash, ingested_at FROM artifacts WHERE source='vcard' AND source_id=?").get(uid);
  assert.ok(before, 'created on first import');

  const s1 = await importContacts(vcard(`FN:Reimport Person\nUID:${uid}\nEMAIL:reimp@example.com`));
  assert.equal(s1.updated, 0, 'unchanged re-import is not an update');
  assert.equal(s1.skipped, 1, 'unchanged re-import is skipped (no embed, no write)');

  const s2 = await importContacts(vcard(`FN:Reimport Person\nUID:${uid}\nEMAIL:reimp@example.com\nEMAIL:reimp2@example.com`));
  assert.equal(s2.updated, 1, 'changed re-import counted as updated');
  assert.equal(s2.artifacts, 0, 'no new artifact created');
  const after = db.prepare("SELECT id, text_repr, content_hash, ingested_at FROM artifacts WHERE source='vcard' AND source_id=?").get(uid);
  assert.equal(after.id, before.id, 'same artifact id (in-place update)');
  assert.match(after.text_repr, /reimp2@example\.com/, 'the new email is in the refreshed text_repr');
  assert.equal(after.content_hash, before.content_hash, 'content_hash frozen (append-only original)');
  assert.equal(after.ingested_at, before.ingested_at, 'ingested_at frozen');
  assert.ok(resolveEntityIds('reimp2@example.com').length > 0, 'the added email resolves as an alias');
  const updForThisArtifact = db.prepare("SELECT COUNT(*) n FROM ingest_log WHERE event_type='ingest_update' AND json_extract(details,'$.artifact_id') = ?").get(after.id).n;
  assert.ok(updForThisArtifact >= 1, 'an ingest_update row was logged for THIS artifact');
});

test('importContacts (#94): a changed re-import respects a UI-removed alias (#111) and does not rewrite the entity profile (#97)', async () => {
  const uid = 'reimport-uid-2';
  await importContacts(vcard(`FN:Reimport Two\nUID:${uid}\nEMAIL:rt@example.com\nNICKNAME:Reepy`));
  const [id] = resolveEntityIds('rt@example.com');
  assert.ok(resolveEntityIds('reepy').includes(id), 'nickname present after first import');
  const profBefore = db.prepare('SELECT attrs_json, canonical_name FROM entities WHERE id=?').get(id);

  removeAlias(id, 'reepy', 'name'); // UI removes the nickname
  assert.ok(!resolveEntityIds('reepy').includes(id), 'nickname removed');

  // Changed re-import still carries NICKNAME:Reepy — must NOT resurrect it, must NOT touch the profile.
  await importContacts(vcard(`FN:Reimport Two\nUID:${uid}\nEMAIL:rt@example.com\nEMAIL:rt2@example.com\nNICKNAME:Reepy`));
  assert.ok(!resolveEntityIds('reepy').includes(id), 'UI-removed nickname NOT resurrected by re-import (#111)');
  const profAfter = db.prepare('SELECT attrs_json, canonical_name FROM entities WHERE id=?').get(id);
  assert.equal(profAfter.attrs_json, profBefore.attrs_json, 'entity attrs_json unchanged by re-import (#97 owns the profile)');
  assert.equal(profAfter.canonical_name, profBefore.canonical_name, 'canonical_name unchanged by re-import');
});

// --- contactAttrs (#304): the one attrs shape the importer and the directory loader share ---
// The shape is now a contract between two writers, so a field added to the profile without adding
// it here (or vice versa) means a promoted directory card silently loses it. This pins the key set.
const ATTRS_KEYS = [
  'emails', 'phones', 'addresses', 'nicknames', 'dates', 'relatedNames', 'categories', 'urls', 'im',
  'socialProfiles', 'birthday', 'anniversary', 'address', 'org', 'department', 'title', 'role',
  'note', 'phonetic', 'isCompany',
];

test('contactAttrs (#304): is the single attrs shape, and the importer writes exactly it', async () => {
  const [c] = parseVCards(vcard('FN:Attrs Shape\nEMAIL:shape@example.com\nTEL:+15550002222\nORG:Acme;Widgets\nTITLE:Chief\nNOTE:a note\nADR:;;5 Fir Ln;Reno;NV;89501;USA\nBDAY:1970-02-02'));
  const attrs = contactAttrs(c);
  assert.deepEqual(Object.keys(attrs).sort(), [...ATTRS_KEYS].sort(), 'the attrs key set is exactly the documented shape');
  assert.deepEqual(attrs.emails, ['shape@example.com']);
  assert.equal(attrs.org, 'Acme, Widgets');
  assert.equal(attrs.department, 'Widgets');
  assert.equal(attrs.title, 'Chief');
  assert.equal(attrs.birthday, '1970-02-02');
  assert.equal(attrs.isCompany, false);

  // The importer must persist that same shape — this is the drift guard: if importOneTxn stops
  // calling contactAttrs, the two diverge and a promoted card (#299) arrives missing fields.
  await importContacts(vcard('FN:Attrs Shape Imported\nEMAIL:shape.import@example.com\nBDAY:1970-02-02'));
  const [id] = resolveEntityIds('shape.import@example.com');
  assert.deepEqual(Object.keys(JSON.parse(db.prepare('SELECT attrs_json FROM entities WHERE id=?').get(id).attrs_json)).sort(), [...ATTRS_KEYS].sort(), 'the imported entity profile carries the same keys');
});

test('contactAttrs (#304): anniversary derives from ANNIVERSARY and from a labelled X-ABDATE, else null', () => {
  const [v4] = parseVCards(vcard('FN:Anniv Four\nANNIVERSARY:2009-05-16'));
  assert.equal(contactAttrs(v4).anniversary, '2009-05-16', 'vCard 4.0 ANNIVERSARY');

  // Apple writes a labelled X-ABDATE; the label is user-typed, so the match is case-insensitive.
  const [apple] = parseVCards(vcard('FN:Anniv Apple\nitem1.X-ABDATE:1998-08-08\nitem1.X-ABLabel:anniversary'));
  assert.equal(contactAttrs(apple).anniversary, '1998-08-08', 'labelled X-ABDATE');

  const [other] = parseVCards(vcard('FN:Other Date\nitem1.X-ABDATE:2001-01-01\nitem1.X-ABLabel:Graduation'));
  assert.equal(contactAttrs(other).anniversary, null, 'a differently-labelled date is not an anniversary');
  assert.deepEqual(contactAttrs(other).dates, [{ type: 'Graduation', value: '2001-01-01' }], 'but it is still preserved in dates[]');

  const [none] = parseVCards(vcard('FN:No Dates\nEMAIL:nodates@example.com'));
  assert.equal(contactAttrs(none).anniversary, null, 'null when the card has no dates at all');
});
