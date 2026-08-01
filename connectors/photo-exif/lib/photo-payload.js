// The one place a photo enrichment payload is built. Both enrichment workers (caption + face)
// upsert the SAME (source, source_id) artifact, and the ingest contract replaces `text_repr` and
// `extra` wholesale (doc 04 §3 — no deep-merge). So whichever worker runs second overwrites the
// other's contribution unless BOTH send the union of what's known. Keeping that union in one
// function is what makes the two passes order-independent — the same reason `lib/describe.js` is
// shared: two scripts building the same thing separately is how they drift (#276).
import { parseClustersFile } from './face-cluster.js';
import { currentTextRepr } from './caption-cache.js';
import { readFileSync, existsSync } from 'node:fs';

// The pictured names on a photo = the labels of the (distinct) clusters its faces fall into.
// Unlabeled clusters contribute nothing — an anonymous pile is not a name (see face-worker.js).
export function picturedNames(clusterIds, clustersById) {
  const names = new Set();
  for (const id of clusterIds) {
    const label = clustersById.get(id)?.label;
    if (label) names.add(label);
  }
  return [...names].sort();
}

// Build the ingest payload for one photo from everything currently known about it. `faces` and
// `pictured` are OPTIONAL and meaningfully so: a caller that has no face data must pass them as
// undefined, NOT as 0/[] — see the extra-field note below.
export function buildPhotoPayload({ source, source_id, dateStr, filename, caption, faces, pictured, hintConfidence }) {
  const names = pictured ?? [];
  const baseText = currentTextRepr(dateStr, filename, caption);
  const payload = {
    source,
    source_id,
    type: 'photo',
    text_repr: names.length ? `${baseText} Pictured: ${names.join(', ')}.` : baseText,
    // `faces_detected: 0` asserts "we ran detection and found no faces" — a claim a caller that
    // never ran detection must not make, and one the wholesale `extra` replace would make
    // permanent. So an absent count stays absent rather than defaulting to 0 (#276).
    extra: { captioned: caption != null },
  };
  if (faces !== undefined && faces !== null) payload.extra.faces_detected = faces;
  if (pictured !== undefined) payload.extra.pictured = names;
  if (names.length) {
    payload.entity_hints = names.map((alias) => ({ alias, alias_type: 'name', role: 'pictured', confidence: hintConfidence }));
  }
  return payload;
}

// Read the face worker's two state files into a relPath -> { faces, pictured } lookup, so the
// caption worker can carry face enrichment through its own upsert without re-running detection.
// Both files absent (face pass never ran) is the normal, non-exceptional case — returns an empty
// map, and every caller then behaves exactly as it did before this existed.
export function readFaceEnrichment(faceStatePath, clustersPath) {
  const lookup = new Map();
  if (!faceStatePath || !existsSync(faceStatePath)) return lookup;
  let faceState;
  try {
    faceState = JSON.parse(readFileSync(faceStatePath, 'utf8'));
  } catch (err) {
    console.error(`photo-exif: unreadable face state at ${faceStatePath}; captioning without face data`, err);
    return lookup;
  }
  // An ABSENT clusters file is legitimate (the face pass ran but nothing has been named yet) and
  // yields `pictured: []`, matching what face-worker.js itself sends in that state. An
  // UNREADABLE one is an anomaly (mid-write on Windows, a directory, bad permissions) — bail to
  // the empty lookup rather than claim `pictured: []`, which would assert "nobody named is in
  // this photo" and, via the wholesale `extra` replace, make that false claim permanent. Same
  // absent-≠-empty reasoning as faces_detected above.
  let clusters = [];
  if (clustersPath && existsSync(clustersPath)) {
    try {
      clusters = parseClustersFile(readFileSync(clustersPath, 'utf8')).clusters;
    } catch (err) {
      console.error(`photo-exif: unreadable cluster state at ${clustersPath}; captioning without face data`, err);
      return new Map();
    }
  }
  const clustersById = new Map(clusters.map((c) => [c.id, c]));
  for (const [relPath, entry] of Object.entries(faceState)) {
    if (!entry || typeof entry.faces !== 'number') continue;
    lookup.set(relPath, { faces: entry.faces, pictured: picturedNames(entry.clusters ?? [], clustersById) });
  }
  return lookup;
}
