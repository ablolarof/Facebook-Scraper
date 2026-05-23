// popup/popup.js — Popup controller
//
// Communication pattern:
//   popup → content script : chrome.tabs.sendMessage(tabId, ...)
//   popup → background     : chrome.runtime.sendMessage(...)   (for dashboard + counts)
//
// The popup polls the content script once per second via GET_STATS to update
// the live status line. This is simpler and easier to debug than a persistent
// port connection.

// ── Tunables (single source of truth for "continue N more …" buttons) ──────
// These drive both the continuation-banner button labels and the values sent
// to the content script's CONTINUE_SCRAPE handler. Change them here only.
const CONTINUE_POSTS   = 50;
const CONTINUE_MINUTES = 5;
// ───────────────────────────────────────────────────────────────────────────

let activeTabId   = null;   // the Facebook tab we're controlling
let pollInterval  = null;   // setInterval handle for the stats poll
let scrapeOptions = {};     // most-recently-used stop-condition values

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Restore previously saved settings (if any). The stored values flow into
  // the input fields, and startScrape() then reads back from the fields — so
  // the inputs are the source of truth at scrape time, and storage just seeds
  // them on each popup open.
  const saved = await chrome.storage.local.get(['maxDupes', 'maxDurationMins']);
  if (saved.maxDupes)        el('max-dupes').value    = saved.maxDupes;
  if (saved.maxDurationMins) el('max-duration').value = saved.maxDurationMins;

  // Template the continuation-banner button labels from the constants above.
  el('continue-posts-btn').textContent = `Continue ${CONTINUE_POSTS} more posts`;
  el('continue-time-btn').textContent  = `Continue ${CONTINUE_MINUTES} more minutes`;

  // Find the active tab and work out whether we're on a Facebook page.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  await checkPageStatus();
  await loadTotalCount();
  bindButtons();
});

// ── Page status ───────────────────────────────────────────────────────────────
async function checkPageStatus() {
  const statusEl  = el('page-status-text');
  const scrapeBtn = el('scrape-btn');

  if (!activeTabId) {
    statusEl.textContent = 'No active tab found.';
    return;
  }

  try {
    const resp = await chrome.tabs.sendMessage(activeTabId, { type: 'PING' });

    // Any facebook.com tab where the content script responded is scrapable.
    // getGroupId() always returns one of <id> | 'feed' | 'home' so resp.groupId
    // is always truthy once alive — but we check defensively in case the
    // PING contract ever changes.
    const onValidPage = resp?.alive && resp.groupId;

    if (onValidPage) {
      statusEl.textContent = `On: ${resp.groupName || resp.groupId}`;
      scrapeBtn.disabled = false;

      // If a scrape was already running when the popup was (re)opened, jump
      // straight into the live-status view so the user doesn't lose the session.
      const stats = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_STATS' });
      if (stats?.running) {
        showScrapingUI();
        startPolling();
      }
    } else {
      statusEl.textContent = 'Not on a Facebook page.';
    }
  } catch {
    // Content script not present — most likely the tab needs a reload.
    statusEl.textContent = 'Reload the Facebook tab, then try again.';
  }
}

// ── Button wiring ─────────────────────────────────────────────────────────────
function bindButtons() {
  el('scrape-btn').addEventListener('click', startScrape);
  el('stop-btn').addEventListener('click', stopScrape);
  el('continue-posts-btn').addEventListener('click', () => continueScrape('posts'));
  el('continue-time-btn').addEventListener('click',  () => continueScrape('time'));
  el('done-btn').addEventListener('click', hideContinuationBanner);
  el('open-dashboard-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  });
  el('settings-link').addEventListener('click', toggleSettings);
  el('save-key-btn').addEventListener('click',   saveApiKey);
  el('clear-key-btn').addEventListener('click',  clearApiKey);

  // Show current key status as soon as the popup opens.
  refreshKeyStatus();
}

// ── Settings panel ────────────────────────────────────────────────────────────
async function toggleSettings(e) {
  e.preventDefault();
  const panel = el('settings-panel');
  const link  = el('settings-link');
  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  link.classList.toggle('active', willShow);
  if (willShow) refreshKeyStatus();
}

async function saveApiKey() {
  const key = el('api-key-input').value.trim();
  if (!key) {
    setKeyStatus('Enter a key first.', 'error');
    return;
  }
  // Gemini keys from AI Studio are Google API keys, typically AIza… (39 chars).
  // Warn but don't block — Google may issue keys with different prefixes too.
  if (!key.startsWith('AIza')) {
    if (!confirm('Gemini keys usually start with "AIza" — save anyway?')) return;
  }
  await chrome.storage.local.set({ gemini_api_key: key });
  el('api-key-input').value = '';
  setKeyStatus('Saved. New scraped posts will auto-classify.', 'ok');
}

async function clearApiKey() {
  await chrome.storage.local.remove('gemini_api_key');
  el('api-key-input').value = '';
  setKeyStatus('Cleared. Auto-classification is now off.', 'ok');
}

async function refreshKeyStatus() {
  const { gemini_api_key } = await chrome.storage.local.get('gemini_api_key');
  if (gemini_api_key) {
    // Show only the last 4 chars so the user can confirm without seeing it all.
    const tail = gemini_api_key.slice(-4);
    setKeyStatus(`Key set (…${tail}). Auto-classification is on.`, 'ok');
  } else {
    setKeyStatus('No key set. Auto-classification is off.', '');
  }
}

function setKeyStatus(text, tone) {
  const node = el('key-status');
  node.textContent = text;
  node.className = tone; // 'ok' | 'error' | ''
}

async function startScrape() {
  scrapeOptions = {
    duplicateThreshold:  parseInt(el('max-dupes').value)    || 30,
    maxDurationMinutes:  parseInt(el('max-duration').value) || 5,
  };

  // Persist so settings survive popup close/reopen.
  chrome.storage.local.set({
    maxDupes:        scrapeOptions.duplicateThreshold,
    maxDurationMins: scrapeOptions.maxDurationMinutes,
  });

  try {
    await chrome.tabs.sendMessage(activeTabId, { type: 'START_SCRAPE', options: scrapeOptions });
    showScrapingUI();
    startPolling();
  } catch (err) {
    console.error('[TLV Rentals Popup] START_SCRAPE failed:', err);
    alert('Could not start scrape. Make sure you are on a Facebook group page and reload it.');
  }
}

async function stopScrape() {
  stopPolling();
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_SCRAPE' });
  } catch { /* tab may have closed */ }
  hideScrapingUI();
  await loadTotalCount();
}

async function continueScrape(mode) {
  hideContinuationBanner();

  const extra = mode === 'posts'
    ? { extraPosts:   CONTINUE_POSTS,   duplicateThreshold: scrapeOptions.duplicateThreshold }
    : { extraMinutes: CONTINUE_MINUTES, duplicateThreshold: scrapeOptions.duplicateThreshold };

  try {
    await chrome.tabs.sendMessage(activeTabId, { type: 'CONTINUE_SCRAPE', options: extra });
    showScrapingUI();
    startPolling();
  } catch (err) {
    console.error('[TLV Rentals Popup] CONTINUE_SCRAPE failed:', err);
  }
}

// ── Polling (1-second stats refresh while scraping) ───────────────────────────
function startPolling() {
  stopPolling(); // guard against double-start
  pollInterval = setInterval(pollStats, 1000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function pollStats() {
  try {
    const stats = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_STATS' });
    renderStatusLine(stats);

    // Scrape ended — show the continuation banner.
    if (!stats.running && stats.stopReason) {
      stopPolling();
      hideScrapingUI();
      showContinuationBanner(stats.stopReason);
      await loadTotalCount();
    }
  } catch {
    // Tab navigated away or script crashed.
    stopPolling();
    hideScrapingUI();
    el('page-status-text').textContent = 'Connection lost — reload the group page.';
  }
}

function renderStatusLine(stats) {
  const elapsed   = formatElapsed(stats.elapsedMs || 0);
  const scanned   = stats.postsCaptured  || 0;
  const dupes     = stats.totalDuplicates || 0;
  const newPosts  = Math.max(0, scanned - dupes);
  el('status-line').textContent =
    `Scraping… ${scanned} scanned (${newPosts} new + ${dupes} duplicates) · ${elapsed}`;
}

// ── UI state helpers ───────────────────────────────────────────────────────────
function showScrapingUI() {
  el('controls').classList.add('hidden');
  el('continuation-banner').classList.add('hidden');
  el('scrape-status').classList.remove('hidden');
}

function hideScrapingUI() {
  el('scrape-status').classList.add('hidden');
  el('controls').classList.remove('hidden');
}

function showContinuationBanner(reason) {
  const messages = {
    max_dupes:    `Stopped: ${scrapeOptions.duplicateThreshold} duplicates in a row.`,
    max_duration: `Stopped: ${scrapeOptions.maxDurationMinutes}-minute limit reached.`,
    manual:       'Scrape stopped manually.',
  };
  el('stop-reason-text').textContent = messages[reason] || 'Scrape stopped.';
  el('continuation-banner').classList.remove('hidden');
}

function hideContinuationBanner() {
  el('continuation-banner').classList.add('hidden');
}

async function loadTotalCount() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_TOTAL_COUNT' });
    el('total-stored').textContent = `Total stored: ${resp?.count ?? 0} posts`;
  } catch {
    el('total-stored').textContent = 'Total stored: —';
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function formatElapsed(ms) {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = String(totalSecs % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}
