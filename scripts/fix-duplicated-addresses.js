#!/usr/bin/env node
/**
 * One-shot repair (#493): every address stored before the ADR 7-component bound in src/contacts.js
 * holds the address TWICE — the flattened component list, then the exporter's pre-formatted mailing
 * label that an unbounded join folded in as if it were an 8th component. The bad text was written
 * once by load-directory.js and then propagated into entity profiles by backfill-directory-attrs.js,
 * so it now sits in three derived places: entities.attrs_json, directory_cards.attrs_json, and the
 * searchable contact artifact's text_repr + extra_json (where it is also embedded, and therefore
 * pollutes recall).
 *
 * WHY ITS OWN SCRIPT. Neither existing path can heal this, and neither should be bent to:
 *   - `npm run directory:load` — upsertDirectoryCard is append-if-exists and keeps the STORED scalar
 *     on a differing value, logging a `conflicts` entry (data-model.md, #304). That policy is right
 *     (a newer export must never clobber an older one); carving a shape-specific exception into the
 *     general merge would be worse than this one-shot pass.
 *   - `npm run backfill:directory-attrs` — fillEntityAttrsFromCard only fills EMPTY fields.
 *
 * DETECTION is structural, not a guessed pattern: stripRedundantAddressLabel (src/contacts.js) looks
 * for a split point where the tail is, ignoring punctuation/whitespace/case, the same characters as
 * the head. One check therefore covers all stored variants (real newlines, escaped newlines, or
 * separators unfolded away). A value it does not match is left untouched, so a genuine second address
 * is never collapsed.
 *
 * SCOPE OF THE ARTIFACT ARM. Restricted to `source = 'vcard'` — src/contacts.js is the only writer of
 * the ADR flatten, and `contact` is a registered ingest type, so a connector can own a type='contact'
 * row with its own addresses. Rewriting one would exceed the defect's blast radius and would not even
 * be durable (upsertArtifactTxn's "present fields overwrite" restores it on the connector's next
 * wave). Same guard-the-known-writer reasoning as backfill:geo (#186). The entities/directory_cards
 * arms carry no provenance column, so their scan is unavoidably broader; there, the detector's own
 * conservatism is the only guard on a UI-typed value.
 *
 * This UPDATEs existing rows, which the append-only rule normally forbids. Permitted on the same
 * reasoning as the ingest upsert path (data-model.md): every field written here is DERIVED — the
 * originals (raw_path, content_hash, ingested_at) are untouched, canonical_name/aliases/relations/
 * photoFile are never read or written, and each change is recorded in ingest_log WITH ITS PRIOR VALUE,
 * which is what actually makes the exception legitimate (mirrors ingest_update's `prior`, and matters
 * most for directory_cards, whose attrs_json is the only copy — the raw vCard text is never stored).
 *
 * Every write is a COMPARE-AND-SWAP on the value that was read (`WHERE … AND <col> = ?`). The reads
 * and the embedding calls happen before the transaction (absolute rule 4), so the live service can
 * commit a profile save in that window; a blind write-back of the whole JSON blob would silently
 * discard it. A CAS miss is counted as `skipped_raced` and reported, never overwritten — the same
 * idiom as setProposalResolvedIfPendingStmt / heal-name-proposals' `skippedRaced`. Running with the
 * server stopped — so this process is the only writer — avoids the race entirely.
 *
 * Artifacts re-embed only when their text_repr actually changed (the documented rule); vec0 PK bound
 * BigInt (absolute rule 3).
 *
 * Idempotent: once repaired the detector no longer matches, so a second run repairs 0 and writes no
 * ingest_log row. --dry-run runs the identical detection and row-write path inside a transaction that
 * is always rolled back (the backfill:handle-aliases / tightenNotNull idiom). One deliberate
 * exception: a dry run fetches no embedding, so the vec0 UPDATE is the single write it does NOT
 * exercise — that is what lets a dry run work with Ollama down, at the cost of not proving the
 * BigInt vec0 bind until the real run.
 *
 * Reports counts and entity/card/artifact IDs. Addresses appear only in the app DB's ingest_log
 * (the established place for a prior value — absolute rule 7 governs logs/events.db, which this
 * script never writes to), never on stdout and never in an ops event.
 *   Run:  npm run fix:addresses [-- --dry-run]
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { db, logEvent } from '../src/db.js';
import { stripRedundantAddressLabel, suspectsRedundantAddressLabel, ADDRESS_LIST_JOIN } from '../src/contacts.js';
import { embedToFloat32 } from '../src/embeddings.js';
import { DB_PATH } from '../src/config.js';

// Exported so tests can exercise the parsing rules directly (mirrors heal-name-proposals.js). Fails
// fast on an unrecognized flag — a typo'd or dropped --dry-run must not silently fall through to a
// real write, and this script's blast radius is three derived layers PLUS the vec0 embeddings.
export function parseArgs(argv) {
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(', ')} — the only flag is --dry-run`);
  return { dryRun: argv.includes('--dry-run') };
}

const ACTOR = 'fix-duplicated-addresses.js';
// Cap the id lists that reach stdout and the ingest_log blob; the counts stay authoritative. Mirrors
// backfill-pictured-proposals' topImpact cap — an unbounded array in a JSON details column is a
// liability if the affected population is ever large.
const MAX_REPORTED_IDS = 200;
// Module scope so it is one identity for the whole process and can be named in a stack if it ever
// escapes a future refactor. Identity-compared, so nothing else can be mistaken for it.
const DRY_RUN_ROLLBACK = Symbol('fix-addresses dry-run rollback');

// The artifacts arm is index-served on `type` (idx_artifacts_type); the entities and directory_cards
// arms are small-table scans (147 / ~2,179 rows on the live store) and their leading-wildcard LIKE
// only skips a JSON.parse, it cannot use an index. All three filters are deliberate supersets of the
// affected set — JSON.stringify always emits the keys quoted, so a corrupted row can never be missed.
const selectEntitiesStmt = db.prepare(`
  SELECT id, attrs_json FROM entities
  WHERE attrs_json IS NOT NULL AND (attrs_json LIKE '%"addresses"%' OR attrs_json LIKE '%"address"%')
`);
const selectCardsStmt = db.prepare(`
  SELECT id, attrs_json FROM directory_cards
  WHERE attrs_json IS NOT NULL AND attrs_json LIKE '%"address%'
`);
const selectContactArtifactsStmt = db.prepare(`
  SELECT id, text_repr, extra_json FROM artifacts
  WHERE type = 'contact' AND source = 'vcard' AND extra_json IS NOT NULL AND extra_json LIKE '%"addresses"%'
`);
// Compare-and-swap: the trailing predicate is the value this run read, so a concurrent write in the
// read→embed→write window loses the race instead of being silently overwritten.
const updateEntityAttrsJsonStmt = db.prepare('UPDATE entities SET attrs_json = ? WHERE id = ? AND attrs_json = ?');
// CURRENT_TIMESTAMP matches src/db.js's own writer of this column. updated_at IS touched (unlike
// upsertDirectoryCard's no-op re-load, which deliberately leaves it alone) because this pass only
// ever writes a row whose content it actually changed.
const updateCardAttrsJsonStmt = db.prepare('UPDATE directory_cards SET attrs_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attrs_json = ?');
// Two statements, mirroring src/db.js's updateArtifactStmt/updateArtifactMetaStmt split: naming
// text_repr in SET fires artifacts_au (AFTER UPDATE OF text_repr) even when the value is identical,
// so an extra_json-only repair must not churn the FTS index for nothing.
const updateArtifactTextStmt = db.prepare('UPDATE artifacts SET text_repr = ?, extra_json = ? WHERE id = ? AND text_repr = ? AND extra_json = ?');
const updateArtifactExtraStmt = db.prepare('UPDATE artifacts SET extra_json = ? WHERE id = ? AND extra_json = ?');
const updateVecStmt = db.prepare('UPDATE vec_artifacts SET embedding = ? WHERE artifact_id = ?');

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Apply the detector to both address shapes an attrs object can carry. Returns the repaired object,
 * which keys changed, the prior values (for the log), and the old→new pairs the artifact text pass
 * needs — or null when nothing matched.
 */
function repairAttrsAddresses(attrs) {
  const next = { ...attrs };
  const changed = [];
  const prior = {};
  const pairs = [];
  if (Array.isArray(attrs.addresses)) {
    const fixed = attrs.addresses.map((a) => stripRedundantAddressLabel(a));
    attrs.addresses.forEach((old, i) => { if (fixed[i] !== old) pairs.push({ old, fixed: fixed[i] }); });
    if (pairs.length) {
      // De-dup after repairing: two near-identical corrupt variants of one address (a merged
      // iCloud+Google card — the case contactTextRepr's own de-dup exists for) can repair to the same
      // string, and leaving both would show a duplicate row in the UI and re-embed the address twice.
      // Only rows already being rewritten are affected, so this cannot touch an untouched profile.
      next.addresses = [...new Set(fixed)];
      prior.addresses = attrs.addresses;
      changed.push('addresses');
    }
  }
  if (typeof attrs.address === 'string') {
    const fixed = stripRedundantAddressLabel(attrs.address);
    if (fixed !== attrs.address) { next.address = fixed; prior.address = attrs.address; changed.push('address'); }
  }
  return changed.length ? { next, changed, prior, pairs } : null;
}

/**
 * The artifact's embedded prose is repaired by replacing each corrupted address with its repaired form
 * verbatim, rather than regenerating text_repr: extra_json holds only structuredFields (no
 * fn/title/org/note), so contactTextRepr cannot be re-run from it. Each old value is a long, highly
 * distinctive string, so a literal whole-string replacement is unambiguous. split/join, not
 * replaceAll — replaceAll applies $-substitution to the replacement, which here is user data.
 */
function repairArtifact(row) {
  const extra = safeJson(row.extra_json);
  if (!extra) return { unparseable: true };
  if (!Array.isArray(extra.addresses)) return null;
  const repaired = repairAttrsAddresses(extra);
  if (!repaired) return null;
  const before = row.text_repr ?? '';
  let text = before;
  let textUnrepaired = false;
  for (const { old, fixed } of repaired.pairs) {
    if (!old) continue;
    if (text.includes(old)) text = text.split(old).join(fixed);
    else textUnrepaired = true;   // the prose never held this value — reported, never silent
  }
  // If two corrupt variants repaired to one string, the prose now lists it twice; collapse that too,
  // or the repair would leave behind a milder form of the duplication it exists to remove.
  for (const fixed of new Set(repaired.pairs.map((p) => p.fixed))) {
    const doubled = `${fixed}${ADDRESS_LIST_JOIN}${fixed}`;
    while (text.includes(doubled)) text = text.split(doubled).join(fixed);
  }
  return { extra: repaired.next, prior: repaired.prior, text, textChanged: text !== before, textUnrepaired };
}

export async function fixDuplicatedAddresses({ dryRun = false } = {}) {
  const entities = [];
  const cards = [];
  const artifacts = [];
  let unparseable = 0;
  let suspect = 0;   // rows an inexact restatement leaves corrupted — reported, never auto-written

  const countSuspects = (attrs) => {
    const values = [...(Array.isArray(attrs.addresses) ? attrs.addresses : []), attrs.address];
    if (values.some((v) => suspectsRedundantAddressLabel(v))) suspect++;
  };

  // A row whose JSON does not parse is skipped — but never silently: it would otherwise stay corrupt
  // while the operator is told "0 repaired", which is the failure shape this repo keeps re-learning.
  const noteUnparseable = (table, id) => { unparseable++; console.error(`skipped ${table} id=${id}: attrs_json/extra_json did not parse`); };

  for (const row of selectEntitiesStmt.all()) {
    const attrs = safeJson(row.attrs_json);
    if (!attrs) { noteUnparseable('entities', row.id); continue; }
    const repaired = repairAttrsAddresses(attrs);
    if (repaired) entities.push({ id: row.id, json: JSON.stringify(repaired.next), prev: row.attrs_json, changed: repaired.changed, prior: repaired.prior });
    else countSuspects(attrs);
  }
  for (const row of selectCardsStmt.all()) {
    const attrs = safeJson(row.attrs_json);
    if (!attrs) { noteUnparseable('directory_cards', row.id); continue; }
    const repaired = repairAttrsAddresses(attrs);
    if (repaired) cards.push({ id: row.id, json: JSON.stringify(repaired.next), prev: row.attrs_json, changed: repaired.changed, prior: repaired.prior });
    else countSuspects(attrs);
  }
  for (const row of selectContactArtifactsStmt.all()) {
    const repaired = repairArtifact(row);
    if (repaired?.unparseable) { noteUnparseable('artifacts', row.id); continue; }
    if (repaired) artifacts.push({ id: row.id, prevText: row.text_repr ?? '', prevExtra: row.extra_json, ...repaired });
  }

  // Enrich-then-commit (absolute rule 4): every embedding is fetched before the transaction opens, so
  // a failed Ollama call aborts the run without having written anything. Only a changed text_repr is
  // re-embedded — the documented rule, and it keeps a dry run from needing the embedder at all.
  for (const a of artifacts) {
    if (a.textChanged && !dryRun) a.vector = await embedToFloat32(a.text);
  }

  let skippedRaced = 0;
  let missingVec = 0;
  const summary = {
    entities: entities.length,
    directory_cards: cards.length,
    artifacts: artifacts.length,
    artifacts_reembedded: artifacts.filter((a) => a.textChanged).length,
    artifacts_text_unrepaired: artifacts.filter((a) => a.textUnrepaired).length,
    unparseable_skipped: unparseable,
    suspect_not_repaired: suspect,
    entity_ids: entities.map((e) => e.id).slice(0, MAX_REPORTED_IDS),
    card_ids: cards.map((c) => c.id).slice(0, MAX_REPORTED_IDS),
    artifact_ids: artifacts.map((a) => a.id).slice(0, MAX_REPORTED_IDS),
    dryRun,
  };
  if (!entities.length && !cards.length && !artifacts.length) return { ...summary, skipped_raced: 0, missing_vec: 0 };

  // One transaction for the whole repair: cross-layer atomicity, and the dry-run rollback needs one
  // enclosing transaction. Measured far cheaper than per-row commits at this population, and every
  // read/embed already happened outside it, so the write-lock hold is milliseconds.
  const run = db.transaction(() => {
    for (const e of entities) {
      if (!updateEntityAttrsJsonStmt.run(e.json, e.id, e.prev).changes) { skippedRaced++; continue; }
      // entity_edited keeps a contact's profile history under one event type (fillEntityAttrsFromCard's
      // convention); `prior` is what makes a false-positive collapse auditable and reversible.
      logEvent('entity_edited', ACTOR, { entity_id: e.id, repaired: e.changed, prior: e.prior });
    }
    for (const c of cards) {
      if (!updateCardAttrsJsonStmt.run(c.json, c.id, c.prev).changes) { skippedRaced++; continue; }
      logEvent('directory_card_repaired', ACTOR, { card_id: c.id, repaired: c.changed, prior: c.prior });
    }
    for (const a of artifacts) {
      const extraJson = JSON.stringify(a.extra);
      const changes = a.textChanged
        ? updateArtifactTextStmt.run(a.text, extraJson, a.id, a.prevText, a.prevExtra).changes
        : updateArtifactExtraStmt.run(extraJson, a.id, a.prevExtra).changes;
      if (!changes) { skippedRaced++; continue; }
      if (a.vector && !updateVecStmt.run(a.vector, BigInt(a.id)).changes) missingVec++;
      logEvent('contact_artifact_repaired', ACTOR, {
        artifact_id: a.id, prior: a.prior, text_rewritten: a.textChanged, text_unrepaired: a.textUnrepaired,
      });
    }
    logEvent('duplicated_addresses_repaired', ACTOR, { ...summary, skipped_raced: skippedRaced, missing_vec: missingVec });
    if (dryRun) throw DRY_RUN_ROLLBACK;
  });
  try { run(); } catch (err) { if (err !== DRY_RUN_ROLLBACK) throw err; }
  return { ...summary, skipped_raced: skippedRaced, missing_vec: missingVec };
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  // Name the DB up front: DB_PATH defaults to the cwd-relative 'life-context.db', so running this from
  // the wrong directory would create an empty store, build the schema into it, and then report a
  // confident "0 repaired" indistinguishable from "already clean".
  console.log(`fix:addresses — ${path.resolve(DB_PATH)}`);
  const s = await fixDuplicatedAddresses({ dryRun });
  console.log(
    `${dryRun ? 'Dry run' : 'Repair complete'}: ${s.entities} entity profile(s), ${s.directory_cards} directory card(s), ` +
    `${s.artifacts} contact artifact(s) ${dryRun ? 'would be ' : ''}repaired (${s.artifacts_reembedded} re-embedded).`
  );
  if (s.entity_ids.length) console.log(`  entity ids: ${s.entity_ids.join(', ')}`);
  if (s.card_ids.length) console.log(`  card ids: ${s.card_ids.join(', ')}`);
  if (s.artifact_ids.length) console.log(`  artifact ids: ${s.artifact_ids.join(', ')}`);
  if (s.artifacts_text_unrepaired) console.log(`  WARNING: ${s.artifacts_text_unrepaired} artifact(s) had the address in extra_json but not in text_repr — extra_json repaired, prose left as-is.`);
  if (s.unparseable_skipped) console.log(`  WARNING: ${s.unparseable_skipped} row(s) skipped — JSON did not parse (see stderr for ids).`);
  if (s.suspect_not_repaired) console.log(`  NOTE: ${s.suspect_not_repaired} row(s) look like an INEXACT restatement (e.g. the label omits the country) and were left untouched — the detector only collapses an exact match. Inspect and correct these by hand.`);
  if (s.skipped_raced) console.log(`  ${s.skipped_raced} row(s) changed concurrently and were left alone — re-run to pick them up.`);
  if (s.missing_vec) console.log(`  WARNING: ${s.missing_vec} artifact(s) had no vec_artifacts row to update.`);
  if (dryRun) console.log('Nothing was written (the vector rewrite is the one path a dry run never exercises). Re-run without --dry-run to apply.');
  db.close();
}

// Run only as a CLI, not when imported for tests. The main().catch wrapper matches src/contacts.js and
// src/consolidate.js — a bare top-level await would print a raw rejection with no context line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Address repair failed:', err); process.exit(1); });
}
