// devtools/server.mjs — OPTIONAL Node shell for the devtools views.
//
// You do not need this. The normal way to use devtools is the in-extension
// page (devtools/devtools.html, opened by the dashboard's 🔬 Devtools button),
// which reads live IndexedDB, needs no sync step, and — unlike this process —
// can see retrained weights in chrome.storage.local.
//
// This shell remains useful for one thing: inspecting an EXPORTED json file
// offline, without loading the extension.
//
//   node devtools/server.mjs                     → serves whatever was last synced
//   node devtools/server.mjs <export.json>       → loads that export instead
//   TLV_DEVTOOLS_PORT=8788 node devtools/server.mjs
//
// All statistics come from ./devtools_core.js, which the extension page also
// imports, so the two shells cannot disagree about what a number means.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeStats, computeShadowStats, buildWeightsResponse, buildShadowWeightsResponse, classify,
} from './devtools_core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'latest.json');
// Overridable so a second instance can run alongside one you already have up
// (TLV_DEVTOOLS_PORT=8788 node devtools/server.mjs). Default is unchanged, so
// the dashboard's hard-coded localhost:8787 sync target still works.
const PORT = Number(process.env.TLV_DEVTOOLS_PORT) || 8787;

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

    if (req.method === 'GET' && url.pathname === '/api/shadow') {
      sendJson(res, 200, {
        synced_at: lastSync?.synced_at || null,
        shadow: computeShadowStats(lastSync?.posts || []),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/weights') {
      sendJson(res, 200, buildWeightsResponse(lastSync?.ml_meta || null));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/shadow-weights') {
      sendJson(res, 200, buildShadowWeightsResponse());
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

// A path argument loads an export directly — the Node shell no longer depends
// on the dashboard's sync button, which the in-extension page made redundant.
const argPath = process.argv[2];
if (argPath) {
  const posts = JSON.parse(await fs.readFile(argPath, 'utf8'));
  lastSync = { posts: Array.isArray(posts) ? posts : posts.posts || [],
               ml_meta: null, synced_at: new Date().toISOString() };
  console.log(`[devtools] loaded ${lastSync.posts.length} posts from ${argPath}`);
} else {
  await loadLastSync();
}
server.listen(PORT, () => {
  console.log(`[devtools] listening on http://localhost:${PORT}`);
  console.log(lastSync
    ? `[devtools] loaded previous sync: ${lastSync.posts.length} posts from ${lastSync.synced_at}`
    : `[devtools] no previous sync found — waiting for the dashboard's Sync to Devtools button`);
});
