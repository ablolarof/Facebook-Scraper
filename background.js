// background.js — Service worker
//
// Responsibilities:
//   1. Open the dashboard tab when the popup requests it.
//   2. Receive scraped posts from the content script, run deduplication,
//      and save to IndexedDB.
//   3. Auto-classify each newly saved post with the local regex extractor
//      (lib/regex_extractor.js). Posts the regex can't classify stay
//      unlabeled until a human (or stage-2 mechanism) labels them.
//   4. Sync human labels and tag corrections to the local training server
//      (http://localhost:8765) whenever the user labels a post or corrects
//      tags. Fire-and-forget — fails silently if the server isn't running.
//      Data is always safe in IndexedDB; the server is just a durable
//      training copy.
//
// Why handle DB + classification here instead of in the content script?
// Content scripts run in the page's origin (facebook.com), so their
// `indexedDB` would be facebook.com's storage — not the extension's. The
// service worker always runs at the extension origin, so its IndexedDB is
// shared with the dashboard. It also has the host_permissions to reach
// localhost, which content scripts do not.

import { savePost, findByDedupHash, countPosts } from './lib/db.js';
import { computeDedupHash } from './lib/dedup.js';
import { regexClassifyPost, regexExtractTags, mergeWithRegex }
  from './lib/regex_extractor.js';

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

  // Dashboard fires this after every human label or tag correction.
  // We forward it to the local training server (fire-and-forget).
  if (message.type === 'SYNC_LABEL') {
    syncToTrainingServer(message.post).catch(() => {}); // silent if server is down
    sendResponse({ ok: true });
    return false;
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

    post.dedup_hash       = dedupHash;
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
    return { ok: true, is_duplicate: post.is_duplicate };

  } catch (err) {
    console.error('[TLV Rentals] Error saving post:', err);
    return { ok: false, error: String(err) };
  }
}

// ── Training server sync ─────────────────────────────────────────────────────
//
// Sends a labeled post to the local training server so it is persisted outside
// Chrome's storage. Called fire-and-forget — if the server is not running the
// fetch will throw and we swallow the error. The post is always safe in IDB.
const TRAINING_SERVER = 'http://localhost:8765';

async function syncToTrainingServer(post) {
  await fetch(`${TRAINING_SERVER}/label`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_id:             post.post_id,
      text:                post.text,
      author_name:         post.author_name   ?? null,
      group_name:          post.group_name    ?? null,
      human_label:         post.human_label   ?? null,
      tags_human_override: post.tags_human_override ?? null,
      scraped_at:          post.scraped_at    ?? null,
      is_duplicate:        post.is_duplicate  ?? false,
    }),
  });
}
