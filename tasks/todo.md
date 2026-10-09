# musegod.fun redesign — implementation spec & plan

Source: `musegod.fun redesign.html` (8 boards: Explore, Token, Launch, Review, Rewards, Buyback, MUSEGOD, Dialogs).

## Goal
Ship the redesign's visual system and page layouts across the whole frontend, keeping every existing
business rule, transaction flow, data source and test intact.

## Scope / constraints
- Frontend only (`src/`, `public/fonts`, `index.html`). No server, Worker, API, contract or database change.
- Never invent data. Design elements without a real data source are omitted or replaced by the closest
  real value (labelled honestly):
  - Buyback 24h/7d/30d range tabs, daily WETH chart, "Where fees went · 7 days", "Top contributing pools",
    rolling-limit bar, price-check spread → no time-series/aggregate API. Replaced by real engine totals,
    latest confirmed burns, pipeline balances and the fee policy split.
  - Rewards "Claimable now ≈ $" / "Claimed all-time" → needs per-token reads + prices. Replaced by
    real counts (launches, locked first buys) and per-token "Check fees".
  - Explore 7d sparkline → no 7-day series. Column omitted.
  - Trade panel "Price impact" → quote has no impact field. Omitted.
  - Global "chain live · block" status bar → no global source. Omitted.
- Existing tests constrain markup (TokenCard, Explore count/featured, FeeBreakdown, TokenMarket labels).
- Fonts self-hosted (CSP `font-src 'self'`; the old Google Fonts @import was blocked by `style-src`).
- Initial review scope prohibited commit/push. On 2026-10-09 the owner authorized deployment and push, then confirmed the existing master-push automatic publication sequence.

## Acceptance
1. Tokens (light + dark) and typography (Young Serif / Schibsted Grotesk / IBM Plex Mono) match the design.
2. Shell: sidebar nav + network segmented control, header breadcrumb/actions, theme toggle, dark footer;
   usable at 390px (no horizontal page scroll).
3. Explore: hero + stats, toolbar, quick filters, list (default) / grid toggle, how-it-works strip.
4. Token + MUSEGOD: header chips, share dialog, market card, trades/holders, creator card, about + fee bar,
   sticky trade panel with segmented slippage.
5. Launch: identity / quote asset / first buy / advanced options cards, sticky preview + launch summary,
   sticky footer; review modal with fact tiles, numbered step cards, progress.
6. Rewards: hero, stats, per-launch fee cards, locked first-buy finder.
7. Buyback: dark burn hero (dead-address balance read on-chain), engine totals, latest burns, waiting-to-burn
   pipeline with existing actions, preview card, contracts / feeds / collected-fees disclosures.
8. Dialogs: wallet connect/account, quick verification, how it works, transaction history (header-triggered),
   notices (info/success/warning/error), empty states, 404, error boundary, share.
9. `npm test`, `npm run build` (typecheck both targets) pass; browser check desktop + mobile, light + dark.

## Plan
- [x] Fonts + design tokens + base primitives (styles.css rewrite), theme provider/toggle
- [x] App shell (sidebar, header, footer, notices, help modal, 404) + TransactionHistory dialog
- [x] Explore (hero, toolbar, filters, list/grid) + TokenCard restyle
- [x] Token page + TokenMarket + PriceChart (line/candles, themed) + FeeCard + share dialog
- [x] MUSEGOD page
- [x] Launch page + FirstBuy + review modal
- [x] Rewards + FirstBuyLock + LockRecovery
- [x] Buyback page + BuybackEngine
- [x] Wallet dialogs, Turnstile, ErrorBoundary
- [x] Verify: tests, build, browser (desktop/mobile, light/dark); independent read-only review

## Review
- `npm test` 624/624 pass; `npm run build` (both typechecks + Vite) passes; pre-existing >500 kB chunk warning unchanged.
- Browser (read-only proxy to production data): all routes at 1440px and 390px, light and dark; no horizontal overflow.
- Independent read-only review: no P0. Fixed all 4 P1:
  1. Token-page fee card was gated to creator/treasury → restored for every wallet (non-creators get the generic card).
  2. Buyback engine load errors were hidden inside an engine-only branch → messages/errors/tx link render always.
  3. "WETH spent · all time" actually showed `rollingSpent()` (5-minute window) → now the design's rolling-limit bar.
  4. Unverified opening valuation warning was inside a closed disclosure → visible warning notice.
- Also fixed P2: history dialog re-open after wallet change, dialog focus return, header chips hidden for mismatched pools
  and renamed "Verified quote asset", still-locked filter, stale MUSEGOD price label, wallet → My rewards keeps chainId,
  lock read errors visible, feed tab semantics, theme toggle labelling, loading indicator.
- Footer (owner-approved 2026-10-09): "Not investment advice." plus a network-specific non-affiliation line —
  Robinhood Chain: "Not affiliated with Robinhood Markets, Inc."; Base: "Not affiliated with Coinbase Global, Inc."
- Not done: real-wallet transactions and the local Playwright acceptance scripts (need wallets/forks).

## Follow-up review fixes (2026-10-09)
- [x] Keep Token/MUSEGOD trading in the right column at 1280px; place it before the market and recent trades in the single-column layout.
- [x] Label retained market values in list rows and Trending with `Previous snapshot` and their original date/time; exclude stale values from the page-level updated time.
- [x] Refresh the parent buyback statistics after a confirmed `burn` or `execute`, while retaining the operation-generation check.
- [x] Use the active network context for both wallet My rewards links and in-app navigation, including Base forks opened without a chain query.
- [x] Give Review its own 640px width and responsive fact tiles that can wrap without overflowing.
- Validation: `npm test` 624/624 pass; `npm run build` passes both TypeScript targets and Vite (existing bundle-size warning remains); `git diff --check` passes.
- Browser: 1280px two-column trading, 1180/1179px breakpoint, 390px trade-first layout, and desktop/mobile Review fact widths checked without page horizontal overflow. Light and dark views checked using read-only production API/RPC data.
- Controlled local fixtures: two retained market timestamps survive a failed refresh and lose the stale label after recovery; a read-only test wallet on Base fork `/` links and navigates to `/rewards?chainId=8453`. These checks use synthetic API/wallet data and reject signing and sending; they do not prove real-wallet or mainnet execution. Buyback confirmation/failure/generation behavior was checked with a mocked action callback.
- No server/Worker/contract changes, production publication, commit, push, or real-wallet transactions in this follow-up.

## Publication preparation (2026-10-09)
- Rechecked the current source, including LaunchCurve's theme-variable colors; `npm test` 624/624 and `npm run build` pass.
- Included the three fonts' original OFL copyright/license notices alongside all five self-hosted font files.
- Publication scope: frontend source, favicon, fonts, the transaction-history browser-test selector and this task record. The raw design export stays local as a reference.
- Current production baseline on both origins: source `084c3a1d0693713e85b9ad597a880ec0d84229ee`, immutable release `build-37802179398-1`, Worker `2a1cbe40-0348-4794-9471-caff5f68b264`.
- Baseline controls: Robinhood enabled at revision 1; Base paused at revision 0; both report security protocol 1. This frontend release does not change those controls.
- The owner confirmed the publication order: push the reviewed commit to master, then wait for Actions to publish and verify the immutable candidate on both domains.
