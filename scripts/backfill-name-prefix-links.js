#!/usr/bin/env node
/**
 * Backfill the unambiguous given-name-prefix fallback (#293) onto photo/connector hints staged
 * before resolveEntityHints gained it. A bare first-name `pictured` hint ("suzie") staged into
 * unresolved_aliases before this fix has no way to resolve itself retroactively — re-ingesting
 * the same photo is the only other trigger, and connectors don't replay old hints on their own.
 *
 * Links only — never mints an alias (#296). The first cut of this script added the bare given
 * name to entity_aliases so future ingests would hit the exact-match path. That was reverted:
 * UNIQUE(alias, alias_type) is globally single-owner per type, so a durable ('suzie','name') row
 * permanently routes every later bare-"suzie" hint through the exact path — bypassing the very
 * ambiguity guard that makes the inference safe — and a second Suzie imported later could never
 * own her own given name (INSERT OR IGNORE, first-writer-wins, silently). The inference is
 * re-checked on every ingest instead, so it self-corrects the moment a second candidate exists.
 *
 * All policy lives in resolveStagedNamePrefixHints (src/db.js) — the same tombstone guard and
 * NAME_PREFIX_CONFIDENCE_CAP the live ingest path applies, so the two cannot diverge.
 *
 * Idempotent: links are INSERT OR IGNORE, aliases are untouched. A second run forms 0 links.
 *   Run:  npm run backfill:name-prefix-links
 */
import { pathToFileURL } from 'node:url';
import { db, resolveStagedNamePrefixHints, logEvent } from '../src/db.js';

export function backfillNamePrefixLinks() {
  const summary = db.transaction(() => resolveStagedNamePrefixHints())();
  logEvent('name_prefix_link_backfill', 'backfill-name-prefix-links.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-entity-links.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillNamePrefixLinks();
  console.log(`Backfill complete: ${s.checked} unresolved name(s) checked, ${s.linksFormed} link(s) formed, ${s.stillUnresolved} still unresolved (no or ambiguous candidate, or tombstoned).`);
  db.close();
}
