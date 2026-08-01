// GET /api/v1/artifacts (#449): deterministic, non-ranked enumeration with paging. Own HTTP
// fixture (mirrors server.test.mjs's setup) rather than piling onto that already-large file.
// useTempEvents() is on so the "no memory content in logs/events.db" acceptance criterion can
// actually be checked, not just assumed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { useTempDb, useTempEvents, startFakeOllama, f32 } from './helpers.mjs';

const API_KEY = 'test-key-artifacts-list-0123456789';
const { cleanup: cleanupDb } = useTempDb();
const { cleanup: cleanupEvents } = useTempEvents();
const fake = await startFakeOllama();
process.env.LIFECONTEXT_API_KEY = API_KEY;
process.env.OLLAMA_BASE_URL = fake.baseUrl;
process.env.PORT = '0';
process.env.RATE_LIMIT_MAX = '10000';
process.env.UI_URL_TOKEN = '';

const { app, serverInstance } = await import('../src/server.js');
const { db, storeArtifactTxn } = await import('../src/db.js');
const { log } = await import('../src/logger.js');
const { readEvents } = await import('./helpers.mjs');

if (!serverInstance.listening) await once(serverInstance, 'listening');
const { port } = serverInstance.address();
const base = `http://127.0.0.1:${port}`;
const get = (path, headers = { 'x-api-key': API_KEY }) => fetch(`${base}${path}`, { headers });

after(async () => {
  serverInstance.closeAllConnections?.();
  await new Promise((resolve) => serverInstance.close(resolve));
  db.close();
  log.close();
  await fake.close();
  cleanupEvents(log);
  cleanupDb();
});

// Seed a small, distinctively-typed backlog: 6 x-agent-preference rows (the motivating caller,
// #407) plus a couple of other types/sources so type/source filtering has something to exclude.
const vec = f32();
const prefIds = [];
for (let i = 0; i < 6; i++) {
  const { id } = storeArtifactTxn(
    { type: 'x-agent-preference', source: 'preferences-migration', source_id: `pref-${i}`, text_repr: `preference number ${i}` },
    vec,
  );
  prefIds.push(id);
}
storeArtifactTxn({ type: 'note', source: 'other-source', source_id: 'n-1', text_repr: 'an unrelated note' }, vec);
const { id: photoId } = storeArtifactTxn({ type: 'photo', source: 'other-source', source_id: 'p-1', text_repr: 'an unrelated photo' }, vec);

// Distinct occurred_at values for since/until coverage — a dedicated x- type so it can never be
// touched by another test's type filter (mirrors the photo/x-agent-preference isolation above).
storeArtifactTxn({ type: 'x-time-marker', source: 'time-test', source_id: 't-early', text_repr: 'an early marker', occurred_at: '2020-01-01 00:00:00' }, vec);
storeArtifactTxn({ type: 'x-time-marker', source: 'time-test', source_id: 't-mid', text_repr: 'a mid marker', occurred_at: '2020-06-01 00:00:00' }, vec);
storeArtifactTxn({ type: 'x-time-marker', source: 'time-test', source_id: 't-late', text_repr: 'a late marker', occurred_at: '2021-01-01 00:00:00' }, vec);

test('enumerates by type with a correct total', async () => {
  const res = await get('/api/v1/artifacts?type=x-agent-preference');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 6);
  assert.equal(body.results.length, 6);
  assert.deepEqual(body.results.map((r) => r.id), [...prefIds].sort((a, b) => a - b), 'default order is id ASC');
});

test('pages every row exactly once across offsets, unaffected by a concurrent insert', async () => {
  const page = async (offset) => (await (await get(`/api/v1/artifacts?type=x-agent-preference&order=id&dir=asc&limit=2&offset=${offset}`)).json()).results.map((r) => r.id);
  const p0 = await page(0);
  // Insert a new artifact of a DIFFERENT type between page requests — id ASC sweep-safety means it
  // appends past the end of this 6-row window (whatever type it is) and must not shift or
  // duplicate anything already paged. A different type also keeps the x-agent-preference total
  // used by later tests stable at 6, so this test's side effect can't leak into them.
  storeArtifactTxn({ type: 'note', source: 'other-source', source_id: 'n-inserted-mid-sweep', text_repr: 'a late arrival' }, vec);
  const p1 = await page(2);
  const p2 = await page(4);
  const seen = [...p0, ...p1, ...p2];
  assert.deepEqual(seen, [...prefIds].sort((a, b) => a - b), 'no duplicate, no gap');
});

test('total ignores limit/offset', async () => {
  const body = await (await get('/api/v1/artifacts?type=x-agent-preference&limit=2&offset=0')).json();
  assert.equal(body.total, 6);
  assert.equal(body.results.length, 2);
});

test('limit over MAX_LIST_LIMIT is 422, never a silent clamp; the boundary itself is 200', async () => {
  const over = await get('/api/v1/artifacts?limit=201');
  assert.equal(over.status, 422);
  const atMax = await get('/api/v1/artifacts?limit=200');
  assert.equal(atMax.status, 200);
});

test('an unknown type is 422; an x- extension marker is enumerable', async () => {
  const bad = await get('/api/v1/artifacts?type=nonsense');
  assert.equal(bad.status, 422);
  const ok = await get('/api/v1/artifacts?type=x-agent-preference');
  assert.equal(ok.status, 200);
});

// Multiple rows all sharing NULL occurred_at (the 6 x-agent-preference fixture rows, none of
// which set occurred_at) — a single-row set can't distinguish a correct id tie-break from a
// broken one, since both would trivially "agree with themselves".
test('deterministic order under NULL occurred_at via the id tie-break, over multiple rows', async () => {
  const a = await (await get('/api/v1/artifacts?order=occurred_at&dir=desc&type=x-agent-preference')).json();
  const b = await (await get('/api/v1/artifacts?order=occurred_at&dir=desc&type=x-agent-preference')).json();
  const expected = [...prefIds].sort((x, y) => y - x); // all occurred_at tie (NULL) -> id DESC decides
  assert.deepEqual(a.results.map((r) => r.id), expected);
  assert.deepEqual(b.results.map((r) => r.id), expected, 'a second identical request must not reorder');
});

test('type accepts a repeated query param and a comma-separated one identically', async () => {
  const repeated = await (await get('/api/v1/artifacts?type=x-agent-preference&type=photo')).json();
  const commaSeparated = await (await get('/api/v1/artifacts?type=x-agent-preference,photo')).json();
  const expectedIds = [...prefIds, photoId].sort((a, b) => a - b);
  assert.equal(repeated.total, 7);
  assert.deepEqual(repeated.results.map((r) => r.id), expectedIds);
  assert.equal(commaSeparated.total, 7);
  assert.deepEqual(commaSeparated.results.map((r) => r.id), expectedIds);
});

test('a comma-separated type list with one bad value is 422', async () => {
  const res = await get('/api/v1/artifacts?type=x-agent-preference,nonsense');
  assert.equal(res.status, 422);
});

test('since/until bound results by occurred_at (default time_field)', async () => {
  const body = await (await get('/api/v1/artifacts?type=x-time-marker&since=2020-03-01&until=2020-12-31')).json();
  assert.equal(body.total, 1);
  assert.equal(body.results[0].source_id, 't-mid');
});

test('since alone (no until) and until alone (no since) each apply independently', async () => {
  const sinceOnly = await (await get('/api/v1/artifacts?type=x-time-marker&since=2020-06-01')).json();
  assert.deepEqual(sinceOnly.results.map((r) => r.source_id).sort(), ['t-late', 't-mid']);
  const untilOnly = await (await get('/api/v1/artifacts?type=x-time-marker&until=2020-06-01')).json();
  assert.deepEqual(untilOnly.results.map((r) => r.source_id).sort(), ['t-early', 't-mid']);
});

test('time_field=ingested_at bounds by ingestion time, not occurred_at', async () => {
  // Every x-time-marker row was ingested "now" (this test run), regardless of its occurred_at —
  // a since far in the future must exclude all of them; a since far in the past must include all.
  const future = await (await get('/api/v1/artifacts?type=x-time-marker&time_field=ingested_at&since=2999-01-01')).json();
  assert.equal(future.total, 0);
  const past = await (await get('/api/v1/artifacts?type=x-time-marker&time_field=ingested_at&since=2000-01-01')).json();
  assert.equal(past.total, 3);
});

test('an unparseable since/until is 422', async () => {
  const res = await get('/api/v1/artifacts?since=not-a-real-date');
  assert.equal(res.status, 422);
});

test('order=ingested_at and order=id&dir=desc are honored', async () => {
  // These 6 rows were inserted in prefIds order, so ingested_at ASC coincides with id ASC (ties,
  // if any, resolve to the same order via the id tie-break either way).
  const byIngested = await (await get('/api/v1/artifacts?type=x-agent-preference&order=ingested_at&dir=asc')).json();
  assert.deepEqual(byIngested.results.map((r) => r.id), [...prefIds].sort((a, b) => a - b));
  const byIdDesc = await (await get('/api/v1/artifacts?type=x-agent-preference&order=id&dir=desc')).json();
  assert.deepEqual(byIdDesc.results.map((r) => r.id), [...prefIds].sort((a, b) => b - a));
});

test('an invalid order, dir, or time_field is 422', async () => {
  assert.equal((await get('/api/v1/artifacts?order=bogus')).status, 422);
  assert.equal((await get('/api/v1/artifacts?dir=sideways')).status, 422);
  assert.equal((await get('/api/v1/artifacts?time_field=bogus')).status, 422);
});

test('missing or invalid x-api-key is 401', async () => {
  const missing = await fetch(`${base}/api/v1/artifacts`);
  assert.equal(missing.status, 401);
  const bad = await get('/api/v1/artifacts', { 'x-api-key': 'wrong-key-wrong-key-wrong' });
  assert.equal(bad.status, 401);
});

test('source filter narrows to that source only', async () => {
  const body = await (await get('/api/v1/artifacts?source=preferences-migration')).json();
  assert.ok(body.results.every((r) => r.source === 'preferences-migration'));
  assert.equal(body.total, 6, 'exactly the 6 preferences-migration fixture rows, nothing else');
});

test('no memory content reaches the ops event log for these requests', async () => {
  const before = readEvents(log, { event: 'db.artifacts.listed' }).length;
  await get('/api/v1/artifacts?type=x-agent-preference&source=preferences-migration');
  const rows = readEvents(log, { event: 'db.artifacts.listed' });
  assert.ok(rows.length > before);
  for (const r of rows) {
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes('preference number'), 'text_repr content must never reach the event log');
    assert.ok(!blob.includes('preferences-migration'), 'the source value itself must never reach the event log');
    assert.ok(!blob.includes('pref-'), 'a source_id must never reach the event log');
  }
});
