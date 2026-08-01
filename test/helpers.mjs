// Shared test helpers for the core (src/) suite. Mirrors the connectors' node:test style
// (connectors/imessage/test.mjs): stand up throwaway state, drive real modules, tear down.
// No new deps — node: built-ins only.
import http from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Deliberately NOT imported from src/config.js: config.js reads process.env (incl. DB_PATH) at
// module load, and importing it here would freeze that read BEFORE useTempDb() runs. Mirror
// config.js's own default instead (tests never override VECTOR_DIMENSION, so this matches).
const VECTOR_DIMENSION = Number(process.env.VECTOR_DIMENSION) || 1024;

// A Float32Array of the right dimension. `fill` seeds every slot (default 0.1) so vectors are
// non-zero and comparable; pass a different constant to make two vectors distinct for KNN.
export const f32 = (fill = 0.1) => new Float32Array(VECTOR_DIMENSION).fill(fill);

/**
 * The exact vector startFakeOllama returns for a given text — the fake's OWN derivation, exported so a
 * test can assert "this row holds the embedding of THIS text" rather than merely "the vector changed"
 * (which a re-embed of the wrong text, or a deleted vec row, would also satisfy). Single-sourced with
 * the handler below so the two can never drift.
 */
export function fakeVectorFor(text) {
  let h = 2166136261; // FNV-1a seed
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return new Float32Array(
    Array.from({ length: VECTOR_DIMENSION }, (_, i) => Math.sin((h ^ Math.imul(i, 2654435761)) >>> 0))
  );
}

// Point DB_PATH at a fresh temp file BEFORE db.js is imported (it opens the DB at module load).
// Returns { dir, cleanup } — cleanup rm's the dir (WAL + shm siblings included). The caller
// closes the db handle in its own teardown (db.js owns the singleton). Call at the very top of
// a test file, before any dynamic import of src/db.js (or anything that imports it).
export function useTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lc-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  // db.js imports src/logger.js (#328), which opens its own store at module load — so a test run
  // would otherwise write into the repo's real logs/events.db. Off by default: most tests don't
  // care about ops logging, and a disabled logger opens no file, so nothing can hold a handle on
  // this temp dir when cleanup() rm's it (Windows refuses to delete an open SQLite file).
  // A test that DOES assert on event rows calls useTempEvents() after this to turn it back on.
  process.env.EVENTS_LOG_ENABLED = 'false';
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Opt a test file INTO a real, isolated ops event store (#328) — for the files that assert on
 * event rows. Own temp dir, so it is torn down independently of useTempDb's. Same before-import
 * timing rule as useTempDb: logger.js reads EVENTS_DB_PATH once, at module load.
 *
 * `cleanup(log)` takes the logger because it must CLOSE it before rm'ing the dir: on Windows an
 * open SQLite handle makes the directory undeletable, and a dynamic import inside cleanup would
 * force every caller's `after()` to become async.
 */
export function useTempEvents() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lc-events-'));
  process.env.EVENTS_DB_PATH = path.join(dir, 'events.db');
  process.env.EVENTS_LOG_ENABLED = 'true';
  return {
    dir,
    cleanup: (log) => { log?.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Rows this process wrote to the event store, newest last. Filters on the live logger's `run_id`
 * so a sibling test file writing to the same file (node --test forks a process per file) can
 * never bleed in. Flushes first — writes are queued and drained on an interval, so a test that
 * queried without this would race the 200 ms timer and fail intermittently.
 */
export function readEvents(log, { event, level, since = 0 } = {}) {
  log.flush();
  const d = new Database(process.env.EVENTS_DB_PATH, { readonly: true });
  try {
    return d.prepare(`SELECT id, level, event, msg, err_type, err_msg, stack, data, duration_ms, ok,
                             trace_id, span_id, parent_span, file, func
                      FROM events
                      WHERE run_id = @run_id AND id > @since
                        AND (@event IS NULL OR event = @event)
                        AND (@level IS NULL OR level = @level)
                      ORDER BY id`)
      .all({ run_id: log.runId, since, event: event ?? null, level: level ?? null });
  } finally {
    d.close();
  }
}

// A fake local Ollama (OpenAI-compatible) so ingest/search/server tests never need a live
// engine — the connector tests take the same mock-HTTP-server approach. Serves:
//   POST /v1/embeddings         -> a deterministic VECTOR_DIMENSION-length vector
//   POST /v1/chat/completions   -> a fixed pure-semantic plan (the planner's happy path)
//   POST /api/generate          -> Ollama's native endpoint (warmUpQueryModel, #247)
// `counts` tracks calls so a test can assert re-embed-only-on-text-change. Set OLLAMA_BASE_URL
// to the returned baseUrl BEFORE importing embeddings.js (or anything that imports it).
// The empty pure-semantic plan the fake planner returns by default (mirrors search.js's fallback);
// one definition so a new PlanSchema key can't fall out of sync between the default and an override.
const EMPTY_PLAN = { types: [], entities: [], place: null, near: null, time_start: null, time_end: null, geo_required: false, sort: 'relevance', semantic: '' };

export async function startFakeOllama() {
  const counts = { embed: 0, chat: 0, generate: 0 };
  // The chat (planner) response is mutable so a test can make the planner emit filters and assert
  // they're applied; default is the empty pure-semantic plan (unchanged for existing callers).
  // lastGenerateBody captures the parsed body of the most recent /api/generate call (#247) so a
  // test can assert warmUpQueryModel sent the right model/keep_alive/stream fields.
  // embedOverride (#408) lets a test replace the default per-text response with an arbitrary
  // `[{ index, embedding }, …]` — used to assert getEmbeddings/embedManyToFloat32 map by INDEX,
  // not array position (an override that reverses index assignment), and to inject a
  // wrong-length vector (the VECTOR_DIMENSION mismatch guard). null = default behavior.
  const state = { chatPlan: { ...EMPTY_PLAN }, lastGenerateBody: null, embedOverride: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/embeddings')) {
        counts.embed++;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* keep default */ }
        // One embed call may carry N inputs (#408's whole point) — always an array of strings.
        // Derive each vector deterministically FROM its own text (not just its index) so distinct
        // texts get distinct vectors — otherwise every artifact embeds identically and the KNN arm
        // can't discriminate, hiding vector-ranking regressions. Same text -> same vector.
        const texts = Array.isArray(parsed.input) ? parsed.input.map(String) : [String(parsed.input ?? '')];
        let entries;
        try {
          entries = state.embedOverride
            ? state.embedOverride(texts)
            : texts.map((text, index) => ({ index, embedding: [...fakeVectorFor(text)] }));
        } catch (err) {
          // A test simulating a chunk-level gateway failure throws here — respond with a real
          // HTTP error (not an uncaught exception inside this listener) so the OpenAI client sees
          // an ordinary APIError, the same shape a real Ollama 500 would produce.
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { message: err.message } }));
          return;
        }
        // Honor whatever `encoding_format` the request asks for. The OpenAI client used here has
        // been observed to request base64, and returning a plain float array to a base64 request
        // gets mis-decoded — so respond in the requested format and the vector round-trips at full
        // length. (embeddings.js always sees a decoded number[] back from the SDK either way.)
        const format = parsed.encoding_format ?? 'float';
        const data = entries.map(({ index, embedding }) => ({
          index,
          embedding: format === 'base64'
            ? Buffer.from(new Float32Array(embedding).buffer).toString('base64')
            : embedding,
        }));
        res.end(JSON.stringify({ data }));
      } else if (req.url.endsWith('/chat/completions')) {
        counts.chat++;
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(state.chatPlan) } }] }));
      } else if (req.url.endsWith('/api/generate')) {
        counts.generate++;
        try { state.lastGenerateBody = JSON.parse(body || '{}'); } catch { state.lastGenerateBody = null; }
        res.end(JSON.stringify({ done: true }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    counts,
    // Override the planner's returned plan (merged over the empty default) for a single assertion.
    setChatPlan: (plan) => { state.chatPlan = { ...EMPTY_PLAN, ...plan }; },
    getLastGenerateBody: () => state.lastGenerateBody,
    // fn(texts) => [{ index, embedding }, …], or null to restore the default per-text behavior.
    setEmbedOverride: (fn) => { state.embedOverride = fn; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
