# LifeContext — The Connector Contract

**How anything — yours or the community's — feeds the brain**

Defines the stable boundary between the LifeContext core (artifact store, entity graph, hybrid retrieval, consolidation) and *connectors*: external processes that gather data from some corner of a digital life and submit it for ingestion. The contract is HTTP + JSON, not a plugin API. Publishing this document *is* shipping the framework.

> **Status: partially implemented.** `POST /api/v1/ingest` (single-artifact upsert on
> `(source, source_id)`, §2–§4), `POST /api/v1/ingest/batch` (up to 100 artifacts per call,
> per-item isolation, §2), and `GET /api/v1/ingest/types` (§6) are **live** in `src/ingest.js`
> / `src/server.js`. The event (`/events`) and per-connector state endpoints below remain
> design-only ([`05-roadmap.md`](05-roadmap.md) Milestone 0+). The contract is declared
> v1-stable only after three real connectors have used it (Milestone 5). This doc supersedes
> the ingestion-pipeline framing in [`03-ob2-design.md`](03-ob2-design.md) §3 — see the naming
> note below for how the terms map.

**Naming note.** Doc 03 §1.1 uses "senses" for the *transducers* — the enrichers (VLM, Whisper, EXIF) that convert a modality into `text_repr` or the structured metadata columns (EXIF's own row in that table is time/place → structured columns, not prose). That usage stands as a conceptual label for the modality-to-artifact-fields step; it says nothing about *where* the step runs. Where a transducer lives follows the source-specificity rule in §1.2a below, in one clause: a transducer that exists only because of one source's data shape is connector-side, same as the parser that feeds it (§1.2a's own exception for `src/contacts.js` still applies — see there). §9's `photo-exif` row is the worked example — the VLM caption worker is a connector-side process that upserts the same `(source, source_id)` with an enriched `text_repr`. The external gatherers defined here are **connectors**, because one connector can emit many types (iMessage emits messages *and* photo attachments; a Takeout importer emits email, location, and browsing history). The decomposition is: **connector** (gathers) → **type** (classifies) → **transducer/sense** (enriches into `text_repr` or structured fields, connector-side). The `artifacts` table already encodes the first two as its `source` and `type` columns.

---

## 1. Design Principles

### 1.1 The contract is the wire, not the runtime

A connector is **any process that can make an authenticated HTTP POST**. Not a TypeScript interface, not a folder the core dynamically loads, not code that runs inside the server process.

| In-process plugin model | HTTP contract model (this doc) |
|---|---|
| Plugins run arbitrary code inside the brain with access to everything | Connectors are isolated processes; a crash or a bug is contained |
| One language (Node) | Any language — PowerShell, Python, bash, an iOS Shortcut |
| Core must review, load, sandbox, and version plugin code | Core reviews nothing; it validates payloads |
| Distribution requires an in-repo plugin directory | Distribution is a list of links to independent repos |

This is the same discipline already stated in doc 03 §7: *"build connectors as isolated, restartable scripts with their own state."* This contract just formalizes it and opens it to strangers.

### 1.2 Core owns the graph; connectors submit hints

**Connectors never see or assert entity IDs.** They submit raw *alias hints* — an email address, a phone number, a name — and the core resolves them against `entity_aliases`. A hit becomes a deterministic link; a miss queues for later resolution. One buggy community connector can therefore never corrupt the contacts spine. (Full rules in §4.)

### 1.2a Core holds no source-specific knowledge — and the one exception

**The rule:** core holds no source-specific knowledge. Anything that exists only because a particular source exists belongs in that source's connector. The test is *LifeContext cannot ingest the data without the connector* — so the connector is the only thing that knows that source's shape, and all of that shape-knowledge lives with it; otherwise core accumulates a little bit of every source it has ever met. The dividing line is **who writes the graph**, not who parses a format: core owns the store, the vector space, and the entity graph (embeddings, entity resolution against `entity_aliases`, `place_label` from submitted GPS, every SQLite/`vec0` write); connectors own everything source-specific that does not write those directly — format parsing, EXIF, HEIC decode, VLM captioning, OCR, face detection/clustering, `chat.db` reading. These only ever produce `text_repr` plus entity hints, never IDs (§4), delivered as an enrichment-wave upsert on the same `(source, source_id)` (§3).

**The exception: `src/contacts.js`.** It parses a source format (vCard) — connector work by the letter — but it also calls `insertEntityStmt.run(...)` and writes `entity_aliases` directly, which §1.2 exists to forbid a connector from doing ("one buggy community connector can therefore never corrupt the contacts spine"). Contact import **is** the authoritative writer of that spine, so it sits on core's side of the who-writes-the-graph line — it is not a loophole in the rule above, it is the same line, viewed from the entity-graph side. This is why `src/contacts.js` lives in `src/`, not `connectors/`, despite containing a hand-rolled vCard parser: moving it would either punch an entity-creation hole in the contract that every other connector is denied, or route bulk vCard import through the `proposed_entities` approval queue — absurd for a thousand cards at once. Its header comment documents this in place.

### 1.3 Idempotency is structural, not conventional

`source` + `source_id` are **required** fields and ingestion is **upsert-by-default**. A connector that crashes mid-run and restarts from the top is harmless by construction. We cannot code-review every community connector's retry logic, so the API makes retries safe regardless.

### 1.4 High-frequency streams are events, not artifacts

A song every 3 minutes, a page view every 30 seconds, a GPS ping every 10 — raw streams would outnumber deliberate memories 1000:1 and poison retrieval. The contract provides two lanes:

- **Artifact lane** — discrete, memory-worthy items (an email, a photo, a dev session). One POST = one memory.
- **Event lane** — raw high-frequency observations. Core *sessionizes* them into artifacts (a listening session, a browsing session, a visit) on its own schedule. This generalizes the location-pings→visits rule from doc 03 §3.1. (Details in §5.)

Connector authors do not implement aggregation. If they did, search quality would be hostage to the worst connector.

### 1.5 Core governs vocabulary and versions the contract

Types come from a registered list (§6) so the planner can reason about them; the endpoint is versioned (`/api/v1/…`) with an explicit compatibility promise (§8) so a shortcut on someone's phone keeps working across LifeContext upgrades.

---

## 2. The Ingest API

All endpoints require the standard `x-api-key` header. All bodies are JSON. Size cap 256 KB per request (raw media never travels through this API — see `raw_path` note in §3).

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/ingest` | Submit one artifact (upsert on `(source, source_id)`) |
| `POST /api/v1/ingest/batch` | Submit up to 100 artifacts in one call (EXIF backlogs, export imports) |
| `POST /api/v1/exists` | Read-only: which of up to 100 `source_ids` are already stored for a `source` (skip-already-imported) |
| `POST /api/v1/events` | Submit raw high-frequency events for sessionization |
| `GET  /api/v1/ingest/types` | The current type registry, plus `x-` extension types observed in the store (machine-readable) |
| `GET  /api/v1/sources/:source/state` | Optional per-connector cursor/state blob (see §7) |
| `PUT  /api/v1/sources/:source/state` | Store the cursor/state blob |

**Responses:**

```json
// 201 created / 200 updated (upsert)
{ "id": 4821, "created": true, "resolved_entities": 2, "unresolved_aliases": 1 }

// 422 — schema violation (missing source_id, unknown required field, oversize)
{ "error": "validation", "issues": [ ... ] }

// 200 with warnings — accepted, but flagged (unregistered x- type, no occurred_at)
{ "id": 4822, "created": true, "warnings": ["occurred_at missing; ingested_at used for timeline"] }
```

Design note: prefer **accept-with-warning** over rejection wherever data isn't destructive. A community connector that mostly works should mostly work.

**Batch (implemented, `POST /api/v1/ingest/batch`).** Request body is `{ "artifacts": [ …1–100 payloads… ] }` — each item is the same shape as §3. Per-item isolation: each artifact still gets its own enrich-then-commit transaction (`upsertArtifactTxn` is itself a `db.transaction`), so one bad item is skipped and reported at its index — it never rolls back or blocks the items around it. **Embedding itself is batched (#408), not per-item:** the server pre-passes every item to decide which ones actually need a fresh embedding (a metadata-only wave issues zero gateway calls), then embeds however many DO need one in as few Ollama calls as its internal per-call budgets allow, before writing anything. Size expectations honestly: the like-for-like benchmark on this box is **~171 ms/text at one input per call → ~40 ms/text at 50 (~4x)**, and a synthetic run on 2026-07-31 measured only **~2x** on a busier box (`src/embeddings.js`'s `EMBED_BATCH_MAX_INPUTS`/`EMBED_BATCH_MAX_CHARS` bound one call). #408's headline ~35x compares an ingest-path span average against an isolated embedder benchmark and should not be used for capacity planning. **This means a fuller batch is materially cheaper per item than several small ones** — a connector doing a backlog/backfill should submit up to the 100-item cap rather than trickling small batches, since the per-call gateway overhead this change amortizes only pays off across a whole batch's worth of items in one call. A chunk-level embed failure (rare — a pathological text, a transient gateway hiccup) falls back to embedding that chunk's items one at a time rather than failing the whole request; per-item failure reporting below is unaffected.

```jsonc
// Batch request (POST /api/v1/ingest/batch)
{ "artifacts": [ { …ingest payload per §3… }, … ] }   // 1–100 items

// 200 — per-item results, index-aligned with the request (results[i] ↔ artifacts[i])
{
  "summary": { "created": 2, "updated": 0, "failed": 3 },
  "results": [
    { "id": 4821, "created": true, "resolved_entities": 1, "unresolved_aliases": 0 },
    { "id": 4822, "created": true, "resolved_entities": 0, "unresolved_aliases": 0, "warnings": ["…"] },
    { "error": "validation", "issues": [ … ] },
    { "error": "embedding_unavailable" },
    { "error": "ingest_failed" }
  ]
}

// 422 — envelope invalid (body isn't {artifacts:[...]}, 0 items, or >100 items); nothing persisted
{ "error": "validation", "issues": [ … ] }
```

The envelope schema validates only shape and count (1–100 items) — a malformed *item* is never an envelope-level 422; it becomes a `{error, issues?}` entry at its index instead, so 99 good artifacts in a batch of 100 are never held hostage by 1 bad one. The response is **always HTTP 200** once the envelope itself is well-formed, even when some items failed — the request succeeded; per-item status lives in the body (`summary` gives the quick read, so a connector doesn't have to count `results` itself). Batch is a backlog path (cron/one-shot backfills), processed sequentially, not a low-latency path — see doc `05-roadmap.md` Milestone 0.

`embedding_unavailable` vs `ingest_failed` (#255): an item that needed a fresh embedding but the embedding gateway (Ollama) was unreachable or timed out gets `embedding_unavailable` — retry that item later, unchanged, once the gateway is back. Any other runtime failure (e.g. a DB-layer error) still gets the generic `ingest_failed` — don't blindly retry it without investigating; resending it unchanged will fail the same way. A metadata-only re-ingest (unchanged `text_repr`) never calls the embedder at all, so it succeeds normally even while the gateway is down.

**Existence check (implemented, `POST /api/v1/exists`, #198).** Purely **read-only** — no upsert, no `ingest_log` row. It lets a connector skip the expensive enrich+ingest for artifacts core already has: the common trigger is a source whose local skip-state was lost or invalidated (e.g. a Google Takeout re-extract resets every file's mtime, so `photo-exif`'s mtime-keyed manifest misses on everything even though the library is fully imported). The check is by the exact upsert key `(source, source_id)`, so a Takeout-origin key (`gphotos:<hash>`) and a generic key (`<hash>`) are correctly treated as distinct. Validation failures are `422` (same funnel as `/ingest`); a connector built against a newer core must treat a `404` as "this core predates `/exists`" and fall back to processing everything, never a hard failure.

```jsonc
// Request (POST /api/v1/exists) — up to 100 source_ids per call
{ "source": "google-photos", "source_ids": ["gphotos:<hash1>", "gphotos:<hash2>", …] }

// 200 — the subset already stored (order not guaranteed; unknown ids omitted)
{ "exists": ["gphotos:<hash1>"] }

// 422 — envelope invalid (missing source, 0 ids, >100 ids, or an unknown key); nothing read
{ "error": "validation", "issues": [ … ] }
```

---

## 3. The Artifact Payload

```jsonc
{
  // ---- REQUIRED ----
  "source": "imessage",                // stable connector identifier; becomes artifacts.source
  "source_id": "chat.db:msg:88213",    // provider-unique ID; upsert key with source
  "type": "message",                   // from the registry (§6), or "x-…"
  "text_repr": "Text from Sarah Jones: 'Landed! See you at the gate.'",

  // ---- STRONGLY RECOMMENDED ----
  "occurred_at": "2026-07-04T18:22:09Z",  // when it HAPPENED; omit → warning, ingested_at used
  "content_hash": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",  // bare sha256 hex of the raw bytes

  // ---- OPTIONAL ----
  "latitude": 30.2672,
  "longitude": -97.7431,
  "place_label": "Austin-Bergstrom Intl",
  "raw_path": "/archive/imessage/2026/07/msg-88213.json",  // pointer; media never travels in-band
  "extra": { "service": "iMessage", "is_from_me": false }, // → artifacts.extra_json, schema-free

  // ---- ENTITY HINTS (never IDs — see §4) ----
  "entity_hints": [
    { "alias": "+15550142",   "alias_type": "phone", "role": "sender" },
    { "alias": "sarah jones", "alias_type": "name",  "role": "mentioned", "confidence": 0.7 }
  ]
}
```

Field-by-field rules:

- **`source`** — lowercase, stable for the lifetime of the connector. Changing it orphans your history. Prefer the plain product/source name (`imessage`, `gmail`, `photo-exif`) — no prefix convention needed; the column itself says what it is.
- **`source_id`** — must be reproducible from the source data itself (a provider ID, a file path + mtime, a hash), *never* a random UUID minted at runtime — random IDs defeat upsert.
- **`text_repr`** — the normalized natural-language representation, per doc 03 §1.1. This is what gets embedded and FTS-indexed. Connectors do the describing — including running a model to *produce* that description when the source needs one (a VLM captioning a photo, OCR reading a scanned document — see `connectors/photo-exif/caption-worker.js` and `connectors/documents/ocr-worker.js`; the former is also §9's worked example) — while core does the embedding. Connectors **never** compute vectors — embedding model and dimensions are core's private business (this is what lets the embedding model change without touching a single connector). See §1.2a for the general rule this instance of the split follows.
- **`occurred_at` vs `ingested_at`** — the 2019 photo imported today sorts into 2019. Connectors that can't determine occurrence time omit the field and accept the warning.
- **`content_hash`** — lowercase hex SHA-256 digest of the raw bytes, no algorithm prefix (matches core's `sha256()` helper). Compared by exact string equality for cross-import dedup — a mismatched format silently breaks dedup instead of erroring.
- **`raw_path`** — the API carries text + metadata only. Connectors that own binary artifacts (photos, audio) write them to disk themselves and submit the pointer. Keeps the DB small and the API fast, per doc 03 §2.1.
- **`place_label`** — connectors with raw GPS should submit `latitude`/`longitude` and omit `place_label`; core resolves an offline place label from them (mirrors `text_repr` → embedding: connectors supply raw signal, core does the resolving — see `src/geocode.js`). A connector with a better/more specific label (e.g. a device's own named location) may still submit `place_label` explicitly — core never overrides an explicitly-submitted value.

**Upsert merge semantics (implemented).** A second POST with the same `(source, source_id)` **updates** the existing artifact (200; a first POST is 201). Fields **present** in the payload overwrite; fields **absent** are left unchanged — so the photo-exif → VLM caption wave can upsert only `text_repr` without wiping the GPS/`place_label` the EXIF pass stored (enrichment waves compose). This reconciles with append-only: only the *derived* representation is rewritten (`text_repr`, its embedding, its FTS row, and metadata) — the original bytes are never touched (`raw_path` files untouched, `content_hash` still tracks them), `ingested_at` stays at first ingestion, entity links are only ever added, and every update appends an `ingest_log` row carrying the prior value of each changed field, so the full evolution is reconstructable. Nothing can be **cleared** through this API: an explicit `null` on an optional field is a 422 (optional, not nullable). The embedding is recomputed only when `text_repr` actually changes — a metadata-only upsert (or an identical retry) never calls the embedder.

---

## 4. Entity Hints & Resolution Rules

The single most important boundary in the contract.

**What connectors submit:** `{alias, alias_type, role, confidence?}` where `alias_type ∈ {email, phone, name, handle}` and `role` uses the `entity_links` vocabulary (`sender`, `recipient`, `pictured`, `mentioned`, `author`, `self`, `location_of`). `self` is connector-submittable, not core-inferred-only — a connector that already knows an artifact is the account owner's own (iMessage's `is_from_me`, a device's own GPS track) should hint `self` directly rather than relying on later resolution.

**What core does with each hint:**

| Case | Action | Resulting confidence |
|---|---|---|
| Alias matches `entity_aliases` exactly (normalized) | Create `entity_links` row | 1.0 for deterministic alias types (email, phone); connector-supplied confidence (capped 0.9) for `name`/`handle` |
| `name`-type alias misses exactly, but is an unambiguous given-name prefix of exactly one entity's alias (#293) | Create `entity_links` row via `resolveNameByPrefix` — the same word-boundary, ambiguity-checked fallback #184 uses at query time (0 or ≥2 candidates stays unresolved, never guessed). The inference is re-run per ingest and **never minted as an alias** (#296), so it self-corrects the moment a second candidate exists; a **tombstoned** `(entity, alias, 'name')` (#111) stays unresolved, so a deliberately removed given name is not re-inferred | **Capped 0.6** — its own tier, below an exact `name` match (#296): this is core's inference, not something the connector supplied, and the ladder is what a later review filters on |
| No match (and no unambiguous prefix, for `name`) | Insert into `unresolved_aliases` staging table with artifact reference | — (staged; when any later alias-adding path — a contact import/re-import, `approveProposedEntity`, or a contacts-UI write (#295) — creates a matching alias, `resolveStagedArtifactHints` links every queued artifact automatically — see below). Core then consults its **side contact directory** (#154) and, if that names the alias, stages a `proposed_entities` row for review — still connector-transparent (the connector submits the same bare hint either way). Precisely which alias types (#301): **`email`, `phone`, and `name`** — `name` matches the directory's stored display name exactly (case-insensitive), **not** fuzzily. `handle` and `relation` are never looked up (`relation` has its own resolver, `resolveRelationHints`). An **ambiguous** directory match — a name held by two different cards — stages **nothing** and logs to stderr rather than guessing which person it is. Nothing is ever minted: the directory names the candidate, a human approves. |
| Connector supplies `confidence` > its type's cap | Clamp | Deterministic trust is earned by alias type, not asserted by the connector |

Normalization (lowercase, digits-only phones) happens core-side; connectors submit what they see.

**Retroactive resolution (implemented, #102; extended #295).** A staged (no-match) hint isn't stranded: **every** path that gives an entity a new alias runs `resolveStagedArtifactHints` for that entity — contact import/re-import, `approveProposedEntity`, and the contacts-UI writes `createEntity` / `updateEntityAttrs` / `addAlias` (#295 — the UI paths previously omitted it, so an alias added in the browser resolved for future ingests but left already-staged hints unlinked). So when *any* of them supplies the missing alias (email/phone/name), all queued artifacts carrying that hint are linked automatically — no separate command, no schedule. Idempotent (append-only `entity_links`, a re-run forms 0 new links). A one-shot `npm run backfill:links` sweeps every entity to heal artifacts staged before this mechanism shipped. (This is why ingest order is a recommendation — contacts first — not a hard constraint: an out-of-order artifact self-heals when its contact arrives.)

A hint staged *before* the given-name-prefix fallback existed (#293) also self-heals only on a fresh ingest, not automatically — `npm run backfill:name-prefix-links` is the one-shot sweep for those: for each staged bare given name (e.g. "suzie") that resolves to exactly one entity by prefix, it links every artifact already carrying that staged hint, at the same 0.6 inference tier and under the same tombstone guard as the live path. It **adds no alias** (#296) — `resolveStagedArtifactHints` can't do this job precisely because it walks an entity's *own* aliases and the bare given name is deliberately never one of them. Idempotent; a second run forms 0 links.

**Never in the payload:** entity IDs, entity creation requests, relationship assertions ("this is my sister"). Durable facts enter the graph through contacts import and consolidation, not through connectors.

> **Internal reuse — person↔person relations (issue #37).** The contacts importer stages *unresolved relationship targets* in this same table using a distinct `alias_type='relation'` marker (with `role` = the raw relationship label), so they never collide with the external hint vocabulary above. This is a core-side mechanism, **not** a connector payload field — external connectors still submit only `{email, phone, name, handle}` hints. When the related person is later imported, `resolveRelationHints` turns each staged row into an `entity_relations` edge (see design doc §2.2).

```sql
-- New staging table (core migration, not a payload concern). UNIQUE(artifact_id, alias,
-- alias_type, role) is an additive deviation from an earlier sketch of this table: it makes
-- resolveEntityHints idempotent by construction (paired with INSERT OR IGNORE), the same
-- discipline entity_links already gets from its own PK — re-submitting identical hints for
-- the same artifact stages zero new rows instead of piling up duplicates.
CREATE TABLE unresolved_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER REFERENCES artifacts(id),
  alias       TEXT NOT NULL,
  alias_type  TEXT,
  role        TEXT,
  hint_confidence REAL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(artifact_id, alias, alias_type, role)
);
CREATE INDEX idx_unresolved_alias ON unresolved_aliases(alias, alias_type);
```

---

## 5. The Event Lane & Sessionization

`POST /api/v1/events` accepts raw observations:

```jsonc
{
  "source": "nowplaying",
  "stream": "music",                    // registered stream name (§6)
  "observed_at": "2026-07-06T21:14:00Z",
  "payload": { "track": "Starboy", "artist": "The Weeknd", "app": "Spotify" },
  "dedup_key": "spotify:starboy:2114"   // optional; same-key events within window collapse
}
```

Events land in an `events` side table — **never** in `artifacts`, never embedded, never searchable directly.

**Sessionization** runs as part of the nightly consolidation job (doc 03 §5) — or opportunistically on stream-idle — and rolls events into one artifact per session using per-stream rules:

| Stream | Session boundary | Resulting artifact `text_repr` (example) |
|---|---|---|
| `music` | gap > 30 min or app change | "Listening session, 9:00–11:30 PM: synthwave — 14 tracks incl. The Weeknd, Kavinsky" |
| `browsing` | gap > 20 min or domain-cluster change | "Reading session: sqlite-vec docs, 3 GitHub issues on FTS5 ranking (25 min)" |
| `location` | existing visit segmentation | "At Riverside Coffee, 9:14–10:02 AM" |
| `terminal` | shell session lifetime | "Shell session in ~/lifecontext: npm test ×6, git commit ×2, nssm restart" |

Session artifacts get `type` from the registry (`listening_session`, `browsing_session`, `visit`, …), `source` = the originating connector, `source_id` = deterministic session key (stream + start timestamp) so re-running sessionization upserts instead of duplicating. Raw events older than a retention window (default 90 days, configurable) are pruned; the session artifact and its `extra` digest are the permanent record.

**Retrieval policy:** ambient session types are **excluded from default search** and included only when the planner detects intent ("what was I listening to", "that article I read") or when explicitly filtered. Deliberate memories stay in front.

---

## 6. Type & Stream Registry

> **Live.** The registry is implemented as static config in `src/ingest-types.js`
> (`TYPE_REGISTRY`) and served machine-readably at `GET /api/v1/ingest/types` — connectors can
> self-check at startup instead of trusting a copy of this table. `src/search.js`'s planner
> prompt and the `types` filter zod enum both derive from the same module, so they cannot
> diverge from what the endpoint advertises. `location_ping` (mentioned in earlier drafts of
> this doc) never shipped as a registered type — location is an event-lane stream (§5), not an
> artifact type. Streams (below) remain design-only; the event lane and `POST /api/v1/events`
> are still deferred (§1.4, roadmap Milestone 0).

Registered artifact types (v1), each with planner policy `{default_searchable, digest_eligible}`:

| type | default_searchable | digest_eligible |
|---|---|---|
| `note` | true | true |
| `message` | true | true |
| `email` | true | true |
| `document` | true | true |
| `photo` | true | true |
| `video` | true | true |
| `contact` | true | false |
| `post` | true | true |
| `dev_session` | false | true |
| `visit` | false | true |
| `listening_session` | false | true |
| `browsing_session` | false | true |
| `digest` | true | false |

Ambient session types (`visit`, `listening_session`, `browsing_session`) default out of search per
the §5 retrieval policy but are digest-eligible — they're exactly what a daily digest
summarizes. `dev_session` joins this default-out set (#244) — a coding-session summary is
dev-workflow noise for an ordinary personal recall, same treatment as the other ambient types;
still fully searchable via an explicit `types:['dev_session']` filter. `contact` is reference
data, not a daily event, so it's not digest-eligible; `digest` itself is excluded from
digest-eligibility to avoid recursive summarization.
`default_searchable` *is enforced* by `hybridSearch` (#121): a search with no `types` filter is
restricted to the `default_searchable:true` set, so ambient session/visit artifacts never pollute
ordinary recall — they surface only when their type is named explicitly (`types:['visit']`).
`digest_eligible` is likewise enforced by the timeline's per-day digest substitution.

Registered event streams (v1): `music`, `browsing`, `location`, `terminal`.

Rules:

- Unregistered types must be prefixed `x-` (e.g., `x-dream-journal`). Accepted with a warning; the type is write-only by default — it is excluded from every untyped search (`default_searchable: false`) and only reachable via an explicit `types` filter naming it (see the last bullet below). If an `x-` type proves broadly useful, it gets promoted into the registry in a minor version — the `x-` name remains accepted as an alias forever. `src/ingest-types.js` exports `isRegisteredType()` / `isExtensionType()` for this check; accept-with-warning handling at ingest is a later issue.
- The registry is machine-readable at `GET /api/v1/ingest/types` so connectors can self-check at startup. Since `x-` types are unregistered by design, there's no static list for them — the same endpoint's `extension_types` field (`[{type, count, default_searchable: false}]`) reports which ones actually exist in the store, derived from `artifacts` at read time (#244) — a `GLOB 'x-?*'` SQL prefilter (index-backed prefix scan) narrowed by an exact `isExtensionType()` JS filter, since GLOB alone can't express "one or more of `[a-z0-9-]`" and would let e.g. `x-Foo_Bar` through. The MCP `list_types` tool surfaces the same registry + extension_types for an MCP-only caller.
- Types carry planner policy (default-searchable: yes/no; digest-eligible: yes/no) — one more reason the vocabulary is governed rather than free-form.
- The MCP `store_memory` tool accepts an optional `type`: `"note"` (default) or an `x-` extension marker (#244) — **not** an arbitrary registered type, since `store_memory` only ever writes a freeform manual note (no `source_id`/`extra_json`/`raw_path`/`occurred_at`); letting a caller mint a `"contact"` or `"digest"` row through this path would produce a structurally-hollow artifact under a type that assumes real structure. A caller needing a different registered type, an upsert key, or structured `extra` still goes through `POST /api/v1/ingest`. `POST /api/remember` (the legacy REST note-store) is unchanged — always `type: 'note'`.
- The write and discovery sides alone would leave an `x-` memory **write-only** — recoverable only by a known artifact id. So the caller-facing `types` filter on the MCP `search`/`timeline` tools and the REST `/api/search`/`/api/timeline` routes also accepts an `x-` extension type (not just the registered enum), letting an explicit `types: ["x-dev-note"]` read a marker back. The query planner's own type inference (`PlanSchema` in `src/search.js`) is unaffected — it still only ever infers a registered type from query text; only an explicit caller-supplied filter may name an `x-` type.

---

## 7. Connector Lifecycle Conventions (guidance, not enforcement)

The core doesn't run connectors, but reference connectors follow these patterns and community connectors should too:

- **Trigger patterns** — three shapes cover everything: **watch** (react to a file/db changing: `chat.db`, a Documents folder), **poll** (ask on an interval: now-playing, an IMAP inbox), **push** (something else initiates: a Claude Code hook, an iOS Shortcut, a browser extension). These are implementation styles, not API concepts — the wire looks identical.
- **Cursor state** — incremental connectors need a high-water mark ("last ROWID synced"). Keep it in a local file next to the connector, *or* use the optional `GET/PUT /api/v1/sources/:source/state` blob store so the cursor lives with the brain and survives connector-machine reinstalls. Either is contract-conformant.
- **Backoff & batching** — batch endpoint for backlogs (100/call), single ingest for live trickle. Respect 429s with exponential backoff. Rate limit is per key. **Batch against the endpoint's BYTE cap, not just its item cap** (#405): the ingest envelope's 1–100 item ceiling is a count, but the server enforces a request-body byte limit (`JSON_BODY_LIMIT`) underneath it, and a connector whose per-item payload size varies (e.g. an uncapped raw-body field alongside a bounded summary) can build a batch that is well under the item cap yet over the byte cap. Pack by measuring each item's own serialized size against a byte budget set with headroom below the server's limit, closing a batch on whichever bound — items or bytes — comes first; use ONE packing function for every place a connector forms a batch (a live path and a spooled-retry path that pack independently is exactly how the reference `email` connector's two paths drifted apart). Treat a `413` as "this batch was too big," not "this request is invalid" — split it and retry the halves rather than discarding it, and if a single item alone still 413s, it can never fit any batch and should be set aside (never silently dropped) rather than retried forever.
- **A spool flush must never be able to block a connector's forward progress** (#405). A connector that spools a failed batch and flushes the spool on its next run must treat that flush as best-effort: a batch that fails again (the same error that put it in the spool) should be logged and left in place, not thrown — and importantly, the flush must not be positioned so that its failure prevents the connector from doing its OTHER job (reading/observing new source data) on that run. The reference bug (`email`, #405): a permanently-failing spooled batch was `await`ed, unguarded, before the mail read — so one bad batch made every subsequent run exit non-zero having read zero new mail. A spool is a retry queue, not a gate.
- **Per-connector API keys** *(core roadmap item)* — v1 ships with the single `LIFECONTEXT_API_KEY`; a follow-up adds named keys with per-key `source` binding and revocation, so a leaked phone Shortcut key can be killed without rotating the brain. The contract is written assuming this arrives; connectors shouldn't share keys across devices.
- **Failure posture** — a connector that dies must lose at most its uncommitted cursor window. Never buffer unbounded in memory; never require the brain to be up to *observe* (queue locally, flush on reconnect) if the source data is ephemeral (now-playing is ephemeral; `chat.db` is not, so the iMessage connector can simply do nothing while the server is down).

---

## 8. Versioning & Compatibility Promise

- The path is versioned: `/api/v1/…`. Within v1: **fields are only ever added, never removed or repurposed**; new registered types/streams may appear; warnings may appear on previously-silent payloads. Nothing that validates today will 422 tomorrow.
- Breaking changes get `/api/v2/…` and v1 keeps working for a deprecation window of **no less than 12 months**.
- **Live.** The payload schema is published as JSON Schema in the repo
  ([`schemas/ingest.v1.json`](../schemas/ingest.v1.json)) — connectors can validate in CI
  without a live server. It's generated from `IngestPayloadSchema`
  (`src/ingest.js`, via zod v4's `z.toJSONSchema()`), not hand-written, so it cannot drift
  from what the endpoint actually enforces; regenerate it with `npm run schema:ingest`
  after any change to that schema (regeneration should produce zero diff otherwise — that's
  the review check). One known gap: the `type` field's registry/`x-`-extension check
  (§6) is a runtime `refine()` that JSON Schema can't express, so the generated schema
  accepts any non-empty string for `type` — every other constraint (required fields,
  `content_hash` format, strict rejection of unknown top-level keys) is enforced exactly
  as the server enforces it.

This promise is the whole reason a stranger can put a LifeContext URL in an iPhone Shortcut and trust it across upgrades.

---

## 9. Reference Connectors (the contract's first three consumers)

Each reference connector doubles as the canonical example of one trigger pattern:

| Connector | Pattern | Sketch |
|---|---|---|
| **`devsession`** | push | Claude Code `SessionEnd` hook → reads transcript path from hook stdin → local LLM (LM Studio) synthesizes a summary → `POST /ingest` as `type='dev_session'`, `source_id` = CC session UUID, `extra` = {project, cwd} |
| **`imessage`** | watch | Mac Mini script watches `~/Library/Messages/chat.db` (WAL-safe read-only attach) → decodes `attributedBody` where `text` is NULL → alias hints from handle table (phone/email) → forwards to the Windows server's LAN IP. The hub-and-spoke topology is *just configuration* — same connector, different base URL. Note this one connector emits two types: `message` for texts, `photo` for attachments — the many-types-per-connector case that motivated the naming |
| **`photo-exif`** | batch | One-shot/cron scan over the photo archive → `exifr` for `DateTimeOriginal` + GPS → `POST /ingest/batch`, `text_repr` = minimal ("Photo taken 2019-03-04"), `latitude`/`longitude` submitted raw (core resolves `place_label` server-side — see §3), `content_hash` for dedup across re-imports. The VLM caption worker later *upserts the same `(source, source_id)`* with an enriched `text_repr` — the contract's upsert semantics are what let enrichment arrive in waves |
| **`email`** | batch | One-shot backfill of **sent** mail from a local mbox/maildir store that a desktop mail client synced over its own OAuth2 — so the connector holds no mail credential and opens no mailbox socket. Two firsts worth copying: it is the first connector whose **acquisition step is an external application** rather than its own client, and the first to use **`POST /api/v1/exists`** (#198) as its idempotency primitive instead of a cursor, because a mail store has no monotonic ordering to page through. `source_id` is derived from the RFC 5322 `Message-ID` **so that a second, independent path over the same mail converges on one artifact** rather than duplicating it. Sent-only is a safety boundary: mail the owner wrote is not attacker-controlled, so its text can be stored and later replayed into an agent's context, which inbound mail cannot be until a provenance/fencing mechanism exists. **Body extraction is MIME-aware and connector-side (`mime.js`, #362)** — turning the raw RFC 5322 body region (boundaries, part headers, `Content-Transfer-Encoding`, `charset`) into the prose that becomes `text_repr` is exactly the §1.2a / connector-conventions hard-rule-2/3 case: a modality→text transducer that exists only because this source's wire format demands it, so it lives with the connector that parses that format, not in core. Core still owns the vector: the connector hands over plain text only, never an embedding. **Quoted reply chains are stripped from `text_repr` (`quotes.js`, #386)** — a reply's thread identity travels forward as `in_reply_to`/`references` in `extra` (present only when the RFC 5322 headers carry them) rather than by duplicating a correspondent's already-embedded words into every later message in the thread; the complete pre-strip body is retained, unembedded, in `extra.body_full`. **A connector using `POST /api/v1/exists` as its idempotency primitive must also offer a re-submit path, or it forfeits the enrichment-wave semantics §9 describes** (#374): `exists` answers "is this `source_id` stored", never "did the payload change" — only core can answer that, and only if the payload is submitted, so filtering on `exists` discards the comparison before it can happen. Silently: the run reports `already-stored`, exit 0. This connector's escape hatch is `--reingest`/`EMAIL_REINGEST`, which keeps the cheap default for a first backfill while making a deliberate heal possible |

Near-term community-obvious connectors that need **zero core changes** once this ships: iOS Shortcut brain-dump (push), now-playing (poll→events), browser reading history (push→events), shell history (watch→events), platform data-dump importers (batch).

---

## 10. Distribution

- Connectors live in **`connectors/` in this repo** — one folder per connector, any language/license per folder, each self-contained (own `package.json`, own `README.md`, own `.env`). *(Supersedes the earlier standalone `life-context-connectors` monorepo, folded back in by issue #49 with full history: with a single maintainer, two repos meant two issue trackers, duplicated agent tooling, and cross-repo sync — cost without payoff, since neither split trigger had fired.)* The repo boundary was never the architectural boundary — **the HTTP contract is**: no connector imports from `src/`, mechanically enforced by `npm run check:boundary`. **Split a connector into its own standalone repo the moment it needs an independent release cadence or an external contributor wants to own just that one** (`git subtree split --prefix=connectors/<name>`) — that's the trigger, not a timeline.
- Discovery via a curated **`awesome-life-context-connectors`** list: name, platform (path under `connectors/`, or its own repo post-split), pattern, data it reads, where the data goes (should always be "your LifeContext server, nothing else" — connectors that phone home don't get listed).
- No certification, no review pipeline, no plugin store. The contract's structural guarantees (hints not IDs, upsert, event lane, payload validation) are the safety model; curation is just a README.

---

## 11. Open Questions (deliberately unresolved in v1)

- **Deletion/tombstones (artifacts)** — when a source deletes an item (a recalled message, a deleted photo), should connectors be able to propagate that? Leaning yes-eventually via `DELETE /api/v1/ingest/:source/:source_id`, but the memory-system philosophy ("memories don't un-happen") argues for a `superseded` flag over hard deletes. Deferred. **Partially resolved for entity aliases (#111):** a UI-removed contact alias now records an `alias_tombstones` row so an additive re-import/edit/hint can't silently resurrect it (an explicit re-add clears it) — the alias sub-case of "represent that a value is no longer known" is handled; artifact-level deletion/supersession is still deferred.
- **Connector-supplied embeddings** — explicitly rejected for v1 (breaks the model-swap freedom in §3); revisit only if a connector emerges with a genuinely better representation (e.g., CLIP for visual similarity — which doc 03 §3.3 already scopes as a *core* second index, not a connector concern).
- **Backpressure on the event lane** — is a per-stream events/day cap needed, or is rate limiting enough? Wait for real abuse before adding knobs (lazy-branching doctrine).
- **Per-connector keys** — committed direction (§7), unscheduled.
