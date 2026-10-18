# Agentic NFT meme mode — spec and plan

Status: **Robinhood implementation in progress on `codex/nft-mode-robinhood`** (proposal 2026-10-12; fee model reconfirmed 2026-10-13: Muses free, other NFTs $10). Implementation plans: `tasks/nft-mode-robinhood-plan.md` (first; includes the shared contracts, app and UI) and `tasks/nft-mode-base-plan.md` (enables Base). It replaces the Muse-only launch plan (`tasks/muse-launch.md`, removed on 2026-10-13 at the owner's request).

The owner asked for:
- a new launch mode alongside the normal mode
- any ERC-721 on any EVM chain can launch a meme coin bound to it
- the coin's treasury travels with the NFT when it is sold
- MUSEGOD Muses launch free; other NFTs pay $10 per launch
- each NFT can launch only one coin, ever (owner decision, 2026-10-13)

Code references were taken at master `1772c0a`.

## 1. Research summary (2026-10-12)

| Item | Finding | Evidence |
|---|---|---|
| "721T (ERC-8048)" | **Correct.** ERC-8048 "Onchain Metadata for Token Registries" (Draft): `metadata(uint256,string) returns (bytes)`, ERC-165 `0xdf670be1`. "ERC-721T" is a nickname for its profile with keys `context`, `endpoint[<type>]` (mcp, a2a, web, x402), `address[<chain-id>]`, `account[<chain-id>][<index>]`. The Muses support `0xdf670be1`; Muse #1 has `context` (its SOUL.md, 1,780 bytes) and `endpoint[web]`. The `agent-registration[...]` key the Muses use comes from ENSIP-25, not ERC-8048. The Muses owner can still rewrite unlocked keys | eips.ethereum.org/EIPS/eip-8048; on-chain reads |
| "8004A (ERC-8217)" | **Mostly correct.** ERC-8217 "Agent NFT Identity Bindings" (Draft, 2026-04): `bindingOf(agentId)`, immutable bindings. Adapter8004 (`0x000000009d62…5E18`, Robinhood only) implements it. It holds the ERC-8004 identity tokens; Muse #1 is agent 6592, bound to `(ERC721, Muses, 1)`. "Reviews" are ERC-8004 Reputation Registry feedback keyed by agentId, so the binding links NFT → agent → reviews. ERC-8217 itself does not mention reviews | ERC-8217 text; verified source on Sourcify; on-chain reads |
| Adapter8004 control rule | Holder (`ownerOf`) or delegate.xyz v2 delegate (rights `adapter8004.manage` or unscoped). The bound NFT must be on the adapter's own chain. The adapter is UUPS-upgradeable by its owner `0x0330…3149` | `AdapterImplementation.sol` |
| ERC-8004 | Draft. The identity registry is ERC-721 (upgradeable). `agentWallet` is set with an EIP-712 or ERC-1271 proof. Identity `0x8004A169…a432` and Reputation `0x8004BAa1…9b63` are on Base, Robinhood and Ethereum | eips.ethereum.org/EIPS/eip-8004; on-chain |
| ERC-6551 | ERC-6551 registry `0x000000006551…5758` and Tokenbound V3 (proxy `0x55266d75…7E7F`, implementation `0x41C8f394…44eC`) are on **Base and Robinhood** (also Ethereum). The account address is identical on every chain. `owner()` is zero when the NFT lives on another chain | eip-6551; on-chain |
| delegate.xyz v2 | `0x00000000000000447e69651d841bD8D104Bed493`, immutable, on Base and Robinhood | on-chain |
| Doppler fee rights | Both creator shares (LP and hook) are fixed at creation (`src/lib/protocol.ts:149-152, 160-163`). `collectFees(poolId)` is permissionless but pays only the caller's share. **`updateBeneficiary(poolId, new)` moves the caller's own shares.** A zero-share caller can still push a target's accrued fees to it, so balances can arrive without a claim. Contract beneficiaries are fork-proven in this repo (`scripts/test-buyback-engine-fork.ts:284-290`, `scripts/test-base-collector-fork.ts:145-166`). The zero-share push is fork-proven only on Base (`scripts/test-base-collector-fork.ts:149-157`); for Robinhood it rests on a review finding. Fee contracts: Rehype `0x5f9e…3215` (both chains); initializer Base `0xbdf9…6544`, Robinhood `0x4e34…a544` | Doppler `FeesManager.sol`; `contracts/test/MusegodBaseFeeCollector.t.sol:58-67`; `docs/evidence/go-live-ux-acceptance.json:257`; `src/lib/config.ts:18-34` |
| Earlier attempt in this repo | `stash@{0}` on `codex/add-agentic-nft-meme-creation` (2026-10-06; 104 files, about 24k lines; never deployed). It was Muses-only, with one project per NFT and hosted Bankr "minds". Net revenue was split 60% policy vault / 10% compute escrow / 10% current holder / 16% buyback / 4% operations, with a trusted-attestor price guard. Its `AgenticOwnerReceiver` pays unclaimed income to the current `ownerOf` at release time. Its `AgenticFeeReceiver` requires exact share equality, which breaks once shares change | `git stash show stash@{0}`; stashed `docs/SPEC.md` section and `contracts/src/Agentic*.sol` |
| Cross-chain | lzRead does not list Robinhood. CCIP (since 2026-07-01) and Hyperlane list Robinhood. Relay and Across bridge ETH to and from Robinhood | LayerZero, Chainlink and Hyperlane docs; api.relay.link/chains |
| Prior art | Flaunch represents revenue rights as an NFT. Zora and pump.fun allow redirecting payouts. No NFT-bound meme launchpad with a home-chain treasury was found. Pons charges 0.0005 ETH per launch | Flaunch, Zora and pump.fun docs and coverage |

**Design consequence:** if the NFT's own ERC-6551 account were the Doppler beneficiary, its holder could call `updateBeneficiary` before a sale and redirect future fees. The beneficiary must therefore be a small contract that cannot redirect.

## 2. Design in one paragraph

Every NFT gets two addresses:
- **The treasury:** its standard ERC-6551 account (Tokenbound V3, salt 0) on the NFT's home chain.
- **A fee vault:** deployed deterministically on the coin's chain.

The vault is the Doppler creator-fee beneficiary of every coin bound to that NFT. Anyone may call `sweep`, which collects the vault's fee share and moves it to the treasury. The vault has no owner, no upgrade path and no redirect function, so the fee stream is permanently bound to the NFT. The holder controls the treasury through ERC-6551; selling the NFT moves control of the treasury and of all future fees. Ownership is never read in the money path; it is resolved by the treasury account at withdrawal time.

**v1 covers NFTs on the coin's own chain** (Base NFTs on Base, Robinhood NFTs on Robinhood, including the Muses). The data model and addresses are chain-agnostic. Phase 2 adds home chains elsewhere by bridging swept fees to the same treasury address on the NFT's chain.

## 3. Out of scope for v1

- Cross-chain NFTs, meaning the NFT's chain differs from the coin's chain (Phase 2).
- ERC-1155 and ERC-6909, which have no single holder.
- Hosted AI "minds", X or Telegram bots, an owned-NFT picker and art pinning (Phase 2–3).
- Changes to the normal mode, the platform fee split, MUSEGOD buyback, guards, keepers, the Base fee pipeline or signing controls.
- First buys deposited directly into the treasury. v1 offers a "Deposit to treasury" transfer helper after launch instead.

## 4. Owner decisions (recommended option first)

| # | Decision | Recommended | Alternative |
|---|---|---|---|
| D1 | Treasury | Fee vault (new contract) → standard Tokenbound V3 account: a real treasury, usable as the agent's wallet, ready for cross-chain | (b) The vault releases straight to the current `ownerOf` (the stash's `AgenticOwnerReceiver` pattern): simplest, same-chain only, no treasury balance. (c) Beneficiary = the Tokenbound account directly: no new contract, but the holder can redirect fees before a sale |
| D2 | Who may launch for an NFT | Holder, or a delegate.xyz v2 delegate for that token or contract | Holder only |
| D3 | Launch fee | Muses free. Other NFTs: $10 per launch, paid as exactly 10 USDC (Base) or 10 USDG (Robinhood), or in ETH using a 60-second server-signed quote. One payment = one launch credit for that payer. No refunds | Stablecoins only |
| D4 | Where the $10 goes | 100% to the operations wallet | Split with MUSEGOD buyback |
| D5 | Muse coins | Any eligible pair, MUSEGOD by default (owner, 2026-10-18, replacing "MUSEGOD pair required"); still free whatever the pair. Like every NFT, a Muse gets one coin, ever (owner decision) | MUSEGOD pair required |
| D6 | Other NFT coins | Any eligible pair; one coin per NFT, ever (owner decision) | — |
| D7 | Collection labels | Verified badge only for a committed allowlist (Muses at launch). Everything else shows "Unverified collection" with its contract address | Show every collection equally |
| D8 | Reserved names | New launches may not use `MUSEGOD`, or an allowlisted collection's name, unless bound to that collection | MUSEGOD only |
| D9 | Moderation | Committed hide list (changes ship as a release). The shared catalog API returns `hidden: true`; the Explore UI filters those out, while Rewards and treasury pages keep them. The public `?nft=` API omits them | DB table plus CLI |
| D10 | Phase 2 cross-chain route | Sweep pair-asset fees home over Relay or Across; meme-token fees stay in the vault until swapped under price protection | Hyperlane or CCIP ownership messages |
| D11 | The earlier stash | Retire it as the product baseline. Reuse only these ideas: release-to-current-holder (the D1 fallback), the fee-calldata assertion, and the registry tests. Keep it as reference for the Phase 3 hosted minds. Dropping the stash and branch is irreversible, so the owner confirms it separately. The stash stack is shared, so first resolve SHA `6a344b86…` to its current `stash@{n}` with `git stash list --format='%H %gd'`, then drop that reference | Revive it (Muses-only; heavy custody, Bankr and attestor trust; about 24k unreviewed lines; would need rebasing onto today's master) |

## 5. Contracts (new: Phase 1A)

### 5.1 `MusegodNftFeeVault` and factory

- **Deployment:**
  - The factory deploys one vault per (home chain, NFT contract, tokenId) on each coin chain, by CREATE2 from inside the factory. `vaultFor(homeChainId, nft, tokenId)` is computable off-chain, so a launch can name a vault that is not yet deployed.
  - The factory itself uses the repo's existing plain-CREATE, nonce-predicted TS deployment (`scripts/deploy-base-collector.ts:60-73`). The repo has no CREATE2 tooling, so a different factory address per chain is fine.
  - Each chain's factory address, factory runtime hash and vault creation-code hash go in a committed manifest, following the pattern of `src/lib/launch-policy-registry.ts:43-99`.
  - A fork test asserts that the TypeScript `vaultFor` equals `factory.vaultFor()` on both chains. A mismatch would strand fees.
- **Immutables:**
  - the NFT identity
  - `treasury = ERC6551Registry.account(TokenboundV3Proxy, 0, homeChainId, nft, tokenId)`
- **Fee sources:** hard-coded per `block.chainid` (Rehype and the chain's initializer), the way `contracts/src/MusegodBaseFeeCollector.sol:22-23, 62` does. They are not constructor arguments, because the initializers differ by chain (`src/lib/config.ts:18, 33`).
- **Functions:**
  - `sweep(bytes32[] poolIds, address[] tokens)`: permissionless and non-reentrant. It calls `collectFees(poolId)` on both fee sources, then transfers each listed token's full balance, and ETH, to `treasury`.
    - It is balance-based, with no share-equality checks.
    - Between the claims and the transfers, it activates the treasury, as ruled in Task 2b fix round 1:
      - It calls the canonical registry's `createAccount`, which is idempotent, then `initialize` with the Tokenbound V3 implementation. Failures are ignored and recorded in `TreasuryActivation(treasury, created, initialized)`.
      - If the treasury still has no code, it transfers nothing (`SweepFailed(token, TreasuryMissing())`).
      - An account that someone initialized to another guardian-trusted implementation before the first sweep keeps it. This residual risk is recorded in fork gate 7.
    - Failures are isolated per source and per token, as in `contracts/src/MusegodFeeEngine.sol:200-218, 266-283`. Stock tokens can pause or restrict transfers, so one bad token never blocks the others.
  - `receive()`.
- **Not present:** owner, upgrade, arbitrary call, `updateBeneficiary`, withdraw-to-anyone.
- **v1 guard:** `homeChainId == block.chainid`. A cross-chain variant ships later as a separate implementation (Phase 2).
- **Events:** `Swept(poolId, token, amount)` and `SweepFailed(source or token, reason)`.
- **Precedent and tests to reuse:** `contracts/src/MusegodFeeEngine.sol:291` and `contracts/src/MusegodBaseFeeCollector.sol:119-140` (its `collectFees` call is at `:134`) already claim fees as contract beneficiaries.

### 5.2 Gates before deploying

- **Doppler:**
  - Already proven: contract beneficiaries on both chains, and the zero-share `updateBeneficiary` push on Base only.
  - Still to prove on forks: the same push on Robinhood, and on both chains that a counterfactual (not yet deployed) vault named at creation is paid once it is deployed and swept.
- **Tokenbound V3:** read the deployed `AccountV3` and `AccountGuardian`. Confirm that for a same-chain NFT only the holder (and holder-granted permissions) can execute, and that guardian-trusted executors cannot. The guardian owner has no code on Robinhood.
  - If that fails, D1 falls back to option (b): release to the current `ownerOf`.
- **Tests:**
  - Forge unit and fuzz tests. CI forge runs offline.
  - TS + Anvil fork scripts on both chains, following the existing `scripts/*-fork.ts` pattern. Real pools: launch with the vault as beneficiary, trade, sweep, transfer the NFT, withdraw as the new holder, and confirm the old holder cannot.
- **Release:**
  - Add the vault build and `git diff` artifact checks to `.github/workflows/deploy.yml`, like the existing contract artifacts.
  - Sourcify verification.
  - Review per `~/.claude/rules/review-fix-roles.md`.
  - Owner-authorized deployment.

## 6. Application changes (Phase 1B)

### 6.1 Schema, launch builder and metadata

- **Draft fields:** add optional `nft {chainId, contract, tokenId}` and `launchFee` to `launchSchema`, which is strict and shared.
  - Canonical NFT identity: `contract` is a checksummed address. `tokenId` is a decimal string with no leading zeros, below 2^256. `ownerOf` would read "007" as 7, so non-canonical ids would dodge the string-keyed one-coin rule and the per-NFT mutex.
  - `launchFee` is `{txHash}` for stablecoins, or `{txHash, wei, expiresAt, mac}` for an ETH quote.
  - Store the transaction hash lowercased; `hashSchema` does not normalise it (`src/lib/validation.ts:25`).
  - Update `restoreDraft`, the key list in `launch-wallet.ts` and the key-pin test (`tests/launch-draft.test.ts:177`) together.
- **Changed-draft comparisons:** `src/lib/launch-wallet.ts:220-223` uses `!==` per key, so an `nft` object would always read as changed; compare its scalars. The prepare refresh check (`server/service.ts:407-413`) has no key loop; add explicit `nft` and `launchFee` comparisons.
- **Launch builder** (`src/lib/protocol.ts:137-176`): add an explicit fee recipient.
  - In NFT mode, the creator's LP and hook shares go to the vault, which `buildLaunch` itself derives from `draft.nft` and the committed factory manifest. Backup recovery re-encodes with `plan.creator` (`server/launch-verification.ts:170`), so it reproduces the same vault.
  - The launcher stays `creator`: transaction sender, first-buy recipient, and an EOA (`server/service.ts:366-373`). `beneficiaries()` already merges and sorts addresses (`src/lib/protocol.ts:61-78`).
- **Binding check:** add `assertNftFeeCalldata` next to `assertEngineFeeCalldata` (`src/lib/protocol.ts:250`), and call it wherever that is called (`server/launch-verification.ts:34`, `src/lib/launch-wallet.ts:103`). It asserts that the creator shares go to exactly the derived vault. Prepare also checks the factory's identity against the manifest.
- **Metadata:** add `properties.nft = {chainId, contract, tokenId, vault, treasury}` only when present, so existing plans re-encode byte-identically.
- **Normal mode:** unchanged.

### 6.2 Checks

- **Prepare**, before RPC, next to `launchAssetsFor` (`server/service.ts:401-402`):
  - flag on
  - NFT chain equals the coin chain (v1)
  - for Muses: MUSEGOD quote by ticker
  - D8 names
- **Prepare**, in parallel with the existing reads (`server/service.ts:435-438`, which today run one after another):
  - `supportsInterface(0x80ac58cd)` and `ownerOf(tokenId)`
  - then, only if the launcher is not the owner, a second hop: delegate.xyz `checkDelegateForERC721(launcher, owner, contract, tokenId, rights)`, with rights `musegod.fun.launch` or unscoped. This mirrors Adapter8004's rule without depending on that upgradeable contract.
- **Prepare**, one coin per NFT: refuse with `NFT_ALREADY_LAUNCHED` if the NFT already has a `verified` coin (registry JSON-path query, both stores). The rule applies to every NFT, for good, and survives sales of the NFT. It counts only `verified` records, so a non-holder cannot use up an NFT's single launch by registering a `rejected` coin from a backup.
- **Prepare**, pricing: Muses launch free; other NFTs need an unused, verified `launchFee` from this launcher.
- **Register:**
  - Reuse a stored `nftVerification` if present.
  - Otherwise check control at the latest block for server-saved previews, or at the receipt block for backup recovery (`server/service.ts:749`, `:680`).
  - Re-check the payment's single use and the one-coin rule (`verified` records only, excluding the coin itself) under a per-NFT in-process mutex. A losing coin registers with `rejected: already_launched` and no badge; its fees still go to the NFT's vault, because the calldata binds them there.
  - `scripts/nft-reverify.ts` applies the same rule: an `unverified` coin whose NFT already has a `verified` coin becomes `rejected: already_launched`.
  - **Badge rules:** evaluate the collection rules for the badge. The pair never decides it: since 2026-10-18 a Muse coin may pair with any eligible asset, so `rejected: pair` is no longer issued.
  - Persist `nftVerification {status: verified|rejected|unverified, reason, block}`.
  - **RPC failure:** retryable 422 while the receipt block (time from `server/service.ts:798`) is under about 10 minutes old, then `unverified`. `reconcile()` also calls register (`:920`), so the same rule applies there.
  - A record with `nft` but no status counts as `unverified`. Records without `nft` are never touched.
  - Register never blocks on the flag, D5's pair rule or D8; those only affect the badge.
- **Mutexes:** the per-NFT and per-payment mutexes live at the Durable Object level (one per chain, `worker/index.ts:32`), because `refreshRuntime` rebuilds the service (`:38-53`).
- **Database guards (2026-10-14, residual R1):** across processes, partial unique indexes on the token records refuse a second spent `launchFee` hash and a second `verified` coin per NFT, in SQLite and in Supabase (migration `20261014120000_nft_single_use_indexes.sql`, applied before the flag-off publish). A refused registration settles `rejected: fee` or `rejected: already_launched`; a refused `nft:reverify` write prints `CONFLICT` and exits non-zero. Without the guards NFT mode fails closed: the runtime reports it off and `nft:reverify` refuses to run.
- **Operator CLI:** `scripts/nft-reverify.ts` upgrades only records whose `nftVerification.status` is `unverified`, or absent with `nft` present. It uses a new compare-and-swap store method following `server/store.ts:357`. PostgREST `not.in` skips NULLs, so filter explicitly. Cover the new store methods in `scripts/verify-database.ts:96-109`.

### 6.3 $10 launch fee

- **Stablecoins:**
  - Base: a USDC `transfer` of exactly 10.000000 (`0x8335…2913`) to the operations wallet.
  - Robinhood: the same in USDG (`0x5fc5…1d168`).
- **ETH:** `GET /api/chains/:id/launch-fee-quote` returns `{wei, expiresAt, mac}`.
  - The MAC is an HMAC under `PLAN_ATTESTATION_KEY` (`server/config.ts:61-64`) with its own domain string, separate from plan attestations (`plan-attestation.ts:7`). Releases cannot add new secrets (`scripts/release.ts:125-131`), which is why the existing key is reused.
  - Without the key, ETH quotes are refused (fail closed).
  - The quote travels in the draft and backups, so register can re-check it.
  - Payment is a plain ETH transfer of at least `wei` whose block time is at most `expiresAt` plus 10 minutes. The quote itself lives 60 s, but the margin keeps slow wallets from being rejected without a refund.
  - The route spends the LI.FI price budget (`server/runtime-policy.ts:10`), so classify it as ingress `workflow` and `expensive` (`server/abuse.ts:12, 33`) and pin it in `tests/go-live-regressions.test.ts:84`.
- **Verification:** reuse the two-confirmation receipt pattern (`server/lifi.ts:305`) and the stablecoin table (`src/lib/first-buy-payment.ts:6, 25-31`).
  - Checks: status success; `from` is the launcher; recipient and amount correct; not used by any stored record (JSON-path lookup, `server/store.ts:357` / `server/supabase-store.ts:223`, plus the mutex).
  - The server keeps no payment ledger today (first-buy verification is stateless, `server/lifi.ts:278`). The single-use rule therefore comes from the token records.
  - `launchFee` is persisted on a record only after it verifies, including that the payment's `from` equals that coin's creator. Otherwise it is dropped from the record. Backup drafts are normalised by `launchSchema` (`server/service.ts:813`) but not payment-verified (`:812-824`), so without this anyone could put a victim's public payment hash on a throwaway coin.
  - The single-use lookup only considers records whose creator equals the payment's `from`.
  - A verified payment on a registered coin is consumed, whatever its badge status. The NFT-bound launch did happen; a `rejected` or `unverified` status only removes the badge.
- **Error handling:** extend the `BuybackError` branch (`server/app.ts:545`, `server/buyback.ts:42`) so `NFT_*` codes reach the client.

### 6.4 APIs

- **`GET /api/chains/:id/tokens?nft=<chainId>:<contract>:<tokenId>|any`:** an in-memory filter over `service.tokens()` (10-second cache, `server/service.ts:975-985`). It returns only `verified` and `unverified` bound coins (never `rejected` ones), omits hidden coins, and sends `Access-Control-Allow-Origin: *` on this GET only.
- **`GET /api/chains/:id/nft-treasury?nft=…`:** vault and treasury addresses, whether each is deployed, balances, and pending fees through the existing `/api/fees` preview with `account = vault` (`server/app.ts:449`, `server/service.ts:1028`). It uses ingress class `read` and an in-memory cache, because `/api/*` is `no-store` (`server/app.ts:119`, `worker/index.ts:148`).
- **`/api/config`:** exposes `nftMode {enabled, freeCollections, verifiedCollections, launchFeeUsd: 10}`.
  - The flag `NFT_MODE_ENABLED` defaults to `false`. Add it to `wrangler.jsonc` vars (pinned, `scripts/release-policy.ts:24`) and to `assertSecurityTransition` (`:82`).
- **Hide list:**
  - Listing (`server/app.ts:306-318`) keeps hidden coins but marks them `hidden: true`. Explore and Rewards share this catalog (`src/lib/token-catalog.ts:16`): Explore filters hidden coins out, Rewards keeps them. Only the public `?nft=` filter omits them.
  - Detail (`:350-357`) shows a "Hidden by operator" banner.
  - `service.token()` paths for market, quote and fees (`:336, 439, 453`) stay available, so holders can still trade and sweep.
  - `service.tokens()` and `listedTokens` stay unchanged for the buyback reader.

### 6.5 Frontend

- **Create:**
  - A mode switch: Normal | NFT.
  - NFT mode is three steps: NFT → Identity → Economics (`tasks/nft-mode-wallet-picker.md`). The launch type cards sit above the step bar.
  - NFT step: the connected wallet's ERC-721 collections (Alchemy NFT API v3 through `nft-collections`; Muses pinned by address, then OpenSea-verified, then by NFTs held; searchable), then the wallet's NFTs with names and images from OpenSea API v2 (`nft-tokens`, server secret `OPENSEA_API_KEY`; already launched NFTs disabled). Manual entry (contract + token number) remains for delegated wallets and unlisted NFTs.
  - Live checks run on the chosen NFT as before: ERC-721, holder or delegate, tier, plus the vault and treasury addresses.
  - Prefill: name and symbol from the Muse's on-chain name, or from a picked NFT's listed name, skipping reserved values. A picked NFT's image becomes the default coin image: converted and pinned like an upload, replaceable (owner decision W6, 2026-10-15, replacing "art only with official permission"). Prefilled values follow a change of NFT, decided by value: a field holding the NFT's value is the NFT's, and the person's change of NFT clears it at once. Values the person typed or uploaded never follow (`tasks/nft-mode-wallet-picker.md` §3.2).
  - MUSEGOD as a Muse coin's default pair: picking a Muse selects it, and `restoreDraft` gives it to a Muse draft that carries no pair (a draft link). The holder can choose any eligible pair; there is no lock (owner, 2026-10-18).
  - Payment step for paid tiers.
- **Review:** the bound NFT, verified or unverified collection, vault and treasury, and the rules:
  - fees follow the NFT
  - the current holder controls the treasury
  - sellers can withdraw before a sale
  - the $10 is non-refundable
- **Draft link:** `#draft=` JSON may carry `nft`. Apply it after the wallet settles (a `restoring` flag, or through `resumeIntent`). The banner reads "Imported from a link — check every field".
- **Token page:** an NFT card showing the NFT, collection status, vault, treasury, pending fees and treasury balances.
  - Actions:
    - Sweep (anyone)
    - Activate treasury (Tokenbound `createAccount` plus initialize)
    - Withdraw and Lock (holder, through the treasury)
    - Deposit to treasury
  - MUSEGOD-paired coins (any non-WETH pair on Robinhood) buy with ETH from the coin's own trade panel ("Pay with: ETH | <pair>", via LI.FI); the separate "Get MUSEGOD with ETH first" panel was removed on 2026-10-14 at the owner's request.
- **Creator-equals-beneficiary assumptions** must key on the vault for NFT coins, and the UI shows no creator claim for them:
  - `src/App.tsx:408-410, 809-815, 2948, 3266, 3349-3388, 3469-3481`
  - copy at `:1998, 2335, 2487, 2561`
  - `allocateFeeIncome` (`src/lib/fee-policy.ts:90`)
- **NFT page `/nft/:chain/:contract/:id`:** the NFT's `verified` and `unverified` coins (`rejected` coins never appear on an NFT's page), plus its treasury and lock status. A link for marketplace listings. It needs:
  - `knownPage` (`server/app.ts:38`, `server/index.ts:27`, `worker/index.ts:138`), or it returns HTTP 404
  - the router (`src/App.tsx:437-444`)
  - `tests/dualchain-runtime.test.ts:90`
- **Explore:** "NFT coins" and "Muse coins" filters. They exclude `rejected` coins, which list only as normal coins. Badges are `<span>`s: "Muse #N", or "NFT · unverified collection".
- **Rewards:** "My NFT treasuries" for held NFTs. Owners are read client-side over the RPC proxy, bounded to listed NFT coins.
- **Types:** `TokenRecord`, `ExploreToken`, `TokenCardToken`.

### 6.6 Agent integration

- **`public/skill.md` for any NFT's agent:** read your NFT's ERC-8048 records or musegod.org soul, propose name, symbol, description and image, build the draft link, explain the costs (free for Muses, $10 otherwise), the fee rules and the safety rules (only the holder instructs; no keys; never sign alone), find the coin by `?nft=`, and post only where the holder agreed. A doc-drift test checks it.
- **Muse agent card:** `agentOf(id)` → agentId, plus the registration file (`musegod.org/muse/<id>.json`).
- **Phase 2:**
  - Set the treasury as the agent's ERC-8004 `agentWallet` (ERC-1271 proof through Adapter8004), so the agent and its treasury travel with the Muse.
  - Show Reputation Registry feedback.
  - Discover ERC-8217 bindings from `AgentBound` events.

### 6.7 Cost budget

| Path | Extra external calls |
|---|---|
| Prepare (NFT mode) | 1–2 extra round trips (`supportsInterface` and `ownerOf` in parallel; the delegate check only when the launcher is not the owner), plus 1–2 DB reads |
| Register (NFT mode) | 1–2 `eth_call`s (control), payment receipt reads for paid tiers, plus 2 DB reads |
| Create live checks | debounced reads through the RPC proxy (ingress class `read`) |
| NFT step lists | Collections: 1–3 Alchemy NFT API calls (`getContractsForOwner`). NFTs: 1–3 OpenSea account-NFT pages by collection, plus a contract-to-slug lookup cached 1 h per lowercase contract (at most 500 slugs). Pages of 100, at most 3 per list; answers cached 60 s per owner (and contract for NFTs); identical in-flight loads share one request. A shared cap of 6 concurrent uncached loads and separate budgets of 120 Alchemy calls and 120 OpenSea calls per rolling minute per holdings instance; failed calls, slug lookups and pages spend budget. `NFT_LIST_UNAVAILABLE` is never automatically retried by the client; `nft-tokens` adds one catalog read |
| Treasury endpoint | about 3–5 reads, cached briefly |

Vault and treasury addresses are computed locally. Nothing re-verifies on reads.

## 7. Plan

**Working rules:**
- Never run `npm run dev` against the real `.env`.
- `npm test` must pass before any commit.
- Commit, push or deploy contracts only with the owner's authorization, because a master push is a production release.
- Run one-time verification once and persist the result.

### Phase 0 — decisions and alignment (2–3 days)

- [ ] Owner confirms D1–D11. Dropping the stash (D11) is a separate, explicit confirmation.
- [ ] Send the official proposal (Appendix A): Muse name and art use, listing `skill.md` among Muse agent next steps, showing NFT coins on Muse pages, a grant.
- [ ] Legal copy: no collection endorsement, IP warning, non-refundable fee, not investment advice. Get counsel on fee-bearing NFTs if possible.

### Phase 1A — contracts (about 1–1.5 weeks)

- [ ] Doppler and Tokenbound gates (§5.2) on Base and Robinhood forks.
- [ ] `MusegodNftFeeVault` and factory with forge unit and fuzz tests (offline in CI), plus TS + Anvil fork scripts on both chains.
- [ ] Review rounds. Then the owner-authorized factory deployment on both chains (plain CREATE, nonce-predicted) and Sourcify verification, recorded in a manifest under `contracts/artifacts/` with evidence in `docs/evidence/`.

### Phase 1B — app (about 2 weeks; can start in parallel against the predicted factory address)

- [ ] 1. Schema, builder, metadata and error class (§6.1). Tests: key pin, byte-identical re-encoding of old plans, refresh check comparing `nft`.
- [ ] 2. Prepare and register checks, statuses, mutex, one coin per NFT (§6.2). Tests: fetch counts, the no-historical-read test for saved previews, backup recovery, the one-coin rule (self-exclusion, races, a second launch after the NFT is sold).
- [ ] 3. The $10 payment: quote, verification, single use (§6.3).
- [ ] 4. APIs, config flag, hide list and allowlists (§6.4).
- [ ] 5. Create NFT step, payment step, review (§6.5).
- [ ] 6. Token-page NFT card, treasury actions, NFT page, Explore, Rewards, Get-MUSEGOD panel.
- [ ] 7. Draft link and `skill.md` with the drift test (§6.6).
- [ ] 8. `scripts/nft-reverify.ts`, and `scripts/report-nft.ts` (offline metrics, §9).
- [ ] 9. Fork tests:
  - Repair `test:robinhood-fork` (stale `deepEqual` at `:143`).
  - Add `test:nft-launch-fork` on both chains: Muse free launch; paid Base NFT launch; non-holder rejected; delegate accepted; sweep after a sale pays the new holder's treasury.
- [ ] 10. Playwright cases: NFT mode, payment, locked pair, draft link, rejection paths.
- [ ] 11. Docs: SPEC sections (issuance, registration `:49`, token cards, fees), README, `.env.example`.
- [ ] 12. `npm test`, `npm run build`, and a read-only proxy browser check. Then review.

### Phase 1C — release (2–3 days, owner-authorized)

- [ ] Release checks:
  - Extend `checkRuntime` and `checkFunctionalSmoke` (`scripts/release.ts:138, 173`). They must accept the previous version's flags (`:398-399`), so rollback verification passes on pre-NFT builds.
  - Add a `supportsNftMode` rollback marker that applies only when the candidate's NFT flag is on, like `baseRollbackCompatible` (`:216-222`), so it does not block the first flag-off release (`:281-285`).
- [ ] Apply migration `supabase/migrations/20261014120000_nft_single_use_indexes.sql` to the production Supabase project and run `npm run verify:database`. Without it the runtime reports NFT mode off, so a flag-on release fails its runtime check.
- [ ] Push to master with `NFT_MODE_ENABLED=false`. Verify both domains. Record this release as the NFT-compatible rollback baseline, because older builds' strict parse rejects NFT plans.
- [ ] Turn the flag on without announcing it. Run canaries: a free Muse launch on Robinhood and a paid Base-NFT launch on Base. Then sweep, transfer the NFT, and withdraw as the new holder.
- [ ] Announce.
- [ ] Stopping: flag off is a release. For an instant stop, use the per-chain runtime-control pause.

### Phase 2 — any EVM chain, and agents (after the day-30 check)

- **Cross-chain vault variant (D10):**
  - `sweep` bridges pair-asset fees to the same treasury address on the home chain, over Relay or Across.
  - Meme-token fees wait, or are swapped under the existing price-protection pattern.
  - Only for home chains with a verified ETH route and with the ERC-6551 registry and Tokenbound V3 deployed.
  - New review and audit.
- Treasury as ERC-8004 `agentWallet`; reputation display; ERC-8217 discovery.
- Owned-NFT picker; Muse art pinning (needs its own cache rule, since `/api/*` is `no-store`); leaderboard; weekly burn report.
- "Bind an existing coin to an NFT": the creator moves its shares to the vault with `updateBeneficiary`. Irreversible; paid tier.

### Phase 3 — after the day-60 check

- Hosted "minds" funded from treasuries, with hard budget caps.

## 8. Acceptance for v1

1. **Fees follow the NFT.** A holder launches an NFT coin:
   - The receipt's fee beneficiaries include `vaultFor(nft)` for the creator shares.
   - After trading, `sweep` moves the fees to the treasury.
   - After the NFT is sold, only the new holder can withdraw.
   - Nobody can redirect the vault's shares.
2. **Pricing and limits:** every NFT gets at most one verified coin, ever, including after a sale. A Muse launch needs no payment. A non-Muse launch needs one unused, verified $10 payment from the launcher, and the same payment cannot fund two coins.
3. **Control:** a non-holder without delegation is rejected at prepare. A delegate is accepted. A control change before registration is handled per §6.2.
4. **Backward compatibility:** normal-mode launches, old plans and recoveries are byte-identical. Saved-preview registration still makes no historical-state reads.
5. **Labels:** collection status is correct. Hidden coins carry `hidden: true` in the catalog, leave Explore and the public `?nft=` API, and stay in Rewards and on treasury pages.
6. **Draft link:** behaves as in §6.5 and never signs automatically.
7. **Cost:** within §6.7.
8. **Quality gate:** contract and app tests, fork tests and Playwright cases pass, and the reviews are closed.

## 9. Success checkpoints

| Day, counted from the public NFT-mode launch | Target | If missed |
|---|---|---|
| 30 | The official team has replied; at least 20 NFT-mode launches that are not the owner's; at least 10 paid launches ($100) | Fix distribution before Phase 2 |
| 60 | At least $500K monthly volume across the platform, or at least 50 paid launches a month | No Phase 3 |
| 90 | Below both | Stop new features and move time to income work |

`scripts/report-nft.ts` measures these offline: launches by tier, payments, volume from GeckoTerminal (no more than 30 requests a minute), vault sweeps and MUSEGOD burn.

## 10. Risks

- **New money contract:** the vault holds fees between sweeps. It must stay minimal, with review, fork tests and staged canaries.
- **Tokenbound V3 trust:** guardian and executor behaviour on Robinhood is unverified (§5.2 gate).
- **Doppler version:** deployed locker and Rehype semantics must match the source read (§5.2 gate).
- **Fake collections and IP:** anyone can deploy a look-alike ERC-721. Defences: D7 labels, D8 names, D9 hiding, legal copy. Trademark claims against coins that use collection names are a real precedent.
- **Seller drain:** holders can empty the treasury before a sale. Show balances and lock status, and recommend Tokenbound `lock` when listing.
- **Ownership cycles:** sending the NFT into its own treasury strands it. The UI warns.
- **Regulatory:** NFTs that carry fee streams may be read as investment products. Get counsel; never market returns.
- **Payments:** no refunds; ETH quotes expire after 60 seconds.
- **Rollback floor:** after NFT coins exist, rolling back below the NFT-compatible release breaks recovery of their backups.

## 11. Review: Robinhood implementation (Task 12, 2026-10-14)

Branch `codex/nft-mode-robinhood`, local only: nothing was pushed, deployed or sent to mainnet. Fork runs used only `.env.fork`.

| Check | Result |
|---|---|
| `npm test` | 1,178 / 1,178 pass |
| `npm run build` (both typechecks and Vite) | pass; the 1,065 kB main-chunk warning predates this work |
| `npm run test:launch-guard` (forge) | 196 / 196 pass |
| `npm run test:launch-browser` (built `dist` served on 127.0.0.1:5191, run alone) | 47 / 47 checks pass; `scripts/test-nft-ui-browser.mjs` also passes (15 checks) |
| `npm run test:nft-vault-fork -- --chain robinhood` | gates 1–6 pass and gate 7 is observed, at block 87,739,425; the committed Task 2b evidence was kept |
| `npm run test:nft-launch-fork -- --chain robinhood` | all 5 steps pass at block 87,753,438; `docs/evidence/nft-launch-fork-robinhood.json`. The USDG donor is the v4 PoolManager (a known holder), so no log scan was needed. `validateLaunch` passes the integrity check and stops only at the signing gate for fork chain id 4663 |
| `npm run test:robinhood-fork` (`.env.fork` only) | pass, repaired 2026-10-14 on `fix/pre-task13` (Task C), at block 88,155,495: WETH / NVDA / USDG / cbBTC / MUSEGOD each create, register, recover after a restart, buy, sell, and pay the creator and the operations treasury exactly their previews, under `creator-70-musegod-swapper-v3` with the fee engine verified by the production `verifyFeeEngine` path; the engine's accrued fees are 2280/6650 (LP) and 2400/7000 (hook) of the creator's paid fees, and the operations treasury's 570/6650 and 600/7000, per currency within 2 raw units; after the snapshot revert, `reconcile` removes all five records (the fork's `finalized` tag trails by 2,000 blocks, the live chain's by 8,235 at this fork, so no launch is final); `docs/evidence/robinhood-fork.json`. The fork keeps chain id 4663 because the engine's activation check reads only chain 4663; `validateLaunch` therefore passes every check before the signing gate and stops there (the gate admits a fork only as chain id 31337), as in the NFT run. Prices are a synthetic opening valuation |

Acceptance (§8), as shown on the Robinhood fork:
1. Fees follow the NFT: met. Both creator shares go to the vault (0.665 LP, 0.70 hook), with the fee engine beside it. A sweep after two trades delivered exactly the previewed fees to the treasury. After a sale the old holder's withdraw reverted (`NotAuthorized()`) and the new holder received the swept balance.
2. Pricing and limits: met. A Muse launched free and a second prepare was refused (`NFT_ALREADY_LAUNCHED`). A paid launch with exactly 10 USDG registered with the fee stored, and the same payment for another NFT was refused (`NFT_FEE_USED`).
3. Control: met. A non-holder was refused (`NFT_NOT_CONTROLLED`); a delegate.xyz delegate (rights `musegod.fun.launch`) was accepted.
4–6: covered by the Task 4, 8, 10 and 11 tests and browser cases.
7. Cost: not measured on mainnet.
8. Quality gate: met for tests; reviews pending (Task 13).

Open items:
- The NFT fork run prices launches from a synthetic opening valuation, because LI.FI is outside its network. NFT-mode rules do not depend on the price.
- The pre-activation residual risk (fork gate 7) stands.
- The §2 sentence on zero-share pushes is left unchanged here. `docs/SPEC.md` states the Robinhood behaviour: initializer only; Rehype refuses.

## Appendix A — proposal to the MUSEGOD team (draft; the owner edits and sends)

> gm — I'm <name>, a MUSEGOD holder building musegod.fun, a community launchpad on Robinhood Chain and Base whose platform fees buy MUSEGOD and send it to the dead address. It is clearly labeled as community-built.
>
> I'm adding an "NFT mode". A coin can be launched for an NFT, and its creator fees go to that NFT's ERC-6551 treasury, so they follow the NFT when it is sold. Muses launch free, and their coins pair with MUSEGOD by default. Control follows the same rule as your Adapter8004 (holder or delegate.xyz delegate). A Muse's agent can prepare a launch from a skill file; the holder always reviews and signs.
>
> Asks:
> 1. May Muse coins use their Muse's name and art?
> 2. Could the Muse agent tab list musegod.fun as an optional next step?
> 3. Would you show a Muse's coins and treasury on its page? Our public API lists them by NFT.
> 4. Would you consider writing each Muse's treasury into its ERC-8048 `account[<chain-id>][0]` record?
> 5. If it proves useful, would a small grant be possible?
