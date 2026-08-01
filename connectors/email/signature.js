// Pure, I/O-free signature/footer stripping for the email connector (#368). Applied to the
// DECODED body in parse.js's buildTextRepr, before SNIPPET_MAX_CHARS truncation — the point is to
// spend the 1000-char cap on what was actually written, not on a letterhead every message from the
// same account repeats near-verbatim. Never touches rawBody, which still feeds sourceIdFor's hash
// fallback (#362's duplicate hazard — see parse.js's sourceIdFor comment); only the display/snippet
// path is stripped.
//
// Conservative by construction: cut at the EARLIEST confidently-identified signature boundary and
// return everything above it. When no boundary is found, the text comes back byte-identical to the
// input — over-stripping silently destroys real content, which is worse than under-stripping (that
// merely leaves today's behaviour). See test.mjs's negative case: prose that merely contains a
// phone number, a URL, and a `|` character must not be touched.

// A contact block, e.g. `Jordan Lee | Sales Manager | m: 555-201-3048 | jordan@example.com` —
// pipe-delimited fields where at least one field is an email address AND at least one is a phone
// number or a URL. Both signals are required together: a phone number and a URL can appear
// together in ordinary prose (the issue's own negative test does exactly that), but a real email
// address sharing pipe-delimited fields with a phone/URL essentially never does by accident.
//
// Checked per PARAGRAPH (its lines joined with a space), not per physical line: html-to-text wraps
// a signature's fielded line at a column width, splitting e.g. `m: 555-201-3048` from the `|
// jordan@example.com` that follows onto the next physical line — a naive per-line check misses
// exactly this, the common case for a real signature (see #368's real-archive verification).
const EMAIL_TOKEN = /[^\s|]+@[^\s|]+\.[^\s|]+/;
const PHONE_TOKEN = /\+?\d[\d().\s-]{7,}\d/;
const URL_TOKEN = /(https?:\/\/|www\.)\S+/i;
const CONTACT_BLOCK_MAX_CHARS = 600; // a signature paragraph (several wrapped fielded lines) is still short; longer is prose

function isContactBlockParagraph(text) {
  if (text.length > CONTACT_BLOCK_MAX_CHARS) return false;
  const parts = text.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return false;
  const hasEmail = parts.some((p) => EMAIL_TOKEN.test(p));
  const hasPhoneOrUrl = parts.some((p) => PHONE_TOKEN.test(p) || URL_TOKEN.test(p));
  return hasEmail && hasPhoneOrUrl;
}

// Group lines into paragraphs (runs of non-blank lines separated by one or more blank lines),
// each remembering the ORIGINAL index of its first line so a match maps back to a real cut point.
function splitParagraphs(lines) {
  const paragraphs = [];
  let startLine = null;
  let current = [];
  const flush = () => {
    if (startLine !== null) paragraphs.push({ startLine, text: current.join(' ') });
    startLine = null;
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') { flush(); continue; }
    if (startLine === null) startLine = i;
    current.push(lines[i]);
  }
  flush();
  return paragraphs;
}

// RFC 3676 §4.3 signature delimiter: "-- " (dash dash space) alone on its own line. Some clients
// drop the trailing space, so both spellings are accepted.
const SIG_DELIMITER_LINE = /^-- ?$/;

// Mobile-client sign-offs, e.g. "Sent from my iPhone" / "Sent from my Galaxy".
const MOBILE_SIGNOFF = /^\s*sent from my \S/i;

// Legal/nonprofit boilerplate: distinctive multi-word phrases, never a single bare keyword — a
// sentence that merely uses the word "confidential" once must not trip this.
const BOUNDARY_PHRASES = [
  /privileged and(?:\/or)?\s+confidential/i,
  /confidential and(?:\/or)?\s+privileged/i,
  /is intended only for the use of/i,
  /if you are not the intended recipient/i,
  /please notify the sender/i,
  /delete (?:this|the) (?:e-?mail|message)/i,
  /501\s*\(c\)\s*\(3\)/i,
  /\bEIN\b[:#\s]{0,4}\d{2}-?\d{7}\b/i,
  /tax[- ]deductible/i,
];

// Flatten lines into one searchable string (space-joined, not newline-joined) so a boundary phrase
// that a wrapping client happened to split across two lines is still found, then map the match
// position back to the line it started on — the cut always lands on a whole line.
function flatten(lines) {
  let flat = '';
  const lineStarts = [];
  for (const line of lines) {
    lineStarts.push(flat.length);
    flat += `${line} `;
  }
  return { flat, lineStarts };
}

function lineIndexForOffset(lineStarts, offset) {
  let idx = 0;
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineStarts[i] > offset) break;
    idx = i;
  }
  return idx;
}

export function stripSignature(text) {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  let cutAt = -1;
  const consider = (idx) => { if (cutAt === -1 || idx < cutAt) cutAt = idx; };

  for (let i = 0; i < lines.length; i++) {
    if (SIG_DELIMITER_LINE.test(lines[i])) { consider(i); break; }
  }
  for (const para of splitParagraphs(lines)) {
    if (isContactBlockParagraph(para.text)) { consider(para.startLine); break; }
  }
  for (let i = 0; i < lines.length; i++) {
    if (MOBILE_SIGNOFF.test(lines[i])) { consider(i); break; }
  }
  const { flat, lineStarts } = flatten(lines);
  for (const phrase of BOUNDARY_PHRASES) {
    const match = phrase.exec(flat);
    if (match) consider(lineIndexForOffset(lineStarts, match.index));
  }

  if (cutAt === -1) return text; // no confident boundary: return unchanged

  // A confidently-identified boundary at (or near) the very start — a message that IS the signature,
  // start to finish, with no reply text above it at all — legitimately strips to ''. That is not the
  // conservative escape hatch above (which is for when NO boundary is found); it is the same
  // graceful-degradation buildTextRepr already relies on for an attachment-only body (empty snippet,
  // subject-only text_repr) and confirmed against the real archive (#368): every such case inspected
  // was a genuinely content-free body, never a false-positive boundary eating real prose.
  return lines.slice(0, cutAt).join('\n').trim();
}
