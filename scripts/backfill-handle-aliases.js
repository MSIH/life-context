#!/usr/bin/env node
/**
 * Heal the historical "fields ⊆ aliases" drift (#409): for every live entity, reconcile
 * attrs.emails/attrs.phones against entity_aliases (reconcileHandleAliases, explicit:false —
 * respects a tombstone, #111, and never steals a handle owned by a different entity) and sweep
 * the staged unresolved_aliases backlog so a newly-aliased value retroactively links every
 * artifact that already named it (resolveStagedArtifactHints). This is the same class of gap
 * #295 fixed for the contacts-UI write paths, applied here to the historical population instead
 * of a live write.
 *
 * Transaction shape differs by mode, deliberately:
 *   - real run: ONE db.transaction PER ENTITY, so one bad row can't roll back the whole heal and
 *     the write lock is released between entities. That matters here because resolveStagedArtifactHints
 *     forms every missing link for the entity it sweeps, which data-model.md already flags as
 *     write-lock-heavy on a large backlog — holding one transaction across the whole population
 *     would block every other writer for the duration of the run.
 *   - --dry-run: one enclosing transaction over ALL entities, always ROLLED BACK (mirrors
 *     src/db.js's tightenNotNull rollback-on-orphan idiom). A rollback is the only way to run the
 *     REAL write path and still write nothing, which is what keeps a dry run from drifting from
 *     what a real run would report; per-entity transactions can't be undone once committed.
 * Either way a dry run leaves nothing behind — no aliases, no links, no ingest_log row.
 *
 * Idempotent: a second real run adds 0 aliases, forms 0 links, and — since nothing changed — logs
 * no ingest_log row (mirrors backfillDirectoryProposals/sweepStagedHints' "a no-op re-run is not
 * an event" discipline).
 *
 * Back up life-context.db before a real run (repo convention for every backfill:*).
 *   Run:  npm run backfill:handle-aliases [-- --dry-run]
 */
import { pathToFileURL } from 'node:url';
import { db, listLiveEntityHandleAttrs, reconcileHandleAliases, resolveStagedArtifactHints, logEvent } from '../src/db.js';

// Exported so tests can exercise the parsing rule directly, not just by shelling out.
export function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

const DRY_RUN_ROLLBACK = '__DRY_RUN_ROLLBACK__';

export function backfillHandleAliases({ dryRun = false } = {}) {
  const entities = listLiveEntityHandleAttrs();
  let aliasesAdded = 0, linksFormed = 0, skippedTombstoned = 0, skippedForeign = 0;
  // The per-entity unit of work, identical in both modes — only its transaction boundary differs.
  const healOne = (e) => {
    const res = reconcileHandleAliases(e.id, e.attrs, { explicit: false });
    aliasesAdded += res.added;
    skippedTombstoned += res.skippedTombstoned.length;
    skippedForeign += res.skippedForeign.length;
    if (res.added > 0) linksFormed += resolveStagedArtifactHints(e.id);
  };
  const healOneTxn = db.transaction(healOne);
  // A dry run must leave no trace, so it wraps the whole population in one transaction and throws
  // to roll it back; a real run commits per entity (see the header note on lock hold time).
  const dryRunAttempt = db.transaction(() => {
    for (const e of entities) healOne(e);
    throw new Error(DRY_RUN_ROLLBACK);
  });
  if (dryRun) {
    try { dryRunAttempt(); } catch (err) { if (err.message !== DRY_RUN_ROLLBACK) throw err; }
  } else {
    for (const e of entities) healOneTxn(e);
  }

  const summary = { entities: entities.length, aliasesAdded, linksFormed, skippedTombstoned, skippedForeign, dryRun };
  if (!dryRun && (aliasesAdded > 0 || linksFormed > 0)) {
    logEvent('handle_aliases_backfill', 'backfill-handle-aliases.js', summary);
  }
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-pictured-proposals.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const s = backfillHandleAliases({ dryRun });
  console.log(
    `${s.dryRun ? '[dry run] ' : ''}handle-aliases backfill: ${s.entities} live entities scanned, ` +
    `${s.aliasesAdded} alias(es) added, ${s.linksFormed} link(s) formed, ` +
    `${s.skippedTombstoned} skipped (tombstoned), ${s.skippedForeign} skipped (foreign-owned).`
  );
  if (dryRun) console.log('Nothing was written. Re-run without --dry-run to apply.');
  db.close();
}
