/**
 * Retrieval: the query planner (docs/03-ob2-design.md §4). A search becomes two stages:
 *   1. Parse the query into structured filters + a semantic core (one cheap LLM call).
 *   2. SQL-prefilter the candidate set, vector-rank + FTS-rank within it, fuse with RRF.
 *
 * Degrades gracefully: if the chat model (QUERY_MODEL) is unreachable we fall back to a
 * no-filter plan (pure semantic); if the embedding model is down we fall back to FTS-only.
 * Search never throws just because Ollama is offline.
 */
import { z } from 'zod';
import { db, resolveEntityIds, resolveNameByPrefix, getEntity, getArtifactById, getRelations, getRelationsTo, mergeEntities, listProbableDuplicates, listContactPhotos, annotateArtifactRows } from './db.js';
import { ai, embedToFloat32 } from './embeddings.js';
import { log } from './logger.js';
import { geocodePlace, haversineKm } from './geocode.js';
import { normalizeUsState } from './us-states.js';
import { OLLAMA_BASE_URL, QUERY_MODEL, QUERY_PLAN_TIMEOUT_MS, QUERY_PLANNER_ENABLED, QUERY_PLAN_MAX_TOKENS, QUERY_MODEL_KEEP_ALIVE, QUERY_MODEL_WARMUP_TIMEOUT_MS, RRF_K, KNN_OVERFETCH, KNN_MIN, KNN_MAX, DIGEST_TIMELINE_DAYS, GEO_RADIUS_DEFAULT_KM, GEO_RADIUS_MAX_KM } from './config.js';
import { ARTIFACT_TYPES, TYPE_REGISTRY } from './ingest-types.js';

// Re-exported so the planner prompt below, the plan-schema filter, and every existing
// importer of ARTIFACT_TYPES from search.js pick up the registry (docs/04-connector-contract.md
// §6) without a second definition — src/ingest-types.js is the one source of truth.
export { ARTIFACT_TYPES };

const MS_PER_DAY = 86_400_000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const emptyish = (s) => (typeof s === 'string' && s.trim() ? s : null);

// --- Query-plan schema (validates the LLM's JSON; coerces junk to safe defaults) ---
const PlanSchema = z.object({
  // Drop only invalid type values, not the whole list — a single bad enum from the LLM
  // (e.g. "reel") must not silently discard the caller's real type constraints.
  types: z.array(z.string()).catch([]).transform((a) => a.filter((t) => ARTIFACT_TYPES.includes(t))),
  entities: z.array(z.string()).catch([]).default([]),
  place: z.string().nullable().catch(null).default(null),
  near: z.string().nullable().catch(null).default(null),
  time_start: z.string().nullable().catch(null).default(null),
  time_end: z.string().nullable().catch(null).default(null),
  // "where / located / last seen / been" with no place named -> restrict to geotagged rows (#190).
  geo_required: z.boolean().catch(false).default(false),
  // "last / latest / most recent" -> order the candidate set by occurred_at DESC instead of RRF (#190).
  sort: z.enum(['relevance', 'recent']).catch('relevance').default('relevance'),
  semantic: z.string().catch('').default(''),
});

const fallbackPlan = (query) => ({ types: [], entities: [], place: null, near: null, time_start: null, time_end: null, geo_required: false, sort: 'relevance', semantic: query });

function planSystemPrompt(today) {
  return [
    `You convert a personal-memory query into a JSON filter plan. Today is ${today}.`,
    'Return ONLY a JSON object with keys:',
    `  types: array of any of [${ARTIFACT_TYPES.join(', ')}], or []`,
    '  entities: array of person/place/org names exactly as written, or []',
    '  place: a place string for "in"/"at" location wording (matched against the stored label), or null',
    '  near: a place name for proximity wording ("near", "around", "close to", "nearby") — a geographic-radius search — or null',
    '  A US state, city, or country name (e.g. "Texas", "Austin", "France") is a LOCATION: put it in place (or near for proximity wording), NEVER in entities. entities is only for people and organizations.',
    '  Only set types when the query explicitly names an artifact kind (photo, email, message, note, document, video). A "when/where was X" question is NOT a type constraint — leave types [].',
    '  time_start, time_end: ISO dates (YYYY-MM-DD) resolving any relative time, or null',
    '  geo_required: true when the query asks WHERE something happened — "where", "located", "last seen", "been" — WITHOUT naming a place; else false. (When a place IS named, use place/near instead.)',
    '  sort: "recent" when the query wants the latest/most-recent — "last", "latest", "most recent", "last seen"; else "relevance"',
    '  semantic: the meaning-bearing core of the query (always a non-empty string)',
    'For week- or month-scale summary questions ("what was I doing in October"), set types to ["digest"] — daily digests answer those in one hit.',
    'Example: "photos of Maria in Ocean City" -> {"types":["photo"],"entities":["Maria"],"place":"Ocean City","near":null,"time_start":null,"time_end":null,"geo_required":false,"sort":"relevance","semantic":"photos of Maria in Ocean City"} — an explicit kind word IS a type constraint, and a named place goes in place, never entities.',
    'Example: "where was Maria last seen" -> {"types":[],"entities":["Maria"],"place":null,"near":null,"time_start":null,"time_end":null,"geo_required":true,"sort":"recent","semantic":"where was Maria last seen"} — no kind word and no place named, so types stays [] and place stays null; "where"/"last seen" set geo_required and sort instead.',
    'Do not invent filters the query does not imply. Emit valid JSON only.',
  ].join('\n');
}

// --- Deterministic lexical pre-pass (#352) ---
// QUERY_MODEL is a 3B local model that reliably under-extracts: a query that literally says
// "photos" and "in Ocean City" can still come back with types:[] and place:null (see #186 for
// this same model already mis-routing "in texas"). "photo" and "Ocean City" are not judgments —
// they're lexical facts decidable without an LLM, so this recovers them deterministically and
// merges them into the plan gap-fill only (mergeLexicalHints below), never overriding a
// non-empty LLM value.
//
// types: literal kind words (singular + plural), mapped through ARTIFACT_TYPES so an invalid/
// renamed type can never surface here — same filter discipline as PlanSchema's own types transform.
const KIND_WORD_TYPE = Object.freeze({
  photo: 'photo', photos: 'photo',
  video: 'video', videos: 'video',
  email: 'email', emails: 'email',
  message: 'message', messages: 'message', text: 'message', texts: 'message',
  note: 'note', notes: 'note',
  document: 'document', documents: 'document', doc: 'document', docs: 'document',
});

// place: a capitalized run after "in"/"at"/"around" is only a CANDIDATE — "at the beach" and
// "in a hurry" have no capitalized run and never even reach the confirmation step below. A
// candidate is confirmed, never trusted, against the same bundled gazetteer geocodePlace/
// normalizeUsState already resolve against elsewhere in this file — no second place vocabulary.
const PLACE_PREP_RE = /\b(?:in|at|around)\s+([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*)*)/gu;

const isKnownPlace = (candidate) => !!(normalizeUsState(candidate) || geocodePlace(candidate));

// Pure, exported for direct unit test (per the coding-standards density: this is the whole
// pre-pass, no side effects, no I/O beyond the in-memory gazetteer geocodePlace already loads).
export function lexicalPlanHints(query) {
  const words = query.toLowerCase().match(/[\p{L}]+/gu) || [];
  const types = [...new Set(words.map((w) => KIND_WORD_TYPE[w]).filter((t) => t && ARTIFACT_TYPES.includes(t)))];

  let place = null;
  for (const m of query.matchAll(PLACE_PREP_RE)) {
    const runWords = m[1].split(/\s+/);
    // Try the full capitalized run first, then shrink from the end — "Ocean City Beach" confirms
    // as "Ocean City" once "Beach" is dropped, without needing a second, looser place grammar.
    for (let n = runWords.length; n >= 1 && !place; n--) {
      const candidate = runWords.slice(0, n).join(' ');
      if (isKnownPlace(candidate)) place = candidate;
    }
    if (place) break;
  }
  return { types, place };
}

// Gap-fill only: a non-empty plan value always wins (the LLM may be better-informed — e.g. a
// place named without "in"/"at"/"around" wording); the lexical hint applies only where the plan
// left types empty / place null. Caller opts still win over the merged plan (unchanged —
// runHybridSearch already prefers explicit types/entities/near over plan.* wholesale). Skips the
// pre-pass entirely when the plan already supplies both fields — the common case once the
// planner succeeds fully — so a query that happens to contain an "in/at/around Capitalized"
// phrase doesn't pay the gazetteer lookup just to have it discarded.
function mergeLexicalHints(plan, query) {
  const typesEmpty = !plan.types.length;
  const placeEmpty = !emptyish(plan.place);
  if (!typesEmpty && !placeEmpty) return plan;
  const hints = lexicalPlanHints(query);
  return {
    ...plan,
    types: typesEmpty ? hints.types : plan.types,
    place: placeEmpty ? hints.place : plan.place,
  };
}

// --- Zero-candidate demotion ladder (#365) ---
// A plan-derived filter can be wrong two different ways: the LLM DROPS a field the query names
// (#352, fixed by lexicalPlanHints above) or it INVENTS one the query never asked for — e.g. a
// time_start/time_end hallucinated for "when was X in Y" wording — and an invented field can
// zero out an otherwise-correct entity+place+type match. Before #365 the zero-candidate retry in
// runHybridSearch was all-or-nothing: it could only fall back to the CALLER's own explicit
// filters, so when the caller supplies none (public/chat.js sends only {query, limit}; so does
// any MCP client that doesn't itself extract structured filters) one hallucinated field dropped
// the entity+place+type filters right along with it, landing on the full default_searchable set
// — a correctness footgun far worse than an honest empty.
//
// Fixed order, most-likely-invented to highest-confidence, each rung cumulative with the ones
// before it:
//   time        — the observed hallucination, and the only plan field with NO deterministic
//                 cross-check (types/place are lexically gap-filled #352; place is existence-
//                 probed below; entities resolve against entity_aliases).
//   geoRequired — a derived boolean over place_label IS NOT NULL; already coarse (#190).
//   near        — resolves through the gazetteer's ambiguous-city fallback (geocodePlace); a
//                 mis-centered radius can empty the set with no error.
//   place       — existence-probed so it matches >=1 stored label, but its CONJUNCTION with
//                 entity/type may still be empty.
//   types       — lexically corroborated since #352 when the query names a kind word; the risky
//                 case is a planner-only type (e.g. the "digest" steer for summary questions).
//   entities    — last: resolved by exact entity_aliases or the unambiguous #184 prefix match —
//                 the highest-confidence plan field, and what the user most clearly asked about.
// Pure, exported for direct unit test. `present[field]` is true only when that field is BOTH
// non-empty AND plan-derived (never caller-supplied — a caller filter is never demoted).
const PLAN_DEMOTION_ORDER = Object.freeze(['time', 'geoRequired', 'near', 'place', 'types', 'entities']);
export function planDemotionLadder(present) {
  return PLAN_DEMOTION_ORDER.filter((f) => present[f]);
}

// Local calendar date (not UTC slice — an evening query must resolve "today" against
// the local day, not tomorrow's UTC date; mirrors consolidate.js's localDate). Exported so a
// test can assert its format/behavior directly, same as rrf.
export const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function parseQuery(query) {
  const today = localDate(new Date());
  try {
    // The planner call is the other big outbound cost on a CPU host (~8-10s/plan here), so it is
    // its own span (#328). The query text is never logged — only the model and the cap.
    const resp = await log.span('ollama.plan.completed', () => ai.chat.completions.create(
      {
        model: QUERY_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        // The plan is a tiny JSON; generation time dominates on a CPU host, so cap output (#179).
        max_tokens: QUERY_PLAN_MAX_TOKENS,
        messages: [
          { role: 'system', content: planSystemPrompt(today) },
          { role: 'user', content: query },
        ],
      },
      { timeout: QUERY_PLAN_TIMEOUT_MS, maxRetries: 0 }
    ), { model: QUERY_MODEL, gen_cap: QUERY_PLAN_MAX_TOKENS });
    const parsed = PlanSchema.safeParse(JSON.parse(resp.choices[0].message.content));
    if (parsed.success) {
      const p = parsed.data;
      return mergeLexicalHints({ ...p, semantic: emptyish(p.semantic) || query }, query);
    }
    // Not an exception — the call succeeded and the model returned something off-schema. That's a
    // recovered degradation (WARN), and the issue COUNT is the signal; zod's issues carry
    // `received` values echoing the model's output, which is derived from the user's query.
    log.warn('search.plan.rejected', 'plan failed schema validation, using pure-semantic fallback',
      { model: QUERY_MODEL, issues: parsed.error.issues.length });
  } catch {
    // Deliberately silent — NOT an empty catch in the coding-standards sense. The span above
    // already wrote the ERROR row, with the stack, before it rethrew; logging again here is the
    // double-log SKILL rule 19 exists to prevent. The fallback-plan return below is the recovery.
  }
  return mergeLexicalHints(fallbackPlan(query), query);
}

// Boot-time warm-up (#247): preloads QUERY_MODEL via Ollama's native /api/generate (an empty
// prompt loads the model without generating tokens) so the first real query-plan call doesn't
// pay a cold-load that alone can exceed QUERY_PLAN_TIMEOUT_MS. The OpenAI-compat endpoint the
// rest of this module uses ignores a per-request keep_alive (ollama/ollama#11458), so this goes
// straight to the native API, which does honor it. Fire-and-forget from server.js at boot; never
// throws — same "search never fails just because Ollama is offline" contract as parseQuery.
export async function warmUpQueryModel() {
  if (!QUERY_PLANNER_ENABLED) return;
  const nativeBase = OLLAMA_BASE_URL.replace(/\/v1\/?$/, '');
  try {
    // Boot-time outbound span (#328). Its duration is the cold-load cost this exists to move OFF
    // the first real query — the number that says whether #247's fix is still doing its job.
    await log.span('ollama.warmup.completed', async () => {
      const resp = await fetch(`${nativeBase}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // stream:false so this resolves with one JSON body instead of Ollama's default NDJSON
        // stream, which we'd otherwise never read — avoids leaving the response stream dangling.
        body: JSON.stringify({ model: QUERY_MODEL, prompt: '', keep_alive: QUERY_MODEL_KEEP_ALIVE, stream: false }),
        signal: AbortSignal.timeout(QUERY_MODEL_WARMUP_TIMEOUT_MS),
      });
      await resp.text(); // drain the body so the connection is released regardless of status
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    }, { model: QUERY_MODEL, keep_alive: QUERY_MODEL_KEEP_ALIVE });
  } catch {
    // Silent for the same reason as parseQuery's catch: the span already logged the failure with
    // its stack. Warm-up is fire-and-forget — the planner just cold-loads on the first query.
  }
}

// --- Statements ---
// NULL occurred_at is no longer invisible to timeline (#436) or to search/recall/about_entity
// (#538): every date(...) range bound and every recency ORDER BY below reads through
// EFFECTIVE_TIME_SQL (or its alias-qualified sibling) — a read-time fallback only, never a write
// that would back-fill the column (data-model.md is explicit the two are different facts). This
// also makes the ingest warning ("occurred_at missing; ingested_at used for timeline",
// src/ingest.js) actually true — before the #436 fix the warning described behavior the query
// didn't have. Declared here, above every statement that uses it, since JS `const` cannot be
// referenced before its point of declaration.
// ingested_at is `DEFAULT CURRENT_TIMESTAMP`, which SQLite writes in UTC, while a caller's
// start/end bounds (and `localDate`, #253) are the LOCAL calendar day — so the fallback wraps
// ingested_at in `datetime(..., 'localtime')` before COALESCE, matching this file's existing
// "resolve 'today' against the local day, not tomorrow's UTC date" rule. Only the fallback term
// is converted; an explicit occurred_at (whatever format a connector wrote) is untouched, so this
// changes NOTHING for a non-null row. pragma-dependent on the OS TZ, same as `localDate` already is.
const EFFECTIVE_TIME_SQL = `COALESCE(occurred_at, datetime(ingested_at, 'localtime'))`;
// Alias-qualified sibling for a statement that joins an aliased `artifacts a` (candidateStmt,
// aboutStmt) rather than querying the bare table (recentOrderStmt, timelineStmt,
// timelineDigestStmt) — same expression, just column-qualified so it compiles unambiguously
// alongside a second joined table.
const EFFECTIVE_TIME_SQL_A = `COALESCE(a.occurred_at, datetime(a.ingested_at, 'localtime'))`;
// One fixed prepared statement; each clause self-neutralizes when its param is NULL.
// Arrays are passed as JSON and unnested with json_each — keeps it a single compiled
// statement (no SQL string-building, coding-standards rule).
const candidateStmt = db.prepare(`
  SELECT DISTINCT a.id
  FROM artifacts a
  LEFT JOIN entity_links el ON el.artifact_id = a.id
  WHERE (@types_json IS NULL OR a.type IN (SELECT value FROM json_each(@types_json)))
    AND (@ents_json  IS NULL OR el.entity_id IN (SELECT value FROM json_each(@ents_json)))
    AND (@t0 IS NULL OR date(${EFFECTIVE_TIME_SQL_A}) >= date(@t0))
    AND (@t1 IS NULL OR date(${EFFECTIVE_TIME_SQL_A}) <= date(@t1))
    AND (@place IS NULL OR a.place_label LIKE @place OR (@place2 IS NOT NULL AND a.place_label LIKE @place2))
    AND (@geo_required = 0 OR a.place_label IS NOT NULL)
`);
// Candidate delivery to the ranking arms (#227). The prefiltered id set is written to a
// per-connection TEMP table with an INTEGER PRIMARY KEY (so lookups are index probes), not
// marshaled into a `json_each(?)` string re-parsed by every arm. This is not cosmetic: at
// scale (~210k rows) the FTS arm written as `rowid IN (SELECT value FROM json_each(?))`
// degrades to ~27s/query, and — measured — an indexed `rowid IN (SELECT id FROM …)` does NOT
// help (the `IN (subquery)` shape is what defeats FTS5's index). The EXISTS form below,
// correlated on the temp table's PK, drops the same query to <1ms. TEMP tables are
// per-connection and better-sqlite3 is single-connection, so there's no cross-request leakage;
// each search clears + refills. DELETE (not DROP) keeps these prepared statements valid.
db.exec('CREATE TEMP TABLE IF NOT EXISTS search_candidates (id INTEGER PRIMARY KEY)');
const clearCandidatesStmt = db.prepare('DELETE FROM search_candidates');
const fillCandidatesStmt = db.prepare('INSERT INTO search_candidates(id) SELECT value FROM json_each(?)');
// Recency ordering (#190): order the candidate set by EFFECTIVE_TIME_SQL DESC (ties broken by id
// DESC for determinism) — since #538, a NULL occurred_at falls back to ingested_at rather than
// always sorting last. Used when the plan/caller sort is 'recent' — the candidate set already
// carries the topical (type/entity/geo) constraint, so recency over it is the "last seen" answer.
const recentOrderStmt = db.prepare(`
  SELECT id FROM artifacts
  WHERE id IN (SELECT id FROM search_candidates)
  ORDER BY ${EFFECTIVE_TIME_SQL} DESC, id DESC
  LIMIT ?
`);
// Filter-then-rank: KNN constrained to the prefiltered candidate set. sqlite-vec (>= 0.1.6)
// supports IN constraints on the vec0 primary key in KNN queries — this ranks *within* the
// candidates instead of hoping a global top-k happens to intersect a tight filter. Compiled
// at startup, so an sqlite-vec too old to support it fails loudly at boot rather than
// silently degrading (verified against 0.1.9). The IN (over the indexed temp table) stays an
// IN here: unlike FTS, sqlite-vec's KNN handles the PK IN-constraint efficiently (#227).
const knnInStmt = db.prepare(`
  SELECT artifact_id, distance FROM vec_artifacts
  WHERE embedding MATCH ? AND k = ?
    AND artifact_id IN (SELECT id FROM search_candidates)
  ORDER BY distance
`);
// FTS arm: candidate constraint expressed as a correlated EXISTS on the temp table's PK, NOT
// `rowid IN (SELECT …)` — the IN shape makes FTS5 rank the full match set before filtering
// (~27s at 210k rows); EXISTS probes the PK index per match (<1ms). Same result set + bm25
// order, verified by the equivalence tests (#227).
const ftsInStmt = db.prepare(`
  SELECT rowid AS artifact_id, bm25(artifacts_fts) AS score
  FROM artifacts_fts
  WHERE artifacts_fts MATCH ?
    AND EXISTS (SELECT 1 FROM search_candidates sc WHERE sc.id = artifacts_fts.rowid)
  ORDER BY score LIMIT ?
`);
// Cheap existence probe: is this place string a usable filter at all? Same two-pattern shape as
// candidateStmt's place clause (#186) — a US-state term supplies both a full-name and a code
// pattern, so the probe succeeds if either form is present in any stored label.
const placeExistsStmt = db.prepare('SELECT 1 FROM artifacts WHERE place_label LIKE @place OR (@place2 IS NOT NULL AND place_label LIKE @place2) LIMIT 1');
// Geo-radius candidates (#68): a cheap lat/lon bounding-box prefilter over artifacts that carry
// coordinates; the caller refines the box corners with an exact haversine pass (geoCandidateIds).
const geoBboxStmt = db.prepare(`
  SELECT id, latitude, longitude FROM artifacts
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    AND latitude BETWEEN @latMin AND @latMax
    AND longitude BETWEEN @lonMin AND @lonMax
`);
// Per-day digest substitution (roadmap M6 deliverable 3): within the range, a day that has a
// daily digest is represented by it — its digest-eligible raw rows are folded away; undigested
// days keep their raw artifacts (partial backfill must never hide data), and types the digest
// doesn't summarize (digest_eligible: false, e.g. contact) are never hidden. When the range
// holds no digests at all, the NOT IN set is empty and this is identical to timelineStmt.
const DIGEST_ELIGIBLE_JSON = JSON.stringify(TYPE_REGISTRY.filter((t) => t.digest_eligible).map((t) => t.type));
// default_searchable enforcement (#121): the type set an ordinary no-type search is restricted to.
// Low-signal session/visit artifacts (default_searchable:false) are excluded so they don't pollute
// recall — they surface only when their type is named explicitly. Substituted by `prefilter` below
// whenever the effective type list is empty.
const SEARCHABLE_TYPES_JSON = JSON.stringify(TYPE_REGISTRY.filter((t) => t.default_searchable).map((t) => t.type));
// The digest sub-select's own substitution disjunct deliberately does NOT read through
// EFFECTIVE_TIME_SQL: consolidate.js's digest-generation query only ever pulls rows that HAVE a
// real occurred_at (src/consolidate.js), so a digest never actually summarized a NULL-occurred_at
// note — substituting one away on a digested day would silently hide it a second, different way
// (the digest doesn't know it exists). `occurred_at IS NULL` therefore short-circuits the row into
// "never substituted," independent of the range bounds above; only a row with a REAL occurred_at
// is ever compared against the digest-day set.
const timelineDigestStmt = db.prepare(`
  SELECT * FROM artifacts
  WHERE date(${EFFECTIVE_TIME_SQL}) >= date(@start) AND date(${EFFECTIVE_TIME_SQL}) <= date(@end)
    AND (type = 'digest'
      OR occurred_at IS NULL
      OR type NOT IN (SELECT value FROM json_each(@eligible_json))
      OR date(occurred_at) NOT IN (
        SELECT date(occurred_at) FROM artifacts
        WHERE type = 'digest' AND date(occurred_at) >= date(@start) AND date(occurred_at) <= date(@end)))
  ORDER BY ${EFFECTIVE_TIME_SQL} ASC, id ASC
  LIMIT @limit
`);
const timelineStmt = db.prepare(`
  SELECT * FROM artifacts
  WHERE (@start IS NULL OR date(${EFFECTIVE_TIME_SQL}) >= date(@start))
    AND (@end   IS NULL OR date(${EFFECTIVE_TIME_SQL}) <= date(@end))
    AND (@types_json IS NULL OR type IN (SELECT value FROM json_each(@types_json)))
  ORDER BY ${EFFECTIVE_TIME_SQL} ASC, id ASC
  LIMIT @limit
`);
const aboutStmt = db.prepare(`
  SELECT a.* FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
  WHERE el.entity_id = ? ORDER BY ${EFFECTIVE_TIME_SQL_A} DESC, a.id DESC LIMIT ?
`);

// Turn free text into a safe FTS5 MATCH: OR of quoted word-tokens. Quoting each token
// neutralizes FTS5 operators (", *, NEAR, :) that would otherwise throw on raw input.
function toFtsQuery(text) {
  const terms = (text.match(/[\p{L}\p{N}]+/gu) || []).map((t) => `"${t}"`);
  return terms.length ? terms.join(' OR ') : null;
}

// Artifact ids within `radiusKm` of a center point (#68). A degree-based bounding box narrows
// the SQL scan to a rectangle around the center, then an exact haversine pass trims it to a true
// circle. Near a pole (cos(lat)→0 blows up the longitude span) the box widens to the full
// longitude band; antimeridian wraparound is out of scope (documented). Returns an id Set.
const KM_PER_DEG_LAT = 111.32;
const POLE_COS_EPSILON = 1e-6;  // below this |cos(lat)| the longitude span blows up — cover the whole band
const LON_ABS_MAX = 180;        // longitude range is [-180, 180]
function geoCandidateIds(center, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  // Near a pole longitude is meaningless (all meridians converge), so the box spans the ENTIRE
  // [-180, 180] band regardless of center.lon; otherwise a degree-based half-width around center.
  const nearPole = Math.abs(cosLat) < POLE_COS_EPSILON;
  const dLon = nearPole ? 0 : radiusKm / (KM_PER_DEG_LAT * Math.abs(cosLat));
  const rows = geoBboxStmt.all({
    latMin: center.lat - dLat, latMax: center.lat + dLat,
    lonMin: nearPole ? -LON_ABS_MAX : center.lon - dLon,
    lonMax: nearPole ? LON_ABS_MAX : center.lon + dLon,
  });
  const ids = new Set();
  for (const r of rows) {
    if (haversineKm(center.lat, center.lon, r.latitude, r.longitude) <= radiusKm) ids.add(r.id);
  }
  return ids;
}

// --- Result-set summary (#353) ---
// Deterministic aggregation over the FULL matched candidate set, never LLM generation — an
// explicit owner decision: exact (a wrong answer fails a memory system at its one job) and
// instant (the planner call already costs ~8-10s on this CPU host; a second generation step
// would double the worst case). A contiguous run of occurred_at dates is what a person means by
// "a visit" — tolerate a gap of up to RUN_GAP_DAYS so a day with no photos doesn't split one trip
// in half (mirrors events:cluster's day-run grouping, #137/#138, deliberately without its "away
// from home" filter, which exists to propose event entities and has no bearing here).
const RUN_GAP_DAYS = 2;

// Artifact-level facts for the summary, id-ordered for deterministic downstream aggregation.
// date(occurred_at) truncates to the calendar date the same way candidateStmt's time bounds do —
// one vocabulary for "date" across the file, no second parsing scheme.
const summaryArtifactsStmt = db.prepare(`
  SELECT id, type, date(occurred_at) AS occurred_date, place_label
  FROM artifacts
  WHERE id IN (SELECT value FROM json_each(?))
  ORDER BY id
`);
// Same batched-join shape as db.js's getLinksForIdsStmt (#149): one query over the whole
// candidate set, not one per row. DISTINCT because an artifact can carry the same entity under
// more than one role — the summary counts an artifact once per person, not once per link.
// kind='person' only (Copilot review, PR #361): entity_links also links artifacts to place/org/
// event entities (linkArtifactsToPlace/linkArtifactsToEvent) — without this filter a photo
// clustered to a place or event entity would surface that place/event under `people`, which
// `places` already reports via place_label.
const summaryEntitiesStmt = db.prepare(`
  SELECT DISTINCT el.artifact_id, el.entity_id, e.canonical_name AS name
  FROM entity_links el JOIN entities e ON e.id = el.entity_id
  WHERE el.artifact_id IN (SELECT value FROM json_each(?)) AND e.kind = 'person'
  ORDER BY el.artifact_id, el.entity_id
`);

// Materializes the rows summarizeCandidates needs from the full candidate id Set. Kept separate
// from that pure function so the DB access (this file's own statements, not db.js's) stays out of
// the part that's unit-tested directly.
function loadSummaryRows(ids) {
  const idsJson = JSON.stringify([...ids]);
  const rows = summaryArtifactsStmt.all(idsJson);
  const peopleByArtifact = new Map();
  for (const l of summaryEntitiesStmt.all(idsJson)) {
    if (!peopleByArtifact.has(l.artifact_id)) peopleByArtifact.set(l.artifact_id, []);
    peopleByArtifact.get(l.artifact_id).push({ entity_id: l.entity_id, name: l.name });
  }
  for (const r of rows) r.people = peopleByArtifact.get(r.id) ?? [];
  return rows;
}

// Pure, exported for direct unit test — no DB access here, only the rows loadSummaryRows already
// fetched. `total` is rows.length, i.e. the FULL matched candidate count, never the caller's
// `limit`ed page (the failure this feature exists to fix). Any facet with no data is omitted
// entirely, never emitted as null/0; an empty row set returns null so callers can omit `summary`
// altogether rather than special-case a "0 results" object.
export function summarizeCandidates(rows) {
  if (!rows?.length) return null;

  const byType = new Map();
  const dateCounts = new Map(); // occurred_date -> count; sorted below, so insertion order doesn't matter
  const placeCounts = new Map();
  const peopleCounts = new Map(); // entity_id -> { entity_id, name, count }

  for (const r of rows) {
    byType.set(r.type, (byType.get(r.type) || 0) + 1);
    if (r.occurred_date) dateCounts.set(r.occurred_date, (dateCounts.get(r.occurred_date) || 0) + 1);
    if (r.place_label) placeCounts.set(r.place_label, (placeCounts.get(r.place_label) || 0) + 1);
    for (const p of r.people ?? []) {
      const cur = peopleCounts.get(p.entity_id);
      if (cur) cur.count += 1;
      else peopleCounts.set(p.entity_id, { entity_id: p.entity_id, name: p.name, count: 1 });
    }
  }

  const summary = { total: rows.length };
  if (byType.size) summary.by_type = Object.fromEntries(byType);

  const sortedDates = [...dateCounts.keys()].sort();
  if (sortedDates.length) {
    summary.date_range = { start: sortedDates[0], end: sortedDates[sortedDates.length - 1] };
    summary.runs = [];
    for (const d of sortedDates) {
      const prev = summary.runs[summary.runs.length - 1];
      if (prev && (new Date(d) - new Date(prev.end)) / MS_PER_DAY <= RUN_GAP_DAYS) {
        prev.end = d;
        prev.count += dateCounts.get(d);
      } else {
        summary.runs.push({ start: d, end: d, count: dateCounts.get(d) });
      }
    }
  }

  // Tie-break by plain codepoint comparison (`<`/`>`), not localeCompare (Copilot review, PR
  // #361): localeCompare's collation varies with the runtime's ICU data, so it could order ties
  // differently across environments — a determinism leak in a feature whose whole point is an
  // exact, reproducible answer.
  const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  if (placeCounts.size) {
    summary.places = [...placeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || byCodepoint(a[0], b[0]))
      .map(([place_label, count]) => ({ place_label, count }));
  }
  if (peopleCounts.size) {
    summary.people = [...peopleCounts.values()].sort((a, b) => b.count - a.count || byCodepoint(a.name, b.name));
  }

  return summary;
}

// Reciprocal rank fusion over N ranked id-lists: score = Σ 1/(RRF_K + rank).
function rrf(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Hybrid search. Explicit args (types/timeRange/entities) win over the parsed plan;
 * the LLM fills whatever the caller didn't specify. Returns hydrated artifacts, with
 * `distance` from the vector arm when available (null for FTS-only hits). Ranking is
 * constrained to the prefiltered candidate set. Pass `usePlanner: false` to skip the LLM
 * parse entirely (the legacy recall path — a plain semantic+keyword lookup, no NL filters).
 * `QUERY_PLANNER_ENABLED=false` (#179) forces that same no-LLM path globally — for a CPU-only
 * host where the planner never beats even a low timeout, so search stays sub-second.
 * `near` (a place name or {lat, lon}) plus `radiusKm` add a geo-radius filter (#68): artifacts
 * within the radius by coordinate, not just by place-label text.
 * `lexicalWhenSkipped` (#433) controls whether the pure, side-effect-free `lexicalPlanHints`
 * gap-fill (#352) still runs when the planner is skipped. Defaults `false` so a caller that
 * OMITS `usePlanner` keeps today's exact behavior on both pre-existing skip paths above —
 * `/api/recall`'s own `usePlanner: false` call, and a box with `QUERY_PLANNER_ENABLED=false` —
 * both documented/tested with no lexical gap-fill. Only the new caller-facing `use_planner: false`
 * REST/MCP flag passes `lexicalWhenSkipped: true`; if a caller sends that flag on a box that ALSO
 * has `QUERY_PLANNER_ENABLED=false`, the gap-fill runs anyway ('caller' wins over 'config' in the
 * `planner_skip` reporting below) — this is a new, `use_planner`-only combination, not a change to
 * either pre-existing path. The gap-fill itself costs a few ms on a query with an `in`/`at`/`around`
 * + capitalized-run phrase (`isKnownPlace` linear-scans the bundled gazetteer) and can add an
 * unindexed `place_label LIKE` probe when a place is confirmed — trivial against the ~7s the flag
 * saves, but not literally microseconds; see `docs/03-ob2-design.md`'s #433 note for measured numbers.
 */
export async function hybridSearch(query, opts = {}) {
  // The search-level span (#328) is the parent every stage below nests under, so one trace shows
  // planner vs. embed vs. KNN vs. FTS side by side. `data` is a live object the inner call
  // mutates before the span closes — the row is serialized on completion, which is the only way
  // to record an OUTCOME (result count) on the same span that measured the work.
  const plannerRequested = opts.usePlanner ?? true;
  const data = {
    limit: opts.limit ?? 3,
    planner: plannerRequested && QUERY_PLANNER_ENABLED,
    // 'caller' wins when both a caller opt-out and the global QUERY_PLANNER_ENABLED=false config
    // apply at once — the caller's own explicit request is the more specific signal.
    planner_skip: !plannerRequested ? 'caller' : (!QUERY_PLANNER_ENABLED ? 'config' : null),
    sort_requested: opts.sort ?? null,
    filtered: !!(opts.types?.length || opts.entities?.length || opts.timeRange || opts.near || opts.geoRequired),
  };
  return log.span('search.hybrid.completed', async () => {
    const results = await runHybridSearch(query, opts);
    data.results = results.length;
    return results;
  }, data);
}

async function runHybridSearch(query, { limit = 3, types, timeRange, entities, near, radiusKm, geoRequired, sort, usePlanner = true, lexicalWhenSkipped = false } = {}) {
  const plan = usePlanner && QUERY_PLANNER_ENABLED
    ? await parseQuery(query)
    : (lexicalWhenSkipped ? mergeLexicalHints(fallbackPlan(query), query) : fallbackPlan(query));

  const effTypes = types?.length ? types : plan.types;
  // Provenance tracked PER BOUND (#510/#365): a caller can supply time_range.start without an
  // end (the zod schema is .partial(), src/server.js), and the planner fills the other bound —
  // that plan-derived bound must stay ladder-eligible even though its sibling is caller-supplied.
  const callerT0 = emptyish(timeRange?.start);
  const callerT1 = emptyish(timeRange?.end);
  const t0FromCaller = !!callerT0;
  const t1FromCaller = !!callerT1;
  const t0 = callerT0 || emptyish(plan.time_start);
  const t1 = callerT1 || emptyish(plan.time_end);
  const entTerms = entities?.length ? entities : plan.entities;
  // geo_required + sort (#190): a caller opt wins over the plan (mirrors types/timeRange/entities).
  // Track whether each came from the caller so the zero-candidate retry can keep a caller-supplied
  // filter (honest empty) while demoting a plan-derived one (demote-never-drop).
  const geoReqFromCaller = geoRequired === true;
  const sortFromCaller = sort != null;
  const effGeoRequired = geoRequired ?? plan.geo_required;
  let effSort = sort ?? plan.sort;

  // Resolve entity terms. Terms that don't resolve can't filter — but they must not
  // vanish either, so they're folded back into the ranked-search text below.
  const entityIds = [];
  const unresolvedTerms = [];
  for (const term of entTerms) {
    const ids = resolveEntityIds(term);
    if (ids.length) { entityIds.push(...ids); continue; }
    // Exact match missed — try the query-time given-name prefix fallback (#184). Resolves a bare
    // first name to a person stored under a full name, but only when it's unambiguous (one entity).
    const prefixIds = resolveNameByPrefix(term);
    if (prefixIds.length) {
      entityIds.push(...prefixIds);
      // A decision worth recording (#328) — but by entity id, never the term: the term is a
      // person's name the user typed. The id resolves back to it for anyone with the app DB.
      log.info('entity.name.resolved', 'given name resolved by unambiguous prefix', { entity_id: prefixIds[0], via: 'prefix' });
    } else {
      unresolvedTerms.push(term);
    }
  }

  // Place is only a filter if it can match at least one place_label; otherwise it's a keyword.
  // A US-state term (#186) expands to TWO patterns so the filter is label-format-independent:
  // the full-name form ("%Texas%", migrated / current labels) and the code form ("%, TX",
  // coordinate-less or not-yet-migrated legacy labels). The canonical name/code are used
  // regardless of how the user wrote the state ("tx"/"texas"/"TEXAS"). A non-state place keeps
  // its single substring pattern (unchanged behavior). `placePattern`/`placeAltPattern` are the
  // LIKE strings threaded to both the existence probe and the prefilter.
  let place = emptyish(plan.place);
  let placePattern = null;
  let placeAltPattern = null;
  if (place) {
    const st = normalizeUsState(place);
    if (st) {
      placePattern = `%${st.name}%`;
      placeAltPattern = `%, ${st.code}`;
    } else {
      placePattern = `%${place}%`;
    }
    if (!placeExistsStmt.get({ place: placePattern, place2: placeAltPattern })) {
      unresolvedTerms.push(place);
      placePattern = null;
      placeAltPattern = null;
    }
  }

  // Geo-radius (#68). Explicit {lat,lon} wins; a name (caller `near` or plan.near) resolves via
  // the bundled gazetteer. A name that resolves to no center isn't a filter — it's folded into
  // the ranked-search text, same demote-never-drop posture as an unmatched place. `geoFromCaller`
  // tracks whether the filter is the caller's (survives the zero-candidate retry) or plan-invented.
  const nearInput = near ?? emptyish(plan.near);
  const radius = clamp(radiusKm ?? GEO_RADIUS_DEFAULT_KM, 0, GEO_RADIUS_MAX_KM);
  let geoIds = null;
  let geoFromCaller = false;
  if (nearInput != null) {
    let center = null;
    if (typeof nearInput === 'object' && nearInput.lat != null && nearInput.lon != null) {
      // Guard out-of-range coordinates (mirrors reverseGeocode): a garbage center yields no geo
      // filter rather than a bounding box that silently matches nothing.
      if (Math.abs(nearInput.lat) <= 90 && Math.abs(nearInput.lon) <= 180) {
        center = { lat: nearInput.lat, lon: nearInput.lon };
      }
    } else if (typeof nearInput === 'string') {
      const resolved = geocodePlace(nearInput);
      if (resolved) center = { lat: resolved.lat, lon: resolved.lon };
      else unresolvedTerms.push(nearInput);
    }
    if (center) {
      geoIds = geoCandidateIds(center, radius);
      geoFromCaller = near != null;
    }
  }

  // What both ranking arms actually search: semantic core + everything the filters
  // couldn't absorb.
  const searchText = [plan.semantic || query, ...unresolvedTerms].join(' ');

  // SQL prefilter -> candidate id set. Always applies a type constraint: the explicit/planner
  // list when non-empty, else the default_searchable set (#121) — so a no-type search never
  // surfaces low-signal session/visit artifacts. The prefilter therefore always runs.
  // spanSync, not span (#328): every statement in this function's ranking path is better-sqlite3,
  // i.e. synchronous, and an async span would insert an await where #227 requires none. Spanning
  // inside the helper covers every call site (the first attempt and each demotion-ladder rung,
  // #365) from one place. Only counts/flags/the fixed-vocabulary `dropped` list reach `data` — a
  // place pattern or query text never does. `rung`/`dropped` default to the first-attempt values
  // (0/[]) so ladder call sites are the only ones that need to pass them.
  const prefilter = (f, rung = 0, dropped = []) =>
    log.spanSync('db.prefilter.completed', () =>
      new Set(
        candidateStmt
          .all({
            types_json: f.types.length ? JSON.stringify(f.types) : SEARCHABLE_TYPES_JSON,
            ents_json: f.entityIds.length ? JSON.stringify(f.entityIds) : null,
            t0: f.t0 || null,
            t1: f.t1 || null,
            place: f.placePattern ?? null,
            place2: f.placeAltPattern ?? null,
            geo_required: f.geoRequired ? 1 : 0,
          })
          .map((r) => r.id)
      ),
    { types: f.types.length, entities: f.entityIds.length, timebound: !!(f.t0 || f.t1),
      placebound: !!f.placePattern, geo_required: !!f.geoRequired, rung, dropped });

  // Geo is an id Set (or null when absent); it intersects the SQL candidate set the same way
  // an extra WHERE clause would (null SQL set + geo => geo alone).
  const applyGeo = (sqlSet, geo) => {
    if (geo == null) return sqlSet;
    if (sqlSet == null) return geo;
    // Intersect by scanning the smaller set and probing the larger — avoids materializing an
    // intermediate array from the (possibly large) SQL candidate set.
    const [small, big] = sqlSet.size <= geo.size ? [sqlSet, geo] : [geo, sqlSet];
    const out = new Set();
    for (const id of small) if (big.has(id)) out.add(id);
    return out;
  };

  // The prefilter always runs — a type constraint is always present (explicit/planner effTypes,
  // else the default_searchable default; #121) — so `candidates` is always a Set, never null.
  let candidates = applyGeo(prefilter({ types: effTypes, entityIds, t0, t1, placePattern, placeAltPattern, geoRequired: effGeoRequired }), geoIds);
  if (candidates.size === 0) {
    // Zero candidates conflates two very different situations: "the caller's own explicit
    // filters matched nothing" (honest) and "the LLM's plan is wrong" (silent planner failure —
    // it either invented a filter the query never asked for, e.g. a time_start/time_end
    // hallucinated for "when was X in Y" wording, or over-filtered, e.g. the prompt's types
    // steer for summary questions). Before #365 recovering from the latter was all-or-nothing:
    // drop every plan-derived field at once, even ones that resolved correctly. The demotion
    // ladder (planDemotionLadder, above) instead drops plan-derived fields ONE AT A TIME in a
    // fixed, most-likely-invented-first order, taking the first rung whose candidate set is
    // non-empty — so a correctly-resolved entity+place+type match survives a single hallucinated
    // time bound instead of being dropped along with it.
    //
    // A field is ladder-ELIGIBLE only when it's both present and plan-derived — a caller-supplied
    // filter (types/entities/timeRange/near/geoRequired passed as an opt to hybridSearch) is
    // never a candidate for demotion, mirroring the pre-#365 caller-vs-plan distinction exactly.
    // Whole-pair flag, kept for the terminal caller-only-empty check below (a caller supplied
    // *any* time bound at all) — eligibility itself is decided per-bound just above/below.
    const timeAnyFromCaller = t0FromCaller || t1FromCaller;
    const typesFromCaller = !!types?.length;
    const entitiesFromCaller = !!entities?.length;
    const ladder = planDemotionLadder({
      // Eligible when at least one bound is present AND plan-derived — not gated on the sibling
      // bound's provenance, so a caller's start survives even when the plan invented the end.
      time: (!t0FromCaller && !!t0) || (!t1FromCaller && !!t1),
      geoRequired: !geoReqFromCaller && !!effGeoRequired,
      near: !geoFromCaller && geoIds != null,
      place: !!placePattern,
      types: !typesFromCaller && effTypes.length > 0,
      entities: !entitiesFromCaller && entityIds.length > 0,
    });

    // Cumulative prefix walk: drop one more rung each iteration (in the fixed ladder order) and
    // take the FIRST non-empty candidate set. Monotone widening only — the terminal rung (every
    // ladder field dropped) rebuilds exactly the caller-only filter set the pre-#365 fallback
    // used, so the result can only ever be narrower than or equal to today's, never wider.
    const dropped = new Set();
    let rung = 0;
    for (let i = 1; i <= ladder.length && candidates.size === 0; i++) {
      dropped.add(ladder[i - 1]);
      rung = i;
      candidates = applyGeo(prefilter({
        types: dropped.has('types') ? [] : effTypes,
        entityIds: dropped.has('entities') ? [] : entityIds,
        // Only the plan-derived bound is cleared when 'time' is dropped — a caller-supplied
        // bound survives even though its sibling was ladder-eligible (#510).
        t0: dropped.has('time') && !t0FromCaller ? null : t0,
        t1: dropped.has('time') && !t1FromCaller ? null : t1,
        placePattern: dropped.has('place') ? null : placePattern,
        placeAltPattern: dropped.has('place') ? null : placeAltPattern,
        geoRequired: dropped.has('geoRequired') ? false : effGeoRequired,
      }, rung, [...dropped]), dropped.has('near') ? null : geoIds);
    }
    // Only log when a rung actually recovered a non-empty set (Copilot review, PR #366) — the
    // loop's own condition means `candidates.size === 0` here iff every present rung was tried
    // and none worked (terminal honest-empty or full-fallback below), which this message would
    // otherwise mischaracterize as a successful recovery.
    if (rung > 0 && candidates.size > 0) {
      log.info('search.plan.demoted', 'a plan-derived filter was dropped to recover a non-empty candidate set', { rung, dropped: [...dropped] });
    }

    if (candidates.size === 0) {
      // The terminal rung dropped every plan-derived field, so what's left is exactly the
      // caller's own filters (if any). Matches the pre-#365 honest-empty-vs-fallback split.
      if (typesFromCaller || entitiesFromCaller || timeAnyFromCaller || geoReqFromCaller || geoFromCaller) {
        return []; // the caller's own filters matched nothing — honest empty
      }
      // else: nothing was caller-supplied, so `candidates` is already the full default_searchable
      // fallback (default_searchable types only, not all types — #121) — nothing further to try.
    }
    // Plan-derived `sort:'recent'` demotes only once `geoRequired` itself was among the dropped
    // fields — checked by membership, not rung position, since the ladder is built from whichever
    // fields are actually present: if only `time` was dropped (entity+place+type intact,
    // `geoRequired` never in the ladder at all, or never demoted), "last seen"/"most recent"
    // ordering is still the right answer for "when was X in Y" (#190's rationale — degrade to
    // relevance only once the topical geo constraint itself weakened, not on every retry).
    if (!sortFromCaller && dropped.has('geoRequired')) effSort = 'relevance';
  }
  if (candidates.size === 0) return []; // no default_searchable artifacts to rank

  // Deterministic result-set summary (#353): computed once over the FULL finalized candidate
  // set — before the ranking slice, regardless of which arm (recent / vector+FTS) runs below —
  // and attached to whichever array either path returns. spanSync: this is a synchronous
  // better-sqlite3 read, same discipline as prefilter above. Only a count reaches the log
  // (absolute rule 7); summarizeCandidates' own output (names, places) never does.
  const summary = log.spanSync('search.summarize.completed',
    () => summarizeCandidates(loadSummaryRows(candidates)),
    { candidates: candidates.size });

  // Deliver the finalized candidate set (post-retry, post-geo) to the ranking arms via the
  // indexed TEMP table (#227). The fill MUST sit in the same synchronous, await-free stretch as
  // the reads it feeds: the table is per-connection (shared across calls), so a concurrent
  // hybridSearch awaiting elsewhere must never refill it between this call's fill and its reads.
  // better-sqlite3 is synchronous, so `fill → read` runs atomically w.r.t. the event loop — this
  // restores the per-call isolation the old json_each local gave us. Helper keeps the two paths
  // (recent below; KNN/FTS after the embed await) from drifting apart.
  const fillCandidates = () => {
    clearCandidatesStmt.run();
    fillCandidatesStmt.run(JSON.stringify([...candidates]));
  };

  // Recency ordering (#190): once the candidate set carries the topical constraint (type/entity/geo),
  // "last seen" is a pure recency question — order by occurred_at DESC and skip the vec/FTS/RRF arms
  // (no embedding call, so this path is unaffected by the embedder being offline). `distance` is null,
  // like an FTS-only hit. getArtifactById attaches display_text just as the RRF path does.
  if (effSort === 'recent') {
    const rows = log.spanSync('db.recent.completed', () => {
      fillCandidates();
      return recentOrderStmt
        .all(limit)
        .map((r) => getArtifactById(r.id))
        .filter(Boolean)
        .map((a) => ({ ...a, distance: null }));
    }, { candidates: candidates.size, limit });
    return Object.assign(rows, { summary });
  }

  const k = clamp(limit * KNN_OVERFETCH, KNN_MIN, KNN_MAX);

  // Vector arm — ranked *within* the candidate set (filter-then-rank).
  // Best-effort; FTS still works if the embedding model is offline. The embed is the only await
  // on this path, so it runs BEFORE the candidate fill — everything after (fill → KNN → FTS) is
  // synchronous and cannot be interleaved by another search.
  let qvec = null;
  try {
    qvec = await embedToFloat32(searchText);
  } catch {
    // Silent by design: the embed span already wrote the ERROR row with its stack. The DECISION
    // this catch makes — degrade to FTS-only — is recorded as `embedded:false` on the
    // search.rank.completed span below, so it costs no second row (SKILL rules 17 and 19).
  }
  // One synchronous span over the whole fill -> KNN -> FTS stretch, with the two arms nested
  // inside it (#328). Nesting is the point: #227's regression was one arm, not the pair, so a
  // single combined duration would have hidden it. spanSync throughout — this stretch must stay
  // await-free (see fillCandidates' comment above), and an async span would break exactly that.
  const { vec, fts } = log.spanSync('search.rank.completed', () => {
    fillCandidates();
    const vecRows = qvec
      ? log.spanSync('db.knn.completed', () => knnInStmt.all(qvec, Math.min(k, candidates.size)), { k: Math.min(k, candidates.size) })
      : [];
    // Keyword arm — same constraint.
    const ftsQuery = toFtsQuery(searchText);
    const ftsRows = ftsQuery
      ? log.spanSync('db.fts.completed', () => ftsInStmt.all(ftsQuery, k), { k })
      : [];
    return { vec: vecRows, fts: ftsRows };
  }, { candidates: candidates.size, embedded: !!qvec });

  const fusedIds = rrf([vec.map((r) => r.artifact_id), fts.map((r) => r.artifact_id)]).slice(0, limit);
  const distById = new Map(vec.map((r) => [r.artifact_id, r.distance]));
  // Skip any id an index returns that no longer hydrates (orphaned after partial/corrupt state)
  // rather than emitting a malformed row.
  const out = fusedIds
    .map((id) => {
      const a = getArtifactById(id);
      return a ? { ...a, distance: distById.get(id) ?? null } : null;
    })
    .filter(Boolean);
  return Object.assign(out, { summary });
}

export function timeline(start, end, types, limit = 50) {
  const s = emptyish(start);
  const e = emptyish(end);
  // Month-scale ranges answer from daily digests where they exist (per-day substitution —
  // see timelineDigestStmt): a bounded span >= DIGEST_TIMELINE_DAYS with no explicit type
  // filter. Explicit types always win; open-ended ranges are unchanged. +1: the range is
  // inclusive on both ends (a 14-day calendar span).
  if (!types?.length && s && e) {
    const spanDays = (new Date(e) - new Date(s)) / MS_PER_DAY + 1;
    if (spanDays >= DIGEST_TIMELINE_DAYS) {
      return annotateArtifactRows(timelineDigestStmt.all({ start: s, end: e, eligible_json: DIGEST_ELIGIBLE_JSON, limit }));
    }
  }
  return annotateArtifactRows(timelineStmt.all({
    start: s,
    end: e,
    types_json: types?.length ? JSON.stringify(types) : null,
    limit,
  }));
}

// Graph-only recall: no embedding. Resolve name -> entity -> recent linked artifacts +
// entity relations (issue #37; person->org #88). `relations` is the entity's outgoing edges
// (worksAt, spouse, …); `relations_in` its incoming edges (#88) — for an org, the people who
// work there. Both [] when the entity has none. Merge
// redirect (#75) is inherited from resolveEntityIds — a name that used to resolve to an
// absorbed entity now resolves straight to the survivor, so no extra redirect logic is needed
// here; the survivor's `aboutStmt` results already include the absorbed entity's re-pointed
// links (the merge).
export function aboutEntity(name, limit = 10) {
  const ids = resolveEntityIds(name);
  if (!ids.length) return { resolved: false, name, entities: [] };
  const entities = ids.map((id) => ({ entity: getEntity(id), artifacts: annotateArtifactRows(aboutStmt.all(id, limit)), relations: getRelations(id), relations_in: getRelationsTo(id) }));
  return { resolved: true, name, entities };
}

export { getArtifactById, rrf, mergeEntities, listProbableDuplicates, listContactPhotos };
