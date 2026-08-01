# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TLV Rentals** is a Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental posts from Facebook feeds and classifies them with a local regex pipeline. Posts are stored in IndexedDB and presented through a filterable dashboard.

The extension is offline by default — no data leaves your machine — with one **opt-in** exception since v2.0.0: Telegram notifications. When enabled, matching new posts (and bot commands) travel between the extension and `api.telegram.org` using the user's own bot token. Nothing else touches the network.

## How to work with the user

**Diagnostics first, code changes second.** Before fixing a bug or making any non-trivial change to the code, propose diagnostic tests the user can run that confirm:

1. The hypothesis about what is broken or how the current behaviour actually works, *and*
2. The proposed fix will actually do what is intended.

Hand the user paste-ready snippets — DevTools console blocks against the live extension, shell commands, IndexedDB inspection scripts. Wait for the results before modifying files. If the diagnostic disproves the hypothesis, revise the plan rather than ship the change anyway.

This applies to every stage of the project — bug fixes, refactors, new features. Skipping the diagnostic step has historically led to rewrites and lost work.

**Extension name per worktree.** The user runs each git worktree as a separate unpacked extension install (own IndexedDB) so parallel work streams don't collide. `manifest.json`'s `"name"` field should reflect that: on `main`, it stays exactly `"TLV Rentals"`. In any other worktree, rename it locally (uncommitted — never push a worktree rename to `main`) to `"TLV Rentals - <Thing>"`, where `<Thing>` names what that worktree is for, e.g. `"TLV Rentals - Redesign"` for a dashboard-redesign worktree, `"TLV Rentals - Telegram"` for Telegram-feature work. This makes `chrome://extensions` unambiguous when several unpacked installs are loaded side by side.

## Active plan

These stages are sequential.

1. **Drop Gemini entirely — regex-only pipeline** (complete as of 2026-05-26). `lib/gemini.js` deleted; `host_permissions` no longer mentions `generativelanguage.googleapis.com`; popup has no settings panel; dashboard has no "Classify & Tag" button. Classification is now `lib/regex_extractor.js` only, called inline from `background.js` on every `SAVE_POST`. Existing Gemini-extracted tags in IDB were left in place — no migration.
2. ~~**Dashboard "regex missed" mechanism.**~~ (Complete.) UI to mark a post as a regex miss and record *why* the correct answer is correct — the "why" is the training signal. Built as: the ✏ tag editor auto-detecting changed fields into `regex_miss.missed_fields`, per-field `key_phrases`, the ⚑ Miss badge, **Export Misses** (formats a ready-to-paste Claude prompt and stamps `exported_at`), and **Re-test Regex + ML** (which clears flags whose fields the updated rules now get right).
3. **Fix the Open button.** (Complete as of 2026-05-28.) Canonical permalink construction now works across all Facebook URL patterns: `/posts/`, `/permalink/`, `?multi_permalinks=`, `?set=pcb.POST_ID` (photo-album posts on the aggregated feed), `/commerce/listing/`, and `/marketplace/item/`. The extractor walks up to 8 DOM levels to locate the group ID when the card container is too narrow to contain the author link.
4. **Missing-posts capture overhaul** (complete as of 2026-05-30, v1.2.0). See the dedicated section below. Detection rewritten to `role="feed"` child units; neighbour-ID theft fixed; pure Marketplace cards captured; anonymous-post hashing hardened.
5. ~~**Improve duplicate detection.**~~ (Complete as of 2026-07-12, v1.4.0.) Two-layer dedup: exact SHA-256 match (unchanged) plus a `prefix_key` index on the first 10 normalised words (`lib/dedup.js::computePrefixKey`). `findByPrefixKey` in `lib/db.js` does an O(1) IDB index lookup after the exact-hash check fails. Catches cross-posted listings edited before reposting (different phone, emoji, small price change). DB schema bumped to v2 to add the `prefix_key` index; `onupgradeneeded` handles the v1→v2 migration automatically.
6. **Fix the group-name capture bug.** Some group names come through truncated.
7. ~~**Telegram notifications + phone-side bot control.**~~ (Complete as of 2026-07-13, v2.0.0.) See the dedicated section below. Push alerts to the user's phone when a newly scraped post matches saved preferences; preferences editable from the dashboard 🔔 modal or from the Telegram chat itself (`/start` setup wizard).
8. ~~**Dashboard visual redesign.**~~ (Complete as of 2026-07-30.) Ported from the "TLV Rentals Dashboard Redesign" Claude Design project. `dashboard.css` is now an oklch design-token system (`:root` custom properties) covering every surface including the modals, tag editor and shadow row; the header groups the six maintenance actions under a **Pipeline ▾** dropdown; sidebar filters are collapsible `<details>` sections (Roommates/Broker fee became 4-way segmented controls — Any/Yes/No/Unknown — replacing the checkbox triples); and each card has a **⋯** overflow menu holding label/edit-tags/dupe/delete, leaving Interested + Open ↗ as the direct actions. **No business logic changed** — filter predicates, the tag editor, shadow verdicts, and the retrain/retest/export flows are untouched, and every pre-existing element id was preserved so `el()` lookups still resolve.

## Post detection (v1.2.0 overhaul)

Detection (`content/scroller.js → processVisible`) runs three paths, each dispatching a card to the extractor exactly once:

- **Path 1 — `role="feed"` children.** The primary detector. Each direct child of a `role="feed"` container is one post. Comment-immune (a comment is a `role="article"` *inside* the card, never its own child) and anchor-independent (works whether or not the post has a `data-ad-*` body anchor). A child counts as a post if it has a body anchor, a `/commerce/listing/` link, or a non-comment `div[dir="auto"]` ≥ 40 chars (skips the "sort feed" header and empty virtualisation placeholders).
- **Path 2 — body anchors outside any `role="feed"`.** Legacy fallback for surfaces with no feed container.
- **Path 3 — commerce links (pure Marketplace cards).** Catches Marketplace listing cards that have no body anchor at all. The card is bounded by author count (walk up while ≤ 1 author link; a 2nd author = a neighbour). Skipped if the card has a body anchor (then it's a written post, handled by Path 1/2).

**Why `/?filter=all&sk=h_chr` matters.** This personalised home feed (all the user's groups, chronological) is the primary scraping surface and has **no `role="feed"` container** — Path 1 never fires there, so Paths 2 and 3 carry it. Any change to detection must be checked on this surface, not just on a single `/groups/<id>/` page.

### Extraction guardrails

- **Comment-safe.** Author (`pickAuthorLink`), text fallback (`pickFallbackBodyText`), and images all exclude `role="article"` (comment) subtrees. `pickAuthorLink` also skips the empty avatar-wrapper `/user/` link so `author_name` isn't blank.
- **Pure-Marketplace text** (`pickMarketplaceText`). A listing card's `div[dir="auto"]` blocks are CSS-scrambled decoy ("Facebook" repeated); the real title/price live in plain `<div>`s. The function scopes to the largest ancestor excluding the author header and reads direct text nodes. Only fires when the post has no written body. The card carries ONLY "₪price · location · title" — the description is recovered later by commerce enrichment (below).
- **Commerce enrichment** (`background.js::queueEnrichment`). The description of a pure Marketplace card exists only on the listing page, and that page is fully client-rendered (nothing in its fetched HTML — verified live 2026-07-19; plain `fetch` is useless). After saving a card-style `cl_`/`mp_` post, the worker opens its permalink in a background tab (serial queue, 2s courtesy delay, 25s budget), the content script answers `EXTRACT_LISTING_DESCRIPTION` by reading the longest `span[dir="auto"] > span` leaf after clicking "See more", the tab closes, and the post is re-saved through `handleSavePost` with description + original card line — so dedup/classification/tags/broker-fill all rerun on full text, and `forceNotifyCheck` lets a now-matching post alert (`notified_at` carry-over still prevents double alerts). Provenance: `listing_enriched_at`; failures stamp `enrich_failed_at` + `enrich_failed_reason` (never retried automatically). Backfill for already-stored cards: `chrome.runtime.sendMessage({type:'ENRICH_COMMERCE_BACKFILL'})` from the dashboard console. **Rate limiting (2026-07-20, after Facebook temp-blocked the listing surface):** 30-45s jittered gap between listing opens, hourly cap of 20 (`enrich_open_times` in chrome.storage.local, survives worker restarts). If the content script sees Facebook's "You're Temporarily Blocked" interstitial it answers `{blocked:true}` — the worker then pauses ALL enrichment for 6h (`enrich_cooldown_until`) and does NOT stamp the post, so a block window can never permanently poison rows. Queue jobs dropped by the cap/cooldown re-queue when the post is next re-saved (re-scrape) or via the backfill message. Note this touches only facebook.com (existing host permission) — the offline-by-default rule (nothing but Telegram leaves the machine) still holds.
- **Neighbour-ID theft guard.** The permalink walk-up in `extractPost` is bounded twice: it never ascends into the `role="feed"` container, AND it stops when a 2nd author link enters scope. Without this, a permalink-less post (anonymous / background / commentless) on a no-`role=feed` surface climbs into an adjacent card, steals its `/posts/` or `/commerce/` ID, and silently overwrites that real post in IDB. Confirmed live: a sublet stole a furniture-listing ID; an apartment was lost.
- **Comment-link permalink recovery** (`pickPostIdFromComments`). When a post has no own permalink, the parent post ID is read (read-only) from the mode of its comments' `/posts/<id>?comment_id=` hrefs.
- **Permalink-less post ID = full-text hash.** When there's no permalink and no comment-recoverable ID, `post_id = h_<hash(author + '|' + full normalised text)>`. Full text (not `text.slice(0,200)`) because anonymous posts share a blank author — two different anonymous posts with the same 200-char prefix would otherwise collide and overwrite. Mirrors `lib/dedup.js::normalise`.

### Debug instrumentation (present in v1.2.0)

`content/content.js` carries a `TLV_DEBUG` block (`dbgSave`/`dbgStop`) that logs every save (`NEW` / `OVERWRITE` / `DUP-HASH`, id, body snippet) and a stop summary (distinct ids, overwrites, `REACHED BOTTOM` vs `STOPPED EARLY`). Console-only, no behaviour change. Intentionally retained for now; gate or remove (`TLV_DEBUG = false`) when diagnosing is no longer needed.

## Architecture

### Data flow

Facebook feed → content scripts → service worker → IndexedDB → dashboard.

### Why this architecture?

- **Content scripts** (facebook.com origin) can see the Facebook DOM but cannot directly access the extension's IndexedDB. They extract posts and send them to the service worker via `chrome.runtime.sendMessage`.
- **Service worker** (extension origin) handles all storage (IndexedDB). It always runs at the extension origin, so its IndexedDB is shared with the dashboard.
- **Dashboard** shares the extension origin with the service worker, so it has direct IndexedDB access.

### Key components

| File | Role |
|------|------|
| **manifest.json** | Declares permissions, content scripts, service worker, popup, dashboard. |
| **background.js** | Service worker — message router, deduplication, regex classification orchestrator. |
| **content/extractor.js** | Extracts post data from Facebook DOM. |
| **content/scroller.js** | Auto-scrolls feed, clicks "See more" buttons. |
| **content/content.js** | Main content script — orchestrates scraper state machine. |
| **popup/popup.js** | Popup UI — scrape controls, live status polling. |
| **dashboard/dashboard.js** | Dashboard — loads posts, filters in-memory, chunked card rendering, tag editor, shadow-ML review, Pipeline menu actions (extract/re-test/retrain/backfill/exports). |
| **lib/db.js** | IndexedDB wrapper — including `clearAllPosts()` for bulk deletion. |
| **lib/regex_extractor.js** | Local Hebrew/English regex classifier + tag extractor. No network. |
| **lib/dedup.js** | Post fingerprinting — SHA-256. |
| **lib/notify.js** | Telegram notification plumbing — settings store, `sendTelegram`, `matchesPreferences`, `formatPostMessage`. |
| **lib/bot.js** | Telegram bot command interface — getUpdates polling, command router, `/start` setup wizard, `/retrain`. |
| **lib/ml_features.js** | Shared ML tokenizer/scorer — single source of truth for train + runtime. |
| **lib/ml_classifier.js** | ML runtime — `mlHybridLabel`, `mlBrokerFill`, dynamic weight loading. |
| **lib/ml_weights.js** | GENERATED bundled weights (by `ml/train.mjs`). Never edit by hand. |
| **lib/ml_train_core.js** | Pure training machinery (TF-IDF + logistic regression, CV, pruning). |
| **lib/ml_retrain.js** | In-extension retraining from corrections — used by dashboard 🧠 and `/retrain`. Also trains the shadow heads. |
| **lib/ml_shadow.js** | Shadow-mode storage + scoring: `ml_shadow` record shape, verdicts, review queue, promotion bars, leak guard. |
| **lib/ml_price.js** | Price CANDIDATE RANKER — candidate generation, period detection, context features, `predictPrice`, `explainPrice`. |
| **lib/ml_roommates.js** | Shadow roommates head (keyword-masked binary classifier). |
| **lib/ml_price_weights.js**, **lib/ml_roommates_weights.js** | GENERATED shadow weights. Never edit by hand. |
| **lib/ml_weights_export.js** | Turns promoted (chrome.storage.local) weights back into the bundled `lib/*_weights.js` modules — dashboard 💾 Export Weights. |
| **devtools/devtools.html/.js** | In-extension devtools page (stats, reasoning, shadow ML, weights). No Node. |
| **devtools/devtools_core.js** | Pure stats/reasoning computation shared by the extension page AND the optional Node shell. |
| **ml/** | Offline side: `gold_labels.json` (2,953 gold labels), `train.mjs`, `train_price.mjs`, `train_roommates.mjs`, `shadow_selftest.mjs`. |

## Common development tasks

### Running the extension locally

1. Navigate to `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked and select the repository folder

### Testing the dashboard

1. Open `chrome-extension://[extension-id]/dashboard/dashboard.html` or click Open Dashboard in the popup
2. Click Regex Extract to backfill tags on rental posts that have not been regex-processed
3. Click the pencil button on a card to edit tags — corrections are stored in IndexedDB

## Key concepts & gotchas

### Facebook URL patterns and permalink construction

The extractor (`content/extractor.js`) handles these URL shapes in priority order:

| Pattern | Where it appears | Post-ID derivation |
|---------|------------------|--------------------|
| `/groups/GID/posts/PID/` | Individual group pages | path segment after `/posts/` |
| `/groups/GID/permalink/PID/` | Older group-page format | path segment after `/permalink/` |
| `?story_fbid=PID` | Profile / home feed | `story_fbid` query param |
| `?multi_permalinks=PID` | Aggregated `/groups/feed/` timestamp links | `multi_permalinks` query param |
| `?set=pcb.PID` | Photo-album image links on `/groups/feed/` | numeric ID after `pcb.` |
| `?set=gm.PID&idorvanity=GID` | Photo-album links on the home feed | numeric ID after `gm.`; `idorvanity` gives GID directly |
| `/commerce/listing/PID` | Marketplace cross-posts & pure listing cards | path segment after `/commerce/listing/`, prefixed `cl_` |
| `/marketplace/item/PID` | Marketplace alternate URL | path segment after `/marketplace/item/`, prefixed `mp_` |
| *(none — comment recovery)* | Post with comments but no own permalink | mode of comments' `/posts/<id>?comment_id=` hrefs (`pickPostIdFromComments`) |
| *(none — hash fallback)* | Anonymous / background / commentless posts (no permalink anywhere) | `h_<hash(author + '|' + full normalised text)>`; Open button disabled |

**`/groups/feed/` and home-feed DOM quirk (important).** On both the aggregated groups feed and the home feed, Facebook renders *zero* `/posts/` URLs inside a post's card container. The only post-ID signal is on photo image links:

- `?set=pcb.POST_ID` on `/groups/feed/` ("photo card book")
- `?set=gm.POST_ID&idorvanity=GROUP_ID` on the home feed ("group media")

The group ID must be read from one of: `idorvanity` query param (home feed, easiest), author links (`/groups/GID/user/UID/`), the source-group link, or a walk-up scan for any `/groups/<GID>/` anchor. The extractor walks up 8 DOM levels to locate `authorEl` when `cardEl.querySelector(SEL.authorLink)` returns null.

**Pcb/gm shadowing trap on group pages.** A reused branding image (e.g. a company logo first uploaded in 2017) carries `?set=pcb.OLD_POST_ID` from the *original* photo album. If the extractor returns that pcb anchor eagerly, the walk-up in `extractPost()` stops before reaching the card-header ancestor with the real `/posts/CURRENT_ID` link — yielding the wrong post_id AND a 2017 `posted_at` from the image anchor's aria-label. `pickPermalink()` therefore deliberately skips pcb/gm links on specific group pages; they are tried as a last resort only after the full walk-up has run.

### Deletion and re-scraping

- **Individual delete** — `db.js::deletePost(id)` removes by primary key. The `_seenContainers` WeakSet in `scroller.js` is in-memory and session-scoped, so deleted posts are re-sent to `background.js` on the next fresh scrape (START_SCRAPE resets both WeakSets). The background dedup checks (`findByDedupHash`, `findByPrefixKey`) only block posts still in IndexedDB.
- **Delete All** — `db.js::clearAllPosts()` calls `IDBObjectStore.clear()`. Dashboard has a "🗑 Delete All" button (requires typed confirmation + post-count display). After clearing, the next scrape re-captures everything from scratch.
- **CONTINUE_SCRAPE** does **not** reset the WeakSets — it picks up exactly where the previous session left off, intentionally skipping already-seen containers.

### Deduplication strategy

Four independent mechanisms, checked in order on every `SAVE_POST`:

- **`post_id`** is the IndexedDB primary key. Derived from the permalink when one exists; otherwise comment-recovered or a full-text hash (see the URL-patterns table). Two saves with the same `post_id` overwrite — this is how the same post re-scraped, or the same listing cross-posted to many groups (identical `cl_` id), collapses to one row.
- **`dedup_hash`** (`lib/dedup.js`, SHA-256 of normalised text + first image URL) catches cross-group reposts that have *different* post_ids but identical content; the duplicate inherits the original's classification.
- **`prefix_key`** (`lib/dedup.js::computePrefixKey`, first 10 normalised words joined by spaces) catches near-duplicates whose OPENING is unchanged — the same listing reposted with minor edits later in the text (different phone number, added emoji, small price change). Stored as a field on each post and indexed in IDB; `findByPrefixKey` does an O(1) lookup after the exact `dedup_hash` check misses.
- **`suffix_key`** (`lib/dedup.js::computeSuffixKey`, last 10 normalised words, 2026-07-25) catches the mirror-image case: a repost that edits the HEADLINE (defeating `prefix_key`) but keeps its closing lines — location, conditions, contact — intact. This was the dominant pattern in the 2026-07-25 dupe-miss report (6/6 reported pairs matched only via suffix, not prefix). Both `prefix_key`/`suffix_key` normalisation strips phone-like digit runs (9+ digits) and the "See less" UI artifact, since those are the parts most likely to differ between an agent's repost of their own template. Because a shared suffix is a much weaker signal than a shared prefix (the same broker template recurs across *different* apartments), `findAllBySuffixKey` returns every candidate rather than the first match, and each is scored by `textSimilarity` before acceptance — only the best match ≥ 0.55 is marked, same gate as the sweep and manual pairing below.

**Self-shadowing guard (2026-07-17).** `findByDedupHash` / `findByPrefixKey` take an `excludePostId` (the post being saved). Without it, `index.get()` returns the lowest-primary-key match — on a re-scrape that can be the post's own row, hiding a true duplicate that sorts after it. Confirmed live: a re-scraped post whose post_id sorted below its cross-group original never got marked.

**Maintenance sweep** (`background.js::dedupMaintenanceSweep`, one-time per profile, guarded by `dedup_sweep_v2` in chrome.storage.local): backfills `prefix_key`/`suffix_key` on rows missing either (pre-v1.4.0 rows have neither; rows saved between v1.4.0 and 2026-07-25 have only `prefix_key`) and retro-marks duplicates that entered the DB unmarked. Posts are grouped by a union-find over BOTH keys (so a repost connected to the original only via prefix, and a second repost connected to the first only via suffix, still collapse into one family); the earliest clean post in each family stays the original, and later members are marked only when whole-text `textSimilarity` ≥ 0.55 — the gate that spares broker-template posts sharing an opening or closing line but describing different apartments.

**Manual dupe marking** (dashboard ⊘ Dupe) also flags a `regex_miss` with `missed_fields: ['duplicate']` and pairs the post with its most similar non-duplicate (`textSimilarity` ≥ 0.55 → `duplicate_of`/`duplicate_sim`); the miss export prints both full texts.

### Classification (regex only)

`lib/regex_extractor.js` exports:

- `regexClassifyPost(text)` returns `'rental'`, `'not_rental'`, or `null` for ambiguous text. Null is honest — the dashboard surfaces null as "Unlabeled".
- `regexExtractTags(text)` returns `{price, rooms, size, entry_date, roommates, broker}` with nulls where the regex cannot determine the field.

Posts scraped before Gemini was dropped carry its extracted tags. The `ai_classified_by` field is `'regex'` for new posts, unset for legacy ones. The dashboard labels legacy posts "Legacy: Rental" with an "Auto-labeled (legacy)" tooltip.


### Async patterns

- **SAVE_POST** → regex classify → ML hybrid check → tag extract + ML broker fill (all inline, no network) → save → notification check (`notifyIfMatch`, errors never propagate to the save result) → respond.

## ML layer (v2.3.0)

A plain-JS logistic-regression layer (TF-IDF over word+bigram features, Hebrew/Latin/Cyrillic) that rides on top of the regex — no dependencies, no network, runs inline in the service worker.

- **Hybrid classification** (`background.js` SAVE_POST): the regex label stands unless the model is ≥0.9 confident it is wrong (`mlHybridLabel`); when the regex returns null the model decides alone. Overrides get `ai_classified_by: 'ml'` + `ml_prob` and a 🤖 badge on the dashboard. Measured on 5-fold CV over the gold set, hybrid beats regex-alone and model-alone on both accuracy and rental-recall.
- **Broker fill** (`mlBrokerFill`): where `extractBroker` returns null, a weakly-supervised head (trained on keyword-labeled posts with the keywords MASKED, so it learns agency register) fills `tags.broker` when ≥0.9 confident; provenance in `ml_filled: ['broker']`.
- **Continuous training**: dashboard 🧠 Retrain ML button and Telegram `/retrain` run `lib/ml_retrain.js::runRetrain` — gathers the shipped gold set (`ml/gold_labels.json`, ids+labels only; texts joined from IDB or the imported cache below) plus every `human_label` / `tags_human_override.broker` correction, trains in-extension (~10–30s), and promotes to `chrome.storage.local.ml_weights` ONLY if it clears the gold gate. The worker hot-reloads weights via `storage.onChanged`; bundled `lib/ml_weights.js` is the fallback.
- **Gold-text import (fresh installs).** Gold TEXTS are personal data and are never committed — a fresh install (empty IDB) cannot join the gold ids to texts. The dashboard retrain flow detects low coverage and prompts a one-time local import of a dashboard-export JSON into `chrome.storage.local.ml_gold_texts` (never uploaded). Guards, added after a live incident where a fresh install promoted a 212-row model that labeled everything rental at p=0.936: (1) `trainAndGate` refuses to promote with < `MIN_GOLD_ROWS` (2,000) gold rows; (2) `loadStoredMlWeights` ignores any stored payload trained on < 2,000 rows and falls back to bundled; (3) a degenerate stored payload's score never becomes the gate bar.
- **The gate metric is the FIXED gold benchmark** — CV accuracy computed over gold-sourced rows only. Corrections still train the model but do not move the measuring stick (they are by construction the hardest posts; measuring on the whole pool made accuracy appear to drop as corrections accumulated). Two invariants added 2026-07-25 after 83 benchmark rows silently eroded: (1) a corrected gold post STAYS in the benchmark, scored against its `human_label` (before, correcting a gold post removed it from the benchmark — the "fixed" set shrank toward the easy posts); (2) the promotion floor is `max(BASELINE_CV, prev promoted CV) − ε`, so the bar can rise but can never ratchet below the bundled baseline (before, each promotion could sit ε under the previous one indefinitely).
- **Training-data rules (do not weaken):** never train on `ai_label` (the model's own output must not feed back); `human_label` beats the gold file; rejected weights are discarded, never stored.
- **Retraining offline**: `node ml/train.mjs <export.json>` regenerates `lib/ml_weights.js` and prints the full eval (model vs regex vs hybrid per gold subset). It shares `lib/ml_train_core.js` + `lib/ml_features.js` with the in-extension path, so the two cannot diverge; if the tokenizer changes, bump `FEATURE_VERSION` and retrain (stored weights with a stale version are ignored).
- **Superseded (v3.0.0)**: the price candidate scorer now exists — see "Shadow ML" below. entry_date remains unbuilt; its rule gaps (103 posts, highly regular patterns) are cheaper to fix in the regex than to model.

### Weight provenance — which weights are actually in use

Precedence is the same for every head and is decided at each worker start:

```
chrome.storage.local   →  wins if present AND feature_version matches
                          (label head additionally requires >= MIN_GOLD_ROWS)
lib/*_weights.js       →  fallback, and what ships to a fresh clone
```

They never compete: promoted weights always win, the bundled file is the
fallback. So the bundled copy is a *distribution artifact*, not the source of
truth for any given install.

The trap this creates: retraining promotes into `chrome.storage.local`, which is
per-install runtime state invisible to git — so the running model can be well
ahead of what is committed, and reading `lib/ml_weights.js` tells you nothing
about what is scoring your posts. Two things address it:

- **Dashboard 💾 Export Weights** (`lib/ml_weights_export.js`) writes the promoted
  weights back out as the bundled modules, in byte-identical format to what the
  offline trainers emit, so a diff between the two paths is meaningful. It writes
  straight into `lib/` via the File System Access API where available, else falls
  back to downloads. Heads with nothing promoted are SKIPPED, never emitted empty
  — overwriting a good bundled head with a stub would silently downgrade the
  shipped model. `trained_correction_ids` is stripped: it is per-install
  bookkeeping for `countNewCorrections()`, and shipping it would make a fresh
  install believe those corrections were already folded in.
- **Devtools → Weights** opens with a per-head table reading either "running the
  bundled file — repo IS the model", "retrained, and the repo copy matches it",
  or "retrained and AHEAD of the repo". It compares `trained_at` between the
  bundled import and the live active meta; only the in-extension page can do this,
  since the Node shell cannot read `chrome.storage.local`.

Note a `FEATURE_VERSION` bump silently invalidates stored weights and falls back
to bundled — by design, since the tokenizer changed underneath them. The table
flipping to "running the bundled file" is the signal to retrain.

### Content script origins

- **Content scripts** run at `facebook.com` origin; their `indexedDB` is Facebook's.
- **Service worker & dashboard** run at `chrome-extension://[id]` origin, sharing one IndexedDB.


## Shadow ML (v3.0.0)

Two heads — **price** and **roommates** — that predict but **never tag**. They exist
to solve a bootstrapping problem: the label/broker heads could be gated before
shipping because a 2,953-row gold set already existed, but the VALUE tags had no
benchmark, and one cannot be built from regex output (measuring a model against
the rules it imitates proves nothing). Shadow mode generates the benchmark: the
model predicts, predictions are shown but unused, the user judges only
disagreements, and those verdicts become the measuring stick.

### The safety property is structural, not a flag

Shadow values live in `post.ml_shadow`. `matchesPreferences` reads exactly
`post.tags_human_override || post.tags` — so a wrong prediction **cannot** reach
the Telegram filter, not because a guard remembers to skip it but because the
value is not in the object the filter reads. A flag on `tags` would have been one
forgotten condition away from silently suppressing a real listing.
`ml_shadow.js::shadowLeakCheck` asserts the invariant by provenance (a tag equal
to the shadow value counts as a leak only when the regex did not produce it and
no human set it). `ml/shadow_selftest.mjs` holds it in place — 46 assertions, and
test [1] runs the REAL `matchesPreferences` with a control case, so it cannot
pass for the wrong reason.

### Metrics differ per field, deliberately

- **price → PRECISION.** A null price PASSES the notification filter, so
  abstaining costs nothing; a wrong value silently hides a listing the user
  wanted. Only emitted values are scored.
- **roommates → ACCURACY vs the REGEX on the same judged posts.**
  `extractRoommates` made zero errors across 28 hand-checked hard cases, so a
  flat 96% bar would pass a model measurably worse than what ships.

`scoreShadow` also splits precision by disagreement shape — **fill** (regex had
nothing), **override** (both had a value, differing), **abstain** (model
declined). Blending them hides the deciding signal: if fill precision is high and
override precision is poor, the head should fill gaps only, exactly as
`mlBrokerFill` already does for broker.

### Two thresholds, two bars — do not conflate

- `PRICE_SHADOW_EMIT` (0.6) — when to emit a SHADOW prediction. Wrong shadow
  predictions cost nothing; they only ask a question. Reusing the strict 0.9 here
  starved the queue: measured live, 127 outstanding disagreements were ALL
  abstentions and 0 were reviewable, making `MIN_VERDICTS` unreachable.
- `PRICE_CONFIDENCE` (0.9) — the bar for ever TAGGING with this head.
- The gate in `retrainShadowHeads` is a **regression guard** (held-out score vs
  `max(baseline, previous) − ε`), answering "did this retrain break the model?".
- The 96%/beat-the-regex bar in `scoreShadow` answers "is it good enough to
  tag with?" — a separate, later decision the retrain never makes.

### Price is a RANKER, not a head

Document-level TF-IDF cannot emit a value. `lib/ml_price.js` generates every
number that could be a monthly rent, scores each by local context (±45-char
window, adjacency, magnitude bucket, currency, rent-label, line position), and
takes the argmax. Training labels are free: a post whose price the regex found is
a solved ranking problem. This does NOT merely re-encode the regex — the regex
fails on *pattern coverage*, a context scorer learns *distribution*.

**Period discrimination is load-bearing.** The first prototype hit ~75% precision
on regex-null posts and every failure was the same mistake: no notion of what
period a number referred to (`1,200 NIS per night`, `6,000 לכל התקופה`). Handled
two ways: an explicit non-monthly marker vetoes a candidate, and short-stay is
also judged at DOCUMENT level (in "Weekday 1,200/night · Shabbat 1,400", only the
first carries a marker). Hebrew markers need letter boundaries — `לילות` matches
inside the place name `גלילות`, `ליום` inside `ליום-יום`. An explicit monthly
quote overrides ambient short-stay wording.

### Verdict flow

`applyVerdictCorrection` does three things: records the verdict (benchmark),
writes the confirmed value to `tags_human_override` (which is what feeds
retraining — the trainers read that field), and flags/clears `regex_miss` keyed on
whether the REGEX was wrong. The ✏ tag editor records a verdict too, but ONLY for
open disagreements — `saveTagEdits` writes all six fields as a snapshot, so
recording agreements would fill the benchmark with trivially both-correct rows.

`reshadow` carries verdicts across re-prediction but **re-derives** `ml_correct` /
`regex_correct` against the fresh prediction. Carrying them would describe the old
model while `emitted` describes the new one, and precision would silently stop
meaning anything after any retrain.

### Known flaw: roommates masking leaks

`maskRoommateKeywords` blanks the regex span, leaving Hebrew suffix debris — the
head's top tokens are `ים`, `ות`, `פים`, i.e. the keyword bleeding through. That
inflates masked CV (96.2%) far above real precision (53.8% over 13 verdicts).
Fixable by masking whole words; not worth it unless the head earns its keep.

## Devtools (v3.0.0)

Runs **in-extension** (`devtools/devtools.html`, dashboard 🔬 button): reads live
IndexedDB, no sync step, and — unlike a Node process — can read the retrained
weights in `chrome.storage.local`. Refreshes on tab focus so numbers cannot go
stale unnoticed. `devtools/server.mjs` remains as an optional shell for inspecting
an exported JSON offline (`node devtools/server.mjs <export.json>`); both import
`devtools_core.js`, so they cannot disagree. The `localhost:8787` host permission
was removed from the manifest.

## Telegram notifications (v2.0.0)

Opt-in push alerts: when a scrape saves a **first-time-captured** post that matches the user's preferences, `background.js::notifyIfMatch` sends one plain-text Telegram message (price/rooms/size, group, 200-char snippet, permalink). Requires a user-created bot (@BotFather) whose token is pasted into the dashboard 🔔 modal.

### Settings & state

- **`notify_settings`** (chrome.storage.local, one flat object — `lib/notify.js::DEFAULT_NOTIFY_SETTINGS`): `enabled`, `bot_token`, `chat_id`, `max_price`, `min_rooms`, `max_rooms`, `roommates`/`broker` (`'yes' | 'no' | 'either'`), `include_keywords`, `exclude_keywords`. Edited by BOTH the dashboard 🔔 modal and the bot wizard — single source of truth; reads merge over defaults so new fields back-fill old saves.
- **`notify_bot_state`** (chrome.storage.local, `lib/bot.js`): `last_update_id` (getUpdates offset) + `wizard` (`{ step, draft }` or null). Wizard survives worker restarts.

### Matching rules (`lib/notify.js::matchesPreferences`)

- **Nulls pass** (recall over precision, user's explicit choice): a rule only excludes when the extracted field exists AND violates it. Null label also passes; only a confirmed `not_rental` is excluded. `tags_human_override` wins over `tags`.
- Keywords are case-insensitive substring checks on the raw text; include-list = at least one must appear; exclude-list = any appearance skips.

### Anti-spam / delivery guarantees

- Only first-time captures qualify (`wasNewRecord`) — the backlog never floods the chat on a re-scrape. Duplicates (hash or prefix) never alert.
- `notified_at` / `notify_failed_at` are stamped on the post row and **carried across post_id overwrites** in `handleSavePost` (an overwrite replaces the row wholesale and would otherwise erase them).
- A failed send stamps `notify_failed_at` → retried when the next scrape re-saves that post. Success stamps `notified_at` → silent forever after.
- The notify check runs after `savePost` and can never fail the save.

### Bot (`lib/bot.js`)

- **No server.** A 30s `chrome.alarms` tick (`tlv-bot-poll`) plus a poll on every worker start calls `getUpdates`; while a conversation is active it switches to 20s long-poll bursts (~2 min after last activity) so wizard answers get near-instant replies.
- **Commands:** `/start` (bind + 6-step setup wizard), `/reset` (clear prefs + wizard), `/status`, `/on` `/off`, `/cancel` (aborts wizard OR an in-progress correction), `/retrain` (retrain the ML layer on accumulated corrections — same pipeline as the dashboard 🧠 button), `/help`. Finishing the wizard sets `enabled: true`.
- **🚩 Miss correction flow (v2.2.0).** Every alert carries a "🚩 Miss" inline button (`callback_data mopen:<post_id>` — post_ids are always short enough for Telegram's 64-byte cap, worst case ~50 bytes). Tapping it opens a field menu (classification / duplicate / price / rooms / size / entry_date / roommates / broker) whose message is edited in place through the whole session (`editTelegramMessage`). The mutation helpers (`applyTagFieldValue`, `applyClassificationValue`, `applyDuplicateValue`) are ports of dashboard.js's tag editor / label buttons / ⊘ Dupe handler — including the similarity pairing on duplicate-mark — writing the same `tags_human_override` / `human_label` / `is_duplicate` / `regex_miss` fields, so phone corrections appear flagged on the dashboard and ride the Export Misses pipeline with zero dashboard changes. Free-text fields ask for a skippable key phrase after the value; duplicate does not (pairing is the evidence, same as the dashboard). Session state lives in `notify_bot_state.correction`; tapping 🚩 Miss again always starts a fresh session, so abandoned sessions never wedge. If the two mutation paths ever diverge from dashboard.js, the miss export becomes inconsistent — change them together.
- **Auto-bind:** when `chat_id` is empty, the first chat to send `/start` becomes the bound chat; all other chats are dropped silently before command parsing. This replaces the dashboard Detect button as the primary binding path.
- **First poll drains the backlog** without acting on it (messages sent before the bot was configured must not trigger surprise replies).
- **At-most-once:** each update's offset is persisted BEFORE handling — a crash loses that message rather than replaying commands forever.
- **Single getUpdates consumer:** the poller owns the connection. The dashboard Detect button's own `getUpdates` call can 409-conflict with it — harmless (both sides catch), but expect Detect to be unreliable while the poller runs.

### Gotchas

- `host_permissions` includes `https://api.telegram.org/*`; permissions include `"alarms"`. Unpacked extensions gain new host permissions silently on reload (no prompt — that's normal).
- Messages are plain text, no `parse_mode` — Hebrew post text full of `<`/`&`/`_` would break HTML/Markdown modes.
- The bot only works while Chrome is running; Telegram queues updates ~24h, and the worker-start poll applies queued commands before the next scrape saves anything.

## Message contracts

### Popup ↔ content script

- `PING` → `{ alive, groupId, groupName }`
- `GET_STATS` → `{ running, postsCaptured, duplicatesInARow, totalDuplicates, totalOverwrites, elapsedMs, startTime, stopReason }`
- `START_SCRAPE { options: { duplicateThreshold, maxDurationMinutes } }` → `{ ok }`
- `STOP_SCRAPE` → `{ ok }`
- `CONTINUE_SCRAPE { options: { extraPosts | extraMinutes, duplicateThreshold } }` → `{ ok }`

`totalOverwrites` counts saves that targeted an already-existing `post_id` — the row was silently overwritten, no net new record. Distinct from `totalDuplicates`, which counts dedup-hash matches that happen to have a *different* `post_id` (cross-group reposts of identical content). Both count toward the duplicates-in-a-row stop condition.

### Content script ↔ service worker

- `SAVE_POST { post }` → `{ ok, is_duplicate, is_new_record }`
- `GET_TOTAL_COUNT` → `{ count }`

`is_new_record` is `true` when no row with the post's `post_id` existed before this save; `false` when an existing row was overwritten. The popup uses this to render "X new + Y duplicates + Z re-scraped" accurately.

### Dashboard ↔ service worker

- `OPEN_DASHBOARD` → `{ ok }`

`CLASSIFY_POST`, `EXTRACT_TAGS`, and `SYNC_LABEL` were removed (Gemini and training server are gone). Classification is fully local now.

## File write & verification

The Edit and Write tools have historically failed silently on this repo, sometimes truncating files or leaving trailing null bytes. When modifying files, verify with:

```bash
wc -c <file>
node --input-type=module --check < <file>
tr -d '\000' < file > file.tmp && mv file.tmp file
```

For rewrites, prefer bash heredocs over Write tool. Use a unique sentinel (not `EOF`) when the content contains `EOF`.

See memory file: `feedback_file_write_verification.md`.

## Debugging tips

- Service worker logs: Extension settings > service worker > Inspect
- Content script logs: Facebook tab > F12
- Dashboard logs: Dashboard tab > F12
- All major logs use the `[TLV Rentals]` prefix.

## Browser compatibility

Chrome, Edge, Arc, Brave (any Chromium-based MV3 browser). Not Firefox.

## License

GNU General Public License v3.0 with an added restriction that prevails over it: **no commercial use of any kind** (no selling/subscription of the software or derivatives, no use by or for real-estate businesses, personal use only). See the License section at the top of README.md and LICENSE.
