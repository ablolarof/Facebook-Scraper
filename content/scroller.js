// content/scroller.js — Auto-scroll with MutationObserver
//
// === Detection v5: role="feed" child units (2026-05-29) =========================
// Posts are detected as DIRECT CHILDREN of a role="feed" container — the unit
// Facebook uses for one post. This is:
//   • comment-immune — a comment is nested INSIDE its post's child, so it can
//     never be mistaken for a separate post. (The v4 permalink-union detector
//     keyed on /posts/ links, which ALSO match comment timestamps
//     /posts/PID/?comment_id=… → it captured comments. That path is removed.)
//   • anchor-independent — it does not require a data-ad-* body element, so posts
//     whose body is a plain div[dir="auto"] are still caught.
//   • deterministic — one child = one post, so card boundaries don't drift.
// A legacy body-anchor path (Path 2) still covers any surface with no role="feed"
// (or posts outside one), so behaviour is never worse than the previous build.
// Validated on the live DOM of group 327483250942 (secrettelaviv).
// ================================================================================
//
// Loaded as a plain (non-module) script before content.js.
// Exposes window.TLVScroller = { startScroll, stopScroll }.

window.TLVScroller = (function () {

  var _scrolling      = false;
  var _timerId        = null;
  var _observer       = null;
  var _seenTexts      = new WeakSet();  // body-anchor elements already handled (Path 2)
  var _seenContainers = new WeakSet();  // post containers already dispatched

  // Post body container Facebook renders on text posts.
  //   data-ad-preview="message"        — legacy renderer (individual group pages)
  //   data-ad-comet-preview="message"  — Comet renderer (same pages, newer build)
  //   data-ad-rendering-role="story_message" — aggregated /groups/feed/ renderer
  // Only ~25% of posts carry one of these; the rest render the body as a plain
  // div[dir="auto"]. Detection does NOT depend on this selector (Path 1 uses the
  // feed-child structure). It is used to (a) quickly recognise a feed child as a
  // post and (b) drive the legacy Path-2 walk-up.
  var POST_TEXT_SEL = [
    '[data-ad-preview="message"]',
    '[data-ad-comet-preview="message"]',
    '[data-ad-rendering-role="story_message"]' +
      ':not(:has([data-ad-preview="message"],[data-ad-comet-preview="message"]))',
  ].join(', ');

  // Post permalink link — used ONLY by the legacy Path-2 container walk-up.
  var PERMALINK_LINK_SEL = [
    'a[href*="/posts/"]',
    'a[href*="/permalink/"]',
    'a[href*="story_fbid="]',
    'a[href*="/share/p/"]',
    'a[href*="/share/v/"]',
    'a[href*="/videos/"]',
    'a[href*="/commerce/listing/"]',
    'a[href*="/marketplace/item/"]',
    'a[href*="multi_permalinks="]',
    'a[href*="set=pcb."]',
    'a[href*="set=gm."]',
  ].join(', ');

  // Comments render inside role="article" subtrees within a post's feed-child.
  // The post body/header is NEVER inside one (verified on group 327483250942),
  // so anything under a role="article" is a comment and must not be treated as
  // post content during detection or extraction.
  var COMMENT_SEL = '[role="article"]';

  // A feed child with no body anchor still counts as a post when it has a
  // non-comment dir=auto block at least this long. Tuned so the "sort group feed
  // by …" header (len ~34) and empty virtualisation placeholders (len 0) are
  // skipped, while genuine short posts (≥ ~40 chars) are kept.
  var MIN_POST_TEXT_LEN = 40;

  // How many DOM levels above an element the legacy Path-2 walk-up searches.
  var MAX_WALK_UP = 20;

  // Reshared cards nest two posts. Path-2 allows up to 2 post-text descendants.
  var MAX_POST_TEXT_PER_CARD = 2;

  // ── Core detection ────────────────────────────────────────────────────────

  /**
   * Path 2 (legacy): find the post-card container for a body-anchor element.
   * Used only for posts that are NOT inside a role="feed".
   */
  function getPostContainer(textEl) {
    var article = textEl.closest('[role="article"]');
    if (article) return article;

    var current    = textEl.parentElement;
    var lastSingle = null;
    for (var i = 0; i < MAX_WALK_UP && current && current !== document.body; i++) {
      var postTextCount = current.querySelectorAll(POST_TEXT_SEL).length;
      if (postTextCount === 1) lastSingle = current;
      if (postTextCount > MAX_POST_TEXT_PER_CARD) return lastSingle;
      if (current.querySelector(PERMALINK_LINK_SEL)) {
        return postTextCount === 1 ? current : lastSingle;
      }
      current = current.parentElement;
    }
    return lastSingle;
  }

  /**
   * Path 1: decide whether a role="feed" direct child is a post.
   * True when it has a body anchor, or a non-comment dir=auto block long enough
   * to be prose. Sort headers and empty placeholders return false.
   */
  function looksLikePost(el) {
    if (el.querySelector(POST_TEXT_SEL)) return true;
    var blocks = el.querySelectorAll('div[dir="auto"]');
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].closest(COMMENT_SEL)) continue;            // skip comment text
      if ((blocks[i].innerText || '').trim().length >= MIN_POST_TEXT_LEN) return true;
    }
    return false;
  }

  // ── See-more expansion ────────────────────────────────────────────────────────
  // Click "See more" / "ראה עוד" so the full post text is captured. Buttons inside
  // comments (role="article") are skipped — we don't extract comment text.
  // Returns true if any button was clicked (caller waits briefly for the DOM update).
  function expandSeeMore(containerEl) {
    var SEE_MORE_RE = /^(see\s+more|ראה\s+עוד|הצג\s+עוד|עוד)$/i;
    var clicked = false;
    var candidates = containerEl.querySelectorAll('[role="button"], [tabindex="0"]');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.closest(COMMENT_SEL)) continue;                   // don't expand comments
      var txt = (el.innerText || el.textContent || '').trim();
      if (SEE_MORE_RE.test(txt)) {
        try { el.click(); } catch (e) {}
        clicked = true;
      }
    }
    return clicked;
  }

  /**
   * Expand "See more" if needed, then dispatch the card to onNewPost.
   * Deferred 400 ms when expansion mutated the DOM. Shared by both paths.
   */
  function handleCard(card, onNewPost) {
    if (!_scrolling) return;
    var expanded = expandSeeMore(card);
    if (expanded) {
      var captured = card;
      setTimeout(function () {
        if (_scrolling) onNewPost(captured);
      }, 400);
    } else {
      onNewPost(card);
    }
  }

  /**
   * Scan the document and dispatch each post card exactly once.
   *
   * Path 1 — role="feed" direct children (primary). Comment-immune and
   *          anchor-independent; one child = one post.
   * Path 2 — body anchors NOT inside any role="feed" (legacy safety net for
   *          surfaces without a feed container). Comment-immune because comments
   *          have no data-ad-* body anchor.
   */
  function processVisible(onNewPost) {
    // Path 1 — feed children.
    var feeds = document.querySelectorAll('[role="feed"]');
    for (var f = 0; f < feeds.length; f++) {
      var kids = feeds[f].children;
      for (var c = 0; c < kids.length; c++) {
        var child = kids[c];
        if (_seenContainers.has(child)) continue;
        if (!looksLikePost(child)) continue;     // header / placeholder / not yet loaded
        _seenContainers.add(child);
        handleCard(child, onNewPost);
      }
    }

    // Path 2 — body anchors outside any feed container.
    document.querySelectorAll(POST_TEXT_SEL).forEach(function (textEl) {
      if (_seenTexts.has(textEl)) return;
      _seenTexts.add(textEl);
      if (textEl.closest('[role="feed"]')) return;   // already covered by Path 1
      var card = getPostContainer(textEl);
      if (!card || _seenContainers.has(card)) return;
      _seenContainers.add(card);
      handleCard(card, onNewPost);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function startScroll(options, callbacks, resetSeen) {
    if (_scrolling) stopScroll();
    _scrolling = true;

    // Reset the per-session dedup WeakSets on a fresh START_SCRAPE so posts
    // deleted from the dashboard are re-sent next scrape. We do NOT reset on
    // CONTINUE_SCRAPE (resetSeen === false) so a continue resumes where it left off.
    if (resetSeen !== false) {
      _seenTexts      = new WeakSet();
      _seenContainers = new WeakSet();
    }

    var onNewPost = callbacks.onNewPost;

    _observer = new MutationObserver(function () {
      processVisible(onNewPost);
    });
    _observer.observe(document.body, { childList: true, subtree: true });

    // Pick up posts already rendered when scraping starts.
    processVisible(onNewPost);

    function tick() {
      if (!_scrolling) return;
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
      _timerId = setTimeout(tick, randomDelay(4000, 7000));
    }
    _timerId = setTimeout(tick, randomDelay(4000, 7000));
  }

  function stopScroll() {
    _scrolling = false;
    if (_timerId)  { clearTimeout(_timerId);  _timerId  = null; }
    if (_observer) { _observer.disconnect();  _observer = null; }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  return { startScroll: startScroll, stopScroll: stopScroll };

})();
