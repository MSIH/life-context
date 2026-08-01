// The store's hard-won invariants (see src/db.js's own comments for the full rationale): BigInt vec0 PK, dedup,
// append-only preservation, the COALESCE upsert, the FTS delete-with-OLD-text trigger, vector
// dimension enforcement, and hint-confidence rules. No network — db.js doesn't import the
// embedder, so we bind Float32Array vectors directly. DB_PATH is pointed at a temp file BEFORE
// db.js is imported (it opens the DB at module load), so db.js is loaded dynamically here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { useTempDb, useTempEvents, f32, readEvents } from './helpers.mjs';

const { cleanup } = useTempDb();
const { cleanup: cleanupEvents } = useTempEvents(); // this file asserts on WARN rows (#328)
const {
  db, storeArtifactTxn, upsertArtifactTxn, resolveEntityHints, getArtifactById, annotateArtifactRows, annotateHandles,
  insertEntityStmt, insertAliasStmt, mergeEntities, listProbableDuplicates, listContactPhotos,
  dismissDuplicatePair, clearDuplicateDismissals, countDuplicateDismissals,
  resolveEntityIds, getEntity, upsertEntityRelation, listEntities,
  addAlias, removeAlias, insertAliasUnlessTombstoned, normalizePhone,
  createEntity, updateEntityAttrs, resolveStagedArtifactHints,
  listProposedEntities, approveProposedEntity, rejectProposedEntity, reopenProposedEntity,
  insertDirectoryEntry, lookupDirectoryName, lookupDirectoryByName, backfillDirectoryProposals,
  upsertDirectoryCard, getDirectoryCard, fillEntityAttrsFromCard,
  listDirectoryCandidates, promoteDirectoryName, proposeEntity,
  reduceEntityDisplayName, listObservedExtensionTypes, normalizeName,
  listStrandedPicturedNames, stagePicturedProposals, healNameProposals,
  NAME_HANDLE_CONFIDENCE_CAP, NAME_PREFIX_CONFIDENCE_CAP,
  resolveHandle, resolveForIngest, reconcileHandleAliases, listLiveEntityHandleAttrs,
} = await import('../src/db.js');
const { backfillPhoneAliases } = await import('../scripts/backfill-phone-aliases.js');
const { backfillDirectoryAttrs } = await import('../scripts/backfill-directory-attrs.js');
const { backfillHandleAliases, parseArgs: parseHandleAliasesArgs } = await import('../scripts/backfill-handle-aliases.js');
const { checkHandleAliases, HANDLE_ALIAS_FIELDS: CHECK_HANDLE_ALIAS_FIELDS } = await import('../scripts/check-handle-aliases.js');
const { backfillNamePrefixLinks } = await import('../scripts/backfill-name-prefix-links.js');
const { fixNamePrefixLinkConfidence } = await import('../scripts/fix-name-prefix-link-confidence.js');
const { loadDirectory } = await import('../scripts/load-directory.js');
const { parseArgs: parsePicturedProposalsArgs } = await import('../scripts/backfill-pictured-proposals.js');
const { parseArgs: parseHealNameProposalsArgs } = await import('../scripts/heal-name-proposals.js');
const { preferredDisplayName } = await import('../src/contacts.js');
const { log } = await import('../src/logger.js');

after(() => { db.close(); cleanupEvents(log); cleanup(); });

const knnStmt = db.prepare('SELECT artifact_id, distance FROM vec_artifacts WHERE embedding MATCH ? AND k = ?');
const ftsStmt = db.prepare('SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH ?');
const countVecStmt = db.prepare('SELECT COUNT(*) AS n FROM vec_artifacts WHERE artifact_id = ?');

let seq = 0;
const uniqueSource = () => `test-${++seq}`;

test('busy_timeout: the connection applies DB_BUSY_TIMEOUT_MS (default 5000)', () => {
  // #224 — better-sqlite3 defaults busy_timeout to 0, throwing SQLITE_BUSY instantly on brief
  // cross-process write overlap; the pragma at connection open installs the 5s default.
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
});

test('busy_timeout: DB_BUSY_TIMEOUT_MS env override is honored', () => {
  // config reads the env once at import, so exercise the override in a child process against a
  // throwaway DB. Pass the module as a file:// URL so dynamic import works on Windows too.
  const dbUrl = new URL('../src/db.js', import.meta.url).href;
  const tmp = path.join(os.tmpdir(), `lc-busytimeout-${process.pid}.db`);
  // Pass the module URL via env (not an -e positional arg — argv semantics under `node -e` are
  // subtle); sentinel prefix so a dotenv boot tip or other stdout noise doesn't defeat the match.
  const out = execFileSync(
    process.execPath,
    ['-e', 'import(process.env.DB_MODULE_URL).then((m) => { console.log("BUSY_TIMEOUT=" + m.db.pragma("busy_timeout", { simple: true })); m.db.close(); });'],
    { env: { ...process.env, DB_BUSY_TIMEOUT_MS: '1234', DB_PATH: tmp, DB_MODULE_URL: dbUrl }, encoding: 'utf8' },
  );
  assert.match(out, /BUSY_TIMEOUT=1234\b/);
  rmSync(tmp, { force: true });
  rmSync(`${tmp}-wal`, { force: true });
  rmSync(`${tmp}-shm`, { force: true });
});

test('storeArtifactTxn: create stores a rank-ordered vector under the right id (BigInt vec0 PK)', () => {
  // If the internal BigInt(id) cast regressed to a plain Number, insertVecArtifactStmt would
  // throw "Only integers are allowed for primary key values" and this store would fail.
  const near = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'near', text_repr: 'a near memory' },
    f32(0.2),
  );
  const far = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'far', text_repr: 'a far memory' },
    f32(0.8),
  );
  assert.equal(near.deduped, false);
  assert.equal(typeof near.id, 'number');
  // Query near f32(0.2): the near artifact must rank ahead of the far one. Ranking (not mere
  // membership) proves the vector was stored under the correct artifact id, not just inserted.
  const ranked = knnStmt.all(f32(0.2), 10).map((r) => r.artifact_id);
  assert.ok(ranked.includes(near.id) && ranked.includes(far.id), 'both vectors are KNN-queryable');
  assert.ok(ranked.indexOf(near.id) < ranked.indexOf(far.id), 'the nearer vector ranks first');
});

test('storeArtifactTxn: duplicate (source, source_id) dedups without a second vector row', () => {
  const source = uniqueSource();
  const a = storeArtifactTxn({ type: 'note', source, source_id: 'dup', text_repr: 'first' }, f32(0.3));
  const b = storeArtifactTxn({ type: 'note', source, source_id: 'dup', text_repr: 'second' }, f32(0.4));
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(b.id, a.id, 'dedup returns the existing id');
  assert.equal(countVecStmt.get(a.id).n, 1, 'no second vector row inserted on dedup');
});

test('upsertArtifactTxn: create path requires an embedding vector', () => {
  assert.throws(
    () => upsertArtifactTxn({ type: 'note', source: uniqueSource(), source_id: 'x', text_repr: 't' }, null),
    /requires an embedding vector/,
  );
});

test('upsertArtifactTxn: update rewrites text_repr but preserves append-only originals', () => {
  const source = uniqueSource();
  const hash = 'a'.repeat(64);
  const created = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'original text', content_hash: hash, raw_path: '/raw/original' },
    f32(0.5),
  );
  assert.equal(created.created, true);
  const before = getArtifactById(created.id);

  // The update deliberately sends a DIFFERENT content_hash/raw_path: if either were ever added to
  // db.js's MUTABLE_FIELDS (regressing the append-only-originals rule), the stored value would
  // change and the assertions below would fail. Omitting them would make preservation trivially
  // true (absent → COALESCE keeps the old value) and catch no such regression.
  const updated = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'revised text', content_hash: 'b'.repeat(64), raw_path: '/raw/CHANGED' },
    f32(0.6),
  );
  assert.equal(updated.created, false);
  const after = getArtifactById(created.id);
  assert.equal(after.text_repr, 'revised text', 'derived text_repr is rewritten');
  assert.equal(after.content_hash, hash, 'content_hash (original) is never overwritten');
  assert.equal(after.raw_path, '/raw/original', 'raw_path (original) is never overwritten');
  assert.equal(after.ingested_at, before.ingested_at, 'ingested_at (first-ingest time) is frozen');
});

test('upsertArtifactTxn: metadata-only update keeps prior text_repr (COALESCE of absent field)', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'keep me' },
    f32(0.5),
  );
  // No text_repr, no vector — only a metadata field changes.
  upsertArtifactTxn({ type: 'note', source, source_id: '1', place_label: 'Berlin' }, null);
  const a = getArtifactById(id);
  assert.equal(a.text_repr, 'keep me', 'absent text_repr must not be wiped');
  assert.equal(a.place_label, 'Berlin', 'present metadata field is applied');
});

test('FTS stays in sync on update: OLD terms are removed, NEW terms are searchable', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'the zebrafish swims' },
    f32(0.5),
  );
  assert.ok(ftsStmt.all('zebrafish').some((r) => r.rowid === id), 'new row is indexed on insert');

  upsertArtifactTxn({ type: 'note', source, source_id: '1', text_repr: 'the quokka hops' }, f32(0.6));
  // If artifacts_au's 'delete' stopped carrying the OLD text_repr, 'zebrafish' would linger.
  assert.equal(ftsStmt.all('zebrafish').length, 0, 'old term is removed from the FTS index');
  assert.ok(ftsStmt.all('quokka').some((r) => r.rowid === id), 'new term is searchable');
});

test('vec_artifacts enforces VECTOR_DIMENSION (wrong-length vector is rejected)', () => {
  const insertVec = db.prepare('INSERT INTO vec_artifacts (artifact_id, embedding) VALUES (?, ?)');
  assert.throws(() => insertVec.run(BigInt(999_999), new Float32Array(512)));
});

test('resolveEntityHints: deterministic types earn 1.0, name/handle are capped, and re-submit is idempotent', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Ada Lovelace', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'ada@example.com', 'email');
  insertAliasStmt.run(entityId, 'ada lovelace', 'name');

  const { id } = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: '1', text_repr: 'note about ada' },
    f32(0.5),
  );

  // Distinct roles so both links persist (entity_links PK is (artifact_id, entity_id, role) —
  // same role to the same entity would collide). email supplies 0.5 but a deterministic type is
  // forced to 1.0; name supplies 0.99, capped at 0.9.
  const hints = [
    { alias: 'ada@example.com', alias_type: 'email', role: 'sender', confidence: 0.5 },
    { alias: 'Ada Lovelace', alias_type: 'name', role: 'mentioned', confidence: 0.99 },
  ];
  const r = resolveEntityHints(id, hints);
  assert.equal(r.resolved, 2);

  const byRole = Object.fromEntries(getArtifactById(id).links.map((l) => [l.role, l.confidence]));
  assert.equal(byRole.sender, 1, 'deterministic (email) hint linked at confidence 1.0');
  assert.equal(byRole.mentioned, 0.9, 'name hint capped at confidence 0.9');

  // Re-submitting the identical hints stages zero new links (entity_links PK + OR IGNORE).
  const linksBefore = getArtifactById(id).links.length;
  resolveEntityHints(id, hints);
  assert.equal(getArtifactById(id).links.length, linksBefore, 'idempotent — no duplicate links');
});

test('resolveEntityHints (#293): a bare first name falls back to the unambiguous given-name-prefix match', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Suzie Araujo', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'suzie araujo', 'name');

  const { id } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: '1', text_repr: 'a beach photo' },
    f32(0.5),
  );
  const r = resolveEntityHints(id, [{ alias: 'suzie', alias_type: 'name', role: 'pictured', confidence: 0.8 }]);
  assert.equal(r.resolved, 1, 'the bare given name resolves via the prefix fallback, not just exact match');
  assert.equal(r.unresolved, 0);

  const links = getArtifactById(id).links;
  assert.equal(links.length, 1);
  assert.equal(links[0].role, 'pictured');
  // #296: an inference earns its own tier, below the 0.9 an exact name match would have earned.
  assert.equal(links[0].confidence, NAME_PREFIX_CONFIDENCE_CAP, 'prefix inference is capped at 0.6, not recorded as an exact match');

  const unresolvedRow = db.prepare(
    `SELECT 1 FROM unresolved_aliases WHERE artifact_id = ? AND alias = 'suzie'`,
  ).get(id);
  assert.equal(unresolvedRow, undefined, 'a resolved hint is never also staged as unresolved');

  // #296: the inference is never minted — a durable ('suzie','name') row would own the alias
  // globally and deny a second Suzie her own given name.
  assert.equal(
    db.prepare(`SELECT 1 FROM entity_aliases WHERE alias = 'suzie' AND alias_type = 'name'`).get(),
    undefined,
    'the bare given name is NOT written to entity_aliases',
  );

  // The same run: an exact name hint still earns the higher tier, so the ladder is observable.
  const { id: id2 } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: '1b', text_repr: 'another beach photo' },
    f32(0.5),
  );
  resolveEntityHints(id2, [{ alias: 'Suzie Araujo', alias_type: 'name', role: 'pictured', confidence: 0.8 }]);
  assert.equal(getArtifactById(id2).links[0].confidence, 0.8, 'an exact name match keeps the connector-supplied 0.8, above the inference tier');
});

test('resolveEntityHints (#296): a tombstoned given name is not re-inferred through the fuller alias', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Marcus Delaney', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'marcus delaney', 'name');
  // The user explicitly removed the bare given name via the contacts UI (#111) — that intent must
  // survive, or the prefix path re-infers it through the surviving fuller alias on every ingest.
  addAlias(entityId, 'marcus', 'name');
  removeAlias(entityId, 'marcus', 'name');
  assert.ok(
    db.prepare(`SELECT 1 FROM alias_tombstones WHERE entity_id = ? AND alias = 'marcus' AND alias_type = 'name'`).get(entityId),
    'precondition: the removal is tombstoned',
  );

  const { id } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: '2b', text_repr: 'a hiking photo' },
    f32(0.5),
  );
  const r = resolveEntityHints(id, [{ alias: 'marcus', alias_type: 'name', role: 'pictured' }]);
  assert.equal(r.resolved, 0, 'a tombstoned given name is never re-inferred');
  assert.equal(r.unresolved, 1);
  assert.equal(getArtifactById(id).links.length, 0);
  assert.ok(
    db.prepare(`SELECT 1 FROM unresolved_aliases WHERE artifact_id = ? AND alias = 'marcus'`).get(id),
    'it stages instead, like any other miss',
  );
});

test('resolveEntityHints (#293): a first name shared by two entities stays unresolved, not guessed', () => {
  insertEntityStmt.run('person', 'Jamie Foster', null);
  insertAliasStmt.run(Number(insertEntityStmt.run('person', 'Jamie Lin', null).lastInsertRowid), 'jamie lin', 'name');
  const fosterId = Number(db.prepare(`SELECT id FROM entities WHERE canonical_name = 'Jamie Foster'`).get().id);
  insertAliasStmt.run(fosterId, 'jamie foster', 'name');

  const { id } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: '2', text_repr: 'a park photo' },
    f32(0.5),
  );
  const r = resolveEntityHints(id, [{ alias: 'jamie', alias_type: 'name', role: 'pictured' }]);
  assert.equal(r.resolved, 0, 'ambiguous across 2 entities — no link guessed');
  assert.equal(r.unresolved, 1);
  assert.equal(getArtifactById(id).links.length, 0);

  const unresolvedRow = db.prepare(
    `SELECT 1 FROM unresolved_aliases WHERE artifact_id = ? AND alias = 'jamie'`,
  ).get(id);
  assert.ok(unresolvedRow, 'the ambiguous hint is staged for later manual/contact resolution');
});

test('backfill:name-prefix-links (#293/#296): heals a hint staged before the entity existed, mints nothing, and is idempotent', () => {
  // Stage the hint first (mirrors a photo ingested before the contact existed) — exact match
  // misses because there's no entity yet, so it lands in unresolved_aliases.
  const { id } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: '3', text_repr: 'a birthday photo' },
    f32(0.5),
  );
  resolveEntityHints(id, [{ alias: 'andrea', alias_type: 'name', role: 'pictured', confidence: 0.7 }]);
  assert.equal(getArtifactById(id).links.length, 0, 'no entity exists yet — hint is only staged');

  // Now the contact arrives, aliased under her full name only.
  const entityId = Number(insertEntityStmt.run('person', 'Andrea Crook', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'andrea crook', 'name');

  const aliasesBefore = db.prepare(`SELECT COUNT(*) AS n FROM entity_aliases`).get().n;
  const s = backfillNamePrefixLinks();
  assert.equal(s.linksFormed, 1);

  const links = getArtifactById(id).links;
  assert.equal(links.length, 1, 'the staged photo hint is retroactively linked');
  assert.equal(links[0].role, 'pictured');
  assert.equal(links[0].confidence, NAME_PREFIX_CONFIDENCE_CAP, 'retroactive links use the same inference tier as the live path');
  // #296: the backfill links, it does not mint. A durable ('andrea','name') row would own the
  // alias globally and bypass the ambiguity guard on every later hint.
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM entity_aliases`).get().n,
    aliasesBefore,
    'no alias row is added by the backfill',
  );
  assert.equal(
    db.prepare(`SELECT 1 FROM entity_aliases WHERE entity_id = ? AND alias = 'andrea' AND alias_type = 'name'`).get(entityId),
    undefined,
    'specifically, the bare given name is not registered',
  );

  const s2 = backfillNamePrefixLinks(); // idempotent
  assert.equal(s2.linksFormed, 0, 'second run forms no new links');
});

test('fix:name-prefix-confidence (#296): re-tiers mint-era 0.9 links to 0.6, leaves other links alone, idempotent', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Stefanie Epstein', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'stefanie epstein', 'name');
  insertAliasStmt.run(entityId, 'stefanie@example.test', 'email');

  // A link the mint-era backfill would have written: staged bare-name hint, recorded at the
  // exact-match tier (0.9) because the old code minted the alias and resolved it as exact.
  const { id: guessed } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: '4', text_repr: 'a wedding photo' },
    f32(0.5),
  );
  // Reconstruct the mint-era state directly rather than via resolveEntityHints — the fixed path
  // would resolve this hint at 0.6 on the spot, which is the very state this repair predates.
  db.prepare(`INSERT INTO unresolved_aliases (artifact_id, alias, alias_type, role, hint_confidence) VALUES (?, 'stefanie', 'name', 'pictured', NULL)`).run(guessed);
  db.prepare(`INSERT INTO entity_links (artifact_id, entity_id, role, confidence) VALUES (?, ?, 'pictured', ?)`)
    .run(guessed, entityId, NAME_HANDLE_CONFIDENCE_CAP);

  // A link earned on deterministic evidence — must survive untouched.
  const { id: solid } = storeArtifactTxn(
    { type: 'email', source: uniqueSource(), source_id: '5', text_repr: 'an email' },
    f32(0.5),
  );
  resolveEntityHints(solid, [{ alias: 'stefanie@example.test', alias_type: 'email', role: 'sender' }]);
  assert.equal(getArtifactById(solid).links[0].confidence, 1.0, 'precondition: deterministic link at 1.0');

  // A SECOND link on the mis-tiered artifact, same entity, different role, earned by an exact
  // full-name match. entity_links' PK is (artifact_id, entity_id, role), so it coexists with the
  // guessed one — and the only-basis guard must not sweep it up just because this artifact
  // happens to have staged the bare name. This is what correlating u.role buys.
  db.prepare(`INSERT INTO entity_links (artifact_id, entity_id, role, confidence) VALUES (?, ?, 'mentioned', ?)`)
    .run(guessed, entityId, NAME_HANDLE_CONFIDENCE_CAP);

  // --dry-run reports the same count but writes nothing — a one-shot that rewrites rows must be
  // inspectable before it runs.
  const dry = fixNamePrefixLinkConfidence({ dryRun: true });
  assert.equal(dry.linksCorrected, 1, 'dry run reports the pending correction');
  assert.equal(getArtifactById(guessed).links[0].confidence, NAME_HANDLE_CONFIDENCE_CAP, 'dry run changed nothing');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'name_prefix_confidence_corrected'`).get().n,
    0,
    'dry run writes no log row',
  );

  const s = fixNamePrefixLinkConfidence();
  assert.equal(s.linksCorrected, 1, 'exactly the mis-tiered link is corrected');
  const guessedLinks = getArtifactById(guessed).links;
  assert.equal(
    guessedLinks.find((l) => l.role === 'pictured').confidence, NAME_PREFIX_CONFIDENCE_CAP,
    'the prefix-inferred link is re-tiered',
  );
  assert.equal(
    guessedLinks.find((l) => l.role === 'mentioned').confidence, NAME_HANDLE_CONFIDENCE_CAP,
    'a same-entity link under a different role keeps its exact-match tier',
  );
  assert.equal(getArtifactById(solid).links[0].confidence, 1.0, 'the deterministic link is never demoted');

  const s2 = fixNamePrefixLinkConfidence(); // idempotent — nothing sits at 0.9 anymore
  assert.equal(s2.linksCorrected, 0, 'second run corrects nothing');
});

test('backfill:name-prefix-links (#296): an ambiguous staged name forms no link and counts as stillUnresolved', () => {
  // Two entities whose fuller names both start with the same given name — resolveNameByPrefix
  // returns 2 candidates, so the retroactive path must refuse to guess exactly like the live one.
  const a = Number(insertEntityStmt.run('person', 'Dana Whitfield', null).lastInsertRowid);
  const b = Number(insertEntityStmt.run('person', 'Dana Okonkwo', null).lastInsertRowid);
  insertAliasStmt.run(a, 'dana whitfield', 'name');
  insertAliasStmt.run(b, 'dana okonkwo', 'name');

  const { id } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: '6', text_repr: 'a group photo' },
    f32(0.5),
  );
  db.prepare(`INSERT INTO unresolved_aliases (artifact_id, alias, alias_type, role, hint_confidence) VALUES (?, 'dana', 'name', 'pictured', NULL)`).run(id);

  const s = backfillNamePrefixLinks();
  assert.equal(getArtifactById(id).links.length, 0, 'an ambiguous given name is never guessed at');
  assert.ok(s.stillUnresolved >= 1, 'and it is counted as still unresolved, not silently dropped');
});

// --- display_text handle annotation (#147) ---
test('display_text (#147): a linked handle in text_repr renders the contact name; text_repr stays raw; unlinked/absent left verbatim', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Amy Margaret Fenwick', null).lastInsertRowid);
  // Alias stored under the canonical key (no +1, #129) — proves the lookup normalizes the +1 handle.
  insertAliasStmt.run(entityId, normalizePhone('+12025550171'), 'phone');
  const raw = 'Message from +12025550171: "call 5551234567 later"'; // second number is NOT a linked entity
  const { id } = storeArtifactTxn(
    { type: 'message', source: uniqueSource(), source_id: 'msg-147', text_repr: raw },
    f32(0.5),
    [{ entity_id: entityId, role: 'sender', confidence: 1.0 }],
  );
  const a = getArtifactById(id);
  assert.equal(a.text_repr, raw, 'stored text_repr is byte-for-byte unchanged (append-only)');
  assert.equal(
    a.display_text,
    'Message from Amy Margaret Fenwick (+12025550171): "call 5551234567 later"',
    'the linked handle is renamed; the unlinked number in the body is left verbatim',
  );

  // No links -> display_text is just text_repr (no annotation, no crash).
  const { id: bare } = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'note-147', text_repr: 'Message from +12025550171: "hi"' },
    f32(0.5),
  );
  assert.equal(getArtifactById(bare).display_text, 'Message from +12025550171: "hi"');
});

test('display_text (#147): email tokens resolve by email alias only — a digit-heavy email never matches a phone alias', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Dana Ortega', null).lastInsertRowid);
  insertAliasStmt.run(entityId, normalizePhone('+12565550111'), 'phone'); // canonical -> 2565550111
  insertAliasStmt.run(entityId, 'dana@example.com', 'email');
  // First email's digits (2565550111) equal Dana's phone; routing an email through the phone path
  // would mis-annotate it (Copilot, PR #148). Second email is Dana's real address and must annotate.
  const raw = 'Email from h2565550111@example.com; reply to dana@example.com';
  const { id } = storeArtifactTxn(
    { type: 'email', source: uniqueSource(), source_id: 'em-147', text_repr: raw },
    f32(0.5),
    [{ entity_id: entityId, role: 'sender', confidence: 1.0 }],
  );
  const d = getArtifactById(id).display_text;
  assert.ok(!d.includes('(h2565550111@example.com)'), 'a digit-heavy email must not match a phone alias');
  assert.equal(
    d,
    'Email from h2565550111@example.com; reply to Dana Ortega (dana@example.com)',
    'only the real email resolves, via its email alias',
  );
});

test('annotateArtifactRows (#149): batch-attaches display_text; linked row annotated, unlinked left raw; empty is safe', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Bianca Lopez', null).lastInsertRowid);
  insertAliasStmt.run(entityId, normalizePhone('+12025550143'), 'phone');
  const { id: linked } = storeArtifactTxn(
    { type: 'message', source: uniqueSource(), source_id: 'ar-linked', text_repr: 'Message from +12025550143: "hi"' },
    f32(0.5),
    [{ entity_id: entityId, role: 'sender', confidence: 1.0 }],
  );
  const { id: unlinked } = storeArtifactTxn(
    { type: 'message', source: uniqueSource(), source_id: 'ar-unlinked', text_repr: 'Message from +19998887777: "yo"' },
    f32(0.5),
  );
  // Raw rows as timeline/about_entity fetch them — no links, no display_text until annotated.
  const rows = [
    { id: linked, text_repr: 'Message from +12025550143: "hi"' },
    { id: unlinked, text_repr: 'Message from +19998887777: "yo"' },
  ];
  const out = annotateArtifactRows(rows);
  assert.equal(out, rows, 'mutates and returns the same array');
  assert.equal(rows[0].display_text, 'Message from Bianca Lopez (+12025550143): "hi"');
  assert.equal(rows[1].display_text, 'Message from +19998887777: "yo"', 'unlinked handle left verbatim');
  assert.equal(annotateArtifactRows([]).length, 0, 'empty input is safe');
});

// --- Side contact directory (#154) ---
test('contact_directory (#154): insert is idempotent + normalized + collision-detected; lookup normalizes', () => {
  const a = insertDirectoryEntry('Jane Directory', '+1 (555) 123-0001', 'phone');
  assert.equal(a.inserted, true);
  assert.equal(insertDirectoryEntry('Jane Directory', '15551230001', 'phone').inserted, false, 'same handle+name is a no-op (normalized key match)');
  // A different name for the same normalized handle is a logged collision, first-writer-wins.
  const c = insertDirectoryEntry('Someone Else', '5551230001', 'phone');
  assert.equal(c.inserted, false); assert.equal(c.collision, true);
  // Lookup matches regardless of +1 / formatting (#129); email lowercased.
  assert.equal(lookupDirectoryName('5551230001', 'phone'), 'Jane Directory');
  assert.equal(lookupDirectoryName('+15551230001', 'phone'), 'Jane Directory');
  insertDirectoryEntry('Mail Person', 'Mail@Example.com', 'email');
  assert.equal(lookupDirectoryName('mail@example.com', 'email'), 'Mail Person');
  assert.equal(lookupDirectoryName('9999999999', 'phone'), null, 'unknown handle → null');
});

test('resolveEntityHints (#154): a directory-known miss stages a person proposal (name pre-filled); an unknown miss does not', () => {
  insertDirectoryEntry('Dir Sender', '5551239100', 'phone');
  const { id } = storeArtifactTxn({ type: 'message', source: uniqueSource(), source_id: 'dir-hint', text_repr: 'Message from +15551239100: "hi"' }, f32(0.4));
  const before = listProposedEntities('pending', 100).length;
  resolveEntityHints(id, [
    { alias: '+15551239100', alias_type: 'phone', role: 'sender' }, // in directory → proposal
    { alias: '5559999999', alias_type: 'phone', role: 'sender' },   // not in directory → no proposal
  ]);
  const pending = listProposedEntities('pending', 100);
  const mine = pending.filter((p) => p.alias === '5551239100');
  assert.equal(mine.length, 1, 'exactly one directory-sourced proposal');
  assert.equal(mine[0].suggested_kind, 'person');
  assert.equal(mine[0].suggested_name, 'Dir Sender', 'name pre-filled from the directory');
  assert.ok(!pending.some((p) => p.alias === '5559999999'), 'an unknown handle stages no proposal');
  assert.equal(pending.length, before + 1, 'only the directory-known handle proposed');
});

test('annotateHandles (#154): auto-labels an unlinked handle from the directory; a curated link still wins', () => {
  // Unlinked handle, present only in the directory → display borrows the directory name.
  insertDirectoryEntry('Auto Label', '5551237777', 'phone');
  const { id: unlinked } = storeArtifactTxn({ type: 'message', source: uniqueSource(), source_id: 'al-1', text_repr: 'Message from +15551237777: "yo"' }, f32(0.4));
  assert.equal(getArtifactById(unlinked).display_text, 'Message from Auto Label (+15551237777): "yo"');

  // Curated entity wins over a (conflicting) directory entry for the same number.
  const eid = Number(insertEntityStmt.run('person', 'Curated Winner', null).lastInsertRowid);
  insertAliasStmt.run(eid, normalizePhone('+15551238888'), 'phone');
  insertDirectoryEntry('Directory Loser', '5551238888', 'phone');
  const { id: linked } = storeArtifactTxn(
    { type: 'message', source: uniqueSource(), source_id: 'al-2', text_repr: 'Message from +15551238888: "hey"' },
    f32(0.4), [{ entity_id: eid, role: 'sender', confidence: 1.0 }],
  );
  assert.equal(getArtifactById(linked).display_text, 'Message from Curated Winner (+15551238888): "hey"');
});

test('backfillDirectoryProposals (#154): stages proposals for historical unresolved matches; idempotent', () => {
  // Simulate history: a handle staged as unresolved BEFORE it was in the directory (no proposal then).
  const { id } = storeArtifactTxn({ type: 'message', source: uniqueSource(), source_id: 'bf-1', text_repr: 'Message from +15551235555: "old"' }, f32(0.4));
  resolveEntityHints(id, [{ alias: '+15551235555', alias_type: 'phone', role: 'sender' }]);
  assert.ok(!listProposedEntities('pending', 200).some((p) => p.alias === '5551235555'), 'no proposal before the directory knows it');
  insertDirectoryEntry('Backfilled Person', '5551235555', 'phone');
  const first = backfillDirectoryProposals();
  assert.ok(first.proposed >= 1, 'backfill stages the now-known handle');
  const staged = listProposedEntities('pending', 200).find((p) => p.alias === '5551235555');
  assert.equal(staged.suggested_name, 'Backfilled Person');
  const second = backfillDirectoryProposals();
  assert.equal(second.proposed, 0, 'idempotent — a second run stages nothing new');
});

// --- Name-type hints consult the side directory (#301) ---
// photo-exif emits every folder-name person hint as alias_type:'name' and never a handle, so before
// this the handle-keyed directory branch could not reach them at all: 40 names the directory knows,
// 6,280 hint rows across 4,949 artifacts, zero proposals. Nothing is ever minted — the directory
// names the person, the human promotes.
const photoNameHint = (name, sourceId) => {
  const { id } = storeArtifactTxn({ type: 'photo', source: uniqueSource(), source_id: sourceId, text_repr: `Photo of ${name}` }, f32(0.44));
  resolveEntityHints(id, [{ alias: name, alias_type: 'name', role: 'pictured', confidence: 0.9 }]);
  return id;
};
const pendingFor = (alias) => listProposedEntities('pending', 500).filter((p) => p.alias === alias);

test('resolveEntityHints (#301): a name hint the directory knows stages ONE person proposal, and mints nothing', () => {
  insertDirectoryEntry('Delphine Marchand', '+1 (614) 555-2400', 'phone');
  const beforeEntities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const first = photoNameHint('Delphine Marchand', 'delphine-1');

  const staged = pendingFor('delphine marchand');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].suggested_kind, 'person');
  assert.equal(staged[0].suggested_name, 'Delphine Marchand', "the directory's display name is pre-filled");
  assert.equal(staged[0].alias_type, 'name', 'keyed by the name alias, which is what approval will seed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, beforeEntities, 'still zero entities — a proposal is not a contact');
  assert.ok(db.prepare('SELECT 1 FROM unresolved_aliases WHERE artifact_id = ? AND alias = ?').get(first, 'delphine marchand'), 'the hint is still staged as unresolved too (the proposal is additional)');

  // The 1,887-photos-of-one-person case: the UNIQUE key absorbs every repeat.
  const second = photoNameHint('Delphine Marchand', 'delphine-2');
  photoNameHint('Delphine Marchand', 'delphine-3');
  assert.equal(pendingFor('delphine marchand').length, 1, 'still exactly one proposal');

  // The payoff: approving links EVERY artifact that shared the name hint, in one call.
  const { entity_id } = approveProposedEntity(staged[0].id);
  for (const artifactId of [first, second]) {
    assert.ok(db.prepare('SELECT 1 FROM entity_links WHERE artifact_id = ? AND entity_id = ?').get(artifactId, entity_id), 'every photo that named her is linked');
  }
  assert.ok(resolveEntityIds('Delphine Marchand').includes(entity_id));
});

test('resolveEntityHints (#301): no proposal for a name the directory does not know, or an ambiguous one', () => {
  const unknown = photoNameHint('Absent Fromdirectory', 'absent-1');
  assert.equal(pendingFor('absent fromdirectory').length, 0, 'no proposal — the directory cannot name her');
  assert.ok(db.prepare('SELECT 1 FROM unresolved_aliases WHERE artifact_id = ? AND alias = ?').get(unknown, 'absent fromdirectory'), 'but the hint still stages exactly as before');

  // Two DIFFERENT cards sharing a display name: the directory cannot say which person, so it must
  // not pick one. This is the safety rule most likely to be "simplified" later.
  const cardA = upsertDirectoryCard({ card_key: 'amb-a', name: 'Robin Sandoval', attrs: {} });
  const cardB = upsertDirectoryCard({ card_key: 'amb-b', name: 'Robin Sandoval', attrs: {} });
  insertDirectoryEntry('Robin Sandoval', '+1 (615) 555-1000', 'phone', cardA.id);
  insertDirectoryEntry('Robin Sandoval', '+1 (615) 555-2000', 'phone', cardB.id);
  assert.equal(lookupDirectoryByName('Robin Sandoval'), null, 'two cards, one display name → refuses to guess');
  photoNameHint('Robin Sandoval', 'ambiguous-1');
  assert.equal(pendingFor('robin sandoval').length, 0, 'and stages no proposal');

  // Several rows for the SAME card are one contact's several handles — not ambiguity.
  const solo = upsertDirectoryCard({ card_key: 'solo-1', name: 'Priya Venkataraman', attrs: {} });
  insertDirectoryEntry('Priya Venkataraman', '+1 (616) 555-3000', 'phone', solo.id);
  insertDirectoryEntry('Priya Venkataraman', 'priya.v@example.com', 'email', solo.id);
  assert.equal(lookupDirectoryByName('priya venkataraman'), 'Priya Venkataraman', 'one card with several handles resolves');

  // Card-less (pre-#304) rows: several same-spelling rows resolve as one contact — the common case —
  // but the imprecision is announced rather than hidden (Copilot, PR #315).
  insertDirectoryEntry('Solveig Nyborg', '+1 (617) 555-9100', 'phone');
  insertDirectoryEntry('Solveig Nyborg', 'solveig@example.com', 'email');
  // #328: the warning is a queryable WARN row now, not a console line.
  const before = readEvents(log).at(-1)?.id ?? 0;
  assert.equal(lookupDirectoryByName('Solveig Nyborg'), 'Solveig Nyborg', 'card-less multi-handle rows still resolve');
  assert.equal(lookupDirectoryByName('Solveig Nyborg'), 'Solveig Nyborg');
  assert.equal(lookupDirectoryByName('solveig nyborg'), 'Solveig Nyborg');
  const warnings = readEvents(log, { event: 'directory.name.cardless', since: before });
  assert.equal(warnings.length, 1, 'warned ONCE, not once per photo — the same folder hint arrives on every photo in the folder');
  assert.equal(warnings[0].level, 'WARN');
  assert.ok(warnings[0].msg.includes('directory:load'), 'and the un-disambiguatable state is logged with the remedy');
  assert.equal(JSON.parse(warnings[0].data).rows, 2, 'by row count — never by the contact name that triggered it');
});

test('resolveEntityHints (#301): the directory is a last resort — an exact alias, a prefix match, or a suggested_kind all win first', () => {
  // (a) exact alias: resolves, no proposal.
  const exact = Number(insertEntityStmt.run('person', 'Curated Alessia Ferrari', null).lastInsertRowid);
  insertAliasStmt.run(exact, 'alessia ferrari', 'name');
  insertDirectoryEntry('Alessia Ferrari', '+1 (617) 555-4000', 'phone');
  const a = photoNameHint('Alessia Ferrari', 'alessia-1');
  assert.ok(db.prepare('SELECT 1 FROM entity_links WHERE artifact_id = ? AND entity_id = ?').get(a, exact), 'linked by the exact alias');
  assert.equal(pendingFor('alessia ferrari').length, 0, 'the directory was never consulted');

  // (b) #293 prefix inference: a bare given name resolves to the one entity it prefixes.
  const full = Number(insertEntityStmt.run('person', 'Ignatius Bellweather-Cruz', null).lastInsertRowid);
  insertAliasStmt.run(full, 'ignatius bellweather-cruz', 'name');
  insertDirectoryEntry('Ignatius', '+1 (618) 555-5000', 'phone'); // the directory also knows the bare name
  const b = photoNameHint('Ignatius', 'ignatius-1');
  assert.ok(db.prepare('SELECT 1 FROM entity_links WHERE artifact_id = ? AND entity_id = ?').get(b, full), 'prefix-inferred link formed');
  assert.equal(pendingFor('ignatius').length, 0, 'so no directory proposal was staged');

  // (c) a connector-stated suggested_kind still wins and is not renamed by the directory.
  insertDirectoryEntry('Halvard Osterlund', '+1 (619) 555-6000', 'phone');
  const { id } = storeArtifactTxn({ type: 'document', source: uniqueSource(), source_id: 'kind-1', text_repr: 'invoice' }, f32(0.45));
  resolveEntityHints(id, [{ alias: 'Halvard Osterlund LLC', alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }]);
  const kinded = pendingFor('halvard osterlund llc');
  assert.equal(kinded.length, 1);
  assert.equal(kinded[0].suggested_kind, 'org', 'the connector-stated kind is untouched');
  assert.equal(kinded[0].suggested_name, 'Halvard Osterlund LLC', 'and so is its name — the directory does not rename it');
});

test('backfillDirectoryProposals (#301): scans name hints too, skips prefix-resolvable and curated ones, idempotent', () => {
  // History: the photo import staged these names before the directory could be consulted for them.
  const historical = photoNameHint('Yusuf Abdallah', 'hist-1');
  photoNameHint('Yusuf Abdallah', 'hist-2');
  assert.equal(pendingFor('yusuf abdallah').length, 0, 'precondition: nothing staged at ingest time');
  insertDirectoryEntry('Yusuf Abdallah', '+1 (620) 555-7000', 'phone'); // directory loaded afterwards

  // A name the directory knows that ALSO prefix-resolves must not be proposed — it is already someone.
  const prefixOwner = Number(insertEntityStmt.run('person', 'Cassandra Whitfield', null).lastInsertRowid);
  insertAliasStmt.run(prefixOwner, 'cassandra whitfield', 'name');
  photoNameHint('Cassandra', 'hist-3');
  insertDirectoryEntry('Cassandra', '+1 (621) 555-8000', 'phone');

  const run = backfillDirectoryProposals();
  assert.ok(run.proposed >= 1);
  const staged = pendingFor('yusuf abdallah');
  assert.equal(staged.length, 1, 'the historical name hint is now proposed');
  assert.equal(staged[0].suggested_name, 'Yusuf Abdallah');
  assert.equal(staged[0].artifact_id, historical, 'MIN(artifact_id) is the representative artifact');
  assert.equal(pendingFor('cassandra').length, 0, 'a prefix-resolvable name is skipped, not duplicated');
  assert.equal(backfillDirectoryProposals().proposed, 0, 'idempotent — a second run stages nothing new');
});

// --- stagePicturedProposals (#350): stage stranded `pictured` name hints as entity proposals ---
// A sidecar people[]/folder-name hint (photoNameHint, above — role='pictured', alias_type='name')
// that matches no directory entry never gets a proposal from resolveEntityHints itself: it just
// sits in unresolved_aliases forever. This backfill is the only thing that ever reaches it.
test('stagePicturedProposals (#350): stages one proposal per stranded pictured name, ordered by impact, and a second run is fully idempotent', () => {
  const big = 'Fennimore Castellworth', mid = 'Odalys Vantongeren', small = 'Peregrine Ashcombe';
  photoNameHint(big, 'ord-big-1'); photoNameHint(big, 'ord-big-2'); photoNameHint(big, 'ord-big-3');
  photoNameHint(mid, 'ord-mid-1'); photoNameHint(mid, 'ord-mid-2');
  photoNameHint(small, 'ord-small-1');

  const first = stagePicturedProposals();
  assert.ok(first.staged >= 3, 'at least our 3 fresh names are staged (plus possibly older backlog)');
  for (const name of [big, mid, small]) {
    const rows = pendingFor(normalizeName(name));
    assert.equal(rows.length, 1, `${name} staged exactly once`);
    assert.equal(rows[0].suggested_kind, 'person');
    assert.equal(rows[0].suggested_name, normalizeName(name), 'no directory to draw a display name from — the alias itself is the suggested name');
  }

  // Ordering: filtered to just our 3 names, impact-descending (3, 2, 1).
  const ranks = listStrandedPicturedNames()
    .filter((r) => [big, mid, small].map(normalizeName).includes(r.alias))
    .map((r) => r.alias);
  assert.deepEqual(ranks, [big, mid, small].map(normalizeName), 'ordered by distinct-artifact count desc');

  // Idempotent: EVERY name in the whole backlog was resolved-or-staged by the first call, so an
  // immediate second run finds nothing new anywhere in the table, not just our 3 test names.
  const second = stagePicturedProposals();
  assert.equal(second.staged, 0, 'idempotent — a second run stages 0');
  assert.equal(second.skippedExact + second.skippedPrefix + second.skippedDecided, second.namesScanned, 'every scanned name now falls into a skip bucket');
});

test('stagePicturedProposals (#350): skips a name that already resolves via an exact alias', () => {
  const name = 'Xiomara Delacroix-Fenwick';
  photoNameHint(name, 'exact-skip-1'); // stranded — no entity exists yet
  const entityId = Number(insertEntityStmt.run('person', name, null).lastInsertRowid);
  insertAliasStmt.run(entityId, normalizeName(name), 'name'); // the contact arrives afterwards

  const r = stagePicturedProposals();
  assert.ok(r.skippedExact >= 1);
  assert.equal(pendingFor(normalizeName(name)).length, 0, 'no proposal for a name the graph already resolves exactly');
});

test('stagePicturedProposals (#350): skips a name resolvable via the #293 unambiguous given-name prefix', () => {
  const bare = 'Thaddeus';
  photoNameHint(bare, 'prefix-skip-1'); // stranded — no entity exists yet
  const entityId = Number(insertEntityStmt.run('person', 'Thaddeus Okonkwo-Reyes', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'thaddeus okonkwo-reyes', 'name'); // arrives afterwards, prefix-matches "thaddeus"

  const r = stagePicturedProposals();
  assert.ok(r.skippedPrefix >= 1);
  assert.equal(pendingFor(normalizeName(bare)).length, 0, 'no proposal — the #293 inference already owns this name, staging one would risk a duplicate');
});

test('stagePicturedProposals (#350): an already-rejected proposal is not re-staged (#300)', () => {
  const name = 'Marguerite Van Der Berg';
  photoNameHint(name, 'decided-1');
  stagePicturedProposals();
  const staged = pendingFor(normalizeName(name));
  assert.equal(staged.length, 1, 'precondition: first run staged it');
  rejectProposedEntity(staged[0].id);

  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n;
  const r = stagePicturedProposals();
  assert.ok(r.skippedDecided >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n, beforeCount, 'a rejected proposal is never re-staged — no new row');
  assert.equal(db.prepare("SELECT status FROM proposed_entities WHERE alias = ? AND alias_type = 'name'").get(normalizeName(name)).status, 'rejected');
});

test('stagePicturedProposals (#350): --dry-run reports counts but writes nothing; a real run afterwards actually stages it', () => {
  const name = 'Zenobia Prescott-Halloway';
  photoNameHint(name, 'dry-run-1');
  const beforeProposals = db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n;
  const beforeEntities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const beforeLog = db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'pictured_proposals_backfill'").get().n;

  const dry = stagePicturedProposals({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n, beforeProposals, 'dry run writes zero proposed_entities rows');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, beforeEntities);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'pictured_proposals_backfill'").get().n, beforeLog, 'a dry run leaves no ingest_log trace');
  assert.equal(pendingFor(normalizeName(name)).length, 0, 'nothing staged for our test name during the dry run');

  const real = stagePicturedProposals();
  assert.equal(real.dryRun, false);
  assert.equal(pendingFor(normalizeName(name)).length, 1, 'a real run afterwards actually stages it');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'pictured_proposals_backfill'").get().n, beforeLog + 1, 'exactly one log row for the real run');
});

test('stagePicturedProposals (#350): creates zero entities/aliases/links by itself (only staging)', () => {
  const name = 'Barnabus Featherstonhaugh';
  photoNameHint(name, 'zero-entities-1');
  const beforeEntities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const beforeAliases = db.prepare('SELECT COUNT(*) AS n FROM entity_aliases').get().n;
  const beforeLinks = db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n;
  stagePicturedProposals();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, beforeEntities, 'zero entities created by staging');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_aliases').get().n, beforeAliases, 'zero aliases created by staging');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n, beforeLinks, 'zero links formed by staging alone — approval is the separate step that links');
});

test('stagePicturedProposals (#350): approving a staged proposal retro-links every photo that named them (end-to-end payoff)', () => {
  const name = 'Cornelius Ashgrove-Whitmore';
  const a1 = photoNameHint(name, 'payoff-1');
  const a2 = photoNameHint(name, 'payoff-2');
  const a3 = photoNameHint(name, 'payoff-3');
  const before = db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n;

  stagePicturedProposals();
  const staged = pendingFor(normalizeName(name));
  assert.equal(staged.length, 1);
  const { entity_id } = approveProposedEntity(staged[0].id);

  const after = db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n;
  assert.equal(after - before, 3, 'all three photos link to the newly-minted entity — the whole point of staging over ignoring');
  for (const artifactId of [a1, a2, a3]) {
    assert.ok(db.prepare('SELECT 1 FROM entity_links WHERE artifact_id = ? AND entity_id = ?').get(artifactId, entity_id), 'each pictured photo is now linked');
  }
});

test('stagePicturedProposals (#350): --limit stages only the top-N by impact', () => {
  const big = 'Persimmon Oakhurst-Delacorte', small = 'Wilhelmina Cross-Thistlewood';
  for (let i = 0; i < 20; i++) photoNameHint(big, `limit-big-${i}`);
  for (let i = 0; i < 10; i++) photoNameHint(small, `limit-small-${i}`);

  // 20/10 artifacts dwarfs anything else staged earlier in this file (single digits), so with
  // limit:1 the ONE name attempted anywhere in the backlog must be "big".
  const before = db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n;
  const r = stagePicturedProposals({ limit: 1 });
  assert.equal(r.staged, 1);
  assert.equal(pendingFor(normalizeName(big)).length, 1, 'the highest-impact name in the batch was staged');
  assert.equal(pendingFor(normalizeName(small)).length, 0, 'the lower-impact name was not reached by limit:1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n, before + 1);

  // limit:0 stages nothing at all, regardless of backlog size — the bounding mechanism itself.
  const zero = stagePicturedProposals({ limit: 0 });
  assert.equal(zero.staged, 0);
});

// --- Pre-PR-review fixes (Copilot on #354): dedup must key on (alias, alias_type) alone ---
// resolveEntityHints' #301 directory-consult branch stages a proposal with `name: dirName` (the
// directory's properly-CASED display name) against the SAME normalized `alias` this backfill uses.
// UNIQUE(suggested_name, alias, alias_type) does not consider those the same row, so a naive
// "does proposeEntity's own INSERT OR IGNORE catch it" check misses the collision and stages a
// second, duplicate pending proposal for the same person under a differently-cased suggested_name.
test('stagePicturedProposals (#350, review fix): a differently-cased suggested_name for the same (alias, alias_type) is not duplicated (mirrors the #301 directory-path shape)', () => {
  // Settle any backlog a PRIOR test left un-decided (e.g. the --limit:1 test above deliberately
  // leaves its lower-impact "small" name unstaged) — otherwise an unbounded stagePicturedProposals()
  // call below would also sweep that up, polluting this test's own before/after row-count delta.
  stagePicturedProposals();
  const name = 'Winnifred Castellane';
  const alias = normalizeName(name);
  // Simulate the #301 directory path staging FIRST, under the properly-cased display name — a
  // different `proposed_entities.suggested_name` than the lowercased `alias` this backfill would use.
  const preExisting = proposeEntity({ suggested_kind: 'person', name, alias, alias_type: 'name', source: 'directory' });
  assert.ok(preExisting.created, 'precondition: a differently-cased proposal already exists for this alias');
  assert.equal(pendingFor(alias).length, 1);

  photoNameHint(name, 'case-dup-1'); // the SAME normalized alias, staged as a stranded pictured hint

  const before = db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n;
  const r = stagePicturedProposals();
  assert.ok(r.skippedDecided >= 1, 'counted as already-decided, not staged again');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n, before, 'no new row — a case-differing suggested_name must not create a duplicate');
  assert.equal(pendingFor(alias).length, 1, 'still exactly the one original pending proposal, not two');
});

test('stagePicturedProposals (#350, review fix): an existing (any-casing) proposal is filtered BEFORE --limit, so --limit stages that many genuinely NEW names', () => {
  const already = 'Quillon Marchetti-Reyes', freshA = 'Ottoline Vasquez-Fairweather', freshB = 'Zebedee Thackeray-Nunes';
  // Highest impact so it would occupy the top slot of an impact-ordered --limit window if it were
  // not filtered out first.
  for (let i = 0; i < 30; i++) photoNameHint(already, `skiplimit-already-${i}`);
  for (let i = 0; i < 25; i++) photoNameHint(freshA, `skiplimit-fresha-${i}`);
  for (let i = 0; i < 20; i++) photoNameHint(freshB, `skiplimit-freshb-${i}`);

  const alreadyAlias = normalizeName(already);
  proposeEntity({ suggested_kind: 'person', name: already, alias: alreadyAlias, alias_type: 'name', source: 'directory' });
  assert.equal(pendingFor(alreadyAlias).length, 1, 'precondition: one differently-cased-source proposal exists for the top-impact name');

  const before = db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n;
  const r = stagePicturedProposals({ limit: 2 });

  assert.equal(r.staged, 2, '--limit 2 stages 2 NEW names — "already" was filtered pre-limit, not counted against the quota');
  assert.equal(pendingFor(alreadyAlias).length, 1, 'still exactly the ORIGINAL proposal — no duplicate under the lowercased alias');
  assert.equal(pendingFor(normalizeName(freshA)).length, 1, 'the highest-impact genuinely-new name was staged');
  assert.equal(pendingFor(normalizeName(freshB)).length, 1, 'the quota reached a SECOND new name instead of stopping after the duplicate — proves the skip runs before the slice');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proposed_entities').get().n, before + 2, 'exactly 2 new rows total, not 3');
});

// --- CLI arg parsing (scripts/backfill-pictured-proposals.js) ---
test('backfill-pictured-proposals CLI (#350, review fix): --limit with no value fails fast instead of silently meaning "no limit"', () => {
  assert.throws(() => parsePicturedProposalsArgs(['--limit']), /--limit must be a non-negative integer/, 'a dropped/typo\'d value must error, not silently stage everything');
  assert.throws(() => parsePicturedProposalsArgs(['--dry-run', '--limit']), /--limit must be a non-negative integer/, 'same when --limit is the last token after another flag');
});

test('backfill-pictured-proposals CLI (#350, review fix): --limit 0 parses consistently with stagePicturedProposals({limit:0}) meaning "stage nothing"', () => {
  assert.deepEqual(parsePicturedProposalsArgs(['--limit', '0']), { dryRun: false, limit: 0 });
  assert.deepEqual(parsePicturedProposalsArgs(['--limit', '5']), { dryRun: false, limit: 5 });
  assert.deepEqual(parsePicturedProposalsArgs([]), { dryRun: false, limit: null }, 'no --limit at all still means unbounded');
  assert.throws(() => parsePicturedProposalsArgs(['--limit', '-1']), /non-negative integer/);
  assert.throws(() => parsePicturedProposalsArgs(['--limit', 'abc']), /non-negative integer/);
});

test('backfill-pictured-proposals CLI (#350, review fix): the script process itself exits non-zero on a missing --limit value', () => {
  const scriptUrl = new URL('../scripts/backfill-pictured-proposals.js', import.meta.url);
  const tmp = path.join(os.tmpdir(), `lc-cli-limit-${process.pid}.db`);
  rmSync(tmp, { force: true }); rmSync(`${tmp}-wal`, { force: true }); rmSync(`${tmp}-shm`, { force: true });
  assert.throws(
    () => execFileSync(process.execPath, [scriptUrl.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--limit'], { env: { ...process.env, DB_PATH: tmp }, stdio: 'pipe' }),
    /Command failed/,
    'a real process invocation with a valueless --limit exits non-zero',
  );
  rmSync(tmp, { force: true }); rmSync(`${tmp}-wal`, { force: true }); rmSync(`${tmp}-shm`, { force: true });
});

test('loadDirectory (#154): vCard load populates the directory and creates NO entities', () => {
  const beforePersons = db.prepare("SELECT COUNT(*) n FROM entities WHERE kind='person'").get().n;
  const beforeAliases = db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n;
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Directory Only Contact',
    'TEL;TYPE=CELL:+1 (555) 424-2000', 'EMAIL:dir.only@example.com', 'END:VCARD',
  ].join('\n');
  const s = loadDirectory(vcf);
  assert.equal(s.contacts, 1);
  assert.equal(s.loaded, 2, 'one phone + one email loaded');
  assert.ok(s.total >= 2, 'summary reports the directory total (distinct handles)');
  // #158: the directory name follows the first+last display rule (#156) — "Directory Only Contact"
  // (3 tokens) is stored as "Directory Contact", consistent with a curated contact's display.
  assert.equal(lookupDirectoryName('5554242000', 'phone'), 'Directory Contact');
  assert.equal(lookupDirectoryName('dir.only@example.com', 'email'), 'Directory Contact');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entities WHERE kind='person'").get().n, beforePersons, 'no entity created');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n, beforeAliases, 'no alias created');

  // A 4-token name is stored full (same cutoff as the display rule).
  loadDirectory(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Maria de la Cruz', 'TEL:+15557778888', 'END:VCARD'].join('\n'));
  assert.equal(lookupDirectoryName('5557778888', 'phone'), 'Maria de la Cruz');

  // A nameless-but-addressable card (no FN, has email) is still covered — labeled by its email
  // (Copilot, PR #160), not silently dropped.
  loadDirectory(['BEGIN:VCARD', 'VERSION:3.0', 'EMAIL:noname@example.com', 'TEL:+15550001111', 'END:VCARD'].join('\n'));
  assert.equal(lookupDirectoryName('noname@example.com', 'email'), 'noname@example.com');
  assert.equal(lookupDirectoryName('5550001111', 'phone'), 'noname@example.com');
});

// --- Directory cards (#304): the per-card profile behind the handle lookup ---
// Nothing a re-load says may destroy what an earlier one said (design-philosophy §1), so these
// pin the append-if-exists merge: arrays union, empty scalars fill, differing scalars are KEPT and
// reported. The card is directory cache state — no entity, no alias, no embedding.
const cardLogCount = (cardKey) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'directory_card_merged' AND json_extract(details, '$.card_key') = ?`).get(cardKey).n;
const cardRow = (cardKey) => db.prepare('SELECT * FROM directory_cards WHERE card_key = ?').get(cardKey);

test('upsertDirectoryCard (#304): fresh insert, then an unchanged re-load is a total no-op', () => {
  const key = 'card-uid-nolan';
  const first = upsertDirectoryCard({ card_key: key, name: 'Nolan Reyes', attrs: { emails: ['n@example.com'], addresses: ['1 Oak St'], birthday: '1980-04-02', anniversary: null, note: '' } });
  assert.equal(first.created, true);
  assert.equal(first.merged, false);
  assert.equal(cardRow(key).updated_at, null, 'a fresh insert leaves updated_at unset');

  const second = upsertDirectoryCard({ card_key: key, name: 'Nolan Reyes', attrs: { emails: ['n@example.com'], addresses: ['1 Oak St'], birthday: '1980-04-02', anniversary: null, note: '' } });
  assert.equal(second.id, first.id, 'same card_key → same row (idempotency key)');
  assert.equal(second.created, false);
  assert.equal(second.merged, false, 'nothing changed');
  assert.equal(cardRow(key).updated_at, null, 'no updated_at write on an unchanged re-load');
  assert.equal(cardLogCount(key), 0, 'and no log row — a no-op re-load is not an event');
});

test('upsertDirectoryCard (#304): a richer re-load unions arrays and fills empty scalars, logging what changed', () => {
  const key = 'card-uid-imelda';
  upsertDirectoryCard({ card_key: key, name: 'Imelda Fox', attrs: { addresses: ['1 Oak St'], urls: [], birthday: null, dates: [{ type: 'Anniversary', value: '2011-06-04' }] } });
  const res = upsertDirectoryCard({
    card_key: key, name: 'Imelda Fox',
    attrs: { addresses: ['1 Oak St', '9 Pine Ave'], urls: ['https://example.com'], birthday: '1979-01-15', dates: [{ type: 'Anniversary', value: '2011-06-04' }] },
  });
  assert.equal(res.merged, true);
  const attrs = JSON.parse(cardRow(key).attrs_json);
  assert.deepEqual(attrs.addresses, ['1 Oak St', '9 Pine Ave'], 'new address unioned, the old one kept');
  assert.deepEqual(attrs.urls, ['https://example.com']);
  assert.equal(attrs.birthday, '1979-01-15', 'an empty scalar is filled');
  assert.deepEqual(attrs.dates, [{ type: 'Anniversary', value: '2011-06-04' }], 'an identical object entry is not duplicated');
  assert.ok(cardRow(key).updated_at, 'updated_at is set when something changed');
  const logged = db.prepare(`SELECT details FROM ingest_log WHERE event_type = 'directory_card_merged' AND json_extract(details, '$.card_key') = ? ORDER BY id DESC LIMIT 1`).get(key);
  const details = JSON.parse(logged.details);
  assert.deepEqual(details.changed.sort(), ['addresses', 'birthday', 'urls'], 'the log names every changed key');
  assert.deepEqual(details.conflicts, []);
});

test('upsertDirectoryCard (#304): a differing scalar keeps the stored value and reports a conflict', () => {
  const key = 'card-uid-omar';
  upsertDirectoryCard({ card_key: key, name: 'Omar Haddad', attrs: { birthday: '1975-03-03', note: 'first note' } });
  const res = upsertDirectoryCard({ card_key: key, name: 'Omar H Haddad', attrs: { birthday: '1999-12-31', note: 'different note' } });
  assert.equal(res.merged, false, 'a conflict-only re-load merges nothing');
  const row = cardRow(key);
  assert.equal(JSON.parse(row.attrs_json).birthday, '1975-03-03', 'the stored birthday is never overwritten');
  assert.equal(JSON.parse(row.attrs_json).note, 'first note');
  assert.equal(row.name, 'Omar Haddad', 'the stored card name wins too (first writer)');
  assert.equal(row.updated_at, null, 'a rejected difference writes no data, so no updated_at');
  const details = JSON.parse(db.prepare(`SELECT details FROM ingest_log WHERE event_type = 'directory_card_merged' AND json_extract(details, '$.card_key') = ? ORDER BY id DESC LIMIT 1`).get(key).details);
  assert.deepEqual(details.conflicts.sort(), ['birthday', 'name', 'note'], 'every rejected difference is recorded');
  assert.deepEqual(details.changed, []);
});

test('getDirectoryCard (#304): handle match wins, exact name is the fallback, ambiguity refuses to guess', () => {
  const card = upsertDirectoryCard({ card_key: 'card-uid-tessa', name: 'Tessa Vaughn', attrs: { birthday: '1990-09-09' } });
  insertDirectoryEntry('Tessa Vaughn', '+1 (555) 606-7000', 'phone', card.id);
  // #129 normalization applies on both sides — a +1 handle finds a card loaded 10-digit and back.
  assert.equal(getDirectoryCard({ handle: '5556067000', handleType: 'phone' }).card_key, 'card-uid-tessa');
  assert.equal(getDirectoryCard({ handle: '+15556067000', handleType: 'phone' }).attrs.birthday, '1990-09-09', 'attrs come back parsed');
  assert.equal(getDirectoryCard({ name: 'tessa vaughn' }).card_key, 'card-uid-tessa', 'the name fallback is case-insensitive');
  assert.equal(getDirectoryCard({ handle: '5559999999', handleType: 'phone' }), null, 'unknown handle and no name → null');
  assert.equal(getDirectoryCard({}), null, 'no criteria → null');

  // Two people can share a display name, and name is deliberately non-unique here.
  upsertDirectoryCard({ card_key: 'card-uid-tessa-2', name: 'Tessa Vaughn', attrs: { birthday: '1961-01-01' } });
  assert.equal(getDirectoryCard({ name: 'Tessa Vaughn' }), null, 'ambiguous name resolves to nothing, never a guess');
  assert.equal(getDirectoryCard({ handle: '5556067000', handleType: 'phone' }).card_key, 'card-uid-tessa', 'the handle key is still unambiguous');
  // Precedence: the deterministic handle wins outright — it is consulted first, so an ambiguous
  // (or simply different) name passed alongside it never degrades the answer.
  assert.equal(getDirectoryCard({ handle: '5556067000', handleType: 'phone', name: 'Tessa Vaughn' }).card_key, 'card-uid-tessa', 'handle match wins over the name');
});

test('loadDirectory (#304): a re-load adopts pre-#304 handle rows into their card, but never re-points one', () => {
  // The upgrade path: these rows exist from a load that predates directory_cards, so card_id is
  // NULL and INSERT OR IGNORE would leave them that way forever — handle-keyed lookups would keep
  // missing even after the documented re-load (Copilot, PR #308).
  insertDirectoryEntry('Adopted Person', '+15554445555', 'phone');
  insertDirectoryEntry('Adopted Person', 'adopted@example.com', 'email');
  assert.equal(getDirectoryCard({ handle: '5554445555', handleType: 'phone' }), null, 'precondition: no card linked yet');

  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:adopt-1', 'FN:Adopted Person',
    'TEL:+1 (555) 444-5555', 'EMAIL:adopted@example.com', 'BDAY:1977-07-07', 'END:VCARD'].join('\n');
  const s = loadDirectory(vcf);
  assert.equal(s.loaded, 0, 'both handles already existed — nothing inserted');
  assert.equal(s.cards, 1, 'the card itself is new');
  assert.equal(s.adopted, 2, 'both legacy rows were linked to it');
  assert.equal(getDirectoryCard({ handle: '5554445555', handleType: 'phone' })?.attrs.birthday, '1977-07-07', 'the handle now resolves to its card');
  assert.equal(getDirectoryCard({ handle: 'adopted@example.com', handleType: 'email' })?.card_key, 'adopt-1');
  assert.equal(loadDirectory(vcf).adopted, 0, 'a second re-load adopts nothing (idempotent)');

  // A handle already pointing at a card keeps it, and a name collision is never adopted — that row
  // belongs to a different person's card.
  const other = upsertDirectoryCard({ card_key: 'adopt-other', name: 'Someone Else', attrs: {} });
  assert.equal(insertDirectoryEntry('Someone Else', '+15554445555', 'phone', other.id).adopted, false, 'a name collision is not adopted');
  assert.equal(getDirectoryCard({ handle: '5554445555', handleType: 'phone' }).card_key, 'adopt-1', 'the original card still owns the handle');
});

// --- Directory browse + promote (#299) ---
// The cases the HTTP tests can't reach: impact excluding already-curated aliases, entity reuse, a
// handle owned by someone else, proposal healing, and the #111 tombstone guard.
const dirCandidate = (name) => listDirectoryCandidates({ query: name, limit: 200 }).candidates.find((c) => c.name === name);
const stageHint = (alias, aliasType, sourceId) => {
  const { id } = storeArtifactTxn({ type: 'photo', source: uniqueSource(), source_id: sourceId, text_repr: `about ${alias}` }, f32(0.61));
  resolveEntityHints(id, [{ alias, alias_type: aliasType, role: aliasType === 'name' ? 'pictured' : 'sender' }]);
  return id;
};

test('listDirectoryCandidates (#299): impact counts distinct artifacts across both arms and excludes curated aliases', () => {
  insertDirectoryEntry('Marlowe Vance', '+1 (617) 555-3100', 'phone');
  insertDirectoryEntry('Marlowe Vance', 'marlowe@example.com', 'email');
  // One artifact carries BOTH a name hint and her phone hint — it must count ONCE in `artifacts`
  // while both arms still report their own hint totals.
  const shared = storeArtifactTxn({ type: 'photo', source: uniqueSource(), source_id: 'shared-1', text_repr: 'marlowe at the lake' }, f32(0.62)).id;
  resolveEntityHints(shared, [{ alias: 'marlowe vance', alias_type: 'name', role: 'pictured' }, { alias: '6175553100', alias_type: 'phone', role: 'sender' }]);
  stageHint('marlowe vance', 'name', 'marlowe-2');

  const c = dirCandidate('Marlowe Vance');
  assert.equal(c.handles.length, 2, 'grouped: one row, both handles');
  assert.equal(c.impact.artifacts, 2, 'the doubly-hinted artifact counts once');
  assert.equal(c.impact.name_hints, 2);
  assert.equal(c.impact.handle_hints, 1);

  // A curated alias is no longer "would link" — give an unrelated entity her email and watch that
  // arm drop out of the impact while the name arm stays.
  const other = Number(insertEntityStmt.run('person', 'Someone With Her Email', null).lastInsertRowid);
  insertAliasStmt.run(other, 'marlowe@example.com', 'email');
  stageHint('marlowe@example.com', 'email', 'marlowe-3');
  assert.equal(dirCandidate('Marlowe Vance').impact.artifacts, 2, 'a hint whose alias already resolves is excluded');
});

test('listDirectoryCandidates (#299): curated means the NAME resolves — a handle owned by someone else does not grey the row', () => {
  // The list must apply the same identity rule as promoteDirectoryName, or it lies about what
  // promoting will do: a shared family landline would mark its second owner curated, point the row's
  // name link at the WRONG contact, and block the promotion that gives that person their own.
  const lineOwner = Number(insertEntityStmt.run('person', 'Landline Holder', null).lastInsertRowid);
  insertAliasStmt.run(lineOwner, 'landline holder', 'name');
  insertAliasStmt.run(lineOwner, '7185551000', 'phone');
  insertDirectoryEntry('Otto Zimmerman', '+1 (718) 555-1000', 'phone');
  assert.equal(dirCandidate('Otto Zimmerman').entity_id, null, 'not curated — his name resolves to nobody');
  const promoted = promoteDirectoryName('Otto Zimmerman');
  assert.notEqual(promoted.entity_id, lineOwner, 'and he gets his own contact');
  assert.equal(dirCandidate('Otto Zimmerman').entity_id, promoted.entity_id, 'now curated by name');
});

test('listDirectoryCandidates (#299): a curated name with un-aliased handles still reports impact, and promoting links it', () => {
  // An existing contact is not necessarily finished — one live example holds 1,155 linkable
  // artifacts because its directory handles were never aliased to it (Copilot, PR #314).
  // Staged BEFORE the directory can name the handle: #409's ingest-time attach (resolveEntityHints
  // consulting the directory) only reaches a hint the directory can ALREADY resolve at hint time,
  // so this stays a pure unresolved_aliases row — exactly the gap listDirectoryCandidates' impact
  // and promoteDirectoryName's healing exist for.
  const id = Number(insertEntityStmt.run('person', 'Wilhelmina Prat', null).lastInsertRowid);
  insertAliasStmt.run(id, 'wilhelmina prat', 'name');
  const artifactId = stageHint('8025553300', 'phone', 'willa-1');
  insertDirectoryEntry('Wilhelmina Prat', '+1 (802) 555-3300', 'phone');

  const row = dirCandidate('Wilhelmina Prat');
  assert.equal(row.entity_id, id, 'curated by name');
  assert.equal(row.impact.artifacts, 1, 'but there is still history to link — the UI must not treat this as done');

  const res = promoteDirectoryName('Wilhelmina Prat');
  assert.equal(res.created, false, 'reuses the existing contact');
  assert.equal(res.aliases, 1, 'adds the handle it was missing');
  assert.equal(res.linked, 1, 'and links the staged history');
  assert.ok(db.prepare('SELECT 1 FROM entity_links WHERE artifact_id = ? AND entity_id = ?').get(artifactId, id));
  assert.equal(dirCandidate('Wilhelmina Prat').impact.artifacts, 0, 'now genuinely done');
});

test('promoteDirectoryName (#299): mints, seeds aliases, links staged history, and heals a rejected proposal', () => {
  insertDirectoryEntry('Odessa Kirkwood', '+1 (503) 555-4200', 'phone');
  const artifactId = stageHint('odessa kirkwood', 'name', 'odessa-1');
  // A rejected proposal for her number now contradicts the graph once she exists.
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Odessa Kirkwood', alias: '5035554200', alias_type: 'phone', source: 'test' });
  rejectProposedEntity(prop.id);

  const res = promoteDirectoryName('Odessa Kirkwood');
  assert.equal(res.created, true);
  assert.equal(res.linked, 1, 'the staged name hint linked in the same transaction');
  assert.ok(res.aliases >= 2, 'name variant(s) + the phone handle');
  // #413: stageHint's bare name hint (no suggested_kind) hits resolveEntityHints' directory-consult
  // branch — the directory now names 'odessa kirkwood', so it ALSO stages its own name-keyed
  // proposal. Before #413 only the phone-keyed heal loop ran, so that second, name-keyed proposal
  // stayed silently pending forever; promoteDirectoryName's healing now covers it too.
  assert.equal(res.proposals_resolved, 2, 'the rejected phone-keyed proposal AND the directory-consult name-keyed proposal both now point at the minted entity');
  assert.equal(db.prepare('SELECT status, resolved_entity_id FROM proposed_entities WHERE id = ?').get(prop.id).status, 'approved');
  assert.equal(db.prepare('SELECT resolved_entity_id FROM proposed_entities WHERE id = ?').get(prop.id).resolved_entity_id, res.entity_id);
  const nameKeyed = db.prepare("SELECT status, resolved_entity_id FROM proposed_entities WHERE alias = 'odessa kirkwood' AND alias_type = 'name'").get();
  assert.equal(nameKeyed.status, 'approved', 'the previously-silent name-keyed proposal is healed too');
  assert.equal(nameKeyed.resolved_entity_id, res.entity_id);
  assert.ok(resolveEntityIds('Odessa Kirkwood').includes(res.entity_id), 'resolvable by name');
  assert.ok(resolveEntityIds('+1 503 555 4200').includes(res.entity_id), 'and by her phone in any format (#129)');
  assert.ok(db.prepare('SELECT 1 FROM entity_links WHERE artifact_id = ? AND entity_id = ?').get(artifactId, res.entity_id), 'the photo is linked');
  assert.equal(dirCandidate('Odessa Kirkwood').entity_id, res.entity_id);

  // #413 AC: a second promote is idempotent — the healed rows are already 'approved', which
  // selectOpenProposalsByAliasStmt excludes, so nothing left to heal.
  const again = promoteDirectoryName('Odessa Kirkwood');
  assert.equal(again.proposals_resolved, 0, 'idempotent — the second promote heals nothing new');
});

test('promoteDirectoryName (#413, regression): a REDUCED name variant tombstoned on this entity must not heal that variant\'s proposal, even on a re-promote that still reuses the entity via its full name', () => {
  // liveOwner(v,'name') !== entityId is the guard: a variant this entity does not actually own —
  // because #111 refused to resurrect a deliberately-removed name — must not steal that variant's
  // open proposal, even though the re-promote still correctly reuses this same entity via its
  // (untouched) full name.
  insertDirectoryEntry('Priya Anne Sundaram', '+1 (312) 555-8800', 'phone');
  const first = promoteDirectoryName('Priya Anne Sundaram');
  assert.ok(resolveEntityIds('Priya Sundaram').includes(first.entity_id), 'seeded the given+family reduction too');
  removeAlias(first.entity_id, 'priya sundaram', 'name'); // tombstone ONLY the reduced form
  const staleProp = proposeEntity({ suggested_kind: 'person', name: 'Priya Sundaram', alias: 'priya-unrelated@example.test', alias_type: 'email', source: 'test' });

  const again = promoteDirectoryName('Priya Anne Sundaram');
  assert.equal(again.entity_id, first.entity_id, 'reused via the still-intact FULL name — same entity');
  assert.ok(!resolveEntityIds('Priya Sundaram').includes(first.entity_id), 'the tombstoned reduced form is not resurrected');
  const untouched = db.prepare('SELECT status FROM proposed_entities WHERE id = ?').get(staleProp.id);
  assert.equal(untouched.status, 'pending', 'a proposal keyed on the tombstoned reduced form is not healed — this entity does not own that alias');
});

test('promoteDirectoryName (#299): reuses a live entity, reports a handle owned by someone else, respects a tombstone', () => {
  // Reuse: the name already resolves, so promotion must not mint a second Ines.
  const existing = Number(insertEntityStmt.run('person', 'Ines Halvorsen', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'ines halvorsen', 'name');
  insertDirectoryEntry('Ines Halvorsen', '+1 (206) 555-8100', 'phone');
  const reuse = promoteDirectoryName('Ines Halvorsen');
  assert.equal(reuse.created, false, 'reused, not minted');
  assert.equal(reuse.entity_id, existing);
  assert.ok(resolveEntityIds('2065558100').includes(existing), 'and her directory handle was added to the entity she already had');

  // Handle-based reuse IS accepted when that entity answers to this name too — the "contact imported
  // since the directory was loaded" case, which is what reuse exists for.
  const sinceImported = Number(insertEntityStmt.run('person', 'Nadia Solberg', null).lastInsertRowid);
  insertAliasStmt.run(sinceImported, 'nadia solberg', 'name');
  insertAliasStmt.run(sinceImported, '5035551100', 'phone');
  insertDirectoryEntry('Nadia Solberg', '+1 (503) 555-1100', 'phone');
  assert.equal(promoteDirectoryName('Nadia Solberg').entity_id, sinceImported, 'reused via the name+handle match');

  // A shared line: the handle belongs to a DIFFERENT person, so Bram must get his own (possibly
  // duplicate, and therefore detectable) contact — never be silently absorbed into its owner.
  const owner = Number(insertEntityStmt.run('person', 'Shared Line Owner', null).lastInsertRowid);
  insertAliasStmt.run(owner, '2065559200', 'phone');
  insertDirectoryEntry('Bram Osei', '+1 (206) 555-9200', 'phone');
  insertDirectoryEntry('Bram Osei', 'bram@example.com', 'email');
  const shared = promoteDirectoryName('Bram Osei');
  assert.equal(shared.created, true, 'minted his own contact — a handle alone never decides identity');
  assert.notEqual(shared.entity_id, owner, 'and was NOT absorbed into the line owner');
  assert.deepEqual(shared.skipped_handles, [{ handle: '2065559200', handle_type: 'phone', entity_id: owner }]);
  assert.ok(resolveEntityIds('bram@example.com').includes(shared.entity_id), 'the non-conflicting handle was still seeded');

  // #111: an alias the user deliberately removed is not resurrected by promoting.
  insertDirectoryEntry('Tomas Ferreira', '+1 (312) 555-6400', 'phone');
  const first = promoteDirectoryName('Tomas Ferreira');
  removeAlias(first.entity_id, '3125556400', 'phone');
  assert.ok(!resolveEntityIds('3125556400').includes(first.entity_id), 'removed');
  const again = promoteDirectoryName('Tomas Ferreira');
  assert.equal(again.entity_id, first.entity_id);
  assert.ok(!resolveEntityIds('3125556400').includes(first.entity_id), 'a tombstoned handle is NOT resurrected by a re-promote');
});

test('promoteDirectoryName (#299): mints with the #304 card profile when the directory has one', () => {
  const card = upsertDirectoryCard({ card_key: 'promote-card-1', name: 'Cecile Aubert', attrs: { emails: ['Cecile.Aubert@example.com'], phones: ['+1 (415) 555-2200'], birthday: '1984-04-04', addresses: ['3 Rue Lepic'], anniversary: null } });
  insertDirectoryEntry('Cecile Aubert', '+1 (415) 555-2200', 'phone', card.id);
  const res = promoteDirectoryName('Cecile Aubert');
  const attrs = JSON.parse(db.prepare('SELECT attrs_json FROM entities WHERE id = ?').get(res.entity_id).attrs_json);
  assert.equal(attrs.birthday, '1984-04-04', 'the promoted contact arrives with a real profile, not just handles');
  assert.deepEqual(attrs.addresses, ['3 Rue Lepic']);
  assert.deepEqual(attrs.phones, ['+1 (415) 555-2200'], 'the card keeps the phone as the user wrote it (display form)');
  assert.ok(resolveEntityIds('4155552200').includes(res.entity_id), 'while the ALIAS is the normalized key');
});

test('promoteDirectoryName (#299): an unknown name throws NOT_FOUND', () => {
  assert.throws(() => promoteDirectoryName('Not In The Directory'), (err) => err.code === 'NOT_FOUND');
  assert.throws(() => promoteDirectoryName(''), (err) => err.code === 'NOT_FOUND');
});

test('loadDirectory (#304): a card with no UID is keyed by content hash and still loads', () => {
  const s = loadDirectory(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Nouid Person', 'TEL:+15557001234', 'BDAY:1966-06-06', 'END:VCARD'].join('\n'));
  assert.equal(s.cards, 1);
  const card = getDirectoryCard({ handle: '5557001234', handleType: 'phone' });
  assert.match(card.card_key, /^[0-9a-f]{64}$/, 'card_key falls back to a bare sha256 hex digest');
  assert.equal(card.attrs.birthday, '1966-06-06');
});

test('fillEntityAttrsFromCard (#304): fills only empty fields, never overwrites, idempotent', () => {
  const id = Number(insertEntityStmt.run('person', 'Priya Raman', JSON.stringify({ emails: ['priya@example.com'], addresses: [], birthday: null, note: 'hand-typed note' })).lastInsertRowid);
  const aliasesBefore = db.prepare('SELECT COUNT(*) AS n FROM entity_aliases WHERE entity_id = ?').get(id).n;
  const cardAttrs = { emails: ['other@example.com'], addresses: ['4 Elm Rd'], birthday: '1988-07-07', note: 'directory note', isCompany: false };

  const res = fillEntityAttrsFromCard(id, cardAttrs);
  assert.deepEqual(res.filled.sort(), ['addresses', 'birthday'], 'only the empty keys are filled — and isCompany:false, the shape default, is not "information"');
  const attrs = JSON.parse(db.prepare('SELECT attrs_json FROM entities WHERE id = ?').get(id).attrs_json);
  assert.deepEqual(attrs.emails, ['priya@example.com'], 'a non-empty list is left alone, not unioned');
  assert.equal(attrs.note, 'hand-typed note', 'a user-typed scalar always wins');
  assert.deepEqual(attrs.addresses, ['4 Elm Rd']);
  assert.equal(attrs.birthday, '1988-07-07');
  assert.equal(db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(id).canonical_name, 'Priya Raman', 'canonical_name untouched');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_aliases WHERE entity_id = ?').get(id).n, aliasesBefore, 'no alias written');
  assert.equal(JSON.parse(db.prepare(`SELECT details FROM ingest_log WHERE event_type = 'entity_edited' AND json_extract(details, '$.entity_id') = ? ORDER BY id DESC LIMIT 1`).get(id).details).filled.length, 2, 'the fill is reconstructable from ingest_log');

  assert.deepEqual(fillEntityAttrsFromCard(id, cardAttrs).filled, [], 'a second call fills 0 (idempotent)');
  assert.deepEqual(fillEntityAttrsFromCard(999999, cardAttrs).filled, [], 'an unknown entity is a no-op, not a throw');
});

test('loadDirectory + backfillDirectoryAttrs (#304): a load writes cards, links them, and enriches a thin contact', () => {
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'UID:card-load-luisa', 'FN:Luisa Marchetti',
    'TEL:+1 (555) 808-1200', 'EMAIL:luisa@example.com',
    'ADR;TYPE=HOME:;;22 Cypress Way;Austin;TX;78701;USA', 'BDAY:1983-11-20',
    'ANNIVERSARY:2009-05-16', 'URL:https://luisa.example.com', 'END:VCARD',
  ].join('\n');
  const s = loadDirectory(vcf);
  assert.equal(s.cards, 1, 'one card written');
  assert.equal(s.cardsMerged, 0);
  const card = getDirectoryCard({ handle: '5558081200', handleType: 'phone' });
  assert.ok(card, 'the handle row links to its card via card_id');
  assert.equal(card.attrs.birthday, '1983-11-20');
  assert.equal(card.attrs.anniversary, '2009-05-16', 'anniversary is derived from the vCard (#304)');
  assert.ok(card.attrs.addresses[0].includes('Cypress Way'));
  assert.deepEqual(card.attrs.urls, ['https://luisa.example.com']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities WHERE canonical_name = ?').get('Luisa Marchetti').n, 0, 'a load still creates NO entity');

  const second = loadDirectory(vcf);
  assert.equal(second.cards, 0, 'a re-load creates no new card');
  assert.equal(second.cardsMerged, 0, 'and merges nothing (idempotent)');

  // A thin curated contact holding only the handle the card names gets enriched by the backfill.
  const thinId = Number(insertEntityStmt.run('person', 'Luisa Marchetti', JSON.stringify({ emails: [], phones: ['+1 (555) 808-1200'] })).lastInsertRowid);
  insertAliasStmt.run(thinId, '5558081200', 'phone');
  const run = backfillDirectoryAttrs();
  assert.ok(run.matched >= 1, 'the thin contact matched its card by handle');
  assert.ok(run.filled >= 1);
  const filledAttrs = JSON.parse(db.prepare('SELECT attrs_json FROM entities WHERE id = ?').get(thinId).attrs_json);
  assert.equal(filledAttrs.birthday, '1983-11-20', 'the empty profile was filled from the card');
  assert.equal(filledAttrs.anniversary, '2009-05-16');
  assert.deepEqual(filledAttrs.phones, ['+1 (555) 808-1200'], 'the already-set list is preserved verbatim');
  assert.equal(backfillDirectoryAttrs().filled, 0, 'a second backfill run fills 0');
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'no FK violations after a load + backfill');
});

test('annotateHandles email regex (#150): matches subdomain/multi-part-TLD emails; adversarial trailing-dot input is no false match', () => {
  // The tightened label-based domain still recognizes a real subdomain + multi-part TLD email.
  const eid = Number(insertEntityStmt.run('person', 'Sub Domain', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'a.b@mail.sub.example.co.uk', 'email');
  const { id } = storeArtifactTxn(
    { type: 'email', source: uniqueSource(), source_id: 'rx-1', text_repr: 'reach a.b@mail.sub.example.co.uk please' },
    f32(0.4), [{ entity_id: eid, role: 'sender', confidence: 1.0 }],
  );
  assert.equal(getArtifactById(id).display_text, 'reach Sub Domain (a.b@mail.sub.example.co.uk) please');

  // The old greedy domain (`[A-Za-z0-9.-]+\.[A-Za-z]{2,}`) let `.` sit in both the class and the
  // following literal, so `x@` + `a.`×N backtracked super-linearly; the label form is linear. A
  // trailing-dot string has no valid TLD label → no match → returned verbatim (and promptly).
  const evil = 'x@' + 'a.'.repeat(80);
  assert.equal(annotateHandles(`${evil} tail`, []), `${evil} tail`, 'no false match; completes without catastrophic backtracking');
});

// --- Display name = first + last (#156) ---
test('preferredDisplayName (#156): reduces a middle name to first+last; leaves 2/4-token names and orgs', () => {
  assert.equal(preferredDisplayName({ fn: 'Amy Margaret Fenwick', name: { given: 'Amy', family: 'Fenwick', additional: 'Margaret' } }), 'Amy Fenwick');
  assert.equal(preferredDisplayName({ fn: 'Amy Margaret Fenwick' }), 'Amy Fenwick', '3-token FN reduces even without structured N');
  assert.equal(preferredDisplayName({ fn: 'Amy Fenwick' }), 'Amy Fenwick', '2-token unchanged');
  assert.equal(preferredDisplayName({ fn: 'Maria de la Cruz' }), 'Maria de la Cruz', '4-token left full (ambiguous)');
  assert.equal(preferredDisplayName({ fn: 'Acme Corporation', isCompany: true }), 'Acme Corporation', 'orgs keep full name');
  assert.equal(preferredDisplayName({ fn: 'Cher' }), 'Cher', 'mononym unchanged');
});

test('reduceEntityDisplayName (#156): 3-token canonical → first+last, both forms resolve, idempotent; 2/4-token untouched', () => {
  const id = Number(insertEntityStmt.run('person', 'Amy Margaret Fenwick', null).lastInsertRowid);
  insertAliasStmt.run(id, 'amy margaret fenwick', 'name'); // the full-name alias import would have made
  const r = reduceEntityDisplayName(id);
  assert.deepEqual([r.changed, r.to], [true, 'Amy Fenwick']);
  assert.equal(getEntity(id).canonical_name, 'Amy Fenwick', 'canonical reduced to first+last');
  assert.ok(resolveEntityIds('Amy Margaret Fenwick').includes(id), 'full name still resolves');
  assert.ok(resolveEntityIds('Amy Fenwick').includes(id), 'reduced name resolves');
  assert.equal(reduceEntityDisplayName(id).changed, false, 'idempotent — a 2-token canonical is skipped');

  const two = Number(insertEntityStmt.run('person', 'Bob Jones', null).lastInsertRowid);
  assert.equal(reduceEntityDisplayName(two).changed, false, '2-token unchanged');
  const four = Number(insertEntityStmt.run('person', 'Maria de la Cruz', null).lastInsertRowid);
  assert.equal(reduceEntityDisplayName(four).changed, false, '4-token unchanged');
  assert.equal(getEntity(four).canonical_name, 'Maria de la Cruz');
});

test('reduceEntityDisplayName (#157): does NOT rename when the reduced form is unresolvable (UI-tombstoned)', () => {
  const id = Number(insertEntityStmt.run('person', 'Nadia Rae Okafor', null).lastInsertRowid);
  addAlias(id, 'Nadia Rae Okafor', 'name'); // seed a name alias so the entity resolves
  addAlias(id, 'Nadia Okafor', 'name');     // the reduced form...
  removeAlias(id, 'Nadia Okafor', 'name');  // ...then remove it via the UI (tombstone, #111)
  const r = reduceEntityDisplayName(id);
  assert.equal(r.changed, false, 'reduction skipped — the reduced name would not resolve back to this entity');
  assert.equal(getEntity(id).canonical_name, 'Nadia Rae Okafor', 'canonical left unchanged, not set to a dead display name');
});

// --- Entity merge & duplicate detection (#75) ---
const getRawEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ?');
const lastMergeLogStmt = db.prepare("SELECT * FROM ingest_log WHERE event_type = 'entity_merged' ORDER BY id DESC LIMIT 1");

// A minimal person entity + its own self-linked contact artifact, mirroring what contacts.js
// produces (attrs carry emails[]/phones[] the same way structuredFields() does). `rawPath`
// mirrors #74's vCard PHOTO persistence (artifacts.raw_path) for #84's listContactPhotos tests.
function makePerson(name, { emails = [], phones = [], rawPath = null } = {}) {
  const entityId = Number(insertEntityStmt.run('person', name, JSON.stringify({ emails, phones })).lastInsertRowid);
  insertAliasStmt.run(entityId, name.toLowerCase(), 'name');
  for (const e of emails) insertAliasStmt.run(entityId, e.toLowerCase(), 'email');
  for (const p of phones) insertAliasStmt.run(entityId, p.replace(/\D/g, ''), 'phone');
  const { id: artifactId } = storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: `contact-${entityId}`, text_repr: `${name} contact card`, raw_path: rawPath },
    f32(0.5),
    [{ entity_id: entityId, role: 'self', confidence: 1.0 }],
  );
  return { entityId, artifactId };
}

test('mergeEntities: tombstones the absorbed entity (never deletes) and re-points aliases/links to the survivor', () => {
  const keep = makePerson('Robert Smith', { emails: ['robert@example.com'] });
  const absorb = makePerson('Bob Smith', { emails: ['bob@old.example.com'] });

  const result = mergeEntities(keep.entityId, absorb.entityId);
  assert.deepEqual(result.moved, { aliases: 2, links: 1, relations: 0 }); // name + email alias, 1 self link

  const absorbedRow = getRawEntityStmt.get(absorb.entityId);
  assert.equal(absorbedRow.merged_into, keep.entityId, 'absorbed entity tombstoned, row still present (never deleted)');

  // An alias that lived only on the absorbed entity now resolves straight to the survivor.
  assert.deepEqual(resolveEntityIds('bob@old.example.com'), [keep.entityId]);
  assert.deepEqual(resolveEntityIds('bob smith'), [keep.entityId]);

  // The absorbed contact's own artifact link is re-pointed to the survivor entity.
  const artifact = getArtifactById(absorb.artifactId);
  assert.ok(artifact.links.some((l) => l.entity_id === keep.entityId && l.role === 'self'));
});

test('mergeEntities: logs an entity_merged ingest_log row with moved counts + absorbed attrs', () => {
  const keep = makePerson('Jane Doe', {});
  const absorb = makePerson('J. Doe', { emails: ['jane@old.example.com'] });
  mergeEntities(keep.entityId, absorb.entityId);

  const details = JSON.parse(lastMergeLogStmt.get().details);
  assert.equal(details.keep_id, keep.entityId);
  assert.equal(details.absorb_id, absorb.entityId);
  assert.equal(details.moved.aliases, 2);
  assert.deepEqual(details.absorbed_attrs.emails, ['jane@old.example.com']);
});

test('mergeEntities: self-merge throws SELF_MERGE and changes nothing', () => {
  const p = makePerson('Solo Person', {});
  assert.throws(() => mergeEntities(p.entityId, p.entityId), (err) => err.code === 'SELF_MERGE');
  assert.equal(getRawEntityStmt.get(p.entityId).merged_into, null);
});

test('mergeEntities: re-merging an already-tombstoned entity throws NOT_FOUND (idempotent-safe)', () => {
  const keep = makePerson('Keep Person', {});
  const absorb = makePerson('Absorb Person', {});
  mergeEntities(keep.entityId, absorb.entityId);

  const third = makePerson('Third Person', {});
  assert.throws(() => mergeEntities(third.entityId, absorb.entityId), (err) => err.code === 'NOT_FOUND');
});

test('mergeEntities: drops a direct keep<->absorb relation (no self-loop), excludes it from moved.relations, and repoints third-party relations', () => {
  const keep = makePerson('Keep Rel', {});
  const absorb = makePerson('Absorb Rel', {});
  const third = makePerson('Third Rel', {});
  upsertEntityRelation({ from_entity_id: keep.entityId, to_entity_id: absorb.entityId, relation_type: 'sibling', source: 'test' });
  upsertEntityRelation({ from_entity_id: third.entityId, to_entity_id: absorb.entityId, relation_type: 'friend', source: 'test' });

  const result = mergeEntities(keep.entityId, absorb.entityId);
  // The direct keep<->absorb edge is deleted, not moved — only the third-party relation
  // should be counted (moved.relations must not overstate what actually carried over).
  assert.equal(result.moved.relations, 1);

  const relations = db.prepare('SELECT * FROM entity_relations WHERE from_entity_id = ? OR to_entity_id = ?').all(keep.entityId, keep.entityId);
  assert.ok(!relations.some((r) => r.from_entity_id === r.to_entity_id), 'no self-loop relation survives the merge');
  assert.ok(
    relations.some((r) => r.from_entity_id === third.entityId && r.to_entity_id === keep.entityId && r.relation_type === 'friend'),
    'a third party\'s relation to the absorbed entity is re-pointed to the survivor'
  );
});

test('mergeEntities: an entity_links collision is deleted as a duplicate, never left orphaned pointing at the tombstoned id', () => {
  const keep = makePerson('Collision Keep', {});
  const absorb = makePerson('Collision Absorb', {});
  // Both entities separately linked as 'mentioned' to the same artifact — the exact collision
  // shape repointLinksStmt (a plain UPDATE, post-fix) cannot move without first deduping.
  const { id: sharedArtifactId } = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'shared', text_repr: 'mentions both' },
    f32(0.5),
    [
      { entity_id: keep.entityId, role: 'mentioned', confidence: 0.7 },
      { entity_id: absorb.entityId, role: 'mentioned', confidence: 0.7 },
    ],
  );

  mergeEntities(keep.entityId, absorb.entityId);

  const rows = db.prepare('SELECT entity_id, role FROM entity_links WHERE artifact_id = ?').all(sharedArtifactId);
  assert.deepEqual(
    rows, [{ entity_id: keep.entityId, role: 'mentioned' }],
    'the colliding duplicate is deleted outright, not left dangling on the tombstoned absorb id'
  );
  // get_artifact/getArtifactById must never surface a stale link to the tombstoned entity.
  assert.ok(!getArtifactById(sharedArtifactId).links.some((l) => l.entity_id === absorb.entityId));
});

test('mergeEntities: an entity_relations collision (to-side) is deleted as a duplicate, never left orphaned', () => {
  const keep = makePerson('Rel Collision Keep', {});
  const absorb = makePerson('Rel Collision Absorb', {});
  const third = makePerson('Rel Collision Third', {});
  upsertEntityRelation({ from_entity_id: third.entityId, to_entity_id: keep.entityId, relation_type: 'friend', source: 'test' });
  upsertEntityRelation({ from_entity_id: third.entityId, to_entity_id: absorb.entityId, relation_type: 'friend', source: 'test' });

  mergeEntities(keep.entityId, absorb.entityId);

  const rows = db.prepare('SELECT from_entity_id, to_entity_id, relation_type FROM entity_relations WHERE from_entity_id = ?').all(third.entityId);
  assert.deepEqual(
    rows, [{ from_entity_id: third.entityId, to_entity_id: keep.entityId, relation_type: 'friend' }],
    'the colliding duplicate relation is deleted, not left pointing at the tombstoned absorb id'
  );
});

test('listProbableDuplicates: surfaces a shared-phone pair (contacts.js never auto-merges on phone) and excludes merged entities', () => {
  const a = makePerson('Duplicate One', { phones: ['(240) 555-0142'] });
  const b = makePerson('Duplicate Two', { phones: ['2405550142'] }); // same number, different formatting
  const unrelated = makePerson('Unrelated Person', { phones: ['5551234567'] });

  const pairs = listProbableDuplicates(50);
  const found = pairs.find((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId));
  assert.ok(found, 'shared-phone pair surfaced');
  assert.match(found.reason, /shared phone/);
  assert.equal(pairs.filter((p) => [p.a.id, p.b.id].includes(unrelated.entityId)).length, 0, 'an unrelated phone number is not paired');

  // #404: each side carries its own email/phone/link counts (both sides here have 1 phone, 0
  // emails, and exactly the one self-linked contact artifact makePerson creates).
  const sideA = found.a.id === a.entityId ? found.a : found.b;
  const sideB = found.a.id === b.entityId ? found.a : found.b;
  for (const side of [sideA, sideB]) {
    assert.equal(side.phone_count, 1);
    assert.equal(side.email_count, 0);
    assert.equal(side.link_count, 1);
  }

  mergeEntities(a.entityId, b.entityId);
  const after = listProbableDuplicates(50);
  assert.ok(!after.some((p) => p.a.id === b.entityId || p.b.id === b.entityId), 'the tombstoned entity is excluded from future duplicate listings');
});

test('listProbableDuplicates (#404): both sides carry independent, non-symmetric email/phone/link counts', () => {
  // Deliberately mismatched fixtures — a shared-name-similarity pair, not shared phone/email, so
  // the sides' own attrs are free to differ — proves email_count isn't hardcoded to 0 or copied
  // from the wrong side.
  const a = makePerson('Count Asymmetric One', { emails: ['one@example.com', 'two@example.com'], phones: ['5556661111'] });
  const b = makePerson('Count Asymmetric Two', { emails: [] });

  const pairs = listProbableDuplicates(50);
  const found = pairs.find((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId));
  assert.ok(found, 'similar-name pair surfaced');
  const sideA = found.a.id === a.entityId ? found.a : found.b;
  const sideB = found.a.id === b.entityId ? found.a : found.b;
  assert.equal(sideA.email_count, 2);
  assert.equal(sideA.phone_count, 1);
  assert.equal(sideB.email_count, 0);
  assert.equal(sideB.phone_count, 0);
  assert.equal(sideA.link_count, 1);
  assert.equal(sideB.link_count, 1);
});

test('listProbableDuplicates (#404): link_count is a DISTINCT-artifact count, not a raw entity_links row count', () => {
  const a = makePerson('Link Count One', { phones: ['5556660001'] });
  const b = makePerson('Link Count Two', { phones: ['5556660001'] });
  // Link a's own contact artifact under a SECOND role — entity_links' PK is
  // (artifact_id, entity_id, role), so this is a legitimate second row for the same artifact,
  // not a duplicate insert. A bare COUNT(*) would report 2 links here; the honest figure is 1
  // distinct artifact.
  db.prepare(`INSERT INTO entity_links (artifact_id, entity_id, role, confidence) VALUES (?, ?, 'mentioned', 0.5)`)
    .run(a.artifactId, a.entityId);

  const pairs = listProbableDuplicates(50);
  const found = pairs.find((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId));
  assert.ok(found, 'shared-phone pair surfaced');
  const sideA = found.a.id === a.entityId ? found.a : found.b;
  const sideB = found.a.id === b.entityId ? found.a : found.b;
  assert.equal(sideA.link_count, 1, 'one artifact linked under two roles still counts as one linked artifact');
  assert.equal(sideB.link_count, 1);
});

test('dismissDuplicatePair (#302): excludes the pair from listProbableDuplicates; others untouched', () => {
  const a = makePerson('Dismiss One', { phones: ['5551110001'] });
  const b = makePerson('Dismiss Two', { phones: ['5551110001'] });
  const c = makePerson('Dismiss Three', { phones: ['5552220002'] });
  const d = makePerson('Dismiss Four', { phones: ['5552220002'] });

  dismissDuplicatePair(a.entityId, b.entityId);
  const pairs = listProbableDuplicates(50);
  assert.ok(!pairs.some((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId)), 'the dismissed pair is suppressed');
  assert.ok(pairs.some((p) => [p.a.id, p.b.id].includes(c.entityId) && [p.a.id, p.b.id].includes(d.entityId)), 'an untouched pair still surfaces');
});

test('listProbableDuplicates (#302): includeDismissed:true surfaces a dismissed pair again (debug opt)', () => {
  const a = makePerson('IncludeDismissed One', { phones: ['5551110009'] });
  const b = makePerson('IncludeDismissed Two', { phones: ['5551110009'] });
  dismissDuplicatePair(a.entityId, b.entityId);

  const hidden = listProbableDuplicates(50);
  assert.ok(!hidden.some((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId)), 'hidden by default');

  const shown = listProbableDuplicates(50, { includeDismissed: true });
  assert.ok(shown.some((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId)), 'includeDismissed:true bypasses the suppression');
});

test('dismissDuplicatePair (#302): order-independent — (b,a) hits the same canonical row', () => {
  const before = countDuplicateDismissals(); // this file shares one temp DB — check the DELTA
  const a = makePerson('Order One', { phones: ['5553330003'] });
  const b = makePerson('Order Two', { phones: ['5553330003'] });
  dismissDuplicatePair(b.entityId, a.entityId); // reversed order
  assert.equal(countDuplicateDismissals(), before + 1);
  const pairs = listProbableDuplicates(50);
  assert.ok(!pairs.some((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId)));
});

test('dismissDuplicatePair (#302): idempotent — a repeat writes no second row and no second log row', () => {
  const before = countDuplicateDismissals(); // this file shares one temp DB — check the DELTA
  const a = makePerson('Idem One', { phones: ['5554440004'] });
  const b = makePerson('Idem Two', { phones: ['5554440004'] });
  const first = dismissDuplicatePair(a.entityId, b.entityId, { score: 0.9, reason: 'shared phone' });
  assert.deepEqual(first, { dismissed: true, created: true });
  const countAfterFirst = db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'duplicate_pair_dismissed'").get().n;
  const second = dismissDuplicatePair(a.entityId, b.entityId, { score: 0.9, reason: 'shared phone' });
  assert.deepEqual(second, { dismissed: true, created: false });
  assert.equal(countDuplicateDismissals(), before + 1, 'still one new row, not two');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'duplicate_pair_dismissed'").get().n,
    countAfterFirst,
    'no second log row on a no-op re-dismiss'
  );
});

test('dismissDuplicatePair (#302): absolute until cleared — a later, stronger signal does not re-surface it', () => {
  const a = makePerson('Absolute One', { phones: ['5555550005'] });
  const b = makePerson('Absolute Two', { phones: ['5555550005'] });
  dismissDuplicatePair(a.entityId, b.entityId, { score: 0.9, reason: 'shared phone' });
  // Add a shared email too — a strictly stronger signal (0.95) — the dismissal must still hold.
  // listProbableDuplicates reads attrs_json directly (not entity_aliases), so a raw update is the
  // right level here — updateEntityAttrs would ALIAS_CONFLICT on two different entities claiming
  // the same email, which is a real UI-layer guard, not what this test is exercising.
  const setAttrs = db.prepare('UPDATE entities SET attrs_json = ? WHERE id = ?');
  setAttrs.run(JSON.stringify({ emails: ['same@example.com'], phones: ['5555550005'] }), a.entityId);
  setAttrs.run(JSON.stringify({ emails: ['same@example.com'], phones: ['5555550005'] }), b.entityId);
  const pairs = listProbableDuplicates(50);
  assert.ok(!pairs.some((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId)), 'still suppressed despite new stronger evidence');
});

test('dismissDuplicatePair (#302): NOT_FOUND for a bogus id or an already-tombstoned side; SAME_ENTITY for (x,x); table unaffected by the throw', () => {
  const before = countDuplicateDismissals(); // this file shares one temp DB — check the DELTA, not an absolute 0
  const a = makePerson('Guard One', {});
  const b = makePerson('Guard Two', {});
  assert.throws(() => dismissDuplicatePair(a.entityId, a.entityId), (err) => err.code === 'SAME_ENTITY');
  assert.throws(() => dismissDuplicatePair(a.entityId, 999999999), (err) => err.code === 'NOT_FOUND');

  mergeEntities(a.entityId, b.entityId); // tombstones b
  assert.throws(() => dismissDuplicatePair(a.entityId, b.entityId), (err) => err.code === 'NOT_FOUND', 'an already-merged side is NOT_FOUND');
  assert.equal(countDuplicateDismissals(), before, 'no row written by any of the throws (rollback)');
});

test('dismissDuplicatePair (#302): a mismatched-type same-id pair (raw !== but numerically equal) is SAME_ENTITY, not a silently-swallowed CHECK violation', () => {
  const before = countDuplicateDismissals();
  const c = makePerson('Coerce Guard', {});
  // String(c.entityId) !== c.entityId by strict ===, but Math.min/Math.max coerce both to the same
  // number — the equality guard must run AFTER canonicalization, or this reaches the DB layer and
  // (since SQLite's IGNORE conflict resolution also suppresses CHECK failures, not just UNIQUE)
  // a plain "INSERT OR IGNORE" would silently report success while writing nothing.
  assert.throws(() => dismissDuplicatePair(String(c.entityId), c.entityId), (err) => err.code === 'SAME_ENTITY');
  assert.equal(countDuplicateDismissals(), before, 'no row written');
});

test('dismissDuplicatePair (#302, pre-slice regression): dismissing a pair within the limit window still returns a FULL window, not a shrunk one', () => {
  // This file shares one temp DB across many tests, so other pairs (from earlier tests) also rank
  // somewhere in the corpus — don't assume this pair is globally #1. Instead: find where it ranks
  // unfiltered, request exactly that many results (so it's the LAST item in the window), dismiss it,
  // and assert the window is still full — a pair from beyond the old cutoff got promoted in. Post-slice
  // filtering would instead leave the window one short.
  const c = makePerson('Slice Three', { emails: ['slice@example.com'] });
  const d = makePerson('Slice Four', { emails: ['slice@example.com'] }); // 0.95 email match

  const full = listProbableDuplicates(100000);
  const idx = full.findIndex((p) => [p.a.id, p.b.id].includes(c.entityId) && [p.a.id, p.b.id].includes(d.entityId));
  assert.ok(idx >= 0, 'the fresh pair is somewhere in the ranked list');
  const windowSize = idx + 1;
  assert.equal(listProbableDuplicates(windowSize).length, windowSize, 'sanity: a window sized to include it is full before dismissal');

  dismissDuplicatePair(c.entityId, d.entityId);

  const afterDismiss = listProbableDuplicates(windowSize);
  assert.equal(afterDismiss.length, windowSize, 'suppression happens before .slice(limit), so the same-sized window still fills');
  assert.ok(!afterDismiss.some((p) => [p.a.id, p.b.id].includes(c.entityId) && [p.a.id, p.b.id].includes(d.entityId)), 'the dismissed pair itself is gone');
});

test('dismissDuplicatePair (#302): non-transitive — dismissing (a,b) then merging b into c does not suppress (a,c); FKs stay clean', () => {
  const a = makePerson('NonTrans One', { phones: ['5557770007'] });
  const b = makePerson('NonTrans Two', { phones: ['5557770007'] });
  const c = makePerson('NonTrans Three', { phones: ['5557770007'] });
  dismissDuplicatePair(a.entityId, b.entityId);
  mergeEntities(c.entityId, b.entityId); // b absorbed into c

  const pairs = listProbableDuplicates(50);
  assert.ok(pairs.some((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(c.entityId)), '(a,c) still surfaces — the dismissal on (a,b) does not carry over');
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'the dismissal row surviving b\'s merge is inert, not an FK orphan');
});

test('clearDuplicateDismissals (#302): returns { cleared }, restores the pairs, logs the full doomed rows, and a second clear is a no-op', () => {
  clearDuplicateDismissals(); // this file shares one temp DB — wipe whatever earlier tests dismissed first
  const logCountBefore = db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'duplicate_dismissals_cleared'").get().n;
  const a = makePerson('Clear One', { phones: ['5558880008'] });
  const b = makePerson('Clear Two', { phones: ['5558880008'] });
  const c = makePerson('Clear Three', { phones: ['5559990009'] });
  const d = makePerson('Clear Four', { phones: ['5559990009'] });
  dismissDuplicatePair(a.entityId, b.entityId, { score: 0.9, reason: 'r1' });
  dismissDuplicatePair(c.entityId, d.entityId, { score: 0.9, reason: 'r2' });

  const result = clearDuplicateDismissals();
  assert.deepEqual(result, { cleared: 2 });
  assert.equal(countDuplicateDismissals(), 0);
  const pairs = listProbableDuplicates(50);
  assert.ok(pairs.some((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId)), 'the pair reappears after clear');

  const logRow = db.prepare("SELECT details FROM ingest_log WHERE event_type = 'duplicate_dismissals_cleared' ORDER BY id DESC LIMIT 1").get();
  const details = JSON.parse(logRow.details);
  assert.equal(details.cleared, 2);
  assert.ok(details.pairs.some((p) => p.a === Math.min(a.entityId, b.entityId) && p.reason === 'r1'), 'the cleared rows are named in the log');

  const second = clearDuplicateDismissals();
  assert.deepEqual(second, { cleared: 0 });
  const logCountAfter = db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'duplicate_dismissals_cleared'").get().n;
  assert.equal(logCountAfter, logCountBefore + 1, 'the real clear logged exactly one row; the no-op second clear logged none');
});

test('listContactPhotos: only live person entities with a preserved contact photo (#84)', () => {
  const photographed = makePerson('Photographed Person', { rawPath: '/raw/contacts/aaa.jpg' });
  const noPhoto = makePerson('No Photo Person', {});
  const company = Number(insertEntityStmt.run('org', 'Acme Corp', JSON.stringify({})).lastInsertRowid);
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: `contact-${company}`, text_repr: 'Acme Corp contact card', raw_path: '/raw/contacts/company.jpg' },
    f32(0.5),
    [{ entity_id: company, role: 'self', confidence: 1.0 }],
  );

  const photos = listContactPhotos(100);
  assert.ok(photos.some((p) => p.entity_id === photographed.entityId && p.raw_path === path.resolve('/raw/contacts/aaa.jpg')));
  assert.ok(!photos.some((p) => p.entity_id === noPhoto.entityId), 'a contact with no preserved photo is excluded');
  assert.ok(!photos.some((p) => p.entity_id === company), 'a company entity is excluded even with a raw_path');

  // A merged-away (tombstoned) entity's photo must not be offered as a reference face either.
  const absorbTarget = makePerson('Merge Absorb Target', { rawPath: '/raw/contacts/bbb.jpg' });
  mergeEntities(photographed.entityId, absorbTarget.entityId);
  const afterMerge = listContactPhotos(100);
  assert.ok(!afterMerge.some((p) => p.entity_id === absorbTarget.entityId), 'a tombstoned entity is excluded from contact-photo listings');
});

test('listEntities: hasPhoto true for an imported raw_path OR an uploaded photoFile, false otherwise (#113)', () => {
  const imported = makePerson('Photo Imported Person', { rawPath: '/raw/contacts/imp.jpg' });
  // Uploaded-only: an entity with attrs.photoFile but a self-linked artifact WITHOUT a raw_path
  // (the #97 UI-upload shape) — has_photo (SQL, raw_path) is false, so hasPhoto must come from photoFile.
  const uploadedId = Number(insertEntityStmt.run('person', 'Photo Uploaded Person', JSON.stringify({ photoFile: 'abc123.jpg' })).lastInsertRowid);
  insertAliasStmt.run(uploadedId, 'photo uploaded person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: `contact-${uploadedId}`, text_repr: 'Photo Uploaded Person contact card' },
    f32(0.5), [{ entity_id: uploadedId, role: 'self', confidence: 1.0 }],
  );
  const none = makePerson('Photo None Person', {});

  const byId = new Map(listEntities({ limit: 500 }).map((e) => [e.id, e]));
  assert.equal(byId.get(imported.entityId)?.hasPhoto, true, 'imported raw_path -> hasPhoto true');
  assert.equal(byId.get(uploadedId)?.hasPhoto, true, 'uploaded attrs.photoFile -> hasPhoto true');
  assert.equal(byId.get(none.entityId)?.hasPhoto, false, 'no photo -> hasPhoto false');
});

test('listContactPhotos: dedups an entity with two self-linked photographed artifacts to one row, and resolves a relative raw_path to absolute (#84)', () => {
  // The ordinary multi-source-consolidation case: the same person imported from a second vCard
  // source under a different UID resolves to the same entity (contacts.js's resolveExistingEntity)
  // but creates a NEW self-linked contact artifact — this entity now has two role='self' links.
  const entityId = Number(insertEntityStmt.run('person', 'Multi Source Person', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(entityId, 'multi source person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: 'first-import', text_repr: 'Multi Source Person (first)', raw_path: 'raw/contacts/first.jpg' },
    f32(0.5), [{ entity_id: entityId, role: 'self', confidence: 1.0 }],
  );
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: 'second-import', text_repr: 'Multi Source Person (second)', raw_path: 'raw/contacts/second.jpg' },
    f32(0.5), [{ entity_id: entityId, role: 'self', confidence: 1.0 }],
  );

  const rows = listContactPhotos(100).filter((p) => p.entity_id === entityId);
  assert.equal(rows.length, 1, 'exactly one row per entity, even with two self-linked photographed artifacts');
  assert.ok(rows[0].raw_path.split(path.sep).join('/').endsWith('raw/contacts/second.jpg'), 'the most recently created contact artifact\'s photo wins');
  assert.ok(path.isAbsolute(rows[0].raw_path), 'a relative raw_path (CONTACTS_RAW_DIR default) is resolved to an absolute path');
});

test('schema (#110): foreign_keys pragma is ON', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('schema (#110): the tightened columns are NOT NULL in table_info', () => {
  const notnull = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().find((x) => x.name === c)?.notnull;
  assert.equal(notnull('entity_aliases', 'entity_id'), 1);
  assert.equal(notnull('entity_aliases', 'alias_type'), 1);
  assert.equal(notnull('entity_links', 'role'), 1);
  assert.equal(notnull('unresolved_aliases', 'alias_type'), 1);
  assert.equal(notnull('unresolved_aliases', 'role'), 1);
});

test('schema (#110): FK enforced — an alias/link/relation referencing a nonexistent entity throws', () => {
  const person = makePerson('FK Guard Person');
  assert.throws(() => db.prepare('INSERT INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)').run(9_999_999, 'ghost alias', 'name'), /FOREIGN KEY|foreign key/i);
  assert.throws(() => db.prepare('INSERT INTO entity_links (artifact_id, entity_id, role) VALUES (?, ?, ?)').run(person.artifactId, 9_999_999, 'mentioned'), /FOREIGN KEY|foreign key/i);
  assert.throws(() => db.prepare('INSERT INTO entity_relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)').run(person.entityId, 9_999_999, 'spouse'), /FOREIGN KEY|foreign key/i);
});

test('schema (#110): NOT NULL enforced — a NULL-role entity_links insert throws (was silently allowed)', () => {
  const person = makePerson('Null Role Person');
  assert.throws(() => db.prepare('INSERT INTO entity_links (artifact_id, entity_id, role) VALUES (?, ?, ?)').run(person.artifactId, person.entityId, null), /NOT NULL/i);
});

test('schema (#110): a born-tight, clean DB logs no not_null rebuild and no integrity violations', () => {
  const rows = db.prepare("SELECT details FROM ingest_log WHERE event_type IN ('schema_migration','integrity_check')").all();
  assert.ok(!rows.some((r) => /not_null/.test(r.details || '')), 'no NOT NULL rebuild on a DB born tight from CREATE TABLE');
  assert.ok(!rows.some((r) => { try { return (JSON.parse(r.details).foreign_key_violations || []).length > 0; } catch { return false; } }), 'no FK violations logged on a clean DB');
});

test('schema (#110): storeArtifactTxn throws (not silently drops) a link missing role', () => {
  const e = Number(insertEntityStmt.run('person', 'Roleless Link Person', null).lastInsertRowid);
  assert.throws(
    () => storeArtifactTxn({ type: 'note', source: uniqueSource(), text_repr: 'roleless link' }, f32(0.4), [{ entity_id: e }]),
    /link requires entity_id and role/,
  );
});

test('startup integrity (#409): a seeded fields ⊆ aliases violation is detected at boot, not repaired, and boot continues', () => {
  // The check runs once, at module load — this process already ran it before this test's entity
  // existed, so seeding one here would not re-trigger it. Two FRESH child processes against a
  // throwaway file: one seeds the violation and closes, the next imports db.js fresh (re-running
  // the startup pass against a file that already holds it) and reports what it found. Mirrors the
  // busy_timeout override test's own child-process technique, above in this file.
  const dbUrl = new URL('../src/db.js', import.meta.url).href;
  const tmp = path.join(os.tmpdir(), `lc-handlealias-${process.pid}.db`);
  const env = { ...process.env, DB_PATH: tmp, DB_MODULE_URL: dbUrl };

  execFileSync(process.execPath, ['-e',
    `import(process.env.DB_MODULE_URL).then((m) => {
       m.insertEntityStmt.run('person', 'Seeded Violation', JSON.stringify({ emails: ['seeded.violation@example.test'] }));
       m.db.close();
     });`,
  ], { env, encoding: 'utf8' });

  const out = execFileSync(process.execPath, ['-e',
    `import(process.env.DB_MODULE_URL).then((m) => {
       const row = m.db.prepare("SELECT details FROM ingest_log WHERE event_type = 'integrity_check' AND json_extract(details, '$.handle_alias_violations') IS NOT NULL ORDER BY id DESC LIMIT 1").get();
       console.log('ROW=' + JSON.stringify(row ? JSON.parse(row.details) : null));
       m.db.close();
     });`,
  ], { env, encoding: 'utf8' });

  const match = out.match(/ROW=(.*)/);
  assert.ok(match, 'the fresh-boot process reported a result');
  const details = JSON.parse(match[1]);
  assert.ok(details, 'a handle_alias_violations ingest_log row was written at boot');
  assert.equal(details.handle_alias_violations, 1);
  assert.equal(details.entities, 1);

  // Detect-don't-repair: re-open (this process) and confirm nothing was touched.
  const d2 = new Database(tmp);
  const entity = d2.prepare('SELECT attrs_json FROM entities WHERE canonical_name = ?').get('Seeded Violation');
  assert.deepEqual(JSON.parse(entity.attrs_json).emails, ['seeded.violation@example.test'], 'the field is untouched');
  assert.equal(d2.prepare(`SELECT COUNT(*) AS n FROM entity_aliases WHERE alias_type = 'email'`).get().n, 0, 'no alias was written — never repaired');
  d2.close();

  rmSync(tmp, { force: true }); rmSync(`${tmp}-wal`, { force: true }); rmSync(`${tmp}-shm`, { force: true });
});

test('alias tombstone (#111): removeAlias tombstones; additive re-add suppressed; explicit addAlias clears', () => {
  const e = Number(insertEntityStmt.run('person', 'Tombstone Person', null).lastInsertRowid);
  addAlias(e, 'betsy', 'name');
  assert.ok(resolveEntityIds('betsy').includes(e), 'alias resolves after add');
  removeAlias(e, 'betsy', 'name');
  assert.ok(!resolveEntityIds('betsy').includes(e), 'removed alias no longer resolves');
  // simulate an import/re-import/edit/hint trying to re-add it → suppressed by the tombstone
  assert.equal(insertAliasUnlessTombstoned(e, 'betsy', 'name'), 0, 'additive re-add is a no-op');
  assert.ok(!resolveEntityIds('betsy').includes(e), 'still not resolvable after an additive attempt');
  // explicit user re-add overrides: clears the tombstone and inserts
  addAlias(e, 'betsy', 'name');
  assert.ok(resolveEntityIds('betsy').includes(e), 'explicit addAlias overrides the tombstone');
  // tombstone cleared → a later additive insert is allowed again (dup here, but not suppressed)
  removeAlias(e, 'betsy', 'name');
  addAlias(e, 'betsy', 'name');
  assert.ok(resolveEntityIds('betsy').includes(e), 're-removal then re-add works (tombstone lifecycle)');
});

test('alias tombstone (#111): scoped per entity — a tombstone on one entity does not suppress another', () => {
  const a = Number(insertEntityStmt.run('person', 'Chris One', null).lastInsertRowid);
  const b = Number(insertEntityStmt.run('person', 'Chris Two', null).lastInsertRowid);
  addAlias(a, 'chrisx', 'handle');
  removeAlias(a, 'chrisx', 'handle'); // tombstone on a only
  assert.equal(insertAliasUnlessTombstoned(a, 'chrisx', 'handle'), 0, 'suppressed on the tombstoned entity');
  assert.equal(insertAliasUnlessTombstoned(b, 'chrisx', 'handle'), 1, 'allowed on a different entity');
  assert.ok(resolveEntityIds('chrisx').includes(b));
});

test('alias tombstone (#111): tombstone insert is idempotent (re-removal adds 0 rows)', () => {
  const e = Number(insertEntityStmt.run('person', 'Idem Tombstone', null).lastInsertRowid);
  addAlias(e, 'idemtomb', 'handle');
  removeAlias(e, 'idemtomb', 'handle');
  removeAlias(e, 'idemtomb', 'handle'); // second removal — OR IGNORE, no duplicate
  const n = db.prepare('SELECT COUNT(*) AS n FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = ?').get(e, 'idemtomb', 'handle').n;
  assert.equal(n, 1, 'exactly one tombstone row despite two removals');
});

// --- Contacts-UI alias writes sweep staged hints (#295) ---
// The UI write surface (createEntity / updateEntityAttrs / addAlias) seeds aliases, so every hint
// already staged under one of them becomes resolvable — and used to stay unlinked forever, invisible
// to about_entity and entity-filtered search until someone ran `npm run backfill:links` by hand.
// Each test stages its own hint against a fresh alias so the cases stay order-independent.
const stagePicturedHint = (alias) => {
  const { id } = storeArtifactTxn(
    { type: 'photo', source: uniqueSource(), source_id: `staged-${alias}`, text_repr: `a photo of ${alias}` },
    f32(0.55),
  );
  resolveEntityHints(id, [{ alias, alias_type: 'name', role: 'pictured' }]);
  assert.ok(
    db.prepare('SELECT 1 FROM unresolved_aliases WHERE artifact_id = ? AND alias = ?').get(id, alias),
    `precondition: "${alias}" staged (no entity owns it yet)`,
  );
  return id;
};
const linkExists = (artifactId, entityId) =>
  !!db.prepare('SELECT 1 FROM entity_links WHERE artifact_id = ? AND entity_id = ?').get(artifactId, entityId);
const sweepLogCount = (entityId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'staged_hints_resolved' AND json_extract(details, '$.entity_id') = ?`).get(entityId).n;

test('addAlias (#295): sweeps staged hints, reports linksFormed, and is idempotent', () => {
  const artifactId = stagePicturedHint('nadia okonkwo');
  const entityId = Number(insertEntityStmt.run('person', 'Nadia Okonkwo', null).lastInsertRowid);
  assert.ok(!linkExists(artifactId, entityId), 'precondition: no link before the alias exists');

  const first = addAlias(entityId, 'nadia okonkwo', 'name');
  assert.equal(first.added, true, 'the alias was inserted');
  assert.equal(first.linksFormed, 1, 'the staged hint linked in the same call');
  assert.ok(linkExists(artifactId, entityId), 'the artifact is now linked to the entity');
  assert.equal(sweepLogCount(entityId), 1, 'one staged_hints_resolved row for the sweep that changed the graph');

  const second = addAlias(entityId, 'nadia okonkwo', 'name');
  assert.equal(second.added, false, 're-adding the same alias inserts nothing');
  assert.equal(second.linksFormed, 0, 'and forms no additional links');
  assert.equal(sweepLogCount(entityId), 1, 'no second log row — a no-op sweep is not an event');
});

test('createEntity (#295): returns { id, linksFormed } and links history the seeded aliases now own', () => {
  const artifactId = stagePicturedHint('theo blackwood');
  const { id, linksFormed } = createEntity({ kind: 'person', canonical_name: 'Theo Blackwood' });
  assert.equal(typeof id, 'number', 'returns an object with a numeric id, not a bare id');
  assert.equal(linksFormed, 1, 'the create swept the hint staged under its name alias');
  assert.ok(linkExists(artifactId, id), 'the staged artifact is linked to the new entity');
  assert.equal(sweepLogCount(id), 1);
});

test('updateEntityAttrs (#295): a rename sweeps hints staged under the new name variants', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Wrong Name', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'wrong name', 'name');
  const artifactId = stagePicturedHint('imani castellanos');
  assert.ok(!linkExists(artifactId, entityId), 'precondition: unlinked before the rename');

  const res = updateEntityAttrs(entityId, { canonical_name: 'Imani Castellanos' });
  assert.equal(res.updated, true);
  assert.equal(res.linksFormed, 1, 'the rename added the matching name alias and swept it');
  assert.ok(linkExists(artifactId, entityId), 'the staged artifact linked on rename');

  const again = updateEntityAttrs(entityId, { canonical_name: 'Imani Castellanos' });
  assert.equal(again.linksFormed, 0, 'a no-change edit forms no links');
});

test('addAlias (#311): a losing name collision forms no links — the sweep only walks its own aliases', () => {
  // assertNoAliasConflict guards email/phone only, so a name collision no-ops silently via
  // INSERT OR IGNORE (data-model.md: single-owner per type, first writer wins). The sweep still runs
  // for the loser (#311 removed the `added` gate), but resolveStagedArtifactHints walks
  // selectEntityAliasesStmt = `WHERE entity_id = ?`, so the loser owns no matching alias and finds
  // nothing. That filter — not a gate — is what keeps it off the real owner's hints.
  const artifactId = stagePicturedHint('rosalind quaye');
  const owner = Number(insertEntityStmt.run('person', 'Rosalind Quaye', null).lastInsertRowid);
  assert.equal(addAlias(owner, 'rosalind quaye', 'name').linksFormed, 1, 'the owner links it');

  const other = Number(insertEntityStmt.run('person', 'Someone Else', null).lastInsertRowid);
  const res = addAlias(other, 'rosalind quaye', 'name');
  assert.equal(res.added, false, 'the collision no-ops (first writer wins)');
  assert.equal(res.linksFormed, 0, 'the loser forms no links');
  assert.ok(!linkExists(artifactId, other), 'the artifact is not linked to the non-owner');
  assert.equal(sweepLogCount(other), 0, 'no log row — nothing changed');
});

test('addAlias (#311): re-adding an alias the entity already owns still sweeps a stale backlog', () => {
  // The gap that made the `added` gate wrong. A hint staged BEFORE the alias existed leaves an entity
  // that OWNS the alias with its links missing — the live-DB backlog #295 was filed over (3,037 rows).
  // A re-add returns added:false, so gating the sweep on it stranded exactly those.
  // Order matters and mirrors history: the hint must be staged while NOTHING owns the alias (else
  // resolveEntityHints resolves it on the spot and never stages), and only then does the entity
  // acquire the alias — via insertAliasStmt directly, i.e. without the sweep addAlias now does.
  const artifactId = stagePicturedHint('backlog person');
  const entityId = Number(insertEntityStmt.run('person', 'Backlog Person', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'backlog person', 'name'); // owns the alias, never swept
  assert.ok(!linkExists(artifactId, entityId), 'precondition: alias owned but the hint is unlinked');

  const res = addAlias(entityId, 'backlog person', 'name');
  assert.equal(res.added, false, 'the alias row already existed');
  assert.equal(res.linksFormed, 1, 'the sweep still ran and healed the stale hint');
  assert.ok(linkExists(artifactId, entityId), 'the backlogged artifact is now linked');
  assert.equal(sweepLogCount(entityId), 1, 'the heal is logged (a branch that changed the outcome)');
});

test('backfill:links (#295): a one-shot heal after the UI paths sweep themselves forms 0', () => {
  // The steady-state paths now link on write, so the historical heal has nothing left to do —
  // which is the whole point of the fix (the backlog stops re-accumulating).
  const artifactId = stagePicturedHint('darius vane');
  const { id } = createEntity({ kind: 'person', canonical_name: 'Darius Vane' });
  assert.ok(linkExists(artifactId, id));
  assert.equal(resolveStagedArtifactHints(id), 0, 're-running the resolver forms 0 links (idempotent)');
});

// --- entity_aliases as the single enforced match surface (#409) ---
// entity_aliases is the only table any resolution path reads, but a contact's email/phone also
// lives in attrs_json (the UI-facing profile) — nothing enforced that a profile value is also
// indexed. These cover the fields ⊆ aliases invariant: reconcileHandleAliases (the one writer),
// resolveHandle/resolveForIngest (the one resolver), and every caller that now routes through them.

test('resolveHandle (#409): exact-match, type-scoped, live-entities-only — never reads attrs_json', () => {
  const id = Number(insertEntityStmt.run('person', 'Petra Lindqvist', null).lastInsertRowid);
  insertAliasStmt.run(id, 'petra@example.test', 'email');
  assert.deepEqual(resolveHandle('Petra@Example.TEST', 'email'), [id], 'normalizes before matching');
  assert.deepEqual(resolveHandle('petra@example.test', 'phone'), [], 'the type must match too');
  assert.deepEqual(resolveHandle('nobody@example.test', 'email'), []);
  // attrs_json alone (no alias row) resolves to nothing — the whole point of the invariant.
  const ghost = Number(insertEntityStmt.run('person', 'Ghost Field', JSON.stringify({ emails: ['ghost@example.test'] })).lastInsertRowid);
  assert.deepEqual(resolveHandle('ghost@example.test', 'email'), [], 'a field value with no alias row does not resolve');
  void ghost;
});

test('resolveHandle (#409): a merged-away entity never resolves (belt-and-suspenders over the merge repoint)', () => {
  const keep = Number(insertEntityStmt.run('person', 'Keep', null).lastInsertRowid);
  const absorb = Number(insertEntityStmt.run('person', 'Absorb', null).lastInsertRowid);
  insertAliasStmt.run(absorb, '5551112222', 'phone');
  mergeEntities(keep, absorb);
  assert.deepEqual(resolveHandle('5551112222', 'phone'), [keep], 'repointed to the survivor');
});

test('resolveForIngest (#409): the ladder — exact, then prefix, then directory — never writes', () => {
  const exactOwner = Number(insertEntityStmt.run('person', 'Exact Owner', null).lastInsertRowid);
  insertAliasStmt.run(exactOwner, 'exact owner', 'name');
  assert.deepEqual(resolveForIngest('Exact Owner', 'name'), { entityId: exactOwner, via: 'exact', directoryName: null });

  const full = Number(insertEntityStmt.run('person', 'Rosario Beltran', null).lastInsertRowid);
  insertAliasStmt.run(full, 'rosario beltran', 'name');
  assert.deepEqual(resolveForIngest('Rosario', 'name'), { entityId: full, via: 'prefix', directoryName: null });

  insertDirectoryEntry('Directory Only', '+1 (720) 555-7100', 'phone');
  assert.deepEqual(resolveForIngest('+17205557100', 'phone'), { entityId: null, via: 'directory', directoryName: 'Directory Only' });

  assert.deepEqual(resolveForIngest('+19995551234', 'phone'), { entityId: null, via: null, directoryName: null }, 'a full miss resolves nothing');
  const before = db.prepare('SELECT COUNT(*) AS n FROM entity_aliases').get().n;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_aliases').get().n, before, 'never writes an alias');
});

test('reconcileHandleAliases (#409, case a): a field value present in attrs with no alias is indexed on the next updateEntityAttrs', () => {
  // The exact reported shape: attrs.emails carries a value entity_aliases never got (drift from a
  // pre-#409 writer — here simulated with a raw insertEntityStmt, same as a live #111-style entity).
  const id = Number(insertEntityStmt.run('person', 'Drift Case', JSON.stringify({ emails: ['drift.case@example.test'], phones: [] })).lastInsertRowid);
  assert.equal(resolveHandle('drift.case@example.test', 'email').length, 0, 'precondition: the field value is unaliased');
  const artifactId = storeArtifactTxn({ type: 'message', source: uniqueSource(), source_id: 'drift-1', text_repr: 'note' }, f32(0.71)).id;
  resolveEntityHints(artifactId, [{ alias: 'drift.case@example.test', alias_type: 'email', role: 'sender' }]);
  assert.ok(!linkExists(artifactId, id), 'precondition: the hint stayed unresolved (no alias to match)');

  // A no-op-looking profile save (same canonical_name, no attrs change) still reconciles — set-based,
  // not diff-based: updateEntityAttrs no longer needs a NEW value to heal an already-present one.
  const res = updateEntityAttrs(id, { canonical_name: 'Drift Case' });
  assert.deepEqual(resolveHandle('drift.case@example.test', 'email'), [id], 'the field value is now indexed');
  assert.equal(res.linksFormed, 1, 'and the sweep linked the history staged under it');
  assert.ok(linkExists(artifactId, id));
});

test('reconcileHandleAliases (#409, case b): remove-then-re-add via the field aliases it (tombstone cleared); the equivalent additive write does not', () => {
  const id = Number(insertEntityStmt.run('person', 'Tomb Case', JSON.stringify({ emails: ['tomb.case@example.test'] })).lastInsertRowid);
  updateEntityAttrs(id, { attrs: { emails: [] } }); // remove via the field — tombstones it (#111)
  assert.deepEqual(resolveHandle('tomb.case@example.test', 'email'), [], 'removed');

  // An ADDITIVE writer (explicit:false) — e.g. fillEntityAttrsFromCard/import/promote — must respect
  // the tombstone, never resurrect it.
  const additive = reconcileHandleAliases(id, { emails: ['tomb.case@example.test'] }, { explicit: false });
  assert.equal(additive.added, 0);
  assert.deepEqual(additive.skippedTombstoned, ['email']);
  assert.deepEqual(resolveHandle('tomb.case@example.test', 'email'), [], 'still not aliased — an automatic writer cannot resurrect it');

  // Typing the SAME email back into the field (explicit:true, a user-typed profile save) DOES
  // re-alias it — the tombstone is cleared, mirroring addAlias's own "explicit re-add" precedent.
  updateEntityAttrs(id, { attrs: { emails: ['tomb.case@example.test'] } });
  assert.deepEqual(resolveHandle('tomb.case@example.test', 'email'), [id], 'typing it back into the field re-aliases it');
});

test('reconcileHandleAliases (#409, case d): an alias with no backing field survives reconciliation', () => {
  // The 24-on-the-live-DB case: a historical handle the entity still resolves by, deliberately not
  // reflected on the card. Reconciling attrs that don't mention it must never delete it.
  const id = Number(insertEntityStmt.run('person', 'Unbacked Alias', JSON.stringify({ emails: ['current@example.test'] })).lastInsertRowid);
  insertAliasStmt.run(id, 'legacy@example.test', 'email'); // field-less alias — never in attrs.emails
  reconcileHandleAliases(id, { emails: ['current@example.test'] }, { explicit: false });
  assert.deepEqual(resolveHandle('legacy@example.test', 'email'), [id], 'the unbacked alias is untouched');
  assert.deepEqual(resolveHandle('current@example.test', 'email'), [id]);
});

test('reconcileHandleAliases (#409, case e): a handle owned by a different entity is skipped, not stolen', () => {
  const owner = Number(insertEntityStmt.run('person', 'Owner', null).lastInsertRowid);
  insertAliasStmt.run(owner, 'shared@example.test', 'email');
  const other = Number(insertEntityStmt.run('person', 'Other', JSON.stringify({ emails: ['shared@example.test'] })).lastInsertRowid);
  const res = reconcileHandleAliases(other, { emails: ['shared@example.test'] }, { explicit: false });
  assert.equal(res.added, 0);
  assert.deepEqual(res.skippedForeign, [{ alias_type: 'email', entity_id: owner }]);
  assert.deepEqual(resolveHandle('shared@example.test', 'email'), [owner], 'ownership never changed');
});

test('reconcileHandleAliases (#409, case f): idempotent — a second call over the same attrs adds 0', () => {
  const id = Number(insertEntityStmt.run('person', 'Idempotent Case', null).lastInsertRowid);
  const attrs = { emails: ['idem@example.test', 'idem@example.test'], phones: ['+1 (555) 010-2000'] }; // a duplicate value too
  const first = reconcileHandleAliases(id, attrs, { explicit: false });
  assert.equal(first.added, 2, 'one per distinct normalized value, the duplicate collapses');
  const second = reconcileHandleAliases(id, attrs, { explicit: false });
  assert.equal(second.added, 0);
  assert.deepEqual(second.skippedTombstoned, []);
  assert.deepEqual(second.skippedForeign, []);
});

test('resolveEntityHints (#409, case c / the #2096 repro): a directory name that already resolves to a live entity attaches instead of proposing', () => {
  insertDirectoryEntry('Marisol Fontaine', '+1 (720) 555-4400', 'phone');
  const eid = Number(insertEntityStmt.run('person', 'Marisol Fontaine', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'marisol fontaine', 'name');
  const { id } = storeArtifactTxn({ type: 'message', source: uniqueSource(), source_id: 'attach-1', text_repr: 'Message from +17205554400: "hi"' }, f32(0.5));
  const before = listProposedEntities('pending', 500).length;

  const r = resolveEntityHints(id, [{ alias: '+17205554400', alias_type: 'phone', role: 'sender' }]);
  assert.equal(r.resolved, 1, 'attached, counted as resolved');
  assert.equal(r.unresolved, 0);
  assert.ok(linkExists(id, eid), 'linked to the existing entity');
  assert.deepEqual(resolveHandle('7205554400', 'phone'), [eid], 'the phone is now aliased to her, closing the gap');
  assert.equal(listProposedEntities('pending', 500).length, before, 'no proposal staged — no duplicate risk');
});

test('resolveEntityHints (#409): a tombstoned handle for the directory-resolved owner still falls through to propose', () => {
  insertDirectoryEntry('Garrett Osei', '+1 (720) 555-4500', 'phone');
  const eid = Number(insertEntityStmt.run('person', 'Garrett Osei', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'garrett osei', 'name');
  insertAliasStmt.run(eid, '7205554500', 'phone');
  removeAlias(eid, '7205554500', 'phone'); // #111: he deliberately does not hold this number
  const { id } = storeArtifactTxn({ type: 'message', source: uniqueSource(), source_id: 'attach-2', text_repr: 'Message from +17205554500: "hi"' }, f32(0.51));

  resolveEntityHints(id, [{ alias: '+17205554500', alias_type: 'phone', role: 'sender' }]);
  assert.ok(!linkExists(id, eid), 'not attached — tombstoned');
  assert.ok(listProposedEntities('pending', 500).some((p) => p.alias === '7205554500'), 'falls through to the ordinary propose path');
});

test('fillEntityAttrsFromCard (#409): fills an empty field AND aliases it; a tombstoned card value adds no alias and does not re-fill the field', () => {
  const id = Number(insertEntityStmt.run('person', 'Card Fill Case', JSON.stringify({ emails: [] })).lastInsertRowid);
  const filled = fillEntityAttrsFromCard(id, { emails: ['card.fill@example.test'] });
  assert.deepEqual(filled.filled, ['emails']);
  assert.equal(filled.aliasesAdded, 1);
  assert.deepEqual(resolveHandle('card.fill@example.test', 'email'), [id], 'both fills AND aliases');

  // Now the equivalent additive write on a TOMBSTONED value.
  const id2 = Number(insertEntityStmt.run('person', 'Card Tombstone Case', JSON.stringify({ emails: ['tombstoned.card@example.test'] })).lastInsertRowid);
  updateEntityAttrs(id2, { attrs: { emails: [] } }); // remove via the field, tombstones it
  const refill = fillEntityAttrsFromCard(id2, { emails: ['tombstoned.card@example.test'] });
  assert.deepEqual(refill.filled, [], 'does not re-fill the field');
  assert.deepEqual(resolveHandle('tombstoned.card@example.test', 'email'), [], 'and adds no alias');
});

test('fillEntityAttrsFromCard (#409): never reconciles a key it left untouched (a non-empty field is out of scope for this writer)', () => {
  // Mirrors #304's own "fills only empty fields" test — emails already non-empty, so the whole key
  // (and therefore its aliasing) is skipped, not just the overwrite.
  const id = Number(insertEntityStmt.run('person', 'Untouched Field', JSON.stringify({ emails: ['already.set@example.test'] })).lastInsertRowid);
  const res = fillEntityAttrsFromCard(id, { emails: ['other.card@example.test'], birthday: '1990-01-01' });
  assert.deepEqual(res.filled, ['birthday']);
  assert.equal(res.aliasesAdded, 0, 'emails was not filled, so it is not aliased either');
  assert.deepEqual(resolveHandle('already.set@example.test', 'email'), [], 'no alias was written for the untouched field');
});

test('createEntity / approveProposedEntity / promoteDirectoryName (#409): every attrs_json writer routes through the one reconciler', () => {
  // createEntity
  const { id: created } = createEntity({ kind: 'person', canonical_name: 'Created Writer', attrs: { emails: ['created.writer@example.test'] } });
  assert.deepEqual(resolveHandle('created.writer@example.test', 'email'), [created]);

  // approveProposedEntity: a normal person/org proposal carries no attrs_json — reconciler no-ops,
  // the single staged alias (already inserted directly) is what resolves.
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Approved Writer', alias: 'approved.writer@example.test', alias_type: 'email', source: 'test' });
  const { entity_id: approvedId } = approveProposedEntity(prop.id);
  assert.deepEqual(resolveHandle('approved.writer@example.test', 'email'), [approvedId]);

  // promoteDirectoryName: its handle-alias loop now shares reconcileHandleAliases.
  insertDirectoryEntry('Promoted Writer', 'promoted.writer@example.test', 'email');
  const promoted = promoteDirectoryName('Promoted Writer');
  assert.deepEqual(resolveHandle('promoted.writer@example.test', 'email'), [promoted.entity_id]);
});

test('check:handle-aliases / backfill:handle-aliases (#409): the check flags a drifted value, the backfill heals it, both are idempotent', () => {
  const id = Number(insertEntityStmt.run('person', 'Backfill Target', JSON.stringify({ emails: ['backfill.target@example.test'], phones: [] })).lastInsertRowid);
  const before = listLiveEntityHandleAttrs().find((e) => e.id === id);
  assert.ok(before, 'the scan surface sees the live entity');
  assert.deepEqual(before.attrs.emails, ['backfill.target@example.test']);

  const artifactId = storeArtifactTxn({ type: 'message', source: uniqueSource(), source_id: 'backfill-1', text_repr: 'note' }, f32(0.72)).id;
  resolveEntityHints(artifactId, [{ alias: 'backfill.target@example.test', alias_type: 'email', role: 'sender' }]);
  assert.ok(!linkExists(artifactId, id), 'precondition: unresolved before the backfill');

  assert.deepEqual(parseHandleAliasesArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseHandleAliasesArgs([]), { dryRun: false });

  const dry = backfillHandleAliases({ dryRun: true });
  assert.ok(dry.aliasesAdded >= 1, 'the dry run computed the real count');
  assert.deepEqual(resolveHandle('backfill.target@example.test', 'email'), [], 'but wrote nothing — genuinely dry');
  assert.ok(!linkExists(artifactId, id));

  const real = backfillHandleAliases({ dryRun: false });
  assert.ok(real.aliasesAdded >= 1);
  assert.deepEqual(resolveHandle('backfill.target@example.test', 'email'), [id], 'the real run wrote the alias');
  assert.ok(linkExists(artifactId, id), 'and swept the staged history');

  const again = backfillHandleAliases({ dryRun: false });
  assert.equal(again.aliasesAdded, 0, 'idempotent — a second run adds 0');
  assert.equal(again.linksFormed, 0);
  const logRows = db.prepare(`SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'handle_aliases_backfill'`).get().n;
  assert.equal(logRows, 1, 'a no-op re-run writes no ingest_log row');
});

// The check is the CI gate for the invariant, so it needs its own coverage: an untested gate that
// passes is indistinguishable from one that is correct (#324/#400's fail-open family). Violations
// are asserted per-entity, never as "the DB is globally clean" — this file shares one temp DB
// across every test, so earlier tests legitimately leave their own drifted rows behind.
const violationsFor = (entityId) =>
  checkHandleAliases(process.env.DB_PATH).violations.filter((v) => v.entity_id === entityId);

test('check:handle-aliases (#409): flags a drifted value and accepts all three permitted states', () => {
  const drifted = Number(insertEntityStmt.run('person', 'Check Drifted', JSON.stringify({ emails: ['check.drifted@example.test'], phones: [] })).lastInsertRowid);
  const flagged = violationsFor(drifted);
  assert.equal(flagged.length, 1, 'a field value with no alias anywhere is a violation');
  assert.equal(flagged[0].alias_type, 'email');
  assert.equal(typeof flagged[0].unlinked_artifacts, 'number');
  // Absolute rule 7: the finding is a pointer (id + type + count), never the handle itself.
  assert.ok(
    !Object.values(flagged[0]).some((v) => typeof v === 'string' && v.includes('@')),
    'no handle value appears in the reported violation',
  );

  // Permitted state 1 — aliased to its own entity.
  reconcileHandleAliases(drifted, { emails: ['check.drifted@example.test'] }, { explicit: false });
  assert.deepEqual(violationsFor(drifted), [], 'aliasing it clears the violation');

  // Permitted state 2 — tombstoned (#111): deliberately not matched, so the field value standing
  // alone is a decision, not drift. addAlias/removeAlias leave attrs untouched, which is the point.
  const tombstoned = Number(insertEntityStmt.run('person', 'Check Tombstoned', JSON.stringify({ emails: ['check.tombstoned@example.test'], phones: [] })).lastInsertRowid);
  addAlias(tombstoned, 'check.tombstoned@example.test', 'email');
  removeAlias(tombstoned, 'check.tombstoned@example.test', 'email');
  assert.deepEqual(violationsFor(tombstoned), [], 'a tombstoned value is permitted, not a violation');

  // Permitted state 3 — owned by a DIFFERENT live entity (two contacts listing one shared number).
  const owner = Number(insertEntityStmt.run('person', 'Check Owner', JSON.stringify({ emails: ['check.shared@example.test'], phones: [] })).lastInsertRowid);
  reconcileHandleAliases(owner, { emails: ['check.shared@example.test'] }, { explicit: false });
  const sharer = Number(insertEntityStmt.run('person', 'Check Sharer', JSON.stringify({ emails: ['check.shared@example.test'], phones: [] })).lastInsertRowid);
  assert.deepEqual(violationsFor(sharer), [], 'a foreign-owned value is permitted, not a violation');
});

test('check:handle-aliases (#409): its duplicated normalizers still agree with db.js', () => {
  // check-handle-aliases.js must not import db.js (its header explains why), so it carries its own
  // copy of normalizeName/normalizePhone. If db.js's copy ever diverges — the #129 NANP rule is the
  // live example — the CI gate would silently disagree with the writer it checks. This is that guard.
  const byType = Object.fromEntries(CHECK_HANDLE_ALIAS_FIELDS.map(([, aliasType, normalize]) => [aliasType, normalize]));
  for (const raw of ['  Mixed.Case@Example.TEST  ', 'plain@example.test', 'UPPER@EXAMPLE.TEST']) {
    assert.equal(byType.email(raw), normalizeName(raw), `email normalizer agrees for ${JSON.stringify(raw)}`);
  }
  for (const raw of ['+1 (415) 555-0148', '1-415-555-0148', '(415) 555-0148', '+44 20 7946 0958', '555-0148', '']) {
    assert.equal(byType.phone(raw), normalizePhone(raw), `phone normalizer agrees for ${JSON.stringify(raw)}`);
  }
});

// --- Proposed entities (#119): the human-approval gate for entities auto-proposed from artifacts ---
const orgHint = (name) => [{ alias: name, alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }];

test('proposed entities (#119): an unmatched hint with suggested_kind stages a proposal and mints nothing', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'document', source, source_id: 'receipt-1', text_repr: 'ACME Hardware receipt' },
    f32(0.5), orgHint('ACME Hardware'),
  );
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'ACME Hardware');
  assert.ok(p, 'a pending proposal was staged');
  assert.equal(p.suggested_kind, 'org');
  assert.equal(resolveEntityIds('ACME Hardware').length, 0, 'no entity was minted');
  assert.equal(getArtifactById(id).links.length, 0, 'no link formed yet');
});

test('proposed entities (#119): a hint WITHOUT suggested_kind stages no proposal', () => {
  const source = uniqueSource();
  upsertArtifactTxn(
    { type: 'document', source, source_id: 'nokind', text_repr: 'no-kind hint' },
    f32(0.5), [{ alias: 'NoKind Inc', alias_type: 'name', role: 'mentioned' }],
  );
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.suggested_name === 'NoKind Inc'), false);
});

test('proposed entities (#119): a matching hint links and ignores suggested_kind (no proposal)', () => {
  const eid = Number(insertEntityStmt.run('org', 'Existing Org', '{}').lastInsertRowid);
  insertAliasStmt.run(eid, 'existing org', 'name'); // normalized name alias
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'document', source, source_id: 'match', text_repr: 'doc mentioning existing org' },
    f32(0.5), orgHint('Existing Org'),
  );
  assert.ok(getArtifactById(id).links.some((l) => l.entity_id === eid), 'linked to the existing entity');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.suggested_name === 'Existing Org'), false);
});

test('proposed entities (#119): approve creates the entity and retroactively links the staged artifact', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'document', source, source_id: 'receipt-2', text_repr: 'BetaCorp invoice' },
    f32(0.5), orgHint('BetaCorp'),
  );
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'BetaCorp');
  const { entity_id } = approveProposedEntity(p.id);
  assert.ok(entity_id > 0);
  assert.equal(getEntity(entity_id).kind, 'org', 'created as an org');
  assert.ok(getArtifactById(id).links.some((l) => l.entity_id === entity_id), 'staged artifact linked on approve');
  const approved = listProposedEntities('approved', 1000).find((x) => x.id === p.id);
  assert.ok(approved && approved.resolved_entity_id === entity_id, 'proposal marked approved + resolved');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === p.id), false, 'no longer pending');
});

test('proposed entities (#119): re-ingesting the same artifact stages no duplicate proposal', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'gamma', text_repr: 'GammaLLC one' }, f32(0.50), orgHint('GammaLLC'));
  const after1 = listProposedEntities('pending', 1000).filter((x) => x.suggested_name === 'GammaLLC').length;
  upsertArtifactTxn({ type: 'document', source, source_id: 'gamma', text_repr: 'GammaLLC two' }, f32(0.51), orgHint('GammaLLC'));
  const after2 = listProposedEntities('pending', 1000).filter((x) => x.suggested_name === 'GammaLLC').length;
  assert.equal(after1, 1);
  assert.equal(after2, 1, 're-ingest is idempotent — no duplicate proposal');
});

test('proposed entities (#119): reject retains the proposal (rejected) and mints nothing', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'spam', text_repr: 'SpamCo ad' }, f32(0.5), orgHint('SpamCo'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'SpamCo');
  rejectProposedEntity(p.id);
  assert.equal(resolveEntityIds('SpamCo').length, 0, 'no entity minted on reject');
  assert.ok(listProposedEntities('rejected', 1000).some((x) => x.id === p.id), 'proposal retained as rejected');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === p.id), false, 'not in the pending queue');
});

test('proposed entities (#119): approve is not repeatable (already-resolved throws)', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn({ type: 'document', source, source_id: 'dupapprove', text_repr: 'DeltaCo bill' }, f32(0.5), orgHint('DeltaCo'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'DeltaCo');
  approveProposedEntity(p.id);
  assert.throws(() => approveProposedEntity(p.id), /already approved/);
  assert.throws(() => rejectProposedEntity(p.id), /already approved/, 'cannot reject an approved proposal');
  assert.ok(id > 0);
});

// --- #413: identity by NAME, not just the staged alias, on approval ---
test('proposed entities (#413): approving a proposal whose suggested_name resolves to ONE live entity attaches, not mints', () => {
  const existing = Number(insertEntityStmt.run('org', 'Attach Target Co', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'attach target co', 'name');
  const source = uniqueSource();
  const { id: artifactId } = upsertArtifactTxn({ type: 'document', source, source_id: 'attach-1', text_repr: 'Attach Target Co invoice' }, f32(0.5), orgHint('Attach Target Co'));
  // The staged alias itself does not yet resolve (simulates #409's backfill not having indexed it) —
  // proposeEntity's own precedence would otherwise attach via resolveEntityHints before staging, so
  // stage this proposal directly rather than through the ingest hint path.
  const beforeEntities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const prop = proposeEntity({ suggested_kind: 'org', name: 'Attach Target Co', alias: 'attach-target@example.test', alias_type: 'email', artifact_id: artifactId, source: 'test' });
  const { entity_id } = approveProposedEntity(prop.id);
  assert.equal(entity_id, existing, 'attached to the existing entity, not a new one');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, beforeEntities, '0 new entities created');
  assert.ok(resolveEntityIds('attach-target@example.test').includes(existing), 'the staged alias was attached to the existing entity');
  assert.ok(getArtifactById(artifactId).links.some((l) => l.entity_id === existing), 'the originating artifact is linked');
});

test('proposed entities (#413): resolveHandle can never report >1 owner for one name — UNIQUE(alias, alias_type) makes the mint path\'s ">1 stays unresolved" branch structurally unreachable, not merely untested', () => {
  // approveProposedEntity's name-check guards `resolveHandle(...).length === 1` before attaching,
  // mirroring promoteDirectoryName's identical ">1 candidates stays unresolved" defensive posture
  // (data-model.md). Two entities literally cannot both hold `('ambiguous twin','name')` — the
  // second insert is silently ignored (first-writer-wins) — so a real >1 case can't be constructed
  // to exercise that branch; this test documents why, rather than forcing an impossible DB state.
  const a = Number(insertEntityStmt.run('person', 'Ambiguous Twin', null).lastInsertRowid);
  insertAliasStmt.run(a, 'ambiguous twin', 'name');
  const b = Number(insertEntityStmt.run('person', 'Ambiguous Twin', null).lastInsertRowid);
  const secondInsertIgnored = insertAliasStmt.run(b, 'ambiguous twin', 'name');
  assert.equal(secondInsertIgnored.changes, 0, 'the second insert was ignored, not applied');
  assert.equal(resolveHandle('Ambiguous Twin', 'name').length, 1, 'still exactly one owner — the second insert was ignored, not a collision');
  assert.equal(resolveHandle('Ambiguous Twin', 'name')[0], a, 'first writer wins, per data-model.md');
});

test('proposed entities (#413): a proposal whose name resolves to NO live entity still mints (unchanged)', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'nomatch-1', text_repr: 'Nobody Yet Inc bill' }, f32(0.5), orgHint('Nobody Yet Inc'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'Nobody Yet Inc');
  const beforeEntities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const { entity_id } = approveProposedEntity(p.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, beforeEntities + 1, 'exactly one new entity');
  assert.ok(entity_id > 0);
});

test('proposed entities (#413): a person/org proposal whose name matches a live PLACE entity still mints its own — never attaches across kinds', () => {
  const place = Number(insertEntityStmt.run('place', 'Harbor Point', null).lastInsertRowid);
  insertAliasStmt.run(place, 'harbor point', 'name');
  const prop = proposeEntity({ suggested_kind: 'org', name: 'Harbor Point', alias: 'harbor-point@example.test', alias_type: 'email', source: 'test' });
  const beforeEntities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const { entity_id } = approveProposedEntity(prop.id);
  assert.notEqual(entity_id, place, 'a same-named PLACE is never a valid attach target for a person/org proposal');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, beforeEntities + 1, 'mints its own org, does not attach to the place');
  assert.equal(getEntity(entity_id).kind, 'org');
});

test('proposed entities (#413): an alias already owned by a live entity still attaches via the alias check (unchanged, first rung)', () => {
  const existing = Number(insertEntityStmt.run('org', 'Alias Owner Co', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'alias-owner@example.test', 'email');
  const prop = proposeEntity({ suggested_kind: 'org', name: 'Some Other Name', alias: 'alias-owner@example.test', alias_type: 'email', source: 'test' });
  const beforeEntities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const { entity_id } = approveProposedEntity(prop.id);
  assert.equal(entity_id, existing, 'the alias-owner check still wins even though suggested_name does not match');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, beforeEntities, '0 new entities');
});

test('proposed entities (#413, regression): the alias-owner rung must NOT heal a name-keyed proposal for someone else', () => {
  // The alias-owner rung resolves entityId from the STAGED HANDLE, not from suggested_name — a
  // shared family landline/email can mean entityId is a completely different person than
  // suggested_name names (data-model.md's own "shared family landline" caution). All six review
  // personas flagged the original heal loop (keyed on suggested_name's own nameVariants) as capable
  // of silently, terminally resolving an unrelated person's queue row onto this entity.
  const shared = Number(insertEntityStmt.run('org', 'Shared Handle Co', null).lastInsertRowid);
  insertAliasStmt.run(shared, 'shared-handle@example.test', 'email');
  const otherPerson = Number(insertEntityStmt.run('person', 'Some Other Name', null).lastInsertRowid);
  insertAliasStmt.run(otherPerson, 'some other name', 'name');
  const otherPending = proposeEntity({ suggested_kind: 'person', name: 'Some Other Name', alias: 'some-other-unrelated-alias', alias_type: 'phone', source: 'test' });

  const prop = proposeEntity({ suggested_kind: 'org', name: 'Some Other Name', alias: 'shared-handle@example.test', alias_type: 'email', source: 'test' });
  const { entity_id } = approveProposedEntity(prop.id);
  assert.equal(entity_id, shared, 'attached to the alias owner, not a mint');

  const untouched = db.prepare('SELECT status, resolved_entity_id FROM proposed_entities WHERE id = ?').get(otherPending.id);
  assert.equal(untouched.status, 'pending', 'Some Other Name\'s OWN proposal must stay pending — Shared Handle Co does not own the name "some other name"');
  assert.equal(untouched.resolved_entity_id, null);
});

test('proposed entities (#413, regression): the mint rung must NOT heal a variant lost to another live entity or tombstoned', () => {
  // A 3-token mint seeds BOTH the full name and the given+family reduction (nameVariants) — but a
  // reduction can already be owned by someone else (INSERT OR IGNORE loses the race) or have been
  // explicitly tombstoned (#111) on the very entity being minted here. Either way, the newly minted
  // entity does NOT actually own that variant, so a proposal keyed on it must not heal to it.
  // nameVariants' given+family reduction for a 3-token name is (first token) + (LAST token) — the
  // middle token is what gets dropped. So "Race Middle Winner" reduces to "race winner".
  const raceWinner = Number(insertEntityStmt.run('person', 'Race Winner', null).lastInsertRowid);
  insertAliasStmt.run(raceWinner, 'race winner', 'name');
  const raceWinnersPending = proposeEntity({ suggested_kind: 'person', name: 'Race Winner', alias: 'race-winner-unrelated@example.test', alias_type: 'email', source: 'test' });

  const mintProp = proposeEntity({ suggested_kind: 'person', name: 'Race Middle Winner', alias: 'race middle winner', alias_type: 'name', source: 'test' });
  const { entity_id: minted } = approveProposedEntity(mintProp.id);
  assert.notEqual(minted, raceWinner, 'a fresh mint — no live entity answered to the full 3-token name');

  const stillPending = db.prepare('SELECT status FROM proposed_entities WHERE id = ?').get(raceWinnersPending.id);
  assert.equal(stillPending.status, 'pending', 'Race Winner\'s own proposal is untouched — the minted entity never actually acquired that variant');
});

test('proposed entities (#413): approving heals another OPEN proposal keyed on a different NAME VARIANT of the same person', () => {
  // A 3-token name derives a given+family reduction too (nameVariants), so a proposal keyed on the
  // full name and one keyed on the reduced form describe the same person under two distinct
  // (alias, alias_type='name') rows — exactly the "she was staged twice under two spellings" shape.
  const first = proposeEntity({ suggested_kind: 'person', name: 'Anna Marie Fields', alias: 'anna marie fields', alias_type: 'name', source: 'test' });
  const stale = proposeEntity({ suggested_kind: 'person', name: 'Anna Fields', alias: 'anna fields', alias_type: 'name', source: 'photo-exif-pictured-backfill' });
  const { entity_id } = approveProposedEntity(first.id);
  assert.ok(entity_id > 0, 'the first proposal mints — no live entity answered to this name yet');
  const healed = db.prepare('SELECT status, resolved_entity_id FROM proposed_entities WHERE id = ?').get(stale.id);
  assert.equal(healed.status, 'approved', 'the stale reduced-name proposal was healed, not left stale');
  assert.equal(healed.resolved_entity_id, entity_id);
});

test('proposed entities reopen (#300): rejected → pending, reappears in the pending queue', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'reopen-1', text_repr: 'ReopenCo notice' }, f32(0.5), orgHint('ReopenCo'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'ReopenCo');
  rejectProposedEntity(p.id);
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === p.id), false, 'gone from pending after reject');
  const { reopened } = reopenProposedEntity(p.id);
  assert.equal(reopened, true);
  assert.ok(listProposedEntities('pending', 1000).some((x) => x.id === p.id), 'back in the pending queue');
  assert.equal(listProposedEntities('rejected', 1000).some((x) => x.id === p.id), false, 'no longer in rejected');
});

test('proposed entities reopen (#300): reopen then approve mints the entity and links staged hints', () => {
  const source = uniqueSource();
  const { id: artifactId } = upsertArtifactTxn({ type: 'document', source, source_id: 'reopen-2', text_repr: 'ReopenApprove Inc bill' }, f32(0.5), orgHint('ReopenApprove Inc'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'ReopenApprove Inc');
  rejectProposedEntity(p.id);
  reopenProposedEntity(p.id);
  const { entity_id } = approveProposedEntity(p.id);
  assert.ok(entity_id > 0);
  assert.ok(getArtifactById(artifactId).links.some((l) => l.entity_id === entity_id), 'staged artifact linked after reopen+approve');
});

test('proposed entities reopen (#300): ALREADY_RESOLVED for a pending proposal and for an approved proposal', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'reopen-3', text_repr: 'StillPending Co' }, f32(0.5), orgHint('StillPending Co'));
  const pending = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'StillPending Co');
  assert.throws(() => reopenProposedEntity(pending.id), (err) => err.code === 'ALREADY_RESOLVED', 'reopening a pending proposal is refused');

  upsertArtifactTxn({ type: 'document', source, source_id: 'reopen-4', text_repr: 'AlreadyApproved Co' }, f32(0.5), orgHint('AlreadyApproved Co'));
  const approvable = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'AlreadyApproved Co');
  approveProposedEntity(approvable.id);
  assert.throws(() => reopenProposedEntity(approvable.id), (err) => err.code === 'ALREADY_RESOLVED', 'reopening an approved proposal is refused — the minted entity lives on');
});

test('proposed entities reopen (#300): NOT_FOUND for a bogus id', () => {
  assert.throws(() => reopenProposedEntity(999999999), (err) => err.code === 'NOT_FOUND');
});

test('proposed entities reopen (#300): logs proposed_entity_reopened with from:"rejected"', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'reopen-5', text_repr: 'LoggedReopen Co' }, f32(0.5), orgHint('LoggedReopen Co'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'LoggedReopen Co');
  rejectProposedEntity(p.id);
  reopenProposedEntity(p.id);
  const row = db.prepare(`SELECT details FROM ingest_log WHERE event_type = 'proposed_entity_reopened' AND json_extract(details, '$.proposal_id') = ? ORDER BY id DESC LIMIT 1`).get(p.id);
  assert.ok(row, 'a proposed_entity_reopened row was logged');
  assert.equal(JSON.parse(row.details).from, 'rejected');
});

test('proposed entities reopen (#300): a reopened row keeps its UNIQUE slot — re-staging still reports created:false', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'reopen-6', text_repr: 'SameSlot Co' }, f32(0.5), orgHint('SameSlot Co'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'SameSlot Co');
  rejectProposedEntity(p.id);
  reopenProposedEntity(p.id);
  const restaged = proposeEntity({ suggested_kind: 'org', name: p.suggested_name, alias: p.alias, alias_type: p.alias_type });
  assert.equal(restaged.id, p.id, 'same row, not a duplicate');
  assert.equal(restaged.created, false);
});

// --- evidence_count (#472): how many staged artifacts back a proposal's (alias, alias_type) ---
test('proposed entities (#472): evidence_count reflects distinct unresolved_aliases artifacts, deduped', () => {
  const s1 = uniqueSource(), s2 = uniqueSource();
  upsertArtifactTxn({ type: 'document', source: s1, source_id: 'ev-1', text_repr: 'EvidenceCo invoice one' }, f32(0.5), orgHint('EvidenceCo'));
  upsertArtifactTxn({ type: 'document', source: s2, source_id: 'ev-2', text_repr: 'EvidenceCo invoice two' }, f32(0.5), orgHint('EvidenceCo'));
  // A duplicate hint on the same artifact must not double-count (unresolved_aliases' UNIQUE key).
  upsertArtifactTxn({ type: 'document', source: s1, source_id: 'ev-1', text_repr: 'EvidenceCo invoice one (rewrite)' }, f32(0.5), orgHint('EvidenceCo'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'EvidenceCo');
  assert.equal(p.evidence_count, 2, 'two distinct artifacts staged the hint');
});

test('proposed entities (#472): an externally-staged proposal (no unresolved_aliases row) reports evidence_count 0', () => {
  const prop = proposeEntity({ suggested_kind: 'org', name: 'ExternalOnly Co', alias: 'externalonly co', alias_type: 'name', source: 'mcp' });
  const p = listProposedEntities('pending', 1000).find((x) => x.id === prop.id);
  assert.equal(p.evidence_count, 0, 'never null/undefined');
});

test('proposed entities (#472): evidence_count survives a reject — a rejected row still carries its count', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'ev-reject', text_repr: 'RejectedEvidence Co invoice' }, f32(0.5), orgHint('RejectedEvidence Co'));
  const pending = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'RejectedEvidence Co');
  assert.equal(pending.evidence_count, 1);
  rejectProposedEntity(pending.id);
  const rejected = listProposedEntities('rejected', 1000).find((x) => x.id === pending.id);
  assert.equal(rejected.evidence_count, 1, 'evidence_count is unaffected by status');
});

test('proposed entities (#472): evidence_count does not cross alias_type boundaries', () => {
  const source = uniqueSource();
  const sharedText = '5551239999';
  upsertArtifactTxn(
    { type: 'document', source, source_id: 'ev-type-1', text_repr: 'a phone number mentioned' },
    f32(0.5), [{ alias: sharedText, alias_type: 'phone', role: 'mentioned', suggested_kind: 'person' }],
  );
  upsertArtifactTxn(
    { type: 'document', source, source_id: 'ev-type-2', text_repr: 'a name mentioned' },
    f32(0.5), [{ alias: sharedText, alias_type: 'name', role: 'mentioned', suggested_kind: 'person' }],
  );
  upsertArtifactTxn(
    { type: 'document', source, source_id: 'ev-type-3', text_repr: 'the same name again' },
    f32(0.5), [{ alias: sharedText, alias_type: 'name', role: 'mentioned', suggested_kind: 'person' }],
  );
  const phoneProp = listProposedEntities('pending', 1000).find((x) => x.alias === sharedText && x.alias_type === 'phone');
  const nameProp = listProposedEntities('pending', 1000).find((x) => x.alias === sharedText && x.alias_type === 'name');
  assert.equal(phoneProp.evidence_count, 1, 'phone-type proposal only counts phone-type hints');
  assert.equal(nameProp.evidence_count, 2, 'name-type proposal only counts name-type hints, not the phone one');
});

test('proposed entities (#413): a tombstoned staged alias is not resurrected by the attach path, but the proposal still resolves', () => {
  const existing = Number(insertEntityStmt.run('person', 'Tombstone Case', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'tombstone case', 'name');
  insertAliasStmt.run(existing, 'tombstone-removed@example.test', 'email');
  removeAlias(existing, 'tombstone-removed@example.test', 'email');
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Tombstone Case', alias: 'tombstone-removed@example.test', alias_type: 'email', source: 'test' });
  const { entity_id } = approveProposedEntity(prop.id);
  assert.equal(entity_id, existing, 'still resolves to the existing entity');
  assert.ok(!resolveEntityIds('tombstone-removed@example.test').includes(existing), 'the removed alias is NOT resurrected by attaching');
});

test('heal-name-proposals CLI parseArgs (#413): fails fast on an unrecognized flag rather than silently running for real', () => {
  assert.deepEqual(parseHealNameProposalsArgs([]), { dryRun: false });
  assert.deepEqual(parseHealNameProposalsArgs(['--dry-run']), { dryRun: true });
  assert.throws(() => parseHealNameProposalsArgs(['--dryrun']), /unknown argument/, 'a typo must not silently fall through to a real, terminal write');
  assert.throws(() => parseHealNameProposalsArgs(['--limit', '5']), /unknown argument/, 'this script has no --limit flag');
});

// --- #413: npm run heal:name-proposals — one-shot heal for stale pre-fix name-keyed proposals ---
test('healNameProposals (#413): resolves a pending name-keyed proposal whose name now resolves to exactly one live entity', () => {
  const existing = Number(insertEntityStmt.run('person', 'Healable Person', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'healable person', 'name');
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Healable Person', alias: 'healable person', alias_type: 'name', source: 'photo-exif-pictured-backfill' });
  const s = healNameProposals();
  assert.ok(s.resolved >= 1, 'resolved at least this proposal (the shared test DB may carry other pending name proposals too)');
  const row = db.prepare('SELECT status, resolved_entity_id FROM proposed_entities WHERE id = ?').get(prop.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.resolved_entity_id, existing);
});

test('healNameProposals (#413): skips a name with no live match, leaves it pending, and is idempotent', () => {
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Unhealable Person', alias: 'unhealable person', alias_type: 'name', source: 'photo-exif-pictured-backfill' });
  const s = healNameProposals();
  assert.ok(s.skippedNoMatch >= 1);
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === prop.id), true, 'left pending — no live entity to resolve to');
  const again = healNameProposals();
  assert.equal(again.resolved, 0, 'idempotent — nothing left to heal on a second run');
});

test('healNameProposals (#413): a pending PLACE proposal is never resolved to a same-named person/org entity', () => {
  const person = Number(insertEntityStmt.run('person', 'Willowbrook', null).lastInsertRowid);
  insertAliasStmt.run(person, 'willowbrook', 'name');
  const placeProp = proposeEntity({ suggested_kind: 'place', name: 'Willowbrook', alias: 'willowbrook', alias_type: 'name', attrs_json: { latitude: 1, longitude: 2, radius_km: 3 } });
  healNameProposals();
  const row = db.prepare('SELECT status FROM proposed_entities WHERE id = ?').get(placeProp.id);
  assert.equal(row.status, 'pending', 'left untouched — a name-keyed place proposal must keep its own mint semantics (#137/#138)');
});

test('healNameProposals (#413, regression — Copilot review PR #480): a PERSON-suggested proposal must not resolve to a same-named live PLACE entity', () => {
  // The WHERE clause restricts the PROPOSAL's suggested_kind to person/org, but a name alias carries
  // no kind of its own — a place entity can hold the exact ('somename','name') row a person proposal
  // is keyed on, so the MATCHED entity's kind must be checked too, not just the proposal's.
  const place = Number(insertEntityStmt.run('place', 'Fernbrook', null).lastInsertRowid);
  insertAliasStmt.run(place, 'fernbrook', 'name');
  const personProp = proposeEntity({ suggested_kind: 'person', name: 'Fernbrook', alias: 'fernbrook', alias_type: 'name', source: 'photo-exif-pictured-backfill' });
  healNameProposals();
  const row = db.prepare('SELECT status FROM proposed_entities WHERE id = ?').get(personProp.id);
  assert.equal(row.status, 'pending', 'left untouched — a same-named PLACE is never a valid resolution target for a person/org proposal');
});

test('healNameProposals (#413): dry-run and a no-op second run write no ingest_log row; a real resolving run writes exactly one', () => {
  const countHealLog = () => db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'name_proposals_healed'").get().n;
  const existing = Number(insertEntityStmt.run('person', 'Logged Heal Person', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'logged heal person', 'name');
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Logged Heal Person', alias: 'logged heal person', alias_type: 'name', source: 'photo-exif-pictured-backfill' });
  const before = countHealLog();
  healNameProposals({ dryRun: true });
  assert.equal(countHealLog(), before, 'dry-run writes no ingest_log row');
  healNameProposals();
  assert.equal(countHealLog(), before + 1, 'exactly one log row for the real resolving run');
  healNameProposals();
  assert.equal(countHealLog(), before + 1, 'a second, no-op run (resolved 0) writes no additional row');
});

test('healNameProposals (#413): --dry-run resolves nothing', () => {
  const existing = Number(insertEntityStmt.run('person', 'Dry Run Person', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'dry run person', 'name');
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Dry Run Person', alias: 'dry run person', alias_type: 'name', source: 'photo-exif-pictured-backfill' });
  const s = healNameProposals({ dryRun: true });
  assert.equal(s.resolved, 1, 'reports what it WOULD resolve');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === prop.id), true, 'still pending — dry-run wrote nothing');
  const real = healNameProposals();
  assert.equal(real.resolved, 1, 'the real run still resolves it — dry-run left no partial state');
});

// --- #484: heal:name-proposals widened to alias_type IN ('name','email','phone') ---
test('healNameProposals (#484): an EMAIL-keyed pending proposal whose alias is owned by exactly one live person resolves to that entity, minting nothing', () => {
  const existing = Number(insertEntityStmt.run('person', 'Karen Email Case', null).lastInsertRowid);
  insertAliasStmt.run(existing, 'karen.emailcase@example.test', 'email');
  const before = listEntities().length;
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Karen Email Case', alias: 'karen.emailcase@example.test', alias_type: 'email', source: 'test' });
  const s = healNameProposals();
  assert.ok(s.resolved >= 1);
  assert.equal(s.byType.email >= 1, true, 'scanned at least one email-keyed row');
  const row = db.prepare('SELECT status, resolved_entity_id FROM proposed_entities WHERE id = ?').get(prop.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.resolved_entity_id, existing);
  assert.equal(listEntities().length, before, 'no new entity minted');
});

test('healNameProposals (#484): a PHONE-keyed pending proposal whose alias is owned by exactly one live person resolves to that entity', () => {
  const existing = Number(insertEntityStmt.run('person', 'Phone Case', null).lastInsertRowid);
  insertAliasStmt.run(existing, '9195557600', 'phone');
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Phone Case', alias: '9195557600', alias_type: 'phone', source: 'test' });
  const s = healNameProposals();
  assert.ok(s.resolved >= 1);
  assert.equal(s.byType.phone >= 1, true, 'scanned at least one phone-keyed row');
  const row = db.prepare('SELECT status, resolved_entity_id FROM proposed_entities WHERE id = ?').get(prop.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.resolved_entity_id, existing);
});

test('healNameProposals (#484): an EMAIL-keyed proposal whose alias has NO live owner stays pending (the #1987 shape)', () => {
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Nobody Owns This', alias: 'unowned.handle@example.test', alias_type: 'email', source: 'test' });
  const s = healNameProposals();
  assert.ok(s.skippedNoMatch >= 1);
  assert.equal(s.byType.email >= 1, true, 'the email-keyed row was actually selected by the widened WHERE clause, not merely left untouched by an unwidened one');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === prop.id), true, 'left pending — no live entity owns this email');
  const again = healNameProposals();
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === prop.id), true, 'still pending on a second run — idempotent, not a false resolve');
});

test('healNameProposals (#484): an EMAIL-keyed proposal whose alias is owned by a live PLACE is skipped by the kind-guard, not resolved', () => {
  const place = Number(insertEntityStmt.run('place', 'Place Email Case', null).lastInsertRowid);
  insertAliasStmt.run(place, 'place.emailcase@example.test', 'email');
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Place Email Case', alias: 'place.emailcase@example.test', alias_type: 'email', source: 'test' });
  const s = healNameProposals();
  assert.equal(s.byType.email >= 1, true, 'the email-keyed row was actually selected by the widened WHERE clause');
  const row = db.prepare('SELECT status FROM proposed_entities WHERE id = ?').get(prop.id);
  assert.equal(row.status, 'pending', 'a person proposal must never resolve to a same-handle PLACE entity');
});

test('healNameProposals (#484): a TOMBSTONED email alias is not resolved — the heal only reads live entity_aliases, never a removed handle', () => {
  const owner = Number(insertEntityStmt.run('person', 'Tombstoned Heal Case', null).lastInsertRowid);
  insertAliasStmt.run(owner, 'tombstoned.healcase@example.test', 'email');
  removeAlias(owner, 'tombstoned.healcase@example.test', 'email');
  const prop = proposeEntity({ suggested_kind: 'person', name: 'Tombstoned Heal Case', alias: 'tombstoned.healcase@example.test', alias_type: 'email', source: 'test' });
  const s = healNameProposals();
  assert.ok(s.skippedNoMatch >= 1);
  assert.equal(s.byType.email >= 1, true, 'the email-keyed row was actually selected by the widened WHERE clause');
  const row = db.prepare('SELECT status FROM proposed_entities WHERE id = ?').get(prop.id);
  assert.equal(row.status, 'pending', 'a removed alias must not resurrect through the heal');
});

test('healNameProposals (#484): idempotent when a genuine MIX of name/email/phone rows resolve in the same run', () => {
  const p1 = Number(insertEntityStmt.run('person', 'Mixed Heal Name', null).lastInsertRowid);
  insertAliasStmt.run(p1, 'mixed heal name', 'name');
  const p2 = Number(insertEntityStmt.run('person', 'Mixed Heal Email', null).lastInsertRowid);
  insertAliasStmt.run(p2, 'mixed.healemail@example.test', 'email');
  const p3 = Number(insertEntityStmt.run('person', 'Mixed Heal Phone', null).lastInsertRowid);
  insertAliasStmt.run(p3, '8185559400', 'phone');
  const nameProp = proposeEntity({ suggested_kind: 'person', name: 'Mixed Heal Name', alias: 'mixed heal name', alias_type: 'name', source: 'test' });
  const emailProp = proposeEntity({ suggested_kind: 'person', name: 'Mixed Heal Email', alias: 'mixed.healemail@example.test', alias_type: 'email', source: 'test' });
  const phoneProp = proposeEntity({ suggested_kind: 'person', name: 'Mixed Heal Phone', alias: '8185559400', alias_type: 'phone', source: 'test' });
  const s = healNameProposals();
  assert.equal(s.byType.name >= 1, true, 'name row present in this run');
  assert.equal(s.byType.email >= 1, true, 'email row present in this run');
  assert.equal(s.byType.phone >= 1, true, 'phone row present in this run');
  for (const prop of [nameProp, emailProp, phoneProp]) {
    const row = db.prepare('SELECT status FROM proposed_entities WHERE id = ?').get(prop.id);
    assert.equal(row.status, 'approved', `proposal ${prop.id} resolved in the mixed-type run`);
  }
  const again = healNameProposals();
  assert.equal(again.resolved, 0, 'a second run over the same mix resolves 0 — idempotent');
});

test('normalizePhone (#129): US +1 and bare 10-digit collapse to one key; non-NANP untouched', () => {
  assert.equal(normalizePhone('+1 (415) 555-0148'), '4155550148', 'US +1 with punctuation → 10-digit key');
  assert.equal(normalizePhone('1-415-555-0148'), '4155550148', 'leading 1, no + → 10-digit key');
  assert.equal(normalizePhone('(415) 555-0148'), '4155550148', 'bare 10-digit unchanged');
  assert.equal(normalizePhone('+44 20 7946 0958'), '442079460958', 'non-NANP international is NOT stripped');
  assert.equal(normalizePhone('555-0148'), '5550148', '7-digit local is unchanged (leading 1-strip does not apply)');
});

test('normalizePhone (#129): a contact aliased +1 resolves from the bare-10-digit form and vice versa', () => {
  const a = Number(insertEntityStmt.run('person', 'Plus One', null).lastInsertRowid);
  insertAliasUnlessTombstoned(a, normalizePhone('+14155550148'), 'phone'); // aliased in +1 form
  assert.ok(resolveEntityIds('(415) 555-0148').includes(a), '+1-aliased contact resolves from bare 10-digit lookup');

  const b = Number(insertEntityStmt.run('person', 'Bare Ten', null).lastInsertRowid);
  insertAliasUnlessTombstoned(b, normalizePhone('(415) 555-0130'), 'phone'); // aliased in bare form
  assert.ok(resolveEntityIds('+1 415 555 0130').includes(b), 'bare-aliased contact resolves from +1 lookup');
});

test('backfill:phones (#129): re-aliases an old +1 key under the canonical key, and flags a cross-entity collision', () => {
  // Simulate pre-change data by inserting the raw 11-digit key directly (bypassing normalizePhone).
  const solo = Number(insertEntityStmt.run('person', 'Solo Backfill', null).lastInsertRowid);
  insertAliasStmt.run(solo, '17776665555', 'phone'); // old digit-strip-only form, no competitor
  const owner = Number(insertEntityStmt.run('person', 'Canon Owner', null).lastInsertRowid);
  insertAliasStmt.run(owner, '8887776666', 'phone'); // already-canonical form
  const loser = Number(insertEntityStmt.run('person', 'Old Form Loser', null).lastInsertRowid);
  insertAliasStmt.run(loser, '18887776666', 'phone'); // same number as owner, but +1 form

  const s = backfillPhoneAliases();

  // Solo: canonical key added, now resolvable from either form.
  assert.ok(resolveEntityIds('(777) 666-5555').includes(solo), 'solo old-form number resolves under the canonical key after backfill');
  // Loser: its canonical key is owned by `owner`, so the add is suppressed and reported as a collision.
  assert.ok(
    s.collisionDetails.some((c) => c.canonical === '8887776666' && c.loser === loser && c.owner === owner),
    'the cross-entity canonical collision is surfaced in collisionDetails',
  );

  const s2 = backfillPhoneAliases(); // idempotent
  assert.equal(s2.aliasesAdded, 0, 'second run adds no new canonical aliases (every alias is now canonical)');
  assert.ok(
    s2.collisionDetails.some((c) => c.canonical === '8887776666' && c.loser === loser && c.owner === owner),
    'the collision is still reported on rerun — the loser still cannot claim the owner-held key',
  );
});

test('backfill:phones (#129): a canonical key tombstoned for this entity is NOT a false-positive collision (Copilot #131)', () => {
  // Entity T deliberately removed the canonical key (#111 tombstone) but still holds the old +1 form;
  // entity O owns the canonical key. The backfill must treat T's suppressed add as a removal, not a
  // cross-entity collision — else it would wrongly report "unreachable until merged".
  const t = Number(insertEntityStmt.run('person', 'Tomb Loser', null).lastInsertRowid);
  insertAliasStmt.run(t, '15554443333', 'phone');    // old +1 form, still on T
  addAlias(t, '5554443333', 'phone');                // T had the canonical key...
  removeAlias(t, '5554443333', 'phone');             // ...then removed it → tombstone on T, row deleted
  const owner = Number(insertEntityStmt.run('person', 'Tomb Owner', null).lastInsertRowid);
  insertAliasStmt.run(owner, '5554443333', 'phone'); // NOW O claims the canonical key (T freed it)

  const s = backfillPhoneAliases();
  assert.ok(
    !s.collisionDetails.some((c) => c.loser === t && c.canonical === '5554443333'),
    'a tombstoned canonical key is not reported as a cross-entity collision',
  );
});

test('listObservedExtensionTypes (#244): the JS isExtensionType() filter catches what GLOB alone would miss (Copilot review)', () => {
  // GLOB 'x-?*' has no repeated character-class quantifier, so it can't itself exclude
  // "x-Bad-Case" (uppercase) or "x-foo_bar" (underscore) the way isExtensionType()'s
  // /^x-[a-z0-9-]+$/ does. No current write path can produce such a row (every write goes
  // through isRegisteredType/isExtensionType), so insert directly to simulate a legacy/manual row.
  const source = uniqueSource();
  storeArtifactTxn({ type: 'x-244-conforming', source, source_id: 'ok', text_repr: 'a conforming marker' }, f32(0.11));
  storeArtifactTxn({ type: 'x-Bad-Case', source, source_id: 'bad-case', text_repr: 'an uppercase marker' }, f32(0.12));
  storeArtifactTxn({ type: 'x-foo_bar', source, source_id: 'bad-char', text_repr: 'an underscore marker' }, f32(0.13));

  const observed = listObservedExtensionTypes().map((t) => t.type);
  assert.ok(observed.includes('x-244-conforming'), 'a conforming x- type is surfaced');
  assert.ok(!observed.includes('x-Bad-Case'), 'an uppercase-prefixed row is excluded');
  assert.ok(!observed.includes('x-foo_bar'), 'an underscore-containing row is excluded');
});
