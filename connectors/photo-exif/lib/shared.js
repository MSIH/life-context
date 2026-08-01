// Shared by scan.js, caption-worker.js, and face-worker.js. All three must compute the
// (source, source_id) key identically (keyForMedia below) — a mismatch would silently create
// duplicate artifacts instead of upserting the same one.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

// No default `dir` — this module lives in lib/, one level below scan.js/caption-worker.js,
// so defaulting to *this* module's own directory would look for photo-exif/lib/.env instead
// of photo-exif/.env. Callers must pass their own directory explicitly.
export function loadDotEnvIfPresent(dir) {
  const envPath = path.join(dir, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] === undefined) process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.3gpp']);

// The core artifact type for a media file — both 'photo' and 'video' are registered ingest
// types. A consolidated scan (a Google Takeout export especially) mixes both; a video must not
// be stored as a photo.
export function mediaType(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 'video' : 'photo';
}

// Manual recursive walk rather than fs.readdir's `recursive` option — that option needs
// Node 20.1+; this connector has zero native dependencies, so it's worth the extra lines to
// keep a genuinely-true `>=18` floor (see the engines.node bug Copilot caught in the imessage
// connector's package.json — this avoids repeating it).
//
// `root` stays fixed across the whole recursion (only `dir` advances) — relPath must always be
// relative to the original scan root, never to the current subdirectory, or two files with the
// same name in different subfolders (e.g. two years' "IMG_1234.jpg") collide onto the same
// source_id and silently overwrite each other via upsert instead of being two artifacts.
export async function* walkImageFiles(root, dir = root) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // An unreadable subdirectory (permissions, broken symlink, transient IO) skips just that
    // directory, not the whole scan — mirrors scan.js's per-file tolerance.
    console.error(`photo-exif: skipping unreadable directory ${dir}`, err);
    return;
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkImageFiles(root, absPath);
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield { absPath, relPath: path.relative(root, absPath).split(path.sep).join('/') };
    }
  }
}

// Images + videos, mirroring walkImageFiles exactly (same root-relative relPath discipline — see
// the note above). scan.js walks media so videos ingest too; the caption/face workers keep
// walking images only (a video gets no caption/face pass).
export async function* walkMediaFiles(root, dir = root) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`photo-exif: skipping unreadable directory ${dir}`, err);
    return;
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMediaFiles(root, absPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
        yield { absPath, relPath: path.relative(root, absPath).split(path.sep).join('/') };
      }
    }
  }
}

// The (source, source_id) key for a media file, derived from its content hash — the id is
// reproducible from the bytes (doc 04 §3), so it dedups Takeout's same-photo-in-many-folders
// duplication and survives folder renames. A file from a Google Takeout export keys under
// source='google-photos' with a `gphotos:`-prefixed id (this MUST match the rows the retired
// gphotos-takeout connector wrote, so a re-scan upserts them rather than duplicating); everything
// else keys under source='photo-exif' with the bare hash. `isTakeout` is a scan-level fact
// (isTakeoutRoot below), NOT per-file sidecar presence — Takeout omits a sidecar for some items
// (motion-photo .MP4s, etc.), and keying those generic would duplicate the google-photos row
// (#176). All three scripts use this so a photo keys identically no matter which one touches it.
export function keyForMedia(contentHash, isTakeout) {
  return isTakeout
    ? { source: 'google-photos', source_id: `gphotos:${contentHash}` }
    : { source: 'photo-exif', source_id: contentHash };
}

// Whether a scan root is a Google Takeout "Google Photos" export — decided ONCE per scan, not per
// file (a Takeout item may have no sidecar; per-file detection mis-keys those, #176). Signals: the
// root IS a "Google Photos" dir; a direct child is "Google Photos", a "Photos from <YYYY>" year
// bucket, or a `metadata.json`; OR an immediate child dir carries its own `metadata.json` — the
// common album layout where PHOTO_ROOT holds one folder per album (#177). `override` (the
// PHOTO_TAKEOUT env value) forces the answer when 'true'/'false'.
export function isTakeoutRoot(root, override) {
  if (override === 'true') return true;
  if (override === 'false') return false;
  if (!root) return false;
  if (path.basename(root) === 'Google Photos') return true;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === 'metadata.json') return true;
    if (e.isDirectory()) {
      if (e.name === 'Google Photos' || /^Photos from \d{4}$/.test(e.name)) return true;
      // Album layout: each album is a child dir with its own metadata.json (a cheap existsSync
      // per child — a non-Takeout library's folders just miss it).
      if (existsSync(path.join(root, e.name, 'metadata.json'))) return true;
    }
  }
  return false;
}

export function contentHashOfFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function ingestClient({ url, apiKey }) {
  async function postIngest(payload) {
    const res = await fetch(`${url}/api/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`ingest returned ${res.status}`);
    return res.json();
  }

  async function postIngestBatch(payloads) {
    const res = await fetch(`${url}/api/v1/ingest/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ artifacts: payloads }),
    });
    if (!res.ok) throw new Error(`ingest batch returned ${res.status}`);
    return res.json();
  }

  // Read-only existence check (#198): which of these source_ids core already has, so scan.js can
  // skip the expensive EXIF-read + ingest for already-stored files. Returns `{ exists: [...] }`, or
  // `null` on 404 — the signal that core predates the endpoint, so the caller falls back to full
  // processing rather than hard-failing an upgraded connector against an older server. Other non-ok
  // statuses throw (like postIngestBatch) — a 500 is a real error, not a reason to skip the check.
  async function postExists({ source, source_ids }) {
    const res = await fetch(`${url}/api/v1/exists`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ source, source_ids }),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`exists returned ${res.status}`);
    return res.json();
  }

  return { postIngest, postIngestBatch, postExists };
}

// #84 — photographed contacts (entity_id/name/raw_path) for face-worker's suggest-labels
// reference-face matching. Read-only GET, mirrors the ingestClient fetch-wrapper style above.
export async function fetchContactPhotos({ url, apiKey, limit }) {
  // The server's ContactPhotosQuerySchema requires a POSITIVE integer (src/server.js) — 0 or
  // negative isn't "no limit", it's a 400. Omit the param for anything that isn't a valid value
  // rather than sending it and letting the server reject it.
  const qs = Number.isInteger(limit) && limit > 0 ? `?limit=${encodeURIComponent(limit)}` : '';
  const res = await fetch(`${url}/api/v1/entities/photos${qs}`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`entities/photos returned ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.contacts)) throw new Error('entities/photos returned an unexpected response shape');
  // Per-entry shape check too, not just "is it an array" — an unexpected payload (schema drift,
  // a proxy/error page that still happens to parse as JSON) should fail loudly here with a clear
  // message, not surface later as `undefined` fed into face detection.
  const malformed = body.contacts.filter(
    (c) => !c || typeof c.raw_path !== 'string' || typeof c.entity_id !== 'number' || typeof c.name !== 'string'
  );
  if (malformed.length) {
    throw new Error(`entities/photos returned ${malformed.length} malformed contact entr${malformed.length === 1 ? 'y' : 'ies'}`);
  }
  return body.contacts;
}
