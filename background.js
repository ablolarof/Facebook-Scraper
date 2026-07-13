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

import { savePost, findByDedupHash, findByPrefixKey, countPosts, getPost } from './lib/db.js';
import { computeDedupHash, computePrefixKey } from './lib/dedup.js';
import { regexClassifyPost, regexExtractTags, mergeWithRegex }
  from './lib/regex_extractor.js';
import { getNotifySettings, sendTelegram, formatPostMessage, matchesPreferences }
  from './lib/notify.js';
import { pollBot } from './lib/bot.js';

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

});

// ── Save + dedup + regex classify ────────────────────────────────────────────
async function handleSavePost(post) {
  try {
    const dedupHash = await computeDedupHash({
      text:       post.text,
      image_urls: post.image_urls,
    });
    const existing = await findByDedupHash(dedupHash);

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
      const prefixMatch = await findByPrefixKey(post.prefix_key);
      if (prefixMatch && prefixMatch.post_id !== post.post_id) {
        console.log(`[TLV Rentals] Prefix duplicate: ${post.post_id} → ${prefixMatch.post_id}`);
        post.is_duplicate    = true;
        post.duplicate_of    = prefixMatch.post_id;
        post.ai_label         = prefixMatch.ai_label         ?? null;
        post.ai_classified_at = prefixMatch.ai_classified_at ?? null;
        post.ai_classified_by = prefixMatch.ai_classified_by ?? null;
      }
    }

    // Run regex classification + tag extraction inline (no API, no rate limit).
    // Skips duplicates (already inherited the original's label above) and any
    // post a human has already labeled.
    if (!post.is_duplicate && !post.ai_label && !post.human_label) {
      const regexLabel = regexClassifyPost(post.text || '');
      if (regexLabel) {
        post.ai_label         = regexLabel;
        post.ai_classified_by = 'regex';
        post.ai_classified_at = new Date().toISOString();
        if (regexLabel === 'rental') {
          const rt = regexExtractTags(post.text || '');
          post.regex_extracted_at = new Date().toISOString();
          if (rt && Object.values(rt).some(v => v != null)) {
            post.tags = mergeWithRegex(null, rt);
          }
        }
      }
      // If regex returns null the post stays unlabeled. Stage 2 (mark-and-correct
      // mechanism) is the path for surfacing those to the user.
    }

    await savePost(post);

    // Telegram notification check. Never lets an error propagate into the
    // save result — the post is already safely stored at this point.
    try {
      await notifyIfMatch(post, wasNewRecord);
    } catch (err) {
      console.warn('[TLV Rentals] Notification check failed:', err);
    }

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
    await sendTelegram(s.bot_token, s.chat_id, formatPostMessage(post));
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

