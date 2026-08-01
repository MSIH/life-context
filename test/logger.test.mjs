// The ops event store (#328, src/logger.js). The properties under test are the ones whose failure
// is SILENT — a leak nobody notices, a swallowed row, a store that grows forever — so each is
// asserted against real rows in a real throwaway DB rather than against the logger's own return
// values. EVENTS_DB_PATH is pointed at a temp file BEFORE logger.js is imported (it opens the
// store at module load), so the module is loaded dynamically here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'lc-logger-'));
const dbPath = path.join(dir, 'events.db');
process.env.EVENTS_DB_PATH = dbPath;
process.env.EVENTS_LOG_ENABLED = 'true';
process.env.EVENTS_LOG_LEVEL = 'INFO';
// A known secret value, so the "a live secret is scrubbed out of free text" assertion below is
// testing identity-matching, not a guess at what a secret looks like.
process.env.LIFECONTEXT_API_KEY = 'test-live-secret-value-01234567';

const { Logger, log, scrubText, repoRelative } = await import('../src/logger.js');

const open = () => new Database(dbPath, { readonly: true });
const rows = (sql, ...args) => { log.flush(); const d = open(); try { return d.prepare(sql).all(...args); } finally { d.close(); } };
const lastFor = (event) => rows('SELECT * FROM events WHERE event = ? ORDER BY id DESC LIMIT 1', event)[0];

after(() => { log.close(); rmSync(dir, { recursive: true, force: true }); });

test('bootstrap: the store, its WAL sidecar, and the schema_version row all exist', () => {
  log.info('test.bootstrap.checked', 'bootstrap');
  log.flush();
  assert.ok(existsSync(dbPath), 'events.db exists');
  assert.ok(existsSync(`${dbPath}-wal`), 'WAL mode is active (the -wal sidecar is present)');
  const d = open();
  try {
    assert.equal(d.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get().v, '1');
    assert.equal(d.pragma('journal_mode', { simple: true }), 'wal');
  } finally { d.close(); }
});

test('every row carries the identity columns, and file is repo-relative — never absolute', () => {
  log.info('test.identity.checked', 'identity', { n: 1 });
  const r = lastFor('test.identity.checked');
  assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(typeof r.ts_ms, 'number');
  assert.equal(r.app, 'life-context');
  assert.equal(r.run_id, log.runId);
  assert.equal(r.pid, process.pid);
  assert.ok(r.host);
  // Rule 2: an absolute path differs dev vs prod (splitting GROUP BY) and leaks the install
  // location. A drive letter or a leading slash in `file` means the capture regressed.
  assert.ok(!/^([A-Za-z]:|\/)/.test(r.file), `file must be repo-relative, got ${r.file}`);
  assert.match(r.file, /test\/logger\.test\.mjs$/);
  assert.ok(r.line > 0, 'and a real line number');
});

test('file/func come from the first frame OUTSIDE the logger, not a fixed frame index', () => {
  // The reference implementation indexed frame 4, which silently attributes every row to the
  // logger the moment a wrapper layer is added. span() IS such an extra layer — if the capture
  // regressed to a fixed index, this row's `file` would be src/logger.js.
  function namedCaller() { log.warn('test.frame.checked', 'frame'); }
  namedCaller();
  const r = lastFor('test.frame.checked');
  assert.match(r.file, /test\/logger\.test\.mjs$/);
  assert.match(r.func, /namedCaller/);
});

// --- Redaction: the failure mode this whole module exists to prevent ---------------------------

test('credential keys are replaced outright — including compounds, which exact-matching missed', () => {
  log.info('test.creds.checked', 'creds', {
    password: 'hunter2', api_key: 'k', secret_token: 'st', access_token: 'at',
    'X-Api-Key': 'xak', authorization: 'Bearer abc', key: 'k2', session_id: 's',
    ok_field: 'kept',
  });
  const data = JSON.parse(lastFor('test.creds.checked').data);
  for (const k of ['password', 'api_key', 'secret_token', 'access_token', 'X-Api-Key', 'authorization', 'key', 'session_id']) {
    assert.equal(data[k], '[REDACTED]', `${k} must be redacted`);
  }
  // Never a length for a credential — a length is a free bit about a secret.
  assert.ok(!JSON.stringify(data).includes('chars'), 'a credential leaks no shape, not even its length');
  assert.equal(data.ok_field, 'kept', 'and an ordinary field is untouched');
});

test('content keys are replaced with their SHAPE — memory text never reaches `data`', () => {
  const memory = "Alex's sister Jamie lives in Rivertown and is a nurse.";
  log.info('test.content.checked', 'content', {
    content: memory, text_repr: memory, search_query: 'where does my sister live',
    canonical_name: 'Jamie', sender_email: 'jamie@example.com', display_text: memory,
    limit: 3, results: 2,
  });
  const r = lastFor('test.content.checked');
  assert.ok(!r.data.includes('Jamie'), 'no contact name in data');
  assert.ok(!r.data.includes('Rivertown'), 'no memory content in data');
  assert.ok(!r.data.includes('sister'), 'no query text in data');
  const data = JSON.parse(r.data);
  assert.equal(data.content, `[redacted:${memory.length} chars]`, 'shape is kept — a 4 KB query is a perf fact');
  assert.equal(data.limit, 3, 'and the identifiers/counts that make the row useful survive');
  assert.equal(data.results, 2);
});

test('a BOOLEAN is exempt from the content list — a flag cannot carry text', () => {
  // Regression, found by querying a real run rather than by reading the code: `planner:true` and
  // `placebound:false` were coming back '[redacted]' purely because their key names contain
  // 'plan'/'place'. Shaping a boolean protects nothing and destroys the diagnostic. Numbers stay
  // shaped (a phone number is a number), and a credential is redacted whatever its type.
  log.info('test.bool.checked', 'bool', {
    planner: true, placebound: false, geo_required: true,
    phone: 4155550148, secret_flag: true,
  });
  const data = JSON.parse(lastFor('test.bool.checked').data);
  assert.equal(data.planner, true);
  assert.equal(data.placebound, false);
  assert.equal(data.geo_required, true);
  assert.equal(data.phone, '[redacted]', 'a NUMBER under a content key is still shaped');
  assert.equal(data.secret_flag, '[REDACTED]', 'a credential key is redacted even as a boolean');
});

test('redaction recurses — a memory nested three levels deep is still caught', () => {
  log.info('test.nested.checked', 'nested', { a: { b: { c: { content: 'deep secret memory' } } } });
  const r = lastFor('test.nested.checked');
  assert.ok(!r.data.includes('deep secret memory'), 'nested content is redacted, not just top-level keys');
});

test('a live secret in FREE TEXT is scrubbed — the deny-list cannot reach msg/err_msg/stack', () => {
  const err = new Error(`connect failed with api_key=${process.env.LIFECONTEXT_API_KEY} and Bearer sk-abc123`);
  log.error('test.freetext.checked', 'free text', err);
  const r = lastFor('test.freetext.checked');
  assert.ok(!r.err_msg.includes(process.env.LIFECONTEXT_API_KEY), 'the live key is gone from err_msg');
  assert.ok(!r.err_msg.includes('sk-abc123'), 'and a credential-shaped assignment is blanked');
  assert.ok(r.err_msg.includes('connect failed'), 'while the diagnostic part of the message survives');
  assert.ok(r.stack && !r.stack.includes(process.env.LIFECONTEXT_API_KEY), 'stack is scrubbed too');
});

test('errorTyped drops the message and keeps only stack FRAMES', () => {
  // The deny-list protects `data`, not an exception's own message — and this codebase builds
  // messages like `no entity named "<name>"`. errorTyped is what a boundary uses when the error
  // message itself is untrusted (Copilot, PR #333).
  const err = new Error('no entity named "Solveig Nyborg"');
  err.code = 'NOT_FOUND';
  log.errorTyped('test.typed.checked', 'typed error', err, { entity_id: 7 });
  const r = lastFor('test.typed.checked');
  assert.equal(r.level, 'ERROR');
  assert.equal(r.err_type, 'Error');
  assert.equal(r.err_msg, null, 'the message is dropped entirely');
  assert.ok(!r.stack.includes('Solveig'), 'and the stack no longer carries it either');
  assert.ok(r.stack.split('\n').every((l) => /^\s*at\s/.test(l)), 'stack is frames only');
  assert.match(r.stack, /test\/logger\.test\.mjs/, 'the frames still locate the throw');
  const data = JSON.parse(r.data);
  assert.equal(data.code, 'NOT_FOUND', 'the typed code is the diagnostic that survives');
  assert.equal(data.entity_id, 7);
});

test('a BigInt id is never silently rounded — out of safe range it becomes a string', () => {
  // Number(bigint) past 2^53 loses precision without complaint, which would log a DIFFERENT id
  // than the one that happened (Copilot, PR #333).
  const big = 9007199254740993n; // 2^53 + 1 — not representable as a Number
  log.info('test.bigint.checked', 'bigint', { small_id: 42n, huge_id: big });
  const data = JSON.parse(lastFor('test.bigint.checked').data);
  assert.equal(data.small_id, 42, 'in range stays a number, so json_extract comparisons work');
  assert.equal(data.huge_id, '9007199254740993', 'out of range becomes an exact string');
});

test('an ESM stack frame is rewritten to repo-relative — no install path in `stack`', () => {
  log.error('test.stackpath.checked', 'stack path', new Error('boom'));
  const r = lastFor('test.stackpath.checked');
  assert.ok(!r.stack.includes('file:///'), 'no file:// URL survives');
  assert.ok(!/[A-Za-z]:[\\/]/.test(r.stack), 'and no drive-letter absolute path');
  assert.match(r.stack, /test\/logger\.test\.mjs/, 'the frame is still identifiable');
});

test('scrubText leaves an ordinary URL alone — over-eager path rewriting destroys diagnostics', () => {
  const msg = 'connect ECONNREFUSED http://localhost:11434/v1/embeddings';
  assert.equal(scrubText(msg), msg);
  assert.equal(repoRelative(path.join(process.cwd(), 'src', 'logger.js')), 'src/logger.js');
});

test('`data` is never truncated into invalid JSON — queries.sql reads it with json_extract', () => {
  log.info('test.bigdata.checked', 'big', { blob: 'x'.repeat(50_000), n: 1 });
  const r = lastFor('test.bigdata.checked');
  assert.doesNotThrow(() => JSON.parse(r.data), 'the column always parses');
  const d = open();
  try {
    assert.ok(d.prepare("SELECT json_valid(data) AS v FROM events WHERE event = 'test.bigdata.checked'").get().v === 1);
  } finally { d.close(); }
});

// --- Spans -------------------------------------------------------------------------------------

test('span records duration and ok, and nests under the ambient trace', async () => {
  await log.withTrace(async () => {
    await log.span('test.parent.completed', async () => {
      await log.span('test.child.completed', async () => 'v');
    });
  });
  const parent = lastFor('test.parent.completed');
  const child = lastFor('test.child.completed');
  assert.equal(parent.trace_id, child.trace_id, 'one trace');
  assert.equal(child.parent_span, parent.span_id, 'child hangs off the parent span');
  assert.equal(parent.parent_span, null, 'and the parent is a root');
  assert.equal(parent.ok, 1);
  assert.ok(parent.duration_ms >= 0);
  // INFO, not DEBUG: DEBUG is off in prod, and latency you can't see in prod is the latency you needed.
  assert.equal(parent.level, 'INFO');
  assert.match(parent.trace_id, /^[0-9a-f]{32}$/, 'W3C trace-id shape');
  assert.match(parent.span_id, /^[0-9a-f]{16}$/, 'W3C span-id shape');
});

test('a span row is attributed to the CALL SITE, not to a Node internal', async () => {
  // Regression: a span's row is written from a microtask continuation, where the nearest
  // non-logger frame is node:internal/process/task_queues (async) or AsyncLocalStorage.run
  // (sync). That made "error rate by module" (queries.sql #1) group by Node internals instead of
  // src/ — the whole query, silently useless. span()/spanSync() now capture the location up front.
  async function asyncCallSite() { await log.span('test.attr.async', async () => 'x'); }
  function syncCallSite() { log.spanSync('test.attr.sync', () => 'x'); }
  await asyncCallSite();
  syncCallSite();
  for (const [event, fn] of [['test.attr.async', 'asyncCallSite'], ['test.attr.sync', 'syncCallSite']]) {
    const r = lastFor(event);
    assert.match(r.file, /test\/logger\.test\.mjs$/, `${event} must be attributed to the caller's file`);
    assert.ok(!r.file.startsWith('node:'), `${event} must not be attributed to a Node internal`);
    assert.match(r.func, new RegExp(fn), `${event} must name the calling function`);
  }
});

test('a failing span logs ONCE as ERROR with the stack, and rethrows', async () => {
  await assert.rejects(() => log.span('test.failing.completed', async () => { throw new Error('nope'); }));
  const all = rows('SELECT * FROM events WHERE event = ?', 'test.failing.completed');
  assert.equal(all.length, 1, 'exactly one row — a span never double-logs its own failure');
  assert.equal(all[0].level, 'ERROR');
  assert.equal(all[0].ok, 0);
  assert.equal(all[0].err_type, 'Error');
  assert.ok(all[0].stack);
});

test('spanSync stays synchronous — no await is introduced into a caller that forbids one', () => {
  // The #227 candidate-fill -> KNN -> FTS stretch depends on this. If spanSync ever returned a
  // promise, `after` would be set before the assertion below rather than during the call.
  let inside = false;
  const out = log.spanSync('test.sync.completed', () => { inside = true; return 42; });
  assert.equal(out, 42, 'the value passes straight through, not a promise');
  assert.equal(inside, true, 'and the body ran synchronously');
  assert.equal(lastFor('test.sync.completed').ok, 1);
});

test('data passed to a span is serialized at CLOSE, so a mutation records the outcome', async () => {
  const data = { limit: 3 };
  await log.span('test.mutable.completed', async () => { data.results = 7; }, data);
  assert.equal(JSON.parse(lastFor('test.mutable.completed').data).results, 7);
});

// --- The never-throws contract and retention ---------------------------------------------------

test('the logger never throws — a circular payload and a closed store are both survivable', () => {
  const circular = { n: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => log.info('test.circular.checked', 'circular', circular));

  const dead = new Logger({ dbPath: path.join(dir, 'nested', 'deeper', 'x.db'), enabled: true });
  dead.close();
  assert.doesNotThrow(() => dead.info('test.afterclose.checked', 'after close'), 'writing after close is inert');
  assert.doesNotThrow(() => dead.flush());
  assert.doesNotThrow(() => dead.close(), 'close is idempotent');
});

test('a disabled logger is fully inert but still callable, and span passes the value through', async () => {
  const off = new Logger({ enabled: false });
  assert.doesNotThrow(() => off.info('test.disabled.checked', 'nothing'));
  assert.equal(await off.span('test.disabled.completed', async () => 'through'), 'through');
  assert.equal(off.spanSync('test.disabled.sync', () => 5), 5);
  off.close();
});

test('level filtering drops DEBUG below the configured minimum', () => {
  log.debug('test.debug.checked', 'should not land');
  assert.equal(rows('SELECT * FROM events WHERE event = ?', 'test.debug.checked').length, 0);
});

test('retention actually deletes — wired, not documented', () => {
  const retDir = mkdtempSync(path.join(tmpdir(), 'lc-logger-ret-'));
  const ret = new Logger({ dbPath: path.join(retDir, 'events.db'), retentionDays: 7, enabled: true });
  try {
    ret.info('test.retention.checked', 'recent');
    ret.flush();
    const d = new Database(path.join(retDir, 'events.db'));
    try {
      // Backdate one row past the window; the recent row must survive the same pass.
      d.prepare('INSERT INTO events (ts, ts_ms, level, event, file, func, run_id, app) VALUES (?,?,?,?,?,?,?,?)')
        .run('2000-01-01T00:00:00.000Z', Date.now() - 60 * 86_400_000, 'INFO', 'test.retention.old', 'x', 'y', ret.runId, 'life-context');
      assert.equal(d.prepare('SELECT COUNT(*) c FROM events').get().c, 2);
    } finally { d.close(); }
    assert.equal(ret.prune(), 1, 'exactly the out-of-window row is deleted');
    const d2 = new Database(path.join(retDir, 'events.db'), { readonly: true });
    try {
      assert.equal(d2.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
      assert.equal(d2.prepare('SELECT event FROM events').get().event, 'test.retention.checked');
    } finally { d2.close(); }
    assert.equal(ret.prune(), 0, 'and a second pass is a cheap no-op');
  } finally {
    ret.close();
    rmSync(retDir, { recursive: true, force: true });
  }
});

test('event names are hygienic — no two differ only by case (queries.sql #6)', () => {
  const dupes = rows(`SELECT LOWER(event) AS normalized, COUNT(DISTINCT event) AS spellings
                      FROM events GROUP BY normalized HAVING spellings > 1`);
  assert.deepEqual(dupes, [], 'casing drift would split every GROUP BY on `event`');
});
