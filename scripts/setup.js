#!/usr/bin/env node
/**
 * `npm run setup` — one-command Ollama bootstrap (issue #32).
 *
 * Automates the manual prerequisites in docs/local-llm-setup-guide.md:
 *   1. Confirm the Ollama daemon is reachable (same requirement as runtime).
 *   2. Pull EMBEDDING_MODEL (required) and QUERY_MODEL (optional) via Ollama's native REST API.
 *   3. Generate .env from .env.example with a random LIFECONTEXT_API_KEY, only when .env is absent.
 *
 * Idempotent: an already-present model isn't re-downloaded; an existing .env is never overwritten.
 * Exit 0 on success; exit 1 if Ollama is unreachable or a REQUIRED pull fails. No new deps —
 * node:fetch + node:crypto. Config comes from src/config.js so there's a single source of truth.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OLLAMA_BASE_URL, EMBEDDING_MODEL, QUERY_MODEL, LIFECONTEXT_API_KEY_PLACEHOLDER } from '../src/config.js';

// Ollama's native API (/api/*) lives at the host root; strip the OpenAI-compat /v1 suffix that
// OLLAMA_BASE_URL carries for the embedding/chat SDK.
const OLLAMA_HOST = OLLAMA_BASE_URL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const ENV_EXAMPLE_PATH = join(ROOT, '.env.example');

const ok = (m) => console.log(`✓ ${m}`);
const info = (m) => console.log(`ℹ ${m}`);
const warn = (m) => console.log(`  ⚠  ${m}`);
const fail = (m) => console.error(`✗ ${m}`);

async function checkOllama() {
  info(`Checking Ollama at ${OLLAMA_HOST}...`);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ok('Ollama reachable');
    return true;
  } catch (err) {
    fail(`Ollama not reachable at ${OLLAMA_HOST} — start Ollama and retry. (${err.message})`);
    return false;
  }
}

// Pull one model (stream:false → one JSON response). Returns true on success. A failed OPTIONAL
// pull is non-fatal (search degrades to pure semantic without the query model).
async function pullModel(model, { required }) {
  info(`Pulling ${model} (${required ? 'required' : 'query model, optional'})...`);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    if (body.status && body.status !== 'success') throw new Error(body.status);
    ok(`${model} ready`);
    return true;
  } catch (err) {
    if (required) { fail(`Failed to pull ${model}: ${err.message}`); return false; }
    warn(`Optional model ${model} not pulled: ${err.message} — search will degrade to pure semantic.`);
    return true;
  }
}

// Generate .env from .env.example with a fresh key, but never clobber an existing .env.
function ensureEnv() {
  if (existsSync(ENV_PATH)) { info('.env already exists — leaving it untouched.'); return; }
  info('No .env found — generating from .env.example...');
  const key = randomBytes(32).toString('hex');
  const env = readFileSync(ENV_EXAMPLE_PATH, 'utf8').replace(LIFECONTEXT_API_KEY_PLACEHOLDER, key);
  writeFileSync(ENV_PATH, env);
  ok(`.env written — LIFECONTEXT_API_KEY=${key.slice(0, 8)}…`);
  warn("Save that key; it's the x-api-key header for every API call.");
}

async function main() {
  if (!(await checkOllama())) process.exit(1);
  if (!(await pullModel(EMBEDDING_MODEL, { required: true }))) process.exit(1);
  await pullModel(QUERY_MODEL, { required: false });
  ensureEnv();
  ok('Setup complete. Run: npm start');
}

main().catch((err) => { fail(err.message); process.exit(1); });
