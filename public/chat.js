// LifeContext webchat sidecar (#124) — a host-agnostic page to query memory in natural language
// beside any app, reaching tools that will never integrate via MCP. Read-only: query + render, no
// mutation. Vanilla ES module, no build step. Talks to POST /api/search (rich artifact results) or
// POST /api/recall (simple {content, created_at, distance}); the page is served token-only (#169)
// so its API credential is the path token itself, sent as x-api-key on every call. DOM is built via
// el() (text nodes, never innerHTML with result data) so a memory's own text can't inject markup.
// Mirrors the idioms in app.js (#96).

const RESULT_LIMIT = 10;
const SNIPPET_MAX = 400; // text_repr can be long prose; cap the card body, keep the whole thing on hover.

// --- tiny DOM helper (mirrors app.js) ---
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

// --- API layer (mirrors app.js) ---
// Token-only (#169): the credential is the capability token parsed from this page's own path
// (/<token>/ui/<file>, URL-decoded), sent as x-api-key — requireAuth accepts UI_URL_TOKEN (#163).
// The page is only reachable at that path, so the token is always present; no manual entry.
const apiKey = () => {
  const seg = location.pathname.match(/^\/([^/]+)\/ui\/[^/]+$/)?.[1];
  if (!seg) return '';
  try { return decodeURIComponent(seg); } catch { return seg; } // malformed %-escape: use the raw segment
};
class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

async function api(method, path, { body } = {}) {
  const headers = { 'x-api-key': apiKey() };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { toast('Unauthorized — reopen the page from its full /<token>/ui/ URL.', true); throw new ApiError(401, 'unauthorized'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText, data);
  return data;
}

// --- state + refs ---
const $ = (id) => document.getElementById(id);
let mode = 'search'; // 'search' (rich) | 'recall' (simple)

// --- toast (mirrors app.js) ---
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
function reportError(err) {
  // 401 already surfaces its own toast in api(); don't double-report it.
  if (!(err instanceof ApiError && err.status === 401)) toast(err.message || 'Request failed', true);
}

// --- rendering ---
// Format a timestamp for a chip. Timestamps from the store are UTC in SQLite's 'YYYY-MM-DD HH:MM:SS'
// form (data-model.md: occurred_at/ingested_at are UTC); that shape has no zone, so pin it to UTC
// (T…Z) before parsing — otherwise the browser reads it as local and the card shows a time off by
// the viewer's offset. Anything else (already-ISO, or non-date) falls through as-is.
function fmtDate(ts) {
  if (!ts) return '';
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
// Distance is a cosine-ish distance (smaller = closer); FTS-only hits carry null.
const fmtDist = (d) => (d == null ? '—' : d.toFixed(3));
// Elapsed wall time (ms) → a `X.XXs` label for the results-meta chip (#180).
const fmtSecs = (ms) => `${(ms / 1000).toFixed(2)}s`;

// Facet header above the result list (#353): a deterministic aggregate over the FULL matched
// candidate set (same total/by_type/places/runs shape POST /api/search returns), not just the
// returned page. Never LLM prose — plain string composition over fields the server already
// computed. Mirrors server.js's formatSummaryLine (duplicated, not shared: this file is a
// build-step-free browser module, src/server.js is Node ESM — no common import between them).
function fmtRunRange(run) {
  if (run.start === run.end) return run.start;
  return run.start.slice(0, 7) === run.end.slice(0, 7) ? `${run.start}–${run.end.slice(8)}` : `${run.start}–${run.end}`;
}
function summaryHeader(summary) {
  const types = Object.entries(summary.by_type || {});
  const parts = [types.length === 1
    ? `${summary.total} ${types[0][0]}${summary.total === 1 ? '' : 's'}`
    : `${summary.total} result${summary.total === 1 ? '' : 's'}`];
  if (summary.places?.length) parts.push(summary.places[0].place_label);
  if (summary.runs?.length) parts.push(`${summary.runs.length} visit${summary.runs.length === 1 ? '' : 's'}: ${summary.runs.map(fmtRunRange).join(', ')}`);
  return el('p', { class: 'summary' }, parts.join(' · '));
}

function metaChips(chips) {
  const row = el('div', { class: 'card-meta' });
  for (const [label, val] of chips) if (val) row.append(el('span', { class: 'chip', title: label }, val));
  return row;
}

// Card body: trim, cap at SNIPPET_MAX (full text on hover). text_repr/content can be long prose.
function cardBody(text) {
  const body = (text || '').trim();
  const long = body.length > SNIPPET_MAX;
  return el('p', { class: 'card-body', title: long ? body : null }, long ? body.slice(0, SNIPPET_MAX) + '…' : (body || '(no text)'));
}

// Linked entities (`links`: [{entity_id, role, canonical_name, kind}]) rendered as name chips;
// the role is shown when it's something other than the default 'self'.
function linkChips(links) {
  if (!links?.length) return null;
  const row = el('div', { class: 'card-links' });
  for (const l of links) row.append(el('span', { class: 'chip entity', title: `${l.kind} #${l.entity_id}` },
    l.canonical_name || `#${l.entity_id}`, l.role && l.role !== 'self' ? ` · ${l.role}` : ''));
  return row;
}

// A /api/search hit: full artifact row + `distance` + `links`. Render the fields the API returns
// (text_repr, occurred_at, type, source, place_label, distance, linked entities).
function searchCard(a) {
  return el('article', { class: 'card' },
    metaChips([
      ['type', a.type],
      ['source', a.source],
      ['when', fmtDate(a.occurred_at ?? a.ingested_at)],
      ['place', a.place_label],
      ['distance', `d ${fmtDist(a.distance)}`],
    ]),
    cardBody(a.display_text ?? a.text_repr), // #147: name-annotated text ("… from Amy Fenwick (+1…)"); raw handle if unresolved
    linkChips(a.links));
}

// A /api/recall hit: the legacy shape {content, created_at, distance}.
function recallCard(r) {
  return el('article', { class: 'card' },
    metaChips([['when', fmtDate(r.created_at)], ['distance', `d ${fmtDist(r.distance)}`]]),
    cardBody(r.content));
}

function addTurn(query, turnMode) {
  // Animated in-flight state: a CSS spinner + a mode-aware label, so it's obviously working (#180).
  const label = turnMode === 'recall' ? 'Recalling…' : 'Searching…';
  // The live seconds counter (#185) is aria-hidden so it doesn't spam SRs each tick — the static
  // "Searching…"/"Recalling…" label carries the in-flight signal; `ask` writes elapsed here.
  const results = el('div', { class: 'results' },
    el('p', { class: 'thinking' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), label,
      el('span', { class: 'elapsed', 'aria-hidden': 'true' })));
  const turn = el('section', { class: 'turn' },
    el('div', { class: 'q' }, el('span', { class: 'q-mode' }, turnMode), el('span', { class: 'q-text' }, query)),
    results);
  const t = $('transcript');
  t.append(turn);
  turn.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return results;
}

// Client-measured wall time (#180): honest end-to-end latency the user felt. A `N result(s) · X.XXs`
// chip heads the cards; 0 results still shows the time, so "no matches in 1.2s" is distinguishable
// from "still running".
function renderResults(container, rows, turnMode, elapsed, summary) {
  container.replaceChildren();
  container.append(el('p', { class: 'results-meta' },
    `${rows.length} result${rows.length === 1 ? '' : 's'} · ${fmtSecs(elapsed)}`));
  if (!rows.length) { container.append(el('p', { class: 'empty' }, 'No matching memories.')); return; }
  // Shown only for search mode with more than one result (#353) — a single hit needs no summary above it.
  if (turnMode === 'search' && summary && rows.length > 1) container.append(summaryHeader(summary));
  const build = turnMode === 'recall' ? recallCard : searchCard;
  for (const r of rows) container.append(build(r));
}

// --- ask flow ---
async function ask(query) {
  // Snapshot the mode at submit time: the toggle can flip while this request is in flight, and the
  // returned shape (search artifact vs recall {content}) must be rendered with the matching card.
  const turnMode = mode;
  const slot = addTurn(query, turnMode);
  const t0 = performance.now(); // wall clock around the fetch — the latency the user actually feels
  // Live progress readout (#185): tick a whole-second counter into the thinking line so a
  // multi-second search shows continuous activity, not just a (possibly static) ring. Cleared in
  // `finally` on BOTH paths — renderResults/the error replaceChildren remove the spinner node, so a
  // surviving interval would keep writing to a detached .elapsed span.
  const elapsedEl = slot.querySelector('.elapsed');
  let shownSecs = -1; // only touch the DOM when the whole-second value changes
  const timer = setInterval(() => {
    const secs = Math.floor((performance.now() - t0) / 1000);
    if (elapsedEl && secs !== shownSecs) { shownSecs = secs; elapsedEl.textContent = `${secs}s`; }
  }, 250);
  try {
    const path = turnMode === 'recall' ? '/api/recall' : '/api/search';
    const { results, summary } = await api('POST', path, { body: { query, limit: RESULT_LIMIT } });
    renderResults(slot, results || [], turnMode, performance.now() - t0, summary);
  } catch (err) {
    const elapsed = performance.now() - t0; // show elapsed on the error path too (#180)
    slot.replaceChildren(
      el('p', { class: 'results-meta' }, `Error · ${fmtSecs(elapsed)}`),
      el('p', { class: 'empty err' }, err instanceof ApiError && err.status === 401 ? 'Unauthorized — reopen this page from its full /<token>/ui/ URL.' : `Error: ${err.message || 'request failed'}`));
    reportError(err);
  } finally {
    clearInterval(timer); // stop ticking on both success and error — the .elapsed node is now gone
  }
}

$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('ask').value.trim();
  if (!q) return;
  void ask(q); // fire-and-forget: ask() funnels its own errors, so nothing rejects unobserved
  $('ask').value = '';
});

// --- mode toggle (button group: keep aria-pressed in sync with the .active class) ---
for (const b of $('modeToggle').querySelectorAll('button')) b.addEventListener('click', () => {
  mode = b.dataset.mode;
  for (const x of $('modeToggle').querySelectorAll('button')) {
    const on = x === b;
    x.classList.toggle('active', on);
    x.setAttribute('aria-pressed', String(on));
  }
  $('ask').focus();
});

// --- boot ---
// Token-only (#169): the page is only served at /<token>/ui/<file>, so apiKey() always resolves the
// credential from the path — nothing to bootstrap or prompt for. Focus the ask box and go.
$('ask').focus();
