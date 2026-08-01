// LifeContext contacts management UI (#96). Vanilla ES module — no framework, no build step.
// Talks to the core /api/v1/entities curation endpoints; the page is served token-only (#169) so
// its API credential is the path token itself, sent as x-api-key on every call. DOM is built via
// el() (text nodes, never innerHTML with user data) so a contact's own fields can't inject markup.

import { aliasMatchKey, looksLikeEmailOrPhone } from './alias-keys.js';
import { CONTACT_PARAM, contactIdFromUrl, setContactInUrl, PANEL_PARAM, panelFromUrl, setPanelInUrl } from './deep-link.js';

// Canonical relation vocabulary (mirrors RELATION_TYPE_MAP in src/db.js) + custom (free label).
const RELATION_TYPES = ['spouse', 'partner', 'domesticPartner', 'child', 'parent', 'mother', 'father',
  'sibling', 'brother', 'sister', 'friend', 'relative', 'assistant', 'manager', 'referredBy', 'worksAt', 'custom'];

// --- tiny DOM helper ---
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

// Trailing-edge debounce. Used for list reloads driven by held-down input: the search box's
// keystrokes and (#332) a radiogroup's arrow keys, which auto-repeat ~30x/s while held and would
// otherwise issue one API request per repeat against a tight per-key rate limit.
const FILTER_RELOAD_DEBOUNCE_MS = 220;
const debounce = (fn, ms) => { let timer; return () => { clearTimeout(timer); timer = setTimeout(fn, ms); }; };

// --- single-select button groups (#332) ---
// #kindFilter / #propStatusFilter / #newContactKind are radiogroups in the markup, not tablists: each
// picks one of N, none reveals a tabpanel. Selection used to live only in the .active class, which
// assistive tech cannot perceive — so .active stays the VISUAL state (styled in style.css) and
// aria-checked carries the semantics. Roving tabindex keeps the group a single tab stop, which is what
// obliges us to handle arrows/Home/End: that keyboard contract is part of the radiogroup pattern, not
// an extra. One helper for all three groups, replacing the per-group classList.toggle loops.
function selectInGroup(group, chosen) {
  const buttons = [...group.querySelectorAll('button')];
  // A `chosen` outside this group would leave every button unchecked AND tabIndex -1 — i.e. a group
  // with no tab stop, silently unreachable by keyboard. Degrade to the first button and say so.
  let target = chosen;
  if (!buttons.includes(target)) {
    console.error(`selectInGroup: #${group.id} has no such button; falling back to the first`);
    target = buttons[0];
  }
  for (const b of buttons) {
    const on = b === target;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
// Click and arrow keys both select; onSelect receives the winning button. Arrow selection moves focus
// too (radiogroup convention — the focused radio IS the checked one), so it fires onSelect the same
// way a click does; nothing here needs to know what the group filters. onSelect runs SYNCHRONOUSLY on
// every selection — a caller that reloads data debounces that reload itself (see #kindFilter below)
// rather than having it debounced here, because a group whose onSelect only records state
// (#newContactKind → the kind Create reads) must observe the choice before the next click.
function wireRadioGroup(group, onSelect) {
  const buttons = [...group.querySelectorAll('button')];
  for (const b of buttons) b.addEventListener('click', () => { selectInGroup(group, b); onSelect(b); });
  group.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(e.target);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = buttons[(i + 1) % buttons.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = buttons[(i - 1 + buttons.length) % buttons.length];
    else if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    if (!next) return;
    e.preventDefault(); // ArrowUp/Down would scroll the panel; Home/End would jump it
    selectInGroup(group, next);
    next.focus();
    onSelect(next);
  });
}

// --- API layer ---
// Token-only (#169): the credential is the capability token parsed from this page's own path
// (/<token>/ui/<file>, URL-decoded), sent as x-api-key — requireAuth accepts UI_URL_TOKEN (#163).
// The page is only reachable at that path, so the token is always present; no manual entry.
const apiKey = () => {
  const seg = location.pathname.match(/^\/([^/]+)\/ui\/[^/]+$/)?.[1];
  if (!seg) return '';
  try { return decodeURIComponent(seg); } catch { return seg; } // malformed %-escape: use the raw segment
};
class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

async function api(method, path, { body, rawBody, contentType } = {}) {
  const headers = { 'x-api-key': apiKey() };
  let payload;
  if (rawBody !== undefined) { payload = rawBody; if (contentType) headers['Content-Type'] = contentType; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { toast('Unauthorized — reopen the page from its full /<token>/ui/ URL.', true); throw new ApiError(401, 'unauthorized'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText, data);
  return data;
}

async function fetchPhotoObjectURL(id) {
  const res = await fetch(`/api/v1/entities/${id}/photo`, { headers: { 'x-api-key': apiKey() } });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

// --- state + refs ---
const $ = (id) => document.getElementById(id);
let currentId = null, currentProfile = null, currentKind = '', searchTerm = '', lastPhotoURL = null;
let currentSave = null; // set by renderDetail to the open contact's save closure; used by the top-bar Save (#127)

// --- toast ---
let toastTimer;
// action (optional): { label, onClick } renders an inline button in the toast (e.g. the 409
// "Review duplicates" affordance). A toast carrying an action lingers longer so it's clickable.
function toast(msg, isErr = false, action = null) {
  const t = $('toast');
  t.replaceChildren(document.createTextNode(msg));
  if (action) t.append(' ', el('button', { type: 'button', class: 'toast-action', onclick: () => { t.hidden = true; action.onClick(); } }, action.label));
  t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 3200);
}
function reportError(err) {
  if (err instanceof ApiError && err.status === 409 && err.data?.conflict) {
    const c = err.data.conflict;
    toast(`That ${c.alias_type} already belongs to contact #${c.entity_id}.`, true, { label: 'Review duplicates', onClick: () => openDuplicates(c.entity_id) });
  } else if (!(err instanceof ApiError && err.status === 401)) {
    toast(err.message || 'Request failed', true);
  }
}

// --- list ---
const initials = (name) => (name || '?').split(/\s+/).slice(0, 2).map((s) => s[0] || '').join('').toUpperCase();

async function loadList() {
  try {
    const params = new URLSearchParams();
    if (searchTerm) params.set('query', searchTerm);
    if (currentKind) params.set('kind', currentKind);
    params.set('limit', '200');
    const { entities } = await api('GET', `/api/v1/entities?${params}`);
    renderList(entities);
  } catch (err) { reportError(err); }
}

function renderList(entities) {
  const list = $('list');
  list.replaceChildren();
  if (!entities.length) { list.append(el('p', { class: 'empty', style: 'padding:16px' }, 'No contacts match.')); return; }
  for (const e of entities) {
    const attrs = e.attrs || {};
    const meta = attrs.emails?.[0] || attrs.phones?.[0] || attrs.org || '';
    // Avatar shows initials; a 📷 badge marks contacts that have a photo (uploaded or imported) —
    // hasPhoto comes from the list endpoint, so no per-row image fetch here.
    const avatar = el('div', { class: 'avatar' }, initials(e.canonical_name));
    if (e.hasPhoto) avatar.append(el('span', { class: 'photo-badge', role: 'img', 'aria-label': 'Has a photo', title: 'Has a photo' }, '📷'));
    const row = el('div', { class: 'row' + (e.id === currentId ? ' selected' : ''), 'data-id': e.id, onclick: () => selectContact(e.id) },
      avatar,
      el('div', {},
        el('div', { class: 'rname' }, e.canonical_name, e.kind === 'org' ? ' ' : '', e.kind === 'org' ? el('span', { class: 'kind-badge' }, 'org') : ''),
        meta ? el('div', { class: 'rmeta' }, meta) : ''),
    );
    list.append(row);
  }
}

// --- detail ---
// fromHistory: the URL already names this contact (initial deep link, or a Back/Forward) — select it
// without writing history, or Back would land on the entry it just re-created.
async function selectContact(id, { fromHistory = false } = {}) {
  const changed = id !== currentId;
  currentId = id;
  if (!fromHistory) setContactInUrl(id, { push: changed }); // a re-click on the open contact must not stack entries
  try {
    const profile = await api('GET', `/api/v1/entities/${id}`);
    // Staleness guard, same idiom as loadPhoto below: a slower response for a contact the user has
    // since navigated away from (a second click, or a Back that deselected) must not repaint over
    // the newer state — currentId/URL/history would still say the newer one, silently disagreeing
    // with what's on screen.
    if (currentId !== id) return;
    currentProfile = profile;
    renderDetail(currentProfile);
    for (const r of $('list').querySelectorAll('.row')) r.classList.toggle('selected', Number(r.dataset.id) === id);
  } catch (err) {
    // Nothing is open, so leave nothing claiming otherwise. clearSelection (not a partial reset) —
    // on a failed switch the previous contact is still rendered, so its Save closure and row
    // highlight would outlive the currentId/URL that just stopped naming it. A stale param would
    // also make every refresh re-raise the same error. Both are scoped to "this is still the
    // current request" for the same reason the success path is: a stale failure must not deselect,
    // or strip the param naming, a contact the user has since moved to.
    if (currentId === id) { clearSelection(); setContactInUrl(null); }
    reportError(err);
  }
}

// Back/Forward. A param-less entry is a deselect — the only one this UI has, so it has to undo
// everything renderDetail set up (see the top-bar Save note there).
function clearSelection() {
  currentId = null; currentProfile = null; currentSave = null;
  $('saveTop').hidden = true;
  if (lastPhotoURL) { URL.revokeObjectURL(lastPhotoURL); lastPhotoURL = null; }
  $('detail').replaceChildren(el('p', { class: 'empty' }, 'Select a contact, or create one.'));
  for (const r of $('list').querySelectorAll('.row')) r.classList.remove('selected');
}
window.addEventListener('popstate', () => {
  const id = contactIdFromUrl();
  if (id === null) clearSelection(); else selectContact(id, { fromHistory: true });
  const panel = panelFromUrl();
  if (panel === null) closeAllPanels(); else openPanelByName(panel, { fromHistory: true });
});

// Cross-panel coordination (#521): Directory/Duplicates/Proposed are mutually exclusive so the
// single `panel` URL param is never ambiguous — this is also what stops two of these three
// role="dialog" aria-modal="true" overlays from being open at once (newContactPanel is a separate,
// non-deep-linked fourth dialog this doesn't touch). Declared here (function-hoisted, so definition
// order relative to the open/close functions below doesn't matter) since it belongs to all three
// panels, not any one of their sections.
function closeAllPanels() {
  closeDuplicates();
  closeProposed();
  closeDirectory();
}
function openPanelByName(name, opts) {
  if (name === 'directory') openDirectory('', opts);
  else if (name === 'duplicates') openDuplicates(undefined, opts);
  else if (name === 'proposed') openProposed(opts);
}

// multi-value row editor (emails / phones / addresses). `multiline` renders each row as a textarea:
// an address legitimately contains newlines — an apartment line, or a vCard-escaped \n — and a
// single-line <input> silently strips them, so merely opening a contact and saving it permanently
// flattened an address the UI was only asked to display (#493). Emails and phones can hold no
// newline, so they stay <input> and are unaffected.
function multiField(label, values, placeholder, { multiline = false } = {}) {
  const wrap = el('div', { class: 'multi field' }, el('label', {}, label));
  const rows = el('div', {});
  const addRow = (v = '') => {
    const input = el(multiline ? 'textarea' : 'input', multiline ? { rows: 2, placeholder } : { type: 'text', placeholder });
    input.value = v;   // assigned, not passed as an attribute — a textarea has no value attribute
    const row = el('div', { class: 'mrow' }, input, el('button', { type: 'button', class: 'danger', title: 'Remove', onclick: () => row.remove() }, '✕'));
    rows.append(row);
  };
  (values && values.length ? values : []).forEach((v) => addRow(v));
  wrap.append(rows, el('button', { type: 'button', class: 'addlink', onclick: () => addRow() }, '+ add'));
  // Both tags are matched, since a row is one or the other depending on `multiline`. trim() strips
  // only surrounding whitespace, so an interior newline is preserved.
  wrap._collect = () => [...rows.querySelectorAll('input, textarea')].map((i) => i.value.trim()).filter(Boolean);
  return wrap;
}

// date field that preserves a non-ISO original (e.g. vCard "--05-14") unless the user changes it
function dateField(label, key, orig) {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(orig || '') ? orig : '';
  const input = el('input', { type: 'date', value: iso });
  const loaded = input.value; // what type=date actually accepted
  const wrap = el('div', { class: 'field' }, el('label', {}, label), input);
  wrap._collect = () => (input.value !== loaded ? (input.value || null) : (orig || null));
  return wrap;
}
function textField(label, key, val, textarea = false) {
  const input = el(textarea ? 'textarea' : 'input', textarea ? { rows: 3 } : { type: 'text' });
  input.value = val || '';
  const wrap = el('div', { class: 'field' }, el('label', {}, label), input);
  wrap._collect = () => input.value.trim() || null;
  return wrap;
}

function renderDetail(profile) {
  const { entity, aliases, relations, relations_in } = profile;
  const attrs = entity.attrs || {};
  const detail = $('detail');
  detail.replaceChildren();

  // header: photo + name + kind + deceased tag
  const photo = el('div', { class: 'photo' }, initials(entity.canonical_name));
  const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  fileInput.addEventListener('change', () => uploadPhoto(fileInput.files[0]));
  const nameInput = el('input', { type: 'text', value: entity.canonical_name });
  const head = el('div', { class: 'dhead' }, photo,
    el('div', { style: 'flex:1' },
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        el('span', { class: 'kind-badge' }, entity.kind),
        attrs.deceased ? el('span', { class: 'deceased-tag', title: `Deceased ${attrs.deceased}` }, 'deceased') : ''),
      el('div', { class: 'field' }, el('label', {}, 'Name'), nameInput),
      el('div', {}, el('button', { type: 'button', onclick: () => fileInput.click() }, '📷 Upload photo'), fileInput)));
  detail.append(head);
  loadPhoto(entity.id, photo);

  // contact fields
  const emails = multiField('Emails', attrs.emails, 'name@example.com');
  const phones = multiField('Phones', attrs.phones, '+1 555 123 4567');
  const addresses = multiField('Addresses', attrs.addresses, 'Street, City', { multiline: true });
  const info = el('fieldset', {}, el('legend', {}, 'Contact'), emails, phones, addresses);
  detail.append(info);

  const birthday = dateField('Birthday', 'birthday', attrs.birthday);
  const anniversary = dateField('Anniversary', 'anniversary', attrs.anniversary);
  const deceased = dateField('Deceased', 'deceased', attrs.deceased);
  const org = textField('Organization', 'org', attrs.org);
  const title = textField('Title', 'title', attrs.title);
  const department = textField('Department', 'department', attrs.department);
  const note = textField('Note', 'note', attrs.note, true);
  const more = el('fieldset', {}, el('legend', {}, 'Details'),
    el('div', { class: 'grid2' }, birthday, anniversary, deceased, org, title, department), note);
  detail.append(more);

  // save handler collects name + attrs (preserving unedited attr keys). Shared by the bottom
  // "Save changes" and the top-bar "Save" (#127) via the module-level currentSave.
  const doSave = () => saveContact(entity.id, {
    canonical_name: nameInput.value.trim(),
    attrs: {
      ...attrs,
      emails: emails._collect(), phones: phones._collect(), addresses: addresses._collect(),
      birthday: birthday._collect(), anniversary: anniversary._collect(), deceased: deceased._collect(),
      org: org._collect(), title: title._collect(), department: department._collect(), note: note._collect(),
    },
  });
  currentSave = doSave;
  // Reveal the top-bar Save once a contact is open. Intentionally hidden (not a dead greyed
  // 'disabled' button) before the first selection; the one deselect is Back to a param-less URL
  // (#492), which hides it again via clearSelection.
  $('saveTop').hidden = false;
  detail.append(el('div', { class: 'actions' }, el('button', { type: 'button', class: 'primary', onclick: doSave }, 'Save changes')));

  detail.append(renderAliases(entity.id, aliases, attrs));
  detail.append(renderRelations(entity.id, relations, relations_in));
}

async function loadPhoto(id, photoEl) {
  if (lastPhotoURL) { URL.revokeObjectURL(lastPhotoURL); lastPhotoURL = null; }
  const url = await fetchPhotoObjectURL(id);
  if (url && currentId === id) { lastPhotoURL = url; const img = el('img', { class: 'photo', src: url, alt: 'photo' }); photoEl.replaceWith(img); }
}

async function saveContact(id, payload) {
  // Save against the entity the form was built for — NOT the global currentId, which selectContact
  // sets before its GET resolves, so a Save during a load would otherwise PATCH the newly-selected
  // contact with the previously-displayed form (#127 review).
  try {
    await api('PATCH', `/api/v1/entities/${id}`, { body: payload });
    toast('Saved.');
    await selectContact(id);
    loadList();
  } catch (err) { reportError(err); }
}

async function uploadPhoto(file) {
  if (!file) return;
  try {
    await api('POST', `/api/v1/entities/${currentId}/photo`, { rawBody: file, contentType: file.type || 'application/octet-stream' });
    toast('Photo updated.');
    await selectContact(currentId);
  } catch (err) { reportError(err); }
}

// --- aliases ---
// attrsListKeyFor(aliasType) -> the attrs list an email/phone alias would have a twin in.
const attrsListKeyFor = (aliasType) => (aliasType === 'email' ? 'emails' : aliasType === 'phone' ? 'phones' : null);

// Find the raw attrs value (if any) that this email/phone alias is the resolved twin of, comparing
// via aliasMatchKey rather than string equality — entity_aliases holds the normalized form while
// attrs holds whatever the user typed (#334).
function findAttrsTwin(a, attrs) {
  const listKey = attrsListKeyFor(a.alias_type);
  if (!listKey) return null;
  const key = aliasMatchKey(a.alias, a.alias_type);
  if (!key) return null;
  return (attrs[listKey] || []).find((v) => aliasMatchKey(v, a.alias_type) === key) ?? null;
}

function renderAliases(id, aliases, attrs) {
  const fs = el('fieldset', {}, el('legend', {}, 'Aliases'));
  fs.append(el('p', { class: 'hint' },
    'Names/handles a contact resolves by. An email/phone alias here is the same value shown in Emails/Phones above — removing it here removes it there too.'));
  for (const a of aliases) {
    const twin = findAttrsTwin(a, attrs);
    fs.append(el('div', { class: 'alias' },
      el('span', { class: 'atype' }, a.alias_type || '—'),
      el('span', { class: 'aval' }, a.alias),
      el('button', {
        type: 'button', class: 'danger', title: 'Remove alias',
        onclick: () => (twin != null ? removeAliasViaAttrs(id, a, attrs, twin) : removeAlias(id, a)),
      }, '✕')));
  }
  // add name/handle alias
  const aliasInput = el('input', { type: 'text', placeholder: 'add another name or handle' });
  const typeSel = el('select', {}, el('option', { value: 'name' }, 'name'), el('option', { value: 'handle' }, 'handle'));
  // Add button between the type dropdown and the input (#127) — consistent with the relationship row.
  fs.append(el('div', { class: 'addrel' }, typeSel,
    el('button', { type: 'button', onclick: () => addAlias(id, aliasInput.value.trim(), typeSel.value) }, 'Add'),
    aliasInput));
  return fs;
}
async function addAlias(id, alias, alias_type) {
  if (!alias) return;
  // Refuse client-side (no request sent) when a name/handle alias is actually a mis-typed
  // email/phone (#334 Defect 2) — it would resolve well enough to look fine, but it misses the
  // type-scoped connector-hint match and the 1.0 confidence tier that come from the real field.
  const looksLike = looksLikeEmailOrPhone(alias);
  if (looksLike) { toast(`That looks like ${looksLike === 'email' ? 'an email' : 'a phone'} — add it in the ${looksLike === 'email' ? 'Emails' : 'Phones'} field above.`, true); return; }
  try { await api('POST', `/api/v1/entities/${id}/aliases`, { body: { alias, alias_type } }); toast('Alias added.'); await selectContact(id); }
  catch (err) { reportError(err); }
}
async function removeAlias(id, a) {
  try { await api('DELETE', `/api/v1/entities/${id}/aliases`, { body: { alias: a.alias, alias_type: a.alias_type } }); toast('Alias removed.'); await selectContact(id); }
  catch (err) { reportError(err); }
}
// ✕ on an email/phone alias that has an attrs twin: route through the attrs PATCH (built from the
// loaded `attrs`, not the live form — surgical, so pending unsaved edits elsewhere are neither
// committed nor blocking) so both layers move together. The server-side updateEntityAttrs deletes
// + tombstones the dropped alias the same way removeAlias does today.
async function removeAliasViaAttrs(id, a, attrs, twinValue) {
  const listKey = attrsListKeyFor(a.alias_type);
  // Filter by aliasMatchKey, not raw equality (Copilot review on #340/PR340): attrs can hold more
  // than one differently-formatted entry that normalizes to the same alias, and dropping only the
  // exact twinValue string would leave a variant behind for updateEntityAttrs to re-alias.
  const twinKey = aliasMatchKey(twinValue, a.alias_type);
  const next = { ...attrs, [listKey]: (attrs[listKey] || []).filter((v) => aliasMatchKey(v, a.alias_type) !== twinKey) };
  try { await api('PATCH', `/api/v1/entities/${id}`, { body: { attrs: next } }); toast('Removed.'); await selectContact(id); loadList(); }
  catch (err) { reportError(err); }
}

// --- relationships ---
function renderRelations(id, relations, relationsIn) {
  const fs = el('fieldset', {}, el('legend', {}, 'Relationships'));
  // group outgoing edges by type (multiple children/parents live here as multiple rows)
  const groups = {};
  for (const r of relations) (groups[r.relation_type] ||= []).push(r);
  for (const type of Object.keys(groups).sort()) {
    const g = el('div', { class: 'rel-group' }, el('h4', {}, type));
    for (const r of groups[type]) {
      g.append(el('div', { class: 'rel' },
        el('span', { class: 'rel-name' }, r.name || `#${r.entity_id}`, r.raw_label && r.raw_label !== type ? ` (${r.raw_label})` : ''),
        el('button', { type: 'button', class: 'danger', title: 'Remove', onclick: () => removeRelation(id, r.relation_id ?? r.id, r) }, '✕')));
    }
    fs.append(g);
  }
  if (relationsIn?.length) {
    const g = el('div', { class: 'rel-group' }, el('h4', {}, 'referenced by'));
    for (const r of relationsIn) g.append(el('div', { class: 'rel' },
      el('span', { class: 'rel-name' }, r.name || `#${r.entity_id}`), el('span', { class: 'rel-dir' }, `${r.relation_type} →`)));
    fs.append(g);
  }
  fs.append(buildAddRelation(id));
  return fs;
}

function buildAddRelation(id) {
  const typeSel = el('select', {}, ...RELATION_TYPES.map((t) => el('option', { value: t }, t)));
  const target = el('input', { type: 'text', placeholder: 'search a contact, or type a new name' });
  const results = el('div', { class: 'results', hidden: true });
  let chosen = null; // { id, name }
  const addBtn = el('button', { type: 'button' }, 'Add');

  let searchTimer;
  target.addEventListener('input', () => {
    chosen = null;
    clearTimeout(searchTimer);
    const q = target.value.trim();
    if (!q) { results.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const { entities } = await api('GET', `/api/v1/entities?query=${encodeURIComponent(q)}&limit=8`);
        results.replaceChildren();
        for (const e of entities) if (e.id !== id) results.append(el('div', { onclick: () => { chosen = { id: e.id, name: e.canonical_name }; target.value = e.canonical_name; results.hidden = true; } }, `${e.canonical_name} (${e.kind})`));
        results.append(el('div', { style: 'color:var(--muted)', onclick: () => createAndChoose(q, 'person', target, (c) => { chosen = c; results.hidden = true; }) }, `+ Create person "${q}"`));
        results.append(el('div', { style: 'color:var(--muted)', onclick: () => createAndChoose(q, 'org', target, (c) => { chosen = c; results.hidden = true; }) }, `+ Create org "${q}"`));
        results.hidden = false;
      } catch (err) { reportError(err); }
    }, 220);
  });

  addBtn.addEventListener('click', async () => {
    if (!chosen) { toast('Pick a contact from the list (or create one) first.', true); return; }
    const type = typeSel.value;
    const body = type === 'custom' ? { to_entity_id: chosen.id, raw_label: target.value.trim() || 'related' } : { to_entity_id: chosen.id, relation_type: type };
    try { await api('POST', `/api/v1/entities/${id}/relations`, { body }); toast('Relationship added.'); await selectContact(id); }
    catch (err) { reportError(err); }
  });

  // Add button between the type dropdown and the target field (#127).
  return el('div', {}, el('div', { class: 'addrel' }, typeSel, addBtn, el('div', { class: 'reltarget' }, target, results)));
}

async function createAndChoose(name, kind, targetInput, cb) {
  try {
    const { id } = await api('POST', '/api/v1/entities', { body: { kind, canonical_name: name } });
    targetInput.value = name;
    toast(`Created ${kind} "${name}".`);
    loadList();
    cb({ id, name });
  } catch (err) { reportError(err); }
}

async function removeRelation(entityId, relationId, r) {
  if (relationId == null) { toast('Cannot remove: missing relation id.', true); return; }
  try { await api('DELETE', `/api/v1/entities/${entityId}/relations/${relationId}`, {}); toast('Relationship removed.'); await selectContact(entityId); }
  catch (err) { reportError(err); }
}

// --- duplicates + merge (#120) ---
// Consumes GET /api/v1/entities/duplicates and POST /api/v1/entities/merge (server-owned; connectors
// may never merge — contract §1.2). Merge is one-way: the absorbed id is tombstoned (entities.merged_into),
// never deleted, so the survivor is the user's explicit choice.
// Focus management for the role=dialog overlay: move focus into the panel on open and restore it
// to whatever was focused (the Duplicates button, or a toast action) on close.
let dupReturnFocus = null;
// prefillAbsorbId (#303): seeds the manual-merge Absorb picker with the conflicting contact from a
// 409 ALIAS_CONFLICT toast action, turning that dead-end into the actual fix. Fetches the name for
// display only when prefilling — the no-arg topbar-button path (unchanged) never makes this call.
async function openDuplicates(prefillAbsorbId, { fromHistory = false } = {}) {
  // Captured before closeAllPanels (#521): if another panel is open, closing it restores ITS return
  // focus, which would otherwise clobber activeElement before we get to read it here. Also captures
  // whether this panel was already the open one, so a re-click doesn't stack a redundant history
  // entry — same "changed" check selectContact makes for the contact param (app.js:174).
  const returnFocus = document.activeElement;
  const alreadyOpen = panelFromUrl() === 'duplicates';
  closeAllPanels();
  dupReturnFocus = returnFocus;
  $('dupPanel').hidden = false;
  $('dupClose').focus();
  loadDuplicates();
  // Written here, before the prefill `await` below (#521): the URL doesn't depend on the prefill
  // fetch succeeding, and writing it only after that `await` would let a since-superseded call (the
  // user switched panels, or closed this one, while the fetch was in flight) clobber whatever newer
  // panel state was written in the meantime.
  setPanelInUrl('duplicates', { push: !fromHistory && !alreadyOpen });
  // Both pickers are module-scope (built once, not per-open), so a prior session's picks would
  // otherwise still be sitting there — a stale Keep alongside a freshly-prefilled Absorb is exactly
  // the "merge the wrong pair by accident" footgun a manual merge tool must not have.
  dupKeepPicker.clear();
  dupAbsorbPicker.clear();
  if (prefillAbsorbId != null) {
    try {
      const { entity } = await api('GET', `/api/v1/entities/${prefillAbsorbId}`);
      dupAbsorbPicker.setValue(prefillAbsorbId, `${entity.canonical_name} (${entity.kind})`);
    } catch (err) { console.error('openDuplicates: failed to fetch prefill entity name', err); dupAbsorbPicker.setValue(prefillAbsorbId, null); }
  }
}
function closeDuplicates() {
  $('dupPanel').hidden = true;
  if (dupReturnFocus && typeof dupReturnFocus.focus === 'function') dupReturnFocus.focus();
  dupReturnFocus = null;
}

// Manual merge (#303): the detector only surfaces a Merge button for pairs it happened to find
// (shared phone/email, or similar names) — this lets a user name ANY two contacts, unfiltered by
// kind (an org<->org pair, or a 409 alias-conflict pair the detector never paired). Reuses the
// existing debounced-search idiom from buildAddRelation (:297) rather than inventing a second one.
function contactPicker(labelText) {
  const input = el('input', { type: 'text', placeholder: 'Search contacts…' });
  const results = el('div', { class: 'results', hidden: true });
  let pickedId = null;
  let searchTimer;
  // A staleness token, bumped on every keystroke (including the empty-query early return) — a
  // slower earlier search resolving after a newer one (or after the field was cleared) must not
  // stomp the results list with results for a query the user no longer has typed.
  let searchToken = 0;
  input.addEventListener('input', () => {
    pickedId = null;
    clearTimeout(searchTimer);
    const q = input.value.trim();
    const myToken = ++searchToken;
    if (!q) { results.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const { entities } = await api('GET', `/api/v1/entities?query=${encodeURIComponent(q)}&limit=8`);
        if (myToken !== searchToken) return; // superseded by a later keystroke or a clear
        results.replaceChildren();
        for (const e of entities) {
          const label = `${e.canonical_name} (${e.kind}) #${e.id}`;
          const choose = () => { pickedId = e.id; input.value = label; results.hidden = true; };
          results.append(el('div', {
            role: 'option', tabindex: '0',
            onclick: choose,
            onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); } },
          }, label));
        }
        results.hidden = entities.length === 0;
      } catch (err) { reportError(err); }
    }, 220);
  });
  return {
    root: el('div', { class: 'reltarget' }, el('label', {}, labelText), input, results),
    getId: () => pickedId,
    getRaw: () => ({ id: pickedId, label: input.value }),
    setValue(id, name) { pickedId = id; input.value = name != null ? `${name} #${id}` : `#${id}`; results.hidden = true; },
    setRaw({ id, label }) { pickedId = id; input.value = label; results.hidden = true; },
    clear() { pickedId = null; input.value = ''; results.hidden = true; },
  };
}

const dupKeepPicker = contactPicker('Keep');
const dupAbsorbPicker = contactPicker('Absorb');
const dupSwapBtn = el('button', { type: 'button', class: 'ghost', title: 'Swap Keep and Absorb' }, '⇅');
const dupMergeBtn = el('button', { type: 'button', class: 'primary' }, 'Merge');
dupSwapBtn.addEventListener('click', () => {
  const keep = dupKeepPicker.getRaw(), absorb = dupAbsorbPicker.getRaw();
  dupKeepPicker.setRaw(absorb);
  dupAbsorbPicker.setRaw(keep);
});
dupMergeBtn.addEventListener('click', async () => {
  const keepId = dupKeepPicker.getId(), absorbId = dupAbsorbPicker.getId();
  if (keepId == null || absorbId == null) { toast('Pick a contact for both Keep and Absorb.', true); return; }
  if (keepId === absorbId) { toast('Keep and Absorb must be different contacts.', true); return; }
  if (await mergePair(keepId, absorbId)) { dupKeepPicker.clear(); dupAbsorbPicker.clear(); }
});
$('dupManual').append(
  el('h3', {}, 'Merge two contacts manually'),
  el('div', { class: 'dup-manual-row' }, dupKeepPicker.root, dupAbsorbPicker.root, dupSwapBtn, dupMergeBtn),
);

async function loadDuplicates() {
  try {
    // renderDuplicates rebuilds #dupList from scratch (replaceChildren), and the Clear button may
    // get hidden right after the user just clicked it — either detaches focus from whatever the
    // panel's Escape-to-close keydown listener needs it to stay on. Restore it to a stable anchor
    // rather than silently dropping focus to <body>.
    const focusWasInPanel = $('dupList').contains(document.activeElement) || document.activeElement === $('dupClearDismissed');
    const { pairs = [], dismissed_count = 0 } = await api('GET', '/api/v1/entities/duplicates?limit=50');
    renderDuplicates(pairs, dismissed_count);
    const clearBtn = $('dupClearDismissed');
    clearBtn.hidden = dismissed_count === 0;
    clearBtn.textContent = `Clear ${dismissed_count} dismissal${dismissed_count === 1 ? '' : 's'}`;
    if (focusWasInPanel) $('dupClose').focus();
  } catch (err) { reportError(err); }
}

// Word-level common-prefix/common-suffix split for the Duplicates panel's name emphasis (#394).
// Pure (no DOM/API): case-insensitive word compare, original casing kept in the output. Names that
// are equal or share no word return the whole string as `lead` with an empty `diff`, so "nothing in
// common" renders as no emphasis rather than the whole name lighting up.
function nameDiffParts(a, b) {
  const wordsA = String(a).trim().split(/\s+/).filter(Boolean);
  const wordsB = String(b).trim().split(/\s+/).filter(Boolean);
  let prefixLen = 0;
  while (prefixLen < wordsA.length && prefixLen < wordsB.length &&
    wordsA[prefixLen].toLowerCase() === wordsB[prefixLen].toLowerCase()) prefixLen++;
  let suffixLen = 0;
  while (suffixLen < wordsA.length - prefixLen && suffixLen < wordsB.length - prefixLen &&
    wordsA[wordsA.length - 1 - suffixLen].toLowerCase() === wordsB[wordsB.length - 1 - suffixLen].toLowerCase()) suffixLen++;
  // Whitespace-collapsed, same as the split path below — the two returns must not differ in shape,
  // or a future caller that reads `lead` on this branch gets the raw input back (PR #399 review).
  if (prefixLen === 0 && suffixLen === 0) {
    return { a: { lead: wordsA.join(' '), diff: '', trail: '' }, b: { lead: wordsB.join(' '), diff: '', trail: '' } };
  }
  const split = (words) => ({
    lead: words.slice(0, prefixLen).join(' '),
    diff: words.slice(prefixLen, words.length - suffixLen).join(' '),
    trail: words.slice(words.length - suffixLen).join(' '),
  });
  return { a: split(wordsA), b: split(wordsB) };
}

function renderDuplicates(pairs, dismissedCount = 0) {
  const wrap = $('dupList');
  wrap.replaceChildren();
  if (!pairs.length) {
    wrap.append(el('p', { class: 'empty' }, dismissedCount ? `No probable duplicates. (${dismissedCount} dismissed)` : 'No probable duplicates.'));
    return;
  }
  for (const p of pairs) {
    // A radio per side picks the survivor (default: the first, higher-ranked side); the other is absorbed.
    const grp = `keep-${p.a.id}-${p.b.id}`;
    const inputA = el('input', { type: 'radio', name: grp, checked: true });
    const inputB = el('input', { type: 'radio', name: grp });
    // Both names present -> emphasize the differing word run (#394); either missing (falls back to
    // #id) -> nothing to diff, render plain.
    const diff = p.a.name && p.b.name ? nameDiffParts(p.a.name, p.b.name) : null;
    const choice = (input, side, parts) => {
      const nameSpan = parts && parts.diff
        ? el('span', { class: 'dup-name' }, parts.lead && `${parts.lead} `, el('strong', { class: 'dup-diff' }, parts.diff), parts.trail && ` ${parts.trail}`)
        : el('span', { class: 'dup-name' }, side.name || `#${side.id}`);
      // Per-side emails/phones/linked-artifacts (#404) so a merge decision doesn't require
      // opening both contacts.
      const statsSpan = el('span', { class: 'dup-stats' }, `${side.email_count ?? 0} email, ${side.phone_count ?? 0} phone, ${side.link_count ?? 0} linked`);
      return el('label', { class: 'dup-choice' }, input, nameSpan, statsSpan, el('span', { class: 'dup-id' }, `#${side.id}`));
    };
    const mergeBtn = el('button', { type: 'button', class: 'primary' }, 'Merge');
    mergeBtn.addEventListener('click', () => {
      const keepId = inputA.checked ? p.a.id : p.b.id;
      const absorbId = inputA.checked ? p.b.id : p.a.id;
      mergePair(keepId, absorbId);
    });
    // No confirm() — a dismissal is cheap and undoable (Clear dismissals), matching the Proposed
    // panel's Reject (no confirm) vs Approve (confirm) split.
    const dismissBtn = el('button', { type: 'button' }, 'Not a duplicate');
    dismissBtn.addEventListener('click', () => dismissPair(p.a.id, p.b.id, p.score, p.reason));
    wrap.append(el('div', { class: 'dup-pair' },
      el('div', { class: 'dup-top' }, el('span', { class: 'dup-score' }, String(p.score)), el('span', { class: 'dup-reason' }, p.reason || '')),
      // Stacked rows, not side-by-side columns (#394): see .dup-choices/.dup-choice in style.css for
      // why -- a future widening here would silently re-introduce the far-apart-names gap.
      el('div', { class: 'dup-choices' }, choice(inputA, p.a, diff && diff.a), choice(inputB, p.b, diff && diff.b)),
      el('div', { class: 'dup-actions' }, el('span', { class: 'hint' }, 'Keep the selected contact; the other is merged in (one-way).'), mergeBtn, dismissBtn)));
  }
}

// Returns true on a completed merge, false on cancel/error — callers that need to react only on
// success (e.g. #303's manual-merge form clearing its pickers) check the return value.
async function mergePair(keepId, absorbId) {
  if (!confirm(`Merge contact #${absorbId} into #${keepId}? This is one-way and cannot be undone.`)) return false;
  try {
    const { moved = {} } = await api('POST', '/api/v1/entities/merge', { body: { keep_id: keepId, absorb_id: absorbId } });
    toast(`Merged: ${moved.aliases || 0} aliases, ${moved.links || 0} links, ${moved.relations || 0} relations.`);
    // If the open contact was the one absorbed, its detail is now a tombstone — follow to the survivor.
    if (currentId === absorbId) selectContact(keepId);
    loadList();
    loadDuplicates();
    return true;
  } catch (err) { reportError(err); return false; }
}

async function dismissPair(aId, bId, score, reason) {
  try {
    await api('POST', '/api/v1/entities/duplicates/dismiss', { body: { a_id: aId, b_id: bId, score, reason } });
    toast('Marked as not a duplicate.');
    loadDuplicates();
  } catch (err) { reportError(err); }
}

async function clearDismissals() {
  if (!confirm('Clear all dismissals? Every dismissed pair will reappear in this list.')) return;
  try {
    const { cleared = 0 } = await api('DELETE', '/api/v1/entities/duplicates/dismissals', {});
    toast(`Cleared ${cleared} dismissal(s).`);
    loadDuplicates();
  } catch (err) { reportError(err); }
}

$('duplicates').addEventListener('click', () => openDuplicates());
// Explicit close (#521): only the outer close action writes the URL, and only when the URL still
// names this panel — a close that fired after some other panel already took over the param (e.g. a
// stray keydown racing a fresh open) must not clobber that newer state.
$('dupClose').addEventListener('click', () => { closeDuplicates(); if (panelFromUrl() === 'duplicates') setPanelInUrl(null); });
$('dupClearDismissed').addEventListener('click', clearDismissals);
// Escape closes the dialog (focus is inside the panel while it's open, so the handler receives it).
$('dupPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDuplicates(); if (panelFromUrl() === 'duplicates') setPanelInUrl(null); } });

// --- proposed entities review (#143) ---
// Human-approval gate for auto-proposed person/org entities (#119 proposed_entities table): email
// senders, OCR'd doc vendors, etc. land as status='pending' instead of silently minting a contact.
// Consumes GET /api/v1/entities/proposed + POST /api/v1/entities/proposed/:id/{approve,reject}. Approve
// mints (or links to an existing) entity and returns {entity_id}; Reject marks it rejected
// (append-only — a re-ingest never re-raises it). Same drawer/focus discipline as #dupPanel.
let propReturnFocus = null;
// Status filter (#300): default 'pending' preserves the drawer's original behavior. 'rejected' is
// what makes the reopen-able backlog (168+ directory-backfill rows) visible at all — previously
// there was no way to see, count, or recover them once rejected.
let propStatus = 'pending';
let propSelected = new Set();
function openProposed({ fromHistory = false } = {}) {
  const returnFocus = document.activeElement; // captured before closeAllPanels, see openDuplicates
  const alreadyOpen = panelFromUrl() === 'proposed'; // avoid a redundant history entry on a re-click
  closeAllPanels();
  propReturnFocus = returnFocus;
  $('propPanel').hidden = false;
  $('propClose').focus();
  loadProposed();
  setPanelInUrl('proposed', { push: !fromHistory && !alreadyOpen });
}
function closeProposed() {
  $('propPanel').hidden = true;
  if (propReturnFocus && typeof propReturnFocus.focus === 'function') propReturnFocus.focus();
  propReturnFocus = null;
}

async function loadProposed() {
  try {
    propSelected = new Set();
    updateReopenSelectedBtn();
    const { proposals = [] } = await api('GET', `/api/v1/entities/proposed?status=${propStatus}&limit=50`);
    renderProposed(proposals);
  } catch (err) { reportError(err); }
}

function updateReopenSelectedBtn() {
  const btn = $('propReopenSelected');
  btn.hidden = propStatus !== 'rejected';
  btn.textContent = `Reopen selected (${propSelected.size})`;
  btn.disabled = propSelected.size === 0;
}

function renderProposed(proposals) {
  const wrap = $('propList');
  wrap.replaceChildren();
  if (!proposals.length) { wrap.append(el('p', { class: 'empty' }, `No ${propStatus} proposals.`)); return; }
  for (const p of proposals) {
    const actions = [];
    if (propStatus === 'rejected') {
      const checkbox = el('input', { type: 'checkbox', 'aria-label': `Select proposal #${p.id}`,
        onchange: (e) => { e.target.checked ? propSelected.add(p.id) : propSelected.delete(p.id); updateReopenSelectedBtn(); } });
      actions.push(checkbox, el('button', { type: 'button', class: 'primary', onclick: () => reopenProposals([p.id]) }, 'Reopen'));
    } else if (propStatus === 'pending') {
      actions.push(
        el('button', { type: 'button', class: 'primary', onclick: () => approveProposal(p.id) }, 'Approve'),
        el('button', { type: 'button', class: 'danger', onclick: () => rejectProposal(p.id) }, 'Reject'));
    }
    wrap.append(el('div', { class: 'dup-pair' },
      el('div', { class: 'dup-top' },
        el('span', { class: 'kind-badge' }, p.suggested_kind || '?'),
        el('span', { class: 'dup-name' }, p.suggested_name || `#${p.id}`),
        el('span', { class: 'dup-id' }, `#${p.id}`)),
      el('div', { class: 'prop-fields' },
        el('span', {}, `${p.alias} (${p.alias_type})`),
        el('span', { class: 'dup-reason' }, `source: ${p.source ?? '—'}`),
        el('span', { class: 'dup-reason' }, `confidence: ${p.confidence ?? '—'}`),
        el('span', { class: 'dup-reason' }, `${p.evidence_count} artifact(s)`),
        el('span', { class: 'dup-reason' }, p.created_at || '')),
      el('div', { class: 'dup-actions' }, ...actions)));
  }
}

async function approveProposal(id) {
  if (!confirm(`Approve proposal #${id}? This mints (or links) a contact in the graph.`)) return;
  try {
    const { entity_id } = await api('POST', `/api/v1/entities/proposed/${id}/approve`, {});
    // Same outer-close discipline as propClose/Escape (#521): this "View" action is a deliberate
    // dismissal of the panel, not an internal open*-driven close, so it clears the URL too.
    toast(`Approved → contact #${entity_id}.`, false, { label: 'View', onClick: () => { closeProposed(); if (panelFromUrl() === 'proposed') setPanelInUrl(null); selectContact(entity_id); } });
    loadProposed();
    loadList();
  } catch (err) { reportError(err); loadProposed(); } // 409 already-resolved / 404: surface + drop the stale row
}

async function rejectProposal(id) {
  try {
    await api('POST', `/api/v1/entities/proposed/${id}/reject`, {});
    toast('Proposal rejected.');
    loadProposed();
  } catch (err) { reportError(err); loadProposed(); } // 409 already-approved / 404: surface + re-fetch
}

// Reopen (#300): rejected → pending. Always the bulk endpoint, even for a single id, so there's one
// code path; per-item isolation means a stale/already-resolved id in the batch can't block the rest.
async function reopenProposals(ids) {
  if (!confirm(`Reopen ${ids.length} proposal(s)? They'll move back to the Pending queue.`)) return;
  try {
    const { reopened = 0 } = await api('POST', '/api/v1/entities/proposed/reopen', { body: { ids } });
    toast(`Reopened ${reopened} proposal(s).`);
    loadProposed();
  } catch (err) { reportError(err); loadProposed(); }
}

// #162: stage proposals from the side contact directory (#154) into the queue, then refresh it.
async function stageFromDirectory() {
  try {
    const { scanned = 0, proposed = 0 } = await api('POST', '/api/v1/entities/proposed/stage-from-directory', {});
    toast(`Staged ${proposed} proposal(s) from directory (${scanned} handle(s) scanned).`);
    loadProposed();
  } catch (err) { reportError(err); }
}

$('proposed').addEventListener('click', () => openProposed());
$('propStage').addEventListener('click', stageFromDirectory);
$('propClose').addEventListener('click', () => { closeProposed(); if (panelFromUrl() === 'proposed') setPanelInUrl(null); });
$('propPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeProposed(); if (panelFromUrl() === 'proposed') setPanelInUrl(null); } });
const reloadProposedDebounced = debounce(loadProposed, FILTER_RELOAD_DEBOUNCE_MS);
wireRadioGroup($('propStatusFilter'), (b) => { propStatus = b.dataset.status; reloadProposedDebounced(); });
$('propReopenSelected').addEventListener('click', () => reopenProposals([...propSelected]));

// --- side contact directory (#299) ---
// Browse the loaded contacts export (GET /api/v1/directory) and promote entries into the curated
// graph (POST /api/v1/directory/promote). Promotion here is DIRECT, not via the proposed queue: the
// directory is the user's own vCard export, so browsing and clicking IS the approval. Rows arrive
// ordered by impact — the artifacts promoting would retro-link — because 1,569 names cannot be
// triaged alphabetically. Already-curated names come back greyed rather than hidden, so "done" is
// visible. Same drawer/focus discipline as #dupPanel/#propPanel.
const DIR_PAGE_SIZES = [10, 25, 50, 100];
const DIR_PAGE_SIZE_DEFAULT = 50;
let dirPageLimit = DIR_PAGE_SIZE_DEFAULT;
const DIR_SEARCH_DEBOUNCE_MS = 220;
let dirReturnFocus = null;
let dirSelected = new Set();
let dirSearchTimer;
// Offset of the last SUCCESSFULLY rendered page (#494) — only ever assigned right before the
// renderDirectory() call that used it, never optimistically by a click handler. That's what makes a
// failed fetch a no-op on the visible page/offset instead of silently skipping or repeating one, and
// (combined with dirRequestId below) what stops an out-of-order response from painting stale button/
// range state over a newer page.
let dirOffset = 0;
// Monotonic token: bumped on every loadDirectory() call, checked before acting on its response. Two
// overlapping requests (Next clicked, then Prev before the first resolves; or the search debounce
// firing while a page-change request is still in flight) can resolve out of order — only the response
// whose token still matches the latest call is applied; an older one is dropped, success or error.
let dirRequestId = 0;

function openDirectory(prefillQuery = '', { fromHistory = false } = {}) {
  const returnFocus = document.activeElement; // captured before closeAllPanels, see openDuplicates
  const alreadyOpen = panelFromUrl() === 'directory'; // avoid a redundant history entry on a re-click
  closeAllPanels();
  dirReturnFocus = returnFocus;
  $('dirPanel').hidden = false;
  if (prefillQuery) $('dirSearch').value = prefillQuery;
  $('dirClose').focus();
  // Page size is not persisted across sessions (#523) — always reset to the default on open. Passed
  // into loadDirectory rather than assigned here (Copilot review, PR #525) so it only takes effect
  // once this fetch actually succeeds — an eager reset here left the page-size selects showing 50
  // while a failed fetch left the list/range/buttons still showing the PREVIOUS session's page.
  loadDirectory(0, DIR_PAGE_SIZE_DEFAULT);
  setPanelInUrl('directory', { push: !fromHistory && !alreadyOpen });
}
function closeDirectory() {
  $('dirPanel').hidden = true;
  if (dirReturnFocus && typeof dirReturnFocus.focus === 'function') dirReturnFocus.focus();
  dirReturnFocus = null;
}

// The selection is dropped on every successful (re)load: after a promote or a search the rows on
// screen are a different set, and silently promoting a name scrolled out of view is the kind of
// surprise this panel exists to avoid. `offset` defaults to the last-rendered page (a plain reload,
// e.g. after a promote) rather than the module-level dirOffset directly, so callers that ARE changing
// page (Prev/Next/search-reset) pass it explicitly instead of mutating shared state before the fetch
// even starts.
// `limit` defaults to the last-committed dirPageLimit for the same reason `offset` defaults to
// dirOffset (#523): a caller that IS changing page size (the select's change handler) passes it
// explicitly, so it can go through the same commit-only-on-success path as offset below, rather
// than the select's handler mutating dirPageLimit itself before the fetch even starts.
async function loadDirectory(offset = dirOffset, limit = dirPageLimit) {
  const requestId = ++dirRequestId;
  const q = $('dirSearch').value.trim();
  try {
    // Fetch one row past the page so "is there a next page" is a fact observed from THIS response,
    // never inferred from the count (Copilot review, PR #517): during a search total_names/total_rows
    // are directory-wide, not scoped to the query, so they can't answer it — and inferring from
    // "this page came back short" breaks exactly when the filtered match count is a multiple of
    // limit (a full last page never looks short). The extra row is trimmed before display.
    const { candidates: raw = [], total_names = 0, total_rows = 0 } =
      await api('GET', `/api/v1/directory?limit=${limit + 1}&offset=${offset}${q ? `&query=${encodeURIComponent(q)}` : ''}`);
    if (requestId !== dirRequestId) return; // superseded by a newer call — its own response will render
    const hasMore = raw.length > limit;
    const candidates = raw.slice(0, limit);
    // A page can come back empty at a nonzero offset (e.g. double-clicking Next past the true end
    // before the disabled state catches up) — step back one page and retry rather than showing a
    // blank drawer. Recursion is bounded: offset strictly decreases by limit toward 0, and reaching
    // 0 with still-empty results just renders the (legitimately empty) result normally.
    if (!candidates.length && offset > 0) return loadDirectory(Math.max(0, offset - limit), limit);
    dirOffset = offset; // commit only now that its fetch has actually succeeded
    dirPageLimit = limit; // ditto — a page-size change that fails must not leave the UI showing a size nothing was fetched at
    dirSelected = new Set();
    renderDirectory(candidates, total_names, total_rows, hasMore);
  } catch (err) { if (requestId === dirRequestId) reportError(err); } // ditto — a superseded failure isn't worth surfacing
}

function syncDirPromoteButton() {
  const btn = $('dirPromote');
  btn.textContent = `Promote selected (${dirSelected.size})`;
  btn.disabled = dirSelected.size === 0;
}

function renderDirectory(candidates, totalNames, totalRows, hasMore) {
  $('dirCount').textContent = `${totalNames.toLocaleString()} names · ${totalRows.toLocaleString()} handles`;
  syncDirPromoteButton();
  const wrap = $('dirList');
  wrap.replaceChildren();
  // Both pager bars (#523) render off one dirOffset/dirPageLimit pair — never independently — so
  // top and bottom can't drift out of sync. This runs only after loadDirectory has committed
  // dirPageLimit (i.e. the fetch succeeded), so a failed page-size change leaves both selects
  // showing the still-correct, previously-committed size rather than the one that was tried.
  const rangeEls = [$('dirRangeTop'), $('dirRangeBottom')];
  const prevBtns = [$('dirPrevTop'), $('dirPrevBottom')];
  const nextBtns = [$('dirNextTop'), $('dirNextBottom')];
  const pageSizeSels = [$('dirPageSizeTop'), $('dirPageSizeBottom')];
  for (const s of pageSizeSels) s.value = String(dirPageLimit);
  if (!candidates.length) {
    wrap.append(el('p', { class: 'empty' }, totalRows ? 'No directory entries match that search.' : 'No directory loaded — run: npm run directory:load <file.vcf>'));
    for (const r of rangeEls) r.textContent = '';
    for (const b of prevBtns) b.disabled = true;
    for (const b of nextBtns) b.disabled = true;
    return;
  }
  const from = dirOffset + 1;
  const to = dirOffset + candidates.length;
  // total_names/total_rows are directory-WIDE totals (#299) — not scoped to an active search — so
  // during a search "of totalNames" would be a lie. `hasMore` (loadDirectory's extra-row fetch) is
  // what actually decides Next in both modes; it's the one signal that doesn't break on a filtered
  // match count that happens to be an exact multiple of dirPageLimit (Copilot review, PR #517).
  const hasQuery = $('dirSearch').value.trim().length > 0;
  const rangeText = hasQuery
    ? `Showing ${from.toLocaleString()}–${to.toLocaleString()}`
    : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${totalNames.toLocaleString()}`;
  for (const r of rangeEls) r.textContent = rangeText;
  for (const b of prevBtns) b.disabled = dirOffset === 0;
  for (const b of nextBtns) b.disabled = !hasMore;
  for (const c of candidates) {
    const curated = c.entity_id != null;
    const impact = c.impact?.artifacts ?? 0;
    // A curated row is NOT necessarily finished: the contact can exist by name while some of the
    // directory's handles were never aliased to it, leaving staged history unlinked (one live example
    // holds 1,155 linkable artifacts). Promoting then reuses the entity, adds the missing handles and
    // links that history — so selection is disabled only when there is genuinely nothing left to do
    // (Copilot, PR #314).
    const done = curated && impact === 0;
    const check = el('input', { type: 'checkbox', disabled: done, onchange: (e) => { if (e.target.checked) dirSelected.add(c.name); else dirSelected.delete(c.name); syncDirPromoteButton(); } });
    const name = curated
      // Already curated: click through to the contact rather than offering a no-op promote.
      // Same outer-close discipline as dirClose/Escape (#521) — this click is a deliberate exit
      // from the panel, not an internal open*-driven close, so it clears the URL too.
      ? el('button', { type: 'button', class: 'linklike dup-name', onclick: () => { closeDirectory(); if (panelFromUrl() === 'directory') setPanelInUrl(null); selectContact(c.entity_id); } }, c.name)
      : el('span', { class: 'dup-name' }, c.name);
    wrap.append(el('div', { class: done ? 'dup-pair dir-row curated' : 'dup-pair dir-row' },
      el('div', { class: 'dup-top' },
        check, name,
        el('span', { class: 'dir-impact' }, impact ? `${impact.toLocaleString()} artifacts` : 'no history'),
        curated ? el('span', { class: 'dup-id' }, `#${c.entity_id}`) : null),
      el('div', { class: 'dir-handles' }, (c.handles ?? []).map((h) => el('span', { class: 'dup-reason' }, `${h.handle} (${h.handle_type})`))),
      el('div', { class: 'dup-actions' },
        done
          ? el('span', { class: 'dup-reason' }, 'already a contact')
          // Honest label: for an existing contact this adds the missing handles and links their
          // history rather than creating anything.
          : el('button', { type: 'button', onclick: () => promoteNames([c.name]) }, curated ? 'Link history' : 'Promote'),
        curated && !done ? el('span', { class: 'dup-reason' }, `already contact #${c.entity_id}`) : null,
        el('span', { class: 'dup-reason' }, `${c.impact?.name_hints ?? 0} name · ${c.impact?.handle_hints ?? 0} handle hints`))));
  }
}

async function promoteNames(names) {
  if (!names.length) return;
  const label = names.length === 1 ? `"${names[0]}"` : `${names.length} contacts`;
  if (!confirm(`Promote ${label} into the contact graph? This creates the contact(s) and links their history.`)) return;
  try {
    const { results = [] } = await api('POST', '/api/v1/directory/promote', { body: { names } });
    // Per-item isolation is the server contract, so report both halves rather than a bare success.
    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const linked = ok.reduce((n, r) => n + (r.linked ?? 0), 0);
    const skipped = ok.reduce((n, r) => n + (r.skipped_handles?.length ?? 0), 0);
    const parts = [`Promoted ${ok.length} contact(s), linked ${linked.toLocaleString()} artifact(s).`];
    if (skipped) parts.push(`${skipped} handle(s) already belong to another contact.`);
    if (failed.length) parts.push(`${failed.length} failed: ${failed.map((r) => `${r.name} (${r.error})`).join(', ')}.`);
    const single = ok.length === 1 ? ok[0] : null;
    // Same outer-close discipline as the two sites above (#521).
    toast(parts.join(' '), failed.length > 0, single ? { label: 'View', onClick: () => { closeDirectory(); if (panelFromUrl() === 'directory') setPanelInUrl(null); selectContact(single.entity_id); } } : null);
    loadDirectory();
    loadList();
  } catch (err) { reportError(err); }
}

$('directory').addEventListener('click', () => openDirectory());
$('dirClose').addEventListener('click', () => { closeDirectory(); if (panelFromUrl() === 'directory') setPanelInUrl(null); });
$('dirPromote').addEventListener('click', () => promoteNames([...dirSelected]));
$('dirPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDirectory(); if (panelFromUrl() === 'directory') setPanelInUrl(null); } });
$('dirSearch').addEventListener('input', () => {
  // A new query is a new result set — reset to page 0, but only via the loadDirectory(offset) param
  // (never by pre-assigning dirOffset), so a failed/superseded request can't leave dirOffset pointing
  // at a page that was never actually rendered (#494 persona review).
  clearTimeout(dirSearchTimer);
  dirSearchTimer = setTimeout(() => loadDirectory(0), DIR_SEARCH_DEBOUNCE_MS);
});
for (const id of ['dirPrevTop', 'dirPrevBottom']) $(id).addEventListener('click', () => loadDirectory(Math.max(0, dirOffset - dirPageLimit)));
for (const id of ['dirNextTop', 'dirNextBottom']) $(id).addEventListener('click', () => loadDirectory(dirOffset + dirPageLimit));
// Changing either select resets to offset 0 (#523): a stale offset computed under the old page size
// lands on an arbitrary/misaligned position under the new one, same reasoning as a new search
// resetting to page 0 (#494). Both selects are synced to the new value OPTIMISTICALLY, immediately
// (Copilot review, PR #525) — never two independently-tracked selects, same invariant as the
// Prev/Next pairs above — rather than waiting for the fetch, which would leave the two visibly
// disagreeing for the length of the request. `dirPageLimit` itself is still only committed once
// loadDirectory's fetch actually succeeds (mirroring dirOffset's commit-only-on-success discipline);
// if it fails (or is superseded before it resolves), dirPageLimit is left exactly where it was, so
// reverting BOTH selects back to it afterward un-does the failed optimistic update on both sides,
// not just the one the user touched.
for (const id of ['dirPageSizeTop', 'dirPageSizeBottom']) {
  $(id).addEventListener('change', async (e) => {
    const size = Number(e.target.value);
    // Revert BOTH selects, not just the one that fired (Copilot review, PR #525): the top/bottom
    // pair must never visibly disagree, even on this defensive branch.
    if (!DIR_PAGE_SIZES.includes(size)) { for (const otherId of ['dirPageSizeTop', 'dirPageSizeBottom']) $(otherId).value = String(dirPageLimit); return; }
    for (const otherId of ['dirPageSizeTop', 'dirPageSizeBottom']) $(otherId).value = String(size);
    await loadDirectory(0, size);
    if (dirPageLimit !== size) for (const otherId of ['dirPageSizeTop', 'dirPageSizeBottom']) $(otherId).value = String(dirPageLimit); // never committed — revert both
  });
}

// --- new contact (#329) ---
// Replaces the old prompt()/confirm() flow: confirm() can only ever show generic OK/Cancel buttons,
// so the org/person mapping was invisible — and backwards besides (OK mapped to the less-common
// org). Same drawer + focus-management pattern as #dupPanel/#propPanel/#dirPanel; kind toggle mirrors
// the #kindFilter radiogroup idiom (#332). Person is the default kind (the more common case).
let newContactReturnFocus = null, newContactKind = 'person';
function openNewContact() {
  newContactReturnFocus = document.activeElement;
  $('newContactName').value = '';
  newContactKind = 'person';
  selectInGroup($('newContactKind'), $('newContactKind').querySelector('[data-kind="person"]'));
  $('newContactCreate').disabled = false;
  $('newContactPanel').hidden = false;
  $('newContactName').focus();
}
function closeNewContact() {
  $('newContactPanel').hidden = true;
  if (newContactReturnFocus && typeof newContactReturnFocus.focus === 'function') newContactReturnFocus.focus();
  newContactReturnFocus = null;
}
async function createNewContact() {
  // Re-entry guard: Enter-to-submit calls this function directly, bypassing the native disabled-
  // button click suppression a mouse click gets for free — so a held/repeated Enter needs its own check.
  if ($('newContactCreate').disabled) return;
  const name = $('newContactName').value.trim();
  if (!name) { toast('Enter a name.', true); return; }
  // Unlike the old blocking prompt()/confirm(), this button doesn't block interaction — disable it
  // for the request's duration so a double-click (or a slow round-trip) can't mint two contacts.
  $('newContactCreate').disabled = true;
  try {
    const { id } = await api('POST', '/api/v1/entities', { body: { kind: newContactKind, canonical_name: name } });
    closeNewContact();
    await loadList();
    selectContact(id);
  } catch (err) { reportError(err); } finally { $('newContactCreate').disabled = false; }
}
$('newContact').addEventListener('click', openNewContact);
$('newContactClose').addEventListener('click', closeNewContact);
$('newContactPanel').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNewContact();
  else if (e.key === 'Enter' && e.target === $('newContactName')) { e.preventDefault(); createNewContact(); }
});
wireRadioGroup($('newContactKind'), (b) => { newContactKind = b.dataset.kind; });
$('newContactCreate').addEventListener('click', createNewContact);

// Top-bar Save (#127): saves the open contact via the current detail closure. Hidden until one is open.
$('saveTop').addEventListener('click', () => { if (currentSave) currentSave(); });

// --- search + filter wiring ---
const reloadListDebounced = debounce(loadList, FILTER_RELOAD_DEBOUNCE_MS);
$('search').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); reloadListDebounced(); });
// currentKind is assigned immediately (the debounced reload and the search box both read it); only the
// fetch waits, so holding an arrow key costs one request instead of one per auto-repeat.
wireRadioGroup($('kindFilter'), (b) => { currentKind = b.dataset.kind; reloadListDebounced(); });

// --- boot ---
// Token-only (#169): the page is only served at /<token>/ui/<file>, so apiKey() always resolves the
// credential from the path — nothing to bootstrap or prompt for. Load the contact list directly.
loadList();
// Deep link (#492): open ?contact=<id> alongside the list, not chained behind it — the detail fetch
// doesn't depend on the list, and the initial URL is already correct so it writes no history entry.
// A malformed value fetches nothing and is stripped, so a refresh isn't a second no-op.
const deepLinkedId = contactIdFromUrl();
if (deepLinkedId !== null) selectContact(deepLinkedId, { fromHistory: true });
else if (new URLSearchParams(location.search).has(CONTACT_PARAM)) setContactInUrl(null);
// Deep link (#521): same discipline as the contact param above, independent of it.
const deepLinkedPanel = panelFromUrl();
if (deepLinkedPanel !== null) openPanelByName(deepLinkedPanel, { fromHistory: true });
else if (new URLSearchParams(location.search).has(PANEL_PARAM)) setPanelInUrl(null);
