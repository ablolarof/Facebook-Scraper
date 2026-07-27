// lib/ml_roommates.js — shadow-mode roommates head.
//
// Shape: a plain binary document classifier, same as the broker head — TF-IDF
// over word+bigram features, one logistic-regression probability out. Unlike
// price, roommates needs no candidate ranking because the answer is yes/no.
//
// Why the keywords are MASKED during training
// -------------------------------------------
// The only available labels come from ROOMMATES_RE. Training on those labels
// with the keywords still in the text would teach the model to detect the
// keyword — it would agree with the regex by construction, and its
// disagreements (the entire point of shadow mode) would be noise rather than
// signal. So the matched keyword spans are blanked out first and the model has
// to decide from everything else: the register of a room-share post
// (roommate ages and genders, "the room", per-room pricing, shared kitchen,
// who is staying/leaving) rather than the trigger phrase.
//
// This mirrors lib/ml_retrain.js's broker head exactly, which is trained on
// keyword-labeled posts with NO_BROKER_RE/BROKER_RE masked for the same
// reason. Treat the two as one pattern — if this masking discipline is
// weakened, the head stops being an independent opinion.
//
// Standing on the regex's shoulders is deliberate. extractRoommates made zero
// errors across 28 hand-checked hard cases (room-shares, whole flats marketed
// to sharers, and "חניה משותפת" false-positive bait), so this head is NOT
// expected to beat it out of the gate. Its job in shadow mode is to disagree
// occasionally and let a human adjudicate — which is why ml_shadow.js scores
// it against the regex on the same reviewed posts instead of a fixed bar.

import { uniqueTokens, scoreHead } from './ml_features.js';
import { ROOMMATES_RE } from './regex_extractor.js';
import {
  ML_ROOMMATES_META, ML_ROOMMATES_BIAS, ML_ROOMMATES_WEIGHTS,
} from './ml_roommates_weights.js';

export const ROOMMATES_FEATURE_VERSION = 1;
export const ROOMMATES_STORAGE_KEY = 'ml_roommates_weights';

/**
 * Blank out every roommate keyword span. Shared by training and by any
 * diagnostic that wants to see what the model actually reads — the runtime
 * does NOT mask (a live post keeps its keywords; masking exists to stop the
 * model leaning on them while learning).
 */
export function maskRoommateKeywords(text) {
  const g = new RegExp(ROOMMATES_RE.source, 'gi');
  return (text || '').replace(g, ' ');
}

let ACTIVE = {
  source: ML_ROOMMATES_META?.stub ? 'stub' : 'bundled',
  meta: ML_ROOMMATES_META,
  weights: ML_ROOMMATES_WEIGHTS,
  bias: ML_ROOMMATES_BIAS,
};

export function activeRoommatesMeta() {
  return { source: ACTIVE.source, ...ACTIVE.meta };
}

export async function loadStoredRoommatesWeights() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return ACTIVE.source;
  try {
    const stored = (await chrome.storage.local.get(ROOMMATES_STORAGE_KEY))[ROOMMATES_STORAGE_KEY];
    if (stored?.weights &&
        stored.meta?.roommates_feature_version === ROOMMATES_FEATURE_VERSION) {
      ACTIVE = { source: 'retrained', meta: stored.meta, weights: stored.weights, bias: stored.bias };
    }
  } catch (err) {
    console.warn('[TLV Rentals] Failed to load stored roommates weights:', err);
  }
  return ACTIVE.source;
}

/**
 * Shadow prediction. Always returns a definite boolean so it can be compared
 * against the regex on every post — ml_shadow.js records the probability
 * separately, and low-confidence predictions simply show as such rather than
 * being withheld. (Contrast with price, where abstaining is the safe default;
 * here there is no null to fall back to — extractRoommates never returns one.)
 *
 * @returns {{ value: boolean, prob: number }}
 */
export function predictRoommates(text) {
  const prob = scoreHead(ACTIVE.weights, ACTIVE.bias, uniqueTokens(text || ''));
  return { value: prob >= 0.5, prob: +prob.toFixed(3) };
}

/** Live weight head, for introspection (devtools Weights tab). */
export function activeRoommatesWeights() { return ACTIVE.weights; }

/**
 * Which tokens pushed this post toward / away from "room share", for the
 * devtools Reasoning tab. Mirrors the contribution maths in scoreHead: each
 * present token contributes weight × (idf / L2-norm), so the numbers here sum
 * to the logit and can be read directly against the bias.
 */
export function explainRoommates(text, n = 12) {
  const tokens = uniqueTokens(text || '');
  let norm = 0;
  const hits = [];
  for (const t of tokens) {
    const wi = ACTIVE.weights[t];
    if (wi !== undefined) { hits.push([t, wi[0], wi[1]]); norm += wi[1] * wi[1]; }
  }
  norm = Math.sqrt(norm) || 1;
  const contribs = hits
    .map(([t, w, idf]) => ({ token: t, contribution: +(w * (idf / norm)).toFixed(4) }))
    .sort((a, b) => b.contribution - a.contribution);
  const { value, prob } = predictRoommates(text);
  return {
    value, prob,
    towardRoommates: contribs.filter(c => c.contribution > 0).slice(0, n),
    towardWhole:     contribs.filter(c => c.contribution < 0).slice(-n).reverse(),
    matchedTokens: hits.length,
  };
}
