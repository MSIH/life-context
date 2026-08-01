#!/usr/bin/env node
/**
 * Fill EMPTY profile fields on existing curated contacts from their side-directory card (#304).
 * 54 of 115 live person entities are thin (no addresses/birthday/anniversary/note/org/urls/dates/
 * nicknames) and 49 of those are names the directory already holds — the data was parsed at
 * `directory:load` time and, before #304, thrown away because the table had no columns for it.
 *
 * Precedence is the point: user-typed > existing non-empty > directory. fillEntityAttrsFromCard
 * only ever writes a key the entity leaves empty, never touches canonical_name / aliases /
 * relations / photoFile, and does NOT go through updateEntityAttrs (which overwrites wholesale).
 * A name that matches more than one card is skipped, not guessed.
 *
 * Not a scheduled job — a one-shot enrichment after a `directory:load` re-load (existing directory
 * rows carry no card_id until then). Idempotent: a second run fills 0. Back up life-context.db
 * first — this mutates up to 49 existing curated contacts.
 *   Run:  npm run backfill:directory-attrs
 */
import { pathToFileURL } from 'node:url';
import { db, getDirectoryCard, fillEntityAttrsFromCard, logEvent } from '../src/db.js';

// merged_into IS NULL: a tombstoned entity's profile is never enriched — mergeEntities already
// re-pointed its aliases at the survivor, which is the row that should carry the facts.
const selectLiveEntitiesStmt = db.prepare('SELECT id, canonical_name FROM entities WHERE merged_into IS NULL');
// Handle-first matching: an email/phone is the deterministic key (#129 normalization applies on both
// sides), so it beats the name fallback the same way getDirectoryCard orders them internally.
const selectEntityHandlesStmt = db.prepare(`SELECT alias, alias_type FROM entity_aliases WHERE entity_id = ? AND alias_type IN ('email','phone')`);

export function backfillDirectoryAttrs() {
  const entities = selectLiveEntitiesStmt.all();
  let matched = 0, filled = 0;
  const run = db.transaction(() => {
    for (const e of entities) {
      let card = null;
      for (const h of selectEntityHandlesStmt.all(e.id)) {
        card = getDirectoryCard({ handle: h.alias, handleType: h.alias_type });
        if (card) break;
      }
      card ??= getDirectoryCard({ name: e.canonical_name });
      if (!card) continue;                                   // no card (or an ambiguous name) — leave it alone
      matched++;
      if (fillEntityAttrsFromCard(e.id, card.attrs).filled.length) filled++;
    }
  });
  run();
  // skipped = matched but nothing to fill (already complete) — the interesting number, since an
  // unmatched entity was never a candidate. scanned - matched is how many had no card at all.
  const summary = { scanned: entities.length, matched, filled, skipped: matched - filled };
  logEvent('directory_attrs_backfill', 'backfill-directory-attrs.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-entity-links.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillDirectoryAttrs();
  console.log(`Backfill complete: ${s.scanned} entities scanned, ${s.matched} matched a card, ${s.filled} enriched, ${s.skipped} already complete.`);
  db.close();
}
