import test from "node:test";
import assert from "node:assert/strict";
import { airlockAbi, computePoolId, DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, http, keccak256, parseAbi, parseAbiParameters, type Address, type Hex, type TransactionReceipt } from "viem";
import { allocateFeeIncome, ENGINE_FEE_POLICY, FEE_POLICY, launchFeePolicy, MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { ROBINHOOD_CONTRACTS, ROBINHOOD_STOCKS, sameAddress, WAD, type RuntimeConfig } from "../src/lib/config";
import { assertEngineFeeCalldata, buildLaunch } from "../src/lib/protocol";
import { BUYBACK_WETH, buybackExecutorAbi, engineTransaction, feeEngineAbi, wethForwarderAbi } from "../src/lib/buyback-engine";
import { assertConversionRoute, conversionSlippageBps, readFeeAssetStatus, readSourceWethStatus, verifiedFlashBurn, verifyFeeEngine, type BuybackDeployment } from "../server/buyback-engine";
import deployment from "../contracts/artifacts/buyback-deployment.json";
import { assertLaunchWalletPlan } from "../src/lib/launch-wallet";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { syntheticOpeningValuation } from "./fixtures";
import type { LaunchPlan } from "../src/lib/launch-plan";

const creator = getAddress("0x1111111111111111111111111111111111111111");
const treasury = getAddress("0x2222222222222222222222222222222222222222");
const engine = getAddress("0x3333333333333333333333333333333333333333");
const executor = getAddress("0x4444444444444444444444444444444444444444");
const owner = getAddress("0x5555555555555555555555555555555555555555");
const automationReceiver = getAddress("0x6666666666666666666666666666666666666666");
const wethForwarder = getAddress("0x7777777777777777777777777777777777777777");
const automationTreasury = getAddress("0x8888888888888888888888888888888888888888");
const zero = getAddress("0x0000000000000000000000000000000000000000");
const token = ROBINHOOD_STOCKS.find((asset) => asset.ticker === "USDG")!;
const poolId = `0x${"aa".repeat(32)}` as Hex;
const config: RuntimeConfig = { mode: "fork", deploymentChainId: 4663, chainId: 31337, treasury, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY, feePolicy: ENGINE_FEE_POLICY, feeEngine: engine, buybackExecutor: executor, automationReceiver, automationTreasury, wethForwarder };
const sdk = new DopplerSDK<8453 | 4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 4663 });
const draft = { name: "Engine Test", symbol: "ENGINE", description: "", image: "", quoteAddress: token.address };

function encoded(ops: Address = treasury, feeEngine: Address = engine) {
  const valuation = syntheticOpeningValuation(token.address, "1", { chainId: 4663 });
  const params = buildLaunch(sdk, draft, creator, ops, owner, valuation, undefined, 4663, feeEngine);
  return { valuation, params: sdk.factory.encodeCreateMulticurveParams(params) };
}
function plan(): LaunchPlan {
  const { valuation, params } = encoded();
  const data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [params] });
  return { id: keccak256(data), creator, data, tokenAddress: executor, poolId, draft, preparedAt: Date.now(), gas: null, feePolicy: ENGINE_FEE_POLICY, feeTreasury: treasury, feeEngine: engine, openingValuation: valuation, curvePolicy: CURVE_POLICY, transaction: { to: ROBINHOOD_CONTRACTS.airlock, data, value: "0" } };
}

test("the direct engine policy is opt-in only for the active Robinhood deployment", () => {
  assert.equal(launchFeePolicy(), FEE_POLICY);
  assert.equal(launchFeePolicy({ mode: "base", feePolicy: ENGINE_FEE_POLICY }), FEE_POLICY);
  assert.equal(launchFeePolicy({ mode: "robinhood" }), FEE_POLICY);
  assert.equal(launchFeePolicy(config), ENGINE_FEE_POLICY);
});

test("Swapper burn attribution follows trader transferFrom receipts and excludes unrelated donations", () => {
  const swapper = owner, thirdPartyTrader = treasury;
  const flashAbi = parseAbi(["event Flash(address indexed beneficiary,address indexed trader,((address base,address quote) quotePair,uint128 baseAmount,bytes data)[] quoteParams,address tokenToBeneficiary,uint256[] amountsToBeneficiary,uint256 excessToBeneficiary)"]);
  const flashLog = {
    address: swapper,
    topics: encodeEventTopics({ abi: flashAbi, eventName: "Flash", args: { beneficiary: MUSEGOD_BUYBACK.burnAddress, trader: thirdPartyTrader } }),
    data: encodeAbiParameters(parseAbiParameters("((address base,address quote) quotePair,uint128 baseAmount,bytes data)[] quoteParams,address tokenToBeneficiary,uint256[] amountsToBeneficiary,uint256 excessToBeneficiary"), [[{ quotePair: { base: BUYBACK_WETH, quote: MUSEGOD_BUYBACK.tokenAddress }, baseAmount: 1n, data: "0x" }], MUSEGOD_BUYBACK.tokenAddress, [985n], 7n]),
  };
  const transfer = (from: Address, value: bigint) => ({ address: MUSEGOD_BUYBACK.tokenAddress, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to: MUSEGOD_BUYBACK.burnAddress } }), data: encodeAbiParameters([{ type: "uint256" }], [value]) });
  const receipt = (logs: unknown[]) => ({ status: "success", logs }) as Pick<TransactionReceipt, "status" | "logs">;
  assert.equal(verifiedFlashBurn(receipt([flashLog, transfer(thirdPartyTrader, 985n), transfer(swapper, 7n)]), swapper), 992n);
  assert.equal(verifiedFlashBurn(receipt([flashLog, transfer(thirdPartyTrader, 2000n), transfer(creator, 10_000n)]), swapper), 985n);
  assert.equal(verifiedFlashBurn(receipt([flashLog]), swapper), 0n, "A Flash event alone is not a burn receipt");
  assert.equal(verifiedFlashBurn(receipt([transfer(thirdPartyTrader, 985n)]), swapper), 0n, "A donation without this Swapper's settlement is not platform buyback output");
  assert.equal(verifiedFlashBurn({ ...receipt([flashLog, transfer(thirdPartyTrader, 985n)]), status: "reverted" }, swapper), 0n);
});

test("new pool calldata assigns the engine 22.8% LP and 24% hook, merging creator and operations safely", () => {
  for (const ops of [treasury, creator]) {
    const { params } = encoded(ops);
    assert.doesNotThrow(() => assertEngineFeeCalldata({ feePolicy: ENGINE_FEE_POLICY, feeEngine: engine, creator, feeTreasury: ops }, params.poolInitializerData));
    const [pool] = decodeAbiParameters(parseAbiParameters("(uint24 fee,int24 tickSpacing,int24 farTick,(int24 tickLower,int24 tickUpper,uint16 numPositions,uint256 shares)[] curves,(address beneficiary,uint96 shares)[] beneficiaries,address dopplerHook,bytes onInitializationDopplerHookCalldata,bytes graduationDopplerHookCalldata)"), params.poolInitializerData);
    assert.equal(pool.beneficiaries.reduce((total, row) => total + row.shares, 0n), WAD);
    assert.equal(pool.beneficiaries.find((row) => row.beneficiary === engine)!.shares, WAD * 2280n / 10_000n);
    assert.equal(pool.beneficiaries.find((row) => row.beneficiary === creator)!.shares, WAD * (ops === creator ? 7220n : 6650n) / 10_000n);
  }
  assert.throws(() => encoded(treasury, creator), /distinct.*beneficiary/);
  assert.throws(() => encoded(treasury, treasury), /distinct.*beneficiary/);
  assert.throws(() => encoded(treasury, owner), /distinct.*beneficiary/);
});

test("engine and operations receipts never receive another 80/20 split", () => {
  for (const amount of [0n, 1n, 11n, 10n ** 30n]) {
    const input = { feePolicy: ENGINE_FEE_POLICY, amount, creator, treasury, engine };
    assert.deepEqual(allocateFeeIncome({ ...input, account: engine }), { creator: 0n, platform: amount, buyback: amount, operations: 0n, remainder: 0n });
    assert.deepEqual(allocateFeeIncome({ ...input, account: treasury }), { creator: 0n, platform: amount, buyback: 0n, operations: amount, remainder: 0n });
    const merged = allocateFeeIncome({ ...input, account: creator, treasury: creator })!;
    assert.equal(merged.buyback, 0n);
    assert.equal(merged.creator + merged.operations + merged.remainder, amount);
    assert.equal(merged.creator, amount * 6650n / 7220n);
  }
});

test("wallet previews bind engine policy and address to the signed beneficiary calldata", () => {
  const original = plan();
  assert.doesNotThrow(() => assertLaunchWalletPlan(original, config, creator));
  assert.throws(() => assertLaunchWalletPlan(original, { ...config, feeEngine: null }, creator), /could not be verified/);
  assert.throws(() => assertLaunchWalletPlan(original, { ...config, feeEngine: executor }, creator), /configuration changed/);
  for (const receiver of [null, treasury, zero])
    assert.throws(() => assertLaunchWalletPlan(original, { ...config, automationReceiver: receiver }, creator), /could not be verified/);
  for (const changes of [{ automationTreasury: null }, { wethForwarder: null }, { automationTreasury: treasury }, { wethForwarder: automationReceiver }])
    assert.throws(() => assertLaunchWalletPlan(original, { ...config, ...changes }, creator), /could not be verified/);
  assert.throws(() => assertLaunchWalletPlan({ ...original, feeEngine: executor }, { ...config, feeEngine: executor }, creator), /fixed fee engine shares/);
  assert.throws(() => assertLaunchWalletPlan({ ...original, feePolicy: FEE_POLICY, feeEngine: undefined }, config, creator), /fee policy has changed/);
  assert.throws(() => assertLaunchWalletPlan({ ...original, feePolicy: undefined }, config, creator), /fee policy has changed/);
});

test("public engine transactions target only fixed contracts with bounded amounts and deadlines", () => {
  assert.equal(engineTransaction({ kind: "claim", poolId }, config).to, engine);
  assert.equal(engineTransaction({ kind: "forward", amount: "100" }, config).to, engine);
  const deadline = Math.floor(Date.now() / 1000) + 59;
  const tx = engineTransaction({ kind: "execute", amount: "100", minProfit: "0", deadline }, config);
  assert.equal(tx.to, executor);
  const decoded = decodeFunctionData({ abi: buybackExecutorAbi, data: tx.data });
  assert.deepEqual(decoded.args, [100n, 0n, BigInt(deadline)]);
  assert.throws(() => engineTransaction({ kind: "forward", amount: "0" }, config), /amount/);
  assert.throws(() => engineTransaction({ kind: "execute", amount: "100", minProfit: "0", deadline: 1 }, config), /expired/);
  assert.throws(() => engineTransaction({ kind: "claim", poolId }, { ...config, feeEngine: null }), /not configured/);
  assert.throws(() => engineTransaction({ kind: "claim", poolId }, { ...config, feePolicy: FEE_POLICY }), /not configured/);
  for (const receiver of [null, treasury, zero])
    assert.throws(() => engineTransaction({ kind: "claim", poolId }, { ...config, automationReceiver: receiver }), /not configured/);
});

test("unpriced release calldata binds only token and amount to the fixed engine without a receiver argument", () => {
  const tx = engineTransaction({ kind: "release_unpriced", token: token.address, amount: "100" }, config);
  assert.equal(tx.to, engine); assert.equal(tx.value, 0n);
  const decoded = decodeFunctionData({ abi: feeEngineAbi, data: tx.data });
  assert.equal(decoded.functionName, "releaseUnpriced");
  assert.deepEqual(decoded.args, [token.address, 100n]);
  for (const forbidden of [BUYBACK_WETH, MUSEGOD_BUYBACK.tokenAddress, zero])
    assert.throws(() => engineTransaction({ kind: "release_unpriced", token: forbidden, amount: "100" }, config), /fixed buyback or burn path/);
  assert.throws(() => engineTransaction({ kind: "release_unpriced", token: token.address, amount: "100" }, { ...config, treasury: null }), /not configured/);
});

test("source WETH forwarding encodes only a positive amount to the fixed forwarder, never a source or recipient", () => {
  const tx = engineTransaction({ kind: "forward_source", amount: "100" }, config);
  assert.equal(tx.to, wethForwarder); assert.equal(tx.value, 0n);
  const decoded = decodeFunctionData({ abi: wethForwarderAbi, data: tx.data });
  assert.equal(decoded.functionName, "forward"); assert.deepEqual(decoded.args, [100n]);
  assert.throws(() => engineTransaction({ kind: "forward_source", amount: "0" }, config), /amount/);
  for (const changes of [{ wethForwarder: null }, { automationTreasury: null }, { automationTreasury: treasury }, { automationTreasury: automationReceiver }, { wethForwarder: automationTreasury }])
    assert.throws(() => engineTransaction({ kind: "forward_source", amount: "100" }, { ...config, ...changes }), /not configured/);
});

test("source WETH reads remain visible before deployment or approval and use the smaller whole balance or allowance", async () => {
  for (const [code, balance, allowance, available] of [["0x6000", 100n, 25n, 25n], ["0x6000", 10n, 25n, 10n], ["0x6000", 100n, 0n, 0n], ["0x", 100n, 25n, 0n]] as const) {
    const client = { getCode: async ({ address, blockNumber }: { address: Address; blockNumber: bigint }) => { assert.equal(address, automationTreasury); assert.equal(blockNumber, 7n); return code; },
      readContract: async ({ address, functionName, args, blockNumber }: { address: Address; functionName: string; args?: Address[]; blockNumber: bigint }) => {
        assert.equal(blockNumber, 7n);
        if (functionName === "balanceOf") { assert.equal(address, BUYBACK_WETH); assert.deepEqual(args, [automationTreasury]); return balance; }
        if (functionName === "allowance") { assert.equal(address, BUYBACK_WETH); assert.deepEqual(args, [automationTreasury, wethForwarder]); return allowance; }
        assert.equal(address, wethForwarder); assert.equal(functionName, "totalForwarded"); return 123n;
      } } as unknown as Parameters<typeof readSourceWethStatus>[0];
    const result = await readSourceWethStatus(client, { forwarder: wethForwarder, automationTreasury, blockNumber: 7n });
    assert.equal(result.sourceDeployed, code !== "0x"); assert.equal(result.sourceWeth, String(balance)); assert.equal(result.sourceAllowance, String(allowance));
    assert.equal(result.sourceForwarded, "123"); assert.equal(result.sourceAvailable, String(available));
  }
});

test("asset classification distinguishes static absence from stale prices and keeps known balances on read failure", async () => {
  const graph = { engine, oracle: owner, blockNumber: 7n };
  const asset = { address: token.address, symbol: token.symbol, decimals: token.decimals };
  for (const mode of ["unpriced", "stale", "paused", "unknown"] as const) {
    let quotes = 0;
    const client = { readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
      assert.equal(blockNumber, 7n);
      if (functionName === "isUnpriced") { if (mode === "unknown") throw new Error("RPC unavailable"); return mode === "unpriced"; }
      if (functionName === "pending") return 100n;
      if (functionName === "totalClaimed") return 120n;
      if (functionName === "totalAutomationForwarded") return 20n;
      if (functionName === "window") return [300n, 10n, 10n];
      if (functionName === "quoteToWeth") { quotes++; throw new Error(mode === "paused" ? "OraclePaused" : "StaleFeed"); }
      return 0n;
    } } as unknown as Parameters<typeof readFeeAssetStatus>[0];
    const result = await readFeeAssetStatus(client, graph, asset, 600n);
    assert.equal(result.pending, "100"); assert.equal(result.claimed, "120"); assert.equal(result.automationForwarded, "20");
    assert.equal(result.referenceWeth, null);
    if (mode === "unpriced") {
      assert.equal(result.pricing, "unsupported_static"); assert.equal(result.available, "100"); assert.equal(result.error, null); assert.equal(quotes, 0);
    } else if (mode === "unknown") {
      assert.equal(result.pricing, "unknown"); assert.equal(result.available, "0"); assert.match(result.error!, /classification could not be verified/); assert.equal(quotes, 0);
    } else {
      assert.equal(result.pricing, "supported"); assert.equal(result.available, "10"); assert(result.error); assert.equal(quotes, 1);
    }
  }
});

test("unverified deployment candidates fail closed before querying the RPC", async () => {
  let queried = false;
  const client = { getBlockNumber: async () => { queried = true; return 1n; } } as unknown as Parameters<typeof verifyFeeEngine>[0];
  await assert.rejects(() => verifyFeeEngine(client, engine), /has not been verified/);
  assert.equal(queried, false);
});

test("Automation routing stays closed until an independent receiver and matching saved-rule metadata exist", async () => {
  let queried = false;
  const client = { getBlockNumber: async () => { queried = true; throw new Error("Unexpected RPC"); } } as unknown as Parameters<typeof verifyFeeEngine>[0];
  // Configured metadata here is only a fixture, not evidence of a saved or executed native rule.
  const manifest: BuybackDeployment = { ...deployment, status: "deployed_verified",
    contracts: Object.fromEntries((["oracle", "swapper", "engine", "executor", "forwarder"] as const).map((name, index) => [name, { address: [owner, creator, engine, executor, wethForwarder][index], runtimeHash: `0x${"aa".repeat(32)}` }])) as BuybackDeployment["contracts"],
    constants: { ...deployment.constants, automation: automationReceiver },
    automation: { status: "configured", account: automationReceiver, network: 4663, outputToken: BUYBACK_WETH, allocationBps: 10_000, recipient: deployment.constants.automationTreasury },
  };
  for (const receiver of [null, manifest.constants.treasury, zero, engine])
    await assert.rejects(() => verifyFeeEngine(client, engine, { ...manifest, constants: { ...manifest.constants, automation: receiver } }), /Independent operations, Splits Automation/);
  for (const source of [null, zero, manifest.constants.treasury, automationReceiver, wethForwarder])
    await assert.rejects(() => verifyFeeEngine(client, engine, { ...manifest, constants: { ...manifest.constants, automationTreasury: source } }), /Independent operations, Splits Automation/);
  for (const changes of [{ status: "not_configured" }, { account: null }, { account: treasury }, { network: 31337 }, { outputToken: token.address }, { allocationBps: 8000 }, { recipient: executor }])
    await assert.rejects(() => verifyFeeEngine(client, engine, { ...manifest, automation: { ...manifest.automation!, ...changes } }), /Awaiting Splits Automation rule configuration/);
  await assert.rejects(() => verifyFeeEngine(client, engine, { ...manifest, automation: undefined }), /Awaiting Splits Automation rule configuration/);
  if (!deployment.constants.automation || !sameAddress(deployment.constants.automation, automationReceiver))
    await assert.rejects(() => verifyFeeEngine(client, engine, manifest), /different asset, beneficiary or Automation account/);
  assert.equal(queried, false);
});

test("the fifth module requires its reviewed runtime and exact source, WETH and Swapper getters", async () => {
  const runtime = "0x6000" as Hex;
  const manifest: BuybackDeployment = { ...deployment, status: "deployed_verified",
    contracts: Object.fromEntries((["oracle", "swapper", "engine", "executor", "forwarder"] as const).map((name, index) => [name, { address: [owner, creator, engine, executor, wethForwarder][index], runtimeHash: keccak256(runtime) }])) as BuybackDeployment["contracts"],
    automation: { status: "configured", account: deployment.constants.automation, network: 4663, outputToken: BUYBACK_WETH, allocationBps: 10_000, recipient: deployment.constants.automationTreasury },
  };
  const constants = manifest.constants;
  const getters = {
    [engine.toLowerCase()]: { initializer: constants.initializer, rehype: constants.rehype, oracle: owner, swapper: creator, weth: constants.weth, muse: constants.muse, router: constants.router, automation: constants.automation },
    [executor.toLowerCase()]: { swapper: creator, weth: constants.weth, musegod: constants.muse, router: constants.swapRouter },
    [wethForwarder.toLowerCase()]: { source: constants.automationTreasury, weth: constants.weth, swapper: creator },
  };
  for (const fault of ["runtime", "source", "weth", "swapper"] as const) {
    const client = { getBlockNumber: async () => 7n,
      getCode: async ({ address }: { address: Address }) => fault === "runtime" && sameAddress(address, wethForwarder) ? "0x6001" : runtime,
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (sameAddress(address, wethForwarder) && functionName === fault) return treasury;
        return getters[address.toLowerCase()]?.[functionName as keyof typeof getters[typeof engine]];
      } } as unknown as Parameters<typeof verifyFeeEngine>[0];
    await assert.rejects(() => verifyFeeEngine(client, engine, manifest), fault === "runtime" ? /runtime does not match/ : /WETH forwarder dependencies/);
  }
});

const kyberAbi = parseAbi(["function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256 returnAmount,uint256 gasUsed)"]);
test("conversion calldata rejects injected recipients, fees, approvals and alternative executor paths", () => {
  const valid = { callTarget: executor, approveTarget: zero, targetData: "0x1234" as Hex, desc: { srcToken: token.address, dstToken: BUYBACK_WETH, srcReceivers: [executor], srcAmounts: [10n], feeReceivers: [] as Address[], feeAmounts: [] as bigint[], dstReceiver: engine, amount: 10n, minReturnAmount: 100n, flags: 512n, permit: "0x" as Hex }, clientData: "0x" as Hex };
  const expected = { token: token.address, amount: 10n, engine, executor, minimum: 100n };
  const encode = (route = valid) => encodeFunctionData({ abi: kyberAbi, functionName: "swap", args: [route] });
  assert.doesNotThrow(() => assertConversionRoute(encode(), expected));
  for (const route of [
    { ...valid, callTarget: treasury }, { ...valid, approveTarget: treasury },
    ...[{ dstReceiver: treasury }, { amount: 9n }, { srcToken: treasury }, { dstToken: treasury }, { minReturnAmount: 99n }, { flags: 256n }, { feeReceivers: [treasury], feeAmounts: [1n] }, { srcReceivers: [treasury] }, { srcAmounts: [9n] }, { permit: "0x1234" as Hex }].map((desc) => ({ ...valid, desc: { ...valid.desc, ...desc } })),
  ]) assert.throws(() => assertConversionRoute(encode(route), expected), /does not match/);
  assert.throws(() => assertConversionRoute(`${encode()}00` as Hex, expected), /does not match/);
});

test("conversion quote headroom is bounded by the 99 percent Oracle floor rather than an API-price cap", () => {
  const minimum = 198n;
  assert.equal(conversionSlippageBps(212n, minimum), 660);
  assert(212n * BigInt(10_000 - conversionSlippageBps(212n, minimum)) / 10_000n >= minimum);
  assert.equal(conversionSlippageBps(198n, minimum), 0);
  assert.throws(() => conversionSlippageBps(197n, minimum));
  assert.throws(() => conversionSlippageBps(0n, 0n));
});
