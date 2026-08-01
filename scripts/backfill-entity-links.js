#!/usr/bin/env node
/**
 * Backfill retroactive artifact->entity links (#102) for artifacts whose connector hints were
 * staged in unresolved_aliases before core had a resolver for them. The contacts importer now
 * calls resolveStagedArtifactHints on every import (the automatic steady-state path), but
 * artifacts ingested before that code existed were never swept — this runs the resolver over
 * every live entity once.
 *
 * Not a scheduled job — a one-shot heal, run by hand after deploy. Append-only + idempotent:
 * entity_links are INSERT OR IGNORE, so a second run forms 0 links.
 *   Run:  npm run backfill:links
 */
import { pathToFileURL } from 'node:url';
import { db, resolveStagedArtifactHints, logEvent } from '../src/db.js';

// merged_into IS NULL: never link to a tombstoned entity — mergeEntities already re-pointed its
// aliases to the survivor, so any matching hint resolves through the survivor instead.
const selectLiveEntityIdsStmt = db.prepare(`SELECT id FROM entities WHERE merged_into IS NULL`);

export function backfillEntityLinks() {
  const entities = selectLiveEntityIdsStmt.all();
  let linksFormed = 0;
  const run = db.transaction(() => {
    for (const e of entities) linksFormed += resolveStagedArtifactHints(e.id);
  });
  run();
  const summary = { entities: entities.length, linksFormed };
  logEvent('entity_link_backfill', 'backfill-entity-links.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-relations.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillEntityLinks();
  console.log(`Backfill complete: ${s.entities} entities, ${s.linksFormed} links formed.`);
  db.close();
}
