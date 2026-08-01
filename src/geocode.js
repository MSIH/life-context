/**
 * Fully offline reverse geocoding: nearest-place lookup against a bundled GeoNames-derived
 * dataset (src/geodata/places.json, ~135k places pop >= 1000, CC BY 4.0 — see README), never
 * a network call. Core owns this (issue #67) so `place_label` resolution happens once, in one
 * place, for every current and future connector that submits raw latitude/longitude — mirrors
 * how core already owns text_repr -> embedding (doc 04 §3: connectors describe, core embeds).
 * Regenerate via `npm run geocode:build -- <path-to-cities1000.txt>`; see scripts/build-places.js.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUsState } from './us-states.js';

const PLACES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'geodata', 'places.json'), 'utf8'),
);

const EARTH_RADIUS_KM = 6371;
const NEARBY_KM = 50; // within this, name the place plainly
const FAR_KM = 300; // beyond this, the dataset has nothing useful to say

const toRad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns a place_label string, or null if the dataset has nothing within FAR_KM (an honest
// "don't know" rather than mislabeling an artifact with a place hundreds of km away).
export function reverseGeocode(lat, lon) {
  // IngestPayloadSchema only requires z.number() — out-of-range values (e.g. a malformed
  // connector payload sending latitude:999) reach here unvalidated; a defined-but-meaningless
  // haversine distance would otherwise still produce a confidently wrong "nearest" label.
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  let nearest = null;
  let nearestKm = Infinity;
  for (const place of PLACES) {
    const km = haversineKm(lat, lon, place.lat, place.lon);
    if (km < nearestKm) {
      nearest = place;
      nearestKm = km;
    }
  }
  if (!nearest || nearestKm > FAR_KM) return null;
  const label = nearest.region ? `${nearest.city}, ${nearest.region}` : `${nearest.city}, ${nearest.country}`;
  return nearestKm > NEARBY_KM ? `near ${label}` : label;
}

// Forward geocode: resolve a place NAME to a center point for geo-radius search (issue #68 —
// the inverse of reverseGeocode). Case-insensitive exact match on city, optionally narrowed by
// a ", <region>" suffix ("Austin, TX"). places.json carries no population, so an unqualified,
// ambiguous name (there are dozens of "San Francisco"s worldwide) can't be disambiguated by
// popularity; it instead prefers a US match — the only entries that carry a region (#67's
// US-only region rule) — so "San Francisco" resolves to California rather than the
// alphabetically-first country. A qualified "City, Region" always matches exactly. Returns
// {lat, lon, label}, or null when nothing matches.
// The region compare is canonicalized through normalizeUsState (#186) so a query's "TX" matches
// a stored full-name "Texas" (and vice versa) — the dataset now stores full state names; a
// non-US region (or an unrecognized string) falls back to a raw lowercase compare.
export function geocodePlace(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const [cityPart, regionPart] = name.trim().toLowerCase().split(',').map((s) => s.trim());
  let fallback = null; // first city match regardless of region — used only if no US match exists
  for (const place of PLACES) {
    if (place.city.toLowerCase() !== cityPart) continue;
    if (regionPart) {
      const q = normalizeUsState(regionPart);
      const p = normalizeUsState(place.region);
      const match = q && p ? q.code === p.code : (place.region || '').toLowerCase() === regionPart;
      if (!match) continue;
    }
    const hit = {
      lat: place.lat,
      lon: place.lon,
      label: place.region ? `${place.city}, ${place.region}` : `${place.city}, ${place.country}`,
    };
    if (regionPart || place.region) return hit; // exact region match, or the preferred US match
    if (!fallback) fallback = hit;
  }
  return fallback;
}
