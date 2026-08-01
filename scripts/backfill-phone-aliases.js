#!/usr/bin/env node
/**
 * Backfill the phone-alias canonicalization (#129) onto contacts imported before this change.
 * `normalizePhone` now strips a leading US/Canada `1` from an 11-digit key, so `+14155550148`
 * and `(415) 555-0148` share the key `4155550148`. Existing entities were aliased under the old
 * digit-strip-only key (e.g. `14155550148`), so a lookup in the other format never resolved.
 * This re-aliases every `alias_type='phone'` row under its canonical key.
 *
 * Append-only + idempotent + tombstone-respecting: new keys go in via insertAliasUnlessTombstoned
 * (skips a #111-removed alias, INSERT OR IGNORE on the UNIQUE key), the old key is left untouched
 * (harmless once lookups canonicalize). A second run adds 0. Re-importing the source vCards can't
 * do this (import:contacts skips a matched UID before reading content), which is why this is a
 * standalone backfill — mirrors npm run backfill:relations (#93).
 *   Run:  npm run backfill:phones
 */
import { pathToFileURL } from 'node:url';
import { db, normalizePhone, insertAliasUnlessTombstoned, logEvent } from '../src/db.js';

const selectPhoneAliasesStmt = db.prepare(`SELECT entity_id, alias FROM entity_aliases WHERE alias_type = 'phone'`);
// entity_aliases is UNIQUE(alias, alias_type) — a canonical key is single-owner. When an add returns
// 0 rows for a NEW key, it's because another entity already owns that key (first-writer-wins): the
// loser is then unreachable by that number until a merge. Surface those instead of hiding them.
const phoneOwnerStmt = db.prepare(`SELECT entity_id FROM entity_aliases WHERE alias = ? AND alias_type = 'phone'`);
// insertAliasUnlessTombstoned also returns 0 when the canonical key was DELIBERATELY removed for this
// entity (#111 tombstone) — that's a removal, not a cross-entity collision, so don't report it.
const isPhoneTombstonedStmt = db.prepare(`SELECT 1 FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = 'phone'`);

export function backfillPhoneAliases() {
  const rows = selectPhoneAliasesStmt.all();
  let aliasesAdded = 0;
  const collisions = []; // { loser, canonical, owner } — canonical key owned by a DIFFERENT entity
  const run = db.transaction(() => {
    for (const { entity_id, alias } of rows) {
      const canonical = normalizePhone(alias);
      if (!canonical || canonical === alias) continue; // already canonical / empty
      if (insertAliasUnlessTombstoned(entity_id, canonical, 'phone')) { aliasesAdded++; continue; }
      // Added 0: distinguish a cross-entity collision (loser becomes phone-unreachable) from a
      // same-entity duplicate (harmless — the contact already had both forms) or a #111 tombstone.
      if (isPhoneTombstonedStmt.get(entity_id, canonical)) continue; // deliberately removed, not a collision
      const owner = phoneOwnerStmt.get(canonical)?.entity_id;
      if (owner != null && owner !== entity_id) collisions.push({ loser: entity_id, canonical, owner });
    }
  });
  run();
  const summary = { phoneAliases: rows.length, aliasesAdded, collisions: collisions.length, collisionDetails: collisions };
  logEvent('phone_alias_backfill', 'backfill-phone-aliases.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-relations.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillPhoneAliases();
  console.log(`Backfill complete: ${s.phoneAliases} phone aliases scanned, ${s.aliasesAdded} canonical aliases added.`);
  if (s.collisions) {
    console.log(`${s.collisions} canonical key(s) already owned by a different entity — the losing contact is unreachable by that number until merged (review with listProbableDuplicates):`);
    for (const c of s.collisionDetails) console.log(`  entity ${c.loser} → "${c.canonical}" already owned by entity ${c.owner}`);
  }
  db.close();
}
