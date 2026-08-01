// Integration smoke test for the server (src/server.js): the constant-time auth comparator, the
// x-api-key gate, and the mandated store->recall round-trip over real HTTP (the mandated pre-commit
// check, automated). All env is set BEFORE importing server.js — it reads config at load, binds
// the listener with app.listen(PORT), and hard-exits if the API key is unset. A fake local
// Ollama serves embeddings so no engine is required.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useTempDb, startFakeOllama, f32 } from './helpers.mjs';

const API_KEY = 'test-key-0123456789-not-the-placeholder';
const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.LIFECONTEXT_API_KEY = API_KEY;
process.env.OLLAMA_BASE_URL = fake.baseUrl;
process.env.PORT = '0'; // ephemeral port — avoids collisions with a real running server
process.env.RATE_LIMIT_MAX = '10000'; // #327: this file's ~100 HTTP calls share one apiLimiter instance
// #169: this file exercises the UNSET (UI DISABLED) path; the token-only enabled path is covered in
// ui-token.test.mjs (a child server with it set). Empty string, NOT `delete` (#358) — config.js
// calls dotenv.config(), which only skips variables already SET, so deleting this frees dotenv to
// reload it from a real .env and the UI mounts after all. `''` is set, and config.js normalizes it
// to undefined, so the disabled path is genuinely what runs.
process.env.UI_URL_TOKEN = '';
// Real on-disk photo store: the /entities/photos + /:id/photo routes existence-check files (#112),
// so contact photos in these tests must be real files under CONTACTS_RAW_DIR. Set before the app
// import — server.js resolves CONTACT_PHOTO_DIR from CONTACTS_RAW_DIR at load.
const rawDir = mkdtempSync(path.join(tmpdir(), 'lc-server-raw-'));
process.env.CONTACTS_RAW_DIR = rawDir;
const writePhoto = (name) => { const p = path.join(rawDir, name); writeFileSync(p, 'img-bytes'); return p; };

const { app, serverInstance, secureCompare, addRelationship, resolveEntityRef, executeStore, StoreTypeSchema, OccurredAtSchema } = await import('../src/server.js');
const { db, insertEntityStmt, insertAliasStmt, storeArtifactTxn, upsertEntityRelation, proposeEntity, rejectProposedEntity, approveProposedEntity, listProposedEntities, clearDuplicateDismissals, countDuplicateDismissals, listProbableDuplicates } = await import('../src/db.js');
const { embedToFloat32 } = await import('../src/embeddings.js');
const { timeline, localDate } = await import('../src/search.js');

if (!serverInstance.listening) await once(serverInstance, 'listening');
const { port } = serverInstance.address();
const base = `http://127.0.0.1:${port}`;

after(async () => {
  // fetch (undici) keeps sockets alive; drop them so serverInstance.close() resolves promptly
  // instead of waiting out undici's keep-alive timeout.
  serverInstance.closeAllConnections?.();
  await new Promise((resolve) => serverInstance.close(resolve));
  db.close();
  await fake.close();
  cleanup();
  rmSync(rawDir, { recursive: true, force: true });
});

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });

test('secureCompare: rejects non-strings and mismatches, accepts an exact match', () => {
  assert.equal(secureCompare(undefined, API_KEY), false);
  assert.equal(secureCompare(['a'], API_KEY), false); // duplicated ?api_key= yields an array
  assert.equal(secureCompare('wrong', API_KEY), false);
  assert.equal(secureCompare(API_KEY, API_KEY), true);
});

test('auth gate: 401 without a key, 401 with a wrong key, 200 with the right key', async () => {
  assert.equal((await post('/api/remember', { content: 'x' })).status, 401);
  assert.equal((await post('/api/remember', { content: 'x' }, { 'x-api-key': 'nope' })).status, 401);
  const ok = await post('/api/remember', { content: 'auth check note' }, { 'x-api-key': API_KEY });
  assert.equal(ok.status, 200);
});

test('store -> recall round-trip returns the memory with a distance', async () => {
  const stored = await post('/api/remember', { content: 'the smoke test memory about otters' }, { 'x-api-key': API_KEY });
  assert.equal(stored.status, 200);
  const { success, id } = await stored.json();
  assert.equal(success, true);
  assert.ok(Number.isInteger(id));

  const recalled = await post('/api/recall', { query: 'otters' }, { 'x-api-key': API_KEY });
  assert.equal(recalled.status, 200);
  const { results } = await recalled.json();
  assert.ok(Array.isArray(results) && results.length >= 1, 'recall returns at least one result');
  const match = results.find((r) => r.content === 'the smoke test memory about otters');
  assert.ok(match, 'the stored memory is recalled');
  // The row is within the KNN k (few rows, k>=50), so the vector arm populates a real distance —
  // assert its type, not mere key presence (which is always true from executeRecall's mapping).
  assert.equal(typeof match.distance, 'number', 'recall result carries a numeric distance');
});

test('UI (#169): with UI_URL_TOKEN unset, the UI is DISABLED — no open /ui mount anywhere', async () => {
  // Secure-by-default: no token set → no UI mount at all, so /ui/* and /<anything>/ui/* all 404. A
  // tunnel can therefore expose nothing without an explicit token. The token-only enabled path
  // (bare /ui 404, /<token>/ui/ 200) is verified in ui-token.test.mjs against a server booted with
  // UI_URL_TOKEN set (config is read once at import, so it needs its own process).
  // Assert the PRECONDITION first (#358). The three 404s below all 404 whether or not a token is
  // set — with one set the UI mounts at /<that-token>/ui/, a path this test never probes — so they
  // passed happily while the disabled path went untested on any machine with a .env. Checking the
  // resolved config is what makes this test capable of failing for the right reason.
  const { UI_URL_TOKEN } = await import('../src/config.js');
  assert.equal(UI_URL_TOKEN, undefined, 'precondition: no UI token resolved, so no UI is mounted at all');
  assert.equal((await get('/ui/chat.html')).status, 404, 'bare /ui/chat.html 404s when the token is unset');
  assert.equal((await get('/ui/style.css')).status, 404, 'a bare /ui asset 404s when the token is unset');
  assert.equal((await get('/anything/ui/chat.html')).status, 404, 'a tokened-shaped path 404s when the token is unset');
});

test('/api/search: filter-then-rank path (planner + prefiltered KNN/FTS) returns typed results', async () => {
  // Exercises the hybrid path the legacy recall skips: usePlanner:true -> parseQuery hits the fake
  // /chat/completions, and types:['note'] drives the SQL prefilter + the IN-constrained
  // knnInStmt/ftsInStmt (filter-then-rank) — the bulk of search.js.
  await post('/api/remember', { content: 'a field note about penguins in antarctica' }, { 'x-api-key': API_KEY });
  const res = await post('/api/search', { query: 'penguins', types: ['note'], limit: 5 }, { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.ok(Array.isArray(results) && results.length >= 1, 'search returns results');
  assert.ok(results.every((r) => r.type === 'note'), 'the type filter is applied via the SQL prefilter');
  assert.ok(results.some((r) => /penguins/.test(r.text_repr)), 'the matching artifact is returned');
});

test('/api/search: response carries an additive `summary` reflecting the FULL matched set, independent of limit (#353)', async () => {
  // Two runs: a 2-day contiguous span + a separate later date — same shape search.test.mjs's
  // hybridSearch-level regression test covers; this only proves the REST plumbing threads
  // hybridSearch's summary property through into the JSON response.
  const uniqueTag = 'zzz353uniquetag';
  const dates = ['2025-01-01', '2025-01-02', '2025-03-01'];
  for (const [i, d] of dates.entries()) {
    const text = `${uniqueTag} photo taken ${d}`;
    const vec = await embedToFloat32(text);
    storeArtifactTxn({ type: 'photo', source: '353rest', source_id: `p-${i}`, text_repr: text, occurred_at: d, place_label: 'Testville, Testland' }, vec, []);
  }

  const narrow = await post('/api/search', { query: uniqueTag, types: ['photo'], limit: 1 }, { 'x-api-key': API_KEY });
  assert.equal(narrow.status, 200);
  const narrowBody = await narrow.json();
  assert.equal(narrowBody.results.length, 1, 'the returned page is capped at the requested limit');
  assert.ok(narrowBody.summary, 'summary is additive — present alongside results, existing clients reading only results are unaffected');
  assert.equal(narrowBody.summary.total, 3, 'total reflects the full matched set, not the limited page (1)');
  assert.equal(narrowBody.summary.runs.length, 2, 'two runs: a 2-day contiguous span and a separate later date');

  const wide = await post('/api/search', { query: uniqueTag, types: ['photo'], limit: 10 }, { 'x-api-key': API_KEY });
  const wideBody = await wide.json();
  assert.equal(wideBody.results.length, 3);
  assert.equal(wideBody.summary.total, 3, 'total is unchanged at a wider limit — independent of limit at two different values');
});

test('/api/search: near + radius_km geo-filters by coordinate (#68)', async () => {
  // Two coord-bearing photos ~4100km apart; a `near` search with a tight radius must return only
  // the one inside the circle. Stored straight through storeArtifactTxn (the fake Ollama embeds)
  // since /api/remember only makes coordinate-less notes.
  const sfVec = await embedToFloat32('a sunny afternoon photo by the bay');
  const nyVec = await embedToFloat32('a rainy afternoon photo in the city');
  const sf = storeArtifactTxn({ type: 'photo', source: 'geo-test', source_id: 'sf', text_repr: 'a sunny afternoon photo by the bay', latitude: 37.7749, longitude: -122.4194, place_label: 'San Francisco, CA' }, sfVec, []);
  const ny = storeArtifactTxn({ type: 'photo', source: 'geo-test', source_id: 'ny', text_repr: 'a rainy afternoon photo in the city', latitude: 40.7128, longitude: -74.006, place_label: 'New York, NY' }, nyVec, []);

  const byName = await post('/api/search', { query: 'afternoon photo', near: 'San Francisco', radius_km: 50, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(byName.status, 200);
  const nameIds = (await byName.json()).results.map((r) => r.id);
  assert.ok(nameIds.includes(sf.id), 'the SF photo is within 50km of San Francisco');
  assert.ok(!nameIds.includes(ny.id), 'the NY photo is excluded by the radius');

  // Omitting radius_km falls back to GEO_RADIUS_DEFAULT_KM (25km): SF stays in, NY (~4100km) out.
  const byDefault = await post('/api/search', { query: 'afternoon photo', near: 'San Francisco', limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(byDefault.status, 200);
  const defaultIds = (await byDefault.json()).results.map((r) => r.id);
  assert.ok(defaultIds.includes(sf.id) && !defaultIds.includes(ny.id), 'default radius keeps SF and still excludes NY');

  // An absurd radius_km is clamped to GEO_RADIUS_MAX_KM (500km), so NY (~4100km away) stays excluded.
  const clamped = await post('/api/search', { query: 'afternoon photo', near: 'San Francisco', radius_km: 999999, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(clamped.status, 200);
  const clampedIds = (await clamped.json()).results.map((r) => r.id);
  assert.ok(clampedIds.includes(sf.id) && !clampedIds.includes(ny.id), 'radius_km is clamped to the max; NY stays excluded');

  const byCoord = await post('/api/search', { query: 'afternoon photo', near: { lat: 40.71, lon: -74.0 }, radius_km: 50, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(byCoord.status, 200);
  const coordIds = (await byCoord.json()).results.map((r) => r.id);
  assert.ok(coordIds.includes(ny.id) && !coordIds.includes(sf.id), 'explicit {lat,lon} filters to NY');

  // Demote-never-drop: an unresolvable place name must not empty the search.
  const bogus = await post('/api/search', { query: 'afternoon photo', near: 'Xyzzyville Nowhere Land', limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(bogus.status, 200);
  assert.ok((await bogus.json()).results.length > 0, 'an unresolvable near folds into search text, not an empty result');

  // Out-of-range explicit coordinates are rejected at the schema (400), not silently ignored.
  const badCoord = await post('/api/search', { query: 'afternoon photo', near: { lat: 999, lon: 999 } }, { 'x-api-key': API_KEY });
  assert.equal(badCoord.status, 400, 'garbage coordinates 400 rather than disabling the filter silently');

  // A whitespace-only place name is rejected at the schema (trim().min(1)), not a silent no-op.
  const blankNear = await post('/api/search', { query: 'afternoon photo', near: '   ' }, { 'x-api-key': API_KEY });
  assert.equal(blankNear.status, 400, 'whitespace-only near is rejected rather than silently ignored');
});

test('/api/search: geo_required and sort are honored as caller opts (#190, #238)', async () => {
  // Caller-supplied geo_required/sort must reach hybridSearch the same way types/near/radius_km
  // already do — search.test.mjs covers hybridSearch's own geo_required/sort behavior in depth;
  // this only proves the REST plumbing actually passes them through.
  const geoVec = await embedToFloat32('a geo-required-test artifact with coordinates');
  const plainVec = await embedToFloat32('a geo-required-test artifact with no coordinates');
  const geotagged = storeArtifactTxn({ type: 'note', source: 'geo-required-test', source_id: 'geo', text_repr: 'a geo-required-test artifact with coordinates', latitude: 51.5074, longitude: -0.1278, place_label: 'London, England' }, geoVec, []);
  const untagged = storeArtifactTxn({ type: 'note', source: 'geo-required-test', source_id: 'plain', text_repr: 'a geo-required-test artifact with no coordinates' }, plainVec, []);

  const filtered = await post('/api/search', { query: 'geo-required-test artifact', geo_required: true, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(filtered.status, 200);
  const filteredIds = (await filtered.json()).results.map((r) => r.id);
  assert.ok(filteredIds.includes(geotagged.id), 'geo_required:true keeps the geotagged artifact');
  assert.ok(!filteredIds.includes(untagged.id), 'geo_required:true excludes the non-geotagged artifact');

  const recent = await post('/api/search', { query: 'geo-required-test artifact', sort: 'recent', limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(recent.status, 200);
  const recentIds = (await recent.json()).results.map((r) => r.id);
  const geoPos = recentIds.indexOf(geotagged.id);
  const plainPos = recentIds.indexOf(untagged.id);
  assert.ok(geoPos !== -1 && plainPos !== -1, 'both artifacts are returned under sort:recent');
  assert.ok(plainPos < geoPos, 'sort:recent orders by occurred_at DESC (the later-inserted artifact first)');

  const bad = await post('/api/search', { query: 'x', sort: 'bogus' }, { 'x-api-key': API_KEY });
  assert.equal(bad.status, 400, 'an invalid sort value is rejected at the schema');
});

test('/api/search: use_planner (#433) — false skips the planner chat call, omitted still calls it once, non-boolean 400s', async () => {
  const vec = await embedToFloat32('a use-planner-test artifact for the x-agent-preference marker');
  const stored = storeArtifactTxn({ type: 'x-agent-preference', source: 'use-planner-test', source_id: 'up-1', text_repr: 'a use-planner-test artifact for the x-agent-preference marker' }, vec, []);

  // Pin the actual new behavior (a chat-count delta), not just the result shape — dropping the
  // usePlanner/lexicalWhenSkipped wiring in src/server.js would otherwise leave both cases green.
  let chatBefore = fake.counts.chat;
  const skip = await post('/api/search', { query: 'use-planner-test artifact', types: ['x-agent-preference'], use_planner: false, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(skip.status, 200);
  assert.equal(fake.counts.chat, chatBefore, 'use_planner:false makes no planner chat call');
  const skipBody = await skip.json();
  assert.ok(Array.isArray(skipBody.results), 'use_planner:false still returns a `results` array');
  assert.ok(skipBody.results.some((r) => r.id === stored.id), 'use_planner:false still returns the matching row');

  chatBefore = fake.counts.chat;
  const omitted = await post('/api/search', { query: 'use-planner-test artifact', types: ['x-agent-preference'], limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(omitted.status, 200);
  assert.equal(fake.counts.chat, chatBefore + 1, 'omitting use_planner still calls the planner exactly once (default unchanged)');
  const omittedBody = await omitted.json();
  assert.ok(omittedBody.results.some((r) => r.id === stored.id), 'omitting use_planner still returns the matching row (planner-on by default)');

  const bad = await post('/api/search', { query: 'x', use_planner: 'nope' }, { 'x-api-key': API_KEY });
  assert.equal(bad.status, 400, 'a non-boolean use_planner is rejected at the schema');
});

test('/api/v1/entities/duplicates + /api/v1/entities/merge (#75): surfaces, merges, and rejects bad merges', async () => {
  // Two entities sharing a phone number — the residue contacts.js's own auto-merge (email/exact
  // name only) never catches, and exactly the gap list_probable_duplicates exists to surface.
  const a = Number(insertEntityStmt.run('person', 'REST Dup One', JSON.stringify({ phones: ['5559990001'] })).lastInsertRowid);
  const b = Number(insertEntityStmt.run('person', 'REST Dup Two', JSON.stringify({ phones: ['5559990001'] })).lastInsertRowid);
  insertAliasStmt.run(a, 'rest dup one', 'name');
  insertAliasStmt.run(b, 'rest dup two', 'name');

  const dupRes = await get('/api/v1/entities/duplicates?limit=50', { 'x-api-key': API_KEY });
  assert.equal(dupRes.status, 200);
  const { pairs } = await dupRes.json();
  const found = pairs.find((p) => [p.a.id, p.b.id].includes(a) && [p.a.id, p.b.id].includes(b));
  assert.ok(found, 'the shared-phone pair is surfaced over REST');
  // #404: per-side email/phone/link counts ride along over REST.
  const side = found.a.id === a ? found.a : found.b;
  assert.equal(side.phone_count, 1);
  assert.equal(side.email_count, 0);
  assert.equal(typeof side.link_count, 'number');

  const mergeRes = await post('/api/v1/entities/merge', { keep_id: a, absorb_id: b }, { 'x-api-key': API_KEY });
  assert.equal(mergeRes.status, 200);
  const merged = await mergeRes.json();
  assert.equal(merged.merged, true);
  assert.equal(merged.absorb_id, b);

  const selfRes = await post('/api/v1/entities/merge', { keep_id: a, absorb_id: a }, { 'x-api-key': API_KEY });
  assert.equal(selfRes.status, 422, 'self-merge is rejected');

  const reMergeRes = await post('/api/v1/entities/merge', { keep_id: a, absorb_id: b }, { 'x-api-key': API_KEY });
  assert.equal(reMergeRes.status, 404, 're-merging an already-tombstoned entity is rejected');
});

// #303: the manual-merge form's whole premise is that /merge has no dependency on detection — a
// user names two contacts the detector never paired (here: kind='org', which listProbableDuplicates
// filters out entirely via listLivePersonEntitiesStmt) and merges them directly. Minimal HTTP calls
// (this file shares one apiLimiter budget with every other test here, see #327).
test('#303 manual merge: an org pair the detector never surfaces still merges via POST /merge', async () => {
  const a = Number(insertEntityStmt.run('org', 'Acme Manual Merge Co', JSON.stringify({})).lastInsertRowid);
  const b = Number(insertEntityStmt.run('org', 'Zephyr Unrelated Corp', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(a, 'acme manual merge co', 'name');
  insertAliasStmt.run(b, 'zephyr unrelated corp', 'name');

  assert.ok(!listProbableDuplicates(100).some((p) => [p.a.id, p.b.id].includes(a) || [p.a.id, p.b.id].includes(b)), 'org entities are never surfaced by the person-only detector');

  const mergeRes = await post('/api/v1/entities/merge', { keep_id: a, absorb_id: b }, { 'x-api-key': API_KEY });
  assert.equal(mergeRes.status, 200);
  const merged = await mergeRes.json();
  assert.equal(merged.merged, true);
  assert.equal(merged.absorb_id, b);
});

// This file's apiLimiter budget (100 req/60s) is shared with every other test here and is already
// close to its ceiling — adding even a handful of HTTP calls can 429 an unrelated, unmodified test
// elsewhere in the file (see #302's PR discussion). So this stays to 2 HTTP calls (one happy path
// per new route). Auth-gating on both routes is the same requireAuth middleware already exercised
// by dozens of other routes in this file, so it isn't re-verified over HTTP here; the full behavior
// matrix (401/404/422/400, idempotency, pre-slice ordering) lives in test/db.test.mjs.
test('#302 dismiss + clear-all REST smoke: dismiss suppresses + counts; clear restores + resets the count', async () => {
  clearDuplicateDismissals(); // this file shares one temp DB across tests — start from a known count
  const a = Number(insertEntityStmt.run('person', 'REST Dismiss One', JSON.stringify({ phones: ['5559990002'] })).lastInsertRowid);
  const b = Number(insertEntityStmt.run('person', 'REST Dismiss Two', JSON.stringify({ phones: ['5559990002'] })).lastInsertRowid);
  insertAliasStmt.run(a, 'rest dismiss one', 'name');
  insertAliasStmt.run(b, 'rest dismiss two', 'name');

  const dismissRes = await post('/api/v1/entities/duplicates/dismiss', { a_id: a, b_id: b, score: 0.9, reason: 'shared phone' }, { 'x-api-key': API_KEY });
  assert.equal(dismissRes.status, 200);
  assert.deepEqual(await dismissRes.json(), { dismissed: true, created: true });
  assert.equal(countDuplicateDismissals(), 1);
  assert.ok(!listProbableDuplicates(50).some((p) => [p.a.id, p.b.id].includes(a) && [p.a.id, p.b.id].includes(b)), 'the dismissed pair no longer surfaces');

  const clearRes = await fetch(`${base}/api/v1/entities/duplicates/dismissals`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
  assert.equal(clearRes.status, 200);
  assert.deepEqual(await clearRes.json(), { cleared: 1 });
  assert.equal(countDuplicateDismissals(), 0);
});

test('/api/v1/entities/photos (#84): only photographed live person entities, for face-worker reference matching', async () => {
  const importedPath = writePhoto('rest-photo.jpg');
  const photographed = Number(insertEntityStmt.run('person', 'REST Photo Person', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(photographed, 'rest photo person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'rest-photo-test', source_id: `contact-${photographed}`, text_repr: 'REST Photo Person contact card', raw_path: importedPath },
    f32(0.5),
    [{ entity_id: photographed, role: 'self', confidence: 1.0 }],
  );
  const noPhoto = Number(insertEntityStmt.run('person', 'REST No Photo Person', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(noPhoto, 'rest no photo person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'rest-photo-test', source_id: `contact-${noPhoto}`, text_repr: 'REST No Photo Person contact card' },
    f32(0.5),
    [{ entity_id: noPhoto, role: 'self', confidence: 1.0 }],
  );

  const res = await get('/api/v1/entities/photos?limit=50', { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const { contacts } = await res.json();
  const found = contacts.find((c) => c.entity_id === photographed);
  assert.ok(found, 'the photographed contact is returned');
  assert.equal(found.raw_path, importedPath);
  assert.ok(!contacts.some((c) => c.entity_id === noPhoto), 'a contact with no preserved photo is excluded');
});

test('/api/v1/entities/photos (#112): honors the uploaded-photo precedence for face matching', async () => {
  // (a) uploaded-only — attrs.photoFile set, NO imported raw_path. Pre-#112 this was dropped
  // (WHERE raw_path IS NOT NULL); it must now appear with the uploaded file (the core bug).
  const uploadedFile = writePhoto('uploaded-only.jpg');
  const uploadedOnly = Number(insertEntityStmt.run('person', 'Uploaded Only Person', JSON.stringify({ photoFile: 'uploaded-only.jpg' })).lastInsertRowid);
  insertAliasStmt.run(uploadedOnly, 'uploaded only person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'prec-test', source_id: `contact-${uploadedOnly}`, text_repr: 'Uploaded Only Person contact card' },
    f32(0.5), [{ entity_id: uploadedOnly, role: 'self', confidence: 1.0 }],
  );
  // (b) both — uploaded override wins over the imported vCard photo.
  const bothUpload = writePhoto('both-upload.jpg');
  const bothImport = writePhoto('both-import.jpg');
  const both = Number(insertEntityStmt.run('person', 'Both Photos Person', JSON.stringify({ photoFile: 'both-upload.jpg' })).lastInsertRowid);
  insertAliasStmt.run(both, 'both photos person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'prec-test', source_id: `contact-${both}`, text_repr: 'Both Photos Person contact card', raw_path: bothImport },
    f32(0.5), [{ entity_id: both, role: 'self', confidence: 1.0 }],
  );
  // (c) missing uploaded file on disk → fall back to the imported photo (mirrors the UI route).
  const fallbackImport = writePhoto('fallback-import.jpg');
  const fallback = Number(insertEntityStmt.run('person', 'Fallback Person', JSON.stringify({ photoFile: 'ghost-missing.jpg' })).lastInsertRowid);
  insertAliasStmt.run(fallback, 'fallback person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'prec-test', source_id: `contact-${fallback}`, text_repr: 'Fallback Person contact card', raw_path: fallbackImport },
    f32(0.5), [{ entity_id: fallback, role: 'self', confidence: 1.0 }],
  );

  const res = await get('/api/v1/entities/photos?limit=200', { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const { contacts } = await res.json();
  const byId = new Map(contacts.map((c) => [c.entity_id, c]));
  assert.equal(byId.get(uploadedOnly)?.raw_path, uploadedFile, 'uploaded-only contact appears with the uploaded file');
  assert.equal(byId.get(both)?.raw_path, bothUpload, 'uploaded override wins over imported');
  assert.equal(byId.get(fallback)?.raw_path, fallbackImport, 'missing uploaded file falls back to imported');
  // Wire contract unchanged: every entry is { entity_id, name, raw_path } with an absolute path.
  for (const c of contacts) {
    assert.ok(typeof c.entity_id === 'number' && typeof c.name === 'string' && path.isAbsolute(c.raw_path),
      'each entry is {entity_id, name, absolute raw_path}');
  }
});

test('/api/about_entity (#88): an org carries its employees in relations_in (reverse worksAt edge)', async () => {
  const org = Number(insertEntityStmt.run('org', 'Acme REST Corp', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(org, 'acme rest corp', 'name');
  const person = Number(insertEntityStmt.run('person', 'Dana Employee', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(person, 'dana employee', 'name');
  upsertEntityRelation({ from_entity_id: person, to_entity_id: org, relation_type: 'worksAt', raw_label: 'worksAt', source: 'test' });

  const res = await post('/api/about_entity', { name: 'Acme REST Corp' }, { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const body = await res.json();
  const e = body.entities.find((x) => x.entity.id === org);
  assert.ok(e, 'the org resolves');
  assert.ok(e.relations_in.some((r) => r.relation_type === 'worksAt' && r.name === 'Dana Employee'), 'relations_in lists the employee');
  assert.equal(e.relations.length, 0, 'the org has no outgoing edges');
});

test('#119 proposed entities: ingest→propose→approve links the artifact; re-approve 409', async () => {
  const ing = await post('/api/v1/ingest', { source: 'documents', source_id: 'srv-receipt', type: 'document', text_repr: 'ProbeCo invoice total 12.00', entity_hints: [{ alias: 'ProbeCo', alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }] }, { 'x-api-key': API_KEY });
  assert.ok(ing.status === 201 || ing.status === 200, 'ingest accepted');

  let r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  assert.equal(r.status, 200);
  const prop = (await r.json()).proposals.find((p) => p.suggested_name === 'ProbeCo');
  assert.ok(prop && prop.suggested_kind === 'org', 'ProbeCo staged as a pending org proposal');
  assert.equal(typeof prop.evidence_count, 'number', '#472: evidence_count survives REST JSON serialization as a number');

  let ab = await (await post('/api/about_entity', { name: 'ProbeCo' }, { 'x-api-key': API_KEY })).json();
  assert.equal(ab.resolved, false, 'no entity before approval');

  r = await fetch(`${base}/api/v1/entities/proposed/${prop.id}/approve`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(r.status, 200);
  assert.ok(Number.isInteger((await r.json()).entity_id));

  ab = await (await post('/api/about_entity', { name: 'ProbeCo' }, { 'x-api-key': API_KEY })).json();
  assert.equal(ab.resolved, true, 'entity created on approve');
  assert.ok(ab.entities[0].artifacts.length >= 1, 'origin artifact retroactively linked');

  const again = await fetch(`${base}/api/v1/entities/proposed/${prop.id}/approve`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(again.status, 409, 'already-approved proposal is 409');
});

test('#119 proposed entities: reject retains + auth-gated; no-suggested_kind hint stages nothing', async () => {
  await post('/api/v1/ingest', { source: 'documents', source_id: 'srv-spam', type: 'document', text_repr: 'JunkCo promo blast', entity_hints: [{ alias: 'JunkCo', alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }] }, { 'x-api-key': API_KEY });
  let r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  const prop = (await r.json()).proposals.find((p) => p.suggested_name === 'JunkCo');
  assert.ok(prop, 'JunkCo staged');

  assert.equal((await fetch(`${base}/api/v1/entities/proposed/${prop.id}/reject`, { method: 'POST' })).status, 401, 'reject is auth-gated');

  r = await fetch(`${base}/api/v1/entities/proposed/${prop.id}/reject`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(r.status, 200);
  r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  assert.equal((await r.json()).proposals.some((p) => p.suggested_name === 'JunkCo'), false, 'rejected leaves the pending queue');
  r = await get('/api/v1/entities/proposed?status=rejected', { 'x-api-key': API_KEY });
  assert.ok((await r.json()).proposals.some((p) => p.suggested_name === 'JunkCo'), 'rejected proposal retained');

  // a hint WITHOUT suggested_kind must not stage anything
  await post('/api/v1/ingest', { source: 'documents', source_id: 'srv-plain', type: 'document', text_repr: 'PlainCo memo', entity_hints: [{ alias: 'PlainCo', alias_type: 'name', role: 'mentioned' }] }, { 'x-api-key': API_KEY });
  r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  assert.equal((await r.json()).proposals.some((p) => p.suggested_name === 'PlainCo'), false, 'no proposal without suggested_kind');
});

// Fixtures are staged/rejected/approved directly against db.js (bypassing HTTP) so these tests don't
// eat into the shared apiLimiter budget (100 req/60s across the whole file) for setup — only the
// actual reopen-route behavior needs to go over HTTP.
test('#300 reopen (single): rejected → pending; 409 on pending/approved; 404 unknown; 401 without key', async () => {
  const { id: propId } = proposeEntity({ suggested_kind: 'org', name: 'ReopenSingle Co', alias: 'reopensingle co', alias_type: 'name' });

  assert.equal((await fetch(`${base}/api/v1/entities/proposed/${propId}/reopen`, { method: 'POST' })).status, 401, 'reopen is auth-gated');
  assert.equal((await fetch(`${base}/api/v1/entities/proposed/${propId}/reopen`, { method: 'POST', headers: { 'x-api-key': API_KEY } })).status, 409, 'reopening a still-pending proposal is 409');

  rejectProposedEntity(propId);
  const r = await fetch(`${base}/api/v1/entities/proposed/${propId}/reopen`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { reopened: true });
  assert.ok(listProposedEntities('pending', 1000).some((p) => p.id === propId), 'back in the pending queue');

  approveProposedEntity(propId);
  assert.equal((await fetch(`${base}/api/v1/entities/proposed/${propId}/reopen`, { method: 'POST', headers: { 'x-api-key': API_KEY } })).status, 409, 'reopening an approved proposal is 409');
  assert.equal((await fetch(`${base}/api/v1/entities/proposed/999999999/reopen`, { method: 'POST', headers: { 'x-api-key': API_KEY } })).status, 404, 'unknown id is 404');
});

test('#300 reopen (bulk): mixed ids isolate per-item; empty/oversized ids array is 400', async () => {
  const stageAndReject = (name) => {
    const { id } = proposeEntity({ suggested_kind: 'org', name, alias: name.toLowerCase(), alias_type: 'name' });
    rejectProposedEntity(id);
    return id;
  };
  const idA = stageAndReject('BulkReopenA Co');
  const idB = stageAndReject('BulkReopenB Co');

  const r = await post('/api/v1/entities/proposed/reopen', { ids: [idA, idB, 999999999] }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reopened, 2, 'the two good ids reopened despite the bad one in the batch');
  const byId = Object.fromEntries(body.results.map((x) => [x.id, x]));
  assert.equal(byId[idA].reopened, true);
  assert.equal(byId[idB].reopened, true);
  assert.equal(byId[999999999].error, 'NOT_FOUND');

  assert.equal((await post('/api/v1/entities/proposed/reopen', { ids: [] }, { 'x-api-key': API_KEY })).status, 400, 'empty ids array is 400');
  const tooMany = Array.from({ length: 201 }, (_, i) => i + 1);
  assert.equal((await post('/api/v1/entities/proposed/reopen', { ids: tooMany }, { 'x-api-key': API_KEY })).status, 400, '201 ids is 400');
});

test('#232 propose_entity: agent-staged person proposal is idempotent, auth-gated, then approvable', async () => {
  assert.equal((await post('/api/v1/entities/proposed', { kind: 'person', name: 'Jane Broker' })).status, 401, 'propose is auth-gated');

  let r = await post('/api/v1/entities/proposed', { kind: 'person', name: 'Jane Broker' }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 201, 'new proposal → 201');
  const staged = await r.json();
  assert.deepEqual({ proposed: staged.proposed, status: staged.status }, { proposed: true, status: 'pending' });
  assert.ok(Number.isInteger(staged.id));

  // defaulted alias=(name,'name'); appears in the same review queue the UI reads
  r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  const p = (await r.json()).proposals.find((x) => x.suggested_name === 'Jane Broker');
  assert.ok(p && p.alias === 'jane broker' && p.alias_type === 'name' && p.source === 'mcp-proposal', 'staged with defaulted, normalized name alias + agent source');

  // the external write earns an audit row (the internal hint path stays silent — logged by its own summary)
  const logged = db.prepare(`SELECT COUNT(*) AS n FROM ingest_log WHERE event_type = 'proposed_entity_staged' AND details LIKE '%Jane Broker%'`).get();
  assert.equal(logged.n, 1, 'one proposed_entity_staged ingest_log row for the fresh external stage');

  // re-proposing the identical (name, alias, alias_type) is a no-op returning the same id
  r = await post('/api/v1/entities/proposed', { kind: 'person', name: 'Jane Broker' }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 200, 'duplicate → 200');
  const dup = await r.json();
  assert.deepEqual({ id: dup.id, proposed: dup.proposed, status: dup.status }, { id: staged.id, proposed: false, status: 'pending' });

  // approval mints the entity (nothing was created before) and it resolves by name
  assert.equal((await (await post('/api/about_entity', { name: 'Jane Broker' }, { 'x-api-key': API_KEY })).json()).resolved, false, 'no entity before approval');
  r = await fetch(`${base}/api/v1/entities/proposed/${staged.id}/approve`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(r.status, 200);
  const ab = await (await post('/api/about_entity', { name: 'Jane Broker' }, { 'x-api-key': API_KEY })).json();
  assert.equal(ab.resolved, true, 'entity created on approve');
});

test('#232 propose_entity: org proposal approves with kind=org and full name preserved', async () => {
  const r = await post('/api/v1/entities/proposed', { kind: 'org', name: 'Acme Insurance' }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.equal((await fetch(`${base}/api/v1/entities/proposed/${id}/approve`, { method: 'POST', headers: { 'x-api-key': API_KEY } })).status, 200);

  const ab = await (await post('/api/about_entity', { name: 'Acme Insurance' }, { 'x-api-key': API_KEY })).json();
  assert.equal(ab.resolved, true, 'org entity created on approve');
  assert.equal(ab.entities[0].entity.kind, 'org', 'created as kind=org (no first/last reduction)');
  assert.equal(ab.entities[0].entity.canonical_name, 'Acme Insurance', 'full org name preserved');

  // a supplied alias without its type is rejected by the schema
  assert.equal((await post('/api/v1/entities/proposed', { kind: 'person', name: 'No Type', alias: 'x@y.com' }, { 'x-api-key': API_KEY })).status, 400, 'alias without alias_type → 400');
});

test('#234 add_relationship: links by name, directional, idempotent; errors leave no edge', async () => {
  const person = Number(insertEntityStmt.run('person', 'Rel Person', '{}').lastInsertRowid);
  const org = Number(insertEntityStmt.run('org', 'Rel Org', '{}').lastInsertRowid);
  insertAliasStmt.run(person, 'rel person', 'name');
  insertAliasStmt.run(org, 'rel org', 'name');

  const res = addRelationship({ from: 'Rel Person', to: 'Rel Org', relation_type: 'worksAt' });
  assert.deepEqual({ added: res.added, type: res.relation_type, from: res.from, to: res.to }, { added: true, type: 'worksAt', from: 'Rel Person', to: 'Rel Org' });

  // directional: worksAt shows outgoing on the person, incoming (relations_in) on the org
  const abP = await (await post('/api/about_entity', { name: 'Rel Person' }, { 'x-api-key': API_KEY })).json();
  assert.ok(abP.entities[0].relations.some((r) => r.relation_type === 'worksAt' && r.name === 'Rel Org'), 'person → worksAt → org');
  const abO = await (await post('/api/about_entity', { name: 'Rel Org' }, { 'x-api-key': API_KEY })).json();
  assert.ok(abO.entities[0].relations_in.some((r) => r.relation_type === 'worksAt' && r.name === 'Rel Person'), 'org referenced-by the person');

  // idempotent: same triple is a no-op
  assert.equal(addRelationship({ from: 'Rel Person', to: 'Rel Org', relation_type: 'worksAt' }).added, false, 're-add is a no-op');

  // by numeric id + a free-text raw_label (→ canonical 'custom')
  assert.equal(addRelationship({ from: person, to: org, raw_label: 'advisor' }).relation_type, 'custom', 'raw_label maps to custom');

  // error cases throw typed codes and write NOTHING new (row count is unchanged across all throws)
  const countRels = () => db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get().n;
  const before = countRels();
  assert.throws(() => addRelationship({ from: 'Rel Person', to: 'Rel Person', relation_type: 'friend' }), (e) => e.code === 'SELF_LOOP');
  assert.throws(() => addRelationship({ from: 'Rel Person', to: 'Rel Org' }), (e) => e.code === 'MISSING_TYPE');
  assert.throws(() => addRelationship({ from: 'Rel Person', to: 'Rel Org', relation_type: '   ' }), (e) => e.code === 'MISSING_TYPE'); // whitespace-only → missing
  assert.throws(() => addRelationship({ from: 'Nobody Here At All', to: 'Rel Org', relation_type: 'friend' }), (e) => e.code === 'NOT_FOUND');
  assert.equal(countRels(), before, 'no edge written by any error case');
});

test('#482 POST /api/v1/entities/:id/relations: 404 (not 500) for a nonexistent from-side or to-side id', async () => {
  const org = Number(insertEntityStmt.run('org', 'Relations Route Org', '{}').lastInsertRowid);
  const bogus = 999999;

  // org is a valid to_entity_id here, so this 404 can only come from the NEW from-side check.
  const fromMissing = await post(`/api/v1/entities/${bogus}/relations`, { to_entity_id: org, relation_type: 'worksAt' }, { 'x-api-key': API_KEY });
  assert.equal(fromMissing.status, 404);
  assert.equal((await fromMissing.json()).error, `entity ${bogus} not found`);

  const toMissing = await post(`/api/v1/entities/${org}/relations`, { to_entity_id: bogus, relation_type: 'worksAt' }, { 'x-api-key': API_KEY });
  assert.equal(toMissing.status, 404);
  assert.equal((await toMissing.json()).error, `entity ${bogus} not found`);

  // both sides missing: proves the from-side check runs FIRST (names bogus, not bogus + 1)
  const bothMissing = await post(`/api/v1/entities/${bogus}/relations`, { to_entity_id: bogus + 1, relation_type: 'worksAt' }, { 'x-api-key': API_KEY });
  assert.equal(bothMissing.status, 404);
  assert.equal((await bothMissing.json()).error, `entity ${bogus} not found`, 'from-side is checked first');

  const countRels = () => db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get().n;
  const before = countRels();
  const person = Number(insertEntityStmt.run('person', 'Relations Route Person', '{}').lastInsertRowid);
  const ok = await post(`/api/v1/entities/${person}/relations`, { to_entity_id: org, relation_type: 'worksAt' }, { 'x-api-key': API_KEY });
  assert.equal(ok.status, 200, 'a valid pair still succeeds');
  assert.equal(countRels(), before + 1);
});

test('#234 resolveEntityRef: resolves by id/name, errors on unknown + ambiguous', () => {
  const id = Number(insertEntityStmt.run('person', 'Ref Lookup', '{}').lastInsertRowid);
  insertAliasStmt.run(id, 'ref lookup', 'name');
  assert.deepEqual(resolveEntityRef(id), { id, name: 'Ref Lookup' }, 'by id');
  assert.equal(resolveEntityRef('Ref Lookup').id, id, 'by name');
  assert.throws(() => resolveEntityRef(999999), (e) => e.code === 'NOT_FOUND', 'unknown id');
  assert.throws(() => resolveEntityRef('No Such Name Here'), (e) => e.code === 'NOT_FOUND', 'unknown name');

  // ambiguous: the same alias value owned by two entities under different types (resolveAliasStmt is type-agnostic)
  const x = Number(insertEntityStmt.run('person', 'Ambig X', '{}').lastInsertRowid);
  const y = Number(insertEntityStmt.run('org', 'Ambig Y', '{}').lastInsertRowid);
  insertAliasStmt.run(x, 'ambig token', 'name');
  insertAliasStmt.run(y, 'ambig token', 'handle');
  assert.throws(() => resolveEntityRef('ambig token'), (e) => e.code === 'AMBIGUOUS');
});

test('#232 propose_entity: email/phone aliases are normalized (idempotent across casing/format)', async () => {
  // Mixed-case email stages once, lowercased; re-proposing the lowercase form is the same row.
  let r = await post('/api/v1/entities/proposed', { kind: 'person', name: 'Pat Agent', alias: 'Pat.Agent@Example.COM', alias_type: 'email' }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 201);
  const first = await r.json();
  r = await post('/api/v1/entities/proposed', { kind: 'person', name: 'Pat Agent', alias: 'pat.agent@example.com', alias_type: 'email' }, { 'x-api-key': API_KEY });
  assert.deepEqual({ id: (await r.json()).id, s: r.status }, { id: first.id, s: 200 }, 'different casing → same proposal, not a duplicate');
  const q = await (await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY })).json();
  assert.equal(q.proposals.find((x) => x.id === first.id).alias, 'pat.agent@example.com', 'email alias stored lowercased');

  // Same for a NANP phone: +1 form and bare 10-digit collapse to one key (#129 normalizePhone).
  r = await post('/api/v1/entities/proposed', { kind: 'person', name: 'Dial Broker', alias: '+1 (415) 555-0148', alias_type: 'phone' }, { 'x-api-key': API_KEY });
  const ph = await r.json();
  r = await post('/api/v1/entities/proposed', { kind: 'person', name: 'Dial Broker', alias: '4155550148', alias_type: 'phone' }, { 'x-api-key': API_KEY });
  assert.equal((await r.json()).id, ph.id, 'phone alias canonicalized to one key');
});

test('#244 GET /api/v1/ingest/types: registry + observed x- extension_types, auth-gated', async () => {
  assert.equal((await get('/api/v1/ingest/types')).status, 401, 'auth-gated');

  const before = await (await get('/api/v1/ingest/types', { 'x-api-key': API_KEY })).json();
  assert.equal(before.version, 'v1');
  assert.ok(before.types.some((t) => t.type === 'note'), 'static registry is present');
  assert.ok(!before.extension_types.some((t) => t.type === 'x-244-marker'), 'not observed yet');

  // Two artifacts under the same x- type, one under a different x- type.
  await executeStore('dev memory one', 'x-244-marker');
  await executeStore('dev memory two', 'x-244-marker');
  await executeStore('a different dev marker', 'x-244-other');

  const after = await (await get('/api/v1/ingest/types', { 'x-api-key': API_KEY })).json();
  const marker = after.extension_types.find((t) => t.type === 'x-244-marker');
  assert.ok(marker, 'newly-observed x- type is surfaced');
  assert.equal(marker.count, 2, 'count reflects both artifacts stored under that type');
  assert.equal(marker.default_searchable, false, 'an extension type is always flagged not default-searchable');
  assert.ok(after.extension_types.some((t) => t.type === 'x-244-other'), 'a second distinct x- type is also surfaced');
});

test('#244 executeStore: optional type defaults to note, accepts an x- extension, stored as given', async () => {
  const defaultId = await executeStore('typed-store default check');
  assert.equal(db.prepare('SELECT type FROM artifacts WHERE id = ?').get(defaultId).type, 'note', 'omitted type defaults to note (back-compat with /api/remember)');

  const typedId = await executeStore('typed-store x- check', 'x-244-solo');
  assert.equal(db.prepare('SELECT type FROM artifacts WHERE id = ?').get(typedId).type, 'x-244-solo', 'an x- extension type is stored verbatim');
});

test('#436 executeStore: an explicit occurred_at is stored on the artifact and appears in that date range on the timeline', async () => {
  const id = await executeStore('remembered something that happened last week', 'note', '2026-02-14');
  assert.equal(db.prepare('SELECT occurred_at FROM artifacts WHERE id = ?').get(id).occurred_at, '2026-02-14');

  const row = timeline('2026-02-01', '2026-02-28', ['note']).find((r) => r.id === id);
  assert.ok(row, 'the explicit occurred_at makes the memory appear in that date range on the timeline');
});

test('#514 executeStore: omitting occurred_at defaults to the write time, not NULL', async () => {
  const before = new Date();
  const id = await executeStore('typed-store no occurred_at check');
  const stored = db.prepare('SELECT occurred_at FROM artifacts WHERE id = ?').get(id).occurred_at;
  assert.notEqual(stored, null, 'occurred_at is set at write time, never left NULL for a manual write');
  // stored is a naive 'YYYY-MM-DD HH:MM:SS' (writeTimeNow), not ISO 8601 — `new Date()` parsing of
  // that shape is implementation-defined; force an unambiguous ISO local-time parse instead.
  const delta = new Date(stored.replace(' ', 'T')).getTime() - before.getTime();
  // writeTimeNow() truncates to whole seconds, so it can read up to ~1s EARLIER than a
  // millisecond-precision `before` captured later in the same second — not staleness.
  assert.ok(delta >= -1000 && delta < 5000, `occurred_at (${stored}) should be ~now, not a stale/future value`);
});

test('#514 POST /api/remember: omitted occurred_at defaults to write time, not NULL', async () => {
  const before = new Date();
  const stored = await post('/api/remember', { content: '#514 remember-path occurred_at check' }, { 'x-api-key': API_KEY });
  assert.equal(stored.status, 200);
  const { id } = await stored.json();
  const occurredAt = db.prepare('SELECT occurred_at FROM artifacts WHERE id = ?').get(id).occurred_at;
  assert.notEqual(occurredAt, null, '/api/remember never passes occurred_at, but executeStore still defaults it to write time');
  const delta = new Date(occurredAt.replace(' ', 'T')).getTime() - before.getTime();
  assert.ok(delta >= -1000 && delta < 5000, `occurred_at (${occurredAt}) should be ~now, not a stale/future value`);
});

test('#514 repro: an x- typed store_memory write with no occurred_at is returned by timeline over today, typed', async () => {
  const id = await executeStore('#514 repro memory for typed timeline read-back', 'x-514-repro');
  // localDate, not a UTC slice — "today" here has to match the LOCAL calendar day executeStore's
  // default writes into, the same local-day semantics timeline itself resolves "today" against
  // (#436). A UTC slice would hide exactly the boundary bug Copilot flagged on PR #515.
  const today = localDate(new Date());
  const row = timeline(today, today, ['x-514-repro']).find((r) => r.id === id);
  assert.ok(row, 'a manual x- typed write with no occurred_at is reachable via a typed timeline range covering today');
});

// Documents current (accepted, not fixed) behavior — a decision on record, not an accident (a
// review finding, #436): OccurredAtSchema accepts a full ISO datetime with a timezone offset, but
// executeStore stores it VERBATIM, not normalized to the 'YYYY-MM-DD HH:MM:SS' shape every other
// writer uses. date()/COALESCE still range-filter correctly (SQLite's date() parses both forms),
// but an offset value buckets by its UTC day, which can differ from the calendar day the caller
// meant. Normalizing on write is a candidate follow-up, not part of #436's scope (NULL visibility).
test('#436 executeStore: an offset ISO datetime is stored verbatim and range-filters correctly, but buckets by its UTC day', async () => {
  // 23:30 Feb 14 in UTC-5 is 04:30 UTC on Feb 15 — the row must still be found by a Feb range
  // (date() parses the offset form), but it lands on the 15th, not the 14th the caller wrote.
  const id = await executeStore('late-evening offset datetime check', 'note', '2026-02-14T23:30:00-05:00');
  assert.equal(db.prepare('SELECT occurred_at FROM artifacts WHERE id = ?').get(id).occurred_at, '2026-02-14T23:30:00-05:00', 'stored verbatim, not normalized');

  const feb = timeline('2026-02-01', '2026-02-28', ['note']).find((r) => r.id === id);
  assert.ok(feb, 'range-filtering still finds it (date() correctly parses the offset form)');

  const day15 = timeline('2026-02-15', '2026-02-15', ['note']).find((r) => r.id === id);
  assert.ok(day15, 'it buckets by its UTC day (the 15th), not the local calendar day the caller wrote (the 14th) — documented, not fixed, by #436');
});

test('#436 OccurredAtSchema (store_memory\'s occurred_at validation): accepts ISO 8601, rejects garbage', () => {
  assert.equal(OccurredAtSchema.safeParse('2026-02-14').success, true, 'a bare ISO date is accepted');
  assert.equal(OccurredAtSchema.safeParse('2026-02-14T10:30:00Z').success, true, 'a full ISO datetime with Z is accepted');
  assert.equal(OccurredAtSchema.safeParse('2026-02-14T10:30:00-05:00').success, true, 'a full ISO datetime with an offset is accepted');
  assert.equal(OccurredAtSchema.safeParse('not-a-date').success, false, 'garbage is rejected, not silently dropped to NULL');
  assert.equal(OccurredAtSchema.safeParse('02/14/2026').success, false, 'a non-ISO format is rejected');
  assert.equal(OccurredAtSchema.safeParse('2026-02-14 10:30:00').success, false, 'the SQLite storage format itself is not accepted input (must be ISO 8601)');
  assert.equal(OccurredAtSchema.safeParse('2026-02-14T10:30:00.' + '1'.repeat(40) + 'Z').success, false, 'an absurdly long fractional-second tail is rejected (length-bounded, not just format-checked)');
});

test('#244 StoreTypeSchema (store_memory\'s type validation): accepts note/x-, rejects everything else', () => {
  assert.equal(StoreTypeSchema.safeParse('note').success, true, 'the existing default is accepted');
  assert.equal(StoreTypeSchema.safeParse('x-dev-note').success, true, 'an x- extension marker is accepted');
  assert.equal(StoreTypeSchema.safeParse('bogus').success, false, 'garbage is rejected');
  assert.equal(StoreTypeSchema.safeParse('Note').success, false, 'wrong case is rejected, not coerced');
  assert.equal(StoreTypeSchema.safeParse('X-Dev-Note').success, false, 'an uppercase x- prefix is rejected (matches isExtensionType, not just LIKE)');
  // Registered types other than 'note' are rejected — store_memory writes only a freeform
  // manual note (no source_id/extra_json/raw_path), so a caller can't mint a structurally-hollow
  // "contact"/"digest"/"photo" row through this path.
  for (const t of ['contact', 'digest', 'photo', 'visit', 'dev_session']) {
    assert.equal(StoreTypeSchema.safeParse(t).success, false, `registered non-note type "${t}" is rejected for store_memory`);
  }
});

test('#244 /api/search + /api/timeline: types filter rejects a malformed value (not registered, not x-)', async () => {
  let r = await post('/api/search', { query: 'anything', types: ['bogus'] }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 400, 'a type that is neither registered nor x-prefixed is rejected');

  r = await post('/api/search', { query: 'anything', types: ['Note'] }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 400, 'wrong-case registered type is rejected (case-sensitive, not silently coerced)');

  r = await post('/api/timeline', { start: '2020-01-01', end: '2030-01-01', types: ['bogus'] }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 400, 'timeline applies the same types validation');
});

test('#244 x- extension isolation + read-back: excluded from an untyped search, surfaced by an explicit types filter', async () => {
  await executeStore('quokka dev marker memory for isolation check', 'x-244-iso');

  const untyped = await post('/api/search', { query: 'quokka dev marker memory', limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(untyped.status, 200);
  const untypedTypes = (await untyped.json()).results.map((r) => r.type);
  assert.ok(!untypedTypes.includes('x-244-iso'), 'an untyped search never surfaces an x- extension artifact (default_searchable)');

  const typed = await post('/api/search', { query: 'quokka dev marker memory', types: ['x-244-iso'], limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(typed.status, 200);
  const typedResults = (await typed.json()).results;
  assert.ok(typedResults.some((r) => r.type === 'x-244-iso' && /quokka/.test(r.text_repr)), 'naming the x- type explicitly reads the marker back');
});

test('#244 dev_session default_searchable:false: excluded from an untyped search, still explicit-searchable', async () => {
  // dev_session joined the ambient-session set (visit/listening_session/browsing_session) — a
  // coding-session summary is dev-workflow noise for ordinary personal recall (#244). Stored via
  // storeArtifactTxn directly since store_memory/executeStore rejects non-note registered types.
  const vec = await embedToFloat32('lemur coding session summary about refactoring the parser');
  storeArtifactTxn({ type: 'dev_session', source: 'devsession-test', source_id: '244-dev', text_repr: 'lemur coding session summary about refactoring the parser' }, vec, []);

  const untyped = await post('/api/search', { query: 'lemur coding session summary', limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(untyped.status, 200);
  const untypedTypes = (await untyped.json()).results.map((r) => r.type);
  assert.ok(!untypedTypes.includes('dev_session'), 'an untyped search never surfaces a dev_session artifact (default_searchable:false)');

  const typed = await post('/api/search', { query: 'lemur coding session summary', types: ['dev_session'], limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(typed.status, 200);
  assert.ok((await typed.json()).results.some((r) => r.type === 'dev_session'), 'an explicit types:["dev_session"] filter still surfaces it');
});

// --- Side contact directory: browse + promote (#299) ---
// The routes that make the loaded roster reachable and promotable. Promotion writes the entity graph
// directly (no proposed-queue round trip), so the isolation contract on the bulk path matters: one
// bad name must never abort its siblings.
test('#299 GET /api/v1/directory: grouped by name with handles, impact-ordered, auth-gated', async () => {
  const { insertDirectoryEntry } = await import('../src/db.js');
  insertDirectoryEntry('Rhoda Bellweather', '+1 (410) 555-7001', 'phone');
  insertDirectoryEntry('Rhoda Bellweather', 'rhoda@example.com', 'email');
  insertDirectoryEntry('Silent Sam', '+1 (410) 555-7002', 'phone');
  // One staged photo hint naming Rhoda — that is her impact, and Sam has none.
  const vec = await embedToFloat32('a photo from the reunion');
  const { id } = storeArtifactTxn({ type: 'photo', source: 'dir-299', source_id: 'ph-1', text_repr: 'a photo from the reunion' }, vec, []);
  const { resolveEntityHints } = await import('../src/db.js');
  resolveEntityHints(id, [{ alias: 'rhoda bellweather', alias_type: 'name', role: 'pictured' }]);

  assert.equal((await get('/api/v1/directory')).status, 401, 'the directory is auth-gated');
  const r = await get('/api/v1/directory?limit=200', { 'x-api-key': API_KEY });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.total_names >= 2 && body.total_rows >= 3, 'totals count distinct names and handle rows');
  const rhoda = body.candidates.find((c) => c.name === 'Rhoda Bellweather');
  assert.equal(rhoda.handles.length, 2, 'a 2-handle name is ONE row carrying both handles');
  assert.equal(rhoda.impact.artifacts, 1);
  assert.equal(rhoda.impact.name_hints, 1);
  assert.equal(rhoda.entity_id, null, 'not curated yet');
  const sam = body.candidates.find((c) => c.name === 'Silent Sam');
  assert.equal(sam.impact.artifacts, 0);
  assert.ok(body.candidates.indexOf(rhoda) < body.candidates.indexOf(sam), 'impact-desc ordering puts history first');

  // query matches a name substring AND a pasted, formatted handle (normalized per #129).
  const byName = await (await get('/api/v1/directory?query=bellwea', { 'x-api-key': API_KEY })).json();
  assert.deepEqual(byName.candidates.map((c) => c.name), ['Rhoda Bellweather']);
  const byHandle = await (await get('/api/v1/directory?query=%2B1%20(410)%20555-7002', { 'x-api-key': API_KEY })).json();
  assert.deepEqual(byHandle.candidates.map((c) => c.name), ['Silent Sam']);
});

test('#494 GET /api/v1/directory: offset pages are disjoint, with a stable directory-wide total', async () => {
  const { insertDirectoryEntry } = await import('../src/db.js');
  for (let i = 0; i < 5; i++) insertDirectoryEntry(`Pagequeen Contact ${i}`, `pagequeen${i}@example.com`, 'email');

  const page1 = await (await get('/api/v1/directory?query=pagequeen&limit=2&offset=0', { 'x-api-key': API_KEY })).json();
  const page2 = await (await get('/api/v1/directory?query=pagequeen&limit=2&offset=2', { 'x-api-key': API_KEY })).json();
  const page3 = await (await get('/api/v1/directory?query=pagequeen&limit=2&offset=4', { 'x-api-key': API_KEY })).json();
  assert.equal(page1.candidates.length, 2);
  assert.equal(page2.candidates.length, 2);
  assert.equal(page3.candidates.length, 1, 'the 5th match is a short final page');
  // total_names/total_rows are directory-wide (#299, unaffected by `query`) — asserted stable across
  // pages of the SAME query, not equal to the filtered match count (5).
  assert.equal(page1.total_names, page2.total_names, 'total is stable across pages of the same query');
  assert.equal(page2.total_names, page3.total_names);
  const namesPage1 = page1.candidates.map((c) => c.name);
  const namesPage2 = page2.candidates.map((c) => c.name);
  const namesPage3 = page3.candidates.map((c) => c.name);
  const all = [...namesPage1, ...namesPage2, ...namesPage3];
  assert.equal(new Set(all).size, 5, 'all three pages together are disjoint and cover every match exactly once');
});

test('#299 POST /api/v1/directory/promote: mints with handles, links staged history, then greys the row', async () => {
  const r = await post('/api/v1/directory/promote', { names: ['Rhoda Bellweather'] }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 200);
  const [res] = (await r.json()).results;
  assert.equal(res.created, true);
  assert.equal(res.linked, 1, 'the staged photo hint linked in the same call — the point of promoting');
  assert.ok(res.entity_id > 0);
  assert.deepEqual(res.skipped_handles, []);
  const profile = await (await get(`/api/v1/entities/${res.entity_id}`, { 'x-api-key': API_KEY })).json();
  assert.equal(profile.entity.canonical_name, 'Rhoda Bellweather');
  assert.deepEqual(profile.entity.attrs.emails, ['rhoda@example.com']);
  assert.deepEqual(profile.entity.attrs.phones, ['4105557001'], 'the normalized handle seeds attrs when no #304 card exists');

  const listed = await (await get('/api/v1/directory?query=bellwea', { 'x-api-key': API_KEY })).json();
  assert.equal(listed.candidates[0].entity_id, res.entity_id, 'now curated — returned, not hidden, so the UI can grey it');
  assert.equal(listed.candidates[0].impact.artifacts, 0, 'its aliases resolve now, so there is nothing left to link');

  const second = await (await post('/api/v1/directory/promote', { names: ['Rhoda Bellweather'] }, { 'x-api-key': API_KEY })).json();
  assert.equal(second.results[0].created, false, 'a second promote reuses the entity');
  assert.equal(second.results[0].linked, 0);
  assert.equal(second.results[0].aliases, 0, 'and adds no duplicate aliases');
});

test('#299 POST /api/v1/directory/promote: a bad name is isolated per item; empty/oversized lists are 400', async () => {
  const r = await post('/api/v1/directory/promote', { names: ['Silent Sam', 'Nobody In Here'] }, { 'x-api-key': API_KEY });
  assert.equal(r.status, 200, 'a per-item failure is never a partial-failure 500');
  const { results } = await r.json();
  const good = results.find((x) => x.name === 'Silent Sam');
  const bad = results.find((x) => x.name === 'Nobody In Here');
  assert.equal(good.created, true, 'the good name still promoted');
  assert.equal(bad.error, 'NOT_IN_DIRECTORY');
  assert.equal(bad.entity_id, undefined);

  assert.equal((await post('/api/v1/directory/promote', { names: [] }, { 'x-api-key': API_KEY })).status, 400, 'empty list rejected');
  assert.equal((await post('/api/v1/directory/promote', { names: Array.from({ length: 101 }, (_, i) => `n${i}`) }, { 'x-api-key': API_KEY })).status, 400, '101 names rejected');
  assert.equal((await post('/api/v1/directory/promote', { names: ['Silent Sam'] })).status, 401, 'promote is auth-gated');
});

// --- Name-type hints consult the side directory (#301) ---
// The photo connector's folder-name hints are alias_type:'name', so before this the handle-keyed
// directory branch never saw them. Over the wire: ingest such a hint and it lands in the review queue.
test('#301 POST /api/v1/ingest: a name hint the directory knows stages a pending proposal', async () => {
  const { insertDirectoryEntry } = await import('../src/db.js');
  insertDirectoryEntry('Fenella Okoro', '+1 (901) 555-4400', 'phone');

  const ing = await post('/api/v1/ingest', {
    source: 'photo-exif', source_id: 'srv-301-photo', type: 'photo', text_repr: 'Photo of Fenella Okoro at the lake',
    entity_hints: [{ alias: 'Fenella Okoro', alias_type: 'name', role: 'pictured', confidence: 0.9 }],
  }, { 'x-api-key': API_KEY });
  assert.ok(ing.status === 201 || ing.status === 200, 'ingest accepted');

  const { proposals } = await (await get('/api/v1/entities/proposed?status=pending&limit=100', { 'x-api-key': API_KEY })).json();
  const prop = proposals.find((p) => p.alias === 'fenella okoro');
  assert.ok(prop, 'the name hint reached the directory and staged a proposal');
  assert.equal(prop.suggested_kind, 'person');
  assert.equal(prop.suggested_name, 'Fenella Okoro');
  assert.equal(prop.alias_type, 'name');

  const before = await (await post('/api/about_entity', { name: 'Fenella Okoro' }, { 'x-api-key': API_KEY })).json();
  assert.equal(before.resolved, false, 'still no entity — a proposal is not a contact');

  // Approving links the photo that named her.
  assert.equal((await fetch(`${base}/api/v1/entities/proposed/${prop.id}/approve`, { method: 'POST', headers: { 'x-api-key': API_KEY } })).status, 200);
  const after = await (await post('/api/about_entity', { name: 'Fenella Okoro' }, { 'x-api-key': API_KEY })).json();
  assert.equal(after.resolved, true);
  assert.ok(after.entities[0].artifacts.some((a) => a.source_id === 'srv-301-photo'), 'her photo is linked after approval');
});

test('#301 POST /api/v1/entities/proposed/stage-from-directory: scans name hints too, and is idempotent', async () => {
  const { insertDirectoryEntry, storeArtifactTxn, resolveEntityHints } = await import('../src/db.js');
  // Historical: the name hint was staged before the directory could be consulted for it.
  const vec = await embedToFloat32('Photo of Ravi Chandrasekaran on the trail');
  const { id } = storeArtifactTxn({ type: 'photo', source: 'photo-exif', source_id: 'srv-301-hist', text_repr: 'Photo of Ravi Chandrasekaran on the trail' }, vec, []);
  resolveEntityHints(id, [{ alias: 'Ravi Chandrasekaran', alias_type: 'name', role: 'pictured' }]);
  insertDirectoryEntry('Ravi Chandrasekaran', '+1 (901) 555-5500', 'phone');

  const first = await (await post('/api/v1/entities/proposed/stage-from-directory', {}, { 'x-api-key': API_KEY })).json();
  assert.ok(first.proposed >= 1, 'the widened backfill proposes the historical name hint');
  const { proposals } = await (await get('/api/v1/entities/proposed?status=pending&limit=100', { 'x-api-key': API_KEY })).json();
  assert.ok(proposals.some((p) => p.alias === 'ravi chandrasekaran' && p.alias_type === 'name'), 'name-keyed row is in the queue');

  const second = await (await post('/api/v1/entities/proposed/stage-from-directory', {}, { 'x-api-key': API_KEY })).json();
  assert.equal(second.proposed, 0, 'idempotent on a second call');
});
