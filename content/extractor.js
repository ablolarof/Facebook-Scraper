// content/extractor.js — DOM extraction
//
// === Fix 2: div[dir="auto"] body-text fallback (2026-05-29) =====================
// Posts with no data-ad-* message element (the missing cluster confirmed by
// DIAGNOSIS_AND_FIX_REPORT.md §5 RC1) previously extracted empty text. This
// version falls back to the largest div[dir="auto"] block in the card when
// SEL.postText finds nothing. Author names and other dir=auto labels are far
// shorter than the post body, so "largest by text length" reliably lands on the
// prose (verified on a Florentin 2.5-room rental: len ~324, newline-ratio ~0.03).
//
// Fix 3 (slug/numeric permalink for the Open button) is NOT applied here.
// See DIAGNOSIS_AND_FIX_REPORT.md §7 Fix 3 for the spec.
// ================================================================================
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
      // Groups-feed timestamp links use ?multi_permalinks=POST_ID instead of /posts/
      'a[href*="multi_permalinks="]:not([href*="comment_id"])',
      // Photo-album links: ?set=pcb.POST_ID — the numeric ID after pcb. IS the parent post ID.
      // Note: /videos/<user>/pcb.<id>/ path-style links (Reels) don't match because
      // they lack the "set=" prefix, so this selector does not re-introduce Reels pollution.
      'a[href*="set=pcb."]',
      // Home-feed group posts use ?set=gm.POST_ID&idorvanity=GROUP_ID on photo links.
      // gm = "group media" — same concept as pcb but for the home/aggregated feed renderer.
      'a[href*="set=gm."]',
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
      'a[href*="multi_permalinks="]',
      'a[href*="set=pcb."]',
      'a[href*="set=gm."]',
    ].join(', '),

    // Full post body text. Three rendering paths:
    //   data-ad-preview="message"       — legacy renderer (individual group pages)
    //   data-ad-comet-preview="message" — Comet renderer (same pages, newer build)
    //   data-ad-rendering-role="story_message" — aggregated /groups/feed/ renderer
    //
    // The :not(:has(…)) guard prevents matching the story_message wrapper when a
    // legacy element is nested inside it, so querySelector always returns the most
    // specific (innermost) element and innerText captures only the post body.
    // Requires Chrome 105+ for :has() — all supported Chromium builds qualify.
    postText: [
      '[data-ad-preview="message"]',
      '[data-ad-comet-preview="message"]',
      '[data-ad-rendering-role="story_message"]' +
        ':not(:has([data-ad-preview="message"],[data-ad-comet-preview="message"]))',
    ].join(', '),

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
    // Fix 2: prefer the data-ad-* message element; if absent/empty (anchor-less
    // posts whose body is a plain div[dir="auto"]), fall back to the largest
    // div[dir="auto"] block in the card. Using querySelector directly (not find())
    // avoids spurious "Selector miss" warnings for this now-expected case.
    const textEl = cardEl.querySelector(SEL.postText);
    let text     = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';
    // Anchor missing, OR anchor is just a shared-link preview URL (the post's
    // prose then lives in a plain div[dir="auto"]) → use the largest NON-COMMENT
    // dir=auto block. Comment text (role="article" subtrees) is never the body.
    if (!text || /^https?:\/\/\S+$/.test(text)) {
      const prose = pickFallbackBodyText(cardEl);
      if (prose) text = prose;
    }

    // Author link. On the aggregated /groups/feed/, the cardEl that scroller
    // returns is often narrow (the body/image scope) and excludes the post
    // header — so the /groups/<gid>/user/<uid>/ author anchor lives in a
    // wider ancestor. Walk up looking for it, capped at 8 levels to avoid
    // crossing into neighbouring cards. This also makes the pcb-permalink
    // branch below able to derive the group ID from the author URL.
    let authorEl = pickAuthorLink(cardEl);
    if (!authorEl) {
      let ancestor = cardEl.parentElement;
      for (let _ai = 0; _ai < 8 && ancestor && ancestor !== document.body; _ai++) {
        authorEl = pickAuthorLink(ancestor);
        if (authorEl) break;
        ancestor = ancestor.parentElement;
      }
    }
    const author_name        = authorEl ? authorEl.textContent.trim() : '';
    const author_profile_url = authorEl ? authorEl.href : '';

    // ── Permalink & post_id ────────────────────────────────────────────────
    // pickPermalink applies the in-group preference: on a specific group page
    // it requires the captured URL to either match the current group or be a
    // Marketplace/commerce listing. Cross-card pollution (recommended widgets,
    // links to OTHER groups, cross-post originals) is rejected here. Walk-up
    // depth 20 matches scroller.js's MAX_WALK_UP so they stay in sync.
    let permalinkEl = pickPermalink(cardEl, pageGroupId);
    // Walk-up boundary: never scan up into the role="feed" container. With
    // feed-child detection cardEl's parent IS the feed, which holds EVERY post
    // — scanning it grabs a NEIGHBOUR's /posts/ link and stamps the same id on
    // every commentless post (confirmed live: 12+ posts → 1 id, mutual
    // overwrite). The whole post already lives inside cardEl; a card with no
    // permalink here is a commentless post that correctly falls through to the
    // author+text hash id below. On surfaces with no role="feed" (legacy Path-2),
    // _feedEl is null and the walk-up behaves exactly as before.
    var _feedEl = cardEl.closest('[role="feed"]');
    if (!permalinkEl) {
      let ancestor = cardEl.parentElement;
      for (var _i = 0; _i < 20 && ancestor && ancestor !== document.body; _i++) {
        if (_feedEl && ancestor.contains(_feedEl)) break;  // reached/passed the feed → stop
        permalinkEl = pickPermalink(ancestor, pageGroupId);
        if (permalinkEl) break;
        ancestor = ancestor.parentElement;
      }
    }

    // On a specific group page, pickPermalink deliberately skips pcb image links
    // so the walk-up above can reach the card-header ancestor containing the real
    // /posts/ timestamp link. If the walk-up exhausted all ancestors without
    // finding a proper /posts/ link, fall back to pcb (the photo-album ID encodes
    // the real post ID for posts that genuinely have no /posts/ anchor in the DOM).
    if (!permalinkEl && pageGroupId && pageGroupId !== 'feed') {
      var _pcbScope = cardEl;
      outer: for (var _pci = 0; _pci <= 8 && _pcbScope && _pcbScope !== document.body; _pci++) {
        // Same feed-boundary guard as the permalink walk-up above: don't scan a
        // pcb/gm link out of a neighbouring post in the shared feed container.
        if (_feedEl && _pcbScope !== cardEl && _pcbScope.contains(_feedEl)) break;
        var _pcbLinks = Array.from(_pcbScope.querySelectorAll('a[href*="set=pcb."], a[href*="set=gm."]'));
        for (var _pcbi = 0; _pcbi < _pcbLinks.length; _pcbi++) {
          try {
            var _pcbU   = new URL(_pcbLinks[_pcbi].href || '', location.origin);
            var _pcbSet = _pcbU.searchParams.get('set');
            if (_pcbSet && (_pcbSet.startsWith('pcb.') || _pcbSet.startsWith('gm.'))) {
              permalinkEl = _pcbLinks[_pcbi]; break outer;
            }
          } catch (_) {}
        }
        _pcbScope = _pcbScope.parentElement;
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
                      || probe.searchParams.has('story_fbid')
                      || probe.searchParams.has('multi_permalinks')
                      || (probe.searchParams.has('set') && (probe.searchParams.get('set') || '').startsWith('pcb.'))
                      || (probe.searchParams.has('set') && (probe.searchParams.get('set') || '').startsWith('gm.'));
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
          const multiPL  = u.searchParams.get('multi_permalinks');
          const setParam = u.searchParams.get('set');
          const pcbId    = (setParam && setParam.startsWith('pcb.')) ? setParam.slice(4) : null;
          const gmId     = (setParam && setParam.startsWith('gm.'))  ? setParam.slice(3)  : null;
          if (multiPL) {
            // Timestamp links on /groups/feed/ use ?multi_permalinks=POST_ID.
            // Convert to canonical /groups/GROUP_ID/posts/POST_ID/ using the
            // source group link visible in the same card. Falls back to
            // keeping the ?multi_permalinks= param when no group ID is found.
            let gid = (pageGroupId && pageGroupId !== 'feed') ? pageGroupId : null;
            if (!gid) {
              const glEl = cardEl.querySelector(SEL.sourceGroupLink);
              if (glEl) {
                const gm = (glEl.href || '').match(/\/groups\/([^/?#]+)/);
                if (gm) gid = gm[1];
              }
            }
            if (gid) {
              permalink = 'https://www.facebook.com/groups/' + gid + '/posts/' + multiPL + '/';
            } else {
              permalink = u.origin + u.pathname + '?multi_permalinks=' + multiPL;
            }
          } else if (pcbId) {
            // Photo-album links (?set=pcb.POST_ID) — the numeric ID after pcb. IS
            // the parent post ID. Build a canonical group permalink using whatever
            // group-ID signal we can find: page URL > author link > source group
            // link > walk-up looking for any /groups/<id>/ anchor.
            let gid = (pageGroupId && pageGroupId !== 'feed') ? pageGroupId : null;
            if (!gid) {
              const gm = author_profile_url.match(/\/groups\/([^/?#]+)\//);
              if (gm && gm[1] !== 'feed') gid = gm[1];
            }
            if (!gid) {
              const glEl = cardEl.querySelector(SEL.sourceGroupLink);
              if (glEl) {
                const gm2 = (glEl.href || '').match(/\/groups\/([^/?#]+)/);
                if (gm2 && gm2[1] !== 'feed') gid = gm2[1];
              }
            }
            if (!gid) {
              // Last-resort: walk up from cardEl looking for ANY anchor whose
              // href is /groups/<id>/… (author link, profile-name title, etc.).
              // The L6 dump for an Itamar Berkowicz post shows four such anchors
              // in the wider card scope even though cardEl is narrower than that.
              // Depth-capped to 8 to avoid bleeding into a neighbouring card.
              let ancestor = cardEl;
              for (let _pi = 0; _pi < 8 && ancestor && ancestor !== document.body; _pi++) {
                const groupA = ancestor.querySelector('a[href*="/groups/"]');
                if (groupA) {
                  const gm3 = (groupA.getAttribute('href') || '').match(/\/groups\/([^/?#]+)/);
                  if (gm3 && gm3[1] !== 'feed') { gid = gm3[1]; break; }
                }
                ancestor = ancestor.parentElement;
              }
            }
            if (gid) {
              permalink = 'https://www.facebook.com/groups/' + gid + '/posts/' + pcbId + '/';
            } else {
              // No group ID found anywhere — keep the photo-set URL as a last resort.
              permalink = u.origin + u.pathname + '?set=' + encodeURIComponent(setParam);
            }
          } else if (gmId) {
            // Home-feed group posts use ?set=gm.POST_ID&idorvanity=GROUP_ID.
            // The idorvanity param directly encodes the group, so no DOM walk needed
            // in the common case.
            let gid = (pageGroupId && pageGroupId !== 'feed') ? pageGroupId : null;
            if (!gid) {
              const idor = u.searchParams.get('idorvanity');
              if (idor) gid = idor;
            }
            if (!gid) {
              const gmA = author_profile_url.match(/\/groups\/([^/?#]+)\//);
              if (gmA && gmA[1] !== 'feed') gid = gmA[1];
            }
            if (!gid) {
              let ancestor = cardEl;
              for (let _gmi = 0; _gmi < 8 && ancestor && ancestor !== document.body; _gmi++) {
                const groupA = ancestor.querySelector('a[href*="/groups/"]');
                if (groupA) {
                  const gmB = (groupA.getAttribute('href') || '').match(/\/groups\/([^/?#]+)/);
                  if (gmB && gmB[1] !== 'feed') { gid = gmB[1]; break; }
                }
                ancestor = ancestor.parentElement;
              }
            }
            if (gid) {
              permalink = 'https://www.facebook.com/groups/' + gid + '/posts/' + gmId + '/';
            } else {
              permalink = u.origin + u.pathname + '?set=' + encodeURIComponent(setParam);
            }
          } else {
            ['comment_id', 'reply_comment_id', 'ref', 'mibextid'].forEach(function (p) {
              u.searchParams.delete(p);
            });
            permalink = u.origin + u.pathname;
            if (!permalink.endsWith('/')) permalink += '/';
          }
        } catch (_) { permalink = rawHref; }

        // The post_id link may not BE the timestamp link (e.g. it's the
        // post-image anchor whose aria-label is alt text). findPostedAt
        // walks the card's anchors and picks the first whose text parses as
        // a relative time, so we get the actual post-header timestamp.
        posted_at = findPostedAt(cardEl, permalinkEl) || new Date().toISOString();
      }
    }

    // Comment-link recovery: before hashing, see if any COMMENT in this card
    // exposes the parent post id (…/posts/<id>/?comment_id=…). This rescues
    // posts that have comments but no own timestamp permalink — and sidesteps
    // the slug-vs-numeric rejection, because we rebuild the URL with the known
    // numeric pageGroupId rather than trusting the link's group token.
    if (!permalinkEl) {
      const recovered = pickPostIdFromComments(cardEl);
      if (recovered) {
        post_id = recovered.postId;
        let gid = (pageGroupId && pageGroupId !== 'feed') ? pageGroupId : null;
        if (!gid) {
          const gm = (author_profile_url || '').match(/\/groups\/([^/?#]+)\//);
          if (gm && gm[1] !== 'feed') gid = gm[1];
        }
        if (!gid) gid = recovered.groupToken;   // last resort: the slug from the comment href
        permalink = gid
          ? 'https://www.facebook.com/groups/' + gid + '/posts/' + recovered.postId + '/'
          : '';
        posted_at = findPostedAt(cardEl, null) || new Date().toISOString();
      }
    }

    if (!permalinkEl && !post_id) {
      // No usable permalink and no comment-recoverable id — hash author + first
      // 200 chars of text so the same post yields the same post_id on subsequent
      // scrapes (dedup).
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
        const anchorTypes = { posts: 0, permalink: 0, story_fbid: 0, share_p: 0, videos: 0, commerce: 0, marketplace: 0, multi_permalinks: 0, pcb_set: 0, gm_set: 0, other: 0 };
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
          else if (h.indexOf('multi_permalinks=')    !== -1) anchorTypes.multi_permalinks++;
          else if (h.indexOf('set=pcb.')             !== -1) anchorTypes.pcb_set++;
          else if (h.indexOf('set=gm.')              !== -1) anchorTypes.gm_set++;
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
    // Exclude images inside comments (role="article") so commenter avatars and
    // comment photos don't pollute image_urls (dedup keys on the first image).
    // Safe degradation: if filtering leaves none, keep all matches.
    let _imgEls = SEL.images ? Array.from(cardEl.querySelectorAll(SEL.images)) : [];
    const _nonCommentImgs = _imgEls.filter(img => !img.closest('[role="article"]'));
    if (_nonCommentImgs.length) _imgEls = _nonCommentImgs;
    const image_urls = _imgEls
      .map(img => img.src)
      .filter(src => src && !src.includes('emoji') && !src.includes('reaction'));

    // ── Source group (feed page only) ──────────────────────────────────────
    let group_id   = pageGroupId;
    let group_name = pageGroupName;

    if (!pageGroupId && SEL.sourceGroupLink) {
      // Search within cardEl first, then walk up. On the aggregated /groups/feed/
      // the post header (profile_name → h3 a group link) can sit one ancestor
      // above the tight card boundary the scroller returns. Stop before crossing
      // into a multi-post ancestor so we don't pick up a neighbouring card's group.
      let groupLinkEl = cardEl.querySelector(SEL.sourceGroupLink);
      if (!groupLinkEl) {
        let ancestor = cardEl.parentElement;
        for (let _gi = 0; _gi < 8 && ancestor && ancestor !== document.body; _gi++) {
          if (ancestor.querySelectorAll(SEL.postText).length > 1) break;
          groupLinkEl = ancestor.querySelector(SEL.sourceGroupLink);
          if (groupLinkEl) break;
          ancestor = ancestor.parentElement;
        }
      }
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

  // Fix 2: fallback body text for posts with no data-ad-* message element.
  // Their prose renders as a plain div[dir="auto"]. The author name and other
  // dir=auto labels are much shorter than the post body, so the largest block
  // reliably lands on the prose.
  // Verified: a Florentin rental the body-anchor scraper missed had its prose in
  // div[dir="auto"], len ~324, clean Hebrew (newline-ratio ~0.03).
  function pickFallbackBodyText(cardEl) {
    const blocks = cardEl.querySelectorAll('div[dir="auto"]');
    let best = '', bestLen = 0;          // largest NON-COMMENT block (the post body)
    let bestAny = '', bestAnyLen = 0;    // largest overall (safe degradation)
    for (let i = 0; i < blocks.length; i++) {
      const t = (blocks[i].innerText || '').trim();
      if (t.length > bestAnyLen) { bestAnyLen = t.length; bestAny = t; }
      if (blocks[i].closest('[role="article"]')) continue;   // skip comment text
      if (t.length > bestLen) { bestLen = t.length; best = t; }
    }
    return best || bestAny;
  }

  // Pick the post author's profile link. Facebook renders 2–3 anchors to the same
  // /user/ id in a post header: an avatar-wrapper link (empty text) and the name
  // link. A plain querySelector grabs the empty avatar link → empty author_name
  // (observed on group 327483250942). Prefer the first NON-COMMENT author link
  // that actually has text; fall back to the first non-comment link so the
  // profile URL is never lost.
  function pickAuthorLink(scopeEl) {
    const links = scopeEl.querySelectorAll(SEL.authorLink);
    let firstNonComment = null;
    for (let i = 0; i < links.length; i++) {
      if (links[i].closest('[role="article"]')) continue;    // skip commenter links
      if (!firstNonComment) firstNonComment = links[i];
      if ((links[i].textContent || '').trim()) return links[i];
    }
    return firstNonComment;
  }

  // Pick the best permalink anchor inside scopeEl.
  //
  // NOTE (Fix 3, not yet applied): on a specific group page this rejects a
  // valid /posts/ link when the page URL's group token (numeric ID) differs
  // from the link's token (vanity slug). The symptom is a disabled Open button.
  // Fix: also accept a candidate whose aria-label / textContent parses as a
  // relative timestamp via parseRelativeTime() — that is the post's own
  // timestamp permalink by definition, regardless of slug vs numeric.
  // See DIAGNOSIS_AND_FIX_REPORT.md §7 Fix 3.
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
      // pcb and gm image links are intentionally NOT returned here on a specific
      // group page. A reused branding image (e.g. a company logo first uploaded in
      // 2017) carries ?set=pcb.OLD_POST_ID — the album ID from the ORIGINAL post,
      // not the current one. The same reasoning applies to gm. links. The image
      // anchor appears in the card body scope while the real /posts/CURRENT_ID
      // timestamp link lives in the card header (a wider ancestor). Returning a
      // photo-album link here would stop the walk-up in extractPost before it
      // reaches that header. Both pcb and gm are tried as last resort in
      // extractPost only after the full walk-up has run without finding a /posts/.
    }
    return null;
  }

  // Comment-link recovery (read-only) for posts that have comments but no own
  // timestamp permalink. Every comment's timestamp href encodes the PARENT post
  // id in its path:
  //   /groups/<gid>/posts/<POST_ID>/?comment_id=…
  //   /groups/<gid>/permalink/<POST_ID>/?comment_id=…
  // cardEl is a single feed-child (one post), so every comment inside it belongs
  // to THIS post — the MODE post id is unambiguously the post's own (robust if a
  // comment quotes another post's link). Validated live on group 327483250942:
  // 0 collisions across 81 posts. Returns { postId, groupToken } or null.
  //
  // This resolves the slug-vs-numeric rejection (report RC2): the comment href
  // carries the vanity slug (…/groups/secrettelaviv/posts/…) which pickPermalink
  // rejects against the numeric page-URL group id, even though it's the same group.
  function pickPostIdFromComments(cardEl) {
    const counts = Object.create(null);
    const gidFor = Object.create(null);
    const links  = cardEl.querySelectorAll('a[href*="comment_id"]');
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute('href') || '';
      const m = href.match(/\/(?:posts|permalink)\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      counts[id] = (counts[id] || 0) + 1;
      if (!gidFor[id]) {
        const gm = href.match(/\/groups\/([^/?#]+)\//);
        if (gm) gidFor[id] = gm[1];
      }
    }
    let bestId = null, bestN = 0;
    for (const id in counts) if (counts[id] > bestN) { bestN = counts[id]; bestId = id; }
    return bestId ? { postId: bestId, groupToken: gidFor[bestId] || null } : null;
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
      const multiPL = u.searchParams.get('multi_permalinks');
      if (multiPL) return multiPL;
      const setParam = u.searchParams.get('set');
      if (setParam && setParam.startsWith('pcb.')) return setParam.slice(4);
      if (setParam && setParam.startsWith('gm.'))  return setParam.slice(3);
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

    // Keep in sync with SEL.postText above — used here only to count distinct
    // posts in the widening scope so we stop before reading a neighbour's timestamp.
    const POST_TEXT_SEL = SEL.postText;
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

    // Guard: a genuine relative timestamp label is short ("4h", "3 days ago").
    // A shared-link preview or post body that merely CONTAINS a time-like token
    // (e.g. "bDeRbb5y.com…" → "5y") is long. findPostedAt scans every <a> in the
    // card and takes the FIRST that parses, so without this a link-preview anchor
    // can win and stamp a bogus date (observed: a post dated 1825d = 5×365 ago
    // because its ticket-link URL contained "bb5y"). 48 chars covers all real
    // formats including absolute dates like "Tuesday, May 24 at 7:18 PM".
    if (label.length > 48) return null;

    // Order matters: 'mo'/'mon'/'month' must match BEFORE plain 'm' (minutes),
    // and 'y'/'yr'/'year' likewise. Months approximated as 30 days, years as
    // 365 days — close enough for a "when was this listed" filter.
    //
    // (?<![a-z0-9./]) — the number must not be glued to a letter/digit or sit
    // right after "/" or ".", so URL/ID fragments ("bb5y", "url2d", "bit.ly/3h")
    // are not misread as durations. Real timestamps never have those before the
    // number; standalone tokens ("5y", "2d") still match.
    let parsedMs = null;
    const mYears  = label.match(/(?<![a-z0-9./])(\d+)\s*y(?:r|ear)?s?\b/);
    if (mYears)  parsedMs = now - parseInt(mYears[1])  * 31536000000;
    const mMonths = label.match(/(?<![a-z0-9./])(\d+)\s*mo(?:n|nth)?s?\b/);
    if (parsedMs == null && mMonths) parsedMs = now - parseInt(mMonths[1]) * 2592000000;
    const mWeeks  = label.match(/(?<![a-z0-9./])(\d+)\s*w(?:k|eek)?s?\b/);
    if (parsedMs == null && mWeeks)  parsedMs = now - parseInt(mWeeks[1])  * 604800000;
    const mDays   = label.match(/(?<![a-z0-9./])(\d+)\s*d(?:ay)?s?\b/);
    if (parsedMs == null && mDays)   parsedMs = now - parseInt(mDays[1])   * 86400000;
    const mHours  = label.match(/(?<![a-z0-9./])(\d+)\s*h(?:r|our)?s?\b/);
    if (parsedMs == null && mHours)  parsedMs = now - parseInt(mHours[1])  * 3600000;
    const mMins   = label.match(/(?<![a-z0-9./])(\d+)\s*m(?:in|inute)?s?\b/);
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
