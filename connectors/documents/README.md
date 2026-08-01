# documents

Three scripts that make a document tree (PDF/DOCX/XLSX/PPTX) semantically searchable in [LifeContext](https://github.com/msih/life-context), then optionally OCR the scans and extract vendor/amount/date from bills & receipts. One universal connector with per-format extractor modules rather than one connector per format — connectors can't share code across folders, so per-format connectors would duplicate the walk/hash/manifest boilerplate four times over and scan the same tree repeatedly.

## Architecture decision: OCR scope

`ocr-worker.js` covers **image-only PDFs only**. Standalone images (`.png`/`.jpg`/`.tiff`) are [`photo-exif`](../photo-exif/)'s source ownership — OCRing them here would create a second artifact for the same file under a different `source`, breaking dedup-by-`(source, source_id)`. OCR of scanned *photos* belongs as a future photo-exif enrichment wave, exactly like its caption worker.

The worker follows photo-exif's caption-worker pattern: it never queries the server for work. `scan.js` writes a local queue file (`DOCUMENTS_OCR_QUEUE_PATH`) whose entries carry each file's `statKey` **and its complete wave-1 `extra`** — the server's upsert overwrites `extra_json` as one whole field (never a key-merge), so the worker must resend the full object with the OCR outcome layered on.

## What it does

### `scan.js`
1. Recursively walks `DOCUMENTS_SCAN_ROOT` for `.pdf`, `.docx`, `.xlsx`, `.pptx` (case-insensitive).
2. Extracts text per format — PDF via `pdfjs-dist`, DOCX via `mammoth`, XLSX via `exceljs` (sheet-by-sheet `cell | cell` lines, per-sheet cap), PPTX via raw slide XML (`Slide N: …` lines, numeric-sorted so slide10 follows slide9).
3. Extracts `occurred_at` from the document's own metadata only — PDF `CreationDate`, OOXML `docProps/core.xml` `dcterms:created` — with a sanity clamp (pre-1980/future → omitted). Never file mtime.
4. Builds `text_repr` = an always-surviving header (`Document (PDF, 12 pages): reports/2019/tax.pdf — "Title"`) + the body, head+tail-truncated at `DOCUMENTS_TEXT_REPR_MAX_CHARS` (default 12,000 — see tradeoff below).
5. Computes a sha256 `content_hash` of the file bytes (from the same in-memory buffer the extractor uses — one disk read per file, bounded by the size guard) and sets `raw_path` to the original file.
6. Sends `type='document'` artifacts via `POST /api/v1/ingest/batch`, chunking batches by **serialized size** as well as the 100-item cap — document payloads are big enough to blow the API's 256KB request limit where photo one-liners never could. `429`s are retried with backoff; the manifest and queue are persisted after **every successful batch**, so a failed run loses at most its uncommitted window.
7. Flags PDFs with no real text layer (< 25 meaningful chars/page) as `extra.needs_ocr: true` — they still ingest immediately (findable by filename/title from wave 1) and land in the OCR queue.
8. Skips files unchanged since the last scan (mtime+size cache in `DOCUMENTS_MANIFEST_PATH`), files over `DOCUMENTS_MAX_FILE_MB` (not cached, so raising the limit picks them up), and unreadable files/subdirectories (logged, retried next run).

### `ocr-worker.js`
1. Drains the queue scan.js wrote: rasterizes up to `DOCUMENTS_OCR_MAX_PAGES` pages per PDF (`pdfjs-dist` + `@napi-rs/canvas`, ~144 DPI) and OCRs them with `tesseract.js` — pure WASM, fully local, no cloud.
2. Upserts the **same** `(source, source_id)` with the OCR'd text_repr; the upsert's merge semantics (doc 04 §3) leave `occurred_at`/`raw_path`/`content_hash` untouched.
3. Drops stale queue entries (file moved/changed — the next scan re-flags if still image-only) and drops files that fail OCR or are deterministically rejected by the server (4xx) with a loud stderr line rather than looping on them forever.
4. Updates the queue after **every** file via an atomic fresh read-modify-write — kill-safe at any point, and safe against a scan.js run finishing concurrently (both sides merge into the current file rather than overwriting it with a run-start snapshot; a fully lock-free guarantee would need per-entry files, doc 04 §7's spool caveat).
5. Stops the whole run (rather than failing through the entire queue) if tesseract can't initialize or the LifeContext server is unreachable.
6. Enqueues each OCR'd PDF into the **extraction queue** (`DOCUMENTS_EXTRACT_QUEUE_PATH`) once it has a text layer — the path `scan.js` can't take for image-only files (they have no text at scan time), so scanned receipts still reach vendor extraction.
7. Does its own scheduling for **nothing** — one pass, then exits (see scheduling below).

### `vendor-worker.js` (#123)
Turns bills/receipts/invoices/prescriptions from undifferentiated `document` artifacts into records that can seed a vendor org and answer "what did I spend at *X*".
1. Drains the extraction queue (`DOCUMENTS_EXTRACT_QUEUE_PATH`) written by `scan.js` (text-layer docs) and `ocr-worker.js` (OCR'd image PDFs). Each entry carries the file's `statKey`, its complete current `extra`, and its full `text_repr` — which the worker resends unchanged on the upsert *and* feeds to the extractor, capped to the leading `DOCUMENTS_EXTRACT_MAX_CHARS` chars (default 4000 — vendor/amount/date sit at the top of a receipt).
2. Asks a local OpenAI-compatible chat model (`DOCUMENTS_LLM_*`, Ollama by default) for strict JSON `{vendor, amount, currency, doc_date, doc_kind}`. This is *extraction*, not embedding, so a connector may call it (contract §1.2); it never computes an embedding or imports `src/`.
3. Upserts the **same** `(source, source_id)` with those fields in `extra_json` (`text_repr`/`occurred_at`/`raw_path`/`content_hash` untouched, per doc 04 §3).
4. For a **vendor** document (`doc_kind` ∈ receipt/invoice/bill/prescription) it emits the vendor as an entity hint `{alias, alias_type:'name', role:'mentioned', suggested_kind:'org'}`. An unknown vendor is staged in core's **proposed-entities approval queue** (#130) for review — never silently minted, and the connector asserts no entity id (rule #3). A non-vendor document records only its `doc_kind` (no vendor fields, no hint).
5. Same failure posture as `ocr-worker.js`: a stale queue entry (file changed) is dropped; a per-payload 4xx (not 429) is dropped; an extractor/server error stops the run to resume next time. Kill-safe — the queue entry is removed only after a confirmed upsert.

## The truncation tradeoff

`text_repr` is embedded whole into a 1024-dim vector — hundreds of KB of text would be retrieval mush and the ingest API caps requests at 256KB anyway. The default cap keeps a strong signal; the split is 80% head / 20% tail because the end of a letter or contract (conclusions, signature blocks) is often the most retrievable part. `extra.extracted_chars` records the full pre-truncation length and `raw_path` keeps the pointer to everything. Raise `DOCUMENTS_TEXT_REPR_MAX_CHARS` if your documents are unusually dense (chars ≠ bytes, so a separate ~150KB byte backstop re-truncates the rare payload — e.g. dense CJK — that would otherwise blow the request cap).

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` / `DOCUMENTS_SCAN_ROOT`.
2. `npm install`.
3. Backfill: `node scan.js`.
4. If the scan reported files awaiting OCR: `node ocr-worker.js` (first run downloads the tesseract language model, ~15MB, cached locally).

### Scheduling (config, not code)

All three scripts do one pass and exit. Re-scan on a schedule with cron:

```cron
# Nightly: pick up new/changed documents, OCR within a bounded window, then extract vendors.
# Stagger vendor-worker AFTER ocr-worker so scanned receipts (enqueued post-OCR) are extracted too.
0 1 * * * cd /path/to/life-context/connectors/documents && node scan.js >> ~/.life-context/documents.log 2>&1
15 1 * * * cd /path/to/life-context/connectors/documents && timeout 4h node ocr-worker.js >> ~/.life-context/documents-ocr.log 2>&1
30 5 * * * cd /path/to/life-context/connectors/documents && node vendor-worker.js >> ~/.life-context/documents-vendor.log 2>&1
```

On Windows, use Task Scheduler with daily triggers running `node scan.js` / `node ocr-worker.js` / `node vendor-worker.js`, each pointed at this connector's directory as its working directory. Killing any worker mid-run is safe; it resumes from its queue next time.

## Exit test

A phrase from inside a DOCX recalls its artifact via `POST /api/recall`; a scanned PDF is findable by filename immediately after `scan.js`, and by its page content after `ocr-worker.js` runs — as the **same artifact id**, no duplicate, guaranteed by upsert-on-`(source, source_id)` since both scripts compute `source_id` identically (`lib/shared.js`'s `sourceIdFor`).

## Known limitations

- **`occurred_at` is never guessed from file mtime.** A document with no metadata date gets no `occurred_at` (and the core server's warning), never an approximation (doc 04 §3).
- **Source ID is the relative file path.** Reorganizing the tree after the first scan orphans history for moved files — the same tradeoff every connector's `source`/`source_id` stability rule implies.
- **XLSX formulas contribute only their cached results**, and one giant sheet is capped so later sheets still get representation. PPTX notes slides are skipped, and slides are ordered by their part filename (`slideN.xml`), not `p:sldIdLst` — a deck reordered after creation extracts in original creation order. Legacy binary formats (`.doc`/`.xls`/`.ppt`) are not read.
- **The compressed-size guard doesn't bound decompression** for hostile zip bombs; single OOXML entries are skipped past a 64MB inflated size where jszip exposes it, but this connector assumes you point it at your own documents, not adversarial ones.
- **A permanently corrupt file is re-attempted and logged every scan** (it never enters the manifest); the fix is moving it out of the tree.
- **The real rasterize+OCR path has no CI coverage** — `test.mjs` verifies queue mechanics against mocks; actual tesseract output quality/latency is manual verification, same posture as photo-exif's no-VLM-in-CI. If pdfjs+canvas rasterization proves flaky on some corpus, `lib/rasterize.js` is the single swap point for an external poppler `pdftoppm` binary.
- **Vendor extraction quality depends on the chat model** and has no live-LLM CI — `test.mjs` exercises the JSON coercion, the org-hint gating, and the worker's queue mechanics against a mock chat endpoint, but real vendor/amount accuracy on your corpus is manual verification (same no-live-model posture as OCR). `doc_kind` is the model's classification; a misread receipt yields a wrong/blank vendor, not a crash. Extraction runs on **every text-bearing document**, not only receipts — the model classifies each and only vendor kinds gain fields/hints.

## Testing without a real document tree

`test.mjs` (`npm test`) synthesizes real fixture files in-test — hand-assembled PDFs (computed xref), jszip-built docx/pptx, exceljs-built xlsx — and runs both scripts against a mock ingest server. Covers: per-format payloads (text, dates, titles, counts), needs_ocr flagging + queue writing, header-only text_repr for scans, unchanged-file skipping, distinct source_ids for same-named files in different folders, oversize skipping, byte-budgeted batch chunking, and stale-queue-entry dropping.

## Files

- `scan.js` — the batch scanner
- `ocr-worker.js` — the tesseract OCR enrichment worker
- `vendor-worker.js` — the vendor/amount/date extraction worker (#123)
- `lib/shared.js` — env loading, directory walk, shared `source_id` computation, ingest client, byte-budgeted batching
- `lib/extract-fields.js` — the LLM vendor/amount/date extractor + coercion + the org-vendor hint (imported only by vendor-worker.js)
- `lib/extract.js` — extension → extractor dispatch
- `lib/pdf.js` — pdfjs text extraction, PDF date parsing, the needs-OCR heuristic
- `lib/ooxml.js` — docx/xlsx/pptx bodies + shared `docProps/core.xml` date/title parsing
- `lib/text-repr.js` — header + collapse + head/tail truncation (shared by both scripts)
- `lib/rasterize.js` — PDF page → PNG (imported only by ocr-worker.js)
- `test.mjs` — `node --test` suite
- `.env.example` — copy to `.env`
