// Seeds a synthetic chat.db (real iMessage schema) and runs index.js against it with mock
// ingest servers, since there's no macOS box in CI/dev to test against a real one. Covers:
// plain text, attributedBody-only text, a photo attachment, a group-chat outgoing message,
// cursor advancement, idempotent re-run, and (#142) a --watch pass reopening an
// atomically-replaced snapshot so its new rows sync without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import bplistCreator from 'bplist-creator';

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const toAppleNs = (isoString) => (Date.parse(isoString) - APPLE_EPOCH_MS) * 1e6;

function seedChatDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      handle_id INTEGER, is_from_me INTEGER, date INTEGER, cache_has_attachments INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);

  db.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)').run(1, '+15550142', 'iMessage');
  db.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)').run(2, 'sarah@example.com', 'iMessage');

  db.prepare('INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (?, ?, ?)').run(1, 'group-chat-guid', 'chat123456789');
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 1);
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 2);

  // 1: plain-text incoming message
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (1, 'msg-1', 'Landed! See you at the gate.', 1, 0, ?, 0)`)
    .run(toAppleNs('2026-07-01T18:22:09Z'));

  // 2: attributedBody-only incoming message (text column NULL)
  const archive = bplistCreator({
    '$archiver': 'NSKeyedArchiver', '$version': 100000,
    '$objects': ['$null', { NSString: 'placeholder' }, 'Running 10 minutes late, sorry!',
      'NSAttributedString', 'NSObject', 'NSMutableAttributedString', 'NSString',
      '__kIMMessagePartAttributeName'],
    '$top': { root: 1 },
  });
  db.prepare(`INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (2, 'msg-2', NULL, ?, 1, 0, ?, 0)`)
    .run(archive, toAppleNs('2026-07-01T18:25:00Z'));

  // 3: outgoing message with a photo attachment
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (3, 'msg-3', 'Check this out', 1, 1, ?, 1)`)
    .run(toAppleNs('2026-07-01T19:00:00Z'));
  db.prepare(`INSERT INTO attachment (ROWID, filename, mime_type) VALUES (1, '~/Library/Messages/Attachments/ab/photo.jpg', 'image/jpeg')`).run();
  db.prepare(`INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (3, 1)`).run();

  // 4: outgoing group-chat message with no direct handle_id (fallback to chat participants)
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (4, 'msg-4', 'See everyone Friday', NULL, 1, ?, 0)`)
    .run(toAppleNs('2026-07-01T19:05:00Z'));
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4)').run();

  // 5: a tapback/reaction-shaped row — no text, no attachment — must be skipped entirely
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (5, 'msg-5', NULL, 1, 0, ?, 0)`)
    .run(toAppleNs('2026-07-01T19:06:00Z'));

  db.close();
}

function startMockServer(handler) {
  const received = [];
  const headers = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      received.push(parsed);
      headers.push(req.headers);
      handler(parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received, headers })));
}

// Async spawn, not spawnSync: spawnSync blocks this process's entire event loop until the
// child exits, but the mock HTTP server the child talks to (started via `http.createServer`
// in THIS process) can only respond by running that very event loop — spawnSync here would
// deadlock the child against its own test's server.
function runConnector(env, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'index.js'), ...extraArgs], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('backfill: syncs messages + photo, hints resolved, tapback skipped, cursor advances', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath);

  const { server, port, received } = await startMockServer((body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      summary: { created: body.artifacts.length, updated: 0, failed: 0 },
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const result = await runConnector({
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    IMESSAGE_DB_PATH: dbPath,
    IMESSAGE_STATE_PATH: statePath,
  });

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(received.length, 1, 'one batch call for a small page');
  const artifacts = received[0].artifacts;

  // msg 1: plain text, sender hint
  const msg1 = artifacts.find((a) => a.source_id === 'chat.db:msg:1');
  assert.equal(msg1.type, 'message');
  assert.match(msg1.text_repr, /Landed! See you at the gate\./);
  assert.deepEqual(msg1.entity_hints, [{ alias: '+15550142', alias_type: 'phone', role: 'sender' }]);

  // msg 2: attributedBody-decoded text
  const msg2 = artifacts.find((a) => a.source_id === 'chat.db:msg:2');
  assert.match(msg2.text_repr, /Running 10 minutes late, sorry!/);

  // msg 3 + its photo attachment
  const msg3 = artifacts.find((a) => a.source_id === 'chat.db:msg:3');
  assert.equal(msg3.entity_hints[0].role, 'recipient');
  const photo = artifacts.find((a) => a.source_id === 'chat.db:attachment:1');
  assert.equal(photo.type, 'photo');
  // Assert the tilde was actually expanded to $HOME, not just "doesn't start with ~" — that
  // weaker check would still pass for a wrongly-rooted absolute path.
  assert.equal(photo.raw_path, path.join(homedir(), 'Library/Messages/Attachments/ab/photo.jpg'));

  // msg 4: group-chat fallback hints both participants
  const msg4 = artifacts.find((a) => a.source_id === 'chat.db:msg:4');
  assert.equal(msg4.entity_hints.length, 2);
  assert.deepEqual(new Set(msg4.entity_hints.map((h) => h.alias)), new Set(['+15550142', 'sarah@example.com']));

  // msg 5 (tapback-shaped, no text/attachment) never sent
  assert.equal(artifacts.find((a) => a.source_id === 'chat.db:msg:5'), undefined);

  // cursor advanced to the last ROWID
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).lastRowId, 5);

  rmSync(tmp, { recursive: true, force: true });
});

test('re-run after cursor advanced sends nothing new (no duplicate work)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath);
  writeFileSync(statePath, JSON.stringify({ lastRowId: 5 }));

  const { server, port, received } = await startMockServer((body, res) => {
    res.end(JSON.stringify({ summary: {}, results: [] }));
  });

  const result = await runConnector({
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    IMESSAGE_DB_PATH: dbPath,
    IMESSAGE_STATE_PATH: statePath,
  });

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(received.length, 0, 'nothing past the cursor to sync');

  rmSync(tmp, { recursive: true, force: true });
});

test('ingest failure aborts the page without advancing the cursor', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath);

  const { server, port } = await startMockServer((body, res) => {
    res.statusCode = 500;
    res.end('{}');
  });

  const result = await runConnector({
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    IMESSAGE_DB_PATH: dbPath,
    IMESSAGE_STATE_PATH: statePath,
  });

  server.closeAllConnections();
  server.close();
  assert.notEqual(result.status, 0);
  assert.throws(() => readFileSync(statePath, 'utf8'), 'cursor file never written');

  rmSync(tmp, { recursive: true, force: true });
});

// #142: the export helper snapshots via os.replace() (atomic rename -> new inode). A watcher that
// held its DB handle open would keep reading the old inode and never see a newer snapshot. This
// asserts a --watch pass reopens the replaced file and syncs its new rows without a restart.
test('watch: an atomically-replaced snapshot (new inode) is reopened and its new rows sync', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath); // v1: ROWIDs 1-5

  const { server, port, received } = await startMockServer((body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      summary: { created: body.artifacts.length, updated: 0, failed: 0 },
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const sawSourceId = (id) => received.some((b) => b.artifacts?.some((a) => a.source_id === id));
  const waitFor = async (predicate, timeoutMs = 5000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  };

  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'index.js'), '--watch'], {
    env: { ...process.env,
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
      LIFECONTEXT_API_KEY: 'test-key',
      IMESSAGE_DB_PATH: dbPath,
      IMESSAGE_STATE_PATH: statePath,
      IMESSAGE_POLL_INTERVAL_MS: '150',
    },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    // initial backfill picked up the v1 rows (generous timeout for cold child + native module load)
    assert.ok(await waitFor(() => sawSourceId('chat.db:msg:1'), 10000), `initial backfill never ran: ${stderr}`);

    // atomically replace the snapshot with v2 (adds ROWID 6) — new inode, exactly like os.replace()
    const v2 = path.join(tmp, 'chat.db.next');
    seedChatDb(v2);
    const db2 = new Database(v2);
    db2.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
                 VALUES (6, 'msg-6', 'Fresh snapshot message', 1, 0, ?, 0)`)
      .run(toAppleNs('2026-07-02T08:00:00Z'));
    db2.close();
    renameSync(v2, dbPath); // atomic inode swap

    // the next poll must reopen the new inode and ingest ROWID 6
    assert.ok(await waitFor(() => sawSourceId('chat.db:msg:6')),
      `new snapshot row never ingested — stale-handle regression (#142): ${stderr}`);
    // The child writes the cursor AFTER the POST is received (cross-process), so poll for it rather
    // than reading once — otherwise this races the child's writeCursor.
    const cursorReached6 = await waitFor(() => {
      try { return JSON.parse(readFileSync(statePath, 'utf8')).lastRowId === 6; } catch { return false; }
    });
    assert.ok(cursorReached6, 'cursor advanced to the new row');
  } finally {
    child.kill('SIGTERM');
    // Register the close listener only if the child is still alive; if it already exited, the
    // 'close' event has fired and would never fire again — awaiting it would hang forever
    // (node:test has no default per-test timeout). The check + on() are synchronous (no yield
    // between), so no close event can slip through the gap.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((r) => child.once('close', r));
    }
    server.closeAllConnections();
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The loader reads `.env` beside index.js (hardcoded via import.meta.url), so a parser test must
// place a real one there. stashEnvFile() moves any existing `.env` aside by RENAME first —
// preserving its mode/owner/mtime and, on a hard mid-test abort, leaving the original recoverable
// at `.env.testbak` (a plain read+rewrite would instead leave the dev's real `.env` clobbered).
// The restore rename atomically replaces our throwaway test file. A fresh checkout has no `.env`
// (gitignored), so the common case just deletes the temp one.
const CONNECTOR_ENV_PATH = path.join(import.meta.dirname, '.env');
function stashEnvFile() {
  const bak = `${CONNECTOR_ENV_PATH}.testbak`;
  const had = existsSync(CONNECTOR_ENV_PATH);
  if (had) renameSync(CONNECTOR_ENV_PATH, bak);
  return () => { if (had) renameSync(bak, CONNECTOR_ENV_PATH); else rmSync(CONNECTOR_ENV_PATH, { force: true }); };
}

// #141: the .env parser must strip an inline `# comment` from an unquoted value (a trailing
// comment on IMESSAGE_DB_PATH pollutes the path → SQLITE_CANTOPEN) while keeping a `#` inside
// a quoted value verbatim (secrets/URLs may contain it).
test('#141 .env parser: inline comment stripped from path, quoted # preserved', async () => {
  const restoreEnv = stashEnvFile();
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath);
  writeFileSync(statePath, JSON.stringify({ lastRowId: 5 })); // skip all rows — this test is about parsing

  const { server, port, received } = await startMockServer((body, res) => {
    res.end(JSON.stringify({ summary: {}, results: [] }));
  });

  // IMESSAGE_DB_PATH carries a trailing inline comment (the original repro); the API key is
  // quoted and contains a `#` that must survive unchanged.
  writeFileSync(CONNECTOR_ENV_PATH, [
    `LIFECONTEXT_URL=http://127.0.0.1:${port}`,
    `IMESSAGE_DB_PATH=${dbPath}   # snapshot (recommended)`,
    'LIFECONTEXT_API_KEY="ab#cd"',
    '',
  ].join('\n'));

  try {
    // Pass only STATE_PATH via env; DB_PATH/URL/KEY must come from the .env under test. Blank
    // out any inherited copies so the loader (which skips already-defined keys) actually applies.
    const result = await runConnector({
      IMESSAGE_STATE_PATH: statePath,
      LIFECONTEXT_URL: undefined,
      IMESSAGE_DB_PATH: undefined,
      LIFECONTEXT_API_KEY: undefined,
    });

    server.closeAllConnections();
    server.close();

    // DB opened with no SQLITE_CANTOPEN → the ` # snapshot...` comment was stripped from the path.
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLITE_CANTOPEN/);
    // Cursor already at the last row, so nothing is sent — but the connector must have gotten
    // past DB open and configuration to reach that point.
    assert.equal(received.length, 0, 'cursor at last row, nothing to sync');
  } finally {
    restoreEnv();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A `#`-in-value assertion needs an actual request, so these run with the cursor unset (all rows
// sync) and inspect the x-api-key header the connector sent. Two keys under one test:
//  - quoted `"ab#cd"`  → surrounding quotes stripped, inner `#` kept.
//  - unquoted `#abc`   → NO leading whitespace before `#`, so it is NOT a comment and stays intact
//    (the KEY=#abc edge the parser explicitly preserves — guards it against silent regression).
test('#141 .env parser: quoted # and leading-# unquoted values reach the wire verbatim', async () => {
  for (const [rawKeyLine, expected] of [['LIFECONTEXT_API_KEY="ab#cd"', 'ab#cd'], ['LIFECONTEXT_API_KEY=#abc', '#abc']]) {
    const restoreEnv = stashEnvFile();
    const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
    const dbPath = path.join(tmp, 'chat.db');
    const statePath = path.join(tmp, 'cursor.json');
    seedChatDb(dbPath);

    const { server, port, headers } = await startMockServer((body, res) => {
      res.end(JSON.stringify({
        summary: { created: body.artifacts.length, updated: 0, failed: 0 },
        results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
      }));
    });

    writeFileSync(CONNECTOR_ENV_PATH, [
      `LIFECONTEXT_URL=http://127.0.0.1:${port}`,
      `IMESSAGE_DB_PATH=${dbPath} # inline comment`,
      rawKeyLine,
      '',
    ].join('\n'));

    try {
      const result = await runConnector({
        IMESSAGE_STATE_PATH: statePath,
        LIFECONTEXT_URL: undefined,
        IMESSAGE_DB_PATH: undefined,
        LIFECONTEXT_API_KEY: undefined,
      });

      server.closeAllConnections();
      server.close();

      assert.equal(result.status, 0, result.stderr);
      assert.ok(headers.length > 0, `connector made at least one ingest call (${rawKeyLine})`);
      assert.equal(headers[0]['x-api-key'], expected, `value preserved verbatim: ${rawKeyLine}`);
    } finally {
      restoreEnv();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});
