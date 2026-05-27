// dashboard/dashboard.js — Dashboard controller
//
// Runs at chrome-extension://[id]/dashboard/dashboard.html, so it shares
// IndexedDB with background.js (same extension origin). Reads + updates posts
// directly via lib/db.js. Classification + tag extraction are local-only
// (lib/regex_extractor.js) — there is no remote API in the loop anymore.
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

import { regexExtractTags, mergeWithRegex, regexClassifyPost } from '../lib/regex_extractor.js';

let allPosts      = [];   // every record from IndexedDB
let filteredPosts = [];   // subset after applying sidebar filters
const expandedPostIds = new Set(); // post_ids whose full text is currently visible

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadPosts();
  buildNeighborhoodCheckboxes();
  applyFilters();
  bindControls();
  autoRegexProcess(); // fire-and-forget: classifies + tags unlabeled/unprocessed posts
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
  // Posted-within / scraped-within are independent filters. Blank input = no
  // filter on that axis. Both can be active simultaneously (AND).
  const postedDaysRaw     = el('posted-days-filter').value.trim();
  const scrapedDaysRaw    = el('scraped-days-filter').value.trim();
  const postedDays        = postedDaysRaw  === '' ? null : (parseInt(postedDaysRaw)  || null);
  const scrapedDays       = scrapedDaysRaw === '' ? null : (parseInt(scrapedDaysRaw) || null);
  const searchText        = el('text-search').value.trim().toLowerCase();
  const showDupes         = el('show-dupes').checked;
  const onlyMisses        = el('show-only-misses').checked;
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
  return { statuses, labels, labelSources, postedDays, scrapedDays,
           searchText, showDupes, onlyMisses,
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
  const f = readFilters();

  filteredPosts = allPosts.filter(p => {
    if (!f.statuses.includes(p.status || 'new')) return false;
    if (!f.showDupes && p.is_duplicate) return false;
    if (f.onlyMisses && !p.regex_miss) return false;
    if (!f.labels.includes(effectiveLabel(p, f.labelSources))) return false;
    if (f.searchText && !(p.text || '').toLowerCase().includes(f.searchText)) return false;

    // Independent time filters. Each axis filters against its own timestamp.
    // Posts missing posted_at slip through the posted-within filter — Facebook's
    // "Xy ago" string occasionally fails to parse, and hiding those posts would
    // make recently-scraped items vanish for opaque reasons.
    if (f.postedDays != null) {
      const postedTs = p.posted_at ? new Date(p.posted_at).getTime() : 0;
      if (postedTs && postedTs < Date.now() - f.postedDays * 86400 * 1000) return false;
    }
    if (f.scrapedDays != null) {
      const scrapedTs = p.scraped_at ? new Date(p.scraped_at).getTime() : 0;
      if (scrapedTs && scrapedTs < Date.now() - f.scrapedDays * 86400 * 1000) return false;
    }

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
  // Scrape-based sorts are the default; posted-based are explicit so users can
  // pick whichever timestamp matters to them (e.g. "newest in my feed" vs
  // "freshest listings on Facebook").
  filteredPosts.sort((a, b) => {
    switch (f.sort) {
      case 'oldest-scraped': return (a.scraped_at || '').localeCompare(b.scraped_at || '');
      case 'newest-posted':  return (b.posted_at  || '').localeCompare(a.posted_at  || '');
      case 'oldest-posted':  return (a.posted_at  || '').localeCompare(b.posted_at  || '');
      case 'price-asc':      return sortNullsLast(a.tags?.price, b.tags?.price,  1);
      case 'price-desc':     return sortNullsLast(a.tags?.price, b.tags?.price, -1);
      case 'rooms-asc':      return sortNullsLast(a.tags?.rooms, b.tags?.rooms,  1);
      case 'rooms-desc':     return sortNullsLast(a.tags?.rooms, b.tags?.rooms, -1);
      case 'newest-scraped':
      default:               return (b.scraped_at || '').localeCompare(a.scraped_at || '');
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

  // Show BOTH timestamps so the user can tell "freshly posted to FB" apart from
  // "freshly pulled into my dashboard". Absolute time is in the tooltip.
  // Posts where parseRelativeTime failed and fell back to "now" will show
  // identical Posted/Scraped values — that's accurate, not a bug.
  const postedAgo  = post.posted_at  ? relativeTime(post.posted_at)  : null;
  const scrapedAgo = post.scraped_at ? relativeTime(post.scraped_at) : null;
  const timeParts = [];
  if (postedAgo)  timeParts.push(`<span class="card-time-part" title="Posted at ${esc(formatAbsoluteTime(post.posted_at))}">Posted ${postedAgo}</span>`);
  if (scrapedAgo) timeParts.push(`<span class="card-time-part" title="Scraped at ${esc(formatAbsoluteTime(post.scraped_at))}">Scraped ${scrapedAgo}</span>`);
  const timeBlock = timeParts.length
    ? `<span class="card-time">${timeParts.join(' · ')}</span>`
    : '';

  const statusClass = `status-${post.status || 'new'}`;
  const dupeTag     = post.is_duplicate ? '<span class="tag tag--dupe">Dupe</span>' : '';
  const missTag     = post.regex_miss
    ? (post.regex_miss.exported_at
        ? '<span class="tag tag--regex-exported" title="Already included in an export">⚑ Sent</span>'
        : '<span class="tag tag--regex-miss" title="Flagged as regex miss — not yet exported">⚑ Miss</span>')
    : '';

  // Pick the most authoritative badge to show on the card.
  let labelTag = '<span class="tag tag--unlabeled">Unlabeled</span>';
  if (post.human_label === 'rental')          labelTag = '<span class="tag tag--rental-human" title="You marked this as rental">✓ Rental</span>';
  else if (post.human_label === 'not_rental') labelTag = '<span class="tag tag--not-rental-human" title="You marked this as not rental">✗ Not rental</span>';
  else if (post.ai_label === 'rental')        labelTag = post.ai_classified_by === 'regex'
    ? '<span class="tag tag--rental-ai" title="Regex classified as rental">Regex: Rental</span>'
    : '<span class="tag tag--rental-ai" title="Auto-labeled (legacy)">AI: Rental</span>';
  else if (post.ai_label === 'not_rental')    labelTag = post.ai_classified_by === 'regex'
    ? '<span class="tag tag--not-rental-ai" title="Regex classified as not rental">Regex: Not rental</span>'
    : '<span class="tag tag--not-rental-ai" title="Auto-labeled (legacy)">AI: Not rental</span>';

  // Highlight whichever label button matches the current human label.
  const rentalActive    = post.human_label === 'rental'     ? ' active' : '';
  const notRentalActive = post.human_label === 'not_rental' ? ' active' : '';

  const id = esc(post.post_id);

  // Detail pills from extracted tags + ✏ edit button.
  // The ✏ button appears on all rental posts so the user can add/correct tags
  // even before regex has extracted them. Corrections are stored as
  // tags_human_override for the training server and stage-2 feedback loop.
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
  <button class="btn-edit-tags" data-action="edit-tags" data-id="${id}" title="Add / correct tags — your fixes train the regex rules">✏</button>
</div>`;
  }

  return `
<div class="card ${statusClass}" data-id="${id}">
  <div class="card-img-wrap">${thumb}</div>
  <div class="card-body">
    <div class="card-meta">
      <span class="card-group" title="${esc(post.group_name || post.group_id || '')}">${esc(post.group_name || post.group_id || '?')}</span>
      ${timeBlock}
      ${dupeTag}${labelTag}${missTag}
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
      ${post.permalink
          ? `<a class="btn-action btn-open" href="${esc(post.permalink)}" target="_blank" rel="noopener noreferrer">Open ↗</a>`
          : `<span class="btn-action btn-open" style="opacity:0.35;cursor:not-allowed" title="No direct link captured">Open ↗</span>`}
    </div>
    <div class="card-actions-row">
      <button class="btn-action btn-dupe${post.is_duplicate ? ' active' : ''}" data-action="toggle-dupe" data-id="${id}" title="Mark as duplicate — hidden from the default view unless 'Duplicates' is checked in the sidebar">⊘ Dupe</button>
      <button class="btn-action btn-delete" data-action="delete" data-id="${id}" title="Permanently remove this post. It will be re-scraped if it still appears on Facebook.">🗑 Delete</button>
    </div>
  </div>
</div>`;
}

function updateResultCount() {
  const labeled        = allPosts.filter(p => p.human_label).length;
  const aiLabeled      = allPosts.filter(p => !p.human_label && p.ai_label).length;
  const unexportedMiss = allPosts.filter(p => p.regex_miss && !p.regex_miss.exported_at).length;
  el('result-count').textContent =
    `Showing ${filteredPosts.length} of ${allPosts.length} posts ` +
    `· ${labeled} human-labeled · ${aiLabeled} AI-labeled`;
  const exportMissBtn = el('export-misses-btn');
  if (exportMissBtn) {
    exportMissBtn.textContent = unexportedMiss > 0
      ? `Export Misses (${unexportedMiss})`
      : 'Export Misses';
  }
}

// ── Controls ───────────────────────────────────────────────────────────────────
function bindControls() {
  // Sidebar inputs that should re-filter on change.
  document.querySelectorAll(
    'input[name="status"], input[name="label"], input[name="label-source"], ' +
    'input[name="roommates-filter"], input[name="broker-filter"], ' +
    '#show-dupes, #show-only-misses, #posted-days-filter, #scraped-days-filter, #sort-by, ' +
    '#entry-date-unknown, #entry-date-immediate'
  ).forEach(input => input.addEventListener('change', applyFilters));

  // Number inputs should also re-filter on every keystroke (consistent with
  // price/rooms range below) so users see results update as they type.
  el('posted-days-filter').addEventListener('input',  applyFilters);
  el('scraped-days-filter').addEventListener('input', applyFilters);

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
  el('export-misses-btn').addEventListener('click', exportMisses);
  el('retest-regex-btn').addEventListener('click', retestRegex);
  el('regex-extract-btn').addEventListener('click', regexExtractAll);

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

    // Auto-manage classification miss:
    //   • human label disagrees with regex  → ensure 'classification' is in missed_fields
    //   • human label agrees (or cleared)   → remove 'classification' from missed_fields
    const regexLabel = regexClassifyPost(post.text || '');
    if (post.human_label && post.human_label !== regexLabel) {
      // Disagrees — add classification miss if not already present.
      const existing   = post.regex_miss || {};
      const prevFields = existing.missed_fields || [];
      if (!prevFields.includes('classification')) {
        post.regex_miss = {
          ...existing,
          missed_fields: ['classification', ...prevFields],
          flagged_at:    existing.flagged_at || new Date().toISOString(),
          exported_at:   null,
        };
      }
    } else if (post.regex_miss?.missed_fields?.includes('classification')) {
      // Agrees (or label cleared) — remove classification from miss.
      const newFields  = post.regex_miss.missed_fields.filter(f => f !== 'classification');
      const newPhrases = { ...post.regex_miss.key_phrases };
      delete newPhrases.classification;
      const isEmpty    = newFields.length === 0 && Object.keys(newPhrases).length === 0
                         && !post.regex_miss.note;
      post.regex_miss  = isEmpty ? null : {
        ...post.regex_miss,
        missed_fields: newFields,
        key_phrases:   newPhrases,
        exported_at:   null,
      };
    }

    await savePost(post);
    applyFilters();

    // Sync the new label to the local training server (fire-and-forget).
    // Fails silently if the server isn't running — data is safe in IndexedDB.
    chrome.runtime.sendMessage({ type: 'SYNC_LABEL', post }).catch(() => {});

    // When manually marking as rental, run regex extraction immediately.
    // No API fallback — if regex finds nothing, tags stay null until the
    // user either edits them manually or stage 2's correction loop ships.
    if (post.human_label === 'rental' && !post.tags_human_override) {
      const rt = regexExtractTags(post.text || '');
      post.regex_extracted_at = new Date().toISOString();
      if (rt && Object.values(rt).some(v => v != null)) {
        post.tags = mergeWithRegex(post.tags || null, rt);
        await savePost(post);
        applyFilters();
      }
    }
    return;
  }

  if (action === 'toggle-dupe') {
    post.is_duplicate = !post.is_duplicate;
    await savePost(post);
    applyFilters();
    return;
  }

  if (action === 'clear-flag') {
    post.regex_miss = null;
    await savePost(post);
    applyFilters();
    return;
  }

  // Status buttons (interested / seen / hidden) keep their existing behaviour.
  await updatePostStatus(postId, action);
  post.status = action;
  applyFilters();
}

// Replace the .card-tags pill row with an inline correction form.
//
// Each field is shown as a row: [label] [value input] [key phrase input].
// The key phrase is the text from the post that led the user to that value —
// it becomes the training signal in the export prompt.
//
// On save, any field whose value differs from what's currently stored is
// automatically detected as a regex miss. Saving with no changes and no
// key phrases is a no-op for regex_miss (Cancel to discard).
function openTagEditor(post, cardEl) {
  const tagsDiv = cardEl.querySelector('.card-tags');
  if (!tagsDiv) return;

  const t   = post.tags_human_override || post.tags || {};
  const kp  = post.regex_miss?.key_phrases || {};
  const id  = esc(post.post_id);
  const lv  = post.human_label || '';
  const rmv = t.roommates === true ? 'true' : t.roommates === false ? 'false' : '';
  const brv = t.broker    === true ? 'true' : t.broker    === false ? 'false' : '';

  tagsDiv.outerHTML = `
<div class="card-tag-editor">
  <div class="tag-field-row">
    <span class="tag-field-label">Classification</span>
    <div class="tag-field-inputs">
      <select name="tag-label" class="tag-field-value">
        <option value=""           ${lv === ''           ? 'selected' : ''}>— keep current —</option>
        <option value="rental"     ${lv === 'rental'     ? 'selected' : ''}>✓ Rental</option>
        <option value="not_rental" ${lv === 'not_rental' ? 'selected' : ''}>✗ Not rental</option>
      </select>
      <input type="text" name="kp-classification" class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.classification || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <span class="tag-field-label">Price ₪/mo</span>
    <div class="tag-field-inputs">
      <input type="number" name="tag-price" class="tag-field-value" value="${t.price ?? ''}" min="0" step="100">
      <input type="text"   name="kp-price"  class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.price || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <span class="tag-field-label">Rooms</span>
    <div class="tag-field-inputs">
      <input type="number" name="tag-rooms" class="tag-field-value" value="${t.rooms ?? ''}" min="0" step="0.5">
      <input type="text"   name="kp-rooms"  class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.rooms || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <span class="tag-field-label">Size m²</span>
    <div class="tag-field-inputs">
      <input type="number" name="tag-size" class="tag-field-value" value="${t.size ?? ''}" min="0">
      <input type="text"   name="kp-size"  class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.size || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <span class="tag-field-label">Neighborhood</span>
    <div class="tag-field-inputs">
      <input type="text" name="tag-neighborhood" class="tag-field-value tag-field-value--text" value="${esc(t.neighborhood || '')}">
      <input type="text" name="kp-neighborhood"  class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.neighborhood || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <span class="tag-field-label">Entry date</span>
    <div class="tag-field-inputs">
      <input type="text" name="tag-entry-date" class="tag-field-value tag-field-value--text" value="${esc(t.entry_date || '')}" placeholder="YYYY-MM-DD or immediate">
      <input type="text" name="kp-entry-date"  class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.entry_date || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <span class="tag-field-label">Roommates</span>
    <div class="tag-field-inputs">
      <select name="tag-roommates" class="tag-field-value">
        <option value=""      ${rmv === ''      ? 'selected' : ''}>Unknown</option>
        <option value="true"  ${rmv === 'true'  ? 'selected' : ''}>Yes — seeking roommate</option>
        <option value="false" ${rmv === 'false' ? 'selected' : ''}>No — whole apartment</option>
      </select>
      <input type="text" name="kp-roommates" class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.roommates || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <span class="tag-field-label">Broker fee</span>
    <div class="tag-field-inputs">
      <select name="tag-broker" class="tag-field-value">
        <option value=""      ${brv === ''      ? 'selected' : ''}>Unknown</option>
        <option value="true"  ${brv === 'true'  ? 'selected' : ''}>Yes — דמי תיווך</option>
        <option value="false" ${brv === 'false' ? 'selected' : ''}>No — ללא תיווך</option>
      </select>
      <input type="text" name="kp-broker" class="tag-field-keyphrase" placeholder="key phrase…" value="${esc(kp.broker || '')}">
    </div>
  </div>
  <div class="tag-field-row">
    <label class="tag-editor-wide">Note (optional)
      <input type="text" name="tag-note" value="${esc(post.regex_miss?.note || '')}" placeholder="any extra context for Claude">
    </label>
  </div>
  <div class="tag-editor-actions">
    <button class="btn-tag-save"   data-action="save-tags"   data-id="${id}">Save corrections</button>
    <button class="btn-tag-cancel" data-action="cancel-tags" data-id="${id}">Cancel</button>
    ${post.regex_miss ? `<button class="btn-clear-miss" data-action="clear-flag" data-id="${id}">✕ Clear miss</button>` : ''}
  </div>
</div>`;
}

// Persist tag corrections and auto-build regex_miss from the diff.
//
// Any field whose new value differs from what was stored is added to
// missed_fields. Key phrases entered for any field (even unchanged ones)
// are stored as evidence. If anything changed or any key phrase was entered,
// regex_miss is created/updated and the ⚑ Miss badge appears on the card.
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
  const kpVal = name =>
    (editor.querySelector(`[name="kp-${name}"]`)?.value || '').trim() || null;

  const rmRaw  = editor.querySelector('[name="tag-roommates"]')?.value;
  const brRaw  = editor.querySelector('[name="tag-broker"]')?.value;
  const roommates = rmRaw === 'true' ? true : rmRaw === 'false' ? false : null;
  const broker    = brRaw === 'true' ? true : brRaw === 'false' ? false : null;
  const labelVal  = editor.querySelector('[name="tag-label"]')?.value;
  const noteVal   = str('tag-note');

  const corrected = {
    price:        num('tag-price'),
    rooms:        num('tag-rooms'),
    size:         num('tag-size'),
    neighborhood: str('tag-neighborhood'),
    entry_date:   str('tag-entry-date'),
    roommates,
    broker,
  };

  // Baseline: what was shown in the editor when it opened.
  const prev      = post.tags_human_override || post.tags || {};
  const prevLabel = post.human_label || '';

  // Detect changed fields and collect key phrases.
  const missedFields = [];
  const keyPhrases   = {};

  if (labelVal && labelVal !== prevLabel) missedFields.push('classification');
  const classKp = kpVal('classification');
  if (classKp) keyPhrases.classification = classKp;

  // [ field_id, input_name, kp_name ]
  const FIELDS = [
    ['price',        'tag-price',        'price'],
    ['rooms',        'tag-rooms',        'rooms'],
    ['size',         'tag-size',         'size'],
    ['neighborhood', 'tag-neighborhood', 'neighborhood'],
    ['entry_date',   'tag-entry-date',   'entry-date'],
    ['roommates',    'tag-roommates',    'roommates'],
    ['broker',       'tag-broker',       'broker'],
  ];
  for (const [fid, , kpName] of FIELDS) {
    if (corrected[fid] !== (prev[fid] ?? null)) missedFields.push(fid);
    const phrase = kpVal(kpName);
    if (phrase) keyPhrases[fid] = phrase;
  }

  // Update classification label.
  if (labelVal === 'rental' || labelVal === 'not_rental') {
    post.human_label = labelVal;
  }

  // Persist corrections.
  post.tags                = corrected;
  post.tags_human_override = corrected;

  // Auto-set regex_miss if anything changed or any key phrase was given.
  const hasMiss = missedFields.length > 0 || Object.keys(keyPhrases).length > 0;
  if (hasMiss) {
    post.regex_miss = {
      missed_fields: missedFields,
      key_phrases:   keyPhrases,
      note:          noteVal,
      flagged_at:    post.regex_miss?.flagged_at || new Date().toISOString(),
      exported_at:   null, // reset so this appears in the next export
    };
  }

  await savePost(post);
  applyFilters();
  chrome.runtime.sendMessage({ type: 'SYNC_LABEL', post }).catch(() => {});
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
  el('posted-days-filter').value  = '30';
  el('scraped-days-filter').value = '';   // no scrape-time filter by default
  el('sort-by').value             = 'newest-scraped';
  el('text-search').value = '';
  el('price-min').value   = '';
  el('price-max').value          = '';
  el('rooms-min').value          = '';
  el('rooms-max').value          = '';
  el('show-dupes').checked = false;
  el('show-only-misses').checked = false;
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

// ── Auto regex process (runs silently on every load / refresh) ───────────────
//
// Classifies unlabeled posts with regex and tags unprocessed rental posts.
// Runs fire-and-forget so the dashboard renders immediately.
async function autoRegexProcess() {
  let changed = false;
  for (const post of allPosts) {
    // 1. Classify unlabeled posts with regex
    if (!post.human_label && !post.ai_label) {
      const label = regexClassifyPost(post.text || '');
      if (label) {
        post.ai_label         = label;
        post.ai_classified_by = 'regex';
        post.ai_classified_at = new Date().toISOString();
        changed = true;
        // fall through to tagging below if rental
      }
    }
    // 2. Tag rental posts that haven't been regex-processed yet
    const label = post.human_label || post.ai_label;
    if (label === 'rental' && !post.tags_human_override && !post.regex_extracted_at) {
      const rt = regexExtractTags(post.text || '');
      post.regex_extracted_at = new Date().toISOString();
      if (rt && Object.values(rt).some(v => v != null)) {
        post.tags = mergeWithRegex(post.tags || null, rt);
      }
      changed = true;
      await savePost(post);
    } else if (!post.human_label && post.ai_label && post.ai_classified_by === 'regex') {
      // Newly regex-classified (step 1 above) but not yet saved
      await savePost(post);
    }
  }
  if (changed) {
    buildNeighborhoodCheckboxes();
    applyFilters();
  }
}

// ── Regex Extract (backfill) ──────────────────────────────────────────────────
//
// Runs the local regex extractor on every rental post that has NOT had its
// tags manually corrected by a human (i.e. tags_human_override is falsy).
// This covers:
//   • Posts with no tags at all
//   • Legacy posts whose tags came from the old Gemini pipeline and haven't
//     been verified yet
//
// Merge strategy: regex wins when it finds a non-null value; existing tag
// values fill the gaps (so we never throw away legacy inferences regex can't
// replicate from NEIGHBORHOOD_OVERRIDES alone).
//
// Entirely local — no API calls, no rate limits, runs instantly.
async function regexExtractAll() {
  // Eligible: rental (human or AI), not yet human-corrected, not yet regex-processed.
  // Posts with regex_extracted_at were already processed (at scrape time or
  // a prior button press) — don't redo them. To re-run on a post, clear its
  // tags via the ✏ editor first.
  const eligible = allPosts.filter(p => {
    const label = p.human_label || p.ai_label;
    return label === 'rental' && !p.tags_human_override && !p.regex_extracted_at;
  });

  if (eligible.length === 0) {
    alert('Nothing to do — all rental posts already have human-verified tags.\n\nTo re-run regex on a post, clear its tags via the ✏ editor first.');
    return;
  }

  const btn = el('regex-extract-btn');
  btn.disabled = true;

  let updated = 0;
  let skipped = 0; // regex found nothing and post already had tags

  for (let i = 0; i < eligible.length; i++) {
    const post = eligible[i];
    el('result-count').textContent =
      `Regex extracting ${i + 1} / ${eligible.length}… (${updated} updated)`;

    const regexResult = regexExtractTags(post.text || '');
    if (!regexResult) { skipped++; continue; }

    const allNull = Object.values(regexResult).every(v => v == null);

    if (allNull && post.tags) {
      // Regex found nothing new and legacy tags exist — don't overwrite.
      skipped++;
      continue;
    }

    const merged = mergeWithRegex(post.tags || null, regexResult);
    post.tags = merged;
    await savePost(post);
    updated++;
  }

  btn.disabled = false;
  buildNeighborhoodCheckboxes();
  applyFilters();

  const lines = [`Updated: ${updated} post${updated !== 1 ? 's' : ''}`];
  if (skipped) lines.push(`Skipped: ${skipped} (regex found nothing new)`);
  alert(`Regex extraction complete.\n\n${lines.join('\n')}`);
}


// ── Export misses ─────────────────────────────────────────────────────────────
//
// Collects all posts with an unexported regex_miss, formats them as a
// ready-to-paste Claude prompt (including the current regex source), downloads
// as a .txt file, then stamps each post with exported_at so they won't appear
// in the next export unless re-flagged.

async function exportMisses() {
  const toExport = allPosts.filter(p => p.regex_miss && !p.regex_miss.exported_at);
  if (toExport.length === 0) {
    alert('No unexported regex misses.\n\nCorrect a post\'s tags with ✏ to flag it, or all flagged posts have already been exported.\nRe-save corrections on a post to include it in the next export.');
    return;
  }

  const now   = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Regex Miss Report — ${now}`,
    `## ${toExport.length} post${toExport.length !== 1 ? 's' : ''} flagged`,
    '',
  ];

  toExport.forEach((post, i) => {
    const m  = post.regex_miss;
    const kp = m.key_phrases || {};
    lines.push('---');
    lines.push(`### Miss ${i + 1}  (post_id: ${post.post_id})`);
    if (m.missed_fields?.length) lines.push(`Missed fields:  ${m.missed_fields.join(', ')}`);
    if (Object.keys(kp).length) {
      lines.push('Key phrases:');
      for (const [field, phrase] of Object.entries(kp)) {
        lines.push(`  ${field}: "${phrase}"`);
      }
    }
    if (m.note) lines.push(`Note:  ${m.note}`);
    lines.push('');
    lines.push('Post text:');
    lines.push('"""');
    lines.push((post.text || '').slice(0, 600));
    if ((post.text || '').length > 600) lines.push('…[truncated]');
    lines.push('"""');
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('Please update lib/regex_extractor.js to handle the cases above.');
  lines.push('Constraints: regex-only, no API calls, no new imports.');

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const fname = `tlv-regex-misses-${now}.txt`;
  const a = Object.assign(document.createElement('a'), { href: url, download: fname });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const exportedAt = new Date().toISOString();
  for (const post of toExport) {
    post.regex_miss = { ...post.regex_miss, exported_at: exportedAt };
    await savePost(post);
  }
  updateResultCount();
  applyFilters();
}

// ── Re-test regex ─────────────────────────────────────────────────────────────
//
// Runs the current regex on every post and computes a diff vs what's stored.
// Shows a confirmation modal before writing anything. Human labels and manual
// tag corrections (tags_human_override) are never overwritten.

/**
 * Returns true if the current regex now produces the correct output for every
 * field that the human flagged as a miss.
 *
 * Checks each entry in post.regex_miss.missed_fields:
 *   'classification' → regexClassifyPost() must equal post.human_label
 *   everything else  → regexExtractTags()[field] must equal
 *                      (tags_human_override || tags || {})[field]
 */
function isMissResolved(post) {
  const miss = post.regex_miss;
  if (!miss?.missed_fields?.length) return false;

  const text    = post.text || '';
  const newTags = regexExtractTags(text) || {};
  const human   = post.tags_human_override || post.tags || {};

  return miss.missed_fields.every(field => {
    if (field === 'classification') {
      return regexClassifyPost(text) === (post.human_label || null);
    }
    return (newTags[field] ?? null) === (human[field] ?? null);
  });
}

async function retestRegex() {
  const diff = {
    resolved:        [],  // had regex_miss whose correct_label now matches new regex
    newlyClassified: [],  // was unlabeled, regex now has an opinion
    reclassified:    [],  // had a regex label, new regex disagrees
    newlyTagged:     [],  // rental post, tags would change
  };

  for (const post of allPosts) {
    const newLabel = regexClassifyPost(post.text || '');

    // Resolve miss: new regex now produces the correct output for all missed fields.
    if (post.regex_miss && isMissResolved(post)) {
      diff.resolved.push(post);
      continue; // don't also count as reclassified / newly-tagged
    }

    // Newly classified (unlabeled post, regex now returns something).
    if (!post.human_label && !post.ai_label && newLabel) {
      diff.newlyClassified.push({ post, newLabel });
      continue; // don't also count as reclassified
    }

    // Reclassified (regex label changes, no human override).
    if (!post.human_label && post.ai_label &&
        post.ai_classified_by === 'regex' && newLabel && newLabel !== post.ai_label) {
      diff.reclassified.push({ post, oldLabel: post.ai_label, newLabel });
    }

    // Tag updates on rental posts not manually corrected.
    const effectiveLabel = post.human_label || post.ai_label || newLabel;
    if (effectiveLabel === 'rental' && !post.tags_human_override) {
      const newTags = regexExtractTags(post.text || '');
      if (newTags) {
        const existing = post.tags || {};
        const changed  = Object.keys(newTags).some(k => {
          const nv = newTags[k]; const ov = existing[k];
          return nv != null && nv !== ov;
        });
        if (changed) diff.newlyTagged.push({ post, newTags });
      }
    }
  }

  const total = diff.resolved.length + diff.newlyClassified.length +
                diff.reclassified.length + diff.newlyTagged.length;

  if (total === 0) {
    alert('Re-test complete: the current regex produces the same results as before — no changes.');
    return;
  }

  showRetestModal(diff);
}

function showRetestModal(diff) {
  const items = [];
  if (diff.resolved.length)
    items.push(`✓ ${diff.resolved.length} regex miss${diff.resolved.length !== 1 ? 'es' : ''} resolved — flags will be cleared`);
  if (diff.newlyClassified.length)
    items.push(`+ ${diff.newlyClassified.length} post${diff.newlyClassified.length !== 1 ? 's' : ''} newly classified`);
  if (diff.reclassified.length)
    items.push(`~ ${diff.reclassified.length} post${diff.reclassified.length !== 1 ? 's' : ''} reclassified (label changes)`);
  if (diff.newlyTagged.length)
    items.push(`✎ ${diff.newlyTagged.length} rental post${diff.newlyTagged.length !== 1 ? 's' : ''} with updated tags`);

  const overlay = document.createElement('div');
  overlay.className = 'retest-overlay';
  overlay.innerHTML = `
<div class="retest-modal">
  <h2>Re-test Results</h2>
  <ul class="retest-list">
    ${items.map(i => `<li>${esc(i)}</li>`).join('')}
  </ul>
  <p class="retest-note">Human labels and manually corrected tags are never overwritten.</p>
  <div class="retest-actions">
    <button class="btn-retest-apply">Apply changes</button>
    <button class="btn-retest-cancel">Cancel</button>
  </div>
</div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('.btn-retest-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.btn-retest-apply').addEventListener('click', async () => {
    overlay.remove();
    await commitRetest(diff);
  });
}

async function commitRetest(diff) {
  const now = new Date().toISOString();
  let count = 0;

  for (const post of diff.resolved) {
    post.regex_miss = null;
    await savePost(post);
    count++;
  }

  for (const { post, newLabel } of diff.newlyClassified) {
    post.ai_label         = newLabel;
    post.ai_classified_by = 'regex';
    post.ai_classified_at = now;
    if (newLabel === 'rental') {
      const rt = regexExtractTags(post.text || '');
      post.regex_extracted_at = now;
      if (rt && Object.values(rt).some(v => v != null)) {
        post.tags = mergeWithRegex(post.tags || null, rt);
      }
    }
    await savePost(post);
    count++;
  }

  for (const { post, newLabel } of diff.reclassified) {
    post.ai_label         = newLabel;
    post.ai_classified_by = 'regex';
    post.ai_classified_at = now;
    await savePost(post);
    count++;
  }

  for (const { post, newTags } of diff.newlyTagged) {
    post.tags               = mergeWithRegex(post.tags || null, newTags);
    post.regex_extracted_at = now;
    await savePost(post);
    count++;
  }

  await loadPosts();
  buildNeighborhoodCheckboxes();
  applyFilters();
  alert(`Re-test applied: ${count} post${count !== 1 ? 's' : ''} updated.`);
}

// ── Utilities ──────────────────────────────────────────────────────────────────

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

// Absolute time for the card tooltip — "25 May 2026, 14:32".
// Used in the hover-title on each Posted/Scraped chip; relative time on its own
// hides whether "3d ago" means 3 days or 3 days plus several hours.
function formatAbsoluteTime(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return isoStr; }
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
