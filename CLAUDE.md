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

## Active plan

These stages are sequential.

1. **Drop Gemini entirely — regex-only pipeline** (complete as of 2026-05-26). `lib/gemini.js` deleted; `host_permissions` no longer mentions `generativelanguage.googleapis.com`; popup has no settings panel; dashboard has no "Classify & Tag" button. Classification is now `lib/regex_extractor.js` only, called inline from `background.js` on every `SAVE_POST`. Existing Gemini-extracted tags in IDB were left in place — no migration.
2. **Dashboard "regex missed" mechanism.** Add UI to mark a post as a regex miss and record *why* the correct answer is correct. The "why" is the training signal — the user batches these and pastes them to Claude, who updates `lib/regex_extractor.js` rules accordingly.
3. **Fix the Open button.** (Complete as of 2026-05-28.) Canonical permalink construction now works across all Facebook URL patterns: `/posts/`, `/permalink/`, `?multi_permalinks=`, `?set=pcb.POST_ID` (photo-album posts on the aggregated feed), `/commerce/listing/`, and `/marketplace/item/`. The extractor walks up to 8 DOM levels to locate the group ID when the card container is too narrow to contain the author link.
4. **Missing-posts capture overhaul** (complete as of 2026-05-30, v1.2.0). See the dedicated section below. Detection rewritten to `role="feed"` child units; neighbour-ID theft fixed; pure Marketplace cards captured; anonymous-post hashing hardened.
5. ~~**Improve duplicate detection.**~~ (Complete as of 2026-07-12, v1.4.0.) Two-layer dedup: exact SHA-256 match (unchanged) plus a `prefix_key` index on the first 10 normalised words (`lib/dedup.js::computePrefixKey`). `findByPrefixKey` in `lib/db.js` does an O(1) IDB index lookup after the exact-hash check fails. Catches cross-posted listings edited before reposting (different phone, emoji, small price change). DB schema bumped to v2 to add the `prefix_key` index; `onupgradeneeded` handles the v1→v2 migration automatically.
6. **Fix the group-name capture bug.** Some group names come through truncated.
7. ~~**Telegram notifications + phone-side bot control.**~~ (Complete as of 2026-07-13, v2.0.0.) See the dedicated section below. Push alerts to the user's phone when a newly scraped post matches saved preferences; preferences editable from the dashboard 🔔 modal or from the Telegram chat itself (`/start` setup wizard).

## Post detection (v1.2.0 overhaul)

Detection (`content/scroller.js → processVisible`) runs three paths, each dispatching a card to the extractor exactly once:

- **Path 1 — `role="feed"` children.** The primary detector. Each direct child of a `role="feed"` container is one post. Comment-immune (a comment is a `role="article"` *inside* the card, never its own child) and anchor-independent (works whether or not the post has a `data-ad-*` body anchor). A child counts as a post if it has a body anchor, a `/commerce/listing/` link, or a non-comment `div[dir="auto"]` ≥ 40 chars (skips the "sort feed" header and empty virtualisation placeholders).
- **Path 2 — body anchors outside any `role="feed"`.** Legacy fallback for surfaces with no feed container.
- **Path 3 — commerce links (pure Marketplace cards).** Catches Marketplace listing cards that have no body anchor at all. The card is bounded by author count (walk up while ≤ 1 author link; a 2nd author = a neighbour). Skipped if the card has a body anchor (then it's a written post, handled by Path 1/2).

**Why `/?filter=all&sk=h_chr` matters.** This personalised home feed (all the user's groups, chronological) is the primary scraping surface and has **no `role="feed"` container** — Path 1 never fires there, so Paths 2 and 3 carry it. Any change to detection must be checked on this surface, not just on a single `/groups/<id>/` page.

### Extraction guardrails

- **Comment-safe.** Author (`pickAuthorLink`), text fallback (`pickFallbackBodyText`), and images all exclude `role="article"` (comment) subtrees. `pickAuthorLink` also skips the empty avatar-wrapper `/user/` link so `author_name` isn't blank.
- **Pure-Marketplace text** (`pickMarketplaceText`). A listing card's `div[dir="auto"]` blocks are CSS-scrambled decoy ("Facebook" repeated); the real title/price live in plain `<div>`s. The function scopes to the largest ancestor excluding the author header and reads direct text nodes. Only fires when the post has no written body.
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
| **dashboard/dashboard.js** | Dashboard — loads posts, filters in-memory, tag editor, Regex Extract backfill. |
| **lib/db.js** | IndexedDB wrapper — including `clearAllPosts()` for bulk deletion. |
| **lib/regex_extractor.js** | Local Hebrew/English regex classifier + tag extractor. No network. |
| **lib/dedup.js** | Post fingerprinting — SHA-256. |
| **lib/notify.js** | Telegram notification plumbing — settings store, `sendTelegram`, `matchesPreferences`, `formatPostMessage`. |
| **lib/bot.js** | Telegram bot command interface — getUpdates polling, command router, `/start` setup wizard. |

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

Three independent mechanisms, checked in order on every `SAVE_POST`:

- **`post_id`** is the IndexedDB primary key. Derived from the permalink when one exists; otherwise comment-recovered or a full-text hash (see the URL-patterns table). Two saves with the same `post_id` overwrite — this is how the same post re-scraped, or the same listing cross-posted to many groups (identical `cl_` id), collapses to one row.
- **`dedup_hash`** (`lib/dedup.js`, SHA-256 of normalised text + first image URL) catches cross-group reposts that have *different* post_ids but identical content; the duplicate inherits the original's classification.
- **`prefix_key`** (`lib/dedup.js::computePrefixKey`, first 10 normalised words joined by spaces) catches near-duplicates — the same listing reposted with minor edits (different phone number, added emoji, small price change). Stored as a field on each post and indexed in IDB (v2 schema); `findByPrefixKey` does an O(1) lookup after the exact `dedup_hash` check misses.

### Classification (regex only)

`lib/regex_extractor.js` exports:

- `regexClassifyPost(text)` returns `'rental'`, `'not_rental'`, or `null` for ambiguous text. Null is honest — the dashboard surfaces null as "Unlabeled".
- `regexExtractTags(text)` returns `{price, rooms, size, entry_date, roommates, broker}` with nulls where the regex cannot determine the field.

Posts scraped before Gemini was dropped carry its extracted tags. The `ai_classified_by` field is `'regex'` for new posts, unset for legacy ones. The dashboard labels legacy posts "Legacy: Rental" with an "Auto-labeled (legacy)" tooltip.


### Async patterns

- **SAVE_POST** → regex classify + tag extract inline (no network) → save → notification check (`notifyIfMatch`, errors never propagate to the save result) → respond.

### Content script origins

- **Content scripts** run at `facebook.com` origin; their `indexedDB` is Facebook's.
- **Service worker & dashboard** run at `chrome-extension://[id]` origin, sharing one IndexedDB.

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
- **Commands:** `/start` (bind + 6-step setup wizard), `/reset` (clear prefs + wizard), `/status`, `/on` `/off`, `/cancel`, `/help`. Finishing the wizard sets `enabled: true`.
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
