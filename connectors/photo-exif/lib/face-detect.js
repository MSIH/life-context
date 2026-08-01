// Local, offline face detection. The heavy ML stack (onnxruntime-node + sharp) is loaded via
// DYNAMIC import only when a real detection actually runs, so importing this module (or the face
// worker) costs nothing and needs neither package present unless you actually scan — and the test
// suite injects a fixture detector instead (below), never touching ML. Models load once from
// FACE_MODELS_PATH (one-time download; fully offline after).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { distance2bbox, distance2kps, generateAnchorCenters, nms, warpTo112 } from './face-align.js';
import { openImage } from './decode-image.js';

// Test seam: PHOTO_EXIF_FACE_FIXTURE points at a JSON file mapping relPath -> an array of faces,
// each face either a bare descriptor array or { box, descriptor }. When set, detection returns
// those instead of loading any ML model — this is how test.mjs exercises the full scan/label/
// ingest pipeline deterministically with no models and no native dependencies. A relPath mapped
// to `{ error: "<message>" }` instead of an array simulates a real decode/detect failure (#289)
// — there's no portable way to make a real corrupt image without shipping one, or the real
// detector without real models, so this is the only fixture-driven way to exercise that path.
export function fixtureDetector(fixturePath) {
  const map = JSON.parse(readFileSync(fixturePath, 'utf8'));
  return async function detectFaces(_absPath, relPath) {
    const entry = map[relPath];
    if (entry && !Array.isArray(entry)) {
      if (entry.error) throw new Error(entry.error);
      throw new Error(`photo-exif: malformed fixture entry for ${relPath} — expected an array of faces or { error }`);
    }
    const faces = entry ?? [];
    return faces.map((f) => (Array.isArray(f)
      ? { box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: f }
      : { box: f.box ?? { x: 0, y: 0, width: 1, height: 1 }, descriptor: f.descriptor }));
  };
}

// SCRFD (buffalo_l det_10g) detection constants — the model's fixed export shape, not tunable.
const DET_INPUT_SIZE = 640;
const DET_SCORE_THRESHOLD = 0.5;
const DET_NMS_IOU = 0.4;
const DET_STRIDES = [8, 16, 32];
const DET_NUM_ANCHORS = 2;
const DET_OUTPUT_COUNT = DET_STRIDES.length * 3; // scores + bboxes + kps per stride

// Full-res 3-channel sRGB raw pixels (HWC, uint8), EXIF-oriented — the source `warpTo112` aligns
// crops out of.
async function decodeRgb(pipeline) {
  const { data, info } = await pipeline.clone().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Letterbox: isotropic resize to fit DET_INPUT_SIZE, zero-padded at the bottom/right (top-left
// aligned, so mapping detections back to original px is a pure division by `scale`, no offset).
// The pad value is normalized like every other pixel (cv2.dnn.blobFromImage's convention: the
// whole canvas — including padding — runs through (px-127.5)/128), not left as a raw 0.
async function letterbox(pipeline, width, height) {
  const scale = Math.min(DET_INPUT_SIZE / width, DET_INPUT_SIZE / height);
  const rw = Math.max(1, Math.round(width * scale));
  const rh = Math.max(1, Math.round(height * scale));
  const { data } = await pipeline.clone().resize(rw, rh, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const blob = new Float32Array(3 * DET_INPUT_SIZE * DET_INPUT_SIZE);
  blob.fill((0 - 127.5) / 128); // pad value in normalized space, not raw 0
  const plane = DET_INPUT_SIZE * DET_INPUT_SIZE;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const srcIdx = (y * rw + x) * 3;
      const dstIdx = y * DET_INPUT_SIZE + x;
      for (let ch = 0; ch < 3; ch++) {
        blob[ch * plane + dstIdx] = (data[srcIdx + ch] - 127.5) / 128;
      }
    }
  }
  return { blob, scale };
}

// Run SCRFD on the letterboxed blob, decode all 3 stride heads, NMS, then scale boxes/kps back to
// original-image px (a pure division — the letterbox padding never offsets the top-left corner).
async function detectAndDecode(ort, detSession, blob, scale) {
  const inputName = detSession.inputNames[0];
  const feeds = { [inputName]: new ort.Tensor('float32', blob, [1, 3, DET_INPUT_SIZE, DET_INPUT_SIZE]) };
  const results = await detSession.run(feeds);
  const outputs = detSession.outputNames.map((name) => results[name].data);

  const candidates = [];
  DET_STRIDES.forEach((stride, idx) => {
    const scores = outputs[idx];
    const bboxPreds = outputs[idx + DET_STRIDES.length];
    const kpsPreds = outputs[idx + DET_STRIDES.length * 2];
    const anchors = generateAnchorCenters(DET_INPUT_SIZE, DET_INPUT_SIZE, stride, DET_NUM_ANCHORS);
    for (let i = 0; i < anchors.length; i++) {
      const score = scores[i];
      if (score < DET_SCORE_THRESHOLD) continue;
      const bd = [bboxPreds[i * 4] * stride, bboxPreds[i * 4 + 1] * stride, bboxPreds[i * 4 + 2] * stride, bboxPreds[i * 4 + 3] * stride];
      const kd = [];
      for (let k = 0; k < 10; k++) kd.push(kpsPreds[i * 10 + k] * stride);
      candidates.push({ box: distance2bbox(anchors[i], bd), kps: distance2kps(anchors[i], kd), score });
    }
  });

  const keep = nms(candidates, DET_NMS_IOU);
  return keep.map((i) => {
    const c = candidates[i];
    return {
      box: c.box.map((v) => v / scale),
      kps: c.kps.map(([x, y]) => [x / scale, y / scale]),
    };
  });
}

export function l2Normalize(vec) {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm < 1e-12) return null;
  return Array.from(vec, (v) => v / norm);
}

// Real detector: lazy-load onnxruntime-node + sharp, load the SCRFD (detection) + ArcFace
// (recognition) ONNX sessions once, return detectFaces(absPath). Unverified in this repo's CI (no
// models here) — same posture as the VLM caption path; behavior is covered by the fixture
// detector, model quality/latency is a manual, on-device concern.
export async function loadModelDetector(modelsPath) {
  if (!modelsPath) throw new Error('FACE_MODELS_PATH not set (required for face detection)');
  const ortMod = await import('onnxruntime-node');
  const ort = ortMod.default ?? ortMod;

  const detModelFile = process.env.FACE_DET_MODEL || 'det_10g.onnx';
  const recModelFile = process.env.FACE_REC_MODEL || 'w600k_r50.onnx';
  const detSession = await ort.InferenceSession.create(path.join(modelsPath, detModelFile), { executionProviders: ['cpu'] });
  const recSession = await ort.InferenceSession.create(path.join(modelsPath, recModelFile), { executionProviders: ['cpu'] });
  if (detSession.outputNames.length !== DET_OUTPUT_COUNT) {
    throw new Error(`face-detect: ${detModelFile} has ${detSession.outputNames.length} outputs, expected ${DET_OUTPUT_COUNT} (3 strides x scores/bboxes/kps)`);
  }

  return async function detectFaces(absPath) {
    const pipeline = (await openImage(absPath)).toColourspace('srgb').removeAlpha();
    const { data: rgb, width, height } = await decodeRgb(pipeline);
    const { blob, scale } = await letterbox(pipeline, width, height);
    const faces = await detectAndDecode(ort, detSession, blob, scale);

    const out = [];
    for (const face of faces) {
      const aligned = warpTo112(rgb, width, height, face.kps);
      const recInputName = recSession.inputNames[0];
      const recResults = await recSession.run({ [recInputName]: new ort.Tensor('float32', aligned, [1, 3, 112, 112]) });
      const embedding = recResults[recSession.outputNames[0]].data;
      const descriptor = l2Normalize(embedding);
      if (!descriptor) continue; // zero-norm/NaN embedding: skip this face, not the image
      const [x1, y1, x2, y2] = face.box;
      out.push({ box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, descriptor });
    }
    return out;
  };
}

// Pick the detector: the fixture seam (tests) when set, otherwise the real model detector.
export async function resolveDetector({ modelsPath, fixturePath }) {
  return fixturePath ? fixtureDetector(fixturePath) : loadModelDetector(modelsPath);
}
