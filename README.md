# musegod.fun

A non-custodial meme launchpad built with Doppler and Uniswap v4. The current source supports **Base (8453)** and **Robinhood Chain (4663)**.

- **Launch, trade, claim fees.** User transactions need confirmation in the selected wallet. Automatic Base fee conversion and cross-chain delivery use a separately authorized Splits native Automation account; public fee claims and final Robinhood settlement use the existing keeper flow.
- **New Create pairs:** 35 exact Coinbase B20 addresses on Base and 115 assets on Robinhood, selected from the recorded LI.FI/Jumper qualification. ST0x and Backed are excluded. The identity registries contain 35 Base assets and 198 Robinhood assets for existing tokens and transaction recovery.
- **$5,000 initial valuation target.** Both chains use the existing 97/3 curve and LI.FI buy/sell quote references. Price snapshots expire after 60 seconds; the optional first buy moves price above the initial boundary.
- **Optional first buy and lock.** Pay with the paired asset, chain-specific stablecoins or native ETH, then optionally lock the purchase for 30/90/365 days.

**Status, 2026-10-12:** Base and Robinhood public issuance are enabled under the owner's previous authorization. Round 12 was published as `1772c0a` / `build-38250637916-1`. Round 13 removes PM from Base issuance locally under the owner's instruction; it is not committed or deployed. Production success and the active version are recorded in GitHub Deployments. Publication preserves both chains' persistent controls and does not upgrade or arm a host keeper or move funds. Base fees use the deployed immutable Collector and dedicated Splits native Automation; native Relay delivery reuses Robinhood's Treasury, Forwarder and protected shared Vault. Stats show aggregate counters, with no continuous cross-chain provenance or Base-specific shared burn attribution. [SPEC](docs/SPEC.md#base-go-live-lightweight-splits-treasury-and-native-automation) records runtime safeguards and separate keeper approval. LI.FI remains the provider for launch pricing and same-chain Pay with. Historical fork/quote/browser checks are distinct from mainnet receipts; new website releases preserve persistent signing controls.

## Start locally

Requires **Node.js 24.11+**.

1. Create `.env` from [.env.example](.env.example) if you don't already have one.
2. Fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Production requires the existing `ALCHEMY_API_KEY` with Base and Robinhood enabled; it does not fall back to public RPCs. Supabase Web scopes are fixed to `base` and `robinhood`; the server uses the service role only.
3. For a fresh database, apply the [initial migration](supabase/migrations/20261005000537_musegod_store.sql), then the additive [runtime safety migration](supabase/migrations/20261007094402_runtime_safety_controls.sql), [Vault journal](supabase/migrations/20261009050807_buyback_vault_ledger.sql) and [native custody journals](supabase/migrations/20261009125045_buyback_native_custody_ledger.sql), in order. Existing databases need only unapplied additive migrations, with owner-authorized production maintenance and a reviewed backup. No anonymous or authenticated-user permissions are added.
4. Run:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5188**. In another terminal, check readiness:

```sh
curl -fsS http://127.0.0.1:5188/readyz
```

Keep `ENABLE_MAINNET_TRANSACTIONS=false`, `ENABLE_BASE_TRANSACTIONS=false` and any explicit `ENABLE_ROBINHOOD_TRANSACTIONS=false` for read-only development. Base cannot inherit Robinhood's write flag or guard address. Signing also requires a valid `PLATFORM_TREASURY` and an unpaused persistent control; missing or unreadable control state fails closed. Guards are exposed only after runtime/dependency verification. Restart Node after server or environment changes. Create selects the deployment with `/create?chainId=8453|4663`, default Robinhood. Scoped APIs use `/api/chains/:chainId/...`; token URLs use `/token/base/:address` or `/token/robinhood/:address`. Legacy token links and production unscoped APIs retain Robinhood meaning.

For a local production build, run `npm run build`, then `npm start`.

## First-buy payments and locks

The **Your first buy (optional)** module follows [Stonx](https://stonx.ai/create): payment selector, amount, ERC20 balance fill, estimated USD value and $10/$20/$50/$100 shortcuts. Base permits the paired asset, USDC, USDT and native ETH; Robinhood permits the paired asset, canonical USDG and native ETH. Exact addresses are pinned in [SPEC](docs/SPEC.md#issuance-and-trading). USD shortcuts use LI.FI token display estimates; opening prices are calculated separately from fixed buy/sell quote probes, independently of the user's first-buy amount. Native Max is disabled when a complete gas reserve is unavailable.

Set server-only `LIFI_API_KEY` and `LIFI_INTEGRATOR=musegodfun` for opening references and LI.FI conversion quotes. Opening snapshots remain fresh for 60 seconds; final v2 issuance plans last five minutes from finalization, and validation cannot extend that window. Above-5% spread or unavailable auxiliary reference prices produce inline warnings. Invalid execution routes/identity/amounts and explicit pause still stop the relevant operation. One business review includes payment and first-buy minimums; necessary wallet approvals/conversion proceed separately, then fresh preparation/simulation continues within the accepted floor. Native ETH→WETH uses direct wrapping with no LI.FI fee. Other LI.FI conversions keep their own validity. Unknown broadcasts are never automatically retried; drafts, frozen calls, conversions and history recover per intent after reload.

New Create pairs use 35 exact Base B20 identities from the [historical Jumper qualification](docs/evidence/base-jumper-qualification.json), excluding PM since 2026-10-12, and 115 Robinhood addresses from the [opening-price audit](docs/evidence/lifi-opening-price/index.json). The owner removed PM (`PMc`, Philip Morris) because the reviewed 10/100 USDC native Relay probes were rejected, leaving no native Automation conversion route. Historical quote records remain unchanged. Each new preparation obtains executable quotes. Base uses `USDC → B20`, the exact resulting B20 quantity `→ WETH`, then a fresh `WETH → USDC` reference, with independent raw quantities and decimals on every leg. A spread above 5% remains a warning; invalid identity, quantities or a genuinely unavailable route blocks preparation. HTTP 429 defers service work without permanently excluding an asset. Chainlink and catalog USD display prices are not Base eligibility or valuation prerequisites.

The earlier [route snapshot](docs/evidence/lifi-launch-pairs.json), [Base catalog audit](docs/evidence/lifi-base-stock-audit/index.json) and [opening-source acceptance](docs/evidence/lifi-opening-price/index.json) retain their original scope, failures and source hashes. The prior pricing probe passed 15/36 Base and 115/192 Robinhood candidates; those historical 130 addresses defined the preceding Create whitelist. The later Jumper review covered all 36 then-existing exact B20 addresses; the current admitted set is 35 after PM was removed on 2026-10-12. ST0x and Backed remain excluded. The [Worker transport check](docs/evidence/lifi-workerd-fetch.json) preserves the preceding provider receiver fix and rollback evidence. Expired audit samples never authorize new transactions. Removed-pair drafts retain metadata but reset first-buy amount and lock; submitted payments retain their original recovery record.

**Lock your first buy** defaults off and supports 30/90/365 days. Official Bundler holds the purchase until a cliff equal to the full duration; it does not release gradually. The recorded recipient alone may claim after unlock. Missing or unverified vesting guard disables locking; the deployed legacy guard continues to support unlocked buys. [Guard deployment status and rollback](docs/launch-guard-deployment.md) distinguish prepared source/fork evidence from mainnet deployment.

## Token images

On `/create`, upload PNG/JPG/WebP/GIF up to **5 MiB**, or use a public HTTPS URL. Uploads become WebP images of at most 512 × 512 and 40 KiB; GIFs use the first frame.

Uploads require server-only `PINATA_JWT` in every runtime. Images go to public IPFS through Pinata; keep them pinned. A content-hash cache reuses successful uploads in the same database scope, and both chains share a durable 100-upload daily budget. Cached uploads spend no additional provider budget. Backups contain image URLs and cache records, not image bytes. Failed uploads preserve the previous image.

## NFT mode

NFT mode binds a new coin to one ERC-721 on Robinhood Chain; each NFT gets one coin, ever. Muses launch free and pair with MUSEGOD; other NFTs pay $10 (10 USDG or quoted ETH) to the operations wallet. The coin's creator fees go to a per-NFT fee vault that anyone can sweep into the NFT's Tokenbound (ERC-6551) treasury, which the current holder controls, so the fees follow the NFT when it is sold. It is off until the owner deploys the vault factory and sets `NFT_MODE_ENABLED=true`. Rules, statuses, APIs and the rollback floor: [specification](docs/SPEC.md#nft-mode-robinhood).

```sh
npm run test:nft-launch-fork -- --chain robinhood   # isolated Robinhood fork, end to end; reads only .env.fork (ALCHEMY_API_KEY)
npm run report:nft                                   # operator report from the public API; add -- --local <store> for a local SQLite store
```

The fork run needs Foundry's `anvil` (the isolated fork) and `forge`, which compiles the run's test ERC-721 offline with solc 0.8.24.

## Check changes

```sh
npm test
npm run build                 # includes both TypeScript checks
npm run verify:asset-logos
```

| Additional check | What it verifies |
| --- | --- |
| `npm run verify:robinhood` | Mainnet reads and unsigned issuance simulations |
| `npm run test:first-buy-payment-fork` | Real LI.FI same-chain swaps and min-output failures on fresh isolated Base/RH forks; requires Anvil and the server-side LI.FI configuration |
| `npm run test:robinhood-fork` | Isolated creation, trades, claims and recovery; requires Anvil |
| `npm run test:musegod-fork` | Router/source executable-code correspondence and isolated native ETH buy/approve/sell, refunds and failure rollback; requires Anvil |
| `npm run test:musegod-http` | Running read-only local Node server on 5192, real MUSEGOD quotes and Bankr snapshots; uses local storage for acceptance |
| `npm run test:http` | Running local server with valid treasury; mainnet reads and unsigned simulations |
| `npm run verify:database` | Database persistence and backup/restore in isolated scopes |

`npm test` runs the native Worker boundary in workerd. The migration test uses a disposable, network-isolated PostgreSQL container with a pinned image; it skips locally if Docker or the image is absent. CI pulls the pinned image before tests. Neither test accesses production.

Fork results and public deployment checks **do not prove real-wallet mainnet execution**. See [chain acceptance](docs/evidence/robinhood-acceptance.md).

The MUSEGOD integration uses its existing SushiSwap v3 MUSEGOD/WETH pool. Native ETH wraps/unwraps in each trade; the pool fee is 1% and the site adds no trading fee. Homepage recommendations remain separate from registered launch records and creator rewards. See [integration specification](docs/SPEC.md#musegod-featured-token-and-native-eth-trading) and [router/fork evidence](docs/evidence/musegod-fork.json).

## Cloudflare

Configuration: [wrangler.jsonc](wrangler.jsonc). The source dispatches chain-scoped APIs to separate `base-mainnet` and `robinhood-mainnet` Durable Objects, each with its canonical Supabase scope. The retained Robinhood name preserves its alarms/recovery. Fork mode serves only the configured deployment and uses isolated SQLite on 31337.

Before an authorized publication, configure `ALCHEMY_API_KEY`, `SUPABASE_SECRET_KEY`, `PINATA_JWT`, private `LIFI_API_KEY`, `TURNSTILE_SECRET_KEY` and `PLAN_ATTESTATION_KEY` (at least 32 random characters; without it, launches recovered from local backups are listed with an unverified opening valuation) as Worker secrets; keep `LIFI_INTEGRATOR=musegodfun` and `TURNSTILE_SITE_KEY` public. Configure the Turnstile site for both production hosts. Workers read native bindings on every request and alarm; changed or removed bindings rebuild the runtime without copying into `process.env`. Workers do not read `.env`; local workerd secrets can go in ignored `.dev.vars`. Keep secrets out of Git and frontend configuration.

Worker previews use their configured flags and the selected database’s persistent control. `.env` does not override Worker configuration. A committed configuration change can promote automatically; an unchanged Git value cannot silently overwrite a live emergency configuration change. Publication never updates or resumes the persistent stop record. The automatic code release preserves the configured Secret inventory.

Ingress normalizes IPv6 clients to /64 and bounds its LRU map. Per-source capacity is 180 total requests/minute, 20 expensive requests/minute and 16 concurrent requests; shared ingress concurrency is 64 per chain runtime. In-flight counts are independent of minute windows and LRU rows; the four-slot limit applies to prepare scheduling, not all page reads. Visible verification uses a separate sustained-workflow signal: the 17th prepare/simulate/payment-quote request in a rolling minute, the 41st in five minutes, or the seventh image upload in five minutes. Price display requests consume capacity but do not themselves prompt verification. A normal 8–12-call conversion/launch with refreshes has no challenge. No caller-supplied intent or request ID exempts capacity or challenge checks; successful verification permits that source for five minutes. Risky requests without configured Turnstile receive a recoverable response. Ingress runs before request bodies.

Preparation uses four concurrent slots shared across both chains, up to eight local queued requests for two seconds, and identical in-flight requests share work. Slots renew while the SDK runs; abandoned slots expire in four minutes. Retries with the same `x-request-id` and canonical body reuse a completed preview for five minutes in the current runtime. Distinct requests can refresh. Shared prepare budget is 40/minute and 2,000/day; LI.FI budget is 80/minute and 9,600/two hours. Twenty percent of those budgets is reserved for preparation with a verified matching payment receipt, never a caller-provided priority flag. Token prices cache for 30 seconds without extending source timestamps, opening probes for ten seconds without extending expiry, and upstream `Retry-After` opens a shared durable circuit.

`workers_dev:false` expresses the intended ingress configuration. Version uploads do not apply account routes, `workers.dev`, WAF rules or Turnstile setup; these remain explicit external setup and verification steps before go-live.

```sh
npm run build
npm run dev:cloudflare        # local Worker preview
```

### Automatic releases and source verification

Every push to `master` runs the GitHub Actions production workflow. It checks out the exact pushed commit, uses Node **24.11.1** and `npm ci`, runs tests/build/Worker dry run, then publishes the same frontend files. Production runs are serialized; an outdated commit is skipped before activation.

One-time setup:

1. Enable **Settings → Releases → Enable release immutability** in this repository.
2. Add **`CLOUDFLARE_API_TOKEN`** as a GitHub Actions repository secret. Scope the token to the existing `musegod-fun` Worker with **Editor** access. No DNS/Routes permission is needed. The account ID is already in `wrangler.jsonc`.
3. Keep the existing application secrets configured on Cloudflare. They are not needed by the frontend build and must not be copied to GitHub build variables.

The workflow uploads a candidate Worker version tagged with the full commit SHA, then publishes an immutable GitHub Release named `build-<runID>-<attempt>`. Its tag points to that exact commit; attachments contain `frontend.tar.gz`, `build-info.json` and `release.json`. The release is a **build record**; the GitHub `production` Deployment status records whether it was activated and verified. After activation, CI allows up to three complete verification attempts with 60 seconds between attempts for edge and Durable Object code propagation. Both production domains must pass artifact hashes, runtime safety protocol/control revision, effective signing flags, curve, guard and fee-engine policy checks in the same attempt before deployment is marked successful. Read-only functional checks cover LI.FI prices, verified launch assets and a trade quote when the launch catalog is nonempty; an empty catalog records the trade quote as `not_run`. Frozen artifact or active-version changes stop verification immediately. Failed activation or exhausted verification attempts roll back only to a version with runtime safety protocol 1 that cannot re-enable a signing flag disabled by the failed candidate. Rollback verification retries the complete pair of domains with the same bounded schedule. Before upload and again immediately before activation, CI requires a compatible rollback baseline. Base rollback requires compatible recovery protocol 7 metadata and the reviewed fee policy; existing abandoned-signature and retryable-evidence accounting remains required. Retired pristine history scanning and its CI cache are removed. Rollback smoke inspects the pinned old source and skips only a summary route that the old version did not contain; current candidates always require it. Robinhood permissions and all other smoke gates remain unchanged. An incompatible previous version reports `blocked_by_safety` before upload, leaving current production unchanged. The first protocol upgrade requires a separately authorized, reviewed and verified paused compatibility baseline with working registration/history/lock recovery; capture its version as the rollback point before normal automatic promotion. Never relabel legacy code as protocol 1 or restore code that ignores persistent stop controls. No manual approval stage is added to normal releases. The independent verifier below performs one strict check and does not retry.

The footer's **Source** link identifies the commit embedded in the bundle loaded by your browser. **Verify build** opens its immutable release. `GET /build-info.json` contains the full commit, run/release links and SHA-256 for every frontend file except the manifest itself. HTML requires cache revalidation; the manifest is not cached. HTML and manifest responses expose `X-Source-Commit` and `X-Worker-Version` from Cloudflare version metadata. Local builds are labeled **Local build**, including **(dirty)** when their source differs from HEAD.

To independently verify a release, use a checkout of its source commit and run:

```sh
npm ci
npm run verify:deployment -- --release build-RUN_ID-ATTEMPT --origin https://musegod.fun
npm run verify:deployment -- --release build-RUN_ID-ATTEMPT --origin https://www.musegod.fun
```

The verifier gets the locked tag and trusted manifest from GitHub, checks the release attachment digests, compares the online manifest bytes, checks Worker version/commit headers, and downloads every listed frontend file to compare SHA-256 after HTTP decompression. It also checks the homepage and `/create` HTML. Any mismatch, missing resource or unexpected redirect fails with a nonzero exit code. This verifies correspondence to the GitHub build; it does not establish code safety.

`npm run deploy:cloudflare` is the CI-only publication entry point and consumes the already built artifact. Local publishing that rebuilds or bypasses the public release record is no longer the normal release path. Database changes, Durable Object lifecycle migrations, routes/domains and application-secret changes require a separate release procedure; the automatic workflow does not apply them. The workflow never commits acceptance evidence back to `master`.

Base public issuance is operational under the owner's authorization. It remains independent from the fee keeper. The immutable Collector sends its genuine paired-asset and new-token fees only to the dedicated Splits Automation account; native Relay settlement goes to Robinhood's existing Treasury, Forwarder and protected shared Vault. The existing fee shares and account-owner/provider trust remain explicit. Small balances or missing routes can remain pending. Unknown recovery uses a separate budget (zero by default), eligible assets, minimum raw amounts and durable cooldown, and never counts as genuine fee income.

Round 10 removes continuous custody/Vault ledgers, FIFO source attribution, D3 bridge proofs, source replay, candidate scans and display projections from production. Historical database tables and rows remain read-only; backups preserve them. Base displays per-asset Collector claimed/released/untracked counters and Automation balances. Robinhood displays aggregate Treasury/Vault/dead-address quantities from all sources. Both groups cache for five minutes; shared burns are never attributed entirely to Base or described as an ERC-20 totalSupply reduction.

`npm run audit:base -- --once` performs a read-only wallet-free host round; omit `--once` for its five-minute audit loop. Each round reads grouped counters and previews at most two registered pools in a fair rotation. Funded releases precede claims, and a claim's conservative paired-asset value must exceed its complete gas reservation. Shared single-attempt or per-task failed-gas limits, insufficient fuel, paused Collector or unavailable permissions defer the task without terminating the process. Both keepers reference `KEEPER_TASK_RETRY_POLICY`: a complete single-attempt reserve above 0.002 ETH is skipped, and 0.001 ETH of failed gas in a task's rolling 24-hour window defers that task. Genuine Base execution has no lifetime gas ceiling; historical nonce/gas journals remain intact. Fifteen-minute amount monitoring writes a stuck-funds alert after twenty-four hours; it never transfers funds. Both keepers also warn to stdout and private alerts when wallet fuel falls below three measured transaction reserves; notification failures do not affect execution. Nonce/hash/gas reservations, canonical own-transaction recovery and abandoned-before-broadcast safeguards remain durable.

The tracked Base `scripts/base-keeper-wrapper.mjs` takes a private `--config=ABSOLUTE_PATH` containing operator/environment paths and an exact released tag/commit. It requires a clean detached release checkout outside developer worktrees. Audit children receive no wallet key. Execution requires the persisted manifest/code-bound startup seal plus both explicit owner switches; live Collector/Automation permissions are checked before signing and broadcasting. This local repair does not change host execution mode or its existing owner controls. No production wrapper installation or new service purchase is included.

The separate `scripts/rh-keeper-wrapper.mjs` prepares Robinhood on the same released checkout, defaulting to dry-run. Its private 0700 cwd has no `.env`; only the existing Alchemy key and reviewed API origin reach the child, with the fixed D3 signing key injected only after explicit execution approval. An explicit journal handoff preserves original bytes and leaves a source fence; it is not performed by a normal start. `KeeperSigningStopped`/locks require manual handling and do not enter a launchd restart loop. Neither supervisor is installed or armed by this source repair. See SPEC for the exact exit handling and installation order. Shared launchd policy uses `ThrottleInterval: 300` and `ExitTimeOut: 120`; manual signing stops are not automatically restarted.

Both production chains require the existing chain-scoped Alchemy key. Missing keys reject startup; public/archive provider splitting and remote/local trace dependencies are removed. Read-only 429 failures have bounded jittered retries; broadcasts are never blindly retried. Each round logs method-level CU and RPC counts, including batch entries and retries. Worker display RPC/config and graph reads use singleflight caches; every config/readiness request reads its live signing control once without RPC. MUSEGOD info caches for sixty seconds while quotes retain fresh state and a canonical block check; display engine failures back off from sixty seconds. Transaction paths retain current authorization. Immutable contract identities persist once per exact manifest/code binding, with failed identity checks backing off for at least sixty seconds.

`npm run verify:base` is an explicit one-time operator command using a private local immutable seal. Its `--record-activation` option is separately authorized metadata writing after full fresh graph/signature checks; it never signs or enables Base. The completed launch record is read without replay during issuance. The first genuine fee flow receives one archived manual receipt report; no recurring proof, manufactured-fee test or trace subscription is required. See [SPEC](docs/SPEC.md#base-go-live-lightweight-splits-treasury-and-native-automation) for the exact permission checks, trust boundary and rollback procedure.

`/readyz` distinguishes `expected_pause`, `signing_dependency_unavailable`, `site_unavailable` and `operational`, with current control revision. Reference-price endpoints may report partial unknown assets without changing whole-site readiness. External monitors must combine this status with price/route health and alert on meaningful sustained changes; monitor setup is an external go-live step, not evidence supplied by unit tests.

## Backup and recovery

```sh
mkdir -p .data/backups
npm run db:backup -- .data/backups/robinhood-backup.json robinhood
npm run db:restore -- .data/backups/robinhood-backup.json restore-robinhood-check
```

Restore requires a new, empty `restore-` scope and never overwrites production. Compact plan storage retains full canonical calldata and reads old full payloads. Ordinary validation/simulation does not protect plans from the existing 30-day unsigned cleanup; the actual wallet handoff sends `signing:true`. Protected and unknown plans are not age-pruned; recovery queues retain backoff/finality metadata, and burn-index/Pinata cache snapshots survive cleanup. Runtime safety controls and global provider budgets are independent operational state, excluded from application backup/restore; a restored scope starts paused. Validate copies through the database CLI's explicit isolated-scope checks: dual-chain Web runtimes always read canonical `base` / `robinhood` scopes, so a restored copy is not Web acceptance. Keep original receipts; later transaction hashes may need rechecking. `/launch/register` accepts the frozen `recoveryPlan`, validates its envelope and re-encodes/canonical-checks the transaction in the service. Only this recovery route allows a bounded 256 KiB body; Node and Worker retain 64 KiB for other requests.

**Stop new signing:** use the service-role CLI against the intended database, independent of a code release. It exposes no public management API. Read the current revision, then supply it with an audit reason; concurrent or stale updates fail instead of overwriting another operator’s change.

```sh
npx tsx scripts/runtime-control.ts status 4663
npx tsx scripts/runtime-control.ts pause 4663 CURRENT_REVISION "incident reason"
# Read the revision again before any intentional reactivation:
npx tsx scripts/runtime-control.ts resume 4663 CURRENT_REVISION "activation reason"
```

Repeat for `8453` when both chains must be stopped, and read both `/api/chains/:chainId/config` endpoints to confirm `signingPaused:true` and `writesEnabled:false`. Normal deploys and compatible rollbacks preserve this record. Missing database state defaults paused. Already broadcast transactions, receipt registration and direct lock lookup/recovery remain available; a stop cannot revoke an existing wallet request or on-chain transaction.

**Roll back:** keep the additive migration and all safety-control records in place. Use only a recorded version that supports the release manifest’s `minimumSecurityProtocol` (currently 1) and preserves the stricter signing flags, then verify both domains, hashes, readiness, controls and functional reads. Historical [rollback evidence](docs/evidence/cloudflare-acceptance.md) records older versions; those versions are not compatible rollback targets after compact plan storage and independent stop controls are introduced. Preserve database scopes, protected plans, receipts and Pinata pins. Runtime rollback cannot change deployed pools or token metadata.

## Details

- [Product, pricing, fees and runtime rules](docs/SPEC.md)
- [Fixed-opening local checks](docs/evidence/fixed-opening-acceptance.json) · [production checks](docs/evidence/fixed-opening-production.json)
- [Image-upload verification](docs/evidence/token-image-pinata.json)
