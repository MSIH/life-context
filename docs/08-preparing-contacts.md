# Preparing Contacts for Ingest

**Contacts are the spine of the entity graph** ([`03-ob2-design.md §2.2`](03-ob2-design.md)): every person you import seeds an `entity` + its aliases, and every later artifact (emails, texts, photos) links to that person by matching an alias. So the quality of recall — "what did Sarah text me", "everything about Mom" — is set by how clean your contacts are *before* import, not after.

This doc has two parts: a **primer** (what actually matters and why, grounded in what `src/contacts.js` does) and a **pre-clean checklist** (the source-side pass to run before `npm run import:contacts`).

> **The boundary this doc encodes:** *bulk cleanup happens at the source* (Google/Yahoo/iPhone — free-form editing, no audit-trail cost, do it now); *judgment calls happen in-system* (merge ambiguous people, assign relationships — logged and reversible via the curation API, #75 "entity merge + duplicate detection"). Don't try to do the second kind here.

---

## Part 1 — Primer: what the importer keys off

`import:contacts` (`src/contacts.js`) creates, per vCard: one person `entity`, a set of **aliases** (the full name, each nickname, each email, each phone), a searchable `type='contact'` artifact, and person↔person **relations** from `RELATED`/`X-ABRELATEDNAMES`. Resolution downstream matches against those aliases. So "good contacts" = "aliases that match what other sources will emit."

| What you set | How it's matched | Why it matters |
|---|---|---|
| **Email / phone** | Deterministic, **confidence 1.0** (`normalizePhone` = digits-only; email lowercased) | The money fields. Every channel — email `From:`, text sender, photo provenance — hard-links on these. A contact with *no* email/phone can only ever fuzzy-match by name. |
| **Name** | **Exact match after lowercasing** (`normalizeName` = `trim().toLowerCase()`) | No fuzzy matching, no accent folding (`José` ≠ `Jose`), no first/last reorder (`Smith, John` ≠ `John Smith`). Set the display name to the natural `First Last` form other sources produce. |
| **Nicknames** | Each becomes another **`name` alias** (capped at confidence 0.9) | The single biggest silent link-dropper. A text "from Mom" only links if `Mom` is a nickname. Add every variant: `Mom`/`Dad`, `Bob`→Robert, maiden names, initials. |
| **Company flag** | `X-ABSHOWAS:COMPANY` / `KIND:org` → `kind='org'` entity (#88) | Keeps businesses out of the *person* graph (dedup, face-matching, and person recall all skip `kind='org'`) so they don't surface as bogus people. |
| **Company (`ORG`)** on a person | Seeds a `worksAt` person→org edge (#88), resolved by the org **name** | Turns "Title at Acme" from fuzzy text into a queryable employment edge — `about_entity('Acme')` lists its people. Only forms if a **company contact** named exactly `Acme` is also imported (either order); an unmatched `ORG` invents no org entity, just stages the edge until one exists. |
| **Relationships** | `RELATED`/`X-ABRELATEDNAMES` → `entity_relations` edges (resolved by name) | Builds the person↔person graph (spouse/parent/sibling) that powers `about_entity`. Only resolves if the related name matches the *other* contact's name exactly. |
| **Contact photo** (`PHOTO`) | **Preserved (#74):** decoded and written to `CONTACTS_RAW_DIR` (default `raw/contacts`) as a content-addressed file, with the contact artifact's `raw_path` pointing at it. | The face-recognition seed that can auto-label anonymous photo clusters. Keep it on the card. |

**Two things that are NOT worth your time:**

- **Phone *formatting*, and the US country code.** `(240) 555-0142`, `240.555.0142`, and `2405550142` all normalize to the identical digit string (`normalizePhone` strips every non-digit) and match. Since #129 the country code is handled too: an 11-digit key beginning with `1` drops it, so `+1 240 555 0142` and a bare `2405550142` collapse to the **same** key. Don't reformat numbers, and don't chase `+1` prefixes. What is *not* normalized away: a **non-NANP international** number (`+44 20 7946 0958` keeps its `44`, so the same person written once with and once without their country code won't match) and a 7-digit local number with no area code.
- **Chasing 100% clean.** The store is append-only and corrections happen forward, and the curation API (#75) handles the residue. Get the bulk-obvious right and stop.

**Free dedup on import:** when a new card shares an **email or exact name** with an already-imported entity, `resolveExistingEntity` merges it into that entity automatically (aliases pooled). So importing overlapping exports collapses the overlaps for you — the leftover ("Bob" vs "Robert", no shared email) is the human residue for #75.

---

## Part 2 — Pre-clean checklist (source-side, before import)

**Golden rule: consolidate into ONE pile first, then clean once.** Cleaning Google, Yahoo, and iPhone separately just re-injects duplicates on import.

### 1. Consolidate everything into one Google account
- [ ] **Yahoo → vCard:** Yahoo Mail → Contacts → **Actions → Export** → **vCard** → download `.vcf`.
- [ ] **iPhone/iCloud → vCard:** [icloud.com](https://icloud.com) → **Contacts** → select all → gear (bottom-left) → **Export vCard…**.
- [ ] **Import both into Google:** [contacts.google.com](https://contacts.google.com) → **Import** → upload the Yahoo `.vcf`, then the iCloud `.vcf`. Everything now lives in one hub.

### 2. Kill duplicates (Google's built-in tool)
- [ ] [contacts.google.com](https://contacts.google.com) → **Merge & fix** → review and **Merge** the obvious ones. Skip anything that needs real judgment (see [Where to stop](#where-to-stop)).

### 3. Bulk-delete the junk *(no audit trail needed for these)*
- [ ] Dead business cards / vendors, no-name entries, spam/auto-added contacts, ancient work contacts you'll never reference. *(If unsure whether you'll want it — keep it; deletion here is permanent.)*

### 4. Fix names + add nicknames  ← highest ROI
- [ ] Fix garbled / ALL-CAPS / `"LASTNAME, First"` display names → natural **`First Last`**.
- [ ] Add a **Nickname** for every other name a source might use: `Mom`/`Dad`, short names (`Bob`→Robert, `Liz`→Elizabeth), maiden/previous names, initials/handles you actually use.
- [ ] Ensure each real person has **at least one email or phone** (the deterministic link keys).

### 5. Phone / address (light touch)
- [ ] **Do not reformat phones** — formatting is normalized away. Only fix a missing country code if your messaging data carries one. Low priority.
- [ ] Fix obviously wrong addresses if quick; otherwise leave (easy to append later).

### 6. Photos (optional, forward-looking)
- [ ] Where easy, keep a contact **photo** on key people — the future face-rec seed (#74). Don't go hunting; just don't strip existing ones.

### 7. Relationships — leave for later *(don't do this at the source)*
- [ ] **Skip.** Spouse/parent/sibling links, "is this Bob the same as Robert?", whose-contact-is-this (you vs spouse) — judgment calls, done **in-system** where each decision is logged and reversible (#75).

### 8. Export the clean pile and import
- [ ] [contacts.google.com](https://contacts.google.com) → select all → **Export** → **vCard** → download one clean `.vcf`. Keep it — it's your clean-state archive.
- [ ] `npm run import:contacts <clean.vcf>` (auto-merges on shared email/exact name).

---

## The side directory keeps the whole card (#304)

`npm run directory:load <clean.vcf>` loads the same export as a **lookup-only side directory** (#154) — it creates no entities. Since #304 it stores two things, not one:

- **one `contact_directory` row per handle** — the handle→name lookup that auto-labels unknown numbers and stages review proposals;
- **one `directory_cards` row per card** — the card's full parsed profile: addresses, birthday, **anniversary**, org/department/title/role, note, urls, nicknames, categories, IM/social. Keyed by the card's vCard `UID`, else a sha256 of the card text (the same dedup ladder the importer uses — so an edited card *without* a UID lands as a new card).

Everything the parser already extracted is now kept, where before only the name and handles survived. Two things follow:

- a directory entry **promoted** into the curated graph arrives with a real profile instead of a name and phone number;
- contacts you imported **before** this existed can be enriched:

```bash
npm run directory:load contacts.vcf        # re-load: existing rows carry no card until you do
npm run backfill:directory-attrs           # fill EMPTY profile fields from each contact's card
```

**A re-load is required.** Handle rows loaded before #304 have `card_id` NULL, so no card exists to read until you re-run `directory:load` against the export. That re-load both writes the cards *and* **links your existing handle rows to them** — reported as `N existing handle(s) linked to a card` in the summary. It only ever fills a NULL link: a handle already pointing at a card keeps it, and a handle whose stored name belongs to a different card is left alone with its collision logged. Both commands are idempotent — a second run merges 0 cards, links 0 handles, and fills 0 fields — and both mutate existing rows, so **back up `life-context.db` first**.

**If your addresses look doubled, run the one-shot address repair (#493).** Some address books export an
`ADR` with an 8th component holding the whole address again as a pre-formatted mailing label. Imports
made before this was bounded stored both copies in one string:

```
240 Example Plaza, Springfield, CA, 90210-0100, US, 240 Example PlazaSpringfield, CA 90210-0100US
```

```bash
npm run fix:addresses -- --dry-run         # report what would change; writes nothing
npm run fix:addresses                      # repair profiles, directory cards, and contact artifacts
```

It repairs all three places the doubled text landed and re-embeds an affected contact artifact so search
stops matching the duplicate. Neither `directory:load` nor `backfill:directory-attrs` can heal it — the
first refuses to overwrite a differing stored value, the second only fills empty fields — which is why
this is its own pass. A value it doesn't recognize is left untouched, so a genuine second address is
never collapsed. Idempotent (a second run repairs 0); **back up `life-context.db` first**. Re-importing
the same export also fixes the address on any contact whose card it can still match.

Prefer to run it with the LifeContext service stopped, during a maintenance window (stop the
service, run the backfill, restart it). Every write is a compare-and-swap on the value the run read, so a profile you save
in the contacts UI mid-run loses the race and is reported (`N row(s) changed concurrently — re-run to
pick them up`) rather than silently overwritten — but stopping the service avoids the race entirely.
The run also reports two things it deliberately does **not** fix: a row whose JSON won't parse, and a
row whose label is an *inexact* restatement (e.g. the exporter omitted the country), which the detector
leaves alone because a fuzzy match must never authorize a write with no undo. Both need a look by hand.

**What the backfill will and won't do.** Precedence is **user-typed > existing non-empty > directory**:

| | |
|---|---|
| field empty on the contact | filled from the card, listed in `filled` |
| field already set | **untouched** — a value you typed always wins |
| `canonical_name`, aliases, relationships, `photoFile`, `raw_path` | never touched |
| contact's name matches >1 card | skipped and logged — no guess |
| no matching card | skipped silently |

It matches by **handle first** (an email/phone, normalized the same way resolution is — #129), then by exact name. Every fill writes an `entity_edited` `ingest_log` row naming the filled keys, so a profile's history stays reconstructable.

**A re-load never overwrites the directory either.** The card merge is append-if-exists: a new address or url is unioned in, an empty field is filled, and a **differing** scalar (a changed birthday, a renamed card) keeps the stored value and records the difference as a `directory_card_merged` conflict in `ingest_log`. Nothing in the directory is clobbered by loading a newer export.

The card stores the *parsed* fields only — not the raw vCard text and not embedded photos. Wanting a new field later therefore needs a schema change **and** a re-load, and contact photos still come from a targeted `npm run import:contacts`.

---

## Where to stop

Stop the moment a decision needs judgment about a *person* rather than a *record*: merging ambiguous people, assigning relationships, untangling shared/spouse contacts, attaching camera-roll photos. Those are the in-system curation layer's job (#75 "entity merge + duplicate detection") — logged, reversible, and a much smaller pile once this bulk pass is done.

**Time-box it.** An hour or two on Steps 1–5 captures ~90% of the value. Past that is diminishing returns — the append-only store plus the curation API exist precisely so you don't have to make it perfect here.

---

## Ingest order & what happens on a no-match

**The order is two tiers, not a five-step chain.**

1. **Tier 1 — contacts (recommended first).** Importing people first seeds the graph — each becomes an `entity` + its aliases — so Tier-2 hints resolve the moment they arrive instead of waiting to self-heal (see below). It's the recommended order, not an enforced one.
2. **Tier 2 — everything else** (photos, emails, documents, texts): ingest in **any order**. Tier-2 artifacts carry entity *hints* (an email address, a phone, a name) that link to the *entities* contacts created — they never link to each other, so no Tier-2 source depends on another. Photos-before-emails, emails-before-texts: it doesn't matter.

**Contacts-first is a recommendation, not a hard requirement.** An artifact ingested before its contact exists is **not** dropped or rejected:

- It is stored, embedded, and FTS-indexed like any other artifact — fully recallable by **meaning, keyword, time, and place** immediately.
- Only the **entity link** is deferred: the unmatched hint is staged in `unresolved_aliases` (see [`03-ob2-design.md §2.2`](03-ob2-design.md) and [`04-connector-contract.md §4`](04-connector-contract.md)). Until it resolves, that artifact won't surface under `about_entity("<person>")` or an entity-filtered search — everything else about it works.
- When you later import the matching contact — **or create/rename it or add the alias in the contacts UI** (#295) — the stage resolves **automatically** (`resolveStagedArtifactHints` runs on every one of those paths) and every queued artifact links to the new person, with the count returned as `linksFormed`. No re-ingest, no separate command (#102). A one-shot `npm run backfill:links` heals anything staged before that mechanism existed.

So the cost of ingesting out of order is temporary (missing person links until the contact lands), never permanent — which is why contacts-first is the *recommended* sequence rather than an enforced one.

## Other sources

Source-side prep checklists for other Tier-2 inputs — photos ([`photo-exif`](../connectors/photo-exif/)) and documents ([`documents`](../connectors/documents/)) — will be added here as those pipelines mature. The same principle carries over: cheap normalization at the source, judgment in-system.
