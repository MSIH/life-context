// Embedding egress guard (#347): OLLAMA_BASE_URL is deliberately env-overridable and every stored
// text passes through it, so a non-loopback endpoint has to be opted into with EMBEDDING_ALLOW_REMOTE.
// The pure helper is unit-tested directly; enforcement is checked by importing src/embeddings.js in a
// CHILD process, because config.js reads the environment once at import and cannot be re-parameterized
// in-process. The permissive cases matter as much as the refusals here — a guard that also rejects a
// valid loopback URL would refuse to start a correctly-configured server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isLoopbackUrl } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dotenv never overrides an already-set variable, so what we pass here wins over any local .env
// (and the suite must pass in CI, where no .env exists at all). Events logging off so this writes
// nothing to logs/. Importing embeddings.js makes no network call — it only constructs the client.
const importEmbeddings = (env) => spawnSync(
  process.execPath,
  ['-e', 'import("./src/embeddings.js").then(() => console.log("IMPORT_OK"))'],
  {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, EVENTS_LOG_ENABLED: 'false', EMBEDDING_ALLOW_REMOTE: '', ...env },
  },
);

test('isLoopbackUrl: accepts localhost, 127.0.0.0/8 and ::1, in any case, with port or path', () => {
  assert.equal(isLoopbackUrl('http://localhost:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://LOCALHOST:11434/v1'), true);
  assert.equal(isLoopbackUrl('https://localhost'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://127.1.2.3/v1'), true);
  assert.equal(isLoopbackUrl('http://[::1]:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://[0:0:0:0:0:0:0:1]:11434/v1'), true); // URL compresses to [::1]
});

// These reach the local host, so refusing them would break a working install rather than prevent
// egress — the guard is about data leaving the machine, not about a preferred spelling.
test('isLoopbackUrl: accepts the unspecified addresses and the FQDN trailing-dot form', () => {
  assert.equal(isLoopbackUrl('http://0.0.0.0:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://[::]:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://localhost.:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1.:11434/v1'), true);
});

test('isLoopbackUrl: rejects any off-box host, including a LAN address', () => {
  assert.equal(isLoopbackUrl('https://api.openai.com/v1'), false);
  assert.equal(isLoopbackUrl('http://10.0.0.5:11434/v1'), false);
  assert.equal(isLoopbackUrl('http://192.168.1.5:11434/v1'), false); // same house, still off this box
  assert.equal(isLoopbackUrl('http://embeddings.internal/v1'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.example.com/v1'), false); // not a 127/8 address
});

test('isLoopbackUrl: fails closed on anything it cannot parse', () => {
  assert.equal(isLoopbackUrl('not a url'), false);
  assert.equal(isLoopbackUrl('localhost:11434/v1'), false); // no scheme — parses, but hostname is empty
  assert.equal(isLoopbackUrl(''), false);
  assert.equal(isLoopbackUrl(undefined), false);
});

test('a non-loopback endpoint refuses to load, naming both variables', () => {
  const r = importEmbeddings({ OLLAMA_BASE_URL: 'https://api.example.com/v1' });
  assert.notEqual(r.status, 0, 'import must fail');
  assert.ok(!r.stdout.includes('IMPORT_OK'), 'module must not finish loading');
  assert.match(r.stderr, /OLLAMA_BASE_URL/);
  assert.match(r.stderr, /EMBEDDING_ALLOW_REMOTE/);
});

test('EMBEDDING_ALLOW_REMOTE=true permits the same non-loopback endpoint', () => {
  const r = importEmbeddings({ OLLAMA_BASE_URL: 'https://api.example.com/v1', EMBEDDING_ALLOW_REMOTE: 'true' });
  assert.equal(r.status, 0, `import should succeed; stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes('IMPORT_OK'));
});

test('a loopback endpoint loads normally — the guard does not break a correct install', () => {
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1']) {
    const r = importEmbeddings({ OLLAMA_BASE_URL: url });
    assert.equal(r.status, 0, `${url} should load; stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('IMPORT_OK'), `${url} should load`);
  }
});

test('an unparseable endpoint refuses to load rather than being treated as local', () => {
  const r = importEmbeddings({ OLLAMA_BASE_URL: 'not-a-url' });
  assert.notEqual(r.status, 0);
  assert.ok(!r.stdout.includes('IMPORT_OK'));
});
