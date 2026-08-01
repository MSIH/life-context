// Extension → extractor dispatch. Every extractor returns the same shape, and extractDocument
// stamps `format` onto it so callers never re-derive it (dispatch and the recorded value can't
// disagree): { format, text, occurredAt: Date|null, meta: {…type-specific counts/title}, needsOcr }.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPdf } from './pdf.js';
import { extractDocx, extractXlsx, extractPptx } from './ooxml.js';

export function formatOf(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  return ext ? ext.slice(1) : null; // '.PDF' → 'pdf'
}

const EXTRACTORS = { pdf: extractPdf, docx: extractDocx, xlsx: extractXlsx, pptx: extractPptx };

// `buffer` is optional so callers that already read the file (scan.js hashes the same bytes)
// don't force a second read from disk.
export async function extractDocument(absPath, buffer = null) {
  const format = formatOf(absPath);
  const extractor = EXTRACTORS[format];
  if (!extractor) throw new Error(`no extractor for ${absPath}`); // the walker only yields known extensions
  const result = await extractor(buffer ?? (await readFile(absPath)));
  return { format, ...result };
}
