# musegod.fun Cloudflare publication — 2026-10-05

Published application: [musegod.fun](https://musegod.fun) and [www.musegod.fun](https://www.musegod.fun). The cleaned application namespace and token image uploads are now live. Worker `musegod-fun` serves frontend assets and the backend through the named `robinhood-mainnet` Durable Object. No existing data was migrated, no wallet was connected or signed, and no mainnet transaction or contract deployment was performed.

Cloudflare API read-back confirms deployment `f2a1a95e-d2cc-4f35-ac7e-da1cdea76b45`, with version **`d4add883-f302-4424-97cd-612a9aeb0400` at 100% traffic**. Activation used immediate Durable Object code updates. Compatibility date `2026-10-04`, `nodejs_compat`, encrypted `ALCHEMY_API_KEY` and `SUPABASE_SECRET_KEY` bindings, `LAUNCHPAD / LaunchpadRuntime`, assets binding `ASSETS`, and root configuration were verified. [Release read-back](cloudflare-release.json)

| Evidence | Result | Record |
| --- | --- | --- |
| Unit tests | 166/166 pass | `npm test`; [image implementation checks](token-image-upload.json) |
| Node/frontend and Worker types; production build | Pass; existing Vite chunk-size advisory remains | `npm run build` |
| Hosted database | Six new tables and six RPCs initialized; 17 isolated persistence, concurrency, backup/restore and receipt checks pass | [Database checks](database.json), [schema and permissions](database-schema.json) |
| Public HTTP | 38/38 pass across both domains: health/readiness/configuration, catalog/stocks, chain 4663 read RPC, signing/broadcast rejection, request validation and security headers | [HTTP checks](cloudflare-release-http.json) |
| Frontend identity | Both domains' homepage/Create HTML match local dist; four build assets match byte hashes | [HTTP checks](cloudflare-release-http.json) |
| Static resources | 199/199 match local files and manifest: 198 logos and favicon | [Static hashes](cloudflare-release-assets.json) |
| Public image API | Actual upload and duplicate return 200; retrieved WebP bytes match SHA-256 with immutable cache headers | [Release checks](cloudflare-release.json) |
| Public browser upload | Actual PNG file selection succeeds; both previews decode at 256×256 and persist after reload | [Image checks](token-image-upload.json), [screenshot](cloudflare-release-create.jpg) |
| Configured secret values | Zero matches in staged source, production assets, Worker bundle/map and sampled public API responses | [Secret scan](cloudflare-secret-scan.json) |

The fresh schema is [20261005000537_musegod_store.sql](../../supabase/migrations/20261005000537_musegod_store.sql). Its application on the configured Supabase project was recorded by the hosted migration service as `20261005002038`. The new `musegod_*` tables and RPCs are independent of existing tables and migration history. All six tables enable RLS; anonymous and authenticated roles cannot read them, while the server service role has the required access. All six RPCs use SECURITY INVOKER and an empty search path; only the service role can execute them. Existing tables and records were retained without copying data. Verification used isolated scopes and removed its test rows.

Routes remain `musegod.fun/*` (ID `17892ff0fcf54172bfe73abf58623a8c`) and `www.musegod.fun/*` (ID `23ce0e73e4ab4ecfb1c6136ecf0f2923`) in zone `13efa20023853aca22c7d76fa60475cf`, account `4b68bb6b6c38892162610027f25fbb0d`. DNS and mail records were unchanged. `CHAIN_MODE=robinhood`, `SUPABASE_DATA_SCOPE=robinhood`, treasury and the existing mainnet transaction flag were preserved. The private `token-images` bucket remains private; the application validates uploads and serves immutable public HTTPS image URLs.

The public catalog remains empty. Browser-wallet connection, issuance, trading and creator/treasury claims remain **not_run**; this release does not claim a real transaction receipt or external security audit. Earlier dated domain/browser/maintenance records document the preceding release, rather than proving those checks on the new version. Historical isolated-fork evidence is described in [chain acceptance](robinhood-acceptance.md).

After public verification, the three session archive directories were removed as requested: **406 files, 98,517,462 bytes**. Obsolete archive restore instructions were removed. Credentials, runtime data, public assets, dependencies and the fork executable were retained. [Cleanup record](repository-cleanup.json)

## Rollback

For a subsequent release, return to this verified baseline:

```sh
npx wrangler versions deploy d4add883-f302-4424-97cd-612a9aeb0400@100 --durable-objects-code-update-mode immediate --yes
```

Read back the active version at 100%, `/readyz`, `/api/config`, frontend asset hashes and an existing uploaded image. Preserve encrypted secrets, database scopes and receipts, and `token-images` objects. Uploaded image URLs referenced by token metadata must continue to resolve. The earlier version `2e14cfd9-9a58-414e-929d-4245412ed20f` uses the preceding database namespace and lacks the image endpoint; it is not the baseline for future releases that rely on uploaded images.

Source recovery uses Git history. The obsolete local archive originals were intentionally deleted. No Git push was requested or performed.
