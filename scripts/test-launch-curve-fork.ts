import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, decodeAbiParameters, decodeEventLog, encodeAbiParameters,
  encodeFunctionData, erc20Abi, formatUnits, http, keccak256, parseAbi, parseAbiItem,
  parseAbiParameters, parseEther, parseUnits, toHex, zeroAddress,
  type Address, type Hash, type Hex,
} from "viem";
import { robinhood } from "viem/chains";
import { bundlerAbi, getSqrtRatioAtTick, type V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import artifact from "../contracts/artifacts/MusegodLaunchGuard.json";
import { ROBINHOOD_BUNDLER, ROBINHOOD_STOCKS, SUPPLY, WAD, contractsFor, sameAddress, type RuntimeConfig, type TokenRecord } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import type { LaunchPlan } from "../src/lib/launch-plan";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { claimFeesAbi, permit2Abi, swapTransaction } from "../src/lib/protocol";
import { LaunchpadService } from "../server/service";
import { redact, runtimeFromEnv } from "../server/config";
import { startRobinhoodFork } from "./robinhood-fork";

const runtime = runtimeFromEnv();
const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const sourceHash = sha256(await readFile(new URL(import.meta.url), "utf8"));
const guardArtifactHash = sha256(await readFile(new URL("../contracts/artifacts/MusegodLaunchGuard.json", import.meta.url), "utf8"));
const priorAssetProof = process.env.LAUNCH_FORK_REUSE_ASSET_PROOF
  ? JSON.parse(await readFile(process.env.LAUNCH_FORK_REUSE_ASSET_PROOF, "utf8")) : null;
if (priorAssetProof) {
  assert.equal(priorAssetProof.assets?.length, 10);
  assert.equal(priorAssetProof.curvePolicy, CURVE_POLICY);
  assert.equal(priorAssetProof.guardArtifactHash, guardArtifactHash);
  assert.equal(priorAssetProof.snapshotRestored, true);
  assert.equal(priorAssetProof.blockedUpstreamWrites, 0);
  assert(priorAssetProof.sourceHash);
}
assert.equal(runtime.config.mode, "robinhood");
const fork = await startRobinhoodFork(runtime.rpcUrl);
const dataDir = await mkdtemp(join(tmpdir(), "musegod-curve-fork-"));
const chain = { ...robinhood, id: 31337, name: "Isolated launch curve acceptance" };
const client = createPublicClient({ chain, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });
const accounts: Address[] = await fork.rpcCall("eth_accounts");
const creator = accounts[0], treasury = accounts[1];
const wallet = createWalletClient({ chain, account: creator, transport: http(fork.rpc, { timeout: 120_000 }) });
const treasuryWallet = createWalletClient({ chain, account: treasury, transport: http(fork.rpc, { timeout: 120_000 }) });
const config: RuntimeConfig = { mode: "fork", chainId: 31337, deploymentChainId: 4663,
  treasury, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY, launchGuard: null };
const contracts = contractsFor(config);
const snapshot = await fork.rpcCall("evm_snapshot");
let service: LaunchpadService | undefined;
let guard: Address | undefined;
let guardDeployment: { hash: Hash; gasUsed: bigint } | undefined;
let snapshotRestored = false;
let executionError: string | null = null;
let cleanupError: string | null = null;
const evidence: Record<string, unknown>[] = priorAssetProof ? priorAssetProof.assets.map((row: Record<string, unknown>) => ({
  ...row, proofPhase: "previous_assets_run", forkBlockNumber: priorAssetProof.forkBlockNumber,
  guard: row.firstBuy ? priorAssetProof.guard : null,
})) : [];
const boundaries: Record<string, unknown>[] = [];
const testedTokens: Address[] = [];
const tickers = ["USDG", "cbBTC", "WETH", "NVDA", "MUSEGOD"];
const balance = (asset: Address, account: Address) => client.readContract({ address: asset, abi: erc20Abi,
  functionName: "balanceOf", args: [account] });
const allowance = (asset: Address, owner: Address, spender: Address) => client.readContract({ address: asset,
  abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
const sqrtAt = (tick: number) => getSqrtRatioAtTick(tick) + (tick === 0 ? 0n : 1n);
const q96 = 1n << 96n;

async function receipt(hash: Hash) {
  await fork.rpcCall("anvil_mine", [2]);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") {
    const transaction = await client.getTransaction({ hash });
    const trace = await fork.rpcCall("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/launch-curve-revert.json", JSON.stringify({ r, transaction, trace }, serialize, 2));
    throw new Error(`Isolated fork transaction reverted: ${hash}; trace .cache/launch-curve-revert.json`);
  }
  return r;
}
const serialize = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
async function saveBoundaryProgress() {
  await mkdir(".cache", { recursive: true });
  await writeFile(".cache/launch-boundary-progress.json", JSON.stringify({
    observedAt: new Date().toISOString(), forkBlockNumber: fork.blockNumber, executionChainId: 31337,
    curvePolicy: CURVE_POLICY, sourceHash, guardArtifactHash, guard,
    fullBoundaryFlowPassed: false, boundaries,
  }, serialize, 2) + "\n");
}
async function send(to: Address, data: Hex, signer = wallet, value = 0n) {
  const estimatedGas = await client.estimateGas({ account: signer.account.address, to, data, value });
  const gasLimit = estimatedGas * 150n / 100n + 50_000n;
  const r = await receipt(await signer.sendTransaction({ to, data, value, gas: gasLimit }));
  return { hash: r.transactionHash, estimatedGas, gasLimit, gasUsed: r.gasUsed, receipt: r };
}
async function fund(asset: typeof ROBINHOOD_STOCKS[number], amount: bigint) {
  if (asset.ticker === "WETH") {
    await fork.rpcCall("anvil_setBalance", [creator, toHex(parseEther("1000000"))]);
    const before = await balance(asset.address, creator);
    const r = await receipt(await wallet.writeContract({ address: asset.address,
      abi: parseAbi(["function deposit() payable"]), functionName: "deposit", value: amount }));
    assert.equal(await balance(asset.address, creator) - before, amount);
    return { kind: "real_WETH_deposit_on_local_fork", hash: r.transactionHash, amount };
  }
  const candidates: Address[] = [contracts.poolManager];
  const transfers = await fork.upstream.getLogs({ address: asset.address,
    event: parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)"),
    fromBlock: fork.blockNumber - 9n, toBlock: fork.blockNumber });
  candidates.push(...transfers.flatMap((log) => [log.args.to, log.args.from])
    .filter((address): address is Address => !!address && !sameAddress(address, zeroAddress)));
  if (candidates.length === 1) {
    const response = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${asset.address}/holders`,
      { signal: AbortSignal.timeout(20_000) });
    if (response.ok) for (const item of ((await response.json()).items ?? []).slice(0, 20))
      if (/^0x[0-9a-fA-F]{40}$/.test(item.address?.hash)) candidates.push(item.address.hash);
  }
  for (const donor of [...new Set(candidates)]) {
    if (sameAddress(donor, creator) || sameAddress(donor, treasury)) continue;
    const donorBefore = await balance(asset.address, donor);
    if (donorBefore < amount) continue;
    await fork.rpcCall("anvil_setBalance", [donor, toHex(parseEther("1"))]);
    try { await client.simulateContract({ address: asset.address, abi: erc20Abi,
      functionName: "transfer", args: [creator, amount], account: donor }); } catch { continue; }
    await fork.rpcCall("anvil_impersonateAccount", [donor]);
    try {
      const signer = createWalletClient({ chain, account: donor, transport: http(fork.rpc) });
      const before = await balance(asset.address, creator);
      const r = await send(asset.address, encodeFunctionData({ abi: erc20Abi,
        functionName: "transfer", args: [creator, amount] }), signer);
      assert.equal(await balance(asset.address, creator) - before, amount);
      assert.equal(donorBefore - await balance(asset.address, donor), amount);
      return { kind: "verified_existing_inventory_transfer_on_local_fork", donor, hash: r.hash, amount, donorBefore };
    } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [donor]); }
  }
  throw new Error(`No genuine ${asset.ticker} inventory found on the fork`);
}
async function poolState(poolId: Hex) {
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
  const read = (at: Hex) => client.readContract({ address: contracts.poolManager,
    abi: parseAbi(["function extsload(bytes32 slot) view returns(bytes32)"]), functionName: "extsload", args: [at] });
  const [raw, rawLiquidity] = await Promise.all([read(slot), read(toHex(BigInt(slot) + 3n, { size: 32 }))]);
  const n = BigInt(raw);
  let tick = Number(n >> 160n & ((1n << 24n) - 1n));
  if (tick >= 2 ** 23) tick -= 2 ** 24;
  return { sqrtPriceX96: n & ((1n << 160n) - 1n), tick,
    liquidity: BigInt(rawLiquidity) & ((1n << 128n) - 1n), lpFee: Number(n >> 208n & ((1n << 24n) - 1n)) };
}
async function tickLiquidityNet(poolId: Hex, tick: number) {
  const poolSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
  const tickSlot = keccak256(encodeAbiParameters([{ type: "int24" }, { type: "bytes32" }],
    [tick, toHex(BigInt(poolSlot) + 4n, { size: 32 })]));
  const raw = BigInt(await client.readContract({ address: contracts.poolManager,
    abi: parseAbi(["function extsload(bytes32 slot) view returns(bytes32)"]), functionName: "extsload", args: [tickSlot] }));
  let liquidityNet = raw >> 128n;
  if (liquidityNet >= 1n << 127n) liquidityNet -= 1n << 128n;
  return liquidityNet;
}
async function trade(token: TokenRecord, key: V4PoolKey, currencyIn: Address, amountIn: bigint) {
  assert(service);
  const asset = ROBINHOOD_STOCKS.find((row) => sameAddress(row.address, token.quoteAddress))!;
  const side = sameAddress(currencyIn, asset.address) ? "buy" : "sell";
  const quoted = await service.quote(token.address, side, formatUnits(amountIn, side === "buy" ? asset.decimals : 18), 100);
  const deadline = (await client.getBlock()).timestamp + 300n;
  if (await allowance(currencyIn, creator, contracts.permit2) < amountIn)
    await send(currencyIn, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contracts.permit2, amountIn] }));
  await send(contracts.permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve",
    args: [currencyIn, contracts.router, amountIn, Number(deadline)] }));
  const tx = swapTransaction(key, currencyIn, amountIn, BigInt(quoted.amountOut), 100, deadline, contracts);
  const before = await Promise.all([balance(currencyIn, creator), balance(tx.currencyOut, creator)]);
  const sent = await send(tx.to, tx.data);
  const after = await Promise.all([balance(currencyIn, creator), balance(tx.currencyOut, creator)]);
  assert.equal(before[0] - after[0], amountIn);
  const amountOut = after[1] - before[1];
  assert(amountOut >= tx.minOut);
  assert.equal(amountOut, BigInt(quoted.amountOut));
  return { hash: sent.hash, estimatedGas: sent.estimatedGas, gasLimit: sent.gasLimit, gasUsed: sent.gasUsed,
    amountIn, amountOut, quotedOut: quoted.amountOut, minOut: tx.minOut, after: await poolState(token.poolId) };
}
async function launch(asset: typeof ROBINHOOD_STOCKS[number], firstBuy: boolean, amount: bigint, label: string) {
  assert(service && guard);
  const plan = await service.prepare({ name: `${asset.ticker} ${label} curve proof`, symbol: `C${asset.ticker.toUpperCase()}`,
    description: "Isolated 31337 acceptance; no mainnet transaction.", image: "", quoteAddress: asset.address }, creator,
    CURVE_POLICY, firstBuy ? { amount: formatUnits(amount, asset.decimals), slippageBps: 100 } : undefined);
  assert.equal(plan.curvePolicy, CURVE_POLICY);
  if (plan.approval?.required) await send(plan.approval.transaction.to, plan.approval.transaction.data);
  const simulation = await service.simulateLaunch(creator, plan.data);
  assert(simulation.valid && plan.transaction);
  assert(!await client.getCode({ address: plan.tokenAddress }), "Prepared token must not exist before creation");
  const before = [await balance(asset.address, creator), 0n];
  const sent = await send(plan.transaction.to, plan.transaction.data);
  await service.trackLaunch(sent.hash, plan.id);
  let token: TokenRecord;
  try { token = await service.register(sent.hash); }
  catch (error) {
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/launch-curve-registration-failure.json", JSON.stringify({ hash: sent.hash,
      receipt: sent.receipt, planId: plan.id, tokenAddress: plan.tokenAddress, poolId: plan.poolId }, serialize, 2));
    throw error;
  }
  testedTokens.push(token.address);
  assert.equal((await service.register(sent.hash)).address, token.address);
  assert.equal(token.curvePolicy, CURVE_POLICY);
  assert.equal(await client.readContract({ address: token.address, abi: erc20Abi, functionName: "totalSupply" }), SUPPLY);
  const after = await Promise.all([balance(asset.address, creator), balance(token.address, creator)]);
  let firstBuyReceipt: unknown;
  if (firstBuy) {
    assert(plan.firstBuy);
    assert.equal(before[0] - after[0], amount);
    assert.equal(after[1] - before[1], BigInt(plan.firstBuy.expectedAmountOut));
    assert(after[1] - before[1] >= BigInt(plan.firstBuy.minAmountOut));
    const events = sent.receipt.logs.flatMap<{ eventName: string; args: unknown }>((log) => {
      try { if (sameAddress(log.address, guard!)) return [decodeEventLog({ abi: launchGuardAbi, data: log.data, topics: log.topics })];
        if (sameAddress(log.address, ROBINHOOD_BUNDLER)) return [decodeEventLog({ abi: bundlerAbi, data: log.data, topics: log.topics })]; } catch { /* Other log. */ }
      return [];
    });
    assert.equal(events.filter((event) => event.eventName === "GuardedLaunch").length, 1);
    assert.equal(events.filter((event) => event.eventName === "Bundled").length, 1);
    assert.equal(await balance(asset.address, guard), 0n);
    assert.equal(await allowance(asset.address, guard, ROBINHOOD_BUNDLER), 0n);
    assert.equal(await allowance(asset.address, creator, guard), 0n);
    firstBuyReceipt = { events, amountIn: amount, amountOut: after[1] - before[1], minAmountOut: plan.firstBuy.minAmountOut,
      guardResidualBalance: "0", guardToBundlerAllowance: "0", creatorToGuardAllowance: "0" };
  } else assert.deepEqual(after, before);
  const state = (await service.state(token.address)).state;
  assert.equal(state.status, 2);
  assert.equal(state.poolKey.fee, 8_388_608);
  return { plan, token, key: state.poolKey, evidence: { firstBuy, tokenAddress: token.address, poolId: token.poolId,
    hash: sent.hash, estimatedGas: sent.estimatedGas, gasLimit: sent.gasLimit, gasUsed: sent.gasUsed,
    simulation, openingValuation: plan.openingValuation, firstBuyReceipt } };
}
async function fees(token: TokenRecord, key: V4PoolKey) {
  assert(service);
  const data = encodeFunctionData({ abi: claimFeesAbi, functionName: "collectFees", args: [token.poolId] });
  const quoteIs0 = sameAddress(key.currency0, token.quoteAddress);
  const results = [];
  for (const [account, signer] of [[creator, wallet], [treasury, treasuryWallet]] as const) {
    const preview = await service.fees(token.address, account);
    let paidQuote = 0n;
    for (const [kind, contract, expected] of [["hook", contracts.rehype, preview.trade], ["LP", contracts.initializer, preview.lp]] as const) {
      const before = await Promise.all([balance(token.quoteAddress, account), balance(token.address, account)]);
      const sent = await send(contract, data, signer);
      const after = await Promise.all([balance(token.quoteAddress, account), balance(token.address, account)]);
      const paid = after.map((value, index) => value - before[index]);
      assert.deepEqual(paid, quoteIs0 ? [expected.fees0, expected.fees1] : [expected.fees1, expected.fees0]);
      paidQuote += paid[0];
      results.push({ account, kind, hash: sent.hash, gasUsed: sent.gasUsed, paid });
    }
    assert(paidQuote > 0n);
  }
  return results;
}
try {
  const deployed = await receipt(await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex,
    args: [ROBINHOOD_BUNDLER], gas: 5_000_000n }));
  assert(deployed.contractAddress);
  guard = deployed.contractAddress;
  guardDeployment = { hash: deployed.transactionHash, gasUsed: deployed.gasUsed };
  config.launchGuard = guard;
  // Keep the isolated dependency explicit; production environment values cannot override it.
  service = new LaunchpadService({ config, rpcUrl: fork.rpc, dataDir, dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: guard, lifi: runtimeFromEnv(4663).lifi });
  assert(sameAddress((await service.config()).launchGuard!, guard));
  for (const ticker of priorAssetProof ? [] : tickers) {
    const asset = ROBINHOOD_STOCKS.find((row) => row.ticker === ticker)!;
    const total = parseUnits(["USDG", "MUSEGOD"].includes(ticker) ? "40" : "0.04", asset.decimals);
    const funding = await fund(asset, total);
    for (const firstBuy of [false, true]) {
      console.log(`Curve fork: ${ticker} ${firstBuy ? "protected atomic" : "plain"} launch / trades / fee claims`);
      const created = await launch(asset, firstBuy, total / 10n, firstBuy ? "Guarded" : "Plain");
      const buy = await trade(created.token, created.key, asset.address, total / 4n);
      const held = await balance(created.token.address, creator);
      const sell = await trade(created.token, created.key, created.token.address, held / 2n);
      const payouts = await fees(created.token, created.key);
      evidence.push({ asset, funding, ...created.evidence, buy, sell, payouts, feePolicy: FEE_POLICY,
        checks: ["canonical receipt registration", "exact input/output raw balances", "minimum outputs",
          "creator and treasury hook and LP fee receipt/payout equality", "guarded output and residual checks"] });
      console.log(`PASS: ${ticker} ${firstBuy ? "guarded" : "plain"}`);
    }
  }
  const weth = ROBINHOOD_STOCKS.find((row) => row.ticker === "WETH")!;
  const capital = await fund(weth, parseEther("100000"));
  const walk = await launch(weth, false, 0n, "Boundary");
  const [pool] = decodeAbiParameters(parseAbiParameters("(uint24 fee, int24 tickSpacing, int24 farTick, (int24 tickLower, int24 tickUpper, uint16 numPositions, uint256 shares)[] curves, (address beneficiary, uint96 shares)[] beneficiaries, address dopplerHook, bytes onInitializationDopplerHookCalldata, bytes graduationDopplerHookCalldata)"), walk.plan.prepared!.createParams.poolInitializerData);
  const tokenIs0 = sameAddress(walk.key.currency0, walk.token.address);
  const opening = await poolState(walk.token.poolId);
  for (let index = 0; index <= 18; index++) {
    const before = await poolState(walk.token.poolId);
    let effectiveLiquidity = before.liquidity;
    if (effectiveLiquidity === 0n) {
      // token1 starts exactly on the exclusive upper boundary. The first
      // zeroForOne swap crosses that initialized tick before consuming input.
      assert.equal(index, 0);
      assert.equal(tokenIs0, false);
      assert.equal(before.sqrtPriceX96, sqrtAt(-pool.curves[0].tickLower));
      effectiveLiquidity = -await tickLiquidityNet(walk.token.poolId, -pool.curves[0].tickLower);
    }
    assert(effectiveLiquidity > 0n);
    const canonicalTarget = index < 18 ? pool.curves[index].tickUpper : pool.curves[18].tickLower + 6940;
    const targetTick = tokenIs0 ? canonicalTarget : -canonicalTarget;
    const targetSqrt = sqrtAt(targetTick);
    const net = tokenIs0 ? ceilDiv(effectiveLiquidity * (targetSqrt - before.sqrtPriceX96), q96)
      : ceilDiv(effectiveLiquidity * q96 * (before.sqrtPriceX96 - targetSqrt), before.sqrtPriceX96 * targetSqrt);
    assert(net > 0n);
    // The initial fee calculation is only a starting estimate. Rehype may
    // charge along a different path than the pool's stored LP fee; calibrate
    // against the actual exact-input quoter rather than assume a net rate.
    const desiredOut = (tokenIs0
      ? effectiveLiquidity * q96 * (targetSqrt - before.sqrtPriceX96) / (targetSqrt * before.sqrtPriceX96)
      : effectiveLiquidity * (before.sqrtPriceX96 - targetSqrt) / q96) + 1n;
    let amountIn = ceilDiv(ceilDiv(net * 1_000_000n, 1_000_000n - BigInt(before.lpFee)) * 1_000_000n, 990_000n);
    let targetQuote: Awaited<ReturnType<LaunchpadService["quote"]>> | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      targetQuote = await service.quote(walk.token.address, "buy", formatUnits(amountIn, weth.decimals), 100);
      if (BigInt(targetQuote.amountOut) >= desiredOut) break;
      amountIn = ceilDiv(amountIn * 102n, 100n) + 1n;
    }
    assert(targetQuote && BigInt(targetQuote.amountOut) >= desiredOut, "Actual quote must cover the target price's asset delta");
    const result = await trade(walk.token, walk.key, weth.address, amountIn * 1_000_001n / 1_000_000n + 100n);
    boundaries.push({ index, tail: index === 18, canonicalTarget, targetTick, before, effectiveLiquidity,
      desiredOut, targetQuote, ...result });
    await saveBoundaryProgress();
    assert(tokenIs0 ? result.after.sqrtPriceX96 >= targetSqrt : result.after.sqrtPriceX96 <= targetSqrt,
      `The executed buy must cross actual SDK boundary ${index}`);
    assert(result.after.liquidity > 0n, "Price must retain active liquidity across every main boundary and into the tail");
    console.log(`PASS: WETH actual boundary ${index + 1}/19 tick ${result.after.tick}`);
  }
  const atTail = await poolState(walk.token.poolId);
  const held = await balance(walk.token.address, creator);
  const reverse = await trade(walk.token, walk.key, walk.token.address, held);
  const firstBoundary = tokenIs0 ? pool.curves[0].tickUpper : -pool.curves[0].tickUpper;
  assert(tokenIs0 ? reverse.after.tick < firstBoundary : reverse.after.tick > firstBoundary,
    "Selling acquired supply must reverse through all 18 main boundaries into the opening range");
  assert(reverse.after.liquidity > 0n);
  boundaries.push({ reverse: true, capital, opening, atTail, crossedMainBoundaries: 18, ...reverse });
  await saveBoundaryProgress();
  await service.store.close();
  service = new LaunchpadService({ config: { ...config, writesEnabled: false }, rpcUrl: fork.rpc, dataDir, dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: guard, lifi: runtimeFromEnv(4663).lifi });
  await service.reconcile();
  for (const token of testedTokens) assert(await service.store.token(token));
  if (process.env.LAUNCH_FORK_KEEP_RUNNING === "true") {
    const finishSignal = join(process.cwd(), ".cache", `launch-browser-done-${process.pid}`);
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/launch-browser-context.json", JSON.stringify({ rpc: fork.rpc, dataDir,
      creator, treasury, guard, executionChainId: 31337, deploymentChainId: 4663, tokens: testedTokens,
      finishSignal, browserWritesEnabled: false }, serialize, 2) + "\n");
    console.log("READY: isolated fork retained for browser verification; .cache/launch-browser-context.json");
    let browserDone = false;
    while (!browserDone) {
      try { browserDone = (await readFile(finishSignal, "utf8")).trim() === "done"; } catch { /* Await explicit finish signal. */ }
      if (!browserDone) await new Promise((done) => setTimeout(done, 1000));
    }
  }
} catch (error) {
  executionError = redact(error);
  throw error;
} finally {
  try {
    snapshotRestored = await fork.rpcCall("evm_revert", [snapshot]);
    assert.equal(snapshotRestored, true);
    if (service) {
      await service.reconcile();
      for (const token of testedTokens) assert.equal(await service.store.token(token), null);
    }
    assert.equal(fork.blockedUpstreamWrites(), 0);
  } catch (error) {
    cleanupError = redact(error);
    console.error(cleanupError);
    process.exitCode = 1;
  }
  try {
    await mkdir("docs/evidence", { recursive: true });
    await writeFile("docs/evidence/launch-curve-fork.json", JSON.stringify({
      scope: "Isolated mainnet-state fork, execution chain 31337; no production signing, deployment or writes.",
      observedAt: new Date().toISOString(), upstreamChainId: 4663, executionChainId: 31337, forkBlockNumber: fork.blockNumber,
      curvePolicy: CURVE_POLICY, sourceHash, guardArtifactHash, creator, treasury, guard, guardDeployment, snapshotRestored, blockedUpstreamWrites: fork.blockedUpstreamWrites(),
      phases: priorAssetProof ? [
        { scope: "5 paired assets plain + guarded, trades and fee payouts", forkBlockNumber: priorAssetProof.forkBlockNumber,
          sourceHash: priorAssetProof.sourceHash, guardArtifactHash: priorAssetProof.guardArtifactHash,
          guard: priorAssetProof.guard, snapshotRestored: priorAssetProof.snapshotRestored, blockedUpstreamWrites: priorAssetProof.blockedUpstreamWrites },
        { scope: "WETH all boundaries + tail + reverse", forkBlockNumber: fork.blockNumber,
          sourceHash, guardArtifactHash, guard, snapshotRestored },
      ] : [{ scope: "All acceptance paths in one fork", forkBlockNumber: fork.blockNumber, sourceHash, guardArtifactHash, guard, snapshotRestored }],
      mainnetTransactionsSubmitted: false, fullFlowPassed: !executionError && !cleanupError && evidence.length === 10 && boundaries.length === 20,
      executionError, cleanupError,
      gasModelScope: "Local EVM execution only; does not prove Robinhood Nitro sequencer or L1 gas costs.",
      assets: evidence, boundaries,
    }, serialize, 2) + "\n");
  } catch (error) { console.error(redact(error)); process.exitCode = 1; }
  await service?.store.close();
  await rm(dataDir, { recursive: true, force: true });
  await fork.stop();
}
assert.equal(evidence.length, 10);
assert.equal(boundaries.length, 20);
assert(!process.exitCode, "Acceptance evidence and cleanup must both complete before reporting success");
console.log("PASS: 5 pairs plain + guarded, 18 actual boundaries + tail + reverse, restart/reorg, no mainnet writes");
