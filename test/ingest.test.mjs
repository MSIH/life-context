// The ingest contract (src/ingest.js, connector contract doc 04): payload validation strictness,
// warning computation, and the enrich-then-commit orchestration — in particular re-embed ONLY
// when text_repr changed (a metadata-only wave must never call the embedder). A fake local
// Ollama stands in for the engine and counts embedding calls. DB_PATH + OLLAMA_BASE_URL are set
// before src/ingest.js (which imports db.js + embeddings.js) is loaded.
//
// #408 (batch embedding): the /ingest/batch route itself is exercised over real HTTP against a
// throwaway express app (buildIngestRouter mounted with a no-op auth stub — this file doesn't
// test auth, server.test.mjs does) so "one embed call for N items" is asserted against the
// ACTUAL route, not just the chunker/prepare helpers in isolation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { useTempDb, useTempEvents, startFakeOllama, fakeVectorFor, readEvents } from './helpers.mjs';

const { cleanup } = useTempDb();
const { cleanup: cleanupEvents } = useTempEvents(); // wins over useTempDb's EVENTS_LOG_ENABLED=false — #408's own event-row AC needs a live store
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const {
  executeIngest, computeWarnings, IngestPayloadSchema, ingestBatchItem, buildIngestRouter,
  chunkForEmbedding,
} = await import('../src/ingest.js');
const { db, getArtifactById } = await import('../src/db.js');
const {
  getEmbeddings, embedManyToFloat32, embedToFloat32, EMBED_BATCH_MAX_INPUTS, EMBED_BATCH_MAX_CHARS,
} = await import('../src/embeddings.js');
const { log } = await import('../src/logger.js');

after(async () => { db.close(); log.close(); await fake.close(); cleanupEvents(log); cleanup(); });

// Stand up the real batch route (no other server.js machinery — auth is a no-op stub, this file
// isn't testing auth) so the chunk/embed/write orchestration is exercised end to end.
async function startBatchApp() {
  const app = express();
  app.use('/api/v1', buildIngestRouter({ requireAuth: (req, res, next) => next() }));
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address();
  return {
    postBatch: (artifacts) => fetch(`http://127.0.0.1:${port}/api/v1/ingest/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifacts }),
    }).then((r) => r.json().then((body) => ({ status: r.status, body }))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('computeWarnings: flags missing occurred_at and an x- extension type', () => {
  const w = computeWarnings({ type: 'x-custom', text_repr: 't' });
  assert.ok(w.some((m) => /occurred_at missing/.test(m)));
  assert.ok(w.some((m) => /x- extension/.test(m)));
  // A registered type with occurred_at present yields no warnings.
  assert.deepEqual(computeWarnings({ type: 'note', occurred_at: '2026-01-01', text_repr: 't' }), []);
});

test('IngestPayloadSchema: strict — unknown key, explicit null, and bad content_hash all fail', () => {
  const base = { source: 's', source_id: '1', type: 'note', text_repr: 't' };
  assert.equal(IngestPayloadSchema.safeParse(base).success, true);
  assert.equal(IngestPayloadSchema.safeParse({ ...base, bogus: 1 }).success, false, 'unknown top-level key rejected');
  assert.equal(IngestPayloadSchema.safeParse({ ...base, place_label: null }).success, false, 'explicit null on optional rejected (nothing is clearable)');
  assert.equal(IngestPayloadSchema.safeParse({ ...base, content_hash: 'not-a-hash' }).success, false, 'malformed content_hash rejected');
  assert.equal(IngestPayloadSchema.safeParse({ ...base, content_hash: 'a'.repeat(64) }).success, true, 'bare sha256 hex accepted');
});

test('executeIngest: create embeds once; metadata-only re-ingest does not re-embed; text change does', async () => {
  const source = 'ingest-embed';
  const start = fake.counts.embed;

  const created = await executeIngest({ source, source_id: '1', type: 'note', text_repr: 'hello world' });
  assert.equal(created.result.created, true);
  assert.equal(fake.counts.embed, start + 1, 'create embeds exactly once');

  // Same text_repr, only a metadata field added → must NOT call the embedder.
  const meta = await executeIngest({ source, source_id: '1', type: 'note', text_repr: 'hello world', place_label: 'Paris' });
  assert.equal(meta.result.created, false);
  assert.equal(fake.counts.embed, start + 1, 'metadata-only upsert skips the embedder');

  // Changed text_repr → re-embed.
  await executeIngest({ source, source_id: '1', type: 'note', text_repr: 'goodbye world' });
  assert.equal(fake.counts.embed, start + 2, 'a text_repr change re-embeds');
});

test('executeIngest: core resolves place_label from raw lat/lon when none is supplied (#67)', async () => {
  // San Francisco coordinates, no place_label — core reverse-geocodes offline from the bundled
  // GeoNames dataset (landed in #69). Assert a label was resolved without pinning the exact city
  // string (dataset-dependent), and that it did not require the embedder path to be special.
  const r = await executeIngest({
    source: 'geo', source_id: '1', type: 'photo', text_repr: 'a photo by the bay',
    latitude: 37.7749, longitude: -122.4194,
  });
  const a = getArtifactById(r.result.id);
  assert.ok(a.place_label && a.place_label.length > 0, 'a place_label was resolved from coordinates');
});

// --- #408: batch the embedding call so /ingest/batch stops embedding serially ---------------
// These MUST run before the "unreachable embedding gateway" test below, which permanently closes
// `fake` (mirroring a real Ollama-down repro) — every test after that one has no live gateway.

test('#408 POST /ingest/batch: a 50-item batch where every text_repr changed issues exactly one embed gateway call', async () => {
  const testApp = await startBatchApp();
  try {
    const start = fake.counts.embed;
    const artifacts = Array.from({ length: 50 }, (_, i) => ({
      source: 'batch-408-all-changed', source_id: String(i), type: 'note', text_repr: `probe message ${i}`,
    }));
    const { status, body } = await testApp.postBatch(artifacts);
    assert.equal(status, 200);
    assert.equal(body.summary.created, 50);
    assert.equal(body.summary.failed, 0);
    assert.equal(fake.counts.embed, start + 1, 'one gateway call embeds all 50 changed items');
  } finally {
    await testApp.close();
  }
});

test('#408 POST /ingest/batch: a metadata-only batch issues zero embed gateway calls', async () => {
  const testApp = await startBatchApp();
  try {
    const seed = Array.from({ length: 50 }, (_, i) => ({
      source: 'batch-408-meta-only', source_id: String(i), type: 'note', text_repr: `stable text ${i}`,
    }));
    const { status: seedStatus, body: seedBody } = await testApp.postBatch(seed);
    assert.equal(seedStatus, 200);
    assert.equal(seedBody.summary.created, 50);

    const start = fake.counts.embed;
    // Same text_repr, only a metadata field added — must never call the embedder.
    const metaOnly = seed.map((a) => ({ ...a, place_label: 'Paris' }));
    const { status, body } = await testApp.postBatch(metaOnly);
    assert.equal(status, 200);
    assert.equal(body.summary.updated, 50);
    assert.equal(body.summary.failed, 0);
    assert.equal(fake.counts.embed, start, 'zero gateway calls for a metadata-only batch');
  } finally {
    await testApp.close();
  }
});

test('#408 POST /ingest/batch: a mixed batch (metadata-only + text-changed, interleaved) issues one embed call and pairs every vector with its own artifact', async () => {
  const testApp = await startBatchApp();
  try {
    // Seed 10 artifacts, then resend all 10 with every ODD index's text_repr changed and every
    // EVEN index left identical — toEmbed's indices are non-contiguous, exercising the chunk's
    // index-to-vector zip (`prepared[index].vector = vectors[j]`) against a gapped input, not
    // just a dense 0..49 range.
    const seed = Array.from({ length: 10 }, (_, i) => ({
      source: 'batch-408-mixed', source_id: String(i), type: 'note', text_repr: `mixed original ${i}`,
    }));
    const seeded = await testApp.postBatch(seed);
    assert.equal(seeded.body.summary.created, 10);

    const start = fake.counts.embed;
    const mixed = seed.map((a, i) => (i % 2 === 1 ? { ...a, text_repr: `mixed changed ${i}` } : a));
    const { status, body } = await testApp.postBatch(mixed);
    assert.equal(status, 200);
    assert.equal(body.summary.updated, 10);
    assert.equal(body.summary.failed, 0);
    assert.equal(fake.counts.embed, start + 1, 'one gateway call for the 5 changed items, despite non-contiguous indices');

    // Storage-level pairing: read each artifact's ACTUAL stored vector (not just what
    // getEmbeddings returned in memory) and confirm it matches its own text — the route's
    // second, independent zip (chunk index -> artifact id) is what this catches; the
    // getEmbeddings-level reordering test above covers only the first zip (response index ->
    // array position).
    for (let i = 0; i < mixed.length; i++) {
      const id = body.results[i].id;
      const stored = db.prepare('SELECT embedding FROM vec_artifacts WHERE artifact_id = ?').get(BigInt(id))?.embedding;
      const expected = Buffer.from(fakeVectorFor(mixed[i].text_repr).buffer);
      assert.deepEqual(Buffer.from(stored), expected, `artifact ${i}'s stored vector belongs to its own text`);
    }
  } finally {
    await testApp.close();
  }
});

test('#535/#408 POST /ingest/batch: two items sharing (source, source_id) in one batch force a re-embed on the second occurrence', async () => {
  const testApp = await startBatchApp();
  try {
    const seeded = await testApp.postBatch([
      { source: 'batch-535-dup', source_id: '0', type: 'note', text_repr: 'dup text' },
    ]);
    assert.equal(seeded.body.summary.created, 1);

    const start = fake.counts.embed;
    // Both items resend the SAME (source, source_id) with unchanged text_repr — in isolation
    // neither would need a re-embed, but the /ingest/batch pre-pass's seenKeys-based dedup guard must
    // force one on the second occurrence so its write doesn't race the first's in-flight upsert.
    const dup = [
      { source: 'batch-535-dup', source_id: '0', type: 'note', text_repr: 'dup text' },
      { source: 'batch-535-dup', source_id: '0', type: 'note', text_repr: 'dup text' },
    ];
    const { status, body } = await testApp.postBatch(dup);
    assert.equal(status, 200);
    assert.equal(body.summary.updated, 2);
    assert.equal(body.summary.failed, 0, 'neither occurrence hits the concurrent-upsert guard');
    assert.equal(fake.counts.embed, start + 1, 'the second same-key occurrence forces exactly one re-embed');
  } finally {
    await testApp.close();
  }
});

test('#408 POST /ingest/batch: a malformed item fails at its own index; good items around it still land', async () => {
  const testApp = await startBatchApp();
  try {
    const artifacts = [
      { source: 'batch-408-mixed-fail', source_id: '1', type: 'note', text_repr: 'good one' },
      { source: 'batch-408-mixed-fail', source_id: '2', type: 'note' }, // missing text_repr — 422-shaped item failure
      { source: 'batch-408-mixed-fail', source_id: '3', type: 'note', text_repr: 'good two' },
    ];
    const { status, body } = await testApp.postBatch(artifacts);
    assert.equal(status, 200, 'envelope itself is well-formed — always 200');
    assert.equal(body.summary.created, 2);
    assert.equal(body.summary.failed, 1);
    assert.equal(body.results[0].created, true);
    assert.equal(body.results[1].error, 'validation', 'the malformed item fails at ITS index, not the envelope');
    assert.equal(body.results[2].created, true, 'the item after the failure still lands');
  } finally {
    await testApp.close();
  }
});

test('#408 POST /ingest/batch: a chunk-level embed failure falls back to per-item embedding and never fails the other chunk', async () => {
  const testApp = await startBatchApp();
  const callSizes = [];
  // Key the injected failure on CHUNK SHAPE (texts.length === the 50-item chunk), not call
  // ordinal — the OpenAI SDK retries a 500 response by default (maxRetries), so failing only the
  // Nth call is silently masked the moment a retry lands on a later, different-shaped call and
  // succeeds: the fallback path never actually runs, yet the test still passes for the wrong
  // reason (caught in review). Every attempt at a 50-item batch — the original AND every SDK
  // retry of it — fails identically here, so the SDK is guaranteed to exhaust its retries and
  // the code's OWN fallback (not the SDK's) is what's under test.
  fake.setEmbedOverride((texts) => {
    callSizes.push(texts.length);
    if (texts.length === EMBED_BATCH_MAX_INPUTS) throw new Error('simulated chunk-level embed failure');
    return texts.map((t, i) => ({ index: i, embedding: [...fakeVectorFor(t)] }));
  });
  try {
    // EMBED_BATCH_MAX_INPUTS + 1 items forces exactly two chunks: a full 50-item chunk (whose
    // batched call always fails and falls back to 50 individual embeds) and a 1-item chunk
    // (embeds fine, size 1, never matches the failure condition).
    const artifacts = Array.from({ length: EMBED_BATCH_MAX_INPUTS + 1 }, (_, i) => ({
      source: 'batch-408-chunk-fallback', source_id: String(i), type: 'note', text_repr: `chunk item ${i}`,
    }));
    const { status, body } = await testApp.postBatch(artifacts);
    assert.equal(status, 200);
    assert.equal(body.summary.created, EMBED_BATCH_MAX_INPUTS + 1, 'every item lands despite the chunk-level failure');
    assert.equal(body.summary.failed, 0);
    // The fallback actually ran: at least one size-50 call was attempted (and every one failed —
    // this override never succeeds at size 50), and the fallback issued exactly 50 size-1 calls
    // for that chunk's items PLUS the one size-1 call for the second (never-failing) chunk.
    const size50Calls = callSizes.filter((n) => n === EMBED_BATCH_MAX_INPUTS).length;
    const size1Calls = callSizes.filter((n) => n === 1).length;
    assert.ok(size50Calls >= 1, 'the 50-item chunk was attempted at least once (and always failed)');
    assert.equal(size1Calls, EMBED_BATCH_MAX_INPUTS + 1, '50 per-item fallback calls plus the second chunk\'s own single call');
  } finally {
    fake.setEmbedOverride(null);
    await testApp.close();
  }
});

test('#408 chunkForEmbedding: splits by item count, by char budget, and ships an oversize item alone', () => {
  const item = (i, chars) => ({ index: i, textToEmbed: 'x'.repeat(chars) });

  // Exactly at the item-count cap: one chunk, not [cap, 0] or [cap-1, 1].
  const atCap = Array.from({ length: EMBED_BATCH_MAX_INPUTS }, (_, i) => item(i, 1));
  assert.deepEqual(chunkForEmbedding(atCap).map((c) => c.length), [EMBED_BATCH_MAX_INPUTS]);

  // One over the item-count cap: [cap, 1].
  const overCap = Array.from({ length: EMBED_BATCH_MAX_INPUTS + 1 }, (_, i) => item(i, 1));
  assert.deepEqual(chunkForEmbedding(overCap).map((c) => c.length), [EMBED_BATCH_MAX_INPUTS, 1]);

  // The char budget splits well before the item-count cap for longer texts: 10 items whose
  // combined chars exceed EMBED_BATCH_MAX_CHARS split into two chunks of [8, 2] at 6,000
  // chars/item (48,000 fits in 8; the 9th would push to 54,000 > 50,000).
  const perItemChars = 6000;
  const charBound = Array.from({ length: 10 }, (_, i) => item(i, perItemChars));
  assert.deepEqual(chunkForEmbedding(charBound).map((c) => c.length), [8, 2]);

  // A single item whose own text alone exceeds the char budget still ships alone — it can't be
  // split, and the char check only ever gates whether the NEXT item joins an already-nonempty
  // chunk, so this must not merge with, or block, its neighbors.
  const oversizeAlone = [item(0, EMBED_BATCH_MAX_CHARS + 1), item(1, 10), item(2, 10)];
  const chunks = chunkForEmbedding(oversizeAlone);
  assert.deepEqual(chunks.map((c) => c.length), [1, 2]);
  assert.deepEqual(chunks[0].map((c) => c.index), [0]);
});

test('#408 getEmbeddings: a response missing an index for one input rejects (coverage guard)', async () => {
  // Two inputs, but the gateway answers with only one entry — the exact "short response" shape
  // the coverage guard exists for (distinct from the wrong-LENGTH-vector test above).
  fake.setEmbedOverride((texts) => [{ index: 0, embedding: [...fakeVectorFor(texts[0])] }]);
  try {
    await assert.rejects(() => getEmbeddings(['probe-a', 'probe-b']), /did not cover every input/);
  } finally {
    fake.setEmbedOverride(null);
  }
});

test('#408 getEmbeddings: a duplicate response index rejects', async () => {
  // Both entries claim index 0 — an invalid/duplicate index, not a coverage shortfall.
  fake.setEmbedOverride((texts) => [
    { index: 0, embedding: [...fakeVectorFor(texts[0])] },
    { index: 0, embedding: [...fakeVectorFor(texts[1])] },
  ]);
  try {
    await assert.rejects(() => getEmbeddings(['probe-a', 'probe-b']), /invalid or duplicate index/);
  } finally {
    fake.setEmbedOverride(null);
  }
});

test('#408 ollama.embed_batch.completed: carries model/count/chars and no text', async () => {
  const before = readEvents(log, { event: 'ollama.embed_batch.completed' }).length;
  await getEmbeddings(['event row probe one', 'event row probe two']);
  const rows = readEvents(log, { event: 'ollama.embed_batch.completed' });
  assert.equal(rows.length, before + 1, 'one new ollama.embed_batch.completed row');
  const row = rows[rows.length - 1];
  const data = JSON.parse(row.data);
  assert.equal(typeof data.model, 'string');
  assert.ok(data.model.length > 0, 'model is a plain string, not redacted-shaped (not a deny-listed key)');
  assert.equal(data.count, 2);
  assert.equal(typeof data.chars, 'number');
  assert.ok(data.chars > 0);
  const serialized = row.data ?? '';
  assert.ok(!serialized.includes('event row probe'), 'no embedded text ever reaches the data column');
  assert.ok(row.msg == null || !row.msg.includes('event row probe'), 'no embedded text in msg');
});

test('#408 getEmbeddings: maps vectors back by the response index field, not array position (reordering guard)', async () => {
  // The array ORDER of `data` is reversed relative to the input, but each entry's own `index`
  // field still correctly names its input. A positional implementation (out[i] = data[i]) would
  // pair every text with the WRONG vector; mapping by index must still land each vector on its
  // own text regardless of array order.
  fake.setEmbedOverride((texts) => texts.map((t, i) => ({ index: i, embedding: [...fakeVectorFor(t)] })).reverse());
  try {
    const texts = ['alpha probe', 'beta probe', 'gamma probe'];
    const vectors = await getEmbeddings(texts);
    texts.forEach((t, i) => {
      assert.deepEqual(vectors[i], [...fakeVectorFor(t)], `position ${i} holds its own text's vector, not a swapped one`);
    });
  } finally {
    fake.setEmbedOverride(null);
  }
});

test('#408 getEmbeddings: a wrong-length vector raises the VECTOR_DIMENSION mismatch error', async () => {
  fake.setEmbedOverride((texts) => texts.map((t, i) => ({ index: i, embedding: [1, 2, 3] })));
  try {
    await assert.rejects(() => getEmbeddings(['short-vector-probe']), /VECTOR_DIMENSION/);
  } finally {
    fake.setEmbedOverride(null);
  }
});

test('#408 embedManyToFloat32: byte-identical to the single-call embedToFloat32 path for the same text', async () => {
  const text = 'byte-identical probe text, batch vs single';
  const single = await embedToFloat32(text);
  const [batched] = await embedManyToFloat32([text]);
  assert.deepEqual(Buffer.from(batched.buffer), Buffer.from(single.buffer));
});

test('ingestBatchItem: an unreachable embedding gateway yields embedding_unavailable, not ingest_failed (#255)', async () => {
  // Stop the fake Ollama so the next embedding call refuses the connection (ECONNREFUSED),
  // mirroring a real Ollama-down repro. Safe to close again in `after` — node's
  // server.close(callback) on an already-stopped server just invokes the callback with an
  // error argument, which the helper's resolve-as-callback silently absorbs. MUST be the LAST
  // test in this file (see the #408 block's note above) — every test after this one has no
  // live gateway.
  await fake.close();

  // A brand-new source_id forces a re-embed (executeIngest always embeds on create).
  const failed = await ingestBatchItem(
    { source: 'ingest-gateway-down', source_id: '1', type: 'note', text_repr: 'unreachable' },
    0,
  );
  assert.deepEqual(failed, { error: 'embedding_unavailable' });
});
