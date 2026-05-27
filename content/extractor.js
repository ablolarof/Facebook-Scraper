// content/extractor.js — DOM extraction
//
// Loaded as a plain (non-module) script. Exposes window.TLVExtractor so that
// content.js (loaded afterwards) can call TLVExtractor.extractPost().
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │  SELECTORS — the ONLY thing you need to update when FB changes its DOM. │
// │  Everything else in this file stays the same.                           │
// └──────────────────────────────────────────────────────────────────────────┘
//
// All selectors are anchored on role/aria/data-* attributes — NOT CSS class
// names — so they survive Facebook's automatic class-name rotations.

window.TLVExtractor = (function () {

  // ── Selector config ────────────────────────────────────────────────────────
  const SEL = {

    // Post timestamp link in the post header. Points to the post itself (not a
    // comment) — its href contains /posts/POST_ID, /permalink/POST_ID,
    // ?story_fbid=POST_ID, or /share/p/POST_ID — without a comment_id param.
    //
    // Marketplace listings cross-posted into a group surface as /commerce/listing/<id>
    // or /marketplace/item/<id> links instead of /posts/. They have no comment_id
    // variant, so the same selector serves both the primary and fallback case.
    //
    // Note: /videos/ and /share/v/ are intentionally NOT in this list. Group
    // feeds inject "Recommended Reels" widgets whose /videos/<user>/pcb.<id>/
    // anchors would otherwise bleed into the card and capture as the post's
    // permalink. We scrape text/image rental posts, so video URLs add
    // pollution without much upside.
    permalink: [
      'a[href*="/posts/"]:not([href*="comment_id"])',
      'a[href*="/permalink/"]:not([href*="comment_id"])',
      'a[href*="story_fbid="]:not([href*="comment_id"])',
      'a[href*="/share/p/"]:not([href*="comment_id"])',
      'a[href*="/commerce/listing/"]',
      'a[href*="/marketplace/item/"]',
    ].join(', '),

    // Fallback: same URL patterns but allow comment_id (a comment's timestamp
    // link still encodes the parent post's ID, which is enough to dedupe by).
    // Comment params are stripped downstream.
    permalinkFallback: [
      'a[href*="/posts/"]',
      'a[href*="/permalink/"]',
      'a[href*="story_fbid="]',
      'a[href*="/share/p/"]',
      'a[href*="/commerce/listing/"]',
      'a[href*="/marketplace/item/"]',
    ].join(', '),

    // Full post body text. Both attribute variants are tried:
    //   data-ad-preview        — legacy renderer
    //   data-ad-comet-preview  — Comet (newer) renderer
    postText: '[data-ad-preview="message"], [data-ad-comet-preview="message"]',

    // Author profile link. Within a group context the href is:
    //   /groups/GROUP_ID/user/USER_ID/
    // In DOM order the post-author link appears before any comment-author links,
    // so querySelector returns the post author.
    authorLink: 'a[href*="/user/"]',

    // On the /groups/feed/ aggregated feed each card shows which group it came
    // from. The group name lives in an h3 inside the profile_name container.
    sourceGroupLink: '[data-ad-rendering-role="profile_name"] h3 a',

    // CDN-hosted post images. Emoji and reaction images are filtered out below.
    images: 'img[src*="scontent"]',
  };

  // Recognized post-URL pathname shapes. A captured href must contain one of
  // these segments — otherwise it's a nav link / page URL / random anchor
  // that snuck through the selector and would send the user to the wrong
  // page (historically: facebook.com/?filter=all&sk=h_chr from a stripped
  // home-feed URL).
  const POST_URL_PATH_RE = /\/(posts|permalink|share\/p|commerce\/listing|marketplace\/item)\//;

  /**
   * Extract structured data from one post-card container.
   *
   * @param {Element} cardEl          — post-card container chosen by scroller.js
   * @param {string|null} pageGroupId — group ID from the page URL (null on feed)
   * @param {string}      pageGroupName — group name from the page (or "Groups Feed")
   */
  function extractPost(cardEl, pageGroupId, pageGroupName) {

    // ── Post text & author ─────────────────────────────────────────────────
    const textEl = find(cardEl, SEL.postText, 'postText');
    const text   = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';

    const authorEl           = cardEl.querySelector(SEL.authorLink);
    const author_name        = authorEl ? authorEl.textContent.trim() : '';
    const author_profile_url = authorEl ? authorEl.href : '';

    // ── Permalink & post_id ────────────────────────────────────────────────
    // pickPermalink applies the in-group preference: on a specific group page
    // it requires the captured URL to either match the current group or be a
    // Marketplace/commerce listing. Cross-card pollution (recommended widgets,
    // links to OTHER groups, cross-post originals) is rejected here. Walk-up
    // depth 20 matches scroller.js's MAX_WALK_UP so they stay in sync.
    let permalinkEl = pickPermalink(cardEl, pageGroupId);
    if (!permalinkEl) {
      let ancestor = cardEl.parentElement;
      for (var _i = 0; _i < 20 && ancestor && ancestor !== document.body; _i++) {
        permalinkEl = pickPermalink(ancestor, pageGroupId);
        if (permalinkEl) break;
        ancestor = ancestor.parentElement;
      }
    }

    let post_id;
    let permalink = '';
    let posted_at;

    if (permalinkEl) {
      const rawHref = permalinkEl.href || '';
      // Sanity-check the URL shape BEFORE accepting the post_id. A bare
      // facebook.com URL or a /?filter= nav link would otherwise pass through
      // derivePostId's last-resort and pollute the DB with bogus Open links.
      let pathLooksValid = false;
      try {
        const probe = new URL(rawHref, location.origin);
        pathLooksValid = POST_URL_PATH_RE.test(probe.pathname)
                      || probe.searchParams.has('story_fbid');
      } catch (_) { pathLooksValid = false; }

      if (pathLooksValid) {
        post_id = derivePostId(rawHref);
      }

      if (!pathLooksValid || !post_id) {
        // Discard bogus href and fall through to hash branch.
        permalinkEl = null;
      } else {
        // Build a clean permalink — strip comment params so the stored URL
        // points directly to the post, not to a particular comment.
        try {
          const u = new URL(rawHref, location.origin);
          ['comment_id', 'reply_comment_id', 'ref', 'mibextid'].forEach(function (p) {
            u.searchParams.delete(p);
          });
          permalink = u.origin + u.pathname;
          if (!permalink.endsWith('/')) permalink += '/';
        } catch (_) { permalink = rawHref; }

        // The post_id link may not BE the timestamp link (e.g. it's the
        // post-image anchor whose aria-label is alt text). findPostedAt
        // walks the card's anchors and picks the first whose text parses as
        // a relative time, so we get the actual post-header timestamp.
        posted_at = findPostedAt(cardEl, permalinkEl) || new Date().toISOString();
      }
    }

    if (!permalinkEl) {
      // No usable permalink — hash author + first 200 chars of text so the
      // same post yields the same post_id on subsequent scrapes (dedup).
      if (!text && !author_name) {
        console.warn('[TLV Rentals] Skipping card with neither permalink nor content');
        return null;
      }
      post_id   = 'h_' + hashString(author_name + '|' + text.slice(0, 200));
      permalink = '';   // leave blank so dashboard shows a disabled Open button
      posted_at = findPostedAt(cardEl, null) || new Date().toISOString();

      // Diagnostic: log what anchors WERE present so a live scrape with
      // DevTools open shows which kinds of cards are losing permalinks.
      try {
        const anchorTypes = { posts: 0, permalink: 0, story_fbid: 0, share_p: 0, videos: 0, commerce: 0, marketplace: 0, other: 0 };
        const anchors = cardEl.querySelectorAll('a[href]');
        for (let ai = 0; ai < anchors.length; ai++) {
          const h = anchors[ai].getAttribute('href') || '';
          if      (h.indexOf('/posts/')              !== -1) anchorTypes.posts++;
          else if (h.indexOf('/permalink/')          !== -1) anchorTypes.permalink++;
          else if (h.indexOf('story_fbid=')          !== -1) anchorTypes.story_fbid++;
          else if (h.indexOf('/share/p/')            !== -1) anchorTypes.share_p++;
          else if (h.indexOf('/videos/')             !== -1) anchorTypes.videos++;
          else if (h.indexOf('/commerce/listing/')   !== -1) anchorTypes.commerce++;
          else if (h.indexOf('/marketplace/item/')   !== -1) anchorTypes.marketplace++;
          else                                                anchorTypes.other++;
        }
        console.warn('[TLV Rentals] Hash-fallback used (no usable permalink found).', {
          post_id: post_id,
          page_group: pageGroupName || pageGroupId,
          author: author_name,
          text_preview: (text || '').slice(0, 80),
          anchor_count: anchors.length,
          anchor_types: anchorTypes,
          card: cardEl,
        });
      } catch (_) { /* diagnostic only — never block extraction */ }
    }

    // ── Images ─────────────────────────────────────────────────────────────
    const image_urls = SEL.images
      ? Array.from(cardEl.querySelectorAll(SEL.images))
          .map(img => img.src)
          .filter(src => src && !src.includes('emoji') && !src.includes('reaction'))
      : [];

    // ── Source group (feed page only) ──────────────────────────────────────
    let group_id   = pageGroupId;
    let group_name = pageGroupName;

    if (!pageGroupId && SEL.sourceGroupLink) {
      const groupLinkEl = find(cardEl, SEL.sourceGroupLink, 'sourceGroupLink');
      if (groupLinkEl) {
        group_name = groupLinkEl.textContent.trim();
        const m = (groupLinkEl.href || '').match(/\/groups\/([^/?#]+)/);
        group_id = m ? m[1] : 'feed';
      }
    }
    if (!group_id) group_id = 'feed';

    return {
      post_id,
      group_id,
      group_name,
      author_name,
      author_profile_url,
      posted_at,
      text,
      image_urls,
      permalink,
      scraped_at: new Date().toISOString(),
      status: 'new',
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function find(el, selector, fieldName) {
    if (!selector) return null;
    const result = el.querySelector(selector);
    if (!result) {
      console.warn('[TLV Rentals] Selector miss for "' + fieldName + '": ' + selector);
    }
    return result;
  }

  // Pick the best permalink anchor inside scopeEl.
  //
  // On a specific group page (pageGroupId set and not "feed"), require the
  // captured URL to either:
  //   (a) contain /groups/<pageGroupId>/ — permalink to a post in the CURRENT
  //       group, OR
  //   (b) be a Marketplace / commerce listing — valid regardless of group
  //       context.
  //
  // Everything else gets rejected. This is the fix for cross-card permalink
  // pollution: group-page cards routinely contain "Recommended Reels" links
  // pointing at random user profiles, related-posts tiles linking to OTHER
  // groups, and cross-post wrappers whose first permalink points to the
  // ORIGINAL post in a different group. Better to return null and let the
  // extractor render a disabled Open button than to ship the user to the
  // wrong page.
  //
  // On the home feed / aggregated /groups/feed/ (pageGroupId null or "feed"),
  // we have no group-ID context to filter against, so any candidate is
  // accepted. Empirically the home feed has always returned correct URLs.
  function pickPermalink(scopeEl, pageGroupId) {
    let candidates = Array.from(scopeEl.querySelectorAll(SEL.permalink));
    if (!candidates.length) {
      candidates = Array.from(scopeEl.querySelectorAll(SEL.permalinkFallback));
    }
    if (!candidates.length) return null;

    if (!pageGroupId || pageGroupId === 'feed') {
      return candidates[0];
    }

    const groupPathFragment = '/groups/' + pageGroupId + '/';
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      let u;
      try { u = new URL(el.href || '', location.origin); }
      catch (_) { continue; }
      if (u.pathname.indexOf(groupPathFragment) !== -1) return el;
      if (u.pathname.indexOf('/commerce/listing/') !== -1) return el;
      if (u.pathname.indexOf('/marketplace/item/') !== -1) return el;
    }
    return null;
  }

  function derivePostId(url) {
    if (!url) return null;
    try {
      const u = new URL(url, location.origin);
      const m1 = u.pathname.match(/\/posts\/([^/?#]+)/);
      if (m1) return m1[1];
      const m2 = u.pathname.match(/\/permalink\/([^/?#]+)/);
      if (m2) return m2[1];
      const m3 = u.pathname.match(/\/share\/p\/([^/?#]+)/);
      if (m3) return m3[1];
      const m4 = u.pathname.match(/\/commerce\/listing\/([^/?#]+)/);
      if (m4) return 'cl_' + m4[1];
      const m5 = u.pathname.match(/\/marketplace\/item\/([^/?#]+)/);
      if (m5) return 'mp_' + m5[1];
      const fbid = u.searchParams.get('story_fbid');
      if (fbid) return fbid;
      // Last resort: hash the URL so we always return something unique
      return url.replace(/[^a-zA-Z0-9]/g, '').slice(-20) || null;
    } catch (e) {
      return null;
    }
  }

  // djb2-style string hash → base36. Stable across scrapes so the same author
  // + text body yields the same post_id (dedup hook for permalink-less posts).
  function hashString(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  // Identify the post's timestamp link by its TEXT, not its href.
  //
  // Two-part strategy because the cardEl handed to us can be too narrow:
  //   1. Scan every <a> inside cardEl. If a label parses as a relative time,
  //      we are done — fast path for cards whose header is in scope.
  //   2. Walk UP from cardEl one level at a time, re-scanning. The home-feed
  //      scroller can lock onto a narrow cardEl (depth 2) when an inline
  //      /posts/-shaped link exists inside the post body, leaving the post
  //      header (timestamp link) one level above. Bail out as soon as scope
  //      contains more than 2 post-text elements — beyond that we'd risk
  //      reading a NEIGHBORING post's timestamp.
  //
  // FB's click-tracking timestamp links (https://facebook.com/?__cft__=...)
  // encode nothing about the post, so URL-substring filtering misses them
  // entirely. Text-based identification is safe because parseRelativeTime
  // returns null for non-time strings ("Like", "Comment", "1.2K", etc.).
  function findPostedAt(cardEl, primaryEl) {
    // Fast path: try the post_id link first. For old-style URL patterns the
    // post_id link IS the timestamp link.
    if (primaryEl) {
      const primaryLabel = primaryEl.getAttribute('aria-label')
                        || primaryEl.textContent
                        || '';
      const primaryIso = parseRelativeTime(primaryLabel);
      if (primaryIso) return primaryIso;
    }

    const POST_TEXT_SEL = '[data-ad-preview="message"], [data-ad-comet-preview="message"]';
    const tested = new Set();   // dedupe link tests across widening scopes
    let scope = cardEl;

    for (let depth = 0; depth < 8 && scope && scope !== document.body; depth++) {
      // Multi-post safety. Stop before scope grows to include neighbors.
      const textCount = scope.querySelectorAll(POST_TEXT_SEL).length;
      if (textCount > 2) break;

      const links = scope.querySelectorAll('a');
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        if (link === primaryEl) continue;
        if (tested.has(link))   continue;
        tested.add(link);

        const label = link.getAttribute('aria-label')
                   || link.textContent
                   || '';
        const iso = parseRelativeTime(label);
        if (iso) return iso;
      }

      scope = scope.parentElement;
    }
    return null;
  }

  // parseRelativeTime returns an ISO timestamp for inputs like "2h", "3 days
  // ago", "yesterday", or an absolute date string. Returns null for anything
  // it can't parse — findPostedAt relies on this to detect "is this a
  // timestamp link or just a Like/Comment button?".
  function parseRelativeTime(label) {
    if (!label) return null;
    const now = Date.now();
    label = label.trim().toLowerCase();

    // Order matters: 'mo'/'mon'/'month' must match BEFORE plain 'm' (minutes),
    // and 'y'/'yr'/'year' likewise. Months approximated as 30 days, years as
    // 365 days — close enough for a "when was this listed" filter.
    let parsedMs = null;
    const mYears  = label.match(/(\d+)\s*y(?:r|ear)?s?\b/);
    if (mYears)  parsedMs = now - parseInt(mYears[1])  * 31536000000;
    const mMonths = label.match(/(\d+)\s*mo(?:n|nth)?s?\b/);
    if (parsedMs == null && mMonths) parsedMs = now - parseInt(mMonths[1]) * 2592000000;
    const mWeeks  = label.match(/(\d+)\s*w(?:k|eek)?s?\b/);
    if (parsedMs == null && mWeeks)  parsedMs = now - parseInt(mWeeks[1])  * 604800000;
    const mDays   = label.match(/(\d+)\s*d(?:ay)?s?\b/);
    if (parsedMs == null && mDays)   parsedMs = now - parseInt(mDays[1])   * 86400000;
    const mHours  = label.match(/(\d+)\s*h(?:r|our)?s?\b/);
    if (parsedMs == null && mHours)  parsedMs = now - parseInt(mHours[1])  * 3600000;
    const mMins   = label.match(/(\d+)\s*m(?:in|inute)?s?\b/);
    if (parsedMs == null && mMins)   parsedMs = now - parseInt(mMins[1])   * 60000;
    if (parsedMs == null && label.includes('yesterday')) parsedMs = now - 86400000;
    if (parsedMs == null) {
      const d = new Date(label);
      if (!isNaN(d)) parsedMs = d.getTime();
    }

    // Sanity bounds. Anything outside the [10 years ago, tomorrow] window is
    // a parsing accident — return null so findPostedAt keeps searching.
    const TEN_YEARS_MS = 10 * 365 * 86400000;
    if (parsedMs == null || parsedMs > now + 86400000 || parsedMs < now - TEN_YEARS_MS) {
      return null;
    }
    return new Date(parsedMs).toISOString();
  }

  return { extractPost: extractPost };

})();
