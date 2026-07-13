# Tel Aviv Facebook Rental Scraper

> A Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental listings from Facebook groups, classifies them with a local regex pipeline, presents them in a filterable dashboard, and (since v2.0.0) pings your phone through your own Telegram bot the moment a new listing matches your preferences — so you can actually find a flat without drowning in posts.
>
> Vibe-coded with Claude (https://claude.ai) by Anthropic.

---

## Features

- **One-click scraping** — open any Facebook group or feed, click *Scrape This Feed* in the popup, and the extension auto-scrolls and captures posts. Configurable stop conditions (N consecutive duplicates, or a time limit). A continuation banner lets you push past the stop point for 50 more posts or 5 more minutes.
- **Local-only classification** — every captured post runs through `lib/regex_extractor.js`, a Hebrew/English regex pass that catches `להשכרה`, `שכירות`, `for rent`, monthly-price patterns, and the inverse (`למכירה`, `for sale`). There is no remote API in the loop. Posts the regex can't classify with confidence stay unlabeled until a human handles them.
- **Structured tag extraction** — for rental posts, the extractor pulls: price (₪/mo), rooms, size (m²), entry date, whether it's a roommate listing, and whether a broker fee applies.
- **See-more expansion** — Facebook collapses long posts with a "See more" / "ראה עוד" button. The scroller clicks them before extraction so the full text ends up in the database (not a 250-char preview).
- **Structural post detection** — posts are detected as `role="feed"` child units (with body-anchor and commerce-link fallbacks for surfaces that don't use a feed container, such as `/?filter=all&sk=h_chr`). This catches posts whether or not they have a `data-ad-*` body anchor, and is comment-immune: a comment lives inside its post's card and can never be mistaken for a separate post.
- **Marketplace cross-posts** — Marketplace listings (`/commerce/listing/`, `/marketplace/item/`) that appear in groups are captured too, with their own post-ID prefixes (`cl_…`, `mp_…`). Pure Marketplace listing cards (a listing with no written prose) are captured as well — their title and price are read directly from the listing attachment.
- **Comment-safe extraction** — author, body text, and images are all read from the post itself, never from its comments. Empty avatar-wrapper links are skipped so the real author name is captured.
- **Comment-link permalink recovery** — when a post has no permalink of its own, the parent post ID is recovered (read-only, no clicking) from the timestamp links of its rendered comments.
- **Anonymous & permalink-less posts** — anonymous posts, and posts whose URL Facebook only builds on click, are still captured (with a disabled Open button). Their post ID is a hash of the full normalised post text, so two different anonymous posts can't overwrite each other.
- **In-group permalink preference** — on a specific group page, the extractor rejects cross-card pollution (Recommended Reels, links to other groups) and only accepts permalinks that match the current group or are Marketplace listings.
- **Canonical Open links** — every post's Open button resolves to the correct canonical Facebook URL across all URL patterns: `/posts/`, `?multi_permalinks=`, `?set=pcb.POST_ID` (photo-album posts on the aggregated feed), `?set=gm.POST_ID` (home-feed group posts), `/commerce/listing/`, and `/marketplace/item/`.
- **Works on the home feed too** — group posts surfaced in the personal home feed are captured with proper post IDs and group context, not just the aggregated `/groups/feed/` view.
- **Filterable dashboard** — sort by scraped/posted date, price, or rooms; filter by status, label, label source, days posted, days scraped, free-text search, price range, rooms range, roommates, broker fee, entry-date range, duplicates visibility.
- **Human-in-the-loop corrections** — correct any label or tag via the inline editor. Corrections are stored as `tags_human_override` in IndexedDB.
- **Two-layer deduplication** — exact duplicates are caught by SHA-256 of normalised text + first image URL. Near-duplicates (same listing reposted with minor edits — different phone number, added emoji, small price change) are caught by a prefix-key match on the first 10 normalised words. A duplicate inherits the original's classification so we don't redo work on the same content.
- **Mark as duplicate** — manually flag cross-posted listings the hash doesn't catch. They drop out of the default view; toggle *Duplicates* in the sidebar to see them again.
- **Permanent delete** — a trash button on each card removes the post from IndexedDB immediately. It will be re-captured on the next fresh scrape if Facebook still shows it — there is no permanent blocklist.
- **Delete All** — wipes the entire database so the next scrape starts from a clean slate. Requires explicit confirmation in the dashboard (shows the current post count before you confirm).
- **Telegram notifications (v2.0.0)** — get an alert on your phone when a scrape captures a **new** post matching your preferences: max price, rooms range, whole-apartment vs. roommates, broker fee, and include/exclude keyword lists (the only location filter — e.g. neighborhood names in Hebrew or English). Matching is recall-biased: a post whose price or rooms could not be extracted is never excluded by that rule. One message per matching post, with price/rooms/size, group name, a text snippet, and the permalink. Duplicates and re-scrapes never re-notify; a failed send retries on the next scrape.
- **Control the bot from your phone (v2.0.0)** — the bot itself is a control surface: `/start` runs a 6-question setup wizard in the chat, `/reset` clears preferences and starts over, `/status` shows current settings, `/on` `/off` toggle alerts. The first chat to `/start` an unbound bot becomes its owner; every other chat is ignored permanently. No server involved — the extension's service worker polls Telegram, so commands apply while Chrome is running (queued up to 24h otherwise).
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

No API keys. No external services. No network traffic — unless you opt in to Telegram notifications, in which case the only external endpoint the extension ever talks to is `api.telegram.org`, using a bot token you create yourself (free, 2 minutes via [@BotFather](https://t.me/BotFather)).

---

## Installation

The extension is not published to the Chrome Web Store. Load it unpacked:

1. Clone or download this repository:
   ```bash
   git clone https://github.com/ablolarof/Facebook-Scraper.git
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

### Telegram notifications

One-time setup (~3 minutes):

1. **Create a bot.** In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a display name and a unique username ending in `bot`. BotFather replies with a **bot token**.
2. **Paste the token** into the dashboard's **🔔 Notifications** panel and press **Save**.
3. **Message your bot `/start`** from your phone. The first chat to `/start` becomes the bound chat automatically, and the bot walks you through a 6-question preferences wizard (max price → rooms → apartment/roommates → broker fee → must-contain keywords → exclude keywords; reply `skip` to any). Finishing the wizard switches alerts ON.

From then on, every scrape that captures a matching new post sends you one Telegram message. Manage everything from the chat: `/status`, `/reset`, `/on`, `/off`, `/help` — or use the same 🔔 dashboard panel; both edit the same settings.

**Privacy note:** with notifications enabled, matching post text is sent to Telegram's API through your own bot. Strangers who find your bot's username see nothing — alerts go only to the bound chat, and messages from any other chat are silently dropped. Keep the bot *token* secret; it's the only credential that matters.

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
│   ├── dedup.js                        # SHA-256 exact hash + first-10-word prefix key
│   ├── regex_extractor.js              # Local-only classifier + tag extractor
│   ├── notify.js                       # Telegram notify — settings, matching, send, format
│   ├── bot.js                          # Telegram bot — polling, commands, /start wizard

├── icons/                              # 16/48/128 PNG icons
├── CLAUDE.md                           # Project guide for Claude Code
├── LICENSE                             # GNU GPL v3.0
└── README.md
```

---

## Roadmap

1. **Dashboard "regex missed" mechanism.** *(In progress.)* Mark a post as a regex miss, record the key phrase that proves the correct answer, export as a training prompt, apply regex fixes, re-test, clear resolved flags.
2. ~~**Fix the Open button.**~~ ✅ Done (v1.1.5) — canonical URLs now work for all Facebook URL patterns across group pages, the aggregated groups feed, and the personal home feed: `/posts/`, `?multi_permalinks=`, `?set=pcb.POST_ID`, `?set=gm.POST_ID`, `/commerce/listing/`, `/marketplace/item/`. Includes guard against reused-image pcb/gm IDs shadowing the real post ID.
3. ~~**Missing-posts capture overhaul.**~~ ✅ Done (v1.2.0) — detection rewritten to `role="feed"` child units with body-anchor and commerce-link fallbacks; fixed neighbour-ID theft (a permalink-less post stealing an adjacent post's ID and overwriting it); pure Marketplace listing cards now captured; anonymous posts hashed on full text to prevent overwrites.
4. ~~**Improve duplicate detection.**~~ ✅ Done (v1.4.0) — two-layer dedup: exact SHA-256 match plus prefix-key matching on the first 10 normalised words. Catches cross-posted listings edited before reposting (different phone, emoji, price tweak).
5. **Fix the group-name capture bug.** Some group names come through truncated.
6. ~~**Telegram notifications + phone-side bot control.**~~ ✅ Done (v2.0.0) — opt-in push alerts through a user-owned Telegram bot when a newly captured post matches saved preferences (nulls-pass matching, per-post messages, no re-notification on re-scrapes/duplicates, failed sends retried next scrape); preferences configurable from the dashboard 🔔 panel or from the Telegram chat itself (`/start` wizard, `/reset`, `/status`, `/on` `/off`), with auto-bind of the first chat and silent dropping of strangers.

### Known limitations

- **Open button on click-only posts** — anonymous, background-colour, and zero/collapsed-comment posts expose no permalink in the DOM (Facebook builds the URL only on click). They are captured with full text, but the Open button is disabled. A click-based permalink resolver is a possible future enhancement.

---

## License

This project is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0** as published by the Free Software Foundation.

See [LICENSE](LICENSE) for the full text, or visit [gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0.html).

---

## Disclaimer

This tool is for personal use. Scraping Facebook may be against their Terms of Service. Use responsibly and at your own risk. The extension is offline by default — no data leaves your machine unless you opt in to Telegram notifications, which send matching post text to Telegram's API through your own bot.
