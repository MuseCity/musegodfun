# Price impact, faster MUSEGOD market, chart history paging and live Bankr swaps

Status: In progress (2026-10-16). Branch `claude/live-market-price-impact`, based on `35d59ec` (master `8df204f` plus its unpushed release record).

## Owner request (2026-10-16, translated)

After a codex study of pools.fun, the owner chose to do all four borrowed items in one round ("do it all at once"), with live swaps delivered by a direct browser connection to Bankr (owner's pick among: browser direct, server relay, 5-second polling).

## Facts established before this plan

- V4 quotes (`server/service.ts` `quote`) return only amounts from the Doppler quoter; no pre-trade pool price or block. The MUSEGOD quote (`server/musegod.ts`) reads `slot0` at a pinned block but does not return it.
- MUSEGOD market data comes from Bankr (`server/musegod-market.ts`): `/discover/{token}/ohlcv?...&limit=200`, `MUSEGOD_MARKET_TTL = 60_000`; the page polls every 60 s while visible (`src/components/TokenMarket.tsx`).
- Robinhood ordinary candles try Bankr, then GeckoTerminal, then CoinGecko (quota-limited). Bankr returned no candles for the CLAWGOD V4 pool on 2026-10-15/16, so live Bankr swaps are only known to cover MUSEGOD (the pools.fun Sushi V3 pool).
- CSP (`server/http-security.ts`): `connect-src 'self' https://challenges.cloudflare.com`.
- Codex's pools.fun study: Bankr OHLCV supports `before_timestamp` paging; pools.fun polls every 5 s and also listens to a Bankr Socket.IO `TOKEN_SWAP` stream, reconciling live updates with the REST `watermark`. Its live-candle code assumes a 1e9 supply.

## Goal

Buyers see how much their trade moves the price before confirming; the MUSEGOD market feels live; anyone can scroll back through chart history where the source allows it.

## Hard constraints

1. Trade safety is unchanged: quote freshness, minimum output, transaction builders, wallet code paths, approvals and execution are not modified except to read new display fields and to gate confirmation behind the L1 acknowledgment. Live data never feeds quotes or trades.
2. Market honesty (`tasks/market-data-plan.md`): every value keeps its own source and time; live updates are labelled; failures, staleness and empty states stay distinguishable; no zero-filling; no fabricated history.
3. Cost bounds: no new paid API, no resident server process, no `eth_getLogs` scans. Additional RPC per quote is at most one pinned-block pool-state read. Bankr call volume stays bounded by the server cache, not by visitor count, except for the browser's own socket.
4. Security: CSP widens only `connect-src`, only to the exact Bankr realtime origin(s) actually used (https and wss), and nothing else. New dependency: `socket.io-client` pinned to an exact version at least two weeks old, lazy-loaded only where used. Every socket payload is schema-validated and bound to the MUSEGOD token and chain.
5. Earlier plans stay in force unless replaced here (declutter honesty rules, automatic quotes and their caps, in-field Max).

## Items

### L1 Price impact and protection (token pages and MUSEGOD panel)

- Quote responses add the pool's pre-trade price state read at the same block as the quote where the reader allows it (V4: `sqrtPriceX96` from the pool's slot0 for the quoted pool key; MUSEGOD: the `slot0` it already reads), plus that block number. If the V4 quoter cannot be pinned to the same block, read both at one pinned block number via the client call options, or document the bound on the mismatch.
- The client computes price impact from mid price, amounts, decimals and direction, excluding the pool's nominal fees when they are verified (`tradingFeeBps` plus the 0.05% LP fee for V4 launches; the 1% pool fee for MUSEGOD); otherwise it labels the value "incl. fees". Pure, tested math with bigint precision.
- Quote summary shows "Price impact". At 5% or more it is highlighted as a warning; at 15% or more the confirm button requires an explicit acknowledgment checkbox showing the percentage, reset on any quote change. No hard block.
- Shown for pair payments, native ETH on WETH pairs, sells and the MUSEGOD panel. The LI.FI two-step ETH path shows it only if a pool-leg quote is available; otherwise the row is omitted (never estimated).

### L2 Faster MUSEGOD market refresh

- `MUSEGOD_MARKET_TTL` 60 s → 15 s and the MUSEGOD page polling 60 s → 15 s while visible; copy "refreshes every minute" becomes accurate. Ordinary token polling (15 min) is unchanged.
- Snapshot, stale and identity semantics are otherwise unchanged.

### L3 Chart history paging (Bankr-sourced candles)

- The candles endpoints (MUSEGOD and ordinary tokens) accept an optional `before` (unix seconds; validated: integer, aligned to the interval, not in the future, not older than 365 days). Only Bankr-sourced candles page; GeckoTerminal/CoinGecko sources return the first page only, so no extra CoinGecko quota is used.
- Verify Bankr's real parameter name and semantics (`before_timestamp`) with a single read-only probe before implementing.
- Historical pages are cached per section, interval and `before` with a longer TTL (1 h); the first page keeps its current TTL.
- Chart: when the user scrolls near the left edge, request one older page (never while one is in flight), merge by time without duplicates, and stop with a quiet "Beginning of indexed history" state when a page is empty. Provenance of the first page is unchanged; paged history is labelled with its own fetch time in the chart footer only if it differs materially.
- Interval labels stay honest: if a source returns fewer bars or gaps, do not relabel or fill.

### L4 Live Bankr swaps on the MUSEGOD page (browser direct)

- Lazy-load `socket.io-client` only on the MUSEGOD page; connect to Bankr's realtime endpoint and subscribe to MUSEGOD swaps exactly as the pools.fun client does (derive endpoint, namespace, subscription and event names from the public pools.fun bundle and a short read-only probe; record them in the plan).
- First verify a browser-origin handshake from a non-pools.fun origin (the local preview) is accepted. If Bankr rejects our origin or requires credentials, stop with NEEDS_DECISION and keep L1–L3.
- A pure reducer applies validated swaps: update the current candle bucket of the selected interval (high, low, close, volume), prepend to Recent trades (deduplicated by transaction hash and log index or Bankr id, list capped at 30), and update the headline price. Price comes from the payload's USD price; if only market cap is given, divide by the verified MUSEGOD total supply from the page's token info, never a constant.
- Reconciliation: a REST refresh replaces data up to its `watermark`; live events at or before the watermark are dropped; no double counting.
- Provenance shows "Live · Bankr" while connected; on disconnect the page silently falls back to L2 polling. Disconnect while the document is hidden; reconnect with backoff; at most one connection per tab.
- Privacy note for the record: visitors' browsers connect to Bankr directly on the MUSEGOD page.

## Out of scope

Limit, stop, TWAP or DCA orders; Bankr-prepared transactions; changing the default slippage; live swaps for V4 tokens (Bankr does not index them today); unwrap on sell.

## Verification and acceptance

1. TDD for all pure logic: price-impact math (direction, decimals, fees, tiny and large trades), acknowledgment gating, `before` validation and page merging, socket payload schema, live reducer (bucket update, dedupe, watermark, supply), connection lifecycle (hidden, backoff, single connection).
2. Fork evidence for L1 (repo fork helpers, worktree-local `.env.fork` with only `ALCHEMY_API_KEY`, deleted afterwards, one session per run): on a Robinhood mainnet fork, quote CLAWGOD and MUSEGOD at a tiny and a large size through the real server quote code; the tiny trade's fee-excluded impact is within 0.05% of zero, impact grows with size, and executing the large quote on the fork realizes an output consistent with the quoted amount.
3. Read-only probes: one Bankr OHLCV `before_timestamp` request; a Bankr socket handshake and subscription lasting at most 2 minutes. No secrets in evidence.
4. `npm test`, `npm run build`, `git diff --check`, Han scan.
5. Local read-only preview (plain Vite, GET-only gateway plus capped quote POSTs; L1 server fields can only be checked against production after release, so the preview checks layout with fork-derived fixtures if needed): MUSEGOD page shows live status, paging on left scroll, 15 s refresh; CLAWGOD shows price impact once quotes carry the fields; CSP has no violations; 1440px and 390px.
6. Cross review: claude review → codex fix → claude accept, then codex review → claude fix → codex accept.
7. Local commits only; release needs the owner's explicit approval.

## Delivery record

(Filled in per run.)
### Run 1 — 2026-10-16

- Delivery: L1–L3 implemented locally; L4 is `NEEDS_DECISION`. Both cross-review rounds remain pending. This plan is included in the first implementation commit; the exact commit hash is recorded in `.superpowers/sdd/live-market/run1-report.md`.
- L1: real V4 quotes use the SDK's same quoter ABI/address directly so the quote and one additional packed pool-slot0 read share a pinned block. The block lookup is additional metadata RPC; no second pool-state read is added. MUSEGOD reuses its existing pinned slot0. Verified nominal V4 fees use the saved launch rate plus the verified 500 ppm LP fee, with unknown fees labelled `incl. fees`. Bigint math uses raw amounts and the raw sqrt price, preserving both assets' decimals. Token pair/native/sell, LI.FI pool previews and the MUSEGOD panel show the impact; warnings start at 5%, acknowledgment at 15%. Every replacement quote invalidates acknowledgment. A high-impact replacement after an ETH conversion uses the existing incomplete-trade recovery path so its new quote can be reviewed.
- L1 fork: one Robinhood fork, block `89763342`, execution chain `31337`, real `LaunchpadService.quote` and `MusegodReader.quote`. Tiny 0.000000001 ETH impacts: CLAWGOD `-0.000505%`, MUSEGOD `0.000000%`; large 1 ETH / 10 ETH impacts: `41.377333%` / `31.854550%`. Both large executions returned exactly their server-quoted output. Evidence: `evidence/fork-price-impact.json`, relative to the collaboration directory. Anvil stopped, its port was rebound successfully, and `.env.fork` was deleted. No production transactions or wallet were used.
- L2: MUSEGOD server TTL and visible polling are 15 seconds; ordinary polling remains 15 minutes. Source, snapshot and identity checks remain in place.
- L3: both candle routes validate optional `before` values (aligned integer unix seconds, past 365 days). Bankr-only historical pages use identity/interval/cursor cache keys and a one-hour TTL; paging never calls CoinGecko or GeckoTerminal. A non-Bankr chart exposes its saved first page only. The lazy chart loads near its left edge after interaction, permits one older-page request, preserves the visible range and displaced first-page bars, merges without filling gaps, and stops on empty/non-progress pages. Historical fetch-time ranges appear separately when materially different; empty pages do not replace the provenance of existing bars.
- Observed probe: one Bankr OHLCV request with `before_timestamp` returned 200 bars in descending order, including the boundary bar. Readers filter `time < before` before merging. The source response had no watermark. Evidence: `evidence/probes.json` and `evidence/ohlcv-probe.json`.
- Observed bundle: public pools.fun bundle `index-DyVWSMUb.js`, SHA-256 `e41fc2277d516f0cc43093a79d3a6c50f9948716b296a3e6fd2e4766fb89ea06`, uses `wss://api.bankr.bot`, namespace `/pools-fun`, default path `/socket.io/`, websocket transport and `TOKEN_SWAP`, `DISCOVER_PRICE_UPDATE`, `DISCOVER_VOLUME_UPDATE`. Subscription is the Socket.IO namespace connect; no explicit subscribe event was found. Bundle swap fields include tokenAddress, chain, txHash, blockNumber, logIndex, timestamp, traderAddress, side, tokenAmount, totalUsd and mcapUsd. These are bundle-derived fields, not an observed valid live payload.
- L4 gate: the browser-origin probe from `http://127.0.0.1:4178` closed with 1006 after 0.957 seconds, before any Engine.IO frame or namespace acknowledgment. No credential was sent. A supplementary curl attempt negotiated HTTP/2 and returned 400; that is not valid proof of an origin-policy rejection. Browser-origin acceptance is unverified, so L4 stops here. No socket client, reducer, lifecycle, CSP expansion or dependency is shipped. `socket.io-client@4.8.1` was checked as a possible exact pin (published `2024-10-25T06:03:00.286Z`) but was not installed while the gate is closed. A direct browser connection would disclose the visitor's IP/origin to Bankr.
- Preview: plain static Vite, no app environment, GET API gateway, read-only RPC allowlist with production Origin, combined quote cap of six, and all other writes rejected. L1 uses fork-derived pool-price response decoration; the CLAWGOD acknowledgment check uses a clearly recorded inert wallet fixture, with no wallet provider or sending code. MUSEGOD at 1440px/390px showed real Bankr data, 15-second requests, history growth from 199 to 398 bars and the genuine daily history boundary. CLAWGOD at 1440px showed the 41.37% warning, disabled → enabled after acknowledgment → disabled/unchecked after replacement. No CSP errors or mobile horizontal overflow were observed. Screenshots and DOM/log evidence are in `evidence/run1/`. The final provenance-only correction is covered by its red/green component test after the captured preview build. The preview stopped and port 4178 was successfully rebound.
- Request bounds: four direct Bankr REST calls total (one semantic probe, three preview history cache misses); two handshake attempts, with no accepted socket session; four production quote POSTs; 133 preview gateway requests, including nine forwarded read-only RPC methods. The fork forwarded 262 upstream RPC methods, with no log scans or upstream writes. Its 17 instrumented local helper/control calls are a partial count; viem's local RPC calls were not fully captured by that instrumentation.
- Verification: TDD red/green evidence covers math, both quote paths, actual acknowledgment buttons, visible polling, before validation, cache/source isolation, route forwarding, merge/pager behavior and history provenance. Final `npm test`, `npm run build`, diff and Han checks are recorded in the run report. The first broad run found one old minute-refresh copy assertion, corrected with the L2 copy change. Build retains its existing large-chunk advisory; `npm ci` reported four high-severity advisories in the existing lockfile.
- Runner evidence: `evidence/fork-price-impact.executed.ts` matches the recorded runner SHA-256. After that one execution, the committed runner moved key/Anvil setup inside its existing cleanup boundary; it was not rerun against another fork.
- Local rollback: revert the Run 1 implementation commit after checking for later changes. Release, push, deployment, mainnet execution and self-acceptance are outside this run. The next decision is how to obtain a successful authorized browser-origin Bankr handshake; the missing REST watermark also needs confirmation before live candle reconciliation can be accepted.
