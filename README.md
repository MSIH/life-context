# LifeContext

*(formerly Open Brain Local)*

[![CI](https://github.com/MSIH/life-context/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MSIH/life-context/actions/workflows/ci.yml)

A local-first, self-owned memory layer that any AI tool can plug into — one database, one gateway, running entirely on your own machine. LifeContext stores your notes, contacts, and (soon) emails, photos, and location history as a unified memory your AI assistants can actually recall from: by meaning, by person, by place, and by time.

## Origins & lineage

LifeContext began as an independent, local-first implementation of the "Open Brain" concept introduced by Nate B. Jones. Nate's reference implementation, **OB1**, lives at <https://github.com/NateBJones-Projects/OB1>.

The project has grown in two stages:

1. **The port** — a faithful local re-implementation of the Open Brain idea (one memory store, any AI plugs in via MCP), swapping OB1's cloud stack (Supabase + edge functions) for a fully local one: SQLite + sqlite-vec, a single Node.js server, and Ollama for embeddings. That version (pre-0.2.0) is **no longer available**: this repository's history was squashed to a single commit to purge personal data that had been committed into test fixtures and doc examples, and the pre-squash history is retained privately.
2. **The evolution** — the living codebase on the default branch. Memories became **artifacts** (events with time, place, and a text representation), backed by an **entity graph** with contacts as the spine, and **hybrid retrieval** (vector + keyword, fused and planned by a small local LLM). The roadmap adds pluggable "senses" — email, documents, photos, location — feeding the same stable core.

The project was renamed from Open Brain Local to LifeContext to avoid confusion with OB1's identity as that divergence grew.

## How this repository is maintained

Day-to-day development happens in a private repository; this one receives reviewed snapshots. So there are no feature branches or pull requests here, and commits arrive in batches rather than continuously — that is the intended shape, not a stalled project.

The reason is specific to what LifeContext is: it is a memory server for its author's real contacts, mail, photos, and location history, and it is developed by dogfooding it against that real data. Several times, real personal values — including a third party's name — reached this public repository through test fixtures and documentation examples written from the live store. A review boundary between development and publication makes that class of mistake recoverable instead of permanent.

Issues and pull requests are welcome. They are triaged into the private repository, so a fix may land in a later snapshot rather than as a direct commit against your report.

## Relationship & license

This project is **not affiliated with, endorsed by, or officially connected to** Nate B. Jones or OB1. It is a clean-room reimplementation of the *concept* — a single, user-owned knowledge/memory store that multiple AI tools share (for example, over the Model Context Protocol) — and it does **not** fork or redistribute OB1's source code. Where OB1 targets free-tier cloud services, LifeContext targets a fully local stack: a local database, a local AI gateway, and no SaaS dependency.

"Open Brain" and "OB1" remain the work of their author. The code in this repository is licensed under the [MIT License](LICENSE); refer to the OB1 repository for its own license terms.

## Concept

Every AI tool keeps its own siloed memory, so each new chat or tool starts from zero. LifeContext flips that around: **you** own one memory store, and every AI plugs into it — with your data and the gateway staying on your machine.

## Quickstart

Runs fully local — no cloud. Requires [Node.js](https://nodejs.org) 18+ and [Ollama](https://ollama.com/download).

```bash
# 1. Install dependencies (Ollama must be installed and running)
npm install
npm rebuild better-sqlite3        # only if npm skipped its native build

# 2. Bootstrap: pulls the embedding model (+ optional query model) and writes .env with a
#    random LIFECONTEXT_API_KEY. Idempotent — safe to re-run; never overwrites an existing .env.
npm run setup

# 3. Run
npm start                         # REST + MCP on http://localhost:3000
```

**Developing against your data?** Use `npm run dev` — it boots a second server on `:3001` against a **copy** of `life-context.db` (`.dev.db`, a consistent online snapshot), so tests never write your live memory. Add `-- --fresh` to re-copy. A *brief* overlap — a connector POSTing while a backfill or `npm run migrate` runs — now waits up to `DB_BUSY_TIMEOUT_MS` (default 5s) for the lock instead of throwing `SQLITE_BUSY` instantly. But still **never** run a second long-lived `npm start` / `node src/server.js` against the live DB — two servers sharing the vec/FTS state cause locks the timeout can't paper over. Every instance logs its resolved DB file at boot, so a mis-pointed one is obvious.

`npm run setup` prints the generated `LIFECONTEXT_API_KEY` once — **save it**; it's the `x-api-key` header for every call. Prefer to do it by hand? The manual equivalent (pull `qwen3-embedding:0.6b` + `qwen2.5:3b`, `cp .env.example .env`, set a key) is in [`docs/local-llm-setup-guide.md`](docs/local-llm-setup-guide.md).

**Tests & CI.** `npm test` (`node --test test/*.test.mjs`) runs the full suite — no Ollama needed (the embedder/planner-offline paths degrade gracefully). Supported runtime is **Node 22+** (`engines` in `package.json`); Node 21+ expands the `test/*.test.mjs` glob natively, so only an older runtime needs a globbing shell (any Unix shell, or **Git Bash** on Windows — not `cmd.exe`/PowerShell). `npm run check:boundary` asserts connectors never import `src/`, and `npm run test:connectors` runs each connector's own suite (skipping any whose deps aren't installed).

The [CI workflow](https://github.com/MSIH/life-context/actions/workflows/ci.yml) has two postures. The **`checks`** job always runs on every PR and push to `main`: the four deterministic gates (hook-layer liveness, connector boundary, schema literal, private-reference sweep) and no tests — it needs no `npm ci`, so it finishes in seconds. The **`test`** job is **opt-in**, since the suite already runs locally before every PR: label a PR `ci:test` for one cell (Ubuntu × Node 26) or `ci:lts` to add Node 24 and 22, or run the workflow manually (**Actions → CI → Run workflow**) and pick `default` / `lts` / `full` (`full` adds a Windows × Node 26 cell). Recommended: enable branch protection on `main` requiring **`checks`** — never a `test (<os>, <node>)` cell, since those are conditional and a required check that never runs would leave an unlabelled PR blocked forever.

Upgrading from an earlier version? Migrate your existing memories into the artifact store once (back up your DB file first — `life-context.db` by default, or whatever `DB_PATH` points to — it's idempotent and safe to re-run). It reuses the stored vectors as-is, so it's only valid while the embedding model and `VECTOR_DIMENSION` are unchanged:

```bash
npm run migrate                   # copies memories -> artifacts (type='note'), reusing vectors
```

Seed the entity graph from your contacts (people become searchable and future emails/photos link to them). Clean them up first — see [`docs/08-preparing-contacts.md`](docs/08-preparing-contacts.md) for the pre-clean checklist and why it matters:

```bash
npm run import:contacts contacts.vcf
```

Any embedded contact photo is decoded and preserved to `CONTACTS_RAW_DIR` (default `raw/contacts`, override in `.env`) — the future seed for face-recognition-based photo↔contact linking.

Re-running `import:contacts` on an **edited** vCard updates that contact in place (#94): a UID-matched card whose content changed is re-embedded and its searchable text refreshed (new emails/phones/nicknames become additive aliases); an unchanged card is skipped with no work. The imported photo and the entity profile you edit in the contacts UI are left untouched — the UI owns the profile. Summary line, e.g. `Contacts import complete: 0 added, 2 updated (0 new entities, 0 photos preserved), 5 skipped, of 7 vCards.`

Phone numbers are matched by a canonical key (#129): US/Canada numbers written with a `+1` country code (`+1 (415) 555-0148`) resolve to the same contact as the bare 10-digit form (`(415) 555-0148`) — punctuation, spacing, and the `+1` all normalize away. Contacts imported before this change are re-aliased under the canonical key by `npm run backfill:phones` (additive and idempotent — back up `life-context.db` first).

A contact's **display name defaults to first + last** (#156): a card with a middle name (`Amy Margaret Fenwick`) is stored and shown as `Amy Fenwick`, while the full name is kept as a searchable alias — so search/timeline read cleanly without losing resolution by the full name. Contacts imported before this change are shortened by `npm run backfill:display-names` (idempotent; back up `life-context.db` first).

**Side contact directory (#154).** To keep the entity graph *curated* while still recognizing everyone, load your full contacts export as a lookup-only directory — it creates **no** entities:
```bash
npm run directory:load contacts.vcf        # handle -> name lookup + one card per contact; NO entities created
npm run backfill:directory-proposals       # stage historical unknown handles AND names for review
npm run backfill:directory-attrs           # fill EMPTY profile fields on existing contacts from their card
```
**Browse it and promote who you want (#299).** The contacts UI's **Directory** panel lists the loaded roster **ordered by impact** — how many artifacts promoting each name would retro-link — so the people you actually have history with come first instead of whoever is alphabetically unlucky. Search by name, phone, or email; promote one row or tick several and promote in bulk. Promoting mints the contact with all of that name's handles (plus the full card profile, above), links its staged history in the same call, and greys the row as done. This is the primary route into the graph and needs no proposal: the directory is your own export, so browsing and clicking *is* the approval. Same thing over REST: `GET /api/v1/directory` and `POST /api/v1/directory/promote` (see [`docs/09-contacts-ui.md`](docs/09-contacts-ui.md)).

Separately and automatically, a **handle** that misses the curated graph but matches the directory is (a) **auto-labeled** in search/timeline (`Message from Jane Doe (number)` — display only, no entity), and (b) **staged in the proposed-entities review queue** with the name pre-filled. Since #301 that staging also covers **person names**, not just handles: the photo connector tags a photo with the person from its folder name (`alias_type:'name'`), and a name the directory knows now stages a proposal too — so `backfill:directory-proposals` surfaces *photographed people*, not only phone numbers. An **ambiguous** name (two different cards share it) stages nothing rather than guessing. Auto-labeling stays handle-only by design — recognizing person names in prose would mean false positives on ordinary words. Approving a proposal promotes it into the curated graph and links its history; rejecting silences it until you reopen it (#300 — a rejected proposal can be flipped back to pending, singly or in bulk, from the contacts UI's Proposed panel; an approved one is terminal). Promotion is always your call — the directory never auto-creates a contact. vCard (`.vcf`) only for now.

**The directory keeps each card's full profile (#304),** not just the handle→name pair: addresses, birthday, anniversary, org/title, urls, and nicknames are stored per card (keyed by its vCard `UID`, else a hash of the card) — the data the parser already produced and previously discarded. Two consequences: a directory entry promoted into the graph arrives with a real profile instead of an empty one, and `npm run backfill:directory-attrs` enriches contacts you imported *before* this existed. That backfill only ever writes a field the contact leaves **empty** — a value you typed always wins, and it never touches the display name, aliases, relationships, or photo. Precedence: user-typed > existing non-empty > directory. Re-loading an export is idempotent and **append-only**: a new address or url is merged in, while a *differing* birthday keeps the stored value and records the conflict in `ingest_log` rather than overwriting it. An existing directory gains cards only on a **re-load** — `npm run directory:load` against the same export, which also links your already-loaded handles to their new cards (back up `life-context.db` first, as with any backfill).

The staging step (`backfill:directory-proposals`) also runs from the browser (#162): the **Stage from directory** button in the contacts UI's *Proposed* drawer re-runs the same idempotent pass against the loaded directory and refreshes the queue — so you never have to drop to a shell after loading a directory.

**Ingest order.** There are two tiers, not a five-step chain: **Tier 1 — contacts** (they seed the entity graph); **Tier 2 — everything else** (photos, emails, documents, texts), in *any* order. Tier-2 sources link to *entities*, never to each other, so nothing among them depends on the rest. Contacts-first is a recommendation, not a hard constraint: an artifact ingested before its contact exists is still stored and fully searchable (by meaning, keyword, time, place) — only the person link is deferred, and it forms automatically when that contact is later imported (see [`docs/08-preparing-contacts.md`](docs/08-preparing-contacts.md#ingest-order--what-happens-on-a-no-match)).

Real imports are messy. Curate contacts — fix emails/phones/addresses, set a photo, and wire up relationships (spouse/parent/child/`worksAt`) — in the browser. **The web UI is token-only (#169):** it is served **only** when `UI_URL_TOKEN` is set in `.env`, and **only** at a bookmarkable capability URL — `http://localhost:3000/<token>/ui/contacts.html` (and `/<token>/ui/chat.html`), token-first, matching the MCP `/<token>/mcp` URL. The page reads the token from its own path and authorizes with **no manual key entry** (there is no API-key bar). With `UI_URL_TOKEN` unset the UI is **disabled** — `/ui/*` and `/<anything>/ui/*` all 404 — so a Cloudflare Tunnel can never expose the page without an explicit token (localhost dev needs a token too — the fail-safe default). See [`docs/09-contacts-ui.md`](docs/09-contacts-ui.md), and [`docs/07`](docs/07-cloudflare-tunnel-setup.md#opening-the-browser-ui-remotely-capability-url) for the URL-leak tradeoff and the Cloudflare Access recommendation.

Consolidate each day's artifacts into one searchable daily digest (schedule it nightly — see [`docs/06-consolidation.md`](docs/06-consolidation.md)):

```bash
npm run consolidate               # yesterday; `-- --date=YYYY-MM-DD` or `-- --backfill=N` for history
```

Smoke test (`$KEY` = your `LIFECONTEXT_API_KEY`):

```bash
curl -s -X POST localhost:3000/api/remember -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"content":"My sister Sarah lives in Austin."}'
curl -s -X POST localhost:3000/api/recall   -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"query":"where does my sister live"}'
```

Recall returns the stored memory with a similarity score. For AI clients, point an MCP-capable tool (Claude Desktop, Cursor, …) at `http://<host>:3000/mcp` with an `x-api-key` header to get the memory tools. Clients that can only take a bare URL (some MCP setups, gemini/VS Code extensions) can pass the key as a `?api_key=<key>` query param instead (`http://<host>:3000/mcp?api_key=$KEY`) — the header is preferred; the query param leaks the key into logs and history (see [`docs/07`](docs/07-cloudflare-tunnel-setup.md#part-c--point-your-ai-tools-at-it)), and it does **not** work for the Claude.ai web connector (the MCP spec forbids query-string tokens — web needs header auth or OAuth).

**Access logging (#178).** Every `/api`, `/mcp`, and `/ui` request appends one metadata line to a daily file `logs/access/access-YYYY-MM-DD.log` (UTC) — method, redacted path, status, real client IP, latency, surface (`api`/`mcp`/`ui`), and auth outcome, e.g. `2026-07-15T13:40:12Z api POST /api/search 200 842ms ip=203.0.113.7 auth=ok`. Secrets are **redacted** before writing (the `?api_key=` query value and any capability path token — `/<token>/mcp`, `/<token>/ui/…` — become `<redacted>`/`<token>`) and **request bodies are never logged** (metadata only). Failed-auth probes (`401`, a wrong capability-token `404`, a rate-limit `429`) are also surfaced to stderr so brute-force attempts against an internet-exposed instance are visible. On boot the server prunes files older than `ACCESS_LOG_RETENTION_DAYS` (default 90) and, on Windows, NTFS-compresses the folder so the text logs cost a fraction of the disk. Toggle with `ACCESS_LOG_ENABLED` / `ACCESS_LOG_DIR` / `ACCESS_LOG_RETENTION_DAYS` in `.env` (see [`docs/07`](docs/07-cloudflare-tunnel-setup.md#access-logging-what-gets-recorded)).

## Interfaces

Every endpoint/tool requires the key, sent as the `x-api-key` header (or `Authorization: Bearer`, or — for clients that can't set headers — an `?api_key=` query param; header preferred, see the caveat above). REST and MCP share one store.

- **REST** — `POST /api/remember`, `POST /api/recall`, `POST /api/search`, `POST /api/timeline`, `POST /api/about_entity`, `GET /api/artifact/:id`
- **Entity curation** (`/api/v1/entities`, core-owned — never via a connector, see [`docs/03-ob2-design.md §7`](docs/03-ob2-design.md)) — `GET /api/v1/entities/duplicates` (rank likely-duplicate person entities by shared phone/email + name similarity; also reports `dismissed_count`), `POST /api/v1/entities/merge` (`{keep_id, absorb_id}` — tombstones the absorbed entity, never deletes it, and re-points its aliases/links/relations to the survivor), `POST /api/v1/entities/duplicates/dismiss` + `DELETE …/duplicates/dismissals` (#302 — mark a candidate pair "not a duplicate," absolute until an explicit clear-all; `list_probable_duplicates` hides a dismissed pair), plus the contacts-UI CRUD surface — list/get, create, `PATCH` fields, add/remove aliases & relationships, and photo upload/download (all under `/api/v1/entities`, see [`docs/09-contacts-ui.md`](docs/09-contacts-ui.md)). The **proposed-entity review queue** (the approval gate for *suggested* entities — a connector/agent suggestion is never minted unapproved; trusted direct creation via `POST /api/v1/entities` is the separate curation path): `GET /api/v1/entities/proposed`, `POST /api/v1/entities/proposed/:id/approve`, `POST …/proposed/:id/reject`, `POST …/proposed/:id/reopen` + bulk `POST …/proposed/reopen` (#300 — rejected → pending, `409` on anything else), `POST …/proposed/stage-from-directory` (#119/#154), plus `GET /api/v1/entities/photos` (the face-match photo source, #112). A browser UI over these lives at `/<token>/ui/contacts.html` (token-only, #169 — see the curation note above).
- **Connector ingest** (`/api/v1`, see [`docs/04-connector-contract.md`](docs/04-connector-contract.md)) — `POST /api/v1/ingest` (submit one artifact; upsert on `(source, source_id)` — 201 create / 200 update, non-destructive issues accepted with a `warnings` array, 256 KB body cap), `POST /api/v1/ingest/batch` (submit 1–100 artifacts in one call; 200 with index-aligned per-item results + a `summary`, per-item isolation — one bad item is reported at its index, never poisons the rest), `GET /api/v1/ingest/types` (the machine-readable type registry, plus `extension_types` — the `x-` types actually observed in the store, with counts, §6). The payload's JSON Schema is published at [`schemas/ingest.v1.json`](schemas/ingest.v1.json) (generated from the zod schema via `npm run schema:ingest`) so connector authors can validate offline, without a live server:

  ```bash
  curl -s -X POST localhost:3000/api/v1/ingest -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{
    "source":"imessage","source_id":"chat.db:msg:88213","type":"message",
    "text_repr":"Text from Sarah Jones: Landed! See you at the gate.",
    "occurred_at":"2026-07-04T18:22:09Z",
    "latitude":30.2672,"longitude":-97.7431,"place_label":"Austin-Bergstrom Intl",
    "entity_hints":[{"alias":"+15550142","alias_type":"phone","role":"sender"}]}'

  curl -s -X POST localhost:3000/api/v1/ingest/batch -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{
    "artifacts":[
      {"source":"photo-exif","source_id":"IMG_0001.jpg","type":"photo","text_repr":"Photo taken 2019-03-04 near Austin, TX"},
      {"source":"photo-exif","source_id":"IMG_0002.jpg","type":"photo","text_repr":"Photo taken 2019-03-04 near Austin, TX"}]}'
  ```
- **MCP** (Streamable HTTP) — `/mcp`, tools:
  - `store_memory` / `search_memories` — the original note store + recall (unchanged on the wire); `store_memory` also takes an optional `type`, `"note"` (default) or an `x-` extension marker (e.g. `"x-dev-note"`), to write dev/personal-isolating memories directly through MCP, and an optional `occurred_at` (ISO 8601, #436) for when the remembered thing actually happened, as opposed to when it was typed — a malformed value is rejected, not silently dropped; omit it and it stays NULL exactly as before, and `timeline` still surfaces the memory by falling back to when it was stored (see below). Other registered types are rejected — `store_memory` only ever writes a freeform manual note (no `source_id`/`extra`), so a caller needing a real `photo`/`contact`/`digest` row (or an upsert key) still goes through `POST /api/v1/ingest`
  - `list_types` — list the registered type vocabulary plus any `x-` extension markers observed in the store, so a caller can discover what to pass to `store_memory`'s `type` or `search`'s `types` instead of hardcoding a convention
  - `search` — hybrid semantic + keyword search with optional `types` / `time_range` / `entities` filters, plus `near` (a place name or `{lat, lon}`) + `radius_km` for geo-radius search — surfaces artifacts within the radius by coordinate, catching nearby places the label text doesn't literally name (e.g. `near: "San Francisco"` finds a Sausalito photo). "Where / last seen" wording is also handled by the query planner: a *where … was X last seen* query with no place named restricts to geotagged artifacts and orders them most-recent-first, so the top hit is the location the person was last seen (#190) — degrading to a normal relevance search when nothing is geotagged. `types` also accepts an `x-` extension marker (e.g. `types: ["x-dev-note"]`) to read back a `store_memory`-tagged marker that's otherwise excluded from an untyped search (#244) — the query planner's own type inference stays registered-types-only, so only an explicit filter can name one. Both the REST response and the tool's text output carry a deterministic `summary` (#353) over the **full** matched set (not just the returned page) — total count, a per-type breakdown, contiguous date "visits," and top places/people — never LLM prose; the tool text leads with one rendered line, e.g. `55 photos · Ocean City, Maryland · 2 visits: 2019-07-28–30, 2021-06-05`. A caller that already knows every filter it needs can pass `use_planner: false` (default `true`, #433) to skip the LLM query-planner call entirely — a ~7s-plus win on this box — while still gap-filling `types`/`place` from a literal word in the query text (the same deterministic pre-pass, #352); omit it for a natural-language query where you want the planner's inference.
  - `timeline` — chronological recall over a date range; `types` accepts an `x-` extension marker too, same as `search`. Sorts and range-filters by `occurred_at`, falling back to `ingested_at` when `occurred_at` is NULL (#436) — so a `store_memory` write without an explicit `occurred_at` still shows up, on the date it was stored, instead of being silently excluded from every range
  - `about_entity` — resolve a person/place/org and return their profile, recent linked artifacts, and person↔person relations (spouse, child, parent, …)
  - `get_artifact` — one artifact's full text, metadata, and entity links by id
  - `list_probable_duplicates` / `merge_entities` — surface and merge likely-duplicate contacts (30 years across Google/Yahoo/iPhone rarely dedup perfectly); merge tombstones the absorbed entity rather than deleting it. A pair dismissed as "not a duplicate" via the REST-only `POST/DELETE /api/v1/entities/duplicates/{dismiss,dismissals}` (#302 — no MCP tool; a human recovery action) stays hidden here too, since both read paths share `list_probable_duplicates`
  - `propose_entity` — suggest a NEW entity (person/org/place/event — e.g. a broker or agent you learned about) for review; stages a *pending* proposal, never mints, so a human approves it (`list_proposed_entities` / `approve_proposed_entity` / `reject_proposed_entity`, or the contacts UI "Proposed" panel). Idempotent — re-proposing the same one is a no-op. REST equivalent: `POST /api/v1/entities/proposed`. This is the only way an agent adds to the graph, and it can't do so unapproved
  - `add_relationship` — link two entities that **already exist** (e.g. a person `worksAt` an org): `from`/`to` are each a name (resolved) or a numeric id, plus a canonical `relation_type` (worksAt, spouse, manager, …) or free-text `raw_label`. Directional (from → to); idempotent; ungated (both endpoints already passed approval). If an endpoint doesn't exist yet, `propose_entity` it and approve first. Ambiguous or unknown names error rather than guess

> **Reconnect after a tool changes.** An MCP client fetches this tool list once, when it connects, and caches it. So a **newly added or renamed tool won't appear in a session that was already connected** — the agent will correctly report the tool "doesn't exist." Restarting the LifeContext service updates the *server* but not already-connected *clients*. To pick up a new tool, reconnect the server in each client session (in Claude Code: `/mcp` → reconnect `lifecontext`, or restart the session).

### Connectors write; recall is separate

A connector's only job is to **submit** data via `POST /api/v1/ingest` (or `POST /api/v1/ingest/batch`) — see [`docs/04-connector-contract.md §1.1`](docs/04-connector-contract.md). Installing a connector does not, by itself, make any AI tool *recall* from LifeContext. That's a separate integration you configure on the AI tool's side: point an MCP-capable client at `/mcp` (or use the REST `/api/recall`/`/api/search` endpoints directly) as described above under Interfaces. A connector neither provides nor configures that wiring for you.

## Status

**Phase 2.0 (foundation) — working.** Every memory is now an **artifact** (an event with time, place, and a text representation) in a unified store, backed by an **entity graph** (contacts as the spine) and **hybrid retrieval** (vector KNN + FTS5 keyword search fused with reciprocal rank fusion, planned by a small LLM). Local store → embed (Ollama) → recall works over both REST and MCP; `npm run migrate` brings earlier memories forward, `npm run import:contacts` seeds people.

Feeding the brain is connector-driven: an HTTP ingest contract so anything — a Claude Code hook, an iMessage watcher, a photo-EXIF scan, a document-tree scan — can submit artifacts. The reference connectors live in [`connectors/`](connectors/) (one self-contained folder each; the HTTP contract is their only coupling to core — `npm run check:boundary` enforces it). See the [connector contract](docs/04-connector-contract.md) and the [roadmap](docs/05-roadmap.md).

Location is resolved server-side: a connector submitting raw `latitude`/`longitude` gets a `place_label` filled in automatically, offline, against a bundled dataset (`src/geodata/places.json`, ~135k places) derived from [GeoNames](https://www.geonames.org/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). US labels store the full state name (`Austin, Texas`), so a query like "in texas" matches directly. Regenerate it with `npm run geocode:build -- <path-to-cities1000.txt>` (the `--` forwards the path to the script) after downloading GeoNames' `cities1000.txt` dump (population ≥ 1,000) from <https://download.geonames.org/export/dump/cities1000.zip> — the raw dump isn't committed, only the derived file and `scripts/build-places.js` are. Upgrading an existing DB from the old code-form labels (`Austin, TX`): back up the `.db`, then run `npm run backfill:geo` once (idempotent; re-derives `place_label` from stored coordinates, leaving connector-supplied labels untouched).

Beyond people, the entity graph also has **place** (#137) and **event** (#138) kinds — recurring locations and multi-artifact occasions you can pivot recall around (`about_entity('Deer Valley')`, spend-by-place, "everything from the Tahoe trip"). Both can be minted directly (the `/api/v1/entities` CRUD surface) or discovered bottom-up from photo GPS/time and staged for approval: `npm run places:cluster` grids GPS-bearing artifacts into candidate places, `npm run events:cluster` groups contiguous-day bursts away from home into candidate events — each stages a proposed entity you approve. See [`docs/03-ob2-design.md §2.2`](docs/03-ob2-design.md).

## Design documents

| Doc | What it covers |
|-----|----------------|
| [`docs/03-ob2-design.md`](docs/03-ob2-design.md) | The core design: unified artifact schema, entity graph, hybrid retrieval, query planner, consolidation. Its build-phase table (§6) is superseded by the roadmap below. |
| [`docs/04-connector-contract.md`](docs/04-connector-contract.md) | The connector contract — the versioned HTTP + JSON ingest API (`/api/v1/ingest`) that lets any external process, in any language, feed the brain: artifact payloads, entity hints, the event lane, the type registry, and the compatibility promise. |
| [`docs/05-roadmap.md`](docs/05-roadmap.md) | The current roadmap: sequence-ordered milestones with exit tests — ingest API foundations, the first three reference connectors (`devsession`, `imessage`, `photo-exif`), planner hardening, contract v1 freeze, consolidation, and distribution. |
| [`docs/06-consolidation.md`](docs/06-consolidation.md) | Consolidation v1 — `npm run consolidate`: nightly daily digests (`type='digest'`), regeneration semantics (input-hash skip, derived-only upsert), timeline/planner digest awareness, scheduling snippets. |
| [`docs/07-cloudflare-tunnel-setup.md`](docs/07-cloudflare-tunnel-setup.md) | Remote access on your own domain — beginner-friendly Cloudflare Tunnel setup so phones, other machines, and cloud agents can reach the server (`https://…/api/*`, `https://…/mcp`); no port forwarding. |
| [`docs/local-llm-setup-guide.md`](docs/local-llm-setup-guide.md) | Setting up Ollama and the local models (Windows-focused; Linux notes included). Later steps predate the 2.0 layout — see the notes inside. |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how issues and pull requests are triaged.
