// Runs index.js end-to-end against a mock LifeContext ingest server (no real network, no LLM).
// Covers: Bash `gh issue create` stdout parse, MCP create_pull_request JSON parse, html_url
// preference, issue_write update -> no ingest, no-URL -> no ingest, PR merge capture (Bash `gh pr
// merge` shorthand + MCP merge_pull_request, keyed #merged; underivable-ref -> no ingest), the
// config-resolution fallback to a primary worktree's .env (#324), gh-pr-view merge verification
// on a non-zero exit code (#324), no-key-anywhere -> spool (#324), and cost instrumentation on a
// merge event (#377): usage summed + deduped across transcript turns, model/effort extraction,
// per-model pricing, attempt count from real commit history, and graceful degradation when the
// transcript is missing/unreadable.
// Mirrors devsession-claude/test.mjs's harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_INDEX_PATH = path.join(__dirname, 'index.js');

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
// loop, so a synchronous spawn here would deadlock (same reasoning as devsession-claude/test.mjs).
function runHookAt(scriptPath, hookInput, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

function runHook(hookInput, env) {
  return runHookAt(REAL_INDEX_PATH, hookInput, env);
}

// Same as runHookAt, but strips LIFECONTEXT_URL/LIFECONTEXT_API_KEY out of the AMBIENT
// environment first (unlike runHookAt's plain `{...process.env, ...env}`, where an ambient value
// would silently satisfy resolveConfig() before its fallback chain ever runs) — for a test that
// must prove a key resolves from a fallback file, not from whatever happens to be exported in the
// shell running the test.
function runHookIsolated(scriptPath, hookInput, env) {
  const isolatedEnv = { ...process.env };
  delete isolatedEnv.LIFECONTEXT_URL;
  delete isolatedEnv.LIFECONTEXT_API_KEY;
  Object.assign(isolatedEnv, env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { env: isolatedEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

// Builds a throwaway PRIMARY git checkout with a real `connectors/gh-event-claude/.env`, plus a
// `git worktree add` off it, and copies THIS connector's real index.js into the worktree's own
// connectors/gh-event-claude/ (a worktree checkout never carries the gitignored .env — mirrors
// every real branch in this repo, per its mandatory workflow). resolveConfig()'s `git
// rev-parse` runs with cwd = the script's OWN directory (import.meta.url), so running the copy
// from inside this fake worktree resolves the FAKE primary — fully isolated from whatever the
// developer's real repo/.env actually contains.
function buildFakeWorktreeWithPrimaryEnv(envContents) {
  const base = mkdtempSync(path.join(tmpdir(), 'gh-event-fakewt-'));
  const primary = path.join(base, 'primary');
  mkdirSync(primary, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args, cwd) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main'], primary);
  writeFileSync(path.join(primary, 'README.md'), 'fake primary checkout for gh-event-claude tests\n');
  git(['add', '-A'], primary);
  git(['commit', '-q', '-m', 'init'], primary);

  mkdirSync(path.join(primary, 'connectors', 'gh-event-claude'), { recursive: true });
  writeFileSync(path.join(primary, 'connectors', 'gh-event-claude', '.env'), envContents);

  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', worktree, '-b', 'wt-branch'], primary);

  const wtConnectorDir = path.join(worktree, 'connectors', 'gh-event-claude');
  mkdirSync(wtConnectorDir, { recursive: true });
  const wtIndexPath = path.join(wtConnectorDir, 'index.js');
  copyFileSync(REAL_INDEX_PATH, wtIndexPath);

  return { base, indexPath: wtIndexPath };
}

// Windows: mergeSucceeded()'s `execFile('gh', ['pr', 'view', ...])` call has no `shell` option,
// and Node's child_process (the CVE-2024-27980 fix, present in every Node version this repo's CI
// matrix runs) refuses to spawn a resolved `.cmd`/`.bat` target without `shell:true`; a POSIX
// shebang script fares no better. So on win32 the only format Node's non-shell resolution can
// launch directly is a genuine PE `.exe` — compiled on the fly with the .NET Framework's
// `csc.exe`, at this fixed path on every supported Windows Server / GitHub Actions windows-2022
// image (the same toolchain ci.yml's better-sqlite3 native rebuild already depends on).
const CSC_PATH = process.platform === 'win32'
  ? [
      ['Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'],
      ['Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'],
    ]
      .map((parts) => path.join(process.env.SystemRoot ?? 'C:\\Windows', ...parts))
      .find((p) => existsSync(p)) ?? null
  : null;

// Stub `gh` on a fresh temp dir prepended to PATH, so mergeSucceeded()'s `gh pr view --json state
// --jq .state` resolves to it instead of a real `gh` CLI. Ignores its arguments and prints the
// given PR state, mimicking that command's bare-string output.
function writeStubGhDir(state) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-event-stub-gh-'));
  if (process.platform === 'win32') {
    if (!CSC_PATH) throw new Error('writeStubGhDir: no csc.exe found to build the Windows gh.exe stub');
    const source = `class StubGh { static int Main() { System.Console.WriteLine("${state}"); return 0; } }`;
    const srcPath = path.join(dir, 'StubGh.cs');
    writeFileSync(srcPath, source);
    execFileSync(CSC_PATH, ['/nologo', `/out:${path.join(dir, 'gh.exe')}`, srcPath]);
    return dir;
  }
  const scriptPath = path.join(dir, 'gh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\necho "${state}"\n`);
  chmodSync(scriptPath, 0o755);
  return dir;
}

// Builds a REAL git repo (#377) with a faked `origin/main` remote-tracking ref + symbolic HEAD --
// no actual remote/push needed, since attemptCount()/resolveDefaultBranch() only ever read local
// refs -- then checks out a `feature` branch with `commitCount` additional commits on top, so
// `git rev-list --count origin/main..HEAD` resolves deterministically to `commitCount`.
function buildFakeRepoWithCommits(commitCount) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-event-repo-'));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) => execFileSync('git', args, { cwd: dir, env: gitEnv, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'README.md'), 'main\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const mainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: gitEnv, encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/remotes/origin/main', mainSha]);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  git(['checkout', '-q', '-b', 'feature']);
  for (let i = 0; i < commitCount; i++) {
    writeFileSync(path.join(dir, `file${i}.txt`), `${i}\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', `commit ${i}`]);
  }
  return dir;
}

// A real git repo (#422) with `origin` set to `originUrl` but no tracking-ref setup (unlike
// buildFakeRepoWithCommits, which fakes origin/main for attempt-count tests) — all
// resolveMergeRef's bare-PR-number fallback needs is `git config --get remote.origin.url`.
function buildFakeRepoWithOrigin(originUrl) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-event-origin-'));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) => execFileSync('git', args, { cwd: dir, env: gitEnv, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'README.md'), 'fake repo with origin for gh-event-claude tests\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  git(['remote', 'add', 'origin', originUrl]);
  return dir;
}

// One assistant-turn JSONL entry matching the real Claude Code transcript shape: usage lives at
// message.usage, model at message.model, effort at the entry's OWN top level (a sibling of
// "message", not nested inside it) -- verified against a real ~/.claude/projects/*.jsonl transcript.
//
// `cacheCreation`, when given, is the real transcript's per-TTL breakdown of the cache-write
// total: message.usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens. Omitting it
// models an older transcript that reports only cache_creation_input_tokens.
function assistantTurn({ messageId, model, effort, usage, cacheCreation }) {
  const usageBlock = cacheCreation ? { ...usage, cache_creation: cacheCreation } : usage;
  return {
    type: 'assistant',
    message: { id: messageId, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage: usageBlock },
    effort,
  };
}

// The recorded usage object always carries the two per-TTL cache-write fields, which are zero
// when the fixture supplied no `cache_creation` breakdown. Expected-value helper so a fixture
// literal (the four wire fields) can be compared against a recorded tally without restating them.
function withTtlZeros(usage) {
  return { ...usage, cache_creation_5m_input_tokens: 0, cache_creation_1h_input_tokens: 0 };
}

// Writes a fixture transcript (one JSON object per line) to a fresh temp dir and returns its path.
function writeTranscriptFixture(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-event-transcript-'));
  const transcriptPath = path.join(dir, 'session.jsonl');
  writeFileSync(transcriptPath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return transcriptPath;
}

test('Bash `gh issue create`: parses the issue URL + title from stdout/command, ingests an x-dev-event, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --repo ACME/example-repo --title "capture gh events" --label enhancement' },
      tool_response: { stdout: 'https://github.com/ACME/example-repo/issues/89\n', stderr: '' },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source, 'gh-event-claude');
  assert.equal(payload.source_id, 'https://github.com/ACME/example-repo/issues/89');
  assert.equal(payload.type, 'x-dev-event');
  assert.equal(payload.extra.kind, 'issue');
  assert.equal(payload.extra.number, 89);
  assert.equal(payload.extra.repo, 'ACME/example-repo');
  assert.match(payload.text_repr, /issue #89 "capture gh events" in ACME\/example-repo/);
});

test('MCP create_pull_request: parses html_url + title from the structured response, kind=pr, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { owner: 'ACME', repo: 'example-repo', title: 'wire it up' },
      tool_response: { html_url: 'https://github.com/ACME/example-repo/pull/90', number: 90, title: 'wire it up' },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/ACME/example-repo/pull/90');
  assert.equal(payload.extra.kind, 'pr');
  assert.equal(payload.extra.number, 90);
  assert.match(payload.text_repr, /pull request #90 "wire it up" in ACME\/example-repo/);
});

test('MCP response with a body link to another issue: prefers html_url, not the first URL in the blob', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { owner: 'ACME', repo: 'example-repo', title: 'wire it up' },
      // body references issue #5 by full URL; html_url (the created PR) is #90 — the capture must
      // key on html_url, not the first github URL it can find.
      tool_response: {
        body: 'Fixes https://github.com/ACME/example-repo/issues/5',
        html_url: 'https://github.com/ACME/example-repo/pull/90',
        number: 90,
        title: 'wire it up',
      },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/pull/90');
  assert.equal(requests[0].body.extra.kind, 'pr');
  assert.equal(requests[0].body.extra.number, 90);
});

test('MCP issue_write update: has an issue html_url but method=update -> no ingest, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      // issue_write handles create AND update; an update still returns the issue's html_url, so
      // without the method guard it would be mis-recorded as "Opened GitHub issue…". Must not ingest.
      tool_name: 'mcp__github__issue_write',
      tool_input: { method: 'update', owner: 'ACME', repo: 'example-repo', issue_number: 89, title: 'edited title' },
      tool_response: { html_url: 'https://github.com/ACME/example-repo/issues/89', number: 89, title: 'edited title' },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'an issue_write update must not be captured as an Opened event');
});

test('MCP issue_write create: method=create is captured as an x-dev-event, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__issue_write',
      tool_input: { method: 'create', owner: 'ACME', repo: 'example-repo', title: 'new via issue_write' },
      tool_response: { html_url: 'https://github.com/ACME/example-repo/issues/92', number: 92, title: 'new via issue_write' },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'an issue_write create must be captured');
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/issues/92');
  assert.equal(requests[0].body.extra.kind, 'issue');
  assert.equal(requests[0].body.extra.number, 92);
});

test('no issue/PR URL in the tool result -> no ingest, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --repo ACME/example-repo --title "boom"' },
      tool_response: { stdout: '', stderr: 'GraphQL: something failed', exit_code: 1 },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'a create with no resulting URL must not ingest anything');
});

test('Bash `gh pr merge`: reconstructs the URL from the "owner/repo#N" shorthand, records a Merged event keyed #merged', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 164 --squash' },
      // gh pr merge prints no full URL — only the "owner/repo#N" shorthand.
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#164\n', stderr: '' },
      cwd: '/tmp/some-project', // non-git → branch resolves null, text_repr deterministic
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/ACME/example-repo/pull/164#merged', 'merge keys on a distinct #merged source_id, not the bare URL');
  assert.equal(payload.extra.action, 'merged');
  assert.equal(payload.extra.kind, 'pr');
  assert.equal(payload.extra.number, 164);
  assert.equal(payload.extra.url, 'https://github.com/ACME/example-repo/pull/164', 'extra.url stays the bare PR URL');
  assert.match(payload.text_repr, /^Merged GitHub pull request #164 in ACME\/example-repo\. /);
});

test('MCP merge_pull_request: builds the URL from {owner, repo, pullNumber}, Merged event keyed #merged', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'ACME', repo: 'example-repo', pullNumber: 170, merge_method: 'squash' },
      tool_response: { sha: 'deadbeef', merged: true },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/ACME/example-repo/pull/170#merged');
  assert.equal(payload.extra.action, 'merged');
  assert.equal(payload.extra.number, 170);
  assert.match(payload.text_repr, /^Merged GitHub pull request #170 in ACME\/example-repo\. /);
});

test('`gh pr create` whose title contains "gh pr merge" is an Opened event, not a merge', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      // the phrase appears inside the quoted title — it must NOT be treated as a merge command.
      tool_input: { command: 'gh pr create --repo ACME/example-repo --title "document gh pr merge capture"' },
      tool_response: { stdout: 'https://github.com/ACME/example-repo/pull/168\n', stderr: '' },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.extra.action, 'opened', 'a create with the phrase in its title stays an open');
  assert.equal(payload.source_id, 'https://github.com/ACME/example-repo/pull/168', 'keyed on the bare URL, not #merged');
  assert.match(payload.text_repr, /^Opened GitHub pull request #168 /);
});

test('MCP merge with snake_case pull_number: accepted (not silently skipped)', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'ACME', repo: 'example-repo', pull_number: 171 }, // snake_case variant
      tool_response: { merged: true },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'a snake_case pull_number must still be captured');
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/pull/171#merged');
  assert.equal(requests[0].body.extra.number, 171);
});

test('MCP merge_pull_request returning { merged: false } -> no ingest (failed merge not recorded), exits 0', async () => {
  const { server, port, requests } = await startMockServer();
  const result = await runHook(
    {
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'ACME', repo: 'example-repo', pullNumber: 172, merge_method: 'squash' },
      tool_response: { merged: false, message: 'Pull Request is not mergeable' }, // blocked/conflicting
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'a { merged: false } response records nothing (Copilot #168)');
});

test('Bash `gh pr merge` non-zero exit_code, `gh pr view` reports OPEN -> no ingest (genuinely not merged), exits 0', async () => {
  const { server, port, requests } = await startMockServer();
  const stubGhDir = writeStubGhDir('OPEN');
  const result = await runHook(
    {
      tool_name: 'Bash',
      // The command names the PR, and resolveMergeRef reads toolInput.command — so without the
      // gh-pr-view verification this failed merge would still be recorded.
      tool_input: { command: 'gh pr merge 173 --squash --repo ACME/example-repo' },
      tool_response: { stdout: '', stderr: 'X Pull request ACME/example-repo#173 is not mergeable', exit_code: 1 },
      // A REAL existing (non-git) directory, unlike the other tests' fake '/tmp/some-project':
      // mergeSucceeded()'s `gh pr view` verification call needs a working `cwd` to spawn in at
      // all (a nonexistent cwd fails the spawn itself, independent of PATH/the stub); `tmpdir()`
      // is real but not a git repo, so `currentBranch()` still deterministically resolves null.
      cwd: tmpdir(),
    },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
      LIFECONTEXT_API_KEY: 'test-key',
      PATH: `${stubGhDir}${path.delimiter}${process.env.PATH}`,
    },
  );
  server.closeAllConnections();
  server.close();
  rmSync(stubGhDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'gh pr view reporting OPEN means the merge genuinely did not happen (#324)');
  assert.match(result.stderr, /gh pr view reports OPEN/);
});

test('Bash `gh pr merge` non-zero exit_code, `gh pr view` confirms MERGED -> records the merge anyway (#324, defect (b))', async () => {
  const { server, port, requests } = await startMockServer();
  const stubGhDir = writeStubGhDir('MERGED');
  const result = await runHook(
    {
      tool_name: 'Bash',
      // `--delete-branch` failed because a worktree still holds the branch — the NORMAL case in
      // this repo (every branch is worked in its own worktree) — even though the merge itself
      // succeeded. The old exit-code-only check silently dropped this; gh-pr-view verification
      // must record it.
      tool_input: { command: 'gh pr merge 323 --squash --delete-branch --repo ACME/example-repo' },
      tool_response: {
        // The merge itself printed its normal success line to stdout BEFORE `--delete-branch`
        // failed (stderr) — resolveMergeRef needs this shorthand to name the PR at all.
        stdout: '✓ Squashed and merged pull request ACME/example-repo#323\n',
        stderr: 'failed to delete local branch fix/319-...: cannot delete branch used by worktree',
        exit_code: 1,
      },
      cwd: tmpdir(), // real (non-git) directory — see the OPEN test above for why
    },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
      LIFECONTEXT_API_KEY: 'test-key',
      PATH: `${stubGhDir}${path.delimiter}${process.env.PATH}`,
    },
  );
  server.closeAllConnections();
  server.close();
  rmSync(stubGhDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'a confirmed MERGED state must still record the event despite the non-zero exit code');
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/ACME/example-repo/pull/323#merged');
  assert.equal(payload.extra.action, 'merged');
  assert.equal(payload.extra.number, 323);
});

test('Bash `gh pr merge <n>`: no owner/repo#N anywhere in stdout/stderr (the non-TTY repro, #422) — resolves via cwd\'s origin remote and captures', async () => {
  const { server, port, requests } = await startMockServer();
  const repoDir = buildFakeRepoWithOrigin('https://github.com/ACME/example-repo.git');

  const result = await runHook(
    {
      // The exact repro shape from #422: a real `gh pr merge <n>` under the Claude Code tool
      // runner prints NEITHER a full URL NOR the "owner/repo#N" shorthand confirmation line.
      tool_name: 'PowerShell',
      tool_input: { command: 'gh pr merge 397 --squash --delete-branch' },
      tool_response: { stdout: '', stderr: '', interrupted: false },
      cwd: repoDir,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(repoDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'the bare PR number + cwd origin must resolve where every other strategy misses');
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/ACME/example-repo/pull/397#merged');
  assert.equal(payload.extra.action, 'merged');
  assert.equal(payload.extra.number, 397);
  assert.equal(payload.extra.repo, 'ACME/example-repo');
  assert.doesNotMatch(result.stderr, /could not resolve merged PR ref/);
});

test('Bash `gh pr merge <n>`: an origin using an SSH Host alias (not literal github.com) still resolves (#422)', async () => {
  const { server, port, requests } = await startMockServer();
  // This repo's own `origin` is exactly this shape -- `git@msih:ACME/example-repo.git`, an SSH
  // config Host alias for juggling multiple GitHub accounts on one box -- so a parse anchored to
  // a literal "github.com" would miss the very remote this fix is verified against.
  const repoDir = buildFakeRepoWithOrigin('git@msih:ACME/example-repo.git');

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 398 --squash' },
      tool_response: { stdout: '', stderr: '' },
      cwd: repoDir,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(repoDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/pull/398#merged');
  assert.equal(requests[0].body.extra.repo, 'ACME/example-repo');
});

test('Bash `gh pr merge <branch-name>` (non-numeric argument): does not guess a PR number even with a resolvable origin (#422)', async () => {
  const { server, port, requests } = await startMockServer();
  const repoDir = buildFakeRepoWithOrigin('https://github.com/ACME/example-repo.git');

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge some-branch-name --squash' }, // not a PR number
      tool_response: { stdout: '', stderr: '' },
      cwd: repoDir,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(repoDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'a non-numeric gh pr merge argument must not be guessed at as a PR number');
  assert.match(result.stderr, /could not resolve merged PR ref/);
});

test('negative (#422): `gh pr create` sharing a cwd with a real origin remote is still an Opened event, never reclassified as a merge', async () => {
  const { server, port, requests } = await startMockServer();
  const repoDir = buildFakeRepoWithOrigin('https://github.com/ACME/example-repo.git');

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --repo ACME/example-repo --title "unaffected by #422"' },
      tool_response: { stdout: 'https://github.com/ACME/example-repo/pull/399\n', stderr: '' },
      cwd: repoDir,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(repoDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.extra.action, 'opened', 'a create must never be reclassified as a merge');
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/pull/399', 'keyed on the bare URL, not #merged');
});

test('merge with no derivable PR ref (no number/repo anywhere) -> no ingest, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge --squash' }, // current-branch merge, no number; nothing to key on
      tool_response: { stdout: '', stderr: '' },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'an undecipherable merge must not ingest anything');
  assert.match(result.stderr, /could not resolve merged PR ref/);
});

test('no resolvable API key anywhere -> spools the event instead of dropping it, exits 0 (#324)', async () => {
  const { server, port, requests } = await startMockServer();
  const spoolDir = mkdtempSync(path.join(tmpdir(), 'gh-event-spool-'));
  const spoolPath = path.join(spoolDir, 'spool.jsonl');

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --title "x"' },
      tool_response: { stdout: 'https://github.com/ACME/example-repo/issues/91\n' },
      cwd: '/tmp/some-project',
    },
    // An explicit empty string, not omission — it must NOT be treated as "unset" and fall through
    // to a sibling/fallback .env (resolveConfig() only fills a genuinely-undefined key), so this
    // deterministically exercises "no key resolvable anywhere" regardless of what's really on
    // this machine's disk.
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: '', GH_EVENT_SPOOL_PATH: spoolPath },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'no key resolvable anywhere — must not attempt to ingest');
  assert.match(result.stderr, /no API key resolved; spooled/);
  const spooled = readFileSync(spoolPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(spooled.length, 1, 'the event must be spooled, not dropped');
  assert.equal(JSON.parse(spooled[0]).source_id, 'https://github.com/ACME/example-repo/issues/91');
  rmSync(spoolDir, { recursive: true, force: true });
});

test('resolveConfig: no sibling .env in a worktree checkout, primary checkout has one -> ingests (#324, defect (a))', async () => {
  const { server, port, requests } = await startMockServer();
  const fakeWt = buildFakeWorktreeWithPrimaryEnv(
    `LIFECONTEXT_URL=http://127.0.0.1:${port}\nLIFECONTEXT_API_KEY=primary-env-key\n`,
  );

  const result = await runHookIsolated(
    fakeWt.indexPath,
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --repo ACME/example-repo --title "worktree config test"' },
      tool_response: { stdout: 'https://github.com/ACME/example-repo/issues/324\n' },
      cwd: '/tmp/some-project',
    },
    {}, // deliberately no LIFECONTEXT_* override — must resolve via the primary worktree's .env
  );

  server.closeAllConnections();
  server.close();
  rmSync(fakeWt.base, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'no key in process env or a sibling .env — must resolve via the primary worktree fallback');
  assert.equal(requests[0].headers['x-api-key'], 'primary-env-key');
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/issues/324');
});

test('cost instrumentation (#377): sums usage across turns deduping duplicate content-block lines by message.id, extracts model/effort, derives attempt_count from real commit history and total_cost_usd from the matching pricing tier', async () => {
  const { server, port, requests } = await startMockServer();
  const repoDir = buildFakeRepoWithCommits(3); // 'feature' branch, 3 commits beyond origin/main
  const usageA = {
    input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 400,
  };
  const usageB = {
    input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100,
  };
  const transcriptPath = writeTranscriptFixture([
    // msg_1 is logged TWICE (e.g. a thinking block then a text block for the same API response) --
    // real Claude Code transcripts repeat the full usage on every content-block line of one
    // message, so this must be counted exactly ONCE, not twice.
    assistantTurn({ messageId: 'msg_1', model: 'claude-opus-5', effort: 'high', usage: usageA }),
    assistantTurn({ messageId: 'msg_1', model: 'claude-opus-5', effort: 'high', usage: usageA }),
    // msg_2 is a genuinely distinct turn and must be added on top.
    assistantTurn({ messageId: 'msg_2', model: 'claude-opus-5', effort: 'high', usage: usageB }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 500 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#500\n', stderr: '' },
      cwd: repoDir, // the 'feature' branch worktree
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const { cost } = requests[0].body.extra;
  assert.deepEqual(
    cost.usage,
    withTtlZeros({ input_tokens: 150, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 500 }),
    'msg_1 must be counted once despite two content-block lines sharing its message id',
  );
  assert.equal(cost.model, 'claude-opus-5');
  assert.equal(cost.effort, 'high');
  assert.equal(cost.turn_count, 2, 'two distinct message ids -> two turns, regardless of line count');
  assert.equal(cost.attempt_count, 3, 'the feature branch carries exactly 3 commits beyond origin/main');
  assert.equal(cost.review_tier, null, 'reserved for #380, not yet populated');
  // Opus 5: input $5.00, cache-write $6.25, cache-read $0.50, output $25.00 per MTok.
  const expected = (150 * 5.00 + 200 * 6.25 + 300 * 0.50 + 500 * 25.00) / 1_000_000;
  assert.equal(cost.total_cost_usd, Math.round(expected * 1e6) / 1e6);
  assert.equal(cost.total_cost_usd_reason, null, 'a clean, single-lane window needs no withholding reason (#438)');
  assert.equal(cost.breakdown.length, 1, 'a homogeneous (model, effort) transcript is one breakdown group');
  assert.equal(cost.breakdown[0].model, 'claude-opus-5');
  assert.equal(cost.breakdown[0].effort, 'high');
  assert.equal(cost.breakdown[0].turn_count, 2);
  assert.deepEqual(cost.breakdown[0].usage, cost.usage, 'the single group\'s usage equals the all-groups total');
  assert.equal(cost.breakdown[0].cost_usd, cost.total_cost_usd);
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/pull/500#merged');
});

test('cost instrumentation (#377): a missing/unreadable transcript and a non-git cwd degrade every cost field to null without dropping the merge event, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 501 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#501\n', stderr: '' },
      cwd: '/tmp/some-project', // not a git repo -> attempt_count cannot be derived
      transcript_path: 'C:/definitely/does/not/exist/transcript.jsonl',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'the merge event itself must still be recorded');
  const { cost } = requests[0].body.extra;
  assert.equal(cost.usage, null);
  assert.equal(cost.model, null);
  assert.equal(cost.effort, null);
  assert.equal(cost.turn_count, null);
  assert.equal(cost.total_cost_usd, null);
  assert.equal(cost.total_cost_usd_reason, null, 'no transcript data at all — neither withheld case applies (#438)');
  assert.equal(cost.attempt_count, null, 'a non-git cwd cannot derive a commit count');
  assert.deepEqual(cost.breakdown, [], 'breakdown is always present, even when empty');
  assert.equal(requests[0].body.source_id, 'https://github.com/ACME/example-repo/pull/501#merged');
});

test('cost instrumentation (#377): the same token counts price differently per model — attribution, not a blended rate', async () => {
  const { server, port, requests } = await startMockServer();
  const usage = {
    input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1_000_000,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_haiku', model: 'claude-haiku-4-5', effort: 'medium', usage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 502 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#502\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.model, 'claude-haiku-4-5');
  assert.equal(cost.effort, 'medium');
  // Haiku 4.5: $1.00 input + $5.00 output per MTok -> 1 + 5 = 6.00 — a $6 PR at Haiku effort
  // 'medium' is NOT the same signal as a $6 PR at Opus 5 xhigh (input $5 + output $25 per MTok),
  // even though the raw dollar total could coincide (#377's whole point).
  assert.equal(cost.total_cost_usd, 6);
});

test('cost instrumentation (#377): an unrecognized model records usage but leaves total_cost_usd null rather than guessing a rate', async () => {
  const { server, port, requests } = await startMockServer();
  const usage = {
    input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_unknown', model: 'claude-some-future-model', effort: 'high', usage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 503 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#503\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.deepEqual(cost.usage, withTtlZeros(usage), 'usage is still recorded even when the model has no pricing entry');
  assert.equal(cost.model, 'claude-some-future-model');
  assert.equal(cost.total_cost_usd, null, 'no pricing entry -> null, never a guessed/blended rate');
  assert.equal(cost.total_cost_usd_reason, 'unpriced_group', 'distinguishable from a contaminated_window null (#438)');
  assert.equal(cost.breakdown.length, 1);
  assert.equal(cost.breakdown[0].cost_usd, null);
});

test('cost instrumentation (#377): a mixed-model/mixed-effort session groups by (model, effort), prices each group at its own rate, sums to total_cost_usd, and leaves top-level model/effort null', async () => {
  const { server, port, requests } = await startMockServer();
  // Two DISTINCT (model, effort) pairs in one transcript — e.g. an attempt that started on
  // Sonnet 5 at 'medium' and finished on Opus 5 at 'xhigh'. Collapsing to one model/effort
  // would credit the whole session to whichever end is last-seen AND price every token at
  // that one rate — the bug this follow-up fixes.
  const sonnetUsage = {
    input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const opusUsage = {
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1_000_000,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_sonnet', model: 'claude-sonnet-5', effort: 'medium', usage: sonnetUsage }),
    assistantTurn({ messageId: 'msg_opus', model: 'claude-opus-5', effort: 'xhigh', usage: opusUsage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 505 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#505\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.model, null, 'a mixed session must never be reported as one model');
  assert.equal(cost.effort, null, 'a mixed session must never be reported as one effort');
  assert.equal(cost.turn_count, 2);
  assert.deepEqual(
    cost.usage,
    withTtlZeros({ input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1_000_000 }),
    'top-level usage is still the all-groups total',
  );
  assert.equal(cost.breakdown.length, 2, 'two distinct (model, effort) pairs -> two breakdown entries');

  const sonnetEntry = cost.breakdown.find((e) => e.model === 'claude-sonnet-5');
  const opusEntry = cost.breakdown.find((e) => e.model === 'claude-opus-5');
  assert.ok(sonnetEntry && opusEntry, 'both groups must be present in the breakdown');
  assert.equal(sonnetEntry.effort, 'medium');
  assert.equal(sonnetEntry.turn_count, 1);
  assert.deepEqual(sonnetEntry.usage, withTtlZeros(sonnetUsage));
  assert.equal(opusEntry.effort, 'xhigh');
  assert.equal(opusEntry.turn_count, 1);
  assert.deepEqual(opusEntry.usage, withTtlZeros(opusUsage));

  // Sonnet 5: $3.00/MTok input -> 1,000,000 input tokens = $3.00.
  // Opus 5: $25.00/MTok output -> 1,000,000 output tokens = $25.00.
  assert.equal(sonnetEntry.cost_usd, 3);
  assert.equal(opusEntry.cost_usd, 25);
  assert.equal(cost.total_cost_usd, 28, 'total_cost_usd is the sum of each group priced at ITS OWN rate');
  // Deterministic ordering: higher cost first.
  assert.equal(cost.breakdown[0].model, 'claude-opus-5');
  assert.equal(cost.breakdown[1].model, 'claude-sonnet-5');
});

test('cost instrumentation (#377): a mixed session where one group\'s model is unrecognized leaves total_cost_usd null while the known group keeps its own cost_usd', async () => {
  const { server, port, requests } = await startMockServer();
  const knownUsage = {
    input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const unknownUsage = {
    input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_known', model: 'claude-haiku-4-5', effort: 'low', usage: knownUsage }),
    assistantTurn({ messageId: 'msg_unknown', model: 'claude-some-future-model', effort: 'high', usage: unknownUsage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 506 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#506\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.breakdown.length, 2);
  const knownEntry = cost.breakdown.find((e) => e.model === 'claude-haiku-4-5');
  const unknownEntry = cost.breakdown.find((e) => e.model === 'claude-some-future-model');
  assert.equal(knownEntry.cost_usd, 1, 'Haiku 4.5: $1.00/MTok input -> 1,000,000 tokens = $1.00 — still populated');
  assert.equal(unknownEntry.cost_usd, null, 'no pricing entry for the unrecognized model');
  assert.equal(
    cost.total_cost_usd, null,
    'one unpriceable group means the total must not read as a complete number',
  );
  assert.equal(cost.total_cost_usd_reason, 'unpriced_group', 'distinguishable from a contaminated_window null (#438)');
});

test('cost instrumentation (#437): an all-zero-usage group (e.g. the harness\'s `<synthetic>` interrupted-turn marker) does not null out an otherwise-fully-priced total', async () => {
  const { server, port, requests } = await startMockServer();
  const realUsage = {
    input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const allZeroUsage = {
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_real', model: 'claude-sonnet-5', effort: 'medium', usage: realUsage }),
    // `<synthetic>` is not a real model and will never be in the pricing table — the group's
    // usage is all-zero, so it must price at $0 regardless (#437), not fall into the
    // `allPriced` fail-honest branch meant for genuinely unpriceable (non-zero) usage.
    assistantTurn({ messageId: 'msg_synthetic', model: '<synthetic>', effort: null, usage: allZeroUsage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 507 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#507\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.breakdown.length, 2, 'both the real group and the all-zero group are represented');
  const realEntry = cost.breakdown.find((e) => e.model === 'claude-sonnet-5');
  const syntheticEntry = cost.breakdown.find((e) => e.model === '<synthetic>');
  assert.ok(realEntry && syntheticEntry, 'both groups must be present in the breakdown');
  // Sonnet 5: $3.00/MTok input -> 1,000,000 input tokens = $3.00.
  assert.equal(realEntry.cost_usd, 3);
  assert.equal(syntheticEntry.cost_usd, 0, 'an all-zero-usage group prices at exactly $0 even though its model has no rate entry');
  assert.equal(syntheticEntry.turn_count, 1, 'the interrupted turn stays visible in the record, not dropped');
  assert.equal(
    cost.total_cost_usd, 3,
    'the all-zero group must not null the total — it is trivially priced at $0, not unpriceable, so the real group\'s cost still sums through',
  );
});

test('cost instrumentation (#437): a NON-zero-usage group with an unknown model still nulls total_cost_usd — the all-zero shortcut must not over-correct', async () => {
  const { server, port, requests } = await startMockServer();
  // Only ONE token, in only ONE field — nowhere near a real turn's usage, but not all-zero
  // either. The fail-honest `allPriced` guard must still fire here.
  const almostZeroUsage = {
    input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_almost_zero', model: 'claude-some-future-model', effort: 'high', usage: almostZeroUsage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 508 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#508\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.breakdown.length, 1);
  assert.equal(cost.breakdown[0].cost_usd, null, 'even one non-zero field with an unknown model must stay unpriced');
  assert.equal(
    cost.total_cost_usd, null,
    'a single non-zero token must still fail-honest to null, never slip through as if it were the all-zero case',
  );
});

test('cost instrumentation (#377): a 1-hour-TTL cache write prices at 2x input, not the 5-minute 1.25x rate', async () => {
  const { server, port, requests } = await startMockServer();
  // Every Claude Code session measured on this box writes 100% 1-hour-TTL cache, so this is
  // the common case, not an edge one. Pricing the whole cache-write total at the 5-minute
  // rate understated it by 37.5% and the session total by ~21%.
  const usage = {
    input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({
      messageId: 'msg_1h',
      model: 'claude-opus-5',
      effort: 'high',
      usage,
      cacheCreation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 507 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#507\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.usage.cache_creation_1h_input_tokens, 1_000_000, 'the 1h tally is recorded in its own field');
  assert.equal(cost.usage.cache_creation_5m_input_tokens, 0);
  // Opus 5: 1h cache write is 2x the $5.00 input rate = $10.00/MTok (NOT the 5m $6.25).
  assert.equal(cost.total_cost_usd, 10, '1,000,000 1h-TTL cache-write tokens = $10.00, not $6.25');
});

test('cost instrumentation (#377): a mixed 5m/1h cache write prices each TTL at its own rate', async () => {
  const { server, port, requests } = await startMockServer();
  const usage = {
    input_tokens: 0, cache_creation_input_tokens: 2_000_000, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({
      messageId: 'msg_mixed_ttl',
      model: 'claude-opus-5',
      effort: 'high',
      usage,
      cacheCreation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 508 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#508\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  // $6.25 (5m) + $10.00 (1h) = $16.25 — a single blended rate cannot produce this.
  assert.equal(cost.total_cost_usd, 16.25);
});

test('cost instrumentation (#377): a transcript with no cache_creation breakdown falls back to the 5-minute rate', async () => {
  const { server, port, requests } = await startMockServer();
  // An older transcript reports only the cache-write total. Bill it at the conservative
  // 5-minute rate rather than dropping it or guessing the 1-hour premium.
  const usage = {
    input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_no_ttl', model: 'claude-opus-5', effort: 'high', usage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 509 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#509\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.usage.cache_creation_5m_input_tokens, 0, 'nothing to record when the transcript has no breakdown');
  assert.equal(cost.usage.cache_creation_1h_input_tokens, 0);
  assert.equal(cost.total_cost_usd, 6.25, 'the unsplit total bills at the 5-minute rate');
});

test('cost instrumentation (#377): a partial GH_EVENT_MODEL_PRICING_JSON override yields a null cost, not NaN', async () => {
  const { server, port, requests } = await startMockServer();
  // The pre-fix table had a single `cacheWrite` key. An override still carrying that shape is
  // missing cacheWrite5m/cacheWrite1h — it must be rejected outright, not multiplied through to
  // a NaN that JSON.stringify quietly serializes as null (indistinguishable from an honestly
  // unpriceable model).
  const usage = {
    input_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 1000,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_partial', model: 'claude-opus-5', effort: 'high', usage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 511 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#511\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
      LIFECONTEXT_API_KEY: 'test-key',
      GH_EVENT_MODEL_PRICING_JSON: JSON.stringify({
        'claude-opus-5': { input: 5.00, cacheWrite: 6.25, cacheRead: 0.50, output: 25.00 },
      }),
    },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.total_cost_usd, null, 'an incomplete rate set is unpriceable, not NaN');
  assert.equal(cost.breakdown[0].cost_usd, null);
  assert.deepEqual(cost.usage, withTtlZeros(usage), 'usage is still recorded');
  assert.match(result.stderr, /missing numeric field\(s\) cacheWrite5m, cacheWrite1h/);
});

test('cost instrumentation (#377): a JSON-array GH_EVENT_MODEL_PRICING_JSON falls back to defaults, not a table that misses on every model', async () => {
  const { server, port, requests } = await startMockServer();
  // `typeof [] === 'object'`, so an array would pass a bare object check and then miss on
  // every lookup — pricing silently off everywhere rather than falling back (Copilot, PR #392).
  const usage = {
    input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  };
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'msg_arr', model: 'claude-opus-5', effort: 'high', usage }),
  ]);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 512 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#512\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: transcriptPath,
    },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
      LIFECONTEXT_API_KEY: 'test-key',
      GH_EVENT_MODEL_PRICING_JSON: '[]',
    },
  );

  server.closeAllConnections();
  server.close();
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /is not a JSON object; using defaults/);
  // Fell back to the built-in table, so Opus 5 still prices: 1,000,000 input @ $5.00 = $5.00.
  assert.equal(requests[0].body.extra.cost.total_cost_usd, 5, 'defaults still apply after an array override');
});

test('cost instrumentation (#377): a cwd not ahead of the default branch reports attempt_count null, never a real-looking 0', async () => {
  const { server, port, requests } = await startMockServer();
  // Models `gh pr merge` run from the primary checkout sitting on main — a routine way to
  // merge. `origin/main..HEAD` is 0 there, which means "HEAD isn't the merged branch", not
  // "the PR took zero commits". A merged PR always has at least one.
  const repoDir = buildFakeRepoWithCommits(0);

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 510 --squash' },
      tool_response: { stdout: '✓ Squashed and merged pull request ACME/example-repo#510\n', stderr: '' },
      cwd: repoDir,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  rmSync(repoDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'the merge event itself must still be recorded');
  assert.equal(
    requests[0].body.extra.cost.attempt_count, null,
    'zero commits ahead is unknown, not a measurement',
  );
});

test('cost instrumentation (#377): opened events (not merges) carry no cost field at all — instrumentation is merge-scoped', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --repo ACME/example-repo --title "not a merge"' },
      tool_response: { stdout: 'https://github.com/ACME/example-repo/pull/504\n', stderr: '' },
      cwd: '/tmp/some-project',
      transcript_path: 'C:/does/not/matter.jsonl',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal('cost' in requests[0].body.extra, false, 'an opened event must not carry a cost object');
});

// --- #402: delegated subagent transcripts + lane windowing ------------------------------------

// Writes a fixture session transcript PLUS per-subagent transcripts in the sibling directory the
// real harness uses: <dir>/session.jsonl alongside <dir>/session/subagents/agent-*.jsonl. That
// layout is the whole point of #402 — the subagent turns are NOT in the session file, so a reader
// that only opens transcript_path misses them entirely.
function writeTranscriptFixtureWithSubagents(entries, subagents) {
  const transcriptPath = writeTranscriptFixture(entries);
  const subDir = path.join(path.dirname(transcriptPath), 'session', 'subagents');
  mkdirSync(subDir, { recursive: true });
  for (const [name, lines] of Object.entries(subagents)) {
    const body = typeof lines === 'string'
      ? lines
      : `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(path.join(subDir, `${name}.jsonl`), body);
  }
  return transcriptPath;
}

// A subagent transcript line: an assistant turn carrying the identity fields a real subagent file
// reports (`agentId` on the first entry, `attributionAgent` naming the agent type).
function subagentTurn({ agentId, agentType, ...turn }) {
  return { ...assistantTurn(turn), agentId, attributionAgent: agentType };
}

// A `gh pr merge` tool_use line — what priorMergeBoundary() scans for to find where the previous
// lane ended. Carries no usage, so it never contributes to a tally itself.
function mergeToolUseEntry({ number, timestamp }) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      id: `mu_${number}`,
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: `gh pr merge ${number} --squash` } }],
    },
  };
}

const OPUS_TURN = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 };
const SONNET_TURN = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2000 };
// A PR number no real repo will reach during this suite's lifetime, so attemptCountFromPr's
// `gh pr view` always misses and the git fallback governs — deterministic and offline.
const UNREACHABLE_PR = 999999;

async function runMergeHook({ transcriptPath, cwd, number = UNREACHABLE_PR }) {
  const { server, port, requests } = await startMockServer();
  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: `gh pr merge ${number} --squash` },
      tool_response: { stdout: `Squashed and merged pull request ACME/example-repo#${number}\n`, stderr: '' },
      cwd,
      transcript_path: transcriptPath,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );
  server.closeAllConnections();
  server.close();
  return { result, requests };
}

test('cost instrumentation (#402): a delegated subagent usage is read from the sibling subagents/ dir and priced as its own group, labelled by agent type AND per-invocation id', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  const transcriptPath = writeTranscriptFixtureWithSubagents(
    [assistantTurn({ messageId: 'main_1', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN })],
    {
      'agent-aaa': [subagentTurn({
        agentId: 'aaa',
        agentType: 'general-purpose',
        messageId: 'sub_1',
        model: 'claude-sonnet-5',
        effort: 'high',
        usage: SONNET_TURN,
      })],
    },
  );

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.subagent_count, 1);
  assert.equal(cost.turn_count, 2, 'the main turn plus the delegated turn');
  assert.equal(cost.breakdown.length, 2, 'main thread and subagent are separate groups');
  const main = cost.breakdown.find((b) => b.agent_id === null);
  const sub = cost.breakdown.find((b) => b.agent_id === 'aaa');
  assert.ok(main && sub, 'both a main-thread group and a subagent group are present');
  assert.equal(main.agent_type, null, 'the main thread carries no agent type');
  assert.equal(sub.agent_type, 'general-purpose', 'the subagent group is labelled by attributionAgent');
  assert.equal(sub.model, 'claude-sonnet-5');
  // Opus output $25.00/MTok, Sonnet output $15.00/MTok — priced at their own rates, not blended.
  assert.equal(main.cost_usd, Math.round((1000 * 25.00 / 1_000_000) * 1e6) / 1e6);
  assert.equal(sub.cost_usd, Math.round((2000 * 15.00 / 1_000_000) * 1e6) / 1e6);
  assert.equal(cost.total_cost_usd, Math.round((main.cost_usd + sub.cost_usd) * 1e6) / 1e6);
  assert.equal(cost.usage.output_tokens, 3000, 'the all-groups total includes delegated output');
  assert.equal(cost.model, null, 'a mixed main/subagent session is not homogeneous');
});

test('cost instrumentation (#402): a session with NO subagents dir records exactly what it did before — the undelegated case is unchanged', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  const transcriptPath = writeTranscriptFixture([
    assistantTurn({ messageId: 'main_1', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }),
  ]);

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.subagent_count, 0, 'no subagents dir is the normal case, not an error');
  assert.equal(cost.breakdown.length, 1);
  assert.equal(cost.breakdown[0].agent_type, null);
  assert.equal(cost.breakdown[0].agent_id, null);
  assert.equal(cost.model, 'claude-opus-5', 'still homogeneous, so top-level model/effort are set');
  assert.equal(cost.turn_count, 1);
});

test('cost instrumentation (#402): an unparseable subagent transcript omits only its own usage — the main thread tally and the merge event survive', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  const transcriptPath = writeTranscriptFixtureWithSubagents(
    [assistantTurn({ messageId: 'main_1', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN })],
    { 'agent-bad': 'this is not json at all\n{also not\n' },
  );

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.turn_count, 1, 'the main thread still counted');
  assert.equal(cost.breakdown.length, 1);
  assert.equal(cost.usage.output_tokens, 1000);
  assert.equal(requests[0].body.source_id, `https://github.com/ACME/example-repo/pull/${UNREACHABLE_PR}#merged`);
});

test('cost instrumentation (#402): a second merge in one session is scoped to work since the PRIOR merge, so the two records do not double-count', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  const transcriptPath = writeTranscriptFixture([
    // Lane one's work, then lane one's merge, then lane two's work. Only the last must be charged
    // to the merge happening now — without the boundary this record would carry all 3000 tokens.
    { ...assistantTurn({ messageId: 'old_1', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), timestamp: '2026-07-28T10:00:00.000Z' },
    { ...assistantTurn({ messageId: 'old_2', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), timestamp: '2026-07-28T10:01:00.000Z' },
    mergeToolUseEntry({ number: 111, timestamp: '2026-07-28T10:05:00.000Z' }),
    { ...assistantTurn({ messageId: 'new_1', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), timestamp: '2026-07-28T10:10:00.000Z' },
  ]);

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir, number: 222 });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.scope, 'since-prior-merge');
  assert.equal(cost.window_start, '2026-07-28T10:05:00.000Z', 'the boundary is the prior merge, not this one');
  assert.equal(cost.turn_count, 1, 'only the turn after the prior merge belongs to this lane');
  assert.equal(cost.usage.output_tokens, 1000, 'the two pre-boundary turns are not charged here');
});

test('cost instrumentation (#438, the PR #435 shape): interleaved + since-prior-merge withholds total_cost_usd with reason contaminated_window, but breakdown stays fully populated', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  const transcriptPath = writeTranscriptFixture([
    // A real prior merge in this transcript, so scope resolves to since-prior-merge (PR #435's
    // actual recorded scope) -- but the window still spans two branches inside that bound.
    mergeToolUseEntry({ number: 429, timestamp: '2026-07-28T09:00:00.000Z' }),
    { ...assistantTurn({ messageId: 'a', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), timestamp: '2026-07-28T09:05:00.000Z', gitBranch: 'fix/one' },
    { ...assistantTurn({ messageId: 'b', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), timestamp: '2026-07-28T09:10:00.000Z', gitBranch: 'fix/two' },
  ]);

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir, number: 435 });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.interleaved, true, 'two lanes in one window is a contaminated measurement');
  assert.equal(cost.scope, 'since-prior-merge', 'PR #435 was actually recorded with a real prior-merge bound');
  assert.equal(cost.total_cost_usd, null, 'a wrong number is worse than an absent one (#438) — the total is withheld');
  assert.equal(cost.total_cost_usd_reason, 'contaminated_window');
  assert.equal(cost.turn_count, 2);
  // Both turns share (model, effort, agent) -> one breakdown group; grouping is by that triple,
  // not by branch, so `interleaved` withholding must not be confused with a per-branch breakdown.
  assert.equal(cost.breakdown.length, 1, 'breakdown stays fully populated even though the total is withheld');
  assert.ok(cost.breakdown[0].cost_usd > 0, 'the per-group cost is still the raw evidence, not deleted');
});

test('cost instrumentation (#438, the PR #430 shape): interleaved + session-to-date (no prior merge at all) ALSO withholds total_cost_usd — the same signal fires regardless of scope', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  // No `mergeToolUseEntry` at all, so `priorMergeBoundary` finds nothing and `scope` resolves to
  // `session-to-date` with `window_start: null` — the shape PR #430 was actually recorded under,
  // absorbing everything since the session started. Two distinct `gitBranch` values inside that
  // unbounded window is exactly PR #430's real recorded `interleaved: true`.
  const transcriptPath = writeTranscriptFixture([
    { ...assistantTurn({ messageId: 'a', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), gitBranch: 'investigate/403' },
    { ...assistantTurn({ messageId: 'b', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), gitBranch: 'feat/430' },
  ]);

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir, number: 430 });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.interleaved, true);
  assert.equal(cost.scope, 'session-to-date');
  assert.equal(cost.window_start, null);
  assert.equal(cost.total_cost_usd, null, 'session-to-date absorbing two lanes is just as untrustworthy as since-prior-merge doing so');
  assert.equal(cost.total_cost_usd_reason, 'contaminated_window');
  assert.equal(cost.breakdown.length, 1, 'both turns share (model, effort, agent) — one group — breakdown still carries the raw evidence');
  assert.ok(cost.breakdown[0].cost_usd > 0);
});

test('cost instrumentation (#402): a single-lane session sets interleaved false, and — being the common single-PR-session shape — still records a real total_cost_usd (#438 must not empty the dataset)', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  const transcriptPath = writeTranscriptFixture([
    { ...assistantTurn({ messageId: 'a', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), gitBranch: 'fix/only' },
    { ...assistantTurn({ messageId: 'b', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), gitBranch: 'fix/only' },
  ]);

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.interleaved, false);
  assert.equal(cost.scope, 'session-to-date', 'a session-to-date scope alone is not a contamination signal (#438)');
  assert.notEqual(cost.total_cost_usd, null, 'a genuinely single-workstream session must still get a real number, or the fix empties the dataset for the common case');
  assert.equal(cost.total_cost_usd_reason, null);
  assert.ok(cost.total_cost_usd > 0);
});

test('cost instrumentation (#438): a genuinely single-workstream window — bounded by a real prior merge AND non-interleaved — still records a real total_cost_usd', async () => {
  const repoDir = buildFakeRepoWithCommits(1);
  const transcriptPath = writeTranscriptFixture([
    // Lane one's work, then lane one's merge, then lane two's work — all on the SAME branch, so
    // this window is both bounded (a real prior merge exists) and non-interleaved.
    { ...assistantTurn({ messageId: 'old_1', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), timestamp: '2026-07-28T10:00:00.000Z', gitBranch: 'fix/only' },
    mergeToolUseEntry({ number: 600, timestamp: '2026-07-28T10:05:00.000Z' }),
    { ...assistantTurn({ messageId: 'new_1', model: 'claude-opus-5', effort: 'high', usage: OPUS_TURN }), timestamp: '2026-07-28T10:10:00.000Z', gitBranch: 'fix/only' },
  ]);

  const { result, requests } = await runMergeHook({ transcriptPath, cwd: repoDir, number: 601 });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(transcriptPath), { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  const { cost } = requests[0].body.extra;
  assert.equal(cost.scope, 'since-prior-merge', 'a real prior merge in this transcript bounds the window');
  assert.equal(cost.interleaved, false, 'only one gitBranch appears in the (bounded) window');
  assert.equal(cost.turn_count, 1, 'only the post-boundary turn belongs to this lane');
  assert.notEqual(cost.total_cost_usd, null, 'the fix must not withhold everything and empty the dataset');
  assert.equal(cost.total_cost_usd_reason, null, 'a clean, bounded, single-lane window needs no withholding reason');
  assert.ok(cost.total_cost_usd > 0);
  assert.equal(cost.total_cost_usd, cost.breakdown[0].cost_usd);
});
