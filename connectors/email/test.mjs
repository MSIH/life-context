// Unit tests for the email connector's pure layer (parse.js). No mailbox, no server, no network —
// every case below is a function of header bytes. Fixtures are synthetic throughout: never commit a
// real message, and never a real address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAddress, parseAddressList, splitAddressList, decodeEncodedWords,
  normalizeMessageId, sourceIdFor, parseDateHeader, truncateSnippet, buildTextRepr,
  splitMessage, parseHeaders, SNIPPET_MAX_CHARS, sha256, parseMessageIdList,
} from './parse.js';
import { readMessages, detectStoreFormat, unescapeMboxLine, isClientIndexFile } from './mailstore.js';
import { stripSignature } from './signature.js';
import { stripQuotedReply, quoteBoundaryFound } from './quotes.js';

test('parseAddress: splits a display name from the address', () => {
  assert.deepEqual(parseAddress('Chris Cole <chris@example.com>'), { email: 'chris@example.com', name: 'Chris Cole' });
});

test('parseAddress: a bare address has no name', () => {
  assert.deepEqual(parseAddress('chris@example.com'), { email: 'chris@example.com', name: null });
  assert.deepEqual(parseAddress('<chris@example.com>'), { email: 'chris@example.com', name: null });
});

test('parseAddress: lowercases the address but preserves display-name case', () => {
  assert.deepEqual(parseAddress('Chris Cole <Chris.Cole@Example.COM>'), { email: 'chris.cole@example.com', name: 'Chris Cole' });
});

test('parseAddress: a display name that merely repeats the address yields no name', () => {
  // Otherwise the caller emits a `name` hint identical to the `email` hint — noise in the graph.
  assert.deepEqual(parseAddress('chris@example.com <chris@example.com>'), { email: 'chris@example.com', name: null });
});

test('parseAddress: strips surrounding quotes and unescapes an inner quote', () => {
  assert.deepEqual(parseAddress('"Cole, Chris" <chris@example.com>'), { email: 'chris@example.com', name: 'Cole, Chris' });
  assert.deepEqual(parseAddress('"Chris \\"CC\\" Cole" <chris@example.com>'), { email: 'chris@example.com', name: 'Chris "CC" Cole' });
});

test('parseAddress: returns null for anything without a usable address', () => {
  assert.equal(parseAddress('undisclosed-recipients:;'), null);
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress('not an address'), null);
});

test('splitAddressList: a comma inside a quoted display name does not split the list', () => {
  // The classic bug: a naive split on ',' turns one recipient into two bogus ones.
  assert.deepEqual(splitAddressList('"Cole, Chris" <c@x.com>, dana@y.com'), ['"Cole, Chris" <c@x.com>', 'dana@y.com']);
});

test('parseAddressList: parses several recipients and drops the unusable ones', () => {
  const list = parseAddressList('"Cole, Chris" <c@x.com>, dana@y.com, undisclosed-recipients:;, Eve <eve@z.com>');
  assert.deepEqual(list, [
    { email: 'c@x.com', name: 'Cole, Chris' },
    { email: 'dana@y.com', name: null },
    { email: 'eve@z.com', name: 'Eve' },
  ]);
});

test('decodeEncodedWords: decodes RFC 2047 B and Q words, leaves plain text alone', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?w4VzYSBCasO2cms=?='), 'Åsa Björk');
  assert.equal(decodeEncodedWords('=?UTF-8?Q?=C3=85sa_Bj=C3=B6rk?='), 'Åsa Björk');
  assert.equal(decodeEncodedWords('Plain Name'), 'Plain Name');
  assert.equal(decodeEncodedWords('=?UTF-8?X?unknown-encoding?='), '=?UTF-8?X?unknown-encoding?=');
});

test('parseAddress: decodes an encoded display name', () => {
  assert.deepEqual(parseAddress('=?UTF-8?B?w4VzYSBCasO2cms=?= <asa@example.com>'), { email: 'asa@example.com', name: 'Åsa Björk' });
});

test('normalizeMessageId: strips brackets, trims and lowercases', () => {
  assert.equal(normalizeMessageId('<ABC-123@Mail.Example.COM>'), 'abc-123@mail.example.com');
  assert.equal(normalizeMessageId('  <abc@x>  '), 'abc@x');
  assert.equal(normalizeMessageId(''), '');
  assert.equal(normalizeMessageId(undefined), '');
});

// The convergence guarantee: this scheme must match the private companion repo's Stage 5 sink exactly,
// or a message both sent recently and backfilled here becomes two artifacts instead of upserting.
test('sourceIdFor: derives from the Message-ID, stable across differing spellings', () => {
  const a = sourceIdFor({ messageId: '<ABC-123@Mail.Example.COM>', from: 'me@x.com' });
  const b = sourceIdFor({ messageId: 'abc-123@mail.example.com', from: 'someone-else@y.com' });
  assert.equal(a, 'email:msg:abc-123@mail.example.com');
  assert.equal(a, b, 'same Message-ID must yield the same id regardless of other fields');
});

test('sourceIdFor: falls back to a content hash when Message-ID is absent, still deterministic', () => {
  const fields = { messageId: '', from: 'me@x.com', date: 'Mon, 3 Jan 2011 10:00:00 +0000', subject: 'Hi', body: 'Hello' };
  const first = sourceIdFor(fields);
  assert.equal(first, sourceIdFor({ ...fields }), 'must be reproducible, never random');
  assert.match(first, /^email:msg:sha256:[0-9a-f]{64}$/);
  assert.notEqual(first, sourceIdFor({ ...fields, body: 'Different' }));
});

test('parseDateHeader: converts a Date header to ISO-8601', () => {
  assert.equal(parseDateHeader('Mon, 3 Jan 2011 10:04:05 +0000'), '2011-01-03T10:04:05.000Z');
  assert.equal(parseDateHeader('3 Jan 2011 05:04:05 -0500'), '2011-01-03T10:04:05.000Z');
});

test('parseDateHeader: returns null rather than guessing on a bad date', () => {
  // Omitting occurred_at costs a warning; a wrong one silently mis-sorts the timeline forever.
  assert.equal(parseDateHeader('not a date'), null);
  assert.equal(parseDateHeader(''), null);
  assert.equal(parseDateHeader(undefined), null);
  assert.equal(parseDateHeader('Mon, 3 Jan 1601 10:00:00 +0000'), null);
});

test('truncateSnippet: collapses whitespace and caps at SNIPPET_MAX_CHARS', () => {
  assert.equal(truncateSnippet('  hello\n\n  world  '), 'hello world');
  const long = truncateSnippet('x'.repeat(SNIPPET_MAX_CHARS * 2));
  assert.equal(long.length, SNIPPET_MAX_CHARS);
  assert.ok(long.endsWith('…'));
});

test('buildTextRepr: names recipients, then summarizes beyond three', () => {
  const one = buildTextRepr({ recipients: [{ email: 'c@x.com', name: 'Chris' }], subject: 'Lunch', body: 'noon?' });
  assert.equal(one, 'Email to Chris: Lunch — noon?');

  const many = buildTextRepr({
    recipients: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ email: `${n}@x.com`, name: n.toUpperCase() })),
    subject: 'Party',
    body: 'come',
  });
  assert.equal(many, 'Email to A, B, C +2 more: Party — come');
});

test('buildTextRepr: degrades cleanly with no subject, no body, or no recipients', () => {
  assert.equal(buildTextRepr({ recipients: [{ email: 'c@x.com', name: null }], subject: '', body: '' }), 'Email to c@x.com');
  assert.equal(buildTextRepr({ recipients: [], subject: 'Solo', body: '' }), 'Email to no recipients: Solo');
});

test('sha256: bare lowercase hex, matching the ingest contract', () => {
  assert.match(sha256('hello'), /^[0-9a-f]{64}$/);
  assert.equal(sha256('hello'), sha256('hello'));
});

// --- header parsing -----------------------------------------------------------------------------

test('splitMessage: splits at the first blank line; all-headers stays parseable', () => {
  assert.deepEqual(splitMessage('A: 1\r\nB: 2\r\n\r\nbody here'), { headerText: 'A: 1\r\nB: 2', body: 'body here' });
  assert.deepEqual(splitMessage('A: 1\nB: 2'), { headerText: 'A: 1\nB: 2', body: '' });
});

test('parseHeaders: lowercases keys and unfolds continuation lines', () => {
  const h = parseHeaders('Subject: a very\r\n  long subject\r\nFrom: me@x.com');
  assert.equal(h.subject, 'a very long subject');
  assert.equal(h.from, 'me@x.com');
});

test('parseHeaders: a repeated header keeps the FIRST value', () => {
  // A forged second Message-ID must not be able to override the real one and re-key the artifact.
  const h = parseHeaders('Message-ID: <real@x>\r\nMessage-ID: <forged@y>');
  assert.equal(h['message-id'], '<real@x>');
});

// --- mail store ---------------------------------------------------------------------------------

test('unescapeMboxLine: removes exactly one level of mboxrd quoting', () => {
  assert.equal(unescapeMboxLine('>From the desk of'), 'From the desk of');
  assert.equal(unescapeMboxLine('>>From the desk of'), '>From the desk of');
  assert.equal(unescapeMboxLine('From the desk of'), 'From the desk of'); // a real separator, untouched here
  assert.equal(unescapeMboxLine('> quoted reply'), '> quoted reply');
});

test('isClientIndexFile: skips the mail client’s own index files', () => {
  assert.equal(isClientIndexFile('Sent.msf'), true);
  assert.equal(isClientIndexFile('popstate.dat'), true);
  assert.equal(isClientIndexFile('1699999999.abc'), false);
});

const MSG_A = ['From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: One',
  'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <a@example.com>', '', 'first body', ''].join('\n');
const MSG_B = ['From: Me <me@example.com>', 'To: Dana <dana@example.com>', 'Subject: Two',
  'Date: Tue, 4 Jan 2011 10:00:00 +0000', 'Message-ID: <b@example.com>', '',
  '>From now on, note the quoting', ''].join('\n');

async function fixtureRoot() {
  return mkdtemp(path.join(tmpdir(), 'lc-email-'));
}

test('readMessages: streams an mbox folder and unescapes a quoted body line', async () => {
  const root = await fixtureRoot();
  const file = path.join(root, 'Sent');
  await writeFile(file, `From - Mon Jan 03 2011\n${MSG_A}\nFrom - Tue Jan 04 2011\n${MSG_B}\n`, 'utf8');

  assert.equal(await detectStoreFormat(file), 'mbox');
  const out = [];
  for await (const m of readMessages(file)) out.push(m);
  assert.equal(out.length, 2);
  assert.equal(out[0].sourcePath, null, 'an mbox has no per-message path, so raw_path must stay unset');
  assert.match(out[0].raw, /Subject: One/);
  assert.match(out[1].raw, /^From now on, note the quoting$/m, 'mboxrd quoting must be undone');
  assert.ok(!out[1].raw.includes('>From now on'));
});

test('readMessages: reads a maildir from cur/ and new/, ignoring index files', async () => {
  const root = await fixtureRoot();
  const dir = path.join(root, 'Sent');
  await mkdir(path.join(dir, 'cur'), { recursive: true });
  await mkdir(path.join(dir, 'new'), { recursive: true });
  await writeFile(path.join(dir, 'cur', '1000.a'), MSG_A, 'utf8');
  await writeFile(path.join(dir, 'new', '2000.b'), MSG_B, 'utf8');
  await writeFile(path.join(dir, 'cur', 'Sent.msf'), 'index, not a message', 'utf8');

  assert.equal(await detectStoreFormat(dir), 'maildir');
  const out = [];
  for await (const m of readMessages(dir)) out.push(m);
  assert.equal(out.length, 2, 'the .msf index must not be read as a message');
  assert.ok(out.every((m) => m.sourcePath), 'maildir gives every message an addressable path');
});

test('readMessages: throws a diagnosable error on a path that is not a mail folder', async () => {
  const root = await fixtureRoot();
  const notAFolder = path.join(root, 'nope');
  await mkdir(notAFolder, { recursive: true });
  await assert.rejects(
    (async () => { for await (const _ of readMessages(notAFolder)) { /* consume */ } })(),
    /POP rather than IMAP/,
    'the error must name the likely cause, not just fail',
  );
});

test('readMessages: never writes to the store', async () => {
  const root = await fixtureRoot();
  const file = path.join(root, 'Sent');
  await writeFile(file, `From - Mon Jan 03 2011\n${MSG_A}\n`, 'utf8');
  const before = await readdir(root);
  for await (const _ of readMessages(file)) { /* consume */ }
  assert.deepEqual((await readdir(root)).sort(), before.sort(), 'reading must not create or remove files');
});

test('parse + read together: an mbox message yields the fields the payload needs', async () => {
  const root = await fixtureRoot();
  const file = path.join(root, 'Sent');
  await writeFile(file, `From - Mon Jan 03 2011\n${MSG_A}\n`, 'utf8');
  const [{ raw }] = await (async () => { const a = []; for await (const m of readMessages(file)) a.push(m); return a; })();

  const { headerText, body } = splitMessage(raw);
  const h = parseHeaders(headerText);
  assert.equal(sourceIdFor({ messageId: h['message-id'] }), 'email:msg:a@example.com');
  assert.equal(parseDateHeader(h.date), '2011-01-03T10:00:00.000Z');
  assert.deepEqual(parseAddressList(h.to), [{ email: 'chris@example.com', name: 'Chris' }]);
  assert.equal(buildTextRepr({ recipients: parseAddressList(h.to), subject: h.subject, body }), 'Email to Chris: One — first body');
});

// --- payload assembly ---------------------------------------------------------------------------

const { buildPayload, packBatches, payloadByteLength, MAX_BATCH_BYTES } = await import('./index.js');

const SENT = [
  'From: Me <me@example.com>',
  'To: Chris <chris@example.com>, "Cole, Dana" <dana@example.com>',
  'Cc: eve@example.com',
  'Subject: Lunch plans',
  'Date: Mon, 3 Jan 2011 10:00:00 +0000',
  'Message-ID: <lunch-1@example.com>',
  '',
  'Noon at the usual place.',
].join('\n');

test('buildPayload: emits the contract shape with email+name hints for every party', async () => {
  const { payload, occurredAt } = await buildPayload({ raw: SENT, sourcePath: null });
  assert.equal(payload.source, 'email');
  assert.equal(payload.type, 'email');
  assert.equal(payload.source_id, 'email:msg:lunch-1@example.com');
  assert.equal(payload.occurred_at, '2011-01-03T10:00:00.000Z');
  assert.equal(occurredAt, '2011-01-03T10:00:00.000Z');
  assert.match(payload.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(payload.text_repr, 'Email to Chris, Cole, Dana, eve@example.com: Lunch plans — Noon at the usual place.');
  assert.equal(payload.extra.recipient_count, 3);
  assert.equal(payload.raw_path, undefined, 'an mbox message has no addressable path');

  assert.deepEqual(payload.entity_hints, [
    { alias: 'me@example.com', alias_type: 'email', role: 'sender' },
    { alias: 'Me', alias_type: 'name', role: 'sender' },
    { alias: 'chris@example.com', alias_type: 'email', role: 'recipient' },
    { alias: 'Chris', alias_type: 'name', role: 'recipient' },
    { alias: 'dana@example.com', alias_type: 'email', role: 'recipient' },
    { alias: 'Cole, Dana', alias_type: 'name', role: 'recipient' },
    { alias: 'eve@example.com', alias_type: 'email', role: 'recipient' },
  ]);
});

test('buildPayload: never sets suggested_kind — that is what feeds #87', async () => {
  // With it, core stages one proposal per recipient and floods the review queue; without it an
  // unknown address accumulates in unresolved_aliases, which is the frequency promoter's input.
  const { payload } = await buildPayload({ raw: SENT, sourcePath: null });
  assert.ok(payload.entity_hints.every((h) => !('suggested_kind' in h)));
});

test('buildPayload: only alias types and roles the ingest contract accepts', async () => {
  // A hint outside these vocabularies is silently DROPPED with a warning, so a typo here would
  // lose entity links without failing anything.
  const { payload } = await buildPayload({ raw: SENT, sourcePath: null });
  const types = new Set(['email', 'phone', 'name', 'handle']);
  const roles = new Set(['sender', 'recipient', 'pictured', 'mentioned', 'author', 'self', 'location_of']);
  for (const h of payload.entity_hints) {
    assert.ok(types.has(h.alias_type), `bad alias_type ${h.alias_type}`);
    assert.ok(roles.has(h.role), `bad role ${h.role}`);
  }
});

test('buildPayload: sets raw_path only for a maildir message', async () => {
  const { payload } = await buildPayload({ raw: SENT, sourcePath: '/store/Sent/cur/1000.a' });
  assert.equal(payload.raw_path, '/store/Sent/cur/1000.a');
});

test('buildPayload: omits occurred_at when the Date header is unusable', async () => {
  const raw = SENT.replace('Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Date: garbage');
  const { payload, occurredAt } = await buildPayload({ raw, sourcePath: null });
  assert.equal('occurred_at' in payload, false, 'omitted, never guessed');
  assert.equal(occurredAt, null);
});

test('buildPayload: omits occurred_at when the Date header is absent entirely', async () => {
  // #519: 329/2,806 messages in the real Yahoo sent store have no Date header at all — calendar
  // alert/response mail relayed through Yahoo's WebService/CalDAV backend, not a rejected format
  // and not an mbox-splitting defect (the header block itself is intact; Date is simply absent).
  // No substitute timestamp exists anywhere in the message, so this must stay omitted forever,
  // never guessed from the mbox `From ` envelope line or a file mtime (connector-conventions R5).
  const raw = SENT.split('\n').filter((line) => !line.startsWith('Date:')).join('\n');
  const { payload, occurredAt } = await buildPayload({ raw, sourcePath: null });
  assert.equal('occurred_at' in payload, false, 'omitted, never guessed');
  assert.equal(occurredAt, null);
});

test('buildPayload: is deterministic — same message, same payload', async () => {
  const [a, b] = await Promise.all([
    buildPayload({ raw: SENT, sourcePath: null }),
    buildPayload({ raw: SENT, sourcePath: null }),
  ]);
  assert.deepEqual(a.payload, b.payload);
});

// --- byte-budgeted batching (#405) ---------------------------------------------------------------
// The defect this closes: EMAIL_BATCH_SIZE (an ITEM count) was the only batching rule, but the
// server's real cap is BYTES (JSON_BODY_LIMIT = 256kb). extra.body_full (#386) is NOT capped at
// SNIPPET_MAX_CHARS the way text_repr is, so wire size scales with real body size — a realistic
// MAX_PART_CHARS-scale archive 413s a fixed 50-item batch (measured ~1.1MB, over 4x the cap). The
// historical fixture this test used before (3x SNIPPET_MAX_CHARS = 3,000 chars/message) was the
// "still fits in one batch" case that made the bug invisible; this raises it to MAX_PART_CHARS
// (20,000 chars), the real worst case, per the issue's own plan step 5.

const MAX_PART_CHARS = 20_000; // matches mime.js's own ceiling — the real worst-case body size

test('packBatches: packs realistic MAX_PART_CHARS-scale messages into MULTIPLE sub-256kb batches, none dropped', async () => {
  const bulky = SENT.replace('Noon at the usual place.', 'x'.repeat(MAX_PART_CHARS));
  const payloads = await Promise.all(
    Array.from({ length: 50 }, () => buildPayload({ raw: bulky, sourcePath: null }).then((r) => r.payload)),
  );
  assert.ok(payloads.every((p) => p.extra.body_full), 'body_full must actually be populated for this measurement to mean anything');

  const oneBigBatchBytes = Buffer.byteLength(JSON.stringify({ artifacts: payloads }), 'utf8');
  assert.ok(oneBigBatchBytes > 256 * 1024, `expected the naive single 50-item batch (${oneBigBatchBytes} bytes) to exceed the 256kb cap — that is the bug this issue fixes`);

  const batches = await packBatches(payloads);
  assert.ok(batches.length > 1, 'a realistic-size 50-message set must be packed into more than one wire batch');
  assert.equal(batches.flat().length, 50, 'every payload must land in exactly one batch — none dropped, none duplicated');
  for (const batch of batches) {
    assert.ok(batch.length <= 50, 'EMAIL_BATCH_SIZE stays an ADDITIONAL item ceiling even for byte-based packing');
    const bytes = Buffer.byteLength(JSON.stringify({ artifacts: batch }), 'utf8');
    assert.ok(bytes < 256 * 1024, `a packed batch serialized to ${bytes} bytes, over the 256kb server cap`);
  }
});

test('packBatches: a batch of small messages still respects the EMAIL_BATCH_SIZE item ceiling (byte budget alone would allow more)', async () => {
  const payloads = await Promise.all(
    Array.from({ length: 120 }, () => buildPayload({ raw: SENT, sourcePath: null }).then((r) => r.payload)),
  );
  const batches = await packBatches(payloads);
  for (const batch of batches) assert.ok(batch.length <= 50, `a batch of ${batch.length} exceeds the 50-item contract ceiling`);
  assert.equal(batches.flat().length, 120);
});

test('payloadByteLength: matches the serialized byte size of the payload alone', async () => {
  const { payload } = await buildPayload({ raw: SENT, sourcePath: null });
  assert.equal(payloadByteLength(payload), Buffer.byteLength(JSON.stringify(payload), 'utf8'));
});

test('MAX_BATCH_BYTES leaves real headroom below the 256kb JSON_BODY_LIMIT server cap', () => {
  assert.ok(MAX_BATCH_BYTES < 256 * 1024, 'the budget must sit below the server cap, not at or above it');
  assert.ok(256 * 1024 - MAX_BATCH_BYTES > 10 * 1024, 'headroom must be more than a token amount, to absorb request-framing overhead the budget does not measure');
});

// --- MIME body extraction (#362) -----------------------------------------------------------------
// The defect this closes: splitMessage()'s `body` is raw MIME wire format — boundaries, part
// headers, transport encoding — not prose. Every fixture here is synthetic, example.com only.

const crlfJoin = (lines) => lines.join('\r\n');

function multipartAlternativeFixture() {
  const plainQp = 'Noon at the usual place=2C bring the report.'; // quoted-printable: place, bring
  const htmlB64 = Buffer.from('<html><body><p>Noon at the usual place, bring the report.</p></body></html>').toString('base64');
  return crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Multipart demo',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <mp-alt@example.com>',
    'Content-Type: multipart/alternative; boundary="mp-boundary-xyz"', '',
    '--mp-boundary-xyz',
    'Content-Type: text/plain; charset=ISO-8859-1',
    'Content-Transfer-Encoding: quoted-printable', '',
    plainQp,
    '--mp-boundary-xyz',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    htmlB64,
    '--mp-boundary-xyz--', '',
  ]);
}

test('Problem repro: multipart/alternative yields clean prose, no boundary, no part headers, no base64', async () => {
  const { payload } = await buildPayload({ raw: multipartAlternativeFixture(), sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: Multipart demo — Noon at the usual place, bring the report.');
  assert.equal(payload.extra.body_source, 'text/plain');
});

test('multipart/mixed with an attachment: picks the plain part, never the attachment bytes', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: With attachment',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <mp-mixed@example.com>',
    'Content-Type: multipart/mixed; boundary="mix1"', '',
    '--mix1',
    'Content-Type: text/plain', '',
    'See the attached report.',
    '--mix1',
    'Content-Type: application/pdf; name=report.pdf',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename=report.pdf', '',
    Buffer.from('not real pdf bytes').toString('base64'),
    '--mix1--', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: With attachment — See the attached report.');
  assert.doesNotMatch(payload.text_repr, /report\.pdf/);
});

test('nested multipart/mixed -> multipart/alternative: picks the nested plain text', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Nested',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <mp-nested@example.com>',
    'Content-Type: multipart/mixed; boundary="outer1"', '',
    '--outer1',
    'Content-Type: multipart/alternative; boundary="inner1"', '',
    '--inner1',
    'Content-Type: text/plain', '',
    'Nested plain text body.',
    '--inner1',
    'Content-Type: text/html', '',
    '<html><body>Nested html body.</body></html>',
    '--inner1--',
    '--outer1',
    'Content-Type: application/pdf; name=x.pdf',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename=x.pdf', '',
    Buffer.from('pdf').toString('base64'),
    '--outer1--', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: Nested — Nested plain text body.');
});

test('single-part base64 decodes to prose', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Base64',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <sp-b64@example.com>',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    Buffer.from('Noon at the usual place.').toString('base64'), '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: Base64 — Noon at the usual place.');
});

test('single-part quoted-printable decodes to prose', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: QP',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <sp-qp@example.com>',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable', '',
    'Noon at the usual place=2C bring the report.', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: QP — Noon at the usual place, bring the report.');
});

test('single-part text/html converts to prose, no tags', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: HTML',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <sp-html@example.com>',
    'Content-Type: text/html; charset=UTF-8', '',
    '<html><body><p>Noon at the <b>usual</b> place.</p></body></html>', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: HTML — Noon at the usual place.');
  assert.equal(payload.extra.body_source, 'text/html');
});

test('charset=ISO-8859-1 quoted-printable decodes accented characters', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Charset',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <sp-charset@example.com>',
    'Content-Type: text/plain; charset=ISO-8859-1',
    'Content-Transfer-Encoding: quoted-printable', '',
    'Caf=E9 na=EFve', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: Charset — Café naïve');
});

test('a quoted boundary containing a semicolon parses without throwing', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Semicolon boundary',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <sp-semi@example.com>',
    'Content-Type: multipart/alternative; boundary="a;b"', '',
    '--a;b',
    'Content-Type: text/plain', '',
    'Plain text with a tricky boundary.',
    '--a;b--', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: Semicolon boundary — Plain text with a tricky boundary.');
});

test('an html-only alternative (no plain part) still yields prose', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: HTML only',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <mp-htmlonly@example.com>',
    'Content-Type: multipart/alternative; boundary="ho1"', '',
    '--ho1',
    'Content-Type: text/html', '',
    '<html><body>Html-only alternative body.</body></html>',
    '--ho1--', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: HTML only — Html-only alternative body.');
  assert.equal(payload.extra.body_source, 'text/html');
});

test('an attachment-only message yields no snippet and body_source none, never boilerplate', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Just a file',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <att-only@example.com>',
    'Content-Type: multipart/mixed; boundary="att1"', '',
    '--att1',
    'Content-Type: application/pdf; name=report.pdf',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename=report.pdf', '',
    Buffer.from('not real pdf bytes').toString('base64'),
    '--att1--', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: Just a file');
  assert.equal(payload.extra.body_source, 'none');
});

test('a truncated multipart with no closing delimiter parses without throwing', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Truncated',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <mp-trunc@example.com>',
    'Content-Type: multipart/alternative; boundary="tb1"', '',
    '--tb1',
    'Content-Type: text/plain', '',
    'Truncated body text with no closing boundary.',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.match(payload.text_repr, /Truncated body text/);
});

test('a deliberately malformed message parses without throwing and degrades to no snippet', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Malformed',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <malformed@example.com>',
    'Content-Type: multipart/alternative; boundary="mb1"', '',
    'garbage with no boundary markers at all, not even one dash-dash',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.extra.body_source, 'none');
  assert.equal(payload.text_repr, 'Email to Chris: Malformed');
});

test('no text_repr fixture contains a MIME boundary delimiter or a Content-Type: header', async () => {
  const fixtures = [
    SENT, multipartAlternativeFixture(),
  ];
  const results = await Promise.all(fixtures.map((raw) => buildPayload({ raw, sourcePath: null })));
  for (const { payload } of results) {
    assert.doesNotMatch(payload.text_repr, /^--/m, 'no MIME boundary delimiter');
    assert.doesNotMatch(payload.text_repr, /Content-Type:/i, 'no Content-Type header leaked into text_repr');
    assert.doesNotMatch(payload.text_repr, /Content-Transfer-Encoding:/i, 'no CTE header leaked into text_repr');
  }
});

test('source_id is unchanged: the byte-identical SENT fixture still yields the same Message-ID id', async () => {
  const { payload } = await buildPayload({ raw: SENT, sourcePath: null });
  assert.equal(payload.source_id, 'email:msg:lunch-1@example.com');
});

// The single most dangerous part of this change: a no-Message-ID message's hash-fallback source_id
// must be pinned to the RAW body, never the newly-decoded one, or every such message re-keys and
// creates a permanent duplicate in an append-only store.
test('source_id (hash fallback, no Message-ID) is pinned to the raw body, not the decoded body', async () => {
  const htmlB64 = Buffer.from('<html><body><p>Noon at the usual place, bring the report.</p></body></html>').toString('base64');
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: No message id',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    htmlB64, '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.match(payload.source_id, /^email:msg:sha256:[0-9a-f]{64}$/);

  // Recompute the expected id directly from parse.js's own primitives, against the RAW (still
  // base64) body — proving the decoded prose was never substituted into the sourceIdFor call.
  const { headerText, body: rawBody } = splitMessage(raw);
  const headers = parseHeaders(headerText);
  const expected = sourceIdFor({
    messageId: headers['message-id'], from: headers.from, date: headers.date, subject: headers.subject, body: rawBody,
  });
  assert.equal(payload.source_id, expected);

  // And explicitly: the id must NOT equal what sourceIdFor would produce if the decoded text had
  // been passed instead — pinning the regression the issue calls out by name.
  const decodedWrongId = sourceIdFor({
    messageId: headers['message-id'], from: headers.from, date: headers.date, subject: headers.subject,
    body: 'Noon at the usual place, bring the report.',
  });
  assert.notEqual(payload.source_id, decodedWrongId);
});

test('content_hash is unchanged — still sha256(raw)', async () => {
  const { payload } = await buildPayload({ raw: multipartAlternativeFixture(), sourcePath: null });
  assert.equal(payload.content_hash, sha256(multipartAlternativeFixture()));
});

test('the existing single-part expectation is byte-identical to before this fix', async () => {
  const { payload } = await buildPayload({ raw: SENT, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris, Cole, Dana, eve@example.com: Lunch plans — Noon at the usual place.');
});

test('the sent-only boundary is enforced, not merely documented', async () => {
  // Everything about this connector's safety rests on the mail being written BY the owner. A folder
  // named like an inbox must be refused before a single message is read.
  const { spawnSync } = await import('node:child_process');
  const run = (folder) => spawnSync(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), // not URL.pathname: that is %-encoded and keeps a leading / on Windows
    encoding: 'utf8',
    env: { ...process.env, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder', EMAIL_STORE_PATH: '/nonexistent', EMAIL_SENT_FOLDER: folder },
  });

  for (const folder of ['Inbox', 'INBOX', 'inbox', 'Personal Inbox']) {
    const r = run(folder);
    assert.notEqual(r.status, 0, `${folder} must be refused`);
    assert.match(r.stderr, /SENT mail only/, `${folder} must say why`);
  }
  // A legitimate sent folder gets past the guard and fails later, on the missing store — proving the
  // guard rejects the name rather than everything.
  const ok = run('Sent Items');
  assert.doesNotMatch(ok.stderr, /SENT mail only/);
});

// Re-ingest (#374): `exists` reporting a source_id as stored must NOT be able to stop a deliberate
// healing run, or no enrichment wave can ever land (doc 04 §9). Both directions are asserted — the
// flag submits the stored id anyway, and its absence still skips it — because the default staying
// cheap is half the requirement. One stub server, driven twice.
async function runAgainstStub({ existsReturns, env }) {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const posted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exists: existsReturns }));
        return;
      }
      const artifacts = JSON.parse(body).artifacts;
      posted.push(...artifacts.map((a) => a.source_id));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: artifacts.map(() => ({ id: 1 })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-reingest-'));
  await writeFile(path.join(store, 'Sent'), `From - Mon Jan 03 2011\n${MSG_A}\n`, 'utf8');

  // spawn, NOT spawnSync — same reason as the /exists 404 test below: the stub runs on this
  // process's event loop and a synchronous spawn would deadlock both.
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
      EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
      EMAIL_STATE_PATH: path.join(store, 'state.json'), EMAIL_SPOOL_DIR: path.join(store, 'spool'),
      ...env,
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((res) => server.close(res));
  return { code, stderr, posted, store };
}

test('EMAIL_REINGEST resubmits a source_id that /exists reports as already stored', async () => {
  const { code, stderr, posted } = await runAgainstStub({
    existsReturns: ['email:msg:a@example.com'],
    env: { EMAIL_REINGEST: 'true' },
  });
  assert.equal(code, 0, `must exit clean; stderr: ${stderr}`);
  assert.deepEqual(posted, ['email:msg:a@example.com'], 'the stored id must still be POSTed — core decides what to re-embed');
  assert.match(stderr, /RE-INGEST mode/, 'the mode must be legible in the run output');
  // The honest-summary half of #374: a healed message must never be reported as newly stored.
  assert.match(stderr, /ingested 0, resubmitted 1/, 'resubmitted must be counted apart from ingested');
});

test('without the flag, a source_id /exists reports as stored is not POSTed', async () => {
  const { code, stderr, posted } = await runAgainstStub({
    existsReturns: ['email:msg:a@example.com'],
    env: {},
  });
  assert.equal(code, 0, `must exit clean; stderr: ${stderr}`);
  assert.deepEqual(posted, [], 'default must stay cheap — a stored id is skipped');
  assert.doesNotMatch(stderr, /RE-INGEST mode/, 'the mode banner must not appear when the flag is unset');
  assert.match(stderr, /already-stored 1/);
});

test('--reingest as an argv flag matches the env var, and ignores a matching resume marker', async () => {
  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-argv-'));
  await writeFile(path.join(store, 'Sent'), `From - Mon Jan 03 2011\n${MSG_A}\n`, 'utf8');
  const statePath = path.join(store, 'state.json');
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const posted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exists: ['email:msg:a@example.com'] }));
        return;
      }
      posted.push(...JSON.parse(body).artifacts.map((a) => a.source_id));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ id: 1 }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const env = {
    ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
    EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
    EMAIL_STATE_PATH: statePath, EMAIL_SPOOL_DIR: path.join(store, 'spool'),
  };
  const spawnOnce = async (args) => {
    const child = spawn(process.execPath, ['index.js', ...args], { cwd: path.dirname(fileURLToPath(import.meta.url)), env });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, stderr };
  };
  // First pass writes a resume marker for an unchanged folder; without the flag the second pass
  // would resume past every message and read 0 — the secondary contributor named in #374.
  const first = await spawnOnce([]);
  const second = await spawnOnce(['--reingest']);
  await new Promise((res) => server.close(res));

  assert.equal(first.code, 0, `first pass must succeed; stderr: ${first.stderr}`);
  assert.match(first.stderr, /read 1/, 'first pass reads the message');
  assert.equal(second.code, 0, `--reingest pass must succeed; stderr: ${second.stderr}`);
  assert.match(second.stderr, /RE-INGEST mode/, '--reingest must enable the same mode as the env var');
  assert.match(second.stderr, /read 1, ingested 0, resubmitted 1/, 'the resume marker must not short-circuit a healing run');
  assert.deepEqual(posted, ['email:msg:a@example.com'], 'only the re-ingest pass POSTs; the first pass skipped it as already-stored');
});

// A core that predates POST /api/v1/exists (#198) answers 404. doc 04 §2: "a connector built
// against a newer core must treat a 404 as 'this core predates /exists' and fall back to processing
// everything, never a hard failure." Safe because ingest upserts on (source, source_id).
const MSG_C_MULTIPART = ['From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Multipart demo',
  'Date: Wed, 5 Jan 2011 10:00:00 +0000', 'Message-ID: <c@example.com>',
  'Content-Type: multipart/alternative; boundary="mp-boundary-xyz"', '',
  '--mp-boundary-xyz',
  'Content-Type: text/plain; charset=ISO-8859-1',
  'Content-Transfer-Encoding: quoted-printable', '',
  'Noon at the usual place=2C bring the report.',
  '--mp-boundary-xyz',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64', '',
  Buffer.from('<html><body><p>Noon at the usual place, bring the report.</p></body></html>').toString('base64'),
  '--mp-boundary-xyz--', ''].join('\n');

test('a 404 from /exists falls back to processing everything, never a hard failure', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const received = [];
  const artifactsPosted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') { res.writeHead(404); res.end('{}'); return; }
      const artifacts = JSON.parse(body).artifacts;
      received.push(...artifacts.map((a) => a.source_id));
      artifactsPosted.push(...artifacts);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: artifacts.map(() => ({ id: 1 })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-404-'));
  await writeFile(path.join(store, 'Sent'), `From - Mon Jan 03 2011
${MSG_A}
From - Wed Jan 05 2011
${MSG_C_MULTIPART}
`, 'utf8');

  // spawn, NOT spawnSync: the stub server runs on THIS process's event loop, and a synchronous
  // spawn would block it — the child's request would never be answered and both would hang.
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
      EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
      EMAIL_STATE_PATH: path.join(store, 'state.json'), EMAIL_SPOOL_DIR: path.join(store, 'spool'),
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((res) => server.close(res));

  assert.equal(code, 0, `must not hard-fail on 404; stderr: ${stderr}`);
  assert.match(stderr, /predates POST \/api\/v1\/exists/, 'must say why it is processing everything');
  assert.deepEqual(received.sort(), ['email:msg:a@example.com', 'email:msg:c@example.com'], 'both messages must still be ingested');

  // The posted payload for the multipart message must be clean prose end-to-end — not just at the
  // unit level, but as it actually goes out over the wire.
  const multipartArtifact = artifactsPosted.find((a) => a.source_id === 'email:msg:c@example.com');
  assert.equal(multipartArtifact.text_repr, 'Email to Chris: Multipart demo — Noon at the usual place, bring the report.');
  for (const a of artifactsPosted) {
    assert.doesNotMatch(a.text_repr, /^--/m, 'no MIME boundary delimiter in a posted payload');
    assert.doesNotMatch(a.text_repr, /Content-Type:/i, 'no Content-Type header in a posted payload');
  }
});

// --- split-on-413, quarantine, non-fatal spool flush (#405) --------------------------------------
// The defect this closes: a batch that 413s used to fail the whole batch outright, and flushSpool
// re-batched a spooled 413 at the SAME size with no try/catch, awaited BEFORE the mail read — so one
// oversized batch permanently bricked every future run. These three tests drive the real HTTP path
// end to end against a stub server (same style as the /exists tests above), because the behavior
// being proven — how a thrown 413 status is handled across the postWithBackoff -> postBatchSplitting
// -> flushBatch/flushSpool chain — only shows up at that boundary, not in a pure function.

test('a 413 on a multi-item batch splits in half and retries each half — both messages still land (#405)', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const batchesSeen = []; // one entry per POST /ingest/batch, recording how many items it carried
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exists: [] }));
        return;
      }
      const artifacts = JSON.parse(body).artifacts;
      batchesSeen.push(artifacts.map((a) => a.source_id));
      if (artifacts.length > 1) { res.writeHead(413); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: artifacts.map(() => ({ id: 1 })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-413-'));
  await writeFile(path.join(store, 'Sent'), `From - Mon Jan 03 2011\n${MSG_A}\nFrom - Tue Jan 04 2011\n${MSG_B}\n`, 'utf8');

  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
      EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
      EMAIL_STATE_PATH: path.join(store, 'state.json'), EMAIL_SPOOL_DIR: path.join(store, 'spool'),
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((res) => server.close(res));

  assert.equal(code, 0, `must exit clean; stderr: ${stderr}`);
  assert.ok(batchesSeen.some((b) => b.length === 2), 'the packer must have tried both messages as one batch first');
  const singles = batchesSeen.filter((b) => b.length === 1).flat();
  assert.deepEqual(singles.sort(), ['email:msg:a@example.com', 'email:msg:b@example.com'], 'after the 413, each half must be retried separately and both must land');
  assert.match(stderr, /read 2, ingested 2, .*spooled 0, quarantined 0/, 'both messages must count as ingested, nothing spooled or quarantined');
});

test('a single irreducible payload (its own size alone exceeds the batch budget) is quarantined, counted, and never retried forever (#405)', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exists: [] }));
        return;
      }
      res.writeHead(413); // every /ingest/batch call fails, no matter how small the batch
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-quarantine-'));
  await writeFile(path.join(store, 'Sent'), `From - Mon Jan 03 2011\n${MSG_A}\n`, 'utf8');
  const spoolDir = path.join(store, 'spool');

  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
      EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
      EMAIL_STATE_PATH: path.join(store, 'state.json'), EMAIL_SPOOL_DIR: spoolDir,
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((res) => server.close(res));

  assert.equal(code, 0, `an irreducible payload must not crash the run; stderr: ${stderr}`);
  assert.match(stderr, /quarantined an irreducible payload email:msg:a@example\.com/, 'quarantine must be logged by source_id (never a subject/address)');
  assert.match(stderr, /read 1, ingested 0, .*quarantined 1/, 'the summary must count it as a distinct outcome, not ingested or spooled');

  const quarantineFiles = (await readdir(path.join(spoolDir, 'quarantine'))).filter((f) => f.endsWith('.json'));
  assert.equal(quarantineFiles.length, 1, 'the payload must be relocated to the quarantine subdirectory, not dropped');
  const mainSpoolFiles = (await readdir(spoolDir)).filter((f) => f.endsWith('.json'));
  assert.equal(mainSpoolFiles.length, 0, 'it must not ALSO sit in the main spool dir, or it would be retried forever');
});

test('REGRESSION (#405): a spool holding an undrainable payload does not block new mail from being read, and the run exits 0', async () => {
  // This is the exact bug: flushSpool used to be awaited BEFORE the mail read, unguarded by a
  // try/catch, so a permanently-413ing spooled payload made every future run die before reading a
  // single new message. This seeds that exact condition and asserts new mail flows through anyway.
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const POISON_ID = 'email:msg:spooled-poison@example.com';
  const posted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exists: [] }));
        return;
      }
      const artifacts = JSON.parse(body).artifacts;
      if (artifacts.some((a) => a.source_id === POISON_ID)) { res.writeHead(413); res.end(); return; } // never lands
      posted.push(...artifacts.map((a) => a.source_id)); // brand-new mail lands normally
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: artifacts.map(() => ({ id: 1 })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-spool-regress-'));
  await writeFile(path.join(store, 'Sent'), `From - Mon Jan 03 2011\n${MSG_A}\n`, 'utf8');
  const spoolDir = path.join(store, 'spool');
  await mkdir(spoolDir, { recursive: true });
  // Pre-seed the spool with an already-undrainable payload, simulating a previous run's leftover —
  // the exact state that used to permanently brick the connector.
  await writeFile(path.join(spoolDir, 'poison.json'), JSON.stringify({
    source: 'email', source_id: POISON_ID, type: 'email', text_repr: 'poisoned',
  }), 'utf8');

  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
      EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
      EMAIL_STATE_PATH: path.join(store, 'state.json'), EMAIL_SPOOL_DIR: spoolDir,
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((res) => server.close(res));

  assert.equal(code, 0, `the run must still succeed; stderr: ${stderr}`);
  assert.deepEqual(posted, ['email:msg:a@example.com'], 'brand-new mail must still be read and ingested despite the poisoned spool');
  assert.match(stderr, /read 1/, 'the mail read must happen — this is exactly what used to never run');
  assert.match(stderr, /quarantined an irreducible spooled payload/, 'the poisoned spool entry must be quarantined, not silently retried forever');

  const quarantineFiles = (await readdir(path.join(spoolDir, 'quarantine'))).filter((f) => f.endsWith('.json'));
  assert.equal(quarantineFiles.length, 1, 'the poisoned payload must be relocated to quarantine, never dropped');
  const mainSpoolFiles = (await readdir(spoolDir)).filter((f) => f.endsWith('.json'));
  assert.equal(mainSpoolFiles.length, 0, 'the spool must not hold it forever — that IS the bug this issue fixes');
});

// --- signature/footer stripping (#368) -------------------------------------------------------
// The defect this closes: extractBodyText returns the WHOLE body, and buildTextRepr's 1000-char
// cap was overwhelmingly spent on a signature/legal footer rather than what was actually written.
// Every fixture is synthetic — example.com/example.org only, never a real name/phone/EIN.

test('stripSignature: cuts at the RFC 3676 "-- " delimiter', () => {
  const body = 'Thanks for the update.\n\n-- \nJordan Lee\nSenior Analyst\nExample Corp';
  assert.equal(stripSignature(body), 'Thanks for the update.');
});

test('stripSignature: cuts at a "--" delimiter with no trailing space too', () => {
  const body = 'Sounds good.\n\n--\nJordan Lee';
  assert.equal(stripSignature(body), 'Sounds good.');
});

test('stripSignature: cuts at a pipe-delimited contact block (name | title | phone | email)', () => {
  const body = [
    'Sounds good, see you then.', '',
    'Jordan Lee | Sales Manager | m: 555-201-3048 | jordan@example.com',
    'Example Corp | www.example.com | o: 555-201-9000 | info@example.com',
  ].join('\n');
  assert.equal(stripSignature(body), 'Sounds good, see you then.');
});

test('stripSignature: cuts a contact block even when a client wraps mid-field (real-archive shape, #368)', () => {
  // html-to-text wraps a signature's fielded line at a column width, splitting a single field
  // (e.g. "m: 555-201-3048") from the "| jordan@example.com" that follows onto the NEXT physical
  // line — this is the exact shape that defeated a naive per-line check against the real archive,
  // which is why isContactBlockParagraph groups by paragraph rather than by physical line.
  const body = [
    'Sounds good, see you then.', '',
    'Jordan Lee | Sales Manager | m: 555-201-3048',
    '| jordan@example.com',
  ].join('\n');
  assert.equal(stripSignature(body), 'Sounds good, see you then.');
});

test('stripSignature: cuts at a mobile-client sign-off', () => {
  const body = 'Yes, that works for me.\n\nSent from my iPhone';
  assert.equal(stripSignature(body), 'Yes, that works for me.');
});

test('stripSignature: cuts at a confidentiality/privilege paragraph, even when a client wraps it across lines', () => {
  const body = [
    "Sure, I'll send the invoice today.", '',
    'This message is intended only for the use of the addressee and',
    'may contain confidential information. If you are not the intended recipient, please',
    'notify the sender immediately and delete this email.',
  ].join('\n');
  assert.equal(stripSignature(body), "Sure, I'll send the invoice today.");
});

test('stripSignature: cuts at 501(c)(3)/tax-deductible nonprofit boilerplate with no contact block present', () => {
  const body = [
    'Thanks for asking about the fundraiser.', '',
    'We are a 501(c)(3) organization; your gift may be tax-deductible as allowed by law.',
  ].join('\n');
  assert.equal(stripSignature(body), 'Thanks for asking about the fundraiser.');
});

test('stripSignature: a one-word reply plus a long signature yields a short result (acceptance criterion)', () => {
  const body = [
    'fixed', '',
    'Jordan Lee | Support Engineer | m: 555-301-2200 | jordan@example.com',
    'Example Corp | www.example.com | o: 555-301-9000 | info@example.com',
    '',
    'This message is intended only for the use of the addressee and may contain confidential information.',
  ].join('\n');
  assert.equal(stripSignature(body), 'fixed');
});

test('stripSignature: NEGATIVE — prose containing a phone number, a URL, and a "|" is left unchanged', () => {
  const body = 'Call me at 555-123-4567 | check https://example.com/report | thanks for reading, no signature here.';
  assert.equal(stripSignature(body), body);
});

test('stripSignature: a pipe-delimited line with no email is not treated as a contact block', () => {
  const body = 'Option A | Option B | Option C — pick one and let me know by Friday.';
  assert.equal(stripSignature(body), body);
});

test('stripSignature: a bare mention of "confidential" in ordinary prose is not stripped', () => {
  const body = "Keep this confidential for now — I haven't told the board yet.";
  assert.equal(stripSignature(body), body);
});

test('stripSignature: text with no boundary at all comes back byte-identical', () => {
  const body = 'Here is the plan for tomorrow. Call me if anything changes.';
  assert.equal(stripSignature(body), body);
});

test('stripSignature: empty/falsy input passes through unchanged', () => {
  assert.equal(stripSignature(''), '');
  assert.equal(stripSignature(null), null);
  assert.equal(stripSignature(undefined), undefined);
});

test('stripSignature: a message that is ALL signature (no prose above the boundary) strips to empty, same as buildTextRepr already does for an attachment-only body', () => {
  const body = 'Jordan Lee | Support Engineer | m: 555-301-2200 | jordan@example.com';
  assert.equal(stripSignature(body), '');
});

test('buildTextRepr: an all-signature body degrades to subject-only, no snippet — never the boilerplate', () => {
  const body = 'Jordan Lee | Support Engineer | m: 555-301-2200 | jordan@example.com';
  const result = buildTextRepr({ recipients: [{ email: 'c@x.com', name: 'Chris' }], subject: 'Sign', body });
  assert.equal(result, 'Email to Chris: Sign');
});

test('buildTextRepr: applies stripSignature before truncation, so the snippet is the reply, not the footer', () => {
  const body = [
    'fixed', '',
    'Jordan Lee | Support Engineer | m: 555-301-2200 | jordan@example.com',
    'This message is intended only for the use of the addressee.',
  ].join('\n');
  const result = buildTextRepr({ recipients: [{ email: 'c@x.com', name: 'Chris' }], subject: 'Re: thing', body });
  assert.equal(result, 'Email to Chris: Re: thing — fixed');
});

test('buildPayload: source_id (hash fallback) is pinned to the raw body, unaffected by signature stripping', async () => {
  // The single most dangerous part of this change: a no-Message-ID message's hash-fallback
  // source_id must be pinned to the RAW body, never the signature-stripped one, or every such
  // message re-keys and creates a permanent duplicate in an append-only store (#362).
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: No message id, has signature',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000',
    'Content-Type: text/plain; charset=UTF-8', '',
    'fixed', '',
    'Jordan Lee | Support Engineer | m: 555-301-2200 | jordan@example.com', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.match(payload.source_id, /^email:msg:sha256:[0-9a-f]{64}$/);

  const { headerText, body: rawBody } = splitMessage(raw);
  const headers = parseHeaders(headerText);
  const expected = sourceIdFor({
    messageId: headers['message-id'], from: headers.from, date: headers.date, subject: headers.subject, body: rawBody,
  });
  assert.equal(payload.source_id, expected, 'source_id must be computed from the raw, unstripped body');

  // text_repr, meanwhile, IS the stripped short form — proving the two paths genuinely diverge.
  assert.equal(payload.text_repr, 'Email to Chris: No message id, has signature — fixed');
});

// --- quoted-reply stripping (#386) ----------------------------------------------------------------
// The defect this closes: extractBodyText/stripSignature return the WHOLE reply chain beneath the
// owner's new text, so a reply's snippet is mostly a correspondent's words re-quoted, not what the
// owner actually wrote. Every fixture is synthetic — example.com/example.org only.

test('stripQuotedReply: cuts at the "On <date>, <name> wrote:" attribution line', () => {
  const body = [
    'Sounds good to me.', '',
    'On Apr 2, 2014, at 3:45 PM, Chris Cole <chris@example.com> wrote:', '',
    '> Let me know if that works.',
    '> Thanks.',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Sounds good to me.');
});

test('stripQuotedReply: cuts at a "-----Original Message-----" separator', () => {
  const body = [
    'Sure, that works.', '',
    '-----Original Message-----',
    'Blah blah forwarded content without a proper header block.',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Sure, that works.');
});

test('stripQuotedReply: cuts at a "-------- Original message --------" separator (Yahoo/AOL web, any dash count)', () => {
  const body = [
    'Sure, that works.', '',
    '-------- Original message --------',
    'Blah blah forwarded content without a proper header block.',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Sure, that works.');
});

test('stripQuotedReply: cuts at "---------- Forwarded message ----------" (Gmail)', () => {
  const body = [
    'Here is my contact info.', '',
    '---------- Forwarded message ----------',
    'From: Chris Cole <chris@example.com>',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Here is my contact info.');
});

test('stripQuotedReply: cuts at "Begin forwarded message:" (Apple/iOS Mail)', () => {
  const body = [
    'Sent from my iPhone', '',
    'Begin forwarded message:', '',
    '> From: Chris Cole <chris@example.com>',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Sent from my iPhone');
});

test('stripQuotedReply: cuts at a bare underscore separator line (Outlook desktop)', () => {
  const body = [
    'Last year my son purchased this.', '',
    '________________________________',
    'From: Support <support@example.com>',
    'To: me@example.com',
    'Sent: Monday, August 5, 2013 3:30 PM',
    'Subject: Re: Order',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Last year my son purchased this.');
});

test('stripQuotedReply: a run of underscores shorter than 8 is not treated as a separator', () => {
  const body = 'Fill in the blank: My name is _____ and I approve this message.';
  assert.equal(stripQuotedReply(body), body);
});

test('stripQuotedReply: cuts at an Outlook-style pasted From/Sent/To/Subject header block', () => {
  const body = [
    'Sure, that works.', '',
    'From: Chris Cole <chris@example.com>',
    'Sent: Monday, April 2, 2014 3:45 PM',
    'To: Me <me@example.com>',
    'Subject: Plans', '',
    'Original text goes here.',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Sure, that works.');
});

test('stripQuotedReply: cuts at a run of ">"-quoted lines (plain-text quoting)', () => {
  const body = [
    'Sounds good.', '',
    '> Let me know if that works.',
    '> Thanks in advance.',
  ].join('\n');
  assert.equal(stripQuotedReply(body), 'Sounds good.');
});

test('stripQuotedReply: cuts at a single ">"-quoted line, the shape html-to-text emits for a real <blockquote>', () => {
  // Verified separately against html-to-text itself: a real <blockquote>, even one line long, is
  // rendered as `> `-prefixed text — so this marker alone covers the HTML case with no separate
  // HTML-aware detection needed.
  const body = 'Thanks!\n\n> Quoted content here.';
  assert.equal(stripQuotedReply(body), 'Thanks!');
});

test('stripQuotedReply: cuts cleanly when the reply and the attribution share a paragraph with no blank line between them (real-archive shape)', () => {
  // Regression for a real off-by-one: when the "On ... wrote:" match starts on a line OTHER than
  // the first line of its paragraph (here the paragraph is "Thanks" + the attribution, glued by a
  // single \n with no blank line), the cut used to land one character INTO the match — keeping a
  // stray "O" — because the per-line offset math omitted the joining space's own character. Found
  // during the real-archive verification, not by any single-line-paragraph unit test.
  const body = 'Thanks\nOn Apr 2, 2014 6:00 PM, "Jeremy Davis" <jeremy@example.com> wrote:\n\n>  Chris,\n> So the update at no cost covers all of the following.';
  assert.equal(stripQuotedReply(body), 'Thanks');
});

test('stripQuotedReply: cuts at a long attribution the client wrapped across 2 physical lines within its own paragraph', () => {
  const body = 'i think this is the monitor.\n\nOn Tue, Jan 9, 2018 at 12:55 PM, Kathy Fenwick <kathy.fenwick@example.com>\nwrote:\n\n> Thank you';
  assert.equal(stripQuotedReply(body), 'i think this is the monitor.');
});

test('stripQuotedReply: NEGATIVE — a ">" used as a comparison, the word "wrote", and a header-like line all survive untouched', () => {
  const body = [
    'The results show 5 > 3 clearly, so the budget holds.',
    'I wrote up the notes properly yesterday evening for the team.',
    'Subject: not a real forward, just a note about scheduling for Friday.',
  ].join('\n');
  assert.equal(stripQuotedReply(body), body);
});

test('stripQuotedReply: a single header-like line (no run of 3+) is not treated as a forward block', () => {
  const body = 'Sounds fine.\nSubject: this is just one line, not a real forwarded header block.';
  assert.equal(stripQuotedReply(body), body);
});

test('stripQuotedReply: a message that is entirely quoted content strips to empty, same graceful degradation as an all-signature body', () => {
  const body = [
    'On Apr 2, 2014, at 3:45 PM, Chris Cole <chris@example.com> wrote:', '',
    '> Full original message quoted here.',
  ].join('\n');
  assert.equal(stripQuotedReply(body), '');
});

test('stripQuotedReply: empty/falsy input passes through unchanged', () => {
  assert.equal(stripQuotedReply(''), '');
  assert.equal(stripQuotedReply(null), null);
  assert.equal(stripQuotedReply(undefined), undefined);
});

test('quoteBoundaryFound: true when stripQuotedReply actually changes the text, false otherwise', () => {
  assert.equal(quoteBoundaryFound('hi\n\nOn Apr 2, 2014, Chris wrote:\n> quoted'), true);
  assert.equal(quoteBoundaryFound('just an ordinary reply, no quoting at all'), false);
  assert.equal(quoteBoundaryFound(''), false);
});

test('buildTextRepr: a reply that is entirely quoted degrades to subject-only, no snippet — never the quoted thread', () => {
  const body = [
    'On Apr 2, 2014, at 3:45 PM, Chris Cole <chris@example.com> wrote:', '',
    '> Full original message quoted here.',
  ].join('\n');
  const result = buildTextRepr({ recipients: [{ email: 'c@x.com', name: 'Chris' }], subject: 'Re: Plans', body });
  assert.equal(result, 'Email to Chris: Re: Plans');
});

test('buildTextRepr: applies quote stripping before truncation, so the snippet is the reply, not the quoted thread', () => {
  const body = [
    'i think this is the monitor.', '',
    'On Apr 2, 2014, at 3:45 PM, Chris Cole <chris@example.com> wrote:', '',
    '> So the update at no cost covers all of the following things you might need.',
  ].join('\n');
  const result = buildTextRepr({ recipients: [{ email: 'c@x.com', name: 'Chris' }], subject: 'RE: Benefits', body });
  assert.equal(result, 'Email to Chris: RE: Benefits — i think this is the monitor.');
});

// buildTextRepr composes signature stripping (#368) and quote stripping (#386) by taking whichever
// boundary is EARLIER — proven here with fixtures where naively always preferring one over the other
// would leak the wrong content into text_repr.
test('buildTextRepr: composes signature + quote stripping, always taking the EARLIER boundary', () => {
  const sigEarlier = [
    'fixed', '',
    'Jordan Lee | Support Engineer | m: 555-301-2200 | jordan@example.com', '',
    'This part should never appear since the signature boundary is earlier than the quote boundary below',
    'On Apr 2, 2014, Chris wrote:',
    '> quoted stuff',
  ].join('\n');
  assert.equal(
    buildTextRepr({ recipients: [{ email: 'c@x.com', name: 'Chris' }], subject: 'Re: thing', body: sigEarlier }),
    'Email to Chris: Re: thing — fixed',
  );

  const quoteEarlier = [
    'fixed', '',
    'On Apr 2, 2014, Chris wrote:', '',
    '> This part should never appear since the quote boundary is earlier than the signature boundary below', '',
    'Jordan Lee | Support Engineer | m: 555-301-2200 | jordan@example.com',
  ].join('\n');
  assert.equal(
    buildTextRepr({ recipients: [{ email: 'c@x.com', name: 'Chris' }], subject: 'Re: thing', body: quoteEarlier }),
    'Email to Chris: Re: thing — fixed',
  );
});

test('buildPayload: source_id (hash fallback) is pinned to the raw body, unaffected by quote stripping', async () => {
  // The same #362 hazard signature stripping was checked against: a no-Message-ID message's
  // hash-fallback source_id must be pinned to the RAW body, never the quote-stripped one, or every
  // such message re-keys and creates a permanent duplicate in an append-only store.
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: No message id, has a quote',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000',
    'Content-Type: text/plain; charset=UTF-8', '',
    'fixed', '',
    'On Apr 2, 2014, Chris wrote:', '',
    '> quoted stuff here', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.match(payload.source_id, /^email:msg:sha256:[0-9a-f]{64}$/);

  const { headerText, body: rawBody } = splitMessage(raw);
  const headers = parseHeaders(headerText);
  const expected = sourceIdFor({
    messageId: headers['message-id'], from: headers.from, date: headers.date, subject: headers.subject, body: rawBody,
  });
  assert.equal(payload.source_id, expected, 'source_id must be computed from the raw, unstripped body');
  assert.equal(payload.text_repr, 'Email to Chris: No message id, has a quote — fixed');
});

// --- thread headers + body_full (#386) --------------------------------------------------------
// Design decision: stripping is only non-lossy because the thread is reconstructable by reference
// (in_reply_to/references) and the complete pre-strip body is retained in extra.body_full.

test('parseMessageIdList: parses a whitespace-separated References header into an array of bracketed ids', () => {
  assert.deepEqual(
    parseMessageIdList('<root@example.com> <parent@example.com>'),
    ['<root@example.com>', '<parent@example.com>'],
  );
});

test('parseMessageIdList: absent or unparseable input yields an empty array, never null/undefined', () => {
  assert.deepEqual(parseMessageIdList(''), []);
  assert.deepEqual(parseMessageIdList(undefined), []);
  assert.deepEqual(parseMessageIdList('no angle brackets here'), []);
});

test('buildPayload: captures in_reply_to and references from the parsed headers', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Re: Lunch plans',
    'Date: Mon, 3 Jan 2011 11:00:00 +0000', 'Message-ID: <reply-1@example.com>',
    'In-Reply-To: <lunch-1@example.com>',
    'References: <root@example.com> <lunch-1@example.com>', '',
    'Sounds good.', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.extra.in_reply_to, '<lunch-1@example.com>');
  assert.deepEqual(payload.extra.references, ['<root@example.com>', '<lunch-1@example.com>']);
});

test('buildPayload: omits in_reply_to/references when the headers are absent — never null-filled', async () => {
  const { payload } = await buildPayload({ raw: SENT, sourcePath: null });
  assert.equal('in_reply_to' in payload.extra, false);
  assert.equal('references' in payload.extra, false);
});

// RFC 5322 defines In-Reply-To as 1*msg-id (and permits CFWS), so a raw copy of the header is not
// "the one parent" — it must be parsed the same as References and reduced to the last (parent) id.

test('buildPayload: a multi-id In-Reply-To reduces to the last (parent) id, as a single string', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Re: Lunch plans',
    'Date: Mon, 3 Jan 2011 11:00:00 +0000', 'Message-ID: <reply-2@example.com>',
    'In-Reply-To: <a@x> <b@x>', '',
    'Sounds good.', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.extra.in_reply_to, '<b@x>');
});

test('buildPayload: an In-Reply-To carrying a CFWS comment yields the bare bracketed id', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Re: Lunch plans',
    'Date: Mon, 3 Jan 2011 11:00:00 +0000', 'Message-ID: <reply-3@example.com>',
    'In-Reply-To: (comment) <lunch-1@example.com>', '',
    'Sounds good.', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.extra.in_reply_to, '<lunch-1@example.com>');
});

test('buildPayload: an unparseable/bracketless In-Reply-To omits the key rather than storing it verbatim', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Re: Lunch plans',
    'Date: Mon, 3 Jan 2011 11:00:00 +0000', 'Message-ID: <reply-4@example.com>',
    'In-Reply-To: no angle brackets here', '',
    'Sounds good.', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal('in_reply_to' in payload.extra, false);
});

test('buildPayload: body_full carries the complete decoded body, pre-strip — stripping is reversible', async () => {
  const raw = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Re: Benefits',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <benefits-1@example.com>',
    'Content-Type: text/plain; charset=UTF-8', '',
    'Thanks', '',
    'On Apr 2, 2014, Chris Cole <chris@example.com> wrote:', '',
    '> So the update at no cost covers all of the following.', '',
  ]);
  const { payload } = await buildPayload({ raw, sourcePath: null });
  assert.equal(payload.text_repr, 'Email to Chris: Re: Benefits — Thanks');
  assert.match(payload.extra.body_full, /So the update at no cost covers all of the following/, 'the quoted content must survive in body_full even though it is gone from text_repr');
  assert.match(payload.extra.body_full, /^Thanks/, 'body_full is the complete decoded body, not just the quoted tail');
});

test('buildPayload: reports whether a quote boundary was detected (for the run summary)', async () => {
  const withQuote = crlfJoin([
    'From: Me <me@example.com>', 'To: Chris <chris@example.com>', 'Subject: Re: thing',
    'Date: Mon, 3 Jan 2011 10:00:00 +0000', 'Message-ID: <q1@example.com>', '',
    'ok', '', 'On Apr 2, 2014, Chris wrote:', '', '> quoted', '',
  ]);
  const { quoteBoundary: withQuoteFlag } = await buildPayload({ raw: withQuote, sourcePath: null });
  assert.equal(withQuoteFlag, true);

  const { quoteBoundary: noQuoteFlag } = await buildPayload({ raw: SENT, sourcePath: null });
  assert.equal(noQuoteFlag, false);
});

test('REGRESSION (#405): the resume marker never names a message that was not submitted', async () => {
  // The packer decides fullness BEFORE adding the incoming payload (it must, to keep a batch under
  // the byte budget), so at flush time counts.read has already counted a message destined for the
  // NEXT batch. Writing counts.read as the marker meant an interrupted run resumed PAST that
  // unsubmitted message and never ingested it — silently and permanently, since the mailbox
  // fingerprint is unchanged so the marker never invalidates, and `exists` prevents duplicates, not
  // skips. Asserted by reading the marker at the moment the SECOND batch arrives, because by then
  // the first flush's write has happened and the end-of-run marker would hide the off-by-one.
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');

  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-marker-'));
  const statePath = path.join(store, 'state.json');
  // 51 messages: the 50-item ceiling flushes [1..50] as #51 is pushed, then finish() posts [51].
  let mbox = '';
  for (let i = 1; i <= 51; i++) {
    mbox += 'From - Mon Jan 03 2011\n' + [
      'From: Me <me@example.com>', 'To: Chris <chris@example.com>', `Subject: Msg ${i}`,
      'Date: Mon, 3 Jan 2011 10:00:00 +0000', `Message-ID: <m${i}@example.com>`, '', `body ${i}`, '',
    ].join('\n') + '\n';
  }
  await writeFile(path.join(store, 'Sent'), mbox, 'utf8');

  let postCount = 0;
  let markerAtSecondPost = null;
  const batchSizes = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exists: [] }));
        return;
      }
      const artifacts = JSON.parse(body).artifacts;
      postCount++;
      batchSizes.push(artifacts.length);
      if (postCount === 2) {
        try { markerAtSecondPost = JSON.parse(readFileSync(statePath, 'utf8')).processed; }
        catch { markerAtSecondPost = 'unreadable'; }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: artifacts.map(() => ({ id: 1 })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
      EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
      EMAIL_STATE_PATH: statePath, EMAIL_SPOOL_DIR: path.join(store, 'spool'),
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((res) => server.close(res));

  assert.equal(code, 0, `the run must succeed; stderr: ${stderr}`);
  assert.deepEqual(batchSizes, [50, 1], 'the item ceiling must yield a 50-item batch then a 1-item batch');
  assert.equal(markerAtSecondPost, 50,
    'the marker after the first flush must name message 50 (the last SUBMITTED one), not 51 — 51 would make an interrupted run skip message 51 forever');
});

test('flushSpool packs by file size and parses lazily, so one corrupt spool file cannot strand the rest (#405)', async () => {
  // Batching on PARSED payloads meant the whole spool was JSON.parsed before the first batch was
  // sent: memory scaled with the backlog (extra.body_full is uncapped), and one unparseable file
  // threw before any batch flushed. Packing by on-disk size — byte-identical to the serialized
  // payload — keeps a single batch resident and isolates a bad file to its own batch.
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');

  const store = await mkdtemp(path.join(tmpdir(), 'lc-email-lazyspool-'));
  await writeFile(path.join(store, 'Sent'), `From - Mon Jan 03 2011\n${MSG_A}\n`, 'utf8');
  const spoolDir = path.join(store, 'spool');
  await mkdir(spoolDir, { recursive: true });
  // 50 good files + 1 corrupt, named so readdir's alphabetical order puts the corrupt one in the
  // SECOND batch (s* sorts before z*), i.e. after a full 50-item first batch.
  for (let i = 0; i < 50; i++) {
    await writeFile(path.join(spoolDir, `s${String(i).padStart(2, '0')}.json`), JSON.stringify({
      source: 'email', source_id: `email:msg:spooled-${i}@example.com`, type: 'email', text_repr: `spooled ${i}`,
    }), 'utf8');
  }
  await writeFile(path.join(spoolDir, 'zz-corrupt.json'), 'this is not json at all', 'utf8');

  const posted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/exists') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exists: [] }));
        return;
      }
      const artifacts = JSON.parse(body).artifacts;
      posted.push(...artifacts.map((a) => a.source_id));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: artifacts.map(() => ({ id: 1 })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env, LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key-not-the-placeholder',
      EMAIL_STORE_PATH: store, EMAIL_SENT_FOLDER: 'Sent', EMAIL_SINCE: '2010-01-01',
      EMAIL_STATE_PATH: path.join(store, 'state.json'), EMAIL_SPOOL_DIR: spoolDir,
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((res) => server.close(res));

  assert.equal(code, 0, `the run must succeed; stderr: ${stderr}`);
  assert.match(stderr, /flushed 50 spooled payloads/, 'the 50 parseable spooled payloads must flush despite the corrupt sibling');
  assert.match(stderr, /spool flush failed for a batch of 1/, 'the corrupt file must fail alone, in its own batch');
  assert.ok(posted.includes('email:msg:a@example.com'), 'new mail must still be read after the partial spool flush');

  const left = (await readdir(spoolDir)).filter((f) => f.endsWith('.json'));
  assert.deepEqual(left, ['zz-corrupt.json'], 'only the corrupt file stays behind — the 50 good ones are unlinked, never re-sent forever');
});
