// Runs index.js end-to-end against a mock LifeContext /api/search server (no real network, no
// server dependency). Covers: preferences returned and printed to stdout, an empty result set
// printing nothing, an unreachable server exiting 0 silently, a malformed response exiting 0
// silently, the request shape sent to /api/search (types filter + generous limit), a missing API
// key never making a network call, and README.md's documented SessionStart wiring naming all five
// matchers (startup|resume|clear|compact|fork). Mirrors gh-event-claude/test.mjs and
// devsession-claude/test.mjs's harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'index.js');

function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      (handler ?? ((_req, _body, res2) => res2.end('{}')))(req, parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

// Async spawn, not spawnSync: the child talks to the mock server running on THIS process's event
// loop, so a synchronous spawn here would deadlock (same reasoning as the sibling connectors).
function runHook(hookInput, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX_PATH], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(JSON.stringify(hookInput ?? {}));
    child.stdin.end();
  });
}

test('preferences returned by /api/search are printed to stdout, one per line, exit 0', async () => {
  const { server, port, requests } = await startMockServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      results: [
        { id: 1, text_repr: 'Prefer tables over prose in status updates.' },
        { id: 2, display_text: 'Report issues/PRs as full clickable URLs.', text_repr: 'stale text' },
      ],
    }));
  });

  const result = await runHook({ source: 'startup' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
  });
  server.close();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /tables over prose in status updates/);
  // display_text preferred over text_repr when both are present (#147's read-time field).
  assert.match(result.stdout, /Report issues\/PRs as full clickable URLs\./);
  assert.doesNotMatch(result.stdout, /stale text/);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/search');
  assert.equal(requests[0].headers['x-api-key'], 'test-key');
  assert.deepEqual(requests[0].body.types, ['x-agent-preference']);
  // 50 is /api/search's own hard cap (src/server.js's limitSchema) — the default IS that cap, so
  // every stored preference comes back without risking a 400 from asking for more than allowed.
  assert.equal(requests[0].body.limit, 50);
  assert.ok(typeof requests[0].body.query === 'string' && requests[0].body.query.length > 0);
  // #433 — this is the whole point of the change: without it, session start silently regresses to
  // the ~7-9s planner-on cost with a green test (the connector prints nothing either way on
  // failure, so this assertion is the only thing that can catch a dropped/misspelled flag).
  assert.equal(requests[0].body.use_planner, false);
});

test('a multi-line preference collapses to one bullet line', async () => {
  // Exactly the shape scripts/migrate-preferences.js writes: the original text, a blank line, then
  // the "(Supersedes artifact N.)" trailer. Every migrated preference looks like this, so without
  // collapsing, the trailer would render as its own unbulleted item in session context.
  const { server, port } = await startMockServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      results: [{ id: 1, text_repr: 'Prefer tables over prose.\n\n(Supersedes artifact 210533.)' }],
    }));
  });

  const result = await runHook({ source: 'startup' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
  });
  server.close();

  assert.equal(result.status, 0);
  const body = result.stdout.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(body.length, 1, 'one preference must produce exactly one bullet line');
  assert.equal(body[0], '- Prefer tables over prose. (Supersedes artifact 210533.)');
});

test('empty results: nothing printed, exit 0', async () => {
  const { server, port } = await startMockServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: [] }));
  });

  const result = await runHook({ source: 'clear' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
  });
  server.close();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('server unreachable: exit 0, silent stdout', async () => {
  // Nothing is listening on this port — fetch() rejects with a connection error.
  const result = await runHook({ source: 'resume' }, {
    LIFECONTEXT_URL: 'http://127.0.0.1:1', // port 1 is reserved/unused, connection refused fast
    LIFECONTEXT_API_KEY: 'test-key',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('non-2xx response: exit 0, silent stdout', async () => {
  const { server, port } = await startMockServer((_req, _body, res) => {
    res.statusCode = 500;
    res.end('internal error');
  });

  const result = await runHook({ source: 'compact' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
  });
  server.close();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('malformed response body (not JSON): exit 0, silent stdout', async () => {
  const { server, port } = await startMockServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{not valid json');
  });

  const result = await runHook({ source: 'fork' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
  });
  server.close();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('malformed response shape (results not an array): exit 0, silent stdout', async () => {
  const { server, port } = await startMockServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: 'not-an-array' }));
  });

  const result = await runHook({ source: 'startup' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
  });
  server.close();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('no API key resolved anywhere: no network call, exit 0, silent stdout', async () => {
  const { server, port, requests } = await startMockServer();

  // An empty string (not a deleted var) deterministically exercises "no key resolvable
  // anywhere" regardless of what's really on this machine's ~/.life-context/.env or the
  // primary worktree's .env: resolveConfig()'s applyEnvFile only fills a STILL-UNSET key
  // (`process.env[key] === undefined`), and an already-present empty string is not undefined,
  // so no fallback file can override it. Mirrors gh-event-claude/test.mjs's equivalent test.
  const result = await runHook({ source: 'startup' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: '',
  });
  server.close();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(requests.length, 0, 'a missing API key must short-circuit before any network call');
});

test('placeholder API key is treated as unset: no network call, exit 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook({ source: 'startup' }, {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'change-this-to-a-long-secure-token',
  });
  server.close();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(requests.length, 0);
});

test('README.md documents the SessionStart wiring with all five matchers', () => {
  const readme = readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  assert.match(readme, /startup\|resume\|clear\|compact\|fork/);
  for (const trigger of ['startup', 'resume', 'clear', 'compact', 'fork']) {
    assert.ok(readme.includes(trigger), `README.md should mention the "${trigger}" SessionStart matcher`);
  }
});
