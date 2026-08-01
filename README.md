# Tel Aviv Facebook Rental Scraper

> A Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental listings from Facebook groups, classifies them with a local regex + machine-learning pipeline (no cloud, no API keys — the model trains and runs inside the extension), presents them in a filterable dashboard, and (since v2.0.0) pings your phone through your own Telegram bot the moment a new listing matches your preferences — so you can actually find a flat without drowning in posts.
>
> Vibe-coded with Claude (https://claude.ai) by Anthropic.

---

## License

This project is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0** as published by the Free Software Foundation, **subject to the commercial-use restriction below, which prevails over the license**.

See [LICENSE](LICENSE) for the full text, or visit [gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0.html).

### ⚠️ No commercial use — this restriction overrides the license

**Notwithstanding anything in the license or any other document, using this software, any part of it, or any derivative of it for any commercial purpose is strictly prohibited.** This includes, without limitation:

- selling this software or a modified version of it, or charging any fee, subscription, or other consideration for access to it or to anything built from it;
- use by or on behalf of a realtor, broker, agency, or any other real-estate business, or any other non-personal use.

This tool exists for one purpose: a private individual finding an apartment for themselves. Anything else is not permitted.

---

## Disclaimer

This tool is for personal use. Scraping Facebook may be against their Terms of Service. Use responsibly and at your own risk. The extension is offline by default — no data leaves your machine unless you opt in to Telegram notifications, which send matching post text to Telegram's API through your own bot.

---

## Features

- **One-click scraping** — open any Facebook group or feed, click *Scrape This Feed* in the popup, and the extension auto-scrolls and captures posts. Configurable stop conditions (N consecutive duplicates, or a time limit). A continuation banner lets you push past the stop point for 50 more posts or 5 more minutes.
- **Local-only classification** — every captured post runs through `lib/regex_extractor.js`, a Hebrew/English regex pass that catches `להשכרה`, `שכירות`, `for rent`, monthly-price patterns, and the inverse (`למכירה`, `for sale`). There is no remote API in the loop.
- **ML hybrid classification (v2.3.0)** — a plain-JS logistic-regression model (TF-IDF over Hebrew/English/Russian word+bigram features, trained on a 2,953-post hand-verified gold set) rides on top of the regex: the regex label stands unless the model is ≥90% confident it's wrong, and when the regex can't decide, the model decides alone. Measured by cross-validation, the hybrid beats both regex-alone and model-alone on accuracy *and* rental-recall. Posts the model decided carry a 🤖 badge with its confidence.
- **ML broker detection (v2.3.0)** — where no explicit תיווך keyword exists, a weakly-supervised model head recognizes agency register (signatures, license numbers, listing style) and fills the broker tag when confident — trained with the broker keywords masked out so it learns the register, not the keyword.
- **Train it yourself, locally (v2.3.0)** — every correction you make (dashboard label buttons / ✏ tag editor / Telegram 🚩 Miss) is training signal. Hit 🧠 *Retrain ML* on the dashboard or send `/retrain` to your bot: the model retrains in-extension in seconds and the new weights are promoted **only** if they score at least as well as the current ones on a fixed gold benchmark. Fresh installs import the gold training texts once from a local export file — nothing is ever uploaded.
- **Shadow ML for price (v3.0.0)** — a candidate *ranker* (not a classifier) that reads every number in a post and scores each by its local context, so it can recover rents the regex has no rule for. It runs in **shadow mode**: predictions are shown on the card and measured, but never written to tags, so a wrong guess can never reach your Telegram filter — the value simply isn't in the object the filter reads. You judge only the posts where it disagrees with the regex, and those verdicts become the benchmark that decides whether it ever graduates to tagging. Scored on *precision* (a missing price costs you nothing; a wrong one silently hides a listing).
- **Explainable predictions (v3.0.0)** — the devtools Reasoning tab shows the full candidate ranking behind any price prediction: every number, its score, the period it was quoted for, the signals that moved it, and which numbers were rejected before scoring ever happened.
- **Publish your trained weights (v3.0.0)** — retraining promotes weights into the browser's local storage, where git can't see them. 💾 *Export Weights* writes them back out as the bundled `lib/*_weights.js` modules — straight into the folder you pick, or as downloads — so a retrain can be committed and shipped. The devtools Weights tab tells you, per head, whether the repo copy still matches what's actually scoring your posts.
- **In-extension devtools (v3.0.0)** — pipeline stats, a reasoning playground, shadow-ML progress and model weights, all at `devtools/devtools.html` (🔬 button on the dashboard). No server, no sync step, reads live IndexedDB — and unlike the old Node backend it can read your *retrained* weights, so the tokens shown are the ones actually scoring your posts.
- **Luxury rents no longer discarded (v3.0.0)** — an explicit rent label (`שכ"ד: 50,000`, `Monthly rent 17,500 NIS`) is now trusted past the sanity cap that was silently dropping genuine high-end listings, along with `ILS`, colon-less `Rent 40,000`, and amount-before-label forms (`2,666 שכ״ד`).
- **Full Marketplace descriptions (v2.4.0)** — pure Marketplace cards only show "₪price · location · title" in the feed; the description exists solely on the listing page, which Facebook renders client-side. The extension now opens each new card-style listing in a background tab, reads the full description from the rendered page, and re-runs dedup/classification/tags/notifications on the complete text.
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
- **Filterable dashboard** — newest-first card grid with collapsible filter sections: label, label source (human / AI), free-text search, price range, rooms range, roommates, broker fee, entry-date range, and toggles for Interested, Duplicates, regex-misses-only, and the ML review queue. Maintenance actions are grouped under a single **Pipeline ▾** menu, and each card carries a **⋯** menu for labelling, tag editing, duplicate marking, and delete. Cards render in chunks as you scroll, so a database of thousands stays responsive.
- **Human-in-the-loop corrections** — correct any label or tag via the inline editor. Corrections are stored as `tags_human_override` in IndexedDB and double as ML training signal.
- **Four-layer deduplication** — `post_id` (the primary key) collapses re-scrapes and cross-group Marketplace posts of the same listing. Exact duplicates are caught by SHA-256 of normalised text + first image URL. Near-duplicates are caught two ways: a **prefix key** (first 10 normalised words) for reposts edited later in the text, and a **suffix key** (last 10 normalised words) for reposts that rewrite the headline but keep their closing lines — with a whole-text similarity gate so broker-template posts describing *different* apartments aren't collapsed. A duplicate inherits the original's classification so we don't redo work on the same content.
- **Mark as duplicate** — manually flag cross-posted listings the hash doesn't catch. They drop out of the default view; toggle *Duplicates* in the sidebar to see them again.
- **Permanent delete** — 🗑 Delete in a card's ⋯ menu removes the post from IndexedDB immediately. It will be re-captured on the next fresh scrape if Facebook still shows it — there is no permanent blocklist.
- **Delete All** — wipes the entire database so the next scrape starts from a clean slate. Requires explicit confirmation in the dashboard (shows the current post count before you confirm).
- **Telegram notifications (v2.0.0)** — get an alert on your phone when a scrape captures a **new** post matching your preferences: max price, rooms range, whole-apartment vs. roommates, broker fee, and include/exclude keyword lists (the only location filter — e.g. neighborhood names in Hebrew or English). Matching is recall-biased: a post whose price or rooms could not be extracted is never excluded by that rule. One message per matching post, with price/rooms/size, group name, a text snippet, and the permalink. Duplicates and re-scrapes never re-notify; a failed send retries on the next scrape.
- **Control the bot from your phone (v2.0.0)** — the bot itself is a control surface: `/start` runs a 6-question setup wizard in the chat, `/reset` clears preferences and starts over, `/status` shows current settings, `/on` `/off` toggle alerts, `/retrain` retrains the ML model on your accumulated corrections (v2.3.0). The first chat to `/start` an unbound bot becomes its owner; every other chat is ignored permanently. No server involved — the extension's service worker polls Telegram, so commands apply while Chrome is running (queued up to 24h otherwise). Every alert carries a 🚩 Miss button for correcting the classification or any tag straight from the chat (v2.2.0).
- **Auto-scrape URL parameter** — appending `?tlv_auto_scrape=1` to a Facebook URL starts a 30-minute scrape automatically after a 4-second render delay. Useful for scheduled-task workflows.
- **Export JSON** — dump every IndexedDB record to a JSON file for backup or external analysis.

---

## Architecture

Facebook feed → content scripts (`extractor.js` + `scroller.js` + `content.js`) → service worker (`background.js`) → IndexedDB.

`background.js` is the only place that:
- Writes the extension's IndexedDB (content scripts run at `facebook.com` origin and would write Facebook's storage instead)
- Runs `lib/regex_extractor.js` + the ML hybrid (`lib/ml_classifier.js`) against incoming posts and saves the result

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

**Header.** Free-text search, a live "shown of total" count, and:

- **Pipeline ▾** — the maintenance menu: *Regex Extract* (run the extractor over unprocessed rental posts, instant), *Re-test Regex + ML* (preview what the current rules would change, then apply), *🧠 Retrain ML* (badge shows corrections accumulated since the last retrain), *🔬 Shadow Backfill*, *Export Misses* (badge shows unexported flags), and *💾 Export Weights*.
- **🔬 Devtools** — pipeline stats, the reasoning playground, shadow-ML progress and live model weights.
- **🔔 Notifications** — the Telegram settings panel.
- **Export** — download the chosen subset (all / current view / rentals / not rentals / unlabeled / duplicates / misses) as JSON.
- **🗑 Delete All** — wipes every post from IndexedDB. Requires confirmation and shows the current count. Use before a re-scrape when you want a clean slate.

**Sidebar filters** (collapsible sections): label, label source (human / AI), price range, rooms range, roommates, broker fee, entry-date range, and toggles for Interested, Duplicates, regex-misses-only, and the 🔬 ML review queue.

**Cards.** A status dot marks new / interested / seen / hidden; badges show the label (with provenance — human, regex, or 🤖 ML with confidence), plus Dupe and ⚑ Miss flags. Long text is clamped to 3 lines with **Show more / Show less**, and the expanded state survives re-renders. Each card has **Interested**, **Open ↗**, and a **⋯** menu:

- **Mark as Rental / Not rental** — override the auto-label (click again to unmark). Marking a post as rental triggers regex tag extraction inline.
- **✏ Edit tags** — correct any extracted field or the classification. Corrections are stored as `tags_human_override` and become ML training signal.
- **⊘ Mark duplicate** — flag a cross-post the hash didn't catch; the dashboard pairs it with its most similar original.
- **🗑 Delete** — removes the post from IndexedDB. It will be re-captured on the next fresh scrape if Facebook still shows it.

Where a shadow ML head disagrees with the regex, the card also shows a 🔬 row asking you to judge which is right — those verdicts are the benchmark that decides whether the head ever graduates to tagging.

### Telegram notifications

One-time setup (~3 minutes):

1. **Create a bot.** In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a display name and a unique username ending in `bot`. BotFather replies with a **bot token**.
2. **Paste the token** into the dashboard's **🔔 Notifications** panel and press **Save**.
3. **Message your bot `/start`** from your phone. The first chat to `/start` becomes the bound chat automatically, and the bot walks you through a 6-question preferences wizard (max price → rooms → apartment/roommates → broker fee → must-contain keywords → exclude keywords; reply `skip` to any). Finishing the wizard switches alerts ON.

From then on, every scrape that captures a matching new post sends you one Telegram message. Manage everything from the chat: `/status`, `/reset`, `/on`, `/off`, `/help` — or use the same 🔔 dashboard panel; both edit the same settings.

**Privacy note:** with notifications enabled, matching post text is sent to Telegram's API through your own bot. Strangers who find your bot's username see nothing — alerts go only to the bound chat, and messages from any other chat are silently dropped. Keep the bot *token* secret; it's the only credential that matters.

### Auto-scrape via URL parameter

Append `?tlv_auto_scrape=1` to any Facebook URL and the content script will start a 30-minute scrape automatically after a 4-second render delay.

To run this on a schedule (e.g. every hour, so Telegram alerts arrive while you're away), see the ready-made Windows Task Scheduler setup in [`automation/`](automation/README.md) — a one-line batch trigger plus an importable hourly task.

---

## Project structure

```
.
├── manifest.json                       # MV3 manifest
├── background.js                       # Service worker — message router, dedup, classify, notify, enrich
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
│   ├── dashboard.js                    # Filters, rendering, tag editor, shadow review, pipeline actions
│   └── dashboard.css
├── lib/
│   ├── db.js                           # IndexedDB wrapper
│   ├── dedup.js                        # SHA-256 exact hash + prefix/suffix keys + similarity
│   ├── regex_extractor.js              # Local-only classifier + tag extractor
│   ├── notify.js                       # Telegram notify — settings, matching, send, format
│   ├── bot.js                          # Telegram bot — polling, commands, /start wizard
│   ├── ml_features.js                  # Shared tokenizer/scorer — one source of truth for train + runtime
│   ├── ml_classifier.js                # ML runtime — hybrid label, broker fill, weight loading
│   ├── ml_train_core.js                # Pure training machinery (TF-IDF + logistic regression, CV)
│   ├── ml_shadow.js                    # Shadow-mode records, verdicts, review queue, leak guard
│   ├── ml_price.js                     # Price candidate ranker + period/short-stay logic
│   ├── ml_roommates.js                 # Shadow roommates head (keyword-masked)
│   ├── ml_retrain.js                   # In-extension retraining (all four heads)
│   ├── ml_weights_export.js            # Promoted weights → bundled lib/*_weights.js
│   └── ml_*_weights.js                 # GENERATED bundled weights — never edit by hand
├── devtools/
│   ├── devtools.html / devtools.js     # In-extension devtools page (no Node)
│   ├── devtools_core.js                # Pure stats/reasoning shared with the Node shell
│   └── server.mjs                      # Optional Node shell for inspecting an export file
├── ml/
│   ├── gold_labels.json                # 2,953 hand-verified labels (ids only)
│   ├── train.mjs                       # Offline trainer for the label + broker heads
│   ├── train_price.mjs                 # Offline trainer for the price ranker
│   ├── train_roommates.mjs             # Offline trainer for the roommates head
│   └── shadow_selftest.mjs             # Invariant tests — shadow values can't reach notifications
├── automation/
│   ├── trigger.bat                     # Opens Chrome with the auto-scrape URL
│   ├── scraper_task.xml                # Importable hourly Task Scheduler task
│   └── README.md                       # Scheduled-scrape setup guide

├── icons/                              # 16/48/128 PNG icons
├── CLAUDE.md                           # Project guide for Claude Code
├── LICENSE                             # GNU GPL v3.0
└── README.md
```

---

## Known limitations

- **Open button on click-only posts** — anonymous, background-colour, and zero/collapsed-comment posts expose no permalink in the DOM (Facebook builds the URL only on click). They are captured with full text, but the Open button is disabled. A click-based permalink resolver is a possible future enhancement.
- **Truncated group names** — some group names come through cut short from the DOM.
- **Entry-date extraction gaps** — entry dates are regex-only (no ML head). Around 100 posts use phrasings the rules don't yet cover; these show no entry date rather than a wrong one.
- **Shadow heads don't tag yet** — the price and roommates models predict but never write tags (by design). They graduate only once their measured precision clears the bar; until then, price/roommates tags come from the regex alone.
- **Roommates masking leak** — the shadow roommates head masks its keywords imperfectly, leaving Hebrew suffix debris, so its masked cross-validation score overstates real precision. Documented in CLAUDE.md.

