#!/usr/bin/env node
/**
 * Stage review proposals for the historical `pictured` name hints (#350) that photo-exif already
 * staged in unresolved_aliases but that resolve to nobody — a Google Photos sidecar people[] tag
 * (or the folder-name fallback) for someone who isn't a contact. Approving one staged proposal
 * mints the person AND retro-links every photo that named them (approveProposedEntity ->
 * resolveStagedArtifactHints) — this script's only write is the proposed_entities row; it creates
 * ZERO entities and mints nothing on its own.
 *
 * Frequency-ordered by distinct-artifact impact (computed before --limit is applied), so the
 * highest-traffic stranded name is reviewed first. Skips a name that already resolves — an exact
 * entity_aliases match, or the #293 unambiguous given-name-prefix inference — and a name with an
 * already-pending/approved/rejected proposal (idempotent; a rejected name is never re-raised, per
 * #300's deliberate explicit-reopen design). The heavy lifting lives in db.js's
 * stagePicturedProposals so it shares the store's prepared statements; this is the thin CLI
 * wrapper. Folder-name hints are in scope and can stage a non-person (a folder like "Cape May
 * 2019") — expected and acceptable, since staging is not promoting: reject it in one click.
 *
 *   Run:  npm run backfill:pictured-proposals [-- --limit <n>] [-- --dry-run]
 */
import { pathToFileURL } from 'node:url';
import { db, stagePicturedProposals } from '../src/db.js';

// Exported so tests can exercise the parsing rules directly, not just by shelling out.
// `--limit 0` is deliberately VALID (stagePicturedProposals({limit:0}) means "stage nothing" —
// tested in db.test.mjs), so the floor here is 0, not 1. `--limit` with no following value must
// fail fast rather than silently fall through to "no limit" (limit=null) — the opposite of what
// someone typing `--limit` with a typo'd/dropped value almost certainly intended, on a command
// that writes rows.
export function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  let limit = null;
  if (limitIdx >= 0) {
    const raw = argv[limitIdx + 1];
    limit = raw == null ? NaN : Number(raw);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`--limit must be a non-negative integer, got: ${raw ?? '(missing)'}`);
    }
  }
  return { dryRun, limit };
}

// Run only as a CLI, not when imported for tests (mirrors backfill-directory-proposals.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const s = stagePicturedProposals({ limit, dryRun });
  console.error(`photo-exif pictured proposals — ${s.namesScanned} stranded name(s) over ${s.artifactsScanned} artifact(s)`);
  console.error(`  skipped ${s.skippedExact + s.skippedPrefix} (already resolve: ${s.skippedExact} exact alias, ${s.skippedPrefix} name-prefix inference)`);
  console.error(`  skipped ${s.skippedDecided} (already staged / decided)`);
  console.error(`  ${dryRun ? 'would stage' : 'staged'} ${s.staged} proposal(s), suggested_kind=person`);
  if (s.topImpact.length) console.error(`  top by impact: ${s.topImpact.join(', ')} artifact(s)`);
  if (dryRun) console.error('Nothing was written. Re-run without --dry-run to apply.');
  db.close();
}
