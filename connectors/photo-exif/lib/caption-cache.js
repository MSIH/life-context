// Caption state, refactored from a Set<relPath> to a relPath -> caption-text map so the face
// worker can reconstruct a photo's current text_repr (base EXIF description + caption) before
// appending "Pictured: ...". Without the caption text stored locally, a face-driven upsert would
// have to either drop the caption or re-query the server; keeping the text here avoids both.
//
// Legacy array-format state (a bare list of captioned relPaths, no text) is still read — those
// entries come back caption-less (null), which just means the face worker can't re-append their
// caption sentence until they're re-captioned. Back-compat, no migration step required.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildTextRepr } from './describe.js';

export function readCaptionCache(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (Array.isArray(parsed)) {
      // Legacy [relPath, ...] — captioned, but the caption text wasn't retained.
      console.error('photo-exif: reading legacy caption state (array); entries lack caption text until re-captioned');
      return Object.fromEntries(parsed.map((relPath) => [relPath, null]));
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeCaptionCache(statePath, cache) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(cache));
}

// The photo's text_repr as scan.js + caption-worker.js would have stored it: the base EXIF
// description, plus the caption sentence when one is cached. The face worker appends its own
// "Pictured: ..." to this so the enriched upsert never silently drops the caption.
export function currentTextRepr(dateStr, filename, caption) {
  const base = buildTextRepr(dateStr, filename);
  return caption ? `${base} ${caption}` : base;
}
