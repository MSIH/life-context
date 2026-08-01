// Shared by scan.js and ocr-worker.js. Both scripts must compute source_id and statKey
// identically — a mismatch would silently create duplicate artifacts (source_id) or drop the
// whole OCR backlog as "stale" (statKey), so both live here as the single owner.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

// No default `dir` — this module lives in lib/, one level below scan.js/ocr-worker.js,
// so defaulting to *this* module's own directory would look for documents/lib/.env instead
// of documents/.env. Callers must pass their own directory explicitly.
export function loadDotEnvIfPresent(dir) {
  const envPath = path.join(dir, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    // trim() before quote-stripping: the greedy capture keeps trailing spaces, and an
    // invisible trailing space in LIFECONTEXT_API_KEY would 401 every request.
    if (process.env[key] === undefined) process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}

// Numeric env parsing: `|| dflt` would override an explicit 0 (0 is falsy), and Number('')
// is 0 — so a set-but-blank line must mean "unset", while an explicit 0 is a real value.
export function envNumber(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const value = Number(raw);
  return Number.isFinite(value) ? value : dflt;
}

// text_repr sizing, shared so wave-1 (scan.js) and the OCR wave (ocr-worker.js) can never
// drift onto different budgets for the same artifact. The char ceiling plus the byte cap in
// text-repr.js together guarantee any single payload fits the server's 256KB request limit.
export const TEXT_REPR_CEILING_CHARS = 100000;
export function textReprMaxChars() {
  return Math.min(envNumber('DOCUMENTS_TEXT_REPR_MAX_CHARS', 12000), TEXT_REPR_CEILING_CHARS);
}

// The leading slice of an artifact's text_repr that vendor-worker.js feeds to the extractor (#123).
// Vendor/amount/date sit at the top of a bill/receipt, so a bounded head focuses the model and keeps
// it fast. This caps only the LLM INPUT — the full text_repr is still resent on the upsert unchanged.
// Default 4000 chars; env-overridable.
export const EXTRACT_TEXT_CEILING_CHARS = 20000;
export function extractTextMaxChars() {
  return Math.min(envNumber('DOCUMENTS_EXTRACT_MAX_CHARS', 4000), EXTRACT_TEXT_CEILING_CHARS);
}

export const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

// Manual recursive walk rather than fs.readdir's `recursive` option — that option needs
// Node 20.1+ and this connector's floor is 20.0 (pdfjs-dist declares >=20; unlike its
// siblings this connector can't honestly claim 18).
//
// `root` stays fixed across the whole recursion (only `dir` advances) — relPath must always be
// relative to the original scan root, never to the current subdirectory, or two files with the
// same name in different subfolders (e.g. two years' "report.pdf") collide onto the same
// source_id and silently overwrite each other via upsert instead of being two artifacts.
export async function* walkDocumentFiles(root, dir = root) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // One unlistable subdirectory (Windows "System Volume Information", an EPERM ACL) must
    // skip that subtree, not abort the walk — the throw would surface at the caller's
    // for-await, outside its per-file error handling.
    console.error(`documents: skipping unreadable directory ${dir}`, err);
    return;
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDocumentFiles(root, absPath);
    } else if (entry.isFile() && DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield { absPath, relPath: path.relative(root, absPath).split(path.sep).join('/') };
    }
  }
}

// The relative path (POSIX-normalized so it's stable across OSes) IS the source_id — it's
// reproducible from the source data itself (doc 04 §3), simple, and debuggable. A document
// tree reorganized after the first scan orphans history the same way renaming any connector's
// `source` would — documented in README.md, not silently handled.
export function sourceIdFor(relPath) {
  return relPath;
}

// The unchanged-file cache key AND the OCR-queue staleness key — scan.js writes it, the
// worker compares it. Changing the format in one place only would silently drop the whole
// OCR backlog as "stale".
export function statKeyOf(stat) {
  return `${stat.mtimeMs}:${stat.size}`;
}

// Every extractor already buffers the whole file (bounded by DOCUMENTS_MAX_FILE_MB), so the
// hash reuses that buffer instead of a second full read from disk.
export function contentHashOfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// --- JSON state files (manifest, OCR queue) ---

export function readJsonFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {}; // no state file yet — first run
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // A corrupt state file must be loud: for the OCR queue it is the only record of pending
    // work, so silently treating it as empty would discard the backlog with no trace.
    console.error(`documents: state file ${filePath} is corrupt, starting empty`, err);
    return {};
  }
}

// Atomic write (temp + rename in the same directory) so a kill mid-write can never leave
// truncated JSON — "kill-safe at any point" is only true if the write itself is.
export function writeJsonFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value));
  renameSync(tmpPath, filePath);
}

// Read-mutate-write against the CURRENT file contents, not a run-start snapshot. scan.js and
// ocr-worker.js can be scheduled to overlap (README's cron staggers them 15 minutes apart —
// a backfill scan runs longer); each side applying its own adds/deletes to a fresh read
// shrinks the lost-update window from a whole run to microseconds. (Fully eliminating it
// needs per-entry files — doc 04 §7's spool caveat — not worth it yet.)
export function updateJsonFile(filePath, mutate) {
  const value = readJsonFile(filePath);
  mutate(value);
  writeJsonFile(filePath, value);
  return value;
}

// --- ingest client ---

export const BATCH_MAX = 100; // contract cap (docs/04-connector-contract.md §2)
// The ingest API rejects request bodies over 256KB; document text_reprs are big enough that
// 100 of them can blow past that where photo-exif's one-liners never could, so groups are cut
// by serialized size as well as count. 200KB leaves margin for the envelope and JSON escaping.
export const BATCH_BYTE_BUDGET = 200 * 1024;

// Groups pending items ({ payload, ... }) into batches that respect BOTH caps. Single-payload
// size is bounded by text-repr.js's byte cap (PAYLOAD_TEXT_BYTE_CAP < this budget).
export function chunkByBudget(pending) {
  const groups = [];
  let group = [];
  let bytes = 0;
  for (const item of pending) {
    const size = Buffer.byteLength(JSON.stringify(item.payload));
    if (group.length && (group.length >= BATCH_MAX || bytes + size > BATCH_BYTE_BUDGET)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(item);
    bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000]; // doc 04 §7: respect 429s with exponential backoff

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ingestClient({ url, apiKey }) {
  // Throws Error with .status set (0 for network errors) so callers can tell a per-item
  // 4xx from "server unreachable" and react differently.
  async function post(route, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${url}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const wrapped = new Error(`ingest ${route} unreachable: ${err.message}`);
        wrapped.status = 0;
        throw wrapped;
      }
      if (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`ingest ${route} returned ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
  }

  return {
    postIngest: (payload) => post('/api/v1/ingest', payload),
    postIngestBatch: (payloads) => post('/api/v1/ingest/batch', { artifacts: payloads }),
  };
}
