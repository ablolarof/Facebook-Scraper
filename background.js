// background.js — Service worker
//
// Four responsibilities:
//   1. Open the dashboard tab when the popup requests it.
//   2. Receive scraped posts from the content script, run deduplication,
//      and save to IndexedDB.
//   3. Auto-classify each newly saved post with Gemini Flash (fire-and-forget,
//      runs only if the user has stored an API key in chrome.storage.local).
//   4. Sync human labels and tag corrections to the local training server
//      (http://localhost:8765) whenever the user labels a post or corrects tags.
//      Fire-and-forget — fails silently if the server isn't running. Data is
//      always safe in IndexedDB; the server is just a durable training copy.
//
// Why handle DB + classification here instead of in the content script?
// Content scripts run in the page's origin (facebook.com), so their
// `indexedDB` would be facebook.com's storage — not the extension's. The
// service worker always runs at the extension origin, so its IndexedDB is
// shared with the dashboard. It also has the host_permissions to reach
// generativelanguage.googleapis.com and localhost, which content scripts do not.

import {
  savePost,
  findByDedupHash,
  countPosts,
  getPost,
  getLabeledExamples,
  getTagExamples,
} from './lib/db.js';
import { computeDedupHash } from './lib/dedup.js';
import { classifyPost, extractPostTags } from './lib/gemini.js';
import { regexClassifyPost, regexExtractTags, mergeWithRegex }
  from './lib/regex_extractor.js';

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

  // Dashboard kicks this off via the "Classify with Gemini" button.
  // Classifies a single specified post and resolves with the AI label.
  if (message.type === 'CLASSIFY_POST') {
    classifyOne(message.postId)
      .then(result  => sendResponse({ ok: true, ...result }))
      .catch(err    => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Dashboard "Extract Tags" backfill button — extracts structured fields
  // (price, rooms, size, neighbourhood, entry date) from a single rental post.
  if (message.type === 'EXTRACT_TAGS') {
    extractTagsOne(message.postId)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err   => sendResponse({ ok: false, error: String(err) }));
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

// ── Save + dedup + auto-classify ─────────────────────────────────────────────
async function handleSavePost(post) {
  try {
    const dedupHash = await computeDedupHash({
      text:       post.text,
      image_urls: post.image_urls,
    });
    const existing = await findByDedupHash(dedupHash);

    post.dedup_hash      = dedupHash;
    post.human_label     = post.human_label     ?? null;
    post.ai_label        = post.ai_label        ?? null;
    post.ai_classified_at = post.ai_classified_at ?? null;

    if (existing && existing.post_id !== post.post_id) {
      post.is_duplicate = true;
      post.duplicate_of = existing.post_id;
      // A duplicate has identical text → inherit the original's AI label so we
      // don't waste an API call re-classifying the same content.
      post.ai_label         = existing.ai_label         ?? null;
      post.ai_classified_at = existing.ai_classified_at ?? null;

      // Back-fill missing fields on the original record if this scrape found them.
      // This fixes posts stored before the /share/v/ and /videos/ selectors were added:
      // re-scraping them now will patch the permalink and author URL in place.
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

    await savePost(post);

    // Try regex classification first (instant, no quota).
    // If regex is confident, set ai_label + run regex tag extraction right here.
    // Only fall back to Gemini when regex returns null (ambiguous post).
    if (!post.is_duplicate && !post.ai_label && !post.human_label) {
      const regexLabel = regexClassifyPost(post.text || '');
      if (regexLabel) {
        post.ai_label          = regexLabel;
        post.ai_classified_by  = 'regex';
        post.ai_classified_at  = new Date().toISOString();
        if (regexLabel === 'rental') {
          const rt = regexExtractTags(post.text || '');
          post.regex_extracted_at = new Date().toISOString();
          if (rt && Object.values(rt).some(v => v != null)) {
            post.tags = mergeWithRegex(null, rt);
          }
        }
        await savePost(post);
      } else {
        // Regex couldn't decide — hand off to Gemini (fire-and-forget).
        autoClassify(post.post_id).catch(err =>
          console.warn('[TLV Rentals] auto-classify failed:', err.message)
        );
      }
    }

    return { ok: true, is_duplicate: post.is_duplicate };

  } catch (err) {
    console.error('[TLV Rentals] Error saving post:', err);
    return { ok: false, error: String(err) };
  }
}

// ── Classification helpers ───────────────────────────────────────────────────
async function autoClassify(postId) {
  const apiKey = await getStoredApiKey();
  if (!apiKey) return; // settings not configured yet — silent no-op

  const post = await getPost(postId);
  if (!post || post.human_label || post.ai_label) return;
  if (!post.text || post.text.length < 10) return; // too short to bother

  const examples = await getLabeledExamples(20);
  const label    = await classifyPost({ apiKey, post, examples });

  if (label) {
    post.ai_label         = label;
    post.ai_classified_at = new Date().toISOString();
    await savePost(post);

    // Fire-and-forget tag extraction for confirmed rentals.
    if (label === 'rental') {
      autoExtractTags(postId).catch(err =>
        console.warn('[TLV Rentals] auto-extract-tags failed:', err.message)
      );
    }
  }
}

// Used by the dashboard "Classify with Gemini" backfill button. Returns the
// label so the dashboard can update its in-memory state without re-reading.
async function classifyOne(postId) {
  const apiKey = await getStoredApiKey();
  if (!apiKey) throw new Error('No Gemini API key set — open the popup → Settings.');

  const post = await getPost(postId);
  if (!post) throw new Error(`Post not found: ${postId}`);

  const examples = await getLabeledExamples(20);
  const label    = await classifyPost({ apiKey, post, examples });

  if (label) {
    post.ai_label         = label;
    post.ai_classified_at = new Date().toISOString();
    await savePost(post);

    // Fire-and-forget tag extraction for confirmed rentals.
    if (label === 'rental') {
      autoExtractTags(postId).catch(err =>
        console.warn('[TLV Rentals] auto-extract-tags failed:', err.message)
      );
    }
  }
  return { label };
}

// ── Tag extraction helpers ────────────────────────────────────────────────────

// Fire-and-forget: called after a post is auto-classified as rental.
async function autoExtractTags(postId) {
  const apiKey = await getStoredApiKey();
  if (!apiKey) return;

  const post = await getPost(postId);
  // Skip if regex already extracted tags — avoids spending Gemini quota
  // on posts that are already partially or fully tagged.
  if (!post || post.tags) return;

  const label = post.human_label || post.ai_label;
  if (label !== 'rental') return; // never tag non-rentals

  const examples = await getTagExamples(10);
  const tags = await extractPostTags({ apiKey, post, examples });
  if (tags) {
    post.tags = tags;
    await savePost(post);
  }
}

// Used by the dashboard "Extract Tags" backfill button and when the user
// manually marks a post as rental. Returns tags so the dashboard can update
// its in-memory copy without a full reload.
async function extractTagsOne(postId) {
  const apiKey = await getStoredApiKey();
  if (!apiKey) throw new Error('No Gemini API key set — open the popup → Settings.');

  const post = await getPost(postId);
  if (!post) throw new Error(`Post not found: ${postId}`);

  const label = post.human_label || post.ai_label;
  if (label !== 'rental') throw new Error('Post is not labeled as rental — tags only extracted for rentals.');

  const examples = await getTagExamples(10);
  const tags = await extractPostTags({ apiKey, post, examples });
  if (tags) {
    post.tags = tags;
    await savePost(post);
  }
  return { tags };
}

async function getStoredApiKey() {
  const { gemini_api_key } = await chrome.storage.local.get('gemini_api_key');
  return gemini_api_key || null;
}

// ── Training server sync ──────────────────────────────────────────────────────
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
