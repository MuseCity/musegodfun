// Read-only comparison prototype. Deliberately not imported by the server,
// keeper, release gate or production proof parser. Structural support is not
// an accepted funds-provenance proof or permission to activate Base.
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData,
  erc20Abi, getAddress, keccak256, parseAbi, zeroHash, type Address, type Hex } from "viem";
import { sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_WETH } from "../src/lib/base-buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import { approvalProxyAbi, RELAY_ROUTER, relayRequestMetadata } from "../server/buyback";
import { BASE_NATIVE_RELAY_SOLVER, nativeCleanupErc20Abi, nativeRelayRouterAbi } from "../server/base-native-trace";

export const NO_TRACE_ENTRY_POINT = getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
export const noTraceEntryPointAbi = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
  "event BeforeExecution()",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
]);
export const noTraceAccountAbi = parseAbi([
  "function execute((address target,uint256 value,bytes data) call)",
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
]);
const wethAbi = parseAbi(["function withdraw(uint256 amount)", "function deposit() payable"]);
const cleanupAbi = parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]);
const depositAbi = parseAbi(["function depositNative(address depositor,bytes32 id)", "event RelayNativeDeposit(address from,uint256 amount,bytes32 id)"]);
const movementAbi = parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
export type NoTraceCall = { target: Address; value: bigint; data: Hex };
export type RawNoTraceLog = { address: Address; data: Hex; topics: readonly Hex[]; logIndex: Hex;
  transactionHash: Hex; blockHash: Hex; removed?: boolean };
export type RawNoTraceSnapshot = { chainId: number; transaction: { hash: Hex; from: Address; to: Address | null;
  input: Hex; value: Hex; blockHash: Hex; blockNumber: Hex; chainId?: Hex };
  receipt: { transactionHash: Hex; status: Hex; from: Address; to: Address | null; blockHash: Hex; blockNumber: Hex; logs: RawNoTraceLog[] };
  block: { hash: Hex; number: Hex; timestamp: Hex }; canonicalBlock: { hash: Hex; number: Hex } };
function requireFact(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function boundedData(data: Hex) { requireFact(/^0x([\da-f]{2})*$/i.test(data) && data.length <= 262146, "Unsupported calldata size/encoding"); }
function tagRequest(tag: Hex) {
  requireFact(/^0x[\da-f]{64}00$/i.test(tag), "Unsupported request tag");
  const request = `0x${tag.slice(2, 66).split("").reverse().join("")}` as Hex;
  requireFact(relayRequestMetadata(request) === tag.toLowerCase(), "Invalid request tag"); return request;
}
export function assertNoTraceSnapshot(snapshot: RawNoTraceSnapshot) {
  const { transaction: tx, receipt: receipt, block, canonicalBlock: canonical } = snapshot;
  requireFact([8453, 4663].includes(snapshot.chainId), "Wrong chain"); boundedData(tx.input);
  requireFact(!tx.chainId || BigInt(tx.chainId) === BigInt(snapshot.chainId), "Wrong transaction chain");
  requireFact(receipt.status === "0x1" && equal(tx.hash, receipt.transactionHash) && sameAddress(tx.from, receipt.from) &&
    !!tx.to && !!receipt.to && sameAddress(tx.to, receipt.to), "Mismatched/reverted transaction receipt");
  requireFact(equal(tx.blockHash, receipt.blockHash) && equal(receipt.blockHash, block.hash) && equal(block.hash, canonical.hash) &&
    BigInt(tx.blockNumber) === BigInt(receipt.blockNumber) && BigInt(block.number) === BigInt(receipt.blockNumber) &&
    BigInt(canonical.number) === BigInt(block.number), "Noncanonical snapshot");
  let previous = -1n;
  for (const log of receipt.logs) {
    requireFact(!log.removed && equal(log.transactionHash, tx.hash) && equal(log.blockHash, block.hash) && BigInt(log.logIndex) > previous,
      "Removed, duplicate, unordered or foreign receipt log"); previous = BigInt(log.logIndex);
  }
}
export function noTraceUserOperationHash(op: { sender: Address; nonce: bigint; initCode: Hex; callData: Hex;
  accountGasLimits: Hex; preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex }, chainId: number) {
  const packed = keccak256(encodeAbiParameters([
    { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
  ], [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits,
    op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)]));
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [packed, NO_TRACE_ENTRY_POINT, BigInt(chainId)]));
}
/** Single deployed v0.7 UserOp, with its exact execution-log window. No
 * assertion about historic implementation or signature-authority continuity. */
export function inspectNoTraceAutomationEnvelope(snapshot: RawNoTraceSnapshot, automation: Address) {
  assertNoTraceSnapshot(snapshot);
  requireFact(sameAddress(snapshot.transaction.to!, NO_TRACE_ENTRY_POINT) && BigInt(snapshot.transaction.value) === 0n,
    "Only the fixed EntryPoint handleOps envelope is supported");
  const decoded = decodeFunctionData({ abi: noTraceEntryPointAbi, data: snapshot.transaction.input });
  const [ops, beneficiary] = decoded.args;
  requireFact(ops.length === 1 && sameAddress(ops[0].sender, automation), "Multiple/foreign UserOperations are unsupported");
  requireFact(equal(encodeFunctionData({ abi: noTraceEntryPointAbi, functionName: "handleOps", args: [ops, beneficiary] }), snapshot.transaction.input),
    "Noncanonical EntryPoint calldata");
  const op = ops[0]; requireFact(op.initCode === "0x" && op.paymasterAndData === "0x", "Account creation/paymaster is unsupported");
  const userOpHash = noTraceUserOperationHash(op, snapshot.chainId);
  const events = snapshot.receipt.logs.filter(log => sameAddress(log.address, NO_TRACE_ENTRY_POINT)).flatMap(log => {
    try { return [{ log, event: decodeEventLog({ abi: noTraceEntryPointAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }) }]; }
    catch { return []; }
  });
  const starts = events.filter(row => row.event.eventName === "BeforeExecution");
  const ends = events.filter(row => row.event.eventName === "UserOperationEvent");
  requireFact(starts.length === 1 && ends.length === 1, "Ambiguous UserOperation event window");
  const end = ends[0]; requireFact(end.event.eventName === "UserOperationEvent", "UserOperation missing");
  requireFact(equal(end.event.args.userOpHash, userOpHash) && sameAddress(end.event.args.sender, automation) &&
    end.event.args.nonce === op.nonce && end.event.args.success && BigInt(end.event.args.paymaster) === 0n,
    "UserOperation hash/sender/nonce/success mismatch");
  requireFact(BigInt(starts[0].log.logIndex) < BigInt(end.log.logIndex), "Invalid execution-log window");
  const account = decodeFunctionData({ abi: noTraceAccountAbi, data: op.callData });
  const calls: readonly NoTraceCall[] = account.functionName === "execute" ? [account.args[0]] : account.args[0];
  requireFact(calls.length > 0 && calls.length <= 3 && calls.every(call => call.value === 0n && !sameAddress(call.target, automation)),
    "Unsupported account batch/self-call/value");
  requireFact(equal(encodeFunctionData({ abi: noTraceAccountAbi, functionName: account.functionName, args: account.args as never }), op.callData),
    "Noncanonical account calldata");
  return { userOpHash, calls, executionLogs: snapshot.receipt.logs.filter(log => BigInt(log.logIndex) > BigInt(starts[0].log.logIndex) &&
    BigInt(log.logIndex) < BigInt(end.log.logIndex)), implementationContinuity: "not_proven" as const };
}
/** Conservative narrow route: Base canonical WETH unwrap -> native deposit.
 * Native B20 DEX routes need a separate complete route review. */
export function inspectNoTraceSourceCalldata(data: Hex, automation: Address) {
  boundedData(data); const decoded = decodeFunctionData({ abi: approvalProxyAbi, data });
  const [tokens, amounts, calls, refund, nft, metadata] = decoded.args;
  requireFact(tokens.length === 1 && amounts.length === 1 && amounts[0] > 0n, "Ambiguous source token/input");
  const requestId = tagRequest(metadata);
  requireFact(sameAddress(refund, BASE_NATIVE_RELAY_SOLVER) && sameAddress(nft, BASE_NATIVE_RELAY_SOLVER), "Foreign source refund/NFT recipient");
  requireFact(calls.length === 2 && calls.every(call => !call.allowFailure && call.value === 0n), "Unknown source route/caught failure");
  requireFact(sameAddress(tokens[0], BASE_BUYBACK_WETH) && sameAddress(calls[0].target, BASE_BUYBACK_WETH), "B20/unknown route is outside the no-trace whitelist");
  const unwrap = decodeFunctionData({ abi: wethAbi, data: calls[0].callData });
  requireFact(unwrap.functionName === "withdraw" && unwrap.args[0] === amounts[0], "Source unwrap amount mismatch");
  requireFact(equal(calls[0].callData, encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [amounts[0]] })), "Noncanonical unwrap calldata");
  requireFact(sameAddress(calls[1].target, RELAY_ROUTER), "Foreign cleanup target");
  const cleanup = decodeFunctionData({ abi: cleanupAbi, data: calls[1].callData });
  requireFact(equal(calls[1].callData, encodeFunctionData({ abi: cleanupAbi, functionName: "cleanupNativeViaCall", args: cleanup.args })), "Noncanonical source cleanup calldata");
  requireFact(cleanup.args[0] === amounts[0] && sameAddress(cleanup.args[1], RELAY_DEPOSITORY), "Only positive exact native cleanup is supported");
  const deposit = decodeFunctionData({ abi: depositAbi, data: cleanup.args[2] });
  requireFact(deposit.functionName === "depositNative" && sameAddress(deposit.args[0], automation) && deposit.args[1] !== zeroHash,
    "Foreign/empty deposit account/order");
  requireFact(equal(cleanup.args[2], encodeFunctionData({ abi: depositAbi, functionName: "depositNative", args: deposit.args })), "Noncanonical deposit calldata");
  // Retained Relay v1 quotes append exactly their deposit order ID as a 32-byte
  // analytics footer. Accept only that bound suffix, never arbitrary tail data.
  const canonical = encodeFunctionData({ abi: approvalProxyAbi, functionName: "transferAndMulticall", args: decoded.args });
  requireFact(equal(data, canonical) || equal(data, `${canonical}${deposit.args[1].slice(2)}`), "Noncanonical source Proxy calldata/footer");
  return { requestId, orderId: deposit.args[1], metadata, sourceAmount: amounts[0], sourceCalldataHash: keccak256(data) };
}
export function inspectNoTraceSource(snapshot: RawNoTraceSnapshot, automation: Address) {
  requireFact(snapshot.chainId === 8453, "A same-chain Robinhood run is not a Base source proof");
  const envelope = inspectNoTraceAutomationEnvelope(snapshot, automation), proxies = envelope.calls.filter(call => sameAddress(call.target, RELAY_APPROVAL_PROXY));
  requireFact(proxies.length === 1, "Source ApprovalProxy call is not unique");
  const proxyIndex = envelope.calls.indexOf(proxies[0]);
  const route = inspectNoTraceSourceCalldata(proxies[0].data, automation);
  envelope.calls.forEach((call, index) => {
    if (index === proxyIndex) return;
    requireFact(sameAddress(call.target, BASE_BUYBACK_WETH), "Unsupported account side call");
    const approval = decodeFunctionData({ abi: erc20Abi, data: call.data });
    requireFact(approval.functionName === "approve" && sameAddress(approval.args[0], RELAY_APPROVAL_PROXY) &&
      approval.args[1] === (index < proxyIndex ? route.sourceAmount : 0n), "Unbounded/misordered account approval");
    requireFact(equal(call.data, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: approval.args })), "Noncanonical approval calldata");
  });
  const transfers = envelope.executionLogs.flatMap(log => { try { const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    return event.eventName === "Transfer" && event.args.value > 0n && sameAddress(event.args.from, automation) ? [{ log, args: event.args }] : []; } catch { return []; } });
  const deposits = envelope.executionLogs.filter(log => sameAddress(log.address, RELAY_DEPOSITORY)).flatMap(log => { try {
    const event = decodeEventLog({ abi: depositAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    return event.eventName === "RelayNativeDeposit" && sameAddress(event.args.from, automation) ? [{ log, args: event.args }] : []; } catch { return []; } });
  requireFact(transfers.length === 1 && sameAddress(transfers[0].log.address, BASE_BUYBACK_WETH) && sameAddress(transfers[0].args.to, RELAY_ROUTER) &&
    transfers[0].args.value === route.sourceAmount && deposits.length === 1 && equal(deposits[0].args.id, route.orderId) && deposits[0].args.amount === route.sourceAmount &&
    BigInt(transfers[0].log.logIndex) < BigInt(deposits[0].log.logIndex), "Missing/ambiguous source debit and exact deposit");
  return { ...route, userOpHash: envelope.userOpHash, implementationContinuity: envelope.implementationContinuity, status: "supported_structure" as const };
}
/** Direct fixed EOA -> Router; only canonical WETH wrap and one exact cleanup.
 * Arbitrary target calls or nested multicalls are intentionally unsupported. */
export function inspectNoTraceDestination(snapshot: RawNoTraceSnapshot, metadata: Hex, historicalProviderCode: Hex) {
  assertNoTraceSnapshot(snapshot); requireFact(snapshot.chainId === 4663, "Wrong destination chain"); tagRequest(metadata);
  requireFact(historicalProviderCode === "0x" && sameAddress(snapshot.transaction.from, BASE_NATIVE_RELAY_SOLVER) &&
    sameAddress(snapshot.transaction.to!, RELAY_ROUTER), "Destination must be a direct fixed EOA Router transaction");
  const decoded = decodeFunctionData({ abi: nativeRelayRouterAbi, data: snapshot.transaction.input });
  const [calls, refund, nft, tag] = decoded.args;
  requireFact(equal(snapshot.transaction.input, encodeFunctionData({ abi: nativeRelayRouterAbi, functionName: "multicall", args: decoded.args })), "Noncanonical destination Router calldata");
  requireFact(equal(tag, metadata) && sameAddress(refund, BASE_NATIVE_RELAY_SOLVER) && sameAddress(nft, BASE_NATIVE_RELAY_SOLVER), "Destination tag/refund mismatch");
  requireFact(calls.length === 2 && calls.every(call => !call.allowFailure) && sameAddress(calls[0].target, BASE_BUYBACK_RH_WETH) &&
    calls[0].value > 0n && BigInt(snapshot.transaction.value) === calls[0].value && sameAddress(calls[1].target, RELAY_ROUTER) && calls[1].value === 0n,
    "Unknown destination route/caught failure/value");
  requireFact(equal(calls[0].callData, encodeFunctionData({ abi: wethAbi, functionName: "deposit" })), "Destination funding is not canonical WETH wrap");
  const cleanup = decodeFunctionData({ abi: nativeCleanupErc20Abi, data: calls[1].callData }); const [tokens, recipients, amounts, cleanupTag] = cleanup.args;
  requireFact(equal(calls[1].callData, encodeFunctionData({ abi: nativeCleanupErc20Abi, functionName: "cleanupErc20s", args: cleanup.args })), "Noncanonical destination cleanup calldata");
  requireFact(tokens.length === 1 && recipients.length === 1 && amounts.length === 1 && sameAddress(tokens[0], BASE_BUYBACK_RH_WETH) &&
    sameAddress(recipients[0], BASE_BUYBACK_TREASURY) && amounts[0] === calls[0].value && equal(cleanupTag, metadata), "Destination exact positive cleanup mismatch");
  const transfers = snapshot.receipt.logs.filter(log => sameAddress(log.address, BASE_BUYBACK_RH_WETH)).flatMap(log => { try {
    const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }); return event.eventName === "Transfer" &&
      event.args.value > 0n && sameAddress(event.args.from, RELAY_ROUTER) && sameAddress(event.args.to, BASE_BUYBACK_TREASURY) ? [{ log, args: event.args }] : []; } catch { return []; } });
  const movements = snapshot.receipt.logs.filter(log => sameAddress(log.address, RELAY_ROUTER)).flatMap(log => { try {
    const event = decodeEventLog({ abi: movementAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }); return sameAddress(event.args.from, RELAY_ROUTER) &&
      sameAddress(event.args.to, BASE_BUYBACK_TREASURY) && sameAddress(event.args.currency, BASE_BUYBACK_RH_WETH) && equal(event.args.metadata, metadata) ? [{ log, args: event.args }] : []; } catch { return []; } });
  requireFact(transfers.length === 1 && movements.length === 1 && transfers[0].args.value === amounts[0] && movements[0].args.amount === amounts[0] &&
    BigInt(transfers[0].log.logIndex) < BigInt(movements[0].log.logIndex), "Destination receipt has ambiguous/inexact WETH settlement");
  return { status: "supported_structure" as const, outputAmount: amounts[0], transferLogIndex: transfers[0].log.logIndex,
    historicalRouterSemantics: "not_proven" as const, sourceOriginIsolation: false as const };
}

/** Real external native-ETH sample: two canonical value transfers and a
 * matching deposit ID. This neither authenticates our fixed solver nor proves
 * the application's WETH/Treasury flow or a cryptographic cross-chain link. */
export function inspectNoTraceDirectNativePair(source: RawNoTraceSnapshot, destination: RawNoTraceSnapshot, recipientCode: Hex) {
  assertNoTraceSnapshot(source); assertNoTraceSnapshot(destination);
  requireFact(source.chainId === 8453 && destination.chainId === 4663, "Wrong direct-native chain pair");
  requireFact(sameAddress(source.transaction.to!, RELAY_DEPOSITORY), "Source is not the fixed Depository");
  const deposit = decodeFunctionData({ abi: depositAbi, data: source.transaction.input });
  requireFact(deposit.functionName === "depositNative" && sameAddress(deposit.args[0], source.transaction.from) && deposit.args[1] !== zeroHash &&
    BigInt(source.transaction.value) > 0n, "Direct source deposit caller/value mismatch");
  requireFact(equal(source.transaction.input, encodeFunctionData({ abi: depositAbi, functionName: "depositNative", args: deposit.args })), "Noncanonical direct deposit calldata");
  const events = source.receipt.logs.filter(log => sameAddress(log.address, RELAY_DEPOSITORY)).flatMap(log => {
    try { const event = decodeEventLog({ abi: depositAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
      return event.eventName === "RelayNativeDeposit" ? [event] : []; } catch { return []; }
  });
  requireFact(events.length === 1 && sameAddress(events[0].args.from, source.transaction.from) && equal(events[0].args.id, deposit.args[1]) &&
    events[0].args.amount === BigInt(source.transaction.value), "Direct source receipt mismatch");
  requireFact(recipientCode === "0x" && sameAddress(destination.transaction.to!, deposit.args[0]) &&
    equal(destination.transaction.input, deposit.args[1]) && BigInt(destination.transaction.value) > 0n &&
    BigInt(destination.block.timestamp) >= BigInt(source.block.timestamp) && destination.receipt.logs.length === 0,
    "Direct destination value/tag/time/recipient mismatch");
  return { status: "observed_matching_canonical_receipts" as const, orderId: deposit.args[1],
    sourceNativeWei: BigInt(source.transaction.value), destinationNativeWei: BigInt(destination.transaction.value),
    destinationSender: destination.transaction.from, fixedProviderAuthenticated: false as const,
    projectWethTreasuryPolicy: false as const, cryptographicCrossChainProof: false as const };
}
