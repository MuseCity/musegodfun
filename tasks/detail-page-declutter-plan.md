# Token detail page declutter plan

Status: In progress (2026-10-15). Branch `claude/codex-redundancy-review-5ebb74`, based on master `9ede4ea`.

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

Everything else moves into one collapsed `<details>` ("Trading details"): router approval scope and lifetime, the LI.FI fee note, slippage/liquidity and transfer rules, Doppler-pending status and how-to text. No sentence may reference a Doppler link when none exists. The `trade-live` status region, errors, quote summary and ETH-buy controls are unchanged.

### D3 Fee card tiers on the token page

Extract the decision into a tested pure function.
- NFT coin, not treasury: unchanged (where creator fees go is buyer-relevant).
- No wallet connected: no fee card (the header connect button remains).
- Connected wallet that is a catalog beneficiary: unchanged `token` variant.
- Connected wallet that is not a catalog beneficiary: a compact card — heading and one short hint that it is for on-chain fee beneficiaries, Check fees, the two claim amounts and claim buttons, allocation reference, errors and tx link. No identity row (icon, name, pair, fee) and no policy note.

### D4 Market card empty states (`TokenMarket`, both `launch` and `musegod`)

- Summary: when not loading and no market value is displayable (price, market cap, FDV, liquidity and 24h volume all null, or no summary at all), replace the `—` price, `— · 24h` chip and metric grid with one status line. The line distinguishes request failure (show the error), stale snapshot, and fresh-but-empty (the source has no price for this pool yet; point to the on-chain quote) without claiming there are no trades. A provided `metric` tile (MUSEGOD burn share) stays. Partial data renders tiles as today.
- Activity block (period selector, flow bar, volume/change line): hidden when no period has any buys, sells, volume or change value.
- Buy/Sell trade filter: hidden when the loaded trade list is empty.
- Candles empty message: suggest a longer interval only when one exists; when the empty response carries a `reason`, the message reflects it (check the server semantics in `server/market.ts`) instead of the generic suggestion.
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

### Run 1 implementation (2026-10-15)

D1–D7 implemented locally, with the original plan included in the first implementation commit. Added category-aware display helpers, collapsed trading/fee disclosures, tested token fee-card tiers, honest compact market empty states/provenance, removal of detail holders UI, and mount-safe trade refresh. Full suite: 1517/1517; build and diff checks passed. Evidence: `.superpowers/sdd/detail-declutter/evidence/run1-test-final.log`, `run1-build-final.log`, `run1-target-green.log`; red logs are in the same directory. Read-only browser verification and the conductor-led cross-review rounds are still pending at this implementation checkpoint. No production changes.
