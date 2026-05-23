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
    // Carries an aria-label with the relative age ("2 hours ago") even when FB
    // splits the visible text into individual <span> elements per character.
    //
    // Marketplace listings cross-posted into a group surface as /commerce/listing/<id>
    // or /marketplace/item/<id> links instead of /posts/. They have no comment_id
    // variant, so the same selector serves both the primary and fallback case.
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
    // Stable because data-* attrs are explicit contract points, not generated names.
    postText: '[data-ad-preview="message"], [data-ad-comet-preview="message"]',

    // Author profile link. Within a group context the href is:
    //   /groups/GROUP_ID/user/USER_ID/
    // In DOM order the post-author link appears before any comment-author links,
    // so querySelector returns the post author.
    authorLink: 'a[href*="/user/"]',

    // On the /groups/feed/ aggregated feed each card shows which group it came
    // from. The group name lives in an h3 inside the profile_name container.
    // On a single-group page this element is absent — that's fine, we fall back
    // to the pageGroupId/pageGroupName passed in from the URL.
    sourceGroupLink: '[data-ad-rendering-role="profile_name"] h3 a',

    // CDN-hosted post images. Emoji and reaction images are filtered out below.
    images: 'img[src*="scontent"]',
  };
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extract structured data from one post-card container.
   * Returns a post object or null if extraction fails badly enough to skip.
   *
   * @param {Element} cardEl          — the post-card container chosen by scroller.js
   *                                    (formerly the [role="article"] wrapper;
   *                                    now whatever getPostContainer returns)
   * @param {string|null} pageGroupId — group ID from the page URL (null on feed page)
   * @param {string}      pageGroupName — group name from the page (or "Groups Feed")
   */
  function extractPost(cardEl, pageGroupId, pageGroupName) {

    // ── Post text & author ─────────────────────────────────────────────────
    // Extracted first so we can hash them into a content-based post_id when
    // the home-feed card has no permalink <a> in the DOM (FB only renders the
    // permalink on the 3-dot menu in some feeds).
    const textEl = find(cardEl, SEL.postText, 'postText');
    const text   = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';

    const authorEl           = cardEl.querySelector(SEL.authorLink);
    const author_name        = authorEl ? authorEl.textContent.trim() : '';
    const author_profile_url = authorEl ? authorEl.href : '';

    // ── Permalink & post_id ────────────────────────────────────────────────
    // Try the post's own timestamp link first (no comment_id param), then any
    // permalink-shaped link, then fall back to a content hash. A comment's
    // timestamp link still encodes the parent post's ID — good enough.
    let permalinkEl = cardEl.querySelector(SEL.permalink);
    if (!permalinkEl) permalinkEl = cardEl.querySelector(SEL.permalinkFallback);

    let post_id;
    let permalink = '';
    let posted_at;

    if (permalinkEl) {
      const rawHref = permalinkEl.href || '';
      post_id = derivePostId(rawHref);
      if (!post_id) {
        console.warn('[TLV Rentals] Could not derive post_id from:', rawHref);
        return null;
      }
      // Build a clean permalink — strip comment params so the stored URL points
      // directly to the post, not to a particular comment on it.
      try {
        const u = new URL(rawHref, location.origin);
        ['comment_id', 'reply_comment_id', 'ref', 'mibextid'].forEach(function (p) {
          u.searchParams.delete(p);
        });
        permalink = u.origin + u.pathname;
        if (!permalink.endsWith('/')) permalink += '/';
      } catch (_) { permalink = rawHref; }

      // aria-label on the timestamp link is unscrambled ("2 hours ago") even
      // when FB splits the visible text across individual character spans.
      posted_at = parseRelativeTime(
        permalinkEl.getAttribute('aria-label') || permalinkEl.textContent || ''
      );
    } else {
      // No permalink in DOM — hash author + first 200 chars of text so the same
      // post yields the same post_id on subsequent scrapes (enables dedup).
      if (!text && !author_name) {
        console.warn('[TLV Rentals] Skipping card with neither permalink nor content');
        return null;
      }
      post_id   = 'h_' + hashString(author_name + '|' + text.slice(0, 200));
      permalink = location.href;
      posted_at = new Date().toISOString();
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
        // Extract group ID from the link href: /groups/GROUP_ID
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

  function derivePostId(url) {
    if (!url) return null;
    try {
      const u = new URL(url, location.origin);
      // /posts/POST_ID — accept numeric IDs AND pfbid-style opaque tokens.
      const m1 = u.pathname.match(/\/posts\/([^/?#]+)/);
      if (m1) return m1[1];
      // /permalink/POST_ID
      const m2 = u.pathname.match(/\/permalink\/([^/?#]+)/);
      if (m2) return m2[1];
      // /share/p/POST_ID
      const m3 = u.pathname.match(/\/share\/p\/([^/?#]+)/);
      if (m3) return m3[1];
      // /commerce/listing/LISTING_ID — Marketplace listings posted into a group.
      // Prefixed so the namespace can't collide with /posts/ IDs.
      const m4 = u.pathname.match(/\/commerce\/listing\/([^/?#]+)/);
      if (m4) return 'cl_' + m4[1];
      // /marketplace/item/ITEM_ID — alternate Marketplace URL form.
      const m5 = u.pathname.match(/\/marketplace\/item\/([^/?#]+)/);
      if (m5) return 'mp_' + m5[1];
      // ?story_fbid=POST_ID (permalink.php / story.php)
      const fbid = u.searchParams.get('story_fbid');
      if (fbid) return fbid;
      // Last resort: hash the full URL so we always return something unique
      return url.replace(/[^a-zA-Z0-9]/g, '').slice(-20) || null;
    } catch (e) {
      return null;
    }
  }

  // djb2-style string hash → base36 string. Used as the post_id fallback when
  // a card has no permalink in the DOM, so the same content yields the same ID
  // on repeat scrapes (which is what enables dedup).
  function hashString(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function parseRelativeTime(label) {
    if (!label) return new Date().toISOString();
    var now = Date.now();
    label = label.trim().toLowerCase();

    // Order matters: 'mo' / 'mon' / 'month' must match BEFORE the plain 'm'
    // (minutes) rule, and 'y' / 'yr' / 'year' likewise. We also approximate
    // months as 30 days and years as 365 days — close enough for a 'when was
    // this listed' UI filter; not a billing system.
    var parsedMs = null;
    var mYears  = label.match(/(\d+)\s*y(?:r|ear)?s?\b/);
    if (mYears)  parsedMs = now - parseInt(mYears[1])  * 31536000000;
    var mMonths = label.match(/(\d+)\s*mo(?:n|nth)?s?\b/);
    if (parsedMs == null && mMonths) parsedMs = now - parseInt(mMonths[1]) * 2592000000;
    var mWeeks  = label.match(/(\d+)\s*w(?:k|eek)?s?\b/);
    if (parsedMs == null && mWeeks)  parsedMs = now - parseInt(mWeeks[1])  * 604800000;
    var mDays   = label.match(/(\d+)\s*d(?:ay)?s?\b/);
    if (parsedMs == null && mDays)   parsedMs = now - parseInt(mDays[1])   * 86400000;
    var mHours  = label.match(/(\d+)\s*h(?:r|our)?s?\b/);
    if (parsedMs == null && mHours)  parsedMs = now - parseInt(mHours[1])  * 3600000;
    var mMins   = label.match(/(\d+)\s*m(?:in|inute)?s?\b/);
    if (parsedMs == null && mMins)   parsedMs = now - parseInt(mMins[1])   * 60000;
    if (parsedMs == null && label.includes('yesterday')) parsedMs = now - 86400000;
    if (parsedMs == null) {
      var d = new Date(label);
      if (!isNaN(d)) parsedMs = d.getTime();
    }

    // Sanity bounds. Facebook doesn't surface posts older than ~10 years on the
    // feed and the future is impossible — anything outside that window is a
    // parsing accident (e.g. "May 23, 2001" interpreted from a stray date
    // string). Fall back to "now" so the post stays visible instead of getting
    // exiled to the dashboard's 30-day cut-off.
    var TEN_YEARS_MS = 10 * 365 * 86400000;
    if (parsedMs == null || parsedMs > now + 86400000 || parsedMs < now - TEN_YEARS_MS) {
      return new Date().toISOString();
    }
    return new Date(parsedMs).toISOString();
  }

  return { extractPost: extractPost };

})();
