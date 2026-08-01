// Forward/reverse geocode pure functions (src/geocode.js): no DB, no network — just the bundled
// gazetteer (places.json). Covers geocodePlace's name->center resolution + US-preference tie-break
// (#68) and haversineKm's distance math. reverseGeocode is exercised by db.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocodePlace, haversineKm } from '../src/geocode.js';

test('geocodePlace: resolves a bare city name to a center point', () => {
  const sf = geocodePlace('San Francisco');
  assert.ok(sf, 'San Francisco resolves');
  assert.ok(Math.abs(sf.lat - 37.77) < 0.5 && Math.abs(sf.lon - (-122.42)) < 0.5, 'near the real SF coords');
});

test('geocodePlace: prefers the US match for an ambiguous unqualified name (#67 region rule)', () => {
  // Only US entries carry a region; the US SF must win over any same-named foreign city
  // regardless of array order, so the label ends with the region, not a country. Regions are
  // stored as the full state name now (#186), so the label ends with "California", not "CA".
  const sf = geocodePlace('San Francisco');
  assert.match(sf.label, /San Francisco, California$/, 'US, region-qualified label preferred');
});

test('geocodePlace: is case-insensitive and trims whitespace', () => {
  const a = geocodePlace('san francisco');
  const b = geocodePlace('  San Francisco  ');
  assert.deepEqual([a.lat, a.lon], [b.lat, b.lon]);
});

test('geocodePlace: a "City, Region" suffix narrows the match', () => {
  const hit = geocodePlace('San Francisco, CA');
  assert.ok(hit && /California$/.test(hit.label), 'region-qualified query matches the California entry');
  assert.equal(geocodePlace('San Francisco, ZZ'), null, 'a non-matching region yields no hit');
});

test('geocodePlace: a US-state region matches whether written as code or full name (#186)', () => {
  // The dataset stores full state names; normalizeUsState canonicalizes both sides so "CA" and
  // "California" resolve to the same center (and same label).
  const byCode = geocodePlace('San Francisco, CA');
  const byName = geocodePlace('San Francisco, California');
  assert.ok(byCode && byName, 'both region forms resolve');
  assert.deepEqual([byCode.lat, byCode.lon], [byName.lat, byName.lon], 'same center point');
  assert.equal(byCode.label, byName.label, 'same full-name label');
});

test('geocodePlace: unresolvable or empty input returns null', () => {
  assert.equal(geocodePlace('Xyzzyville Nowhere Land'), null);
  assert.equal(geocodePlace(''), null);
  assert.equal(geocodePlace('   '), null);
  assert.equal(geocodePlace(null), null);
  assert.equal(geocodePlace(42), null);
});

test('haversineKm: distance math', () => {
  assert.equal(haversineKm(37.7749, -122.4194, 37.7749, -122.4194), 0, 'same point is 0 km');
  const sfToNy = haversineKm(37.7749, -122.4194, 40.7128, -74.006);
  assert.ok(Math.abs(sfToNy - 4129) < 50, `SF->NY ~4129km (got ${Math.round(sfToNy)})`);
});
