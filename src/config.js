/**
 * Single source of config. dotenv.config() runs HERE, before any other module reads
 * process.env — under ESM, imports are hoisted and evaluated before the importing
 * module's body, so loading .env inside each consumer would race. Every module imports
 * its constants from here, guaranteeing .env is loaded first.
 *
 * All values are env-overridable (absolute rule 1). Defaults match the
 * historical hardcoded values so existing installs are unaffected.
 */
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const int = (v, dflt) => {
  if (v === undefined) return dflt;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n; // malformed env → default, never NaN into SQL/search math
};

// Boolean env: only an explicit falsey token turns a default-true flag off; anything else
// (unset, empty, "true", "1", junk) keeps the default. Case-insensitive.
const bool = (v, dflt) => {
  if (v === undefined) return dflt;
  const s = v.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  return dflt;
};

export const PORT = process.env.PORT || 3000;

// Express 'trust proxy' hop count. 1 = one reverse proxy in front (Cloudflare Tunnel —
// docs/07-cloudflare-tunnel-setup.md); harmless for direct localhost use. Set TRUST_PROXY=0
// to never trust forwarded headers (direct-only installs).
export const TRUST_PROXY = int(process.env.TRUST_PROXY, 1);

// Local file store. Overridable via DB_PATH — set it in .env to point at an existing DB.
export const DB_PATH = process.env.DB_PATH || 'life-context.db';

// SQLite busy_timeout (ms): how long a writer waits for a competing writer's lock before throwing
// SQLITE_BUSY. better-sqlite3 defaults to 0 — brief cross-process overlap (a connector POSTing during
// a backfill/migrate) fails instantly; 5s lets a short writer finish first. This only softens transient
// overlap — the single-live-server rule still stands (two long-lived servers share vec/FTS state badly).
export const DB_BUSY_TIMEOUT_MS = int(process.env.DB_BUSY_TIMEOUT_MS, 5000);

// Where contacts.js writes decoded vCard PHOTO bytes (raw_path target). Relative to cwd by
// default so a fresh install just works; override to keep raw originals on a bigger disk.
export const CONTACTS_RAW_DIR = process.env.CONTACTS_RAW_DIR || 'raw/contacts';

// Max bytes accepted by the contacts-UI photo upload (#96). Caps the express.raw body so a
// huge/hostile upload can't exhaust memory; 10 MB comfortably fits a phone photo.
export const CONTACT_PHOTO_MAX_BYTES = int(process.env.CONTACT_PHOTO_MAX_BYTES, 10 * 1024 * 1024);

// --- Embedding / LLM gateway (local Ollama, OpenAI-compatible) ---
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
// Egress guard (#347). This URL is deliberately overridable (absolute rules 1 and 6) and EVERY
// stored text passes through it on its way to a vector, so repointing it at a hosted endpoint would
// ship the whole store to a third party one call at a time — no error, no log, search still working
// perfectly. Pluggability stays; leaving the machine now has to be said out loud. Default-off, and a
// loopback URL (including the default) is unaffected, so existing installs see no change.
export const EMBEDDING_ALLOW_REMOTE = bool(process.env.EMBEDDING_ALLOW_REMOTE, false);
// Loopback = anything that cannot leave this machine: localhost, 127.0.0.0/8, ::1, and the
// unspecified addresses 0.0.0.0 / :: (a connection to those reaches the local host, so refusing them
// would reject a working local install). A trailing dot is the same host in FQDN form. Exported for
// the test. A URL that won't parse counts as NOT loopback: an unparseable endpoint is precisely when
// the guard should be on (fail closed). Known gap, left deliberately: the IPv4-mapped IPv6 form
// (::ffff:127.0.0.1) is refused — it is genuinely loopback but never appears in a real
// OLLAMA_BASE_URL, and the failure message names the opt-in, so the cost is one clear error.
export const isLoopbackUrl = (raw) => {
  let hostname;
  try { hostname = new URL(raw).hostname; } catch { return false; }
  // new URL keeps IPv6 brackets and normalizes the address (so [0:0:0:0:0:0:0:1] arrives as [::1]).
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
};
// The message when the endpoint is off-box and not opted into, else null. Names both variables so
// the fix is in the failure itself; embeddings.js is where it's enforced (one choke point for the
// server, the scripts and the workers alike).
export const embeddingEndpointViolation = () =>
  EMBEDDING_ALLOW_REMOTE || isLoopbackUrl(OLLAMA_BASE_URL)
    ? null
    : 'OLLAMA_BASE_URL is not a loopback address, so the full text of every embedded memory would ' +
      'leave this machine. Set EMBEDDING_ALLOW_REMOTE=true to allow that deliberately, or point ' +
      'OLLAMA_BASE_URL back at localhost.';
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
// MUST equal the embedding model's output length. qwen3-embedding:0.6b -> 1024.
// Changing the model means changing this AND re-embedding (see data-model.md rule 2).
export const VECTOR_DIMENSION = int(process.env.VECTOR_DIMENSION, 1024);
// Chat model used only by the query planner to parse a query into filters. Optional at
// runtime: if it's unreachable, search degrades gracefully to pure semantic (see search.js).
export const QUERY_MODEL = process.env.QUERY_MODEL || 'qwen2.5:3b';
// Request timeout (ms) for the embedding/LLM gateway — a hung Ollama shouldn't block for the SDK's 10-min default.
export const EMBED_TIMEOUT_MS = int(process.env.EMBED_TIMEOUT_MS, 60000);
// Budgets for ONE batched embed call (#408, src/embeddings.js's getEmbeddings/embedManyToFloat32
// for POST /ingest/batch) — named, not magic numbers, and BOTH bounds are enforced (by
// ingest.js's chunker), not just the count: Ollama will happily accept a request that is slow or
// memory-hostile, and a 50x20,000-char batch is a very different (heavier, slower) request than
// 50x200 chars even though both satisfy an item-count cap alone. Mirrors the byte-budget lesson
// from #405 rather than repeating its item-count-only mistake. Per-box tuning knobs like
// EMBED_TIMEOUT_MS above, so env-overridable the same way rather than hardcoded in embeddings.js.
// The char cap binds FIRST for any batch averaging >1,000 chars/item (50_000/50 default) — a
// documents/email connector with longer texts gets chunks smaller than 50, and above ~25,000
// chars/item a chunk degenerates to size 1 (no batching) — never WORSE than today's serial calls,
// just not the full amortization the item-count default implies once texts run long.
// FOUR budgets now bound one backfill, on two independent axes — keep them straight before tuning
// either of these: WIRE size limits what can ARRIVE in one request (ingest.js's JSON_BODY_LIMIT
// 256kb server-side, and connectors/email's MAX_BATCH_BYTES 200kb self-imposed below it, #405),
// while these two limit what LEAVES in one gateway call. They do not constrain each other, and the
// char cap here binds first by a wide margin: a 200kb payload can carry ~200,000 chars of
// text_repr, 4x this 50,000 default, so a wire-legal batch is routinely split into several embed
// chunks. Raising EMBED_BATCH_MAX_CHARS toward the wire cap makes each call slower and must stay
// answerable within EMBED_TIMEOUT_MS (60s), since a chunk-level timeout costs that whole budget
// before the per-item fallback even starts.
export const EMBED_BATCH_MAX_INPUTS = int(process.env.EMBED_BATCH_MAX_INPUTS, 50);   // items/call
export const EMBED_BATCH_MAX_CHARS = int(process.env.EMBED_BATCH_MAX_CHARS, 50_000); // total chars/call
// Query-planner controls (#179, defaults recalibrated #221). The planner is a small JSON call, but
// on a CPU-only host — this project's expected deployment — a 3B model can take >10s, so the default
// must not abandon a plan that would have succeeded. QUERY_PLAN_TIMEOUT_MS bounds the single planner
// attempt; 20000ms is the CPU-host-safe default (a fast/GPU host answers well within it). The
// fail-over-fast rationale still holds for a dead/unreachable planner — just bounded at 20s now.
// QUERY_PLANNER_ENABLED=false skips the LLM call entirely (search behaves like usePlanner:false —
// pure semantic + keyword, sub-second) for a box where the planner never beats even a low timeout.
export const QUERY_PLAN_TIMEOUT_MS = int(process.env.QUERY_PLAN_TIMEOUT_MS, 20000);
export const QUERY_PLANNER_ENABLED = bool(process.env.QUERY_PLANNER_ENABLED, true);
// Cap on planner output tokens — the plan is a tiny JSON and generation time dominates on CPU, so
// bounding it is a big per-search win. 256 is the default (#221): 128 truncated real plans into
// invalid JSON, which silently triggered the same fail-over to pure-semantic.
export const QUERY_PLAN_MAX_TOKENS = int(process.env.QUERY_PLAN_MAX_TOKENS, 256);
// Boot-time warm-up (#247): a cold Ollama load of QUERY_MODEL can alone exceed
// QUERY_PLAN_TIMEOUT_MS, so every query-plan attempt after boot (or after an idle unload) times
// out and silently degrades to pure-semantic. Ollama's OpenAI-compat /v1/chat/completions ignores
// a per-request keep_alive (ollama/ollama#11458), so warmUpQueryModel (search.js) instead hits the
// native /api/generate endpoint, which does honor it. QUERY_MODEL_KEEP_ALIVE is the duration Ollama
// keeps the model resident after that warm-up; QUERY_MODEL_WARMUP_TIMEOUT_MS bounds the one-shot
// warm-up call itself (longer than QUERY_PLAN_TIMEOUT_MS — a cold load is expected to be slow).
export const QUERY_MODEL_KEEP_ALIVE = process.env.QUERY_MODEL_KEEP_ALIVE || '30m';
export const QUERY_MODEL_WARMUP_TIMEOUT_MS = int(process.env.QUERY_MODEL_WARMUP_TIMEOUT_MS, 60000);

// --- Hybrid search tuning ---
export const RRF_K = int(process.env.RRF_K, 60);          // reciprocal-rank-fusion constant
export const KNN_OVERFETCH = int(process.env.KNN_OVERFETCH, 5); // fetch limit*this before fusion/filter
export const KNN_MIN = int(process.env.KNN_MIN, 50);      // floor on k so fusion has depth
export const KNN_MAX = int(process.env.KNN_MAX, 500);     // ceiling on k (perf guard)
export const GEO_RADIUS_DEFAULT_KM = int(process.env.GEO_RADIUS_DEFAULT_KM, 25); // default radius for `near` search (#68)
export const GEO_RADIUS_MAX_KM = int(process.env.GEO_RADIUS_MAX_KM, 500);        // clamp ceiling on radius_km

// --- Rate limiting ---
// apiLimiter max requests/windowMs (#327 — tests override this to clear the shared-limiter
// ceiling). A non-positive or malformed value falls back to the default — same posture as
// ACCESS_LOG_RETENTION_DAYS/EVENTS_RETENTION_DAYS above.
const rateLimitMax = int(process.env.RATE_LIMIT_MAX, 100);
export const RATE_LIMIT_MAX = rateLimitMax > 0 ? rateLimitMax : 100;

// --- Consolidation (nightly daily digests — docs/06-consolidation.md) ---
// Chat model that writes the digest. Roadmap M6 default; any Ollama chat model works.
export const DIGEST_MODEL = process.env.DIGEST_MODEL || 'qwen3:8b';
export const DIGEST_TIMEOUT_MS = int(process.env.DIGEST_TIMEOUT_MS, 120000); // digest is a bigger call than a query parse
export const DIGEST_MAX_ARTIFACTS = int(process.env.DIGEST_MAX_ARTIFACTS, 200); // cap per day so a heavy day can't blow the context
export const DIGEST_TEXT_CLIP = int(process.env.DIGEST_TEXT_CLIP, 500);     // chars of text_repr fed to the model per artifact
export const DIGEST_TIMELINE_DAYS = int(process.env.DIGEST_TIMELINE_DAYS, 14); // timeline spans >= this prefer digests over raw rows

// --- Auth --- (raw value; the server validates it — scripts don't need it)
export const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
export const LIFECONTEXT_API_KEY_PLACEHOLDER = 'change-this-to-a-long-secure-token';

// --- Access logging (all surfaces: /api, /mcp, /ui) — #178 ---
// One request-logging middleware writes a per-request line (method/path/status/IP/latency/surface/
// auth) to a daily file; secrets (the api_key query param, capability path tokens) are redacted and
// request bodies are never logged. Default on; ACCESS_LOG_ENABLED=false (or 0/no/off) disables it.
const accessLogFlag = (process.env.ACCESS_LOG_ENABLED ?? '').trim().toLowerCase();
export const ACCESS_LOG_ENABLED = !(accessLogFlag === 'false' || accessLogFlag === '0' || accessLogFlag === 'no' || accessLogFlag === 'off');
export const ACCESS_LOG_DIR = process.env.ACCESS_LOG_DIR || 'logs/access';
// Days of dated files to keep; boot prunes older. A non-positive value (incl. an explicit 0) or a
// malformed one falls back to the 90-day default (0/unset = keep 90; a positive N prunes older).
const accessLogRetention = int(process.env.ACCESS_LOG_RETENTION_DAYS, 90);
export const ACCESS_LOG_RETENTION_DAYS = accessLogRetention > 0 ? accessLogRetention : 90;

// --- Operational event log (#328, src/logger.js) ---
// A SEPARATE SQLite store holding spans/durations/errors for ops analysis — distinct from the
// access log above (per-request security audit trail) and from the app DB's `ingest_log` (domain
// history of how a memory evolved). Its own file so it can never contend with sqlite-vec/FTS on
// the app DB, never lands in an app-DB backup, and can be deleted wholesale without losing a
// memory. `logs/` and `*.db` are both gitignored, so the default path can't be committed.
export const EVENTS_LOG_ENABLED = bool(process.env.EVENTS_LOG_ENABLED, true);
// Default derives from DB_PATH's basename (#369) so a scratch/test DB_PATH doesn't silently write
// its ops spans into the same logs/events.db as the real server: the default DB_PATH keeps the
// historical 'logs/events.db' byte-identical, and any other DB_PATH defaults to
// logs/events-<basename-without-ext>.db instead. An explicit EVENTS_DB_PATH always wins.
const defaultEventsDbPath = DB_PATH === 'life-context.db'
  ? 'logs/events.db'
  : path.join('logs', `events-${path.basename(DB_PATH, path.extname(DB_PATH))}.db`);
export const EVENTS_DB_PATH = process.env.EVENTS_DB_PATH || defaultEventsDbPath;
// Minimum level written. INFO by default, which is what keeps "DEBUG is off in prod" true rather
// than aspirational; DEBUG/TRACE are added reactively when a specific bug needs the extra state.
export const EVENTS_LOG_LEVEL = (process.env.EVENTS_LOG_LEVEL || 'INFO').trim().toUpperCase();
// Days of rows to keep, pruned at boot and every EVENTS_PRUNE_INTERVAL_MS. A non-positive or
// malformed value falls back to the default — same posture as ACCESS_LOG_RETENTION_DAYS above.
const eventsRetention = int(process.env.EVENTS_RETENTION_DAYS, 30);
export const EVENTS_RETENTION_DAYS = eventsRetention > 0 ? eventsRetention : 30;
export const EVENTS_FLUSH_MS = int(process.env.EVENTS_FLUSH_MS, 200);
export const EVENTS_PRUNE_INTERVAL_MS = int(process.env.EVENTS_PRUNE_INTERVAL_MS, 24 * 60 * 60 * 1000);
// The running build, stamped on every row so "did this deploy introduce a new error class" is a
// query. Unset falls back to the checked-out git SHA (logger.js resolveVersion).
export const APP_VERSION = process.env.APP_VERSION || undefined;

// Optional capability-URL token for the claude.ai web MCP connector, which offers no header
// field (anthropics/claude-ai-mcp #112). Distinct from LIFECONTEXT_API_KEY — it rides in the
// URL path, so it lands in Cloudflare edge/proxy access logs and must be rotatable on its own
// without invalidating the header key CLI/Desktop clients use. Unset (undefined) = feature off:
// every /:token/mcp request 404s exactly like today. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export const MCP_URL_TOKEN = process.env.MCP_URL_TOKEN;

// Optional capability-URL token for the browser web UI (#161, token-only #169) — a distinct secret
// from LIFECONTEXT_API_KEY and MCP_URL_TOKEN so each surface (REST key, MCP capability URL, browser
// UI) rotates independently. When SET, the UI is served ONLY at the token-first capability URL
// /<token>/ui/… (404 otherwise) and requireAuth also accepts it, so the bookmarked page's /api calls
// authorize with no manual key entry. Unset/empty (trimmed) = feature off: there is NO UI mount at
// all — /ui/* and /<anything>/ui/* all 404 (no open /ui mount, even for localhost dev). Like
// MCP_URL_TOKEN it rides in the URL (edge/proxy logs, browser history) — a browser-bookmark
// convenience credential; for exposure, front the tokened UI path (or simply the whole hostname)
// with Cloudflare Access — docs/07. An Access policy scoped to a bare /ui protects nothing, since
// nothing is served there: the only UI route is /<token>/ui/… (server.js's '/:token/ui' mount).
export const UI_URL_TOKEN = (process.env.UI_URL_TOKEN || '').trim() || undefined;
