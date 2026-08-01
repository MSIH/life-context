#!/usr/bin/env node
// Third photo-exif pass (issue #53): detect faces locally, cluster them into anonymous groups,
// and — once a human names a cluster — emit `pictured` entity hints on the same photo artifacts
// scan.js already created. Follows the caption worker's enrichment pattern: walk the same
// PHOTO_ROOT, keep local state, upsert the SAME (source='photo-exif', source_id=relPath) — never
// a new artifact. Detection is local/offline; descriptors stay in the local clusters file and
// NEVER go on the wire (doc 04 §4/§11) — only human-assigned names do, as name hints.
//
// Commands:
//   node face-worker.js                      scan: detect + cluster + emit hints for labeled faces
//   node face-worker.js label <id> "<name>"  name a cluster and re-emit its photos' hints
//   node face-worker.js export-thumbnails <dir>  write one sample image per cluster + index.json
//   node face-worker.js suggest-labels       print (never apply) name suggestions for unlabeled
//                                             clusters, matched against contact photos (#84)
//   node face-worker.js suggest-from-sidecars  print (never apply) name suggestions for unlabeled
//                                             clusters, from Google Photos sidecar people[] (#272)
//   node face-worker.js merge-clusters --threshold <t> [--apply] [--max-merge-fraction <f>] [--force]
//                                             merge clusters by centroid distance, WITHOUT
//                                             re-detecting any photo (#342). Dry run by default.
//
// Kill-safe: state is saved after every photo. Nightly-window scheduling is config, not code —
// see README.md (same posture as caption-worker.js).
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkImageFiles, keyForMedia, isTakeoutRoot, contentHashOfFile, ingestClient, fetchContactPhotos } from './lib/shared.js';
import { describePhoto, readSidecar } from './lib/describe.js';
import { readCaptionCache } from './lib/caption-cache.js';
import { assignCluster, euclideanDistance, parseClustersFile, serializeClustersFile, planMerges, mergeTwo } from './lib/face-cluster.js';
import { buildPhotoPayload, picturedNames } from './lib/photo-payload.js';
import { resolveDetector } from './lib/face-detect.js';

const CONNECTOR_DIR = path.dirname(fileURLToPath(import.meta.url));
loadDotEnvIfPresent(CONNECTOR_DIR);

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const PHOTO_ROOT = process.env.PHOTO_ROOT;
const FACE_MODELS_PATH = process.env.FACE_MODELS_PATH;
const FACE_FIXTURE = process.env.PHOTO_EXIF_FACE_FIXTURE; // test seam (see face-detect.js)
const HOME_STATE = (name) => path.join(os.homedir(), '.life-context', name);
const FACE_STATE_PATH = process.env.PHOTO_EXIF_FACE_STATE_PATH || HOME_STATE('photo-exif-faces.json');
const CLUSTERS_PATH = process.env.PHOTO_EXIF_FACE_CLUSTERS_PATH || HOME_STATE('photo-exif-face-clusters.json');
const CAPTION_STATE_PATH = process.env.PHOTO_EXIF_CAPTION_STATE_PATH || HOME_STATE('photo-exif-captions.json');
// Number()-with-isFinite so an explicit 0 isn't overridden by a `|| default` (0 is falsy).
// Euclidean thresholds for L2-normalized 512-d ArcFace descriptors (#268) — NOT comparable to the
// old 128-d face-api value (0.6). For unit vectors, euclidean d = sqrt(2*(1-cos)), so raising the
// threshold merges more aggressively, lowering it splits more aggressively.
const matchRaw = Number(process.env.FACE_MATCH_THRESHOLD);
const FACE_MATCH_THRESHOLD = Number.isFinite(matchRaw) ? matchRaw : 1.0; // ~= cosine 0.50
const confRaw = Number(process.env.FACE_HINT_CONFIDENCE);
const FACE_HINT_CONFIDENCE = Number.isFinite(confRaw) ? confRaw : 0.6;
const throttleRaw = Number(process.env.FACE_THROTTLE_MS);
const FACE_THROTTLE_MS = Number.isFinite(throttleRaw) ? throttleRaw : 0;
// #84 — distance threshold for matching a contact's reference photo against an unlabeled
// cluster centroid. Separate from FACE_MATCH_THRESHOLD (intra-camera-roll clustering): a posed
// contact photo and a candid camera-roll photo differ enough in framing/lighting that
// cross-source matching may warrant a different threshold. Defaults to the same value so
// behavior is a pure addition until tuned.
const seedRaw = Number(process.env.FACE_SEED_THRESHOLD);
const FACE_SEED_THRESHOLD = Number.isFinite(seedRaw) ? seedRaw : 1.15; // ~= cosine 0.34, looser than match
// #272 — suggest-from-sidecars: a cluster's top sidecar-name vote must clear BOTH a minimum raw
// count and a minimum share of that cluster's single-name/single-face votes before it's suggested,
// so a stray Google mis-tag or an impure/merged cluster doesn't produce a confident wrong label.
// These two guard the safety threshold itself, so — unlike the plain Number()+isFinite idiom above
// — an unset-but-present value (`FACE_SEED_MIN_VOTES=` blank, or `Number('')` = 0) must NOT parse
// as a valid override; that would silently disable the gate this feature exists to provide.
const minVotesRaw = Number(process.env.FACE_SEED_MIN_VOTES);
const FACE_SEED_MIN_VOTES = Number.isFinite(minVotesRaw) && minVotesRaw > 0 ? minVotesRaw : 3;
const minFractionRaw = Number(process.env.FACE_SEED_MIN_FRACTION);
const FACE_SEED_MIN_FRACTION = Number.isFinite(minFractionRaw) && minFractionRaw > 0 && minFractionRaw <= 1 ? minFractionRaw : 0.7;
// #342 — merge-clusters: refuse an --apply that would collapse more than this fraction of
// clusters in one run unless --force is also passed (a fat-fingered --threshold must not silently
// fuse the whole library into a handful of piles). A CLI flag, not an env var (see merge-clusters'
// own arg parsing below) — this default backs the flag when --max-merge-fraction is omitted.
const DEFAULT_MAX_MERGE_FRACTION = 0.5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requireApiKey = () => {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('photo-exif: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
};

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

function loadClusters() {
  return existsSync(CLUSTERS_PATH) ? parseClustersFile(readFileSync(CLUSTERS_PATH, 'utf8')) : { version: 0, clusters: [] };
}

function saveClusters(state) {
  mkdirSync(path.dirname(CLUSTERS_PATH), { recursive: true });
  writeFileSync(CLUSTERS_PATH, serializeClustersFile(state.version, state.clusters));
}

// Build the enrichment payload for one photo from its stored face entry + current cluster labels.
// The payload shape itself lives in lib/photo-payload.js so the caption worker emits the identical
// union of fields and the two passes can run in either order without clobbering each other (#276).
// entry.{source,source_id} is the content-hash key scan() computed and persisted (keyForMedia),
// so a labeled photo enriches the SAME artifact scan.js/caption-worker created.
function buildPayload(relPath, entry, clustersById, captionCache) {
  return buildPhotoPayload({
    source: entry.source,
    source_id: entry.source_id,
    dateStr: entry.dateStr,
    filename: path.basename(relPath),
    caption: captionCache[relPath] ?? null,
    faces: entry.faces,
    pictured: picturedNames(entry.clusters, clustersById),
    hintConfidence: FACE_HINT_CONFIDENCE,
  });
}

// Everything in the payload that can change between runs — used to skip an upsert that would be
// byte-for-byte identical to the last one we sent for this photo.
const payloadSignature = (p) => JSON.stringify({ e: p.extra, h: p.entity_hints ?? null, t: p.text_repr ?? null });

// Shared by scan() and suggestLabels() — models unavailable/unloadable stops the run before
// touching anything, same as the VLM-down path.
async function loadDetectorOrExit() {
  try {
    return await resolveDetector({ modelsPath: FACE_MODELS_PATH, fixturePath: FACE_FIXTURE });
  } catch (err) {
    console.error('photo-exif: face detector unavailable (check FACE_MODELS_PATH)', err);
    process.exit(1);
  }
}

async function scan() {
  requireApiKey();
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }
  const detectFaces = await loadDetectorOrExit();
  // Same scan-level Google-origin decision scan.js makes, so the persisted key matches (#176).
  const isTakeout = isTakeoutRoot(PHOTO_ROOT, process.env.PHOTO_TAKEOUT);

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const faceState = readJson(FACE_STATE_PATH, {});
  const clustersState = loadClusters();
  const captionCache = readCaptionCache(CAPTION_STATE_PATH);
  const clustersById = new Map(clustersState.clusters.map((c) => [c.id, c]));

  let detected = 0;
  let emitted = 0;
  let skippedUnchanged = 0;

  const emit = async (relPath, entry) => {
    const payload = buildPayload(relPath, entry, clustersById, captionCache);
    const sig = payloadSignature(payload);
    if (entry.ingestedSig === sig) return false;
    await postIngest(payload);
    entry.ingestedSig = sig;
    return true;
  };

  for await (const { absPath, relPath } of walkImageFiles(PHOTO_ROOT)) {
    let statKey;
    try {
      const st = statSync(absPath);
      statKey = `${st.mtimeMs}:${st.size}`;
    } catch (err) {
      console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
      continue;
    }

    let entry = faceState[relPath];
    if (entry && entry.statKey === statKey && entry.failed) {
      // Known-bad file (#289): detection failed on this exact statKey before, and the file
      // hasn't changed since — don't re-attempt an expensive decode we already know fails.
      // A changed statKey (file replaced/repaired) falls through to a fresh attempt below.
      continue;
    }
    if (!entry || entry.statKey !== statKey) {
      // New or changed file → (re)detect. A per-file failure skips just this file (scan.js
      // posture), but IS persisted (#289) so a future run doesn't retry a permanently-broken
      // file forever — only a statKey change (the underlying file itself changing) clears it.
      let faces;
      try {
        faces = await detectFaces(absPath, relPath);
      } catch (err) {
        console.error(`photo-exif: face detection failed for ${relPath}, skipping`, err);
        faceState[relPath] = { statKey, failed: true };
        writeJson(FACE_STATE_PATH, faceState);
        continue;
      }
      const { dateStr } = await describePhoto(absPath);
      const clusterIds = [];
      for (const face of faces) {
        const id = assignCluster(face.descriptor, clustersState.clusters, FACE_MATCH_THRESHOLD);
        clusterIds.push(id);
        const cl = clustersState.clusters.find((c) => c.id === id);
        if (!cl.sample) cl.sample = relPath;
        clustersById.set(id, cl);
      }
      entry = { statKey, faces: faces.length, clusters: [...new Set(clusterIds)], dateStr, ingestedSig: null };
      faceState[relPath] = entry;
      // Persist BOTH the clusters and the face-state entry before the network step, together, so a
      // crash here can't leave clusters updated but the entry missing (which would re-detect this
      // photo next run and double-count its centroids).
      saveClusters(clustersState);
      writeJson(FACE_STATE_PATH, faceState);
      detected++;
    }

    // The content-hash key (keyForMedia) — computed once and persisted on the entry so it's stable
    // across runs and reused by label(). Also backfills an entry from before this key was stored.
    if (!entry.source_id) {
      let contentHash;
      try {
        contentHash = await contentHashOfFile(absPath);
      } catch (err) {
        console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
        continue;
      }
      const { source, source_id } = keyForMedia(contentHash, isTakeout);
      entry.source = source;
      entry.source_id = source_id;
      writeJson(FACE_STATE_PATH, faceState);
    }

    // #288: only throttle when a network call actually happened. emit() returns false with NO
    // request sent when the payload signature is unchanged (the common case once resuming past
    // already-processed files) — sleeping FACE_THROTTLE_MS there too turned "walk past files
    // already done" into the single largest cost of resuming a run, for a rate limit that was
    // never at risk. A throw still means postIngest was attempted, so it still throttles.
    let calledIngest = true;
    try {
      if (await emit(relPath, entry)) emitted++;
      else { skippedUnchanged++; calledIngest = false; }
    } catch (err) {
      console.error(`photo-exif: ingest failed for ${relPath}, will retry next run`, err);
    }
    writeJson(FACE_STATE_PATH, faceState); // after every photo — kill-safe
    if (calledIngest && FACE_THROTTLE_MS) await sleep(FACE_THROTTLE_MS);
  }

  writeJson(FACE_STATE_PATH, faceState);
  saveClusters(clustersState);
  console.error(`photo-exif: faces — detected ${detected} new/changed photo(s), emitted ${emitted}, ${skippedUnchanged} unchanged`);
}

async function label(clusterIdArg, name) {
  requireApiKey();
  const clusterId = Number(clusterIdArg);
  if (!Number.isInteger(clusterId) || !name) {
    console.error('photo-exif: usage: face-worker.js label <clusterId> "<name>"');
    process.exit(1);
  }
  const clustersState = loadClusters();
  const cluster = clustersState.clusters.find((c) => c.id === clusterId);
  if (!cluster) {
    console.error(`photo-exif: no cluster with id ${clusterId} (run scan first, or export-thumbnails to browse)`);
    process.exit(1);
  }
  cluster.label = name;
  clustersState.version += 1;
  saveClusters(clustersState);

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const faceState = readJson(FACE_STATE_PATH, {});
  const captionCache = readCaptionCache(CAPTION_STATE_PATH);
  const clustersById = new Map(clustersState.clusters.map((c) => [c.id, c]));

  let reingested = 0;
  for (const [relPath, entry] of Object.entries(faceState)) {
    if (!entry.clusters.includes(clusterId)) continue;
    const payload = buildPayload(relPath, entry, clustersById, captionCache);
    const sig = payloadSignature(payload);
    if (entry.ingestedSig === sig) continue;
    try {
      await postIngest(payload);
      entry.ingestedSig = sig;
      writeJson(FACE_STATE_PATH, faceState); // kill-safe after each
      reingested++;
    } catch (err) {
      console.error(`photo-exif: re-ingest failed for ${relPath}, will retry on next scan`, err);
    }
  }
  console.error(`photo-exif: labeled cluster ${clusterId} "${name}", re-emitted ${reingested} photo(s)`);
}

// #342 — parse `merge-clusters` flags. Returns null (having already printed the usage/validation
// error) on anything invalid, so the caller can just `process.exit(1)`.
function parseMergeArgs(rest) {
  const args = { threshold: null, apply: false, maxMergeFraction: DEFAULT_MAX_MERGE_FRACTION, force: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--threshold') args.threshold = Number(rest[++i]);
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--max-merge-fraction') args.maxMergeFraction = Number(rest[++i]);
    else if (arg === '--force') args.force = true;
    else {
      console.error(`photo-exif: merge-clusters — unknown argument "${arg}"`);
      return null;
    }
  }
  if (!Number.isFinite(args.threshold) || args.threshold <= 0) {
    console.error('photo-exif: usage: face-worker.js merge-clusters --threshold <t> [--apply] [--max-merge-fraction <f>] [--force]');
    return null;
  }
  if (!Number.isFinite(args.maxMergeFraction) || args.maxMergeFraction < 0 || args.maxMergeFraction > 1) {
    console.error('photo-exif: merge-clusters — --max-merge-fraction must be a number between 0 and 1');
    return null;
  }
  return args;
}

// #342 — copy both state files into a fresh timestamped backup dir before any mutation. These two
// JSON files are the only copy of many hours of detection work, so --apply always writes one
// (never skips it) — there is no code path where --apply mutates without a backup existing first.
function backupStateFiles() {
  const backupRoot = path.join(path.dirname(CLUSTERS_PATH), 'merge-backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupRoot, stamp);
  mkdirSync(dir, { recursive: true });
  if (existsSync(CLUSTERS_PATH)) copyFileSync(CLUSTERS_PATH, path.join(dir, path.basename(CLUSTERS_PATH)));
  if (existsSync(FACE_STATE_PATH)) copyFileSync(FACE_STATE_PATH, path.join(dir, path.basename(FACE_STATE_PATH)));
  return dir;
}

// #342 — union-find over the plan's merge list: `find(id)` returns the FINAL surviving id for any
// original cluster id, following however many hops a chain of merges took (id 7 -> 5 -> 2 resolves
// to 2). Built once from the plan's `merges` (already in apply order), then reused for every
// face-state entry's `clusters` remap.
function buildRemap(merges) {
  const parent = new Map();
  for (const { survivorId, absorbedId } of merges) parent.set(absorbedId, survivorId);
  function find(id) {
    const seen = [];
    let cur = id;
    while (parent.has(cur)) {
      seen.push(cur);
      cur = parent.get(cur);
    }
    for (const s of seen) parent.set(s, cur); // path compression (cosmetic at this scale)
    return cur;
  }
  return { find };
}

// #342 — merge face clusters by centroid distance, WITHOUT re-detecting a single photo. Dry run
// by default (prints the plan, writes nothing); `--apply` performs it. See lib/face-cluster.js's
// planMerges/mergeTwo for the pure planning/arithmetic — this function is all the IO: load, plan,
// print, and (on --apply) backup + persist + re-emit, in that order.
async function mergeClusters(rest) {
  const args = parseMergeArgs(rest);
  if (!args) { process.exit(1); return; }
  if (args.apply) requireApiKey(); // dry run makes no network call and needs no key

  const clustersState = loadClusters();
  const totalBefore = clustersState.clusters.length;
  if (totalBefore === 0) {
    console.error('photo-exif: merge-clusters — no clusters (run scan first)');
    return;
  }

  const { merges, refusals } = planMerges(clustersState.clusters, args.threshold);

  console.error(`photo-exif: merge-clusters — ${args.apply ? 'APPLY' : 'DRY RUN'} at threshold ${args.threshold}`);
  // Replay the plan against a working copy to print pre-merge counts — the SAME replay (same
  // mergeTwo calls, same order) that --apply performs for real below, so what's printed here is
  // provably what --apply does, not merely a description of it (#342 acceptance: determinism
  // proven, not asserted).
  const working = new Map(clustersState.clusters.map((c) => [c.id, { ...c, merged_from: c.merged_from ?? [] }]));
  for (const { survivorId, absorbedId, distance } of merges) {
    const survivor = working.get(survivorId);
    const absorbed = working.get(absorbedId);
    console.error(`photo-exif: merge — ${survivorId} + ${absorbedId} -> ${survivorId} (${survivor.count} + ${absorbed.count} photos, distance ${distance.toFixed(2)})`);
    working.set(survivorId, mergeTwo(survivor, absorbed));
    working.delete(absorbedId);
  }
  for (const r of refusals) {
    console.error(`photo-exif: refuse — ${r.clusterA} + ${r.clusterB} both labeled ("${r.labelA}" / "${r.labelB}"), skipped`);
  }
  const totalAfter = totalBefore - merges.length;
  console.error(
    `photo-exif: merge-clusters — ${totalBefore} clusters -> ${totalAfter} (${merges.length} merges, ${refusals.length} refusals)` +
    (args.apply ? '' : '; re-run with --apply')
  );

  if (!args.apply) return; // dry run: writes nothing (proven by the caller's own byte-identical-files test)

  const fraction = merges.length / totalBefore;
  if (fraction > args.maxMergeFraction && !args.force) {
    const pct = Math.round(fraction * 100);
    console.error(
      `photo-exif: merge-clusters — refused: would collapse ${pct}% of clusters ` +
      `(> --max-merge-fraction ${args.maxMergeFraction}); re-run with --force to override`
    );
    process.exit(1);
  }

  const backupDir = backupStateFiles();
  console.error(`photo-exif: wrote backup ${backupDir}`);

  // Rebuild the clusters array from the replayed `working` map (survivors only — absorbed ids are
  // already gone), bump version (a label composition changed, same as label() does), then remap
  // every face-state entry's `clusters` to its final surviving id, deduped.
  clustersState.clusters = [...working.values()];
  clustersState.version += 1;

  // A survivor id can carry a NEW label (inherited from what it absorbed) without its OWN id ever
  // changing in a photo's `clusters` array — that photo still needs a re-emit, even though its ids
  // are untouched. `affectedSurvivorIds` is how those photos are found alongside the ones whose
  // ids literally moved.
  const affectedSurvivorIds = new Set(merges.map((m) => m.survivorId));
  const remap = buildRemap(merges);
  const faceState = readJson(FACE_STATE_PATH, {});
  const remappedRelPaths = []; // ids literally changed — this is the "remapped N photo entries" count
  const reemitCandidates = []; // superset: also includes an unchanged id whose cluster's label just changed
  for (const [relPath, entry] of Object.entries(faceState)) {
    if (!Array.isArray(entry.clusters) || entry.clusters.length === 0) continue;
    const next = [...new Set(entry.clusters.map((id) => remap.find(id)))];
    const idsChanged = next.length !== entry.clusters.length || next.some((id, i) => id !== entry.clusters[i]);
    if (idsChanged) {
      entry.clusters = next;
      remappedRelPaths.push(relPath);
    }
    if (idsChanged || next.some((id) => affectedSurvivorIds.has(id))) reemitCandidates.push(relPath);
  }

  // Persist BOTH files together, BEFORE any network call — the same crash-safety invariant scan()
  // depends on (see the comment at the top of this file, "Persist BOTH the clusters and..."): a
  // crash here must never leave clusters merged but face-state pointing at ids that no longer exist.
  saveClusters(clustersState);
  writeJson(FACE_STATE_PATH, faceState);

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const captionCache = readCaptionCache(CAPTION_STATE_PATH);
  const clustersById = new Map(clustersState.clusters.map((c) => [c.id, c]));
  let reemitted = 0;
  let reemitFailed = 0;
  for (const relPath of reemitCandidates) {
    const entry = faceState[relPath];
    const payload = buildPayload(relPath, entry, clustersById, captionCache);
    const sig = payloadSignature(payload);
    if (entry.ingestedSig === sig) continue; // a candidate, but nothing about the photo's actual payload changed
    try {
      await postIngest(payload);
      entry.ingestedSig = sig;
      writeJson(FACE_STATE_PATH, faceState); // kill-safe after each, mirrors label()
      reemitted++;
    } catch (err) {
      // Leaves ingestedSig unset (never set on failure) so the next scan retries — never a silent
      // success (#342 behavior spec).
      console.error(`photo-exif: re-emit failed for ${relPath}, will retry next run`, err);
      reemitFailed++;
    }
  }

  console.error(
    `photo-exif: applied ${merges.length} merge(s), remapped ${remappedRelPaths.length} photo entr(ies), re-emitted ${reemitted} hint(s)` +
    (reemitFailed ? ` (${reemitFailed} failed, will retry)` : '')
  );
}

// #84 — suggest names for unlabeled clusters using each contact's own preserved photo (#74) as a
// reference face. NEVER writes cluster.label and NEVER emits a hint — only prints candidate
// matches; a human still confirms via the existing `label <id> "<name>"` command. Requires this
// connector's process to be able to read the raw_path core returns (same filesystem/shared
// volume as core — see README); an unreadable/undetectable reference photo is skipped, not
// fatal to the run.
const CONTACT_PHOTOS_FETCH_LIMIT = 500; // matches the server's own GET /api/v1/entities/photos max

async function suggestLabels() {
  requireApiKey();
  const clustersState = loadClusters();
  const unlabeled = clustersState.clusters.filter((c) => !c.label);
  if (unlabeled.length === 0) {
    console.error('photo-exif: suggest-labels — no unlabeled clusters; nothing to suggest');
    return;
  }

  const detectFaces = await loadDetectorOrExit();

  let contacts;
  try {
    contacts = await fetchContactPhotos({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY, limit: CONTACT_PHOTOS_FETCH_LIMIT });
  } catch (err) {
    console.error('photo-exif: suggest-labels — could not fetch contact photos from LifeContext', err);
    process.exit(1);
  }
  if (contacts.length === CONTACT_PHOTOS_FETCH_LIMIT) {
    console.error(`photo-exif: suggest-labels — hit the ${CONTACT_PHOTOS_FETCH_LIMIT}-contact fetch limit; some contacts may not have been checked`);
  }

  const suggestedClusterIds = new Set(); // unique clusters, not contact×cluster match count
  let skipped = 0;
  for (const contact of contacts) {
    let faces;
    try {
      // Second arg is the fixture detector's lookup key (see lib/face-detect.js); the real
      // detector uses only the first arg (the actual file path) and ignores the second.
      faces = await detectFaces(contact.raw_path, contact.raw_path);
    } catch (err) {
      console.error(`photo-exif: suggest-labels — skipping "${contact.name}" (entity #${contact.entity_id}): reference photo unreadable/undetectable`, err);
      skipped++;
      continue;
    }
    if (faces.length !== 1) {
      console.error(`photo-exif: suggest-labels — skipping "${contact.name}" (entity #${contact.entity_id}): detected ${faces.length} faces, expected exactly 1`);
      skipped++;
      continue;
    }
    const [{ descriptor }] = faces;
    for (const cluster of unlabeled) {
      const dist = euclideanDistance(descriptor, cluster.centroid);
      if (dist <= FACE_SEED_THRESHOLD) {
        console.error(
          `photo-exif: suggest — cluster ${cluster.id} (${cluster.count} photo(s)) possibly "${contact.name}" ` +
          `(entity #${contact.entity_id}, distance ${dist.toFixed(2)} <= threshold ${FACE_SEED_THRESHOLD})`
        );
        suggestedClusterIds.add(cluster.id);
      }
    }
  }
  // A run where every contact was skipped must not read the same as "checked N, found nothing" —
  // that's indistinguishable from a healthy zero-match run otherwise (e.g. a CONTACTS_RAW_DIR /
  // shared-filesystem misconfiguration would silently look like "nothing to suggest").
  if (contacts.length > 0 && skipped === contacts.length) {
    console.error(`photo-exif: suggest-labels — all ${skipped} contact photo(s) were unreadable/undetectable; check the same-filesystem setup (see README)`);
  }
  console.error(`photo-exif: suggest-labels — checked ${contacts.length} contact photo(s) (${skipped} skipped), ${suggestedClusterIds.size} cluster(s) suggested`);
}

// #272 — suggest names for unlabeled clusters by joining the face scan's own state against Google
// Photos sidecar people[] tags: a photo with exactly one detected face in exactly one cluster,
// whose sidecar names exactly one person, is a (clusterId -> name) vote. NEVER writes cluster.label
// and NEVER emits an ingest hint — only prints candidate matches; a human still confirms via the
// existing `label <id> "<name>"` command. Needs zero ONNX/detection — reads persisted FACE_STATE +
// sidecars only, so it never calls the detector, postIngest, saveClusters, or writeJson.
function suggestFromSidecars() {
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }
  const clustersState = loadClusters();
  const unlabeled = clustersState.clusters.filter((c) => !c.label);
  if (unlabeled.length === 0) {
    console.error('photo-exif: suggest-from-sidecars — no unlabeled clusters; nothing to suggest');
    return;
  }
  const unlabeledIds = new Set(unlabeled.map((c) => c.id));

  const faceState = readJson(FACE_STATE_PATH, {});
  const votesByCluster = new Map(); // clusterId -> Map<name, count>
  let checkedPhotos = 0;
  for (const [relPath, entry] of Object.entries(faceState)) {
    if (entry.faces !== 1 || !entry.clusters || entry.clusters.length !== 1) continue;
    const clusterId = entry.clusters[0];
    if (!unlabeledIds.has(clusterId)) continue; // already-labeled clusters excluded silently
    const sidecar = readSidecar(path.join(PHOTO_ROOT, relPath));
    if (!sidecar || sidecar.names.length !== 1) continue;
    checkedPhotos++;
    const nameVotes = votesByCluster.get(clusterId) ?? new Map();
    nameVotes.set(sidecar.names[0], (nameVotes.get(sidecar.names[0]) ?? 0) + 1);
    votesByCluster.set(clusterId, nameVotes);
  }

  if (checkedPhotos === 0) {
    console.error('photo-exif: suggest-from-sidecars — nothing to suggest (no single-name sidecar votes)');
    return;
  }

  let suggested = 0;
  for (const cluster of unlabeled) {
    const nameVotes = votesByCluster.get(cluster.id);
    if (!nameVotes) continue; // no single-name/single-face votes for this cluster at all
    const total = [...nameVotes.values()].reduce((a, b) => a + b, 0);
    const [topName, topCount] = [...nameVotes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount >= FACE_SEED_MIN_VOTES && topCount / total >= FACE_SEED_MIN_FRACTION) {
      const pct = Math.round((topCount / total) * 100);
      console.error(`photo-exif: suggest-from-sidecars — cluster ${cluster.id} → "${topName}" (${topCount} of ${total} single-name votes, ${pct}%)`);
      suggested++;
    } else {
      const breakdown = [...nameVotes.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ');
      console.error(`photo-exif: suggest-from-sidecars — cluster ${cluster.id}: no majority (${breakdown} of ${total}) — skipped`);
    }
  }
  console.error(`photo-exif: suggest-from-sidecars — checked ${unlabeled.length} unlabeled cluster(s) against ${checkedPhotos} single-name/single-face photo(s), suggested ${suggested}`);
}

// Write one representative SAMPLE image per cluster (whole image, not a tight face crop — a crop
// would pull in the native image stack, and per-face boxes aren't persisted today, only
// centroid/count/label/sample) plus index.json, so a human can eyeball who each anonymous cluster
// is before labeling.
function exportThumbnails(outDir) {
  if (!outDir) {
    console.error('photo-exif: usage: face-worker.js export-thumbnails <dir>');
    process.exit(1);
  }
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }
  const clustersState = loadClusters();
  mkdirSync(outDir, { recursive: true });
  const index = {};
  let written = 0;
  for (const c of clustersState.clusters) {
    index[c.id] = { label: c.label ?? null, count: c.count, sample: c.sample ?? null };
    if (!c.sample) continue;
    const src = path.join(PHOTO_ROOT, c.sample);
    try {
      copyFileSync(src, path.join(outDir, `${c.id}${path.extname(c.sample) || '.jpg'}`));
      written++;
    } catch (err) {
      console.error(`photo-exif: could not copy sample for cluster ${c.id} (${src})`, err);
    }
  }
  writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.error(`photo-exif: exported ${written} cluster sample(s) + index.json to ${outDir}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'scan') return scan();
  if (cmd === 'label') return label(rest[0], rest[1]);
  if (cmd === 'export-thumbnails') return exportThumbnails(rest[0]);
  if (cmd === 'suggest-labels') return suggestLabels();
  if (cmd === 'suggest-from-sidecars') return suggestFromSidecars();
  if (cmd === 'merge-clusters') return mergeClusters(rest);
  console.error(`photo-exif: unknown command "${cmd}" (expected: scan | label | export-thumbnails | suggest-labels | suggest-from-sidecars | merge-clusters)`);
  process.exit(1);
}

main()
  .then(() => process.exit(0)) // fetch keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('photo-exif: face worker failed', err);
    process.exit(1);
  });
