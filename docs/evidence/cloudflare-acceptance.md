# musegod.fun Cloudflare publication — 2026-10-05

Published application: [musegod.fun](https://musegod.fun) and [www.musegod.fun](https://www.musegod.fun). Token image uploads now use public IPFS through Pinata, and the previous Supabase/local image reader and GET endpoint are removed. Worker `musegod-fun` serves frontend assets and the backend through the named `robinhood-mainnet` Durable Object. This release makes no database changes, signs no wallet requests, broadcasts no transactions and deploys no contracts.

Cloudflare API read-back confirms deployment `ffe9a11d-c064-40cf-a62a-07295683dd89`, with version **`32684bca-f328-4f45-910e-73f089e471c5` at 100% traffic**. Encrypted secret bindings are `ALCHEMY_API_KEY`, `SUPABASE_SECRET_KEY` and the newly installed `PINATA_JWT`. Public bindings and the script runtime remain unchanged, with compatibility date `2026-10-04` and `nodejs_compat`. [Current release read-back](token-image-pinata.json)

| Evidence | Result | Record |
| --- | --- | --- |
| Unit tests | 169/169 pass | `npm test`; [Pinata checks](token-image-pinata.json) |
| Node/frontend and Worker types; production build; Worker dry run | Pass | [Pinata checks](token-image-pinata.json) |
| Public HTTP | 22/22 pass across both domains: health/readiness/configuration, direct frontend identity, removed image route, RPC broadcast rejection and security headers | [Current HTTP checks](token-image-pinata.json) |
| Frontend identity | Both domains' `/create` HTML and all four current JS/CSS assets match local dist bytes and SHA-256 | [Current HTTP checks](token-image-pinata.json) |
| Runtime configuration | Robinhood mode, chain/deployment 4663 and existing `writesEnabled:true` preserved | [Current HTTP checks](token-image-pinata.json) |
| Removed image reader | Old `/api/token-images/<sha256>.webp` returns 404 without immutable cache headers on both domains | [Current HTTP checks](token-image-pinata.json) |
| Public browser upload | Native file selection returns 200; 550-byte WebP gateway read returns 200 with matching SHA-256; both previews decode at 2×3; draft URL survives refresh; 390×844 viewport has no horizontal overflow | [Pinata image checks](token-image-pinata.json) |
| Configured secret values | Tracked source/evidence, production assets, Worker bundle/map and captured public evidence contain zero configured-secret matches | [Pinata checks](token-image-pinata.json) |

## Previous baseline evidence

Version `d4add883-f302-4424-97cd-612a9aeb0400`, deployment `f2a1a95e-d2cc-4f35-ac7e-da1cdea76b45`, is the preceding verified baseline and rollback point. Its [release read-back](cloudflare-release.json), [38 HTTP checks](cloudflare-release-http.json), [199 static resource hashes](cloudflare-release-assets.json), [Supabase image-upload checks](token-image-upload.json) and [secret scan](cloudflare-secret-scan.json) document that earlier version. They do not establish those checks or the removed Supabase image reader on the Pinata version.

The database initialization and 17 isolated persistence, concurrency, backup/restore and receipt checks also belong to that baseline: [database checks](database.json), [schema and permissions](database-schema.json). No schema migration is required by the Pinata change.

The fresh schema is [20261005000537_musegod_store.sql](../../supabase/migrations/20261005000537_musegod_store.sql). Its application on the configured Supabase project was recorded by the hosted migration service as `20261005002038`. The new `musegod_*` tables and RPCs are independent of existing tables and migration history. All six tables enable RLS; anonymous and authenticated roles cannot read them, while the server service role has the required access. All six RPCs use SECURITY INVOKER and an empty search path; only the service role can execute them. Existing tables and records were retained without copying data. Verification used isolated scopes and removed its test rows.

The configured routes remain `musegod.fun/*` and `www.musegod.fun/*`; their IDs, account/zone and retained DNS/mail configuration are recorded in the preceding [baseline release](cloudflare-release.json). `CHAIN_MODE=robinhood`, `SUPABASE_DATA_SCOPE=robinhood`, treasury and the existing mainnet transaction flag are preserved. Images now load directly from public Pinata HTTPS gateway URLs; the application no longer reads Supabase/local image bytes.

Browser-wallet connection, issuance, trading and creator/treasury claims remain **not_run** for this release; image-upload and read-only HTTP checks do not establish a real transaction receipt or external security audit. Earlier dated domain/browser/maintenance records document preceding releases. Historical isolated-fork evidence is described in [chain acceptance](robinhood-acceptance.md).

The previous baseline's cleanup removed the three session archive directories as requested: **406 files, 98,517,462 bytes**. Obsolete archive restore instructions were removed. Credentials, runtime data, public assets, dependencies and the fork executable were retained. This is earlier cleanup evidence, not an additional deletion in the Pinata release. [Cleanup record](repository-cleanup.json)

## Rollback

To restore the preceding verified baseline:

```sh
npx wrangler versions deploy d4add883-f302-4424-97cd-612a9aeb0400@100 --durable-objects-code-update-mode immediate --yes
```

Read back the active version at 100%, `/readyz`, `/api/config` and frontend asset hashes. Preserve encrypted secrets, Supabase tables and scopes, transaction receipts and Pinata pins. Pinata HTTPS URLs already saved in drafts or token metadata must continue to resolve independently of the application version. Rolling back to this baseline restores its earlier Supabase upload behavior, so verify the image-upload flow for that version separately. The older `2e14cfd9-9a58-414e-929d-4245412ed20f` uses the preceding database namespace and is not this rollback point.

Source recovery uses Git history. The obsolete local archive originals were intentionally deleted.
