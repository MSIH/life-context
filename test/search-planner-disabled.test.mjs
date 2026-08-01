// #179: QUERY_PLANNER_ENABLED=false must skip the planner LLM entirely (no chat call) yet still
// return fused semantic+keyword results. The flag is read at config load (src/config.js), so it
// is set BEFORE the dynamic imports — the same before-import discipline as DB_PATH/OLLAMA_BASE_URL
// (helpers.mjs). This lives in its own file because `node --test` runs each file in a separate
// process, so the load-time flag can't be toggled within search.test.mjs (which loads it enabled).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;
process.env.QUERY_PLANNER_ENABLED = 'false';

const { hybridSearch, warmUpQueryModel } = await import('../src/search.js');
const { executeIngest } = await import('../src/ingest.js');
const { db } = await import('../src/db.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

test('QUERY_PLANNER_ENABLED=false: search makes no planner LLM call and still returns fused results (#179)', async () => {
  await executeIngest({ source: 'np', source_id: 'n-1', type: 'note', text_repr: 'sunset kayak on the bay', occurred_at: '2026-02-02' });
  const before = fake.counts.chat;
  // usePlanner defaults true; the global flag being false must still short-circuit to the
  // pure-semantic path (identical to usePlanner:false) without touching the chat endpoint.
  const rows = await hybridSearch('kayak sunset bay', { limit: 5 });
  assert.equal(fake.counts.chat, before, 'no planner chat call is made with the planner disabled');
  assert.ok(rows.some((r) => r.source_id === 'n-1'), 'the pure-semantic path still returns the matching note');
});

test('QUERY_PLANNER_ENABLED=false: warmUpQueryModel makes no /api/generate call either (#247)', async () => {
  const before = fake.counts.generate;
  await warmUpQueryModel();
  assert.equal(fake.counts.generate, before, 'nothing to warm up when the planner is disabled');
});
