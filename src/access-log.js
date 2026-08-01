/**
 * Access logging for every HTTP surface (/api, /mcp, /ui) — #178.
 *
 * One request-logging middleware, mounted early (after `trust proxy`, before the routes) that
 * logs on `res.on('finish')`: UTC timestamp, surface tag (api/mcp/ui), method, redacted path,
 * status, latency ms, the real client IP (via `trust proxy`, not the tunnel's 127.0.0.1), and an
 * auth outcome. This is the single funnel — every route flows through it. For a server exposed on
 * the internet (Cloudflare Tunnel — docs/07) this is how a probe/brute-force against the key or the
 * capability tokens becomes visible; 401 / wrong-capability-token 404 / 429 are also surfaced to
 * stderr at warn.
 *
 * SECRET REDACTION IS MANDATORY (coding-standards: never log a secret). Before any line is written,
 * `redactPath` scrubs the `?api_key=` query param and the capability tokens embedded in the path
 * (`/<token>/mcp`, `/<token>/ui/…` — requirePathToken / requireUiPathToken in server.js) → `<token>`.
 * Header/body credentials and request/response BODIES are NEVER logged (privacy — metadata only).
 *
 * Writes are buffered/non-blocking (a per-day append WriteStream), so logging never delays a
 * response. Daily files `access-YYYY-MM-DD.log` (UTC date) give cheap retention: `pruneOldLogs`
 * deletes files older than the window at boot. `ensureCompressed` turns on NTFS compression on the
 * dir (Windows `compact /c`, best-effort; a no-op elsewhere) so the highly-compressible text logs
 * take a fraction of the disk, and new daily files inherit it.
 *
 * This file's OWN failures (stream error, unwritable dir, a failed compact) go to the ops event
 * store instead of the console (#328) — they are ops facts worth querying. The 401/429/probe warn
 * on line ~115 deliberately stays on stderr: that is this subsystem's security-alerting channel,
 * not error handling, and every request is already a row in the event store via the trace boundary.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ACCESS_LOG_DIR } from './config.js';
import { log } from './logger.js';

// Capability-URL shapes whose FIRST path segment is a secret token: /<token>/mcp and /<token>/ui/…
// (server.js's requirePathToken / requireUiPathToken mounts). The token segment is replaced with
// the literal <token> so no secret ever reaches a log line. A single-segment /mcp (header-auth) has
// no token to scrub and does not match.
const TOKEN_PATH_RE = /^\/[^/]+\/(mcp|ui)(?=$|\/)/;
const DATED_FILE_RE = /^access-(\d{4}-\d{2}-\d{2})\.log$/;

const logDir = path.resolve(ACCESS_LOG_DIR);

// Redact secrets from a request URL (path + query). Never mutates the request — the returned string
// is only ever written to the log. The `api_key` query value is replaced; a capability path token is
// replaced with <token>. Everything else is preserved verbatim so the line stays diagnostic.
export function redactPath(originalUrl) {
  if (typeof originalUrl !== 'string') return String(originalUrl ?? '');
  const q = originalUrl.indexOf('?');
  let pathPart = q === -1 ? originalUrl : originalUrl.slice(0, q);
  const queryPart = q === -1 ? undefined : originalUrl.slice(q + 1);
  pathPart = pathPart.replace(TOKEN_PATH_RE, '/<token>/$1');
  if (queryPart === undefined) return pathPart;
  const scrubbed = queryPart.split('&').map((kv) => {
    const eq = kv.indexOf('=');
    const key = eq === -1 ? kv : kv.slice(0, eq);
    return key.toLowerCase() === 'api_key' ? `${key}=<redacted>` : kv;
  }).join('&');
  return `${pathPart}?${scrubbed}`;
}

// Which surface a request hit, from its (raw) path. Only the classification is ever logged, never
// the raw path — a tokened /<token>/mcp classifies as 'mcp' without the token leaking. Exported so
// the ops-trace boundary (#328, src/logger.js) classifies requests the same way this file does,
// rather than growing a second copy that drifts.
export function surfaceTag(pathname = '') {
  if (/^\/mcp(?=$|\/)/.test(pathname) || /^\/[^/]+\/mcp(?=$|\/)/.test(pathname)) return 'mcp';
  if (/^\/ui(?=$|\/)/.test(pathname) || /^\/[^/]+\/ui(?=$|\/)/.test(pathname)) return 'ui';
  if (/^\/api(?=$|\/)/.test(pathname)) return 'api';
  return '-';
}

// Auth outcome from the final status. A wrong/absent capability token 404s (never 401 — the guards
// hide the endpoint's existence), so a 404 on a tokened /<token>/{mcp,ui} path is a failed-auth probe.
function authOutcome(status, isTokenProbe) {
  if (status === 401 || isTokenProbe) return 'fail';
  if (status === 429) return 'ratelimited';
  if (status >= 200 && status < 400) return 'ok';
  return 'n/a'; // 4xx/5xx where auth wasn't the deciding factor (resource 404, validation 400, 500)
}

// --- Buffered per-day append stream (non-blocking; never on the request's critical path) ---
let streamDate = null;
let stream = null;
let dirReady = false;

function ensureDir() {
  if (dirReady) return;
  mkdirSync(logDir, { recursive: true });
  dirReady = true;
}

function streamForToday() {
  const date = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD — the file rolls at UTC midnight
  if (date !== streamDate) {
    ensureDir();
    if (stream) stream.end();
    stream = createWriteStream(path.join(logDir, `access-${date}.log`), { flags: 'a' });
    stream.on('error', (err) => log.error('access_log.stream.failed', 'access-log write stream error', err));
    streamDate = date;
  }
  return stream;
}

// The middleware. Mount once, first, after `app.set('trust proxy')` and before the rate limiter, so
// req.ip is the real client and 429s are captured too. It registers a finish hook and returns
// immediately — the append happens after the response is sent.
export function accessLogMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // second precision, UTC
      const surface = surfaceTag(req.path);
      const isTokenProbe = res.statusCode === 404 && TOKEN_PATH_RE.test(req.path || '');
      const auth = authOutcome(res.statusCode, isTokenProbe);
      const ip = req.ip || req.socket?.remoteAddress || '-';
      const line = `${ts} ${surface} ${req.method} ${redactPath(req.originalUrl)} ${res.statusCode} ${latencyMs}ms ip=${ip} auth=${auth}`;
      // Probes/limit hits also go to stderr at warn so they surface in the service .err log, not just
      // the flat access file. (The file line format is identical — one funnel, one shape.)
      if (res.statusCode === 401 || res.statusCode === 429 || isTokenProbe) console.warn('access-log', line);
      streamForToday().write(line + '\n');
    } catch (err) {
      log.error('access_log.write.failed', 'could not write an access line', err);
    }
  });
  next();
}

// Delete dated files older than `days` (by the UTC date in the filename — deterministic, independent
// of mtime). A non-positive `days` or a missing dir is a no-op. Returns { pruned, kept }.
export async function pruneOldLogs(dir, days) {
  if (!days || days <= 0) return { pruned: 0, kept: 0 };
  // Cutoff at the UTC-midnight boundary of the oldest day to keep, so exactly `days` dated files
  // (today included) survive. Comparing a file's midnight stamp against Date.now() would prune the
  // oldest in-window day ~half the time (retaining days-1); the date boundary keeps it deterministic.
  const now = new Date();
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1));
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { pruned: 0, kept: 0 };
    throw err;
  }
  let pruned = 0;
  let kept = 0;
  for (const name of entries) {
    const m = DATED_FILE_RE.exec(name);
    if (!m) continue; // never touch non-access files sharing the dir
    const fileTime = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(fileTime)) continue;
    if (fileTime < cutoff) { await unlink(path.join(dir, name)); pruned++; }
    else kept++;
  }
  return { pruned, kept };
}

// Best-effort: make `dir` exist and, on Windows, NTFS-compressed so new daily files inherit
// compression (`compact /c`). Never throws — a failure is logged and logging still works uncompressed.
export function ensureCompressed(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error('access_log.dir.failed', 'could not create the access-log dir', err);
  }
  if (process.platform !== 'win32') return Promise.resolve({ compressed: false, reason: 'not-windows' });
  return new Promise((resolve) => {
    // /c compress, /i ignore errors on individual files, /q quiet. Run on the dir (no /s) so the
    // directory's compressed attribute is set and new files inherit it, without recursing existing ones.
    execFile('compact', ['/c', '/i', '/q', dir], { windowsHide: true }, (err) => {
      if (err) {
        log.error('access_log.compression.failed', 'NTFS compression (compact /c) failed', err);
        resolve({ compressed: false, error: err.message });
        return;
      }
      resolve({ compressed: true });
    });
  });
}

// Flush + close the current day's stream, resolving once its buffered bytes have been written. Call
// on graceful shutdown so a buffered final line isn't lost on exit; a test awaits it to read the file
// it just wrote. Idempotent — a no-op when no stream is open; the next write transparently reopens.
export async function closeAccessLog() {
  if (!stream) return;
  const s = stream;
  stream = null;
  streamDate = null;
  await new Promise((resolve) => {
    // Resolve on error too, so a flush/close failure (disk full, permissions) can't hang shutdown
    // until the 10s forced exit — the callback may never fire if the stream errors.
    s.on('error', resolve);
    s.end(resolve);
  });
}
