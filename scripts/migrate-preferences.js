#!/usr/bin/env node
/**
 * One-shot migration (#407): re-store the four existing untyped `note` preferences under the
 * dedicated `x-agent-preference` marker type, so a `types`-filtered search — and the
 * preferences-claude SessionStart hook — can read them back deterministically instead of getting
 * lost among ~188 other notes (see the issue's Problem section for the measured numbers).
 *
 * The untyped originals are left untouched — memory is append-only (design-philosophy.md #1).
 * This only ADDS new typed records, each naming which artifact it supersedes.
 *
 * Talks to a RUNNING LifeContext server over HTTP rather than writing life-context.db in-process
 * (unlike this repo's other backfill-*.js scripts, which import src/db.js directly): the
 * original's prose is fetched via `GET /api/artifact/:id` — nothing here hardcodes it — and the
 * new record is written via `POST /api/v1/ingest`, which reuses the server's own
 * embed-then-upsert path (executeIngest) instead of duplicating embedding logic in a script.
 * `source_id` is deterministically derived from the superseded artifact's own id
 * (`supersedes-<id>`), so ingest's upsert-by-(source, source_id) makes a re-run a no-op — the
 * idempotency the issue's implementation note asks for.
 *
 * Requires the server to be running (npm start) and LIFECONTEXT_API_KEY / LIFECONTEXT_URL
 * resolvable via .env (src/config.js). Back up life-context.db before a real run — that's
 * a call for a human to make, not this script.
 *
 *   Run:  npm run backfill:preferences [-- --dry-run]
 */
import { pathToFileURL } from 'node:url';
import { LIFECONTEXT_API_KEY, LIFECONTEXT_API_KEY_PLACEHOLDER, PORT } from '../src/config.js';

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || `http://localhost:${PORT}`;
const SOURCE = 'preferences-migration';
const PREFERENCE_TYPE = 'x-agent-preference';

// The four untyped `note` preferences #407 measured as existing (its Problem section) —
// exhaustive as of this writing, not a query. Adding a fifth later means adding its id here and
// re-running; an id already migrated is a no-op (idempotent upsert, below).
const SUPERSEDED_ARTIFACT_IDS = [210533, 211030, 211635, 211707];

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function hasApiKey() {
  return Boolean(LIFECONTEXT_API_KEY) && LIFECONTEXT_API_KEY !== LIFECONTEXT_API_KEY_PLACEHOLDER;
}

async function fetchOriginal(id) {
  const res = await fetch(`${LIFECONTEXT_URL}/api/artifact/${id}`, {
    headers: { 'x-api-key': LIFECONTEXT_API_KEY },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/artifact/${id} returned ${res.status}`);
  return res.json();
}

async function ingest(payload) {
  const res = await fetch(`${LIFECONTEXT_URL}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LIFECONTEXT_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST /api/v1/ingest returned ${res.status}${body ? `: ${body}` : ''}`);
  }
  return res.json();
}

// One artifact's migration: fetch its original text, build the superseding record, and (unless
// dryRun) ingest it. Returns a per-id outcome string rather than throwing, so one bad id can't
// abort the rest — mirrors /api/v1/ingest/batch's own per-item isolation.
async function migrateOne(id, { dryRun }) {
  let original;
  try {
    original = await fetchOriginal(id);
  } catch (err) {
    return { id, status: 'fetch_failed', detail: err.message };
  }
  if (!original) return { id, status: 'not_found' };

  const text = typeof original.text_repr === 'string' ? original.text_repr.trim() : '';
  if (!text) return { id, status: 'empty_text' };

  const payload = {
    source: SOURCE,
    source_id: `supersedes-${id}`, // deterministic + reproducible -> a re-run upserts, never duplicates
    type: PREFERENCE_TYPE,
    text_repr: `${text}\n\n(Supersedes artifact ${id}.)`,
    // Preserves WHEN the preference was actually stated (connector-conventions.md rule 5) —
    // never a fresh "now", which would misrepresent this as a new preference rather than a
    // re-typed one.
    occurred_at: typeof original.occurred_at === 'string' ? original.occurred_at : undefined,
    extra: { supersedes_artifact_id: id },
  };

  if (dryRun) return { id, status: 'dry_run', payload };

  try {
    const result = await ingest(payload);
    return { id, status: result.created ? 'created' : 'updated', newId: result.id };
  } catch (err) {
    return { id, status: 'ingest_failed', detail: err.message };
  }
}

export async function migratePreferences({ dryRun = false } = {}) {
  if (!hasApiKey()) {
    throw new Error('no LIFECONTEXT_API_KEY resolved (set it in .env) — is the server configured?');
  }
  const outcomes = [];
  for (const id of SUPERSEDED_ARTIFACT_IDS) {
    outcomes.push(await migrateOne(id, { dryRun }));
  }
  return outcomes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dryRun } = parseArgs(process.argv.slice(2));
  console.log(
    `migrate-preferences: ${dryRun ? '[dry run] ' : ''}re-storing ${SUPERSEDED_ARTIFACT_IDS.length} ` +
    `preference(s) under type "${PREFERENCE_TYPE}" from ${LIFECONTEXT_URL}.`,
  );
  try {
    const outcomes = await migratePreferences({ dryRun });
    for (const o of outcomes) {
      if (o.status === 'dry_run') {
        console.log(`[dry run] artifact ${o.id} -> would ingest source_id=supersedes-${o.id}`);
      } else if (o.status === 'created' || o.status === 'updated') {
        console.log(`artifact ${o.id} -> ${o.status} id ${o.newId} (source_id=supersedes-${o.id})`);
      } else {
        console.error(`artifact ${o.id} -> ${o.status}${o.detail ? `: ${o.detail}` : ''}`);
      }
    }
    if (dryRun) console.log('Nothing was written. Re-run without --dry-run to apply.');
  } catch (err) {
    console.error('migrate-preferences: aborted —', err.message);
    process.exitCode = 1;
  }
}
