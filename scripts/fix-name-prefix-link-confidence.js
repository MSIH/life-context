#!/usr/bin/env node
/**
 * One-shot correction (#296): the mint-era run of the #293 backfill (2026-07-25 17:23) recorded
 * every prefix-inferred link at NAME_HANDLE_CONFIDENCE_CAP (0.9) — the tier reserved for a
 * connector-supplied *exact* name match. From #296 onward an inference is capped at
 * NAME_PREFIX_CONFIDENCE_CAP (0.6). Without this, links written that evening keep passing
 * themselves off as exact matches: identical evidence, two different stories by accident of
 * timing, and a later "show me the shaky links" review skips precisely the guesses worth
 * checking — which here are guesses about who is in a photo.
 *
 * ONLY-BASIS GUARD. Links carry no provenance, so the correction works backwards from the
 * staged hint: a link is corrected only when it sits at exactly NAME_HANDLE_CONFIDENCE_CAP AND
 * its artifact has a staged bare-name hint, under that same role, that resolves by prefix to that
 * same entity. A link the artifact earned some other way is never touched. Verified unambiguous on the live DB
 * before writing this: for all four affected entities the 0.9-link count equalled the staged-hint
 * count exactly, with zero 0.9 links from any other basis (2342/190/66/104, and 1.0 links
 * untouched).
 *
 * This UPDATEs existing rows, which the append-only rule normally forbids. Permitted on the same
 * reasoning as the ingest upsert path (data-model.md): confidence is a derived judgment *about* a
 * link, not an original, no original field is touched, and the change is recorded in ingest_log.
 * Back up the .db first.
 *
 * Idempotent: once corrected the rows no longer sit at 0.9, so a second run updates 0.
 *   Run:  npm run fix:name-prefix-confidence
 */
import { pathToFileURL } from 'node:url';
import { db, NAME_HANDLE_CONFIDENCE_CAP, NAME_PREFIX_CONFIDENCE_CAP, resolveNameByPrefix, listUnresolvedNamePrefixAliases, logEvent } from '../src/db.js';

// The only-basis guard, as SQL: this artifact staged THIS bare name against THIS entity, and the
// link is still sitting at the exact-match tier.
// u.role = <link>.role is load-bearing, not decoration: entity_links' PK is (artifact_id,
// entity_id, role), so one artifact can hold several links to the same entity. The mint-era
// backfill wrote its links through resolveStagedArtifactHints, which carries the staged hint's
// OWN role — so correlating role is what makes this "the rows that run wrote" rather than "every
// 0.9 link on an artifact that happens to have staged this name". Without it, an exact full-name
// match under a different role gets demoted alongside them.
const countMisTieredStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM entity_links l
  WHERE l.entity_id = @entityId AND l.confidence = @exactCap
    AND EXISTS (SELECT 1 FROM unresolved_aliases u
                WHERE u.artifact_id = l.artifact_id AND u.alias = @alias AND u.alias_type = 'name'
                  AND u.role != 'relation' AND u.role = l.role)
`);
const correctMisTieredStmt = db.prepare(`
  UPDATE entity_links SET confidence = @inferredCap
  WHERE entity_id = @entityId AND confidence = @exactCap
    AND EXISTS (SELECT 1 FROM unresolved_aliases u
                WHERE u.artifact_id = entity_links.artifact_id AND u.alias = @alias AND u.alias_type = 'name'
                  AND u.role != 'relation' AND u.role = entity_links.role)
`);

export function fixNamePrefixLinkConfidence({ dryRun = false } = {}) {
  const aliases = listUnresolvedNamePrefixAliases();
  const corrected = [];
  let linksCorrected = 0;
  const run = db.transaction(() => {
    for (const alias of aliases) {
      // Deliberately resolveNameByPrefix, NOT the ingest path's tombstone-guarded helper: this
      // repairs links that already exist. A since-tombstoned alias must still have its historical
      // links re-tiered — skipping it would leave exactly the mislabelled rows this exists to fix.
      const [entityId] = resolveNameByPrefix(alias);
      if (entityId == null) continue;
      const params = { entityId, alias, exactCap: NAME_HANDLE_CONFIDENCE_CAP, inferredCap: NAME_PREFIX_CONFIDENCE_CAP };
      const n = dryRun ? countMisTieredStmt.get(params).n : correctMisTieredStmt.run(params).changes;
      if (n) { linksCorrected += n; corrected.push({ alias, entity_id: entityId, links: n }); }
    }
  });
  run();
  const summary = { checked: aliases.length, linksCorrected, from: NAME_HANDLE_CONFIDENCE_CAP, to: NAME_PREFIX_CONFIDENCE_CAP, corrected, dryRun };
  // A dry run inspects only — it must leave no trace, or the log stops meaning "rows changed".
  if (!dryRun) logEvent('name_prefix_confidence_corrected', 'fix-name-prefix-link-confidence.js', summary);
  return summary;
}

// Run only as a CLI, not when imported for tests (mirrors backfill-entity-links.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const s = fixNamePrefixLinkConfidence({ dryRun });
  console.log(`${dryRun ? 'Dry run' : 'Correction complete'}: ${s.checked} unresolved name(s) checked, ${s.linksCorrected} link(s) ${dryRun ? 'would move' : 'moved'} from ${s.from} to ${s.to}.`);
  for (const c of s.corrected) console.log(`  ${c.alias} -> entity ${c.entity_id}: ${c.links}`);
  if (dryRun) console.log('Nothing was written. Re-run without --dry-run to apply.');
  db.close();
}
