// Shared image decode for both AI enrichment passes (issue #280). sharp (native, fast) is the
// primary path for every format including most HEIC/HEIF; heic-decode (pure-JS libde265/WASM,
// no compiler, no native build step) is the fallback for the iPhone HEICs sharp's bundled libheif
// can't open — ~47% of this library's photos. Extension-first dispatch skips a decode attempt
// known to fail on .heic/.heif; either path falls back to the other on error, because Google
// Takeout sometimes mislabels extensions.
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

let cachedSharp;
async function loadSharp() {
  if (!cachedSharp) {
    const mod = await import('sharp');
    cachedSharp = mod.default ?? mod;
  }
  return cachedSharp;
}

let cachedHeicDecode;
async function loadHeicDecode() {
  if (!cachedHeicDecode) {
    const mod = await import('heic-decode');
    cachedHeicDecode = mod.default ?? mod;
  }
  return cachedHeicDecode;
}

// Test seam: inject `sharp` (the module's default export, called as `sharp(input, opts)`),
// `heicDecode` (heic-decode's default export, called as `decode({ buffer })`), and `readFile`
// instead of the real lazy imports — mirrors fixtureDetector/resolveDetector in
// lib/face-detect.js:148-151. The exported `openImage` below is `createOpenImage()` with no
// overrides, i.e. the real decoders.
export function createOpenImage({ sharp: sharpOverride, heicDecode: heicDecodeOverride, readFile: readFileFn = readFile } = {}) {
  const getSharp = sharpOverride ? async () => sharpOverride : loadSharp;
  const getHeicDecode = heicDecodeOverride ? async () => heicDecodeOverride : loadHeicDecode;
  let warnedHeicFallback = false;

  // sharp path: .rotate() applies EXIF orientation, same as every caller did before this helper.
  // sharp defers the real pixel decode until an output op runs — `sharp(absPath)` never throws
  // for an undecodable file, the same trap as `sharp.metadata()` (which also never decodes; see
  // the module comment). Left unguarded, a mislabeled file (Google Takeout does this) would look
  // like a successful sharp decode here and never fall back to heic-decode — the failure would
  // only surface later, deep in whatever the caller does with the pipeline. Force the decode now,
  // on a clone, so a real failure is caught HERE and triggers the fallback; the pipeline returned
  // to the caller is untouched by the clone and still open for its own resize/colourspace/encode.
  async function decodeWithSharp(absPath) {
    const sharp = await getSharp();
    const pipeline = sharp(absPath).rotate();
    await pipeline.clone().stats();
    return pipeline;
  }

  // heic-decode path: deliberately NO .rotate() — libheif already applies the container's
  // rotation transform during decode. Evidence: IMG_5048/IMG_5049 (from the field) carry an irot
  // box with angle byte 3 (270° CCW = 90° CW) matching their EXIF Orientation: Rotate 90 CW, and
  // heic-decode returns already-rotated (portrait) dimensions. A second, EXIF-driven rotate would
  // double-rotate every portrait iPhone photo — catastrophic for face detection, which depends on
  // upright faces. A raw buffer also carries no EXIF for `.rotate()` to read, so calling it here
  // would be a silent no-op rather than a loud error — the bug would only show up as wrong
  // detections on real photos, never in a test.
  async function decodeWithHeic(absPath) {
    const sharp = await getSharp();
    const decode = await getHeicDecode();
    const buffer = await readFileFn(absPath);
    const { width, height, data } = await decode({ buffer });
    // "fallback" here means relative to sharp overall (the architecture's primary decoder), not
    // per-file dispatch order — this runs for every .heic/.heif file, where heic-decode is the
    // one dispatched FIRST, not a fallback from a failed sharp attempt. Saying so explicitly
    // avoids reading this line as "sharp just failed" when it's the expected, common case.
    if (!warnedHeicFallback) {
      console.error('photo-exif: using heic-decode (the slower ~1s/photo fallback decoder) for', absPath);
      warnedHeicFallback = true;
    }
    // A view over data's existing ArrayBuffer, not Buffer.from(typedArray) (which copies) — a 12MP
    // RGBA decode is already ~48MB; doubling that with an extra memcpy for every HEIC is wasteful.
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } });
  }

  // Returns a sharp pipeline for any supported image, orientation already normalized. Callers
  // apply their own resize/colourspace/encode. Throws if BOTH decoders fail, naming both causes.
  return async function openImage(absPath) {
    const isHeic = HEIC_EXTENSIONS.has(path.extname(absPath).toLowerCase());
    const primary = isHeic ? decodeWithHeic : decodeWithSharp;
    const fallback = isHeic ? decodeWithSharp : decodeWithHeic;
    try {
      return await primary(absPath);
    } catch (primaryErr) {
      try {
        return await fallback(absPath);
      } catch (fallbackErr) {
        const [sharpErr, heicErr] = isHeic ? [fallbackErr, primaryErr] : [primaryErr, fallbackErr];
        throw new Error(`photo-exif: cannot decode ${absPath} (sharp: ${sharpErr.message}; heic-decode: ${heicErr.message})`);
      }
    }
  };
}

export const openImage = createOpenImage();
