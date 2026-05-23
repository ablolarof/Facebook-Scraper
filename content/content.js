// content/content.js — Main content script
//
// Plain (non-module) script loaded after extractor.js and scroller.js.
// Uses the globals window.TLVExtractor and window.TLVScroller.
//
// Handles all messages from the popup:
//   PING          → { alive, groupId, groupName }
//   GET_STATS     → copy of current scrape state
//   START_SCRAPE  → begin scroll + extraction
//   STOP_SCRAPE   → stop immediately
//   CONTINUE_SCRAPE → resume after a stop-condition banner

(function () {

  // ── Classification strategy ────────────────────────────────────────────────
  // Stage 1 saves EVERY extracted post unfiltered. Rental-vs-not classification
  // happens after the fact:
  //   1. Background.js auto-classifies each new post with Gemini Flash (if
  //      the user has set an API key in popup settings).
  //   2. The user can override/confirm AI labels with Rental/Not Rental buttons
  //      on each dashboard card. Those human labels become the few-shot
  //      examples Gemini sees for future classification calls.
  // No rule-based regex filter runs here anymore — Gemini with a growing pool
  // of human-labeled examples replaces it.
  // ──────────────────────────────────────────────────────────────────────────

  // ── Page helpers ───────────────────────────────────────────────────────────
  // getGroupId() classifies the current page into one of:
  //   - a numeric/slug group id, when on /groups/<id>/
  //   - 'feed', when on the aggregated /groups/feed/ view
  //   - 'home', when on any other facebook.com URL
  // The extractor branches on these: a real group id means all posts share that
  // group, 'feed' and 'home' mean the extractor must read group info per-post
  // from each card's source-group link.
  function getGroupId() {
    // Specific group page: /groups/12345/
    var m = location.pathname.match(/\/groups\/([^/?#]+)/);
    if (m && m[1] !== 'feed') return m[1];
    // Aggregated groups feeds
    if (/\/groups\/feed\/?/.test(location.pathname)) return 'feed';
    if (/[?&]filter=groups/.test(location.search)) return 'feed';
    // Any other facebook page (home, marketplace, etc.)
    return 'home';
  }

  function getGroupName() {
    var gid = getGroupId();
    if (gid === 'feed') return 'Groups Feed';
    if (gid === 'home') return 'Home Feed';
    return (
      (document.querySelector('h1') || {}).textContent || ''
    ).trim() || document.title.replace(/\s*\|.*$/, '').trim();
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Scrape state ───────────────────────────────────────────────────────────
  var state = freshState();

  function freshState() {
    return {
      running:           false,
      postsCaptured:     0,
      duplicatesInARow:  0,
      totalDuplicates:   0,
      elapsedMs:         0,
      startTime:         null,
      stopReason:        null,   // null | 'max_dupes' | 'max_duration' | 'manual'
    };
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Message listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {

    if (msg.type === 'PING') {
      sendResponse({
        alive:     true,
        groupId:   getGroupId(),
        groupName: getGroupName(),
      });
      return false;
    }

    if (msg.type === 'GET_STATS') {
      if (state.running) state.elapsedMs = Date.now() - state.startTime;
      // Shallow copy so the listener doesn't hold a stale reference
      sendResponse({
        running:           state.running,
        postsCaptured:     state.postsCaptured,
        duplicatesInARow:  state.duplicatesInARow,
        totalDuplicates:   state.totalDuplicates,
        elapsedMs:         state.elapsedMs,
        startTime:         state.startTime,
        stopReason:        state.stopReason,
      });
      return false;
    }

    if (msg.type === 'START_SCRAPE') {
      state           = freshState();
      state.running   = true;
      state.startTime = Date.now();
      beginScrape(msg.options || {});
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'STOP_SCRAPE') {
      window.TLVScroller.stopScroll();
      state.running    = false;
      state.stopReason = 'manual';
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'CONTINUE_SCRAPE') {
      state.running          = true;
      state.stopReason       = null;
      state.duplicatesInARow = 0;
      state.startTime        = Date.now(); // fresh clock for this continuation window
      beginScrape(msg.options || {});
      sendResponse({ ok: true });
      return false;
    }
  });
  // ──────────────────────────────────────────────────────────────────────────

  // ── Scrape loop ────────────────────────────────────────────────────────────
  function beginScrape(options) {
    // On /groups/feed/ (aggregated view) and on any non-group page, individual
    // cards each come from a different group — let the extractor read the
    // group from each card's source-group link. On a specific /groups/<id>/
    // page, every card shares that group, so pass the id down once.
    var gid           = getGroupId();
    var pageGroupId   = (gid === 'feed' || gid === 'home') ? null : gid;
    var pageGroupName = getGroupName();
    var dupLimit      = options.duplicateThreshold ?? 30;
    var maxMs         = options.extraMinutes
      ? options.extraMinutes * 60000
      : (options.maxDurationMinutes ?? 5) * 60000;
    var extraPostsRemaining = options.extraPosts ?? 0;

    window.TLVScroller.startScroll(
      { duplicateThreshold: dupLimit, maxDurationMs: maxMs },
      {
        onNewPost: function (cardEl) {
          if (!state.running) return;

          // Time-limit check (cheap, runs before any DOM work).
          if (Date.now() - state.startTime >= maxMs) {
            window.TLVScroller.stopScroll();
            state.running    = false;
            state.stopReason = 'max_duration';
            return;
          }

          // Extract post data from the DOM node.
          var post;
          try {
            post = window.TLVExtractor.extractPost(cardEl, pageGroupId, pageGroupName);
          } catch (e) {
            console.error('[TLV Rentals] extractPost threw:', e);
            return;
          }
          if (!post) return; // extractor returned null (stub or bad node)

          // No client-side filtering — background.js handles classification.
          // Send to background worker for dedup + IndexedDB save + auto-classify.
          chrome.runtime.sendMessage({ type: 'SAVE_POST', post: post }, function (result) {
            if (chrome.runtime.lastError) {
              // Background worker not ready — ignore and keep going.
              return;
            }
            if (!result || !result.ok) return;

            state.postsCaptured++;

            if (result.is_duplicate) {
              state.totalDuplicates++;
              if (extraPostsRemaining > 0) {
                extraPostsRemaining--;
                // Don't count against threshold during a "Continue N more posts" window.
              } else {
                state.duplicatesInARow++;
              }
            } else {
              state.duplicatesInARow = 0;
            }

            // Duplicate-threshold stop condition.
            if (state.duplicatesInARow >= dupLimit) {
              window.TLVScroller.stopScroll();
              state.running    = false;
              state.stopReason = 'max_dupes';
            }
          });
        },

        onStopped: function (reason) {
          if (state.running) {
            state.running    = false;
            state.stopReason = reason || 'done';
          }
        },
      }
    );
  }
  // ──────────────────────────────────────────────────────────────────────────

  console.log('[TLV Rentals] content script ready on', location.pathname);

})();
