# LifeContext — Consolidation v1 (nightly daily digests)

Implements roadmap Milestone 6 ([`05-roadmap.md`](05-roadmap.md)) from the design in
[`03-ob2-design.md`](03-ob2-design.md) §5 ("the sleep cycle"): one small-model call per day
turns the day's artifacts into a single `type='digest'` artifact, so month-scale questions
("what was I doing last October") answer from ~30 digests instead of hundreds of raw rows.
Code: [`src/consolidate.js`](../src/consolidate.js).

## Run

```bash
npm run consolidate                      # digest for yesterday (local date)
npm run consolidate -- --date=2026-07-07 # one specific day
npm run consolidate -- --backfill=30     # last 30 days ending yesterday, oldest first
```

Needs the Ollama engine on `:11434` with `DIGEST_MODEL` (default `qwen3:8b`) and the embedding
model pulled. Exit 0 on success/skip; non-zero the moment a day fails (LLM/embed unreachable) —
already-completed backfill days stay committed (each day is its own transaction; restartable
like `npm run migrate`).

## What it writes

One artifact per day with digest-eligible inputs:

| Field | Value |
|---|---|
| `type` | `digest` (registered in `src/ingest-types.js`; `digest_eligible: false` — no digest-of-digest) |
| `source`, `source_id` | `consolidation`, `daily-<YYYY-MM-DD>` — the standard dedup/idempotency key |
| `occurred_at` | the day it describes (sorts into that day, not the run date) |
| `text_repr` | `Daily digest — <date>. Worked on: … Talked with: … Was at: … Also: …` |
| `extra_json` | `{ input_hash, artifact_count, truncated, types, model }` |

Inputs = artifacts with `date(occurred_at) = <date>` whose type has `digest_eligible: true` in
the registry (`contact` and `digest` itself are excluded), capped at `DIGEST_MAX_ARTIFACTS`
oldest-first with each `text_repr` clipped to `DIGEST_TEXT_CLIP` chars (`truncated: true` in
`extra_json` marks a capped day).

## Regeneration semantics (idempotent, append-only-safe)

- **`input_hash`** = sha256 over the sorted `(artifact_id, sha256(text_repr))` pairs of the day's
  input set. A re-run whose inputs are byte-identical logs `unchanged … skipped` and makes **no
  LLM or embedding call** — safe to re-run the whole history nightly.
- **Late-arriving or enriched inputs** (a backfilled message, a photo caption upsert) change the
  hash; the re-run regenerates and updates the digest through `upsertArtifactTxn` — the sanctioned
  derived-only update path for an existing artifact: originals untouched, `ingested_at`
  frozen, and the `ingest_log` `ingest_update` row carries the prior `text_repr`, so every past
  wording is reconstructable from the log.
- A day with **zero** eligible artifacts writes nothing (no empty digests).
- Enrich-then-commit holds: digest text and embedding are fetched before the transaction opens;
  an Ollama failure writes no partial rows.
- Every day consolidated appends a `consolidate_daily` row to `ingest_log` (design tenet 3).

## Retrieval awareness

- **Planner** (`src/search.js`): the query-plan prompt steers week/month-scale summary questions
  to `types: ["digest"]`. Safety net: when a *plan-derived* filter matches zero candidates (e.g.
  no digests exist for the period), the search retries with only the caller's explicit filters
  instead of returning empty — the planner can narrow a search, never silently empty it.
- **Timeline** (`src/search.js`): a bounded range spanning ≥ `DIGEST_TIMELINE_DAYS` (default 14,
  inclusive of both ends) with **no explicit type filter** substitutes **per day**: a day with a
  digest is represented by it; undigested days keep their raw artifacts (a partial backfill never
  hides data); types a digest doesn't summarize (`digest_eligible: false`, e.g. `contact`) are
  never hidden. Explicit `types` or open-ended ranges are unchanged.

## Scheduling (config, not code)

Nightly at 02:00, Windows Task Scheduler — register a task that runs `npm run consolidate` once a
day (Action: `npm.cmd`, Arguments: `run consolidate`, Start in: the repo root), on the box that
hosts the live server. Redirect stdout/stderr to a log file yourself (e.g. wrap the action in a
`cmd /c "npm run consolidate >> logs\consolidate-task.log 2>&1"`) — Task Scheduler's own run
history doesn't capture it.

Or as an NSSM-wrapped service with its own schedule, per the roadmap's low-priority worker
posture. macOS/Linux: a `launchd` plist or cron line (`0 2 * * * cd /path/to/life-context && npm run consolidate`).

## Config (`.env`, all optional)

| Key | Default | Meaning |
|---|---|---|
| `DIGEST_MODEL` | `qwen3:8b` | Chat model that writes the digest (any Ollama chat model) |
| `DIGEST_TIMEOUT_MS` | `120000` | Per-call timeout for the digest generation |
| `DIGEST_MAX_ARTIFACTS` | `200` | Max artifacts fed to the model per day |
| `DIGEST_TEXT_CLIP` | `500` | Chars of each artifact's `text_repr` given to the model |
| `DIGEST_TIMELINE_DAYS` | `14` | Timeline spans ≥ this prefer digests over raw rows |

## Known limitations

- **Day grouping is by the stored `occurred_at` string** (SQLite `date()`, no timezone
  conversion) — consistent with every other date filter in the store (`timeline`, the search
  prefilter). Artifacts stored with UTC `Z` timestamps by a connector west of UTC can group an
  evening event into the next day's digest; fixing that is a store-wide timezone policy
  decision, not a consolidation one.
- **Extension types (`x-*`) are not digest-eligible** — eligibility comes from `TYPE_REGISTRY`,
  which only lists registered types. A custom `x-*` connector type is searchable but won't
  appear in digests until it's promoted into the registry.
- **Sub-threshold timelines include digest rows** alongside the raw artifacts they summarize
  (a digest is an ordinary artifact); pass explicit `types` to exclude them.

## Deferred (ships when needed)

- **Weekly/monthly rollups** (design §5 item 3) — after daily digests prove out; rollups read
  daily digests, so nothing here blocks them.
- **Entity refresh** (design §5 item 2 — fold new facts into `entities.attrs_json`) — separate
  consolidation pass, own issue.
- **Event lane + sessionization** — deferred by roadmap M6 itself until an events-producing
  connector exists (lazy-branching).
