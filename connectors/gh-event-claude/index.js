#!/usr/bin/env node
// Claude Code `PostToolUse` hook. Fires AFTER a GitHub issue/PR create tool succeeds (see the
// matchers in .claude/settings.json), reads the hook JSON from stdin, extracts the issue/PR
// URL + number (+ title/branch, best-effort) from the tool call, and POSTs it to LifeContext as
// an `x-dev-event` artifact — so "when did I open issue/PR X" is recallable. Complements the
// devsession-claude connector, which captures the conversation, not the discrete event.
//
// Unlike devsession-claude this does NO LLM call and is registered UNGUARDED (fires locally and
// in cloud): ingest is upsert-by-(source, source_id) with source_id = the issue/PR URL, so a
// double-fire just refines the same artifact. Best-effort like every push connector: never throws
// past main(), always exits 0 so a slow/broken hook can't hang or fail the user's terminal
// (docs/04-connector-contract.md §7 "Failure posture").
import { readFile, appendFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_API_KEY = 'change-this-to-a-long-secure-token';
// Ordered config resolution (#324, doc 04's connector-contract failure posture). First hit per
// KEY wins; process env is never overridden (each application below only fills a still-unset
// key). Order: (1) process env — implicit, nothing to do; (2) this script's own sibling `.env`
// (unchanged behavior, every key); (3) the PRIMARY worktree's `connectors/gh-event-claude/.env`,
// then its root `.env` — a `git worktree` checkout never carries a committed `.env` (gitignored),
// so a hook running from inside `.worktrees/<name>/` (every branch here — this project's mandatory
// workflow) would otherwise see nothing at all; `git rev-parse --git-common-dir` finds the
// primary checkout with zero user setup, since a worktree's `.git` is a pointer file back to it.
// Only `LIFECONTEXT_URL`/`LIFECONTEXT_API_KEY` are adopted from a FALLBACK file — never a whole
// root `.env` (PORT, geo radii, access-log settings, ...), which would leak unrelated core config
// across the connector boundary; (4) `~/.life-context/.env`, where this connector's own spool and
// other connectors' cursors already live. The `git rev-parse` subprocess only runs once the key is
// still unresolved after (1)-(2), so the common (sibling-.env-present) path pays nothing extra.
const FALLBACK_KEYS = ['LIFECONTEXT_URL', 'LIFECONTEXT_API_KEY'];

resolveConfig();

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const SPOOL_PATH = process.env.GH_EVENT_SPOOL_PATH
  || path.join(os.homedir(), '.life-context', 'gh-event-spool.jsonl');

// Cost instrumentation (#377). Rates are USD per MILLION tokens ("MTok"), one entry per
// model id actually seen in a transcript (`message.model`) — Opus 5, Sonnet 5, and Haiku
// 4.5 all price differently, so a single blended rate would misattribute spend across
// them (see the `buildMergeCost` comment below). `cacheRead` is the discounted re-read
// rate (0.1x input) per Anthropic's published pricing.
//
// The cache-WRITE premium is TTL-dependent, which is why there are two of them:
// 1.25x input at the 5-minute TTL, 2x input at the 1-hour TTL. Pricing every write at
// the 5-minute rate understates a 1-hour write by 37.5%, and that is not an edge case —
// every Claude Code session measured on this box writes 100% 1-hour-TTL cache, and cache
// write is ~44% of a session's bill. See `computeCostUsd` for how the split is applied.
//
// All rates are named fields, not derived at request time, so a rate change means editing
// this table (or the env override) and never the math. Rates change over time and differ
// per model (absolute rule 1/5) — GH_EVENT_MODEL_PRICING_JSON replaces this table wholesale
// with a same-shaped JSON object when set, rather than being hardcoded here with no override.
const DEFAULT_MODEL_PRICING_USD_PER_MTOK = {
  'claude-opus-5': { input: 5.00, cacheWrite5m: 6.25, cacheWrite1h: 10.00, cacheRead: 0.50, output: 25.00 },
  'claude-opus-4-8': { input: 5.00, cacheWrite5m: 6.25, cacheWrite1h: 10.00, cacheRead: 0.50, output: 25.00 },
  // Sonnet 5 list pricing. Introductory pricing ($2.00/$10.00 per MTok) runs through
  // 2026-08-31; recording at list keeps the table stable across that cutover, and the env
  // override is the escape hatch if spend needs to reflect what was actually invoiced.
  'claude-sonnet-5': { input: 3.00, cacheWrite5m: 3.75, cacheWrite1h: 6.00, cacheRead: 0.30, output: 15.00 },
  'claude-sonnet-4-6': { input: 3.00, cacheWrite5m: 3.75, cacheWrite1h: 6.00, cacheRead: 0.30, output: 15.00 },
  'claude-haiku-4-5': { input: 1.00, cacheWrite5m: 1.25, cacheWrite1h: 2.00, cacheRead: 0.10, output: 5.00 },
};

function loadModelPricing() {
  const raw = process.env.GH_EVENT_MODEL_PRICING_JSON;
  if (!raw) return DEFAULT_MODEL_PRICING_USD_PER_MTOK;
  try {
    const parsed = JSON.parse(raw);
    // Must be a PLAIN object keyed by model id. `typeof [] === 'object'`, so an array would
    // otherwise be accepted as the table and then miss on every model lookup — silently
    // disabling pricing everywhere instead of falling back to the defaults (Copilot, PR #392).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.error('gh-event-claude: GH_EVENT_MODEL_PRICING_JSON is not a JSON object; using defaults');
  } catch (err) {
    console.error('gh-event-claude: GH_EVENT_MODEL_PRICING_JSON failed to parse; using defaults', err.message);
  }
  return DEFAULT_MODEL_PRICING_USD_PER_MTOK;
}
const MODEL_PRICING_USD_PER_MTOK = loadModelPricing();
const USD_PER_MTOK_TO_PER_TOKEN = 1 / 1_000_000; // the four usage fields are raw token counts
const DEFAULT_BASE_BRANCH_FALLBACK = 'main'; // used only when the tracking ref can't be read

const SOURCE = 'gh-event-claude';
const EVENT_TYPE = 'x-dev-event'; // issue/PR creation isn't a registered type; x- extension is accepted by ingest
// Owner/repo/kind/number from any github.com issue or PR URL, wherever it appears in the tool
// result (Bash `gh` stdout or a stringified MCP response). Kept loose on the host path segments.
const GH_URL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/(issues|pull)\/(\d+)/;
// `gh pr merge` prints no full URL — just the "owner/repo#number" shorthand (e.g.
// "✓ Squashed and merged pull request ACME/example-repo#164"). Match that to reconstruct the URL.
const GH_SHORTHAND_RE = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)/;

function parseEnvText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    out[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// Applies KEY=VALUE lines from `envPath` to process.env, never overriding an already-set key.
// `keysAllowed`, when given, restricts adoption to that allowlist (used for fallback files so a
// root `.env`'s unrelated keys never leak into this connector's process).
function applyEnvFile(envPath, keysAllowed) {
  if (!existsSync(envPath)) return;
  const parsed = parseEnvText(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (keysAllowed && !keysAllowed.includes(key)) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// The primary checkout's root, found via the worktree's `.git` pointer file — works unchanged
// from the primary checkout itself (git-common-dir is just its own `.git`). Best-effort: no git,
// no repo, or a detached process.cwd() all resolve to null, never throw.
function primaryWorktreeRoot(cwd) {
  try {
    const gitCommonDir = execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return gitCommonDir ? path.dirname(gitCommonDir) : null;
  } catch {
    return null;
  }
}

// The `owner/repo` slug from the local checkout's `origin` remote (#422's final resolveMergeRef
// fallback needs a repo to pair with a bare PR number — `cwd` has no such information on its own).
// Deliberately host-agnostic — NOT anchored to a literal "github.com" — because this repo's own
// `origin` is `git@myhost:ACME/example-repo.git`, an SSH config Host alias (a common setup for
// juggling multiple GitHub accounts on one box), so a github.com-anchored match would miss the
// very remote this fix is verified against. Takes the last two `/`-separated path segments before
// an optional `.git` suffix, which is `owner/repo` for both an SSH form (`host:owner/repo[.git]`)
// and an HTTPS form (`https://host/owner/repo[.git]`) regardless of what the host itself is named.
// Best-effort like `primaryWorktreeRoot`: no git, no repo, or no `origin` remote all resolve to
// null, never throw.
function repoSlugFromCwd(cwd) {
  try {
    const url = execFileSync(
      'git', ['config', '--get', 'remote.origin.url'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().replace(/\.git$/, '');
    const match = /[/:]([^/:]+)\/([^/]+)$/.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function hasApiKey() {
  const key = process.env.LIFECONTEXT_API_KEY;
  return Boolean(key) && key !== PLACEHOLDER_API_KEY;
}

function resolveConfig() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));

  // (2) sibling .env next to this script — unchanged behavior, every key.
  applyEnvFile(path.join(scriptDir, '.env'));
  if (hasApiKey()) return;

  // (3) the primary worktree's own .env (connector-scoped first, then root), fallback keys only.
  const primaryRoot = primaryWorktreeRoot(scriptDir);
  if (primaryRoot) {
    applyEnvFile(path.join(primaryRoot, 'connectors', 'gh-event-claude', '.env'), FALLBACK_KEYS);
    if (hasApiKey()) return;
    applyEnvFile(path.join(primaryRoot, '.env'), FALLBACK_KEYS);
    if (hasApiKey()) return;
  }

  // (4) ~/.life-context/.env — where this connector's spool and other connectors' cursors live.
  applyEnvFile(path.join(os.homedir(), '.life-context', '.env'), FALLBACK_KEYS);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Pull a plain-text title from either a Bash `--title "..."`/`-t "..."` flag or a parsed MCP
// response `.title`. Best-effort: a missing title just drops from text_repr, never throws.
function extractTitle(toolInput, toolResponse) {
  const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
  const flag = /(?:--title|-t)[= ]("([^"]*)"|'([^']*)'|(\S+))/.exec(command);
  if (flag) return flag[2] ?? flag[3] ?? flag[4] ?? null;
  if (typeof toolInput?.title === 'string' && toolInput.title.trim()) return toolInput.title.trim();
  const respTitle = pickFromResponse(toolResponse, 'title');
  return respTitle ?? null;
}

// MCP responses reach the hook in varying shapes (a structured object, or {content:[{text}]} with
// JSON inside). Search the object for a string field, then fall back to any embedded JSON — all
// optional-chained so an unexpected shape yields null rather than throwing.
function pickFromResponse(toolResponse, field) {
  if (toolResponse && typeof toolResponse === 'object' && typeof toolResponse[field] === 'string') {
    return toolResponse[field];
  }
  const text = stringifyResponse(toolResponse);
  const embedded = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(text);
  return embedded ? embedded[1] : null;
}

function stringifyResponse(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  try {
    return JSON.stringify(toolResponse ?? '');
  } catch {
    return '';
  }
}

// The created issue/PR URL is the anchor for source_id. Prefer an explicit `html_url` on a
// structured (MCP) response — matching the first github URL anywhere in the blob could pick up a
// link in the body/description ("Closes <url>") that precedes the created object's own link. Fall
// back to the first URL in the stringified response + Bash command; for Bash `gh` the stdout
// (prepended by the caller) is just the created URL, so first-match is the right one there.
function extractGithubUrlMatch(toolResponse, toolInput) {
  if (toolResponse && typeof toolResponse === 'object' && typeof toolResponse.html_url === 'string') {
    const fromField = GH_URL_RE.exec(toolResponse.html_url);
    if (fromField) return fromField;
  }
  const haystack = `${stringifyResponse(toolResponse)}\n${toolInput?.command ?? ''}`;
  return GH_URL_RE.exec(haystack);
}

// `mcp__github__issue_write` handles BOTH create and update; only a create is an "Opened…" event.
// (The dedicated `create_*` MCP tools and `gh … create` are creates by definition — nothing to
// check there.) An update still carries the issue's html_url, so without this guard it would be
// recorded as a phantom "Opened GitHub issue…" and pollute memory. Mirrors the gate's detection
// exactly (.claude/hooks/draft-issue-gate.sh): only an EXPLICIT non-create method is an update; a
// missing/unparseable method falls through as a create, so the two hooks agree on "a create".
function isNonCreateIssueWrite(toolName, toolInput) {
  const method = typeof toolInput?.method === 'string' ? toolInput.method : '';
  return toolName === 'mcp__github__issue_write' && method !== '' && method !== 'create';
}

// A merge is a DISTINCT event from the open (kept as a separate artifact, see below): the Bash
// `gh pr merge …` command or the MCP merge tool. Everything else the hook fires on is an "opened".
function isMergeEvent(toolName, toolInput) {
  if (toolName === 'mcp__github__merge_pull_request') return true;
  const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
  // Anchor to a command boundary (start, or after a shell separator) so the phrase inside a quoted
  // `gh pr create --title "…gh pr merge…"` can't misclassify a create as a merge.
  return /(?:^|[;&|]\s*)gh\s+pr\s+merge\b/.test(command);
}

// A merge is recorded only when it actually SUCCEEDED (Copilot #168). The MCP merge tool must
// report `merged: true` — a `{ merged: false }` (blocked/conflicting PR) is a no-op.
//
// A Bash `gh pr merge` exit code is only a PROXY for success, not proof (#324): `--delete-branch`
// can fail — "cannot delete branch used by worktree" — AFTER the merge itself succeeded, which is
// the NORMAL case here (every branch in this repo is worked in its own worktree, its mandatory
// mandatory workflow), so a non-zero exit must not be trusted as failure. Ask GitHub directly
// (`gh pr view --json state`) and record only a confirmed `MERGED`; if the check itself can't run
// (no `gh`, no auth, no network) fall back to dropping the event, same as before — a false merge is
// never recorded, and an unverifiable one is not guessed at. Deliberately NOT matching stderr text
// for the failure phrase: fragile against wording changes, and the real failure case observed here
// carried no success line to match against anyway.
async function mergeSucceeded(toolName, toolResponse, toolInput, cwd) {
  if (toolName === 'mcp__github__merge_pull_request') {
    const merged = (toolResponse && typeof toolResponse === 'object' && 'merged' in toolResponse)
      ? toolResponse.merged === true
      : /"merged"\s*:\s*true/i.test(stringifyResponse(toolResponse));
    if (!merged) console.error(`gh-event-claude: ${toolName} did not report merged:true; nothing to capture`);
    return merged;
  }
  const code = toolResponse?.exit_code ?? toolResponse?.exitCode;
  if (code == null || code === 0) return true; // clean exit — trust it, as before

  const ref = resolveMergeRef(toolResponse, toolInput, cwd);
  if (!ref) {
    console.error(`gh-event-claude: exit ${code}; no derivable PR ref to verify; nothing to capture`);
    return false;
  }
  try {
    const { stdout } = await promisify(execFile)(
      'gh', ['pr', 'view', ref.number, '--repo', ref.repoSlug, '--json', 'state', '--jq', '.state'],
      { cwd },
    );
    const state = stdout.trim();
    if (state === 'MERGED') return true;
    console.error(`gh-event-claude: exit ${code}; gh pr view reports ${state}; nothing to capture`);
    return false;
  } catch (err) {
    console.error(`gh-event-claude: exit ${code}; gh pr view could not verify merge state; nothing to capture`, err.message);
    return false;
  }
}

// Resolve { url, repoSlug, number } for a merged PR. Unlike a create, `gh pr merge` emits no full
// URL, so: prefer a real pull URL (MCP html_url / a URL in the command), then the MCP tool's
// structured {owner, repo, pullNumber}, then the "owner/repo#N" shorthand `gh pr merge` prints —
// reconstructing https://github.com/<repo>/pull/<n> — and finally (#422) the bare PR number `gh pr
// merge <n>` takes as its own argument, paired with the repo slug derived from `cwd`'s `origin`
// remote. That last fallback exists because under the Claude Code tool runner a real `gh pr merge
// <n>` invocation supplies NONE of the first three: no URL, no MCP fields, and (most plausibly
// gh's non-TTY output suppression) not even its own shorthand confirmation line — every one of
// seven real merges on 2026-07-28 was dropped this way (#422). Best-effort throughout: null when
// nothing is derivable.
function resolveMergeRef(toolResponse, toolInput, cwd) {
  const full = extractGithubUrlMatch(toolResponse, toolInput);
  if (full && full[3] === 'pull') return { url: full[0], repoSlug: `${full[1]}/${full[2]}`, number: full[4] };

  // GitHub-MCP tool inputs are inconsistent — some camelCase (pullNumber), some snake_case
  // (issue_write uses issue_number) — so accept either spelling rather than silently skip.
  const { owner, repo } = toolInput ?? {};
  const pull = toolInput?.pullNumber ?? toolInput?.pull_number;
  if (owner && repo && pull != null) {
    const repoSlug = `${owner}/${repo}`;
    return { url: `https://github.com/${repoSlug}/pull/${pull}`, repoSlug, number: String(pull) };
  }

  const haystack = `${stringifyResponse(toolResponse)}\n${toolInput?.command ?? ''}`;
  const short = GH_SHORTHAND_RE.exec(haystack);
  if (short) {
    const repoSlug = `${short[1]}/${short[2]}`;
    return { url: `https://github.com/${repoSlug}/pull/${short[3]}`, repoSlug, number: short[3] };
  }

  // Final fallback (#422): the bare PR number argument to `gh pr merge <n>` itself, boundary-
  // anchored exactly as isMergeEvent is, so this only ever fires on an actual `gh pr merge`
  // invocation. A non-numeric argument (a branch name, or a URL the strategies above already
  // handle) does not match `\d+` here and correctly yields no ref rather than a guess.
  const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
  const bare = /(?:^|[;&|]\s*)gh\s+pr\s+merge\s+(\d+)\b/.exec(command);
  if (bare) {
    const repoSlug = repoSlugFromCwd(cwd);
    if (repoSlug) {
      return { url: `https://github.com/${repoSlug}/pull/${bare[1]}`, repoSlug, number: bare[1] };
    }
  }
  return null;
}

// Current branch, best-effort — useful context on a PR. Never throws (detached HEAD, no git, …).
async function currentBranch(cwd) {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

// Best-effort resolution of the repo's default branch via the remote tracking ref, so
// attemptCount() below isn't hardcoded to "main" for every repo this connector might run
// in. Falls back to DEFAULT_BASE_BRANCH_FALLBACK when the ref can't be read (no origin,
// never fetched, shallow clone).
async function resolveDefaultBranch(cwd) {
  try {
    const { stdout } = await promisify(execFile)(
      'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd },
    );
    const short = stdout.trim(); // e.g. "origin/main"
    const branch = short.replace(/^origin\//, '');
    return branch || DEFAULT_BASE_BRANCH_FALLBACK;
  } catch {
    return DEFAULT_BASE_BRANCH_FALLBACK;
  }
}

// Attempt count is not in the transcript (#377) — it's the number of commits the merged PR
// carried. Ask GitHub, not git (#402): `gh pr merge --delete-branch` is this repo's normal
// merge form, so by the time this PostToolUse hook runs the branch is already gone locally
// AND remotely, and the git approach could only ever measure `origin/<default>..HEAD` — i.e.
// whatever the hook's cwd happened to be sitting on. That cwd is the primary checkout on the
// default branch for every merge as actually practiced here, making the count 0 (reported as
// null) essentially always. `gh pr view` still answers after the merge and after the branch
// is deleted, so it measures the PR instead of the working tree.
//
// Deliberately NOT also used to derive the lane's start: a PR's first commit lands AFTER the
// drafting and implementation that produced it, so a first-commit window measured only 52.5% of
// a real lane's weighted spend. `priorMergeBoundary` below is the start bound instead.
//
// A count of ZERO stays unknown, not a measurement: a merged PR always carries at least one
// commit, so zero means the response wasn't what we expected, and a plausible-looking 0 would
// poison the very dataset #375 exists to build. Best-effort — never throws; null degrades one
// field rather than losing the merge event.
async function attemptCountFromPr(ref, cwd) {
  if (!ref) return null;
  try {
    const { stdout } = await promisify(execFile)(
      'gh', ['pr', 'view', ref.number, '--repo', ref.repoSlug, '--json', 'commits'], { cwd },
    );
    const commits = JSON.parse(stdout)?.commits;
    return Array.isArray(commits) && commits.length > 0 ? commits.length : null;
  } catch (err) {
    console.error('gh-event-claude: could not read PR commits; attempt count unknown', err.message);
    return null;
  }
}

// Fallback attempt count from local git, used only when the `gh` lane lookup came back empty
// (no network, no auth). Same zero-is-unknown rule, and the same caveat that it measures the
// hook's cwd rather than the PR — which is exactly why it is the fallback and not the primary.
async function attemptCountFromGit(cwd) {
  try {
    const defaultBranch = await resolveDefaultBranch(cwd);
    const { stdout } = await promisify(execFile)(
      'git', ['rev-list', '--count', `origin/${defaultBranch}..HEAD`], { cwd },
    );
    const count = Number(stdout.trim());
    return Number.isInteger(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

// The four usage fields the transcript carries per assistant turn, and their pricing-table
// keys — priced separately (5.00 / 6.25 / 0.50 / 25.00 USD per MTok on Opus 5) because a
// single summed number can't be re-priced later and cache traffic can dwarf output (#377:
// on one measured session, output was 10% of spend and cache traffic was 90%).
const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

// The TTL breakdown of `cache_creation_input_tokens`, carried by the transcript as
// `message.usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`. Recorded as their
// own fields (not derived at read time) because the two TTLs price differently and the total
// alone cannot be re-priced later — the same reasoning that keeps the four fields above
// separate. Absent on older transcripts, which report only the total; `computeCostUsd` falls
// back to the 5-minute rate for whatever the breakdown doesn't account for.
const CACHE_TTL_FIELDS = ['cache_creation_5m_input_tokens', 'cache_creation_1h_input_tokens'];
const ALL_USAGE_FIELDS = [...USAGE_FIELDS, ...CACHE_TTL_FIELDS];

function zeroUsage() {
  return Object.fromEntries(ALL_USAGE_FIELDS.map((field) => [field, 0]));
}

// True when every counted field is 0 — a group that costs exactly $0 under ANY rate table,
// priced or not (#437). `<synthetic>` (the harness's interrupted-turn marker) is the motivating
// case, but this deliberately checks the usage, not the model name: keying on the literal string
// `<synthetic>` would fix today's symptom and miss the next pseudo-model the harness introduces.
function isZeroUsage(usage) {
  return ALL_USAGE_FIELDS.every((field) => usage[field] === 0);
}

// A model/effort switch mid-session (a retry on a different model, an escalated effort) means
// two DIFFERENT rates applied to two DIFFERENT slices of the same transcript — collapsing to
// one model/effort would credit the whole session to whichever end happened to be last-seen,
// and (worse than a labelling error) `computeCostUsd` would then price every token at that ONE
// model's rate even for turns that ran on a different model entirely, producing a wrong number
// with no indication anything was collapsed (#377 follow-up). So usage is grouped by the
// (model, effort) pair the transcript actually reports; each group is priced independently.
// Delegated work is grouped separately too (#402): a subagent runs on its own model at its own
// effort, so folding it into the main thread's group would blend two rates AND hide the very
// comparison #375 is asking for — is delegating to a cheaper tier actually cheaper? The key uses
// the per-invocation agent id (null for the main thread), not the agent TYPE, so two runs of the
// same agent type stay separate groups and one expensive delegation cannot hide inside an average.
function groupKey(model, effort, agentId) {
  return `${model ?? ''}|${effort ?? ''}|${agentId ?? ''}`; // '|' can't appear in any of them
}

// A delegated subagent's turns are NOT in the session transcript (#402). Hooks fire inside
// subagents and the hook input's `transcript_path` points at the MAIN session transcript, but
// the subagent writes its own file in a sibling directory:
//
//   <dir>/<session-id>.jsonl              <- transcript_path
//   <dir>/<session-id>/subagents/agent-*.jsonl   <- one per delegated agent
//
// No `isSidechain:true` line ever appears in the parent file, so reading only `transcript_path`
// misses 100% of delegated spend — silently, with no null to signal it (measured 16% aggregate
// understatement across 8 sessions, 1-61% per session). Derived from the transcript path rather
// than guessed; a missing directory is the normal undelegated case and yields [] rather than an
// error, so behavior is unchanged for a session that delegated nothing.
async function subagentTranscriptPaths(transcriptPath) {
  if (!transcriptPath) return [];
  const dir = path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, path.extname(transcriptPath)),
    'subagents',
  );
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.jsonl'))
      .sort() // deterministic order so two runs produce byte-identical output
      .map((name) => path.join(dir, name));
  } catch {
    return []; // no subagents dir — an undelegated session, not a failure
  }
}

// True when `timestamp` falls inside the lane window. A missing window means "no window" (every
// entry counts); an entry with no parsable timestamp is KEPT rather than dropped — losing real
// spend to a formatting surprise would understate, and understating is the failure #402 exists
// to fix. Errs toward over-inclusion, which `scope` then names honestly.
function withinWindow(timestamp, windowStart) {
  if (!windowStart) return true;
  const t = Date.parse(timestamp ?? '');
  if (!Number.isFinite(t)) return true;
  return t >= Date.parse(windowStart);
}

// Reads a Claude Code session transcript (JSONL) and, for every distinct (model, effort) pair
// the transcript reports, sums token usage across that pair's assistant turns. Streams
// line-by-line via readline over a fs.createReadStream — never reads the whole file into
// memory — so an arbitrarily large transcript is safe to process (#377). A single API response
// with multiple content blocks (e.g. a thinking block followed by a text block) is logged as
// SEPARATE JSONL lines that repeat the SAME message.id and usage totals; summing every line
// would multiply usage by the block count, so this dedups by message.id (the actual API
// response identity) before summing — each message.id is assigned to exactly one (model,
// effort) group, the pair reported on its first-seen line. Missing or unreadable file, or a
// transcript with no assistant turns, returns null (never throws) so the caller degrades to
// recording the merge event without cost data.
// Accumulates one JSONL file's assistant turns into `groups`, honoring the lane window. Shared
// by the main transcript and every subagent file so the parsing rules can't drift between them:
// one unreadable file logs and returns false, leaving the others' totals intact (per-source
// best-effort, the same posture as every other input here).
async function accumulateUsage(file, { groups, seenMessageIds, branches, windowStart, agent }) {
  try {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // one malformed line doesn't sink the whole transcript
      }
      if (!withinWindow(entry?.timestamp, windowStart)) continue;
      // Which branches the window spans — the `interleaved` signal. Collected from EVERY
      // in-window line, not just assistant turns, so a lane switch is seen even if the other
      // lane's turns happen to fall outside the window.
      if (typeof entry?.gitBranch === 'string' && entry.gitBranch) branches.add(entry.gitBranch);
      const msg = entry?.message;
      if (!msg || msg.role !== 'assistant' || !msg.usage || !msg.id || seenMessageIds.has(msg.id)) continue;
      seenMessageIds.add(msg.id);
      const model = typeof msg.model === 'string' ? msg.model : null;
      const effort = typeof entry.effort === 'string' ? entry.effort : null;
      const key = groupKey(model, effort, agent?.agentId);
      let group = groups.get(key);
      if (!group) {
        group = {
          model,
          effort,
          agentId: agent?.agentId ?? null,
          agentType: agent?.agentType ?? null,
          turnCount: 0,
          usage: zeroUsage(),
        };
        groups.set(key, group);
      }
      group.turnCount += 1;
      for (const field of USAGE_FIELDS) {
        const value = msg.usage[field];
        if (typeof value === 'number') group.usage[field] += value;
      }
      // The per-TTL breakdown sits one level down, and only on newer transcripts. Note a
      // subagent writes 5m-TTL cache where the main loop writes 1h — measured, and the reason
      // the unsplit fallback in computeCostUsd stays at the 5m rate.
      const creation = msg.usage.cache_creation;
      if (creation && typeof creation === 'object') {
        if (typeof creation.ephemeral_5m_input_tokens === 'number') {
          group.usage.cache_creation_5m_input_tokens += creation.ephemeral_5m_input_tokens;
        }
        if (typeof creation.ephemeral_1h_input_tokens === 'number') {
          group.usage.cache_creation_1h_input_tokens += creation.ephemeral_1h_input_tokens;
        }
      }
    }
    return true;
  } catch (err) {
    console.error('gh-event-claude: a transcript file was unreadable; its usage is omitted', err.message);
    return false;
  }
}

// Where this PR's lane starts, in transcript time (#402, option b — a timestamp window, no new
// state). NOT the PR's first commit: a lane's drafting and implementation happen BEFORE its first
// commit, so a first-commit window measured only 52.5% of a real lane's weighted spend — an
// undercount of the same order as the subagent gap this issue exists to close. The boundary that
// does capture the whole lane is the PREVIOUS `gh pr merge` in this same session: everything since
// the last thing that landed is this lane's work. Returns null when this is the session's first
// merge, meaning "no lower bound" — the whole session so far IS this lane.
//
// Scans for a Bash/PowerShell tool_use naming `gh pr merge` for a DIFFERENT PR number than the one
// merging now, boundary-anchored the same way isMergeEvent is; the current merge's own tool_use
// line (which may or may not be flushed to the transcript yet) is excluded by that number compare,
// so this is stable regardless of write timing. Best-effort: unreadable file yields null (no
// bound), which degrades to session-to-date rather than losing the record.
async function priorMergeBoundary(transcriptPath, currentNumber) {
  if (!transcriptPath) return null;
  let latest = null;
  try {
    const rl = createInterface({ input: createReadStream(transcriptPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('gh pr merge')) continue; // cheap prefilter before the JSON parse
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const blocks = entry?.message?.content;
      if (!Array.isArray(blocks) || !entry.timestamp) continue;
      for (const block of blocks) {
        const command = block?.type === 'tool_use' ? block?.input?.command : null;
        if (typeof command !== 'string') continue;
        if (!/(?:^|[;&|])\s*gh\s+pr\s+merge\b/.test(command)) continue;
        const merged = /gh\s+pr\s+merge\s+(\d+)/.exec(command);
        if (merged && merged[1] === String(currentNumber)) continue; // this very merge
        if (!latest || Date.parse(entry.timestamp) > Date.parse(latest)) latest = entry.timestamp;
      }
    }
  } catch (err) {
    console.error('gh-event-claude: could not scan for a prior merge boundary; scoping to the session', err.message);
    return null;
  }
  return latest;
}

// How many leading lines to scan for a subagent's identity fields. They appear within the first
// few entries; a bound keeps this from streaming a large transcript twice just for a label.
const AGENT_IDENTITY_SCAN_LINES = 200;

// A subagent transcript's identity: the opaque per-invocation `agentId` and the human-meaningful
// `attributionAgent` type (e.g. "general-purpose"). BOTH are recorded, because they answer
// different questions and neither substitutes for the other: the id keeps two invocations of the
// same agent type in separate breakdown groups (so one expensive delegation stays visible), while
// the type is what a later "is delegating to a cheaper tier actually cheaper?" analysis groups by.
// They do not appear on the same line — `agentId` is on the first entry and `attributionAgent`
// shows up later — so this scans rather than reading one line, and takes the first value seen for
// each. Falls back to the file's basename for the id so a group is never anonymous; a missing type
// stays null rather than being guessed at.
async function readAgentIdentity(file) {
  let agentId = null;
  let agentType = null;
  // Held so the early exit can destroy it: rl.close() stops readline but does NOT tear down the
  // underlying fd, and this is the one reader here that stops before EOF.
  const stream = createReadStream(file, { encoding: 'utf8' });
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let scanned = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!agentId && typeof entry.agentId === 'string' && entry.agentId) agentId = entry.agentId;
      const type = entry.attributionAgent ?? entry.agentName;
      if (!agentType && typeof type === 'string' && type) agentType = type;
      if ((agentId && agentType) || ++scanned >= AGENT_IDENTITY_SCAN_LINES) {
        rl.close();
        break;
      }
    }
  } catch {
    // fall through to the basename
  } finally {
    stream.destroy();
  }
  return { agentId: agentId ?? path.basename(file, '.jsonl'), agentType };
}

// Reads a Claude Code session transcript (JSONL) PLUS every delegated subagent transcript, and
// for each distinct (model, effort, agentType) triple sums token usage across that group's
// assistant turns. Streams line-by-line via readline over a fs.createReadStream — never reads a
// whole file into memory — so an arbitrarily large transcript is safe to process (#377).
//
// A single API response with multiple content blocks (e.g. a thinking block followed by a text
// block) is logged as SEPARATE JSONL lines that repeat the SAME message.id and usage totals;
// summing every line would multiply usage by the block count, so this dedups by message.id (the
// actual API response identity) before summing — each message.id is assigned to exactly one
// group, the triple reported on its first-seen line. The dedup set is shared across files, since
// a parent and a subagent file never share a message.id but sharing the set costs nothing and
// makes double-counting impossible by construction.
//
// `windowStart` scopes the tally to this PR's lane (#402): without it, the whole session from
// line 1 is charged to whichever PR happens to merge, so a session merging N PRs records ~1x,
// ~2x, ... ~Nx cumulatively. Missing file, or no assistant turns in window, returns null (never
// throws) so the caller degrades to recording the merge event without cost data.
async function readSessionUsage(transcriptPath, windowStart) {
  if (!transcriptPath) return null;
  const seenMessageIds = new Set();
  const groups = new Map();
  const branches = new Set();
  const mainOk = await accumulateUsage(transcriptPath, {
    groups, seenMessageIds, branches, windowStart, agent: null,
  });
  if (!mainOk) return null; // the main transcript is the one file whose loss voids the record

  const subagentFiles = await subagentTranscriptPaths(transcriptPath);
  for (const file of subagentFiles) {
    await accumulateUsage(file, {
      groups, seenMessageIds, branches, windowStart, agent: await readAgentIdentity(file),
    });
  }

  const turnCount = [...groups.values()].reduce((sum, g) => sum + g.turnCount, 0);
  if (turnCount === 0) return null;
  return {
    groups: [...groups.values()],
    turnCount,
    subagentCount: subagentFiles.length,
    branchCount: branches.size,
  };
}

const RATE_FIELDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];

// A rate set is usable only when EVERY field is a finite number. GH_EVENT_MODEL_PRICING_JSON is
// user-supplied and replaces the table wholesale, so a partial override (e.g. carrying the old
// single `cacheWrite` key) would otherwise multiply tokens by `undefined` and yield NaN — which
// JSON.stringify happens to serialize as null, making a malformed override look identical to an
// honestly-unpriceable model. Reject it up front and log, so the gap is visible rather than lucky.
function isCompleteRateSet(rates) {
  if (!rates || typeof rates !== 'object') return false;
  const missing = RATE_FIELDS.filter((field) => !Number.isFinite(rates[field]));
  if (missing.length) {
    console.error(`gh-event-claude: pricing entry missing numeric field(s) ${missing.join(', ')}; cost not computed`);
    return false;
  }
  return true;
}

// USD cost of one usage tally at the given per-MTok rates, or null when the model wasn't
// recognized or its rate set is incomplete (a rate gap must never be silently priced at 0,
// guessed, or emitted as NaN).
//
// Cache writes are priced per TTL: the 5-minute and 1-hour tallies each bill at their own
// rate. Anything the transcript reported as a cache-write total but did NOT break down by
// TTL bills at the 5-minute rate — the conservative choice, and the only one available for
// an older transcript that carries no `cache_creation` sub-object. `Math.max(0, ...)` guards
// a breakdown that somehow exceeds its own total rather than subtracting a negative back in.
function computeCostUsd(usage, rates) {
  if (!isCompleteRateSet(rates)) return null;
  const splitCacheWrite = usage.cache_creation_5m_input_tokens + usage.cache_creation_1h_input_tokens;
  const unsplitCacheWrite = Math.max(0, usage.cache_creation_input_tokens - splitCacheWrite);
  const cost = (usage.input_tokens * rates.input
    + usage.cache_creation_5m_input_tokens * rates.cacheWrite5m
    + usage.cache_creation_1h_input_tokens * rates.cacheWrite1h
    + unsplitCacheWrite * rates.cacheWrite5m
    + usage.cache_read_input_tokens * rates.cacheRead
    + usage.output_tokens * rates.output) * USD_PER_MTOK_TO_PER_TOKEN;
  return Math.round(cost * 1e6) / 1e6; // micro-dollar precision, not floating-point noise
}

// Deterministic, diffable ordering for the breakdown array: highest cost first (an unpriced
// group's null cost sorts as the lowest, i.e. last), tie-broken by model then effort so two
// runs over the same transcript always produce byte-identical output.
function compareBreakdownEntries(a, b) {
  const aCost = a.cost_usd ?? -Infinity;
  const bCost = b.cost_usd ?? -Infinity;
  if (aCost !== bCost) return bCost - aCost;
  const aModel = a.model ?? '';
  const bModel = b.model ?? '';
  if (aModel !== bModel) return aModel < bModel ? -1 : 1;
  const aEffort = a.effort ?? '';
  const bEffort = b.effort ?? '';
  if (aEffort !== bEffort) return aEffort < bEffort ? -1 : 1;
  const aAgent = `${a.agent_type ?? ''}|${a.agent_id ?? ''}`;
  const bAgent = `${b.agent_type ?? ''}|${b.agent_id ?? ''}`;
  if (aAgent !== bAgent) return aAgent < bAgent ? -1 : 1;
  return 0;
}

function sumUsage(usageList) {
  const total = zeroUsage();
  for (const usage of usageList) {
    for (const field of ALL_USAGE_FIELDS) total[field] += usage[field];
  }
  return total;
}

// Assembles the merged-PR cost record (#377): attempt count from the branch's commit
// history, and — per distinct (model, effort) group in the transcript — the token spend and
// its own USD cost at that model's rates ("Cost per merged PR is derivable per model/effort
// combination", the issue's own acceptance criterion). Never throws — every input source is
// independently best-effort, so a missing transcript or an unresolvable branch degrades to a
// null field rather than losing the rest of the record (or the merge event itself).
//
// `total_cost_usd` is the sum of the groups' costs, but ONLY when every group priced AND the
// window is known clean (#438) — if even one group's model has no pricing entry, or the window is
// `interleaved` (regardless of `scope` — a bound-less `session-to-date` first merge is NOT, by
// itself, a withholding trigger), the total goes null (`total_cost_usd_reason` names which) rather
// than silently reporting a number that reads as complete or as this PR's own. Every group's own
// `cost_usd` in `breakdown` stays populated where known regardless, so
// the raw evidence isn't lost, just not blindly totalled or misattributed. Top-level `model`/
// `effort` are the single value when the transcript is homogeneous (exactly one group) and null
// the moment it isn't — a consumer reading `cost.model` must never be told a mixed-model/mixed-
// effort session was one thing; `breakdown` is always present (an empty array when there's no
// transcript data at all) so nothing is lost behind the null.
async function buildMergeCost(cwd, transcriptPath, ref) {
  // The attempt count (a `gh` network round-trip) and the window boundary (a local transcript
  // scan) are independent, so they overlap — this hook runs inline on the user's merge and a
  // needlessly serial ~1s API call would just be latency in their terminal. `readSessionUsage`
  // below cannot join them: it consumes the window.
  const [attemptsFromPr, windowStart] = await Promise.all([
    attemptCountFromPr(ref, cwd),
    priorMergeBoundary(transcriptPath, ref?.number),
  ]);
  const attempts = attemptsFromPr ?? await attemptCountFromGit(cwd);
  const sessionUsage = await readSessionUsage(transcriptPath, windowStart);
  // `scope` names what the totals actually cover, so a consumer can never mistake a
  // whole-session number for a per-PR one. That mistake is what makes a cost dataset worse
  // than no dataset, so it is a recorded field rather than an assumption. `since-prior-merge`
  // is a true per-lane slice; `session-to-date` means this was the session's first merge, so
  // the two coincide.
  const scope = windowStart ? 'since-prior-merge' : 'session-to-date';
  if (!sessionUsage) {
    return {
      attempt_count: attempts,
      scope,
      window_start: windowStart,
      interleaved: null,
      subagent_count: null,
      model: null,
      effort: null,
      review_tier: null, // reserved for #380 (review-tier attribution) — not yet populated
      turn_count: null,
      usage: null,
      total_cost_usd: null,
      total_cost_usd_reason: null, // no transcript data at all — neither withheld case applies (#438)
      breakdown: [],
    };
  }

  const breakdown = sessionUsage.groups
    .map((group) => {
      const rates = group.model ? MODEL_PRICING_USD_PER_MTOK[group.model] : null;
      // An all-zero-usage group (e.g. `<synthetic>`, the harness's interrupted-turn marker)
      // costs exactly $0 regardless of whether its model resolves in the rate table — no rate
      // lookup can make a zero-token group cost anything else. Priced here rather than
      // `allPriced` below treating it as unpriceable, which used to null the WHOLE total even
      // though every real group priced fine (#437). Emitted at cost_usd:0 rather than dropped
      // from `breakdown` entirely — the smaller change, and it keeps the group's `turn_count`
      // (so the interrupted turn stays visible) without losing any information a consumer might
      // want; revisit if zero rows prove noisy in practice.
      const cost_usd = isZeroUsage(group.usage) ? 0 : computeCostUsd(group.usage, rates);
      return {
        model: group.model,
        effort: group.effort,
        agent_type: group.agentType, // null = the main thread; else the agent TYPE (#402)
        agent_id: group.agentId,     // null = the main thread; else the per-invocation id
        turn_count: group.turnCount,
        usage: group.usage,
        cost_usd,
      };
    })
    .sort(compareBreakdownEntries);

  const allPriced = breakdown.every((entry) => entry.cost_usd !== null);
  // More than one branch inside the window means the session was working two lanes at once, so
  // this PR's slice still includes some of the other's spend.
  const interleaved = sessionUsage.branchCount > 1;
  // #438: a wrong number is worse than an absent one — "one PR per session" isn't how this repo is
  // actually worked, so the total is withheld (not trusted as this PR's own cost) whenever the
  // window is KNOWN to be contaminated. `interleaved` is the known signal — it fires regardless of
  // `scope`: PR #435's contamination showed up as `since-prior-merge` + `interleaved:true` (other
  // subagents' work inside a bounded window), and PR #430's showed up as `session-to-date` +
  // `interleaved:true` (a session-to-date window is unbounded on the low end, but what made it
  // wrong in that real case was the same branch-diversity signal, not the lack of a bound by
  // itself — a `session-to-date` window that never left one branch is the normal shape of a short,
  // single-PR session and must still report a real number, or the fix empties the dataset for the
  // common case). `breakdown` still carries every group's own priced spend either way, so the raw
  // evidence is never lost, only the misleading single total is withheld. True lane attribution (a
  // signal transcripts don't carry yet) is out of scope here — see #438's Design Decisions.
  const contaminated = interleaved;
  let totalCostUsd = null;
  let totalCostUsdReason = null;
  if (contaminated) {
    totalCostUsdReason = 'contaminated_window';
  } else if (!allPriced) {
    totalCostUsdReason = 'unpriced_group'; // a group's model has no rate at all (companion issue)
  } else {
    totalCostUsd = Math.round(breakdown.reduce((sum, entry) => sum + entry.cost_usd, 0) * 1e6) / 1e6;
  }
  const homogeneous = breakdown.length === 1;

  return {
    attempt_count: attempts,
    scope,
    window_start: windowStart,
    // Reported rather than hidden: it is the residual error of the timestamp-window approach
    // (#402's chosen option b), and a consumer filtering for clean measurements needs to see it.
    // One of the two signals `total_cost_usd_reason` (below) treats as contaminated.
    interleaved,
    subagent_count: sessionUsage.subagentCount,
    model: homogeneous ? breakdown[0].model : null,
    effort: homogeneous ? breakdown[0].effort : null,
    review_tier: null, // reserved for #380 (review-tier attribution) — not yet populated
    turn_count: sessionUsage.turnCount,
    usage: sumUsage(sessionUsage.groups.map((g) => g.usage)),
    total_cost_usd: totalCostUsd,
    // #438: null exactly when total_cost_usd is null, naming WHY so the two null causes are never
    // confused: 'contaminated_window' (this window can't be trusted as one PR's own work) vs
    // 'unpriced_group' (every group's spend is known, but one couldn't be priced at all).
    total_cost_usd_reason: totalCostUsdReason,
    breakdown,
  };
}

async function postIngest(payload) {
  const res = await fetch(`${LIFECONTEXT_URL}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LIFECONTEXT_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ingest returned ${res.status}`);
  return res.json();
}

async function spool(payload) {
  await mkdir(path.dirname(SPOOL_PATH), { recursive: true });
  await appendFile(SPOOL_PATH, `${JSON.stringify(payload)}\n`);
}

// Flush any payloads a prior server-unreachable run couldn't deliver, before the current event —
// the connector contract's failure posture (doc 04 §7): lose at most the uncommitted window.
async function flushSpool() {
  let lines;
  try {
    lines = (await readFile(SPOOL_PATH, 'utf8')).split('\n').filter((l) => l.trim());
  } catch {
    return; // no spool file yet
  }
  const remaining = [];
  for (const line of lines) {
    try {
      await postIngest(JSON.parse(line));
    } catch {
      remaining.push(line);
    }
  }
  if (remaining.length) await writeFile(SPOOL_PATH, `${remaining.join('\n')}\n`);
  else await rm(SPOOL_PATH, { force: true });
}

async function main() {
  const hookInput = JSON.parse(await readStdin());
  const {
    tool_name: toolName, tool_input: toolInput, tool_response: toolResponse, cwd,
    transcript_path: transcriptPath,
  } = hookInput;

  // Skip issue_write updates before touching the response — an update is not an "Opened" event.
  if (isNonCreateIssueWrite(toolName, toolInput)) {
    console.error(`gh-event-claude: ${toolName} method=${toolInput?.method} is not a create; nothing to capture`);
    return;
  }

  // Two actions: a merge (its own artifact) or an open. Both anchor on the PR/issue URL; no URL
  // means nothing to remember (a failed create, an update, or an undecipherable merge).
  const merge = isMergeEvent(toolName, toolInput);
  if (merge && !(await mergeSucceeded(toolName, toolResponse, toolInput, cwd))) {
    return; // mergeSucceeded already logged the specific reason
  }
  let url, repoSlug, number, kind;
  if (merge) {
    const ref = resolveMergeRef(toolResponse, toolInput, cwd);
    if (!ref) {
      console.error(`gh-event-claude: could not resolve merged PR ref from ${toolName}; nothing to capture`);
      return;
    }
    ({ url, repoSlug, number } = ref);
    kind = 'pr';
  } else {
    const urlMatch = extractGithubUrlMatch(toolResponse, toolInput);
    if (!urlMatch) {
      console.error(`gh-event-claude: no issue/PR URL in ${toolName} result; nothing to capture`);
      return;
    }
    const [matchedUrl, owner, repo, kindPath, matchedNumber] = urlMatch;
    url = matchedUrl;
    repoSlug = `${owner}/${repo}`;
    number = matchedNumber;
    kind = kindPath === 'pull' ? 'pr' : 'issue';
  }
  const title = extractTitle(toolInput, toolResponse);
  const branch = kind === 'pr' ? await currentBranch(cwd) : null;

  // Cost instrumentation (#377) is scoped to a merged PR — that's the falsifiable unit the
  // harness-cost epic (#375) needs, and the "opened" artifact's shape stays untouched. Never
  // let a cost-computation failure drop the merge event itself: catch here, log, and record
  // the merge with cost fields null rather than losing the event over a git/fs hiccup.
  let cost = null;
  if (merge) {
    try {
      // `{ repoSlug, number }` rather than the block-scoped `ref` above — same two fields the
      // PR lookup needs, and they're already resolved for the payload.
      cost = await buildMergeCost(cwd, transcriptPath, { repoSlug, number });
    } catch (err) {
      console.error('gh-event-claude: cost instrumentation failed, recording merge without it', err);
    }
  }

  await flushSpool().catch((err) => console.error('gh-event-claude: spool flush failed', err));

  const action = merge ? 'merged' : 'opened';
  const verb = merge ? 'Merged' : 'Opened';
  const label = kind === 'pr' ? 'pull request' : 'issue';
  const titlePart = title ? ` "${title}"` : '';
  const branchPart = branch ? ` (branch ${branch})` : '';
  const textRepr = `${verb} GitHub ${label} #${number}${titlePart} in ${repoSlug}${branchPart}. ${url}`;
  // A merge keys on a DISTINCT source_id ("<url>#merged") so it never upserts over the "Opened"
  // artifact for the same PR — both events coexist. An open keys on the bare URL as before.
  const sourceId = merge ? `${url}#merged` : url;

  const payload = {
    source: SOURCE,
    source_id: sourceId, // reproducible + globally unique → re-fire upserts, never duplicates
    type: EVENT_TYPE,
    text_repr: textRepr,
    occurred_at: new Date().toISOString(),
    extra: {
      kind, action, number: Number(number), url, repo: repoSlug, branch, tool_name: toolName, title,
      ...(merge ? { cost } : {}), // attempt count + token spend + model/effort — merges only
    },
  };

  // The key check moves here — AFTER the payload is built (#324) — so a config gap spools the
  // event instead of dropping it silently: the connector contract's failure posture (doc 04 §7) is
  // to lose at most the uncommitted window, and a missing/unresolved key is exactly that case, not
  // a reason to skip capturing the event at all.
  if (!hasApiKey()) {
    console.error('gh-event-claude: no API key resolved; spooled 1 event for a later run');
    await spool(payload);
    return;
  }

  try {
    await postIngest(payload);
  } catch (err) {
    console.error('gh-event-claude: ingest failed, spooling for next run', err);
    await spool(payload);
  }
}

main()
  .catch((err) => console.error('gh-event-claude: unexpected error', err))
  .finally(() => process.exit(0)); // never hang or fail the user's terminal
