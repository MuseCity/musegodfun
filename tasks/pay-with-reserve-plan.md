# Stable trade panel: no late "Pay with" row on token pages

Status: Runs 1 and 1b implemented locally; strict MUSEGOD mobile acceptance needs a trade-panel scope decision and cross-review (2026-10-17). Branch `claude/pay-with-reserve`, based on master `7bdf276`.

## Owner request (2026-10-17, translated)

Do the follow-up "Reserve trade panel Pay-with row before config loads" in this session, with the usual process.

## Facts

- Live QA of release `7bdf276` (build-38996555896-1) measured an intermittent 32 px shift on CLAWGOD at 390 px dark theme: the chart frame top moved 1388 → 1420 px while its height stayed 260 px. In the single-column layout the trade panel sits above the market card.
- `src/App.tsx` (~3048): `ethPayable = side === "buy" && !!pairAsset && ethBuyAvailable(config)`. `ethBuyAvailable` (`src/lib/eth-buy.ts:21`) returns false while `config` is null, so the `<div className="pay-with">` row (~3416) is missing on first paint and appears when the config request resolves.
- Whether ETH payment is offered depends on the deployment chain (Robinhood 4663, including fork mode deployed for 4663), which the token record already carries when the trade panel first renders.

## Goal

The trade panel's layout is final at its first render: no row appears or disappears because the runtime config arrives later, on any viewport.

## Constraints

1. Payment behavior is unchanged once config is known: same availability rule, same defaults (`defaultPayWith`, frozen choice, WETH-pair ETH default), same routes, quotes, approvals and execution. No ETH option is ever offered where it is unavailable once config is known.
2. Decide the row's presence from data available at first render (the token's deployment chain/mode and the pair asset), equivalent to `ethBuyAvailable` for every supported config. If config later contradicts it (an anomalous mismatch), hide the row; document that this is the only remaining shift case.
3. While config is still loading, the row is visible but its buttons are disabled and marked busy, and nothing config-dependent (quotes, Max fee reads, execution) runs earlier than today.
4. Audit every other element above the market card in the narrow layout whose presence depends on asynchronous data (config, balances, wallet, stock status) and stabilize any that can shift the chart; list what you checked. Do not change copy beyond what stabilization requires.
5. No server, contract, wallet, quote-logic or dependency changes. English only.

## Owner decision: chart directly under the price row (2026-10-17, translated)

Run 1 fixed the config-driven shifts. It also measured a separate shift that predates this work: on pools with market data (MV2C), the price heading, the four metric tiles and the activity row arrive with the summary response above the chart. That moves the chart about 291 px at 390 px and 173 px at 1440 px. Whether a pool has data is unknown until the response arrives. A skeleton would only move the jump onto empty pools.

The owner chose to move the metrics below the chart, so the chart position never depends on market data. Applies to `TokenMarket` for both token pages and the MUSEGOD page:

- Market card order:
  1. Price row with a reserved, constant height. It shows the price and change, or the loading/empty/failure status line, without changing height.
  2. Chart toolbar (unchanged).
  3. Chart frame (260 px) and its status line.
  4. The on-chain quote hint.
  5. Metric tiles (or the compact empty-summary state), the activity row and any summary or chart stale warnings.
  6. The provenance line.
- Nothing that depends on market responses may sit above the chart frame. The stale warnings move below the chart, next to the status line, and stay prominent.
- Unchanged: the declutter honesty rules (no `—` tile grid for empty summaries; activity hidden when there are no values; attribution; no cross-section borrowing), live updates, paging and the dark chart palette.
- The acceptance is updated. On every tested page and viewport, the chart frame top is identical from the first rendered token frame through summary, candles, trades and config arrival.

## Acceptance

1. TDD: failing-first tests showing the row renders (disabled) before config on a Robinhood pair page, stays absent on sell and on chains or pairs without ETH payment, becomes interactive once config loads, and that payment state and defaults after config are identical to before.
2. Failing-first rendered-order and fixed-height tests for both `TokenMarket` kinds across loading, empty, failure, partial, populated and stale states; `npm test`, `npm run build`, `git diff --check`, Han scan.
3. Local read-only preview in two modes: chain config delayed by about 3 s; chain config plus launch/MUSEGOD market summaries delayed by about 3 s. Check CLAWGOD, MV2C and MUSEGOD at 390 px light/dark and 1440 px light against `d9574ea`. The chart frame top must remain identical from the first token/market frame through config, summary, candles and trades arrival; the frame stays 260 px and the price row stays constant. Preserve unmodified GET responses and record any other page-level movement separately.
4. Cross review: claude review → codex fix → claude accept, then codex review → claude fix → codex accept.
5. Local commits only. The release needs the owner's explicit approval, and the post-release check must probe the live layout at 390 px.

## Delivery record

### Run 1 - 2026-10-17

- First local implementation commit includes this previously untracked plan, `src/App.tsx`, `src/styles.css`, and `tests/pay-with-reserve.test.ts`. The exact commit is recorded in `.superpowers/sdd/pay-with/run1-report.md` after commit creation.
- Token deployment metadata reserves the buy-side payment row; the original config-dependent `ethPayable`, defaults, choice freezing, routes, reads, quotes and execution remain unchanged. Buttons are disabled and the row is busy until config arrives. A contradictory config hides the row; this is the remaining config-driven payment-row removal case.
- The quote-verification badge reserves its footprint before stock status. Stock pairs also reserve a 16 px share-equivalent line before multiplier/balance reads, retaining the slot when the default switches to ETH. Hidden reservations are excluded from accessibility output.
- TDD: payment-row/badge tests first failed 4/10; share-slot coverage then failed 1/14 and Robinhood multiplier coverage failed 1/15 before their fixes. Final focused suite: 57/57. Full `npm test`: 1804/1804; `npm run build` (including both typechecks), `git diff --check`, and the changed-file Han scan passed. The existing large-chunk build warning remains.
- Browser: chrome-devtools MCP, plain Vite with `envDir: false`, production GET gateway only, 3000 ms delay exclusively on chain config responses. CLAWGOD and MV2C were measured at 390 px light/dark and 1440 px light against `7bdf276`. All six base panels gained 56 px on config; all six fixed panels retained their initial height, with a disabled/busy row present before config and interactive after it. Config-only chart displacement is zero in all six fixed cases.
- Strict acceptance 3 is **not fully met**: MV2C's independent market-summary hydration moves the chart 291 px at 390 px and 173 px at 1440 px, reproduced on the unfixed base. That presentation belongs to `TokenMarket`, outside the run's allowed trade-panel rendering scope. No market, stream, quote, wallet or server behavior was changed to mask it. A scope decision is required before implementing that additional stabilization; runtime error/read-only/fork/wallet-recovery presentation also remains outside the guest mainnet browser evidence.
- The constraint-4 audit, before/after measurements, screenshots, request audit and test logs are in `.superpowers/sdd/pay-with/run1-report.md` and `evidence/run1/measurements-summary.json`. Final viewport screenshots avoid the temporary scrollbar reflow observed during exploratory full-page captures; raw exploratory evidence is retained separately as `probe-*`.
- Both preview processes stopped; ports 4190/4191 were released. Gateway audits recorded GET only, zero POSTs. No `.env`, push, deployment, wallet connection, signing or funds were used.
- Cross-review remains pending: claude review -> codex fix -> claude acceptance, then the reverse review. `review-state.md` records this handoff. Release and the owner's post-release 390 px check have not run.

### Run 1b - 2026-10-17

- Implemented the owner decision on top of `d9574ea`, including that previously uncommitted decision in this commit. `TokenMarket` now orders the reserved price row, unchanged toolbar, chart/status, quote pointer, metrics or compact empty-summary state, activity/warnings, and provenance for both launch and MUSEGOD pages.
- The price row reserves 90 px (16 px eyebrow + 4 px gap + a wrapped 40 px price / 6 px gap / 24 px change chip), with no flex shrink. Detailed summary failures/stale-empty copy, latest-swap details and the live-receiving indicator are below the chart. Empty tile/activity suppression, independent section attribution, live component props/gates, candle paging and the dark chart palette remain intact.
- TDD: the three initial tests failed on the base before implementation; a separate live-receiving placement test also failed on the base before passing against the fix. The focused market/chart suite passed 50/50. Only the existing empty-copy order assertion and activity-versus-toolbar order assertion changed. Full tests passed 1808/1808; build with both typechecks, diff checks and the Han scan passed. The existing large-chunk warning remains.
- Browser evidence: 36 base/fixed cases and 72 viewport screenshots across both delay modes, three tokens and three viewport/theme combinations. All 18 fixed cases retain a 90 px price row, a 260 px frame and a constant chart offset inside the market card (292 px at 390, 228 px at 1440). All initial config/summary/candles/trades responses completed. The 12 launch-token cases and both MUSEGOD desktop cases retain absolute chart coordinates throughout.
- Strict whole-page acceptance is **not met** in four MUSEGOD mobile cases: the existing separate `MusegodTradePanel` removes/reintroduces its loading-verification notice as `/api/musegod` and config resolve. Its height alternates 642/588 px, moving the entire market card and plot by 54 px despite a constant internal offset. The renderer is outside this run's allowed scope; no CSS workaround or runtime-permission change was applied. The owner must authorize narrowly stabilizing that notice reservation, then the affected cases need revalidation.
- Full details, response-boundary geometry, screenshots, gateway audits and cleanup evidence are in `.superpowers/sdd/pay-with/run1b-report.md` and `evidence/run1b/`. All production forwarding was GET only. MUSEGOD's existing RPC POST attempts were rejected locally with 403, including its burn read, so this preview does not validate the burned-total metric. WebSocket upgrades still receive 426. One initial MUSEGOD candle GET had a gateway transport failure (502); 143 other initial responses were HTTP 200. A separate slower run crossed the automatic-refresh interval. Completion, failure and the observed geometry are recorded separately.
- Preview processes stopped and ports 4190/4191 are free, independently verified. No environment files, direct provider calls, wallet connection, signing, funds, push or deployment. Status: **NEEDS_DECISION** for the separate MUSEGOD trade-panel renderer; independent cross-review and release acceptance remain pending.
