#!/usr/bin/env node
// Low-priority background worker: drains the extraction queue scan.js/ocr-worker.js write (text-bearing
// documents), asks a local chat model to pull {vendor, amount, currency, doc_date, doc_kind} from each
// document's text, and upserts the SAME (source, source_id) with those fields in extra_json. For a
// vendor document (bill/receipt/invoice/prescription) the vendor is emitted as a name hint with
// suggested_kind:'org' — core stages an unknown vendor in the proposed-entities approval queue (#130)
// rather than minting an entity; the connector asserts no entity id (rule #3). One file at a time; the
// queue entry is removed via a fresh read-modify-write after each success (kill-safe), throttled between.
//
// Nightly-window scheduling is config, not code — a single pass, then exit; run it on a schedule with
// cron or Task Scheduler (stagger after ocr-worker.js so OCR'd receipts are enqueued first). See README.md.
import { existsSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDotEnvIfPresent, envNumber, extractTextMaxChars, sourceIdFor, statKeyOf, readJsonFile, updateJsonFile, ingestClient,
} from './lib/shared.js';
import { extractFields, vendorHintFor, extractExtraFor } from './lib/extract-fields.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const SCAN_ROOT = process.env.DOCUMENTS_SCAN_ROOT;
const EXTRACT_QUEUE_PATH = process.env.DOCUMENTS_EXTRACT_QUEUE_PATH
  || path.join(os.homedir(), '.life-context', 'documents-extract-queue.json');
// The extractor LLM: any OpenAI-compatible /chat/completions endpoint (local Ollama by default). This
// is extraction, not embedding — permitted for a connector (doc 04 §1.2). Provider-swappable via env.
const LLM_BASE_URL = process.env.DOCUMENTS_LLM_BASE_URL || 'http://localhost:11434/v1';
const LLM_MODEL = process.env.DOCUMENTS_LLM_MODEL || 'qwen3:8b';
const LLM_API_KEY = process.env.DOCUMENTS_LLM_API_KEY; // optional bearer for a hosted endpoint
const THROTTLE_MS = envNumber('DOCUMENTS_EXTRACT_THROTTLE_MS', 1000);
const EXTRACT_TEXT_MAX_CHARS = extractTextMaxChars();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dropEntry(relPath) {
  updateJsonFile(EXTRACT_QUEUE_PATH, (queue) => {
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

  // Queue shape (written by scan.js/ocr-worker.js): { [relPath]: { statKey, extra, text_repr } }.
  // `text_repr` is the artifact's CURRENT text_repr (already built by scan/OCR) — the extractor reads
  // it and the upsert resends it UNCHANGED, which satisfies the ingest schema's required text_repr
  // AND leaves it byte-identical so the server re-embeds nothing (textChanged=false). `extra` is the
  // file's complete current extra — resent whole because the upsert overwrites extra_json as one field.
  const entries = Object.entries(readJsonFile(EXTRACT_QUEUE_PATH));
  if (!entries.length) {
    console.error('documents: extraction queue empty, nothing to do');
    return;
  }

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const scanRootPrefix = realpathSync(SCAN_ROOT) + path.sep;

  // Drop stale/escaping entries first (mirrors ocr-worker.js): a '..' key or an in-root symlink
  // pointing outside must never let a tampered queue drive extraction of arbitrary files; a file
  // changed since it was enqueued is dropped (scan.js re-enqueues it against the new statKey).
  const live = [];
  for (const [relPath, entry] of entries) {
    let absPath;
    try {
      absPath = realpathSync(path.resolve(SCAN_ROOT, relPath));
    } catch {
      absPath = null;
    }
    if (absPath && !absPath.startsWith(scanRootPrefix)) {
      console.error(`documents: dropping extraction queue entry outside the scan root: ${relPath}`);
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
      console.error(`documents: dropping stale extraction queue entry ${relPath}`);
      dropEntry(relPath);
    } else {
      live.push({ relPath, entry });
    }
  }
  if (!live.length) {
    console.error('documents: extraction queue had only stale entries, nothing to do');
    return;
  }

  let done = 0;
  let vendors = 0;
  let remaining = live.length;
  for (const { relPath, entry } of live) {
    let fields;
    try {
      // Feed the extractor a bounded head of text_repr (vendor/amount/date sit up top) — the full
      // text_repr is still resent below, this only caps the LLM input for focus and speed.
      fields = await extractFields((entry.text_repr || '').slice(0, EXTRACT_TEXT_MAX_CHARS), { baseUrl: LLM_BASE_URL, model: LLM_MODEL, apiKey: LLM_API_KEY });
    } catch (err) {
      // The extractor failing is a server/config problem, not a poison document (text is pre-capped,
      // so context-length can't wedge a single doc). Stop and leave the rest for next run.
      console.error(`documents: extractor call failed for ${relPath}, stopping run (will resume next time)`, err);
      break;
    }

    const hints = vendorHintFor(fields);
    try {
      // text_repr resent UNCHANGED (required by the schema; byte-identical => no re-embed). extra is
      // the complete stored extra with the extracted fields layered on (extra_json overwrites whole);
      // occurred_at/raw_path/content_hash stay untouched per doc 04 §3 upsert merge semantics.
      await postIngest({
        source: 'documents',
        source_id: sourceIdFor(relPath),
        type: 'document',
        text_repr: entry.text_repr,
        extra: { ...entry.extra, ...extractExtraFor(fields), extracted_fields: true },
        ...(hints.length ? { entity_hints: hints } : {}),
      });
    } catch (err) {
      // Mirror ocr-worker.js: a 4xx (bar the client-retried 429) is deterministic for THIS payload —
      // drop it or it wedges the queue. Anything else means the server is down/unhappy: stop the run.
      if (err.status >= 400 && err.status < 500 && err.status !== 429) {
        console.error(`documents: ingest rejected ${relPath} (${err.status}), dropping from queue`, err);
        dropEntry(relPath);
        remaining--;
        continue;
      }
      console.error(`documents: ingest failed for ${relPath}, stopping run (will resume next time)`, err);
      break;
    }
    dropEntry(relPath); // fresh read-modify-write after every success — kill-safe at any point
    remaining--;
    done++;
    if (hints.length) vendors++;

    await sleep(THROTTLE_MS);
  }

  console.error(`documents: extracted ${done} document(s) this run (${vendors} with a vendor), ${remaining} remaining`);
}

// Exit naturally rather than forcing process.exit(0): this worker makes two sequential fetches per
// document (chat + ingest), and an abrupt exit with undici's keep-alive sockets still open trips a
// libuv assertion on Windows (async.c: UV_HANDLE_CLOSING, exit 0xC0000409). Undici's sockets are
// unref'd, so the event loop drains and the process exits on its own once keep-alive times out.
main().catch((err) => {
  console.error('documents: vendor worker failed', err);
  process.exitCode = 1;
});
