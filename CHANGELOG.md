# Changelog

All notable changes to this project are documented here.

Versions correspond to the `version` field in [`manifest.json`](manifest.json).
Entries before 4.0.0 are reconstructed from the project history; see `git log`
for the full detail.

---

## 4.0.0 — 2026-08-01

The dashboard's visual overhaul, plus the ability to publish retrained model
weights back into the repo. No changes to the scraping, classification, or
notification pipelines — a post captured by 3.0.0 is captured identically here.

### Dashboard redesign

Ported from the "TLV Rentals Dashboard Redesign" Claude Design project.

- **New visual system.** `dashboard.css` is now built on an oklch design-token
  palette (`:root` custom properties) applied across every surface — cards,
  sidebar, both modals, the inline tag editor, and the shadow-ML review row —
  replacing the previous Facebook-blue styling.
- **Pipeline ▾ menu.** The six maintenance actions (Regex Extract, Re-test
  Regex + ML, 🧠 Retrain ML, 🔬 Shadow Backfill, Export Misses, 💾 Export
  Weights) are grouped under one header dropdown instead of competing for space
  in the top bar. The Retrain and Export Misses badge counts are unchanged.
- **Collapsible sidebar filters.** Each filter group is now a `<details>`
  section. Roommates and Broker fee became 4-way segmented controls
  (Any / Yes / No / Unknown) in place of checkbox triples.
- **New filters.** Interested-only, alongside the existing label, label-source,
  price, rooms, entry-date, duplicates, regex-misses and ML-review-queue filters.
- **Card overflow menu.** Each card now has a **⋯** menu holding Mark as
  Rental / Not rental, ✏ Edit tags, Mark duplicate, and 🗑 Delete — leaving
  **Interested** and **Open ↗** as the two direct actions. Post status (new /
  interested / seen / hidden) reads from a coloured dot on the thumbnail.
- **Delete All** moved from the sidebar into the header. It still requires
  typed confirmation and still shows the current post count.

Filter predicates, the tag editor, shadow-ML verdict recording, and the
retrain / re-test / export flows are behaviourally unchanged, and every
pre-existing element id was preserved.

### Model weight publishing

- **💾 Export Weights** (`lib/ml_weights_export.js`) writes the currently
  *promoted* weights back out as the bundled `lib/*_weights.js` modules, in the
  same format the offline trainers emit — so a retrain that lives only in
  `chrome.storage.local` can be committed to git. Writes straight into a folder
  you pick via the File System Access API, else falls back to downloads. Heads
  with nothing promoted are skipped rather than emitted as stubs, and
  `trained_correction_ids` is stripped so a fresh clone doesn't believe those
  corrections were already folded in.
- **Devtools → Weights** gained a per-head provenance table reading "running the
  bundled file", "retrained, and the repo copy matches", or "retrained and ahead
  of the repo" — the answer to *which weights are actually scoring my posts*,
  which only the in-extension page can determine.
- All four heads' retrained weights are now bundled in the repo, so a fresh
  clone starts from the trained model rather than the original baseline.

### Documentation

- **README**: the Roadmap section was removed; its still-open items were folded
  into an expanded **Known limitations** section. The Dashboard usage section
  was rewritten for the new UI, and the deduplication description corrected
  from "two-layer" to four-layer (`post_id` / `dedup_hash` / `prefix_key` /
  `suffix_key` — the suffix layer shipped in 2.5.0 but was never documented).
- **background.js**: the file header was rewritten — it still described a
  regex-only pipeline with three responsibilities. It now documents all five
  message types, the `SAVE_POST` pipeline ordering, and the invariants to
  preserve when editing.

---

## 3.0.0 — 2026-07-30

- **Shadow ML.** Two new heads — a price *candidate ranker* and a roommates
  classifier — that predict but never tag. Predictions live in `post.ml_shadow`,
  which the notification filter structurally cannot read, so a wrong prediction
  can never suppress a listing. You judge only the posts where a head disagrees
  with the regex; those verdicts become the benchmark deciding whether a head
  ever graduates to tagging.
- **In-extension devtools** (`devtools/devtools.html`) — pipeline stats, a
  reasoning playground showing the full candidate ranking behind any price
  prediction, shadow-ML progress, and live model weights. Reads IndexedDB
  directly; the Node shell became optional and the `localhost` host permission
  was dropped.
- **Luxury rents no longer discarded** — an explicit rent label is trusted past
  the sanity cap that was silently dropping genuine high-end listings.

## 2.5.0 — 2026-07-25

- **Suffix-key dedup layer** — catches reposts that rewrite the headline but
  keep their closing lines, the dominant pattern in the 2026-07-25 dupe report.
  Guarded by a whole-text similarity gate so broker-template posts describing
  different apartments aren't collapsed.
- 33 regex fixes from the same report.
- **Benchmark-erosion fixes**: a corrected gold post stays in the benchmark, and
  the promotion floor can rise but never ratchet below the bundled baseline.

## 2.4.0 — 2026-07-20

- **Commerce enrichment** — pure Marketplace cards carry only
  "₪price · location · title" in the feed; the description exists only on the
  client-rendered listing page. Those listings are now opened in a background
  tab, read, and re-saved through the full pipeline. Rate-limited with a
  jittered delay, an hourly cap, and a 6-hour cooldown if Facebook returns its
  temporary-block interstitial.

## 2.3.0 — 2026-07-19

- **ML hybrid classification** — a plain-JS logistic-regression model rides on
  top of the regex: the regex label stands unless the model is ≥90% confident
  it's wrong, and the model decides alone when the regex can't.
- **ML broker fill** — a weakly-supervised head trained with broker keywords
  masked, so it learns agency register rather than the keyword.
- **In-extension retraining** — 🧠 Retrain ML and Telegram `/retrain`. New
  weights are promoted only if they clear a fixed gold benchmark.

## 2.2.0 — 2026-07-15

- **🚩 Miss correction flow in Telegram** — every alert carries an inline button
  for correcting the classification or any tag straight from the chat.

## 2.0.0 — 2026-07-13

- **Telegram notifications** — opt-in push alerts through a user-owned bot when
  a newly captured post matches saved preferences. Recall-biased matching (a
  post whose price couldn't be extracted is never excluded by a price rule),
  no re-notification on re-scrapes or duplicates, failed sends retried.
- **Phone-side bot control** — `/start` setup wizard, `/status`, `/reset`,
  `/on`, `/off`, `/help`. First chat to `/start` binds; all others are dropped.

## 1.4.0 — 2026-07-12

- **Prefix-key dedup layer** — catches cross-posted listings edited before
  reposting. DB schema bumped to v2 with an automatic migration.

## 1.2.0 — 2026-05-30

- **Post-detection overhaul** — detection rewritten to `role="feed"` child
  units with body-anchor and commerce-link fallbacks. Fixed neighbour-ID theft
  (a permalink-less post stealing an adjacent card's ID and overwriting it),
  captured pure Marketplace cards, and hardened anonymous-post hashing.

## 1.1.5 — 2026-05-28

- **Canonical Open links** across all Facebook URL patterns, including
  photo-album (`pcb.`/`gm.`) links and the guard against reused branding images
  shadowing the real post ID.

## 1.0.0

- Initial release: feed scraping, regex classification, IndexedDB storage, and
  the filterable dashboard.
