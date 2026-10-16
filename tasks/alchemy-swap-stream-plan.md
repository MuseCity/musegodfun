# Own on-chain swap stream via Alchemy Custom Webhooks

Status: Released and accepted online 2026-10-16 (master `01637b7`, build-38913175998-1, Worker `b2775475`).

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
2. Authenticity: only signature-verified webhook deliveries (`X-Alchemy-Signature`, HMAC-SHA256 over the raw body with that webhook's signing key, constant-time compare) are accepted. Payloads are schema-validated, bound to the expected webhook id, kind, network, contract addresses, topic0 and registered pool set. The exact callback path selects the kind before raw HMAC, which tries at most that kind's current and immediately superseded key (two keys per request on either chain), before parsing; all existing body, rate and slot bounds remain unchanged. Anything else is rejected without storage side effects.
3. Market honesty:
   - Our data is labelled "On-chain · Alchemy" with its own time.
   - Forward coverage is labelled "On-chain · Alchemy since <start>"; it is not a completeness claim. Provider records keep their source, including records after coverage begins.
   - No backfill is fabricated, and no zero-filling.
   - USD values only come from a verified quote-asset USD price with its own source and time; otherwise prices show in quote-asset terms or as unavailable.
4. Reorgs and duplicates: trades are keyed by chain, transaction hash and log index, and remember their block hash. Before final verification, a newer redelivery of the same webhook kind for the same block number with a different block hash replaces that kind's trades at that height; a kind without a cursor at a height never replaces another kind's rows, and kinds never compare sequences. Rows of different kinds may carry different hashes at one height until finality. After a 2-minute delay, check each distinct retained swap block once using `eth_getBlockByNumber`; remove every row (of any kind) whose block hash differs from the canonical hash, even if the canonical replacement has no matching swap. Persist completion. `sequenceNumber` and retries never double-count; an exact retry (same webhook generation, sequence and block hash) idempotently restores missing rows, also after finality. A log id already displayed in another unverified block is a reinclusion: a verified occurrence wins, otherwise the verified or newer delivery is displayed and the other occurrence is kept as an alternate until its block is verified, replaced or pruned, so removing either block keeps the surviving occurrence. Deeper reorganizations after that one verification are outside this policy.
5. Cost and load:
   - The filters are narrow, with `skip_empty_messages: true`.
   - No polling of Alchemy for logs, and no `eth_getLogs` scans. Finality checks run after launch maintenance, in an isolated try/catch, and are bounded to 10 distinct blocks and 10 seconds per alarm; successful checks are persisted and never repeated. Expected normal RPC volume is approximately distinct blocks containing our retained swaps per day (at the evaluation pace, at most about 59/day for MUSEGOD, plus V4 activity). The display-only verifier uses a 2-second per-call timeout, cancellation and no transport retries; failures and work left at the deadline remain pending for a later alarm.
   - The Notify API is called only when the registered pool set changes, plus at most one verification per webhook kind per day. Alarm reconciliation runs after launch maintenance in its own try/catch, with a 30-second total budget and cancellable per-call deadlines including response-body reads: 8 seconds for list/delete and 15 seconds for create (Run 8). Timeout stops subsequent calls and retains the existing retry/uncertain-creation state.
   - Storage per chain is bounded, with documented retention.
   - The webhook route is exempt from browser challenges but has its own size and rate bounds.
6. Secrets: `ALCHEMY_NOTIFY_API_KEY` is read from env only. It is never logged, returned or stored in evidence. Signing keys are fetched through the Notify API and kept only in Durable Object storage, never in responses or logs. Production needs a new Worker secret `ALCHEMY_NOTIFY_API_KEY`, added at release with the owner's approval and before the push, per the release secret-set rule.
7. No new Durable Object class, binding or migration. No Supabase migration. No new third-party service beyond Alchemy.
8. Replacing Bankr live: remove `socket.io-client`, the Bankr socket modules, their tests and the CSP `wss://api.bankr.bot` entry in the same change. Bankr REST stays as a provider source.

## Items

### S1 Webhook receiver, verification and storage

- `POST /api/chains/{4663|8453}/webhooks/alchemy/v4` and `POST /api/chains/4663/webhooks/alchemy/v3`, routed to that chain's DO. The old query-only callback and unsupported kinds return 404. The raw body is preserved for HMAC. Before reading, require a numeric `Content-Length` of at most 1 MiB (1,048,576 bytes): missing/chunked-without-length returns 411, malformed length or ambiguous transfer encoding 400, and oversize 413. Check the source's 120 failed HMACs/minute budget before reading; exhausted sources return 429. Atomically reserve at most 2 pre-read slots per IPv4 address or IPv6 /64 and 8 per chain. A 10-second read deadline and cancellation bound slow bodies; all error/timeout/abort paths release the reservation. Release immediately after HMAC, before asynchronous pool lookup or authenticated processing. Failed HMAC verification spends 1 unit of the source penalty. A pre-HMAC read that times out, aborts, errors or differs from its declared length spends in proportion to the slot time it held: 6 per second, so a full 10-second hold spends 60 and two block that source for the rest of its minute, while a failure within 1 second spends 5, so two fast failures never block it. Alchemy's documented sender IPs (`54.236.136.17`, `34.237.24.169`) skip only that read-failure charge; they still need HMAC and respect the HMAC-failure budget and both slot caps. Missing/malformed signatures, pre-read length rejections and authenticated schema errors spend nothing. Verified traffic then uses only the authenticated 600/minute budget and 8 processing slots. Node enforces the same admission/read deadline. Exempt from Turnstile challenge and the browser cross-site Origin rule, and only for this path.
- Decode V4 and V3 Swap logs into trades: pool, block number and hash, block timestamp, transaction hash, log index, amounts, `sqrtPriceX96`, tick and direction. Derive the coin price in quote-asset terms from the swap itself, with exact decimal handling.
- Store in the chain DO's SQLite storage through an injected adapter (the Node server and tests get an in-memory or file adapter). Index `(pool, block, log index)`, `(pool, time, block, log index)`, time and block lookups. Delivery writes use indexed lookups only. Summary reads 1 latest row, Recent trades reads 30, and provider-backed candles read only the current in-progress bucket. Provider-less candles use SQL OHLCV aggregation over the requested window, returning at most 200 bucket rows and one metadata payload per bucket, independent of the trade count. Reorg removal and pruning are reflected directly by aggregation over retained rows. Retention targets newest 50,000 trades or 400 days; the existing alarm prunes at most 500 trades and 500 block tombstones per run using persisted counts, never per delivery. A backlog of at most 2,000 additional rows/tombstones may exist between alarm runs (hard ceiling 52,000 each, counting rows restored from alternates); further deliveries receive retryable 503 without partial writes and an explicit gap signal prompts debounced client recovery. Finality checks begin after 2 minutes, at most 10 distinct stored swap blocks per alarm, and persist canonical hash and completion.

### S2 Webhook lifecycle via the Notify API

- Verify the Notify API's real capabilities from Alchemy's docs and read-only calls: list team webhooks, create GraphQL webhooks, update or replace a GraphQL query, and read signing keys.
- Each chain's DO owns one webhook per log filter: Robinhood V4 (PoolManager, Swap topic0, registered poolId topic1 OR-list), Robinhood MUSEGOD Sushi V3 (pool address, V3 topic0), and Base V4. Every GraphQL query contains exactly one unaliased `logs` selection, including `transaction { hash from { address } }`. Create sends only `network`, `webhook_type`, `webhook_url`, `name`, `graphql_query`; internal hashes never leave in the body. Every Notify request sends a neutral explicit User-Agent.
- Reconcile kinds independently and concurrently in the existing chain alarm on kind-specific pool-set changes or missing state; ordinary API requests only schedule a missing alarm and never invoke reconciliation; registration may schedule a changed-set reconcile. The alarm checks the per-kind state, including missing bindings. Successful same-set verification runs at most daily. Failures use persisted 1-minute exponential backoff capped at 1 hour; a different pool set resets only that kind. Persist a short pre-call attempt lease so eviction retries safely. Before creating, delete every unbound orphan on this kind's exact callback origin/path, excluding every id currently bound to any kind on this chain; a failed deletion prevents another creation. Persist the created id as soon as the response supplies it, before validating the remaining response. Identity uses the stored id plus callback origin and exact kind path, network, type and active state; any query string may be dropped or normalized without affecting identity. Delete a newly created hook by id on post-create verification failure. Store and verify the replacement signing key before explicitly retiring this kind's superseded remote destination; the orphan sweep still excludes every bound id, including sibling predecessors. Persist an uncertain-creation marker before each create call. A create that receives a response counts as a failed creation until it binds; one that times out, fails in transport or is evicted is resolved by the next orphan sweep: a swept same-callback hook means it reached Alchemy and does not count, none means it counts. After five consecutive failed creations for the same pool set, stop creating, keep a 1-hour capped backoff and perform only daily verification until a stored binding verifies successfully or the pool set changes. Expose the stopped state, failure count and retry/verification times without secrets in the existing readiness response. The read-only CLI reports same-callback hooks as requiring runtime-binding verification when it lacks a stored id. Keep at most the current and immediately superseded signing key; the latter expires after 5 minutes, while its remote webhook is deleted immediately.
- The kind is encoded in `/alchemy/v4` or `/alchemy/v3`; `?set=<hash>` is informational only. Sweeps never cross origin or exact kind path and never sweep any bound id on the chain. No legacy query-only orphan sweep remains; production has no such hook. Bindings, signing keys, hashes, leases, uncertain creation markers, backoff and stop counters live under `notify-v3|v4` and `notify-attempt-v3|v4`. Legacy `notify` / `notify-attempt` are ignored: production has no legacy binding and its failed single-webhook counters cannot gate either new kind. Readiness exposes sanitized status per kind. Independent delivery cursors are bounded to two kinds in the existing block sequence column; block hash, finality and retention remain shared, with no schema or DO migration.
- Operator CLI (`scripts/alchemy-webhooks.ts`) lists sanitized webhooks and runs one dry-run diff entry per webhook kind only. A chain absent from the supplied token catalog reports every kind as `skipped (not in catalog)`, with zero pools and no query or callback plan, including its implicit MUSEGOD filter; chains present are planned as before. This does not change the runtime's pool registry. Errors print only short known reasons or sanitized HTTP/timeout/schema/file categories. Reject `--apply`; there is no production reconcile/operator HTTP endpoint. The Notify token is sent only directly to Alchemy by server-side reconciliation or read-only CLI listing, never in an incoming Worker request.

### S3 Serving our trades, price and candles

- Recent trades for every registered pool (both chains) and MUSEGOD merge our trades with provider trades, deduplicated by transaction hash and log index. Ours are authoritative where they overlap.
- Headline live price: the latest stored swap's price, when it is newer than the provider summary. If no retained own row exists, preserve a valid provider summary. When the latest swap lacks USD conversion but the provider has a valid USD price, preserve the provider's USD price, market cap, FDV, source, status and timestamps. Show the swap's quote-unit price separately as "Latest swap · On-chain · Alchemy", with its own Block time (`quotePriceAt`); do not relabel the provider's USD values as on-chain. Recent trades still include the newer own trade with its own provenance and unavailable USD. Older pushes cannot replace a newer secondary price. If neither source has USD, show own quote units; when conversion recovers, the current swap can supply the headline again. Store quote-unit prices only. At read time convert using an identity-checked current quote-asset USD cache: successes last 5 minutes, failures 60 seconds, with a dedicated budget of 2 token reads per minute per chain and a 3-second timeout. When configured, send only `runtime.lifi.apiKey` as `x-lifi-api-key`, the same server-side key used by the payment reader; never log or return it. This display reader never touches the payment reader, shared LI.FI quote budget, shared backoff or `blockBudget` and never runs in delivery. Broadcasts may peek its cache without I/O. Missing USD affects that response only; the chart unit is never pinned by a historical missing price. Current-quote conversion is not historical USD valuation.
- Candles: keep every provider candle as the base wherever returned. Own trades may add/update only the in-progress bucket strictly newer than the provider's last bar, and only in compatible units; otherwise keep the provider bars. If no provider returns bars, build the requested window from own trades with coverage start. No historical provider bar is replaced, no double counting or zero filling. A current USD quote is applied consistently across one requested window. Responses carry the provider's last returned bar and own quote-asset OHLCV for later buckets, so pushes apply the same boundary independent of provider watermarks and rescale the whole own portion whenever the pushed quote changes, including USD to USD; without a current quote, own bars are hidden beside provider bars or shown in quote units without them.
- Freshness: `fetchedAt` is when a response was served; on-chain data carries the last trade's block time separately as `lastTradeAt`, shown as "Block". The 24-hour client expiry applies to `fetchedAt`, so stale provider snapshots still expire and retained on-chain history of a quiet pool does not.
- Whenever our latest swap supplies the headline price, with or without USD, retain the provider summary's market cap, FDV, liquidity and period statistics (including volumes, price changes and trade counts). Attribute these statistics to the provider with its original fetch time, preserved across subsequent pushes; do not relabel them as on-chain or recompute market cap from supply. Without a provider summary they remain unavailable. REST and push projection use the same merge.
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

### 2026-10-16 - Run 2b

- C1b-1: launch maintenance precedes isolated swap maintenance; 10-second total verification budget, 2-second cancellable calls, no RPC retries, pending work resumes on a later alarm.
- C1b-2: sweep orphans before creation, persist response ids before validation, delete failed creations by id, match stored ids without callback query dependence, and stop after five failed creations. Daily verification or a changed set is the only reset; readiness exposes sanitized failure state.
- C1b-3: provider reads cover only the current bucket; provider-less reads return at most 200 SQL OHLCV aggregates with one metadata payload per bucket, including after reorg removal.
- C1b-4: only unverified rejections spend the 120/min source bucket. Synchronous HMAC precedes authenticated processing; verified deliveries use only 600/min and 8 processing slots. The removal of pre-read leases is superseded by Run 2c below.

### 2026-10-16 - Run 2c

- C1c-1: require numeric bounded Content-Length before reading; check the HMAC-failure source budget first; reserve 2 pre-read slots per source and 8 per chain, released immediately after HMAC and on all errors, timeout or abort. Only failed HMAC verification spends the source penalty. Valid deliveries never spend it and retain the authenticated 600/minute and 8-slot limits after verification.
- C1c-2: Notify reconciliation follows launch maintenance in its own try/catch, with a 10-second total budget and cancellable 2-second call deadlines covering fetch and response-body reads. Block verification remains a separate guarded and bounded task; the alarm is always rescheduled.

### 2026-10-16 - Run 4 (claude fix of the reverse review)

- X2-1: reinclusion with persisted alternates (SQLite `swap_alternates`), atomic with block metadata and persisted counts; exact retries are idempotent.
- X2-2/X2-3/X2-4: separate `fetchedAt` and `lastTradeAt`; one shared candle composition for REST and push with explicit `own` state (provider boundary, quote-unit bars, own watermark).
- C1d-1 (revised after Codex acceptance round 2): failed pre-HMAC reads cost 6 per second of slot time held (5 within 1 s, 60 for a full 10 s hold) of the 120/minute source budget; Alchemy's documented sender IPs skip only this charge. X2b-1: alternate restorations count toward the 52,000 ceiling before any write. C1d-2: create 15 s, list/delete 2 s, reconcile budget 30 s, uncertain creations resolved by the orphan sweep.

### 2026-10-16 - Production hotfix (Run 6, revised by Run 6b)

- Conductor-observed production facts after release `d1e7479` / build `38888842595-1`: both chain DOs report `swapStream: {creationFailures: 2, error: "Notify reconciliation unavailable"}` and the team has zero webhooks. These creation probes were performed by the conductor, not this run; every successful probe was immediately deleted and the team returned to zero.
- Replaying the original create body returned HTTP 503, `{"message":"Internal server error"}`. Probe A: documented fields only with aliased `v4: logs(...)` and `v3: logs(...)` -> 503. Probe B: aliases retained, `transaction.from` removed -> 503. Probe C: one unaliased V4 `logs(filter: ...)`, without `from` -> 200. Probe D: one unaliased `logs`, `transaction { hash from { address } }` and `name` -> 200. Its response includes `deactivation_reason, id, is_active, name, network, networks, signing_key, time_created, version, webhook_type, webhook_url`.
- Conductor inference from those probes: multiple aliased logs selections are rejected; use one webhook per filter. The probe matrix did not independently isolate a lone alias, so the hotfix removes aliases entirely. Python's default User-Agent receives Cloudflare 1010; no UA, `node` or a custom UA reaches the API (401 without a token). Worker requests use `Musegod-Swap-Stream/1.0`.
- Implement per-kind lifecycle, bounded pre-parse authentication, decoder kind isolation, callback identity, dry-run entries and migration from the unbound failed attempt as specified in S1/S2. One kind's backoff, stop or transport failure cannot block the other's reconciliation. The chain's existing 30 s total budget still bounds both kinds.
- Run 6b conductor decisions (C3-1/C3-2/C3-3): put the kind in the exact callback path, accept any query normalization, and exclude all stored bindings across kinds from orphan sweeps. Retire this kind's predecessor explicitly after replacement key persistence. Reject the old query-only receiver with 404. Authenticate against only the selected kind's first two stored bindings, filtered for kind/network/expiry before raw HMAC and parsing. Reconciliation runs only from the alarm or a pool-set change; ordinary API requests never invoke it. Restore the C1b-2 query-less identity fixtures. These are local implementation decisions and test results, not new live probe facts.
- Self-review found independent webhook sequences could discard the other filter's trades in the same block. Keep at most two cursors in the existing sequence column and retain shared block finality/retention. Run 7b (X4-1): each kind's cursor also records the hash it delivered, reorg replacement is scoped to the delivering kind, and finality compares each row's own hash with the canonical one. Run 7b (X4-2): no swap-cursor migration is needed, because production (`d1e7479`) never created a webhook, Alchemy never delivered and the receiver rejects unsigned requests, so its swap storage holds zero trades and zero cursors; `e4dd05e`/`e0e3d82` were never deployed. The store therefore reads and writes only the per-kind format with generation, sequence and hash; any other stored cursor (plain sequence, hashless or unknown kind) is corrupt state, and the delivery is rejected with a retryable 503 before any write, never inferred from the block hash. The `notify-attempt` migration used by the first alarm is unchanged. Also select the two allowed keys before excluding an expired predecessor, so an older extra key can never become eligible.
- Run 6 is local only: no live Notify create/update/delete, production write, deploy, push, wallet action or secret command. Local rollback is the parent `d1e7479` via reverting the Run 6 commit; production is unchanged by this run. Owner-approved release must still verify active hooks, real delivery/signing keys, Content-Length and a real displayed swap.

### 2026-10-16 - Run 8 post-release fixes

- Conductor observations after `d2c8454` / build `38901468420-1`: three active GRAPHQL hooks; first MUSEGOD swap at 13:03:35 UTC, block 90099042, with correct quote units but missing USD; keyed LI.FI pricing works from the Worker while anonymous display reads return null. Anonymous shared-egress rate limiting is an inference, not a cause verified by this run. Notify listing took 1.0-1.45 s against the previous 2 s deadline. These are supplied production observations, not new external checks.
- Apply the S2/S3 rules above: use the existing LI.FI key with independent display cache/budgets, keep provider USD when conversion is unavailable and label own quote detail, raise list/delete to 8 s within the existing 30 s total, and leave absent CLI catalog chains idle with sanitized error reasons. Create remains 15 s; trade execution and runtime permissions stay unchanged.

### 2026-10-16 - Run 8b review fixes

- C5-1: when our swap supplies the headline, retain all provider statistics with the provider's original source/fetch time, including when USD conversion succeeds. No provider summary means unavailable statistics; no supply-based calculation is added. REST and pushed projections agree.
- C5-2: supersede Run 8's absent-chain `idle` label with `skipped (not in catalog)` for every kind, omitting that chain's query/callback plan. Present-chain planning and the runtime registry are unchanged.

## Delivery record

### Run 1 - 2026-10-16

Historical implementation record; lifecycle, admission, pricing, serving and push behavior below is superseded by the Run 2 conductor decisions.

- S1-S4 implemented locally on `claude/alchemy-swap-stream`; this plan is included in the first implementation commit. The exact commit and detailed results are recorded in `.superpowers/sdd/swap-stream/run1-report.md`.
- Official research and read-only Notify evidence: `.superpowers/sdd/swap-stream/evidence/notify-api.json`. Two real `GET /api/team-webhooks` calls returned HTTP 200 with `{data: []}`; one was the operator dry run. No live Notify mutation was made. The public Custom payload puts the decimal-string sequence in `event.sequenceNumber` and does not promise a network field; the receiver binds its id to the stored Notify network and rejects explicit conflicts.
- The documented update endpoint changes name/status only. Replacement uses deterministic callback-set URLs, persists the new signing key before retiring the old one, retains old verification keys for 24 hours, and does not depend on an undocumented `name` in list responses. Failed same-set attempts and daily verification are limited to once per day; a changed set can reconcile immediately. Single-query aliases and actual empty-message suppression still needed Alchemy's release acceptance at this historical stage; the dated Run 6 production hotfix supersedes the alias design.
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


### Run 2b - 2026-10-16

- Verified and accepted C1b-1 through C1b-4. Ten new regressions failed on the pre-fix tree, then passed after the fixes; evidence is under `.superpowers/sdd/swap-stream/evidence/run2b/`. No findings were rejected.
- Local checks cover actual compiled Worker alarm ordering/error isolation, simulated hanging RPC deadlines and resumed pending blocks, persistent creation failures/cleanup/stop/reset, normalized callback identity, and a 40,000-trade 1d chart returning at most 200 rows. SQL aggregation uses retained rows, so it reflects reorg removal without a separate rollup migration.
- Node and Miniflare Worker route harnesses each accept 125 additional valid deliveries from one source. Unit coverage accepts exactly 600 authenticated deliveries per minute and eight held processing slots despite a saturated unverified source bucket; the next authenticated request is rejected. Readiness exposes sanitized Notify status. All upstreams are mocked, and a Node fetch guard rejects accidental unmocked external requests.
- Required checks and the local commit are recorded in `.superpowers/sdd/swap-stream/run2b-report.md`. Claude acceptance, reverse review and owner-approved release remain pending. No live external call, Notify mutation, production write, wallet action, secret command, push, deployment or PR occurred.

### Run 2c - 2026-10-16

- Verified and fixed C1c-1 (P1) and C1c-2 (P3) from the second acceptance pass, following `run2c-brief.md`. Each finding has pre-fix failing regressions retained in `.superpowers/sdd/swap-stream/evidence/run2c/`; no finding was rejected.
- The compiled actual Worker fetch method, using synthetic streams and storage, proves that 128 slow unsigned requests hold at most 2 body readers per source and 8 across sources; IPv6 /64 rotations share the source cap. Failure-budget rejection occurs before reading, a valid delivery from another source succeeds, and timeout/abort/read/storage-error paths release slots. HMAC completion releases slots before asynchronous processing, preserving 600 authenticated deliveries/minute and 8 processing slots. A real Node HTTP harness verifies pre-parser admission, chunked/oversize rejection, abort/deadline release and subsequent signed delivery.
- Alarm tests prove launch work precedes Notify even when launch or swap tasks fail. Fake-clock tests bound hanging Notify fetch/body reads to 2 seconds and sequential calls to 10 seconds overall, abort pending work, prevent late follow-up calls and preserve alarm scheduling. Existing Miniflare and Node synthetic-delivery/storage/WebSocket regressions remain covered.
- Required checks and the local commit are recorded in `.superpowers/sdd/swap-stream/run2c-report.md`. All upstreams are mocked; a Node fetch guard blocks accidental external requests. Claude acceptance, reverse review and owner-approved release remain pending. No live external call, Notify mutation, production write, secret read/command, wallet action, push, deployment or PR occurred.

### Run 4 (claude fix) - 2026-10-16

- Claude fixed Codex review round 2 (X2-1 to X2-4) and the open P3s C1d-1 and C1d-2 from Claude acceptance, following the Run 4 decisions above. Eleven new regressions in `tests/swap-run4.test.ts` failed on `cdde2eb` and pass now; evidence and per-finding notes are in `.superpowers/sdd/swap-stream/claude-fix-r2.md` and `evidence/run4/`.
- Follow-up after Codex acceptance round 2: C1d-1 made proportional to slot time held, with Alchemy sender IPs exempt from the read-failure charge only, and X2b-1 counts alternate restorations toward the hard ceiling; 4 new regressions red on `7450ed1`, green after.
- Four Run 2c tests and three merge-helper call sites were updated where they encoded the superseded read-failure policy, the 10-second Notify budget or the per-trade USD candle signature.
- Local only: no Alchemy/Notify/RPC call, `.env` read, browser, preview server, wrangler command, push, deployment or PR. Codex acceptance and owner-approved release remain pending.

### Cross-review closure (2026-10-16)

- Codex implemented S1–S4 in `76ab5a3`.
- Claude review round 1 raised C1-1…C1-13, including two P1s: full-table reads per request, and a REST burst per push that could exhaust read capacity and rate-limit quotes. Fixes went through codex `8098bdb`, `d249e65` and `cdde2eb`. Claude accepted all of them over three passes, including C1b-1…C1b-4 and C1c-1, a P1 where unverified bodies were read unbounded.
- Codex review round 2 raised X2-1…X2-4 (P2: reincluded swaps lost across blocks; quiet pools hidden by freshness; pushes rewriting the provider's current bar; mixed USD bases) and C1d-1/C1d-2. Claude fixed them in `7450ed1` and `d7e04d0`; codex accepted them after a second pass that also covered X2b-1 (restoration counted against the storage ceiling).
- Conductor verification:
  - Alchemy's documented webhook sender IPs (`54.236.136.17`, `34.237.24.169`) and its retry policy (exponential backoff up to 10 minutes on Free/PAYG) were checked against https://www.alchemy.com/docs/reference/notify-api-quickstart.
  - Rerun on `d7e04d0`: `npm test` **1701/1701**, `npm run build`, `git diff --check` and the Han scan pass. The built assets contain neither `socket.io-client` nor `api.bankr.bot`.
- Not verified before release: live delivery, `Content-Length` on real deliveries, real create latency, signing-key adoption, and a real swap shown live. These belong to online acceptance.
- Release steps, each needing owner approval:
  1. Add the Worker secret `ALCHEMY_NOTIFY_API_KEY` to the currently deployed version (`6f7b475`) through `wrangler versions secret put`, piping the value from `.env` without printing it, and deploy that version. `scripts/release.ts` requires identical secret sets.
  2. Push to master.
  3. The chain Durable Objects create and reconcile the webhooks in the owner's Alchemy team on their next alarm.
  4. Online acceptance.
- Rollback: Worker `dd2582ff` (`6f7b475`). After a rollback, remove the created webhooks with the operator CLI's list output and the Alchemy dashboard.

### Run 6 - 2026-10-16

- Implemented the production hotfix for `d1e7479` / build `38888842595-1`: three separate single-filter, unaliased webhook queries (Robinhood V4/V3 and Base V4), documented-only create bodies and a neutral User-Agent. Conductor production facts and probes are recorded in the dated Production hotfix section.
- Per-kind callback identity, bindings/keys, canonical pool-set hashes, backoff/leases/uncertain creations/stop counters and readiness status are independent. The failed unbound legacy attempt is ignored. Concurrent reconciliation lets a healthy kind bind even when its sibling hangs or fails. Authentication stays bounded before parsing, and signed cross-kind payloads are rejected without storage. The read-only CLI has one entry per kind.
- Added 16 Run 6 regressions: 15 fail on archived `d1e7479`, then all 16 pass locally. The key-expiry guard also has its own pre-fix failure in the intermediate hotfix tree. Self-review R6-1/R6-2 are fixed: same-block independent delivery cursors in both adapters, and no older-key admission after a predecessor expires. Existing Node/Miniflare ingestion, storage, REST, sockets, capacity and alarm-budget tests remain covered.
- Final `npm test`: 1717 pass, 0 fail; `npm run build`: pass (existing chunk-size warning). Final whitespace/Han/bundle checks and local commit are recorded in `.superpowers/sdd/swap-stream/run6-report.md`; evidence is under `evidence/run6/`.
- One real read-only Notify list was attempted but returned no usable result; current count is unknown in this run (the conductor's prior count was zero). No live create/update/delete, RPC request, app startup with real env, production write, wallet action, secret command, deploy, push or PR. Independent hotfix acceptance, release and live delivery acceptance remain pending.

### Run 6b - 2026-10-16

- Fixed C3-1, C3-2 and C3-3 from Claude review round 3. Callback identity is stored id + origin + exact `/alchemy/v3|v4` path; all query strings are optional. Orphan sweeps exclude every chain binding, while explicit own-kind predecessor retirement preserves immediate remote cleanup and the five-minute key window. Worker and Node receivers reject query-only callbacks and select at most two HMAC keys by path before parsing.
- Removed the legacy request-triggered Notify check. Missing state is reconciled by the scheduled alarm; pool-set changes retain their existing trigger. The read-only CLI reports each kind's new callback URL, including idle filters.
- Fourteen new regressions failed before implementation and pass after it. Coverage includes query stripping/replacement in create/list, daily sibling preservation, both orphan sweeps, actual HMAC counts, wrong-kind rejection, bound/partial/missing/stopped API request state, compiled Worker routes, real Node HTTP and the CLI. Existing C1/C1b and Node/Miniflare regressions remain covered. Final `npm test`: 1731 pass, 0 fail; build pass with the existing chunk-size warning; whitespace/Han/bundle scans clean. Required check results and the local commit are recorded in `.superpowers/sdd/swap-stream/run6b-report.md`; evidence is in `evidence/run6b/`.
- Local only: no live Notify/RPC call or mutation, env/secret read, production write, wallet action, deployment, push or PR. Roll back locally by reverting the Run 6b commit to parent `e4dd05e`; release and real Alchemy delivery acceptance remain pending.

### Run 7b (claude fix) - 2026-10-16

- Fixed X4-1 from Codex review round 4 in `server/swap-store.ts`: reorg replacement is scoped to the delivering kind; finality removes rows of any kind whose own hash is not canonical. X2-1 alternates and X2b-1 capacity (now kind-scoped) remain intact. Five new regressions in `tests/swap-run7b.test.ts` failed on `e0e3d82` and pass now; `npm test` 1736 pass, 0 fail; build, whitespace, Han and bundle checks clean (`.superpowers/sdd/swap-stream/claude-fix-r4.md`). Local only; Codex acceptance and release remain pending.
- X4-2 (Codex accept pass): removed the never-deployed plain-sequence and hashless cursor fallbacks; a cursor outside the current format is rejected as retryable without mutation. Three new regressions (two red on `e38ad77`, one format guard); `npm test` 1739 pass, 0 fail; details in `claude-fix-r4.md`.

### Hotfix cross-review closure (2026-10-16)

- Production fact after `d1e7479`: both chains reported Notify creation failures. Conductor probes proved that Alchemy GraphQL webhooks return 503 for multiple aliased `logs` selections in one query. The fix creates one webhook per filter (RH v4, RH v3, Base v4).
- Codex implemented `e4dd05e`.
- Claude review found C3-1 (P2: kind identity in the query string), C3-2 and C3-3. Codex fixed them in `e0e3d82` (kind in the callback path) and claude accepted them.
- Codex review found X4-1 (P2: a delayed sibling-kind orphan could erase a canonical row). Claude fixed it in `e38ad77` (reorg replacement scoped to the delivering kind).
- The codex accept pass found X4-2 (P2: hashless cursors from the never-deployed `e0e3d82`). Claude fixed it in `2f8a105` by removing legacy cursor formats; production swap storage was empty because no webhook had ever existed. Codex accepted it, including a local simulation in which the first production alarm creates exactly three hooks from the stored notify-attempt state.
- Conductor rerun on `2f8a105`: `npm test` **1739/1739**, build, diff check, Han scan and bundle scan pass. The operator dry-run against the real team (read-only) shows zero existing webhooks and three planned creates with kind paths.
- Known operator-tool nit (not production): the CLI dry-run throws when the supplied catalog lacks one chain's tokens. Pass a catalog that covers both chains.

### Run 8 - 2026-10-16

- Implemented the four post-release fixes from `run8-brief.md`. The display-only LI.FI reader receives the existing runtime API key, sends it only in the token request header and retains independent two-reads/minute/chain budgets. Failures cache for 60 s; successes remain five minutes. Shared reservation/backoff and `blockBudget` are untouched.
- Missing own USD no longer clears the provider's USD headline, market cap or provenance. The own quote price appears as a separately labelled secondary detail with its own Block time; newer own trades stay visible. REST/live share the fallback, recovery clears the marker, and older pushes cannot overwrite newer secondary prices. S2/S3 and the dated Run 8 decisions above document the final rule.
- Notify list/delete now get 8 s, create stays 15 s and reconciliation stays 30 s with cancellation and persisted retry state. CLI absent-chain filters are zero/idle; errors expose only short sanitized reasons. A well-formed single-chain array did not reproduce the conductor's exception, but Base-only input did incorrectly plan the absent Robinhood chain's implicit MUSEGOD filter; the regression now verifies the requested zero-pool behavior. Runtime pool registration is unchanged.
- TDD evidence: final behavioral tests on archived parent `d2c8454` give 15 fail / 4 pass (new formatter export excluded); the secondary-price ordering fix has its own pre-fix failure. All 20 Run 8 regressions and 48 affected tests pass. Final `npm test`: 1759 pass / 0 fail; build passes with the existing chunk-size warning. Required scans, local commit and details are recorded in `.superpowers/sdd/swap-stream/run8-report.md` and `evidence/run8/`.
- Local only: all upstreams mocked, with the external-fetch guard enabled; no env/secret read, live service call, Notify mutation, production write, wallet action, runtime-permission change, deploy, push or PR. Revert the Run 8 commit to return to `d2c8454`. Independent review and a later owner-authorized release/live acceptance remain pending.

### Run 8b - 2026-10-16

- Fixed C5-1/C5-2 from Claude review round 5 under `run8b-brief.md`. The shared summary merge retains provider market cap and FDV alongside liquidity and all period statistics when an own swap supplies the headline, with or without USD. Existing provider source/fetch metadata and the statistics label are preserved across pushes. Without a provider summary statistics remain unavailable; no market-cap calculation is added. REST and push results agree.
- The operator CLI reports every absent-chain kind as `skipped (not in catalog)` with zero pools and no query/callback plan. Present-chain planning and the runtime registry are unchanged. Updated the superseded Run 8 idle assertions and narrowed the existing full-catalog test to planned entries.
- TDD: 12 new regressions first yield 9 behavioral failures and 3 preservation passes, then all pass; the affected suite passes 65/65. Coverage includes the USD matrix, provider fetch time, repeated pushes, zero-valued statistics, no-provider availability, rendered values/provenance, both single-chain catalogs and an empty catalog. Full `npm test`: 1771 pass / 0 fail. Build passes with the existing chunk-size warning; whitespace/Han/bundle scans clean. Report and local commit: `.superpowers/sdd/swap-stream/run8b-report.md` and `evidence/run8b/`.
- Local only: upstreams mocked with the external-fetch guard enabled; no external service call, real env/secret read, Notify mutation, production write, wallet action, runtime-permission change, deploy, push or PR. Revert the Run 8b commit to return to `d4040f9`. Independent Claude acceptance and a later owner-authorized release/live acceptance remain pending.

### Run 9 (claude fix) - 2026-10-16

- Fixed X5-1 from Codex review round 5: a merged summary keeps the provider's own summary as `providerSnapshot`, and every summary merge (REST or push) uses that provider summary as its base, so a newer own swap without USD after an own USD headline restores the provider USD headline with its source, status and fetch time while our quote price keeps its own label and Block time. Provider statistics and attribution are retained; no-provider behavior is unchanged. Four sequential regressions in `tests/swap-run9.test.ts` (available, missing and available conversions from an own-priced REST response and from a converted push, with and without a provider, REST equal to push at every step) show the provider cases failing on `788400f` and all passing now; `npm test` 1775 pass, 0 fail; build, whitespace, Han and bundle checks clean (`.superpowers/sdd/swap-stream/claude-fix-r5.md`). Local only; Codex acceptance and release remain pending.

### Post-release fixes closure (2026-10-16)

- Production after `d2c8454`:
  - Three GRAPHQL webhooks are active: RH v4 `wh_3mh7qv8pz632pe5g`, RH v3 `wh_eotsum1hbbt98vlu`, Base v4 `wh_wig0365m85e9omap`.
  - The first real MUSEGOD swap (13:03:35 UTC, block 90099042, tx `0xdfc9dc1c8118…`) was delivered and served as "On-chain · Alchemy". It matched Bankr's record exactly.
- Two regressions were observed:
  - `quoteUsd` was null, because the anonymous display reader on Cloudflare egress got nothing from LI.FI while the keyed path worked. The MUSEGOD headline therefore lost its USD price and market cap.
  - The Notify list took 1.0–1.45 s against a 2 s timeout.
- Fixes:
  - Run 8 `d4040f9`: keyed display reader with its own budget, 60 s failure cache, provider USD fallback, 8 s list/delete timeout, CLI single-chain catalogs.
  - Run 8b `788400f`: provider statistics retained with attribution (C5-1); CLI skips absent chains (C5-2).
  - Claude fix `fc7d1a9`: a provider headline snapshot carried across pushes, so push equals REST (X5-1).
- Claude review accepted C5-1/C5-2. Codex review found X5-1, and codex accepted the fix.
- Conductor rerun on `fc7d1a9`: `npm test` **1775/1775**, build, diff check, Han scan and bundle scan pass (no `socket.io-client`, `api.bankr.bot` or LI.FI key header strings in browser assets).

### Run 10 (claude fix) - 2026-10-16

- Fixed X6-1, found in production after release `a58f726`: the display price reader (`server/swap-prices.ts`) stored the global `fetch` as its default and called it as a method, which workerd rejects as "Illegal invocation", so `quoteUsd` stayed null without any LI.FI request. The default now calls `fetch` unbound, as `NotifyClient` does; the Node-only webhook CLI default is wrapped the same way. A scan of `server/` found no other stored-global method call. Budgets, caching, identity checks and key handling are unchanged. A new real-workerd regression (`tests/swap-prices-worker.test.ts`, Miniflare with production compatibility flags and an outbound LI.FI fixture) failed on `a58f726` and passes now, with and without a configured `x-lifi-api-key`; `npm test` 1776 pass, 0 fail; build, whitespace, Han and bundle checks clean. Local only; release remains owner-approved.

### Release and online acceptance (2026-10-16)

- Release sequence:
  1. Worker secret `ALCHEMY_NOTIFY_API_KEY` added on version `ee7746a4` (code `6f7b475`).
  2. `d1e7479`: webhook creation failed (aliased filters).
  3. Hotfix `d2c8454`: three webhooks created.
  4. `a58f726`: USD fixes. The DO kept the previous code until the same version was redeployed with `--durable-objects-code-update-mode immediate`.
  5. `01637b7`: unbound `fetch` in the display price reader. Workerd rejected the stored global fetch with Illegal invocation.
- Online API checks:
  - All three webhooks are active with zero failures.
  - The first real MUSEGOD swap (13:03:35 UTC, block 90099042, tx `0xdfc9dc1c8118…`) was delivered and matches Bankr exactly.
  - `quoteUsd` comes from LI.FI (WETH $2,457.35).
  - The summary shows our USD price ($0.00016007) with the provider market cap ($158.8K) attributed to Bankr; the trade row shows USD $0.08.
- Codex read-only Chrome QA, VERDICT PASS on all 9 checks:
  - The build identity is correct on both hostnames.
  - The MUSEGOD headline shows USD and market cap, with separate on-chain, provider-statistics and LI.FI attributions.
  - The real trade is listed with its on-chain label.
  - Same-origin stream sockets open on MUSEGOD and CLAWGOD.
  - There are no application CSP violations, and no socket.io or Bankr scripts load.
  - There is no 390 px overflow.
- Production rollback point for the feature: Worker `dd2582ff` (`6f7b475`). After a rollback, delete webhooks `wh_3mh7qv8pz632pe5g`, `wh_eotsum1hbbt98vlu` and `wh_wig0365m85e9omap` in the Alchemy dashboard.
