# Token detail page declutter plan

Status: Released 2026-10-16 (`ae62e5c`, build-38821395839-1); live acceptance passed for all in-scope checks. Branch `claude/codex-redundancy-review-5ebb74`, based on master `9ede4ea`.

## Background

A read-only review of the live token detail page (desktop, no wallet; sample: CLAWGOD, a WETH pair on Robinhood) found that trading, creator fee claiming and protocol mechanics sit at the same level, and that empty market modules take most of the first screen. The review was cross-checked against the code; this plan is the corrected version the owner approved on 2026-10-15 (translated from Chinese: "proceed with the corrected version").

Observed facts on the live page (2026-10-15):
- `/market/summary` returned `status: fresh`, `source: CoinGecko`, and every value `null`; the page shows four `—` tiles with no explanation.
- `/market/candles?interval=1d` returned 0 candles from Bankr with `reason: backoff` (GeckoTerminal backing off); the page suggests "Try a longer interval" even on 1d.
- The trade note says "follows the stock token’s transfer rules" and "CLAWGOD does not represent ownership of Wrapped Ether stock."
- Quick amounts offer 1 / 5 / 10 WETH.
- "Doppler trading is pending" is followed by "or use the verified Doppler link".
- Every market section (summary, candles, trades) is requested twice on page load.
- A visitor with no wallet sees a "Beneficiary fees" card with "Connect wallet to view" and the "no second 80/20 split" note.

## Goal

An ordinary buyer can read the price state, check what they are buying and trade without first reading fee-claim mechanics or repeated status lines. Every real state stays visible and honest.

## Hard constraints

1. Presentation only. No change to server routes, market data semantics, contracts, fee policy, quote/trade/approval logic, wallet signing or the MUSEGOD trade panel (`MusegodTradePanel`).
2. Must stay clearly visible: chain, token contract copy, verified quote asset, total fee, estimated receive, slippage, minimum received, quote expiry, real errors, stale-data warnings, block reasons, NFT/hidden/unverified-valuation notices, ETH-buy recovery states, and the "Get on-chain quote" button for visitors without a wallet (it is the only price signal when the summary is empty, and read-only mode promises quote previews).
   - 2026-10-16: The guest "Get on-chain quote" button constraint is superseded by E2 of `tasks/weth-eth-pay-auto-quote-plan.md`: pair payments and native ETH payments on WETH pairs quote automatically for guests. The price signal, quote expiry, minimum output and real errors remain visible.

3. Market data honesty (`tasks/market-data-plan.md`): request failure, stale snapshot, source not covering the pool and an empty index stay distinguishable. Never imply there are no on-chain trades. Never fill zeros. Linked CoinGecko attribution stays wherever CoinGecko data is shown. A section never borrows another section's source or time.
4. The token-page fee card must stay reachable for every connected wallet (redesign review P1 fix, `tasks/todo.md`): the on-chain beneficiary can differ from the catalog record, for example after a transfer, and My rewards lists only catalog matches.
5. Rewards page (`Rewards`, `FeeCard` default variant) is unchanged.
6. Old copy, state, branches and CSS made dead by this change are removed in the same change.

## Items

### D1 Quote-asset-aware trade copy and presets (correctness)

Use `assetCategory()` (`src/lib/asset-categories.ts`). Robinhood non-stock assets (`OTHERS`): WETH, USDG, cbBTC, MUSEGOD. Legacy Base B20 assets have no category and stay stocks.

- Transfer-rules sentence: only for STOCK, PENNY_STOCK and ETF pairs.
- Ownership disclaimer: STOCK and PENNY_STOCK `"{coin} does not represent ownership of {name} stock."`; ETF `"{coin} does not represent ownership of {name}."`; OTHERS: none.
- The stock-status load error (`Could not load the stock multiplier...`) must not mention a stock multiplier or share equivalent for a non-stock pair.
- Pair-asset buy presets: stocks and ETFs keep 1 / 5 / 10. WETH uses the ETH presets 0.001 / 0.005 / 0.01; cbBTC 0.0001 / 0.0005 / 0.001; USDG 10 / 50 / 100. MUSEGOD and any other non-stock asset without a vetted preset show no fixed presets (Max stays). Sell presets (25/50/75%, Max) are unchanged.

### D2 Trade panel notes

Directly under the primary action, show only real states and at most one short line:
- `blockReason` (existing) and, when writes are disabled, one short line saying transactions are disabled and quotes are previews.
- For STOCK/PENNY_STOCK/ETF pairs, the one-line ownership disclaimer from D1.
- The "Trade on Doppler ↗" link when `dopplerUrl(token)` exists.

Everything else moves into one collapsed `<details>` ("Trading details"): router approval scope and lifetime, the LI.FI fee note, slippage/liquidity and transfer rules, Doppler-pending status and how-to text. No sentence may tell the user to use a Doppler link when none exists; the pending status may say when trading on Doppler opens (clarified 2026-10-16 after live QA). The `trade-live` status region, errors, quote summary and ETH-buy controls are unchanged.

### D3 Fee card tiers on the token page

Extract the decision into a tested pure function.
- NFT coin, not treasury: unchanged (where creator fees go is buyer-relevant). Superseded 2026-10-20 by `tasks/token-ip-detail-plan.md` §12: the NFT treasury card directly above says where creator fees go and carries the sweep, so this card is hidden for everyone but the platform treasury.
- No wallet connected: no fee card (the header connect button remains).
- Connected wallet that is a catalog beneficiary: unchanged `token` variant.
- Connected wallet that is not a catalog beneficiary: a compact card — heading and one short hint that it is for on-chain fee beneficiaries, Check fees, the two claim amounts and claim buttons, allocation reference, errors and tx link. No identity row (icon, name, pair, fee) and no policy note.

### D4 Market card empty states (`TokenMarket`, both `launch` and `musegod`)

- Summary: when not loading and no market value is displayable (price, market cap, FDV, liquidity and 24h volume all null, or no summary at all), replace the `—` price, `— · 24h` chip and metric grid with one status line. The line distinguishes request failure (show the error), stale snapshot, and fresh-but-empty (the source has no price for this pool yet; point to the on-chain quote) without claiming there are no trades. A provided `metric` tile (MUSEGOD burn share) stays. Partial data renders tiles as today.
- Activity block (period selector, flow bar, volume/change line): hidden when no period has any buys, sells, volume or change value. It reads the summary periods, so it sits in the market card directly after the metrics and summary warning, covered by the Summary provenance and stale/error note; the Recent trades card holds only the trade list, its filter, messages and the Trades provenance.
- Buy/Sell trade filter: hidden when the loaded trade list is empty.
- Candles empty message: suggest a longer interval only when one exists; when the empty response carries a `reason`, the message reflects it (check the server semantics in `server/market.ts`) instead of the generic suggestion.
- Stale snapshots with no rows (candles, trades, or a filter with no matches) keep the empty statement beside the stale or error note, as the summary does. Several transient causes say "Try again later." once.
- Provenance: one line per card. Market card: summary and candles provenance in one line, each section naming its own source (CoinGecko link preserved) and its own stale marker; short fetch time with the full timestamp in `dateTime`/`title`. Sections with no data and no error print nothing (no repeated "Source pending · Source and fetch time appear after data loads"). Trades card: one line with source, fetch time and the "latest 30 indexed trades, indexing may lag the chain" coverage note. MUSEGOD keeps "refreshes every minute while visible".

### D5 Holders tab

H1 (no holder data on either chain) has no restoration date, so the detail page drops the Holders tab, its state and its unavailable block; the feed card is titled "Recent trades" for both kinds. The server holders route and `scripts/test-market-http.ts` contract stay unchanged. Amend `tasks/market-data-plan.md` with a dated note: owner-approved 2026-10-15, the detail page omits the Holders tab while H1 holds; the API still returns an explicit `source_not_provided`.

### D6 Fee mentions and About card

- Header chip keeps the total fee (main view).
- The About card drops `FeeSplitBar` and the facts row. `FeeSplitBar` moves to the top of the "How fees are distributed" disclosure; Pool ID moves into "Contract details" (Supply is already there); the duplicate "How the buyback works" link goes (the disclosure already links the buyback policy).

### D7 Duplicate market requests

The `refreshKey` effect in `TokenMarket` must not bump the revision on mount. Each market section is requested once per page load; a later `refreshKey` change (a confirmed trade) still refreshes.

## Out of scope

- Paying with ETH on WETH pairs (`ethBuyAvailable` excludes WETH; a native wrap would be a separate trading change).
- Mobile-specific redesign (only regressions are checked).
- Server or market-source changes, holder data, MUSEGOD trade panel copy.

## Acceptance

1. Each D item is covered by tests that fail before the change (pure helpers or `renderToStaticMarkup` of presentational parts; no test duplicates the implementation).
2. `npm test`, `npm run build` and `git diff --check` pass.
3. Local read-only preview (plain Vite, GET-only proxy to production, no `.env`, no wallet) of CLAWGOD (WETH pair), MuseVader (MUSEGOD pair), MV2C (COST stock pair) and the MUSEGOD page at 1440px and 390px, light and dark: no `Wrapped Ether stock`, no 10 WETH preset, no guest fee card, one provenance line per card, no Holders tab, quote button present without a wallet, each market section requested once.
4. Repo documents stay English; no Han characters in tracked changes.
5. Cross review: claude review → codex fix → claude accept, then codex review → claude fix → codex accept. Both accept before delivery.
6. Local commits only. Pushing to master is a production release and needs the owner's explicit approval.

## Delivery record

### Run 1 (2026-10-15)

D1–D7 implemented in `bf8fcb4`; the original plan is included in that first commit. The closeout preserves the shared `.about-facts` styles still used by MUSEGOD. Full suite: **1517/1517**, build, diff and Han scan passed. Evidence: `.superpowers/sdd/detail-declutter/evidence/run1-test-final2.log`, `run1-build-final2.log`, and `run1/summary.json`; per-item changes and red/green evidence are in `.superpowers/sdd/detail-declutter/run1-report.md`.

Read-only Chrome DevTools preview: all four routes at 1440px/390px in light/dark passed (16 views); each market section loaded once, attribution and guest quote controls remained, and three guest quotes returned minimum receive/expiry. The gateway forwarded only GET API requests, three quote POSTs and allowlisted read-only RPCs; its write-method probe was rejected locally. Preview PID 44911 exited, port 4178 closed, and the stale PID file was removed after independent verification (`evidence/preview-cleanup.json`). No wallet, production writes, push or deployment.

Run 1 scope is complete. The conductor-led cross-review rounds and both acceptances are pending; this is not final acceptance of the whole plan. Local rollback: revert the closeout commit, then `bf8fcb4`, after checking for later work. No production rollback is required.

### Run 2 (2026-10-16)

Verified and fixed C1-1–C1-7: removed duplicate/error-mislabeling provenance, kept loading config separate from disabled trading, corrected loading separators and hidden-filter copy, tested the extracted About/Contract markup, removed the dead CSS selector, and consolidated quote guidance with short provider causes. Each finding except C1-6 has failing-before evidence; the About test also rejects three temporary regression mutations. Full suite: **1525/1525**; build, diff check and Han scan passed. Report and red/green evidence: `.superpowers/sdd/detail-declutter/run2-report.md` and `evidence/run2/` beneath the same directory.

Chrome DevTools rechecked CLAWGOD and MUSEGOD at 1440px in light mode against live read-only responses; both passed with their own section attribution and timestamps. The gateway allowed GETs and allowlisted read-only RPCs, capped quotes at zero, and forwarded no quote POSTs. Preview PID 92063 exited, port 4178 closed, and its stale PID file was removed after independent verification. No wallet, production writes, push or deployment. Findings are fixed, not self-accepted; both cross-review acceptances remain pending. Local rollback: revert this Run 2 fix commit after checking for later work.

### Run 4 (2026-10-16, claude fix)

Fixed X2-1 (P2), C1b-1 and C1b-2 (P3) in `src/components/TokenMarket.tsx`. Verified X2-1 first: the activity block read `summary.data.periods` but sat under the Trades provenance, so it borrowed the trades snapshot's source, time and stale state (and showed no source at all when trades were unavailable). The whole block now sits in the market card between the metrics/summary warning and the chart toolbar, so the Summary provenance, stale marker, linked CoinGecko attribution and warning cover it; visibility rule unchanged, both kinds. Recent trades keeps the list, the Buy/Sell filter, its messages and the Trades provenance. Stale empty chart/trade snapshots now say the empty statement plus the stale or error note; combined transient causes print "Try again later." once. No CSS change was needed: the flow selectors are content-based and both cards share width and gap. A static render of the market card at 390px showed no horizontal overflow.

Tests: 4 new cases in `tests/token-market-declutter.test.ts` fail against `36087af` and pass now (stale summary + fresh trades, fresh summary + stale trades, fresh summary + unavailable trades, for both kinds; visibility rule; stale empty chart/trades with and without a client error and with a filter; single retry sentence). Full suite **1529/1529**; build, diff check and Han scan passed. Details and red/green evidence: `.superpowers/sdd/detail-declutter/claude-fix-r2.md` and `evidence/run4/`. Findings are fixed, not accepted; Codex acceptance is pending. No server, contract, wallet, trade, MusegodTradePanel or Rewards change; no push. Local rollback: revert the Run 4 commit.

### Cross-review closure (2026-10-16)

- Claude review round 1 (`claude-review-r1.md`): C1-1–C1-7 found; codex fixed them in `36087af`; claude accepted all seven (`claude-accept-r1.md`) and raised C1b-1/C1b-2 (P3).
- Codex review round 2 (`codex-review-r2.md`): X2-1 (P2) found; claude fixed X2-1, C1b-1 and C1b-2 in `83c46d1`; codex accepted all three with pre-fix red tests and a five-view browser recheck (`codex-accept-r2.md`, `evidence/run5/`).
- Both verdicts are ACCEPT with no open findings (`review-state.md`). Conductor rerun on `83c46d1`: `npm test` **1529/1529**, `npm run build`, `git diff --check` and the Han scan pass.
- Acceptance items 1–5 are met. Item 6 holds: commits are local only. Connected-wallet fee card tiers are covered by pure/SSR tests, not by a real wallet session.
- Local rollback: revert `83c46d1`, `36087af`, `8333cc9`, `bf8fcb4` (newest first). After a release, the production rollback point is Worker `6c87963c` (`9ede4ea`, recorded 2026-10-15).

### Release and online acceptance (2026-10-16)

- Owner approved the release (translated: "release"). Pushed `9ede4ea..ae62e5c` to master. CI run 38821395839 passed; build `build-38821395839-1`, Worker version `80ffc154-16c6-4a6c-8e70-97c6d7d0f090`, deployment verified on both origins by `scripts/verify-deployment.ts`. Production rollback point: Worker `6c87963c` (`9ede4ea`).
- Conductor spot check on https://musegod.fun (CLAWGOD, no wallet): `build-info.json` reports `build-38821395839-1` / `ae62e5c`; no stock wording in the trade panel, WETH presets 0.001/0.005/0.01, no guest fee card, no Holders tab, quote button present, summary/candles/trades each requested once.
- Codex read-only Chrome QA (gpt-6.1-sol xhigh) on both domains, 1440px and 390px, light, plus MUSEGOD dark: every in-scope check passed, including build identity, presets, disclaimers, guest fee card absence, feed, empty summary, activity placement, provenance, guest actions, collapsed Trading details, About disclosures, single requests, no 390px overflow, one guest quote preview, Explore and Rewards sanity.
- Its four FAIL rows were triaged as outside this change: the global footer sentence about "the underlying stock" is pre-existing owner-approved copy (`tasks/todo.md`, 2026-10-09); the Doppler pending status inside the closed Trading details is allowed by D2 (wording clarified above); the MUSEGOD page's trade notes and About/header use `MusegodTradePanel`/`MusegodPage`, which this plan leaves unchanged. The QA brief applied token-page checks too broadly; no regression was found.
- Follow-up (owner decision 2026-10-16, translated: "change the footer to underlying asset and release it together"): the global footer now reads "does not represent ownership of the underlying asset", which fits stock, ETF and crypto pairs alike. It is not part of `build-38821395839-1`; it ships in the next release together with this record, whose build id the site footer and GitHub releases show.
