// search.js coverage: the pure ranking core (rrf) plus hybridSearch's default_searchable
// enforcement (#121). Importing search.js opens the DB (via db.js) and constructs the embedder
// client, so DB_PATH is pointed at a temp file and a fake local Ollama is stood up (embeddings +
// planner) BEFORE the dynamic imports — the same pattern as ingest.test.mjs. rrf touches neither.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, useTempEvents, startFakeOllama, readEvents } from './helpers.mjs';

const { cleanup } = useTempDb();
const { cleanup: cleanupEvents } = useTempEvents(); // this file asserts on search.plan.demoted rows (#365)
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const { rrf, hybridSearch, timeline, aboutEntity, warmUpQueryModel, localDate, lexicalPlanHints, summarizeCandidates, planDemotionLadder } = await import('../src/search.js');
const { executeIngest } = await import('../src/ingest.js');
const { db, insertEntityStmt, insertAliasStmt, normalizePhone } = await import('../src/db.js');
const { log } = await import('../src/logger.js');

after(async () => { db.close(); await fake.close(); cleanup(); cleanupEvents(log); });

test('rrf: a single list preserves its order', () => {
  assert.deepEqual(rrf([[10, 20, 30]]), [10, 20, 30]);
});

test('rrf: an id ranked by two arms outranks ids seen by only one', () => {
  // id 2 appears in both lists → its scores sum and it wins. 1 (rank 0 of one list) beats
  // 3 (rank 1 of one list).
  assert.deepEqual(rrf([[1, 2], [2, 3]]), [2, 1, 3]);
});

test('rrf: empty input is safe', () => {
  assert.deepEqual(rrf([]), []);
  assert.deepEqual(rrf([[], []]), []);
});

test('localDate: formats from local calendar components, zero-padded, never a UTC ISO slice (#253)', () => {
  // Construct via the local-component constructor (TZ-agnostic assertion): whatever the runner's
  // timezone, localDate() must report those same y/m/d components back — proving it reads
  // getFullYear/getMonth/getDate, not new Date().toISOString(), which would give the UTC day.
  assert.equal(localDate(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
  assert.equal(localDate(new Date(2026, 10, 1, 0, 5)), '2026-11-01');
});

test('hybridSearch enforces default_searchable: a no-type search hides a visit; an explicit type surfaces it (#121)', async () => {
  // A visit (default_searchable:false) and a note (searchable) sharing the query terms — the only
  // difference the enforcement can act on is the type.
  await executeIngest({ source: 'srch', source_id: 'note-1', type: 'note', text_repr: 'hiking trip to the alpine lakes', occurred_at: '2026-01-02' });
  await executeIngest({ source: 'srch', source_id: 'visit-1', type: 'visit', text_repr: 'hiking trip to the alpine lakes', occurred_at: '2026-01-02' });

  const dflt = (await hybridSearch('hiking trip alpine lakes', { limit: 10, usePlanner: false })).map((r) => r.type);
  assert.ok(dflt.includes('note'), 'a searchable type is still returned by a default search');
  assert.ok(!dflt.includes('visit'), 'a visit is NOT returned by a no-type search');

  const explicit = (await hybridSearch('hiking trip alpine lakes', { limit: 10, types: ['visit'], usePlanner: false })).map((r) => r.type);
  assert.ok(explicit.includes('visit'), 'an explicit types:[visit] returns the visit — explicit wins over the default');
  assert.ok(!explicit.includes('note'), 'the explicit type filter still excludes other types');
});

test('planner: a filter it returns within the timeout is applied (fake-Ollama) (#179)', async () => {
  // Two notes with identical text (identical embeddings → both are semantic candidates) on
  // different dates. The query text names no date, so only a planner-supplied time filter can
  // select June over January — proving the plan is both fetched (chat call) and applied.
  await executeIngest({ source: 'plan', source_id: 'p-jan', type: 'note', text_repr: 'quarterly planning offsite', occurred_at: '2026-01-10' });
  await executeIngest({ source: 'plan', source_id: 'p-jun', type: 'note', text_repr: 'quarterly planning offsite', occurred_at: '2026-06-10' });
  const before = fake.counts.chat;
  fake.setChatPlan({ time_start: '2026-06-01', time_end: '2026-06-30', semantic: 'quarterly planning offsite' });
  const rows = await hybridSearch('quarterly planning offsite', { limit: 10, usePlanner: true });
  assert.equal(fake.counts.chat, before + 1, 'the planner LLM was called (planner enabled, responds within the timeout)');
  const ids = rows.map((r) => r.source_id);
  assert.ok(ids.includes('p-jun'), 'the June note (inside the planner time window) is returned');
  assert.ok(!ids.includes('p-jan'), 'the January note is excluded by the planner time filter');
});

test('#227 candidate temp table: two sequential searches with different type filters do not cross-contaminate', async () => {
  // A note and a message sharing a distinctive keyword — the shared candidate temp table is
  // cleared + refilled per search, so search N's candidate set must never leak into search N+1.
  // 'zebra-widget' is rare enough to drive the FTS (EXISTS) arm; the type filter is the only
  // discriminator, exactly as the temp table constrains both the KNN (IN) and FTS (EXISTS) arms.
  await executeIngest({ source: 'iso', source_id: 'iso-note', type: 'note', text_repr: 'zebra-widget quarterly recap', occurred_at: '2026-02-01' });
  await executeIngest({ source: 'iso', source_id: 'iso-msg', type: 'message', text_repr: 'zebra-widget quarterly recap', occurred_at: '2026-02-01' });

  const first = (await hybridSearch('zebra-widget quarterly recap', { limit: 10, types: ['note'], usePlanner: false })).map((r) => r.source_id);
  const second = (await hybridSearch('zebra-widget quarterly recap', { limit: 10, types: ['message'], usePlanner: false })).map((r) => r.source_id);

  assert.ok(first.includes('iso-note') && !first.includes('iso-msg'), 'search 1 (types:[note]) returns only the note');
  assert.ok(second.includes('iso-msg') && !second.includes('iso-note'), 'search 2 (types:[message]) returns only the message — no leftover candidates from search 1');
});

test('#227 recent sort orders the candidate set via the temp table (occurred_at DESC)', async () => {
  // sort:'recent' bypasses KNN/FTS and orders the temp-table candidate set directly — exercise it
  // so the recentOrderStmt rewrite (json_each -> temp table) is covered end-to-end.
  await executeIngest({ source: 'rec', source_id: 'rec-old', type: 'note', text_repr: 'sprint retro notes', occurred_at: '2026-04-01' });
  await executeIngest({ source: 'rec', source_id: 'rec-new', type: 'note', text_repr: 'sprint retro notes', occurred_at: '2026-05-01' });
  const ids = (await hybridSearch('sprint retro notes', { limit: 10, types: ['note'], sort: 'recent', usePlanner: false })).map((r) => r.source_id);
  const iOld = ids.indexOf('rec-old');
  const iNew = ids.indexOf('rec-new');
  assert.ok(iNew !== -1 && iOld !== -1, 'both notes are candidates');
  assert.ok(iNew < iOld, 'the newer note (May) sorts before the older (April) under sort:recent');
});

test('timeline + about_entity annotate handles with the resolved contact name (#149)', async () => {
  // A contact with a phone alias, then a message from that number — the ingest hint links it.
  const eid = Number(insertEntityStmt.run('person', 'Marta Reyes', null).lastInsertRowid);
  insertAliasStmt.run(eid, normalizePhone('+13105550188'), 'phone');
  insertAliasStmt.run(eid, 'marta reyes', 'name'); // so aboutEntity('Marta Reyes') resolves by name
  await executeIngest({
    source: 'tl', source_id: 'msg-149', type: 'message',
    text_repr: 'Message from +13105550188: "dinner at 7?"', occurred_at: '2026-03-15',
    entity_hints: [{ alias: '+13105550188', alias_type: 'phone', role: 'sender' }],
  });

  const row = timeline('2026-03-01', '2026-03-31').find((r) => r.source_id === 'msg-149');
  assert.ok(row, 'the message is in the timeline range');
  assert.equal(row.text_repr, 'Message from +13105550188: "dinner at 7?"', 'text_repr stays raw');
  assert.equal(row.display_text, 'Message from Marta Reyes (+13105550188): "dinner at 7?"');

  const about = aboutEntity('Marta Reyes');
  const linked = about.entities[0].artifacts.find((a) => a.source_id === 'msg-149');
  assert.equal(linked.display_text, 'Message from Marta Reyes (+13105550188): "dinner at 7?"');
});

// The effective-day helper mirrors EFFECTIVE_TIME_SQL's own fallback (src/search.js): a NULL
// occurred_at reads through datetime(ingested_at,'localtime'). Deriving the expected day from the
// ROW rather than the wall clock (localDate(new Date())) keeps these tests correct at any hour —
// a NULL-occurred_at row's ingested_at is UTC, so a wall-clock comparison drifts by a day for
// several hours around local midnight (review finding, #436).
const effectiveDayOf = (source, sourceId) =>
  db.prepare(`SELECT date(COALESCE(occurred_at, datetime(ingested_at,'localtime'))) AS d FROM artifacts WHERE source = ? AND source_id = ?`)
    .get(source, sourceId).d;

test('timeline: a NULL occurred_at artifact is no longer invisible — falls back to ingested_at, local day (#436)', async () => {
  // No occurred_at on this ingest -> the row lands with occurred_at NULL and ingested_at defaulted
  // to CURRENT_TIMESTAMP (UTC, now). This is the repro from #436: on main, a range covering the
  // row's own effective day returns nothing because date(occurred_at) on a NULL is neither >= nor
  // <= anything. Post-fix, EFFECTIVE_TIME_SQL makes it visible on the LOCAL day it was stored.
  await executeIngest({ source: 'tl436', source_id: 'null-occurred-436', type: 'note', text_repr: 'a note with no occurred_at at all' });
  const row = db.prepare('SELECT occurred_at FROM artifacts WHERE source = ? AND source_id = ?').get('tl436', 'null-occurred-436');
  assert.equal(row.occurred_at, null, 'sanity: the row really was stored with a NULL occurred_at');

  const day = effectiveDayOf('tl436', 'null-occurred-436');
  const found = timeline(day, day).find((r) => r.source_id === 'null-occurred-436');
  assert.ok(found, 'a NULL-occurred_at artifact is returned by a range that covers its effective (local) day');
});

test('timeline: the digest-substitution path does NOT fold away a NULL-occurred_at row, even on a digested day (#436)', async () => {
  // A digest for the day, PLUS a NULL-occurred_at note ingested that same day: consolidate.js's
  // own digest-generation query excludes NULL-occurred_at rows from its input (WHERE occurred_at
  // >= ? AND occurred_at < date(?,'+1 day')), so this digest never actually summarized the note —
  // substituting it away because its ingest day matches would hide it a second, different way.
  // A prior version of this fix used COALESCE in the substitution disjunct too, which DID fold it
  // away vacuously-passing the wrong claim (a review finding, #436) — this test pins the real
  // behavior: the NULL row survives digest substitution unconditionally.
  const day = '2026-06-15';
  await executeIngest({ source: 'tl436d', source_id: 'the-digest', type: 'digest', text_repr: `digest for ${day}`, occurred_at: day });
  await executeIngest({ source: 'tl436d', source_id: 'dated-note', type: 'note', text_repr: 'a dated note on the digested day', occurred_at: day });
  await executeIngest({ source: 'tl436d', source_id: 'null-occurred-digest-436', type: 'note', text_repr: 'a note with no occurred_at, ingested on the digested day' });
  // Force the NULL row's ingested_at onto the digest's day so this test is deterministic
  // regardless of when it runs — otherwise it only exercises the digest branch when run on the
  // exact calendar day under test.
  db.prepare(`UPDATE artifacts SET ingested_at = ? WHERE source = ? AND source_id = ?`)
    .run(`${day} 12:00:00`, 'tl436d', 'null-occurred-digest-436');

  // Span must be >= DIGEST_TIMELINE_DAYS (14) with no explicit types, or timeline() routes to
  // timelineStmt (not the digest-substitution branch this test targets) — see src/search.js's
  // own span check.
  const rows = timeline('2026-06-01', '2026-06-30').map((r) => r.source_id);
  assert.ok(rows.includes('the-digest'), 'the digest itself is present');
  assert.ok(rows.includes('null-occurred-digest-436'), 'the NULL-occurred_at row is NOT folded away by the digest that never covered it');
  assert.ok(!rows.includes('dated-note'), 'a dated, digest-eligible row on the same day IS folded away — substitution still works for what the digest actually covers');
});

test('timeline: an existing connector artifact with a non-null occurred_at still sorts by it, unaffected (#436)', async () => {
  // Two notes, deliberately stored out of ingested_at order (older occurred_at ingested second),
  // with an explicit types filter so this forces timelineStmt (not the digest branch) — proves
  // ordering still tracks occurred_at, not ingested_at, for rows that HAVE one.
  await executeIngest({ source: 'tl436b', source_id: 'later', type: 'note', text_repr: 'the later one', occurred_at: '2026-02-20' });
  await executeIngest({ source: 'tl436b', source_id: 'earlier', type: 'note', text_repr: 'the earlier one', occurred_at: '2026-02-10' });

  const rows = timeline('2026-02-01', '2026-02-28', ['note']).filter((r) => r.source === 'tl436b');
  assert.deepEqual(rows.map((r) => r.source_id), ['earlier', 'later'], 'occurred_at ASC ordering is unchanged for non-null rows');
});

test('timeline: rows sharing the exact same effective time sort deterministically by id (#436)', async () => {
  // Two NULL-occurred_at rows forced to the identical ingested_at second — EFFECTIVE_TIME_SQL has
  // no other way to break the tie, so ORDER BY must append `, id ASC` or the order is arbitrary.
  await executeIngest({ source: 'tl436e', source_id: 'tie-a', type: 'note', text_repr: 'tie a' });
  await executeIngest({ source: 'tl436e', source_id: 'tie-b', type: 'note', text_repr: 'tie b' });
  const same = '2026-05-05 12:00:00';
  db.prepare(`UPDATE artifacts SET ingested_at = ? WHERE source = 'tl436e' AND source_id = 'tie-a'`).run(same);
  db.prepare(`UPDATE artifacts SET ingested_at = ? WHERE source = 'tl436e' AND source_id = 'tie-b'`).run(same);
  const [idA, idB] = ['tie-a', 'tie-b'].map((sid) => db.prepare('SELECT id FROM artifacts WHERE source = ? AND source_id = ?').get('tl436e', sid).id);

  const rows = timeline('2026-05-05', '2026-05-05', ['note']).filter((r) => r.source === 'tl436e');
  assert.deepEqual(rows.map((r) => r.id), [idA, idB].sort((a, b) => a - b), 'a tied effective time still sorts by id ASC, deterministically');
});

test('timeline: types:["x-agent-preference"] repro — 0 of 4 NULL-occurred_at preferences returned pre-fix, all 4 post-fix (#436)', async () => {
  // The issue's literal repro, typed (the actual preferences-claude connector shape) rather than
  // an untyped .find() — proves the fix reaches a caller-supplied types filter, not just the
  // default path.
  for (const n of [1, 2, 3, 4]) {
    await executeIngest({ source: 'tl436f', source_id: `pref-${n}`, type: 'x-agent-preference', text_repr: `preference ${n}` });
  }
  const day = effectiveDayOf('tl436f', 'pref-1');
  const rows = timeline(day, day, ['x-agent-preference']).filter((r) => r.source === 'tl436f');
  assert.equal(rows.length, 4, 'all 4 NULL-occurred_at preferences are returned by a typed timeline range covering their effective day');
});

test('hybridSearch: a caller time_range covering a NULL-occurred_at row\'s effective day returns it, not wrong-empty (#538)', async () => {
  // Repro: pre-fix, candidateStmt's date(a.occurred_at) bound excluded every NULL-occurred_at row
  // regardless of range, so a time-bounded search over only such a row returned nothing even
  // though timeline() already showed it for the identical range (#436 fixed timeline only).
  await executeIngest({ source: 'srch538', source_id: 'null-occurred-538', type: 'note', text_repr: 'zephyr-crescent quarterly notes with no occurred_at' });
  const row = db.prepare('SELECT occurred_at FROM artifacts WHERE source = ? AND source_id = ?').get('srch538', 'null-occurred-538');
  assert.equal(row.occurred_at, null, 'sanity: the row really was stored with a NULL occurred_at');

  const day = effectiveDayOf('srch538', 'null-occurred-538');
  const ids = (await hybridSearch('zephyr-crescent quarterly notes', {
    limit: 10, types: ['note'], timeRange: { start: day, end: day }, usePlanner: false,
  })).map((r) => r.source_id);
  assert.ok(ids.includes('null-occurred-538'), 'a time-bounded search returns the NULL-occurred_at row for its effective (local) day, matching timeline');
});

test('hybridSearch sort:"recent": a NULL-occurred_at row ranks by its ingested_at fallback, not always last (#538)', async () => {
  // The live repro from #538: ORDER BY occurred_at DESC sorts NULL last in SQLite, so a row stored
  // just now (NULL occurred_at) always lost to any dated row, however stale, under sort:'recent'.
  await executeIngest({ source: 'srch538r', source_id: 'dated-old', type: 'note', text_repr: 'sprint-quokka retro notes', occurred_at: '2020-01-01' });
  await executeIngest({ source: 'srch538r', source_id: 'null-new', type: 'note', text_repr: 'sprint-quokka retro notes' });
  const nullRow = db.prepare('SELECT occurred_at FROM artifacts WHERE source = ? AND source_id = ?').get('srch538r', 'null-new');
  assert.equal(nullRow.occurred_at, null, 'sanity: the newer row has a NULL occurred_at');

  // limit is generous (not 10, unlike most sort:recent tests here) — this shared temp DB
  // accumulates other tests' 'note'-type fixtures over the file's run, and `dated-old`'s 2020
  // date would otherwise fall out of a tight top-N window as later tests add newer rows.
  const ids = (await hybridSearch('sprint-quokka retro notes', {
    limit: 1000, types: ['note'], sort: 'recent', usePlanner: false,
  })).map((r) => r.source_id);
  const iNull = ids.indexOf('null-new');
  const iDated = ids.indexOf('dated-old');
  assert.ok(iNull !== -1 && iDated !== -1, 'both notes are candidates');
  assert.ok(iNull < iDated, 'the just-ingested NULL-occurred_at row outranks a 2020 dated row under sort:recent');
});

test('about_entity: a NULL-occurred_at artifact orders by its ingested_at fallback, not always last (#538)', async () => {
  const eid = Number(insertEntityStmt.run('person', 'Talia Osment', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'talia osment', 'name');
  await executeIngest({
    source: 'ae538', source_id: 'ae-dated-old', type: 'note', text_repr: 'Note about Talia Osment, 2020',
    occurred_at: '2020-01-01', entity_hints: [{ alias: 'talia osment', alias_type: 'name', role: 'mentioned' }],
  });
  await executeIngest({
    source: 'ae538', source_id: 'ae-null-new', type: 'note', text_repr: 'Note about Talia Osment, no occurred_at',
    entity_hints: [{ alias: 'talia osment', alias_type: 'name', role: 'mentioned' }],
  });
  const nullRow = db.prepare('SELECT occurred_at FROM artifacts WHERE source = ? AND source_id = ?').get('ae538', 'ae-null-new');
  assert.equal(nullRow.occurred_at, null, 'sanity: the newer artifact has a NULL occurred_at');

  const about = aboutEntity('Talia Osment');
  const ids = about.entities[0].artifacts.map((a) => a.source_id);
  const iNull = ids.indexOf('ae-null-new');
  const iDated = ids.indexOf('ae-dated-old');
  assert.ok(iNull !== -1 && iDated !== -1, 'both artifacts are linked to the entity');
  assert.ok(iNull < iDated, 'the just-ingested NULL-occurred_at artifact outranks the 2020 dated one');
});

test('about_entity: artifacts sharing the exact same effective time sort deterministically by id (#538, mirrors #436\'s timeline tie test)', async () => {
  const eid = Number(insertEntityStmt.run('person', 'Corin Beaulac', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'corin beaulac', 'name');
  await executeIngest({
    source: 'ae538tie', source_id: 'ae-tie-a', type: 'note', text_repr: 'Note about Corin Beaulac, tie a',
    entity_hints: [{ alias: 'corin beaulac', alias_type: 'name', role: 'mentioned' }],
  });
  await executeIngest({
    source: 'ae538tie', source_id: 'ae-tie-b', type: 'note', text_repr: 'Note about Corin Beaulac, tie b',
    entity_hints: [{ alias: 'corin beaulac', alias_type: 'name', role: 'mentioned' }],
  });
  const same = '2026-05-05 12:00:00';
  db.prepare(`UPDATE artifacts SET ingested_at = ? WHERE source = 'ae538tie' AND source_id = 'ae-tie-a'`).run(same);
  db.prepare(`UPDATE artifacts SET ingested_at = ? WHERE source = 'ae538tie' AND source_id = 'ae-tie-b'`).run(same);
  const [idA, idB] = ['ae-tie-a', 'ae-tie-b'].map((sid) => db.prepare('SELECT id FROM artifacts WHERE source = ? AND source_id = ?').get('ae538tie', sid).id);

  const about = aboutEntity('Corin Beaulac');
  const ids = about.entities[0].artifacts.map((a) => a.id);
  assert.deepEqual(ids, [idA, idB].sort((a, b) => b - a), 'a tied effective time still sorts by id DESC, deterministically');
});

test('lexicalPlanHints: extracts a type from a literal kind word, singular and plural (#352)', () => {
  assert.deepEqual(lexicalPlanHints('show me the photo of the lake').types, ['photo']);
  assert.deepEqual(lexicalPlanHints('show me photos of the lake').types, ['photo']);
  assert.deepEqual(lexicalPlanHints('any texts or messages from Jordan').types, ['message']);
  assert.deepEqual(new Set(lexicalPlanHints('emails and documents from work').types), new Set(['email', 'document']));
  assert.deepEqual(lexicalPlanHints('quiet afternoon by the lake').types, [], 'no kind word -> no type');
});

test('lexicalPlanHints: a place candidate is confirmed against the shipped gazetteer, never regex-trusted (#352)', () => {
  assert.equal(lexicalPlanHints('photos of Jordan Lee in Ocean City').place, 'Ocean City');
  assert.equal(lexicalPlanHints('vacation in Texas').place, 'Texas', 'a US state resolves via normalizeUsState too');
  assert.equal(lexicalPlanHints('a walk at the beach').place, null, '"the beach" has no capitalized run to even try');
  assert.equal(lexicalPlanHints('left in a hurry').place, null, '"a hurry" has no capitalized run either');
  assert.equal(lexicalPlanHints('meeting at Zzyzxville').place, null, 'a capitalized run that fails gazetteer confirmation yields nothing');
});

test('lexicalPlanHints: "where was X last seen" (#190) yields neither types nor place (no kind word, no place named)', () => {
  const hints = lexicalPlanHints('where was Jordan Lee last seen');
  assert.deepEqual(hints.types, []);
  assert.equal(hints.place, null);
});

test('regression #352: "photos of X in Ocean City" recovers the types/place filters the planner omits, so the geotagged photo outranks a message that merely mentions the place', async () => {
  const eid = Number(insertEntityStmt.run('person', 'Jordan Lee', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'jordan lee', 'name');

  // The correct answer: geotagged, linked to the entity, but — the shape the bug needs —
  // text_repr carries no scene text at all (the caption worker hasn't run).
  await executeIngest({
    source: 'reg352', source_id: 'reg-photo', type: 'photo', text_repr: 'Photo taken 2021-06-05',
    occurred_at: '2021-06-05', latitude: 38.34, longitude: -75.08, place_label: 'Ocean City, Maryland',
    entity_hints: [{ alias: 'jordan lee', alias_type: 'name', role: 'pictured' }],
  });
  // The decoy: a message that literally contains "Ocean City" in its body, linked to the same
  // entity — without the place filter this currently outranks the photo (#352's Problem section).
  await executeIngest({
    source: 'reg352', source_id: 'reg-message', type: 'message',
    text_repr: "Jordan Lee: can't wait for our Ocean City trip next month!", occurred_at: '2021-05-20',
    entity_hints: [{ alias: 'jordan lee', alias_type: 'name', role: 'sender' }],
  });

  // The fake planner reproduces the EXACT documented failure: types:[] and place:null for a
  // query that literally says "photos" and "in Ocean City" (qwen2.5:3b's real behavior, #352).
  fake.setChatPlan({ types: [], entities: ['Jordan Lee'], place: null, semantic: 'photos of Jordan Lee in Ocean City' });
  const rows = await hybridSearch('photos of Jordan Lee in Ocean City', { limit: 5, entities: ['Jordan Lee'], usePlanner: true });
  const ids = rows.map((r) => r.source_id);
  assert.ok(ids.includes('reg-photo'), 'the geotagged photo is found even though the planner omitted both types and place');
  assert.ok(!ids.includes('reg-message'), 'the message is excluded once the type filter is recovered');
});

test('gap-fill only: a non-empty LLM place is NOT overridden by a place lexically extracted from the query text (#352)', async () => {
  await executeIngest({
    source: 'gap352', source_id: 'gap-la', type: 'photo', text_repr: 'Photo taken 2024-01-01',
    occurred_at: '2024-01-01', latitude: 34.05, longitude: -118.25, place_label: 'Los Angeles, California',
  });
  await executeIngest({
    source: 'gap352', source_id: 'gap-oc', type: 'photo', text_repr: 'Photo taken 2024-02-01',
    occurred_at: '2024-02-01', latitude: 38.34, longitude: -75.08, place_label: 'Ocean City, Maryland',
  });
  // The query text says "Ocean City", but the plan already names a (different) place — the
  // plan's own value must survive untouched, never overridden by the lexical extraction.
  fake.setChatPlan({ types: ['photo'], place: 'Los Angeles', semantic: 'photos in Ocean City' });
  const rows = await hybridSearch('photos in Ocean City', { limit: 10, usePlanner: true });
  const ids = rows.map((r) => r.source_id);
  assert.ok(ids.includes('gap-la'), 'the LLM-supplied place (Los Angeles) is honored');
  assert.ok(!ids.includes('gap-oc'), 'the lexically-extractable place does not leak in over a plan that already named one');
});

test('gap-fill only: a non-empty LLM types list is NOT overridden by a kind word in the query text (#352)', async () => {
  await executeIngest({ source: 'gap352b', source_id: 'gap-note', type: 'note', text_repr: 'a note about photos', occurred_at: '2024-03-01' });
  await executeIngest({ source: 'gap352b', source_id: 'gap-photo', type: 'photo', text_repr: 'Photo taken 2024-03-01', occurred_at: '2024-03-01' });
  // The query literally says "photos", but the plan already names types:["note"] — that must win.
  fake.setChatPlan({ types: ['note'], semantic: 'photos' });
  const rows = await hybridSearch('photos', { limit: 10, usePlanner: true });
  const ids = rows.map((r) => r.source_id);
  assert.ok(ids.includes('gap-note'), 'the LLM-supplied types:["note"] is honored');
  assert.ok(!ids.includes('gap-photo'), 'the lexically-extractable "photo" type does not leak in over a plan that already named types');
});

test('gap-fill: plan supplies types but leaves place null — the lexical pre-pass still fills the empty field (#352)', async () => {
  await executeIngest({
    source: 'gap352c', source_id: 'gap-photo-oc', type: 'photo', text_repr: 'Photo taken 2024-04-01',
    occurred_at: '2024-04-01', latitude: 38.34, longitude: -75.08, place_label: 'Ocean City, Maryland',
  });
  await executeIngest({
    source: 'gap352c', source_id: 'gap-photo-other', type: 'photo', text_repr: 'Photo taken 2024-04-02',
    occurred_at: '2024-04-02', latitude: 34.05, longitude: -118.25, place_label: 'Los Angeles, California',
  });
  // The plan already names types (so that field must NOT be touched) but leaves place null even
  // though the query names one — the lexical pre-pass must still recover just the empty field.
  fake.setChatPlan({ types: ['photo'], place: null, semantic: 'photos in Ocean City' });
  const rows = await hybridSearch('photos in Ocean City', { limit: 10, usePlanner: true });
  const ids = rows.map((r) => r.source_id);
  assert.ok(ids.includes('gap-photo-oc'), 'place is gap-filled from the query text when the plan left it null');
  assert.ok(!ids.includes('gap-photo-other'), 'the non-matching place is excluded once place is gap-filled');
});

test('summarizeCandidates: contiguous dates within RUN_GAP_DAYS group into one run; a larger gap splits them (#353)', () => {
  const rows = [
    { id: 1, type: 'photo', occurred_date: '2019-07-28', place_label: null, people: [] },
    { id: 2, type: 'photo', occurred_date: '2019-07-30', place_label: null, people: [] }, // 2-day gap: tolerated
    { id: 3, type: 'photo', occurred_date: '2019-08-05', place_label: null, people: [] }, // 6-day gap: new run
  ];
  const summary = summarizeCandidates(rows);
  assert.equal(summary.runs.length, 2);
  assert.deepEqual(summary.runs[0], { start: '2019-07-28', end: '2019-07-30', count: 2 });
  assert.deepEqual(summary.runs[1], { start: '2019-08-05', end: '2019-08-05', count: 1 });
});

test('summarizeCandidates: a single date yields a one-day run (#353)', () => {
  const rows = [{ id: 1, type: 'note', occurred_date: '2024-01-01', place_label: null, people: [] }];
  const summary = summarizeCandidates(rows);
  assert.deepEqual(summary.runs, [{ start: '2024-01-01', end: '2024-01-01', count: 1 }]);
  assert.deepEqual(summary.date_range, { start: '2024-01-01', end: '2024-01-01' });
});

test('summarizeCandidates: rows with no occurred_date yield no runs/date_range; other facets still render (#353)', () => {
  const rows = [
    { id: 1, type: 'contact', occurred_date: null, place_label: 'Austin, Texas', people: [] },
    { id: 2, type: 'contact', occurred_date: null, place_label: 'Austin, Texas', people: [] },
  ];
  const summary = summarizeCandidates(rows);
  assert.equal(summary.total, 2);
  assert.ok(!('date_range' in summary), 'no occurred_date on any row -> no date_range key at all');
  assert.ok(!('runs' in summary), 'no occurred_date on any row -> no runs key at all');
  assert.deepEqual(summary.places, [{ place_label: 'Austin, Texas', count: 2 }]);
});

test('summarizeCandidates: a facet with no data is absent, never null or zero (#353)', () => {
  const rows = [{ id: 1, type: 'note', occurred_date: null, place_label: null, people: [] }];
  assert.deepEqual(summarizeCandidates(rows), { total: 1, by_type: { note: 1 } });
});

test('summarizeCandidates: an empty (or missing) row set yields no summary object at all (#353)', () => {
  assert.equal(summarizeCandidates([]), null);
  assert.equal(summarizeCandidates(undefined), null);
});

test('summarizeCandidates: places and people are ordered by count desc (#353)', () => {
  const rows = [
    { id: 1, type: 'photo', occurred_date: null, place_label: 'A Place', people: [{ entity_id: 1, name: 'Alice' }] },
    { id: 2, type: 'photo', occurred_date: null, place_label: 'B Place', people: [{ entity_id: 2, name: 'Bob' }] },
    { id: 3, type: 'photo', occurred_date: null, place_label: 'B Place', people: [{ entity_id: 2, name: 'Bob' }] },
  ];
  const summary = summarizeCandidates(rows);
  assert.deepEqual(summary.places, [{ place_label: 'B Place', count: 2 }, { place_label: 'A Place', count: 1 }]);
  assert.deepEqual(summary.people, [{ entity_id: 2, name: 'Bob', count: 2 }, { entity_id: 1, name: 'Alice', count: 1 }]);
});

test('regression #353: hybridSearch summary.total reflects the FULL matched candidate set, independent of limit at two different values, and groups dates into runs', async () => {
  const eid = Number(insertEntityStmt.run('person', 'Diana Monday', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'diana monday', 'name');

  // Two visits, the shape #353 reproduces: a synthetic stand-in for the reported case —
  // a 3-day contiguous run (2019-07-28..30) and a separate later date (2021-06-05) — 5 photos
  // total, small enough to run quickly while still proving 2 runs, not 1 or 3.
  let n = 0;
  for (const d of ['2019-07-28', '2019-07-29', '2019-07-30', '2021-06-05', '2021-06-05']) {
    n += 1;
    await executeIngest({
      source: '353repro', source_id: `oc-${n}`, type: 'photo', text_repr: `Photo taken ${d}`,
      occurred_at: d, latitude: 38.34, longitude: -75.08, place_label: 'Ocean City, Maryland',
      entity_hints: [{ alias: 'diana monday', alias_type: 'name', role: 'pictured' }],
    });
  }

  const chatBefore = fake.counts.chat;
  const narrow = await hybridSearch('photos of Diana Monday in Ocean City', { limit: 2, entities: ['Diana Monday'], types: ['photo'], usePlanner: false });
  const wide = await hybridSearch('photos of Diana Monday in Ocean City', { limit: 50, entities: ['Diana Monday'], types: ['photo'], usePlanner: false });

  assert.equal(fake.counts.chat, chatBefore, 'summarizing the candidate set makes no LLM call — it is pure JS over rows already fetched');
  assert.equal(narrow.length, 2, 'the returned page is capped at the requested limit');
  assert.equal(narrow.summary.total, 5, 'total is the full matched set, not the limited page (2)');
  assert.equal(wide.length, 5);
  assert.equal(wide.summary.total, 5, 'total is unchanged at a wider limit — provably independent of limit');

  assert.deepEqual(narrow.summary.date_range, { start: '2019-07-28', end: '2021-06-05' });
  assert.equal(narrow.summary.runs.length, 2, 'two visits: the 3-day contiguous run and the separate later date');
  assert.deepEqual(narrow.summary.runs[0], { start: '2019-07-28', end: '2019-07-30', count: 3 });
  assert.deepEqual(narrow.summary.runs[1], { start: '2021-06-05', end: '2021-06-05', count: 2 });
  assert.deepEqual(narrow.summary.places, [{ place_label: 'Ocean City, Maryland', count: 5 }]);
  assert.deepEqual(narrow.summary.people, [{ entity_id: eid, name: 'Diana Monday', count: 5 }]);
});

test('regression (Copilot review, PR #361): summary.people never surfaces a non-person entity a photo is linked to (place/org/event)', async () => {
  // Photo clustering (linkArtifactsToPlace/linkArtifactsToEvent) links artifacts to place/event
  // entities via the SAME entity_links table people are linked through — summaryEntitiesStmt must
  // filter to kind='person', or a place/event entity would leak into the "people" facet (which
  // `places` already reports via place_label). The entities: filter below scopes the SQL prefilter
  // to exactly the one artifact linked to this place entity, so the shared test DB's other
  // (person-linked) photos can't dilute the assertion.
  const placeId = Number(insertEntityStmt.run('place', 'Some Cluster Place 361', null).lastInsertRowid);
  insertAliasStmt.run(placeId, 'some cluster place 361', 'name');
  const { result } = await executeIngest({
    source: '361kindfix', source_id: 'kindfix-1', type: 'photo', text_repr: 'a photo near the cluster place',
    occurred_at: '2024-05-01',
  });
  db.prepare('INSERT OR IGNORE INTO entity_links (artifact_id, entity_id, role, confidence) VALUES (?, ?, ?, ?)')
    .run(result.id, placeId, 'near', 1.0);

  const rows = await hybridSearch('a photo near the cluster place', { limit: 10, types: ['photo'], entities: ['Some Cluster Place 361'], usePlanner: false });
  assert.equal(rows.length, 1, 'the entity filter narrows the candidate set to just this one artifact');
  assert.equal(rows[0].source_id, 'kindfix-1');
  assert.ok(!('people' in rows.summary), 'a place-kind entity link does not surface under people');
});

test('hybridSearch: summary is absent for an empty result set — no "0 results" object to special-case downstream (#353)', async () => {
  // No 'video' artifact exists anywhere in this suite's temp DB, so an explicit type filter the
  // caller supplied yields an honest, deterministic empty result (demote-never-drop still applies
  // to plan-derived filters only — a caller-supplied type filter is never dropped, #121/#352).
  const rows = await hybridSearch('anything at all', { limit: 5, types: ['video'], usePlanner: false });
  assert.deepEqual(rows, []);
  assert.equal(rows.summary, undefined, 'no summary property on an empty result array');
});

test('planDemotionLadder: fixed order, filtered to only the present fields (#365)', () => {
  assert.deepEqual(
    planDemotionLadder({ time: true, geoRequired: true, near: true, place: true, types: true, entities: true }),
    ['time', 'geoRequired', 'near', 'place', 'types', 'entities'],
    'every field present -> the full fixed order',
  );
  assert.deepEqual(planDemotionLadder({ time: true, geoRequired: false, near: false, place: false, types: false, entities: false }), ['time']);
  assert.deepEqual(
    planDemotionLadder({ time: false, geoRequired: true, near: false, place: true, types: false, entities: false }),
    ['geoRequired', 'place'],
    'present fields keep the fixed order regardless of which ones are set',
  );
  assert.deepEqual(planDemotionLadder({ time: false, geoRequired: false, near: false, place: false, types: false, entities: false }), []);
});

test('regression #365: a hallucinated plan time bound no longer collapses the search to the full default_searchable set — only `time` is demoted, entity+place+type survive at rung 1', async () => {
  // Reproduces the live bug found validating #353: the planner correctly resolves entity+place+
  // type (proving #352's fix works) but ALSO invents a time_start/time_end nothing in the query
  // asked for, and that fabricated window excludes every real date — a shape the pre-#365
  // all-or-nothing retry could only "fix" by dropping entity+place+type right along with it.
  const eid = Number(insertEntityStmt.run('person', 'Nadia Ferris', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'nadia ferris', 'name');
  let n = 0;
  for (const d of ['2019-07-28', '2019-07-29', '2019-07-30', '2021-06-05', '2021-06-05']) {
    n += 1;
    await executeIngest({
      source: '365repro', source_id: `oc-${n}`, type: 'photo', text_repr: `Photo taken ${d}`,
      occurred_at: d, latitude: 38.34, longitude: -75.08, place_label: 'Ocean City, Maryland',
      entity_hints: [{ alias: 'nadia ferris', alias_type: 'name', role: 'pictured' }],
    });
  }
  // Also seed a decoy: same entity, unrelated place, so a full-fallback bug would still return
  // it — proving the ladder result is genuinely scoped, not accidentally narrow.
  await executeIngest({
    source: '365repro', source_id: 'decoy-1', type: 'photo', text_repr: 'Photo taken 2024-01-01',
    occurred_at: '2024-01-01', latitude: 34.05, longitude: -118.25, place_label: 'Los Angeles, California',
    entity_hints: [{ alias: 'nadia ferris', alias_type: 'name', role: 'pictured' }],
  });

  const before = readEvents(log).at(-1)?.id ?? 0;
  // The fake planner reproduces the exact documented failure: types/entities/place all resolve
  // correctly, but time_start/time_end are hallucinated into a window that excludes every real
  // date — no caller-supplied filters at all (matching how public/chat.js actually calls this).
  fake.setChatPlan({
    types: ['photo'], entities: ['Nadia Ferris'], place: 'Ocean City',
    time_start: '2099-01-01', time_end: '2099-12-31', semantic: 'photos of Nadia Ferris in Ocean City',
  });
  const rows = await hybridSearch('photos of Nadia Ferris in Ocean City', { limit: 10, usePlanner: true });
  const ids = rows.map((r) => r.source_id);

  assert.ok(ids.every((id) => id.startsWith('oc-')), 'only the Ocean City photos are returned — the decoy in Los Angeles is excluded');
  assert.ok(!ids.includes('decoy-1'), 'the same-entity, wrong-place decoy proves this is a real scoped match, not the full-fallback bug');
  assert.equal(rows.summary.total, 5, 'total is the real Ocean City match — NOT the whole default_searchable store');
  assert.deepEqual(rows.summary.by_type, { photo: 5 });
  assert.deepEqual(rows.summary.places, [{ place_label: 'Ocean City, Maryland', count: 5 }]);
  assert.equal(rows.summary.runs.length, 2, 'two visits: the 3-day contiguous run and the separate later date');

  // Exactly one search.plan.demoted row, resolving at rung 1 (only `time` dropped) — no query
  // text, place string, or person name in it (absolute rule 7: only the fixed-vocabulary field
  // name and a count ever reach the log).
  const demoted = readEvents(log, { event: 'search.plan.demoted', since: before });
  assert.equal(demoted.length, 1, 'exactly one demotion event for this search');
  const data = JSON.parse(demoted[0].data);
  assert.equal(data.rung, 1);
  assert.deepEqual(data.dropped, ['time']);
  const dataStr = JSON.stringify(data);
  assert.ok(!dataStr.includes('Ocean City') && !dataStr.includes('Nadia') && !dataStr.includes('Ferris'), 'no query/place/name text ever reaches the log');

  // Bounded retry: the first attempt + at most one prefilter per present plan-derived field.
  const prefilters = readEvents(log, { event: 'db.prefilter.completed', since: before });
  assert.ok(prefilters.length <= 1 + 6, 'at most 1 (first attempt) + 6 (every ladder field) prefilter calls for one search');
});

test('regression #365: a caller-supplied filter that matches nothing is still an honest empty — never demoted (unchanged contract)', async () => {
  await executeIngest({ source: '365caller', source_id: 'caller-note', type: 'note', text_repr: 'a completely unrelated note for the 365 caller-empty test', occurred_at: '2024-06-01' });
  // A caller-supplied time_range that matches nothing must still yield an honest [] — the ladder
  // only ever demotes PLAN-derived fields, never ones the caller explicitly passed as opts.
  const rows = await hybridSearch('a completely unrelated note for the 365 caller-empty test', {
    limit: 10, timeRange: { start: '1900-01-01', end: '1900-01-02' }, usePlanner: false,
  });
  assert.deepEqual(rows, []);
  assert.equal(rows.summary, undefined);
});

test('regression #510: a half-caller time range (start from caller, end hallucinated by the planner) demotes only the invented end — the caller\'s start still constrains the result', async () => {
  // Caller supplies timeRange.start only (a valid .partial() shape, src/server.js) — the planner
  // fills time_end, but invents one that excludes every real match. Pre-#510, the pair-level
  // timeFromCaller flag treated the whole time filter as caller-immune (since start came from the
  // caller), so the invented end was never ladder-eligible and the search returned an honest empty
  // even though dropping only the end would have surfaced the real, in-range data.
  const eid = Number(insertEntityStmt.run('person', 'Odessa Vance', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'odessa vance', 'name');
  for (const d of ['2021-03-01', '2021-04-15']) {
    await executeIngest({
      source: '510repro', source_id: `ov-${d}`, type: 'note', text_repr: `Note about Odessa Vance ${d}`,
      occurred_at: d, entity_hints: [{ alias: 'odessa vance', alias_type: 'name', role: 'mentioned' }],
    });
  }
  // A decoy before the caller's start bound — must stay excluded, proving the caller's own start
  // still constrains the result rather than the whole time filter being dropped.
  await executeIngest({
    source: '510repro', source_id: 'ov-decoy', type: 'note', text_repr: 'Note about Odessa Vance 2019-01-01',
    occurred_at: '2019-01-01', entity_hints: [{ alias: 'odessa vance', alias_type: 'name', role: 'mentioned' }],
  });

  const before = readEvents(log).at(-1)?.id ?? 0;
  // The planner invents a time_end before the caller's own start — an empty window no real data
  // can fall in — while resolving entities correctly.
  fake.setChatPlan({ entities: ['Odessa Vance'], time_end: '2020-06-01', semantic: 'notes about Odessa Vance' });
  const rows = await hybridSearch('notes about Odessa Vance', {
    limit: 10, timeRange: { start: '2021-01-01' }, entities: ['Odessa Vance'], usePlanner: true,
  });
  const ids = rows.map((r) => r.source_id);

  assert.ok(ids.includes('ov-2021-03-01') && ids.includes('ov-2021-04-15'), 'both in-range (post-caller-start) notes are returned');
  assert.ok(!ids.includes('ov-decoy'), "the caller's start bound still excludes the pre-2021 decoy — not a full time-filter drop");

  const demoted = readEvents(log, { event: 'search.plan.demoted', since: before });
  assert.equal(demoted.length, 1, 'exactly one demotion event');
  const data = JSON.parse(demoted[0].data);
  assert.deepEqual(data.dropped, ['time'], 'only the time rung is dropped — entities (caller-supplied) never demoted');
});

test('regression #365: sort:"recent" demotes to relevance only when geoRequired itself is dropped, not on every retry', async () => {
  // Same entity+type shape as geo-lastseen.test.mjs's Devon Marsh case (#190), reused here to
  // pin the #365 ladder's sort-demotion condition directly: geoRequired IS the field that has to
  // be dropped for these geo-less photos to surface, so sort must demote too.
  const eid = Number(insertEntityStmt.run('person', 'Priya Novak', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'priya novak', 'name');
  for (const sid of ['pn-p1', 'pn-p2']) {
    await executeIngest({
      source: '365sort', source_id: sid, type: 'photo', text_repr: `Photo received from Priya Novak ${sid}`, occurred_at: '2026-05-01',
      entity_hints: [{ alias: 'Priya Novak', alias_type: 'name', role: 'sender' }],
    });
  }
  const before = readEvents(log).at(-1)?.id ?? 0;
  fake.setChatPlan({ types: ['photo'], entities: ['priya novak'], geo_required: true, sort: 'recent', semantic: 'priya novak photo' });
  const rows = await hybridSearch('where was priya novak last seen', { limit: 10, types: ['photo'], entities: ['priya novak'], usePlanner: true });
  assert.ok(rows.some((r) => r.source_id.startsWith('pn-p')), "Priya's geo-less photos are returned once geoRequired is demoted");

  const demoted = readEvents(log, { event: 'search.plan.demoted', since: before });
  assert.equal(demoted.length, 1);
  assert.deepEqual(JSON.parse(demoted[0].data).dropped, ['geoRequired'], 'geoRequired is the only ladder-eligible field here (types/entities are caller-supplied)');
});

test('regression (Copilot review, PR #366): no search.plan.demoted log when the ladder exhausts every rung and still ends empty', async () => {
  // An entity that resolves (caller-supplied, so it's never ladder-eligible and survives every
  // rung untouched) but has zero linked artifacts — the terminal caller-only filter is honestly
  // empty even after every plan-derived field (time, geoRequired) is dropped along the way. The
  // demoted-event log must not fire a false "recovered a non-empty set" row here.
  const eid = Number(insertEntityStmt.run('person', 'Wren Castillo', null).lastInsertRowid);
  insertAliasStmt.run(eid, 'wren castillo', 'name');

  const before = readEvents(log).at(-1)?.id ?? 0;
  fake.setChatPlan({
    types: [], entities: [], place: null, near: null,
    time_start: '2099-01-01', time_end: '2099-12-31', geo_required: true,
    semantic: 'anything about wren castillo',
  });
  const rows = await hybridSearch('anything about wren castillo', { limit: 5, entities: ['Wren Castillo'], usePlanner: true });
  assert.deepEqual(rows, [], 'the caller-supplied entity has no linked artifacts at all — honest empty, not the full fallback');
  assert.equal(rows.summary, undefined);

  const demoted = readEvents(log, { event: 'search.plan.demoted', since: before });
  assert.equal(demoted.length, 0, 'no demotion event when the ladder never actually recovered a non-empty set');
});

test('warmUpQueryModel: hits the native /api/generate endpoint with the query model, keep_alive, and a non-streamed request (#247)', async () => {
  const before = fake.counts.generate;
  await warmUpQueryModel();
  assert.equal(fake.counts.generate, before + 1, 'exactly one warm-up call is made');
  const body = fake.getLastGenerateBody();
  assert.equal(body.prompt, '', 'an empty prompt preloads the model without generating tokens');
  assert.equal(body.stream, false, 'a streamed reply would otherwise never be drained');
  assert.ok(body.model && body.keep_alive, 'model and keep_alive are both forwarded');
});
