// EVENTS_DB_PATH default derivation (#369): a scratch/test DB_PATH must not silently share the
// production logs/events.db. config.js reads the environment once at import and cannot be
// re-parameterized in-process (same constraint as embedding-egress.test.mjs), so each branch is
// checked by importing src/config.js in a CHILD process with a controlled env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dotenv never overrides an already-set variable, so passing DB_PATH/EVENTS_DB_PATH here (even as
// an explicit empty string, #358) wins over any real .env in the repo root, and the suite must
// pass in CI where no .env exists at all.
const readEventsDbPath = (env) => {
  const r = spawnSync(
    process.execPath,
    ['-e', 'import("./src/config.js").then(m => console.log(JSON.stringify({ EVENTS_DB_PATH: m.EVENTS_DB_PATH, DB_PATH: m.DB_PATH })))'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, DB_PATH: '', EVENTS_DB_PATH: '', ...env } },
  );
  assert.equal(r.status, 0, `import must succeed; stderr: ${r.stderr}`);
  // dotenv v17 writes its own "injected env ..." banner line to stdout ahead of our output
  // (even when there's nothing to inject) — the JSON payload is always the last line.
  const lastLine = r.stdout.trim().split('\n').pop();
  return JSON.parse(lastLine);
};

test('default DB_PATH + unset EVENTS_DB_PATH: stays logs/events.db (byte-identical to today)', () => {
  const { EVENTS_DB_PATH, DB_PATH } = readEventsDbPath({});
  assert.equal(DB_PATH, 'life-context.db');
  assert.equal(EVENTS_DB_PATH, 'logs/events.db');
});

test('non-default DB_PATH + unset EVENTS_DB_PATH: derives logs/events-<basename>.db', () => {
  const { EVENTS_DB_PATH } = readEventsDbPath({ DB_PATH: 'lc-scratch.db' });
  assert.equal(EVENTS_DB_PATH, path.join('logs', 'events-lc-scratch.db'));
});

test('non-default DB_PATH with a nested path: derives from the basename only', () => {
  const { EVENTS_DB_PATH } = readEventsDbPath({ DB_PATH: path.join('data', 'lc-slice50.db') });
  assert.equal(EVENTS_DB_PATH, path.join('logs', 'events-lc-slice50.db'));
});

test('explicit EVENTS_DB_PATH always wins, regardless of DB_PATH', () => {
  const withDefaultDb = readEventsDbPath({ EVENTS_DB_PATH: 'custom/events.db' });
  assert.equal(withDefaultDb.EVENTS_DB_PATH, 'custom/events.db');

  const withScratchDb = readEventsDbPath({ DB_PATH: 'lc-scratch.db', EVENTS_DB_PATH: 'custom/events.db' });
  assert.equal(withScratchDb.EVENTS_DB_PATH, 'custom/events.db');
});
