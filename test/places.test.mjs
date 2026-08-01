// Place entities (#137): a geo-anchored, human-approved location node. Drives the real db.js +
// cluster-places.js paths against a temp DB (no network — db.js doesn't embed; a place has no
// vector). Covers ensurePlaceEntity idempotency, spatial linkArtifactsToPlace (in/out of radius),
// the cluster -> propose -> approve -> link pipeline, manual-create linking, and the no-coords edge.
// A fake Ollama is stood up only so importing search.js (for aboutEntity) never needs a live engine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, f32, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const {
  db, storeArtifactTxn, ensurePlaceEntity, linkArtifactsToPlace, createEntity,
  proposeEntity, listProposedEntities, approveProposedEntity, getEntity, resolveEntityIds,
} = await import('../src/db.js');
const { clusterPlaces } = await import('../scripts/cluster-places.js');
const { aboutEntity } = await import('../src/search.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

// San Francisco — the bundled gazetteer names these coords "San Francisco, California" (geocode.test).
const SF = { lat: 37.7749, lon: -122.4194 };
let seq = 0;
const uniqueSource = () => `place-test-${++seq}`;
// Insert a GPS-bearing artifact; returns its id.
const geoArtifact = (lat, lon) => storeArtifactTxn(
  { type: 'photo', source: uniqueSource(), source_id: `geo-${seq}`, text_repr: `photo at ${lat},${lon}`, latitude: lat, longitude: lon },
  f32(0.5),
).id;
const locationLinks = (placeId) =>
  db.prepare("SELECT artifact_id FROM entity_links WHERE entity_id = ? AND role = 'location_of'").all(placeId).map((r) => r.artifact_id);

test('ensurePlaceEntity: mints a kind=place entity with geo in attrs_json; a 2nd call mints 0 (idempotent)', () => {
  const before = db.prepare("SELECT COUNT(*) n FROM entities").get().n;
  const id = ensurePlaceEntity('Deer Valley', { latitude: SF.lat, longitude: SF.lon, radius_km: 5 });
  const e = getEntity(id);
  assert.equal(e.kind, 'place');
  assert.deepEqual([e.attrs.latitude, e.attrs.longitude, e.attrs.radius_km], [SF.lat, SF.lon, 5]);
  assert.ok(resolveEntityIds('Deer Valley').includes(id), 'the place resolves by its seeded name alias');

  const aliasesBefore = db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n;
  const again = ensurePlaceEntity('Deer Valley', { latitude: SF.lat, longitude: SF.lon, radius_km: 5 });
  assert.equal(again, id, 'resolve-first returns the same id');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entities").get().n, before + 1, 'no second entity minted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n, aliasesBefore, 'no duplicate aliases');
});

test('linkArtifactsToPlace: links artifacts inside the radius, excludes those outside; idempotent', () => {
  const inside = geoArtifact(37.78, -122.42);      // ~0.6 km from SF center → within 5 km
  const outside = geoArtifact(37.90, -122.4194);   // ~13.9 km north → outside 5 km
  const placeId = ensurePlaceEntity('SF Radius Place', { latitude: SF.lat, longitude: SF.lon, radius_km: 5 });

  const linked = linkArtifactsToPlace(placeId);
  const ids = locationLinks(placeId);
  assert.ok(ids.includes(inside), 'in-radius artifact linked');
  assert.ok(!ids.includes(outside), 'out-of-radius artifact excluded');
  assert.equal(linked, ids.length, 'returned count matches the links written');

  const linkedAgain = linkArtifactsToPlace(placeId);
  assert.equal(linkedAgain, 0, 'a second run writes 0 new links (OR IGNORE idempotent)');
  assert.deepEqual(locationLinks(placeId).sort(), ids.sort(), 'link set unchanged');
});

test('linkArtifactsToPlace: a place with no usable coords links nothing and never throws (edge)', () => {
  geoArtifact(37.775, -122.418); // an artifact exists near SF, but this place has no coords
  const placeId = ensurePlaceEntity('Coordless Place', { latitude: null, longitude: null, radius_km: null });
  assert.equal(linkArtifactsToPlace(placeId), 0, 'no coords → 0 links, no throw');
  assert.equal(locationLinks(placeId).length, 0);
});

test('linkArtifactsToPlace: null coords with a positive radius do NOT center on (0,0) (Number(null)===0 guard)', () => {
  // An artifact at the equator/prime-meridian island would be wrongly linked if null coords
  // collapsed to 0. The explicit null guard must reject this place before any bbox is built.
  const nearZero = geoArtifact(0.001, 0.001);
  const placeId = ensurePlaceEntity('Null Coords Radius Set', { latitude: null, longitude: null, radius_km: 5 });
  assert.equal(linkArtifactsToPlace(placeId), 0, 'null coords + radius → 0 links, not a (0,0) search');
  assert.ok(!locationLinks(placeId).includes(nearZero), 'the (0,0)-adjacent artifact is not linked');
});

test('linkArtifactsToPlace: a genuine equator/prime-meridian place (lat/lon 0) still links (0 is valid, not null)', () => {
  const atZero = geoArtifact(0.002, 0.002);
  const placeId = ensurePlaceEntity('Null Island Place', { latitude: 0, longitude: 0, radius_km: 5 });
  assert.ok(linkArtifactsToPlace(placeId) >= 1, 'lat/lon 0 is a real coordinate and links in-radius artifacts');
  assert.ok(locationLinks(placeId).includes(atZero));
});

test('createEntity (manual, #137): a trusted place create links in-radius artifacts immediately + about_entity returns them', () => {
  const inside = geoArtifact(37.7752, -122.4180); // ~0.15 km from SF center
  const { id: placeId } = createEntity({ kind: 'place', canonical_name: 'Ferry Building', attrs: { latitude: SF.lat, longitude: SF.lon, radius_km: 2 } });
  assert.equal(getEntity(placeId).kind, 'place');
  assert.ok(locationLinks(placeId).includes(inside), 'manual create linked the in-radius artifact without a separate call');

  const about = aboutEntity('Ferry Building');
  assert.equal(about.resolved, true);
  assert.ok(about.entities[0].artifacts.some((a) => a.id === inside), 'about_entity(<place>) returns its linked artifacts');
});

test('places:cluster: stages a place proposal from a GPS cluster and mints nothing; approve mints + links', () => {
  // 5 artifacts in one ~1km grid cell at SF → a cluster; a lone artifact far away → not a cluster.
  const clusterIds = [];
  for (let i = 0; i < 5; i++) clusterIds.push(geoArtifact(37.7749 + i * 0.0001, -122.4194 + i * 0.0001));
  geoArtifact(40.7128, -74.006); // lone NYC artifact — below MIN_CLUSTER_SIZE, no proposal

  const entitiesBefore = db.prepare("SELECT COUNT(*) n FROM entities").get().n;
  const summary = clusterPlaces();
  assert.ok(summary.staged >= 1, 'at least one proposal staged');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entities").get().n, entitiesBefore, 'clusterer mints nothing');

  const proposal = listProposedEntities('pending', 1000).find((p) => p.suggested_kind === 'place');
  assert.ok(proposal, 'a place proposal is pending');
  assert.match(proposal.suggested_name, /San Francisco/, 'named from the reverse-geocoded centroid');
  assert.ok(proposal.attrs_json, 'staged geo carried in attrs_json');
  const staged = JSON.parse(proposal.attrs_json);
  assert.ok(Number.isFinite(staged.latitude) && Number.isFinite(staged.longitude) && staged.radius_km > 0);

  // Approving mints the place and spatially links its cluster artifacts.
  const { entity_id } = approveProposedEntity(proposal.id);
  assert.equal(getEntity(entity_id).kind, 'place');
  const linkedIds = locationLinks(entity_id);
  for (const cid of clusterIds) assert.ok(linkedIds.includes(cid), 'each clustered artifact is linked to the approved place');
});

test('places:cluster: re-running stages no duplicate proposal (proposed_entities UNIQUE)', () => {
  const before = listProposedEntities('pending', 1000).length;
  const s = clusterPlaces();
  assert.equal(s.staged, 0, 'a second run stages nothing new');
  assert.equal(listProposedEntities('pending', 1000).length, before, 'pending queue unchanged');
});

test('proposeEntity: carries attrs_json for a place proposal (person/org leave it NULL)', () => {
  const staged = proposeEntity({ suggested_kind: 'place', name: 'Manual Prop Place', alias: 'manual prop place', alias_type: 'name', attrs_json: { latitude: 1, longitude: 2, radius_km: 3 } });
  assert.equal(staged.created, true);
  const row = listProposedEntities('pending', 1000).find((p) => p.suggested_name === 'Manual Prop Place');
  assert.deepEqual(JSON.parse(row.attrs_json), { latitude: 1, longitude: 2, radius_km: 3 });
});
