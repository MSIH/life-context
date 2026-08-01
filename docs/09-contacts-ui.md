# 09 — Contacts Management UI (#96)

A local web UI for curating the entity graph — the **spine** of LifeContext. Contacts imported from
vCards are messy (wrong emails, missing phones, unlinked relationships), and until now the only way
to fix the graph was `merge_entities`. This adds a browser UI + core REST endpoints to correct a
contact's fields, edit its aliases and relationships, and set a photo.

Open it at **`http://localhost:3000/<token>/ui/contacts.html`** (served as static assets from `public/`). The UI is **token-only** (#169): it is served only when `UI_URL_TOKEN` is set in `.env`, and only under the `/<token>/ui/…` capability path — see the Auth note below and [`docs/07`](07-cloudflare-tunnel-setup.md#opening-the-browser-ui-remotely-capability-url).

## Deep-linking a contact (#492)

The open contact is mirrored into the URL as **`?contact=<entity_id>`**, so
`http://localhost:3000/<token>/ui/contacts.html?contact=42` opens that contact directly —
bookmarkable, refresh-proof, and pasteable into another tab or an agent.

| Detail | Behavior |
|---|---|
| Selecting a contact | `history.pushState` — no reload; **Back** walks the contacts you visited, and Back past the first one deselects (empty detail pane, param gone) |
| Boot with the param | detail fetch runs **alongside** `loadList()`; works even for a contact the current search/kind filter excludes, since it reads `GET /api/v1/entities/:id` directly, not the list |
| Bad value | unknown id → one error toast, empty state, param stripped; non-numeric (`?contact=abc`) → ignored, param stripped, no request |
| Other params | preserved on both set and clear (`URLSearchParams`, not a rebuilt query string) |

**A query param, not a path segment** — deliberately, because the page's own credential is the token
in its path (Auth note below): `apiKey()` in `public/app.js` matches `/<token>/ui/<file>` strictly, so
`…/ui/contacts.html/42` would leave the token unresolvable and 401 every call on the page. It is keyed
on the **entity id**, since `canonical_name` is user-editable and non-unique. The param adds no new
secret to a URL that already carries the capability token.

## Model: the entity graph is mutable curation state

The **artifact** store is append-only (design-philosophy §1) — the raw `contact` artifacts imported
from vCards (`raw_path`, `content_hash`) are **never touched** by this UI. What the UI edits is the
*derived* entity graph (`entities` / `entity_aliases` / `entity_relations`), exactly as
`merge_entities` already does. Every mutation writes an `ingest_log` row with before/after, so the
derived record's history stays reconstructable.

Why mutable rather than append-and-supersede: a *wrong* alias actively mis-resolves future ingests
(an email from the real owner won't match, a wrong number resolves to the wrong person). Removing it
repairs resolution — the whole point of the spine. Keeping a "deprecated" copy around wouldn't fix
that unless the resolution hot path learned to skip it. The original vCard remains the archive.

## Endpoints (`/api/v1/entities`, all `x-api-key`)

Core-owned curation surface — never a connector concern (contract §1.2), same family as
`/duplicates` and `/merge`. Errors map: `ALIAS_CONFLICT`→409, `NOT_FOUND`→404, `BAD_ALIAS`→422.
`linksFormed` (#295) counts how many staged connector hints were retro-linked by the aliases the
write just seeded — 0 on the common path, large the first time a backlogged contact is touched.

| Method + path | Body / query | Result |
|---|---|---|
| `GET /api/v1/entities` | `?query&kind&limit&offset` | `{ entities: [{id, kind, canonical_name, attrs, hasPhoto}] }` |
| `GET /api/v1/entities/:id` | — | `{ entity, aliases[], relations[], relations_in[], artifacts[] }` |
| `POST /api/v1/entities` | `{ kind: person\|org, canonical_name, attrs? }` | `201 { id, linksFormed }` |
| `PATCH /api/v1/entities/:id` | `{ canonical_name?, attrs? }` | `{ updated: true, linksFormed }` |
| `POST /api/v1/entities/:id/aliases` | `{ alias, alias_type: email\|phone\|name\|handle }` | `{ added, linksFormed }` |
| `DELETE /api/v1/entities/:id/aliases` | `{ alias, alias_type }` | `{ removed }` |
| `POST /api/v1/entities/:id/relations` | `{ to_entity_id, relation_type? \| raw_label? }` | `{ added, relation_type }` |
| `DELETE /api/v1/entities/:id/relations/:relationId` | — | `{ removed }` |
| `POST /api/v1/entities/:id/photo` | raw image bytes (`Content-Type: image/*`) | `{ photoFile }` |
| `GET /api/v1/entities/:id/photo` | — | image bytes (`404` if none) |
| `GET /api/v1/entities/photos` | — | contact reference-photo list for the photo-exif face matcher (#112) |

**Duplicates review + merge** (#75/#120/#302 — the core-owned curation admin surface; connectors may never merge/assert entities, contract §1.2):

| Method + path | Body / query | Result |
|---|---|---|
| `GET /api/v1/entities/duplicates` | `?limit` | `{ pairs: [...], dismissed_count }` — candidate pairs, dismissed ones already suppressed |
| `POST /api/v1/entities/merge` | `{ keep_id, absorb_id }` | tombstones `absorb_id` (`merged_into`), re-points aliases/links/relations to `keep_id` |
| `POST /api/v1/entities/duplicates/dismiss` | `{ a_id, b_id, score?, reason? }` | records "not a duplicate"; `422` same id, `404` unknown/already-merged side |
| `DELETE /api/v1/entities/duplicates/dismissals` | — | clears every dismissal at once; `{ cleared }` |

- **Dismissal is a persisted negative fact (`duplicate_dismissals`), not a merge** — modelled on `alias_tombstones`: a canonical `(min_id, max_id)` key enforced by a `CHECK`, idempotent insert via a targeted `ON CONFLICT(...) DO NOTHING` (not `INSERT OR IGNORE` — SQLite's `IGNORE` conflict resolution also suppresses `CHECK` failures, which would silently accept a non-canonical write instead of throwing), consulted by `GET /duplicates` before the per-pair scoring work and before the result is capped to `limit` (so dismissing the top-scored pair correctly promotes the next one into view, rather than just shrinking the list). **Absolute until cleared** — a later, stronger match signal (e.g. a shared email showing up after a shared-phone dismissal) does not re-raise it; re-raising would reintroduce the exact "why is this back?" surprise the feature exists to fix.
- **Clear-all is the only undo**, `confirm()`-gated in the UI (unlike a per-row dismiss, which has no confirm — cheap and reversible, matching the Proposed panel's Reject-vs-Approve split). Every cleared pair's score/reason/timestamp is captured in the `duplicate_dismissals_cleared` `ingest_log` row, so a clear-all is reconstructable even though the table itself is not append-only.
- **A dismissed pair stays manually mergeable** — dismissal and merge are independent decisions; `mergeEntities` never consults the dismissals table.
- **Not transitive.** Dismissing `(a,b)` says nothing about `(a,c)` — if `b` is later merged into `c`, `(a,c)` still surfaces normally.
- **A candidate pair's two names render stacked, not side by side (#394).** The drawer is a
  full-viewport overlay, so two flex columns put the names ~950px apart at 1920px wide — outside one
  fixation, with no shared x-column to reveal a shared prefix; stacked rows on a fixed radio gutter
  put both names at an identical x, and the differing word run (`nameDiffParts` in `public/app.js`)
  is emphasized so the mismatch is unmissable. Detection, scoring, and merge semantics are unchanged.
- **Manual merge (#303) — front-end only, no new endpoint.** `listProbableDuplicates` only ever surfaces `kind='person'` pairs (`listLivePersonEntitiesStmt`), so two duplicate `kind='org'` contacts, or any pair that shares nothing the detector scores (different phone/email, dissimilar names), had no route to a Merge button. The Duplicates panel now has a **Merge two contacts manually** form above the detected-pairs list: a `Keep` and an `Absorb` picker (each a debounced `GET /api/v1/entities?query=` search, results shown `Name (kind) #id`, **not** filtered by kind), an ⇅ swap, and `Merge` — which calls the same `POST /api/v1/entities/merge` and the same `mergePair()` client-side path (confirm → toast → follow-to-survivor → refresh) that a detected pair's own Merge button uses. Picking the same contact for both sides, or leaving either unset, is caught client-side with no request sent.

**Proposed-entity review queue** (#119/#143 — the approval gate for *suggested* entities; same `/api/v1/entities` family). A connector/agent *suggestion* is never minted without approval; trusted direct creation via `POST /api/v1/entities` (above) is the separate curation path:

| Method + path | Body / query | Result |
|---|---|---|
| `GET /api/v1/entities/proposed` | `?status&limit` | `{ proposals: [...] }` — the review queue |
| `POST /api/v1/entities/proposed/:id/approve` | — | mints the entity, or attaches to the live entity its name already resolves to (#413), + retro-links its queued artifacts |
| `POST /api/v1/entities/proposed/:id/reject` | — | marks it rejected; the row is retained, but reversible (see reopen below) |
| `POST /api/v1/entities/proposed/:id/reopen` | — | rejected → pending, back in the review queue; `409` if not currently rejected (#300) |
| `POST /api/v1/entities/proposed/reopen` | `{ ids: [...] }` | bulk reopen, per-item isolated (#300) |
| `POST /api/v1/entities/proposed/stage-from-directory` | — | re-runs the side-directory proposal pass (#162) |

- **Rejection is reversible; approval is terminal (#300).** A rejected proposal keeps its `UNIQUE(suggested_name, alias, alias_type)` slot (append-only — the row is the audit record of the decision, not deleted), so reopening it is a status flip back to `pending`, never a re-stage. An **approved** proposal refuses reopen (`409 ALREADY_RESOLVED`) for the same reason it refuses re-rejection: the minted entity lives on, and flipping status would mislabel the audit trail. Every reopen writes a `proposed_entity_reopened` `ingest_log` row, so `staged → rejected → reopened → approved` is fully reconstructable. The UI's Proposed drawer has a Pending/Rejected/Approved status filter (default Pending, unchanged behavior) — Rejected rows render a `Reopen` button plus a bulk `Reopen selected` action; there is deliberately no "reopen everything rejected" switch, since a blind reset would resurrect genuinely-bad proposals too.

> **Pending rename (#219, display-only):** the UI's *Proposed* panel and *Approve* control are being relabeled **Candidates** / **Promote**. The `proposed_entities` table, the `/proposed/*` endpoints above, and the element ids are **unchanged** — only user-facing strings change.

**Side contact directory — browse + promote** (#299, its own top-level path). The directory (#154) held 1,569 names over 2,888 handle rows that nothing could read: `name` was a write-only column, so there was no way to ask the directory anything, and the only promotion route was the indirect handle-driven proposal queue:

| Method + path | Body / query | Result |
|---|---|---|
| `GET /api/v1/directory` | `?query&limit&offset` | `{ candidates: [{ name, handles[], entity_id, impact }], total_names, total_rows }` |
| `POST /api/v1/directory/promote` | `{ names: [string] }` (1–100) | `{ results: [{ name, entity_id, created, linked, aliases, proposals_resolved, skipped_handles[] } \| { name, error }] }` |

- **Grouped by the exact name string**, with every handle that name owns — 411 names carry 2 handles and 225 carry 3, so promoting one handle at a time would mint duplicates of the same person. `"Jason Lomax (personal)"` and `"Jason Lomax"` are honestly two groups; merging them is the merge issues' job, not a guess made here.
- **Ordered by impact, not alphabetically** — `impact.artifacts` is the number of *distinct* artifacts promoting would retro-link, counted across both hint arms (`name`-type photo-folder hints and handle-typed hints) and excluding aliases that already resolve. 1,569 names are untriageable by name; by impact, the people with real history come first (measured on the live DB: Diana Monday 3,028 artifacts = 1,887 name + 1,141 handle hints, Steve Monday 2,694).
- **`query` matches a name substring or a handle**, case-insensitively, and a pasted formatted number (`+1 (301) 555-0134`) matches its stored digits form (#129).
- **Already-curated names are returned with `entity_id` set**, not hidden, so "already done" is visible rather than mysteriously absent. "Curated" means **this name resolves to a live entity** — deliberately *not* "any of its handles resolves", which is the same identity rule promotion applies (see below); otherwise a shared family landline would grey its second owner's row and link its name to the wrong contact. And a curated row is not necessarily *finished*: the contact can exist by name while some of the directory's handles were never aliased to it, leaving staged history unlinked (one live example holds 1,155 linkable artifacts). Such a row keeps a non-zero `impact` and stays actionable — the UI offers **Link history** instead of Promote and only greys out a row whose impact is 0.
- **Promotion is DIRECT, not via `proposed_entities`.** The directory is the user's own vCard export, so a name it holds is not a machine guess needing approval — browsing and clicking *is* the approval. (Routing through the queue would also collide with any already-rejected rows for those handles, whose `UNIQUE` key is occupied — the Proposed panel's Rejected filter + Reopen control, #300, is the other route back into review for those.) It mints `kind='person'` with the #304 card's full profile when the directory has one (else its handles), seeds `nameVariants` name aliases plus every handle alias through the tombstone guard (#111 — a deliberately-removed alias is never resurrected), runs `resolveStagedArtifactHints` so the staged history links in the same transaction, and **heals the queue**: a `pending` or `rejected` proposal for one of those handles, or for a name-type alias variant this entity actually owns (#413), is resolved to the minted entity instead of being left to contradict the graph.
- **Identity is decided by name, never by a handle alone.** A handle-based reuse is accepted only when that entity also answers to this name (the "contact was imported since the directory was loaded" case). Otherwise a shared family landline listed under a second person's name would silently absorb them into its owner's contact; minting a *detectable* duplicate instead (surfaced by the Duplicates panel, resolved by merge) is the safer failure.
- **Bulk is isolated per item**, same contract as `/api/v1/ingest/batch`: an unknown name returns `{ error: "NOT_IN_DIRECTORY" }` for that item while its siblings still promote — never a partial-failure 500.
- **Promoting twice is a no-op** (`created:false`, `linked:0`, `aliases:0`).

What the directory does **not** give a promoted contact: a photo. Handles and the card profile come across; run a targeted `npm run import:contacts` for the vCard photo. Every promotion writes a `directory_promoted` `ingest_log` row.

Backing helpers live in `src/db.js` (`listEntities`, `getEntityProfile`, `createEntity`,
`updateEntityAttrs`, `addAlias`, `removeAlias`, `removeRelation`, `setEntityPhotoFile`,
`getContactPhotoRawPath`) — relation adds reuse `upsertEntityRelation` + `canonicalRelationType`.
The directory pair is `listDirectoryCandidates` + `promoteDirectoryName` (#299).

## Editing rules

- **Fields.** `PATCH` overwrites the contact's editable `attrs` (emails, phones, addresses, dates,
  org/title/department/note). Life dates `birthday` / `anniversary` / `deceased` are ISO date
  strings; a set `deceased` shows a "deceased" marker. Server-owned keys (`photoFile`, `raw_path`)
  can't be set or wiped via `PATCH` — they belong to the upload route and the importer.
- **Alias reconciliation.** On `PATCH`, added emails/phones become `entity_aliases`, dropped ones are
  deleted. A rename adds new name variants (`nameVariants`); old name aliases stay (a person may
  still be referenced by them).
- **The Emails/Phones fields are the write surface for handle matching; the Aliases list is the
  index (#409).** Every resolution path — an ingest hint, search, `annotateHandles` — reads
  `entity_aliases` exclusively, never `attrs.emails`/`attrs.phones`, so a value visible on the
  Contact fieldset that never made it into `entity_aliases` is invisible to matching with no error
  shown anywhere in this UI. `PATCH` closes that gap by reconciling the contact's **whole current**
  Emails/Phones set against `entity_aliases` on every save (`reconcileHandleAliases`, set-based, not
  a diff of what changed) — so a value that arrived already un-aliased (drift from before this
  fix, or from a source outside the UI) gets indexed on the next save even if nothing else about it
  changed. Typing a previously-removed value back into Emails/Phones re-aliases it (the save is a
  user-typed, explicit write, so it clears the #111 tombstone); the vCard re-import and
  `backfill:directory-attrs` paths respect a tombstone instead, so they can never resurrect a
  deliberately-removed handle. A value already owned by a different contact is left alone (reported
  server-side, never surfaced as a UI conflict beyond the existing 409 above).
- **Aliases fieldset ✕ vs. the Contact fieldset (#334).** The Aliases list displays `email`/`phone`
  rows too, since the attrs `PATCH` above is what minted them — so its ✕ branches on whether the row
  has a twin in `attrs.emails`/`attrs.phones` (compared via `public/alias-keys.js`'s `aliasMatchKey`,
  which mirrors `normalizePhone`/`normalizeName` since `entity_aliases` stores the normalized form
  while `attrs` holds the raw string). A twin present routes through the same `PATCH` as the Contact
  fieldset (dropping the value from the loaded `attrs`, not the live form) so both layers move
  together and the tombstone is written the same way; no twin (an orphan alias — e.g. a handle seeded
  by `promoteDirectoryName`) still goes through `DELETE /aliases` directly. Before this, ✕ on an
  `email`/`phone` row deleted only the alias: `attrs` kept displaying the value, but it no longer
  resolved (`resolveEntityIds` reads `entity_aliases`, never `attrs_json`) — an unrecoverable
  desync, since re-typing the same value in Emails hits `insertAliasUnlessTombstoned`, which skips a
  tombstoned alias. **This ✕ still writes that same tombstone** (unchanged, existing `updateEntityAttrs`
  behavior, #111) — the fix closes the *desync* (both layers now drop together, so Emails never shows
  a value that silently fails to resolve), not the separate, pre-existing, by-design rule that only an
  explicit `addAlias` (name/handle only, from this fieldset) clears a tombstone. Retyping the exact
  same value into Emails afterward will *not* re-resolve it, same as retyping any other tombstoned
  value into Emails always has — that is #111's intended behavior everywhere in the system, not
  something this issue changes.
- **Alias add box refuses a mis-typed email/phone (#334).** Typing an email or phone-shaped value
  into the "add another name or handle" box is refused client-side (`looksLikeEmailOrPhone`, no
  request sent) with a toast pointing at the Emails/Phones field instead of silently storing it as
  `alias_type='name'`. That mis-typing isn't merely cosmetic: a `name`-typed email/phone misses
  `resolveAliasByTypeStmt` (type-scoped) so a connector ingest hint for that address never matches,
  and it never earns the deterministic 1.0 `entity_links.confidence` tier a real `email`/`phone`
  alias gets.
- **Alias conflict.** email/phone are globally `UNIQUE(alias, alias_type)`. Adding one already owned
  by a *different* live entity returns `409 {error, conflict:{alias, alias_type, entity_id}}` — the
  two are likely the same person; the UI's toast offers a **Review duplicates** action that opens the
  Duplicates panel with the conflicting contact pre-filled into the manual-merge form's `Absorb`
  picker (#303), so the next click is the merge that resolves the conflict. name/handle aliases are
  shareable (two people named "chris"), so they never conflict.
- **Relationships.** A relation is a directional edge (a `RELATION_TYPE_MAP` type, or `custom` with a
  free `raw_label`) to a target entity. **Multiple children/parents** are just multiple edges to
  distinct people — no schema change. The UI can create a new related person/org inline. Removing an
  edge is by its `relation_id` (now returned by `getRelations`).
- **Photos.** Upload sends the raw file bytes (not multipart); the server stores them
  content-addressed under `CONTACTS_RAW_DIR` (same store as vCard photos), records the basename in
  `attrs.photoFile`, and never overwrites (`flag:'wx'`). Display precedence: uploaded `photoFile`
  → the imported vCard photo (`raw_path`) → none. The UI fetches `/photo` as a blob with the key
  header and renders it (a plain `<img src>` can't send `x-api-key`). Cap: `CONTACT_PHOTO_MAX_BYTES`
  (default 10 MB → `413`); non-image `Content-Type` → `415`. Uploaded files are gitignored (`raw/`).
  The **list** marks which contacts have a photo with a small 📷 badge on the avatar, driven by
  `hasPhoto` on `GET /api/v1/entities` (uploaded `photoFile` OR imported `raw_path`) — no per-row
  image fetch (#113). This is the same "effective photo" precedence the face-match source uses (#112).
- **Single-select button groups are radiogroups, not tablists (#332).** The three pickers — kind
  filter (All/People/Orgs), proposal status filter (Pending/Rejected/Approved), and new-contact kind
  (Person/Organization) — each choose one of N and none reveals a tabpanel, so they carry
  `role="radiogroup"` + `role="radio"` + `aria-checked`. They were previously `role="tablist"` with
  plain buttons whose selection lived only in an `.active` CSS class, invisible to assistive tech;
  `role="tab"` would also promise an `aria-controls`'d tabpanel that doesn't exist. `.active` remains
  the *visual* state (`style.css`), `aria-checked` the semantic one. Because a radiogroup is a single
  tab stop (roving `tabindex`), the pattern obliges keyboard support: **←/→/↑/↓ move the selection,
  Home/End jump to the ends**, and an arrow selection fires the same handler a click does. One shared
  `selectInGroup`/`wireRadioGroup` pair in `app.js` serves all three groups. The ARIA/visual update is
  **synchronous**, but a group whose selection reloads data debounces *that reload* at the call site
  (`FILTER_RELOAD_DEBOUNCE_MS`, shared with the search box) — arrow keys auto-repeat ~30×/s while held,
  which would otherwise be one API call per repeat against a tight per-key rate limit. Debouncing
  `onSelect` itself would be wrong: `#newContactKind`'s callback records the kind that **Create** reads,
  so it has to observe the choice before the next click.

## Boundaries (out of scope)

- Editing a contact **does not re-embed** its original `contact` artifact (that's the ingest-upsert
  path's job). Corrections fix the profile + resolution aliases, not the artifact's vector.
- No bulk edit / CSV / undo UI, beyond bulk **reopen** of rejected proposals (#300 — a partial undo: it only reverses a rejection, never an approval or a contact edit) and **clear-all duplicate dismissals** (#302 — also partial: it only reverses dismissals, never a merge); no auth beyond `x-api-key` (single trusted local user).

## Auth note

Token-only (#169): the UI is served only when `UI_URL_TOKEN` is set, and only at `/<token>/ui/…`.
The page's credential is the **path token itself** — parsed from `location.pathname` and sent as
`x-api-key` on every data call — which `requireAuth` accepts as an alternative to
`LIFECONTEXT_API_KEY` (#163). There is no API-key bar and no `localStorage` key: the token is always
in the URL you loaded. With `UI_URL_TOKEN` unset the UI is disabled (every `/ui/*` path 404s), so a
Cloudflare Tunnel (docs/07) can't expose the page without an explicit token. A capability token in a
URL still leaks via history/logs/`Referer` — treat it as a full-access browser credential (docs/07),
and for anything beyond personal use put Cloudflare Access in front of `/ui`.
