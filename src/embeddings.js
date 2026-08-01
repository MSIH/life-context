/**
 * Shared embedding + LLM gateway. Points the OpenAI SDK at the local Ollama server.
 * Extracted so the server, the query planner, and the headless connectors/migration
 * scripts all reuse ONE client and ONE getEmbedding — the enrich-then-commit discipline
 * (absolute rule 4) depends on every writer producing embeddings the same way.
 */
import OpenAI from 'openai';
import {
  OLLAMA_BASE_URL, EMBEDDING_MODEL, VECTOR_DIMENSION, EMBED_TIMEOUT_MS, embeddingEndpointViolation,
  EMBED_BATCH_MAX_INPUTS, EMBED_BATCH_MAX_CHARS,
} from './config.js';
import { log } from './logger.js';

// Re-exported so ingest.js (the one consumer) imports both the batch entry points and their
// budgets from this one module, matching how it already imports embedToFloat32 from here rather
// than from config.js directly. Actual defaults/env-override live in config.js (#408) — a
// per-box tuning knob, same posture as EMBED_TIMEOUT_MS above.
export { EMBED_BATCH_MAX_INPUTS, EMBED_BATCH_MAX_CHARS };

// Fail closed before the client exists (#347). Enforced HERE rather than in server.js because this
// is the one module every embedder shares — server, migrate, contacts, the connector workers — so a
// single check covers all of them; a check in server.js would leave `npm run import:contacts` free
// to ship the same text off-box. It throws rather than calling process.exit: a library others import
// must not kill the process itself, and an unhandled throw at import already halts with a non-zero
// exit. The console line survives a logger that failed to open its own store (same reasoning as
// server.js's API-key halt); `host` is config, never user content.
const endpointViolation = embeddingEndpointViolation();
if (endpointViolation) {
  console.error(`❌ CRITICAL ERROR: ${endpointViolation}`);
  log.error('proc.config.invalid', 'Embedding endpoint is not loopback and remote egress is not enabled', null, {
    host: (() => { try { return new URL(OLLAMA_BASE_URL).host; } catch { return 'unparseable'; } })(),
    halted: true,
  });
  log.close();
  throw new Error(endpointViolation);
}

// Ollama ignores the key, but the OpenAI SDK requires a non-empty string. The timeout
// bounds a hung gateway (the SDK default is 10 minutes).
export const ai = new OpenAI({ baseURL: OLLAMA_BASE_URL, apiKey: 'ollama', timeout: EMBED_TIMEOUT_MS });

// Shared by getEmbedding/getEmbeddings: fail loudly at the boundary if the model's output doesn't
// match the vec table dimension, instead of surfacing later as a cryptic sqlite-vec bind/DDL
// error (data-model.md rule 2).
function assertVectorDimension(embedding) {
  if (embedding.length !== VECTOR_DIMENSION) {
    throw new Error(
      `Embedding length ${embedding.length} != VECTOR_DIMENSION ${VECTOR_DIMENSION} ` +
      `(model ${EMBEDDING_MODEL}); set VECTOR_DIMENSION to match the model and re-embed.`
    );
  }
}

// Returns a plain number[] embedding for the given text. The gateway call is an outbound span
// (#328) — on a CPU host this is routinely the largest single slice of a store or a search, so
// "where is the time going" is unanswerable without it. `chars` (a length) is the only thing
// recorded about the input; the text itself is a memory or a query and is never logged. `count:1`
// lets a dashboard aggregate `sum(dur_ms)/sum(count)` across this event AND `ollama.embed_batch.
// completed` uniformly, so a batch's per-item fallback (which emits rows under THIS event name)
// doesn't read as a mysteriously fast/slow batch when grouped by event alone.
export async function getEmbedding(text) {
  return log.span('ollama.embed.completed', async () => {
    const response = await ai.embeddings.create({ input: [text], model: EMBEDDING_MODEL });
    const embedding = response.data[0].embedding;
    assertVectorDimension(embedding);
    return embedding;
  }, { model: EMBEDDING_MODEL, count: 1, chars: text?.length ?? 0 });
}

// Convenience: embedding as the Float32Array that sqlite-vec binds directly.
export async function embedToFloat32(text) {
  return new Float32Array(await getEmbedding(text));
}

// Returns embeddings for N texts via ONE gateway call, order-aligned to `texts` regardless of the
// order the response itself returns entries in (#408). The OpenAI-shaped response's `data[]`
// carries an `index` field for exactly this reason — mapped back by that field, NEVER by array
// position, so a provider that reorders can never silently pair text A's vector with text B's
// artifact (that failure would be invisible and permanent, the one class this project cannot
// tolerate). Every returned vector is length-checked individually, not just the first, so a
// partially-wrong response fails loudly at the boundary instead of binding a wrong-width vector
// into vec0 (data-model.md rule 2). `getEmbedding`/`embedToFloat32` are unchanged — this is an
// additive entry point for the batch path only (search, import:contacts, migrate are untouched).
export async function getEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const chars = texts.reduce((sum, t) => sum + (t?.length ?? 0), 0);
  return log.span('ollama.embed_batch.completed', async () => {
    const response = await ai.embeddings.create({ input: texts, model: EMBEDDING_MODEL });
    // A plain `new Array(n)` is sparse (every slot a hole) — `Array.prototype.some`/`map`/
    // `forEach` all SKIP holes when invoking their callback, so a coverage check built on `some`
    // can never fire (verified: `new Array(3).some(v => v === undefined)` is `false`). Direct
    // bracket access (`out[i]`) does NOT skip holes, and neither does `.includes`, which is why
    // `filled` (an explicit counter) and an `out[item.index] !== undefined` check — not `.some`
    // afterward — are what actually catch a short, long, or duplicate-index response.
    const out = new Array(texts.length);
    let filled = 0;
    for (const item of response.data) {
      assertVectorDimension(item.embedding);
      const idx = item.index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= texts.length || out[idx] !== undefined) {
        throw new Error(
          `Embedding gateway returned an invalid or duplicate index for ${texts.length} input(s); ` +
          'response indices did not map 1:1 onto the request.'
        );
      }
      out[idx] = item.embedding;
      filled++;
    }
    // A short response (fewer entries than inputs) leaves holes — fail loudly here, at the one
    // place that knows the input count, rather than silently shipping an `undefined` vector into
    // a caller that would then bind it as `undefined` (or crash somewhere less legible).
    if (filled !== texts.length) {
      throw new Error(
        `Embedding gateway returned ${filled} vector(s) for ${texts.length} input(s); ` +
        'response indices did not cover every input.'
      );
    }
    return out;
  }, { model: EMBEDDING_MODEL, count: texts.length, chars });
}

// Convenience mirror of embedToFloat32 for the batch path.
export async function embedManyToFloat32(texts) {
  return (await getEmbeddings(texts)).map((e) => new Float32Array(e));
}
