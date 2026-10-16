# Empty TradingView chart frame for coins without trades

Status: In progress (2026-10-17). Branch `claude/empty-chart-frame`, based on `1749822` (master `01637b7` plus its unpushed release record).

## Owner request (2026-10-17, translated)

"For coins without trade records, show an empty TradingView frame so it looks professional, instead of showing almost nothing like now."

## Facts

- `src/components/TokenMarket.tsx` renders the lazy `MarketChart` → `PriceChart` (TradingView Lightweight Charts, 260 px, attribution logo on) only when candles exist; otherwise a 120 px `.market-empty` box with a status sentence (`emptyCandlesMessage` / `emptyText`), plus the hint "Enter an amount in the trade panel for an on-chain price preview."
- Coins such as CLAWGOD, MVADER and the Base Musegod pair currently have no candles, so their market card shows the small beige box.

## Goal

Every token page and the MUSEGOD page show a real chart frame at all times; when there are no candles the frame is empty but looks like a professional chart, and the honest status is shown inside it.

## Constraints

1. Honesty: never draw bars, lines, prices or volumes that do not exist. The empty frame may use whitespace data points (time only, no values) to lay out the time axis for the selected interval; the price axis stays without values. The existing status texts keep their distinctions (loading, no indexed records, provider rate limit/backoff, not indexed, request failure, stale snapshot) and the on-chain quote hint stays.
2. Same frame as the populated chart: same component family, 260 px height, grid, axes, theme (light/dark) and the TradingView attribution; no layout jump between loading, empty and populated states.
3. The status text is a centered overlay inside the frame (muted, small, `role="status"`), readable at 390 px and in both themes; it never covers the attribution.
4. No chart data requests change: no extra API calls, no history paging in the empty state, no change to market reads, provenance lines, live stream handling or trading.
5. Remove the now-dead `.market-empty` chart usage and CSS if nothing else uses it (Recent trades' empty state is out of scope unless it shares the component; keep its behavior).

## Owner decision: dark chart frames (2026-10-17, translated)

"A black background for the blank TradingView frame looks more professional." Asked whether to darken only the empty frame or all charts, the owner chose: **all price charts use a black background, populated and empty, in both the light and dark site themes.** The rest of the site keeps following the theme.

- Scope: the token-page and MUSEGOD price charts (`PriceChart` via `MarketChart`, line and candle modes, volume histogram) and their empty frame. The launch-curve chart and other cards are unchanged.
- The frame is a near-black panel (TradingView-style dark, for example `#0b0e11`–`#131722`) with rounded corners matching the card. It has subtle grid lines, light-muted axis text, readable up/down candle and volume colors, crosshair and price-line colors, and the OHLC legend inside the frame. The empty-state overlay text is light-muted, and the TradingView attribution and link stay legible.
- Contrast: axis text and overlay text meet WCAG AA against the panel background, in both site themes.
- Constraint 2 is updated accordingly: empty and populated frames stay visually identical apart from data, now in the dark palette regardless of site theme.

## Acceptance

1. Tests (SSR or component harness): empty, loading, error and stale-empty states render the chart frame with the correct overlay text and no series values; populated state unchanged; no paging trigger in the empty state.
2. `npm test`, `npm run build`, `git diff --check`, Han scan.
3. Local read-only preview: CLAWGOD (no candles), MV2C (candles) and MUSEGOD at 1440 px and 390 px, light and dark; screenshots show the empty frame with axes, grid, attribution and overlay; no console errors; no extra network requests compared with the current page.
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
