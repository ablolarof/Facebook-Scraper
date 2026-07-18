// lib/ml_train_core.js — pure training machinery for the ML layer.
//
// Shared by ml/train.mjs (Node), lib/ml_retrain.js (dashboard + bot /retrain),
// so the offline trainer and the in-extension retrain can never diverge.
// No I/O, no chrome APIs — inputs in, weights out.

import { tokenize } from './ml_features.js';

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Presence-based TF-IDF corpus over unique uni+bigrams (min document freq 3).
export function buildCorpus(texts, minDf = 3) {
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

// Logistic regression via SGD with L2. idxs selects the training rows.
export function trainLR(X, y, idxs, rng, dim, epochs = 40, lr = 0.4, l2 = 1e-4) {
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

export const predictRow = (m, x) => {
  let z = m.b; for (const [j, v] of x) z += m.w[j] * v;
  return 1 / (1 + Math.exp(-z));
};

// k-fold cross-validation → out-of-fold probability per row.
export function crossValProbs(X, y, dim, k = 5, seed = 7) {
  const rng = mulberry32(seed);
  const idx = X.map((_, i) => i).sort(() => rng() - 0.5);
  const probs = new Float64Array(X.length);
  for (let f = 0; f < k; f++) {
    const test = idx.filter((_, j) => j % k === f);
    const testSet = new Set(test);
    const tr = idx.filter(i => !testSet.has(i));
    const m = trainLR(X, y, tr, mulberry32(seed + f), dim);
    for (const i of test) probs[i] = predictRow(m, X[i]);
  }
  return probs;
}

// Prune a trained head to its strongest tokens: { token: [weight, idf] }.
export function exportHead(model, vocab, idf, keep) {
  const entries = [...vocab.entries()]
    .map(([tok, i]) => [tok, model.w[i], idf[i]])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, keep)
    .filter(e => Math.abs(e[1]) > 1e-3);
  const obj = {};
  for (const [tok, w, i] of entries) obj[tok] = [+w.toFixed(4), +i.toFixed(3)];
  return obj;
}
