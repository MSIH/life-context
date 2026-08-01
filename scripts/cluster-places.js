#!/usr/bin/env node
/**
 * Cluster GPS-bearing artifacts into candidate place entities (#137). Groups artifacts by a coarse
 * lat/lon grid cell; a cell with enough artifacts is a recurring location worth a place node. For
 * each such cell it reverse-geocodes a candidate name and stages ONE proposed_entities row
 * (suggested_kind='place') carrying the centroid + a seed radius in attrs_json.
 *
 * MINTS NOTHING — generation is cluster -> propose -> human-approve (the #130 queue): a one-off
 * location must never auto-pollute the entity spine. Review with GET /api/v1/entities/proposed;
 * approving one (POST /api/v1/entities/proposed/:id/approve) mints the place and spatially links its
 * in-radius artifacts (approveProposedEntity -> linkArtifactsToPlace).
 *
 * Idempotent: proposed_entities' UNIQUE(suggested_name, alias, alias_type) absorbs re-runs (a second
 * run stages 0), and same-named cells collapse to one proposal (first centroid wins — a v1 coarseness
 * documented in docs/03-ob2-design.md). Back up the .db before running (append-only, but adds rows).
 *   Run:  npm run places:cluster
 */
import { pathToFileURL } from 'node:url';
import { db, proposeEntity, normalizeName, logEvent } from '../src/db.js';
import { reverseGeocode } from '../src/geocode.js';

// Tunables (auto-tuning is out of scope, #137). CELL_PRECISION decimals ~= grid resolution:
// 2 dp ≈ 1.1 km of latitude. MIN_CLUSTER_SIZE gates "recurring" — fewer means a one-off. The seed
// radius is deliberately small; a user widens it via the entity profile after approval.
const CELL_PRECISION = 2;
const MIN_CLUSTER_SIZE = 5;
const DEFAULT_RADIUS_KM = 1;

const selectGeoStmt = db.prepare(
  `SELECT id, latitude AS lat, longitude AS lon FROM artifacts
   WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
);

export function clusterPlaces() {
  const rows = selectGeoStmt.all();
  // Bucket by grid cell; accumulate a running centroid so we never hold all rows twice.
  const cells = new Map();
  for (const { lat, lon } of rows) {
    const key = `${lat.toFixed(CELL_PRECISION)},${lon.toFixed(CELL_PRECISION)}`;
    const c = cells.get(key) ?? { sumLat: 0, sumLon: 0, n: 0 };
    c.sumLat += lat; c.sumLon += lon; c.n += 1;
    cells.set(key, c);
  }
  let clusters = 0, staged = 0, unnamed = 0;
  for (const c of cells.values()) {
    if (c.n < MIN_CLUSTER_SIZE) continue;
    clusters += 1;
    const latitude = c.sumLat / c.n;
    const longitude = c.sumLon / c.n;
    const name = reverseGeocode(latitude, longitude); // "Austin, Texas" | "near <city>, <region>" | null
    if (!name) { unnamed += 1; continue; }            // too far from any known place to name — skip
    if (proposeEntity({
      suggested_kind: 'place',
      name,
      alias: normalizeName(name),
      alias_type: 'name',
      source: 'places-cluster',
      attrs_json: { latitude, longitude, radius_km: DEFAULT_RADIUS_KM },
    }).created) staged += 1;
  }
  const summary = { scanned: rows.length, clusters, staged, unnamed };
  logEvent('places_clustered', 'cluster-places.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-place-labels.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = clusterPlaces();
  console.log(
    `Clustered ${s.scanned} GPS artifacts into ${s.clusters} candidate place(s): ` +
    `${s.staged} proposal(s) staged (${s.unnamed} unnamed cluster(s) skipped). ` +
    `Review: GET /api/v1/entities/proposed — nothing was minted.`,
  );
  db.close();
}
