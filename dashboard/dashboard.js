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
  savePost,
  deletePost,
  clearAllPosts,
} from '../lib/db.js';

import { regexExtractTags, mergeWithRegex, regexClassifyPost } from '../lib/regex_extractor.js';
import {
  readShadow, needsReviewAny, applyVerdictCorrection, recordVerdict, reviewQueueCount,
  SHADOW_FIELDS,
} from '../lib/ml_shadow.js';
import { buildWeightFiles, describeStoredWeights, WEIGHT_EXPORTS }
  from '../lib/ml_weights_export.js';
import {
  runRetrain, countCorrections, countNewCorrections, goldCoverage, importGoldTexts,
} from '../lib/ml_retrain.js';

import { textSimilarity } from '../lib/dedup.js';

import { getNotifySettings, saveNotifySettings, sendTelegram, detectChatId }
  from '../lib/notify.js';

import { activeMlMeta } from '../lib/ml_classifier.js';

let allPosts      = [];   // every record from IndexedDB
let filteredPosts = [];   // subset after applying sidebar filters
const expandedPostIds = new Set(); // post_ids whose full text is currently visible

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadPosts();
  applyFilters();
  bindControls();
  autoRegexProcess(); // fire-and-forget: classifies + tags unlabeled/unprocessed posts
});

// ── Data loading ──────────────────────────────────────────────────────────────
// Post ids judged since the last explicit reload. The review filter keeps
// showing them so a card never evaporates mid-session: handleShadowVerdict
// swaps only its own card and does NOT re-filter, so without this every post
// judged since the last render vanished in a batch the next time anything
// called applyFilters() — saving a tag edit, retraining. Observed live as
// "60 cards on screen, 60 of them already judged", which read as the view
// wiping itself. Cleared by loadPosts(), i.e. by any deliberate refresh.
const shadowSessionKeep = new Set();

async function loadPosts() {
  // A deliberate reload is the point at which judged cards are allowed to go.
  shadowSessionKeep.clear();
  allPosts = await getAllPosts();
  allPosts.sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));
}


// ── Filter logic ──────────────────────────────────────────────────────────────
function readFilters() {
  const labels            = checkedValues('label');        // 'rental' | 'not_rental' | 'unlabeled'
  const labelSources      = checkedValues('label-source'); // 'human' | 'ai'
  const searchText        = el('text-search').value.trim().toLowerCase();
  const showDupes         = el('show-dupes').checked;
  const onlyMisses        = el('show-only-misses').checked;
  const shadowQueue       = el('show-shadow-queue').checked;
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
  return { labels, labelSources,
           searchText, showDupes, onlyMisses, shadowQueue,
           priceMin, priceMax, roomsMin, roomsMax,
           roommatesFilter, brokerFilter,
           entryDateFrom, entryDateTo, entryDateUnknown, entryDateImmediate };
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
    if (!f.showDupes && p.is_duplicate) return false;
    if (f.onlyMisses && !p.regex_miss) return false;
    // Shadow review queue: only posts where a head disagrees with the regex
    // AND no verdict exists yet. Agreement carries no information, and a
    // judged disagreement has already done its job.
    if (f.shadowQueue &&
        !shadowSessionKeep.has(p.post_id) &&
        !SHADOW_FIELDS.some(fl => needsReviewAny(p, fl))) return false;
    if (!f.labels.includes(effectiveLabel(p, f.labelSources))) return false;
    if (f.searchText && !(p.text || '').toLowerCase().includes(f.searchText)) return false;

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

    return true;
  });

  // Sort control was removed from the sidebar — always newest-scraped first
  // (matches the load-time sort in loadPosts(), so this is a no-op stabilizer
  // for filteredPosts specifically after card actions mutate allPosts in place).
  if (f.shadowQueue) {
    // Order by how much a verdict teaches us. A model FILL (regex had nothing)
    // is the informative case; an ABSTAIN (regex had a value, model declined)
    // is the least informative — the regex is nearly always right there — and
    // it moves no metric. Reviewing top-down therefore spends your attention
    // where it counts, without hiding anything.
    const rank = p => {
      let best = 3;
      for (const fl of SHADOW_FIELDS) {
        const s = readShadow(p); const d = s?.fields?.[fl];
        if (!d || d.agrees || s.verdicts?.[fl]) continue;
        const mlHas = (d.value ?? null) !== null, rxHas = (d.regex ?? null) !== null;
        best = Math.min(best, !mlHas ? 2 : (rxHas ? 1 : 0));   // fill < override < abstain
      }
      return best;
    };
    filteredPosts.sort((a, b) =>
      rank(a) - rank(b) || (b.scraped_at || '').localeCompare(a.scraped_at || ''));
  } else {
    filteredPosts.sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));
  }

  renderCards();
  updateResultCount();
}

// ── Rendering ──────────────────────────────────────────────────────────────────
// Cards render in chunks. Building thousands of card nodes in one innerHTML
// assignment is what made the dashboard crawl as the DB grew — the first
// chunk paints instantly and an IntersectionObserver on a sentinel appends
// the next chunk whenever the user scrolls near the bottom. filteredPosts is
// untouched: filtering, the result count, and exports still see everything.
// Re-renders triggered by card actions (label/edit/dupe) keep the current
// depth so the user doesn't lose their place mid-list.
const RENDER_CHUNK = 60;
let renderedCount  = 0;
let renderObserver = null;
let renderSentinel = null;

function renderCards() {
  const grid  = el('card-grid');
  const empty = el('empty-state');

  if (renderObserver) { renderObserver.disconnect(); renderObserver = null; }
  if (renderSentinel) { renderSentinel.remove(); renderSentinel = null; }
  const keepDepth = Math.max(RENDER_CHUNK, Math.min(renderedCount, filteredPosts.length));
  renderedCount = 0;

  if (filteredPosts.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = '';
  appendCardChunk(grid, keepDepth);
}

function appendCardChunk(grid, count = RENDER_CHUNK) {
  if (renderObserver) { renderObserver.disconnect(); renderObserver = null; }
  if (renderSentinel) { renderSentinel.remove(); renderSentinel = null; }

  const next = filteredPosts.slice(renderedCount, renderedCount + count);
  renderedCount += next.length;
  grid.insertAdjacentHTML('beforeend', next.map(cardHTML).join(''));

  if (renderedCount < filteredPosts.length) {
    renderSentinel = document.createElement('div');
    renderSentinel.style.cssText = 'grid-column:1/-1;text-align:center;padding:16px;color:#888;';
    renderSentinel.textContent = `Loading more… (${renderedCount} of ${filteredPosts.length})`;
    grid.appendChild(renderSentinel);
    renderObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) appendCardChunk(grid);
    }, { rootMargin: '600px' });
    renderObserver.observe(renderSentinel);
  }
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
    : post.ai_classified_by === 'ml'
      ? `<span class="tag tag--rental-ai" title="ML model classified as rental (confidence ${post.ml_prob ?? '?'}) — overrode or replaced the regex label">🤖 ML: Rental</span>`
      : '<span class="tag tag--rental-ai" title="Auto-labeled (legacy)">Legacy: Rental</span>';
  else if (post.ai_label === 'not_rental')    labelTag = post.ai_classified_by === 'regex'
    ? '<span class="tag tag--not-rental-ai" title="Regex classified as not rental">Regex: Not rental</span>'
    : post.ai_classified_by === 'ml'
      ? `<span class="tag tag--not-rental-ai" title="ML model classified as not rental (confidence ${post.ml_prob ?? '?'}) — overrode or replaced the regex label">🤖 ML: Not rental</span>`
      : '<span class="tag tag--not-rental-ai" title="Auto-labeled (legacy)">Legacy: Not rental</span>';

  // Highlight whichever label button matches the current human label.
  const rentalActive    = post.human_label === 'rental'     ? ' active' : '';
  const notRentalActive = post.human_label === 'not_rental' ? ' active' : '';

  const id = esc(post.post_id);

  // Detail pills from extracted tags + ✏ edit button.
  // The ✏ button appears on all rental posts so the user can add/correct tags
  // even before regex has extracted them. Corrections are stored as
  // tags_human_override and feed into the stage-2 feedback loop.
  const isRental = post.human_label === 'rental' || post.ai_label === 'rental';
  let tagsRow = '';
  if (isRental) {
    const pills = [];
    if (post.tags) {
      const t = post.tags;
      if (t.price        != null) pills.push(`<span class="detail-pill">₪${t.price.toLocaleString()}</span>`);
      if (t.rooms        != null) pills.push(`<span class="detail-pill">${t.rooms} חד'</span>`);
      if (t.size         != null) pills.push(`<span class="detail-pill">${t.size} מ"ר</span>`);
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
</div>${shadowHTML(post, id)}`;
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

// ── Shadow-mode ML review UI ────────────────────────────────────────────────
//
// Rendered ONLY where a head disagrees with the regex, or where a verdict has
// already been recorded. Agreement is invisible: showing a shadow value that
// merely echoes the tag would be noise, and the point of the row is to ask a
// question the benchmark needs answered.
//
// These values are deliberately styled unlike tag pills. They are not tags —
// they never reach matchesPreferences — and the UI should not imply otherwise.

const fmtShadowVal = (field, v) => {
  if (v === null || v === undefined) return '—';
  if (field === 'price') return '₪' + Number(v).toLocaleString();
  if (field === 'roommates') return v ? 'Roommates' : 'No roommates';
  return String(v);
};

// truth values ride through the DOM as strings; '' means null (e.g. "this post
// states no rent"), which is a meaningful answer for price, not a missing one.
const encodeTruth = v => (v === null || v === undefined) ? '' : String(v);
function decodeTruth(field, raw) {
  if (raw === '') return null;
  if (field === 'roommates') return raw === 'true';
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function shadowHTML(post, id) {
  const s = readShadow(post);
  if (!s) return '';
  const rows = [];
  for (const field of SHADOW_FIELDS) {
    const f = s.fields?.[field];
    if (!f) continue;
    const verdict = s.verdicts?.[field];

    if (verdict) {
      const cls = verdict.ml_correct ? 'shadow-judged' : 'shadow-judged shadow-judged--wrong';
      rows.push(`<span class="shadow-field">${esc(field)}</span>
        <span class="${cls}" title="You judged this. ML ${verdict.ml_correct ? 'was right' : 'was wrong'}; regex ${verdict.regex_correct ? 'was right' : 'was wrong'}.">${esc(fmtShadowVal(field, verdict.truth))} ✓</span>`);
      continue;
    }
    if (f.agrees) continue;   // nothing to ask

    rows.push(`<span class="shadow-field">${esc(field)}</span>
      <button class="btn-shadow btn-shadow--ml" data-action="shadow-verdict" data-id="${id}" data-field="${esc(field)}" data-truth="${esc(encodeTruth(f.value))}" title="ML says this (confidence ${f.prob ?? '?'}) — click if it is correct">ML: ${esc(fmtShadowVal(field, f.value))}</button>
      <button class="btn-shadow btn-shadow--regex" data-action="shadow-verdict" data-id="${id}" data-field="${esc(field)}" data-truth="${esc(encodeTruth(f.regex))}" title="The regex says this — click if it is correct">regex: ${esc(fmtShadowVal(field, f.regex))}</button>
      ${field === 'price'
        ? `<button class="btn-shadow btn-shadow--other" data-action="shadow-other" data-id="${id}" data-field="price" title="Neither is right — type the correct rent, or leave blank if the post states none">other…</button>`
        : ''}`);
  }
  if (!rows.length) return '';
  return `<div class="shadow-row"><span class="shadow-row-label">🔬 SHADOW ML (not used as tags)</span>${rows.join('')}</div>`;
}

// A verdict does three things at once (see ml_shadow.js::applyVerdictCorrection):
// it scores the shadow benchmark, promotes the confirmed value to a real tag —
// which is what feeds ML retraining, since the trainers read
// tags_human_override — and flags the regex as a miss when the regex was the
// one that got it wrong, so Export Misses can fix the RULE rather than just
// this post. Confirming the regex was right instead clears any stale miss.
async function handleShadowVerdict(post, field, truth, cardEl) {
  const applied = applyVerdictCorrection(post, field, truth);
  if (!applied) return;
  await savePost(post);
  const fresh = cardHTML(post);
  const tmp = document.createElement('div');
  tmp.innerHTML = fresh;
  cardEl.replaceWith(tmp.firstElementChild);
  shadowSessionKeep.add(post.post_id);   // keep it on screen until an explicit refresh
  updateResultCount();   // the ⚑ Miss / Export Misses counter may have moved
}

/**
 * Write the promoted weights back out as lib/*_weights.js so a retrain can be
 * committed. Retraining promotes into chrome.storage.local, which is per-install
 * runtime state — invisible to git, and lost if the profile is cleared.
 *
 * Prefers the File System Access API: pick the repo's lib/ folder once and the
 * files are written in place, ready to commit. Falls back to ordinary downloads
 * where that API is unavailable or the write fails, in which case the files land
 * in Downloads and need copying into lib/.
 */
async function exportWeights() {
  const btn = el('export-weights-btn');
  const stored = await chrome.storage.local.get(WEIGHT_EXPORTS.map(w => w.key));
  const { files, skipped } = buildWeightFiles(stored);

  if (!files.length) {
    alert([
      'No retrained weights are promoted yet — every head is running the bundled',
      'weights already in the repo, so there is nothing new to export.',
      '',
      'Run 🧠 Retrain ML first.',
    ].join('\n'));
    return;
  }

  const lines = [
    `Export ${files.length} weight file${files.length !== 1 ? 's' : ''}?`,
    '',
    ...describeStoredWeights(stored),
  ];
  if (skipped.length) {
    lines.push('', `Skipped (nothing promoted): ${skipped.join(', ')} —`,
               'their bundled files are left untouched.');
  }
  lines.push('', 'These encode your corrections. Committing them makes your',
             'judgement the default for anyone who clones the repo.');
  if (!confirm(lines.join('\n'))) return;

  btn.disabled = true;
  const names = files.map(f => '  ' + f.name).join('\n');
  try {
    // Preferred: write straight into lib/.
    if (window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tlv-lib' });
        for (const f of files) {
          const fh = await dir.getFileHandle(f.name, { create: true });
          const w = await fh.createWritable();
          await w.write(f.content);
          await w.close();
        }
        alert([`Wrote ${files.length} file(s) into the folder you chose:`, '', names, '',
               "If that was the repo's lib/ folder, they are ready to commit."].join('\n'));
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;   // cancelled — not a failure
        console.warn('[TLV Rentals] Directory write failed, falling back to download:', err);
      }
    }
    // Fallback: plain downloads.
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.content], { type: 'text/javascript' }));
      const a = document.createElement('a');
      a.href = url; a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      await new Promise(r => setTimeout(r, 300));   // Chrome throttles rapid downloads
    }
    alert([`Downloaded ${files.length} file(s):`, '', names, '',
           "Copy them into the repo's lib/ folder, then commit."].join('\n'));
  } catch (err) {
    alert('Weight export failed: ' + (err.message || err));
  } finally {
    btn.disabled = false;
  }
}

// Delegates to the service worker, which owns the model heads — the dashboard
// deliberately does not import them, so there is exactly one code path that
// can write ml_shadow.
async function runShadowBackfill() {
  const btn = el('shadow-backfill-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🔬 Backfilling…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SHADOW_BACKFILL' });
    if (!res?.ok) throw new Error(res?.error || 'backfill failed');
    await loadPosts();
    applyFilters();
    alert(`Shadow backfill complete.\n\n${res.updated} rentals scored, ${res.skipped} skipped` +
          `${res.failed ? `, ${res.failed} failed` : ''}.\n\n` +
          `Tick "🔬 ML review queue" in the sidebar to review only the posts ` +
          `where the model and the regex disagree.`);
  } catch (err) {
    alert('Shadow backfill failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function updateResultCount() {
  const unexportedMiss = allPosts.filter(p => p.regex_miss && !p.regex_miss.exported_at).length;
  el('result-count').textContent = `Showing ${filteredPosts.length} of ${allPosts.length}`;
  const exportMissBtn = el('export-misses-btn');
  if (exportMissBtn) {
    exportMissBtn.textContent = unexportedMiss > 0
      ? `Export Misses (${unexportedMiss})`
      : 'Export Misses';
  }
  updateRetrainButton();
}

// Show how many corrections are waiting to be folded into the ML model.
// This count is "new since the last PROMOTED retrain" — separate from the
// ⚑ Miss / Export Misses counter, which tracks "not yet sent to Claude for
// a regex fix" and is untouched by retraining (see lib/ml_retrain.js header).
async function updateRetrainButton() {
  const btn = el('ml-retrain-btn');
  if (!btn || btn.dataset.busy) return;
  const fresh = await countNewCorrections(allPosts);
  btn.textContent = fresh > 0 ? `🧠 Retrain ML (${fresh} new)` : '🧠 Retrain ML';
  btn.title = fresh > 0
    ? `${fresh} correction(s) since the last retrain — click to fold them into the model.`
    : 'No new corrections since the last retrain.';
}

// One-time gold-text import for fresh installs: the shipped gold file has
// ids+labels only (texts are personal data and stay off the repo). If this
// install's IDB lacks the gold posts, ask the user to pick their dashboard
// export JSON; the texts are cached in chrome.storage.local, never uploaded.
function pickLocalFile() {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'),
      { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', () => resolve(input.files[0] || null));
    // 'cancel' fires (Chrome 113+) when the dialog is dismissed.
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

async function ensureGoldTexts() {
  const cov = await goldCoverage();
  if (cov.have >= cov.min_required) return true;
  if (!confirm(
    `This install only has ${cov.have} of the ${cov.total} gold training texts ` +
    `(the shipped gold file contains ids+labels only — the texts live in your ` +
    `main extension's database / export file).\n\n` +
    `Select your dashboard export JSON (e.g. tlv-rentals-2026-07-18.json) to ` +
    `import them once. The file stays on this computer.\n\nChoose file now?`)) return false;
  const file = await pickLocalFile();
  if (!file) return false;
  try {
    const res = await importGoldTexts(await file.text());
    alert(`✅ Imported ${res.imported} of ${res.gold_total} gold training texts.`);
    return res.imported >= (await goldCoverage()).min_required;
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
    return false;
  }
}

async function retrainMl() {
  const btn = el('ml-retrain-btn');
  if (!(await ensureGoldTexts())) return;
  const total = countCorrections(allPosts);
  const fresh = await countNewCorrections(allPosts);
  if (!confirm(
    `Retrain the ML classifier now?\n\n` +
    `Training data: the shipped gold set + all ${total} of your corrections ` +
    `(dashboard labels/✏ and Telegram 🚩 Miss) — ${fresh} of them new since the last retrain.\n` +
    `Runs locally (~10-30s). New weights are kept only if they score at ` +
    `least as well as the current ones.`)) return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  try {
    const result = await runRetrain(msg => { btn.textContent = `🧠 ${msg}`; });

    // Shadow heads share this button. If either was promoted, every stored
    // prediction is now stale — re-score them so the review queue and the
    // devtools precision figure reflect the weights that are actually live.
    // reshadow() keeps your verdicts and recomputes their correctness against
    // the new predictions, so the benchmark stays honest across a retrain.
    let shadowMsg = '';
    if (result.shadow) {
      const lines = Object.entries(result.shadow).map(([name, r]) => r.promoted
        ? `  🔬 ${name}: promoted — held-out ${(r.score * 100).toFixed(1)}% ` +
          `(was ${(r.previous * 100).toFixed(1)}%), ${r.human_labeled} human-labeled`
        : `  🔬 ${name}: not promoted — ${r.reason}`);
      shadowMsg = `\n\nShadow heads (still shadow-only — they do not tag):\n${lines.join('\n')}`;
      if (Object.values(result.shadow).some(r => r.promoted)) {
        btn.textContent = '🧠 Re-scoring shadow…';
        try {
          const bf = await chrome.runtime.sendMessage({ type: 'SHADOW_BACKFILL' });
          if (bf?.ok) shadowMsg += `\n  Re-scored ${bf.updated} rentals with the new weights.`;
        } catch { /* non-fatal — the 🔬 Shadow Backfill button can redo it */ }
        await loadPosts();
        applyFilters();
      }
    }

    if (result.promoted) {
      alert(
        `✅ ML model retrained and promoted.\n\n` +
        `Cross-validated accuracy: ${(result.cv_accuracy * 100).toFixed(1)}% ` +
        `(previous: ${(result.previous_cv * 100).toFixed(1)}%)\n` +
        `Trained on ${result.label_rows} labeled posts ` +
        `(${result.corrections} of them your corrections, ${result.new_corrections} new) + ` +
        `${result.broker_rows} broker examples.\n\n` +
        `New scrapes will classify with the new weights immediately.${shadowMsg}`);
    } else if (result.needs_import) {
      alert(`⚠️ Retrain refused:\n\n${result.reason}`);
    } else {
      alert(
        `⚠️ Retrain finished but the new weights were NOT promoted.\n\n` +
        `${result.reason}\n\n` +
        `This usually means the new corrections need company — keep marking ` +
        `misses and try again later. (Your ⚑ Miss flags are unaffected either way.)${shadowMsg}`);
    }
  } catch (err) {
    alert('Retrain failed: ' + (err.message || err));
  } finally {
    delete btn.dataset.busy;
    btn.disabled = false;
    updateRetrainButton();
  }
}

// ── Controls ───────────────────────────────────────────────────────────────────
function bindControls() {
  // Sidebar inputs that should re-filter on change.
  document.querySelectorAll(
    'input[name="label"], input[name="label-source"], ' +
    'input[name="roommates-filter"], input[name="broker-filter"], ' +
    '#show-dupes, #show-only-misses, #show-shadow-queue, ' +
    '#entry-date-unknown, #entry-date-immediate'
  ).forEach(input => input.addEventListener('change', applyFilters));

  // Number inputs should also re-filter on every keystroke (consistent with
  // price/rooms range below) so users see results update as they type.
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
    applyFilters();
  });

  el('export-btn').addEventListener('click', exportJSON);
  el('devtools-btn').addEventListener('click', openDevtools);
  el('export-misses-btn').addEventListener('click', exportMisses);
  el('retest-regex-btn').addEventListener('click', retestRegex);
  el('ml-retrain-btn').addEventListener('click', retrainMl);
  el('regex-extract-btn').addEventListener('click', regexExtractAll);
  el('delete-all-btn').addEventListener('click', deleteAllPosts);

  // Notifications settings modal.
  el('export-weights-btn').addEventListener('click', exportWeights);
  el('shadow-backfill-btn').addEventListener('click', runShadowBackfill);
  el('notify-settings-btn').addEventListener('click', openNotifyModal);
  el('notify-close-btn').addEventListener('click', () => el('notify-overlay').classList.add('hidden'));
  el('notify-save-btn').addEventListener('click', saveNotifyForm);
  el('notify-test-btn').addEventListener('click', sendNotifyTest);
  el('notify-detect-btn').addEventListener('click', detectNotifyChatId);

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

  // ── Shadow ML verdicts ──
  // Recording a verdict writes ONLY to post.ml_shadow.verdicts — it never
  // touches post.tags, so judging a shadow prediction cannot change what the
  // notification filter sees. Use the ✏ tag editor for that, deliberately.
  if (action === 'shadow-verdict') {
    const field = btn.dataset.field;
    await handleShadowVerdict(post, field, decodeTruth(field, btn.dataset.truth), btn.closest('.card'));
    return;
  }
  if (action === 'shadow-other') {
    const field = btn.dataset.field;
    const cur = readShadow(post)?.fields?.[field];
    const raw = prompt(
      'Correct monthly rent for this post?\n\n' +
      'Leave blank if the post states no monthly rent (a short-stay rate or ' +
      'no price at all). Blank is a real answer, not a skip — it records that ' +
      'the model should have stayed silent.',
      cur?.value ?? '');
    if (raw === null) return;                       // cancelled — record nothing
    const trimmed = raw.trim();
    let truth = null;
    if (trimmed !== '') {
      truth = Number(trimmed.replace(/[^\d.]/g, ''));
      if (!Number.isFinite(truth) || truth <= 0) { alert('Not a number — nothing recorded.'); return; }
    }
    await handleShadowVerdict(post, field, truth, btn.closest('.card'));
    return;
  }

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
    // A manually marked dupe is also a dedup miss — the two-layer dedup
    // (lib/dedup.js: exact hash + prefix_key) failed to catch it. Flag it so
    // it lands in the next miss export; unmarking removes the flag again.
    if (post.is_duplicate) {
      // Pair the dupe with its suspected original: highest token-set Jaccard
      // among non-duplicate posts. The pair is the actual training signal —
      // the miss export includes both texts so the dedup rules can be fixed
      // against the real divergence. Below the threshold nothing is stored;
      // the export then says the pair is unknown (also a signal).
      if (!post.duplicate_of) {
        let best = null, bestScore = 0;
        for (const other of allPosts) {
          if (other.post_id === post.post_id || other.is_duplicate) continue;
          const s = textSimilarity(post.text || '', other.text || '');
          if (s > bestScore) { bestScore = s; best = other; }
        }
        if (best && bestScore >= 0.55) {
          post.duplicate_of  = best.post_id;
          post.duplicate_sim = Math.round(bestScore * 100) / 100;
        }
      }
      const existing   = post.regex_miss || {};
      const prevFields = existing.missed_fields || [];
      if (!prevFields.includes('duplicate')) {
        post.regex_miss = {
          ...existing,
          missed_fields: [...prevFields, 'duplicate'],
          key_phrases:   existing.key_phrases || {},
          flagged_at:    existing.flagged_at || new Date().toISOString(),
          exported_at:   null, // (re)appear in the next miss export
        };
      }
    } else {
      // Unmarked — the user says it is NOT a dupe: drop the pairing too.
      post.duplicate_of  = null;
      post.duplicate_sim = null;
      if (post.regex_miss?.missed_fields?.includes('duplicate')) {
        const newFields = post.regex_miss.missed_fields.filter(f => f !== 'duplicate');
        const isEmpty   = newFields.length === 0
                       && Object.keys(post.regex_miss.key_phrases || {}).length === 0
                       && !post.regex_miss.note;
        post.regex_miss = isEmpty ? null : {
          ...post.regex_miss,
          missed_fields: newFields,
          exported_at:   null,
        };
      }
    }
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
    price:      num('tag-price'),
    rooms:      num('tag-rooms'),
    size:       num('tag-size'),
    entry_date: str('tag-entry-date'),
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
    ['price',      'tag-price',      'price'],
    ['rooms',      'tag-rooms',      'rooms'],
    ['size',       'tag-size',       'size'],
    ['entry_date', 'tag-entry-date', 'entry-date'],
    ['roommates',  'tag-roommates',  'roommates'],
    ['broker',     'tag-broker',     'broker'],
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

  // A correction made here answers the same question the 🔬 buttons ask, so
  // record it as a verdict too — which button you happened to reach for should
  // not decide whether the benchmark learns from your answer.
  //
  // ONLY for fields with an open disagreement. saveTagEdits writes
  // tags_human_override as a full six-field snapshot, so editing `rooms` also
  // stamps `price`; recording verdicts for those would fill the benchmark with
  // posts where the model and the regex already agreed — trivially both-correct
  // rows that drag precision toward a meaningless 100%.
  for (const field of SHADOW_FIELDS) {
    if (needsReviewAny(post, field)) recordVerdict(post, field, corrected[field] ?? null);
  }

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
}

function resetFilters() {
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
  el('text-search').value = '';
  el('price-min').value   = '';
  el('price-max').value          = '';
  el('rooms-min').value          = '';
  el('rooms-max').value          = '';
  el('show-dupes').checked = false;
  el('show-only-misses').checked = false;
  el('show-shadow-queue').checked = false;
  applyFilters();
}

async function deleteAllPosts() {
  const count = allPosts.length;
  const noun  = count === 1 ? '1 post' : `${count} posts`;
  if (!count) {
    alert('The database is already empty — nothing to delete.');
    return;
  }
  const confirmed = window.confirm(
    `Delete all ${noun}?\n\nThis cannot be undone, but you can re-scrape to collect them again.`
  );
  if (!confirmed) return;

  const btn = el('delete-all-btn');
  btn.disabled = true;
  try {
    await clearAllPosts();
    await loadPosts();
    applyFilters();
  } finally {
    btn.disabled = false;
  }
}

// Export a chosen subset of posts as JSON. The scope dropdown mirrors the
// sidebar categories: label buckets use effectiveLabel with both sources
// (human wins over AI), duplicates/misses are independent flags, and
// "Current view" exports exactly what the active filters show.
async function exportJSON() {
  const scope = el('export-scope')?.value || 'all';
  const both  = ['human', 'ai'];
  const subsets = {
    all:        () => allPosts,
    view:       () => filteredPosts,
    rental:     () => allPosts.filter(p => effectiveLabel(p, both) === 'rental'),
    not_rental: () => allPosts.filter(p => effectiveLabel(p, both) === 'not_rental'),
    unlabeled:  () => allPosts.filter(p => effectiveLabel(p, both) === 'unlabeled'),
    // Duplicates export also carries each dupe's original (when known), so
    // the file is self-contained for analysing what dedup failed to match.
    duplicates: () => {
      const dupes = allPosts.filter(p => p.is_duplicate);
      const seen  = new Set(dupes.map(p => p.post_id));
      const out   = [...dupes];
      for (const d of dupes) {
        if (d.duplicate_of && !seen.has(d.duplicate_of)) {
          const orig = allPosts.find(p => p.post_id === d.duplicate_of);
          if (orig) { out.push(orig); seen.add(orig.post_id); }
        }
      }
      return out;
    },
    misses:     () => allPosts.filter(p => p.regex_miss),
  };
  const posts = (subsets[scope] || subsets.all)();
  if (posts.length === 0) {
    alert(`No posts in the "${scope}" category — nothing to export.`);
    return;
  }
  const json  = JSON.stringify(posts, null, 2);
  const blob  = new Blob([json], { type: 'application/json' });
  const url   = URL.createObjectURL(blob);
  const date  = new Date().toISOString().slice(0, 10);
  const fname = scope === 'all'
    ? `tlv-rentals-${date}.json`
    : `tlv-rentals-${scope}-${date}.json`;
  const a = Object.assign(document.createElement('a'), { href: url, download: fname });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Sync to local devtools backend ────────────────────────────────────────────
//
// Pushes the full in-memory post list to a local Node server (devtools/,
// gitignored, not part of the shipped extension) that visualizes regex/ML
// reasoning and stats. Manual, button-triggered only — never wired into the
// scrape/save path, so a stopped or missing devtools server can't affect
// scraping. `ml_meta` lets the backend flag when the extension is running
// retrained weights that differ from the bundled lib/ml_weights.js it reads
// directly (it has no access to chrome.storage.local from Node).
// Devtools now runs INSIDE the extension (devtools/devtools.html), reading
// IndexedDB directly. There is no server to start and no sync step: the page
// always sees live data, and being on the extension origin it can also read
// the retrained weights in chrome.storage.local, which the old Node backend
// could not.
function openDevtools() {
  window.open(chrome.runtime.getURL('devtools/devtools.html'), '_blank');
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
// values fill the gaps (so we never throw away tags regex can't re-derive).
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
    const isDupeMiss = m.missed_fields?.includes('duplicate');
    if (m.missed_fields?.length) lines.push(`Missed fields:  ${m.missed_fields.join(', ')}`);
    if (isDupeMiss) {
      lines.push('Duplicate:  manually marked as a dupe — dedup (lib/dedup.js) failed to catch it.'
        + (post.duplicate_of
            ? `  Suspected original: ${post.duplicate_of}${post.duplicate_sim ? ` (similarity ${post.duplicate_sim})` : ''}`
            : '  No similar post found (similarity < 0.55) — pair unknown.'));
    }
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
    // Duplicate misses need the FULL text of both posts — the fix is designed
    // against exactly where the two texts diverge, which truncation can hide.
    if (isDupeMiss) {
      lines.push(post.text || '');
    } else {
      lines.push((post.text || '').slice(0, 600));
      if ((post.text || '').length > 600) lines.push('…[truncated]');
    }
    lines.push('"""');
    if (isDupeMiss && post.duplicate_of) {
      const orig = allPosts.find(p => p.post_id === post.duplicate_of);
      if (orig) {
        lines.push('');
        lines.push(`Suspected original's text (post_id: ${orig.post_id}):`);
        lines.push('"""');
        lines.push(orig.text || '');
        lines.push('"""');
      }
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('Please update lib/regex_extractor.js to handle the cases above.');
  if (toExport.some(p => p.regex_miss.missed_fields?.includes('duplicate'))) {
    lines.push('For "duplicate" misses: improve lib/dedup.js (exact hash / prefix_key) so these are caught automatically.');
  }
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
    // No regex changes does NOT mean nothing to do: the shadow heads may have
    // been retrained, or these posts may predate shadow mode entirely. Offer
    // the ML pass on its own rather than returning and leaving no way to run it.
    if (confirm('The current regex produces the same results as before — no regex changes.\n\n' +
                'Re-score the shadow ML heads (price + roommates) on all stored rentals anyway?')) {
      await commitRetest(diff);
    }
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
  <p class="retest-note">Applying also re-scores the 🔬 shadow ML heads (price + roommates) on every stored rental. Those write to <code>ml_shadow</code> only — never to tags — so they cannot affect notifications. Verdicts you have already recorded are kept.</p>
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

  // ── Then re-score the shadow ML heads across the whole store ──
  // Runs AFTER the regex pass on purpose: shadow records store the regex value
  // they were compared against (`fields[x].regex`), so scoring first would
  // freeze the OLD regex output into every record and report disagreements
  // that no longer exist.
  //
  // Delegated to the service worker, which owns the model heads — one write
  // path for ml_shadow. Existing verdicts survive (reshadow), and tags are
  // never touched, so this cannot alter what the notification filter sees.
  let shadowMsg = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SHADOW_BACKFILL' });
    if (res?.ok) shadowMsg = `\n🔬 Shadow ML re-scored ${res.updated} rental${res.updated !== 1 ? 's' : ''}` +
      `${res.failed ? ` (${res.failed} failed)` : ''}.`;
    else shadowMsg = `\n🔬 Shadow ML re-score failed: ${res?.error || 'unknown error'}`;
  } catch (err) {
    shadowMsg = `\n🔬 Shadow ML re-score failed: ${err.message}`;
  }

  await loadPosts();
  applyFilters();
  const queued = SHADOW_FIELDS.reduce((n, f) => n + reviewQueueCount(allPosts, f), 0);
  alert(`Re-test applied: ${count} post${count !== 1 ? 's' : ''} updated.${shadowMsg}\n\n` +
        `${queued} shadow question${queued !== 1 ? 's' : ''} awaiting review — ` +
        `tick "🔬 ML review queue" in the sidebar to see only those posts.`);
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

// ── Telegram notifications settings modal ─────────────────────────────────────
// Settings live in chrome.storage.local under 'notify_settings' (lib/notify.js),
// which the service worker reads on every SAVE_POST. The dashboard only
// edits them — matching + sending happen in background.js (stage 7c).

async function openNotifyModal() {
  const s = await getNotifySettings();
  el('notify-enabled').checked = s.enabled;
  el('notify-token').value     = s.bot_token;
  el('notify-chat-id').value   = s.chat_id;
  el('notify-max-price').value = s.max_price ?? '';
  el('notify-min-rooms').value = s.min_rooms ?? '';
  el('notify-max-rooms').value = s.max_rooms ?? '';
  el('notify-roommates').value = s.roommates;
  el('notify-broker').value    = s.broker;
  el('notify-include').value   = (s.include_keywords || []).join(', ');
  el('notify-exclude').value   = (s.exclude_keywords || []).join(', ');
  setNotifyStatus('');
  el('notify-overlay').classList.remove('hidden');
}

function readNotifyForm() {
  const num = id => {
    const v = parseFloat(el(id).value);
    return Number.isFinite(v) ? v : null;
  };
  const csv = id => el(id).value.split(',').map(s => s.trim()).filter(Boolean);
  return {
    enabled:          el('notify-enabled').checked,
    bot_token:        el('notify-token').value.trim(),
    chat_id:          el('notify-chat-id').value.trim(),
    max_price:        num('notify-max-price'),
    min_rooms:        num('notify-min-rooms'),
    max_rooms:        num('notify-max-rooms'),
    roommates:        el('notify-roommates').value,
    broker:           el('notify-broker').value,
    include_keywords: csv('notify-include'),
    exclude_keywords: csv('notify-exclude'),
  };
}

async function saveNotifyForm() {
  const s = readNotifyForm();
  await saveNotifySettings(s);
  if (s.enabled && (!s.bot_token || !s.chat_id)) {
    setNotifyStatus('Saved, but notifications are enabled without a bot token / chat ID — nothing will send until both are set.', 'warn');
  } else {
    setNotifyStatus('Saved ✓', 'ok');
  }
}

// Test uses the CURRENT form values, not the saved ones, so the user can
// verify credentials before committing them.
async function sendNotifyTest() {
  const s = readNotifyForm();
  if (!s.bot_token || !s.chat_id) {
    setNotifyStatus('Enter the bot token and chat ID first.', 'err');
    return;
  }
  setNotifyStatus('Sending…');
  try {
    await sendTelegram(s.bot_token, s.chat_id,
      '✅ TLV Rentals test — notifications are working.');
    setNotifyStatus('Test message sent ✓ — check Telegram.', 'ok');
  } catch (err) {
    setNotifyStatus(err.message || String(err), 'err');
  }
}

async function detectNotifyChatId() {
  const token = el('notify-token').value.trim();
  if (!token) {
    setNotifyStatus('Enter the bot token first.', 'err');
    return;
  }
  setNotifyStatus('Detecting…');
  try {
    const id = await detectChatId(token);
    if (id) {
      el('notify-chat-id').value = id;
      setNotifyStatus('Chat ID detected ✓ — remember to Save.', 'ok');
    } else {
      setNotifyStatus('No recent messages found. Open your bot in Telegram, send it any message, then click Detect again.', 'err');
    }
  } catch (err) {
    setNotifyStatus(err.message || String(err), 'err');
  }
}

function setNotifyStatus(text, kind) {
  const box = el('notify-status');
  box.textContent = text;
  box.className = 'notify-status' + (kind ? ` notify-status-${kind}` : '');
}
