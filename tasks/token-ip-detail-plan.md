# Token detail as an IP page — spec and plan

Status: released 2026-10-18 as `0934171` (`build-39050292574-1`). Design source: the owner-approved canvas "Token IP Detail Redesign" (claude.ai artifact XrbcWR3NPjMLCFTMgmQrha, version 16), built on the musegod.fun design system.

## 1. Goal

Turn the token detail page into the coin's home page, treating each coin as an IP:

- Trading leaves the page. A trade card sends buyers to Doppler (primary) or the Fomo app (secondary, through the owner's invite link). The pool fee is charged on-chain on every swap, so the coin's beneficiaries earn the same on any venue (verified 2026-10-17: the Rehype hook and LP beneficiaries are fixed at launch; musegod.fun takes no frontend fee).
- The page leads with identity: a dense hero, the coin's social channels, and tabs modelled on useclaudia.xyz agent pages.
- The coin's owner can edit its social links.

Owner instructions this plan implements (translated from Chinese):
- "Redesign the token detail page; trading goes to Doppler and Fomo (with my invite link); the detail page shows the token as an IP."
- "Put price information in the trade section."
- "Overview should show the more important content (like useclaudia); the current overview content goes in its own tab."
- "Whatever the route (NFT, agent or plain meme), the most important links are its social media links; NFT coins may add an OpenSea link; everything else can go."
- "YouTube, TikTok and similar links are optional; show nothing when absent."
- "The meme owner must be able to edit these."
- "Talk to it is not supported yet; remove it."

## 2. Launch routes covered

| Route | Who owns the profile | Page differences |
|---|---|---|
| 1 · Meme | the creator wallet recorded at launch | base layout |
| 2 · NFT meme | the bound NFT's holder, or its delegate.xyz v2 delegate | NFT overline, OpenSea link, NFT treasury as the fee beneficiary |
| 3 · Agent NFT meme | same as Route 2 (the agent is controlled by the NFT holder through ERC-8217) | Route 2 plus an ERC-8004 identity card |

A standalone ERC-8004 agent launch does not exist in the launch flow, so standalone agents are out of scope.

## 3. Layout

- **Hero card:** coin image, an overline (network, pair, launch date; NFT coins: collection and token id), name, `$SYMBOL`, trust badges, the launch description as the story, a meta row (creator and the fee line; NFT coins add the pair and launch date), the link row (social links, OpenSea for NFT coins, Share, Edit profile for the owner), a headline figure (the creator's or NFT treasury's share of every trading fee) and a stat band of facts the page already has (trading fee, buyback share, opening valuation, supply, linked channels, age). Superseded on 2026-10-18 at the owner's request: the headline is the creator fee per trade and the buyback share left the stat band (`tasks/ip-page-improvements-2026-10-18-plan.md` §8).
- **Aside:** the trade card, then the fee beneficiary card. It is a sticky right column when the columns fit side by side (a container query on the columns' own width) and leads the page otherwise. Superseded on 2026-10-18 by `tasks/ip-page-improvements-2026-10-18-plan.md` §4: the tabs now follow the hero and the aside comes after them when stacked.
  - Trade card: the price block (market summary price and 24h change, market cap, liquidity, 24h volume, with source attribution), "Trade on Doppler" (gold), "Open Fomo with invite" plus the contract to search, what a $100 buy pays, and "musegod.fun adds no fee of its own and signs nothing here". When the summary has no price, a "Get pool quote" button reads one on-chain quote for 1 unit of the pair asset, labelled as that buy's average price; it never runs automatically.
  - Beneficiary card: the creator address (Route 1) or the NFT, its vault and treasury (Routes 2–3), the share, and a button that opens the On-chain tab.
- **Tabs:** Overview, Posts, Activity, On-chain. Posts was added by the owner-authorized 2026-10-20 extension in §10.
  - Overview: About (story and a one-line owner statement), Channels (one card per linked channel, link only), and for Route 3 the agent identity.
  - Activity: the buy/sell flow by period and the recent trades feed (any venue, live via the swap stream).
  - On-chain: first-buy lock, the NFT treasury card (Routes 2–3), beneficiary fees (FeeCard), the fee disclosure, contract details and the launch curve.
- No chart (the trade card links to Doppler's chart) and no channel metrics: the redesign's data-honesty rule omits elements with no backing API. Posts now has its own persistent API and storage (§10).

## 4. Trading venues

- Doppler: `https://app.doppler.lol/tokens/{base|robinhood}/<lowercased address>` for every registered launch on Base or Robinhood Chain. Registration already verifies the pool identity against the canonical Doppler contracts, and the Doppler app lists launches on both chains (checked 2026-10-17: MVADER on Robinhood, MUSEGOD `0x79ea…e670` on Base). This replaces the empty release-reviewed allowlist of the deleted `src/lib/doppler.ts`. Forks never link.
- Fomo: shown only when the public runtime value `FOMO_INVITE_HANDLE` is set; the button opens `https://fomo.family/r/<handle>`. Fomo has no per-coin link, so the card shows the contract address with copy. The owner must set the handle before release.
- The in-page swap (buy/sell, pay with ETH, quotes, slippage, price impact) is removed with its client-only code. Server endpoints stay where something else uses them (MUSEGOD trading, the launch first buy, release verification).

## 5. Profile links

- Fields: X, YouTube, TikTok and Telegram handles, and a website. All optional; empty fields are not shown. Inputs accept a handle, an `@handle` or the platform URL and are stored normalized. The website must be a public `https:` URL of at most 200 characters.
- Until an owner saves a profile, the page shows the launch links (`twitter`, `telegram`, `website` in the token record). A saved profile replaces them entirely.
- Saving signs EIP-712 typed data `TokenProfile { token, x, youtube, tiktok, telegram, website, issuedAt }` in domain `{ name: "musegod.fun", version: "1", chainId: <coin chain> }`. No gas, nothing on-chain.
- The wallet policy (`src/lib/wallet-signing.ts`) keeps refusing every signature method outside the dedicated profile and Posts authorization paths. The profile signer accepts exactly one `eth_signTypedData_v4` request whose account, domain, types and message match what the editor built; no `verifyingContract`, no other primary type. The separate Posts signer is specified in §10.
- Server (`POST /api/tokens/:address/profile`): validates the fields, requires `issuedAt` within 10 minutes of now and newer than the saved profile, recovers the signer (EOA locally; contract wallets through ERC-1271/6492 under a request budget), then checks ownership: Route 1 the recorded creator, Routes 2–3 `readNftControl` (holder or delegate). Forks and unknown coins are refused.
- Storage: `snapshots` key `profile:<lowercased address>` (the per-chain scope is the store scope), like the persistent `pinata:` records. Cleanup in SQLite and the Supabase `musegod_cleanup` function skips `profile:` keys (migration `20261017120000_profile_snapshots.sql`, to be applied before release; security attributes unchanged). Backups already include snapshots.
- `GET /api/tokens/:address` returns `profile` (links, signer, savedAt) when one exists, and `nftProfile` (`name`, `agentId`) for Muse coins, cached in memory like `nftStatus`.

## 6. Acceptance

1. Route 1 page renders the hero, trade card, beneficiary card and four tabs (including the 2026-10-20 Posts addition); tab switching works; no swap form or chart remains on the token page.
2. Doppler links appear for every registered non-fork coin on both chains; the Fomo button appears only with `FOMO_INVITE_HANDLE`.
3. Social links render only when present, from the saved profile or else the launch links, always `target="_blank" rel="noopener noreferrer"`.
4. The owner sees Edit profile; others do not. A save by a non-owner, a replayed or stale signature, a signature for another coin or chain, or an invalid link is refused with a clear message.
5. The profile signer refuses any other signature or transaction request; signatures are allowed only in the exact dedicated profile and Posts authorization paths.
6. NFT coins show the collection overline, OpenSea link and NFT treasury card; Muse agent coins show the identity card.
7. Profiles survive cleanup in both stores.
8. `npm test`, `npm run typecheck` and `npm run build` pass; repo documents stay English; README and SPEC describe the new page.
9. The page works at phone width (390 px): the aside stacks above the tabs, tabs scroll horizontally, no horizontal page scroll. (Stacking order superseded on 2026-10-18: the tabs come first, see `tasks/ip-page-improvements-2026-10-18-plan.md` §4.)

## 7. Review

Claude implements; codex (gpt-6.1-sol, xhigh) reviews; findings are fixed and re-accepted, then a fresh claude reviewer pass and a codex fix/accept pass. Focus areas: the signing exception, profile authorization and replay, link sanitization, removed code and test coverage.

## 8. Release notes for the owner

- Done: migration `20261017120000_profile_snapshots.sql` was applied to production before the release.
- Done: `FOMO_INVITE_HANDLE` is `daboluo` (the owner's invite link `https://fomo.family/r/daboluo`) in `wrangler.jsonc` vars, set in a follow-up release. Production reads this var, not `.env`.
- Pushing to `master` releases production.

## 9. Status, 2026-10-17

Implemented, reviewed and released (`0934171`); the Fomo handle followed in a separate release.

| Acceptance item | State | Evidence |
|---|---|---|
| 1 Route 1 layout, tabs, no swap or chart | Met | `tests/token-ip-page.test.ts`; read-only preview against production data (desktop, 1024 px, phone) |
| 2 Doppler on both chains, Fomo only with a handle | Met | Tests; Doppler pages checked for MVADER (Robinhood) and MUSEGOD (Base) |
| 3 Links only when present, `noopener noreferrer` | Met | Tests |
| 4 Owner-only edit, refusals | Met | `tests/token-profile.test.ts` (signatures, replay, overlapping saves, NFT mode gate, cache order) |
| 5 Profile signer refuses everything else | Met | Signing guard tests with a real viem client |
| 6 NFT overline, OpenSea, treasury, agent card | Met | Tests |
| 7 Profiles survive cleanup | Met in SQLite; Supabase by migration | Service test; the migration must be applied before release |
| 8 Test, typecheck, build, English docs | Met | `npm test` 1779/1779, typecheck, build |
| 9 Phone width | Met | Preview at 375 px: trade card first, no clipped values, no horizontal scroll |

Review: codex round 1 (7 findings) fixed by Claude and accepted, plus one follow-up (cache order) accepted; Claude round 1 (12 findings) fixed by codex and accepted by Claude, with three minor notes fixed afterwards. Not run: the two browser scripts (no browser installed; syntax and selectors reviewed), real-wallet signing, contract-wallet signatures on a live chain, and the Supabase conditional write against a live database (request shapes are unit-tested).

## 10. Token-owner Agent Posts, 2026-10-20

This owner-authorized extension adds public Posts and token-scoped Agent API keys. This section describes the local implementation contract; the historical release evidence above does not establish that Posts or its database migration is deployed.

- The public Posts tab displays text, uploaded images, clickable links and a video external-link card under the token's avatar and name, marked as published by an Agent. It supports newest-first pagination and an addressable Posts tab. Owners can create, list and revoke keys, delete Posts, and copy the Agent instructions. The complete key is shown once and is kept out of logs, URLs and browser persistent storage. There is no browser composer, Post editing, comments or likes.
- Plain meme key management belongs to the recorded creator. NFT meme key management belongs only to the current NFT holder; delegate authority for profile editing in §2/§5 does not extend to Posts keys. The dedicated `Musegod Token Posts` EIP-712 domain binds chain and token (`verifyingContract`); `PostOwnerAction` binds action, target UUID, name, key lifetime and signature time. Signatures expire after ten minutes and use the existing EOA/ERC-1271/ERC-6492 verification support. A creation UUID remains consumed to prevent replay.
- A key uses 256 random bits, lasts 30 days and is stored only as a hash, masked prefix and management metadata; each token may have five active keys. It can read, publish, upload images and delete any Post on that same token. Each write checks expiry/revocation and the current NFT holder. Confirmed loss of ownership permanently revokes the key; uncertain RPC results return 503. Transfer history is not indexed: an unobserved transfer away and back does not itself revoke a key.
- Chain-specific interfaces share `/api/chains/:chainId/tokens/:address`: `GET /posts` returns `{items,nextCursor}` (20 by default, at most 50); `POST /posts` accepts `{text,imageIds,videoUrl}` and an `Idempotency-Key`; `POST /posts/images` accepts `{image}` (a WebP data URL) and returns `{id,url}`; `POST /posts/:id/delete` accepts either bearer or owner authorization. Owner-only key endpoints are `POST /post-api-keys`, `POST /post-api-keys/list` and `POST /post-api-keys/:id/revoke`. Mixed bearer and owner credentials are rejected.
- Posts accept at most 5,000 Unicode characters, four static WebP images (at most 512 × 512 pixels and 40 KiB each) and one public HTTPS video link. Video links are navigation cards only; no remote metadata, thumbnail or video fetch occurs. Media IDs are token-bound. Posts use soft deletion; audit/idempotency records remain and IPFS images are not unpinned.
- SQLite and Supabase persist keys, Posts, media and quota state; each write atomically rechecks key state. Idempotency is per token: exact retries reuse the original result, different content conflicts, and retries cannot recreate deleted Posts. New Supabase tables and write RPCs are restricted to the service role. Backups retain key/creation UUIDs, revocation, media, deletion and rate records, including the shared cross-chain image counter, which restore merges by maximum so a live window never drops; restore revokes every restored key. Only a production scope clears that shared counter during cleanup, never ahead of the database clock.
- Defaults: two Posts/minute and 60/day/token; ten writes/minute/key; 30 deletions/minute/token; ten images/day/token and 50 Posts images/day across chains, also subject to the existing 100/day Pinata budget. Uploads pre-reserve durable capacity, deduplicate content, and retain capacity for unknown upstream outcomes; a Pinata budget refusal, known to precede any upload, releases its daily slots and returns 429 with the budget's `Retry-After`. Admission classifies percent-encoded routes as Express matches them. Valid agent credentials use machine quotas without Turnstile while retaining IP/concurrency limits.
- Public integration documentation is served at `/agent-posts.md`. Local acceptance covers service/store tests, real Miniflare Worker routing with isolated upstream fixtures, responsive browser rendering, typechecking and build. Fixture wallets, local Worker results and SQL migration inspection are distinct from production migration, live RPC ownership, real-wallet acceptance or production publishing; these require their existing authorization gates.

Local acceptance completed on 2026-10-20: `npm test` passed 1,898 tests with zero failures; the one default-skipped PostgreSQL test also passed separately against isolated PostgreSQL 17, including migration application, RLS, concurrent limits and restore behavior. `npm run build` passed both TypeScript targets and Vite (the existing large-chunk warning remains). Browser acceptance at 1280 × 900 and 390 × 844 covered ordinary/NFT key creation and revocation, one-time display/copy, pagination, retained tab state, deletion, read failure/recovery, image layout, video links and anonymous reading. The independent review's NFT-launch-switch management issue was fixed and regression-tested. Evidence and runtime boundaries: `docs/evidence/token-posts-local.json`.

Rollback reference: the pre-change source HEAD is `c89fb720f166f348225cde680e7d5c9803029171`. For a future application rollback, retain the additive Posts tables, key revocations and deletion tombstones; reverting code does not require dropping data or restoring previously revoked credentials. This local run made no production changes.
