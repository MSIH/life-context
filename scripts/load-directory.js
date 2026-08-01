#!/usr/bin/env node
/**
 * Load a side contact directory (#154) from a full contacts export. This is a handle -> name
 * LOOKUP, deliberately SEPARATE from the curated entity graph: it creates NO entities/aliases.
 * Its only jobs downstream are (a) auto-labeling unknown handles for display and (b) staging
 * proposed_entities (name pre-filled) for review — promotion into the curated graph stays a
 * human-approved act (the whole point of keeping ~1000 contacts out of the graph).
 *
 * Reuses src/contacts.js's vCard parser; every phone/email of every card becomes one
 * contact_directory row keyed by its normalized handle (normalizePhone / lowercased email, #129).
 * Each card ALSO writes one directory_cards row carrying its full parsed profile (#304) — addresses,
 * birthday, anniversary, org/title, urls, nicknames — so a promoted entry (#299) arrives with a real
 * profile instead of just a name and handles, and `npm run backfill:directory-attrs` can fill the
 * empty fields of contacts imported before this existed.
 * Idempotent: UNIQUE(handle, handle_type) is first-writer-wins, a collision is logged, a re-run
 * loads 0 new rows and merges 0 cards. CSV exports are out of scope for now (vCard only).
 *   Run:  npm run directory:load <file.vcf>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { db, insertDirectoryEntry, upsertDirectoryCard, logEvent, sha256 } from '../src/db.js';
import { parseVCards, preferredDisplayName, contactAttrs } from '../src/contacts.js';

const directoryCountStmt = db.prepare('SELECT COUNT(*) AS n FROM contact_directory');

export function loadDirectory(text) {
  const cards = parseVCards(text);
  let contacts = 0, loaded = 0, collisions = 0, cardsLoaded = 0, cardsMerged = 0, adopted = 0;
  const run = db.transaction(() => {
    for (const c of cards) {
      // #158: first+last (drops a middle name), same rule as the curated display (#156); fall back
      // to the email as the label when a card has no FN but is addressable (parseVCards keeps those),
      // mirroring the import path's `preferredDisplayName(c) || c.emails[0]` — else we'd silently drop
      // directory coverage for nameless-but-addressable contacts (Copilot, PR #160).
      const name = (preferredDisplayName(c) || c.emails[0] || '').trim();
      if (!name) continue; // truly unlabelable (no name, no email) — nothing to show
      contacts++;
      // The card profile is written FIRST: contact_directory.card_id is a real FK and
      // foreign_keys = ON, so the parent row must exist before any handle row points at it (#304).
      // card_key = the vCard UID when present, else a hash of the card text — the same ladder
      // importOneCard uses, so an edited no-UID card lands as a new card (documented caveat).
      const card = upsertDirectoryCard({ card_key: (c.uid ?? '').trim() || sha256(c.raw ?? name), name, attrs: contactAttrs(c) });
      if (card.created) cardsLoaded++; else if (card.merged) cardsMerged++;
      // `adopted` counts pre-#304 rows this run linked to their card — the observable proof that
      // re-loading an existing directory actually upgraded it (it is 0 on a fresh load and on any
      // subsequent re-run, so it also shows when there is nothing left to adopt).
      for (const p of c.phones ?? []) { const r = insertDirectoryEntry(name, p, 'phone', card.id); if (r.inserted) loaded++; if (r.collision) collisions++; if (r.adopted) adopted++; }
      for (const e of c.emails ?? []) { const r = insertDirectoryEntry(name, e, 'email', card.id); if (r.inserted) loaded++; if (r.collision) collisions++; if (r.adopted) adopted++; }
    }
  });
  run();
  // total = distinct handles now in the directory (each row is one (handle, handle_type)); lets a
  // re-run confirm idempotency (loaded 0, total unchanged) and shows the directory size (#155).
  const summary = { contacts, loaded, collisions, cards: cardsLoaded, cardsMerged, adopted, total: directoryCountStmt.get().n };
  logEvent('directory_load', 'load-directory.js', summary);
  return summary;
}

// CLI only (not when imported for tests) — mirrors backfill-phone-aliases.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: npm run directory:load <file.vcf>'); process.exit(1); }
  const s = loadDirectory(readFileSync(file, 'utf8'));
  console.log(`directory:load — ${s.contacts} contacts, ${s.loaded} handle(s) loaded, ${s.collisions} collision(s), ${s.cards} card(s) loaded, ${s.cardsMerged} merged, ${s.adopted} existing handle(s) linked to a card; ${s.total} handle(s) in directory total.`);
  db.close();
}
