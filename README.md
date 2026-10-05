# musegod.fun

Official domain and visible brand: `musegod.fun`. Current domain-change checks are recorded in `docs/evidence/domain-rebrand.json`; dated evidence retains the identity observed at that time.

The npm package is `musegodfun`. Browser drafts, wallet preferences and transaction hashes use `musegod.*`; database tables and RPCs use `musegod_*`. The current release initializes this namespace independently without previous-name compatibility or existing-data migration. Obsolete project routes remain removed.

A non-custodial meme launchpad on Robinhood Chain (4663), using Doppler Multicurve/Rehype and Uniswap v4. The application is English throughout. Issuance, swaps and fee claims require confirmation in the selected browser wallet; the server never holds private keys or broadcasts transactions.

The active paired-asset list curates [PAIR launch](https://pair.fund/launch): 198 assets, including 194 Robinhood stock/ETF tokens and WETH, USDG, cbBTC and [MUSEGOD](https://musegod.org/docs). U and PAIR are excluded; MUSEGOD is separately verified at `0x0379E228F6887c6F18bf394042ECAF81B308cb2e` with 18 decimals. The addresses of the 194 stock/ETF tokens also match Robinhood's asset registry. Each asset is checked on-chain before issuance. The reference list is pinned in `src/lib/robinhood-assets.json`; an upstream list change does not silently add signing targets.

Base fee bridging and buyback execution are deferred. `/buyback` explains the fee policy and planned MUSEGOD target; it cannot prepare a bridge or burn transaction. Robinhood market data is explicitly unavailable until its provider integration is verified. On-chain swap quotes are independent of market data. See [SPEC](docs/SPEC.md) and [acceptance evidence](docs/evidence/robinhood-acceptance.md).

## Run

Node.js 24.11+ is required for local development, builds and administration. Cloudflare serves the built assets and routes the backend through one named Durable Object, using server-only Supabase storage. Existing environment credentials remain private.

For a fresh Supabase project, initialize `supabase/migrations/20261005000537_musegod_store.sql` before running the mainnet backend. It creates the six application tables and six RPCs with RLS and server-only grants. The configured project has been initialized and verified for this release; previous records remain in their existing tables and were not migrated. The hosted migration is recorded as `20261005002038`; earlier hosted migration history remains retained. Fork development uses local SQLite.

```sh
npm ci
npm test
npm run build
npm start
# http://127.0.0.1:5188
curl -fsS http://127.0.0.1:5188/readyz
```

`npm run dev` serves development assets. Production serves `dist`. Restart Node after server or environment changes, rebuild and reload the browser after frontend changes.

Cloudflare configuration is in `wrangler.jsonc`. Local Node reads `.env`; Workers read configured variables and encrypted secret bindings. The Worker requires Robinhood mainnet and Supabase; it never opens the local SQLite store.

Token images can be uploaded from `/create` or supplied as public HTTPS URLs. File selection supports PNG/JPG/WebP/GIF up to 5 MiB (GIFs use the first frame); the browser preserves aspect ratio and transparency while preparing a WebP no larger than 512 × 512 and 40 KiB. The server validates the image and uploads it to public IPFS through [Pinata's v3 Files API](https://docs.pinata.cloud/api-reference/endpoint/upload-a-file), using server-only `PINATA_JWT`. Uploaded images return `https://gateway.pinata.cloud/ipfs/<CID>` for previews, drafts and immutable token metadata. The v3 API needs the JWT; `PINATA_API_KEY` and `PINATA_API_SECRET` may remain in `.env` but are not needed by this upload flow. Missing credentials or Pinata failures stop the upload without replacing the previous image. Local/fork uploads also use Pinata; they never fall back to Supabase or local files.

Images load directly from their public HTTPS URLs. Keep Pinata files pinned for continued availability; database backups retain their URLs, not the image bytes. The Pinata change requires no database migration. The product has not formally launched, so the previous Supabase/local image reader and its GET endpoint are removed.

The Pinata switch is published on both domains. Production browser file selection, decoded previews, refresh persistence and public gateway byte integrity are verified; both domains return 404 for the removed image GET endpoint. [Verification evidence](docs/evidence/token-image-pinata.json) separates production checks from local Node/workerd and injected failure scenarios.

```sh
npm run build
npm run dev:cloudflare
# After Wrangler authentication and configuring server-only secrets:
npm run deploy:cloudflare
```

`ALCHEMY_API_KEY`, `SUPABASE_SECRET_KEY` and `PINATA_JWT` must be configured as Worker secrets before publication. Node reads `.env`; Cloudflare does not automatically import it. The ignored `.dev.vars` file can provide local workerd secrets; `wrangler deploy --secrets-file .dev.vars` installs them as encrypted bindings. Never put their values in Wrangler variables, frontend configuration or saved evidence. The domain uses Worker routes over its existing proxied DNS; all A/CNAME and MX/TXT records are retained. Every application response comes from the Worker and its asset binding. Public deployment evidence is recorded in [Cloudflare acceptance](docs/evidence/cloudflare-acceptance.md).

- `CHAIN_MODE=robinhood` is the default. `base` is retained for existing Base receipts; `fork` is isolated testing.
- `ALCHEMY_API_KEY` selects the corresponding mainnet endpoint. Robinhood Mainnet must be enabled in Alchemy. Without a key, `ROBINHOOD_RPC_URL` is the HTTPS fallback; configured provider failures do not silently fall back.
- `PLATFORM_TREASURY` is the verified treasury address. `ENABLE_MAINNET_TRANSACTIONS=true` enables user-wallet signing only; the existing explicitly enabled setting is preserved in Cloudflare. The example remains `false`. Every operation rechecks the runtime, selected provider, account and network before requesting a signature.
- `SUPABASE_URL` and `SUPABASE_SECRET_KEY` stay server-only. `SUPABASE_DATA_SCOPE=robinhood` isolates active records from existing `base` records. A restored scope may be selected explicitly. No schema migration or deletion of Base history is needed. CoinGecko quota remains shared under `base`, so switching data scopes does not reset usage.
- `COINGECKO_API_KEY` uses the Demo header for verified Base markets only. Persistent quotas, shared snapshots and stale-data expiry remain in place. Robinhood requests fail explicitly before reading a Base snapshot or calling a Base provider.
- Fork mode uses loopback `FORK_RPC_URL`, runtime chain 31337 and `FORK_CHAIN_ID=4663` or `8453`. Each deployment uses a separate local directory. Mainnet RPC proxies always reject signing and broadcasting methods.

Paired assets can be found by category (Stocks, ETFs, Penny stocks, Crypto assets), name, ticker or contract address. Filters preserve the selected quote asset. All 198 logos are served from `public/asset-logos`; the source catalog, exact asset identity, file hash and contrast background are recorded in `src/lib/asset-logos.json`. Generated ticker badges and outdated company images are replaced with reviewed company/fund marks or current issuer assets. Fund families may share issuer marks. The offline logo verifier rejects missing assets, malformed images, unsafe SVGs and altered files. Local production/browser results are in `docs/evidence/robinhood-acceptance.md`.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run verify:robinhood
npm run verify:asset-logos
npm run test:robinhood-fork
npm run test:http
npm run verify:database
```

`verify:robinhood` performs only live reads and `eth_call` issuance simulations. It checks canonical deployments, all paired-asset metadata, the official Robinhood registry, exclusions of U/PAIR, and WETH/NVDA/USDG/cbBTC/MUSEGOD issuance simulations at 18/6/8-decimal precision. It never signs or broadcasts.

`test:robinhood-fork` starts an isolated Anvil fork behind a read-only upstream proxy, executes local creation, registration, buy/sell and both beneficiaries' fee claims for WETH/NVDA/USDG/cbBTC/MUSEGOD, tests restart/reorg recovery, and restores the snapshot in `finally`. The default binary is `.cache/bin/base-anvil-v1.1.1/anvil`; `ANVIL_BIN` may select an installed official Anvil. A generic EVM fork does not reproduce Nitro gas accounting or prove mainnet settlement. No mainnet private keys are used.

Evidence separates successful mainnet reads, local fork execution, local checks, public Cloudflare deployment and real wallet/mainnet execution. Publishing the domain does not prove a real wallet connection or a successful mainnet issuance, trade or fee claim. The active catalog remains empty; no wallet signature or real-capital transaction is included in this deployment task.

## Operations, backup and rollback

`/healthz` checks the runtime. `/readyz` checks the configured chain and database, returning 503 on failure. Local Node binds loopback and trusts a loopback reverse proxy. Cloudflare sends backend requests to the single named `robinhood-mainnet` Durable Object and replaces caller-supplied forwarding headers with Cloudflare's client identity. API limits remain 180/minute/IP and 32 concurrent requests, including Worker request-body buffering. Bodies are limited to 64 KiB, with a 30-second ingress budget. Launch simulations remain serialized; upstream URLs and secrets are redacted.

Node retains its maintenance interval and graceful SIGTERM shutdown. Cloudflare uses durable alarms for cleanup and receipt reconciliation, scheduling the next alarm 30 seconds after each run. Reconciliation stops starting additional rows after its 60-second budget; the current row may finish under existing upstream timeouts. Supabase retains plans, receipts and catalog records across runtime restarts. Production sets CSP, MIME, frame, referrer and permissions headers; HTTPS adds HSTS.

```sh
mkdir -p .data/backups
npm run db:backup -- .data/backups/robinhood-backup.json robinhood
npm run db:restore -- .data/backups/robinhood-backup.json restore-robinhood-check
SUPABASE_DATA_SCOPE=restore-robinhood-check npm start
```

Backup files use mode 0600 and contain application data, not credentials. Restore accepts only a new empty `restore-` scope and never overwrites production. Keep all original receipts; a restored backup can require later transaction hashes to be rechecked.

To stop new signing: stop Node, set `ENABLE_MAINNET_TRANSACTIONS=false`, then `npm start`. Already broadcast transactions continue confirmation and registration; disabling the flag cannot revoke a wallet request already presented or an on-chain transaction.

For Cloudflare, set that flag to `false` in `wrangler.jsonc`, publish the updated Worker and verify that the public `/api/config` returns `writesEnabled:false`. Existing transaction recovery remains available. The flag cannot revoke an on-chain transaction or a wallet request already presented.

Roll back the Pinata release to its preceding verified version with `npx wrangler versions deploy d4add883-f302-4424-97cd-612a9aeb0400@100 --durable-objects-code-update-mode immediate --yes`, then verify `/readyz`, `/api/config` and asset identities. The [deployment record](docs/evidence/cloudflare-acceptance.md) includes the version and route IDs. Removing the two published Worker routes restores the prior parking-page routing through retained DNS. Preserve Supabase tables, scopes, receipts, mail records, fee-policy identifiers and Pinata pins. Runtime rollback cannot change deployed pools or token metadata.

Repository cleanup removed obsolete evidence, research caches, source snapshots, logs and staging bundles. After the verified 2026-10-05 publication, the three session archive directories were deleted as requested. Current acceptance records, the fork-test binary, runtime data, credentials and assets remain retained. The [cleanup record](docs/evidence/repository-cleanup.json) records the deletion totals and validation. Source recovery uses Git history; deployment recovery uses retained Cloudflare versions. Obsolete local archive originals are no longer available.
