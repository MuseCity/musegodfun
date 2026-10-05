import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient, createWalletClient, decodeFunctionData, decodeEventLog, erc20Abi, http,
  getAddress, keccak256, parseAbi, parseAbiItem, parseEther, parseUnits, toHex, zeroAddress,
  type Address, type Hash, type Hex,
} from "viem";
import { base } from "viem/chains";
import { STOCKS, sameAddress } from "../src/lib/config";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import {
  approvalProxyAbi, BuybackReader, BUYBACK_CODE_HASHES, RELAY_ROUTER,
  validateRelayExecution,
} from "../server/buyback";
import { redact, runtimeFromEnv } from "../server/config";

// This script never creates a mainnet wallet client. Upstream RPC requests are
// read-only, including those forwarded on behalf of the isolated Anvil process.
const runtime = runtimeFromEnv();
assert.equal(runtime.config.mode, "base", "Run from the configured Base read provider");
const upstream = createPublicClient({ chain: base, transport: http(runtime.rpcUrl, { timeout: 30_000, retryCount: 1 }) });
assert.equal(await upstream.getChainId(), 8453);
const stock = STOCKS.find((item) => item.ticker === (process.env.TEST_STOCK || "NVDA"));
assert(stock, "Choose a whitelisted stock");
const amount = parseUnits("0.01", stock.decimals);
let resolvedBeforeFixObservations: unknown[] = [];
try {
  const previous = JSON.parse(await readFile("docs/evidence/musegod-source-fork.json", "utf8"));
  resolvedBeforeFixObservations = previous.resolvedBeforeFixObservations ?? previous.observations ?? [];
} catch { /* The first run has no previous observations. */ }
const binary = resolve(".cache/bin/base-anvil-v1.1.1/anvil");
await access(binary);
const forkChain = { ...base, id: 31337, name: "Isolated buyback source fork" };
// Resolve and verify a real holder before obtaining the short-lived quote.
const stockBalanceUpstream = (address: Address) => upstream.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
let donor: Address | undefined;
try {
  const previous = JSON.parse(await readFile(`docs/evidence/fork-flow-${stock.ticker}.json`, "utf8"));
  const candidate = getAddress(previous.donor);
  const [code, balance] = await Promise.all([upstream.getCode({ address: candidate }), stockBalanceUpstream(candidate)]);
  if ((!code || code === "0x" || /^0xef0100[0-9a-fA-F]{40}$/.test(code)) && balance >= amount) donor = candidate;
} catch { /* Discover from canonical logs if the hint is missing or stale. */ }
const discoveryBlock = await upstream.getBlockNumber({ cacheTime: 0 });
const visited = new Set<string>();
// Alchemy Free restricts eth_getLogs to ten blocks per request.
for (let window = 0; window < 100 && !donor; window++) {
  const end = discoveryBlock - BigInt(window) * 10n;
  const transfers = await upstream.getLogs({ address: stock.address,
    event: parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)"),
    fromBlock: end - 9n, toBlock: end });
  for (const candidate of transfers.flatMap((log) => [log.args.to, log.args.from])) {
    if (!candidate || sameAddress(candidate, zeroAddress) || visited.has(candidate.toLowerCase())) continue;
    visited.add(candidate.toLowerCase());
    if (await stockBalanceUpstream(candidate) < amount) continue;
    const code = await upstream.getCode({ address: candidate });
    if (!code || code === "0x" || /^0xef0100[0-9a-fA-F]{40}$/.test(code)) { donor = candidate; break; }
  }
}
assert(donor, "No genuine funded stock EOA found in bounded canonical transfer history");
await Promise.all(Object.entries(BUYBACK_CODE_HASHES).map(async ([address, expected]) => {
  const code = await upstream.getCode({ address: address as Address });
  assert(code && keccak256(code) === expected, "Live source contract identity must match before quoting");
}));
let child: ChildProcess | undefined;
let snapshot: string | undefined;
let snapshotReverted = false;
let rpc = "";
let evidence: Record<string, unknown> | undefined;
let upstreamWrites = 0;
let failureTracePath: string | undefined;
let failure: string | undefined;
const runContext: Record<string, unknown> = {
  scope: "Actual Base fork source attempt only; no mainnet broadcast, Robinhood settlement or burn",
  quoteChainId: 8453, executionChainId: 31337, mainnetTransactionSubmitted: false,
  resolvedBeforeFixObservations,
};

const proxy = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const part of request) {
      raw += part;
      if (raw.length > 1_000_000) throw new Error("RPC request too large");
    }
    const body = JSON.parse(raw);
    for (const item of Array.isArray(body) ? body : [body]) {
      if (!/^eth_get[A-Z]/.test(item.method) && ![
        "eth_call", "eth_blockNumber", "eth_chainId", "eth_gasPrice", "eth_feeHistory",
        "eth_maxPriorityFeePerGas", "net_version", "web3_clientVersion",
      ].includes(item.method)) {
        upstreamWrites++;
        throw new Error("Only read RPC may reach upstream");
      }
    }
    const result = await fetch(runtime.rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
      signal: AbortSignal.timeout(60_000),
    });
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(await result.text());
  } catch {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: -32000, message: "Read-only upstream unavailable" } }));
  }
});
async function port() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const value = (probe.address() as AddressInfo).port;
  await new Promise<void>((done, fail) => probe.close((error) => error ? fail(error) : done()));
  return value;
}
async function rpcCall(method: string, params: unknown[] = []) {
  assert.equal(new URL(rpc).hostname, "127.0.0.1");
  const response = await fetch(rpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert(!body.error, `Local fork RPC ${method} failed: ${body.error?.message ?? ""}`);
  return body.result;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child!.kill("SIGKILL"), 5000);
    child!.once("exit", () => { clearTimeout(timer); done(); });
    child!.kill("SIGTERM");
  });
}

try {
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const forkPort = await port();
  rpc = `http://127.0.0.1:${forkPort}`;
  // Keep provider keys out of argv, Anvil nodeInfo and child logs.
  const forkSource = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  // Relay blocks widely published Anvil default addresses. Use a fresh random
  // address unlocked only inside this fork; no private key or real wallet exists.
  const treasury = getAddress(`0x${randomBytes(20).toString("hex")}`);
  assert(!sameAddress(treasury, runtime.config.treasury ?? zeroAddress), "Use an isolated fork treasury");
  const quoteBlockBefore = await upstream.getBlockNumber({ cacheTime: 0 });
  const { quote, raw } = await new BuybackReader(treasury).prepareRoute({ stockAddress: stock.address, amount: "0.01" });
  const verified = await validateRelayExecution(quote, raw);
  const quoteBlockAfter = await upstream.getBlockNumber({ cacheTime: 0 });
  const expectedSourceNative = BigInt(raw.protocol.v2.orderData.inputs[0].payment.amount);
  const quotedSourceNativeMinimum = BigInt(raw.details.route.origin.outputCurrency.minimumAmount);
  const sourceNativeMinimum = (expectedSourceNative * 9900n + 9999n) / 10000n;
  const relayerNativeFee = BigInt(raw.fees.relayer.amount);
  const destinationNativeInput = BigInt(raw.details.route.destination.inputCurrency.amount);
  const cleanupAbi = parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]);
  const rebuilt = decodeFunctionData({ abi: approvalProxyAbi, data: verified.deposit.data });
  const rebuiltCleanup = decodeFunctionData({ abi: cleanupAbi, data: rebuilt.args[2][2].callData });
  const payment = rebuiltCleanup.args[0];
  assert.equal(quotedSourceNativeMinimum, expectedSourceNative * 9900n / 10000n,
    "Quoted source floor must match the API's 1% slippage and downward integer rounding");
  assert.equal(destinationNativeInput, quotedSourceNativeMinimum - relayerNativeFee);
  assert.equal(BigInt(raw.details.route.destination.inputCurrency.minimumAmount), destinationNativeInput);
  assert.equal(payment, sourceNativeMinimum, "Rebuilt deposit must fund exactly the validated source minimum");
  assert.equal(payment.toString(), verified.nativeDepositAmount);
  const kyberAbi = parseAbi([
    "function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256 returnAmount,uint256 gasUsed)",
  ]);
  const rebuiltSwap = decodeFunctionData({ abi: kyberAbi, data: rebuilt.args[2][1].callData });
  const originalProxy = decodeFunctionData({ abi: approvalProxyAbi,
    data: raw.steps.find((item: any) => item.id === "deposit").items[0].data.data });
  const originalSwap = decodeFunctionData({ abi: kyberAbi, data: originalProxy.args[2][1].callData });
  assert.equal(rebuiltSwap.args[0].desc.amount, amount);
  assert(rebuiltSwap.args[0].desc.minReturnAmount >= sourceNativeMinimum &&
    rebuiltSwap.args[0].desc.minReturnAmount >= originalSwap.args[0].desc.minReturnAmount,
  "Rebuilt source min must preserve upstream protection and guarantee the exact deposit");
  assert.equal(BigInt(raw.protocol.v2.orderData.output.payments[0].minimumAmount), BigInt(quote.minimumOut),
    "Destination signed MUSEGOD minimum must not be scaled down");
  Object.assign(runContext, { quoteBlockBefore: quoteBlockBefore.toString(), quoteBlockAfter: quoteBlockAfter.toString(),
    quoteTime: new Date(quote.quotedAt).toISOString(), quoteExpiry: new Date(quote.expiresAt).toISOString(),
    expectedSourceNative: expectedSourceNative.toString(), sourceNativeMinimum: sourceNativeMinimum.toString(),
    quotedSourceNativeMinimum: quotedSourceNativeMinimum.toString(),
    relayerNativeFee: relayerNativeFee.toString(), destinationNativeInput: destinationNativeInput.toString(),
    exactNativeDeposit: payment.toString(), signedMinimumMusegod: quote.minimumOut, sourceTreasury: treasury });
  // Pin only after the live quote, so lengthy holder discovery cannot leave
  // the simulated pool state dozens of blocks behind the quoted route.
  child = spawn(binary, ["--base", "--fork-url", forkSource, "--chain-id", "31337",
    "--fork-block-number", quoteBlockAfter.toString(),
    "--host", "127.0.0.1", "--port", String(forkPort), "--silent",
    "--retries", "3", "--fork-retry-backoff", "1500"], {
    cwd: resolve("."), env: { PATH: process.env.PATH, RUST_LOG: "error" }, stdio: "ignore",
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("Isolated Base Anvil exited before startup");
    try { ready = await rpcCall("eth_chainId") === "0x7a69"; } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert(ready, "Isolated Base Anvil must start on chain 31337");
  assert.match(await rpcCall("web3_clientVersion"), /anvil/i);
  const info = await rpcCall("anvil_nodeInfo");
  assert.equal(info.forkConfig.forkUrl, forkSource);
  const forkBlock = BigInt(info.forkConfig.forkBlockNumber);
  assert.equal(forkBlock, quoteBlockAfter);
  const client = createPublicClient({ chain: forkChain, transport: http(rpc, { timeout: 120_000, retryCount: 0 }) });
  const wallet = createWalletClient({ chain: forkChain, account: treasury, transport: http(rpc, { timeout: 120_000 }) });
  snapshot = await rpcCall("evm_snapshot");
  const snapshotTakenAt = new Date().toISOString();
  Object.assign(runContext, { forkBlock: forkBlock.toString(), snapshotTakenAt });
  await rpcCall("anvil_impersonateAccount", [treasury]);
  await rpcCall("anvil_setBalance", [treasury, toHex(parseEther("10"))]);
  const stockBalance = (address: Address) => client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  await Promise.all(Object.entries(BUYBACK_CODE_HASHES).map(async ([address, expected]) => {
    const code = await client.getCode({ address: address as Address });
    assert(code && code !== "0x");
    assert.equal(keccak256(code), expected, "Inspected source contract bytecode must match");
  }));
  const [decimals, donorCode, donorBalance] = await Promise.all([
    client.readContract({ address: stock.address, abi: erc20Abi, functionName: "decimals" }),
    client.getCode({ address: donor }), stockBalance(donor),
  ]);
  assert.equal(decimals, 8);
  assert(donorBalance >= amount && (!donorCode || donorCode === "0x" || /^0xef0100[0-9a-fA-F]{40}$/.test(donorCode)),
    "Previously discovered holder must still have genuine stock on the pinned fork");
  await rpcCall("anvil_impersonateAccount", [donor]);
  await rpcCall("anvil_setBalance", [donor, toHex(parseEther("1"))]);
  const donorWallet = createWalletClient({ chain: forkChain, account: donor, transport: http(rpc, { timeout: 120_000 }) });
  async function confirmed(hash: Hash, label = "funding") {
    // Match the repository's existing Base-fork harness: explicitly mine so
    // accepted local transactions cannot remain pending behind automine timing.
    await rpcCall("anvil_mine", [2]);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") {
      const trace = await rpcCall("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
      await mkdir(".cache", { recursive: true });
      failureTracePath = ".cache/buyback-source-fork-failure.json";
      Object.assign(runContext, { transactionHash: hash, receiptStatus: receipt.status, failedStep: label, diagnosticTrace: failureTracePath });
      await writeFile(failureTracePath, JSON.stringify({
        observedAt: new Date().toISOString(), executionChainId: 31337, forkBlock: forkBlock.toString(),
        quoteBlockBefore: quoteBlockBefore.toString(), quoteBlockAfter: quoteBlockAfter.toString(),
        quoteTime: new Date(quote.quotedAt).toISOString(), quoteExpiry: new Date(quote.expiresAt).toISOString(), snapshotTakenAt,
        label, transactionHash: hash, trace,
      }, null, 2) + "\n");
      throw new Error(`Local ${label} reverted; diagnostic trace saved in .cache/buyback-source-fork-failure.json`);
    }
    return receipt;
  }
  await confirmed(await donorWallet.writeContract({ address: stock.address, abi: erc20Abi,
    functionName: "transfer", args: [treasury, amount], gas: 200_000n }));
  await rpcCall("anvil_stopImpersonatingAccount", [donor]);
  console.log(`Base fork ${forkBlock}: genuine ${stock.ticker} holder funded isolated treasury for live Relay route`);
  const [beforeStock, beforeNative, beforeDepository] = await Promise.all([
    stockBalance(treasury), client.getBalance({ address: treasury }), client.getBalance({ address: RELAY_DEPOSITORY }),
  ]);
  const before = { stock: beforeStock, native: beforeNative, depository: beforeDepository };
  const intermediateNativeBefore: Record<string, string> = {};
  let refundableRouterDust = 0n;
  await Promise.all([RELAY_ROUTER, RELAY_APPROVAL_PROXY].map(async (address) => {
    const [value, stockValue] = await Promise.all([client.getBalance({ address }), stockBalance(address)]);
    intermediateNativeBefore[address] = value.toString();
    if (sameAddress(address, RELAY_ROUTER)) refundableRouterDust = value;
    assert.equal(stockValue, 0n, "Source intermediaries must begin without stock");
  }));
  assert.equal(quote.originChainId, 8453);
  assert.equal(quote.destinationChainId, 4663);
  assert(sameAddress(rebuilt.args[3], treasury) && sameAddress(rebuilt.args[4], treasury));
  assert.notEqual(verified.deposit.data, raw.steps.find((item: any) => item.id === "deposit").items[0].data.data,
    "Execution must use validated, rebuilt calldata");
  async function send(step: typeof verified.approval, gas: bigint) {
    assert.equal(await client.getChainId(), 31337, "Transactions may only reach this isolated fork");
    assert.equal(step.chainId, 8453, "Production step identity remains Base");
    assert(Date.now() < step.expiresAt, "Live Relay route must remain fresh at broadcast");
    return confirmed(await wallet.sendTransaction({ to: step.to, data: step.data, value: BigInt(step.value), gas }), step.kind);
  }
  const approval = await send(verified.approval, 200_000n);
  console.log("Exact source allowance confirmed; executing rebuilt Relay deposit on isolated fork");
  assert.equal(await client.readContract({ address: stock.address, abi: erc20Abi,
    functionName: "allowance", args: [treasury, RELAY_APPROVAL_PROXY] }), amount);
  const deposit = await send(verified.deposit, 8_000_000n);
  const after = { stock: await stockBalance(treasury), native: await client.getBalance({ address: treasury }),
    depository: await client.getBalance({ address: RELAY_DEPOSITORY }) };
  assert.equal(before.stock - after.stock, amount, "Only exact budgeted stock may be spent");
  assert.equal(after.depository - before.depository, payment, "Relay order must receive exactly the independently validated source minimum");
  // Verified canonical Depository ABI: all RelayNativeDeposit parameters are non-indexed.
  const depositAbi = parseAbi(["event RelayNativeDeposit(address from,uint256 amount,bytes32 id)"]);
  const deposits = deposit.logs.filter((log) => sameAddress(log.address, RELAY_DEPOSITORY)).flatMap((log) => {
    try { return [decodeEventLog({ abi: depositAbi, data: log.data, topics: log.topics })]; } catch { return []; }
  });
  assert.equal(deposits.length, 1);
  assert(sameAddress(deposits[0].args.from, treasury));
  assert.equal(deposits[0].args.amount, payment);
  assert.equal(deposits[0].args.id.toLowerCase(), verified.orderId.toLowerCase());
  const intermediateNativeAfter: Record<string, string> = {};
  for (const address of [RELAY_ROUTER, RELAY_APPROVAL_PROXY]) {
    // Router multicall refunds its entire balance. ApprovalProxy forwards only
    // msg.value; unrelated pre-existing ETH there must remain unchanged.
    const expected = sameAddress(address, RELAY_ROUTER) ? 0n : BigInt(intermediateNativeBefore[address]);
    const native = await client.getBalance({ address });
    intermediateNativeAfter[address] = native.toString();
    assert.equal(native, expected, "No native funds from this batch may remain in source intermediaries");
    assert.equal(await stockBalance(address), 0n, "Stock must not remain in source intermediaries");
  }
  assert.equal(await client.readContract({ address: stock.address, abi: erc20Abi,
    functionName: "allowance", args: [treasury, RELAY_APPROVAL_PROXY] }), 0n);
  const trace = await rpcCall("debug_traceTransaction", [deposit.transactionHash, { tracer: "callTracer" }]);
  type Call = { type?: string; from: Address; to?: Address; value?: Hex; input?: Hex; error?: string; calls?: Call[] };
  const calls: Call[] = [];
  const flatten = (call: Call) => { calls.push(call); for (const next of call.calls ?? []) flatten(next); };
  flatten(trace);
  assert(calls.length > 1 && !trace.error, "Actual source execution trace is required");
  const nativeCalls = calls.filter((call) => call.type === "CALL" && !call.error && BigInt(call.value ?? "0x0") > 0n);
  const incoming = (address: Address) => nativeCalls.filter((call) => call.to && sameAddress(call.to, address))
    .reduce((sum, call) => sum + BigInt(call.value!), 0n);
  const treasuryRefund = incoming(treasury);
  const swapNativeOutput = incoming(RELAY_ROUTER);
  assert.equal(incoming(RELAY_DEPOSITORY), payment);
  const batchSurplus = treasuryRefund - refundableRouterDust;
  assert(batchSurplus > 0n, "Live route must demonstrate a positive batch surplus, excluding pre-existing native dust");
  assert.equal(swapNativeOutput + refundableRouterDust, payment + treasuryRefund,
    "All ETH output and pre-existing Router dust must be deposited or refunded to treasury");
  const depositCalls = nativeCalls.filter((call) => call.to && sameAddress(call.to, RELAY_DEPOSITORY));
  assert.equal(depositCalls.length, 1);
  assert(depositCalls[0].input?.toLowerCase().endsWith(verified.orderId.slice(2).toLowerCase()),
    "Actual deposit calldata must include the verified order ID");
  let gasCost = 0n;
  for (const receipt of [approval, deposit]) {
    const rawReceipt = await rpcCall("eth_getTransactionReceipt", [receipt.transactionHash]);
    gasCost += receipt.gasUsed * receipt.effectiveGasPrice + BigInt(rawReceipt.l1Fee ?? "0x0");
  }
  assert.equal(after.native, before.native - gasCost + treasuryRefund, "Treasury native balance must reconcile with gas and all surplus");
  assert.equal(upstreamWrites, 0);
  evidence = {
    observedAt: new Date().toISOString(), status: "passed", sourceExecutionVerified: true,
    scope: "Actual Base fork source execution only; no mainnet broadcast, Robinhood settlement or burn",
    forkBlock: forkBlock.toString(), quoteBlockBefore: quoteBlockBefore.toString(), quoteBlockAfter: quoteBlockAfter.toString(),
    quoteTime: new Date(quote.quotedAt).toISOString(), quoteExpiry: new Date(quote.expiresAt).toISOString(), snapshotTakenAt,
    quoteChainId: 8453, executionChainId: 31337,
    stock: stock.address, symbol: stock.symbol, stockDecimals: stock.decimals,
    sourceTreasury: treasury, genuineStockDonor: donor, amountIn: amount.toString(),
    requestId: quote.requestId, orderId: verified.orderId,
    approvalHash: approval.transactionHash, depositHash: deposit.transactionHash,
    depositBlockHash: deposit.blockHash, depositBlockNumber: deposit.blockNumber.toString(),
    sourceNativeOutput: swapNativeOutput.toString(), expectedSourceNative: expectedSourceNative.toString(),
    quotedSourceNativeMinimum: quotedSourceNativeMinimum.toString(),
    sourceNativeMinimum: sourceNativeMinimum.toString(), exactNativeDeposit: payment.toString(),
    originalKyberMinimum: originalSwap.args[0].desc.minReturnAmount.toString(),
    rebuiltKyberMinimum: rebuiltSwap.args[0].desc.minReturnAmount.toString(),
    relayerNativeFee: relayerNativeFee.toString(), destinationNativeInput: destinationNativeInput.toString(),
    signedMinimumMusegod: quote.minimumOut,
    treasuryNativeSurplus: batchSurplus.toString(), treasuryTotalNativeRefund: treasuryRefund.toString(),
    intermediateNativeBefore, intermediateNativeAfter, refundedRouterDust: refundableRouterDust.toString(), gasCost: gasCost.toString(),
    balances: {
      stockBefore: before.stock.toString(), stockAfter: after.stock.toString(), actualStockSpent: (before.stock - after.stock).toString(),
      treasuryNativeBefore: before.native.toString(), treasuryNativeAfter: after.native.toString(),
      depositoryNativeBefore: before.depository.toString(), depositoryNativeAfter: after.depository.toString(),
      actualNativeDeposit: (after.depository - before.depository).toString(),
    },
    codeHashes: BUYBACK_CODE_HASHES, calldataRebuilt: true, exactAllowanceConsumed: true,
    relayNativeDepositEventVerified: true,
    intermediateBalances: "Router native and stock zero; ApprovalProxy native unchanged and stock zero; no new batch residue",
    upstreamWriteRequests: upstreamWrites,
    destinationSettlementVerified: false, mainnetTransactionSubmitted: false,
    resolvedBeforeFixObservations,
  };
} catch (error) {
  failure = redact(error);
  throw error;
} finally {
  try { if (snapshot) snapshotReverted = await rpcCall("evm_revert", [snapshot]); }
  finally {
    await stop();
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
    if (failureTracePath) {
      const diagnostic = JSON.parse(await readFile(failureTracePath, "utf8"));
      await writeFile(failureTracePath, JSON.stringify({ ...diagnostic, snapshotReverted, isolatedNodeStopped: true }, null, 2) + "\n");
    }
    if (failure) {
      await mkdir("docs/evidence", { recursive: true });
      await writeFile("docs/evidence/musegod-source-fork.json", JSON.stringify({
        ...runContext, observedAt: new Date().toISOString(), status: "blocked", error: failure,
        snapshotReverted, isolatedNodeStopped: true, upstreamWriteRequests: upstreamWrites,
        sourceExecutionVerified: false, destinationSettlementVerified: false,
      }, null, 2) + "\n");
    }
    if (snapshot) assert(snapshotReverted, "Fork snapshot must be restored on both success and failure");
  }
}
assert(snapshotReverted, "Fork snapshot must be restored");
assert(evidence);
await mkdir("docs/evidence", { recursive: true });
await writeFile("docs/evidence/musegod-source-fork.json", JSON.stringify({ ...evidence, snapshotReverted, isolatedNodeStopped: true }, null, 2) + "\n");
console.log("PASS: live Relay source calldata executed on chain 31337; exact stock/payment, positive treasury surplus and zero intermediary residue; snapshot restored");
