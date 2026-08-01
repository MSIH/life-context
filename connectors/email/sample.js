#!/usr/bin/env node
// Rehearses a sent-mail backfill into a SCRATCH server, never the live one. Two large backfills are
// queued (a Yahoo and a Gmail store) and the one archive already ingested predates #386's quote
// stripping — 382/528 text_repr values sat at the snippet cap, all 528 with a null body_full. This
// is the pre-backfill instrument: ingest a stratified, deterministic sample of the REAL archive
// somewhere disposable, so a defective text_repr is caught before the real (append-only) store ever
// sees it. See #518 for the full design rationale.
//
// A separate script, not a --sample flag on index.js: a sampling flag on the real backfill entry
// point is one mistyped argument away from a partial real ingest, and the two need opposite safety
// defaults — index.js defaults to the live server, this refuses it outright.
//
// Reuses index.js's own buildPayload/packBatches/postBatchSplitting/MAX_BATCH_BYTES and mailstore's
// readMessages/detectStoreFormat — never re-derives parsing or posting logic, so the payloads this
// rehearses are byte-for-byte what a real backfill would send. index.js's `import.meta.url`
// main-guard is what makes importing it safe (its own main() never runs from this import).
//
// One deliberate divergence from the real run: `alreadyStored` (#374's POST /api/v1/exists filter)
// is NOT called. It must not be — the determinism check reruns the same sample and expects
// `0 created / N updated`, which exists-filtering would defeat by removing every already-stored
// message from the batch. So the exists call and its 404 fallback are the one code path a rehearsal
// does not exercise.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMessages, detectStoreFormat } from './mailstore.js';
import {
  buildPayload, packBatches, postBatchSplitting, MAX_BATCH_BYTES,
  INBOX_FOLDER_PATTERN, API_KEY_PLACEHOLDER, expandTilde,
} from './index.js';

// index.js's own module top-level already calls loadDotEnvIfPresent() as an import side effect
// (it is idempotent — skips any key already set), so process.env is fully populated by the time
// the consts below read it. Not called a second time here: one call site is what keeps the .env
// loading order unambiguous.

const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const STORE_PATH = expandTilde(process.env.EMAIL_STORE_PATH || '');
const SENT_FOLDER = process.env.EMAIL_SENT_FOLDER || 'Sent';

const DEFAULT_PER_YEAR = 25;
const DEFAULT_YEARS = 4;
// A fixed constant, not a random default: an operator who never passes --seed must still get the
// exact same sample on a re-run (the whole point of a seeded rehearsal — a scratch-DB diff after a
// parser change has to be signal, not noise from a different default seed each time).
const DEFAULT_SAMPLE_SEED = 518;
const PROGRESS_INTERVAL = 2000;
const LIVE_PORT = '3000'; // LifeContext's documented default port — refused outright, no exception
const UNDATED_KEY = 'undated';

// --- tiny CLI/env helpers ------------------------------------------------------------------------

// A flag whose value is missing (last argv) or is itself a flag is an operator error, not a request
// for the default: silently falling back to 25 on `--per-year` would run a rehearsal the operator
// did not ask for and cannot tell apart from the one they did.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    console.error(`email-sample: ${flag} needs a value`);
    process.exit(1);
  }
  return next;
}

// Positive INTEGER, not merely finite. `Number('')` is 0 and `Number.isFinite(0)` is true, so an
// empty env var used to sail through — and `perYear <= 0` makes reservoirPush's every branch false
// (`items.length < 0` never holds, and `j >= 0` is never `< 0`), so every bucket stays empty and the
// run posts nothing while reporting a clean summary and exit 0. A non-integer is just as bad one
// step later: `--years 2.5` makes pickSpreadYears index past the end and throw. Both are the
// fail-open shape this instrument exists to eliminate, so they are refused up front.
function numOpt(flag, envVar, fallback) {
  const raw = argValue(flag) ?? process.env[envVar];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`email-sample: ${flag} (or ${envVar}) must be a positive whole number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

// Port only, per the issue's contract — a scratch server on a different HOST but the same port as
// the live one is still refused, since "port matches LIFECONTEXT_URL" is the documented check, not
// "host+port matches". Returns null on an unparseable URL so the caller can fail closed.
function effectivePort(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return null; }
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

// --- seeded reservoir sampling --------------------------------------------------------------------

// A tiny LCG — Math.random() is forbidden here (#518): a re-run with the same seed and the same
// store must select the exact same messages, which only a deterministic generator can guarantee.
// Numerical Recipes' 32-bit constants; good enough for sampling, not cryptography.
function makeRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296; // -> [0, 1)
  };
}

// Algorithm R (Knuth): every message a bucket has ever seen gets an equal chance of surviving to
// the final `perYear`-sized reservoir, regardless of stream order — the fix for "the first N
// messages of a roughly-chronological mbox samples one January" (#518's Design Decisions). `bucket`
// is `{ count, items }`; `count` is every message seen (the full year distribution), `items` is the
// capped reservoir. One rng() call per message once the reservoir is full, never more.
function reservoirPush(bucket, item, perYear, rng) {
  if (bucket.items.length < perYear) {
    bucket.items.push(item);
  } else {
    const j = Math.floor(rng() * (bucket.count + 1)); // j in [0, count] inclusive
    if (j < perYear) bucket.items[j] = item;
  }
  bucket.count++;
}

// Picks `yearsWanted` years spread evenly across the account's real dated range, oldest and newest
// ALWAYS included (#518 Design Decisions: "that spread is the whole point" — a first-N-messages
// sample would rehearse one mail client's format and miss format drift going back to 2011).
function pickSpreadYears(sortedYears, yearsWanted) {
  if (yearsWanted <= 0 || sortedYears.length === 0) return [];
  if (sortedYears.length <= yearsWanted) return sortedYears.slice();
  if (yearsWanted === 1) return [sortedYears[sortedYears.length - 1]]; // one slot: newest wins
  const lastIdx = sortedYears.length - 1;
  const picked = [];
  for (let i = 0; i < yearsWanted; i++) {
    picked.push(sortedYears[Math.round((i * lastIdx) / (yearsWanted - 1))]);
  }
  return [...new Set(picked)]; // rounding can collide on a short range — dedup keeps intent (spread)
}

function formatDistribution(buckets) {
  const dated = [...buckets.entries()]
    .filter(([key]) => key !== UNDATED_KEY)
    .sort((a, b) => a[0] - b[0])
    .map(([year, b]) => `${year}:${b.count}`);
  const undated = buckets.get(UNDATED_KEY);
  if (undated) dated.push(`${UNDATED_KEY}:${undated.count}`);
  return dated.join(', ') || '(no messages)';
}

// --- validation, BEFORE any mail is read (#518: "zero messages read" on any failure) -------------

async function validateOrExit() {
  const postUrl = argValue('--post');
  if (!postUrl) {
    console.error('email-sample: --post <scratch-server-url> is required — this sampler never defaults to a target (see README.md)');
    process.exit(1);
  }
  const postPort = effectivePort(postUrl);
  if (postPort === null) {
    console.error('email-sample: --post is not a valid URL');
    process.exit(1);
  }
  if (postPort === LIVE_PORT) {
    console.error(`email-sample: --post refuses port ${LIVE_PORT} — that is LifeContext's default live port; point this at a scratch server on another port`);
    process.exit(1);
  }
  // Fail CLOSED on an unparseable LIFECONTEXT_URL. `postPort` is a non-null string by here, so a
  // `livePort` of null could never equal it — the guard would silently evaporate and a typo'd URL in
  // `.env` would remove a safety check with no message, which is the opposite of what :63's comment
  // promises.
  const livePort = effectivePort(LIFECONTEXT_URL);
  if (livePort === null) {
    console.error('email-sample: LIFECONTEXT_URL is not a valid URL — cannot prove --post is not the live server');
    process.exit(1);
  }
  if (postPort === livePort) {
    console.error("email-sample: --post's port matches LIFECONTEXT_URL's port — refusing to rehearse against what may be the live server");
    process.exit(1);
  }
  // Third rung: the live server's OWN port, when this box runs it somewhere other than 3000.
  // LIFECONTEXT_URL is optional and defaults to :3000, so an operator whose server listens on
  // another PORT and never set LIFECONTEXT_URL would otherwise get no protection at all — and the
  // failure writes real mail into the live append-only store, the one outcome that cannot be undone.
  if (process.env.PORT && postPort === process.env.PORT) {
    console.error("email-sample: --post's port matches this checkout's PORT — refusing to rehearse against what may be the live server");
    process.exit(1);
  }
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === API_KEY_PLACEHOLDER) {
    console.error('email-sample: LIFECONTEXT_API_KEY not configured — set it to the SCRATCH server\'s key (see README.md)');
    process.exit(1);
  }
  if (!STORE_PATH) {
    console.error('email-sample: EMAIL_STORE_PATH not set — point it at the mail store directory (see README.md)');
    process.exit(1);
  }
  if (INBOX_FOLDER_PATTERN.test(SENT_FOLDER)) {
    console.error(
      `email-sample: refusing to read "${SENT_FOLDER}" — this rehearses SENT mail only, same refusal as index.js (#346)`,
    );
    process.exit(1);
  }
  const folder = path.join(STORE_PATH, SENT_FOLDER);
  // A stat/readdir only — no message content read yet. This is the "store path readable" check;
  // reusing detectStoreFormat means an unreadable/mistyped path is caught with the same definition
  // of "readable" the real read path uses, rather than a second guess at what counts as valid.
  const format = await detectStoreFormat(folder);
  if (!format) {
    console.error('email-sample: EMAIL_STORE_PATH/EMAIL_SENT_FOLDER is not a readable mail folder (expected an mbox file or a maildir directory)');
    process.exit(1);
  }
  return { postUrl, folder };
}

// --- run -------------------------------------------------------------------------------------------

async function run() {
  const startedAt = Date.now();
  const perYear = numOpt('--per-year', 'EMAIL_SAMPLE_PER_YEAR', DEFAULT_PER_YEAR);
  const yearsWanted = numOpt('--years', 'EMAIL_SAMPLE_YEARS', DEFAULT_YEARS);
  const seed = numOpt('--seed', 'EMAIL_SAMPLE_SEED', DEFAULT_SAMPLE_SEED);
  const { postUrl, folder } = await validateOrExit();
  const rng = makeRng(seed);

  console.error(
    `email-sample: reading, per-year=${perYear} years=${yearsWanted} seed=${seed}, ` +
    `batch budget ${(MAX_BATCH_BYTES / 1024).toFixed(0)}kb`,
  );

  // EMAIL_SINCE is deliberately ignored (#518 Design Decisions) — it bounds a recent window, so it
  // can only ever rehearse the newest client's output, exactly the format drift a year-spread
  // sample exists to catch.
  // `batchFailed`, deliberately NOT `spooled`: index.js's `spooled` means "written to
  // EMAIL_SPOOL_DIR for the next run to retry", i.e. recoverable. Nothing is persisted here, so
  // borrowing that word would tell a reader who knows the sibling connector the opposite of the
  // truth about recoverability.
  const counts = { read: 0, parseFailures: 0, posted: 0, batches: 0, created: 0, updated: 0, failed: 0, batchFailed: 0, quarantined: 0 };
  const parseFailureKinds = new Map(); // error class -> count. The CLASS is not user content.
  const buckets = new Map(); // year (number) | UNDATED_KEY -> { count, items: [payload,...] }
  for await (const message of readMessages(folder)) {
    counts.read++;
    if (counts.read % PROGRESS_INTERVAL === 0) console.error(`email-sample: read ${counts.read} messages`);
    let payload;
    let occurredAt;
    try {
      ({ payload, occurredAt } = await buildPayload(message));
    } catch (err) {
      // The error MESSAGE is never printed — a parser's text can quote a header/body fragment back,
      // and stderr here is counts-only by contract (absolute rule 7). The error's CLASS carries no
      // user content, though, and discarding it too would collapse "every 2013 message fails the
      // same way" and "random scattered failures" into one indistinguishable number — exactly the
      // diagnosis a pre-backfill instrument exists to provide. Counted by class, reported in the
      // summary.
      const kind = err?.constructor?.name ?? 'Unknown';
      parseFailureKinds.set(kind, (parseFailureKinds.get(kind) ?? 0) + 1);
      counts.parseFailures++;
      continue;
    }
    const key = occurredAt ? new Date(occurredAt).getUTCFullYear() : UNDATED_KEY;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { count: 0, items: [] }; buckets.set(key, bucket); }
    reservoirPush(bucket, payload, perYear, rng);
  }

  const sortedYears = [...buckets.keys()].filter((k) => k !== UNDATED_KEY).sort((a, b) => a - b);
  const chosenYears = pickSpreadYears(sortedYears, yearsWanted);
  const undatedBucket = buckets.get(UNDATED_KEY);
  const includeUndated = Boolean(undatedBucket?.items.length);

  const selected = [
    ...chosenYears.flatMap((year) => buckets.get(year).items),
    ...(includeUndated ? undatedBucket.items : []),
  ];

  // A rehearsal that selected nothing has PROVEN nothing, and every downstream count would read as
  // a clean zero: packBatches([]) returns [], the post loop never runs, and the summary prints a
  // tidy "posted 0 … quarantined 0". Reporting that as success is the #324/#400/#405 fail-open shape
  // this whole instrument exists to catch, one level up. Refuse it loudly instead.
  if (!selected.length) {
    console.error(
      `email-sample: selected 0 messages of ${counts.read} read (${counts.parseFailures} parse failures) — nothing was rehearsed. ` +
      'An empty or unreadable sent folder, or a store whose messages all failed to parse.',
    );
    process.exit(1);
  }

  const batches = await packBatches(selected);
  counts.batches = batches.length;
  // Same path index.js posts to — `--post` names the server, not the route. Built with `new URL`
  // rather than concatenation because a trailing slash (`http://host:3099/`, an entirely natural
  // thing to type) would otherwise yield `//api/v1/ingest/batch`, which this server 404s — verified
  // against a real scratch instance: the correct path returns 422 for an empty batch, the
  // double-slash one returns 404. Post-#518's exit-code fix that surfaces as a loud INCOMPLETE run
  // rather than a silent one, but it is still a baffling failure for a correct-looking invocation.
  const ingestUrl = new URL('/api/v1/ingest/batch', postUrl).toString();
  for (const batch of batches) {
    try {
      const { landed, irreducible } = await postBatchSplitting(ingestUrl, batch);
      for (const { result } of landed) {
        // An ABSENT result (a server returning fewer results than items submitted) must never fall
        // through to the success bucket — `result?.error` and `result?.created` are both falsy for
        // `undefined`, so a bare `else` would silently score an unaccounted item as "updated" and
        // corrupt the determinism check, whose whole signal is `0 created / N updated`.
        if (result?.error) counts.failed++;
        else if (result?.created) counts.created++;
        else if (result) counts.updated++;
        else counts.failed++;
      }
      // Only cleanly-landed items count as posted, or the issue's "artifact count == messages
      // posted" assertion can never hold on a run with any rejection — and the mismatch would read
      // as a store defect rather than the ingest rejection it actually is.
      counts.posted += landed.filter(({ result }) => result && !result.error).length;
      // Irreducible (index.js's own #405 vocabulary): one payload's own serialized size exceeds
      // MAX_BATCH_BYTES so no batch size could ever deliver it. The payload is not written to disk —
      // a rehearsal has no quarantine directory (#518 forbids touching EMAIL_SPOOL_DIR) and the
      // sample is reproducible from seed+store anyway. Its source_id IS logged, mirroring
      // index.js's own quarantine line: an irreducible payload is the single most interesting thing
      // a pre-backfill rehearsal can find, and a bare count gives the operator nothing to grep for.
      for (const item of irreducible) {
        console.error(`email-sample: irreducible payload ${item.source_id} — a real run would quarantine it`);
      }
      counts.quarantined += irreducible.length;
    } catch (err) {
      // Nothing is spooled in a rehearsal — a batch that fails for a reason other than 413 (already
      // handled inside postBatchSplitting) is counted and discarded; re-run the whole rehearsal once
      // the scratch server is fixed. A non-zero count here means this run is NOT a completed
      // rehearsal, which the exit code below reflects.
      counts.batchFailed += batch.length;
      console.error(`email-sample: a batch of ${batch.length} failed to post (status ${err.status ?? 'network'})`);
    }
  }

  const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(
    `email-sample: read ${counts.read}, parse failures ${counts.parseFailures}, ` +
    `posted ${counts.posted}, batches ${counts.batches}, created ${counts.created}, ` +
    `updated ${counts.updated}, failed ${counts.failed}, batch-failed ${counts.batchFailed}, ` +
    `quarantined ${counts.quarantined}, wall ${wallSeconds}s`,
  );
  if (parseFailureKinds.size) {
    const breakdown = [...parseFailureKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(', ');
    console.error(`email-sample: parse failures by class — ${breakdown}`);
  }
  console.error(`email-sample: year distribution (whole store) — ${formatDistribution(buckets)}`);
  const yearsLabel = `${chosenYears.join(', ')}${includeUndated ? `${chosenYears.length ? ' + ' : ''}undated` : ''}`;
  console.error(`email-sample: years sampled — ${yearsLabel || '(none)'}`);

  // An incomplete rehearsal must not report success. `batchFailed` is not the only way to be
  // incomplete: a server that rejects every item per-item returns 200s with `{error}` bodies
  // (`failed`), and an irreducible payload never landed at all (`quarantined`) — the issue's own
  // acceptance criteria demand 0 for both.
  const incomplete = counts.batchFailed + counts.failed + counts.quarantined;
  if (incomplete > 0) {
    console.error(`email-sample: INCOMPLETE — ${incomplete} of ${selected.length} sampled messages did not land cleanly`);
    process.exitCode = 1;
  }

  // stdout: the ONE machine/human-readable line, so the operator's next step is obvious. This
  // sampler talks HTTP only (never opens a DB — #518's "MUST NOT" list), so it cannot literally
  // name a scratch DB_PATH; the --post target IS the pointer to that scratch server's DB.
  console.log(`email-sample: years ${yearsLabel || '(none)'} -> scratch target ${postUrl}`);
}

// Only run when invoked directly, mirroring index.js's own guard — so a future test.mjs addition
// can import this module's helpers without triggering a rehearsal.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    // The error's CLASS only — never its message or stack. `mailstore.js` reads the store with
    // `readFile`/`stat`, so an EACCES or a file deleted mid-read produces an Error whose `.message`
    // carries the FULL ABSOLUTE PATH to a mail file; printing `err` verbatim would put a store path
    // on stderr, which this connector's logging contract forbids outright (README "Logging: counts,
    // source_ids and durations only — never … a store path"). The class still names what broke.
    console.error(`email-sample: rehearsal failed (${err?.constructor?.name ?? 'Error'}) — see the store path and permissions for the configured EMAIL_STORE_PATH/EMAIL_SENT_FOLDER`);
    process.exitCode = 1;
  });
}
