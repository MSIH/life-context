// The ops-trace HTTP boundary (#328). Its own file, with its own server, deliberately: the
// boundary span is what every downstream span hangs off, so it has to be asserted through a REAL
// request — and server.test.mjs has already spent the 100-req/min rate-limit budget by the time a
// test appended there would run, so those requests come back 429 and the spans never happen.
// A handful of requests in a fresh process keeps the assertion about tracing, not about limits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { useTempDb, useTempEvents, startFakeOllama, readEvents } from './helpers.mjs';

const API_KEY = 'trace-test-key-0123456789-not-placeholder';
const { cleanup } = useTempDb();
const { cleanup: cleanupEvents } = useTempEvents();
const fake = await startFakeOllama();
process.env.LIFECONTEXT_API_KEY = API_KEY;
process.env.OLLAMA_BASE_URL = fake.baseUrl;
process.env.PORT = '0'; // ephemeral port — never collides with the real running server
// Empty string, NOT `delete` (#358). config.js calls dotenv.config(), and dotenv only skips
// variables that are already SET — so deleting this is precisely what frees dotenv to load it from
// a real .env moments later, re-populating what we just removed. `''` is set, so dotenv leaves it
// alone, and config.js normalizes it to undefined ((process.env.UI_URL_TOKEN || '').trim() ||
// undefined) so the UI stays disabled. With `delete`, this file passed in CI (no .env) and failed
// on every dev box that has one.
process.env.UI_URL_TOKEN = '';

const { serverInstance } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { log } = await import('../src/logger.js');

if (!serverInstance.listening) await once(serverInstance, 'listening');
const base = `http://127.0.0.1:${serverInstance.address().port}`;

after(async () => {
  serverInstance.closeAllConnections?.();
  await new Promise((resolve) => serverInstance.close(resolve));
  db.close();
  await fake.close();
  cleanupEvents(log);
  cleanup();
});

const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });
const mark = () => readEvents(log).at(-1)?.id ?? 0;

// `serverInstance.listening` flips synchronously inside listen(), but the 'listening' event — and
// therefore the boot row written from its callback — is emitted on a later tick. So the guarded
// `once()` above can fall through with the row not yet queued. Poll for it instead of assuming.
async function waitForEvent(event, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const rows = readEvents(log, { event });
    if (rows.length) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

test('the process-start row anchors the run', async () => {
  const rows = await waitForEvent('proc.server.started');
  assert.equal(rows.length, 1);
  const data = JSON.parse(rows[0].data);
  assert.equal(data.ui_mount, false, 'a boolean flag survives redaction');
  assert.ok(!/[\\/]/.test(data.db), 'only the DB file basename — never the resolved path');
});

test('a request produces ONE boundary span with duration, ok, and a trace id', async () => {
  const before = mark();
  const res = await post('/api/remember', { content: 'trace boundary probe' }, { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const spans = readEvents(log, { event: 'http.request.completed', since: before });
  assert.equal(spans.length, 1, 'exactly one boundary span per request');
  const [s] = spans;
  assert.ok(s.duration_ms >= 0, 'duration recorded');
  assert.equal(s.ok, 1);
  assert.match(s.trace_id, /^[0-9a-f]{32}$/, 'W3C trace-id shape');
  assert.equal(s.parent_span, null, 'the boundary is the trace root');
  const data = JSON.parse(s.data);
  assert.equal(data.surface, 'api');
  assert.equal(data.method, 'POST');
  assert.equal(data.status, 200);
  assert.equal(data.route, '/api/remember', 'the static route PATTERN, never the raw URL');
});

test('downstream spans nest under the boundary, on the same trace', async () => {
  const before = mark();
  await post('/api/remember', { content: 'nested span probe' }, { 'x-api-key': API_KEY });
  const rows = readEvents(log, { since: before });
  const boundary = rows.find((r) => r.event === 'http.request.completed');
  const embed = rows.find((r) => r.event === 'ollama.embed.completed');
  const store = rows.find((r) => r.event === 'db.artifact.stored');
  assert.ok(boundary, 'boundary span present');
  assert.ok(embed, 'the Ollama embed span present');
  assert.ok(store, 'the artifact-write span present');
  for (const r of [embed, store]) {
    assert.equal(r.trace_id, boundary.trace_id, `${r.event} shares the boundary's trace`);
    // Nesting is the assertion that matters: a flat list means parent_span was never threaded,
    // and the trace-tree query (queries.sql #3) would return siblings instead of a tree.
    assert.equal(r.parent_span, boundary.span_id, `${r.event} hangs off the boundary span`);
  }
  assert.ok(embed.file.startsWith('src/'), 'and spans are attributed to src/, not a Node internal');
  assert.ok(store.file.startsWith('src/'));
});

test('a 4xx is a working boundary (ok=1), and no part of the URL reaches the row', async () => {
  const before = mark();
  // The query-string value here is exactly the shape of thing that must never be logged: a
  // person's name the user typed into the entity-list route.
  assert.equal((await get('/api/v1/entities?query=Some%20Private%20Person', { 'x-api-key': API_KEY })).status, 200);
  assert.equal((await post('/api/recall', { query: 'x' })).status, 401);
  const rows = readEvents(log, { event: 'http.request.completed', since: before });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.ok, 1, '4xx is the boundary rejecting input, not a server failure');
    assert.ok(!r.data.includes('Private'), 'no query-string value in the span');
    assert.ok(!r.data.includes('?'), 'no raw URL at all — only the route pattern');
  }
  assert.equal(JSON.parse(rows[1].data).status, 401);
});

test('a failing entity-name lookup logs NO name — the error message itself is untrusted', async () => {
  // The leak Copilot caught on PR #333: promoteDirectoryName throws `"<name>" is not in the
  // contact directory`, so logging the raw error put a contact's name into err_msg and stack.
  // Driven through the real route so the assertion covers the wiring, not just errorTyped.
  const before = mark();
  const NAME = 'Zzyzx Unlikelyname';
  const res = await post('/api/v1/directory/promote', { names: [NAME] }, { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).results[0].error, 'NOT_IN_DIRECTORY');
  for (const r of readEvents(log, { since: before })) {
    for (const col of ['data', 'msg', 'err_msg', 'stack']) {
      assert.ok(!(r[col] ?? '').includes('Zzyzx'), `${r.event}.${col} must not carry the name`);
    }
  }
});

test('a GET /mcp span carries data.long_lived:true (#367) — the SSE stream-open duration must be flaggable', async () => {
  const before = mark();
  // No session header -> handleExistingSession 400s immediately; the boundary's classification is
  // by method+path, not by how long the connection actually stayed open (a real SSE stream can't
  // be driven to completion in a unit test).
  const res = await get('/mcp', { 'x-api-key': API_KEY });
  assert.equal(res.status, 400);
  const spans = readEvents(log, { event: 'http.request.completed', since: before });
  assert.equal(spans.length, 1);
  const data = JSON.parse(spans[0].data);
  assert.equal(data.surface, 'mcp');
  assert.equal(data.method, 'GET');
  assert.equal(data.long_lived, true);
});

test('every other route/method is byte-identical: no long_lived key added', async () => {
  const before = mark();
  await post('/api/remember', { content: 'not long-lived' }, { 'x-api-key': API_KEY });
  await get('/api/v1/entities', { 'x-api-key': API_KEY });
  // POST /mcp (not GET) must not be flagged either — long_lived is GET-only.
  await post('/mcp', {}, { 'x-api-key': API_KEY });
  const spans = readEvents(log, { event: 'http.request.completed', since: before });
  assert.ok(spans.length >= 3);
  for (const s of spans) {
    const data = JSON.parse(s.data);
    assert.ok(!('long_lived' in data), `${data.method} ${data.surface} must not carry long_lived`);
  }
});

test('an unhandled route error becomes exactly one ERROR row, via the error middleware', async () => {
  const before = mark();
  // A malformed JSON body is a body-parser 400 — a 4xx, so NOT an error row (it never reaches the
  // 500 branch). This asserts the boundary distinguishes the two rather than logging every 4xx.
  const res = await fetch(`${base}/api/remember`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal(readEvents(log, { event: 'http.request.failed', since: before }).length, 0,
    'a 4xx must not produce an ERROR row — ERROR is reserved for "a human must look"');
});
