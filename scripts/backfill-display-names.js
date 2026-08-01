#!/usr/bin/env node
/**
 * Reduce existing person contacts' display name to first+last (#156). The importer now defaults a
 * new contact's canonical_name to given+family (dropping a middle name), keeping the full name as a
 * resolvable alias — but contacts imported before that still read "Amy Margaret Fenwick" in the
 * UI and search. Re-importing can't fix them (the re-import path never touches canonical_name, and
 * import:contacts skips a matched UID), so this standalone backfill does it — mirrors
 * backfill-phone-aliases.js / backfill-relations.js.
 *
 * For each live person entity whose canonical_name is a clean 3-token first-middle-last, it sets
 * canonical to first+last and keeps BOTH the full name and the reduced form as name aliases (so
 * resolution by either still works). Idempotent: a 2-token name is skipped, so a re-run reduces 0.
 * A UI-shortened name is already 2-token and left alone. Back up life-context.db first.
 *   Run:  npm run backfill:display-names
 */
import { pathToFileURL } from 'node:url';
import { db, reduceEntityDisplayName } from '../src/db.js';

const selectPersonIdsStmt = db.prepare("SELECT id FROM entities WHERE kind = 'person' AND merged_into IS NULL");

export function backfillDisplayNames() {
  const ids = selectPersonIdsStmt.all().map((r) => r.id);
  let reduced = 0;
  const changes = [];
  for (const id of ids) {
    const r = reduceEntityDisplayName(id);
    if (r.changed) { reduced++; changes.push(r); }
  }
  return { scanned: ids.length, reduced, skipped: ids.length - reduced, changes };
}

// CLI only (not when imported for tests) — mirrors backfill-phone-aliases.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillDisplayNames();
  console.log(`Backfill complete: ${s.scanned} person entities scanned, ${s.reduced} reduced to first+last, ${s.skipped} unchanged.`);
  for (const c of s.changes) console.log(`  "${c.from}" → "${c.to}"`);
  db.close();
}
