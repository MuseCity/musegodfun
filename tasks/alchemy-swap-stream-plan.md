# Own on-chain swap stream via Alchemy Custom Webhooks

Status: Run 2 review fixes implemented locally; Claude acceptance, reverse review and release pending (2026-10-16). Branch `claude/alchemy-swap-stream`, based on `1030b05` (master `6f7b475` plus its unpushed release record).

## Owner request (2026-10-16, translated)

After the zero-cost source evaluation, the owner chose to build our own swap stream: "ALCHEMY_NOTIFY_API_KEY is configured in .env, go implement it." The owner placed the Alchemy Notify (webhook management) token in the main checkout's `.env` as `ALCHEMY_NOTIFY_API_KEY`.

## Facts established before this plan

- Evaluation report: `.superpowers/sdd/market-source-eval/report.md`.
  - No free provider covers our V4 pools (CLAWGOD, MV2C, MVADER, Base MUSEGOD). Bankr and CoinGecko are accurate for MUSEGOD (Robinhood Sushi V3).
  - On Robinhood, an Alchemy WebSocket `logs` subscription delivered 5,005 PoolManager Swaps in 450 s (p50 0.74 s, p95 1.18 s), and `newHeads` arrived with no gaps.
  - Alchemy documents Custom (GraphQL) Webhooks for ROBINHOOD_MAINNET. Billing is 0.04 CU per delivered byte, with 30M free CU/month.
  - The existing RPC key is Free tier: `eth_getLogs` is capped at 10 blocks per call, so no historical backfill is in scope.
- Event signatures: V4 `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` topic0 `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` (topic1 = poolId); V3 `Swap(address,address,int256,int256,uint160,uint128,int24)` topic0 `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`.
- Contracts: Robinhood PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, Base PoolManager `0x498581ff718922c3f8e6a244956af099b2652b2b`, MUSEGOD Sushi V3 pool `0x071ee139277688d64b139af1e44f79a9acf12e53`.
- Runtime: each chain has one `LaunchpadRuntime` Durable Object (`worker/index.ts`, SQLite class) running the shared app; a 30 s alarm already exists. `scripts/release.ts` refuses a pending Durable Object migration, so no new DO class or binding is allowed in this release. Supabase migrations are applied separately and are avoided here.
- Live MUSEGOD swaps currently use a browser-direct Bankr Socket.IO stream (`src/lib/musegod-live*.ts`, `src/components/MusegodLive.tsx`, `socket.io-client`, CSP `wss://api.bankr.bot`). Bankr's realtime endpoint was unavailable (502) during the last online acceptance.

## Goal

Every registered pool on both chains, plus MUSEGOD, gets exact on-chain trades within about a second of the block. These feed Recent trades, the live price and candles from the moment the stream starts. Browsers receive them over our own same-origin connection, and the flaky Bankr socket is retired.

## Hard constraints

1. Trade safety is unchanged: no change to quotes, builders, wallet execution, approvals or the price-impact gate. Stream data is display-only.
2. Authenticity: only signature-verified webhook deliveries (`X-Alchemy-Signature`, HMAC-SHA256 over the raw body with that webhook's signing key, constant-time compare) are accepted. Payloads are schema-validated, bound to the expected webhook id, network, contract addresses, topic0 and registered pool set. Anything else is rejected without storage side effects.
3. Market honesty:
   - Our data is labelled "On-chain · Alchemy" with its own time.
   - Forward coverage is labelled "On-chain · Alchemy since <start>"; it is not a completeness claim. Provider records keep their source, including records after coverage begins.
   - No backfill is fabricated, and no zero-filling.
   - USD values only come from a verified quote-asset USD price with its own source and time; otherwise prices show in quote-asset terms or as unavailable.
4. Reorgs and duplicates: trades are keyed by chain, transaction hash and log index, and remember their block hash. Before final verification, a redelivery for the same block number with a different block hash replaces that block's trades. After a 2-minute delay, check each distinct retained swap block once using `eth_getBlockByNumber`; remove orphaned rows even if the canonical replacement has no matching swap. Persist completion. `sequenceNumber` and retries never double-count. Deeper reorganizations after that one verification are outside this policy.
5. Cost and load:
   - The filters are narrow, with `skip_empty_messages: true`.
   - No polling of Alchemy for logs, and no `eth_getLogs` scans. Finality checks are bounded to 10 distinct blocks per alarm; successful checks are persisted and never repeated. Expected normal RPC volume is approximately distinct blocks containing our retained swaps per day (at the evaluation pace, at most about 59/day for MUSEGOD, plus V4 activity). Existing RPC transport 429 retries can multiply failed attempts by up to four; failures remain pending for a later alarm.
   - The Notify API is called only when the registered pool set changes, plus at most one verification per chain per day.
   - Storage per chain is bounded, with documented retention.
   - The webhook route is exempt from browser challenges but has its own size and rate bounds.
6. Secrets: `ALCHEMY_NOTIFY_API_KEY` is read from env only. It is never logged, returned or stored in evidence. Signing keys are fetched through the Notify API and kept only in Durable Object storage, never in responses or logs. Production needs a new Worker secret `ALCHEMY_NOTIFY_API_KEY`, added at release with the owner's approval and before the push, per the release secret-set rule.
7. No new Durable Object class, binding or migration. No Supabase migration. No new third-party service beyond Alchemy.
8. Replacing Bankr live: remove `socket.io-client`, the Bankr socket modules, their tests and the CSP `wss://api.bankr.bot` entry in the same change. Bankr REST stays as a provider source.

## Items

### S1 Webhook receiver, verification and storage

- `POST /api/chains/{4663|8453}/webhooks/alchemy`, routed to that chain's DO. The raw body is preserved for HMAC. Body limit sized to Alchemy payloads (document the bound). Exempt from Turnstile challenge and the browser cross-site Origin rule, and only for this path.
- Decode V4 and V3 Swap logs into trades: pool, block number and hash, block timestamp, transaction hash, log index, amounts, `sqrtPriceX96`, tick and direction. Derive the coin price in quote-asset terms from the swap itself, with exact decimal handling.
- Store in the chain DO's SQLite storage through an injected adapter (the Node server and tests get an in-memory or file adapter). Index `(pool, block, log index)`, `(pool, time, block, log index)`, time and block lookups. Delivery writes use indexed lookups only. Summary reads 1 latest row, Recent trades reads 30, and candles stream only the requested 200-bucket time window into bounded memory. Retention targets newest 50,000 trades or 400 days; the existing alarm prunes at most 500 trades and 500 block tombstones per run using persisted counts, never per delivery. A backlog of at most 2,000 additional rows/tombstones may exist between alarm runs (hard ceiling 52,000 each); further deliveries receive retryable 503 without partial writes and an explicit gap signal prompts debounced client recovery. Finality checks begin after 2 minutes, at most 10 distinct stored swap blocks per alarm, and persist canonical hash and completion.

### S2 Webhook lifecycle via the Notify API

- Verify the Notify API's real capabilities from Alchemy's docs and read-only calls: list team webhooks, create GraphQL webhooks, update or replace a GraphQL query, and read signing keys.
- Each chain's DO owns its webhook. The GraphQL query has a V4 filter (PoolManager, Swap topic0, topic1 OR-list of the chain's registered poolIds) and, on Robinhood only, the MUSEGOD V3 filter (pool address, V3 topic0). Use one webhook per chain if a single query can hold both filters; otherwise use two.
- Reconcile in the existing chain alarm on pool-set changes or missing state; a request may schedule startup reconciliation and registration may schedule a changed-set reconcile. Successful same-set verification runs at most daily. Failures use persisted 1-minute exponential backoff capped at 1 hour; a different pool set resets it. Persist a short pre-call attempt lease so eviction retries safely. Store and verify the replacement signing key before immediately sweeping every non-current team webhook on this chain's exact callback origin/path, regardless of its set query. On the next reconcile the same sweep resolves timeout-after-create, eviction-after-create and verification failures. Keep at most the current and immediately superseded signing key; the latter expires after 5 minutes, while its remote webhook is deleted immediately.
- Operator CLI (`scripts/alchemy-webhooks.ts`) lists sanitized webhooks and runs a dry-run diff only. Reject `--apply`; there is no production reconcile/operator HTTP endpoint. The Notify token is sent only directly to Alchemy by server-side reconciliation or read-only CLI listing, never in an incoming Worker request.

### S3 Serving our trades, price and candles

- Recent trades for every registered pool (both chains) and MUSEGOD merge our trades with provider trades, deduplicated by transaction hash and log index. Ours are authoritative where they overlap.
- Headline live price: the latest stored swap's price, when it is newer than the provider summary. If no retained own row exists, preserve a valid provider summary. Store quote-unit prices only. At read time convert using an identity-checked current quote-asset USD cache, refreshed at most once per 5 minutes per asset, with a dedicated budget of 2 token reads per minute per chain and a 3-second timeout. This display reader never touches the payment reader, shared LI.FI quote budget or shared backoff and never runs in delivery. Broadcasts may peek its cache without I/O. Missing USD affects that response only, with quote-asset units or USD unavailable; the chart unit is never pinned by a historical missing price. Current-quote conversion is not historical USD valuation.
- Candles: keep every provider candle as the base wherever returned. Own trades may add/update only the in-progress bucket strictly newer than the provider's last bar, and only in compatible units; otherwise keep the provider bars. If no provider returns bars, build the requested window from own trades with coverage start. No historical provider bar is replaced, no double counting or zero filling. A current USD quote is applied consistently across one requested window.
- Provenance shows each part's source and time.

### S4 Same-origin realtime push (replaces Bankr live)

- `GET /api/chains/{id}/market/stream?pool=…` upgrades to a WebSocket accepted by the chain DO with the hibernation API. New verified trades for that pool are broadcast as validated JSON. Admission accounting must not hold request slots for open sockets.
- The client applies validated pushed rows directly to Recent trades, price and the latest candle; dedupe/watermarks prevent replay volume. Normal pushes cause zero REST reads. Late/out-of-order newly stored logs and storage backpressure emit an explicit gap signal; reorgs emit their own signal. Only explicit server reorg/gap signals schedule a section refresh: 5–10 second debounce/jitter, at most once every 30 seconds per tab, surviving remounts. Preserve one connection per tab, hidden disconnect, capped backoff, polling fallback and "Live · On-chain" only after a value-changing event. Applies to both chains and MUSEGOD. Stream admission groups IPv6 by /64 (IPv4 by address), caps 8/client and 128/chain, and reserves pending upgrades synchronously before pool lookup.
- CSP: verify whether `connect-src 'self'` covers same-origin `wss:` in the supported browsers. Add explicit same-origin `wss://` origins only if required, and remove `wss://api.bankr.bot`.
- Remove the Bankr socket path entirely (code, tests, dependency, CSP, docs mention in prior plans via a dated note).

## Out of scope

Historical backfill (needs a paid Alchemy tier); paid data providers; trade execution changes; holders.

## Verification and acceptance

1. TDD:
   - Signature verification: valid, invalid, missing, and wrong webhook id.
   - Payload schema, decoding of V4 and V3 Swaps with real logs (taken from real receipts of known MUSEGOD trades and recent V4 swaps, fetched with the RPC key within the 10-block limit or via `eth_getTransactionReceipt`), price math, reorg replacement, idempotency and retention.
   - Notify reconciliation, using a mocked Notify API that follows the documented shapes.
   - Merge and boundary logic, the stream broadcast and client lifecycle, and the CSP.
2. Read-only Notify check before release: list webhooks with the real token (no create, update or delete). Record the shape, never the token.
3. `npm test`, `npm run build`, `git diff --check`, Han scan; the built bundle no longer contains `socket.io-client` or `api.bankr.bot`.
4. A local end-to-end run in the Node server or a test harness: a signed synthetic delivery built from real logs leads to storage, the REST merge and a WebSocket broadcast to a test client.
5. Cross review: claude review → codex fix → claude accept, then codex review → claude fix → codex accept.
6. Release, with owner approval: add the Worker secret first, push, let the DOs create and reconcile the webhooks, then do online acceptance. Online acceptance means the webhooks are listed and active, a real MUSEGOD swap arrives and is shown live, and V4 pools are registered.

## Dated conductor decisions

### 2026-10-16 - Run 2

- C1-1/C1-2: windowed indexed storage and alarm pruning; direct client push application with exceptional debounced recovery only.
- C1-3/C1-4: remove the operator endpoint and apply CLI; retry failures with capped exponential backoff, reset on changed pool set or success.
- C1-5/C1-10: after replacement identity verification and key persistence, immediately delete superseded and same-callback orphan hooks. Resolve uncertain creations on the next reconcile sweep.
- C1-6/C1-11: raw-byte HMAC before payload parsing against at most two keys; unverified per-source buckets cannot spend authenticated slots/rate. Atomic socket reservations and IPv6 /64 caps.
- C1-7/C1-12: quote-unit storage, response-time USD conversion with its own cache/budget and no delivery I/O; no persistent chart-unit decision.
- C1-8/C1-13: own-wins Recent trades union, provider candle base with current-bucket additions only, explicit forward coverage and provider-summary fallback.
- C1-9: once-only, persisted block-hash verification after 2 minutes, bounded per alarm. This replaces Run 1's unverified assumption that empty canonical replacements will arrive as webhooks.

## Delivery record

### Run 1 - 2026-10-16

Historical implementation record; lifecycle, admission, pricing, serving and push behavior below is superseded by the Run 2 conductor decisions.

- S1-S4 implemented locally on `claude/alchemy-swap-stream`; this plan is included in the first implementation commit. The exact commit and detailed results are recorded in `.superpowers/sdd/swap-stream/run1-report.md`.
- Official research and read-only Notify evidence: `.superpowers/sdd/swap-stream/evidence/notify-api.json`. Two real `GET /api/team-webhooks` calls returned HTTP 200 with `{data: []}`; one was the operator dry run. No live Notify mutation was made. The public Custom payload puts the decimal-string sequence in `event.sequenceNumber` and does not promise a network field; the receiver binds its id to the stored Notify network and rejects explicit conflicts.
- The documented update endpoint changes name/status only. Replacement uses deterministic callback-set URLs, persists the new signing key before retiring the old one, retains old verification keys for 24 hours, and does not depend on an undocumented `name` in list responses. Failed same-set attempts and daily verification are limited to once per day; a changed set can reconcile immediately. Single-query aliases and actual empty-message suppression still need Alchemy's release acceptance.
- Fixtures: 7 real Alchemy RPC calls, including one exact latest 10-block PoolManager control window and one known MUSEGOD receipt. Three V4 control logs and one V3 log are retained in `tests/fixtures/alchemy-swaps.json`. Control logs do not prove a registered V4 target traded. No subscription or historical scan ran.
- Ingestion uses a 1 MiB raw-body limit, 600 attempts per minute per chain, 8 concurrent receiver reads, and a 10-second Worker body deadline. Only the chain-qualified webhook receiver bypasses browser Origin/challenge enforcement. Operator reconciliation requires the Notify bearer token and retains ordinary ingress enforcement. Neither route exposes keys. Node uses an injected in-memory adapter; production ownership and persisted keys remain in the existing chain DO's SQLite tables.
- Retention: newest 50,000 trades or 400 days, whichever is smaller; block tombstones are also capped at 50,000. Pruned block floors prevent old retries resurrecting removed history. Coverage begins with the first accepted swap block, and advances conservatively when retention removes records. Reorg replacement can remove a block even when the new canonical block has no matching swaps; webhook generations prevent retiring callbacks undoing newer canonical data.
- Serving preserves provider records before coverage and makes verified records authoritative within coverage. Candle boundary buckets are replaced once, without zero filling. Quote decimals and raw amounts use integer arithmetic; ratios retain up to 96 decimal places. USD requires the existing identity-checked, unexpired LI.FI payment-price cache within 60 seconds of the swap. Otherwise the headline, trade and candle use the quote asset. Older USD candles remain separately available and visible when units differ. Provider statistics retain their source/time label.
- Same-origin push uses the existing DO's hibernation API, with 128 sockets per chain and 8 per client. Open sockets bypass HTTP slot accounting. Large block broadcasts use batches of at most 200 trades. The client validates pushes and coalesces them into independent REST section reads, so one committed server merge handles reorg removals and interval changes. It disconnects while hidden, caps reconnect backoff at 60 seconds, continues polling when unavailable, and marks Live only for a visible value change. This adds a same-origin REST round trip after each coalesced push; block-to-screen latency is unverified in production.
- Bankr's browser socket modules/tests, Socket.IO dependency and remote CSP origin are removed; Bankr REST remains. L4 in `tasks/live-market-price-impact-plan.md` has a dated supersession note.
- Required verification, browser evidence, deviations and local commit are recorded in the run report. Cross-review and owner-approved release remain pending. No secret command, push, deployment, wallet action, quote POST or production write was performed.

### Run 2 - 2026-10-16

- Verified C1-1 through C1-13 against the code; accepted all findings and implemented the dated conductor decisions above. Each behavior fix has a pre-fix failing regression, retained under `.superpowers/sdd/swap-stream/evidence/run2/`.
- Regression coverage includes a 12,000-row SQLite window/query-plan check; zero-REST push bursts; raw-byte authentication and isolated ingress; uncertain webhook creation cleanup; capped/reset backoff; independent USD caching and response-unit recovery; provider merge/source fallback; persisted finality across adapter reload; and atomic IPv6/global stream admission.
- The Node harness verifies signed real-log fixture delivery to SQLite, an actual WebSocket and direct client projection. The Worker harness uses mocked Notify/RPC/services, rejects the removed operator endpoint, and verifies persistent trades after reload. These are local synthetic-delivery checks, not live Alchemy receipt or production acceptance.
- Final checks and local commit are recorded in `.superpowers/sdd/swap-stream/run2-report.md`. Claude acceptance, reverse review and owner-approved release remain pending. No Notify mutation, production write, wallet action, secret command, push, deployment or PR occurred.
- Verification deviation: before the new display-price reader was explicitly mocked, two Node harness runs each made one public LI.FI token GET. The returned USD value exposed the missing mock. No transaction or credential was sent; the mock was corrected before final verification. All final harness dependencies are synthetic. No live Alchemy RPC/Notify call was needed in Run 2.
