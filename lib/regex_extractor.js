// lib/regex_extractor.js
//
// Regex-based structured tag extractor and classifier for rental posts.
// Runs entirely in the browser — no API calls, no rate limits.
//
// Tag schema (also used as the post.tags shape in IndexedDB):
//   { price, rooms, size, neighborhood, neighborhood_confidence,
//     neighborhood_evidence, entry_date, roommates, broker }
//
// Usage (from dashboard.js / background.js):
//   import { regexExtractTags, mergeWithRegex, regexClassifyPost }
//     from '../lib/regex_extractor.js';

import { NEIGHBORHOOD_OVERRIDES } from './neighborhood_overrides.js';

// ── Internal helpers ───────────────────────────────────────────────────────────

function parseNum(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

function toISO(year, month, day) {
  return (
    String(year).padStart(4, '0') + '-' +
    String(month).padStart(2, '0') + '-' +
    String(day).padStart(2, '0')
  );
}

function isPlausibleDate(year, month, day) {
  const cy = new Date().getFullYear();
  if (year < cy || year > cy + 2) return false;
  if (month < 1 || month > 12)    return false;
  if (day   < 1 || day   > 31)    return false;
  return true;
}

// ── Price ─────────────────────────────────────────────────────────────────────
//
// Handles all common Israeli rental price formats:
//   ₪5,500 | 5,500₪ | 5500 ש"ח | 5500 ש״ח | 5500 שח | 5,500 שקל(ים)
//
// ״ = Hebrew gershayim ״  (the typographically correct quote in ש״ח)
// We also accept the plain ASCII " that people often type instead.

const PRICE_RE  = /₪\s*([\d,]+)|([\d,]+)\s*(?:₪|ש[״"'`]?ח|שח|שקל(?:ים)?)/g;
const PRICE_MIN = 1500;
const PRICE_MAX = 40000;

function extractPrice(text) {
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[1] ?? m[2];
    const n   = parseNum(raw);
    if (n >= PRICE_MIN && n <= PRICE_MAX) return n;
  }
  return null;
}

// ── Rooms ─────────────────────────────────────────────────────────────────────
//
// Handles: 3 חדרים | 2.5 חד' | 3.5 חד"ר | 4ח' | studio | סטודיו | חדר אחד
//
// Decimal separator can be . or , (e.g. "2,5 חדרים" is common in Hebrew text).
// Punctuation after חד can be: ' " ״ ׳ . or nothing.

const ROOMS_RE      = /(\d+(?:[.,]\d+)?)\s*(?:חדר(?:ים)?|חד[״׳"'.]?(?:ר)?)/g;
const STUDIO_RE     = /(?:סטודיו|studio)/i;
const ONE_ROOM_RE   = /חדר\s+אחד|\b1\s+(?:חדר|חד)/;

function extractRooms(text) {
  if (STUDIO_RE.test(text)) return 1;
  if (ONE_ROOM_RE.test(text)) return 1;
  for (const m of text.matchAll(ROOMS_RE)) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (n >= 1 && n <= 20) return n;
  }
  return null;
}

// ── Size ──────────────────────────────────────────────────────────────────────
//
// Handles: 80 מ"ר | 80 מ'ר | 80מ"ר | 80 sqm | 80 מטר רבוע

const SIZE_RE  = /(\d+)\s*(?:מ[״׳"']ר|מטר(?:\s+רבוע)?(?!\s+\d)|sqm)/gi;
const SIZE_MIN = 10;
const SIZE_MAX = 1000;

function extractSize(text) {
  for (const m of text.matchAll(SIZE_RE)) {
    const n = parseInt(m[1], 10);
    if (n >= SIZE_MIN && n <= SIZE_MAX) return n;
  }
  return null;
}

// ── Neighborhood ──────────────────────────────────────────────────────────────
//
// Reuses the same NEIGHBORHOOD_OVERRIDES map as gemini.js, so results are
// identical to Gemini's override pass. Confidence is always "high".

function extractNeighborhood(text) {
  const lower = text.toLowerCase();
  for (const [key, canonical] of Object.entries(NEIGHBORHOOD_OVERRIDES)) {
    if (lower.includes(key.toLowerCase())) {
      return {
        neighborhood:            canonical,
        neighborhood_confidence: 'high',
        neighborhood_evidence:   key,
      };
    }
  }
  return {
    neighborhood:            null,
    neighborhood_confidence: null,
    neighborhood_evidence:   null,
  };
}

// ── Broker ────────────────────────────────────────────────────────────────────
//
// Check NO-broker patterns before YES-broker to avoid "ללא תיווך"
// being caught by the broker positive pattern.
//
// false: ללא תיווך | בלי תיווך | ישיר מבעל | פרטי | no broker | owner only
// true:  דמי תיווך | עמלת תיווך | מתיווך
// null:  anything else

const NO_BROKER_RE = /ללא\s+(?:דמי\s+)?תיווך|בלי\s+(?:דמי\s+)?תיווך|ישיר(?:ות)?\s+מ(?:ה?בעל|ה?דייר|ה?משכיר)|פרטי\s+(?:מ(?:בעל|משכיר|דייר))|no\s+(?:broker|fee|commission)|owner\s+only/i;
const BROKER_RE    = /דמי\s+תיווך|עמלת\s+תיווך|מתיווך/;

function extractBroker(text) {
  if (NO_BROKER_RE.test(text)) return false;
  if (BROKER_RE.test(text))    return true;
  return null;
}

// ── Roommates ─────────────────────────────────────────────────────────────────
//
// true  = post is someone seeking a roommate to JOIN an existing shared flat
// null  = anything else (we never infer false)

const ROOMMATES_RE = /(?:מחפש|מחפשת|דרוש|דרושה|מוצע)\s+שות|דירת\s+שותפ|שותפ(?:ים|ף|ה)?\s+ל(?:דירה|חדר)|roommate\s+(?:wanted|needed|sought)|looking\s+for\s+(?:a\s+)?roommate|flatmate/i;

function extractRoommates(text) {
  return ROOMMATES_RE.test(text) ? true : null;
}

// ── Entry date ────────────────────────────────────────────────────────────────
//
// Returns 'immediate' or a 'YYYY-MM-DD' string, or null.

const IMMEDIATE_RE  = /מיידי|פנוי\s+עכשיו|זמין\s+(?:עכשיו|מיידי)|immediately|immediate(?:\s+entry)?|available\s+now/i;
const DATE_ISO_RE   = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DATE_SLASH_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g;

const HEB_MONTHS = {
  'ינואר': 1, 'פברואר': 2, 'מרץ': 3,     'אפריל': 4,
  'מאי':   5, 'יוני':   6, 'יולי': 7,    'אוגוסט': 8,
  'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
};

const HEB_DATE_RE = new RegExp(
  '\\b(\\d{1,2})\\s+(?:ל|ב)(' + Object.keys(HEB_MONTHS).join('|') + ')(?:\\s+(\\d{4}))?',
  'g'
);

function extractEntryDate(text) {
  if (IMMEDIATE_RE.test(text)) return 'immediate';

  const now          = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  for (const m of text.matchAll(DATE_ISO_RE)) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (isPlausibleDate(y, mo, d)) return toISO(y, mo, d);
  }

  for (const m of text.matchAll(DATE_SLASH_RE)) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (isPlausibleDate(y, mo, d)) return toISO(y, mo, d);
  }

  for (const m of text.matchAll(HEB_DATE_RE)) {
    const day   = parseInt(m[1], 10);
    const month = HEB_MONTHS[m[2]];
    let year    = m[3] ? parseInt(m[3], 10) : currentYear;
    if (!m[3] && month < currentMonth) year++;
    if (isPlausibleDate(year, month, day)) return toISO(year, month, day);
  }

  return null;
}

// ── Classification ────────────────────────────────────────────────────────────
//
// Quick rental/not-rental signal detection used as a pre-filter before Gemini.
// Returns null when the text is ambiguous so Gemini can make the final call.
//
// RENTAL (high-confidence): להשכרה | לשכירות | שכירות | for rent | (price) לחודש
// NOT_RENTAL (high-confidence): למכירה | קנייה | for sale | מוכר/ת + apt word
//
// Conservative: when in doubt return null rather than risk a wrong
// classification that would block Gemini from running.

// Strong rental signals
const RENTAL_RE = /להשכרה|לשכירות|שכירות|להשכיר|for\s+rent(?:al)?(?:\s|$)|available\s+for\s+rent/i;

// Price per month: "5,500 שח לחודש" / "₪5000 לחודש"
const MONTHLY_PRICE_RE = /\d[\d,]*\s*(?:₪|ש[״"'`]?ח|שח)?\s*ל(?:כל\s+)?חודש/;

// Strong not-rental signals
const NOT_RENTAL_RE  = /למכירה|למכור|for\s+sale(?:\s|$)|קני[יה]ה?(?:\s|$)|לקנות\s+(?:דירה|נכס|בית)/i;
const NOT_RENTAL_RE2 = /מוכר(?:ת|ים|ות)?\s+(?:דירה|נכס|בית|דו-?משפחתי)/i;

/**
 * Attempt to classify a post as 'rental' or 'not_rental' using regex alone.
 * Returns null when the text is ambiguous — Gemini handles those.
 *
 * @param  {string} text  Raw post text.
 * @returns {'rental'|'not_rental'|null}
 */
export function regexClassifyPost(text) {
  if (!text) return null;
  if (NOT_RENTAL_RE.test(text) || NOT_RENTAL_RE2.test(text)) return 'not_rental';
  if (RENTAL_RE.test(text) || MONTHLY_PRICE_RE.test(text))   return 'rental';
  return null;
}

// ── Tag extraction ────────────────────────────────────────────────────────────

/**
 * Extract structured tags from a rental post's text using regex only.
 *
 * Returns the canonical post.tags object shape, stored directly into IndexedDB
 * without further transformation.
 *
 * @param  {string} text  The raw post text.
 * @returns {{ price, rooms, size, roommates, broker,
 *             neighborhood, neighborhood_confidence, neighborhood_evidence,
 *             entry_date } | null}
 */
export function regexExtractTags(text) {
  if (!text) return null;
  const { neighborhood, neighborhood_confidence, neighborhood_evidence } =
    extractNeighborhood(text);
  return {
    price:                   extractPrice(text),
    rooms:                   extractRooms(text),
    size:                    extractSize(text),
    roommates:               extractRoommates(text),
    broker:                  extractBroker(text),
    neighborhood,
    neighborhood_confidence,
    neighborhood_evidence,
    entry_date:              extractEntryDate(text),
  };
}

/**
 * Merge existing tags (e.g. from a prior Gemini run) with fresh regex results.
 *
 * Regex wins when it has a non-null answer; existing values fill the gaps.
 *
 * @param  {object|null} existingTags  The current post.tags (may be null).
 * @param  {object}      regexTags     Result of regexExtractTags().
 * @returns {object}
 */
export function mergeWithRegex(existingTags, regexTags) {
  const b = existingTags || {};
  return {
    price:                   regexTags.price                   ?? b.price                   ?? null,
    rooms:                   regexTags.rooms                   ?? b.rooms                   ?? null,
    size:                    regexTags.size                    ?? b.size                    ?? null,
    roommates:               regexTags.roommates               ?? b.roommates               ?? null,
    broker:                  regexTags.broker                  ?? b.broker                  ?? null,
    neighborhood:            regexTags.neighborhood            ?? b.neighborhood            ?? null,
    neighborhood_confidence: regexTags.neighborhood_confidence ?? b.neighborhood_confidence ?? null,
    neighborhood_evidence:   regexTags.neighborhood_evidence   ?? b.neighborhood_evidence   ?? null,
    entry_date:              regexTags.entry_date              ?? b.entry_date              ?? null,
  };
}
