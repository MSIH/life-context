#!/usr/bin/env node
// Batch-scans a photo archive: EXIF DateTimeOriginal + GPS, sha256 content_hash, minimal
// text_repr — POSTed to LifeContext via /api/v1/ingest/batch. GPS is submitted raw; core
// reverse-geocodes it into place_label server-side (issue #67 — doc 04's transducer split:
// this connector describes, core embeds/resolves). See README.md for setup and the exit test.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkMediaFiles, keyForMedia, isTakeoutRoot, mediaType, contentHashOfFile, ingestClient } from './lib/shared.js';
import { describePhoto, buildTextRepr, readSidecar } from './lib/describe.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const PHOTO_ROOT = process.env.PHOTO_ROOT;
const MANIFEST_PATH = process.env.PHOTO_EXIF_MANIFEST_PATH
  || path.join(os.homedir(), '.life-context', 'photo-exif-manifest.json');
const BATCH_MAX = 100; // contract cap (docs/04-connector-contract.md §2)
// Wall-clock throttle for the progress line + mid-run manifest persistence (#197). A time
// interval (not per-N-files) keeps a steady cadence across both the fast skip-cache prefix and
// the slow hash+EXIF path. 0 disables progress lines and mid-run writes (end-of-run write only).
// Non-numeric or negative → default (a negative would make maybeTick fire every file); the
// Number.isFinite guard matches the caption/face-worker config idiom and keeps an explicit 0.
const intervalRaw = Number(process.env.PHOTO_EXIF_PROGRESS_INTERVAL_MS ?? 30000);
const PROGRESS_INTERVAL_MS = Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : 30000;
// Google Takeout `people[]` are user-curated face tags — high trust, but core caps name/handle
// hints at 0.9 regardless (doc 04 §4), so 0.9 is the effective ceiling we ask for (#152). The
// folder-name pictured hint (a person-named album/folder) rides the same confidence.
const PICTURED_HINT_CONFIDENCE = 0.9;
// Google's year buckets ("Photos from 2019"), never a person — English default only (a
// non-English Takeout names these differently; a documented best-effort limitation).
const YEAR_BUCKET_RE = /^Photos from \d{4}$/;

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeManifest(manifest) {
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  // Atomic write (temp + rename): a kill mid-write must not leave a truncated manifest —
  // readManifest would then parse-fail and return {}, discarding the whole skip cache (the very
  // resume this connector provides). rename is atomic on the same filesystem. (#197)
  const tmp = `${MANIFEST_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest));
  renameSync(tmp, MANIFEST_PATH);
}

// Cheap identity step (#198): stream a sha256 → (source, source_id) upsert key + media type,
// WITHOUT the expensive EXIF read. source_id is exactly what /exists checks, so scan.js hashes
// first, asks core what it already has, then runs the enrich tail only for genuinely new files.
// Google-origin is a scan-level fact (isTakeout), not per-file sidecar presence — Takeout omits a
// sidecar for some items, and keying those generic would duplicate the google-photos row (#176).
// Content-hash keying (never the file path) dedups Takeout's per-album copies (see keyForMedia).
async function keyForFile(absPath, isTakeout) {
  const contentHash = await contentHashOfFile(absPath);
  const { source, source_id } = keyForMedia(contentHash, isTakeout);
  return { contentHash, source, source_id, type: mediaType(path.basename(absPath)) };
}

// Enrich step (#198): the expensive tail — EXIF (describePhoto), Takeout sidecar, folder hints —
// building the full ingest payload from a precomputed `key` (keyForFile). Runs only for files the
// existence check reports as new, so an already-stored library costs a hash per file and nothing more.
async function enrichPayload(absPath, relPath, key) {
  const { date, dateStr, latitude, longitude } = await describePhoto(absPath);
  // Google Takeout sidecar (#152): people tags → entity_hints, and takenTime/geo as a FALLBACK for
  // the common case where Takeout stripped the image's own EXIF. EXIF always wins when present; the
  // sidecar only fills a gap. Best-effort — readSidecar returns null on any miss/parse failure, and
  // text_repr is left EXIF-only (the caption/face workers rebuild it, so names live in entity_hints).
  const sidecar = readSidecar(absPath);
  const { source, source_id, type, contentHash } = key;

  const payload = {
    source,
    source_id,
    type,
    text_repr: buildTextRepr(dateStr, path.basename(absPath), type),
    content_hash: contentHash,
    raw_path: absPath,
    extra: { captioned: false },
  };
  // occurred_at is when the photo was TAKEN, never a mtime/import-time guess — doc 04 §3 is
  // explicit that a 2019 photo imported today must still sort into 2019, so an unknown date
  // is omitted (and warned on) rather than approximated with something that's actively wrong.
  const occurred = date ?? sidecar?.takenTime ?? null;
  if (occurred) payload.occurred_at = occurred.toISOString();
  const lat = latitude ?? sidecar?.latitude ?? null;
  const lon = longitude ?? sidecar?.longitude ?? null;
  if (lat != null && lon != null) {
    payload.latitude = lat;
    payload.longitude = lon;
  }
  // Pictured-name hints from two sources: the sidecar's people[] (authoritative for Google
  // photos) and the immediate containing folder name (a person-named album/folder — this is what
  // lets a JSON-less photo in ".../Aunt Mary/" map to that person; a non-person folder simply
  // won't resolve core-side, harmless). A file directly in PHOTO_ROOT emits no folder hint, and a
  // Takeout year bucket is never a person. The folder hint is deduped against sidecar names.
  const names = [...(sidecar?.names ?? [])];
  if (relPath.includes('/')) {
    const folder = path.basename(path.dirname(absPath));
    if (!YEAR_BUCKET_RE.test(folder) && !names.some((n) => n.toLowerCase() === folder.toLowerCase())) {
      names.push(folder);
    }
  }
  const hints = names.map((name) => ({
    alias: name, alias_type: 'name', role: 'pictured', confidence: PICTURED_HINT_CONFIDENCE,
  }));
  if (hints.length) payload.entity_hints = hints;
  return payload;
}

// Two byte-identical copies of one photo (Takeout puts a photo in its year bucket AND every album
// it's in) share a content hash → the same source_id. Collapse them into one payload, unioning the
// pictured hints (dedup by alias|role) and filling a missing occurred_at / coordinate from a later
// copy that has it; the first copy's other fields win.
function mergePayloads(base, dup) {
  const merged = [...(base.entity_hints ?? [])];
  // Delimiter-free composite key — a JSON tuple can't collide the way `${alias}|${role}` could if
  // an alias ever contained the delimiter.
  const hintKey = (h) => JSON.stringify([h.alias, h.role]);
  const seen = new Set(merged.map(hintKey));
  for (const h of dup.entity_hints ?? []) {
    const key = hintKey(h);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(h);
    }
  }
  if (merged.length) base.entity_hints = merged;
  if (base.occurred_at == null && dup.occurred_at != null) base.occurred_at = dup.occurred_at;
  if (base.latitude == null && dup.latitude != null) {
    base.latitude = dup.latitude;
    base.longitude = dup.longitude;
  }
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('photo-exif: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }

  // Decide Google-origin ONCE for the whole scan (not per file) — see keyForMedia/#176.
  const isTakeout = isTakeoutRoot(PHOTO_ROOT, process.env.PHOTO_TAKEOUT);
  console.error(`photo-exif: scanning ${PHOTO_ROOT} (isTakeout=${isTakeout} → source=${isTakeout ? 'google-photos' : 'photo-exif'})`);

  const { postIngestBatch, postExists } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const manifest = readManifest();
  let scanned = 0;            // files that missed the local manifest and were hashed
  let skippedUnchanged = 0;   // manifest (stat) hits — skipped without hashing
  let skippedAlreadyStored = 0; // hashed, but core already had them — skipped without EXIF read / ingest
  let ingested = 0;
  let manifestDirty = false;
  // Flips false on the first 404 from /exists (core predates the endpoint, #198) — thereafter we
  // stop asking and process everything, so an upgraded connector never hard-fails against old core.
  let existsAvailable = true;
  const startMs = Date.now();
  let lastTick = startMs;
  // Staged by source_id so byte-identical copies (same content hash) collapse to one entry carrying
  // every contributing file. No EXIF is read at staging time — the enrich tail runs (in processStaged)
  // only for files the existence check reports as new. Manifest stays keyed by relPath (the skip cache).
  const staged = new Map(); // source_id -> { source, source_id, type, contentHash, copies:[{absPath,relPath,statKey}] }

  // Record the skip-cache entry for every copy that shared a source_id (success or already-stored).
  const markManifest = (copies) => {
    for (const { relPath, statKey } of copies) manifest[relPath] = statKey;
    manifestDirty = true;
  };

  // Process one staged batch (#198): check which source_ids core already has, record-manifest-and-skip
  // those (no EXIF, no POST), then enrich + ingest only the genuinely new ones. Distinct source_ids
  // per batch are ≤ BATCH_MAX, so the new payloads fit a single /ingest/batch call.
  const processStaged = async () => {
    if (!staged.size) return;
    const entries = [...staged.values()];
    staged.clear();
    const hashedFiles = entries.reduce((n, e) => n + e.copies.length, 0);

    // Existence check — source is scan-constant (keyForMedia depends only on isTakeout), so take it
    // from the first entry. null ⇒ 404 ⇒ core predates /exists: fall back to processing everything.
    let existing = null;
    if (existsAvailable) {
      const resp = await postExists({ source: entries[0].source, source_ids: entries.map((e) => e.source_id) });
      if (resp === null) {
        existsAvailable = false;
        console.error('photo-exif: /api/v1/exists unavailable (404) — processing all files (older core)');
      } else {
        existing = new Set(resp.exists);
      }
    }

    const toIngest = new Map(); // source_id -> { payload, copies }
    let storedFiles = 0;
    for (const entry of entries) {
      if (existing?.has(entry.source_id)) {
        // Already in core — record the manifest so subsequent LOCAL runs skip via a cheap stat, but
        // do no EXIF read and no ingest POST (the whole point of the check).
        markManifest(entry.copies);
        storedFiles += entry.copies.length;
        continue;
      }
      // New: enrich each copy (EXIF) and merge, preserving byte-identical-copy union semantics. A
      // per-copy read error skips just that file (mirrors the walk-loop try/catch), not the batch.
      for (const copy of entry.copies) {
        let payload;
        try {
          payload = await enrichPayload(copy.absPath, copy.relPath, entry);
        } catch (err) {
          console.error(`photo-exif: skipping unreadable file ${copy.relPath}`, err);
          continue;
        }
        const ex = toIngest.get(entry.source_id);
        if (ex) {
          mergePayloads(ex.payload, payload);
          ex.copies.push(copy);
        } else {
          toIngest.set(entry.source_id, { payload, copies: [copy] });
        }
      }
    }
    skippedAlreadyStored += storedFiles;
    // Log the check outcome only when we actually got an answer (not on the 404-fallback path).
    if (existing !== null) {
      console.error(`photo-exif: skip-check — ${hashedFiles} hashed, ${storedFiles} already stored, ${hashedFiles - storedFiles} new`);
    }

    const groups = [...toIngest.values()];
    if (groups.length) {
      const result = await postIngestBatch(groups.map((g) => g.payload));
      result.results.forEach((r, i) => {
        if (r.error) {
          console.error('photo-exif: item failed', groups[i].payload.source_id, r.error, r.issues ?? '');
        } else {
          // Only cache success — a failed item must be retried on the next scan, not skipped as
          // "unchanged" forever. Mark every copy that shared this source_id.
          markManifest(groups[i].copies);
          ingested++;
        }
      });
    }
  };

  // Time-throttled progress + resumable manifest (#197): at most once per interval, emit a
  // progress line and persist the manifest so a killed scan resumes to within one interval.
  // Interval 0 disables both (final-write-only), preserving the pre-#197 behavior byte-for-byte.
  const maybeTick = () => {
    if (!PROGRESS_INTERVAL_MS) return;
    const now = Date.now();
    if (now - lastTick < PROGRESS_INTERVAL_MS) return;
    lastTick = now;
    const elapsed = Math.round((now - startMs) / 1000);
    console.error(`photo-exif: progress — ${scanned} scanned, ${skippedUnchanged} skipped, ${ingested} ingested, ${elapsed}s elapsed`);
    // Persist only when the manifest changed since the last write — an all-skip phase mutates
    // nothing, so there's no point re-serializing a 120k-entry map every tick. Best-effort: a
    // transient write failure logs and leaves manifestDirty set (retried next tick / at end) but
    // must not abort a multi-hour scan; the unconditional end-of-run write is authoritative.
    if (!manifestDirty) return;
    try {
      writeManifest(manifest);
      manifestDirty = false;
    } catch (err) {
      console.error('photo-exif: mid-run manifest write failed (will retry next tick / at end)', err);
    }
  };

  for await (const { absPath, relPath } of walkMediaFiles(PHOTO_ROOT)) {
    maybeTick();
    // statSync AND keyForFile share one try/catch — a permission error or broken file entry can
    // throw from either, and either way it must skip just this file, not abort the scan.
    let statKey;
    let key;
    try {
      const stat = statSync(absPath);
      statKey = `${stat.mtimeMs}:${stat.size}`;
      if (manifest[relPath] === statKey) {
        skippedUnchanged++;
        continue;
      }
      key = await keyForFile(absPath, isTakeout); // streamed hash → upsert key (the cheap tail-gate)
    } catch (err) {
      console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
      continue;
    }
    scanned++;
    const entry = staged.get(key.source_id);
    if (entry) {
      entry.copies.push({ absPath, relPath, statKey });
    } else {
      staged.set(key.source_id, { ...key, copies: [{ absPath, relPath, statKey }] });
    }
    if (staged.size >= BATCH_MAX) await processStaged();
  }
  await processStaged();
  writeManifest(manifest);

  console.error(`photo-exif: scanned ${scanned} new/changed file(s), skipped ${skippedUnchanged} unchanged, ${skippedAlreadyStored} already stored`);
}

main()
  // Let the event loop drain naturally rather than forcing process.exit(0): a hard exit while
  // undici's keep-alive sockets are still closing trips a libuv teardown assertion
  // (UV_HANDLE_CLOSING) on Node 26 / Windows, and #198's second endpoint (/exists) made that a
  // near-certain race. The pooled sockets idle out in well under a second, so the process still
  // exits promptly on its own once main() resolves.
  .then(() => { process.exitCode = 0; })
  .catch((err) => {
    console.error('photo-exif: scan failed', err);
    process.exitCode = 1;
  });
