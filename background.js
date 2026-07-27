// background.js — Service worker
//
// Responsibilities:
//   1. Open the dashboard tab when the popup requests it.
//   2. Receive scraped posts from the content script, run deduplication,
//      and save to IndexedDB.
//   3. Auto-classify each newly saved post with the local regex extractor
//      (lib/regex_extractor.js). Posts the regex can't classify stay
//      unlabeled until a human (or stage-2 mechanism) labels them.
//
// Why handle DB + classification here instead of in the content script?
// Content scripts run in the page's origin (facebook.com), so their
// `indexedDB` would be facebook.com's storage — not the extension's. The
// service worker always runs at the extension origin, so its IndexedDB is
// shared with the dashboard.

import { savePost, findByDedupHash, findByPrefixKey, findAllBySuffixKey, countPosts, getPost, getAllPosts } from './lib/db.js';
import { computeDedupHash, computePrefixKey, computeSuffixKey, textSimilarity } from './lib/dedup.js';
import { regexClassifyPost, regexExtractTags, mergeWithRegex }
  from './lib/regex_extractor.js';
import { getNotifySettings, sendTelegram, formatPostMessage, matchesPreferences }
  from './lib/notify.js';
import { pollBot } from './lib/bot.js';
import { mlHybridLabel, mlBrokerFill, loadStoredMlWeights } from './lib/ml_classifier.js';
import { predictPrice, loadStoredPriceWeights } from './lib/ml_price.js';
import { predictRoommates, loadStoredRoommatesWeights } from './lib/ml_roommates.js';
import { buildShadow, reshadow } from './lib/ml_shadow.js';

// ── ML weights: prefer retrained weights from chrome.storage.local ───────────
// Loaded at every worker start; hot-reloaded when a retrain (dashboard button
// or Telegram /retrain) writes new weights.
loadStoredMlWeights().then(src => console.log(`[TLV Rentals] ML weights: ${src}`));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ml_weights) {
    loadStoredMlWeights().then(src => console.log(`[TLV Rentals] ML weights reloaded (${src})`));
  }
  if (area === 'local' && changes.ml_price_weights) {
    loadStoredPriceWeights().then(src => console.log(`[TLV Rentals] price weights reloaded (${src})`));
  }
  if (area === 'local' && changes.ml_roommates_weights) {
    loadStoredRoommatesWeights().then(src => console.log(`[TLV Rentals] roommates weights reloaded (${src})`));
  }
});

// ── Shadow-mode heads (price, roommates) ─────────────────────────────────────
// These predict but do NOT tag: their output goes to post.ml_shadow, never to
// post.tags, so matchesPreferences (which reads tags_human_override || tags)
// cannot see them and a wrong prediction can never suppress or trigger an
// alert. See lib/ml_shadow.js for the full rationale, and
// ml/shadow_selftest.mjs for the test that holds the invariant in place.
loadStoredPriceWeights().then(src => console.log(`[TLV Rentals] price weights: ${src}`));
loadStoredRoommatesWeights().then(src => console.log(`[TLV Rentals] roommates weights: ${src}`));

// ── Telegram bot command polling (stage 7d) ──────────────────────────────────
// A 30-second alarm wakes the worker to check for bot commands; pollBot()
// switches to long-poll bursts while a conversation is active. Registered at
// top level so every worker start re-registers it (chrome.alarms.create with
// the same name just resets the timer — idempotent). The immediate call makes
// queued commands apply as soon as the worker wakes — i.e. before the next
// hourly scrape starts saving posts.
chrome.alarms.create('tlv-bot-poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'tlv-bot-poll') pollBot();
});
pollBot();

// ── One-time cleanup of legacy Gemini storage keys ───────────────────────────
// The Gemini era stored these in chrome.storage.local; the regex-only pipeline
// has no use for them. Removing on worker startup is idempotent and silent.
chrome.storage.local.remove(['gemini_api_key', 'gemini_daily_count']).catch(() => {});

// ── One-time dedup maintenance sweep ─────────────────────────────────────────
// Repairs historic dedup gaps found via the dupe-miss report / Export Misses:
//   1. Rows scraped before v1.4.0 have no prefix_key (or, before this sweep's
//      v2, no suffix_key) field, so they are invisible to those indexes —
//      backfill both.
//   2. Duplicates that entered the DB unmarked (self-shadowing index.get bug,
//      a repost sharing only its CLOSING lines with the original — the
//      2026-07-25 report's dominant pattern — or saved before their family's
//      original existed) are never re-examined — retro-mark them.
// Posts are grouped by prefix_key OR suffix_key (union-find, so a chain of
// partial matches collapses into one family), the earliest clean post in
// each family stays the original, and later members are marked only when
// whole-text similarity >= 0.55 — the gate that spares broker-template posts
// sharing an opening/closing line but describing different apartments.
// Guarded by a storage flag so each sweep version runs once per profile.
async function dedupMaintenanceSweep() {
  const { dedup_sweep_v2 } = await chrome.storage.local.get('dedup_sweep_v2');
  if (dedup_sweep_v2) return;
  const posts = await getAllPosts();

  let backfilled = 0;
  for (const p of posts) {
    let changed = false;
    if (p.prefix_key === undefined) { p.prefix_key = computePrefixKey(p.text || ''); changed = true; }
    if (p.suffix_key === undefined) { p.suffix_key = computeSuffixKey(p.text || ''); changed = true; }
    if (changed) { await savePost(p); backfilled++; }
  }

  // Union-find over post indexes, connected by a shared prefix_key OR suffix_key.
  const idx    = new Map(posts.map((p, i) => [p.post_id, i]));
  const parent = posts.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (const key of ['prefix_key', 'suffix_key']) {
    const byKey = new Map();
    for (const p of posts) {
      const k = p[key];
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(idx.get(p.post_id));
    }
    for (const members of byKey.values()) {
      for (let i = 1; i < members.length; i++) union(members[0], members[i]);
    }
  }

  const groups = new Map();
  for (let i = 0; i < posts.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(posts[i]);
  }

  let marked = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const clean = list.filter(p => !p.is_duplicate)
                      .sort((a, b) => (a.scraped_at || '').localeCompare(b.scraped_at || ''));
    if (clean.length < 2) continue;
    const original = clean[0];
    for (const d of clean.slice(1)) {
      if (textSimilarity(original.text || '', d.text || '') >= 0.55) {
        d.is_duplicate = true;
        d.duplicate_of = original.post_id;
        await savePost(d);
        marked++;
      }
    }
  }

  await chrome.storage.local.set({ dedup_sweep_v2: new Date().toISOString() });
  console.log(`[TLV Rentals] Dedup sweep: ${backfilled} keys backfilled, ${marked} retroactive duplicates marked`);
}
dedupMaintenanceSweep().catch(err => console.warn('[TLV Rentals] Dedup sweep failed:', err));

// ── Message routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'SAVE_POST') {
    handleSavePost(message.post).then(sendResponse);
    return true; // async response — keep the channel open
  }

  if (message.type === 'GET_TOTAL_COUNT') {
    countPosts().then(count => sendResponse({ count }));
    return true;
  }

  // Recompute shadow predictions across every stored rental. Needed after a
  // retrain, and to populate the review queue on posts scraped before shadow
  // mode existed. Human verdicts are preserved (reshadow); tags are never
  // touched, so this cannot alter what the notification filter sees.
  if (message.type === 'SHADOW_BACKFILL') {
    backfillShadow().then(sendResponse).catch(err => {
      console.error('[TLV Rentals] shadow backfill failed:', err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }

  // Queue every already-stored card-style commerce post for enrichment
  // (one-off maintenance, triggered from the dashboard console).
  if (message.type === 'ENRICH_COMMERCE_BACKFILL') {
    getAllPosts().then(posts => {
      const todo = posts.filter(isEnrichable).slice(0, 200);
      for (const p of todo) queueEnrichment(p.post_id, p.permalink);
      sendResponse({ queued: todo.length });
    });
    return true;
  }

});

// ── Commerce-listing enrichment ──────────────────────────────────────────────
// Pure Marketplace cards on the feed carry only "₪price · location · title" —
// the description exists ONLY on the listing page (/commerce/listing/…), and
// that page is fully client-rendered (nothing useful in its HTML, verified
// live 2026-07-19). So: open the listing in a background tab, let the content
// script read the rendered description, close the tab, and re-save the post
// through handleSavePost so classification/tags/dedup all see the full text.
// Serial queue with a courtesy delay — a scrape yields at most a handful of
// new card-style listings.

const enrichQueue = [];
let enrichRunning = false;

// Throttle + block handling (added 2026-07-20 after Facebook temp-blocked the
// /commerce/listing/ surface: the 2s gap sustained 10-29 listing opens/hour
// for two days). Chrome.storage keys:
//   enrich_cooldown_until — epoch ms; all enrichment paused until then. Set
//                           for 6h whenever the block interstitial is seen.
//   enrich_open_times     — epoch-ms list of listing opens in the last hour,
//                           enforcing the hourly cap across worker restarts.
const ENRICH_DELAY_MS     = 30000;             // base gap between listing opens
const ENRICH_DELAY_JITTER = 15000;             // + random 0..this
const ENRICH_HOURLY_CAP   = 20;                // max opens per rolling hour
const ENRICH_COOLDOWN_MS  = 6 * 3600 * 1000;   // pause after a block page

async function enrichCooldownRemaining() {
  const { enrich_cooldown_until = 0 } = await chrome.storage.local.get('enrich_cooldown_until');
  return Math.max(0, enrich_cooldown_until - Date.now());
}

async function enrichHourlyBudgetLeft() {
  const cutoff = Date.now() - 3600 * 1000;
  const { enrich_open_times = [] } = await chrome.storage.local.get('enrich_open_times');
  return ENRICH_HOURLY_CAP - enrich_open_times.filter(t => t > cutoff).length;
}

async function recordEnrichOpen() {
  const cutoff = Date.now() - 3600 * 1000;
  const { enrich_open_times = [] } = await chrome.storage.local.get('enrich_open_times');
  const times = enrich_open_times.filter(t => t > cutoff);
  times.push(Date.now());
  await chrome.storage.local.set({ enrich_open_times: times });
}

function isEnrichable(post) {
  if (!post || !post.permalink) return false;
  if (!/^(cl_|mp_)/.test(String(post.post_id))) return false;
  if (post.listing_enriched_at || post.enrich_failed_at) return false;
  const text = (post.text || '').trim();
  // Card-style summary: starts with a price (or FREE), or is just very short.
  return /^(₪|FREE)/.test(text) || text.length < 200;
}

function queueEnrichment(postId, permalink) {
  if (enrichQueue.some(job => job.postId === postId)) return;
  enrichQueue.push({ postId, permalink });
  processEnrichQueue();
}

async function processEnrichQueue() {
  if (enrichRunning) return;
  enrichRunning = true;
  try {
    while (enrichQueue.length > 0) {
      const cooldown = await enrichCooldownRemaining();
      if (cooldown > 0) {
        console.warn(`[TLV Rentals] Enrichment paused for ${Math.ceil(cooldown / 60000)} more min (Facebook block cooldown). Dropping ${enrichQueue.length} queued job(s) — unstamped posts re-queue on the next scrape.`);
        enrichQueue.length = 0;
        break;
      }
      if ((await enrichHourlyBudgetLeft()) <= 0) {
        console.warn(`[TLV Rentals] Enrichment hourly cap (${ENRICH_HOURLY_CAP}) reached. Dropping ${enrichQueue.length} queued job(s) — unstamped posts re-queue on the next scrape.`);
        enrichQueue.length = 0;
        break;
      }
      const job = enrichQueue.shift();
      try {
        await enrichOne(job);
      } catch (err) {
        console.warn(`[TLV Rentals] Enrichment failed for ${job.postId}:`, err);
        await stampEnrichFailure(job.postId, 'error: ' + (err && err.message || err));
      }
      // Jittered gap between listing opens. Slept in short chunks with a
      // storage touch between them — one long setTimeout would let Chrome
      // kill the idle MV3 worker mid-wait and lose the queue.
      let wait = ENRICH_DELAY_MS + Math.floor(Math.random() * ENRICH_DELAY_JITTER);
      while (wait > 0 && enrichQueue.length > 0) {
        const chunk = Math.min(wait, 10000);
        await new Promise(r => setTimeout(r, chunk));
        await chrome.storage.local.get('enrich_cooldown_until'); // worker keepalive
        wait -= chunk;
      }
    }
  } finally {
    enrichRunning = false;
  }
}

async function enrichOne({ postId, permalink }) {
  const record = await getPost(postId);
  if (!record || !isEnrichable(record)) return;

  await recordEnrichOpen();
  const tab = await chrome.tabs.create({ url: permalink, active: false });
  let result = null;
  try {
    // The content script needs time to load and the PDP to render; retry the
    // message until it answers or the budget runs out. Any object response is
    // terminal: {description}, {blocked:true}, or {description:null, reason}
    // (the content side already waited out its own render deadline).
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && result == null) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_LISTING_DESCRIPTION' });
        if (res && (res.description != null || res.blocked || res.reason)) { result = res; break; }
      } catch { /* content script not ready yet — retry */ }
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }

  if (result && result.blocked) {
    // Facebook's rate-limit interstitial. The listing itself is fine — do NOT
    // stamp it failed. Pause everything and let it retry after the cooldown.
    const until = Date.now() + ENRICH_COOLDOWN_MS;
    await chrome.storage.local.set({ enrich_cooldown_until: until });
    console.warn(`[TLV Rentals] Facebook "temporarily blocked" page detected on ${postId} — pausing ALL enrichment until ${new Date(until).toLocaleString()}. Post not stamped; it will retry after the cooldown.`);
    return;
  }

  const description = result && result.description;
  if (!description || description.trim().length < 80) {
    await stampEnrichFailure(postId, (result && result.reason) || 'no_response_within_budget');
    return;
  }

  // Description first (position-sensitive classification rules read the top),
  // original card line (price · location · title) preserved at the end.
  const cardLine = (record.text || '').trim();
  record.text = description.trim() + (cardLine ? '\n\n' + cardLine : '');
  record.listing_enriched_at = new Date().toISOString();
  // Force re-classification on the full text (human labels always win and
  // are checked inside handleSavePost).
  if (!record.human_label) {
    record.ai_label = null;
    record.ai_classified_by = null;
    record.ai_classified_at = null;
    record.tags = null;
    record.ml_filled = null;
  }
  // Re-save through the full pipeline: dedup hash/prefix recompute, hybrid
  // classification, tag extraction, broker fill. forceNotifyCheck lets a
  // now-matching post alert even though it is not a new record (notified_at
  // is carried over, so an already-alerted post can never alert twice).
  await handleSavePost(record, { forceNotifyCheck: true });
  console.log(`[TLV Rentals] Enriched commerce listing ${postId} (+${description.length} chars)`);
}

async function stampEnrichFailure(postId, reason) {
  try {
    const record = await getPost(postId);
    if (record && !record.listing_enriched_at) {
      record.enrich_failed_at     = new Date().toISOString();
      record.enrich_failed_reason = String(reason || 'unknown').slice(0, 300);
      await savePost(record);
    }
  } catch { /* best effort */ }
}

// ── Save + dedup + regex classify ────────────────────────────────────────────
async function handleSavePost(post, opts = {}) {
  try {
    const dedupHash = await computeDedupHash({
      text:       post.text,
      image_urls: post.image_urls,
    });
    const existing = await findByDedupHash(dedupHash, post.post_id);

    // Did a record with this exact post_id already exist? If yes, savePost()
    // will overwrite it (silent re-save), not add a new row to IDB. The popup
    // uses this to distinguish "truly new" from "we already had this one" —
    // important on the home feed where the same post can reappear in the feed
    // and any hash-fallback collision would silently overwrite an existing row.
    const existingRecord = await getPost(post.post_id);
    const wasNewRecord   = !existingRecord;

    // An overwrite replaces the row wholesale, so the notification stamps
    // must be carried over or a re-scrape would erase the record of having
    // already alerted the user about this post.
    if (existingRecord) {
      post.notified_at      = existingRecord.notified_at      ?? null;
      post.notify_failed_at = existingRecord.notify_failed_at ?? null;
    }

    post.dedup_hash       = dedupHash;
    post.prefix_key       = computePrefixKey(post.text || '');  // null for very short posts
    post.suffix_key       = computeSuffixKey(post.text || '');  // null for very short posts
    post.human_label      = post.human_label      ?? null;
    post.ai_label         = post.ai_label         ?? null;
    post.ai_classified_at = post.ai_classified_at ?? null;
    post.ai_classified_by = post.ai_classified_by ?? null;

    if (existing && existing.post_id !== post.post_id) {
      post.is_duplicate = true;
      post.duplicate_of = existing.post_id;
      // A duplicate has identical text → inherit the original's label so
      // we don't waste cycles re-classifying the same content.
      post.ai_label         = existing.ai_label         ?? null;
      post.ai_classified_at = existing.ai_classified_at ?? null;
      post.ai_classified_by = existing.ai_classified_by ?? null;

      // Back-fill missing fields on the original record if this scrape found
      // them. Patches posts stored before the /share/v/ and /videos/ selectors
      // were added: re-scraping them now updates permalink + author URL in place.
      let existingUpdated = false;
      if (!existing.permalink && post.permalink) {
        existing.permalink = post.permalink;
        existingUpdated = true;
      }
      if (!existing.author_profile_url && post.author_profile_url) {
        existing.author_profile_url = post.author_profile_url;
        existingUpdated = true;
      }
      if (existingUpdated) {
        await savePost(existing);
      }
    } else {
      post.is_duplicate = false;
      post.duplicate_of = null;
    }

    // ── Prefix-key near-duplicate check ──────────────────────────────────────
    // Runs only when the exact dedup_hash didn't fire AND the text has enough
    // words for a meaningful prefix (computePrefixKey returns null otherwise).
    // If any stored post opens with the same first 10 words, this is almost
    // certainly the same listing reposted with minor edits.
    if (!post.is_duplicate && post.prefix_key) {
      const prefixMatch = await findByPrefixKey(post.prefix_key, post.post_id);
      if (prefixMatch && prefixMatch.post_id !== post.post_id) {
        console.log(`[TLV Rentals] Prefix duplicate: ${post.post_id} → ${prefixMatch.post_id}`);
        post.is_duplicate    = true;
        post.duplicate_of    = prefixMatch.post_id;
        post.ai_label         = prefixMatch.ai_label         ?? null;
        post.ai_classified_at = prefixMatch.ai_classified_at ?? null;
        post.ai_classified_by = prefixMatch.ai_classified_by ?? null;
      }
    }

    // ── Suffix-key near-duplicate check ──────────────────────────────────────
    // Catches reposts that edited the HEADLINE (defeating prefix_key) but kept
    // the closing lines — location/conditions/contact — intact (the dominant
    // pattern in the 2026-07-25 dupe-miss report). A shared suffix is a much
    // weaker signal than a shared prefix (broker templates recur across
    // different apartments), so every candidate is scored by whole-text
    // similarity and only a >= 0.55 match is accepted — the same gate the
    // maintenance sweep and manual ⊘ Dupe pairing use.
    if (!post.is_duplicate && post.suffix_key) {
      const candidates = await findAllBySuffixKey(post.suffix_key, post.post_id);
      let best = null, bestScore = 0;
      for (const c of candidates) {
        if (c.is_duplicate) continue;
        const s = textSimilarity(post.text || '', c.text || '');
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (best && bestScore >= 0.55) {
        console.log(`[TLV Rentals] Suffix duplicate: ${post.post_id} → ${best.post_id} (sim ${bestScore.toFixed(2)})`);
        post.is_duplicate     = true;
        post.duplicate_of     = best.post_id;
        post.ai_label         = best.ai_label         ?? null;
        post.ai_classified_at = best.ai_classified_at ?? null;
        post.ai_classified_by = best.ai_classified_by ?? null;
      }
    }

    // Classify inline (no API, no rate limit): regex first, then the ML
    // hybrid rule — the regex label stands unless the model is confidently
    // sure it is wrong (or the regex returned null). Skips duplicates
    // (already inherited the original's label above) and any post a human
    // has already labeled. The model itself is NEVER trained on ai_label,
    // so this override cannot feed back into training.
    if (!post.is_duplicate && !post.ai_label && !post.human_label) {
      const regexLabel = regexClassifyPost(post.text || '');
      const ml = mlHybridLabel(post.text || '', regexLabel);
      post.ml_prob = +ml.prob.toFixed(3);
      if (ml.overrode || regexLabel == null) {
        post.ai_label         = ml.label;
        post.ai_classified_by = 'ml';
      } else {
        post.ai_label         = regexLabel;
        post.ai_classified_by = 'regex';
      }
      post.ai_classified_at = new Date().toISOString();
      if (post.ai_label === 'rental') {
        const rt = regexExtractTags(post.text || '');
        post.regex_extracted_at = new Date().toISOString();
        if (rt && Object.values(rt).some(v => v != null)) {
          post.tags = mergeWithRegex(null, rt);
        }
        // Broker fill-in: only where the regex extractor had no answer, and
        // only when the ML broker head is confident. Provenance is recorded
        // so the dashboard/corrections can tell ML-filled tags apart.
        if ((post.tags?.broker ?? null) === null) {
          const bf = mlBrokerFill(post.text || '');
          if (bf !== null) {
            post.tags = post.tags || { price: null, rooms: null, size: null, roommates: null, broker: null, entry_date: null };
            post.tags.broker = bf;
            post.ml_filled = ['broker'];
          }
        }
      }
    }

    // ── Shadow-mode predictions (price, roommates) ───────────────────────────
    // Written to post.ml_shadow ONLY. Never merged into post.tags, so the
    // notification filter cannot see them — a wrong prediction costs nothing
    // but a review. Verdicts already recorded by the user survive re-saves
    // (reshadow), the same way notified_at is carried across an overwrite:
    // predictions are cheap to recompute, human judgements are not.
    //
    // Wrapped so a shadow failure can never fail a save. The post and its real
    // tags matter; an experimental head does not.
    try {
      const effLabel = post.human_label || post.ai_label;
      if (!post.is_duplicate && effLabel === 'rental' && (post.text || '').trim()) {
        const rxTags = post.tags_human_override || post.tags || {};
        post.ml_shadow = reshadow(post, buildShadow(
          { price: predictPrice(post.text), roommates: predictRoommates(post.text) },
          rxTags, 'bundled'));
      }
    } catch (err) {
      console.warn('[TLV Rentals] shadow prediction failed (save unaffected):', err);
    }

    await savePost(post);

    // Telegram notification check. Never lets an error propagate into the
    // save result — the post is already safely stored at this point.
    try {
      await notifyIfMatch(post, wasNewRecord || opts.forceNotifyCheck === true);
    } catch (err) {
      console.warn('[TLV Rentals] Notification check failed:', err);
    }

    // Card-style commerce posts get their full description fetched from the
    // listing page in the background (queue is serial; never blocks the save).
    if (isEnrichable(post)) queueEnrichment(post.post_id, post.permalink);

    return { ok: true, is_duplicate: post.is_duplicate, is_new_record: wasNewRecord };

  } catch (err) {
    console.error('[TLV Rentals] Error saving post:', err);
    return { ok: false, error: String(err) };
  }
}

// ── Telegram notification on matching new posts (stage 7c) ──────────────────
// Sends at most one alert per post, ever:
//   - Only posts seen for the FIRST time qualify (wasNewRecord), so the
//     existing backlog never floods the chat on a re-scrape — with one
//     exception: a row whose previous send attempt failed (notify_failed_at
//     set, notified_at not) is retried when the next scrape re-saves it.
//   - Duplicates (hash or prefix) inherit their original's outcome and are
//     never alerted separately.
//   - notified_at / notify_failed_at are stamped on the post row itself and
//     preserved across overwrites in handleSavePost.
async function notifyIfMatch(post, wasNewRecord) {
  if (post.is_duplicate || post.notified_at) return;
  if (!wasNewRecord && !post.notify_failed_at) return;

  const s = await getNotifySettings();
  if (!s.enabled || !s.bot_token || !s.chat_id) return;
  if (!matchesPreferences(post, s)) return;

  try {
    // The 🚩 Miss button (lib/bot.js::handleCallbackQuery) lets the user
    // correct classification/price/rooms/etc straight from the alert.
    const replyMarkup = {
      inline_keyboard: [[{ text: '🚩 Miss', callback_data: `mopen:${post.post_id}` }]],
    };
    await sendTelegram(s.bot_token, s.chat_id, formatPostMessage(post), replyMarkup);
    post.notified_at      = new Date().toISOString();
    post.notify_failed_at = null;
    console.log(`[TLV Rentals] Notified: ${post.post_id}`);
  } catch (err) {
    // Stamp the failure so the next scrape of this same post retries the send.
    post.notify_failed_at = new Date().toISOString();
    console.warn(`[TLV Rentals] Notification send failed for ${post.post_id}:`, err);
  }
  await savePost(post);
}


/**
 * Recompute shadow predictions for every stored rental.
 *
 * Only `ml_shadow` is written — tags, labels and notification stamps are left
 * exactly as they were, so this is safe to run at any time. Existing human
 * verdicts are carried across by reshadow(): re-running after a retrain
 * re-scores the model without discarding the benchmark that measures it.
 */
async function backfillShadow() {
  const posts = await getAllPosts();
  let updated = 0, skipped = 0, failed = 0;
  for (const post of posts) {
    const effLabel = post.human_label || post.ai_label;
    if (post.is_duplicate || effLabel !== 'rental' || !(post.text || '').trim()) { skipped++; continue; }
    try {
      const rxTags = post.tags_human_override || post.tags || {};
      post.ml_shadow = reshadow(post, buildShadow(
        { price: predictPrice(post.text), roommates: predictRoommates(post.text) },
        rxTags, 'bundled'));
      await savePost(post);
      updated++;
    } catch (err) {
      failed++;
      console.warn(`[TLV Rentals] shadow backfill failed for ${post.post_id}:`, err);
    }
  }
  console.log(`[TLV Rentals] Shadow backfill: ${updated} updated, ${skipped} skipped, ${failed} failed.`);
  return { ok: true, updated, skipped, failed };
}
