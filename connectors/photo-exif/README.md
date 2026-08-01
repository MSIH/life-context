# photo-exif

The single photo/video connector for [LifeContext](https://github.com/msih/life-context). Three scripts make a media library time/place/person-queryable with zero inference, then optionally enrich it with real content understanding. Implements [Milestone 4](https://github.com/msih/life-context/blob/2.0/docs/05-roadmap.md) of the roadmap — the **batch** reference connector, and the proof that upsert-as-enrichment works.

**Handles both a plain photo library and a Google Takeout export** (#171 folded the former `gphotos-takeout` connector in here). Media from a **Google Takeout export** keys under `source='google-photos'`, `source_id='gphotos:<sha256>'`; everything else keys under `source='photo-exif'`, `source_id='<sha256>'`. Takeout-origin is decided **at the scan root, not per file** (#176): the root is a Takeout export when it *is* a `Google Photos` directory, contains one, or holds a Takeout marker (a `Photos from <YYYY>` bucket or an album `metadata.json`) — set `PHOTO_TAKEOUT=true|false` to force it. (Per-file sidecar presence is the wrong signal: Takeout omits a sidecar for some items — e.g. motion-photo `.MP4`s — and keying those generic would duplicate the `google-photos` row.) Person hints come from two sources: the sidecar's `people[]` (Google's face tags) and the immediate containing folder name (a person-named album/folder). Videos (`.mp4`/`.mov`/`.m4v`/`.3gp`/`.3gpp`) ingest as `type='video'`; images as `type='photo'`.

## Architecture decision: where the caption worker lives

The roadmap flags this as an open question ("worker lives with core or alongside — decide here," since doc 04 frames VLM captioning as a core-side "transducer," conceptually parallel to how core owns embeddings). **Decision: it lives here, in `photo-exif/`, as a second script alongside the scanner** — not in `life-context` core. Rationale:

- Consistency: `devsession-claude` and `imessage` are both pure isolated HTTP clients with zero direct database coupling; splitting `photo-exif`'s enrichment step into core would make it the only connector that isn't.
- The worker never needs to query "which artifacts need captions" from the server — it re-walks the same `PHOTO_ROOT` it already knows and checks its own local state file (`PHOTO_EXIF_CAPTION_STATE_PATH`). No new server-side capability required.
- It still upserts the *same artifact* (the `(source, source_id)` key is the file's content hash, computed identically in all three scripts via `lib/shared.js`'s `keyForMedia`), so the contract's upsert semantics do all the real work — the worker is just a slow, patient HTTP client like any other.

## What it does

### `scan.js` (deliverables 1–2)
1. Recursively walks `PHOTO_ROOT` for image files (`.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.tif`, `.tiff`) **and** videos (`.mp4`, `.mov`, `.m4v`, `.3gp`, `.3gpp`, ingested as `type='video'`).
2. Extracts `DateTimeOriginal` and GPS coordinates via `exifr`.
3. Submits GPS as raw `latitude`/`longitude` — this connector does no geocoding of its own. [LifeContext core](https://github.com/msih/life-context) resolves `place_label` from those coordinates server-side, fully offline (`src/geocode.js`), so every connector with GPS gets place resolution without bundling its own city dataset.
4. Computes a sha256 `content_hash` of the file bytes (streamed, not loaded fully into memory) — this content hash **is** the `source_id` (see keying above), so a re-organized library, a re-export, or a copy in another folder all key to the same artifact.
5. **Collapses byte-identical copies within a scan.** A Google Takeout export puts the same photo in its year bucket *and* every album it belongs to; scan.js merges copies that share a content hash into one payload before sending, unioning their `pictured` hints. (The server's upsert is additive too, so cross-batch copies still converge.)
6. Sends `type='photo'`/`type='video'` artifacts via `POST /api/v1/ingest/batch`.
7. Skips files unchanged since the last scan (mtime+size cache in `PHOTO_EXIF_MANIFEST_PATH`, keyed by relPath) — repeat scans over a large library only process what's new. On a long run scan.js prints a throttled `photo-exif: progress — …` line and **persists the manifest to disk on the same tick** (`PHOTO_EXIF_PROGRESS_INTERVAL_MS`, default 30000ms; `0` disables both), so a killed/crashed scan resumes to within one interval instead of re-hashing everything.
   - **Skips files core already has, even on a cold manifest (#198).** For files that miss the local manifest, scan.js hashes them (cheap), asks the server `POST /api/v1/exists` which `(source, source_id)`s are already stored, and runs the expensive EXIF read + ingest only for genuinely new files (logged per batch: `skip-check — N hashed, M already stored, K new`). This is what makes a **Takeout re-extract cheap** — unzipping resets every file's mtime, so the mtime-keyed manifest misses on everything, but the server check recognizes the already-imported library and skips it. Already-stored files are still recorded in the manifest so subsequent *local* runs skip them via a bare `stat`. Against a core that predates `/exists` (a `404`), scan.js logs one line and falls back to processing everything — never a hard failure.
8. **Person hints — two sources**, both `alias_type:'name'`, `role:'pictured'`, `confidence:0.9`; core resolves each against the entity graph (linking the photo, or staging an unresolved alias), never asserted as an entity here:
   - **Google Takeout sidecar `people[]` (#152)** — Google's user-verified face tags. If a per-photo `*.supplemental-metadata.json` (or an older/variant name) sits next to the file, scan.js reads it best-effort. It also uses the sidecar's **`photoTakenTime` / `geoData` as an EXIF fallback** — only when the file's own EXIF lacks a date/GPS (Takeout frequently strips EXIF on export); EXIF always wins when present, and `geoData {0,0}` (Google's "no location" sentinel) is not submitted as a coordinate. The sidecar resolver handles `<file>.supplemental-metadata.json`, `.supplemental-meta.json`, older `<file>.json`, the duplicate-media `(N)` variants, and a length-truncated prefix fallback (a per-directory scan, amortized to one readdir per folder — plain non-Takeout folders pay a negligible once-per-folder cost).
   - **Immediate containing folder name** — a JSON-less photo in `.../Aunt Mary/` maps to that person via a folder-name hint (a non-person folder simply won't resolve core-side, which is harmless). A file directly in `PHOTO_ROOT` (no subfolder) emits no folder hint, and a Takeout year bucket (`Photos from <year>`) is never treated as a person. The folder hint is deduped against sidecar names (case-insensitive).
   - Names are **not** written into `text_repr` (the caption/face workers rebuild `text_repr`, so people live in the durable `entity_hints`, not the prose).
   - **What core does with a name it can't resolve (#301).** Connector behavior is unchanged, but the downstream fate of these hints is no longer a dead end: a `name` hint that misses the entity graph (and misses the #293 given-name-prefix fallback) is staged in `unresolved_aliases` as before **and** looked up in the user's side contact directory (#154). If the directory names that person exactly, core stages a `proposed_entities` row for review — so a folder full of photos of someone who isn't a contact yet surfaces as one candidate to approve, and approving links every photo that named them. Ambiguous names (two directory cards sharing one display name) stage nothing. Nothing is ever minted from a hint.

### `caption-worker.js` (deliverables 3–4)
1. Walks the same `PHOTO_ROOT`, skipping anything already captioned (local state file).
2. Decodes each photo via the shared `lib/decode-image.js` helper (see "HEIC decoding" below), downscales it to fit 1024px (fastest useful size for a VLM call, smaller payload), and sends it to a local vision-language model (Ollama, default `llava`) for a one-sentence caption.
3. Upserts the **same** `(source, source_id)` with the caption appended to the original EXIF-based description — the upsert's merge semantics (doc 04 §3) mean `occurred_at`/GPS/`place_label`/`raw_path`/`content_hash` are left untouched; only `text_repr` and `extra.captioned` change. `content_hash` is always computed from the **original** file bytes, never the re-encoded JPEG sent to the VLM — the dedup key can't move just because this worker happens to re-encode the image for a model (#280).
4. Saves its state after **every** photo, not batched — kill-safe at any point.
5. Stops the run only after `VLM_MAX_CONSECUTIVE_FAILURES` VLM failures **in a row** (default 5, resetting on any success) rather than on the first one (#280) — one corrupt/unsupported photo at 2am must not waste the rest of a multi-hour overnight window; per-item ingest failures are logged and retried on the next run regardless.
6. Does its own scheduling for **nothing** — one pass, then exits. Nightly-window scheduling is config, not code (see below).

### `face-worker.js` (issue #53)

A third, local-first enrichment pass that links photos to *who is in them* via the contract's `pictured` `entity_hints` role (doc 04 §4). Detection runs entirely on-device — no cloud face API (Prime Directive: local-first).

1. Detects faces in each photo (local `onnxruntime-node` + `sharp` — SCRFD detection + ArcFace recognition, buffalo_l ONNX models loaded from `FACE_MODELS_PATH`; #268 swapped this off `@tensorflow/tfjs-node`/`@vladmandic/face-api`/`canvas`, which have no prebuilt Windows binary for current Node and need a VS C++ workload to build from source).
2. Clusters the 512-d, L2-normalized ArcFace face descriptors into anonymous groups by nearest-centroid (`FACE_MATCH_THRESHOLD`). **Descriptors never leave the machine** — they live only in the local clusters file; doc 04 §11 forbids connectors sending embeddings.
3. Records `extra.faces_detected` on every scanned photo. A photo whose faces are all in *unlabeled* clusters gets **no** `pictured` hint (its `text_repr` is re-sent as base + caption, reconstructed from the caption cache, so captioning is preserved, not extended).
4. Once you name a cluster (`label`), every photo containing it upserts `entity_hints: [{alias, alias_type:"name", role:"pictured", confidence}]` and a `text_repr` with a "Pictured: …" sentence appended to the base + caption text.

Commands:
```bash
node face-worker.js                         # scan: detect + cluster + emit hints for any labeled faces
node face-worker.js export-thumbnails ./faces   # one sample image per cluster + index.json, to eyeball who's who
node face-worker.js label 7 "Sarah Jones"   # name cluster 7; re-emits its photos' hints immediately
node face-worker.js suggest-labels          # print (never apply) name suggestions for unlabeled clusters
node face-worker.js suggest-from-sidecars   # print (never apply) name suggestions from Google Photos sidecar tags
node face-worker.js merge-clusters --threshold 1.2 [--apply] [--max-merge-fraction 0.5] [--force]  # merge clusters by centroid, no re-detection (#342)
```

Nothing is sent for a cluster until you name it — an unnamed cluster is just an anonymous bucket, so no fabricated aliases pollute the entity graph. Naming is a deliberate, local trust decision; alias→entity resolution stays core's job.

#### `suggest-labels` — pre-name clusters from contact photos (#84)

Speeds up labeling by using each contact's **current** photo as a reference face — the UI-uploaded override (`attrs.photoFile`, #97) if present, else the imported vCard photo (core's `PHOTO` import, #74) — the same photo the contacts UI shows (`GET /api/v1/entities/photos` applies that precedence, #112). It only ever **prints** candidate matches to stderr — it never writes `cluster.label` and never emits an ingest hint. You still confirm with the existing `label <id> "<name>"` command; a wrong auto-label would be worse than an anonymous cluster.

```bash
node face-worker.js suggest-labels
# photo-exif: suggest — cluster 7 (12 photo(s)) possibly "Sarah Jones" (entity #42, distance 0.31 <= threshold 0.6)
# photo-exif: suggest-labels — checked 18 contact photo(s), 1 cluster(s) suggested
```

**Requires this connector's process to be able to read the file path LifeContext core returns** (`raw_path`, under core's `CONTACTS_RAW_DIR`) — i.e., this connector and core must share a filesystem (same machine, or a mounted/synced volume). There is no endpoint to fetch the raw bytes over HTTP; a `raw_path` this process can't read is skipped and logged, not fatal to the run. If `CONTACTS_RAW_DIR` is a relative path in core's `.env`, set it to an **absolute** path there for reliable resolution — a relative path resolves against whatever directory core's own process happened to start from, which this connector has no way to know. Already-labeled clusters are never re-suggested, and a reference photo with zero or multiple detected faces is skipped as ambiguous. Tune the match distance with `FACE_SEED_THRESHOLD` (defaults to `1.15`, looser than `FACE_MATCH_THRESHOLD`) — see `.env.example`.

#### `suggest-from-sidecars` — pre-name clusters from Google Photos sidecar tags (#272)

For a Takeout library, this is usually cheaper than `suggest-labels`: it joins the face scan's own state (`extra.faces_detected` + cluster membership) against the sidecar `people[]` tags scan.js already reads (doc 04, #152) — **no ONNX/detection call, no contact photos, no network**. A photo with exactly one detected face in exactly one cluster, whose sidecar names exactly one person, is a `(cluster → name)` vote; each unlabeled cluster's majority name is the suggestion. It only ever **prints** — never writes `cluster.label`, never emits an ingest hint, never touches the clusters/face-state files. Requires a prior `scan` over a Google Takeout library (so `FACE_STATE` and sidecars both exist).

```bash
node face-worker.js suggest-from-sidecars
# photo-exif: suggest-from-sidecars — cluster 12 → "Amy Fenwick" (48 of 51 single-name votes, 94%)
# photo-exif: suggest-from-sidecars — cluster 7: no majority (Amy Fenwick 4, Matt Sorrel 3 of 12) — skipped
# photo-exif: suggest-from-sidecars — checked 9 unlabeled cluster(s) against 63 single-name/single-face photo(s), suggested 4
```

A suggestion requires the top name to clear **both** `FACE_SEED_MIN_VOTES` (default 3, a minimum raw count) and `FACE_SEED_MIN_FRACTION` (default 0.7, a minimum share of that cluster's votes) — see `.env.example` — so a stray Google mis-tag or an impure/merged cluster doesn't produce a confident wrong label. Already-labeled clusters are excluded silently; a photo with more than one detected face, more than one cluster, or a sidecar naming more than one person doesn't count as a vote (too ambiguous).

#### `merge-clusters` — merge existing clusters by centroid, without re-detecting any photo (#342)

`FACE_MATCH_THRESHOLD` governs how fragmented clustering is, but it's a one-shot dial: per-face descriptors are never persisted (only each cluster's running-mean centroid + count is), so changing the threshold normally means re-detecting the whole library. `merge-clusters` makes that reversible in seconds instead — it agglomerates existing centroids (single-linkage: repeatedly merge the globally closest pair within `--threshold`, count-weighted mean on merge) with **zero ONNX, zero image decode, zero network** until you `--apply`.

```bash
node face-worker.js merge-clusters --threshold 1.2                     # dry run: print the plan, write nothing
node face-worker.js merge-clusters --threshold 1.2 --apply             # perform it
node face-worker.js merge-clusters --threshold 1.2 --apply --max-merge-fraction 0.7 --force
```

```
photo-exif: merge-clusters — DRY RUN at threshold 1.20
photo-exif: merge — 412 + 1877 -> 412 (18 + 3 photos, distance 0.94)
photo-exif: refuse — 88 + 1204 both labeled ("Amy Fenwick" / "Beth Allister"), skipped
photo-exif: merge-clusters — 4769 clusters -> 1338 (3431 merges, 2 refusals); re-run with --apply
```

- **Dry run by default, `--apply` is opt-in** — same posture as `suggest-labels`/`suggest-from-sidecars`: a read command never mutates.
- **Deterministic.** The closest pair merges first; a tie is broken by the lowest cluster id. Identical input always produces the identical plan — proven by `test.mjs`, not merely asserted — and `--apply`'s result is exactly what the dry run printed (both replay the same plan through the same arithmetic).
- **This is an approximation, not equivalent to re-detecting at a looser threshold.** Merging means-of-means differs from sequential nearest-centroid assignment over individual faces. It trades exactness for reversibility — validate a candidate threshold value against real re-detection on a sample before committing to it as a permanent setting (the companion threshold-tuning chore, not this command).
- **Two differently-labeled clusters are never merged** — refused and named in the output, left untouched. A labeled + unlabeled merge is allowed and keeps the label (an unlabeled survivor inherits the label it absorbs).
- **The survivor records `merged_from: [ids]`**, so a merge is reconstructable from the clusters file itself, not just from having watched the run.
- **`--apply` always writes a backup first** (`merge-backups/<timestamp>/` next to the clusters file) — these two JSON files are the only copy of many hours of detection work.
- **`--max-merge-fraction`** (default `0.5`) refuses an apply that would collapse more than that fraction of clusters in one run — a fat-fingered `--threshold` must not silently fuse the whole library into a handful of piles. Exits 1 without writing; `--force` overrides.
- **No re-detection, ever.** `photo-exif-faces.json`'s per-photo `faces` counts are untouched; only `clusters` id arrays are remapped (to the surviving id, deduped) and the two enrichment-worker state files are persisted together before any network call — the same crash-safety invariant `scan()` depends on.
- **There is still no split command.** A wrong merge is undone by restoring the backup `--apply` wrote.
- **Runtime scales with library size, not with "seconds" at every size.** `planMerges` evaluates every pair once up front (unavoidable — it's what makes the plan correct) and then only the merging cluster's pairs again per merge, via a min-heap rather than a full rescan, so it's far from the naive cubic approach — but on a library with several thousand clusters, a full run is still on the order of a minute or two, not instant. The built-in `--max-merge-fraction` guard means an unforced run never collapses more than half the library in one pass, which bounds the realistic worst case; `--force`-ing a near-total collapse on a very large clusters file is the slow end of that range.

## HEIC decoding, shared across both AI passes (#280)

Both the caption worker and the face worker need actual **pixels**, not just EXIF metadata — and `sharp`'s bundled libheif cannot decode a large share of real-world iPhone HEICs (two distinct failure modes measured against this project's own library: a "decoder plugin generated an error" on some files, and an `iref` box reference-count security limit on others — both hit files sharp's own `.metadata()` call reports as fine, because `.metadata()` only parses container boxes and never actually decodes; it is **not** a valid HEIC-support check). `lib/decode-image.js` is the one shared helper both workers call (`await openImage(absPath)`, returning a `sharp` pipeline) so this logic exists exactly once:

- **sharp is the primary decoder** for every format, including most HEIC/HEIF — it's native, fast, and already correct for jpg/png/tif.
- **`heic-decode`** (pure-JS libde265 via WASM — no compiler, no native build step) is the fallback for the HEICs sharp can't open. It's markedly slower (~0.25–1.3s/photo vs. sharp's native decode), so dispatch is **extension-first**: a `.heic`/`.heif` file tries `heic-decode` first (skipping a decode attempt already known to fail), everything else tries `sharp` first. Either path falls back to the other on error, since a Google Takeout export sometimes mislabels extensions.
- **Orientation is the subtle part.** The sharp path applies `.rotate()` (EXIF orientation). The heic-decode path deliberately does **not** — libheif already applies the HEIC container's own rotation transform during decode, so a second EXIF-driven rotate would double-rotate every portrait iPhone photo (catastrophic for face detection, which depends on upright faces). A raw pixel buffer also carries no EXIF for `.rotate()` to read, so getting this wrong is a silent no-op in code, not a thrown error — it only shows up as sideways/mirrored faces on real photos.
- **`heic-decode`'s dependency `libheif-js` is LGPL-3.0** (this repo is MIT). It's an unmodified, separately-installed npm runtime dependency of an optional connector — never vendored or statically linked, freely replaceable — the ordinary LGPL-compliant arrangement.
- **The helper never resizes** — that stays caller policy (the caption worker wants ~1024px for a faster VLM call; the face worker needs full resolution for detection accuracy, and letterboxes to 640px itself).

**Manual verification is required after touching this file** — the only automated tests are dispatch/fallback logic against an injectable decoder seam (`createOpenImage`, mirroring `resolveDetector`/`fixtureDetector` in `lib/face-detect.js`); there's no real HEIC fixture in this repo (no encoder on this box can synthesize one, and committing a real photo isn't appropriate for a public repo). To verify a change: decode a real portrait iPhone HEIC end-to-end and **look at the output image** — correct content, right-side up, not mirrored. **Never use `sharp.metadata()` as a HEIC-support check** (see above) — it will report success on a file that cannot actually be decoded.

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` / `PHOTO_ROOT`.
2. `npm install` (real dependency: `exifr`; `caption-worker.js` and `face-worker.js` additionally need `sharp` and `heic-decode` to decode pixels, `face-worker.js` also needs `onnxruntime-node` — all three ship prebuilt binaries/WASM, no native compile step, only loaded lazily when you actually run one of those scripts).
3. Backfill: `node scan.js`.
4. Optionally, once you have a vision model pulled in Ollama (`ollama pull llava`): `node caption-worker.js`.
5. Optionally, for face → contact linking: download the buffalo_l ONNX model pair into `FACE_MODELS_PATH` — `det_10g.onnx` (SCRFD detection) and `w600k_r50.onnx` (ArcFace recognition), from the InsightFace model zoo, one-time and fully offline after — then `node face-worker.js`, browse clusters with `export-thumbnails`, and `label` the ones you recognize.

### Prep a Takeout download (Windows) — `prep-takeout.ps1`

A Google Takeout photo export arrives as multi-part zips (`takeout-*.zip`) that must be unzipped before `scan.js` can walk them, and the zips then eat a lot of disk. `prep-takeout.ps1` does that prep in one pass over `-PhotoRoot` (default `C:\Artifacts\life-context\photo`):

1. Extracts each `takeout-*.zip` into `-PhotoRoot` (the parts are independent archives that merge into the shared `Takeout\` tree; `-Force` overwrites byte-identical dupes across parts).
2. **Only after a zip extracts successfully**, sends that zip to the **Recycle Bin** (a failed extract leaves its zip in place and is logged — nothing is lost to a half-run).
3. Recurses the extracted tree and sends every movie file (`.mp4,.mov,.m4v,.avi,.mkv,.wmv,.mpg,.mpeg,.3gp,.3gpp,.webm` by default, `-VideoExtensions`) to the **Recycle Bin**, so videos never reach the library.
4. **Auto-launches `scan.js`** (the inject connector) so one command does unzip → recycle → ingest. The scan runs in the foreground (prep returns only after it finishes) and only when at least one zip was extracted. `-NoScan` skips it (extract + recycle only). A scan failure is logged (`scan FAIL`) but never negates the successful extract/recycle — `scan.js` is resumable (warm manifest + `/api/v1/exists`), so re-running it later finishes the job. Assumes `node` is on PATH (the same `node scan.js` you'd otherwise run manually).

```powershell
powershell -File prep-takeout.ps1 -WhatIf   # dry-run: log every action, change nothing (no scan)
powershell -File prep-takeout.ps1           # unzip + recycle, then auto-run scan.js
powershell -File prep-takeout.ps1 -NoScan   # unzip + recycle only (skip the ingest)
```

**Persistent, append-only run log (`-LogPath`).** Stdout is ephemeral, so every run also **appends** to a log — default `<PhotoRoot>\prep-takeout.log`, overridable with `-LogPath` — that accumulates the full history of every part ever processed, so you can later answer "did I process every Takeout part?" or audit a destructive run. It is written *alongside* the stdout output (tee, so interactive use is unchanged), and is **append-only** (never truncated). Each line is `UTC-timestamp LEVEL message` (`LEVEL` = `INFO`/`WARN`); a run logs a run-start header (start time, PhotoRoot, zip count, WhatIf flag), a per-zip `extract ok|FAIL <reason>` and `recycle ok|FAIL <reason>` (the failure line carries the exception message, e.g. `A local file header is corrupt.`), a single `videos recycled=<n> failed=<n>` summary (not one line per video), and a final `run end ...` tally. When no zips match the pattern, the run logs the start header, a `no zips to process` line, and a `run end ... extracted=0 ...` tally — no per-zip or video-summary lines. `-WhatIf` lines carry a `[WhatIf]` marker. Logging is **best-effort** — an unwritable log degrades to a stdout warning and never aborts the run — and the `.log` is inert to the script's own scans (it is neither a `takeout-*.zip` nor a video). Example:

```
2026-07-16T20:14:03Z INFO  run start PhotoRoot=C:\Artifacts\life-context\photo zips=10 whatif=False
2026-07-16T20:14:03Z WARN  extract FAIL takeout-...-015.zip -- A local file header is corrupt.
2026-07-16T20:19:41Z INFO  extract ok takeout-...-021.zip
2026-07-16T20:19:58Z INFO  recycle ok takeout-...-021.zip
2026-07-16T21:02:10Z INFO  videos recycled=1234 failed=0
2026-07-16T21:02:10Z INFO  run end zips: extracted=9 recycled=9 failed=1 | videos: recycled=1234 failed=0
```

**Recycle Bin, never permanent delete** — recoverable, and matching this project's append-only ethos and the box's delete-blocked posture (the `rm`/`Remove-Item` deny); it uses `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(SendToRecycleBin)`, not `Remove-Item`. **Caveat:** the Recycle Bin still occupies disk until emptied — to actually reclaim the space after a verified run, empty it manually (the script can't, since permanent delete is blocked). Windows-only.

### Wave order — either order is safe, one at a time (#276)

Run `scan.js` first (it creates the artifacts). After that, **the caption and face passes may run in either order** — whichever runs second preserves the first one's work.

**Run them one at a time, not concurrently.** Each worker snapshots the other's state once at startup, so a face `label` applied *while* a caption run is in flight won't be seen by that run, and the caption upsert will overwrite it with the older picture. Sequential runs in either order are safe; overlapping runs are not.

The hazard this protects against: the ingest contract requires `text_repr` on every upsert and replaces it (and `extra`) **wholesale** — there is no deep-merge (doc 04 §3). So whichever enrichment pass runs second overwrites the first one's contribution unless both send the *union* of what's known.

Both workers therefore build their payload through the one shared builder in **`lib/photo-payload.js`**:

- The **face worker** reads the caption cache and rebuilds *base + caption + "Pictured: …"*.
- The **caption worker** reads the face state + clusters files and carries `faces_detected` / `pictured` / the "Pictured: …" sentence through.

Two properties worth knowing:

- **Absent is not zero.** If the face pass hasn't touched a photo, the caption worker omits `faces_detected` and `pictured` entirely rather than sending `0`/`[]` — sending `0` would assert "detection ran and found nothing," which would be false and, thanks to the wholesale replace, permanent.
- **Keep both state directories co-located with the workers.** They read each other's state from `~/.life-context/` (overridable via `PHOTO_EXIF_CAPTION_STATE_PATH`, `PHOTO_EXIF_FACE_STATE_PATH`, `PHOTO_EXIF_FACE_CLUSTERS_PATH`). A worker that can't see the other's state falls back to writing only what it knows — correct, but it will drop the other's contribution, which is the pre-#276 behavior. Running the two passes on *different machines* against the same server is therefore still unsupported.

### Nightly-window scheduling (config, not code)

`caption-worker.js` does one pass and exits — schedule it to run during an off-hours window with cron (it naturally stops at the end of its pass; killing it mid-run is safe and just resumes next time):

```cron
# Run nightly between 1am and 5am; a `timeout` bounds the window in case the library is huge
0 1 * * * cd /path/to/life-context/connectors/photo-exif && timeout 4h node caption-worker.js >> ~/.life-context/photo-exif-captions.log 2>&1
```

On Windows, use Task Scheduler with a "Daily, 1:00 AM" trigger running `node caption-worker.js`, and a second trigger at 5:00 AM that kills the `node.exe` process if it's still running.

### Recurring scheduling (face-worker) — `schedule-face-worker.ps1` (#278)

`face-worker.js` has the same one-shot shape as `caption-worker.js` (scan, then exit) and the same need for a recurring trigger — but `schedule-face-worker.ps1` registers it with Windows Task Scheduler directly, rather than documenting the GUI/kill-node.exe steps above:

```powershell
powershell -File schedule-face-worker.ps1                                  # register/update, defaults: 06:00 daily, 2h limit
powershell -File schedule-face-worker.ps1 -TriggerTime "23:30" -ExecutionTimeLimitHours 3
powershell -File schedule-face-worker.ps1 -WhatIf                          # dry-run: log the action, change nothing
powershell -File schedule-face-worker.ps1 -Unregister                      # remove the task cleanly
```

Params (all optional, all with defaults): `-TaskName` (`LifeContextFaceWorker`), `-TriggerTime` (`"06:00"`, 24h `HH:mm`), `-ExecutionTimeLimitHours` (`2`), `-PhotoExifDir` (the script's own directory), `-WhatIf`, `-Unregister`. Re-running the script (with the same or different params) updates the existing task **in place** — `Register-ScheduledTask -Force` replaces a same-named task rather than duplicating it, so the task count stays at 1 across repeated runs.

**Why `MultipleInstances=IgnoreNew` + `ExecutionTimeLimit`, not the caption-worker doc's kill-`node.exe` trigger above.** That pattern works for caption-worker's documented setup, but it's the wrong default here: this box routinely runs a dozen-plus unrelated `node.exe` processes (editor tooling, other services, etc.), and a trigger that kills every process named `node.exe` would take all of them out along with the overrun face-worker run — collateral damage, not a targeted stop. Two built-in Task Scheduler settings avoid that entirely, with zero custom code:
- `MultipleInstances = IgnoreNew` — Task Scheduler refuses to start a new instance while one is already running, so a trigger firing mid-backlog-run (or on top of a previous still-running trigger) is simply skipped, not raced. This is also the only guard against two `face-worker.js` processes writing the same state files (`photo-exif-faces.json` / `photo-exif-face-clusters.json`) concurrently — the script has no internal locking of its own.
- `ExecutionTimeLimit` (default 2h, `-ExecutionTimeLimitHours`) — Task Scheduler terminates **only this task's own process tree** if it overruns, never a same-named process started some other way. No blast radius beyond the one scheduled run.

Default trigger time (06:00) is deliberately outside the caption-worker doc's documented 1am–5am window, so the two don't collide by default if #275 ever adds its own caption-worker schedule on this box — coordinating the two schedules is explicitly out of scope here (#278) until that happens.

**The task registers with `LogonType S4U`, not the `Register-ScheduledTask` default of `Interactive`.** Interactive requires the invoking account to have an active console session at trigger time — silently never firing a 6am run on a box with nobody logged in defeats the entire point of an unattended recurring job. `S4U` runs whether or not the account is logged on, with no password stored (unlike `LogonType Password`), and only needs the account to hold "Log on as a batch job" (`SeBatchLogonRight`) — Administrators has this by default on Windows.

**No changes needed in `face-worker.js` itself for recurring runs to be cheap.** Its existing `statKey` (mtime+size) skip logic already means an unchanged file costs a bare `stat`, not a re-detect — so once the initial backlog (#217) finishes, a scheduled recurring run only pays real detection cost for genuinely new/changed photos.

## Exit test (roadmap M4)

"Photos from Austin in 2019" works from EXIF alone before any caption exists; a captioned photo answers a content query ("photos of us cooking") without creating a duplicate artifact — guaranteed by the ingest contract's upsert-on-`(source, source_id)` semantics, since all three scripts compute the `(source, source_id)` key identically (`lib/shared.js`'s `keyForMedia`, from the file's content hash).

## Known limitations

- **Reverse geocoding happens in LifeContext core, not here** — this connector submits raw `latitude`/`longitude` only. `place_label` resolution (coarseness, the "near" prefix, the distance cutoff beyond which nothing is labeled) is core's behavior now (`src/geocode.js` in [`msih/life-context`](https://github.com/msih/life-context)), not this connector's.
- **`occurred_at` is never guessed from file mtime.** A photo with no `DateTimeOriginal` gets no `occurred_at` (and the core server's own warning), never an approximation — an import-time mtime would make a 2019 photo sort as "today," which is worse than an honest gap (doc 04 §3).
- **Source ID is the content hash.** The `source_id` is the file's sha256 (see keying above), so moving/renaming/re-exporting a photo, or the same photo appearing in several Takeout folders, all key to the *same* artifact. The tradeoff is the inverse of a path key: an **edited** copy (different bytes) is a distinct artifact even though it's "the same" photo — intended.
- **Year-bucket / folder-hint detection is English-only** (`Photos from <year>`). A non-English Takeout names year folders differently; such a folder would be read as an album and its name emitted as a (usually non-resolving, harmless) person hint.
- **The caption worker has no real vision model to test against in this repo's CI/dev environment** — `test.mjs` verifies the full flow (state tracking, upsert-only-what-changed, VLM-down handling) against a mock Ollama server, but the actual caption quality/latency of a real `llava` (or similar) model is unverified here.
- **The `heic-decode` fallback is real but slow** — ~0.25–1.3s per HEIC photo it has to handle (measured against files sharp's bundled libheif can't open), against sharp's near-instant native decode for everything else. Noise for the caption worker (VLM inference dominates); adds real wall-clock time to a full-library face-detection pass. See "HEIC decoding" above for why this fallback exists and how dispatch works.

## Testing without a real photo library or VLM

`test.mjs` (`npm test`) synthesizes JPEGs with injected EXIF via `piexifjs` (analogous to how the `imessage` connector's tests use `bplist-creator`) and runs the scripts against mock ingest/VLM HTTP servers. Covers: EXIF+GPS, GPS-only, and no-metadata photos; content-hash keying (generic `photo-exif`/`<hash>` vs. Google-origin `google-photos`/`gphotos:<hash>`); Takeout sidecar people/date/geo parsing; byte-identical copies collapsing to one payload with unioned hints; folder-name person hints (subfolder yes, root none, year bucket none); video (`type='video'`) typing; unchanged-file skipping on re-scan; caption enrichment preserving EXIF-sourced fields via upsert semantics; kill-safe per-photo state; VLM-unreachable handling; the caption worker surviving an isolated VLM failure and stopping only after `VLM_MAX_CONSECUTIVE_FAILURES` in a row (#280); and `lib/decode-image.js`'s dispatch/fallback logic against an injected decoder seam — `.heic`/`.heif` routes to `heic-decode` first (and only the sharp path rotates), everything else routes to sharp first, either falls back to the other on failure, and both failing throws one error naming both causes (#280). Real HEIC decoding itself has no fixture here (no encoder on this box can synthesize one) and stays a manual, on-device check — same posture as the VLM/ONNX paths below. `merge-clusters` (#342) is covered directly: weighted-mean arithmetic, plan determinism (identical input → byte-identical plan, proven via `deepEqual` across two independent calls) and the closest-pair/tie-break ordering, refusing a differently-labeled pair while a labeled+unlabeled pair merges and keeps the label, face-state `clusters` remapping/dedup across a multi-hop merge chain with no dangling references, a dry run writing nothing, `--apply` persisting both state files before its one network call (proven by snapshotting them from inside the mock ingest server's request handler), the backup it writes, and the `--max-merge-fraction` guard tripping/being overridden by `--force`.

## Known limitations (face worker)

- **Clustering is approximate** — nearest-centroid with a fixed Euclidean threshold, not a trained recognizer. Expect occasional split clusters (same person, two buckets) or, rarely, a merged one; `export-thumbnails` + re-`label` is the correction path.
- **`export-thumbnails` writes the sample *image*, not a tight face crop** — a real crop would pull in the native image-processing stack at export time. Per-face bounding boxes aren't persisted today (the clusters file stores only centroid/count/label/sample), so a future cropped version would need to re-detect the sample image or start persisting boxes.
- **The ML stack is unverified in this repo's CI** — `test.mjs` covers the full clustering/label/ingest pipeline with an injected fixture detector (no models), so the wire behavior is tested, but real ONNX detection/recognition quality/latency is a manual, on-device concern (same posture as the VLM caption worker). The pure decode/alignment math (`lib/face-align.js`) — SCRFD box/keypoint decode, NMS, and the Umeyama similarity + bilinear warp used to align each face crop — **is** unit-tested without any model.
- **Native dependencies** — `onnxruntime-node` and `sharp` ship prebuilt binaries for current Node/Windows (no VS C++ workload, unlike the tfjs-node stack this replaced, #268), and `heic-decode` is pure JS/WASM (no native build at all, #280); all three are only loaded (via dynamic import) when a scan actually decodes an image, so the other scripts and the test suite need none of them.
- **`suggest-labels` requires a shared filesystem with core (#84)** — it reads `raw_path` values LifeContext core returns; there's no HTTP endpoint to fetch those bytes, so this connector must be able to read the same disk (or a mounted/synced volume) core wrote contact photos to. Cross-machine setups (this connector on a different host than core, e.g. the Mac Mini/Windows-server iMessage topology) aren't supported for this command specifically — everything else in this connector works unchanged in that topology.
- **`merge-clusters` is an approximation, and there is still no split command (#342)** — merging means-of-means centroids is not identical to re-detecting at a looser threshold, so a merge plan should be understood as a fast, reversible-by-backup preview, not ground truth for a permanent `FACE_MATCH_THRESHOLD` change. Undoing a bad merge means restoring the backup `--apply` wrote; there is no way to split a cluster back apart in place.

## Files

- `prep-takeout.ps1` — Windows pre-scan prep: unzip a Takeout export, recycle the zips + any videos (Recycle Bin, never permanent delete)
- `scan.js` — the media batch scanner (EXIF + Takeout sidecars + folder-name hints; walks images **and** videos)
- `caption-worker.js` — the VLM enrichment worker (images only)
- `face-worker.js` — the local face-detection/clustering worker, images only (`scan` / `label` / `export-thumbnails` / `suggest-labels` / `suggest-from-sidecars` / `merge-clusters`, #342)
- `schedule-face-worker.ps1` — Windows Task Scheduler registration for recurring `face-worker.js` runs (register/update, `-WhatIf`, `-Unregister`; #278)
- `lib/shared.js` — env loading, media walk (`walkImageFiles`/`walkMediaFiles`), the content-hash keying resolver (`keyForMedia`), `mediaType`, ingest client, contact-photos fetch (`suggest-labels`)
- `lib/describe.js` — shared EXIF + Takeout-sidecar description logic (`describePhoto`/`readSidecar`/`sidecarPathFor`), used by every script so they can never drift
- `lib/caption-cache.js` — caption state (relPath→text map) + `currentTextRepr`, shared by caption + face workers
- `lib/photo-payload.js` — the single ingest-payload builder both enrichment workers use, so neither clobbers the other's `text_repr`/`extra` (#276); also reads the face state into a `relPath → {faces, pictured}` lookup for the caption worker
- `lib/decode-image.js` — the shared HEIC-capable image decode both AI passes use (`openImage`, sharp-primary/heic-decode-fallback, orientation-safe — #280); see "HEIC decoding" above
- `lib/face-cluster.js` — pure, IO-free descriptor clustering (euclidean, nearest-centroid, (de)serialization) + centroid-merge planning (`planMerges`/`mergeTwo`, #342)
- `lib/face-align.js` — pure, IO-free SCRFD decode (distance2bbox/kps, anchor centers, NMS) + Umeyama similarity/bilinear warp used to align each 112x112 ArcFace input crop (#268)
- `lib/face-detect.js` — lazy ML-model detector + the test fixture detector
- `test.mjs` — `node --test` suite
- `.env.example` — copy to `.env`
