#!/usr/bin/env node
/**
 * `npm run geocode:build -- <path-to-cities1000.txt>` (the `--` forwards the path through npm
 * to this script) — regenerate src/geodata/places.json (issue #67) from a locally downloaded
 * GeoNames `cities1000.txt` dump (population >= 1000; not committed — download
 * https://download.geonames.org/export/dump/cities1000.zip and unzip it yourself).
 *
 * Country names come from Node's built-in `Intl.DisplayNames` (ICU/CLDR), not GeoNames'
 * own countryInfo.txt — one fewer raw file to source, and the output matches GeoNames'
 * wording closely enough ("South Korea", "Japan", ...) for a place_label.
 *
 * US rows get `region` as the full state NAME (#186): GeoNames' admin1 code column for the US
 * already *is* the USPS postal abbreviation (e.g. "TX"), which `normalizeUsState` maps to the
 * full name ("Texas") — so a query filter written as "texas" matches the stored label directly
 * (no admin1CodesASCII.txt join needed). Non-US admin1 codes aren't human-readable postal
 * abbreviations, so region stays null there, same as the dataset this replaces.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUsState } from '../src/us-states.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(repoRoot, 'src', 'geodata', 'places.json');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/build-places.js <path-to-cities1000.txt>');
  process.exit(1);
}

const countryName = new Intl.DisplayNames(['en'], { type: 'region' });

const lines = readFileSync(inputPath, 'utf8').split('\n');
const places = [];
let skipped = 0;

for (const line of lines) {
  if (!line) continue;
  // GeoNames cities dump columns (tab-separated): id, name, asciiname, alternatenames, lat,
  // lon, featureClass, featureCode, countryCode, cc2, admin1Code, admin2Code, admin3Code,
  // admin4Code, population, elevation, dem, timezone, modificationDate.
  const [, name, , , latRaw, lonRaw, , , countryCode, , admin1Code] = line.split('\t');
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  // Number.isFinite, not a truthiness check: a malformed/non-numeric field must be SKIPPED,
  // never silently written as NaN — JSON.stringify(NaN) serializes to `null`, which would sit
  // at (0,0) once read back by geocode.js's haversine loop (null coerces to 0 in arithmetic)
  // and could win as the "nearest" match for real queries near the equator/prime meridian.
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !countryCode) {
    skipped++;
    continue;
  }
  let country;
  try {
    country = countryName.of(countryCode) ?? countryCode;
  } catch {
    country = countryCode; // unmapped/future ISO code — fall back rather than break the build
  }
  places.push({
    city: name,
    // Full state name for US rows ("TX" -> "Texas"); fall back to the raw code if it's an
    // admin1 value normalizeUsState doesn't recognize, and null for non-US.
    region: countryCode === 'US' && admin1Code ? (normalizeUsState(admin1Code)?.name ?? admin1Code) : null,
    country,
    lat,
    lon,
  });
}

// Deterministic, diff-friendly ordering for a ~130k-entry file.
places.sort((a, b) => a.country.localeCompare(b.country) || a.city.localeCompare(b.city));

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `[\n${places.map((p) => `  ${JSON.stringify(p)}`).join(',\n')}\n]\n`);
console.error(`geocode:build — wrote ${places.length} places to ${OUT_PATH} (${skipped} rows skipped)`);
