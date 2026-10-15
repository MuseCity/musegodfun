# NFT mode: pick the NFT from the connected wallet — spec

Status: draft for owner review, 2026-10-15. Builds on `tasks/nft-mode.md` (NFT mode, live on Robinhood since release `0e0da30`).

## 1. Goal

Today the NFT launch asks for a contract address and a token number, inside the Identity step. Most holders do not know either.

NFT mode becomes three steps, and the first one starts from what the connected wallet holds:

1. **NFT:** pick a collection the wallet holds, then one NFT in it. The existing live check runs, and the $10 fee is paid if the NFT is not a Muse.
2. **Identity:** unchanged, prefilled from the NFT's name.
3. **Economics:** unchanged.

Normal mode keeps its two steps (Identity, Economics).

## 2. Owner decisions (2026-10-15)

| # | Decision |
|---|---|
| W1 | Step order: NFT → Identity → Economics. Identity and Economics keep today's pages. |
| W2 | The collection list pins Muses at the top and is searchable. Manual entry (contract + token number) stays as a fallback. |
| W3 | Selecting an NFT prefills only the coin's name and symbol. The coin image is still uploaded by the user. |
| W4 | Data source: the Alchemy NFT API v3 with the server's existing `ALCHEMY_API_KEY`. Its responses carry OpenSea collection metadata (name, logo, safelist status), which is used for display and ordering. The OpenSea API is not called; `OPENSEA_API_KEY` is not used. |

Facts checked on 2026-10-15 with a real Muse holder on Robinhood:
- Alchemy `getContractsForOwner` and `getNFTsForOwner` work on `robinhood-mainnet`. That holder has 203 collections and 379 NFTs.
- Alchemy's spam filter (`excludeFilters[]=SPAM`) needs a paid plan (HTTP 400 on ours), and `isSpam` is false for every collection.
- `openSeaMetadata.safelistRequestStatus` is present. Muses are `approved`, one other collection is `verified`, and most are `not_requested`.
- The OpenSea API (`/chain/robinhood/account/{addr}/nfts`) returns 191 collections for the same wallet. `include_auto_hidden` changes nothing for it, and it gives collection slugs only, not names.

## 3. Flow

### 3.1 Launch type and step bar

- When NFT mode is enabled for the page's network, the two launch type cards (Normal, NFT) sit **above** the step bar, because the mode decides how many steps there are.
- The step bar shows two steps (Identity, Economics) in Normal mode and three (NFT, Identity, Economics) in NFT mode. The screen-reader text reads "Step n of N".
- **Choosing NFT** opens the NFT step.
- **Choosing Normal** behaves as today: the NFT is cleared and the page opens Identity.
- Moving forward from the NFT step needs the step to be complete (§3.3). That applies to both the Continue button and the step bar.

### 3.2 The NFT step

| State | What the person sees |
|---|---|
| No wallet connected | "Connect your wallet to see your NFTs" and the existing connect button. |
| Loading | "Loading your NFTs…" |
| Collections | A search box ("Search your collections": name or contract address). Below it, one row per collection, as a button: logo, name, "N held", and badges. |
| One collection open | "← All collections" and the collection name, then a grid of the wallet's NFTs in it: image and name, or "#id". |
| NFT selected | A summary (image, name, short contract, #id) with a "Change" button. Below it, the existing live check result and, for a paid NFT, the existing $10 fee panel. |
| No NFTs found | "No NFTs found in this wallet on Robinhood Chain." Manual entry stays offered. |
| List failed | "Couldn't load your NFTs.", a Retry button, and manual entry. |

**Collection rows:**
- Badges:
  - "Free" for a free collection (the config's `freeCollections`), "$10" otherwise.
  - "Verified on OpenSea" when the OpenSea safelist status is `verified` or `approved`.
- Order:
  1. Muses, matched by contract address `0x13ea3072b7215d4c9c2ec4f498a08c5825129836`, never by name.
  2. Collections verified on OpenSea.
  3. The rest, by NFTs held (most first), then by name.
- Search filters that list client-side. It matches a case-insensitive substring of the name, or a prefix of the contract address.

**NFT grid:**
- NFTs are ordered by token id, ascending.
- An NFT that already has a verified coin shows "Already launched" and cannot be selected.

**Manual entry:**
- "Enter a contract and token number instead" opens today's two inputs (contract, Muses preset; token number).
- It is the path for a wallet that controls an NFT through delegate.xyz, and for an NFT the list misses.

**Selecting an NFT:**
- Selection, by either path, hands the NFT to the existing check and fee logic (`NftLaunchStep`). The rules do not change: ERC-721, holder or delegate, one coin per NFT ever, and $10 unless the NFT is free.
- The list is only a convenience; the live check is the authority.

**Continue:**
- It moves on only when the live check passed for the connected account and the fee is settled (free, or paid and confirmed). These are the conditions `nftReviewBlocker` already applies.
- Otherwise the person stays on the step, and the step shows which condition is missing. This is how Identity's Continue already works.

**Prefill (W3):**
- A Muse keeps today's prefill (its on-chain name, through `musePrefill`).
- Any other NFT prefills from its listed name with the same rules: only empty fields; the symbol is the name's letters, at most 10, in upper case.
- A name or symbol the reserved-name rule would refuse (D8, MUSEGOD) is not prefilled.

**Other behaviour:**
- **Wallet change:** the list reloads for the new account. A selected NFT is checked again (as today); if the new account does not control it, the check reports so.
- **Mobile, 375 px wide:** rows are full width, the NFT grid has two columns, and there is no horizontal page scroll.
- **Accessibility:** every row and tile is a real button with an accessible name. Keyboard order is search, rows or tiles, then Continue.

### 3.3 Drafts and draft links

- A draft keeps `nftMode`, `nft` and its step. The saved step numbers are:
  - `0`: the NFT step, which exists in NFT mode only;
  - `1`: Identity;
  - `2`: Economics.
- **Restoring a step:**
  - Saved `1` and `2` reopen where they were, in both modes. This includes NFT drafts saved before this change.
  - Saved `0` reopens at the NFT step in NFT mode, and at Identity otherwise.
  - A draft with no saved step reopens at the NFT step in NFT mode, and at Identity otherwise. A draft link has no saved step.
  - Old drafts are not remapped. A remap could not tell an old step 1 from a new one, and two tabs would then move each other's step.
- **If the NFT check has not passed:** an NFT draft restored at Identity or Economics is sent back to the NFT step by Continue or Review, with the `nftReviewBlocker` message.
- **Launching:** after a launch, an NFT-mode draft resets to the NFT step. A normal draft resets to Identity.
- **Draft links:** a link that carries `nft` (see `public/skill.md`) opens NFT mode on the NFT step, with that NFT selected. It is checked once the wallet is connected.
  - The link's identity fields import as today.
  - "The page stays on step 1" in `skill.md` stays true: step 1 is now the NFT step.
- Review stays blocked by `nftReviewBlocker` whatever step a draft restores to.

## 4. Server API

There are two new read endpoints. They sit next to `nft-status` and are served under the chain prefix (`/api/chains/4663/…`), like the other NFT endpoints. Both are GET, public and unauthenticated, and use the `read` ingress class.

### 4.1 `GET …/nft-collections?owner=0x…`

```json
{ "owner": "0x…", "truncated": false,
  "collections": [ { "contract": "0x…", "name": "MUSEGOD Muses", "image": "https://…", "held": 2,
                     "free": true, "openSeaVerified": true } ] }
```

- **Source:** Alchemy `getContractsForOwner` (`pageSize=100`), following `pageKey` for at most 3 pages (300 collections). `truncated` is true when more remain.
- **Kept:** `tokenType === "ERC721"` only. `isSpam === true` is dropped if Alchemy ever sets it.
- **`name`:** `openSeaMetadata.collectionName`, else `name`, else the short contract address.
- **`image`:** `openSeaMetadata.imageUrl`, else `image.thumbnailUrl`, else `image.cachedUrl`. It is kept only when it is an `https:` URL.
- **Other fields:**
  - `held` is `numDistinctTokensOwned`.
  - `free` comes from the config's `freeCollections`.
  - `openSeaVerified` is true when `safelistRequestStatus` is `verified` or `approved`.
- **Sorting:** the server returns the §3.2 order.

### 4.2 `GET …/nft-tokens?owner=0x…&contract=0x…`

```json
{ "owner": "0x…", "contract": "0x…", "truncated": false,
  "tokens": [ { "tokenId": "631", "name": "Sealed Muse", "image": "https://…", "launched": false } ] }
```

- **Source:** Alchemy `getNFTsForOwner` with `contractAddresses[]=contract`, `withMetadata=true` and `pageSize=100`, for at most 3 pages (300 NFTs).
- **Fields:**
  - `tokenId` is a decimal string.
  - `name` is the NFT's name, else absent.
  - `image` is `image.thumbnailUrl`, else `image.cachedUrl`, https only.
- **`launched`:** true when a `verified` coin exists for `(4663, contract, tokenId)`, the same rule as `nft-status`'s `alreadyLaunched`. It is read in one pass over the catalog, not once per token.

### 4.3 Both endpoints

- **Inputs:** `owner` and `contract` must be addresses; otherwise HTTP 400 with the validation message.
- **Network:**
  - NFT mode off, including every Base request: HTTP 422 `NFT_MODE_UNAVAILABLE`, before any provider call (`assertNftModeAvailable`).
  - A network other than the deployment's: `NFT_CHAIN_UNSUPPORTED`, as `nft-status` does.
- **Provider failure:** no `ALCHEMY_API_KEY`, a timeout (8 s per call), a non-2xx response, a malformed body, or reaching the list's load cap (6 concurrent uncached loads) or provider budget (120 Alchemy calls per rolling minute) all give HTTP 503 `NFT_LIST_UNAVAILABLE`, "Your NFTs could not be loaded. Enter the contract and token number instead." Identical in-flight requests share one load.
- **Caching:** in memory for 60 s, per owner for collections and per owner + contract for NFTs. Keys are lowercase addresses. A failure is not cached.
- **Secrecy:** the Alchemy key stays on the server. Responses carry no Alchemy URL other than image URLs.
- **Cost:** at most 3 Alchemy calls per uncached request. They go to the NFT API host (`robinhood-mainnet.g.alchemy.com/nft/v3/…`), not to the RPC proxy.

## 5. Out of scope

- Spam filtering beyond the OpenSea ordering; Alchemy's filter needs a paid plan.
- Using the NFT's image as the coin image.
- Listing NFTs delegated to the wallet through delegate.xyz; these go through manual entry.
- Base (NFT mode is off there), ERC-1155, and collections past the first 300 except through manual entry.

## 6. Documentation updated in the same change

- `tasks/nft-mode.md`:
  - §6.5 "Create" describes the three-step flow and the picker, replacing "Enter the contract and token id".
  - §6.7 gains a row for the two list endpoints.
- `docs/SPEC.md`: the NFT APIs paragraph lists `nft-collections` and `nft-tokens`, with their 422 and 503 rules.
- `public/skill.md`: what the holder sees on opening a link mentions the NFT step with the NFT selected. Its tests follow.

## 7. Acceptance

1. On Robinhood with NFT mode on, the launch type cards sit above the step bar. NFT mode shows three steps, and Normal shows two, unchanged.
2. A connected wallet sees its ERC-721 collections:
   - Muses first, by address, with "Free";
   - OpenSea-verified collections next, with their badge;
   - the rest by NFTs held.
   Search filters by name or address.
3. Opening a collection lists the wallet's NFTs in it. Already launched NFTs cannot be selected.
4. Selecting an NFT runs the existing check and fee flow. Continue, and the step bar, move on only when `nftReviewBlocker` would pass; otherwise the step says why. Name and symbol are prefilled only into empty fields, never with a reserved name.
5. Manual entry works, and it is offered when the list is empty or fails.
6. The endpoints return the §4 shapes and codes: 400, 422 (including Base), 503 `NFT_LIST_UNAVAILABLE`. They respect the 300 caps with `truncated`, cache for 60 s, and never expose the Alchemy key.
7. Drafts restore their step as §3.3 says. A draft link with `nft` opens on the NFT step with that NFT selected. Two tabs on one draft never move each other's step unless the saved step itself changed.
8. Normal mode, Base, and every other page behave as before.
9. At 375 px there is no horizontal page scroll, and every control is reachable by keyboard with an accessible name.
10. `npm test` passes, with new unit tests for:
    - Alchemy parsing;
    - ordering and search;
    - caps and `truncated`;
    - the 400, 422 and 503 paths;
    - cache expiry;
    - the `launched` marking;
    - prefill rules;
    - draft step restore.
11. Review follows the owner's codex ↔ claude cross-review rules before release.
12. After an owner-approved release, codex runs a read-only QA of the live site in Chrome: no wallet, so only the not-connected state, the step bar, manual entry and the endpoint error paths.
    The owner checks the connected-wallet list with their own wallet.

## 8. Risks

| Risk | Handling |
|---|---|
| Alchemy compute use | 60 s cache, 3-page caps, `read` ingress limits, identical in-flight requests share one load, 6 concurrent uncached loads, 120 Alchemy calls per rolling minute |
| A new mint is not yet indexed by Alchemy | Manual entry |
| A copycat collection named like Muses | Muses are pinned and marked free by contract address only. The existing disclaimer ("musegod.fun does not endorse NFT collections…") stays on the step. |
| "Verified on OpenSea" read as a musegod.fun endorsement | The badge names OpenSea, and the disclaimer stays |
| A wallet with more than 300 collections | `truncated` note: "Showing the first 300. Use manual entry for others." |
