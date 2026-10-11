import test from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, parseAbiItem,
  type AbiEvent, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { BASE_NATIVE_RELAY_SOLVER, nativeDestinationTagMatches, nativeDestinationHasFixedProvider, NativeDestinationProviderPendingError, UnsupportedNativeCallTraceError, verifyBaseNativeDestinationReceipt, verifyBaseNativeSourceTrace, verifyBaseNativeTraceProof, nativeRelayRouterAbi, nativeCleanupErc20Abi, nativeSolverExecutionAbi } from "../server/base-native-trace";
import { approvalProxyAbi, BUYBACK_CODE_HASHES, RELAY_ROUTER } from "../server/buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_NATIVE_BUYBACK_PROTOCOL } from "../src/lib/base-buyback";
import { verifyBaseNativeRelayProof } from "../server/base-native-provenance";
import signedV1Quote from "./fixtures/native-relay-v1-signed-quote.json";
import destinationControl from "./fixtures/base-native-destination-control-mainnet.json";
import routerSemantics from "../docs/evidence/base-relay-router-receipt.json";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Public quote-only fixture extracted from .cache/base-native-route-audit/NVDAc-outbound.json.
// It was never broadcast. All receipts and callTracer responses below are simulated unit data.
// Retain the exact quoted source calldata so tests do not depend on an ignored cache or upstream service.
const QUOTE_ONLY = {
  "automation": "0xAdA3348D6fC8EcF7cc2DbCA931D038b4B2913E3a",
  "sourceAsset": "0xb20000000000000000000078ee7ce2fe4908108c",
  "sourceAmount": "4263301",
  "nativeAmount": "3995664749236744",
  "outputAmount": "3974519173266012",
  "requestId": "0x1791550882c3eec55611dbbc20643beb3339fa5e3632dbc70b084a3bb8a26d42",
  "orderId": "0x7cae0de29bd563a0776a5e9b561e11f798f2031d5005246e134efeb98b13b28e",
  "sourceData": "0xf9e4bab400000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000f70da97812cb96acdf810712aa562db8dfa3dbef000000000000000000000000f70da97812cb96acdf810712aa562db8dfa3dbef00000000000000000000000000000000000000000000000000000000000010a00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000b20000000000000000000078ee7ce2fe4908108c00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000410d850000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000da0000000000000000000000000b20000000000000000000078ee7ce2fe4908108c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b50000000000000000000000000000000000000000000000000000000000410d85000000000000000000000000000000000000000000000000000000000000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000b84e21fd0e900000000000000000000000000000000000000000000000000000000000000200000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f996000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000008400000000000000000000000000000000000000000000000000000000000000a800000000000000000000000000000000000000000000000000000000000000774d7a5c6b52756e795f680b0f7e0c2f21281dde6ef00000000000000000000000000410d8500000000000000000000000000410d85000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000004187549f2844fc494e9047d511aeef28bedc8171842e734b12780d59183f0a54e722be21d70f42cceaa80d7fc55684a041998d699a6a2ca7bc293a8a461cf7bb281c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000660000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f00000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000180000000000000000000000000003dccd700000000000000000000000000444e3200000000000000000000000000410d850000000000000000000e32093205120800000000000000000000000000000000000000ee29016d0000000f42400000000000000000000000000000001111110f0f73c0b2ef09ec012eae758b3e03a9020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ac8ea520000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000161f598cd00000000000000007b0e2e8300899b647d5ebc66f9d4fa3f16c540610000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002e00000000000000000000000000000000000000000000000000000000000000420000000000000000000000000b20000000000000000000078ee7ce2fe4908108c8000000000000000000000000000000400000000000000000000000000410d8500000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000410d853b9d6e0900000000000000015455c918e405a2831fbff8595c0aae35ee3db9d100000000000000000000000000000000000000000000000000000000000000800000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f996000000000000000000000000000000000000000000000000000000000000004000000000000000000000000020e5fad2661ee9eb0c04824524030af31943b62d000000000000000000000000ffb57e36d5b8bf4597abf0bbcfe764cfe8b121124000000000000000000000000000000000000000000000000000000000410d853b9d6e0900000000000000015455c918e405a2831fbff8595c0aae35ee3db9d100000000000000000000000000000000000000000000000000000000000000800000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f996000000000000000000000000000000000000000000000000000000000000004000000000000000000000000020e5fad2661ee9eb0c04824524030af31943b62d000000000000000000000000ffb57e36d5b8bf4597abf0bbcfe764cfe8b121120000000000000000000000004200000000000000000000000000000000000006800000000000000000000000ee29016d0000000000000000000e320932051208000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000e3209320512080000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee8000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b20000000000000000000078ee7ce2fe4908108c000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f0000000000000000000000000000000000000000000000000000000000410d85000000000000000000000000000000000000000000000000000e0db2103d56f70000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000000010000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f99600000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000410d8500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a97b22536f75726365223a2272656c6179222c22416d6f756e74496e555344223a22392e393732313031222c22416d6f756e744f7574555344223a22392e393730393535222c22416d6f756e744f7574223a2233393935363634373439323336373433222c22526f7574654944223a223737643163633336724a4a4a506f6c4d3a326235316232306551376849704c4632222c2254696d657374616d70223a313739313535303838327d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e45d1fe6a200000000000000000000000000000000000000000000000000000000000000000000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004449290c1c000000000000000000000000ada3348d6fc8ecf7cc2dbca931d038b4b2913e3a7cae0de29bd563a0776a5e9b561e11f798f2031d5005246e134efeb98b13b28e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002124d62a8bb3a480b07cbd2363e5af9333beb34602cbbd11655cee3c288055197100000000000000000000000000000000000000000000000000000000000000007cae0de29bd563a0776a5e9b561e11f798f2031d5005246e134efeb98b13b28e"
};
const address = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const sourceHash = hash(1), destinationHash = hash(2), runtime = "0x6001600055" as Hex;
const cleanupAbi = parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]);
const nativeDepositAbi = parseAbi(["function depositNative(address depositor,bytes32 id)"]);
const nativeDepositEvent = parseAbiItem("event RelayNativeDeposit(address from,uint256 amount,bytes32 id)");
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const movementEvent = parseAbiItem("event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)");
type TraceCall = { from: Address; to: Address; input: Hex; value: Hex; error?: string; calls: TraceCall[] };
function log(event: AbiEvent, contract: Address, args: Record<string, unknown>, tx: Hex, number: bigint, index: number) {
  const nonIndexed = event.inputs.filter(input => !input.indexed);
  return { address: contract, topics: encodeEventTopics({ abi: [event], args } as any), data: encodeAbiParameters(nonIndexed, nonIndexed.map(input => args[input.name!]) as any),
    blockNumber: number, blockHash: hash(Number(number)), transactionHash: tx, transactionIndex: 0, logIndex: index, removed: false };
}
function fixture() {
  const automation = getAddress(QUOTE_ONLY.automation), sourceAsset = getAddress(QUOTE_ONLY.sourceAsset);
  const sourceAmount = BigInt(QUOTE_ONLY.sourceAmount), nativeAmount = BigInt(QUOTE_ONLY.nativeAmount), outputAmount = BigInt(QUOTE_ONLY.outputAmount);
  const decoded = decodeFunctionData({ abi: approvalProxyAbi, data: QUOTE_ONLY.sourceData as Hex });
  const sourceCalls = decoded.args[2], cleanupIndex = sourceCalls.findIndex(call => call.target.toLowerCase() === RELAY_ROUTER);
  assert(cleanupIndex >= 0);
  const cleanup = decodeFunctionData({ abi: cleanupAbi, data: sourceCalls[cleanupIndex].callData });
  const depositData = cleanup.args[2], metadata = decoded.args[5];
  const sourceCall: TraceCall = { from: automation, to: RELAY_APPROVAL_PROXY, input: QUOTE_ONLY.sourceData as Hex, value: "0x0", calls: [] };
  const depositCall: TraceCall = { from: RELAY_ROUTER, to: RELAY_DEPOSITORY, input: depositData, value: `0x${nativeAmount.toString(16)}`, calls: [] };
  const routerCall: TraceCall = { from: RELAY_APPROVAL_PROXY, to: RELAY_ROUTER, input: encodeFunctionData({ abi: nativeRelayRouterAbi, functionName: "multicall", args: [sourceCalls, decoded.args[3], decoded.args[4], metadata] }), value: "0x0", calls: sourceCalls.map(call => ({ from: RELAY_ROUTER, to: call.target, input: call.callData, value: "0x0", calls: [] })) };
  routerCall.calls[cleanupIndex].calls.push(depositCall);
  const transferCall: TraceCall = { from: RELAY_APPROVAL_PROXY, to: sourceAsset, input: encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [automation, RELAY_ROUTER, sourceAmount] }), value: "0x0", calls: [] };
  sourceCall.calls = [transferCall, routerCall];
  const sourceTrace: TraceCall = { from: address(99), to: automation, input: "0x", value: "0x0", calls: [sourceCall] };
  // Simulated destination topology follows the official multicall/cleanupErc20s
  // ABI. This fixture is never evidence that a native cross-chain order settled.
  const destinationTokenCall:TraceCall={from:RELAY_ROUTER,to:BASE_BUYBACK_RH_WETH,input:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[BASE_BUYBACK_TREASURY,outputAmount]}),value:"0x0",calls:[]};
  const destinationCleanup:TraceCall={from:RELAY_ROUTER,to:RELAY_ROUTER,input:encodeFunctionData({abi:nativeCleanupErc20Abi,functionName:"cleanupErc20s",args:[[BASE_BUYBACK_RH_WETH],[BASE_BUYBACK_TREASURY],[0n],metadata]}),value:"0x0",calls:[destinationTokenCall]};
  const destinationInstructions=[{target:RELAY_ROUTER,allowFailure:false,value:0n,callData:destinationCleanup.input}];
  const destinationTrace: TraceCall = { from: BASE_NATIVE_RELAY_SOLVER, to: RELAY_ROUTER, input: encodeFunctionData({abi:nativeRelayRouterAbi,functionName:"multicall",args:[destinationInstructions,BASE_NATIVE_RELAY_SOLVER,BASE_NATIVE_RELAY_SOLVER,metadata]}), value: "0x0", calls: [destinationCleanup] };
  const sourceReceipt = { status: "success", transactionHash: sourceHash, blockNumber: 100n, blockHash: hash(100), transactionIndex: 0,
    logs: [log(transferEvent, sourceAsset, { from: automation, to: RELAY_ROUTER, value: sourceAmount }, sourceHash, 100n, 0),
      log(nativeDepositEvent, RELAY_DEPOSITORY, { from: automation, amount: nativeAmount, id: QUOTE_ONLY.orderId }, sourceHash, 100n, 1)] };
  const destinationReceipt = { status: "success", transactionHash: destinationHash, blockNumber: 200n, blockHash: hash(200), transactionIndex: 0,
    from: BASE_NATIVE_RELAY_SOLVER, to: RELAY_ROUTER,
    logs: [log(transferEvent, BASE_BUYBACK_RH_WETH, { from: RELAY_ROUTER, to: BASE_BUYBACK_TREASURY, value: outputAmount }, destinationHash, 200n, 0),
      log(movementEvent, RELAY_ROUTER, { from: RELAY_ROUTER, to: BASE_BUYBACK_TREASURY, currency: BASE_BUYBACK_RH_WETH, amount: outputAmount, metadata }, destinationHash, 200n, 1),
      log(nativeSolverExecutionAbi[0], RELAY_ROUTER, {to:RELAY_ROUTER,data:destinationCleanup.input,amount:0n},destinationHash,200n,2)] };
  const state = { sourceChainId: 8453, destinationChainId: 4663, sourceHead: 400n, destinationHead: 500n,
    sourceTimestamp: 1000n, destinationTimestamp: 1001n, sourceReorgAtRead: Infinity, destinationReorgAtRead: Infinity,
    sourceBlockReads: 0, destinationBlockReads: 0, destinationTraceRequests:0, changedSourceCode: undefined as Address | undefined, changedDestinationCode: false };
  const makeClient = (source: boolean) => ({
    getChainId: async () => source ? state.sourceChainId : state.destinationChainId,
    getBlockNumber: async () => source ? state.sourceHead : state.destinationHead,
    getTransactionReceipt: async ({ hash: value }: { hash: Hex }) => {
      assert.equal(value, source ? sourceHash : destinationHash); return source ? sourceReceipt : destinationReceipt;
    },
    getTransaction:async()=>({hash:source?sourceHash:destinationHash,from:source?sourceTrace.from:destinationTrace.from,to:source?sourceTrace.to:destinationTrace.to,input:source?sourceTrace.input:destinationTrace.input,
      value:0n,type:"eip1559",chainId:source?8453:4663,blockNumber:source?100n:200n,blockHash:hash(source?100:200),transactionIndex:0}),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const count = source ? ++state.sourceBlockReads : ++state.destinationBlockReads;
      return { number: blockNumber, parentHash:hash(Number(blockNumber)-1), hash: hash(count >= (source ? state.sourceReorgAtRead : state.destinationReorgAtRead) ? 999 : Number(blockNumber)),
        timestamp: source ? state.sourceTimestamp : state.destinationTimestamp };
    },
    getCode: async ({ address: candidate }: { address: Address }) => candidate.toLowerCase()===BASE_NATIVE_RELAY_SOLVER?"0x":source && candidate.toLowerCase() === state.changedSourceCode?.toLowerCase() || !source && state.changedDestinationCode ? "0x60026000fd" : runtime,
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      if(!source){state.destinationTraceRequests++;throw new Error("Destination must not request a trace");}
      assert.equal(method, "debug_traceTransaction"); assert.deepEqual(params, [source ? sourceHash : destinationHash, { tracer: "callTracer" }]);
      return source ? sourceTrace : destinationTrace;
    },
  }) as unknown as PublicClient<Transport, any>;
  const wrapper = (mutate: (args: typeof decoded.args) => typeof decoded.args) => {
    sourceCall.input = encodeFunctionData({ abi: approvalProxyAbi, functionName: "transferAndMulticall", args: mutate(structuredClone(decoded.args)) });
  };
  const sourceTransfer = (value: bigint, token = sourceAsset) => { sourceReceipt.logs[0] = log(transferEvent, token, { from: automation, to: RELAY_ROUTER, value }, sourceHash, 100n, 0); };
  const destinationTransfer = (value: bigint) => { destinationReceipt.logs[0] = log(transferEvent, BASE_BUYBACK_RH_WETH, { from: RELAY_ROUTER, to: BASE_BUYBACK_TREASURY, value }, destinationHash, 200n, 0);destinationTokenCall.input=encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[BASE_BUYBACK_TREASURY,value]}); };
  const destinationMovement = (value: bigint, tag = metadata) => { destinationReceipt.logs[1] = log(movementEvent, RELAY_ROUTER, { from: RELAY_ROUTER, to: BASE_BUYBACK_TREASURY, currency: BASE_BUYBACK_RH_WETH, amount: value, metadata: tag }, destinationHash, 200n, 1); };
  const destinationWitness=()=>{destinationReceipt.logs[2]=log(nativeSolverExecutionAbi[0],RELAY_ROUTER,{to:RELAY_ROUTER,data:destinationInstructions.at(-1)!.callData,amount:0n},destinationHash,200n,2);};
  return { source: makeClient(true), destination: makeClient(false), automation, sourceAsset, sourceAmount, nativeAmount, outputAmount, sourceTrace, sourceCall, routerCall, transferCall, depositCall, destinationTrace,
    sourceReceipt, destinationReceipt, destinationCleanup,destinationTokenCall,destinationInstructions,metadata, state, wrapper, sourceTransfer, destinationTransfer, destinationMovement,destinationWitness };
}
type Fixture = ReturnType<typeof fixture>;
async function withSimulatedCode<T>(run: () => Promise<T>): Promise<T> {
  const endpoints = [RELAY_APPROVAL_PROXY, RELAY_ROUTER, RELAY_DEPOSITORY], previous = endpoints.map(candidate => BUYBACK_CODE_HASHES[candidate.toLowerCase()]);
  for (const candidate of endpoints) BUYBACK_CODE_HASHES[candidate.toLowerCase()] = keccak256(runtime);
  try { return await run(); } finally { endpoints.forEach((candidate, index) => { BUYBACK_CODE_HASHES[candidate.toLowerCase()] = previous[index]; }); }
}
// Destination tests now use real signed roots/Permit2 witnesses in the separate
// base-native-destination-permit2 suite. This quote-only fixture proves Base source
// semantics only; fake hashes and an unsigned fixed-solver destination prove none.
test("simulated source trace preserves exact quote input, deposit, request and raw integers",async()=>withSimulatedCode(async()=>{
 const f=fixture(),frame=await verifyBaseNativeSourceTrace(f.source,sourceHash,f.automation);
 assert.equal(frame.requestId,QUOTE_ONLY.requestId);assert.equal(frame.orderId,QUOTE_ONLY.orderId);
 assert.equal(frame.sourceAsset.toLowerCase(),QUOTE_ONLY.sourceAsset.toLowerCase());assert.equal(frame.sourceAmount,QUOTE_ONLY.sourceAmount);
 assert.equal(frame.sourceNativeDeposit,QUOTE_ONLY.nativeAmount);assert.equal(frame.sourceCalldataHash,keccak256(QUOTE_ONLY.sourceData as Hex));
 assert.equal(frame.sourceTransferLogIndex,0);assert.equal(frame.sourceDepositLogIndex,1);
}));
const sourceFailures: [string, (f: Fixture) => void][] = [
  ["foreign source caller", f => { f.sourceCall.from = address(10); }],
  ["another source target", f => { f.sourceCall.to = address(10); }],
  ["undecodable source input", f => { f.sourceCall.input = "0x1234"; }],
  ["native value on token input", f => { f.sourceCall.value = "0x1"; }],
  ["duplicate source proxy execution", f => { f.sourceTrace.calls.push(structuredClone(f.sourceCall)); }],
  ["duplicate source token inputs", f => f.wrapper(args => [[...args[0], address(10)], [...args[1], 1n], ...args.slice(2)] as unknown as typeof args)],
  ["wrong source transfer token", f => f.sourceTransfer(f.sourceAmount, address(10))],
  ["partial source transfer", f => f.sourceTransfer(f.sourceAmount - 1n)],
  ["legacy fake ApprovalProxy recipient fixture", f => { f.sourceReceipt.logs[0] = log(transferEvent, f.sourceAsset, { from: f.automation, to: RELAY_APPROVAL_PROXY, value: f.sourceAmount }, sourceHash, 100n, 0); }],
  ["missing actual spender call", f => { f.sourceCall.calls = [f.routerCall]; }],
  ["wrong token spender caller", f => { f.transferCall.from = RELAY_ROUTER; }],
  ["wrong spender transferFrom recipient", f => { f.transferCall.input = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [f.automation, RELAY_APPROVAL_PROXY, f.sourceAmount] }); }],
  ["wrong actual Router wrapper calldata", f => { f.routerCall.input = "0x1234"; }],
  ["wrong actual Router caller", f => { f.routerCall.from = f.automation; }],
  ["foreign native depositor caller", f => { f.depositCall.from = RELAY_APPROVAL_PROXY; }],
  ["duplicate source spend logs", f => { f.sourceReceipt.logs.push({ ...f.sourceReceipt.logs[0], logIndex: 2 }); }],
  ["malformed source request tag", f => f.wrapper(args => [args[0], args[1], args[2], args[3], args[4], `${f.metadata.slice(0, -2)}01`] as unknown as typeof args)],
  ["unreviewed source refund recipient", f => f.wrapper(args => [args[0], args[1], args[2], address(10), args[4], args[5]])],
  ["source allowFailure", f => f.wrapper(args => [args[0], args[1], [{ ...args[2][0], allowFailure: true }, ...args[2].slice(1)], ...args.slice(3)] as unknown as typeof args)],
  ["wrong traced deposit calldata", f => { f.depositCall.input = encodeFunctionData({ abi: nativeDepositAbi, functionName: "depositNative", args: [f.automation, hash(555)] }); }],
  ["wrong actual native deposit value", f => { f.depositCall.value = "0x1"; }],
  ["wrong actual native deposit order", f => { f.sourceReceipt.logs[1] = log(nativeDepositEvent, RELAY_DEPOSITORY, { from: f.automation, amount: f.nativeAmount, id: hash(555) }, sourceHash, 100n, 1); }],
  ["duplicate native deposit logs", f => { f.sourceReceipt.logs.push({ ...f.sourceReceipt.logs[1], logIndex: 2 }); }],
  ["duplicate traced deposit execution", f => { f.sourceCall.calls.push(structuredClone(f.depositCall)); }],
  ["source receipt reverted", f => { f.sourceReceipt.status = "reverted"; }],
  ["failed source trace", f => { f.sourceCall.error = "execution reverted"; }],
  ["failed ancestor cannot authorize successful-looking child", f => { f.sourceTrace.error = "execution reverted"; }],
  ["failed deposit descendant", f => { f.depositCall.error = "execution reverted"; }],
  ["source RPC network mismatch", f => { f.state.sourceChainId = 4663; }],
  ["source receipt is not confirmed", f => { f.state.sourceHead = 100n; }],
  ["source block reorganized before trace", f => { f.state.sourceReorgAtRead = 1; }],
  ["source block reorganized after trace", f => { f.state.sourceReorgAtRead = 2; }],
];
for (const [name, mutate] of sourceFailures) test(`simulated native v2 rejects ${name}`, async () => withSimulatedCode(async () => {
  const f = fixture(); mutate(f); await assert.rejects(() => verifyBaseNativeSourceTrace(f.source, sourceHash, f.automation));
}));
for (const endpoint of [RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY, RELAY_ROUTER]) test(`simulated native v2 rejects changed source code at ${endpoint}`, async () => withSimulatedCode(async () => {
  const f = fixture(); f.state.changedSourceCode = endpoint;
  await assert.rejects(() => verifyBaseNativeSourceTrace(f.source, sourceHash, f.automation), /implementation/);
}));

test("source precision preserves exact input integers",async()=>withSimulatedCode(async()=>{
 const f=fixture(),raw=100000000000000000000000000001n;f.wrapper(args=>[args[0],[raw],args[2],args[3],args[4],args[5]]);f.sourceTransfer(raw);
 f.transferCall.input=encodeFunctionData({abi:erc20Abi,functionName:"transferFrom",args:[f.automation,RELAY_ROUTER,raw]});
 assert.equal((await verifyBaseNativeSourceTrace(f.source,sourceHash,f.automation)).sourceAmount,String(raw));
}));
test("source graph ignores zero/self logs but rejects every additional real source spend",async()=>withSimulatedCode(async()=>{
 const f=fixture();f.sourceReceipt.logs.push(log(transferEvent,f.sourceAsset,{from:f.automation,to:address(999),value:0n},sourceHash,100n,2),
 log(transferEvent,f.sourceAsset,{from:f.automation,to:f.automation,value:999n},sourceHash,100n,3));
 assert.equal((await verifyBaseNativeSourceTrace(f.source,sourceHash,f.automation)).sourceAmount,QUOTE_ONLY.sourceAmount);
 f.sourceReceipt.logs.push(log(transferEvent,f.sourceAsset,{from:f.automation,to:address(999),value:1n},sourceHash,100n,4));
 await assert.rejects(()=>verifyBaseNativeSourceTrace(f.source,sourceHash,f.automation),/input spending/);
}));
test("source call-tree resource bounds remain fail closed",async()=>withSimulatedCode(async()=>{
 const f=fixture();f.sourceTrace.calls.push(...Array.from({length:4097},()=>({from:address(900),to:address(901),input:"0x" as Hex,value:"0x0" as Hex,calls:[]})));
 await assert.rejects(()=>verifyBaseNativeSourceTrace(f.source,sourceHash,f.automation),UnsupportedNativeCallTraceError);
}));
for(const[name,mutate]of[
 ["wrong cleanup caller",(f:Fixture)=>{f.routerCall.calls.find(row=>row.input.startsWith("0x5d1fe6a2"))!.from=address(900);} ],
 ["wrong cleanup value",(f:Fixture)=>{f.routerCall.calls.find(row=>row.input.startsWith("0x5d1fe6a2"))!.value="0x1";} ],
 ["failed cleanup",(f:Fixture)=>{f.routerCall.calls.find(row=>row.input.startsWith("0x5d1fe6a2"))!.error="failed cleanup";} ],
 ["cleanup outside direct Router instruction",(f:Fixture)=>{const index=f.routerCall.calls.findIndex(row=>row.input.startsWith("0x5d1fe6a2")),cleanup=f.routerCall.calls.splice(index,1)[0];f.routerCall.calls.push({from:RELAY_ROUTER,to:address(900),input:"0x",value:"0x0",calls:[cleanup]});} ],
]as[string,(f:Fixture)=>void][])test(`source specific invocation rejects ${name}`,async()=>withSimulatedCode(async()=>{const f=fixture();mutate(f);await assert.rejects(()=>verifyBaseNativeSourceTrace(f.source,sourceHash,f.automation));}));
test("retained v1 signed quote cannot authorize an unsigned destination fixture",async()=>withSimulatedCode(async()=>{
 const f=fixture(),input={version:1 as const,protocol:BASE_NATIVE_BUYBACK_PROTOCOL as typeof BASE_NATIVE_BUYBACK_PROTOCOL,sourceHash,destinationHash,raw:structuredClone(signedV1Quote.raw)};
 await assert.rejects(()=>verifyBaseNativeRelayProof(f.source,f.destination,input,f.automation),/Unsigned/);
 const bad=structuredClone(input);bad.raw.protocol.v2.orderSignature=`0x${"00".repeat(65)}`;
 await assert.rejects(()=>verifyBaseNativeRelayProof(f.source,f.destination,bad,f.automation));
}));
test("receipt semantics evidence binds the exact recompiled runtime and event ABI",async()=>{
 assert.equal(routerSemantics.runtimeHash,BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()]);assert.equal(routerSemantics.fullRuntimeMatchParent,true);assert.equal(routerSemantics.fullRuntimeMatchTarget,true);
 const code=destinationControl.codes.target[RELAY_ROUTER as keyof typeof destinationControl.codes.target].code as Hex;
 assert.equal(keccak256(code),routerSemantics.runtimeHash);assert.equal((code.length-2)/2,4720);
 assert.deepEqual(encodeEventTopics({abi:nativeSolverExecutionAbi,eventName:"SolverCallExecuted"}),[routerSemantics.SolverCallExecutedTopic]);
 assert.deepEqual(routerSemantics.SolverCallExecutedAbi.inputs.map(({type,name,indexed})=>({type,name,indexed})),nativeSolverExecutionAbi[0].inputs.map(input=>({...input,indexed:!!("indexed" in input&&input.indexed)})));
 const input=await readFile(new URL(`../${routerSemantics.compilerInput.path}`,import.meta.url));
 assert.equal(createHash("sha256").update(input).digest("hex"),routerSemantics.compilerInput.sha256);
 assert.equal(routerSemantics.activation.projectFeeCanary,false);
});
