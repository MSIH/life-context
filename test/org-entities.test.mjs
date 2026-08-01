// Org-kind business contacts + person->org employment edges (#88). Drives the real
// importContacts path against a fake Ollama + temp DB, and reads back the entity graph
// (entities.kind, entity_relations, unresolved_aliases) and aboutEntity's relations/relations_in.
// The load-time kind='org' data migration is covered separately in org-migration.test.mjs (it
// needs a fresh process per reopen). DB_PATH + OLLAMA_BASE_URL are set before contacts.js loads.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const { importContacts } = await import('../src/contacts.js');
const { db } = await import('../src/db.js');
const { aboutEntity } = await import('../src/search.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

const vcard = (body) => `BEGIN:VCARD\nVERSION:3.0\n${body}\nEND:VCARD\n`;
const kindOf = (name) => db.prepare('SELECT kind FROM entities WHERE canonical_name = ?').get(name)?.kind;
const stagedWorksAt = (alias) => db.prepare(
  "SELECT * FROM unresolved_aliases WHERE alias = ? AND alias_type = 'relation' AND role = 'worksAt'"
).all(alias);

test('company vCard -> kind=org; person vCard -> kind=person; re-import is idempotent (kind stable, no dup)', async () => {
  await importContacts(vcard('FN:Globex\nX-ABSHOWAS:COMPANY\nEMAIL:info@globex.example'));
  await importContacts(vcard('FN:Jane Human\nEMAIL:jane.human@example.com'));
  assert.equal(kindOf('Globex'), 'org');
  assert.equal(kindOf('Jane Human'), 'person');

  // vCard 4.0 KIND:org is the other company signal.
  await importContacts(vcard('FN:Initech\nKIND:org\nEMAIL:hi@initech.example'));
  assert.equal(kindOf('Initech'), 'org');

  const again = await importContacts(vcard('FN:Globex\nX-ABSHOWAS:COMPANY\nEMAIL:info@globex.example'));
  assert.equal(again.skipped, 1, 're-import dedups');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entities WHERE canonical_name = 'Globex'").get().n, 1);
  assert.equal(kindOf('Globex'), 'org', 'kind stays org on re-import');
});

test('person with ORG then the company contact -> worksAt edge (person->org); about_entity shows both sides', async () => {
  await importContacts(vcard('FN:Alice Worker\nEMAIL:alice@acme.example\nORG:Acme;Engineering'));
  // #125: an employer with no contact yet is auto-created as an org NOW (trusted contact data),
  // so the worksAt edge forms immediately rather than staging.
  assert.equal(kindOf('Acme'), 'org', 'the employer org is minted from the ORG field');
  assert.equal(stagedWorksAt('acme').length, 0, 'edge formed directly, nothing left staged');

  // Importing the company card later dedups onto that org (name alias 'acme'), no duplicate.
  await importContacts(vcard('FN:Acme\nX-ABSHOWAS:COMPANY\nEMAIL:contact@acme.example'));
  assert.equal(kindOf('Acme'), 'org');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entities WHERE canonical_name = 'Acme'").get().n, 1, 'no duplicate org');

  const person = aboutEntity('Alice Worker').entities[0];
  const edge = person.relations.find((r) => r.relation_type === 'worksAt');
  assert.ok(edge, 'person has an outgoing worksAt edge');
  assert.equal(edge.name, 'Acme');

  const org = aboutEntity('Acme').entities[0];
  const inbound = org.relations_in.find((r) => r.relation_type === 'worksAt');
  assert.ok(inbound, 'org lists the employee via relations_in');
  assert.equal(inbound.name, 'Alice Worker');
});

test('reverse import order (company first, then the person) forms the same worksAt edge', async () => {
  await importContacts(vcard('FN:Umbrella\nKIND:org\nEMAIL:corp@umbrella.example'));
  await importContacts(vcard('FN:Bob Staff\nEMAIL:bob@umbrella.example\nORG:Umbrella'));

  const person = aboutEntity('Bob Staff').entities[0];
  assert.ok(person.relations.some((r) => r.relation_type === 'worksAt' && r.name === 'Umbrella'));
  const org = aboutEntity('Umbrella').entities[0];
  assert.ok(org.relations_in.some((r) => r.relation_type === 'worksAt' && r.name === 'Bob Staff'));
});

test('#125: a person whose ORG has no company contact mints the org + worksAt edge; idempotent; non-worksAt still stages', async () => {
  await importContacts(vcard('FN:Carol Solo\nEMAIL:carol@example.com\nORG:Nonexistent Co;Sales'));
  assert.equal(kindOf('Nonexistent Co'), 'org', 'the unmatched employer is auto-created as an org (#125)');
  assert.equal(stagedWorksAt('nonexistent co').length, 0, 'edge formed, not staged');
  const carol = aboutEntity('Carol Solo').entities[0];
  assert.ok(carol.relations.some((r) => r.relation_type === 'worksAt' && r.name === 'Nonexistent Co'), 'worksAt edge person->org');
  // Match/mint is on the ORG NAME (parts[0]), not the joined "org, department" display string.
  assert.equal(kindOf('Nonexistent Co, Sales'), undefined);

  // Re-import: resolve-first + OR IGNORE edge => 0 new orgs, 0 new edges.
  const orgs = () => db.prepare("SELECT COUNT(*) n FROM entities WHERE kind = 'org'").get().n;
  const edges = () => db.prepare("SELECT COUNT(*) n FROM entity_relations WHERE relation_type = 'worksAt'").get().n;
  const orgsBefore = orgs();
  const edgesBefore = edges();
  await importContacts(vcard('FN:Carol Solo\nEMAIL:carol@example.com\nORG:Nonexistent Co;Sales'));
  assert.equal(orgs(), orgsBefore, 're-import mints no new org');
  assert.equal(edges(), edgesBefore, 're-import forms no new edge');

  // Only worksAt auto-creates its target: a non-worksAt unresolved relation must still just stage,
  // never mint a stub person.
  await importContacts(vcard('FN:Dave Lone\nEMAIL:dave@example.com\nX-SPOUSE:Ghost Partner'));
  assert.equal(kindOf('Ghost Partner'), undefined, 'a spouse with no contact mints no stub person');
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM unresolved_aliases WHERE alias = 'ghost partner' AND alias_type = 'relation'").get().n,
    1, 'the spouse relation stays staged');
});

test('an org contact never self-links via its own ORG line', async () => {
  // A company card can carry an ORG too; the !isCompany guard means it never becomes a worksAt hint.
  await importContacts(vcard('FN:Wayne Enterprises\nKIND:org\nORG:Wayne Enterprises\nEMAIL:info@wayne.example'));
  const org = aboutEntity('Wayne Enterprises').entities[0];
  assert.equal(org.relations.length, 0, 'no outgoing edge');
  assert.equal(stagedWorksAt('wayne enterprises').length, 0, 'no staged self-hint');
});
