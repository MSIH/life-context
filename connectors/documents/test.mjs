// Synthesizes real fixture files in-test (hand-assembled PDFs, jszip-built docx/pptx,
// exceljs-built xlsx — no binary fixtures checked in) and runs scan.js / ocr-worker.js
// against them with a mock ingest server. The real tesseract/pdfjs OCR path is manual
// verification (README.md), same posture as photo-exif's no-VLM-in-CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { chunkByBudget, BATCH_MAX, BATCH_BYTE_BUDGET, DOCUMENT_EXTENSIONS, statKeyOf, envNumber } from './lib/shared.js';
import { truncateHeadTail, collapseWhitespace, buildHeader, buildTextRepr } from './lib/text-repr.js';
import { parsePdfDate, needsOcr } from './lib/pdf.js';
import { parseCoreXml, extractPptxText, decodeXmlEntities, loadZip } from './lib/ooxml.js';
import { formatOf } from './lib/extract.js';
import { parseExtraction, vendorHintFor, extractExtraFor } from './lib/extract-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+; this connector's floor is 20.0

// --- fixture builders ---

// Assembles a minimal but structurally valid PDF (computed xref offsets) — one page per entry
// in pageTexts; an empty string yields a page with no text layer (the "scanned PDF" case).
function makePdf({ pageTexts = ['Hello'], creationDate, title } = {}) {
  const n = pageTexts.length;
  const pageObj = (i) => 4 + 2 * i;
  const contentObj = (i) => 5 + 2 * i;
  const infoObj = 4 + 2 * n;
  const esc = (t) => t.replace(/([()\\])/g, '\\$1');

  const bodies = new Map();
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  bodies.set(2, `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  bodies.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pageTexts.forEach((text, i) => {
    bodies.set(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
    const stream = text ? `BT /F1 24 Tf 72 720 Td (${esc(text)}) Tj ET` : '';
    bodies.set(contentObj(i), `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const info = [];
  if (creationDate) info.push(`/CreationDate (${creationDate})`);
  if (title) info.push(`/Title (${esc(title)})`);
  bodies.set(infoObj, `<< ${info.join(' ')} >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const [num, body] of bodies) {
    offsets[num] = out.length;
    out += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${infoObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= infoObj; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'binary');
}

const CORE_XML = ({ created, title }) => `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title ? `<dc:title>${title}</dc:title>` : ''}${created ? `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` : ''}</cp:coreProperties>`;

async function makeDocx({ paragraphs, created, title }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  if (created || title) zip.file('docProps/core.xml', CORE_XML({ created, title }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makePptx({ slides, created, title }) {
  const zip = new JSZip();
  slides.forEach((runs, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${runs.map((r) => `<a:t>${r}</a:t>`).join('<a:t> </a:t>')}</p:spTree></p:cSld></p:sld>`);
  });
  if (created || title) zip.file('docProps/core.xml', CORE_XML({ created, title }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeXlsx({ sheets, created }) {
  const wb = new ExcelJS.Workbook();
  if (created) wb.created = created;
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- test harness (mirrors photo-exif/test.mjs) ---

function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: parsed });
      handler(req, parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

function batchOkHandler(req, body, res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    summary: {},
    results: (body.artifacts ?? []).map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
  }));
}

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// --- pure-function tests ---

test('truncateHeadTail: passthrough under cap, head+tail split over it, cap 0 drops the body', () => {
  assert.deepEqual(truncateHeadTail('short', 100), { text: 'short', truncated: false });
  const long = 'A'.repeat(900) + 'MIDDLE' + 'Z'.repeat(900);
  const { text, truncated } = truncateHeadTail(long, 200);
  assert.equal(truncated, true);
  assert.ok(text.length < long.length);
  assert.ok(text.startsWith('AAA'), 'head preserved');
  assert.ok(text.endsWith('ZZZ'), 'tail preserved');
  assert.match(text, /\[\.\.\. \d+ chars omitted \.\.\.\]/);
  // Regression: slice(-0) returns the WHOLE string — cap 0 must drop the body, not leak it.
  assert.deepEqual(truncateHeadTail(long, 0), { text: '', truncated: true });
});

test('buildTextRepr: header survives a tiny cap intact; body capped; byte backstop on multibyte text', () => {
  const body = 'word '.repeat(2000);
  const capped = buildTextRepr('pdf', { page_count: 2 }, 'a.pdf', body, 120);
  assert.ok(capped.text_repr.startsWith('Document (PDF, 2 pages): a.pdf'));
  assert.ok(capped.text_repr.length <= 200, 'body honors the cap');
  assert.equal(capped.truncated, true);
  assert.equal(capped.extracted_chars, body.length);
  // 100k 3-byte CJK chars would serialize to ~300KB; the byte backstop must keep the payload text under ~150KB.
  const cjk = buildTextRepr('pdf', {}, 'b.pdf', '漢'.repeat(100000), 100000);
  assert.ok(Buffer.byteLength(JSON.stringify(cjk.text_repr)) <= 150 * 1024);
  assert.equal(cjk.truncated, true);
});

test('envNumber: blank means unset, explicit zero is honored', () => {
  process.env.TEST_ENV_NUM = '';
  assert.equal(envNumber('TEST_ENV_NUM', 50), 50, 'set-but-blank falls back to the default');
  process.env.TEST_ENV_NUM = '0';
  assert.equal(envNumber('TEST_ENV_NUM', 50), 0, 'explicit 0 must win over the default');
  process.env.TEST_ENV_NUM = 'abc';
  assert.equal(envNumber('TEST_ENV_NUM', 50), 50);
  delete process.env.TEST_ENV_NUM;
  assert.equal(envNumber('TEST_ENV_NUM', 50), 50);
});

test('collapseWhitespace: collapses runs and blank-line stacks, keeps line structure', () => {
  assert.equal(collapseWhitespace('a  \t b\n\n\n\nc   \n  d'), 'a b\n\nc\nd');
});

test('buildHeader: format label, counts, title', () => {
  assert.equal(buildHeader('pdf', { page_count: 12, title: 'Tax Return' }, 'r/tax.pdf'), 'Document (PDF, 12 pages): r/tax.pdf — "Tax Return"');
  assert.equal(buildHeader('xlsx', { sheet_count: 1 }, 'b.xlsx'), 'Document (XLSX, 1 sheet): b.xlsx');
  assert.equal(buildHeader('docx', {}, 'notes.docx'), 'Document (DOCX): notes.docx');
});

test('chunkByBudget: splits by serialized size and by the 100-item cap', () => {
  const big = (i) => ({ payload: { source_id: `f${i}`, text_repr: 'x'.repeat(60 * 1024) } });
  const bigGroups = chunkByBudget([big(1), big(2), big(3), big(4), big(5)]);
  assert.ok(bigGroups.length >= 2, 'oversized payloads split into multiple groups');
  for (const g of bigGroups) {
    assert.ok(Buffer.byteLength(JSON.stringify({ artifacts: g.map((x) => x.payload) })) < 256 * 1024, 'every request stays under the 256KB cap');
  }
  const tiny = Array.from({ length: 150 }, (_, i) => ({ payload: { source_id: `t${i}` } }));
  const tinyGroups = chunkByBudget(tiny);
  assert.equal(tinyGroups.length, 2);
  assert.equal(tinyGroups[0].length, BATCH_MAX);
  assert.ok(BATCH_BYTE_BUDGET < 256 * 1024);

  // A solo item over the budget still forms its own group (never dropped, never looped).
  const solo = chunkByBudget([{ payload: { text_repr: 'x'.repeat(BATCH_BYTE_BUDGET + 1024) } }]);
  assert.equal(solo.length, 1);
  assert.equal(solo[0].length, 1);
});

test('extension dispatch: known extensions map, case-insensitively; others are not walked', () => {
  assert.equal(formatOf('a/B.PDF'), 'pdf');
  assert.equal(formatOf('report.docx'), 'docx');
  assert.ok(DOCUMENT_EXTENSIONS.has('.pptx'));
  assert.ok(!DOCUMENT_EXTENSIONS.has('.txt'));
});

test('parsePdfDate: offsets, quote quirks, partial dates, garbage', () => {
  assert.equal(parsePdfDate("D:20190304143000+05'30'").toISOString(), '2019-03-04T09:00:00.000Z');
  assert.equal(parsePdfDate('D:20190304143000Z').toISOString(), '2019-03-04T14:30:00.000Z');
  assert.equal(parsePdfDate("D:20190304143000Z00'00'").toISOString(), '2019-03-04T14:30:00.000Z'); // spec-legal UTC form (iText)
  assert.equal(parsePdfDate('D:2019').toISOString(), '2019-01-01T00:00:00.000Z');
  assert.equal(parsePdfDate('20190304143000Z').toISOString(), '2019-03-04T14:30:00.000Z'); // D: optional in the wild
  assert.equal(parsePdfDate('D:16010101000000Z'), null, 'epoch garbage rejected');
  assert.equal(parsePdfDate('D:29990101000000Z'), null, 'future rejected');
  assert.equal(parsePdfDate('not a date'), null);
  assert.equal(parsePdfDate(undefined), null);
});

test('parseCoreXml: valid W3CDTF + title, missing element, malformed date, clamps, missing-TZ-as-UTC', async () => {
  const ok = await loadZip(await makePptx({ slides: [['x']], created: '2021-06-15T10:00:00Z', title: 'Deck &amp; Notes' }));
  const core = await parseCoreXml(ok);
  assert.equal(core.created.toISOString(), '2021-06-15T10:00:00.000Z');
  assert.equal(core.title, 'Deck & Notes');
  const none = await loadZip(await makePptx({ slides: [['x']] }));
  assert.deepEqual(await parseCoreXml(none), { created: null, title: null });
  const bad = await loadZip(await makePptx({ slides: [['x']], created: 'garbage' }));
  assert.equal((await parseCoreXml(bad)).created, null);
  const future = await loadZip(await makePptx({ slides: [['x']], created: '2999-01-01T00:00:00Z' }));
  assert.equal((await parseCoreXml(future)).created, null, 'future dates rejected');
  const epoch = await loadZip(await makePptx({ slides: [['x']], created: '1989-06-01T00:00:00Z' }));
  assert.equal((await parseCoreXml(epoch)).created, null, 'pre-1990 template epochs rejected');
  // Lenient writers omit the TZ designator; new Date() would read that as LOCAL time.
  const noTz = await loadZip(await makePptx({ slides: [['x']], created: '2021-06-15T10:00:00' }));
  assert.equal((await parseCoreXml(noTz)).created.toISOString(), '2021-06-15T10:00:00.000Z', 'missing TZ treated as UTC');
});

test('needsOcr: thresholds', () => {
  assert.equal(needsOcr('', 3), true);
  assert.equal(needsOcr('page 1  page 2  page 3', 3), true, 'stamp-only text still flagged');
  assert.equal(needsOcr('x'.repeat(5000), 3), false);
  assert.equal(needsOcr('', 0), false, 'zero pages is not a scan');
});

test('extractPptxText: slide order (slide10 after slide9), run/paragraph joining, entity decode', async () => {
  const zip = new JSZip();
  for (let i = 1; i <= 10; i++) zip.file(`ppt/slides/slide${i}.xml`, `<p:sld xmlns:a="x"><a:t>Slide body ${i} &amp; more</a:t></p:sld>`);
  const { text, slideCount } = await extractPptxText(await loadZip(await zip.generateAsync({ type: 'nodebuffer' })));
  assert.equal(slideCount, 10);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Slide 1: Slide body 1 & more');
  assert.equal(lines[9], 'Slide 10: Slide body 10 & more');

  // PowerPoint splits words across runs within a paragraph — they must join with NO space,
  // while separate paragraphs (and text boxes) join with one.
  const split = new JSZip();
  split.file('ppt/slides/slide1.xml', '<p:sld xmlns:a="x"><a:p><a:r><a:t>inter</a:t></a:r><a:r><a:t>national</a:t></a:r></a:p><a:p><a:t>Second para</a:t></a:p></p:sld>');
  const joined = await extractPptxText(await loadZip(await split.generateAsync({ type: 'nodebuffer' })));
  assert.equal(joined.text, 'Slide 1: international Second para');

  assert.equal(decodeXmlEntities('&lt;a&gt; &#65;&#x42;'), '<a> AB');
  assert.equal(decodeXmlEntities('&#38;lt;'), '&lt;', 'numeric & must not be re-decoded by the named pass');
  assert.equal(decodeXmlEntities('x &#x110000; y'), 'x &#x110000; y', 'out-of-range code point kept raw, not RangeError');
});

// --- end-to-end: scan.js against generated fixtures + mock ingest server ---

test('scan.js: mixed fixture dir → correct payloads per format; unchanged-file skip on re-run', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-test-'));
  writeFileSync(path.join(tmp, 'report.pdf'), makePdf({
    pageTexts: ['The quarterly engineering figures improved substantially this period.'],
    creationDate: 'D:20190304143000Z',
    title: 'Q1 Report',
  }));
  writeFileSync(path.join(tmp, 'notes.docx'), await makeDocx({
    paragraphs: ['Meeting notes about the veranda renovation budget.'],
    created: '2021-06-15T10:00:00Z',
    title: 'Renovation Notes',
  }));
  writeFileSync(path.join(tmp, 'budget.xlsx'), await makeXlsx({
    sheets: { Q1: [['Item', 'Cost'], ['Lumber', 1200]], Q2: [['Item', 'Cost'], ['Paint', 300]] },
    created: new Date('2022-01-05T08:00:00Z'),
  }));
  writeFileSync(path.join(tmp, 'deck.pptx'), await makePptx({
    slides: [['Roadmap overview'], ['Milestones &amp; risks']],
  }));

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const manifestPath = path.join(tmp, 'manifest.json');
  const queuePath = path.join(tmp, 'ocr-queue.json');
  const env = {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: manifestPath,
    DOCUMENTS_OCR_QUEUE_PATH: queuePath,
  };
  const result = await run('scan.js', env);
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const artifacts = requests.flatMap((r) => r.body.artifacts);
  assert.equal(artifacts.length, 4, result.stderr);
  for (const a of artifacts) {
    assert.equal(a.source, 'documents');
    assert.equal(a.type, 'document');
    assert.match(a.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(path.isAbsolute(a.raw_path));
    assert.equal(a.extra.ocr_done, false);
  }

  const pdf = artifacts.find((a) => a.source_id === 'report.pdf');
  assert.ok(pdf.text_repr.startsWith('Document (PDF, 1 page): report.pdf — "Q1 Report"'));
  assert.ok(pdf.text_repr.includes('quarterly engineering figures'));
  assert.equal(pdf.occurred_at, '2019-03-04T14:30:00.000Z');
  assert.equal(pdf.extra.format, 'pdf');
  assert.equal(pdf.extra.page_count, 1);
  assert.equal(pdf.extra.needs_ocr, false);

  const docx = artifacts.find((a) => a.source_id === 'notes.docx');
  assert.ok(docx.text_repr.includes('veranda renovation budget'));
  assert.equal(docx.occurred_at, '2021-06-15T10:00:00.000Z');
  assert.equal(docx.extra.title, 'Renovation Notes');

  const xlsx = artifacts.find((a) => a.source_id === 'budget.xlsx');
  assert.ok(xlsx.text_repr.includes('Sheet "Q1":'));
  assert.ok(xlsx.text_repr.includes('Lumber | 1200'));
  assert.equal(xlsx.occurred_at, '2022-01-05T08:00:00.000Z');
  assert.deepEqual(xlsx.extra.sheet_names, ['Q1', 'Q2']);
  assert.equal(xlsx.extra.sheet_count, 2);

  const pptx = artifacts.find((a) => a.source_id === 'deck.pptx');
  assert.ok(pptx.text_repr.includes('Slide 1: Roadmap overview'));
  assert.ok(pptx.text_repr.includes('Slide 2: Milestones & risks'));
  assert.equal(pptx.occurred_at, undefined, 'no metadata date -> omitted, never guessed from mtime');
  assert.equal(pptx.extra.slide_count, 2);

  // Documents with a real text layer must stay OUT of the OCR queue.
  assert.deepEqual(JSON.parse(readFileSync(queuePath, 'utf8')), {});

  // Re-run with the same (populated) manifest: nothing changed on disk, so nothing re-sent.
  const { server: server2, port: port2, requests: requests2 } = await startMockServer(batchOkHandler);
  const rerun = await run('scan.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port2}` });
  server2.closeAllConnections();
  server2.close();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(requests2.length, 0, 'unchanged files are skipped on re-scan');
});

test('scan.js: image-only PDF ingests thin with needs_ocr and lands in the OCR queue', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-ocr-flag-'));
  writeFileSync(path.join(tmp, 'scanned.pdf'), makePdf({ pageTexts: ['', '', ''] }));

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const queuePath = path.join(tmp, 'ocr-queue.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    DOCUMENTS_OCR_QUEUE_PATH: queuePath,
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const [artifact] = requests[0].body.artifacts;
  assert.equal(artifact.extra.needs_ocr, true);
  assert.equal(artifact.text_repr, 'Document (PDF, 3 pages): scanned.pdf', 'header-only text_repr is still searchable by filename');

  const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  const stat = statSync(path.join(tmp, 'scanned.pdf'));
  assert.deepEqual(Object.keys(queue), ['scanned.pdf']);
  assert.equal(queue['scanned.pdf'].statKey, statKeyOf(stat));
  // The FULL wave-1 extra, not a subset — the worker resends it whole (extra_json overwrites whole).
  assert.deepEqual(queue['scanned.pdf'].extra, artifact.extra);
});

test('scan.js: per-item batch failure is not manifested (retried next run) while successes are', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-item-fail-'));
  writeFileSync(path.join(tmp, 'bad.docx'), await makeDocx({ paragraphs: ['First document body.'] }));
  writeFileSync(path.join(tmp, 'good.docx'), await makeDocx({ paragraphs: ['Second document body.'] }));

  const { server, port } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      summary: {},
      // Index-aligned per-item results, one failed — mirrors src/ingest.js's batch shape.
      results: body.artifacts.map((a, i) => (a.source_id === 'bad.docx'
        ? { error: 'validation', issues: [{ path: ['text_repr'] }] }
        : { id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: manifestPath,
    DOCUMENTS_OCR_QUEUE_PATH: path.join(tmp, 'ocr-queue.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /item failed bad\.docx/);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['good.docx'], 'failed item must be retried next run, not cached as done');
});

test('scan.js: DOCUMENTS_TEXT_REPR_MAX_CHARS caps text_repr end-to-end with the header intact', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-truncate-'));
  writeFileSync(path.join(tmp, 'long.docx'), await makeDocx({ paragraphs: [`start ${'lorem ipsum '.repeat(500)}end`] }));

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    DOCUMENTS_OCR_QUEUE_PATH: path.join(tmp, 'ocr-queue.json'),
    DOCUMENTS_TEXT_REPR_MAX_CHARS: '200',
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const [artifact] = requests[0].body.artifacts;
  assert.ok(artifact.text_repr.startsWith('Document (DOCX): long.docx'), 'header survives truncation whole');
  assert.ok(artifact.text_repr.length <= 300, `text_repr should honor the cap, got ${artifact.text_repr.length}`);
  assert.equal(artifact.extra.truncated, true);
  assert.ok(artifact.extra.extracted_chars > 5000, 'extracted_chars records the full pre-truncation length');
});

test('scan.js: same filename in different subdirectories gets distinct source_ids', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-nested-'));
  mkdirSync(path.join(tmp, '2019'), { recursive: true });
  mkdirSync(path.join(tmp, '2020'), { recursive: true });
  const docx = await makeDocx({ paragraphs: ['Same name, different year.'] });
  writeFileSync(path.join(tmp, '2019', 'notes.docx'), docx);
  writeFileSync(path.join(tmp, '2020', 'notes.docx'), docx);

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    DOCUMENTS_OCR_QUEUE_PATH: path.join(tmp, 'ocr-queue.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const ids = requests[0].body.artifacts.map((a) => a.source_id).sort();
  assert.deepEqual(ids, ['2019/notes.docx', '2020/notes.docx']);
});

test('scan.js: oversize file skipped without ingest or manifest entry', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-oversize-'));
  writeFileSync(path.join(tmp, 'big.pdf'), makePdf({ pageTexts: ['some text'] }));

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: manifestPath,
    DOCUMENTS_OCR_QUEUE_PATH: path.join(tmp, 'ocr-queue.json'),
    DOCUMENTS_MAX_FILE_MB: '0', // explicit 0 must be honored, not fall back to the default
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /oversize/);
  // Manifest is written per successful batch; a run that ingested nothing writes nothing.
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // no file — equivalent to an empty manifest
  }
  assert.deepEqual(manifest, {}, 'not manifested — raising the limit later picks it up');
});

// --- vendor extraction (#123) ---

test('parseExtraction: coerces types, tolerates fences/prose, garbage -> all null', () => {
  const ok = parseExtraction('```json\n{"vendor":"  ACME Hardware ","amount":"$1,240.50","currency":"usd","doc_date":"2026-03-04","doc_kind":"Receipt"}\n```');
  assert.deepEqual(ok, { vendor: 'ACME Hardware', amount: 1240.5, currency: 'USD', doc_date: '2026-03-04', doc_kind: 'receipt' });
  // Prose around the object; a numeric amount; an out-of-vocab doc_kind and a malformed date drop to null.
  const prose = parseExtraction('Here you go: {"vendor":null,"amount":42,"currency":"EUR","doc_date":"03/04/2026","doc_kind":"memo"} — done');
  assert.deepEqual(prose, { vendor: null, amount: 42, currency: 'EUR', doc_date: null, doc_kind: null });
  // Non-JSON / empty / non-string all collapse to the empty shape rather than throwing.
  for (const bad of ['no json here', '', null, undefined, '{not json}']) {
    assert.deepEqual(parseExtraction(bad), { vendor: null, amount: null, currency: null, doc_date: null, doc_kind: null });
  }
  // "null" as a literal string and a currency that isn't 3 letters are rejected.
  assert.deepEqual(parseExtraction('{"vendor":"null","currency":"dollars","amount":"n/a"}'),
    { vendor: null, amount: null, currency: null, doc_date: null, doc_kind: null });
  // A shape-valid but impossible date is rejected, not silently rolled over to a real one.
  assert.equal(parseExtraction('{"doc_date":"2026-13-45"}').doc_date, null);
  assert.equal(parseExtraction('{"doc_date":"2026-02-30"}').doc_date, null);
  assert.equal(parseExtraction('{"doc_date":"2026-02-28"}').doc_date, '2026-02-28');
});

test('vendorHintFor: org hint only for a vendor kind WITH a vendor', () => {
  assert.deepEqual(vendorHintFor({ vendor: 'ACME', doc_kind: 'receipt' }),
    [{ alias: 'ACME', alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }]);
  assert.deepEqual(vendorHintFor({ vendor: 'ACME', doc_kind: 'invoice' }).length, 1);
  assert.deepEqual(vendorHintFor({ vendor: 'ACME', doc_kind: 'letter' }), [], 'non-vendor kind emits no hint');
  assert.deepEqual(vendorHintFor({ vendor: null, doc_kind: 'receipt' }), [], 'no vendor => no hint');
});

test('extractExtraFor: vendor kinds carry spend fields; others record only doc_kind', () => {
  assert.deepEqual(extractExtraFor({ vendor: 'ACME', amount: 42.5, currency: 'USD', doc_date: '2026-03-04', doc_kind: 'receipt' }),
    { doc_kind: 'receipt', vendor: 'ACME', amount: 42.5, currency: 'USD', doc_date: '2026-03-04' });
  assert.deepEqual(extractExtraFor({ vendor: null, doc_kind: 'letter' }), { doc_kind: 'letter' }, 'no vendor fields for a non-vendor kind');
  assert.deepEqual(extractExtraFor({ vendor: null, doc_kind: null }), {}, 'unclassified doc adds nothing');
});

// End-to-end: one mock server answers BOTH the chat endpoint (/v1/chat/completions) and ingest
// (/api/v1/ingest), so the worker's LLM call and upsert are both observed.
function vendorMockServer(chatContent) {
  return startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/chat/completions')) {
      res.end(JSON.stringify({ choices: [{ message: { content: chatContent } }] }));
    } else if (!body.text_repr) {
      // Mirror the server's schema (text_repr is required, .min(1)) so a worker that forgets to
      // resend it fails the test instead of silently passing against a lenient mock.
      res.statusCode = 422;
      res.end(JSON.stringify({ error: 'validation', issues: [{ path: ['text_repr'] }] }));
    } else {
      res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 1 }));
    }
  });
}

test('vendor-worker.js: a receipt gains extra fields + an org vendor hint; queue drained', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-vendor-'));
  writeFileSync(path.join(tmp, 'receipt.pdf'), 'dummy');
  const queuePath = path.join(tmp, 'extract-queue.json');
  const statKey = statKeyOf(statSync(path.join(tmp, 'receipt.pdf')));
  writeFileSync(queuePath, JSON.stringify({
    'receipt.pdf': { statKey, extra: { format: 'pdf', needs_ocr: false, ocr_done: false }, text_repr: 'Document (PDF): receipt.pdf\nACME Hardware\nTotal: $42.50\n2026-03-04' },
  }));

  const { server, port, requests } = await vendorMockServer(JSON.stringify({
    vendor: 'ACME Hardware', amount: 42.5, currency: 'USD', doc_date: '2026-03-04', doc_kind: 'receipt',
  }));
  const result = await run('vendor-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_EXTRACT_QUEUE_PATH: queuePath,
    DOCUMENTS_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    DOCUMENTS_EXTRACT_THROTTLE_MS: '0',
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const ingest = requests.find((r) => r.url.endsWith('/api/v1/ingest'));
  assert.ok(ingest, 'an ingest upsert was sent');
  assert.equal(ingest.body.source_id, 'receipt.pdf');
  assert.equal(ingest.body.text_repr, 'Document (PDF): receipt.pdf\nACME Hardware\nTotal: $42.50\n2026-03-04', 'text_repr resent unchanged (schema requires it; identical => no re-embed)');
  assert.equal(ingest.body.extra.vendor, 'ACME Hardware');
  assert.equal(ingest.body.extra.amount, 42.5);
  assert.equal(ingest.body.extra.doc_kind, 'receipt');
  assert.equal(ingest.body.extra.format, 'pdf', 'prior extra preserved (resent whole)');
  assert.deepEqual(ingest.body.entity_hints, [{ alias: 'ACME Hardware', alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }]);
  assert.deepEqual(JSON.parse(readFileSync(queuePath, 'utf8')), {}, 'queue drained on success');
});

test('vendor-worker.js: a non-vendor doc records doc_kind but emits no vendor fields or hint', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-vendor-none-'));
  writeFileSync(path.join(tmp, 'letter.pdf'), 'dummy');
  const queuePath = path.join(tmp, 'extract-queue.json');
  const statKey = statKeyOf(statSync(path.join(tmp, 'letter.pdf')));
  writeFileSync(queuePath, JSON.stringify({
    'letter.pdf': { statKey, extra: { format: 'pdf', needs_ocr: false }, text_repr: 'Document (PDF): letter.pdf\nDear Sir, ...' },
  }));

  const { server, port, requests } = await vendorMockServer(JSON.stringify({
    vendor: null, amount: null, currency: null, doc_date: null, doc_kind: 'letter',
  }));
  const result = await run('vendor-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_EXTRACT_QUEUE_PATH: queuePath,
    DOCUMENTS_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    DOCUMENTS_EXTRACT_THROTTLE_MS: '0',
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const ingest = requests.find((r) => r.url.endsWith('/api/v1/ingest'));
  assert.ok(ingest, 'the doc_kind classification is still recorded');
  assert.equal(ingest.body.extra.doc_kind, 'letter');
  assert.equal(ingest.body.extra.vendor, undefined, 'no vendor field on a non-vendor doc');
  assert.equal(ingest.body.entity_hints, undefined, 'no entity hint on a non-vendor doc');
});

test('vendor-worker.js: stale statKey entry dropped without a chat or ingest call', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-vendor-stale-'));
  const queuePath = path.join(tmp, 'extract-queue.json');
  // Points at a file that doesn't exist -> stale -> dropped before any network call.
  writeFileSync(queuePath, JSON.stringify({ 'gone.pdf': { statKey: '1:1', extra: { format: 'pdf' }, text_repr: 'x' } }));

  const { server, port, requests } = await vendorMockServer('{}');
  const result = await run('vendor-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_EXTRACT_QUEUE_PATH: queuePath,
    DOCUMENTS_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /dropping stale extraction queue entry gone\.pdf/);
  assert.equal(requests.length, 0, 'no chat or ingest call for a stale entry');
  assert.deepEqual(JSON.parse(readFileSync(queuePath, 'utf8')), {});
});

test('ocr-worker.js: stale statKey entry dropped without ingest; queue rewritten', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-stale-'));
  const queuePath = path.join(tmp, 'ocr-queue.json');
  // Entry points at a file that no longer exists — must be dropped before tesseract ever loads.
  writeFileSync(queuePath, JSON.stringify({ 'gone.pdf': { statKey: '1:1', extra: { format: 'pdf', needs_ocr: true } } }));

  const result = await run('ocr-worker.js', {
    LIFECONTEXT_URL: 'http://127.0.0.1:19999', // nothing listening — must not be contacted
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_OCR_QUEUE_PATH: queuePath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /dropping stale OCR queue entry gone\.pdf/);
  assert.deepEqual(JSON.parse(readFileSync(queuePath, 'utf8')), {});
});
