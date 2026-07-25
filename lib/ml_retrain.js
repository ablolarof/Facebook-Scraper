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
// "Consumed" tracking is intentionally SEPARATE from the regex_miss / Export
// Misses machinery in dashboard.js and lib/bot.js. regex_miss.exported_at
// tracks "already sent to Claude in a miss-fixing prompt" — that pipeline
// edits regex_extractor.js by hand and must stay independent so the same
// correction can still be exported for a regex fix after it has already
// trained the model (or vice versa). Every promoted retrain instead stamps
// the post_ids it trained on into ml_weights.meta.trained_correction_ids, so
// countNewCorrections() can report "N new since the last retrain" without
// touching regex_miss at all.
//
// Entry points:
//   countCorrections(posts)     — total human corrections that exist (for UI).
//   countNewCorrections(posts)  — corrections not yet folded into a promoted
//                                 retrain (chrome.storage.local read).
//   runRetrain(onProgress)      — gather → train → gate → store. Returns a
//                                 summary object; never throws on gate rejection.

import { getAllPosts } from './db.js';
import { buildCorpus, trainLR, crossValProbs, exportHead, mulberry32 } from './ml_train_core.js';
import { NO_BROKER_RE, BROKER_RE } from './regex_extractor.js';
import { FEATURE_VERSION } from './ml_features.js';

export const ML_STORAGE_KEY = 'ml_weights';
// Gold texts imported from a dashboard-export file (one-time, per install).
// The shipped ml/gold_labels.json has ids+labels only — texts are personal
// data and stay OFF the public repo. A fresh extension install (empty IDB)
// has no texts to join the gold ids against, so the user imports their
// export JSON once and the texts are cached here, locally.
export const ML_GOLD_TEXTS_KEY = 'ml_gold_texts';
// Model-alone CV accuracy of the shipped (bundled) weights — the initial gate.
const BASELINE_CV = 0.965;
const GATE_EPSILON = 0.005;
// A retrain may only PROMOTE if at least this many gold-labeled texts were
// resolvable. Without this, a fresh install trains on a handful of posts,
// scores a meaningless CV on its tiny set, and replaces the good bundled
// weights with garbage (observed live: 212 rows → 99.5% "accuracy" → every
// short post classified rental at p=0.936).
export const MIN_GOLD_ROWS = 2000;

const isCorrection = p =>
  Boolean(p.human_label) || typeof p.tags_human_override?.broker === 'boolean';

export function countCorrections(posts) {
  return posts.filter(isCorrection).length;
}

// Corrections that have not yet been folded into a PROMOTED retrain. On a
// fresh install (no stored weights yet) everything counts as new. Rejected
// retrains never advance trained_correction_ids, so their corrections keep
// counting as new next time too — the badge should reflect what the ACTIVE
// model actually knows, not what the last training attempt saw.
export async function countNewCorrections(posts) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return countCorrections(posts);
  const stored = (await chrome.storage.local.get(ML_STORAGE_KEY))[ML_STORAGE_KEY];
  const trained = new Set(isValidStoredWeights(stored)
    ? stored.meta.trained_correction_ids || [] : []);
  return posts.filter(p => isCorrection(p) && !trained.has(p.post_id)).length;
}

async function loadGoldLabels() {
  const res = await fetch(chrome.runtime.getURL('ml/gold_labels.json'));
  return (await res.json()).labels;
}

// Stored weights are only trustworthy if they were trained with enough gold
// data — anything else is a degenerate model that must not be used as the
// active weights OR as the gate bar for future retrains.
export function isValidStoredWeights(stored) {
  return Boolean(stored?.label?.weights) &&
    (stored.meta?.label_rows ?? 0) >= MIN_GOLD_ROWS;
}

// One-time import of gold TEXTS from a dashboard export JSON (the file the
// user keeps locally, e.g. tlv-rentals-2026-07-18.json). Only texts whose
// post_id appears in the shipped gold set are kept; stored in
// chrome.storage.local, never leaves the machine.
export async function importGoldTexts(jsonText) {
  const parsed = JSON.parse(jsonText);
  const posts = Array.isArray(parsed) ? parsed : parsed.posts;
  if (!Array.isArray(posts)) throw new Error('Not a dashboard export file (expected an array of posts).');
  const gold = await loadGoldLabels();
  const goldIds = new Set(gold.map(g => g.post_id));
  const texts = {};
  for (const p of posts) {
    if (goldIds.has(p.post_id) && (p.text || '').trim()) texts[p.post_id] = p.text;
  }
  const imported = Object.keys(texts).length;
  if (imported === 0) throw new Error('No gold-set posts found in that file.');
  await chrome.storage.local.set({ [ML_GOLD_TEXTS_KEY]: texts });
  return { imported, gold_total: gold.length };
}

// How many gold labels can currently be joined to a text (IDB or imported)?
export async function goldCoverage() {
  const gold = await loadGoldLabels();
  const posts = await getAllPosts();
  const ids = new Set(posts.filter(p => (p.text || '').trim()).map(p => p.post_id));
  const cached = (await chrome.storage.local.get(ML_GOLD_TEXTS_KEY))[ML_GOLD_TEXTS_KEY] || {};
  const have = gold.filter(g => ids.has(g.post_id) || cached[g.post_id]).length;
  return { have, total: gold.length, min_required: MIN_GOLD_ROWS };
}

// Assemble both heads' training rows from IndexedDB posts + shipped gold.
// Pure given its inputs — ml/selftest can drive it with an export file.
export function assembleTrainingData(posts, goldLabels, goldTexts = {}) {
  const byId = new Map(posts.map(p => [p.post_id, p]));
  const correctionIds = new Set(); // for countNewCorrections' trained_correction_ids

  // ── label head rows ──
  // Each row carries src: 'gold' | 'correction'. The promotion gate measures
  // accuracy on the gold rows ONLY — a fixed benchmark that stays comparable
  // across retrains (corrections are by construction the hardest posts, so a
  // metric over the whole pool would drop as corrections accumulate even
  // when the model is improving).
  //
  // src records id provenance (in the shipped gold file or not) — NOT whether
  // a human touched the label. A corrected gold post stays src:'gold', scored
  // against its human_label (the better ground truth; evaluation is out-of-
  // fold via crossValProbs, so this is honest). Before 2026-07-25 a gold-post
  // correction flipped src to 'correction' and silently REMOVED the row from
  // the benchmark — 83 of the hardest rows had already eroded away, making
  // successive gate scores incomparable (measured bias then: ~0.06pt).
  const labelRows = [];
  const seen = new Set();
  let humanCount = 0;
  for (const g of goldLabels) {
    const p = byId.get(g.post_id);
    const text = (p?.text || '').trim() ? p.text : goldTexts[g.post_id];
    if (!text) continue;
    const label = p?.human_label || g.label;         // human overrides gold
    labelRows.push({ text, y: label === 'rental' ? 1 : 0, src: 'gold' });
    seen.add(g.post_id);
    if (p?.human_label) { humanCount++; correctionIds.add(p.post_id); }
  }
  // Corrections on posts outside the gold file (new scrapes, dupes the user
  // labeled anyway) — every one of them is training signal.
  for (const p of posts) {
    if (seen.has(p.post_id) || !p.human_label || !(p.text || '').trim()) continue;
    labelRows.push({ text: p.text, y: p.human_label === 'rental' ? 1 : 0, src: 'correction' });
    humanCount++;
    correctionIds.add(p.post_id);
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
      correctionIds.add(p.post_id);
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
  // Imported gold texts feed the broker head too — without this, a fresh
  // install trains the broker head on its few IDB posts only (~121 rows vs
  // ~1,100) while the label head enjoys the full gold set.
  for (const [id, text] of Object.entries(goldTexts)) {
    if (byId.has(id) || !(text || '').trim()) continue;   // IDB copy already handled
    const noB = NO_BROKER_RE.test(text);
    const isB = BROKER_RE.test(text);
    const yLab = noB ? 0 : isB ? 1 : null;
    if (yLab === null) continue;
    brokerRows.push({ text: text.replace(noBrokerG, ' ').replace(brokerG, ' '), y: yLab });
  }

  return { labelRows, brokerRows, humanCount, correctionIds };
}

// Train both heads, cross-validate the label head, apply the gold gate.
// The gate metric is accuracy over the GOLD rows only (fixed benchmark).
export function trainAndGate(labelRows, brokerRows, prevCv) {
  const goldIdx = labelRows.map((r, i) => r.src === 'gold' ? i : -1).filter(i => i >= 0);
  if (goldIdx.length < MIN_GOLD_ROWS) {
    return { promoted: false, needs_import: true, cv: null, floor: null, reason:
      `Only ${goldIdx.length} of the ${MIN_GOLD_ROWS}+ required gold training texts ` +
      `are available on this install. Import your dashboard export file once ` +
      `(dashboard → 🧠 Retrain ML will offer it) so the model can train on the full gold set.` };
  }

  const texts = labelRows.map(r => r.text);
  const y = labelRows.map(r => r.y);
  const { vocab, idf, X } = buildCorpus(texts);

  const probs = crossValProbs(X, y, vocab.size);
  const cv = goldIdx.filter(i => (probs[i] >= 0.5 ? 1 : 0) === y[i]).length / goldIdx.length;

  // The bar rises with a genuinely better promoted model but never drops
  // below the bundled baseline — without the max(), each promotion could sit
  // GATE_EPSILON under the previous one and ratchet the gate downward
  // indefinitely (0.5pt per retrain of pure noise).
  const floor = Math.max(BASELINE_CV, prevCv ?? BASELINE_CV) - GATE_EPSILON;
  if (cv < floor) {
    return { promoted: false, cv, floor, reason:
      `Gold-benchmark accuracy ${(cv * 100).toFixed(1)}% is below the gate ` +
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
      cv_accuracy: +cv.toFixed(4),      // gold-benchmark accuracy (fixed set)
      label_rows: labelRows.length,
      gold_rows: goldIdx.length,
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
  const goldTexts = (await chrome.storage.local.get(ML_GOLD_TEXTS_KEY))[ML_GOLD_TEXTS_KEY] || {};
  const { labelRows, brokerRows, humanCount, correctionIds } =
    assembleTrainingData(posts, gold, goldTexts);

  onProgress(`Training on ${labelRows.length} posts (${humanCount} corrections)…`);
  const stored = (await chrome.storage.local.get(ML_STORAGE_KEY))[ML_STORAGE_KEY];
  // A degenerate stored payload (trained pre-guard on too little data) must
  // neither raise nor lower the bar — fall back to the bundled baseline.
  const prevCv = isValidStoredWeights(stored) ? stored.meta.cv_accuracy : undefined;
  const prevTrainedIds = new Set(isValidStoredWeights(stored)
    ? stored.meta.trained_correction_ids || [] : []);
  const newCorrections = [...correctionIds].filter(id => !prevTrainedIds.has(id)).length;

  const result = trainAndGate(labelRows, brokerRows, prevCv);

  if (result.promoted) {
    // Stamp which corrections this promotion covers — independent of
    // regex_miss/exported_at, see the module header.
    result.payload.meta.trained_correction_ids = [...correctionIds];
    await chrome.storage.local.set({ [ML_STORAGE_KEY]: result.payload });
  }
  return {
    promoted: result.promoted,
    needs_import: result.needs_import || false,
    cv_accuracy: result.cv,
    previous_cv: prevCv ?? BASELINE_CV,
    reason: result.reason || null,
    label_rows: labelRows.length,
    gold_rows: labelRows.filter(r => r.src === 'gold').length,
    broker_rows: brokerRows.length,
    corrections: humanCount,
    new_corrections: newCorrections,
  };
}
