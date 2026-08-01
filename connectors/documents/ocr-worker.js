#!/usr/bin/env node
// Low-priority background worker: drains the OCR queue scan.js writes (image-only PDFs),
// rasterizes each with pdfjs + @napi-rs/canvas, OCRs the pages with tesseract.js (WASM,
// runs locally; the ~15MB language model is fetched once and cached), and upserts the SAME
// (source, source_id) with an enriched text_repr. One file at a time, the queue entry is
// removed via a fresh read-modify-write after each success (kill-safe, and safe against a
// concurrently finishing scan.js), throttled between files.
//
// Scope: image-only PDFs ONLY. Standalone images are photo-exif's source ownership — OCRing
// them here would create a second artifact for the same file under a different `source`.
//
// Nightly-window scheduling is config, not code — this script does a single pass and exits;
// start/stop it on a schedule with cron or Task Scheduler. See README.md.
import { existsSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import {
  loadDotEnvIfPresent, envNumber, textReprMaxChars, sourceIdFor, statKeyOf,
  readJsonFile, updateJsonFile, ingestClient,
} from './lib/shared.js';
import { buildTextRepr } from './lib/text-repr.js';
import { rasterizePdf } from './lib/rasterize.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const SCAN_ROOT = process.env.DOCUMENTS_SCAN_ROOT;
const OCR_QUEUE_PATH = process.env.DOCUMENTS_OCR_QUEUE_PATH
  || path.join(os.homedir(), '.life-context', 'documents-ocr-queue.json');
// Vendor-extraction queue (#123): once OCR gives an image-only PDF a text layer, it becomes a
// text-bearing doc and is enqueued here for vendor-worker.js — the path scan.js can't take for
// image-only files (they have no text at scan time). Shares the queue with scan.js's text-layer docs.
const EXTRACT_QUEUE_PATH = process.env.DOCUMENTS_EXTRACT_QUEUE_PATH
  || path.join(os.homedir(), '.life-context', 'documents-extract-queue.json');
const OCR_LANG = process.env.DOCUMENTS_OCR_LANG || 'eng';
// Where tesseract caches its ~15MB language model — defaulted OUT of the repo/connector dir
// (tesseract.js downloads into cachePath, which defaults to cwd; an uncontained default
// would drop eng.traineddata into the working tree).
const OCR_CACHE_PATH = process.env.DOCUMENTS_OCR_CACHE_PATH
  || path.join(os.homedir(), '.life-context', 'tesseract');
// Optional override for where the language model is fetched FROM (tesseract.js otherwise
// uses its built-in CDN) — lets an air-gapped host point at a local tessdata mirror.
const OCR_LANG_PATH = process.env.DOCUMENTS_OCR_LANG_PATH;
const OCR_MAX_PAGES = envNumber('DOCUMENTS_OCR_MAX_PAGES', 20);
const OCR_THROTTLE_MS = envNumber('DOCUMENTS_OCR_THROTTLE_MS', 1000);
const TEXT_REPR_MAX_CHARS = textReprMaxChars();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dropEntry(relPath) {
  updateJsonFile(OCR_QUEUE_PATH, (queue) => {
    delete queue[relPath];
  });
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('documents: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
  if (!SCAN_ROOT || !existsSync(SCAN_ROOT)) {
    console.error(`documents: DOCUMENTS_SCAN_ROOT not set or doesn't exist: ${SCAN_ROOT}`);
    process.exit(1);
  }

  // Queue shape (written by scan.js): { [relPath]: { statKey, extra } }. The stored extra is
  // the file's complete wave-1 extra — resent whole because the server's upsert overwrites
  // extra_json as one field, never merges keys.
  const entries = Object.entries(readJsonFile(OCR_QUEUE_PATH));
  if (!entries.length) {
    console.error('documents: OCR queue empty, nothing to do');
    return;
  }

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const scanRootPrefix = realpathSync(SCAN_ROOT) + path.sep;

  // Drop stale entries BEFORE paying tesseract init: a file that moved or changed since it
  // was flagged is dropped — if it's still image-only, the next scan.js run re-flags it
  // against the new statKey.
  const live = [];
  for (const [relPath, entry] of entries) {
    // The queue file is local state, but keys still must not escape the scan root — a '..'
    // key or an in-root symlink pointing outside would otherwise let a corrupted/tampered
    // queue OCR and index arbitrary files. realpath resolves both.
    let absPath;
    try {
      absPath = realpathSync(path.resolve(SCAN_ROOT, relPath));
    } catch {
      absPath = null; // missing file — same treatment as a stale entry below
    }
    if (absPath && !absPath.startsWith(scanRootPrefix)) {
      console.error(`documents: dropping OCR queue entry outside the scan root: ${relPath}`);
      dropEntry(relPath);
      continue;
    }
    let stat;
    try {
      stat = absPath ? statSync(absPath) : null;
    } catch {
      stat = null;
    }
    if (!stat || statKeyOf(stat) !== entry.statKey) {
      console.error(`documents: dropping stale OCR queue entry ${relPath}`);
      dropEntry(relPath);
    } else {
      live.push({ relPath, entry, absPath });
    }
  }
  if (!live.length) {
    console.error('documents: OCR queue had only stale entries, nothing to do');
    return;
  }

  // One shared tesseract worker for the whole run — model init is the expensive step.
  let tesseract;
  try {
    mkdirSync(OCR_CACHE_PATH, { recursive: true });
    tesseract = await createWorker(OCR_LANG, 1, {
      cachePath: OCR_CACHE_PATH,
      ...(OCR_LANG_PATH ? { langPath: OCR_LANG_PATH } : {}),
    });
  } catch (err) {
    console.error('documents: tesseract failed to initialize, stopping (queue left intact)', err);
    return;
  }

  let done = 0;
  let remaining = live.length;
  try {
    for (const { relPath, entry, absPath } of live) {
      let body;
      let ocrPages;
      try {
        const images = await rasterizePdf(await readFile(absPath), OCR_MAX_PAGES);
        const pages = [];
        for (let i = 0; i < images.length; i++) {
          const { data } = await tesseract.recognize(images[i]);
          const text = data.text.trim();
          if (text) pages.push(`Page ${i + 1}:\n${text}`);
        }
        body = pages.join('\n\n');
        ocrPages = images.length;
      } catch (err) {
        // A single bad PDF must not loop forever — drop it loudly; scan.js re-flags it only
        // if the file itself changes.
        console.error(`documents: OCR failed for ${relPath}, dropping from queue`, err);
        dropEntry(relPath);
        remaining--;
        continue;
      }

      const { text_repr, extracted_chars, truncated } = buildTextRepr('pdf', entry.extra, relPath, body, TEXT_REPR_MAX_CHARS);
      const ocrExtra = { ...entry.extra, extracted_chars, truncated, needs_ocr: false, ocr_done: true, ocr_pages: ocrPages };
      try {
        // Present fields only: text_repr + extra. Per doc 04 §3 upsert merge semantics,
        // everything scan.js already stored (occurred_at, raw_path, content_hash) is left
        // untouched. extra is the complete wave-1 object with the OCR outcome layered on,
        // because extra_json overwrites whole — a partial extra would erase the counts.
        await postIngest({
          source: 'documents',
          source_id: sourceIdFor(relPath),
          type: 'document',
          text_repr,
          extra: ocrExtra,
        });
      } catch (err) {
        // 4xx (bar the client-retried 429) is deterministic for THIS payload — drop it or it
        // wedges the whole queue behind it forever. Anything else means the server is down
        // or unhappy: stop the run and leave the rest for next time.
        if (err.status >= 400 && err.status < 500 && err.status !== 429) {
          console.error(`documents: ingest rejected ${relPath} (${err.status}), dropping from queue`, err);
          dropEntry(relPath);
          remaining--;
          continue;
        }
        console.error(`documents: ingest failed for ${relPath}, stopping run (will resume next time)`, err);
        break;
      }
      // Now that OCR gave it a text layer, hand it to the vendor extractor (#123), carrying the OCR'd
      // text_repr (the worker reads it and resends it unchanged). Skip a page with no recovered text.
      // Enqueue BEFORE dropping the OCR entry: a kill between the two then just re-OCRs next run
      // (idempotent upsert + idempotent re-enqueue), never leaving the doc OCR'd-but-never-extracted —
      // once the OCR entry is dropped, an unchanged file is never re-flagged, so extraction would be lost.
      if (body) {
        updateJsonFile(EXTRACT_QUEUE_PATH, (queue) => {
          queue[relPath] = { statKey: entry.statKey, extra: ocrExtra, text_repr };
        });
      }
      dropEntry(relPath); // fresh read-modify-write after every success — kill-safe at any point
      remaining--;
      done++;

      await sleep(OCR_THROTTLE_MS);
    }
  } finally {
    await tesseract.terminate();
  }

  console.error(`documents: OCR'd ${done} file(s) this run, ${remaining} remaining`);
}

main()
  .then(() => process.exit(0)) // tesseract/fetch would otherwise hold the process open
  .catch((err) => {
    console.error('documents: ocr worker failed', err);
    process.exit(1);
  });
