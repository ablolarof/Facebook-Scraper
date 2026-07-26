// devtools/public/app.js — vanilla JS frontend for the local devtools backend.

function el(id) { return document.getElementById(id); }
function pct(n) { return `${(n * 100).toFixed(1)}%`; }

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

async function loadStats() {
  const res = await fetch('/api/stats');
  const { synced_at, stats } = await res.json();

  el('sync-info').textContent = synced_at
    ? `Last synced: ${new Date(synced_at).toLocaleString()} (${stats.total} posts)`
    : 'No data synced yet — click "🛰 Sync to Devtools" in the dashboard';

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
      ${entries.map(e => `<span class="token-chip ${cls}">${e.token} (${e.weight.toFixed(2)})</span>`).join('')}
    </div>
  `;
}

async function loadWeights() {
  const res = await fetch('/api/weights');
  const data = await res.json();
  const meta = data.meta || {};
  const active = data.extensionActiveMeta;

  const activeNote = active && active.source === 'retrained'
    ? `<p style="color:var(--neg)">⚠ The extension is currently running <strong>retrained</strong> weights
       (${active.gold_rows ?? active.label_rows ?? '?'} rows, trained ${active.trained_at || 'unknown date'}) —
       different from the bundled weights shown below, which Node can't read from chrome.storage.local.</p>`
    : `<p style="color:var(--muted)">Extension is running bundled weights (or no sync yet) — matches what's shown below.</p>`;

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
    const res = await fetch('/api/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const r = await res.json();

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
    `;
  } finally {
    el('classify-btn').disabled = false;
  }
}

el('classify-btn').addEventListener('click', classify);

// ── Init ─────────────────────────────────────────────────────────────────

loadStats();
loadWeights();
