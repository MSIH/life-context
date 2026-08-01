// Pure, I/O-free quoted-reply stripping for the email connector (#386). Applied to the DECODED body
// in parse.js's buildTextRepr, alongside signature.js's stripSignature (the two compose by taking
// whichever boundary is EARLIER — see buildTextRepr) — before SNIPPET_MAX_CHARS truncation. Never
// touches rawBody, which still feeds sourceIdFor's hash fallback (#362's duplicate hazard — see
// parse.js's sourceIdFor comment); only the display/snippet path is stripped.
//
// Conservative by construction, same posture as signature.js: cut at the EARLIEST confidently-
// identified quote boundary and return everything above it. When no boundary is found, the text
// comes back byte-identical to the input — over-stripping silently destroys a correspondent's actual
// authored content, which is worse than under-stripping (that merely leaves today's behaviour, a
// long thread's `wrote:`/`>`-quoted tail dominating the snippet — the very problem this closes).
// See test.mjs's negative case: prose containing a `>` used as a comparison, the word "wrote" used
// as an ordinary past-tense verb, and a line that merely resembles an email header must all survive
// untouched.
//
// Known, accepted gaps (per the issue's own Design Decisions — not attempted here): top-posting with
// no marker at all, HTML quotes styled as ordinary divs rather than a real <blockquote>, non-English
// clients ("Le ... a écrit :"), and a reply typed INLINE inside an already-quoted thread (content
// appearing textually after a genuine "wrote:" attribution, which by convention always means
// everything below is a quote — indistinguishable from real prose without semantic understanding;
// measured on the real archive, see the PR description). html-to-text (mime.js) already renders a
// real <blockquote> as `> `-prefixed lines by default, so the QUOTE_MARK_LINE marker below covers
// that case without any separate HTML-aware detection.

// A real-archive quirk (Yahoo/AOL web forwards): the `text/plain` MIME part sometimes contains
// literal `<br>` tags instead of real line breaks — the webmail client baked its own HTML-ish
// formatting into what it declared as plain text. Every line-anchored marker below depends on real
// line boundaries, so this is normalized to `\n` before detection; it is NOT applied to the
// "no confident boundary" return path, which still hands back the ORIGINAL text byte-identical.
const BR_TAG = /<br\s*\/?\s*>/gi;

// "On <date...>, <name> wrote:" — the standard Gmail/Apple Mail/Outlook-web attribution line that
// introduces a quoted reply. In practice it is almost always its own
// paragraph (a blank line separates it from the owner's actual reply above), but two client quirks
// mean it cannot be found by a simple "does this line end in wrote:" check: (1) a long one — a full
// date plus a display name and address — is routinely WRAPPED across 2+ physical lines by the client,
// e.g. "On Tue, Jun 5, 2018 at 2:41 PM, Doe, Jordan (US) <\nJordan.Doe@example.com> wrote:"
// — so this is checked per PARAGRAPH (lines joined with a space, same technique as signature.js's
// contact-block check), not per physical line; (2) some clients (a Freecycle mailing-list relay, on
// the real archive) put the FIRST quoted line directly on the next physical line with no blank
// separator at all — "...wrote:\n>\n> WANTED: ..." — so requiring "wrote:" to end the whole paragraph
// would miss it once the quote lines merge into the same paragraph. So this looks for the EARLIEST
// literal "wrote:" anywhere in the paragraph, then searches BACKWARD from it for a valid attribution
// start. A paragraph can in principle also contain an earlier, innocent "on" before that "wrote:", so
// two things keep this safe regardless: (1) it must be the literal token "wrote:", colon attached —
// ordinary prose describing someone's past action essentially never uses that exact form; (2) the
// true attribution always carries a 4-digit year shortly after "On", so "On" candidates before the
// "wrote:" are checked RIGHTMOST-FIRST and only accepted when a year appears within a short window —
// "call me on Monday at 4pm? On Thu, Apr 13, 2017 ... wrote:" correctly resolves to the second "On".
const WROTE_TOKEN = /\bwrote:/gi;
const ON_TOKEN = /\bOn\b/gi;
const ON_WITH_YEAR_NEARBY = /^On\s.{0,60}?\b(19|20)\d{2}\b/i;

function findWroteBoundary(paragraphText) {
  const wroteMatches = [...paragraphText.matchAll(WROTE_TOKEN)];
  if (!wroteMatches.length) return -1;
  const before = paragraphText.slice(0, wroteMatches[0].index + wroteMatches[0][0].length);
  const positions = [...before.matchAll(ON_TOKEN)].map((m) => m.index);
  for (let k = positions.length - 1; k >= 0; k--) {
    if (ON_WITH_YEAR_NEARBY.test(before.slice(positions[k]))) return positions[k];
  }
  return -1;
}

// Groups lines into paragraphs (runs of non-blank lines separated by one or more blank lines) for the
// WROTE marker above, remembering — for every line in the paragraph — the character offset at which
// its content begins in the paragraph's space-joined flat text, so a match found in the flat text
// maps back to a precise (line, char-within-that-line) cut point rather than only a whole line.
function paragraphsWithOffsets(lines) {
  const paragraphs = [];
  let flat = '';
  let lineOffsets = [];
  const flush = () => {
    if (lineOffsets.length) paragraphs.push({ flat, lineOffsets });
    flat = '';
    lineOffsets = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') { flush(); continue; }
    // The line's content starts one char further out than `flat.length` once a joining space is
    // about to be inserted (every line after the paragraph's first) — omitting this +1 was an
    // off-by-one that let the cut land one character INTO the boundary token itself (e.g. keeping a
    // stray "O" of "On ..." — caught by the end-to-end verification, not the unit tests, because
    // every synthetic fixture happened to test only single-line paragraphs).
    const sep = flat ? 1 : 0;
    lineOffsets.push({ line: i, offset: flat.length + sep });
    flat += flat ? ` ${lines[i]}` : lines[i];
  }
  flush();
  return paragraphs;
}

function mapFlatOffsetToLine(lineOffsets, idx) {
  let chosen = lineOffsets[0];
  for (const lo of lineOffsets) {
    if (lo.offset > idx) break;
    chosen = lo;
  }
  return { line: chosen.line, charIdx: idx - chosen.offset };
}

// Forward/reply separators that are their own line, dash- or underscore-flanked or not — all
// tolerate leading whitespace, since a real specimen had one ("    On Sunday, ...") and a pasted
// block being indented a few spaces by the client is common. Covers Outlook/Exchange
// ("-----Original Message-----"), Yahoo/AOL web ("-------- Original message --------", any dash
// count), Gmail ("---------- Forwarded message ----------"), Apple/iOS Mail ("Begin forwarded
// message:", no dashes at all), and Outlook desktop's underscore rule ("____...____" on its own line,
// immediately above a pasted From/To/Sent/Subject block).
const ORIGINAL_MESSAGE_LINE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;
const FORWARDED_MESSAGE_LINE = /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i;
const BEGIN_FORWARDED_LINE = /^\s*Begin forwarded message:\s*$/i;
const UNDERSCORE_SEPARATOR_LINE = /^\s*_{8,}\s*$/;

// An Outlook-style (or Yahoo web, once `<br>` is normalized above) pasted header block:
// From:/Sent:/Date:/To:/Cc:/Subject: as their own lines. A SINGLE line that merely resembles a
// header (the issue's own negative test: "a line that resembles an email header") must not trip
// this — only a RUN of several such lines together, including both `From:` and `Subject:` (the pair
// least likely to appear coincidentally), counts as a block.
const FORWARD_HEADER_LINE = /^\s*(from|sent|date|to|cc|subject):\s?\S/i;
const FORWARD_HEADER_MIN_RUN = 3; // From/Sent/To/Subject is 4 lines; require most of that run
const FORWARD_HEADER_KEY = /^\s*(from|sent|date|to|cc|subject):/i;

// A line beginning with one or more `>` (optionally quoted further, `>>`) — classic plain-text quote
// marking, and also what html-to-text emits for a real HTML <blockquote> (verified: it prefixes every
// quoted line with `> `). Anchored at the START of the line, so an inline comparison like "5 > 3"
// mid-sentence — the issue's own negative test — never matches; nobody starts an authored sentence
// with a bare `>`.
const QUOTE_MARK_LINE = /^\s*>+(?:\s|$)/;

function isForwardHeaderBlock(lines, start) {
  const keys = new Set();
  let i = start;
  while (i < lines.length && lines[i].trim() !== '' && FORWARD_HEADER_LINE.test(lines[i])) {
    keys.add(FORWARD_HEADER_KEY.exec(lines[i])[1].toLowerCase());
    i++;
  }
  const runLength = i - start;
  return runLength >= FORWARD_HEADER_MIN_RUN && keys.has('from') && keys.has('subject');
}

export function stripQuotedReply(text) {
  if (!text) return text;
  const lines = text.replace(BR_TAG, '\n').split(/\r?\n/);
  // The earliest boundary found so far, as (lineIndex, charIndex within that line) — charIndex 0
  // means "the whole line and everything after it is gone". Compared lexicographically: a smaller
  // lineIndex always wins; a tie on lineIndex is broken by the smaller charIndex.
  let bestLine = -1;
  let bestChar = 0;
  const consider = (lineIdx, charIdx = 0) => {
    if (bestLine === -1 || lineIdx < bestLine || (lineIdx === bestLine && charIdx < bestChar)) {
      bestLine = lineIdx;
      bestChar = charIdx;
    }
  };

  for (const para of paragraphsWithOffsets(lines)) {
    const at = findWroteBoundary(para.flat);
    if (at !== -1) { const { line, charIdx } = mapFlatOffsetToLine(para.lineOffsets, at); consider(line, charIdx); break; }
  }
  for (let i = 0; i < lines.length; i++) {
    if (
      ORIGINAL_MESSAGE_LINE.test(lines[i]) || FORWARDED_MESSAGE_LINE.test(lines[i])
      || BEGIN_FORWARDED_LINE.test(lines[i]) || UNDERSCORE_SEPARATOR_LINE.test(lines[i])
    ) { consider(i); break; }
  }
  for (let i = 0; i < lines.length; i++) {
    if (FORWARD_HEADER_LINE.test(lines[i]) && isForwardHeaderBlock(lines, i)) { consider(i); break; }
  }
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_MARK_LINE.test(lines[i])) { consider(i); break; }
  }

  if (bestLine === -1) return text; // no confident boundary: return unchanged, byte-identical

  // A confidently-identified boundary at (or near) the very start — a reply whose entire content is
  // quoted material, with no new text above it at all — legitimately strips to ''. Same graceful
  // degradation buildTextRepr already relies on for signature-only/attachment-only bodies (empty
  // snippet, subject-only text_repr): a message contributing no new words is accurately recorded as
  // contributing none.
  return [...lines.slice(0, bestLine), lines[bestLine].slice(0, bestChar)].join('\n').trim();
}

// Whether stripQuotedReply found and applied a boundary — for the run summary (visibility into the
// strip rate), never used to decide what gets stored. Re-derives from stripQuotedReply itself rather
// than duplicating the boundary search, so the two can never disagree.
export function quoteBoundaryFound(text) {
  if (!text) return false;
  return stripQuotedReply(text) !== text;
}
