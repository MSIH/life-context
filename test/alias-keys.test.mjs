// aliasMatchKey / looksLikeEmailOrPhone (public/alias-keys.js, #334): pure display-side helpers,
// no DOM. Verifies the phone key mirrors normalizePhone's digit-strip + NANP leading-1 drop
// (src/db.js) closely enough that an attrs-typed number and its resolved entity_aliases twin
// collapse to the same key, and that looksLikeEmailOrPhone correctly gates the alias add box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasMatchKey, looksLikeEmailOrPhone } from '../public/alias-keys.js';

test('aliasMatchKey(phone): equivalent US formats collapse to the same key', () => {
  const expected = '2405550142';
  assert.equal(aliasMatchKey('(240) 555-0142', 'phone'), expected);
  assert.equal(aliasMatchKey('+1 240 555 0142', 'phone'), expected);
  assert.equal(aliasMatchKey('1-240-555-0142', 'phone'), expected);
  assert.equal(aliasMatchKey('2405550142', 'phone'), expected);
});

test('aliasMatchKey(phone): non-NANP international number is digit-stripped only, leading country code kept', () => {
  // +44 20 7946 0958 -> not an 11-digit-starting-with-1 number, so no digit is dropped.
  assert.equal(aliasMatchKey('+44 20 7946 0958', 'phone'), '442079460958');
});

test('aliasMatchKey(phone): 7-digit local number is left alone (untouched by NANP rule)', () => {
  assert.equal(aliasMatchKey('555-0148', 'phone'), '5550148');
});

test('aliasMatchKey(email/name): trims and lowercases', () => {
  assert.equal(aliasMatchKey('  Someone@Example.com  ', 'email'), 'someone@example.com');
  assert.equal(aliasMatchKey('  Betsy Allister  ', 'name'), 'betsy allister');
});

test('aliasMatchKey: unusable input returns empty string', () => {
  assert.equal(aliasMatchKey(null, 'email'), '');
  assert.equal(aliasMatchKey(undefined, 'phone'), '');
  assert.equal(aliasMatchKey('', 'phone'), '');
});

test('looksLikeEmailOrPhone: classifies an email address', () => {
  assert.equal(looksLikeEmailOrPhone('someone@example.com'), 'email');
});

test('looksLikeEmailOrPhone: classifies a formatted US phone number', () => {
  assert.equal(looksLikeEmailOrPhone('(240) 555-0142'), 'phone');
  assert.equal(looksLikeEmailOrPhone('+1 240 555 0142'), 'phone');
  assert.equal(looksLikeEmailOrPhone('240-555-0142'), 'phone');
});

test('looksLikeEmailOrPhone: returns null for names and IM-style handles', () => {
  assert.equal(looksLikeEmailOrPhone('Betsy'), null);
  assert.equal(looksLikeEmailOrPhone('betsy allister'), null);
  assert.equal(looksLikeEmailOrPhone('@betsy_handle'), null);
  assert.equal(looksLikeEmailOrPhone('betsy.on.signal'), null);
});

test('looksLikeEmailOrPhone: returns null for empty/whitespace input', () => {
  assert.equal(looksLikeEmailOrPhone(''), null);
  assert.equal(looksLikeEmailOrPhone('   '), null);
  assert.equal(looksLikeEmailOrPhone(null), null);
});
