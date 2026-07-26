# TLV Rentals — devtools backend

Local-only visualization for the extension's regex/ML pipeline. Not part of
the shipped extension — this whole folder is gitignored and never pushed.

Imports `lib/regex_extractor.js`, `lib/ml_classifier.js`, `lib/ml_features.js`,
and `lib/ml_weights.js` directly from the repo (same trick `ml/train.mjs`
uses), so what it shows is the real decision logic, not a copy.

## Run

```
node devtools/server.mjs
```

Then open http://localhost:8787.

## Getting data in

Data comes from the dashboard's **🛰 Sync to Devtools** button (top bar,
next to Export JSON) — it POSTs the full current post list to
`http://localhost:8787/api/sync`. The server is the only recipient; nothing
is uploaded anywhere else. The last sync is cached to `devtools/data/latest.json`
so restarting the server doesn't lose it.

Requires the server to be running *before* you click the button, and the
extension reloaded at least once after `manifest.json` picked up the
`http://localhost:8787/*` host permission.

## Tabs

- **Stats** — label/classifier breakdown, dedup rate, tag completeness,
  regex-miss backlog, enrichment/notify success rates. Computed from the
  last synced post list.
- **Reasoning** — paste any post text, see the real regex extraction, the
  ML hybrid decision (probability, override threshold, whether it overrode
  the regex), broker-fill decision, and which tokens pushed the ML score
  toward/away from "rental". No sync needed — this is stateless per request.
- **Weights** — the bundled model's metadata (feature version, gold rows, CV
  accuracy, trained date) and its top rental-indicative / not-rental-indicative
  tokens for both the label and broker heads. If the synced extension is
  running retrained weights (`chrome.storage.local`, not visible to this
  Node process), a warning banner says so — the token lists shown are always
  the bundled `lib/ml_weights.js`.
