#!/usr/bin/env node
// Claude Code `SessionStart` hook (#407). Fetches the operator's stored `x-agent-preference` memories
// from LifeContext and prints them to stdout, which the harness injects into the new session's
// context — a deterministic push, not a probabilistic "remember to search" instruction. Register
// on ALL FIVE matchers (startup|resume|clear|compact|fork, see README.md) so a `/clear` or
// `/compact` session gets preferences too, not only a fresh `startup`.
//
// Mirrors gh-event-claude's config-resolution fallback chain and never-block posture (doc
// 04-connector-contract.md §7 "Failure posture"): every failure path (no key, server down,
// non-2xx, malformed JSON, timeout) prints nothing and exits 0. A SessionStart hook that hangs or
// crashes is worse than the preferences-don't-reach-a-session bug it exists to fix.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_API_KEY = 'change-this-to-a-long-secure-token';
// Ordered config resolution (#324, doc 04's connector-contract failure posture) — identical
// shape to gh-event-claude's resolveConfig: (1) process env; (2) this script's own sibling
// `.env`; (3) the PRIMARY worktree's `connectors/preferences-claude/.env`, then its root `.env`
// (a `git worktree` checkout never carries the gitignored `.env`, and every branch in this repo
// is worked in its own worktree — this project's mandatory workflow); (4) `~/.life-context/.env`,
// where every other connector's fallback config already lives. Only `LIFECONTEXT_URL`/
// `LIFECONTEXT_API_KEY` are adopted from a fallback file — never a whole root `.env`.
const FALLBACK_KEYS = ['LIFECONTEXT_URL', 'LIFECONTEXT_API_KEY'];

resolveConfig();

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;

// The dedicated marker type this hook reads back (#407's design decision — an `x-` extension,
// discoverable via `list_types`, excluded from untyped recall). Fixed, not env-configurable:
// changing it would silently stop reading what npm run migrate-preferences.js wrote.
const PREFERENCE_TYPE = 'x-agent-preference';
// Fixed, descriptive query text. The `/api/search` route requires a non-empty query, but with an
// explicit `types` filter the SQL prefilter (src/search.js candidateStmt) already constrains the
// candidate set to PREFERENCE_TYPE rows before ranking — as long as SEARCH_LIMIT is generous
// enough to exceed the number of stored preferences, every one of them comes back regardless of
// how this query text ranks them, so its exact wording isn't load-bearing.
const PREFERENCE_QUERY = 'working preferences for how the assistant should behave';
// /api/search's own LimitSchema hard-caps at 50 (src/server.js's limitSchema: z.number().int()
// .min(1).max(50)) — a higher value 422s the whole request, which this hook would then treat as
// just another failure (silent, per its contract) rather than the generous ceiling it looks like.
// So the default IS that cap, and an env override is clamped to it rather than trusted verbatim.
const SEARCH_LIMIT_MAX = 50;
const SEARCH_LIMIT = Math.min(envNumber('PREFERENCES_SEARCH_LIMIT', SEARCH_LIMIT_MAX), SEARCH_LIMIT_MAX);
// Named + env-overridable (issue #407). This bounds a genuinely unreachable/hung server, NOT a
// working-but-slow one. Originally sized at 15s to cover /api/search's query-planner LLM call
// (measured ~7s warm/empty, ~9s with rows, on this box) plus an embedding call, both real network
// hops with their own generous budgets (QUERY_PLAN_TIMEOUT_MS defaults to 20s, EMBED_TIMEOUT_MS to
// 60s in src/config.js). #433 removes that planner call from this connector's own request
// (`use_planner: false` below — this fetch already supplies every filter it needs, `types`), so
// the same warm call now completes in well under 1500ms; 15000 is left as-is rather than tightened
// in the same change, since it's still the right bound for a genuinely unreachable/hung server and
// tightening it is a separate, non-motivating decision. A short timeout here would silently "fail"
// on every ordinary run, which is worse than the bug #407 exists to fix. An unreachable server
// (connection refused/DNS failure) still fails in milliseconds regardless.
const CONNECT_TIMEOUT_MS = envNumber('PREFERENCES_TIMEOUT_MS', 15000);

function envNumber(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : dflt;
}

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

function hasApiKey() {
  const key = process.env.LIFECONTEXT_API_KEY;
  return Boolean(key) && key !== PLACEHOLDER_API_KEY;
}

function resolveConfig() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));

  // (2) sibling .env next to this script — every key.
  applyEnvFile(path.join(scriptDir, '.env'));
  if (hasApiKey()) return;

  // (3) the primary worktree's own .env (connector-scoped first, then root), fallback keys only.
  const primaryRoot = primaryWorktreeRoot(scriptDir);
  if (primaryRoot) {
    applyEnvFile(path.join(primaryRoot, 'connectors', 'preferences-claude', '.env'), FALLBACK_KEYS);
    if (hasApiKey()) return;
    applyEnvFile(path.join(primaryRoot, '.env'), FALLBACK_KEYS);
    if (hasApiKey()) return;
  }

  // (4) ~/.life-context/.env — where every other connector's fallback config already lives.
  applyEnvFile(path.join(os.homedir(), '.life-context', '.env'), FALLBACK_KEYS);
}

// Fetches stored preference text from LifeContext. Every failure (no key, unreachable server,
// non-2xx, a timeout, a malformed/unexpected body shape) resolves to an empty array rather than
// throwing — this is the ONLY function main() calls before printing, so a failure here must
// degrade to silence, never a thrown error or a hung process.
async function fetchPreferences() {
  if (!hasApiKey()) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${LIFECONTEXT_URL}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': LIFECONTEXT_API_KEY },
      // use_planner:false (#433) — this call already supplies its one filter (types), so the
      // LLM query-planner call (the ~7-9s cost measured above) is pure waste here every session
      // start; lexicalPlanHints (#352) still runs server-side but this query has no literal kind
      // word or place phrase to gap-fill from, so it's a no-op either way.
      body: JSON.stringify({ query: PREFERENCE_QUERY, types: [PREFERENCE_TYPE], limit: SEARCH_LIMIT, use_planner: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`preferences-claude: search returned ${res.status}; no preferences printed`);
      return [];
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.results)) {
      console.error('preferences-claude: unexpected search response shape; no preferences printed');
      return [];
    }
    // display_text (annotated for display, #147) falls back to text_repr (what was actually
    // embedded) — a preference artifact carries no entity handles to annotate, so these are
    // normally identical, but display_text is the documented read-time field to prefer.
    return data.results
      .map((r) => (typeof r?.display_text === 'string' && r.display_text.trim())
        || (typeof r?.text_repr === 'string' && r.text_repr.trim())
        || null)
      .filter((text) => Boolean(text));
  } catch (err) {
    // Absolute rule 7: no preference text here. `err.name` (TypeError / SyntaxError / AbortError)
    // and NOT `err.message` — a malformed body makes res.json() throw a SyntaxError whose message
    // quotes a snippet of that body, which is exactly the preference text this must never log.
    console.error(`preferences-claude: search request failed (${err.name}); no preferences printed`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const preferences = await fetchPreferences();
  if (!preferences.length) return; // empty result (or any failure above) — print nothing

  // ONE write, awaited to completion, rather than a console.log per line. stdout is a pipe when
  // the harness invokes this as a hook, and a pipe write is buffered asynchronously — the
  // process.exit(0) below does NOT wait for that flush, so a multi-line console.log sequence can
  // be truncated mid-preference on exit. Awaiting the write callback is what makes the exit safe;
  // dropping the exit instead is not an option (undici's keep-alive socket from the fetch above
  // can hold the event loop open, and a SessionStart hook that lingers delays every session).
  const lines = ['Stored agent preferences from LifeContext (apply these without being asked):'];
  // Each preference is ONE bullet, so any newline inside it must collapse to a space — otherwise
  // its continuation lines read as separate, unbulleted items. Not hypothetical: the companion
  // scripts/migrate-preferences.js appends "\n\n(Supersedes artifact N.)" to every record it
  // writes, so every migrated preference arrives multi-line.
  for (const preference of preferences) lines.push(`- ${preference.replace(/\s*\n\s*/g, ' ')}`);
  await new Promise((resolve) => process.stdout.write(`${lines.join('\n')}\n`, resolve));
}

main()
  // Constant + err.name only, never the message/stack — same reasoning as fetchPreferences' catch.
  .catch((err) => console.error(`preferences-claude: unexpected error (${err?.name ?? 'Error'})`))
  .finally(() => process.exit(0)); // never hang or fail session start
