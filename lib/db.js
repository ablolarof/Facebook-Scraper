// lib/db.js — IndexedDB wrapper
//
// All posts live in a single "posts" object store, keyed by post_id.
// Used by: background.js (writes), dashboard.js (reads + status updates).
// Content scripts do NOT use this file directly — they send posts to
// background.js via chrome.runtime.sendMessage, which saves them here.

const DB_NAME    = 'tlv-rentals';
const DB_VERSION = 3;
const STORE      = 'posts';

// Cached connection. Lives until the service worker is terminated.
// On the next wake-up, _db is null again and we re-open — that's fine.
// withRetry() also clears it on InvalidStateError so we recover from
// out-of-band connection invalidation (DB upgrade in another tab, etc).
let _db = null;

// Opens the database (or returns the cached connection).
export function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // This callback runs once when the DB is first created, or when DB_VERSION
    // is incremented. It's where we define the schema.
    req.onupgradeneeded = e => {
      const db    = e.target.result;
      const upgTx = e.target.transaction;
      if (!db.objectStoreNames.contains(STORE)) {
        // Fresh install — create store with all current indexes.
        const store = db.createObjectStore(STORE, { keyPath: 'post_id' });
        store.createIndex('group_id',      'group_id',      { unique: false });
        store.createIndex('status',        'status',        { unique: false });
        store.createIndex('scraped_at',    'scraped_at',    { unique: false });
        store.createIndex('dedup_hash',    'dedup_hash',    { unique: false });
        store.createIndex('prefix_key',    'prefix_key',    { unique: false });
        store.createIndex('suffix_key',    'suffix_key',    { unique: false });
      } else {
        // Upgrade from v1: add the prefix_key index to the existing store.
        const store = upgTx.objectStore(STORE);
        if (!store.indexNames.contains('prefix_key')) {
          store.createIndex('prefix_key', 'prefix_key', { unique: false });
        }
        // Upgrade from v2 (2026-07-25): add the suffix_key index — reposts
        // often edit the headline (defeating prefix_key) but leave the
        // closing lines (location/conditions/contact) untouched.
        if (!store.indexNames.contains('suffix_key')) {
          store.createIndex('suffix_key', 'suffix_key', { unique: false });
        }
      }
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(new Error(`DB open failed: ${e.target.error}`));
  });
}

// Run an IDB operation, retrying once after clearing the cached connection
// if the underlying connection was invalidated (e.g. user cleared site data,
// or a schema upgrade happened in another tab). Other errors propagate.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const name = err && err.name;
    if (name === 'InvalidStateError' || name === 'TransactionInactiveError') {
      _db = null;
      return await fn();
    }
    throw err;
  }
}

// Insert or overwrite a single post (upsert by post_id).
export async function savePost(post) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(post);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  });
}

// Retrieve one post by post_id. Returns null if not found.
export async function getPost(postId) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(postId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  });
}

// Retrieve every post. The dashboard sorts them in JS (newest first).
export async function getAllPosts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// Permanently remove a post by post_id. The same post will be re-saved if
// it appears in a future scrape (dedup_hash will be re-computed and matched).
export async function deletePost(postId) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(postId);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  });
}

// Change just the status field of a post ('new' | 'seen' | 'interested' | 'hidden').
export async function updatePostStatus(postId, status) {
  const post = await getPost(postId);
  if (!post) throw new Error(`Post not found: ${postId}`);
  post.status = status;
  return savePost(post);
}

// Return the first existing post that has this dedup_hash, or null if none.
// excludePostId guards against self-shadowing: index.get() returns the
// LOWEST-primary-key match, which on a re-scrape can be the post itself —
// hiding a true duplicate that sorts after it. getAll(hash, 2) fetches the
// two lowest matches so the first non-self row is always visible.
export async function findByDedupHash(hash, excludePostId = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const index = db
      .transaction(STORE, 'readonly')
      .objectStore(STORE)
      .index('dedup_hash');
    const req = index.getAll(hash, 2);
    req.onsuccess = () => {
      const rows = req.result || [];
      resolve(rows.find(r => r.post_id !== excludePostId) ?? null);
    };
    req.onerror   = () => reject(req.error);
  });
}

// Total number of records in the store.
export async function countPosts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// Delete every record from the posts store in a single transaction.
// After this call, findByDedupHash() returns null for every hash, so the
// next scrape re-saves all posts as fresh (no duplicates suppressed).
export async function clearAllPosts() {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  });
}

// Return the first existing post that has this prefix_key, or null if none.
// Used by background.js for near-duplicate detection. excludePostId prevents
// the self-shadowing bug (see findByDedupHash) — confirmed live: a re-scraped
// post whose post_id sorted below its cross-group original returned ITSELF
// from index.get(), so the pair was never marked.
export async function findByPrefixKey(key, excludePostId = null) {
  if (!key) return null;
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const index = db
        .transaction(STORE, 'readonly')
        .objectStore(STORE)
        .index('prefix_key');
      const req = index.getAll(key, 2);
      req.onsuccess = () => {
        const rows = req.result || [];
        resolve(rows.find(r => r.post_id !== excludePostId) ?? null);
      };
      req.onerror   = () => reject(req.error);
    });
  });
}

// Return every existing post sharing this suffix_key (capped at 50 — a
// popular broker template can recur often), or [] if none. Unlike
// findByPrefixKey this returns ALL candidates rather than just the first:
// a shared suffix (e.g. the same agency's closing lines) is a much weaker
// signal than a shared prefix, so the caller must score each candidate by
// whole-text similarity rather than trust the first match blindly.
export async function findAllBySuffixKey(key, excludePostId = null) {
  if (!key) return [];
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const index = db
        .transaction(STORE, 'readonly')
        .objectStore(STORE)
        .index('suffix_key');
      const req = index.getAll(key, 50);
      req.onsuccess = () => resolve((req.result || []).filter(r => r.post_id !== excludePostId));
      req.onerror   = () => reject(req.error);
    });
  });
}

// Returns all posts serialised to a JSON string. Used by the Export button.
export async function exportAllJSON() {
  const posts = await getAllPosts();
  return JSON.stringify(posts, null, 2);
}

// Return all rental posts (human or AI labeled) that have no extracted tags yet.
// Used by the dashboard "Extract Tags" backfill button.
export async function getRentalPostsWithoutTags() {
  const posts = await getAllPosts();
  return posts
    .filter(p => {
      const label = p.human_label || p.ai_label;
      return label === 'rental' && !p.tags;
    })
    .sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));
}

// Return all posts that have NO human label AND NO ai label, sorted newest first.
// Used by the dashboard backfill button to find posts that need classifying.
export async function getUnlabeledPosts() {
  const posts = await getAllPosts();
  return posts
    .filter(p => !p.human_label && !p.ai_label)
    .sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));
}
