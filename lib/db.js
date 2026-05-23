// lib/db.js — IndexedDB wrapper
//
// All posts live in a single "posts" object store, keyed by post_id.
// Used by: background.js (writes), dashboard.js (reads + status updates).
// Content scripts do NOT use this file directly — they send posts to
// background.js via chrome.runtime.sendMessage, which saves them here.

const DB_NAME    = 'tlv-rentals';
const DB_VERSION = 1;
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
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'post_id' });
        // Indexes let us look up posts by a field without scanning everything.
        store.createIndex('group_id',      'group_id',      { unique: false });
        store.createIndex('status',        'status',        { unique: false });
        store.createIndex('scraped_at',    'scraped_at',    { unique: false });
        store.createIndex('dedup_hash',    'dedup_hash',    { unique: false });
        // TODO: remove on next schema bump — not written or queried anywhere
        // (leftover from the pre-Gemini rule-based filter).
        store.createIndex('filter_passed', 'filter_passed', { unique: false });
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
export async function findByDedupHash(hash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const index = db
      .transaction(STORE, 'readonly')
      .objectStore(STORE)
      .index('dedup_hash');
    const req = index.get(hash);
    req.onsuccess = () => resolve(req.result ?? null);
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

// Returns all posts serialised to a JSON string. Used by the Export button.
export async function exportAllJSON() {
  const posts = await getAllPosts();
  return JSON.stringify(posts, null, 2);
}

// Return up to `limit` human-labeled posts, balanced between rental and
// not_rental so the few-shot prompt is not class-skewed. Newest first.
//
// Used by both the auto-classifier (called per-post from background.js) and
// the dashboard backfill button. Cheap enough — IndexedDB getAll is fast and
// we have at most a few hundred posts.
export async function getLabeledExamples(limit = 20) {
  const posts = await getAllPosts();
  posts.sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));

  const half       = Math.ceil(limit / 2);
  const rentals    = posts.filter(p => p.human_label === 'rental').slice(0, half);
  const notRentals = posts.filter(p => p.human_label === 'not_rental').slice(0, half);

  // Interleave so the prompt alternates labels — helps the model not anchor on
  // whichever class appears first.
  const out = [];
  const len = Math.max(rentals.length, notRentals.length);
  for (let i = 0; i < len && out.length < limit; i++) {
    if (rentals[i])    out.push(rentals[i]);
    if (notRentals[i] && out.length < limit) out.push(notRentals[i]);
  }
  return out;
}

// Return up to `limit` posts whose tags were manually corrected by the user
// (i.e. tags_human_override is set). Used as few-shot examples in extractPostTags()
// so Gemini learns from past corrections.
export async function getTagExamples(limit = 10) {
  const posts = await getAllPosts();
  return posts
    .filter(p => p.tags_human_override)
    .sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''))
    .slice(0, limit);
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
