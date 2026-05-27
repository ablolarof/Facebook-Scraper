# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TLV Rentals** is a Manifest V3 Chrome extension that scrapes Tel Aviv apartment rental posts from Facebook feeds and classifies them with a local regex pipeline. Posts are stored in IndexedDB and presented through a filterable dashboard.

The extension is fully offline. The only outbound traffic is to an optional local training server at `http://localhost:8765` that mirrors human corrections into a SQLite database. If that server is not running, every fetch fails silently and nothing breaks.

## How to work with the user

**Diagnostics first, code changes second.** Before fixing a bug or making any non-trivial change to the code, propose diagnostic tests the user can run that confirm:

1. The hypothesis about what is broken or how the current behaviour actually works, *and*
2. The proposed fix will actually do what is intended.

Hand the user paste-ready snippets — DevTools console blocks against the live extension, shell commands, SQL queries against `training.db`, IndexedDB inspection scripts. Wait for the results before modifying files. If the diagnostic disproves the hypothesis, revise the plan rather than ship the change anyway.

This applies to every stage of the project — bug fixes, refactors, new features. Skipping the diagnostic step has historically led to rewrites and lost work.

## Active 5-stage plan

These stages are sequential.

1. **Drop Gemini entirely — regex-only pipeline** (complete as of 2026-05-26). `lib/gemini.js` deleted; `host_permissions` no longer mentions `generativelanguage.googleapis.com`; popup has no settings panel; dashboard has no "Classify & Tag" button. Classification is now `lib/regex_extractor.js` only, called inline from `background.js` on every `SAVE_POST`. Existing Gemini-extracted tags in IDB were left in place — no migration.
2. **Dashboard "regex missed" mechanism.** Add UI to mark a post as a regex miss and record *why* the correct answer is correct. The "why" is the training signal — the user batches these and pastes them to Claude, who updates `lib/regex_extractor.js` rules accordingly.
3. **Fix the Open button.** Currently links correctly only when the post URL contains `/commerce/listing/`. Group-page permalinks land users on the wrong page or a disabled stub.
4. **Improve duplicate detection.** Current dedup is SHA-256 of normalised text + first image URL. Many cross-posted listings with slightly different wording slip through.
5. **Fix the group-name capture bug.** Some group names come through truncated.

## Architecture

### Data flow

Facebook feed → content scripts → service worker → IndexedDB → dashboard. Service worker also fires labels to optional `localhost:8765` training server.

### Why this architecture?

- **Content scripts** (facebook.com origin) can see the Facebook DOM but cannot directly access the extension's IndexedDB or reach `localhost:8765`. They extract posts and send them to the service worker via `chrome.runtime.sendMessage`.
- **Service worker** (extension origin) handles all storage (IndexedDB) and outbound network (training server). It has the `host_permissions` required to reach `localhost:8765`.
- **Dashboard** shares the extension origin with the service worker, so it has direct IndexedDB access. Writes for label corrections go through the service worker's `SYNC_LABEL` handler.

### Key components

| File | Role |
|------|------|
| **manifest.json** | Declares permissions, content scripts, service worker, popup, dashboard. |
| **background.js** | Service worker — message router, deduplication, regex classification orchestrator, training-server sync. |
| **content/extractor.js** | Extracts post data from Facebook DOM. |
| **content/scroller.js** | Auto-scrolls feed, clicks "See more" buttons. |
| **content/content.js** | Main content script — orchestrates scraper state machine. |
| **popup/popup.js** | Popup UI — scrape controls, live status polling. |
| **dashboard/dashboard.js** | Dashboard — loads posts, filters in-memory, tag editor, Regex Extract backfill. |
| **lib/db.js** | IndexedDB wrapper. |
| **lib/regex_extractor.js** | Local Hebrew/English regex classifier + tag extractor. No network. |
| **lib/dedup.js** | Post fingerprinting — SHA-256. |
| **lib/neighborhood_overrides.js** | Deterministic Hebrew → English neighborhood mapping. |
| **server/server.py** | Optional FastAPI/SQLite training-data sink. |

## Common development tasks

### Running the extension locally

1. Navigate to `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked and select the repository folder

### Testing the dashboard

1. Open `chrome-extension://[extension-id]/dashboard/dashboard.html` or click Open Dashboard in the popup
2. Click Regex Extract to backfill tags on rental posts that have not been regex-processed
3. Click the pencil button on a card to edit tags — corrections sync to the training server

## Key concepts & gotchas

### Deduplication strategy

Posts are deduplicated by content hash (text + first image URL). Cross-group reposts of the same listing inherit the original's classification. Stage 4 will replace this with a fuzzier signal.

### Classification (regex only)

`lib/regex_extractor.js` exports:

- `regexClassifyPost(text)` returns `'rental'`, `'not_rental'`, or `null` for ambiguous text. Null is honest — the dashboard surfaces null as "Unlabeled".
- `regexExtractTags(text)` returns `{price, rooms, size, neighborhood, neighborhood_confidence, neighborhood_evidence, entry_date, roommates, broker}` with nulls where the regex cannot determine the field.

Posts written before the rip carry Gemini-extracted tags. The `ai_classified_by` field is `'regex'` for new posts, unset for legacy ones. The dashboard labels legacy posts "AI: Rental" with an "Auto-labeled (legacy)" tooltip.

### Neighborhood detection

Currently doesn't work. to be dealt with in the next phase.

### Async patterns

- **SAVE_POST** → regex classify + tag extract inline (no network) → save → respond.
- **SYNC_LABEL** → fire-and-forget POST to training server; always responds `{ ok: true }` even if server is down.

### Content script origins

- **Content scripts** run at `facebook.com` origin; their `indexedDB` is Facebook's.
- **Service worker & dashboard** run at `chrome-extension://[id]` origin, sharing one IndexedDB.

## Message contracts

### Popup ↔ content script

- `PING` → `{ alive, groupId, groupName }`
- `GET_STATS` → `{ running, postsCaptured, duplicatesInARow, totalDuplicates, elapsedMs, startTime, stopReason }`
- `START_SCRAPE { options: { duplicateThreshold, maxDurationMinutes } }` → `{ ok }`
- `STOP_SCRAPE` → `{ ok }`
- `CONTINUE_SCRAPE { options: { extraPosts | extraMinutes, duplicateThreshold } }` → `{ ok }`

### Content script ↔ service worker

- `SAVE_POST { post }` → `{ ok, is_duplicate }`
- `GET_TOTAL_COUNT` → `{ count }`

### Dashboard ↔ service worker

- `OPEN_DASHBOARD` → `{ ok }`
- `SYNC_LABEL { post }` → `{ ok }`

`CLASSIFY_POST` and `EXTRACT_TAGS` were removed when Gemini was dropped. Classification is fully local now.

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

GNU General Public License v3.0. See LICENSE.
