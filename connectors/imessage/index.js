#!/usr/bin/env node
// Reads ~/Library/Messages/chat.db (read-only, WAL-safe — better-sqlite3's readonly mode
// still needs read access to the sibling chat.db-wal/chat.db-shm files, which live next to
// chat.db by default) and syncs messages + photo attachments to LifeContext. One script, two
// modes: a one-shot backfill (default — suitable for cron) and `--watch` (backfill once, then
// poll for new rows on an interval, same connector). See README.md for setup.
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText } from './bplist-text.js';

loadDotEnvIfPresent();

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const DB_PATH = process.env.IMESSAGE_DB_PATH || path.join(os.homedir(), 'Library/Messages/chat.db');
const STATE_PATH = process.env.IMESSAGE_STATE_PATH || path.join(os.homedir(), '.life-context', 'imessage-cursor.json');
const DB_PAGE_SIZE = Number(process.env.IMESSAGE_DB_PAGE_SIZE) || 500; // chat.db rows read per SQL page
const INGEST_BATCH_MAX = 100; // contract cap (docs/04-connector-contract.md §2)
const POLL_INTERVAL_MS = Number(process.env.IMESSAGE_POLL_INTERVAL_MS) || 15000;
const WATCH = process.argv.includes('--watch') || process.env.IMESSAGE_WATCH === 'true';

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

function loadDotEnvIfPresent() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] !== undefined) continue;
    const v = rawValue.trim();
    // Quoted values are kept verbatim (any inner `#` preserved — secrets/URLs may contain it);
    // unquoted values have a whitespace-preceded inline `#` comment stripped. `KEY=#abc` (no
    // leading space) stays intact — only ` #` opens a comment.
    const quoted = /^(['"])(.*)\1$/.exec(v);
    process.env[key] = quoted ? quoted[2] : v.replace(/\s+#.*$/, '').trim();
  }
}

// macOS 10.13+ stores `date` as nanoseconds since the Apple epoch; older releases stored
// seconds. A nanosecond "now" is ~1.7e18; a seconds "now" is ~1.7e9 — 1e12 cleanly separates
// the two so one script handles chat.db files from either era.
function appleTimeToISO(raw) {
  if (raw == null) return null;
  const ms = raw > 1e12 ? raw / 1e6 : raw * 1000;
  return new Date(APPLE_EPOCH_MS + ms).toISOString();
}

function isEmailLike(identifier) {
  return identifier.includes('@');
}

function expandTilde(filePath) {
  if (!filePath) return filePath;
  return filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

function prepareStatements(db) {
  return {
    pageAfter: db.prepare(`
      SELECT
        m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
        m.handle_id AS handleId, m.is_from_me AS isFromMe, m.date AS date,
        m.cache_has_attachments AS hasAttachments,
        h.id AS handleIdentifier, h.service AS service
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT ?
    `),
    chatForMessage: db.prepare('SELECT chat_id AS chatId FROM chat_message_join WHERE message_id = ?'),
    participantsForChat: db.prepare(`
      SELECT h.id AS identifier
      FROM chat_handle_join chj
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id = ?
    `),
    attachmentsForMessage: db.prepare(`
      SELECT a.ROWID AS rowid, a.filename AS filename, a.mime_type AS mimeType
      FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = ?
    `),
  };
}

// 1:1 chats carry the other party directly on the message row (handleIdentifier, via the
// LEFT JOIN in pageAfter). Group-chat outgoing messages often have no direct handle — fall
// back to every other participant in the chat, cached per chat since it never changes mid-run.
function resolveHints(row, statements, chatCache) {
  if (row.handleIdentifier) {
    return [{
      alias: row.handleIdentifier,
      alias_type: isEmailLike(row.handleIdentifier) ? 'email' : 'phone',
      role: row.isFromMe ? 'recipient' : 'sender',
    }];
  }
  if (!row.isFromMe) return []; // incoming with no resolvable handle — nothing to hint
  const chatRow = statements.chatForMessage.get(row.rowid);
  if (!chatRow) return [];
  if (!chatCache.has(chatRow.chatId)) {
    chatCache.set(chatRow.chatId, statements.participantsForChat.all(chatRow.chatId));
  }
  return chatCache.get(chatRow.chatId).map((p) => ({
    alias: p.identifier,
    alias_type: isEmailLike(p.identifier) ? 'email' : 'phone',
    role: 'recipient',
  }));
}

function messageText(row) {
  if (row.text) return row.text;
  if (row.attributedBody) return extractText(row.attributedBody);
  return null;
}

function buildMessagePayload(row, text, hints) {
  const who = row.handleIdentifier ?? 'group chat';
  return {
    source: 'imessage',
    source_id: `chat.db:msg:${row.rowid}`,
    type: 'message',
    text_repr: row.isFromMe ? `Message to ${who}: "${text}"` : `Message from ${who}: "${text}"`,
    occurred_at: appleTimeToISO(row.date),
    extra: { service: row.service ?? null, is_from_me: !!row.isFromMe, guid: row.guid },
    entity_hints: hints,
  };
}

function buildPhotoPayload(row, attachment, hints) {
  const who = row.handleIdentifier ?? 'group chat';
  return {
    source: 'imessage',
    source_id: `chat.db:attachment:${attachment.rowid}`,
    type: 'photo',
    text_repr: row.isFromMe ? `Photo sent to ${who}` : `Photo received from ${who}`,
    occurred_at: appleTimeToISO(row.date),
    raw_path: expandTilde(attachment.filename),
    extra: { mime_type: attachment.mimeType, guid: row.guid },
    entity_hints: hints,
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function postIngestBatch(payloads) {
  const res = await fetch(`${LIFECONTEXT_URL}/api/v1/ingest/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LIFECONTEXT_API_KEY },
    body: JSON.stringify({ artifacts: payloads }),
  });
  if (!res.ok) throw new Error(`ingest batch returned ${res.status}`);
  return res.json();
}

function buildPagePayloads(rows, statements, chatCache) {
  const payloads = [];
  for (const row of rows) {
    const text = messageText(row);
    if (!text && !row.hasAttachments) continue; // reaction/tapback or truly empty row — nothing to remember
    const hints = resolveHints(row, statements, chatCache);
    if (text) payloads.push(buildMessagePayload(row, text, hints));
    if (row.hasAttachments) {
      const attachments = statements.attachmentsForMessage.all(row.rowid);
      for (const attachment of attachments) {
        if ((attachment.mimeType || '').startsWith('image/')) {
          payloads.push(buildPhotoPayload(row, attachment, hints));
        } else {
          // Out of scope for this milestone (README "Known limitations") — logged, not silently
          // dropped, so an operator can see what's being skipped and prioritize accordingly.
          console.error(`imessage: skipping non-image attachment ${attachment.rowid} (${attachment.mimeType || 'unknown mime type'})`);
        }
      }
    }
  }
  return payloads;
}

// A POST failure (network error, non-2xx envelope) aborts the whole page WITHOUT advancing
// the cursor — chat.db is a stable historical record, so the safe move is "do nothing and
// retry next run" (doc 04 §7 failure posture), not partial progress with data unaccounted for.
// A per-item validation failure inside a successful response still advances the cursor (the
// item was attempted; retrying a validation failure forever isn't productive) but is logged.
async function syncPage(rows, statements, chatCache) {
  const payloads = buildPagePayloads(rows, statements, chatCache);
  for (const batch of chunk(payloads, INGEST_BATCH_MAX)) {
    const result = await postIngestBatch(batch);
    result.results.forEach((r, i) => {
      if (r.error) console.error('imessage: item failed', batch[i].source_id, r.error, r.issues ?? '');
    });
  }
}

function readCursor() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')).lastRowId ?? 0;
  } catch {
    return 0;
  }
}

function writeCursor(lastRowId) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ lastRowId }));
}

async function backfill(statements, chatCache) {
  let cursor = readCursor();
  for (;;) {
    const rows = statements.pageAfter.all(cursor, DB_PAGE_SIZE);
    if (!rows.length) break;
    await syncPage(rows, statements, chatCache);
    cursor = rows[rows.length - 1].rowid;
    writeCursor(cursor);
    console.error(`imessage: synced through ROWID ${cursor}`);
    if (rows.length < DB_PAGE_SIZE) break; // caught up to the end of the table
  }
}

// One backfill pass against a FRESH connection. The export helper (README) snapshots via
// os.replace() — an atomic rename to a NEW inode — so a connection opened before the swap keeps
// reading the old, now-unlinked inode and never sees rows added by a later snapshot. Opening (and
// closing) per pass makes every pass read the CURRENT file, which is what lets --watch work against
// the helper's snapshot at all. The chat-participant cache is per-pass too: a later snapshot may
// change a group's roster, so caching it for the process lifetime would serve stale entity_hints
// for outgoing group messages while their rows are read fresh. See #142.
async function runPass() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await backfill(prepareStatements(db), new Map());
  } finally {
    db.close();
  }
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('imessage: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }

  await runPass();

  if (!WATCH) {
    process.exit(process.exitCode ?? 0); // fetch's keep-alive sockets would otherwise hold the process open
    return;
  }

  console.error(`imessage: watching for new messages every ${POLL_INTERVAL_MS}ms`);
  // Self-rescheduling setTimeout, not setInterval: a pass that takes longer than POLL_INTERVAL_MS
  // (slow network, large page) must not overlap with the next one — two concurrent passes would
  // race reading/writing the same cursor file. The next poll is scheduled only after the current
  // one settles. Each poll is a fresh runPass() so an atomically-replaced snapshot (new inode) is
  // reopened and its new rows are picked up — without this, a long-running watcher never sees a
  // newer snapshot. See #142.
  let stopped = false;
  let timer = null;
  const scheduleNextPoll = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      runPass()
        .catch((err) => console.error('imessage: poll failed', err))
        .finally(scheduleNextPoll);
    }, POLL_INTERVAL_MS);
  };
  scheduleNextPoll();
  const shutdown = () => { stopped = true; clearTimeout(timer); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('imessage: sync failed', err);
  process.exit(1); // fetch's keep-alive sockets would otherwise hold the process open
});
