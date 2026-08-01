/**
 * The artifact type registry (docs/04-connector-contract.md §6): the one source of truth
 * for the v1 type vocabulary so the planner prompt (search.js), the zod TypeEnum
 * (server.js), and GET /api/v1/ingest/types can never diverge. Static config, no DB
 * table — the roadmap's M0 deliverable 4 calls for "static config"; a table adds migration
 * surface for a list that already changes with code (the planner prompt references it).
 *
 * Leaf module: no imports from other src files, so both search.js and a future ingest.js
 * can depend on it without a cycle.
 *
 * default_searchable / digest_eligible are planner policy per doc 04 §6. Both are now
 * enforced: default_searchable by search.js (#121 — a no-type search is restricted to the
 * searchable set), digest_eligible by the timeline's per-day digest substitution.
 */
export const TYPE_REGISTRY = Object.freeze([
  { type: 'note', default_searchable: true, digest_eligible: true },
  { type: 'message', default_searchable: true, digest_eligible: true },
  { type: 'email', default_searchable: true, digest_eligible: true },
  { type: 'document', default_searchable: true, digest_eligible: true },
  { type: 'photo', default_searchable: true, digest_eligible: true },
  { type: 'video', default_searchable: true, digest_eligible: true },
  { type: 'contact', default_searchable: true, digest_eligible: false },
  { type: 'post', default_searchable: true, digest_eligible: true },
  // default_searchable:false (#244) — dev-session summaries are dev-workflow noise for an
  // ordinary personal recall, same ambient-out-of-default treatment as visit/listening_session/
  // browsing_session below; still fully searchable via an explicit types:['dev_session'] filter.
  { type: 'dev_session', default_searchable: false, digest_eligible: true },
  { type: 'visit', default_searchable: false, digest_eligible: true },
  { type: 'listening_session', default_searchable: false, digest_eligible: true },
  { type: 'browsing_session', default_searchable: false, digest_eligible: true },
  { type: 'digest', default_searchable: true, digest_eligible: false },
].map(Object.freeze));

export const ARTIFACT_TYPES = Object.freeze(TYPE_REGISTRY.map((t) => t.type));

const EXTENSION_TYPE_RE = /^x-[a-z0-9-]+$/;

export const isRegisteredType = (t) => ARTIFACT_TYPES.includes(t);
export const isExtensionType = (t) => EXTENSION_TYPE_RE.test(t);
