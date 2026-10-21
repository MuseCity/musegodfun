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
  - Beneficiary card: the creator address (Route 1) or the NFT, its vault and treasury (Routes 2–3), the share, and a button that opens the On-chain tab (named About since §11).
- **Tabs:** Overview, Posts, Activity, On-chain. Posts was added by the owner-authorized 2026-10-20 extension in §10. Superseded the same day by §11: Overview, Activity, About.
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

This owner-authorized extension adds public Posts and token-scoped Agent API keys. It was released on 2026-10-20; see the release paragraph at the end of this section.

- The public Posts feed (a tab at release, the first section of Overview since §11) displays text, uploaded images, clickable links and a video external-link card under the token's avatar and name, marked as published by an Agent. It supports newest-first pagination. Owners can create, list and revoke keys, delete Posts, and copy the Agent instructions. The complete key is shown once and is kept out of logs, URLs and browser persistent storage. There is no browser composer, Post editing, comments or likes.
- Plain meme key management belongs to the recorded creator. NFT meme key management belongs only to the current NFT holder; delegate authority for profile editing in §2/§5 does not extend to Posts keys. The dedicated `Musegod Token Posts` EIP-712 domain binds chain and token (`verifyingContract`); `PostOwnerAction` binds action, target UUID, name, key lifetime and signature time. Signatures expire after ten minutes and use the existing EOA/ERC-1271/ERC-6492 verification support. A creation UUID remains consumed to prevent replay.
- A key uses 256 random bits, lasts 30 days and is stored only as a hash, masked prefix and management metadata; each token may have five active keys. It can read, publish, upload images and delete any Post on that same token. Each write checks expiry/revocation and the current NFT holder. Confirmed loss of ownership permanently revokes the key; uncertain RPC results return 503. Transfer history is not indexed: an unobserved transfer away and back does not itself revoke a key.
- Chain-specific interfaces share `/api/chains/:chainId/tokens/:address`: `GET /posts` returns `{items,nextCursor}` (20 by default, at most 50); `POST /posts` accepts `{text,imageIds,videoUrl}` and an `Idempotency-Key`; `POST /posts/images` accepts `{image}` (a WebP data URL) and returns `{id,url}`; `POST /posts/:id/delete` accepts either bearer or owner authorization. Owner-only key endpoints are `POST /post-api-keys`, `POST /post-api-keys/list` and `POST /post-api-keys/:id/revoke`. Mixed bearer and owner credentials are rejected.
- Posts accept at most 5,000 Unicode characters, four static WebP images (at most 512 × 512 pixels and 40 KiB each) and one public HTTPS video link. Video links are navigation cards only; no remote metadata, thumbnail or video fetch occurs. Media IDs are token-bound. Posts use soft deletion; audit/idempotency records remain and IPFS images are not unpinned.
- SQLite and Supabase persist keys, Posts, media and quota state; each write atomically rechecks key state. Idempotency is per token: exact retries reuse the original result, different content conflicts, and retries cannot recreate deleted Posts. New Supabase tables and write RPCs are restricted to the service role. Backups retain key/creation UUIDs, revocation, media, deletion and rate records, including the shared cross-chain image counter, which restore merges by maximum so a live window never drops; restore revokes every restored key. Only a production scope clears that shared counter during cleanup, never ahead of the database clock.
- Defaults: two Posts/minute and 60/day/token; ten writes/minute/key; 30 deletions/minute/token; ten images/day/token and 50 Posts images/day across chains, also subject to the existing 100/day Pinata budget. Uploads pre-reserve durable capacity, deduplicate content, and retain capacity for unknown upstream outcomes; a Pinata budget refusal, known to precede any upload, releases its daily slots and returns 429 with the budget's `Retry-After`. Admission classifies percent-encoded routes as Express matches them. Valid agent credentials use machine quotas without Turnstile while retaining IP/concurrency limits.
- Public integration documentation is served at `/agent-posts.md`. Local acceptance covers service/store tests, real Miniflare Worker routing with isolated upstream fixtures, responsive browser rendering, typechecking and build. Fixture wallets, local Worker results and SQL migration inspection are distinct from production migration, live RPC ownership, real-wallet acceptance or production publishing; these require their existing authorization gates.

Local acceptance completed on 2026-10-20 and repeated after the cross review below: `npm test` ran 1,913 tests, 1,912 passed with zero failures; the one default-skipped PostgreSQL test also passed separately against isolated PostgreSQL 17, including migration application, RLS, concurrent limits and restore behavior. `npm run build` passed both TypeScript targets and Vite (the existing large-chunk warning remains). Browser acceptance at 1280 × 900 and 390 × 844 covered ordinary/NFT key creation and revocation, one-time display/copy, pagination, retained tab state, deletion, read failure/recovery, image layout, video links and anonymous reading. The independent review's NFT-launch-switch management issue was fixed and regression-tested. A codex (gpt-6.1-sol, xhigh) and Claude cross review then ran review, fix and acceptance in both directions. codex found that verify-scope cleanup erased the live shared image counter (P1), that percent-encoded addresses bypassed Posts admission limits, that a Pinata budget refusal returned 503 and spent image slots, and that backups dropped the shared image counter; Claude fixed all four, codex reopened the SQLite refund commit order once, and accepted the corrected fix. Claude found that owner key routes lacked the risk challenge, that agent docs omitted terminal errors and that the database verifier skipped image release; codex fixed all three and Claude accepted them. Each fix has a regression test that fails on the previous code. Evidence and runtime boundaries: `docs/evidence/token-posts-local.json`.

Rollback reference: the pre-change source HEAD is `c89fb720f166f348225cde680e7d5c9803029171`. For a future application rollback, retain the additive Posts tables, key revocations and deletion tombstones; reverting code does not require dropping data or restoring previously revoked credentials. This local run made no production changes.

Released 2026-10-20 on the owner's "release and clean up". The migration was applied first, at 06:32:37 UTC, through the IPv4 session pooler in one transaction, after backups of both scopes and a preflight that found no Posts objects and confirmed the live `musegod_backup`, `musegod_restore` and `musegod_cleanup` bodies matched their base migrations; the postcheck and `npm run verify:database` passed (`docs/evidence/database.json` `tokenPostsMigration`). Master `aa90f87` then released through CI run 39381228509 as `build-39381228509-1`, Worker version `8fc23c3b`. Rollback point: Worker `e955610d` (`fa8a3df`, build-39203140278-1); the additive migration stays in place on rollback, since the replaced database functions keep their signatures and old behavior. Both chain Durable Objects served the new Posts route at once (`GET .../posts` returned `{"items":[],"nextCursor":null}` on Robinhood and Base, where it was 404 before), `/agent-posts.md` is served as `text/markdown`, owner and bearer routes refuse invalid requests with 400 and 401, both `readyz` checks are operational, and the live Phial page shows the Posts tab with "No Posts yet." and no owner controls for a visitor. Still not verified live: real-wallet key management, a real Pinata upload and a public Post.

## 11. Overview leads with Posts; On-chain becomes About, 2026-10-20

Owner request after the Posts release: Overview should show Posts first and then "About <coin>", the On-chain tab is renamed About, and the Agent identity card leaves Overview for that tab.

- Tabs are Overview, Activity and About (`?tab=about`); Activity was removed by §13. There is no separate Posts tab. A `tab=onchain` link opens About and a `tab=posts` link opens Overview, so links shared before the change still land on the same content; switching tabs writes the new name.
- Overview: the Posts feed (unchanged component, including owner key management and deletion), then the About card (story and owner sentence), then Channels. The feed loads with the page instead of on a first tab visit, which adds one public `GET /posts` per token page view.
- About (formerly On-chain): first-buy lock, NFT coin card, then the Agent identity · ERC-8004 card for agent coins, then the fee card, contract and launch record, fee disclosure and launch curve. It still mounts on its first visit. Trimmed by §12.
- The beneficiary card's button opens About; its label is unchanged.
- Acceptance: page tests cover the tab order, Posts before About and Channels in Overview, the identity card only in About (after the NFT card), Posts ownership without a tab click, keyboard wrapping across three tabs and the legacy `tab=onchain` / `tab=posts` links; `npm test`, `npm run typecheck` and `npm run build` pass; a read-only preview at desktop and phone width shows the new order.

Released 2026-10-20 on the owner's request: master `40d17c8` through CI run 39410169334 as `build-39410169334-1`, Worker version `b49766dd`; rollback point Worker `8fc23c3b` (`aa90f87`). Live checks: Robinhood Phial and Base MUSEGOD show the tabs Overview, Activity and About; Overview reads Posts ("No Posts yet.") then About and, for MUSEGOD, Channels; a `tab=onchain` link opens About; Phial's About tab carries the Agent identity card and Overview does not; no horizontal overflow at 1280 px or 375 px; both `readyz` checks operational and the Posts API unchanged. No database or Worker secret change. The live Agent Posts release (§10) is unaffected.

## 12. About tab without repeated facts, 2026-10-20

Owner request: reduce the remaining redundancy in the About tab. Rule: each fact appears once on the token page; About keeps only what the hero, the Overview and the always-visible beneficiary card do not show, plus every action and explorer link.

| Fact | Kept in | Removed from About |
| --- | --- | --- |
| Token contract, pair, creator, supply, launch date | Hero (contract with copy, pair badge, "by", stats, "launched") | On-chain record rows |
| Unverified opening valuation | Page notice and hero stat hint | On-chain record row |
| Creator share and its recipient | Beneficiary card, Overview About card, fee split | "Creator share recipient" row |
| Gross fee shares | Fee split bar in "How fees are distributed" | The second "Equivalent share of total fees" table in the same disclosure (token page only; the launch and buyback pages keep it) |
| NFT, fee vault, treasury | Hero NFT badge, beneficiary card (vault and treasury now link to the explorer) | Treasury card head badge and its Bound NFT, Fee vault and Treasury rows (the NFT page keeps them) |
| Agent id | Agent identity card | Treasury card "Agent" row |
| The holder controls the agent | Overview About card | Agent identity "Controller" row |
| Where an NFT coin's creator fees go | NFT treasury card (with the sweep) | The NFT fee card, now shown only to the platform treasury, which claims there (supersedes `tasks/detail-page-declutter-plan.md` D3's NFT line) |

The record card is renamed "On-chain record" and keeps the fee engine and operations addresses with their shares, pool ID and launch transaction, then the fee disclosure (buyback share kept, per the 2026-10-18 headline ruling) and the launch curve. The connected-wallet fee card for ordinary coins is unchanged (2026-10-15 owner ruling).

Acceptance: tests cover the trimmed record, the disclosure without the second gross table, the fee card tiers, the token-page treasury card versus the NFT page card, the Agent identity card without Controller and the beneficiary card's treasury link; each fails on the previous code. `npm test`, `npm run typecheck` and `npm run build` pass; a read-only preview of Phial (NFT, agent) and GOD (ordinary) shows the trimmed About tab.

## 13. No Activity tab, 2026-10-20

Owner question: why does the page have an Activity tab? It was kept by the IP redesign (§3) to show buy/sell flow and the latest trades after trading moved to Doppler and Fomo. On 2026-10-20 every registered coin's trade index was empty except one trade on GOD, so the tab showed only "No indexed trades in this snapshot.", while each token page view still fetched the trade list for it. The owner chose to remove it.

- Tabs are Overview and About. `tab=activity` links open Overview. `TokenActivity` is deleted; its CSS classes stay because the MUSEGOD page's market card uses them.
- `useLaunchMarket` reads only the summary, so a token page makes one market request per refresh instead of two. The live swap stream stays for the trade card's price: on the token page it runs in summary-only mode, keeping candles and trades null and re-reading only the summary after a gap, reorg or resume. The MUSEGOD page's chart stream is unchanged.
- A compact list of recent trades can return inside the trade card once coins trade enough to fill it.
- Acceptance: page tests cover the two tabs, legacy `tab=activity` links and the About panel's state across tab switches; the refresh test proves the token page reads only `/market/summary`; the stream test proves summary-only pushes and recovery; both fail on the previous code. `npm test`, `npm run typecheck` and `npm run build` pass; a read-only preview shows Overview and About only, with the live trade card.

Released §12 and §13 together on 2026-10-20 on the owner's request: master `82f73f6` through CI run 39434712270 as `build-39434712270-1`, Worker version `283871ea`; rollback point Worker `b49766dd` (`40d17c8`). Live checks on Robinhood Phial and GOD and Base MUSEGOD: the tabs are Overview and About, and a `tab=activity` link opens Overview; each token page makes one market request, `/market/summary`, and none for trades; Phial's About shows the treasury card without identity rows, Agent identity without Controller and the four-row On-chain record, with no NFT fee card or second gross table, while the beneficiary card links its collection, fee vault and treasury; GOD's About is the On-chain record alone; no horizontal overflow at 1280 px; both `readyz` checks operational and the summary and Posts APIs return 200. No database or Worker secret change.

## 14. NFT treasury rows that explain themselves, 2026-10-21

Owner request: on the About tab (live Phial page), "Collection · Verified collection", "Coin status · Verified", "Holder · Connect a wallet to check" and "Treasury lock · Not active yet" do not say what they mean. Rule: every row of the NFT treasury card names what it describes, shows a value a visitor can act on, and carries a one-line plain note where the value alone is not enough. The card is shared by the token page and the NFT page, so both change. No server, Worker or database change.

| Row | Before | After |
| --- | --- | --- |
| Collection | "Verified collection" / "Unverified collection" | The collection's name and status: "Muses · verified" (Muses), "Verified" (another allowlisted contract) or "Unverified" (warning). Note: verified means the official contract on musegod.fun's verified list; unverified warns that look-alike collections exist and to check the contract address |
| Coin status → Official coin | "Verified" / "Unverified" / "Rejected: already_launched" (raw reason code) | "Yes" (this NFT's one verified coin, launched by its holder or the holder's delegate; one per NFT), "Not confirmed yet" (the launch check could not finish: chain unreadable at launch, or launch fee unconfirmed) or "No" (warning) with the reason in words: another coin was verified first, the launcher did not control the NFT, not an ERC-721 contract, launch fee not paid, pair not allowed at launch; a rejected coin's note adds that its creator fees still go to this NFT's vault |
| Holder → Current holder | "Connect a wallet to check" for visitors | The holder's address with an explorer link, read publicly with `ownerOf` through the RPC proxy for visitors (the connected wallet keeps the existing `/nft-status` read), inside one Multicall3 `aggregate3` call so the chain's answer is told apart from a failed read; "(you)" when it is the connected wallet; "None" when `ownerOf` reverts or answers nothing usable; "Unavailable" when the read fails |
| Treasury lock → Treasury status + Withdrawal lock | "Not active yet" / "Activation not finished" / "Unlocked" / "Locked until …" in one row | Two facts, two rows. Treasury status: "Not activated yet" (note: fees still collect at its address; it is activated once before the first withdrawal), "Activation not finished" (note: Withdraw and Lock wait for it) or "Active". Withdrawal lock: "Off", "On until <date>" (warning), "Reading…" or "Unavailable", with the note: while on, the treasury cannot send anything until the date, even for its holder; holders use it while selling the NFT; approvals it gave earlier still work |

- A visitor of an activated treasury reads "Only the NFT holder can withdraw or lock the treasury." in Withdraw and lock instead of a permanent "Checking the NFT holder…".
- The notes sit on their own line under the label and value (a second `dd`), left-aligned, so the right-aligned values stay scannable at desktop and phone width.
- Unchanged: the warning paragraph under the rows, the actions and their gating (a visitor's public holder read never enables an action), the beneficiary card, and the launch review dialog's Collection tile.

Acceptance: unit tests cover each row's value and note for every state (collection verified/Muse/unverified; coin verified, each unverified and rejected reason, unknown reason; treasury not deployed/not initialized/active; lock reading/error/off/on), the public holder read for a visitor (shown with an explorer link, "(you)" for the holder's wallet, "None" and "Unavailable"), and the visitor's Withdraw and lock copy; each fails on the previous code. `npm test`, `npm run typecheck` and `npm run build` pass; a read-only preview of Phial at 1280 px and 390 px shows the new rows without horizontal overflow.

Cross review, 2026-10-21: codex (gpt-6.1-sol, xhigh) reviewed the change and raised three P2 findings, each confirmed and fixed with a regression test. The lock note promised more than the account enforces (a Tokenbound V3 lock stops the account's own transactions, not ERC-20 approvals it gave earlier), so it now says approvals still work. The public holder read used viem's `multicall` with `allowFailure`, which reports a failed RPC request as a failed entry, so an outage read as "None" with the no-holder warning; it now reads `ownerOf` inside one `aggregate3` call and throws when the request fails (the new test uses a real viem client and fails on the previous read). "The first coin launched" did not match the rule, which gives the badge to the first coin verified for the NFT, so the notes now say "one verified coin" and "verified for this NFT first". Local acceptance: `npm test` and `npm run build` pass; the read-only preview showed the Phial About tab and the Muse #610 NFT page with the new rows at 1280 px and 390 px, no horizontal overflow, and the holder read without a wallet.
