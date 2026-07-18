// lib/notify.js — Telegram notification plumbing (Stage 7)
//
// Used by: background.js (send an alert when a newly saved post matches the
// user's preferences), dashboard.js (Notifications settings panel, test
// message, chat-id detection), and lib/bot.js (editTelegramMessage /
// answerCallbackQuery power the phone-side "🚩 Miss" correction flow).
//
// Messages are sent as PLAIN TEXT — no parse_mode. Hebrew rental posts are
// full of characters (<, &, _, *) that would break HTML/Markdown parse modes;
// plain text can never fail to render.
//
// This is the ONLY file in the extension that talks to a non-Facebook origin.
// The api.telegram.org host permission exists solely for these calls, and
// nothing is sent unless the user has enabled notifications and provided
// their own bot token.

const SETTINGS_KEY = 'notify_settings';

// One flat object under a single chrome.storage.local key. Nulls mean
// "no constraint". Missing extracted tag fields on a post never exclude it
// (nulls pass — the user chose recall over precision).
export const DEFAULT_NOTIFY_SETTINGS = {
  enabled: false,
  bot_token: '',
  chat_id: '',
  max_price: null,        // ₪/month upper bound, or null = no limit
  min_rooms: null,        // number | null
  max_rooms: null,        // number | null
  roommates: 'either',    // 'yes' | 'no' | 'either'
  broker: 'either',       // 'yes' | 'no' | 'either'
  include_keywords: [],   // notify only if at least one appears (empty = no constraint)
  exclude_keywords: [],   // skip if any appears
};

// Read settings, back-filling any field added after the user last saved.
export async function getNotifySettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return { ...DEFAULT_NOTIFY_SETTINGS, ...(stored || {}) };
}

export async function saveNotifySettings(settings) {
  const merged = { ...DEFAULT_NOTIFY_SETTINGS, ...settings };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

// ── Telegram Bot API ─────────────────────────────────────────────────────────

// Send one plain-text message. Throws with Telegram's own description on
// failure (wrong token → 401 "Unauthorized"; user never pressed Start →
// 403 "bot can't initiate conversation"; bad chat_id → 400 "chat not found").
// replyMarkup is passed straight through as Telegram's reply_markup (e.g. an
// inline_keyboard) — optional, used by the alert's "🚩 Miss" button.
export async function sendTelegram(botToken, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    },
  );
  const resBody = await res.json().catch(() => null);
  if (!res.ok || !resBody || !resBody.ok) {
    const why = resBody?.description || `HTTP ${res.status}`;
    throw new Error(`Telegram sendMessage failed: ${why}`);
  }
  return resBody.result;
}

// Edit a message's text and/or inline keyboard in place — used by the bot's
// correction flow so one round-trip stays one message instead of spawning a
// new bubble per step. replyMarkup is ALWAYS sent explicitly (even as an
// empty inline_keyboard) rather than omitted, because Telegram's behaviour
// when reply_markup is absent from an edit is not something to rely on.
export async function editTelegramMessage(botToken, chatId, messageId, text, replyMarkup) {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/editMessageText`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    chatId,
        message_id: messageId,
        text,
        reply_markup: replyMarkup || { inline_keyboard: [] },
      }),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.ok) {
    const why = body?.description || `HTTP ${res.status}`;
    throw new Error(`Telegram editMessageText failed: ${why}`);
  }
  return body.result;
}

// Acknowledge a button tap so Telegram's client dismisses the loading
// spinner. Callback queries can legitimately fail to answer (expired, or
// already answered by a previous worker tick) — never let that break the
// correction flow, so errors are swallowed here rather than thrown.
export async function answerCallbackQuery(botToken, callbackQueryId, text, showAlert) {
  try {
    const body = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    if (showAlert) body.show_alert = true;
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[TLV Rentals] answerCallbackQuery failed:', err.message || err);
  }
}

// Find the user's chat_id from the bot's pending updates. Works only if the
// user has messaged the bot recently (getUpdates retains ~24h). Returns the
// chat id of the most recent private message, or null if none found.
export async function detectChatId(botToken) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.ok) {
    const why = body?.description || `HTTP ${res.status}`;
    throw new Error(`Telegram getUpdates failed: ${why}`);
  }
  for (let i = body.result.length - 1; i >= 0; i--) {
    const msg = body.result[i].message || body.result[i].edited_message;
    if (msg?.chat?.id) return String(msg.chat.id);
  }
  return null;
}

// ── Message formatting ───────────────────────────────────────────────────────

const SNIPPET_LEN = 200;

// Build the plain-text alert for one matching post. Human tag corrections
// win over regex-extracted tags, mirroring the dashboard's display logic.
export function formatPostMessage(post) {
  const t = post.tags_human_override || post.tags || {};
  const lines = ['🏠 New rental match'];

  const facts = [];
  if (t.price != null) facts.push(`₪${t.price}`);
  if (t.rooms != null) facts.push(`${t.rooms} rooms`);
  if (t.size  != null) facts.push(`${t.size} m²`);
  if (facts.length) lines.push(facts.join(' · '));

  if (t.entry_date != null)      lines.push(`Entry: ${t.entry_date}`);
  if (t.roommates === true)      lines.push('Roommates listing');
  if (t.broker === true)         lines.push('Broker fee');

  if (post.group_name) lines.push(`Group: ${post.group_name}`);

  const text = (post.text || '').trim();
  if (text) {
    const snippet = text.length > SNIPPET_LEN
      ? text.slice(0, SNIPPET_LEN) + '…'
      : text;
    lines.push('', snippet);
  }

  lines.push('');
  if (post.permalink) {
    lines.push(post.permalink);
  } else {
    lines.push('(no link — open the dashboard to view this post)');
  }

  return lines.join('\n');
}

// ── Preference matching ──────────────────────────────────────────────────────

// Decide whether a post qualifies for a notification under the user's saved
// preferences. NULLS PASS: a rule only excludes a post when the extracted
// field exists AND violates it — a post whose price the regex couldn't read
// is never silenced by the max-price rule. The user chose recall over
// precision (missing an apartment is worse than an extra ping).
//
// Label rule: only a confirmed 'not_rental' is excluded. 'rental' and the
// (rare, post-v1.3.0) null label both qualify.
export function matchesPreferences(post, s) {
  const label = post.human_label || post.ai_label;
  if (label === 'not_rental') return false;

  const t = post.tags_human_override || post.tags || {};

  if (s.max_price != null && t.price != null && t.price > s.max_price) return false;
  if (s.min_rooms != null && t.rooms != null && t.rooms < s.min_rooms) return false;
  if (s.max_rooms != null && t.rooms != null && t.rooms > s.max_rooms) return false;

  if (s.roommates === 'yes' && t.roommates === false) return false;
  if (s.roommates === 'no'  && t.roommates === true)  return false;

  if (s.broker === 'yes' && t.broker === false) return false;
  if (s.broker === 'no'  && t.broker === true)  return false;

  const text = (post.text || '').toLowerCase();
  if (s.include_keywords?.length &&
      !s.include_keywords.some(k => text.includes(k.toLowerCase()))) return false;
  if (s.exclude_keywords?.length &&
      s.exclude_keywords.some(k => text.includes(k.toLowerCase()))) return false;

  return true;
}
