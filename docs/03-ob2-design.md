# Open Brain 2 — Design Document

**A local, unified memory system for your entire digital footprint**

Evolves the OB1 text-memory server (Node.js + SQLite + sqlite-vec) into a system that ingests emails, documents, contacts, photos, videos, social posts, and location/time data — and can recall across all of them the way human memory does: by meaning, by person, by place, and by time.

> **Reader/agent note (July 2026).** The project this doc describes was renamed **LifeContext**
> (formerly Open Brain Local); "Open Brain 2 / OB2" here names this design generation, not the
> product. Two sections have been **superseded by newer docs** — this doc remains the canonical
> reference for the core architecture (data model §2, retrieval §4, consolidation §5), but read
> the newer docs first for anything they cover:
>
> - **Ingestion (§3) →** [`04-connector-contract.md`](04-connector-contract.md). Connectors are now
>   *external processes* speaking a versioned HTTP + JSON ingest API, not in-core scripts; the
>   "senses"/transducers described here (VLM, Whisper, EXIF) ship connector-side in practice — core
>   holds no source-specific knowledge. See doc 04's naming note and §1.2a.
> - **Build phases (§6) →** [`05-roadmap.md`](05-roadmap.md). The milestone order changed:
>   connector-first (dev sessions, iMessage, photo-EXIF), consolidation pulled forward.

---

## 1. Core Philosophy

### 1.1 The senses are multimodal; the mind is not

The human brain doesn't store photons or air pressure. Eyes and ears **transduce** raw sensory input into a common neural representation, and memory operates on that. Open Brain 2 copies this architecture:

| Human | Open Brain 2 |
|---|---|
| Eyes | Vision-language model (captioning, OCR, subject detection) |
| Ears | Whisper (speech → transcript) |
| Sense of time/place | EXIF, email headers, GPS logs → structured columns |
| Recognizing people | Contact entities + (optional) face clustering |
| Associative recall | Vector embeddings over the text representation |
| "Where was I when...?" | SQL filters on time + location, fused with vector rank |

**Design rule: every artifact gets normalized into exactly three things:**

1. **`text_repr`** — a natural-language description of the artifact (embedded for semantic search)
2. **Structured metadata** — timestamp, lat/lon, type, source (filtered with plain SQL)
3. **Entity links** — edges to people, places, and events (traversed as a graph)

This is the "describe, then embed" pattern. It's the pragmatic current-tech answer: instead of chasing a single embedding space that natively understands images, audio, and text (possible, but immature and lossy for retrieval-by-meaning), you convert everything to text — the representation LLMs are best at — and keep the raw artifact on disk as ground truth.

### 1.2 Three memory layers (mirrors human memory)

| Layer | Human analog | Implementation |
|---|---|---|
| **Episodic** | "That dinner in New Orleans" | `artifacts` table — every email, photo, doc as an event in time/space |
| **Semantic** | "Sarah is my sister; she lives in Austin" | `entities` + `entity_links` — durable facts and relationships |
| **Associative** | Fuzzy recall by vibe/meaning | `vec_artifacts` + FTS5 — hybrid retrieval |

Retrieval fuses all three: *"photos of Sarah from the New Orleans trip"* = entity filter (Sarah) ∩ location filter (New Orleans bbox) ∩ time filter ∩ vector rank on "dinner, celebration, trip."

---

## 2. Data Model

### 2.1 Unified artifact schema

```sql
CREATE TABLE artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,        -- registered type — see doc 04 §6 for the current list
  source        TEXT NOT NULL,        -- gmail | icloud | filesystem | takeout | manual
  source_id     TEXT,                 -- provider's ID (dedup key)
  content_hash  TEXT,                 -- sha256 of raw bytes (dedup + integrity)
  occurred_at   DATETIME,             -- when it HAPPENED (photo taken, email sent)
  ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  latitude      REAL,                 -- nullable
  longitude     REAL,                 -- nullable
  place_label   TEXT,                 -- reverse-geocoded, US region as full state name: "Houston, Texas" (#186)
  raw_path      TEXT,                 -- pointer to original file on disk
  text_repr     TEXT NOT NULL,        -- normalized text — this gets embedded
  extra_json    TEXT,                 -- type-specific fields (EXIF, headers, etc.)
  UNIQUE(source, source_id)
);

CREATE INDEX idx_artifacts_time  ON artifacts(occurred_at);
CREATE INDEX idx_artifacts_type  ON artifacts(type, occurred_at);
CREATE INDEX idx_artifacts_hash  ON artifacts(content_hash);
```

Key decisions:

- **`occurred_at` ≠ `ingested_at`.** The photo from 2019 you import today must sort into 2019. This is what makes timeline queries work.
- **`raw_path`, not raw blobs.** SQLite holds pointers + text; originals stay on the filesystem (or NAS). DB stays small and fast; nothing is ever lossy.
- **`extra_json`** absorbs type-specific structure (email headers, EXIF camera model, video duration) without schema churn. Promote a field to a real column only when you need to index/filter on it.

### 2.2 Entity graph (the relationship layer)

```sql
CREATE TABLE entities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,       -- person | place | org | event | topic
                                      -- (a contact flagged isCompany -> 'org', else 'person'; #88)
  canonical_name TEXT NOT NULL,
  attrs_json     TEXT,                -- person: the contact superset below —
                                      -- emails[], phones[], addresses[], birthday,
                                      -- dates[], relatedNames[], categories[],
                                      -- nicknames[], urls[], im[], socialProfiles[],
                                      -- org/department/title/role, phonetic, isCompany
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Aliases solve identity resolution: "Mom", "sarah.j@example.com",
-- "+1-555-0142", and "Sarah Jones" are all the same entity.
CREATE TABLE entity_aliases (
  entity_id INTEGER REFERENCES entities(id),
  alias     TEXT NOT NULL,            -- normalized (lowercase, digits-only phones)
  alias_type TEXT,                    -- email | phone | name | handle
  UNIQUE(alias, alias_type)
);

CREATE TABLE entity_links (
  artifact_id INTEGER REFERENCES artifacts(id),
  entity_id   INTEGER REFERENCES entities(id),
  role        TEXT,                   -- sender | recipient | pictured |
                                      -- mentioned | author | self | location_of
  confidence  REAL DEFAULT 1.0,       -- 1.0 = deterministic (email header),
                                      -- <1.0 = inferred (NER, face match)
  PRIMARY KEY (artifact_id, entity_id, role)
);

-- Entity<->entity edges (issue #37; person->org #88). entity_links joins
-- artifacts->entities; this joins entities to each other. Directional (from =
-- contact owner / employee, to = related person / employer org), append-only,
-- idempotent via the UNIQUE key + OR IGNORE. Columns are kind-agnostic.
CREATE TABLE entity_relations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id INTEGER NOT NULL REFERENCES entities(id),
  to_entity_id   INTEGER NOT NULL REFERENCES entities(id),
  relation_type  TEXT NOT NULL,        -- canonical enum (spouse|partner|child|
                                       -- parent|mother|father|sibling|…) or 'custom'
  raw_label      TEXT,                 -- original source label (preserved for 'custom')
  confidence     REAL DEFAULT 1.0,     -- 1.0 for an explicit contact field
  source         TEXT,
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);
```

> **Schema drift note (current tables).** The blocks above are the original design sketch; the live schema in `src/db.js` has grown since — read the `CREATE TABLE`/`CREATE INDEX` block there, and the guarded `ALTER TABLE`/rebuild migrations immediately below it (with their inline comments), for the authoritative current shape. Added since: `entities.merged_into` (merge tombstones, #75); `NOT NULL` + enforced foreign keys on `entity_aliases`/`entity_links`/`unresolved_aliases` (#110); and the tables `alias_tombstones` (#111), `unresolved_aliases` (connector hint staging), `proposed_entities` (the human-approval queue, #119), and `contact_directory` (side handle→name lookup, #154).

**Person↔person relationships (issue #37).** A contact's `relatedNames[] {type, name}` (parsed above) become `entity_relations` edges. Because every source expresses a relationship as a related **name string + a type** (no foreign key), this is a name→entity resolution problem, so it reuses the same machinery as alias hints: for each related name, `resolveEntityIds(name)` — a hit inserts the edge now; a miss is **staged** on the owner's contact artifact in `unresolved_aliases` (`alias_type='relation'`, `role` = the raw label) and `resolveRelationHints` forms the edge when that person is later imported (so either import order converges). The raw label is canonicalized (`RELATION_TYPE_MAP`) to a fixed vocabulary — `spouse, partner, domesticPartner, child, parent, mother, father, sibling, brother, sister, friend, relative, assistant, manager, referredBy, worksAt, custom` — with the original preserved in `raw_label`. Edges are append-only and idempotent (`UNIQUE(from, to, relation_type)` + `OR IGNORE`); `ingest_log` records `relation_added` / `relation_resolved`. `about_entity` returns each entity's outgoing edges as `relations: [{ entity_id, name, relation_type, raw_label, confidence }]` and its incoming edges as `relations_in` (same shape, the `from` side) (`raw_label` carries the original label, most useful when `relation_type` is `custom`).

**Business contacts + employment (issue #88).** A contact flagged as a company (`X-ABSHOWAS:COMPANY` / vCard 4.0 `KIND:org` → `isCompany`) is created as a `kind='org'` entity rather than `kind='person'`, filling the existing schema slot instead of polluting the person graph (`isCompany` stays in `attrs_json` as the raw signal; `kind` is the derived classification — deterministic flags only, no fuzzy heuristics). A person's `ORG` name seeds a structured `worksAt` edge (person→org) through the same relation-staging machinery: the org **name** (`ORG` component `parts[0]`, not the joined `org, department` display string) becomes a synthetic `worksAt` hint that forms an edge to the org entity when a matching org contact exists, in **either import order**; a name that matches no imported org contact is staged (never fabricated into an org entity — a free-text org string has no dedup key to assert identity by, the same exact-name-match limitation as person relations). A startup data migration promotes any pre-existing `person`+`isCompany` entity to `org` (idempotent; logged `schema_migration` only when rows change; no DDL — `kind` and `entity_relations` already exist). Person-only surfaces (`listProbableDuplicates` dedup, `listContactPhotos` reference faces) already filter `kind='person'`, so orgs are correctly excluded.

**Place entities (issue #137).** A recurring, meaningful location (home, work, a resort) becomes a `kind='place'` entity so every artifact type can pivot around one location node — `about_entity('Deer Valley')`, spend-by-place, co-presence — the same leap `org` (#88) made over a free-text company string. **No schema change:** `kind` already reserves `place`; a place's geometry lives in `attrs_json` `{latitude, longitude, radius_km}`, and links reuse `entity_links` with role `location_of` (append-only, `OR IGNORE`-idempotent). Two creation paths, both core-owned (connectors never assert entities, doc 04 §1.2):
> - **Trusted manual create** (`POST /api/v1/entities` `{kind:'place', canonical_name, attrs:{latitude, longitude, radius_km}}`, the #96 CRUD surface) mints the place and — because it's deliberate, trusted input (mirrors #125's ungated org mint) — immediately runs `linkArtifactsToPlace` so it's recallable without a second call.
> - **Cluster → propose → approve** (`npm run places:cluster` → the #130 proposed-entities queue) is the bottom-up path for existing photo GPS: it grids GPS-bearing artifacts, and a cell with ≥ N artifacts is reverse-geocoded to a candidate name and staged as one `proposed_entities` row (`suggested_kind='place'`), carrying the centroid + a seed radius in the new nullable `proposed_entities.attrs_json` column. The clusterer **mints nothing** — a one-off location must never auto-pollute the spine; a human approves via `POST /api/v1/entities/proposed/:id/approve`, which copies the staged geo into the minted entity and links its in-radius artifacts.
>
> `linkArtifactsToPlace(placeId)` links every artifact with non-null coords within `radius_km` (a lat/lon bounding box narrowed by an exact haversine pass — the #68 `near`-radius pattern), returns the count, logs `place_linked`, and no-ops (never throws) for a place with null/invalid coords. `place_label` is unchanged and independent — a place *entity* is a curated identity; `place_label` is a per-artifact derived string. **Out of scope for v1:** forward-geocoding contact street-address text (the bundled gazetteer is reverse-only), a location/visits connector, radius auto-tuning, and place↔place containment. The `event` kind (#138) builds on this — it reuses `proposed_entities.attrs_json` and the kind-generalized `approveProposedEntity`.

**Event entities (issue #138).** An occasion that spans many artifacts ("the Tahoe trip", "Sarah's wedding" — photos + receipts + messages) becomes a `kind='event'` entity — the episodic-memory north star ("tell me about Tahoe" returns one episode, not 200 scattered rows). Built directly on #137: **no schema change** (`kind` already reserves `event`; span/place ride `attrs_json` `{start, end, place_entity_id?}`), reusing the `proposed_entities.attrs_json` column and the kind-generalized `approveProposedEntity`. Links use `entity_links` role `part_of` (an artifact is *part_of* an event). Two creation paths, both core-owned:
> - **Trusted top-down** — a calendar entry *is* an event (name+time+place); mint directly (`POST /api/v1/entities` `{kind:'event', canonical_name, attrs:{start, end, place_entity_id?}}`, ungated per #125) and it links immediately. The **calendar connector** — the roadmap's long-deferred "events-producing connector" — is a *separate* dependency (a connector issue); this issue ships the representation + linker + manual/proposed paths so that connector can land on top.
> - **Bottom-up cluster → propose → approve** (`npm run events:cluster` → the #130 queue) groups GPS+time artifacts into contiguous-day runs **away from home** (a `kind='place'` entity named `home`, if one exists, marks the routine radius to exclude), reverse-geocodes a name, and stages one `proposed_entities` row (`suggested_kind='event'`) with the inferred `{start, end}` (padded to whole UTC days). Mints nothing; a human approves.
>
> `linkArtifactsToEvent(eventId)` links every artifact whose `occurred_at ∈ [start, end]` (dates normalized to ISO, compared via SQLite `datetime()` so a space-form `occurred_at` and an ISO span still compare); if `place_entity_id` references a place with usable coords, linking is **additionally** constrained to that place's radius (coordless artifacts excluded — they can't be confirmed there; a referenced place with no coords degrades to time-only, logged). Returns the count, logs `event_linked`, no-ops (never throws) on a null/invalid span. **Out of scope for v1:** the calendar connector itself; sessionization heuristic tuning; event↔event nesting (a trip containing dinners); digest/consolidation integration (doc 06); attendee (person) auto-linking from co-present artifacts.

**Contacts are the spine.** Your contacts import seeds the `entities` table with high-quality person records (name, emails, phones, birthday, relationship). Because recall quality is set by how clean these records are *before* import, [`08-preparing-contacts.md`](08-preparing-contacts.md) is the primer + source-side pre-clean checklist for getting them right. Every subsequent artifact links to them deterministically: email `From:` header matches an alias → hard link, confidence 1.0. A name mentioned in a document body → NER-inferred link, confidence 0.7. Confidence lets retrieval prefer certain links without discarding fuzzy ones.

**The cross-platform contact superset.** `parseVCards` (`src/contacts.js`) emits one connector-agnostic shape so that future Google People API / Android ContactsContract connectors map onto the *same* internal model — the three sources converge (esp. relationships = a related **name string** + a type, with no foreign key). The superset: structured + phonetic names, `nicknames[]`, `emails[]`, `phones[]`, `addresses[]` (+ the legacy scalar `address`), `urls[]`, `org`/`department`/`title`/`role`, `birthday`, `dates[] {type, value}` (labeled — anniversary, etc.), `relatedNames[] {type, name}`, `categories[]`, `im[] {service, handle}`, `socialProfiles[] {service, url}`, `note`, `uid`, `isCompany`. Apple 3.0 exports carry labeled properties under an `itemN.` group prefix with an `X-ABLabel` sibling (`item1.X-ABDATE` + `item1.X-ABLabel:_$!<Anniversary>!$_`); the parser strips the group prefix off the property name and pairs each value with its decoded label after the whole card is read, so a label may precede or follow its value. vCard 4.0 equivalents (`ANNIVERSARY`/`RELATED`/`NICKNAME`) are read by property name, so both versions land in the same shape. All of it rides in existing columns — `entities.attrs_json`, `artifacts.extra_json`, and the embedded `text_repr` — no new columns (a field is promoted to a real column only when filtered on). Relationships are captured as text here (folded into `text_repr` as `Spouse: Amy Fenwick` and stored in `relatedNames[]`); real entity↔entity graph edges are a separate layer built on this parsed data.

**Contact photo preservation (#74).** A vCard's embedded `PHOTO` (inline base64, a vCard 4.0 `data:` URI, or an external `http(s)` URI) is decoded and written to `CONTACTS_RAW_DIR` (env-overridable, default `raw/contacts`) as a content-addressed file (`<sha256>.<ext>`), and the contact artifact's `raw_path` points at it — an original worth keeping under this project's own data-preservation principle (never discard a raw input alongside its derived value), and the future seed a face-recognition worker (see #53) could use to auto-label photo clusters. External URIs are recorded (`extra_json.photo.photo_url`) but never fetched. A photo that fails to decode is logged and skipped without aborting the rest of the import.

### 2.3 Search indexes

```sql
-- Semantic (existing OB1 pattern, now keyed to artifacts)
CREATE VIRTUAL TABLE vec_artifacts USING vec0(
  artifact_id INTEGER PRIMARY KEY,
  embedding float[1024]        -- MUST match the embedding model; qwen3-embedding:0.6b -> 1024
);

-- Keyword/exact match — vectors are bad at names, IDs, exact phrases
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  text_repr, content='artifacts', content_rowid='id'
);
```

> **Implemented at dim 1024**, not the 1536 this doc first sketched — the live embedding model is
> local `qwen3-embedding:0.6b` (1024-dim), driven by `VECTOR_DIMENSION`. External-content FTS is
> kept in sync by a single `AFTER INSERT` trigger; because the store is append-only, no
> delete/update shadow triggers or `('rebuild')` are needed.

Hybrid (vector + FTS5, fused with reciprocal rank fusion) is the current best practice — semantic search alone whiffs on proper nouns and exact strings, which your footprint is full of.

### 2.4 Hard rules (learned the hard way)

Four rules that any code touching this schema has to hold, restated here as the one place a public
contributor can find them without a repo-internal doc:

1. **`sqlite-vec` vec0 primary keys must be bound as `BigInt`, not a JS Number.** `better-sqlite3`
   returns `lastInsertRowid` as a `Number`; passing it straight to a vec0 primary key throws
   `SqliteError: Only integers are allowed for primary key values`. Cast explicitly —
   `insertVecStmt.run(BigInt(artifactId), vec)` — while keeping the plain `Number` id for anything
   serialized to JSON (`BigInt` isn't `JSON.stringify`-safe).
2. **`VECTOR_DIMENSION` must equal the embedding model's output length** (`qwen3-embedding:0.6b` →
   1024, see §2.3 above). `CREATE VIRTUAL TABLE IF NOT EXISTS` will **not** resize an existing vec
   table — swapping models means dropping `vec_artifacts` and re-embedding every row; vectors from
   two different models are not comparable and must never be mixed in one table.
3. **Enrich first, then commit atomically.** Fetch the embedding (a network call) *before* opening
   the write transaction, so a failed embedding call can never leave an orphaned artifact row with
   no vector.
4. **Memory is append-only — never hard-delete or overwrite a stored artifact.** Correct forward by
   appending a new row or a log entry, never by mutating or deleting an existing one; keep the
   original raw input (a `raw_path` pointer, not a DB blob) alongside anything derived from it.

---

## 3. Ingestion Pipeline

> **Superseded by [`04-connector-contract.md`](04-connector-contract.md)** for how data *reaches* the
> core: connectors are isolated external processes that POST artifacts (with entity *hints*, never
> IDs) to a versioned ingest API. The per-type normalization/enrichment guidance below still stands —
> it now describes what a connector does end-to-end, gathering *and* any modality-to-text
> transducer it needs (VLM/Whisper/EXIF enrichment), all producing `text_repr`; core's part is
> everything downstream (embedding, entity resolution, storage) — see doc 04 §1.2a.

```
Source connector → Normalizer → Enricher(s) → Store (transaction)
```

Each stage is idempotent; `(source, source_id)` and `content_hash` make re-runs safe. Same discipline as OB1's `storeTxn`: **enrich first (API calls), then commit atomically** — a failed caption never orphans a row.

### 3.1 Per-type normalization and enrichment

> **Shipped vs. backlog (July 2026):** Contact (`src/contacts.js`), Photo (`connectors/photo-exif`), and Document (`connectors/documents`, #56) are shipped. Video is *ingested* by `photo-exif` (EXIF/metadata), but its Whisper/keyframe enrichment is backlog. **Email, Social post, and Location remain backlog** (see [`05-roadmap.md`](05-roadmap.md)). The rows below describe each type's target normalization — shipped or not.

| Type | Source connector | `occurred_at` | `text_repr` construction | Entity links |
|---|---|---|---|---|
| **Email** | IMAP, or Gmail/Google Takeout mbox | `Date:` header | Subject + cleaned body (strip quotes/signatures) + "From X to Y" | Sender/recipients via alias match (1.0) |
| **Document** | Filesystem watcher / manual | file mtime or doc metadata | Extracted text (pdf-parse, mammoth for docx); LLM summary if huge | NER on body (inferred) |
| **Contact** | vCard / CardDAV / Google Contacts | — | "Sarah Jones, sister, lives in Austin, birthday March 4, email …" | IS an entity; artifact row makes it semantically searchable |
| **Photo** | Filesystem / iCloud or Google Photos export | EXIF `DateTimeOriginal` | VLM caption: subjects, scene, activity, visible text (OCR) | EXIF GPS → place entity; face clustering → person (optional, local) |
| **Video** | Filesystem export | file/container metadata | Whisper transcript + VLM captions of N keyframes | Speakers/subjects (inferred) |
| **Social post** | Platform data exports (Takeout, Twitter/X archive, Facebook DYI) | post timestamp | Post text + caption of attached media + engagement context | Mentions, tagged people |
| **Location** | Google Timeline export / Owntracks / iOS Significant Locations | ping timestamp | Segmented into *visits*: "At Riverside Coffee, 9:14–10:02 AM" | Place entity |

Notes:

- **Location pings get segmented, not stored raw.** A million GPS points are noise; ~10 "visits" per day are memories. Cluster pings into visit windows, reverse-geocode once per visit, store the visit as the artifact. Keep raw pings in `extra_json` or a side table if the hoarder instinct demands it.
- **Photos are the highest-value phase-2 target.** EXIF alone (time + GPS) makes them queryable before any AI runs; VLM captioning then unlocks "photos of us cooking."
- **Videos are photos + audio.** Keyframe extraction (ffmpeg, 1 frame per scene change) + Whisper covers 90% of recall value at low cost.

### 3.2 Enrichment tech choices (current, practical)

> **Embeddings row superseded by the implementation:** the live stack is local
> `qwen3-embedding:0.6b` via Ollama (1024-dim, `VECTOR_DIMENSION`), not `text-embedding-3-small`
> or `nomic-embed-text` — see [`local-llm-setup-guide.md`](local-llm-setup-guide.md).
>
> **Reverse geocoding row superseded by the implementation:** shipped as `src/geocode.js` +
> a bundled GeoNames-derived dataset (`src/geodata/places.json`, ~135k places, CC BY 4.0) —
> not the `local-reverse-geocoder` npm package this row originally sketched. Core resolves
> `place_label` from any connector-submitted `latitude`/`longitude` (issue #67); connectors
> never bundle their own place dataset. The rest of the table is still the working plan for
> future enrichers.

| Job | Cloud (via your OpenRouter gateway) | Local (privacy-max) |
|---|---|---|
| Embeddings | `text-embedding-3-small` (keep — it works) | `nomic-embed-text` via Ollama (768-dim; change vec table dim) |
| Image captioning/OCR | `claude-haiku` / `gpt-4o-mini` (cents per thousand images) | LLaVA / Qwen2.5-VL via Ollama |
| Speech → text | — | `whisper.cpp` (local is genuinely best here) |
| NER / entity extraction | Small LLM with JSON-output prompt | Same model via Ollama |
| Face clustering | ❌ never cloud | `insightface` — embeddings + DBSCAN, cluster IDs you name once |
| Reverse geocoding | ❌ never cloud | ~~Offline dataset (e.g., `local-reverse-geocoder`)~~ — shipped, see callout above |
| EXIF | — | `exifr` (npm) |

**Recommendation:** cloud VLM for the initial photo backlog (fast, cheap, quality), local-only for faces and location. Make the enricher an interface so each job's backend is a config flag.

### 3.3 One optional second index: true image embeddings

"Describe then embed" covers semantic recall. If you later want *visual similarity* ("find photos that look like this one"), add a second vec table with CLIP-family embeddings (`jina-clip-v2` or SigLIP, both runnable locally). It's additive — don't build it in v2.0.

---

## 4. Retrieval: The Query Planner

The single biggest upgrade over OB1. `search_memories(query)` becomes a two-stage planner:

**Stage 1 — Parse the query into filters + semantic core** (one cheap LLM call):

```
"photos of Sarah from our New Orleans trip last spring"
→ {
    types: ["photo"],
    entities: ["Sarah"],           → resolve via entity_aliases
    place: "New Orleans"           → place_label LIKE ("in"/"at" wording)
    near: null                     → a place NAME for "near"/"around" wording → geo-radius (#68)
    time: 2025-03-01 .. 2025-06-01,
    geo_required: false            → true for "where/last seen/been" with NO place named → place_label IS NOT NULL (#190)
    sort: "relevance"              → "recent" for "last/latest/most recent" → order candidates by occurred_at DESC, skip RRF (#190)
    semantic: "trip, vacation, together"
  }
```

> **"Where / last seen" (#190).** `geo_required` + `sort` handle the *no-place-named* location question. A "where was X last seen" query resolves the person, restricts to geotagged artifacts (`place_label IS NOT NULL`), and orders them `occurred_at DESC` — so the top hit is where they were last seen. Both are plan-derived and ride the demote-never-drop retry (no geotagged match → normal relevance search, never empty); a caller may override via `hybridSearch(query, { geoRequired, sort })`. No REST/MCP/schema change. The complement to a named place (which already implies geotagged rows via `place`/`near`).

**Stage 2 — Filter, then rank:**

```sql
-- SQL prefilter shrinks the candidate set
SELECT a.id FROM artifacts a
JOIN entity_links el ON el.artifact_id = a.id
WHERE a.type = 'photo'
  AND el.entity_id = :sarah_id
  AND a.occurred_at BETWEEN :t0 AND :t1
  AND a.place_label LIKE '%New Orleans%';
```

Then vector-rank only within those candidates (sqlite-vec supports `partition key` columns and metadata filtering as of v0.1.6 — or do the filter-then-KNN join in SQL). Fuse with FTS5 results via reciprocal rank fusion.

> **v2.0 implementation note.** vec0 metadata filtering can't span the `entity_links` join or a
> `place_label LIKE`, so the planner runs the SQL prefilter to a candidate id set first, then ranks
> *within* it (filter-then-rank). The candidate ids are delivered to both arms through a
> per-connection `search_candidates` **TEMP table** (`id INTEGER PRIMARY KEY`), refilled once per
> search — **not** marshaled into a `json_each(?)` string re-parsed by each arm (#227). The two arms
> constrain against it differently, and the difference is load-bearing at scale: the **KNN** arm uses
> `artifact_id IN (SELECT id FROM search_candidates)` (sqlite-vec ≥ 0.1.6 handles the vec0-PK IN
> efficiently); the **FTS** arm uses a correlated `EXISTS (SELECT 1 FROM search_candidates sc WHERE
> sc.id = artifacts_fts.rowid)`, **never** `rowid IN (…)`. On a ~210k-row store the `rowid IN
> (subquery)` shape makes FTS5 rank the full match set before filtering (~27 s/query, whether the set
> is `json_each` or an indexed temp table); the EXISTS form probes the PK index per match (<1 ms).
> Results and bm25 order are identical (equivalence-tested). Because the temp table is shared across
> calls, the refill sits in the same synchronous, await-free stretch as the reads it feeds, so a
> concurrent search can't refill it mid-flight. Both arms fuse with RRF (`RRF_K`). A filter term that
> can't actually filter (an unresolved entity name, a `place` matching no `place_label`) is folded
> back into the ranked search text so it can't silently vanish. The query parse is one small-LLM call
> (`QUERY_MODEL`) validated with zod; if the model or the embedder is unreachable, search degrades
> gracefully (pure-semantic plan / FTS-only).
>
> **US-state place terms (#186).** When `place` resolves to a US state, the prefilter matches
> `place_label` against **both** the full-name form (`%Texas%`, the stored format) and a code form
> (`%, TX`, legacy/coordinate-less labels) so neither label format is missed. The planner prompt
> also classifies a state/city/country name as `place` (never `entities`) and only sets `types`
> when a kind is explicitly named — a small local model otherwise mis-routed "in texas" to
> `entities` + `types:["visit"]`, leaving `place` empty.
>
> **Two-source plan: LLM + deterministic lexical gap-fill (#352).** Stage 1 is not the LLM alone.
> `QUERY_MODEL` can under-extract even when it succeeds — a query that literally says "photos" and
> "in Ocean City" can still come back with `types:[]` and `place:null` (the same model, the same
> failure class as #186's "in texas" above, just a different field). `lexicalPlanHints(query)` is a
> pure, deterministic pre-pass: `types` from a literal kind word (singular/plural, mapped through
> `ARTIFACT_TYPES` so it can never emit an unregistered type), `place` from an `in`/`at`/`around`
> phrase **confirmed** against the same bundled gazetteer `place`/`near` resolution already uses
> (`geocodePlace`/`normalizeUsState`) — never trusted from capitalization alone, so "at the beach"
> and "in a hurry" contribute nothing. It merges into the LLM's plan **gap-fill only**: a
> non-empty LLM `types`/`place` always wins (it may be better-informed than a literal word match);
> the lexical value fills in only what the plan left empty. Precedence end to end is **caller opts
> (`hybridSearch`'s `types`/`entities`/`near`/`geoRequired`/`sort`) > LLM plan > lexical hints** —
> unchanged from before #352 except that the LLM plan itself is now gap-filled before that caller
> precedence is applied. No schema change, no REST/MCP signature change.
>
> **Per-field plan demotion, not all-or-nothing (#365).** #352 is about the planner *dropping* a
> field the query names; this is about it *inventing* one the query never asked for — e.g. a
> `time_start`/`time_end` hallucinated for "when was X in Y" wording — and that invented field can
> zero out an otherwise-correct entity+place+type match. Before #365 the zero-candidate retry
> (the demote-never-drop behavior referenced above) was all-or-nothing: it could only fall back to
> the *caller's own* explicit filters (`hybridSearch`'s `types`/`entities`/`timeRange`/`near`/
> `geoRequired` opts), so a bare NL query with none of those set (`public/chat.js` sends only
> `{query, limit}`) lost the entity+place+type filters right along with the one bad field, landing
> on the full `default_searchable` fallback — a correctness footgun far worse than an honest empty.
> `planDemotionLadder(present)` (`src/search.js`, pure, exported for direct unit test) fixes this
> with a **cumulative prefix walk** over a fixed, most-likely-invented-first order — `time →
> geoRequired → near → place → types → entities` — dropping one more plan-derived field each rung
> and taking the first non-empty candidate set. A field is ladder-eligible only when it's both
> present **and** plan-derived; a caller-supplied filter is never demoted, so the honest-empty
> contract for caller filters is unchanged. The terminal rung (every ladder field dropped) rebuilds
> exactly the pre-#365 caller-only fallback, so the ladder can only ever narrow or match today's
> result — never widen it. `sort:'recent'` demotes to `relevance` only when `geoRequired` itself was
> among the dropped fields (by membership, not rung position — #190's rationale is specifically
> about geotagging, not "any retry happened"), so a query resolved by dropping only `time` keeps its
> plan-requested ordering. Observability: `db.prefilter.completed` carries `rung`/`dropped` (a count
> and a list of fixed-vocabulary field names — never query text), and one `search.plan.demoted` INFO
> row logs when the ladder had to widen at all. No schema change, no REST/MCP signature change, no
> re-embedding; `summarizeCandidates` (#353) and `lexicalPlanHints` (#352) are untouched.
>
> **Planner cost on CPU-only hosts (#179).** The parse is a tiny JSON, but generation time dominates
> and a 3B model on CPU can take >10s. So the single planner attempt is bounded by `QUERY_PLAN_TIMEOUT_MS`
> (default 20000) — on timeout, search fails over to the pure-semantic plan immediately (never throws)
> rather than stalling every query. A fast/GPU host that answers within the window still gets planned
> filters. The chat call also caps output tokens (the biggest CPU win). `QUERY_PLANNER_ENABLED=false`
> skips the LLM entirely (search == pure semantic + keyword, sub-second) for a box where the planner
> never beats even a low timeout; a smaller `QUERY_MODEL` (`qwen2.5:1.5b`/`0.5b`) is the middle ground.
>
> **Caller opt-out, `use_planner` (#433).** `QUERY_PLANNER_ENABLED=false` above is global and
> env-level — turning it off to make one connector fast strips NL filter inference from every
> human search on the box. `use_planner` (REST `POST /api/search`, MCP `search`; boolean, default
> `true`) is the per-call equivalent: a caller who has already supplied every filter it needs
> (`types`/`time_range`/`entities`/`near`/`geo_required`/`sort`) can skip the planner LLM call for
> just that request. Measured on this box: `POST /api/search` with `{types:["x-agent-preference"]}`
> took ~7.4s (empty result set) / ~9.0s (4 rows) with the planner running; the same body plus
> `use_planner: false` dropped to sub-second, because the embedding call and both ranking arms were
> never the cost (removing them alone, via `sort:"recent"`, saved only ~0.4s) — the planner's LLM
> call was. Precedence is unchanged in shape, one rung shorter when skipped: **caller opts > (LLM
> plan, absent) > lexical hints**. Unlike the two pre-existing skip paths — a caller that OMITS
> `use_planner` on `/api/recall`, or on a `QUERY_PLANNER_ENABLED=false` box — a caller that
> EXPLICITLY sends `use_planner: false` **still runs** `lexicalPlanHints`/`mergeLexicalHints` (#352)
> against its own query text, even on a `QUERY_PLANNER_ENABLED=false` box (the caller's own opt-out
> is the more specific signal); the flag's contract is "skip the LLM call," not "skip all filter
> inference." That gap-fill is cheap against the ~7s being saved but not literally microseconds:
> measured in this repo, `lexicalPlanHints` on a plain query with no `in`/`at`/`around` phrase costs
> well under a millisecond, but a query containing one (e.g. "photos in Ocean City") costs a few ms
> — `isKnownPlace`→`geocodePlace` linearly scans the ~135k-row bundled gazetteer per shrinking prefix
> of the capitalized run — and a *confirmed* place additionally reaches an unindexed
> `place_label LIKE '%…%'` existence probe (tens of ms on a large store). The internal knob is
> `hybridSearch(query, { usePlanner, lexicalWhenSkipped })`; REST/MCP set `lexicalWhenSkipped: true`
> alongside a caller's `use_planner: false`, while a caller that omits `use_planner` (on either
> `/api/recall` or a `QUERY_PLANNER_ENABLED=false` box) keeps `lexicalWhenSkipped: false` — their
> documented, tested behavior, unchanged. No auto-skip when only some plan-derived fields are
> supplied — auto-skipping would silently change results for every existing caller with no opt-out;
> the explicit flag is smaller, observable, and can't drift as new plan fields are added.
>
> **Geo-radius (`near`, issue #68).** `place` is a `place_label LIKE` text match; `near` is a true
> distance filter for proximity wording ("near/around/close to X"). A `near` value — a caller-supplied
> place name or `{lat, lon}`, or one the planner extracts — resolves to a center point (names via the
> bundled gazetteer, `geocodePlace`), and artifacts within `radius_km` (default `GEO_RADIUS_DEFAULT_KM`,
> clamped to `GEO_RADIUS_MAX_KM`) by coordinate join the candidate set: a cheap SQL lat/lon bounding box
> then an exact haversine refine — no spatial index. This catches nearby places whose `place_label`
> doesn't literally contain the query (a "Sausalito" photo surfaced by `near "San Francisco"`). Same
> demote-never-drop posture: a name that resolves to no center folds into the ranked search text.

**Graph expansion for relationship queries:** "what's going on with my sister" → resolve relationship attr → Sarah entity → walk `entity_links` → recent artifacts of any type, sorted by `occurred_at`. No embedding needed at all.

### 4.1 Result-set summary (#353)

A search returns a **page** (`limit`, default 3, max 50) of a potentially much larger matched
candidate set — "when was X in Ocean City" should answer "55 photos, two visits," not hand back
the top 3 rows and leave the counting to the human. `hybridSearch` computes `summary` once over
the **full filtered candidate set**, before the ranking slice, and attaches it to the array it
returns (`results.summary`) — REST (`POST /api/search`) and the MCP `search` tool both thread it
through. `summary`:

```json
{
  "total": 55,
  "by_type": { "photo": 55 },
  "date_range": { "start": "2019-07-28", "end": "2021-06-05" },
  "runs": [
    { "start": "2019-07-28", "end": "2019-07-30", "count": 8 },
    { "start": "2021-06-05", "end": "2021-06-05", "count": 47 }
  ],
  "places": [ { "place_label": "Ocean City, Maryland", "count": 55 } ],
  "people": [ { "entity_id": 128, "name": "Diana Monday", "count": 55 } ]
}
```

**Deterministic aggregation, never LLM generation** — an explicit design decision: exact (a
memory system that answers wrongly has failed at its one job) and instant (the planner call
already costs ~8-10s on this CPU host; a second generation step on every search would double the
worst case). `summarizeCandidates(rows)` (`src/search.js`, pure, exported for direct unit test) is
plain JS over rows already fetched — `total` is `rows.length`, i.e. the **full** matched count,
never the `limit`ed page, which is precisely the failure this feature exists to fix. `runs` groups
`occurred_at` into contiguous visits, tolerating a gap of up to `RUN_GAP_DAYS` (default 2) so a day
with no photos doesn't split one trip in half — the same day-run grouping `npm run events:cluster`
(#137/#138) already performs, deliberately without its "away from home" filter (irrelevant to
summarizing a result set). Any facet with no data is **omitted entirely**, never emitted as
null/0/empty-array; an empty result set yields no `summary` key at all rather than a "0 results"
object.

**Derived and non-persisted** — computed per read from rows `hybridSearch` already loaded, the
same precedent `display_text` (#147, above) set: it can change shape without a migration and can
never drift from the underlying data. **Additive** — an existing REST/MCP client reading only
`results` is unaffected; no schema, endpoint, or tool signature change. The MCP `search` tool
always prepends the one-line render (`"55 photos · Ocean City, Maryland · 2 visits:
2019-07-28–30, 2021-06-05"`) ahead of the rows when `summary` is present — including a
single-artifact result. `public/chat.js` renders only when it adds information: the same summary
is in every `POST /api/search` response, but the header is shown only when there's more than one
result; a single hit needs no summary above it.

### 4.2 MCP tool surface (v2)

Keep the per-session server factory and Streamable HTTP transport from v2.2 unchanged. New/updated tools:

> Note: MCP clients cache the tool list at connect time, so a newly added tool needs a client **reconnect** to appear (a service restart alone doesn't reach already-connected clients) — see the "Reconnect after a tool changes" note in `README.md`.

- `store_memory(content, type?, occurred_at?)` — manual notes are just `type='note'` artifacts; `type` is `'note'` (default) or an x- extension marker (#244). `occurred_at` is optional; if provided it must be ISO 8601 (#436, a malformed value is rejected, never silently dropped) and is stored verbatim. Omitted, it defaults to the write time (#514) — stored as a local `YYYY-MM-DD HH:MM:SS` timestamp (matching `ingested_at`'s local-day bucketing, not ISO 8601) — so a manual note is reachable via timeline's typed read-back and digest eligibility without relying on a read-time fallback; set it explicitly when the fact being remembered happened at a different time than it was typed.
- `search(query, types?, time_range?, entities?, near?, radius_km?, geo_required?, sort?, limit?, use_planner?)` — hybrid planner above; `near` (place name or `{lat, lon}`) + `radius_km` add a geo-radius filter (#68); the text output leads with a one-line deterministic summary of the full matched set (§4.1, #353); `use_planner: false` (#433, default `true`) skips the LLM planner call when the caller already supplied every filter it needs
- `timeline(start, end, types?)` — pure chronological recall, ordered by `COALESCE(occurred_at, ingested_at)` (#436): a NULL `occurred_at` (e.g. every pre-#436 `store_memory` write) reads through to when it was stored, rather than being silently excluded from every range — a read-time fallback only, `occurred_at` itself is never back-filled
- `about_entity(name)` — resolve → profile + linked artifact digest + person↔person `relations` ("everything about Sarah")
- `get_artifact(id)` — full `text_repr` + metadata + `raw_path`
- `propose_entity(kind, name, alias?, alias_type?, source?, confidence?)` (#232) — an agent *suggests* a new entity (a broker, an agent) instead of asserting one. Stages a **pending** `proposed_entities` row (`source='mcp-proposal'`, `alias` defaults to `(name,'name')`); mints nothing. A human then `approve_proposed_entity` / `reject_proposed_entity` (or uses the contacts-UI "Proposed" panel). Idempotent per `(name, alias, alias_type)`. REST: `POST /api/v1/entities/proposed`. This is the *only* graph-write an agent can make, and approval is the gate that keeps it from polluting the graph — distinct from the trusted, ungated `POST /api/v1/entities` (`createEntity`) the contacts UI uses.
- `add_relationship(from, to, relation_type?, raw_label?)` (#234) — link two **already-existing** entities with a directional edge (person `worksAt` org, etc.). `from`/`to` are each a name (resolved via `resolveEntityIds`) or a numeric id; `type = relation_type || canonicalRelationType(raw_label)` (both trimmed; a blank falls through to canonicalize the label). Wraps `upsertEntityRelation` (append-only, `OR IGNORE` idempotent) — **ungated**, since both endpoints already passed the `propose_entity` approval gate; an unknown/ambiguous ref or a self-loop errors rather than guessing or creating. No REST twin (the id-based `POST /api/v1/entities/:id/relations` already serves the UI).

### 4.3 Enumeration: GET /api/v1/artifacts (#449)

`/api/search` answers a relevance question — it ranks. It cannot correctly answer an
enumeration question — "all rows of type X" — because its candidate set is capped
(`k = clamp(limit * KNN_OVERFETCH, KNN_MIN, KNN_MAX)`) and its final ordering is a fused,
ranked list (`rrf([vecIds, ftsIds]).slice(0, limit)`); paging that with `offset` would page
into a ranking that structurally stops well short of the full table, and any ingest between
pages reshuffles ranks and produces duplicates/gaps. `GET /api/v1/artifacts` is the separate,
deterministic primitive this needs: a plain `WHERE`-filtered, `ORDER BY`-sorted, `LIMIT/OFFSET`-
paged listing, no planner call, no embedding, no RRF fusion.

Query params (all optional): `type` (a registered type or an `x-` extension marker — repeatable
or comma-separated), `source` (exact match), `since`/`until` (inclusive bounds — any string
`Date.parse` accepts, including plain ISO 8601 dates/datetimes and the DB's own stored
`"YYYY-MM-DD HH:MM:SS"` shape; compared to `occurred_at`/`ingested_at` via SQLite's `date()`
truncation, so a bare date bound is inclusive of that whole day rather than only its midnight
instant — an unparseable value is a **422**, not a silently-wrong filter),
`time_field` (`occurred_at` default, or `ingested_at`), `order` (`id` default, `occurred_at`, or
`ingested_at`), `dir` (`asc` default or `desc`), `limit` (1–200, `MAX_LIST_LIMIT`, default 50 —
over the max is a **422**, never a silent clamp), `offset` (default 0).

**`order=id` is the only ordering safe for a complete paged sweep.** `id` is monotonic and
append-only: a new ingest between page requests appends past the end and can never shift an
already-paged row across a page boundary. `occurred_at`/`ingested_at` orderings are offered for
convenience but are **not** sweep-safe — a backfilled artifact (a 2019 photo imported today; see
§2.1's `occurred_at` vs `ingested_at` split) inserts into the *middle* of that order, and a sweep
in progress can miss or duplicate it. Every ordering appends `id` as a deterministic tie-break, so
two identical requests never reorder rows sharing an `occurred_at`/`ingested_at` value (including
`NULL`, which SQLite sorts first ascending / last descending).

Response envelope: `{ total, limit, offset, order, dir, results }`. `total` is the count matching
the filters, independent of `limit`/`offset` — the signal that distinguishes "that was everything"
from "the page was full and there's more." `results` rows are hydrated exactly like `timeline`'s —
through `annotateArtifactRows` (one batched `entity_links` query for the whole page, never
per-row N+1) — so they carry `display_text` and parsed `extra`, matching what existing consumers
of a `results` array already expect.

Implementation (`src/db.js`'s `listArtifacts`): one fixed, null-guarded-predicate `WHERE` body
(the `candidateStmt` idiom above), shared by a **map of 6 prepared statements** keyed by
`${order}:${dir}` — `ORDER BY` cannot be a bound parameter, so the 3 order fields × 2 directions
are compiled once at module load from a static, non-user-controlled list, never spliced from a
request value — plus one `COUNT` sharing the same predicates. No schema change: no index, column,
or trigger was added for this route (the existing `idx_artifacts_type(type, occurred_at)` serves
a type-filtered scan; a dedicated `(type, id)` index is deferred until a caller actually measures
it as slow — see the issue for the trigger that would revisit this). Read-only, so nothing is
logged to `ingest_log` (§5 below is for mutations); the ops-log span (`db.artifacts.listed`)
carries counts and parameter names only — never row content or query text, this project's
standing logging rule (see `src/logger.js`).

Deliberately out of scope: changing `/api/search` (including adding `offset` to it — see above
for why that's wrong), keyset/cursor pagination (an append-only table's `id` offset is sweep-safe
without one), and an MCP tool wrapping this route (add one when an agent-side caller actually
needs enumeration).

---

## 5. Memory Consolidation (the sleep cycle)

> **Shipped (consolidation v1).** This is live: `src/consolidate.js` (`npm run consolidate`) writes one `type='digest'` artifact per day and the planner is digest-aware — see [`06-consolidation.md`](06-consolidation.md) and [`05-roadmap.md`](05-roadmap.md) Milestone 6. The design below is the original spec (note the `type='note'` → `type='digest'` change, already reflected in step 1).

Humans don't keep raw sensory streams; they consolidate. A nightly batch job:

1. **Daily digest** — LLM summarizes yesterday's artifacts into one `type='digest'` artifact (originally specced as `type='note'`; superseded by the doc 04 §6 type registry) ("Emailed 3 clients; brunch downtown; shipped OB2 ingestion PR"). Digests are what make *"what was I doing last October"* answerable in one hit instead of 400.
2. **Entity refresh** — new facts fold into `entities.attrs_json` ("Sarah changed jobs").
3. **Rollups** — weekly/monthly digests built from daily ones, hierarchical.

Cheap (one small-model call per day), and it's the feature that makes the system feel like memory instead of search.

---

## 6. Build Phases

> **Superseded by [`05-roadmap.md`](05-roadmap.md).** After Phase 2.0 shipped, the sequencing
> changed to connector-first milestones (contract foundations → `devsession` → `imessage` →
> `photo-exif` → contract freeze → consolidation → distribution); email/documents/location/video
> moved to the roadmap's backlog. This table is kept for the original rationale only — do not
> plan work from it.

| Phase | Scope | Why this order |
|---|---|---|
| **2.0** ✅ | Artifact schema + entity graph + FTS5; migrate OB1 memories to `type='note'`; contacts import; query planner v1 | Foundation; contacts seed the entity spine; everything is text-native (no new AI deps) — **shipped** (`src/db.js`, `search.js`, `migrate.js`, `contacts.js`) |
| **2.1** | Email (Takeout mbox first, IMAP later) | Highest-density relationship data; deterministic entity links prove the graph |
| **2.2** | Documents + filesystem watcher | Easy win on existing pipeline |
| **2.3** | Photos: EXIF pass first (instantly queryable), VLM caption backlog second | Biggest emotional/recall payoff |
| **2.4** | Location visits + daily digests | Timeline becomes continuous; consolidation begins |
| **2.5** | Video/audio (Whisper + keyframes); social media exports | Heavier compute, lower marginal value — last |
| **Future** | Face clustering, CLIP visual similarity, cross-device sync, temporal knowledge graph (facts with validity ranges) | Additive, each independently optional |

Each phase is a new connector + enricher against a **stable core schema** — the schema is the contract; senses get added over time, exactly like the framing in §1.

---

## 7. Practical Constraints & Risks

- **Scale:** SQLite + sqlite-vec is comfortable to ~1M artifacts. A decade of personal data ≈ 100k–500k artifacts after location segmentation. You're fine; WAL mode already handles concurrent readers. Revisit only if you cross ~5M vectors.
- **Backlog cost:** 20k photos × VLM caption ≈ $10–30 via cheap cloud VLMs, or free-but-slow locally. Budget the embedding calls too (trivial: ~$0.02/1M tokens).
- **Ingestion is where the work is.** Retrieval is a solved pattern; parsing Google Takeout, mbox quirks, HEIC conversion, and export-format drift is 70% of the engineering. Build connectors as isolated, restartable scripts with their own state.
- **Privacy tiering:** faces and raw location never leave the machine. Everything else is your call per-enricher. Since it's all local SQLite + files, backup = copy a folder — matches the metadata-hoarder doctrine: cheap storage, one place, permanent.
- **Identity resolution is the hard unsolved-in-general problem.** Aliases + confidence scores get you 90%; accept occasional manual merges via a `merge_entities` admin endpoint rather than chasing full auto-resolution — **delivered (#75):** `POST /api/v1/entities/merge` + the `merge_entities` MCP tool, backed by `mergeEntities` in `src/db.js`. A merge **tombstones** the absorbed entity (`entities.merged_into` points at the survivor; the row is never deleted — design-philosophy.md §1) and re-points its `entity_aliases`/`entity_links`/`entity_relations` rows to the survivor. `entity_aliases` repoints unconditionally (`(alias, alias_type)` is globally unique, so it can never collide), which is why `resolveEntityIds`/`about_entity` need no separate merge-redirect logic — an alias can never resolve to a tombstoned id in the first place. A direct keep↔absorb relation is dropped rather than becoming a self-loop (excluded from the `moved` count, since it's genuinely deleted, not moved); a repoint that would collide with a link/relation the survivor already holds for the same artifact/role (or same from/to/type) is resolved by **deleting the absorbed side's duplicate before repointing the rest** — never left orphaned pointing at the tombstoned id, so `get_artifact`/`about_entity` can never surface a stale link back to a merged-away entity. This is core-owned (connectors may never merge/assert entities, doc 04 §1.2), so it lives outside the `/api/v1/ingest` connector lane. Paired with `GET /api/v1/entities/duplicates` (`list_probable_duplicates`), which ranks candidate person-entity pairs by shared normalized phone/email in their contact attrs (the real residue — the contacts importer's own `resolveExistingEntity` only auto-merges on shared email or exact name, **never** phone) and by name similarity (typo-level; not nickname resolution, which needs a name dictionary and is out of scope). Detection never merges anything itself — a human decides: merge, or **dismiss** ("not a duplicate," #302, `POST/DELETE /api/v1/entities/duplicates/{dismiss,dismissals}`) — so the endpoint is stateful with respect to a human's prior dismissal, not purely read-only-and-derived; it takes no other write and there is still no per-pair undo, only clear-all (see `docs/09-contacts-ui.md`). **Extended (#96):** a full contacts-curation surface over `/api/v1/entities` (list/get, create, `PATCH` fields, add/remove aliases & relationships, photo upload) plus a browser UI at `/<token>/ui/contacts.html` (token-only when `UI_URL_TOKEN` is set, #169 — there is no bare `/ui` mount) lets a human correct the graph directly — same "entity graph is mutable curation state, raw artifacts stay append-only, every change logged" posture as merge. See [`docs/09-contacts-ui.md`](09-contacts-ui.md).

**Matching reads `entity_aliases` only, never `attrs_json` (#409).** A contact's email/phone lives on the profile (`attrs.emails`/`attrs.phones`) for display/editing, but every resolution path — ingest hints, search, `annotateHandles`, the side-directory consult — reads the separate `entity_aliases` index exclusively; the two can drift (a profile value with no matching alias is invisible to matching, silently) unless something keeps them in sync. `resolveHandle(alias, aliasType)` in `src/db.js` is the one exact-match resolver a future connector or script should reach for; `resolveForIngest(alias, aliasType)` is the documented ingest-lane precedence ladder (exact → the #293 given-name-prefix inference → the #154/#301 side-directory consult) in one place, so a new caller does not re-derive it. `reconcileHandleAliases(entityId, attrs, { explicit })` is the one writer that keeps a profile's emails/phones indexed — every `attrs_json` writer (contact import, the contacts-UI `PATCH`, `createEntity`, `approveProposedEntity`, `promoteDirectoryName`, the `backfill:directory-attrs` card-fill) routes through it. Full detail, including the three-states invariant (aliased / tombstoned / owned-by-another), lives in `src/db.js`'s comments around `resolveHandle`/`reconcileHandleAliases`; the `check:handle-aliases` (read-only invariant check) and `backfill:handle-aliases` (heals drift) npm scripts are defined in `package.json`.

---

## 8. Summary

Open Brain 2 = OB1's engine + three additions:

1. **A unified artifact schema** where every digital object is an event with time, place, and a text representation
2. **An entity graph** with contacts as the spine, turning artifacts into relationships
3. **A query planner** that fuses SQL filters (time/place/person/type) with hybrid vector+keyword ranking

The senses (VLM, Whisper, EXIF) are pluggable and improve over time. The mind — text + metadata + graph — stays stable. That's the same trick evolution used.

---

## 9. Prior Art (researched July 2026)

- **Timelinize** (timelinize.com, AGPL, Go) — closest existing project: open-source, local-only personal archive unifying photos, messages, emails, location, social posts, and contacts into a SQLite-backed timeline. Entity-aware with automatic cross-source contact merging, and can infer locations for non-geolocated items. Caveats: still unstable (v0.0.x, schema changes force timeline rebuilds), and built for *browsing* (timeline/map/gallery UI) rather than *AI recall* — no MCP server, early semantic search. Its importers are a useful reference for Takeout/export parsing; its entity-attribute model independently validates the contacts-as-spine design in §2.2.
- **Perkeep** — unified personal data storage; weak on relationships/recall
- **Rewind/Limitless, Microsoft Recall** — lifelogging via screen/audio capture; continuous but shallow, no historical footprint
- **mem0, Letta** — LLM memory layers (text-only, like OB1)
- **Upstream OB1 itself** — community importers for Takeout/Twitter/Instagram/Gmail exist, and entity extraction + knowledge-graph work is emerging in that community; worth monitoring for reusable pieces. (An earlier reference here to a "doc 01" pointed at pre-repo research notes that were never committed — there are no docs 01/02 in this repo; the numbering starts at 03.)

No existing project combines local-first multimodal ingestion, an entity graph, and an MCP retrieval brain — that combination is OB2's niche.
