#!/usr/bin/env node
/**
 * `npm run check:schema-literal` — keep a stray backtick out of the `db.exec(...)` schema template
 * literal (issue #317).
 *
 * The entire SQLite schema — every table, index, trigger, and the comments explaining them — lives
 * inside ONE template literal in src/db.js. A backtick written in an ordinary SQL comment (quoting an
 * identifier, the house style in every other comment in this repo) silently TERMINATES that literal,
 * and the rest of the file re-parses as code. The failure is at parse time, so nothing imports:
 * the server won't boot and the whole test suite dies at import. Worse, the reported location is
 * wherever the resulting garbage first fails to parse, NOT the offending comment — a real instance
 * pointed at `src/db.js:25` (the `db.exec(` line) with "SyntaxError: Invalid left-hand side in
 * assignment", hundreds of lines above the actual backtick.
 *
 * `node --check` also catches it, but reports that same unhelpful location, so this exists for the
 * DIAGNOSTIC: exact file:line:col of the backtick plus what to do instead. It is deliberately textual
 * — it must work on a file that does not parse, which rules out importing or AST-walking it.
 *
 * Exit 0 clean; exit 1 listing each violation. No deps.
 *
 * How it decides (not "are there backticks inside" — the terminator is one, and a one-line
 * db.exec(`SELECT …`) is legal): template literals don't nest and nothing here escapes a backtick, so
 * the NEXT backtick after the opener IS the terminator. The only question is whether the literal ends
 * where the SQL was meant to end. Two endings are intended — on the opener's own line followed by `)`
 * (a one-liner), or on a later line that opens with the closing backtick + `)` (the block form
 * src/db.js uses). Any other terminator is a backtick written inside the SQL, and its position is the
 * diagnostic. This is why the first draft of this check was wrong: treating every inner backtick as a
 * violation false-positived on the three legitimate one-line db.exec() calls in the rebuild migration.
 *
 * Known limits (deliberate, an honest-repo guard rather than a lexer): a block is recognized only by
 * the literal `db.exec(` + backtick opener, and an escaped backtick or a nested `${`…`}` template
 * inside the SQL would confuse the terminator scan (neither occurs here). A schema literal opened some
 * other way is not inspected — so the check fails loudly when it finds ZERO blocks under src/, making
 * a silent zero-coverage regression visible rather than passing vacuously.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'src');
const OPENER_RE = /\bdb\.exec\(\s*`/;      // `db.exec(` immediately opening a template literal
const CLOSER_RE = /^\s*`\s*\)/;            // a line that starts the closing backtick + `)`

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|cjs)$/.test(name)) yield full;
  }
}

const violations = [];
let blocksInspected = 0;

// Template literals don't nest and this repo never escapes a backtick inside one, so the NEXT
// backtick after the opener is necessarily the terminator. The question is therefore not "is there a
// backtick inside" (the terminator is one, and a one-line db.exec(`SELECT ...`) is entirely legal) but
// "does the literal end where the SQL was meant to end". Two endings are intended: on the opener's own
// line followed by `)` (a one-liner), or on a later line that opens with the closing backtick + `)`.
// Anything else is a backtick written INSIDE the SQL, and its position is the actionable diagnostic.
for (const file of walk(srcRoot)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const where = relative(repoRoot, file).replace(/\\/g, '/');
  for (let i = 0; i < lines.length; i++) {
    const opener = OPENER_RE.exec(lines[i]);
    if (!opener) continue;
    blocksInspected++;
    const startCol = opener.index + opener[0].length;
    let terminator = null;
    for (let j = i; j < lines.length && !terminator; j++) {
      const col = lines[j].indexOf('`', j === i ? startCol : 0);
      if (col !== -1) terminator = { line: j, col };
    }
    if (!terminator) {
      violations.push({ where, line: i + 1, col: startCol + 1, text: 'schema literal is never closed (unterminated template literal)' });
      continue;
    }
    const onOpenerLine = terminator.line === i;
    const intended = onOpenerLine
      ? /^\s*\)/.test(lines[terminator.line].slice(terminator.col + 1))   // …`);  — a one-liner
      : CLOSER_RE.test(lines[terminator.line]);                            // `);   — the block close
    if (!intended) violations.push({ where, line: terminator.line + 1, col: terminator.col + 1, text: lines[terminator.line].trim() });
    i = terminator.line; // resume after this literal, not inside it
  }
}

if (!blocksInspected) {
  console.error('check:schema-literal: found NO db.exec(`...`) block under src/ — the check is not covering anything.');
  console.error('  If the schema literal moved or changed shape, update OPENER_RE/CLOSER_RE in scripts/check-schema-literal.js.');
  process.exit(1);
}

if (violations.length) {
  console.error(`check:schema-literal: ${violations.length} stray backtick(s) inside a db.exec(\`...\`) schema literal:\n`);
  for (const v of violations) console.error(`  ${v.where}:${v.line}:${v.col}  ${v.text}`);
  console.error('\nA backtick TERMINATES the template literal, so the rest of the file re-parses as code and');
  console.error('nothing imports — the server will not boot and every test fails at import, usually reported');
  console.error('at a line far from the real cause. In SQL comments, write the identifier plainly or in');
  console.error("single quotes ('name'), never in backticks.");
  process.exit(1);
}

console.log(`check:schema-literal: OK (${blocksInspected} schema literal(s) inspected, no stray backticks)`);
