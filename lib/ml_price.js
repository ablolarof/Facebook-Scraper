// lib/ml_price.js — price extraction as CANDIDATE RANKING.
//
// Why this is not another head like label/broker
// ----------------------------------------------
// The label and broker heads answer a yes/no question about a whole document:
// TF-IDF in, one probability out. Price has to emit a VALUE, which that shape
// structurally cannot do. So instead: generate every number in the post that
// could plausibly be a monthly rent, score each one by its LOCAL context, and
// take the argmax. The regex fails on pattern coverage (it needs a keyword it
// knows, adjacent, in an order it expects); a context scorer learns the
// distribution instead and reaches phrasings no rule was written for.
//
// Training labels are free: every post where the regex already found a price
// is a solved ranking problem (that candidate is positive, the other numbers
// in the same post are negatives). Unlike training a CLASSIFIER on regex
// output — which can only re-learn the regex's own decision boundary — this
// generalises, because the thing being learned (what rent context looks like)
// is not the thing the regex encodes (which literal keywords sit adjacent).
//
// The period problem
// ------------------
// The first prototype hit ~75% precision on the posts the regex could not
// answer, and every failure was the same mistake: it had no notion of what
// period a number refers to. It proposed `Weekday Price: 1,200 NIS per night`,
// `8000 ILS per night`, and `6,000 לכל התקופה` (a whole-sublet total) as
// monthly rents. A number's period is decided by the words right after it, so
// it is handled two ways here: an explicit non-monthly marker VETOES the
// candidate outright (a per-night rate is definitionally not a monthly rent —
// that is a rule, not something the model should have to discover), and the
// detected period is also a feature so the model can weigh softer cases.
//
// Everything here is shared by the offline trainer (ml/train_price.mjs) and
// the in-extension runtime, exactly like ml_features.js — if the featurizer
// changes, bump PRICE_FEATURE_VERSION and retrain, or stored weights will be
// scored with the wrong features.

import { ML_PRICE_META, ML_PRICE_BIAS, ML_PRICE_WEIGHTS } from './ml_price_weights.js';

export const PRICE_FEATURE_VERSION = 1;

// A monthly TLV rent. The lower bound also removes almost every distractor
// for free (sizes 20-200, rooms 1-8, arnona/vaad in the hundreds, dates,
// floors); the upper bound sits above the highest labeled rent observed
// (60,000) with headroom, while excluding sale prices in the millions.
export const PRICE_CAND_MIN = 1200;
export const PRICE_CAND_MAX = 150000;

// The bar for eventually TAGGING with this head. Price is scored on PRECISION
// because a null price passes matchesPreferences (costing nothing) while a
// wrong one silently hides a listing — so the deployment bar is strict.
export const PRICE_CONFIDENCE = 0.9;

// The bar for emitting a SHADOW prediction, which is a different question.
//
// Shadow predictions cost nothing when wrong — they never tag, they only ask
// the user a question. Reusing the strict 0.9 here starved the review queue:
// measured live, after 31 verdicts the head emitted on nothing at all, leaving
// 127 disagreements that were every one of them an abstention and 0 reviewable
// questions — with MIN_VERDICTS at 40, the benchmark could never be reached.
//
// Emitting lower gets the model to commit to an answer often enough to be
// judged. Precision measured here is therefore a CONSERVATIVE figure: it is
// precision at the review threshold, not at the stricter threshold we would
// actually deploy at, so the real deployed precision would be higher.
export const PRICE_SHADOW_EMIT = 0.6;

const parseNum = s => parseFloat(String(s).replace(/,/g, '').replace(/\.(\d{3})$/, '$1'));

// ── period detection ─────────────────────────────────────────────────────────
// Read the text immediately after a number (optionally past a currency token)
// and decide what period it is quoted for.
const CUR = String.raw`(?:₪|ש["״'\`׳]{0,2}ח|שח|nis|ils|shekels?|\$)`;
const after = (r, body) => new RegExp(`^\\s*${CUR}?\\s*(?:${body})`, 'i').test(r);

const P_NIGHT = String.raw`(?:\/|per\s+|a\s+|ל[-\s]?)?\s*(?:night|nightly|לילה|ללילה|לילות)`;
const P_WEEK  = String.raw`(?:\/|per\s+|a\s+|ל[-\s]?)?\s*(?:week|weekly|שבוע|לשבוע)`;
const P_TOTAL = String.raw`(?:ל(?:כל\s+ה)?תקופה|לכל\s+התקופה|for\s+the\s+(?:entire|whole)\s+period|in\s+total|סה["״']?כ)`;
const P_MONTH = String.raw`(?:\/|per\s+|a\s+|ל|ב)?\s*(?:month(?:ly)?|חודש|לחודש|בחודש|לחו["׳']?)`;

/** @returns {'night'|'week'|'total'|'month'|null} */
export function periodAfter(right) {
  if (after(right, P_NIGHT)) return 'night';
  if (after(right, P_WEEK))  return 'week';
  if (after(right, P_TOTAL)) return 'total';
  if (after(right, P_MONTH)) return 'month';
  return null;
}

// A number explicitly quoted per night / per week / as a period total is not a
// monthly rent, whatever else the context looks like.
const VETOED_PERIODS = new Set(['night', 'week', 'total']);

// Document-level short-stay detection.
//
// A per-candidate veto is not enough on its own. In a post reading
// "Weekday Price: 1,200 NIS per night / Shabbat Price: 1,400 NIS", only the
// 1,200 carries the marker — the 1,400 looks like a bare price and was
// proposed at p=1.00. The signal is a property of the POST, not of one number.
//
// Deliberately limited to explicit RATE markers (per night / per day / for N
// days / vacation-rental words). Broader phrases like "short term" or
// "לטווח קצר" are excluded on purpose: a sublet is short-term but still quotes
// a genuine monthly rent, and vetoing those would lose real prices.
// Hebrew markers need letter boundaries: without them "לילות" matches inside
// the place name "גלילות" and "ליום" inside the idiom "ליום-יום" (day-to-day),
// which suppressed three genuine monthly rentals. Same substring-collision
// class as "משותפת" matching a shared-parking mention.
const SHORT_TERM_RE = /per\s+night|a\s+night|\/\s*night|per\s+day|a\s+day|\/\s*day|(?<![א-ת])ללילה|(?<![א-ת])לילות|(?<![א-ת])ליום(?![-\s]*יום)|for\s+\d+\s+days?|minimum\s+(?:stay|\d+\s*-?\s*(?:week|night|day))|airbnb|צימר|דירת\s+נופש/i;

// Hebrew routinely puts the period label BEFORE the amount ("לחודש 3000₪"),
// which periodAfter() cannot see. Without this, a sublet quoting
// "לחודש 3000₪ … או 1000₪ לשבוע" is judged short-stay off its weekly fallback.
const MONTHLY_BEFORE_RE = /(?:לחודש|בחודש|monthly|per\s+month)\s*[-–:]?\s*(?:₪|ש["״'`׳]{0,2}ח|nis|ils)?\s*\d[\d,.]*\d/i;

/**
 * True when the post quotes nightly/daily rates — i.e. it is a short-stay
 * listing whose correct MONTHLY rent is null.
 *
 * Checks the explicit markers above, and also reuses the per-candidate veto:
 * if any number in the post is quoted per night or per week, that is proof the
 * listing is priced by stay, so every other bare number in it is suspect too.
 */
export function isShortStayListing(text) {
  const t = text || '';
  let monthly = false, byStay = false;
  for (const m of t.matchAll(/(?<![\d,.])\d[\d,.]*\d(?![\d,.])/g)) {
    const p = periodAfter(t.slice(m.index + m[0].length, m.index + m[0].length + 30));
    if (p === 'month') monthly = true;
    else if (p === 'night' || p === 'week') byStay = true;
  }
  // An explicitly quoted monthly rate outranks everything else. "…stylish and
  // cozy, just like an Airbnb! … Rent: 7900 NIS per month" is a monthly
  // listing that merely mentions Airbnb as a simile; so is a sublet offering
  // "לחודש 3000₪ … או 1000₪ לשבוע", where the weekly figure is the alternative.
  if (monthly || MONTHLY_BEFORE_RE.test(t)) return false;
  if (byStay) return true;
  return SHORT_TERM_RE.test(t);
}

/**
 * Every number in the post that could be a monthly rent.
 * Vetoed candidates are dropped here so they can never be selected — and the
 * trainer sees the same candidate set as the runtime, preserving parity.
 */
export function priceCandidates(text) {
  const t = text || '';
  const out = [];
  for (const m of t.matchAll(/(?<![\d,.])\d[\d,.]*\d(?![\d,.])/g)) {
    const v = parseNum(m[0]);
    if (!(v >= PRICE_CAND_MIN && v <= PRICE_CAND_MAX)) continue;
    const right = t.slice(m.index + m[0].length, m.index + m[0].length + 30);
    const period = periodAfter(right);
    if (VETOED_PERIODS.has(period)) continue;
    out.push({ raw: m[0], v, i: m.index, period });
  }
  return out;
}

const words = s => (s.toLowerCase().match(/[֐-׿a-z]{2,}/g) || []).slice(0, 12);

/** Sparse binary features describing one candidate in its context. */
export function priceFeatures(text, c) {
  const t = text || '';
  const L = t.slice(Math.max(0, c.i - 45), c.i);
  const R = t.slice(c.i + c.raw.length, c.i + c.raw.length + 45);
  const f = [];
  for (const w of words(L)) f.push('L:' + w);
  for (const w of words(R)) f.push('R:' + w);
  // The immediately adjacent words carry far more signal than the rest of the
  // window, so they also get their own features.
  const lw = words(L), rw = words(R);
  if (lw.length) f.push('L1:' + lw[lw.length - 1]);
  if (rw.length) f.push('R1:' + rw[0]);

  f.push('MAG:' + (c.v < 2000 ? 'a' : c.v < 4000 ? 'b' : c.v < 7000 ? 'c'
                 : c.v < 12000 ? 'd' : c.v < 20000 ? 'e' : c.v < 45000 ? 'f' : 'g'));
  f.push('PERIOD:' + (c.period || 'none'));
  if (SHORT_TERM_RE.test(t)) f.push('DOC_SHORTTERM');
  if (new RegExp(`^\\s*${CUR}`, 'i').test(R)) f.push('CUR_R');
  if (/(?:₪|\$)\s*$/.test(L)) f.push('CUR_L');
  if (/(?:ארנונה|ועד|פי?קדון|דמי\s+ניהול|חשמל|מים|גז|מסי?\s+ועד)\s*[:\-–]?\s*כ?[-־]?\s*$/.test(L)) f.push('SIDECOST');
  if (/(?:שכ["״'`׳]?ד|שכירות|שכר\s+דירה|מחיר|rent|price)\s*[:\-–]?\s*כ?\s*$/i.test(L)) f.push('RENTLBL');
  if (/^\s*(?:שכ["״'`׳]?ד|שכירות|שכר\s+דירה)/.test(R)) f.push('RENTLBL_R');
  if (/(?:^|\n)\s*$/.test(L)) f.push('LINESTART');
  if (c.raw.includes(',')) f.push('COMMA');
  f.push('NDIG:' + c.raw.replace(/[^\d]/g, '').length);
  f.push('POS:' + Math.min(3, Math.floor(4 * c.i / Math.max(1, t.length))));
  return f;
}

/**
 * L2-normalised binary vector, identical in training and at runtime.
 * `lookup` maps a feature name to an index (training) or is null (runtime,
 * where the weight object is keyed by name directly).
 */
export function priceVector(feats, lookup) {
  const v = [];
  for (const f of new Set(feats)) {
    const i = lookup ? lookup.get(f) : f;
    if (i !== undefined) v.push(i);
  }
  const n = Math.sqrt(v.length) || 1;
  return { idx: v, w: 1 / n };
}

/** Score one candidate against a name-keyed weight head. */
export function scorePriceCandidate(weights, bias, feats) {
  const { idx, w } = priceVector(feats, null);
  let z = bias;
  for (const f of idx) { const wt = weights[f]; if (wt !== undefined) z += wt * w; }
  return 1 / (1 + Math.exp(-z));
}

// ── active weights (bundled by default, retrained ones take precedence) ──
let ACTIVE = {
  source: ML_PRICE_META?.stub ? 'stub' : 'bundled',
  meta: ML_PRICE_META,
  weights: ML_PRICE_WEIGHTS,
  bias: ML_PRICE_BIAS,
};

export const PRICE_STORAGE_KEY = 'ml_price_weights';

export function activePriceMeta() {
  return { source: ACTIVE.source, ...ACTIVE.meta };
}

export async function loadStoredPriceWeights() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return ACTIVE.source;
  try {
    const stored = (await chrome.storage.local.get(PRICE_STORAGE_KEY))[PRICE_STORAGE_KEY];
    if (stored?.weights && stored.meta?.price_feature_version === PRICE_FEATURE_VERSION) {
      ACTIVE = { source: 'retrained', meta: stored.meta, weights: stored.weights, bias: stored.bias };
    }
  } catch (err) {
    console.warn('[TLV Rentals] Failed to load stored price weights:', err);
  }
  return ACTIVE.source;
}

/**
 * Rank the candidates and return the best one above the threshold.
 * Abstains (value: null) when nothing clears it — abstention is the safe
 * outcome, since a null price passes the notification filter untouched.
 *
 * @returns {{ value: ?number, prob: number, candidates: number }}
 */
export function predictPrice(text, threshold = PRICE_SHADOW_EMIT) {
  // A short-stay listing has no monthly rent to find. Abstaining is both the
  // correct answer and the free one.
  if (isShortStayListing(text)) return { value: null, prob: 0, candidates: 0, short_stay: true };
  const cands = priceCandidates(text);
  let best = null, bestP = -1;
  for (const c of cands) {
    const p = scorePriceCandidate(ACTIVE.weights, ACTIVE.bias, priceFeatures(text, c));
    if (p > bestP) { bestP = p; best = c; }
  }
  if (!best || bestP < threshold) {
    return { value: null, prob: best ? +bestP.toFixed(3) : 0, candidates: cands.length };
  }
  return { value: best.v, prob: +bestP.toFixed(3), candidates: cands.length };
}

/** Live weight head, for introspection (devtools Weights tab). */
export function activePriceWeights() { return ACTIVE.weights; }

/**
 * Everything behind a price prediction, for the devtools Reasoning tab.
 *
 * predictPrice() returns only the winner, which is useless for understanding
 * WHY it won — a ranker's interesting behaviour is the losers it beat and by
 * how much. This returns every candidate with its score, plus the vetoes that
 * removed candidates before scoring ever happened.
 */
export function explainPrice(text, threshold = PRICE_SHADOW_EMIT) {
  const t = text || '';
  const shortStay = isShortStayListing(t);
  const cands = priceCandidates(t).map(c => {
    const feats = priceFeatures(t, c);
    return {
      raw: c.raw, value: c.v, index: c.i, period: c.period,
      prob: +scorePriceCandidate(ACTIVE.weights, ACTIVE.bias, feats).toFixed(4),
      features: feats.filter(f => !f.startsWith('L:') && !f.startsWith('R:')),
    };
  }).sort((a, b) => b.prob - a.prob);

  // Numbers dropped before scoring: out of range, or explicitly quoted per
  // night / per week / as a period total.
  const rejected = [];
  for (const m of t.matchAll(/(?<![\d,.])\d[\d,.]*\d(?![\d,.])/g)) {
    const v = parseNum(m[0]);
    if (cands.some(c => c.index === m.index)) continue;
    const period = periodAfter(t.slice(m.index + m[0].length, m.index + m[0].length + 30));
    rejected.push({ raw: m[0], value: v, reason:
      VETOED_PERIODS.has(period) ? `quoted per ${period}`
      : v < PRICE_CAND_MIN ? `below ${PRICE_CAND_MIN}`
      : v > PRICE_CAND_MAX ? `above ${PRICE_CAND_MAX}` : 'not a candidate' });
  }

  const best = cands[0] || null;
  return {
    shortStay, threshold, candidates: cands, rejected,
    value: (!shortStay && best && best.prob >= threshold) ? best.value : null,
    prob: best ? best.prob : 0,
  };
}

/**
 * Training rows from posts whose price is already known (regex output or a
 * human correction). Pure — the offline trainer and any in-extension retrain
 * both call this, so their candidate sets and features cannot drift apart.
 *
 * Posts whose known price is not among the generated candidates are reported
 * as `unreachable` rather than silently dropped: a rising count there means
 * the generator or the veto is losing real prices.
 */
export function buildPriceTrainingRows(items) {
  const rows = [];
  let unreachable = 0, absentPosts = 0;
  for (const { text, price, confirmedAbsent } of items) {
    if (!(text || '').trim()) continue;
    // Short-stay posts are excluded from training as well as inference: their
    // "price" is a nightly rate, so the label would be noise and the runtime
    // never sees such posts anyway. Train/runtime parity.
    if (isShortStayListing(text)) continue;
    const cs = priceCandidates(text);

    if (price == null) {
      // `confirmedAbsent` means a HUMAN judged this post to state no monthly
      // rent — not merely that we don't know. Every candidate in it is then a
      // wrong answer, which is the strongest available teaching signal for
      // abstention. Precision is the metric price is gated on, and precision
      // is improved by learning when to stay silent, so these all-negative
      // posts matter as much as the positive ones. An unjudged null is still
      // skipped: absence of evidence is not evidence of absence.
      if (!confirmedAbsent || !cs.length) continue;
      for (const c of cs) rows.push({ feats: priceFeatures(text, c), y: 0 });
      absentPosts++;
      continue;
    }

    if (!cs.some(c => c.v === price)) { unreachable++; continue; }
    for (const c of cs) rows.push({ feats: priceFeatures(text, c), y: c.v === price ? 1 : 0 });
  }
  return { rows, unreachable, absentPosts };
}
