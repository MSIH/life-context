// Load-time kind='org' data migration (#88). A legacy business contact inserted as kind='person'
// with attrs_json.isCompany=1 (before this feature) must be promoted to kind='org' on the next
// startup — idempotently, writing exactly one schema_migration log row, and never on a second
// startup. The migration runs at db.js import, so each "startup" is a separate child process
// (org-migration-fixture.mjs) sharing one temp DB_PATH. See the repo guide's "guarded migration" note.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'org-migration-fixture.mjs');
const dir = mkdtempSync(path.join(tmpdir(), 'lc-test-orgmig-'));
const dbPath = path.join(dir, 'mig.db');
const outPath = path.join(dir, 'out.json');

after(() => rmSync(dir, { recursive: true, force: true }));

const run = (phase) => {
  execFileSync(process.execPath, [fixture, phase, outPath], { env: { ...process.env, DB_PATH: dbPath, EVENTS_DB_PATH: path.join(path.dirname(dbPath), 'events.db') }, stdio: 'ignore' });
  return JSON.parse(readFileSync(outPath, 'utf8'));
};

test('a pre-existing person+isCompany entity is promoted to org on startup, logged once, idempotent', () => {
  // Seed: migration runs on the empty DB (no-op), then the legacy mis-kinded row is inserted.
  const seeded = run('seed');
  assert.equal(seeded.companyKind, 'person', 'starts life mis-kinded as person (pre-migration)');
  assert.equal(seeded.migRows, 0, 'no migration fired on the empty DB');

  // First reopen: the migration promotes the company and writes exactly one log row. A row with
  // malformed attrs_json must NOT crash the startup migration (json_valid guards json_extract) —
  // if it threw, this execFileSync would throw and the test would fail here.
  const first = run('check');
  assert.equal(first.companyKind, 'org', 'promoted to org');
  assert.equal(first.humanKind, 'person', 'a genuine person (isCompany:false) is untouched');
  assert.equal(first.malformedKind, 'person', 'a malformed-attrs_json row is skipped, not crashed on');
  assert.equal(first.migRows, 1, 'exactly one schema_migration row');

  // Second reopen: nothing left to promote, no new log row.
  const second = run('check');
  assert.equal(second.companyKind, 'org');
  assert.equal(second.migRows, 1, 'idempotent — no second log row on a clean startup');
});
