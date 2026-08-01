# devsession-claude

> Renamed from `devsession`. If you registered a `.claude/settings.json` hook pointing at the old `devsession/index.js` path, update it to `devsession-claude/index.js` (see Setup below). The ingest payload's `source` field also changed from `'devsession'` to `'devsession-claude'` — artifacts already ingested under the old value keep it; only new ingests use the new one, so a `search`/`GET /api/v1/ingest` query scoped to `source: 'devsession'` won't find sessions recorded after this change (and vice versa) unless you backfill. The name change reflects that this connector is specifically for Claude Code — see [the sibling-connectors issue](https://github.com/MSIH/life-context-connectors/issues/10) (transferred to the core tracker) for planned sibling connectors covering other AI coding tools.

A Claude Code `SessionEnd` (and, optionally, `PreCompact`) hook that turns every coding session into a searchable `dev_session` artifact in [LifeContext](https://github.com/msih/life-context). Implements Milestone 1 (#28) of the LifeContext roadmap — the **push** reference connector.

## What it does

1. Claude Code invokes `index.js` on `SessionEnd` (and, if registered, `PreCompact`), passing hook JSON (`session_id`, `transcript_path`, `cwd`, …) on stdin.
2. It reads the session transcript and asks a chat model for a short summary — what was done, key decisions and why, next steps. By default (`CHAT_PROVIDER=claude-cli`) this shells out to the `claude` binary already authenticated in the environment — no local LLM or separate API key required, and it works the same whether Claude Code is running on your laptop or in a Claude Code web/cloud container. `CHAT_PROVIDER=openai` switches to the original path: any local or hosted OpenAI-compatible `/chat/completions` endpoint (Ollama by default).
3. It `POST`s the summary to LifeContext as `POST /api/v1/ingest`, `type: 'dev_session'`, `source: 'devsession-claude'`, `source_id` = the Claude Code session UUID.
4. If LifeContext is unreachable, the payload is appended to a local spool file instead of being dropped; the next session's hook run flushes anything spooled before processing itself.

## Setup

1. `cp .env.example .env` and fill in:
   - `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` — where LifeContext is running and its `x-api-key` (set the key to the same value as `LIFECONTEXT_API_KEY` in the core server's own `.env`)
   - The default summarizer provider (`claude-cli`) needs nothing else configured. If you'd rather use a local/hosted OpenAI-compatible endpoint, set `CHAT_PROVIDER=openai` and fill in `CHAT_BASE_URL` / `CHAT_MODEL` (and `CHAT_API_KEY` if the endpoint requires bearer auth) — see `.env.example`. (`life-context`'s [`docs/local-llm-setup-guide.md`](https://github.com/msih/life-context/blob/2.0/docs/local-llm-setup-guide.md) covers running Ollama locally.)
2. No `npm install` needed — zero dependencies, Node 18+ built-ins only (`fetch`, `fs/promises`, `child_process`).
3. Register the hook in your project's or user's `.claude/settings.json`. `SessionEnd` alone is enough to get started; also registering `PreCompact` (recommended — see below) captures long-running sessions before they compact instead of only at the very end:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/life-context/connectors/devsession-claude/index.js",
            "timeout": 120
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/life-context/connectors/devsession-claude/index.js",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

No `matcher` on either — `SessionEnd` fires for every reason (`clear`, `logout`, `prompt_input_exit`, …) and `PreCompact` fires for both `manual` (`/compact`) and `auto` (context-limit) triggers. Give both a generous `timeout`; the summarizer call can take a while (the `claude-cli` provider caps itself at `SUMMARIZE_TIMEOUT_MS`, ~90s, so a 120s hook timeout leaves headroom) and there's nothing to gain by cutting it off early (see Known Limitations below).

4. End a real coding session — the hook pushes it to LifeContext as a `dev_session` artifact. See "Recalling these sessions in Claude Code" below to actually get it back.

### Recalling these sessions in Claude Code

This hook only **pushes** sessions into LifeContext (`POST /api/v1/ingest`) — it is not itself the memory/recall path, and installing it doesn't make Claude Code recall anything. Recall is a separate MCP integration you register once, on the Claude Code side:

```bash
claude mcp add -s user --transport http lifecontext "$LIFECONTEXT_URL/mcp" --header "x-api-key: $LIFECONTEXT_API_KEY"
```

Once registered, the next morning try asking Claude Code "where did I leave off" — it should call the `search` tool and return the session artifact with the right project context. That's the roadmap's exit test for this connector. See [Claude Code's MCP docs](https://docs.claude.com/en/docs/claude-code/mcp) for the `claude mcp add` command itself, and the [LifeContext README](https://github.com/msih/life-context/blob/2.0/README.md#interfaces) for the authoritative MCP/REST endpoint details.

### Why also register `PreCompact`

A session that runs for hours or days may not hit `SessionEnd` for a long time — or the hook process may get killed before it finishes when the session does end (see Known Limitations). `PreCompact` fires earlier, whenever the conversation is about to be compacted (manually via `/compact` or automatically at the context limit), while the full pre-compaction transcript is still on disk at `transcript_path`. Registering the same script under both events is safe to do unconditionally: ingest is upsert-by-`(source, source_id)` and `source_id` is the session UUID (unchanged across compactions), so a `PreCompact` send and a later `SessionEnd` send for the same session refine the same `dev_session` artifact rather than creating duplicates. The payload's `extra.hook_event` records which event produced each ingest (`'PreCompact'` or `'SessionEnd'`) if you need to tell them apart.

### Recursion guard (`claude-cli` provider)

The default provider spawns `claude -p` to do the summarizing — and that spawned process is itself a Claude Code session, which would normally also fire `SessionEnd`. Two layers prevent it from recursively summarizing itself:

1. `--safe-mode` on the spawned process disables all customizations there, including hooks — so it can't invoke this script at all.
2. Belt-and-suspenders: the spawned process's env also carries `DEVSESSION_DISABLE=1`, and `main()` checks that first, before anything else. If a future change ever drops `--safe-mode`, this second guard still stops the recursion.

`--no-session-persistence` additionally keeps the summarizer's own transient session off disk and out of `/resume`.

### Running on Claude Code web / cloud sessions

The `claude-cli` provider works unchanged in a Claude Code web/cloud container — the spawned `claude` binary inherits whatever credentials the outer session already has.

A project-level `.claude/settings.json` can register this connector under both `SessionEnd` and `PreCompact`, guarded so it runs *only* in a cloud container (never doubling up with a user-level hook capturing the same local session):

```json
{ "type": "command", "shell": "bash", "timeout": 120,
  "command": "[ \"${CLAUDE_CODE_REMOTE:-}\" = \"true\" ] && node \"$CLAUDE_PROJECT_DIR/connectors/devsession-claude/index.js\" || true" }
```

The `CLAUDE_CODE_REMOTE=true` guard is the point: capturing *local* sessions stays the job of a user-level `~/.claude/settings.json` registration (which covers all your repos, not just one), so a project-level hook wired this way stands down locally — the guard short-circuits to `|| true` and node is never spawned. Without it, project + user hooks would both fire on every local session and summarize it twice (the upsert dedupes the artifact, but the summarizer would run twice). A checkout with no such project-level hook registered is unaffected either way: the connector only runs when something invokes it, and exits early (no-op) whenever `LIFECONTEXT_API_KEY` is unset.

What differs from a local setup:

- **No `.env` file reaches the container.** Cloud sessions only get the git checkout — configure `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` (and `CHAT_PROVIDER`/`CHAT_MODEL` if overriding the default) as real environment variables in the [environment's own settings](https://code.claude.com/docs/en/claude-code-on-the-web); the existing `.env` loader already prefers real env vars over the file, so no code change is needed. Note the docs' warning: env vars are visible to anyone who can edit the environment config — treat `LIFECONTEXT_API_KEY` as a rotatable secret.
- **`LIFECONTEXT_URL` must be reachable from the container**, not `localhost` — point it at wherever LifeContext is actually exposed (the Cloudflare Tunnel from [`docs/07-cloudflare-tunnel-setup.md`](../../docs/07-cloudflare-tunnel-setup.md), or another public host).
- **The environment's network policy must allow that host.** The default "Trusted" allowlist won't include your personal tunnel domain — use a Custom allowlist (defaults + your domain) or Full access, or the ingest POST is blocked (and the payload only spools, which won't survive the container anyway).
- **The spool is best-effort only.** If ingest fails, the payload is written to `DEVSESSION_SPOOL_PATH` for retry on the next run — but a cloud container is ephemeral, so a spooled payload does not survive container reclaim. Acceptable for a best-effort hook; there's no durable fix without a persistent volume.

## Known limitations

- **`SessionEnd` cannot block session exit**, and Claude Code does not guarantee it waits for the hook process to finish. A slow summarizer call may be killed mid-summary before it can either produce a summary or fall back — in that case the session is silently not recorded. There's no full fix within a single-process hook; a future iteration could split "capture" (fast, synchronous) from "summarize + send" (a detached background process) if this proves to be a real problem in practice.
- **The transcript JSONL format is internal to Claude Code and undocumented** (it can change between releases). `readTranscriptTurns()` in `index.js` is deliberately defensive — every field access is optional-chained and any line that doesn't match the expected shape is skipped rather than throwing — but a future Claude Code release could still change the shape enough that summaries degrade or come back empty. Sessions below `MIN_USER_TURNS` (currently 1) are skipped rather than logged as an empty artifact.
- Near-empty sessions (no user turns) are skipped entirely — nothing worth remembering, and it avoids polluting search with empty artifacts.
- **Possible future provider: Codex CLI** (`codex exec`) as an alternative to `claude-cli` for users primarily on OpenAI's tooling — not implemented, tracked as a follow-up idea only.

## Verifying changes to this connector

`npm test` (`node --test test.mjs`) runs the automated suite — no `npm install`, no real API usage, matching the pattern `imessage/test.mjs` and `photo-exif/test.mjs` use. It spawns `index.js` as a real child process against a mock `node:http` ingest server (and, for the `openai` provider, a mock chat-completions server) and a stub `claude` script written to a temp dir and prepended onto `PATH`, so `execFile('claude', ...)` resolves to the stub instead of a real CLI. Covers: the `claude-cli` provider's happy path, the `DEVSESSION_DISABLE` recursion guard, the fallback-summary path when the summarizer fails, the `openai` provider's request shape with and without `CHAT_API_KEY`, and the `PreCompact`/`SessionEnd` dedup path from #4 (same `source_id`, distinct `extra.hook_event`) — note that a mock server which just logs bodies doesn't exercise LifeContext's real upsert dedup; the test only confirms both events produce a request keyed on the same `source_id`, which is what makes the upsert in a real server a refine-not-duplicate.

For a change the suite doesn't cover, the same ingredients work standalone: a `node:http` server logging `POST /api/v1/ingest` bodies, a hand-written executable `claude` script on `PATH`, and a fake hook payload on stdin — `{"session_id":"...","transcript_path":"<path-to-a-fixture-transcript.jsonl>","cwd":"..."}` (add `hook_event_name`/`trigger`/`custom_instructions` for a `PreCompact`-shaped payload) — pointing `transcript_path` at a small fixture JSONL matching the shape in `readTranscriptTurns()` (`{"message":{"role":"user","content":[{"type":"text","text":"..."}]}}` per line). One real run with the actual `claude` binary is still worth doing after a summarizer-path change: `echo '<transcript>' | claude -p --safe-mode --no-session-persistence --tools "" --model haiku --system-prompt "<prompt>"` should print a plain-text summary.

## Files

- `index.js` — the hook script (no dependencies)
- `test.mjs` — automated test suite (`npm test`; no dependencies, `node:test` built-in)
- `.env.example` — copy to `.env`
- Spool file (not checked in): `~/.life-context/devsession-spool.jsonl` by default, override with `DEVSESSION_SPOOL_PATH`
