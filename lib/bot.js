// lib/bot.js — Telegram bot command interface (stage 7d)
//
// Lets the user (re)configure notification preferences from their phone.
// There is no server: the extension's service worker polls getUpdates on a
// 30-second chrome.alarms tick, and switches to long-poll bursts while a
// conversation is active so wizard answers get near-instant replies. The
// in-flight fetch keeps the MV3 worker awake during a burst; the alarm is
// the safety net that revives it otherwise.
//
// Commands:
//   /start  — bind this chat (first time) and run the setup wizard
//   /reset  — clear preferences to defaults and re-run the wizard
//   /status — show current settings
//   /on /off — enable / disable alerts
//   /cancel — abort the wizard, keep previous settings
//   /help   — command list
//
// Security: when no chat_id is configured, the FIRST chat to send /start
// becomes the bound chat (auto-bind). Messages from any other chat are
// dropped silently, before any command parsing.
//
// Delivery semantics: each update is acknowledged (offset persisted) BEFORE
// it is handled — at-most-once. A crash mid-command loses that one message
// rather than replaying commands on every restart.

import {
  getNotifySettings, saveNotifySettings, sendTelegram, DEFAULT_NOTIFY_SETTINGS,
} from './notify.js';

const STATE_KEY             = 'notify_bot_state';
const LONG_POLL_SECONDS     = 20;
const BURST_MAX_IDLE_ROUNDS = 6;  // ≈2 min of empty long-polls ends a burst

// ── Bot state (persisted so a worker restart resumes mid-wizard) ────────────
// { last_update_id: number|null, wizard: { step, draft }|null }

async function getState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  return { last_update_id: null, wizard: null, ...(stored || {}) };
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
  params.set('allowed_updates', '["message"]');
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
          if (u.message) {
            try { await handleMessage(u.message); }
            catch (err) { console.warn('[TLV Rentals] Bot command failed:', err); }
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
  '/cancel — abort setup',
  '/help — this list',
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
    if (st.wizard) {
      await patchState({ wizard: null });
      await reply('Setup cancelled — previous preferences kept.\n\n' + formatSettings(s));
    } else {
      await reply('Nothing to cancel.');
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

  // Plain text: a wizard answer if one is running, otherwise a nudge.
  const st = await getState();
  if (st.wizard) {
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
  return ['skip', '-', 'none', 'דלג'].includes(text.toLowerCase());
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

// Exposed for unit tests only.
export const __test__ = {
  commandOf, parseMaxPrice, parseRooms, parseRoommates, parseBroker, parseKeywords,
};
