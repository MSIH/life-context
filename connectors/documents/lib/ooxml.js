// The three OOXML formats (docx/xlsx/pptx) share the docProps/core.xml metadata block, so
// occurred_at + title come from one jszip code path; bodies go through the format-appropriate
// extractor (mammoth for docx prose, exceljs for xlsx, raw slide XML for pptx). exceljs is
// used in document-model mode, not its streaming reader — the stream reader mis-handles zips
// whose worksheet entries precede workbook.xml (model.sheets undefined); memory is bounded by
// scan.js' DOCUMENTS_MAX_FILE_MB guard instead. (exceljs also exposes wb.created, but it
// DEFAULTS to construction time when core.xml lacks the field — indistinguishable from a real
// date and exactly the "guessed occurred_at" doc 04 §3 forbids, so core.xml stays the source.)
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

// One giant sheet must not eat the whole text_repr budget before later sheets get a line in.
const SHEET_TEXT_CAP = 4000;
// DOCUMENTS_MAX_FILE_MB bounds the COMPRESSED size; a zip-bomb entry can inflate 1000:1. Skip
// any single entry that would inflate past this (checked via jszip's internal size field when
// available — best-effort, absent on some construction paths).
const ENTRY_INFLATE_CAP = 64 * 1024 * 1024;
// Same clamp rationale as parsePdfDate: template-epoch and future dates mis-sort the timeline.
const MIN_YEAR = 1990;

export function loadZip(buffer) {
  return JSZip.loadAsync(buffer);
}

function entryTooLarge(entry) {
  const inflated = entry?._data?.uncompressedSize;
  return typeof inflated === 'number' && inflated > ENTRY_INFLATE_CAP;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// Single pass, so a numeric entity that decodes to '&' can't be re-decoded by a later pass
// ('&#38;lt;' must yield '&lt;', not '<'). Out-of-range/surrogate code points keep the raw
// entity text — String.fromCodePoint would throw RangeError and fail the whole file.
export function decodeXmlEntities(text) {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (match, hex, dec, named) => {
    if (named) return XML_ENTITIES[named];
    const code = parseInt(hex ?? dec, hex ? 16 : 10);
    if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
    return String.fromCodePoint(code);
  });
}

// Regex over XML is deliberate here: docProps/core.xml is machine-generated with fixed
// namespace prefixes (ECMA-376 mandates the dcterms/dc names), so a full XML parser
// dependency buys nothing.
export async function parseCoreXml(zip) {
  const entry = zip.file('docProps/core.xml');
  if (!entry || entryTooLarge(entry)) return { created: null, title: null };
  const xml = await entry.async('string');
  const titleMatch = /<dc:title[^>]*>([^<]+)<\/dc:title>/.exec(xml);
  const createdMatch = /<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/.exec(xml);
  let created = null;
  if (createdMatch) {
    let value = createdMatch[1].trim();
    // W3CDTF requires a timezone designator, but lenient writers omit it — and bare
    // 'YYYY-MM-DDTHH:mm:ss' is parsed as LOCAL time by new Date(), shifting occurred_at by
    // the scanning machine's offset. Treat missing TZ as UTC, matching parsePdfDate.
    if (/T\d{2}:\d{2}/.test(value) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) value += 'Z';
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getFullYear() >= MIN_YEAR && date <= new Date()) created = date;
  }
  const title = titleMatch ? decodeXmlEntities(titleMatch[1].trim()).slice(0, 500) || null : null;
  return { created, title };
}

export async function extractPptxText(zip) {
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1])); // slide10 after slide9
  const lines = [];
  for (const name of slideNames) {
    const entry = zip.file(name);
    if (entryTooLarge(entry)) {
      console.error(`documents: skipping oversized slide entry ${name}`);
      continue;
    }
    const xml = await entry.async('string');
    // PowerPoint splits single words across <a:t> runs (formatting/spell-check boundaries),
    // so runs within one <a:p> paragraph concatenate with NO separator; paragraphs (and thus
    // separate text boxes, which each hold ≥1 paragraph) are joined with a space.
    const paragraphs = xml.split('</a:p>')
      .map((chunk) => [...chunk.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1])).join(''))
      .filter((p) => p.trim());
    const text = paragraphs.join(' ').trim();
    if (text) lines.push(`Slide ${Number(name.match(/(\d+)/)[1])}: ${text}`);
  }
  return { text: lines.join('\n'), slideCount: slideNames.length };
}

export async function extractDocx(buffer) {
  const [{ value }, core] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    loadZip(buffer).then(parseCoreXml),
  ]);
  const meta = {};
  if (core.title) meta.title = core.title;
  return { text: value ?? '', occurredAt: core.created, meta, needsOcr: false };
}

// Cell values from exceljs come in several shapes; flatten each to display text.
function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if (value.result != null) return cellText(value.result); // formula → cached result only
    if (value.text != null) return cellText(value.text); // hyperlink — .text itself can be a richText object
    if (value.error != null) return String(value.error);
    return '';
  }
  return String(value);
}

export async function extractXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheetNames = [];
  const parts = [];
  wb.eachSheet((worksheet) => {
    sheetNames.push(worksheet.name);
    const lines = [`Sheet "${worksheet.name}":`];
    let chars = 0;
    let capped = false;
    worksheet.eachRow((row) => {
      if (capped) return;
      const cells = (row.values ?? []).map(cellText).filter((t) => t !== '');
      if (!cells.length) return;
      const line = cells.join(' | ');
      lines.push(line);
      chars += line.length;
      if (chars > SHEET_TEXT_CAP) {
        lines.push('[... sheet truncated ...]');
        capped = true;
      }
    });
    parts.push(lines.join('\n'));
  });
  const core = await loadZip(buffer).then(parseCoreXml);
  const meta = { sheet_count: sheetNames.length, sheet_names: sheetNames };
  if (core.title) meta.title = core.title;
  return { text: parts.join('\n\n'), occurredAt: core.created, meta, needsOcr: false };
}

export async function extractPptx(buffer) {
  const zip = await loadZip(buffer);
  const [{ text, slideCount }, core] = await Promise.all([extractPptxText(zip), parseCoreXml(zip)]);
  const meta = { slide_count: slideCount };
  if (core.title) meta.title = core.title;
  return { text, occurredAt: core.created, meta, needsOcr: false };
}
