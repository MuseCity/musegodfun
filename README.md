# musegod.fun

A non-custodial meme launchpad on **Robinhood Chain (4663)**, built with Doppler and Uniswap v4.

- **Launch, trade, claim fees.** Every transaction needs confirmation in your selected wallet; the server never holds private keys or broadcasts transactions.
- **198 paired assets:** 194 stocks/ETFs plus WETH, USDG, cbBTC and MUSEGOD.
- **$5,000 opening market-cap target.** Preview prices expire after five minutes. Tick rounding and later asset-price changes affect actual USD value.

**Status:** Published at [musegod.fun](https://musegod.fun). Real-wallet mainnet transactions remain unverified. Robinhood market history is unavailable; on-chain quotes work independently. Buyback and Base fee bridging are deferred. Base mode retains historical receipt recovery.

## Start locally

Requires **Node.js 24.11+**.

1. Create `.env` from [.env.example](.env.example) if you don't already have one.
2. Fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Use `ALCHEMY_API_KEY` with Robinhood Mainnet enabled, or `ROBINHOOD_RPC_URL` without an Alchemy key.
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

Keep `ENABLE_MAINNET_TRANSACTIONS=false` for read-only development. Signing also requires a valid `PLATFORM_TREASURY`. Restart Node after server or environment changes.

For a local production build, run `npm run build`, then `npm start`.

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
| `npm run test:robinhood-fork` | Isolated creation, trades, claims and recovery; requires Anvil |
| `npm run test:http` | Running local server with valid treasury; mainnet reads and unsigned simulations |
| `npm run verify:database` | Database persistence and backup/restore in isolated scopes |

Fork results and public deployment checks **do not prove real-wallet mainnet execution**. See [chain acceptance](docs/evidence/robinhood-acceptance.md).

## Cloudflare

Configuration: [wrangler.jsonc](wrangler.jsonc). One Durable Object serves the backend; Supabase stores application data. Fork mode uses isolated local SQLite.

Before publishing, authenticate Wrangler and configure `ALCHEMY_API_KEY`, `SUPABASE_SECRET_KEY` and `PINATA_JWT` as secrets. Workers do not read `.env`; local workerd secrets can go in ignored `.dev.vars`. Keep secrets out of Git and frontend configuration.

Worker previews use the signing flag in `wrangler.jsonc` (currently `true`); `.env` does not override it.

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

The workflow uploads a candidate Worker version tagged with the full commit SHA, then publishes an immutable GitHub Release named `build-<runID>-<attempt>`. Its tag points to that exact commit; attachments contain `frontend.tar.gz`, `build-info.json` and `release.json`. The release is a **build record**; the GitHub `production` Deployment status records whether it was activated and verified. The workflow only marks deployment successful after both production domains match the public artifact hashes. Failed activation/acceptance triggers a rollback to the previously recorded Worker version and reports the rollback result.

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
SUPABASE_DATA_SCOPE=restore-robinhood-check npm start
```

Restore requires a new, empty `restore-` scope and never overwrites production. Keep original receipts; later transaction hashes may need rechecking.

**Stop new signing:** stop Node, set `ENABLE_MAINNET_TRANSACTIONS=false`, then restart. On Cloudflare, change the flag in `wrangler.jsonc`, publish and verify `/api/config` returns `writesEnabled:false`. Already broadcast transactions still recover; disabling signing cannot revoke an existing wallet request or on-chain transaction.

**Roll back:** follow the [verified version and rollback command](docs/evidence/cloudflare-acceptance.md). Preserve database scopes, receipts and Pinata pins. Runtime rollback cannot change deployed pools or token metadata.

## Details

- [Product, pricing, fees and runtime rules](docs/SPEC.md)
- [Fixed-opening local checks](docs/evidence/fixed-opening-acceptance.json) · [production checks](docs/evidence/fixed-opening-production.json)
- [Image-upload verification](docs/evidence/token-image-pinata.json)
