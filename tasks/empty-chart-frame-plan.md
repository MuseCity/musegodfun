# Empty TradingView chart frame for coins without trades

Status: Implemented and cross-review accepted locally (2026-10-17); not released. Branch `claude/empty-chart-frame`, based on `1749822`. Release needs the owner's explicit approval.

## Owner request (2026-10-17, translated)

"For coins without trade records, show an empty TradingView frame so it looks professional, instead of showing almost nothing like now."

## Facts

- `src/components/TokenMarket.tsx` renders the lazy `MarketChart` → `PriceChart` (TradingView Lightweight Charts, 260 px, attribution logo on) only when candles exist; otherwise a 120 px `.market-empty` box with a status sentence (`emptyCandlesMessage` / `emptyText`), plus the hint "Enter an amount in the trade panel for an on-chain price preview."
- Coins such as CLAWGOD, MVADER and the Base Musegod pair currently have no candles, so their market card shows the small beige box.

## Goal

Every token page and the MUSEGOD page show a real chart frame at all times; when there are no candles the frame shows a faint symbol/unit watermark, with an honest short status directly below it.

## Constraints

1. Honesty: never draw bars, lines, prices or volumes that do not exist. The empty frame may use whitespace data points (time only, no values) to lay out the time axis for the selected interval; the price axis stays without values. Precise status distinctions remain in the status tooltip and chart description, as specified by the owner decision below; the on-chain quote hint stays.
2. Same frame as the populated chart: same component family, 260 px height, grid, axes, dark palette in both site themes and the TradingView attribution; no chart-frame layout jump between loading, empty and populated states.
3. No status sentence inside the frame. Empty/loading frames use a faint non-interactive symbol/unit watermark; one muted `role="status"` line below the panel follows the owner's three copy classes, readable at 390 px and in both themes.
4. No chart data requests change: no extra API calls, no history paging in the empty state, no change to market reads, provenance lines, live stream handling or trading.
5. Remove the now-dead `.market-empty` chart usage and CSS if nothing else uses it (Recent trades' empty state is out of scope unless it shares the component; keep its behavior).

## Owner decision: dark chart frames (2026-10-17, translated)

"A black background for the blank TradingView frame looks more professional." Asked whether to darken only the empty frame or all charts, the owner chose: **all price charts use a black background, populated and empty, in both the light and dark site themes.** The rest of the site keeps following the theme.

- Scope: the token-page and MUSEGOD price charts (`PriceChart` via `MarketChart`, line and candle modes, volume histogram) and their empty frame. The launch-curve chart and other cards are unchanged.
- The frame is a near-black panel (TradingView-style dark, for example `#0b0e11`–`#131722`) with rounded corners matching the card. It has subtle grid lines, light-muted axis text, readable up/down candle and volume colors, crosshair and price-line colors, and the OHLC legend inside the frame. The TradingView attribution and link stay legible; the later owner decision replaces the status overlay with a faint decorative watermark.
- Contrast: axis text, legend and credit meet WCAG AA against the panel background, in both site themes. The decorative watermark is intentionally faint.
- Constraint 2 is updated accordingly: empty and populated frames stay visually identical apart from data, now in the dark palette regardless of site theme.

## Owner decision: no status sentence inside the chart (2026-10-17, translated)

The owner asked whether the sentence "No indexed price records for this interval. The price provider is rate limited. Try again later." should be removed. Conductor recommendation, adopted:

- Inside the frame (empty and loading states, including the library-free fallback): no status sentence. Show a faint, non-interactive watermark with the chart's symbol and unit label instead (e.g. `CLAWGOD / USD`, or just the symbol when the unit is unknown). The watermark is not data. Populated charts get no watermark.
- The status moves to one short muted line directly under the chart, in buyer language and three classes:
  - loading: "Loading market data…";
  - an empty response without an error or reason: "No price history yet". Never "No trades", because an empty index does not prove there were no on-chain trades;
  - any failure, rate limit, backoff, not indexed or unusable response: "Chart data temporarily unavailable".
  The stale-snapshot warning above the chart is unchanged.
- The precise existing reason text (from `emptyCandlesMessage` / `emptyText`) stays available as the status line's `title` tooltip and in the chart's accessible description, so the earlier distinctions remain inspectable without cluttering the view. This is a deliberate owner-approved simplification of the visible copy under `tasks/market-data-plan.md`'s distinct-state rule; no state is hidden or misreported.
- The on-chain quote hint stays.
- C1b-1 is folded in: during loading, the accessible label and the visible status both say loading, and a populated chart's loading frame shows the same unit label it will show when loaded.

## Acceptance

1. Tests (SSR or component harness): empty, loading, error and stale-empty states render the chart frame with the correct short status below it, precise tooltip and accessible description, a symbol/unit watermark and no series values. Populated charts have no watermark; loading labels agree with their status and retain the known final unit. Populated data behavior and the no-empty-paging guard are unchanged.
2. `npm test`, `npm run build`, `git diff --check`, Han scan.
3. Local read-only preview: the original matrix covers CLAWGOD (no candles), MV2C (candles) and MUSEGOD at 1440 px and 390 px, light and dark. Run 3 re-checks CLAWGOD at 1440/390 px light and MV2C at 1440 px light, including the watermark, status below the chart and loading fallback. No console errors or added chart data requests.
4. Cross review: claude review → codex fix → claude accept, then codex review → claude fix → codex accept.
5. Local commits only; release needs the owner's explicit approval.

## Delivery record

### Run 1 - 2026-10-17 - Codex implementation

- Implemented in the first local `feat(chart): keep empty market chart frames visible` commit, including this previously untracked plan. Independent cross-review and release are pending.
- Loading, empty, failed and stale-empty chart states render the existing `PriceChart`, with a centered `role="status"` overlay, the original status distinctions and the existing on-chain quote hint. Real candle and volume data paths are preserved.
- Empty series receive 60 interval-aligned time-only whitespace points, no price or volume values. An explicit logical range lays out the time axis; theme-token grid decoration supplies the lines that Lightweight Charts omits when its price scale is empty. History paging is disabled without candles.
- Shared 260 px chart geometry and reserved OHLC header space prevent chart-frame shifts. Browser measurements match before and after loading for empty and populated charts at 1440 px and 390 px. `.market-empty` remains used by Recent trades only, so its existing CSS is retained.
- TDD: two new regressions failed before implementation (`red.log`); all 24 targeted tests and all 1779 full-suite tests pass. Production build, diff check and changed-file Han scan pass.
- Chrome DevTools: CLAWGOD (0 candles), MV2C (2 candles) and MUSEGOD (199 candles), each at 1440 px and 390 px in light and dark. All 12 final preview cases have no console errors, real chart canvases and attribution. Exact initial API endpoint/count multisets match production in all cases: 9 GETs for CLAWGOD/MV2C, 8 for MUSEGOD, including 3 market reads per page. Empty drag/zoom does not page; selecting 1m adds only its normal candle read.
- Evidence: `.superpowers/sdd/empty-chart/evidence/run1/summary.json`, screenshots and per-case JSON; report: `.superpowers/sdd/empty-chart/run1-report.md`; review handoff: `.superpowers/sdd/empty-chart/review-state.md`.
- Preview used plain Vite with `configFile: false`, `envDir: false`, GET-only production API forwarding, no direct provider calls and zero transmitted POSTs. Browser-only guards suppressed sockets and rejected MUSEGOD RPC POST attempts before networking; real stream behavior and unrelated burn totals were not verified. Two initial production-429 cases were retained and successfully rechecked after cooldown. The production baseline has an existing Cloudflare beacon CSP error; final local previews do not. Server process exited and port 4189 is free.
- Local only; no push, release, server, wallet, quote, stream or CSP source changes. Roll back by reverting the Run 1 implementation commit.

### Run 1b - 2026-10-17 - Codex dark chart palette

- Applied the owner's dark-frame decision above to empty and populated price charts, candles, lines and volume in both site themes. Chart-scoped CSS tokens use the same `#0b0e11` panel, light axis/overlay/legend text, grid, series, crosshair and price-line colors. The OHLC legend and attribution credit sit inside the rounded dark panel; the launch curve and other cards are unchanged.
- Removed the chart's site-theme subscription and color dependencies. Switching the site theme preserves the chart instance, options and visible range. Run 1's empty whitespace, status distinctions, attribution clearance, quote hint and no-empty-paging behavior remain.
- WCAG sRGB contrast against `#0b0e11`: axis and empty-overlay text `#a9b4c2` are **9.21:1**; attribution link `#7ab7ff` is **9.26:1**, in both site themes (AA threshold 4.5:1). Tests also check the stronger OHLC value text against the panel.
- TDD: two new tests fail on the Run 1 implementation (`evidence/run1b/red.log`). All 25 targeted tests and all 1781 full-suite tests pass. Production build, diff check and changed-file Han scan pass; the existing Vite large-chunk warning remains.
- Browser: 12/12 cases cover CLAWGOD (0 candles), MV2C (2 candles) and MUSEGOD (199 line points), 1440/390 px, light/dark. Real chart options have identical layout, grid and crosshair colors; same-type series options match. No console errors, horizontal overflow or history reads. Initial GET endpoint/count multisets match the archived Run 1 preview captures (9/9/8 GETs respectively); no new production-page baseline is claimed.
- Plot height remains 260 px. Shared dark panels measure 340 px on desktop and 376 px on mobile in empty and populated states. The panel padding and inset credit add 16/32 px respectively over Run 1; loading and populated states share these styles. Empty pointer/wheel/range interaction adds no request, price or volume value. Actual empty/populated theme toggles preserve the chart and range without extra reads.
- Evidence: `.superpowers/sdd/empty-chart/evidence/run1b/summary.json`, all 12 screenshots and per-case captures; report: `.superpowers/sdd/empty-chart/run1b-report.md`; handoff: `.superpowers/sdd/empty-chart/review-state.md`.
- Reused Run 1's plain Vite, no-env, GET-only production API harness and browser-only socket/POST guards. No direct data-provider call or transmitted POST. Real stream delivery and unrelated MUSEGOD burn totals remain unverified. Preview PID 71281 exited; independent process/TCP checks confirm port 4189 is free.
- Local implementation only, including the owner's previously uncommitted plan section; no push or release. Independent cross-review and acceptance remain pending. Roll back by reverting this Run 1b commit, retaining Run 1's empty-frame baseline.

### Run 2 - 2026-10-17 - Codex fixes for Claude review round 1

- Fixed C1-1 through C1-5; independent acceptance remains pending. `PriceChart` and `lightweight-charts` are behind dynamic imports for both empty and populated states. One library-free `PriceChartFrame` supplies the shared Suspense fallback and the mounted chart's markup, dark palette, status overlay, credit and 260 px plot.
- Empty charts reuse the snapshot's candles array, or one module constant before a snapshot exists. An unrelated activity-period change preserves whitespace data and the user's viewport; a new snapshot still advances the axis. Removed the redundant MarketChart empty-history checks and its unreachable empty-input test, retaining PriceChart's tested interaction/range guard; simplified the fitted assignment.
- Unknown units are omitted from the header, accessible name and credit; known quote units remain visible. Empty accessible names say there are no price records and do not invite price hovering. A full-width overlay backing hides the decorative grid behind and beside the status. The empty time scale fixes its left edge to align the first tick label fully inside the plot; populated scrolling remains unfixed. No invented price or volume values.
- TDD: the main-entry static-chunk graph and unknown-unit/accessibility regressions fail before the fix on `e57c690` (`evidence/run2/red.log`). The activity-period regression also fails with the old TokenMarket restored (`red-lifecycle.log`), then passes with stable snapshot references. All 28 targeted tests and 1783 full-suite tests pass. Final production build/typechecks, diff check and changed-tracked-file Han scan pass; the existing Vite large-chunk warning remains.
- Same-worktree production builds: entry 1298.09 kB / 387.59 kB gzip before, 1126.75 kB / 330.57 kB gzip after (57.02 kB less entry gzip). The library now lives in lazy PriceChart (171.34 kB / 55.66 kB gzip); lazy MarketChart is 2.60 kB / 1.29 kB gzip. The compiler regression traverses only static output edges from the real `src/main.tsx` entry and excludes both PriceChart and the chart library.
- Browser re-check: CLAWGOD (0 candles) and MV2C (2 candles), 1440 px, light. Final captures show 7 chart canvases, attribution, equal 340 px panels and 260 px plots, readable status/first tick, and no horizontal overflow or console errors. MV2C has font-preload warnings only. Each initial API GET endpoint/count multiset matches archived Run 1b (9 GETs, 3 market reads); no history reads. Empty pointer/wheel/range interaction plus an actual theme toggle preserves chart/range, adds no reads and creates no values.
- A preview-only 20-second delay of the PriceChart JS response exposes the library-free CLAWGOD fallback: 0 canvases, identical panel/plot rectangles, status and accessible label before and after the chunk loads. Initial two-edge locking collapsed the whitespace range; retained diagnostic captures explain why only the left edge is fixed. The full-width overlay removes the remaining inset grid stub.
- Evidence and report: `.superpowers/sdd/empty-chart/evidence/run2/summary.json`, its assertion script, red/green/full/build logs, browser JSON/PNG, network audit, source hashes and cleanup; `.superpowers/sdd/empty-chart/run2-report.md`. Reused the no-env plain-Vite GET-only preview harness, with browser socket/POST guards. No direct provider calls, transmitted POST, source permission changes or release. Real stream execution remains unverified. Preview PID 10371 exited; TCP/process checks confirm port 4189 is free.
- Local commit only. Roll back by reverting this Run 2 commit to the `e57c690` Run 1b baseline. Next handoff: Claude read-only review and acceptance of these fixes, followed by the existing reverse review sequence. No implementer self-acceptance.

### Run 3 - 2026-10-17 - Codex owner copy decision and C1b-1

- Implemented the owner's no-status-sentence decision, including its previously uncommitted plan section. Empty and loading frames have one faint, non-interactive symbol/unit watermark and no in-frame status sentence; populated charts have no watermark. The shared library-free PriceChartFrame supplies identical watermark markup/styles to both the lazy fallback and live chart. Removed the overlay markup, props and dead CSS.
- One muted status line below the panel uses exactly the three buyer-facing copy classes. All reason codes, client errors, unusable responses and stale-empty failures map to temporary unavailability; a successful reason-free empty response says "No price history yet". The original precise reason remains byte-for-byte in the line's title and the chart's aria-description. Existing populated stale warnings, quote hints, real data paths, stable candles references and paging guards are unchanged.
- C1b-1 is fixed: loading names agree with visible loading copy; the populated fallback retains its final USD or known quote unit. Lightweight Charts' text watermark API targets a library pane with computed bounds and no word wrapping; one shared CSS watermark instead gives the library-free and live frames identical placement, font and responsive wrapping without importing the library into the entry.
- TDD: three new regressions fail on the pre-change implementation (`evidence/run3/red.log`). All 32 targeted tests and all 1787 full-suite tests pass, including the static-import graph and stable-reference lifecycle checks. Production build/typechecks pass; entry 1127.13 kB / 330.67 kB gzip, lazy PriceChart 171.33 kB / 55.66 kB gzip. Main entry still excludes PriceChart and lightweight-charts. Diff check and changed-tracked-file Han scan are clean; the existing large-chunk warning remains.
- Browser: CLAWGOD at 1440/390 px light and MV2C at 1440 px light, using real production API GET responses. Three normal initial endpoint/count multisets equal archived Run 1b (9 GETs each, 3 market reads), with no history paging, blocked request, console error or horizontal overflow. CLAWGOD has no price/volume/OHLC values; MV2C retains two candles and four OHLC values. Plot height remains 260 px; panels remain 340 px desktop / 376 px mobile. PNGs were inspected.
- Two 20-second static-chunk delays expose empty and populated fallbacks. CLAWGOD's watermark geometry, style, status, tooltip and accessible label match before/after chart load; MV2C shows "MV2C / USD" with matching visible/accessible loading copy, then removes the watermark. The delayed captures include one existing FirstBuyLock 20-second poll beyond the initial 9 reads; chart reads stay at 3. Empty pointer/wheel/range interaction adds no read or data value.
- Evidence: `.superpowers/sdd/empty-chart/evidence/run3/summary.json`, assertion script, red/green/full/build logs, screenshots, captures, source hashes, network audit and cleanup. Report: `.superpowers/sdd/empty-chart/run3-report.md`; C1b-1 disposition: `.superpowers/sdd/empty-chart/review-state.md`.
- Reused the no-env plain-Vite GET-only production API harness and browser socket/POST guards. No direct provider call, transmitted POST or source permission change. Real stream delivery remains unverified. Preview PID 35248 exited after SIGTERM (143); process/TCP checks confirm port 4189 is free. Temporary browser tabs are closed.
- Local commit only; no push, deployment or independent acceptance. Roll back by reverting this Run 3 commit to the accepted `a42e664` Run 2 baseline. Next handoff: Claude read-only review of Run 3, then the existing cross-review sequence.

### Run 5 - 2026-10-17 - Claude fix for Codex review round 2 (X2-1)

- Fixed X2-1 (P3): at `max-width: 480px` the shared legend header reserves three rows (56 px) in the loading, empty and populated states, so a filled legend (for example `MICROCOIN / USD` with O/H/L/C `0.0000010000` at 390 px) no longer moves the plot 20 px when the chart chunk or the first candle arrives. Desktop keeps its 36 px reservation; values, markup and accessible text are unchanged and nothing is truncated or hidden.
- TDD: a wrap model built from the rendered legend text and the stylesheet's own rules fails on `988e3f3` (36 px against 56 px, first at 320 px) and passes after the one-rule change; a second test rejects clipping or hiding. A deliberately undersized 360 px breakpoint fails the model again. 1789 full-suite tests, build (entry 1127.13 kB / 330.67 kB gzip, chart library still only in the lazy chunk), diff check and Han scan are clean. No browser run: the check is the font-metric model, not a fresh layout capture. Local commit only; independent Codex acceptance is pending. Roll back by reverting this commit to the `988e3f3` baseline.

### Cross-review closure (2026-10-17)

- Codex implemented the empty frame in `2f28131` and the dark palette (owner decision) in `e57c690`.
- Claude review found C1-1, a P1: the chart library had moved into the main bundle, adding 57.7 kB gzip on every route. It also found C1-2…C1-5 (P3). Codex fixed them in `a42e664`, and claude accepted them. The main entry is back to about 1,126 kB, and the chart library sits in a lazy chunk with a library-free fallback frame.
- The owner's copy decision (no status sentence in the frame; a symbol watermark; one short status line below) and C1b-1 landed in `988e3f3`.
- Codex reverse review: ACCEPT, with X2-1 (P3, a narrow-screen legend height shift). Claude fixed it in `7d462bf` with a 56 px reserved legend at 480 px and below, and codex accepted it.
- Conductor rerun on `7d462bf`: `npm test` **1789/1789**, `npm run build`, `git diff --check` and the Han scan pass.
- Not verified: a browser check of the final narrow-screen legend. The geometry is covered by a CSS and font-metric test. Online acceptance after release covers it.
