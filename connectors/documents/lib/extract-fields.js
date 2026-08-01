// Vendor/amount/date extraction from a document's text (#123). A connector MAY call an LLM for
// extraction (doc 04 §1.2 — the boundary forbids only embeddings and importing src/); this asks a
// local OpenAI-compatible chat model (Ollama by default) for strict JSON, then coerces it. The
// vendor is emitted as an entity HINT with suggested_kind:'org' — the connector never asserts an
// entity id (rule #3); an unknown vendor routes through core's proposed-entities approval queue (#130).
//
// No import from '../.././src' or anywhere in src/ — fetch + built-ins only (npm run check:boundary).

// doc_kind values that denote a spend/vendor document. Only these emit a vendor hint + vendor fields;
// everything else (letter, report, statement, form, other) records just its doc_kind classification.
export const VENDOR_DOC_KINDS = new Set(['receipt', 'invoice', 'bill', 'prescription']);

// The doc_kind vocabulary the model is asked to choose from — the vendor kinds plus common
// non-vendor kinds so classification is bounded, not free-form.
const DOC_KINDS = [...VENDOR_DOC_KINDS, 'statement', 'letter', 'report', 'form', 'other'];

const SYSTEM_PROMPT = [
  'You extract structured fields from the text of a single document. Respond with ONLY a JSON object,',
  'no prose and no code fences, with exactly these keys:',
  '  vendor: the merchant/company/provider that issued or billed the document (a business name), or null',
  '  amount: the grand total as a plain number (no currency symbol, no thousands separators), or null',
  '  currency: the ISO 4217 code (e.g. USD, EUR, GBP), or null',
  '  doc_date: the document\'s own date as YYYY-MM-DD, or null',
  `  doc_kind: one of ${DOC_KINDS.join(', ')}`,
  'Use null for any field the text does not clearly state. Do not guess a vendor or amount that is not present.',
].join('\n');

// Pull a JSON object out of a model response that may wrap it in prose or ```json fences, then coerce
// each field to a safe shape. Never throws — an unparseable/garbage response yields all-null (the doc
// simply gains no vendor fields), which is the right posture for a best-effort enrichment.
export function parseExtraction(raw) {
  const empty = { vendor: null, amount: null, currency: null, doc_date: null, doc_kind: null };
  if (typeof raw !== 'string') return empty;
  // First balanced-looking {...} span — tolerates fences and leading/trailing chatter.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return empty;
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!obj || typeof obj !== 'object') return empty;
  return {
    vendor: coerceString(obj.vendor),
    amount: coerceAmount(obj.amount),
    currency: coerceCurrency(obj.currency),
    doc_date: coerceDate(obj.doc_date),
    doc_kind: coerceDocKind(obj.doc_kind),
  };
}

function coerceString(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.toLowerCase() !== 'null' ? t : null;
}
function coerceAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // Strip currency symbols and thousands separators; keep digits, one dot, a leading minus.
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && v.replace(/[^0-9]/g, '') !== '' ? n : null;
  }
  return null;
}
function coerceCurrency(v) {
  const s = coerceString(v);
  return s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
}
function coerceDate(v) {
  const s = coerceString(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Reject shape-valid but impossible dates (2026-13-45, 2026-02-30): a UTC round-trip must
  // reproduce the exact string, else JS silently rolled it over to a real (wrong) date.
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}
function coerceDocKind(v) {
  const s = coerceString(v);
  return s && DOC_KINDS.includes(s.toLowerCase()) ? s.toLowerCase() : null;
}

// The entity hint(s) for a set of extracted fields: a single org-vendor hint when the doc is a
// vendor kind AND a vendor was found, else none. suggested_kind:'org' routes an unknown vendor
// through core's proposed-entities queue (#130) rather than minting an entity.
export function vendorHintFor(fields) {
  if (!fields.vendor || !VENDOR_DOC_KINDS.has(fields.doc_kind)) return [];
  return [{ alias: fields.vendor, alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }];
}

// The extra-subset to merge onto the artifact: vendor kinds carry the full spend fields; other
// kinds record only their classification (no vendor fields — acceptance: a non-receipt gains none).
export function extractExtraFor(fields) {
  if (fields.doc_kind && VENDOR_DOC_KINDS.has(fields.doc_kind)) {
    return {
      doc_kind: fields.doc_kind,
      vendor: fields.vendor,
      amount: fields.amount,
      currency: fields.currency,
      doc_date: fields.doc_date,
    };
  }
  return fields.doc_kind ? { doc_kind: fields.doc_kind } : {};
}

// Call the chat model and return coerced fields. Throws Error with .status (0 = network) on an
// unreachable/erroring endpoint so the worker can distinguish "server down → stop" from a per-doc
// drop — a successful-but-unparseable response is NOT an error (returns all-null).
export async function extractFields(text, { baseUrl, model, apiKey }) {
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }],
        stream: false,
        temperature: 0,
        // Recent Ollama/OpenAI-compatible servers honor this and reply with a bare JSON object; the
        // parse is defensive regardless, so an older server that ignores it still works.
        response_format: { type: 'json_object' },
      }),
    });
  } catch (err) {
    const wrapped = new Error(`extract chat unreachable: ${err.message}`);
    wrapped.status = 0;
    throw wrapped;
  }
  if (!res.ok) {
    const err = new Error(`extract chat returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return parseExtraction(data?.choices?.[0]?.message?.content);
}
