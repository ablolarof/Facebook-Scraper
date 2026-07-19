// lib/bot.js — Telegram bot command interface (stage 7d) + phone-side
// regex-miss correction (stage 7e)
//
// Lets the user (re)configure notification preferences from their phone, and
// correct a miscategorised post directly from its alert message — the same
// correction the dashboard's tag editor makes, writing into the exact same
// fields (tags_human_override, human_label, is_duplicate, regex_miss) so a
// phone correction shows up flagged on the dashboard with zero new dashboard
// code, and rides the existing Export Misses / Re-test Regex pipeline.
//
// There is no server: the extension's service worker polls getUpdates on a
// 30-second chrome.alarms tick, and switches to long-poll bursts while a
// conversation is active so replies get near-instant delivery. The in-flight
// fetch keeps the MV3 worker awake during a burst; the alarm is the safety
// net that revives it otherwise.
//
// Commands:
//   /start  — bind this chat (first time) and run the setup wizard
//   /reset  — clear preferences to defaults and re-run the wizard
//   /status — show current settings
//   /on /off — enable / disable alerts
//   /cancel — abort the wizard or an in-progress correction
//   /help   — command list
//
// Corrections: every alert carries a "🚩 Miss" inline button. Tapping it
// opens a field menu (Classification, Duplicate, Price, Rooms, Size, Entry
// date, Roommates, Broker) in a message that gets edited in place through the
// whole exchange — one bubble per correction session, not one per step.
//
// Security: when no chat_id is configured, the FIRST chat to send /start
// becomes the bound chat (auto-bind). Messages AND button taps from any
// other chat are dropped silently, before any command/callback parsing.
//
// Delivery semantics: each update is acknowledged (offset persisted) BEFORE
// it is handled — at-most-once. A crash mid-command loses that one message
// rather than replaying commands on every restart.

import {
  getNotifySettings, saveNotifySettings, sendTelegram, editTelegramMessage,
  answerCallbackQuery, DEFAULT_NOTIFY_SETTINGS,
} from './notify.js';
import { getPost, savePost, getAllPosts } from './db.js';
import { textSimilarity } from './dedup.js';
import { regexClassifyPost, regexExtractTags, mergeWithRegex } from './regex_extractor.js';
import { runRetrain } from './ml_retrain.js';

const STATE_KEY             = 'notify_bot_state';
const LONG_POLL_SECONDS     = 20;
const BURST_MAX_IDLE_ROUNDS = 6;  // ≈2 min of empty long-polls ends a burst
const DUPLICATE_SIM_THRESHOLD = 0.55; // matches dashboard.js's pairing threshold

// ── Bot state (persisted so a worker restart resumes mid-wizard/correction) ─
// {
//   last_update_id: number|null,
//   wizard: { step, draft } | null,
//   correction: {
//     post_id, message_id,
//     field:  string|null,               // field currently being corrected, or null = at the menu
//     stage:  'value'|'keyphrase'|null,   // 'value' = awaiting free-text value, 'keyphrase' = awaiting evidence text
//     pending_value,                      // the value just applied, kept only for logging/debugging
//   } | null,
// }

async function getState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  return { last_update_id: null, wizard: null, correction: null, ...(stored || {}) };
}

async function patchState(patch) {
  const st = await getState();
  await chrome.storage.local.set({ [STATE_KEY]: { ...st, ...patch } });
}

// ── Telegram API ─────────────────────────────────────────────────────────────

async function tgGetUpdates(botToken, offset, timeoutSec) {
  const params = new URLSearchParams();
  if (offset != null) params.set('offset', String(offset));
  params.set('timeout', String(timeoutSec));
  params.set('allowed_updates', '["message","callback_query"]');
  const res  = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?${params}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.ok) {
    throw new Error(`Telegram getUpdates failed: ${body?.description || 'HTTP ' + res.status}`);
  }
  return body.result;
}

// ── Polling loop ─────────────────────────────────────────────────────────────

let _polling = false; // collapse overlapping alarm ticks within one worker life

export async function pollBot() {
  if (_polling) return;
  _polling = true;
  try {
    const s = await getNotifySettings();
    if (!s.bot_token) return;

    const state = await getState();
    let lastId  = state.last_update_id;

    // Very first poll: acknowledge the whole backlog without acting on it.
    // Messages sent before the bot was configured (e.g. the one used for the
    // dashboard Detect button) must not trigger surprise replies.
    if (lastId == null) {
      const backlog = await tgGetUpdates(s.bot_token, null, 0);
      lastId = backlog.length ? backlog[backlog.length - 1].update_id : 0;
      await patchState({ last_update_id: lastId });
      return;
    }

    // First read is instant (alarm tick). If anything arrived, stay in a
    // long-poll burst until the conversation goes quiet.
    let first = true;
    let idleRounds = 0;
    while (true) {
      const updates = await tgGetUpdates(
        s.bot_token, lastId + 1, first ? 0 : LONG_POLL_SECONDS);

      if (updates.length) {
        idleRounds = 0;
        for (const u of updates) {
          lastId = u.update_id;
          await patchState({ last_update_id: lastId }); // ack first — at-most-once
          try {
            if (u.message)        await handleMessage(u.message);
            else if (u.callback_query) await handleCallbackQuery(u.callback_query);
          } catch (err) {
            console.warn('[TLV Rentals] Bot update failed:', err);
          }
        }
      } else {
        if (first) break; // idle tick, nothing pending — back to the alarm
        if (++idleRounds >= BURST_MAX_IDLE_ROUNDS) break;
      }
      first = false;
    }
  } catch (err) {
    // 409 Conflict = another getUpdates consumer (e.g. the dashboard Detect
    // button) grabbed the connection — harmless, the next tick retries.
    console.warn('[TLV Rentals] Bot poll error:', err.message || err);
  } finally {
    _polling = false;
  }
}

// ── Message routing ──────────────────────────────────────────────────────────

const HELP = [
  'Commands:',
  '/start — set up alert preferences',
  '/reset — clear preferences and set up again',
  '/status — show current preferences',
  '/on /off — enable / disable alerts',
  '/cancel — abort setup or an in-progress correction',
  '/retrain — retrain the ML model on your corrections',
  '/help — this list',
  '',
  'Tip: every alert has a 🚩 Miss button — tap it to correct price, rooms, classification, and more.',
].join('\n');

function commandOf(text) {
  if (!text.startsWith('/')) return null;
  return text.split(/[\s@]/)[0].toLowerCase();
}

async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  if (!text || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const s = await getNotifySettings();

  // Auto-bind: the first chat to /start an unbound bot becomes the owner.
  if (!s.chat_id) {
    if (commandOf(text) === '/start') {
      const bound = await saveNotifySettings({ ...s, chat_id: chatId });
      await sendTelegram(bound.bot_token, chatId,
        '🔗 This chat is now linked to your TLV Rentals extension.');
      await beginWizard(bound);
    }
    return;
  }
  if (chatId !== String(s.chat_id)) return; // stranger — drop silently

  const reply = t => sendTelegram(s.bot_token, s.chat_id, t);
  const cmd   = commandOf(text);

  if (cmd === '/start') {
    await beginWizard(s);
    return;
  }
  if (cmd === '/reset') {
    const cleared = await saveNotifySettings({
      ...s,
      max_price: DEFAULT_NOTIFY_SETTINGS.max_price,
      min_rooms: DEFAULT_NOTIFY_SETTINGS.min_rooms,
      max_rooms: DEFAULT_NOTIFY_SETTINGS.max_rooms,
      roommates: DEFAULT_NOTIFY_SETTINGS.roommates,
      broker:    DEFAULT_NOTIFY_SETTINGS.broker,
      include_keywords: [],
      exclude_keywords: [],
    });
    await reply('♻️ Preferences cleared.');
    await beginWizard(cleared);
    return;
  }
  if (cmd === '/status') {
    await reply(formatSettings(s));
    return;
  }
  if (cmd === '/on' || cmd === '/off') {
    const enabled = cmd === '/on';
    await saveNotifySettings({ ...s, enabled });
    await reply(enabled ? 'Alerts ON ✅' : 'Alerts OFF ⏸');
    return;
  }
  if (cmd === '/cancel') {
    const st = await getState();
    if (st.wizard || st.correction) {
      await patchState({ wizard: null, correction: null });
      await reply('Cancelled.\n\n' + formatSettings(s));
    } else {
      await reply('Nothing to cancel.');
    }
    return;
  }
  if (cmd === '/retrain') {
    // Same pipeline as the dashboard 🧠 button: gold set + every correction
    // (including the ones made right here via 🚩 Miss), gold-gated promotion.
    await reply('🧠 Retraining the ML model on your corrections… (~10–30s)');
    try {
      const r = await runRetrain();
      if (r.promoted) {
        await reply(
          `✅ Model retrained and promoted.\n` +
          `Accuracy (cross-validated): ${(r.cv_accuracy * 100).toFixed(1)}%` +
          ` (was ${(r.previous_cv * 100).toFixed(1)}%)\n` +
          `Trained on ${r.label_rows} labeled posts — ${r.corrections} of them your corrections ` +
          `(${r.new_corrections} new since the last retrain) — ` +
          `plus ${r.broker_rows} broker examples.\n` +
          `New scrapes classify with the new weights immediately.`);
      } else if (r.needs_import) {
        await reply(`⚠️ Retrain refused: ${r.reason}\n(The import can only be done from the dashboard — open it once on the computer.)`);
      } else {
        await reply(`⚠️ Retrain finished but the new weights were NOT promoted.\n${r.reason}\nKeep marking misses and try again later.`);
      }
    } catch (err) {
      await reply('Retrain failed: ' + (err.message || err));
    }
    return;
  }
  if (cmd === '/help') {
    await reply(HELP);
    return;
  }
  if (cmd) {
    await reply('Unknown command.\n\n' + HELP);
    return;
  }

  // Plain text: a correction reply takes priority, then a wizard answer,
  // else a nudge. Correction and wizard never run at the same time in
  // practice, but checking correction first is the safe order regardless.
  const st = await getState();
  if (st.correction?.stage === 'value') {
    await handleCorrectionValue(text, s, st);
  } else if (st.correction?.stage === 'keyphrase') {
    await handleCorrectionKeyPhrase(text, s, st);
  } else if (st.wizard) {
    await handleWizardAnswer(text, s, st);
  } else {
    await reply('Not sure what you mean.\n\n' + HELP);
  }
}

// ── Setup wizard ─────────────────────────────────────────────────────────────
// One question per step; every answer accepts "skip" for no constraint.
// The draft accumulates in persisted state, so a worker restart mid-wizard
// resumes exactly where the user left off.

const WIZARD_STEPS = [
  {
    prompt: '1/6 — Max price (₪/month)?\nReply with a number (e.g. 6500), or "skip" for no limit.',
    parse: parseMaxPrice,
  },
  {
    prompt: '2/6 — Rooms?\nReply with a range like "2-3", a minimum like "2", or "skip".',
    parse: parseRooms,
  },
  {
    prompt: '3/6 — Listing type?\n1 — whole apartment only\n2 — roommate listings only\n3 — either',
    parse: parseRoommates,
  },
  {
    prompt: '4/6 — Broker fee?\n1 — only listings with no broker fee\n2 — either is fine',
    parse: parseBroker,
  },
  {
    prompt: '5/6 — Must contain at least one of…\nComma-separated keywords (e.g. פלורנטין, דיזנגוף), or "skip".',
    parse: parseKeywords('include_keywords'),
  },
  {
    prompt: '6/6 — Skip posts containing…\nComma-separated keywords (e.g. סאבלט, sublet), or "skip".',
    parse: parseKeywords('exclude_keywords'),
  },
];

async function beginWizard(s) {
  await patchState({ wizard: { step: 0, draft: {} } });
  await sendTelegram(s.bot_token, s.chat_id,
    'Let\'s set your alert preferences. Answer each question, or reply "skip". You can /cancel at any time.\n\n'
    + WIZARD_STEPS[0].prompt);
}

async function handleWizardAnswer(text, s, st) {
  const step   = st.wizard.step;
  const parsed = WIZARD_STEPS[step].parse(text);
  const reply  = t => sendTelegram(s.bot_token, s.chat_id, t);

  if (!parsed.ok) {
    await reply('⚠ ' + parsed.error + '\n\n' + WIZARD_STEPS[step].prompt);
    return;
  }

  const draft = { ...st.wizard.draft, ...parsed.fields };
  const next  = step + 1;

  if (next < WIZARD_STEPS.length) {
    await patchState({ wizard: { step: next, draft } });
    await reply(WIZARD_STEPS[next].prompt);
    return;
  }

  // Wizard complete: apply the draft and switch alerts on.
  const updated = await saveNotifySettings({ ...s, ...draft, enabled: true });
  await patchState({ wizard: null });
  await reply('🎉 Setup complete — alerts are ON.\n\n' + formatSettings(updated));
}

// ── Answer parsers ───────────────────────────────────────────────────────────
// Each returns { ok: true, fields: {...} } or { ok: false, error: '...' }.

function isSkip(text) {
  return ['skip', '-', 'none', 'unknown', 'דלג'].includes(text.toLowerCase());
}

function parseMaxPrice(text) {
  if (isSkip(text)) return { ok: true, fields: { max_price: null } };
  const n = parseFloat(text.replace(/[,₪\s]/g, ''));
  if (Number.isFinite(n) && n > 0) return { ok: true, fields: { max_price: n } };
  return { ok: false, error: 'Please reply with a number (e.g. 6500) or "skip".' };
}

function parseRooms(text) {
  if (isSkip(text)) return { ok: true, fields: { min_rooms: null, max_rooms: null } };
  const range = text.match(/^(\d+(?:\.\d+)?)?\s*[-–]\s*(\d+(?:\.\d+)?)?$/);
  if (range && (range[1] || range[2])) {
    const min = range[1] ? parseFloat(range[1]) : null;
    const max = range[2] ? parseFloat(range[2]) : null;
    if (min != null && max != null && min > max) {
      return { ok: false, error: 'Minimum is bigger than maximum.' };
    }
    return { ok: true, fields: { min_rooms: min, max_rooms: max } };
  }
  const single = parseFloat(text);
  if (Number.isFinite(single) && single > 0) {
    return { ok: true, fields: { min_rooms: single, max_rooms: null } };
  }
  return { ok: false, error: 'Please reply like "2-3", "2" (minimum), or "skip".' };
}

function parseRoommates(text) {
  const t = text.toLowerCase();
  if (['1', 'apartment', 'whole', 'דירה'].includes(t)) return { ok: true, fields: { roommates: 'no' } };
  if (['2', 'roommates', 'roommate', 'שותפים'].includes(t)) return { ok: true, fields: { roommates: 'yes' } };
  if (['3', 'either', 'any', 'skip', '-'].includes(t)) return { ok: true, fields: { roommates: 'either' } };
  return { ok: false, error: 'Please reply 1, 2 or 3.' };
}

function parseBroker(text) {
  const t = text.toLowerCase();
  if (['1', 'no', 'ללא תיווך'].includes(t)) return { ok: true, fields: { broker: 'no' } };
  if (['2', 'either', 'any', 'yes', 'skip', '-'].includes(t)) return { ok: true, fields: { broker: 'either' } };
  return { ok: false, error: 'Please reply 1 or 2.' };
}

function parseKeywords(field) {
  return text => {
    if (isSkip(text)) return { ok: true, fields: { [field]: [] } };
    const list = text.split(',').map(k => k.trim()).filter(Boolean);
    return { ok: true, fields: { [field]: list } };
  };
}

// ── Settings summary (also used by /status) ─────────────────────────────────

export function formatSettings(s) {
  const rooms =
    s.min_rooms == null && s.max_rooms == null ? 'any'
      : `${s.min_rooms ?? 'any'}–${s.max_rooms ?? 'any'}`;
  const type = { no: 'whole apartment only', yes: 'roommate listings only', either: 'either' }[s.roommates] || 'either';
  return [
    `Notifications: ${s.enabled ? 'ON ✅' : 'OFF ⏸'}`,
    `Max price: ${s.max_price != null ? '₪' + s.max_price : 'no limit'}`,
    `Rooms: ${rooms}`,
    `Type: ${type}`,
    `Broker: ${s.broker === 'no' ? 'no broker fee only' : 'either'}`,
    `Must contain: ${s.include_keywords?.length ? s.include_keywords.join(', ') : '—'}`,
    `Excluded: ${s.exclude_keywords?.length ? s.exclude_keywords.join(', ') : '—'}`,
  ].join('\n');
}

// ── Phone-side correction flow (🚩 Miss) ─────────────────────────────────────
//
// Every alert carries a "🚩 Miss" button (callback_data mopen:<post_id>).
// Post IDs in this system are always short (permalink-derived Facebook IDs,
// cl_/mp_-prefixed Marketplace IDs, or the h_<djb2-hash> fallback — see
// content/extractor.js::hashString), so they're embedded directly in
// callback_data with room to spare under Telegram's 64-byte limit even in
// the longest variant (mval:<post_id>:classification:not_rental).
//
// callback_data namespace:
//   mopen:<post_id>                    tap the alert's 🚩 Miss button
//   mfield:<post_id>:<field>           pick a field from the menu
//   mval:<post_id>:<field>:<value>     pick a value for a binary/tri-state field
//   mback:<post_id>                    back to the field menu
//   mdone:<post_id>                    end the correction session
//
// All state for an in-progress session lives in notify_bot_state.correction,
// keyed to ONE message_id that gets edited in place through every step —
// tapping 🚩 Miss again always starts a fresh message/session, so an
// abandoned session never blocks a later one (on the same or a different post).

const FIELD_LABELS = {
  classification: '🏷 Classification',
  duplicate:      '⧉ Duplicate',
  price:          '💰 Price',
  rooms:          '🛏 Rooms',
  size:           '📐 Size',
  entry_date:     '📅 Entry date',
  roommates:      '🧑‍🤝‍🧑 Roommates',
  broker:         '💼 Broker fee',
};
const FIELD_ORDER    = ['classification', 'duplicate', 'price', 'rooms', 'size', 'entry_date', 'roommates', 'broker'];
const BINARY_FIELDS  = new Set(['classification', 'duplicate', 'roommates', 'broker']);
const VALUE_PROMPTS  = {
  price:      '💰 New price? (₪/mo, or "unknown")',
  rooms:      '🛏 New room count? (or "unknown")',
  size:       '📐 New size in m²? (or "unknown")',
  entry_date: '📅 New entry date? (YYYY-MM-DD, "immediate", or "unknown")',
};

function fieldMenuKeyboard(postId) {
  const rows = [];
  for (let i = 0; i < FIELD_ORDER.length; i += 2) {
    rows.push(FIELD_ORDER.slice(i, i + 2).map(f => ({
      text: FIELD_LABELS[f], callback_data: `mfield:${postId}:${f}`,
    })));
  }
  rows.push([{ text: '✅ Done', callback_data: `mdone:${postId}` }]);
  return { inline_keyboard: rows };
}

function backKeyboard(postId) {
  return { inline_keyboard: [[{ text: '‹ Back', callback_data: `mback:${postId}` }]] };
}

function valueKeyboard(postId, field) {
  const back = { text: '‹ Back', callback_data: `mback:${postId}` };
  if (field === 'classification') {
    return { inline_keyboard: [
      [{ text: '✓ Rental',     callback_data: `mval:${postId}:classification:rental` }],
      [{ text: '✗ Not rental', callback_data: `mval:${postId}:classification:not_rental` }],
      [back],
    ] };
  }
  if (field === 'duplicate') {
    return { inline_keyboard: [
      [{ text: 'Mark duplicate',   callback_data: `mval:${postId}:duplicate:true` }],
      [{ text: 'Unmark duplicate', callback_data: `mval:${postId}:duplicate:false` }],
      [back],
    ] };
  }
  // roommates / broker
  return { inline_keyboard: [
    [{ text: 'Yes', callback_data: `mval:${postId}:${field}:true` },
     { text: 'No',  callback_data: `mval:${postId}:${field}:false` }],
    [{ text: 'Unknown', callback_data: `mval:${postId}:${field}:null` }],
    [back],
  ] };
}

function postSummary(post) {
  const t = post.tags_human_override || post.tags || {};
  const bits = [];
  if (t.price != null) bits.push('₪' + t.price);
  if (t.rooms != null) bits.push(t.rooms + ' rooms');
  const snippet = (post.text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return [bits.join(' · '), snippet].filter(Boolean).join(' — ') || '(no text)';
}

// ── regex_miss bookkeeping — mirrors dashboard.js exactly ───────────────────
// (openTagEditor/saveTagEdits for tag fields, the toggle-dupe handler for
// duplicate) so a phone correction and a dashboard correction are
// indistinguishable to Export Misses / Re-test Regex.

function addMissField(post, field) {
  const existing = post.regex_miss || {};
  const fields   = existing.missed_fields || [];
  if (fields.includes(field)) return;
  post.regex_miss = {
    ...existing,
    missed_fields: [...fields, field],
    key_phrases:   existing.key_phrases || {},
    flagged_at:    existing.flagged_at || new Date().toISOString(),
    exported_at:   null,
  };
}

function removeMissField(post, field) {
  if (!post.regex_miss) return;
  const fields  = (post.regex_miss.missed_fields || []).filter(f => f !== field);
  const phrases = { ...post.regex_miss.key_phrases };
  delete phrases[field];
  const isEmpty = fields.length === 0 && Object.keys(phrases).length === 0 && !post.regex_miss.note;
  post.regex_miss = isEmpty ? null : {
    ...post.regex_miss,
    missed_fields: fields,
    key_phrases:   phrases,
    exported_at:   null,
  };
}

function addKeyPhrase(post, field, phrase) {
  const existing = post.regex_miss || {};
  post.regex_miss = {
    ...existing,
    missed_fields: existing.missed_fields || [],
    key_phrases:   { ...existing.key_phrases, [field]: phrase },
    flagged_at:    existing.flagged_at || new Date().toISOString(),
    exported_at:   null,
  };
}

// price / rooms / size / entry_date / roommates / broker all live in
// tags (+ tags_human_override) — one shared setter, mirrors saveTagEdits's
// per-field diff (only flagged as a miss when the value actually changes).
function applyTagFieldValue(post, field, value) {
  const base    = { ...(post.tags_human_override || post.tags || {}) };
  const changed = (base[field] ?? null) !== value;
  base[field] = value;
  post.tags                = base;
  post.tags_human_override = base;
  if (changed) addMissField(post, field);
}

// Classification lives on human_label, not tags. Mirrors dashboard.js's
// label buttons: missed_fields tracks 'classification' only while the human
// label disagrees with what the regex would currently say, and marking a
// post rental with no existing override triggers an immediate tag extract.
function applyClassificationValue(post, value) {
  post.human_label = value; // 'rental' | 'not_rental'
  const regexLabel = regexClassifyPost(post.text || '');
  if (post.human_label !== regexLabel) addMissField(post, 'classification');
  else removeMissField(post, 'classification');

  if (post.human_label === 'rental' && !post.tags_human_override) {
    const rt = regexExtractTags(post.text || '');
    post.regex_extracted_at = new Date().toISOString();
    if (rt && Object.values(rt).some(v => v != null)) {
      post.tags = mergeWithRegex(post.tags || null, rt);
    }
  }
}

// Duplicate is a separate flag (not part of tags), with its own pairing
// step — mirrors dashboard.js's toggle-dupe handler exactly, including the
// token-set-Jaccard best-match search over every non-duplicate post.
async function applyDuplicateValue(post, value) {
  post.is_duplicate = value;
  if (value) {
    if (!post.duplicate_of) {
      const posts = await getAllPosts();
      let best = null, bestScore = 0;
      for (const other of posts) {
        if (other.post_id === post.post_id || other.is_duplicate) continue;
        const sim = textSimilarity(post.text || '', other.text || '');
        if (sim > bestScore) { bestScore = sim; best = other; }
      }
      if (best && bestScore >= DUPLICATE_SIM_THRESHOLD) {
        post.duplicate_of  = best.post_id;
        post.duplicate_sim = Math.round(bestScore * 100) / 100;
      }
    }
    addMissField(post, 'duplicate');
  } else {
    post.duplicate_of  = null;
    post.duplicate_sim = null;
    removeMissField(post, 'duplicate');
  }
}

function parseFieldValue(field, text) {
  if (isSkip(text)) return { ok: true, value: null };
  if (field === 'entry_date') return { ok: true, value: text.trim() };
  const n = parseFloat(text.replace(/[,₪\s]/g, ''));
  if (Number.isFinite(n) && n >= 0) return { ok: true, value: n };
  return { ok: false, error: 'Please send a number, or "unknown".' };
}

function formatValue(field, value) {
  if (value == null) return 'unknown';
  return field === 'price' ? '₪' + value : String(value);
}

// Routes every callback_query (button tap). Mirrors handleMessage's chat
// binding + stranger-drop, but a stray/expired button still gets its
// spinner dismissed either way (Telegram requires SOME response).
async function handleCallbackQuery(cq) {
  const s = await getNotifySettings();
  if (!s.bot_token) return;
  if (!s.chat_id || String(cq.message?.chat?.id) !== String(s.chat_id)) {
    await answerCallbackQuery(s.bot_token, cq.id);
    return;
  }
  await answerCallbackQuery(s.bot_token, cq.id);

  const data = cq.data || '';
  const [action, postId, ...rest] = data.split(':');
  const chatId    = s.chat_id;
  const messageId = cq.message.message_id;

  if (action === 'mopen') {
    const post = await getPost(postId);
    if (!post) {
      await sendTelegram(s.bot_token, chatId, '⚠ That post is no longer in the database.');
      return;
    }
    const sent = await sendTelegram(s.bot_token, chatId,
      `Correcting: ${postSummary(post)}\n\nWhat's wrong?`, fieldMenuKeyboard(postId));
    await patchState({ correction: {
      post_id: postId, message_id: sent.message_id, field: null, stage: null, pending_value: null,
    } });
    return;
  }

  const st = await getState();
  if (!st.correction || st.correction.post_id !== postId) return; // stale/expired button — ignore

  if (action === 'mback') {
    await patchState({ correction: { ...st.correction, field: null, stage: null, pending_value: null } });
    await editTelegramMessage(s.bot_token, chatId, messageId, 'What\'s wrong?', fieldMenuKeyboard(postId));
    return;
  }

  if (action === 'mdone') {
    await patchState({ correction: null });
    await editTelegramMessage(s.bot_token, chatId, messageId,
      '👍 Done — corrections saved. They\'ll show up flagged on the dashboard.', null);
    return;
  }

  if (action === 'mfield') {
    const field = rest[0];
    if (BINARY_FIELDS.has(field)) {
      await patchState({ correction: { ...st.correction, field, stage: null, pending_value: null } });
      await editTelegramMessage(s.bot_token, chatId, messageId,
        `${FIELD_LABELS[field]} — pick a value:`, valueKeyboard(postId, field));
    } else {
      await patchState({ correction: { ...st.correction, field, stage: 'value', pending_value: null } });
      await editTelegramMessage(s.bot_token, chatId, messageId, VALUE_PROMPTS[field], backKeyboard(postId));
    }
    return;
  }

  if (action === 'mval') {
    const [field, rawValue] = rest;
    const post = await getPost(postId);
    if (!post) {
      await editTelegramMessage(s.bot_token, chatId, messageId, '⚠ That post is no longer in the database.', null);
      await patchState({ correction: null });
      return;
    }

    // Duplicate has no key-phrase step (the dashboard's ⊘ Dupe button
    // doesn't have one either — the similarity pairing IS the evidence).
    if (field === 'duplicate') {
      await applyDuplicateValue(post, rawValue === 'true');
      await savePost(post);
      await patchState({ correction: {
        post_id: postId, message_id: messageId, field: null, stage: null, pending_value: null,
      } });
      const pairNote = post.is_duplicate
        ? (post.duplicate_of ? ` (paired, similarity ${post.duplicate_sim})` : ' (no similar post found)')
        : '';
      await editTelegramMessage(s.bot_token, chatId, messageId,
        `✅ Duplicate → ${post.is_duplicate ? 'marked' : 'unmarked'}${pairNote}.\n\nWhat's wrong?`,
        fieldMenuKeyboard(postId));
      return;
    }

    if (field === 'classification') {
      applyClassificationValue(post, rawValue); // 'rental' | 'not_rental'
    } else {
      applyTagFieldValue(post, field, rawValue === 'null' ? null : rawValue === 'true');
    }
    await savePost(post);
    await patchState({ correction: {
      post_id: postId, message_id: messageId, field, stage: 'keyphrase', pending_value: rawValue,
    } });
    await editTelegramMessage(s.bot_token, chatId, messageId,
      `✅ ${FIELD_LABELS[field]} updated.\n\n🔎 Key phrase that proves this? (or "skip")`, null);
    return;
  }
}

// Text reply while awaiting a free-text field value (price/rooms/size/entry_date).
async function handleCorrectionValue(text, s, st) {
  const { post_id: postId, field, message_id: messageId } = st.correction;
  const parsed = parseFieldValue(field, text);
  if (!parsed.ok) {
    await editTelegramMessage(s.bot_token, s.chat_id, messageId,
      `⚠ ${parsed.error}\n\n${VALUE_PROMPTS[field]}`, backKeyboard(postId));
    return;
  }

  const post = await getPost(postId);
  if (!post) {
    await editTelegramMessage(s.bot_token, s.chat_id, messageId, '⚠ That post is no longer in the database.', null);
    await patchState({ correction: null });
    return;
  }

  applyTagFieldValue(post, field, parsed.value);
  await savePost(post);
  await patchState({ correction: { ...st.correction, stage: 'keyphrase', pending_value: parsed.value } });
  await editTelegramMessage(s.bot_token, s.chat_id, messageId,
    `✅ ${FIELD_LABELS[field]} → ${formatValue(field, parsed.value)}\n\n🔎 Key phrase that proves this? (or "skip")`,
    null);
}

// Text reply while awaiting a key phrase (or "skip") after a value was applied.
async function handleCorrectionKeyPhrase(text, s, st) {
  const { post_id: postId, field, message_id: messageId } = st.correction;
  const post = await getPost(postId);
  if (!post) {
    await patchState({ correction: null });
    return;
  }

  const phrase = isSkip(text) ? null : text.trim();
  if (phrase) {
    addKeyPhrase(post, field, phrase);
    await savePost(post);
  }
  await patchState({ correction: {
    post_id: postId, message_id: messageId, field: null, stage: null, pending_value: null,
  } });
  await editTelegramMessage(s.bot_token, s.chat_id, messageId,
    `Saved${phrase ? ' with key phrase' : ''}.\n\nWhat's wrong?`, fieldMenuKeyboard(postId));
}

// Exposed for unit tests only.
export const __test__ = {
  commandOf, parseMaxPrice, parseRooms, parseRoommates, parseBroker, parseKeywords,
  parseFieldValue, formatValue, addMissField, removeMissField, addKeyPhrase,
  applyTagFieldValue, applyClassificationValue, applyDuplicateValue,
  fieldMenuKeyboard, valueKeyboard, postSummary,
};
