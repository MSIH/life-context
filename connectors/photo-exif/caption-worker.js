#!/usr/bin/env node
// Low-priority background worker: walks the same photo root as scan.js, captions any photo
// not yet captioned via a local vision-language model (Ollama's native /api/generate, not the
// OpenAI-compat endpoint — that's what supports the `images` field), and upserts the SAME
// (source, source_id) with an enriched text_repr. One photo at a time, state saved after each
// (kill-safe at any point per roadmap Milestone 4), throttled between calls.
//
// Nightly-window scheduling is config, not code (roadmap deliverable 4) — this script does a
// single pass and exits; start/stop it on a schedule with cron, launchd, or Task Scheduler.
// See README.md for a scheduling snippet.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkImageFiles, keyForMedia, isTakeoutRoot, contentHashOfFile, ingestClient } from './lib/shared.js';
import { describePhoto } from './lib/describe.js';
import { readCaptionCache, writeCaptionCache } from './lib/caption-cache.js';
import { buildPhotoPayload, readFaceEnrichment } from './lib/photo-payload.js';
import { openImage } from './lib/decode-image.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const PHOTO_ROOT = process.env.PHOTO_ROOT;
const VLM_BASE_URL = process.env.VLM_BASE_URL || 'http://localhost:11434';
const VLM_MODEL = process.env.VLM_MODEL || 'llava';
const VLM_PROMPT = process.env.VLM_PROMPT
  || "Describe this photo in one concise sentence, focused on what's happening and who or what is visible.";
// `|| 2000` would also override an explicit 0 (0 is falsy) — Number.isFinite distinguishes
// "not set" (NaN) from "set to zero" (a real, useful value for tests and manual runs).
const rawThrottle = Number(process.env.VLM_THROTTLE_MS);
const VLM_THROTTLE_MS = Number.isFinite(rawThrottle) ? rawThrottle : 2000;
const HOME_STATE = (name) => path.join(os.homedir(), '.life-context', name);
const STATE_PATH = process.env.PHOTO_EXIF_CAPTION_STATE_PATH || HOME_STATE('photo-exif-captions.json');
// The face worker's state, read (never written) so a caption upsert carries face enrichment
// through instead of wiping it — `extra` is replaced wholesale by ingest (#276). Same env vars and
// defaults as face-worker.js; absent files just mean the face pass hasn't run yet.
const FACE_STATE_PATH = process.env.PHOTO_EXIF_FACE_STATE_PATH || HOME_STATE('photo-exif-faces.json');
const CLUSTERS_PATH = process.env.PHOTO_EXIF_FACE_CLUSTERS_PATH || HOME_STATE('photo-exif-face-clusters.json');
const confRaw = Number(process.env.FACE_HINT_CONFIDENCE);
const FACE_HINT_CONFIDENCE = Number.isFinite(confRaw) ? confRaw : 0.6;
// One corrupt/unsupported photo at 2am must not waste the rest of an overnight window on a
// multi-week job — stop only after this many VLM failures IN A ROW, resetting on any success.
// A value below 1 would break out before the first VLM call is ever made (consecutiveFailures
// starts at 0), which is never what "stop after N failures" should mean for N<1 — clamp instead.
const maxFailRaw = Number(process.env.VLM_MAX_CONSECUTIVE_FAILURES);
const VLM_MAX_CONSECUTIVE_FAILURES = Number.isFinite(maxFailRaw) && maxFailRaw >= 1 ? maxFailRaw : 5;

async function caption(base64Image) {
  const res = await fetch(`${VLM_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VLM_MODEL,
      prompt: VLM_PROMPT,
      images: [base64Image],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`VLM returned ${res.status}`);
  const data = await res.json();
  const text = data?.response?.trim();
  if (!text) throw new Error('VLM returned no caption text');
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // Same scan-level Google-origin decision scan.js makes, so the key matches (keyForMedia/#176).
  const isTakeout = isTakeoutRoot(PHOTO_ROOT, process.env.PHOTO_TAKEOUT);
  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  // relPath -> caption text, so the face worker can reconstruct base+caption before appending
  // "Pictured: ..." (lib/caption-cache.js). A present key means "already captioned" — same
  // skip semantics as the old Set, but the text is retained now.
  const captionCache = readCaptionCache(STATE_PATH);
  // Read once, not per photo — the face pass is finished (or absent) by the time this runs.
  const faceEnrichment = readFaceEnrichment(FACE_STATE_PATH, CLUSTERS_PATH);
  let done = 0;
  let consecutiveFailures = 0;

  for await (const { absPath, relPath } of walkImageFiles(PHOTO_ROOT)) {
    // Skip only photos that already have caption TEXT cached. A legacy null entry (from the old
    // array-format state) means "captioned once, text not retained" — re-caption it to populate the
    // map so the face worker can reconstruct base+caption instead of overwriting it with base-only
    // text. Object.hasOwn guards against prototype keys (a relPath could be "constructor").
    const cachedCaption = Object.hasOwn(captionCache, relPath) ? captionCache[relPath] : undefined;
    if (cachedCaption != null) continue;
    if (consecutiveFailures >= VLM_MAX_CONSECUTIVE_FAILURES) break; // stop rather than fail through the whole library

    const { dateStr } = await describePhoto(absPath);

    let base64Image;
    let contentHash;
    try {
      // Downscaled + re-encoded for the VLM call (faster inference, smaller payload); contentHash
      // is still computed from the ORIGINAL file bytes — content_hash is the dedup key and must
      // not change because of how this worker happens to re-encode the image for a model.
      const resized = await (await openImage(absPath))
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      base64Image = resized.toString('base64');
      contentHash = await contentHashOfFile(absPath);
    } catch (err) {
      // A single unreadable/corrupt file must not be mistaken for the VLM being down —
      // skip it and keep going, same posture as scan.js.
      console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
      continue;
    }

    let captionText;
    try {
      captionText = await caption(base64Image);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.error(`photo-exif: VLM call failed for ${relPath} (${consecutiveFailures}/${VLM_MAX_CONSECUTIVE_FAILURES} consecutive)`, err);
      if (consecutiveFailures >= VLM_MAX_CONSECUTIVE_FAILURES) {
        console.error(`photo-exif: ${VLM_MAX_CONSECUTIVE_FAILURES} consecutive VLM failures, stopping run (will resume next time)`);
      }
      // The throttle exists to keep this a low-priority background load on the VLM host — a
      // retry after a failure must pace the same as a success, or repeated failures hammer the
      // endpoint back-to-back until the consecutive-failure limit lands (#282 review).
      await sleep(VLM_THROTTLE_MS);
      continue;
    }

    // Same content-hash key scan.js computed (keyForMedia) so this enriches the SAME artifact —
    // a Takeout-export photo keys under source='google-photos', everything else under 'photo-exif'.
    const { source, source_id } = keyForMedia(contentHash, isTakeout);
    // Carry through whatever the face pass already found for this photo. Absent (face pass never
    // ran) leaves faces_detected/pictured off the payload entirely rather than sending 0/[] — see
    // lib/photo-payload.js. This is what makes caption/face order-independent (#276).
    const face = faceEnrichment.get(relPath);
    try {
      // Present fields only: text_repr + extra (+ hints when someone is pictured). Per doc 04 §3
      // upsert merge semantics, everything scan.js already stored (occurred_at, GPS, raw_path,
      // content_hash) — plus whatever core resolved into place_label from that GPS — is left
      // untouched, since none of it is present in this payload. This is exactly the "enrichment
      // wave" the contract's upsert exists for.
      await postIngest(buildPhotoPayload({
        source,
        source_id,
        dateStr,
        filename: path.basename(absPath),
        caption: captionText,
        faces: face?.faces,
        pictured: face?.pictured,
        hintConfidence: FACE_HINT_CONFIDENCE,
      }));
      captionCache[relPath] = captionText;
      writeCaptionCache(STATE_PATH, captionCache); // after every success, not batched — kill-safe
      done++;
    } catch (err) {
      console.error(`photo-exif: ingest failed for ${relPath}, will retry next run`, err);
    }

    await sleep(VLM_THROTTLE_MS);
  }

  console.error(`photo-exif: captioned ${done} photo(s) this run`);
}

main()
  .then(() => process.exit(0)) // fetch's keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('photo-exif: caption worker failed', err);
    process.exit(1);
  });
