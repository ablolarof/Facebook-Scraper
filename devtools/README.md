# TLV Rentals — devtools

Visualization for the extension's regex/ML pipeline: pipeline stats, a reasoning
playground, shadow-ML progress, and model weights.

## Run it (no Node)

Open the dashboard and click **🔬 Devtools**, or go straight to
`chrome-extension://[id]/devtools/devtools.html`.

That page runs inside the extension, which is what makes it the better shell:

- **No sync step.** It reads IndexedDB directly, so it always shows live data —
  there is no cached copy to go stale.
- **It can see the weights actually in force.** Retrained weights live in
  `chrome.storage.local`; a Node process cannot read those, so the old backend
  had to display a warning admitting the token lists might not match the model
  doing the scoring. This page reports the live source for every head.
- **Nothing personal is written to disk**, and no `localhost` host permission is
  needed — it was removed from `manifest.json` along with the sync button.

Hit **↺ Refresh** after running a scrape, a retrain, or a shadow backfill.

## Optional: the Node shell

`devtools/server.mjs` still exists for one case the extension page cannot cover —
inspecting an **exported JSON file** without loading the extension:

```
node devtools/server.mjs ~/Downloads/tlv-rentals-export.json
node devtools/server.mjs                    # or: whatever was last synced
TLV_DEVTOOLS_PORT=8788 node devtools/server.mjs
```

Then open http://localhost:8787. It does not hot-reload — restart after editing
anything under `lib/` or `devtools/`.

## No drift between the two

Every statistic is computed in **`devtools/devtools_core.js`**, which both shells
import — the extension page directly, the Node server over HTTP. Neither has its
own copy of `computeStats`, `computeShadowStats`, `buildWeightsResponse`, or
`classify`, so the two cannot disagree about what a number means.

That core in turn imports the extension's real `lib/*.js` modules
(`regex_extractor`, `ml_classifier`, `ml_features`, `ml_weights`, `ml_shadow`),
so the "reasoning" shown is the actual decision code, not a reimplementation.
Only `devtools/data/` (synced post content) is gitignored; the code is tracked.

## Tabs

- **Stats** — label/classifier breakdown, dedup rate, tag completeness,
  regex-miss backlog, enrichment/notify success rates. Computed from the
  last synced post list.
- **Reasoning** — paste any post text, see the real regex extraction, the
  ML hybrid decision (probability, override threshold, whether it overrode
  the regex), broker-fill decision, and which tokens pushed the ML score
  toward/away from "rental". No sync needed — this is stateless per request.
- **🔬 Shadow ML** — progress of the shadow-mode heads (price, roommates).
  These predict but never tag: their output lives in `post.ml_shadow`, never
  `post.tags`, so a wrong prediction cannot reach the Telegram filter — it only
  costs a review. Shown per field: the governing metric and how far it is from
  its bar, verdicts recorded vs. the `MIN_VERDICTS` minimum, how many posts
  await review, coverage on posts the regex could not answer, and a
  who-was-right breakdown over judged posts.

  Two things worth reading carefully:

  - **The metrics differ by field, deliberately.** Price is scored on
    *precision* (of the values it emits, how many are right), because a null
    price passes `matchesPreferences` untouched while a wrong one silently
    hides a listing. Roommates is scored on *accuracy against the regex on the
    same judged posts* — `extractRoommates` is already strong, so a flat 96%
    bar would pass a model that is measurably worse than what ships today.
  - **The isolation line must always read zero.** It runs `shadowLeakCheck()`
    over every scored post, flagging any case where a shadow value reached
    `post.tags` without the regex producing it or a human setting it. Non-zero
    means shadow values can influence notifications, which is the one thing
    this design must never allow.

  This deliberately lives here and not on the dashboard: a half-trained model's
  score is a lab number, not something to read while browsing apartments.

- **Weights** — the bundled model's metadata (feature version, gold rows, CV
  accuracy, trained date) and its top rental-indicative / not-rental-indicative
  tokens for both the label and broker heads. If the synced extension is
  running retrained weights (`chrome.storage.local`, not visible to this
  Node process), a warning banner says so — the token lists shown are always
  the bundled `lib/ml_weights.js`.
