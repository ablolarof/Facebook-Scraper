// ml/train_price.mjs — offline trainer/evaluator for the price ranker.
//
// Usage:  node ml/train_price.mjs <path-to-export.json>
//
// Writes: lib/ml_price_weights.js
//
// Featurization and candidate generation come from lib/ml_price.js, so this
// script and the in-extension runtime cannot diverge. What only makes sense
// offline lives here: the held-out evaluation and the report on the posts the
// regex could NOT answer — which is the population shadow mode exists to
// measure, and the only one whose precision is meaningful.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { trainLR, predictRow, mulberry32 } from '../lib/ml_train_core.js';
import { regexExtractTags } from '../lib/regex_extractor.js';
import {
  priceCandidates, priceFeatures, buildPriceTrainingRows, isShortStayListing,
  PRICE_FEATURE_VERSION, PRICE_CONFIDENCE,
} from '../lib/ml_price.js';
import { verdictTruth } from '../lib/ml_shadow.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exportPath = process.argv[2];
if (!exportPath) {
  console.error('Usage: node ml/train_price.mjs <path-to-export.json>');
  process.exit(1);
}

const posts = JSON.parse(readFileSync(exportPath, 'utf8'));
const rentals = posts.filter(p =>
  (p.human_label || p.ai_label) === 'rental' && !p.is_duplicate && (p.text || '').trim());

// Label precedence: shadow VERDICT > tags_human_override > regex. Never the
// model's own output — same rule as every other head here.
//
// The verdict is checked first and explicitly, not via `??`, because a verdict
// of null is meaningful ("this post states no monthly rent") and `??` would
// silently fall through to the regex and discard exactly the correction the
// user just made. Those posts become all-negative training rows instead.
const known = [], unknown = [], absent = [];
let fromVerdict = 0, fromOverride = 0;
for (const p of rentals) {
  const vt = verdictTruth(p, 'price');
  const hasOverride = p.tags_human_override &&
    Object.prototype.hasOwnProperty.call(p.tags_human_override, 'price');

  let price;
  if (vt !== undefined)       { price = vt; fromVerdict++; }
  else if (hasOverride)       { price = p.tags_human_override.price ?? null; fromOverride++; }
  else                        { price = (regexExtractTags(p.text) || {}).price ?? null; }

  if (price != null)          known.push({ text: p.text, price });
  else if (vt === null)       absent.push({ text: p.text, price: null, confirmedAbsent: true });
  else                        unknown.push({ text: p.text, price: null });
}
console.log(`rentals ${rentals.length} — known price ${known.length}, regex-null ${unknown.length}, ` +
  `human-confirmed absent ${absent.length}`);
console.log(`labels from shadow verdicts: ${fromVerdict}, from tag overrides: ${fromOverride}`);

// ── split by POST before building candidate rows, so candidates from one post
//    can never straddle the train/test boundary and inflate the score ────────
const rng = mulberry32(5);
const shuffled = known.map(r => [rng(), r]).sort((a, b) => a[0] - b[0]).map(r => r[1]);
const cut = Math.floor(shuffled.length * 0.8);
const trainPosts = shuffled.slice(0, cut), testPosts = shuffled.slice(cut);

// Human-confirmed-absent posts join the TRAINING side only — they have no
// value for top-1 accuracy to match against, so they would corrupt the
// held-out metric while being genuinely useful as negatives.
const { rows: trainRows, unreachable, absentPosts } =
  buildPriceTrainingRows([...trainPosts, ...absent]);
console.log(`train posts ${trainPosts.length} (+${absentPosts} all-negative from confirmed-absent), ` +
  `${unreachable} whose price is not a generatable candidate`);

const vocab = new Map(), df = new Map();
for (const r of trainRows) for (const f of new Set(r.feats)) df.set(f, (df.get(f) || 0) + 1);
for (const [f, n] of df) if (n >= 3) vocab.set(f, vocab.size);

const vec = feats => {
  const v = [];
  for (const f of new Set(feats)) { const i = vocab.get(f); if (i !== undefined) v.push(i); }
  const w = 1 / (Math.sqrt(v.length) || 1);
  return v.map(i => [i, w]);
};
const X = trainRows.map(r => vec(r.feats));
const y = trainRows.map(r => r.y);
console.log(`candidate rows ${X.length} (positives ${y.filter(v => v).length}), vocab ${vocab.size}`);

const model = trainLR(X, y, X.map((_, i) => i), mulberry32(17), vocab.size, 25, 0.5, 1e-5);

// ── held-out: top-1 exact match, at several thresholds ───────────────────────
const pick = (text) => {
  // mirrors predictPrice()'s document-level short-stay abstention
  if (isShortStayListing(text)) return { best: null, prob: -1 };
  let best = null, bp = -1;
  for (const c of priceCandidates(text)) {
    const p = predictRow(model, vec(priceFeatures(text, c)));
    if (p > bp) { bp = p; best = c; }
  }
  return { best, prob: bp };
};
console.log(`\nheld-out posts: ${testPosts.length}`);
console.log('thr    coverage   precision');
for (const thr of [0.5, 0.7, 0.8, 0.9, 0.95]) {
  let emitted = 0, correct = 0;
  for (const r of testPosts) {
    const { best, prob } = pick(r.text);
    if (!best || prob < thr) continue;
    emitted++; if (best.v === r.price) correct++;
  }
  console.log(`${thr.toFixed(2)}   ${(100 * emitted / testPosts.length).toFixed(1)}%      ` +
    `${emitted ? (100 * correct / emitted).toFixed(1) : '—'}%   (${correct}/${emitted})`);
}
console.log('NOTE: this population is the EASY one — posts the regex already solved.');

// ── the population that actually matters: regex found nothing ────────────────
console.log(`\nregex-null posts: ${unknown.length}`);
const proposals = [];
for (const r of unknown) {
  const { best, prob } = pick(r.text);
  if (best && prob >= PRICE_CONFIDENCE) proposals.push({ v: best.v, prob, c: best, text: r.text });
}
console.log(`model proposes a price on ${proposals.length} of them at thr ${PRICE_CONFIDENCE}`);
console.log('(precision here is UNMEASURABLE offline — no ground truth. That is exactly');
console.log(' what shadow mode collects. Sample below is for eyeballing only.)\n');
for (const p of proposals.slice(0, 15)) {
  const s = Math.max(0, p.c.i - 55);
  console.log(`  ${String(p.v).padStart(6)} p=${p.prob.toFixed(2)} | …` +
    p.text.slice(s, p.c.i + p.c.raw.length + 45).replace(/\n/g, ' ⏎ ') + '…');
}

// ── export ───────────────────────────────────────────────────────────────────
const weights = {};
for (const [f, i] of vocab) {
  const w = model.w[i];
  if (Math.abs(w) > 1e-3) weights[f] = +w.toFixed(4);
}
const out = `// lib/ml_price_weights.js — GENERATED by ml/train_price.mjs. Do not edit by hand.
// Regenerate with:  node ml/train_price.mjs <path-to-export.json>
// feature: weight. Scored by lib/ml_price.js::scorePriceCandidate.

export const ML_PRICE_META = {
  price_feature_version: ${PRICE_FEATURE_VERSION},
  trained_at: ${JSON.stringify(new Date().toISOString())},
  train_posts: ${trainPosts.length},
  candidate_rows: ${X.length},
  features: ${Object.keys(weights).length},
};

export const ML_PRICE_BIAS = ${model.b.toFixed(5)};
export const ML_PRICE_WEIGHTS = ${JSON.stringify(weights)};
`;
writeFileSync(join(root, 'lib/ml_price_weights.js'), out, 'utf8');
console.log(`\nwrote lib/ml_price_weights.js (${Object.keys(weights).length} features)`);
