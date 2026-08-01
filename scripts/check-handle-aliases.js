#!/usr/bin/env node
/**
 * `npm run check:handle-aliases` — assert the "fields ⊆ aliases" invariant (#409):
 * `entity_aliases` is the ONLY table any matching path reads (data-model.md, `resolveEntityIds`'
 * own comment), but a contact's email/phone also lives in `entities.attrs_json` as the UI-facing
 * profile. Nothing else enforces that a profile value is also indexed, so a handle can be visible
 * on a contact card and simultaneously invisible to matching — silently, with no error and no log.
 *
 * Three permitted states per attrs.emails/attrs.phones value: aliased to its OWN entity, tombstoned
 * (#111, deliberately not matched), or owned by a DIFFERENT live entity (legitimate — see
 * data-model.md). Anything else — no entity_aliases row anywhere for that normalized value+type —
 * is a violation: visible on the card, invisible to matching.
 *
 * Deliberately opens its OWN read-only connection rather than importing src/db.js: db.js's module
 * load runs schema DDL, guarded migrations, and its own startup integrity pass — none of which this
 * check should trigger, and "read-only" should mean the SQLite connection itself is opened
 * `readonly: true` (mode=ro), not merely "this script happens not to call an INSERT". Duplicates the
 * two normalizers (normalizeName/normalizePhone) rather than importing them, matching
 * check-boundary.js's own "no deps" ethos for a script that must stay self-contained.
 *
 * That duplication is a deliberate trade with a guard, not a free pass: this check gates CI, so if
 * db.js's normalizer ever diverges from the copy below (the #129 NANP rule is the live example) the
 * gate would silently disagree with the writer it is checking — passing a violation, or flagging a
 * compliant value. `test/db.test.mjs` asserts the two implementations agree over a fixture set, so
 * the drift is caught by a red test rather than by a wrong verdict here.
 *
 * Never repairs anything (npm run backfill:handle-aliases is the separate, deliberate act). No
 * handle values are printed or logged — only entity ids, alias types, and counts (absolute rule 7).
 * Exit 0 clean; exit 1 listing each violation, one line per finding, plus a total.
 *   Run:  npm run check:handle-aliases
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { DB_PATH } from '../src/config.js';

const normalizeName = (s) => s.trim().toLowerCase();
const normalizePhone = (s) => { const d = s.replace(/\D/g, ''); return /^1\d{10}$/.test(d) ? d.slice(1) : d; };
// Mirrors src/db.js's HANDLE_ALIAS_FIELDS — the same key -> alias_type -> normalizer mapping,
// necessarily duplicated here since this script must not import db.js (see file header). Exported
// so the drift test can compare these normalizers against db.js's without shelling out.
export const HANDLE_ALIAS_FIELDS = [['emails', 'email', normalizeName], ['phones', 'phone', normalizePhone]];

/**
 * Assert the invariant over one DB file. Returns { missing, entitiesChecked, violations } and
 * NEVER exits the process or writes anything — the CLI wrapper below owns exit codes and output,
 * so a test can call this directly against its own temp DB.
 */
export function checkHandleAliases(dbPath = DB_PATH) {
  // A fresh checkout (or CI, which never leaves a life-context.db at the default path — every test
  // points DB_PATH at its own throwaway temp file) has no DB at all yet. `readonly: true` requires
  // the file to already exist; a missing DB trivially has zero live entities, so this is a pass, not
  // a crash — the same "nothing to check" posture check-boundary.js takes for a missing connectors/.
  if (!existsSync(dbPath)) return { missing: true, entitiesChecked: 0, violations: [] };

  const db = new Database(dbPath, { readonly: true });
  try {
    const selectLiveEntitiesStmt = db.prepare(
      `SELECT id, attrs_json FROM entities WHERE merged_into IS NULL AND attrs_json IS NOT NULL`
    );
    const resolveAliasByTypeStmt = db.prepare('SELECT DISTINCT entity_id FROM entity_aliases WHERE alias = ? AND alias_type = ?');
    const hasTombstoneStmt = db.prepare('SELECT 1 FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = ?');
    // The impact figure in each violation line: how many artifacts a fix would retroactively link —
    // the same "distinct staged hints" signal listDirectoryCandidates/listStrandedPicturedNames use.
    const countUnresolvedArtifactsStmt = db.prepare(
      `SELECT COUNT(DISTINCT artifact_id) AS n FROM unresolved_aliases WHERE alias = ? AND alias_type = ?`
    );

    let entitiesChecked = 0;
    const violations = [];
    for (const row of selectLiveEntitiesStmt.all()) {
      entitiesChecked++;
      let attrs;
      try { attrs = JSON.parse(row.attrs_json); } catch { continue; } // malformed attrs_json is not this check's concern
      for (const [key, aliasType, normalize] of HANDLE_ALIAS_FIELDS) {
        const values = Array.isArray(attrs?.[key]) ? attrs[key] : [];
        const seen = new Set();
        for (const raw of values) {
          if (typeof raw !== 'string') continue;
          const alias = normalize(raw);
          if (!alias || seen.has(alias)) continue;
          seen.add(alias);
          const owners = resolveAliasByTypeStmt.all(alias, aliasType).map((r) => r.entity_id);
          if (owners.length) continue; // aliased — to this entity, or legitimately to another (permitted)
          if (hasTombstoneStmt.get(row.id, alias, aliasType)) continue; // deliberately not matched (#111, permitted)
          violations.push({
            entity_id: row.id,
            alias_type: aliasType,
            unlinked_artifacts: countUnresolvedArtifactsStmt.get(alias, aliasType).n,
          });
        }
      }
    }
    return { missing: false, entitiesChecked, violations };
  } finally {
    db.close();
  }
}

// Run only as a CLI, not when imported for tests (mirrors backfill-handle-aliases.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { missing, entitiesChecked, violations } = checkHandleAliases();
  if (missing) {
    console.log(`handle-aliases OK (no database at ${DB_PATH} yet — nothing to check)`);
    process.exit(0);
  }
  if (violations.length) {
    console.error('handle-aliases VIOLATED — attrs.emails/attrs.phones values with no entity_aliases row anywhere (data-model.md "fields ⊆ aliases"):');
    for (const v of violations) console.error(`  entity_id=${v.entity_id} alias_type=${v.alias_type} unlinked_artifacts=${v.unlinked_artifacts}`);
    console.error(`  total: ${violations.length}`);
    process.exit(1);
  }
  console.log(`handle-aliases OK (${entitiesChecked} live entit${entitiesChecked === 1 ? 'y' : 'ies'} checked)`);
}
