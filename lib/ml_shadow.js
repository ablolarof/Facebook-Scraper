// lib/ml_shadow.js — shadow-mode ML predictions: computed, stored, measured,
// and deliberately NOT used as tags.
//
// Why shadow mode exists
// ----------------------
// The label and broker heads could be gated before shipping because a fixed
// gold benchmark already existed (ml/gold_labels.json, 2,953 rows). For the
// VALUE tags there is no such benchmark and no way to build one from the
// regex's own output — measuring a model against the rules it was trained to
// imitate proves nothing. Shadow mode bootstraps the missing benchmark: the
// model predicts, the predictions are shown but never used, the user corrects
// only what is wrong, and those corrections become the benchmark that decides
// whether the field is ever promoted into real tags.
//
// The safety property, and why it is structural
// ---------------------------------------------
// Shadow values live in their own `ml_shadow` field. They are NEVER written
// into `tags` or `tags_human_override`. This matters because notification
// matching reads exactly one place:
//
//     lib/notify.js::matchesPreferences → (post.tags_human_override || post.tags)
//
// Since `ml_shadow` is neither, a wrong shadow prediction CANNOT reach the
// Telegram filter — not because some `if (!isShadow)` guard remembers to skip
// it, but because the value is not in the object the filter reads. A flag on
// `tags` would have been one forgotten condition away from silently
// suppressing a real listing. shadowLeakCheck() below asserts the invariant
// so a future refactor cannot quietly break it.
//
// Metrics differ per field, on purpose
// ------------------------------------
//   price     → PRECISION (of the values it emits, how many are right).
//               A null price PASSES matchesPreferences, so abstaining costs
//               the user nothing; emitting a wrong value silently hides a
//               listing they wanted. Precision is the number that matters,
//               coverage is reported separately as the thing to grow after.
//   roommates → ACCURACY, but scored against the REGEX on the same posts.
//               extractRoommates is already strong (0 errors in 28 hand-checked
//               hard cases), so a flat "96%" would be a regression. The bar is
//               "at least as good as the regex on posts a human has judged".

export const ML_SHADOW_VERSION = 1;
export const SHADOW_FIELDS = ['price', 'roommates'];

// Promotion bars. `beat_regex` is resolved by scoreShadow() against the
// regex's measured accuracy on the same reviewed posts.
export const SHADOW_TARGETS = {
  price:     { metric: 'precision', bar: 0.96 },
  roommates: { metric: 'accuracy',  bar: 'beat_regex' },
};
// Below this many human verdicts a field's score is noise, not evidence.
// Mirrors the spirit of ml_retrain.js::MIN_GOLD_ROWS at value-tag scale.
export const MIN_VERDICTS = 40;

/**
 * Build a shadow record. Predictions are passed in rather than imported so
 * this module has no dependency on the model files — it can be unit-tested
 * and reasoned about on its own.
 *
 * @param {{price?:{value:?number,prob:number}, roommates?:{value:?boolean,prob:number}}} preds
 * @param {object} regexTags  regexExtractTags() output — what the rules said.
 * @param {string} model      weights provenance, e.g. 'bundled' | 'retrained'.
 */
export function buildShadow(preds, regexTags = {}, model = 'bundled') {
  const fields = {};
  for (const f of SHADOW_FIELDS) {
    const p = preds[f];
    if (!p) continue;
    const rx = regexTags?.[f] ?? null;
    fields[f] = {
      value: p.value ?? null,
      prob: typeof p.prob === 'number' ? +p.prob.toFixed(3) : null,
      regex: rx,
      agrees: (p.value ?? null) === rx,
    };
  }
  return { v: ML_SHADOW_VERSION, at: new Date().toISOString(), model, fields, verdicts: {} };
}

/** Version-gated read. A shadow record from an older shape is ignored, not migrated. */
export function readShadow(post) {
  const s = post?.ml_shadow;
  return s && s.v === ML_SHADOW_VERSION ? s : null;
}

/**
 * Carry human verdicts across a re-prediction. Predictions are cheap to
 * recompute (new weights, backfill); verdicts are the expensive human input
 * and must survive. Mirrors how handleSavePost carries notified_at across a
 * post_id overwrite — same class of bug if forgotten.
 */
export function reshadow(post, freshShadow) {
  const old = readShadow(post);
  if (!old?.verdicts) return freshShadow;

  // `truth` is the human's input and is preserved verbatim. `ml_correct` /
  // `regex_correct` are DERIVED, so they must be recomputed against the fresh
  // prediction — carrying them over would describe the previous model while
  // scoreShadow's `emitted` count describes the new one, and the precision
  // number would silently stop meaning anything after a retrain. This is the
  // same principle recordVerdict follows: never store a judgement that can
  // disagree with the data it is about.
  const carried = {};
  for (const [field, v] of Object.entries(old.verdicts)) {
    const f = freshShadow.fields?.[field];
    carried[field] = f
      ? { ...v,
          ml_correct:    (f.value ?? null) === (v.truth ?? null),
          regex_correct: (f.regex ?? null) === (v.truth ?? null) }
      : v;   // field no longer predicted — keep the record as-is
  }
  freshShadow.verdicts = carried;
  return freshShadow;
}

/** True when the model and the regex differ on this field — the posts worth reviewing. */
export function shadowDisagrees(post, field) {
  const s = readShadow(post);
  const f = s?.fields?.[field];
  return Boolean(f) && !f.agrees;
}

/**
 * Posts needing human review: an unjudged disagreement that can actually move
 * the field's metric.
 *
 * The "can move the metric" part matters more than it sounds. For a
 * PRECISION-scored field (price), only emitted values are scored — abstentions
 * are excluded by definition. So "the model stayed silent where the regex
 * found a price" is a disagreement that no verdict can affect: answering it
 * changes nothing about the number gating promotion, and the regex is very
 * likely right anyway. Measured on the live corpus, queueing those buried the
 * 23 informative questions under 117 useless ones.
 *
 * ACCURACY-scored fields (roommates) score every verdict, so every
 * disagreement is worth asking about, in both directions.
 */
export function needsReview(post, field) {
  const s = readShadow(post);
  const f = s?.fields?.[field];
  if (!f || f.agrees || s.verdicts?.[field]) return false;
  if (SHADOW_TARGETS[field]?.metric === 'precision' && (f.value ?? null) === null) return false;
  return true;
}

export function reviewQueueCount(posts, field) {
  return posts.filter(p => needsReview(p, field)).length;
}

/**
 * Every unjudged disagreement, including ones no verdict could score.
 *
 * needsReview() is the STRICT set — the questions whose answers move the
 * governing metric — and it is what the promotion counts use. But it is too
 * strict to drive the dashboard's review filter: measured live, 127 of 127
 * outstanding price disagreements were ML abstentions, so the strict queue
 * read zero and there was nothing left to review at all. Judging an
 * abstention still records what the right answer was, still trains the next
 * model, and still tells you whether the regex was right — it just doesn't
 * move precision. Showing them beats showing an empty list.
 */
export function needsReviewAny(post, field) {
  const s = readShadow(post);
  const f = s?.fields?.[field];
  return Boolean(f) && !f.agrees && !s.verdicts?.[field];
}

/**
 * Record a human judgement on a shadow prediction.
 * `truth` is the correct value (null is meaningful for price: "this post
 * states no rent"). Correctness is derived, never taken on trust, so the
 * stored verdict cannot disagree with itself.
 */
export function recordVerdict(post, field, truth) {
  const s = readShadow(post);
  if (!s) return null;
  const f = s.fields?.[field];
  if (!f) return null;
  const t = truth ?? null;
  s.verdicts = s.verdicts || {};
  s.verdicts[field] = {
    truth: t,
    ml_correct: (f.value ?? null) === t,
    regex_correct: (f.regex ?? null) === t,
    at: new Date().toISOString(),
  };
  return s.verdicts[field];
}

/** The human-confirmed value for a field, or undefined if never judged. */
export function verdictTruth(post, field) {
  const v = readShadow(post)?.verdicts?.[field];
  return v ? v.truth : undefined;
}

// ── regex_miss helpers ───────────────────────────────────────────────────────
// Mirrors lib/bot.js::addMissField / removeMissField exactly. That file keeps
// its own copy for the Telegram flow; if these two ever diverge the Export
// Misses pipeline becomes inconsistent, so change them together.

function addMissField(post, field) {
  const existing = post.regex_miss || {};
  const fields   = existing.missed_fields || [];
  if (fields.includes(field)) return;
  post.regex_miss = {
    ...existing,
    missed_fields: [...fields, field],
    key_phrases:   existing.key_phrases || {},
    flagged_at:    existing.flagged_at || new Date().toISOString(),
    exported_at:   null,   // reset so it appears in the next Export Misses
  };
}

function removeMissField(post, field) {
  if (!post.regex_miss) return;
  const fields  = (post.regex_miss.missed_fields || []).filter(f => f !== field);
  const phrases = { ...(post.regex_miss.key_phrases || {}) };
  delete phrases[field];
  if (fields.length === 0 && Object.keys(phrases).length === 0 && !post.regex_miss.note) {
    post.regex_miss = null;
  } else {
    post.regex_miss = { ...post.regex_miss, missed_fields: fields, key_phrases: phrases };
  }
}

/**
 * Act on a human verdict: record it, promote the confirmed value to a real
 * tag, and flag the regex if it was the one that got it wrong.
 *
 * This is the ONE place shadow-adjacent code writes `tags`, and it does so
 * only for a value a human explicitly confirmed — never for a model
 * prediction. The distinction is the whole safety argument: an ML guess must
 * not reach matchesPreferences, but a human-confirmed rent is simply the
 * correct rent, and withholding it would leave the dashboard knowingly
 * displaying a value the user just told us was wrong. Identical in effect to
 * editing the field in the ✏ tag editor.
 *
 * Three things happen, and each has a reason:
 *   1. the verdict is stored           → feeds the shadow benchmark (scoreShadow)
 *   2. tags + tags_human_override set  → feeds ML retraining, which reads
 *                                        tags_human_override, and corrects the
 *                                        card + notification filter
 *   3. regex_miss add/remove           → feeds Export Misses so the RULE gets
 *                                        fixed, not just this one post
 *
 * The miss is keyed on whether the REGEX was wrong (`regex_correct`), not on
 * whether the value changed — that is the "if applicable" part. Confirming
 * the regex was right also CLEARS any stale miss on that field.
 *
 * @returns {?{verdict:object, taggedValue:*, flaggedMiss:boolean}}
 */
export function applyVerdictCorrection(post, field, truth) {
  const verdict = recordVerdict(post, field, truth);
  if (!verdict) return null;

  // Merge into the existing tag object rather than replacing it, so judging
  // price never clobbers a previously corrected rooms/size. Mirrors
  // lib/bot.js::applyTagFieldValue, which sets both fields the same way.
  const base = { ...(post.tags_human_override || post.tags || {}) };
  base[field] = verdict.truth;
  post.tags                = base;
  post.tags_human_override = base;

  if (verdict.regex_correct) removeMissField(post, field);
  else                       addMissField(post, field);

  return { verdict, taggedValue: verdict.truth, flaggedMiss: !verdict.regex_correct };
}

/**
 * Score every shadow field against the human verdicts collected so far.
 *
 * price:     precision over EMITTED values only (abstentions excluded — the
 *            model declining to guess is not an error), plus coverage over
 *            the posts where the regex had nothing.
 * roommates: accuracy over all verdicted posts, alongside the regex's
 *            accuracy on those same posts — the bar it has to clear.
 */
export function scoreShadow(posts, field) {
  const target = SHADOW_TARGETS[field];
  let verdicts = 0, mlCorrect = 0, rxCorrect = 0;
  let emitted = 0, emittedCorrect = 0;
  let regexNull = 0, filledRegexNull = 0;

  // A disagreement comes in three shapes, and they do NOT behave alike:
  //
  //   fill     — the regex had nothing, the model proposed a value.
  //   override — both produced a value and they differ.
  //   abstain  — the regex had a value, the model declined to answer.
  //
  // Reporting one blended precision over all three hides the most useful
  // thing the review data can tell us. If `fill` precision is high while
  // `override` precision is poor, the deployment rule writes itself: fill
  // gaps, never contradict — which is exactly how mlBrokerFill already
  // behaves for the broker tag.
  const dir = {
    fill:     { n: 0, ml: 0, regex: 0 },
    override: { n: 0, ml: 0, regex: 0 },
    abstain:  { n: 0, ml: 0, regex: 0 },
  };

  for (const p of posts) {
    const s = readShadow(p);
    const f = s?.fields?.[field];
    if (!f) continue;
    if ((f.regex ?? null) === null) {
      regexNull++;
      if ((f.value ?? null) !== null) filledRegexNull++;
    }
    const v = s.verdicts?.[field];
    if (!v) continue;
    verdicts++;
    if (v.ml_correct) mlCorrect++;
    if (v.regex_correct) rxCorrect++;
    if ((f.value ?? null) !== null) { emitted++; if (v.ml_correct) emittedCorrect++; }

    const mlHas = (f.value ?? null) !== null;
    const rxHas = (f.regex ?? null) !== null;
    const bucket = !mlHas ? dir.abstain : (rxHas ? dir.override : dir.fill);
    bucket.n++;
    if (v.ml_correct) bucket.ml++;
    if (v.regex_correct) bucket.regex++;
  }
  const rate = (a, b) => (b ? a / b : null);
  const byDirection = Object.fromEntries(Object.entries(dir).map(([k, d]) => [k, {
    n: d.n, ml_precision: rate(d.ml, d.n), regex_precision: rate(d.regex, d.n),
  }]));

  const precision = emitted ? emittedCorrect / emitted : null;
  const accuracy  = verdicts ? mlCorrect / verdicts : null;
  const regexAccuracy = verdicts ? rxCorrect / verdicts : null;
  const score = target.metric === 'precision' ? precision : accuracy;
  const bar = target.bar === 'beat_regex' ? regexAccuracy : target.bar;

  return {
    field,
    metric: target.metric,
    score,
    bar,
    // Enough evidence AND clears the bar. Null score never passes.
    meets_bar: score != null && bar != null && verdicts >= MIN_VERDICTS && score >= bar,
    enough_evidence: verdicts >= MIN_VERDICTS,
    verdicts,
    min_verdicts: MIN_VERDICTS,
    accuracy,
    regex_accuracy: regexAccuracy,
    precision,
    emitted,
    // Precision split by disagreement shape — the number that decides whether
    // this head should fill gaps only, or is trustworthy enough to override.
    byDirection,
    // Of the posts the regex could not answer, how many did the model fill?
    coverage_on_regex_null: regexNull ? filledRegexNull / regexNull : null,
    regex_null_posts: regexNull,
    filled_regex_null: filledRegexNull,
  };
}

/**
 * Invariant guard: a shadow value must never appear in `tags`.
 *
 * Detects the leak by provenance rather than by value alone — a tag that
 * matches the shadow prediction is only suspicious when the regex did NOT
 * produce it and no human set it, which means it could only have come from
 * the model. Returns the leaked field names (empty array = clean).
 */
export function shadowLeakCheck(post) {
  const s = readShadow(post);
  if (!s) return [];
  const tags = post.tags || {};
  const human = post.tags_human_override || {};
  const leaked = [];
  for (const [name, f] of Object.entries(s.fields || {})) {
    const shadowVal = f.value ?? null;
    if (shadowVal === null) continue;
    const tagVal = tags[name] ?? null;
    const humanSet = (human[name] ?? null) !== null;
    if (tagVal === shadowVal && (f.regex ?? null) !== shadowVal && !humanSet) leaked.push(name);
  }
  return leaked;
}
