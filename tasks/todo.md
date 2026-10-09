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

## Two-step Launch wizard (2026-10-09)
Reference: ponsfamily.com/launchpad/create (step 1 Identity, step 2 Economics, sticky preview on the right).

### Spec
- Step 1 "Identity": image, name, symbol, description, image URL, socials. `Continue` (and Enter) checks only these
  fields (`launchIdentityIssue`); an invalid field shows its inline error and takes focus.
- Step 2 "Economics": quote asset, first buy, advanced trading fee. `Back` + `Review and continue` (unchanged preflight and
  review dialog). If preflight finds an invalid identity field, the form returns to step 1 and focuses it.
- Both panels stay mounted (`hidden`), so draft state, field lookups and recovery behave as before. The payment-recovery
  card and the launch footer (draft status, Clear draft, notices, Create another token, recovery hash, Recover pending
  launch) show on both steps.
- The step is saved with the autosaved draft and restored on reload, wallet/intent switch and Resume; Clear draft and a
  new launch start at step 1.
- Uploaded token image fills the whole upload box (`object-fit: cover`) with a "Replace image" label; square on phones;
  falls back to the letter icon if the image fails to load.
- No server, Worker, contract, API or transaction-flow change. Playwright acceptance scripts updated to click Continue.

### Acceptance
- [x] `npm test` 625/625 (new test: step restore + identity-only check); `npm run build` passes (existing chunk warning).
- [x] Browser (read-only proxy): step 1 form 1816px → 810px at 1024px wide; page 1197px at 1440px. Validation, Enter to
  continue, Back, step indicator, Clear draft, reload resume, step-2 → step-1 bounce, review dialog open/close;
  390px and dark mode without horizontal overflow; image fill desktop/mobile and broken-image fallback.
- [x] Local Playwright UI fixtures (`test:launch-browser`, all API mocked): see Review.

### Review
- Local Playwright UI suite (`test:launch-browser`, all API/RPC/wallet mocked, local Vite only): 34/38 cases passed
  with the wizard; the other 4 (`two_tabs`, `unknown_send`, `approval_unknown`, `unknown_fetch`) failed identically
  on unmodified HEAD and are fixed below.

## Second-tab wallet restore (2026-10-09)
- Symptom: in the 4 cross-tab cases the second tab stayed on "Connecting…" with "This wallet already has a connection
  request", so it fell back to the anonymous empty draft and never showed the in-flight launch's recovery UI.
- Root cause: React StrictMode runs `WalletProvider`'s mount effect twice in development with the same
  `WalletConnection`. `dispose()` advanced the epoch (discarding the first restore's result) but kept that request in
  the per-provider `pending` guard, so the remounted restore was rejected as a duplicate prompt.
- Impact: development/test only. A production build of HEAD passes `two_tabs` (no StrictMode double effects).
- Fix (`src/lib/wallet-connection.ts`): `dispose()` replaces the `pending` set; each request releases only the set it
  registered in, so a late disposed request cannot reopen duplicate prompts for the live one.
- Test: `tests/readonly.test.ts` "a restore started before dispose cannot block the remounted provider's restore"
  (failed before the fix). `npm test` 626/626; `npm run build` passes; all 4 cases now pass.

## Wizard review follow-up (2026-10-09)
Independent read-only review: no High/Medium findings. All 4 Low findings verified and fixed:
- [x] A launched draft reopened on step 2 with the launched token's identity hidden (success never rotates the intent;
  pre-existing gap the wizard made more visible). `reopenDraftAtIdentity()` resets the saved step to 1 for the shared
  chain draft, the launched intent and the pre-connection copy before navigating to the token. Browser `success` case
  now proves the draft was autosaved at step 2 first, then asserts step 1 after launch; it fails with the reset disabled.
- [x] `LAUNCH_IDENTITY_FIELDS` is now pinned to `launchSchema` by a unit test (every field belongs to one step).
- [x] Step indicator: `role="list"` and screen-reader text "Step N of 2[, completed]".
- [x] Payment recovery "Use paired asset directly" / "Keep tokens…" switches to step 2, where the first buy lives.
- Final: `npm test` 626/626; `npm run build` passes; `git diff --check` clean; `test:launch-browser` 38/38 in one run.
- Not run: `test:launch-fork-browser` (needs a local Anvil fork); its selectors were updated for the two steps.

## Commit and deployment review (2026-10-09)
- Owner requested review of the uncommitted changes, then commit and deploy through the existing master-push pipeline.
- Three independent read-only reviews covered wizard persistence/recovery, wallet connection races, validation, CSS and
  acceptance selectors. Two low-severity findings were verified and fixed before publication:
  - Successful launch reset an unrelated anonymous draft to Identity. Reset now applies only to the launched intent or
    a complete matching migrated copy; independent identity, fee and first-buy settings retain their saved step.
  - At 320px the Back/Review labels overlapped. The action group wraps when its buttons no longer fit; 390px stays inline.
- Current-run checks: `npm test` 627/627, both TypeScript targets and Vite build pass; acceptance scripts parse and
  `git diff --check` passes. The build retains the existing bundle-size warning.
- Current-run read-only browser: Identity validation focuses the invalid name; Enter advances to Economics; reload
  restores step 2 and identity; Back restores step 1 and focuses its heading. Button labels fit at 320/360/390px;
  360/390px have no page overflow. Existing 320px sidebar/navigation overflow predates this diff and is left unchanged.
- The previous 38-case mocked browser run is recorded above; it was not rerun in this review. No Anvil fork or real
  wallet signing was performed. Original redesign HTML stays local and untracked.
- Publication baseline was re-read on both origins: source `7e798acee12e4adf3ab1e29d127b1f50b12f7cd6`, release
  `build-37880215532-1`, Worker `da7b05d1-a127-4e52-b1d6-468ad51af324`. Robinhood remains enabled at revision 1;
  Base remains paused at revision 0; security protocol 1. Production verification will compare the new immutable
  release on both domains and confirm those runtime controls stay unchanged.
