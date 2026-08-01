# imessage

Reads `~/Library/Messages/chat.db` (read-only, WAL-safe) and syncs messages and photo attachments to [LifeContext](https://github.com/msih/life-context) as `message`/`photo` artifacts. Implements [Milestone 3](https://github.com/msih/life-context/blob/2.0/docs/05-roadmap.md) of the LifeContext roadmap — the **watch** reference connector, and the first one that proves deterministic entity links at volume.

## What it does

1. Opens `chat.db` read-only (`better-sqlite3`, `readonly: true`) and reads messages in ROWID order, past a locally-persisted cursor.
2. For each message: uses `text` if present, otherwise decodes the `attributedBody` binary-plist column (best-effort — see Known Limitations).
3. Emits a `type='message'` artifact with `entity_hints` (`sender`/`recipient`, phone or email, from the `handle` table) so LifeContext can link the conversation to a real contact.
4. Photo attachments (`image/*` MIME types only) are emitted as separate `type='photo'` artifacts with `raw_path` pointing at the file on disk.
5. Sends via `POST /api/v1/ingest/batch` (chunks of ≤100).
6. One script, two modes: a one-shot backfill (default — good for cron) or `--watch` (backfill once, then poll for new rows on an interval).

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY`.
2. `npm install` (this connector has real dependencies: `better-sqlite3` to read `chat.db`, `bplist-parser` to decode `attributedBody`).
3. **Give the connector read access to `chat.db` without granting Full Disk Access to your whole shell** — see [Full Disk Access — scope it to one helper, not your terminal](#full-disk-access--scope-it-to-one-helper-not-your-terminal) below. The connector reads a plain snapshot the helper produces, via `IMESSAGE_DB_PATH`; it never needs FDA itself.
4. Backfill: `node index.js`. For continuous sync, run it one-shot on a `launchd` timer or long-running with `--watch` (each poll reopens the snapshot, #142) — see [Keep the connector running](#7--keep-the-connector-running-ongoing-sync). With the scoped-helper setup, both read the snapshot at `IMESSAGE_DB_PATH`, not the live `~/Library/Messages/chat.db`.
5. **Hub-and-spoke topology is just configuration**: to run this on a Mac Mini that syncs to a LifeContext server on another machine, set `LIFECONTEXT_URL` to that machine's LAN IP. No code change — that's the point of the ingest contract being plain HTTP.

## Full Disk Access — scope it to one helper, not your terminal

macOS has no "read Messages only" permission: Full Disk Access (FDA) is the only key that unlocks `~/Library/Messages/chat.db`. But **FDA is granted per executable**, so the goal isn't to avoid it — it's to make sure exactly one tiny binary holds it and nothing else does.

**The trap:** granting FDA to `Terminal.app`, `/bin/bash`, or `/usr/bin/python3`. macOS TCC attributes access to the process that *opens the file* — for a script that's the **interpreter, not the script**. Grant FDA to `python3` (or to `node`) and now every Python (or Node) script on the machine can read your messages. That's the "granting everything" to avoid — and it's exactly what "grant FDA to your terminal/Node" would do.

**The fix:** ship a dedicated, code-signed helper binary whose only job is to snapshot `chat.db` into an unprotected folder. Grant FDA to that binary alone. This connector then reads the ordinary snapshot (`IMESSAGE_DB_PATH`) and **never gets FDA at all**.

```
[FDA-granted helper]  →  snapshots chat.db  →  ~/LifeContext/ingest/imessage/chat.db
   (only thing with FDA)                                     │
                                                             ▼
                                    [imessage connector — NO FDA needed]
                                    reads the snapshot via IMESSAGE_DB_PATH
```

### 1 — Write the helper (does nothing but snapshot the DB)

`export.py`:

```python
#!/usr/bin/env python3
"""LifeContext iMessage export helper. Only job: snapshot chat.db to the ingest folder."""
import os, sqlite3, tempfile, pathlib

HOME    = pathlib.Path.home()
SRC     = HOME / "Library/Messages/chat.db"
OUT_DIR = HOME / "LifeContext/ingest/imessage"
OUT_DB  = OUT_DIR / "chat.db"

OUT_DIR.mkdir(parents=True, exist_ok=True)

# Snapshot to a temp file in the same dir, then atomically replace the destination — a reader
# never sees a half-written DB, and an interrupted run leaves the previous good snapshot intact.
fd, tmp = tempfile.mkstemp(dir=OUT_DIR, suffix=".tmp")
os.close(fd)
try:
    # sqlite backup API = one consistent snapshot, WAL folded in, source opened read-only.
    # as_uri() escapes spaces/special chars in the path; ?mode=ro forces read-only open.
    src = sqlite3.connect(f"{SRC.as_uri()}?mode=ro", uri=True)
    dst = sqlite3.connect(tmp)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()
    os.replace(tmp, OUT_DB)   # atomic on the same filesystem
    print(f"snapshot -> {OUT_DB}")
finally:
    if os.path.exists(tmp):    # replace() consumed it on success; clean up on failure
        os.remove(tmp)

# Optional: attachments (can be large — enable deliberately). Only needed if core shares this
# machine's filesystem and you want it to read attachment bytes — see the attachments note below.
# import shutil
# shutil.copytree(HOME / "Library/Messages/Attachments",
#                 OUT_DIR / "Attachments", dirs_exist_ok=True)
```

Using SQLite's `backup()` API rather than `cp` gives a consistent snapshot and folds the `-wal`/`-shm` sidecars in, so the connector reads a single self-contained `chat.db` — no half-written WAL to worry about. Writing to a temp file and `os.replace()`-ing it in means a scan that runs mid-snapshot reads the previous complete DB, never a partial one.

### 2 — Freeze it into a standalone binary

This is the critical step: it gives the helper its own executable identity, so FDA attaches to *it*, not to a shared `python3`.

```bash
pip install pyinstaller
pyinstaller --onefile --name lc-imessage-export export.py
# result: dist/lc-imessage-export  (embeds its own interpreter)
```

(A compiled Go/Swift/Rust binary works identically — anything that is its own executable rather than a script handed to a shared interpreter.)

### 3 — Ad-hoc code-sign it (so the grant survives rebuilds)

```bash
codesign --force --sign - \
  --identifier com.local.lc-imessage-export \
  dist/lc-imessage-export
```

Unsigned binaries are tracked by path + code hash and re-prompt or break whenever you rebuild or move them. Ad-hoc signing (`--sign -`) gives a stable identity so the FDA grant sticks. Put it somewhere permanent:

```bash
mkdir -p ~/bin && cp dist/lc-imessage-export ~/bin/
```

### 4 — Grant FDA to only that binary (manual, one time)

FDA can't be added by script (that needs SIP disabled), so do it once by hand:

1. System Settings → Privacy & Security → Full Disk Access
2. Click **+**
3. In the file picker press **⌘⇧G**, type `~/bin`, and select `lc-imessage-export`
4. Toggle it on

That's the whole grant. `Terminal`, `python3`, `node`, and the connector itself stay untouched and cannot read `chat.db`.

### 5 — Schedule it (`launchd`)

`~/Library/LaunchAgents/com.local.lc-imessage-export.plist` (replace `YOU` with your username):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.local.lc-imessage-export</string>
  <key>ProgramArguments</key>
    <array>
      <string>/Users/YOU/bin/lc-imessage-export</string>
    </array>
  <key>StartInterval</key>    <integer>3600</integer>
  <key>RunAtLoad</key>        <true/>
</dict>
</plist>
```

```bash
# modern macOS (10.11+): bootstrap the agent into your GUI login session
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.lc-imessage-export.plist
# to remove it later: launchctl bootout gui/$(id -u)/com.local.lc-imessage-export
# (older releases use the now-deprecated `launchctl load … / unload …`)
```

**Critical:** `ProgramArguments` must invoke the FDA-granted binary **directly**. Wrap it in `/bin/sh -c "…"` and the process holding the file open becomes `sh`, which does not have FDA — it fails silently.

### 6 — Point the connector at the snapshot

In this connector's `.env`:

```bash
IMESSAGE_DB_PATH=/Users/YOU/LifeContext/ingest/imessage/chat.db
```

Then `node index.js` (or `--watch`) reads the unprotected snapshot — no FDA on Node, your shell, or the connector.

### 7 — Keep the connector running (ongoing sync)

The helper writes each snapshot with `os.replace()` — an **atomic rename to a new inode** (§ helper, above). That detail drives how the connector must be run for *continuous* sync, and there are two conformant models:

- **One-shot on a timer (recommended for the snapshot setup).** Run `node index.js` (no `--watch`) from a `launchd` `StartInterval` — each run opens the *current* snapshot fresh, ingests everything past the cursor, and exits. It's the simplest robust option and lines up naturally with the helper's snapshot cadence (fire it a little after the helper). This is the "good for cron" default mode.
- **`--watch` (long-running).** `node index.js --watch` backfills once, then polls every `IMESSAGE_POLL_INTERVAL_MS`. **Each poll reopens the snapshot** (#142), so an atomically-replaced snapshot (new inode) is picked up without a restart. (A single long-lived handle would keep reading the old, unlinked inode and never see a newer snapshot — that was the #142 bug; the reopen-per-poll fix is what makes `--watch` safe against the helper's `os.replace()` output.)

A one-shot connector `launchd` agent (`~/Library/LaunchAgents/com.local.lc-imessage-connector.plist`) resembles the helper's — invoke `node` directly with the script's absolute path, `RunAtLoad`, and a `StartInterval` at (or just after) the helper's cadence. No `WorkingDirectory` is needed: `.env` loads relative to the script and the cursor/DB paths resolve absolutely. Bootstrap it the same way: `launchctl bootstrap gui/$(id -u) <plist>`.

**Reliability against a slow or remote embedder.** Core embeds every message as it ingests, so a slow/remote LifeContext (e.g. behind a Cloudflare Tunnel with a request timeout) makes large batches risky. Set **`IMESSAGE_DB_PAGE_SIZE` small (e.g. `10`)**: each POST then carries ≤10 messages (timeout-proof) and the cursor checkpoints every 10 rows, so an interruption re-does almost nothing. It's only marginally slower — the embedding work is fixed regardless of batching; smaller pages just add a few more HTTP round-trips. See `.env.example`.

### Verify the scoping worked

```bash
# From a plain (non-FDA) Terminal — this SHOULD fail with "Operation not permitted":
sqlite3 ~/Library/Messages/chat.db ".tables"

# The snapshot the helper produced SHOULD be readable freely:
sqlite3 ~/LifeContext/ingest/imessage/chat.db ".tables"
```

If the first fails and the second succeeds, access is correctly confined to the helper.

### Attachments

This connector emits photo attachments as `raw_path` pointers only — it reads the attachment *path* from `chat.db`, never the file bytes ([`index.js`](index.js) `buildPhotoPayload`), so scoping FDA away from the connector doesn't affect attachment ingestion. The `Attachments/` folder is itself FDA-protected; enable the helper's optional `copytree` step above only if core shares this machine's filesystem and you want it to resolve those `raw_path` files (a pre-existing hub-and-spoke / shared-FS concern, not specific to this setup).

## Exit test (roadmap M3)

"What did Sarah text me about the trip" returns real messages; `about_entity("Sarah")` shows message artifacts interleaved with notes; a full backfill re-run produces zero duplicates (guaranteed by the ingest contract's upsert-on-`(source, source_id)` semantics, independent of the local cursor file).

## Known limitations

- **`attributedBody` decoding is a reverse-engineered heuristic**, not a real NSKeyedArchiver parser (`bplist-text.js`) — Apple doesn't document this format. It walks every string in the archive and discards known class-name/attribute-key markers, keeping the longest survivor. This can misfire (return `null`, or occasionally the wrong string) on a future macOS release that changes NSKeyedArchiver's internals.
- **Only image attachments become artifacts.** Videos, documents, and other attachment types are not ingested yet — out of scope for this milestone, not silently dropped from consideration.
- **No self-identification hint.** The account owner's own phone/email isn't in `chat.db` (it's tied to the local Apple ID), so outgoing messages hint the *other* party's role as `recipient` but never emit a `self` hint for the account owner.
- **Group-chat participant fallback is a heuristic.** When an outgoing message has no direct `handle_id` (common in group chats on many macOS versions), every other participant in the chat is hinted as `recipient` — this can't distinguish "sent to the whole group" from "meant for one person" the way a human reading the thread could.
- **Failure posture**: a POST failure (network error, non-2xx) aborts the whole page and does **not** advance the cursor — the next run retries from the same point, since `chat.db` isn't going anywhere. A per-item validation failure inside an otherwise-successful batch response is logged but does not block the cursor (retrying a validation failure forever isn't productive).
- **Legacy date format**: `chat.db` on macOS 10.13+ stores `date` as nanoseconds since the Apple epoch (2001-01-01); older releases used seconds. Both are handled (`appleTimeToISO` in `index.js`), but only tested against the modern (nanosecond) format.

## Testing without a Mac

`test.mjs` (`npm test`) seeds a synthetic `chat.db` with the real iMessage schema (`message`, `handle`, `chat`, `chat_handle_join`, `chat_message_join`, `attachment`, `message_attachment_join`) — including a real `attributedBody` archive built with `bplist-creator` — and runs `index.js` against it with a mock ingest server. Covers: plain text, `attributedBody`-only text, a photo attachment, group-chat participant fallback, a tapback-shaped row being correctly skipped, cursor advancement, idempotent re-run, and the no-cursor-advance-on-failure behavior.

## Files

- `index.js` — the sync script
- `bplist-text.js` — the `attributedBody` decoder
- `test.mjs` — `node --test` suite against a synthetic `chat.db`
- `.env.example` — copy to `.env`
