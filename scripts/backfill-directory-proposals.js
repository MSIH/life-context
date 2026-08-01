#!/usr/bin/env node
/**
 * Stage review proposals for the historical unmatched handles that the side contact directory
 * (#154) can now name. Resolution runs at ingest time, so the ~20k phone/email hints already
 * parked in unresolved_aliases don't retroactively benefit when the directory is loaded later —
 * this backfill walks them, and for every one the directory knows, stages a person proposal with
 * the name pre-filled (frequency-ordered, so the highest-traffic numbers surface first).
 *
 * Creates NO entities — promotion stays a human approval in the review queue. Idempotent
 * (proposed_entities' UNIQUE absorbs re-runs) and skips a handle that has since become curated.
 * The heavy lifting lives in db.js's backfillDirectoryProposals so it shares the store's prepared
 * statements; this is the thin CLI wrapper. Run AFTER `npm run directory:load`.
 *   Run:  npm run backfill:directory-proposals
 */
import { pathToFileURL } from 'node:url';
import { db, backfillDirectoryProposals } from '../src/db.js';

// CLI only (not when imported for tests) — mirrors backfill-phone-aliases.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = backfillDirectoryProposals();
  console.log(`Backfill complete: ${s.scanned} distinct unmatched handle(s) scanned, ${s.proposed} directory proposal(s) staged for review.`);
  db.close();
}
