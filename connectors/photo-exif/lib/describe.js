// Shared by scan.js and caption-worker.js so both build the exact same base description —
// drift here would mean the caption worker's "enriched" upsert contradicts the scanner's
// original text instead of extending it.
//
// This connector submits raw GPS only — it never resolves a place name itself. LifeContext
// core reverse-geocodes latitude/longitude into place_label server-side (issue #67), so this
// connector doesn't need its own bundled place dataset (and neither does any other connector
// that has GPS but no code of its own for describing where it is).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import { mediaType } from './shared.js';

// Per-directory cache of sidecar-candidate JSON filenames, populated lazily the first time a file
// in that directory needs the truncation-prefix fallback below. Keeps that fallback amortized to
// one readdir per directory (not per image) — a plain non-Takeout library pays only a negligible,
// once-per-folder cost. Process-lifetime cache: a connector run is short-lived.
const dirJsonCache = new Map();
function jsonNamesIn(dir) {
  let names = dirJsonCache.get(dir);
  if (names) return names;
  try {
    names = readdirSync(dir).filter((n) => {
      const low = n.toLowerCase();
      return low.endsWith('.json') && low !== 'metadata.json'; // metadata.json is the album's own, never a media sidecar
    });
  } catch {
    names = []; // unreadable dir → no truncation fallback here, not fatal
  }
  dirJsonCache.set(dir, names);
  return names;
}

// Resolve the Google Takeout sidecar path for a media file. Tries the known exact names first via
// cheap existsSync probes (the O(1) common path); only when all of those miss does it fall back to
// a per-directory scan for a length-truncated sidecar (Google caps filename length, so a long
// media name can get a sidecar whose stem is a truncated prefix). Naming variants observed across
// real exports:
//   "<file>.supplemental-metadata.json"          (2023+ common case)
//   "<file>.supplemental-meta.json"              (a truncated form of the above)
//   "<file>.json"                                (older exports)
//   "<stem><ext>.supplemental-metadata(N).json" / ".supplemental-meta(N).json" / "(N).json"
//                                                (for a duplicate media "<stem>(N)<ext>")
//   a name Google truncated to fit its filename cap (prefix fallback below)
// Returns abs path or null.
export function sidecarPathFor(absPath) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const candidates = [
    `${base}.supplemental-metadata.json`,
    `${base}.supplemental-meta.json`,
    `${base}.json`,
  ];
  const dup = base.match(/^(.*)\((\d+)\)(\.[^.]+)$/); // IMG_0503(1).HEIC -> IMG_0503.HEIC.supplemental-metadata(1).json
  if (dup) {
    const [, stem, n, ext] = dup;
    candidates.push(
      `${stem}${ext}.supplemental-metadata(${n}).json`,
      `${stem}${ext}.supplemental-meta(${n}).json`,
      `${stem}${ext}(${n}).json`,
    );
  }
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (existsSync(p)) return p;
  }
  // Truncation fallback: a sidecar whose stripped stem is a prefix of the media filename. The
  // length floor avoids matching an unrelated short-named sidecar in the same folder.
  for (const j of jsonNamesIn(dir)) {
    const stripped = j.replace(/\.supplemental-meta(data)?\.json$/i, '').replace(/\.json$/i, '');
    if (stripped.length >= 6 && base.startsWith(stripped)) return path.join(dir, j);
  }
  return null;
}

// Best-effort Google Takeout sidecar enrichment (#152). Returns { names, takenTime, latitude,
// longitude } or null when no sidecar is found. The connector submits names as entity_hints only —
// it never resolves entities itself (doc 04 §4). geoData {0,0} is Google's "no location" sentinel
// (~60% of a real export) and yields null coords, never a false (0,0). photoTakenTime is a unix-
// seconds string (UTC, zone-unambiguous). Any read/parse failure returns null — never throws.
export function readSidecar(absPath) {
  const file = sidecarPathFor(absPath);
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`photo-exif: unreadable sidecar ${path.basename(file)}`, err.message);
    return null;
  }
  const names = Array.isArray(data.people)
    ? data.people.map((p) => (typeof p?.name === 'string' ? p.name.trim() : '')).filter(Boolean)
    : [];
  const ts = Number(data.photoTakenTime?.timestamp);
  const takenTime = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null;
  const g = data.geoData ?? {};
  const hasGeo = typeof g.latitude === 'number' && typeof g.longitude === 'number'
    && !(g.latitude === 0 && g.longitude === 0);
  return { names, takenTime, latitude: hasGeo ? g.latitude : null, longitude: hasGeo ? g.longitude : null };
}

export async function describePhoto(absPath) {
  // exifr is an image parser (it never extracts EXIF/GPS from an mp4/mov/m4v/3gp container), so for a
  // video the whole readFile below would allocate O(fileSize) bytes only to yield the empty result.
  // Short-circuit videos before the read — walkMediaFiles feeds this both images and videos (#196).
  if (mediaType(path.basename(absPath)) === 'video') {
    return { date: null, dateStr: null, latitude: null, longitude: null };
  }
  // Hand exifr a Buffer, never a path: for a path input exifr opens an internal FileHandle it does
  // not always close (HEIC observed), and Node >=26 promotes a GC-closed FileHandle to a fatal
  // ERR_INVALID_STATE thrown asynchronously from the finalizer — the .catch()es below can't catch
  // it, so the whole scan aborts (#196). readFile owns and closes its own descriptor; an unreadable
  // file resolves to the same "no EXIF/GPS" result the exifr .catch() paths already produce.
  const buf = await readFile(absPath).catch(() => null);
  if (!buf) return { date: null, dateStr: null, latitude: null, longitude: null };
  // exifr resolves to undefined (not an error) when the file has no EXIF/GPS at all.
  const parsed = await exifr.parse(buf, { pick: ['DateTimeOriginal'] }).catch(() => undefined);
  const gps = await exifr.gps(buf).catch(() => undefined);
  const date = parsed?.DateTimeOriginal instanceof Date ? parsed.DateTimeOriginal : null;
  const dateStr = date ? date.toISOString().slice(0, 10) : null;
  return {
    date,
    dateStr,
    latitude: gps?.latitude ?? null,
    longitude: gps?.longitude ?? null,
  };
}

// `kind` is the artifact type ('photo' | 'video') so a video's embedded text isn't mislabeled
// "Photo …". Defaults to 'photo' (the caption worker only ever handles images).
export function buildTextRepr(dateStr, filename, kind = 'photo') {
  const noun = kind === 'video' ? 'Video' : 'Photo';
  if (dateStr) return `${noun} taken ${dateStr}`;
  return `${noun}: ${filename}`;
}
