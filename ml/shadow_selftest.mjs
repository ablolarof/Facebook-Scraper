// ml/shadow_selftest.mjs — invariant tests for the shadow-mode ML layer.
//
// Usage:  node ml/shadow_selftest.mjs        (exit 0 = all green)
//
// Zero dependencies, same as ml/train.mjs. The point of this file is test [1]:
// it proves that a wrong shadow prediction cannot influence Telegram
// notifications, by running the REAL matchesPreferences against a post whose
// shadow price would blow past max_price. The control case immediately after
// puts the same number in `tags` and asserts it DOES exclude the post — without
// that control, test [1] could pass for the wrong reason (e.g. if the filter
// were broken and matched everything).
//
// Run this after any change to lib/ml_shadow.js, lib/notify.js, or the shape
// of the tags/ml_shadow records.

import * as sh from '../lib/ml_shadow.js';
import { matchesPreferences } from '../lib/notify.js';

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name); }
};
const clone = o => JSON.parse(JSON.stringify(o));

// ── [1] the safety property ──────────────────────────────────────────────────
console.log('\n[1] shadow values are invisible to matchesPreferences');
const prefs = {
  enabled: true, max_price: 8000, min_rooms: null, max_rooms: null,
  roommates: 'either', broker: 'either', include_keywords: [], exclude_keywords: [],
};
const base = {
  text: 'nice flat', ai_label: 'rental',
  tags: { price: null, rooms: 3, size: null, roommates: false, broker: false, entry_date: null },
};
base.ml_shadow = sh.buildShadow(
  { price: { value: 25000, prob: 0.99 }, roommates: { value: true, prob: 0.95 } },
  base.tags, 'selftest');
ok('shadow price 25000 does not exclude (null price passes the filter)',
   matchesPreferences(base, prefs) === true);
const control = clone(base);
control.tags.price = 25000;
ok('CONTROL: the same 25000 in tags DOES exclude — filter is genuinely sensitive',
   matchesPreferences(control, prefs) === false);

// ── [2] leak guard ───────────────────────────────────────────────────────────
console.log('\n[2] shadowLeakCheck detects model-origin values in tags');
ok('clean post reports no leak', sh.shadowLeakCheck(base).length === 0);
const leaky = clone(base); leaky.tags.price = 25000;
ok('model-origin value in tags is flagged', sh.shadowLeakCheck(leaky).includes('price'));
const humanSet = clone(base);
humanSet.tags.price = 25000; humanSet.tags_human_override = { price: 25000 };
ok('human-set value is not a leak', sh.shadowLeakCheck(humanSet).length === 0);
const fromRegex = clone(base);
fromRegex.tags.price = 25000; fromRegex.ml_shadow.fields.price.regex = 25000;
ok('regex-origin value is not a leak', sh.shadowLeakCheck(fromRegex).length === 0);

// ── [3] verdicts outlive predictions ─────────────────────────────────────────
console.log('\n[3] human verdicts survive re-prediction');
const p3 = clone(base);
sh.recordVerdict(p3, 'price', 7300);
p3.ml_shadow = sh.reshadow(p3, sh.buildShadow({ price: { value: 7300, prob: 0.9 } }, p3.tags, 'v2'));
ok('verdict carried across reshadow', p3.ml_shadow.verdicts.price?.truth === 7300);

// Correctness is DERIVED, so a retrain must re-derive it. Carrying the old
// flag would describe the previous model while scoreShadow's `emitted` count
// describes the new one — the precision figure would quietly stop meaning
// anything the first time weights changed.
const p3b = { tags: { price: null } };
p3b.ml_shadow = sh.buildShadow({ price: { value: 7300, prob: 0.9 } }, p3b.tags, 'v1');
sh.recordVerdict(p3b, 'price', 7300);
ok('baseline: verdict says ML was right', p3b.ml_shadow.verdicts.price.ml_correct === true);
p3b.ml_shadow = sh.reshadow(p3b, sh.buildShadow({ price: { value: 4200, prob: 0.9 } }, p3b.tags, 'v2'));
ok('truth is preserved verbatim across retrain', p3b.ml_shadow.verdicts.price.truth === 7300);
ok('ml_correct RE-DERIVED against the new prediction',
   p3b.ml_shadow.verdicts.price.ml_correct === false);
ok('scoreShadow reflects the new model, not the old',
   sh.scoreShadow([p3b], 'price').precision === 0);
ok('correctness is derived, not trusted', sh.recordVerdict(p3, 'price', 7300).ml_correct === true);
ok('a wrong prediction scores false', sh.recordVerdict(p3, 'price', 9999).ml_correct === false);

// ── [4] price = precision; abstaining is not an error ────────────────────────
console.log('\n[4] price scores as precision over emitted values only');
const mkPrice = (mlVal, rxVal, truth) => {
  const q = { tags: { price: rxVal } };
  q.ml_shadow = sh.buildShadow({ price: { value: mlVal, prob: 0.9 } }, q.tags, 't');
  if (truth !== undefined) sh.recordVerdict(q, 'price', truth);
  return q;
};
const corpus = [
  mkPrice(7300, null, 7300),   // emitted, right
  mkPrice(5000, null, 5000),   // emitted, right
  mkPrice(1200, null, null),   // emitted, wrong (per-night price)
  mkPrice(null, null, 8000),   // abstained on a post that HAD a price
  mkPrice(null, null, null),   // abstained correctly
];
const s4 = sh.scoreShadow(corpus, 'price');
ok('precision = 2/3 (abstentions excluded)', Math.abs(s4.precision - 2 / 3) < 1e-9);
ok('accuracy = 3/5 and is NOT the reported score', Math.abs(s4.accuracy - 3 / 5) < 1e-9);
ok('reported metric is precision', s4.metric === 'precision' && Math.abs(s4.score - 2 / 3) < 1e-9);
ok('coverage on regex-null = 3/5', Math.abs(s4.coverage_on_regex_null - 3 / 5) < 1e-9);
ok('too few verdicts -> meets_bar false', s4.meets_bar === false && s4.enough_evidence === false);

// ── [5] roommates must beat the REGEX, not a constant ────────────────────────
console.log('\n[5] roommates is scored against the regex on the same posts');
const mkRm = (mlVal, rxVal, truth) => {
  const q = { tags: { roommates: rxVal } };
  q.ml_shadow = sh.buildShadow({ roommates: { value: mlVal, prob: 0.9 } }, q.tags, 't');
  if (truth !== undefined) sh.recordVerdict(q, "roommates", truth);
  return q;
};
const s5 = sh.scoreShadow([
  mkRm(true, true, true), mkRm(false, false, false),
  mkRm(true, true, true), mkRm(true, false, false),   // ML wrong, regex right
], 'roommates');
ok('bar resolves to the regex’s own accuracy (1.0)', s5.bar === 1);
ok('ML worse than regex does not meet the bar', s5.meets_bar === false);
ok('the 0.96 constant is not applied to roommates', s5.bar !== 0.96);

// ── [6] review queue holds only informative posts ────────────────────────────
console.log('\n[6] review queue = disagreements awaiting a verdict');
const agree = mkPrice(7300, 7300);
const open = mkPrice(7300, null);
const judged = mkPrice(7300, null, 7300);
ok('agreement is not queued', sh.needsReview(agree, 'price') === false);
ok('unjudged disagreement is queued', sh.needsReview(open, 'price') === true);
ok('judged disagreement leaves the queue', sh.needsReview(judged, 'price') === false);
ok('queue count is 1', sh.reviewQueueCount([agree, open, judged], 'price') === 1);

// A precision-scored field must not queue its own abstentions: precision is
// computed over emitted values, so no verdict on an abstention can move it.
// On the live corpus this was 117 of 140 price questions.
const abstained = mkPrice(null, 7300);
ok('price abstention (regex has a value) is NOT in the strict queue',
   sh.needsReview(abstained, 'price') === false);
// …but the dashboard filter must still offer it, or the review list can read
// empty while real disagreements remain. Measured live: 127 outstanding price
// disagreements, all abstentions, strict queue = 0.
ok('abstention IS offered by needsReviewAny', sh.needsReviewAny(abstained, 'price') === true);
ok('agreement is not offered by needsReviewAny', sh.needsReviewAny(agree, 'price') === false);
ok('judged disagreement is not offered by needsReviewAny',
   sh.needsReviewAny(judged, 'price') === false);
// roommates is accuracy-scored, so both directions carry information.
const rmMissed = mkRm(false, true, undefined);
delete rmMissed.ml_shadow.verdicts.roommates;
ok('roommates disagreement IS queued in both directions', sh.needsReview(rmMissed, 'roommates') === true);

// ── [8] a verdict trains the ML and flags the regex ──────────────────────────
console.log('\n[8] applyVerdictCorrection: tags + regex_miss + training signal');

// ML right, regex wrong -> value becomes a tag, regex flagged as a miss
const v1 = { text: 'flat', tags: { price: null, rooms: 3 } };
v1.ml_shadow = sh.buildShadow({ price: { value: 7300, prob: 0.95 } }, v1.tags, 't');
const r1 = sh.applyVerdictCorrection(v1, 'price', 7300);
ok('confirmed value written to tags_human_override', v1.tags_human_override.price === 7300);
ok('and mirrored into tags', v1.tags.price === 7300);
ok('sibling tags preserved (merge, not replace)', v1.tags_human_override.rooms === 3);
ok('regex flagged as a miss', v1.regex_miss?.missed_fields.includes('price') === true);
ok('miss re-enters the export queue', v1.regex_miss.exported_at === null);
ok('reported as flagged', r1.flaggedMiss === true);
ok('trainer can read it back', sh.verdictTruth(v1, 'price') === 7300);
ok('still not a leak — a human set it', sh.shadowLeakCheck(v1).length === 0);

// regex right, ML wrong -> NO miss flagged, and a stale one is cleared
const v2 = { text: 'flat', tags: { price: 5000 },
             regex_miss: { missed_fields: ['price'], key_phrases: {}, flagged_at: 'x', exported_at: null } };
v2.ml_shadow = sh.buildShadow({ price: { value: 9999, prob: 0.95 } }, v2.tags, 't');
const r2 = sh.applyVerdictCorrection(v2, 'price', 5000);
ok('regex correct -> not flagged', r2.flaggedMiss === false);
ok('stale miss on that field cleared', v2.regex_miss === null);

// a miss on ANOTHER field must survive
const v3 = { text: 'flat', tags: { price: null },
             regex_miss: { missed_fields: ['classification'], key_phrases: {}, flagged_at: 'x', exported_at: null } };
v3.ml_shadow = sh.buildShadow({ price: { value: 7000, prob: 0.9 } }, v3.tags, 't');
sh.applyVerdictCorrection(v3, 'price', 7000);
ok('unrelated miss field preserved', v3.regex_miss.missed_fields.join() === 'classification,price');

// "no rent stated" is a real answer, not a skip
const v4 = { text: 'flat', tags: { price: null } };
v4.ml_shadow = sh.buildShadow({ price: { value: 1200, prob: 0.99 } }, v4.tags, 't');
sh.applyVerdictCorrection(v4, 'price', null);
ok('null truth recorded, not dropped', sh.verdictTruth(v4, 'price') === null);
ok('null truth is distinguishable from "never judged"',
   sh.verdictTruth(v4, 'price') === null && sh.verdictTruth({}, 'price') === undefined);
ok('regex was right (both null) -> no miss', !v4.regex_miss);

// ── [7] version gating ───────────────────────────────────────────────────────
console.log('\n[7] a stale shadow shape is ignored, never misread');
const stale = clone(base); stale.ml_shadow.v = 0;
ok('old version reads as absent', sh.readShadow(stale) === null);
ok('and contributes nothing to scoring', sh.scoreShadow([stale], 'price').verdicts === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
