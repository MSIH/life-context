#!/usr/bin/env node
/**
 * Backfill full-state-name place labels (#186) onto artifacts geocoded before this change.
 * `places.json` now stores the full state name ("Texas"), so newly reverse-geocoded labels read
 * "Austin, Texas" instead of the old "Austin, TX". Existing rows still carry the old USPS-code
 * form; this rewrites them to the full-name form so a query like "in texas" matches by label.
 *
 * place_label is a DERIVED value (re-computable from lat/lon), so rewriting it is consistent with
 * append-only preservation — the originals (raw_path/content_hash/ingested_at) are untouched and
 * the change is logged to ingest_log. It does NOT feed text_repr, so no re-embedding is needed.
 *
 * GUARDED so a connector's intentional (non-derived) label is never clobbered: a row is rewritten
 * only when its stored label EQUALS the old-format core derivation — i.e. `toCodeForm(newLabel)`,
 * the full-name label with its region mapped back to the USPS code. reverseGeocode's city pick is
 * unchanged (only the region formatting changed), so for a core-derived row the old stored label
 * is exactly that code form. A label that differs came from a connector (or a far-away coord that
 * geocodes to null) and is left as-is.
 *
 * Idempotent: after a rewrite the stored label is the full-name form, which no longer equals the
 * code form, so a second run rewrites 0. Back up the .db before running.
 *   Run:  npm run backfill:geo
 */
import { pathToFileURL } from 'node:url';
import { db, logEvent } from '../src/db.js';
import { reverseGeocode } from '../src/geocode.js';
import { normalizeUsState } from '../src/us-states.js';

const selectGeoStmt = db.prepare(
  `SELECT id, latitude AS lat, longitude AS lon, place_label AS label FROM artifacts
   WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND place_label IS NOT NULL`,
);
const updateLabelStmt = db.prepare('UPDATE artifacts SET place_label = ? WHERE id = ?');

// A full-name label ("Austin, Texas" / "near Houston, Texas") -> its old USPS-code form
// ("Austin, TX" / "near Houston, TX"). Splits on the LAST ", " so a "near <city>, <region>"
// prefix (or a comma inside a city name) is preserved. Non-US regions map to themselves.
function toCodeForm(label) {
  const idx = label.lastIndexOf(', ');
  if (idx === -1) return label;
  const st = normalizeUsState(label.slice(idx + 2));
  return st ? `${label.slice(0, idx + 2)}${st.code}` : label;
}

export function backfillPlaceLabels() {
  const rows = selectGeoStmt.all();
  let rewritten = 0;
  let skipped = 0;
  const run = db.transaction(() => {
    for (const { id, lat, lon, label } of rows) {
      const newLabel = reverseGeocode(lat, lon); // full-name format now
      // No usable derivation (coord too far from any place), already in full-name form, or a
      // connector-supplied label that isn't the old core derivation — leave it untouched.
      if (!newLabel || label === newLabel || label !== toCodeForm(newLabel)) {
        skipped++;
        continue;
      }
      updateLabelStmt.run(newLabel, id);
      rewritten++;
    }
  });
  run();
  const summary = { scanned: rows.length, rewritten, skipped };
  logEvent('place_label_backfill', 'backfill-place-labels.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-phone-aliases.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillPlaceLabels();
  console.log(`Backfill complete: ${s.scanned} geo artifacts scanned, ${s.rewritten} labels rewritten (${s.skipped} left as-is).`);
  db.close();
}
