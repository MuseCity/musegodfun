# musegod.fun

A non-custodial meme launchpad built with Doppler and Uniswap v4. The current source supports **Base (8453)** and **Robinhood Chain (4663)**.

- **Launch, trade, claim fees.** Every transaction needs confirmation in your selected wallet; the server never holds private keys or broadcasts transactions.
- **Paired assets:** 36 Coinbase B20 assets on Base; 192 assets on Robinhood with tested same-chain LI.FI routes. ST0x and Backed are excluded. The complete 198-asset Robinhood registry remains available for existing tokens and transaction recovery.
- **$5,000 initial valuation target.** Both chains use the existing 97/3 curve and LI.FI buy/sell quote references. Price snapshots expire after 60 seconds; the optional first buy moves price above the initial boundary.
- **Optional first buy and lock.** Pay with the paired asset, chain-specific stablecoins or native ETH, then optionally lock the purchase for 30/90/365 days.

**Status:** Website releases follow the verified master-push workflow below. The configured production guard remains the verified legacy Robinhood revision, supporting unlocked first buys; Base signing is off, and new vesting guards on both chains remain `not_run`. Locking is available only with a separately deployed and verified vesting guard. LI.FI uses a private Worker Secret, configured separately from the immutable code release. Local fork funding/receipts do not prove real-wallet mainnet execution. [Production deployments](https://github.com/MuseCity/musegodfun/deployments) identify the build active at [musegod.fun](https://musegod.fun). Existing MUSEGOD trading/market behavior and fee/buyback policy remain described in [SPEC](docs/SPEC.md); ordinary Robinhood launch market history and Base fee bridging remain unavailable/deferred.

## Start locally

Requires **Node.js 24.11+**.

1. Create `.env` from [.env.example](.env.example) if you don't already have one.
2. Fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Use `ALCHEMY_API_KEY` with the intended networks enabled, or the separate `BASE_RPC_URL` / `ROBINHOOD_RPC_URL` values without an Alchemy key. Supabase Web scopes are fixed to `base` and `robinhood`; this change needs no SQL migration.
3. For a fresh database, apply the [initial migration](supabase/migrations/20261005000537_musegod_store.sql).
4. Run:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5188**. In another terminal, check readiness:

```sh
curl -fsS http://127.0.0.1:5188/readyz
```

Keep `ENABLE_MAINNET_TRANSACTIONS=false`, `ENABLE_BASE_TRANSACTIONS=false` and any explicit `ENABLE_ROBINHOOD_TRANSACTIONS=false` for read-only development. Base cannot inherit Robinhood's write flag or guard address. Signing also requires a valid `PLATFORM_TREASURY`; guards are exposed only after runtime/dependency verification. Restart Node after server or environment changes. Create selects the deployment with `/create?chainId=8453|4663`, default Robinhood. Scoped APIs use `/api/chains/:chainId/...`; token URLs use `/token/base/:address` or `/token/robinhood/:address`. Legacy token links and production unscoped APIs retain Robinhood meaning.

For a local production build, run `npm run build`, then `npm start`.

## First-buy payments and locks

The **Your first buy (optional)** module follows [Stonx](https://stonx.ai/create): payment selector, amount, ERC20 balance fill, estimated USD value and $10/$20/$50/$100 shortcuts. Base permits the paired asset, USDC, USDT and native ETH; Robinhood permits the paired asset, canonical USDG and native ETH. Exact addresses are pinned in [SPEC](docs/SPEC.md#issuance-and-trading). USD shortcuts use LI.FI token display estimates; opening prices are calculated separately from fixed buy/sell quote probes, independently of the user's first-buy amount. Native Max is disabled when a complete gas reserve is unavailable.

Set server-only `LIFI_API_KEY` and `LIFI_INTEGRATOR=musegodfun` for opening-price and conversion quotes. Opening prices use 100 USDC on Base or 100 USDG on Robinhood, followed by a reverse quote for the actual quoted output. USDG itself uses native ETH sized near $100 from LI.FI's ETH reference. The midpoint removes only explicit LI.FI input fees; DEX costs and price impact remain. Each leg uses LI.FI's numeraire USD reference without assuming a stablecoin is $1. Missing, invalid, expired or more than 5% divergent buy/sell quotes stop preparation; there is no Chainlink, Robinhood-price or TWAP fallback for new launches. The earliest probe request starts the 60-second validity window. The recorded canonical RPC block proves asset identity, not quote execution. Before conversion, the server verifies dependencies and this LI.FI opening reference without creating a launch plan; launch preparation obtains fresh quotes again. Conversion is confirmed before the separate guarded launch. If launch fails, previously converted quote tokens stay in the user's wallet. Historical oracle snapshots remain readable and recover already broadcast transactions; they cannot authorize a new signature. Saved hashes and frozen calls recover without payment resubmission, even after expiry.

New Create pairs use the [original verified route snapshot](docs/evidence/lifi-launch-pairs.json), checked on 2026-10-07 (Asia/Shanghai), rather than LI.FI's token directory alone. At least one supported payment currency must produce an inbound quote accepted by the existing payment reader, with a reverse same-chain quote to a stablecoin or WETH. SATS, BND, FISV, LHX, NAVN and SCHD are omitted from new launches because the tested amounts lacked complete two-way evidence; this does not establish permanent LI.FI exclusion. MUSEGOD remains eligible despite its absence from the default token directory. Quotes vary with currency, amount and time and are checked again before payment. Removed-pair drafts keep their metadata but reset the first-buy amount and lock; submitted payments retain their original recovery record and received asset.

The original route snapshot captured ten Base pairs and the preceding Reader revision; its policy/hash fields remain historical. Current Base identities and opening probes are recorded separately below.

The extended [Base stock audit](docs/evidence/lifi-base-stock-audit/index.json) covers 164 official catalog addresses: Coinbase B20 92, current wrapped ST0x 55 and legacy Backed 17. Base pairing is limited to its 36 identity-matched Coinbase candidates with bidirectional USDC quotes; ST0x and Backed remain excluded. The audit records its original ten-asset Create scope. The current source adds the other 26 official Coinbase identities and uses LI.FI opening quotes, removing the per-asset feed requirement. Dinari's complete Base address catalog remains unverified. Route and price availability are checked again at preview time. The [native Worker transport check](docs/evidence/lifi-workerd-fetch.json) records the initial production smoke failure, rollback and receiver fix; earlier route/Node snapshots keep their original source hashes. The [LI.FI opening-source acceptance](docs/evidence/lifi-opening-price/index.json) tests all 228 current pairs: 15/36 Base and 115/192 Robinhood passed the fixed pricing probe; the other 98 were rejected for wide buy/sell divergence or unavailable probe routes. Base $10 USDC payment quotes passed for all 36. These dated samples are expired; a route-eligible pair still needs a valid opening reference at preparation time.

**Lock your first buy** defaults off and supports 30/90/365 days. Official Bundler holds the purchase until a cliff equal to the full duration; it does not release gradually. The recorded recipient alone may claim after unlock. Missing or unverified vesting guard disables locking; the deployed legacy guard continues to support unlocked buys. [Guard deployment status and rollback](docs/launch-guard-deployment.md) distinguish prepared source/fork evidence from mainnet deployment.

## Token images

On `/create`, upload PNG/JPG/WebP/GIF up to **5 MiB**, or use a public HTTPS URL. Uploads become WebP images of at most 512 × 512 and 40 KiB; GIFs use the first frame.

Uploads require server-only `PINATA_JWT` in every runtime. Images go to public IPFS through Pinata; keep them pinned. Backups contain image URLs, not image bytes. Failed uploads preserve the previous image.

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

Fork results and public deployment checks **do not prove real-wallet mainnet execution**. See [chain acceptance](docs/evidence/robinhood-acceptance.md).

The MUSEGOD integration uses its existing SushiSwap v3 MUSEGOD/WETH pool. Native ETH wraps/unwraps in each trade; the pool fee is 1% and the site adds no trading fee. Homepage recommendations remain separate from registered launch records and creator rewards. See [integration specification](docs/SPEC.md#musegod-featured-token-and-native-eth-trading) and [router/fork evidence](docs/evidence/musegod-fork.json).

## Cloudflare

Configuration: [wrangler.jsonc](wrangler.jsonc). The source dispatches chain-scoped APIs to separate `base-mainnet` and `robinhood-mainnet` Durable Objects, each with its canonical Supabase scope. The retained Robinhood name preserves its alarms/recovery. Fork mode serves only the configured deployment and uses isolated SQLite on 31337.

Before an authorized publication, configure `ALCHEMY_API_KEY`, `SUPABASE_SECRET_KEY`, `PINATA_JWT` and the private `LIFI_API_KEY` as Worker secrets; keep `LIFI_INTEGRATOR=musegodfun` as public configuration. Workers do not read `.env`; local workerd secrets can go in ignored `.dev.vars`. Keep secrets out of Git and frontend configuration.

Worker previews use their configured flags: existing Robinhood `ENABLE_MAINNET_TRANSACTIONS` is currently `true`, while Base remains off unless its separate flag is explicitly enabled. `.env` does not override Worker configuration. Code publication preserves those signing flags and guard addresses. The LI.FI API key is added through the separate private-Secret workflow; the automatic code release preserves the configured Secret inventory.

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

The workflow uploads a candidate Worker version tagged with the full commit SHA, then publishes an immutable GitHub Release named `build-<runID>-<attempt>`. Its tag points to that exact commit; attachments contain `frontend.tar.gz`, `build-info.json` and `release.json`. The release is a **build record**; the GitHub `production` Deployment status records whether it was activated and verified. After activation, CI allows up to three complete verification attempts with 60 seconds between attempts for edge and Durable Object code propagation. Both production domains must pass artifact and runtime checks in the same attempt before deployment is marked successful. Frozen artifact or active-version changes stop verification immediately. Failed activation or exhausted verification attempts trigger a rollback to the previously recorded Worker version and report the rollback result. The independent verifier below performs one strict check and does not retry.

The footer's **Source** link identifies the commit embedded in the bundle loaded by your browser. **Verify build** opens its immutable release. `GET /build-info.json` contains the full commit, run/release links and SHA-256 for every frontend file except the manifest itself. HTML requires cache revalidation; the manifest is not cached. HTML and manifest responses expose `X-Source-Commit` and `X-Worker-Version` from Cloudflare version metadata. Local builds are labeled **Local build**, including **(dirty)** when their source differs from HEAD.

To independently verify a release, use a checkout of its source commit and run:

```sh
npm ci
npm run verify:deployment -- --release build-RUN_ID-ATTEMPT --origin https://musegod.fun
npm run verify:deployment -- --release build-RUN_ID-ATTEMPT --origin https://www.musegod.fun
```

The verifier gets the locked tag and trusted manifest from GitHub, checks the release attachment digests, compares the online manifest bytes, checks Worker version/commit headers, and downloads every listed frontend file to compare SHA-256 after HTTP decompression. It also checks the homepage and `/create` HTML. Any mismatch, missing resource or unexpected redirect fails with a nonzero exit code. This verifies correspondence to the GitHub build; it does not establish code safety.

`npm run deploy:cloudflare` is the CI-only publication entry point and consumes the already built artifact. Local publishing that rebuilds or bypasses the public release record is no longer the normal release path. Database changes, Durable Object lifecycle migrations, routes/domains and application-secret changes require a separate release procedure; the automatic workflow does not apply them. The workflow never commits acceptance evidence back to `master`.

## Backup and recovery

```sh
mkdir -p .data/backups
npm run db:backup -- .data/backups/robinhood-backup.json robinhood
npm run db:restore -- .data/backups/robinhood-backup.json restore-robinhood-check
```

Restore requires a new, empty `restore-` scope and never overwrites production. Validate copies through the database CLI's explicit isolated-scope checks: dual-chain Web runtimes always read canonical `base` / `robinhood` scopes, so a restored copy is not Web acceptance. Keep original receipts; later transaction hashes may need rechecking.

**Stop new signing:** stop Node, set both network write flags false (including any explicit Robinhood override), then restart. On Cloudflare, change the relevant public flags, publish only with release authorization and verify each `/api/chains/:chainId/config` returns `writesEnabled:false`. Already broadcast transactions still recover; disabling signing cannot revoke an existing wallet request or on-chain transaction.

**Roll back:** follow the [verified version and rollback command](docs/evidence/cloudflare-acceptance.md). Preserve database scopes, receipts and Pinata pins. Runtime rollback cannot change deployed pools or token metadata.

## Details

- [Product, pricing, fees and runtime rules](docs/SPEC.md)
- [Fixed-opening local checks](docs/evidence/fixed-opening-acceptance.json) · [production checks](docs/evidence/fixed-opening-production.json)
- [Image-upload verification](docs/evidence/token-image-pinata.json)
