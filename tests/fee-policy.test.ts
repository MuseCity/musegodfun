import test from "node:test";
import assert from "node:assert/strict";
import { airlockAbi, computePoolId, DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, http, encodeFunctionData, keccak256, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { LaunchpadService } from "../server/service";
import type { LaunchPlan } from "../server/store";
import { CONTRACTS, STOCKS, ROBINHOOD_STOCKS, SUPPLY, type TokenRecord } from "../src/lib/config";
import { allocateFeeIncome, ENGINE_FEE_POLICY, FEE_POLICIES, FEE_POLICY, feePolicyFor, type FeeIncomeAllocation } from "../src/lib/fee-policy";
import { LAUNCH_PRICE_TTL } from "../src/lib/opening-valuation";
import { syntheticOpeningValuation } from "./fixtures";
import { buildLaunch } from "../src/lib/protocol";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { serializePrepared } from "../src/lib/launch-plan";

const creator = "0x1111111111111111111111111111111111111111";
const treasury = "0x2222222222222222222222222222222222222222";
const otherTreasury = "0x3333333333333333333333333333333333333333";
const asset = "0x4444444444444444444444444444444444444444";
const hash = `0x${"a".repeat(64)}` as Hex;
const blockHash = `0x${"b".repeat(64)}` as Hex;
const poolKey = {
  currency0: STOCKS[0].address,
  currency1: asset,
  fee: 8388608,
  tickSpacing: 10,
  hooks: CONTRACTS.initializer,
} as const;

function planFixture(): LaunchPlan {
  const plan: LaunchPlan = {
    id: `0x${"c".repeat(64)}`,
    creator,
    data: "0x1234",
    tokenAddress: asset,
    poolId: computePoolId(poolKey),
    draft: {
      name: "Fee Policy Proof",
      symbol: "FEEPROOF",
      description: "",
      image: "",
      quoteAddress: STOCKS[0].address,
      openingCap: "100",
    },
    preparedAt: Date.now(),
    gas: null,
    feePolicy: FEE_POLICY,
    feeTreasury: treasury,
    openingValuation: syntheticOpeningValuation(),
    curvePolicy: CURVE_POLICY,
  };
  freeze(plan);
  return plan;
}
function freeze(plan: LaunchPlan) {
  const sdk = new DopplerSDK<8453 | 4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 8453 });
  const params = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, (({ openingCap, ...draft }) => draft)(plan.draft), creator, treasury, creator, plan.openingValuation!, undefined, plan.openingValuation!.chainId));
  const data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [params] });
  plan.data = data; plan.id = keccak256(data);
  plan.transaction = { to: CONTRACTS.airlock, data, value: "0" };
  plan.prepared = serializePrepared({ chainId: 8453, account: creator, airlock: CONTRACTS.airlock, createParams: params,
    prediction: { tokenAddress: asset, poolOrHookAddress: CONTRACTS.initializer, governanceAddress: creator, timelockAddress: creator, poolKey, poolId: plan.poolId, tokenIsCurrency0: false },
    transaction: { ...plan.transaction, value: 0n }, gasEstimate: { status: "unavailable" } });
}

function validationService(plan: LaunchPlan | null, configuredTreasury: string | null = treasury) {
  return Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config: { mode: "base", chainId: 8453, treasury: configuredTreasury, writesEnabled: true } },
    store: {
      findPlan: async (account: string, data: string) =>
        plan && account === plan.creator && data === plan.data ? plan : null,
    },
  }) as LaunchpadService;
}

test("launch signing validates the exact creator, calldata and current fee policy", async () => {
  const plan = planFixture();
  const service = validationService(plan);
  assert.deepEqual(await service.validateLaunch(creator, plan.data), { valid: true, feePolicy: FEE_POLICY, curvePolicy: CURVE_POLICY });
  await assert.rejects(() => service.validateLaunch(treasury, plan.data), /curve policy has changed/);
  await assert.rejects(() => service.validateLaunch(creator, "0x5678"), /curve policy has changed/);
  plan.feePolicy = "musegod-80-v1";
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /fee policy has changed/);
  delete plan.feePolicy;
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /fee policy has changed/);
  await assert.rejects(() => validationService(null).validateLaunch(creator, plan.data), /curve policy has changed/);
});

test("launch signing rejects changed or absent treasury and expired previews", async () => {
  const plan = planFixture();
  await assert.rejects(() => validationService(plan, otherTreasury).validateLaunch(creator, plan.data), /treasury changed/);
  await assert.rejects(() => validationService(plan, null).validateLaunch(creator, plan.data), /treasury changed/);
  delete plan.feeTreasury;
  await assert.rejects(() => validationService(plan).validateLaunch(creator, plan.data), /treasury changed/);
  plan.feeTreasury = treasury;
  plan.preparedAt = Date.now() - 300_001;
  await assert.rejects(() => validationService(plan).validateLaunch(creator, plan.data), /preview expired/);
});

test("previous issuance previews cannot sign a removed pair or a different deployment", async () => {
  const plan = planFixture();
  const service = validationService(plan);
  service.runtime.config.mode = "robinhood";
  service.runtime.config.chainId = 4663;
  for (const quoteAddress of [
    "0xce24439f2d9c6a2289f741120fe202248b666666",
    "0x6b1d42927b1a84ec28fa88d4fc6fa7af404966be",
    STOCKS[0].address,
  ] as const) {
    plan.draft.quoteAddress = quoteAddress;
    await assert.rejects(() => service.validateLaunch(creator, plan.data), /no longer supported/);
  }
  plan.draft.quoteAddress = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!.address;
  plan.openingValuation = syntheticOpeningValuation(plan.draft.quoteAddress, "0.000005", { chainId: 4663 });
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /parameters changed/);
});

test("launch signing rejects old unsigned previews, changed quote evidence and price expiry", async () => {
  const plan = planFixture();
  const service = validationService(plan);
  delete plan.openingValuation;
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /market cap policy has changed/);
  plan.openingValuation = syntheticOpeningValuation(STOCKS[1].address);
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /does not match/);
  plan.openingValuation = syntheticOpeningValuation(STOCKS[0].address, "100", { chainId: 4663 });
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /does not match/);
  const quotedAt = Date.now() - LAUNCH_PRICE_TTL;
  plan.openingValuation = syntheticOpeningValuation(STOCKS[0].address, "100", {
    quotedAt, expiresAt: quotedAt + LAUNCH_PRICE_TTL, sourceUpdatedAt: quotedAt,
  });
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /price expired/);
});

for (const [legacyPolicy, usdSnapshot] of [
  [undefined, false], ["musegod-80-v1", false], [FEE_POLICY, false], [FEE_POLICY, true],
] as const)
test(`already broadcast ${legacyPolicy ?? "unmarked"}${usdSnapshot ? " fixed USD" : ""} launches retain their original valuation`, async () => {
  const plan = planFixture();
  delete plan.curvePolicy; delete plan.prepared; delete plan.transaction;
  plan.feePolicy = legacyPolicy;
  delete plan.openingValuation;
  if (!legacyPolicy) delete plan.feeTreasury;
  plan.preparedAt = Date.now() - 86_400_000;
  if (usdSnapshot) {
    plan.openingValuation = syntheticOpeningValuation(STOCKS[0].address, "100", {
      quotedAt: plan.preparedAt, expiresAt: plan.preparedAt + LAUNCH_PRICE_TTL,
      sourceUpdatedAt: plan.preparedAt,
    });
    plan.draft.openingCap = "50";
  }
  const saved: TokenRecord[] = [];
  const tracked: unknown[][] = [];
  const statuses: unknown[][] = [];
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config: { mode: "base", chainId: 8453, treasury: otherTreasury, writesEnabled: false } },
    assertNetwork: async () => {},
    client: {
      getTransaction: async () => ({ to: CONTRACTS.airlock, from: creator, input: plan.data, value: 0n }),
      getTransactionReceipt: async () => ({
        status: "success", from: creator, to: CONTRACTS.airlock,
        blockNumber: 10n, blockHash,
        logs: [{
          address: CONTRACTS.airlock,
          topics: encodeEventTopics({ abi: airlockAbi, eventName: "Create", args: { numeraire: plan.draft.quoteAddress } }),
          data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [asset, CONTRACTS.initializer, CONTRACTS.initializer]),
        }],
      }),
      getBlockNumber: async () => 11n,
      getBlock: async () => ({ hash: blockHash, timestamp: 1_800_000_000n }),
      readContract: async (input: { functionName: string; blockNumber?: bigint; args?: readonly unknown[] }) => {
        if (input.functionName !== "getFeeSchedule") return SUPPLY;
        assert.equal(input.blockNumber, 10n, "Recovery verifies the schedule at the receipt block");
        assert.deepEqual(input.args, [plan.poolId]);
        return [1_800_000_000, 10_000, 10_000, 10_000, 0];
      },
    },
    sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: plan.draft.quoteAddress, poolKey }) }) },
    store: {
      findPlan: async (account: string, data: string) => account === creator && data === plan.data ? plan : null,
      trackLaunch: async (...args: unknown[]) => tracked.push(args),
      pendingLaunches: async () => [{ hash, planId: plan.id, status: "pending", blockHash: null }],
      tokens: async () => saved,
      saveToken: async (token: TokenRecord) => saved.push(token),
      launchStatus: async (...args: unknown[]) => statuses.push(args),
    },
  }) as LaunchpadService;
  await assert.rejects(() => service.validateLaunch(creator, plan.data), /curve policy has changed|fee policy has changed|preview expired/);
  await service.trackLaunch(hash, plan.id);
  await service.reconcile();
  assert.equal(tracked.length, 2);
  assert.equal(saved.length, 1, "A canonical legacy receipt must still register during recovery");
  assert.equal(saved[0].address, asset);
  assert.equal(saved[0].tradingFeeBps, 100, "Legacy recovery records the verified original 1% trading fee");
  assert.equal(saved[0].feePolicy, legacyPolicy, "Recovery must preserve the original immutable fee policy");
  assert.equal(saved[0].feeTreasury, legacyPolicy ? treasury : undefined);
  assert.equal(saved[0].openingCap, usdSnapshot ? "50" : "100", "Recovery preserves original paired-unit valuation");
  assert.deepEqual(saved[0].openingValuation, plan.openingValuation, "Recovery preserves original USD evidence only when it exists");
  assert.deepEqual(statuses, [[hash, "confirmed", blockHash]]);
});


test("policy versions preserve their distinct gross, net and platform-income bases", () => {
  assert.deepEqual(FEE_POLICIES["musegod-80-v1"], { id: "musegod-80-v1", protocol: 500, creator: 1900, platform: 7600, buyback: 7600, operations: 0, creatorNet: 2000, platformNet: 8000, platformBuyback: 10000, platformOperations: 0 });
  assert.deepEqual(FEE_POLICIES[FEE_POLICY], { id: FEE_POLICY, protocol: 500, creator: 6650, platform: 2850, buyback: 2280, operations: 570, creatorNet: 7000, platformNet: 3000, platformBuyback: 8000, platformOperations: 2000 });
  for (const policy of Object.values(FEE_POLICIES)) {
    assert.equal(policy.protocol + policy.creator + policy.platform, 10000);
    assert.equal(policy.buyback + policy.operations, policy.platform);
    assert.equal(policy.creatorNet + policy.platformNet, 10000);
    assert.equal(policy.platformBuyback + policy.platformOperations, 10000);
    assert.equal(feePolicyFor(policy.id), policy);
  }
  for (const value of [undefined, null, "", "future-v3", "toString", "__proto__"]) {
    assert.equal(feePolicyFor(value), null);
    assert.equal(allocateFeeIncome({ feePolicy: value, amount: 10n, account: treasury, creator, treasury }), null);
  }
});

test("fee allocation floors each layer without allocating more than actual income", () => {
  for (const feePolicy of Object.keys(FEE_POLICIES) as (keyof typeof FEE_POLICIES)[]) {
    if (feePolicy === ENGINE_FEE_POLICY) continue; // v3 is split on-chain, covered separately.
    const policy = FEE_POLICIES[feePolicy];
    for (const amount of [0n, 1n, 2n, 9n, 10n, 11n, 99n, 100n, 101n, 123456789n, 900719925474099300000000000000001n]) {
      const creatorOnly: FeeIncomeAllocation = allocateFeeIncome({ feePolicy, amount, account: creator, creator, treasury })!;
      assert.deepEqual(creatorOnly, { creator: amount, platform: 0n, buyback: 0n, operations: 0n, remainder: 0n });
      const platformOnly: FeeIncomeAllocation = allocateFeeIncome({ feePolicy, amount, account: treasury, creator, treasury })!;
      assert.equal(platformOnly.platform, amount);
      assert.equal(platformOnly.creator, 0n);
      assert.equal(platformOnly.buyback, amount * BigInt(policy.platformBuyback) / 10000n);
      assert.equal(platformOnly.operations, amount * BigInt(policy.platformOperations) / 10000n);
      const shared: FeeIncomeAllocation = allocateFeeIncome({ feePolicy, amount, account: creator, creator, treasury: creator })!;
      assert.equal(shared.creator, amount * BigInt(policy.creatorNet) / 10000n);
      assert.equal(shared.platform, amount * BigInt(policy.platformNet) / 10000n);
      assert.equal(shared.buyback, shared.platform * BigInt(policy.platformBuyback) / 10000n);
      assert.equal(shared.operations, shared.platform * BigInt(policy.platformOperations) / 10000n);
      for (const allocation of [creatorOnly, platformOnly, shared]) {
        assert.equal(allocation.creator + allocation.buyback + allocation.operations + allocation.remainder, amount);
        assert(allocation.remainder >= 0n && allocation.remainder <= 2n);
      }
    }
  }
  assert.deepEqual(allocateFeeIncome({ feePolicy: FEE_POLICY, amount: 11n, account: creator, creator, treasury: creator }), { creator: 7n, platform: 3n, buyback: 2n, operations: 0n, remainder: 2n });
  assert.equal(allocateFeeIncome({ feePolicy: FEE_POLICY, amount: 10n, account: otherTreasury, creator, treasury }), null);
  assert.equal(allocateFeeIncome({ feePolicy: FEE_POLICY, amount: 10n, account: treasury, creator, treasury: undefined }), null);
  assert.throws(() => allocateFeeIncome({ feePolicy: FEE_POLICY, amount: -1n, account: treasury, creator, treasury }), /cannot be negative/);
});


test("per-claim reference preserves rounding dust when hook and LP receipts are summed", () => {
  const allocate = (amount: bigint) => allocateFeeIncome({ feePolicy: FEE_POLICY, amount, account: treasury, creator, treasury })!;
  const hook = allocate(2849n), lp = allocate(142n), combined = allocate(2991n);
  assert.deepEqual(hook, { creator: 0n, platform: 2849n, buyback: 2279n, operations: 569n, remainder: 1n });
  assert.deepEqual(lp, { creator: 0n, platform: 142n, buyback: 113n, operations: 28n, remainder: 1n });
  const totals = { buyback: hook.buyback + lp.buyback, operations: hook.operations + lp.operations, remainder: hook.remainder + lp.remainder };
  assert.deepEqual(totals, { buyback: 2392n, operations: 597n, remainder: 2n });
  assert.equal(totals.buyback + totals.operations + totals.remainder, hook.platform + lp.platform);
  assert.equal(combined.operations, 598n, "Combining claims before flooring is a distinct accounting basis");
  assert.equal(combined.remainder, 1n);
});
