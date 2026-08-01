/**
 * Operational event log (#328): one denormalized `events` table in its OWN SQLite file, written
 * so an agent can QUERY "why did this break" and "where is the time going" instead of eyeballing
 * text. Three stores exist in this project and they are not interchangeable:
 *
 *   - `life-context.db`  — the memories themselves, plus `ingest_log` (domain history: how a
 *                          stored artifact evolved, design-philosophy §3). Untouched by this file.
 *   - `logs/access/*.log` — per-request security/probe audit trail (#178, src/access-log.js).
 *   - `logs/events.db`   — THIS: ops tracing (spans, durations, errors), separate file so it can
 *                          never contend with sqlite-vec/FTS on the app DB, never lands in an
 *                          app-DB backup, and can be deleted wholesale without losing a memory.
 *
 * PRIVACY IS THE HARD CONSTRAINT HERE. This server stores the user's personal memories, so
 * memory content, search-query text, contact names and aliases must NEVER reach `data`, `msg`,
 * `err_msg`, or `stack` — log identifiers, counts, and durations. `redact()` denies both
 * credential and content key names (recursively) and `scrubText()` covers the three free-text
 * columns a key deny-list cannot reach. Both are backstops: the primary discipline is that call
 * sites pass ids/counts/durations, and `msg` is a constant string (variable state goes in `data`).
 *
 * Correlation is ambient. `AsyncLocalStorage` carries {traceId, spanId} for the life of a request,
 * so an outbound span in search.js/db.js nests under the HTTP boundary without every function in
 * between growing a traceId parameter. `span()` is async; `spanSync()` exists because
 * better-sqlite3 is synchronous and hybridSearch's candidate-fill -> KNN -> FTS stretch is
 * deliberately await-free (#227) — an async span there would reintroduce the interleaving it fixed.
 *
 * The logger NEVER throws: every public method is wrapped, a write failure falls back to stderr.
 * Writes go to an in-memory queue drained on an interval, so no request blocks on fsync.
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EVENTS_LOG_ENABLED, EVENTS_DB_PATH, EVENTS_LOG_LEVEL, EVENTS_RETENTION_DAYS,
  EVENTS_FLUSH_MS, EVENTS_PRUNE_INTERVAL_MS, APP_VERSION,
  LIFECONTEXT_API_KEY, MCP_URL_TOKEN, UI_URL_TOKEN,
} from './config.js';

export const SCHEMA_VERSION = 1;
const APP_NAME = 'life-context';

// Levels ordered by severity; anything below EVENTS_LOG_LEVEL is dropped at write time, which is
// what makes "DEBUG is off in prod" (SKILL rule) actually true instead of aspirational.
const LEVELS = { TRACE: 10, DEBUG: 20, INFO: 30, WARN: 40, ERROR: 50, FATAL: 60 };

// --- Redaction ---------------------------------------------------------------------------------
// Credentials: the value is worthless once logged, so it is replaced outright (never a length —
// a length is a free bit about a secret). Content: the value is the user's private data, so it is
// replaced with its SHAPE — `[redacted:N chars]` keeps the diagnostic signal (a 4 KB query is a
// perf fact) without the text.
//
// Matching is SUBSTRING, not exact, on the lowercased key name. Exact matching looked adequate
// until the first smoke run put `secret_token` straight through — the interesting keys in real
// code are compounds (`access_token`, `sender_email`, `search_query`), and a deny-list that only
// catches the bare noun is a deny-list that fails exactly when it matters. The consequence is
// deliberate over-redaction: a key containing `name` is shaped even if it is `tool_name`, so call
// sites in this repo use `tool`/`route`/`model` rather than fighting it. A false redaction costs
// one diagnostic; a false pass costs a leak of the user's memories.
const CREDENTIAL_PARTS = [
  'password', 'passwd', 'pwd', 'token', 'secret', 'authorization', 'auth', 'cookie', 'otp',
  'apikey', 'api_key', 'api-key', 'bearer', 'credential', 'connectionstring', 'connection_string',
  'signature', 'session', 'private_key', 'privatekey',
];
const CONTENT_PARTS = [
  'content', 'text', 'body', 'message', 'msg', 'snippet', 'excerpt', 'summary', 'digest',
  'query', 'semantic', 'prompt', 'note', 'title', 'subject', 'reason', 'label',
  'alias', 'name', 'email', 'phone', 'address', 'place', 'location', 'birthday', 'memory',
  'attrs', 'extra_json', 'path', 'filename', 'term', 'value', 'input', 'output',
];
// `key` on its own is a credential, but as a substring it collides with ordinary compounds
// (`card_key`, `keys`), so it is the one exact-match entry rather than a substring.
const CREDENTIAL_EXACT = new Set(['key', 'keys']);
const matchesPart = (key, parts) => parts.some((p) => key.includes(p));

const MAX_STRING = 512;      // per-value cap inside `data`
const MAX_DATA = 4000;       // cap on the serialized `data` JSON
const MAX_MSG = 200;
const MAX_ERR_MSG = 1000;
const MAX_STACK = 4000;
const MAX_DEPTH = 4;         // recursion guard for nested objects/arrays
const MAX_ARRAY = 20;
const MIN_SAFE_BIG = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const VACUUM_PAGE_BUDGET = 2000;  // pages reclaimed per prune pass — bounded, so it never stalls the loop

// The live secrets, so a value that leaks one into free text is caught by identity rather than by
// a guess at what a secret looks like. Longest-first so a prefix can't shadow a longer match.
const LIVE_SECRETS = [LIFECONTEXT_API_KEY, MCP_URL_TOKEN, UI_URL_TOKEN]
  .filter((s) => typeof s === 'string' && s.length >= 8)
  .sort((a, b) => b.length - a.length);
// `key=value` / `key: value` shapes in free text (an SDK error echoing a header, a URL with
// ?api_key=). Only the VALUE is replaced, so the surrounding message stays readable.
const SECRET_ASSIGN_RE = /\b(api[_-]?key|apikey|token|secret|password|authorization|bearer)\b(\s*[=:]\s*|\s+)(\S+)/gi;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Deep-redact a `data` payload. Arrays are capped (a long array in a log line is a rule-18 smell
// anyway); anything past MAX_DEPTH collapses to a type marker rather than recursing forever.
function redact(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clip(scrubText(value, MAX_STRING), MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    // Number() past 2^53 loses precision SILENTLY, so an out-of-range id would be logged as a
    // different id — worse than not logging it (Copilot, PR #333). Stay a number while it is
    // exact, so json_extract comparisons keep working, and fall back to a string when it isn't.
    return value >= MIN_SAFE_BIG && value <= MAX_SAFE_BIG ? Number(value) : value.toString();
  }
  if (depth >= MAX_DEPTH) return '[depth-capped]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `[+${value.length - MAX_ARRAY} more]`] : head;
  }
  if (typeof value !== 'object') return String(value); // symbol/function — never expected, never raw
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (CREDENTIAL_EXACT.has(key) || matchesPart(key, CREDENTIAL_PARTS)) { out[k] = '[REDACTED]'; continue; }
    // A BOOLEAN is exempt from the content list — it cannot carry text, so shaping it costs a
    // diagnostic and protects nothing. Found by querying a real run: `planner:true` and
    // `placebound:false` were both coming back '[redacted]' because their key names happen to
    // contain 'plan'/'place'. Numbers are NOT exempt: a phone number or a coordinate is a number.
    // Credentials above are exempt from this exemption — a numeric PIN is still a secret.
    if (typeof v !== 'boolean' && matchesPart(key, CONTENT_PARTS)) { out[k] = shapeOf(v); continue; }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

// What a denied CONTENT value is replaced with: its shape, never its text.
const shapeOf = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return `[redacted:${v.length} chars]`;
  if (Array.isArray(v)) return `[redacted:${v.length} items]`;
  if (typeof v === 'object') return `[redacted:${Object.keys(v).length} keys]`;
  return '[redacted]';
};

/**
 * Scrub free text (`msg`, `err_msg`, `stack`, and every string inside `data`). Three passes:
 * replace any live secret by identity, blank the value of a credential-shaped assignment, and
 * rewrite absolute paths to repo-relative — an ESM stack frame is a `file:///…` URL carrying the
 * account name and install location, which SKILL rule 2 bars from `file` and which has no more
 * business inside `stack`. Exported for the redaction tests.
 */
export function scrubText(text, cap = MAX_ERR_MSG) {
  if (typeof text !== 'string') return text == null ? null : String(text);
  let out = text;
  for (const s of LIVE_SECRETS) out = out.split(s).join('<redacted-secret>');
  out = out.replace(SECRET_ASSIGN_RE, (_m, k, sep, _v) => `${k}${sep}<redacted>`);
  for (const re of ABS_PATH_RES) out = out.replace(re, (m) => repoRelative(m));
  return clip(out, cap);
}

// --- Caller location ---------------------------------------------------------------------------
// The repo root is the process cwd for the server and every npm script; resolved once.
const REPO_ROOT = path.resolve(process.cwd());
const THIS_FILE = fileURLToPath(import.meta.url);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Absolute paths as they appear inside stacks and messages. Three narrow forms rather than one
// "starts with a slash" pattern, which would also eat the `//host/…` of an ordinary URL and turn a
// useful "ECONNREFUSED http://localhost:11434/v1" into noise: a `file://` URL (how ESM stack frames
// render), a drive-letter path (Windows), and anything under the repo root (catches the POSIX CJS
// frames on Ubuntu CI, where node_modules sits inside the checkout).
const ABS_PATH_RES = [
  /file:\/\/\/?[^\s'"()]+/g,
  // The lookbehind is load-bearing: without it the drive-letter branch also matches the `p://` of
  // `http://localhost:11434/v1`, and an "ECONNREFUSED <url>" message gets shredded into nonsense.
  // A real drive letter is never preceded by another alphanumeric.
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"()]*/g,
  new RegExp(`${escapeRe(REPO_ROOT)}[^\\s'"()]*`, 'g'),
];

// Repo-relative, forward-slashed, never absolute (SKILL rule 2 — an absolute path differs dev vs
// prod and splits GROUP BY, and here it would also leak the install location). A path outside the
// repo keeps only its basename for the same reason.
export function repoRelative(p) {
  try {
    const abs = p.startsWith('file:') ? fileURLToPath(p) : p;
    const rel = path.relative(REPO_ROOT, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(abs);
    return rel.split(path.sep).join('/');
  } catch {
    return path.basename(p);
  }
}

// First stack frame that is neither this module nor a Node internal. Two rules, both learned the
// hard way:
//  - Not a fixed frame index (what the reference logger used): adding one wrapper layer silently
//    reattributes every row to the logger, and span() IS such a layer.
//  - Skip `node:internal/…` frames. A span's row is written from a microtask continuation, where
//    the nearest non-logger frame is `node:internal/process/task_queues` or
//    `AsyncLocalStorage.run` — which made "error rate by module" (queries.sql #1) group by Node
//    internals instead of src/. span()/spanSync() also capture the location up front, before the
//    first await, which is the other half of the fix.
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
function callerLocation() {
  const frames = new Error().stack?.split('\n').slice(1) ?? [];
  for (const frame of frames) {
    const m = FRAME_RE.exec(frame);
    if (!m) continue;
    const [, func, loc, line] = m;
    if (loc.startsWith('node:')) continue;
    let abs;
    try { abs = loc.startsWith('file:') ? fileURLToPath(loc) : loc; } catch { continue; }
    if (abs === THIS_FILE) continue;
    return { file: repoRelative(abs), func: func || 'anonymous', line: Number(line) };
  }
  return { file: 'unknown', func: 'anonymous', line: null };
}

// --- Version ------------------------------------------------------------------------------------
// The running build, for the before/after-deploy queries. Explicit env wins; otherwise ask git,
// once, at boot. Reading `.git/HEAD` directly was the first attempt and it returns null in a
// linked worktree (`.git` is a file pointing elsewhere) and against a packed ref — exactly the
// checkouts this gets developed in. `git rev-parse` knows all of that; it is one short-lived
// subprocess at startup, never on the request path, and any failure (no git, packaged install,
// tarball deploy) falls through to the package version and then to null.
function resolveVersion() {
  if (APP_VERSION) return APP_VERSION;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { /* not a checkout, or no git on PATH — fall through */ }
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// --- Schema ---------------------------------------------------------------------------------------
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    ts          TEXT    NOT NULL,
    ts_ms       INTEGER NOT NULL,
    level       TEXT    NOT NULL,
    event       TEXT    NOT NULL,
    msg         TEXT,
    file        TEXT    NOT NULL,
    func        TEXT    NOT NULL,
    line        INTEGER,
    run_id      TEXT    NOT NULL,
    trace_id    TEXT,
    span_id     TEXT,
    parent_span TEXT,
    duration_ms REAL,
    ok          INTEGER,
    err_type    TEXT,
    err_msg     TEXT,
    stack       TEXT,
    data        TEXT,
    app         TEXT    NOT NULL,
    version     TEXT,
    pid         INTEGER,
    host        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts_ms);
  CREATE INDEX IF NOT EXISTS idx_events_level_ts  ON events(level, ts_ms);
  CREATE INDEX IF NOT EXISTS idx_events_event_ts  ON events(event, ts_ms);
  CREATE INDEX IF NOT EXISTS idx_events_trace     ON events(trace_id);
  CREATE INDEX IF NOT EXISTS idx_events_file_func ON events(file, func);
  CREATE INDEX IF NOT EXISTS idx_events_duration  ON events(duration_ms) WHERE duration_ms IS NOT NULL;
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

const INSERT_SQL = `INSERT INTO events
  (ts, ts_ms, level, event, msg, file, func, line, run_id, trace_id, span_id, parent_span,
   duration_ms, ok, err_type, err_msg, stack, data, app, version, pid, host)
  VALUES (@ts,@ts_ms,@level,@event,@msg,@file,@func,@line,@run_id,@trace_id,@span_id,@parent_span,
          @duration_ms,@ok,@err_type,@err_msg,@stack,@data,@app,@version,@pid,@host)`;

// --- Logger ---------------------------------------------------------------------------------------
// A stack with its first line (the message) removed — see errorTyped.
const stackFrames = (e) => {
  if (!e?.stack) return null;
  const frames = e.stack.split('\n').filter((l) => /^\s*at\s/.test(l));
  return frames.length ? frames.join('\n') : null;
};

const newTraceId = () => randomBytes(16).toString('hex'); // W3C shape: 32 hex
const newSpanId = () => randomBytes(8).toString('hex');   // W3C shape: 16 hex

export class Logger {
  #db = null;
  #insert = null;
  #queue = [];
  #timers = [];
  #onExit = null;
  #closed = false;

  /** `enabled:false` yields a fully inert logger — every method is still callable and does nothing. */
  constructor({ dbPath = EVENTS_DB_PATH, app = APP_NAME, enabled = EVENTS_LOG_ENABLED,
                level = EVENTS_LOG_LEVEL, retentionDays = EVENTS_RETENTION_DAYS,
                flushMs = EVENTS_FLUSH_MS, pruneIntervalMs = EVENTS_PRUNE_INTERVAL_MS,
                version } = {}) {
    this.app = app;
    this.runId = newSpanId();
    this.enabled = enabled;
    // Resolved lazily and only when enabled — resolveVersion() spawns `git rev-parse`, and a
    // default-parameter call would pay for it in every test process that disables the logger.
    this.version = version ?? (enabled ? resolveVersion() : null);
    this.minLevel = LEVELS[level] ?? LEVELS.INFO;
    this.retentionDays = retentionDays;
    this.als = new AsyncLocalStorage();
    if (!enabled) return;
    try {
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
      this.#db = new Database(dbPath);
      // Set BEFORE the schema exists — auto_vacuum cannot be changed on a populated DB without a
      // full VACUUM. This is what lets prune() reclaim space in bounded slices (see prune).
      this.#db.pragma('auto_vacuum = INCREMENTAL');
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = NORMAL');
      this.#db.pragma('busy_timeout = 5000');
      this.#db.exec(SCHEMA_SQL);
      this.#db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      this.#insert = this.#db.prepare(INSERT_SQL);
      this.#timers.push(setInterval(() => this.flush(), flushMs).unref());
      this.#timers.push(setInterval(() => this.prune(), pruneIntervalMs).unref());
      // Kept on the instance so close() can detach it — a test that builds several loggers would
      // otherwise trip Node's max-listeners warning and leak them for the life of the process.
      this.#onExit = () => this.flush();
      process.on('exit', this.#onExit);
      this.prune();
    } catch (err) {
      // A logger that can't open its store must not take the server down with it (SKILL rule 7).
      this.enabled = false;
      this.#db = null;
      console.error('logger: disabled — could not open the event store:', err.message);
    }
  }

  // --- Trace context ---
  /** Run `fn` under a fresh (or supplied) trace. Everything it awaits inherits the correlation. */
  withTrace(fn, traceId = newTraceId(), spanId = null) {
    return this.als.run({ traceId, spanId }, fn);
  }

  /**
   * Emit an already-measured span. `span()`/`spanSync()` cover the common case where the work is
   * a function call; this covers the case where start and end are separated by an EVENT — the
   * HTTP boundary begins in a middleware and ends on `res.on('finish')`, which cannot be
   * expressed as wrapping a callable. The caller owns the ids so the row lands on the same trace
   * the request ran under (an event listener does not inherit the registrant's ALS context).
   */
  emitSpan(event, { level = 'INFO', msg = 'span completed', traceId, spanId, parentSpan = null,
                    durationMs, ok = true, data, errType, errMsg, stack, where } = {}) {
    this.#write(level, event, msg, { traceId, spanId, parentSpan, durationMs, ok, data, errType, errMsg, stack, where });
  }

  /** The ambient {traceId, spanId}, or null outside any traced work. */
  context() {
    return this.als.getStore() ?? null;
  }

  // --- Emit ---
  #write(level, event, msg, opts = {}) {
    if (!this.enabled || this.#closed) return;
    if ((LEVELS[level] ?? LEVELS.INFO) < this.minLevel) return;
    try {
      const ctx = this.als.getStore();
      // `where` is supplied by span()/spanSync(), which capture it before the work starts — by the
      // time a span's row is written the original call stack is gone (see callerLocation).
      const { file, func, line } = opts.where ?? callerLocation();
      const now = Date.now();
      let data = null;
      if (opts.data !== undefined && opts.data !== null) {
        // Over-length `data` is REPLACED, not clipped: queries.sql reaches into this column with
        // json_extract, and a string cut mid-object is invalid JSON that would fail silently.
        const json = JSON.stringify(redact(opts.data));
        data = json == null ? null : (json.length > MAX_DATA ? JSON.stringify({ truncated_bytes: json.length }) : json);
      }
      this.#queue.push({
        ts: new Date(now).toISOString(), ts_ms: now, level, event,
        msg: msg == null ? null : clip(scrubText(msg, MAX_MSG), MAX_MSG),
        file, func, line,
        run_id: this.runId,
        trace_id: opts.traceId ?? ctx?.traceId ?? null,
        span_id: opts.spanId ?? null,
        parent_span: opts.parentSpan ?? null,
        duration_ms: opts.durationMs ?? null,
        ok: opts.ok === undefined ? null : (opts.ok ? 1 : 0),
        err_type: opts.errType ?? null,
        err_msg: opts.errMsg == null ? null : scrubText(opts.errMsg, MAX_ERR_MSG),
        stack: opts.stack == null ? null : scrubText(opts.stack, MAX_STACK),
        data,
        app: this.app, version: this.version, pid: process.pid, host: hostname(),
      });
    } catch (err) {
      console.error('logger: write failed:', err.message);
    }
  }

  trace(event, msg, data) { this.#write('TRACE', event, msg, { data }); }
  debug(event, msg, data) { this.#write('DEBUG', event, msg, { data }); }
  info(event, msg, data) { this.#write('INFO', event, msg, { data }); }
  warn(event, msg, data) { this.#write('WARN', event, msg, { data }); }

  /**
   * An ERROR row must be self-sufficient (SKILL rule 20) and logged exactly once, where the
   * exception is handled (rule 19) — not again at every rethrow. `err` may be any thrown value.
   */
  error(event, msg, err, data) {
    const e = err instanceof Error ? err : err == null ? null : new Error(String(err));
    this.#write('ERROR', event, msg, {
      data, errType: e?.name ?? null, errMsg: e?.message ?? null, stack: e?.stack ?? null,
    });
  }

  /**
   * An ERROR row for a boundary whose errors are KNOWN to embed user text in the message, or whose
   * origin is unknowable. Drops `err_msg` and reduces `stack` to its FRAMES.
   *
   * Needed because the deny-list protects `data`, not an exception's own message, and this codebase
   * builds messages like `no entity named "<name>"` (resolveEntityRef) and `"<name>" is not in the
   * contact directory` (promoteDirectoryName) — so a plain error() at those call sites writes a
   * contact's name straight into `err_msg`, and into `stack`, whose first line IS the message
   * (Copilot, PR #333). Frames are code locations, already repo-relative, and carry no user data,
   * so "where did this come from" survives; `code` is the diagnostic that actually matters.
   */
  errorTyped(event, msg, err, data) {
    const e = err instanceof Error ? err : null;
    this.#write('ERROR', event, msg, {
      data: { ...(data ?? {}), code: e?.code ?? null },
      errType: e?.name ?? null, errMsg: null, stack: stackFrames(e),
    });
  }

  // --- Spans ---
  /**
   * Wrap an async operation as a span: one row on completion carrying `duration_ms` and `ok`,
   * nested under the ambient span. Success is INFO, not DEBUG — DEBUG is off in prod, and latency
   * data you can't see in prod is the data you needed. Failure is an ERROR row and the error is
   * rethrown; the span is the single log of it, so a caller that also catches must not re-log.
   *
   * `data` is serialized when the span CLOSES, so passing a live object and mutating it inside
   * `fn` is the supported way to record an outcome (a result count, a chosen branch) on the same
   * row that measured the work — see hybridSearch.
   */
  async span(event, fn, data) {
    if (!this.enabled) return fn();
    const ctx = this.als.getStore();
    const traceId = ctx?.traceId ?? newTraceId();
    const parentSpan = ctx?.spanId ?? null;
    const spanId = newSpanId();
    // Captured HERE, on the caller's own stack. After the first await the stack is a microtask
    // continuation and the row would be attributed to node:internal/process/task_queues.
    const where = callerLocation();
    const start = performance.now();
    return this.als.run({ traceId, spanId }, async () => {
      try {
        const result = await fn();
        this.#write('INFO', event, 'span completed',
          { traceId, spanId, parentSpan, where, durationMs: performance.now() - start, ok: true, data });
        return result;
      } catch (err) {
        this.#write('ERROR', event, 'span failed', {
          traceId, spanId, parentSpan, where, durationMs: performance.now() - start, ok: false, data,
          errType: err?.name ?? 'Error', errMsg: err?.message ?? String(err), stack: err?.stack ?? null,
        });
        throw err;
      }
    });
  }

  /**
   * The synchronous twin. Required, not a convenience: better-sqlite3 is synchronous and
   * hybridSearch's candidate-fill -> KNN -> FTS stretch must stay await-free so a concurrent
   * search can't refill the shared TEMP candidate table between this call's fill and its reads
   * (#227). An async span there would reintroduce exactly that interleaving.
   */
  spanSync(event, fn, data) {
    if (!this.enabled) return fn();
    const ctx = this.als.getStore();
    const traceId = ctx?.traceId ?? newTraceId();
    const parentSpan = ctx?.spanId ?? null;
    const spanId = newSpanId();
    // Same reason as span(): the writes below run inside the als.run callback, so without this the
    // nearest non-logger frame is AsyncLocalStorage.run rather than the query's actual call site.
    const where = callerLocation();
    const start = performance.now();
    return this.als.run({ traceId, spanId }, () => {
      try {
        const result = fn();
        this.#write('INFO', event, 'span completed',
          { traceId, spanId, parentSpan, where, durationMs: performance.now() - start, ok: true, data });
        return result;
      } catch (err) {
        this.#write('ERROR', event, 'span failed', {
          traceId, spanId, parentSpan, where, durationMs: performance.now() - start, ok: false, data,
          errType: err?.name ?? 'Error', errMsg: err?.message ?? String(err), stack: err?.stack ?? null,
        });
        throw err;
      }
    });
  }

  // --- Store maintenance ---
  /** Drain the queue in one transaction. Never throws; a failed batch is dropped, not retried. */
  flush() {
    if (!this.#db || this.#queue.length === 0) return 0;
    const batch = this.#queue.splice(0);
    try {
      this.#db.transaction((rows) => { for (const r of rows) this.#insert.run(r); })(batch);
      return batch.length;
    } catch (err) {
      console.error('logger: flush failed, dropped', batch.length, 'row(s):', err.message);
      return 0;
    }
  }

  /**
   * Retention (SKILL rule 9) — wired, not documented: this service runs continuously and would
   * otherwise grow an unbounded store.
   *
   * Reclaim is `incremental_vacuum`, NOT `VACUUM`. A full VACUUM rewrites the entire file while
   * holding a write lock, and this runs in-process on a live server — on a month of continuous
   * spans that is a multi-second event-loop stall for no benefit, since a rolling window reaches
   * steady state anyway (new inserts reuse the pages the DELETE freed). The incremental form is
   * bounded to a page budget per pass. On a store created before auto_vacuum was set it is simply
   * a no-op, which is harmless — freelist reuse still happens.
   */
  prune(days = this.retentionDays) {
    if (!this.#db || !days || days <= 0) return 0;
    try {
      const cutoff = Date.now() - days * 86_400_000;
      const { changes } = this.#db.prepare('DELETE FROM events WHERE ts_ms < ?').run(cutoff);
      if (changes > 0) this.#db.pragma(`incremental_vacuum(${VACUUM_PAGE_BUDGET})`);
      return changes;
    } catch (err) {
      console.error('logger: prune failed:', err.message);
      return 0;
    }
  }

  /** Flush and close. Idempotent; safe to call on a disabled logger. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    if (this.#onExit) { process.off('exit', this.#onExit); this.#onExit = null; }
    if (!this.#db) return;
    try { this.#db.transaction((rows) => { for (const r of rows) this.#insert.run(r); })(this.#queue.splice(0)); }
    catch (err) { console.error('logger: final flush failed:', err.message); }
    try { this.#db.close(); } catch { /* already closed */ }
    this.#db = null;
  }
}

/**
 * The process-wide logger. Constructed at import like `db` in db.js, so every module shares one
 * store, one run_id, and one AsyncLocalStorage instance — a second instance would hand out a
 * second, invisible trace context.
 */
export const log = new Logger();

export { newTraceId, newSpanId };
