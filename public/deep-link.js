// Contacts-UI deep-link helpers (#492, extracted #497). The open contact is mirrored into a QUERY
// param, never a path segment: apiKey() in app.js parses the capability token out of
// location.pathname with a strict /<token>/ui/<file> match, so an extra path segment would leave
// the token unresolvable and 401 the whole page. Keyed on the entity id, since canonical_name is
// user-editable and non-unique. Zero DOM references beyond location/history so it's importable
// from a plain `node --test` (mirrors public/alias-keys.js, #334) — a caller running under Node
// stubs globalThis.location/history before calling these.
export const CONTACT_PARAM = 'contact';

// Safe-integer, not just /^\d+$/: a long-enough digit string parses to Infinity (and anything past
// 2^53 loses precision), which would otherwise reach the API as /api/v1/entities/Infinity.
export function contactIdFromUrl() {
  const raw = new URLSearchParams(location.search).get(CONTACT_PARAM);
  if (!/^\d+$/.test(raw || '')) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Rebuilt from a URLSearchParams copy rather than a literal `?contact=` so any unrelated param on
// the URL survives both setting and clearing. This helper mutates the query string only — the path
// carries the capability token and the hash is nobody's business here, so both are carried verbatim.
export function setContactInUrl(id, { push = false } = {}) {
  const params = new URLSearchParams(location.search);
  if (id === null) params.delete(CONTACT_PARAM); else params.set(CONTACT_PARAM, String(id));
  const query = params.toString();
  history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
}

// Deep-links the three drawer-opening panels (#521): Directory, Duplicates, Proposed. Independent of
// CONTACT_PARAM — same "each helper touches only its own param" discipline as above — so
// `?contact=42&panel=duplicates` coexist.
export const PANEL_PARAM = 'panel';
export const PANEL_NAMES = ['directory', 'duplicates', 'proposed'];

// An unrecognized value is treated as absent — never a console error or toast, mirroring
// contactIdFromUrl's safe-integer validation for a malformed contact id.
export function panelFromUrl() {
  const raw = new URLSearchParams(location.search).get(PANEL_PARAM);
  return PANEL_NAMES.includes(raw) ? raw : null;
}

export function setPanelInUrl(name, { push = false } = {}) {
  const params = new URLSearchParams(location.search);
  if (name === null) params.delete(PANEL_PARAM); else params.set(PANEL_PARAM, name);
  const query = params.toString();
  history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
}
