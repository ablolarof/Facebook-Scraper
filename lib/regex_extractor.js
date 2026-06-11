// lib/regex_extractor.js
//
// Regex-based structured tag extractor and classifier for rental posts.
// Runs entirely in the browser — no API calls, no rate limits.
//
// Tag schema (also used as the post.tags shape in IndexedDB):
//   { price, rooms, size, entry_date, roommates, broker }
//
// Usage (from dashboard.js / background.js):
//   import { regexExtractTags, mergeWithRegex, regexClassifyPost }
//     from '../lib/regex_extractor.js';

// ── Internal helpers ───────────────────────────────────────────────────────────

function parseNum(s) {
  const str = String(s).replace(/,/g, '');
  // Dot-as-thousands-separator: "7.800" → 7800, "12.500" → 12500.
  // Only fires when exactly three digits trail the dot (safe against "7.5").
  return parseFloat(str.replace(/\.(\d{3})$/, '$1'));
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
//   שכ"ד 12,500 | שכ״ד 12500   (שכר דירה — rent payment, label before number)
//   שכר דירה 4,500             (full שכר דירה form, not abbreviated)
//   לחודש 3,200                (monthly price stated after לחודש)
//   7.800 ש׳׳ח                 (dot-thousands separator; double-geresh shekel)
//   מחיר 7,000 | מחיר מבוקש 14,000  (asking price label before number)
//   6,500 כולל                 (bare number immediately before כולל)
//
// ״ = Hebrew gershayim  (the typographically correct quote in ש״ח / שכ״ד)
// ׳׳ = two geresh chars  (common Facebook variant for ש״ח)
// We also accept plain ASCII " and smart-quote variants.
// Numbers use [\d,.]+ to capture dot-thousands (7.800); parseNum() normalises.

const PRICE_RE  = /₪\s*([\d,.]+)|([\d,.]+)\s*(?:₪|ש[״"'`׳]{0,2}ח|שח|שקל(?:ים)?)|שכ[״"'`""׳]?ד\s*([\d,.]+)|לחודש\s*([\d,.]+)|שכר\s+דירה\s*([\d,.]+)|מחיר[:\s]+(?:מבוקש[:\s]+)?([\d,.]+)|([\d,.]+)\s*כולל/g;
const PRICE_MIN = 1500;
const PRICE_MAX = 40000;

function extractPrice(text) {
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7];
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

const ROOMS_RE      = /(\d+(?:[.,]\d+)?)\s*(?:חדר(?:ים)?|חד[״׳"'""''.]?(?:ר)?)/g;
const STUDIO_RE     = /(?:סטודיו|studio)/i;
const ONE_ROOM_RE   = /חדר\s+אחד|\b1\s+(?:חדר|חד)/;

const HEB_NUM_WORDS = { 'שניים': 2, 'שתיים': 2, 'שלושה': 3, 'שלוש': 3, 'ארבעה': 4, 'ארבע': 4, 'חמישה': 5, 'חמש': 5 };
const ROOMS_WORD_RE = new RegExp('(' + Object.keys(HEB_NUM_WORDS).join('|') + ')\\s+חדר(?:ים)?');

function extractRooms(text) {
  if (STUDIO_RE.test(text)) return 1;
  if (ONE_ROOM_RE.test(text)) return 1;
  const wm = ROOMS_WORD_RE.exec(text);
  if (wm) return HEB_NUM_WORDS[wm[1]];
  for (const m of text.matchAll(ROOMS_RE)) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (n >= 1 && n <= 20) return n;
  }
  return null;
}

// ── Size ──────────────────────────────────────────────────────────────────────
//
// Handles: 80 מ"ר | 80 מ'ר | 80מ"ר | 80 sqm | 80 מטר רבוע

// {1,2} handles doubled-geresh variants like מ׳׳ר; ″ = DOUBLE PRIME ″
const SIZE_RE  = /(\d+)\s*(?:מ[״׳"'""'″]{1,2}ר|מר(?![א-ת])|מטר(?:\s+רבוע)?(?!\s+\d)|sqm)/gi;
const SIZE_MIN = 10;
const SIZE_MAX = 1000;

function extractSize(text) {
  for (const m of text.matchAll(SIZE_RE)) {
    const n = parseInt(m[1], 10);
    if (n >= SIZE_MIN && n <= SIZE_MAX) return n;
  }
  return null;
}

// ── Broker ────────────────────────────────────────────────────────────────────
//
// Check NO-broker patterns before YES-broker to avoid "ללא תיווך"
// being caught by the broker positive pattern.
//
// false: ללא תיווך | ללא עמלת תיווך | אין תיווך | בלי תיווך | ישיר מבעל | ...
// true:  דמי תיווך | עמלת תיווך | מתיווך | שיווק נדל"ן | תיווך (bare)
// null:  anything else
//
// NO_BROKER_RE is checked first so "ללא עמלת תיווך" / "אין תיווך" are caught
// before the bare-תיווך positive fires.

const NO_BROKER_RE = /ללא\s+(?:כל\s+)?(?:דמי\s+|עמלת\s+)?תיווך|אין\s+(?:דמי\s+|עמלת\s+)?תיווך|בלי\s+(?:דמי\s+|עמלת\s+)?תיווך|לא\s+מתיווך|ישיר(?:ות)?\s+מ(?:ה?בעל|ה?דייר|ה?משכיר)|פרטי\s+(?:מ(?:בעל|משכיר|דייר))|no\s+(?:broker|fee|commission)|owner\s+only/i;
const BROKER_RE    = /דמי\s+תיווך|עמלת\s+תיווך|מתיווך|שיווק\s+נדל[״"'""׳]?ן|תיווך|תווך/;

function extractBroker(text) {
  if (NO_BROKER_RE.test(text)) return false;
  if (BROKER_RE.test(text))    return true;
  return null;
}

// ── Roommates ─────────────────────────────────────────────────────────────────
//
// true  = post explicitly seeks a roommate to JOIN an existing shared flat
// false = no roommate signal found — assume whole-apartment rental
//
// We default to false rather than null: the absence of roommate keywords in a
// rental post reliably indicates a whole-apartment listing. Posts that do seek
// roommates always use recognisable Hebrew/English terms.

// נשאר/נשארים + שותפ* covers "נשארים 2 שותפים" (existing roommates staying)
// (?:\d+\s+)? before שותפ covers "דירת 2 שותפות" (number between דירת and שותפ)
const ROOMMATES_RE = /(?:מחפש(?:ת|ות|ים)?|דרוש(?:ה)?|מוצע)\s+שות|מחפש(?:ת|ות|ים)?\s+מחליפ|דירת\s+(?:\d+\s+)?שותפ|שותפ(?:ים|ף|ה)?\s+ל(?:דירה|חדר)|נשאר(?:ת|ים)?\s+(?:\d+\s+)?שות|roommate\s+(?:wanted|needed|sought)|looking\s+for\s+(?:a\s+)?roommate|flatmate/i;

function extractRoommates(text) {
  return ROOMMATES_RE.test(text) ? true : false;
}

// ── Entry date ────────────────────────────────────────────────────────────────
//
// Returns 'immediate' or a 'YYYY-MM-DD' string, or null.

const IMMEDIATE_RE  = /מיידי|פנוי\s+עכשיו|זמין\s+(?:עכשיו|מיידי)|immediately|immediate(?:\s+entry)?|available\s+now/i;
const DATE_ISO_RE         = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DATE_SLASH_RE       = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g;
// 2-digit year variant: "1.8.26" → 1 Aug 2026. Processed after the 4-digit
// variant so full years take priority. yy is interpreted as 2000 + yy.
const DATE_SLASH_SHORT_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{2})\b/g;
// Month-range with כניסה: "כניסה 6-7.2026" → first month, day = 1.
// Captures the start month so we return the earliest plausible entry date.
const DATE_RANGE_ENTRY_RE = /כניסה\s+(\d{1,2})-\d{1,2}[./](\d{4})/g;
// Day/month without year after כניסה, handling these variants:
//   "כניסה 15/6"    (space + digit)
//   "כניסה: 1.7"   (colon then digit)
//   "כניסה ב1.7"   (ב prefix directly before digit)
//   "כניסה ב-18.07" (ב + maqaf/hyphen before digit)
// Negative lookahead prevents matching when a full year follows (DATE_SLASH_RE covers that).
const DATE_NO_YEAR_RE = /כניסה[:\s]\s*(?:ב[-]?)?(\d{1,2})[./](\d{1,2})(?![./\d])/g;

const HEB_MONTHS = {
  'ינואר': 1, 'פברואר': 2, 'מרץ': 3,     'אפריל': 4,
  'מאי':   5, 'יוני':   6, 'יולי': 7,    'אוגוסט': 8,
  'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
};

const HEB_DATE_RE = new RegExp(
  '\\b(\\d{1,2})\\s+(?:ל|ב)(' + Object.keys(HEB_MONTHS).join('|') + ')(?:\\s+(\\d{4}))?',
  'g'
);

// Month name without a specific day: "בסוף אוגוסט" | "בתחילת יולי" → day = 1.
const DATE_APPROX_MONTH_RE = new RegExp(
  '(?:בסוף|בתחילת|תחילת|סוף)\\s+(' + Object.keys(HEB_MONTHS).join('|') + ')(?:\\s+(\\d{4}))?',
  'g'
);

// Day/month without year after מתפנה: "מתפנה ב1/9" → September 1.
const DATE_AVAIL_NO_YEAR_RE = /מתפנ(?:ה|ת|ים|ות)\s+ב[-]?(\d{1,2})[./](\d{1,2})(?![./\d])/g;

// Month name after entry keywords: "כניסה בחודש יולי" | "כניסה בספטמבר" | "שייכנסו לחוזה באוגוסט" → day = 1.
const DATE_MONTH_ENTRY_RE = new RegExp(
  '(?:כניסה\\s+(?:ב(?:חודש\\s+)?)?|מתפנ(?:ה|ת|ים|ות)\\s+ב|שייכנסו\\s+לחוזה\\s+ב)(' + Object.keys(HEB_MONTHS).join('|') + ')(?:\\s+(\\d{4}))?',
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

  for (const m of text.matchAll(DATE_SLASH_SHORT_RE)) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = 2000 + parseInt(m[3], 10);
    if (isPlausibleDate(y, mo, d)) return toISO(y, mo, d);
  }

  for (const m of text.matchAll(DATE_RANGE_ENTRY_RE)) {
    const mo = parseInt(m[1], 10), y = parseInt(m[2], 10);
    if (isPlausibleDate(y, mo, 1)) return toISO(y, mo, 1);
  }

  for (const m of text.matchAll(DATE_NO_YEAR_RE)) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    const y = (mo > currentMonth || (mo === currentMonth && d >= now.getDate()))
      ? currentYear
      : currentYear + 1;
    if (isPlausibleDate(y, mo, d)) return toISO(y, mo, d);
  }

  for (const m of text.matchAll(DATE_AVAIL_NO_YEAR_RE)) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    const y = (mo > currentMonth || (mo === currentMonth && d >= now.getDate()))
      ? currentYear
      : currentYear + 1;
    if (isPlausibleDate(y, mo, d)) return toISO(y, mo, d);
  }

  for (const m of text.matchAll(DATE_APPROX_MONTH_RE)) {
    const month = HEB_MONTHS[m[1]];
    let year    = m[2] ? parseInt(m[2], 10) : currentYear;
    if (!m[2] && month < currentMonth) year++;
    if (isPlausibleDate(year, month, 1)) return toISO(year, month, 1);
  }

  for (const m of text.matchAll(DATE_MONTH_ENTRY_RE)) {
    const month = HEB_MONTHS[m[1]];
    let year    = m[2] ? parseInt(m[2], 10) : currentYear;
    if (!m[2] && month < currentMonth) year++;
    if (isPlausibleDate(year, month, 1)) return toISO(year, month, 1);
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
// Quick rental/not-rental signal detection.
// Returns null when the text is ambiguous — the user labels those manually.
//
// RENTAL:     להשכרה | לשכירות | שכירות | for rent | (price) לחודש
// NOT_RENTAL: למכירה | קנייה | for sale | מוכר/ת + apt word
//
// Conservative: when in doubt return null rather than risk a wrong
// classification that forces manual correction.

// Strong rental signals:
//   שכ"ד / שכ״ד          — abbreviation for שכר דירה, only used in rental context
//   מתפנה/מתפנים + יחידה  — "a unit/room is becoming available" (optional number prefix)
//   מפנה את הדירה/הבית    — "vacating my apartment/house" (active form)
//   מחפש/ת מחליפ          — "looking for a replacement [tenant]"
//   מחיר + 4-digit number — bare asking price (e.g. "מחיר 9500", "מחיר מבוקש 14,000")
const RENTAL_RE = /להשכרה|לשכירות|שכירות|להשכיר|שכ[״"'`׳]?ד|מתפנ(?:ה|ת|ים|ות)\s+(?:\d+\s+)?(?:דירה|חדר|יחידה)|מפנ(?:ה|ים|ות)\s+(?:את\s+)?ה?(?:דירה|בית|חדר)|מחפש(?:ת|ים)?\s+מחליפ|מחפש(?:ת|ות|ים)?\s+דיר|סאבלט|כניסה\s+מיידית|מחיר[:\s]+(?:מבוקש[:\s]+)?[\d,]{4,}|for\s+rent(?:al)?(?:\s|$)|available\s+for\s+rent/i;

// Price per month: "5,500 שח לחודש" / "₪5000 לחודש" / "9,000 ₪ בחודש"
// (?:ל|ב) catches both "לחודש" and "בחודש" (common in Hebrew rental posts)
const MONTHLY_PRICE_RE = /\d[\d,]*\s*(?:₪|ש[״"'`]?ח|שח)?\s*(?:ל|ב)(?:כל\s+)?חודש/;

// Strong not-rental signals
const NOT_RENTAL_RE  = /למכירה|למכור|for\s+sale(?:\s|$)|קני[יה]ה?(?:\s|$)|לקנות\s+(?:דירה|נכס|בית)/i;
const NOT_RENTAL_RE2 = /מוכר(?:ת|ים|ות)?\s+(?:דירה|נכס|בית|דו-?משפחתי)/i;

/**
 * Attempt to classify a post as 'rental' or 'not_rental' using regex alone.
 * Falls back to 'not_rental' when no rental signal is found — ambiguous posts
 * can be manually re-labeled in the dashboard if needed.
 *
 * @param  {string} text  Raw post text.
 * @returns {'rental'|'not_rental'|null}
 */
export function regexClassifyPost(text) {
  if (!text) return null;
  if (NOT_RENTAL_RE.test(text) || NOT_RENTAL_RE2.test(text)) return 'not_rental';
  if (RENTAL_RE.test(text) || MONTHLY_PRICE_RE.test(text))   return 'rental';
  return 'not_rental';
}

// ── Tag extraction ────────────────────────────────────────────────────────────

/**
 * Extract structured tags from a rental post's text using regex only.
 *
 * Returns the canonical post.tags object shape, stored directly into IndexedDB
 * without further transformation.
 *
 * @param  {string} text  The raw post text.
 * @returns {{ price, rooms, size, roommates, broker, entry_date } | null}
 */
export function regexExtractTags(text) {
  if (!text) return null;
  return {
    price:      extractPrice(text),
    rooms:      extractRooms(text),
    size:       extractSize(text),
    roommates:  extractRoommates(text),
    broker:     extractBroker(text),
    entry_date: extractEntryDate(text),
  };
}

/**
 * Merge existing tags (e.g. from a previous extraction run) with fresh regex results.
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
    roommates:  regexTags.roommates  ?? b.roommates  ?? null,
    broker:     regexTags.broker     ?? b.broker     ?? null,
    entry_date: regexTags.entry_date ?? b.entry_date ?? null,
  };
}
