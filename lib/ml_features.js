// lib/ml_features.js — shared text featurization for the ML layer.
//
// This module is imported BOTH by the training script (ml/train.mjs, Node)
// and by the in-extension runtime (lib/ml_classifier.js, service worker).
// Keeping tokenization in one place guarantees train/runtime parity — if the
// tokenizer changes, the model MUST be retrained (bump ML_META.feature_version).
//
// Features: unique unigrams + adjacent bigrams over lowercased text with all
// numbers collapsed to <num>. Hebrew, Latin, and Cyrillic letters are kept
// (the corpus has Russian rental listings); everything else is a separator.

export const FEATURE_VERSION = 1;

export function tokenize(text) {
  const norm = (text || '').toLowerCase()
    .replace(/[0-9][\d,.]*/g, ' <num> ')
    .replace(/[^֐-׿a-zа-я<>₪ ]+/g, ' ');
  const toks = norm.split(/\s+/).filter(t => t.length > 1);
  const grams = [...toks];
  for (let i = 0; i < toks.length - 1; i++) grams.push(toks[i] + '_' + toks[i + 1]);
  return grams;
}

// Unique feature set of a document (presence-based TF-IDF, like training).
export function uniqueTokens(text) {
  return new Set(tokenize(text));
}

// Score a document against one weight head.
// weights: { token: [weight, idf] }, bias: number.
// Vector = idf per present token, L2-normalized — identical to training.
export function scoreHead(weights, bias, tokenSet) {
  let z = bias, norm = 0;
  const hits = [];
  for (const t of tokenSet) {
    const wi = weights[t];
    if (wi !== undefined) { hits.push(wi); norm += wi[1] * wi[1]; }
  }
  norm = Math.sqrt(norm) || 1;
  for (const [w, idf] of hits) z += w * (idf / norm);
  return 1 / (1 + Math.exp(-z));
}
