// devtools/server.mjs — local regex/ML visualization backend.
//
// NOT part of the shipped extension (devtools/ is gitignored). Imports the
// extension's real lib/*.js modules directly — same trick ml/train.mjs
// already uses — so "reasoning" shown here is the actual decision code, not
// a reimplementation that can drift out of sync.
//
// Run: node devtools/server.mjs   →   http://localhost:8787

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { regexExtractTags, regexClassifyPost } from '../lib/regex_extractor.js';
import { mlHybridLabel, mlBrokerProb, mlBrokerFill, ML_CONFIDENCE, BROKER_CONFIDENCE }
  from '../lib/ml_classifier.js';
import { uniqueTokens } from '../lib/ml_features.js';
import {
  ML_META, ML_LABEL_WEIGHTS, ML_BROKER_WEIGHTS,
} from '../lib/ml_weights.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'latest.json');
const PORT = 8787;

// ── In-memory last-synced payload, backed by data/latest.json ──────────────

let lastSync = null; // { posts, ml_meta, synced_at }

async function loadLastSync() {
  try {
    lastSync = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch {
    lastSync = null; // no sync yet, or file unreadable — fine, endpoints handle null
  }
}

async function saveLastSync(payload) {
  lastSync = payload;
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(payload, null, 2));
}

// ── Stats ────────────────────────────────────────────────────────────────

function effectiveLabel(post) {
  const label = post.human_label || post.ai_label;
  return label || 'unlabeled';
}

function computeStats(posts) {
  const total = posts.length;
  const byLabel = { rental: 0, not_rental: 0, unlabeled: 0 };
  const byClassifiedBy = {};
  let mlOverrides = 0, mlClassified = 0;
  let duplicates = 0;
  let missesTotal = 0, missesPending = 0;
  const tagFields = ['price', 'rooms', 'size', 'entry_date', 'roommates', 'broker'];
  const tagCounts = Object.fromEntries(tagFields.map(f => [f, 0]));
  let rentalCount = 0;
  let brokerFromRegex = 0, brokerFromMl = 0;
  let enrichOk = 0, enrichFailed = 0;
  let notifySent = 0, notifyFailed = 0;

  for (const p of posts) {
    byLabel[effectiveLabel(p)]++;

    const by = p.ai_classified_by || 'none';
    byClassifiedBy[by] = (byClassifiedBy[by] || 0) + 1;
    if (by === 'ml') { mlClassified++; mlOverrides++; }

    if (p.is_duplicate) duplicates++;

    if (p.regex_miss) {
      missesTotal++;
      if (!p.regex_miss.exported_at) missesPending++;
    }

    if (effectiveLabel(p) === 'rental') {
      rentalCount++;
      const tags = p.tags_human_override
        ? { ...p.tags, ...p.tags_human_override }
        : (p.tags || {});
      for (const f of tagFields) if (tags[f] != null && tags[f] !== '') tagCounts[f]++;
      if (tags.broker != null) {
        if (p.ml_filled?.includes('broker')) brokerFromMl++;
        else brokerFromRegex++;
      }
    }

    if (p.listing_enriched_at) enrichOk++;
    if (p.enrich_failed_at) enrichFailed++;

    if (p.notified_at) notifySent++;
    if (p.notify_failed_at) notifyFailed++;
  }

  return {
    total,
    byLabel,
    byClassifiedBy,
    mlOverrideRate: mlClassified ? mlOverrides / total : 0,
    duplicates,
    duplicateRate: total ? duplicates / total : 0,
    misses: { total: missesTotal, pending: missesPending },
    tagCompleteness: Object.fromEntries(
      tagFields.map(f => [f, rentalCount ? tagCounts[f] / rentalCount : 0])
    ),
    rentalCount,
    brokerProvenance: { regex: brokerFromRegex, ml: brokerFromMl },
    enrichment: { ok: enrichOk, failed: enrichFailed },
    notify: { sent: notifySent, failed: notifyFailed },
  };
}

// ── Weights ──────────────────────────────────────────────────────────────

function topTokens(weights, n = 25) {
  const entries = Object.entries(weights).map(([token, [w]]) => [token, w]);
  entries.sort((a, b) => b[1] - a[1]);
  return {
    positive: entries.slice(0, n).map(([token, w]) => ({ token, weight: w })),
    negative: entries.slice(-n).reverse().map(([token, w]) => ({ token, weight: w })),
  };
}

function buildWeightsResponse() {
  return {
    meta: ML_META,
    extensionActiveMeta: lastSync?.ml_meta || null,
    label: topTokens(ML_LABEL_WEIGHTS),
    broker: topTokens(ML_BROKER_WEIGHTS),
  };
}

// ── Classify (reasoning playground) ─────────────────────────────────────

function tokenContributions(weights, text, n = 15) {
  const tokens = uniqueTokens(text || '');
  let norm = 0;
  const hits = [];
  for (const t of tokens) {
    const wi = weights[t];
    if (wi !== undefined) { hits.push([t, wi[0], wi[1]]); norm += wi[1] * wi[1]; }
  }
  norm = Math.sqrt(norm) || 1;
  const scored = hits.map(([token, w, idf]) => ({ token, contribution: w * (idf / norm) }));
  scored.sort((a, b) => b.contribution - a.contribution);
  return {
    towardRental: scored.slice(0, n).filter(s => s.contribution > 0),
    towardNotRental: scored.slice(-n).reverse().filter(s => s.contribution < 0),
  };
}

function classify(text) {
  const regexLabel = regexClassifyPost(text);
  const regexTags = regexExtractTags(text);
  const hybrid = mlHybridLabel(text, regexLabel);
  const brokerProb = mlBrokerProb(text);
  const brokerFill = mlBrokerFill(text);
  const contributions = tokenContributions(ML_LABEL_WEIGHTS, text);

  return {
    regex: { label: regexLabel, tags: regexTags },
    ml: {
      prob: hybrid.prob,
      label: hybrid.label,
      overrode: hybrid.overrode,
      confidenceThreshold: ML_CONFIDENCE,
      contributions,
    },
    broker: {
      prob: brokerProb,
      fill: brokerFill,
      confidenceThreshold: BROKER_CONFIDENCE,
    },
    final: {
      label: hybrid.label,
      broker: regexTags.broker ?? brokerFill,
    },
  };
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function serveStatic(req, res) {
  let reqPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readJsonBody(req);
      const posts = Array.isArray(body.posts) ? body.posts : [];
      await saveLastSync({ posts, ml_meta: body.ml_meta || null, synced_at: body.synced_at || new Date().toISOString() });
      sendJson(res, 200, { ok: true, count: posts.length });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stats') {
      sendJson(res, 200, {
        synced_at: lastSync?.synced_at || null,
        stats: computeStats(lastSync?.posts || []),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/weights') {
      sendJson(res, 200, buildWeightsResponse());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/classify') {
      const body = await readJsonBody(req);
      sendJson(res, 200, classify(body.text || ''));
      return;
    }

    await serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

await loadLastSync();
server.listen(PORT, () => {
  console.log(`[devtools] listening on http://localhost:${PORT}`);
  console.log(lastSync
    ? `[devtools] loaded previous sync: ${lastSync.posts.length} posts from ${lastSync.synced_at}`
    : `[devtools] no previous sync found — waiting for the dashboard's Sync to Devtools button`);
});
