// Unit tests for the access-logging module (src/access-log.js) — #178. No live server: the
// middleware is driven with a fake req + an EventEmitter res, so we can assert the exact line that
// lands on disk. The single non-negotiable is SECRET REDACTION — a written line must never contain
// the ?api_key= value, a capability path token, or any request body. ACCESS_LOG_DIR is pointed at a
// throwaway dir BEFORE importing the module (config.js reads it once at load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTempEvents } from './helpers.mjs';

const { cleanup: cleanupEvents } = useTempEvents(); // access-log.js imports the logger (#328)
const dir = mkdtempSync(path.join(tmpdir(), 'lc-access-'));
process.env.ACCESS_LOG_DIR = dir;
// Exercise the default-on path. Empty string, NOT `delete` (#358): config.js calls dotenv.config(),
// which only skips variables already SET, so a `delete` here would let a real .env supply a value
// and this file would quietly stop testing the default. `''` is set, so dotenv leaves it alone, and
// it still yields the default — ACCESS_LOG_ENABLED does not go through bool(); config.js:149-150
// disables logging only for an explicit 'false'/'0'/'no'/'off', so an empty string stays on.
// Latent today (no .env in this repo sets it) — fixed with its two siblings so the pattern doesn't
// survive anywhere to be copied.
process.env.ACCESS_LOG_ENABLED = '';

const { accessLogMiddleware, redactPath, pruneOldLogs, ensureCompressed, closeAccessLog } = await import('../src/access-log.js');
const { log } = await import('../src/logger.js');

after(() => { rmSync(dir, { recursive: true, force: true }); cleanupEvents(log); });

const fakeReq = (over = {}) => ({ method: 'GET', originalUrl: '/', path: '/', ip: '203.0.113.7', socket: {}, ...over });
const fakeRes = (statusCode) => Object.assign(new EventEmitter(), { statusCode });

// Run one request through the middleware and return everything written to today's file(s).
async function drive(req, statusCode) {
  const res = fakeRes(statusCode);
  accessLogMiddleware(req, res, () => {});
  res.emit('finish');
  await closeAccessLog();
  return readdirSync(dir)
    .filter((f) => /^access-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .join('');
}

test('redactPath scrubs the api_key query param and capability path tokens', () => {
  assert.equal(redactPath('/api/search?api_key=SUPERSECRET&limit=3'), '/api/search?api_key=<redacted>&limit=3');
  assert.equal(redactPath('/api/search?limit=3&API_KEY=SUPERSECRET'), '/api/search?limit=3&API_KEY=<redacted>');
  assert.equal(redactPath('/deadbeeftoken/mcp'), '/<token>/mcp');
  assert.equal(redactPath('/deadbeeftoken/ui/chat.html'), '/<token>/ui/chat.html');
  assert.equal(redactPath('/api/recall'), '/api/recall'); // nothing to redact
  assert.equal(redactPath('/mcp'), '/mcp');               // header-auth mcp: no token segment
});

test('a request writes one redacted line; the api_key value and the request body never appear', async () => {
  const req = fakeReq({
    method: 'POST',
    originalUrl: '/api/recall?api_key=SUPERSECRET',
    path: '/api/recall',
    body: { query: 'my private memory content about otters' }, // must NEVER be logged
  });
  const content = await drive(req, 200);
  assert.match(content, /api POST \/api\/recall\?api_key=<redacted> 200 \d+ms ip=203\.0\.113\.7 auth=ok/);
  assert.ok(!content.includes('SUPERSECRET'), 'the api_key value is redacted');
  assert.ok(!content.includes('my private memory content'), 'the request body is never logged');
  assert.match(content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /m, 'line starts with a UTC second-precision timestamp');
});

test('a capability path token is redacted; a 401 logs auth=fail', async () => {
  const tokened = await drive(fakeReq({ originalUrl: '/deadbeeftoken/ui/chat.html', path: '/deadbeeftoken/ui/chat.html' }), 200);
  assert.ok(!tokened.includes('deadbeeftoken'), 'the ui path token never reaches the log');
  assert.match(tokened, /ui GET \/<token>\/ui\/chat\.html 200/);

  const unauth = await drive(fakeReq({ method: 'POST', originalUrl: '/api/recall', path: '/api/recall', ip: '10.0.0.2' }), 401);
  assert.match(unauth, /api POST \/api\/recall 401 \d+ms ip=10\.0\.0\.2 auth=fail/);
});

test('a wrong-capability-token 404 is an auth=fail probe (never leaks the token)', async () => {
  const content = await drive(fakeReq({ originalUrl: '/wrongtoken/mcp', path: '/wrongtoken/mcp' }), 404);
  assert.match(content, /mcp GET \/<token>\/mcp 404 \d+ms ip=203\.0\.113\.7 auth=fail/);
  assert.ok(!content.includes('wrongtoken'));
});

test('pruneOldLogs deletes files older than the window, keeps recent, ignores non-access files', async () => {
  const pdir = mkdtempSync(path.join(tmpdir(), 'lc-prune-'));
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(pdir, 'access-2020-01-01.log'), 'old');
  writeFileSync(path.join(pdir, `access-${today}.log`), 'new');
  writeFileSync(path.join(pdir, 'notes.txt'), 'unrelated');

  const r = await pruneOldLogs(pdir, 90);
  const remaining = readdirSync(pdir);
  assert.ok(!remaining.includes('access-2020-01-01.log'), 'the old dated file is pruned');
  assert.ok(remaining.includes(`access-${today}.log`), 'a recent file is kept');
  assert.ok(remaining.includes('notes.txt'), 'a non-access file is untouched');
  assert.equal(r.pruned, 1);
  assert.equal(r.kept, 1);
  rmSync(pdir, { recursive: true, force: true });

  // A non-positive window and a missing dir are both no-ops.
  assert.deepEqual(await pruneOldLogs(pdir, 0), { pruned: 0, kept: 0 });
  assert.deepEqual(await pruneOldLogs(path.join(tmpdir(), 'lc-does-not-exist-xyz'), 90), { pruned: 0, kept: 0 });
});

test('ensureCompressed is best-effort and never throws (no-op off Windows)', async () => {
  const r = await ensureCompressed(dir);
  assert.equal(typeof r, 'object');
  assert.equal(process.platform === 'win32' ? typeof r.compressed : r.reason, process.platform === 'win32' ? 'boolean' : 'not-windows');
});
