// Event entities (#138): a time-bounded (optionally place-anchored) episode node. Drives the real
// db.js + cluster-events.js paths against a temp DB (no network — an event has no vector). Covers
// ensureEventEntity idempotency, temporal linkArtifactsToEvent (in/out of range), the optional
// place-radius intersection, the null-span edge, manual-create linking, and the cluster -> propose
// -> approve -> link pipeline incl. the away-from-home filter. A fake Ollama is stood up only so
// importing search.js (for aboutEntity) never needs a live engine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, f32, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const {
  db, storeArtifactTxn, ensureEventEntity, linkArtifactsToEvent, ensurePlaceEntity, createEntity,
  proposeEntity, listProposedEntities, approveProposedEntity, getEntity, resolveEntityIds,
} = await import('../src/db.js');
const { clusterEvents } = await import('../scripts/cluster-events.js');
const { aboutEntity } = await import('../src/search.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

const SF = { lat: 37.7749, lon: -122.4194 };
let seq = 0;
const uniqueSource = () => `event-test-${++seq}`;
// Insert an artifact with occurred_at and optional coords; returns its id.
const artifactAt = (occurredAt, { lat = null, lon = null } = {}) => storeArtifactTxn(
  { type: 'photo', source: uniqueSource(), source_id: `ev-${seq}`, text_repr: `artifact at ${occurredAt}`, occurred_at: occurredAt, latitude: lat, longitude: lon },
  f32(0.5),
).id;
const partOfLinks = (eventId) =>
  db.prepare("SELECT artifact_id FROM entity_links WHERE entity_id = ? AND role = 'part_of'").all(eventId).map((r) => r.artifact_id);

test('ensureEventEntity: mints a kind=event entity with span in attrs_json; a 2nd call mints 0 (idempotent)', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM entities').get().n;
  const id = ensureEventEntity('Tahoe Trip', { start: '2026-03-01T00:00:00Z', end: '2026-03-05T23:59:59Z' });
  const e = getEntity(id);
  assert.equal(e.kind, 'event');
  assert.equal(e.attrs.start, '2026-03-01T00:00:00Z');
  assert.equal(e.attrs.end, '2026-03-05T23:59:59Z');
  assert.ok(resolveEntityIds('Tahoe Trip').includes(id), 'resolves by seeded name alias');

  const again = ensureEventEntity('Tahoe Trip', { start: '2026-03-01T00:00:00Z', end: '2026-03-05T23:59:59Z' });
  assert.equal(again, id, 'resolve-first returns the same id');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities').get().n, before + 1, 'no second entity minted');
});

test('linkArtifactsToEvent: links artifacts with occurred_at in [start,end], excludes out-of-range; idempotent', () => {
  const inRange = artifactAt('2026-03-15T12:00:00Z');
  const before = artifactAt('2026-02-28T12:00:00Z'); // just before the window
  const after_ = artifactAt('2026-04-01T12:00:00Z'); // just after the window
  const eventId = ensureEventEntity('March Window', { start: '2026-03-01T00:00:00Z', end: '2026-03-31T23:59:59Z' });

  const linked = linkArtifactsToEvent(eventId);
  const ids = partOfLinks(eventId);
  assert.ok(ids.includes(inRange), 'in-range artifact linked');
  assert.ok(!ids.includes(before) && !ids.includes(after_), 'out-of-range artifacts excluded');
  assert.equal(linked, ids.length, 'returned count matches links written');

  assert.equal(linkArtifactsToEvent(eventId), 0, 'second run writes 0 new links (OR IGNORE idempotent)');
});

test('linkArtifactsToEvent: with place_entity_id set, linking is additionally constrained to that place radius', () => {
  const atSF = artifactAt('2026-05-15T12:00:00Z', { lat: 37.78, lon: -122.42 });   // in time + in radius
  const farAway = artifactAt('2026-05-16T12:00:00Z', { lat: 40.71, lon: -74.0 });  // in time, out of radius (NYC)
  const coordless = artifactAt('2026-05-17T12:00:00Z');                            // in time, no coords
  const placeId = ensurePlaceEntity('SF Venue', { latitude: SF.lat, longitude: SF.lon, radius_km: 5 });
  const eventId = ensureEventEntity('SF May Event', { start: '2026-05-01T00:00:00Z', end: '2026-05-31T23:59:59Z', place_entity_id: placeId });

  linkArtifactsToEvent(eventId);
  const ids = partOfLinks(eventId);
  assert.ok(ids.includes(atSF), 'in-radius + in-time artifact linked');
  assert.ok(!ids.includes(farAway), 'in-time but out-of-radius artifact excluded');
  assert.ok(!ids.includes(coordless), 'coordless artifact excluded when place-constrained (can\'t confirm)');
});

test('linkArtifactsToEvent: a null/invalid span links nothing and never throws (edge)', () => {
  artifactAt('2026-06-15T12:00:00Z'); // an artifact exists, but the event has no span
  const noSpan = ensureEventEntity('No Span Event', { start: null, end: null });
  assert.equal(linkArtifactsToEvent(noSpan), 0, 'null span → 0 links, no throw');
  const inverted = ensureEventEntity('Inverted Span Event', { start: '2026-06-30T00:00:00Z', end: '2026-06-01T00:00:00Z' });
  assert.equal(linkArtifactsToEvent(inverted), 0, 'end < start → 0 links, no throw');
});

test('createEntity (manual, #138): a trusted event create links in-range artifacts immediately + about_entity returns them', () => {
  const inRange = artifactAt('2026-09-15T12:00:00Z');
  const { id: eventId } = createEntity({ kind: 'event', canonical_name: 'September Occasion', attrs: { start: '2026-09-01T00:00:00Z', end: '2026-09-30T23:59:59Z' } });
  assert.equal(getEntity(eventId).kind, 'event');
  assert.ok(partOfLinks(eventId).includes(inRange), 'manual create linked the in-range artifact without a separate call');

  const about = aboutEntity('September Occasion');
  assert.equal(about.resolved, true);
  assert.ok(about.entities[0].artifacts.some((a) => a.id === inRange), 'about_entity(<event>) returns its linked artifacts');
});

test('events:cluster: stages an event proposal from an away burst and mints nothing; approve mints + links', () => {
  // 5 GPS+time artifacts within one day at SF (hours apart, so one contiguous run) on a date no
  // other test uses, so the proposal name is distinct. No "home" place yet → all bursts cluster.
  const burst = [];
  for (let i = 0; i < 5; i++) burst.push(artifactAt(`2026-10-10T1${i}:00:00Z`, { lat: SF.lat + i * 0.001, lon: SF.lon + i * 0.001 }));

  const entitiesBefore = db.prepare('SELECT COUNT(*) n FROM entities').get().n;
  const summary = clusterEvents();
  assert.ok(summary.staged >= 1, 'at least one event proposal staged');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities').get().n, entitiesBefore, 'clusterer mints nothing');

  const proposal = listProposedEntities('pending', 1000).find((p) => p.suggested_kind === 'event' && /2026-10-10/.test(p.suggested_name));
  assert.ok(proposal, 'a dated event proposal is pending');
  const staged = JSON.parse(proposal.attrs_json);
  assert.ok(staged.start && staged.end && staged.start <= staged.end, 'staged span present + ordered');

  const { entity_id } = approveProposedEntity(proposal.id);
  assert.equal(getEntity(entity_id).kind, 'event');
  const linkedIds = partOfLinks(entity_id);
  for (const b of burst) assert.ok(linkedIds.includes(b), 'each burst artifact linked to the approved event');
});

test('events:cluster: a "home" place excludes at-home artifacts from clustering (away-from-home filter)', () => {
  // Home at Los Angeles; a 5-artifact burst AT home must be excluded (routine), so no LA-named event.
  ensurePlaceEntity('home', { latitude: 34.0522, longitude: -118.2437, radius_km: 10 });
  for (let i = 0; i < 5; i++) artifactAt(`2026-11-0${i + 1}T12:00:00Z`, { lat: 34.0522 + i * 0.001, lon: -118.2437 + i * 0.001 });

  const summary = clusterEvents();
  assert.equal(summary.home_filtered, true, 'home place detected → filter active');
  const laProposal = listProposedEntities('pending', 1000).find((p) => p.suggested_kind === 'event' && /Los Angeles/.test(p.suggested_name) && /2026-11/.test(p.suggested_name));
  assert.ok(!laProposal, 'the at-home November burst produced no event proposal');
});

test('proposeEntity: carries attrs_json span for an event proposal', () => {
  const staged = proposeEntity({ suggested_kind: 'event', name: 'Manual Event Prop', alias: 'manual event prop', alias_type: 'name', attrs_json: { start: '2026-12-01T00:00:00Z', end: '2026-12-02T00:00:00Z', place_entity_id: null } });
  assert.equal(staged.created, true);
  const row = listProposedEntities('pending', 1000).find((p) => p.suggested_name === 'Manual Event Prop');
  assert.deepEqual(JSON.parse(row.attrs_json), { start: '2026-12-01T00:00:00Z', end: '2026-12-02T00:00:00Z', place_entity_id: null });
});
