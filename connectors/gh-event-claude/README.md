# gh-event-claude

A Claude Code `PostToolUse` hook that records **GitHub issue/PR creation and PR merges** as
searchable `x-dev-event` artifacts in [LifeContext](https://github.com/msih/life-context). It
complements [`devsession-claude`](../devsession-claude/README.md): that connector captures the
*conversation* (`SessionEnd`/`PreCompact` → `dev_session`), this one captures the discrete *event*
— "when did I open issue #89?", "what PRs did I merge last week?".

## What it does

1. Claude Code invokes `index.js` on `PostToolUse` for a GitHub create **or merge** tool (matchers
   below), passing the hook JSON (`tool_name`, `tool_input`, `tool_response`, `cwd`) on stdin.
2. It extracts the issue/PR URL (the anchor), number, repo, and — best-effort — title and current
   branch, from either the Bash `gh` stdout or the GitHub-MCP structured response.
3. It POSTs one artifact to `POST {LIFECONTEXT_URL}/api/v1/ingest`. Core embeds and stores it.

If no issue/PR URL can be found (the create failed, or there's nothing to record) it ingests
nothing and exits 0.

**Merges** (`gh pr merge` / `mcp__github__merge_pull_request`) are a distinct action. `gh pr merge`
prints no full URL — only the `owner/repo#N` shorthand — so the hook reconstructs
`https://github.com/<repo>/pull/<n>` from that shorthand (or the MCP tool's `{owner, repo,
pullNumber}`). A merge is stored under a **separate** `source_id` (`<url>#merged`) so it never
upserts over the "Opened" artifact for the same PR — both events coexist.

**The non-TTY caveat (#422).** Under the Claude Code tool runner, a real `gh pr merge <n>`
invocation's confirmation line — the very `owner/repo#N` shorthand the paragraph above depends on —
is frequently absent from *both* stdout and stderr (most plausibly `gh`'s own non-TTY output
suppression; confirmed as a dependency, the exact mechanism isn't). Seven merges in one day were
silently dropped this way before the fix. So `resolveMergeRef` carries a **final** fallback: when
the URL, MCP-fields, and shorthand strategies all miss, it parses the bare PR number that `gh pr
merge <n>` takes as its own argument straight out of `toolInput.command` (boundary-anchored exactly
like the merge-detection check above, so it only ever fires on a genuine `gh pr merge` invocation)
and pairs it with the `owner/repo` slug read from the hook's `cwd` via `git config --get
remote.origin.url` — deliberately **not** anchored to a literal `github.com`, since an SSH config
Host alias (e.g. `git@myhost:ACME/example-repo.git`) is a common setup
for juggling multiple GitHub accounts on one box. A non-numeric argument (a branch name, or a URL
the earlier strategies already cover) does not match and correctly falls through. A merge whose PR
ref *still* can't be derived (e.g. a bare current-branch `gh pr merge` with no number at all, or a
`cwd` with no discoverable `origin`) ingests nothing and exits 0.

**A non-zero `gh pr merge` exit is verified, not trusted as failure (#324).** `--delete-branch` can
fail — "cannot delete branch used by worktree" — *after* the merge itself succeeded, which is the
normal case in a repo where every branch is worked in its own `git worktree` (this one). So a
non-zero exit from the MCP merge tool's `merged: false` is still a hard no, but a non-zero Bash
`gh pr merge` exit triggers a `gh pr view <n> --repo <slug> --json state --jq .state` check, and the
event is recorded only on a confirmed `MERGED`. If that check itself can't run (no `gh` on `PATH`,
no auth, no network) the event is dropped, same as before — a false merge is never recorded, and an
unverifiable one is not guessed at.

`mcp__github__issue_write` handles both **create** and **update**; an update still returns the
issue's `html_url`, so the hook records *only* `method: "create"` — an explicit non-create method
is skipped, so ordinary edits never appear as phantom "Opened…" events. This mirrors the
`draft-issue-gate`'s method detection exactly (a missing/unparseable method falls through as a
create). The other matchers are creates by definition, so no check applies to them.

## Contract

| Field | Value |
|-------|-------|
| `source` | `gh-event-claude` |
| `source_id` | the issue/PR URL (e.g. `https://github.com/ACME/example-repo/issues/89`); a merge uses `<url>#merged` — reproducible + unique, so a re-fire **upserts**, never duplicates |
| `type` | `x-dev-event` (an `x-` extension type — issue/PR events aren't a registered artifact type; no registry change needed) |
| `text_repr` | `Opened GitHub issue #89 "capture gh events" in ACME/example-repo. <url>` — or `Merged GitHub pull request #164 …` for a merge |
| `extra` | `{ kind: 'issue'\|'pr', action: 'opened'\|'merged', number, url, repo, branch, tool_name, title, cost? }` — `cost` is present **only** on a merge (below) |

## Cost instrumentation (#377)

Spend alone doesn't say much — a $6 PR on Opus 5 at `xhigh` and a $6 PR on Sonnet 5 at `medium`
are the same dollar figure and a completely different signal. So a **merged PR's** `x-dev-event`
also carries `extra.cost`, attributing the spend to the model/effort that produced it:

```jsonc
"cost": {
  "attempt_count": 3,        // commits the merged PR carried, via `gh pr view --json commits`; null if undeterminable OR zero (see below)
  "scope": "since-prior-merge", // what these totals COVER (#402) — or "session-to-date" on a session's first merge
  "window_start": "2026-07-28T10:05:00.000Z", // lower bound of that window; null when scope is session-to-date
  "interleaved": false,      // true = >1 git branch inside the window, so this slice includes another lane's spend
  "subagent_count": 1,       // delegated subagent transcripts found and included
  "model": "claude-opus-5",  // ONLY set when the whole window is one (model, effort, agent) group; null on a mixed session
  "effort": "high",          // same homogeneous-only rule as model
  "review_tier": null,       // reserved for #380 (review-tier attribution) — not yet populated
  "turn_count": 3,           // distinct assistant messages in-window, main thread AND subagents (see dedup note below)
  "usage": {                 // the ALL-GROUPS total, summed across every in-window assistant turn; null if unavailable
    "input_tokens": 150,
    "cache_creation_input_tokens": 200,      // TOTAL cache write; the two fields below split it by TTL
    "cache_creation_5m_input_tokens": 0,     // 5-minute-TTL share (bills at 1.25x input)
    "cache_creation_1h_input_tokens": 200,   // 1-hour-TTL share (bills at 2x input)
    "cache_read_input_tokens": 300,
    "output_tokens": 500
  },
  "total_cost_usd": 0.0154, // sum of every breakdown entry's cost_usd; null when withheld (see total_cost_usd_reason)
  "total_cost_usd_reason": null, // 'contaminated_window' | 'unpriced_group' | null (a real total was recorded)
  "breakdown": [              // one entry per distinct (model, effort, agent) group seen — always present, even if empty
    {
      "model": "claude-opus-5",
      "effort": "high",
      "agent_type": null,     // null = the main thread; else the delegated agent's TYPE, e.g. "general-purpose"
      "agent_id": null,       // null = the main thread; else the per-invocation agent id
      "turn_count": 2,
      "usage": { "...": "same shape as the all-groups total above" },
      "cost_usd": 0.0154
    }
  ]
}
```

**Where it comes from:**

- **`transcript_path`** (and `session_id`) arrive on the same `PostToolUse` hook JSON as
  `tool_name`/`tool_input`/`tool_response`/`cwd` — no new plumbing. The transcript is the
  session's own JSONL file (`~/.claude/projects/<project>/<session>.jsonl`).
- **The usage fields are summed separately, never blended into one number.** They price at very
  different rates ($5.00 input / $0.50 cache read / $25.00 output per MTok on Opus 5) — on one
  measured session, output was only 10% of spend and cache traffic was 90%, so a single summed
  token count would misattribute nearly all of the cost.
- **Cache writes are priced per TTL, which is why `cache_creation` is recorded three ways.** The
  write premium is **1.25x input at the 5-minute TTL and 2x at the 1-hour TTL** — $6.25 vs
  $10.00 per MTok on Opus 5. `message.usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`
  carries the split; the flat `cache_creation_input_tokens` is only the total. Pricing that total
  wholesale at the 5-minute rate understates a 1-hour write by 37.5%, and every Claude Code
  **main-loop** session measured on this box writes **100% 1-hour-TTL** cache — so that is the
  normal case, not an edge one, and cache write is ~44% of a session's bill. **A delegated
  subagent is the opposite** (#402): the subagent transcripts measured here wrote **100%
  5-minute-TTL** cache (101,871 / 0 on one real lane), so the two halves of a session bill at
  different write rates — another reason the per-TTL fields are recorded rather than derived. An
  older transcript that carries no `cache_creation` sub-object reports only the total; whatever
  isn't broken down bills at the conservative 5-minute rate.
- **Deduplication by `message.id`.** A single assistant API response with multiple content
  blocks (e.g. a thinking block followed by a text block) is logged as *separate* JSONL lines
  that all repeat the *same* `message.id` and the *same* `usage` totals. Summing every line would
  multiply usage by the block count, so each `message.id` is counted exactly once — assigned to
  whichever `(model, effort)` group its first-seen line reports.
- **Usage is grouped by the `(model, effort)` pair, never collapsed to one value.** `model` comes
  from `message.model`, `effort` from the entry's own top-level `effort` field, both read per
  assistant turn. A session that runs across more than one model and/or effort level (a retry on
  a different model, an escalated effort) produces **one `breakdown` entry per distinct pair**,
  each with its own `usage` and `cost_usd` — collapsing to a single last-seen value would credit
  the whole session to whichever end happened to run last, and (a real costing bug, not just a
  labelling one) would then price every token at that one model's rate even for turns that ran on
  a different model entirely. Since #402 the group key also carries the **agent** (see the delegated
  -subagent note below), so the grouping is `(model, effort, agent_id)`. `breakdown` is sorted
  highest-`cost_usd`-first, tie-broken by model, then effort, then agent, so the array is stable and
  diffable across runs.
- **Top-level `model`/`effort`/`usage`/`total_cost_usd` summarize the whole session** — `model`
  and `effort` are the single value **only** when `breakdown` has exactly one entry (a homogeneous
  session); the moment there's more than one, both go `null` rather than naming just one side of a
  mixed session. `usage` is always the all-groups total regardless of homogeneity.
- **`attempt_count`** is *not* in the transcript — it's the number of commits the merged PR
  carried, read from **`gh pr view --json commits`** (#402). Asking GitHub rather than git is
  deliberate: `gh pr merge --delete-branch` is this repo's normal merge form, so by the time this
  `PostToolUse` hook runs the branch is gone both locally and remotely, and the git approach could
  only ever measure `origin/<default>..HEAD` in whatever `cwd` the tool call had — the primary
  checkout sitting on `main` for every merge as actually practiced here, making the count `0`
  (reported `null`) essentially always. `git rev-list --count origin/<default branch>..HEAD` remains
  the **fallback** when the `gh` lookup can't run (no network, no auth). Best-effort throughout: a
  failure yields `null`, never a guess. **A count of zero is also reported as `null`**, not as `0`:
  a merged PR always carries at least one commit, so zero means the measurement missed. Recording a
  real-looking `0` would seed the dataset with a plausible wrong number instead of an honest gap.
- **Delegated subagent spend is included, and attributed (#402).** A subagent's turns are *not* in
  the session transcript: `transcript_path` names the main session file, while each delegated agent
  writes its own `<session-dir>/<session-id>/subagents/agent-*.jsonl`. No `isSidechain` line ever
  appears in the parent file, so reading only `transcript_path` misses **100%** of delegated spend —
  silently, with no `null` to signal it (measured 16% aggregate understatement across 8 sessions,
  1–61% per session). Each subagent file becomes its own `breakdown` group keyed by the
  per-invocation `agent_id` — so two runs of the same agent type stay separate and one expensive
  delegation can't hide inside an average — and labelled with `agent_type` (the transcript's
  `attributionAgent`, e.g. `general-purpose`). A missing `subagents/` directory is the ordinary
  undelegated case and changes nothing; one unreadable subagent file omits only its own usage.
- **`scope` / `window_start` / `interleaved` — what the totals actually cover (#402).** Usage is no
  longer summed from line 1 of the transcript: that charged the *whole session to date* to whichever
  PR happened to merge, so a session merging N PRs recorded ~1x, ~2x, … ~Nx cumulatively. The window
  now starts at the **previous `gh pr merge` in the same session** (`scope: "since-prior-merge"`), or
  has no lower bound on a session's first merge (`scope: "session-to-date"`, `window_start: null`).
  Deliberately *not* the PR's first commit: a lane's drafting and implementation happen before its
  first commit, and a first-commit window measured only **52.5%** of a real lane's weighted spend —
  an undercount of the same order as the subagent gap above. The residual error of any time window is
  a session working two lanes at once, so `interleaved: true` flags a window spanning more than one
  `gitBranch`.
  `gitBranch`.
- **`total_cost_usd` is withheld — not reported — the moment the window is known to be
  contaminated (#438).** Per-PR cost used to be scoped by wall-clock, not by which work belonged to
  the PR: whatever an `interleaved` window absorbed from another lane got charged to whichever PR
  happened to merge at the end of it, and a `session-to-date` window (a session's first merge) had
  *no* lower bound at all, so it could absorb an arbitrary amount of unrelated drafting/discussion
  that preceded it. "One PR per session" isn't how this repo is actually worked (a single session
  routinely merges several PRs across several workstreams), so a scheme that trusts every window is
  wrong most of the time. **`interleaved: true` now withholds `total_cost_usd` (`null`) rather than
  reporting it**, regardless of `scope` — a `since-prior-merge` window that still spans more than one
  `gitBranch` (PR #435's real recorded shape) and a `session-to-date` window that does the same (PR
  #430's) are both withheld the same way, because the branch-diversity signal is what's known to be
  wrong in either case. A `session-to-date` scope by itself is **not** a withholding trigger — that
  is also the shape of a short, single-PR session with no other workstream mixed in, and withholding
  it unconditionally (regardless of branch diversity) would empty the dataset for that legitimate
  case too, on top of the interleaved ones. So the one shape this connector currently vouches for is
  a window with **no** branch diversity, whether or not it also happens to have a real prior-merge
  lower bound. True lane
  attribution — knowing which turns actually belonged to this PR rather than inferring it from
  branch diversity — needs a signal the transcript doesn't carry yet (see the issue's Design
  Decisions); this is the cheaper, honest interim fix: a wrong number is worse than an absent one.
- **`total_cost_usd_reason` names why the total is `null`, so the two null causes are never
  confused (#438).** `'contaminated_window'` — the window above is known-contaminated (`interleaved:
  true`); `'unpriced_group'` — the window is clean but at least one `breakdown` group's model has no
  pricing entry (below); `null` — either a real `total_cost_usd` was recorded, or there was no
  transcript data at all to price in the first place (`breakdown: []`, every other `cost` field also
  `null`). **`breakdown` stays fully populated in every case, including a withheld total** — each
  group's own `cost_usd` is computed independently and is never deleted; only the potentially
  misleading single total is held back.
- **`total_cost_usd`, when not withheld, is the sum of every `breakdown` entry's `cost_usd`**, each
  derived from that group's own `usage` at its own model's per-MTok rates
  (`DEFAULT_MODEL_PRICING_USD_PER_MTOK` in `index.js`, overridable via `GH_EVENT_MODEL_PRICING_JSON`
  — see `.env.example`). A group whose model has no pricing entry still gets its `usage` recorded and
  keeps its own `cost_usd: null` in `breakdown` — but if **any** group is unpriceable, the top-level
  `total_cost_usd` goes `null` too (`total_cost_usd_reason: 'unpriced_group'`), rather than silently
  reporting a partial sum that reads as a complete number.
- **A group whose usage is entirely zero across every counted field prices at `cost_usd: 0`, even
  when its model has no pricing entry — it does NOT trip the `allPriced` fail-honest rule above
  (#437).** The harness emits a `<synthetic>` model entry for an interrupted turn — a transcript
  artifact, not a model that ran, `turn_count: 1` with every usage field `0` — and `<synthetic>`
  will never be in the pricing table. Before #437 that one group's unresolved rate nulled the
  *entire* `total_cost_usd`, even when every real model group in the same `breakdown` priced fine,
  silently zeroing out cost data for every PR whose session had a mid-turn interruption (ordinary in
  interactive work). The fix gates on the group's **usage being all-zero**, never on the model name
  or the literal string `<synthetic>` — a zero-usage group costs exactly `$0` under any rate table,
  so excluding it from the completeness check loses no honesty, and the check stays correct for
  whatever the *next* pseudo-model turns out to be called. A group with any real, non-zero usage
  and an unresolved model still nulls the total exactly as before — this only short-circuits the
  true-all-zero case. The zero-usage group is still emitted in `breakdown` (at `cost_usd: 0`) rather
  than dropped, so its `turn_count` keeps the interrupted turn visible in the record.

**Which merges produce a usable tier sample (#438, for #380).** A record is trustworthy as one PR's
own cost only when `total_cost_usd` is non-`null` — equivalently, `total_cost_usd_reason: null`.
That means: no branch diversity inside the window (`interleaved: false`) **and** every `breakdown`
group priced. `interleaved: true` (any `scope`) and an unpriced group are both explicitly excluded,
named by `total_cost_usd_reason`, with the full per-group `breakdown` retained as raw evidence either
way. Do not average or otherwise consume a `null` `total_cost_usd` row into a tier value.

**Scoped to merges only.** An "Opened…" event's `extra` is unchanged by this feature — no `cost`
key at all — since the acceptance unit here is a *merged* PR, the falsifiable thing the harness
cost epic (#375) needs to measure.

**Never blocks the merge event.** Every input (transcript read, git commands) is independently
best-effort and wrapped so a failure degrades individual `cost` fields to `null` rather than
dropping the merge event itself — consistent with this connector's overall failure posture below.

## Setup

1. `cp .env.example .env` and set `LIFECONTEXT_URL` + `LIFECONTEXT_API_KEY` to match the core
   server.
2. No `npm install` — the script is dependency-free (Node 18+ built-ins only).
3. Register the hook under `PostToolUse` in a `.claude/settings.json`, one entry per create/merge
   tool matcher.

   **A `matcher` selects the tool NAME only** — an exact string or a regex over the name, never an
   argument pattern. `"Bash(gh pr merge*)"` looks like it would fire on that command and never
   does: no tool is *named* that, so the hook sits inert with no error, and a `PostToolUse` hook
   that never fires simply loses the event. An argument pattern belongs in the per-handler **`if`**
   field, which does use permission-rule syntax — so the shell entries below match on
   `"Bash|PowerShell"` and narrow with `if`, while the MCP entries match their tool name directly:

    ```jsonc
    "PostToolUse": [
      { "matcher": "Bash|PowerShell", "hooks": [
        { "type": "command", "if": "Bash(gh issue create *)",       "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 },
        { "type": "command", "if": "PowerShell(gh issue create *)", "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }
      ] },
      { "matcher": "mcp__github__create_issue",          "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__issue_write",           "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "Bash|PowerShell", "hooks": [
        { "type": "command", "if": "Bash(gh pr create *)",          "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 },
        { "type": "command", "if": "PowerShell(gh pr create *)",    "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }
      ] },
      { "matcher": "mcp__github__create_pull_request",   "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "Bash|PowerShell", "hooks": [
        { "type": "command", "if": "Bash(gh pr merge *)",           "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 },
        { "type": "command", "if": "PowerShell(gh pr merge *)",     "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }
      ] },
      { "matcher": "mcp__github__merge_pull_request",    "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] }
    ]
    ```

   Note the trailing space in each `if` pattern (`gh pr merge *`) — it anchors the match at a real
   command boundary. Matching is existence-based across a compound command: a pattern matching any
   one subcommand at a boundary (start, or after `&&`/`;`/`|`) is enough, so a
   `cd … && git push … && gh pr create …` chain still fires.

   The create/merge matchers overlap the `draft-issue-gate` / `pre-pr-review-gate` `PreToolUse`
   hooks — the gates *enforce* the workflow, this *records* the result. The command uses
   `${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}` (not a bare
   `$CLAUDE_PROJECT_DIR`, and not a `$(pwd)` fallback either — #324) so an unset var doesn't
   resolve to `/connectors/…` → `ENOENT` → a silent no-op, and the fallback doesn't depend on the
   invoking process's cwd matching the repo root: `git rev-parse --show-toplevel` finds the
   checkout root from anywhere inside it (the primary checkout or any `git worktree`), which a bare
   `$(pwd)` cannot guarantee. After editing your `.claude/settings.json`, re-check by hand that
   every hook command still resolves to a real, readable script — a hook that can't launch fails
   silently, and a `PreToolUse` hook that fails to launch *allows* the call it was meant to gate.

### Config resolution (#324)

`resolveConfig()` fills `LIFECONTEXT_URL`/`LIFECONTEXT_API_KEY` from, in order, first hit wins:

1. **Process env** — never overridden by anything below.
2. **This script's own sibling `.env`** — unchanged behavior, every key.
3. **The PRIMARY worktree's `.env`** — `connectors/gh-event-claude/.env`, then its root `.env`,
   located via `git rev-parse --path-format=absolute --git-common-dir` (a worktree's `.git` is a
   pointer file back to the primary checkout, so this needs zero setup). Only `LIFECONTEXT_URL`/
   `LIFECONTEXT_API_KEY` are adopted from this file — never the rest of a root `.env` (`PORT`, geo
   radii, access-log settings, …), which would leak unrelated core config into this connector.
   This exists because a `git worktree` checkout never carries the gitignored `.env` — and this
   project's development workflow puts every branch in its own worktree, so without this fallback
   the hook silently lost every event fired from inside one.
4. **`~/.life-context/.env`** — same two keys only; where this connector's own spool and other
   connectors' cursors already live.

**A config gap spools the event; it no longer skips it.** If no key resolves anywhere, the payload
is still built and appended to `GH_EVENT_SPOOL_PATH` (same file a network failure spools to,
below) rather than dropped — the connector contract's failure posture (doc 04 §7) is to lose at
most the uncommitted window, and a missing key is exactly that case.

### Why unguarded (unlike devsession-claude)

`devsession-claude`'s setup registers it in a project `.claude/settings.json` behind a
`CLAUDE_CODE_REMOTE=true` guard, because a user-level + project hook would otherwise run its
*expensive LLM summarizer* twice on every local session. This connector does **no** LLM call, and
ingest is upsert-by-`(source, source_id)` keyed on the URL — a double-fire just re-writes the same
artifact. So it's registered **unguarded**: it fires locally *and* in cloud, capturing your local
issue/PR events with no separate user-level wiring. `PostToolUse` only fires after the tool
actually ran, so a create denied by a `PreToolUse` gate never reaches this hook.

## Failure posture

Best-effort, per [`docs/04-connector-contract.md`](../../docs/04-connector-contract.md) §7: never
throws past `main()`, always exits 0 (a capture hook must never hang or fail the terminal). If the
ingest server is unreachable, or no API key resolves at all (above), the payload is spooled to
`GH_EVENT_SPOOL_PATH` (default `~/.life-context/gh-event-spool.jsonl`) and flushed on the next
event.

## Testing

`npm test` (`node --test test.mjs`) spawns `index.js` against a mock `node:http` ingest server —
no `npm install`, no real network. Covers the Bash-stdout parse, the MCP-response parse, the
`html_url` preference, the `issue_write` update → no-ingest and create → ingest paths, the
no-URL no-ingest path, the merge paths (`gh pr merge` shorthand + MCP `merge_pull_request`, keyed
`#merged`; underivable-ref → no-ingest), the non-zero-exit `gh pr merge` verification (a stubbed
`gh pr view` reporting `OPEN` → no ingest, `MERGED` → records anyway), the config-resolution
fallback to a fake primary worktree's `.env`, and the no-key-anywhere → spool path.

**The bare-PR-number fallback (#422)** gets its own tests against a real throwaway git repo with a
real `origin` remote (`buildFakeRepoWithOrigin`): a `gh pr merge <n>` payload with **no**
`owner/repo#N` anywhere in stdout/stderr/command still resolves and captures via `cwd`'s `origin`;
an `origin` using an SSH Host alias (not a literal `github.com`) resolves the same way, matching
this repo's own remote; a `gh pr create` payload sharing a `cwd` with a real `origin` still records
as an **opened** event, unaffected; and a bare `gh pr merge` with no PR-number argument at all still
falls through to the existing no-ingest/exit-0 behavior. The `gh`
stub used for merge verification is a compiled `.exe` on Windows (Node's `child_process` refuses
to spawn a resolved `.cmd`/`.bat` without `shell:true`, and the production `execFile('gh', ...)`
call has none) — see the `CSC_PATH`/`writeStubGhDir` comments in `test.mjs`.

**Cost instrumentation (#377)** is covered against a *real* throwaway git repo (`git init` +
a faked `origin/main` tracking ref, so `attempt_count` resolves without any real remote/push —
see `buildFakeRepoWithCommits`) and fixture transcripts (`writeTranscriptFixture`/`assistantTurn`,
matching the real Claude Code JSONL shape verified against a live transcript): summing the four
usage fields across multiple assistant turns while deduping a repeated `message.id` (a single API
response logged across several content-block lines), model/effort extraction, per-model pricing
(the same token counts price differently on Haiku 4.5 vs Opus 5 — proving attribution isn't a
blended rate), an unrecognized model recording `usage` but leaving `total_cost_usd` null, a
missing/unreadable transcript plus a non-git `cwd` degrading every `cost` field to `null` without
dropping the merge event, and an "Opened…" event carrying no `cost` key at all (merge-scoped).
**Mixed-session grouping** gets its own two tests: a transcript with two distinct `(model, effort)`
pairs produces two `breakdown` entries each priced at its own rate summing to `total_cost_usd`,
with top-level `model`/`effort` both `null` (never naming just one side of a mixed session); and a
mixed session where one group's model is unrecognized leaves `total_cost_usd` `null` while the
known group keeps its own populated `cost_usd`.

**Withholding a contaminated window (#438)** is built from the two real windows that motivated the
fix: a fixture mirroring PR #435's actual shape (`since-prior-merge` scope, `interleaved: true`) and
one mirroring PR #430's (`session-to-date` scope, `window_start: null`, also `interleaved: true`)
both assert `total_cost_usd: null` with `total_cost_usd_reason: 'contaminated_window'`, while
`breakdown` stays fully populated with real, non-null per-group `cost_usd` — proving the withholding
is scope-independent and never deletes the raw evidence. A `session-to-date` window with **no**
branch diversity (the ordinary shape of a short, single-PR session) and a `since-prior-merge` window
that is both bounded and non-interleaved each assert the opposite: a real, non-null `total_cost_usd`
and `total_cost_usd_reason: null` — proving the fix does not empty the dataset for the common,
genuinely single-workstream case. The two pre-existing "a group could not be priced" tests now also
assert `total_cost_usd_reason: 'unpriced_group'`, so the two withholding causes are verified
distinguishable, not just both `null`.
