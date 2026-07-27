// devtools/devtools_core.js — pure computation shared by BOTH devtools shells.
//
// Two front-ends render this:
//   * devtools/devtools.html — an EXTENSION page (no Node, reads live IndexedDB
//     and chrome.storage). This is the normal way to use devtools.
//   * devtools/server.mjs    — the original Node server, still supported for
//     working against an exported JSON file offline.
//
// Everything here is pure: posts in, numbers out. No chrome APIs, no fs, no
// http — that is what lets one implementation serve both, so the two shells
// can never disagree about what a statistic means.

import { regexExtractTags, regexClassifyPost } from '../lib/regex_extractor.js';
import { mlHybridLabel, mlBrokerProb, mlBrokerFill, ML_CONFIDENCE, BROKER_CONFIDENCE }
  from '../lib/ml_classifier.js';
import { uniqueTokens } from '../lib/ml_features.js';
import { ML_META, ML_LABEL_WEIGHTS, ML_BROKER_WEIGHTS } from '../lib/ml_weights.js';
import {
  scoreShadow, reviewQueueCount, readShadow, shadowLeakCheck,
  SHADOW_FIELDS, SHADOW_TARGETS,
} from '../lib/ml_shadow.js';
import { ML_PRICE_META } from '../lib/ml_price_weights.js';
import { ML_ROOMMATES_META } from '../lib/ml_roommates_weights.js';
import { explainPrice, activePriceWeights, activePriceMeta, PRICE_SHADOW_EMIT, PRICE_CONFIDENCE }
  from '../lib/ml_price.js';
import { explainRoommates, activeRoommatesWeights, activeRoommatesMeta }
  from '../lib/ml_roommates.js';

// ── Stats ────────────────────────────────────────────────────────────────

function effectiveLabel(post) {
  const label = post.human_label || post.ai_label;
  return label || 'unlabeled';
}

export function computeStats(posts) {
  const total = posts.length;
  const byLabel = { rental: 0, not_rental: 0, unlabeled: 0 };
  const byClassifiedBy = {};
  let mlOverrides = 0, mlClassified = 0;
  let duplicates = 0;
  let missesTotal = 0, missesPending = 0;
  const tagFields = ['price', 'rooms', 'size', 'entry_date', 'roommates', 'broker'];
  const tagCounts = Object.fromEntries(tagFields.map(f => [f, 0]));
  let rentalCount = 0;
  let brokerFromRegex = 0, brokerFromMl = 0;
  let enrichOk = 0, enrichFailed = 0;
  let notifySent = 0, notifyFailed = 0;

  for (const p of posts) {
    byLabel[effectiveLabel(p)]++;

    const by = p.ai_classified_by || 'none';
    byClassifiedBy[by] = (byClassifiedBy[by] || 0) + 1;
    if (by === 'ml') { mlClassified++; mlOverrides++; }

    if (p.is_duplicate) duplicates++;

    if (p.regex_miss) {
      missesTotal++;
      if (!p.regex_miss.exported_at) missesPending++;
    }

    if (effectiveLabel(p) === 'rental') {
      rentalCount++;
      const tags = p.tags_human_override
        ? { ...p.tags, ...p.tags_human_override }
        : (p.tags || {});
      for (const f of tagFields) if (tags[f] != null && tags[f] !== '') tagCounts[f]++;
      if (tags.broker != null) {
        if (p.ml_filled?.includes('broker')) brokerFromMl++;
        else brokerFromRegex++;
      }
    }

    if (p.listing_enriched_at) enrichOk++;
    if (p.enrich_failed_at) enrichFailed++;

    if (p.notified_at) notifySent++;
    if (p.notify_failed_at) notifyFailed++;
  }

  return {
    total,
    byLabel,
    byClassifiedBy,
    mlOverrideRate: mlClassified ? mlOverrides / total : 0,
    duplicates,
    duplicateRate: total ? duplicates / total : 0,
    misses: { total: missesTotal, pending: missesPending },
    tagCompleteness: Object.fromEntries(
      tagFields.map(f => [f, rentalCount ? tagCounts[f] / rentalCount : 0])
    ),
    rentalCount,
    brokerProvenance: { regex: brokerFromRegex, ml: brokerFromMl },
    enrichment: { ok: enrichOk, failed: enrichFailed },
    notify: { sent: notifySent, failed: notifyFailed },
  };
}

// ── Shadow ML ────────────────────────────────────────────────────────────
//
// Shadow heads (price, roommates) predict but never tag — their output lives
// in post.ml_shadow, never in post.tags, so a wrong prediction cannot reach
// the Telegram filter. This panel is where their progress is tracked; the
// dashboard deliberately shows none of it, because a half-trained model's
// score is a lab number, not something to read while browsing apartments.
//
// scoreShadow / reviewQueueCount are imported from the extension's real
// lib/ml_shadow.js rather than reimplemented, so the number shown here is the
// same one that governs promotion.

export function computeShadowStats(posts) {
  const fields = {};
  for (const field of SHADOW_FIELDS) {
    const s = scoreShadow(posts, field);
    const target = SHADOW_TARGETS[field];
    // Verdict breakdown: where the model and the regex actually stand on the
    // posts a human has judged. "both wrong" is the interesting bucket — it
    // means neither source can answer that post and a rule may be missing.
    let mlOnly = 0, regexOnly = 0, both = 0, neither = 0;
    for (const p of posts) {
      const v = readShadow(p)?.verdicts?.[field];
      if (!v) continue;
      if (v.ml_correct && v.regex_correct) both++;
      else if (v.ml_correct) mlOnly++;
      else if (v.regex_correct) regexOnly++;
      else neither++;
    }
    fields[field] = {
      ...s,
      queue: reviewQueueCount(posts, field),
      bar_kind: target.bar === 'beat_regex' ? 'regex accuracy on the same posts' : `fixed ${target.bar}`,
      breakdown: { both, ml_only: mlOnly, regex_only: regexOnly, neither },
    };
  }
  const scored = posts.filter(p => readShadow(p)).length;
  const leaks = posts.filter(p => shadowLeakCheck(p).length).map(p => p.post_id);
  return {
    scored,
    unscored: posts.length - scored,
    fields,
    // Invariant monitor: any non-zero value here means a shadow value reached
    // post.tags, which is the one thing shadow mode must never do.
    leaks: { count: leaks.length, post_ids: leaks.slice(0, 20) },
    models: {
      price: ML_PRICE_META,
      roommates: ML_ROOMMATES_META,
    },
  };
}

// ── Weights ──────────────────────────────────────────────────────────────

function topTokens(weights, n = 25) {
  const entries = Object.entries(weights).map(([token, [w]]) => [token, w]);
  entries.sort((a, b) => b[1] - a[1]);
  return {
    positive: entries.slice(0, n).map(([token, w]) => ({ token, weight: w })),
    negative: entries.slice(-n).reverse().map(([token, w]) => ({ token, weight: w })),
  };
}

export function buildWeightsResponse(activeMeta = null) {
  return {
    meta: ML_META,
    extensionActiveMeta: activeMeta,
    label: topTokens(ML_LABEL_WEIGHTS),
    broker: topTokens(ML_BROKER_WEIGHTS),
  };
}

// Top features of the SHADOW heads. The price head is keyed differently from
// the others — its weights are plain numbers per feature name, not
// [weight, idf] token pairs — so it needs its own reader.
function topFlat(weights, n = 30) {
  const e = Object.entries(weights).map(([k, w]) => [k, typeof w === 'number' ? w : w[0]]);
  e.sort((a, b) => b[1] - a[1]);
  return {
    positive: e.slice(0, n).map(([token, weight]) => ({ token, weight })),
    negative: e.slice(-n).reverse().map(([token, weight]) => ({ token, weight })),
  };
}

export function buildShadowWeightsResponse() {
  return {
    price: {
      meta: { ...ML_PRICE_META, ...activePriceMeta() },
      emitThreshold: PRICE_SHADOW_EMIT,
      deployThreshold: PRICE_CONFIDENCE,
      ...topFlat(activePriceWeights()),
    },
    roommates: {
      meta: { ...ML_ROOMMATES_META, ...activeRoommatesMeta() },
      ...topFlat(activeRoommatesWeights()),
    },
  };
}

// ── Classify (reasoning playground) ─────────────────────────────────────

function tokenContributions(weights, text, n = 15) {
  const tokens = uniqueTokens(text || '');
  let norm = 0;
  const hits = [];
  for (const t of tokens) {
    const wi = weights[t];
    if (wi !== undefined) { hits.push([t, wi[0], wi[1]]); norm += wi[1] * wi[1]; }
  }
  norm = Math.sqrt(norm) || 1;
  const scored = hits.map(([token, w, idf]) => ({ token, contribution: w * (idf / norm) }));
  scored.sort((a, b) => b.contribution - a.contribution);
  return {
    towardRental: scored.slice(0, n).filter(s => s.contribution > 0),
    towardNotRental: scored.slice(-n).reverse().filter(s => s.contribution < 0),
  };
}

export function classify(text) {
  const regexLabel = regexClassifyPost(text);
  const regexTags = regexExtractTags(text);
  const hybrid = mlHybridLabel(text, regexLabel);
  const brokerProb = mlBrokerProb(text);
  const brokerFill = mlBrokerFill(text);
  const contributions = tokenContributions(ML_LABEL_WEIGHTS, text);

  return {
    regex: { label: regexLabel, tags: regexTags },
    ml: {
      prob: hybrid.prob,
      label: hybrid.label,
      overrode: hybrid.overrode,
      confidenceThreshold: ML_CONFIDENCE,
      contributions,
    },
    broker: {
      prob: brokerProb,
      fill: brokerFill,
      confidenceThreshold: BROKER_CONFIDENCE,
    },
    final: {
      label: hybrid.label,
      broker: regexTags.broker ?? brokerFill,
    },
    // Shadow heads: what they would predict, and why. These never tag — shown
    // here so the ranking behind a price proposal is inspectable, which the
    // single winning number can never convey.
    shadow: {
      price: explainPrice(text),
      roommates: explainRoommates(text),
    },
  };
}
