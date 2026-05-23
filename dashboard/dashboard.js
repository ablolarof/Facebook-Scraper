// dashboard/dashboard.js — Dashboard controller
//
// Runs at chrome-extension://[id]/dashboard/dashboard.html, so it shares
// IndexedDB with background.js (same extension origin). Reads + updates posts
// directly via lib/db.js; routes Gemini classification through background.js
// (the service worker has the host_permissions to reach generativelanguage.googleapis.com).
//
// Filtering is done in JS on the already-loaded array — no round-trips to
// storage on each filter change.

import {
  getAllPosts,
  updatePostStatus,
  exportAllJSON,
  savePost,
  deletePost,
} from '../lib/db.js';

let allPosts      = [];   // every record from IndexedDB
let filteredPosts = [];   // subset after applying sidebar filters
const expandedPostIds = new Set(); // post_ids whose full text is currently visible

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadPosts();
  buildNeighborhoodCheckboxes();
  applyFilters();
  bindControls();
});

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadPosts() {
  allPosts = await getAllPosts();
  allPosts.sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));
}

// ── Filter logic ──────────────────────────────────────────────────────────────
function readFilters() {
  const statuses          = checkedValues('status');
  const labels            = checkedValues('label');        // 'rental' | 'not_rental' | 'unlabeled'
  const labelSources      = checkedValues('label-source'); // 'human' | 'ai'
  const days              = parseInt(el('days-filter').value) || 30;
  const searchText        = el('text-search').value.trim().toLowerCase();
  const showDupes         = el('show-dupes').checked;
  const sort              = el('sort-by').value;
  const priceMin          = parseFloat(el('price-min').value)  || null;
  const priceMax          = parseFloat(el('price-max').value)  || null;
  const roomsMin          = parseFloat(el('rooms-min').value)  || null;
  const roomsMax          = parseFloat(el('rooms-max').value)  || null;
  const roommatesFilter    = checkedValues('roommates-filter'); // [] = no filter (show all)
  const brokerFilter       = checkedValues('broker-filter');    // [] = no filter (show all)
  const entryDateFrom      = el('entry-date-from').value || null;  // 'YYYY-MM-DD' or null
  const entryDateTo        = el('entry-date-to').value   || null;
  const entryDateUnknown   = el('entry-date-unknown').checked;
  const entryDateImmediate = el('entry-date-immediate').checked;
  const neighborhoodFilter = checkedValues('neighborhood-filter'); // empty = no filter active
  return { statuses, labels, labelSources, days, searchText, showDupes,
           sort, priceMin, priceMax, roomsMin, roomsMax,
           roommatesFilter, brokerFilter,
           entryDateFrom, entryDateTo, entryDateUnknown, entryDateImmediate,
           neighborhoodFilter };
}

function checkedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(el => el.value);
}

// Returns 'rental' | 'not_rental' | 'unlabeled' for a post, honouring the
// label-source filter. If the user unchecked "AI-labeled", AI labels are
// ignored when categorising (the post falls through to 'unlabeled' unless a
// human label exists).
function effectiveLabel(post, sources) {
  if (sources.includes('human') && post.human_label) return post.human_label;
  if (sources.includes('ai')    && post.ai_label)    return post.ai_label;
  return 'unlabeled';
}

function applyFilters() {
  const f        = readFilters();
  const cutoffMs = Date.now() - f.days * 86400 * 1000;

  filteredPosts = allPosts.filter(p => {
    if (!f.statuses.includes(p.status || 'new')) return false;
    if (!f.showDupes && p.is_duplicate) return false;
    if (!f.labels.includes(effectiveLabel(p, f.labelSources))) return false;
    if (f.searchText && !(p.text || '').toLowerCase().includes(f.searchText)) return false;

    // Use the LATER of posted_at and scraped_at so a freshly-scraped post is
    // never filtered out just because Facebook's "Xy ago" string parsed wrong.
    // The "Posted within N days" label is approximate — a recently-saved post
    // should always be visible regardless of FB's reported posting age.
    const postedTs  = p.posted_at  ? new Date(p.posted_at).getTime()  : 0;
    const scrapedTs = p.scraped_at ? new Date(p.scraped_at).getTime() : 0;
    const ts = Math.max(postedTs, scrapedTs);
    if (ts && ts < cutoffMs) return false;

    // ── Tag-based filters (skip posts with no tags when a tag filter is active) ──
    if (f.priceMin !== null) {
      if (p.tags?.price == null || p.tags.price < f.priceMin) return false;
    }
    if (f.priceMax !== null) {
      if (p.tags?.price == null || p.tags.price > f.priceMax) return false;
    }
    if (f.roomsMin !== null) {
      if (p.tags?.rooms == null || p.tags.rooms < f.roomsMin) return false;
    }
    if (f.roomsMax !== null) {
      if (p.tags?.rooms == null || p.tags.rooms > f.roomsMax) return false;
    }
    // Roommates — checkboxes; empty selection = no filter
    if (f.roommatesFilter.length > 0) {
      const rm = p.tags?.roommates ?? null;
      const match =
        (f.roommatesFilter.includes('yes')     && rm === true)  ||
        (f.roommatesFilter.includes('no')      && rm === false) ||
        (f.roommatesFilter.includes('unknown') && rm === null);
      if (!match) return false;
    }

    // Broker fee — same pattern
    if (f.brokerFilter.length > 0) {
      const br = p.tags?.broker ?? null;
      const match =
        (f.brokerFilter.includes('yes')     && br === true)  ||
        (f.brokerFilter.includes('no')      && br === false) ||
        (f.brokerFilter.includes('unknown') && br === null);
      if (!match) return false;
    }

    // Entry date — date range + include-unknown / include-immediate toggles.
    // Filter is active if a range bound is set OR either toggle is turned off.
    {
      const hasRange = f.entryDateFrom || f.entryDateTo;
      const active   = hasRange || !f.entryDateUnknown || !f.entryDateImmediate;
      if (active) {
        const d = p.tags?.entry_date ?? null;
        if (d === null) {
          if (!f.entryDateUnknown) return false;
        } else if (d === 'immediate') {
          if (!f.entryDateImmediate) return false;
        } else if (hasRange) {
          // d is a 'YYYY-MM-DD' string — lexicographic comparison works correctly.
          if (f.entryDateFrom && d < f.entryDateFrom) return false;
          if (f.entryDateTo   && d > f.entryDateTo)   return false;
        }
      }
    }

    // Neighborhood multi-select: '__unknown__' matches posts where tags exist but neighborhood is null.
    if (f.neighborhoodFilter.length > 0) {
      const n = p.tags?.neighborhood || null;
      const matched = f.neighborhoodFilter.includes(n) ||
                      (n === null && p.tags && f.neighborhoodFilter.includes('__unknown__'));
      if (!matched) return false;
    }

    return true;
  });

  // ── Sort ────────────────────────────────────────────────────────────────────
  filteredPosts.sort((a, b) => {
    switch (f.sort) {
      case 'oldest':     return (a.scraped_at || '').localeCompare(b.scraped_at || '');
      case 'price-asc':  return sortNullsLast(a.tags?.price, b.tags?.price,  1);
      case 'price-desc': return sortNullsLast(a.tags?.price, b.tags?.price, -1);
      case 'rooms-asc':  return sortNullsLast(a.tags?.rooms, b.tags?.rooms,  1);
      case 'rooms-desc': return sortNullsLast(a.tags?.rooms, b.tags?.rooms, -1);
      default:           return (b.scraped_at || '').localeCompare(a.scraped_at || '');
    }
  });

  renderCards();
  updateResultCount();
}

// Numeric sort that pushes nulls to the end regardless of direction.
function sortNullsLast(a, b, dir) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * dir;
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function renderCards() {
  const grid  = el('card-grid');
  const empty = el('empty-state');

  if (filteredPosts.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = filteredPosts.map(cardHTML).join('');
}

function cardHTML(post) {
  const thumb = post.image_urls?.[0]
    ? `<img class="card-thumb" src="${esc(post.image_urls[0])}" alt="" loading="lazy">`
    : `<div class="card-thumb card-thumb--placeholder">No image</div>`;

  // Strip Facebook's own "See more" / "See less" / "ראה עוד" suffix that the
  // scraper captures when the expander button sits inside the text container.
  // After our expandSeeMore() click the button label switches to "See less",
  // so we strip both variants (and their Hebrew equivalents).
  const cleanText = (post.text || '')
    .replace(/[\s…]*\.{0,3}\s*(?:see more|see less|ראה עוד|ראה פחות|הצג עוד|הצג פחות|עוד)[\s.…]*$/i, '')
    .trimEnd();

  // Show "Show more" if there's enough content to plausibly overflow 3 lines:
  // either the raw text is longer than 120 chars OR the post has 3+ lines.
  const isLong     = cleanText.length > 120 || cleanText.split('\n').length >= 3;
  const isExpanded = expandedPostIds.has(post.post_id);

  // Single .card-text element; CSS line-clamp:3 provides the preview.
  // Adding the .expanded class removes the clamp so the full text shows.
  // The button sits as a sibling so RTL bidi cannot affect it.
  const textBlock = isLong
    ? `<div class="card-text${isExpanded ? ' expanded' : ''}">${esc(cleanText)}</div>
       <button class="btn-see-more" data-action="toggle-text" data-id="${esc(post.post_id)}">${isExpanded ? 'Show less ▲' : 'Show more ▼'}</button>`
    : `<div class="card-text expanded">${esc(cleanText)}</div>`;

  // Use the later of posted_at / scraped_at so a bogus old posted_at (parsed
  // wrong from FB's aria-label) doesn't render as "9148d ago" on the card.
  const timeAgo     = relativeTime(bestDisplayTime(post));
  const statusClass = `status-${post.status || 'new'}`;
  const dupeTag     = post.is_duplicate ? '<span class="tag tag--dupe">Dupe</span>' : '';

  // Pick the most authoritative badge to show on the card.
  let labelTag = '<span class="tag tag--unlabeled">Unlabeled</span>';
  if (post.human_label === 'rental')          labelTag = '<span class="tag tag--rental-human" title="You marked this as rental">✓ Rental</span>';
  else if (post.human_label === 'not_rental') labelTag = '<span class="tag tag--not-rental-human" title="You marked this as not rental">✗ Not rental</span>';
  else if (post.ai_label === 'rental')        labelTag = '<span class="tag tag--rental-ai" title="Gemini labeled this as rental">AI: Rental</span>';
  else if (post.ai_label === 'not_rental')    labelTag = '<span class="tag tag--not-rental-ai" title="Gemini labeled this as not rental">AI: Not rental</span>';

  // Highlight whichever label button matches the current human label.
  const rentalActive    = post.human_label === 'rental'     ? ' active' : '';
  const notRentalActive = post.human_label === 'not_rental' ? ' active' : '';

  const id = esc(post.post_id);

  // Detail pills from extracted tags + ✏ edit button.
  // The ✏ button appears on all rental posts so the user can add/correct tags
  // even before Gemini has extracted them. Corrections are stored as
  // tags_human_override and fed back to Gemini as few-shot examples.
  const isRental = post.human_label === 'rental' || post.ai_label === 'rental';
  let tagsRow = '';
  if (isRental) {
    const pills = [];
    if (post.tags) {
      const t = post.tags;
      if (t.price        != null) pills.push(`<span class="detail-pill">₪${t.price.toLocaleString()}</span>`);
      if (t.rooms        != null) pills.push(`<span class="detail-pill">${t.rooms} חד'</span>`);
      if (t.size         != null) pills.push(`<span class="detail-pill">${t.size} מ"ר</span>`);
      if (t.neighborhood) {
        const lowConf  = t.neighborhood_confidence === 'low';
        const nClass   = lowConf ? 'detail-pill detail-pill--neighborhood-low' : 'detail-pill';
        const nTitle   = t.neighborhood_evidence
          ? ` title="${esc(t.neighborhood_evidence)}"`
          : (lowConf ? ' title="Low confidence"' : '');
        pills.push(`<span class="${nClass}"${nTitle}>${esc(t.neighborhood)}</span>`);
      } else {
        pills.push('<span class="detail-pill detail-pill--unknown">? Neighborhood</span>');
      }
      if (t.roommates === true)   pills.push(`<span class="detail-pill detail-pill--roommates">Roommates</span>`);
      if (t.broker === true)      pills.push(`<span class="detail-pill detail-pill--broker" title="דמי תיווך">Broker fee</span>`);
      if (t.broker === false)     pills.push(`<span class="detail-pill detail-pill--no-broker" title="ללא דמי תיווך">No broker fee</span>`);
      if (t.entry_date) {
        const dateLabel = t.entry_date === 'immediate' ? 'Immediate' : formatEntryDate(t.entry_date);
        pills.push(`<span class="detail-pill">${esc(dateLabel)}</span>`);
      }
      if (post.tags_human_override) {
        pills.push('<span class="detail-pill detail-pill--corrected" title="Tags manually corrected">✓ Corrected</span>');
      }
    }
    tagsRow = `
<div class="card-tags">
  ${pills.join('')}
  <button class="btn-edit-tags" data-action="edit-tags" data-id="${id}" title="Add / correct tags — your fixes feed back to Gemini">✏</button>
</div>`;
  }

  return `
<div class="card ${statusClass}" data-id="${id}">
  <div class="card-img-wrap">${thumb}</div>
  <div class="card-body">
    <div class="card-meta">
      <span class="card-group" title="${esc(post.group_name || post.group_id || '')}">${esc(post.group_name || post.group_id || '?')}</span>
      <span class="card-time">${timeAgo}</span>
      ${dupeTag}${labelTag}
    </div>
    ${textBlock}
    ${tagsRow}
    <div class="card-actions-row">
      <button class="btn-action btn-rental${rentalActive}"         data-action="label-rental"     data-id="${id}">Rental</button>
      <button class="btn-action btn-not-rental${notRentalActive}"  data-action="label-not-rental" data-id="${id}">Not rental</button>
    </div>
    <div class="card-actions-row">
      <button class="btn-action btn-interested" data-action="interested" data-id="${id}">Interested</button>
      <button class="btn-action btn-seen"       data-action="seen"       data-id="${id}">Seen</button>
      <button class="btn-action btn-hide"       data-action="hidden"     data-id="${id}">Hide</button>
      <a class="btn-action btn-open" href="${esc(post.permalink || '#')}" target="_blank" rel="noopener noreferrer">Open ↗</a>
    </div>
    <div class="card-actions-row">
      <button class="btn-action btn-dupe${post.is_duplicate ? ' active' : ''}" data-action="toggle-dupe" data-id="${id}" title="Mark as duplicate — hidden from the default view unless 'Duplicates' is checked in the sidebar">⊘ Dupe</button>
      <button class="btn-action btn-delete" data-action="delete" data-id="${id}" title="Permanently remove this post. It will be re-scraped if it still appears on Facebook.">🗑 Delete</button>
    </div>
  </div>
</div>`;
}

function updateResultCount() {
  const labeled   = allPosts.filter(p => p.human_label).length;
  const aiLabeled = allPosts.filter(p => !p.human_label && p.ai_label).length;
  el('result-count').textContent =
    `Showing ${filteredPosts.length} of ${allPosts.length} posts ` +
    `· ${labeled} human-labeled · ${aiLabeled} AI-labeled`;
}

// ── Controls ───────────────────────────────────────────────────────────────────
function bindControls() {
  // Sidebar inputs that should re-filter on change.
  document.querySelectorAll(
    'input[name="status"], input[name="label"], input[name="label-source"], ' +
    'input[name="roommates-filter"], input[name="broker-filter"], ' +
    '#show-dupes, #days-filter, #sort-by, ' +
    '#entry-date-unknown, #entry-date-immediate'
  ).forEach(input => input.addEventListener('change', applyFilters));

  el('entry-date-from').addEventListener('input', applyFilters);
  el('entry-date-to').addEventListener('input',   applyFilters);

  el('text-search').addEventListener('input', applyFilters);
  el('price-min').addEventListener('input', applyFilters);
  el('price-max').addEventListener('input', applyFilters);
  el('rooms-min').addEventListener('input', applyFilters);
  el('rooms-max').addEventListener('input', applyFilters);
  el('reset-filters-btn').addEventListener('click', resetFilters);

  el('refresh-btn').addEventListener('click', async () => {
    el('result-count').textContent = 'Refreshing…';
    await loadPosts();
    buildNeighborhoodCheckboxes();
    applyFilters();
  });

  el('export-btn').addEventListener('click', exportJSON);
  el('classify-btn').addEventListener('click', classifyAndTag);

  // Event delegation for card buttons.
  el('card-grid').addEventListener('click', handleCardClick);
}

async function handleCardClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const postId = btn.dataset.id;
  const action = btn.dataset.action;

  // Pure DOM action — no post lookup needed, must come first.
  if (action === 'toggle-text') {
    const cardBody = btn.closest('.card-body');
    if (!cardBody) return;
    const textEl = cardBody.querySelector('.card-text');
    if (!textEl) return;
    const expanding = !textEl.classList.contains('expanded');
    // Persist expanded state so re-renders don't collapse the card.
    if (expanding) expandedPostIds.add(postId);
    else           expandedPostIds.delete(postId);
    textEl.classList.toggle('expanded', expanding);
    btn.textContent = expanding ? 'Show less ▲' : 'Show more ▼';
    return;
  }

  const post = allPosts.find(p => p.post_id === postId);
  if (!post) return;

  if (action === 'edit-tags') {
    openTagEditor(post, btn.closest('.card'));
    return;
  }

  if (action === 'save-tags') {
    await saveTagEdits(post, btn.closest('.card'));
    return;
  }

  if (action === 'cancel-tags') {
    applyFilters(); // re-render restores pills view
    return;
  }

  if (action === 'delete') {
    await deletePost(postId);
    // Drop from in-memory caches so we don't have to re-fetch from IDB.
    allPosts      = allPosts.filter(p => p.post_id !== postId);
    filteredPosts = filteredPosts.filter(p => p.post_id !== postId);
    expandedPostIds.delete(postId);
    buildNeighborhoodCheckboxes();
    applyFilters();
    return;
  }

  if (action === 'label-rental' || action === 'label-not-rental') {
    const newLabel = action === 'label-rental' ? 'rental' : 'not_rental';
    // Toggle: clicking the same label again clears it.
    post.human_label = post.human_label === newLabel ? null : newLabel;
    await savePost(post);
    applyFilters();

    // When manually marking as rental, kick off tag extraction if not yet done.
    if (post.human_label === 'rental' && !post.tags) {
      chrome.runtime.sendMessage({ type: 'EXTRACT_TAGS', postId: post.post_id })
        .then(result => {
          if (result?.ok && result.tags) {
            post.tags = result.tags;
            applyFilters(); // re-render cards with the new pills
          }
        })
        .catch(() => {}); // fire-and-forget; errors are logged in background
    }
    return;
  }

  if (action === 'toggle-dupe') {
    post.is_duplicate = !post.is_duplicate;
    await savePost(post);
    applyFilters();
    return;
  }

  // Status buttons (interested / seen / hidden) keep their existing behaviour.
  await updatePostStatus(postId, action);
  post.status = action;
  applyFilters();
}

// Replace the .card-tags pill row with an inline edit form.
// Values are seeded from tags_human_override (if a previous correction exists)
// or from the AI-extracted tags.
function openTagEditor(post, cardEl) {
  const tagsDiv = cardEl.querySelector('.card-tags');
  if (!tagsDiv) return;
  const t   = post.tags_human_override || post.tags || {};
  const id  = esc(post.post_id);

  const rmVal     = t.roommates === true  ? 'true'  : t.roommates === false  ? 'false' : '';
  const brokerVal = t.broker    === true  ? 'true'  : t.broker    === false  ? 'false' : '';
  const labelVal  = post.human_label || '';

  tagsDiv.outerHTML = `
<div class="card-tag-editor">
  <div class="tag-editor-row">
    <label>Classification
      <select name="tag-label">
        <option value=""           ${labelVal === ''           ? 'selected' : ''}>— keep current —</option>
        <option value="rental"     ${labelVal === 'rental'     ? 'selected' : ''}>✓ Rental</option>
        <option value="not_rental" ${labelVal === 'not_rental' ? 'selected' : ''}>✗ Not rental</option>
      </select>
    </label>
  </div>
  <div class="tag-editor-row">
    <label>₪/mo<input type="number" name="tag-price"     value="${t.price        ?? ''}" min="0" step="100"></label>
    <label>Rooms<input type="number" name="tag-rooms"     value="${t.rooms        ?? ''}" min="0" step="0.5"></label>
    <label>m²<input   type="number" name="tag-size"      value="${t.size         ?? ''}" min="0"></label>
  </div>
  <div class="tag-editor-row">
    <label class="tag-editor-wide">Neighborhood
      <input type="text" name="tag-neighborhood" value="${esc(t.neighborhood || '')}">
    </label>
  </div>
  <div class="tag-editor-row">
    <label class="tag-editor-wide">Entry date (YYYY-MM-DD or "immediate")
      <input type="text" name="tag-entry-date" value="${esc(t.entry_date || '')}">
    </label>
  </div>
  <div class="tag-editor-row">
    <label>Roommates
      <select name="tag-roommates">
        <option value=""      ${rmVal === ''      ? 'selected' : ''}>Unknown</option>
        <option value="true"  ${rmVal === 'true'  ? 'selected' : ''}>Yes — seeking roommate</option>
        <option value="false" ${rmVal === 'false' ? 'selected' : ''}>No — whole apartment</option>
      </select>
    </label>
    <label>Broker fee
      <select name="tag-broker">
        <option value=""      ${brokerVal === ''      ? 'selected' : ''}>Unknown</option>
        <option value="true"  ${brokerVal === 'true'  ? 'selected' : ''}>Yes — דמי תיווך</option>
        <option value="false" ${brokerVal === 'false' ? 'selected' : ''}>No — ללא תיווך</option>
      </select>
    </label>
  </div>
  <div class="tag-editor-actions">
    <button class="btn-tag-save"   data-action="save-tags"   data-id="${id}">Save &amp; train Gemini</button>
    <button class="btn-tag-cancel" data-action="cancel-tags" data-id="${id}">Cancel</button>
  </div>
</div>`;
}

// Read the editor inputs from the card, persist as tags_human_override,
// and update tags so the pills re-render with the corrected values.
async function saveTagEdits(post, cardEl) {
  const editor = cardEl.querySelector('.card-tag-editor');
  if (!editor) return;

  const num = name => {
    const v = parseFloat(editor.querySelector(`[name="${name}"]`)?.value);
    return isNaN(v) ? null : v;
  };
  const str = name => {
    const v = (editor.querySelector(`[name="${name}"]`)?.value || '').trim();
    return v || null;
  };
  const rmRaw     = editor.querySelector('[name="tag-roommates"]')?.value;
  const roommates = rmRaw === 'true' ? true : rmRaw === 'false' ? false : null;

  const brokerRaw = editor.querySelector('[name="tag-broker"]')?.value;
  const broker    = brokerRaw === 'true' ? true : brokerRaw === 'false' ? false : null;

  const corrected = {
    price:        num('tag-price'),
    rooms:        num('tag-rooms'),
    size:         num('tag-size'),
    neighborhood: str('tag-neighborhood'),
    entry_date:   str('tag-entry-date'),
    roommates,
    broker,
  };

  // Update classification label if the user changed it (trains future classifications).
  const labelVal = editor.querySelector('[name="tag-label"]')?.value;
  if (labelVal === 'rental' || labelVal === 'not_rental') {
    post.human_label = labelVal;
  }

  // Store both: tags (used for display/filters) and tags_human_override
  // (used as few-shot examples in future Gemini extraction calls).
  post.tags                = corrected;
  post.tags_human_override = corrected;
  await savePost(post);
  applyFilters(); // re-render cards to show updated pills + "Corrected" badge
}

// Builds the neighborhood multi-select from distinct values found in IndexedDB.
// Only looks at rental posts that already have extracted tags.
// "Unknown" (pinned last) covers posts where tags exist but neighborhood is null.
function buildNeighborhoodCheckboxes() {
  const seen = new Set();
  let hasUnknown = false;

  allPosts.forEach(p => {
    const label = p.human_label || p.ai_label;
    if (label !== 'rental' || !p.tags) return;
    if (p.tags.neighborhood) seen.add(p.tags.neighborhood);
    else hasUnknown = true;
  });

  const container = el('neighborhood-filters');
  if (seen.size === 0 && !hasUnknown) {
    container.innerHTML = '<em style="font-size:11px;color:#aaa">No tagged posts yet</em>';
    return;
  }

  const sorted = [...seen].sort((a, b) => a.localeCompare(b));
  const rows = sorted.map(n => `
    <label>
      <input type="checkbox" name="neighborhood-filter" value="${esc(n)}">
      ${esc(n)}
    </label>`);

  if (hasUnknown) {
    rows.push(`
    <label>
      <input type="checkbox" name="neighborhood-filter" value="__unknown__">
      Unknown
    </label>`);
  }

  container.innerHTML = rows.join('');
  container.querySelectorAll('input').forEach(i => i.addEventListener('change', applyFilters));
}

function resetFilters() {
  document.querySelectorAll('input[name="status"]').forEach(cb => {
    cb.checked = cb.value === 'new' || cb.value === 'interested';
  });
  document.querySelectorAll('input[name="label"]').forEach(cb => {
    cb.checked = cb.value === 'rental' || cb.value === 'unlabeled';
  });
  document.querySelectorAll('input[name="label-source"]').forEach(cb => cb.checked = true);
  document.querySelectorAll('input[name="roommates-filter"]').forEach(cb => cb.checked = false);
  document.querySelectorAll('input[name="broker-filter"]').forEach(cb => cb.checked = false);
  el('entry-date-from').value          = '';
  el('entry-date-to').value            = '';
  el('entry-date-unknown').checked     = true;
  el('entry-date-immediate').checked   = true;
  el('days-filter').value = '30';
  el('sort-by').value    = 'newest';
  el('text-search').value = '';
  el('price-min').value   = '';
  el('price-max').value          = '';
  el('rooms-min').value          = '';
  el('rooms-max').value          = '';
  el('show-dupes').checked = false;
  document.querySelectorAll('input[name="neighborhood-filter"]').forEach(cb => cb.checked = false);
  applyFilters();
}

async function exportJSON() {
  const json = await exportAllJSON();
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `tlv-rentals-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Classify & Tag (backfill) ──────────────────────────────────────────────────
//
// Combined two-phase operation:
//   Phase 1 — Classify every still-unlabeled post as "rental" or "not_rental".
//   Phase 2 — Extract structured tags (price, rooms, neighborhood…) from every
//              rental post (human or AI labeled) that has no tags yet.
//              This includes posts newly classified in Phase 1 AND any pre-existing
//              rental posts that were missed in earlier runs.
//
// The model fallback chain (gemini-2.5-flash-lite → gemini-2.5-flash) is handled
// inside gemini.js, so both phases benefit from it automatically.
async function classifyAndTag() {
  const unlabeled      = allPosts.filter(p => !p.human_label && !p.ai_label);
  const untaggedRentals = allPosts.filter(p => {
    const label = p.human_label || p.ai_label;
    return label === 'rental' && !p.tags;
  });

  const needsClassify = unlabeled.length > 0;
  const needsTagging  = untaggedRentals.length > 0;

  if (!needsClassify && !needsTagging) {
    alert('Nothing to do — all posts are labeled and all rentals are tagged.');
    return;
  }

  // Build a clear confirm message listing exactly what will happen.
  const lines = [];
  if (needsClassify) lines.push(
    `• Classify ${unlabeled.length} unlabeled post${unlabeled.length !== 1 ? 's' : ''} ` +
    `(new rentals will also get tags extracted)`
  );
  if (needsTagging)  lines.push(
    `• Extract tags from ${untaggedRentals.length} already-labeled rental post${untaggedRentals.length !== 1 ? 's' : ''}`
  );

  if (!confirm(
    `Send to Gemini?\n\n${lines.join('\n')}\n\n` +
    `Posts go to generativelanguage.googleapis.com using your saved API key. ` +
    `Free tier covers ~1,500 requests/day.`
  )) return;

  const btn = el('classify-btn');
  btn.disabled = true;
  const originalCount = el('result-count').textContent;

  let classified = 0, classifyFailed = 0;
  let tagged = 0, tagFailed = 0;
  let dailyQuotaExhausted = false;

  // ── Phase 1: classify unlabeled posts ────────────────────────────────────────
  for (let i = 0; i < unlabeled.length; i++) {
    if (dailyQuotaExhausted) break;

    const post = unlabeled[i];
    el('result-count').textContent =
      `Step 1/2 — Classifying ${i + 1} / ${unlabeled.length}… ` +
      `(${classified} labeled, ${classifyFailed} failed)`;

    let attempts = 0;
    let success  = false;

    while (attempts < 2 && !success) {
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'CLASSIFY_POST',
          postId: post.post_id,
        });

        if (result?.ok && result.label) {
          post.ai_label         = result.label;
          post.ai_classified_at = new Date().toISOString();
          classified++;
          success = true;
        } else {
          const isRateLimit = result?.error &&
            (result.error.includes('429') || result.error.toLowerCase().includes('quota'));

          if (isRateLimit) {
            attempts++;
            if (attempts < 2) {
              el('result-count').textContent = `Rate limit hit (429) — pausing 60s…`;
              await sleep(60_000);
              continue;
            } else {
              dailyQuotaExhausted = true;
              classifyFailed += (unlabeled.length - i);
              console.warn('[TLV Rentals] Quota exhausted. Aborting classify phase.');
              break;
            }
          }

          classifyFailed++;
          if (result?.error) console.warn('[TLV Rentals] classify error:', result.error);
          success = true;
        }
      } catch (err) {
        classifyFailed++;
        console.warn('[TLV Rentals] classify threw:', err);
        success = true;
      }
    }
  }

  // ── Phase 2: extract tags for all rental posts without tags ──────────────────
  // Includes posts newly classified in Phase 1 plus any pre-existing untagged rentals.
  if (!dailyQuotaExhausted) {
    const toTag = allPosts.filter(p => {
      const label = p.human_label || p.ai_label;
      return label === 'rental' && !p.tags;
    });

    for (let i = 0; i < toTag.length; i++) {
      const post = toTag[i];
      el('result-count').textContent =
        `Step 2/2 — Extracting tags ${i + 1} / ${toTag.length}… ` +
        `(${tagged} done, ${tagFailed} failed)`;

      try {
        const result = await chrome.runtime.sendMessage({
          type: 'EXTRACT_TAGS',
          postId: post.post_id,
        });
        if (result?.ok && result.tags) {
          post.tags = result.tags;
          tagged++;
        } else {
          tagFailed++;
          if (result?.error) console.warn('[TLV Rentals] extract tags error:', result.error);
        }
      } catch (err) {
        tagFailed++;
        console.warn('[TLV Rentals] extract tags threw:', err);
      }
    }
  }

  btn.disabled = false;
  el('result-count').textContent = originalCount;
  buildNeighborhoodCheckboxes();
  applyFilters();

  if (dailyQuotaExhausted) {
    alert(
      `Paused — API quota exhausted.\n\n` +
      `Your key returned 429 even after a 60-second cooldown. ` +
      `Wait until your daily quota resets, then run Classify & Tag again ` +
      `— it will pick up where it left off.`
    );
  } else {
    const summaryLines = [];
    if (classified || classifyFailed)
      summaryLines.push(`Classification: ${classified} labeled, ${classifyFailed} failed`);
    if (tagged || tagFailed)
      summaryLines.push(`Tag extraction: ${tagged} tagged, ${tagFailed} failed`);

    alert(
      `Done!\n\n` +
      summaryLines.join('\n') + '\n\n' +
      `Spot-check AI labels with the Rental / Not rental buttons — ` +
      `your corrections feed back as few-shot examples next time.`
    );
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function el(id) { return document.getElementById(id); }

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatEntryDate(isoStr) {
  try {
    return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return isoStr; }
}

// Returns whichever of posted_at / scraped_at is more recent (and sane).
// Guards against parseRelativeTime bugs that put posted_at decades in the past.
function bestDisplayTime(post) {
  const postedTs  = post.posted_at  ? new Date(post.posted_at).getTime()  : 0;
  const scrapedTs = post.scraped_at ? new Date(post.scraped_at).getTime() : 0;
  const ts = Math.max(postedTs, scrapedTs);
  return ts ? new Date(ts).toISOString() : null;
}

function relativeTime(isoStr) {
  if (!isoStr) return '?';
  const ms   = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
