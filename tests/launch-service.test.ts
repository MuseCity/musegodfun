import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DopplerSDK, airlockAbi, bundlerAbi, computePoolId, rehypeDopplerHookInitializerAbi, verifyPreparedCreateExecution } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, http, encodeFunctionData, encodeEventTopics, encodeAbiParameters, decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiParameters, erc20Abi, formatUnits, keccak256, zeroAddress, ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, type Hex, type Address, type TransactionReceipt } from "viem";
import { ROBINHOOD_BUNDLER, ROBINHOOD_BUNDLER_CODE_HASH, ROBINHOOD_CONTRACTS as contracts, ROBINHOOD_STOCKS, STOCKS, SUPPLY, assetsFor, launchAssetsFor, listedTokens, stockByAddress, type RuntimeConfig, type Stock, type TokenRecord } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { restorePrepared, serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { buildLaunch } from "../src/lib/protocol";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import { minimumOutput } from "../src/lib/validation";
import { syntheticOpeningValuation } from "./fixtures";
import { ENGINE_MANIFEST } from "../server/launch-policy-registry";
import { activatedEngineManifest } from "./engine-manifest-fixture";
import { OPENING_CAP_USD, openingCapInQuote, type HistoricalOpeningValuation } from "../src/lib/opening-valuation";
import { assertPlanIntegrity, assertRecoveryPlan, verifiedFirstBuyLock, verifyGuardedReceipt } from "../server/launch-verification";
import { chainLaunchDependencies, expectedGuardRuntime, identifyGuardVersion, LaunchGuardMismatch, verifyLaunchGuard } from "../server/launch-guard";
import { LaunchpadService } from "../server/service";
import { planAttestation, verifyPlanAttestation } from "../server/plan-attestation";
import { Store } from "../server/store";
import { unpackPlan } from "../server/plan-storage";
import { SupabaseStore } from "../server/supabase-store";
import { FIRST_BUY_PAYMENT_CONTRACTS, assertFirstBuyPaymentQuote, firstBuyPairedAsset, firstBuyPaymentAbi, firstBuyPaymentAssets, type FirstBuyPaymentQuote } from "../src/lib/first-buy-payment";

const creator = "0x1111111111111111111111111111111111111111" as Address;
const treasury = "0x2222222222222222222222222222222222222222" as Address;
const guard = "0x3333333333333333333333333333333333333333" as Address;
const token = "0x4444444444444444444444444444444444444444" as Address;
const hash = `0x${"aa".repeat(32)}` as Hex, blockHash = `0x${"bb".repeat(32)}` as Hex;
const quote = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
function fixture(quoteAsset: Stock = quote, tradingFeeBps = 100) {
  const quote = quoteAsset;
  const sdk = new DopplerSDK<4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 4663 });
  const openingValuation = syntheticOpeningValuation(quote.address, "3000", { chainId: 4663 });
  const draft = { name: "Guard Test", symbol: "GUARD", description: "", image: "", quoteAddress: quote.address, tradingFeeBps };
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
    firstBuy: { amount: formatUnits(amountIn, quote.decimals), amountIn: "100", expectedAmountOut: "1000", minAmountOut: "990", slippageBps: 100, deadline, recipient: creator, quoteAddress: quote.address, guard, bundler: ROBINHOOD_BUNDLER },
    approval: { token: quote.address, spender: guard, amount: "100", required: true, transaction: { ...approval, value: "0" } } };
  const guardLog = { address: guard, topics: encodeEventTopics({ abi: launchGuardAbi, eventName: "GuardedLaunch", args: { creator, asset: token, numeraire: quote.address } }),
    data: encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }, { type: "bytes32" }], [amountIn, expected, min, BigInt(deadline), plan.poolId]) };
  const poolTuple = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] } as const;
  const receipt = { status: "success", from: creator, to: guard, transactionHash: hash, blockHash, blockNumber: 10n, logs: [
    { address: contracts.airlock, topics: encodeEventTopics({ abi: airlockAbi, eventName: "Create", args: { numeraire: quote.address } }), data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [token, contracts.initializer, token]) },
    { address: ROBINHOOD_BUNDLER, topics: encodeEventTopics({ abi: bundlerAbi, eventName: "Bundled", args: { recipient: creator } }), data: encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }, poolTuple], [amountIn, expected, poolKey]) }, guardLog,
    { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: zeroAddress, to: contracts.airlock } }),
      data: encodeAbiParameters([{ type: "uint256" }], [SUPPLY]) },
    { address: contracts.rehype, topics: encodeEventTopics({ abi: rehypeDopplerHookInitializerAbi, eventName: "FeeScheduleSet", args: { poolId: plan.poolId } }),
      data: encodeAbiParameters([{ type: "uint32" }, { type: "uint24" }, { type: "uint24" }, { type: "uint32" }], [1, tradingFeeBps * 100, tradingFeeBps * 100, 0]) },
  ] } as unknown as TransactionReceipt;
  const tx = { hash, from: creator, to: guard, input: plan.data, value: 0n };
  return { sdk, plan, prepared, receipt, tx, guardLog, poolKey };
}

function historicalFixture(quotedAt = Date.now()) {
  const f = fixture();
  const legacy: HistoricalOpeningValuation = { policy: "fixed-usd-5000-v1", marketCapUsd: OPENING_CAP_USD,
    chainId: 4663, quoteAddress: quote.address, quotePriceUsd: "3000", quotedAt, expiresAt: quotedAt + 300_000,
    source: "Chainlink", sourceUpdatedAt: quotedAt, blockNumber: "10", blockHash, feed: treasury };
  const factoryDataAbi = parseAbiParameters("string name,string symbol,(uint64 cliff,uint64 duration)[] schedules,address[] beneficiaries,uint256[] scheduleIds,uint256[] amounts,string tokenURI,uint256 maxBalanceLimit,uint48 balanceLimitEnd,address controller,address[] excluded");
  const decoded = decodeAbiParameters(factoryDataAbi, f.prepared.createParams.tokenFactoryData);
  const metadata = JSON.parse(decodeURIComponent(decoded[6].slice("data:application/json,".length)));
  metadata.properties.openingValuation = legacy;
  metadata.properties.openingCap = openingCapInQuote(legacy);
  const tokenURI = `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;
  f.prepared.createParams.tokenFactoryData = encodeAbiParameters(factoryDataAbi,
    [decoded[0], decoded[1], decoded[2], decoded[3], decoded[4], decoded[5], tokenURI, decoded[7], decoded[8], decoded[9], decoded[10]]);
  const deadline = Math.floor(legacy.expiresAt / 1000);
  f.plan.openingValuation = legacy; f.plan.draft.openingCap = openingCapInQuote(legacy); f.plan.preparedAt = quotedAt;
  f.plan.firstBuy!.deadline = deadline;
  const data = encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuy", args: [f.prepared.createParams, 100n, 990n, BigInt(deadline)] });
  f.prepared.transaction.data = data;
  f.plan.data = data; f.plan.id = keccak256(data); f.plan.transaction!.data = data;
  f.plan.prepared = serializePrepared(f.prepared); f.tx.input = data;
  f.guardLog.data = encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }, { type: "bytes32" }],
    [100n, 1000n, 990n, BigInt(deadline), f.plan.poolId]);
  assertPlanIntegrity(f.plan, contracts);
  return { ...f, tokenURI };
}

function lockedFixture(lockDays: 30 | 90 | 365 = 30, quoteAsset: Stock = quote, tradingFeeBps = 100) {
  const f = fixture(quoteAsset, tradingFeeBps), duration = BigInt(lockDays) * 86400n, start = BigInt(f.plan.firstBuy!.deadline - 1);
  f.plan.firstBuy!.lockDays = lockDays;
  f.prepared.devBuy.vesting = { permissionlessClaim: false, cliffDuration: duration, vestingDuration: duration };
  const data = encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuyLocked",
    args: [f.prepared.createParams, 100n, 990n, BigInt(f.plan.firstBuy!.deadline), lockDays] });
  f.prepared.transaction.data = data;
  f.plan.data = data; f.plan.id = keccak256(data); f.plan.transaction!.data = data;
  f.plan.prepared = serializePrepared(f.prepared);
  f.tx.input = data;
  const vestingLog = { address: ROBINHOOD_BUNDLER, topics: encodeEventTopics({ abi: bundlerAbi, eventName: "VestingCreated", args: { asset: token, recipient: creator } }),
    data: encodeAbiParameters([{ type: "bool" }, { type: "uint128" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
      [false, 1000n, start, duration, duration]) };
  f.receipt.logs.push(vestingLog as unknown as TransactionReceipt["logs"][number]);
  const custodyLog = { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: contracts.poolManager, to: ROBINHOOD_BUNDLER } }),
    data: encodeAbiParameters([{ type: "uint256" }], [1000n]) };
  f.receipt.logs.push(custodyLog as unknown as TransactionReceipt["logs"][number]);
  return { ...f, start, duration, vestingLog, custodyLog };
}

function ordinaryFixture(tradingFeeBps = 100) {
  const f = fixture(quote, tradingFeeBps), prepared = restorePrepared(f.plan.prepared!);
  delete prepared.devBuy; delete prepared.approvalTransaction;
  delete f.plan.firstBuy; delete f.plan.approval;
  const data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [prepared.createParams] });
  prepared.transaction = { to: contracts.airlock, data, value: 0n };
  f.plan.data = data; f.plan.id = keccak256(data);
  f.plan.transaction = { ...prepared.transaction, value: "0" };
  f.plan.prepared = serializePrepared(prepared);
  f.tx.input = data; f.tx.to = contracts.airlock;
  f.receipt.to = contracts.airlock; f.receipt.logs = f.receipt.logs.filter((log) => ![guard, ROBINHOOD_BUNDLER].some((address) => address.toLowerCase() === log.address.toLowerCase()));
  return { ...f, prepared };
}

function registryOnlyAsset(chainId: 8453 | 4663) {
  const registry = assetsFor({ mode: "fork", deploymentChainId: chainId });
  const allowed = launchAssetsFor({ mode: "fork", deploymentChainId: chainId });
  const removed = registry.find((asset) => !allowed.some((candidate) => candidate.address === asset.address));
  assert(removed, "each chain has an actual issuer identity excluded from new issuance");
  return { asset: removed, restore() {} };
}

test("new prepares and payment preflights reject opening-price exclusions before RPC, SDK or storage", async () => {
  for (const chainId of [8453, 4663] as const) {
    const actualExcluded = assetsFor({ mode: "fork", deploymentChainId: chainId }).filter((asset) =>
      !launchAssetsFor({ mode: "fork", deploymentChainId: chainId }).some((candidate) => candidate.address === asset.address));
    assert.equal(actualExcluded.length, chainId === 8453 ? 21 : 83);
    const excluded = registryOnlyAsset(chainId);
    try {
      assert.equal(stockByAddress(excluded.asset.address, chainId), excluded.asset);
      for (const asset of actualExcluded.length ? actualExcluded : [excluded.asset]) for (const mode of [chainId === 8453 ? "base" : "robinhood", "fork"] as const) {
        const config: RuntimeConfig = { mode, deploymentChainId: chainId, chainId: mode === "fork" ? 31337 : chainId,
          treasury, writesEnabled: false, blockReason: "Read-only" };
        let rpc = 0;
        const untouched = () => { throw new Error("Excluded asset must not access SDK or storage"); };
        const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config },
          assertNetwork: async () => { rpc++; }, sdk: new Proxy({}, { get: untouched }), store: new Proxy({}, { get: untouched }) }) as LaunchpadService;
        const draft = { name: "Excluded route", symbol: "EXCLUDE", description: "", image: "", website: "", twitter: "", telegram: "", quoteAddress: asset.address };
        for (const firstBuy of [{ amount: "0", slippageBps: 100, lockDays: 0 }, { amount: "1", slippageBps: 100, lockDays: 30 }])
          await assert.rejects(() => service.prepare(draft, creator, CURVE_POLICY, firstBuy), /new launch.*verified LI\.FI opening-price/);
        await assert.rejects(() => service.preflightFirstBuyPayment(asset.address), /new launch.*verified LI\.FI opening-price/);
        assert.equal(rpc, 0); assert.equal(config.writesEnabled, false);
        assert(service.assets.some((candidate) => candidate.address === asset.address), "historical service registry remains complete");
      }
    } finally { excluded.restore(); }
  }
});

test("opening-price exclusions do not hide existing tokens or block their scoped lookup", async () => {
  for (const chainId of [8453, 4663] as const) {
    const excluded = registryOnlyAsset(chainId);
    try {
      const tokenRecord = { address: token, mode: "fork", deploymentChainId: chainId, transactionHash: hash,
        quoteAddress: excluded.asset.address } as TokenRecord;
      assert.deepEqual(listedTokens([tokenRecord], "fork", chainId), [tokenRecord]);
      assert.deepEqual(listedTokens([tokenRecord], "fork", chainId === 8453 ? 4663 : 8453), []);
      const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
        runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: chainId } },
        store: { tokens: async () => [tokenRecord], token: async () => tokenRecord },
      }) as LaunchpadService;
      assert.deepEqual(await service.tokens(), [tokenRecord]); assert.equal(await service.token(token), tokenRecord);
    } finally { excluded.restore(); }
  }
});

test("removed paired assets remain valid in frozen launch integrity, old-plan validation and receipt recovery", async () => {
  const excluded = registryOnlyAsset(4663), directory = mkdtempSync(join(tmpdir(), "removed-asset-recovery-test-")), store = new Store(directory, 31337);
  try {
    const f = lockedFixture(30, excluded.asset);
    assertPlanIntegrity(f.plan, contracts);
    verifyGuardedReceipt(f.plan, f.receipt, 1000n);
    store.savePlan(f.plan);
    const config: RuntimeConfig = { mode: "fork", chainId: 31337, deploymentChainId: 4663,
      treasury, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY, feePolicy: FEE_POLICY,
      launchGuard: guard, launchLockAvailable: true };
    const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config }, store,
      config: async () => config, assertNetwork: async () => {},
      client: { getTransaction: async () => f.tx, getTransactionReceipt: async () => f.receipt,
        getBlockNumber: async () => 11n, getBlock: async () => ({ hash: blockHash, timestamp: f.start }),
        readContract: async (input: { functionName: string }) => input.functionName === "totalSupply" ? SUPPLY
          : input.functionName === "getFeeSchedule" ? [Number(f.start), 10_000, 10_000, 10_000, 0]
          : [creator, false, f.start, f.duration, f.duration, 1000n, 0n] },
      sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: excluded.asset.address, poolKey: f.poolKey }) }) },
    }) as LaunchpadService;
    assert.equal((await service.validateLaunch(creator, f.plan.data)).valid, true);
    config.launchGuard = null; config.launchLockAvailable = false; config.curvePolicy = "future"; config.treasury = null;
    const saved = await service.register(hash);
    assert.equal(saved.quoteAddress, excluded.asset.address); assert.equal(saved.firstBuyLock?.totalAmount, "1000");
    assert.equal((await service.token(token)).address, token);
  } finally { store.close(); rmSync(directory, { recursive: true }); excluded.restore(); }
});

test("expired frozen payments still decode removed paired assets through the complete historical registry", () => {
  for (const chainId of [8453, 4663] as const) {
    const excluded = registryOnlyAsset(chainId);
    try {
      const registry = FIRST_BUY_PAYMENT_CONTRACTS[chainId], now = Date.now();
      const fromToken = firstBuyPaymentAssets(chainId).find((asset) => asset.address === zeroAddress)!;
      const toToken = firstBuyPairedAsset(chainId, excluded.asset.address);
      const payment: FirstBuyPaymentQuote = { protocol: "lifi", id: "historical-route-policy", transactionId: hash,
        integrator: "musegodfun", tool: "verified", chainId, account: creator, fromToken, toToken, amountIn: "1000",
        expectedOut: "1000", minimumOut: "990", slippageBps: 100, quotedAt: now - 120_000, expiresAt: now - 60_000,
        router: registry.diamond, facet: registry.facet, facetRuntimeHash: registry.runtimeHash, blockNumber: "10", blockHash,
        transaction: { to: registry.diamond, value: "1000", data: encodeFunctionData({ abi: firstBuyPaymentAbi,
          functionName: "swapTokensSingleV3NativeToERC20", args: [hash, "musegodfun", zeroAddress, creator, 990n,
            { callTo: treasury, approveTo: treasury, sendingAssetId: zeroAddress, receivingAssetId: toToken.address,
              fromAmount: 1000n, callData: "0x3f0bde25", requiresDeposit: true }] }) },
        approval: null, feeAmount: "0", feeUsd: null, gasFeeUsd: null, amountInUsd: null };
      assertFirstBuyPaymentQuote(payment, now, true);
      assert.throws(() => assertFirstBuyPaymentQuote(payment, now), /could not be verified/);
    } finally { excluded.restore(); }
  }
});

test("missing and stale curve handshakes reject before any RPC", async () => {
  let rpc = 0;
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { assertNetwork: async () => { rpc++; } }) as LaunchpadService;
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

test("frozen issuance binds the selected trading fee on all creation paths", () => {
  for (const make of [ordinaryFixture, (fee: number) => fixture(quote, fee), (fee: number) => lockedFixture(30, quote, fee)]) {
    for (const fee of [100, 300]) {
      const f = make(fee);
      assert.doesNotThrow(() => assertPlanIntegrity(f.plan, contracts));
      f.plan.draft.tradingFeeBps = fee === 300 ? 100 : 300;
      assert.throws(() => assertPlanIntegrity(f.plan, contracts), /trading fee/);
      delete f.plan.draft.tradingFeeBps;
      if (fee === 100) assert.doesNotThrow(() => assertPlanIntegrity(f.plan, contracts));
      else assert.throws(() => assertPlanIntegrity(f.plan, contracts), /trading fee/);
    }
  }
});

test("registration verifies creation mint and fee events without mutable or historical contract reads", async () => {
  for (const make of [ordinaryFixture, (fee: number) => fixture(quote, fee), (fee: number) => lockedFixture(30, quote, fee)]) {
    for (const fee of [100, 300]) {
      const f = make(fee), directory = mkdtempSync(join(tmpdir(), "trading-fee-register-test-")), store = new Store(directory, 31337);
      const start = BigInt(Math.floor(f.plan.openingValuation!.expiresAt / 1000) - 1);
      const schedule = f.receipt.logs.find((log) => log.address === contracts.rehype)!;
      const validData = schedule.data;
      try {
        store.savePlan(f.plan);
        const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
          runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: 4663, writesEnabled: false } },
          store, assertNetwork: async () => {},
          client: { getTransaction: async () => f.tx, getTransactionReceipt: async () => f.receipt,
            getBlockNumber: async () => 11n, getBlock: async () => ({ hash: blockHash, timestamp: start }),
            readContract: async () => { throw new Error("Archive unavailable; live supply already burned"); } },
          sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey: f.poolKey }) }) },
        }) as LaunchpadService;
        for (const index of [1, 2, 3]) {
          const values = [1, fee * 100, fee * 100, 0]; values[index]++;
          schedule.data = encodeAbiParameters([{ type: "uint32" }, { type: "uint24" }, { type: "uint24" }, { type: "uint32" }], values as [number, number, number, number]);
          await assert.rejects(() => service.register(hash), /trading fee schedule/);
          assert.equal(store.token(token), null);
        }
        schedule.data = validData;
        const saved = await service.register(hash);
        assert.equal(saved.tradingFeeBps, fee); assert.equal(store.token(token)?.tradingFeeBps, fee);
        assert.equal((await service.register(hash)).address, saved.address, "burns and claims after creation cannot break idempotent recovery");
      } finally { store.close(); rmSync(directory, { recursive: true }); }
    }
  }
});

test("actual creation calldata rejects a three percent declaration with one percent encoded", async () => {
  for (const f of [ordinaryFixture(), fixture(), lockedFixture()]) {
    const directory = mkdtempSync(join(tmpdir(), "trading-fee-mismatch-test-")), store = new Store(directory, 31337);
    try {
      f.plan.draft.tradingFeeBps = 300; store.savePlan(f.plan);
      const untouched = async () => { throw new Error("Mismatched fee must stop before contract reads or pool lookup"); };
      const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
        runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: 4663, writesEnabled: false } },
        store, assertNetwork: async () => {},
        client: { getTransaction: async () => f.tx, getTransactionReceipt: async () => f.receipt, getBlockNumber: async () => 11n, readContract: untouched },
        sdk: { getMulticurvePool: untouched },
      }) as LaunchpadService;
      await assert.rejects(() => service.trackLaunch(hash, f.plan.id), /trading fee/);
      await assert.rejects(() => service.register(hash), /trading fee/);
      assert.equal(store.token(token), null);
    } finally { store.close(); rmSync(directory, { recursive: true }); }
  }
});

test("historical unprepared transactions recover only the original one percent fee", async () => {
  for (const fee of [100, 300]) {
    const f = ordinaryFixture(fee), directory = mkdtempSync(join(tmpdir(), "historical-trading-fee-test-")), store = new Store(directory, 31337);
    delete f.plan.draft.tradingFeeBps; delete f.plan.prepared; delete f.plan.transaction; delete f.plan.curvePolicy;
    delete f.plan.openingValuation;
    f.plan.preparedAt = Date.now() - 86_400_000; f.plan.feePolicy = "musegod-80-v1";
    let feeReads = 0;
    try {
      store.savePlan(f.plan);
      const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
        runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: 4663, writesEnabled: false, curvePolicy: "future", treasury: null } },
        store, assertNetwork: async () => {}, validateLaunch: async () => { throw new Error("Recovery must not use current signing gates"); },
        client: { getTransaction: async () => f.tx, getTransactionReceipt: async () => f.receipt,
          getBlockNumber: async () => 11n, getBlock: async () => ({ hash: blockHash, timestamp: 1n }),
          readContract: async (input: { functionName: string; blockNumber?: bigint }) => {
            if (input.functionName === "totalSupply") return SUPPLY;
            assert.equal(input.functionName, "getFeeSchedule"); assert.equal(input.blockNumber, 10n); feeReads++;
            return [1, fee * 100, fee * 100, fee * 100, 0];
          } },
        sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey: f.poolKey }) }) },
      }) as LaunchpadService;
      if (fee === 100) {
        await service.trackLaunch(hash, f.plan.id);
        assert.equal((await service.register(hash)).tradingFeeBps, 100); assert.equal(feeReads, 0);
      } else {
        await assert.rejects(() => service.trackLaunch(hash, f.plan.id), /trading fee/);
        await assert.rejects(() => service.register(hash), /trading fee/);
        assert.equal(feeReads, 0); assert.equal(store.token(token), null);
      }
    } finally { store.close(); rmSync(directory, { recursive: true }); }
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

test("locked previews and receipts bind each schedule, amount, recipient and actual block timestamp", async () => {
  for (const days of [30, 90, 365] as const) {
    const f = lockedFixture(days);
    assertPlanIntegrity(f.plan, contracts);
    const result = await verifyPreparedCreateExecution({ prepared: f.prepared, receipt: f.receipt, publicClient: { getTransaction: async () => f.tx } });
    const record = verifiedFirstBuyLock(f.plan, f.receipt, f.start)!;
    assert.equal(result.devBuy?.amountOut, 1000n);
    assert.equal(record.totalAmount, "1000"); assert.equal(record.lockDays, days);
    assert.equal(record.recipient, creator); assert.equal(record.cliffDuration, days * 86400);
    assert.throws(() => verifiedFirstBuyLock(f.plan, f.receipt, f.start + 1n), /lock event/);
    const changed = structuredClone(f.plan); changed.firstBuy!.lockDays = days === 30 ? 90 : 30;
    assert.throws(() => assertPlanIntegrity(changed, contracts), /changed/);
    await assert.rejects(() => verifyPreparedCreateExecution({ prepared: f.prepared,
      receipt: { ...f.receipt, logs: f.receipt.logs.filter((log) => log !== f.vestingLog) }, publicClient: { getTransaction: async () => f.tx } }));
    assert.throws(() => verifiedFirstBuyLock(f.plan, { ...f.receipt, logs: [...f.receipt.logs, f.vestingLog] as TransactionReceipt["logs"] }, f.start), /lock event/);
  }
});

test("guard versions remain distinguishable and Base binds its own official dependency hash", () => {
  const legacy = expectedGuardRuntime(4663, "legacy"), vesting = expectedGuardRuntime(4663, "vesting");
  assert.notEqual(legacy, vesting);
  assert.equal(identifyGuardVersion(legacy, 4663), "legacy");
  assert.equal(identifyGuardVersion(vesting, 8453), "vesting");
  assert.equal(identifyGuardVersion("0x1234", 8453), null);
  assert.notEqual(chainLaunchDependencies(8453).bundlerCodeHash, chainLaunchDependencies(4663).bundlerCodeHash);
  assert.equal(chainLaunchDependencies(8453).contracts.airlock.toLowerCase(), "0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12");
});

test("registration persists only verified locked custody and recovers without current signing capabilities", async () => {
  const f = lockedFixture(), directory = mkdtempSync(join(tmpdir(), "locked-recovery-test-")), store = new Store(directory, 31337);
  try {
    store.savePlan(f.plan);
    let badPosition = false;
    const client = { getTransaction: async () => f.tx, getTransactionReceipt: async () => f.receipt,
      getBlockNumber: async () => 11n, getBlock: async () => ({ hash: blockHash, timestamp: f.start }),
      readContract: async (args: { functionName: string }) => args.functionName === "totalSupply" ? SUPPLY
        : args.functionName === "getFeeSchedule" ? [Number(f.start), 10_000, 10_000, 10_000, 0]
        : [creator, false, f.start, f.duration, f.duration, badPosition ? 999n : 1000n, 0n] };
    const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config: { mode: "fork", chainId: 31337,
      deploymentChainId: 4663, writesEnabled: false, launchGuard: null, launchLockAvailable: false } }, store, client,
      assertNetwork: async () => {}, sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey: f.poolKey }) }) } }) as LaunchpadService;
    badPosition = true; f.custodyLog.data = encodeAbiParameters([{ type: "uint256" }], [999n]); await assert.rejects(() => service.register(hash), /custody/);
    assert.equal(store.token(token), null);
    badPosition = false; f.custodyLog.data = encodeAbiParameters([{ type: "uint256" }], [1000n]); const saved = await service.register(hash);
    assert.equal(saved.firstBuyLock?.totalAmount, "1000"); assert.equal(saved.firstBuyLock?.start, Number(f.start));
    assert.deepEqual((await service.register(hash)).firstBuyLock, saved.firstBuyLock);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
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
      getBlock: async () => ({ hash: canonicalHash, timestamp: BigInt(plan.firstBuy!.deadline - 1) }),
      readContract: async (input: { functionName: string }) => input.functionName === "getFeeSchedule" ? [plan.firstBuy!.deadline - 1, 10_000, 10_000, 10_000, 0] : SUPPLY };
    const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime, store, client, assertNetwork: async () => {},
      sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey }) }) } }) as LaunchpadService;
    const saved = await service.register(hash);
    assert.equal(saved.curvePolicy, CURVE_POLICY); assert.equal(saved.creator, creator);
    assert.equal((await service.register(hash)).address, token);
    canonicalHash = `0x${"cc".repeat(32)}`; unknown = true;
    await service.reconcile(); assert.equal(store.token(token), null); assert.equal(store.pendingLaunches(Date.now() + 500_000)[0].status, "pending");
    canonicalHash = blockHash; unknown = false; store.db.prepare("UPDATE pending_launches SET retry_at=0").run(); await service.reconcile(); assert.equal(store.token(token)?.address, token);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("broadcast retired-price plans recover original metadata after expiry while unsigned plans cannot validate", async (context) => {
  const current = fixture(), unsigned = historicalFixture(), old = historicalFixture(Date.now() - 86_400_000);
  const directory = mkdtempSync(join(tmpdir(), "legacy-price-recovery-test-")), store = new Store(directory, 31337);
  let pricingRequests = 0;
  context.mock.method(globalThis, "fetch", async () => { pricingRequests++; throw new Error("Recovery must not reprice an already broadcast launch"); });
  const config: RuntimeConfig = { mode: "fork", chainId: 31337, deploymentChainId: 4663, treasury,
    writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY, feePolicy: FEE_POLICY, launchGuard: guard };
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config }, store,
    config: async () => config, assertNetwork: async () => {},
    client: { getTransaction: async () => old.tx, getTransactionReceipt: async () => old.receipt,
      getBlockNumber: async () => 11n, getBlock: async () => ({ hash: blockHash, timestamp: BigInt(old.plan.firstBuy!.deadline - 1) }),
      readContract: async (input: { functionName: string }) => input.functionName === "getFeeSchedule" ? [old.plan.firstBuy!.deadline - 1, 10_000, 10_000, 10_000, 0] : SUPPLY },
    sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey: old.poolKey }) }) },
  }) as LaunchpadService;
  try {
    store.savePlan(current.plan);
    assert.equal((await service.validateLaunch(creator, current.plan.data)).valid, true);
    store.savePlan(unsigned.plan);
    await assert.rejects(() => service.validateLaunch(creator, unsigned.plan.data), /opening market cap policy has changed/);
    store.savePlan(old.plan);
    assert(old.plan.openingValuation!.expiresAt < Date.now());
    const embedded = JSON.parse(decodeURIComponent(old.tokenURI.slice("data:application/json,".length)));
    assert.deepEqual(embedded.properties.openingValuation, old.plan.openingValuation);
    assert.equal(embedded.properties.openingValuation.policy, "fixed-usd-5000-v1");
    assert.equal(embedded.properties.openingValuation.source, "Chainlink");
    config.treasury = null; config.launchGuard = null; config.curvePolicy = "future";
    await service.trackLaunch(hash, old.plan.id);
    const recovered = await service.register(hash);
    assert.deepEqual(recovered.openingValuation, old.plan.openingValuation);
    assert.equal(recovered.openingCap, old.plan.draft.openingCap);
    assert.equal(store.pendingLaunches()[0].status, "confirmed");
    assert.equal(pricingRequests, 0);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("JSON plan persistence preserves uint128 amounts and targets through the existing Supabase payload", async () => {
  const { plan } = fixture();
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-launch");
  let body: unknown;
  store.request = async <T>(_path: string, _method?: string, payload?: unknown) => { body = JSON.parse(JSON.stringify(payload)); return undefined as T; };
  await store.savePlan(plan);
  const stored = unpackPlan((body as { payload: unknown }).payload);
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
    const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { store, assertNetwork: async () => {},
      client: { getTransactionReceipt: async () => ({ ...receipt, status }), getBlockNumber: async () => head,
        getBlock: async () => ({ hash: canonical }) },
      register: async () => { recovered = true; store.launchStatus(hash, "confirmed", blockHash); } }) as LaunchpadService;
    await service.reconcile(); assert.equal(store.pendingLaunches(Date.now() + 500_000)[0].status, "pending");
    head = 11n; canonical = `0x${"cc".repeat(32)}`;
    await service.reconcile(); assert.equal(store.pendingLaunches(Date.now() + 500_000)[0].status, "pending");
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
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime, guardCandidate: guard,
    assertNetwork: () => new Promise<void>((_resolve, reject) => { rejectNetwork = reject; }) }) as LaunchpadService;
  const failedRequest = service.config();
  // A concurrent successful verification used to write this shared field.
  runtime.config.launchGuard = guard;
  rejectNetwork(new Error("RPC verification failed"));
  assert.equal((await failedRequest).launchGuard, null);
  assert.equal(runtime.config.launchGuard, guard, "config reads do not mutate shared state");
});

function paymentPreflightFixture(chainId: 8453 | 4663 = 8453) {
  const asset = chainId === 8453 ? STOCKS.find((stock) => stock.ticker === "NVDA")! : quote;
  const numeraire = firstBuyPaymentAssets(chainId).find((item) => item.symbol === (chainId === 8453 ? "USDC" : "USDG"))!;
  const calls: string[] = [];
  const requests: URLSearchParams[] = [], identityBlocks: bigint[] = [];
  const state = { fault: "", rpcChainId: chainId as number, guard: guard as Address | null, feePolicy: FEE_POLICY as string };
  const config: RuntimeConfig = { mode: chainId === 8453 ? "base" : "robinhood", deploymentChainId: chainId,
    chainId, treasury, writesEnabled: false, blockReason: "Read-only" };
  const untouched = () => { throw new Error("Payment preflight must not access SDK preparation or storage"); };
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
    runtime: { config, lifi: { integrator: "service-preflight-test" } }, store: new Proxy({}, { get: untouched }), sdk: new Proxy({}, { get: untouched }),
    config: async () => ({ ...config, launchGuard: state.guard, feePolicy: state.feePolicy, feeEngine: null }),
    rpcRequest: async (method: string) => { assert.equal(method, "web3_clientVersion"); return "anvil synthetic unit-test fixture"; },
    client: {
      getChainId: async () => state.rpcChainId,
      getBlock: async () => ({ number: 1n, hash: blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)) - 5n }),
      getCode: async ({ blockNumber }: { blockNumber: bigint }) => { identityBlocks.push(blockNumber); return "0x1234"; },
      readContract: async (input: { address: Address; functionName: string; blockNumber?: bigint }) => {
        calls.push(input.functionName);
        const target = input.address.toLowerCase() === asset.address.toLowerCase() ? asset : numeraire;
        if (input.blockNumber !== undefined) identityBlocks.push(input.blockNumber);
        if (input.functionName === "symbol") return state.fault === "identity" ? "WRONG" : target.symbol;
        if (input.functionName === "decimals") return target.decimals;
        if (input.functionName === "name") return asset.name;
        if (input.functionName === "totalSupply") return 1n;
        if (input.functionName === "multiplier") return 10n ** 18n;
        throw new Error(`Unexpected payment preflight call ${input.functionName}`);
      },
    },
  }) as LaunchpadService;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://li.quest"); assert.equal(url.pathname, "/v1/quote");
    assert.equal(init?.redirect, "manual"); assert(init?.signal);
    const params = url.searchParams; requests.push(params);
    assert.equal(params.get("integrator"), "service-preflight-test");
    assert.equal(params.get("fee"), "0"); assert.equal(params.get("allowBridges"), "none");
    assert.equal(params.get("fromChain"), String(chainId)); assert.equal(params.get("toChain"), String(chainId));
    if (state.fault === "missing" || (state.fault === "reverse-missing" && requests.length === 2))
      return Response.json({ error: "No same-chain route" }, { status: 404 });
    if (state.fault === "timeout") throw new DOMException("Synthetic fetch deadline", "TimeoutError");
    const buy = params.get("fromToken")!.toLowerCase() === numeraire.address.toLowerCase();
    const from = buy ? numeraire : asset, to = buy ? asset : numeraire;
    const amountIn = BigInt(params.get("fromAmount")!), fee = amountIn * 25n / 10_000n;
    const amountOut = buy ? (amountIn - fee) * 10n ** BigInt(asset.decimals) / (100n * 10n ** 6n)
      : (amountIn - fee) * 100n * 10n ** 6n / 10n ** BigInt(asset.decimals);
    const tokenData = (value: typeof numeraire) => ({ ...value, priceUSD: value.symbol === numeraire.symbol ? "1" : "100" });
    const action = { fromChainId: chainId, toChainId: chainId, fromToken: tokenData(from), toToken: tokenData(to),
      fromAddress: params.get("fromAddress"), toAddress: params.get("toAddress"), fromAmount: amountIn.toString(), slippage: Number(params.get("slippage")) };
    if (state.fault === "mismatch") action.toToken.address = treasury;
    return Response.json({ id: `${buy ? "buy" : "sell"}-${requests.length}`, tool: "synthetic-unit-test", action,
      transactionRequest: { chainId, from: action.fromAddress, to: treasury, data: "0x12345678", value: "0x0" },
      estimate: { fromAmount: amountIn.toString(), toAmount: amountOut.toString(), toAmountMin: (amountOut * 99n / 100n).toString(),
        feeCosts: [{ name: "LIFI Fixed Fee", included: true, amount: fee.toString(), token: tokenData(from), feeSplit: { integratorFee: "0", lifiFee: fee.toString() } }] },
      includedSteps: [{ type: "swap", action }] });
  };
  const run = async () => {
    const previous = globalThis.fetch; globalThis.fetch = fetcher;
    try { await service.preflightFirstBuyPayment(asset.address); }
    finally { globalThis.fetch = previous; }
  };
  return { service, asset, calls, requests, identityBlocks, state, config, run };
}

test("payment preflight refuses missing guard, treasury, wrong-chain assets and unverified fee engine", async (context) => {
  let http = 0;
  context.mock.method(globalThis, "fetch", async () => { http++; throw new Error("Dependency failures must precede LI.FI requests"); });
  const f = paymentPreflightFixture();
  f.state.guard = null;
  await assert.rejects(() => f.service.preflightFirstBuyPayment(f.asset.address), /guard is configured and verified/);
  assert.equal(f.calls.length, 0);
  f.state.guard = guard;
  f.config.treasury = null;
  await assert.rejects(() => f.service.preflightFirstBuyPayment(f.asset.address), /treasury is not configured/);
  f.config.treasury = treasury;
  await assert.rejects(() => f.service.preflightFirstBuyPayment(quote.address), /new launch.*verified LI\.FI opening-price/);
  f.state.rpcChainId = 4663;
  await assert.rejects(() => f.service.preflightFirstBuyPayment(f.asset.address), /RPC network does not match/);
  const rh = paymentPreflightFixture(4663);
  rh.state.feePolicy = ENGINE_FEE_POLICY;
  await assert.rejects(() => rh.service.preflightFirstBuyPayment(rh.asset.address), /fee engine could not be verified/);
  assert.equal(rh.calls.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(http, 0);
});

test("payment preflight reads LI.FI swap evidence before conversion without old feeds or launch plans", async () => {
  for (const chainId of [8453, 4663] as const) {
    for (const fault of ["missing", "reverse-missing", "mismatch", "timeout", "identity"]) {
      const f = paymentPreflightFixture(chainId);
      f.state.fault = fault;
      await assert.rejects(f.run, /LI\.FI pricing or routing is unavailable|fixed same-chain price probe|identity verification failed/, `${chainId} ${fault}`);
      assert.equal(f.config.writesEnabled, false, "a failed read cannot enable signing");
      assert.equal(f.calls.some((call) => ["latestRoundData", "getOracleParams", "observe"].includes(call)), false);
      assert.equal(f.requests.length, fault === "identity" ? 0 : fault === "reverse-missing" ? 2 : 1);
    }
    const f = paymentPreflightFixture(chainId), before = structuredClone(f.config);
    await f.run();
    assert.equal(f.requests.length, 2); assert.equal(f.requests[0].get("fromAmount"), "100000000");
    assert.equal(f.requests[0].get("toToken")?.toLowerCase(), f.asset.address.toLowerCase());
    assert.equal(f.requests[1].get("fromToken")?.toLowerCase(), f.asset.address.toLowerCase());
    assert(f.identityBlocks.length >= 6); assert(f.identityBlocks.every((block) => block === 1n));
    assert.equal(f.calls.some((call) => ["latestRoundData", "getOracleParams", "observe"].includes(call)), false);
    assert.deepEqual(f.config, before, "read-only preview leaves runtime permissions unchanged");
    f.state.fault = "missing";
    await f.run(); assert.equal(f.requests.length, 2, "fresh opening probes are shared for ten seconds");
    (f.service as any).openingCache.clear();
    await assert.rejects(f.run, /LI\.FI pricing or routing is unavailable/, "expired cache must not hide a fresh provider failure");
    const fork = paymentPreflightFixture(chainId);
    fork.config.mode = "fork"; fork.config.chainId = 31337; fork.state.rpcChainId = 31337;
    await fork.run(); assert.equal(fork.requests.length, 2);
    assert(fork.requests.every((request) => request.get("fromChain") === String(chainId)), "fork RPC identity does not rewrite deployment-chain quotes");
  }
});


test("local frozen backups are reconstructed before replacing missing server plans", () => {
  for (const f of [fixture(), historicalFixture(), ordinaryFixture(100), lockedFixture()]) {
    // The protocol owner is recovered from the creation's own beneficiaries,
    // which Doppler required to include it with at least 5% inside that transaction.
    assert.doesNotThrow(() => assertRecoveryPlan(f.plan, contracts, f.sdk), `${f.plan.openingValuation!.policy} ${f.plan.firstBuy?.lockDays}`);
    for (const mutation of [
      (p: LaunchPlan) => { p.draft.name = "unproven metadata"; },
      (p: LaunchPlan) => { p.feeTreasury = creator; },
      (p: LaunchPlan) => { p.draft.description = "unproven description"; },
      (p: LaunchPlan) => { p.prepared!.createParams.initialSupply = "1"; },
    ]) {
      const copy = structuredClone(f.plan); mutation(copy);
      assert.throws(() => assertRecoveryPlan(copy, contracts, f.sdk), "creation-time beneficiary candidates cannot launder a changed backup");
    }
  }
});

test("native WETH wrap preflight skips price probes only for the exact native pair", async () => {
  const f = paymentPreflightFixture(4663);
  let probes = 0;
  f.service.openingValuation = async () => { probes++; throw new Error("LI.FI unavailable"); };
  await f.service.preflightFirstBuyPayment(f.asset.address, { fromToken: zeroAddress });
  assert.equal(probes, 0); assert(f.calls.includes("symbol"));
  await assert.rejects(() => f.service.preflightFirstBuyPayment(f.asset.address, { fromToken: creator }), /LI.FI unavailable/);
  assert.equal(probes, 1);
});
test("unsupported smart accounts stop before payment while direct and delegated EOAs retain the flow", async () => {
  const f = paymentPreflightFixture(4663);
  let code = "0x6000", reads = 0;
  f.service.assertNetwork = async () => {};
  const original = f.service.client.getCode.bind(f.service.client);
  f.service.client.getCode = (async (args: {address:Address}) => {
    if (args.address.toLowerCase() === creator.toLowerCase()) { reads++; return code; }
    return original(args);
  }) as typeof f.service.client.getCode;
  await assert.rejects(() => f.service.preflightFirstBuyPayment(f.asset.address, {fromToken:zeroAddress,account:creator}), /smart-account launch.*before converting payment/);
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0, "reject before route/asset work or payment");
  for (const allowed of ["0x", "0xef0100" + treasury.slice(2)]) {
    code = allowed;
    await f.service.preflightFirstBuyPayment(f.asset.address, {fromToken:zeroAddress,account:creator});
  }
  assert.equal(reads, 3);
});

test("refresh preserves intent, salt and accepted floor until explicit confirmation of the displayed minimum", async (context) => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "launch-floor-test-")), store = new Store(directory, 31337);
  let expected = 1000n, time = Date.now();
  context.mock.method(Date, "now", () => time);
  context.mock.method(f.sdk, "getAirlockOwner", async () => treasury);
  context.mock.method(f.sdk.factory, "prepareCreateMulticurve", async (params: Parameters<typeof f.sdk.factory.prepareCreateMulticurve>[0]) => {
    const prepared = structuredClone(f.prepared);
    prepared.createParams = f.sdk.factory.encodeCreateMulticurveParams(params);
    prepared.devBuy.simulatedAmountOut = expected;
    return prepared;
  });
  const config: RuntimeConfig = { mode: "fork", deploymentChainId: 4663, chainId: 31337, treasury, writesEnabled: true,
    blockReason: null, feePolicy: FEE_POLICY, launchGuard: guard, launchLockAvailable: true };
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config }, store, sdk: f.sdk,
    config: async () => config, assertNetwork: async () => {},
    openingValuation: async () => syntheticOpeningValuation(quote.address, "3000", { chainId: 4663, quotedAt: time }),
    client: { getCode: async () => "0x", readContract: async ({ functionName }: { functionName: string }) => ({ symbol: quote.symbol, decimals: quote.decimals,
      name: quote.name, totalSupply: 1n, paused: false, allowance: 100n }[functionName]) } }) as LaunchpadService;
  try {
    const input = { amount: f.plan.firstBuy!.amount, slippageBps: 100, lockDays: 0 };
    const first = await service.prepare(f.plan.draft, creator, CURVE_POLICY, input, { intentId: "same-user-intent" });
    assertRecoveryPlan(first, contracts, f.sdk);
    assert.equal(first.firstBuy!.minAmountOut, "990"); assert.equal(first.signingExpiresAt, first.finalizedAt! + 300_000);
    time += 1000; expected = 1500n;
    const improved = await service.prepare(f.plan.draft, creator, CURVE_POLICY, input, { intentId: first.intentId, previousPlanId: first.id });
    assert.equal(improved.firstBuy!.minAmountOut, "1485"); assert.equal(improved.firstBuy!.acceptedMinAmountOut, "990");
    time += 61_000; expected = 995n;
    const second = await service.prepare(f.plan.draft, creator, CURVE_POLICY, input,
      { intentId: first.intentId, previousPlanId: improved.id, acceptedMinAmountOut: "1" });
    assert.equal(second.firstBuy!.minAmountOut, "990"); assert.equal(second.requiresReconfirmation, false);
    assert.equal(second.prepared!.createParams.salt, first.prepared!.createParams.salt);
    time += 1000; expected = 980n;
    const adverse = await service.prepare(f.plan.draft, creator, CURVE_POLICY, input, { intentId: first.intentId, previousPlanId: second.id });
    assert.equal(adverse.requiresReconfirmation, true); assert.equal(adverse.firstBuy!.minAmountOut, "990");
    await assert.rejects(() => service.validateLaunch(creator, adverse.data), /accepted minimum/);
    const displayed = minimumOutput(980n, 100).toString();
    expected = 979n; time += 1000;
    const accepted = await service.prepare(f.plan.draft, creator, CURVE_POLICY, input,
      { intentId: first.intentId, previousPlanId: adverse.id, reconfirmPrice: true, reconfirmedMinimumOut: displayed });
    assert.equal(accepted.firstBuy!.minAmountOut, displayed); assert.equal(accepted.requiresReconfirmation, false);
    assert.equal(accepted.intentId, first.intentId); assert.equal(accepted.prepared!.createParams.salt, first.prepared!.createParams.salt);
    assert.equal((await service.validateLaunch(creator, accepted.data)).planId, accepted.id);
    await assert.rejects(() => service.prepare(f.plan.draft, creator, CURVE_POLICY, input,
      { intentId: "unrelated-intent", previousPlanId: accepted.id }), /same creator, intent/);
    await assert.rejects(() => service.prepare(f.plan.draft, token, CURVE_POLICY, input,
      { intentId: first.intentId, previousPlanId: accepted.id }), /same creator, intent/);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("payment proceeds may increase the paired input without lowering or ratcheting the accepted token minimum", async (context) => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "launch-payment-floor-test-")), store = new Store(directory, 31337);
  let expected = 1000n, time = Date.now();
  context.mock.method(Date, "now", () => time);
  context.mock.method(f.sdk, "getAirlockOwner", async () => treasury);
  context.mock.method(f.sdk.factory, "prepareCreateMulticurve", async (params: Parameters<typeof f.sdk.factory.prepareCreateMulticurve>[0]) => {
    const prepared = structuredClone(f.prepared);
    prepared.createParams = f.sdk.factory.encodeCreateMulticurveParams(params);
    prepared.devBuy.exactAmountIn = params.devBuy!.exactAmountIn;
    prepared.devBuy.simulatedAmountOut = expected;
    return prepared;
  });
  const config: RuntimeConfig = { mode: "fork", deploymentChainId: 4663, chainId: 31337, treasury, writesEnabled: true,
    blockReason: null, feePolicy: FEE_POLICY, launchGuard: guard, launchLockAvailable: true };
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config, secrets: { planAttestationKey: "k".repeat(32) } }, store, sdk: f.sdk,
    config: async () => config, assertNetwork: async () => {},
    openingValuation: async () => syntheticOpeningValuation(quote.address, "3000", { chainId: 4663, quotedAt: time }),
    client: { getCode: async () => "0x", readContract: async ({ functionName }: { functionName: string }) => ({ symbol: quote.symbol, decimals: quote.decimals,
      name: quote.name, totalSupply: 1n, paused: false, allowance: 0n }[functionName]) } }) as LaunchpadService;
  try {
    const reviewedInput = { amount: formatUnits(100n, quote.decimals), slippageBps: 100, lockDays: 0 };
    const beforePayment = await service.prepare(f.plan.draft, creator, CURVE_POLICY, reviewedInput, { intentId: "payment-launch-intent" });
    assert(verifyPlanAttestation(["k".repeat(32)], 4663, beforePayment.id, beforePayment.attestation), "prepared previews carry the platform attestation");
    const accepted = beforePayment.firstBuy!.acceptedMinAmountOut!;
    assert.equal(accepted, "990");
    const actualInput = { ...reviewedInput, amount: formatUnits(110n, quote.decimals) };
    // The actual conversion output differs from the reviewed minimum, so this
    // request deliberately has no previousPlanId (whose input must be exact).
    for (const output of [995n, 980n, 1500n]) {
      time += 61_000; expected = output;
      const funded = await service.prepare(f.plan.draft, creator, CURVE_POLICY, actualInput,
        { intentId: beforePayment.intentId, acceptedMinAmountOut: accepted });
      assert.equal(funded.intentId, beforePayment.intentId); assert.equal(funded.previousPlanId, undefined);
      assert.equal(funded.firstBuy!.amountIn, "110"); assert.equal(funded.approval!.amount, "110");
      assert.equal(funded.firstBuy!.acceptedMinAmountOut, accepted, "the reviewed token floor remains the same even if actual payment proceeds are better");
      const freshMinimum = minimumOutput(output, 100), protectedMinimum = freshMinimum > 990n ? freshMinimum : 990n;
      assert.equal(funded.firstBuy!.minAmountOut, String(protectedMinimum));
      const calldata = decodeFunctionData({ abi: launchGuardAbi, data: funded.data });
      assert.equal(calldata.functionName, "createAndBuy");
      assert.equal(calldata.args[1], 110n); assert.equal(calldata.args[2], protectedMinimum);
      assertRecoveryPlan(funded, contracts, f.sdk);
      if (output < 990n) {
        assert.equal(funded.requiresReconfirmation, true);
        await assert.rejects(() => service.validateLaunch(creator, funded.data), /accepted minimum/);
      } else {
        assert.equal(funded.requiresReconfirmation, false);
        assert.equal((await service.validateLaunch(creator, funded.data)).planId, funded.id);
      }
    }
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

const oracleRuntime = readFileSync(new URL("./fixtures/buyback-oracle.runtime.hex", import.meta.url), "utf8").trim() as Hex;
const bundlerRuntime = readFileSync(new URL("./fixtures/robinhood-bundler.runtime.hex", import.meta.url), "utf8").trim() as Hex;
assert.equal(keccak256(bundlerRuntime), ROBINHOOD_BUNDLER_CODE_HASH, "the recovery fixture is the pinned public Robinhood Bundler runtime");
function recoveryService(f: ReturnType<typeof ordinaryFixture> | ReturnType<typeof fixture>, store: Store,
  options: { treasury?: Address | null; owner?: Address; reads?: string[]; valuationHash?: Hex; referencePrice?: bigint;
    attestationKey?: string; previousAttestationKeys?: string[]; blockTimes?: Record<string, bigint>; manifest?: unknown;
    blockHashes?: Record<string, Hex>; finalized?: bigint } = {}) {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const sdk = f.sdk, reads = options.reads ?? [];
  (sdk as any).getMulticurvePool = async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey: f.poolKey }) });
  const valuation = f.plan.openingValuation!;
  return Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
    runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: 4663, writesEnabled: false,
      treasury: options.treasury === undefined ? treasury : options.treasury },
      secrets: { planAttestationKey: options.attestationKey, planAttestationPreviousKeys: options.previousAttestationKeys ?? [] } }, store, sdk,
    assertNetwork: async () => {}, client: {
      getTransaction: async () => { reads.push("transaction"); return f.tx; },
      getTransactionReceipt: async () => { reads.push("receipt"); return f.receipt; },
      getBlockNumber: async () => 11n,
      getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
        if (blockTag === "finalized") {
          reads.push("block:finalized");
          if (options.finalized === undefined) throw new Error("finalized tag unsupported");
          return { number: options.finalized, hash: blockHash, timestamp: nowSeconds };
        }
        reads.push(`block:${blockNumber}`);
        return { hash: options.blockHashes?.[String(blockNumber)] ??
          (blockNumber === BigInt(valuation.blockNumber) ? options.valuationHash ?? valuation.blockHash : blockHash),
          timestamp: options.blockTimes?.[String(blockNumber)] ?? nowSeconds };
      },
      readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
        reads.push(`${functionName}:${blockNumber ?? "latest"}`);
        // What the chain would report as the Airlock owner at any block.
        if (functionName === "owner") return options.owner ?? treasury;
        // The immutable oracle's mapped feed for the paired asset, 8 decimals.
        if (options.referencePrice !== undefined && functionName === "assetFeeds") return [guard, 86_400, quote.decimals, 8, false];
        if (options.referencePrice !== undefined && functionName === "latestRoundData") return [1n, options.referencePrice, 0n, nowSeconds - 10n, 1n];
        if (options.referencePrice !== undefined && functionName === "decimals") return 8;
        throw new Error("No independent reference in this fixture");
      },
      getCode: async () => options.referencePrice !== undefined ? oracleRuntime : undefined,
    },
    launchManifest: () => options.manifest ?? { ...ENGINE_MANIFEST, engineLaunchCutover: undefined },
  }) as LaunchpadService;
}

test("a missing server preview recovers from a matching frozen local backup while signing is paused", async () => {
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "missing-plan-recovery-test-")), store = new Store(directory, 31337);
  const reads: string[] = [], service = recoveryService(f, store, { reads });
  try {
    await assert.rejects(() => service.register(hash), /frozen local backup/);
    const corrupt = structuredClone(f.plan); corrupt.draft.symbol = "FAKE";
    await assert.rejects(() => service.register(hash, corrupt), /canonical creation parameters/);
    assert.equal(store.getPlan(f.plan.id), null);
    const record = await service.register(hash, f.plan);
    assert.equal(record.address, token); assert.equal(record.transactionHash, hash);
    assert(!reads.some((read) => read.startsWith("owner:")), "the protocol owner is proven by the creation itself, not a state read");
    assert.equal(store.getPlan(f.plan.id)?.id, f.plan.id);
    assert.equal((await service.register(hash)).transactionHash, hash);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("recovery lists only platform-approved fee routing, independent of the backup's self-consistency", async () => {
  // The backup is a fully consistent re-encoding of the real transaction, but
  // it pays treasury B while the platform's configured treasury is A.
  const platform = "0x5555555555555555555555555555555555555555" as Address;
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "untrusted-treasury-recovery-test-")), store = new Store(directory, 31337);
  const reads: string[] = [];
  let encodes = 0;
  const encode = f.sdk.factory.encodeCreateMulticurveParams.bind(f.sdk.factory);
  (f.sdk.factory as any).encodeCreateMulticurveParams = (params: any) => { encodes++; return encode(params); };
  try {
    assert.doesNotThrow(() => assertRecoveryPlan(f.plan, contracts, f.sdk), "the attacker's backup is self-consistent");
    encodes = 0;
    for (const configured of [platform, null]) {
      const service = recoveryService(f, store, { treasury: configured, reads });
      await assert.rejects(() => service.register(hash, f.plan), /platform-approved treasury/);
    }
    assert.equal(encodes, 0, "the trusted registry rejects before any SDK re-encoding");
    assert(!reads.some((read) => read.startsWith("owner") || read.startsWith("block")), "and before historical reads");
    assert.equal(store.getPlan(f.plan.id), null); assert.equal(store.tokenByTxHash(hash), null);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("recovery rejects a backup whose transaction or price snapshot does not match chain evidence", async () => {
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-evidence-test-")), store = new Store(directory, 31337);
  const reads: string[] = [];
  try {
    const other = structuredClone(f.plan);
    other.data = `${other.data}00` as Hex; other.id = keccak256(other.data);
    await assert.rejects(() => recoveryService(f, store, { reads }).register(hash, other), /outer transaction/);
    assert.deepEqual(reads.filter((read) => !["receipt", "transaction"].includes(read)), [], "calldata mismatch costs no further reads");
    await assert.rejects(() => recoveryService(f, store, { valuationHash: `0x${"cd".repeat(32)}` }).register(hash, f.plan),
      /anchored to a canonical block/, "the price snapshot must name a canonical block");
    const early = { ...f, receipt: { ...f.receipt, blockNumber: 0n } };
    await assert.rejects(() => recoveryService(early, store).register(hash, early.plan), /newer than its creation receipt/);
    assert.equal(store.tokenByTxHash(hash), null);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("an Airlock owner change after creation, even later in the same block, cannot block a correct backup", async () => {
  // The creation paid the owner at that point in the block (treasury). A later
  // transfer in the same block makes every block-level read report another owner.
  for (const reported of [creator, "0x5555555555555555555555555555555555555555" as Address]) {
    const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-owner-change-test-")), store = new Store(directory, 31337);
    const reads: string[] = [];
    try {
      const record = await recoveryService(f, store, { owner: reported, reads }).register(hash, f.plan);
      assert.equal(record.address, token);
      assert(!reads.some((read) => read.startsWith("owner:")), "no block-level owner state is consulted");
    } finally { store.close(); rmSync(directory, { recursive: true }); }
  }
});

test("reference divergence is reported for operators above 5% but never blocks a verified recovery", async (context) => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  // The backup priced WETH at $3000; the immutable oracle's feed reads the price below (8 decimals).
  const recover = async (feedUsd: bigint) => {
    const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-reference-test-")), store = new Store(directory, 31337);
    warnings.length = 0;
    try { return await recoveryService(f, store, { referencePrice: feedUsd * 10n ** 8n }).register(hash, f.plan); }
    finally { store.close(); rmSync(directory, { recursive: true }); }
  };
  assert.equal((await recover(3010n)).address, token); assert.deepEqual(warnings, [], "within the review threshold is silent");
  for (const feedUsd of [2500n, 1000n, 30n]) {
    assert.equal((await recover(feedUsd)).address, token, `${feedUsd}: the price comparison is advisory`);
    const entry: { event: string; divergenceBps: number; transactionHash: string } | undefined = warnings
      .map((line) => JSON.parse(line)).find((row: { event: string }) => row.event === "recovery_reference_divergence");
    assert(entry && entry.divergenceBps > 500 && entry.transactionHash === hash, JSON.stringify(warnings));
  }
});

test("a recovered launch is listed as platform-verified only with a valid platform attestation over its preview", async () => {
  const current = "k".repeat(32), previous = "p".repeat(32);
  const recover = async (attest: ((id: Hex) => Hex) | undefined, options: { attestationKey?: string; previousAttestationKeys?: string[] } = { attestationKey: current }) => {
    const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-attestation-test-")), store = new Store(directory, 31337);
    try {
      const backup = { ...structuredClone(f.plan), ...(attest ? { attestation: attest(f.plan.id) } : {}) };
      const record = await recoveryService(f, store, options).register(hash, backup);
      return { record, stored: store.getPlan(f.plan.id), id: f.plan.id };
    } finally { store.close(); rmSync(directory, { recursive: true }); }
  };
  const signed = await recover((id) => planAttestation(current, 4663, id));
  assert.equal(signed.record.openingValuationUnverified, undefined); assert.equal(signed.stored?.attestation, planAttestation(current, 4663, signed.id));
  assert.equal((await recover((id) => planAttestation(previous, 4663, id), { attestationKey: current, previousAttestationKeys: [previous] })).record.openingValuationUnverified,
    undefined, "a backup signed before a key rotation stays verified");
  for (const [label, attest, options] of [
    ["missing", undefined, { attestationKey: current }],
    ["forged", () => `0x${"ab".repeat(32)}` as Hex, { attestationKey: current }],
    ["other chain", (id: Hex) => planAttestation(current, 8453, id), { attestationKey: current }],
    ["service without keys", (id: Hex) => planAttestation(current, 4663, id), {}],
  ] as const) {
    const unverified = await recover(attest, options);
    assert.equal(unverified.record.address, token, `${label}: the verified creation still registers`);
    assert.equal(unverified.record.openingValuationUnverified, true, `${label}: but its opening valuation is not claimed as verified`);
  }
});

test("after a recorded engine cutover, treasury-only launches recover only within the signing window and prepare refuses new ones", async () => {
  const cutoverAt = 1_900_000_000n;
  const manifest = (hashOf: Hex = blockHash, at = cutoverAt) => activatedEngineManifest(guard, { blockNumber: "5", blockHash: hashOf, timestamp: Number(at) }, "5");
  const recover = async (receiptTime: bigint, cutoverHash?: Hex) => {
    const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-cutover-test-")), store = new Store(directory, 31337);
    try {
      return await recoveryService(f, store, { manifest: manifest(cutoverHash), blockTimes: { "5": cutoverAt, "10": receiptTime } }).register(hash, f.plan)
        .catch((error: Error) => error);
    } finally { store.close(); rmSync(directory, { recursive: true }); }
  };
  assert.equal(((await recover(cutoverAt + 359n)) as TokenRecord).address, token, "mined within the signing window after the cutover");
  assert.match(((await recover(cutoverAt + 360n)) as Error).message, /platform-approved/, "a later treasury-only launch bypasses the engine");
  assert.match(((await recover(cutoverAt, `0x${"cd".repeat(32)}`)) as Error).message, /not a canonical block/, "the recorded cutover must be canonical");
  const config: RuntimeConfig = { mode: "fork", deploymentChainId: 4663, chainId: 31337, treasury, writesEnabled: true, blockReason: null, feePolicy: FEE_POLICY };
  const prepareWith = (at: bigint) => Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config }, config: async () => config,
    assertNetwork: async () => {}, client: { getCode: async () => "0x" }, launchManifest: () => manifest(blockHash, at) }) as LaunchpadService;
  const draft = { name: "After cutover", symbol: "LATE", description: "", image: "", quoteAddress: quote.address, tradingFeeBps: 100 };
  const passed = prepareWith(BigInt(Math.floor(Date.now() / 1000) - 60));
  await assert.rejects(() => passed.prepare(draft, creator, CURVE_POLICY, { amount: "0", slippageBps: 100, lockDays: 0 }), /route fees through the buyback engine/);
  await assert.rejects(() => passed.preflightFirstBuyPayment(quote.address), /route fees through the buyback engine/);
  const malformed = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, { runtime: { config }, config: async () => config,
    assertNetwork: async () => {}, client: { getCode: async () => "0x" },
    launchManifest: () => { const value = manifest(blockHash, BigInt(Math.floor(Date.now() / 1000) + 3600));
      return { ...value, engineLaunchCutover: { ...value.engineLaunchCutover!, graphFingerprint: "0x" } }; } }) as LaunchpadService;
  await assert.rejects(() => malformed.prepare(draft, creator, CURVE_POLICY, { amount: "0", slippageBps: 100, lockDays: 0 }), /cutover is malformed/,
    "a malformed cutover stops treasury-only previews instead of being ignored");
  // Before the cutover, treasury-only previews continue (this stub then fails at the asset read).
  await assert.rejects(() => prepareWith(BigInt(Math.floor(Date.now() / 1000) + 3600)).prepare(draft, creator, CURVE_POLICY, { amount: "0", slippageBps: 100, lockDays: 0 }),
    (error: Error) => !/buyback engine/.test(error.message));
});

test("recovery stores the normalized draft and only known preview fields", async () => {
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-normalized-test-")), store = new Store(directory, 31337);
  try {
    const backup = structuredClone(f.plan) as LaunchPlan & { junk?: string };
    backup.draft.symbol = "guard"; backup.junk = "x".repeat(10_000);
    const record = await recoveryService(f, store).register(hash, backup);
    assert.equal(record.symbol, "GUARD", "the listed symbol matches the on-chain normalized symbol");
    const saved = store.getPlan(f.plan.id) as LaunchPlan & { junk?: string };
    assert.equal(saved.draft.symbol, "GUARD"); assert.equal(saved.junk, undefined);
    assert.equal(store.tokenByTxHash(hash)?.symbol, "GUARD");
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("concurrent recoveries of one transaction share verification and capacity refusals stay retryable", async () => {
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-coalesce-test-")), store = new Store(directory, 31337);
  const reads: string[] = [];
  try {
    const service = recoveryService(f, store, { reads });
    const results = await Promise.all(Array.from({ length: 10 }, () => service.register(hash, f.plan)));
    assert(results.every((result) => result.address === token));
    assert.equal(reads.filter((read) => read === "receipt").length, 1, "identical concurrent requests verify once");
    const busyDirectory = mkdtempSync(join(tmpdir(), "recovery-busy-test-")), busyStore = new Store(busyDirectory, 31337);
    try {
      const busy = recoveryService(f, busyStore);
      (busy as any).recoveryLoad = { active: 4, started: [] };
      await assert.rejects(() => busy.register(hash, f.plan), /capacity is temporarily limited/);
      (busy as any).recoveryLoad = { active: 0, started: Array.from({ length: 60 }, () => Date.now()) };
      await assert.rejects(() => busy.register(hash, f.plan), /capacity is temporarily limited/);
      assert.equal(busyStore.tokenByTxHash(hash), null);
    } finally { busyStore.close(); rmSync(busyDirectory, { recursive: true }); }
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("altered backups fail before the shared budget and never delay the correct backup for the same transaction", async () => {
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-two-stage-test-")), store = new Store(directory, 31337);
  const reads: string[] = [];
  try {
    const service = recoveryService(f, store, { reads });
    for (let i = 0; i < 20; i++) {
      const variant = structuredClone(f.plan); variant.draft.name = `unproven ${i}`;
      await assert.rejects(() => service.register(hash, variant), /canonical creation parameters/);
    }
    assert.equal((service as any).recoveryLoad, undefined, "re-encoding failures spend none of the shared RPC budget");
    assert(!reads.some((read) => read.startsWith("block:")), "and read no chain evidence");
    assert.equal((await service.register(hash, f.plan)).transactionHash, hash, "the correct backup recovers immediately afterwards");
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("chain evidence is verified once per transaction for every backup that re-encodes it, and definitive failures are cached", async () => {
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-evidence-cache-test-")), store = new Store(directory, 31337);
  const reads: string[] = [];
  const valuationBlock = `block:${f.plan.openingValuation!.blockNumber}`;
  try {
    // The valuation block is not canonical: a definitive evidence failure.
    const service = recoveryService(f, store, { reads, valuationHash: `0x${"cd".repeat(32)}` });
    // Backups that differ only in fields the calldata does not encode still re-encode the transaction.
    const variants = Array.from({ length: 5 }, (_, i) => ({ ...structuredClone(f.plan), gas: String(1000 + i) }));
    for (const variant of variants) await assert.rejects(() => service.register(hash, variant), /anchored to a canonical block/);
    assert.equal(reads.filter((read) => read === valuationBlock).length, 1, "one anchor check serves every equivalent backup");
    assert.equal((service as any).recoveryLoad, undefined, "a contradicted anchor is refused before the shared budget");
    await Promise.all(variants.map((variant) => assert.rejects(() => service.register(hash, { ...variant, gas: "concurrent" }), /anchored/)));
    assert.equal(reads.filter((read) => read === valuationBlock).length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
  // A capacity refusal is not cached: the next request competes again.
  const g = ordinaryFixture(100), second = mkdtempSync(join(tmpdir(), "recovery-evidence-budget-test-")), other = new Store(second, 31337);
  try {
    const busy = recoveryService(g, other);
    (busy as any).recoveryLoad = { active: 4, started: [] };
    await assert.rejects(() => busy.register(hash, g.plan), /capacity is temporarily limited/);
    (busy as any).recoveryLoad = { active: 0, started: [] };
    assert.equal((await busy.register(hash, g.plan)).transactionHash, hash);
  } finally { other.close(); rmSync(second, { recursive: true }); }
});

test("a recovery retried after its token failed to save is still a backup: verified again, attested only by HMAC, never signable", async () => {
  const key = "k".repeat(32), other = "0x5555555555555555555555555555555555555555" as Address;
  const failFirstTokenSave = (store: Store) => {
    const save = store.saveToken.bind(store);
    let failed = false;
    store.saveToken = (record: TokenRecord) => { if (!failed) { failed = true; throw new Error("token store unavailable"); } return save(record); };
  };
  for (const retryWith of ["no backup", "the same backup"] as const) {
    const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-retry-provenance-test-")), store = new Store(directory, 31337);
    try {
      failFirstTokenSave(store);
      const service = recoveryService(f, store, { attestationKey: key });
      await assert.rejects(() => service.register(hash, f.plan), /token store unavailable/);
      assert.equal(store.getPlan(f.plan.id)?.recovered, true, "the stored preview remembers it came from a backup");
      await assert.rejects(() => service.validateLaunch(creator, f.plan.data), /restored from a backup/);
      const backup = retryWith === "the same backup" ? f.plan : undefined;
      await assert.rejects(() => recoveryService(f, store, { attestationKey: key, treasury: other }).register(hash, backup), /platform-approved/,
        `${retryWith}: the retry runs recovery verification again`);
      const record = await service.register(hash, backup);
      assert.equal(record.openingValuationUnverified, true, `${retryWith}: an unattested opening valuation is not claimed as verified`);
      assert.equal(store.tokenByTxHash(hash)?.openingValuationUnverified, true);
      // Reconciliation removes a token whose block was reorganized, then registers it again from the stored preview.
      store.removeToken(hash);
      assert.equal((await service.register(hash)).openingValuationUnverified, true, `${retryWith}: still unverified after re-registration`);
      assert.equal(store.tokenByTxHash(hash)?.openingValuationUnverified, true);
    } finally { store.close(); rmSync(directory, { recursive: true }); }
  }
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-retry-attested-test-")), store = new Store(directory, 31337);
  try {
    failFirstTokenSave(store);
    const service = recoveryService(f, store, { attestationKey: key });
    await assert.rejects(() => service.register(hash, { ...structuredClone(f.plan), attestation: planAttestation(key, 4663, f.plan.id) }), /token store unavailable/);
    assert.equal((await service.register(hash, structuredClone(f.plan))).openingValuationUnverified, undefined,
      "an attestation verified on the first attempt still counts when the retried copy lacks it");
    assert.equal(store.getPlan(f.plan.id)?.attestation, planAttestation(key, 4663, f.plan.id));
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("an unattested backup registered first cannot keep a launch unverified once its attestation is proven", async () => {
  const key = "k".repeat(32), previous = "p".repeat(32);
  for (const order of ["unattested first", "attested first"] as const) {
    const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-provenance-order-test-")), store = new Store(directory, 31337);
    try {
      const service = recoveryService(f, store, { attestationKey: key });
      const attested = { ...structuredClone(f.plan), attestation: planAttestation(key, 4663, f.plan.id) };
      const stripped = structuredClone(f.plan);
      const [first, second] = order === "unattested first" ? [stripped, attested] : [attested, stripped];
      await service.register(hash, first);
      const response = await service.register(hash, second);
      assert.equal(store.tokenByTxHash(hash)?.openingValuationUnverified, undefined, `${order}: the listed launch is verified`);
      assert.equal(response.openingValuationUnverified, undefined, `${order}: the response matches what is listed`);
    } finally { store.close(); rmSync(directory, { recursive: true }); }
  }
  // A launch recovered while its attestation key was not retained becomes verified once the key is restored.
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-provenance-rotation-test-")), store = new Store(directory, 31337);
  try {
    const backup = { ...structuredClone(f.plan), attestation: planAttestation(previous, 4663, f.plan.id) };
    assert.equal((await recoveryService(f, store, { attestationKey: key }).register(hash, backup)).openingValuationUnverified, true);
    // Meanwhile anyone registers the same launch with a stripped or forged copy: the stored attestation stays.
    const gap = recoveryService(f, store, { attestationKey: key });
    await gap.register(hash, structuredClone(f.plan));
    await gap.register(hash, { ...structuredClone(f.plan), attestation: `0x${"ab".repeat(32)}` });
    assert.equal(store.getPlan(f.plan.id)?.attestation, backup.attestation);
    const restored = recoveryService(f, store, { attestationKey: key, previousAttestationKeys: [previous] });
    assert.equal((await restored.register(hash)).openingValuationUnverified, undefined, "the stored backup's attestation now verifies");
    assert.equal(store.tokenByTxHash(hash)?.openingValuationUnverified, undefined);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
  // A stripped copy racing the attested one cannot drop the stored attestation, so a later re-registration
  // after a reorganization removes the token still lists it verified.
  const g = ordinaryFixture(100), second = mkdtempSync(join(tmpdir(), "recovery-provenance-race-test-")), other = new Store(second, 31337);
  try {
    const service = recoveryService(g, other, { attestationKey: key });
    const attested = { ...structuredClone(g.plan), attestation: planAttestation(key, 4663, g.plan.id) };
    await Promise.all([service.register(hash, structuredClone(g.plan)), service.register(hash, attested), service.register(hash, structuredClone(g.plan))]);
    assert.equal(other.getPlan(g.plan.id)?.attestation, attested.attestation);
    other.removeToken(hash);
    assert.equal((await service.register(hash)).openingValuationUnverified, undefined);
    assert.equal(other.tokenByTxHash(hash)?.openingValuationUnverified, undefined);
  } finally { other.close(); rmSync(second, { recursive: true }); }
});

test("recovery evidence is keyed by the receipt block, and an anchor rejection is kept long only once the anchor block is final", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-evidence-block-test-")), store = new Store(directory, 31337);
  const reads: string[] = [], valuationBlock = `block:${f.plan.openingValuation!.blockNumber}`;
  // The price anchor is block 1 and the receipt block 10.
  const options: NonNullable<Parameters<typeof recoveryService>[2]> = { reads, valuationHash: `0x${"cd".repeat(32)}`, finalized: 0n };
  const anchorReads = () => reads.filter((read) => read === valuationBlock).length;
  try {
    const service = recoveryService(f, store, options);
    await assert.rejects(() => service.register(hash, f.plan), /anchored to a canonical block/);
    await assert.rejects(() => service.register(hash, f.plan), /anchored/);
    assert.equal(anchorReads(), 1, "a rejection is shared briefly");
    context.mock.timers.tick(15_000);
    await assert.rejects(() => service.register(hash, f.plan), /anchored/);
    assert.equal(anchorReads(), 2, "before the anchor block is final, a rejection (perhaps from a lagging node) is checked again");
    // The chain converges on the backup's anchor before it is final: the evidence holds and registers.
    options.valuationHash = undefined;
    context.mock.timers.tick(15_000);
    assert.equal((await service.register(hash, f.plan)).address, token);
    // The same transaction re-mined in another block is a new evidence key, checked afresh.
    const reorganized = `0x${"ee".repeat(32)}` as Hex;
    f.receipt = { ...f.receipt, blockHash: reorganized }; options.blockHashes = { "10": reorganized };
    const evidence = () => (service as any).recoveryChecks.size;
    const keys = evidence();
    assert.equal((await service.register(hash, f.plan)).address, token);
    assert.equal(evidence(), keys + 1, "the new receipt block is a new key");
    assert.equal((service as any).recoveryLoad.started.length, 2, "the budget was spent only for real evidence checks");
  } finally { store.close(); rmSync(directory, { recursive: true }); }
  // An anchor contradicted at a finalized block cannot change and is kept for ten minutes.
  const g = ordinaryFixture(100), second = mkdtempSync(join(tmpdir(), "recovery-evidence-final-test-")), other = new Store(second, 31337);
  const finalReads: string[] = [];
  try {
    const service = recoveryService(g, other, { reads: finalReads, valuationHash: `0x${"cd".repeat(32)}`, finalized: 1n });
    await assert.rejects(() => service.register(hash, g.plan), /anchored/);
    context.mock.timers.tick(300_000);
    await assert.rejects(() => service.register(hash, g.plan), /anchored/);
    assert.equal(finalReads.filter((read) => read === valuationBlock).length, 1, "kept, not re-read every 15 seconds");
    assert.equal((service as any).recoveryLoad, undefined, "and never spent the shared budget");
  } finally { other.close(); rmSync(second, { recursive: true }); }
});

test("a transaction that never created the token through the official Airlock, or prices after its receipt, spends no recovery budget", async () => {
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-fake-transaction-test-")), store = new Store(directory, 31337);
  const reads: string[] = [];
  try {
    // Same calldata sent to the Airlock address, but no Create event from it (e.g. a call that created nothing).
    const fake = { ...f, receipt: { ...f.receipt, logs: f.receipt.logs.filter((log) => log.address.toLowerCase() !== contracts.airlock.toLowerCase()) } };
    const service = recoveryService(fake, store, { reads });
    for (let i = 0; i < 20; i++) await assert.rejects(() => service.register(hash, fake.plan), /creation event does not match/);
    const early = { ...f, receipt: { ...f.receipt, blockNumber: 0n } };
    const earlyService = recoveryService(early, store, { reads });
    for (let i = 0; i < 20; i++) await assert.rejects(() => earlyService.register(hash, early.plan), /newer than its creation receipt/);
    assert.equal((service as any).recoveryLoad, undefined); assert.equal((earlyService as any).recoveryLoad, undefined, "no shared budget is spent");
    assert(!reads.some((read) => read.startsWith("block:")), "and no chain evidence is read");
    // A launch made through the official Airlock but naming a wrong price anchor costs one shared block read, no budget.
    const anchorService = recoveryService(f, store, { reads, valuationHash: `0x${"cd".repeat(32)}`, finalized: 0n });
    for (let i = 0; i < 20; i++) await assert.rejects(() => anchorService.register(hash, f.plan), /anchored to a canonical block/);
    assert.equal((anchorService as any).recoveryLoad, undefined);
    assert.equal(reads.filter((read) => read === `block:${f.plan.openingValuation!.blockNumber}`).length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("a nonempty fake guard is refused before its reverting bundler read, sharing ten minutes without more budget", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-guard-mismatch-test-")), store = new Store(directory, 31337);
  try {
    const service = recoveryService(f, store);
    const client = (service as any).client;
    const read = client.readContract;
    let guardReads = 0, dependencyReads = 0;
    client.getCode = async ({ address }: { address: Address }) => {
      if (address.toLowerCase() !== guard.toLowerCase()) return undefined;
      guardReads++; return "0x60006000";
    };
    client.readContract = async (call: { functionName: string }) => {
      if (!["bundler", "airlock", "poolManager"].includes(call.functionName)) return read(call);
      dependencyReads++;
      throw new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: launchGuardAbi, functionName: "bundler" }),
        { abi: launchGuardAbi, functionName: "bundler", args: [], contractAddress: guard });
    };
    const guarded = { ...f.plan, firstBuy: { guard, lockDays: 0 } } as unknown as LaunchPlan;
    const verify = () => (service as any).recoveryEvidence(hash, guarded, { blockNumber: 10n, blockHash });
    await assert.rejects(verify, /launch guard runtime or official dependencies/);
    assert.equal(dependencyReads, 0, "foreign nonempty code is already proof; its reverting getters are never read");
    context.mock.timers.tick(300_000);
    await assert.rejects(verify, /launch guard runtime/);
    assert.equal(guardReads, 1, "kept for ten minutes, not re-checked every 15 seconds");
    // Other transactions through the same guard share its verdict before the budget.
    const started = (service as any).recoveryLoad.started.length;
    for (let i = 0; i < 15; i++) {
      const other = { ...guarded, firstBuy: { ...guarded.firstBuy!, lockDays: i % 2 ? 30 : 0 } };
      await assert.rejects(() => (service as any).recoveryEvidence(`0x${String(i).padStart(64, "f")}`, other, { blockNumber: 10n, blockHash }), /launch guard runtime/);
    }
    assert.equal(guardReads, 1); assert.equal((service as any).recoveryLoad.started.length, started, "no budget is spent on them");
    context.mock.timers.tick(300_001);
    await assert.rejects(verify, /launch guard runtime/);
    assert.equal(guardReads, 2);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("a pinned guard with unavailable code or dependencies retries full registration after fifteen seconds", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const abi = parseAbi(["function bundler() view returns(address)"]);
  const reverted = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, functionName: "bundler" }),
    { abi, functionName: "bundler", args: [], contractAddress: guard });
  const empty = new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "bundler" }),
    { abi, functionName: "bundler", args: [], contractAddress: guard });
  const transport = new HttpRequestError({ url: "https://rpc.example", status: 503 });
  for (const label of ["missing guard", "empty guard", "guard code transport", "guard getter revert", "guard getter no data",
    "missing official code", "foreign official code", "official getter revert", "official getter no data", "wrong official dependency"]) {
    await context.test(label, async () => {
      const f = fixture(), directory = mkdtempSync(join(tmpdir(), "recovery-guard-transient-test-")), store = new Store(directory, 31337);
      try {
        const service = recoveryService(f, store), client = (service as any).client, read = client.readContract;
        let fault = true, codeReads = 0;
        client.getCode = async ({ address }: { address: Address }) => {
          codeReads++;
          if (address.toLowerCase() === guard.toLowerCase()) {
            if (fault && label === "missing guard") return undefined;
            if (fault && label === "empty guard") return "0x";
            if (fault && label === "guard code transport") throw transport;
            return expectedGuardRuntime();
          }
          if (address.toLowerCase() === ROBINHOOD_BUNDLER.toLowerCase()) {
            if (fault && label === "missing official code") return undefined;
            if (fault && label === "foreign official code") return "0x60006000";
            return bundlerRuntime;
          }
          return undefined;
        };
        client.readContract = async (call: { address: Address; functionName: string }) => {
          const address = call.address.toLowerCase();
          if (address === guard.toLowerCase()) {
            if (fault && label === "guard getter revert") throw reverted;
            if (fault && label === "guard getter no data") throw empty;
            return ROBINHOOD_BUNDLER;
          }
          if (address === ROBINHOOD_BUNDLER.toLowerCase()) {
            if (fault && label === "official getter revert") throw reverted;
            if (fault && label === "official getter no data") throw empty;
            if (fault && label === "wrong official dependency") return zeroAddress;
            return call.functionName === "airlock" ? contracts.airlock : contracts.poolManager;
          }
          if (address === contracts.rehype.toLowerCase()) return ROBINHOOD_BUNDLER;
          return read(call);
        };
        const failed = await service.register(hash, f.plan).catch((error: unknown) => error);
        assert(failed instanceof Error); assert(!(failed instanceof LaunchGuardMismatch));
        assert.equal((service as any).guardMismatches.size, 0);
        assert.equal((service as any).recoveryChecks.get(`${hash}:${blockHash}`).ttl, 15_000);
        fault = false;
        const previousReads = codeReads;
        await assert.rejects(() => service.register(hash, f.plan));
        assert.equal(codeReads, previousReads, "immediate retry shares the brief failure");
        context.mock.timers.tick(15_000);
        assert.equal((await service.register(hash, f.plan)).address, token, "the original frozen backup registers after RPC state converges");
        assert.equal(store.tokenByTxHash(hash)?.address, token);
        assert.equal((service as any).recoveryLoad.started.length, 2);
      } finally { store.close(); rmSync(directory, { recursive: true }); }
    });
  }
});

test("a pinned legacy runtime lacking lock support is not a fake guard mismatch", async () => {
  let dependencyReads = 0;
  const client = { getBlockNumber: async () => 10n, getCode: async () => expectedGuardRuntime(4663, "legacy"),
    readContract: async () => { dependencyReads++; throw new Error("getters should not be needed to know the version"); } } as unknown as Parameters<typeof verifyLaunchGuard>[0];
  const failure = await verifyLaunchGuard(client, guard, 4663, "vesting").catch((error: unknown) => error);
  assert(failure instanceof Error); assert(!(failure instanceof LaunchGuardMismatch));
  assert.equal(dependencyReads, 0);
});

test("evidence read across a reorganization is not kept for the receipt block it did not see", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-evidence-reorg-test-")), store = new Store(directory, 31337);
  const reads: string[] = [], valuationBlock = `block:${f.plan.openingValuation!.blockNumber}`;
  try {
    // The receipt names block 10 as 0xbb…, but by the time evidence is read the chain reports another block 10.
    const service = recoveryService(f, store, { reads, blockHashes: { "10": `0x${"ee".repeat(32)}` } });
    await assert.rejects(() => service.register(hash, f.plan), /reorganized/);
    (service as any).client.getBlock = (recoveryService(f, store, { reads }) as any).client.getBlock;
    context.mock.timers.tick(15_000);
    assert.equal((await service.register(hash, f.plan)).address, token);
    assert.equal((service as any).recoveryLoad.started.length, 2, "no verdict was kept for the receipt block those reads did not see");
    assert(reads.filter((read) => read === valuationBlock).length >= 2);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("a recorded cutover is re-verified until final, so a reorganized cutover block stops being trusted", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const cutoverAt = 1_900_000_000n;
  const manifest = activatedEngineManifest(guard, { blockNumber: "5", blockHash, timestamp: Number(cutoverAt) }, "5");
  const f = ordinaryFixture(100), directory = mkdtempSync(join(tmpdir(), "recovery-cutover-final-test-")), store = new Store(directory, 31337);
  const reads: string[] = [];
  const options: NonNullable<Parameters<typeof recoveryService>[2]> = { reads, manifest, blockTimes: { "5": cutoverAt, "10": cutoverAt + 100n }, finalized: 4n };
  const cutoverReads = () => reads.filter((read) => read === "block:5").length;
  try {
    const service = recoveryService(f, store, options);
    assert.equal((await service.register(hash, f.plan)).address, token);
    assert.equal((await service.register(hash, f.plan)).address, token);
    assert.equal(cutoverReads(), 1, "a canonical cutover that is not final yet is reused only briefly");
    context.mock.timers.tick(15_000);
    options.blockHashes = { "5": `0x${"cd".repeat(32)}` };
    await assert.rejects(() => service.register(hash, f.plan), /not a canonical block/, "a reorganized cutover is noticed");
    options.blockHashes = undefined; options.finalized = 5n;
    assert.equal((await service.register(hash, f.plan)).address, token);
    const settled = cutoverReads();
    context.mock.timers.tick(3_600_000);
    assert.equal((await service.register(hash, f.plan)).address, token);
    assert.equal(cutoverReads(), settled, "a finalized cutover is not read again");
    // An RPC without the finalized tag keeps re-verifying it.
    const unsupported = recoveryService(f, store, { ...options, finalized: undefined, reads });
    for (let i = 0; i < 2; i++) { await unsupported.register(hash, f.plan); context.mock.timers.tick(15_000); }
    assert.equal(cutoverReads(), settled + 2);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("final simulation accepts outputs within the signed minimum instead of exact preview equality", async () => {
  const f = fixture(); let output = 995n;
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
    validateLaunch: async () => ({ valid: true }), assertNetwork: async () => {},
    store: { findPlan: async () => f.plan },
    client: { readContract: async () => 100n, estimateGas: async () => 200_000n,
      simulateContract: async () => ({ result: [token, f.poolKey, treasury, treasury, output] }) },
  }) as LaunchpadService;
  assert.equal((await service.simulateLaunch(creator, f.plan.data)).amountOut, "995");
  output = 1001n; assert.equal((await service.simulateLaunch(creator, f.plan.data)).amountOut, "1001");
  output = 989n; await assert.rejects(() => service.simulateLaunch(creator, f.plan.data), /accepted minimum/);
});

test("validation and simulation previews do not permanently protect abandoned plans", async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "unsigned-plan-lifetime-")), store = new Store(directory,31337);
  const config: RuntimeConfig = {mode:"fork",deploymentChainId:4663,chainId:31337,writesEnabled:true,blockReason:null,
    treasury,launchGuard:guard,curvePolicy:CURVE_POLICY,feePolicy:FEE_POLICY};
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {runtime:{config},store,config:async()=>config}) as LaunchpadService;
  try {
    store.savePlan(f.plan);
    await service.validateLaunch(creator,f.plan.data);
    store.cleanup(Date.now()+31*86400000);
    assert.equal(store.getPlan(f.plan.id),null,"read-only validation must not disable unsigned TTL cleanup");
    store.savePlan(f.plan);
    await service.validateLaunch(creator,f.plan.data,true);
    store.cleanup(Date.now()+31*86400000);
    assert(store.getPlan(f.plan.id),"wallet handoff can have an unknown outcome and must preserve its frozen plan");
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test("old confirmed receipts slow down when finality is unavailable without being marked finalized", async () => {
  let finalized = false, retryAt = 0;
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
    assertNetwork: async () => {},
    store: { pendingLaunches: async () => [{ hash, status: "confirmed", blockHash }],
      tokenByTxHash: async () => ({ blockNumber: "10", createdAt: Date.now() - 2 * 86_400_000 }),
      deferLaunch: async (_hash: string, at: number) => { retryAt = at; },
      finalizeLaunch: async () => { finalized = true; } },
    client: { getBlockNumber: async () => 100n, getBlock: async (input: { blockTag?: string }) => {
      if (input.blockTag === "finalized") throw new Error("unsupported block tag"); return { hash: blockHash };
    } },
  }) as LaunchpadService;
  await service.reconcile(); assert.equal(finalized, false);
  assert(retryAt >= Date.now() + 3_599_000);
});
