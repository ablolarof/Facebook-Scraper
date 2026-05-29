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
  // The content script saves EVERY extracted post unfiltered. Classification
  // happens inside background.js using lib/regex_extractor.js — a local
  // Hebrew/English regex pass that runs synchronously on save. No network
  // calls in the loop.
  //
  // Posts the regex can't classify with confidence stay unlabeled until a
  // human marks them on the dashboard. Stage 2 of the project plan adds a
  // "mark as regex miss + explain" mechanism that feeds those gaps back
  // into the regex rules.
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
      totalOverwrites:   0,        // posts whose post_id already existed → silently updated, not added
      elapsedMs:         0,
      startTime:         null,
      stopReason:        null,   // null | 'max_dupes' | 'max_duration' | 'manual'
    };
  }

  // ── DEBUG instrumentation (dev-extractor-2 only — remove before merge) ──────
  // Traces the real save pipeline to settle "scanned ≫ saved". Logs every save
  // (id, new vs overwrite, body snippet) and the stop reason + elapsed time, so
  // we can SEE whether posts are lost to early-stop or to id churn.
  var TLV_DEBUG    = true;
  var _dbgIdSeen   = Object.create(null);  // post_id → times dispatched to save
  function dbgSave(post, result) {
    if (!TLV_DEBUG) return;
    var n = (_dbgIdSeen[post.post_id] = (_dbgIdSeen[post.post_id] || 0) + 1);
    var tag = result.is_new_record === false ? 'OVERWRITE' : (result.is_duplicate ? 'DUP-HASH' : 'NEW');
    var hashId = (post.post_id || '').slice(0, 3) === 'h_';
    console.log(
      '%c[TLV-DBG ' + tag + (n > 1 ? ' ×' + n : '') + ']',
      'color:' + (tag === 'NEW' ? '#27ae60' : '#e67e22'),
      { id: post.post_id, hashFallback: hashId, sec: Math.round((Date.now() - state.startTime) / 1000),
        body: (post.text || '').replace(/\s+/g, ' ').slice(0, 40) }
    );
  }
  function dbgStop(reason) {
    if (!TLV_DEBUG) return;
    var distinct = Object.keys(_dbgIdSeen).length;
    var hashIds  = Object.keys(_dbgIdSeen).filter(function (k) { return k.slice(0, 2) === 'h_'; }).length;
    console.log('%c[TLV-DBG] ====== STOP: ' + reason + ' ======', 'font-weight:bold;font-size:13px;color:#c0392b');
    console.log('  elapsedSec      :', state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0);
    console.log('  saveCalls       :', state.postsCaptured, '(NEW+OVERWRITE+DUP round-trips)');
    console.log('  distinctIds     :', distinct, '(' + hashIds + ' hash-fallback, ' + (distinct - hashIds) + ' real permalink)');
    console.log('  totalOverwrites :', state.totalOverwrites, '(same id re-dispatched — churn)');
    console.log('  totalDuplicates :', state.totalDuplicates);
    console.log('  scrollY/maxY    :', Math.round(window.scrollY), '/', Math.round(document.body.scrollHeight - window.innerHeight),
                window.scrollY >= (document.body.scrollHeight - window.innerHeight - 200) ? '→ REACHED BOTTOM' : '→ STOPPED EARLY (more feed below)');
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
        totalOverwrites:   state.totalOverwrites,
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
      dbgStop('manual');
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'CONTINUE_SCRAPE') {
      state.running          = true;
      state.stopReason       = null;
      state.duplicatesInARow = 0;
      state.startTime        = Date.now(); // fresh clock for this continuation window
      beginScrape(msg.options || {}, false); // false = don't reset _seenContainers
      sendResponse({ ok: true });
      return false;
    }
  });
  // ──────────────────────────────────────────────────────────────────────────

  // ── Scrape loop ────────────────────────────────────────────────────────────
  function beginScrape(options, resetSeen) {
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
            dbgStop('max_duration');
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
            dbgSave(post, result);

            // Three outcomes per save:
            //   1. is_duplicate  — same dedup_hash as a DIFFERENT existing post_id
            //                      (cross-group repost of identical content).
            //   2. !is_new_record — same post_id already in IDB → savePost() overwrote
            //                      the existing row, no new record was added. Happens
            //                      when re-scraping a post we already have, OR when
            //                      hash-fallback IDs collide on the home feed.
            //   3. is_new_record  — a fresh row in IDB.
            //
            // Both (1) and (2) count toward the duplicates-in-a-row stop condition:
            // if we're scrolling past content we already have, that IS the signal to
            // stop, regardless of whether the trigger was a cross-post or a re-scrape.
            if (result.is_duplicate) {
              state.totalDuplicates++;
              if (extraPostsRemaining > 0) {
                extraPostsRemaining--;
              } else {
                state.duplicatesInARow++;
              }
            } else if (result.is_new_record === false) {
              state.totalOverwrites++;
              if (extraPostsRemaining > 0) {
                extraPostsRemaining--;
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
              dbgStop('max_dupes');
            }
          });
        },

        onStopped: function (reason) {
          if (state.running) {
            state.running    = false;
            state.stopReason = reason || 'done';
          }
        },
      },
      resetSeen  // false on CONTINUE_SCRAPE, undefined (→ true) on START_SCRAPE
    );
  }
  // ──────────────────────────────────────────────────────────────────────────

  console.log('[TLV Rentals] content script ready on', location.pathname);

  // ── Auto-scrape via URL parameter ──────────────────────────────────────────
  // When the URL contains ?tlv_auto_scrape=1 (e.g. added by a scheduled task),
  // start scraping automatically without needing the popup. Runs for 30 minutes
  // with a high duplicate threshold so it captures a full hour of new posts.
  (function checkAutoScrape() {
    if (!/[?&]tlv_auto_scrape=/.test(location.search)) return;
    // Wait 4 seconds for Facebook's feed to render before scrolling starts.
    setTimeout(function () {
      if (state.running) return; // already running — do nothing
      state           = freshState();
      state.running   = true;
      state.startTime = Date.now();
      beginScrape({
        maxDurationMinutes:  30,
        duplicateThreshold: 200, // scroll past up to 200 consecutive dupes before stopping
      });
      console.log('[TLV Rentals] Auto-scrape started via URL parameter (30 min)');
    }, 4000);
  })();
  // ──────────────────────────────────────────────────────────────────────────

})();
