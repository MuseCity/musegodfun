# NFT Mode — Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on NFT mode for Base (8453). A Base ERC-721 launches exactly one coin, pays $10 in USDC or quoted ETH, and its creator fees go to the NFT's vault and then to its ERC-6551 treasury on Base.

**Architecture:** This plan reuses everything from `tasks/nft-mode-robinhood-plan.md`: the contracts are chain-keyed, and so are the library, the server rules and the UI. It adds:
- the Base factory deployment and manifest entry
- USDC in the fee table
- removal of the Robinhood-only lock
- Base-specific fork evidence and release checks

The Base platform share keeps flowing to the deployed Base Collector (`BASE_AUTOMATION_FEE_POLICY`). Only the creator shares change, from the launcher to the NFT vault.

**Tech Stack:** Same as the Robinhood plan.

**Spec:** `tasks/nft-mode.md`. Prerequisite: `tasks/nft-mode-robinhood-plan.md` Tasks 1–12 are merged. Task 13 may still be pending.

## Global Constraints

- All Global Constraints of `tasks/nft-mode-robinhood-plan.md` apply. Work on `codex/nft-mode-base`, branched from `master` after the Robinhood work is merged.
- **Base addresses (pinned):**
  - USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals; fee `10_000_000` raw units)
  - initializer `0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544`
  - Rehype `0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215`
  - Base Collector: read `BASE_FEE_COLLECTOR_ADDRESS` from `wrangler.jsonc`
  - ERC-6551, Tokenbound V3 and delegate.xyz use the same addresses as on Robinhood
- **No free collection on Base.** Muses live on Robinhood, so a Muse cannot launch on Base in v1 (`NFT_CHAIN_UNSUPPORTED`). Cross-chain NFTs are Phase 2 of the spec.
- **No new fee split.** Base creator shares go to the vault. Platform shares (operations 5.7% and the Collector 22.8% LP / 24% hook) stay exactly as `BASE_AUTOMATION_FEE_POLICY` defines them.

## Review Focus

1. **A Muse submitted on Base** (draft `nft.chainId` 4663 while deployed on 8453). Expected: `NFT_CHAIN_UNSUPPORTED` before RPC, with a message pointing to Robinhood. Tested in Task 2.
2. **A Base NFT launch under the Collector fee policy.** `assertEngineFeeCalldata` and `assertNftFeeCalldata` must both pass on the same calldata, and the Collector shares are unchanged. Tested in Task 2.
3. **USDC paid on Robinhood, or USDG on Base.** Expected: `NFT_FEE_INVALID`, because the stablecoin is per chain. Tested in Task 2.
4. **Base rollback** to a pre-NFT build after Base NFT coins exist. The release marker must block it once the Base NFT flag is on. Tested in Task 3.
5. **Explore on Base** must not show Robinhood NFT coins, and vice versa; the deployment boundary holds. Tested in Task 2.

---

## File Structure

| File | Change |
|---|---|
| `src/lib/launch-fee.ts` | Add the `8453` USDC entry |
| `server/config.ts` | Remove the `deploymentChainId === 4663` lock; add a per-chain flag `NFT_MODE_BASE_ENABLED` |
| `wrangler.jsonc`, `.env.example`, `scripts/release-policy.ts` | New var `NFT_MODE_BASE_ENABLED` (default `"false"`) |
| `scripts/test-nft-vault-fork.ts`, `scripts/test-nft-launch-fork.ts` | Run with `--chain base` |
| `contracts/artifacts/nft-vault-deployment.json` | `8453` entry after deployment |
| `scripts/release.ts`, `tests/release-policy.test.ts` | Base runtime/smoke checks and rollback marker |
| `src/App.tsx`, `src/components/NftLaunchStep.tsx` | Base copy (USDC, no Muse preset on Base) |
| `docs/SPEC.md`, `README.md`, `public/skill.md` | Base notes |
| `tests/nft-base.test.ts` | Base unit tests |

---

### Task 1: Base fork gates

**Files:**
- Modify: `scripts/test-nft-vault-fork.ts` (add the `--chain base` branch)
- Create: `docs/evidence/nft-vault-fork-base.json` (generated)

- [ ] **Step 1: Add the Base branch to the fork gate script**

With `--chain base`, use the Base Alchemy URL and assert `client.getChainId() === 8453`, as `scripts/test-base-collector-fork.ts` does. Then repeat the Robinhood gate steps (Task 2 Step 3 of the Robinhood plan) on Base:

1. **Treasury formula.** TS `treasuryFor` equals `ERC6551Registry.account(proxy, 0x0, 8453, nft, id)` for a real Base ERC-721. Pick a collection with on-chain `ownerOf`, found through Alchemy NFT `getContractsForOwner` on any known holder. Record its address in the evidence.
2. **Factory.** Deploy it locally from `factoryBytecode`. `vaultFor` from TS equals `factory.vaultFor` on chain.
3. **Counterfactual beneficiary under the Base Collector policy.**
   - Launch a WETH-paired coin with `draft.nft` and the Base Collector as the fee engine, using the same local launch helper as `scripts/test-base-collector-fork.ts`.
   - Trade both directions, deploy the vault, sweep.
   - The treasury balance increases.
   - The Collector's `claimFees(poolId)` still credits its own share. Assert that `pendingFees` increased.
4. **Zero-share push.** It is already fork-proven on Base (`scripts/test-base-collector-fork.ts:149-157`). Assert that the vault forwards pushed balances on the next sweep.
5. **Tokenbound control** on Base: create and initialize the treasury. The holder's `execute` succeeds; after an NFT transfer, the old holder's reverts and the new holder's succeeds.

Write `docs/evidence/nft-vault-fork-base.json`.

- [ ] **Step 2: Run it**

Run: `npm run test:nft-vault-fork -- --chain base`
Expected: PASS. Local fork only; no mainnet transaction.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-nft-vault-fork.ts docs/evidence/nft-vault-fork-base.json
git commit -m "test: Base fork gates for NFT vaults under the Collector fee policy"
```

---

### Task 2: Enable NFT mode on Base in code (flag off)

**Files:**
- Modify: `src/lib/launch-fee.ts`, `server/config.ts`, `wrangler.jsonc`, `.env.example`, `scripts/release-policy.ts`
- Modify: `src/components/NftLaunchStep.tsx`, `src/App.tsx` (Base copy)
- Test: `tests/nft-base.test.ts`

**Interfaces:**
- Consumes: everything from the Robinhood plan.
- Produces:
  - `LAUNCH_FEE_STABLE[8453] = { address: USDC, symbol: "USDC", decimals: 6, amount: 10_000_000n }`
  - `RuntimeConfig.nftMode.enabled` on Base = `environment.NFT_MODE_BASE_ENABLED === "true"`
  - Robinhood keeps `NFT_MODE_ENABLED`

- [ ] **Step 1: Write the failing tests**

Create `tests/nft-base.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, type Address, type Hex } from "viem";
import { STOCKS, WAD } from "../src/lib/config";
import { LAUNCH_FEE_STABLE } from "../src/lib/launch-fee";
import { assertNftDraftRules, NftLaunchError, verifyLaunchFeePayment } from "../server/nft-launch";
import { MUSES, vaultFor, type NftVaultManifest } from "../src/lib/nft-mode";
import { assertEngineFeeCalldata, assertNftFeeCalldata, buildLaunch, launchFeeData } from "../src/lib/protocol";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { syntheticOpeningValuation } from "./fixtures";
import { DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, http } from "viem";

const weth = STOCKS.find((a) => a.symbol === "WETH")!;
const baseNft = { chainId: 8453 as const, contract: "0x1111111111111111111111111111111111111111" as Address, tokenId: "5" };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof NftLaunchError ? e.code : String(e); } return "ok"; };

test("Base charges USDC and a Muse cannot launch on Base", () => {
  assert.equal(LAUNCH_FEE_STABLE[8453]?.symbol, "USDC");
  assert.equal(LAUNCH_FEE_STABLE[8453]?.amount, 10_000_000n);
  const draft = { name: "Ape", symbol: "APE", description: "", image: "", quoteAddress: weth.address, tradingFeeBps: 100 };
  assert.equal(code(() => assertNftDraftRules({ ...draft, nft: baseNft }, 8453, true)), "ok");
  assert.equal(code(() => assertNftDraftRules({ ...draft, nft: { chainId: 4663, contract: MUSES.contract, tokenId: "1" } }, 8453, true)), "NFT_CHAIN_UNSUPPORTED");
});

test("the Base Collector shares and the NFT vault shares coexist in one calldata", () => {
  const factory = "0x9999999999999999999999999999999999999999" as Address, collector = "0x3B6d01e627Fe6e06C831E0f9f57aC976a88309Ff" as Address;
  const manifest: NftVaultManifest = { version: 1, vaultInitCodeHash: keccak256("0x01"), chains: {
    "4663": { status: "not_deployed", factory: null, factoryRuntimeHash: null, transactionHash: null, blockNumber: null },
    "8453": { status: "deployed_verified", factory, factoryRuntimeHash: keccak256("0x02"), transactionHash: null, blockNumber: 1 } } };
  const creator = "0xAAAA000000000000000000000000000000000001" as Address, treasury = "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" as Address;
  const sdk = new DopplerSDK({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:9") }) as never, chainId: 8453 });
  const draft = { name: "Ape", symbol: "APE", description: "", image: "", quoteAddress: weth.address, tradingFeeBps: 100, nft: baseNft };
  const params = buildLaunch(sdk, draft, creator, treasury, "0x5555555555555555555555555555555555555555", syntheticOpeningValuation(weth.address, 8453),
    undefined, 8453, collector, false, undefined, manifest);
  assert.doesNotThrow(() => assertEngineFeeCalldata({ feePolicy: BASE_AUTOMATION_FEE_POLICY, feeEngine: collector, creator, feeTreasury: treasury }, params.poolInitializerData));
  assert.doesNotThrow(() => assertNftFeeCalldata({ draft, creator }, params.poolInitializerData, 8453, manifest));
  const { pool } = launchFeeData(params.poolInitializerData);
  assert.equal(pool.beneficiaries.find((b) => b.beneficiary === collector)?.shares, WAD * 2280n / 10_000n);
  assert.ok(pool.beneficiaries.some((b) => b.beneficiary === vaultFor(baseNft, factory, manifest.vaultInitCodeHash)));
});

test("stablecoins are per chain: USDG on Base is not a valid fee", async () => {
  const payer = "0xAAAA000000000000000000000000000000000001" as Address, ops = "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" as Address;
  const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
  const log = { address: usdg, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: payer, to: ops } }),
    data: encodeAbiParameters([{ type: "uint256" }], [10_000_000n]) };
  const client = { getTransactionReceipt: async () => ({ status: "success", blockNumber: 1n, blockHash: `0x${"22".repeat(32)}`, from: payer, logs: [log] }),
    getBlockNumber: async () => 100n, getTransaction: async () => ({}), getBlock: async () => ({}) } as never;
  await assert.rejects(verifyLaunchFeePayment(client, { fee: { asset: "stable", txHash: `0x${"11".repeat(32)}` as Hex }, payer, recipient: ops, chainId: 8453, keys: [] }),
    (e: unknown) => e instanceof NftLaunchError && e.code === "NFT_FEE_INVALID");
});
```

Add a test for Review Focus 5 (deployment boundary). Search `tests/musegod-explore.test.ts` for the "Base isolation" case; it checks that Base and Robinhood records never mix in Explore. Extend it with one Robinhood NFT coin and one Base NFT coin, and assert each deployment's Explore shows only its own.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/nft-base.test.ts`
Expected: FAIL. There is no `8453` stable entry, and the first test's USDC assertion fails.

- [ ] **Step 3: Implement**

`src/lib/launch-fee.ts`, add to `LAUNCH_FEE_STABLE`:

```ts
  8453: { address: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), symbol: "USDC", decimals: 6, amount: 10_000_000n },
```

`server/config.ts`: replace the Robinhood lock

```ts
enabled: environment.NFT_MODE_ENABLED === "true" && deploymentChainId === 4663,
```

with

```ts
enabled: deploymentChainId === 4663 ? environment.NFT_MODE_ENABLED === "true" : environment.NFT_MODE_BASE_ENABLED === "true",
```

and set `freeCollections` and `verifiedCollections` to `[]` on 8453.

- `wrangler.jsonc`: add `"NFT_MODE_BASE_ENABLED": "false"`.
- `.env.example`: add the same key.
- `scripts/release-policy.ts`: pin it, and include it in `assertSecurityTransition` like `NFT_MODE_ENABLED`.

`src/components/NftLaunchStep.tsx`:
- show the "Use Muses" preset only when `config.deploymentChainId === 4663`;
- on Base, when the user pastes the Muses contract, show "Muse coins launch on Robinhood Chain." with a link to `/create?chainId=4663`;
- the fee line reads "costs $10 (USDC or ETH)" on Base, using `LAUNCH_FEE_STABLE[chain].symbol`.

`src/App.tsx` payment card: the stable button label uses the same symbol ("Pay 10 USDC" on Base).

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test tests/nft-base.test.ts && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/launch-fee.ts server/config.ts wrangler.jsonc .env.example scripts/release-policy.ts src/components/NftLaunchStep.tsx src/App.tsx tests/nft-base.test.ts tests/musegod-explore.test.ts
git commit -m "feat: enable NFT mode on Base behind its own flag with USDC launch fees"
```

---

### Task 3: Base end-to-end fork test, release checks and docs

**Files:**
- Modify: `scripts/test-nft-launch-fork.ts` (the `--chain base` branch), `scripts/release.ts`, `tests/release-policy.test.ts`, `scripts/report-nft.ts`, `docs/SPEC.md`, `README.md`, `public/skill.md`, `scripts/test-launch-browser.mjs`

- [ ] **Step 1: Base branch of the launch fork test**

With `--chain base`:
1. Deploy the factory locally (temp manifest, as in the Robinhood test).
2. Deploy a minimal ERC-721 and mint #1. Fund the account with USDC from a real Base holder (impersonate), and pay exactly 10 USDC to `config.treasury`.
3. Prepare, sign and register a WETH-paired NFT coin under the Base Collector fee policy. Assert `verified`, the `launchFee` is stored, and both `assertEngineFeeCalldata` and `assertNftFeeCalldata` pass on the signed calldata.
4. Trade, deploy the vault, sweep, activate the treasury, transfer the NFT, withdraw as the new holder.
5. The Collector's `claimFees(poolId)` still credits its own share.
6. Reusing the USDC payment → `NFT_FEE_USED`. A Muse draft on Base → `NFT_CHAIN_UNSUPPORTED`.

Write `docs/evidence/nft-launch-fork-base.json`.

Run: `npm run test:nft-launch-fork -- --chain base`. Expected: PASS (local fork only).

- [ ] **Step 2: Release checks for Base**

`scripts/release.ts`:
- `checkRuntime` also reads `/api/chains/8453/config` → `nftMode.enabled` and `nftMode.vaultFactory`.
- `checkFunctionalSmoke` calls `GET /api/chains/8453/tokens?nft=any` and expects HTTP 200 with a JSON array.
- The `supportsNftMode` marker from the Robinhood plan also applies when the candidate's Base `nftMode.enabled` is true. Rollback below the NFT-compatible release is then refused for Base too.

`tests/release-policy.test.ts`:
- a candidate with Base NFT enabled refuses a pre-NFT rollback target;
- a flag-off candidate does not.

- [ ] **Step 3: Browser cases**

In `scripts/test-launch-browser.mjs`, add `nft_base_paid_usdc` and `nft_base_muse_redirect`, using mocked APIs on `/create?chainId=8453`:
- the paid case shows "Pay 10 USDC" before Review;
- pasting the Muses contract shows the Robinhood redirect message and disables Continue.

Run: `npm run test:launch-browser`. Expected: PASS.

- [ ] **Step 4: Docs and report**

- `docs/SPEC.md` NFT mode section: add "Base" rules:
  - USDC or ETH fee
  - no free collections
  - Muses only on Robinhood
  - creator shares to the vault while Collector shares are unchanged
  - flag `NFT_MODE_BASE_ENABLED`
  - evidence files
- `README.md`: one line.
- `public/skill.md`: add the Base link form `https://musegod.fun/create?chainId=8453#draft=…`, and state that Base NFTs pay $10. Keep the drift test passing; it reads only `chainId=4663` examples, so add a `chainId=8453` example only if `tests/skill-doc.test.ts`'s regex is extended to match both.
- `scripts/report-nft.ts`: accept `--chain base` (GeckoTerminal network `base`).

- [ ] **Step 5: Full verification**

Run, in order:
1. `npm test`
2. `npm run build`
3. `npm run test:launch-guard`
4. `npm run test:launch-browser`
5. `npm run test:nft-vault-fork -- --chain base`
6. `npm run test:nft-launch-fork -- --chain base`

Also rerun the Robinhood fork tests to confirm no regression.
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-nft-launch-fork.ts scripts/release.ts tests/release-policy.test.ts scripts/report-nft.ts docs/SPEC.md README.md public/skill.md tests/skill-doc.test.ts scripts/test-launch-browser.mjs docs/evidence/nft-launch-fork-base.json
git commit -m "test: Base NFT launch fork test, release checks and docs"
```

---

### Task 4: Owner-authorized Base rollout (do not run without explicit approval)

Each step needs the owner's explicit go-ahead in chat.

- [ ] **Step 1: Review gate.** Run the review roles over `codex/nft-mode-base` until accepted.
- [ ] **Step 2: Deploy the factory on Base.**
  - The owner runs `scripts/deploy-nft-vault.ts --chain base --deploy` (written in the Robinhood plan's Task 13), then `--verify`.
  - Record the manifest `8453` entry as `deployed_verified`.
  - Verify on Sourcify.
  - The Base factory address may differ from Robinhood's; vault addresses are per chain by design.
- [ ] **Step 3: Merge and publish with `NFT_MODE_BASE_ENABLED=false`.** CI publishes and verifies both domains. Record the release as the Base NFT-compatible rollback floor.
- [ ] **Step 4: Canary.**
  - The owner sets `NFT_MODE_BASE_ENABLED=true` (a release).
  - With a real Base NFT: pay 10 USDC, launch, see the `verified` badge, make a small trade, sweep, activate the treasury, withdraw.
  - Confirm the Base Collector still receives its share. Check `pendingFees` after a public `claimFees`.
- [ ] **Step 5: Announce** (owner's call).
- [ ] **Stopping:** flag off is a release. For an instant stop, use `npx tsx scripts/runtime-control.ts pause 8453 <revision> "<reason>"`, which stops all Base launches.
