// PDF text extraction via pdfjs-dist (the same library lib/rasterize.js renders with — one
// PDF dependency, not two; pdf-parse was tried first but its bundled 2018 pdf.js build fails
// on valid files under current Node). Plus the two PDF-specific judgment calls: parsing the
// PDF date format and deciding whether a file is a scan that needs OCR.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// One owner for the getDocument flags so lib/rasterize.js can't drift (it did: verbosity 0
// was missing there, spamming per-file font warnings through the OCR worker's stderr).
// verbosity 0 = errors only — pdfjs otherwise warns per file about the fake worker and
// missing standard-font data, neither of which affects extraction or rasterization.
export function pdfOpenParams(buffer) {
  return {
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  };
}

// Below this many meaningful chars per page the "text layer" is page numbers/watermarks at
// best: a genuinely scanned PDF yields 0, a scan with a header stamp a handful, real text
// pages 1,000+. A named constant, not an env var — add a knob only when a real corpus
// demands one.
const OCR_CHARS_PER_PAGE = 25;

export function needsOcr(text, numpages) {
  if (!numpages) return false;
  const threshold = numpages * OCR_CHARS_PER_PAGE;
  // Count-with-early-exit instead of text.replace(/\s+/g,'').length — the replace would
  // allocate a full stripped copy of a multi-MB extract just to compare a small number.
  let meaningful = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09 && c !== 0x0c && c !== 0x0b) {
      if (++meaningful >= threshold) return false;
    }
  }
  return true;
}

// PDF dates look like D:20190304143000+05'30' (offset quoted per the spec), with every
// component after the year optional and the D: prefix itself optional in the wild. The
// spec's UTC form also allows digits after Z (D:...Z00'00', emitted by iText et al).
const PDF_DATE = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z(?:'?\d{2}'?)*|[+-]\d{2}(?:'?\d{2}'?)?)?$/;

export function parsePdfDate(value) {
  const m = typeof value === 'string' && PDF_DATE.exec(value.trim());
  if (!m) return null;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', tz] = m;
  let offset = 'Z';
  if (tz && !tz.startsWith('Z')) {
    const t = /([+-])(\d{2})'?(\d{2})?'?/.exec(tz);
    offset = `${t[1]}${t[2]}:${t[3] ?? '00'}`;
  }
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
  // Sanity clamp: broken PDF writers emit epoch garbage (1601-01-01) or future dates; a wrong
  // occurred_at silently mis-sorts the artifact on the timeline, so reject rather than trust.
  if (Number.isNaN(date.getTime()) || Number(year) < 1980 || date > new Date()) return null;
  return date;
}

export async function extractPdf(buffer) {
  const doc = await getDocument(pdfOpenParams(buffer)).promise;
  try {
    const numPages = doc.numPages;
    const pageTexts = [];
    for (let n = 1; n <= numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
      page.cleanup();
    }
    const text = pageTexts.join('\n\n').trim();
    // getMetadata rejects on some malformed-but-renderable files — missing metadata must not
    // fail the whole extraction.
    const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
    const meta = { page_count: numPages };
    // Title is untrusted metadata — cap it so a garbage multi-KB title can't bloat extra/header.
    if (info?.Title) meta.title = String(info.Title).slice(0, 500);
    return { text, occurredAt: parsePdfDate(info?.CreationDate), meta, needsOcr: needsOcr(text, numPages) };
  } finally {
    await doc.destroy();
  }
}
