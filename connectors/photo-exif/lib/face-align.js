// Pure, IO-free math for ONNX face detection/alignment (SCRFD decode + Umeyama similarity +
// bilinear warp). No ML runtime, no disk, no network — unit-testable without any model file.
// Mirrors the public InsightFace reference algorithms (scrfd.py / face_align.py) closely enough
// that model outputs decode the same way; only the language changed.

// Standard 112x112 ArcFace 5-point reference template (insightface `arcface_dst`), in
// (leye, reye, nose, lmouth, rmouth) order — the same order SCRFD's keypoint head emits.
export const DST_112 = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

// --- SCRFD box/keypoint decode -----------------------------------------------------------------

// anchor center point + 4 edge distances (l,t,r,b) -> [x1,y1,x2,y2], both in feature-map pixels.
export function distance2bbox(point, distance) {
  const [px, py] = point;
  return [px - distance[0], py - distance[1], px + distance[2], py + distance[3]];
}

// anchor center point + 10 keypoint offsets (dx0,dy0,...,dx4,dy4) -> 5 [x,y] keypoints.
export function distance2kps(point, distance) {
  const [px, py] = point;
  const kps = [];
  for (let i = 0; i < distance.length; i += 2) {
    kps.push([px + distance[i], py + distance[i + 1]]);
  }
  return kps;
}

// SCRFD anchor centers for one FPN stride level: a (width/stride * height/stride) grid, x fastest,
// each cell repeated `numAnchors` times consecutively (buffalo_l det_10g uses 2 anchors/cell) —
// matches scrfd.py's center_cache layout so the flat model output indexes align.
export function generateAnchorCenters(height, width, stride, numAnchors = 2) {
  const gh = Math.floor(height / stride);
  const gw = Math.floor(width / stride);
  const centers = [];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      for (let a = 0; a < numAnchors; a++) centers.push([x * stride, y * stride]);
    }
  }
  return centers;
}

// Greedy NMS over {box:[x1,y1,x2,y2], score} candidates (already-decoded, original-image px).
// Pixel-inclusive area (+1), matching the reference SCRFD implementation's convention.
export function nms(boxes, iouThreshold) {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].score - boxes[a].score);
  const area = (b) => Math.max(0, b.box[2] - b.box[0] + 1) * Math.max(0, b.box[3] - b.box[1] + 1);
  const areas = boxes.map(area);
  const keep = [];
  const suppressed = new Set();
  for (const i of order) {
    if (suppressed.has(i)) continue;
    keep.push(i);
    for (const j of order) {
      if (j === i || suppressed.has(j)) continue;
      const [ax1, ay1, ax2, ay2] = boxes[i].box;
      const [bx1, by1, bx2, by2] = boxes[j].box;
      const xx1 = Math.max(ax1, bx1);
      const yy1 = Math.max(ay1, by1);
      const xx2 = Math.min(ax2, bx2);
      const yy2 = Math.min(ay2, by2);
      const w = Math.max(0, xx2 - xx1 + 1);
      const h = Math.max(0, yy2 - yy1 + 1);
      const inter = w * h;
      const iou = inter / (areas[i] + areas[j] - inter);
      if (iou > iouThreshold) suppressed.add(j);
    }
  }
  return keep;
}

// --- 2x2 SVD (inline, no BLAS/dep) --------------------------------------------------------------

// Eigen-decomposition of a symmetric 2x2 matrix [[m11,m12],[m12,m22]]: closed-form via the
// quadratic formula, robust to the axis-aligned case (m12===0) by picking whichever of the two
// candidate eigenvector formulas has the larger norm.
function eigSym2x2(m11, m12, m22) {
  const tr = m11 + m22;
  const det = m11 * m22 - m12 * m12;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  const pick = (l) => {
    const a = [m12, l - m11];
    const b = [l - m22, m12];
    const na = Math.hypot(a[0], a[1]);
    const nb = Math.hypot(b[0], b[1]);
    if (na < 1e-12 && nb < 1e-12) return [1, 0]; // fully degenerate (scalar) matrix
    const v = na >= nb ? a : b;
    const n = Math.hypot(v[0], v[1]);
    return [v[0] / n, v[1] / n];
  };
  const v1 = pick(l1);
  const v2 = [-v1[1], v1[0]]; // orthogonal complement
  return { values: [l1, l2], vectors: [v1, v2] };
}

// SVD of a general 2x2 matrix A (row-major [[a,b],[c,d]]) via eigendecomposition of A^T A.
// Returns { u: [[..],[..]], s: [s1,s2], v: [[..],[..]] } (columns of u/v) such that A = U*diag(S)*V^T.
function svd2x2([[a, b], [c, d]]) {
  const m11 = a * a + c * c;
  const m12 = a * b + c * d;
  const m22 = b * b + d * d;
  const { values, vectors } = eigSym2x2(m11, m12, m22);
  const s = values.map((l) => Math.sqrt(Math.max(0, l)));
  const uCols = vectors.map((v, i) => {
    const av = [a * v[0] + b * v[1], c * v[0] + d * v[1]];
    if (s[i] > 1e-12) return [av[0] / s[i], av[1] / s[i]];
    return i === 0 ? [1, 0] : null; // filled below once u0 is known
  });
  if (uCols[1] === null) uCols[1] = [-uCols[0][1], uCols[0][0]];
  // v/u as column-major 2x2 matrices [[v0x,v1x],[v0y,v1y]]
  const V = [[vectors[0][0], vectors[1][0]], [vectors[0][1], vectors[1][1]]];
  const U = [[uCols[0][0], uCols[1][0]], [uCols[0][1], uCols[1][1]]];
  return { u: U, s, v: V };
}

const det2x2 = ([[a, b], [c, d]]) => a * d - b * c;

// --- Umeyama similarity transform ---------------------------------------------------------------

// Least-squares similarity transform (scale + rotation + translation, no reflection) mapping
// `src` points onto `dst` points (both arrays of [x,y], same length, dim=2). Returns a 2x3 affine
// matrix [[a,b,tx],[c,d,ty]] such that dst ≈ M @ [srcX, srcY, 1]. Reference: Umeyama (1991), the
// same algorithm scikit-image's SimilarityTransform / insightface's face_align.py use.
export function umeyama(src, dst) {
  const n = src.length;
  const mean = (pts) => [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  const srcMean = mean(src);
  const dstMean = mean(dst);
  const srcDemean = src.map((p) => [p[0] - srcMean[0], p[1] - srcMean[1]]);
  const dstDemean = dst.map((p) => [p[0] - dstMean[0], p[1] - dstMean[1]]);

  let varSrc = 0;
  for (const [x, y] of srcDemean) varSrc += x * x + y * y;
  varSrc /= n;

  let a00 = 0, a01 = 0, a10 = 0, a11 = 0;
  for (let i = 0; i < n; i++) {
    const [sx, sy] = srcDemean[i];
    const [dx, dy] = dstDemean[i];
    a00 += dx * sx; a01 += dx * sy;
    a10 += dy * sx; a11 += dy * sy;
  }
  const A = [[a00 / n, a01 / n], [a10 / n, a11 / n]];

  const { u, s, v } = svd2x2(A);
  const d = [1, 1];
  if (det2x2(A) < 0) d[1] = -1;
  // R = U @ diag(d) @ V^T
  const Vt = [[v[0][0], v[1][0]], [v[0][1], v[1][1]]];
  const UD = [[u[0][0] * d[0], u[0][1] * d[1]], [u[1][0] * d[0], u[1][1] * d[1]]];
  const R = [
    [UD[0][0] * Vt[0][0] + UD[0][1] * Vt[1][0], UD[0][0] * Vt[0][1] + UD[0][1] * Vt[1][1]],
    [UD[1][0] * Vt[0][0] + UD[1][1] * Vt[1][0], UD[1][0] * Vt[0][1] + UD[1][1] * Vt[1][1]],
  ];

  const scale = varSrc > 1e-12 ? (s[0] * d[0] + s[1] * d[1]) / varSrc : 1;
  const Rs = [[R[0][0] * scale, R[0][1] * scale], [R[1][0] * scale, R[1][1] * scale]];
  const tx = dstMean[0] - (Rs[0][0] * srcMean[0] + Rs[0][1] * srcMean[1]);
  const ty = dstMean[1] - (Rs[1][0] * srcMean[0] + Rs[1][1] * srcMean[1]);
  return [[Rs[0][0], Rs[0][1], tx], [Rs[1][0], Rs[1][1], ty]];
}

// Invert a 2x3 affine matrix [[a,b,c],[d,e,f]] (maps [x,y,1] -> [x',y']) so it maps back.
export function invertAffine([[a, b, c], [d, e, f]]) {
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) throw new Error('face-align: affine matrix is not invertible');
  return [
    [e / det, -b / det, (b * f - e * c) / det],
    [-d / det, a / det, (d * c - a * f) / det],
  ];
}

export function applyAffine([[a, b, c], [d, e, f]], x, y) {
  return [a * x + b * y + c, d * x + e * y + f];
}

// Warp the aligned 112x112 ArcFace input crop out of a decoded RGB image (Uint8Array/Array, HWC,
// 3 channels) via the inverse of the src->DST_112 similarity transform, bilinear-sampled, and
// return it pre-normalized to NCHW float32 [1,3,112,112] with (px-127.5)/127.5.
export function warpTo112(rgb, width, height, landmarks) {
  const M = umeyama(landmarks, DST_112);
  const Minv = invertAffine(M);
  const SIZE = 112;
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  const sample = (x, y, ch) => {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0, fy = y - y0;
    const at = (xx, yy) => rgb[(yy * width + xx) * 3 + ch];
    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bot = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    return top * (1 - fy) + bot * fy;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [sx, sy] = applyAffine(Minv, x + 0.5, y + 0.5);
      const idx = y * SIZE + x;
      for (let ch = 0; ch < 3; ch++) {
        out[ch * plane + idx] = (sample(sx, sy, ch) - 127.5) / 127.5;
      }
    }
  }
  return out;
}
