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

To publish:

```sh
npm run deploy:cloudflare
```

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
