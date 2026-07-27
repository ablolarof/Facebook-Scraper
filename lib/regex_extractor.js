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
//   6,500 לחודש | 2500 ללא     (number before לחודש / ללא [חשבונות])
//   ב-7600 !                   (price after ב- followed by exclamation)
//   שכ"ד: 6,750 | שכירות 6000 | דמי שכירות 5,500 | Rent: 4150
//                              (labeled rent — see LABELED_PRICE_RE below,
//                               checked first so it beats e.g. דמי ניהול)
//
// ״ = Hebrew gershayim  (the typographically correct quote in ש״ח / שכ״ד)
// ׳׳ = two geresh chars  (common Facebook variant for ש״ח)
// We also accept plain ASCII " and smart-quote variants.
// Numbers use [\d,.]+ to capture dot-thousands (7.800); parseNum() normalises.

const PRICE_RE  = /₪\s*([\d,.]+)|([\d,.]*\d)\s*(?:₪|ש[״"'`׳’”“]{0,2}ח|שח|שקל(?:ים)?|לחודש|ללא|לחדר|לשותף|פלוס|לא\s+כולל|shekels?|nis\b|ils\b)|שכ[״"'`""׳]?ד\s*([\d,.]+)|לחודש\s*([\d,.]+)|שכר\s+דירה\s*([\d,.]+)|מחיר\s*[:\-]?\s*(?:(?:מבוקש|מציאה|החדר|הדירה)\s*[!:\-]*\s*)?([\d,.]*\d)|([\d,.]+)\s*כולל|ב[-־]\s*([\d,.]+)\s*!|החל\s+מ[-־]?\s*([\d,.]+)|([\d,.]*\d)\s*שכר\s+דירה|([\d,.]*\d)\s+מחיר\s+שיווק|([\d,.]*\d)\s*,\s*כניסה|([\d,.]*\d)\s*\+\s*(?:הוצאות|חשבונות)|ב[-־](?!20\d\d(?!\d))([1-9]\d?,?\d{3})(?![\d,.])/g;
const PRICE_MIN = 1500;
const PRICE_MAX = 40000;
// An EXPLICIT rent label (שכ"ד: 50,000 / מחיר מבוקש: 60,000 / Monthly rent 17,500)
// is trusted far past the loose-pass cap: PRICE_MAX exists to stop unlabeled
// numbers (sale prices, arnona-for-two-months) leaking in, but it was also
// silently discarding genuine luxury TLV rents — 9 of them in a 2,311-post
// sample, every one correctly parsed and then thrown away by the bound.
const LABELED_PRICE_MAX = 150000;

// Explicitly rent-labeled prices (שכ"ד / שכר דירה / דמי שכירות / שכירות / rent)
// checked in a FIRST pass, so a rent label wins over earlier unlabeled numbers
// like "דמי ניהול : 2000₪" (management fee) appearing before the actual rent.
// Tolerates a colon/dash after the label and an optional מבוקש / כ (approx).
const LABELED_PRICE_RE = /(?:שכ[״"'`""׳]?ד|שכר\s+ה?דירה|דמי\s+שכירות|שכירות|מחיר\s+מבוקש)\s*[:\-–]?\s*(?:(?:מבוקש|הרצוי|חודשי)\s*[:\-]?\s*)?כ?([\d,.]*\d)|(?:monthly\s+)?rent\s*[:\-]?\s*([\d,.]*\d)|(?:monthly\s+)?price\s*[:\-]\s*([\d,.]*\d)/gi;

// Amount-then-label ("2,666 שכ״ד", "6500 שכירות"). Deliberately a SEPARATE pass
// rather than another LABELED_PRICE_RE alternative: as an alternative it wins the
// left-to-right race, and in "כניסה 1/8⏎שכר דירה 11,500" it captures the 8 from
// the date, fails the PRICE_MIN bound, and leaves matchAll's lastIndex past the
// label — so the forward pattern never sees the real 11,500. Six prices were lost
// that way. Kept same-line and adjacent, with a date guard so "1.9.2026 … שכירות"
// cannot yield 2026.
const REVERSED_PRICE_RE = /(?<![./\d])([\d,.]*\d)[ \t]{0,2}(?:שכ[״"'`׳]?ד|שכירות)(?![א-ת])/g;

function extractPrice(text) {
  for (const m of text.matchAll(LABELED_PRICE_RE)) {
    const n = parseNum(m[1] ?? m[2] ?? m[3]);
    if (n >= PRICE_MIN && n <= LABELED_PRICE_MAX) return n;
  }
  for (const m of text.matchAll(REVERSED_PRICE_RE)) {
    const n = parseNum(m[1]);
    if (n >= PRICE_MIN && n <= LABELED_PRICE_MAX) return n;
  }
  for (const m of text.matchAll(PRICE_RE)) {
    // A number labeled as a side cost (ארנונה: כ־16,000 לחודשיים / ועד בית /
    // פיקדון) is never the rent — skip it so a later real rent can match.
    const ctx = text.slice(Math.max(0, m.index - 20), m.index);
    if (/(?:ארנונה|ועד(?:\s+בית)?|פי?קדון|דמי\s+ניהול|חשמל)\s*[:\-–]?\s*כ?[-־]?\s*$/.test(ctx)) continue;
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9]
             ?? m[10] ?? m[11] ?? m[12] ?? m[13] ?? m[14];
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

const ROOMS_RE      = /(\d+(?:[.,]\d+)?)\s*(?:חדר(?:ים)?|חד[״׳"'""''.]?(?:ר)?|ח(?![א-ת]))/g;
const STUDIO_RE     = /(?:סטודיו|studio)/i;
const ONE_ROOM_RE   = /חדר\s+אחד|\b1\s+(?:חדר|חד)|דירת\s+חדר(?!ים)/;
const HALF_ROOM_RE  = /חדר\s+וחצי/;
// "2 וחצי חדרים" — digit + וחצי before the room word ("1 וחצי חדרים" → 1.5).
const NUM_HALF_ROOM_RE = /(\d+)\s+וחצי\s+חדר/;
// English: "3 rooms" / "4-room" / "Two bedrooms" — Marketplace cards & English posts
const ROOMS_EN_RE   = /(\d+(?:\.\d+)?)[\s-]*(?:rooms?|bed(?:room)?s?)\b/i;
// "N חדרי שינה" is a BEDROOM count — Israeli room counting adds the salon
// ("2 חדרי שינה + סלון" = a 3-room apartment). "אין סלון" keeps the raw count.
const BEDROOMS_RE   = /(\d+)\s*חדרי\s+שינה/;
const ONE_BEDROOM_RE = /חדר\s+שינה\s+אחד/;
// A room-count match followed by these words is a sub-room, not the apartment
// size: חדרי שינה / חדרי רחצה / חדר כביסה / חדרי שירותים…
const SUBROOM_AFTER_RE = /^(?:י|ות)?\s*(?:שינה|רחצה|שי?רותים|אמבטיה|כביסה|ארונות|עבודה)/;

// Longer forms first (שניים before שני) so the alternation prefers them.
const HEB_NUM_WORDS = { 'שניים': 2, 'שתיים': 2, 'שני': 2, 'שתי': 2, 'שלושה': 3, 'שלוש': 3, 'ארבעה': 4, 'ארבע': 4, 'חמישה': 5, 'חמש': 5 };
const ROOMS_WORD_RE = new RegExp('(' + Object.keys(HEB_NUM_WORDS).join('|') + ')\\s+חדר(?:ים)?');

function extractRooms(text) {
  if (STUDIO_RE.test(text)) return 1;
  if (HALF_ROOM_RE.test(text)) return 1.5;
  const nh = NUM_HALF_ROOM_RE.exec(text);
  if (nh) {
    const n = parseInt(nh[1], 10) + 0.5;
    if (n >= 1 && n <= 20) return n;
  }
  // Numeric first: "דירת 4 חדרים... שני חדרי שינה" must yield 4, not 2.
  // Sub-room counts (חדרי שינה / חדר כביסה / חדרי שירותים) are skipped here
  // and handled by the bedrooms rule below.
  for (const m of text.matchAll(ROOMS_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (SUBROOM_AFTER_RE.test(after)) continue;
    const n = parseFloat(m[1].replace(',', '.'));
    if (n >= 1 && n <= 20) return n;
  }
  // No plain room count — derive from bedrooms: "2 חדרי שינה + סלון" = 3.
  const hasSalon = /סלון/.test(text) && !/(?:אין|ללא)\s+סלון/.test(text);
  const bm = BEDROOMS_RE.exec(text);
  if (bm) {
    const n = parseInt(bm[1], 10) + (hasSalon ? 1 : 0);
    if (n >= 1 && n <= 20) return n;
  }
  if (ONE_BEDROOM_RE.test(text)) return 1 + (hasSalon ? 1 : 0);
  if (ONE_ROOM_RE.test(text)) return 1;
  const wm = ROOMS_WORD_RE.exec(text);
  if (wm) return HEB_NUM_WORDS[wm[1]];
  const em = ROOMS_EN_RE.exec(text);
  if (em) {
    const n = parseFloat(em[1]);
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
    // "כ20 מ"ר כל אחד" is a PER-ROOM size, not the apartment's — skip it.
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (/^\s*(?:כל\s+אחד|לחדר)/.test(after)) continue;
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

const NO_BROKER_RE = /(?:ללא|בלי|אין|לא)\s+(?:כל\s+)?(?:דמי\s+|עמלת\s+)?(?:מ?תי?ווך|מתווכ(?:ים)?)|ישיר(?:ות)?\s+מ(?:ה?בעל|ה?דייר|ה?משכיר)|פרטי\s+(?:מ(?:בעל|משכיר|דייר))|מפרטי(?![א-ת])(?!\s+ה)|no\s+(?:broker|fee|commission|agency)|owner\s+only/i;
const BROKER_RE    = /דמי\s+תיווך|עמלת\s+תיווך|מתיווך|מתווכ(?:ים|ת)?|מתווך|שיווק\s+נדל[״"'""׳]?ן|ניהול\s+נכסים|תיווך|תווך|מס(?:פר)?['׳]?\s*רישיון|רישיון\s*(?:מס(?:פר)?['׳]?)?\s*[:#]?\s*\d{4,}|listed\s+via\s+agency|real\s+estate|realty/i;

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
const ROOMMATES_RE = /(?:מחפש[א-ת]{0,2}|דרוש(?:\s*\/?\s*ה)?|מוצע)\s+(?:את\s+ה?)?(?:שני\s+|שתי\s+|\d+\s+)?שות|מחפש[א-ת]{0,2}\s+מחלי[פף]|עם\s+שותפ|דיר(?:ת|ות)\s+(?:\d+\s+|(?:שניים|שתיים|שני|שתי|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש)\s+)?שותפ|שותפ(?:ים|ף|ה)?\s+ל(?:דירה|חדר)|נשאר(?:ת|ות|ים)?\s+(?:בדירה\s+)?(?:עוד\s+)?(?:\d+\s+|(?:שניים|שתיים|שני|שתי|שלושה|שלוש)\s+)?שות|להי?כנס\s+שות|roommate\s+(?:wanted|needed|sought)|looking\s+for\s+(?:\w+[,.]?\s+){0,4}?roommate|flatmate/i;

function extractRoommates(text) {
  return ROOMMATES_RE.test(text) ? true : false;
}

// ── Entry date ────────────────────────────────────────────────────────────────
//
// Returns 'immediate' or a 'YYYY-MM-DD' string, or null.

// מי?די covers the common one-yod spelling: "אכלוס מידי", "פינוי מידי", or a
// standalone "מידי" line. Bare mid-sentence מידי is NOT matched ("יותר מידי").
const IMMEDIATE_RE  = /מיידי|(?:אכלוס|פינוי|כניסה|מסירה)\s+מי?די(?:ת)?(?![א-ת])|(?:^|\n)\s*מידי\s*[.!]?\s*(?:\n|$)|פנוי\s+עכשיו|זמין\s+(?:עכשיו|מיידי)|immediately|immediate(?:\s+entry)?|available\s+now/i;
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
// Negative lookahead (?![./]?\d) prevents matching when a year follows
// (DATE_SLASH_RE covers that) but still allows a sentence period: "כניסה 11/9. לטווח".
//   "כניסה מה1/9"   (מ/מה/ה prefixes), "כניסה ב: 1/8" (colon after ב),
//   "כניסה לתחילת חוזה 01.08" (contract-start phrasing).
const DATE_NO_YEAR_RE = /כניסה\s*[-:]?\s*(?:(?:ב|מ?ה)[-־:]?\s*|לתחילת\s+חוזה\s+)?(\d{1,2})[./](\d{1,2})(?![./]?\d)/g;

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

// Day/month without year after מתפנה: "מתפנה ב1/9" | "מתפנה ב 23/08" | "מתפנה 3/7".
// (?:ב|מ?ה) covers "מתפנה ב1/9", "מתפנה מה19/7", "מתפנה ה-1.8".
const DATE_AVAIL_NO_YEAR_RE = /מתפנ(?:ה|ת|ים|ות)\s+(?:(?:ב|מ?ה)[-־]?\s*)?(\d{1,2})[./](\d{1,2})(?![./]?\d)/g;

// Month name after entry keywords: "כניסה בחודש יולי" | "כניסה בספטמבר" | "שייכנסו לחוזה באוגוסט" → day = 1.
const DATE_MONTH_ENTRY_RE = new RegExp(
  '(?:כניסה\\s+(?:ב(?:חודש\\s+|מהלך\\s+)?)?|פינוי\\s+ב(?:חודש\\s+)?|מתפנ(?:ה|ת|ים|ות)\\s+ב|שייכנסו\\s+לחוזה\\s+ב)(' + Object.keys(HEB_MONTHS).join('|') + ')(?:\\s+(\\d{4}))?',
  'g'
);

// English month + day: "September 1st" | "Available: August 15" | "starting
// September 15". A 4-digit year after the month never matches (\d{1,2} + \b
// can't split "2027"), so "February 2027" lease-end dates are safe.
const EN_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_EN_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;

// Date range without a year: "27.8-14.9" / "1/8-19/9" / "02.09-23.11" —
// typical sublet periods; entry = the range start. d/m required on BOTH sides
// of the dash so phone numbers and "24/7" never fire.
// (?![./]?\d) rejects a trailing year (covered elsewhere) but allows the
// sentence period in "מה1.8-30.9. באוקטובר".
const DATE_RANGE_NO_YEAR_RE = /\b(\d{1,2})[./](\d{1,2})\s*[-–]\s*\d{1,2}[./]\d{1,2}(?![./]?\d)/g;

// Day range before a Hebrew month: "כניסה: 15-30 באוגוסט 2026" → earliest day.
// Must run BEFORE HEB_DATE_RE, which would otherwise grab the 30.
const DATE_RANGE_HEB_RE = new RegExp(
  '(\\d{1,2})\\s*[-–]\\s*\\d{1,2}\\s+(?:ל|ב)(' + Object.keys(HEB_MONTHS).join('|') + ')(?:\\s+(\\d{4}))?',
  'g'
);

// "כניסה בסוף החודש" → last day of the current month. Requires an entry word
// so marketing deadlines ("המבצע עד סוף החודש") never fire.
const ENTRY_EOM_RE = /(?:כניסה|פינוי|מתפנה)\s+ב?סוף\s+החודש/;

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

  for (const m of text.matchAll(DATE_RANGE_NO_YEAR_RE)) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    const y = (mo > currentMonth || (mo === currentMonth && d >= now.getDate()))
      ? currentYear
      : currentYear + 1;
    if (isPlausibleDate(y, mo, d)) return toISO(y, mo, d);
  }

  if (ENTRY_EOM_RE.test(text)) {
    const lastDay = new Date(currentYear, currentMonth, 0).getDate();
    return toISO(currentYear, currentMonth, lastDay);
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

  for (const m of text.matchAll(DATE_RANGE_HEB_RE)) {
    const day   = parseInt(m[1], 10);
    const month = HEB_MONTHS[m[2]];
    let year    = m[3] ? parseInt(m[3], 10) : currentYear;
    if (!m[3] && month < currentMonth) year++;
    if (isPlausibleDate(year, month, day)) return toISO(year, month, day);
  }

  for (const m of text.matchAll(DATE_EN_RE)) {
    const month = EN_MONTHS[m[1].slice(0, 3).toLowerCase()];
    const day   = parseInt(m[2], 10);
    let year    = currentYear;
    if (month < currentMonth) year++;
    if (isPlausibleDate(year, month, day)) return toISO(year, month, day);
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
//   שכ"ד / שכר דירה / דמי שכירות — rent-payment labels, only used in rental context
//   מתפנה/מתפנים + יחידה/date    — "a unit/room is becoming available"
//   מפנה את הדירה/הבית           — "vacating my apartment/house" (active form)
//   מחפש/ת מחליפ/שותפ/דיר        — replacement tenant / roommate / apartment seekers
//   דירת N שותפים                — shared flat (digit or Hebrew numeral word)
//   כניסה מיידית / כניסה + date / כניסה לחדר
//   תיווך/תווך (bare)            — broker listing; for-sale posts are caught by
//                                   NOT_RENTAL first (למכירה / million-scale price)
//   עבור בעל(ת) הדירה            — "posting on behalf of the landlord"
//   N,NNN כולל                    — 4+ digit price followed by כולל ("includes")
//   NN אלף                        — 1–39 thousand asking price (rent range)
//   מחיר + price 1,000–39,999    — bounded so car/property sale prices (65,000 /
//                                   2,450,000) no longer classify as rental
const RENTAL_RE = /ל?השכר[הת]|לשכירות|שכירות|להשכיר|(?<![א-ת])שכ[״"'`׳’”]?ד(?![א-ת])|שכר\s+ה?דירה|שכר\s+חודשי|דמי\s+שכירות|מתפנ(?:ה|ת|ים|ות)\s+(?:\d+\s+)?(?:דירה|חדר|יחידה)|מתפנ(?:ה|ת|ים|ות)\s+(?:ב[-]?\s*)?\d|מפנ(?:ה|ים|ות)\s+(?:את\s+)?ה?(?:דירה|בית|חדר)|מחפש(?:ת|ים)?\s+מחליפ|מחפש(?:ת|ות|ים)?\s+שות[פף]|מחפש(?:ת|ות|ים)?\s+(?:שוכר|דייר)|דיר(?:ת|ות)\s+(?:\d+\s+|(?:שניים|שתיים|שני|שתי|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש)\s+)?שותפ|ס(?:א)?בלט|כניסה\s*[-:]?\s*(?:מיידית|(?:ב[-־]?\s*)?\d+[./]|לחדר|לחוזה)|משכיר(?:ים|ות)?|תי?ווך|(?:לגור|לשכור|שכירות|חוזה|ל?השכר[הת]|דירה)\s+לטווח\s+ארוך|עבור\s+בעל(?:ת)?\s+הדירה|\d[\d,]{3,}\s*כולל|(?<!\d)(?:[1-9]|[1-3]\d)\s*אלף(?!\s*(?:ק|עוקב))|מחיר\s*[:\-]?\s*(?:מבוקש\s*[:\-]?\s*)?(?:[1-9],?\d{3}|[1-3]\d,?\d{3})(?![\d,])|₪\s*\d{1,2},?\d{3}.{0,80}·.{0,80}דיר|מ?ה?\d{1,2}[./]\d{1,2}\s*עד\s*ה?\d{1,2}[./]\d{1,2}|(?:חוזר(?:ת)?|חזר(?:ה)?)\s+להיות\s+רלו{1,2}נטי|עדיין\s+רלוונטי|for\s+rent(?:al)?(?:\s|$)|\bsublet\b|available\s+(?:from|now|immediately)|available\s+for\s+(?!tonight|today|this\s)|monthly\s+rent|long[\s-]?term\s+rent(?:al)?|entry\s+date|real\s+estate\s+agent|israeli\s+real\s+estate|apartment\/condo|аренд|сда[её]тся|сда[юм]|מחפש\S{0,3}\s+מישה[וי]\s+שיגור/i;

// Price per month: "5,500 שח לחודש" / "₪5000 לחודש" / "9,000 ₪ בחודש"
// (?:ל|ב) catches both "לחודש" and "בחודש" (common in Hebrew rental posts)
const MONTHLY_PRICE_RE = /\d[\d,]*\s*(?:₪|ש[״"'`’”]?ח|שח)?\s*(?:ל|ב)(?:כל\s+)?חודש/;

// Strong not-rental signals.
// נמכר(ת) — "is being sold"; להשקעה/למשקיעים — investment-sale marketing.
const NOT_RENTAL_RE  = /למכירה|למכור|נמכר(?:ת|ים|ות)?(?:\s|$)|להשקעה|למשקיעים|לרכ(?:וש|ישה)\s+(?:דירה|נכס|בית)|רכישת\s+דיר|הון\s+עצמי|ש[״"'`׳’”]{0,2}ח\s+למ[״"'`׳]?ר|for\s+sale(?:\s|$)|(?<![א-ת])קני[יה]ה?(?:\s|$)|לקנות\s+(?:דירה|נכס|בית)/i;
const NOT_RENTAL_RE2 = /מוכר(?:ת|ים|ות)?\s+(?:דירה|נכס|בית|דו-?משפחתי)/i;

// Million-scale price — a sale, never rent. Comma/dot-formatted (2,450,000 /
// 2.920.000) or spelled out ("5 מיליון", "3.85 מיליון", "מחיר מבוקש: 10.5 מליון").
// Checked before everything else: even a post full of rental vocabulary
// (e.g. "צפי שכירות 3,000 ש"ח לחודש" in an investment ad) is a sale post.
// (?<!\d) / (?!\d) guards keep dotted PHONE numbers out: "0528.244.875"
// matched the comma/dot form and flipped a real rental to not_rental.
const MILLION_PRICE_RE = /(?<!\d)\d{1,2}[.,]\d{3}[.,]\d{3}(?!\d)|\d+(?:[.,]\d+)?\s*(?:מיליון|מליון|million)/i;

// Vehicle-sale markers: mileage ("ק"מ 152") and test date ("טסט 2.4.2027").
// Cars carry rent-range prices ("מחיר 17500") that fooled the rental price
// heuristic. The mileage form requires the number AFTER ק"מ so distance
// phrases ("2 ק"מ מהים") never fire.
const VEHICLE_RE = /טסט\s*[:.]?\s*\d|(?<![א-ת])ק[״"'׳]?מ\s*[:.]?\s*\d{2,}/;

// Non-apartment rentals (offices, shops, commercial space, parking lots) and
// WhatsApp-group promo spam — the user tracks APARTMENTS; these are noise even
// though they carry להשכרה. Kept to tightly-bound phrases so apartment posts
// that merely mention a nearby shop or their storage room never fire.
const NON_APT_RE = /להשכרה\s+(?:משרד|חנות|חלל|מחסן)|משרד(?:ים)?\s+להשכרה|חלל\s+מסחרי|נכס\s+מסחרי|חנות\s+(?:חזית|פופ|בגדים|להשכרה)|החנות(?![א-ת])|מספרה|חניות\s+נוספות\s+להשכרה|chat\.whatsapp\.com/i;

// Apartment-SEEKER posts ("מחפשת דירת 2 חדרים עד 7000") are wanted ads, not
// listings — the user wants them excluded from the rentals feed. מחפש followed
// by דירה/דירת/סאבלט. Does NOT catch "מחפשים שוכרים/דיירים" (seeking TENANTS —
// that's an offer) because שוכר/דייר don't start with דיר as a token here.
// Lookbehinds exclude conditional marketing phrasing inside listings:
// "אם אתם מחפשים דירה עם אופי..." (if you're looking for) and "למי שמחפש
// דירה" (for whoever seeks) — real seekers open with a bare מחפש.
// Word-start guard (?<![א-ת]) with an optional ש: "עולה חדש שמחפש דירה" is a
// seeker, but "המחפשים דירה" (listing marketing) and "למי שמחפש" are blocked.
// [א-ת]{0,2} soaks suffixes and typos (מחפשים / מחפשתת); [*!:.]* skips
// decoration ("*מחפשת*"). להשכרה/לשכור may sit between מחפש and דירה.
const SEEKER_RE = /(?<!אם\s{1,3}את(?:ם|ן|ה)?\s{1,3})(?<!מי\s{0,3})(?<![א-ת])ש?מחפש[א-ת]{0,2}[*!:.]*\s+(?:אחר\s+)?(?:את\s+)?(?:להשכרה\s+|לשכור\s+)?(?:דירה|דירת|דירות|סאבלט|יחיד(?:ה|ת)|\d+(?:[.,]\d+)?\s*חדרים)|ש?מחפש[א-ת]{0,2}\s+להי?כנס\s+לדיר|מעוניי(?:ן|נת|נים|נות)\s+להי?כנס\s+לדיר|אשמח\s+להצעות|looking\s+for\s+(?:an?\s+)?(?:apartment|flat|sublet|studio|room\b)/i;

// Unambiguous OFFER signals. Checked BEFORE the seeker rule because broker
// listings open with rhetorical seeker lines ("מחפשים דירה מרווחת? זו
// ההזדמנות שלכם!") and then say להשכרה — those are offers, not wanted ads.
// סאבלט is deliberately NOT here: "מחפשים סאבלט" is a seeker post.
const STRONG_RENTAL_RE = /ל?השכר[הת]|לשכירות|להשכיר|(?<![א-ת])שכ[״"'`׳’”]?ד(?![א-ת])|שכר\s+ה?דירה|שכר\s+חודשי|דמי\s+שכירות|מחפש(?:ת|ות|ים)?\s+(?:שוכר|דייר)|for\s+rent|monthly\s+rent/i;

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
  // 1. A million-scale price is a sale regardless of rental vocabulary
  //    (investment ads quote expected rent: "צפי שכירות 3,000 ש"ח לחודש").
  if (MILLION_PRICE_RE.test(text)) return 'not_rental';
  //    Same for vehicle-sale markers (mileage / test date).
  if (VEHICLE_RE.test(text))       return 'not_rental';
  // 2. A sale signal near the TOP of the post is its headline ("למכירה
  //    בבלעדיות...") — a sale even when rental vocabulary appears later.
  //    Deeper in the text it's usually incidental ("הריהוט מוצע למכירה" in a
  //    rental post selling furniture to the incoming tenant) — then strong
  //    offer language (step 3) wins.
  const saleM = NOT_RENTAL_RE.exec(text) || NOT_RENTAL_RE2.exec(text);
  if (saleM && saleM.index < 150) return 'not_rental';
  // 2.5 Non-apartment rentals (office / shop / commercial space / parking) and
  //     WhatsApp-group promo spam carry להשכרה but are not apartments.
  if (NON_APT_RE.test(text)) return 'not_rental';
  // 3. Wanted ads (apartment seekers) — checked before offer language because
  //    seekers state budgets in offer vocabulary ("תקציב עד 7,000₪ לחודש").
  //    A question mark shortly after the מחפש phrase marks a rhetorical broker
  //    hook instead ("מחפשים דירה נעימה...? הדירה הזו בדיוק בשבילכם!") — real
  //    seekers state, not ask — then offer language and room count decide.
  //    Position matters too: seekers OPEN with the phrase, while listings drop
  //    it mid-text ("אם אתם מחפשים דירה — צרו קשר") — only match near the top.
  const seekM = SEEKER_RE.exec(text);
  if (seekM && seekM.index < 250) {
    const tail = text.slice(seekM.index + seekM[0].length, seekM.index + seekM[0].length + 60);
    if (!tail.includes('?')) return 'not_rental';
    // A rhetorical hook is an AD for a property. Broker teasers often state
    // no price ("לפרטים דברו איתי") — trust the room count instead.
    if (extractRooms(text) !== null) return 'rental';
  }
  // 4. Unambiguous offer language.
  if (STRONG_RENTAL_RE.test(text) || MONTHLY_PRICE_RE.test(text)) return 'rental';
  // 5. Other rental signals beat a DEEP sale mention — rentals routinely sell
  //    their furniture ("נשאר בדירה ריהוט שנשמח למכור") without any strong
  //    rental keyword; genuine sale posts headline למכירה early (step 2).
  if (RENTAL_RE.test(text)) return 'rental';
  if (saleM) return 'not_rental';
  // Heuristic fallback: a rent-range price (1,500–40,000) together with an
  // explicit room count is a listing even without any rental keyword.
  // Furniture/car ads fail one of the two (price out of range or no חדרים).
  if (extractPrice(text) !== null && extractRooms(text) !== null) return 'rental';
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
  const roommates = extractRoommates(text);
  let broker = extractBroker(text);
  // A roommate-seeking post is written by a private tenant filling a room in
  // their own flat — agencies don't broker shared rooms. Unless the text says
  // otherwise, no broker fee applies.
  if (broker === null && roommates) broker = false;
  return {
    price:      extractPrice(text),
    rooms:      extractRooms(text),
    size:       extractSize(text),
    roommates,
    broker,
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

// Exported for the ML layer's weak supervision (lib/ml_retrain.js masks these
// patterns out of the text before training the broker head).
export { NO_BROKER_RE, BROKER_RE, ROOMMATES_RE };
