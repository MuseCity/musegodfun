import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DopplerSDK, airlockAbi, bundlerAbi, computePoolId, verifyPreparedCreateExecution } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, http, encodeFunctionData, encodeEventTopics, encodeAbiParameters, decodeAbiParameters, parseAbiParameters, erc20Abi, formatUnits, keccak256, zeroAddress, type Hex, type Address, type TransactionReceipt } from "viem";
import { ROBINHOOD_BUNDLER, ROBINHOOD_CONTRACTS as contracts, ROBINHOOD_STOCKS, STOCKS, SUPPLY, assetsFor, launchAssetsFor, listedTokens, stockByAddress, type RuntimeConfig, type Stock, type TokenRecord } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { restorePrepared, serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { buildLaunch } from "../src/lib/protocol";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import { minimumOutput } from "../src/lib/validation";
import { syntheticOpeningValuation } from "./fixtures";
import { OPENING_CAP_USD, openingCapInQuote, type HistoricalOpeningValuation } from "../src/lib/opening-valuation";
import { assertPlanIntegrity, verifiedFirstBuyLock, verifyGuardedReceipt } from "../server/launch-verification";
import { chainLaunchDependencies, expectedGuardRuntime, identifyGuardVersion, verifyLaunchGuard } from "../server/launch-guard";
import { LaunchpadService } from "../server/service";
import { Store } from "../server/store";
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
  ] } as unknown as TransactionReceipt;
  const tx = { hash, from: creator, to: guard, input: plan.data, value: 0n };
  return { plan, prepared, receipt, tx, guardLog, poolKey };
}

function historicalFixture(quotedAt = Date.now()) {
  const f = fixture();
  const legacy: HistoricalOpeningValuation = { policy: "fixed-usd-5000-v1", marketCapUsd: OPENING_CAP_USD,
    chainId: 4663, quoteAddress: quote.address, quotePriceUsd: "3000", quotedAt, expiresAt: quotedAt + 300_000,
    source: "Chainlink", sourceUpdatedAt: quotedAt, blockNumber: "10", blockHash, feed: treasury };
  const factoryDataAbi = parseAbiParameters("string name,string symbol,uint256 yearlyMintRate,uint256 vestingDuration,address[] vestingRecipients,uint256[] vestingAmounts,string tokenURI");
  const decoded = decodeAbiParameters(factoryDataAbi, f.prepared.createParams.tokenFactoryData);
  const metadata = JSON.parse(decodeURIComponent(decoded[6].slice("data:application/json,".length)));
  metadata.properties.openingValuation = legacy;
  metadata.properties.openingCap = openingCapInQuote(legacy);
  const tokenURI = `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;
  f.prepared.createParams.tokenFactoryData = encodeAbiParameters(factoryDataAbi,
    [decoded[0], decoded[1], decoded[2], decoded[3], decoded[4], decoded[5], tokenURI]);
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
  return { ...f, start, duration, vestingLog };
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
  f.receipt.to = contracts.airlock; f.receipt.logs = f.receipt.logs.slice(0, 1);
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
        const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime: { config },
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
      const service = Object.assign(Object.create(LaunchpadService.prototype), {
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
      treasury, writesEnabled: false, blockReason: "Read-only", curvePolicy: CURVE_POLICY, feePolicy: FEE_POLICY,
      launchGuard: guard, launchLockAvailable: true };
    const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime: { config }, store,
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

test("registration reads the receipt-block trading fee and rejects every non-fixed schedule field", async () => {
  for (const make of [ordinaryFixture, (fee: number) => fixture(quote, fee), (fee: number) => lockedFixture(30, quote, fee)]) {
    for (const fee of [100, 300]) {
      const f = make(fee), directory = mkdtempSync(join(tmpdir(), "trading-fee-register-test-")), store = new Store(directory, 31337);
      const start = BigInt(Math.floor(f.plan.openingValuation!.expiresAt / 1000) - 1);
      let faultIndex = -1, scheduleReads = 0;
      try {
        store.savePlan(f.plan);
        const service = Object.assign(Object.create(LaunchpadService.prototype), {
          runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: 4663, writesEnabled: false } },
          store, assertNetwork: async () => {},
          client: { getTransaction: async () => f.tx, getTransactionReceipt: async () => f.receipt,
            getBlockNumber: async () => 11n, getBlock: async () => ({ hash: blockHash, timestamp: start }),
            readContract: async (input: { functionName: string; address: Address; blockNumber?: bigint; args?: readonly unknown[] }) => {
              if (input.functionName === "totalSupply") return SUPPLY;
              assert.equal(input.blockNumber, f.receipt.blockNumber);
              if (input.functionName === "vestingOf") {
                const duration = BigInt(f.plan.firstBuy!.lockDays!) * 86400n;
                return [creator, false, start, duration, duration, 1000n, 0n];
              }
              assert.equal(input.functionName, "getFeeSchedule");
              assert.equal(input.address, contracts.rehype); assert.deepEqual(input.args, [f.plan.poolId]);
              scheduleReads++;
              const schedule = [Number(start), fee * 100, fee * 100, fee * 100, 0];
              if (faultIndex >= 0) schedule[faultIndex]++;
              return schedule;
            } },
          sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey: f.poolKey }) }) },
        }) as LaunchpadService;
        for (const index of [1, 2, 3, 4]) {
          faultIndex = index;
          await assert.rejects(() => service.register(hash), /trading fee schedule/);
          assert.equal(store.token(token), null);
        }
        faultIndex = -1;
        const saved = await service.register(hash);
        assert.equal(saved.tradingFeeBps, fee); assert.equal(store.token(token)?.tradingFeeBps, fee);
        assert.equal(scheduleReads, 5);
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
      const service = Object.assign(Object.create(LaunchpadService.prototype), {
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
      const service = Object.assign(Object.create(LaunchpadService.prototype), {
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
        assert.equal((await service.register(hash)).tradingFeeBps, 100); assert.equal(feeReads, 1);
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
    const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime: { config: { mode: "fork", chainId: 31337,
      deploymentChainId: 4663, writesEnabled: false, launchGuard: null, launchLockAvailable: false } }, store, client,
      assertNetwork: async () => {}, sdk: { getMulticurvePool: async () => ({ getState: async () => ({ status: 2, numeraire: quote.address, poolKey: f.poolKey }) }) } }) as LaunchpadService;
    badPosition = true; await assert.rejects(() => service.register(hash), /custody/);
    assert.equal(store.token(token), null);
    badPosition = false; const saved = await service.register(hash);
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

test("broadcast retired-price plans recover original metadata after expiry while unsigned plans cannot validate", async (context) => {
  const current = fixture(), unsigned = historicalFixture(), old = historicalFixture(Date.now() - 86_400_000);
  const directory = mkdtempSync(join(tmpdir(), "legacy-price-recovery-test-")), store = new Store(directory, 31337);
  let pricingRequests = 0;
  context.mock.method(globalThis, "fetch", async () => { pricingRequests++; throw new Error("Recovery must not reprice an already broadcast launch"); });
  const config: RuntimeConfig = { mode: "fork", chainId: 31337, deploymentChainId: 4663, treasury,
    writesEnabled: false, blockReason: "Read-only", curvePolicy: CURVE_POLICY, feePolicy: FEE_POLICY, launchGuard: guard };
  const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime: { config }, store,
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

function paymentPreflightFixture(chainId: 8453 | 4663 = 8453) {
  const asset = chainId === 8453 ? STOCKS.find((stock) => stock.ticker === "NVDA")! : quote;
  const numeraire = firstBuyPaymentAssets(chainId).find((item) => item.symbol === (chainId === 8453 ? "USDC" : "USDG"))!;
  const calls: string[] = [];
  const requests: URLSearchParams[] = [], identityBlocks: bigint[] = [];
  const state = { fault: "", rpcChainId: chainId as number, guard: guard as Address | null, feePolicy: FEE_POLICY as string };
  const config: RuntimeConfig = { mode: chainId === 8453 ? "base" : "robinhood", deploymentChainId: chainId,
    chainId, treasury, writesEnabled: false, blockReason: "Read-only" };
  const untouched = () => { throw new Error("Payment preflight must not access SDK preparation or storage"); };
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
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
    await assert.rejects(f.run, /LI\.FI pricing or routing is unavailable/, "each request fetches a new swap probe");
    const fork = paymentPreflightFixture(chainId);
    fork.config.mode = "fork"; fork.config.chainId = 31337; fork.state.rpcChainId = 31337;
    await fork.run(); assert.equal(fork.requests.length, 2);
    assert(fork.requests.every((request) => request.get("fromChain") === String(chainId)), "fork RPC identity does not rewrite deployment-chain quotes");
  }
});
