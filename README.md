# Tel Aviv Facebook Rental Scraper

> A Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental listings from Facebook groups, classifies them with a local regex pass and Google Gemini AI, and presents them in a filterable dashboard — so you can actually find a flat without drowning in posts.
>
> Vibe-coded with Claude (https://claude.ai) by Anthropic.

---

## Features

- **One-click scraping** — open any Facebook group or feed, click *Scrape This Feed* in the popup, and the extension auto-scrolls and captures posts. Configurable stop conditions (N consecutive duplicates, or a time limit). A continuation banner lets you push past the stop point for 50 more posts or 5 more minutes.
- **Auto-classify on save** — every captured post runs through a two-tier classifier:
  1. **Local regex** (`lib/regex_extractor.js`) — instant, no API quota, catches the obvious cases (`להשכרה`, `שכירות`, `for rent`, monthly-price patterns; `למכירה`, `for sale` for non-rentals).
  2. **Google Gemini** — only invoked when the regex returns null (ambiguous post). Uses `gemini-2.5-flash-lite` with a fallback to `gemini-2.5-flash` on 503/429 errors, exponential back-off retries, and a 25-second per-request timeout.
- **Structured tag extraction** — for every rental post, the extension extracts: price (₪/mo), rooms, size (m²), neighborhood, entry date, whether it's a roommate listing, and whether a broker fee applies. Regex runs first; Gemini fills the gaps for non-trivial cases.
- **See-more expansion** — Facebook collapses long posts with a "See more" / "ראה עוד" button. The scroller clicks them before extraction so the full text ends up in the database (not a 250-char preview).
- **Marketplace cross-posts** — Marketplace listings (`/commerce/listing/`, `/marketplace/item/`) that appear in groups are captured too, with their own post-ID prefixes (`cl_…`, `mp_…`).
- **In-group permalink preference** — on a specific group page, the extractor rejects cross-card pollution (Recommended Reels, links to other groups, cross-post originals) and only accepts permalinks that match the current group or are Marketplace listings.
- **Deterministic neighborhood overrides** — a curated list of 40+ Hebrew neighborhood names (sourced from the Tel Aviv municipal GIS, layer 511) matched against the post text before Gemini runs. Override matches win with `confidence: high`.
- **Filterable dashboard** — sort by scraped/posted date, price, or rooms; filter by status, label, label source (human vs AI), days posted, days scraped, free-text search, price range, rooms range, roommates, broker fee, entry-date range, neighborhood, and duplicates visibility.
- **Human-in-the-loop training** — correct any label or tag via the inline editor. Corrections are stored as `tags_human_override` and fed back to Gemini as few-shot examples on subsequent calls. Labels are also synced to the optional local training server.
- **Optional Python training server** (`server/`) — a FastAPI/SQLite service at `http://localhost:8765` that mirrors labeled posts into a durable `training.db`, so corrections survive a browser-data clear. Fire-and-forget — the extension never blocks on it.
- **Deduplication** — posts are fingerprinted on save (SHA-256 of normalised text + first image URL). Re-scraping the same feed never creates duplicates; a duplicate inherits the original's AI label so we don't waste API quota re-classifying identical content.
- **Mark as duplicate** — manually flag cross-posted listings that the hash didn't catch (e.g. slightly different wording). They drop out of the default view; toggle the *Duplicates* checkbox to see them again.
- **Permanent delete** — a 🗑 button on each card. Deleted posts come back if Facebook still shows them on a future scrape — there's no permanent blocklist.
- **Auto-scrape URL parameter** — appending `?tlv_auto_scrape=1` to a Facebook URL starts a 30-minute scrape automatically after a 4-second render delay, no popup interaction required. Useful for scheduled-task workflows.
- **Export JSON** — dump every IndexedDB record to a JSON file for backup, external analysis, or bulk-import into the training server.

---

## Architecture

```
Facebook feed
      │  content scripts: extractor.js + scroller.js + content.js
      ▼
chrome.runtime.sendMessage(SAVE_POST)
      ▼
background.js (service worker — extension origin)
      │  ├─ lib/dedup.js          → SHA-256 fingerprint
      │  ├─ lib/db.js             → IndexedDB upsert
      │  ├─ lib/regex_extractor.js → instant classification + tag extraction
      │  └─ lib/gemini.js         → Gemini API (only when regex returns null)
      ▼
IndexedDB ("tlv-rentals", store "posts")
      │
      ├──→ dashboard.html ←─ filter, sort, label, edit tags, export
      │
      └──→ http://localhost:8765/label (optional training server, fire-and-forget)
```

### Why this split?

- **Content scripts** run at the `facebook.com` origin. They can read the Facebook DOM but their `indexedDB` belongs to Facebook, not the extension. They have no `host_permissions` for the Gemini API either.
- **Service worker + dashboard** run at the `chrome-extension://[id]` origin and share one IndexedDB. The service worker holds the `host_permissions` for `generativelanguage.googleapis.com` and `localhost:8765`.
- Content scripts therefore never touch storage directly — every post is sent to the service worker via `chrome.runtime.sendMessage`, which is the only path that can write the extension's IndexedDB.

---

## Prerequisites

- **Chrome** (or any Chromium-based browser that supports Manifest V3 — Edge, Arc, Brave).
- A **Google Gemini API key** — get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The free tier covers a personal scraper comfortably (~1,500 requests/day on `gemini-2.5-flash-lite`).
- **Python 3.10+** — only needed if you want to run the optional training server.

---

## Installation

The extension is not published to the Chrome Web Store. Load it unpacked:

1. Clone or download this repository:
   ```bash
   git clone https://github.com/ablolarof/tel-aviv-facebook-scraper.git
   ```
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
5. The 🏠 TLV Rentals icon appears in your toolbar.

---

## Setup

1. Click the 🏠 icon to open the popup.
2. Click **Settings** at the bottom.
3. Paste your Gemini API key and click **Save**. The key is stored in `chrome.storage.local` on your machine only and is sent nowhere except Google's Gemini API.

The extension still works without a Gemini key — regex handles the obvious cases, and you can label everything by hand. Gemini just fills in the ambiguous middle.

---

## Usage

### Scraping

1. Navigate to a Facebook group or feed that contains rental listings.
2. Click the 🏠 icon and press **Scrape This Feed**.
3. The extension auto-scrolls and captures posts until it hits the configured stop condition (default: 30 consecutive duplicates or 5 minutes).
4. Press **■ Stop** at any time to end early. When a stop condition fires, you can **Continue 50 more posts**, **Continue 5 more minutes**, or **Done**.

### Dashboard

Click **Open Dashboard ↗** in the popup (or navigate to `chrome-extension://[id]/dashboard/dashboard.html`).

- **Classify & Tag** — two-phase Gemini backfill: classify every unlabeled post, then extract tags from every rental post that doesn't have them yet. Handles 429/quota errors with a 60-second cooldown and a clean abort on full daily exhaustion.
- **Regex Extract** — runs the local regex extractor on every rental post that hasn't been human-corrected yet. Instant, no API calls. Regex wins when it finds something; existing Gemini values fill the gaps.
- **Rental / Not rental** buttons — override the AI label. Marking a post as rental immediately triggers regex tag extraction, falling back to Gemini if regex came up empty.
- **✏ Edit tags** — correct any extracted field (or the classification itself). Corrections are stored as `tags_human_override` and used as few-shot examples on future Gemini extractions.
- **Show more / Show less** — long card text is line-clamped to 3 lines; click to expand inline. The expanded state persists across re-renders.
- **⊘ Dupe** — toggle a post's duplicate flag manually. Duplicates are hidden from the default view; check *Duplicates* in the sidebar to see them again.
- **🗑 Delete** — permanently remove a post. It will be re-scraped if it still appears on Facebook.
- **Export JSON** — download every IndexedDB record as a JSON file.

### Auto-scrape via URL parameter

Append `?tlv_auto_scrape=1` to any Facebook URL and the content script will start a 30-minute scrape automatically after a 4-second render delay. Useful when wiring up a scheduled task that opens a tab at a fixed time.

---

## Optional: Training server

The `server/` folder contains a small FastAPI service that persists labeled posts into a SQLite database (`training.db`) so they survive a browser-data clear or a fresh install. The extension fires labels at it best-effort — if the server is down, corrections are still safe in IndexedDB.

### Running it

On Windows:

```cmd
cd server
start.bat
```

On macOS / Linux:

```bash
cd server
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8765
```

### Endpoints

| Method | Path           | Purpose                                                                |
|--------|----------------|------------------------------------------------------------------------|
| GET    | `/health`      | Liveness check                                                         |
| GET    | `/stats`       | Label counts + progress toward a 500-post training threshold           |
| POST   | `/label`       | Save / upsert one labeled post (called automatically by the extension) |
| POST   | `/import-bulk` | One-time backfill — POST the dashboard's Export JSON file to seed `training.db` |

Bulk-import example:

```bash
curl -X POST http://localhost:8765/import-bulk \
     -H "Content-Type: application/json" \
     -d @tlv-rentals-2026-05-24.json
```

The server binds to `127.0.0.1` only — it is not reachable from the network.

---

## Project structure

```
.
├── manifest.json                       # MV3 manifest
├── background.js                       # Service worker — message router, dedup, auto-classify, training-server sync
├── content/
│   ├── content.js                      # Orchestrator + popup-message handler + auto-scrape detector
│   ├── extractor.js                    # DOM → post object (text, author, group, permalink, images, timestamps)
│   └── scroller.js                     # MutationObserver-based feed scroller + "See more" expander
├── popup/
│   ├── popup.html
│   ├── popup.js                        # Scrape controls, live status (1s poll), continuation banner, Gemini settings
│   └── popup.css
├── dashboard/
│   ├── dashboard.html
│   ├── dashboard.js                    # Filters, rendering, Classify & Tag, Regex Extract, tag editor, delete
│   └── dashboard.css
├── lib/
│   ├── db.js                           # IndexedDB wrapper (open/save/get/delete + few-shot example queries)
│   ├── dedup.js                        # SHA-256 of normalised text + first image URL
│   ├── gemini.js                       # Gemini API client — model fallback chain, retry/backoff, RPM + daily caps
│   ├── regex_extractor.js              # Local-only classifier + tag extractor (no API calls)
│   └── neighborhood_overrides.js       # Hebrew → canonical English neighborhood map (40+ entries)
├── server/
│   ├── server.py                       # FastAPI training-data sink (SQLite)
│   ├── requirements.txt                # fastapi, uvicorn[standard], pydantic
│   ├── start.bat                       # Windows one-click launcher
│   └── training.db                     # SQLite database (created on first run)
├── icons/                              # 16/48/128 PNG icons
├── JSONs-(Training)/                   # Dashboard JSON exports (kept as training-data backups)
├── CLAUDE.md                           # Project guide for Claude Code
├── LICENSE                             # GNU GPL v3.0
└── README.md
```

---

## Neighborhood detection

Neighborhoods are identified in two tiers:

1. **Deterministic override** (`lib/neighborhood_overrides.js`) — if the post text contains an official Hebrew neighborhood name (e.g. `פלורנטין`, `הצפון הישן`, `כרם התימנים`), that match wins with `confidence: high`. Names sourced from Tel Aviv's municipal GIS boundary dataset (layer 511).
2. **Gemini inference** — if no override fires, Gemini infers the neighborhood from street names, landmarks, and directional clues, returning one of 14 canonical English names. Confidence is `high` / `medium` / `low`, with a 10-30 character evidence substring quoted from the post.

The override pass runs both in `lib/regex_extractor.js` (instant path) and as a final overwrite step in `lib/gemini.js` (in case Gemini returned a different name despite an explicit Hebrew label). User corrections via the tag editor feed back as few-shot examples.

### Canonical neighborhoods

The 14 recognised neighbourhoods (used in filters and Gemini prompts):

| Canonical name           | Hebrew examples              |
|--------------------------|------------------------------|
| Old North                | הצפון הישן                   |
| New North                | הצפון החדש                   |
| Bavli                    | בבלי                         |
| Lev Tel Aviv             | לב תל-אביב, מרכז העיר         |
| Ganei Sarona             | גני שרונה, שרונה              |
| Montefiore               | מונטיפיורי                   |
| Kerem Hateimanim         | כרם התימנים, שוק הכרמל        |
| Neve Zedek               | נווה צדק                     |
| Florentine               | פלורנטין                     |
| Neve Sha'anan            | נווה שאנן                    |
| South Tel Aviv           | שפירא, התקווה, יד אליהו, …    |
| North of the Yarkon      | רמת אביב, גלילות              |
| East of the Ayalon       | —                            |
| Yafo                     | יפו                          |

---

## Rate limiting and quota

`lib/gemini.js` enforces two layers of self-throttling:

- **Per-minute** — sliding 60-second window capped at 990 RPM. When the cap is reached, the client sleeps until the window rotates.
- **Per-day** — a counter in `chrome.storage.local` keyed by `YYYY-MM-DD`. At 9,500 requests in a day it throws a visible error in the dashboard so you can stop and let the quota reset.

On HTTP 503 or 429 from Gemini, the client retries the same model up to 3 times with exponential back-off (2s, 4s, 8s) plus jitter, then falls through to the next model in the chain (`gemini-2.5-flash-lite` → `gemini-2.5-flash`). Other HTTP errors (400, 401, 403) fail immediately — there's no point retrying a bad request or auth failure.

---

## License

This project is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0** as published by the Free Software Foundation.

See [LICENSE](LICENSE) for the full text, or visit [gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0.html).

---

## Disclaimer

This tool is for personal use. Scraping Facebook may be against their Terms of Service. Use responsibly and at your own risk. The extension only contacts Gemini's API and your optional local training server — it never talks to any other external service.
