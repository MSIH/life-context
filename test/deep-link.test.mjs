// contactIdFromUrl / setContactInUrl (public/deep-link.js, #492, extracted #497): pure apart from
// reading a stubbed global `location` and calling a stubbed global `history` — no real DOM/browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { CONTACT_PARAM, contactIdFromUrl, setContactInUrl, PANEL_PARAM, PANEL_NAMES, panelFromUrl, setPanelInUrl } from '../public/deep-link.js';

// Neither global exists in a plain Node process, so restore that absence once this file is done —
// otherwise the stubs leak into whatever runs next in the same process.
after(() => { delete globalThis.location; delete globalThis.history; });

function stubLocationAndHistory(url) {
  const u = new URL(url);
  globalThis.location = { pathname: u.pathname, search: u.search, hash: u.hash };
  const calls = [];
  globalThis.history = {
    pushState: (...args) => { calls.push(['pushState', ...args]); applyUrl(args[2]); },
    replaceState: (...args) => { calls.push(['replaceState', ...args]); applyUrl(args[2]); },
  };
  function applyUrl(urlStr) {
    const next = new URL(urlStr, 'http://example.test');
    globalThis.location.pathname = next.pathname;
    globalThis.location.search = next.search;
    globalThis.location.hash = next.hash;
  }
  return calls;
}

test('contactIdFromUrl: parses a valid id', () => {
  stubLocationAndHistory('http://example.test/tok/ui/contacts.html?contact=42');
  assert.equal(contactIdFromUrl(), 42);
});

test('contactIdFromUrl: null for non-numeric, empty, zero, negative, non-integer, and exponential values', () => {
  for (const raw of ['abc', '', '0', '-3', '1.5', '1e3']) {
    stubLocationAndHistory(`http://example.test/tok/ui/contacts.html${raw === '' ? '?contact=' : `?contact=${raw}`}`);
    assert.equal(contactIdFromUrl(), null, `expected null for raw=${JSON.stringify(raw)}`);
  }
});

test('contactIdFromUrl: null when the param is absent', () => {
  stubLocationAndHistory('http://example.test/tok/ui/contacts.html');
  assert.equal(contactIdFromUrl(), null);
});

test('setContactInUrl: pushState on a change, replaceState otherwise', () => {
  let calls = stubLocationAndHistory('http://example.test/tok/ui/contacts.html');
  setContactInUrl(5, { push: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'pushState');
  assert.equal(globalThis.location.search, `?${CONTACT_PARAM}=5`);

  calls = stubLocationAndHistory('http://example.test/tok/ui/contacts.html?contact=5');
  setContactInUrl(5); // re-click on the already-open contact: caller passes push:false (default)
  assert.equal(calls[0][0], 'replaceState');
});

test('setContactInUrl: an unrelated query param survives both set and clear', () => {
  const calls = stubLocationAndHistory('http://example.test/tok/ui/contacts.html?foo=bar');
  setContactInUrl(7, { push: true });
  assert.equal(globalThis.location.search, `?foo=bar&${CONTACT_PARAM}=7`);
  setContactInUrl(null);
  assert.equal(globalThis.location.search, '?foo=bar');
  assert.equal(calls.length, 2);
});

test('setContactInUrl: clearing a malformed value strips it via replaceState, growing no history entry', () => {
  const calls = stubLocationAndHistory('http://example.test/tok/ui/contacts.html?contact=abc');
  setContactInUrl(null); // default push:false
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'replaceState');
  assert.equal(globalThis.location.search, '');
});

// panelFromUrl / setPanelInUrl (#521): same helper shape as contact above, independent of it.
test('panelFromUrl: parses each allow-listed name', () => {
  for (const name of PANEL_NAMES) {
    stubLocationAndHistory(`http://example.test/tok/ui/contacts.html?${PANEL_PARAM}=${name}`);
    assert.equal(panelFromUrl(), name);
  }
});

test('panelFromUrl: null for an unrecognized or empty value, never an error', () => {
  for (const raw of ['bogus', '']) {
    stubLocationAndHistory(`http://example.test/tok/ui/contacts.html?${PANEL_PARAM}=${raw}`);
    assert.equal(panelFromUrl(), null, `expected null for raw=${JSON.stringify(raw)}`);
  }
});

test('panelFromUrl: null when the param is absent', () => {
  stubLocationAndHistory('http://example.test/tok/ui/contacts.html');
  assert.equal(panelFromUrl(), null);
});

test('setPanelInUrl: pushState on open, replaceState on a fromHistory-style re-apply', () => {
  let calls = stubLocationAndHistory('http://example.test/tok/ui/contacts.html');
  setPanelInUrl('duplicates', { push: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'pushState');
  assert.equal(globalThis.location.search, `?${PANEL_PARAM}=duplicates`);

  calls = stubLocationAndHistory('http://example.test/tok/ui/contacts.html?panel=duplicates');
  setPanelInUrl('duplicates'); // default push:false — the push:false half of app.js's push:!fromHistory
  assert.equal(calls[0][0], 'replaceState');
});

test('setPanelInUrl: coexists with an unrelated contact param independently in both directions', () => {
  const calls = stubLocationAndHistory(`http://example.test/tok/ui/contacts.html?${CONTACT_PARAM}=42`);
  setPanelInUrl('proposed', { push: true });
  assert.equal(globalThis.location.search, `?${CONTACT_PARAM}=42&${PANEL_PARAM}=proposed`);
  setPanelInUrl(null);
  assert.equal(globalThis.location.search, `?${CONTACT_PARAM}=42`);
  assert.equal(calls.length, 2);
});

test('setPanelInUrl: clearing removes the param via replaceState, growing no history entry', () => {
  const calls = stubLocationAndHistory(`http://example.test/tok/ui/contacts.html?${PANEL_PARAM}=directory`);
  setPanelInUrl(null); // default push:false
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'replaceState');
  assert.equal(globalThis.location.search, '');
});
