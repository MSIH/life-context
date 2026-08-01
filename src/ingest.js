/**
 * The single-artifact ingest endpoint (connector contract doc 04 §2–§4, roadmap M0
 * deliverable 1) plus the batch endpoint (#19, roadmap M0 deliverable 2). Keeps
 * server.js a wiring file: the shared zod payload schema, warning computation, the
 * embed-then-upsert orchestration, and the router factory all live here so the JSON-schema
 * generator (#20) reuses ONE definition.
 *
 * Contract shape (§2): 201 on create / 200 on update, body
 * { id, created, resolved_entities, unresolved_aliases } plus an optional `warnings` array
 * (present only when non-empty). Validation failures are 422 { error:'validation', issues:[…] }.
 * Design bias (§2): accept-with-warning wherever data isn't destructive; reject at the door
 * only what would silently lose data (a typo'd key, a missing upsert id, a bad hash format).
 *
 * Batch (§2, batched embedding #408): POST /ingest/batch pre-passes every item (prepareIngest,
 * separable from the write since #408), embeds however many items need it in as few gateway
 * calls as EMBED_BATCH_MAX_INPUTS/EMBED_BATCH_MAX_CHARS allow (a metadata-only wave issues
 * ZERO embed calls), then writes each item with its now-known vector via `finishIngest` — one
 * enrich+commit transaction per artifact still (upsertArtifactTxn is itself a db.transaction),
 * so item N's failure never touches items 1..N-1. `executeIngest` (prepareIngest+embed+
 * finishIngest in one step) is unchanged and still the single-item route's whole body. The
 * envelope schema (BatchEnvelopeSchema) validates only shape/count (1–100 items); each item is
 * parsed individually so one malformed item yields `{error}` at its index, not a request-wide
 * 422. Always 200 on a well-formed envelope — per-item outcomes live in the body (`summary` +
 * index-aligned `results`).
 */
import express from 'express';
import { z } from 'zod';
import { APIConnectionError } from 'openai';

import { upsertArtifactTxn, getArtifactBySource, existingSourceIds } from './db.js';
import { embedToFloat32, embedManyToFloat32, EMBED_BATCH_MAX_INPUTS, EMBED_BATCH_MAX_CHARS } from './embeddings.js';
import { log } from './logger.js';
import { reverseGeocode } from './geocode.js';
import { isRegisteredType, isExtensionType } from './ingest-types.js';

const JSON_BODY_LIMIT = '256kb'; // contract §2 per-request cap (raw media never travels here)
const INGEST_BATCH_MAX = 100; // contract §2/§7 batch cap — named, not a magic number

// alias_type / role vocabularies (doc 04 §4). A hint that violates these is dropped with a
// warning rather than failing the whole artifact.
const ALIAS_TYPES = ['email', 'phone', 'name', 'handle'];
const HINT_ROLES = ['sender', 'recipient', 'pictured', 'mentioned', 'author', 'self', 'location_of'];

// Bare lowercase sha256 hex (no algorithm prefix) — matches core's sha256() helper so
// cross-import dedup compares by exact string equality (doc 04 §3).
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

// Per-hint schema (strict: an unknown key inside a hint is a malformed hint → dropped+warned,
// never a 422 that loses the artifact). Validated element-by-element in validateHints, so the
// payload schema itself only checks that entity_hints is an array.
const HintSchema = z.object({
  alias: z.string().min(1),
  alias_type: z.enum(ALIAS_TYPES),
  role: z.enum(HINT_ROLES).optional(),
  confidence: z.number().optional(), // clamped/sanitized core-side (db.js hintConfidence)
  // #119: opt-in creation intent. When present AND the hint doesn't match an existing entity,
  // core STAGES a proposed_entities row for human review instead of minting the entity — the
  // anti-pollution gate for seed-from-artifacts (vendor/sender). A connector still asserts no
  // ID (contract §1.2 / rule #3): it proposes a kind; core decides.
  suggested_kind: z.enum(['person', 'org']).optional(),
}).strict();

// Strict payload schema (doc 04 §3). `.strict()` → an unknown top-level key is 422, not a
// silently-dropped field. Optional (not nullable): explicit null on an optional field is 422 —
// nothing can be cleared through this API (append-only). source/source_id required (upsert key).
export const IngestPayloadSchema = z.object({
  source: z.string().min(1),
  source_id: z.string().min(1),
  type: z.string().refine((t) => isRegisteredType(t) || isExtensionType(t), {
    message: 'type must be a registered type or an x- extension (see GET /api/v1/ingest/types)',
  }),
  text_repr: z.string().min(1),
  occurred_at: z.string().min(1).optional(),
  content_hash: z.string().regex(CONTENT_HASH_RE, 'content_hash must be a bare lowercase sha256 hex string').optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  place_label: z.string().optional(),
  raw_path: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  entity_hints: z.array(z.unknown()).optional(),
}).strict();

// Envelope shape only (doc 04 §2 batch rule): 1–100 items, each still `z.unknown()` — item
// validation happens per-item in the route so one malformed item never 422s the whole batch.
// Deliberately NOT .strict(): unlike IngestPayloadSchema (where an unknown key is a likely
// typo that would silently lose data), an unrecognized envelope key is forward-compatible —
// a future `meta` field shouldn't 422 against an older server. Only shape/count is enforced.
export const BatchEnvelopeSchema = z.object({
  artifacts: z.array(z.unknown()).min(1).max(INGEST_BATCH_MAX),
});

// Read-only existence check (#198): given a source and up to INGEST_BATCH_MAX source_ids, report
// which are already stored. `.strict()` (an unknown key is a likely typo); 1..100 ids, each
// non-empty. Validation failures are 422 via the router error middleware, exactly like /ingest.
export const ExistsSchema = z.object({
  source: z.string().min(1),
  source_ids: z.array(z.string().min(1)).min(1).max(INGEST_BATCH_MAX),
}).strict();

// Validate hints one at a time: good ones pass through, malformed ones are dropped and
// reported as warnings (the artifact itself is never lost over a bad hint — doc 04 §2).
function validateHints(rawHints) {
  const hints = [];
  const warnings = [];
  (rawHints ?? []).forEach((h, i) => {
    const parsed = HintSchema.safeParse(h);
    if (parsed.success) hints.push(parsed.data);
    else warnings.push(`entity_hints[${i}] dropped: ${parsed.error.issues.map((x) => x.message).join('; ')}`);
  });
  return { hints, warnings };
}

// Non-destructive issues stay accept-with-warning (doc 04 §2): a missing occurred_at falls
// back to ingested_at for the timeline; an x- type is accepted but flagged unregistered.
export function computeWarnings(payload) {
  const warnings = [];
  if (payload.occurred_at == null) warnings.push('occurred_at missing; ingested_at used for timeline');
  // The schema guarantees a registered type OR an x- extension, so "not registered" ⇒ x-.
  if (!isRegisteredType(payload.type)) {
    warnings.push(`type "${payload.type}" is not in the registry; accepted as an x- extension type`);
  }
  return warnings;
}

/**
 * Decide whether an embed is needed and build the artifact/hints shape — everything executeIngest
 * did EXCEPT calling the embedder and writing the DB. Split out (#408) so the batch route can
 * pre-pass every item (this function), collect whichever items came back with `textToEmbed !=
 * null`, and embed however many of them fit in a gateway call — instead of one embed call per
 * item. `textToEmbed` is `payload.text_repr` when a (re)embed is needed, else null, mirroring the
 * textChanged gate exactly as it read before the split: a metadata-only upsert (or an identical
 * retry) still never calls Ollama. Pure of network/DB writes; the one DB read
 * (`getArtifactBySource`) is the same existing-row lookup the old inline code made.
 */
export function prepareIngest(payload) {
  const { hints, warnings: hintWarnings } = validateHints(payload.entity_hints);
  const warnings = [...computeWarnings(payload), ...hintWarnings];

  const existing = getArtifactBySource(payload.source, payload.source_id);
  const textChanged = !existing || payload.text_repr !== existing.text_repr;

  // Present fields only (the schema is .strict(), so unknown keys are already rejected 422, and
  // absent optionals are simply not on the object); serialize `extra` into extra_json. The
  // update path leaves any field not present here untouched.
  const { extra, entity_hints, ...rest } = payload;
  const artifact = { ...rest };
  if (extra !== undefined) artifact.extra_json = JSON.stringify(extra);

  // place_label is schema-optional but not schema-non-empty (unlike e.g. entity_hints' alias,
  // which is .min(1)) — a "" from a connector means "I don't have one," not "clear it." Treat
  // it exactly like an absent field: never forward it to upsertArtifactTxn, where a non-null ""
  // would win the COALESCE and silently wipe an existing value despite the contract's "nothing
  // can be cleared" rule (that rule only rejects an explicit `null`, not an empty string).
  if (artifact.place_label === '') delete artifact.place_label;

  // Core resolves place_label from raw coordinates when neither this payload nor the artifact's
  // current stored row already has one (issue #67) — mirrors the textChanged decision just
  // above (both decide whether a derived field needs recomputing), but needs no textChanged-style
  // gate itself: reverseGeocode is a pure local lookup, not a network call, so it's cheap enough
  // to just always run when eligible. (The actual embed call this textChanged decision feeds
  // happens later, in the caller — prepareIngest only decides; see #408.) Checking
  // `existing` (not just this payload) matters: a later upsert wave that resends lat/lon without
  // place_label must never clobber a value already resolved — whether that value came from a
  // connector's own explicit label or from this same enrichment on an earlier ingest.
  if (
    payload.latitude != null && payload.longitude != null && !payload.place_label
    && !existing?.place_label
  ) {
    const label = reverseGeocode(payload.latitude, payload.longitude);
    if (label) artifact.place_label = label;
  }

  return { artifact, hints, warnings, textToEmbed: textChanged ? payload.text_repr : null };
}

/**
 * Perform the write given an already-computed vector (null when `prepared.textToEmbed` was null).
 * Split out from executeIngest (#408) so the embed decision (prepareIngest, above) stays
 * separable from the commit — the batch route calls this once per item, after filling in whatever
 * vector a batched (or per-item-fallback) embed call produced for it.
 */
export function finishIngest(prepared, vector) {
  const result = upsertArtifactTxn(prepared.artifact, vector, prepared.hints);
  return { result, warnings: prepared.warnings };
}

/**
 * Orchestrate one ingest: decide whether the embedding must be (re)computed, fetch it BEFORE
 * the transaction (enrich-then-commit), then upsert. Re-embeds only when text_repr is new or
 * changed — a metadata-only upsert (or an identical retry) never calls Ollama. Returns
 * { result, warnings } where result is upsertArtifactTxn's { id, created, resolved, unresolved }.
 * Unchanged in signature and behavior (#408) — the single-item route still calls straight
 * through in one step; only the batch route (below) pulls prepareIngest/finishIngest apart.
 */
export async function executeIngest(payload) {
  const prepared = prepareIngest(payload);
  const vector = prepared.textToEmbed != null ? await embedToFloat32(prepared.textToEmbed) : null;
  return finishIngest(prepared, vector);
}

// Shared response shape (§2) for a successful ingest, single or batch — one place to change
// if the contract ever adds a field, instead of the single route and the batch loop drifting.
function formatIngestResult(result, warnings) {
  const body = {
    id: result.id,
    created: result.created,
    resolved_entities: result.resolved,
    unresolved_aliases: result.unresolved,
  };
  if (warnings.length) body.warnings = warnings;
  return body;
}

// Route-local wrapper (mirrors server.js): funnels async rejections into next(err) so the
// router error middleware / the app error funnel handle them.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Validate one raw batch item then run it through the SAME executeIngest path as single ingest —
// unchanged (#19 design decision), embedding that one item's text on its own rather than as part
// of a chunk. The /ingest/batch route itself no longer loops through this (#408: it pre-passes,
// chunks, and batch-embeds instead, below) — this stays exported for a caller that wants
// single-item-at-a-time semantics (and is what the #255 gateway-vs-item classification is tested
// against). Never throws — a validation failure or a runtime failure (embed, constraint) becomes
// `{error, issues?}` instead of throwing (upsertArtifactTxn is itself a db.transaction, so a
// thrown error there rolls back only this one item's write).
export async function ingestBatchItem(rawItem, index) {
  const parsed = IngestPayloadSchema.safeParse(rawItem);
  if (!parsed.success) return { error: 'validation', issues: parsed.error.issues };
  try {
    const { result, warnings } = await executeIngest(parsed.data);
    return formatIngestResult(result, warnings);
  } catch (err) {
    // Full detail logged server-side with the item index so a batch failure is attributable
    // (design-philosophy §4); the item is skipped, the loop continues. The client-facing body
    // stays generic — mirrors the app's own 500 posture (server.js's error funnel masks
    // internal errors behind "Internal server error"), so an embed/DB failure never leaks
    // internal connection details (e.g. the Ollama URL) to an API-key holder. The one
    // exception: an unreachable/timed-out embedding gateway gets its own code
    // (`APIConnectionTimeoutError` extends `APIConnectionError`, so this one check covers
    // both) — this is a "retry later" signal, not "this item is bad," and a connector can't
    // tell those apart from an identical `ingest_failed` (#255). Shared with the batch route's
    // own error classification below (classifyEmbedOrWriteError) so the two can't drift.
    return classifyEmbedOrWriteError(err, index);
  }
}

/**
 * Bin-pack the items a batch's pre-pass found needing an embed into chunks that respect BOTH
 * `EMBED_BATCH_MAX_INPUTS` and `EMBED_BATCH_MAX_CHARS` (#408) — greedy, in original order, so
 * results stay easy to reason about. A single item whose own text alone exceeds the char budget
 * still ships in a chunk of one (it can't be split); the char check only ever gates whether the
 * NEXT item joins an already-nonempty chunk. `items` is `[{ index, textToEmbed }, …]`.
 */
export function chunkForEmbedding(items) {
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const item of items) {
    const len = item.textToEmbed.length;
    if (current.length > 0 && (current.length >= EMBED_BATCH_MAX_INPUTS || currentChars + len > EMBED_BATCH_MAX_CHARS)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Shared by both the chunk-level and the per-item-fallback embed failure paths below: classify a
// runtime failure exactly like ingestBatchItem does (#255) and log it once, at the index it
// belongs to, before recording it as the item's result.
function classifyEmbedOrWriteError(err, index) {
  log.error('ingest.batch_item.failed', 'batch item failed and was isolated', err, { index });
  return err instanceof APIConnectionError ? { error: 'embedding_unavailable' } : { error: 'ingest_failed' };
}

/**
 * Build the /api/v1 connector router. Mounted BEFORE the global 32 KB parser in server.js
 * so the 256 KB cap (contract §2) applies to ingest bodies while legacy routes keep their cap.
 * `requireAuth` is the shared x-api-key middleware, injected so this module stays server-agnostic.
 */
export function buildIngestRouter({ requireAuth }) {
  const router = express.Router();

  // Auth BEFORE the body parser: reject an unauthenticated caller on headers alone, so no one
  // without a key can make the server buffer/parse up to 256 KB (8x the legacy 32 KB budget).
  router.post('/ingest', requireAuth, express.json({ limit: JSON_BODY_LIMIT }), wrap(async (req, res) => {
    const payload = IngestPayloadSchema.parse(req.body); // ZodError → router error mw → 422
    const { result, warnings } = await executeIngest(payload);
    res.status(result.created ? 201 : 200).json(formatIngestResult(result, warnings));
  }));

  // Existence check (#198, doc 04 §2): read-only — report which source_ids are already stored so a
  // connector can skip the expensive enrich+ingest for artifacts core already has (e.g. a Takeout
  // re-extract resets file mtimes → the connector's local skip-manifest misses on everything). No
  // upsert, no ingest_log row. 422 on a bad envelope (shape/count) via the same middleware below.
  router.post('/exists', requireAuth, express.json({ limit: JSON_BODY_LIMIT }), wrap(async (req, res) => {
    const { source, source_ids } = ExistsSchema.parse(req.body); // ZodError → router error mw → 422
    res.status(200).json({ exists: existingSourceIds(source, source_ids) });
  }));

  // Batch (#19, doc 04 §2; batched embedding #408): envelope-level 422 only for shape/count
  // problems (not an array, 0 items, >100 items) — the same z.ZodError → 422 middleware below
  // handles that. Item-level failures never reach that middleware; they're isolated per item and
  // reported at their index. Always 200 on a well-formed envelope, per-item outcomes in the body,
  // so a connector never re-sends 99 good items because 1 failed.
  //
  // Four phases, replacing the old "await ingestBatchItem per item" loop (which embedded strictly
  // serially — #408's whole point):
  //   1. pre-pass every item — validate, then prepareIngest decides textToEmbed per item so a
  //      metadata-only wave collects nothing to embed at all (zero gateway calls);
  //   2. chunk the items that DO need embedding by the two budgets;
  //   3. embedManyToFloat32 once per chunk — on a chunk-level failure, log it ONCE and fall back
  //      to per-item embedding for that chunk only, so one pathological text degrades to
  //      today's per-item behavior without failing the other chunks (#255's gateway-vs-item
  //      distinction stays intact: an unreachable gateway still reports `embedding_unavailable`);
  //   4. write every item that has a result pending (finishIngest with its now-known vector,
  //      null for a metadata-only item) — a chunk/fallback failure already filled that item's
  //      slot in step 3 and is skipped here.
  router.post('/ingest/batch', requireAuth, express.json({ limit: JSON_BODY_LIMIT }), wrap(async (req, res) => {
    const { artifacts } = BatchEnvelopeSchema.parse(req.body); // ZodError → router error mw → 422
    const summary = { created: 0, updated: 0, failed: 0 };
    const results = new Array(artifacts.length);
    const prepared = new Array(artifacts.length);
    const toEmbed = [];

    // A key seen earlier in THIS batch (source, source_id) forces a re-embed for every later
    // occurrence — prepareIngest's textChanged read happens before ANY of this batch's writes
    // land, so a later item's own "unchanged" snapshot can already be stale by the time the write
    // loop reaches it (an earlier same-key item's write lands first, in-batch). Without this, a
    // stale null vector hits upsertArtifactTxn's own concurrent-upsert guard (db.js) and the item
    // fails with ingest_failed for what is actually a same-batch ordering effect, not a real
    // conflict (#408) — verified against that guard directly, not assumed.
    const seenKeys = new Set();
    for (let i = 0; i < artifacts.length; i++) {
      const parsed = IngestPayloadSchema.safeParse(artifacts[i]);
      if (!parsed.success) { results[i] = { error: 'validation', issues: parsed.error.issues }; continue; }
      // prepareIngest does a DB read and JSON.stringify — not immune to a runtime failure, and a
      // batch's per-item isolation promise (module docstring above) has to hold for THIS phase
      // too, not just the embed/write phases below.
      try {
        const p = prepareIngest(parsed.data);
        const key = `${parsed.data.source}\u0000${parsed.data.source_id}`;
        if (seenKeys.has(key) && p.textToEmbed == null) p.textToEmbed = parsed.data.text_repr;
        seenKeys.add(key);
        prepared[i] = p;
        if (p.textToEmbed != null) toEmbed.push({ index: i, textToEmbed: p.textToEmbed });
      } catch (err) {
        results[i] = classifyEmbedOrWriteError(err, i);
      }
    }

    for (const chunk of chunkForEmbedding(toEmbed)) {
      let vectors = null;
      try {
        vectors = await embedManyToFloat32(chunk.map((c) => c.textToEmbed));
      } catch (err) {
        if (err instanceof APIConnectionError) {
          // An unreachable/timed-out gateway (#255) fails identically for every item in the
          // chunk — retrying per-item would pay EMBED_TIMEOUT_MS (default 60s) again for each of
          // up to EMBED_BATCH_MAX_INPUTS items, a guaranteed-doomed, very expensive retry.
          // Classify the whole chunk directly instead; no fallback attempt.
          for (const { index } of chunk) results[index] = classifyEmbedOrWriteError(err, index);
          continue;
        }
        // A deterministic/protocol failure (VECTOR_DIMENSION mismatch, index-coverage) or
        // anything else unexpected: not necessarily item-specific, but bounded in cost (each
        // fallback call below is one ordinary embed, not a repeated timeout) — so fall back to
        // embedding this chunk one item at a time. `embedManyToFloat32`'s own `log.span` already
        // wrote this failure's ERROR row (err_msg/stack); this is a distinct transition event,
        // not a second log of the same exception (absolute rule 7 — log an exception once).
        log.warn('ingest.batch_chunk_embed.fell_back', 'chunk-level embed failed; falling back to per-item embedding', { count: chunk.length });
      }
      for (let j = 0; j < chunk.length; j++) {
        const { index, textToEmbed } = chunk[j];
        if (vectors) { prepared[index].vector = vectors[j]; continue; }
        try {
          prepared[index].vector = await embedToFloat32(textToEmbed);
        } catch (err) {
          results[index] = classifyEmbedOrWriteError(err, index);
        }
      }
    }

    for (let i = 0; i < artifacts.length; i++) {
      if (results[i]) continue; // already a validation failure or an embed-fallback failure above
      try {
        const { result, warnings } = finishIngest(prepared[i], prepared[i].vector ?? null);
        results[i] = formatIngestResult(result, warnings);
      } catch (err) {
        results[i] = classifyEmbedOrWriteError(err, i);
      }
    }

    for (const entry of results) {
      if (entry.error) summary.failed++;
      else if (entry.created) summary.created++;
      else summary.updated++;
    }
    res.status(200).json({ summary, results });
  }));

  // Contract §2 validation shape (422) lives here, not in the app funnel — the legacy routes
  // keep their existing 400 "Validation Failed" body. Body-parser errors (413 oversize, 400
  // malformed JSON) carry a numeric status and fall through to the app error funnel.
  router.use((err, req, res, next) => {
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: 'validation', issues: err.issues });
    }
    next(err);
  });

  return router;
}
