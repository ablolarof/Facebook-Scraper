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

// Shared word-normaliser for the prefix/suffix keys. Strips two things the
// hash normaliser deliberately keeps:
//   - "See less" — a Facebook UI artifact that rides on one scraped copy of a
//     post but not another, breaking key equality between identical texts.
//   - phone-like digit runs (9+ digits/dashes/dots) — broker template reposts
//     differ ONLY by the agent's phone (and wa.me link), usually in the last
//     lines, which would defeat the suffix key.
function keyWords(text) {
  return (text || '')
    .replace(/see\s+less/gi, ' ')
    .replace(/\+?\d[\d\-.]{7,}\d/g, ' ')
    .replace(/[֑-ׇ]/g, '')                              // Hebrew nikud
    .replace(/[^א-תװ-״A-Za-z0-9]+/g, ' ')   // keep Hebrew + alphanum
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0);
}

// Return the first N words of text as a normalised, space-joined string, or
// null when the text is too short to be meaningful (< 3 words).
// Used as a near-duplicate key: two posts sharing the same opening words are
// almost certainly the same listing reposted with minor edits.
export function computePrefixKey(text, n = 10) {
  const words = keyWords(text);
  if (words.length < 3) return null;
  return words.slice(0, n).join(' ');
}

// Mirror of computePrefixKey over the LAST N words. Reposts typically edit
// the headline (defeating prefix_key) but keep the closing lines — location,
// conditions, contact — intact. Phones are stripped by keyWords, so the same
// broker template posted by two agents still collides here; the save-time
// check and the sweep then gate on whole-text similarity before marking.
export function computeSuffixKey(text, n = 10) {
  const words = keyWords(text);
  if (words.length < 3) return null;
  return words.slice(-n).join(' ');
}

// Normalise text to a token array (same character rules as computePrefixKey).
// Single-character tokens are dropped — they're mostly bullets and stray
// punctuation survivors that inflate similarity between unrelated posts.
export function tokenize(text) {
  return (text || '')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[^א-תװ-״A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1);
}

// Jaccard similarity between two texts' token SETS (0..1). Order-insensitive,
// so it catches reposts whose opening line changed (which defeats prefix_key).
// Used by the dashboard to pair a manually marked dupe with its original.
export function textSimilarity(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
