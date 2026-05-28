# Tel Aviv Facebook Rental Scraper

> A Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental listings from Facebook groups, classifies them with a local regex pipeline, and presents them in a filterable dashboard — so you can actually find a flat without drowning in posts.
>
> Vibe-coded with Claude (https://claude.ai) by Anthropic.

---

## Features

- **One-click scraping** — open any Facebook group or feed, click *Scrape This Feed* in the popup, and the extension auto-scrolls and captures posts. Configurable stop conditions (N consecutive duplicates, or a time limit). A continuation banner lets you push past the stop point for 50 more posts or 5 more minutes.
- **Local-only classification** — every captured post runs through `lib/regex_extractor.js`, a Hebrew/English regex pass that catches `להשכרה`, `שכירות`, `for rent`, monthly-price patterns, and the inverse (`למכירה`, `for sale`). There is no remote API in the loop. Posts the regex can't classify with confidence stay unlabeled until a human handles them.
- **Structured tag extraction** — for rental posts, the extractor pulls: price (₪/mo), rooms, size (m²), entry date, whether it's a roommate listing, and whether a broker fee applies.
- **See-more expansion** — Facebook collapses long posts with a "See more" / "ראה עוד" button. The scroller clicks them before extraction so the full text ends up in the database (not a 250-char preview).
- **Marketplace cross-posts** — Marketplace listings (`/commerce/listing/`, `/marketplace/item/`) that appear in groups are captured too, with their own post-ID prefixes (`cl_…`, `mp_…`).
- **In-group permalink preference** — on a specific group page, the extractor rejects cross-card pollution (Recommended Reels, links to other groups) and only accepts permalinks that match the current group or are Marketplace listings.
- **Canonical Open links** — every post's Open button resolves to the correct canonical Facebook URL across all URL patterns: `/posts/`, `?multi_permalinks=`, `?set=pcb.POST_ID` (photo-album posts on the aggregated feed), `?set=gm.POST_ID` (home-feed group posts), `/commerce/listing/`, and `/marketplace/item/`.
- **Works on the home feed too** — group posts surfaced in the personal home feed are captured with proper post IDs and group context, not just the aggregated `/groups/feed/` view.
- **Filterable dashboard** — sort by scraped/posted date, price, or rooms; filter by status, label, label source, days posted, days scraped, free-text search, price range, rooms range, roommates, broker fee, entry-date range, duplicates visibility.
- **Human-in-the-loop corrections** — correct any label or tag via the inline editor. Corrections are stored as `tags_human_override` in IndexedDB.
- **Deduplication** — posts are fingerprinted on save (SHA-256 of normalised text + first image URL). A duplicate inherits the original's classification so we don't redo work on identical content.
- **Mark as duplicate** — manually flag cross-posted listings the hash doesn't catch. They drop out of the default view; toggle *Duplicates* in the sidebar to see them again.
- **Permanent delete** — a trash button on each card removes the post from IndexedDB immediately. It will be re-captured on the next fresh scrape if Facebook still shows it — there is no permanent blocklist.
- **Delete All** — wipes the entire database so the next scrape starts from a clean slate. Requires explicit confirmation in the dashboard (shows the current post count before you confirm).
- **Auto-scrape URL parameter** — appending `?tlv_auto_scrape=1` to a Facebook URL starts a 30-minute scrape automatically after a 4-second render delay. Useful for scheduled-task workflows.
- **Export JSON** — dump every IndexedDB record to a JSON file for backup or external analysis.

---

## Architecture

Facebook feed → content scripts (`extractor.js` + `scroller.js` + `content.js`) → service worker (`background.js`) → IndexedDB.

`background.js` is the only place that:
- Writes the extension's IndexedDB (content scripts run at `facebook.com` origin and would write Facebook's storage instead)
- Runs `lib/regex_extractor.js` against incoming posts and saves the result

Classification is fully synchronous from the content script's perspective — by the time `SAVE_POST` returns, the post is dedup'd, classified, and saved.

---

## Prerequisites

- **Chrome** or any Chromium-based browser that supports Manifest V3 (Edge, Arc, Brave).

No API keys. No external services. No network traffic.

---

## Installation

The extension is not published to the Chrome Web Store. Load it unpacked:

1. Clone or download this repository:
   ```bash
   git clone https://github.com/ablolarof/Tel-Aviv-Facebook-Scraper.git
   ```
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right corner toggle).
4. Click **Load unpacked** and select the repository folder.
5. The "H" TLV Rentals icon appears in your toolbar.

---

## Usage

### Scraping

1. Navigate to a Facebook group or feed.
2. Click the "H" icon and press **Scrape This Feed**.
3. The extension auto-scrolls and captures posts until it hits the configured stop condition (default: 30 consecutive duplicates or 5 minutes).
4. Press **■ Stop** at any time. When a stop condition fires, you can **Continue 50 more posts**, **Continue 5 more minutes**, or **Done**.

### Dashboard

Click **Open Dashboard ↗** in the popup (or navigate to `chrome-extension://[id]/dashboard/dashboard.html`).

- **Regex Extract** — runs the local regex extractor on every rental post that hasn't been processed yet. Instant.
- **Rental / Not rental** buttons — override the auto-label. Marking a post as rental triggers regex tag extraction inline.
- **✏ Edit tags** — correct any extracted field, or change the classification. Corrections are stored as `tags_human_override` in IndexedDB.
- **Show more / Show less** — long card text is line-clamped to 3 lines; click to expand. Expanded state persists across re-renders.
- **⊘ Dupe** — toggle a post's duplicate flag manually.
- **🗑 Delete** — removes the post from IndexedDB. It will be re-captured on the next fresh scrape if Facebook still shows it.
- **🗑 Delete All** — wipes every post from IndexedDB. Requires confirmation (shows the current count). Use this before a re-scrape when you want a clean slate.
- **Export JSON** — download every IndexedDB record as a JSON file.

### Auto-scrape via URL parameter

Append `?tlv_auto_scrape=1` to any Facebook URL and the content script will start a 30-minute scrape automatically after a 4-second render delay.

---

## Project structure

```
.
├── manifest.json                       # MV3 manifest
├── background.js                       # Service worker — message router, dedup, regex classify
├── content/
│   ├── content.js                      # Orchestrator + popup-message handler + auto-scrape detector
│   ├── extractor.js                    # DOM → post object
│   └── scroller.js                     # MutationObserver-based feed scroller + See-more expander
├── popup/
│   ├── popup.html
│   ├── popup.js                        # Scrape controls, live status, continuation banner
│   └── popup.css
├── dashboard/
│   ├── dashboard.html
│   ├── dashboard.js                    # Filters, rendering, Regex Extract, tag editor, delete
│   └── dashboard.css
├── lib/
│   ├── db.js                           # IndexedDB wrapper
│   ├── dedup.js                        # SHA-256 of normalised text + first image URL
│   ├── regex_extractor.js              # Local-only classifier + tag extractor

├── icons/                              # 16/48/128 PNG icons
├── JSONs-(Training)/                   # Dashboard JSON exports
├── CLAUDE.md                           # Project guide for Claude Code
├── LICENSE                             # GNU GPL v3.0
└── README.md
```

---

## Roadmap

1. **Dashboard "regex missed" mechanism.** *(In progress.)* Mark a post as a regex miss, record the key phrase that proves the correct answer, export as a training prompt, apply regex fixes, re-test, clear resolved flags.
2. ~~**Fix the Open button.**~~ ✅ Done (v1.1.5) — canonical URLs now work for all Facebook URL patterns across group pages, the aggregated groups feed, and the personal home feed: `/posts/`, `?multi_permalinks=`, `?set=pcb.POST_ID`, `?set=gm.POST_ID`, `/commerce/listing/`, `/marketplace/item/`. Includes guard against reused-image pcb/gm IDs shadowing the real post ID.
3. **Improve duplicate detection.** Fuzzier signal than text+image SHA-256.
4. **Fix the group-name capture bug.** Some group names come through truncated.

---

## License

This project is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0** as published by the Free Software Foundation.

See [LICENSE](LICENSE) for the full text, or visit [gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0.html).

---

## Disclaimer

This tool is for personal use. Scraping Facebook may be against their Terms of Service. Use responsibly and at your own risk. The extension is fully offline — no data leaves your machine.
