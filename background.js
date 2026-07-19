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

import { savePost, findByDedupHash, findByPrefixKey, countPosts, getPost, getAllPosts } from './lib/db.js';
import { computeDedupHash, computePrefixKey, textSimilarity } from './lib/dedup.js';
import { regexClassifyPost, regexExtractTags, mergeWithRegex }
  from './lib/regex_extractor.js';
import { getNotifySettings, sendTelegram, formatPostMessage, matchesPreferences }
  from './lib/notify.js';
import { pollBot } from './lib/bot.js';
import { mlHybridLabel, mlBrokerFill, loadStoredMlWeights } from './lib/ml_classifier.js';

// ── ML weights: prefer retrained weights from chrome.storage.local ───────────
// Loaded at every worker start; hot-reloaded when a retrain (dashboard button
// or Telegram /retrain) writes new weights.
loadStoredMlWeights().then(src => console.log(`[TLV Rentals] ML weights: ${src}`));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ml_weights) {
    loadStoredMlWeights().then(src => console.log(`[TLV Rentals] ML weights reloaded (${src})`));
  }
});

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
// Repairs two historic dedup gaps (2026-07-17 dupe-miss report):
//   1. Rows scraped before v1.4.0 have no prefix_key field, so they are
//      invisible to the prefix index — backfill it.
//   2. Duplicates that entered the DB unmarked (self-shadowing index.get bug,
//      or saved before their family's original existed) are never re-examined
//      — retro-mark them. Within each prefix family the earliest clean post
//      stays the original; later ones are marked only when whole-text
//      similarity >= 0.55, which spares broker-template posts that share an
//      opening line but describe different apartments.
// Guarded by a storage flag so it runs once per profile.
async function dedupMaintenanceSweep() {
  const { dedup_sweep_v1 } = await chrome.storage.local.get('dedup_sweep_v1');
  if (dedup_sweep_v1) return;
  const posts = await getAllPosts();

  let backfilled = 0;
  for (const p of posts) {
    if (p.prefix_key === undefined) {
      p.prefix_key = computePrefixKey(p.text || '');
      await savePost(p);
      backfilled++;
    }
  }

  const families = new Map();
  for (const p of posts) {
    if (!p.prefix_key) continue;
    if (!families.has(p.prefix_key)) families.set(p.prefix_key, []);
    families.get(p.prefix_key).push(p);
  }

  let marked = 0;
  for (const list of families.values()) {
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

  await chrome.storage.local.set({ dedup_sweep_v1: new Date().toISOString() });
  console.log(`[TLV Rentals] Dedup sweep: ${backfilled} prefix keys backfilled, ${marked} retroactive duplicates marked`);
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
      const job = enrichQueue.shift();
      try {
        await enrichOne(job);
      } catch (err) {
        console.warn(`[TLV Rentals] Enrichment failed for ${job.postId}:`, err);
        await stampEnrichFailure(job.postId);
      }
      await new Promise(r => setTimeout(r, 2000)); // be gentle
    }
  } finally {
    enrichRunning = false;
  }
}

async function enrichOne({ postId, permalink }) {
  const record = await getPost(postId);
  if (!record || !isEnrichable(record)) return;

  const tab = await chrome.tabs.create({ url: permalink, active: false });
  let description = null;
  try {
    // The content script needs time to load and the PDP to render; retry the
    // message until it answers or the budget runs out.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && description == null) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_LISTING_DESCRIPTION' });
        if (res && 'description' in res) { description = res.description; break; }
      } catch { /* content script not ready yet — retry */ }
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }

  if (!description || description.trim().length < 80) {
    await stampEnrichFailure(postId);
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

async function stampEnrichFailure(postId) {
  try {
    const record = await getPost(postId);
    if (record && !record.listing_enriched_at) {
      record.enrich_failed_at = new Date().toISOString();
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

