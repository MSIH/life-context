// UI capability-URL gate (#161), the SET case. UI_URL_TOKEN is read from config once at module
// load, and server.test.mjs already boots the app with it UNSET in this same process — so the
// gated path needs a SEPARATE process. This file spawns `node src/server.js` as a child with
// UI_URL_TOKEN set on a fresh temp DB + free port, then drives it over real HTTP. No Ollama is
// needed: only static /ui routes and the auth gate (which runs before any embedding) are exercised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const API_KEY = 'test-key-0123456789-not-the-placeholder';
const UI_TOKEN = 'ui-token-abcdef0123456789-capability';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '..', 'src', 'server.js');

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

let child, base, dbDir;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dbDir = mkdtempSync(path.join(tmpdir(), 'lc-ui-token-'));
  // cwd = the temp dir so config.js's dotenv.config() finds no .env to override our explicit env.
  child = spawn(process.execPath, [serverPath], {
    cwd: dbDir,
    env: {
      ...process.env,
      LIFECONTEXT_API_KEY: API_KEY,
      UI_URL_TOKEN: UI_TOKEN,
      DB_PATH: path.join(dbDir, 'ui-token.db'),
      CONTACTS_RAW_DIR: path.join(dbDir, 'raw'),
      PORT: String(port),
      OLLAMA_BASE_URL: 'http://127.0.0.1:1/v1', // never contacted by these routes
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { if (process.env.DEBUG_UI_TOKEN) process.stderr.write(d); });
  // Boot is signaled by the listen log line; fail fast if the child dies first.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server child did not boot within 15s')), 15000);
    child.stdout.on('data', (d) => { if (/operating on port/.test(String(d))) { clearTimeout(t); resolve(); } });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server child exited early (code ${code})`)); });
  });
});

after(async () => {
  if (child && child.exitCode === null) { child.kill(); await new Promise((r) => child.on('exit', r)); }
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
});

const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });

test('UI gated: /<token>/ui/chat.html → 200 with NO api-key bar, and serves the asset under the tokened path', async () => {
  const page = await get(`/${UI_TOKEN}/ui/chat.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  const html = await page.text();
  assert.match(html, /LifeContext/, 'the page HTML is served under the tokened mount');
  // Token-only (#169): the API-key bar markup is gone — no manual-key input/Save/🔑 remain.
  for (const id of ['keyBar', 'keyInput', 'keySave', 'keyEdit']) {
    assert.ok(!html.includes(`id="${id}"`), `no #${id} in the token-only page`);
  }
  assert.ok(!html.includes('🔑'), 'no 🔑 change-key button in the token-only page');
  // A relative asset (./chat.js from the HTML) must resolve under /<token>/ui/ too — proves the
  // mount strips the token prefix so express.static finds the file.
  const asset = await get(`/${UI_TOKEN}/ui/chat.js`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /apiKey/, 'the JS asset loads under the token path');
});

test('UI gated: bare /ui and a wrong token both 404 (existence hidden)', async () => {
  assert.equal((await get('/ui/chat.html')).status, 404, 'bare /ui 404s when a token is set');
  assert.equal((await get(`/wrong-token/ui/chat.html`)).status, 404, 'a wrong token 404s');
});

test('/api accepts UI_URL_TOKEN as an alternative credential; wrong token still 401', async () => {
  // /api/v1/ingest/types returns 200 without touching Ollama, so it isolates the auth decision.
  assert.equal((await get('/api/v1/ingest/types', { 'x-api-key': UI_TOKEN })).status, 200, 'UI token authorizes /api');
  assert.equal((await get('/api/v1/ingest/types', { 'x-api-key': API_KEY })).status, 200, 'the primary key still authorizes');
  assert.equal((await get('/api/v1/ingest/types', { 'x-api-key': 'nope' })).status, 401, 'a wrong token is still 401');
  assert.equal((await get('/api/v1/ingest/types')).status, 401, 'no token is still 401');
});
