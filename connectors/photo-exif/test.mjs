// Synthesizes JPEGs with injected EXIF (piexifjs — no real photo library needed) and runs
// scan.js / caption-worker.js against them with mock ingest/VLM servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import piexif from 'piexifjs';
import { euclideanDistance, assignCluster, parseClustersFile, serializeClustersFile, planMerges, mergeTwo } from './lib/face-cluster.js';
import { readCaptionCache, writeCaptionCache, currentTextRepr } from './lib/caption-cache.js';
import { umeyama, invertAffine, applyAffine, distance2bbox, distance2kps, generateAnchorCenters, nms, warpTo112, DST_112 } from './lib/face-align.js';
import { l2Normalize } from './lib/face-detect.js';
import { createOpenImage } from './lib/decode-image.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+; this connector declares >=20.9.0 (sharp's floor, #268)

// source_id is now the content hash (keyForMedia): generic photos → source='photo-exif',
// source_id=<sha256>; Google-origin (the scan ROOT is a Takeout export — isTakeoutRoot, #176, NOT
// per-file sidecar) → source='google-photos', source_id='gphotos:<sha256>'. Tests force/expect
// Takeout via a marker (a "Photos from <YYYY>" dir / a "Google Photos" root) or PHOTO_TAKEOUT.
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256(readFileSync(p));

// A minimal valid 1x1 JPEG (no EXIF) — piexifjs inserts EXIF into a real JPEG rather than
// building one from scratch.
const BASE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

function jpegWithExif({ dateTimeOriginal, lat, lon } = {}) {
  const binaryStr = Buffer.from(BASE_JPEG_BASE64, 'base64').toString('binary');
  const exifObj = { '0th': {}, Exif: {}, GPS: {} };
  if (dateTimeOriginal) exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = dateTimeOriginal;
  if (lat != null && lon != null) {
    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    exifObj.GPS[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? 'E' : 'W';
    exifObj.GPS[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lon));
  }
  const exifBytes = piexif.dump(exifObj);
  return Buffer.from(piexif.insert(exifBytes, binaryStr), 'binary');
}

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

// Mock the connector-facing REST surface (#198): /api/v1/exists → { exists } and
// /api/v1/ingest/batch → per-item created results. `exists(sourceIds)` lets a test declare which
// ids core already has (default: none stored → every file is new, i.e. pre-#198 behavior). Pass
// `existsStatus: 404` to simulate an older core with no /exists route (graceful-degrade path).
function ingestMock({ exists = () => [], existsStatus = 200 } = {}) {
  return (req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/exists') {
      if (existsStatus !== 200) { res.statusCode = existsStatus; res.end(JSON.stringify({ error: 'not found' })); return; }
      res.end(JSON.stringify({ exists: exists(body.source_ids) }));
      return;
    }
    res.end(JSON.stringify({
      summary: {},
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  };
}

// The single /api/v1/ingest/batch request (scan.js also calls /api/v1/exists first, #198).
const batchReq = (requests) => requests.find((r) => r.url === '/api/v1/ingest/batch');
const batchReqs = (requests) => requests.filter((r) => r.url === '/api/v1/ingest/batch');

function run(script, env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('scan.js: EXIF + GPS photo, GPS-only photo, no-metadata photo, unchanged-file skip', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-test-'));
  writeFileSync(path.join(tmp, 'with-both.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));
  writeFileSync(path.join(tmp, 'gps-only.jpg'), jpegWithExif({ lat: 51.5074, lon: -0.1278 }));
  writeFileSync(path.join(tmp, 'no-metadata.jpg'), Buffer.from(BASE_JPEG_BASE64, 'base64'));

  const { server, port, requests } = await startMockServer(ingestMock());

  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: manifestPath,
    TZ: 'UTC', // pin so the EXIF-local DateTimeOriginal → UTC assertion is deterministic (matches the sidecar test)
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(batchReqs(requests).length, 1);
  const artifacts = batchReq(requests).body.artifacts;
  assert.equal(artifacts.length, 3);

  const both = artifacts.find((a) => a.raw_path.endsWith('with-both.jpg'));
  assert.equal(both.type, 'photo');
  assert.equal(both.source, 'photo-exif'); // no sidecar -> generic keying
  assert.equal(both.source_id, both.content_hash); // generic source_id IS the bare content hash
  assert.match(both.source_id, /^[0-9a-f]{64}$/);
  assert.equal(both.text_repr, 'Photo taken 2019-03-04');
  assert.equal(both.occurred_at, '2019-03-04T14:30:00.000Z');
  assert.equal(both.latitude, 30.2672);
  assert.equal(both.place_label, undefined); // this connector never resolves place_label; core does (issue #67)
  assert.match(both.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(both.extra.captioned, false);
  assert.equal(both.entity_hints, undefined); // in PHOTO_ROOT (no subfolder) -> no folder hint

  const gpsOnly = artifacts.find((a) => a.raw_path.endsWith('gps-only.jpg'));
  assert.equal(gpsOnly.text_repr, 'Photo: gps-only.jpg'); // no date, and no place phrase (GPS alone no longer produces one)
  assert.equal(gpsOnly.occurred_at, undefined); // no date -> omitted, never guessed from mtime

  const noMeta = artifacts.find((a) => a.raw_path.endsWith('no-metadata.jpg'));
  assert.equal(noMeta.text_repr, 'Photo: no-metadata.jpg');
  assert.equal(noMeta.latitude, undefined);

  // Re-run with the same (populated) manifest: nothing changed on disk, so nothing re-sent.
  requests.length = 0;
  const { server: server2, port: port2, requests: requests2 } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ summary: {}, results: [] }));
  });
  const rerun = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port2}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: manifestPath,
  });
  server2.closeAllConnections();
  server2.close();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(requests2.length, 0, 'unchanged files are skipped on re-scan');
});

test('scan.js: Google Takeout sidecar → pictured hints + takenTime/geo fallback (#152)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-takeout-'));
  const sidecar = (mediaName, body) => writeFileSync(path.join(tmp, `${mediaName}.supplemental-metadata.json`), JSON.stringify(body));
  // Distinct trailing bytes per file so each is a distinct content hash (a valid JPEG with junk
  // after EOI; exifr reads from the start and still sees no EXIF). Identical bytes would collapse
  // under content-hash keying — that's exercised deliberately in the dedup test, not here.
  const noExif = (salt) => Buffer.concat([Buffer.from(BASE_JPEG_BASE64, 'base64'), Buffer.from(`\n${salt}`, 'utf8')]);
  const TAKEN = 1764458538; // unix seconds — UTC, zone-unambiguous
  const takenISO = new Date(TAKEN * 1000).toISOString();

  // (a) no EXIF + full sidecar: people → hints, takenTime → occurred_at, real geo → coords
  writeFileSync(path.join(tmp, 'sidecar-full.jpg'), noExif('sidecar-full'));
  sidecar('sidecar-full.jpg', { people: [{ name: 'April Marsh Sorrel' }, { name: 'Matt Sorrel' }, { name: 'Amy Fenwick' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 39.0, longitude: -76.0 } });

  // (b) EXIF present: EXIF date/gps WIN over the sidecar, but people still become hints
  writeFileSync(path.join(tmp, 'exif-wins.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));
  sidecar('exif-wins.jpg', { people: [{ name: 'Amy Fenwick' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 10, longitude: 20 } });

  // (c) geoData {0,0} is Google's "no location" sentinel → no coords (but date + hints still set)
  writeFileSync(path.join(tmp, 'zero-geo.jpg'), noExif('zero-geo'));
  sidecar('zero-geo.jpg', { people: [{ name: 'Amy Fenwick' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 0, longitude: 0 } });

  // (d) duplicate-media naming: sidecar is "<stem><ext>.supplemental-metadata(N).json"
  writeFileSync(path.join(tmp, 'dup(1).jpg'), noExif('dup'));
  writeFileSync(path.join(tmp, 'dup.jpg.supplemental-metadata(1).json'), JSON.stringify({ people: [{ name: '  Matt Sorrel  ' }], photoTakenTime: { timestamp: String(TAKEN) } })); // padded name → asserted trimmed below

  // (e) no sidecar and (f) malformed sidecar → EXIF-only, must not throw/abort the scan
  writeFileSync(path.join(tmp, 'no-sidecar.jpg'), noExif('no-sidecar'));
  writeFileSync(path.join(tmp, 'bad-sidecar.jpg'), noExif('bad-sidecar'));
  writeFileSync(path.join(tmp, 'bad-sidecar.jpg.supplemental-metadata.json'), '{ not valid json');

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'), TZ: 'UTC',
    PHOTO_TAKEOUT: 'true', // this temp root has no marker → force Takeout so keying is google-photos
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  const by = (name) => arts.find((a) => a.raw_path.endsWith(name));

  const full = by('sidecar-full.jpg');
  assert.equal(full.source, 'google-photos', 'a file in a Takeout tree is Google-origin');
  assert.match(full.source_id, /^gphotos:[0-9a-f]{64}$/, 'Google-origin source_id is gphotos:<hash>');
  assert.equal(full.source_id, `gphotos:${full.content_hash}`);
  assert.deepEqual(full.entity_hints, [
    { alias: 'April Marsh Sorrel', alias_type: 'name', role: 'pictured', confidence: 0.9 },
    { alias: 'Matt Sorrel', alias_type: 'name', role: 'pictured', confidence: 0.9 },
    { alias: 'Amy Fenwick', alias_type: 'name', role: 'pictured', confidence: 0.9 },
  ]);
  assert.equal(full.occurred_at, takenISO, 'sidecar photoTakenTime fills occurred_at when EXIF has none');
  assert.equal(full.latitude, 39.0);
  assert.equal(full.longitude, -76.0);

  const exif = by('exif-wins.jpg');
  assert.equal(exif.source, 'google-photos'); // sidecar present -> Google-origin even though EXIF wins for date/gps
  assert.equal(exif.occurred_at, '2019-03-04T14:30:00.000Z', 'EXIF date wins over the sidecar');
  assert.equal(exif.latitude, 30.2672, 'EXIF GPS wins over the sidecar');
  assert.deepEqual(exif.entity_hints, [{ alias: 'Amy Fenwick', alias_type: 'name', role: 'pictured', confidence: 0.9 }]);

  const zero = by('zero-geo.jpg');
  assert.equal(zero.occurred_at, takenISO);
  assert.equal(zero.latitude, undefined, 'geoData {0,0} is not submitted as a coordinate');
  assert.equal(zero.longitude, undefined);

  assert.deepEqual(by('dup(1).jpg').entity_hints, [{ alias: 'Matt Sorrel', alias_type: 'name', role: 'pictured', confidence: 0.9 }], 'duplicate-named sidecar is resolved');

  assert.equal(by('no-sidecar.jpg').entity_hints, undefined, 'no sidecar → no hints');
  assert.equal(by('no-sidecar.jpg').occurred_at, undefined);
  // #176: in a Takeout tree, a sidecar-less file is STILL google-photos (tree-level, not per-file).
  assert.equal(by('no-sidecar.jpg').source, 'google-photos', 'no sidecar but Takeout tree → google-photos');
  assert.match(by('no-sidecar.jpg').source_id, /^gphotos:[0-9a-f]{64}$/);
  assert.equal(by('bad-sidecar.jpg').entity_hints, undefined, 'malformed sidecar → EXIF-only, no crash');
  assert.equal(by('bad-sidecar.jpg').source, 'google-photos');
});

test('scan.js: same filename, different content in different subdirectories gets distinct source_ids', async () => {
  // source_id is the content hash now: two photos with the same filename but DIFFERENT bytes
  // (different EXIF here) must key distinctly and stay two artifacts. (The inverse — identical
  // bytes collapsing to one — is the dedup test below.)
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-nested-test-'));
  mkdirSync(path.join(tmp, '2019', 'trip'), { recursive: true });
  mkdirSync(path.join(tmp, '2020', 'trip'), { recursive: true });
  writeFileSync(path.join(tmp, '2019', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, '2020', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));

  const { server, port, requests } = await startMockServer(ingestMock());

  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const artifacts = batchReq(requests).body.artifacts;
  assert.equal(artifacts.length, 2, 'two distinct photos, not one collapsed into the other');
  const ids = artifacts.map((a) => a.source_id);
  assert.notEqual(ids[0], ids[1], 'different bytes -> different content-hash source_ids');
  for (const a of artifacts) {
    assert.equal(a.source, 'photo-exif'); // no sidecar -> generic
    assert.match(a.source_id, /^[0-9a-f]{64}$/);
    assert.equal(a.source_id, a.content_hash);
  }
});

test('scan.js: a video ingests as type=video, a still as type=photo', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-video-'));
  writeFileSync(path.join(tmp, 'clip.mp4'), Buffer.from('fake-mp4-bytes'));
  writeFileSync(path.join(tmp, 'oldclip.3gpp'), Buffer.from('fake-3gpp-bytes'));
  writeFileSync(path.join(tmp, 'still.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  assert.equal(arts.length, 3, 'both videos and the still are walked (walkMediaFiles)');
  const video = arts.find((a) => a.raw_path.endsWith('clip.mp4'));
  assert.equal(video.type, 'video');
  assert.match(video.text_repr, /^Video[: ]/, "a video's text_repr says Video, not Photo");
  const gpp = arts.find((a) => a.raw_path.endsWith('oldclip.3gpp'));
  assert.ok(gpp, '.3gpp file was walked and ingested (not skipped)');
  assert.equal(gpp.type, 'video', '.3gpp is recognized as a video, not skipped');
  assert.equal(arts.find((a) => a.raw_path.endsWith('still.jpg')).type, 'photo');
});

test('scan.js: byte-identical copies in different folders collapse to one payload with unioned pictured hints', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-dedup-'));
  // The SAME photo (identical bytes) sits in two person-named album folders, each with its own
  // sidecar naming a different person — Takeout's per-album duplication. Both have a sidecar →
  // Google-origin → the same content-hash source_id → they must collapse into ONE artifact.
  const bytes = Buffer.from('one-identical-photo');
  mkdirSync(path.join(tmp, 'Alice Album'));
  mkdirSync(path.join(tmp, 'Bob Album'));
  writeFileSync(path.join(tmp, 'Alice Album', 'photo.jpg'), bytes);
  writeFileSync(path.join(tmp, 'Alice Album', 'photo.jpg.supplemental-metadata.json'), JSON.stringify({ people: [{ name: 'Alice' }] }));
  writeFileSync(path.join(tmp, 'Bob Album', 'photo.jpg'), bytes);
  writeFileSync(path.join(tmp, 'Bob Album', 'photo.jpg.supplemental-metadata.json'), JSON.stringify({ people: [{ name: 'Bob' }] }));

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    PHOTO_TAKEOUT: 'true', // album folders, no root marker → force Takeout for google-photos keying
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  assert.equal(arts.length, 1, 'two byte-identical copies collapse to one payload');
  const [art] = arts;
  assert.equal(art.source, 'google-photos');
  assert.equal(art.source_id, `gphotos:${art.content_hash}`);
  // Union of both sidecars' people AND both folder-name hints, deduped by alias|role.
  const aliases = art.entity_hints.map((h) => h.alias).sort();
  assert.deepEqual(aliases, ['Alice', 'Alice Album', 'Bob', 'Bob Album']);
  for (const h of art.entity_hints) {
    assert.equal(h.alias_type, 'name');
    assert.equal(h.role, 'pictured');
    assert.equal(h.confidence, 0.9);
  }
});

test('scan.js: folder-name pictured hint — subfolder yes, root none, year bucket none', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-folderhint-'));
  writeFileSync(path.join(tmp, 'root.jpg'), Buffer.from('img-root')); // directly in PHOTO_ROOT
  mkdirSync(path.join(tmp, 'Aunt Mary'));
  writeFileSync(path.join(tmp, 'Aunt Mary', 'm.jpg'), Buffer.from('img-aunt'));
  mkdirSync(path.join(tmp, 'Photos from 2019'));
  writeFileSync(path.join(tmp, 'Photos from 2019', 'y.jpg'), Buffer.from('img-year'));

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  const by = (name) => arts.find((a) => a.raw_path.endsWith(name));
  assert.equal(by('root.jpg').entity_hints, undefined, 'a file directly in PHOTO_ROOT emits no folder hint');
  assert.deepEqual(by('m.jpg').entity_hints, [{ alias: 'Aunt Mary', alias_type: 'name', role: 'pictured', confidence: 0.9 }], 'a person-named subfolder becomes a pictured hint');
  assert.equal(by('y.jpg').entity_hints, undefined, 'a Takeout year bucket is never a person');
});

test('scan.js: Takeout detected at tree level — a sidecar-less .mp4 keys google-photos (#176)', async () => {
  // The repro: a motion-photo/Live-Photo .MP4 has no sidecar of its own, but it IS a Takeout export
  // item. Per-file sidecar detection mis-keyed it generic and duplicated the google-photos row.
  // Detection is now tree-level: PHOTO_ROOT named "Google Photos" is auto-recognized (no override).
  const base = mkdtempSync(path.join(tmpdir(), 'photo-exif-takeoutroot-'));
  const tmp = path.join(base, 'Google Photos');
  mkdirSync(tmp);
  writeFileSync(path.join(tmp, 'IMG_7078.MP4'), Buffer.from('sidecar-less-motion-video-bytes')); // no sidecar

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(base, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const [art] = batchReq(requests).body.artifacts;
  assert.equal(art.type, 'video');
  assert.equal(art.source, 'google-photos', 'sidecar-less Takeout media keys google-photos, not generic');
  assert.equal(art.source_id, `gphotos:${art.content_hash}`);
});

test('scan.js: album-layout Takeout (child dirs with metadata.json, no year bucket) keys google-photos (#177)', async () => {
  // Copilot #177: the common layout where PHOTO_ROOT holds one folder per album, each with its own
  // metadata.json, and the root is NOT named "Google Photos" and has no "Photos from <YYYY>" bucket.
  // A sidecar-less .mp4 in such a tree must still key google-photos (auto-detected, no override).
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-albumlayout-'));
  mkdirSync(path.join(tmp, 'Adam Fenwick'));
  writeFileSync(path.join(tmp, 'Adam Fenwick', 'metadata.json'), JSON.stringify({ title: 'Adam Fenwick' }));
  writeFileSync(path.join(tmp, 'Adam Fenwick', 'IMG_9001.MP4'), Buffer.from('album-layout-sidecar-less-video')); // no sidecar

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const mp4 = batchReq(requests).body.artifacts.find((a) => a.raw_path.endsWith('IMG_9001.MP4'));
  assert.equal(mp4.source, 'google-photos', 'album-layout Takeout detected via child metadata.json');
  assert.equal(mp4.source_id, `gphotos:${mp4.content_hash}`);
});

test('scan.js: PHOTO_TAKEOUT overrides detection both ways (#176)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-override-'));
  writeFileSync(path.join(tmp, 'x.jpg'), Buffer.from('override-bytes')); // no sidecar, no marker
  const runOnce = async (override) => {
    const { server, port, requests } = await startMockServer(ingestMock());
    const result = await run('scan.js', {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
      PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, `manifest-${override}.json`),
      PHOTO_TAKEOUT: override,
    });
    server.closeAllConnections();
    server.close();
    assert.equal(result.status, 0, result.stderr);
    return batchReq(requests).body.artifacts[0];
  };
  assert.equal((await runOnce('true')).source, 'google-photos', 'PHOTO_TAKEOUT=true forces google-photos');
  assert.equal((await runOnce('false')).source, 'photo-exif', 'PHOTO_TAKEOUT=false forces generic');
});

test('scan.js: /exists skips already-stored files (no ingest) and a 404 falls back to full processing (#198)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-exists-'));
  // Two distinct files → two distinct content hashes → two distinct source_ids. No sidecar/marker,
  // so generic keying: source='photo-exif', source_id === the bare content hash.
  writeFileSync(path.join(tmp, 'stored.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, 'new.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));
  const storedHash = sha256File(path.join(tmp, 'stored.jpg'));
  const newHash = sha256File(path.join(tmp, 'new.jpg'));

  // (1) /exists reports stored.jpg already present → only new.jpg is enriched + ingested.
  const manifestPath = path.join(tmp, 'manifest.json');
  const { server, port, requests } = await startMockServer(ingestMock({ exists: (ids) => ids.filter((id) => id === storedHash) }));
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: manifestPath, TZ: 'UTC',
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const existsReq = requests.find((r) => r.url === '/api/v1/exists');
  assert.ok(existsReq, 'scan.js calls /api/v1/exists');
  assert.deepEqual([...existsReq.body.source_ids].sort(), [newHash, storedHash].sort(), 'both hashed source_ids are checked');
  const batch = batchReq(requests);
  assert.equal(batch.body.artifacts.length, 1, 'only the not-already-stored file is ingested');
  assert.equal(batch.body.artifacts[0].source_id, newHash);
  assert.match(result.stderr, /skip-check — 2 hashed, 1 already stored, 1 new/);

  // The already-stored file is still recorded in the manifest, so subsequent LOCAL runs skip it via
  // a cheap stat with no hash and no server round-trip.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(Object.keys(manifest).length, 2, 'both files (stored + ingested) are manifest-recorded');

  // (2) 404 fallback: an older core with no /exists route → process everything, no crash. A fresh
  // manifest path forces both files to miss the local skip cache and be re-hashed + checked.
  const { server: s2, port: p2, requests: r2 } = await startMockServer(ingestMock({ existsStatus: 404 }));
  const result2 = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${p2}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest-404.json'), TZ: 'UTC',
  });
  s2.closeAllConnections();
  s2.close();
  assert.equal(result2.status, 0, result2.stderr);
  assert.match(result2.stderr, /\/api\/v1\/exists unavailable \(404\)/);
  assert.equal(batchReq(r2).body.artifacts.length, 2, '404 → all files processed (graceful fallback)');
});

test('caption-worker.js: enriches text_repr in place, preserves EXIF fields via upsert semantics, kill-safe state', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-caption-test-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 0 }));
  });

  const vlmRequests = [];
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmRequests.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: 'two people cooking pasta in a kitchen' }));
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const statePath = path.join(tmp, 'captions.json');
  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });

  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vlmRequests.length, 1);
  assert.ok(vlmRequests[0].images[0].length > 0, 'sent base64 image data');
  assert.equal(ingestRequests.length, 1);
  const payload = ingestRequests[0];
  // Same content-hash key scan.js would compute (no sidecar → generic), so the caption enriches
  // the SAME artifact rather than creating a new one.
  assert.equal(payload.source, 'photo-exif');
  assert.equal(payload.source_id, sha256File(path.join(tmp, 'photo.jpg')));
  assert.equal(payload.text_repr, 'Photo taken 2019-03-04 two people cooking pasta in a kitchen');
  assert.equal(payload.extra.captioned, true);
  // Upsert-only-what-changed: no occurred_at/latitude/place_label/raw_path/content_hash resent —
  // those were already stored by scan.js and must be left untouched (doc 04 §3 merge semantics).
  assert.equal(payload.occurred_at, undefined);
  assert.equal(payload.latitude, undefined);
  assert.equal(payload.place_label, undefined);

  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { 'photo.jpg': 'two people cooking pasta in a kitchen' });

  // Re-run: already captioned, VLM should not be called again.
  const rerun = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(vlmRequests.length, 1, 'already-captioned photo is not re-sent to the VLM');
});

test('caption-worker.js: legacy array-format state entries are re-captioned to populate the text map', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-legacy-caption-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  const statePath = path.join(tmp, 'captions.json');
  writeFileSync(statePath, JSON.stringify(['photo.jpg'])); // legacy array -> loaded as { 'photo.jpg': null }

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const vlmRequests = [];
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmRequests.push(JSON.parse(body));
      res.end(JSON.stringify({ response: 'a dog on a beach' }));
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vlmRequests.length, 1, 'a legacy (text-less) entry is re-captioned, not skipped');
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { 'photo.jpg': 'a dog on a beach' }, 'map now holds the caption text');
});

test('caption-worker.js: VLM unreachable stops the run without marking anything captioned', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-caption-down-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  const statePath = path.join(tmp, 'captions.json');

  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: 'http://127.0.0.1:19999',
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: 'http://127.0.0.1:19998', // nothing listening
    VLM_THROTTLE_MS: '0',
  });

  assert.equal(result.status, 0, result.stderr); // stops cleanly, not a crash
  assert.throws(() => readFileSync(statePath, 'utf8')); // nothing was captioned
});

// --- #276: caption pass must not clobber face enrichment ---------------------------------------

// Minimal VLM stand-in for the #276 tests — always answers with the same caption.
async function startVlmStub(responseText) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: responseText }));
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { server, port };
}

test('caption-worker.js (#276): carries face enrichment through instead of wiping it', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-276-preserve-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));

  // Face pass already ran over this photo and cluster 1 was named.
  const faceState = path.join(tmp, 'faces.json');
  writeFileSync(faceState, JSON.stringify({ 'photo.jpg': { faces: 2, clusters: [1, 2], dateStr: '2019-03-04' } }));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 3, label: 'Sarah Jones', sample: 'photo.jpg' },
    { id: 2, centroid: [9, 9, 9], count: 1, label: null, sample: 'photo.jpg' }, // unlabeled -> contributes no name
  ]));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const { server: vlmServer, port: vlmPort } = await startVlmStub('two people cooking pasta in a kitchen');

  const res = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: path.join(tmp, 'captions.json'),
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
    FACE_HINT_CONFIDENCE: '0.6',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(res.status, 0, res.stderr);
  assert.equal(ingestRequests.length, 1);
  const p = ingestRequests[0];
  // The caption landed AND the face pass's work survived — this is the whole point of #276.
  assert.equal(p.text_repr, 'Photo taken 2019-03-04 two people cooking pasta in a kitchen Pictured: Sarah Jones.');
  assert.equal(p.extra.captioned, true);
  assert.equal(p.extra.faces_detected, 2, 'face count carried through, not wiped');
  assert.deepEqual(p.extra.pictured, ['Sarah Jones'], 'only the NAMED cluster contributes a name');
  assert.deepEqual(p.entity_hints, [{ alias: 'Sarah Jones', alias_type: 'name', role: 'pictured', confidence: 0.6 }]);
  // Still upsert-only-what-changed: scan.js's originals are not resent.
  assert.equal(p.occurred_at, undefined);
  assert.equal(p.latitude, undefined);
});

test('caption-worker.js (#276): with no face state, omits faces_detected entirely — never sends 0', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-276-noface-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const { server: vlmServer, port: vlmPort } = await startVlmStub('a dog on a beach');

  const res = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: path.join(tmp, 'captions.json'),
    PHOTO_EXIF_FACE_STATE_PATH: path.join(tmp, 'does-not-exist-faces.json'),
    PHOTO_EXIF_FACE_CLUSTERS_PATH: path.join(tmp, 'does-not-exist-clusters.json'),
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(res.status, 0, res.stderr);
  const p = ingestRequests[0];
  assert.equal(p.text_repr, 'Photo taken 2019-03-04 a dog on a beach'); // no "Pictured:" sentence
  assert.equal(p.extra.captioned, true);
  // `0` would assert "we ran detection and found no faces" — a claim this worker cannot make.
  assert.ok(!('faces_detected' in p.extra), 'faces_detected absent, not 0');
  assert.ok(!('pictured' in p.extra), 'pictured absent, not []');
  assert.equal(p.entity_hints, undefined);
});

test('caption-worker.js (#276): an unreadable clusters file degrades to no face data, never a crash or a false empty', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-276-badclusters-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  const faceState = path.join(tmp, 'faces.json');
  writeFileSync(faceState, JSON.stringify({ 'photo.jpg': { faces: 2, clusters: [1] } }));
  // A directory where the clusters file should be: exists, but readFileSync throws (EISDIR).
  // Portable stand-in for the real hazards — mid-write on Windows, bad permissions.
  const clustersState = path.join(tmp, 'clusters.json');
  mkdirSync(clustersState);

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const { server: vlmServer, port: vlmPort } = await startVlmStub('a dog on a beach');

  const res = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: path.join(tmp, 'captions.json'),
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(res.status, 0, res.stderr); // degrades, does not crash the run
  assert.match(res.stderr, /unreadable cluster state/, 'the anomaly is logged loudly, not swallowed');
  const p = ingestRequests[0];
  assert.equal(p.extra.captioned, true); // the caption still lands
  // Names are unknowable here, so claim nothing rather than assert "nobody is pictured" — the
  // wholesale `extra` replace would make that false claim permanent.
  assert.ok(!('pictured' in p.extra), 'pictured omitted, not []');
  assert.ok(!('faces_detected' in p.extra), 'faces_detected omitted too — partial face data is not sent');
});

test('caption-worker.js (#276): face -> caption -> face round trip converges, nothing lost mid-way', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-276-roundtrip-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({ 'photo.jpg': [[0, 0, 0]] }));

  const faceState = path.join(tmp, 'faces.json');
  const clustersState = path.join(tmp, 'clusters.json');
  const captionState = path.join(tmp, 'captions.json');
  const shared = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    PHOTO_EXIF_CAPTION_STATE_PATH: captionState,
    FACE_THROTTLE_MS: '0',
    FACE_HINT_CONFIDENCE: '0.6',
  };

  const posted = [];
  const { server, port } = await startMockServer((req, body, res) => {
    posted.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const { server: vlmServer, port: vlmPort } = await startVlmStub('two people cooking');
  const url = `http://127.0.0.1:${port}`;

  // 1. face scan (cluster is anonymous), 2. name it, 3. caption, 4. face scan again
  assert.equal((await run('face-worker.js', { ...shared, LIFECONTEXT_URL: url })).status, 0);
  const clusterId = parseClustersFile(readFileSync(clustersState, 'utf8')).clusters[0].id;
  assert.equal((await run('face-worker.js', { ...shared, LIFECONTEXT_URL: url }, ['label', String(clusterId), 'Sarah Jones'])).status, 0);
  const afterLabel = posted.at(-1);
  assert.equal((await run('caption-worker.js', { ...shared, LIFECONTEXT_URL: url, VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`, VLM_THROTTLE_MS: '0' })).status, 0);
  const afterCaption = posted.at(-1);
  assert.equal((await run('face-worker.js', { ...shared, LIFECONTEXT_URL: url })).status, 0);
  const afterRefresh = posted.at(-1);

  server.closeAllConnections();
  server.close();
  vlmServer.close();

  // The label wave established the face data...
  assert.equal(afterLabel.extra.faces_detected, 1);
  assert.deepEqual(afterLabel.extra.pictured, ['Sarah Jones']);
  // ...the caption wave ADDED the caption without dropping any of it (pre-#276 this wiped both)...
  assert.equal(afterCaption.text_repr, 'Photo taken 2019-03-04 two people cooking Pictured: Sarah Jones.');
  assert.equal(afterCaption.extra.faces_detected, 1);
  assert.deepEqual(afterCaption.extra.pictured, ['Sarah Jones']);
  // ...and a following face pass is now a no-op in content: both workers agree byte-for-byte.
  assert.deepEqual(afterRefresh, afterCaption, 'face and caption workers converge on an identical payload');
});

// --- #53: face worker ------------------------------------------------------------------------

test('face-cluster: euclidean + nearest-centroid grouping and new-cluster creation', () => {
  assert.equal(euclideanDistance([0, 0, 0], [0, 0, 0]), 0);
  assert.ok(Math.abs(euclideanDistance([0, 0, 0], [3, 4, 0]) - 5) < 1e-9);

  const clusters = [];
  const a = assignCluster([0, 0, 0], clusters, 0.6);
  const b = assignCluster([0.05, 0, 0], clusters, 0.6); // within threshold -> same cluster
  const c = assignCluster([9, 9, 9], clusters, 0.6); // far -> new cluster
  assert.equal(a, b, 'nearby descriptors share a cluster');
  assert.notEqual(a, c, 'distant descriptor starts a new cluster');
  assert.equal(clusters.length, 2);
  assert.equal(clusters.find((x) => x.id === a).count, 2);

  // serialize round-trips version + clusters
  const round = parseClustersFile(serializeClustersFile(3, clusters));
  assert.equal(round.version, 3);
  assert.equal(round.clusters.length, 2);
  assert.deepEqual(parseClustersFile('not json'), { version: 0, clusters: [] });
});

test('face-align: umeyama recovers a known scale/rotation/translation and invertAffine round-trips', () => {
  const angle = (25 * Math.PI) / 180;
  const scale = 1.8;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const t = [15, -7];
  const src = [[0, 0], [10, 0], [5, 10], [2, 7], [8, 3]];
  const dst = src.map(([x, y]) => [scale * (cos * x - sin * y) + t[0], scale * (sin * x + cos * y) + t[1]]);

  const M = umeyama(src, dst);
  for (let i = 0; i < src.length; i++) {
    const [px, py] = applyAffine(M, src[i][0], src[i][1]);
    assert.ok(Math.abs(px - dst[i][0]) < 1e-6 && Math.abs(py - dst[i][1]) < 1e-6, `point ${i} maps to dst`);
  }

  const Minv = invertAffine(M);
  const [rx, ry] = applyAffine(Minv, dst[0][0], dst[0][1]);
  assert.ok(Math.abs(rx - src[0][0]) < 1e-6 && Math.abs(ry - src[0][1]) < 1e-6, 'invertAffine round-trips');

  // umeyama against the real DST_112 template (5-point face alignment) also succeeds and is finite.
  const M2 = umeyama(src.slice(0, 5), DST_112);
  for (const row of M2) for (const v of row) assert.ok(Number.isFinite(v));
});

test('face-align: SCRFD decode helpers (distance2bbox/kps, anchor grid, NMS)', () => {
  assert.deepEqual(distance2bbox([10, 10], [2, 3, 4, 5]), [8, 7, 14, 15]);
  assert.deepEqual(distance2kps([10, 10], [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]), [[11, 11], [12, 12], [13, 13], [14, 14], [15, 15]]);

  const anchors = generateAnchorCenters(16, 16, 8, 2);
  assert.equal(anchors.length, 8); // (16/8)^2 cells * 2 anchors/cell
  assert.deepEqual(anchors.slice(0, 2), [[0, 0], [0, 0]]); // first cell, both anchors at the same center

  const boxes = [
    { box: [0, 0, 10, 10], score: 0.9 },
    { box: [1, 1, 11, 11], score: 0.8 }, // heavy overlap with the first -> suppressed
    { box: [50, 50, 60, 60], score: 0.7 }, // disjoint -> kept
  ];
  assert.deepEqual(nms(boxes, 0.3), [0, 2]);
});

test('face-align: warpTo112 produces a normalized 112x112 NCHW float32 crop', () => {
  const width = 200, height = 150;
  const rgb = new Uint8Array(width * height * 3).fill(200);
  // 5 plausible face keypoints within the image (order doesn't matter for a shape/range check).
  const kps = [[70, 60], [130, 60], [100, 90], [80, 120], [120, 120]];
  const out = warpTo112(rgb, width, height, kps);
  assert.equal(out.length, 3 * 112 * 112);
  for (const v of out) assert.ok(v >= -1 - 1e-6 && v <= 1 + 1e-6, 'normalized to [-1,1]');
  // uniform 200-value input warps to a uniform (200-127.5)/127.5 output, modulo edge zero-padding.
  const expected = (200 - 127.5) / 127.5;
  assert.ok(Math.abs(out[112 * 56 + 56] - expected) < 1e-6, 'center pixel matches the uniform fill');
});

test('face-detect: l2Normalize produces a unit vector, and rejects a zero/degenerate vector', () => {
  const v = l2Normalize([3, 4, 0]);
  assert.equal(v.length, 3);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.equal(l2Normalize([0, 0, 0]), null);
  assert.equal(l2Normalize([NaN, 0, 0]), null);
});

test('caption-cache: legacy array read, map round-trip, currentTextRepr', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'caption-cache-'));
  const p = path.join(tmp, 'captions.json');

  writeFileSync(p, JSON.stringify(['2019/a.jpg', '2019/b.jpg'])); // legacy array
  assert.deepEqual(readCaptionCache(p), { '2019/a.jpg': null, '2019/b.jpg': null });

  writeCaptionCache(p, { 'x.jpg': 'a cat on a sofa' });
  assert.deepEqual(readCaptionCache(p), { 'x.jpg': 'a cat on a sofa' });
  assert.deepEqual(readCaptionCache(path.join(tmp, 'missing.json')), {}); // absent -> empty

  assert.equal(currentTextRepr('2019-03-04', 'a.jpg', null), 'Photo taken 2019-03-04');
  assert.equal(currentTextRepr('2019-03-04', 'a.jpg', 'a cat'), 'Photo taken 2019-03-04 a cat');
  assert.equal(currentTextRepr(null, 'a.jpg', null), 'Photo: a.jpg');
});

test('face-worker: scan clusters + records faces, label emits pictured hints preserving caption, re-scan is idempotent', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-worker-'));
  // Plain files — the fixture detector supplies descriptors; describePhoto tolerates non-EXIF.
  writeFileSync(path.join(tmp, 'a.jpg'), 'aaaa');
  writeFileSync(path.join(tmp, 'b.jpg'), 'bbbb');
  writeFileSync(path.join(tmp, 'c.jpg'), 'cccc');
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    'a.jpg': [[0, 0, 0]],
    'b.jpg': [[0.05, 0, 0]], // same person as a
    'c.jpg': [[9, 9, 9]], // different person
  }));
  // Pre-seed a caption for a.jpg so we can prove the "Pictured" append keeps the caption text.
  const captionState = path.join(tmp, 'captions.json');
  writeFileSync(captionState, JSON.stringify({ 'a.jpg': 'a sunny beach' }));

  // source_id is the content hash now (no sidecars here → generic keying).
  const hashA = sha256(Buffer.from('aaaa'));
  const hashB = sha256(Buffer.from('bbbb'));

  const faceState = path.join(tmp, 'faces.json');
  const clustersState = path.join(tmp, 'clusters.json');
  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    PHOTO_EXIF_CAPTION_STATE_PATH: captionState,
    FACE_THROTTLE_MS: '0',
    FACE_HINT_CONFIDENCE: '0.6',
  };

  // --- scan ---
  const scanReqs = [];
  const { server, port } = await startMockServer((req, body, res) => {
    scanReqs.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 0 }));
  });
  const scan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` });
  server.closeAllConnections();
  server.close();
  assert.equal(scan.status, 0, scan.stderr);
  assert.equal(scanReqs.length, 3, 'one upsert per photo');
  for (const r of scanReqs) {
    assert.equal(r.type, 'photo');
    assert.equal(r.source, 'photo-exif'); // content-hash keying, no sidecar
    assert.match(r.source_id, /^[0-9a-f]{64}$/);
    assert.equal(typeof r.extra.faces_detected, 'number');
    assert.equal(r.entity_hints, undefined, 'no hints while every cluster is unlabeled');
    assert.equal(typeof r.text_repr, 'string', 'text_repr is required by the contract and always sent');
    assert.doesNotMatch(r.text_repr, /Pictured:/, 'no Pictured sentence while unlabeled');
  }
  // Caption preserved through the unlabeled scan (reconstructed from the cache, not clobbered).
  assert.equal(scanReqs.find((r) => r.source_id === hashA).text_repr, 'Photo: a.jpg a sunny beach');
  assert.equal(scanReqs.find((r) => r.source_id === hashB).text_repr, 'Photo: b.jpg');
  const clusters = parseClustersFile(readFileSync(clustersState, 'utf8')).clusters;
  assert.equal(clusters.length, 2, 'a+b cluster, c alone');
  const person = clusters.find((c) => c.count === 2); // the a+b cluster (id independent of walk order)
  assert.ok(person, 'the two same-person photos formed one cluster');
  assert.ok(existsSync(faceState), 'face state written (kill-safe)');

  // --- label the a+b cluster ---
  const labelReqs = [];
  const { server: s2, port: p2 } = await startMockServer((req, body, res) => {
    labelReqs.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 1, unresolved_aliases: 0 }));
  });
  const lab = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p2}` }, ['label', String(person.id), 'Sarah Jones']);
  s2.closeAllConnections();
  s2.close();
  assert.equal(lab.status, 0, lab.stderr);
  assert.equal(labelReqs.length, 2, 'only the two photos in the labeled cluster are re-emitted');
  for (const r of labelReqs) {
    assert.deepEqual(r.entity_hints, [{ alias: 'Sarah Jones', alias_type: 'name', role: 'pictured', confidence: 0.6 }]);
    assert.match(r.text_repr, /Pictured: Sarah Jones\.$/);
    assert.deepEqual(r.extra.pictured, ['Sarah Jones']);
  }
  const aReq = labelReqs.find((r) => r.source_id === hashA);
  assert.equal(aReq.text_repr, 'Photo: a.jpg a sunny beach Pictured: Sarah Jones.', 'caption preserved, Pictured appended');

  // --- re-scan: nothing changed on disk or in labels -> no new upserts ---
  const reReqs = [];
  const { server: s3, port: p3 } = await startMockServer((req, body, res) => {
    reReqs.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const rescan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p3}` });
  s3.closeAllConnections();
  s3.close();
  assert.equal(rescan.status, 0, rescan.stderr);
  assert.equal(reReqs.length, 0, 'idempotent: unchanged photos + labels re-emit nothing');
});

test('face-worker: a file that fails detection is persisted so it is not retried until it changes (#289)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-worker-negcache-'));
  writeFileSync(path.join(tmp, 'good.jpg'), 'aaaa');
  writeFileSync(path.join(tmp, 'bad.jpg'), 'bbbb');
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    'good.jpg': [[0, 0, 0]],
    'bad.jpg': { error: 'simulated corrupt JPEG' }, // fixture error seam, see lib/face-detect.js
  }));

  const faceState = path.join(tmp, 'faces.json');
  const clustersState = path.join(tmp, 'clusters.json');
  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    FACE_THROTTLE_MS: '0',
  };

  // --- first scan: bad.jpg fails detection, good.jpg succeeds ---
  const { server, port } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const scan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` });
  server.closeAllConnections();
  server.close();
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stderr, /face detection failed for bad\.jpg/);
  const state1 = JSON.parse(readFileSync(faceState, 'utf8'));
  assert.ok(state1['bad.jpg']?.failed, 'the failed file is recorded, not silently dropped');
  assert.ok(!state1['good.jpg']?.failed);

  // --- second scan: bad.jpg unchanged on disk -> must NOT re-attempt detection (no repeat log) ---
  const { server: s2, port: p2 } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const rescan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p2}` });
  s2.closeAllConnections();
  s2.close();
  assert.equal(rescan.status, 0, rescan.stderr);
  assert.doesNotMatch(rescan.stderr, /face detection failed/, 'known-bad file was not retried');

  // --- bad.jpg is "repaired" (content/size changes) -> the fresh statKey clears the negative cache ---
  writeFileSync(path.join(tmp, 'bad.jpg'), 'bbbb-fixed');
  writeFileSync(fixturePath, JSON.stringify({ 'good.jpg': [[0, 0, 0]], 'bad.jpg': [[1, 1, 1]] }));
  const { server: s3, port: p3 } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const rescan2 = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p3}` });
  s3.closeAllConnections();
  s3.close();
  assert.equal(rescan2.status, 0, rescan2.stderr);
  const state3 = JSON.parse(readFileSync(faceState, 'utf8'));
  assert.equal(state3['bad.jpg']?.failed, undefined, 'a changed file clears the negative cache and is re-detected');
  assert.equal(state3['bad.jpg']?.faces, 1);
});

test('face-worker: FACE_THROTTLE_MS only delays an actual ingest call, not a skipped/unchanged file (#288)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-worker-throttle-'));
  writeFileSync(path.join(tmp, 'a.jpg'), 'aaaa');
  writeFileSync(path.join(tmp, 'b.jpg'), 'bbbb');
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({ 'a.jpg': [[0, 0, 0]], 'b.jpg': [[9, 9, 9]] }));

  // Generous relative to node startup/module-load overhead (Copilot review, PR #290): the
  // no-throttle assertion below compares rescanMs against THROTTLE_MS, so it needs enough
  // headroom that cold subprocess spawn time on a slower/CI runner can't cross this threshold
  // on its own — a mistaken per-file throttle would still separate cleanly at ~2*THROTTLE_MS.
  const THROTTLE_MS = 1500;
  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_STATE_PATH: path.join(tmp, 'faces.json'),
    PHOTO_EXIF_FACE_CLUSTERS_PATH: path.join(tmp, 'clusters.json'),
    FACE_THROTTLE_MS: String(THROTTLE_MS),
  };

  // --- first scan: both photos are new -> two real ingest calls -> throttled between them ---
  const arrivalTimes = [];
  const { server, port } = await startMockServer((req, body, res) => {
    arrivalTimes.push(Date.now());
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const scan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` });
  server.closeAllConnections();
  server.close();
  assert.equal(scan.status, 0, scan.stderr);
  assert.equal(arrivalTimes.length, 2);
  const gap = arrivalTimes[1] - arrivalTimes[0];
  assert.ok(gap >= THROTTLE_MS * 0.8, `expected ~${THROTTLE_MS}ms between real ingest calls, got ${gap}ms`);

  // --- rescan: nothing changed -> zero ingest calls -> must NOT pay any throttle sleep ---
  let rescanRequests = 0;
  const { server: s2, port: p2 } = await startMockServer((req, body, res) => {
    rescanRequests++;
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const t0 = Date.now();
  const rescan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p2}` });
  const rescanMs = Date.now() - t0;
  s2.closeAllConnections();
  s2.close();
  assert.equal(rescan.status, 0, rescan.stderr);
  assert.equal(rescanRequests, 0, 'idempotent rescan sends no requests');
  // A mistaken per-file throttle (the pre-fix #288 bug) would cost >= 2*THROTTLE_MS just walking
  // past these two already-done files; well under one interval proves it wasn't paid at all.
  assert.ok(rescanMs < THROTTLE_MS, `resuming past unchanged files should not throttle, took ${rescanMs}ms`);
});

test('face-worker: FACE_THROTTLE_MS still applies when the ingest call itself fails (#288)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-worker-throttle-fail-'));
  writeFileSync(path.join(tmp, 'a.jpg'), 'aaaa');
  writeFileSync(path.join(tmp, 'b.jpg'), 'bbbb');
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({ 'a.jpg': [[0, 0, 0]], 'b.jpg': [[9, 9, 9]] }));

  const THROTTLE_MS = 400;
  const arrivalTimes = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      arrivalTimes.push(Date.now());
      res.statusCode = 500;
      res.end('boom');
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  const scan = await run('face-worker.js', {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_STATE_PATH: path.join(tmp, 'faces.json'),
    PHOTO_EXIF_FACE_CLUSTERS_PATH: path.join(tmp, 'clusters.json'),
    FACE_THROTTLE_MS: String(THROTTLE_MS),
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
  });
  server.close();

  assert.equal(scan.status, 0, scan.stderr);
  assert.equal(arrivalTimes.length, 2, 'both ingest attempts were made despite failing');
  assert.match(scan.stderr, /ingest failed for a\.jpg, will retry next run/);
  assert.match(scan.stderr, /ingest failed for b\.jpg, will retry next run/);
  const gap = arrivalTimes[1] - arrivalTimes[0];
  assert.ok(gap >= THROTTLE_MS * 0.8, `a failed ingest attempt is still a real network call and should throttle, got ${gap}ms`);
});

test('face-worker: export-thumbnails writes a sample per cluster + index.json', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-export-'));
  writeFileSync(path.join(tmp, 'a.jpg'), 'aaaa');
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: 'Sarah Jones', sample: 'a.jpg' },
    { id: 2, centroid: [9, 9, 9], count: 1, label: null, sample: 'a.jpg' },
  ]));
  const outDir = path.join(tmp, 'faces-out');
  const res = await run('face-worker.js', {
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['export-thumbnails', outDir]);
  assert.equal(res.status, 0, res.stderr);
  const index = JSON.parse(readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  assert.equal(index['1'].label, 'Sarah Jones');
  assert.equal(index['2'].label, null);
  assert.ok(existsSync(path.join(outDir, '1.jpg')), 'sample image copied per cluster');
});

test('face-worker: suggest-labels (#84) matches unlabeled clusters against contact reference photos, never writes labels', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: null, sample: 'a.jpg' },                // unlabeled, near Sarah's reference
    { id: 2, centroid: [9, 9, 9], count: 1, label: null, sample: 'c.jpg' },                // unlabeled, far from every reference
    { id: 3, centroid: [0.01, 0, 0], count: 3, label: 'Already Named', sample: 'd.jpg' },  // labeled — must be excluded even though it's the closest match
  ]));

  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    '/fake/raw/sarah.jpg': [[0.02, 0, 0]],              // one face, close to cluster 1
    '/fake/raw/ambiguous.jpg': [[1, 1, 1], [2, 2, 2]],  // two faces -> ambiguous reference, skip
  }));

  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    FACE_SEED_THRESHOLD: '0.6',
  };
  const beforeClusters = readFileSync(clustersState, 'utf8');

  const { server, port } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/entities/photos')) {
      res.end(JSON.stringify({
        contacts: [
          { entity_id: 10, name: 'Sarah Jones', raw_path: '/fake/raw/sarah.jpg' },
          { entity_id: 11, name: 'Ambiguous Contact', raw_path: '/fake/raw/ambiguous.jpg' },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({})); // any other route (e.g. an accidental ingest) — never expected here
  });
  const res = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['suggest-labels']);
  server.closeAllConnections();
  server.close();

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /suggest — cluster 1 \(2 photo\(s\)\) possibly "Sarah Jones" \(entity #10/, 'cluster 1 is suggested as Sarah Jones');
  assert.equal(
    (res.stderr.match(/suggest — cluster/g) || []).length, 1,
    'exactly one suggestion — the far cluster and the already-labeled cluster (despite being the closest match) are not suggested'
  );
  assert.match(
    res.stderr, /skipping "Ambiguous Contact".*detected 2 faces, expected exactly 1/,
    'a multi-face reference photo is skipped, never treated as a match'
  );
  assert.equal(readFileSync(clustersState, 'utf8'), beforeClusters, 'suggest-labels never writes cluster.label — clusters file is byte-identical');
});

test('face-worker: suggest-labels exits early (no detector load, no network fetch) when every cluster is already labeled', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-early-exit-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: 'Already Named', sample: 'a.jpg' },
  ]));
  // LIFECONTEXT_URL is deliberately unreachable, and no FACE_MODELS_PATH/fixture is set — if the
  // early exit didn't fire before loading a detector or fetching contacts, this would fail loudly.
  const res = await run('face-worker.js', {
    LIFECONTEXT_API_KEY: 'test-key',
    LIFECONTEXT_URL: 'http://127.0.0.1:1',
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['suggest-labels']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no unlabeled clusters/);
});

test('face-worker: suggest-labels warns distinctly when every contact photo was unreadable/undetectable', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-allskip-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 1, label: null, sample: 'a.jpg' },
  ]));
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({})); // empty — every raw_path lookup misses -> 0 faces detected

  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  };
  const { server, port } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ contacts: [{ entity_id: 20, name: 'Nobody Detected', raw_path: '/fake/raw/missing.jpg' }] }));
  });
  const res = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['suggest-labels']);
  server.closeAllConnections();
  server.close();

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /all 1 contact photo\(s\) were unreadable\/undetectable/, 'a total-skip run is distinguishable from a healthy zero-match run');
});

test('face-worker: suggest-labels summary counts unique clusters, not contact×cluster matches', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-unique-'));
  const clustersState = path.join(tmp, 'clusters.json');
  // One unlabeled cluster; TWO different contacts both happen to match it.
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: null, sample: 'a.jpg' },
  ]));
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    '/fake/raw/one.jpg': [[0.01, 0, 0]],
    '/fake/raw/two.jpg': [[0.02, 0, 0]],
  }));

  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    FACE_SEED_THRESHOLD: '0.6',
  };
  const { server, port } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      contacts: [
        { entity_id: 30, name: 'Contact One', raw_path: '/fake/raw/one.jpg' },
        { entity_id: 31, name: 'Contact Two', raw_path: '/fake/raw/two.jpg' },
      ],
    }));
  });
  const res = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['suggest-labels']);
  server.closeAllConnections();
  server.close();

  assert.equal(res.status, 0, res.stderr);
  assert.equal((res.stderr.match(/suggest — cluster/g) || []).length, 2, 'both contacts are printed as suggestions for the one cluster');
  assert.match(res.stderr, /checked 2 contact photo\(s\) \(0 skipped\), 1 cluster\(s\) suggested/, 'the summary counts the one unique cluster, not the two contact matches');
});

test('face-worker: suggest-from-sidecars (#272) votes single-name/single-face sidecars against unlabeled clusters, never writes/posts', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-sidecars-'));
  const sidecar = (relPath, names) => writeFileSync(path.join(tmp, `${relPath}.supplemental-metadata.json`), JSON.stringify({ people: names.map((n) => ({ name: n })) }));

  const clustersState = path.join(tmp, 'clusters.json');
  const clustersJson = serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 4, label: null, sample: 'amy1.jpg' }, // clear majority
    { id: 2, centroid: [0, 0, 0], count: 5, label: null, sample: 'split1.jpg' }, // fails min-fraction
    { id: 3, centroid: [0, 0, 0], count: 3, label: 'Someone Known', sample: 'known1.jpg' }, // already labeled
  ]);
  writeFileSync(clustersState, clustersJson);

  const faceState = path.join(tmp, 'faces.json');
  const faceStateJson = JSON.stringify({
    'amy1.jpg': { faces: 1, clusters: [1] },
    'amy2.jpg': { faces: 1, clusters: [1] },
    'amy3.jpg': { faces: 1, clusters: [1] },
    'amy4.jpg': { faces: 1, clusters: [1] },
    'split1.jpg': { faces: 1, clusters: [2] },
    'split2.jpg': { faces: 1, clusters: [2] },
    'split3.jpg': { faces: 1, clusters: [2] },
    'split4.jpg': { faces: 1, clusters: [2] },
    'split5.jpg': { faces: 1, clusters: [2] },
    'known1.jpg': { faces: 1, clusters: [3] },
    'known2.jpg': { faces: 1, clusters: [3] },
    'known3.jpg': { faces: 1, clusters: [3] },
    'two-faces.jpg': { faces: 2, clusters: [1, 2] }, // excluded: faces !== 1
    'multi-name.jpg': { faces: 1, clusters: [1] }, // excluded: sidecar names 2 people
    'no-sidecar.jpg': { faces: 1, clusters: [1] }, // excluded: no sidecar at all
  });
  writeFileSync(faceState, faceStateJson);

  for (let i = 1; i <= 4; i++) sidecar(`amy${i}.jpg`, ['Amy Fenwick']);
  for (let i = 1; i <= 3; i++) sidecar(`split${i}.jpg`, ['Amy Fenwick']);
  for (let i = 4; i <= 5; i++) sidecar(`split${i}.jpg`, ['Matt Sorrel']);
  for (let i = 1; i <= 3; i++) sidecar(`known${i}.jpg`, ['Someone Known']); // labeled cluster — must be excluded entirely
  sidecar('two-faces.jpg', ['Amy Fenwick']);
  sidecar('multi-name.jpg', ['Amy Fenwick', 'Matt Sorrel']);
  // no-sidecar.jpg deliberately gets no sidecar file

  const res = await run('face-worker.js', {
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['suggest-from-sidecars']);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /cluster 1 → "Amy Fenwick" \(4 of 4 single-name votes, 100%\)/, 'clear majority is suggested with vote counts');
  assert.match(res.stderr, /cluster 2: no majority \(Amy Fenwick 3, Matt Sorrel 2 of 5\) — skipped/, 'a split vote below FACE_SEED_MIN_FRACTION is not suggested');
  assert.doesNotMatch(res.stderr, /cluster 3/, 'an already-labeled cluster is excluded entirely, even though its votes would qualify');
  assert.match(res.stderr, /checked 2 unlabeled cluster\(s\) against 9 single-name\/single-face photo\(s\), suggested 1/);

  assert.equal(readFileSync(clustersState, 'utf8'), clustersJson, 'suggest-from-sidecars never writes cluster.label — clusters file is byte-identical');
  assert.equal(readFileSync(faceState, 'utf8'), faceStateJson, 'suggest-from-sidecars never mutates face state');
});

test('face-worker: suggest-from-sidecars — a blank FACE_SEED_MIN_VOTES/FACE_SEED_MIN_FRACTION falls back to the default gate, not 0', async () => {
  // Number('') is 0, which is Number.isFinite — a naive Number()+isFinite parse would treat a
  // blank env value as a valid override and silently disable the confidence gate this feature
  // exists to provide. A single weak vote must NOT be suggested when the env is left blank.
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-sidecars-blank-env-'));
  const sidecar = (relPath, names) => writeFileSync(path.join(tmp, `${relPath}.supplemental-metadata.json`), JSON.stringify({ people: names.map((n) => ({ name: n })) }));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [{ id: 1, centroid: [0, 0, 0], count: 1, label: null, sample: 'weak.jpg' }]));
  const faceState = path.join(tmp, 'faces.json');
  writeFileSync(faceState, JSON.stringify({ 'weak.jpg': { faces: 1, clusters: [1] } }));
  sidecar('weak.jpg', ['Amy Fenwick']); // exactly 1 vote — fails the default FACE_SEED_MIN_VOTES=3

  const res = await run('face-worker.js', {
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    FACE_SEED_MIN_VOTES: '',
    FACE_SEED_MIN_FRACTION: '',
  }, ['suggest-from-sidecars']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /cluster 1 →/, 'a blank threshold env must not disable the gate and auto-suggest a single-vote cluster');
  assert.match(res.stderr, /cluster 1: no majority \(Amy Fenwick 1 of 1\) — skipped/);
});

test('face-worker: suggest-from-sidecars exits early when every cluster is already labeled', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-sidecars-early-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [{ id: 1, centroid: [0, 0, 0], count: 1, label: 'Already Named', sample: 'a.jpg' }]));
  const res = await run('face-worker.js', {
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['suggest-from-sidecars']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no unlabeled clusters/);
});

test('face-worker: suggest-from-sidecars — PHOTO_ROOT missing exits 1, and no sidecar votes exits 0 with a clean message', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-sidecars-edge-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [{ id: 1, centroid: [0, 0, 0], count: 1, label: null, sample: 'a.jpg' }]));

  const missing = await run('face-worker.js', {
    PHOTO_ROOT: path.join(tmp, 'does-not-exist'),
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['suggest-from-sidecars']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /PHOTO_ROOT not set or doesn't exist/);

  const faceState = path.join(tmp, 'faces.json');
  writeFileSync(faceState, JSON.stringify({ 'no-sidecar.jpg': { faces: 1, clusters: [1] } })); // no sidecar written -> zero votes
  const noVotes = await run('face-worker.js', {
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['suggest-from-sidecars']);
  assert.equal(noVotes.status, 0, noVotes.stderr);
  assert.match(noVotes.stderr, /nothing to suggest \(no single-name sidecar votes\)/);
});

// --- #280: shared HEIC-capable decode ----------------------------------------------------------

// Fake sharp: each call returns a fresh pipeline stub that records whether `.rotate()` was
// invoked on it — the one thing that must differ between the two decode paths (the heic-decode
// path must NOT re-apply rotation; libheif already applied it during decode).
// clone()/stats() are needed because decodeWithSharp now forces a real decode on a clone before
// returning (#282 review — sharp defers real decode errors past construction, so an unguarded
// caller would never see a mislabeled-file failure in time to fall back to heic-decode).
function fakeSharpFactory() {
  return () => {
    const pipeline = { rotated: false };
    pipeline.rotate = () => { pipeline.rotated = true; return pipeline; };
    pipeline.clone = () => pipeline;
    pipeline.stats = async () => ({});
    return pipeline;
  };
}

test('decode-image: .heic dispatches to heic-decode first, .jpg dispatches to sharp first, and only the sharp path rotates', async () => {
  const order = [];
  const rawSharp = fakeSharpFactory();
  const sharp = (...args) => { order.push('sharp'); return rawSharp(...args); };
  const heicDecode = async () => { order.push('heic'); return { width: 2, height: 2, data: new Uint8ClampedArray(16) }; };
  const openImage = createOpenImage({ sharp, heicDecode, readFile: async () => Buffer.alloc(0) });

  const heicPipeline = await openImage('/photos/IMG_5048.HEIC');
  assert.deepEqual(order, ['heic', 'sharp'], 'heic-decode runs first; sharp is only used to wrap its raw RGBA output');
  assert.equal(heicPipeline.rotated, false, 'the heic-decode path must not re-apply EXIF rotation — libheif already rotated the pixels, and a second rotate would double-rotate every portrait iPhone photo');

  order.length = 0;
  const jpgPipeline = await openImage('/photos/vacation.jpg');
  assert.deepEqual(order, ['sharp'], '.jpg dispatches straight to sharp; heic-decode never runs');
  assert.equal(jpgPipeline.rotated, true, 'the sharp path still applies EXIF rotation, unchanged from before this helper existed');

  // Case-insensitive + .heif, matching real Takeout/iPhone filenames.
  order.length = 0;
  await openImage('/photos/IMG_1.HEIF');
  assert.deepEqual(order, ['heic', 'sharp'], '.HEIF (uppercase) also dispatches to heic-decode first');
});

test('decode-image: each path falls back to the other decoder on failure', async () => {
  // .heic: heic-decode throws (the decoder-plugin / iref-security-limit failures sharp hits) ->
  // sharp is tried as the fallback and succeeds.
  const sharpOk = fakeSharpFactory();
  const openImageHeicFallback = createOpenImage({
    sharp: sharpOk,
    heicDecode: async () => { throw new Error('libheif: decoder plugin error'); },
    readFile: async () => Buffer.alloc(0),
  });
  const viaSharpFallback = await openImageHeicFallback('/photos/broken.heic');
  assert.equal(viaSharpFallback.rotated, true, 'fell through to the sharp path, which rotates');

  // .jpg: sharp throws (a Takeout file mislabeled with the wrong extension) -> heic-decode is
  // tried as the fallback and succeeds.
  const openImageSharpFallback = createOpenImage({
    sharp: (input) => {
      if (typeof input === 'string') throw new Error('sharp: unsupported image format');
      return fakeSharpFactory()(input); // reached only via the heic-decode fallback, wrapping its raw output
    },
    heicDecode: async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
    readFile: async () => Buffer.alloc(0),
  });
  const viaHeicFallback = await openImageSharpFallback('/photos/mislabeled.jpg');
  assert.equal(viaHeicFallback.rotated, false, 'fell through to the heic-decode path, which does not rotate');
});

test('decode-image: a REAL sharp decode failure (not a synchronous throw) still triggers the heic-decode fallback (#282 review)', async () => {
  // sharp defers the real pixel decode until an output op runs — `sharp(absPath)` alone never
  // throws for an undecodable file, even though the test above simulates sharp throwing right at
  // construction. That's not representative of real sharp behavior, so this exercises the REAL
  // sharp module (no override) against a file it genuinely cannot decode, proving decodeWithSharp
  // forces the decode itself rather than relying on the caller to eventually trip over it.
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-mislabeled-'));
  const mislabeled = path.join(tmp, 'mislabeled.jpg'); // a Takeout file with the wrong extension
  writeFileSync(mislabeled, Buffer.from('not an image sharp can decode, just plain bytes'));

  const openImage = createOpenImage({
    heicDecode: async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
  });
  const pipeline = await openImage(mislabeled);
  assert.ok(pipeline, 'a real sharp decode failure on a mislabeled file still falls back to heic-decode, not a silently-broken pipeline');
});

test('decode-image: both decoders failing throws once, naming both underlying causes', async () => {
  const openImage = createOpenImage({
    sharp: () => { throw new Error('sharp: unsupported image format'); },
    heicDecode: async () => { throw new Error('libheif: decoder plugin error'); },
    readFile: async () => Buffer.alloc(0),
  });
  await assert.rejects(
    () => openImage('/photos/unreadable.heic'),
    (err) => {
      assert.match(err.message, /cannot decode/);
      assert.match(err.message, /sharp: sharp: unsupported image format/);
      assert.match(err.message, /heic-decode: libheif: decoder plugin error/);
      return true;
    },
  );
});

// --- #280: caption worker survives a bad photo, stops only after N consecutive VLM failures ----

test('caption-worker.js (#280): one failed photo does not abort the run; the failure counter resets on the next success', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-vlm-fail-'));
  writeFileSync(path.join(tmp, 'a.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, 'b.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, 'c.jpg'), jpegWithExif({ dateTimeOriginal: '2021:03:04 14:30:00' }));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });

  // Exactly one VLM call ever fails, regardless of which photo hits it first (walk order is not
  // guaranteed) — proves a single bad photo mid-run doesn't wedge the whole pass.
  let vlmCalls = 0;
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmCalls++;
      if (vlmCalls === 1) { res.statusCode = 500; res.end('boom'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: 'a caption' }));
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: path.join(tmp, 'captions.json'),
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
    VLM_MAX_CONSECUTIVE_FAILURES: '2',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vlmCalls, 3, 'all three photos were attempted — one failure did not abort the run');
  assert.equal(ingestRequests.length, 2, 'the two photos that captioned successfully were ingested');
  assert.match(result.stderr, /VLM call failed for .*\(1\/2 consecutive\)/);
});

test('caption-worker.js (#280): stops the run after VLM_MAX_CONSECUTIVE_FAILURES in a row', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-vlm-stop-'));
  writeFileSync(path.join(tmp, 'a.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, 'b.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, 'c.jpg'), jpegWithExif({ dateTimeOriginal: '2021:03:04 14:30:00' }));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });

  let vlmCalls = 0;
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmCalls++;
      res.statusCode = 500;
      res.end('boom');
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: path.join(tmp, 'captions.json'),
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
    VLM_MAX_CONSECUTIVE_FAILURES: '2',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr); // stops cleanly, not a crash
  assert.equal(vlmCalls, 2, 'stops after the 2nd consecutive failure, never attempts the 3rd photo');
  assert.equal(ingestRequests.length, 0);
  assert.match(result.stderr, /2 consecutive VLM failures, stopping run/);
});

test('caption-worker.js (#280): VLM_MAX_CONSECUTIVE_FAILURES=0 falls back to the default rather than stopping before the first attempt', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-vlm-zero-'));
  writeFileSync(path.join(tmp, 'a.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const { server: vlmServer, port: vlmPort } = await startVlmStub('a caption');

  // consecutiveFailures starts at 0, so a literal "0" (or negative) must not be read as "stop
  // after zero failures" — that would break out before the VLM is ever called even once.
  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: path.join(tmp, 'captions.json'),
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
    VLM_MAX_CONSECUTIVE_FAILURES: '0',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(ingestRequests.length, 1, 'the VLM was called and the photo was captioned, not skipped outright');
});

test('caption-worker.js (#282 review): throttles between VLM attempts even after a failure', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-vlm-throttle-'));
  writeFileSync(path.join(tmp, 'a.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, 'b.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));

  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  // Every call fails — records the server-side arrival time of each, so the gap between them
  // reflects only the worker's own throttle, not subprocess spawn overhead.
  const vlmTimestamps = [];
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmTimestamps.push(Date.now());
      res.statusCode = 500;
      res.end('boom');
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const THROTTLE_MS = 200;
  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: path.join(tmp, 'captions.json'),
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: String(THROTTLE_MS),
    VLM_MAX_CONSECUTIVE_FAILURES: '5', // stay above the file count so both photos are attempted
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vlmTimestamps.length, 2, 'both photos were attempted despite the first failing');
  const gap = vlmTimestamps[1] - vlmTimestamps[0];
  // Generous slack for scheduler jitter — a MISSING throttle (the pre-fix bug, #282 review) would
  // put this gap at single-digit ms, nowhere near even 80% of THROTTLE_MS.
  assert.ok(gap >= THROTTLE_MS * 0.8, `expected ~${THROTTLE_MS}ms between VLM attempts (throttled even on failure), got ${gap}ms`);
});

// --- #342: merge-clusters — pure planning/arithmetic (lib/face-cluster.js) ---------------------

test('face-cluster: mergeTwo computes the count-weighted centroid mean, prefers the survivor label, and flattens merged_from', () => {
  const survivor = { id: 1, centroid: [0, 0], count: 2, label: null, sample: null, merged_from: [] };
  const absorbed = { id: 2, centroid: [10, 10], count: 6, label: null, sample: 'b.jpg', merged_from: [] };
  const merged = mergeTwo(survivor, absorbed);
  assert.equal(merged.id, 1, 'keeps the survivor id');
  assert.equal(merged.count, 8);
  // (0*2 + 10*6) / 8 = 7.5 — a plain (unweighted) average would give 5, which would let a
  // 2-photo pile drag a 6-photo pile's centroid; this proves the weighting.
  assert.deepEqual(merged.centroid, [7.5, 7.5]);
  assert.equal(merged.sample, 'b.jpg', 'an absent survivor sample falls back to the absorbed one');
  assert.deepEqual(merged.merged_from, [2]);

  // Labeled + unlabeled keeps the label, whichever side carries it.
  assert.equal(mergeTwo({ ...survivor, label: 'Amy Fenwick' }, absorbed).label, 'Amy Fenwick');
  assert.equal(mergeTwo(survivor, { ...absorbed, label: 'Amy Fenwick' }).label, 'Amy Fenwick');

  // merged_from flattens a prior chain rather than nesting it.
  const chained = mergeTwo(
    { id: 1, centroid: [0, 0], count: 1, label: null, sample: null, merged_from: [2] },
    { id: 3, centroid: [1, 1], count: 1, label: null, sample: null, merged_from: [] }
  );
  assert.deepEqual(chained.merged_from, [2, 3]);
});

test('face-cluster: planMerges is deterministic — identical input yields a byte-identical plan, closest pair first, ties broken by lowest id (#342)', () => {
  // Two independent close pairs at DIFFERENT distances: (30,40) is closer than (10,20), so it must
  // merge first even though its ids are numerically higher — proves ordering is by distance, not id.
  const clusters = [
    { id: 10, centroid: [0, 0], count: 1, label: null, sample: null },
    { id: 20, centroid: [1, 0], count: 1, label: null, sample: null }, // dist(10,20) = 1
    { id: 30, centroid: [10, 0], count: 1, label: null, sample: null },
    { id: 40, centroid: [10.4, 0], count: 1, label: null, sample: null }, // dist(30,40) = 0.4
  ];
  const snapshot = JSON.stringify(clusters);
  const plan1 = planMerges(clusters, 1.5);
  assert.equal(JSON.stringify(clusters), snapshot, 'planMerges must not mutate its input');
  const plan2 = planMerges(clusters, 1.5); // fresh call, same input
  assert.deepEqual(plan1, plan2, 'identical input must yield a byte-identical (deepEqual) plan every time');

  assert.deepEqual(plan1.merges.map((m) => [m.survivorId, m.absorbedId]), [[30, 40], [10, 20]], 'the closer pair (30,40) merges before the farther pair (10,20)');
  assert.ok(Math.abs(plan1.merges[0].distance - 0.4) < 1e-9);
  assert.ok(Math.abs(plan1.merges[1].distance - 1) < 1e-9);
  assert.deepEqual(plan1.refusals, []);

  // Exact-tie case: two pairs at the SAME distance — tie-break must pick the pair with the lower
  // ids first, deterministically (not whichever the JS engine happens to iterate first).
  const tied = [
    { id: 100, centroid: [0, 0], count: 1, label: null, sample: null },
    { id: 200, centroid: [1, 0], count: 1, label: null, sample: null }, // dist(100,200) = 1
    { id: 300, centroid: [10, 0], count: 1, label: null, sample: null },
    { id: 400, centroid: [11, 0], count: 1, label: null, sample: null }, // dist(300,400) = 1, tied
  ];
  const tiedPlan = planMerges(tied, 1.5);
  assert.deepEqual(tiedPlan.merges.map((m) => [m.survivorId, m.absorbedId]), [[100, 200], [300, 400]], 'a distance tie is broken by the lower id pair');

  // A three-way chain: (1,2) merges first, then the UPDATED centroid is close enough to pull in a
  // third cluster that was NOT within threshold of the original id-1 centroid — proves the plan
  // recomputes distances against the merged centroid rather than the stale originals.
  const chain = [
    { id: 1, centroid: [0, 0, 0], count: 1, label: null, sample: null },
    { id: 2, centroid: [0.4, 0, 0], count: 1, label: null, sample: null }, // dist(1,2) = 0.4
    { id: 3, centroid: [0.9, 0, 0], count: 1, label: null, sample: null }, // dist(1,3) = 0.9 (out of range), dist(2,3) = 0.5
  ];
  const chainPlan = planMerges(chain, 0.75);
  assert.equal(chainPlan.merges.length, 2, 'both merges happen: (1,2) then the updated centroid reaches 3');
  assert.deepEqual([chainPlan.merges[0].survivorId, chainPlan.merges[0].absorbedId], [1, 2]);
  assert.deepEqual([chainPlan.merges[1].survivorId, chainPlan.merges[1].absorbedId], [1, 3]);
});

test('face-cluster: planMerges refuses two differently-labeled clusters, names them, and never merges them', () => {
  const clusters = [
    { id: 1, centroid: [0, 0, 0], count: 5, label: 'Amy Fenwick', sample: null },
    { id: 2, centroid: [0.05, 0, 0], count: 4, label: 'Beth Allister', sample: null }, // very close, but different labels
  ];
  const { merges, refusals } = planMerges(clusters, 1.0);
  assert.deepEqual(merges, [], 'a differently-labeled pair is never merged, no matter how close');
  assert.deepEqual(refusals, [{ clusterA: 1, clusterB: 2, labelA: 'Amy Fenwick', labelB: 'Beth Allister' }]);
});

test('face-cluster: planMerges — an unlabeled survivor inherits the absorbed cluster\'s label, and the inherited label then blocks a further merge (#342)', () => {
  const clusters = [
    { id: 1, centroid: [0.05, 0, 0], count: 2, label: null, sample: null },
    { id: 2, centroid: [0, 0, 0], count: 5, label: 'Amy Fenwick', sample: null }, // dist(1,2) = 0.05, closest
    { id: 3, centroid: [0.2, 0, 0], count: 4, label: 'Beth Allister', sample: null }, // dist(1,3) = 0.15; dist(2,3) = 0.2, refused up front
  ];
  const { merges, refusals } = planMerges(clusters, 1.0);
  assert.deepEqual(merges.map((m) => [m.survivorId, m.absorbedId]), [[1, 2]], 'only the unlabeled+labeled pair merges');
  const namedRefusals = refusals.map((r) => [r.clusterA, r.clusterB, r.labelA, r.labelB]);
  assert.deepEqual(namedRefusals.sort(), [[1, 3, 'Amy Fenwick', 'Beth Allister'], [2, 3, 'Amy Fenwick', 'Beth Allister']].sort(), 'cluster 3 is refused both against the original label-2 and against the survivor that inherited it');
});

// Copilot review (PR #344): planMerges' heap staleness check ONLY recomputed distance, on the
// (stated, but false) assumption that a label change always comes with a centroid change. It
// doesn't — mergeTwo's count-weighted mean of two IDENTICAL centroids returns that same centroid,
// so a survivor can inherit a label with ZERO centroid movement, and a heap entry for a NOW-refused
// pair (heaped before the label changed) has nothing to make its distance look stale. Real
// duplicate photos (Takeout's `-edited` companions) produce identical descriptors, so this isn't
// only a theoretical shape. Unlike the test above, A and B sit at the exact SAME centroid, so a
// distance-only staleness check cannot detect the label change — this is what must fail without
// the pop-time label re-check.
test('face-cluster: planMerges — a label inherited with ZERO centroid movement (identical centroids) still blocks a pending merge (#342, Copilot PR #344)', () => {
  const clusters = [
    { id: 1, centroid: [0, 0, 0], count: 2, label: null, sample: null },       // A: unlabeled
    { id: 2, centroid: [0, 0, 0], count: 5, label: 'Amy', sample: null },      // B: "Amy", IDENTICAL centroid to A
    { id: 3, centroid: [0.5, 0, 0], count: 3, label: 'Beth', sample: null },   // C: "Beth", within threshold of both
  ];
  const { merges, refusals } = planMerges(clusters, 1.0);
  // A+B merge first (distance 0, closest possible) — the survivor (id 1) inherits "Amy" from B
  // with its centroid UNCHANGED (weighted mean of two identical points is that same point).
  assert.deepEqual(merges.map((m) => [m.survivorId, m.absorbedId]), [[1, 2]], 'only the identical-centroid pair merges');
  // C ("Beth") must NEVER merge with the "Amy"-inherited survivor, even though (1,3)'s distance
  // never moved from what was heaped before cluster 1 had a label at all.
  assert.ok(!merges.some((m) => m.survivorId === 3 || m.absorbedId === 3), 'cluster 3 (Beth) is never merged away');
  const namedRefusals = refusals.map((r) => [r.clusterA, r.clusterB, r.labelA, r.labelB]).sort();
  assert.deepEqual(namedRefusals, [[1, 3, 'Amy', 'Beth'], [2, 3, 'Amy', 'Beth']].sort(), 'cluster 3 is refused against both the pre-merge label-2 and the post-merge survivor');
});

// --- #342: merge-clusters — the CLI command (face-worker.js) -----------------------------------

test('face-worker.js merge-clusters: dry run prints the plan + resulting count and writes nothing (both state files byte-identical)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-dryrun-'));
  const clustersPath = path.join(tmp, 'clusters.json');
  const facesPath = path.join(tmp, 'faces.json');
  writeFileSync(clustersPath, serializeClustersFile(7, [
    { id: 1, centroid: [0, 0, 0], count: 5, label: null, sample: 'a.jpg' },
    { id: 2, centroid: [0.3, 0, 0], count: 3, label: null, sample: 'b.jpg' }, // dist(1,2) = 0.3
    { id: 3, centroid: [9, 9, 9], count: 2, label: null, sample: 'c.jpg' },   // far — no merge
  ]));
  writeFileSync(facesPath, JSON.stringify({ 'a.jpg': { faces: 1, clusters: [1] } }));
  const beforeClusters = readFileSync(clustersPath, 'utf8');
  const beforeFaces = readFileSync(facesPath, 'utf8');

  // LIFECONTEXT_URL is deliberately unreachable and no API key is set — a dry run must need neither.
  const res = await run('face-worker.js', {
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersPath,
    PHOTO_EXIF_FACE_STATE_PATH: facesPath,
  }, ['merge-clusters', '--threshold', '1.0']);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /merge-clusters — DRY RUN at threshold 1/);
  assert.match(res.stderr, /merge — 1 \+ 2 -> 1 \(5 \+ 3 photos, distance 0\.30\)/);
  assert.match(res.stderr, /merge-clusters — 3 clusters -> 2 \(1 merges, 0 refusals\); re-run with --apply/);
  assert.equal(readFileSync(clustersPath, 'utf8'), beforeClusters, 'dry run writes nothing to the clusters file');
  assert.equal(readFileSync(facesPath, 'utf8'), beforeFaces, 'dry run writes nothing to the face-state file');
});

test('face-worker.js merge-clusters: requires --threshold and rejects an out-of-range --max-merge-fraction', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-badargs-'));
  const noThreshold = await run('face-worker.js', {
    PHOTO_EXIF_FACE_CLUSTERS_PATH: path.join(tmp, 'clusters.json'),
  }, ['merge-clusters']);
  assert.equal(noThreshold.status, 1);
  assert.match(noThreshold.stderr, /usage: face-worker\.js merge-clusters --threshold/);

  const badFraction = await run('face-worker.js', {
    PHOTO_EXIF_FACE_CLUSTERS_PATH: path.join(tmp, 'clusters.json'),
  }, ['merge-clusters', '--threshold', '1.0', '--max-merge-fraction', '2']);
  assert.equal(badFraction.status, 1);
  assert.match(badFraction.stderr, /--max-merge-fraction must be a number between 0 and 1/);
});

test('face-worker.js merge-clusters --apply: persists BOTH state files before any network call, writes a backup, and its own printed plan matches the dry run exactly (#342)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-crashsafety-'));
  const clustersPath = path.join(tmp, 'clusters.json');
  const facesPath = path.join(tmp, 'faces.json');
  writeFileSync(clustersPath, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 5, label: null, sample: 'a.jpg' },
    { id: 2, centroid: [0.3, 0, 0], count: 3, label: null, sample: 'b.jpg' }, // dist(1,2) = 0.3 -> merges
    { id: 3, centroid: [9, 9, 9], count: 2, label: null, sample: 'c.jpg' },   // far — untouched
  ]));
  writeFileSync(facesPath, JSON.stringify({
    'a.jpg': { source: 'photo-exif', source_id: 'hasha', statKey: 'x:1', faces: 1, clusters: [1], dateStr: null, ingestedSig: null },
    'b.jpg': { source: 'photo-exif', source_id: 'hashb', statKey: 'x:1', faces: 1, clusters: [2], dateStr: null, ingestedSig: null },
    'c.jpg': { source: 'photo-exif', source_id: 'hashc', statKey: 'x:1', faces: 1, clusters: [3], dateStr: null, ingestedSig: null },
  }));
  const env = { LIFECONTEXT_API_KEY: 'test-key', PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersPath, PHOTO_EXIF_FACE_STATE_PATH: facesPath };

  const dry = await run('face-worker.js', { ...env, LIFECONTEXT_URL: 'http://127.0.0.1:1' }, ['merge-clusters', '--threshold', '1.0']);
  assert.equal(dry.status, 0, dry.stderr);
  const beforeClusters = readFileSync(clustersPath, 'utf8');
  const beforeFaces = readFileSync(facesPath, 'utf8');

  // The mock server's FIRST request handler snapshots the on-disk state — proving both files were
  // already persisted (merged + remapped) before this, the only network call, went out.
  let snapshot = null;
  const { server, port } = await startMockServer((req, body, res) => {
    if (!snapshot) {
      snapshot = { clusters: JSON.parse(readFileSync(clustersPath, 'utf8')), faces: JSON.parse(readFileSync(facesPath, 'utf8')) };
    }
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 0 }));
  });
  const apply = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['merge-clusters', '--threshold', '1.0', '--apply']);
  server.closeAllConnections();
  server.close();
  assert.equal(apply.status, 0, apply.stderr);

  // Same plan lines as the dry run — the printed apply plan IS the dry run's plan, not a rewording.
  assert.match(apply.stderr, /merge — 1 \+ 2 -> 1 \(5 \+ 3 photos, distance 0\.30\)/);
  assert.match(apply.stderr, /merge-clusters — 3 clusters -> 2 \(1 merges, 0 refusals\)/);
  assert.doesNotMatch(apply.stderr, /re-run with --apply/, 'apply does not tell you to re-run with --apply');
  assert.match(apply.stderr, /wrote backup (.+)/);
  // remapped=1 (only b.jpg's cluster id literally moved, 2 -> 1) but re-emitted=2: a.jpg's cluster
  // id was ALREADY 1 (unchanged), yet it's still a re-emit candidate because survivor 1 is an
  // "affected" cluster (its count/merged_from changed) — so a.jpg's ingestedSig gets refreshed too.
  assert.match(apply.stderr, /applied 1 merge\(s\), remapped 1 photo entr\(ies\), re-emitted 2 hint\(s\)/);

  assert.ok(snapshot, 'the mock ingest server received the expected request');
  assert.equal(snapshot.clusters.clusters.length, 2, 'clusters file was ALREADY merged before the network call');
  const survivorAtSnapshot = snapshot.clusters.clusters.find((c) => c.id === 1);
  assert.deepEqual(survivorAtSnapshot.merged_from, [2], 'merged_from already recorded before the network call');
  assert.deepEqual(snapshot.faces['b.jpg'].clusters, [1], 'face-state already remapped before the network call');

  // The backup dir holds the PRE-merge content, byte-for-byte.
  const backupRoot = path.join(tmp, 'merge-backups');
  const stamps = readdirSync(backupRoot);
  assert.equal(stamps.length, 1);
  assert.equal(readFileSync(path.join(backupRoot, stamps[0], 'clusters.json'), 'utf8'), beforeClusters);
  assert.equal(readFileSync(path.join(backupRoot, stamps[0], 'faces.json'), 'utf8'), beforeFaces);

  // No re-detection: `faces` counts are untouched; only `clusters` moved. Survivor recorded what it absorbed.
  const finalClusters = parseClustersFile(readFileSync(clustersPath, 'utf8')).clusters;
  const survivor = finalClusters.find((c) => c.id === 1);
  assert.equal(survivor.count, 8);
  assert.deepEqual(survivor.merged_from, [2]);
  const finalFaces = JSON.parse(readFileSync(facesPath, 'utf8'));
  assert.equal(finalFaces['a.jpg'].faces, 1);
  assert.equal(finalFaces['b.jpg'].faces, 1);
  assert.equal(finalFaces['c.jpg'].faces, 1);
  assert.deepEqual(finalFaces['a.jpg'].clusters, [1]);
  assert.deepEqual(finalFaces['b.jpg'].clusters, [1], 'b.jpg remapped from absorbed cluster 2 to survivor 1');
  assert.deepEqual(finalFaces['c.jpg'].clusters, [3], 'the untouched far cluster is left alone');
});

test('face-worker.js merge-clusters --apply: remaps every face-state clusters array to the surviving id, dedupes multi-face entries, and leaves no dangling references across a multi-hop chain (#342)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-remap-'));
  const clustersPath = path.join(tmp, 'clusters.json');
  const facesPath = path.join(tmp, 'faces.json');
  // A three-cluster chain that all merges into survivor 1 (see the determinism test above for the
  // same shape proven at the lib level): dist(1,2)=0.2, dist(2,3)=0.3, dist(1,3)=0.5.
  writeFileSync(clustersPath, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 3, label: null, sample: 'p1.jpg' },
    { id: 2, centroid: [0.2, 0, 0], count: 2, label: null, sample: 'p2.jpg' },
    { id: 3, centroid: [0.5, 0, 0], count: 1, label: null, sample: 'p3.jpg' },
  ]));
  // None of these clusters is ever labeled, so a photo's actual PAYLOAD (pictured stays [],
  // faces_detected unchanged, text_repr unaffected by which cluster id it's filed under) never
  // truly changes here — only the local `clusters` id array does. Pre-matching `ingestedSig` to
  // that (precomputed, never-changing) payload signature for p1/p3/p4 means those entries are
  // still remap CANDIDATES (asserted below) but make no real ingest call, leaving only p2 and p5
  // to actually hit the mock server — keeps this test's real network-call count low (a handful of
  // sequential fetch() calls followed by process.exit(0) is its own separate, environment-level
  // flake on this box's Node/Windows combination, unrelated to #342's logic under test here).
  const noopSig = (filename, faces) => JSON.stringify({ e: { captioned: false, faces_detected: faces, pictured: [] }, h: null, t: `Photo: ${filename}` });
  writeFileSync(facesPath, JSON.stringify({
    'p1.jpg': { source: 'photo-exif', source_id: 'h1', statKey: 'x', faces: 1, clusters: [1], dateStr: null, ingestedSig: noopSig('p1.jpg', 1) },
    'p2.jpg': { source: 'photo-exif', source_id: 'h2', statKey: 'x', faces: 1, clusters: [2], dateStr: null, ingestedSig: null },
    'p3.jpg': { source: 'photo-exif', source_id: 'h3', statKey: 'x', faces: 1, clusters: [3], dateStr: null, ingestedSig: noopSig('p3.jpg', 1) },
    // Multi-face photos whose faces land in clusters that all converge on the SAME survivor —
    // must dedupe to a single-element array, not carry duplicate/stale ids.
    'p4.jpg': { source: 'photo-exif', source_id: 'h4', statKey: 'x', faces: 2, clusters: [1, 2], dateStr: null, ingestedSig: noopSig('p4.jpg', 2) },
    'p5.jpg': { source: 'photo-exif', source_id: 'h5', statKey: 'x', faces: 2, clusters: [2, 3], dateStr: null, ingestedSig: null },
  }));

  const { server, port } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 0 }));
  });
  const apply = await run('face-worker.js', {
    LIFECONTEXT_API_KEY: 'test-key',
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersPath,
    PHOTO_EXIF_FACE_STATE_PATH: facesPath,
    // 2 merges / 3 clusters = 67%, over the default 50% guard — this test is about remapping, not
    // the guard (which has its own dedicated test below), so force past it.
  }, ['merge-clusters', '--threshold', '1.0', '--apply', '--force']);
  server.closeAllConnections();
  server.close();
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stderr, /applied 2 merge\(s\), remapped 4 photo entr\(ies\)/, 'p1 was already survivor-1 and is not counted as remapped');

  const finalClusters = parseClustersFile(readFileSync(clustersPath, 'utf8')).clusters;
  assert.equal(finalClusters.length, 1, 'all three clusters converged into one survivor');
  const liveIds = new Set(finalClusters.map((c) => c.id));
  assert.deepEqual([...liveIds], [1]);
  assert.deepEqual(finalClusters[0].merged_from.slice().sort(), [2, 3]);

  const finalFaces = JSON.parse(readFileSync(facesPath, 'utf8'));
  for (const relPath of ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg', 'p5.jpg']) {
    const clusters = finalFaces[relPath].clusters;
    assert.deepEqual(clusters, [1], `${relPath}: expected exactly the surviving id, deduped`);
    for (const id of clusters) assert.ok(liveIds.has(id), `${relPath} references live cluster ${id} — no dangling reference`);
  }
});

test('face-worker.js merge-clusters --apply: refuses to merge differently-labeled clusters (untouched), an unlabeled survivor inherits an absorbed label and re-emits it, survivor records merged_from (#342)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-labels-'));
  const clustersPath = path.join(tmp, 'clusters.json');
  const facesPath = path.join(tmp, 'faces.json');
  writeFileSync(clustersPath, serializeClustersFile(1, [
    { id: 1, centroid: [0.05, 0, 0], count: 2, label: null, sample: 'amy1.jpg' },
    { id: 2, centroid: [0, 0, 0], count: 5, label: 'Amy Fenwick', sample: 'amy2.jpg' }, // dist(1,2) = 0.05 -> merges, 1 inherits the label
    { id: 3, centroid: [0.2, 0, 0], count: 4, label: 'Beth Allister', sample: 'beth.jpg' }, // refused against both 2 and the survivor
  ]));
  writeFileSync(facesPath, JSON.stringify({
    'amy1.jpg': { source: 'photo-exif', source_id: 'ha1', statKey: 'x', faces: 1, clusters: [1], dateStr: null, ingestedSig: null },
    'amy2.jpg': { source: 'photo-exif', source_id: 'ha2', statKey: 'x', faces: 1, clusters: [2], dateStr: null, ingestedSig: null },
    'beth.jpg': { source: 'photo-exif', source_id: 'hb', statKey: 'x', faces: 1, clusters: [3], dateStr: null, ingestedSig: null },
  }));

  const requests = [];
  const { server, port } = await startMockServer((req, body, res) => {
    requests.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 1, unresolved_aliases: 0 }));
  });
  const apply = await run('face-worker.js', {
    LIFECONTEXT_API_KEY: 'test-key',
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersPath,
    PHOTO_EXIF_FACE_STATE_PATH: facesPath,
  }, ['merge-clusters', '--threshold', '1.0', '--apply']);
  server.closeAllConnections();
  server.close();
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stderr, /refuse — 1 \+ 3 both labeled \("Amy Fenwick" \/ "Beth Allister"\), skipped/, 'the survivor that inherited the label is named in a refusal against cluster 3');
  assert.match(apply.stderr, /refuse — 2 \+ 3 both labeled \("Amy Fenwick" \/ "Beth Allister"\), skipped/, 'the original label-2/label-3 pair is also named');

  const finalClusters = parseClustersFile(readFileSync(clustersPath, 'utf8')).clusters;
  assert.equal(finalClusters.length, 2, 'cluster 3 was never touched');
  const survivor = finalClusters.find((c) => c.id === 1);
  assert.equal(survivor.label, 'Amy Fenwick', 'the unlabeled survivor inherited the absorbed cluster\'s label');
  assert.deepEqual(survivor.merged_from, [2]);
  const untouched = finalClusters.find((c) => c.id === 3);
  assert.equal(untouched.label, 'Beth Allister');
  assert.equal(untouched.count, 4, 'refused cluster is completely untouched');

  // amy1.jpg was in the unlabeled cluster pre-merge (no pictured hint) and must now re-emit one;
  // beth.jpg's cluster never changed, so it must not be re-sent at all.
  const amy1Req = requests.find((r) => r.source_id === 'ha1');
  assert.ok(amy1Req, 'amy1.jpg (newly labeled via the merge) was re-emitted');
  assert.deepEqual(amy1Req.entity_hints, [{ alias: 'Amy Fenwick', alias_type: 'name', role: 'pictured', confidence: 0.6 }]);
  assert.match(amy1Req.text_repr, /Pictured: Amy Fenwick\.$/);
  assert.ok(!requests.some((r) => r.source_id === 'hb'), 'beth.jpg (cluster 3, untouched) was never re-emitted');
});

test('face-worker.js merge-clusters --apply: --max-merge-fraction guard refuses an over-broad merge (exit 1, no writes) unless --force (#342)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-guard-'));
  const clustersPath = path.join(tmp, 'clusters.json');
  const facesPath = path.join(tmp, 'faces.json');
  // 5 mutually-close, unlabeled clusters: a threshold of 1.0 chains all 5 into ONE survivor (4
  // merges / 5 clusters = 80% collapse), well past the default 50% guard.
  writeFileSync(clustersPath, serializeClustersFile(1, [
    { id: 1, centroid: [0.0, 0, 0], count: 1, label: null, sample: null },
    { id: 2, centroid: [0.1, 0, 0], count: 1, label: null, sample: null },
    { id: 3, centroid: [0.2, 0, 0], count: 1, label: null, sample: null },
    { id: 4, centroid: [0.3, 0, 0], count: 1, label: null, sample: null },
    { id: 5, centroid: [0.4, 0, 0], count: 1, label: null, sample: null },
  ]));
  writeFileSync(facesPath, JSON.stringify({}));
  const beforeClusters = readFileSync(clustersPath, 'utf8');
  const beforeFaces = readFileSync(facesPath, 'utf8');
  const env = { LIFECONTEXT_API_KEY: 'test-key', PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersPath, PHOTO_EXIF_FACE_STATE_PATH: facesPath };

  // Without --force: refuses, exits 1, writes nothing (not even a backup).
  const refused = await run('face-worker.js', { ...env, LIFECONTEXT_URL: 'http://127.0.0.1:1' }, ['merge-clusters', '--threshold', '1.0', '--apply']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refused: would collapse 80% of clusters \(> --max-merge-fraction 0\.5\); re-run with --force to override/);
  assert.equal(readFileSync(clustersPath, 'utf8'), beforeClusters, 'guard refusal writes nothing to the clusters file');
  assert.equal(readFileSync(facesPath, 'utf8'), beforeFaces, 'guard refusal writes nothing to the face-state file');
  assert.ok(!existsSync(path.join(tmp, 'merge-backups')), 'guard refusal writes no backup either');

  // With --force: proceeds.
  const { server, port } = await startMockServer((req, body, res) => res.end(JSON.stringify({ id: 1, created: false })));
  const forced = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['merge-clusters', '--threshold', '1.0', '--apply', '--force']);
  server.closeAllConnections();
  server.close();
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /applied 4 merge\(s\)/);
  const finalClusters = parseClustersFile(readFileSync(clustersPath, 'utf8')).clusters;
  assert.equal(finalClusters.length, 1, '--force overrides the guard and the merge proceeds');
});

test('face-worker.js merge-clusters: no clusters yet exits cleanly (0) without touching anything', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-empty-'));
  const res = await run('face-worker.js', {
    PHOTO_EXIF_FACE_CLUSTERS_PATH: path.join(tmp, 'does-not-exist-clusters.json'),
  }, ['merge-clusters', '--threshold', '1.0']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no clusters \(run scan first\)/);
});
