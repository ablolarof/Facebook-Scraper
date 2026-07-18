// lib/ml_retrain.js — in-extension retraining of the ML layer.
//
// This is what makes the model continuously trainable from the dashboard and
// from Telegram: every correction the user makes (dashboard label buttons /
// ✏ tag editor / Telegram 🚩 Miss) is stored on the post row in IndexedDB,
// and a retrain folds all of them into fresh weights — locally, in seconds,
// no network.
//
// Training-data rules (agreed design, do not weaken):
//   1. NEVER train on the model's own output (ai_label is ignored entirely).
//      Labels come only from ml/gold_labels.json and human_label corrections.
//   2. human_label always wins over the shipped gold label.
//   3. Gold gate: new weights are promoted only if their cross-validated
//      accuracy is not meaningfully below the current weights' score
//      (small epsilon allows normal CV noise). Rejected weights are
//      discarded and the previous ones stay active.
//
// Entry points:
//   countCorrections(posts) — how many human corrections exist (for UI).
//   runRetrain(onProgress)  — gather → train → gate → store. Returns a
//                             summary object; never throws on gate rejection.

import { getAllPosts } from './db.js';
import { buildCorpus, trainLR, crossValProbs, exportHead, mulberry32 } from './ml_train_core.js';
import { NO_BROKER_RE, BROKER_RE } from './regex_extractor.js';
import { FEATURE_VERSION } from './ml_features.js';

export const ML_STORAGE_KEY = 'ml_weights';
// Model-alone CV accuracy of the shipped (bundled) weights — the initial gate.
const BASELINE_CV = 0.965;
const GATE_EPSILON = 0.005;

export function countCorrections(posts) {
  return posts.filter(p =>
    p.human_label || typeof p.tags_human_override?.broker === 'boolean').length;
}

async function loadGoldLabels() {
  const res = await fetch(chrome.runtime.getURL('ml/gold_labels.json'));
  return (await res.json()).labels;
}

// Assemble both heads' training rows from IndexedDB posts + shipped gold.
// Pure given its inputs — ml/selftest can drive it with an export file.
export function assembleTrainingData(posts, goldLabels) {
  const byId = new Map(posts.map(p => [p.post_id, p]));

  // ── label head rows ──
  const labelRows = [];
  const seen = new Set();
  let humanCount = 0;
  for (const g of goldLabels) {
    const p = byId.get(g.post_id);
    if (!p || !(p.text || '').trim()) continue;
    const label = p.human_label || g.label;          // human overrides gold
    labelRows.push({ text: p.text, y: label === 'rental' ? 1 : 0 });
    seen.add(g.post_id);
    if (p.human_label) humanCount++;
  }
  // Corrections on posts outside the gold file (new scrapes, dupes the user
  // labeled anyway) — every one of them is training signal.
  for (const p of posts) {
    if (seen.has(p.post_id) || !p.human_label || !(p.text || '').trim()) continue;
    labelRows.push({ text: p.text, y: p.human_label === 'rental' ? 1 : 0 });
    humanCount++;
  }

  // ── broker head rows (weak keyword supervision, keywords masked) ──
  const noBrokerG = new RegExp(NO_BROKER_RE.source, 'gi');
  const brokerG   = new RegExp(BROKER_RE.source, 'gi');
  const brokerRows = [];
  for (const p of posts) {
    if (p.is_duplicate || !(p.text || '').trim()) continue;
    const human = p.tags_human_override?.broker;
    let yLab = null;
    if (typeof human === 'boolean') {
      yLab = human ? 1 : 0;                          // human broker correction
    } else {
      const noB = NO_BROKER_RE.test(p.text);
      const isB = BROKER_RE.test(p.text);
      // no-broker phrases win over the broker keywords they contain (ללא תיווך)
      yLab = noB ? 0 : isB ? 1 : null;
    }
    if (yLab === null) continue;
    const masked = p.text.replace(noBrokerG, ' ').replace(brokerG, ' ');
    brokerRows.push({ text: masked, y: yLab });
  }

  return { labelRows, brokerRows, humanCount };
}

// Train both heads, cross-validate the label head, apply the gold gate.
export function trainAndGate(labelRows, brokerRows, prevCv) {
  const texts = labelRows.map(r => r.text);
  const y = labelRows.map(r => r.y);
  const { vocab, idf, X } = buildCorpus(texts);

  const probs = crossValProbs(X, y, vocab.size);
  const cv = y.filter((v, i) => (probs[i] >= 0.5 ? 1 : 0) === v).length / y.length;

  const floor = (prevCv ?? BASELINE_CV) - GATE_EPSILON;
  if (cv < floor) {
    return { promoted: false, cv, floor, reason:
      `CV accuracy ${(cv * 100).toFixed(1)}% is below the gate ` +
      `(${(floor * 100).toFixed(1)}%) — keeping the current weights.` };
  }

  const label = trainLR(X, y, X.map((_, i) => i), mulberry32(99), vocab.size);

  const bTexts = brokerRows.map(r => r.text);
  const bY = brokerRows.map(r => r.y);
  const bc = buildCorpus(bTexts);
  const broker = trainLR(bc.X, bY, bc.X.map((_, i) => i), mulberry32(101), bc.vocab.size);

  const payload = {
    meta: {
      feature_version: FEATURE_VERSION,
      trained_at: new Date().toISOString(),
      cv_accuracy: +cv.toFixed(4),
      label_rows: labelRows.length,
      broker_rows: brokerRows.length,
    },
    label:  { bias: +label.b.toFixed(5),  weights: exportHead(label, vocab, idf, 12000) },
    broker: { bias: +broker.b.toFixed(5), weights: exportHead(broker, bc.vocab, bc.idf, 6000) },
  };
  return { promoted: true, cv, floor, payload };
}

// Full pipeline against live extension state. onProgress(text) is optional.
export async function runRetrain(onProgress = () => {}) {
  onProgress('Loading posts…');
  const posts = await getAllPosts();
  const gold = await loadGoldLabels();
  const { labelRows, brokerRows, humanCount } = assembleTrainingData(posts, gold);

  onProgress(`Training on ${labelRows.length} posts (${humanCount} corrections)…`);
  const stored = (await chrome.storage.local.get(ML_STORAGE_KEY))[ML_STORAGE_KEY];
  const prevCv = stored?.meta?.cv_accuracy;
  const result = trainAndGate(labelRows, brokerRows, prevCv);

  if (result.promoted) {
    await chrome.storage.local.set({ [ML_STORAGE_KEY]: result.payload });
  }
  return {
    promoted: result.promoted,
    cv_accuracy: result.cv,
    previous_cv: prevCv ?? BASELINE_CV,
    reason: result.reason || null,
    label_rows: labelRows.length,
    broker_rows: brokerRows.length,
    corrections: humanCount,
  };
}
