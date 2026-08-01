#!/usr/bin/env node
/**
 * Cluster time+place artifact bursts into candidate event entities (#138). Groups GPS-bearing
 * artifacts into contiguous-day runs that are AWAY from home; a run with enough artifacts is a
 * trip/occasion worth an event node. For each run it reverse-geocodes a name, infers the [start,end]
 * span (padded to whole UTC days so same-day non-geo artifacts — messages, receipts — are captured
 * at approval), and stages ONE proposed_entities row (suggested_kind='event', span in attrs_json).
 *
 * MINTS NOTHING — generation is cluster -> propose -> human-approve (the #130 queue). Review with
 * GET /api/v1/entities/proposed; approving one (POST /api/v1/entities/proposed/:id/approve) mints the
 * event and links every artifact in its window (approveProposedEntity -> linkArtifactsToEvent).
 *
 * "Away from home": if a place entity named "home" exists (create one via the #137 manual-place
 * path with coords+radius), artifacts within its radius are treated as routine and excluded from
 * clustering. With no home place defined, ALL bursts cluster (logged) — the honest degradation.
 *
 * Idempotent: proposed_entities' UNIQUE(suggested_name, alias, alias_type) absorbs re-runs. Back up
 * the .db before running (append-only, but adds rows).
 *   Run:  npm run events:cluster
 */
import { pathToFileURL } from 'node:url';
import { db, proposeEntity, normalizeName, resolveEntityIds, getEntity, logEvent } from '../src/db.js';
import { reverseGeocode, haversineKm } from '../src/geocode.js';

// Tunables (sessionization heuristic tuning is out of scope, #138). A run breaks when the gap to
// the next away-artifact exceeds MAX_GAP_DAYS; a run needs >= MIN_EVENT_SIZE artifacts to qualify.
const MIN_EVENT_SIZE = 5;
const MAX_GAP_DAYS = 1;
const HOME_PLACE_NAME = 'home';
const MS_PER_DAY = 86_400_000;

const selectGeoTimeStmt = db.prepare(
  `SELECT id, latitude AS lat, longitude AS lon, occurred_at AS at FROM artifacts
   WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND occurred_at IS NOT NULL
   ORDER BY datetime(occurred_at) ASC`,
);

// Whole-UTC-day floor/ceil so the staged span covers the trip's days end-to-end.
const dayStart = (ms) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)).toISOString(); };
const dayEnd = (ms) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)).toISOString(); };
const isoDate = (iso) => iso.slice(0, 10);

// Resolve the optional home place's center+radius (null when no such place / no usable coords).
function homeCircle() {
  const ids = resolveEntityIds(HOME_PLACE_NAME);
  for (const id of ids) {
    const e = getEntity(id);
    if (e?.kind !== 'place') continue;
    const { latitude, longitude, radius_km } = e.attrs ?? {};
    const lat = Number(latitude), lon = Number(longitude), rad = Number(radius_km);
    if (latitude != null && longitude != null && [lat, lon, rad].every(Number.isFinite) && rad > 0) return { lat, lon, rad };
  }
  return null;
}

export function clusterEvents() {
  const home = homeCircle();
  const rows = selectGeoTimeStmt.all()
    .map((r) => ({ ...r, ms: Date.parse(r.at) }))
    .filter((r) => Number.isFinite(r.ms))
    .filter((r) => !(home && haversineKm(home.lat, home.lon, r.lat, r.lon) <= home.rad)); // drop at-home

  // Break the time-ordered away-artifacts into contiguous runs (gap > MAX_GAP_DAYS starts a new one).
  const runs = [];
  let cur = null;
  for (const r of rows) {
    if (cur && (r.ms - cur.lastMs) <= MAX_GAP_DAYS * MS_PER_DAY) {
      cur.items.push(r); cur.lastMs = r.ms; cur.sumLat += r.lat; cur.sumLon += r.lon;
    } else {
      cur = { items: [r], firstMs: r.ms, lastMs: r.ms, sumLat: r.lat, sumLon: r.lon };
      runs.push(cur);
    }
  }

  let clusters = 0, staged = 0, unnamed = 0;
  for (const run of runs) {
    if (run.items.length < MIN_EVENT_SIZE) continue;
    clusters += 1;
    const start = dayStart(run.firstMs);
    const end = dayEnd(run.lastMs);
    const place = reverseGeocode(run.sumLat / run.items.length, run.sumLon / run.items.length);
    if (!place) { unnamed += 1; continue; } // too far from any known place to name — skip
    const span = isoDate(start) === isoDate(end) ? isoDate(start) : `${isoDate(start)}–${isoDate(end)}`;
    const name = `${place} (${span})`;
    if (proposeEntity({
      suggested_kind: 'event',
      name,
      alias: normalizeName(name),
      alias_type: 'name',
      source: 'events-cluster',
      attrs_json: { start, end, place_entity_id: null },
    }).created) staged += 1;
  }
  const summary = { scanned: rows.length, home_filtered: !!home, clusters, staged, unnamed };
  logEvent('events_clustered', 'cluster-events.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors cluster-places.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = clusterEvents();
  console.log(
    `Clustered ${s.scanned} away-from-home GPS artifacts into ${s.clusters} candidate event(s): ` +
    `${s.staged} proposal(s) staged (${s.unnamed} unnamed skipped)${s.home_filtered ? '' : ' — no "home" place defined, all bursts clustered'}. ` +
    `Review: GET /api/v1/entities/proposed — nothing was minted.`,
  );
  db.close();
}
