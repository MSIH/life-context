#!/usr/bin/env node
// Backfills SENT mail from a local mail store into LifeContext. A desktop mail client
// (Thunderbird or equivalent) does the downloading over OAuth2 with its own provider credentials —
// so this connector holds no mail credential, opens no mailbox socket, and only reads files.
//
// Sent-only is a safety boundary, not a scope cut: sent mail is written by the account owner, so
// its subject and body are not attacker-controlled. Inbound mail is the opposite and is handled
// separately, under much tighter rules. Do NOT point EMAIL_SENT_FOLDER at an Inbox.
//
// Going-forward capture is a different lane (a private companion repo); this is history only. Both
// derive source_id the same way so a message seen by both upserts to ONE artifact. See README.md.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMessages, detectStoreFormat } from './mailstore.js';
import {
  splitMessage, parseHeaders, parseAddressList, parseAddress,
  sourceIdFor, parseDateHeader, buildTextRepr, sha256, parseMessageIdList,
} from './parse.js';
import { extractBodyText } from './mime.js';
import { quoteBoundaryFound } from './quotes.js';

loadDotEnvIfPresent();

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const STORE_PATH = expandTilde(process.env.EMAIL_STORE_PATH || '');
const SENT_FOLDER = process.env.EMAIL_SENT_FOLDER || 'Sent';
const STATE_PATH = expandTilde(process.env.EMAIL_STATE_PATH || path.join(os.homedir(), '.life-context', 'email-state.json'));
const SPOOL_DIR = expandTilde(process.env.EMAIL_SPOOL_DIR || path.join(os.homedir(), '.life-context', 'email-spool'));

// Re-ingest (#374). By default `exists` filters an already-stored source_id out of the batch, which
// makes an enrichment wave impossible for this connector: no later text_repr improvement (#368's
// signature stripping, #386's quote stripping, a better snippet) can ever reach an artifact already
// in the store, and the run says so only as a cheerful `already-stored`, exit 0. `exists` cannot know
// whether the PAYLOAD changed — only core can, and only if the payload is submitted (src/ingest.js
// compares text_repr and re-embeds solely on a difference). This flag submits everything and lets
// that comparison happen. Default stays off so a genuine first backfill is still cheap. Same
// argv-or-env shape as the sibling imessage connector's --watch.
const REINGEST = process.argv.includes('--reingest') || process.env.EMAIL_REINGEST === 'true';

// The sent-only boundary, enforced rather than documented. Everything about this connector — that
// subjects and bodies are safe to store, and safe for `search` to replay into an agent's context —
// rests on the mail being written BY the account owner. Pointed at an Inbox it would quietly ingest
// attacker-controlled text into exactly the store that has no provenance or fencing layer yet
// (#346). A README warning is not a control; this is.
export const INBOX_FOLDER_PATTERN = /(^|[^a-z])inbox([^a-z]|$)/i;
const INGEST_BATCH_MAX = 100;      // contract cap (docs/04-connector-contract.md §2)
const EMAIL_BATCH_SIZE = 50;       // the ITEM ceiling only (contract cap, doc 04 §2) — NOT what bounds
// wire size (#405). The server's real limit is BYTES: JSON_BODY_LIMIT = '256kb' (src/ingest.js:31,
// 262,144 bytes). Before #390 an item cap held anyway because text_repr was capped at
// SNIPPET_MAX_CHARS, so wire size per item stayed roughly flat; extra.body_full (#386) is
// deliberately uncapped, so wire size now scales with real body size and a count-based batch cannot
// respect a byte cap on its own. Measured: 50 messages at the historical "bulky" test size (3x
// SNIPPET_MAX_CHARS = 3,000 chars) still fit a single batch; 50 messages each at mime.js's own
// MAX_PART_CHARS ceiling (20,000 chars) do NOT (~1.1MB, over 4x the cap) — which is exactly why
// packing must be byte-aware, not just item-aware. EMAIL_BATCH_SIZE stays as an ADDITIONAL ceiling
// (createBatcher/packBatches below never exceed it either) so a batch of many tiny messages still
// respects the contract's ≤100-item cap.
export const MAX_BATCH_BYTES = 200 * 1024; // 200kb — ~57kb (22%) of headroom below the 256kb server cap.
// The headroom covers what this budget does NOT measure (each payload's OWN serialized size, not the
// fully framed request: the `{"artifacts":[...]}` wrapper and inter-item commas) plus margin for
// measurement drift across Node/V8 versions. Deliberately not tuned closer to 256kb — see
// test.mjs's realistic-body-size packing test and #405 for the measurement this replaces.
const DEFAULT_SINCE_MONTHS = 24;   // an unset EMAIL_SINCE must never mean "the whole archive"
const MAX_BACKOFF_MS = 30_000;
export const API_KEY_PLACEHOLDER = 'change-this-to-a-long-secure-token';

// Not exported: sample.js (#518) gets this for free as an import side effect (this module calls it
// at top level, and it skips any key already set), so an export would name a consumer that does not
// exist. INBOX_FOLDER_PATTERN, API_KEY_PLACEHOLDER and expandTilde ARE exported for it, so the
// refusal, the placeholder check and the path expansion have exactly one implementation between the
// two entry points — a second copy of any of those is the drift this connector's contract forbids.
function loadDotEnvIfPresent() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] !== undefined) continue;
    const v = rawValue.trim();
    const quoted = /^(['"])(.*)\1$/.exec(v);
    process.env[key] = quoted ? quoted[2] : v.replace(/\s+#.*$/, '').trim();
  }
}

export function expandTilde(filePath) {
  if (!filePath) return filePath;
  return filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

// The date bound is enforced HERE rather than delegated to whatever the mail client happened to
// sync — the store's contents are not this connector's contract.
function resolveSince() {
  const raw = process.env.EMAIL_SINCE;
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new Error('EMAIL_SINCE is not a parseable date (expected e.g. 2024-01-01)');
    return new Date(ms).toISOString();
  }
  const d = new Date();
  d.setMonth(d.getMonth() - DEFAULT_SINCE_MONTHS);
  return d.toISOString();
}

// --- payload ------------------------------------------------------------------------------------

// Hints, never entity IDs (doc 04 §4). `suggested_kind` is deliberately OMITTED: without it core
// stages a proposal for a recipient already in contact_directory and leaves an unknown address in
// unresolved_aliases, which is exactly the input the frequency promoter (#87) needs. Setting it
// would stage one proposal per recipient and flood the review queue.
function buildHints(from, recipients) {
  const hints = [];
  const push = (addr, role) => {
    if (!addr) return;
    hints.push({ alias: addr.email, alias_type: 'email', role });
    if (addr.name) hints.push({ alias: addr.name, alias_type: 'name', role });
  };
  push(from, 'sender');
  for (const r of recipients) push(r, 'recipient');
  return hints;
}

export async function buildPayload({ raw, sourcePath }) {
  // rawBody feeds sourceIdFor, bodyText feeds buildTextRepr — never swap these. sourceIdFor's
  // no-Message-ID fallback hashes the body, so substituting the newly-decoded text there would
  // re-key every such message on this fix's first run and create permanent duplicates in an
  // append-only store (#362).
  const { headerText, body: rawBody } = splitMessage(raw);
  const headers = parseHeaders(headerText);
  const from = parseAddress(headers.from || '');
  const recipients = [...parseAddressList(headers.to || ''), ...parseAddressList(headers.cc || '')];
  const occurredAt = parseDateHeader(headers.date);
  const subject = headers.subject || '';
  const { text: bodyText, source: bodySource, mimeType } = await extractBodyText(raw);

  // Thread identity travels by reference, not by re-embedding the correspondent's own words in every
  // later message (#386's whole point). Omitted, never null-filled, when the header is absent (~47%
  // of messages) — connector-conventions rule 7 forbids clearing a field with an explicit null, and
  // fabricating one here would be worse: a bogus `in_reply_to` would misattribute a thread.
  //
  // RFC 5322 defines In-Reply-To as 1*msg-id (and permits CFWS between them), so it is parsed through
  // the same parseMessageIdList as References rather than stored verbatim — a raw copy could be
  // multi-valued or carry a comment, which is not "the one parent". The LAST id is the immediate
  // parent (References lists the whole chain root-first; In-Reply-To, when it disagrees, still names
  // the direct parent last) — kept as a single bracketed string, matching what a thread-key consumer
  // expects, while `references` stays the full chain.
  const inReplyTo = parseMessageIdList(headers['in-reply-to']);
  const references = parseMessageIdList(headers.references);

  const payload = {
    source: 'email',
    source_id: sourceIdFor({ messageId: headers['message-id'], from: headers.from, date: headers.date, subject, body: rawBody }),
    type: 'email',
    text_repr: buildTextRepr({ recipients, subject, body: bodyText }),
    content_hash: sha256(raw),
    extra: {
      message_id: headers['message-id'] || null,
      reader: 'mailstore',
      recipient_count: recipients.length,
      body_source: bodySource,
      mime_type: mimeType,
      // The complete decoded body, pre-strip — what makes stripping non-lossy. Never embedded, never
      // FTS-indexed (that duplication is exactly what this issue removes); it exists so a
      // correspondent's side of the conversation is still reconstructable from stored data alone.
      body_full: bodyText,
    },
    entity_hints: buildHints(from, recipients),
  };
  if (inReplyTo.length) payload.extra.in_reply_to = inReplyTo.at(-1);
  if (references.length) payload.extra.references = references;
  // Omitted rather than guessed when the Date header is missing or unparseable — a wrong
  // occurred_at silently mis-sorts the timeline (connector-conventions rule 5).
  if (occurredAt) payload.occurred_at = occurredAt;
  // Only a maildir gives one message a stable path; an mbox has no per-message address.
  if (sourcePath) payload.raw_path = sourcePath;
  return { payload, occurredAt, quoteBoundary: quoteBoundaryFound(bodyText) };
}

// --- HTTP ---------------------------------------------------------------------------------------

const authHeaders = { 'content-type': 'application/json', 'x-api-key': LIFECONTEXT_API_KEY };

async function postWithBackoff(url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    // 429 is the documented rate-limit signal (doc 04 §2) and the one status worth waiting out.
    if (res.status !== 429 || attempt >= 5) {
      const err = new Error(`${url} returned ${res.status}`);
      err.status = res.status; // callers branch on it — see the 404 fallback in alreadyStored
      throw err;
    }
    const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    console.error(`email: rate limited, retrying in ${wait}ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// Split-on-413 (#405). Only 413 (payload too large) triggers a split; every other status — including
// 429, which postWithBackoff already retries with backoff — propagates unchanged, same as before a
// batch that overflows the byte cap despite the packer's budget (packBatches/createBatcher below
// estimate each payload's OWN serialized size, not the fully framed request body, so the budget is a
// close but not exact bound) degrades by halving rather than failing the whole batch outright. A
// single item that still 413s ALONE is irreducible — it can never fit in any multi-item batch, so it
// is reported back (not retried) for the caller to quarantine (design-philosophy §1: relocated,
// never dropped). `landed` pairs each submitted item with its own result by array position — a
// reference, not a source_id Set, so a batch that happens to carry a duplicate source_id (or one
// that recurses through several splits) is never mislabeled.
export async function postBatchSplitting(url, artifacts) {
  try {
    const res = await postWithBackoff(url, { artifacts });
    const results = res.results ?? [];
    return { landed: artifacts.map((item, i) => ({ item, result: results[i] })), irreducible: [] };
  } catch (err) {
    if (err.status !== 413) throw err;
    if (artifacts.length <= 1) return { landed: [], irreducible: artifacts };
    const mid = Math.ceil(artifacts.length / 2);
    const left = await postBatchSplitting(url, artifacts.slice(0, mid));
    const right = await postBatchSplitting(url, artifacts.slice(mid));
    return { landed: [...left.landed, ...right.landed], irreducible: [...left.irreducible, ...right.irreducible] };
  }
}

// Which of these source_ids are already stored (#198). This is the idempotency mechanism —
// correctness never depends on the state file below.
//
// A 404 means this core predates /exists, and doc 04 §2 requires falling back to processing
// everything rather than hard-failing. Safe to do: ingest is an upsert on (source, source_id), so
// re-submitting a stored artifact rewrites its derived representation instead of duplicating it —
// the cost is wasted work, never a duplicate. Logged once, not once per batch.
let existsUnsupported = false;
async function alreadyStored(sourceIds) {
  if (existsUnsupported) return new Set();
  const stored = new Set();
  for (let i = 0; i < sourceIds.length; i += INGEST_BATCH_MAX) {
    const slice = sourceIds.slice(i, i + INGEST_BATCH_MAX);
    try {
      const { exists } = await postWithBackoff(`${LIFECONTEXT_URL}/api/v1/exists`, { source: 'email', source_ids: slice });
      for (const id of exists ?? []) stored.add(id);
    } catch (err) {
      if (err.status !== 404) throw err;
      existsUnsupported = true;
      console.error('email: this LifeContext predates POST /api/v1/exists — processing everything (upsert makes it safe)');
      return new Set();
    }
  }
  return stored;
}

// --- batching (#405) -----------------------------------------------------------------------------
// The ONE packing rule shared by the live read path (run(), below) and flushSpool — a second packing
// rule is precisely how EMAIL_BATCH_SIZE (item cap) and the server's byte cap drifted apart in the
// first place. `createBatcher` is the shared primitive: the live path pushes payloads one at a time
// as it streams the mailbox (bounded memory, an incremental resume marker), while flushSpool already
// holds every spooled payload in memory and pushes them all through the same instance. Either way,
// the boundary decision — is the batch full? — is made in exactly one place.
export function payloadByteLength(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

// `sizeOf` lets a caller batch something that CARRIES a payload rather than being one: the live read
// path pushes {payload, readIndex} so its flush can write a truthful resume marker (see run()), and
// flushSpool pushes bare filenames so it never parses the whole spool into memory. The boundary rule
// itself stays in this one function either way — only the measuring differs.
function createBatcher(onFlush, sizeOf = payloadByteLength) {
  let batch = [];
  let bytes = 0;
  return {
    async push(item) {
      const size = sizeOf(item);
      // Close the CURRENT batch before adding an item that would push it past either bound — never
      // split a single payload across two batches (that would need a second wire format entirely).
      // NOTE: this look-ahead means the incoming item is NOT part of the batch being flushed, so a
      // caller deriving state from its own read position must use the flushed batch's own items and
      // never its live counter — the #405 review found exactly that off-by-one here.
      if (batch.length && (batch.length >= EMAIL_BATCH_SIZE || bytes + size > MAX_BATCH_BYTES)) {
        await onFlush(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(item);
      bytes += size;
    },
    async finish() {
      if (batch.length) await onFlush(batch);
    },
  };
}

// A pre-collected-array convenience over createBatcher, for a caller (flushSpool) that already has
// every payload in hand rather than streaming them one at a time.
export async function packBatches(items, sizeOf = payloadByteLength) {
  const batches = [];
  const batcher = createBatcher(async (batch) => { batches.push(batch); }, sizeOf);
  for (const i of items) await batcher.push(i);
  await batcher.finish();
  return batches;
}

// --- spool + quarantine (doc 04 §7, #405) ---------------------------------------------------------
// Per-payload files, not one shared file: a shared spool is unsafe if the connector ever runs
// concurrently with itself, and per-payload files make a partial flush trivially resumable.

function spool(payloads) {
  mkdirSync(SPOOL_DIR, { recursive: true });
  for (const p of payloads) {
    writeFileSync(path.join(SPOOL_DIR, `${sha256(p.source_id)}.json`), JSON.stringify(p), 'utf8');
  }
}

// A payload whose own serialized size alone exceeds MAX_BATCH_BYTES can never land in ANY batch, no
// matter how it is split — retrying it forever would re-derive the same 413 on every run (exactly
// this issue's bug). Quarantining it — a subdirectory of EMAIL_SPOOL_DIR, never a delete — keeps it
// visible and reconstructable (design-philosophy §1) while letting the run move on. Named by
// source_id only, never a subject/address/store path (the connector's existing logging discipline).
const QUARANTINE_DIR = path.join(SPOOL_DIR, 'quarantine');
function quarantine(payload) {
  mkdirSync(QUARANTINE_DIR, { recursive: true });
  writeFileSync(path.join(QUARANTINE_DIR, `${sha256(payload.source_id)}.json`), JSON.stringify(payload), 'utf8');
}

// Non-fatal by construction (#405): every per-batch failure is caught HERE, inside the loop, so one
// undrainable spooled payload can never stop the rest of the spool — or the mail read that follows —
// from making progress. A batch that 413s splits/quarantines via postBatchSplitting; any OTHER
// failure (network, 5xx, exhausted 429 backoff) leaves that batch's files in place for the next run
// and moves on to the next batch, rather than throwing out of flushSpool entirely.
async function flushSpool() {
  if (!existsSync(SPOOL_DIR)) return { flushed: 0, quarantined: 0 };
  const files = readdirSync(SPOOL_DIR).filter((f) => f.endsWith('.json'));
  // Pack by each spool FILE's on-disk size, not by its parsed payload: a spool file is exactly
  // JSON.stringify(payload) written as utf8, so its size is byte-identical to what
  // payloadByteLength would return — and batching on filenames means only ONE batch of payloads is
  // ever resident (connector-conventions.md failure posture: never buffer unbounded in memory). The
  // spool can hold a whole backlog's worth of uncapped extra.body_full, so parsing it all up front
  // to decide batch boundaries would scale memory with the backlog. Found in #405's pre-PR review.
  const fileBatches = await packBatches(files, (f) => statSync(path.join(SPOOL_DIR, f)).size);
  let flushed = 0;
  let quarantined = 0;
  for (const fileBatch of fileBatches) {
    try {
      // Parsed per batch, and the map is keyed by object REFERENCE — safe because postBatchSplitting
      // only ever slices/rejoins the array it was given, never clones an item.
      const fileByPayload = new Map();
      const batch = fileBatch.map((f) => {
        const payload = JSON.parse(readFileSync(path.join(SPOOL_DIR, f), 'utf8'));
        fileByPayload.set(payload, f);
        return payload;
      });
      const { landed, irreducible } = await postBatchSplitting(`${LIFECONTEXT_URL}/api/v1/ingest/batch`, batch);
      // Only unlink after the POST (or quarantine write) resolves — a crash mid-flush replays, it
      // never loses.
      for (const { item } of landed) {
        unlinkSync(path.join(SPOOL_DIR, fileByPayload.get(item)));
        flushed++;
      }
      for (const item of irreducible) {
        quarantine(item);
        unlinkSync(path.join(SPOOL_DIR, fileByPayload.get(item)));
        quarantined++;
        console.error(`email: quarantined an irreducible spooled payload ${item.source_id} — see EMAIL_SPOOL_DIR/quarantine`);
      }
    } catch (err) {
      // Left in the spool for the next attempt — never lost, never blocking THIS run (#405).
      console.error(`email: spool flush failed for a batch of ${fileBatch.length} — left in spool for retry`, err);
    }
  }
  return { flushed, quarantined };
}

// --- state (efficiency only) ----------------------------------------------------------------------
// A resume marker, never a correctness mechanism: `exists` already makes a re-run ingest zero
// duplicates. Keyed on the store's own size+mtime so an appended-to mbox invalidates it rather than
// silently skipping newly-synced messages.

function readState(fingerprint) {
  try {
    const saved = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return saved.fingerprint === fingerprint ? saved.processed ?? 0 : 0;
  } catch {
    return 0;
  }
}

function writeState(fingerprint, processed) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ fingerprint, processed }), 'utf8');
}

function storeFingerprint(target) {
  try {
    const s = statSync(target);
    return `${s.size}:${Math.floor(s.mtimeMs)}`;
  } catch {
    return 'unknown';
  }
}

// --- main ---------------------------------------------------------------------------------------

// Two failure modes, deliberately handled differently. An unreachable server fails the `exists`
// call FIRST and is left to propagate — fatal, exit non-zero, fix it and re-run. That is the right
// answer for a backfill whose source is durable on disk: re-reading the store is cheap, whereas
// spooling is bounded by nothing and a down server would otherwise write the entire archive out as
// spool files. A server that is up but rejects one batch is the case worth spooling: bounded to
// EMAIL_BATCH_SIZE payloads, and the next run delivers them.
async function flushBatch(batch, counts) {
  if (!batch.length) return;
  // In re-ingest mode `exists` is still called, but its answer changes ROLE: it LABELS each item
  // (already stored -> resubmitted) instead of filtering it out. That is what keeps the summary
  // honest — "healed 528" and "newly stored 528" must never read the same (#374) — at the cost of
  // one already-batched call per flush, which a deliberate healing run can afford.
  const stored = await alreadyStored(batch.map((p) => p.source_id));
  const fresh = REINGEST ? batch : batch.filter((p) => !stored.has(p.source_id));
  if (!REINGEST) counts.skippedStored += batch.length - fresh.length;
  if (!fresh.length) return;
  try {
    // postBatchSplitting (#405) degrades a 413 by halving rather than failing the whole batch, and
    // reports an irreducible single item back instead of throwing — so this try only ever sees a
    // NON-413 failure (network, 5xx, exhausted 429 backoff), same as before this change.
    const { landed, irreducible } = await postBatchSplitting(`${LIFECONTEXT_URL}/api/v1/ingest/batch`, fresh);
    // A per-item validation failure is logged by source_id and not retried forever; the whole batch
    // is not lost for one bad item (the contract isolates per item). Tracked by ITEM REFERENCE, not
    // source_id — a Set of ids would mislabel every same-id item if a batch ever carried a duplicate
    // source_id (an object reference is unique regardless of how many times it was split/rejoined).
    for (const { item, result } of landed) {
      if (result?.error) {
        counts.failed++;
        console.error(`email: item failed ${item.source_id}: ${result.error}`);
        continue;
      }
      // Count only what actually landed — a summary that reports rejected items as ingested is worse
      // than no summary, since it is the only signal an unattended backfill gives. Attributed per
      // item by what `exists` said about it; in default mode `stored` and `fresh` are disjoint by
      // construction, so `resubmitted` stays 0 and this reduces to the previous arithmetic.
      if (stored.has(item.source_id)) counts.resubmitted++;
      else counts.ingested++;
    }
    for (const item of irreducible) {
      // Irreducible (#405): this ONE payload's own serialized size exceeds MAX_BATCH_BYTES, so no
      // batch size could ever deliver it — quarantine rather than retry it into the spool forever.
      quarantine(item);
      counts.quarantined++;
      console.error(`email: quarantined an irreducible payload ${item.source_id} — see EMAIL_SPOOL_DIR/quarantine`);
    }
  } catch (err) {
    // Spool, don't retry-loop in memory (doc 04 §7). Next run flushes.
    spool(fresh);
    counts.spooled += fresh.length;
    console.error(`email: batch failed (${err.message}) — spooled ${fresh.length} payloads for the next run`);
  }
}

async function run() {
  const since = resolveSince();
  const folder = path.join(STORE_PATH, SENT_FOLDER);
  const format = await detectStoreFormat(folder);
  const fingerprint = storeFingerprint(folder);
  // A re-ingest run must not be short-circuited by a matching folder fingerprint either. The marker
  // is an efficiency device, never correctness (see readState), and healing is exactly the case where
  // re-reading a folder whose bytes have not changed is the entire point — so one flag covers it,
  // rather than also requiring an undocumented fresh EMAIL_STATE_PATH (#374).
  const resumeAfter = REINGEST ? 0 : readState(fingerprint);
  const counts = {
    read: 0, tooOld: 0, skippedStored: 0, ingested: 0, resubmitted: 0, failed: 0, spooled: 0, quarantined: 0,
    bodyPlain: 0, bodyHtml: 0, bodyNone: 0, quoteBoundary: 0,
  };

  // Non-fatal (#405): flushSpool already catches per-batch failures internally and does not throw for
  // them, but this belt-and-suspenders try/catch is what keeps a genuinely unexpected flush error
  // (e.g. a filesystem permission failure on SPOOL_DIR itself) from ever stopping the mail read below
  // — the whole point of this issue is that a spool problem must never brick forward progress.
  let flushedFromSpool = 0;
  try {
    const spoolResult = await flushSpool();
    flushedFromSpool = spoolResult.flushed;
    counts.quarantined += spoolResult.quarantined;
  } catch (err) {
    console.error('email: spool flush failed, continuing to read mail', err);
  }
  if (flushedFromSpool) console.error(`email: flushed ${flushedFromSpool} spooled payloads from a previous run`);

  // Log the mode, so a run's behaviour is legible in its own output rather than inferred from a flag
  // nobody can see afterwards.
  if (REINGEST) {
    console.error('email: RE-INGEST mode — submitting every message including already-stored ones, resume marker ignored; core re-embeds only what changed');
  }
  console.error(`email: reading ${format} folder, since ${since.slice(0, 10)}${resumeAfter ? `, resuming after ${resumeAfter}` : ''}`);

  // createBatcher (#405) is the ONE packer shared with flushSpool — see its definition above. Flushing
  // a batch also writes the resume marker, exactly as the old fixed-size flush did.
  //
  // The marker is the read index of the LAST payload in the FLUSHED batch — never `counts.read`. The
  // packer decides fullness BEFORE adding the incoming payload (it must, to keep a batch under the
  // byte budget), so at flush time `counts.read` has already counted a payload that is going into the
  // NEXT batch and has not been submitted. Writing it would mark that message processed; a crash
  // before the next flush then resumes past it and it is NEVER ingested — silently and permanently,
  // since the mailbox fingerprint is unchanged so the marker never invalidates. `exists`-based
  // idempotency cannot save this: it prevents duplicates, not skips. Found in #405's pre-PR review.
  const batcher = createBatcher(
    async (entries) => {
      await flushBatch(entries.map((e) => e.payload), counts);
      writeState(fingerprint, entries[entries.length - 1].readIndex);
    },
    (entry) => payloadByteLength(entry.payload),
  );
  for await (const message of readMessages(folder)) {
    counts.read++;
    if (counts.read <= resumeAfter) continue;
    const { payload, occurredAt, quoteBoundary } = await buildPayload(message);
    // A message with no usable Date is kept: it is in the Sent folder, so it is the owner's, and
    // omitting occurred_at is the documented behaviour. Only a datable, too-old message is dropped.
    if (occurredAt && occurredAt < since) { counts.tooOld++; continue; }
    if (payload.extra.body_source === 'text/plain') counts.bodyPlain++;
    else if (payload.extra.body_source === 'text/html') counts.bodyHtml++;
    else counts.bodyNone++;
    if (quoteBoundary) counts.quoteBoundary++;
    await batcher.push({ payload, readIndex: counts.read });
  }
  await batcher.finish();
  // Safe here (unlike inside a flush): the loop is done, so every message counted has either been
  // submitted or deliberately skipped (resume marker / before-cutoff).
  writeState(fingerprint, counts.read);

  console.error(
    `email: read ${counts.read}, ingested ${counts.ingested}, resubmitted ${counts.resubmitted}, ` +
    `already-stored ${counts.skippedStored}, before-cutoff ${counts.tooOld}, rejected ${counts.failed}, ` +
    `spooled ${counts.spooled}, quarantined ${counts.quarantined}`,
  );
  console.error(`email: body source — plain ${counts.bodyPlain}, html ${counts.bodyHtml}, none ${counts.bodyNone}`);
  console.error(`email: quote boundary detected in ${counts.quoteBoundary} of ${counts.read} read`);
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === API_KEY_PLACEHOLDER) {
    console.error('email: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
  if (!STORE_PATH) {
    console.error('email: EMAIL_STORE_PATH not set — point it at the mail store directory (see README.md)');
    process.exit(1);
  }
  if (INBOX_FOLDER_PATTERN.test(SENT_FOLDER)) {
    console.error(
      `email: refusing to read "${SENT_FOLDER}" — this connector ingests SENT mail only. Inbound mail is ` +
      'attacker-controlled and its subject and body must not be stored until a provenance mechanism ' +
      'exists (#346). Set EMAIL_SENT_FOLDER to the sent folder.',
    );
    process.exit(1);
  }
  await run();
  // Deliberately NO process.exit() here. The sibling imessage connector calls it because "fetch's
  // keep-alive sockets would otherwise hold the process open" — measured, that is not true for this
  // connector: it drains and exits on its own in about a second. Calling process.exit() while the
  // mbox reader's file handle is still tearing down trips a libuv assertion on Windows
  // (`!(handle->flags & UV_HANDLE_CLOSING)`) INTERMITTENTLY, so a successful backfill prints its
  // summary and then dies with exit 127. Setting exitCode and letting the loop drain avoids the
  // race entirely. If a future change ever does leave the loop pinned, fix the handle it leaks
  // rather than reaching for process.exit().
}

// Only run when invoked directly, so test.mjs can import buildPayload without starting a backfill.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // A manually-run backfill must fail visibly — doc 04 §7's exit-0 rule governs push-style
    // connectors that must not crash their invoker, which this is not. exitCode rather than
    // exit() for the same teardown-race reason as the success path above.
    console.error('email: backfill failed', err);
    process.exitCode = 1;
  });
}
