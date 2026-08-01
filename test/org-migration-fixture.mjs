// Child-process fixture for org-migration.test.mjs (#88). The kind='org' data migration runs at
// db.js module load, so exercising "reopen an existing DB and promote mis-kinded rows" needs a
// fresh process per open — this script is invoked once per phase with a shared DB_PATH.
//   seed  : import db.js (migration no-ops on the empty DB), THEN insert a legacy person+isCompany
//           row and a plain person, and report state (proves the pre-migration starting point).
//   check : import db.js (migration runs against the seeded DB) and report state.
// Writes { companyKind, humanKind, malformedKind, migRows } as JSON to the file at argv[3] — NOT
// stdout, which db.js pollutes with a startup log line — so the test can diff state across opens.
import { writeFileSync } from 'node:fs';
import { db, insertEntityStmt } from '../src/db.js';

if (process.argv[2] === 'seed') {
  insertEntityStmt.run('person', 'Legacy Company', JSON.stringify({ isCompany: true }));
  insertEntityStmt.run('person', 'Legacy Human', JSON.stringify({ isCompany: false }));
  // A row with non-JSON attrs_json (the column is unconstrained TEXT): json_extract would THROW
  // on it, so the migration must json_valid-guard past it rather than crash startup.
  insertEntityStmt.run('person', 'Legacy Malformed', '{not valid json');
}

const migRows = db.prepare(
  "SELECT COUNT(*) n FROM ingest_log WHERE event_type = 'schema_migration' AND details LIKE '%kind=org%'"
).get().n;
const companyKind = db.prepare("SELECT kind FROM entities WHERE canonical_name = 'Legacy Company'").get()?.kind;
const humanKind = db.prepare("SELECT kind FROM entities WHERE canonical_name = 'Legacy Human'").get()?.kind;
const malformedKind = db.prepare("SELECT kind FROM entities WHERE canonical_name = 'Legacy Malformed'").get()?.kind;
writeFileSync(process.argv[3], JSON.stringify({ companyKind, humanKind, malformedKind, migRows }));
db.close();
