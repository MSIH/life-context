# Connectors

Official connectors for **LifeContext** — each is an isolated process that gathers data from one corner of a digital life and submits it to a running LifeContext server over the versioned `POST /api/v1/ingest` contract ([`docs/04-connector-contract.md`](../docs/04-connector-contract.md)). **Nothing here imports LifeContext source or another connector's code** — the HTTP contract is the only coupling point, enforced by `npm run check:boundary` from the repo root.

A connector isn't only a gatherer — it may also include a transducer worker that turns a non-text modality (a photo, a scanned PDF) into `text_repr` via a local model (VLM captioning, OCR); core holds no source-specific knowledge, so that enrichment step lives here too, per doc 04's source-specificity rule (§1.2a).

> Formerly the standalone `life-context-connectors` repo, folded into this repo (with full history) once the two-repo split proved to be overhead without payoff — see doc 04 §10. A connector still splits out into its own repo the moment it needs an independent release cadence or an external owner (`git subtree split --prefix=connectors/<name>`).

## Structure

```
devsession-claude/  Claude Code SessionEnd/PreCompact hook → dev_session artifacts (Milestone 1)
gh-event-claude/    Claude Code PostToolUse hook → x-dev-event artifacts on gh issue/PR create (#89)
documents/          PDF/DOCX/XLSX/PPTX tree scan + tesseract OCR worker → document artifacts (#56)
email/              Sent-mail backfill from a local mbox/maildir store synced by a desktop mail client → email artifacts (#345; sent only — inbound is gated on #346)
imessage/           iMessage chat.db sync → message/photo artifacts (Milestone 3)
photo-exif/         Photo/video library scan (EXIF + Google Takeout sidecars + folder-name person hints) + VLM captioning + local face clustering → photo/video artifacts (Milestone 4; #171 folded the former gphotos-takeout connector in here)
```

Each connector is self-contained: its own `package.json` (dependencies never shared), its own `README.md` (setup, env vars, trigger registration), its own `.env` (gitignored). There is no repo-wide build — these are client processes deployed wherever the source data lives (e.g. `imessage/` runs on a Mac), cloned from this repo.

## Adding a connector

1. New folder under `connectors/`, named after the connector's `source` value (e.g. `imessage/`).
2. Own `package.json` (or equivalent for another language) — no shared dependencies assumed between connectors.
3. Own `README.md` with setup steps and, for push-style connectors, the trigger registration snippet.
4. Talk to LifeContext only via `POST {LIFECONTEXT_URL}/api/v1/ingest` (or `/ingest/batch`) per [`docs/04-connector-contract.md`](../docs/04-connector-contract.md). Validate payloads against [`schemas/ingest.v1.json`](../schemas/ingest.v1.json) for CI-time checking without a live server. Never import from `src/`.

**Conventions, in brief** (full spec: [`docs/04-connector-contract.md`](../docs/04-connector-contract.md)):
- `source_id` must be reproducible from the source data (a provider ID, a file path + mtime, a content hash) — never a random UUID minted at call time, since ingestion is upsert-by-`(source, source_id)`.
- Never compute embeddings; a connector may run a local model to produce `text_repr` (a VLM caption, OCR text), but the vector step is core's job.
- Submit entity hints (`{alias, alias_type, role, confidence?}`), never entity IDs — resolution against the entity graph is core's job.
- A connector that dies loses at most its uncommitted window: spool failed ingest calls to disk and flush them on the next run, rather than retry-looping in memory or buffering unbounded.

## License

MIT (see `LICENSE`) — each connector folder is free to declare its own.
