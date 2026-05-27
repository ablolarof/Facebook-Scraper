// lib/neighborhood_overrides.js
//
// Deterministic neighborhood detection via substring matching.
// Applied in gemini.js AFTER Gemini returns its guess — any match here wins
// and is stored with neighborhood_confidence: "high" and
// neighborhood_evidence: "<override>".
//
// Keys   — lowercase substrings matched against the full lowercased post text.
//          Hebrew is already case-invariant so no special handling needed.
//          Longer / more-specific keys take priority: place them BEFORE shorter
//          ones because the loop breaks on the first match.
//
// Values — must be an exact entry from CANONICAL_NEIGHBORHOODS in gemini.js.
//
// Scope: only the 11 neighborhoods this project actively tracks. Areas outside
// that scope (north of the Yarkon, east of the Ayalon, Yafo) are left to
// Gemini — no override entries for them.

export const NEIGHBORHOOD_OVERRIDES = {

  // ── Old North (הצפון הישן) ─────────────────────────────────────────────────
  'הצפון הישן':     'Old North',
  'צפון ישן':       'Old North',

  // ── New North (הצפון החדש) ─────────────────────────────────────────────────
  'הצפון החדש':     'New North',
  'צפון חדש':       'New North',

  // ── Bavli ─────────────────────────────────────────────────────────────────
  'בבלי':            'Bavli',

  // ── Lev Tel Aviv (city center) ─────────────────────────────────────────────
  'לב תל-אביב':     'Lev Tel Aviv',
  'לב תל אביב':     'Lev Tel Aviv',
  'מרכז תל אביב':   'Lev Tel Aviv',
  'מרכז העיר':      'Lev Tel Aviv',

  // ── Ganei Sarona ──────────────────────────────────────────────────────────
  'גני שרונה':       'Ganei Sarona',
  'גן שרונה':        'Ganei Sarona',
  'שרונה':           'Ganei Sarona',

  // ── Montefiore ────────────────────────────────────────────────────────────
  'מונטיפיורי':     'Montefiore',
  'montefiore':      'Montefiore',

  // ── Kerem Hateimanim ──────────────────────────────────────────────────────
  // Longer keys first so 'כרם התימנים' is checked before any shorter 'כרם' alias.
  'כרם התימנים':    'Kerem Hateimanim',
  'שוק הכרמל':     'Kerem Hateimanim',
  'carmel market':   'Kerem Hateimanim',
  'kerem hateimanim': 'Kerem Hateimanim',

  // ── Neve Zedek ────────────────────────────────────────────────────────────
  'נווה צדק':        'Neve Zedek',
  'נוה צדק':         'Neve Zedek',
  'neve zedek':      'Neve Zedek',
  'לילינבלום':      'Neve Zedek',   // Lilienblum St — strongly anchors Neve Zedek

  // ── Florentine ────────────────────────────────────────────────────────────
  'פלורנטין':        'Florentine',
  'florentine':      'Florentine',

  // ── Neve Sha'anan ─────────────────────────────────────────────────────────
  "נווה שאנן":       "Neve Sha'anan",
  "נוה שאנן":        "Neve Sha'anan",
  "neve sha'anan":   "Neve Sha'anan",
  'neve shaanan':    "Neve Sha'anan",

  // ── South Tel Aviv ────────────────────────────────────────────────────────
  // Shapira, Hatikva, Yad Eliyahu / Bloomfield, Ezra, Kiryat Shalom.
  'שפירא':           'South Tel Aviv',
  'שכונת שפירא':    'South Tel Aviv',
  'התקווה':          'South Tel Aviv',   // two-vav spelling (modern)
  'התקוה':           'South Tel Aviv',   // one-vav spelling (GIS / older)
  'שכונת התקווה':   'South Tel Aviv',
  'שכונת התקוה':    'South Tel Aviv',
  'יד אליהו':        'South Tel Aviv',
  'בלומפילד':        'South Tel Aviv',
  'קריית שלום':     'South Tel Aviv',
  'קרית שלום':      'South Tel Aviv',
  'עזרא':            'South Tel Aviv',

};
