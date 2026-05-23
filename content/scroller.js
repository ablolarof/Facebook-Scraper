// content/scroller.js — Auto-scroll with MutationObserver
//
// Loaded as a plain (non-module) script before content.js.
// Exposes window.TLVScroller = { startScroll, stopScroll }.
//
// Detection strategy (v3 — anchored on the permalink, not on aria attrs):
//   1. MutationObserver fires on any childList change in document.body.
//   2. We scan for [data-ad-preview="message"] / [data-ad-comet-preview="message"]
//      elements — these mark the body of a real post (never a comment).
//   3. From each text element we walk UP the DOM until we find an ancestor that
//      contains a /posts/ or /permalink/ link. That ancestor is the smallest
//      post-card container — it spans BOTH the post body (where we started)
//      AND the post header (where the permalink lives), so every extractor
//      selector will resolve correctly inside it.
//   4. WeakSets dedupe at both the text-element and container level so each
//      post is handed to extractPost exactly once per scrape session.

window.TLVScroller = (function () {

  var _scrolling       = false;
  var _timerId         = null;
  var _observer        = null;
  var _seenTexts       = new WeakSet();  // text elements already kicked off
  var _seenContainers  = new WeakSet();  // post containers already extracted

  // Selector for the post body container Facebook renders on every group post.
  var POST_TEXT_SEL = '[data-ad-preview="message"], [data-ad-comet-preview="message"]';

  // Selector for the post's permalink link. Must cover every Facebook URL
  // pattern the extractor knows how to derive a post_id from.
  //   /groups/X/posts/Y       — posts inside a group page
  //   /groups/X/permalink/Y   — older group post format
  //   /USER/posts/Y           — posts on the home/profile feed
  //   /permalink.php?story_fbid=…
  //   /story.php?story_fbid=…
  //   /share/p/Y              — shared-post URLs surfaced on the home feed
  //   /commerce/listing/Y     — Marketplace listings cross-posted into a group
  //   /marketplace/item/Y     — Marketplace items (alternate URL form)
  var PERMALINK_LINK_SEL = [
    'a[href*="/posts/"]',
    'a[href*="/permalink/"]',
    'a[href*="story_fbid="]',
    'a[href*="/share/p/"]',
    'a[href*="/commerce/listing/"]',
    'a[href*="/marketplace/item/"]',
  ].join(', ');

  // How many DOM levels above the text element we'll search before giving up.
  // Home-feed posts can sit deeper than group-page posts because of the extra
  // feed wrapper / story-card divs, so we go up to 20.
  var MAX_WALK_UP = 20;

  // Reshared / cross-posted cards sometimes render the post-text element TWICE
  // within a single card (once in an "inner" preview layer, once in the "outer"
  // share wrapper). The walk-up must be willing to climb past an ancestor that
  // contains BOTH copies in order to reach the layer holding the permalink. We
  // cap at 2 to avoid climbing into a feed-level container with N posts.
  var MAX_POST_TEXT_PER_CARD = 2;

  // ── Core detection ────────────────────────────────────────────────────────

  /**
   * Find the post-card container for a given post-body element.
   *
   * Strategy 1 (primary, legacy): the nearest [role="article"] ancestor. FB used
   * to wrap every feed item in role="article", though as of mid-2026 the Groups
   * Feed no longer does. Kept first because it's still the cheapest, most
   * unambiguous boundary when present.
   *
   * Strategy 2 (current FB DOM): walk up looking for an ancestor that contains
   * a permalink-shaped link, but bail out if we cross a boundary that holds more
   * than MAX_POST_TEXT_PER_CARD post-text descendants — at that point we'd be
   * looking at the feed wrapper, not a single post card. Reshared posts double
   * the count to 2 (inner + outer copies of the same text), which we allow.
   *
   * Strategy 3 (fallback): if no permalink ancestor exists within MAX_WALK_UP
   * levels (e.g. a post type where FB simply doesn't render a permalink link),
   * return the tightest ancestor that still uniquely contained THIS post-text
   * element. The extractor's hash-based post_id fallback can still derive a
   * stable ID from author + content.
   */
  function getPostContainer(textEl) {
    var article = textEl.closest('[role="article"]');
    if (article) return article;

    var current    = textEl.parentElement;
    var lastSingle = null; // most recent ancestor with exactly 1 post-text descendant
    for (var i = 0; i < MAX_WALK_UP && current && current !== document.body; i++) {
      var postTextCount = current.querySelectorAll(POST_TEXT_SEL).length;
      if (postTextCount === 1) lastSingle = current;

      // Crossed into multi-post territory — stop here and use the best ancestor
      // we found below this point.
      if (postTextCount > MAX_POST_TEXT_PER_CARD) return lastSingle;

      if (current.querySelector(PERMALINK_LINK_SEL)) return current;
      current = current.parentElement;
    }
    return lastSingle;
  }

  // ── See-more expansion ───────────────────────────────────────────────────────
  // Facebook collapses long posts in the feed with a "See more" / "ראה עוד"
  // button. If we extract text before expanding, we only capture the truncated
  // preview (~250 visible characters). This function finds and clicks those
  // buttons so the full post text is in the DOM before extraction runs.
  //
  // Returns true if any button was clicked (caller should wait briefly for the
  // DOM to update before reading innerText).
  function expandSeeMore(containerEl) {
    var SEE_MORE_RE = /^(see\s+more|ראה\s+עוד|הצג\s+עוד|עוד)$/i;
    var clicked = false;

    // Facebook renders the expander as a [role="button"] or a plain <div>/<span>
    // with a tabIndex, sitting inside or adjacent to the message container.
    var candidates = containerEl.querySelectorAll(
      '[role="button"], [tabindex="0"]'
    );
    for (var i = 0; i < candidates.length; i++) {
      var el  = candidates[i];
      var txt = (el.innerText || el.textContent || '').trim();
      if (SEE_MORE_RE.test(txt)) {
        try { el.click(); } catch (e) {}
        clicked = true;
      }
    }
    return clicked;
  }

  /**
   * Scan the document for post-text elements, derive each one's container,
   * and fire onNewPost() for containers we haven't seen yet.
   *
   * If a collapsed "See more" button is found we click it first and defer the
   * callback by 400 ms so Facebook's synchronous (or lightly-async) DOM update
   * has time to complete before the extractor reads innerText.
   */
  function processVisible(onNewPost) {
    document.querySelectorAll(POST_TEXT_SEL).forEach(function (textEl) {
      if (_seenTexts.has(textEl)) return;
      _seenTexts.add(textEl);

      var postEl = getPostContainer(textEl);
      if (!postEl) {
        console.warn(
          '[TLV Rentals] post-text element found but no usable container within ' +
          MAX_WALK_UP + ' levels — skipping. Snippet:',
          (textEl.innerText || '').slice(0, 80)
        );
        return;
      }
      if (_seenContainers.has(postEl)) return;
      _seenContainers.add(postEl);

      if (!_scrolling) return;

      var expanded = expandSeeMore(postEl);
      if (expanded) {
        // Give the DOM a moment to reflect the expanded text before extracting.
        var capturedPostEl = postEl;
        setTimeout(function () {
          if (_scrolling) onNewPost(capturedPostEl);
        }, 400);
      } else {
        onNewPost(postEl);
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function startScroll(options, callbacks) {
    if (_scrolling) stopScroll();
    _scrolling = true;
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
