import { decodeEventLog, decodeFunctionData, erc20Abi, keccak256, parseAbi, zeroHash, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_NATIVE_BUYBACK_PROTOCOL, type BaseNativeRelayEvidence, type BaseNativeRelayProofInput } from "../src/lib/base-buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import { approvalProxyAbi, BUYBACK_CODE_HASHES, RELAY_ROUTER, relayRequestMetadata } from "./buyback";
import { canonicalBaseReceipt } from "./base-buyback";
type Client=PublicClient<Transport,any>;
export const BASE_NATIVE_RELAY_SOLVER="0xf70da97812cb96acdf810712aa562db8dfa3dbef" as Address;
const cleanupAbi=parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]);
const depositAbi=parseAbi(["function depositNative(address depositor,bytes32 id)","event RelayNativeDeposit(address from,uint256 amount,bytes32 id)"]);
const movementAbi=parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
const hash=(value:unknown):value is Hex=>typeof value==="string"&&/^0x[\da-f]{64}$/i.test(value);
type Call={from?:string;to?:string;input?:string;value?:string;error?:string;calls?:Call[]};
function calls(trace:unknown):Call[] {
 const output:Call[]=[];let visited=0;
 function walk(value:any,depth:number,failed=false){if(!value||typeof value!=="object"||Array.isArray(value)||++visited>4096||depth>128)throw new Error("Unsupported native call trace");failed ||=!!value.error;
  if(!failed)output.push(value);if(Array.isArray(value.calls))for(const child of value.calls)walk(child,depth+1,failed);}
 walk(trace,0);return output;
}
function decodeTransfers(receipt:Awaited<ReturnType<typeof canonicalBaseReceipt>>) {
 return receipt.logs.flatMap(log=>{try{const event=decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics,strict:true});return event.eventName==="Transfer"?[{log,args:event.args}]:[];}catch{return[];}});
}
export type BaseNativeSourceFrame={sourceTransactionHash:Hex;sourceBlockNumber:string;sourceBlockHash:Hex;sourceTransferLogIndex:number;sourceDepositLogIndex:number;
 sourceTimestamp:string;sourceAsset:Address;sourceAmount:string;sourceNativeDeposit:string;requestId:Hex;orderId:Hex;metadata:Hex;automation:Address;sourceCalldataHash:Hex};
/** Extracts what actually executed. No quote is obtained, prepared or renewed. */
export async function verifyBaseNativeSourceTrace(source:Client,sourceHash:Hex,automation:Address):Promise<BaseNativeSourceFrame> {
 if(!hash(sourceHash))throw new Error("Invalid native source hash");
 const receipt=await canonicalBaseReceipt(source,sourceHash,8453);if(receipt.status!=="success")throw new Error("Native source reverted");
 const trace=await source.request({method:"debug_traceTransaction" as any,params:[sourceHash,{tracer:"callTracer"}] as any});
 const edges=calls(trace).filter(call=>!!call.from&&!!call.to&&sameAddress(call.from,automation)&&sameAddress(call.to,RELAY_APPROVAL_PROXY));
 if(edges.length!==1||!edges[0].input||BigInt(edges[0].value??"0x0")!==0n)throw new Error("Unsupported or ambiguous native Automation source call");
 const data=edges[0].input as Hex,decoded=decodeFunctionData({abi:approvalProxyAbi,data}),[tokens,amounts,sourceCalls,refundTo,nftRecipient,metadata]=decoded.args;
 if(decoded.functionName!=="transferAndMulticall"||tokens.length!==1||amounts.length!==1||amounts[0]<=0n||sourceCalls.length<1||sourceCalls.length>8||sourceCalls.some(call=>call.allowFailure||call.value!==0n)||
  !/^0x[\da-f]{64}00$/i.test(metadata)||!sameAddress(refundTo,BASE_NATIVE_RELAY_SOLVER)||!sameAddress(nftRecipient,BASE_NATIVE_RELAY_SOLVER))throw new Error("Unsupported native source parameters");
 const requestId=`0x${metadata.slice(2,66).split("").reverse().join("")}` as Hex;if(relayRequestMetadata(requestId)!==metadata.toLowerCase())throw new Error("Unsupported native request tag");
 const cleanups=sourceCalls.filter(call=>sameAddress(call.target,RELAY_ROUTER)&&call.callData.slice(0,10)==="0x5d1fe6a2");if(cleanups.length!==1)throw new Error("Native order deposit is ambiguous");
 const cleanup=decodeFunctionData({abi:cleanupAbi,data:cleanups[0].callData});if(!sameAddress(cleanup.args[1],RELAY_DEPOSITORY))throw new Error("Native source deposit targets another contract");
 const deposit=decodeFunctionData({abi:depositAbi,data:cleanup.args[2]});if(deposit.functionName!=="depositNative"||!sameAddress(deposit.args[0],automation)||deposit.args[1]===zeroHash)throw new Error("Native source deposit account/order mismatch");
 const depositoryEdges=calls(edges[0]).filter(call=>!!call.to&&sameAddress(call.to,RELAY_DEPOSITORY));if(depositoryEdges.length!==1||depositoryEdges[0].input?.toLowerCase()!==cleanup.args[2].toLowerCase())throw new Error("Native actual source deposit is not uniquely traced");
 const sourceTransfers=decodeTransfers(receipt).filter(({args})=>sameAddress(args.from,automation));
 if(sourceTransfers.length!==1||!sameAddress(sourceTransfers[0].log.address,tokens[0])||!sameAddress(sourceTransfers[0].args.to,RELAY_APPROVAL_PROXY)||sourceTransfers[0].args.value!==amounts[0])throw new Error("Native source input spending is ambiguous");
 const deposits=receipt.logs.filter(log=>sameAddress(log.address,RELAY_DEPOSITORY)).flatMap(log=>{try{const event=decodeEventLog({abi:depositAbi,data:log.data,topics:log.topics,strict:true});return event.eventName==="RelayNativeDeposit"&&sameAddress(event.args.from,automation)?[{log,args:event.args}]:[];}catch{return[];}});
 if(deposits.length!==1||deposits[0].args.id.toLowerCase()!==deposit.args[1].toLowerCase()||deposits[0].args.amount<=0n||BigInt(depositoryEdges[0].value??"0x0")!==deposits[0].args.amount)throw new Error("Native actual deposit amount/order mismatch");
 for(const address of [RELAY_APPROVAL_PROXY,RELAY_DEPOSITORY,RELAY_ROUTER]){const code=await source.getCode({address,blockNumber:receipt.blockNumber});if(!code||code==="0x"||keccak256(code)!==BUYBACK_CODE_HASHES[address.toLowerCase()])throw new Error("Unreviewed native source implementation");}
 const block=await source.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash)throw new Error("Native source trace reorganized");
 return{sourceTimestamp:String(block.timestamp),sourceTransactionHash:sourceHash,sourceBlockNumber:String(receipt.blockNumber),sourceBlockHash:receipt.blockHash,sourceTransferLogIndex:sourceTransfers[0].log.logIndex!,sourceDepositLogIndex:deposits[0].log.logIndex!,sourceAsset:tokens[0],sourceAmount:String(amounts[0]),sourceNativeDeposit:String(deposits[0].args.amount),requestId,orderId:deposit.args[1],metadata,automation,sourceCalldataHash:keccak256(data)};
}
export function nativeDestinationTagMatches(receipt:Awaited<ReturnType<typeof canonicalBaseReceipt>>,metadata:Hex):boolean {
 return receipt.logs.some(log=>{if(!sameAddress(log.address,RELAY_ROUTER))return false;try{const event=decodeEventLog({abi:movementAbi,data:log.data,topics:log.topics,strict:true});return sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,BASE_BUYBACK_TREASURY)&&sameAddress(event.args.currency,BASE_BUYBACK_RH_WETH)&&event.args.metadata.toLowerCase()===metadata.toLowerCase();}catch{return false;}});
}
/** Caller authentication for ambiguity checks. A foreign Router donation cannot occupy a provider's request identity. */
export async function nativeDestinationHasFixedProvider(destination:Client,destinationHash:Hex):Promise<boolean> {
 const receipt=await canonicalBaseReceipt(destination,destinationHash,4663);if(receipt.status!=="success")return false;
 const trace=await destination.request({method:"debug_traceTransaction" as any,params:[destinationHash,{tracer:"callTracer"}] as any});
 const authenticated=calls(trace).some(call=>!!call.from&&!!call.to&&sameAddress(call.from,BASE_NATIVE_RELAY_SOLVER)&&sameAddress(call.to,RELAY_ROUTER));
 if(!authenticated)return false;const code=await destination.getCode({address:RELAY_ROUTER,blockNumber:receipt.blockNumber});if(!code||code==="0x"||keccak256(code)!==BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()])throw new Error("Unreviewed native destination implementation");
 if((await destination.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error("Native destination ambiguity check reorganized");return true;
}
export async function verifyBaseNativeDestinationTrace(destination:Client,destinationHash:Hex,frame:BaseNativeSourceFrame):Promise<BaseNativeRelayEvidence> {
 const receipt=await canonicalBaseReceipt(destination,destinationHash,4663);if(receipt.status!=="success")throw new Error("Native destination reverted");
 const movements=receipt.logs.filter(log=>sameAddress(log.address,RELAY_ROUTER)).flatMap(log=>{try{const event=decodeEventLog({abi:movementAbi,data:log.data,topics:log.topics,strict:true});return sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,BASE_BUYBACK_TREASURY)&&sameAddress(event.args.currency,BASE_BUYBACK_RH_WETH)&&event.args.metadata.toLowerCase()===frame.metadata.toLowerCase()?[{log,args:event.args}]:[];}catch{return[];}});
 const incoming=decodeTransfers(receipt).filter(({log,args})=>sameAddress(log.address,BASE_BUYBACK_RH_WETH)&&sameAddress(args.from,RELAY_ROUTER)&&sameAddress(args.to,BASE_BUYBACK_TREASURY));
 if(movements.length!==1||incoming.length!==1||movements[0].args.amount<=0n||movements[0].args.amount!==incoming[0].args.value)throw new Error("Native destination receipt is missing, partial or ambiguous");
 const trace=await destination.request({method:"debug_traceTransaction" as any,params:[destinationHash,{tracer:"callTracer"}] as any});
 const edges=calls(trace).filter(call=>!!call.from&&!!call.to&&sameAddress(call.from,BASE_NATIVE_RELAY_SOLVER)&&sameAddress(call.to,RELAY_ROUTER));
 if(edges.length!==1)throw new Error("Native destination fixed provider caller is not uniquely traced");
 const code=await destination.getCode({address:RELAY_ROUTER,blockNumber:receipt.blockNumber});if(!code||code==="0x"||keccak256(code)!==BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()])throw new Error("Unreviewed native destination implementation");
 const block=await destination.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash)throw new Error("Native destination trace reorganized");
 if(block.timestamp<BigInt(frame.sourceTimestamp))throw new Error("Native destination predates source deposit");
 return{...frame,version:2,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,orderParametersVerified:false,treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:String(incoming[0].args.value),destinationTransactionHash:destinationHash,destinationBlockNumber:String(receipt.blockNumber),destinationBlockHash:receipt.blockHash,destinationTransferLogIndex:incoming[0].log.logIndex!,destinationMovementLogIndex:movements[0].log.logIndex!};
}
export async function verifyBaseNativeTraceProof(source:Client,destination:Client,input:Extract<BaseNativeRelayProofInput,{version:2}>,automation:Address) {
 if(input.protocol!==BASE_NATIVE_BUYBACK_PROTOCOL||!hash(input.sourceHash)||!hash(input.destinationHash))throw new Error("Unsupported native trace proof version");
 const frame=await verifyBaseNativeSourceTrace(source,input.sourceHash,automation),proof=await verifyBaseNativeDestinationTrace(destination,input.destinationHash,frame);
 const [sb,db]=await Promise.all([source.getBlock({blockNumber:BigInt(frame.sourceBlockNumber)}),destination.getBlock({blockNumber:BigInt(proof.destinationBlockNumber)})]);if(db.timestamp<sb.timestamp)throw new Error("Native destination predates source deposit");return proof;
}
