// Best-effort text extractor for iMessage's `attributedBody` column — a serialized
// NSAttributedString written via NSKeyedArchiver's binary plist format. Apple does not
// document this format; the approach below (walk every string in the archive, discard known
// NSKeyedArchiver/Apple bookkeeping strings, keep the longest survivor) is the same
// reverse-engineered heuristic most open-source iMessage export tools use, not a real parser
// of NSKeyedArchiver's object graph. It can misfire on a future macOS release that changes
// NSKeyedArchiver's internals — when it can't find a plausible string, it returns null rather
// than guessing, so a caller can distinguish "no text" from "text present."
import bplist from 'bplist-parser';

// Class names, attribute keys, and other archive bookkeeping strings present in every
// attributedBody blob regardless of message content — never the actual message text.
const KNOWN_MARKERS = new Set([
  'NSString', 'NSObject', 'NSDictionary', 'NSMutableString', 'NSMutableDictionary',
  'NSMutableAttributedString', 'NSAttributedString', 'NSNumber', 'NSValue', 'NSArray',
  'NSMutableArray', 'NSData', 'NSMutableData', 'NSUUID', 'NSKeyedArchiver', 'NSFont',
  'NSParagraphStyle', 'NSKern', 'root', '$null', '$class', '$classes', '$classname',
  '__kIMMessagePartAttributeName', '__kIMDataDetectedAttributeName', '__kIMLinkAttributeName',
  '__kIMFileTransferGUIDAttributeName', '__kIMBaseWritingDirectionAttributeName',
  '__kIMMessagePartQuoteRangeAttributeName', '__kIMTextEffectAttributeName',
  '__kIMFilenameAttributeName', '__kIMFileTransferRestingFilenameAttributeName',
  '__kIMOneLineSummaryAttributeName',
]);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_RE = /^[+-]?\d+(\.\d+)?$/;

function collectStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) collectStrings(value[key], out);
  }
}

function isPlausibleMessageText(candidate) {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  if (KNOWN_MARKERS.has(trimmed)) return false;
  if (trimmed.startsWith('__k') || trimmed.startsWith('NS')) return false; // Apple-internal naming convention
  if (GUID_RE.test(trimmed)) return false;
  if (NUMBER_RE.test(trimmed)) return false;
  return true;
}

export function extractText(attributedBodyBuffer) {
  if (!attributedBodyBuffer || attributedBodyBuffer.length === 0) return null;
  let parsed;
  try {
    parsed = bplist.parseBuffer(attributedBodyBuffer);
  } catch {
    return null; // not a bplist this parser understands — degrade to "no text" rather than throw
  }
  const strings = [];
  collectStrings(parsed, strings);
  const candidates = strings.filter(isPlausibleMessageText);
  if (!candidates.length) return null;
  // The message text is reliably the longest surviving string — everything else in the
  // archive is a short class name, attribute key, or identifier.
  return candidates.reduce((longest, s) => (s.length > longest.length ? s : longest), '');
}
