# Tel Aviv Facebook Rental Scraper

> A Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental listings from Facebook groups, classifies them automatically with Google Gemini AI, and presents them in a filterable dashboard — so you can actually find a flat without drowning in posts.
>
> Vibe-coded with Claude (https://claude.ai) by Anthropic.

---

## Features

- **One-click scraping** — open any Facebook group or feed, click *Scrape This Feed* in the popup, and the extension scrolls and captures posts automatically. Configurable stop conditions (N consecutive duplicates, or a time limit).
- **AI classification** — every captured post is sent to Google Gemini Flash Lite to be labelled *rental* or *not rental*. Falls back to Gemini Flash if the primary model is overloaded.
- **Structured tag extraction** — for rental posts, Gemini extracts: price (₪/mo), rooms, size (m²), neighborhood, entry date, whether it's a roommate listing, and whether a broker fee applies.
- **Deterministic neighborhood overrides** — a curated list of Hebrew neighborhood names (sourced from the Tel Aviv municipal GIS) is matched against the post text before Gemini runs, giving high-confidence results for the most common names.
- **Filterable dashboard** — browse all scraped posts with sidebar filters for: status, label, days posted, text search, price range, rooms range, roommates, broker fee, entry date range, and neighborhood.
- **Human-in-the-loop training** — correct any AI label or tag via the inline editor. Your corrections are stored and fed back to Gemini as few-shot examples on the next run.
- **Deduplication** — posts are fingerprinted on save; re-scraping the same feed never creates duplicates.
- **Mark as duplicate** — manually flag cross-posted listings so they disappear from the default view.

---

## How It Works

```
Facebook feed
      │  content scripts scroll & extract posts
      ▼
background.js (service worker)
      │  saves to IndexedDB via lib/db.js
      │  calls lib/gemini.js → Gemini API (auto-classify on save)
      ▼
IndexedDB ("tlv-rentals")
      │
      ▼
dashboard/dashboard.html  ←  filter, sort, label, edit tags, export
```

The content scripts (`content/extractor.js`, `content/scroller.js`, `content/content.js`) run inside Facebook's page, extract post data, and send it to the service worker via `chrome.runtime.sendMessage`. All Gemini network calls are made from the service worker, which is the only origin that has `host_permissions` for `generativelanguage.googleapis.com`.

---

## Prerequisites

- **Chrome** (or any Chromium-based browser that supports Manifest V3)
- A **Google Gemini API key** — get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

---

## Installation

The extension is not published to the Chrome Web Store. Load it as an unpacked extension:

1. Clone or download this repository:
   ```bash
   git clone https://github.com/ablolarof/tel-aviv-facebook-scraper.git
   ```
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
5. The 🏠 TLV Rentals icon will appear in your toolbar.

---

## Setup

1. Click the 🏠 icon to open the popup.
2. Click **Settings** at the bottom.
3. Paste your Gemini API key and click **Save**. The key is stored in `chrome.storage.local` on your machine only and never sent anywhere except Google's Gemini API.

---

## Usage

### Scraping

1. Navigate to a Facebook group or feed that contains rental listings.
2. Click the 🏠 icon and press **Scrape This Feed**.
3. The extension will auto-scroll the page, capturing posts until it hits the configured stop condition (default: 30 consecutive duplicates or 5 minutes).
4. Click **■ Stop** at any time to end early.

### Dashboard

Click **Open Dashboard ↗** in the popup (or navigate to the extension's `dashboard/dashboard.html` directly).

- **Classify & Tag** — runs Gemini over all unlabeled posts (Phase 1: classify; Phase 2: extract tags from all rental posts that don't have them yet).
- **Rental / Not rental** buttons — override the AI label on any card. Marking a post as rental immediately triggers tag extraction if tags are missing.
- **✏ Edit tags** — correct any extracted field. Corrections are stored and used as few-shot examples in future Gemini calls.
- **⊘ Dupe** — mark a cross-posted listing as a duplicate. It disappears from the default view (toggle *Duplicates* in the sidebar to see them again).
- **Export JSON** — download everything in IndexedDB as a JSON file.

---

## Project Structure

```
├── manifest.json
├── background.js          # Service worker — receives messages, calls Gemini, saves to IDB
├── content/
│   ├── content.js         # Orchestrates scraping; talks to background.js
│   ├── extractor.js       # Pulls post data out of the Facebook DOM
│   └── scroller.js        # Auto-scrolls the feed and detects end-of-page
├── popup/
│   ├── popup.html
│   ├── popup.js           # Scrape controls, settings, live status
│   └── popup.css
├── dashboard/
│   ├── dashboard.html
│   ├── dashboard.js       # Filtering, rendering, Classify & Tag, tag editor
│   └── dashboard.css
└── lib/
    ├── db.js                      # IndexedDB wrapper (openDB, savePost, getAllPosts, …)
    ├── gemini.js                  # Gemini API wrapper — classify + tag extraction,
    │                              #   model fallback chain, rate limiting, daily guard
    ├── dedup.js                   # Post fingerprinting for deduplication
    └── neighborhood_overrides.js  # Deterministic Hebrew → canonical neighborhood map
```

---

## Neighborhood Detection

Neighborhoods are identified in two tiers:

1. **Deterministic override** (`lib/neighborhood_overrides.js`) — if the post text contains an official Hebrew neighborhood name (e.g. `פלורנטין`, `הצפון הישן`, `כרם התימנים`), that match wins immediately with `confidence: high`. The name list is sourced from Tel Aviv's municipal GIS boundary dataset (layer 511).
2. **Gemini inference** — if no override fires, Gemini infers the neighborhood from street names, landmarks, and directional clues, returning one of 14 canonical English names.

Users can correct any neighborhood guess via the tag editor; corrections feed back as few-shot examples.

---

## Canonical Neighborhoods

The 14 recognised neighbourhoods (used in filters and Gemini prompts):

| Canonical name | Hebrew examples |
|---|---|
| Old North | הצפון הישן |
| New North | הצפון החדש |
| Bavli | בבלי |
| Lev Tel Aviv | לב תל-אביב, מרכז העיר |
| Ganei Sarona | גני שרונה, שרונה |
| Montefiore | מונטיפיורי |
| Kerem Hateimanim | כרם התימנים, שוק הכרמל |
| Neve Zedek | נווה צדק |
| Florentine | פלורנטין |
| Neve Sha'anan | נווה שאנן |
| South Tel Aviv | שפירא, התקווה, יד אליהו, … |
| North of the Yarkon | רמת אביב, גלילות |
| East of the Ayalon | — |
| Yafo | יפו |

---

## License

This project is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0** as published by the Free Software Foundation.

See [LICENSE](LICENSE) for the full text, or visit [gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0.html).

---

## Disclaimer

This tool is for personal use. Scraping Facebook may be against their Terms of Service. Use responsibly and at your own risk.
