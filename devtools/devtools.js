// devtools/devtools.js — in-extension devtools page (no Node required).
//
// Runs at chrome-extension://[id]/devtools/devtools.html, so it shares the
// extension origin with the dashboard and service worker. That buys three
// things the Node shell could never have:
//
//   1. No sync step. It reads IndexedDB directly, so what you see is live —
//      there is no "last synced" copy to go stale.
//   2. It can read chrome.storage.local, so the Weights tab shows the weights
//      that are ACTUALLY active. The Node server had to print a warning banner
//      admitting it could not see retrained weights.
//   3. No personal post content is written to disk as JSON, and no
//      localhost host permission is needed.
//
// Every statistic comes from ./devtools_core.js — the same module the Node
// shell imports — so the two can never disagree about what a number means.
// The rendering below is unchanged from the original public/app.js.

import { getAllPosts } from '../lib/db.js';
import {
  computeStats, computeShadowStats, buildWeightsResponse, buildShadowWeightsResponse,
  classify as classifyText,
} from './devtools_core.js';
import { activeMlMeta, loadStoredMlWeights } from '../lib/ml_classifier.js';
import { loadStoredPriceWeights, activePriceMeta } from '../lib/ml_price.js';
import { loadStoredRoommatesWeights, activeRoommatesMeta } from '../lib/ml_roommates.js';

// Cached post list — every tab reads the same snapshot so the numbers on one
// tab cannot describe a different moment than the numbers on another.
let POSTS = [];

async function refresh() {
  // Load whatever weights are actually promoted BEFORE computing anything, so
  // the reasoning playground and weight metadata describe the live model.
  await Promise.all([
    loadStoredMlWeights(), loadStoredPriceWeights(), loadStoredRoommatesWeights(),
  ]);
  POSTS = await getAllPosts();
  el('sync-info').textContent =
    `${POSTS.length} posts · live from IndexedDB · ${new Date().toLocaleTimeString()}`;
  loadStats();
  loadShadow();
  loadWeights();
}

function el(id) { return document.getElementById(id); }
function pct(n) { return `${(n * 100).toFixed(1)}%`; }

// Model tokens can contain markup-significant characters — the tokenizer keeps
// "<" and ">", so "<num>" is a real, high-weight token. Injected raw it renders
// as an unknown element and the chip shows up blank.
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FEATURE_LEGEND = `L1:/R1: word immediately before/after the number ·
  L:/R: any word in the ±45-char window · MAG: magnitude bucket ·
  PERIOD: period the number is quoted for · RENTLBL: a rent label sits right before it ·
  CUR_L/CUR_R: currency symbol adjacent · SIDECOST: preceded by arnona/vaad/deposit ·
  LINESTART: the number begins its line · COMMA/NDIG: formatting and digit count`;

function shadowWeightsHTML(sw) {
  const metaRow = (m) => `
    <dl class="kv">
      <dt>weights in force</dt><dd>${escHtml(m.source || 'bundled')}</dd>
      <dt>trained</dt><dd>${m.trained_at ? new Date(m.trained_at).toLocaleString() : 'not trained yet'}</dd>
      ${m.heldout_precision != null ? `<dt>held-out precision</dt><dd>${pct(m.heldout_precision)}</dd>` : ''}
      ${m.heldout_accuracy != null ? `<dt>held-out accuracy</dt><dd>${pct(m.heldout_accuracy)}</dd>` : ''}
      ${m.human_labeled != null ? `<dt>human-labeled rows</dt><dd>${m.human_labeled}</dd>` : ''}
    </dl>`;
  return `
    <h2>🔬 Shadow heads</h2>
    <p class="muted">These predict but never tag. Weights shown are the ones actually in force —
    retrained weights live in chrome.storage.local and are read directly by this page.</p>

    <h3>Price ranker</h3>
    ${metaRow(sw.price.meta)}
    <p class="muted">Emits a shadow prediction at ≥ ${sw.price.emitThreshold};
    the bar for ever tagging with it is ${sw.price.deployThreshold}.</p>
    <p class="muted">${FEATURE_LEGEND}</p>
    <div class="result-panel">
      ${tokenTable('Toward “this number is the rent”', sw.price.positive, 'pos')}
      ${tokenTable('Away from it', sw.price.negative, 'neg')}
    </div>

    <h3>Roommates head</h3>
    ${metaRow(sw.roommates.meta)}
    <p class="muted">Trained on keyword-MASKED text, so high-weight tokens should reflect the
    register of a room-share rather than the trigger phrase itself. Bare Hebrew suffixes here
    (ים, ות, פים) are masking leftovers — the keyword bleeding through, not learned register.</p>
    <div class="result-panel">
      ${tokenTable('Toward room-share', sw.roommates.positive, 'pos')}
      ${tokenTable('Toward whole apartment', sw.roommates.negative, 'neg')}
    </div>`;
}

function shadowReasoningHTML(sd) {
  const p = sd.price, r = sd.roommates;
  return `
    <div class="result-panel">
      <h3>🔬 Shadow price ranker <span class="muted">(never tags)</span></h3>
      ${p.shortStay
        ? '<p class="neg">Short-stay listing — abstains entirely; there is no monthly rent to find.</p>'
        : ''}
      <p>Emits at ≥ ${p.threshold} →
        <strong>${p.value == null ? 'abstained' : '₪' + p.value.toLocaleString()}</strong></p>
      ${p.candidates.length ? `
      <table>
        <tr><th>candidate</th><th>score</th><th>period</th><th>signals</th></tr>
        ${p.candidates.map(c => `<tr>
          <td>${c.value.toLocaleString()}</td>
          <td class="${c.prob >= p.threshold ? 'pos' : 'muted'}">${c.prob.toFixed(3)}</td>
          <td>${escHtml(c.period || '—')}</td>
          <td class="muted">${c.features.map(escHtml).join(' ')}</td></tr>`).join('')}
      </table>` : '<p class="muted">No candidate numbers in range.</p>'}
      ${p.rejected.length
        ? `<p class="muted">rejected before scoring: ${p.rejected.map(x => escHtml(x.raw) + ' (' + escHtml(x.reason) + ')').join(', ')}</p>`
        : ''}
    </div>

    <div class="result-panel">
      <h3>🔬 Shadow roommates <span class="muted">(never tags)</span></h3>
      <p>p = ${r.prob} → <strong>${r.value ? 'room share' : 'whole apartment'}</strong>
        <span class="muted">(${r.matchedTokens} known tokens matched)</span></p>
      <div class="token-list">
        ${r.towardRoommates.map(t => `<span class="token-chip pos">${escHtml(t.token)} (+${t.contribution.toFixed(3)})</span>`).join('')}
        ${r.towardWhole.map(t => `<span class="token-chip neg">${escHtml(t.token)} (${t.contribution.toFixed(3)})</span>`).join('')}
      </div>
    </div>`;
}


// ── Tabs ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    el(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Stats ────────────────────────────────────────────────────────────────

function loadStats() {
  const stats = computeStats(POSTS);

  const tiles = [
    ['Total posts', stats.total],
    ['Rental', stats.byLabel.rental],
    ['Not rental', stats.byLabel.not_rental],
    ['Unlabeled', stats.byLabel.unlabeled],
    ['Duplicates', `${stats.duplicates} (${pct(stats.duplicateRate)})`],
    ['ML overrides', `${stats.byClassifiedBy.ml || 0} (${pct(stats.mlOverrideRate)})`],
    ['Regex misses', `${stats.misses.pending} pending / ${stats.misses.total} total`],
    ['Enrichment', `${stats.enrichment.ok} ok / ${stats.enrichment.failed} failed`],
    ['Notify sent', `${stats.notify.sent} sent / ${stats.notify.failed} failed`],
  ];

  el('tab-stats').innerHTML = `
    <h2>Overview</h2>
    <div class="stat-grid">
      ${tiles.map(([label, value]) => `
        <div class="stat-tile"><div class="value">${value}</div><div class="label">${label}</div></div>
      `).join('')}
    </div>

    <h2>Classified by</h2>
    <table>
      <tr><th>Source</th><th>Count</th></tr>
      ${Object.entries(stats.byClassifiedBy).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
    </table>

    <h2>Tag completeness (rental posts, n=${stats.rentalCount})</h2>
    <table>
      <tr><th>Field</th><th>Filled</th></tr>
      ${Object.entries(stats.tagCompleteness).map(([k, v]) => `<tr><td>${k}</td><td>${pct(v)}</td></tr>`).join('')}
    </table>

    <h2>Broker tag provenance</h2>
    <table>
      <tr><th>Source</th><th>Count</th></tr>
      <tr><td>regex</td><td>${stats.brokerProvenance.regex}</td></tr>
      <tr><td>ml_filled</td><td>${stats.brokerProvenance.ml}</td></tr>
    </table>
  `;
}

// ── Weights ──────────────────────────────────────────────────────────────

function tokenTable(title, entries, cls) {
  return `
    <h3>${title}</h3>
    <div class="token-list">
      ${entries.map(e => `<span class="token-chip ${cls}">${escHtml(e.token)} (${e.weight.toFixed(2)})</span>`).join('')}
    </div>
  `;
}

function loadWeights() {
  const active = activeMlMeta();
  const data = buildWeightsResponse(active);
  const meta = data.meta || {};

  // Unlike the Node shell, this page CAN read chrome.storage.local — so it
  // reports the weights actually in force rather than guessing.
  const shadowMeta = [
    ['price', activePriceMeta()],
    ['roommates', activeRoommatesMeta()],
  ].map(([n, m]) => `<dt>${n} head</dt><dd>${m.source}${m.trained_at ? ` · trained ${new Date(m.trained_at).toLocaleString()}` : ' · not trained yet'}</dd>`).join('');

  const activeNote = `
    <p class="${active.source === 'retrained' ? 'pos' : 'muted'}">
      Label/broker weights in force: <strong>${active.source}</strong>${
        active.source === 'retrained'
          ? ` (${active.gold_rows ?? active.label_rows ?? '?'} rows, CV ${active.cv_accuracy != null ? pct(active.cv_accuracy) : '?'}, trained ${active.trained_at ? new Date(active.trained_at).toLocaleString() : '?'})`
          : ' — the bundled weights shown below'}.
    </p>
    <dl class="kv">${shadowMeta}</dl>
    <p class="muted">Token lists below are always the bundled <code>lib/ml_weights.js</code>;
    retrained weights live in chrome.storage.local and are used for scoring, not listed here.</p>`;

  el('tab-weights').innerHTML = `
    <h2>Model metadata (bundled lib/ml_weights.js)</h2>
    <dl class="kv">
      <dt>Feature version</dt><dd>${meta.feature_version ?? '?'}</dd>
      <dt>Gold rows</dt><dd>${meta.gold_rows ?? meta.label_rows ?? '?'}</dd>
      <dt>CV accuracy</dt><dd>${meta.cv_accuracy != null ? pct(meta.cv_accuracy) : '?'}</dd>
      <dt>Trained at</dt><dd>${meta.trained_at ?? '?'}</dd>
    </dl>
    ${activeNote}

    <h2>Label head — top tokens</h2>
    <div class="result-panel">
      ${tokenTable('Toward rental', data.label.positive, 'pos')}
      ${tokenTable('Toward not-rental', data.label.negative, 'neg')}
    </div>

    <h2>Broker head — top tokens</h2>
    <div class="result-panel">
      ${tokenTable('Toward has-broker-fee', data.broker.positive, 'pos')}
      ${tokenTable('Toward no-broker-fee', data.broker.negative, 'neg')}
    </div>

    ${shadowWeightsHTML(buildShadowWeightsResponse())}
  `;
}

// ── Reasoning playground ────────────────────────────────────────────────

function labelBadge(label) {
  const cls = label === 'rental' ? 'rental' : label === 'not_rental' ? 'not_rental' : 'null';
  return `<span class="badge ${cls}">${label ?? 'null (ambiguous)'}</span>`;
}

async function classify() {
  const text = el('classify-text').value.trim();
  if (!text) return;
  el('classify-btn').disabled = true;
  try {
    const r = classifyText(text);

    el('reasoning-result').innerHTML = `
      <div class="result-panel">
        <h3>Regex</h3>
        <p>Label: ${labelBadge(r.regex.label)}</p>
        <dl class="kv">
          ${Object.entries(r.regex.tags).map(([k, v]) => `<dt>${k}</dt><dd>${v ?? '—'}</dd>`).join('')}
        </dl>
      </div>

      <div class="result-panel">
        <h3>ML classification</h3>
        <p>
          Probability of rental: <strong>${(r.ml.prob * 100).toFixed(1)}%</strong>
          (override threshold ${(r.ml.confidenceThreshold * 100).toFixed(0)}%) —
          ${r.ml.overrode ? '<strong style="color:var(--neg)">overrode the regex label</strong>' : 'did not override'}
        </p>
        <p>Hybrid final label: ${labelBadge(r.ml.label)}</p>
        <h3>Top contributing tokens</h3>
        <div class="token-list">
          ${r.ml.contributions.towardRental.map(t => `<span class="token-chip pos">${t.token} (+${t.contribution.toFixed(3)})</span>`).join('')}
          ${r.ml.contributions.towardNotRental.map(t => `<span class="token-chip neg">${t.token} (${t.contribution.toFixed(3)})</span>`).join('')}
        </div>
      </div>

      <div class="result-panel">
        <h3>Broker fill</h3>
        <p>
          Probability: <strong>${(r.broker.prob * 100).toFixed(1)}%</strong>
          (confidence threshold ${(r.broker.confidenceThreshold * 100).toFixed(0)}%) —
          fill decision: <strong>${r.broker.fill === null ? 'not confident enough' : r.broker.fill}</strong>
        </p>
      </div>

      <div class="result-panel">
        <h3>Final (what would be saved)</h3>
        <dl class="kv">
          <dt>Label</dt><dd>${labelBadge(r.final.label)}</dd>
          <dt>Broker</dt><dd>${r.final.broker ?? '—'}</dd>
        </dl>
      </div>

      ${shadowReasoningHTML(r.shadow)}
    `;
  } finally {
    el('classify-btn').disabled = false;
  }
}

el('classify-btn').addEventListener('click', classify);

// ── Shadow ML ────────────────────────────────────────────────────────────
//
// Shadow heads predict but never tag: their values live in post.ml_shadow,
// never post.tags, so they cannot reach the Telegram filter. This panel is
// the only place their progress is reported — the dashboard shows none of it
// on purpose, because a half-trained model's score is a lab number, not
// something to read while browsing apartments.

function barRow(label, value, bar) {
  if (value == null) return `<tr><td>${label}</td><td colspan="2" class="muted">no verdicts yet</td></tr>`;
  const pctVal = value * 100;
  const pctBar = bar == null ? null : bar * 100;
  const cls = (pctBar != null && pctVal >= pctBar) ? 'pos' : 'neg';
  return `<tr>
    <td>${label}</td>
    <td><div class="meter"><div class="meter-fill ${cls}" style="width:${Math.min(100, pctVal).toFixed(1)}%"></div>` +
      (pctBar != null ? `<div class="meter-bar" style="left:${Math.min(100, pctBar).toFixed(1)}%"></div>` : '') +
    `</div></td>
    <td class="${cls}"><strong>${pctVal.toFixed(1)}%</strong>${pctBar != null ? ` <span class="muted">/ ${pctBar.toFixed(1)}% bar</span>` : ''}</td>
  </tr>`;
}

function shadowFieldCard(name, f) {
  const modelMeta = f.model || {};
  const status = f.meets_bar
    ? '<span class="badge rental">MEETS BAR</span>'
    : f.enough_evidence
      ? '<span class="badge not_rental">below bar</span>'
      : `<span class="badge null">needs ${f.min_verdicts - f.verdicts} more verdict(s)</span>`;

  return `
    <div class="shadow-card">
      <h3><span class="shadow-field-name">${name}</span> ${status}</h3>
      <p class="muted">Scored on <strong>${f.metric}</strong> — bar is ${f.bar_kind}.</p>
      <table class="meter-table">
        ${barRow(f.metric, f.score, f.bar)}
      </table>
      <dl class="kv">
        <dt>Verdicts recorded</dt><dd>${f.verdicts} / ${f.min_verdicts} needed</dd>
        <dt>Awaiting review</dt><dd>${f.queue}</dd>
        <dt>Values emitted</dt><dd>${f.emitted}</dd>
        ${f.regex_accuracy != null ? `<dt>Regex accuracy (same posts)</dt><dd>${pct(f.regex_accuracy)}</dd>` : ''}
        ${f.accuracy != null ? `<dt>ML accuracy (all verdicts)</dt><dd>${pct(f.accuracy)}</dd>` : ''}
        ${f.coverage_on_regex_null != null
            ? `<dt>Fills where regex was null</dt><dd>${f.filled_regex_null} / ${f.regex_null_posts} (${pct(f.coverage_on_regex_null)})</dd>`
            : ''}
        <dt>Weights trained</dt><dd>${modelMeta.trained_at ? new Date(modelMeta.trained_at).toLocaleString() : 'stub — not trained'}</dd>
      </dl>
      <h4>Precision by disagreement shape</h4>
      <p class="muted">Whether this head should FILL gaps only, or is trustworthy enough to OVERRIDE the regex.</p>
      <table>
        <tr><th>Shape</th><th>n</th><th>ML right</th><th>regex right</th></tr>
        ${['fill','override','abstain'].map(k => {
          const d = (f.byDirection || {})[k] || { n: 0 };
          const lbl = k === 'fill' ? 'fill — regex had nothing'
                    : k === 'override' ? 'override — both had a value, differing'
                    : 'abstain — ML declined, regex had a value';
          return `<tr><td>${lbl}</td><td>${d.n}</td>` +
                 `<td class="pos">${d.ml_precision == null ? '—' : pct(d.ml_precision)}</td>` +
                 `<td class="neg">${d.regex_precision == null ? '—' : pct(d.regex_precision)}</td></tr>`;
        }).join('')}
      </table>

      <h4>Who was right, on judged posts</h4>
      <table>
        <tr><th>Outcome</th><th>Count</th></tr>
        <tr><td>both correct</td><td>${f.breakdown.both}</td></tr>
        <tr><td>ML only</td><td class="pos">${f.breakdown.ml_only}</td></tr>
        <tr><td>regex only</td><td class="neg">${f.breakdown.regex_only}</td></tr>
        <tr><td>neither — rule gap</td><td>${f.breakdown.neither}</td></tr>
      </table>
    </div>`;
}

function loadShadow() {
  const shadow = computeShadowStats(POSTS);

  if (!shadow || !shadow.scored) {
    el('tab-shadow').innerHTML = `
      <h2>Shadow ML</h2>
      <p class="muted">No shadow-scored posts in the last sync.
      Run <strong>Re-test Regex + ML</strong> (or 🔬 Shadow Backfill) in the dashboard,
      then hit ↺ Refresh here.</p>`;
    return;
  }

  const leakNote = shadow.leaks.count === 0
    ? `<p class="pos">✔ Isolation holds: no shadow value has reached <code>post.tags</code> in ${shadow.scored} scored posts.</p>`
    : `<p class="neg"><strong>⚠ ${shadow.leaks.count} leak(s)</strong> — a shadow value reached <code>post.tags</code>,
       which means it can influence Telegram notifications. This must be zero.<br>
       <code>${shadow.leaks.post_ids.join(', ')}</code></p>`;

  const cards = Object.entries(shadow.fields).map(([name, f]) =>
    shadowFieldCard(name, { ...f, model: shadow.models[name] })).join('');

  el('tab-shadow').innerHTML = `
    <h2>Shadow ML</h2>
    <p class="muted">These heads predict but do not tag. Values live in
    <code>post.ml_shadow</code>, never <code>post.tags</code>, so a wrong prediction
    cannot suppress or trigger a notification — it only costs a review.</p>

    <div class="stat-grid">
      <div class="stat-tile"><div class="value">${shadow.scored}</div><div class="label">Posts scored</div></div>
      <div class="stat-tile"><div class="value">${shadow.unscored}</div><div class="label">Not scored</div></div>
      ${Object.entries(shadow.fields).map(([n, f]) => `
        <div class="stat-tile"><div class="value">${f.queue}</div><div class="label">${n} to review</div></div>
      `).join('')}
    </div>

    ${leakNote}

    <div class="shadow-grid">${cards}</div>
  `;
}

// ── Init ─────────────────────────────────────────────────────────────────

el('reload-btn').addEventListener('click', refresh);

// Re-read whenever the tab is brought back into view. Without this the page
// silently shows whatever was true when it was opened: judge a batch of posts
// in the dashboard, switch back here, and the old numbers sit there looking
// authoritative. A stale statistic that looks live is worse than no statistic,
// and this view exists precisely to be trusted.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
