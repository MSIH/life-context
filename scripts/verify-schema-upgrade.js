#!/usr/bin/env node
/**
 * `npm run verify:schema-upgrade [-- <base-ref>]` — prove a src/db.js schema change is safe on a DB
 * that already exists (issue #318).
 *
 * The test suite always starts from an EMPTY DB, so it exercises the `CREATE TABLE IF NOT EXISTS`
 * path and never the upgrade path: a guarded `ALTER` that silently does nothing, or a migration that
 * re-runs on every boot, passes every test. #304's `contact_directory.card_id` reached PR review that
 * way — fresh-DB green, while the real upgrade linked nothing. On the live DB (~1 GB, append-only,
 * irreplaceable) that distinction is the whole ballgame.
 *
 * What it does: builds a DB with the code at <base-ref> (default `main`) in a throwaway git worktree,
 * seeds a few rows through THAT code, then opens the same file with the WORKING TREE's code so its
 * migrations run — and asserts the things a migration must never get wrong:
 *
 *   1. the new code opens the old DB at all (no throw);
 *   2. nothing was dropped — every table, column and index the old schema had still exists;
 *   3. nothing was deleted — every pre-existing table's row count is unchanged (ingest_log may only
 *      GROW, by the migration's own log rows);
 *   4. old rows are still readable BY VALUE, not just counted;
 *   5. `integrity_check` is ok and `foreign_key_check` is empty (a new FK column pointed at a
 *      missing parent shows up here);
 *   6. the migration is IDEMPOTENT — a second open logs zero further `schema_migration` rows;
 *   7. and it prints the diff (added tables/columns/indexes + migrations logged), so a reviewer can
 *      see what the upgrade actually did instead of trusting that it did something.
 *
 * Safety: this script only ever writes to a temp DB. `.env` sets DB_PATH, and dotenv does not
 * override an explicit process.env value — but a future switch to override-by-default would silently
 * aim these migrations at the live DB, so the live file's size+mtime are captured before the
 * subprocesses run and asserted unchanged after. Read-only snapshots happen in THIS process.
 *
 * Exit 0 = every assertion passed; exit 1 = at least one failed (each printed with FAIL).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseRef = process.argv[2] || 'main';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
const git = (...args) => run('git', args, { cwd: repoRoot }).trim();

// A read-only snapshot of everything a migration could plausibly break. Taken in-process (this file
// resolves better-sqlite3 from the repo's node_modules) — sqlite-vec must be loaded or any pragma
// touching the vec0 virtual table fails with "no such module: vec0".
function snapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  try {
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const tables = objects.filter((o) => o.type === 'table').map((o) => o.name);
    const columns = {}, counts = {};
    for (const t of tables) {
      columns[t] = db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map((c) => c.name).sort();
      try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(t)}`).get().n; }
      catch (err) { counts[t] = `uncountable: ${err.message}`; } // a shadow/virtual table may refuse
    }
    return {
      objects: objects.map((o) => `${o.type}:${o.name}`).sort(),
      columns,
      counts,
      migrations: db.prepare("SELECT details FROM ingest_log WHERE event_type = 'schema_migration' ORDER BY id").all().map((r) => r.details),
      integrity: db.pragma('integrity_check'),
      foreignKeys: db.pragma('foreign_key_check'),
      probe: db.prepare("SELECT canonical_name FROM entities WHERE canonical_name = 'Upgrade Probe Person'").get() ?? null,
      probeArtifact: db.prepare("SELECT text_repr FROM artifacts WHERE source = 'schema-upgrade-probe'").get() ?? null,
    };
  } finally { db.close(); }
}

// Seeded through the OLD code so the rows are exactly what that schema produces. Raw SQL on
// long-standing tables (not the old code's exports, whose signatures drift across refs); each insert
// is independent so a ref predating one table doesn't abort the rest.
const SEED = `
const { db } = await import('./src/db.js');
const tryRun = (label, sql, ...args) => { try { db.prepare(sql).run(...args); } catch (err) { console.error('seed skipped (' + label + '): ' + err.message); } };
tryRun('entity', "INSERT INTO entities (kind, canonical_name, attrs_json) VALUES ('person', 'Upgrade Probe Person', '{}')");
const eid = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Upgrade Probe Person'").get()?.id;
if (eid) tryRun('alias', "INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, 'upgrade probe person', 'name')", eid);
tryRun('artifact', "INSERT INTO artifacts (type, source, source_id, text_repr) VALUES ('note', 'schema-upgrade-probe', 'probe-1', 'a row written by the OLD code')");
tryRun('directory', "INSERT OR IGNORE INTO contact_directory (name, handle, handle_type) VALUES ('Upgrade Probe Person', '5550001234', 'phone')");
db.close();
`;
const OPEN_ONLY = `const { db } = await import('./src/db.js'); db.close();`;

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const tmpBase = mkdtempSync(join(tmpdir(), 'lc-schema-upgrade-'));
const oldTree = join(tmpBase, 'base');
const dbPath = join(tmpBase, 'upgrade.db');
// Guard: the live DB must be byte-identical afterwards (see header).
const liveDb = join(repoRoot, 'life-context.db');
const liveBefore = existsSync(liveDb) ? statSync(liveDb) : null;

console.log(`verify:schema-upgrade — base ref ${baseRef} (${git('rev-parse', '--short', baseRef)}) vs working tree`);
console.log(`  scratch: ${tmpBase}`);

try {
  git('worktree', 'add', '--detach', oldTree, baseRef);
  // The base worktree has no node_modules of its own; a junction works on Windows without admin
  // rights and lets the old src/db.js resolve better-sqlite3/sqlite-vec.
  symlinkSync(join(repoRoot, 'node_modules'), join(oldTree, 'node_modules'), 'junction');

  const env = { ...process.env, DB_PATH: dbPath };
  run(process.execPath, ['--input-type=module', '-e', SEED], { cwd: oldTree, env });
  const before = snapshot(dbPath);
  check(before.objects.length > 0, 'base ref produced a schema', `${before.objects.length} objects`);
  check(before.probe !== null, 'seed row written by the OLD code');

  let opened = true;
  try { run(process.execPath, ['--input-type=module', '-e', OPEN_ONLY], { cwd: repoRoot, env }); }
  catch (err) { opened = false; check(false, 'working-tree code opens the old DB', (err.stderr || err.message).split('\n').slice(0, 4).join(' | ')); }
  if (!opened) throw new Error('working-tree code could not open a DB created by the base ref — nothing further is meaningful');
  check(true, 'working-tree code opens the old DB');
  const after = snapshot(dbPath);

  // 2 — nothing dropped
  const missingObjects = before.objects.filter((o) => !after.objects.includes(o));
  check(missingObjects.length === 0, 'no table/index/trigger was dropped', missingObjects.join(', ') || 'none missing');
  const droppedCols = [];
  for (const [t, cols] of Object.entries(before.columns)) {
    for (const c of cols) if (!(after.columns[t] ?? []).includes(c)) droppedCols.push(`${t}.${c}`);
  }
  check(droppedCols.length === 0, 'no column was dropped', droppedCols.join(', ') || 'none missing');

  // 3 — nothing deleted (ingest_log may only grow, by the migration's own rows)
  const countDrift = [];
  for (const [t, n] of Object.entries(before.counts)) {
    const now = after.counts[t];
    if (typeof n !== 'number' || typeof now !== 'number') continue;
    if (t === 'ingest_log' ? now < n : now !== n) countDrift.push(`${t}: ${n} -> ${now}`);
  }
  check(countDrift.length === 0, 'no pre-existing row was deleted', countDrift.join(', ') || 'all counts held');

  // 4 — old rows still readable by value
  check(after.probe?.canonical_name === 'Upgrade Probe Person', 'an entity written by the old code is still readable');
  check(after.probeArtifact?.text_repr === 'a row written by the OLD code', 'an artifact written by the old code is still readable');

  // 5 — SQLite's own verdict
  const integrityOk = after.integrity.length === 1 && after.integrity[0].integrity_check === 'ok';
  check(integrityOk, 'integrity_check ok', JSON.stringify(after.integrity));
  check(after.foreignKeys.length === 0, 'foreign_key_check empty', JSON.stringify(after.foreignKeys));

  // 6 — idempotent: a second open must succeed AND log no further schema_migration rows. An
  // unguarded ALTER throws here ("duplicate column name: …") rather than double-logging, so the
  // throw is itself the finding — catch it and report a clean FAIL instead of a stack trace.
  let reopened = true;
  try { run(process.execPath, ['--input-type=module', '-e', OPEN_ONLY], { cwd: repoRoot, env }); }
  catch (err) { reopened = false; check(false, 'migration is idempotent (second open succeeds)', (err.stderr || err.message).split('\n').find((l) => /Error|error:/.test(l))?.trim() ?? 'second open threw'); }
  if (reopened) {
    const again = snapshot(dbPath);
    check(again.migrations.length === after.migrations.length, 'migration is idempotent (second open logs no new schema_migration row)',
      `${after.migrations.length} -> ${again.migrations.length} rows`);
  }
  const dupes = after.migrations.filter((m, i) => after.migrations.indexOf(m) !== i);
  check(dupes.length === 0, 'no migration logged twice', dupes.join(', ') || 'none duplicated');

  // Safety guard — the live DB must not have been touched.
  const liveAfter = existsSync(liveDb) ? statSync(liveDb) : null;
  const liveUntouched = !liveBefore || (liveAfter && liveAfter.size === liveBefore.size && liveAfter.mtimeMs === liveBefore.mtimeMs);
  check(liveUntouched, 'the live life-context.db was not touched',
    liveUntouched ? 'size + mtime unchanged' : 'CHANGED — check that DB_PATH was honored');

  // 7 — the diff, so a reviewer sees what the upgrade did
  const addedObjects = after.objects.filter((o) => !before.objects.includes(o));
  const addedCols = [];
  for (const [t, cols] of Object.entries(after.columns)) {
    for (const c of cols) if (!(before.columns[t] ?? []).includes(c)) addedCols.push(`${t}.${c}${before.columns[t] ? '' : ' (new table)'}`);
  }
  const newMigrations = after.migrations.filter((m) => !before.migrations.includes(m));
  console.log('\nupgrade diff');
  console.log(`  added objects   : ${addedObjects.join(', ') || '(none)'}`);
  console.log(`  added columns   : ${addedCols.join(', ') || '(none)'}`);
  console.log(`  migrations run  : ${newMigrations.join(', ') || '(none)'}`);
  if (!addedObjects.length && !addedCols.length && !newMigrations.length) {
    console.log('  NOTE: the working tree changed no schema at all vs this base ref — expected only if this branch has no schema change.');
  }
} finally {
  try { git('worktree', 'remove', oldTree, '--force'); } catch { /* Windows lock: prune below, dir stays in temp */ }
  try { git('worktree', 'prune'); } catch { /* nothing registered */ }
  console.log(`\nscratch left in place (temp dir, safe to ignore): ${tmpBase}`);
}

if (failures.length) {
  console.error(`\nverify:schema-upgrade FAILED — ${failures.length} assertion(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nverify:schema-upgrade: all assertions passed.');
