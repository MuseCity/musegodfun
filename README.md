# musegod.fun

A non-custodial meme launchpad built with Doppler and Uniswap v4. The current source supports **Base (8453)** and **Robinhood Chain (4663)**.

- **Launch, trade, claim fees.** Every transaction needs confirmation in your selected wallet; the server never holds private keys or broadcasts transactions.
- **New Create pairs:** 15 Coinbase B20 assets on Base and 115 assets on Robinhood, selected from the successful LI.FI opening-price audit. ST0x and Backed are excluded. The complete identity registries retain 36 Base assets and 198 Robinhood assets for existing tokens and transaction recovery.
- **$5,000 initial valuation target.** Both chains use the existing 97/3 curve and LI.FI buy/sell quote references. Price snapshots expire after 60 seconds; the optional first buy moves price above the initial boundary.
- **Optional first buy and lock.** Pay with the paired asset, chain-specific stablecoins or native ETH, then optionally lock the purchase for 30/90/365 days.

**Status:** Website releases follow the verified master-push workflow below. The [V2 vesting guards](docs/launch-guard-deployment.md) are deployed and source-verified on both mainnets, and configured for optional 30/90/365-day first-buy locks. The source keeps Robinhood’s public signing flag enabled and Base’s disabled; effective signing also requires the separate persistent control to be resumed. The new control defaults to paused. This local change has not been deployed and does not establish the current production signing state. LI.FI uses a private Worker Secret, configured separately from the immutable code release. Local fork funding/receipts do not prove real-wallet mainnet execution. [Production deployments](https://github.com/MuseCity/musegodfun/deployments) identify the build active at [musegod.fun](https://musegod.fun). Existing MUSEGOD trading/market behavior and fee/buyback policy remain described in [SPEC](docs/SPEC.md); ordinary Robinhood launch market history and Base fee bridging remain unavailable/deferred.

## Start locally

Requires **Node.js 24.11+**.

1. Create `.env` from [.env.example](.env.example) if you don't already have one.
2. Fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Use `ALCHEMY_API_KEY` with the intended networks enabled, or the separate `BASE_RPC_URL` / `ROBINHOOD_RPC_URL` values without an Alchemy key. Supabase Web scopes are fixed to `base` and `robinhood`; the server uses the service role only.
3. For a fresh database, apply the [initial migration](supabase/migrations/20261005000537_musegod_store.sql), then the additive [runtime safety migration](supabase/migrations/20261007094402_runtime_safety_controls.sql). Existing databases need only the latter. Apply and verify it before publishing the new runtime; no anonymous or authenticated-user permissions are added.
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

New Create pairs use only the 15 Base and 115 Robinhood addresses that passed the complete [LI.FI opening-price audit](docs/evidence/lifi-opening-price/index.json), checked on 2026-10-07 (Asia/Shanghai). Route discovery alone no longer qualifies a pair. The [original verified route snapshot](docs/evidence/lifi-launch-pairs.json) established same-chain inbound and reverse routes; its earlier eligibility decisions remain historical. SATS, BND, FISV, LHX, NAVN and SCHD lacked complete two-way route evidence, and another 98 route candidates failed the opening-price probe. These dated failures do not establish permanent LI.FI exclusion. MUSEGOD remains eligible despite its absence from the default token directory. Every preparation and payment preflight still obtains fresh quotes and enforces the current price-quality gate. Removed-pair drafts keep their metadata but reset the first-buy amount and lock; submitted payments retain their original recovery record and received asset.

The original route snapshot captured ten Base pairs and the preceding Reader revision; its policy/hash fields remain historical. Current Base identities and opening probes are recorded separately below.

The extended [Base stock audit](docs/evidence/lifi-base-stock-audit/index.json) covers 164 official catalog addresses: Coinbase B20 92, current wrapped ST0x 55 and legacy Backed 17. Its 36 identity-matched Coinbase candidates with bidirectional USDC quotes remain in the complete Base registry; new Create selects only the 15 that also passed the opening-price audit. ST0x and Backed remain excluded. The audit records its original ten-asset Create scope. The issuer registry retains the other 26 official Coinbase identities, and LI.FI opening quotes replace the per-asset feed requirement. Dinari's complete Base address catalog remains unverified. Route and price availability are checked again at preview time. The [native Worker transport check](docs/evidence/lifi-workerd-fetch.json) records the initial production smoke failure, rollback and receiver fix; earlier route/Node snapshots keep their original source hashes. The [LI.FI opening-source acceptance](docs/evidence/lifi-opening-price/index.json) tested the preceding 228 route candidates: 15/36 Base and 115/192 Robinhood passed the fixed pricing probe; the other 98 were rejected for wide buy/sell divergence or unavailable probe routes. Base $10 USDC payment quotes passed for all 36. These historical quantities and hashes remain unchanged. The 130 passing addresses now form the new Create whitelist, but their expired audit samples never replace the fresh opening reference required at preparation time.

**Lock your first buy** defaults off and supports 30/90/365 days. Official Bundler holds the purchase until a cliff equal to the full duration; it does not release gradually. The recorded recipient alone may claim after unlock. Missing or unverified vesting guard disables locking; the deployed legacy guard continues to support unlocked buys. [Guard deployment status and rollback](docs/launch-guard-deployment.md) distinguish prepared source/fork evidence from mainnet deployment.

## Token images

On `/create`, upload PNG/JPG/WebP/GIF up to **5 MiB**, or use a public HTTPS URL. Uploads become WebP images of at most 512 × 512 and 40 KiB; GIFs use the first frame.

Uploads require server-only `PINATA_JWT` in every runtime. Images go to public IPFS through Pinata; keep them pinned. A content-hash cache reuses successful uploads in the same database scope, and both chains share a durable 100-upload daily budget. Cached uploads spend no additional provider budget. Backups contain image URLs and cache records, not image bytes. Failed uploads preserve the previous image.

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

The workflow uploads a candidate Worker version tagged with the full commit SHA, then publishes an immutable GitHub Release named `build-<runID>-<attempt>`. Its tag points to that exact commit; attachments contain `frontend.tar.gz`, `build-info.json` and `release.json`. The release is a **build record**; the GitHub `production` Deployment status records whether it was activated and verified. After activation, CI allows up to three complete verification attempts with 60 seconds between attempts for edge and Durable Object code propagation. Both production domains must pass artifact hashes, runtime safety protocol/control revision, effective signing flags, curve, guard and fee-engine policy checks in the same attempt before deployment is marked successful. Read-only functional checks cover LI.FI prices, verified launch assets and a trade quote when the launch catalog is nonempty; an empty catalog records the trade quote as `not_run`. Frozen artifact or active-version changes stop verification immediately. Failed activation or exhausted verification attempts roll back only to a version with runtime safety protocol 1 that cannot re-enable a signing flag disabled by the failed candidate. Rollback verification retries the complete pair of domains with the same bounded schedule. Before upload and again immediately before activation, CI requires a compatible rollback baseline. An incompatible previous version reports `blocked_by_safety` before upload, leaving current production unchanged. The first protocol upgrade requires a separately authorized, reviewed and verified paused compatibility baseline with working registration/history/lock recovery; capture its version as the rollback point before normal automatic promotion. Never relabel legacy code as protocol 1 or restore code that ignores persistent stop controls. No manual approval stage is added to normal releases. The independent verifier below performs one strict check and does not retry.

The footer's **Source** link identifies the commit embedded in the bundle loaded by your browser. **Verify build** opens its immutable release. `GET /build-info.json` contains the full commit, run/release links and SHA-256 for every frontend file except the manifest itself. HTML requires cache revalidation; the manifest is not cached. HTML and manifest responses expose `X-Source-Commit` and `X-Worker-Version` from Cloudflare version metadata. Local builds are labeled **Local build**, including **(dirty)** when their source differs from HEAD.

To independently verify a release, use a checkout of its source commit and run:

```sh
npm ci
npm run verify:deployment -- --release build-RUN_ID-ATTEMPT --origin https://musegod.fun
npm run verify:deployment -- --release build-RUN_ID-ATTEMPT --origin https://www.musegod.fun
```

The verifier gets the locked tag and trusted manifest from GitHub, checks the release attachment digests, compares the online manifest bytes, checks Worker version/commit headers, and downloads every listed frontend file to compare SHA-256 after HTTP decompression. It also checks the homepage and `/create` HTML. Any mismatch, missing resource or unexpected redirect fails with a nonzero exit code. This verifies correspondence to the GitHub build; it does not establish code safety.

`npm run deploy:cloudflare` is the CI-only publication entry point and consumes the already built artifact. Local publishing that rebuilds or bypasses the public release record is no longer the normal release path. Database changes, Durable Object lifecycle migrations, routes/domains and application-secret changes require a separate release procedure; the automatic workflow does not apply them. The workflow never commits acceptance evidence back to `master`.

The V2 automated buyback graph remains unpublished until its graph-bound activation proof passes. Source/runtime verification alone is insufficient. See the [deployment, treasury signatures, native Automation proof and rollback checklist](contracts/README.md#deployment-and-activation-runbook). The 0.01 WETH rolling 300-second cap applies to all funds managed by the new Vault; historical pools/old contracts and third-party direct Swapper deposits retain their explicit boundaries.

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
