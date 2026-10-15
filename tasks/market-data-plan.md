# Base / Robinhood Market Data Fix Plan

Date: 2026-10-15 (Asia/Shanghai)

Status: Released (2026-10-15, `50d5047`, build-38732268647-1). The Worker has `COINGECKO_API_KEY` configured; live API and browser acceptance passed on both domains, see "Release and online acceptance" in the Delivery record. H1: ordinary holders on both chains are not provided for now. Still unmet: the registered Base pool has no real trades (no positive sample), and nonempty/long-history Robinhood trades have not been accepted.

## Goal and completion criteria

Make the homepage and detail pages for Base (8453) and ordinary Robinhood (4663) tokens use identity-verified real market data, candles, and trades; per H1, ordinary holders on both chains are not provided for now and are explicitly shown as unavailable. These cases must each be shown distinctly: trades exist but the data source does not cover them, the data request failed, the index returned empty records, and on-chain verification found no trades. Do not claim a fix by hiding error messages or filling in zeros.

Completion criteria:

1. summary/candles/trades on both chains each have an actually working data path; holders consistently return unavailable per H1; source, time, and coverage are traceable; a failure in one section does not affect other data or on-chain quotes.
2. Verify the normal data branch with a registered pool that has real existing trades; verify the originally failing pool's actual state at that time. Without a positive sample, or while a dependency is unmet, this item must not be marked complete.
3. The homepage and detail pages use consistent metric semantics and snapshots; missing fields stay `null`, actual zero values stay `0`, and empty history generates no candles.
4. MUSEGOD-specific market data, the six chart intervals, and the existing trading and fee flows pass the relevant regressions.
5. Local acceptance and release acceptance are recorded separately; before release, only a completed local fix may be reported.

## Current evidence and samples

Production endpoints were re-requested at 2026-10-15 18:18:46 Beijing time; the results still reproduce. The following are API measurements, not conclusions about on-chain trades.

| Network / sample | summary | candles (1h) | trades | holders |
| --- | --- | --- | --- | --- |
| Robinhood / MuseVader | 503, feature not integrated | 200, Bankr, `candles: []` | 503, feature not integrated | 503, feature not integrated |
| Base / Musegod–NVDAc | 503, no valid snapshot | 503, no valid snapshot | 503, no valid snapshot | 503, no valid snapshot |

- Robinhood token: `0xB60E817D8E6F72013701aC447fd1D92Caa561c7c`; pool: `0x3d20d8f4037cf3a75236fccde9ee33da848ccb14fda4c4dd8367966379b97955`.
- Base token: `0x79eA556198C33BB3025f0243144E74Cb9416E670`; pool: `0x1a050a8dd375dce8c34ae2394aea4c7f0acd1381f29d1290272a5c847cd41475`. It is not the same on-chain asset as the featured MUSEGOD on Robinhood.
- The October 14 RPC scan only proves that no Swap was found in the MuseVader registered pool in blocks `87043468–88137451`; it must not be reused as a no-trade conclusion for today or for other pools.
- All four Base paths are implemented; CoinGecko failures such as a missing key, quota, rate limiting, indexing, and identity verification are merged into a generic error by `server/snapshots.ts`, so the exact current cause still needs to be pinpointed.

## Scope and constraints

- Reuse `server/market.ts`, `server/snapshots.ts`, existing storage, batch summaries, and frontend market components; do not introduce a general-purpose data platform.
- Keep the fixed identity, dedicated cache, and one-minute refresh behavior of `server/musegod-market.ts`.
- Do not change contracts, launch rules, fee rates, buybacks, wallet signing, or trading entry points; do not change the public RPC allowlist or the primary RPC security limits.
- `server/alchemy-rpc.ts` currently limits a single `eth_getLogs` to at most 10 blocks. Do not bypass existing permission and usage constraints by switching to a backup primary RPC, raising this limit, or issuing large numbers of 10-block requests.
- By default, do not buy paid APIs, add resident background collection processes, or build a full-chain index. Only when evidence proves it necessary, list a data-dependency option and its cost separately; do not claim full restoration before the dependency is resolved.
- Implement on the dedicated branch `codex/market-data-reliability`; first check for and reuse a suitable attached worktree. Protect other tasks.
- Do not load the real `.env`, and do not start a dev server that writes to the production database. Verification uses isolated storage, a controlled read-only API proxy, or native Worker tests; credentials never enter the browser, logs, or Git.
- Run 1 authorizes P1 only; the commander's decision in the Run 2 brief separately authorizes P2/P3/P5 implementation, P4 evaluation, and P6 local verification and local commits. Browser, review, and release acceptance remain for later; pushing, production configuration changes, deployment, collectors, and purchases remain prohibited.

## Implementation order

### P1: Locate the real Base failure cause and confirm data-source coverage on both chains

Touches: `server/market.ts`, `server/snapshots.ts`, `server/config.ts`, existing read-only acceptance script.

- [x] Build a read-only baseline for the current production version: record the response, source, fetch time, and failure reason per chain / token / pool / section, covering the originally failing samples. Run 1 covers all 4 ordinary registered tokens, six intervals, and the batch on both chains; see the Delivery record.
- [x] In the actual runtime environment, verify whether CoinGecko credentials are usable, the auth type, remaining quota, and upstream status; record only boolean results and sanitized status, never reading or printing credential contents. Run 1 checked the Worker secret names (the Demo key is missing), a single read-only quota GET, and the local Demo response; the Demo provider's remaining-quota endpoint returned 401, so actual remaining quota is still unknown, and the local key is not the Worker key.
- [x] Check Blockscout from the Worker's actual egress environment instead of treating the local 403 directly as the Worker's failure cause. Run 1 made a single Base holders request from an isolated remote-dev Worker with no bindings, no secrets, and no routes, and got a 403 challenge; this is not a production Worker or Robinhood egress verification.
- [ ] For each chain, select one registered pool with real existing trades and one empty-history sample. Do not launch tokens or manufacture trades for acceptance.
- [ ] Verify CoinGecko / GeckoTerminal pool summary, OHLCV, and trades, plus Bankr's corresponding capabilities. Confirm chain, full token, pool, quote, pair direction, and response granularity item by item.
- [x] The holders source is closed out per H1 as not provided for now; no provider is integrated this round. Any future restoration must re-verify real coverage of the target token; documented chain support is no substitute.
- [ ] For pools with trade evidence but no USD candles, compare USD- and quote-denominated responses for the same token / pool to determine whether USD valuation is missing. Quote data is for diagnosis only and must not be loaded directly into USD charts.

Stage gate: record each section's primary source, verifiable backup source, and remaining gaps. The exact Base failure must be backed by configuration, quota, or actual upstream response evidence; listing a few guesses is no longer enough. If the original cause has been swallowed and cannot be obtained read-only, first implement P2's minimal diagnostic change, then return to this step to pinpoint it; do not blindly change auth or providers before pinpointing it. When runtime-environment evidence cannot be obtained, mark it explicitly as an unverified dependency.

### P2: Preserve diagnosable errors and fix the Base data path

Touches: `server/market.ts`, `server/snapshots.ts`, `src/lib/market.ts`, `server/app.ts`.

- [x] Add stable, sanitized reason codes to the existing error and snapshot metadata, distinguishing at least missing configuration, insufficient quota, not indexed, rate limited, request failed, and identity/data validation failed. Keep the existing fresh / stale / unavailable semantics; do not redo the API protocol.
- [ ] Fix the actual Base root cause based on P1 evidence. Run 2 completed cause preservation; the missing Worker Demo secret still awaits separately authorized configuration, so this cannot be checked as a production fix.
- [ ] Only after P1 verifies it works, add a GeckoTerminal fallback for Base summary / candles / trades; trigger it by error type, with no unbounded retries. CoinGecko and GeckoTerminal may share an index, so the fallback does not guarantee an independent index.
- [x] Keep existing real zero values and legitimate empty results; all-empty fields must not be treated as positive acceptance evidence that "market data is restored". A failed request must not be converted into a successful empty array.
- [x] H1: holders accesses no upstream or snapshot and returns `503 / unavailable / source_not_provided` after registration validation; historical snapshots are kept but not read, and MUSEGOD is unaffected.
- [x] Batch summaries keep per-row status and reason; HTTP 200 does not mean every token has valid market data.

Stage gate: the original Base failure is explained; a sample with trades returns real market data, six-interval candles, and trades; holders are explicitly unavailable per H1, and integrating a source is no longer required this round. Unresolved external coverage issues move to P4; they cannot be closed by changing copy alone.

### P3: Complete ordinary Robinhood market data and trades; degrade holders per H1

Touches: `server/market.ts`, `server/app.ts`, `src/lib/market.ts`, related parser tests.

- [x] Add an explicit Robinhood branch that selects endpoints and identity prefixes by chain; do not just delete `assertLive()` and keep fetching Base data.
- [ ] summary / trades use the registered-pool source that passed P1 verification; Run 2 integrated the CoinGecko exact pool: the R3 summary is nonempty and current 24h trades are legitimately empty, but acceptance of a nonempty Robinhood trade list is still missing; canary receipts do not substitute for that provider response.
- [x] H1: holders keeps the route and registered-token validation, then is directly unavailable; remove Blockscout fetching/parsing, source inference and failure types, frontend requests/table, and the script's old checks.
- [x] Do not provide holder count/Top10/contract flags/update time, and do not fill zeros or fabricate; the homepage never had a holders area, so none is added.
- [x] Forward and reverse pools are both displayed from the meme token's perspective. The USD price cannot simply be inverted; market cap, FDV, price change, and buy/sell counts stay `null` when the target token's corresponding field is missing.
- [x] candles are requested by full token address first, and the actual denomination and direction are checked. The Run 3 order is Bankr → GT → CoinGecko, at most once per source; a legitimate empty Bankr response does not call CG, GT has a circuit breaker of at least 15 minutes, and CG is bound by the candles subquota; OHLC, time, and dedup validation are kept, and no artificial candles are filled in.
- [ ] trades determine side from the from/to addresses, and dedupe by chain/hash/logIndex when logIndex is explicit or inferred from the provider id; unknown formats fall back to chain/hash/provider-id. The id segment has not been verified against receipts, and the same-shape RH format exists only as fixtures. The 8/18-decimal fixtures are done, and 11 real normalized trades from a nonregistered Base pool pass; the nonempty Robinhood trade list still lacks real acceptance, so this stays unchecked. No new raw-integer amount channel was added; Demo's already-normalized amounts are not scaled again.

Stage gate: the three ordinary Robinhood features have real data paths; even if the original MuseVader still has no indexed records, it must no longer receive the fixed "feature not configured for the whole chain" error. Without a positive sample, the new integration cannot be proven successful.

### P4: Close out gaps that providers cannot cover

This stage is triggered by actual gaps; do not build an indexer in advance, and do not skip unresolved items and then claim completion. The collection options below are only design and feasibility checks; any new collector, resident job, paid service, or runtime permission requires separate explicit authorization.

- [x] If free/existing holder sources cannot cover it, first compare available hosted APIs. The CoinGecko Pro top_holders docs list Base and Robinhood, but it requires Pro auth and is in Beta; verify the target token, update frequency, amount units, and actual plan entitlements before proposing a cost option, and do not assume access is already available.
- [x] If on-chain trades are proven to exist but all verified providers still lack the history, propose a collection plan scoped only to this site's registered pools: fixed start block, persistent cursor, reorg rollback, idempotent event keys, per-run/per-day request caps, and a recovery method.
- [x] A standalone collection plan must first be proven feasible within the existing Alchemy limits and budget; otherwise, make a service-tier or architecture change an explicit dependency. Do not quietly relax the primary RPC limits or let the browser scan the chain.
- [x] If holders are instead rebuilt from Transfer events, the rebuild must cover the full history and mint/burn, and reconcile balances and supply at the same reference block. A partial scan cannot claim a total holder count or a global Top 10.
- [x] On-chain reads may only produce provable quantities. Without a reliable contemporaneous USD reference, do not use today's price or the opening valuation to generate historical USD volume, market cap, or candles; unproven fields stay `null`.
- [x] Do not treat the v4 PoolManager's shared token balance or active liquidity as single-pool TVL; do not treat the router / Swap sender as the real end trader. Market cap and FDV keep their respective supply definitions.

Stage gate: every gap has a verified data source, or the pending dependencies and remaining work are clearly listed. Honest messaging with an unresolved data dependency is a degraded improvement, not a full fix.

#### Run 2 / P4 evaluation (2026-10-15; no purchases, new service integrations, or collectors built)

| Gap / option | Impact and cost | Recommendation and convergence criteria |
| --- | --- | --- |
| Blockscout PRO API free key | The general official docs list a free tier of 100K credits/day and 5 RPS, no credit card; a server-side `proapi_` key, accessed via `https://api.blockscout.com/{chain_id}/api/v2/...`. The Base-specific page, however, explicitly lists plans starting at Builder $49/month, so the docs are inconsistent about plan terms. The Robinhood-specific page explicitly lists 4663 and the free tier, but there is no key this round and the target token is unverified | First have a human confirm the free tier's actual entitlements on both chains, then use info/holders for one full token per chain to verify count, Top10, amount units, contract flags, and update time. Documented chain support does not substitute for target coverage. H1 has rejected integration this round; the Blockscout market fetching and parsing code is deleted, and no configuration or provider abstraction is added |
| CoinGecko Analyst holders / long-history trades | In Run 1, Demo returned 401 for holders and 30d trades; Analyst lists at $129/month, or $103.2/month billed annually, and actual target coverage is still unknown | First have the provider check the target token/pool and all required fields; do not buy, and do not assume a plan upgrade will necessarily fill the gaps. holders has been ruled not provided for now by H1 |
| Do not provide holders for now (H1 ruled and implemented) | Subscription cost $0; count, Top10, contract flags, and index time are all unavailable; no PRO registration, no Analyst purchase, no Transfer index | `server/market.ts` returns `source_not_provided` directly; `TokenMarket.tsx` is statically unavailable with no request; the script accepts this explicit 503 contract; old snapshots are kept but not read. Restoration requires new evidence, and the degradation is not treated as data restoration |
| Base registered pool B1 positive sample | The original pool's index is still empty / core values null; nonempty parsing of the nonregistered KAI/NVDAc only verifies code and contributes nothing to registered-pool acceptance | Do not manufacture trades. Wait for a traceable existing Swap hash or organic history in the original pool, then spot-check through an approved read-only channel. The production blocker from the missing secret is listed as a separate release step |
| R3 long-history trades | The exact-pool Swaps of the October 8 historical canary have been independently verified; the free endpoint's default 24h empty list does not cover that history. Available six-interval candles do not mean the trade list has long history | First decide whether the product needs recent indexed data or full history. Keep the coverage limitation; do not treat a 24h empty array as never traded |
| Registered-pool-only collection design | Backfilling from R3's first known Swap block 83223147 to about block 88M at only 10 blocks/request needs about 500K requests; the 20-request evidence budget makes this infeasible, and there is no full start point for the original pool yet. Service cost was not measured, so no fake quote can be given | Do not build for now. The candidate design covers only fixed registered pools and proven start points, with a persistent cursor, idempotent chain/txHash/logIndex, reference block hash, reorg rollback to the last confirmed cursor, a fixed per-run/per-day budget, and resume after failure. It must first be proven feasible within the existing Alchemy entitlements and budget; do not raise the public RPC limits, switch the primary RPC, or let the browser scan the chain |
| Transfer rebuild / historical USD | Partial Transfers or shared PoolManager balances cannot give a global holder count / single-pool TVL; without a contemporaneous USD reference, USD candles cannot be rebuilt | If a design is separately approved, require full mint/burn/Transfer history and reconciliation of balances and supply at the same reference block; with no USD reference, values stay null. sender/router is called only the transaction sender, without inferring the end trader |

Official sources (documentation snapshots, not target measurements): [PRO general free tier](https://docs.blockscout.com/devs/pro-api), [PRO auth and routes](https://docs.blockscout.com/devs/pro-api-responses-and-routes), [Base plans](https://docs.blockscout.com/base-api), [Robinhood support notes](https://docs.blockscout.com/robinhood-api), [CoinGecko holders](https://docs.coingecko.com/reference/top-token-holders-token-address), [CoinGecko pricing](https://www.coingecko.com/en/api/pricing). This round only evaluated; no credentials were sent to providers, no accounts were created, and no resident processes were added.

### P5: Unify homepage and detail page status, source, time, and cache

Touches: `src/components/TokenMarket.tsx`, `src/components/TokenCard.tsx`, `src/lib/token-card-market.ts`, `src/lib/market.ts`, `server/market.ts`, `server/snapshots.ts`.

- [x] Homepage ordinary Robinhood cards use the implemented batch summary path to avoid repeated per-card requests; the homepage and detail page reuse the same snapshot for the same metric.
- [x] Show loading, index returned no records, not indexed, request unavailable, and stale snapshot separately. Say "no on-chain trades" only when supported by on-chain verification with an explicit scope; an empty array only says the current index/interval has no records.
- [x] summary, candles, and trades use their own real source and fetchedAt; holders is statically unavailable. The homepage info bar no longer hard-codes CoinGecko or borrows MUSEGOD's time, and shows loading on its own while configuration has not arrived; Run 5 added visible per-row status/source/fetch time to the default list and a CoinGecko API attribution link based on the sources actually displayed, with the same attribution on the detail page (C3/B1 corrects the earlier check, which held only for the grid). Fetch time does not masquerade as last trade time, and a failed refresh does not change old data's time to now.
- [x] Keep the existing bounds of a shared 15-minute snapshot and stale snapshots of at most 24 hours. The new cache identity includes chain/mode, token, pool, quote, section, and interval; parsing-semantics changes isolate old keys that are no longer trustworthy, without deleting historical records.
- [x] Cache hits consume no external quota; identical requests are coalesced, concurrency and fallback counts are limited, intervals load on demand, holders makes no requests, and rate-limit backoff is honored. Extending the homepage must not create N+1 requests or let multiple instances bypass the budget.
- [x] A failure in one section, token, or chain does not clear other valid data; chain switches, pool changes, late responses, and forks must not mix data.
- [x] Product messages are in English and describe only the data status users need to know; specific internal failures stay in sanitized diagnostics.

### P6: Verification, documentation sync, and follow-up release

- [x] For new behavior, first write meaningful failing tests, then fix. Extend the existing market / robinhood-market / worker-market / token-market-network / token-card-market tests; do not copy the implementation into assertions.
- [x] Coverage matrix: both chains, forward and reverse pools, 8/18-decimal quotes, token and pool granularity, wrong identity, real zero/null/empty array, 401/403/404/429/timeout, partial fields, fallback after Bankr/GT/CG failure, empty fallback not overwriting a nonempty snapshot, aggregated reasons, GT circuit breaker and local backoff, candles subquota, storage/program errors, provider id decoding/unknown formats, stale snapshots and expiry, concurrency, and cross-chain cache.
- [x] Verify MUSEGOD's separate route, fixed identity, dedicated cache, one-minute refresh, and unknown-FDV semantics; ordinary-token integration must not override this path.
- [x] Run the affected tests first, then `npm test`, `npm run build`, and `git diff --check`. Worker egress and JSON/redirect/timeout behavior must have native Worker boundary verification.
- [x] Adjust the existing read-only acceptance script: explicitly accept chain / token / pool, support real empty history, and distinguish fixture, real API, and on-chain evidence; do not require the first token to have trades, and do not pass off a skip as a pass. Run it directly, not through the wrapper that loads the real `.env`.
- [x] Local browser acceptance: homepage and detail desktop/390px, light/dark, chain switching, six intervals, trade filters, holders, stale snapshot and recovery are in Run 4; after the Run 5 commit, list B1 and actual-source attribution were fixed and re-verified, with spot checks of R3 1h/MUSEGOD/holders on both chains. Real data and fixtures are clearly separated, with no real wallet/production acceptance; data gaps such as Base positive market data and RH nonempty trades remain unchecked in P1/P3/P4.
- [x] Check off implementation results in this plan, and update `docs/SPEC.md` and the README where needed, removing the "ordinary Robinhood not supported" description that the implementation has superseded; keep limitations that still genuinely exist.
- [x] Round 1 independent reviewer read-only review is complete; the Run 3 fixer verified and fixed C1–C11 without changing RPC or runtime permissions.
- [x] Independent re-review: Round 2 requested changes including C3/R2-1; after the Run 5 fixes, Round 3 (claude accept) concluded ACCEPT with 0 new findings.
- [x] Release (authorized by owner 2026-10-15): before release, recorded the build / Worker version on both domains and the runtime controls on both chains; released `50d5047` through the existing pipeline; build identity, live API, and browser were all accepted on both domains, see "Release and online acceptance".
- [x] Rollback points recorded (no rollback performed): Worker `27772523-6fde-4b12-972c-e4c84f5f8d52` (tag `57624e9`, build-38708671686-1, no CoinGecko secret); the intermediate version with the secret configured `e0e9e577-b39f-4cf8-870b-87b4c00ef2fd` (same code). After a rollback, verify both domains, the API on both chains, data status, and the existing runtime controls; do not restore old caches already judged to be wrong-chain/wrong-pool; a code rollback does not automatically delete the secret.

## Delivery record

During implementation, record each stage's conclusions and evidence paths in this file; do not write a second spec. Provider probes and API response summaries keep only the minimum necessary sanitized records; Run 2 changed business code and the local acceptance script, but not production configuration, deployment, or runtime permissions.

### Run 1 / P1: 2026-10-15, read-only evidence gathering; stage gate not passed

Scope basis: `.superpowers/sdd/market-data-reliability/brief-common.md` and `run1-brief.md`. Report: `.superpowers/sdd/market-data-reliability/run1-report.md`; all evidence below is under that directory's `evidence/`, which holds gitignored local collaboration artifacts, not a second spec.

**Production baseline (observed fact)**: the full catalog has 1 Base and 3 Robinhood ordinary tokens, including the hidden Base Musegod; for each token, summary, six-interval candles, trades, and holders were read once, and the batch was read once per chain. Of the 36 detail responses, 12 were HTTP 200 and all had empty candles, and 24 were HTTP 503; the Base batch was HTTP 200 but its only row was `summary:null,status:unavailable`, and the Robinhood batch was HTTP 503. All token/pool/quote, source/fetchedAt/status/errors, and raw responses are in `catalog-*.json`, `production-baseline.json`, and `production-*.json`; HTTP 200 or an empty array cannot be taken as a successful fix.

**Base cause (configuration fact and same-version reproduction)**: `worker-secret.json` has no `COINGECKO_API_KEY`, and the committed vars do not configure it either; the active version `27772523-6fde-4b12-972c-e4c84f5f8d52` has source tag `57624e9ec193fb15f53d264efe9a0cff7af090cb`. When the key is missing, the existing `MarketReader` fails before quota / fetch, and the original cause `The CoinGecko Demo API key is not configured` is swallowed by Snapshots; `missing-key-local-reproduction.json` confirms this order in an isolated reproduction with no network and no production storage. Neither the actual Worker secret nor the active plaintext vars values were read, and no unmasked production exception was captured; the conclusion rests on secret configuration evidence, the deployed source, the committed vars, and the same-version reproduction.

**Auth, quota, and upstream (observed fact)**: a local Demo key is configured; the original Base pool's summary/trades/1h USD/1d USD/1h quote all returned 200 and passed the existing parsers, and the 32-byte v4 pool identity and meme18/quote8 decimals metadata are correct. But core market values are null and trades and candles are empty, so this cannot serve as a positive sample. The single Supabase quota GET returned `rows:[]`; the daily/monthly 300/9000 caps were not observed to be reached; the local URL matches the committed Worker URL, but this is not evidence from independently reading the active Worker variables. Demo `/key` returned 401/10005, so the provider's remaining quota is unknown. The local key does not necessarily equal the Worker secret. See `cg-8453-MUSEGOD-*.json`, `supabase-quota-single-read.json`, `supabase-project-binding.json`, and `cg-key-usage.json`. No quota RPC was called this round.

**Holders and Worker boundary (observed fact)**: sampled local Blockscout token/holders requests for Base and Robinhood all got a 403 challenge; one actual egress request for Base holders from an unbound temporary Cloudflare remote-dev Worker also got a 403 HTML challenge. This probe was not treated as a result for the production Worker or a Robinhood Worker. CoinGecko Demo returned 401 for top_holders of the target tokens on both chains, explicitly requiring Analyst or higher; there was no real positive holders response at all. See `blockscout-local-*.json`, `blockscout-worker-egress.json`, `egress-probe-persistence-check.json`, and `cg-*-holders.json`. Adding the Demo secret will not automatically solve holders.

**Samples, identity, and coverage (facts and open items)**:

- The Base catalog has only the original Musegod/NVDAc pool; USD/quote candles and trades are all empty, so there is **no positive sample**. This pool can serve as an indexed empty-history sample, but it cannot be said to have no on-chain trades.
- The CoinGecko exact pool summary for Robinhood MV2C has price/FDV/liquidity (market cap null), two 1h USD candles, one 1d candle, and two quote candles; 24h trades are empty, and the 30d query returned 401. There is not yet a complete positive sample with a trade hash that has been independently spot-checked, and launch/fee/settlement hashes are not passed off as Swaps. MuseVader/CLAWGOD can serve as indexed empty-history samples; the old October 14 scan is not extrapolated.
- Measured CoinGecko network ids are `base` / `robinhood`; MuseVader's summary is a reverse pool, and the other two RH pools are forward. The existing summary parser hard-codes `base_`, so applying it directly to RH would reject the identity; RH candles with a full token parameter pass identity parsing. Actual decimals: Base meme18/NVDAc8, RH meme18/MUSEGOD18, WETH18, COST18.
- Bankr's target discovery/stats/swaps all returned 404 (including a recheck of the existing path with canonical lowercase and no chain); the MuseVader/CLAWGOD chart is a legitimate empty with identity; the MV2C chart is only `{ohlcv:[]}` with no pool/pair, and the existing parser rejects it. The dedicated MUSEGOD summary/trades logic cannot be applied directly.
- GeckoTerminal locally had repeated transport failures with no HTTP response, curl failed TLS, and the website was also unreachable, so that approach was stopped; RH sections and holders have not been measured, so there is **no verified backup source**. The CoinGecko shared index was not treated as evidence of GT reachability.
- In the USD/quote comparison, both are empty for Base/MuseVader/CLAWGOD; for MV2C both are nonempty with matching times. No qualifying sample was found with "trades independently proven, quote has records, but USD is empty", so missing USD valuation cannot be determined. The gaps above correspond to the unchecked P1 items.

**Stage gate (no item passed)**:

| Chain / section | Primary source or candidate | Verified backup source | Remaining gaps |
| --- | --- | --- | --- |
| Base summary | CoinGecko (empty core market data parses) | None | Worker Demo secret, nonempty positive sample |
| Base candles | CoinGecko (1h/1d legitimately empty) | None | Worker secret, real nonempty interval, GT reachability |
| Base trades | CoinGecko (24h legitimately empty) | None | Worker secret, existing trade hash with independent receipt, history coverage |
| Base holders | Existing Blockscout failed in measurement | None | Worker 403; Demo top_holders 401; data source decision |
| Robinhood summary | Candidate CoinGecko (MV2C nonempty) | None | Chain prefix/reverse identity, Worker auth/shared budget, complete trade sample |
| Robinhood candles | Existing Bankr→GT; candidate CG has nonempty MV2C 1h/1d | No nonempty backup source | Bankr lacks identity; GT unverified; a new CG path needs its own scope and six-interval verification |
| Robinhood trades | Candidate CG verified only as 24h empty; Bankr target 404 | None | Positive trade, independent receipt, access terms for longer history |
| Robinhood holders | No usable primary source | None | Local 403, RH Worker egress unverified, Demo 401, target coverage unknown |

**Pending decisions and Run 2 boundary**: leave the Worker key configuration as a later, explicitly authorized release step; secret put/deployment is prohibited this round. For holders, first verify the hosted API against the full target token for count/contract flags/update time/units; Analyst's official monthly list price is $129 ($103.2/month billed annually), actual target coverage is unknown, and it must not be bought directly or assumed to require Pro. Once an allowed existing Alchemy read-only credential channel or a traceable existing trade record is available, spot-check within ≤20 requests, without manufacturing trades, widening the log range, or building a custom index. In Run 2 the commander may first explicitly schedule cause preservation, RH identity parsing, and P5 status improvements; until the source and sample gates are met, add no unverified fallback and claim no full restoration. Specific files, endpoints, identity rules, and bounded fallback conditions are in the Run 1 report; this round did not enter P2/P3/P5.

**Local verification and delivery**: `npm test` 1464/1464 passed (0 skipped, 0 todo); `npm run build` (two TypeScript checks and the Vite build) passed with only the pre-existing large-chunk warning; `git diff --check` and the staged diff check passed. The sanitization scan and local commit details are in this round's final report and `evidence/local-validation.json`. Only this plan was committed, with no push or deploy; source files, trading flows, MUSEGOD-specific semantics, and runtime permissions are unchanged, and rollback only involves reverting this round's plan-file commit, with no change to production state.

Official capability references (docs verified on 2026-10-15; not equivalent to the target pool passing measurement):

- [CoinGecko Pool OHLCV: target token, USD/quote denomination, empty-interval behavior](https://docs.coingecko.com/demo/reference/pool-ohlcv-contract-address)
- [CoinGecko Pro Top Holders: Base / Robinhood support, Beta, and auth restrictions](https://docs.coingecko.com/reference/top-token-holders-token-address)

### Run 2 / P2: local diagnostic implementation

Authority: Run 2 commander's decisions supersede the Run 1 implementation hold; production configuration and deployment remain prohibited. `server/market.ts`, `snapshots.ts`, `app.ts`, and `src/lib/market.ts` preserve stable sanitized reasons and HTTP status in unavailable/stale/batch responses. No provider body or private URL is exposed. Retry suppression retains the cause; 429 honors Retry-After and snapshot TTL.

Evidence under `.superpowers/sdd/market-data-reliability/evidence/`: `run2-p2-red.log` demonstrates two failing new tests before implementation; `run2-p2-test.log` passes 1466/1466 (zero skips/todos); `run2-p2-build.log` passes both TypeScript targets and Vite. `git diff --check` passes. MUSEGOD source remains unchanged.

`run2-gt-worker-egress.json`: four unbound remote-dev GETs (R3 summary/hour/trades and B1 summary) all returned HTTP 429. GT identity/nonempty coverage remains unverified; no new Base fallback is implemented. Production Demo secret and holders source remain dependencies; this stage is a diagnostic improvement, not restored production data.

### Run 2 / P3: explicit Robinhood data paths

`server/market.ts` selects CoinGecko network/prefix `base` or `robinhood` and the matching Blockscout host. Reverse summaries use only `quote_token_price_usd` for the target meme token; FDV/market cap/change/buy/sell counts remain null because those fields describe the provider base asset. Pool liquidity and USD volume remain pool-level values. No count inversion is assumed.

Historical Run 2 order was CoinGecko -> Bankr -> GT. Round 1 found quota starvation and empty-fallback snapshot corruption; this order is superseded by Run 3 Bankr -> GT -> CG and the candles subquota described below. The recorded R3 six-interval observations remain historical source evidence, not a guarantee of Worker availability. No Base GT fallback or production quota RPC was used.

Trade side derives from exact from/to addresses. Demo amounts are already normalized human units and are never scaled again. Run 2 inferred the logIndex segment from observed Base network/block/hash/segment/timestamp ids, without receipt verification. Run 3 retains explicit/inferred chain/hash/logIndex keys and falls back to opaque chain/hash/provider-id for unknown formats. Robinhood same-shape ids are controlled fixtures only; real nonempty RH ids remain unobserved. Fixture precision coverage is distinct from real supply/holder coverage.

TDD evidence: `run2-p3-red.log`, `run2-p3-trades-red.log`, `run2-p3-target.log`; full `run2-p3-test.log` 1469/1469 (zero skips/todos), `run2-p3-build.log` both TypeScript targets + Vite, diff check passed. `run2-r3-swap-proof.json` independently verifies Oct 8 exact-pool Swap receipts in two historical canary transactions, using 7 direct Alchemy reads including receipt/block timestamps, no logs scan. Candidate hashes came from the existing local canary journal. Its current digest differs from the tracked historical journal digest, so it is only a candidate locator; independent Alchemy receipts, manager/pool topics and canonical block timestamps are the evidence. These are historical canary test trades, not organic demand.

`run2-base-parser-proof.json`: nonregistered Base v4 KAI/NVDAc 18/8 pool has nonempty summary/trades. The 200-row hourly response contains conflicting duplicates and correctly fails closed; the same exact-token 30-row query passes (`run2-base-candles-30.json`). This is parser evidence only; registered B1 remains without a positive sample. Real raw evidence is retained, not trimmed into a fake successful response. Two-chain holders still have no verified positive source, and long-history trades/production credentials remain dependencies.

### Run 2 / P5 + P6 local: homepage, provenance, cache identity and acceptance

`src/lib/token-card-market.ts`, `src/App.tsx`, `TokenCard.tsx` and `TokenMarket.tsx` now use registered-address batches on both mainnets, retain independent per-row failures, and show each section's real source/fetch time. Chart attribution never borrows summary time, and trades no longer hard-code CoinGecko. Loading has no assumed provider. Empty history only describes indexed records; transaction sender is not claimed to be the final trader. `src/lib/api.ts` retains sanitized reasons for state messages; `server/app.ts` includes Retry-After so HTTP clients do not immediately retry known failures.

The shared `market:v2` cache identity binds deployment chain/mode, complete token, pool, quote, section and candle interval. Both summary routes share the same key. Old keys are retained and isolated; no history deletion or migration occurs. Frontend scope/key changes and the existing request cancellation guard prevent reuse after chain, pool, quote or period changes. 15-minute fresh / 24-hour stale and actual snapshot timestamps remain; MUSEGOD server source, dedicated keys and one-minute TTL are unchanged.

TDD logs: `run2-p5-red.log`, `run2-p5-source-red.log`, `run2-p5-batch-red.log`, `run2-http-red.log`, `run2-worker-timeout-red.log`. Native Workerd checks use controlled fixture upstreams, including manual redirects, JSON rejection, 429 backoff and injected timeout; they are not live provider evidence. The direct HTTP script explicitly accepts origin/chain/token/pool/evidence/output, loads no dotenv, records legal empty histories as contract observations, and exits incomplete for failed dependencies rather than skipping. `package.json` no longer wraps this script with `scripts/run.ts`. `docs/SPEC.md` and README now describe implemented RH paths and remaining dependencies.

P4 evaluation is recorded above. H1 now closes the holders product decision as intentionally unavailable; Base registered positive data, long-history trades and any future collector remain unresolved. Browser, post-fix independent review and publication gates remain unchecked for later runs.

Quota estimate (Run 3 supersedes Run 2): the current catalog has 1 Base pool and 3 RH pools; a cold homepage cache on both chains costs `ceil(1/30)+ceil(3/30)=2` CG multi calls / 15 minutes, a sustained demand of 192/day. MUSEGOD consumes no Demo quota; ordinary batches now refresh independently every 15 minutes, and card-list changes do not clear the snapshot wholesale.

Based on the observed source shapes (R1/R2 Bankr is legitimately empty with identity and GT provides nothing nonempty; R3 Bankr lacks identity and GT fails; Base is CG only), six intervals across four pools need `6*(Base+R3)=12` CG calls plus 4 for trades: with the homepage already prefetched, the total is 18 per 15-minute cycle (demand 1728/day), and when each of the four detail pages cold-starts its own single summary, the total is 20. R1/R2 do not call CG for any interval; R3's CG calls must first pass the candles subquota. If Bankr/GT fail for all RH pools, the worst-case demand is 24 candles + 4 trades + 2 homepage multi = 30/cycle (2880/day); with single-summary detail cold starts it is 32. Multiple instances, restarts, and address-group changes may cause extra misses; the actual site-wide upper bound is still constrained by the persistent shared budget of 300/day and 9000/month.

CG calls for candles on all chains first reserve `<shared scope>:candles` (currently `base:candles`) at 100/day and 3000/month, then reserve the original `base` shared budget. The existing text scope and RPC already support subscopes, so no migration is added; on Supabase both chains share `base:candles`, and SQLite isolates the subquota with a date-key suffix. candles take at most 100/day and 3000/month of the shared budget, so summary/trades together keep at least 200/day and 6000/month of capacity; this does not guarantee that every request succeeds or that capacity is reserved for summary alone. Cache hits are not charged, and concurrent requests for the same key are coalesced. Charging the subquota first means exhausted candles do not consume shared capacity for summary/trades; if the later shared charge fails, the one subquota unit already charged is wasted. No refund/migration is added, no upstream request is sent in that case, and this is not misdescribed as a single cross-scope atomic operation. Charging the shared budget first instead would keep wasting limited shared capacity after the subquota is exhausted, so it is not used. GT 429, or 503 + Retry-After, trips a circuit breaker of at least 15 minutes on this instance; successful responses ignore that header, and no wasted requests are sent per key; across restarts/multiple instances this is not a global GT circuit breaker.

Local rollback: revert the Run 2 commits in reverse order on this branch; production is unchanged. Reverting code alone does not delete new/old snapshots or change future secret/configuration state. Any later rollout must capture its actual production rollback point and honor the separate release gate.

Final local validation: `run2-final-test.log` passes 1479/1479, zero skipped/todo/cancelled; `run2-final-build.log` passes both TypeScript targets and Vite (existing large-chunk warning only); `git diff --check` passes. `run2-secret-scan.json` finds zero plaintext matches for the two permitted credentials across Run 2 evidence and the complete diff. `run2-r3-proof-binding.json` binds all target Swap logs to the pinned Robinhood PoolManager; `run2-chain-binding.json` independently confirms chain 4663. `run2-probe-persistence-check.json` confirms the temporary probe resource is absent. Final Run 2 request count: Demo 11 (5 Base, 6 R3 intervals), GT remote-dev 4, Alchemy read-only 8, production Supabase GET/write/quota RPC 0. No browser, push, deployment, signing, production control/configuration or collector change occurred.

Stage commits: P2 `ec1ffe0`, P3 `7579133`, P5/P4/P6 in this final local commit. Full Run 2 report: `.superpowers/sdd/market-data-reliability/run2-report.md`. Historical Run 2 result was NEEDS_DECISION for production secret/holders and positive registered Base/long-history gaps; H1 now settles holders as intentionally unavailable; local implementation and scoped validation are complete, full production restoration is not.


### Run 3: Round 1 findings and H1 local closeout

Authority: the commander's decision in `run3-brief.md`. C1–C11 have all been verified and fixed, with no disputed/deferred findings; H1 is an explicit owner product trade-off. Implemented on the server: source order / empty-fallback protection / reason aggregation / GT circuit breaker / 100-per-day, 3000-per-month subquota, handling of placeholder zeros for unknown USD, provider-id-compatible dedup, and Storage/Internal/backoff classification. Fixed on the frontend: source notes, independent 1/15-minute refresh, per-row identity preservation, MUSEGOD Pools link and one-minute note, refresh not obscuring existing data, and empty price record copy. H1 removes the holders upstream and cache, type/source inference, and frontend table/requests; route registration validation and the long Retry-After are kept, and the homepage never had a holders area. Old holders snapshots are neither deleted nor read.

TDD evidence: `evidence/run3-server-red.log` (new server tests initially failed), `run3-ui-red.log` (UI/script failures), `run3-card-hook-red.log` (after fixing the test harness, verifies that the original Run 2 source lacked the 15-minute timer), `run3-refresh-red.log` (the original source showed a loading banner over existing data); the rest are the corresponding green/target logs. Test runs used only isolated SQLite / controlled Supabase requests / controlled fetch / SSR / hook / Workerd fixtures; no real `.env`, external APIs, Supabase production GET/write/quota RPC, production configuration, or deployment. `server/musegod-market.ts`, RPC limits, contracts/trading/launch/fee rates/buybacks, and runtime permissions are all unchanged.

Specific test deltas, full checks, commits, and rollback are in this round's `run3-report.md`; the fix mapping has been appended to the "Round 1 fixer response" section of `claude-review.md`, with the reviewer's original text fully preserved. Follow-up independent re-review, browser, and production acceptance are still incomplete; the Worker Demo secret, a registered Base positive sample, and real RH nonempty/long-history trades do not go away because of local tests. Under the H1 limitation, any future restoration requires new evidence.


Run 3 final local verification: `evidence/run3-final-test.log` **1495/1495**, 0 fail/cancelled/skipped/todo (net +16 over Run 2); `run3-final-build.log` passes both tsc targets and Vite, with only the pre-existing large-chunk warning; `git diff --check` passes. The first full run found that the shared error classification affected MUSEGOD's source field; Snapshots now keeps the provider identity and classifies with an Internal cause, the original MUSEGOD tests are unchanged, and 51 targeted regressions and the full suite all pass. Protected paths such as `server/musegod-market.ts` show no diff against the starting point. Rollback: after checking later commits on this branch, `git revert HEAD` (only if HEAD is this round's `fix(market): address reliability review and disable holders` commit); do not delete historical snapshots/quota records; no production configuration rollback. The final local commit details are recorded in this round's report; status DONE refers only to the Run 3 authorized scope.


### Run 5: Round 2 fixes (before browser re-verification)

Authority: `run5-brief.md` and the still-valid Run 3 commander's decision. C3/B1: the list reuses the grid's `CardMarketStatus`, showing the actual source and fetch time per row, with loading/unavailable/Previous snapshot directly visible; unknown metrics on fresh rows remain dashes. The homepage info bar shows linked attribution based on the CG rows actually present, each detail section carries the same attribution, and the grid keeps a single detail link without nested links. Official attribution basis: [attribution guide](https://brand.coingecko.com/resources/attribution-guide), [API Deck](https://assets.coingecko.com/reports/API/CoinGecko-API-Deck.pdf), checked this round on 2026-10-15.

R2-1: after a snapshot write fails, the Snapshots instance keeps this return value until that key's TTL, and this hit takes precedence over the storage read, shared by summary/batch; 15 minutes for ordinary tokens and one minute for MUSEGOD, without repeating upstream or quota. This is not a cross-instance/restart guarantee. R2-2: the shared `marketFailure` classifies network and explicit program exceptions, and unknown exceptions use the neutral `upstream_unclassified`; app wiring injects a `marketFetch` with HTTP status for MUSEGOD. The source, fixed identity, dedicated keys, and one-minute semantics of `server/musegod-market.ts` are unchanged. R2-3: only 429 or 503 + Retry-After opens host backoff, and successful responses ignore that header. R2-4: removed the dead holders style `.market-table .chip`, kept the API client's message mapping for `source_not_provided`, and the frontend still does not request holders.

R2-5 checked the existing SQL: cleanup, backup, and restore are all strictly scoped and do not include `<scope>:candles` (currently `base:candles`). Subquota day/month rows are about 31+1 per month, no more than about 384 per year per shared quota scope, and they accumulate; restoring by the main scope does not restore the subquota, a new quota scope counts the subquota from 0, and the shared total limit still applies. This round does not change cleanup: the volume is small, and a new migration and changed production write semantics are not a necessary fix this round; any later operational cleanup needs separate authorization. No database operation was performed.

TDD: in `evidence/run5-red.log`, 8 of the first 75 tests failed, covering missing list status/attribution, repeated quota charges on write failure, MUSEGOD minute protection/HTTP boundary, network classification, and backoff on successful responses. After the fix, targeted 98/98 pass (including real Express routes, SSR, and actual hook regressions); full-suite, build, commit results, and browser coverage are filled in by later records.

Run 5 final pre-browser check: `evidence/run5-final-test.log` full suite **1502/1502**, 0 fail/cancelled/skipped/todo; `run5-final-build.log` passes both tsc targets + Vite (only the pre-existing large-chunk warning); `git diff --check` passes. The tests, after correcting the SSR attribute-name casing, were rerun against the original `aa0afdd` App: in `run5-ui-baseline-red.log`, 2 of 9 failed, confirming they still genuinely detect the missing per-row status/source/time and the incorrect info bar; the current source was then restored. The protected MUSEGOD-specific reader, alchemy-rpc, contracts, and supabase source show no diff against the starting point.

### Run 5 post-commit browser checks and wrap-up

Source commit `9d86fda` (`fix(market): resolve second reliability review and list provenance`); it first passed the full 1502/1502, build, and diff checks, then this round's isolated re-verification used the original Run 4 harness. The app was started without reading the project environment; the CG key was extracted only in-process, Vite disabled the project env, 127.0.0.1:4173, non-GET returns 405 (except local fixture controls), separate SQLite, no server/index/wrangler/production Store. Chrome DevTools MCP created a separate Chrome via this round's launch flag `--isolated`; the user's ChatGPT Chrome was not operated.

In the real list, all 3 ordinary rows show CoinGecko + their own Fetched time, and the featured row's separate Bankr/Pools time is not borrowed; the info bar has visible linked attribution. Unknown metrics on fresh rows are dashes. At 390px in dark mode, unavailable/quota and stale/Previous snapshot are visible, and after fixture recovery they return to Fetched; homepage grid and detail attribution are consistent. R3 real 1h shows 2 GT candles, CG summary price about 0.00000498192, market cap still unknown, and 24h trades still legitimately empty; the Base hidden notice and all-null/empty index stay honest and do not count as Base positive market data. MUSEGOD via the actual read-only proxy loads summary/candles/trades, all labeled with the Bankr/Pools link, and the minute note is kept; holders on both chains shows unavailable, with 0 automatic holders requests from the browser.

Evidence: `evidence/browser-run5/`, including DOM/screenshots/DevTools network, real provider raw text, and separate excerpts for fixture API unavailable/stale snapshot/recovery. `qa-summary.json` passes checks on 30 saved evidence items. Page at 390px: scrollWidth=clientWidth=390; the initial check mistook the width of flex boxes inside a horizontally scrollable table for text overflow, so it switched to real text Range bounds, and `mobile-status-text-layout.json` shows all status text within 390px, so no source change was needed. R3's first waiter timed out looking for "Chart" copy, but the actual component is Candles; screenshots/a11y/API independently prove 2 candles, and the waiter timeout is not treated as an API failure. The console shows only 2 automatic RPC POSTs rejected by the gateway (405), with no new uncaught JS exceptions; MUSEGOD burn/RPC is not claimed as accepted.

This round: 5 real CG Demo calls (≤20), GT 1, Bankr 1; 24 production read-only GET proxy calls, and the internal provider requests behind the proxy cannot be counted individually locally. Production writes, Supabase read/write/quota RPC, on-chain RPC, and wallet connection/signing were all 0. The fixtures are synthetic provider data + an isolated Store that rejects quota / sets the clock back 16 minutes, and cannot serve as proof of real trades or natural production recovery. The local key does not mean the Worker is configured. During the browser session the tracked diff was empty and the accepted source was still 9d86fda; no code was changed for QA.

`cleanup.json` confirms that all 8 process-tree members (including root) of harness 41482 and this round's separate Chrome root 41521 exited, nothing listens on 4173, and the user's Chrome keeps running. After re-verification only documentation records were added, and the full suite was not rerun since nothing else changed. The full Run 5 report and the item-by-item Round 2 fixer response are in the existing collaboration directory; the final documentation commit id is recorded in the report. Still pending: independent re-review, authorized production secret configuration, a registered Base positive sample, RH nonempty/long-history trade coverage, and the release gate. No production changes this round; local rollback reverts this round's documentation commit and 9d86fda in reverse order, without deleting historical snapshots/quota or changing production configuration.


### Release and online acceptance (2026-10-15, owner-authorized)

Pre-release record (20:05 Beijing time): both domains on `build-38708671686-1` / `57624e9`, Worker `27772523`; runtime controls on both chains are writesEnabled=true, signingPaused=false, controlRevision=1, with NFT mode on for Robinhood and off for Base.

Steps:

1. Piped the local Demo key into `wrangler versions secret put COINGECKO_API_KEY --tag 57624e9`, producing `e0e9e577`, deployed at 100%. The secret was configured first because release.ts requires the old and new versions to have the same secret set (`assertPreservedBindings`). That deployment did not include `--durable-objects-code-update-mode immediate`, so the DO stayed on the old instance and old-code requests still returned 503; the subsequent formal release updated in immediate mode.
2. Fast-forwarded master to `50d5047` and pushed; CI run 38732268647 succeeded, `build-38732268647-1`, Worker `cb269df2-9760-44c3-b1d2-030532fc549b` at 100%, tag `50d5047`.

Live API (single read-only pass; evidence is `release/online-api.json` in the collaboration directory):

| Item | Result |
| --- | --- |
| Build identity | build-info and `x-source-commit` on both domains are `50d5047` |
| Base B1 | summary, six-interval candles, and trades are all 200 fresh CoinGecko; metrics are null, candles and trades are empty (legitimately empty, not a positive sample). The original 503 is gone |
| Robinhood R3 (MV2C) | summary price 0.000004981916994; six-interval candles 20/5/2/2/1/1, source CoinGecko (Bankr identity missing, fallback after GT 429); 24h trades empty |
| Robinhood R1/R2 | summary and trades 200 (fields unknown/empty); candles are Bankr legitimately empty, with GT `rate_limited` / `backoff` reasons attached |
| Batch summary | 200 on both chains, fresh per row, source CoinGecko |
| holders | 503 `source_not_provided` for all four tokens, no upstream requests |
| MUSEGOD dedicated | Bankr fresh, 199 1h candles, 30 trades, unaffected |
| Runtime controls | Same after release as before |

Live browser (codex, chrome-devtools read-only, both domains): build identity, source and time on the homepage grid/list, linked CoinGecko attribution, hidden-token filtering, MV2C six-interval candles, dashes for unknown metrics, Base hidden-token notice and status, holders unavailable on both chains with no Blockscout requests, MUSEGOD Pools link and minute refresh, and 390px/desktop/dark and light themes all passed.

codex reported three "failures"; the commander's review conclusions:

1. For about 0.1–0.5 seconds after a chain switch, the old chain's title and token entries are still shown (market values already cleared, links carry the chain name). This release did not change catalog loading or chain-switch logic; it is a pre-existing transitional-state issue, a follow-up task has been opened, and it does not block this plan.
2. The homepage makes a MUSEGOD-dedicated summary request. This is the separate one-minute path the plan keeps, not a per-card N+1; the acceptance brief did not note this exception.
3. The `--isolated` flag check is an execution-environment detail: it was passed via command-line `-c`, while codex checked the config file. It does not affect the product conclusion.

Conclusion: online release acceptance within this plan's scope passed.

Remaining known limitations (not failures of this release):

- The registered Base pool has no real trades, so positive trade acceptance is not possible.
- Robinhood free trades cover only 24h.
- GT egress from the Worker keeps returning 429.
- holders are not provided for now per H1.

### Detail page H1 presentation amendment (2026-10-15)

Owner-approved on 2026-10-15: while H1 holds with no holder data on either chain and no restoration date, token detail pages omit the Holders tab and its unavailable block. Both feed cards are titled "Recent trades". The holders API still returns an explicit `source_not_provided`; its route and `scripts/test-market-http.ts` contract are unchanged.
