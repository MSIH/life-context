# Local LLM Setup Guide — MINISFORUM UM870 (Ryzen 7 8745H / Radeon 780M / 32GB)

Goal: run **Ollama** as your local AI engine, serving

1. `qwen3-embedding:0.6b` — the one embedding model for your brain server
2. A chat model (Qwen3 8B) for query parsing, daily digests, and general local use

Written for **Windows 11** (PowerShell). Linux notes at the end.

> **Reader/agent note.** Steps 1–5 (install Ollama, pull models, configure for 24/7) are current.
> Steps 6–8 were written for the pre-2.0 single-file server (`brain-server.js`) and are
> **superseded** — see the notes at each step: config is now env-driven (`.env` + `src/config.js`,
> no code edits), the store is the `artifacts` schema (not `memories`), and a Windows-service
> wrapper (WinSW is the one this project's own box runs) is the recommended replacement for
> Step 8's NSSM instructions below.

---

## Quick start (automated) — `npm run setup`

Once [Ollama is installed](#step-1--install-ollama) and running, one command does the model pulls and `.env` generation for you:

```bash
npm install
npm run setup     # checks Ollama, pulls the embedding model (+ optional query model), writes .env
npm start
```

`npm run setup` (`scripts/setup.js`):
- confirms the Ollama daemon is reachable at `OLLAMA_BASE_URL`,
- pulls `EMBEDDING_MODEL` (required) and `QUERY_MODEL` (optional — search degrades to pure semantic if it's missing),
- writes `.env` from `.env.example` with a random `LIFECONTEXT_API_KEY`, **only if `.env` doesn't already exist** (it never overwrites your key),
- exits non-zero if Ollama is unreachable or the required model fails to pull.

It's idempotent — models already present aren't re-downloaded. It prints the generated key once; save it (it's the `x-api-key` for every request).

**Chat with your memory (optional):** build the bundled Ollama persona and talk to your brain:

```bash
ollama create lifecontext -f Modelfile   # base model is qwen3:8b — edit FROM to use another
ollama run lifecontext --keepalive 24h
```

The manual, step-by-step setup below remains the source of truth for what `npm run setup` automates (and for the 24/7 service configuration).

---

## Step 1 — Install Ollama

1. Download the Windows installer from <https://ollama.com/download>
2. Run `OllamaSetup.exe` — no options needed; it installs per-user and adds a background service
3. Verify in a new PowerShell window:

```powershell
ollama --version
```

You should see a version number. Ollama now runs automatically at login and listens on `http://localhost:11434`.

---

## Step 2 — Pull the models

```powershell
# Embedding model (~600 MB) — the permanent one for your brain
ollama pull qwen3-embedding:0.6b

# Chat model (~5 GB at Q4 quantization) — for digests, query parsing, general chat
ollama pull qwen3:8b
```

Check what's installed:

```powershell
ollama list
```

---

## Step 3 — Smoke test

**Chat model (interactive):**

```powershell
ollama run qwen3:8b
```

Type a question; `/bye` to exit. Expect roughly 8–15 tokens/sec on this hardware — usable, not instant.

**Embedding endpoint (what brain-server.js will call):**

```powershell
$body = @{
    model = "qwen3-embedding:0.6b"
    input = "test memory about my sister in Austin"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:11434/v1/embeddings" -Method Post -ContentType "application/json" -Body $body
```

You should get back a JSON object with an `embedding` array of **1024** numbers. That number matters — it's your new `VECTOR_DIMENSION`.

---

## Step 4 — Configure Ollama for a 24/7 brain server

Set these as **user environment variables** (Settings → System → About → Advanced system settings → Environment Variables), then quit Ollama from the system tray and relaunch:

| Variable | Value | Why |
|---|---|---|
| `OLLAMA_KEEP_ALIVE` | `24h` | Keeps the embedding model loaded so every store/recall isn't paying a cold-start. At 600 MB it costs almost nothing to keep resident. |
| `OLLAMA_MAX_LOADED_MODELS` | `2` | Lets the embedding model and chat model stay loaded together (fine in 32 GB). |
| `OLLAMA_HOST` | `127.0.0.1` | Default, but set it explicitly — keeps Ollama loopback-only. Your brain server is the thing exposed to the network, not Ollama. |

Or set them for the current session only while testing:

```powershell
$env:OLLAMA_KEEP_ALIVE = "24h"
$env:OLLAMA_MAX_LOADED_MODELS = "2"
```

---

## Step 5 — GPU acceleration (the honest section)

The 780M is an iGPU (gfx1103) that AMD's ROCm does **not officially support**, so out of the box **Ollama on Windows runs on CPU**. For your use case that's mostly fine:

- **Embeddings**: CPU is completely fine — milliseconds per memory at 0.6B size. Don't bother with GPU here.
- **Query planner (`QUERY_MODEL`, `/api/search`)**: on CPU a 3B planner is slow (often several seconds);
  if a plan exceeds `QUERY_PLAN_TIMEOUT_MS` (default 20000ms) — an especially slow model, or a cold load —
  that search falls back to pure-semantic after the stall (#179). Fixes, cheapest first:
  set `QUERY_PLANNER_ENABLED=false` (skip the planner — search stays sub-second, keyword+semantic only),
  or use a smaller `QUERY_MODEL` (`qwen2.5:1.5b`/`0.5b`) that plans well within `QUERY_PLAN_TIMEOUT_MS`.
  A GPU removes the issue outright. `recall`/`store` are unaffected (no planner).
  Note that `OLLAMA_KEEP_ALIVE` (Step 4) only helps *after* `QUERY_MODEL` has loaded once — it does
  nothing for the very first query after boot, or the first one after an idle unload. That cold load
  alone can exceed even a 20s `QUERY_PLAN_TIMEOUT_MS` (#247), which is what a repeated
  `query-plan: LLM parse failed … Request timed out` in the server log means. The server now warms
  `QUERY_MODEL` at boot (`warmUpQueryModel` in `src/search.js`) via Ollama's native `/api/generate` —
  the OpenAI-compat endpoint ignores a per-request `keep_alive` (ollama/ollama#11458), so this hits
  Ollama directly instead. Tune it with `QUERY_MODEL_KEEP_ALIVE` (default `30m`) and
  `QUERY_MODEL_WARMUP_TIMEOUT_MS` (default `60000`) in `.env`; it's skipped entirely when
  `QUERY_PLANNER_ENABLED=false`.
- **Chat (8B)**: CPU gives usable-but-slow speeds. If you want faster:

**Easiest GPU path — LM Studio (Vulkan):** LM Studio's Vulkan backend works with the 780M on Windows with zero hacks. Install from <https://lmstudio.ai>, load a Qwen3 8B GGUF, enable GPU offload, and turn on its local server (also OpenAI-compatible, port 1234). You can run LM Studio for chat and Ollama for embeddings side by side.

**Tinkerer path — Ollama with ROCm override:** community builds and the `HSA_OVERRIDE_GFX_VERSION=11.0.2` environment variable can force ROCm onto the 780M. It works for many people but breaks across driver updates. Skip it unless you enjoy that kind of thing.

**One BIOS tweak worth doing either way:** in the UM870 BIOS, set the iGPU dedicated memory (UMA frame buffer) to **8 GB or 16 GB**. Shared-memory allocation is what lets Vulkan offload larger models.

---

## Step 6 — Point brain-server.js at Ollama

> **Superseded (2.0).** No code edits anymore: set `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, and
> `VECTOR_DIMENSION` in `.env` (defaults already match this guide) — `src/config.js` reads them
> and `src/embeddings.js` owns the client. Kept for the pre-2.0 single-file server:

Three changes near the top of the file:

```js
// --- CONFIGURATION CONSTANTS ---
const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
const VECTOR_DIMENSION = 1024;   // was 1536

// --- LOCAL EMBEDDING GATEWAY (was OpenRouter) ---
const openrouter = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",              // Ollama ignores it, but the SDK requires a non-empty string
});
```

Everything else — the transaction pattern, MCP transport, auth — is untouched. `OPENROUTER_API_KEY` in `.env` becomes unused (keep it for later cloud enrichment jobs in OB2).

---

## Step 7 — Migrate the existing database

> **Superseded (2.0).** This re-embed targets the legacy `memories`/`vec_memories` tables from the
> OB1-port era. On 2.0, memories live in `artifacts`/`vec_artifacts` (`npm run migrate` copies them
> forward, reusing vectors) — a model/dimension swap there needs its own re-embed of
> `vec_artifacts` (see the `VECTOR_DIMENSION` comment in `src/config.js`, which is where that
> constant is actually defined — `src/db.js` only imports it). The procedure is one sentence:
> `CREATE VIRTUAL TABLE IF NOT EXISTS` will **not** resize an existing vec table, so a model swap
> means dropping `vec_artifacts` and re-embedding everything, the same shape as the pre-2.0 steps
> below. Kept for anyone still on the pre-2.0 server:

`CREATE VIRTUAL TABLE IF NOT EXISTS` will **not** resize the old 1536-dim vec table, and old OpenAI vectors are incompatible with Qwen vectors anyway. Re-embed once:

1. **Back up first** (the whole point of local SQLite). Substitute your actual DB file — `life-context.db` is the default; use whatever `DB_PATH` points to if you've set it:

```powershell
Copy-Item life-context.db life-context.backup.db
```

2. **Drop the old vector table** (raw memories are safe in `memories`). Same file substitution applies:

```powershell
sqlite3 life-context.db "DROP TABLE vec_memories;"
```

3. **Start the server once** — the startup `db.exec` recreates `vec_memories` at 1024 dims.

4. **Re-embed** — save as `reembed.js` next to the server and run `node reembed.js`:

```js
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import OpenAI from 'openai';

const db = new Database(process.env.DB_PATH || 'life-context.db');
sqliteVec.load(db);

const ollama = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
const insertVec = db.prepare('INSERT OR REPLACE INTO vec_memories (memory_id, embedding) VALUES (?, ?)');

const rows = db.prepare('SELECT id, content FROM memories').all();
console.log(`Re-embedding ${rows.length} memories...`);

for (const row of rows) {
  const res = await ollama.embeddings.create({ model: "qwen3-embedding:0.6b", input: [row.content] });
  insertVec.run(row.id, new Float32Array(res.data[0].embedding));
  console.log(`  ✓ ${row.id}`);
}
console.log('Done.');
db.close();
```

5. **Verify** with a recall you know should hit:

```powershell
$body = @{ query = "something you know is in there"; limit = 3 } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/recall" -Method Post -ContentType "application/json" -Headers @{ "x-api-key" = "your-secret" } -Body $body
```

---

## Step 8 — Run everything at boot

> **Alternative:** **WinSW** (a self-contained exe + committable XML config) does the same job with
> a leaner, more auditable setup than NSSM below, if you prefer it — see the
> [WinSW project](https://github.com/winsw/winsw) for the general pattern (service exe pointed at
> `node src/server.js`, working directory set to the repo root, auto-restart on crash).

Ollama already autostarts. For the brain server, install it as a **Windows service** using NSSM — it starts at boot (before anyone logs in), restarts on crash, and is managed like any other service.

**1. Install NSSM:**

```powershell
winget install nssm
```

(Or download from <https://nssm.cc> and put `nssm.exe` somewhere on your PATH.)

**2. Create the service** (elevated PowerShell — right-click, Run as Administrator):

```powershell
# Adjust paths to your install
$nodeExe = "C:\Program Files\nodejs\node.exe"
$appDir = "C:\brain"

nssm install BrainServer $nodeExe "brain-server.js"
nssm set BrainServer AppDirectory $appDir
nssm set BrainServer AppStdout "$appDir\logs\brain.log"
nssm set BrainServer AppStderr "$appDir\logs\brain-error.log"
nssm set BrainServer AppRotateFiles 1
nssm set BrainServer AppRotateBytes 10485760
nssm set BrainServer Start SERVICE_AUTO_START
```

`AppDirectory` matters: it's the working directory, so the server finds `.env` and creates `life-context.db` there. Create the `logs` folder first (`New-Item -ItemType Directory -Force "$appDir\logs"`).

**3. Start and verify:**

```powershell
nssm start BrainServer
Get-Content C:\brain\logs\brain.log -Tail 5
```

You should see the "operating on port 3000" startup line. From now on it survives reboots and crash-restarts automatically (tune restart behavior under `services.msc` → BrainServer → Recovery, or via `nssm edit BrainServer`).

**Useful commands:**

```powershell
nssm restart BrainServer     # after editing brain-server.js
nssm stop BrainServer
nssm remove BrainServer confirm   # uninstall the service
```

**Two caveats:**

- **Shutdown signals**: Windows services don't receive SIGINT/SIGTERM the way the script's graceful-shutdown handler expects; NSSM may terminate the process hard on stop. Harmless here — SQLite in WAL mode recovers cleanly — but don't be surprised that the shutdown log lines never appear.
- **During development**, skip the service and just run `node brain-server.js` in a terminal (or use `pm2` for auto-restart while iterating). Install the service once the setup is stable; remember `nssm restart BrainServer` after each code change.

---

## Linux alternative (one-liners)

If you ever put Linux on the UM870 (a common choice for a headless brain box):

```bash
curl -fsSL https://ollama.com/install.sh | sh        # installs + systemd service
ollama pull qwen3-embedding:0.6b && ollama pull qwen3:8b
```

ROCm on the 780M is also more tractable on Linux (`HSA_OVERRIDE_GFX_VERSION=11.0.2` in the systemd unit), and the rest of the guide is identical.

---

## Quick reference

| Thing | Value |
|---|---|
| Ollama endpoint | `http://localhost:11434/v1` |
| Embedding model | `qwen3-embedding:0.6b` → **1024 dims** |
| Chat model | `qwen3:8b` (upgrade path: `qwen3:14b`, still fits in 32 GB) |
| Brain server | port 3000, unchanged auth/MCP |
| Cost per embedding | $0, forever, offline |
