# VIEWER.md — the offline `scope view` HTML viewer

`scope view` renders ONE self-contained HTML file embedding the current graph plus the
latest check summary. It is a **passive read model**: it never rescans and never writes to
the index — run `scope scan` / `scope check` first, then regenerate.

## Usage

```
node "<scope>/scripts/scope.mjs" view [--root <dir>] [--out <file>]
```

- Default output: `<root>/.scope/symbols/view-data.html`.
- `--out <file>` writes anywhere you like (a directory path is a usage error, exit 2).
- Stdout line reports exact counts:
  `view .scope/symbols/view-data.html (22 of 22 symbols, 37 of 37 relations, 48356 bytes)`.
- If data was cut to fit the size bound, stderr adds a warning pointing at the in-page
  truncation banner.
- Requires a complete index (exit 2 with "no complete symbol index …; run `scope scan`
  first" otherwise). A stale-schema store is refused the same way as other queries.

## Data bounding algorithm (why numbers may show "N of M")

Hard cap: **1 500 000 decimal bytes total file size**, template + embedded JSON island
included (`VIEWER_MAX_TOTAL_BYTES`, safety margin 4 KiB). When a repo's graph does not
fit, selection is deterministic — same input bytes ⇒ same viewer bytes:

1. Rank nodes by graph degree desc → span size desc → id asc.
2. Phase A greedily spends up to ~62 % of the byte budget on top-ranked nodes (so edges
   keep headroom and the picture never degrades to disconnected dots).
3. Phase B adds edges whose both endpoints are selected, hub-first; then `route`/`tests`
   edges pull their missing counterpart node in while budget lasts.
4. Phase C backfills any unused budget with more ranked nodes.
5. The whole payload is measured; overshoot shrinks the budget and selection repeats
   (converges in 1–2 passes); the final file is asserted under the cap before writing.

Per-section lens caps keep the check summary bounded too: drift 250 / dangling 250 /
orphans 150 / ambiguous 100 / tests 120 entries (each drift entry shows ≤ 12 dependents),
rebindings ≤ 50, per-node note-count map ≤ 64 KiB. Every cut is counted and displayed —
the banner and stdout always give exact shown/total numbers, never silence.

## Tabs

- **Graph** (default): symbols sized/ranked by connectivity, edges colored by confidence;
  click any symbol to inspect it (kind, span, confidence, signature) and pick
  "Flow from here". Search box (`/`) filters by name/path, or by kind with a `kind:`
  prefix. **`kind:module` gives you the file graph** — every file as a node, the imports
  between them as edges, everything else dimmed. That is the same picture the file graph draws,
  minus its git and issue overlays. Any legend kind works: `kind:route`, `kind:class`.
- **Flow**: entry→sink call flows for one selected entrypoint (route handlers and `main`
  functions are auto-detected; otherwise pick from the dropdown).
- **Change Lens**: overlays the latest `scope check` state — issue chip in the tab,
  drift entries with stale dependents, dangling references, orphan/ambiguous notes,
  rebindings, detected test runners and affected tests. Without a prior `scope check` the
  lens shows an explicit "run scope check" hint instead of fake data.

Keyboard: `1/2/3` switch tabs, `/` focuses search. Drag pans, wheel zooms.

## Offline guarantees

The file makes zero external requests — no CDNs, no fetched fonts, no images, no dynamic
imports, not even SVG `xmlns` URL strings that some offline-policy scanners flag. This is
test-enforced rather than runtime-policed: the exported `findNetworkRefs` battery
(`lib/view.mjs`) runs over generated output in the test suite, so a regression fails CI,
while the generator itself does not scan the HTML on every run. The viewer therefore
opens from `file://` on an air-gapped machine. Rendering is hand-rolled inline
SVG + vanilla JS; no timestamps are baked into the HTML, so regeneration is
byte-deterministic for the same store state.

## Regeneration etiquette

- Regenerate after every scan/check whose answer you might show a human:
  `node "<scope>/scripts/scope.mjs" view --root <dir>`.
- Treat the file as disposable derived art — do not hand-edit, do not commit unless your
  team wants point-in-time snapshots (it lives in gitignored `.scope/symbols/` by default).
- The embedded payload carries its own schema version (`v1`) and the tool id, so old
  snapshots stay interpretable.
