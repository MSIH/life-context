# preferences-claude

A Claude Code `SessionStart` hook that fetches your stored `x-agent-preference` memories from
[LifeContext](https://github.com/msih/life-context) and prints them to stdout — which the harness
injects into the new session's context. Implements #407:
a working preference stored in LifeContext should reach a new session **deterministically**, not
depend on the session happening to search for it or you restating it by hand.

## What it does

1. Claude Code invokes `index.js` on `SessionStart`, passing hook JSON (`source`, `session_id`, …)
   on stdin. This hook ignores it entirely — nothing it needs is in the payload, and leaving stdin
   unread is safe at this size (the payload is far below the OS pipe buffer, so the harness's write
   completes without a reader).
2. It `POST`s `{LIFECONTEXT_URL}/api/search` with `types: ["x-agent-preference"]` and a generous
   `limit`, so every stored preference comes back regardless of query wording (the `types` filter
   narrows the SQL candidate set before ranking — see `src/search.js`'s `candidateStmt`). It also
   sends `use_planner: false` (#433): this
   request already supplies the one filter it needs, so the LLM query-planner call is pure cost
   here — measured at ~7.4s (empty result set) / ~9.0s (with 4 rows) on this box with the planner
   running, dropping to well under 1.5s with it skipped. Every session start pays this cost once,
   so removing it is the whole point of the fix.
3. Each result's preference text is printed to stdout, one per line under a short header.
4. Exits 0. **Every** failure path — no API key resolved, LifeContext unreachable, a non-2xx
   response, a malformed body, a timeout — prints nothing **to stdout** and exits 0 just the same.
   A `SessionStart` hook that blocks or errors is worse than the bug it exists to fix.

stdout is silent on failure; **stderr** carries a one-line diagnostic so a broken hook is still
debuggable. That line is a constant plus the error's *class* (`TypeError` / `SyntaxError` /
`AbortError`) — never `err.message` and never a stack, because a malformed response body makes
`res.json()` throw a `SyntaxError` quoting that body, which could be preference text. No preference
text ever reaches stderr or an ops log (absolute rule 7).

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` (same value as the
   core server's own `.env`). No `npm install` needed — zero dependencies, Node 18+ built-ins only
   (`fetch`, `fs`, `child_process`).
2. Register the hook in your **user-level** `~/.claude/settings.json` (this is a personal-machine
   convenience hook, not something a cloud/remote session can use — see Out of Scope below).
   Register **all five** `SessionStart` matchers, not just `startup` — a `/clear` or `/compact`
   session should get preferences too:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact|fork",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/life-context/connectors/preferences-claude/index.js",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

Give it headroom over the hook's own `PREFERENCES_TIMEOUT_MS` (default 15000ms/15s — sized for a
genuinely unreachable/hung server, not a working-but-slow one; see `.env.example`) so the harness
timeout is just a backstop, not the thing actually bounding the request. Since #433 the request
itself sends `use_planner: false`, so a healthy call now completes in well under 1.5s in practice —
the 15s budget is unchanged because it still has to cover a genuinely slow/cold server, not because
the request is expected to take that long.

3. Start a new session (or run `/clear`/`/compact`) with at least one `x-agent-preference` memory
   stored (see below) and confirm the preferences print at the top of context.

## Storing a preference under the marker

Any preference must be typed `x-agent-preference` — an untyped `note` is invisible to this hook
by design (it deliberately reads back only this marker, not every note; see `store_memory`'s
optional `type` field in the main README's MCP tool list, and issue #244). Two ways to write one:

- **Via the `store_memory` MCP tool** (interactively, from any session with the `lifecontext` MCP
  server registered): call it with `type: "x-agent-preference"`, e.g.

  > store_memory({ content: "Prefer tables over prose in status updates.", type: "x-agent-preference" })

- **Via `POST /api/v1/ingest`** (scripted/backfill — this is the route `scripts/migrate-preferences.js`
  uses): `{ source, source_id, type: "x-agent-preference", text_repr, ... }`. Upsert-keyed on
  `(source, source_id)`, so a script that re-derives the same `source_id` can safely re-run.

`list_types` (MCP tool) or `GET /api/v1/ingest/types` confirms the marker is observed once at
least one preference has been stored.

## Contract

| Field | Value |
|-------|-------|
| Trigger | `SessionStart`, matchers `startup\|resume\|clear\|compact\|fork` |
| Request | `POST {LIFECONTEXT_URL}/api/search`, `{ query, types: ["x-agent-preference"], limit, use_planner: false }` |
| Output | stdout, one preference per line under a `Stored agent preferences from LifeContext (apply these without being asked):` header; nothing printed on empty results or any failure |
| Measured latency | ~7.4-9.0s with the query planner running (pre-#433) → well under 1.5s with `use_planner: false` (post-#433), same box |

## Env

See `.env.example`: `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` (same fallback chain as
`gh-event-claude` — process env, sibling `.env`, the primary worktree's `.env`,
`~/.life-context/.env`), plus the optional `PREFERENCES_TIMEOUT_MS` / `PREFERENCES_SEARCH_LIMIT`
knobs.

## Out of Scope (see issue #407)

**Cloud sessions** (claude.ai/code, GitHub task runners) have no `localhost:3000` to reach, so this
hook cannot help there — deliberately deferred rather than building a second recall mechanism (an
unconditional user-level recall rule) before this local path is proven working. File a
follow-up issue once it is.
