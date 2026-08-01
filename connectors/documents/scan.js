#!/usr/bin/env node
// Batch-scans a document tree (.pdf/.docx/.xlsx/.pptx): extracts text + created-date metadata,
// sha256 content_hash, capped text_repr — POSTed to LifeContext via /api/v1/ingest/batch.
// Image-only PDFs are ingested immediately with their thin header (findable by filename from
// wave 1) and queued for ocr-worker.js, which later upserts an OCR'd text_repr onto the same
// (source, source_id). See README.md for setup and the exit test.
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDotEnvIfPresent, envNumber, textReprMaxChars, walkDocumentFiles, sourceIdFor, statKeyOf,
  contentHashOfBuffer, readJsonFile, writeJsonFile, updateJsonFile, chunkByBudget, ingestClient, BATCH_MAX,
} from './lib/shared.js';
import { extractDocument } from './lib/extract.js';
import { buildTextRepr } from './lib/text-repr.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const SCAN_ROOT = process.env.DOCUMENTS_SCAN_ROOT;
const MANIFEST_PATH = process.env.DOCUMENTS_MANIFEST_PATH
  || path.join(os.homedir(), '.life-context', 'documents-manifest.json');
const OCR_QUEUE_PATH = process.env.DOCUMENTS_OCR_QUEUE_PATH
  || path.join(os.homedir(), '.life-context', 'documents-ocr-queue.json');
// Vendor-extraction queue (#123): text-bearing docs land here for vendor-worker.js. Image-only PDFs
// go to the OCR queue first and are enqueued here by ocr-worker.js once they have text.
const EXTRACT_QUEUE_PATH = process.env.DOCUMENTS_EXTRACT_QUEUE_PATH
  || path.join(os.homedir(), '.life-context', 'documents-extract-queue.json');
const MAX_FILE_BYTES = envNumber('DOCUMENTS_MAX_FILE_MB', 50) * 1024 * 1024;
const TEXT_REPR_MAX_CHARS = textReprMaxChars();

async function buildPayload(absPath, relPath) {
  // One read serves both extraction and hashing — every extractor buffers the whole file
  // anyway (bounded by MAX_FILE_BYTES), so a second streamed read would double the disk I/O.
  const buffer = await readFile(absPath);
  const { format, text, occurredAt, meta, needsOcr } = await extractDocument(absPath, buffer);
  const { text_repr, extracted_chars, truncated } = buildTextRepr(format, meta, relPath, text, TEXT_REPR_MAX_CHARS);

  const payload = {
    source: 'documents',
    source_id: sourceIdFor(relPath),
    type: 'document',
    text_repr,
    content_hash: contentHashOfBuffer(buffer),
    raw_path: absPath,
    extra: { format, extracted_chars, truncated, needs_ocr: needsOcr, ocr_done: false, ...meta },
  };
  // occurred_at is when the document was CREATED (its own metadata), never a mtime/import-time
  // guess — doc 04 §3 is explicit that a 2019 document imported today must still sort into
  // 2019, so an unknown date is omitted (and warned on) rather than approximated with
  // something that's actively wrong.
  if (occurredAt) payload.occurred_at = occurredAt.toISOString();
  return payload;
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

  const { postIngestBatch } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const manifest = readJsonFile(MANIFEST_PATH);
  let scanned = 0;
  let skippedUnchanged = 0;
  let skippedOversize = 0;
  const pending = [];

  // Persist per successful batch, not per run: a failed batch (or a crash) must lose at most
  // its own uncommitted window (doc 04 §7), never the bookkeeping of everything already
  // server-confirmed this run. The OCR queue is updated against a fresh read — ocr-worker.js
  // may be draining it concurrently, and overwriting from a run-start snapshot would resurrect
  // entries it completed (see updateJsonFile).
  const flush = async () => {
    if (!pending.length) return;
    for (const group of chunkByBudget(pending)) {
      const result = await postIngestBatch(group.map((p) => p.payload));
      if (!Array.isArray(result?.results)) {
        throw new Error(`documents: unexpected ingest response shape from ${LIFECONTEXT_URL} — is this a LifeContext server?`);
      }
      const flagged = [];
      const cleared = [];
      const toExtract = [];
      result.results.forEach((r, i) => {
        if (r.error) {
          console.error('documents: item failed', group[i].payload.source_id, r.error, r.issues ?? '');
        } else {
          // Only cache success — a failed item must be retried on the next scan, not skipped
          // as "unchanged" forever. Same rule for the OCR queue: flag on success, and clear
          // any stale entry when a changed file now has a real text layer.
          const { relPath, statKey, payload } = group[i];
          manifest[relPath] = statKey;
          if (payload.extra.needs_ocr) flagged.push({ relPath, statKey, extra: payload.extra });
          else cleared.push(relPath);
          // Text-bearing docs go to the vendor-extraction queue (#123), carrying their text_repr —
          // the worker reads it and resends it unchanged. Image-only PDFs have no text yet;
          // ocr-worker.js enqueues them here after OCR.
          if (!payload.extra.needs_ocr) toExtract.push({ relPath, statKey, extra: payload.extra, text_repr: payload.text_repr });
        }
      });
      writeJsonFile(MANIFEST_PATH, manifest);
      if (flagged.length || cleared.length) {
        updateJsonFile(OCR_QUEUE_PATH, (queue) => {
          for (const { relPath, statKey, extra } of flagged) queue[relPath] = { statKey, extra };
          for (const relPath of cleared) delete queue[relPath];
        });
      }
      if (toExtract.length) {
        updateJsonFile(EXTRACT_QUEUE_PATH, (queue) => {
          for (const { relPath, statKey, extra, text_repr } of toExtract) queue[relPath] = { statKey, extra, text_repr };
        });
      }
    }
    pending.length = 0;
  };

  for await (const { absPath, relPath } of walkDocumentFiles(SCAN_ROOT)) {
    // statSync AND buildPayload share one try/catch — a permission error or a corrupt file
    // can throw from either, and either way it must skip just this file, not abort the scan.
    let statKey;
    let payload;
    try {
      const stat = statSync(absPath);
      // Oversize files are skipped but NOT manifested — every extractor (pdfjs, mammoth,
      // exceljs, jszip) buffers the whole file, so the guard bounds memory; raising the
      // limit later picks them up.
      if (stat.size > MAX_FILE_BYTES) {
        console.error(`documents: skipping oversize file ${relPath} (${Math.round(stat.size / 1024 / 1024)}MB)`);
        skippedOversize++;
        continue;
      }
      statKey = statKeyOf(stat);
      if (manifest[relPath] === statKey) {
        skippedUnchanged++;
        continue;
      }
      payload = await buildPayload(absPath, relPath);
    } catch (err) {
      console.error(`documents: skipping unreadable file ${relPath}`, err);
      continue;
    }
    scanned++;
    pending.push({ relPath, statKey, payload });
    if (pending.length >= BATCH_MAX) await flush();
  }
  await flush();

  const queued = Object.keys(readJsonFile(OCR_QUEUE_PATH)).length;
  console.error(`documents: scanned ${scanned} new/changed file(s), skipped ${skippedUnchanged} unchanged, ${skippedOversize} oversize; ${queued} awaiting OCR`);
}

main()
  .then(() => process.exit(0)) // fetch's keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('documents: scan failed', err);
    process.exit(1);
  });
