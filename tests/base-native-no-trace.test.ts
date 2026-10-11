import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, parseAbi, zeroAddress, zeroHash,
  type Abi, type Address, type Hex } from "viem";
import fixture from "./fixtures/native-relay-no-trace-mainnet.json";
import signedQuote from "./fixtures/native-relay-v1-signed-quote.json";
import { inspectNoTraceAutomationEnvelope, inspectNoTraceDestination, inspectNoTraceDirectNativePair, inspectNoTraceSource,
  inspectNoTraceSourceCalldata, noTraceAccountAbi, noTraceEntryPointAbi, noTraceUserOperationHash, NO_TRACE_ENTRY_POINT,
  type RawNoTraceLog, type RawNoTraceSnapshot } from "../scripts/base-native-no-trace";
import { BASE_NATIVE_RELAY_SOLVER, nativeCleanupErc20Abi, nativeRelayRouterAbi, nativeSolverExecutionAbi, verifyBaseNativeDestinationReceipt,
  type BaseNativeSourceFrame } from "../server/base-native-trace";
import { approvalProxyAbi, RELAY_ROUTER, relayRequestMetadata } from "../server/buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_WETH } from "../src/lib/base-buyback";
import { type PublicClient, type Transport } from "viem";

const automation = "0xAdA3348D6fC8EcF7cc2DbCA931D038b4B2913E3a" as Address;
const same = fixture.automation as unknown as RawNoTraceSnapshot;
const actualSource = fixture.source as unknown as RawNoTraceSnapshot, actualDestination = fixture.destination as unknown as RawNoTraceSnapshot;
const clone = <T>(v: T): T => structuredClone(v);
const order = `0x${"12".repeat(32)}` as Hex, request = `0x${"ab".repeat(32)}` as Hex, tag = relayRequestMetadata(request), amount = 100n;
const wethAbi = parseAbi(["function withdraw(uint256 amount)", "function deposit() payable"]);
const cleanupAbi = parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]);
const depositAbi = parseAbi(["function depositNative(address depositor,bytes32 id)", "event RelayNativeDeposit(address from,uint256 amount,bytes32 id)"]);
const movementAbi = parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
// Below this point synthetic receipts exist only to exercise narrow accepted
// layouts and hostile variations; the three imported captures are real reads.
function snapshot(chainId: number, from: Address, to: Address, input: Hex, value = 0n): RawNoTraceSnapshot {
  const hash = `0x${"34".repeat(32)}` as Hex, blockHash = `0x${"56".repeat(32)}` as Hex;
  return { chainId, transaction: { hash, blockHash, blockNumber: "0x10", from, to, input, value: `0x${value.toString(16)}` },
    receipt: { transactionHash: hash, blockHash, blockNumber: "0x10", from, to, status: "0x1", logs: [] },
    block: { hash: blockHash, number: "0x10", timestamp: "0x20" }, canonicalBlock: { hash: blockHash, number: "0x10" } };
}
function appendLog(s: RawNoTraceSnapshot, address: Address, abi: Abi, name: string, args: Record<string, unknown>) {
  const event = abi.find(row => row.type === "event" && row.name === name); assert.ok(event && event.type === "event");
  const log: RawNoTraceLog = { address, topics: encodeEventTopics({ abi, eventName: name, args } as never) as Hex[],
    data: encodeAbiParameters(event.inputs.filter(row => !row.indexed), event.inputs.filter(row => !row.indexed).map(row => args[row.name!]) as never),
    logIndex: `0x${s.receipt.logs.length.toString(16)}`, blockHash: s.block.hash, transactionHash: s.transaction.hash };
  s.receipt.logs.push(log); return log;
}
function sourceData() {
  return encodeFunctionData({ abi: approvalProxyAbi, functionName: "transferAndMulticall", args: [[BASE_BUYBACK_WETH], [amount], [
    { target: BASE_BUYBACK_WETH, value: 0n, allowFailure: false, callData: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [amount] }) },
    { target: RELAY_ROUTER, value: 0n, allowFailure: false, callData: encodeFunctionData({ abi: cleanupAbi, functionName: "cleanupNativeViaCall", args: [amount,
      RELAY_DEPOSITORY, encodeFunctionData({ abi: depositAbi, functionName: "depositNative", args: [automation, order] })] }) },
  ], BASE_NATIVE_RELAY_SOLVER, BASE_NATIVE_RELAY_SOLVER, tag] });
}
function source() {
  const callData = encodeFunctionData({ abi: noTraceAccountAbi, functionName: "execute", args: [{ target: RELAY_APPROVAL_PROXY, value: 0n, data: sourceData() }] });
  const op = { sender: automation, nonce: 7n, initCode: "0x" as Hex, callData, accountGasLimits: zeroHash, preVerificationGas: 0n,
    gasFees: zeroHash, paymasterAndData: "0x" as Hex, signature: "0x" as Hex };
  const s = snapshot(8453, zeroAddress, NO_TRACE_ENTRY_POINT, encodeFunctionData({ abi: noTraceEntryPointAbi, functionName: "handleOps", args: [[op], zeroAddress] }));
  appendLog(s, NO_TRACE_ENTRY_POINT, noTraceEntryPointAbi, "BeforeExecution", {});
  appendLog(s, BASE_BUYBACK_WETH, erc20Abi, "Transfer", { from: automation, to: RELAY_ROUTER, value: amount });
  appendLog(s, RELAY_DEPOSITORY, depositAbi, "RelayNativeDeposit", { from: automation, amount, id: order });
  appendLog(s, NO_TRACE_ENTRY_POINT, noTraceEntryPointAbi, "UserOperationEvent", { userOpHash: noTraceUserOperationHash(op, 8453), sender: automation,
    paymaster: zeroAddress, nonce: op.nonce, success: true, actualGasCost: 0n, actualGasUsed: 1n });
  return s;
}
function destination() {
  const s = snapshot(4663, BASE_NATIVE_RELAY_SOLVER, RELAY_ROUTER, encodeFunctionData({ abi: nativeRelayRouterAbi, functionName: "multicall", args: [[
    { target: BASE_BUYBACK_RH_WETH, allowFailure: false, value: amount, callData: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }) },
    { target: RELAY_ROUTER, allowFailure: false, value: 0n, callData: encodeFunctionData({ abi: nativeCleanupErc20Abi, functionName: "cleanupErc20s",
      args: [[BASE_BUYBACK_RH_WETH], [BASE_BUYBACK_TREASURY], [amount], tag] }) },
  ], BASE_NATIVE_RELAY_SOLVER, BASE_NATIVE_RELAY_SOLVER, tag] }), amount);
  appendLog(s, BASE_BUYBACK_RH_WETH, erc20Abi, "Transfer", { from: RELAY_ROUTER, to: BASE_BUYBACK_TREASURY, value: amount });
  appendLog(s, RELAY_ROUTER, movementAbi, "FundsMovement", { from: RELAY_ROUTER, to: BASE_BUYBACK_TREASURY, currency: BASE_BUYBACK_RH_WETH, amount, metadata: tag });
  return s;
}

test("real mined Splits operation: recompute v0.7 hash and isolate execution logs without a client/trace", () => {
  const result = inspectNoTraceAutomationEnvelope(same, automation);
  assert.equal(result.userOpHash, "0xa09c11b4ad8bf1b60b2b0f0668d3c771ee05a94cbc103c76629d2dc598df9a22");
  assert.equal(result.calls.length, 2); assert.equal(result.calls[0].data.slice(0, 10), "0x095ea7b3");
  assert.equal(result.calls[1].data.slice(0, 10), "0xe21fd0e9"); assert.equal(result.executionLogs.length, 16);
  assert.equal(result.implementationContinuity, "not_proven"); assert.equal(fixture.traceRequests, 0);
});
test("real same-chain run is never admitted as Base fee provenance", () => {
  assert.throws(() => inspectNoTraceSource(same, automation), /not a Base source/);
});
test("real third-party native receipts establish amounts/tag only, with all project/protocol proof flags false", () => {
  const result = inspectNoTraceDirectNativePair(actualSource, actualDestination, "0x");
  assert.equal(result.sourceNativeWei, 3748445073097782n); assert.equal(result.destinationNativeWei, 3738959352407765n);
  assert.equal(result.fixedProviderAuthenticated, false); assert.equal(result.projectWethTreasuryPolicy, false); assert.equal(result.cryptographicCrossChainProof, false);
  assert.throws(() => inspectNoTraceDestination(actualDestination, tag, "0x"), /fixed EOA/);
});
test("canonical positive WETH-only UserOp layout is structurally supported and remains unproved for historical implementation", () => {
  const result = inspectNoTraceSource(source(), automation); assert.equal(result.sourceAmount, amount); assert.equal(result.orderId, order);
  assert.equal(result.implementationContinuity, "not_proven");
});
test("strict direct wrap+cleanup layout is supported, without claiming Router code or source isolation", () => {
  const result = inspectNoTraceDestination(destination(), tag, "0x"); assert.equal(result.outputAmount, amount);
  assert.equal(result.historicalRouterSemantics, "not_proven"); assert.equal(result.sourceOriginIsolation, false);
});
for (const [name, change] of [
  ["reorged header", (s: RawNoTraceSnapshot) => { s.canonicalBlock.hash = zeroHash; }],
  ["foreign receipt", (s: RawNoTraceSnapshot) => { s.receipt.transactionHash = zeroHash; }],
  ["removed log", (s: RawNoTraceSnapshot) => { s.receipt.logs[1].removed = true; }],
  ["foreign log", (s: RawNoTraceSnapshot) => { s.receipt.logs[1].transactionHash = zeroHash; }],
  ["duplicate log index", (s: RawNoTraceSnapshot) => { s.receipt.logs[1].logIndex = s.receipt.logs[0].logIndex; }],
  ["reverted receipt", (s: RawNoTraceSnapshot) => { s.receipt.status = "0x0"; }],
] as const) test(`no-trace cannot replace canonical evidence with ${name}`, () => {
  const s = source(); change(s); assert.throws(() => inspectNoTraceSource(s, automation));
});
test("outer success does not admit a failed UserOperation", () => {
  const s = source(); const op = decodeFunctionData({ abi: noTraceEntryPointAbi, data: s.transaction.input }).args[0][0];
  s.receipt.logs.pop(); appendLog(s, NO_TRACE_ENTRY_POINT, noTraceEntryPointAbi, "UserOperationEvent", { userOpHash: noTraceUserOperationHash(op, s.chainId),
    sender: automation, paymaster: zeroAddress, nonce: 7n, success: false, actualGasCost: 0n, actualGasUsed: 1n });
  assert.equal(s.receipt.status, "0x1"); assert.throws(() => inspectNoTraceAutomationEnvelope(s, automation), /hash\/sender\/nonce\/success/);
});
test("same UserOperation evidence on a different chain cannot authenticate the envelope", () => {
  const s = source(); s.chainId = 4663; assert.throws(() => inspectNoTraceAutomationEnvelope(s, automation), /hash\/sender\/nonce\/success/);
});
test("a forged success event from an unrelated contract is ignored", () => {
  const s = source(); s.receipt.logs.at(-1)!.address = RELAY_ROUTER;
  assert.throws(() => inspectNoTraceAutomationEnvelope(s, automation), /Ambiguous UserOperation/);
});
test("a duplicate successful UserOperation event is never arbitrarily selected", () => {
  const s = source(), duplicate = clone(s.receipt.logs.at(-1)!); duplicate.logIndex = "0x4"; s.receipt.logs.push(duplicate);
  assert.throws(() => inspectNoTraceAutomationEnvelope(s, automation), /Ambiguous UserOperation/);
});
test("a Depository event with the Automation depositor cannot alone establish the input debit", () => {
  const s = source(); s.receipt.logs[1].address = BASE_BUYBACK_RH_WETH;
  assert.throws(() => inspectNoTraceSource(s, automation), /source debit/);
});
test("identical native deposits cannot alias into one source proof", () => {
  const s = source(), event = clone(s.receipt.logs[2]); s.receipt.logs.splice(3, 0, event);
  s.receipt.logs.forEach((log, index) => { log.logIndex = `0x${index.toString(16)}`; });
  assert.throws(() => inspectNoTraceSource(s, automation), /ambiguous source debit/);
});
test("actual retained B20 quote with opaque DEX calls is refused despite its well-formed calldata", () => {
  const quote = signedQuote as any, raw = quote.raw ?? quote;
  const data = raw.steps.find((step: any) => step.id === "deposit").items[0].data;
  assert.throws(() => inspectNoTraceSourceCalldata(data.data, data.from), /Unknown source route|B20/);
});
test("source Proxy allows only its exact order-ID footer, rejecting arbitrary trailing data", () => {
  const data = sourceData(); assert.equal(inspectNoTraceSourceCalldata(`${data}${order.slice(2)}`, automation).orderId, order);
  assert.throws(() => inspectNoTraceSourceCalldata(`${data}00`, automation), /Noncanonical source Proxy/);
  assert.throws(() => inspectNoTraceSourceCalldata(`${data}${zeroHash.slice(2)}`, automation), /footer/);
});
test("source amount-zero cleanup stays unsupported even with matching deposit events", () => {
  const decoded = decodeFunctionData({ abi: approvalProxyAbi, data: sourceData() });
  const calls = [...decoded.args[2]]; calls[1] = { ...calls[1], callData: encodeFunctionData({ abi: cleanupAbi, functionName: "cleanupNativeViaCall",
    args: [0n, RELAY_DEPOSITORY, encodeFunctionData({ abi: depositAbi, functionName: "depositNative", args: [automation, order] })] }) };
  const data = encodeFunctionData({ abi: approvalProxyAbi, functionName: "transferAndMulticall", args: [decoded.args[0], decoded.args[1], calls,
    decoded.args[3], decoded.args[4], decoded.args[5]] });
  assert.throws(() => inspectNoTraceSourceCalldata(data, automation), /positive exact/);
});
test("destination rejects outer and nested cleanup trailing bytes", () => {
  const s = destination(); s.transaction.input = `${s.transaction.input}00`;
  assert.throws(() => inspectNoTraceDestination(s, tag, "0x"), /Noncanonical destination Router/);
  const nested = destination(), d = decodeFunctionData({ abi: nativeRelayRouterAbi, data: nested.transaction.input });
  const calls = [...d.args[0]]; calls[1] = { ...calls[1], callData: `${calls[1].callData}00` };
  nested.transaction.input = encodeFunctionData({ abi: nativeRelayRouterAbi, functionName: "multicall", args: [calls, d.args[1], d.args[2], d.args[3]] });
  assert.throws(() => inspectNoTraceDestination(nested, tag, "0x"), /Noncanonical destination cleanup/);
});
test("zero cleanup, caught failure, extra call and inconsistent funding cannot pass matching logs", () => {
  for (const variant of ["zero", "allowFailure", "thirdCall", "wrapValue", "cleanupValue", "txValue"] as const) {
    const s = destination(), d = decodeFunctionData({ abi: nativeRelayRouterAbi, data: s.transaction.input });
    const calls = [...d.args[0]];
    if (variant === "zero" || variant === "cleanupValue") calls[1] = { ...calls[1], callData: encodeFunctionData({ abi: nativeCleanupErc20Abi,
      functionName: "cleanupErc20s", args: [[BASE_BUYBACK_RH_WETH], [BASE_BUYBACK_TREASURY], [variant === "zero" ? 0n : amount + 1n], tag] }) };
    if (variant === "allowFailure") calls[1] = { ...calls[1], allowFailure: true };
    if (variant === "thirdCall") calls.push({ ...calls[1] });
    if (variant === "wrapValue") calls[0] = { ...calls[0], value: amount + 1n };
    if (variant === "txValue") s.transaction.value = "0x0";
    s.transaction.input = encodeFunctionData({ abi: nativeRelayRouterAbi, functionName: "multicall", args: [calls, d.args[1], d.args[2], d.args[3]] });
    assert.throws(() => inspectNoTraceDestination(s, tag, "0x"), variant);
  }
});
test("valid receipt plus an arbitrary/nested destination call does not bypass the whitelist", () => {
  const s = destination(); const cleanup = encodeFunctionData({ abi: nativeCleanupErc20Abi, functionName: "cleanupErc20s", args: [[BASE_BUYBACK_RH_WETH], [BASE_BUYBACK_TREASURY], [amount], tag] });
  s.transaction.input = encodeFunctionData({ abi: nativeRelayRouterAbi, functionName: "multicall", args: [[
    { target: RELAY_APPROVAL_PROXY, allowFailure: false, value: 0n, callData: "0x" },
    { target: RELAY_ROUTER, allowFailure: false, value: 0n, callData: cleanup },
  ], BASE_NATIVE_RELAY_SOLVER, BASE_NATIVE_RELAY_SOLVER, tag] });
  assert.throws(() => inspectNoTraceDestination(s, tag, "0x"), /Unknown destination route/);
});
test("7702/delegated solver code cannot be treated as a fixed direct EOA", () => {
  assert.throws(() => inspectNoTraceDestination(destination(), tag, "0xef0100"), /fixed EOA/);
});
test("duplicate equal WETH transfers do not select an arbitrary receipt leg", () => {
  const s = destination(); appendLog(s, BASE_BUYBACK_RH_WETH, erc20Abi, "Transfer", { from: RELAY_ROUTER, to: BASE_BUYBACK_TREASURY, value: amount });
  assert.throws(() => inspectNoTraceDestination(s, tag, "0x"), /ambiguous\/inexact/);
});
test("direct native pair rejects changed tag, recipient, timing or executable recipient", () => {
  for (const change of [
    (s: RawNoTraceSnapshot) => { s.transaction.input = zeroHash; },
    (s: RawNoTraceSnapshot) => { s.transaction.to = zeroAddress; s.receipt.to = zeroAddress; },
    (s: RawNoTraceSnapshot) => { s.block.timestamp = "0x0"; },
  ]) { const s = clone(actualDestination); change(s); assert.throws(() => inspectNoTraceDirectNativePair(actualSource, s, "0x")); }
  assert.throws(() => inspectNoTraceDirectNativePair(actualSource, actualDestination, "0xef0100"));
});

test("historical unsigned wrap+cleanup structure cannot authenticate a production payment", async () => {
  await compareSyntheticDestination(false);
});
test("matching execution events and an extra call cannot authenticate an unsigned production root", async () => {
  await compareSyntheticDestination(true);
});
async function compareSyntheticDestination(extra: boolean) {
  const s = destination();
  const decoded = decodeFunctionData({ abi: nativeRelayRouterAbi, data: s.transaction.input }); const calls = [...decoded.args[0]];
  if (extra) { calls.unshift({ target: BASE_BUYBACK_RH_WETH, allowFailure: false, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [RELAY_ROUTER] }) });
    s.transaction.input = encodeFunctionData({ abi: nativeRelayRouterAbi, functionName: "multicall", args: [calls, decoded.args[1], decoded.args[2], decoded.args[3]] }); }
  const witness = (call: typeof calls[number]): RawNoTraceLog => ({ address: RELAY_ROUTER,
    topics: encodeEventTopics({ abi: nativeSolverExecutionAbi, eventName: "SolverCallExecuted" }) as Hex[],
    data: encodeAbiParameters(nativeSolverExecutionAbi[0].inputs, [call.target, call.callData, call.value]),
    logIndex: "0x0", blockHash: s.block.hash, transactionHash: s.transaction.hash });
  const witnessed = [...calls.slice(0, -1).map(witness), ...s.receipt.logs, witness(calls.at(-1)!)];
  const receipt = { ...s.receipt, transactionIndex: 0, status: "success", blockNumber: BigInt(s.receipt.blockNumber),
    logs: witnessed.map((log, logIndex) => ({ ...log, logIndex, blockNumber: BigInt(s.receipt.blockNumber), transactionIndex: 0, removed: false })) };
  const transaction = { ...s.transaction, transactionIndex: 0, chainId: 4663, type: "eip1559", value: BigInt(s.transaction.value),
    blockNumber: BigInt(s.transaction.blockNumber), v: 1n };
  let mockTraceCalls = 0; const runtime = "0x6001600055" as Hex;
  const client = { getChainId: async () => 4663, getTransactionReceipt: async () => receipt, getTransaction: async () => transaction,
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber,
      hash: blockNumber === 16n ? s.block.hash : zeroHash, parentHash: zeroHash, timestamp: BigInt(s.block.timestamp) }),
    getCode: async ({ address }: { address: Address }) => address.toLowerCase() === BASE_NATIVE_RELAY_SOLVER.toLowerCase() ? "0x" : runtime,
    request: async () => { mockTraceCalls++; throw new Error("Destination trace is disabled"); } } as unknown as PublicClient<Transport, any>;
  const frame: BaseNativeSourceFrame = { sourceTransactionHash: s.transaction.hash, sourceBlockNumber: "1", sourceBlockHash: zeroHash,
    sourceTransferLogIndex: 0, sourceDepositLogIndex: 1, sourceTimestamp: "1", sourceAsset: BASE_BUYBACK_WETH, sourceAmount: String(amount),
    sourceNativeDeposit: String(amount), requestId: request, orderId: order, metadata: tag, automation, sourceCalldataHash: zeroHash };
  // The retained prototype describes receipt structure only. Even plausible
  // success events cannot substitute for the current root/funding signatures.
  await assert.rejects(() => verifyBaseNativeDestinationReceipt(client, s.transaction.hash, frame), /Unsigned or unsupported destination transaction/);
  assert.equal(mockTraceCalls, 0);
  if (extra) assert.throws(() => inspectNoTraceDestination(s, tag, "0x"), /Unknown destination route/);
  else assert.equal(inspectNoTraceDestination(s, tag, "0x").outputAmount, amount);
}
