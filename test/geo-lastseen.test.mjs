// #190: "where / last seen" — geo-required filter + recency ordering in hybridSearch.
// geoRequired restricts the candidate set to artifacts with a non-null place_label; sort:'recent'
// bypasses RRF and orders the (filtered) set by occurred_at DESC. Both are plan-derived (planner
// classifies "where"/"last seen" wording) and overridable by caller opts, and both preserve the
// demote-never-drop posture — a "where was X" with no geotagged match degrades to relevance.
// DB_PATH -> temp file and a fake Ollama (embeddings + planner) are stood up BEFORE the dynamic
// imports — the same pattern as search.test.mjs / entity-resolve.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const { hybridSearch } = await import('../src/search.js');
const { executeIngest } = await import('../src/ingest.js');
const { db, insertEntityStmt, insertAliasStmt } = await import('../src/db.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

test('(a) geoRequired:true returns only artifacts with a non-null place_label (#190)', async () => {
  // Three notes sharing the query terms; only two carry a place_label.
  await executeIngest({ source: 'geo-a', source_id: 'a-geo1', type: 'note', text_repr: 'lakeside picnic afternoon', occurred_at: '2026-02-01', latitude: 47.6, longitude: -122.3, place_label: 'Seattle, WA' });
  await executeIngest({ source: 'geo-a', source_id: 'a-geo2', type: 'note', text_repr: 'lakeside picnic afternoon', occurred_at: '2026-02-02', latitude: 45.5, longitude: -122.6, place_label: 'Portland, OR' });
  await executeIngest({ source: 'geo-a', source_id: 'a-nogeo', type: 'note', text_repr: 'lakeside picnic afternoon', occurred_at: '2026-02-03' });

  const rows = await hybridSearch('lakeside picnic afternoon', { limit: 10, geoRequired: true, usePlanner: false });
  assert.ok(rows.length > 0, 'geoRequired:true still returns the geotagged matches');
  assert.ok(rows.every((r) => r.place_label != null), 'every returned row has a non-null place_label');
  assert.ok(!rows.some((r) => r.source_id === 'a-nogeo'), 'the geo-less artifact is filtered out');
});

test('(b) sort:"recent" orders the result set by occurred_at DESC (#190)', async () => {
  await executeIngest({ source: 'geo-b', source_id: 'b-old', type: 'note', text_repr: 'sprint retro meeting notes', occurred_at: '2026-01-05' });
  await executeIngest({ source: 'geo-b', source_id: 'b-mid', type: 'note', text_repr: 'sprint retro meeting notes', occurred_at: '2026-03-05' });
  await executeIngest({ source: 'geo-b', source_id: 'b-new', type: 'note', text_repr: 'sprint retro meeting notes', occurred_at: '2026-06-05' });

  const rows = await hybridSearch('sprint retro meeting notes', { limit: 10, sort: 'recent', usePlanner: false });
  const seen = rows.filter((r) => r.source_id.startsWith('b-'));
  assert.deepEqual(seen.map((r) => r.source_id), ['b-new', 'b-mid', 'b-old'], 'ordered occurred_at DESC');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i - 1].occurred_at >= seen[i].occurred_at, 'monotonically non-increasing occurred_at');
  }
});

test('(c) "where was X last seen" returns the most-recent GEOTAGGED photo first (#190)', async () => {
  // One person, several photos across dates; only some geotagged. The most recent photo overall is
  // geo-less (a message-style attachment); the most recent GEOTAGGED one is the "last seen" answer.
  const eid = Number(insertEntityStmt.run('person', 'Casey Lane', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'casey lane', 'name');
  const photo = (source_id, occurred_at, geo) => executeIngest({
    source: 'geo-c', source_id, type: 'photo', text_repr: `Photo with Casey Lane ${source_id}`, occurred_at,
    ...(geo ? { latitude: 34.05, longitude: -118.24, place_label: geo } : {}),
    entity_hints: [{ alias: 'Casey Lane', alias_type: 'name', role: 'mentioned' }],
  });
  await photo('c-geo-old', '2026-01-10', 'Los Angeles, CA');
  await photo('c-geo-mid', '2026-04-10', 'San Diego, CA');   // <- most recent geotagged: the answer
  await photo('c-nogeo-new', '2026-07-01', null);            // most recent overall, but geo-less

  const rows = await hybridSearch('where was casey lane last seen in photo', {
    limit: 10, types: ['photo'], entities: ['casey lane'], geoRequired: true, sort: 'recent', usePlanner: false,
  });
  assert.ok(rows.length > 0, 'the geotagged photos are returned');
  assert.equal(rows[0].source_id, 'c-geo-mid', 'the most-recent GEOTAGGED photo is the top result');
  assert.ok(rows.every((r) => r.place_label != null), 'no geo-less attachment leaks in');
  assert.ok(!rows.some((r) => r.source_id === 'c-nogeo-new'), 'the geo-less newest photo is excluded');
});

test('(d) a PLAN-derived geo_required with zero geotagged candidates demotes to relevance (non-empty) (#190)', async () => {
  // Devon's linked photos are ALL geo-less. When geo_required comes from the PLAN (not the caller),
  // the zero-candidate retry drops it (demote-never-drop) and plan-derived sort:recent demotes to
  // relevance too; the caller-supplied entity/type filters survive, so Devon's geo-less photos return.
  const eid = Number(insertEntityStmt.run('person', 'Devon Marsh', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'devon marsh', 'name');
  for (const sid of ['d-p1', 'd-p2']) {
    await executeIngest({
      source: 'geo-d', source_id: sid, type: 'photo', text_repr: `Photo received from Devon Marsh ${sid}`, occurred_at: '2026-05-01',
      entity_hints: [{ alias: 'Devon Marsh', alias_type: 'name', role: 'sender' }],
    });
  }
  fake.setChatPlan({ types: ['photo'], entities: ['devon marsh'], geo_required: true, sort: 'recent', semantic: 'devon marsh photo' });
  const rows = await hybridSearch('where was devon marsh last seen', {
    limit: 10, types: ['photo'], entities: ['devon marsh'], usePlanner: true,
  });
  assert.ok(rows.length > 0, 'plan-derived geo_required with no geotagged match -> demotes to relevance, not empty');
  assert.ok(rows.some((r) => r.source_id.startsWith('d-p')), "Devon's geo-less photos are returned by the demoted search");
});

test('(e) a plain query is unchanged — defaults geo_required:false, sort:relevance (#190)', async () => {
  // A geo-less note is returned by a plain default search: geo_required defaults false (no filter),
  // sort defaults relevance (RRF path). Proves the new keys don't perturb the ordinary path.
  await executeIngest({ source: 'geo-e', source_id: 'e-note', type: 'note', text_repr: 'grocery list for the week', occurred_at: '2026-03-20' });
  const rows = await hybridSearch('grocery list for the week', { limit: 10, usePlanner: false });
  assert.ok(rows.some((r) => r.source_id === 'e-note'), 'the geo-less note is returned by the default search');
});

test('(f) the planner plan carries geo_required/sort for a "where … last seen" query (#190)', async () => {
  // The fake planner echoes setChatPlan; a plan carrying geo_required:true + sort:"recent" must flow
  // through PlanSchema into hybridSearch and produce the geotagged-most-recent-first behavior WITHOUT
  // any caller override — proving the two plan fields are read and applied on the planner path.
  const eid = Number(insertEntityStmt.run('person', 'Robin Vega', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'robin vega', 'name');
  const photo = (source_id, occurred_at, geo) => executeIngest({
    source: 'geo-f', source_id, type: 'photo', text_repr: `Photo with Robin Vega ${source_id}`, occurred_at,
    ...(geo ? { latitude: 40.71, longitude: -74.0, place_label: geo } : {}),
    entity_hints: [{ alias: 'Robin Vega', alias_type: 'name', role: 'mentioned' }],
  });
  await photo('f-geo-old', '2026-02-15', 'New York, NY');
  await photo('f-geo-new', '2026-05-15', 'Boston, MA');   // most recent geotagged: the answer
  await photo('f-nogeo-new', '2026-08-15', null);         // most recent overall, geo-less

  const before = fake.counts.chat;
  fake.setChatPlan({ types: ['photo'], entities: ['robin vega'], geo_required: true, sort: 'recent', semantic: 'robin vega photo' });
  const rows = await hybridSearch('where was robin vega last seen in photo', { limit: 10, usePlanner: true });
  assert.equal(fake.counts.chat, before + 1, 'the planner LLM was called');
  assert.ok(rows.length > 0, 'the plan-driven geo filter still returns the geotagged photos');
  assert.equal(rows[0].source_id, 'f-geo-new', 'plan geo_required+sort:recent -> most-recent geotagged photo first');
  assert.ok(rows.every((r) => r.place_label != null), 'plan geo_required filtered out the geo-less photo');
});

test('(g) a CALLER-supplied geoRequired:true with no geotagged match yields an honest empty (#190)', async () => {
  // Unlike the plan-derived case (d), an explicit caller geoRequired:true is a deliberate filter (like
  // caller-supplied types/entities): if it matches nothing it returns empty, not a silent demotion.
  const eid = Number(insertEntityStmt.run('person', 'Harper Quinn', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'harper quinn', 'name');
  await executeIngest({
    source: 'geo-g', source_id: 'g-p1', type: 'photo', text_repr: 'Photo received from Harper Quinn g-p1', occurred_at: '2026-05-02',
    entity_hints: [{ alias: 'Harper Quinn', alias_type: 'name', role: 'sender' }],
  });
  const rows = await hybridSearch('where was harper quinn last seen', {
    limit: 10, types: ['photo'], entities: ['harper quinn'], geoRequired: true, usePlanner: false,
  });
  assert.equal(rows.length, 0, 'explicit caller geoRequired:true + no geotagged match -> honest empty');
});
