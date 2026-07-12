// lib/dedup.js — Deduplication hash
//
// Computes a SHA-256 hash of normalised post text + first image URL.
// The same listing posted to multiple groups will produce the same hash,
// letting us mark cross-group reposts as duplicates without deleting them.
//
// Used exclusively in background.js (which has access to the correct IndexedDB).

// Lowercase, collapse whitespace, take first 500 chars.
function normalise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

// SHA-256 via the built-in Web Crypto API. Available in service workers and
// extension pages. Returns a lowercase hex string.
async function sha256(str) {
  const bytes  = new TextEncoder().encode(str);
  const buf    = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeDedupHash({ text, image_urls }) {
  const input = normalise(text) + '|||' + (image_urls?.[0] ?? '');
  return sha256(input);
}

// Return the first N words of text as a normalised, space-joined string, or
// null when the text is too short to be meaningful (< 3 words).
// Used as a near-duplicate key: two posts sharing the same opening words are
// almost certainly the same listing reposted with minor edits.
export function computePrefixKey(text, n = 10) {
  const words = (text || '')
    .replace(/[֑-ׇ]/g, '')                              // Hebrew nikud
    .replace(/[^א-תװ-״A-Za-z0-9]+/g, ' ')   // keep Hebrew + alphanum
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0);
  if (words.length < 3) return null;
  return words.slice(0, n).join(' ');
}
