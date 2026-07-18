// ml/train.mjs — offline trainer/evaluator for the ML layer (Node).
//
// Usage:  node ml/train.mjs <path-to-export.json>
//
// Reads:  ml/gold_labels.json  (post_id → rental/not_rental gold labels)
//         the export JSON      (post texts; NOT committed to the repo)
// Writes: lib/ml_weights.js    (generated bundled-weights module)
//
// The actual training machinery lives in lib/ml_train_core.js and is shared
// with the in-extension retrain (lib/ml_retrain.js — dashboard 🧠 button and
// Telegram /retrain), so offline and in-extension training cannot diverge.
// This script adds what only makes sense offline: the full evaluation report
// (model vs regex vs hybrid, per gold subset) and the bundled-weights export.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scoreHead, uniqueTokens } from '../lib/ml_features.js';
import {
  buildCorpus, trainLR, predictRow, crossValProbs, exportHead, mulberry32,
} from '../lib/ml_train_core.js';
import { regexClassifyPost, regexExtractTags, NO_BROKER_RE, BROKER_RE }
  from '../lib/regex_extractor.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exportPath = process.argv[2];
if (!exportPath) { console.error('Usage: node ml/train.mjs <path-to-export.json>'); process.exit(1); }

const posts = JSON.parse(readFileSync(exportPath, 'utf8'));
const byId = new Map(posts.map(p => [p.post_id, p]));
const gold = JSON.parse(readFileSync(join(root, 'ml/gold_labels.json'), 'utf8')).labels
  .filter(g => byId.has(g.post_id));
console.log('gold labels with text available:', gold.length);

// ── 1. Label head: train + evaluate ──────────────────────────────────────────
console.log('\n=== label head: rental vs not_rental ===');
const texts = gold.map(g => byId.get(g.post_id).text || '');
const y = gold.map(g => g.label === 'rental' ? 1 : 0);
const { vocab, idf, X } = buildCorpus(texts);
console.log('docs:', X.length, 'vocab:', vocab.size);

const probs = crossValProbs(X, y, vocab.size);
const rx = gold.map(g => regexClassifyPost(byId.get(g.post_id).text || '') === 'rental' ? 1 : 0);

function evalSet(name, mask) {
  const idxs = gold.map((_, i) => i).filter(mask);
  const n = idxs.length;
  const acc = f => idxs.filter(f).length / n;
  const mAcc = acc(i => (probs[i] >= 0.5 ? 1 : 0) === y[i]);
  const rAcc = acc(i => rx[i] === y[i]);
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
const noBrokerG = new RegExp(NO_BROKER_RE.source, 'gi');
const brokerG   = new RegExp(BROKER_RE.source, 'gi');
const brokerRows = [];
for (const g of gold) {
  const t = byId.get(g.post_id).text || '';
  const noB = NO_BROKER_RE.test(t);
  const isB = BROKER_RE.test(t);
  // no-broker phrases win over the broker keywords they contain (ללא תיווך) —
  // same precedence as extractBroker().
  const yLab = noB ? 0 : isB ? 1 : null;
  if (yLab === null) continue;
  brokerRows.push({ text: t.replace(noBrokerG, ' ').replace(brokerG, ' '), y: yLab });
}
const bTexts = brokerRows.map(r => r.text);
const bY = brokerRows.map(r => r.y);
const bc = buildCorpus(bTexts);
console.log('weak-labeled docs:', bTexts.length,
  `(broker=yes ${bY.filter(v => v).length}, broker=no ${bY.filter(v => !v).length})`, 'vocab:', bc.vocab.size);
const bProbs = crossValProbs(bc.X, bY, bc.vocab.size, 5, 11);
const bAcc = bY.filter((v, i) => (bProbs[i] >= 0.5 ? 1 : 0) === v).length / bY.length;
console.log(`CV accuracy on masked text: ${(bAcc * 100).toFixed(1)}%`);
for (const t of [0.8, 0.9]) {
  const conf = bY.map((_, i) => i).filter(i => bProbs[i] >= t || bProbs[i] <= 1 - t);
  const cAcc = conf.filter(i => (bProbs[i] >= 0.5 ? 1 : 0) === bY[i]).length / conf.length;
  console.log(`  confident@${t}: coverage ${(conf.length / bY.length * 100).toFixed(0)}%  accuracy ${(cAcc * 100).toFixed(1)}%`);
}

// ── 3. Final models on ALL data + pruned export ──────────────────────────────
console.log('\n=== exporting lib/ml_weights.js ===');
const finalLabel = trainLR(X, y, X.map((_, i) => i), mulberry32(99), vocab.size);
const finalBroker = trainLR(bc.X, bY, bc.X.map((_, i) => i), mulberry32(101), bc.vocab.size);
const labelW = exportHead(finalLabel, vocab, idf, 12000);
const brokerW = exportHead(finalBroker, bc.vocab, bc.idf, 6000);

let flips = 0;
for (let i = 0; i < gold.length; i++) {
  const full = predictRow(finalLabel, X[i]) >= 0.5;
  const pruned = scoreHead(labelW, finalLabel.b, uniqueTokens(texts[i])) >= 0.5;
  if (full !== pruned) flips++;
}
console.log(`pruning check: ${flips}/${gold.length} label flips vs full model`);

// Deployment estimate: broker fill-in on rentals where regex says null.
const nullBroker = gold.filter(g => {
  if (g.label !== 'rental') return false;
  const tags = regexExtractTags(byId.get(g.post_id).text || '');
  return tags && tags.broker == null;
});
let confYes = 0, confNo = 0;
for (const g of nullBroker) {
  const p = scoreHead(brokerW, finalBroker.b, uniqueTokens(byId.get(g.post_id).text || ''));
  if (p >= 0.9) confYes++;
  else if (p <= 0.1) confNo++;
}
console.log(`broker-null rentals in gold: ${nullBroker.length} → confident yes: ${confYes}, confident no: ${confNo}`);

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
