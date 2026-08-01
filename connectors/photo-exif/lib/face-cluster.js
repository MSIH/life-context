// Pure, IO-free face clustering: group face descriptors into anonymous clusters by
// nearest-centroid within a Euclidean threshold. No ML, no network, no disk — so it's unit
// testable directly and the face worker owns all IO. Descriptors never leave the connector
// (doc 04 §11: core rejects connector-supplied embeddings); only human-assigned names ever go
// on the wire, as `pictured` hints.
//
// Descriptors are L2-normalized 512-d ArcFace embeddings (face-detect.js), so Euclidean distance
// on them is monotonic with cosine distance (d = sqrt(2*(1-cos))) — nearest-centroid clustering
// below is unaffected by the model swap; only the threshold VALUE changes (see face-worker.js).

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// Assign a descriptor to the nearest existing cluster within `threshold`, else start a new one.
// A match updates that cluster's centroid as a running mean and increments its count. Mutates
// `clusters` in place and returns the assigned cluster id (ids are dense positive integers).
export function assignCluster(descriptor, clusters, threshold) {
  let best = null;
  let bestDist = Infinity;
  for (const c of clusters) {
    const dist = euclideanDistance(descriptor, c.centroid);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (best && bestDist <= threshold) {
    best.centroid = best.centroid.map((v, i) => (v * best.count + descriptor[i]) / (best.count + 1));
    best.count += 1;
    return best.id;
  }
  const id = clusters.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  clusters.push({ id, centroid: [...descriptor], count: 1, label: null, sample: null });
  return id;
}

// --- #342: merge clusters by centroid, without re-detecting a single photo -------------------
//
// FACE_MATCH_THRESHOLD governs fragmentation, but changing it costs a full re-detect (per-face
// descriptors are never persisted — only each cluster's running-mean centroid is). A merge pass
// over existing centroids approximates re-clustering at a looser threshold for the cost of
// arithmetic. This IS an approximation (merging means-of-means differs from sequential
// nearest-centroid assignment over individual faces) — see README's threshold-tuning note.

// Count-weighted centroid merge — `(cA*nA + cB*nB)/(nA+nB)`, consistent with assignCluster's own
// running-mean update, so a 2-photo pile can't drag a 500-photo pile's centroid. `survivor` keeps
// its id and sample; `label` is the survivor's if it has one, else the absorbed's — a labeled +
// unlabeled merge keeps the label, and same-label merges are unaffected. `merged_from` accumulates
// every absorbed id (including any the absorbed cluster had itself already absorbed), so the
// result is reconstructable from the record alone, the same posture `mergeEntities`' `absorbed_attrs`
// uses core-side. Pure: does not mutate `survivor`/`absorbed`, returns a new object. Refusing an
// incompatible (differently-labeled) pair is the CALLER's job (planMerges below) — this function
// trusts whatever it's given.
export function mergeTwo(survivor, absorbed) {
  const totalCount = survivor.count + absorbed.count;
  const centroid = survivor.centroid.map((v, i) => (v * survivor.count + absorbed.centroid[i] * absorbed.count) / totalCount);
  return {
    id: survivor.id,
    centroid,
    count: totalCount,
    label: survivor.label ?? absorbed.label ?? null,
    sample: survivor.sample ?? absorbed.sample ?? null,
    merged_from: [...(survivor.merged_from ?? []), absorbed.id, ...(absorbed.merged_from ?? [])],
  };
}

// Minimal binary min-heap, ordered by `compare`. Used only by planMerges below to avoid an O(n^2)
// full rescan every iteration (a real library's ~4769 clusters made that unusable — minutes and
// counting rather than the "seconds" this feature exists to promise); nothing here is IO or
// print, so it doesn't compromise this file's pure/IO-free contract.
class MinHeap {
  constructor(compare) {
    this._compare = compare;
    this._data = [];
  }
  push(item) {
    const data = this._data;
    data.push(item);
    let i = data.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._compare(data[i], data[parent]) < 0) {
        [data[i], data[parent]] = [data[parent], data[i]];
        i = parent;
      } else break;
    }
  }
  pop() {
    const data = this._data;
    if (data.length === 0) return undefined;
    const top = data[0];
    const last = data.pop();
    if (data.length > 0) {
      data[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < data.length && this._compare(data[l], data[smallest]) < 0) smallest = l;
        if (r < data.length && this._compare(data[r], data[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [data[i], data[smallest]] = [data[smallest], data[i]];
        i = smallest;
      }
    }
    return top;
  }
}

// Plan a single-linkage agglomerative merge of `clusters`: repeatedly merge the globally closest
// compatible pair within `threshold`, until none remain. Deterministic (#342 acceptance: proven,
// not asserted) — the closest pair merges first, and a tie is broken by (lowest survivor id, lowest
// absorbed id), so identical input always produces a byte-identical plan. The lower-id cluster of
// a merging pair always survives (simple, stable, and matches the tie-break's own "lowest id"
// bias) — so a chain of merges keeps converging toward the smallest id in its group.
//
// Two clusters carrying DIFFERENT non-null labels are never merged — refused and reported in
// `refusals` (deduped by pair, since labels never change back once set, a refusal is permanent for
// that pair and must only be reported once). A labeled + unlabeled pair merges and keeps the label.
//
// Pure and IO-free: never touches `clusters` (works over an internal deep-ish copy) and never
// prints. Returns `{ merges, refusals }` — `merges` is `{ survivorId, absorbedId, distance }[]` IN
// APPLY ORDER: replaying it via `mergeTwo`, in order, against the real cluster list reproduces
// exactly this plan. That equivalence — not a comment — is what makes a dry run's printed plan
// and `--apply`'s actual result provably identical (face-worker.js replays the same array both times).
//
// Performance note (why a heap, not the obvious "rescan every live pair each iteration"): only ONE
// cluster's centroid/label ever changes per iteration — the new survivor's — so every OTHER pair
// is unaffected. Instead of recomputing the full O(m^2) pair set every iteration (cubic overall —
// unusable past a few thousand clusters), each pair is evaluated ONCE up front and again only for
// (newSurvivor, *) after it changes; a min-heap picks the next closest candidate in O(log n).
//
// A heaped entry's DISTANCE can go stale (superseded by a fresher push for the same pair, or
// naming an id that's since been absorbed) — detected at pop time by recomputing it fresh and
// comparing to what was heaped, and discarded on a mismatch. But a pair's LABEL COMPATIBILITY can
// change WITHOUT any detectable centroid movement: mergeTwo's count-weighted mean of two IDENTICAL
// centroids returns that same centroid unchanged, so a survivor can inherit a label from what it
// absorbed while its distance to every other live cluster stays bit-for-bit identical — real
// libraries hit this via exact-duplicate photos (Google Takeout's `-edited` companions), which
// produce identical descriptors and therefore identical centroids. So the distance-staleness check
// is NOT a valid proxy for "is this entry's refusal status still current," and pop time re-derives
// label compatibility from LIVE state every time, never trusting whatever was true when the entry
// was heaped.
export function planMerges(clusters, threshold) {
  const state = new Map(clusters.map((c) => [c.id, {
    id: c.id,
    centroid: [...c.centroid],
    count: c.count,
    label: c.label ?? null,
    sample: c.sample ?? null,
    merged_from: [],
  }]));

  const merges = [];
  const refusals = [];
  const refusedPairs = new Set(); // "loId:hiId" already reported — dedup only, not a freshness cache

  // [distance, loId, hiId], loId < hiId always — matches the reported/tie-break order below.
  const heap = new MinHeap((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

  // Check (lo,hi)'s CURRENT live labels; if incompatible, log the refusal (once, deduped) and
  // return true. Called both when (re-)heaping a pair and again at pop time — the latter is what
  // catches a label change that happened with no accompanying centroid movement (see above).
  function checkRefused(lo, hi) {
    const cLo = state.get(lo);
    const cHi = state.get(hi);
    if (!(cLo.label && cHi.label && cLo.label !== cHi.label)) return false;
    const key = `${lo}:${hi}`;
    if (!refusedPairs.has(key)) {
      refusedPairs.add(key);
      refusals.push({ clusterA: lo, clusterB: hi, labelA: cLo.label, labelB: cHi.label });
    }
    return true;
  }

  // (Re-)evaluate one pair against its CURRENT live state: skip (refusal already logged by
  // checkRefused) if incompatible, else heap it if within threshold. Called once per pair up
  // front, and again for (newSurvivorId, everyRemainingId) after each merge — the only pairs whose
  // live state could possibly have just changed.
  function evaluatePair(x, y) {
    const lo = x < y ? x : y;
    const hi = x < y ? y : x;
    if (checkRefused(lo, hi)) return;
    const cLo = state.get(lo);
    const cHi = state.get(hi);
    const d = euclideanDistance(cLo.centroid, cHi.centroid);
    if (d <= threshold) heap.push([d, lo, hi]);
  }

  const ids = [...state.keys()].sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) evaluatePair(ids[i], ids[j]);
  }

  for (;;) {
    let entry;
    for (;;) {
      entry = heap.pop();
      if (!entry) break; // heap exhausted — no valid candidate remains
      const [d, lo, hi] = entry;
      const cLo = state.get(lo);
      const cHi = state.get(hi);
      if (!cLo || !cHi) continue; // one side was absorbed since this entry was heaped — stale
      // Re-derive label compatibility from LIVE state before trusting anything else about this
      // entry — a label can change with zero centroid movement (identical-centroid merge, see the
      // function comment), so this can NEVER be inferred from the distance check below.
      if (checkRefused(lo, hi)) continue;
      // Only a pair involving the MOST RECENT survivor can have a stale DISTANCE (everyone else's
      // mutual distance never changes) — recompute and compare to confirm this entry is still the
      // live truth, not a superseded snapshot from before that survivor's last merge.
      const fresh = euclideanDistance(cLo.centroid, cHi.centroid);
      if (Math.abs(fresh - d) > 1e-9) continue;
      break;
    }
    if (!entry) break;
    const [distance, survivorId, absorbedId] = entry;
    const merged = mergeTwo(state.get(survivorId), state.get(absorbedId));
    merges.push({ survivorId, absorbedId, distance });
    state.set(survivorId, merged);
    state.delete(absorbedId);
    for (const other of state.keys()) {
      if (other === survivorId) continue;
      evaluatePair(survivorId, other);
    }
  }

  return { merges, refusals };
}

// Serialization helpers for the clusters file. `version` bumps whenever a label changes so the
// scan pass can tell when a previously-ingested photo needs re-emitting.
export function parseClustersFile(text) {
  try {
    const o = JSON.parse(text);
    return { version: o.version ?? 0, clusters: Array.isArray(o.clusters) ? o.clusters : [] };
  } catch {
    return { version: 0, clusters: [] };
  }
}

export function serializeClustersFile(version, clusters) {
  return JSON.stringify({ version, clusters });
}
