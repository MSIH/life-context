/**
 * Regenerates schemas/ingest.v1.json from the zod schema that actually validates
 * POST /api/v1/ingest (src/ingest.js's IngestPayloadSchema, doc 04 §3, roadmap M0
 * deliverable 5). One source of truth: zod v4 ships z.toJSONSchema() natively, so the
 * committed file can never drift from the runtime validator by construction.
 *
 * Run: `npm run schema:ingest`. Deterministic — same input schema always produces the
 * same bytes (direct JSON.stringify of the generator output, no extra key reordering),
 * so "regeneration produces zero diff" is the review check whenever IngestPayloadSchema
 * changes.
 *
 * Known gap (see doc 04 §3 / PR notes): the payload schema's `type` field is
 * `z.string().refine(...)` against the live type registry (src/ingest-types.js) — a
 * runtime check against a table that can grow, plus the open-ended `x-` extension
 * prefix. z.toJSONSchema() cannot represent an arbitrary refine() predicate, so the
 * emitted schema (before the minLength patch below) would accept ANY string, including
 * empty, for `type`. We patch in `minLength: 1` post-generation so the file at least
 * matches the refine()'s de-facto non-empty requirement; connectors validating offline
 * get every other constraint (required fields, content_hash format, strict unknown-key
 * rejection, non-empty type) but not registry membership for `type` — that check still
 * runs server-side on every real POST.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { IngestPayloadSchema } from '../src/ingest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'schemas', 'ingest.v1.json');

// z.toJSONSchema's own output already leads with $schema; splice $id/title/description
// in right after it (conventional JSON Schema key order), then the generated body
// (type/properties/required/additionalProperties). $id is the raw GitHub URL of this
// file on the default branch (2.0) — names the versioned contract so the schema is
// self-describing for anyone who finds it outside the repo (doc 04 §8 promise).
const { $schema, ...body } = z.toJSONSchema(IngestPayloadSchema);
// z.toJSONSchema() drops the refine() predicate on `type`, so the emitted property is bare
// `{type:"string"}` — that would let an offline validator accept `type:""`, which the real
// server rejects (isRegisteredType/isExtensionType both reject empty). Patch minLength: 1 in
// so the committed file matches that de-facto constraint (registry membership itself still
// can't be expressed here — see the Known gap note above).
if (body.properties?.type) body.properties.type = { ...body.properties.type, minLength: 1 };
const schema = {
  $schema,
  $id: 'https://raw.githubusercontent.com/MSIH/life-context/main/schemas/ingest.v1.json',
  title: 'LifeContext connector ingest payload (v1)',
  description: 'Single-artifact payload for POST /api/v1/ingest — see docs/04-connector-contract.md §3 for the field-by-field contract. Generated from src/ingest.js\'s IngestPayloadSchema via z.toJSONSchema(); do not hand-edit — run `npm run schema:ingest`.',
  ...body,
};

writeFileSync(OUT_PATH, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Wrote ${OUT_PATH}`);
