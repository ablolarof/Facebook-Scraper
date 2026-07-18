// ml/train.mjs — trains the ML layer from gold labels + a dashboard export.
//
// Usage:  node ml/train.mjs [path-to-export.json]
//         (default export path: the newest tlv-rentals-*.json in ~/Downloads
//          must be passed explicitly on other machines)
//
// Reads:  ml/gold_labels.json  (post_id → rental/not_rental gold labels)
//         the export JSON      (post texts; NOT committed to the repo)
// Writes: lib/ml_weights.js    (generated weight module used by lib/ml_classifier.js)
//
// Two heads are trained:
//   1. label  — rental vs not_rental, trained on the gold labels.
//   2. broker — broker-fee likelihood, weakly supervised: posts whose text
//      explicitly matches the broker / no-broker keyword regexes provide the
//      labels, and those keywords are MASKED OUT of the text before
//      featurization, so the model is forced to learn the surrounding signals
//      (agency names, license numbers, listing register). That is exactly the
//      capability needed for the 47% of rentals where no explicit keyword
//      exists and the regex extractor returns null.
//
// Evaluation is 5-fold cross-validation. Reported separately for the
// claude_review subset — labels there were assigned independently of both
// the regex and the model, so it is the honest hard-set number.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tokenize } from '../lib/ml_features.js';
import { regexClassifyPost } from '../lib/regex_extractor.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exportPath = process.argv[2];
if (!exportPath) { console.error('Usage: node ml/train.mjs <path-to-export.json>'); process.exit(1); }

const posts = JSON.parse(readFileSync(exportPath, 'utf8'));
const byId = new Map(posts.map(p => [p.post_id, p]));
const gold = JSON.parse(readFileSync(join(root, 'ml/gold_labels.json'), 'utf8')).labels
  .filter(g => byId.has(g.post_id));
console.log('gold labels with text available:', gold.length);

// ── deterministic RNG ────────────────────────────────────────────────────────
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── generic TF-IDF + logistic-regression pipeline ────────────────────────────
function buildCorpus(texts, minDf = 3) {
  const df = new Map();
  const docs = texts.map(t => {
    const set = new Set(tokenize(t));
    for (const tok of set) df.set(tok, (df.get(tok) || 0) + 1);
    return set;
  });
  const vocab = new Map();
  for (const [tok, n] of df) if (n >= minDf) vocab.set(tok, vocab.size);
  const idf = new Float64Array(vocab.size);
  for (const [tok, i] of vocab) idf[i] = Math.log(texts.length / df.get(tok));
  const X = docs.map(set => {
    const v = [];
    for (const tok of set) { const i = vocab.get(tok); if (i !== undefined) v.push([i, idf[i]]); }
    const norm = Math.sqrt(v.reduce((s, [, w]) => s + w * w, 0)) || 1;
    return v.map(([i, w]) => [i, w / norm]);
  });
  return { vocab, idf, X };
}

function trainLR(X, y, idxs, rng, epochs = 40, lr = 0.4, l2 = 1e-4, dim) {
  const w = new Float64Array(dim); let b = 0;
  const order = [...idxs];
  for (let e = 0; e < epochs; e++) {
    order.sort(() => rng() - 0.5);
    for (const i of order) {
      let z = b; for (const [j, v] of X[i]) z += w[j] * v;
      const g = 1 / (1 + Math.exp(-z)) - y[i];
      b -= lr * g;
      for (const [j, v] of X[i]) w[j] -= lr * (g * v + l2 * w[j]);
    }
  }
  return { w, b };
}
const predict = (m, x) => { let z = m.b; for (const [j, v] of x) z += m.w[j] * v; return 1 / (1 + Math.exp(-z)); };

function crossVal(X, y, dim, k = 5, seed = 7) {
  const rng = mulberry32(seed);
  const idx = X.map((_, i) => i).sort(() => rng() - 0.5);
  const probs = new Float64Array(X.length);
  for (let f = 0; f < k; f++) {
    const test = idx.filter((_, j) => j % k === f);
    const testSet = new Set(test);
    const tr = idx.filter(i => !testSet.has(i));
    const m = trainLR(X, y, tr, mulberry32(seed + f), 40, 0.4, 1e-4, dim);
    for (const i of test) probs[i] = predict(m, X[i]);
  }
  return probs;
}

// ── 1. Classification head ───────────────────────────────────────────────────
console.log('\n=== label head: rental vs not_rental ===');
const texts = gold.map(g => byId.get(g.post_id).text || '');
const y = gold.map(g => g.label === 'rental' ? 1 : 0);
const { vocab, idf, X } = buildCorpus(texts);
console.log('docs:', X.length, 'vocab:', vocab.size);

const probs = crossVal(X, y, vocab.size);
const rx = gold.map(g => regexClassifyPost(byId.get(g.post_id).text || '') === 'rental' ? 1 : 0);

function evalSet(name, mask) {
  const idxs = gold.map((_, i) => i).filter(mask);
  const n = idxs.length;
  const acc = f => idxs.filter(f).length / n;
  const mAcc = acc(i => (probs[i] >= 0.5 ? 1 : 0) === y[i]);
  const rAcc = acc(i => rx[i] === y[i]);
  // hybrid: model overrides regex only when confident
  for (const t of [0.85, 0.9, 0.95]) {
    const hAcc = acc(i => ((probs[i] >= t ? 1 : probs[i] <= 1 - t ? 0 : rx[i])) === y[i]);
    console.log(`  [${name}] hybrid@${t}: ${(hAcc * 100).toFixed(1)}%`);
  }
  const rentals = idxs.filter(i => y[i] === 1);
  const recall = rentals.filter(i => probs[i] >= 0.5).length / rentals.length;
  const rxRecall = rentals.filter(i => rx[i] === 1).length / rentals.length;
  const hyRecall = rentals.filter(i =>
    (probs[i] >= 0.9 ? 1 : probs[i] <= 0.1 ? 0 : rx[i]) === 1).length / rentals.length;
  console.log(`  [${name}] n=${n}  model: ${(mAcc * 100).toFixed(1)}%  regex: ${(rAcc * 100).toFixed(1)}%  | rental-recall model ${(recall * 100).toFixed(1)}% / regex ${(rxRecall * 100).toFixed(1)}% / hybrid@0.9 ${(hyRecall * 100).toFixed(1)}%`);
}
evalSet('all', () => true);
evalSet('claude_review', i => gold[i].source === 'claude_review');
evalSet('human', i => gold[i].source === 'human');

// ── 2. Broker head (weak supervision, keyword-masked) ────────────────────────
console.log('\n=== broker head (weakly supervised, keywords masked) ===');
// Keep in sync with lib/regex_extractor.js NO_BROKER_RE / BROKER_RE.
const NO_BROKER_RE = /ללא\s+(?:כל\s+)?(?:דמי\s+|עמלת\s+)?תיווך|ללא\s+מתווכ(?:ים)?|אין\s+(?:דמי\s+|עמלת\s+)?תיווך|בלי\s+(?:דמי\s+|עמלת\s+)?תיווך|לא\s+(?:דמי\s+|עמלת\s+)?מ?תי?ווך|ישיר(?:ות)?\s+מ(?:ה?בעל|ה?דייר|ה?משכיר)|פרטי\s+(?:מ(?:בעל|משכיר|דייר))|מפרטי(?![א-ת])(?!\s+ה)|no\s+(?:broker|fee|commission|agency)|owner\s+only/gi;
const BROKER_RE = /דמי\s+תיווך|עמלת\s+תיווך|מתיווך|מתווכ(?:ים|ת)?|מתווך|שיווק\s+נדל[״"'׳]?ן|תיווך|תווך|מס(?:פר)?['׳]?\s*רישיון|רישיון\s*(?:מס(?:פר)?['׳]?)?\s*[:#]?\s*\d{4,}|listed\s+via\s+agency|real\s+estate|realty/gi;

const brokerRows = [];
for (const g of gold) {
  const t = byId.get(g.post_id).text || '';
  const noB = NO_BROKER_RE.test(t); NO_BROKER_RE.lastIndex = 0;
  const isB = BROKER_RE.test(t); BROKER_RE.lastIndex = 0;
  // no-broker phrases win over the bare broker keywords they contain
  // (ללא תיווך matches both) — same precedence as extractBroker().
  const yLab = noB ? 0 : isB ? 1 : null;
  if (yLab === null) continue;
  const masked = t.replace(NO_BROKER_RE, ' ').replace(BROKER_RE, ' ');
  brokerRows.push({ text: masked, y: yLab });
}
const bTexts = brokerRows.map(r => r.text);
const bY = brokerRows.map(r => r.y);
const bc = buildCorpus(bTexts);
console.log('weak-labeled docs:', bTexts.length,
  `(broker=yes ${bY.filter(v => v).length}, broker=no ${bY.filter(v => !v).length})`, 'vocab:', bc.vocab.size);
const bProbs = crossVal(bc.X, bY, bc.vocab.size, 5, 11);
const bAcc = bY.filter((v, i) => (bProbs[i] >= 0.5 ? 1 : 0) === v).length / bY.length;
console.log(`CV accuracy on masked text: ${(bAcc * 100).toFixed(1)}%`);
for (const t of [0.8, 0.9]) {
  const conf = bY.map((_, i) => i).filter(i => bProbs[i] >= t || bProbs[i] <= 1 - t);
  const cAcc = conf.filter(i => (bProbs[i] >= 0.5 ? 1 : 0) === bY[i]).length / conf.length;
  console.log(`  confident@${t}: coverage ${(conf.length / bY.length * 100).toFixed(0)}%  accuracy ${(cAcc * 100).toFixed(1)}%`);
}

// ── 3. Final models on ALL data + pruned export ──────────────────────────────
console.log('\n=== exporting lib/ml_weights.js ===');
const rngAll = mulberry32(99);
const finalLabel = trainLR(X, y, X.map((_, i) => i), rngAll, 40, 0.4, 1e-4, vocab.size);
const finalBroker = trainLR(bc.X, bY, bc.X.map((_, i) => i), mulberry32(101), 40, 0.4, 1e-4, bc.vocab.size);

function exportHead(model, vocabMap, idfArr, keep) {
  const entries = [...vocabMap.entries()]
    .map(([tok, i]) => [tok, model.w[i], idfArr[i]])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, keep)
    .filter(e => Math.abs(e[1]) > 1e-3);
  const obj = {};
  for (const [tok, w, i] of entries) obj[tok] = [+w.toFixed(4), +i.toFixed(3)];
  return obj;
}
const labelW = exportHead(finalLabel, vocab, idf, 12000);
const brokerW = exportHead(finalBroker, bc.vocab, bc.idf, 6000);

// Verify pruning barely changes predictions (full-precision vs pruned).
import { scoreHead, uniqueTokens } from '../lib/ml_features.js';
let flips = 0;
for (let i = 0; i < gold.length; i++) {
  const full = predict(finalLabel, X[i]) >= 0.5;
  const pruned = scoreHead(labelW, finalLabel.b, uniqueTokens(texts[i])) >= 0.5;
  if (full !== pruned) flips++;
}
console.log(`pruning check: ${flips}/${gold.length} label flips vs full model`);

// Deployment estimate: how much does the broker head fill in where the
// regex extractor returns null? Score those posts and show samples.
import { regexExtractTags } from '../lib/regex_extractor.js';
const nullBroker = gold.filter(g => {
  if (g.label !== 'rental') return false;
  const tags = regexExtractTags(byId.get(g.post_id).text || '');
  return tags && tags.broker == null;
});
let confYes = 0, confNo = 0;
const samples = [];
for (const g of nullBroker) {
  const t = byId.get(g.post_id).text || '';
  const p = scoreHead(
    Object.fromEntries([...bc.vocab.entries()].map(([tok, i]) => [tok, [finalBroker.w[i], bc.idf[i]]])),
    finalBroker.b, uniqueTokens(t));
  if (p >= 0.9) { confYes++; if (samples.length < 10) samples.push([p, g.post_id, t]); }
  else if (p <= 0.1) confNo++;
}
console.log(`\nbroker-null rentals in gold: ${nullBroker.length} → confident yes: ${confYes}, confident no: ${confNo}`);
for (const [p, id, t] of samples) console.log(`  p=${p.toFixed(2)} ${id} :: ${t.replace(/\n+/g, ' ').slice(0, 90)}`);

const out = `// lib/ml_weights.js — GENERATED by ml/train.mjs. Do not edit by hand.
// Retrain with:  node ml/train.mjs <path-to-export.json>
// token: [weight, idf]. Heads are scored by lib/ml_features.js::scoreHead.

export const ML_META = {
  feature_version: 1,
  trained_at: ${JSON.stringify(new Date().toISOString())},
  gold_size: ${gold.length},
  broker_weak_size: ${bTexts.length},
};

export const ML_LABEL_BIAS = ${finalLabel.b.toFixed(5)};
export const ML_LABEL_WEIGHTS = ${JSON.stringify(labelW)};

export const ML_BROKER_BIAS = ${finalBroker.b.toFixed(5)};
export const ML_BROKER_WEIGHTS = ${JSON.stringify(brokerW)};
`;
writeFileSync(join(root, 'lib/ml_weights.js'), out, 'utf8');
console.log('wrote lib/ml_weights.js',
  `(label tokens: ${Object.keys(labelW).length}, broker tokens: ${Object.keys(brokerW).length})`);
