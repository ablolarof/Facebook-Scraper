# Scraping Facebook Feeds — A Detailed Engineering Report

**Project:** TLV Rentals (Manifest V3 Chrome extension)
**Scope of this report:** the *post-capture / scraping* subsystem — how the extension finds and extracts posts from Facebook feeds. Deduplication, re-scraping, classification, and the dashboard are mentioned only where they touch scraping.
**Status:** reflects v1.2.0 (2026-05-30).
**Audience:** future developers maintaining this code, and curious non-engineers who want to understand how (and why) it works.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [What "scraping a feed" actually means](#2-what-scraping-a-feed-actually-means)
3. [How Facebook builds a feed (the DOM you're fighting)](#3-how-facebook-builds-a-feed-the-dom-youre-fighting)
4. [A taxonomy of Facebook posts](#4-a-taxonomy-of-facebook-posts)
5. [The scraping pipeline, end to end](#5-the-scraping-pipeline-end-to-end)
6. [Detection: the three paths](#6-detection-the-three-paths)
7. [Extraction and its guardrails](#7-extraction-and-its-guardrails)
8. [The diagnostic journey: issues, hypotheses, tests, solutions](#8-the-diagnostic-journey-issues-hypotheses-tests-solutions)
9. [Limitations (read this before trusting the data)](#9-limitations-read-this-before-trusting-the-data)
10. [A guide for future developers](#10-a-guide-for-future-developers)
11. [A guide for non-engineers](#11-a-guide-for-non-engineers)
12. [Appendix A — selector reference](#appendix-a--selector-reference)
13. [Appendix B — reusable console probes](#appendix-b--reusable-console-probes)
14. [Appendix C — glossary](#appendix-c--glossary)

---

## 1. Executive summary

This extension reads apartment-rental posts out of Facebook group feeds, with no API and no network calls — purely by reading the rendered web page (the DOM) the way a human's browser sees it. That sounds simple. It is not, because Facebook's feed is engineered to be **read by humans, not by machines**: it has almost no stable, semantic markup; it recycles and destroys page elements as you scroll; it scrambles some text with CSS; and it renders the *same* logical post in several structurally different ways depending on which feed surface you're on.

The headline lessons from building this:

- **There is no single reliable "this is a post" marker.** We tried three different anchors before landing on a layered approach. The most robust signal turned out to be a structural one — the direct children of a `role="feed"` container — but that container *doesn't exist on the most important surface* (the personalised home feed), so we need fallbacks.
- **The biggest bugs were silent.** Posts didn't error out — they were simply never seen, or they quietly overwrote each other in storage. You cannot debug what doesn't announce itself. The single most valuable practice in this whole project was **writing throwaway diagnostic probes that run in the browser console and *count* things**, before changing any code.
- **Comments are the enemy of naïve scraping.** A Facebook comment looks a lot like a small post. Several of our worst bugs came from accidentally treating comments as posts, or reading a comment's data as if it were the post's.
- **"Captured" and "has a working link" are different problems.** Many posts are captured perfectly but have no shareable URL anywhere in the page (Facebook builds the link only when you click). That's a limitation of the medium, not a bug in the code.

---

## 2. What "scraping a feed" actually means

When you load a Facebook group, your browser receives a stream of JavaScript that *builds* the page in memory. What you see — posts, names, photos, timestamps — is the **DOM** (Document Object Model): a live tree of elements (`<div>`, `<a>`, `<img>`, …) that the browser renders to pixels.

A scraper does what your eyes do, but in code: it walks that tree, finds the chunks that are posts, and pulls out the fields it cares about (author, text, price, link, images). Three hard constraints shape everything:

1. **We only get what's rendered.** If Facebook hasn't drawn a post into the DOM yet (because you haven't scrolled to it), it doesn't exist for us. So scraping is inseparable from **scrolling**.
2. **We run in an "isolated world."** A Chrome extension's content script shares the *page's* DOM but not its JavaScript variables. We can read every element, but we cannot call Facebook's own functions or read its internal data. Everything must come from the visible DOM.
3. **Facebook actively churns the DOM.** To stay fast with infinite feeds, Facebook keeps only a small window of posts "live" at any moment and destroys the rest (this is **virtualization**, §3). Our scraper has to grab a post during the brief window it's alive.

---

## 3. How Facebook builds a feed (the DOM you're fighting)

This section is the single most important context for anyone touching this code. Facebook's markup choices are *adversarial to scraping* — not always on purpose, but the effect is the same. Here is what we learned about it, concretely.

### 3.1 Class names are randomised and meaningless

A typical post wrapper looks like:

```html
<div class="x1n2onr6 xh8yej3 x1ja2u2z xod5an3">…</div>
```

Those class names (`x1n2onr6`, …) are **atomic CSS hashes**, regenerated by Facebook's build system. They change without notice and carry no meaning. **Rule #1 of this codebase: never select on a class name.** Every selector we use is anchored on `role`, `aria-*`, `data-*`, `href` shapes, or DOM structure — things tied to *function*, which Facebook changes far less often.

### 3.2 `role="feed"` and `role="article"` — the semantic skeleton (when present)

Facebook uses ARIA roles for accessibility, and these are our most stable hooks:

- **`role="feed"`** — a container whose **direct children are individual posts**. This is the cleanest "one child = one post" signal we have. *But it is not always present* (see §3.6).
- **`role="article"`** — wraps a self-contained content unit. Critically, on the surfaces we scrape, **`role="article"` wraps *comments*, not the top-level post.** This was a repeated source of bugs: code that treated `role="article"` as "a post" actually grabbed comments. We now treat `role="article"` as a reliable **"this is a comment, exclude it"** marker.

### 3.3 The `data-ad-*` body anchors — present on *some* posts only

When Facebook renders a post's written body, it *sometimes* tags the text block with one of:

```
[data-ad-preview="message"]            (legacy renderer)
[data-ad-comet-preview="message"]      (newer "Comet" renderer)
[data-ad-rendering-role="story_message"]  (aggregated /groups/feed/ renderer)
```

The original version of this scraper keyed *entirely* on these "body anchors." That was Root Cause #1 of the missing-posts problem (§8.1): a large fraction of posts — anything without a normal written body in that exact shape — has **none** of these attributes, so the scraper never even iterated them.

### 3.4 `div[dir="auto"]` — where text actually lives

Hebrew and mixed RTL/LTR text is wrapped in `<div dir="auto">` (auto-direction). The post body, when it has no `data-ad-*` anchor, is usually the **largest** `div[dir="auto"]` block in the card. "Largest by character count" is a surprisingly reliable heuristic for "this is the prose, not a label" — the author name, "See more", and UI chrome are all short.

Caveat: comments *also* use `div[dir="auto"]`. So "largest `dir=auto`" must be scoped to **exclude `role="article"` subtrees**, or you'll grab a long comment instead of the post (this exact bug bit us — §8.2).

### 3.5 CSS-scrambled decoy text (the "Facebook Facebook Facebook" trap)

Some cards — notably **pure Marketplace listing cards** — fill their `div[dir="auto"]` blocks with **decoy text**: the literal word "Facebook" repeated dozens of times. The *real* title and price are rendered in plain `<div>`s (no `dir` attribute) and visually reordered with CSS so they read correctly to a human. A probe on one listing found **52 decoy `span[dir="auto"]` blocks all reading "Facebook"**, while the real "₪10,500 · דירת 3 חדרים …" sat in unattributed `<div>`s.

This is almost certainly an anti-scraping measure. The defence: for these cards, read **direct text nodes of plain `<div>`s** and explicitly drop the `"Facebook"` token (see `pickMarketplaceText`, §7.4).

The same scrambling hits **timestamps**: a post's "4h" timestamp link sometimes has `innerText` like `d S r o e p o n t s 2 8 1 0 5 …` (one character per line, visually reordered). This breaks naïve time parsing and is why `posted_at` can be unreliable for some posts.

### 3.6 The home feed has **no `role="feed"`** — and it's the surface that matters most

The user's primary scraping surface is `https://www.facebook.com/?filter=all&sk=h_chr` — the personalised home feed showing **all their groups, chronologically**, without Facebook's algorithm injecting suggested content. This surface is the whole point of the tool.

We confirmed by probe that **this surface renders with zero `role="feed"` containers** (and zero `data-pagelet="FeedUnit_*"` either). The post wrappers are anonymous `<div>`s nested ~5–6 levels deep, distinguishable only by structure (e.g. a child of a list with ~24 siblings, each holding exactly one author link). Any change to detection **must be tested on this surface**, because the primary detector (`role="feed"` children) silently does nothing here.

### 3.7 Virtualization: posts blink in and out of existence

Facebook keeps only a small window of posts "hydrated" (fully rendered) near the viewport. Scroll past a post and it's **de-hydrated** back into an empty placeholder `<div>` to save memory. A probe early on found a feed container with **14 child slots but only ~3 hydrated posts** — the rest were empty divs above and below the viewport.

Consequences that shaped the design:

- The scraper must **scroll slowly enough that posts hydrate before it tries to read them**, and use a `MutationObserver` to catch posts as they appear.
- Re-hydration requires the **network**. A diagnostic where the user went offline to "freeze" the feed actually *broke* it: de-hydrated posts couldn't be redrawn, so they stayed empty placeholders and were never captured. (Lesson: never scrape offline.)
- The same post's DOM element can be **destroyed and recreated** as you scroll, so per-element dedup (a `WeakSet` of seen elements) sees it as "new" again. This is harmless for data integrity (it overwrites the same `post_id`) but it inflates the "re-scraped" counter.

### 3.8 The isolated-world gotcha (a diagnostic trap, documented so you don't lose hours to it)

Content scripts run in an **isolated world**: they share the DOM with the page but have a *separate* JavaScript global scope. So `window.TLVExtractor` (the extension's extractor object) exists in the content script's world but is **`undefined` in the DevTools console** by default, because the console runs in the *page's* world.

This burned us twice. A diagnostic probe that called `window.TLVExtractor.extractPost(...)` returned `undefined` and looked like the extractor was broken — it wasn't; it was simply unreachable from that context. **All console diagnostics in this project are therefore written as self-contained pure-DOM snippets** that re-implement the relevant logic inline, rather than calling the extension's functions. (See Appendix B.)

---

## 4. A taxonomy of Facebook posts

Different post types render differently and break scrapers in different ways. This is the catalogue we built up empirically. "Has body anchor?" = does it carry a `data-ad-*` message element. "Has own permalink?" = is there a usable post URL anywhere in the card's DOM.

| Post type | Body anchor? | Own permalink in DOM? | Notes / how we handle it |
|---|---|---|---|
| **Standard text post** | Usually yes | Often, via timestamp link | The easy case. Body anchor → text; timestamp link → permalink. |
| **Text post, no body anchor** | No | Sometimes | ~75% of posts on some groups. Body is a plain `div[dir="auto"]`. Caught structurally (feed child), text via largest non-comment `dir=auto`. |
| **Background / colour post** (text on a coloured card) | Often no | Frequently **no** | Permalink built on click only → hash-fallback ID, disabled Open button. |
| **Photo / album post** | Varies | Via `?set=pcb.` / `?set=gm.` image links | The numeric ID after `pcb.`/`gm.` *is* the post ID. Beware reused branding images carrying an *old* post's ID (the "pcb shadowing" trap). |
| **Shared-link post** | Yes, but anchor text is the URL | Yes | The body anchor's text is the shared URL, not prose. We detect a bare-URL body and fall back to the real `dir=auto` prose. |
| **Anonymous post** (group "anonymous participant" feature) | Yes | **No** (no author link either) | No author, no permalink. Captured with a **full-text hash** ID so two different anonymous posts can't collide. Disabled Open button. |
| **Post with comments, no own permalink** | Varies | Recoverable | The parent post ID can be read from the comments' `/posts/<id>?comment_id=` links (read-only). |
| **Marketplace cross-post (with prose)** | Yes | `/commerce/listing/<id>` | A written post that *also* carries a listing attachment. Treated as a normal text post; the listing just provides the ID/permalink. |
| **Pure Marketplace listing card** (no prose) | **No** | `/commerce/listing/<id>` | Title/price in plain `<div>`s amid "Facebook" decoy. Detected on the commerce link; text via `pickMarketplaceText`. |
| **Comment** (not a post!) | No | `/posts/<id>?comment_id=…` | Must be *excluded* from detection. Lives inside a `role="article"` within its post's card. Several bugs came from mistaking these for posts. |
| **Recommended Reel / suggested content** | No | `/videos/`, `/reel/`, `/share/v/` | Injected by the algorithm. Deliberately *not* detected (we exclude video URL shapes) to avoid polluting the dataset. |

### Permalink URL shapes (post-ID derivation)

Facebook encodes the post ID in many URL formats depending on surface. The extractor recognises, in priority order:

| URL shape | Where it appears | ID derivation |
|---|---|---|
| `/groups/GID/posts/PID/` | individual group pages | segment after `/posts/` |
| `/groups/GID/permalink/PID/` | older group format | segment after `/permalink/` |
| `?story_fbid=PID` | profile / home feed | `story_fbid` param |
| `?multi_permalinks=PID` | aggregated `/groups/feed/` | `multi_permalinks` param |
| `?set=pcb.PID` | photo links on `/groups/feed/` | numeric after `pcb.` |
| `?set=gm.PID&idorvanity=GID` | photo links on home feed | numeric after `gm.`; `idorvanity` gives the group |
| `/commerce/listing/PID` | Marketplace | segment after `/commerce/listing/`, prefixed `cl_` |
| `/marketplace/item/PID` | Marketplace alt | segment after `/marketplace/item/`, prefixed `mp_` |
| *(comment recovery)* | post w/ comments, no own link | mode of comments' `/posts/<id>?comment_id=` hrefs |
| *(hash fallback)* | anonymous / background / commentless | `h_<hash(author + '\|' + full text)>` |

---

## 5. The scraping pipeline, end to end

```
Facebook feed (DOM)
   │
   │  content/scroller.js  — auto-scroll + MutationObserver + DETECTION (3 paths)
   ▼
onNewPost(cardElement)
   │
   │  content/extractor.js — EXTRACTION (author, text, permalink, images, group)
   ▼
post object  ──►  content/content.js  ──►  chrome.runtime.sendMessage(SAVE_POST)
                                              │
                                              ▼
                                      background.js (service worker)
                                              │  dedup + regex classify
                                              ▼
                                          IndexedDB  ──►  dashboard
```

Why this split exists (the architectural constraint): **content scripts run at the `facebook.com` origin**, so their `indexedDB` would be *Facebook's* storage, not the extension's. The **service worker** runs at the extension origin and owns the real database, shared with the dashboard. So content scripts can only *read the page and send messages*; all storage happens in the worker. This report focuses on the first two boxes — `scroller.js` (detection) and `extractor.js` (extraction).

### The role of each file (scraping-relevant)

- **`content/scroller.js`** — owns *detection*. Auto-scrolls the window, runs a `MutationObserver` so newly rendered posts are processed as they appear, expands "See more" buttons, and decides *what counts as a post*. Hands each post card to a callback exactly once.
- **`content/extractor.js`** — owns *extraction*. Given one post card element, pulls out author, text, permalink/post-ID, images, and group. Pure DOM reading; returns a plain object.
- **`content/content.js`** — the orchestrator. Receives popup commands (start/stop/continue), wires the scroller's `onNewPost` to the extractor, sends results to the worker, and tracks session stats. Also hosts the `TLV_DEBUG` instrumentation.

---

## 6. Detection: the three paths

Detection lives in `scroller.js → processVisible()`, which runs on every `MutationObserver` tick. It dispatches each post card to the extractor **exactly once** (tracked by `WeakSet`s). It uses three layered paths because no single signal works on every surface.

### Path 1 — `role="feed"` children (primary)

Each **direct child** of a `role="feed"` container is treated as one post. A child counts as a post (`looksLikePost`) if it has:
- a `data-ad-*` body anchor, **or**
- a `/commerce/listing/` or `/marketplace/item/` link, **or**
- a non-comment `div[dir="auto"]` of ≥ 40 characters.

The 40-char floor skips the "Sort feed by Recent activity" header (~34 chars) and empty virtualisation placeholders (0 chars).

**Why this path is good:** it is *comment-immune* (a comment is a `role="article"` *inside* a child, never a child itself) and *anchor-independent* (it doesn't require `data-ad-*`). One child = one post, so card boundaries don't drift.

**Why it's not enough:** the home feed has no `role="feed"` (§3.6), so this path never fires there.

### Path 2 — body anchors outside any `role="feed"` (legacy fallback)

Scans for `data-ad-*` body anchors that are **not** inside a `role="feed"` (those are Path 1's job). For each, walks up to a card container. This is the original detection strategy, retained as a safety net for surfaces without a feed container. Comment-immune because comments have no `data-ad-*` anchor.

### Path 3 — commerce links (pure Marketplace cards)

Scans for `/commerce/listing/` and `/marketplace/item/` links. For each, bounds the card by **author count** (walk up while the scope holds ≤ 1 author link; a 2nd author means we've reached a neighbouring post). Skipped if the card already has a body anchor (then it's a written post handled by Path 1/2) — so this path *only* catches the bodyless listing cards Paths 1–2 can't see.

**Deliberately excluded from all detection:** `/videos/`, `/reel/`, `/share/v/` link shapes — these are "Recommended Reels" the algorithm injects, not posts we want.

---

## 7. Extraction and its guardrails

Given one card, `extractor.js → extractPost(cardEl, pageGroupId, pageGroupName)` produces the post object. Each field has a guardrail learned from a real bug.

### 7.1 Text

1. Prefer the `data-ad-*` body anchor's text.
2. If that's empty **or is just a bare URL** (a shared-link preview), fall back to the largest `div[dir="auto"]` block **that is not inside a `role="article"`** (i.e. not a comment).
3. If still empty, try `pickMarketplaceText` (pure listing card).

The "exclude `role="article"`" scoping is critical: without it, a post with a long comment grabs the *comment* as its body (§8.2).

### 7.2 Author (`pickAuthorLink`)

The author link is `a[href*="/user/"]`. Facebook renders this **2–3 times** per header: an avatar-wrapper link with **empty text**, plus the name link. A naïve `querySelector` grabs the empty one → blank author. Fix: take the first non-comment `/user/` link **that actually has text**; fall back to the first non-comment link so the profile URL is never lost. Anonymous posts have *no* author link at all → author stays blank (expected).

### 7.3 Permalink & post-ID — with the neighbour-ID-theft guard

`pickPermalink` looks for a usable post URL inside the card; if none, it **walks up** the DOM. That walk-up is bounded **twice**, and both bounds exist because of real data-loss bugs:

1. **Never ascend into the `role="feed"` container.** On feed surfaces, a card's parent *is* the feed, which contains every post — so an unbounded walk-up grabs the *first* post's link and stamps it on everyone.
2. **Stop when a 2nd author link enters scope.** On the home feed (no `role="feed"`), bound #1 can't fire, so this author-count bound is what stops a permalink-less post from climbing into an adjacent card and **stealing its ID**. Confirmed live: an anonymous sublet stole a furniture listing's `cl_` ID and overwrote it; a real apartment was lost.

If a usable permalink is found, the ID is derived per the table in §4 and a canonical URL is built (comment params stripped). If not:

- **Comment-link recovery** (`pickPostIdFromComments`): read the parent post ID from the *mode* of the card's comment timestamp links (`/posts/<id>?comment_id=…`). Read-only — no clicking. This is the user's "the comment button reveals the URL" insight, done without navigation.
- **Full-text hash fallback**: `post_id = h_<hash(author + '|' + full normalised text)>`. The full text (not the first 200 chars) matters because anonymous posts share a blank author — two different anonymous posts with the same 200-char prefix would otherwise hash identically and overwrite each other. Mirrors `lib/dedup.js::normalise`. These posts get a **disabled Open button** (no URL exists to store).

### 7.4 Pure-Marketplace text (`pickMarketplaceText`)

For a bodyless listing card: from the commerce link, walk up to the largest ancestor that still **excludes the author header** (stop at the first ancestor containing a `/user/` link). Within that clean scope, collect each `<div>`'s **direct text nodes**, skipping the `"Facebook"` decoy token and UI chrome ("Message", "See more", etc.). This reliably yields `"₪10,500תל אביב - יפו, TA · דירת 3 חדרים …"`.

### 7.5 Images

CDN images (`img[src*="scontent"]`), **excluding any inside a `role="article"`** so commenter avatars and comment photos don't pollute the post's images (which would also corrupt the dedup hash that keys on the first image). Safe degradation: if filtering leaves none, keep all matches.

### 7.6 Timestamp (`findPostedAt` / `parseRelativeTime`)

Identifies the post's timestamp by **text**, not href — it scans the card's links for one whose label parses as a relative time ("4h", "3 days ago", "yesterday", absolute dates). Two hardening rules came from the "1825-day" bug (§8.6): a label longer than 48 chars is rejected (a shared-link preview that merely *contains* a time-like token isn't a timestamp), and the number must not be glued to letters/digits or sit right after `/` or `.` (so `5y` inside a URL like `bb5y.com` is not read as "5 years").

---

## 8. The diagnostic journey: issues, hypotheses, tests, solutions

This is the heart of the report — the actual sequence of problems and how each was resolved. The throughline is a **method**, mandated by the project's working agreement: *diagnostics first, code second.* Before any non-trivial change we wrote a console probe that **counted** the relevant DOM facts, ran it against the live page, and only changed code once the data confirmed both the diagnosis and that the proposed fix would work. This section is organised problem-by-problem; each shows the symptom, the hypotheses, the test, the verdict, and the fix.

### 8.1 Root cause #1 — posts silently missing

**Symptom.** Whole posts never reached the dashboard. Confirmed genuinely absent from storage (verified via JSON export with all filters off). The misses were **clustered by post type**, not by scroll depth — a crucial clue.

**Hypotheses considered:**
- H1: virtualization / scroll timing dropping posts. *Rejected* — clustering by type, not depth, points at the selector, not timing.
- H2: posts lacking a `data-ad-*` body anchor are never iterated. *Candidate.*
- H5: the extractor returns `null` and eats them. *Rejected* — the extractor's only null path needs *both* text and author missing; posts were dying earlier, in the scroller.

**Test.** A console set-difference: count cards reachable via permalink-shaped links vs. cards reachable via body anchors. Result: a large cluster (~75% on the tested group) had a permalink but **no** body anchor.

**Verdict / Root Cause #1.** Detection keyed *only* on `data-ad-*` body anchors. Posts whose body renders as a plain `div[dir="auto"]` were never iterated.

**First (wrong) fix and its lesson.** The initial fix added a detection path that scanned for **permalink-shaped links** (`/posts/`, `/permalink/`, …) and walked each up to a card. It seemed reasonable. It was wrong — see §8.2 — and the lesson is that *a plausible fix shipped without a confirming diagnostic is how you get a worse bug.*

### 8.2 The comment-capture regression (and the discovery that reframed everything)

**Symptom.** After the permalink-link detector shipped, the dashboard filled with **comments instead of posts**.

**The smoking gun, in our own code.** The extractor's permalink selector already excluded comment links:
```
a[href*="/posts/"]:not([href*="comment_id"])
```
…but the new *scroller* detector did **not** have that guard. A comment's timestamp link is `/groups/GID/posts/PID/?comment_id=…` — it matches `a[href*="/posts/"]`. On a page with comments expanded, comment links vastly outnumber post links, so the detector iterated mostly comments.

**The diagnostic that reframed the whole project.** Rather than just patch the guard, we dumped the live DOM structure. The output overturned earlier assumptions:
- The visible "post" links were *all* comments (`comment_id` present); there were **zero** clean post permalinks in the card DOM.
- There **was** a `role="feed"` container whose **direct children were the posts**, with comments nested as `role="article"` *inside* them.

This is the pivot. It meant the right detector wasn't "find permalink links" at all — it was **"iterate the feed's children."** That is structural, comment-immune, and anchor-independent.

**Further probes** (each run on the live feed, counting) confirmed the model:
- For each feed-child post, the body lived **outside** any `role="article"`; comments lived **inside** them. So excluding `role="article"` cleanly separates post body from comments.
- The largest *non-comment* `div[dir="auto"]` was the real body in every sampled post — including one case where a 121-char **comment** was longer than the 84-char post body (proving that *not* excluding comments would grab the wrong text).
- The author link appeared 2–3× per header, the first instance being an **empty avatar-wrapper** link (→ blank author bug, §7.2).

**Solution.** Rewrote detection to **Path 1 (feed children)**, kept the legacy body-anchor scan as **Path 2** for non-feed surfaces, and deleted the permalink-link detector entirely. Hardened extraction to exclude `role="article"` for text, author, and images.

### 8.3 The 50→16 collapse — neighbour-ID theft

**Symptom.** A live scrape reported "45 scanned" but only 16–21 distinct rows landed. Posts were being lost *after* detection.

**The instrumentation.** Rather than guess, we added a debug trace (`TLV_DEBUG`) to the *real* save pipeline: log every save as `NEW` / `OVERWRITE` / `DUP-HASH` with its `post_id` and a text snippet, plus a stop summary. This is the log report idea, and it caught the bug red-handed:

```
NEW         10164519536800943  "יוקר המחיה…"      (post A)
OVERWRITE×2 10164519536800943  "בר שמשדר…"        (DIFFERENT post B, same id!)
OVERWRITE×3 10164519536800943  "ערב משחקים…"      (DIFFERENT post C, same id!)
… ×12 different posts, one id
```

**Verdict.** Twelve different posts received **one** ID and overwrote each other. With feed-child detection, a card's parent *is* the `role="feed"`, which contains every post. When a card had no permalink of its own, the extractor's walk-up climbed into the feed and grabbed the **first post's** `/posts/` link — stamping that neighbour's ID on everyone.

**Confirming test.** A probe compared the current unbounded walk-up against a proposed bounded one across all feed children: current → 1 distinct ID for 15 posts; proposed (stop before re-entering the feed) → 15 distinct IDs, 0 collisions.

**Solution.** Bound the walk-up so it never ascends into the `role="feed"` container. Permalink-less posts then correctly fall through to the hash-fallback ID instead of stealing a neighbour's.

### 8.4 Comment-link permalink recovery

**Observation (user).** Clicking a post's comment button reveals the post's permalink in the URL bar — so the ID *is* obtainable.

**Insight.** We don't need to click. A rendered comment's timestamp href already contains the **parent** post's ID: `/groups/GID/posts/PID/?comment_id=…`. Every comment on a post points at that same `PID`, so the **mode** of `/posts/<id>` across a card's comment links is unambiguously the post's own ID.

**Test.** A probe took the mode-of-`/posts/<id>` per card: **0 collisions across 81 posts** — when an ID was present, it was unique to that post.

**Solution.** `pickPostIdFromComments` — read-only recovery that runs before the hash fallback, rebuilding the canonical URL with the known numeric group ID (which also sidesteps the slug-vs-numeric rejection that had been disabling Open buttons).

**Boundary of the technique.** It only works if at least one comment is *rendered*. Zero-comment posts and posts with collapsed comments expose no `comment_id` link → still hash-fallback, disabled Open button. Confirmed by probe (the failing cases all had `comment_id present = false`).

### 8.5 The "scanned ≫ saved, even online" puzzle — virtualization, not loss

**Symptom.** The user noted the "re-scraped" count stayed high even with the network on, and a specific post wouldn't reappear.

**What the data showed.** A console probe that scrolled top→bottom and *counted distinct posts* found **62 distinct posts, dispatched 62 times, 0 re-dispatch** — detection was complete. The dashboard's lower number was a *different* run (offline) plus the genuine post_id collisions of §8.3, not a detection miss.

**Verdict.** Two separable effects were being conflated: (a) **virtualization** recycling elements inflates the "re-scraped" counter (harmless — same ID overwrites), and (b) scrapes stopping early at the time/dup limit before reaching the feed bottom (`STOPPED EARLY` in the debug summary). Neither is a capture bug. Going **offline** to freeze the feed actively broke hydration and *caused* misses — the opposite of the intent.

**Takeaway.** "Scanned" counts save-attempts, not distinct posts. The debug summary's `distinctIds` and `REACHED BOTTOM / STOPPED EARLY` lines are the honest metrics.

### 8.6 The "posted 1825 days ago" bug

**Symptom.** A post from 4 hours ago showed as posted ~1825 days (≈ 5 years) ago.

**Test.** A probe replicated `findPostedAt` + `parseRelativeTime` and printed the winning label for each mis-dated post. The winner: `"BDeRbb5y.comStevenמסיבה לטיני…"` — a shared-link preview whose URL contained `bb5y`. The year regex `(\d+)\s*y…` matched the `5y` inside `bb5y` → "5 years."

**Solution (validated in a Node test battery before shipping).** Two guards in `parseRelativeTime`: reject labels longer than 48 chars (real timestamps are short), and require the number not be glued to a letter/digit or preceded by `/` or `.` (lookbehind `(?<![a-z0-9./])`). The battery confirmed all real formats still parse ("4h", "2 days", "yesterday", standalone "5y") while `bb5y`, `url2d`, `bit.ly/3h` no longer false-match.

### 8.7 Pure Marketplace listing cards

**Symptom (user).** Marketplace listings with *no written text* weren't captured (e.g. a ₪10,500 apartment posted purely as a Marketplace listing).

**Decision first.** A probe characterised the Marketplace cards on the feed: on the user's surface, **5/5 commerce cards were apartments**, not furniture — so the "noise" worry was unfounded and capture was worth it.

**Two-part diagnosis.** A probe on the missed card showed `hasDataAd=false`, `largest dir=auto = 0`, and `linkText = ""` — every text channel the extractor knew about was empty. A deeper probe revealed why: the `div[dir="auto"]` blocks were **52× "Facebook" decoy** (§3.5); the real title/price sat in plain `<div>`s at a DOM depth that excluded the author header.

**Solution.** Detection **Path 3** (commerce link, author-count-bounded card) + extraction `pickMarketplaceText` (read plain-`div` direct text, drop the decoy). Validated by probe: the missed card now yields `cl_26781735978149210` with text `"₪10,500 · … דירת 3 חדרים …"`, 0 collisions.

### 8.8 The home feed has no `role="feed"` — Path 3 had to be surface-agnostic

**Symptom.** On `/?filter=all&sk=h_chr`, the just-built Marketplace capture still missed the pure listing card, and a separate collision (a sublet overwriting a furniture listing) appeared.

**Test.** A probe reported **`role=feed containers: 0`** on this surface. So Path 1 never runs here; everything depends on Paths 2 and 3, and the `role="feed"`-based walk-up guard (§8.3) never fires.

**Solution.** Two things: (a) Path 3's `getCardFromCommerce` bounds by **author count** (surface-agnostic), not by `role="feed"`; (b) the extractor's walk-up gained a **second** bound — stop when a 2nd author link enters scope — so the neighbour-ID-theft fix also protects the no-`role=feed` home feed. A before/after probe showed the author-bound is a *pure no-op on settled DOM except where it prevents a steal* (1 collision → 0, every other ID unchanged).

### 8.9 Anonymous-post hash collision

**Symptom (user).** Anonymous posts appear without a working link.

**Verdict.** Correct, expected behaviour — anonymous posts have no author link and no permalink anywhere in the DOM (probe: `directPL=(none)` even with an unbounded walk-up). Same id-less family as background/commentless posts. Not a bug.

**The latent bug it exposed.** Anonymous posts all share a *blank* author, so the old hash-fallback (`author + text.slice(0,200)`) could merge two *different* anonymous posts that share a 200-char prefix (e.g. templated agency "דרושה עזרה…" posts whose only distinguishing detail is a phone number past char 200) — silently losing one.

**Solution (validated in a Node battery before shipping).** Hash the **full** normalised text instead of the first 200 chars. This can only ever *split* a false merge, never wrongly merge identical content. Mirrors `lib/dedup.js::normalise`, which already depends on cross-scrape text stability, so it introduces no new assumption. Battery confirmed: old hash collides on a shared prefix; new hash splits; whitespace drift stays stable; identical cross-posts still collapse to one row.

---

## 9. Limitations (read this before trusting the data)

These are inherent to scraping Facebook this way; most are *known and accepted*, not bugs.

1. **Open button disabled on "click-only" posts.** Anonymous posts, background/colour posts, and posts with zero or collapsed comments expose **no permalink anywhere in the DOM** — Facebook constructs the URL only when you click. These posts are *captured with full text*, but the Open button is disabled. The only way to get their URL is a real click (a click-based resolver is a possible future enhancement, deliberately not built — it would navigate the page and risk looking like automation).

2. **`posted_at` can be wrong for scrambled-timestamp posts.** Some posts' timestamp text is CSS-decoy (§3.5); `parseRelativeTime` can't read it and the date falls back to "now." The 48-char/lookbehind guards prevent the *worst* failure (a URL fragment parsing as "5 years ago"), but they can't recover an unreadable timestamp.

3. **Virtualization means coverage depends on scroll behaviour.** Posts must hydrate before they're read. Scroll too fast, or go offline, and posts are missed. Scrape **online, from the top, at the built-in pace**, and let it run to the bottom (watch for `REACHED BOTTOM` vs `STOPPED EARLY` in the debug log).

4. **Time/duplicate stop limits can end a scrape before the feed bottom.** The default 5-minute / 30-consecutive-duplicate limits exist to stop runaway scrolling. On a long feed they can stop early; raise them for full coverage.

5. **The home feed (`/?filter=all&sk=h_chr`) is a structurally distinct surface.** No `role="feed"`, no `FeedUnit` pagelets. Detection there rests entirely on Paths 2–3 and author-count bounding. Any future Facebook change to this surface's structure is the highest-risk breakage point, and it must be tested *specifically* — a green test on a `/groups/<id>/` page does not imply the home feed works.

6. **Selectors are anchored on `role`/`aria`/`data-*`/URL shapes, which Facebook still changes occasionally.** When (not if) Facebook renames `data-ad-rendering-role` or restructures cards, detection/extraction will degrade. The probes in Appendix B are the first-response toolkit: run them to see *what changed* before editing code.

7. **CSS-scramble / decoy text is an active countermeasure.** It currently affects pure-Marketplace titles and some timestamps. Facebook can extend it. The `pickMarketplaceText` approach (plain-`div` direct text, drop "Facebook") is a point-in-time defence, not a guarantee.

8. **Pure-Marketplace `posted_at` and author may be weak.** These cards sometimes lack a clean author (one was observed storing a share-URL as the author name) and a reliable timestamp. The *listing* data (title, price, ID, permalink) is solid; the social metadata is best-effort.

9. **No protection against Facebook rate-limiting / detection.** The scraper scrolls at randomised 4–7s intervals to look human, but heavy use could trigger Facebook's automation defences. This is out of scope and unmitigated.

10. **Comments are only as recoverable as they are rendered.** Comment-link ID recovery needs at least one comment visible; collapsed comment threads yield nothing.

---

## 10. A guide for future developers

### 10.1 The cardinal rule: diagnose before you code

Every durable fix in this project followed the same loop, and every regression came from skipping it:

1. **Form a hypothesis** about what the DOM is doing.
2. **Write a console probe that counts** the relevant facts (not one that just eyeballs one element). See Appendix B.
3. **Run it on the live page**, on the surface that matters (the home feed, not just a group page).
4. **Only change code if the data confirms** both the diagnosis *and* that the fix will work. For pure functions (`parseRelativeTime`, the hash), prove it in a Node test battery first.
5. **Re-run a probe after the change** to confirm the fix and check for regressions.

This is slower per step and far faster overall. The permalink-link detector (§8.2) and an early "offline freeze" idea (§8.5) are the cautionary tales — both plausible, both wrong, both caught only by data.

### 10.2 The isolated-world trap (don't lose an afternoon to it)

Console probes **cannot** call `window.TLVExtractor` / `window.TLVScroller` — those live in the content script's isolated world (§3.8). Write probes as **self-contained pure-DOM snippets** that re-implement the logic inline. If a probe prints `undefined` for an extension global, that's the trap, not a broken extension.

### 10.3 How to read the debug instrumentation

`content/content.js` has a `TLV_DEBUG` block (currently **on** in main). During a scrape, the console shows:
- Per save: `[TLV-DBG NEW|OVERWRITE|DUP-HASH] {id, hashFallback, sec, body}`.
- On stop: a summary with `saveCalls`, `distinctIds` (split into hash-fallback vs real-permalink), `totalOverwrites`, and `scrollY/maxY → REACHED BOTTOM | STOPPED EARLY`.

How to interpret:
- `distinctIds ≈ saveCalls` → healthy; little churn.
- Many `OVERWRITE` lines **with different bodies under one ID** → ID-theft/collision (the §8.3 class of bug). Different bodies = real bug; same body = harmless virtualization re-dispatch.
- `STOPPED EARLY` on a finite group page → raise the time/dup limit for full coverage. (`STOPPED EARLY` on the infinite home feed is normal.)

Turn it off by setting `TLV_DEBUG = false` (or strip the block) once diagnosing is done.

### 10.4 How to add support for a new surface or post type

1. Probe the surface: does it have `role="feed"`? `data-pagelet="FeedUnit_*"`? `role="article"` (comments)? What URL shapes appear? (Appendix B has a structure-survey probe.)
2. If it has `role="feed"` → Path 1 likely already works; verify `looksLikePost` accepts the new card.
3. If not → identify the repeating post-container signal (author-count bounding has worked on two surfaces) and extend Path 2/3.
4. For a new post *type*, slot it into the §4 taxonomy: does it have a body anchor? an own permalink? Decide the ID source (permalink → comment recovery → hash) and the text source (anchor → `dir=auto` → marketplace decoy).
5. **Test on the home feed specifically** before declaring victory.

### 10.5 Things that will break, and where to look first

- **Posts suddenly missing** → detection. Check `role="feed"` still exists and `looksLikePost`'s thresholds; run the detection probe.
- **Comments showing as posts** → a detector matched comment links/articles; check the `role="article"` and `comment_id` exclusions.
- **Wrong/duplicate IDs, posts overwriting** → the walk-up bounds in `extractPost` (feed boundary + author-count). Run the collision probe.
- **Blank author** → the avatar-wrapper link; check `pickAuthorLink`.
- **Garbage text ("Facebook")** → decoy scramble reached a new card type; extend `pickMarketplaceText`'s scope/skip rules.
- **Crazy dates** → `parseRelativeTime`; a new token shape is matching. Re-run the date probe.

---

## 11. A guide for non-engineers

**What does this thing do?** It reads apartment-rental posts off your Facebook groups automatically, so you can browse them in a clean, filterable list instead of endlessly scrolling Facebook.

**How does it "read" Facebook?** Exactly like you do — by looking at the page in your browser. It doesn't log into any Facebook system or use a secret back door. It scrolls the feed (slowly, like a person), looks at each post that appears, and copies the useful bits: who posted, the text, the price, the photos, and a link back to the original. Everything stays on your computer; nothing is sent anywhere.

**Why was this hard?** Three reasons, in plain terms:

1. **Facebook's page is built for eyes, not robots.** The underlying code has almost no helpful labels saying "this is a post" or "this is the price." We had to infer it from structure and patterns — like recognising a letter by its shape when the envelope has no address.
2. **Facebook hides posts to stay fast.** As you scroll, it throws away posts that scroll off-screen and only keeps a handful visible. So our tool has to catch each post during the brief moment it's actually on the page. (This is also why scraping with the internet off doesn't work — Facebook needs the connection to redraw posts.)
3. **Some posts are deliberately obfuscated.** A few post types fill the page with the decoy word "Facebook" hundreds of times to confuse copying tools, hiding the real text elsewhere. We had to find where the real text was hiding.

**The kinds of posts, and how well we handle them:**
- Normal text posts with a price → **captured perfectly**, with a working "Open" link.
- Posts with photos, or shared in many groups at once → **captured**, links built from the photo or listing.
- Marketplace listings (the "for sale/rent" cards) → **captured**, including ones with no written description.
- **Anonymous** posts, plain coloured-background posts, and posts nobody has commented on → **captured with all their text, but no clickable link.** This isn't a flaw we can easily fix: Facebook simply doesn't put a link on the page for these until you personally click them.

**What it can't promise:**
- A working "Open" link for every post (see above).
- A correct "posted X hours ago" for every post — a few have scrambled timestamps and show as "just now."
- Every single post if you scroll too fast, scrape with the internet off, or stop it early.
- That it'll keep working forever — when Facebook redesigns its pages, parts will need fixing.

**How to get the best results:** open your chronological groups feed, start at the **top**, keep the internet **on**, press start, and let it scroll to the bottom on its own.

---

## Appendix A — selector reference

| Purpose | Selector | Notes |
|---|---|---|
| Post body anchor | `[data-ad-preview="message"]`, `[data-ad-comet-preview="message"]`, `[data-ad-rendering-role="story_message"]` | Not present on all posts. |
| Comment subtree (to **exclude**) | `[role="article"]` | On scraped surfaces, wraps comments, not the post. |
| Feed container (Path 1) | `[role="feed"]` | Absent on the home feed. |
| Author link | `a[href*="/user/"]` | Rendered 2–3×; first is an empty avatar wrapper. |
| Body text fallback | `div[dir="auto"]` | Use largest **non-`role=article`** block. |
| Commerce / Marketplace | `a[href*="/commerce/listing/"]`, `a[href*="/marketplace/item/"]` | Path 3 detection + `cl_`/`mp_` IDs. |
| Permalink shapes | `/posts/`, `/permalink/`, `story_fbid=`, `multi_permalinks=`, `set=pcb.`, `set=gm.`, `/share/p/` | Comment variants carry `comment_id` — exclude for the *primary* permalink. |
| Reels/video (to **exclude** from detection) | `/videos/`, `/reel/`, `/share/v/` | Algorithmic injections, not posts. |

## Appendix B — reusable console probes

These run in the DevTools console **on the Facebook tab** (top frame). They are pure-DOM (no extension globals — see §3.8). Adapt freely.

**B1 — Surface structure survey** (what am I dealing with?):
```js
(() => {
  console.log('role=feed:', document.querySelectorAll('[role="feed"]').length,
              '| role=article:', document.querySelectorAll('[role="article"]').length,
              '| FeedUnit pagelets:', document.querySelectorAll('[data-pagelet^="FeedUnit"]').length);
  const pg={}; document.querySelectorAll('[data-pagelet]').forEach(e=>{const k=e.getAttribute('data-pagelet').replace(/\d+/g,'#');pg[k]=(pg[k]||0)+1;});
  console.log('data-pagelet survey:', pg);
  console.log('body anchors:', document.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"]').length,
              '| commerce links:', document.querySelectorAll('a[href*="/commerce/listing/"],a[href*="/marketplace/item/"]').length);
})();
```

**B2 — Detection count** (how many posts would Path 1 see, top→bottom; auto-scrolls):
```js
(() => {
  const PT='[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"]';
  const clean=s=>(s||'').replace(/\s+/g,' ').trim(), inArt=el=>!!el.closest('[role="article"]');
  const looksLikePost=el=>{if(el.querySelector(PT))return true;if(el.querySelector('a[href*="/commerce/listing/"]'))return true;for(const d of el.querySelectorAll('div[dir="auto"]')){if(inArt(d))continue;if(clean(d.innerText).length>=40)return true;}return false;};
  const seen=new WeakSet(); let n=0;
  const scan=()=>document.querySelectorAll('[role="feed"]').forEach(f=>[...f.children].forEach(c=>{if(seen.has(c)||!looksLikePost(c))return;seen.add(c);n++;}));
  const mo=new MutationObserver(scan); mo.observe(document.body,{childList:true,subtree:true}); scan();
  let t=0; const iv=setInterval(()=>{window.scrollBy({top:innerHeight*0.8}); if(++t>=60){clearInterval(iv);mo.disconnect();console.log('distinct feed-child posts:',n);}},2000);
})();
```

**B3 — Collision check** (do distinct posts get distinct IDs?): re-implement `derivePostId` inline, walk each card's links, and report any ID mapped to >1 distinct body. (See §8.3/§8.8 for the full version used in development.)

## Appendix C — glossary

- **DOM** — the live tree of elements the browser renders; what a scraper reads.
- **Content script** — extension code injected into the page; shares the DOM but not the page's JS variables (the *isolated world*).
- **Service worker** — the extension's background process; owns the database.
- **Virtualization** — Facebook keeping only on-screen posts "alive" and destroying the rest to save memory.
- **Body anchor** — a `data-ad-*` element marking a post's written body. Present on some posts only.
- **Permalink** — a post's canonical URL. Not present in the DOM for all post types.
- **`role="feed"` / `role="article"`** — ARIA roles; feed = post container, article = (here) a comment.
- **Hash fallback** — when no permalink exists, the post ID is a hash of author + full text, ensuring stable identity across scrapes.
- **Neighbour-ID theft** — a permalink-less post's DOM walk-up grabbing an adjacent post's ID and overwriting it; fixed by bounding the walk-up.
- **Decoy text** — repeated "Facebook" filler in `div[dir="auto"]` blocks on some cards; an anti-scraping measure.

---

*This report documents the scraping subsystem as of v1.2.0. The debug instrumentation (`TLV_DEBUG` in `content/content.js`) is retained in `main` and is the recommended first tool when investigating any future capture issue.*
