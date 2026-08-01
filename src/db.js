/**
 * The store. Single authority for the SQLite/sqlite-vec schema, the write transaction,
 * and the append-only ingest log. Opened once and shared by the server and every
 * headless script (migrate, connectors) so the enrich-then-commit discipline and the
 * BigInt vec0-PK rule live in exactly one place.
 *
 * OB2 Phase 2.0 schema (docs/03-ob2-design.md §2): a unified `artifacts` table, an
 * entity graph, and hybrid search indexes (vec0 + FTS5). Created idempotently at import.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DB_PATH, VECTOR_DIMENSION, DB_BUSY_TIMEOUT_MS } from './config.js';
import { log } from './logger.js';
import { haversineKm } from './geocode.js';
import { isExtensionType } from './ingest-types.js';

export const db = new Database(DB_PATH);
sqliteVec.load(db);
db.pragma('journal_mode = WAL'); // concurrent readers (data-model.md rule 5)
db.pragma('foreign_keys = ON');  // enforce REFERENCES clauses — per-connection, defaults OFF (#110)
db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`); // wait out a brief competing writer instead of throwing SQLITE_BUSY instantly (#224)

// --- SCHEMA (idempotent; VECTOR_DIMENSION must match the embedding model — rule 2) ---
db.exec(`
  -- Unified artifact: every email/photo/doc/note is an event with time, place, text.
  CREATE TABLE IF NOT EXISTS artifacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,        -- registered type (src/ingest-types.js) or an x- extension
    source        TEXT NOT NULL,        -- gmail|icloud|filesystem|vcard|ob1-migration|manual
    source_id     TEXT,                 -- provider's id (dedup key)
    content_hash  TEXT,                 -- sha256 of raw bytes (dedup + integrity)
    occurred_at   DATETIME,             -- when it HAPPENED (nullable)
    ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    latitude      REAL,
    longitude     REAL,
    place_label   TEXT,
    raw_path      TEXT,                 -- pointer to original on disk (never the blob)
    text_repr     TEXT NOT NULL,        -- normalized text — this gets embedded
    extra_json    TEXT,                 -- type-specific fields (headers, EXIF, …)
    UNIQUE(source, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_time ON artifacts(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(content_hash);

  -- Entity graph: contacts are the spine; artifacts link to people/places/orgs.
  CREATE TABLE IF NOT EXISTS entities (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,       -- person|place|org|event|topic
    canonical_name TEXT NOT NULL,
    attrs_json     TEXT,                -- emails[], phones[], birthday, relationship, …
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Identity resolution: "Mom", an email, a phone, and a full name are one entity.
  CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id  INTEGER NOT NULL REFERENCES entities(id),
    alias      TEXT NOT NULL,           -- normalized (lowercase names/emails, digits-only phones)
    alias_type TEXT NOT NULL,           -- email|phone|name|handle
    UNIQUE(alias, alias_type)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);

  -- Deliberately-removed aliases (#111). A removal records a tombstone here so a later ADDITIVE
  -- write (contact import/re-import #94, a profile edit, hint resolution) can't silently resurrect
  -- it; an explicit user addAlias clears (DELETEs) the tombstone (user intent overrides). Scoped
  -- per entity — removing "chris" from one person doesn't suppress it on another. Inserts are
  -- idempotent (OR IGNORE on the UNIQUE key); rows are cleared only by an explicit re-add, so this
  -- is not strictly append-only. The UNIQUE(entity_id, alias, alias_type) index also serves the
  -- hasTombstone lookup — no separate index needed.
  CREATE TABLE IF NOT EXISTS alias_tombstones (
    entity_id  INTEGER NOT NULL REFERENCES entities(id),
    alias      TEXT NOT NULL,           -- normalized identically to entity_aliases
    alias_type TEXT NOT NULL,           -- email|phone|name|handle
    removed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_id, alias, alias_type)
  );
  -- Human "not a duplicate" decisions on a candidate pair from listProbableDuplicates (#302).
  -- Canonical key a<b (CHECK enforces it, matching addPair's Math.min/Math.max convention below —
  -- a comment saying "normalized like addPair" rots, a CHECK cannot). UNIQUE also serves the
  -- suppression lookup, no separate index. Cleared only by explicit clear-all (like alias_tombstones,
  -- this is NOT strictly append-only — it holds curation state, not a stored memory/artifact, so
  -- design-philosophy's append-only doctrine doesn't apply here). score/reason are the detector's
  -- output AS SHOWN TO THE USER at dismissal time, kept for audit only — never re-consulted, so a
  -- dismissal is absolute until cleared (no score-gated re-surfacing). A row can outlive one side
  -- being merged into another entity; that's inert, not orphaned — listLivePersonEntitiesStmt's
  -- merged_into IS NULL filter means the pair can never regenerate, so leaving the row is harmless
  -- and preserves the record that a human once judged those two distinct.
  CREATE TABLE IF NOT EXISTS duplicate_dismissals (
    entity_a_id         INTEGER NOT NULL REFERENCES entities(id),
    entity_b_id         INTEGER NOT NULL REFERENCES entities(id),
    score_at_dismissal  REAL,
    reason_at_dismissal TEXT,
    dismissed_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_a_id, entity_b_id),
    CHECK(entity_a_id < entity_b_id)
  );
  CREATE TABLE IF NOT EXISTS entity_links (
    artifact_id INTEGER REFERENCES artifacts(id),
    entity_id   INTEGER REFERENCES entities(id),
    role        TEXT NOT NULL,          -- sender|recipient|pictured|mentioned|author|self|location_of
    confidence  REAL DEFAULT 1.0,       -- 1.0 deterministic; <1.0 inferred
    PRIMARY KEY (artifact_id, entity_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_links_entity ON entity_links(entity_id);

  -- Staging for connector hints that miss entity_aliases (connector contract doc 04 §4).
  -- UNIQUE is an additive deviation from the doc's DDL sketch: makes resolveEntityHints
  -- idempotent by construction, matching entity_links' own PK + OR IGNORE discipline.
  CREATE TABLE IF NOT EXISTS unresolved_aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id     INTEGER REFERENCES artifacts(id),
    alias           TEXT NOT NULL,       -- normalized (lowercase; digits-only phones)
    alias_type      TEXT NOT NULL,       -- email|phone|name|handle
    role            TEXT NOT NULL,
    hint_confidence REAL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(artifact_id, alias, alias_type, role)
  );
  CREATE INDEX IF NOT EXISTS idx_unresolved_alias ON unresolved_aliases(alias, alias_type);

  -- Proposed entities (#119): the human-approval gate for entities auto-proposed from ARTIFACT
  -- signals (a document vendor, an email sender) via an entity hint's suggested_kind flag. An
  -- unmatched such hint stages a proposal here INSTEAD of minting the entity, so low-signal
  -- senders (noreply@, marketing, one-off vendors) can't silently pollute the graph. Approve →
  -- create + retroactively link; reject → kept (append-only) so re-ingest never re-raises it.
  -- Gates ONLY the connector-ingest lane; contact import (trusted) creates entities directly.
  -- UNIQUE makes proposeEntity idempotent, mirroring unresolved_aliases' discipline.
  CREATE TABLE IF NOT EXISTS proposed_entities (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    suggested_kind     TEXT NOT NULL,                   -- person|org|place (free-text; #137)
    suggested_name     TEXT NOT NULL,
    alias              TEXT NOT NULL,                   -- normalized resolution key
    alias_type         TEXT NOT NULL,                   -- email|phone|name|handle
    artifact_id        INTEGER REFERENCES artifacts(id),
    source             TEXT,
    confidence         REAL,
    status             TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
    resolved_entity_id INTEGER REFERENCES entities(id),
    attrs_json         TEXT,                            -- staged geo/span for a place/event proposal (#137); NULL for person/org
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(suggested_name, alias, alias_type)
  );
  CREATE INDEX IF NOT EXISTS idx_proposed_status ON proposed_entities(status);

  -- Side contact directory (#154): a handle -> name LOOKUP loaded from the user's full contacts
  -- export. Deliberately NOT entities/entity_aliases — the curated entity graph only grows by
  -- explicit approval. A directory hit on an unresolved handle (a) auto-labels it for display and
  -- (b) stages a proposed_entities row (name pre-filled) for review. Nothing here is an entity, has
  -- an embedding, or references entities. Handle is normalized (normalizePhone / lowercased email);
  -- UNIQUE(handle, handle_type) makes the loader idempotent (first-writer-wins on a shared number,
  -- mirroring entity_aliases discipline). name may repeat (a contact has several handles).
  CREATE TABLE IF NOT EXISTS contact_directory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    handle      TEXT NOT NULL,
    handle_type TEXT NOT NULL CHECK(handle_type IN ('phone','email')),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(handle, handle_type)
  );
  -- The name column was write-only until #299 made the directory browsable: listDirectoryCandidates
  -- groups BY name, correlates handles back to their group, and selectDirectoryHandlesByNameStmt
  -- looks a group up by exact name. BINARY collation deliberately (not NOCASE): every one of those is
  -- an equality compare in the default collation, which a NOCASE index cannot serve — measured on the
  -- real DB, a NOCASE index left the query= path at 394ms (1,569 names x a 2,888-row scan). The name
  -- SEARCH itself is a leading-wildcard LIKE, which no index can serve, so nothing is lost.
  CREATE INDEX IF NOT EXISTS idx_directory_name ON contact_directory(name);

  -- The per-card profile behind that directory (#304). One row per vCard CARD, where
  -- contact_directory is one row per HANDLE (1,569 names span 2,888 handle rows, up to 7 each) — so
  -- per-handle storage would duplicate the profile ~1.8x and leave "which row owns her birthday?"
  -- undefined. card_key is the card's vCard UID, else a sha256 of the card text: the same dedup
  -- ladder importOneCard uses, so the directory and the importer agree on what "the same card" is
  -- (with the same caveat — an edited no-UID card lands as a new card). attrs_json holds the parsed
  -- contactAttrs profile and NOT the raw vCard text (explicit decision: wanting a new field later
  -- needs a schema change AND a re-load, in exchange for not duplicating the export into the DB).
  -- Still deliberately outside the entity graph: no embedding, no FK to entities, nothing here is
  -- an entity until #299 promotes it. Merge on re-load is append-if-exists (upsertDirectoryCard).
  CREATE TABLE IF NOT EXISTS directory_cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    card_key   TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    attrs_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
  -- Name lookup for getDirectoryCard's fallback + #299's browse; NOCASE matches the query's collation.
  CREATE INDEX IF NOT EXISTS idx_directory_cards_name ON directory_cards(name COLLATE NOCASE);

  -- Entity<->entity edges (issue #37; person->org added #88). entity_links joins
  -- artifacts->entities; this joins entities to each other (spouse/child/parent/…, and a
  -- person's worksAt->org). Append-only + idempotent via the UNIQUE key + OR IGNORE, mirroring
  -- entity_links. Kind-agnostic columns. Directional: from_entity_id = the contact owner (or the
  -- employee), to_entity_id = the related person (or the employer org); asymmetric; confidence
  -- 1.0 for an explicit contact field.
  CREATE TABLE IF NOT EXISTS entity_relations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity_id INTEGER NOT NULL REFERENCES entities(id),
    to_entity_id   INTEGER NOT NULL REFERENCES entities(id),
    relation_type  TEXT NOT NULL,       -- canonical vocab (RELATION_TYPE_MAP) or 'custom'
    raw_label      TEXT,                -- original source label, preserved (esp. for 'custom')
    confidence     REAL DEFAULT 1.0,
    source         TEXT,                -- vcard|…
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_entity_id, to_entity_id, relation_type)
  );
  CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relations_to ON entity_relations(to_entity_id);

  -- Semantic index (dim MUST equal the embedding model's output).
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifacts USING vec0(
    artifact_id INTEGER PRIMARY KEY,
    embedding float[${VECTOR_DIMENSION}]
  );
  -- Keyword/exact index — vectors miss proper nouns and exact strings.
  CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
    text_repr, content='artifacts', content_rowid='id'
  );
  -- Keep FTS in sync with this external-content table. INSERT feeds the new row in. The
  -- ingest upsert path (src/ingest.js) rewrites text_repr in place when an enrichment wave
  -- arrives, so an AFTER UPDATE OF text_repr trigger does the external-content delete+reinsert
  -- dance: 'delete' MUST carry the OLD text_repr so FTS removes the right terms, then the new
  -- text is indexed. Artifacts are otherwise append-only — no row is ever DELETEd — so no
  -- delete shadow trigger is needed. (Never run ('rebuild') — a double run or an empty-table
  -- rebuild corrupts/duplicates the index.)
  CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
    INSERT INTO artifacts_fts(rowid, text_repr) VALUES (new.id, new.text_repr);
  END;
  CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE OF text_repr ON artifacts BEGIN
    INSERT INTO artifacts_fts(artifacts_fts, rowid, text_repr) VALUES('delete', old.id, old.text_repr);
    INSERT INTO artifacts_fts(rowid, text_repr) VALUES (new.id, new.text_repr);
  END;

  -- Append-only log of significant transitions (design-philosophy.md §3).
  CREATE TABLE IF NOT EXISTS ingest_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type  TEXT NOT NULL,          -- migrate|import_contacts|store_note|dedup_skip|ingest_create|ingest_update|relation_added|relation_resolved|relation_removed|entity_created|entity_edited|entity_merged|alias_added|alias_removed|alias_tombstone_cleared|schema_migration|integrity_check|directory_card_merged|directory_attrs_backfill|directory_promoted|proposed_entity_reopened|duplicate_pair_dismissed|duplicate_dismissals_cleared
    actor       TEXT,
    details     TEXT                    -- JSON
  );
`);

// Guarded migration (#75): CREATE TABLE IF NOT EXISTS above won't add a column to an
// entities table that already existed pre-upgrade — check PRAGMA table_info and ALTER once.
// merged_into NULL = a live entity; non-NULL = a tombstone redirecting to its merge survivor
// (mergeEntities never deletes the absorbed row — design-philosophy.md §1). Back up
// life-context.db before upgrading, same as any schema change (data-model.md "Migrations").
if (!db.prepare("PRAGMA table_info(entities)").all().some((c) => c.name === 'merged_into')) {
  db.exec('ALTER TABLE entities ADD COLUMN merged_into INTEGER REFERENCES entities(id)');
  // Schema changes get a log row same as any other significant transition (design-philosophy.md
  // §3) — a raw statement, not the logEvent()/logStmt helper below, since those aren't defined
  // yet at this point in module evaluation (this runs at schema-setup time, top-to-bottom).
  db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)')
    .run('schema_migration', 'db.js', JSON.stringify({ migration: 'entities.merged_into' }));
}
db.exec('CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON entities(merged_into)');

// Guarded migration (#137): carry a place/event proposal's staged geo/span so approveProposedEntity
// can copy it into the minted entity. Nullable — a person/org proposal leaves it NULL. Same
// table_info-guarded ALTER as merged_into above (ADD COLUMN doesn't rewrite existing rows).
if (!db.prepare('PRAGMA table_info(proposed_entities)').all().some((c) => c.name === 'attrs_json')) {
  db.exec('ALTER TABLE proposed_entities ADD COLUMN attrs_json TEXT');
  db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)')
    .run('schema_migration', 'db.js', JSON.stringify({ migration: 'proposed_entities.attrs_json' }));
}

// Guarded migration (#304): link each handle row to the directory_cards row it was loaded from.
// Nullable by design — rows loaded before #304 keep card_id NULL until the export is re-loaded
// (docs/08 documents that a re-load is required), so an existing directory stays valid meanwhile.
// Same table_info-guarded ALTER as merged_into above; ADD COLUMN doesn't rewrite existing rows.
if (!db.prepare('PRAGMA table_info(contact_directory)').all().some((c) => c.name === 'card_id')) {
  db.exec('ALTER TABLE contact_directory ADD COLUMN card_id INTEGER REFERENCES directory_cards(id)');
  db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)')
    .run('schema_migration', 'db.js', JSON.stringify({ migration: 'contact_directory.card_id' }));
}

// Data migration (#88): business contacts flagged isCompany were historically inserted as
// kind='person' (the 'org' schema slot went unused). Fill the derived classification from the
// raw source signal — idempotent (only still-mis-kinded live rows change), run unconditionally,
// logged only when it actually promotes rows. Same raw-statement approach as the migration above
// (logEvent/logStmt aren't defined yet at schema-setup time). json_extract ships with better-sqlite3.
// json_valid guards first: attrs_json is an unconstrained TEXT column the code already treats as
// possibly-non-JSON (safeJson), and json_extract THROWS on malformed JSON — since this runs at
// module load, one bad row would otherwise crash every startup. SQLite short-circuits AND, so a
// malformed/NULL row is skipped before json_extract sees it.
{
  const info = db.prepare(`
    UPDATE entities SET kind = 'org'
    WHERE kind = 'person' AND merged_into IS NULL
      AND json_valid(attrs_json)
      AND json_extract(attrs_json, '$.isCompany') = 1
  `).run();
  if (info.changes > 0) {
    db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)')
      .run('schema_migration', 'db.js', JSON.stringify({ migration: 'entities.kind=org', rows: info.changes }));
  }
}

// --- Integrity enforcement (#110) ---
// FKs are enforced for NEW writes (pragma at open). Check EXISTING data once at startup —
// detect-only: design-philosophy §1 forbids deleting stored rows, so a pre-existing orphan is
// logged (console + an `integrity_check` ingest_log row) and boot continues; repair is a separate,
// deliberate act. Raw statement, not logEvent/logStmt (not defined until later in this module).
const logSchemaStmt = db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)');
{
  const fkViolations = db.pragma('foreign_key_check');            // [] when clean
  const integrity = db.pragma('integrity_check');                 // [{integrity_check:'ok'}] when clean
  const integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
  if (fkViolations.length > 0 || !integrityOk) {
    // ERROR, not WARN: a human must look. Detect-only by design (§1 forbids repairing stored
    // rows), so boot continues — but counts only here; the full violation detail stays in the
    // ingest_log row below, inside the app DB, where it isn't duplicated into the ops store.
    log.error('db.integrity.failed', 'startup integrity issues detected (not repaired)', null,
      { foreign_key_violations: fkViolations.length, integrity_ok: integrityOk });
    logSchemaStmt.run('integrity_check', 'db.js',
      JSON.stringify({ foreign_key_violations: fkViolations, integrity_check: integrityOk ? 'ok' : integrity }));
  }
}

// Guarded NOT NULL tightening (#110): SQLite can't ALTER a column to NOT NULL, so rebuild the table
// (sqlite.org new-table→INSERT SELECT→drop→rename recipe). Idempotent — skipped once the target
// column is already NOT NULL (so a fresh DB, born tight from the CREATE TABLE above, never rebuilds).
// Never coerces/drops data: if the target columns still hold NULLs, or the rebuilt table trips a
// pre-existing FK orphan, SKIP and log loudly (surfacing corruption beats hiding it, design-philosophy
// §1). FKs toggle OFF around the rebuild (the pragma is a no-op inside a transaction) and are always
// restored in `finally`; foreign_key_check re-verifies before commit and rolls back on an orphan.
function tightenNotNull(table, columns, createNewSql, copyCols, indexSqls) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.every((c) => info.find((x) => x.name === c)?.notnull === 1)) return; // already migrated
  const nullRows = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${columns.map((c) => `"${c}" IS NULL`).join(' OR ')}`).get().n;
  if (nullRows > 0) {
    log.error('db.migration.skipped', 'NOT NULL migration skipped — rows still hold NULLs', null,
      { table, columns, null_rows: nullRows, cause: 'null_rows' });
    logSchemaStmt.run('integrity_check', 'db.js', JSON.stringify({ migration: `${table}.not_null`, skipped: 'null_rows', null_rows: nullRows, columns }));
    return;
  }
  db.pragma('foreign_keys = OFF'); // must be outside any transaction; restored in finally
  try {
    let orphans = [];
    const rebuild = db.transaction(() => {
      db.exec(createNewSql);
      db.exec(`INSERT INTO ${table}_new (${copyCols}) SELECT ${copyCols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      for (const ix of indexSqls) db.exec(ix);
      orphans = db.pragma(`foreign_key_check(${table})`);
      if (orphans.length > 0) throw new Error('__ROLLBACK_ORPHAN__'); // preserve data; leave table untightened
    });
    try {
      rebuild();
      logSchemaStmt.run('schema_migration', 'db.js', JSON.stringify({ migration: `${table}.not_null`, columns }));
    } catch (err) {
      if (err.message !== '__ROLLBACK_ORPHAN__') throw err;
      log.error('db.migration.skipped', 'NOT NULL migration skipped — pre-existing FK orphans', null,
        { table, columns, orphans: orphans.length, cause: 'fk_orphans' });
      logSchemaStmt.run('integrity_check', 'db.js', JSON.stringify({ migration: `${table}.not_null`, skipped: 'fk_orphans', orphans: orphans.length, columns }));
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

tightenNotNull('entity_aliases', ['entity_id', 'alias_type'], `
  CREATE TABLE entity_aliases_new (
    entity_id  INTEGER NOT NULL REFERENCES entities(id),
    alias      TEXT NOT NULL,
    alias_type TEXT NOT NULL,
    UNIQUE(alias, alias_type)
  )`, 'entity_id, alias, alias_type', [
  'CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id)',
]);

tightenNotNull('entity_links', ['role'], `
  CREATE TABLE entity_links_new (
    artifact_id INTEGER REFERENCES artifacts(id),
    entity_id   INTEGER REFERENCES entities(id),
    role        TEXT NOT NULL,
    confidence  REAL DEFAULT 1.0,
    PRIMARY KEY (artifact_id, entity_id, role)
  )`, 'artifact_id, entity_id, role, confidence', [
  'CREATE INDEX IF NOT EXISTS idx_links_entity ON entity_links(entity_id)',
]);

tightenNotNull('unresolved_aliases', ['alias_type', 'role'], `
  CREATE TABLE unresolved_aliases_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id     INTEGER REFERENCES artifacts(id),
    alias           TEXT NOT NULL,
    alias_type      TEXT NOT NULL,
    role            TEXT NOT NULL,
    hint_confidence REAL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(artifact_id, alias, alias_type, role)
  )`, 'id, artifact_id, alias, alias_type, role, hint_confidence, created_at', [
  'CREATE INDEX IF NOT EXISTS idx_unresolved_alias ON unresolved_aliases(alias, alias_type)',
]);

// --- PREPARED STATEMENTS (compiled once) ---
const insertArtifactStmt = db.prepare(`
  INSERT OR IGNORE INTO artifacts
    (type, source, source_id, content_hash, occurred_at, latitude, longitude, place_label, raw_path, text_repr, extra_json)
  VALUES
    (@type, @source, @source_id, @content_hash, @occurred_at, @latitude, @longitude, @place_label, @raw_path, @text_repr, @extra_json)
`);
const insertVecArtifactStmt = db.prepare('INSERT INTO vec_artifacts (artifact_id, embedding) VALUES (?, ?)');
const insertLinkStmt = db.prepare('INSERT OR IGNORE INTO entity_links (artifact_id, entity_id, role, confidence) VALUES (?, ?, ?, ?)');
const insertUnresolvedStmt = db.prepare(`
  INSERT OR IGNORE INTO unresolved_aliases (artifact_id, alias, alias_type, role, hint_confidence)
  VALUES (?, ?, ?, ?, ?)
`);
const selectIdBySourceStmt = db.prepare('SELECT id FROM artifacts WHERE source = ? AND source_id = ?');
const getArtifactBySourceStmt = db.prepare('SELECT * FROM artifacts WHERE source = ? AND source_id = ?');
const selectIdByHashStmt = db.prepare('SELECT id FROM artifacts WHERE content_hash = ? LIMIT 1');
const getArtifactStmt = db.prepare('SELECT * FROM artifacts WHERE id = ?');
// Upsert update path. COALESCE(@field, field): a present field overwrites; an absent one
// (bound null) keeps the current value — so a metadata-only wave never wipes what an earlier
// wave stored, and nothing can be cleared through this path (schema rejects explicit null).
// source / source_id (the upsert key) and ingested_at (first-ingest time) are never in the
// SET clause. Two variants so the caller only touches text_repr when it actually changed:
// naming text_repr in SET fires `artifacts_au` (AFTER UPDATE OF text_repr) even when the value
// is identical, so a metadata-only wave would otherwise churn the FTS index for nothing.
const updateArtifactStmt = db.prepare(`
  UPDATE artifacts SET
    type        = COALESCE(@type, type),
    occurred_at = COALESCE(@occurred_at, occurred_at),
    latitude    = COALESCE(@latitude, latitude),
    longitude   = COALESCE(@longitude, longitude),
    place_label = COALESCE(@place_label, place_label),
    text_repr   = COALESCE(@text_repr, text_repr),
    extra_json  = COALESCE(@extra_json, extra_json)
  WHERE id = @id
`);
// Metadata-only variant: identical but omits text_repr, so the FTS update trigger does NOT
// fire. Used when text_repr is unchanged (an enrichment wave that only touches place/geo/etc.).
const updateArtifactMetaStmt = db.prepare(`
  UPDATE artifacts SET
    type        = COALESCE(@type, type),
    occurred_at = COALESCE(@occurred_at, occurred_at),
    latitude    = COALESCE(@latitude, latitude),
    longitude   = COALESCE(@longitude, longitude),
    place_label = COALESCE(@place_label, place_label),
    extra_json  = COALESCE(@extra_json, extra_json)
  WHERE id = @id
`);
// One vector per artifact, dimension unchanged — update in place; vec0 PK binds as BigInt.
const updateVecArtifactStmt = db.prepare('UPDATE vec_artifacts SET embedding = ? WHERE artifact_id = ?');
const getLinksStmt = db.prepare(`
  SELECT el.entity_id, el.role, el.confidence, e.canonical_name, e.kind
  FROM entity_links el JOIN entities e ON e.id = el.entity_id
  WHERE el.artifact_id = ?
`);
const insertEntityStmt = db.prepare('INSERT INTO entities (kind, canonical_name, attrs_json) VALUES (?, ?, ?)');
const insertAliasStmt = db.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)');
const resolveAliasStmt = db.prepare('SELECT DISTINCT entity_id FROM entity_aliases WHERE alias = ?');
// entity_aliases is UNIQUE(alias, alias_type) — a hint's declared type must be part of the
// match, or a name/handle alias could collide with an unrelated entity's differently-typed
// alias (and a phone/email hint could earn undeserved 1.0 confidence off that collision).
const resolveAliasByTypeStmt = db.prepare('SELECT DISTINCT entity_id FROM entity_aliases WHERE alias = ? AND alias_type = ?');
// Query-time given-name fallback (#184): a name alias whose value is exactly the term OR starts
// with the term at a token boundary ("sam" -> "sam rivera"/"sam maria rivera", never "jetsam" or a
// mid-token "sa"). `name` aliases ONLY — a prefix on a phone/email is meaningless. Two callers:
// hybridSearch's entity loop (query time), and — only after an exact miss — the ingest/backfill
// hint path via prefixInferredEntityId (#293/#296), which adds a tombstone guard and records the
// link at NAME_PREFIX_CONFIDENCE_CAP. resolveEntityIds itself stays exact-match/deterministic.
// LIMIT 2: we only ever decide "exactly one match" vs "ambiguous", so two distinct rows is enough —
// no need to materialize every entity whose name starts with a common/short prefix.
const resolveNameByPrefixStmt = db.prepare(`SELECT DISTINCT entity_id FROM entity_aliases WHERE alias_type = 'name' AND (alias = @t OR alias LIKE @t || ' %' ESCAPE '\\') LIMIT 2`);
const getEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ?');
const logStmt = db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)');
// entity_relations (issue #37): append-only edges, OR IGNORE for idempotency.
const insertRelationStmt = db.prepare(`
  INSERT OR IGNORE INTO entity_relations (from_entity_id, to_entity_id, relation_type, raw_label, confidence, source)
  VALUES (@from_entity_id, @to_entity_id, @relation_type, @raw_label, @confidence, @source)
`);
// r.id AS relation_id lets the contacts UI (#96) target a specific edge for removal; harmless to
// about_entity, which ignores it.
const getRelationsStmt = db.prepare(`
  SELECT r.id AS relation_id, r.to_entity_id AS entity_id, r.relation_type, r.raw_label, r.confidence, e.canonical_name AS name
  FROM entity_relations r JOIN entities e ON e.id = r.to_entity_id
  WHERE r.from_entity_id = ? ORDER BY r.relation_type, e.canonical_name
`);
// Incoming edges (#88): the reverse of getRelationsStmt — who points AT this entity. Lets
// about_entity(org) list its employees (worksAt from=person, to=org); harmlessly gives every
// entity its reverse edges too. Joins the FROM side for the name.
const getRelationsToStmt = db.prepare(`
  SELECT r.id AS relation_id, r.from_entity_id AS entity_id, r.relation_type, r.raw_label, r.confidence, e.canonical_name AS name
  FROM entity_relations r JOIN entities e ON e.id = r.from_entity_id
  WHERE r.to_entity_id = ? ORDER BY r.relation_type, e.canonical_name
`);
// Name aliases of an entity — used to match staged relation hints that point at this person.
const selectNameAliasesStmt = db.prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ? AND alias_type = 'name'`);
// Staged relation hints keyed by the related person's normalized name (alias_type='relation'
// marks them so they never collide with ordinary artifact->entity alias hints).
const selectRelationHintsStmt = db.prepare(`SELECT artifact_id, role FROM unresolved_aliases WHERE alias = ? AND alias_type = 'relation'`);
// The self-entity of a contact artifact — the "from" side of a staged relation.
const selectSelfEntityStmt = db.prepare(`SELECT entity_id FROM entity_links WHERE artifact_id = ? AND role = 'self' LIMIT 1`);
// Proposed entities (#119): stage / list / read / transition rows in proposed_entities.
const insertProposalStmt = db.prepare(`
  INSERT OR IGNORE INTO proposed_entities (suggested_kind, suggested_name, alias, alias_type, artifact_id, source, confidence, attrs_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const listProposalsStmt = db.prepare(`
  SELECT id, suggested_kind, suggested_name, alias, alias_type, artifact_id, source, confidence, status, resolved_entity_id, attrs_json, created_at,
    (SELECT COUNT(DISTINCT artifact_id) FROM unresolved_aliases ua WHERE ua.alias = proposed_entities.alias AND ua.alias_type = proposed_entities.alias_type) AS evidence_count
  FROM proposed_entities WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?
`);
const getProposalStmt = db.prepare('SELECT * FROM proposed_entities WHERE id = ?');
// Look up a proposal by its UNIQUE key so proposeEntity can return the row id + status even when
// INSERT OR IGNORE staged nothing new (the key already existed) — see proposeEntity.
const getProposalByKeyStmt = db.prepare('SELECT id, status FROM proposed_entities WHERE suggested_name = ? AND alias = ? AND alias_type = ?');
const setProposalStatusStmt = db.prepare('UPDATE proposed_entities SET status = ? WHERE id = ?');
const setProposalResolvedStmt = db.prepare(`UPDATE proposed_entities SET status = 'approved', resolved_entity_id = ? WHERE id = ?`);

// Side contact directory (#154). Handles normalize the same way resolution does, so a directory
// number stored 10-digit matches a `+1…` message handle and vice versa (#129). insertDirectoryEntry
// is first-writer-wins per (handle, type) and logs a name collision; lookupDirectoryName returns the
// stored name or null. Defined here (used by resolveEntityHints, annotateHandles, the loader, and
// the backfill) — all callers run after module load, so referencing normalizePhone/normalizeName
// (declared below) is safe.
const directorySelectStmt = db.prepare('SELECT name, card_id FROM contact_directory WHERE handle = ? AND handle_type = ?');
// #304: fill a legacy row's NULL card_id on re-load (see insertDirectoryEntry). Guarded to
// card_id IS NULL in SQL as well as in JS, so it can only ever fill a gap, never re-point a row.
const directoryAdoptCardStmt = db.prepare('UPDATE contact_directory SET card_id = ? WHERE handle = ? AND handle_type = ? AND card_id IS NULL');
const directoryInsertStmt = db.prepare('INSERT OR IGNORE INTO contact_directory (name, handle, handle_type, card_id) VALUES (?, ?, ?, ?)');
const dirKey = (handle, handleType) => (handleType === 'phone' ? normalizePhone(handle) : normalizeName(handle));
export function insertDirectoryEntry(name, handle, handleType, cardId = null) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  // Guard the type up front (matches the table CHECK) so a bad value returns a no-op result rather
  // than throwing a SqliteError mid-load; empty name/handle can't label anything.
  const key = cleanName && handle && (handleType === 'phone' || handleType === 'email') ? dirKey(handle, handleType) : '';
  if (!key) return { inserted: false, collision: false, adopted: false };
  // INSERT OR IGNORE first, then trust .changes — a SELECT-then-INSERT could wrongly report an
  // insert when a concurrent writer took the (handle,type) between the two (Copilot, PR #155).
  if (directoryInsertStmt.run(cleanName, key, handleType, cardId ?? null).changes > 0) return { inserted: true, collision: false, adopted: false };
  // Ignored: the (handle,type) already exists — SELECT only now, to detect/log a name collision.
  const existing = directorySelectStmt.get(key, handleType);
  const collision = !!existing && existing.name !== cleanName;
  // The handle and both names are contact data — the row carries the handle TYPE and the card
  // this collided with, which is enough to find it in the app DB, and nothing identifying (#328).
  if (collision) log.warn('directory.handle.collision', 'handle already maps to a different name, ignoring', { handle_type: handleType, existing_card_id: existing.card_id ?? null });
  // #304: adopt the card on re-load. INSERT OR IGNORE leaves an existing row untouched, so a row
  // loaded before directory_cards existed would keep card_id NULL forever and handle-keyed
  // getDirectoryCard would miss it even after the documented re-load — the upgrade path would
  // silently do nothing (Copilot, PR #308). Filling a NULL is the only write allowed here: a row
  // that already names a card keeps it (first-writer-wins, same as the name), and a row whose
  // stored name differs belongs to a DIFFERENT card, so it is left alone with its collision logged.
  const adopted = !!(cardId && existing && !collision && existing.card_id == null
    && directoryAdoptCardStmt.run(cardId, key, handleType).changes > 0);
  return { inserted: false, collision, adopted };
}
export const lookupDirectoryName = (handle, handleType) => {
  const key = handle ? dirKey(handle, handleType) : '';
  return key ? directorySelectStmt.get(key, handleType)?.name ?? null : null;
};

// The NAME direction of that lookup (#301). The photo connector emits every folder-name person hint
// as alias_type:'name' and never a handle, so the handle-keyed lookup above could not reach the
// directory for them at all — on the live DB that stranded 40 names the directory knows across 6,280
// hint rows / 4,949 artifacts. Exact match on the stored display name (which preferredDisplayName
// already reduced to first+last, #158 — the same shape a photo folder is usually named), never a
// fuzzy similarity: the resolve path stays deterministic, the same discipline as entity_aliases.
const directoryRowsByNameStmt = db.prepare('SELECT name, card_id FROM contact_directory WHERE name = ? COLLATE NOCASE');
export function lookupDirectoryByName(name) {
  const key = typeof name === 'string' ? normalizeName(name) : '';
  if (!key) return null;
  const rows = directoryRowsByNameStmt.all(key);
  if (!rows.length) return null;
  // `name` is deliberately non-unique here (one contact, several handle rows), so several rows are
  // NOT ambiguity. What is: rows from two different cards (#304's card_id — two people who share a
  // display name). Pre-#304 rows carry no card_id, and then differing stored spellings are the only
  // identity signal available. Either way >1 identity returns null rather than picking one, mirroring
  // annotateHandles' ambiguous branch and getDirectoryCard's refusal to guess.
  const cards = new Set(rows.map((r) => r.card_id).filter((id) => id != null));
  const spellings = new Set(rows.map((r) => r.name));
  if (cards.size > 1 || (cards.size === 0 && spellings.size > 1)) {
    log.warn('directory.name.ambiguous', 'name matches several distinct contacts, refusing to guess',
      { matches: Math.max(cards.size, spellings.size), by: cards.size > 1 ? 'card' : 'spelling' });
    return null;
  }
  // Residual imprecision worth naming (Copilot, PR #315): with no card_id, several same-spelling rows
  // are INDISTINGUISHABLE between one contact's several handles (the common case — 411 names carry 2
  // handles, 225 carry 3) and two people who happen to share a display name. We resolve, and say so,
  // because (a) refusing would drop most of the real cases on a directory that hasn't been re-loaded
  // yet, and (b) the downstream risk is not new: `name` aliases are single-owner per type in the graph
  // (UNIQUE(alias, alias_type)), so two same-named people already collide on any curated alias — this
  // lookup doesn't make that worse, and its only output is a proposal a human reads before approving.
  // A `directory:load` re-load (#304) populates card_id and makes the check above exact.
  if (cards.size === 0 && rows.length > 1 && !warnedCardLessNames.has(key)) {
    warnedCardLessNames.add(key);
    log.warn('directory.name.cardless', 'name backed only by card-less rows; assuming one contact — re-run directory:load to disambiguate', { rows: rows.length });
  }
  return rows[0].name;
}
// Warn ONCE per name per process. The same folder-name hint arrives on every photo in that folder
// (1,887 for one person on the live DB), and an identical line per photo buries the signal it exists
// to carry. Purely a log-dedup set — never consulted for behavior, so staleness cannot affect a
// resolve (unlike a cached dismissal set, which this file forbids for exactly that reason).
const warnedCardLessNames = new Set();

// --- DIRECTORY CARDS (#304): the per-card profile behind the handle lookup ---
// Loading a richer export must never destroy what an earlier one said, so the merge is
// APPEND-IF-EXISTS, mirroring contact_directory's first-writer-wins per handle: list fields union
// (deduped), an empty stored scalar is filled, and a DIFFERING scalar keeps the stored value and is
// reported as a conflict rather than overwritten (design-philosophy §1 — nothing here is clobbered
// by a re-load). Card rows are directory cache state, not artifacts: the idempotency key is
// card_key, not (source, source_id)/content_hash, and nothing is embedded.
const getCardByKeyStmt = db.prepare('SELECT id, card_key, name, attrs_json FROM directory_cards WHERE card_key = ?');
const insertCardStmt = db.prepare('INSERT INTO directory_cards (card_key, name, attrs_json) VALUES (?, ?, ?)');
const updateCardAttrsStmt = db.prepare('UPDATE directory_cards SET attrs_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
const cardByHandleStmt = db.prepare(`
  SELECT c.id, c.card_key, c.name, c.attrs_json FROM contact_directory d
  JOIN directory_cards c ON c.id = d.card_id WHERE d.handle = ? AND d.handle_type = ?
`);
const cardsByNameStmt = db.prepare('SELECT id, card_key, name, attrs_json FROM directory_cards WHERE name = ? COLLATE NOCASE');

// A value that carries no information, so filling it is not an overwrite. `false` is a real value
// (isCompany), which is why this is not a truthiness test.
const isEmptyValue = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
// Compare/dedupe by serialized form — the list fields hold objects (dates, relatedNames, im,
// socialProfiles), so identity or === would union duplicates on every re-load.
const valueKey = (v) => JSON.stringify(v);
const hydrateCard = (row) => (row ? { ...row, attrs: row.attrs_json ? safeJson(row.attrs_json) ?? {} : {} } : null);

// Merge incoming card attrs onto the stored ones per the append rules above. Returns the merged
// object plus the keys that changed and the scalars that differed (kept, not applied).
function mergeCardAttrs(stored, incoming) {
  const merged = { ...stored };
  const changed = [], conflicts = [];
  for (const [k, v] of Object.entries(incoming)) {
    const cur = merged[k];
    if (Array.isArray(v)) {
      if (!v.length) continue;
      const union = Array.isArray(cur) ? [...cur] : [];
      const seen = new Set(union.map(valueKey));
      let added = false;
      for (const item of v) { const key = valueKey(item); if (!seen.has(key)) { seen.add(key); union.push(item); added = true; } }
      if (added) { merged[k] = union; changed.push(k); }
      continue;
    }
    if (isEmptyValue(v)) continue;                                  // nothing offered
    if (isEmptyValue(cur)) { merged[k] = v; changed.push(k); continue; } // fill an empty slot
    if (valueKey(cur) !== valueKey(v)) conflicts.push(k);           // differs — stored value wins
  }
  return { merged, changed, conflicts };
}

/**
 * Insert or append-merge one directory card. Returns { id, created, merged }; callers count
 * `created` for new cards and `merged` for ones that gained data (mirrors proposeEntity's
 * `.created`). Logs directory_card_merged when the re-load either changed something OR hit a
 * conflict — the log row IS how a rejected difference is recorded (design-philosophy §3/§4); an
 * unchanged re-load writes nothing at all, not even updated_at, so idempotency is observable.
 */
export const upsertDirectoryCard = db.transaction(({ card_key, name, attrs }) => {
  const key = typeof card_key === 'string' ? card_key.trim() : '';
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!key || !cleanName) return { id: null, created: false, merged: false };
  const existing = getCardByKeyStmt.get(key);
  if (!existing) return { id: Number(insertCardStmt.run(key, cleanName, JSON.stringify(attrs ?? {})).lastInsertRowid), created: true, merged: false };
  const stored = existing.attrs_json ? safeJson(existing.attrs_json) ?? {} : {};
  const { merged, changed, conflicts } = mergeCardAttrs(stored, attrs ?? {});
  // The card's own display name is append-if-exists too: a renamed card keeps the stored label
  // (first writer wins, same discipline as the handle rows) and the difference is logged.
  if (cleanName !== existing.name) conflicts.push('name');
  if (!changed.length && !conflicts.length) return { id: existing.id, created: false, merged: false };
  if (changed.length) updateCardAttrsStmt.run(JSON.stringify(merged), existing.id);
  logEvent('directory_card_merged', 'load-directory.js', { card_key: key, name: existing.name, changed, conflicts });
  return { id: existing.id, created: false, merged: changed.length > 0 };
});

/**
 * Resolve one directory card: by handle first (the deterministic key, joined through
 * contact_directory.card_id), then by exact name as a fallback. Returns the row with a parsed
 * `attrs`, or null on a miss OR on ambiguity — `name` is deliberately non-unique here (one contact
 * has several handles, and two people can share a display name), so >1 match must refuse to guess
 * rather than pick one, mirroring annotateHandles' ambiguous branch and insertDirectoryEntry's
 * collision log. A card_id-less legacy handle row (loaded pre-#304) simply doesn't join and falls
 * through to the name path.
 */
export function getDirectoryCard({ handle, handleType, name } = {}) {
  if (handle && (handleType === 'phone' || handleType === 'email')) {
    const key = dirKey(handle, handleType);
    const row = key ? cardByHandleStmt.get(key, handleType) : null;
    if (row) return hydrateCard(row);
  }
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return null;
  const rows = cardsByNameStmt.all(cleanName);
  if (rows.length > 1) { log.warn('directory.card.ambiguous', 'name matches several cards, refusing to guess', { matches: rows.length }); return null; }
  return rows.length === 1 ? hydrateCard(rows[0]) : null;
}

// --- BROWSE + PROMOTE (#299): the directory's third role, alongside auto-label and stage-for-review ---
// The whole roster is unreachable without this: `name` was a write-only column, so given "Diana
// Monday" you could not ask the directory anything. Promotion here is DIRECT, not via
// proposed_entities — the directory is the user's own vCard export, so a name it holds is not a
// machine guess needing approval, and browse-and-click IS the approval. (Routing through the queue
// would also collide with the 185 already-rejected rows, whose UNIQUE key is occupied.)

// Grouped by the EXACT name string: `name` is only .trim()ed at load and handles are first-writer-
// wins, so "Jason Lomax (personal)" and "Jason Lomax" are honestly two groups — merging them is
// #302/#303's job, not a guess made here.
const countDirectoryNamesStmt = db.prepare('SELECT COUNT(DISTINCT name) AS n FROM contact_directory');
const countDirectoryRowsStmt = db.prepare('SELECT COUNT(*) AS n FROM contact_directory');
const selectDirectoryHandlesByNameStmt = db.prepare('SELECT handle, handle_type FROM contact_directory WHERE name = ? ORDER BY handle_type, handle');

/**
 * The impact-ordered candidate list. 1,569 names is untriageable alphabetically, so the ordering key
 * is what promoting would actually buy: the number of DISTINCT artifacts that would retro-link,
 * counted across BOTH hint arms — `alias_type='name'` hints (the photo folder names) and the
 * handle-typed hints — and excluding any alias that already resolves (a curated alias is no longer
 * "would link"). Computed for every group BEFORE the LIMIT, or the global ordering would be a lie.
 * `entity_id` is non-null when the name is already curated: returned, not hidden, so the user can
 * see it's done. Ordering `artifacts DESC, name ASC` is total (no nondeterministic ties).
 */
const listDirectoryCandidatesStmt = db.prepare(`
  WITH open_hints AS (
    SELECT u.alias, u.alias_type, u.artifact_id FROM unresolved_aliases u
    WHERE u.alias_type != 'relation'
      AND NOT EXISTS (SELECT 1 FROM entity_aliases ea WHERE ea.alias = u.alias AND ea.alias_type = u.alias_type)
  ),
  names AS (SELECT DISTINCT name FROM contact_directory),
  hits AS (
    SELECT n.name AS name, h.artifact_id AS artifact_id, 1 AS is_name
    FROM names n JOIN open_hints h ON h.alias_type = 'name' AND h.alias = lower(n.name)
    UNION ALL
    SELECT d.name AS name, h.artifact_id AS artifact_id, 0 AS is_name
    FROM contact_directory d JOIN open_hints h ON h.alias = d.handle AND h.alias_type = d.handle_type
  ),
  impact AS (
    SELECT name, COUNT(DISTINCT artifact_id) AS artifacts,
           SUM(is_name) AS name_hints, SUM(1 - is_name) AS handle_hints
    FROM hits GROUP BY name
  ),
  -- Curated = this NAME resolves to a live entity. Deliberately NOT "any handle resolves": that is
  -- the same identity rule promoteDirectoryName applies (Copilot, PR #314), and the two must agree or
  -- the list lies about the promote path. A shared family landline owned by someone else would
  -- otherwise mark its second owner's row curated — greying it, pointing its name link at the WRONG
  -- contact, and blocking the promotion that would actually give that person their own. A genuinely
  -- imported contact holds both its name and handle aliases, so the common case is unaffected.
  curated AS (
    SELECT n.name AS name, MIN(ea.entity_id) AS entity_id
    FROM names n
    JOIN entity_aliases ea ON ea.alias = lower(n.name) AND ea.alias_type = 'name'
    JOIN entities e ON e.id = ea.entity_id AND e.merged_into IS NULL
    GROUP BY n.name
  )
  SELECT n.name,
         COALESCE(i.artifacts, 0) AS artifacts,
         COALESCE(i.name_hints, 0) AS name_hints,
         COALESCE(i.handle_hints, 0) AS handle_hints,
         c.entity_id AS entity_id
  FROM names n
  LEFT JOIN impact i ON i.name = n.name
  LEFT JOIN curated c ON c.name = n.name
  WHERE @like IS NULL
     OR n.name LIKE @like
     OR EXISTS (SELECT 1 FROM contact_directory d2 WHERE d2.name = n.name AND (d2.handle LIKE @like OR (@likeDigits IS NOT NULL AND d2.handle LIKE @likeDigits)))
  ORDER BY artifacts DESC, n.name ASC
  LIMIT @limit OFFSET @offset
`);

export function listDirectoryCandidates({ query, limit = 50, offset = 0 } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  // A pasted phone arrives formatted ("+1 (301) 555-0134") but is stored digits-only (#129), so the
  // digit form is matched as well as the raw string — else searching by a copied number finds nothing.
  const digits = q ? normalizePhone(q) : '';
  const rows = listDirectoryCandidatesStmt.all({
    like: q ? `%${q}%` : null,
    likeDigits: digits && digits !== q ? `%${digits}%` : null,
    limit, offset,
  });
  // One handles lookup per RETURNED row — bounded by `limit` (≤200) and index-backed by
  // idx_directory_name, not an N+1 over all 2,888 rows. Deliberately not a group_concat that the
  // caller would have to split: emails and phone digits are arbitrary text, so any separator is a
  // parsing hazard.
  return {
    candidates: rows.map((r) => ({
      name: r.name,
      handles: selectDirectoryHandlesByNameStmt.all(r.name),
      entity_id: r.entity_id ?? null,
      impact: { artifacts: r.artifacts, name_hints: r.name_hints, handle_hints: r.handle_hints },
    })),
    total_names: countDirectoryNamesStmt.get().n,
    total_rows: countDirectoryRowsStmt.get().n,
  };
}

// Proposals for a handle that promotion makes obsolete. Excludes 'approved' — that row already names
// a minted entity, and rewriting its resolved_entity_id would make the audit trail lie (#300's
// reasoning for refusing to reopen an approved proposal, applied in reverse).
const selectOpenProposalsByAliasStmt = db.prepare(`SELECT id, status FROM proposed_entities WHERE alias = ? AND alias_type = ? AND status != 'approved'`);

/**
 * Promote one directory name (and ALL of its handles) into the curated graph. Grouped promotion is
 * the point: 411 names carry 2 handles and 225 carry 3, so promoting one handle at a time would mint
 * duplicates of the same person.
 *
 * Resolve-or-mint, mirroring approveProposedEntity: if any handle — or the name itself — already
 * resolves to a LIVE entity, that entity is reused and only its missing aliases are added
 * (`created:false`), so a second promote is a no-op. On a mint the entity carries the #304 card's
 * full profile when the directory has one, else just its handles.
 *
 * A handle owned by a DIFFERENT entity is collected into `skipped_handles` and the rest of the
 * promotion proceeds — deliberately NOT assertNoAliasConflict, which throws: a shared family number
 * must not abort this promotion (let alone the other 99 in a bulk call), and the conflict is
 * reported per handle instead of as a failure. Aliases go through insertAliasUnlessTombstoned, so a
 * deliberately-removed alias (#111) is not resurrected.
 *
 * Throws typed NOT_FOUND when the exact name has no directory rows.
 */
export const promoteDirectoryName = db.transaction((rawName) => {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const rows = name ? selectDirectoryHandlesByNameStmt.all(name) : [];
  if (!rows.length) { const err = new Error(`"${name}" is not in the contact directory`); err.code = 'NOT_FOUND'; throw err; }
  const liveOwner = (alias, aliasType) => resolveAliasByTypeStmt.all(alias, aliasType)
    .map((r) => r.entity_id).find((id) => getLiveEntityStmt.get(id)) ?? null;
  const nameAliases = nameVariants({ fn: name, derive: true });

  // Identity is decided by NAME, not by a handle. A handle-based reuse is accepted only when that
  // entity ALSO answers to this name — "the contact was imported since the directory was loaded",
  // which is the case reuse exists for. Without that guard a shared family landline listed in the
  // directory under a second person's name would silently absorb them into its owner's contact,
  // attaching their email to the wrong person. Minting a DETECTABLE duplicate instead
  // (listProbableDuplicates + mergeEntities resolve it) is the repo's established stance on this
  // trade (data-model.md: duplicates are detected later, not blocked at write) — and a mis-merge is
  // far harder to undo than a duplicate. The foreign handle is reported in skipped_handles below.
  let entityId = nameAliases.map((v) => liveOwner(v, 'name')).find((id) => id != null) ?? null;
  if (entityId == null) {
    for (const r of rows) {
      const owner = liveOwner(r.handle, r.handle_type);
      if (owner != null && nameAliases.some((v) => resolveAliasByTypeStmt.all(v, 'name').some((x) => x.entity_id === owner))) { entityId = owner; break; }
    }
  }

  let created = false;
  if (entityId == null) {
    const emails = rows.filter((r) => r.handle_type === 'email').map((r) => r.handle);
    const phones = rows.filter((r) => r.handle_type === 'phone').map((r) => r.handle);
    // #304: the card carries the real profile (addresses/birthday/anniversary/org/…) and its
    // emails/phones as the user wrote them, which is what the UI displays; the normalized directory
    // handles are the fallback for a card-less (pre-#304, not-yet-re-loaded) directory.
    const card = getDirectoryCard({ handle: rows[0].handle, handleType: rows[0].handle_type, name });
    const attrs = card
      ? { ...card.attrs, emails: card.attrs.emails?.length ? card.attrs.emails : emails, phones: card.attrs.phones?.length ? card.attrs.phones : phones }
      : { emails, phones };
    entityId = Number(insertEntityStmt.run('person', name, JSON.stringify(attrs)).lastInsertRowid);
    created = true;
  }

  let aliases = 0;
  for (const v of nameAliases) aliases += insertAliasUnlessTombstoned(entityId, v, 'name');
  // #409: route the handle-alias writes through the one reconciler implementation rather than a
  // second copy of insertAliasUnlessTombstoned + an ownership check. skippedHandles below still
  // needs the actual handle VALUE for its return/log (reconcileHandleAliases deliberately never
  // returns one — its result must stay safely loggable to the ops store too, from other callers)
  // — a second, read-only pass over `rows` recovers it without re-deriving the write logic.
  const { added: handleAliasesAdded } = reconcileHandleAliases(
    entityId,
    { emails: rows.filter((r) => r.handle_type === 'email').map((r) => r.handle), phones: rows.filter((r) => r.handle_type === 'phone').map((r) => r.handle) },
    { explicit: false },
  );
  aliases += handleAliasesAdded;
  const skippedHandles = [];
  for (const r of rows) {
    const owner = resolveAliasByTypeStmt.all(r.handle, r.handle_type).map((x) => x.entity_id).find((id) => id !== entityId);
    if (owner != null) skippedHandles.push({ handle: r.handle, handle_type: r.handle_type, entity_id: owner });
  }
  // The reason promotion is worth anything: link the history already staged under those aliases.
  const linked = resolveStagedArtifactHints(entityId);
  // Heal the queue: a pending or rejected proposal for one of these handles now contradicts the
  // graph (the entity exists), so resolve it to this entity rather than leave a stale row.
  let proposalsResolved = 0;
  for (const r of rows) {
    for (const p of selectOpenProposalsByAliasStmt.all(r.handle, r.handle_type)) { setProposalResolvedStmt.run(entityId, p.id); proposalsResolved++; }
  }
  // #413: a proposal keyed on the NAME itself (alias_type='name') is never in the handle set above,
  // so it survived promotion and kept asking to create someone who now exists. Heal every variant
  // this entity's name aliases, mirroring approveProposedEntity's own healing loop. Guarded to
  // variants the entity ACTUALLY owns (liveOwner) — a variant can lose the first-writer-wins race to
  // another live entity, or be tombstoned (#111) and therefore never actually seed, and healing a
  // proposal for either would silently resolve someone else's identity onto this entity.
  for (const v of nameAliases) {
    if (liveOwner(v, 'name') !== entityId) continue;
    for (const p of selectOpenProposalsByAliasStmt.all(v, 'name')) { setProposalResolvedStmt.run(entityId, p.id); proposalsResolved++; }
  }
  logEvent('directory_promoted', 'contacts-ui', { name, entity_id: entityId, created, handles: rows.length, aliases, linked, proposals_resolved: proposalsResolved, skipped_handles: skippedHandles });
  return { entity_id: entityId, created, linked, aliases, proposals_resolved: proposalsResolved, skipped_handles: skippedHandles };
});

/**
 * Fill EMPTY profile fields on an entity from a directory card. The third writer of attrs_json
 * (#97 named two: the contacts UI owns the profile, the re-import owns the searchable artifact) and
 * the lowest-precedence one: user-typed > existing non-empty > directory. Deliberately NOT
 * updateEntityAttrs — that overwrites attrs wholesale and reconciles aliases/tombstones, which a
 * directory-sourced fill has no business doing generally, but it IS the third writer of
 * attrs.emails/phones specifically, so it now closes the same fields-⊆-aliases gap those two other
 * writers do (#409) — for whichever of those two keys THIS call actually fills, never the entity's
 * untouched pre-existing set (the dedicated backfill:handle-aliases script owns healing that).
 * Touches attrs_json only: never canonical_name, aliases, relations, photoFile, or any artifact.
 * Returns { filled: [<keys>], aliasesAdded }; idempotent, since a key filled on the first run is
 * non-empty on the second (and a second run's aliasesAdded is 0 for the same reason).
 */
export const fillEntityAttrsFromCard = db.transaction((entityId, cardAttrs) => {
  const cur = getEntityStmt.get(entityId);
  if (!cur) return { filled: [] };
  const before = cur.attrs_json ? safeJson(cur.attrs_json) ?? {} : {};
  const next = { ...before };
  const filled = [];
  for (const [k, v0] of Object.entries(cardAttrs ?? {})) {
    // #409: a value tombstoned for THIS entity (#111) must not be re-filled into the field either
    // — otherwise this backfill recreates the exact reported symptom (a card value visible on the
    // profile with no matching alias) while technically satisfying fields ⊆ aliases (the field
    // just wouldn't hold it, so there'd be nothing to alias). Only emails/phones are
    // tombstone-checkable; every other key passes through untouched.
    const field = HANDLE_ALIAS_FIELDS.find(([key]) => key === k);
    const v = field && Array.isArray(v0)
      ? v0.filter((raw) => { const n = typeof raw === 'string' ? field[2](raw) : ''; return !(n && hasTombstoneStmt.get(entityId, n, field[1])); })
      : v0;
    // `v === false` is skipped HERE but not in the card merge: `isCompany: false` is the attrs
    // shape's default, so filling it writes nothing meaningful yet would count as an enrichment —
    // inflating the run summary ("49 enriched") with entities that gained no actual profile data.
    if (isEmptyValue(v) || v === false || !isEmptyValue(next[k])) continue;
    next[k] = v; filled.push(k);
  }
  if (!filled.length) return { filled: [] };
  updateEntityRowStmt.run(null, JSON.stringify(next), entityId);
  // #409: alias only the field(s) THIS call actually filled (never the entity's whole current
  // attrs — a non-empty emails/phones was left untouched above, out of scope for this writer).
  const aliasAttrs = {};
  if (filled.includes('emails')) aliasAttrs.emails = next.emails;
  if (filled.includes('phones')) aliasAttrs.phones = next.phones;
  const { added } = reconcileHandleAliases(entityId, aliasAttrs, { explicit: false });
  if (added > 0) sweepStagedHints(entityId, { entity_id: entityId });
  // Reuse entity_edited so a contact's profile history stays reconstructable from one event type.
  logEvent('entity_edited', 'backfill-directory-attrs.js', { entity_id: entityId, filled, aliases_added: added });
  return { filled, aliasesAdded: added };
});
// Backfill: stage a directory-sourced person proposal for every historical unresolved hint the
// directory knows — phone/email (#154) and, since #301, `name` too. The live-path fix only helps
// FUTURE ingests, and this backlog is entirely historical (the photo import already happened), so
// widening the query is what actually reaches those 40 names. Frequency-ordered (COUNT(*) DESC) so
// the highest-traffic entries surface first; skips an alias that has since become curated; idempotent
// (proposed_entities' UNIQUE absorbs re-runs). Named for hints, not handles, since #301 — a `name`
// hint is not a handle.
const selectUnmatchedHintsStmt = db.prepare(`
  SELECT alias, alias_type, MIN(artifact_id) AS artifact_id, COUNT(*) AS freq
  FROM unresolved_aliases WHERE alias_type IN ('phone','email','name')
  GROUP BY alias, alias_type ORDER BY COUNT(*) DESC
`);
export function backfillDirectoryProposals() {
  let scanned = 0, proposed = 0;
  const run = db.transaction(() => {
    for (const row of selectUnmatchedHintsStmt.all()) {
      scanned++;
      const isName = row.alias_type === 'name';
      const name = isName ? lookupDirectoryByName(row.alias) : lookupDirectoryName(row.alias, row.alias_type);
      if (!name) continue;
      if (resolveAliasByTypeStmt.all(row.alias, row.alias_type).length) continue; // became curated since
      // Mirror the ingest path's precedence: there, a #293 prefix inference short-circuits before the
      // directory is consulted. A staged bare given name that resolves to exactly one entity by prefix
      // is that person (backfill:name-prefix-links is what links it), so proposing a NEW person for
      // the same name would stage a duplicate of someone the graph already has.
      if (isName && prefixInferredEntityId(row.alias) != null) continue;
      if (proposeEntity({ suggested_kind: 'person', name, alias: row.alias, alias_type: row.alias_type, artifact_id: row.artifact_id, source: 'directory-backfill' }).created) proposed++;
    }
  });
  run();
  logEvent('directory_backfill', 'backfill-directory-proposals.js', { scanned, proposed });
  return { scanned, proposed };
}

// --- Photo-exif "pictured" name proposals (#350) ---
// Google Photos sidecar people[] tags (and photo-exif's folder-name fallback) arrive as
// unresolved_aliases rows under role='pictured', alias_type='name' (connectors/photo-exif/scan.js).
// For anyone already a contact these resolve at ingest time via resolveEntityHints (exact match,
// then the #293 prefix fallback); for everyone else the hint just sits here forever — no error, no
// entity, invisible to about_entity/search. Deliberately scoped to role='pictured' only (unlike
// backfillDirectoryProposals above, which scans phone/email/name across every role for the side
// contact_directory) — this is the photo connector's own backlog, not the general directory one, and
// there is no directory lookup here: a sidecar/folder name is staged for review exactly as-is.
// Grouped + ordered by distinct-artifact impact (the highest-traffic name reviewed first); the
// extra MIN(artifact_id) rides along as the proposal's audit-pointer artifact, cheaper than a
// second per-name query. Impact is intentionally NOT persisted anywhere (design decision, #350) —
// it's derived from unresolved_aliases and would go stale the moment another ingest wave lands.
const selectStrandedPicturedNamesStmt = db.prepare(`
  SELECT alias, COUNT(DISTINCT artifact_id) AS artifact_count, MIN(artifact_id) AS artifact_id
  FROM unresolved_aliases WHERE alias_type = 'name' AND role = 'pictured'
  GROUP BY alias ORDER BY artifact_count DESC, alias ASC
`);
const selectStrandedPicturedArtifactTotalStmt = db.prepare(`
  SELECT COUNT(DISTINCT artifact_id) AS n FROM unresolved_aliases WHERE alias_type = 'name' AND role = 'pictured'
`);
// Existing-proposal check keyed on (alias, alias_type) ONLY — deliberately NOT the full
// UNIQUE(suggested_name, alias, alias_type) key. A different staging path can already own this
// exact alias under a differently-cased suggested_name (e.g. resolveEntityHints' directory-consult
// branch stages `name: dirName` — the directory's properly-cased display name — against the same
// normalized `alias`); matching on the full key would miss that row and stage a second, duplicate
// pending proposal for the same person. One proposal per (alias, alias_type) is the right dedup
// granularity regardless of which source or casing staged it first.
const existsProposalForAliasStmt = db.prepare('SELECT 1 FROM proposed_entities WHERE alias = ? AND alias_type = ? LIMIT 1');
export function listStrandedPicturedNames() {
  return selectStrandedPicturedNamesStmt.all();
}

/**
 * Stage one proposed_entities row per stranded `pictured` name (#350) — never mints an entity;
 * approval (approveProposedEntity) is the separate, human step that does that and retro-links
 * every photo that named the person. Two skip classes, each counted separately in the summary:
 *   - "already resolves": an exact entity_aliases match, or the #293 unambiguous given-name-prefix
 *     inference (prefixInferredEntityId — same tombstone/ambiguity guards the ingest lane uses).
 *     Mirrors ingest precedence so the queue can never contradict the graph or duplicate someone
 *     already curated.
 *   - "already staged / decided": ANY existing proposed_entities row for this (alias, alias_type) —
 *     pending, approved, or rejected, regardless of which source staged it or under what
 *     suggested_name casing (existsProposalForAliasStmt, above) — is left alone; a rejected name
 *     reappearing would defeat #300's deliberate explicit-reopen design.
 * Both filters run over the FULL ordered backlog before `limit` is applied (mirrors
 * listProbableDuplicates' dismissal-then-slice discipline) so `--limit N` reports the top N
 * genuinely stageable names, not an arbitrary raw slice that might resolve/already-exist away to
 * fewer than N. `--dry-run` performs the identical read-only filtering and simply never reaches
 * proposeEntity's INSERT, so it writes nothing and logs nothing — a dry run must leave no trace.
 * A real run logs ONE pictured_proposals_backfill ingest_log row with the summary counts.
 */
export function stagePicturedProposals({ limit = null, dryRun = false } = {}) {
  const all = selectStrandedPicturedNamesStmt.all();
  const artifactsTotal = selectStrandedPicturedArtifactTotalStmt.get().n;
  let skippedExact = 0, skippedPrefix = 0, skippedDecided = 0, staged = 0;
  const stageable = [];
  for (const row of all) {
    if (resolveAliasByTypeStmt.all(row.alias, 'name').length) { skippedExact++; continue; }
    if (prefixInferredEntityId(row.alias) != null) { skippedPrefix++; continue; }
    if (existsProposalForAliasStmt.get(row.alias, 'name')) { skippedDecided++; continue; }
    stageable.push(row);
  }
  const scoped = limit != null ? stageable.slice(0, limit) : stageable;
  const stagedImpacts = [];
  const run = db.transaction(() => {
    for (const row of scoped) {
      if (dryRun) { staged++; stagedImpacts.push(row.artifact_count); continue; }
      // created is expected true here — the pre-filter above already ruled out any existing row
      // for this (alias, alias_type) — but proposeEntity's own UNIQUE is the real guarantee, so a
      // false (e.g. a same-run collision) is still handled rather than assumed impossible.
      const result = proposeEntity({
        suggested_kind: 'person', name: row.alias, alias: row.alias, alias_type: 'name',
        artifact_id: row.artifact_id, source: 'photo-exif-pictured-backfill',
      });
      if (result.created) { staged++; stagedImpacts.push(row.artifact_count); } else skippedDecided++;
    }
  });
  run();
  const summary = {
    namesScanned: all.length, artifactsScanned: artifactsTotal,
    skippedExact, skippedPrefix, skippedDecided, staged,
    topImpact: stagedImpacts.slice(0, 5), dryRun,
  };
  if (!dryRun) logEvent('pictured_proposals_backfill', 'backfill-pictured-proposals.js', summary);
  return summary;
}

// One-shot heal for stale pending person/org proposals keyed on a name, email, or phone alias
// (originally #413's 15 name-keyed rows; widened by #484 to email/phone, see below):
// promoteDirectoryName's and approveProposedEntity's own healing loops (above) only cover proposals
// staged AFTER this fix lands — these rows were staged and orphaned before it existed. Idempotent (a healed row is no
// longer 'pending', so a second run finds nothing); `--dry-run` performs the identical resolution
// and simply never writes, so it can never drift from what a real run would report.
// Restricted to person/org, mirroring approveProposedEntity's own name-check (:2408) — a place/event
// proposal's identity is its staged geo/span (#137/#138), never a name, and clusterPlaces/clusterEvents
// both stage alias_type='name' rows too, so an unguarded scan here could terminally resolve one to an
// unrelated same-named person (#300 makes 'approved' irreversible through any REST/MCP surface).
// Widened by #484 to alias_type IN ('name','email','phone') — the original name-only scope missed a
// proposal staged on an email/phone alias whose handle was later aliased to a live entity (#409 made
// entity_aliases the single enforced match surface; before that, a profile field wasn't guaranteed to
// be indexed there at all, so this heal could not have resolved a handle-keyed row until #409's
// backfill — npm run backfill:handle-aliases — ran). `relation` is deliberately excluded: it is never
// a resolvable identity on its own (#409's ladder never routes through it), so a future alias type
// stays safely out of scope until someone explicitly widens this list again.
// HANDLE_ALIAS_TYPES is the SINGLE source for both the SQL scope and the summary's byType keys — a
// future 4th type only needs adding here, never in two places that could silently drift apart.
const HANDLE_ALIAS_TYPES = ['name', 'email', 'phone'];
const selectPendingHandleProposalsStmt = db.prepare(
  `SELECT id, alias, alias_type FROM proposed_entities WHERE status = 'pending' AND alias_type IN (${HANDLE_ALIAS_TYPES.map(() => '?').join(', ')}) AND suggested_kind IN ('person', 'org')`
);
// Guarded on status so a row a human approved/rejected via the API between this script's read and
// write is never silently overwritten — the live service holds its own connection to the same DB.
const setProposalResolvedIfPendingStmt = db.prepare(`UPDATE proposed_entities SET status = 'approved', resolved_entity_id = ? WHERE id = ? AND status = 'pending'`);
export function healNameProposals({ dryRun = false } = {}) {
  let scanned = 0, resolved = 0, skippedNoMatch = 0, skippedAmbiguous = 0, skippedRaced = 0, linked = 0;
  const byType = Object.fromEntries(HANDLE_ALIAS_TYPES.map((t) => [t, 0]));
  // The read runs INSIDE the transaction too — reading outside then writing inside would let a
  // concurrent approve/reject (from the live service) change a row's status between the two, and the
  // status-guarded UPDATE below would then silently no-op on a row this function still counted as
  // resolved.
  const run = db.transaction(() => {
    const rows = selectPendingHandleProposalsStmt.all(...HANDLE_ALIAS_TYPES);
    scanned = rows.length;
    for (const row of rows) {
      byType[row.alias_type] = (byType[row.alias_type] ?? 0) + 1;
      // Kind-guard BOTH sides, mirroring approveProposedEntity (:2408): the WHERE clause above
      // already restricts the PROPOSAL to person/org, but an alias carries no kind of its own — a
      // place or event entity can hold the exact same (alias, alias_type) row, so the MATCHED
      // entity's kind must be checked too (Copilot review, PR #480: this filter was present in
      // approveProposedEntity but missing here).
      const matches = resolveHandle(row.alias, row.alias_type).filter((eid) => ['person', 'org'].includes(getLiveEntityStmt.get(eid)?.kind));
      if (matches.length === 0) { skippedNoMatch++; continue; }
      if (matches.length > 1) { skippedAmbiguous++; continue; } // structurally unreachable — UNIQUE(alias,alias_type) — kept as a defensive guard, matching promoteDirectoryName's identical posture
      if (dryRun) { resolved++; continue; }
      const changed = setProposalResolvedIfPendingStmt.run(matches[0], row.id).changes;
      if (changed === 0) { skippedRaced++; continue; }
      linked += resolveStagedArtifactHints(matches[0]);
      resolved++;
    }
  });
  run();
  const summary = { scanned, resolved, skippedNoMatch, skippedAmbiguous, skippedRaced, linked, byType, dryRun };
  if (!dryRun && resolved > 0) logEvent('name_proposals_healed', 'heal-name-proposals.js', summary);
  return summary;
}

// The 11 artifact columns storeArtifactTxn writes; callers pass a partial and we fill nulls.
const ARTIFACT_FIELDS = ['type', 'source', 'source_id', 'content_hash', 'occurred_at',
  'latitude', 'longitude', 'place_label', 'raw_path', 'text_repr', 'extra_json'];

// The derived/metadata columns the upsert update path may rewrite. Deliberately EXCLUDES:
// source/source_id (the upsert key); ingested_at (records FIRST ingestion — the update event
// lives in ingest_log); and content_hash + raw_path, which are the append-only ORIGINALS
// (absolute rule 5: "Preserve originals (raw_path, content_hash)") — write-once at create,
// never overwritten by a later enrichment wave, so the artifact row keeps pointing at the raw
// bytes it was born from. Absent fields keep their prior value (COALESCE in updateArtifactStmt).
const MUTABLE_FIELDS = ['type', 'occurred_at', 'latitude', 'longitude',
  'place_label', 'text_repr', 'extra_json'];

function normalizeArtifact(a) {
  const row = {};
  for (const f of ARTIFACT_FIELDS) row[f] = a[f] ?? null;
  return row;
}

/**
 * Atomic write of one artifact + its vector + entity links. Enrich-then-commit:
 * the caller MUST fetch `float32Vector` (network) BEFORE calling, so a failed API call
 * never opens this transaction (absolute rule 4). Returns { id, deduped }.
 * The FTS row is produced by the AFTER INSERT trigger — do not insert it here.
 *
 * Spanned (#328) via the wrapper below rather than inside the transaction body, so the measured
 * duration includes commit and the FTS/vec trigger work, not just the statement calls.
 */
const storeArtifactTxnRaw = db.transaction((artifact, float32Vector, links = []) => {
  const row = normalizeArtifact(artifact);
  const info = insertArtifactStmt.run(row);
  if (info.changes === 0) {
    // INSERT OR IGNORE skipped the row. The ONLY expected reason is a (source, source_id)
    // dedup hit — anything else (a NOT NULL / CHECK violation) must not be silently swallowed
    // as a dedup, or we'd lose a write and report success (violates append-only + no-swallow).
    const existing = row.source_id != null ? selectIdBySourceStmt.get(row.source, row.source_id) : null;
    if (!existing) {
      throw new Error(
        `storeArtifactTxn: insert ignored with no (source, source_id) match — likely a constraint ` +
        `violation (source=${row.source}, source_id=${row.source_id}, type=${row.type})`
      );
    }
    return { id: existing.id, deduped: true }; // genuine dedup — don't duplicate vector/links
  }
  const id = info.lastInsertRowid; // Number — safe for JSON responses
  // sqlite-vec vec0 PKs MUST bind as BigInt; a plain Number throws (data-model.md rule 1).
  insertVecArtifactStmt.run(BigInt(id), float32Vector);
  for (const l of links) {
    // entity_id + role are the entity_links PK and role is NOT NULL (#110); a missing one would be
    // silently dropped by INSERT OR IGNORE (it swallows constraint violations, incl. NOT NULL), so
    // fail fast and surface the caller's bug rather than lose the link (design-philosophy §1).
    if (l.entity_id == null || l.role == null) throw new Error(`storeArtifactTxn: link requires entity_id and role — got ${JSON.stringify(l)}`);
    insertLinkStmt.run(id, l.entity_id, l.role, l.confidence ?? 1.0);
  }
  return { id, deduped: false };
});

// spanSync, not span: better-sqlite3 transactions are synchronous, and wrapping one in an async
// span would let the event loop run mid-write. `type`/`source` are vocabulary values, not content.
export const storeArtifactTxn = (artifact, float32Vector, links = []) =>
  log.spanSync('db.artifact.stored', () => storeArtifactTxnRaw(artifact, float32Vector, links),
    { type: artifact.type, source: artifact.source, links: links.length });

/**
 * Upsert one artifact on (source, source_id), reconciling the connector contract's
 * upsert-by-default (doc 04 §1.3/§3) with the store's append-only rule. Enrich-then-commit:
 * the caller MUST fetch `float32Vector` BEFORE calling (absolute rule 4); pass null when
 * text_repr is unchanged so no re-embed happens (embedding is the expensive step).
 *
 *  - CREATE (no existing row): mirrors storeArtifactTxn — insert row + vector, resolve hints,
 *    log ingest_create. Requires a non-null vector.
 *  - UPDATE (row exists): rewrite ONLY the present derived/metadata fields (MUTABLE_FIELDS);
 *    originals are never destroyed (raw_path files untouched, content_hash still tracks the
 *    raw bytes, ingested_at frozen). The vec row is updated in place only when a new vector
 *    is passed. Hints are re-resolved (idempotent). The ingest_update log row carries the
 *    prior value of every changed field, so the full evolution of the derived record is
 *    reconstructable from the log (design-philosophy §1/§3) — the log IS the history.
 *
 * Entity links are additive on update (resolveEntityHints is INSERT OR IGNORE). Returns
 * { id, created, resolved, unresolved }.
 */
const upsertArtifactTxnRaw = db.transaction((artifact, float32Vector, hints = []) => {
  let existing = artifact.source_id != null
    ? getArtifactBySourceStmt.get(artifact.source, artifact.source_id)
    : null;

  if (!existing) {
    // Create path requires a vector — a null here would insert a broken vec row or throw an
    // opaque sqlite-vec error. Guard with a clear message (enrich-then-commit means the caller
    // fetches the embedding before opening this transaction — absolute rule 4).
    if (!float32Vector) {
      throw new Error(
        `upsertArtifactTxn: create path requires an embedding vector ` +
        `(source=${artifact.source}, source_id=${artifact.source_id})`
      );
    }
    const row = normalizeArtifact(artifact);
    const info = insertArtifactStmt.run(row);
    if (info.changes === 0) {
      // INSERT OR IGNORE skipped the row. WAL lets a separate process (migrate, a connector
      // script) insert this (source, source_id) between our read above and this insert — a
      // normal concurrent-upsert outcome, not a failure. Re-read: if the row now exists, fall
      // through to the update path so the ingest stays idempotent (§1.3) instead of 500ing. If
      // it's STILL absent, the ignore was a real constraint violation — never swallow that.
      existing = getArtifactBySourceStmt.get(row.source, row.source_id);
      if (!existing) {
        throw new Error(
          `upsertArtifactTxn: insert ignored with no dedup match — likely a constraint violation ` +
          `(source=${row.source}, source_id=${row.source_id}, type=${row.type})`
        );
      }
      // fall through to the update path below
    } else {
      const id = info.lastInsertRowid; // Number — safe for JSON responses
      insertVecArtifactStmt.run(BigInt(id), float32Vector); // vec0 PK must bind as BigInt (rule 1)
      const { resolved, unresolved } = resolveEntityHints(id, hints);
      logEvent('ingest_create', row.source, { artifact_id: id, type: row.type });
      return { id, created: true, resolved, unresolved };
    }
  }

  const textChanged = artifact.text_repr != null && artifact.text_repr !== existing.text_repr;

  // Guard the enrich-then-commit window: the caller decided whether to re-embed from a read
  // taken BEFORE this transaction. If text_repr changed but no new vector was supplied, a
  // concurrent upsert of the same key changed the text underneath us — committing would leave
  // text_repr and its embedding out of sync. Fail loudly so the connector retries (idempotent)
  // rather than silently persisting a mismatch.
  if (textChanged && !float32Vector) {
    throw new Error(
      `upsertArtifactTxn: text_repr changed under a concurrent upsert (source=${artifact.source}, ` +
      `source_id=${artifact.source_id}) but no embedding was supplied — retry the ingest`
    );
  }

  // Update path: build the bind from present fields, tracking what actually changed.
  const changed = [];
  const prior = {};
  const bind = { id: existing.id };
  for (const f of MUTABLE_FIELDS) {
    const val = artifact[f] ?? null;
    bind[f] = val; // null → COALESCE keeps the existing value
    if (val !== null && val !== existing[f]) { changed.push(f); prior[f] = existing[f]; }
  }
  // Only touch text_repr (and thus fire the FTS trigger) when it actually changed; a
  // metadata-only wave uses the variant that omits it, so the FTS index isn't churned.
  if (textChanged) {
    updateArtifactStmt.run(bind);
  } else {
    const { text_repr, ...metaBind } = bind;
    updateArtifactMetaStmt.run(metaBind);
  }
  // Update the vector whenever a new one was supplied (in the normal flow that's exactly when
  // text_repr changed; a direct caller may also re-embed unchanged text).
  if (float32Vector) updateVecArtifactStmt.run(float32Vector, BigInt(existing.id));
  const { resolved, unresolved } = resolveEntityHints(existing.id, hints);
  logEvent('ingest_update', artifact.source, { artifact_id: existing.id, type: artifact.type, changed, prior });
  return { id: existing.id, created: false, resolved, unresolved };
});

// The connector ingest lane's write path — same spanSync wrapper and same reasoning as
// storeArtifactTxn above. `created` lands on the span so the create/update split is a GROUP BY.
export const upsertArtifactTxn = (artifact, float32Vector, hints = []) => {
  const data = { type: artifact.type, source: artifact.source, hints: hints.length, reembedded: !!float32Vector };
  return log.spanSync('db.artifact.upserted', () => {
    const result = upsertArtifactTxnRaw(artifact, float32Vector, hints);
    data.created = result.created;
    return result;
  }, data);
};

// x- extension types (#244) are unregistered by design (docs/04-connector-contract.md §6), so
// there's no static list to publish for them — this is the only way a caller can discover which
// ones actually exist in the store, alongside the static TYPE_REGISTRY. The GLOB is a cheap SQL
// prefilter only (uses idx_artifacts_type's range scan on the 'x-' prefix) — GLOB has no repeated
// character-class quantifier, so 'x-?*' still passes something like "x-Dev-Note" or "x-foo_bar"
// that isExtensionType()'s /^x-[a-z0-9-]+$/ would reject. The isExtensionType() filter below is
// the exact gate, reusing the same write-side validator so this can never advertise a marker no
// write path would accept — belt-and-suspenders should a non-conforming row ever exist (a legacy
// row, a manual DB edit) despite every current write path already enforcing it.
const listExtensionTypesStmt = db.prepare(
  `SELECT type, COUNT(*) AS count FROM artifacts WHERE type GLOB 'x-?*' GROUP BY type ORDER BY type`
);
export const listObservedExtensionTypes = () => listExtensionTypesStmt.all().filter((t) => isExtensionType(t.type));

// --- Shared helpers ---
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function logEvent(eventType, actor, details) {
  logStmt.run(eventType, actor, details == null ? null : JSON.stringify(details));
}

export const normalizeName = (s) => s.trim().toLowerCase();
// Digit-strip, then canonicalize the NANP country code: an 11-digit key beginning with `1`
// (US/Canada) drops the leading `1` so `+1 (415) 555-0148`, `1-415-555-0148`, and
// `(415) 555-0148` all collapse to `4155550148` and resolve to one contact (#129). Assumption:
// an 11-digit key starting with `1` is a US country code. Non-NANP international (e.g. `+44…`),
// bare 10-digit, and 7-digit local numbers are left untouched. Not full E.164 (would need a
// default region + libphonenumber) — out of scope; this covers US-with/without-`+1`.
export const normalizePhone = (s) => { const d = s.replace(/\D/g, ''); return /^1\d{10}$/.test(d) ? d.slice(1) : d; };

// The two attrs_json list fields (#409) entity_aliases must index — the "⊆" side of the
// "fields ⊆ aliases" invariant (data-model.md). One shared mapping key -> alias_type ->
// normalizer so reconcileHandleAliases, fillEntityAttrsFromCard's tombstone pre-filter, the
// startup detect pass below, and promoteDirectoryName's handle loop can never drift on which
// field feeds which alias type.
const HANDLE_ALIAS_FIELDS = [['emails', 'email', normalizeName], ['phones', 'phone', normalizePhone]];

// The set of name aliases a person should answer to (#93). Always the full FN + each verbatim
// nickname; when `derive` is on (persons, not orgs) we also add:
//   - a given+family form when a middle name is present, so "Amy Fenwick" resolves an entity
//     stored as "Amy Margaret Fenwick" (exact-match lookup misses the middle name otherwise);
//   - a nickname+family form ("betsy allister"), so a related-name reference by nickname+surname
//     resolves alongside the bare nickname ("betsy").
// Prefers the structured N split (given/family/additional). When it's absent (e.g. the backfill,
// which only has canonical_name) we fall back to tokenizing FN, but ONLY for a clean 2- or
// 3-token name (first [middle] last) — a 4+ token name is too ambiguous (compound given names,
// multi-part surnames) to reduce to first+last without minting a wrong alias, so we skip it.
// `derive: false` (orgs) yields just the full name + nicknames — a company name has no given/
// family to reduce, and "Bank of America" must not become "bank america". Returns normalized,
// de-duped strings; callers INSERT OR IGNORE so re-runs are no-ops.
export function nameVariants({ fn, given, family, additional, nicknames = [], derive = true }) {
  const nicks = Array.isArray(nicknames) ? nicknames : [];
  const out = new Set();
  const add = (s) => { const n = typeof s === 'string' && normalizeName(s); if (n) out.add(n); };
  if (fn) add(fn);
  for (const nick of nicks) add(nick);
  if (derive) {
    const toks = typeof fn === 'string' ? fn.trim().split(/\s+/) : [];
    const g = given || toks[0];
    // Trust a structured family outright; from tokenization only accept the last of a 2/3-token name.
    const f = family || (toks.length === 2 || toks.length === 3 ? toks[toks.length - 1] : null);
    const hasMiddle = Boolean(additional) || toks.length === 3;
    if (hasMiddle && g && f) add(`${g} ${f}`);
    if (f) for (const nick of nicks) add(`${nick} ${f}`);
  }
  return [...out];
}

// Resolve a free-text name/email/phone into entity ids via the alias table. Name/email
// aliases are stored lowercased; phone aliases digits-only — so try both normalizations.
//
// No merge-tombstone redirect is needed here (#75): mergeEntities re-points EVERY
// entity_aliases row off the absorbed entity unconditionally (see repointAliasesStmt below —
// (alias, alias_type) is globally unique, so the repoint can never collide and is never
// partial), so an alias can never resolve to an id with entities.merged_into set. The same
// invariant is why resolveEntityHints' resolveAliasByTypeStmt lookup (used by the connector
// ingest lane) needs no redirect either — both read the same always-live table.
export function resolveEntityIds(term) {
  const ids = new Set(resolveAliasStmt.all(normalizeName(term)).map((r) => r.entity_id));
  const digits = normalizePhone(term);
  if (digits.length >= 7) for (const r of resolveAliasStmt.all(digits)) ids.add(r.entity_id);
  return [...ids];
}

// The ONLY exact-match resolver scoped to a single alias TYPE, live entities only (#409). Not a
// new query — resolveAliasByTypeStmt already existed — but the single normalize+resolve+live-
// filter surface every future caller reaches for instead of re-typing the ladder (Design
// Decisions: matching is currently re-typed at ~10 sites). Normalizes via normalizeAlias (defined
// below; referenced here by closure, resolved at call time — same as every other forward
// reference in this file), so a caller passes a raw value. No merge-tombstone redirect needed
// (#75, see resolveEntityIds' own comment above): mergeEntities re-points EVERY alias off the
// absorbed entity, so an alias can never resolve to a merged_into id — the getLiveEntityStmt
// filter here is belt-and-suspenders, matching this file's dominant defensive-liveness style.
// Returns entity ids (at most one, in practice — UNIQUE(alias, alias_type) is globally
// single-owner per type — but callers must not assume that; an ambiguous case just yields >1).
export function resolveHandle(alias, aliasType) {
  const norm = normalizeAlias(alias, aliasType);
  if (!norm) return [];
  return resolveAliasByTypeStmt.all(norm, aliasType)
    .map((r) => r.entity_id)
    .filter((id) => getLiveEntityStmt.get(id));
}

/**
 * The documented ingest-lane precedence ladder (#409), in one place: exact (resolveHandle) ->
 * the #293 unambiguous given-name-prefix inference (name only, tombstone-guarded via
 * prefixInferredEntityId) -> the #154/#301 side-directory consult. Read-only: never writes an
 * alias, a link, or a proposal — resolveEntityHints (the current caller, step 6) still records the
 * confidence tier and does the writing itself, since the right action differs by rung (an exact
 * hit links every match; a directory hit may attach-or-propose depending on whether the name is
 * already live). Returns which rung matched (or null) so a caller need not re-derive it.
 */
export function resolveForIngest(alias, aliasType) {
  const norm = normalizeAlias(alias, aliasType);
  if (!norm) return { entityId: null, via: null, directoryName: null };
  const exact = resolveHandle(norm, aliasType);
  if (exact.length) return { entityId: exact[0], via: 'exact', directoryName: null };
  if (aliasType === 'name') {
    const inferred = prefixInferredEntityId(norm);
    if (inferred != null) return { entityId: inferred, via: 'prefix', directoryName: null };
  }
  if (aliasType === 'phone' || aliasType === 'email' || aliasType === 'name') {
    const dirName = aliasType === 'name' ? lookupDirectoryByName(norm) : lookupDirectoryName(norm, aliasType);
    if (dirName) return { entityId: null, via: 'directory', directoryName: dirName };
  }
  return { entityId: null, via: null, directoryName: null };
}

// Given-name prefix fallback (#184). Resolves a bare first name ("sam") to a person stored under
// a full name alias ("sam rivera"), but ONLY when exactly one distinct entity matches the
// token-boundary prefix — two people sharing a first name stay unresolved (a wrong filter is
// worse than none). Returns the single entity's id(s) or [] (no match, or ambiguous). LIKE
// metacharacters in the term are escaped (matching the stmt's ESCAPE '\') so a stray `%`/`_`
// can't widen the match.
//
// Started search-path-only; since #293/#296 the ingest lane calls it too, but ONLY through
// prefixInferredEntityId, which adds the tombstone guard and records the link at
// NAME_PREFIX_CONFIDENCE_CAP. Still deliberately separate from resolveEntityIds, which must stay
// exact-match/deterministic on the hot ingest/annotate/display path — that separation is the
// invariant, not "query time only". A caller that reaches past prefixInferredEntityId to link on
// ingest is re-introducing the #296 bug: an inference recorded as though it were an exact match.
export function resolveNameByPrefix(term) {
  const t = normalizeName(term).replace(/[\\%_]/g, '\\$&');
  if (!t) return [];
  const ids = resolveNameByPrefixStmt.all({ t }).map((r) => r.entity_id); // capped at 2 rows (see stmt)
  if (ids.length > 1) {
    log.warn('entity.prefix.ambiguous', 'given-name prefix matches several entities, left unresolved', { matches: ids.length });
    return [];
  }
  return ids; // 0 rows (no match) or the single matching entity
}

// Deterministic alias types earn confidence 1.0 outright (connector-supplied value ignored);
// name/handle earn only the connector-supplied confidence, capped (connector contract doc 04 §4).
const DETERMINISTIC_ALIAS_TYPES = new Set(['email', 'phone']);
const NAME_HANDLE_DEFAULT_CONFIDENCE = 0.7;
export const NAME_HANDLE_CONFIDENCE_CAP = 0.9;
// #296: a given-name-prefix match is an *inference* ("only one contact starts with 'suzie'"),
// not a match on what the connector actually supplied — so it earns its own, lower tier rather
// than masquerading as an exact name hit. Applied at the call site, deliberately NOT inside
// hintConfidence(): that keys off alias_type, and this is a difference of provenance, not type.
// The ladder a later audit relies on: 1.0 deterministic (email/phone) > 0.9 exact name/handle
// > 0.6 prefix inference. Collapsing the last two hides the guesses worth reviewing.
export const NAME_PREFIX_CONFIDENCE_CAP = 0.6;

function hintConfidence(aliasType, supplied) {
  if (DETERMINISTIC_ALIAS_TYPES.has(aliasType)) return 1.0;
  // Garbage supplied values (NaN, Infinity, negative, non-number) are treated as absent
  // rather than persisted into entity_links.confidence, where they'd corrupt ranking.
  const isValidSupplied = typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0;
  return Math.min(isValidSupplied ? supplied : NAME_HANDLE_DEFAULT_CONFIDENCE, NAME_HANDLE_CONFIDENCE_CAP);
}

/**
 * The ingest-time half of the #293 given-name-prefix fallback: the unambiguous candidate for a
 * bare `name` alias, or null. Adds the tombstone guard (#111/#296) that the query-time caller
 * doesn't need — a user who explicitly removed the bare given name from a contact would
 * otherwise have it re-inferred through the surviving fuller alias on every subsequent ingest,
 * with no way to stop it. A tombstoned (entity, alias, 'name') falls through to staging.
 * Shared by resolveEntityHints and resolveStagedNamePrefixHints so live and retroactive
 * resolution can't diverge (same reasoning as hintConfidence).
 */
function prefixInferredEntityId(alias) {
  const [entityId] = resolveNameByPrefix(alias);
  if (entityId == null) return null;
  if (hasTombstoneStmt.get(entityId, alias, 'name')) {
    log.warn('entity.prefix.tombstoned', 'prefix match suppressed by an alias tombstone, left unresolved', { entity_id: entityId });
    return null;
  }
  return entityId;
}

/**
 * Resolve connector-submitted alias hints against entity_aliases (connector contract doc 04
 * §4). Hints, never IDs — resolution is wholly core-side, so a buggy connector can never
 * corrupt the graph. An exact normalized match links every matching entity (ambiguity
 * preserved, not guessed away, per resolveEntityIds' own multi-match behavior); a miss
 * stages a row in unresolved_aliases for later retroactive resolution. Synchronous,
 * prepared-statements-only, no network — composable inside the caller's own open
 * transaction alongside the artifact write. Returns { resolved, unresolved } entity/alias
 * counts (future contract response fields resolved_entities / unresolved_aliases).
 */
export function resolveEntityHints(artifactId, hints) {
  let resolved = 0, unresolved = 0;
  // #119: the artifact's source is stamped on any proposal staged below — fetch it once here,
  // not per hint, since it's constant across the loop (only read when a suggested_kind miss occurs).
  let artifactSource = null, sourceFetched = false;
  const sourceOf = () => { if (!sourceFetched) { artifactSource = getArtifactStmt.get(artifactId)?.source ?? null; sourceFetched = true; } return artifactSource; };
  for (const hint of hints) {
    const aliasType = hint.alias_type ?? null;
    // '' rather than null: SQLite UNIQUE indexes don't treat NULL as equal to NULL, so a
    // role-less/type-less hint retried with the same input would otherwise insert a
    // duplicate row instead of hitting the UNIQUE constraint (breaks idempotency).
    const role = hint.role ?? '';
    const alias = aliasType === 'phone' ? normalizePhone(hint.alias) : normalizeName(hint.alias);
    const confidence = hintConfidence(aliasType, hint.confidence);
    const matches = resolveAliasByTypeStmt.all(alias, aliasType);
    // #293: an exact miss on a name-type hint gets one more try — the same unambiguous
    // given-name-prefix fallback #184 already trusts at query time (resolveNameByPrefix: word-
    // boundary prefix, stays unresolved on 0 or >=2 candidates). Lets a bare first name
    // ("suzie") from a connector's pictured hint resolve to a contact stored under a fuller
    // name ("suzie araujo") instead of staging forever in unresolved_aliases.
    // #296: the inference is re-run per ingest and never minted as an alias — a durable
    // ('suzie','name') row would own UNIQUE(alias, alias_type) globally, permanently routing
    // every later bare-"suzie" hint through the exact path and silently denying a second Suzie
    // her own given name. Two guards below keep the inference honest.
    const inferredId = !matches.length && aliasType === 'name' ? prefixInferredEntityId(alias) : null;
    if (matches.length) {
      for (const m of matches) insertLinkStmt.run(artifactId, m.entity_id, role, confidence);
      resolved += matches.length;
    } else if (inferredId != null) {
      // Capped below an exact match: this link is a guess, and the ladder is what a later
      // review filters on. Logged because a heuristic link must never form silently (§4).
      const inferredConfidence = Math.min(confidence, NAME_PREFIX_CONFIDENCE_CAP);
      insertLinkStmt.run(artifactId, inferredId, role, inferredConfidence);
      resolved++;
      log.info('entity.prefix.inferred', 'hint linked by unambiguous given-name prefix', { entity_id: inferredId, artifact_id: artifactId, confidence: inferredConfidence });
    } else {
      insertUnresolvedStmt.run(artifactId, alias, aliasType ?? '', role, hint.confidence ?? null);
      // #119: a hint carrying suggested_kind asks to CREATE (not just link) an entity — stage it
      // for human review instead of minting it, so low-signal senders never auto-pollute the graph.
      // The unresolved_aliases row above still stands, so approving later retroactively links this artifact.
      if (hint.suggested_kind) {
        unresolved++;
        proposeEntity({
          suggested_kind: hint.suggested_kind,
          name: hint.alias,
          alias,
          alias_type: aliasType ?? '',
          artifact_id: artifactId,
          source: sourceOf(),
          confidence: hint.confidence ?? null,
        });
      } else if (aliasType === 'phone' || aliasType === 'email' || aliasType === 'name') {
        // #154/#301: the connector sent no suggested_kind, but the side directory may know this
        // handle — or, since #301, this NAME. Reached only on a full miss: an exact alias match,
        // and for a name also the #293 prefix inference, both short-circuit above — the directory
        // is the last resort, not a competitor. 'handle' and 'relation' stay excluded (relation has
        // its own resolver, resolveRelationHints).
        const dirName = aliasType === 'name' ? lookupDirectoryByName(alias) : lookupDirectoryName(alias, aliasType);
        // #409 (the #2096 repro): the directory can name someone who is ALREADY a live entity —
        // resolveHandle (never attrs_json) is the single exact-match resolver. Attach instead of
        // proposing a duplicate: alias this hint to the entity the directory's name already
        // resolves to, and link it at the tier the alias type earns, so a repeat of the SAME hint
        // later resolves at the top of the ladder with no directory consult needed. A tombstoned
        // (owner, alias, aliasType) — the user deliberately removed this handle from that entity —
        // still falls through to the ordinary propose path.
        const dirOwners = dirName ? resolveHandle(dirName, 'name') : [];
        if (dirOwners.length === 1 && !hasTombstoneStmt.get(dirOwners[0], alias, aliasType)) {
          insertAliasUnlessTombstoned(dirOwners[0], alias, aliasType);
          insertLinkStmt.run(artifactId, dirOwners[0], role, confidence);
          resolved++;
          log.info('entity.directory.attached', 'directory-resolved name already curated; aliased and linked instead of proposing', { entity_id: dirOwners[0], artifact_id: artifactId });
        } else {
          unresolved++;
          // Stage a person proposal with the directory's display name (pre-filled) for review.
          // Promotion into the curated graph still requires approval; the unresolved_aliases row
          // above stands, so an approval retroactively links this artifact (and every other
          // artifact that staged the same hint). Idempotent via proposed_entities' UNIQUE, which is
          // what makes 1,887 photos of one person stage exactly one proposal.
          if (dirName) proposeEntity({ suggested_kind: 'person', name: dirName, alias, alias_type: aliasType, artifact_id: artifactId, source: sourceOf(), confidence: hint.confidence ?? null });
        }
      } else {
        unresolved++;
      }
    }
  }
  return { resolved, unresolved };
}

// The entity's own aliases, and the staged artifact hints matching one (alias, alias_type).
// alias_type != 'relation' keeps person<->person relation staging (resolveRelationHints) out —
// though entity_aliases never holds a 'relation' type anyway, so the guard is belt-and-suspenders.
// ORDER BY deterministic-first: when multiple hints share one (artifact, entity, role) they collide
// on entity_links' PK and INSERT OR IGNORE keeps the FIRST — so email/phone (1.0) must be tried
// before name/handle, or a capped-0.9 name link would wrongly shadow a deterministic match. Within
// a type, higher supplied confidence wins.
const selectEntityAliasesStmt = db.prepare(`SELECT alias, alias_type FROM entity_aliases WHERE entity_id = ? ORDER BY CASE alias_type WHEN 'email' THEN 0 WHEN 'phone' THEN 0 ELSE 1 END`);
const selectArtifactHintsStmt = db.prepare(`SELECT artifact_id, role, hint_confidence FROM unresolved_aliases WHERE alias = ? AND alias_type = ? AND alias_type != 'relation' ORDER BY hint_confidence DESC`);

/**
 * Retroactively link artifacts whose connector hints (doc 04 §4) were staged in
 * unresolved_aliases before this entity existed — "resolving retroactively links all queued
 * artifacts." For each of the entity's own aliases (name/email/phone/handle), form an
 * entity_links row for every staged hint matching (alias, alias_type). Confidence follows the
 * same hintConfidence() policy as resolveEntityHints, so ingest-time and retroactive linking
 * cannot diverge. Append-only + idempotent: staged rows are left in place (mirrors
 * resolveRelationHints) and the INSERT OR IGNORE + entity_links PK absorb re-runs.
 * Called automatically by EVERY path that gives an entity a new alias — contact import/re-import,
 * approveProposedEntity, and the contacts-UI writes createEntity / updateEntityAttrs / addAlias
 * (#295; the UI paths omitted it, so a hint staged before the alias existed stayed unlinked
 * forever). NOT scheduled — the steady-state paths sweep themselves, which is what makes
 * `npm run backfill:links` a one-shot heal rather than a recurring job. Returns links formed.
 */
export function resolveStagedArtifactHints(entityId) {
  let formed = 0;
  for (const { alias, alias_type } of selectEntityAliasesStmt.all(entityId)) {
    for (const hint of selectArtifactHintsStmt.all(alias, alias_type)) {
      const confidence = hintConfidence(alias_type, hint.hint_confidence);
      formed += insertLinkStmt.run(hint.artifact_id, entityId, hint.role, confidence).changes;
    }
  }
  return formed;
}

// Sweep-and-log for the contacts-UI write paths (#295), so createEntity/updateEntityAttrs/addAlias
// share one policy instead of three copies. Called from inside each caller's db.transaction, so a
// throw here rolls the alias write back with it. Logs only when the graph actually changed
// (design-philosophy §4) — the resolver is idempotent, so a no-op re-run is not an event.
// Cost note: on an entity with a large staged backlog the first sweep forms every missing link
// while holding the write lock (entity 70 in #295: ~3,000 links), so that one UI click is a
// multi-second locked write. Subsequent writes form 0 and are instant.
function sweepStagedHints(entityId, details) {
  const linksFormed = resolveStagedArtifactHints(entityId);
  if (linksFormed > 0) logEvent('staged_hints_resolved', 'contacts-ui', { ...details, linksFormed });
  return linksFormed;
}

// Distinct staged `name` hints that no entity owns exactly — the candidates for a prefix
// inference. role != 'relation' mirrors selectArtifactHintsStmt (relation staging is
// resolveRelationHints' domain).
const selectUnresolvedNameAliasesStmt = db.prepare(`
  SELECT DISTINCT alias FROM unresolved_aliases
  WHERE alias_type = 'name' AND role != 'relation'
    AND alias NOT IN (SELECT alias FROM entity_aliases WHERE alias_type = 'name')
`);
const selectStagedByAliasStmt = db.prepare(`SELECT artifact_id, role, hint_confidence FROM unresolved_aliases WHERE alias = ? AND alias_type = 'name' AND role != 'relation'`);

// Exported so the one-shot confidence repair (scripts/fix-name-prefix-link-confidence.js) selects
// the SAME candidate set this resolver does — two hand-kept copies of the query would drift, and a
// repair that silently skips rows is worse than none.
export const listUnresolvedNamePrefixAliases = () => selectUnresolvedNameAliasesStmt.all().map((r) => r.alias);

/**
 * The retroactive half of #293: link hints staged *before* resolveEntityHints gained the prefix
 * fallback. resolveStagedArtifactHints can't do this — it walks an entity's OWN aliases, and the
 * whole point (#296) is that the bare given name is never one of them. So this resolves each
 * staged bare name by prefix instead, under the same two guards as the live path
 * (prefixInferredEntityId's tombstone check, NAME_PREFIX_CONFIDENCE_CAP), and writes zero
 * aliases. Append-only + idempotent: staged rows stay (mirrors resolveStagedArtifactHints), and
 * INSERT OR IGNORE on entity_links' PK absorbs re-runs — a second call forms 0.
 * Returns { checked, linksFormed, stillUnresolved }.
 */
export function resolveStagedNamePrefixHints() {
  const aliases = listUnresolvedNamePrefixAliases();
  let linksFormed = 0, stillUnresolved = 0;
  for (const alias of aliases) {
    const entityId = prefixInferredEntityId(alias);
    if (entityId == null) { stillUnresolved++; continue; }
    for (const hint of selectStagedByAliasStmt.all(alias)) {
      const confidence = Math.min(hintConfidence('name', hint.hint_confidence), NAME_PREFIX_CONFIDENCE_CAP);
      linksFormed += insertLinkStmt.run(hint.artifact_id, entityId, hint.role, confidence).changes;
    }
  }
  return { checked: aliases.length, linksFormed, stillUnresolved };
}

// Canonical person<->person relation vocabulary (issue #37). Maps an Apple X-ABLabel /
// Google `type` / Android relation label (lowercased) onto one enum; anything unrecognized is
// 'custom' with the original label preserved in entity_relations.raw_label.
const RELATION_TYPE_MAP = {
  spouse: 'spouse', husband: 'spouse', wife: 'spouse',
  partner: 'partner',
  'domestic partner': 'domesticPartner', domesticpartner: 'domesticPartner',
  child: 'child', son: 'child', daughter: 'child',
  parent: 'parent', mother: 'mother', mom: 'mother', father: 'father', dad: 'father',
  sibling: 'sibling', brother: 'brother', sister: 'sister',
  friend: 'friend', relative: 'relative',
  assistant: 'assistant', manager: 'manager',
  'referred by': 'referredBy', referredby: 'referredBy',
  worksat: 'worksAt', employer: 'worksAt',   // person->org employment edge (#88)
};
export const canonicalRelationType = (rawLabel) =>
  RELATION_TYPE_MAP[String(rawLabel ?? '').trim().toLowerCase()] || 'custom';

/**
 * Insert one append-only person<->person edge (OR IGNORE — re-inserting the same triple is a
 * no-op, so callers are idempotent). Logs `relation_added` only when a row is actually created.
 * Returns true if a new edge was written.
 */
export function upsertEntityRelation({ from_entity_id, to_entity_id, relation_type, raw_label = null, confidence = 1.0, source = null }, eventType = 'relation_added') {
  const info = insertRelationStmt.run({ from_entity_id, to_entity_id, relation_type, raw_label, confidence, source });
  if (info.changes > 0) logEvent(eventType, source ?? 'entity_relations', { from_entity_id, to_entity_id, relation_type, raw_label });
  return info.changes > 0;
}

/**
 * Resolve an org by name, or create it (kind='org') and seed its name aliases so pending relation
 * hints for that name resolve. For a person's employer field (#125) — trusted, deliberate contact
 * data, so NOT gated by the proposed-entities approval queue (which governs artifact-derived
 * entities). Idempotent: resolve-first means an existing org card (imported before or after) or a
 * re-import forms zero new entities. `derive:false` — a company name has no given/family to reduce
 * ("Bank of America" must not become "bank america"), mirroring the org-card alias seeding in
 * contacts.js. Returns the org entity id.
 */
export function ensureOrgEntity(name) {
  const existing = resolveEntityIds(name);
  if (existing.length) return existing[0];
  const id = insertEntityStmt.run('org', name, '{}').lastInsertRowid;
  for (const alias of nameVariants({ fn: name, derive: false })) insertAliasUnlessTombstoned(id, alias, 'name');
  return id;
}

// --- Place entities (#137): a geo-anchored, human-approved location node. ---
// A place's coordinates live in attrs_json {latitude, longitude, radius_km}; kind='place' is
// free-text (no DDL / vec / VECTOR_DIMENSION impact — a place has no embedding). Reuses the #68
// bbox+haversine prefilter pattern; haversineKm comes from geocode.js (no import cycle —
// geocode.js is I/O-pure and imports nothing from db.js).
const KM_PER_DEG_LAT = 111.32;   // matches search.js's geo-radius prefilter (#68)
const POLE_COS_EPSILON = 1e-6;   // below this |cos(lat)| the longitude span blows up — cover the whole band
const LON_ABS_MAX = 180;         // longitude range is [-180, 180]
const placeBboxStmt = db.prepare(`
  SELECT id, latitude, longitude FROM artifacts
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    AND latitude BETWEEN @latMin AND @latMax
    AND longitude BETWEEN @lonMin AND @lonMax
`);

/**
 * Resolve a place by name, or create it (kind='place') with its geo in attrs_json and seed name
 * aliases so `about_entity`/`search entities:[…]` resolve it. Mirrors ensureOrgEntity (#125):
 * resolve-first (idempotent — a 2nd call mints 0 entities/aliases), `derive:false` (a place name
 * has no given/family to reduce, like an org). Does NOT link artifacts — call
 * linkArtifactsToPlace(id) after. Returns the place entity id.
 */
export function ensurePlaceEntity(name, { latitude = null, longitude = null, radius_km = null } = {}) {
  const existing = resolveEntityIds(name);
  if (existing.length) return existing[0];
  const id = Number(insertEntityStmt.run('place', name, JSON.stringify({ latitude, longitude, radius_km })).lastInsertRowid);
  for (const alias of nameVariants({ fn: name, derive: false })) insertAliasUnlessTombstoned(id, alias, 'name');
  logEvent('entity_created', 'places', { entity_id: id, kind: 'place', canonical_name: name });
  return id;
}

/**
 * Link every GPS-bearing artifact within a place's radius to it via entity_links (role
 * 'location_of', OR IGNORE — idempotent, append-only). A degree bounding box narrows the SQL scan,
 * then an exact haversine pass trims it to a true circle (the #68 geoCandidateIds pattern). A place
 * with null/invalid coords or radius links nothing (logged), never throws. Runs in its own
 * transaction (nested via savepoint when called from createEntity/approveProposedEntity). Returns
 * the count of newly-created links.
 */
export const linkArtifactsToPlace = db.transaction((placeId) => {
  const { latitude, longitude, radius_km } = getEntity(placeId)?.attrs ?? {};
  const lat = Number(latitude);
  const lon = Number(longitude);
  const radiusKm = Number(radius_km);
  // Reject null/absent coords EXPLICITLY: Number(null) is 0, so relying on Number.isFinite alone
  // would center the search on (0,0) instead of no-op'ing. lat/lon of 0 (equator / prime meridian)
  // is a legitimate coordinate and still passes.
  if (latitude == null || longitude == null || ![lat, lon, radiusKm].every(Number.isFinite) || radiusKm <= 0) {
    logEvent('place_linked', 'places', { entity_id: placeId, linked: 0, reason: 'no-coords-or-radius' });
    return 0;
  }
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Near a pole longitude is meaningless (all meridians converge), so the box spans the ENTIRE
  // [-180, 180] band regardless of lon (matching geoCandidateIds #68 — NOT lon±180, which would
  // exclude valid longitudes when lon≠0); otherwise a degree-based half-width around lon.
  const nearPole = Math.abs(cosLat) < POLE_COS_EPSILON;
  const dLon = nearPole ? 0 : radiusKm / (KM_PER_DEG_LAT * Math.abs(cosLat));
  const rows = placeBboxStmt.all({
    latMin: lat - dLat, latMax: lat + dLat,
    lonMin: nearPole ? -LON_ABS_MAX : lon - dLon,
    lonMax: nearPole ? LON_ABS_MAX : lon + dLon,
  });
  let linked = 0;
  for (const r of rows) {
    if (haversineKm(lat, lon, r.latitude, r.longitude) > radiusKm) continue;
    if (insertLinkStmt.run(r.id, placeId, 'location_of', 1.0).changes > 0) linked++;
  }
  logEvent('place_linked', 'places', { entity_id: placeId, scanned: rows.length, linked });
  return linked;
});

// --- Event entities (#138): a time-bounded (optionally place-anchored) episode node. ---
// An event's span/place lives in attrs_json {start, end, place_entity_id?}; kind='event' is
// free-text (no DDL / vec impact — an event has no embedding). Reuses proposed_entities.attrs_json
// and the kind-generalized approveProposedEntity from #137. Linking is temporal (occurred_at in
// [start,end]) + an optional spatial intersect with the referenced place's radius.
const eventArtifactsStmt = db.prepare(`
  SELECT id, latitude, longitude FROM artifacts
  WHERE occurred_at IS NOT NULL
    AND datetime(occurred_at) >= datetime(@start)
    AND datetime(occurred_at) <= datetime(@end)
`);

/**
 * Resolve an event by name, or create it (kind='event') with its span/place in attrs_json and seed
 * name aliases so `about_entity`/`search entities:[…]` resolve it. Mirrors ensurePlaceEntity /
 * ensureOrgEntity: resolve-first (idempotent — a 2nd call mints 0), `derive:false` (an event name
 * has no given/family to reduce). Does NOT link artifacts — call linkArtifactsToEvent(id) after.
 * Returns the event entity id.
 */
export function ensureEventEntity(name, { start = null, end = null, place_entity_id = null } = {}) {
  const existing = resolveEntityIds(name);
  if (existing.length) return existing[0];
  const id = Number(insertEntityStmt.run('event', name, JSON.stringify({ start, end, place_entity_id })).lastInsertRowid);
  for (const alias of nameVariants({ fn: name, derive: false })) insertAliasUnlessTombstoned(id, alias, 'name');
  logEvent('entity_created', 'events', { entity_id: id, kind: 'event', canonical_name: name });
  return id;
}

/**
 * Link every artifact whose `occurred_at` falls in the event's [start, end] span to it via
 * entity_links (role 'part_of', OR IGNORE — idempotent, append-only). Dates are normalized to ISO
 * and compared with SQLite `datetime()` so a 'YYYY-MM-DD HH:MM:SS' occurred_at and an ISO span
 * compare correctly. If the event references a place (place_entity_id) with usable coords, linking
 * is ADDITIONALLY constrained to that place's radius (haversine) — coordless artifacts are excluded
 * since they can't be confirmed at the place; a referenced place with no usable coords degrades to
 * time-only (logged). An event with a null/invalid span links nothing (logged), never throws. Runs
 * in its own transaction (nested via savepoint from createEntity/approveProposedEntity). Returns the
 * count of newly-created links.
 */
export const linkArtifactsToEvent = db.transaction((eventId) => {
  const { start, end, place_entity_id } = getEntity(eventId)?.attrs ?? {};
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    logEvent('event_linked', 'events', { entity_id: eventId, linked: 0, reason: 'no-span' });
    return 0;
  }
  const rows = eventArtifactsStmt.all({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
  // Optional spatial constraint: only when the referenced place has usable coords + radius.
  let center = null, radiusKm = null;
  if (place_entity_id != null) {
    const { latitude, longitude, radius_km } = getEntity(place_entity_id)?.attrs ?? {};
    const plat = Number(latitude), plon = Number(longitude), prad = Number(radius_km);
    if (latitude != null && longitude != null && [plat, plon, prad].every(Number.isFinite) && prad > 0) {
      center = { lat: plat, lon: plon }; radiusKm = prad;
    } else {
      logEvent('event_linked', 'events', { entity_id: eventId, place_entity_id, reason: 'place-no-coords-time-only' });
    }
  }
  let linked = 0;
  for (const r of rows) {
    if (center) {
      if (r.latitude == null || r.longitude == null) continue;
      if (haversineKm(center.lat, center.lon, r.latitude, r.longitude) > radiusKm) continue;
    }
    if (insertLinkStmt.run(r.id, eventId, 'part_of', 1.0).changes > 0) linked++;
  }
  logEvent('event_linked', 'events', { entity_id: eventId, scanned: rows.length, linked, place_constrained: !!center });
  return linked;
});

/**
 * Stage a relation whose related name doesn't resolve yet: recorded on the owner's contact
 * artifact in unresolved_aliases (alias_type='relation', role=raw label). When the related
 * person is later imported, resolveRelationHints forms the edge. Idempotent via the table's
 * UNIQUE(artifact_id, alias, alias_type, role).
 */
export function stageRelationHint(artifactId, relatedName, rawLabel) {
  insertUnresolvedStmt.run(artifactId, normalizeName(relatedName), 'relation', rawLabel, 1.0);
  // Also stage a given+family reduction of a 3-token related name (#93), so a card that names
  // someone by their full middle-name form ("Amy Margaret Fenwick") still matches an entity
  // aliased only as given+family ("amy fenwick"). Gated to exactly 3 tokens for the same reason
  // nameVariants is: a 4+ token name can't be reduced to first+last without minting a wrong match.
  // Idempotent via the table's UNIQUE key.
  const toks = String(relatedName ?? '').trim().split(/\s+/);
  if (toks.length === 3) {
    const reduced = normalizeName(`${toks[0]} ${toks[toks.length - 1]}`);
    if (reduced && reduced !== normalizeName(relatedName)) {
      insertUnresolvedStmt.run(artifactId, reduced, 'relation', rawLabel, 1.0);
    }
  }
}

/**
 * Form edges for staged relations that now resolve to `entityId` — i.e. an earlier import
 * named this person as someone's relation before their own contact existed. Matches the
 * entity's name aliases against staged hints, derives the "from" side from the hint artifact's
 * self-link, and inserts the (canonicalized) edge. Append-only and idempotent (staged rows are
 * left in place; the OR IGNORE edge insert absorbs re-runs). Returns the count of edges formed.
 */
export function resolveRelationHints(entityId) {
  let formed = 0;
  for (const { alias } of selectNameAliasesStmt.all(entityId)) {
    for (const hint of selectRelationHintsStmt.all(alias)) {
      const from = selectSelfEntityStmt.get(hint.artifact_id);
      if (!from || from.entity_id === entityId) continue; // no self-loop
      const relation_type = canonicalRelationType(hint.role);
      if (upsertEntityRelation({ from_entity_id: from.entity_id, to_entity_id: entityId, relation_type, raw_label: hint.role, confidence: 1.0, source: 'vcard' }, 'relation_resolved')) {
        formed++;
      }
    }
  }
  return formed;
}

export function getRelations(entityId) {
  return getRelationsStmt.all(entityId);
}

export function getRelationsTo(entityId) {
  return getRelationsToStmt.all(entityId);
}

export function getEntity(id) {
  const e = getEntityStmt.get(id);
  if (e && e.attrs_json) e.attrs = safeJson(e.attrs_json);
  return e;
}

// --- Entity merge & duplicate detection (#75) ---
// Identity resolution is the hard unsolved-in-general problem (doc 03 §7) — this is the
// "accept occasional manual merges" admin surface, not auto-resolution.
const getLiveEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ? AND merged_into IS NULL');
const tombstoneEntityStmt = db.prepare('UPDATE entities SET merged_into = ? WHERE id = ?');
// entity_aliases has no unique key on entity_id, and (alias, alias_type) is globally unique
// across the WHOLE table (not per-entity) — so re-pointing entity_id can never collide with
// an existing row; a plain UPDATE (no OR IGNORE) is correct and complete.
const repointAliasesStmt = db.prepare('UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?');
const countAliasesStmt = db.prepare('SELECT COUNT(*) AS n FROM entity_aliases WHERE entity_id = ?');
const countLinksStmt = db.prepare('SELECT COUNT(*) AS n FROM entity_links WHERE entity_id = ?');
// entity_links' PK is (artifact_id, entity_id, role) — a bare COUNT(*) (countLinksStmt above,
// kept as-is for mergeEntities) counts one row per role, so an artifact linked under two roles
// counts twice. listProbableDuplicates' per-side "linked artifacts" figure needs an honest
// distinct-artifact count instead (#404).
const countDistinctLinkedArtifactsStmt = db.prepare('SELECT COUNT(DISTINCT artifact_id) AS n FROM entity_links WHERE entity_id = ?');
// entity_links' PK is (artifact_id, entity_id, role) — repointing CAN collide when the
// survivor already has a link for the same artifact+role (e.g. both entities were separately
// hinted as "mentioned" on the same artifact before being recognized as one person). Delete
// the absorbed side's row FIRST when that's the case — it's an exact duplicate of a row the
// survivor already has, so nothing is lost — THEN repoint the remainder unconditionally.
// (An earlier version used UPDATE OR IGNORE alone, which left the duplicate permanently
// orphaned pointing at the tombstoned id — visible forever via getLinksStmt/get_artifact.)
const deleteDuplicateLinksStmt = db.prepare(`
  DELETE FROM entity_links
  WHERE entity_id = @absorb
    AND EXISTS (
      SELECT 1 FROM entity_links k
      WHERE k.entity_id = @keep AND k.artifact_id = entity_links.artifact_id AND k.role = entity_links.role
    )
`);
const repointLinksStmt = db.prepare('UPDATE entity_links SET entity_id = ? WHERE entity_id = ?');
const countRelationsStmt = db.prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE from_entity_id = ? OR to_entity_id = ?');
// A direct keep<->absorb relation edge is meaningless once they're recognized as one person —
// drop it before repointing so the repoint below can never produce a from=to self-loop. This
// one is genuinely DELETED, not moved (see the moved-count comment in mergeEntities).
const deleteSelfRelationsStmt = db.prepare(`
  DELETE FROM entity_relations
  WHERE (from_entity_id = @keep AND to_entity_id = @absorb) OR (from_entity_id = @absorb AND to_entity_id = @keep)
`);
// entity_relations is UNIQUE(from_entity_id, to_entity_id, relation_type) on both edge columns —
// dedupe-then-repoint each side separately, same reasoning and same fix as entity_links above.
const deleteDuplicateRelationsFromStmt = db.prepare(`
  DELETE FROM entity_relations
  WHERE from_entity_id = @absorb
    AND EXISTS (
      SELECT 1 FROM entity_relations k
      WHERE k.from_entity_id = @keep AND k.to_entity_id = entity_relations.to_entity_id AND k.relation_type = entity_relations.relation_type
    )
`);
const repointRelationsFromStmt = db.prepare('UPDATE entity_relations SET from_entity_id = ? WHERE from_entity_id = ?');
const deleteDuplicateRelationsToStmt = db.prepare(`
  DELETE FROM entity_relations
  WHERE to_entity_id = @absorb
    AND EXISTS (
      SELECT 1 FROM entity_relations k
      WHERE k.to_entity_id = @keep AND k.from_entity_id = entity_relations.from_entity_id AND k.relation_type = entity_relations.relation_type
    )
`);
const repointRelationsToStmt = db.prepare('UPDATE entity_relations SET to_entity_id = ? WHERE to_entity_id = ?');

/**
 * Merge two entities: tombstone `absorbId` (merged_into = keepId, row never deleted —
 * design-philosophy.md §1) and re-point its aliases/links/relations to `keepId`. All-or-nothing
 * in one transaction. Throws (never silently no-ops) when either id is missing/already merged,
 * or when keepId === absorbId — callers map these to 404/422. Returns
 * { keep_id, absorb_id, moved: { aliases, links, relations } }. Every one of the absorbed
 * entity's original alias/link/relation rows ends up represented on the survivor — either
 * physically repointed, or deleted because it exactly duplicated a row the survivor already
 * had (never left dangling on the tombstoned id) — so `moved` is an exact count, counted right
 * after the one row category that's genuinely deleted rather than moved (a direct keep<->absorb
 * relation edge) is removed.
 */
export const mergeEntities = db.transaction((keepId, absorbId) => {
  if (keepId === absorbId) {
    const err = new Error('mergeEntities: keep_id and absorb_id must differ');
    err.code = 'SELF_MERGE';
    throw err;
  }
  const keep = getLiveEntityStmt.get(keepId);
  const absorb = getLiveEntityStmt.get(absorbId);
  if (!keep || !absorb) {
    const err = new Error('mergeEntities: keep_id or absorb_id not found (or already merged)');
    err.code = 'NOT_FOUND';
    throw err;
  }
  deleteSelfRelationsStmt.run({ keep: keepId, absorb: absorbId });
  const moved = {
    aliases: countAliasesStmt.get(absorbId).n,
    links: countLinksStmt.get(absorbId).n,
    relations: countRelationsStmt.get(absorbId, absorbId).n,
  };
  repointAliasesStmt.run(keepId, absorbId);
  deleteDuplicateLinksStmt.run({ keep: keepId, absorb: absorbId });
  repointLinksStmt.run(keepId, absorbId);
  deleteDuplicateRelationsFromStmt.run({ keep: keepId, absorb: absorbId });
  repointRelationsFromStmt.run(keepId, absorbId);
  deleteDuplicateRelationsToStmt.run({ keep: keepId, absorb: absorbId });
  repointRelationsToStmt.run(keepId, absorbId);
  tombstoneEntityStmt.run(keepId, absorbId);
  logEvent('entity_merged', 'entities', {
    keep_id: keepId, absorb_id: absorbId, moved,
    absorbed_attrs: absorb.attrs_json ? safeJson(absorb.attrs_json) : null,
  });
  return { keep_id: keepId, absorb_id: absorbId, moved };
});

// A targeted ON CONFLICT(...) DO NOTHING, not "INSERT OR IGNORE": SQLite's IGNORE resolution
// suppresses CHECK-constraint failures too, not just UNIQUE — so "OR IGNORE" would silently accept
// a non-canonical (a>=b) write as a false "success" instead of throwing. The conflict target names
// only the UNIQUE key, so the CHECK(entity_a_id < entity_b_id) stays a loud, real guard against a
// future bug in this function (the canonicalization below should make it unreachable in practice).
const insertDismissalStmt = db.prepare(
  'INSERT INTO duplicate_dismissals (entity_a_id, entity_b_id, score_at_dismissal, reason_at_dismissal) VALUES (?, ?, ?, ?) ON CONFLICT(entity_a_id, entity_b_id) DO NOTHING'
);
const listDismissalsStmt = db.prepare('SELECT * FROM duplicate_dismissals');
const deleteAllDismissalsStmt = db.prepare('DELETE FROM duplicate_dismissals');
const countDismissalsStmt = db.prepare('SELECT COUNT(*) AS n FROM duplicate_dismissals');

// Record a human "not a duplicate" decision on a candidate pair (#302). Canonicalizes to the
// (min,max) key the CHECK constraint enforces. mergeEntities stays unaware of this table — a
// dismissed pair remains manually mergeable, exactly like addAlias clearing an alias tombstone.
export const dismissDuplicatePair = db.transaction((idA, idB, { score = null, reason = null } = {}) => {
  // The equality guard runs on the CANONICALIZED ids, not the raw arguments: Math.min/Math.max
  // coerce to number, so a raw idA !== idB by strict === (e.g. mismatched types) can still collapse
  // to the same numeric value here — checking pre-canonicalization would let that slip past
  // SAME_ENTITY and hit the CHECK constraint instead.
  const a = Math.min(idA, idB), b = Math.max(idA, idB);
  if (a === b) { const err = new Error('dismissDuplicatePair: a_id and b_id must differ'); err.code = 'SAME_ENTITY'; throw err; }
  if (!getLiveEntityStmt.get(a) || !getLiveEntityStmt.get(b)) { const err = new Error('dismissDuplicatePair: a_id or b_id not found (or already merged)'); err.code = 'NOT_FOUND'; throw err; }
  const created = insertDismissalStmt.run(a, b, score, reason).changes > 0;
  if (created) logEvent('duplicate_pair_dismissed', 'contacts-ui', { entity_a_id: a, entity_b_id: b, score, reason });
  return { dismissed: true, created };
});

// Undo every dismissal at once (the only undo this supports — see #302 Out of Scope). Captures
// the full doomed rows into the log event before deleting, the same "reconstructable via
// ingest_log" trick mergeEntities' absorbed_attrs uses — duplicate_dismissals holds curation
// state rather than a stored memory/artifact, so a bulk DELETE here is not the append-only
// violation it would be on `artifacts`.
export const clearDuplicateDismissals = db.transaction(() => {
  const rows = listDismissalsStmt.all();
  if (!rows.length) return { cleared: 0 };
  deleteAllDismissalsStmt.run();
  logEvent('duplicate_dismissals_cleared', 'contacts-ui', {
    cleared: rows.length,
    pairs: rows.map((r) => ({ a: r.entity_a_id, b: r.entity_b_id, score: r.score_at_dismissal, reason: r.reason_at_dismissal, dismissed_at: r.dismissed_at })),
  });
  return { cleared: rows.length };
});

// Deliberately a bare COUNT(*) of the table, not "pairs currently suppressed in a listProbableDuplicates
// call" — those diverge once a dismissed pair stops generating (a side gets merged, attrs get edited)
// but the row stays (inert, not orphaned — see the schema comment above). The UI's "Clear N dismissals"
// button describes what the DELETE will remove, so it must be the stored total; don't "fix" this into
// the other number.
export function countDuplicateDismissals() {
  return countDismissalsStmt.get().n;
}

// Cheap token-overlap-free string similarity for typo/spelling near-duplicates ("Jon Smith" vs
// "John Smith") — NOT nickname resolution ("Bob" vs "Robert" needs a name dictionary, out of
// scope; see #75 Out of Scope). 1 - (Levenshtein distance / longer string's length).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function nameSimilarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen ? 1 - levenshtein(na, nb) / maxLen : 0;
}
const NAME_SIMILARITY_THRESHOLD = 0.6;
// Guard against an unbounded event-loop stall: the O(n²) Levenshtein pass below is only
// "acceptable at contact-book scale" (see listProbableDuplicates' doc comment) if that
// assumption holds. Past this many live person entities, skip that pass (phone/email
// matching — both O(n) — still runs) rather than silently let it grow quadratically forever.
const NAME_SIMILARITY_MAX_ENTITIES = 5000;

const listLivePersonEntitiesStmt = db.prepare(
  `SELECT id, canonical_name, attrs_json FROM entities WHERE kind = 'person' AND merged_into IS NULL`
);
// The contact's own artifact (role='self') — used as the embedding-distance tie-breaker signal.
const getSelfArtifactVecStmt = db.prepare(`
  SELECT v.embedding FROM entity_links el JOIN vec_artifacts v ON v.artifact_id = el.artifact_id
  WHERE el.entity_id = ? AND el.role = 'self' LIMIT 1
`);
// sqlite-vec (loaded above) ships vec_distance_cosine() as a callable SQL scalar function —
// reuse it instead of hand-parsing the raw BLOB into a Float32Array. It returns cosine
// DISTANCE (1 - similarity); a raw Buffer from a SELECT binds directly, no conversion needed.
const cosineDistanceStmt = db.prepare('SELECT vec_distance_cosine(?, ?) AS d');

/**
 * Rank candidate duplicate PERSON entities never merged into each other, by cheap signals:
 * a shared normalized phone/email in their contact attrs (strong — contacts.js only
 * auto-merges on shared email/exact name at import, NEVER on phone, so two records sharing a
 * phone number is a real, common residue) and name similarity (typo-level; NOT nicknames).
 * Embedding distance between each pair's own contact artifact enriches the reason as a
 * tie-breaker rather than a standalone O(n²) sweep over the whole corpus. Never merges; a human
 * (via merge_entities) decides — merges, or dismisses ("not a duplicate", #302). A dismissed pair
 * is suppressed pre-slice (before the per-pair cosine work AND before .slice(limit)) unless
 * includeDismissed is set, so dismissing the #1-scored pair correctly promotes the next one
 * instead of just shrinking the returned window. O(n²) over live person entities, acceptable at
 * contact-book scale (hundreds to low thousands) for this on-demand admin call, not the search
 * hot path. Returns pairs sorted by score desc, capped at `limit`; each side additionally carries
 * email_count/phone_count/link_count (#404) so a merge decision doesn't require opening both
 * contacts — link_count is distinct artifacts, not a raw entity_links row count.
 */
export function listProbableDuplicates(limit = 20, { includeDismissed = false } = {}) {
  const entities = listLivePersonEntitiesStmt.all();
  const nameById = new Map(entities.map((e) => [e.id, e.canonical_name]));
  // Populated in the same pass that already parses attrs_json for phone/email indexing below —
  // otherwise these values are read once here and discarded, and the pair-building loop has no
  // second chance to get at them cheaply (#404).
  const attrsById = new Map();
  const byPhone = new Map();
  const byEmail = new Map();
  for (const e of entities) {
    const attrs = e.attrs_json ? safeJson(e.attrs_json) ?? {} : {};
    attrsById.set(e.id, attrs);
    for (const p of attrs.phones ?? []) {
      const norm = normalizePhone(p);
      if (norm.length < 7) continue;
      if (!byPhone.has(norm)) byPhone.set(norm, []);
      byPhone.get(norm).push(e.id);
    }
    for (const em of attrs.emails ?? []) {
      const norm = normalizeName(em);
      if (!norm) continue;
      if (!byEmail.has(norm)) byEmail.set(norm, []);
      byEmail.get(norm).push(e.id);
    }
  }

  const pairs = new Map(); // "minId:maxId" -> { a, b, score, reasons: [] }
  const addPair = (idA, idB, score, reason) => {
    if (idA === idB) return;
    const a = Math.min(idA, idB), b = Math.max(idA, idB);
    const key = `${a}:${b}`;
    const existing = pairs.get(key) ?? { a, b, score: 0, reasons: [] };
    existing.score = Math.max(existing.score, score);
    existing.reasons.push(reason);
    pairs.set(key, existing);
  };
  for (const [phone, ids] of byPhone) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addPair(ids[i], ids[j], 0.9, `shared phone ${phone}`);
  }
  for (const [email, ids] of byEmail) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addPair(ids[i], ids[j], 0.95, `shared email ${email}`);
  }
  if (entities.length > NAME_SIMILARITY_MAX_ENTITIES) {
    log.warn('entities.similarity.skipped', 'name-similarity pass skipped — too many live person entities; phone/email matching still ran',
      { entities: entities.length, max: NAME_SIMILARITY_MAX_ENTITIES });
  } else {
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const sim = nameSimilarity(entities[i].canonical_name, entities[j].canonical_name);
        if (sim >= NAME_SIMILARITY_THRESHOLD) {
          addPair(entities[i].id, entities[j].id, sim, `similar name ("${entities[i].canonical_name}" vs "${entities[j].canonical_name}")`);
        }
      }
    }
  }

  // Memoize each entity's own contact-artifact vector once — an entity can appear in several
  // candidate pairs (e.g. a shared-phone match AND a similar-name match), and without this a
  // popular id would re-trigger the same entity_links/vec_artifacts join for every pair it's in.
  const vecByEntity = new Map();
  const vecFor = (id) => {
    if (!vecByEntity.has(id)) vecByEntity.set(id, getSelfArtifactVecStmt.get(id)?.embedding ?? null);
    return vecByEntity.get(id);
  };
  // Same memoization reasoning as vecFor above, for the per-side linked-artifact count (#404).
  const linkCountByEntity = new Map();
  const linkCountFor = (id) => {
    if (!linkCountByEntity.has(id)) linkCountByEntity.set(id, countDistinctLinkedArtifactsStmt.get(id).n);
    return linkCountByEntity.get(id);
  };

  // Loaded per call, never at module scope — a cached Set would mean a dismissal doesn't take
  // effect until server restart. Suppressed here, before the cosine work AND before .slice(limit):
  // that ordering is the actual fix (see the doc comment above and the pre-slice regression test).
  const dismissed = includeDismissed ? new Set() : new Set(listDismissalsStmt.all().map((r) => `${r.entity_a_id}:${r.entity_b_id}`));

  return [...pairs.values()]
    .filter((p) => !dismissed.has(`${p.a}:${p.b}`))
    .map((p) => {
      const vecA = vecFor(p.a);
      const vecB = vecFor(p.b);
      let reason = p.reasons.join('; ');
      if (vecA && vecB) reason += `; contact text ${Math.round((1 - cosineDistanceStmt.get(vecA, vecB).d) * 100)}% similar`;
      // New keys only (#404) — list_probable_duplicates' MCP text formatting reads a.id/a.name/
      // b.id/b.name/score/reason and must keep working unchanged.
      const attrsA = attrsById.get(p.a) ?? {};
      const attrsB = attrsById.get(p.b) ?? {};
      return {
        a: { id: p.a, name: nameById.get(p.a), email_count: Array.isArray(attrsA.emails) ? attrsA.emails.length : 0, phone_count: Array.isArray(attrsA.phones) ? attrsA.phones.length : 0, link_count: linkCountFor(p.a) },
        b: { id: p.b, name: nameById.get(p.b), email_count: Array.isArray(attrsB.emails) ? attrsB.emails.length : 0, phone_count: Array.isArray(attrsB.phones) ? attrsB.phones.length : 0, link_count: linkCountFor(p.b) },
        score: Math.round(p.score * 100) / 100,
        reason,
      };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

// The reference-face input for photo-exif's face-worker `suggest-labels` command (#84): live
// person entities whose own contact artifact has a preserved photo (raw_path, from #74's vCard
// PHOTO persistence). Company entities and photo-less contacts are excluded at the query level.
// One row per entity, never per artifact: an entity can end up with more than one role='self'
// contact artifact (re-importing the same person from a second vCard source under a different
// UID resolves to the same entity but creates a NEW self-linked artifact, per contacts.js's
// resolveExistingEntity — this is the ordinary multi-source-consolidation case, not an edge
// case) — the correlated subquery picks the most-recently-created photo deterministically,
// mirroring the LIMIT-1-per-entity discipline getSelfArtifactVecStmt already applies to this
// exact join shape. `merged_into IS NULL` is provably redundant here (mergeEntities re-points
// every entity_links row off an absorbed entity unconditionally, so no such row can ever join
// back to a tombstoned e.id) — kept anyway as defense-in-depth, matching this file's dominant
// style of explicit liveness checks (getLiveEntityStmt, listLivePersonEntitiesStmt).
const listContactPhotosStmt = db.prepare(`
  SELECT entity_id, name, photo_file, raw_path FROM (
    SELECT e.id AS entity_id, e.canonical_name AS name,
      -- Uploaded UI override (#97), a bare basename; json_valid guards a malformed attrs_json
      -- (unconstrained TEXT) so json_extract can't throw at query time (mirrors the #88 migration).
      CASE WHEN json_valid(e.attrs_json) THEN json_extract(e.attrs_json, '$.photoFile') END AS photo_file,
      (SELECT a.raw_path FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
       WHERE el.entity_id = e.id AND el.role = 'self' AND a.raw_path IS NOT NULL
       ORDER BY a.id DESC LIMIT 1) AS raw_path
    FROM entities e
    WHERE e.kind = 'person' AND e.merged_into IS NULL
  )
  WHERE photo_file IS NOT NULL OR raw_path IS NOT NULL
  ORDER BY entity_id
  LIMIT ?
`);

/**
 * List photographed contacts for reference-face matching. Read-only; core never computes or
 * compares face descriptors itself — that stays connector-local (doc 04 §11 rejects
 * connector-supplied embeddings, and the inverse holds too: core doesn't do connector-side ML).
 * Returns BOTH photo candidates per contact — the uploaded UI override (`photo_file`, bare
 * basename) and the imported vCard photo (`raw_path`) — so the server can apply the same
 * uploaded-wins precedence as GET /api/v1/entities/:id/photo (#112). db.js stays fs-free: it does
 * not resolve/confine `photo_file` (no CONTACTS_RAW_DIR here) — the server's resolver does that.
 * `raw_path` is passed through path.resolve() before returning. contacts.js now stores an
 * already-absolute raw_path (resolved at import time, against that import's own cwd — the only
 * moment the correct base directory is unambiguous), so this is a no-op for new rows; it's a
 * backward-compat shim for any row imported before that fix, when CONTACTS_RAW_DIR's relative
 * default meant raw_path was stored relative to whatever cwd `import:contacts` happened to run
 * from. Resolving here against the SERVER's cwd is only correct for those old rows if the server
 * happens to share import's cwd — best-effort for pre-existing data, not a general guarantee.
 */
export function listContactPhotos(limit = 100) {
  return listContactPhotosStmt.all(limit).map((r) => ({
    entity_id: r.entity_id, name: r.name,
    photo_file: r.photo_file ?? null,
    raw_path: r.raw_path ? path.resolve(r.raw_path) : null, // only resolve a present imported path
  }));
}

// --- Contacts curation surface (#96) ---
// The core-owned admin API the contacts web UI drives: correct a contact's aliases/attrs, edit
// relationships, set a photo. Same posture as mergeEntities above — the entity graph is mutable
// curation state (raw `contact` artifacts stay append-only; nothing here touches them), and every
// mutation logs to ingest_log with before/after so the derived record's history is reconstructable.
const listEntitiesStmt = db.prepare(`
  SELECT id, kind, canonical_name, attrs_json,
    EXISTS (
      SELECT 1 FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
      WHERE el.entity_id = entities.id AND el.role = 'self' AND a.raw_path IS NOT NULL
    ) AS has_photo
  FROM entities
  WHERE merged_into IS NULL
    AND (@kind IS NULL OR kind = @kind)
    AND (@like IS NULL
         OR LOWER(canonical_name) LIKE @like
         OR id IN (SELECT entity_id FROM entity_aliases WHERE alias LIKE @like))
  ORDER BY canonical_name COLLATE NOCASE
  LIMIT @limit OFFSET @offset
`);
const getAliasesStmt = db.prepare('SELECT alias, alias_type FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias');
const profileArtifactsStmt = db.prepare(`
  SELECT a.id, a.type, a.occurred_at, a.text_repr, el.role
  FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
  WHERE el.entity_id = ? ORDER BY a.id DESC LIMIT ?
`);
const updateEntityRowStmt = db.prepare('UPDATE entities SET canonical_name = COALESCE(?, canonical_name), attrs_json = ? WHERE id = ?');
const deleteAliasStmt = db.prepare('DELETE FROM entity_aliases WHERE entity_id = ? AND alias = ? AND alias_type = ?');
// Alias tombstones (#111): a removal records one here; additive inserts consult it, an explicit
// add clears it. All callers pass an ALREADY-normalized alias (same normalization as entity_aliases).
const insertTombstoneStmt = db.prepare('INSERT OR IGNORE INTO alias_tombstones (entity_id, alias, alias_type) VALUES (?, ?, ?)');
const deleteTombstoneStmt = db.prepare('DELETE FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = ?');
const hasTombstoneStmt = db.prepare('SELECT 1 FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = ?');
// The additive-insert guard: import/re-import (#94), profile edits, and hint resolution route alias
// creation through this so a tombstoned (deliberately-removed) alias is NOT resurrected. Returns the
// number of rows inserted (0 when suppressed by a tombstone or an OR IGNORE duplicate). The alias
// must already be normalized. Explicit user re-adds (addAlias) bypass this and clear the tombstone.
export function insertAliasUnlessTombstoned(entityId, alias, aliasType) {
  if (hasTombstoneStmt.get(entityId, alias, aliasType)) return 0;
  return insertAliasStmt.run(entityId, alias, aliasType).changes;
}
const getRelationByIdStmt = db.prepare('SELECT * FROM entity_relations WHERE id = ?');
const deleteRelationStmt = db.prepare('DELETE FROM entity_relations WHERE id = ?');
// The self-linked contact artifact's photo (most-recent, mirroring listContactPhotos' subquery).
const getSelfPhotoStmt = db.prepare(`
  SELECT a.raw_path FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
  WHERE el.entity_id = ? AND el.role = 'self' AND a.raw_path IS NOT NULL
  ORDER BY a.id DESC LIMIT 1
`);

const notFound = (id) => { const err = new Error(`entity ${id} not found (or merged)`); err.code = 'NOT_FOUND'; throw err; };
// email/phone aliases are globally UNIQUE(alias, alias_type). Adding one already owned by a
// DIFFERENT live entity would silently no-op (insertAliasStmt is OR IGNORE) and quietly fail to
// take effect — surface it as a conflict instead so the UI can offer a merge (mergeEntities).
// name/handle aliases are exempt from this friendly pre-check only: the UNIQUE(alias, alias_type)
// constraint still applies to them (an alias value is single-owner per type — two people named
// "chris" can't both hold ('chris','name')), so a same-type name/handle collision falls through to
// OR IGNORE and silently no-ops (first-writer-wins) rather than raising ALIAS_CONFLICT. They are not
// truly shareable; the exemption just means such a collision fails silently instead of loudly.
function assertNoAliasConflict(entityId, normAlias, aliasType) {
  if (aliasType !== 'email' && aliasType !== 'phone') return;
  const other = resolveAliasByTypeStmt.all(normAlias, aliasType).map((r) => r.entity_id).find((eid) => eid !== entityId);
  if (other != null) {
    const err = new Error(`${aliasType} "${normAlias}" already belongs to entity ${other}`);
    err.code = 'ALIAS_CONFLICT';
    err.conflict = { alias: normAlias, alias_type: aliasType, entity_id: other };
    throw err;
  }
}
const normalizeAlias = (alias, aliasType) => (aliasType === 'phone' ? normalizePhone(alias) : normalizeName(alias));
// Recent linked artifacts shown on a contact's profile (GET /:id) — a preview, not the full set.
const PROFILE_ARTIFACT_LIMIT = 10;

export function listEntities({ kind = null, query = null, limit = 50, offset = 0 } = {}) {
  const like = query && query.trim() ? `%${normalizeName(query)}%` : null;
  return listEntitiesStmt.all({ kind, like, limit, offset }).map((e) => {
    const attrs = e.attrs_json ? safeJson(e.attrs_json) : null;
    // hasPhoto: same "effective photo" precedence as the /photo route + #112 — an uploaded
    // override (attrs.photoFile) OR an imported vCard photo (self-linked artifact raw_path,
    // computed as has_photo in SQL). Lets the list badge which contacts have a picture without
    // fetching any image.
    return { id: e.id, kind: e.kind, canonical_name: e.canonical_name, attrs, hasPhoto: Boolean(e.has_photo) || Boolean(attrs?.photoFile) };
  });
}

export function getEntityProfile(id) {
  const entity = getLiveEntityStmt.get(id);
  if (!entity) return null;
  return {
    entity: { id: entity.id, kind: entity.kind, canonical_name: entity.canonical_name, attrs: entity.attrs_json ? safeJson(entity.attrs_json) : null },
    aliases: getAliasesStmt.all(id),
    relations: getRelations(id),
    relations_in: getRelationsTo(id),
    artifacts: profileArtifactsStmt.all(id, PROFILE_ARTIFACT_LIMIT),
  };
}

// Create a person/org from the UI (e.g. a related contact that doesn't exist yet). Seeds name/
// email/phone aliases exactly like the vCard import path so the new entity is resolvable. Any
// supplied email/phone that already belongs to another entity is a conflict (throws) — a new
// contact must not silently inherit someone else's alias. Returns `{ id, linksFormed }` — an object
// since #295, not a bare id, so the caller can see how much staged history the create linked.
export const createEntity = db.transaction(({ kind, canonical_name, attrs = {} }) => {
  const emails = [...new Set((attrs.emails ?? []).map((e) => normalizeName(e)).filter(Boolean))];
  const phones = [...new Set((attrs.phones ?? []).map((p) => normalizePhone(p)).filter(Boolean))];
  for (const e of emails) assertNoAliasConflict(-1, e, 'email');
  for (const p of phones) assertNoAliasConflict(-1, p, 'phone');
  const id = Number(insertEntityStmt.run(kind, canonical_name, JSON.stringify(attrs)).lastInsertRowid);
  for (const alias of nameVariants({ fn: canonical_name, nicknames: attrs.nicknames, derive: kind === 'person' })) insertAliasUnlessTombstoned(id, alias, 'name');
  reconcileHandleAliases(id, attrs, { explicit: false }); // #409: the one email/phone alias writer
  logEvent('entity_created', 'contacts-ui', { entity_id: id, kind, canonical_name });
  // Trusted manual place/event creation (#137/#138): link matching artifacts immediately so the
  // entity is recallable without a separate call. No-ops (never throws) on absent coords/span.
  if (kind === 'place') linkArtifactsToPlace(id);
  else if (kind === 'event') linkArtifactsToEvent(id);
  // #295: seeding aliases above makes any hint staged under them resolvable — link it now, or the
  // artifact stays invisible to about_entity/search until someone runs backfill:links by hand.
  const linksFormed = sweepStagedHints(id, { entity_id: id, kind, canonical_name });
  return { id, linksFormed };
});

// --- PROPOSED ENTITIES (#119): human-approval gate for entities auto-proposed from artifacts ---
// Stage a proposal (no entity is minted). Plain function (no transaction of its own): it runs
// INSIDE resolveEntityHints, which runs inside the caller's ingest transaction. Hoisted so
// resolveEntityHints (defined earlier) can call it. Idempotent via the table's UNIQUE key.
// Returns { id, created, status }: `created` is true when a NEW proposal row was written (false when
// the UNIQUE key already existed — INSERT OR IGNORE), and id/status come from the (new or existing)
// row so external callers (propose_entity, #232) can reference it. Silent by design — the internal
// hint/backfill/cluster paths log at a higher level (a per-run summary), and the external write logs
// its own proposed_entity_staged row in stageProposedEntity (server.js). Callers that count staged
// proposals (the #154 backfill) check `.created`; resolveEntityHints ignores the return.
export function proposeEntity({ suggested_kind, name, alias, alias_type, artifact_id = null, source = null, confidence = null, attrs_json = null }) {
  const attrs = attrs_json == null ? null : (typeof attrs_json === 'string' ? attrs_json : JSON.stringify(attrs_json));
  const created = insertProposalStmt.run(suggested_kind, name, alias, alias_type, artifact_id, source, confidence, attrs).changes > 0;
  // The UNIQUE(suggested_name, alias, alias_type) columns are the exact WHERE key, and every caller
  // passes non-null name/alias/alias_type, so a row always exists here — guard defensively anyway so a
  // future null-keyed caller (which INSERT OR IGNOREs but then SELECTs nothing) fails loud, not with a bare TypeError.
  const row = getProposalByKeyStmt.get(name, alias, alias_type);
  if (!row) { const err = new Error('proposeEntity: staged row not found by its unique key'); err.code = 'STAGE_LOOKUP_FAILED'; throw err; }
  return { id: row.id, created, status: row.status };
}

// List proposals by status (default the review queue: pending), newest first.
export function listProposedEntities(status = 'pending', limit = 20) {
  return listProposalsStmt.all(status, limit);
}

// Approve a pending proposal: create the entity, seed its aliases (name variants + the exact staged
// key so email/phone/handle hints resolve too), mark the proposal approved, then
// resolveStagedArtifactHints so the originating artifact(s) link. One transaction — a mid-way
// failure rolls back to no entity, proposal still pending.
export const approveProposedEntity = db.transaction((id) => {
  const p = getProposalStmt.get(id);
  if (!p) { const err = new Error(`proposal ${id} not found`); err.code = 'NOT_FOUND'; throw err; }
  if (p.status !== 'pending') { const err = new Error(`proposal ${id} already ${p.status}`); err.code = 'ALREADY_RESOLVED'; throw err; }
  // If an entity already carries this exact (alias, alias_type) — e.g. a contact was imported
  // after the proposal was staged — link to it instead of minting a duplicate (review note #119).
  const existing = resolveAliasByTypeStmt.all(p.alias, p.alias_type);
  // #413: identity is decided by NAME, never by the staged alias alone (mirrors promoteDirectoryName's
  // rule below) — a proposal's suggested_name can already resolve to a live entity while its staged
  // alias does not (e.g. #409's backfill hasn't indexed this field value yet), and approving it under
  // the old alias-only check minted a detectable-but-avoidable duplicate (repro: #2079/#2088/#2096).
  // Restricted to person/org proposals AND person/org matches — a place/event's identity is its staged
  // geo/span (#137/#138), not a name, so a person/org proposal must never attach to a same-named place.
  // Resolved once (not re-derived in the branch body) so the guard and the attach can't drift apart.
  // Skipped entirely when the alias-owner rung already wins (Copilot review, PR #480) — two avoidable
  // DB reads on the common "alias already owned" path.
  const nameOwners = !existing.length && ['person', 'org'].includes(p.suggested_kind)
    ? resolveHandle(p.suggested_name, 'name').filter((eid) => ['person', 'org'].includes(getLiveEntityStmt.get(eid)?.kind))
    : [];
  let entityId, created = false, aliasAttached = false;
  if (existing.length) {
    entityId = existing[0].entity_id;
  } else if (nameOwners.length === 1) {
    // Ambiguity (0 or >1 match) falls through to mint, same as promoteDirectoryName — a wrong merge
    // is far harder to undo than a duplicate (data-model.md).
    entityId = nameOwners[0];
    aliasAttached = insertAliasUnlessTombstoned(entityId, p.alias, p.alias_type) > 0;
  } else {
    // A place/event proposal carries its staged geo/span in attrs_json (#137); person/org have NULL.
    entityId = Number(insertEntityStmt.run(p.suggested_kind, p.suggested_name, p.attrs_json ?? '{}').lastInsertRowid);
    for (const v of nameVariants({ fn: p.suggested_name, derive: p.suggested_kind === 'person' })) insertAliasUnlessTombstoned(entityId, v, 'name');
    insertAliasUnlessTombstoned(entityId, p.alias, p.alias_type);
    // #409: p.attrs_json is normally a place/event's geo/span (#137) or absent for a person/org —
    // a no-op here — but if a proposal ever carries card-derived emails/phones, reconcile them
    // through the one writer rather than leaving a future caller to duplicate this loop.
    if (p.attrs_json) {
      const mintedAttrs = safeJson(p.attrs_json);
      if (mintedAttrs) reconcileHandleAliases(entityId, mintedAttrs, { explicit: false });
    }
    created = true;
  }
  setProposalResolvedStmt.run(entityId, id);
  // #413: heal any OTHER open proposal keyed on a name-type alias this entity ACTUALLY owns (mirrors
  // promoteDirectoryName's own heal loop below) — otherwise a name-keyed proposal for the same person
  // survives approval and keeps asking to create someone who now exists. Deliberately NOT keyed on
  // p.suggested_name's own variants: on the alias-owner rung above, entityId can be a DIFFERENT person
  // than suggested_name names (a shared handle); on the mint rung, a variant can lose the INSERT OR
  // IGNORE race to another live entity or be tombstoned (#111) and therefore never actually seed. Both
  // would otherwise resolve someone else's proposal to this entity — silently, and terminally (#300).
  let healed = 0;
  for (const { alias: v } of selectEntityAliasesStmt.all(entityId).filter((a) => a.alias_type === 'name')) {
    for (const op of selectOpenProposalsByAliasStmt.all(v, 'name')) {
      if (op.id !== id) { setProposalResolvedStmt.run(entityId, op.id); healed++; }
    }
  }
  const linked = resolveStagedArtifactHints(entityId);
  // A place mints with staged coords then links in-radius artifacts (#137); an event mints with its
  // staged span then links artifacts in that time window (+ place radius if referenced, #138) — the
  // location_of / part_of edges that make about_entity('<place|event>') return its artifacts.
  const placeLinked = p.suggested_kind === 'place' ? linkArtifactsToPlace(entityId) : 0;
  const eventLinked = p.suggested_kind === 'event' ? linkArtifactsToEvent(entityId) : 0;
  logEvent('proposed_entity_approved', 'proposed-entities', { proposal_id: id, entity_id: entityId, created, alias_attached: aliasAttached, healed_proposals: healed, suggested_kind: p.suggested_kind, suggested_name: p.suggested_name, linked, place_linked: placeLinked, event_linked: eventLinked });
  return { entity_id: entityId };
});

// Reject a proposal — status='rejected', retained (append-only) so re-ingest never re-raises it.
export const rejectProposedEntity = db.transaction((id) => {
  const p = getProposalStmt.get(id);
  if (!p) { const err = new Error(`proposal ${id} not found`); err.code = 'NOT_FOUND'; throw err; }
  // Can't reject an already-approved proposal — that would flip status approved→rejected while the
  // created entity lives on, mislabeling the audit trail. Re-rejecting a rejected one is a no-op.
  if (p.status === 'approved') { const err = new Error(`proposal ${id} already approved`); err.code = 'ALREADY_RESOLVED'; throw err; }
  setProposalStatusStmt.run('rejected', id);
  logEvent('proposed_entity_rejected', 'proposed-entities', { proposal_id: id, suggested_name: p.suggested_name });
  return { rejected: true };
});

// Reopen a rejected proposal back to 'pending' so it re-enters the review queue. Only 'rejected'
// is reopenable — 'approved' is refused (same reasoning as rejectProposedEntity above: the minted
// entity lives on, so flipping status would mislabel the audit trail) and 'pending' is a no-op state,
// not an error to hide, so it's also refused rather than silently succeeding.
export const reopenProposedEntity = db.transaction((id) => {
  const p = getProposalStmt.get(id);
  if (!p) { const err = new Error(`proposal ${id} not found`); err.code = 'NOT_FOUND'; throw err; }
  if (p.status !== 'rejected') { const err = new Error(`proposal ${id} is ${p.status}, not rejected`); err.code = 'ALREADY_RESOLVED'; throw err; }
  setProposalStatusStmt.run('pending', id);
  logEvent('proposed_entity_reopened', 'proposed-entities', { proposal_id: id, suggested_name: p.suggested_name, from: p.status });
  return { reopened: true };
});

// Overwrite a contact's editable attrs (+ optional rename), reconciling email/phone aliases to
// match the new attrs. Additive for names (a rename adds new name variants; old ones stay, as a
// person may still be referenced by them). photoFile/raw_path are server-owned — a PATCH can
// neither set nor wipe them (the upload route + import own them). Conflicts are checked before
// any write; a throw rolls the whole transaction back.
export const updateEntityAttrs = db.transaction((id, { canonical_name = null, attrs = null } = {}) => {
  const cur = getLiveEntityStmt.get(id) || notFound(id);
  const before = cur.attrs_json ? safeJson(cur.attrs_json) : {};
  const next = attrs ? { ...attrs } : { ...before };
  delete next.photoFile; delete next.raw_path;
  if (before.photoFile) next.photoFile = before.photoFile; // preserve server-owned photo
  const set = (arr, fn) => [...new Set((arr ?? []).map(fn).filter(Boolean))];
  const oldEmails = set(before.emails, normalizeName), newEmails = set(next.emails, normalizeName);
  const oldPhones = set(before.phones, normalizePhone), newPhones = set(next.phones, normalizePhone);
  for (const e of newEmails) if (!oldEmails.includes(e)) assertNoAliasConflict(id, e, 'email');
  for (const p of newPhones) if (!oldPhones.includes(p)) assertNoAliasConflict(id, p, 'phone');
  if (canonical_name && canonical_name !== cur.canonical_name)
    for (const alias of nameVariants({ fn: canonical_name, nicknames: next.nicknames, derive: cur.kind === 'person' })) insertAliasUnlessTombstoned(id, alias, 'name');
  // #409: set-based, not diff-based (data-model.md fields ⊆ aliases). Reconciles the WHOLE current
  // email/phone set against entity_aliases — not just the newly-added values above — so a value
  // that arrived HERE already unaliased (drift from a pre-#409 writer) is healed on this save too,
  // not only a genuinely new one. explicit:true because this is a user-typed profile save: it
  // clears a matching tombstone (#111), so typing a removed handle back into the field re-aliases
  // it (mirrors addAlias's "explicit user re-add overrides a prior removal"). A value already
  // conflict-checked above never throws again here; one still owned by a DIFFERENT entity (the "5
  // legitimately excluded" case) is skipped and reported, never stolen.
  reconcileHandleAliases(id, next, { explicit: true });
  for (const e of oldEmails) if (!newEmails.includes(e)) { deleteAliasStmt.run(id, e, 'email'); insertTombstoneStmt.run(id, e, 'email'); } // tombstone so a re-import can't re-add it (#111)
  for (const p of oldPhones) if (!newPhones.includes(p)) { deleteAliasStmt.run(id, p, 'phone'); insertTombstoneStmt.run(id, p, 'phone'); }
  updateEntityRowStmt.run(canonical_name, JSON.stringify(next), id);
  logEvent('entity_edited', 'contacts-ui', { entity_id: id, before, after: next, renamed_to: canonical_name && canonical_name !== cur.canonical_name ? canonical_name : null });
  // #295: once at the end, not per-alias — resolveStagedArtifactHints walks every alias the entity
  // owns, so one call covers the rename variants plus every added email/phone above.
  const linksFormed = sweepStagedHints(id, { entity_id: id });
  return { updated: true, linksFormed };
});

// Reduce a person entity's display name to first+last when it's a clean 3-token first-middle-last
// (#156), keeping the full name (and the reduced form) as resolvable name aliases. The import path
// now defaults new contacts to first+last; this fixes the ones imported before that. Idempotent:
// a 2-token canonical is left alone, so a re-run reduces 0. Only touches person entities that
// aren't merged away; a UI-shortened name is already 2-token and skipped.
const setCanonicalNameStmt = db.prepare('UPDATE entities SET canonical_name = ? WHERE id = ?');
export const reduceEntityDisplayName = db.transaction((id) => {
  const e = getEntityStmt.get(id);
  if (!e || e.kind !== 'person' || e.merged_into != null || !e.canonical_name) return { changed: false };
  const toks = e.canonical_name.trim().split(/\s+/);
  if (toks.length !== 3) return { changed: false }; // only first-middle-last reduces (2/4+ untouched)
  const reduced = `${toks[0]} ${toks[2]}`;
  if (reduced === e.canonical_name) return { changed: false };
  insertAliasUnlessTombstoned(id, normalizeName(e.canonical_name), 'name'); // keep the full name resolvable
  insertAliasUnlessTombstoned(id, normalizeName(reduced), 'name');           // and the reduced form
  // Only rename if the reduced form actually resolves to THIS entity — a prior UI tombstone (#111)
  // would have refused the alias above, and a cross-entity collision (first-writer-wins) leaves it
  // owned elsewhere; renaming the display to a name that doesn't resolve back here would break the
  // guarantee, so skip the reduction in that case (Copilot, PR #157). The full name stays aliased.
  if (!resolveAliasByTypeStmt.all(normalizeName(reduced), 'name').some((r) => r.entity_id === id)) {
    return { changed: false, skipped: 'reduced-name-unresolvable' };
  }
  setCanonicalNameStmt.run(reduced, id);
  logEvent('display_name_reduced', 'backfill-display-names', { entity_id: id, from: e.canonical_name, to: reduced });
  return { changed: true, from: e.canonical_name, to: reduced };
});

/**
 * Writer-side invariant enforcer (#409): computes the desired email/phone alias set from
 * attrs.emails/attrs.phones and inserts whatever entity_aliases is missing. Set-based, not
 * diff-based — data-model.md's fields ⊆ aliases rule — so a value that was ALREADY unaliased when
 * it arrived here (drift from a writer that predates this function) still gets indexed here, not
 * just what the caller happens to know changed. Never deletes an alias not implied by attrs (the
 * 24 field-less aliases on the live DB survive untouched — this function only ever inserts).
 *
 * explicit:true (a user-typed profile save) clears a matching tombstone (#111) and aliases
 * unconditionally, mirroring addAlias's "explicit user re-add overrides a prior removal". explicit:
 * false (an additive/automatic writer — import, fillEntityAttrsFromCard, createEntity,
 * approveProposedEntity, promoteDirectoryName) respects the tombstone, so a deliberately-removed
 * handle is never resurrected by a backfill, a re-import, or a directory promotion.
 *
 * A handle already owned by a DIFFERENT live entity is skipped and reported (skippedForeign),
 * never stolen — assertNoAliasConflict is the UI's own pre-check for a genuinely NEW value (still
 * the caller's job); this reconciler quietly steps around a pre-existing foreign owner instead of
 * throwing, since a caller reconciling an entity's WHOLE current attrs set will routinely pass
 * values it never touched.
 *
 * No db.transaction of its own — every caller already holds one open. Returns alias TYPES and
 * entity ids only, never handle VALUES (absolute rule 7): any caller may log the result directly,
 * including into the ops event store, not just the app DB's ingest_log.
 */
export function reconcileHandleAliases(entityId, attrs, { explicit = false } = {}) {
  let added = 0;
  const skippedTombstoned = [];
  const skippedForeign = [];
  for (const [key, aliasType, normalize] of HANDLE_ALIAS_FIELDS) {
    const values = Array.isArray(attrs?.[key]) ? attrs[key] : [];
    const seen = new Set();
    for (const raw of values) {
      const alias = typeof raw === 'string' ? normalize(raw) : '';
      if (!alias || seen.has(alias)) continue;
      seen.add(alias);
      const owner = resolveAliasByTypeStmt.all(alias, aliasType).map((r) => r.entity_id).find((eid) => eid !== entityId);
      if (owner != null) { skippedForeign.push({ alias_type: aliasType, entity_id: owner }); continue; }
      if (explicit) {
        if (deleteTombstoneStmt.run(entityId, alias, aliasType).changes > 0) logEvent('alias_tombstone_cleared', 'reconcile-handle-aliases', { entity_id: entityId, alias_type: aliasType });
        added += insertAliasStmt.run(entityId, alias, aliasType).changes;
      } else if (hasTombstoneStmt.get(entityId, alias, aliasType)) {
        skippedTombstoned.push(aliasType);
      } else {
        added += insertAliasUnlessTombstoned(entityId, alias, aliasType);
      }
    }
  }
  return { added, skippedTombstoned, skippedForeign };
}

// #409: every live entity's profile — the fields ⊆ aliases invariant's scan surface, shared by the
// startup detect pass below and scripts/backfill-handle-aliases.js. Not kind-restricted: an org can
// carry a main-line email/phone too, and the invariant doesn't distinguish by kind. Skips a
// malformed attrs_json (safeJson -> null) rather than throwing — same posture as every other
// attrs_json reader in this file.
const listLiveEntityAttrsStmt = db.prepare(`SELECT id, attrs_json FROM entities WHERE merged_into IS NULL AND attrs_json IS NOT NULL`);
export function listLiveEntityHandleAttrs() {
  return listLiveEntityAttrsStmt.all()
    .map((e) => ({ id: e.id, attrs: safeJson(e.attrs_json) }))
    .filter((e) => e.attrs != null);
}

export const addAlias = db.transaction((id, alias, alias_type) => {
  if (!getLiveEntityStmt.get(id)) notFound(id);
  const a = normalizeAlias(alias, alias_type);
  if (!a) { const err = new Error('empty alias'); err.code = 'BAD_ALIAS'; throw err; }
  assertNoAliasConflict(id, a, alias_type);
  // Explicit user re-add overrides a prior removal (#111): clear the tombstone, then insert directly.
  if (deleteTombstoneStmt.run(id, a, alias_type).changes > 0) logEvent('alias_tombstone_cleared', 'contacts-ui', { entity_id: id, alias: a, alias_type });
  const added = insertAliasStmt.run(id, a, alias_type).changes > 0;
  if (added) logEvent('alias_added', 'contacts-ui', { entity_id: id, alias: a, alias_type });
  // #295/#311: unconditional, NOT gated on `added`. A hint can be staged for an alias the entity
  // ALREADY owns — that is exactly the pre-#295 backlog (staged before the alias existed, never
  // swept), so gating on `added` would skip a re-add and strand those orphaned. Claiming another
  // entity's hints is impossible regardless: resolveStagedArtifactHints walks selectEntityAliasesStmt
  // (`WHERE entity_id = ?`), so when a name/handle collision loses to the first writer
  // (assertNoAliasConflict deliberately guards only email/phone) this entity owns no matching alias
  // and the sweep finds nothing. That filter is the protection, not the gate.
  const linksFormed = sweepStagedHints(id, { entity_id: id, alias: a, alias_type });
  return { added, linksFormed };
});

export const removeAlias = db.transaction((id, alias, alias_type) => {
  const a = normalizeAlias(alias, alias_type);
  const removed = deleteAliasStmt.run(id, a, alias_type).changes > 0;
  if (removed) {
    // Record the removal (#111) so an additive re-add (import/re-import/edit/hint) can't silently
    // resurrect it — but only if the entity row exists: #110's integrity pass leaves pre-existing
    // FK orphans in place, and a tombstone for a missing entity would throw
    // SQLITE_CONSTRAINT_FOREIGNKEY. For an orphaned alias, resurrection is moot (nothing resolves to
    // a missing entity), so skip the tombstone and just log the removal.
    if (getEntityStmt.get(id)) insertTombstoneStmt.run(id, a, alias_type);
    logEvent('alias_removed', 'contacts-ui', { entity_id: id, alias: a, alias_type });
  }
  return { removed };
});

export const removeRelation = db.transaction((relationId) => {
  const row = getRelationByIdStmt.get(relationId);
  if (!row) return { removed: false };
  deleteRelationStmt.run(relationId);
  logEvent('relation_removed', 'contacts-ui', { relation_id: relationId, from_entity_id: row.from_entity_id, to_entity_id: row.to_entity_id, relation_type: row.relation_type, raw_label: row.raw_label });
  return { removed: true };
});

// Record an uploaded photo's basename in attrs.photoFile (server-owned key — see updateEntityAttrs).
export const setEntityPhotoFile = db.transaction((id, basename) => {
  const cur = getLiveEntityStmt.get(id) || notFound(id);
  const before = cur.attrs_json ? safeJson(cur.attrs_json) : {};
  updateEntityRowStmt.run(null, JSON.stringify({ ...before, photoFile: basename }), id);
  logEvent('entity_edited', 'contacts-ui', { entity_id: id, photoFile: basename, prev_photoFile: before.photoFile ?? null });
  return { photoFile: basename };
});

// The effective photo path for a contact: the self-linked contact artifact's raw_path (imported
// vCard photo), absolute. The uploaded-photo override (attrs.photoFile) is resolved by the route,
// which confines it to CONTACTS_RAW_DIR. Returns null when the contact has no imported photo.
export function getContactPhotoRawPath(id) {
  const row = getSelfPhotoStmt.get(id);
  return row?.raw_path ? path.resolve(row.raw_path) : null;
}

// Handle-annotation for display (#147, #154). A connector bakes raw contact handles into text_repr
// ("Message from +12025550171: …"); recall reads far better with the resolved name folded in.
// Non-mutating: derives a display string; the stored text_repr (embedded, append-only) is never
// touched, the displayed handle stays raw (only the match key is normalized, #129).
//
// Precedence per handle token:
//   1. A curated entity LINKED to this artifact — exactly one match → its canonical name wins;
//      an ambiguous match (>1 linked entity) is left raw, never mis-attributed.
//   2. Otherwise the side contact_directory (#154) — display-only auto-label; creates no entity,
//      needs no approval. So a handle with no curated link (a number quoted in a message body, an
//      unlinked sender) is now labeled IF the directory knows it; still-unknown tokens stay verbatim.
// Curated resolution is skipped entirely when the artifact has no links (the query couldn't match)
// and a per-call cache resolves a repeated handle once — both avoid wasted queries on the hot
// hydration path (Copilot, PR #155). Curated resolution is scoped to the token's OWN alias_type
// (email→email, phone→phone) rather than routed through resolveEntityIds, which also tries the phone
// path on any 7+-digit string — an email like "h1471234567@example.com" would otherwise digit-strip
// to a phone alias and mis-attribute (Copilot, PR #148).
// Email domain is label-based (`label(.label)*.tld`) rather than `[A-Za-z0-9.-]+\.[A-Za-z]{2,}`:
// the old form let `.` sit in both the greedy class and the following literal, so an adversarial
// `x@` + `a.`×N backtracked super-linearly. Labels can't contain `.`, so there's no overlap to
// backtrack across (#150). Phone alternative unchanged.
const HANDLE_TOKEN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}|\+?\d[\d().-]{5,}\d/g;
const resolveHandleToken = (tok) => {
  if (tok.includes('@')) return resolveAliasByTypeStmt.all(normalizeName(tok), 'email').map((r) => r.entity_id);
  const digits = normalizePhone(tok);
  return digits.length >= 7 ? resolveAliasByTypeStmt.all(digits, 'phone').map((r) => r.entity_id) : [];
};
export function annotateHandles(text, links) {
  if (!text) return text;
  const nameById = new Map((links ?? []).map((l) => [l.entity_id, l.canonical_name]));
  const cache = new Map(); // per-call memo: a handle repeated in one text resolves once (Copilot, PR #155 / #150)
  return text.replace(HANDLE_TOKEN_RE, (tok) => {
    if (cache.has(tok)) return cache.get(tok);
    let name = null, ambiguous = false;
    if (nameById.size) { // curated resolution only when the artifact has links
      const matched = resolveHandleToken(tok).filter((id) => nameById.has(id));
      if (matched.length === 1) name = nameById.get(matched[0]);
      else if (matched.length > 1) ambiguous = true;
    }
    if (!name && !ambiguous) name = lookupDirectoryName(tok, tok.includes('@') ? 'email' : 'phone'); // #154 directory fallback
    const out = name ? `${name} (${tok})` : tok;
    cache.set(tok, out);
    return out;
  });
}

export function getArtifactById(id) {
  const a = getArtifactStmt.get(id);
  if (!a) return null;
  a.extra = a.extra_json ? safeJson(a.extra_json) : null;
  a.links = getLinksStmt.all(id);
  a.display_text = annotateHandles(a.text_repr, a.links);
  return a;
}

// Batch links loader for the read paths that DON'T go through getArtifactById (timeline,
// about_entity — #149). One query over all row ids (json_each), grouped in JS by artifact_id, so
// annotating N rows costs a single round-trip, not N. getLinksStmt is single-id and stays private.
const getLinksForIdsStmt = db.prepare(`
  SELECT el.artifact_id, el.entity_id, el.role, el.confidence, e.canonical_name, e.kind
  FROM entity_links el JOIN entities e ON e.id = el.entity_id
  WHERE el.artifact_id IN (SELECT value FROM json_each(?))
`);
// Attach display_text (#147) to a batch of raw artifact rows in place, returning the same array.
// Same read-time, non-mutating annotation as getArtifactById; a row with no links keeps text_repr.
export function annotateArtifactRows(rows) {
  if (!rows?.length) return rows;
  const linksById = new Map();
  for (const l of getLinksForIdsStmt.all(JSON.stringify(rows.map((r) => r.id)))) {
    if (!linksById.has(l.artifact_id)) linksById.set(l.artifact_id, []);
    linksById.get(l.artifact_id).push(l);
  }
  for (const r of rows) r.display_text = annotateHandles(r.text_repr, linksById.get(r.id) ?? []);
  return rows;
}

// --- Artifact enumeration (#449) ---
// Deterministic, non-ranked listing — the counterpart to hybridSearch's relevance ranking, for a
// caller that wants "all rows of type X" rather than a relevance question. id ASC is the only
// sweep-safe ordering: id is monotonic and append-only, so a new ingest between pages appends at
// the end and can never shift a row across a page boundary. occurred_at/ingested_at orderings are
// offered but NOT sweep-safe — a backfilled artifact (a 2019 photo imported today) inserts into
// the middle of the order (data-model.md). Every ordering appends id as a deterministic tie-break
// (docs/03-ob2-design.md §4.3), so two identical requests can't reorder on a shared occurred_at.
const ARTIFACT_LIST_FIELDS = `
  a.id, a.type, a.source, a.source_id, a.content_hash, a.occurred_at, a.ingested_at,
  a.latitude, a.longitude, a.place_label, a.raw_path, a.text_repr, a.extra_json
`;
// One fixed WHERE body, shared by every order/dir statement below and by the COUNT — same
// null-guarded-predicate idiom as search.js's candidateStmt (no string-built SQL). time_field
// selects which column since/until bind against; it's a bound VALUE compared in SQL, never an
// interpolated column identifier. date(...) truncation on both sides (mirrors search.js's
// candidateStmt t0/t1 predicates) is deliberate, not incidental: occurred_at/ingested_at are
// stored as full datetime strings, so a bare-date bound ("until=2020-06-01") would otherwise
// lexicographically sort BEFORE that same day's timestamped rows ("2020-06-01 00:00:00" >
// "2020-06-01" as strings) and silently exclude them — date() truncation is what makes the
// "inclusive bound" contract actually inclusive for a bare date.
const ARTIFACT_LIST_WHERE = `
  WHERE (@types_json IS NULL OR a.type IN (SELECT value FROM json_each(@types_json)))
    AND (@source IS NULL OR a.source = @source)
    AND (@since IS NULL OR
         (@time_field = 'occurred_at' AND a.occurred_at IS NOT NULL AND date(a.occurred_at) >= date(@since)) OR
         (@time_field = 'ingested_at' AND date(a.ingested_at) >= date(@since)))
    AND (@until IS NULL OR
         (@time_field = 'occurred_at' AND a.occurred_at IS NOT NULL AND date(a.occurred_at) <= date(@until)) OR
         (@time_field = 'ingested_at' AND date(a.ingested_at) <= date(@until)))
`;
const countArtifactsStmt = db.prepare(`SELECT COUNT(*) AS total FROM artifacts a ${ARTIFACT_LIST_WHERE}`);
// ORDER BY cannot be a bound parameter (coding-standards.md) — a map of prepared statements over
// the static (order, dir) combinations below, never a request value spliced into SQL.
const ARTIFACT_ORDER_COLUMNS = { id: 'a.id', occurred_at: 'a.occurred_at', ingested_at: 'a.ingested_at' };
const listArtifactsStmts = new Map();
for (const [order, col] of Object.entries(ARTIFACT_ORDER_COLUMNS)) {
  for (const dir of ['ASC', 'DESC']) {
    const tieBreak = col === 'a.id' ? '' : `, a.id ${dir}`;
    listArtifactsStmts.set(`${order}:${dir.toLowerCase()}`, db.prepare(`
      SELECT ${ARTIFACT_LIST_FIELDS}
      FROM artifacts a
      ${ARTIFACT_LIST_WHERE}
      ORDER BY ${col} ${dir}${tieBreak}
      LIMIT @limit OFFSET @offset
    `));
  }
}

// Copilot review (PR #451): timeField has no guard the way order/dir does, so a bad value would
// silently make every since/until branch false — an empty-looking result, not an error. The HTTP
// route can't reach this (ListArtifactsQuerySchema's enum already rejects it at 422), but
// listArtifacts is exported and other callers (scripts, tests, a future MCP tool) aren't
// schema-gated, so guard here too rather than relying on the one call site that happens to validate.
const ARTIFACT_TIME_FIELDS = new Set(['occurred_at', 'ingested_at']);

// Read-only, so nothing to log to ingest_log (design-philosophy §3 is for mutations). spanSync,
// not span: better-sqlite3 is synchronous (same reasoning as storeArtifactTxn above). `data`
// carries counts/parameter names only — never a source value, a date, or type names (rule 7).
export function listArtifacts({ types = null, source = null, since = null, until = null, timeField = 'occurred_at', order = 'id', dir = 'asc', limit = 50, offset = 0 } = {}) {
  const stmt = listArtifactsStmts.get(`${order}:${dir}`);
  if (!stmt) throw new Error(`listArtifacts: unsupported order/dir combination "${order}:${dir}"`);
  if (!ARTIFACT_TIME_FIELDS.has(timeField)) throw new Error(`listArtifacts: unsupported timeField "${timeField}"`);
  const bind = {
    types_json: types?.length ? JSON.stringify(types) : null,
    source: source ?? null,
    since: since ?? null,
    until: until ?? null,
    time_field: timeField,
    limit, offset,
  };
  return log.spanSync('db.artifacts.listed', () => {
    const total = countArtifactsStmt.get(bind).total;
    const rows = stmt.all(bind);
    for (const r of rows) r.extra = r.extra_json ? safeJson(r.extra_json) : null;
    return { total, results: annotateArtifactRows(rows) };
  }, { types: types?.length ?? 0, has_source: !!source, has_since: since != null, has_until: until != null, order, dir, limit, offset });
}

// Raw artifact row by its upsert key, or undefined. Used by the ingest orchestrator to decide
// whether text_repr changed (and thus whether to re-embed) before opening upsertArtifactTxn.
export const getArtifactBySource = (source, sourceId) => getArtifactBySourceStmt.get(source, sourceId);
// Read-only existence check for the connector /exists endpoint (#198): the subset of `sourceIds`
// already stored under `source`. Point lookups reuse the prepared selectIdBySourceStmt (indexed by
// UNIQUE(source, source_id)), so there's no dynamically-built IN() SQL; the batch is capped ≤100 by
// the route schema, and this is a pure read — no write, no ingest_log row.
export function existingSourceIds(source, sourceIds) {
  const present = [];
  const checked = new Set(); // dedup input: a duplicate source_id → one lookup, one output at most
  for (const sourceId of sourceIds) {
    if (checked.has(sourceId)) continue;
    checked.add(sourceId);
    if (selectIdBySourceStmt.get(source, sourceId)) present.push(sourceId);
  }
  return present;
}
// The entity a contact artifact self-links to (role='self') — the authoritative owner for the
// contacts re-import update path (#94), resilient to a post-import merge (links repoint to survivor).
export const getSelfEntityId = (artifactId) => selectSelfEntityStmt.get(artifactId)?.entity_id ?? null;

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Entity write statements exposed for the contacts connector (composes its own txn).
export { insertEntityStmt, insertAliasStmt, selectIdByHashStmt };

// --- Startup integrity: fields ⊆ aliases (#409) ---
// The boot-time counterpart to `npm run check:handle-aliases` — same detect-don't-repair
// discipline as the #110 FK/integrity pass near the top of this file (never touches a stored row
// here; a violation is logged, never coerced). Runs down here, after HANDLE_ALIAS_FIELDS/
// listLiveEntityHandleAttrs/reconcileHandleAliases exist, rather than inline with that earlier
// block. Guarded by entity count: an unbounded per-entity/per-value scan on every boot is the
// wrong trade for a very large DB (mirrors listProbableDuplicates' NAME_SIMILARITY_MAX_ENTITIES
// guard) — check:handle-aliases has no such cap, since a human runs it deliberately, off the boot
// path.
const HANDLE_ALIAS_CHECK_MAX_ENTITIES = 5000;
{
  const entities = listLiveEntityHandleAttrs();
  if (entities.length > HANDLE_ALIAS_CHECK_MAX_ENTITIES) {
    log.warn('db.handle_aliases.check_skipped', 'startup fields-aliased check skipped — too many live entities to scan at boot', { entities: entities.length, max: HANDLE_ALIAS_CHECK_MAX_ENTITIES });
  } else {
    let violatingEntities = 0, violatingValues = 0;
    for (const e of entities) {
      let hit = false;
      for (const [key, aliasType, normalize] of HANDLE_ALIAS_FIELDS) {
        const values = Array.isArray(e.attrs?.[key]) ? e.attrs[key] : [];
        const seen = new Set();
        for (const raw of values) {
          const alias = typeof raw === 'string' ? normalize(raw) : '';
          if (!alias || seen.has(alias)) continue;
          seen.add(alias);
          const owners = resolveAliasByTypeStmt.all(alias, aliasType).map((r) => r.entity_id);
          if (owners.length) continue; // aliased — to this entity, or legitimately to another
          if (hasTombstoneStmt.get(e.id, alias, aliasType)) continue; // deliberately not matched (#111)
          violatingValues++; hit = true;
        }
      }
      if (hit) violatingEntities++;
    }
    if (violatingValues > 0) {
      // ERROR, not WARN: a human must look — mirrors the #110 block's own severity choice.
      // Detect-only by design (never repaired here; npm run backfill:handle-aliases is the
      // separate, deliberate act), so boot continues regardless.
      log.error('db.handle_aliases.violated', 'attrs.emails/phones values with no entity_aliases row anywhere (not repaired)', null,
        { entities: violatingEntities, values: violatingValues });
      logSchemaStmt.run('integrity_check', 'db.js', JSON.stringify({ handle_alias_violations: violatingValues, entities: violatingEntities }));
    }
  }
}
// insertAliasUnlessTombstoned is exported at its definition (used by the contacts importer, #111).
