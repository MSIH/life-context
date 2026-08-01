#!/usr/bin/env node
/**
 * Run a dev/test server against a COPY of the live DB, never the live file (#170). Running a second
 * `node src/server.js` with the default `.env` opens `life-context.db` a second time — concurrent
 * writers to one SQLite file cause `SQLITE_BUSY`/"database is locked" and risk your real memory.
 * This copies the live DB to a scratch file (consistent online snapshot via better-sqlite3's backup,
 * so it's safe even while the live service is writing) and boots the server on an alt port pointed
 * at the copy. The live service on :3000 / life-context.db is untouched.
 *
 *   npm run dev              # copy life-context.db -> .dev.db (once), serve on :3001 against the copy
 *   npm run dev -- --fresh   # re-copy even if .dev.db already exists
 * Env: DEV_DB_PATH (default .dev.db), DEV_PORT (default 3001), DB_PATH (source; default life-context.db).
 * The scratch DB is gitignored (matches *.db). Nothing here writes the live DB.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DEV_PORT = process.env.DEV_PORT || '3001';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveAbs = path.resolve(root, process.env.DB_PATH || 'life-context.db');
const devRel = process.env.DEV_DB_PATH || '.dev.db';
const devAbs = path.resolve(root, devRel);
const fresh = process.argv.includes('--fresh');

if (path.resolve(liveAbs) === path.resolve(devAbs)) {
  console.error(`dev-server: DEV_DB_PATH must differ from the live DB (${liveAbs}) — refusing to run against the live file.`);
  process.exit(1);
}
if (!existsSync(liveAbs)) {
  console.error(`dev-server: live DB not found at ${liveAbs} (set DB_PATH). Nothing to copy.`);
  process.exit(1);
}

if (fresh || !existsSync(devAbs)) {
  console.error(`dev-server: snapshotting ${path.relative(root, liveAbs)} -> ${devRel} (consistent online copy)…`);
  const src = new Database(liveAbs, { readonly: true });
  try { await src.backup(devAbs); } finally { src.close(); } // online backup: safe while the live service writes
} else {
  console.error(`dev-server: reusing existing ${devRel} (pass --fresh to re-copy from the live DB)`);
}

console.error(`dev-server: starting server on :${DEV_PORT} against ${devRel} (live DB untouched)`);
// dotenv.config() in src/config.js does NOT override an already-set process.env, so DB_PATH/PORT
// here win over any value in .env — the dev instance is pinned to the copy + alt port.
const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: { ...process.env, DB_PATH: devRel, PORT: DEV_PORT },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
