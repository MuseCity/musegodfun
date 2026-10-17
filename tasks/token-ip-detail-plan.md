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

- **Hero card:** coin image, an overline (network, pair, launch date; NFT coins: collection and token id), name, `$SYMBOL`, trust badges, the launch description as the story, a meta row (creator and the fee line; NFT coins add the pair and launch date), the link row (social links, OpenSea for NFT coins, Share, Edit profile for the owner), a headline figure (the creator's or NFT treasury's share of every trading fee) and a stat band of facts the page already has (trading fee, buyback share, opening valuation, supply, linked channels, age).
- **Aside:** the trade card, then the fee beneficiary card. It is a sticky right column when the columns fit side by side (a container query on the columns' own width) and leads the page otherwise.
  - Trade card: the price block (market summary price and 24h change, market cap, liquidity, 24h volume, with source attribution), "Trade on Doppler" (gold), "Open Fomo with invite" plus the contract to search, what a $100 buy pays, and "musegod.fun adds no fee of its own and signs nothing here". When the summary has no price, a "Get pool quote" button reads one on-chain quote for 1 unit of the pair asset, labelled as that buy's average price; it never runs automatically.
  - Beneficiary card: the creator address (Route 1) or the NFT, its vault and treasury (Routes 2–3), the share, and a button that opens the On-chain tab.
- **Tabs:** Overview, Activity, On-chain.
  - Overview: About (story and a one-line owner statement), Channels (one card per linked channel, link only), and for Route 3 the agent identity.
  - Activity: the buy/sell flow by period and the recent trades feed (any venue, live via the swap stream).
  - On-chain: first-buy lock, the NFT treasury card (Routes 2–3), beneficiary fees (FeeCard), the fee disclosure, contract details and the launch curve.
- No chart (the trade card links to Doppler's chart), no Posts tab and no channel metrics: no data source exists, and the redesign's data-honesty rule omits elements with no backing API. They return when a source exists.

## 4. Trading venues

- Doppler: `https://app.doppler.lol/tokens/{base|robinhood}/<lowercased address>` for every registered launch on Base or Robinhood Chain. Registration already verifies the pool identity against the canonical Doppler contracts, and the Doppler app lists launches on both chains (checked 2026-10-17: MVADER on Robinhood, MUSEGOD `0x79ea…e670` on Base). This replaces the empty release-reviewed allowlist of the deleted `src/lib/doppler.ts`. Forks never link.
- Fomo: shown only when the public runtime value `FOMO_INVITE_HANDLE` is set; the button opens `https://fomo.family/r/<handle>`. Fomo has no per-coin link, so the card shows the contract address with copy. The owner must set the handle before release.
- The in-page swap (buy/sell, pay with ETH, quotes, slippage, price impact) is removed with its client-only code. Server endpoints stay where something else uses them (MUSEGOD trading, the launch first buy, release verification).

## 5. Profile links

- Fields: X, YouTube, TikTok and Telegram handles, and a website. All optional; empty fields are not shown. Inputs accept a handle, an `@handle` or the platform URL and are stored normalized. The website must be a public `https:` URL of at most 200 characters.
- Until an owner saves a profile, the page shows the launch links (`twitter`, `telegram`, `website` in the token record). A saved profile replaces them entirely.
- Saving signs EIP-712 typed data `TokenProfile { token, x, youtube, tiktok, telegram, website, issuedAt }` in domain `{ name: "musegod.fun", version: "1", chainId: <coin chain> }`. No gas, nothing on-chain.
- The wallet policy (`src/lib/wallet-signing.ts`) keeps refusing every signature method for every other flow. A dedicated profile signer accepts exactly one `eth_signTypedData_v4` request whose account, domain, types and message match what the editor built; no `verifyingContract`, no other primary type.
- Server (`POST /api/tokens/:address/profile`): validates the fields, requires `issuedAt` within 10 minutes of now and newer than the saved profile, recovers the signer (EOA locally; contract wallets through ERC-1271/6492 under a request budget), then checks ownership: Route 1 the recorded creator, Routes 2–3 `readNftControl` (holder or delegate). Forks and unknown coins are refused.
- Storage: `snapshots` key `profile:<lowercased address>` (the per-chain scope is the store scope), like the persistent `pinata:` records. Cleanup in SQLite and the Supabase `musegod_cleanup` function skips `profile:` keys (migration `20261017120000_profile_snapshots.sql`, to be applied before release; security attributes unchanged). Backups already include snapshots.
- `GET /api/tokens/:address` returns `profile` (links, signer, savedAt) when one exists, and `nftProfile` (`name`, `agentId`) for Muse coins, cached in memory like `nftStatus`.

## 6. Acceptance

1. Route 1 page renders the hero, trade card, beneficiary card and three tabs; tab switching works; no swap form or chart remains on the token page.
2. Doppler links appear for every registered non-fork coin on both chains; the Fomo button appears only with `FOMO_INVITE_HANDLE`.
3. Social links render only when present, from the saved profile or else the launch links, always `target="_blank" rel="noopener noreferrer"`.
4. The owner sees Edit profile; others do not. A save by a non-owner, a replayed or stale signature, a signature for another coin or chain, or an invalid link is refused with a clear message.
5. The profile signer refuses any other signature or transaction request; every other flow still refuses all signatures.
6. NFT coins show the collection overline, OpenSea link and NFT treasury card; Muse agent coins show the identity card.
7. Profiles survive cleanup in both stores.
8. `npm test`, `npm run typecheck` and `npm run build` pass; repo documents stay English; README and SPEC describe the new page.
9. The page works at phone width (390 px): the aside stacks above the tabs, tabs scroll horizontally, no horizontal page scroll.

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
