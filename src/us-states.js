/**
 * US state (+ DC) name<->USPS-code map and a single normalizer (#186). One source of truth
 * imported by src/geocode.js (region-canonical comparison), scripts/build-places.js (emit full
 * names into places.json), and src/search.js (expand a state place-term to both label forms).
 *
 * Pure data — no fs, no network — so importing it never triggers I/O or a circular places.json
 * read. GeoNames' US admin1 column already *is* the USPS abbreviation (e.g. "TX"), which is what
 * lets `normalizeUsState(admin1Code)` map straight to the full state name.
 */

// Full name -> USPS code (50 states + DC). DC is included because GeoNames carries a "DC" admin1.
const NAME_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

// Code -> full name (title-cased), derived from the map above so there's one list to maintain.
// The `Of`->`of` fixup keeps "District of Columbia" correctly cased (the one connector word).
const CODE_TO_NAME = Object.fromEntries(
  Object.entries(NAME_TO_CODE).map(([name, code]) => [
    code,
    name.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bOf\b/g, 'of'),
  ]),
);

/**
 * Resolve a US state given EITHER a full name ("Texas", "texas", "TEXAS") or a USPS code
 * ("TX", "tx"), case-insensitive and trimmed. Returns { code, name } or null for anything that
 * isn't a US state (unknown string, empty, non-string, a non-US GeoNames region code).
 */
export function normalizeUsState(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  const code = s.length === 2 ? s.toUpperCase() : NAME_TO_CODE[s.toLowerCase()];
  const name = code ? CODE_TO_NAME[code] : null;
  return name ? { code, name } : null;
}

export { NAME_TO_CODE, CODE_TO_NAME };
