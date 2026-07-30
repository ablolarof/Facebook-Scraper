// lib/ml_weights_export.js — turn promoted (chrome.storage.local) weights back
// into the bundled lib/*_weights.js modules, so a retrain can be committed.
//
// Why this exists
// ---------------
// Retraining promotes to chrome.storage.local, which is per-install runtime
// state: the model your extension actually scores with is invisible to git,
// and a fresh clone falls back to whatever was last bundled. Without this,
// publishing a retrain meant dumping JSON from the console and hand-editing
// three generated files.
//
// The output is byte-for-byte the format the offline trainers emit, so the two
// paths produce interchangeable files and a diff between them is meaningful
// rather than noise.

export const WEIGHT_EXPORTS = [
  { key: 'ml_weights',           file: 'ml_weights.js' },
  { key: 'ml_price_weights',     file: 'ml_price_weights.js' },
  { key: 'ml_roommates_weights', file: 'ml_roommates_weights.js' },
];

const j = o => JSON.stringify(o);

function labelFile(p) {
  // trained_correction_ids is per-install bookkeeping for countNewCorrections().
  // Shipping it would make a fresh install believe those corrections were
  // already folded in — its retrain badge would read zero and they would never
  // train that install's model. It also publishes a few hundred post ids for
  // no benefit.
  const { trained_correction_ids, ...meta } = p.meta || {};
  return `// lib/ml_weights.js — GENERATED. Do not edit by hand.
// Bundled from weights retrained IN-EXTENSION (dashboard 🧠 Retrain ML) and
// exported with 💾 Export Weights. Regenerate offline with:
//   node ml/train.mjs <path-to-export.json>
// token: [weight, idf]. Heads are scored by lib/ml_features.js::scoreHead.

export const ML_META = ${j(meta)};

export const ML_LABEL_BIAS = ${p.label.bias};
export const ML_LABEL_WEIGHTS = ${j(p.label.weights)};

export const ML_BROKER_BIAS = ${p.broker.bias};
export const ML_BROKER_WEIGHTS = ${j(p.broker.weights)};
`;
}

const priceFile = p => `// lib/ml_price_weights.js — GENERATED. Do not edit by hand.
// Bundled from weights retrained IN-EXTENSION (dashboard 🧠 Retrain ML) and
// exported with 💾 Export Weights. Regenerate offline with:
//   node ml/train_price.mjs <path-to-export.json>
// feature: weight. Scored by lib/ml_price.js::scorePriceCandidate.

export const ML_PRICE_META = ${j(p.meta)};

export const ML_PRICE_BIAS = ${p.bias};
export const ML_PRICE_WEIGHTS = ${j(p.weights)};
`;

const roommatesFile = p => `// lib/ml_roommates_weights.js — GENERATED. Do not edit by hand.
// Bundled from weights retrained IN-EXTENSION (dashboard 🧠 Retrain ML) and
// exported with 💾 Export Weights. Regenerate offline with:
//   node ml/train_roommates.mjs <path-to-export.json>
// token: [weight, idf]. Scored by lib/ml_features.js::scoreHead.

export const ML_ROOMMATES_META = ${j(p.meta)};

export const ML_ROOMMATES_BIAS = ${p.bias};
export const ML_ROOMMATES_WEIGHTS = ${j(p.weights)};
`;

const BUILDERS = {
  ml_weights: labelFile,
  ml_price_weights: priceFile,
  ml_roommates_weights: roommatesFile,
};

/**
 * Build the module files for every head that has promoted weights stored.
 *
 * Heads with nothing promoted are SKIPPED rather than emitted empty — the
 * bundled file already in the repo is the better artifact in that case, and
 * overwriting it with a stub would silently downgrade the shipped model.
 *
 * @param {object} stored  chrome.storage.local contents (or any equivalent map)
 * @returns {{files: {name:string, content:string}[], skipped: string[]}}
 */
export function buildWeightFiles(stored) {
  const files = [], skipped = [];
  for (const { key, file } of WEIGHT_EXPORTS) {
    const payload = stored?.[key];
    const ok = payload && (payload.weights || payload.label?.weights);
    if (!ok) { skipped.push(key); continue; }
    files.push({ name: file, content: BUILDERS[key](payload) });
  }
  return { files, skipped };
}

/** One-line provenance summary per head, for the confirmation dialog. */
export function describeStoredWeights(stored) {
  return WEIGHT_EXPORTS.map(({ key }) => {
    const m = stored?.[key]?.meta;
    if (!m) return `${key}: none promoted — the bundled file stays as-is`;
    const when = m.trained_at ? new Date(m.trained_at).toLocaleString() : '?';
    const score = m.cv_accuracy != null ? `CV ${(m.cv_accuracy * 100).toFixed(2)}%`
      : m.heldout_precision != null ? `held-out precision ${(m.heldout_precision * 100).toFixed(1)}%`
      : m.heldout_accuracy != null ? `held-out accuracy ${(m.heldout_accuracy * 100).toFixed(1)}%` : '';
    const rows = m.gold_rows ?? m.train_posts ?? '?';
    return `${key}: ${when} · ${rows} rows${score ? ' · ' + score : ''}`;
  });
}
