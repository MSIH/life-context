#!/usr/bin/env node
/**
 * Backfill the entity-resolution improvements (#93) onto contacts imported before this change.
 * The importer now generates given+family and nickname+family name aliases and parses the
 * Google/Android X-* relationship props — but existing entities were stored under the old
 * exact-FN aliases, so relationships that depended on a middle-name-dropped or nickname+family
 * match never formed. This regenerates the alias variants for every person entity and re-runs
 * the staged-relation resolver so those edges form now.
 *
 * Append-only + idempotent: aliases and edges are INSERT OR IGNORE; a second run adds 0 aliases
 * and forms 0 edges. Re-importing the source vCards can't do this (import:contacts skips a
 * matched UID before it looks at content), which is why this is a standalone backfill.
 *   Run:  npm run backfill:relations
 */
import { pathToFileURL } from 'node:url';
import { db, insertAliasStmt, nameVariants, resolveRelationHints, logEvent } from '../src/db.js';

const selectPersonsStmt = db.prepare(`SELECT id, canonical_name, attrs_json FROM entities WHERE kind = 'person'`);

export function backfillRelations() {
  const persons = selectPersonsStmt.all();
  let aliasesAdded = 0, edgesFormed = 0;
  const run = db.transaction(() => {
    // Pass 1: enrich aliases for every person, so pass 2 can match against the full set
    // regardless of entity order. canonical_name is the only name we have here (the structured
    // N split isn't persisted on the entity), so nameVariants tokenizes it (first + last).
    for (const e of persons) {
      let nicknames = [];
      try { nicknames = JSON.parse(e.attrs_json ?? '{}')?.nicknames ?? []; } catch { /* attrs_json absent/legacy */ }
      for (const alias of nameVariants({ fn: e.canonical_name, nicknames })) {
        aliasesAdded += insertAliasStmt.run(e.id, alias, 'name').changes;
      }
    }
    // Pass 2: form any staged relation whose target now resolves to one of the new aliases.
    for (const e of persons) edgesFormed += resolveRelationHints(e.id);
  });
  run();
  const summary = { entities: persons.length, aliasesAdded, edgesFormed };
  logEvent('relation_backfill', 'backfill-relations.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors contacts.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillRelations();
  console.log(`Backfill complete: ${s.entities} entities, ${s.aliasesAdded} aliases added, ${s.edgesFormed} edges formed.`);
  db.close();
}
