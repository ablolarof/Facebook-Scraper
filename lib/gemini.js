// lib/gemini.js — Google Gemini API wrapper for rental-or-not classification
//
// Called from background.js (auto-classify on save) and dashboard.js (backfill).
// Sends the post text + author + group + a handful of human-labeled examples
// to Gemini Flash, which returns "rental" or "not_rental".
//
// Why Gemini over Anthropic? Google AI Studio's free tier covers this workload
// comfortably (1,500 requests/day on 2.0-flash, more on 2.5-flash) — perfect
// for a personal scraper that classifies a few hundred posts/day at most.
//
// IMPORTANT: this is the ONLY place in the codebase that makes external
// network requests. host_permissions in manifest.json gates that explicitly.

import { NEIGHBORHOOD_OVERRIDES } from './neighborhood_overrides.js';

// Fallback chain: try each model in order on 503 "high demand" responses.
// The first model is preferred (fastest / cheapest); later ones are only used
// when the primary is unavailable. Any other HTTP error terminates immediately.
const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

// Truncate example text so 20 few-shot examples don't blow the token budget.
// The new post being classified is sent at full length.
const EXAMPLE_MAX_CHARS = 250;

// ── Canonical neighborhood list ───────────────────────────────────────────────
// Gemini must return one of these strings for the neighborhood field, or null.
// Used in the system prompt so Gemini knows the exact expected values, and
// exported so the dashboard can populate its filter list from the same source.
export const CANONICAL_NEIGHBORHOODS = [
  'North of the Yarkon',
  'East of the Ayalon',
  'Old North',
  'New North',
  'Bavli',
  'Lev Tel Aviv',
  'Ganei Sarona',
  'Montefiore',
  'Kerem Hateimanim',
  'Neve Zedek',
  'Florentine',
  "Neve Sha'anan",
  'Yafo',
  'South Tel Aviv',
];

// ── Rate limiter ──────────────────────────────────────────────────────────────
// Enforces a 990 RPM sliding-window cap (gemini-2.5-flash-lite free tier).
// Module-level state persists for the lifetime of the service worker.
const RATE_LIMIT_RPM       = 990;
const RATE_LIMIT_WINDOW_MS = 60_000;

const _requestTimestamps = []; // ms timestamps of calls within the current window

async function enforceRateLimit() {
  const now = Date.now();
  while (_requestTimestamps.length > 0 && now - _requestTimestamps[0] >= RATE_LIMIT_WINDOW_MS) {
    _requestTimestamps.shift();
  }
  if (_requestTimestamps.length >= RATE_LIMIT_RPM) {
    const waitMs = RATE_LIMIT_WINDOW_MS - (Date.now() - _requestTimestamps[0]) + 50;
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return enforceRateLimit();
  }
  _requestTimestamps.push(Date.now());
}

// ── Daily usage guard ─────────────────────────────────────────────────────────
// Persists a per-day request count in chrome.storage.local. Throws a clear
// error when the count hits 9,500 so the classify loop surfaces it visibly.
const DAILY_WARN_THRESHOLD = 9_500;

async function checkDailyLimit() {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const { gemini_daily_count: stored } = await chrome.storage.local.get('gemini_daily_count');
  const count = (stored?.date === today ? stored.count : 0) + 1;
  await chrome.storage.local.set({ gemini_daily_count: { date: today, count } });
  if (count >= DAILY_WARN_THRESHOLD) {
    throw new Error(
      `Daily Gemini request warning: ${count} requests sent today — ` +
      `approaching the 10,000/day limit. Check usage at aistudio.google.com.`
    );
  }
}

// ── Model fallback ────────────────────────────────────────────────────────────
// Tries each model in MODELS order.
// 503 (overloaded) and 429 (rate-limited) are treated as transient: the same
// model is retried up to MAX_RETRIES times with exponential back-off + jitter
// before falling through to the next model in the chain.
// A hung request (no response within REQUEST_TIMEOUT_MS) is treated the same way.
// Any other HTTP error (400, 401, 403 …) is thrown immediately.
const REQUEST_TIMEOUT_MS = 25_000; // 25 s — generous for large few-shot prompts
const MAX_RETRIES        = 3;

const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithFallback(apiKey, body) {
  let lastError;

  for (const model of MODELS) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
      `?key=${encodeURIComponent(apiKey)}`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
          signal:  controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) return response;

        const errText = await response.text();

        // Transient errors — back off and retry the same model, then fall through.
        if (response.status === 503 || response.status === 429) {
          lastError = new Error(`Gemini API ${response.status} (${model}): ${errText.slice(0, 200)}`);
          if (attempt < MAX_RETRIES) {
            // Exponential back-off with jitter to avoid thundering-herd retries.
            const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            console.warn(`[TLV Rentals] ${model} returned ${response.status}. Attempt ${attempt}/${MAX_RETRIES} — retrying in ${Math.round(backoffMs)}ms…`);
            await _sleep(backoffMs);
            continue;
          }
          console.warn(`[TLV Rentals] ${model} exhausted after ${MAX_RETRIES} attempts — trying next model…`);
          break; // move to next model
        }

        // Fatal error (400 bad request, 401/403 auth, …) — don't retry.
        throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);

      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          lastError = new Error(`Gemini timeout (${model}) — no response within ${REQUEST_TIMEOUT_MS / 1000}s`);
          if (attempt < MAX_RETRIES) {
            const backoffMs = Math.pow(2, attempt) * 1000;
            console.warn(`[TLV Rentals] ${model} timed out. Retrying in ${backoffMs}ms…`);
            await _sleep(backoffMs);
            continue;
          }
          console.warn(`[TLV Rentals] ${model} timed out on all ${MAX_RETRIES} attempts — trying next model…`);
          break;
        }
        throw err; // network down, CORS, non-transient — propagate immediately
      }
    }
  }

  // All models in the chain have been exhausted.
  throw lastError;
}

const SYSTEM_PROMPT = `You classify Facebook group posts as either a rental apartment listing ("rental") or anything else ("not_rental").

Tel Aviv apartment rental posts typically include some combination of:
- A price in shekels (₪, ש"ח)
- Number of rooms (חדרים, חד', "room", "studio")
- A Tel Aviv neighborhood or street name
- Move-in date, square meters (מ"ר), floor, contact details
- Hebrew words like דירה, להשכרה, שכירות, פינוי, מפנים

Other posts that should be "not_rental" include: photos with social captions, questions ("does anyone know…"), recommendations, news, jokes, lost-and-found, social events, group rules, sales of furniture, services offered (cleaning, moving), and posts ABOUT rentals that aren't actual listings (e.g. someone LOOKING for an apartment is borderline — only mark "rental" if it's clearly offering one).

Reply with exactly one word: rental or not_rental. Nothing else.`;

/**
 * Classify a single post using few-shot prompting.
 *
 * @param {object} args
 * @param {string} args.apiKey       — Gemini API key (typically starts AIza…)
 * @param {object} args.post         — the post to classify
 * @param {object[]} [args.examples] — human-labeled posts used as few-shot context
 * @returns {Promise<'rental'|'not_rental'|null>} — null if Gemini's response was unparseable
 */
export async function classifyPost({ apiKey, post, examples = [] }) {
  if (!apiKey) throw new Error('No Gemini API key configured');

  await enforceRateLimit();
  await checkDailyLimit();

  // Gemini uses { role: 'user' | 'model', parts: [{text}] } turns.
  // Build the alternating few-shot history, then the actual classification ask.
  const contents = [];
  for (const ex of examples) {
    if (ex.human_label !== 'rental' && ex.human_label !== 'not_rental') continue;
    contents.push({ role: 'user',  parts: [{ text: formatPostForPrompt(ex,  /*truncate=*/true) }] });
    contents.push({ role: 'model', parts: [{ text: ex.human_label }] });
  }
  contents.push({ role: 'user', parts: [{ text: formatPostForPrompt(post, /*truncate=*/false) }] });

  // Gemini auth is via ?key=… query param. Header-based auth also works
  // (x-goog-api-key) but the query param is what AI Studio's docs show first.
  // callGeminiWithFallback retries with the next model on 503.
  const response = await callGeminiWithFallback(apiKey, {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      maxOutputTokens: 30,
      // Deterministic — the task has a single correct label, no creativity needed.
      temperature: 0.0,
    },
  });

  const data = await response.json();
  const raw  = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase();
  return parseLabel(raw);
}

// ── Tag extraction ────────────────────────────────────────────────────────────

const TAGS_SYSTEM_PROMPT = `You extract structured details from Tel Aviv apartment rental listings written in Hebrew or English.

Return a JSON object with exactly these fields (use null for anything you cannot determine with confidence):
- price: monthly rent as a plain number in NIS (₪/ש"ח). No currency symbols. null if not stated.
- rooms: number of rooms (חדרים/חד') as a number (0.5 increments allowed). null if not stated.
- size: apartment size in square meters (מ"ר/sqm) as a number. null if not stated.
- roommates: true ONLY if the post is someone seeking a roommate to JOIN existing tenants in a shared apartment. false if the post is renting out a whole apartment. null if unclear.
- broker: true if the listing is from a real estate agent/realtor and involves a brokerage fee (דמי תיווך / עמלת תיווך). false if the post explicitly says no broker fee (ללא תיווך / ישיר מבעל הדירה / פרטי). null if not mentioned.
- neighborhood: identify the Tel Aviv neighborhood using the signals below (in priority order). Return the single best match from the canonical list, or null if you cannot determine it with at least medium confidence.
  Canonical list: North of the Yarkon, East of the Ayalon, Old North, New North, Bavli, Lev Tel Aviv, Ganei Sarona, Montefiore, Kerem Hateimanim, Neve Zedek, Florentine, Neve Sha'anan, Yafo, South Tel Aviv.
  Priority signals:
  1. An explicit canonical neighborhood name in the post.
  2. A street name — use your knowledge of Tel Aviv's street grid. For streets crossing multiple neighborhoods (Dizengoff, Ibn Gvirol, Ben Yehuda, Rothschild) use any house number or spatial clue.
  3. A named landmark or POI (Rabin Square, Habima, Carmel Market, Dizengoff Center, Park HaYarkon, HaTachana, Tachana Merkazit, the beach/sea).
  4. A directional or relative description ("north Tel Aviv", "south of Florentin", "5 min from the shuk").
- neighborhood_confidence: "high" if a canonical name appears explicitly; "medium" if inferred from a street or landmark with reasonable certainty; "low" if inferred only from a vague directional clue. null if neighborhood is null.
- neighborhood_evidence: the exact substring (10–30 characters) from the post text that informed the neighborhood answer. null if neighborhood is null.
- entry_date: move-in date as "YYYY-MM-DD", or the special string "immediate" if the post says immediately / מיידי / פנוי עכשיו / available now. null if not mentioned.`;

const TAGS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    price:                   { type: 'NUMBER',  nullable: true },
    rooms:                   { type: 'NUMBER',  nullable: true },
    size:                    { type: 'NUMBER',  nullable: true },
    roommates:               { type: 'BOOLEAN', nullable: true },
    broker:                  { type: 'BOOLEAN', nullable: true },
    neighborhood:            { type: 'STRING',  nullable: true },
    neighborhood_confidence: { type: 'STRING',  nullable: true },
    neighborhood_evidence:   { type: 'STRING',  nullable: true },
    entry_date:              { type: 'STRING',  nullable: true },
  },
};

/**
 * Extract structured rental details from a post already confirmed as a rental.
 *
 * Gemini infers the neighborhood directly from the post text. If it gets it
 * wrong the user can correct it via the inline tag editor — those corrections
 * are stored as tags_human_override and passed back as few-shot examples so
 * Gemini learns the local neighborhood names over time.
 *
 * @param {object}   args
 * @param {string}   args.apiKey   — Gemini API key
 * @param {object}   args.post     — the post to extract tags from
 * @param {object[]} args.examples — posts with tags_human_override (few-shot)
 * @returns {Promise<{price,rooms,size,roommates,broker,neighborhood,entry_date}|null>}
 */
export async function extractPostTags({ apiKey, post, examples = [] }) {
  if (!apiKey) throw new Error('No Gemini API key configured');

  await enforceRateLimit();
  await checkDailyLimit();

  // Build conversation: human-corrected examples as few-shot turns, then the post.
  const contents = [];
  for (const ex of examples) {
    if (!ex.tags_human_override) continue;
    contents.push({ role: 'user',  parts: [{ text: formatPostForPrompt(ex, false) }] });
    contents.push({ role: 'model', parts: [{ text: JSON.stringify(ex.tags_human_override) }] });
  }
  contents.push({ role: 'user', parts: [{ text: formatPostForPrompt(post, false) }] });

  const response = await callGeminiWithFallback(apiKey, {
    systemInstruction: { parts: [{ text: TAGS_SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: TAGS_SCHEMA,
      temperature: 0.0,
    },
  });

  const data = await response.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    const t = JSON.parse(raw);

    const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
    let neighborhood            = typeof t.neighborhood === 'string' ? t.neighborhood.trim() || null : null;
    let neighborhood_confidence = VALID_CONFIDENCE.has(t.neighborhood_confidence) ? t.neighborhood_confidence : null;
    let neighborhood_evidence   = typeof t.neighborhood_evidence === 'string' ? t.neighborhood_evidence.trim() || null : null;

    // Manual override: if the post text contains a key from NEIGHBORHOOD_OVERRIDES,
    // replace whatever Gemini returned for neighborhood with the authoritative value.
    const textLower = (post.text || '').toLowerCase();
    for (const [key, canonical] of Object.entries(NEIGHBORHOOD_OVERRIDES)) {
      if (textLower.includes(key.toLowerCase())) {
        neighborhood            = canonical;
        neighborhood_confidence = 'high';
        neighborhood_evidence   = '<override>';
        break;
      }
    }

    return {
      price:                   typeof t.price     === 'number'  ? t.price                      : null,
      rooms:                   typeof t.rooms     === 'number'  ? t.rooms                      : null,
      size:                    typeof t.size      === 'number'  ? t.size                       : null,
      roommates:               typeof t.roommates === 'boolean' ? t.roommates                  : null,
      broker:                  typeof t.broker    === 'boolean' ? t.broker                     : null,
      neighborhood,
      neighborhood_confidence: neighborhood ? neighborhood_confidence : null,
      neighborhood_evidence:   neighborhood ? neighborhood_evidence   : null,
      entry_date:              typeof t.entry_date === 'string' ? t.entry_date.trim() || null  : null,
    };
  } catch {
    console.warn('[TLV Rentals] Failed to parse tags JSON:', raw.slice(0, 100));
    return null;
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

// Format a post into the prompt body. Includes author + group because the user
// opted to send them — author identity is a useful signal (realtors post from
// a stable handle, friends offering sublets vary more).
function formatPostForPrompt(post, truncate) {
  const parts = [];
  if (post.author_name) parts.push(`Author: ${post.author_name}`);
  if (post.group_name)  parts.push(`Group: ${post.group_name}`);
  let text = post.text || '(no text)';
  if (truncate && text.length > EXAMPLE_MAX_CHARS) {
    text = text.slice(0, EXAMPLE_MAX_CHARS) + '…';
  }
  parts.push(`Text:\n${text}`);
  return parts.join('\n');
}

// Gemini usually replies with exactly the label, but be tolerant of stray
// punctuation, code-fences, or verbose replies.
function parseLabel(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/['"`.\s]/g, '');
  if (cleaned === 'rental')     return 'rental';
  if (cleaned === 'notrental')  return 'not_rental';
  if (cleaned === 'not_rental') return 'not_rental';
  // Substring fallbacks for verbose replies ("This is a rental listing.")
  if (raw.includes('not_rental') || raw.includes('not rental')) return 'not_rental';
  if (raw.includes('rental')) return 'rental';
  return null;
}
