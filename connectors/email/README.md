# email — sent-mail backfill

Backfills **sent** mail into LifeContext from a local mail store on disk. A desktop mail client does
the downloading; this connector only reads files.

That split is the whole design. Thunderbird (or any client producing a standard mbox/maildir store)
authenticates to Gmail, Yahoo and Outlook/M365 over OAuth2 **using its own provider-approved client
credentials**, so LifeContext holds no mail credential of any kind — no password, no app password,
no refresh token, no OAuth client to register. There is no network code and no secret handling here
at all: the connector opens files, builds payloads, and POSTs them to your LifeContext server.

**Scope: sent mail only, and that is a safety boundary rather than a scope cut.** Mail you wrote is
not attacker-controlled, so its subject and body are safe to store and later replay into an agent's
context via `search`. Inbound mail is the opposite case and is handled separately under much tighter
rules — see `#346` (provenance/fencing) and `#348` (historical inbound, tiered).
**Do not point `EMAIL_SENT_FOLDER` at an Inbox.**

Going-forward capture is a different lane (a private companion repo, a Stage 5 sink of the
untrusted-email pipeline). This connector owns **history**. Both derive `source_id` identically, so a
message seen by both upserts to one artifact instead of landing twice.

## Setup

### 1. Sync the folder with a mail client

- **Add the account as IMAP, not POP.** POP3 fetches INBOX only, so a POP profile has **no Sent
  folder at all** and this connector has nothing to read. If you point it at a POP store, the error
  says so.
- **Prefer maildir if you are setting the store up fresh** (Thunderbird: *Config Editor →
  `mail.serverDefaultStoreContractID` → maildir* before adding the account). One file per message
  makes re-runs cheap, gives every artifact a stable `raw_path`, and avoids mbox's `>From ` quoting.
  mbox works too and is what an existing profile almost certainly has.
- **Bound what you sync.** *Account Settings → Synchronization & Storage → Synchronize the most
  recent N days* keeps the on-disk copy small. The connector applies its own date bound regardless
  (`EMAIL_SINCE`), so this is about disk, not correctness.
- **Mind the disk.** A fully-synced mailbox is potentially many gigabytes of plaintext mail sitting
  unencrypted on disk. That is a real consequence of this approach; decide it deliberately.

Find the profile's mail directory via *Account Settings → Server Settings → Local Directory*. Point
`EMAIL_STORE_PATH` at the directory that **contains** the Sent folder, not at the folder itself.

### 2. Install dependencies

```bash
cd connectors/email && npm install
```

This connector now has runtime dependencies — `postal-mime` (MIME parsing) and `html-to-text`
(html→text conversion, for an html-only body). Both are pure-JS, no native build step.

### 3. Configure

Copy `.env.example` to `.env` (gitignored) or export the variables:

| Variable | Default | Meaning |
|---|---|---|
| `LIFECONTEXT_URL` | `http://localhost:3000` | Your LifeContext server |
| `LIFECONTEXT_API_KEY` | — | **Required.** Same key the server uses |
| `EMAIL_STORE_PATH` | — | **Required.** Directory containing the Sent folder |
| `EMAIL_SENT_FOLDER` | `Sent` | Folder name within the store (`Sent Mail`, `Sent Items`, …) |
| `EMAIL_SINCE` | 24 months ago | ISO date; older messages are skipped. Unset never means "everything" |
| `EMAIL_STATE_PATH` | `~/.life-context/email-state.json` | Resume marker (efficiency only) |
| `EMAIL_SPOOL_DIR` | `~/.life-context/email-spool` | Failed payloads, flushed next run. A `quarantine/` subdirectory (#405) holds any single payload whose own size alone exceeds the batch byte budget — see "Failure posture" below |
| `EMAIL_REINGEST` | `false` | `true` submits every message even if already stored — see below |

### 4. Run

```bash
node index.js
```

One-shot; re-running is safe and ingests zero duplicates. Run it again after the client syncs more.

### Rehearsing a backfill against a scratch DB

Two large backfills are typically queued (a Yahoo and a Gmail archive, thousands of messages each),
and the store is append-only — a defective `text_repr` shipped by a real run is permanent until a
full `--reingest` pass corrects it, paying the embedding cost twice. `sample.js` rehearses first: it
reads the REAL local archive but ingests only a small, deterministic, year-spread sample into a
disposable scratch server, so the actual `text_repr`/`extra.body_full`/entity-hint output is there to
inspect before the real backfill ever touches `life-context.db`. It imports `buildPayload`,
`packBatches` and `postBatchSplitting` straight from `index.js` — it rehearses the connector's own
code, never a re-derived copy of it.

Start a second, throwaway LifeContext server first (`#416` "commit the scratch-DB connector
re-ingest verification harness" owns automating this step; today it is a manual env block):

```bash
# in the life-context repo root, a SEPARATE shell from the live server
PORT=3099 DB_PATH=/somewhere/outside/the/repo/email-scratch.db \
ACCESS_LOG_DIR=/somewhere/outside/the/repo/email-scratch-access \
LIFECONTEXT_API_KEY=scratch-only-throwaway-key \
  node src/server.js
```

**`node src/server.js` here, deliberately not `npm run dev`.** `npm run dev`
(`scripts/dev-server.js`) is the right tool for the *smoke test* — it snapshots the live DB so a dev
instance has real data — but it is the wrong one here, in two ways that both fail silently in the
direction of "looks fine, proves nothing": it ignores `PORT` (its own knob is `DEV_PORT`, default
`3001`) and it reads `DB_PATH` as the **source to copy from**, not the scratch target, so the block
above would exit `1` with "live DB not found". Corrected to its own knobs it would then seed the
scratch with a full copy of the live store — and a rehearsal whose scratch DB already contains every
previously-ingested message cannot answer "artifact count == messages posted", which is the whole
point. A rehearsal wants an **empty** DB. This is also the invocation `#416`'s captured procedure
uses.

`DB_PATH` off the default also moves `EVENTS_DB_PATH` (`#369` "derive EVENTS_DB_PATH from DB_PATH so
scratch runs don't share the events log") to `logs/events-email-scratch.db` automatically — a scratch
rehearsal's ops spans never land in the real server's `logs/events.db`. Put `DB_PATH` somewhere
outside the repo: it holds real mail content (subjects, bodies, addresses) once the sample lands, the
same as the live `life-context.db` does, and is not a fixture to commit or leave inside a git worktree
that later gets cleaned up. The server creates the file and its schema on first boot, so point it at
a path that does not exist yet; delete it to start a fresh rehearsal.

#### Seed the scratch entity graph first, or the rehearsal cannot see resolution at all

**An empty scratch DB silently under-reports.** Entity resolution is exact-match against
`entity_aliases`, so with no entities present *every* sender and recipient misses and stages into
`unresolved_aliases` — measured on a real 100-message rehearsal as `entity_links: 0`,
`proposed_entities: 0`, and 788 staged hints, none of which is what the live store would do. The
run still reports a cheerful success, so this reads as "nothing to see" rather than "this question
was never asked". Since the entity graph is the *other* thing a backfill changes irreversibly
(`unresolved_aliases` is append-only and never deleted, even after linking), leaving it untested
defeats half the point.

Seed the **resolution surface only** — from the live DB, which is the exact surface the real
backfill will hit — before booting the scratch server. Copy `entities`, `directory_cards`,
`contact_directory`, `entity_aliases`, `alias_tombstones` and `entity_relations`; deliberately
**not** `artifacts`, `vec_artifacts`, `entity_links` or `unresolved_aliases`, which must start empty
so the rehearsal measures what *this* backfill stages rather than what history already staged.

Both commands run **from the life-context repo root** (they use the relative `life-context.db` and
the root's own `node_modules`), and both read the same `DB_PATH` variable — export it once:

```bash
# from the life-context repo root
export DB_PATH=/somewhere/outside/the/repo/email-scratch.db

# 1. create the schema in the empty scratch DB (no server needed).
#    --input-type=module is explicit rather than relying on --eval's module-syntax detection,
#    which is default-on only from Node 22.7 — the repo floor is 22, so a 22.0-22.6 box would
#    otherwise get a SyntaxError on the top-level await.
node --input-type=module -e "await import('./src/db.js')"

# 2. copy the resolution surface across, live opened READ-ONLY
node -e '
const Database = require("better-sqlite3");
const live = new Database("life-context.db", { readonly: true });
const s = new Database(process.env.DB_PATH);
s.pragma("foreign_keys = OFF");   // entities.merged_into is a self-FK; row order is not guaranteed
const tables = ["entities","directory_cards","contact_directory","entity_aliases","alias_tombstones","entity_relations"];
s.transaction(() => { for (const t of tables) {
  const rows = live.prepare("select * from " + t).all(); if (!rows.length) continue;
  const cols = Object.keys(rows[0]);
  const ins = s.prepare(`insert or ignore into ${t} (${cols.map(c => `"${c}"`).join(",")}) values (${cols.map(c => "@" + c).join(",")})`);
  let n = 0; for (const r of rows) n += ins.run(r).changes; console.log(t, n);
} })();
s.pragma("foreign_keys = ON");
console.log("fk_check:", s.pragma("foreign_key_check").length, "violations");
'
```

`foreign_keys = OFF` for the copy is required, not a shortcut: `entities.merged_into` references
`entities`, and `SELECT *` returns no guaranteed topological order, so a merged-away entity can be
inserted before its survivor. The `foreign_key_check` afterwards is what proves the copy is sound —
it must report `0`.

Then, from `connectors/email`:

```bash
EMAIL_STORE_PATH=<dir containing the sent folder> EMAIL_SENT_FOLDER="Sent Mail" \
LIFECONTEXT_API_KEY=scratch-only-throwaway-key \
  node sample.js --post http://localhost:3099 --per-year 25 --years 4
```

`npm run sample` is the same entry point; npm needs the `--` separator before the flags
(`npm run sample -- --post http://localhost:3099`).

| Variable / flag | Default | Meaning |
|---|---|---|
| `EMAIL_STORE_PATH` | — | **Required.** Same meaning as `index.js`'s |
| `EMAIL_SENT_FOLDER` | `Sent` | Same meaning as `index.js`'s (the inbox refusal applies) |
| `LIFECONTEXT_API_KEY` | — | **Required.** The *scratch* server's key, not the live one |
| `--post <url>` | — | **Required.** The scratch server. Refuses port `3000` and any port matching `LIFECONTEXT_URL` — a rehearsal that lands on the live store is worse than no rehearsal |
| `--per-year` / `EMAIL_SAMPLE_PER_YEAR` | `25` | Messages reservoir-sampled per selected year |
| `--years` / `EMAIL_SAMPLE_YEARS` | `4` | How many years to spread evenly across the account's real dated range (oldest and newest always included) |
| `--seed` / `EMAIL_SAMPLE_SEED` | a fixed constant | Sampling seed for the in-file LCG (never `Math.random`) — same seed + same store selects the same messages, so a re-run after a parser change is a signal-bearing diff, not sampling noise |

`EMAIL_SINCE` is deliberately ignored: it bounds a recent window, so it could only ever rehearse the
newest mail client's output, and mail-client format drift over the years is exactly what a
pre-backfill rehearsal exists to catch. Exit `0` on a completed rehearsal; exit `1`, with zero
messages read, on a missing/unreadable store, an inbox-named folder, a missing API key, or a refused
`--post` target. Nothing is written to disk beyond the scratch DB itself — no report file, no
payload dump; the scratch DB's rows ARE the artifact to inspect. `EMAIL_STATE_PATH` and
`EMAIL_SPOOL_DIR` are untouched by a rehearsal (it neither reads nor advances the real resume marker,
and has no spool of its own — a batch that fails to post is only counted, never persisted).

Inspect the result with SQL against the scratch DB — one query per known failure mode:

| Query | Catches |
|---|---|
| `text_repr` where `length(text_repr) >= 1000` | content cut at `SNIPPET_MAX_CHARS` |
| `text_repr LIKE '%wrote:%'` / `LIKE '%> %'` / `LIKE '%Original Message%'` | quoted thread `quotes.js` failed to strip |
| `text_repr LIKE '%confidential%'` / `'%Sent from my %'` / `'%501(c)(3)%'` | signature/legal boilerplate `signature.js` failed to cut |
| `occurred_at IS NULL` | unparseable `Date` header |
| `source_id LIKE 'email:msg:sha256:%'` | no `Message-ID`; identity is the hash fallback |
| `json_extract(extra_json,'$.body_source')` grouped | `text/plain` vs `text/html` vs `none` mix |
| `text_repr NOT LIKE '% — %'` | degraded to subject-only |
| count of `artifacts` vs `vec_artifacts` vs distinct `source_id` | orphaned vectors, duplicate identities |
| `unresolved_aliases` / `proposed_entities` counts and top aliases | what the real backfill would stage on the live entity graph |

`sample.js` never opens a database at all — it only ever talks HTTP to whatever `--post` names, same
as `index.js`. The **one** place this procedure touches the live store is the read-only seeding copy
above (`{ readonly: true }`), which reads the entity tables and writes nothing. Any defect the
rehearsal surfaces is its own follow-up issue; this instrument delivers the sample, not the repair.

### Re-ingesting to apply a `text_repr` improvement

```bash
node index.js --reingest        # or EMAIL_REINGEST=true node index.js
```

A plain re-run **cannot** rewrite a message already in the store, and says so only as a cheerful
`already-stored`, exit 0 (#374). `POST /api/v1/exists` answers "is this `source_id` stored" — it cannot
know whether the *payload* changed, and only core can, and only if the payload is actually submitted.
So a default run skips the POST and the upsert path is never reached: every later snippet improvement
(signature stripping #368, quote stripping #386, a better `describeRecipients`) would stall at the
store's edge. That is what this flag exists for — it is the enrichment wave
`docs/04-connector-contract.md` §9 describes, which this connector otherwise forfeits.

With the flag set:

- `exists` is still called, but its answer only **labels** each message; nothing is filtered out.
- The resume marker is ignored too, so an unchanged mail folder is re-read rather than skipped — one
  flag, not also a fresh `EMAIL_STATE_PATH`.
- The summary reports **`resubmitted`** separately from `ingested`, so "healed 528" and "newly stored
  528" never read the same.
- Core **re-embeds only what changed**, so the cost is one embedding per genuinely-altered snippet; a
  second re-ingest over an unchanged archive embeds nothing.

Expect it to be slower than a first backfill by design: every message is read, parsed, and POSTed.

## How it behaves

- One artifact per sent message, `type='email'`.
- **Entity hints, never IDs.** Each address emits an `email` hint, plus a `name` hint when it carries
  a display name. `role='sender'` for the `From` address, `role='recipient'` for each `To`/`Cc`.
- **`suggested_kind` is deliberately never set.** Without it, core stages a proposal for a recipient
  already in `contact_directory` and leaves an unknown address in `unresolved_aliases` — exactly the
  input the frequency promoter (`#87`) needs. Setting it would stage one proposal per recipient.
- **`source_id`** is `email:msg:<Message-ID, brackets stripped, lowercased>`, falling back to
  `email:msg:sha256:<hash of canonical fields>` when the header is missing (legal — it is only a
  SHOULD in RFC 5322 — and routinely mangled by exports). **This scheme must stay byte-identical to
  the going-forward lane's**; if the two diverge, every recently-sent message lands twice.
- **Idempotency** comes from `POST /api/v1/exists`, not from the state file. The state file is a
  resume marker keyed on the folder's size+mtime, so an appended-to store invalidates it rather than
  skipping newly-synced messages. Both are **efficiency** devices and both are bypassed by
  `--reingest` (below) — neither is a correctness mechanism, since ingest upserts on
  `(source, source_id)`.
- **`occurred_at`** is the `Date` header, omitted rather than guessed when unusable — a wrong one
  silently mis-sorts the timeline forever.
- **`raw_path`** is set only for maildir sources. An mbox folder has no per-message path.
- **Body extraction is MIME-aware (`mime.js`, #362).** The raw region after the header block is
  parsed with `postal-mime`, not stuffed into `text_repr` as-is: a `multipart/*` message is walked
  for its parts (nested multipart included), `Content-Transfer-Encoding` (base64,
  quoted-printable) is decoded, and `charset` is honored. **Selection ladder:** the parsed
  `text/plain` part wins; failing that, the `text/html` part is converted to plain prose via
  `html-to-text`; failing that, the snippet is empty. Attachment parts are never a body candidate —
  the connector reads only text/html content, never attachment bytes. A message that fails to parse
  degrades to no snippet (`Email to <recipients>: <subject>`), never boilerplate. `extra.body_source`
  records which branch fired (`text/plain` / `text/html` / `none`) and `extra.mime_type` records the
  message's top-level `Content-Type`, so a later audit can find html-converted snippets without a
  re-ingest.
- **Signature/legal-footer stripping (`signature.js`, #368).** Before `SNIPPET_MAX_CHARS`
  truncation, the decoded body is passed through `stripSignature`, which cuts at the earliest
  confidently-identified signature boundary and keeps only the prose above it: an RFC 3676 `-- `
  delimiter line; a pipe-delimited contact block (`Name | Title | phone | email`, checked per
  *paragraph* so a client that wraps a signature's fielded line across two physical lines is still
  caught); a confidentiality/privilege or 501(c)(3)/tax-deductible nonprofit-boilerplate paragraph;
  or a mobile sign-off (`Sent from my …`). **Conservative by construction:** when no boundary is
  confidently identified, the body is returned byte-for-byte unchanged — a sentence that merely
  contains a phone number, a URL, and a `|` character (with no email token) is left alone, and a
  bare mention of the word "confidential" is left alone too. This only ever touches the
  display/snippet path — `rawBody` (which feeds `sourceIdFor`'s no-`Message-ID` hash fallback,
  #362) is never stripped, so re-running this fix over an already-ingested archive changes
  `text_repr` in place via the upsert path and mints **zero** new `source_id`s. A body that is
  *entirely* signature (no reply text above the boundary at all) legitimately strips to an empty
  snippet — the same graceful degradation `buildTextRepr` already applies to an attachment-only
  message (subject-only `text_repr`, no dash-snippet) — confirmed safe against a real 528-message
  archive (every such case was a genuinely content-free body, not lost prose). To rewrite
  already-ingested artifacts after upgrading, re-run with **`--reingest`** (see *Re-ingesting to
  apply a `text_repr` improvement* below) — a plain `node index.js` will **not** do it, because
  `exists` filters every already-stored message out of the batch before the upsert path is ever
  reached (#374). Core **re-embeds only when `text_repr` actually changed** (`src/ingest.js`), so a
  re-ingest run pays the embedding cost for every message whose snippet the stripper altered, while a
  later no-op re-ingest embeds nothing at all.
- **Quoted-reply stripping + thread-by-reference linking (`quotes.js`, #386).** A reply's body
  carries the whole thread beneath it — measured on the real archive at `wrote:` in 21/50 and `>` in
  24/50 of a Gmail slice, 11/50 and 23/50 of a Yahoo slice — so `stripQuotedReply` runs alongside
  `stripSignature` (whichever finds the **earlier** boundary wins; see `parse.js`'s
  `stripToEarliestBoundary`) and cuts at the earliest confidently-identified quote boundary: an
  Apple/Gmail/Outlook-web `On <date>, <name> wrote:` attribution (checked per *paragraph*, since a
  long one is often wrapped across physical lines by the client, and disambiguated from an innocent
  earlier "on" by requiring a 4-digit year shortly after "On", checked rightmost-candidate-first);
  `-----Original Message-----` / `-------- Original message --------` (Outlook/Yahoo web, any dash
  count) / `---------- Forwarded message ----------` (Gmail) / `Begin forwarded message:` (Apple
  Mail) / a bare underscore rule (Outlook desktop); a pasted `From:`/`Sent:`/`To:`/`Subject:` header
  block (a run of 3+ such lines, never a single line — the issue's own negative test); and a run of
  `>`-quoted lines (also what html-to-text emits for a real HTML `<blockquote>`, so that needs no
  separate detection). A real Yahoo/AOL-web quirk — a `text/plain` part containing literal `<br>`
  tags instead of real line breaks — is normalized to `\n` before any of the above runs, purely for
  detection; the "no boundary found" path still returns the original text byte-for-byte. **Thread
  identity now travels by reference, not by re-quoting:** `extra.references` (parsed from the RFC 5322
  `References` header into an array of bracketed message-ids, the whole chain) and `extra.in_reply_to`
  (parsed from `In-Reply-To` the same way, since RFC 5322 defines it as `1*msg-id` and may carry CFWS
  comments — but reduced to a single bracketed string, the last/parent id) are set **only when the
  header is present** (never null-filled) — ~52%/53% of the real Gmail archive, matching the
  independently-measured 53% thread share. `extra.body_full` always carries the complete decoded body
  pre-strip, so stripping is non-lossy: a correspondent's quoted words are gone from the vector space
  but still reconstructable from stored data. **`body_full` is not capped at `SNIPPET_MAX_CHARS`
  the way `text_repr` is** — see Known Limitations for the batch-size consequence.
- **Failure posture, two cases on purpose.** An **unreachable server** is fatal: exit non-zero, fix
  it, re-run. The source is durable on disk, so re-reading costs nothing — whereas spooling a whole
  archive to disk because the server was down would be unbounded. A server that is **up but rejects
  one batch** spools that batch (at most `EMAIL_BATCH_SIZE` payloads) to `EMAIL_SPOOL_DIR`, and the
  next run **attempts** to flush it before reading anything new — but that attempt can never block
  the run (#405): flushing a batch that keeps failing (e.g. it 413s again) leaves its files in the
  spool and moves on to the next batch or the mail read, it never throws out of the connector. `429`
  backs off exponentially.
- **Batching is byte-budgeted, not just item-counted, and a 413 degrades instead of failing (#405).**
  `extra.body_full` (below) means wire size scales with real message size, so a fixed 50-item batch
  can exceed the server's 256kb cap. Both the live read path and `flushSpool` pack payloads through
  one shared function (`createBatcher`/`packBatches` in `index.js`) that closes a batch before adding
  a payload that would push it past `MAX_BATCH_BYTES` (200kb, with headroom below the 256kb server
  cap) *or* the `EMAIL_BATCH_SIZE` item ceiling, whichever comes first. If a batch still gets a `413`
  anyway (the byte estimate is a close but not exact bound on the fully-framed request), it is split
  in half and each half retried recursively — so an unexpectedly large batch degrades gracefully
  instead of failing outright. A single message whose own serialized payload alone exceeds the
  budget can never land at any batch size; rather than retry it forever (which is exactly what used
  to permanently brick the connector), it is moved to `EMAIL_SPOOL_DIR/quarantine` — never deleted,
  named by its `sha256(source_id)` filename, logged and counted as `quarantined` in the run summary.
  Inspect it with `cat EMAIL_SPOOL_DIR/quarantine/*.json | jq .source_id` to see which messages
  landed there; nothing about them is fixed automatically, since a payload that alone exceeds the
  cap needs either a raised cap (out of scope, see Out of Scope in `#405`) or a
  smaller `extra.body_full` (also currently out of scope — see #390).
- **Logging:** counts, `source_id`s and durations only — never a subject, an address, a display name,
  or a store path.

## Known limitations

- **A folder whose name contains "inbox" is refused outright**, not warned about — see the sent-only
  note above. If your sent folder is genuinely named that, rename it in the client.
- **mbox message boundaries are heuristic**, as they are in every mbox reader: a line beginning
  `From ` starts a new message. Clients quote body lines that would collide (`>From `, which this
  reader unquotes), but a client that did *not* quote can split one message into two. maildir has no
  such ambiguity, which is the other reason to prefer it.
- **`content_hash` is computed after mbox unquoting**, so the same message read from an mbox and
  from a maildir hashes differently. Harmless — `source_id` is the identity, and the upsert path
  never rewrites an existing `content_hash` — but worth knowing before comparing hashes across
  stores.
- **Attachments are not ingested** (content, not just filenames — only `text/plain`/`text/html`
  parts are ever read), and the body is stored as a snippet capped at 1000 characters.
- **html→text is a snippet conversion, not a rendition.** `html-to-text` produces plain prose good
  enough for embedding and recall, not a faithful re-layout of the original message — tables,
  styling, and inline images are gone, on purpose.
- **A raw 8-bit non-UTF-8 body is already lossy before the MIME parser sees it.** `mailstore.js`
  reads and streams the store with `encoding:'utf8'`, so an 8-bit body whose bytes are not valid
  UTF-8 is mangled before `postal-mime` ever runs. Base64 and quoted-printable bodies are unaffected
  — their transport form is 7-bit ASCII and survives the read intact; only a raw 8-bit body (rare,
  and against the MIME spec for transported mail) is at risk. See `#362`'s "out of
  scope" for the byte-accurate fix, which needs `mailstore.js` to stream Buffers instead of strings.
- **Quoted-reply stripping (#386) has known, accepted gaps** — conservative-by-construction means
  under-stripping over over-stripping: top-posting with no marker at all; an HTML quote styled as an
  ordinary `<div>` rather than a real `<blockquote>`; a non-English client (`Le ... a écrit :`); a
  reply typed **inline inside an already-quoted thread** (real content positioned textually after a
  genuine `wrote:` attribution reads as quoted and is removed — indistinguishable from a correspondent's
  words without semantic understanding; observed once on the real archive); and a forward whose header
  block was collapsed onto one physical line with no separators at all by a broken html→text
  conversion (no line-anchored marker can find a boundary in that shape). None of these are silently
  "fixed" by guessing — they simply leave today's behavior (the quote stays in the snippet).
- **`extra.body_full` is not length-capped, so wire size scales with real message size** (unlike
  `text_repr`, always bounded by `SNIPPET_MAX_CHARS`). 50 messages at `mime.js`'s own `MAX_PART_CHARS`
  ceiling (20,000 chars) serialize to ~1.1MB in one naive batch — over 4× the 256kb `JSON_BODY_LIMIT`
  — which is exactly why batching is byte-budgeted rather than a fixed item count (#405, see
  "Failure posture" above). Deliberately not fixed by capping `body_full` itself — that is #390's
  decision, and stripping stays non-lossy only because the complete body survives uncapped.
- **`Bcc` is not read** — it is generally absent from the stored copy anyway.
- **No incremental watch mode.** This is a backfill; a private companion repo owns going-forward.
- **A store-specific, genuinely undateable minority is expected and not fixable.** Measured on the
  real Yahoo sent store (`#519`): 329 of 2,806 messages (11.7%) carry no `Date`
  header at all — 325 calendar alerts (`Subject: Alert - ...`), 3 meeting-response confirmations
  (`Accepted:`/`Tentative:`/`Declined:`), and 1 calendar invite, all relayed through Yahoo's own
  `WebService`/CalDAV backend rather than composed in a mail client. The header block itself is
  intact (not an mbox-splitting artifact, and not a rejected `Date` form — `parseDateHeader` never
  sees a `Date:` line to reject), and no
  other header carries a usable timestamp, so `occurred_at` is correctly omitted per the
  never-guess rule above; these artifacts sort by ingestion day (the store's own read-time fallback
  that orders a NULL-`occurred_at` row by `ingested_at` instead) rather than send day, permanently. The work-domain and Gmail sent
  stores measured 0% on the same rehearsal (`#518`) — this is Yahoo-account-specific,
  not a general parser weakness.
