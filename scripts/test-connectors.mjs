#!/usr/bin/env node
/**
 * `npm run test:connectors` — run each connector's own `node --test test.mjs` suite.
 *
 * Connectors are isolated packages (doc 04 §1.1) with their own deps, so their tests aren't
 * part of the root `npm test` glob. This walks each `connectors/<name>/` folder, and for each
 * one that has a `test.mjs` it runs the suite UNLESS the connector's own `package.json` declares
 * a non-empty `dependencies` map that isn't installed (`node_modules` missing) — a connector that
 * declares zero dependencies (e.g. `gh-event-claude`, `devsession-claude`) has nothing to install
 * and must never be skipped on that basis (issue #324 — the old `node_modules` existence check
 * skipped every zero-dep connector unconditionally, on every machine, so their suites never ran in
 * CI). A connector whose declared deps aren't installed is still **skipped, not failed** — a dev
 * who `npm ci`'d only the connector they're working on tests just that one. Exit 1 if any run
 * suite failed; exit 0 if every present suite passed (or all were skipped).
 *
 * Portable (spawns `process.execPath`, no shell), so it runs the same on Windows and Unix.
 */
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const connectorsRoot = join(repoRoot, 'connectors');
if (!existsSync(connectorsRoot)) { console.log('test:connectors — no connectors/ directory'); process.exit(0); }

function declaresUninstalledDeps(dir) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false; // no package.json -> nothing declared, nothing to skip on
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return false; // unparseable package.json isn't this script's job to fail on
  }
  const hasDeps = pkg.dependencies && Object.keys(pkg.dependencies).length > 0;
  return hasDeps && !existsSync(join(dir, 'node_modules'));
}

let ran = 0, failed = 0, skipped = 0;
for (const name of readdirSync(connectorsRoot)) {
  const dir = join(connectorsRoot, name);
  if (!statSync(dir).isDirectory()) continue;
  if (!existsSync(join(dir, 'test.mjs'))) continue;
  if (declaresUninstalledDeps(dir)) { console.log(`  skip ${name} (declared deps not installed)`); skipped++; continue; }
  console.log(`  test ${name}…`);
  const r = spawnSync(process.execPath, ['--test', 'test.mjs'], { cwd: dir, stdio: 'inherit' });
  ran++;
  // status is null when spawn failed to launch the runner (r.error) or it was signal-killed
  // (r.signal) — distinguish those from a normal non-zero exit so a failure names its real cause.
  if (r.status !== 0) {
    failed++;
    const why = r.error ? `could not launch: ${r.error.message}` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    console.error(`  FAIL ${name} (${why})`);
  }
}

console.log(`test:connectors — ${ran} suite(s) run, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
