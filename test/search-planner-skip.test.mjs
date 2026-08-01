// #433: a caller-supplied `use_planner: false` (REST/MCP) must skip the LLM query-planner call
// entirely while still gap-filling via the pure, deterministic `lexicalPlanHints` (#352) pre-pass
// — unlike the two pre-existing skip paths (`/api/recall`'s `usePlanner:false` and
// `QUERY_PLANNER_ENABLED=false`, both covered by search-planner-disabled.test.mjs and asserted
// unchanged there), which never ran the lexical pre-pass and must keep not running it. Own file
// (mirrors search-planner-disabled.test.mjs) so the default-planner-on chat-count assertion and
// the skip-path chat-count assertion are cleanest kept apart from the rest of search.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, useTempEvents, startFakeOllama, readEvents } from './helpers.mjs';

const { cleanup } = useTempDb();
const { cleanup: cleanupEvents } = useTempEvents();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;
// Pin explicitly (mirrors search-planner-disabled.test.mjs's own explicit 'false') — the "default
// call DOES make a planner chat call" assertion below would otherwise fail on a box whose .env
// sets QUERY_PLANNER_ENABLED=false (a supported, documented posture, #179).
process.env.QUERY_PLANNER_ENABLED = 'true';

const { hybridSearch } = await import('../src/search.js');
const { executeIngest } = await import('../src/ingest.js');
const { db } = await import('../src/db.js');
const { log } = await import('../src/logger.js');

after(async () => { db.close(); await fake.close(); cleanupEvents(log); cleanup(); });

test('usePlanner:false, lexicalWhenSkipped:true makes no planner chat call but still returns the matching row', async () => {
  await executeIngest({ source: 'sp', source_id: 'sp-1', type: 'note', text_repr: 'sunset kayak on the bay', occurred_at: '2026-02-02' });
  const before = fake.counts.chat;
  const rows = await hybridSearch('kayak sunset bay', { limit: 5, usePlanner: false, lexicalWhenSkipped: true });
  assert.equal(fake.counts.chat, before, 'no planner chat call on the skip path');
  assert.ok(rows.some((r) => r.source_id === 'sp-1'), 'the skip path still returns the matching row');
});

test('a default call (usePlanner omitted) DOES make a planner chat call', async () => {
  const before = fake.counts.chat;
  await hybridSearch('kayak sunset bay', { limit: 5 });
  assert.equal(fake.counts.chat, before + 1, 'the default path calls the planner exactly once');
});

test('lexicalWhenSkipped:true gap-fills types from a literal kind word; lexicalWhenSkipped:false does not', async () => {
  await executeIngest({ source: 'sp', source_id: 'sp-2', type: 'photo', text_repr: 'beach photos from the trip', occurred_at: '2026-02-03' });
  await executeIngest({ source: 'sp', source_id: 'sp-3', type: 'note', text_repr: 'beach notes from the trip', occurred_at: '2026-02-03' });

  const withLexical = await hybridSearch('show me the beach photos', { limit: 10, usePlanner: false, lexicalWhenSkipped: true });
  assert.ok(withLexical.some((r) => r.source_id === 'sp-2'), 'lexical gap-fill infers types:[photo] and returns the photo');
  assert.ok(!withLexical.some((r) => r.source_id === 'sp-3'), 'the note (not a photo) is filtered out by the inferred type');

  const withoutLexical = await hybridSearch('show me the beach photos', { limit: 10, usePlanner: false, lexicalWhenSkipped: false });
  assert.ok(withoutLexical.some((r) => r.source_id === 'sp-3'), 'without lexical gap-fill, no type filter is applied and the note is still returned');
});

test('usePlanner:false with lexicalWhenSkipped OMITTED does not gap-fill — the default stays off (#179 unchanged)', async () => {
  // Same fixtures as the previous test (sp-2 a photo, sp-3 a note, both mentioning "beach"). Pins
  // the claim in src/search.js's own JSDoc/docs/03-ob2-design.md that the two PRE-EXISTING skip
  // paths (usePlanner:false with no lexicalWhenSkipped, and QUERY_PLANNER_ENABLED=false) stay
  // byte-for-byte unchanged — i.e. lexicalWhenSkipped truly defaults false, not just documented as
  // such. Flipping the default to true would leave every other assertion in this file green.
  const rows = await hybridSearch('show me the beach photos', { limit: 10, usePlanner: false });
  assert.ok(rows.some((r) => r.source_id === 'sp-3'), 'omitting lexicalWhenSkipped applies no type inference — the note is still returned');
});

test('planner_skip (#328/#433): a caller skip logs "caller"; the default path logs null', async () => {
  const before = readEvents(log).at(-1)?.id ?? 0;
  await hybridSearch('kayak sunset bay', { limit: 5, usePlanner: false, lexicalWhenSkipped: true });
  await hybridSearch('kayak sunset bay', { limit: 5 });
  const spans = readEvents(log, { event: 'search.hybrid.completed', since: before });
  assert.equal(spans.length, 2, 'both search calls produce a completed span');
  const [skipSpan, defaultSpan] = spans.map((s) => JSON.parse(s.data));
  assert.equal(skipSpan.planner_skip, 'caller', 'a caller-supplied usePlanner:false logs planner_skip:"caller"');
  assert.equal(defaultSpan.planner_skip, null, 'the default (planner-on) path logs planner_skip:null');
  // Absolute rule 7: the query text itself never reaches the span row.
  for (const s of spans) {
    assert.doesNotMatch(JSON.stringify(s), /kayak|sunset|bay/i, 'no query text in the logged row');
  }
});
