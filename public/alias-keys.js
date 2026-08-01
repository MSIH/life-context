// Display-side alias/attrs match key (#334). Mirrors — does NOT call — normalizePhone/normalizeName
// in src/db.js: entity_aliases stores the server-normalized value while attrs holds the raw string
// the user typed, so the UI needs the same compare key to tell "this alias IS this attrs value"
// apart from "these are two different values that happen to render similarly". Every write still
// goes through the server's authoritative normalization; this is read-only, for the ✕ branch in
// renderAliases (public/app.js). Zero DOM references so it's importable from a plain `node --test`.

// Mirrors normalizePhone (src/db.js): digit-strip, then drop a leading '1' on an 11-digit NANP number.
function phoneKey(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  return /^1\d{10}$/.test(d) ? d.slice(1) : d;
}

// Mirrors normalizeName (src/db.js): trim + lowercase.
function nameKey(s) {
  return String(s ?? '').trim().toLowerCase();
}

// aliasMatchKey(value, aliasType) -> normalized compare key, '' if unusable.
export function aliasMatchKey(value, aliasType) {
  if (value == null) return '';
  return aliasType === 'phone' ? phoneKey(value) : nameKey(value);
}

// looksLikeEmailOrPhone(value) -> 'email' | 'phone' | null. Used to refuse a mis-typed email/phone
// at the alias add box (Defect 2) — never to auto-classify a real alias write.
export function looksLikeEmailOrPhone(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  // Digits/punctuation-only (spaces, dashes, parens, dots, a leading +) with >= 7 digits — enough to
  // catch a formatted phone number while leaving names/handles (which contain letters) alone.
  if (/^[\d\s().+-]+$/.test(v) && (v.match(/\d/g) || []).length >= 7) return 'phone';
  return null;
}
