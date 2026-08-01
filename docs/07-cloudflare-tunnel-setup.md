# Reach Your LifeContext From Anywhere (Cloudflare Tunnel + Your Own Domain)

Right now your LifeContext server only answers on the computer it runs on
(`http://localhost:3000`). This guide gives it a real address on the internet — like
`https://lc.yourdomain.com` — so your phone, laptop, and cloud AI tools can all talk to the
same memory. Written for normal people: every step is either a click in a website or one
command you copy and paste.

**What you'll build, in plain words:** a small helper program called `cloudflared` runs on
your server and opens a private, outbound connection to Cloudflare. When someone visits
`https://lc.yourdomain.com`, Cloudflare passes the request down that private connection to
your server. Nothing on your network is opened up — no router settings, no port forwarding,
no "static IP" from your internet provider. The connection is encrypted, and your API key is
still required for every request.

> **One honest caveat:** Cloudflare decrypts traffic at its edge before passing it down the
> tunnel — that's how the service works. For most people that's a fine trade for remote
> access to your own memory; if "no third party ever sees a request" is a hard requirement
> for you, stop here and keep the server local-only.

---

## Before you start (10 minutes, one-time)

You need three things:

1. **A domain name managed by Cloudflare.** If you own a domain (from GoDaddy, Namecheap,
   anywhere), add it to a free Cloudflare account at <https://dash.cloudflare.com> — click
   **Add a domain** and follow the prompts to point your domain's *nameservers* at
   Cloudflare (the wizard shows exactly what to change at your registrar). If you don't own
   a domain yet, buy one — Cloudflare itself sells them for ~$10/year.

2. **Your LifeContext server running.** If `npm start` works and stays running, you're set.
   Even better, run it as a Windows service (NSSM or WinSW both work) so it survives reboots.

3. **A strong API key.** Once your server is on the internet, the `LIFECONTEXT_API_KEY` in
   your `.env` file is the *only* lock on the door. If yours is short or guessable, generate
   a strong one now (paste into PowerShell):

   ```powershell
   $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
   ```

   (This uses Windows' cryptographic random generator — the right tool for a secret. Works
   in both Windows PowerShell 5.1 and PowerShell 7.)

   Put the result in `.env` as `LIFECONTEXT_API_KEY=<the new value>` and restart the server.
   Update any tool that was using the old key.

---

## Part A — Create the tunnel (mostly clicking)

### Step 1: Install the helper program

On the server, open PowerShell **as Administrator** (right-click PowerShell → *Run as
administrator*) and paste this to download and install Cloudflare's official installer:

```powershell
$msi = "$env:TEMP\cloudflared.msi"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi" -OutFile $msi
Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet" -Wait
```

Then **close and reopen** PowerShell (as Administrator again) so it picks up the newly
installed program. Confirm it's there:

```powershell
cloudflared --version
```

> **Why not `winget`?** Cloudflare's own instructions often show
> `winget install --id Cloudflare.cloudflared`, but **winget isn't installed on Windows
> Server**, so that command fails there. The download above works on Windows Server *and*
> regular Windows 10/11. (If you happen to be on a Windows 10/11 desktop that already has
> winget, the one-liner is a fine shortcut instead.)

### Step 2: Create the tunnel in Cloudflare's dashboard

1. Go to <https://one.dash.cloudflare.com> (the "Zero Trust" dashboard — free plan is fine;
   it may ask you to pick a team name the first time, any name works).
2. In the left menu: **Networks → Tunnels → Create a tunnel**.
3. Choose **Cloudflared** as the connector type, name it `lifecontext`, click **Save**.
4. The page now shows install commands for several systems. Click **Windows**, and copy the
   command that looks like this (the long blob is your tunnel's token):

   ```powershell
   cloudflared service install <LONG-TOKEN>
   ```

5. Paste it into PowerShell **run as Administrator** (right-click PowerShell → *Run as
   administrator*). This installs `cloudflared` as a Windows service, so the tunnel starts
   automatically on boot. Back in the dashboard, the connector should show as **Connected**
   within a minute.

### Step 3: Give the tunnel your address

Still in the tunnel screen, open the **Public Hostname** tab and click **Add a public
hostname**:

| Field | What to enter |
|-------|---------------|
| Subdomain | `lc` (or whatever you like) |
| Domain | your domain, e.g. `yourdomain.com` |
| Type | `HTTP` |
| URL | `localhost:3000` |

Click **Save**. Cloudflare creates the DNS record for you — there is nothing else to
configure, no config files to edit.

That's it. `https://lc.yourdomain.com` now reaches your server.

---

## Part B — Test it

From a **different** device (your phone's browser won't do POSTs easily, so use another
computer, or the same one is fine for a first pass):

```powershell
$KEY = "<your LIFECONTEXT_API_KEY>"
Invoke-RestMethod -Method Post -Uri https://lc.yourdomain.com/api/remember `
  -Headers @{ 'x-api-key' = $KEY } -ContentType 'application/json' `
  -Body '{"content":"tunnel smoke test"}'
Invoke-RestMethod -Method Post -Uri https://lc.yourdomain.com/api/recall `
  -Headers @{ 'x-api-key' = $KEY } -ContentType 'application/json' `
  -Body '{"query":"tunnel smoke test"}'
```

The first call should answer `success: True` with an id; the second should return your
"tunnel smoke test" memory with a distance score. If both work, you're done — anything that
could talk to `localhost:3000` can now talk to `https://lc.yourdomain.com` instead.

---

## Part C — Point your AI tools at it

Wherever a tool asked for your LifeContext address, swap `http://localhost:3000` for
`https://lc.yourdomain.com`:

- **MCP clients** (Claude Code, Claude Desktop, anything MCP): the server URL becomes
  `https://lc.yourdomain.com/mcp`, with the same `x-api-key` header as before. A client that
  can only take a bare URL and no header (some MCP setups, gemini/VS Code extensions) can carry
  the key as a query param instead: `https://lc.yourdomain.com/mcp?api_key=<your key>`
  (URL-encode the key if it contains `+`, `/`, `=`, `&`, or `#` — the default generated key is
  hex and needs no encoding). **Prefer the header.** A key in the URL leaks into access/proxy logs, browser history, and
  `Referer` headers in a way a header does not — if you ever send it as a query param over a
  shared or logged channel, treat that key as exposed and rotate it (regenerate
  `LIFECONTEXT_API_KEY`, restart). The `?api_key=` fallback also does **not** work for the
  **Claude.ai web** connector: the MCP authorization spec forbids tokens in the query string, so
  web needs header auth (the Request-headers beta, which accepts `x-api-key`) or OAuth.
- **Connectors** (`connectors/*/.env`): set `LIFECONTEXT_URL=https://lc.yourdomain.com` —
  this is exactly the "public/tunnel URL" their READMEs mention for cloud sessions.
- **REST scripts**: same paths as always (`/api/remember`, `/api/recall`, …), new host.

### Connecting claude.ai web (capability URL)

The **claude.ai web/mobile** connector is the one client this whole guide can't get to with a
header or a query param: its "Advanced settings" only offers an OAuth Client ID/Secret, with
no field for a custom header or a static API key
([anthropics/claude-ai-mcp #112](https://github.com/anthropics/claude-ai-mcp/issues/112),
closed "not planned"). It *does* accept an arbitrary endpoint URL, though — so the credential
has to ride in the URL path instead.

1. Generate a token (this is a **separate** secret from `LIFECONTEXT_API_KEY` — see why below):

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. Add it to `.env` as `MCP_URL_TOKEN=<the value>` and restart the server. Leaving it unset
   keeps this feature off — every `/:token/mcp` request 404s, identical to before.
3. In claude.ai's connector settings, use `https://lc.yourdomain.com/<token>/mcp` as the
   server URL — no header, no OAuth. A wrong or missing token 404s (not 401), so a probe of
   the plain `/mcp` path — or of `/<guess>/mcp` — never confirms an MCP endpoint exists there.

**Why a second secret instead of reusing `LIFECONTEXT_API_KEY`?** A token in the URL path
lands in Cloudflare's edge access logs (and any proxy in front of your server) in a way a
header never does — it's structurally lower-trust. Keeping it separate means a leak of the
URL token doesn't compromise the header key every other client (CLI, Desktop, connectors)
relies on. **Rotate it** the same way you'd rotate any secret: generate a new value, update
`MCP_URL_TOKEN`, restart, and update the URL in claude.ai's connector settings — the header
key is untouched throughout.

### Opening the browser UI remotely (capability URL)

The web UI (Ask + Contacts) is static HTML/JS a browser loads and then calls `/api` from. A browser
**can't** attach an `x-api-key` header to a plain address-bar visit, so the UI is **token-only**
(#169): it is served **only** when `UI_URL_TOKEN` is set, and **only** behind a **capability URL**,
so it's both protected and bookmarkable. There is **no open `/ui` mount** — with `UI_URL_TOKEN`
unset the UI is disabled entirely (`/ui/*` and `/<anything>/ui/*` all 404), so a tunnel can never
expose the page without an explicit token. This mirrors the MCP token convention above.

1. Generate a token (again a **separate** secret from `LIFECONTEXT_API_KEY` and `MCP_URL_TOKEN`):

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. Add it to `.env` as `UI_URL_TOKEN=<the value>` and restart. When set, the UI is served **only**
   at `https://lc.yourdomain.com/<token>/ui/chat.html` (and `/<token>/ui/contacts.html`) — token
   **first**, matching the MCP capability URL `/<token>/mcp` (#63, #165); the bare `/ui/chat.html`
   — or a wrong token — 404s, exactly like the MCP path token. **The UI now requires this token even
   on localhost** (`http://localhost:3000/<token>/ui/chat.html`) — an accepted tradeoff for a
   fail-safe default; the boot log prints `web UI: /<token>/ui/…` when set, `web UI: disabled (set
   UI_URL_TOKEN)` when not.
3. **Bookmark that full URL.** The page reads the token from its own path and sends it as the API
   key, so the bookmark works end-to-end with **no manual key entry** (there is no API-key bar) —
   `UI_URL_TOKEN` is, by design, a full-access browser credential (the server accepts it on `/api`
   as an alternative to `LIFECONTEXT_API_KEY`).

**Same URL-leak caveat as the MCP token, and then some:** a secret in a URL leaks via browser
history, proxy/CDN logs, and the `Referer` header — and a *browser* leaks URLs far more readily than
a CLI does. Treat `UI_URL_TOKEN` as a convenience credential for your own bookmark, rotate it the
same way (new value → `UI_URL_TOKEN` → restart → update the bookmark), and for anything beyond
personal use put **Cloudflare Access** in front of `/ui` (next section) as the real gate.

> **Access gates the browser UI, not MCP.** Cloudflare Access authenticates an interactive
> browser session (SSO), which is exactly what a person loading `/ui` has — but a programmatic MCP
> client (claude.ai web, Claude Desktop) can't complete an interactive login, so Access would just
> break it. That asymmetry is *why* MCP relies on the `MCP_URL_TOKEN` path capability instead. Scope
> any Access application you add to the `/ui` path (or a `/ui`-only hostname), leaving `/mcp` and
> `/api` reachable for token/header clients.

---

## Part D — Optional extra locks (recommended, still free)

- **Check the direct port is closed.** The tunnel talks to your server privately, so nothing
  on the internet should reach port 3000 directly. Windows Firewall blocks inbound
  connections by default; make sure nobody added an *inbound allow* rule for 3000:

  ```powershell
  Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True |
    Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -eq 3000 } |
    Select-Object DisplayName
  ```

  No output means no enabled inbound-allow rule opens port 3000 — good. If a rule comes
  back, open **Windows Defender Firewall with Advanced Security** and delete it unless you
  created it on purpose. (One caveat: this only tells you about the firewall's own rules —
  if Windows Firewall itself is turned off, or another firewall/VPN is in play, verify
  there too. The surest test is to try reaching `http://<your-server-ip>:3000` from another
  device and confirm it *fails*.)

- **Don't run a second server against the live DB.** Only one instance should open
  `life-context.db` (the `:3000` service). For testing/dev, use `npm run dev` — it serves on
  `:3001` against a **copy** (`.dev.db`), never the live file; a second `npm start` against the
  live DB causes `SQLITE_BUSY`/lock contention on your real memory. Each instance logs its resolved
  DB file at boot (`… · db <path>`), so a mis-pointed one is easy to spot.

- **A second key that you can revoke.** In the Zero Trust dashboard, **Access →
  Applications → Add an application** for `lc.yourdomain.com`, then create a **Service
  Token**. Clients then send two extra headers (`CF-Access-Client-Id` and
  `CF-Access-Client-Secret`) that Cloudflare checks *before* the request ever reaches your
  server — and you can revoke a token from the dashboard without touching the server. Skip
  this if your tool can only send one custom header. **For the browser UI specifically**, add an
  Access *application with an interactive SSO policy* scoped to the `/ui` path instead (a person
  loading `/ui` can complete the login; a service token suits header-sending API clients). Access
  can't gate `/mcp` — see "Opening the browser UI remotely" above for why.

- **Turn on Cloudflare's free firewall.** On your domain's dashboard under **Security**,
  enable the free managed WAF rules so obvious attack traffic is dropped at Cloudflare's
  edge instead of reaching your tunnel.

---

## Access logging — what gets recorded

Once you expose the server, you want to know whether anyone is probing it. LifeContext writes a
per-request **access log** for every surface — `/api`, `/mcp`, and `/ui` — on by default (#178).

- **Where.** One line per request, appended to a daily file `logs/access/access-YYYY-MM-DD.log`
  (UTC date). The folder is gitignored and, on Windows, NTFS-compressed at boot so the highly
  compressible text costs a fraction of the disk.
- **What's in a line.** UTC timestamp, surface tag (`api`/`mcp`/`ui`), method, path, status, latency,
  the **real client IP** (via `trust proxy`, not the tunnel's `127.0.0.1`), and the auth outcome:

  ```
  2026-07-15T13:40:12Z api POST /api/search 200 842ms ip=203.0.113.7 auth=ok
  2026-07-15T13:41:05Z api POST /api/recall 401 3ms ip=198.51.100.4 auth=fail
  2026-07-15T13:41:06Z mcp GET /<token>/mcp 404 1ms ip=198.51.100.4 auth=fail
  ```

- **Secrets are redacted, bodies are never logged.** The `?api_key=` query value is replaced with
  `<redacted>`, and a capability path token (`/<token>/mcp`, `/<token>/ui/…` — the very tokens that
  otherwise leak into the URL, as warned above) is replaced with the literal `<token>`. The log holds
  **metadata only** — never a request body, so your stored memory content never lands in a log file.
- **Probes are visible.** A `401` (bad/missing key), a wrong-capability-token `404`, and a rate-limit
  `429` are marked `auth=fail`/`ratelimited` and also echoed to the server's stderr — so a
  brute-force attempt against your key or a token shows up plainly, not silently.
- **Retention.** On boot the server deletes dated files older than `ACCESS_LOG_RETENTION_DAYS`
  (default 90). No logrotate needed.
- **Config (`.env`).** `ACCESS_LOG_ENABLED` (default `true`; set `false` to turn it off entirely),
  `ACCESS_LOG_DIR` (default `logs/access`), `ACCESS_LOG_RETENTION_DAYS` (default `90`; `0`/unset keeps 90).
- **Manual NTFS compression** (Windows, if you want to compress files already written, not just new
  ones): `compact /c /s "logs\access"` from the repo root. The boot step only sets the folder
  attribute so *new* daily files inherit compression.

This is deliberately local-only: shipping logs off-box or alerting on them is out of scope — a flat
daily file you can `grep` is enough to answer "did anyone try the door?"

---

## If something doesn't work

| What you see | What it means | Fix |
|--------------|---------------|-----|
| Cloudflare error page 530 / 1033 | The tunnel itself is down | On the server: `Start-Service cloudflared`, then check the connector shows **Connected** in the dashboard |
| Error 502 Bad Gateway | Tunnel is up, but LifeContext isn't | Start the server (`npm start` or the Windows service); confirm `http://localhost:3000` answers locally |
| `Rate limit breached` for everyone at once | The server is treating all remote users as one visitor | The `trust proxy` setting is missing — see the note below; it ships enabled in this repo |
| 403 Forbidden from Cloudflare | An Access policy or firewall rule is blocking | Check **Zero Trust → Logs** and your Access application settings |
| `{"error":"Unauthorized"}` | Wrong or missing API key | Send the exact `LIFECONTEXT_API_KEY` value in the `x-api-key` header |

---

## Appendix 1 — For technical users: CLI-managed tunnel instead

If you'd rather keep the tunnel's config in a file under version control than in
Cloudflare's dashboard:

```powershell
cloudflared tunnel login                       # browser auth; pick your zone
cloudflared tunnel create lifecontext          # prints the tunnel UUID
cloudflared tunnel route dns lifecontext lc.yourdomain.com
```

Write `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-UUID>.json
ingress:
  - hostname: lc.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Test in the foreground with `cloudflared tunnel run lifecontext`. To install it as a
service, note the gotcha: the service runs as `LocalSystem`, whose home folder is **not**
yours, so copy the config there first:

```powershell
New-Item -ItemType Directory -Force C:\Windows\System32\config\systemprofile\.cloudflared
Copy-Item $env:USERPROFILE\.cloudflared\config.yml, $env:USERPROFILE\.cloudflared\<TUNNEL-UUID>.json `
  C:\Windows\System32\config\systemprofile\.cloudflared\
cloudflared service install
Start-Service cloudflared
```

## Appendix 2 — Why the server sets `trust proxy`

Behind the tunnel, every request reaches Express from `127.0.0.1` (the tunnel's local end).
Without `app.set('trust proxy', 1)`, the rate limiter would see one visitor — the whole
internet sharing a single 100-requests-per-minute bucket — and `express-rate-limit` logs
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation errors. With it, Express reads the real
client address from the `X-Forwarded-For` header Cloudflare sets, and rate limiting works
per visitor. It's on by default and harmless for plain localhost use (local requests carry
no forwarded header and behave exactly as before). If your server is reachable directly on
your LAN and you *don't* use a tunnel or proxy, you can set `TRUST_PROXY=0` in `.env` so
forwarded headers are never trusted.
