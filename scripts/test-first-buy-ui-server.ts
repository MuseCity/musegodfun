/** Local-only UI fixture. Wallet, prices, balances, allowance, receipt, launch,
 * and lock behaviour are injected mocks, never real settlement evidence. */
import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { DopplerSDK, airlockAbi, computePoolId } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData,
  erc20Abi, formatUnits, http, keccak256, parseUnits, toHex, zeroAddress, type Address, type Hex } from "viem";
import { STOCKS, ROBINHOOD_STOCKS, ROBINHOOD_BUNDLER, BASE_BUNDLER_CODE_HASH, ROBINHOOD_BUNDLER_CODE_HASH,
  contractsFor, type RuntimeConfig, type TokenRecord } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { syntheticOpeningValuation } from "../tests/fixtures";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { buildLaunch } from "../src/lib/protocol";
import { serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { FIRST_BUY_PAYMENT_CONTRACTS, assertFirstBuyPaymentQuote, firstBuyFeeAbi, firstBuyPaymentAbi,
  firstBuyPaymentAssets, firstBuyPaymentInput, firstBuyReceiptOutput, type FirstBuyPaymentChain,
  type FirstBuyPaymentQuote } from "../src/lib/first-buy-payment";
import { bundlerAbi } from "../src/lib/first-buy-lock";

const PORT = Number(process.env.PORT || "5193");
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("Invalid local fixture port");
const creator = "0x1111111111111111111111111111111111111111" as Address;
const treasury = "0x2222222222222222222222222222222222222222" as Address;
const guard = "0x3333333333333333333333333333333333333333" as Address;
const token = "0x4444444444444444444444444444444444444444" as Address;
const dex = "0x5555555555555555555555555555555555555555" as Address;
const blockHash = `0x${"bb".repeat(32)}` as Hex;
const scope = "LOCAL UI FIXTURE: injected wallet/API/RPC/receipts only; no real wallet, chain funds, or settlement proof";
type Sent = { hash: Hex; chainId: FirstBuyPaymentChain; from: Address; to: Address; data: Hex; value: Hex; nonce: number;
  kind: "approval" | "payment" | "launch" | "claim" | "cancel"; status: "success" | "reverted" | "pending"; logs: any[] };
let mode = "success", unlocked = false;
const claimedChains = new Set<FirstBuyPaymentChain>();
const supportedCases = ["success", "reject_payment", "pending_payment", "launch_failure", "cancel_payment", "delayed_prices"];
const state = { scope, quotes: [] as any[], sends: [] as Sent[], prepare: [] as any[], registered: [] as TokenRecord[], claims: 0 };
const plans = new Map<FirstBuyPaymentChain, LaunchPlan>(), allowances = new Map<string, bigint>(), balances = new Map<string, bigint>();
const paymentQuotes = new Map<string, FirstBuyPaymentQuote>(), paymentOutputs = new Map<string, bigint>();
const facetCodes = new Map<FirstBuyPaymentChain, Hex>(), bundlerCodes = new Map<FirstBuyPaymentChain, Hex>();
for (const chain of [8453, 4663] as const) {
  const fixture = JSON.parse(await readFile(`tests/fixtures/lifi-${chain}-runtime.json`, "utf8"));
  if (keccak256(fixture.onchainBytecode) !== FIRST_BUY_PAYMENT_CONTRACTS[chain].runtimeHash) throw new Error("LI.FI runtime fixture hash mismatch");
  facetCodes.set(chain, fixture.onchainBytecode);
  const path = `.cache/first-buy-ui-bundler-${chain}.json`;
  let snapshot: any;
  try { snapshot = JSON.parse(await readFile(path, "utf8")); }
  catch {
    // Public verified source bytes only, never a wallet or chain provider.
    const response = await fetch(`https://sourcify.dev/server/v2/contract/${chain}/${ROBINHOOD_BUNDLER}?fields=runtimeBytecode`,
      { redirect: "manual", signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error("The public Bundler source snapshot is unavailable");
    const source: any = await response.json(); snapshot = { code: source.runtimeBytecode.onchainBytecode };
    await writeFile(path, JSON.stringify(snapshot));
  }
  if (keccak256(snapshot.code) !== (chain === 4663 ? ROBINHOOD_BUNDLER_CODE_HASH : BASE_BUNDLER_CODE_HASH)) throw new Error("Bundler source snapshot hash mismatch");
  bundlerCodes.set(chain, snapshot.code);
}
function config(chainId: FirstBuyPaymentChain): RuntimeConfig {
  return { mode: "fork", chainId: 31337, deploymentChainId: chainId, treasury, writesEnabled: true, blockReason: null,
    curvePolicy: CURVE_POLICY, launchGuard: guard, launchLockAvailable: true, feePolicy: FEE_POLICY };
}
function assets(chain: FirstBuyPaymentChain) { return chain === 4663 ? ROBINHOOD_STOCKS : STOCKS; }
function assetPrice(symbol: string) { return ["ETH", "WETH"].includes(symbol) ? 3000n : ["USDG", "USDC", "USDT"].includes(symbol) ? 1n : 100n; }
function decimals(chain: FirstBuyPaymentChain, address: string) {
  return [...assets(chain), ...firstBuyPaymentAssets(chain)].find((a) => a.address.toLowerCase() === address.toLowerCase())?.decimals ?? 18;
}
function balanceKey(chain: number, asset: string) { return `${chain}:${asset.toLowerCase()}`; }
function balance(chain: FirstBuyPaymentChain, asset: string) { return balances.get(balanceKey(chain, asset)) ?? 100n * 10n ** BigInt(decimals(chain, asset)); }
function rpcTransaction(sent: Sent) { return { hash: sent.hash, from: creator, to: sent.to, input: sent.data, value: sent.value, nonce: toHex(sent.nonce),
  gas: "0x5b8d80", gasPrice: "0x3b9aca00", blockHash: sent.status === "pending" ? null : blockHash,
  blockNumber: sent.status === "pending" ? null : "0x10", transactionIndex: sent.status === "pending" ? null : "0x0",
  type: "0x0", chainId: "0x7a69", v: "0xf4f5", r: "0x1", s: "0x1" }; }
function block(fullTransactions = false) { return { number: "0x20", hash: blockHash, parentHash: blockHash, timestamp: toHex(Math.floor(Date.now() / 1000)),
  gasLimit: "0x5f5e100", gasUsed: "0x0", baseFeePerGas: "0x3b9aca00", difficulty: "0x0", totalDifficulty: "0x0", size: "0x0", extraData: "0x",
  miner: treasury, nonce: "0x0000000000000000", logsBloom: `0x${"00".repeat(256)}`,
  transactions: state.sends.filter((s) => s.status !== "pending").map((s) => fullTransactions ? rpcTransaction(s) : s.hash) }; }
function paymentQuote(chain: FirstBuyPaymentChain, input: any): FirstBuyPaymentQuote {
  const normalized = firstBuyPaymentInput(chain, input), registry = FIRST_BUY_PAYMENT_CONTRACTS[chain], now = Date.now();
  const fee = normalized.amountIn / 400n, net = normalized.amountIn - fee;
  const expected = net * assetPrice(normalized.fromToken.symbol) * 10n ** BigInt(normalized.toToken.decimals) /
    (10n ** BigInt(normalized.fromToken.decimals) * assetPrice(normalized.toToken.symbol));
  const minimum = expected * BigInt(10_000 - input.slippageBps) / 10_000n, actual = expected * 997n / 1000n;
  const native = normalized.fromToken.address === zeroAddress, id = keccak256(toHex(`ui-quote-${chain}-${state.quotes.length}-${now}`));
  const swaps = [{ callTo: registry.feeForwarder, approveTo: registry.feeForwarder, sendingAssetId: normalized.fromToken.address,
    receivingAssetId: normalized.fromToken.address, fromAmount: normalized.amountIn, requiresDeposit: true,
    callData: native ? encodeFunctionData({ abi: firstBuyFeeAbi, functionName: "forwardNativeFees", args: [[{ recipient: "0xc06ebbefd94032b85424d51906e2a335efae264b", amount: fee }]] })
      : encodeFunctionData({ abi: firstBuyFeeAbi, functionName: "forwardERC20Fees", args: [normalized.fromToken.address, [{ recipient: "0xc06ebbefd94032b85424d51906e2a335efae264b", amount: fee }]] }) },
  { callTo: dex, approveTo: dex, sendingAssetId: normalized.fromToken.address, receivingAssetId: normalized.toToken.address,
    fromAmount: net, callData: "0x3f0bde251234" as Hex, requiresDeposit: false }];
  const q: FirstBuyPaymentQuote = { protocol: "lifi", id: `ui-fixture-${state.quotes.length}`, transactionId: id,
    integrator: "musegodfun", tool: "fixture", chainId: chain, account: creator, fromToken: normalized.fromToken, toToken: normalized.toToken,
    amountIn: normalized.amountIn.toString(), expectedOut: expected.toString(), minimumOut: minimum.toString(), slippageBps: input.slippageBps,
    quotedAt: now, expiresAt: now + 60_000, router: registry.diamond, facet: registry.facet, facetRuntimeHash: registry.runtimeHash,
    blockNumber: "32", blockHash, transaction: { to: registry.diamond,
      data: encodeFunctionData({ abi: firstBuyPaymentAbi, functionName: native ? "swapTokensMultipleV3NativeToERC20" : "swapTokensMultipleV3ERC20ToERC20",
        args: [id, "musegodfun", zeroAddress, creator, minimum, swaps] }), value: native ? normalized.amountIn.toString() : "0" },
    approval: native ? null : { token: normalized.fromToken.address, spender: registry.diamond, amount: normalized.amountIn.toString() },
    feeAmount: fee.toString(), feeUsd: formatUnits(fee * assetPrice(normalized.fromToken.symbol), normalized.fromToken.decimals),
    gasFeeUsd: "0.01", amountInUsd: formatUnits(normalized.amountIn * assetPrice(normalized.fromToken.symbol), normalized.fromToken.decimals) };
  assertFirstBuyPaymentQuote(q); paymentQuotes.set(q.transaction.data, q); paymentOutputs.set(id, actual);
  state.quotes.push({ chainId: chain, id, amountIn: q.amountIn, expectedOut: q.expectedOut, minimumOut: q.minimumOut, actualOutput: String(actual) });
  return q;
}
function prepare(chain: FirstBuyPaymentChain, payload: any): LaunchPlan {
  const draft = payload.draft, buy = payload.firstBuy, now = Date.now(), cfg = config(chain), contracts = contractsFor(cfg);
  const paired = assets(chain).find((a) => a.address.toLowerCase() === draft.quoteAddress.toLowerCase())!;
  const openingValuation = syntheticOpeningValuation(paired.address, String(assetPrice(paired.symbol)),
    { chainId: chain, quotedAt: now, sourceUpdatedAt: now, blockNumber: "32", blockHash });
  const sdk = new DopplerSDK<8453 | 4663>({ chainId: chain, publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }) });
  const params = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, treasury, openingValuation,
    keccak256(toHex(`fixture-launch-${state.prepare.length}`)), chain));
  const amountIn = parseUnits(buy?.amount || "0", paired.decimals), lockDays = buy?.lockDays || 0;
  const out = 543327925691014316198420n, minimum = out * BigInt(10_000 - (buy?.slippageBps || 100)) / 10_000n;
  const tokenIsCurrency0 = token.toLowerCase() < paired.address.toLowerCase();
  const poolKey = { currency0: tokenIsCurrency0 ? token : paired.address, currency1: tokenIsCurrency0 ? paired.address : token,
    fee: 8388608, tickSpacing: 10, hooks: contracts.initializer };
  const poolId = computePoolId(poolKey), deadline = Math.floor(openingValuation.expiresAt / 1000);
  const tx = amountIn ? { to: guard, value: 0n, data: lockDays ? encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuyLocked",
    args: [params, amountIn, minimum, BigInt(deadline), lockDays] }) : encodeFunctionData({ abi: launchGuardAbi,
    functionName: "createAndBuy", args: [params, amountIn, minimum, BigInt(deadline)] }) }
    : { to: contracts.airlock, value: 0n, data: encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [params] }) };
  const approval = amountIn ? { to: paired.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [guard, amountIn] }) } : undefined;
  const duration = BigInt(lockDays) * 86400n;
  const prepared = { chainId: chain, account: creator, airlock: contracts.airlock, createParams: params,
    prediction: { tokenAddress: token, poolOrHookAddress: token, governanceAddress: treasury, timelockAddress: treasury,
      poolKey, poolId, tokenIsCurrency0 }, transaction: tx, approvalTransaction: approval,
    devBuy: amountIn ? { exactAmountIn: amountIn, recipient: creator, bundler: ROBINHOOD_BUNDLER, simulatedAmountOut: out,
      vesting: { permissionlessClaim: false, cliffDuration: duration, vestingDuration: duration } } : undefined,
    gasEstimate: { status: "unavailable" as const } };
  const plan: LaunchPlan = { id: keccak256(tx.data), creator, data: tx.data, tokenAddress: token, poolId, draft, preparedAt: now,
    gas: null, openingValuation, feePolicy: FEE_POLICY, feeTreasury: treasury, curvePolicy: CURVE_POLICY,
    prepared: serializePrepared(prepared), transaction: { ...tx, value: "0" },
    firstBuy: amountIn ? { amount: buy.amount, amountIn: String(amountIn), expectedAmountOut: String(out), minAmountOut: String(minimum),
      slippageBps: buy.slippageBps, lockDays, deadline, recipient: creator, quoteAddress: paired.address, guard, bundler: ROBINHOOD_BUNDLER } : undefined,
    approval: amountIn ? { token: paired.address, spender: guard, amount: String(amountIn), required: true, transaction: { ...approval!, value: "0" } } : undefined };
  plans.set(chain, plan); state.prepare.push({ chainId: chain, amount: buy.amount, amountIn: String(amountIn), lockDays,
    quoteAddress: paired.address, planId: plan.id }); return plan;
}
function transferLog(asset: Address, from: Address, to: Address, amount: bigint) {
  return { address: asset, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]) };
}
function paymentLogs(q: FirstBuyPaymentQuote) {
  const actual = paymentOutputs.get(q.transactionId)!;
  return [{ address: q.router, topics: encodeEventTopics({ abi: firstBuyPaymentAbi, eventName: "LiFiGenericSwapCompleted", args: { transactionId: q.transactionId } }),
    data: encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [q.integrator, zeroAddress, creator, q.fromToken.address, q.toToken.address, BigInt(q.amountIn), actual]) },
  transferLog(q.toToken.address, q.router, creator, actual)];
}
function lock(chain: FirstBuyPaymentChain) {
  const record = state.registered.find((row) => row.deploymentChainId === chain)?.firstBuyLock;
  if (!record) return null;
  return { ...record, unlockAt: record.start + record.vestingDuration, claimedAmount: claimedChains.has(chain) ? record.totalAmount : "0",
    claimableAmount: unlocked && !claimedChains.has(chain) ? record.totalAmount : "0", ...(unlocked && !claimedChains.has(chain) ? { claimTransaction:
      { to: ROBINHOOD_BUNDLER, data: encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [token] }), value: "0" } } : {}) };
}
const app = express(); app.use(express.json({ limit: "128kb" }));
app.set("json replacer", (_key: string, value: unknown) => typeof value === "bigint" ? String(value) : value);
app.get("/test-state", (_req, res) => res.json({ ...state, case: mode, unlocked, sendCounts: Object.fromEntries(
  ["approval", "payment", "launch", "claim", "cancel"].map((kind) => [kind, state.sends.filter((row) => row.kind === kind).length])) }));
app.post("/test-case", (req, res) => { if (!supportedCases.includes(req.body.case)) { res.status(400).json({ error: "Unsupported fixture case" }); return; }
  mode = req.body.case; if (req.body.reset) { state.quotes.length = state.sends.length = state.prepare.length = state.registered.length = state.claims = 0;
    paymentQuotes.clear(); paymentOutputs.clear(); plans.clear(); allowances.clear(); balances.clear(); claimedChains.clear(); unlocked = false; }
  res.json({ scope, case: mode, supportedCases }); });
app.post("/test-unlock", (_req, res) => { unlocked = true; res.json({ scope, unlocked }); });
app.post("/test-wallet", (req, res) => {
  try {
    const tx = req.body.transaction, chain = Number(req.body.chainId) as FirstBuyPaymentChain;
    if (![8453, 4663].includes(chain) || tx.from?.toLowerCase() !== creator.toLowerCase()) throw new Error("Wrong fixture wallet scope");
    const q = paymentQuotes.get(tx.data), plan = plans.get(chain);
    const kind = q ? "payment" : tx.to.toLowerCase() === ROBINHOOD_BUNDLER.toLowerCase() ? "claim" :
      tx.to.toLowerCase() === guard.toLowerCase() || tx.to.toLowerCase() === contractsFor(config(chain)).airlock.toLowerCase() ? "launch" : "approval";
    if (kind === "payment" && mode === "reject_payment") { res.json({ reject: true }); return; }
    const hash = keccak256(toHex(`ui-send-${state.sends.length}-${Date.now()}`));
    const row: Sent = { hash, chainId: chain, from: creator, to: tx.to, data: tx.data, value: tx.value || "0x0",
      nonce: state.sends.length, kind, status: kind === "payment" && ["pending_payment", "cancel_payment"].includes(mode) ? "pending" :
        kind === "launch" && mode === "launch_failure" ? "reverted" : "success", logs: [] };
    if (kind === "approval") { const decoded = decodeFunctionData({ abi: erc20Abi, data: row.data });
      if (decoded.functionName !== "approve") throw new Error("Only token approvals are valid fixture transactions");
      allowances.set(`${chain}:${row.to.toLowerCase()}:${decoded.args[0].toLowerCase()}`, decoded.args[1]); }
    if (kind === "payment" && row.status === "success") {
      assertFirstBuyPaymentQuote(q!); row.logs = paymentLogs(q!);
      balances.set(balanceKey(chain, q!.fromToken.address), balance(chain, q!.fromToken.address) - BigInt(q!.amountIn));
      balances.set(balanceKey(chain, q!.toToken.address), balance(chain, q!.toToken.address) + paymentOutputs.get(q!.transactionId)!);
    }
    if (kind === "claim") { const position = lock(chain); if (!position?.claimTransaction) throw new Error("Fixture lock is not unlocked");
      row.logs = [transferLog(token, ROBINHOOD_BUNDLER, creator, BigInt(position.totalAmount))]; state.claims++; claimedChains.add(chain); }
    if (kind === "launch" && (!plan || plan.transaction?.data !== row.data)) throw new Error("Fixture launch differs from its prepared plan");
    state.sends.push(row);
    if (kind === "payment" && mode === "cancel_payment") state.sends.push({ ...row,
      hash: keccak256(toHex(`cancel-${row.hash}`)), to: creator, data: "0x", value: "0x0", kind: "cancel", status: "success", logs: [] });
    res.json({ hash, scope });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : "Fixture wallet rejected" }); }
});
app.post("/test-settle", (req, res) => {
  for (const row of state.sends.filter((row) => row.status === "pending")) {
    if (req.body.cancel) { const replacement = { ...row, hash: keccak256(toHex(`cancel-${row.hash}`)), kind: "cancel" as const,
      to: creator, data: "0x" as Hex, value: "0x0" as Hex, status: "success" as const, logs: [] }; state.sends.push(replacement); }
    else { row.status = "success"; const q = paymentQuotes.get(row.data); if (q) { row.logs = paymentLogs(q);
      balances.set(balanceKey(row.chainId, q.fromToken.address), balance(row.chainId, q.fromToken.address) - BigInt(q.amountIn));
      balances.set(balanceKey(row.chainId, q.toToken.address), balance(row.chainId, q.toToken.address) + paymentOutputs.get(q.transactionId)!); } }
  }
  res.json({ scope, settled: true });
});
app.use("/api", async (req, res) => {
  try {
    const match = /^\/chains\/(8453|4663)(\/.*)$/.exec(req.path), chain = (match ? Number(match[1]) : 4663) as FirstBuyPaymentChain;
    const path = match ? match[2] : req.path, payload = req.body;
    if (path === "/config") { res.json(config(chain)); return; }
    if (path === "/stocks") { res.json(assets(chain).map((a) => ({ ...a, verified: true, blockNumber: "32", totalSupply: "1000000000000000000000000", multiplierWad: null }))); return; }
    if (path === "/tokens") { res.json(state.registered.filter((t) => t.deploymentChainId === chain)); return; }
    if (path === "/first-buy/prices") {
      if (mode === "delayed_prices") await new Promise((done) => setTimeout(done, chain === 4663 ? 6000 : 100));
      const now = Date.now(); res.json({ chainId: chain, quotedAt: now, expiresAt: now + 60_000, referenceOnly: true,
        assets: firstBuyPaymentAssets(chain, req.query.pairedAsset as string | undefined).map((a) => ({ ...a,
          priceUsd: String(mode === "delayed_prices" && chain === 4663 && ["ETH", "WETH"].includes(a.symbol) ? 6000n : assetPrice(a.symbol)) })) }); return;
    }
    if (path === "/first-buy/quote") { res.json(paymentQuote(chain, payload)); return; }
    if (path === "/first-buy/verify") {
      const row = state.sends.find((s) => s.hash === payload.hash && s.chainId === chain);
      if (!row || row.status === "pending") { res.json({ status: "pending", hash: payload.hash, actualOutput: null, blockNumber: null, blockHash: null }); return; }
      assertFirstBuyPaymentQuote(payload.quote, Date.now(), true);
      if (row.data !== payload.quote.transaction.data || row.to.toLowerCase() !== payload.quote.router.toLowerCase() || BigInt(row.value) !== BigInt(payload.quote.transaction.value))
        throw new Error("Fixture payment receipt does not match quote");
      const actual = row.status === "success" ? firstBuyReceiptOutput(payload.quote, row.logs).toString() : null;
      res.json({ status: row.status, hash: row.hash, actualOutput: actual, blockNumber: "16", blockHash }); return;
    }
    if (path === "/launch/prepare") { res.json(prepare(chain, payload)); return; }
    if (path === "/launch/validate") { res.json({ valid: true, feePolicy: FEE_POLICY, curvePolicy: CURVE_POLICY }); return; }
    if (path === "/launch/simulate") { res.json({ valid: true, gas: "5000000", amountOut: plans.get(chain)?.firstBuy?.expectedAmountOut || null, simulatedAt: Date.now() }); return; }
    if (path === "/launch/track") { res.status(202).json({ status: "pending" }); return; }
    if (path === "/launch/register") {
      const plan = plans.get(chain)!;
      const sent = state.sends.find((s) => s.hash === payload.hash && s.kind === "launch" && s.status === "success");
      if (!sent) throw new Error("Fixture launch not confirmed");
      const lockDays = plan.firstBuy?.lockDays || 0, duration = lockDays * 86400;
      const registered: TokenRecord = { ...plan.draft, address: token, creator, poolId: plan.poolId, transactionHash: sent.hash,
        blockNumber: "16", createdAt: Date.now(), mode: "fork", deploymentChainId: chain, openingCap: "1.666666",
        openingValuation: plan.openingValuation, curvePolicy: CURVE_POLICY, feePolicy: FEE_POLICY, feeTreasury: treasury,
        ...(lockDays ? { firstBuyLock: { bundler: ROBINHOOD_BUNDLER, recipient: creator, totalAmount: plan.firstBuy!.expectedAmountOut,
          start: Math.floor(Date.now() / 1000), cliffDuration: duration, vestingDuration: duration, lockDays: lockDays as 30 | 90 | 365 } } : {}) };
      state.registered.push(registered); res.json(registered); return;
    }
    if (path.startsWith("/first-buy-lock/")) { res.json(lock(chain)); return; }
    if (/^\/tokens\/0x[\da-f]+$/i.test(path)) { const registered = state.registered.find((t) => t.deploymentChainId === chain), plan = plans.get(chain)!;
      res.json({ token: registered, state: { status: 2, numeraire: plan?.draft.quoteAddress,
        poolKey: (plan?.prepared as any)?.prediction.poolKey } }); return; }
    if (path.includes("/fees")) { res.json({ lp: { amount0: "0", amount1: "0" }, trade: { amount0: "0", amount1: "0" } }); return; }
    if (path.includes("/market") || path.includes("/chart")) { res.json([]); return; }
    if (path === "/rpc") {
      const one = (item: any) => {
        let result: any;
        const data = item.params?.[0]?.data || "0x", selector = data.slice(0, 10), to = item.params?.[0]?.to?.toLowerCase();
        if (item.method === "eth_chainId") result = "0x7a69";
        else if (item.method === "eth_blockNumber") result = "0x20";
        else if (["eth_getBlockByNumber", "eth_getBlockByHash"].includes(item.method)) result = block(item.params?.[1] === true);
        else if (item.method === "eth_getBalance") result = toHex(100n * 10n ** 18n);
        else if (item.method === "eth_estimateGas") result = "0x493e0";
        else if (["eth_gasPrice", "eth_maxPriorityFeePerGas"].includes(item.method)) result = "0x3b9aca00";
        else if (item.method === "eth_feeHistory") result = { oldestBlock: "0x1f", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.1], reward: [["0x3b9aca00"]] };
        else if (item.method === "eth_getTransactionCount") result = toHex(state.sends.length);
        else if (item.method === "eth_getCode") {
          const address = item.params[0].toLowerCase();
          result = address === FIRST_BUY_PAYMENT_CONTRACTS[chain].facet.toLowerCase() ? facetCodes.get(chain)
            : address === ROBINHOOD_BUNDLER.toLowerCase() ? bundlerCodes.get(chain) : "0x";
        } else if (item.method === "eth_call") {
          if (selector === "0xcdffacc6") result = encodeAbiParameters([{ type: "address" }], [FIRST_BUY_PAYMENT_CONTRACTS[chain].facet]);
          else if (selector === "0xdd62ed3e") { const call = decodeFunctionData({ abi: erc20Abi, data });
            result = toHex(allowances.get(`${chain}:${to}:${(call.args![1] as string).toLowerCase()}`) || 0n, { size: 32 }); }
          else if (selector === "0x70a08231") result = toHex(balance(chain, to), { size: 32 });
          else if (["0x736eac0b", "0x5fd9ae2e"].includes(selector)) result = "0x";
          else result = toHex(1n, { size: 32 }); // Explicitly injected allowlist/other read behaviour.
        } else if (item.method === "eth_getTransactionByHash") {
          const sent = state.sends.find((s) => s.hash === item.params[0]);
          result = sent ? rpcTransaction(sent) : null;
        } else if (item.method === "eth_getTransactionReceipt") {
          const sent = state.sends.find((s) => s.hash === item.params[0]);
          result = !sent || sent.status === "pending" ? null : { transactionHash: sent.hash, transactionIndex: "0x0", blockHash,
            blockNumber: "0x10", from: creator, to: sent.to, cumulativeGasUsed: "0x493e0", gasUsed: "0x493e0", contractAddress: null,
            logs: sent.logs.map((log, index) => ({ ...log, blockHash, blockNumber: "0x10", transactionHash: sent.hash, transactionIndex: "0x0", logIndex: toHex(index), removed: false })),
            logsBloom: `0x${"00".repeat(256)}`, status: sent.status === "reverted" ? "0x0" : "0x1", effectiveGasPrice: "0x3b9aca00", type: "0x0" };
        } else throw new Error(`Unexpected fixture RPC ${item.method}`);
        return { jsonrpc: "2.0", id: item.id, result };
      };
      res.json(Array.isArray(payload) ? payload.map(one) : one(payload)); return;
    }
    res.status(404).json({ error: `Unavailable fixture route ${path}`, scope });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : "Fixture error", scope }); }
});
const walletScript = `<script>
(() => { const account=${JSON.stringify(creator)}, listeners=new Map();
const provider={on(n,f){listeners.set(n,[...(listeners.get(n)||[]),f])},removeListener(n,f){listeners.set(n,(listeners.get(n)||[]).filter(x=>x!==f))},
async request(r){if(r.method==='eth_accounts'||r.method==='eth_requestAccounts')return[account];if(r.method==='eth_chainId')return'0x7a69';
if(r.method==='eth_sendTransaction'){const chainId=new URLSearchParams(location.search).get('chainId')==='8453'||location.pathname.startsWith('/token/base/')?8453:4663;
const response=await fetch('/test-wallet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chainId,transaction:r.params[0]})});const body=await response.json();
if(body.reject){const error=new Error('User rejected the fixture payment');error.code=4001;throw error}if(!response.ok)throw new Error(body.error);return body.hash}throw new Error('Unexpected fixture wallet method '+r.method)}};
window.ethereum=provider;const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'11111111-2222-4333-8444-555555555555',name:'LOCAL UI FIXTURE wallet',rdns:'fun.musegod.localtest',icon:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='},provider}}));
window.addEventListener('eip6963:requestProvider',announce);window.addEventListener('load',announce);
const original=setTimeout;window.setTimeout=(fn,ms,...args)=>original(fn,ms===120000?1000:ms,...args);
})();</script>`;
// Serve the same production-compiled assets used by the application; no Vite
// dev middleware, HMR socket, env-file loading, or injected product flags.
const builtHtml = await readFile("dist/index.html", "utf8");
app.use(express.static("dist", { index: false }));
app.use((_req, res) => { res.type("html").send(builtHtml.replace("<head>", `<head>${walletScript}`)); });
const server = app.listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({ scope, origin: `http://127.0.0.1:${PORT}`,
  create: `http://127.0.0.1:${PORT}/create?chainId=4663`, state: "/test-state", cases: supportedCases })));
process.on("SIGTERM", () => { server.close(); });
