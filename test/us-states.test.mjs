// normalizeUsState (src/us-states.js): the pure US-state name<->USPS-code normalizer shared by
// geocode/build/search (#186). No DB, no I/O — just the map + the resolver's edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsState } from '../src/us-states.js';

test('normalizeUsState: resolves a full name (any case) to {code, name}', () => {
  assert.deepEqual(normalizeUsState('Texas'), { code: 'TX', name: 'Texas' });
  assert.deepEqual(normalizeUsState('texas'), { code: 'TX', name: 'Texas' });
  assert.deepEqual(normalizeUsState('TEXAS'), { code: 'TX', name: 'Texas' });
  assert.deepEqual(normalizeUsState('new york'), { code: 'NY', name: 'New York' });
});

test('normalizeUsState: resolves a 2-letter USPS code (any case) to {code, name}', () => {
  assert.deepEqual(normalizeUsState('tx'), { code: 'TX', name: 'Texas' });
  assert.deepEqual(normalizeUsState('TX'), { code: 'TX', name: 'Texas' });
  assert.deepEqual(normalizeUsState('ny'), { code: 'NY', name: 'New York' });
});

test('normalizeUsState: trims surrounding whitespace', () => {
  assert.deepEqual(normalizeUsState('  California  '), { code: 'CA', name: 'California' });
  assert.deepEqual(normalizeUsState('  ca '), { code: 'CA', name: 'California' });
});

test('normalizeUsState: District of Columbia is correctly cased (not "Of")', () => {
  assert.deepEqual(normalizeUsState('DC'), { code: 'DC', name: 'District of Columbia' });
  assert.deepEqual(normalizeUsState('district of columbia'), { code: 'DC', name: 'District of Columbia' });
});

test('normalizeUsState: name and code forms resolve to the same object', () => {
  assert.deepEqual(normalizeUsState('Illinois'), normalizeUsState('IL'));
  assert.deepEqual(normalizeUsState('west virginia'), normalizeUsState('wv'));
});

test('normalizeUsState: non-states and bad input return null', () => {
  assert.equal(normalizeUsState('Marsville'), null);
  assert.equal(normalizeUsState('ZZ'), null, 'unknown 2-letter code');
  assert.equal(normalizeUsState('Ontario'), null, 'Canadian province is not a US state');
  assert.equal(normalizeUsState(''), null);
  assert.equal(normalizeUsState('   '), null);
  assert.equal(normalizeUsState(null), null);
  assert.equal(normalizeUsState(42), null);
});
