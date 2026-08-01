// text_repr assembly: an always-surviving header line + a whitespace-collapsed,
// head+tail-truncated body. Shared by scan.js and ocr-worker.js so wave-1 and OCR
// representations stay structurally identical.

const FORMAT_LABELS = { pdf: 'PDF', docx: 'DOCX', xlsx: 'XLSX', pptx: 'PPTX' };
// Titles come from untrusted document metadata; uncapped, a garbage multi-KB title would make
// the "always-surviving" header itself blow the payload budget.
const TITLE_MAX_CHARS = 200;
// Hard byte ceiling per text_repr: the char cap counts UTF-16 code units, but the server's
// 256KB request limit counts bytes — 100k CJK chars serialize to ~300KB. This cap is what
// actually guarantees a single payload fits (kept well under shared.js's BATCH_BYTE_BUDGET).
const PAYLOAD_TEXT_BYTE_CAP = 150 * 1024;
// Collapsing runs over the raw extract before truncation; on a multi-MB extract >99% of that
// work is thrown away. Pre-slicing to generous multiples of the cap (collapsing only ever
// shrinks text) bounds the regex passes without changing what survives truncation.
const COLLAPSE_MARGIN = 4;

function countLabel(meta) {
  if (meta.page_count != null) return `${meta.page_count} page${meta.page_count === 1 ? '' : 's'}`;
  if (meta.sheet_count != null) return `${meta.sheet_count} sheet${meta.sheet_count === 1 ? '' : 's'}`;
  if (meta.slide_count != null) return `${meta.slide_count} slide${meta.slide_count === 1 ? '' : 's'}`;
  return null;
}

// `Document (PDF, 12 pages): reports/2019/tax.pdf — "2019 Federal Tax Return"` — the header
// carries format, size, path, and title so the artifact stays findable by filename/title even
// when the body is thin (a not-yet-OCR'd scan) or truncated.
export function buildHeader(format, meta, relPath) {
  const count = countLabel(meta);
  const kind = count ? `${FORMAT_LABELS[format] ?? format}, ${count}` : FORMAT_LABELS[format] ?? format;
  const title = meta.title ? ` — "${String(meta.title).slice(0, TITLE_MAX_CHARS)}"` : '';
  return `Document (${kind}): ${relPath}${title}`;
}

// Collapse horizontal whitespace runs and blank-line stacks, keeping line structure — sheet
// rows and slide lines are meaningful units, so this is not a flatten-to-one-line collapse.
export function collapseWhitespace(text) {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 80/20 head+tail rather than head-only: the end of a letter/contract (conclusions, signature
// blocks) is often the most retrievable part, while full text can't fit — the ingest request
// cap is 256KB and a 1024-dim embedding of hundreds of KB is mush anyway. The full extract
// length is recorded in extra.extracted_chars and raw_path keeps the pointer to everything.
export function truncateHeadTail(text, cap) {
  if (text.length <= cap) return { text, truncated: false };
  if (cap <= 0) return { text: '', truncated: text.length > 0 }; // slice(-0) would return the WHOLE string
  const head = Math.floor(cap * 0.8);
  const tail = cap - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}${tail > 0 ? `\n[... ${omitted} chars omitted ...]\n${text.slice(-tail)}` : ''}`,
    truncated: true,
  };
}

// header + body → { text_repr, extracted_chars, truncated }. The cap applies to the body;
// the header always survives whole. extracted_chars is the RAW extract length (pre-collapse,
// pre-truncation) — the honest "how much text was there" number.
export function buildTextRepr(format, meta, relPath, body, maxChars) {
  const header = buildHeader(format, meta, relPath);
  const raw = body ?? '';
  const bodyCap = Math.max(0, maxChars - header.length - 2);
  const windowed = raw.length > bodyCap * COLLAPSE_MARGIN * 2
    ? `${raw.slice(0, bodyCap * COLLAPSE_MARGIN)}\n${raw.slice(-bodyCap * COLLAPSE_MARGIN)}`
    : raw;
  const collapsed = collapseWhitespace(windowed);
  let { text, truncated } = truncateHeadTail(collapsed, bodyCap);
  truncated = truncated || windowed !== raw;

  let textRepr = text ? `${header}\n\n${text}` : header;
  // Byte backstop: chars ≠ bytes (CJK ≈ 3 bytes/char, control chars 6 as \uXXXX). Halve the
  // body until the whole text_repr serializes under the payload byte cap — converges in a
  // few iterations and almost never runs at the default char cap.
  let effectiveCap = bodyCap;
  while (Buffer.byteLength(JSON.stringify(textRepr)) > PAYLOAD_TEXT_BYTE_CAP && effectiveCap > 0) {
    effectiveCap = Math.floor(effectiveCap / 2);
    ({ text } = truncateHeadTail(collapsed, effectiveCap));
    truncated = true;
    textRepr = text ? `${header}\n\n${text}` : header;
  }

  return { text_repr: textRepr, extracted_chars: raw.length, truncated };
}
