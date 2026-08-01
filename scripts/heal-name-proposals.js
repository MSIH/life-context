#!/usr/bin/env node
/**
 * One-shot heal for the stale pending proposals identified in #413 (name-keyed) and widened by
 * #484 to email/phone-keyed: a proposal staged on alias_type IN ('name','email','phone')
 * (person/org only — a place/event's identity is its staged geo/span, never a name) whose staged
 * alias already resolves to exactly one live entity (promotion/approval minted the person after
 * the proposal was staged, or #409's backfill:handle-aliases later indexed a profile field that
 * wasn't in entity_aliases yet, but the old healing loops only ever iterated HANDLES-via-#413's-
 * name-only-scan, so these survived). For each such row, resolves it to the matching entity via
 * resolveHandle — the same identity rule approveProposedEntity and promoteDirectoryName apply.
 * Ambiguous (>1 live match) or unmatched (0) rows are left pending, untouched — this heal never
 * guesses. An email/phone-keyed proposal only resolves once its handle is actually an alias
 * (npm run backfill:handle-aliases is a precondition, not a dependency this script checks).
 *
 * Writes NO new proposed_entities row and mints NO entity; it only resolves rows that already
 * describe someone who exists. Idempotent (a healed row is no longer 'pending', so a second run
 * resolves 0). Status-guarded against a concurrent approve/reject from the live service. The heavy
 * lifting lives in db.js's healNameProposals so it shares the store's prepared statements; this is
 * the thin CLI wrapper.
 *   Run:  npm run heal:name-proposals [-- --dry-run]
 */
import { pathToFileURL } from 'node:url';
import { db, healNameProposals } from '../src/db.js';

// Exported so tests can exercise the parsing rules directly, not just by shelling out (mirrors
// backfill-pictured-proposals.js). Fails fast on an unrecognized flag — a typo'd/dropped --dry-run
// must not silently fall through to a real, terminal write against the live DB.
export function parseArgs(argv) {
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(', ')} — the only flag is --dry-run`);
  return { dryRun: argv.includes('--dry-run') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const s = healNameProposals({ dryRun });
  const byTypeStr = Object.entries(s.byType).map(([t, n]) => `${t} ${n}`).join(', ');
  console.error(`handle-keyed proposals — ${s.scanned} pending person/org row(s) scanned (${byTypeStr})`);
  console.error(`  ${dryRun ? 'would resolve' : 'resolved'} ${s.resolved} (already minted, exactly one live match), ${s.linked} staged hint(s) retro-linked`);
  console.error(`  skipped ${s.skippedNoMatch} (no live entity answers to this handle), ${s.skippedAmbiguous} (ambiguous — more than one live match), ${s.skippedRaced} (changed concurrently — re-run to pick up)`);
  if (dryRun) console.error('Nothing was written. Re-run without --dry-run to apply.');
  db.close();
}
