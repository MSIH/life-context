// PDF page → PNG buffers for tesseract. Imported ONLY by ocr-worker.js — scan.js must never
// load pdfjs/canvas, so the fast path stays dependency-light at runtime.
//
// pdfjs-dist legacy build + @napi-rs/canvas: both work on Node 18+ without a node-gyp/Cairo
// toolchain (napi-rs ships prebuilt win32-x64 binaries). If this pairing proves flaky, this
// module is the single swap point for an external poppler `pdftoppm` binary instead.
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfOpenParams } from './pdf.js';

const RENDER_SCALE = 2; // 72dpi base × 2 ≈ 144 DPI — enough for OCR without huge bitmaps
// MediaBox comes from the untrusted PDF; uncapped, a declared 14,400pt (spec-max) or garbage
// page size times RENDER_SCALE would ask the canvas for a multi-GB native bitmap.
const MAX_DIM_PX = 8192;

export async function rasterizePdf(buffer, maxPages) {
  const doc = await getDocument(pdfOpenParams(buffer)).promise;
  const images = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(RENDER_SCALE, MAX_DIM_PX / base.width, MAX_DIM_PX / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      images.push(canvas.toBuffer('image/png'));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return images;
}
