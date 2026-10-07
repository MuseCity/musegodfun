import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient, createWalletClient, decodeFunctionData, decodeErrorResult, encodeFunctionData, erc20Abi,
  getAddress, http, keccak256, parseAbi, parseAbiItem, parseEventLogs, parseEther, parseUnits, toHex, zeroAddress,
  type Abi, type Address, type Hash, type Hex,
} from "viem";
import { robinhood } from "viem/chains";
import { DopplerSDK, type V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import { contractsFor, ROBINHOOD_STOCKS, sameAddress, SUPPLY, WAD } from "../src/lib/config";
import { ENGINE_FEE_POLICY } from "../src/lib/fee-policy";
import { buildLaunch, permit2Abi, swapTransaction, assertEngineFeeCalldata } from "../src/lib/protocol";
import { readOpeningValuation } from "../server/opening-price";
import { verifyFeeEngineRuntime } from "../server/buyback-engine";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";
import { startRobinhoodFork } from "./robinhood-fork";

// No production wallet or signer exists in this script. All writes use unlocked
// Anvil accounts on verified loopback chain 31337 through the read-only proxy.
loadEnvironment();
const runtime = runtimeFromEnv();
assert.equal(runtime.config.mode, "robinhood");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const serialize = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
const sourceHash = sha256(await readFile(new URL(import.meta.url), "utf8"));
const configRaw = await readFile(new URL("../contracts/buyback.config.json", import.meta.url), "utf8");
const config = JSON.parse(configRaw) as {
  feePolicy: string; offerFactor: number; ethMaxAge: number; twapSeconds: number;
  constants: Record<"weth" | "muse" | "museWethPool" | "ethUsdFeed" | "initializer" | "rehype" | "router" | "swapRouter" | "swapperFactory" | "beneficiary" | "routerExecutor" | "treasury" | "automationTreasury", Address> & { automation: Address | null };
  expectedRuntimeHashes: { router: Hex; routerExecutor: Hex };
  feeds: { token: Address; symbol: string; feed: Address; maxAge: number; checkOraclePaused: boolean }[];
};
assert.equal(config.feePolicy, ENGINE_FEE_POLICY);
assert.equal(config.feeds.length, 37);
const c = config.constants;
const recordedDeployment = JSON.parse(await readFile("contracts/artifacts/buyback-deployment.json","utf8"));
const reviewedV2 = JSON.parse(await readFile("contracts/artifacts/buyback-v2-deployment.json", "utf8"));
const deployedBridge = {
  forwarder: getAddress("0x3B6d01e627Fe6e06C831E0f9f57aC976a88309Ff"),
  swapper: getAddress("0xE8834943A4eD3758f3b5930E3EEfb43568B222b3"),
  executor: getAddress("0x787b6a964C3e86A005B8Fda87991e088178A8455"),
};
type Artifact = { abi: Abi; bytecode: Hex; deployedBytecode: Hex; compilerInputSha256: string;
  immutableReferences: Record<string, { start: number; length: number }[]>;
  immutableASTbindings: Record<string, { name: string; type: string }> };
const artifacts: Record<string, Artifact> = {};
const artifactHashes: Record<string, string> = {};
for (const name of ["MusegodBuybackOracle", "MusegodFeeEngine", "MusegodBuybackExecutor", "MusegodWethForwarder", "MusegodAssetFeedOracle", "MusegodBuybackBudgetVault"]) {
  const raw = await readFile(new URL(`../contracts/artifacts/${["MusegodBuybackOracle","MusegodBuybackExecutor"].includes(name) ? "" : "buyback-v2/"}${name}.json`, import.meta.url), "utf8");
  artifacts[name] = JSON.parse(raw);
  artifactHashes[name] = sha256(raw);
}
const factoryAbi = parseAbi([
  "function swapperImpl() view returns(address)",
  "function createSwapper((address owner,bool paused,address beneficiary,address tokenToBeneficiary,(address oracle,(address factory,bytes data) createOracleParams) oracleParams,uint32 defaultScaledOfferFactor,((address base,address quote) quotePair,uint32 scaledOfferFactor)[] pairScaledOfferFactors) params) returns(address swapper)",
]);
const swapperReadAbi = parseAbi([
  "function owner() view returns(address)", "function paused() view returns(bool)",
  "function beneficiary() view returns(address)", "function tokenToBeneficiary() view returns(address)",
  "function oracle() view returns(address)", "function defaultScaledOfferFactor() view returns(uint32)",
  "function getPairScaledOfferFactors((address base,address quote)[] pairs) view returns(uint32[])",
]);
const sharesAbi = parseAbi(["function getShares(bytes32,address) view returns(uint256)"]);
const poolAbi = parseAbi([
  "function observe(uint32[] secondsAgos) view returns(int56[],uint160[])",
  "function liquidity() view returns(uint128)",
]);
const kyberAbi = parseAbi([
  "function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256,uint256)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const quoter: Address = "0x3e290e5e01818002a0b672148bdc7514d861c7b3";
const result: Record<string, unknown> = {
  scope: "Isolated Robinhood fork, actual deployed Doppler, Splits and AMMs; no mainnet writes",
  upstreamChainId: 4663, executionChainId: 31337, mainnetTransactionSubmitted: false,
  sourceHash, configHash: sha256(configRaw), artifactHashes, feePolicy: ENGINE_FEE_POLICY,
  fullWethFeeBurnFlowPassed: false, fullWethSettlementSafetyPassed:false, fullUnpricedFeeAutomationTransferPassed: false, fullSourceWethForwarderFlowPassed:false, conversions: [], deployments: [], assets: [],
  snapshotRestored: false, blockedUpstreamWrites: null,
};
const deployments = result.deployments as Record<string, unknown>[];
const assets = result.assets as Record<string, unknown>[];
const conversions = result.conversions as Record<string, unknown>[];
const feeCustody: { label: string; engine: Address; transactionHash: Hash; rawReceipt: unknown }[] = [];
if (!c.automation) {
  Object.assign(result,{status:"not_run",reason:"Configure the real Robinhood Splits Automation address before current-route fork acceptance",nativeSplitsAutomationExecution:"not_run",blockedUpstreamWrites:0});
  await writeFile("docs/evidence/buyback-v2-fork.json",JSON.stringify(result,serialize,2)+"\n");
  console.log(JSON.stringify({status:"not_run",reason:result.reason}));
  process.exit(0);
}
const automation = getAddress(c.automation);
assert(!sameAddress(automation,c.treasury),"Automation and operations funds must use separate accounts");
const fork = await startRobinhoodFork(runtime.rpcUrl);
const chain = { ...robinhood, id: 31337, name: "Isolated fee buyback acceptance" };
assert.equal(new URL(fork.rpc).hostname, "127.0.0.1");
const client = createPublicClient({ chain, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });
assert.equal(await client.getChainId(), 31337);
const automationCode = await client.getCode({address:automation});
result.automationUpstreamCode = automationCode ?? "0x";
const sourceCode = await client.getCode({address:c.automationTreasury});
result.sourceUpstreamCode = sourceCode ?? "0x";
result.nativeSplitsAutomationExecution = "not_run";
const accounts: Address[] = await fork.rpcCall("eth_accounts");
const [creator, , stranger] = accounts;
const operations = c.treasury;
assert(creator && operations && stranger && !sameAddress(stranger, creator) && !sameAddress(stranger, operations));
const wallet = createWalletClient({ chain, account: creator, transport: http(fork.rpc, { timeout: 120_000 }) });
const publicWallet = createWalletClient({ chain, account: stranger, transport: http(fork.rpc, { timeout: 120_000 }) });
const contracts = contractsFor({ mode: "fork", deploymentChainId: 4663 });
const sdk = new DopplerSDK<4663>({ chainId: 4663, publicClient: createPublicClient({ chain: robinhood,
  transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) }).extend(() => ({ getChainId: async () => 4663 })) });
const snapshot = await fork.rpcCall("evm_snapshot");
const balance = (token: Address, account: Address) => client.readContract({ address: token, abi: erc20Abi,
  functionName: "balanceOf", args: [account] });
const allowance = (token: Address, account: Address, spender: Address) => client.readContract({ address: token,
  abi: erc20Abi, functionName: "allowance", args: [account, spender] });
let oracle: Address;
let engine: Address;
let swapper: Address;
let executor: Address;
let forwarder: Address;
let assetOracle: Address;
let vault: Address;
let realSourceBaseline: {
  sourceWeth: bigint; swapperWeth: bigint; sourceAllowance: bigint; totalForwarded: bigint;
  helperCodes: { address: Address; code: Hex }[];
} | undefined;
async function receipt(hash: Hash) {
  await fork.rpcCall("anvil_mine", [1]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const trace = await fork.rpcCall("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/buyback-engine-revert.json", JSON.stringify({ hash, receipt, trace }, serialize, 2));
    throw new Error(`Local fork transaction reverted: ${hash}; trace .cache/buyback-engine-revert.json`);
  }
  return receipt;
}
async function send(to: Address, data: Hex, signer = wallet, value = 0n) {
  const estimatedGas = await client.estimateGas({ account: signer.account.address, to, data, value });
  const gasLimit = estimatedGas * 150n / 100n + 50_000n;
  const r = await receipt(await signer.sendTransaction({ to, data, value, gas: gasLimit }));
  return { hash: r.transactionHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed, estimatedGas, gasLimit,
    effectiveGasPrice: r.effectiveGasPrice };
}
async function read(address: Address, artifactName: string, functionName: string, args?: readonly unknown[]) {
  return client.readContract({ address, abi: artifacts[artifactName].abi, functionName, args });
}
async function callEngine(functionName: string, args: readonly unknown[]) {
  return send(engine, encodeFunctionData({ abi: artifacts.MusegodFeeEngine.abi, functionName, args }), publicWallet);
}
async function verifyCompiledRuntime(name: string, address: Address, blockNumber?: bigint) {
  const artifact = artifacts[name];
  const code = await client.getCode({ address, blockNumber });
  assert(code && code !== "0x");
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  const bindings: Record<string, unknown> = {};
  for (const [astId, references] of Object.entries(artifact.immutableReferences)) {
    const binding = artifact.immutableASTbindings[astId];
    assert(binding, "Every compiler immutable reference requires an AST-named binding");
    const value = await client.readContract({ address, abi: artifact.abi, functionName: binding.name, blockNumber });
    bindings[binding.name] = value;
    const encoded = typeof value === "string" ? value.slice(2).toLowerCase().padStart(64, "0")
      : BigInt(value as number | bigint).toString(16).padStart(64, "0");
    for (const ref of references) {
      assert.equal(ref.length, 32);
      expected = expected.slice(0, ref.start * 2) + encoded + expected.slice((ref.start + ref.length) * 2);
    }
  }
  assert.equal(code.toLowerCase(), "0x" + expected, `${name} compiled runtime and immutable bindings must match`);
  return { runtimeHash: keccak256(code), compiledRuntimeVerified: true,
    compilerInputSha256: artifact.compilerInputSha256, bindings };
}
async function deploy(name: string, args: readonly unknown[]) {
  const artifact = artifacts[name];
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args, gas: 8_000_000n });
  const r = await receipt(hash);
  assert(r.contractAddress);
  const address = r.contractAddress;
  const verified = await verifyCompiledRuntime(name, address);
  deployments.push({ name, address, hash, blockNumber: r.blockNumber, gasUsed: r.gasUsed,
    ...verified });
  return address;
}
async function nextWindow() {
  const timestamp = (await client.getBlock()).timestamp;
  const next = (timestamp / 300n + 1n) * 300n + 1n;
  await fork.rpcCall("evm_setNextBlockTimestamp", [Number(next)]);
  await fork.rpcCall("anvil_mine", [1]);
  return { before: timestamp, after: next, reason: "Fork-only five-minute fee release window; no oracle history priming" };
}
async function resetScenarioClock() {
  const parentTime = (await client.getBlock()).timestamp;
  const wallTime = Math.floor(Date.now() / 1000);
  assert(parentTime <= BigInt(wallTime), "Restored scenario block must precede the real wall clock");
  // Anvil keeps its mining time offset across evm_revert. Restore it explicitly
  // before the next independent scenario; no feed/pool storage is changed.
  await fork.rpcCall("evm_setNextBlockTimestamp", [wallTime]);
  await fork.rpcCall("anvil_mine", [1]);
  return { restoredBlockTime: parentTime, nextBlockTime: wallTime,
    reason: "Reset Anvil mining clock offset after independent snapshot restoration" };
}
async function fund(asset: typeof ROBINHOOD_STOCKS[number], amount: bigint) {
  if (asset.ticker === "WETH") {
    const before = await balance(asset.address, creator);
    const tx = await send(asset.address, encodeFunctionData({ abi: parseAbi(["function deposit() payable"]),
      functionName: "deposit" }), wallet, amount);
    assert.equal(await balance(asset.address, creator) - before, amount);
    return { kind: "actual_WETH_deposit_on_local_fork", amount, ...tx };
  }
  const candidates: Address[] = [contracts.poolManager, "0x9B050cb1F265094b0977160a2BD7dA8C9E529c3C"];
  for (let window = 0; window < 20; ++window) {
    const end = fork.blockNumber - BigInt(window * 10);
    const logs = await fork.upstream.getLogs({ address: asset.address,
      event: parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)"),
      fromBlock: end - 9n, toBlock: end });
    candidates.push(...logs.flatMap((log) => [log.args.from, log.args.to]).filter((value): value is Address => !!value));
    for (const donor of [...new Set(candidates)]) {
      if ([creator, operations, stranger, zeroAddress, automation, c.automationTreasury,
        ...Object.values(deployedBridge)].some((address) => sameAddress(address, donor))) continue;
      const donorBefore = await balance(asset.address, donor);
      if (donorBefore < amount) continue;
      await fork.rpcCall("anvil_setBalance", [donor, toHex(parseEther("1"))]);
      try { await client.simulateContract({ address: asset.address, abi: erc20Abi,
        functionName: "transfer", args: [creator, amount], account: donor }); } catch { continue; }
      await fork.rpcCall("anvil_impersonateAccount", [donor]);
      try {
        const signer = createWalletClient({ chain, account: donor, transport: http(fork.rpc) });
        const before = await balance(asset.address, creator);
        const tx = await send(asset.address, encodeFunctionData({ abi: erc20Abi,
          functionName: "transfer", args: [creator, amount] }), signer);
        assert.equal(await balance(asset.address, creator) - before, amount);
        assert.equal(donorBefore - await balance(asset.address, donor), amount);
        return { kind: "existing_mainnet_inventory_impersonation_on_local_fork", donor, donorBefore, amount, ...tx };
      } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [donor]); }
    }
    if (candidates.length === 2 && window === 0) {
      const response = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${asset.address}/holders`,
        { signal: AbortSignal.timeout(20_000) });
      if (response.ok) for (const item of ((await response.json()).items ?? []).slice(0, 20))
        if (/^0x[0-9a-fA-F]{40}$/.test(item.address?.hash)) candidates.push(item.address.hash);
    }
  }
  throw new Error(`No genuine transferable ${asset.symbol} inventory found in bounded discovery`);
}
async function trade(key: V4PoolKey, currencyIn: Address, amount: bigint) {
  const quote = await sdk.quoter.quoteExactInputV4({ poolKey: key,
    zeroForOne: sameAddress(currencyIn, key.currency0), exactAmount: amount, hookData: "0x" });
  assert(quote.amountOut > 0n);
  const deadline = (await client.getBlock()).timestamp + 300n;
  if (await allowance(currencyIn, creator, contracts.permit2) < amount)
    await send(currencyIn, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contracts.permit2, amount] }));
  await send(contracts.permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve",
    args: [currencyIn, contracts.router, amount, Number(deadline)] }));
  const tx = swapTransaction(key, currencyIn, amount, quote.amountOut, 100, deadline, contracts);
  const before = await balance(tx.currencyOut, creator);
  const sent = await send(tx.to, tx.data);
  const received = await balance(tx.currencyOut, creator) - before;
  assert(received >= tx.minOut);
  return { ...sent, input: amount, output: received, minimumOutput: tx.minOut };
}
async function issue(ticker: string, buyAmount: string) {
  const asset = ROBINHOOD_STOCKS.find((row) => row.ticker === ticker);
  assert(asset);
  const amount = parseUnits(buyAmount, asset.decimals);
  const funding = await fund(asset, amount * 2n);
  const valuation = await readOpeningValuation(client, asset, 4663,
    { integrator: process.env.LIFI_INTEGRATOR || "musegodfun", apiKey: process.env.LIFI_API_KEY, rpcChainId: 31337 });
  const owner = await sdk.getAirlockOwner();
  const input = { name: `${ticker} fee burn fork proof`, symbol: `BF${ticker}`, description: "Isolated fork acceptance.",
    image: "", quoteAddress: asset.address };
  const params = buildLaunch(sdk, input, creator, operations, owner, valuation, undefined, 4663, engine);
  const prepared = await sdk.factory.prepareCreateMulticurve(params, { account: creator });
  assertEngineFeeCalldata({ feePolicy: ENGINE_FEE_POLICY, feeEngine: engine, creator, feeTreasury: operations },
    prepared.createParams.poolInitializerData);
  const launch = await send(prepared.transaction.to, prepared.transaction.data, wallet, prepared.transaction.value);
  const address = prepared.prediction.tokenAddress;
  const poolId = prepared.prediction.poolId;
  assert.equal(await client.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }), SUPPLY);
  const state = await (await sdk.getMulticurvePool(address)).getState();
  assert.equal(await client.readContract({ address: c.initializer, abi: sharesAbi,
    functionName: "getShares", args: [poolId, engine] }), WAD * 228n / 1000n);
  assert.equal(await client.readContract({ address: c.rehype, abi: sharesAbi,
    functionName: "getShares", args: [poolId, engine] }), WAD * 24n / 100n);
  const buy = await trade(state.poolKey, asset.address, amount);
  const sell = await trade(state.poolKey, address, (await balance(address, creator)) / 2n);
  const pendingBefore = await read(engine, "MusegodFeeEngine", "pending", [asset.address]) as bigint;
  const claim = await callEngine("claimFees", [poolId]);
  if (ticker === "WETH") feeCustody.push({ label: "claimFees", engine, transactionHash: claim.hash,
    rawReceipt: await client.getTransactionReceipt({ hash: claim.hash }) });
  const pending = await read(engine, "MusegodFeeEngine", "pending", [asset.address]) as bigint;
  assert(pending > pendingBefore, `${ticker} actual pool fees must credit the fixed engine beneficiary`);
  const row = { ticker, pairedAsset: asset.address, address, poolId, poolKey: state.poolKey, valuation, funding, launch, buy, sell,
    claim, caller: stranger, engine, lpShare: WAD * 228n / 1000n, hookShare: WAD * 24n / 100n,
    pending, pendingNewMeme: await read(engine, "MusegodFeeEngine", "pending", [address]),
    layer: "new_pool_actual_trades_and_fee_claim_on_local_fork" };
  assets.push(row);
  return row;
}
async function releaseUnknownFees(row: Awaited<ReturnType<typeof issue>>) {
  assert.equal(await read(engine, "MusegodFeeEngine", "isUnpriced", [row.address]), true);
  assert.equal(await read(engine, "MusegodFeeEngine", "isUnpriced", [c.weth]), false);
  const amount = await read(engine, "MusegodFeeEngine", "pending", [row.address]) as bigint;
  assert(amount > 0n, "A new meme's real LP fees must be unpriced and credited");
  const automationBefore = await balance(row.address, automation);
  const operationsBefore = await balance(row.address, operations);
  const callerBefore = await balance(row.address, stranger);
  const forwardedBefore = await read(engine, "MusegodFeeEngine", "totalAutomationForwarded", [row.address]) as bigint;
  const manual = await callEngine("releaseUnpriced", [row.address, amount]);
  assert.equal(await balance(row.address, automation) - automationBefore, amount);
  assert.equal(await balance(row.address, stranger), callerBefore);
  assert.equal(await balance(row.address, operations), operationsBefore);
  assert.equal(await read(engine, "MusegodFeeEngine", "pending", [row.address]), 0n);
  assert.equal((await read(engine, "MusegodFeeEngine", "totalAutomationForwarded", [row.address]) as bigint) - forwardedBefore, amount);
  await assert.rejects(client.simulateContract({ address: engine, abi: artifacts.MusegodFeeEngine.abi,
    functionName: "releaseUnpriced", args: [c.weth, 1n], account: stranger }),
    "Already priced WETH fees must remain on the buyback route");

  // Generate another real LP fee receipt in the same pool, then test the public
  // combined entry's automatic fallback. No token balances or prices are edited.
  const extraSale = await trade(row.poolKey, row.address, (await balance(row.address, creator)) / 10n);
  const nextAutomationBefore = await balance(row.address, automation);
  const claimedBefore = await read(engine, "MusegodFeeEngine", "totalClaimed", [row.address]) as bigint;
  const nextForwardedBefore = await read(engine, "MusegodFeeEngine", "totalAutomationForwarded", [row.address]) as bigint;
  const combined = await callEngine("claimAndForward", [row.poolId]);
  feeCustody.push({ label: "claimAndForward", engine, transactionHash: combined.hash,
    rawReceipt: await client.getTransactionReceipt({ hash: combined.hash }) });
  const newlyClaimed = (await read(engine, "MusegodFeeEngine", "totalClaimed", [row.address]) as bigint) - claimedBefore;
  assert(newlyClaimed > 0n, "The additional real sale must generate new meme LP fees");
  assert.equal(await balance(row.address, automation) - nextAutomationBefore, newlyClaimed);
  assert.equal(await read(engine, "MusegodFeeEngine", "pending", [row.address]), 0n);
  assert.equal((await read(engine, "MusegodFeeEngine", "totalAutomationForwarded", [row.address]) as bigint) - nextForwardedBefore, newlyClaimed);
  assert.equal(await balance(row.address, stranger), callerBefore);
  assert.equal(await balance(row.address, operations), operationsBefore);
  return { token: row.address, fixedAutomation: automation, caller: stranger, unsupportedOracleMapping: true,
    manual: { amount, ...manual }, automatic: { extraSale, newlyClaimed, ...combined },
    pendingAfterManual: "0", pendingAfterAutomatic: "0", callerReceived: "0",
    alreadyPricedWethReleaseRejected: true, priceOrTokenBalanceOverrides: false,
    layer: "actual_new_pool_unpriced_LP_fee_receipts_to_fixed_automation_on_local_fork" };
}
async function sourceWethBridge() {
  const source = c.automationTreasury, amount = parseEther("0.0001");
  const evidence: Record<string, unknown> = { source, forwarder, vault, swapper, executor, caller: stranger,
    amount, approvalFixture: true, approvalTransactionSubmitted: false, nativeAutomationSwapSweep: "not_run",
    layer: "fork-only impersonated finite approval -> new Forwarder -> new Vault -> reused Swapper/Executor" };
  result.sourceWethFlow = evidence;
  await fork.rpcCall("anvil_impersonateAccount", [source]);
  try {
    const sourceWallet = createWalletClient({ chain, account: source, transport: http(fork.rpc) });
    await wallet.sendTransaction({ to: source, value: parseEther("0.01") }).then(receipt);
    evidence.finiteApproval = await send(c.weth, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [forwarder, amount] }), sourceWallet);
    evidence.wrapped = await send(c.weth, "0xd0e30db0", wallet, amount);
    evidence.funded = await send(c.weth, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [source, amount] }));
    const sourceBefore = await balance(c.weth, source), vaultBefore = await balance(c.weth, vault);
    evidence.forward = await send(forwarder, encodeFunctionData({ abi: artifacts.MusegodWethForwarder.abi, functionName: "forward", args: [amount] }), publicWallet);
    assert.equal(await balance(c.weth, source), sourceBefore - amount);
    assert.equal(await balance(c.weth, vault), vaultBefore + amount);
    assert.equal(await allowance(c.weth, source, forwarder), 0n);
    evidence.sourceExactDebit = true; evidence.vaultExactCredit = true; evidence.finiteAllowanceConsumed = true;
    evidence.settlement = await settle("SOURCE_WETH_FINITE_FORK_APPROVAL", amount);
    evidence.status = "passed";
    return evidence;
  } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [source]); }
}
function containsRouterFloorRejection(trace:unknown,amount:bigint,minimum:bigint):boolean {
  if (!trace || typeof trace !== "object") return false;
  const node=trace as {to?:string;input?:string;output?:Hex;error?:string;calls?:unknown[]};
  if (node.to && sameAddress(node.to,c.swapRouter) && node.input?.startsWith("0x04e45aaf") && node.error && node.output) {
    try {
      const input=decodeFunctionData({abi:parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256)"]),data:node.input as Hex}).args[0];
      if(!sameAddress(input.tokenIn,c.weth) || !sameAddress(input.tokenOut,c.muse) || input.fee!==10000 || !sameAddress(input.recipient,executor) || input.amountIn!==amount || input.amountOutMinimum!==minimum || input.sqrtPriceLimitX96!==0n) return false;
      const decoded=decodeErrorResult({abi:parseAbi(["error Error(string)"]),data:node.output});
      if(decoded.errorName === "Error" && decoded.args?.[0] === "Too little received") return true;
    } catch { /* An undecoded failure cannot establish the fixed price guard. */ }
  }
  return Array.isArray(node.calls) && node.calls.some((call)=>containsRouterFloorRejection(call,amount,minimum));
}
async function settle(label: string, maximumAmount?:bigint) {
  const startingWeth = await balance(c.weth,vault);
  const originalSwapperWeth = await balance(c.weth,swapper);
  const available = await read(vault, "MusegodBuybackBudgetVault", "available") as bigint;
  const total = maximumAmount === undefined || available < maximumAmount ? available : maximumAmount;
  assert(total > 0n);
  const guardedBalances={dead:await balance(c.muse,c.beneficiary),callerMuse:await balance(c.muse,stranger),callerWeth:await balance(c.weth,stranger)};
  const attempts:Record<string,unknown>[]=[];
  result.settlementAttempts ??= [];
  (result.settlementAttempts as unknown[]).push({label,startingWeth,maximumAttemptedWeth:total,attempts});
  let selected:{amount:bigint;fairQuote:bigint;minimumMuse:bigint;ammQuote:bigint;data:Hex}|null=null;
  for(let step=0,amount=total;step<20 && amount>0n;step++,amount/=2n) {
    const attempt:Record<string,unknown>={amountWeth:amount}; attempts.push(attempt);
    let data:Hex|undefined;
    try {
      const fairQuote=await read(oracle,"MusegodBuybackOracle","quoteWethToMuse",[amount]) as bigint;
      const minimumMuse=fairQuote*985000n/1000000n;
      const quoted=await client.simulateContract({address:quoter,abi:quoterAbi,functionName:"quoteExactInputSingle",args:[{tokenIn:c.weth,tokenOut:c.muse,amountIn:amount,fee:10000,sqrtPriceLimitX96:0n}]});
      const ammQuote=quoted.result[0];
      Object.assign(attempt,{fairQuote,minimumMuse,ammQuote,offerFactor:985000});
      const deadline=(await client.getBlock()).timestamp+300n;
      data=encodeFunctionData({abi:artifacts.MusegodBuybackBudgetVault.abi,functionName:"execute",args:[amount,1n,deadline]});
      // Simulating the actual executor includes callback settlement and preserves
      // the fixed floor; a quote alone is not an execution guarantee.
      await client.call({account:stranger,to:vault,data});
      attempt.status="simulated_executable";
      selected={amount,fairQuote,minimumMuse,ammQuote,data}; break;
    } catch(error) {
      attempt.status="rejected_by_settlement_guards";attempt.reason=redact(error);
      if(data) try {attempt.trace=await fork.rpcCall("debug_traceCall",[{from:stranger,to:vault,data},"latest",{tracer:"callTracer"}]);}catch{attempt.trace="unavailable";}
    }
  }
  if (!selected) {
    assert(attempts.length > 0);
    // An explicit Vault circuit breaker, unavailable history or canonical router floor
    // is safe waiting. Unknown errors fail the acceptance rather than being called safe.
    function guardRejected(trace: unknown): boolean {
      if (!trace || typeof trace !== "object") return false;
      const node = trace as { to?: string; output?: Hex; error?: string; calls?: unknown[] };
      if (node.error && node.output && node.to && sameAddress(node.to, vault)) {
        try { const decoded = decodeErrorResult({ abi: artifacts.MusegodBuybackBudgetVault.abi, data: node.output });
          if (["PriceDeviation", "PriceUnavailable", "BudgetExceeded"].includes(decoded.errorName)) return true;
        } catch { /* canonical pool OLD means insufficient observation history */ }
        try { const decoded = decodeErrorResult({ abi: parseAbi(["error Error(string)"]), data: node.output });
          if (decoded.args?.[0] === "OLD") return true;
        } catch { /* A different failure is checked below. */ }
      }
      return (node.calls ?? []).some(guardRejected);
    }
    assert(attempts.every((row) => guardRejected(row.trace) || typeof row.amountWeth === "bigint" && typeof row.minimumMuse === "bigint" && containsRouterFloorRejection(row.trace, row.amountWeth, row.minimumMuse + 1n)), "An unexplained settlement failure must not pass safety acceptance");
    assert.equal(await balance(c.weth,vault),startingWeth);
    assert.equal(await balance(c.weth,swapper),originalSwapperWeth);
    assert.equal(await balance(c.muse,c.beneficiary),guardedBalances.dead);
    assert.equal(await balance(c.muse,stranger),guardedBalances.callerMuse);
    assert.equal(await balance(c.weth,stranger),guardedBalances.callerWeth);
    assert.equal(await balance(c.weth,executor),0n);
    assert.equal(await balance(c.muse,executor),0n);
    assert.equal(await allowance(c.muse,executor,swapper),0n);
    assert.equal(await allowance(c.weth,executor,c.swapRouter),0n);
    return {label,status:"waiting_at_unchanged_safety_guards",startingWeth,maximumAttemptedWeth:total,remainingWeth:startingWeth,burned:0n,profit:0n,offerFactor:985000,attempts,layer:"actual_vault_eth_call_and_trace_revert_only; no receipt or burn"};
  }
  const {amount,fairQuote,minimumMuse,ammQuote,data}=selected;
  const before={dead:await balance(c.muse,c.beneficiary),caller:await balance(c.muse,stranger),totalSupply:await client.readContract({address:c.muse,abi:erc20Abi,functionName:"totalSupply"})};
  const tx=await send(vault,data,publicWallet);
  // Preserve a real receipt before later verification can fail. Pre-send quotes
  // are estimates: a newly mined block can change the thirty-minute mean tick.
  const evidence:Record<string,unknown>={label,status:"receipt_pending_verification",caller:stranger,amountWeth:amount,
    startingWeth,maximumAttemptedWeth:total,preview:{fairQuote,minimumMuse,ammQuote},offerFactor:985000,...tx};
  result.settlementReceipts ??= [];
  (result.settlementReceipts as unknown[]).push(evidence);
  const burned=await balance(c.muse,c.beneficiary)-before.dead,profit=await balance(c.muse,stranger)-before.caller;
  Object.assign(evidence,{burned,profit});
  const actualReceipt=await client.getTransactionReceipt({hash:tx.hash});
  assert.equal(actualReceipt.status,"success");assert.equal(actualReceipt.blockNumber,tx.blockNumber);
  const receiptFairQuote=await client.readContract({address:oracle,abi:artifacts.MusegodBuybackOracle.abi,
    functionName:"quoteWethToMuse",args:[amount],blockNumber:tx.blockNumber}) as bigint;
  const receiptMinimumMuse=receiptFairQuote*985000n/1000000n;
  const flashes=parseEventLogs({abi:parseAbi(["event Flash(address indexed beneficiary,address indexed trader,((address base,address quote) quotePair,uint128 baseAmount,bytes data)[] quoteParams,address tokenToBeneficiary,uint256[] amountsToBeneficiary,uint256 excessToBeneficiary)"]),
    logs:actualReceipt.logs.filter((log)=>sameAddress(log.address,swapper)),strict:true});
  const executions=parseEventLogs({abi:parseAbi(["event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)"]),
    logs:actualReceipt.logs.filter((log)=>sameAddress(log.address,executor)),strict:true});
  const museTransfers=parseEventLogs({abi:erc20Abi,eventName:"Transfer",logs:actualReceipt.logs.filter((log)=>sameAddress(log.address,c.muse)),strict:true});
  const transferred=(from:Address,to:Address)=>museTransfers.filter((log)=>sameAddress(log.args.from,from)&&sameAddress(log.args.to,to)).reduce((sum,log)=>sum+log.args.value,0n);
  const actualAmmOutput=transferred(c.museWethPool,executor);
  Object.assign(evidence,{receiptFairQuote,receiptMinimumMuse,actualAmmOutput,flashEvents:flashes,executedEvents:executions,museTransferReceipts:museTransfers});
  assert.equal(flashes.length,1);assert.equal(executions.length,1);
  const flash=flashes[0].args,executed=executions[0].args;
  assert(sameAddress(flash.beneficiary,c.beneficiary)&&sameAddress(flash.trader,executor)&&sameAddress(flash.tokenToBeneficiary,c.muse));
  assert.equal(flash.quoteParams.length,1);assert.equal(flash.amountsToBeneficiary.length,1);
  const params=flash.quoteParams[0];
  assert(sameAddress(params.quotePair.base,c.weth)&&sameAddress(params.quotePair.quote,c.muse));
  assert.equal(params.baseAmount,amount);assert.equal(params.data,"0x");assert.equal(flash.excessToBeneficiary,0n);
  assert.equal(flash.amountsToBeneficiary[0],receiptMinimumMuse);
  assert.equal(burned,receiptMinimumMuse);assert.equal(transferred(executor,c.beneficiary),burned);
  assert(sameAddress(executed.caller,vault));assert.equal(executed.wethAmount,amount);
  assert.equal(executed.museToDead,burned);assert.equal(executed.profit,profit);
  assert.equal(transferred(executor,vault),profit);assert.equal(transferred(vault,stranger),profit);assert.equal(actualAmmOutput,burned+profit);assert(profit>=1n);
  assert.equal(await balance(c.weth,vault),startingWeth-amount);
  assert.equal(await balance(c.weth,swapper),originalSwapperWeth);
  assert.equal(await balance(c.muse,executor),0n);assert.equal(await allowance(c.muse,executor,swapper),0n);assert.equal(await allowance(c.weth,executor,c.swapRouter),0n);
  assert.equal(await client.readContract({address:c.muse,abi:erc20Abi,functionName:"totalSupply"}),before.totalSupply);
  Object.assign(evidence,{status:"settled",remainingWeth:startingWeth-amount,callerGasCostWei:tx.gasUsed*tx.effectiveGasPrice,
    profitBeforeGas:true,receiptBlockOracleAndTokenTransfersVerified:true,
    layer:"actual_Splits_flash_Router02_and_DEAD_receipt_on_local_fork"});
  return evidence;
}
async function convert(row: Awaited<ReturnType<typeof issue>>) {
  const checkpoint = await fork.rpcCall("evm_snapshot");
  const attempted: Record<string, unknown> = { ticker: row.ticker, token: row.pairedAsset,
    inputSource: "actual_fixed_engine_beneficiary_fee_receipt", inputCredited: true, status: "not_run",
    priceOrTokenBalanceOverrides: false, oracleFloorNeverLowered: true };
  conversions.push(attempted);
  let conversionCall: Hex | undefined;
  try {
    attempted.windowAdvance = await nextWindow();
    const pending = await read(engine, "MusegodFeeEngine", "pending", [row.pairedAsset]) as bigint;
    const amount = pending / 10n;
    assert(amount > 0n);
    attempted.amountIn = amount;
    const reference = await read(assetOracle, "MusegodAssetFeedOracle", "quoteToWeth", [row.pairedAsset, amount]) as bigint;
    const minimum = reference - reference / 100n;
    attempted.referenceWeth = reference;
    attempted.minimumWeth = minimum;
    const query = new URLSearchParams({ tokenIn: row.pairedAsset, tokenOut: c.weth, amountIn: String(amount), gasInclude: "false" });
    const routeResponse = await fetch(`https://aggregator-api.kyberswap.com/robinhood/api/v1/routes?${query}`,
      { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { "x-client-id": "musegodfun-fork-acceptance" } });
    const rawRoute = await routeResponse.text();
    attempted.routeResponseHash = sha256(rawRoute);
    assert(routeResponse.ok, `Kyber route API HTTP ${routeResponse.status}`);
    const routes = JSON.parse(rawRoute);
    assert.equal(routes.code, 0, `Kyber route unavailable: ${routes.message ?? "unknown"}`);
    assert(sameAddress(routes.data.routerAddress, c.router));
    attempted.quotedWeth = routes.data.routeSummary.amountOut;
    const quotedWeth = BigInt(routes.data.routeSummary.amountOut);
    assert(quotedWeth >= minimum, "The actual Kyber quote cannot meet the fixed Oracle floor");
    // Use only the interval the fixed 99% Oracle floor permits. This preserves
    // that floor even when the API quote exceeds the Oracle reference price.
    const slippageTolerance = Number((quotedWeth - minimum) * 10_000n / quotedWeth);
    attempted.slippageToleranceBps = slippageTolerance;
    const deadline = (await client.getBlock()).timestamp + 600n;
    const buildResponse = await fetch("https://aggregator-api.kyberswap.com/robinhood/api/v1/route/build", {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "x-client-id": "musegodfun-fork-acceptance" },
      body: JSON.stringify({ routeSummary: routes.data.routeSummary, sender: engine, recipient: engine,
        slippageTolerance, deadline: Number(deadline), source: "musegodfun-fork-acceptance" }),
      signal: AbortSignal.timeout(30_000),
    });
    const rawBuild = await buildResponse.text();
    attempted.buildResponseHash = sha256(rawBuild);
    assert(buildResponse.ok, `Kyber build API HTTP ${buildResponse.status}`);
    const built = JSON.parse(rawBuild);
    assert.equal(built.code, 0, `Kyber build unavailable: ${built.message ?? "unknown"}`);
    const data = built.data.data as Hex;
    const decoded = decodeFunctionData({ abi: kyberAbi, data });
    const execution = decoded.args[0];
    assert(sameAddress(execution.callTarget, c.routerExecutor));
    assert(sameAddress(execution.desc.srcToken, row.pairedAsset));
    assert(sameAddress(execution.desc.dstToken, c.weth));
    assert(sameAddress(execution.desc.dstReceiver, engine));
    assert.equal(execution.desc.amount, amount);
    attempted.routeDataHash = keccak256(data);
    attempted.flags = execution.desc.flags;
    attempted.router = c.router;
    attempted.routerExecutor = execution.callTarget;
    attempted.routeMinimumWeth = execution.desc.minReturnAmount;
    assert(execution.desc.minReturnAmount >= minimum, "The built route must preserve the fixed Oracle floor");
    conversionCall = encodeFunctionData({ abi: artifacts.MusegodFeeEngine.abi, functionName: "convertToWeth",
      args: [row.pairedAsset, amount, data, minimum, deadline] });
    const pendingBefore = await read(engine, "MusegodFeeEngine", "pending", [row.pairedAsset]) as bigint;
    const vaultBefore = await balance(c.weth, vault);
    const tx = await callEngine("convertToWeth", [row.pairedAsset, amount, data, minimum, deadline]);
    const wethReceived = await balance(c.weth, vault) - vaultBefore;
    assert(wethReceived >= minimum);
    assert.equal(pendingBefore - (await read(engine, "MusegodFeeEngine", "pending", [row.pairedAsset]) as bigint), amount);
    assert.equal(await allowance(row.pairedAsset, engine, c.router), 0n);
    Object.assign(attempted, { status: "passed", wethReceived, ...tx,
      layer: "actual_Kyber_router_from_credited_fees_on_local_fork", settlement: await settle(row.ticker) });
  } catch (error) {
    Object.assign(attempted, { status: "rejected_or_unavailable", reason: redact(error),
      pendingPreserved: await read(engine, "MusegodFeeEngine", "pending", [row.pairedAsset]),
      layer: "actual_fork_attempt_or_read_only_API_failure" });
    if (conversionCall) {
      const trace = await fork.rpcCall("debug_traceCall", [{ from: stranger, to: engine,
        data: conversionCall, value: "0x0" }, "latest", { tracer: "callTracer" }]);
      const traceRaw = JSON.stringify(trace, serialize, 2);
      const tracePath = `.cache/buyback-engine-${row.ticker}-trace.json`;
      await mkdir(".cache", { recursive: true });
      await writeFile(tracePath, traceRaw + "\n");
      const failures: Record<string, unknown>[] = [];
      const wethTransfers: Record<string, unknown>[] = [];
      function inspectTrace(node: { from?: Address; to?: Address; input?: Hex; output?: Hex;
        error?: string; revertReason?: string; calls?: typeof node[] }) {
        if (node.error) failures.push({ from: node.from, to: node.to, selector: node.input?.slice(0, 10),
          error: node.error, revertReason: node.revertReason, output: node.output });
        if (node.to && sameAddress(node.to, c.weth) && node.input && !node.error) {
          try {
            const call = decodeFunctionData({ abi: erc20Abi, data: node.input });
            if (call.functionName === "transfer") wethTransfers.push({ from: node.from, to: call.args[0],
              amount: call.args[1], layer: "successful_inner_call_in_globally_reverted_simulation" });
            if (call.functionName === "transferFrom") wethTransfers.push({ from: call.args[0], to: call.args[1],
              amount: call.args[2], layer: "successful_inner_call_in_globally_reverted_simulation" });
          } catch { /* Other WETH selectors are not settlement transfers. */ }
        }
        for (const child of node.calls ?? []) inspectTrace(child);
      }
      inspectTrace(trace);
      Object.assign(attempted, { tracePath, traceHash: sha256(traceRaw), innerFailures: failures,
        simulatedWethTransfersBeforeGlobalRevert: wethTransfers, simulationHasReceipt: false });
    }
  } finally {
    assert.equal(await fork.rpcCall("evm_revert", [checkpoint]), true);
    attempted.attemptSnapshotRestored = true;
  }
}

let failure: string | null = null;
try {
  // The human-created accounts must exist at the pinned upstream block.
  // This acceptance never supplies account code or changes their permissions.
  result.accountCodeFixtures = [];
  for (const [address,original] of [[automation,automationCode],[c.automationTreasury,sourceCode]] as const) {
    assert(original && original !== "0x",`${address} must already be deployed upstream; account code fixtures are forbidden`);
  }
  const pinnedBlock = await fork.upstream.getBlock({ blockNumber: fork.blockNumber });
  Object.assign(result, { observedAt: new Date().toISOString(), forkBlockNumber: fork.blockNumber,
    forkBlockHash: pinnedBlock.hash, forkBlockTimestamp: pinnedBlock.timestamp,
    actors: { creator, operations, stranger } });
  // Read the already existing thirty-minute history before advancing fork time.
  const actualHistory = await fork.upstream.readContract({ address: c.museWethPool, abi: poolAbi,
    functionName: "observe", args: [[1800, 0]], blockNumber: fork.blockNumber });
  result.existingMainnetTwapRead = { period: 1800, blockNumber: fork.blockNumber, cumulatives: actualHistory,
    layer: "block_pinned_mainnet_read_only", historyArtificiallyPrimed: false };
  for (const key of ["router", "routerExecutor"] as const) {
    const code = await client.getCode({ address: c[key] });
    assert(code && keccak256(code) === config.expectedRuntimeHashes[key], `${key} code differs from reviewed source`);
  }
  oracle = getAddress(recordedDeployment.contracts.oracle.address);
  swapper = getAddress(recordedDeployment.contracts.swapper.address);
  executor = getAddress(recordedDeployment.contracts.executor.address);
  for (const [key, name, address] of [["oracle", "MusegodBuybackOracle", oracle], ["executor", "MusegodBuybackExecutor", executor]] as const) {
    const verified = await verifyCompiledRuntime(name, address);
    assert.equal(verified.runtimeHash, recordedDeployment.contracts[key].runtimeHash);
  }
  assert.equal(keccak256((await client.getCode({ address: swapper }))!), recordedDeployment.contracts.swapper.runtimeHash);
  realSourceBaseline = { sourceWeth: await balance(c.weth, c.automationTreasury), swapperWeth: await balance(c.weth, swapper),
    sourceAllowance: await allowance(c.weth, c.automationTreasury, deployedBridge.forwarder),
    totalForwarded: await read(deployedBridge.forwarder, "MusegodWethForwarder", "totalForwarded") as bigint, helperCodes: [] };
  // Explicit fork-only approval fixture. Production revocation and governor control
  // remain separate signed acceptance requirements; impersonation proves neither.
  await fork.rpcCall("anvil_impersonateAccount", [c.automationTreasury]);
  try {
    const sourceWallet = createWalletClient({ chain, account: c.automationTreasury, transport: http(fork.rpc) });
    await wallet.sendTransaction({ to: c.automationTreasury, value: parseEther("0.01") }).then(receipt);
    result.legacyRevocationFixture = await send(c.weth, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployedBridge.forwarder, 0n] }), sourceWallet);
  } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [c.automationTreasury]); }
  assetOracle = await deploy("MusegodAssetFeedOracle", [c.treasury, c.weth, c.ethUsdFeed, config.ethMaxAge,
    config.feeds.map(({ token, feed, maxAge, checkOraclePaused }) => ({ token, feed, maxAge, checkOraclePaused }))]);
  vault = await deploy("MusegodBuybackBudgetVault", [c.weth, c.muse, oracle, swapper, executor]);
  forwarder = await deploy("MusegodWethForwarder", [c.automationTreasury, c.weth, swapper, vault]);
  engine = await deploy("MusegodFeeEngine", [c.initializer, c.rehype, oracle, swapper, c.weth, c.muse, c.router, c.routerExecutor, automation, assetOracle, vault]);
  result.graph = { oracle, swapper, executor, assetOracle, vault, forwarder, engine };
  const deployedContract = (name: string) => {
    const entry = deployments.find((row) => row.name === name)!;
    return { address: entry.address as Address, runtimeHash: entry.runtimeHash as Hex, blockNumber: String(entry.blockNumber) };
  };
  const savedPolicy = recordedDeployment.automation;
  assert(savedPolicy?.status === "configured" && sameAddress(savedPolicy.account ?? "",automation) &&
    savedPolicy.network === 4663 && sameAddress(savedPolicy.outputToken ?? "",c.weth) &&
    savedPolicy.allocationBps === 10000 && sameAddress(savedPolicy.recipient ?? "",c.automationTreasury),
    "The saved, independently observed native policy must match the actual accounts; no synthetic policy fallback is permitted");
  result.policyMetadataFixtureOnly=false;
  result.policyMetadataSource="recorded independently observed native policy; this fork does not execute the Splits scheduler";
  const forkManifest = { schemaVersion: 2, chainId: 4663, status: "deployed_verified", constants: c,
    automation:savedPolicy, assetFeedDescriptions: reviewedV2.assetFeedDescriptions,
    contracts: { oracle: recordedDeployment.contracts.oracle, swapper: recordedDeployment.contracts.swapper,
      assetOracle: deployedContract("MusegodAssetFeedOracle"), vault: deployedContract("MusegodBuybackBudgetVault"),
      engine: deployedContract("MusegodFeeEngine"), executor: recordedDeployment.contracts.executor,forwarder:deployedContract("MusegodWethForwarder") } };

  result.serverGraphVerification = { ...await verifyFeeEngineRuntime(client, engine, forkManifest),
    fixedAutomation: automation, layer: "real_fork_contract_getters_and_compiled_runtime_manifest_validation" };
  let scenarioSnapshot = await fork.rpcCall("evm_snapshot");
  console.log("Buyback fork: real new WETH pool and fee claim");
  const weth = await issue("WETH", "0.02");
  result.unpricedAutomationFlow = await releaseUnknownFees(weth);
  result.fullUnpricedFeeAutomationTransferPassed = true;
  const pendingBeforeDonation = await read(engine, "MusegodFeeEngine", "pending", [c.weth]);
  const donation = 12345n;
  const donated = await send(c.weth, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [engine, donation] }));
  assert.equal(await read(engine, "MusegodFeeEngine", "pending", [c.weth]), pendingBeforeDonation);
  const synced = await callEngine("syncUntracked", [weth.poolId]);
  assert.equal(await read(engine, "MusegodFeeEngine", "totalSynced", [c.weth]), donation);
  const advance = await nextWindow();
  const amount = (await read(engine, "MusegodFeeEngine", "pending", [c.weth]) as bigint) / 10n;
  const forward = await callEngine("forwardWeth", [amount]);
  const wethFlow:Record<string,unknown>={pool:weth,donation:{amount:donation,...donated,synced,creditedAsFees:false},windowAdvance:advance,forward};
  result.wethFlow=wethFlow;
  wethFlow.settlement=await settle("WETH");
  result.fullWethFeeBurnFlowPassed = (result.wethFlow as {settlement:{status:string}}).settlement.status === "settled";
  result.fullWethSettlementSafetyPassed = true;
  // Restore the pre-scenario fork clock before preparing another fresh launch.
  // Production launch snapshots deliberately reject future or stale blocks.
  assert.equal(await fork.rpcCall("evm_revert", [scenarioSnapshot]), true);
  result.wethScenarioSnapshotRestored = true;
  await resetScenarioClock();
  result.sourceWethFlow = await sourceWethBridge();
  result.fullSourceWethForwarderFlowPassed = true;
  for (const [ticker, amount] of [["USDG", "20"], ["cbBTC", "0.0002"]]) {
    const clockReset = await resetScenarioClock();
    scenarioSnapshot = await fork.rpcCall("evm_snapshot");
    console.log(`Buyback fork: ${ticker} actual credited fees to Kyber/WETH`);
    try {
      const issued = await issue(ticker, amount);
      Object.assign(issued, { scenarioClockReset: clockReset });
      await convert(issued);
    }
    catch (error) { conversions.push({ ticker, status: "unavailable_before_conversion", reason: redact(error) }); }
    finally { assert.equal(await fork.rpcCall("evm_revert", [scenarioSnapshot]), true); }
  }
} catch (error) {
  failure = redact(error);
  result.failure = failure;
} finally {
  try {
    assert.equal(await fork.rpcCall("evm_revert", [snapshot]), true);
    result.snapshotRestored = true;
    for (const deployed of deployments) assert.equal((await client.getCode({ address: deployed.address as Address })) ?? "0x", "0x");
    for (const [address,original] of [[automation,automationCode],[c.automationTreasury,sourceCode]] as const)
      assert.equal((await client.getCode({address})) ?? "0x",original ?? "0x");
    if(realSourceBaseline) {
      assert.equal(await balance(c.weth,c.automationTreasury),realSourceBaseline.sourceWeth);
      assert.equal(await balance(c.weth,deployedBridge.swapper),realSourceBaseline.swapperWeth);
      assert.equal(await allowance(c.weth,c.automationTreasury,deployedBridge.forwarder),realSourceBaseline.sourceAllowance);
      assert.equal(await read(deployedBridge.forwarder,"MusegodWethForwarder","totalForwarded"),realSourceBaseline.totalForwarded);
      for(const {address,code} of realSourceBaseline.helperCodes)
        assert.equal(await client.getCode({address}),code);
      result.preexistingSourceBridgeStateRestored=true;
    }
    result.snapshotContractRemovalVerified = true;
  } catch (error) { result.cleanupFailure = redact(error); failure ??= redact(error); }
  result.blockedUpstreamWrites = fork.blockedUpstreamWrites();
  await fork.stop();
  assert.equal(result.blockedUpstreamWrites, 0);
  await mkdir("docs/evidence", { recursive: true });
  await writeFile("docs/evidence/buyback-v2-fork.json", JSON.stringify(result, serialize, 2) + "\n");
  if (feeCustody.length === 2) await writeFile("docs/evidence/buyback-v2-fee-custody.json", JSON.stringify({
    scope: "Fresh isolated actual Doppler claim/release custody receipts from the reviewed V2 source",
    producer: "scripts/test-buyback-engine-fork.ts", sourceHash, configHash: sha256(configRaw), artifactHashes,
    upstreamChainId: 4663, executionChainId: 31337, forkBlock: result.forkBlock, mainnetTransactionSubmitted: false,
    actualFeeCustodyCaptured: true, snapshotRestored: result.snapshotRestored,
    snapshotContractRemovalVerified: result.snapshotContractRemovalVerified, blockedUpstreamWrites: result.blockedUpstreamWrites,
    nativeSplitsAutomationExecution: "not_run", feeCustody,
  }, serialize, 2) + "\n");
}
if (failure) throw new Error(failure);
console.log(JSON.stringify({ fullWethFeeBurnFlowPassed: result.fullWethFeeBurnFlowPassed,
  conversions: conversions.map(({ ticker, status }) => ({ ticker, status })), snapshotRestored: result.snapshotRestored,
  blockedUpstreamWrites: result.blockedUpstreamWrites }, serialize, 2));
