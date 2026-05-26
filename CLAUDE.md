# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TLV Rentals** is a Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental posts from Facebook feeds and classifies them automatically using Google Gemini AI. Posts are stored in IndexedDB and presented through a filterable dashboard.

The extension runs entirely client-side in Chrome — no external servers are involved except:
- **Gemini API** (for AI classification and tag extraction)
- **Optional training server** at `http://localhost:8765` (for persistent labeled examples; fire-and-forget, fails silently if offline)

---

## Architecture Overview

### Data Flow

```
Facebook Feed
     ↓ (content scripts: extractor.js, scroller.js)
Content Script (facebook.com origin)
     ↓ chrome.runtime.sendMessage (SAVE_POST)
Service Worker / background.js (extension origin)
     ↓ (lib/db.js → IndexedDB, lib/gemini.js → Gemini API)
IndexedDB ("tlv-rentals")
     ↓ (lib/db.js reads)
Dashboard (extension origin, shared IndexedDB)
     ↓ chrome.runtime.sendMessage (CLASSIFY_POST, EXTRACT_TAGS, SYNC_LABEL)
Service Worker (has host_permissions for Gemini API)
```

### Why This Architecture?

- **Content scripts** (facebook.com origin) can see the Facebook DOM but **cannot** directly access the extension's IndexedDB or reach external APIs. They extract posts and send them to the service worker via `chrome.runtime.sendMessage`.
- **Service worker** (extension origin) handles all storage (IndexedDB) and external API calls (Gemini). It has the `host_permissions` required to reach `generativelanguage.googleapis.com`.
- **Dashboard** shares the extension origin with the service worker, so it has direct IndexedDB access (no round-trip required for reads; writes go through the service worker message handler).

### Key Components

| File | Role |
|------|------|
| **manifest.json** | Declares permissions, content scripts, service worker, popup, dashboard. |
| **background.js** | Service worker—message router, deduplication, auto-classification orchestrator, training server sync. |
| **content/extractor.js** | Extracts post data from Facebook DOM (text, images, author, group, timestamps). |
| **content/scroller.js** | Auto-scrolls feed, detects end-of-page, reports duplicates in real-time. |
| **content/content.js** | Main content script—orchestrates scraper state machine, handles popup messages (START_SCRAPE, STOP_SCRAPE, CONTINUE_SCRAPE, GET_STATS, PING). |
| **popup/popup.js** | Popup UI—scrape controls, live status polling (1s intervals), settings, Gemini API key storage. |
| **dashboard/dashboard.js** | Dashboard—loads all posts from IndexedDB, applies filters in-memory (no DB query for each filter change), handles Classify/Tag buttons, inline tag editing. |
| **lib/db.js** | IndexedDB wrapper—savePost, getPost, getAllPosts, deletePost, updatePostStatus, export JSON. Cached connection, auto-reconnect on InvalidStateError. |
| **lib/gemini.js** | Gemini API client—classify (rental or not), extract tags (price, rooms, size, neighborhood, entry date). Includes model fallback chain, rate limiting (990 RPM), daily usage guard (9,500 requests/day). |
| **lib/dedup.js** | Post fingerprinting—SHA256 hash of text + image URLs. |
| **lib/neighborhood_overrides.js** | Deterministic Hebrew→English neighborhood mapping (40+ entries from Tel Aviv municipal GIS). Matched before Gemini inference. |

---

## Common Development Tasks

### Running the Extension Locally

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the repository folder
4. The 🏠 icon appears in the toolbar

### Testing the Scraper

1. Navigate to a Facebook group or feed
2. Open the popup and set a Gemini API key in **Settings** (if not already set)
3. Click **Scrape This Feed** and observe the live status line
4. Stop manually or let it run until the stop condition
5. Open the **Dashboard** to view and filter scraped posts

### Testing the Dashboard

1. Open the dashboard directly: `chrome-extension://[extension-id]/dashboard/dashboard.html`
2. Or click **Open Dashboard ↗** in the popup
3. Click **Classify with Gemini** to backfill AI labels on unlabeled posts
4. Click **Extract Tags** to extract structured fields from rental posts
5. Use the sidebar filters to test filter logic
6. Click **✏ Edit tags** on any post to test tag corrections and training server sync

### Testing Deduplication

1. Scrape the same feed twice with minimal changes to see dedup in action
2. Watch the popup status: `x duplicates found` should increase
3. Check the dashboard: duplicate posts should have `is_duplicate: true` and `duplicate_of: <post_id>`

### Inspecting IndexedDB

1. Open DevTools on the dashboard (`chrome-extension://...`): **F12**
2. Navigate to **Application** > **IndexedDB** > **tlv-rentals** > **posts**
3. Inspect individual records or export the whole store via dashboard's **Export JSON** button

### Testing Gemini Integration

1. Ensure a valid Gemini API key is set in popup settings
2. Click **Classify with Gemini** on the dashboard
3. Watch the browser console (DevTools) for classification logs
4. Check rate-limiting and daily-limit guards in the browser console

---

## Key Concepts & Gotchas

### Deduplication Strategy

Posts are deduplicated by content hash (text + image URLs), not by unique ID. If the same post appears in multiple groups, it will be flagged as a duplicate. The `duplicate_of` field points to the first post's `post_id`.

When a duplicate is detected, it inherits the original's AI label to avoid redundant API calls. If the original was classified as "rental" and tagged, the duplicate inherits those tags too.

### Gemini Model Fallback

If the primary model (`gemini-2.5-flash-lite`) returns a 503 "high demand" error, the code automatically retries with `gemini-2.5-flash`. Any other HTTP error fails immediately (e.g., 401, 429, 500 will not retry).

The fallback chain is defined in `lib/gemini.js` at the top. To add a new model, update the `MODELS` array.

### Few-Shot Examples (Human-in-the-Loop)

When classifying a post, Gemini receives up to 20 human-labeled examples from IndexedDB. When a user corrects a label or tag via the dashboard:
1. The correction is saved to IndexedDB
2. A `SYNC_LABEL` message is sent to the service worker
3. The service worker forwards it to the training server (fire-and-forget) at `http://localhost:8765/label`

If the training server is offline, the sync fails silently — the correction is still saved locally.

### Neighborhood Detection (Two-Tier)

1. **Deterministic override** (`lib/neighborhood_overrides.js`)—if post text contains a Hebrew neighborhood name, match immediately with `confidence: high`
2. **Gemini inference**—if no override matches, Gemini infers from street names and landmarks, returning one of 14 canonical English names

The canonical list is exported from `lib/gemini.js` and used in the dashboard filter and Gemini system prompt.

### Rate Limiting

- **Per-minute cap**: 990 RPM (sliding window, enforced in `lib/gemini.js`)
- **Daily cap**: 9,500 requests/day (checked at call time; throws an error visible in the dashboard when breached)
- **Rate limiter state** lives in the service worker module scope and persists for the lifetime of the service worker

If rate-limited, the code sleeps until the 60-second window rotates.

### Async Patterns & Fire-and-Forget

- **SAVE_POST** → auto-classify (fire-and-forget) + auto-extract tags (fire-and-forget)
  - Content script gets a response immediately; classification happens in parallel
- **CLASSIFY_POST** → awaited; dashboard waits for the result to update UI
- **EXTRACT_TAGS** → awaited; dashboard waits for the result
- **SYNC_LABEL** → fire-and-forget to training server; always responds with `{ ok: true }`

This pattern keeps the UI responsive and the scraper loop fast.

### Content Script Origins & Storage

- **Content scripts** run at `facebook.com` origin, so their `indexedDB` is Facebook's, not the extension's
- **Service worker & dashboard** run at `chrome-extension://[id]` origin, sharing the same IndexedDB
- Content scripts **must** send posts to the service worker via `chrome.runtime.sendMessage` (the only way to write to the extension's IndexedDB)

---

## Message Contracts

### Popup ↔ Content Script

```
popup → PING
content ← { alive, groupId, groupName }

popup → GET_STATS
content ← { running, postsCaptured, duplicatesInARow, totalDuplicates, elapsedMs, startTime, stopReason }

popup → START_SCRAPE { maxDupes, maxDurationMins }
content ← { ok }

popup → STOP_SCRAPE
content ← { ok }

popup → CONTINUE_SCRAPE { maxDupes, maxDurationMins }
content ← { ok }
```

### Content Script ↔ Service Worker

```
content → SAVE_POST { post: { text, author_name, group_id, group_name, image_urls, posted_at, ... } }
sw ← { ok, is_duplicate }

content → GET_TOTAL_COUNT
sw ← { count }
```

### Dashboard ↔ Service Worker

```
dashboard → CLASSIFY_POST { postId }
sw ← { ok, label } or { ok: false, error }

dashboard → EXTRACT_TAGS { postId }
sw ← { ok, tags } or { ok: false, error }

dashboard → SYNC_LABEL { post: { post_id, human_label, tags_human_override, ... } }
sw ← { ok }
```

---

## File Write & Verification

**IMPORTANT**: The Edit and Write tools in this environment have historically failed silently. When modifying files, especially large ones, verify the write succeeded using:

```bash
wc -c <file>  # check byte count
```

For rewrites, prefer bash heredocs over Write tool:

```bash
cat > file.js << 'EOF'
... content ...
EOF
```

(See memory file: `feedback_file_write_verification.md`)

---

## Debugging Tips

### Enable Logging

All major functions log to the browser console with the `[TLV Rentals]` prefix. Open DevTools:
- **Service worker logs**: Extension settings > service worker > **inspect**
- **Content script logs**: Facebook tab > **F12**
- **Dashboard logs**: Dashboard tab > **F12**

### Watch State Machine

In `content/content.js`, the state object tracks:
- `running` — whether a scrape is in progress
- `postsCaptured` — total extracted so far
- `duplicatesInARow` — consecutive duplicates (drives stop condition)
- `totalDuplicates` — all duplicates ever seen
- `elapsedMs` — time elapsed since START_SCRAPE
- `stopReason` — 'max_dupes' | 'max_duration' | 'manual' | null

The popup polls this every 1 second via GET_STATS.

### Test with a Mock Gemini Response

In `lib/gemini.js`, you can inject a mock response by replacing the `fetch` call. Example:

```javascript
// In classifyPost(), replace the fetch:
return Promise.resolve({ label: 'rental' }); // mock
```

Then classification will always return "rental" without hitting the API.

---

## Folder Structure (Quick Ref)

```
.
├── manifest.json                    # MV3 manifest
├── background.js                    # Service worker (main entry point for storage + API)
├── popup/
│   ├── popup.html
│   ├── popup.js                     # Popup UI controller
│   └── popup.css
├── content/
│   ├── extractor.js                 # DOM extraction
│   ├── scroller.js                  # Feed scrolling + duplicate detection
│   └── content.js                   # Orchestration + message handling
├── dashboard/
│   ├── dashboard.html
│   ├── dashboard.js                 # Dashboard UI controller
│   └── dashboard.css
├── lib/
│   ├── db.js                        # IndexedDB wrapper
│   ├── gemini.js                    # Gemini API client
│   ├── dedup.js                     # Post hashing
│   └── neighborhood_overrides.js    # Hebrew→English mapping
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── JSONs-(Training)/                # Export snapshots (for training data backups)
```

---

## Training Data & Export

The dashboard's **Export JSON** button saves all posts as a JSON file. This is useful for:
- Backing up training examples before a fresh scrape
- Feeding data to external analysis tools
- Debugging dedup and classification issues

The local training server (`http://localhost:8765`) maintains a persistent copy of labeled examples if running.

---

## Browser Compatibility

- **Chrome** (Manifest V3 native)
- **Edge, Arc, Brave, Chromium** (any Chromium-based browser supporting MV3)
- Not compatible with Firefox (uses MV2)

---

## Important Security & Privacy Notes

- **No external servers**: The extension only communicates with Gemini API and an optional local server
- **API key storage**: Gemini API key is stored in `chrome.storage.local` (on-disk, not synced to Google)
- **Scraping disclaimer**: Facebook's Terms of Service may restrict scraping. Use responsibly and at your own risk
- **Training data**: Human-labeled corrections are synced to the local training server only (not to any cloud service)

---

## License & Attribution

**GNU General Public License v3.0** — redistribute and modify freely, with attribution.

Vibe-coded with Claude (https://claude.ai) by Anthropic.
