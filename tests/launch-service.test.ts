import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DopplerSDK, airlockAbi, bundlerAbi, computePoolId, verifyPreparedCreateExecution } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, http, encodeFunctionData, encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, type Hex, type Address, type TransactionReceipt } from "viem";
import { ROBINHOOD_BUNDLER, ROBINHOOD_CONTRACTS as contracts, ROBINHOOD_STOCKS, SUPPLY } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { restorePrepared, serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { buildLaunch } from "../src/lib/protocol";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { minimumOutput } from "../src/lib/validation";
import { syntheticOpeningValuation } from "./fixtures";
import { assertPlanIntegrity, verifyGuardedReceipt } from "../server/launch-verification";
import { expectedGuardRuntime, verifyLaunchGuard } from "../server/launch-guard";
import { LaunchpadService } from "../server/service";
import { Store } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";

const creator = "0x1111111111111111111111111111111111111111" as Address;
const treasury = "0x2222222222222222222222222222222222222222" as Address;
const guard = "0x3333333333333333333333333333333333333333" as Address;
const token = "0x4444444444444444444444444444444444444444" as Address;
const hash = `0x${"aa".repeat(32)}` as Hex, blockHash = `0x${"bb".repeat(32)}` as Hex;
const quote = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
function fixture() {
  const sdk = new DopplerSDK<4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 4663 });
  const openingValuation = syntheticOpeningValuation(quote.address, "3000", { chainId: 4663 });
  const draft = { name: "Guard Test", symbol: "GUARD", description: "", image: "", quoteAddress: quote.address };
  const createParams = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, treasury, openingValuation, undefined, 4663));
  const poolKey = { currency0: token, currency1: quote.address, fee: 8388608, tickSpacing: 10, hooks: contracts.initializer };
  const amountIn = 100n, expected = 1000n, min = minimumOutput(expected, 100), deadline = Math.floor(openingValuation.expiresAt / 1000);
  const transaction = { to: guard, data: encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuy", args: [createParams, amountIn, min, BigInt(deadline)] }), value: 0n };
  const approval = { to: quote.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [guard, amountIn] }), value: 0n };
  const prepared = { chainId: 4663 as const, account: creator, airlock: contracts.airlock, createParams,
    prediction: { tokenAddress: token, poolOrHookAddress: token, governanceAddress: treasury, timelockAddress: treasury, poolKey, poolId: computePoolId(poolKey), tokenIsCurrency0: true },
    transaction, approvalTransaction: approval, devBuy: { bundler: ROBINHOOD_BUNDLER, recipient: creator, exactAmountIn: amountIn, simulatedAmountOut: expected, vesting: { permissionlessClaim: false, vestingDuration: 0n, cliffDuration: 0n } }, gasEstimate: { status: "unavailable" as const } };
  const plan: LaunchPlan = { id: keccak256(transaction.data), creator, data: transaction.data, tokenAddress: token, poolId: prepared.prediction.poolId, draft,
    preparedAt: Date.now(), gas: null, feePolicy: FEE_POLICY, feeTreasury: treasury, openingValuation, curvePolicy: CURVE_POLICY,
    prepared: serializePrepared(prepared), transaction: { ...transaction, value: "0" },
    firstBuy: { amount: "0.0000000000000001", amountIn: "100", expectedAmountOut: "1000", minAmountOut: "990", slippageBps: 100, deadline, recipient: creator, quoteAddress: quote.address, guard, bundler: ROBINHOOD_BUNDLER },
    approval: { token: quote.address, spender: guard, amount: "100", required: true, transaction: { ...approval, value: "0" } } };
  const guardLog = { address: guard, topics: encodeEventTopics({ abi: launchGuardAbi, eventName: "GuardedLaunch", args: { creator, asset: token, numeraire: quote.address } }),
    data: encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }, { type: "bytes32" }], [amountIn, expected, min, BigInt(deadline), plan.poolId]) };
  const poolTuple = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] } as const;
  const receipt = { status: "success", from: creator, to: guard, transactionHash: hash, blockHash, blockNumber: 10n, logs: [
    { address: contracts.airlock, topics: encodeEventTopics({ abi: airlockAbi, eventName: "Create", args: { numeraire: quote.address } }), data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [token, contracts.initializer, token]) },
    { address: ROBINHOOD_BUNDLER, topics: encodeEventTopics({ abi: bundlerAbi, eventName: "Bundled", args: { recipient: creator } }), data: encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }, poolTuple], [amountIn, expected, poolKey]) }, guardLog,
  ] } as unknown as TransactionReceipt;
  const tx = { hash, from: creator, to: guard, input: plan.data, value: 0n };
  return { plan, prepared, receipt, tx, guardLog, poolKey };
}

test("missing and stale curve handshakes reject before any RPC", async () => {
  let rpc = 0;
  const service = Object.assign(Object.create(LaunchpadService.prototype), { assertNetwork: async () => { rpc++; } }) as LaunchpadService;
  for (const policy of [undefined, null, "old-v1", CURVE_POLICY + "-old"]) await assert.rejects(() => service.prepare({}, creator, policy), /curve policy has changed/);
  assert.equal(rpc, 0);
});

test("frozen SDK snapshots serialize losslessly and bind outer calldata and exact approval", () => {
  const { plan, prepared } = fixture();
  assert.deepEqual(restorePrepared(plan.prepared!), prepared);
  assertPlanIntegrity(plan, contracts);
  for (const mutate of [
    (p: LaunchPlan) => { p.transaction!.to = treasury; },
    (p: LaunchPlan) => { p.prepared!.createParams.salt = hash; },
    (p: LaunchPlan) => { p.firstBuy!.minAmountOut = "989"; },
    (p: LaunchPlan) => { p.firstBuy!.deadline++; },
    (p: LaunchPlan) => { p.firstBuy!.recipient = treasury; },
    (p: LaunchPlan) => { p.prepared!.devBuy!.bundler = guard; },
    (p: LaunchPlan) => { p.approval!.amount = "101"; },
    (p: LaunchPlan) => { p.approval!.transaction.data = "0x1234"; },
  ]) {
    const copy = structuredClone(plan); mutate(copy); assert.throws(() => assertPlanIntegrity(copy, contracts), /changed/);
  }
});

test("guarded execution requires matching SDK outer/Create/Bundled and one protected event", async () => {
  const { plan, prepared, receipt, tx, guardLog } = fixture();
  const verified = await verifyPreparedCreateExecution({ prepared, receipt, publicClient: { getTransaction: async () => tx } });
  assert.equal(verified.devBuy?.amountOut, 1000n);
  assert.equal(verifyGuardedReceipt(plan, receipt, verified.devBuy?.amountOut).amountOut, 1000n);
  await assert.rejects(() => verifyPreparedCreateExecution({ prepared, receipt, publicClient: { getTransaction: async () => ({ ...tx, value: 1n }) } }));
  for (const logs of [receipt.logs.slice(0, 2), [...receipt.logs, guardLog] as TransactionReceipt["logs"], receipt.logs.map((l) => l.address === guard ? { ...l, address: treasury } : l)])
    assert.throws(() => verifyGuardedReceipt(plan, { ...receipt, logs }, 1000n), /event does not match/);
  assert.throws(() => verifyGuardedReceipt(plan, receipt, 999n), /event does not match/);
  for (const field of ["minAmountOut", "deadline", "amountIn"] as const) {
    const changed = structuredClone(plan); if (field === "deadline") changed.firstBuy!.deadline++; else changed.firstBuy![field] = "1";
    assert.throws(() => verifyGuardedReceipt(changed, receipt, 1000n), /event does not match/);
  }
});

test("guard receipt recovery survives restart, expiry and disabled signing; reorg/unknown stay recoverable", async () => {
  const { plan, receipt, tx, poolKey } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "launch-recovery-test-"));
  let store = new Store(directory, 31337);
  try {
    store.savePlan(plan); store.trackLaunch(hash, plan.id); store.close(); store = new Store(directory, 31337);
    // Expiry and curve/signing config deliberately differ from the stored plan.
    const runtime = { config: { mode: "fork", deploymentChainId: 4663, chainId: 31337, writesEnabled: false, launchGuard: null, curvePolicy: "future", treasury: null } };
    let canonicalHash: Hex = blockHash, unknown = false;
    const client = { getTransaction: async () => tx, getTransactionReceipt: async () => { if (unknown) throw new Error("timeout"); return receipt; }, getBlockNumber: async () => 11n,
      getBlock: async () => ({ hash: canonicalHash, timestamp: BigInt(plan.firstBuy!.deadline - 1) }), readContract: async () => SUPPLY };
    const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime, store, client, assertNetwork: async () => {},
      sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey }) }) } }) as LaunchpadService;
    const saved = await service.register(hash);
    assert.equal(saved.curvePolicy, CURVE_POLICY); assert.equal(saved.creator, creator);
    assert.equal((await service.register(hash)).address, token);
    canonicalHash = `0x${"cc".repeat(32)}`; unknown = true;
    await service.reconcile(); assert.equal(store.token(token), null); assert.equal(store.pendingLaunches()[0].status, "pending");
    canonicalHash = blockHash; unknown = false; await service.reconcile(); assert.equal(store.token(token)?.address, token);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("JSON plan persistence preserves uint128 amounts and targets through the existing Supabase payload", async () => {
  const { plan } = fixture();
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-launch");
  let body: unknown;
  store.request = async <T>(_path: string, _method?: string, payload?: unknown) => { body = JSON.parse(JSON.stringify(payload)); return undefined as T; };
  await store.savePlan(plan);
  const stored = (body as { payload: LaunchPlan }).payload;
  assert.deepEqual(stored, JSON.parse(JSON.stringify(plan)));
  assert.equal(stored.prepared!.createParams.initialSupply, SUPPLY.toString());
});

test("unconfirmed or orphaned reverted receipts remain pending and can recover after a reorg", async () => {
  const { plan, receipt } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "launch-reorg-test-"));
  const store = new Store(directory, 31337);
  try {
    store.savePlan(plan); store.trackLaunch(hash, plan.id);
    let head = 10n, canonical = blockHash, status = "reverted";
    let recovered = false;
    const service = Object.assign(Object.create(LaunchpadService.prototype), { store, assertNetwork: async () => {},
      client: { getTransactionReceipt: async () => ({ ...receipt, status }), getBlockNumber: async () => head,
        getBlock: async () => ({ hash: canonical }) },
      register: async () => { recovered = true; store.launchStatus(hash, "confirmed", blockHash); } }) as LaunchpadService;
    await service.reconcile(); assert.equal(store.pendingLaunches()[0].status, "pending");
    head = 11n; canonical = `0x${"cc".repeat(32)}`;
    await service.reconcile(); assert.equal(store.pendingLaunches()[0].status, "pending");
    canonical = blockHash; status = "success";
    await service.reconcile(); assert.equal(recovered, true);
    assert.equal(store.pendingLaunches()[0].status, "confirmed");
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("the compiled guard runtime has only the pinned Bundler substituted and fails closed on a foreign runtime", async () => {
  const expected = expectedGuardRuntime(); assert(expected.length > 1000);
  const client = { getBlockNumber: async () => 1n, getCode: async () => "0x1234", readContract: async () => ROBINHOOD_BUNDLER } as unknown as Parameters<typeof verifyLaunchGuard>[0];
  await assert.rejects(() => verifyLaunchGuard(client, guard), /do not match/);
});

test("failed guard verification cannot inherit another request's verified address", async () => {
  let rejectNetwork!: (error: Error) => void;
  const runtime = { config: { mode: "fork", deploymentChainId: 4663, chainId: 31337,
    writesEnabled: true, launchGuard: null as Address | null, treasury } };
  const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime, guardCandidate: guard,
    assertNetwork: () => new Promise<void>((_resolve, reject) => { rejectNetwork = reject; }) }) as LaunchpadService;
  const failedRequest = service.config();
  // A concurrent successful verification used to write this shared field.
  runtime.config.launchGuard = guard;
  rejectNetwork(new Error("RPC verification failed"));
  assert.equal((await failedRequest).launchGuard, null);
  assert.equal(runtime.config.launchGuard, guard, "config reads do not mutate shared state");
});
