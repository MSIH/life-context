// #184: query-time given-name prefix fallback for entity resolution — SEARCH PATH ONLY.
// resolveEntityIds stays exact-match (hot ingest/annotate/display path); hybridSearch falls back
// to resolveNameByPrefix when the exact match misses, and that resolves a bare first name to a
// full-name entity ONLY when exactly one entity matches (ambiguous -> unresolved, no wrong filter).
// DB_PATH -> temp file and a fake Ollama (embeddings + planner) are stood up BEFORE the dynamic
// imports — the same pattern as search.test.mjs / ingest.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const { hybridSearch } = await import('../src/search.js');
const { executeIngest } = await import('../src/ingest.js');
const { db, insertEntityStmt, insertAliasStmt, resolveEntityIds, resolveNameByPrefix } = await import('../src/db.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

// Create a person entity with the given full-name `name` aliases and ingest ONE note linked to it
// via an exact name hint (role 'mentioned'). Returns the entity id. Each test uses its own first-name
// namespace so the shared module-level DB never lets one test's entity make another's ambiguous.
async function person(fullNames, { source_id, text_repr }) {
  const eid = Number(insertEntityStmt.run('person', fullNames[0], null).lastInsertRowid);
  for (const n of fullNames) insertAliasStmt.run(eid, n.toLowerCase(), 'name');
  await executeIngest({
    source: 'e184', source_id, type: 'note', text_repr, occurred_at: '2026-05-01',
    entity_hints: [{ alias: fullNames[0], alias_type: 'name', role: 'mentioned' }],
  });
  return eid;
}

test('(a) an unambiguous given name resolves and restricts results to that entity (#184)', async () => {
  // One "Quinn" person, two name aliases (both start with "quinn " -> same single entity), plus an
  // unlinked artifact carrying the same query terms. "quinn" must resolve to Quinn and filter out the rest.
  const quinn = await person(['Quinn Delgado', 'Quinn Marie Delgado'], { source_id: 'a-quinn', text_repr: 'weekend hike trip report' });
  await executeIngest({ source: 'e184', source_id: 'a-other', type: 'note', text_repr: 'weekend hike trip report', occurred_at: '2026-05-01' });

  assert.deepEqual(resolveNameByPrefix('quinn'), [quinn], 'the bare given name resolves to the single matching entity');
  const ids = (await hybridSearch('weekend hike trip report', { limit: 10, entities: ['quinn'], usePlanner: false })).map((r) => r.source_id);
  assert.ok(ids.includes('a-quinn'), "the artifact linked to Quinn is returned");
  assert.ok(!ids.includes('a-other'), 'the unlinked artifact is filtered out — the entity filter was applied');
});

test('(b) an ambiguous given name does NOT resolve; the search stays unfiltered (#184)', async () => {
  await person(['Sam Rivera'], { source_id: 'b-sam1', text_repr: 'quarterly budget memo' });
  await person(['Sam Okafor'], { source_id: 'b-sam2', text_repr: 'quarterly budget memo' });
  await executeIngest({ source: 'e184', source_id: 'b-other', type: 'note', text_repr: 'quarterly budget memo', occurred_at: '2026-05-01' });

  assert.deepEqual(resolveNameByPrefix('sam'), [], 'two entities match "sam…" -> ambiguous -> [] (no resolution)');
  const ids = (await hybridSearch('quarterly budget memo', { limit: 10, entities: ['sam'], usePlanner: false })).map((r) => r.source_id);
  assert.ok(ids.includes('b-other'), 'the artifact linked to neither Sam is still returned — no wrong entity filter applied');
});

test('(c) exact full-name resolution still works and restricts (#184)', async () => {
  // Self-contained (no cross-test state): two "Dana …" people so bare "dana" is ambiguous, yet the
  // full name exact-resolves to exactly one entity via resolveEntityIds (the unchanged exact path).
  const cole = await person(['Dana Cole'], { source_id: 'c-cole', text_repr: 'release notes checklist' });
  await person(['Dana Pearce'], { source_id: 'c-pearce', text_repr: 'release notes checklist' });
  await executeIngest({ source: 'e184', source_id: 'c-other', type: 'note', text_repr: 'release notes checklist', occurred_at: '2026-05-01' });

  assert.deepEqual(resolveEntityIds('dana cole'), [cole], 'the full name resolves via resolveEntityIds (exact match, unchanged)');
  const ids = (await hybridSearch('release notes checklist', { limit: 10, entities: ['dana cole'], usePlanner: false })).map((r) => r.source_id);
  assert.ok(ids.includes('c-cole'), "Dana Cole's artifact is returned");
  assert.ok(!ids.includes('c-pearce') && !ids.includes('c-other'), 'other artifacts are excluded — the exact full-name filter applied');
});

test('(d) phone / email / handle aliases are never prefix-matched (#184)', async () => {
  // An entity with NO `name` alias — only non-name aliases whose VALUES start with the term. A prefix
  // match must ignore them entirely (matching a phone or email by a name prefix is meaningless/unsafe).
  const eid = Number(insertEntityStmt.run('person', 'Morgan Vance', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'morgan@example.com', 'email');
  insertAliasStmt.run(eid, '2565550137', 'phone');
  insertAliasStmt.run(eid, 'morgan_v', 'handle');

  assert.deepEqual(resolveNameByPrefix('morgan'), [], 'no `name` alias -> no prefix match, even though email/handle values start with "morgan"');
  assert.deepEqual(resolveNameByPrefix('2565550137'), [], 'a phone value is not reachable via the name-prefix path');
});

test('(e) exact match takes precedence — a term that exact-matches never uses the prefix path (#184)', async () => {
  // A single-token "Alex" entity plus two "Alex …" entities. Bare "alex" EXACT-matches the single-token
  // entity; the prefix path alone would be ambiguous (3 entities) and resolve nothing — but it never
  // runs, because hybridSearch tries resolveEntityIds first and short-circuits on a hit.
  const alex = await person(['Alex'], { source_id: 'e-alex', text_repr: 'onboarding checklist draft' });
  await person(['Alex Stone'], { source_id: 'e-stone', text_repr: 'onboarding checklist draft' });
  await person(['Alex Kim'], { source_id: 'e-kim', text_repr: 'onboarding checklist draft' });

  assert.deepEqual(resolveEntityIds('alex'), [alex], 'the bare name exact-matches the single-token "Alex" entity');
  assert.deepEqual(resolveNameByPrefix('alex'), [], 'the prefix path alone would be ambiguous across 3 entities');

  const ids = (await hybridSearch('onboarding checklist draft', { limit: 10, entities: ['alex'], usePlanner: false })).map((r) => r.source_id);
  assert.ok(ids.includes('e-alex'), "the exact-matched Alex entity's artifact is returned");
  assert.ok(!ids.includes('e-stone') && !ids.includes('e-kim'), 'the prefix-only entities are excluded — exact match won and filtered');
});
