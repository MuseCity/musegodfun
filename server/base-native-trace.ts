import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, isAddress, keccak256, parseAbi, recoverTypedDataAddress, recoverTransactionAddress, serializeTransaction, stringToHex, toHex, zeroHash, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_NATIVE_BUYBACK_PROTOCOL, BASE_NATIVE_DESTINATION_POLICY, type BaseNativeRelayEvidence, type BaseNativeRelayProofInput } from "../src/lib/base-buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import { approvalProxyAbi, BUYBACK_CODE_HASHES, RELAY_ROUTER, relayRequestMetadata } from "./buyback";
import { canonicalBaseReceipt } from "./base-buyback";
import type { BaseAuditStore } from "./base-audit";
type Client=PublicClient<Transport,any>;
export const BASE_NATIVE_RELAY_SOLVER="0xf70da97812cb96acdf810712aa562db8dfa3dbef" as Address;
const cleanupAbi=parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]);
const depositAbi=parseAbi(["function depositNative(address depositor,bytes32 id)","event RelayNativeDeposit(address from,uint256 amount,bytes32 id)"]);
const tokenParticipationAbi=parseAbi(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
 "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
 "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)"]);
const movementAbi=parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
export const nativeCleanupErc20Abi=parseAbi(["function cleanupErc20s(address[] tokens,address[] recipients,uint256[] amounts,bytes metadata)"]);
export const nativeRelayRouterAbi=parseAbi(["function multicall((address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable returns((bool success,bytes returnData)[])"]);
export const nativeSolverExecutionAbi=parseAbi(["event SolverCallExecuted(address to,bytes data,uint256 amount)"]);
const hash=(value:unknown):value is Hex=>typeof value==="string"&&/^0x[\da-f]{64}$/i.test(value);
type Call={from?:string;to?:string;input?:string;value?:string;error?:string;calls?:Call[]};
export class UnsupportedNativeCallTraceError extends Error {
 constructor(){super("Unsupported native call trace");this.name="UnsupportedNativeCallTraceError";}
}
export class NativeDestinationProviderPendingError extends Error {
 constructor(message="Fixed native provider evidence is unsupported or temporarily unavailable"){super(message);this.name="NativeDestinationProviderPendingError";}
}
function calls(trace:unknown):Call[] {
 const output:Call[]=[];let visited=0;const pending=[{value:trace as Call,depth:0,failed:false}];
 while(pending.length){const next=pending.pop()!,value=next.value;
  if(!value||typeof value!=="object"||Array.isArray(value)||++visited>4096||next.depth>128||value.calls!==undefined&&!Array.isArray(value.calls))throw new UnsupportedNativeCallTraceError();
  const failed=next.failed||!!value.error;if(!failed)output.push(value);
  if(value.calls){if(value.calls.length+pending.length>4096-visited)throw new UnsupportedNativeCallTraceError();for(let index=value.calls.length-1;index>=0;index--)pending.push({value:value.calls[index],depth:next.depth+1,failed});}
 }
 return output;
}
function decodeTransfers(receipt:Awaited<ReturnType<typeof canonicalBaseReceipt>>) {
 return receipt.logs.flatMap(log=>{try{const event=decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics,strict:true});return event.eventName==="Transfer"&&event.args.value>0n&&!sameAddress(event.args.from,event.args.to)?[{log,args:event.args}]:[];}catch{return[];}});
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
 // Official ApprovalProxy.transferAndMulticall is the spender, while the actual ERC20 recipient is ROUTER.
 // Pin both direct child calls and the complete Router calldata; a matching Transfer alone cannot authenticate a route.
 const transferData=encodeFunctionData({abi:erc20Abi,functionName:"transferFrom",args:[automation,RELAY_ROUTER,amounts[0]]});
 const transfers=(edges[0].calls??[]).filter(call=>!!call.from&&!!call.to&&sameAddress(call.from,RELAY_APPROVAL_PROXY)&&sameAddress(call.to,tokens[0])&&call.input?.toLowerCase()===transferData.toLowerCase()&&BigInt(call.value??"0x0")===0n&&!call.error);
 const routerData=encodeFunctionData({abi:nativeRelayRouterAbi,functionName:"multicall",args:[sourceCalls,refundTo,nftRecipient,metadata]});
 const routers=(edges[0].calls??[]).filter(call=>!!call.from&&!!call.to&&sameAddress(call.from,RELAY_APPROVAL_PROXY)&&sameAddress(call.to,RELAY_ROUTER)&&call.input?.toLowerCase()===routerData.toLowerCase()&&BigInt(call.value??"0x0")===0n&&!call.error);
 if(transfers.length!==1||routers.length!==1)throw new Error("Native actual ApprovalProxy spender and exact Router call graph mismatch");
 const cleanupEdges=(routers[0].calls??[]).filter(call=>!!call.from&&!!call.to&&sameAddress(call.from,RELAY_ROUTER)&&sameAddress(call.to,RELAY_ROUTER)&&call.input?.toLowerCase()===cleanups[0].callData.toLowerCase()&&!call.error&&BigInt(call.value??"0x0")===0n);
 if(cleanupEdges.length!==1)throw new Error("Native actual Router cleanup is not uniquely traced");
 const depositoryEdges=calls(cleanupEdges[0]).filter(call=>!!call.from&&!!call.to&&sameAddress(call.from,RELAY_ROUTER)&&sameAddress(call.to,RELAY_DEPOSITORY));if(depositoryEdges.length!==1||calls(edges[0]).filter(call=>!!call.to&&sameAddress(call.to,RELAY_DEPOSITORY)).length!==1||depositoryEdges[0].input?.toLowerCase()!==cleanup.args[2].toLowerCase())throw new Error("Native actual source deposit is not uniquely traced");
 const sourceTransfers=decodeTransfers(receipt).filter(({args})=>sameAddress(args.from,automation));
 if(sourceTransfers.length!==1||!sameAddress(sourceTransfers[0].log.address,tokens[0])||!sameAddress(sourceTransfers[0].args.to,RELAY_ROUTER)||sourceTransfers[0].args.value!==amounts[0])throw new Error("Native source input spending is ambiguous");
 const deposits=receipt.logs.filter(log=>sameAddress(log.address,RELAY_DEPOSITORY)).flatMap(log=>{try{const event=decodeEventLog({abi:depositAbi,data:log.data,topics:log.topics,strict:true});return event.eventName==="RelayNativeDeposit"&&sameAddress(event.args.from,automation)?[{log,args:event.args}]:[];}catch{return[];}});
 if(deposits.length!==1||deposits[0].args.id.toLowerCase()!==deposit.args[1].toLowerCase()||deposits[0].args.amount<=0n||BigInt(depositoryEdges[0].value??"0x0")!==deposits[0].args.amount)throw new Error("Native actual deposit amount/order mismatch");
 for(const address of [RELAY_APPROVAL_PROXY,RELAY_DEPOSITORY,RELAY_ROUTER]){const code=await source.getCode({address,blockNumber:receipt.blockNumber});if(!code||code==="0x"||keccak256(code)!==BUYBACK_CODE_HASHES[address.toLowerCase()])throw new Error("Unreviewed native source implementation");}
 const block=await source.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash)throw new Error("Native source trace reorganized");
 return{sourceTimestamp:String(block.timestamp),sourceTransactionHash:sourceHash,sourceBlockNumber:String(receipt.blockNumber),sourceBlockHash:receipt.blockHash,sourceTransferLogIndex:sourceTransfers[0].log.logIndex!,sourceDepositLogIndex:deposits[0].log.logIndex!,sourceAsset:tokens[0],sourceAmount:String(amounts[0]),sourceNativeDeposit:String(deposits[0].args.amount),requestId,orderId:deposit.args[1],metadata,automation,sourceCalldataHash:keccak256(data)};
}
export function nativeDestinationTagMatches(receipt:Awaited<ReturnType<typeof canonicalBaseReceipt>>,metadata:Hex):boolean {
 return receipt.logs.some(log=>{if(!sameAddress(log.address,RELAY_ROUTER))return false;try{const event=decodeEventLog({abi:movementAbi,data:log.data,topics:log.topics,strict:true});return sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,BASE_BUYBACK_TREASURY)&&sameAddress(event.args.currency,BASE_BUYBACK_RH_WETH)&&event.args.metadata.toLowerCase()===metadata.toLowerCase();}catch{return false;}});
}
/** Destination-only pins. Permit2's domain/chain immutables differ from Base. */
export const NATIVE_DESTINATION_PERMIT2="0x000000000022d473030f116ddee9f6b43ac78ba3" as Address;
export const NATIVE_DESTINATION_PROXY_CODE_HASH="0xa3b36a6aa3c2fb588b92336d88b0735b40dea0282c110d2034edf688ca661b5b" as Hex;
export const NATIVE_DESTINATION_PERMIT2_CODE_HASH="0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca" as Hex;
export const nativeDestinationPermitAbi=parseAbi(["function permit2TransferAndMulticall(address user,((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,(address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata,bytes permitSignature) payable returns((bool success,bytes returnData)[])"]);
export const nativeDestinationPermitTypes={
 TokenPermissions:[{name:"token",type:"address"},{name:"amount",type:"uint256"}],
 Call3Value:[{name:"target",type:"address"},{name:"allowFailure",type:"bool"},{name:"value",type:"uint256"},{name:"callData",type:"bytes"}],
 RelayerWitness:[{name:"relayer",type:"address"},{name:"refundTo",type:"address"},{name:"nftRecipient",type:"address"},{name:"metadata",type:"bytes"},{name:"call3Values",type:"Call3Value[]"}],
 PermitBatchWitnessTransferFrom:[{name:"permitted",type:"TokenPermissions[]"},{name:"spender",type:"address"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint256"},{name:"witness",type:"RelayerWitness"}],
} as const;
type DestinationContext={provider:Address;token:Address;recipient:Address;routerCodeHash:Hex;proxyCodeHash:Hex;permit2CodeHash:Hex};
export type NativeDestinationVerificationOptions={auditStore?:BaseAuditStore|Pick<BaseAuditStore,"getBuybackBatch">};
const productionDestinationContext:DestinationContext={provider:BASE_NATIVE_RELAY_SOLVER,token:BASE_BUYBACK_RH_WETH,recipient:BASE_BUYBACK_TREASURY,
 routerCodeHash:BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()],proxyCodeHash:NATIVE_DESTINATION_PROXY_CODE_HASH,permit2CodeHash:NATIVE_DESTINATION_PERMIT2_CODE_HASH};
const emptyCode=(code:Hex|undefined)=>code===undefined||code==="0x";
/** Participation is a retry/isolation hint, never proof of ownership or payment.
 * Zero/self ERC20 transfers cannot manufacture a solver participation hint. */
function destinationHasSolverParticipation(tx:Awaited<ReturnType<Client["getTransaction"]>>,receipt:Awaited<ReturnType<typeof canonicalBaseReceipt>>,provider:Address){
 if(sameAddress(tx.from,provider)||decodeTransfers(receipt).some(({args})=>sameAddress(args.from,provider)))return true;
 // NFT ids may be zero, but ERC1155 quantity must be positive. Untrusted token
 // emitters remain only an uncertain per-candidate hint, never authentication.
 if(receipt.logs.some(log=>{try{const event=decodeEventLog({abi:tokenParticipationAbi,data:log.data,topics:log.topics,strict:true});
  return sameAddress(event.args.from,provider)&&!sameAddress(event.args.from,event.args.to)&&(event.eventName==="Transfer"||event.eventName==="TransferSingle"&&event.args.value>0n||event.eventName==="TransferBatch"&&event.args.values.some(value=>value>0n));
 }catch{return false;}}))return true;
 if(sameAddress(tx.to!,RELAY_APPROVAL_PROXY)&&tx.input.slice(0,10)==="0x0a2b8f36"){
  // The first static owner word remains a conservative hint even when later
  // arguments are malformed. It is not accepted as an owner signature.
  if(tx.input.length>=74&&/^0{24}[\da-f]{40}$/i.test(tx.input.slice(10,74))&&sameAddress(`0x${tx.input.slice(34,74)}`,provider))return true;
 }
 return false;
}
/** Complete canonical envelopes without any fixed-solver participation are
 * foreign even when their Router route is unsupported. Ambiguous solver-related
 * candidates remain pending; a receipt/code/RPC failure is never a negative. */
export async function nativeDestinationHasFixedProvider(destination:Client,destinationHash:Hex,metadata?:Hex,opts?:NativeDestinationVerificationOptions):Promise<boolean> {
 try{
  const receipt=await canonicalBaseReceipt(destination,destinationHash,4663);if(receipt.status==="reverted")return false;
  const envelope=await destinationEnvelope(destination,destinationHash,receipt);
  if(!destinationHasSolverParticipation(envelope.tx,envelope.receipt,BASE_NATIVE_RELAY_SOLVER)){
   await closeDestinationEnvelope(destination,destinationHash,envelope);return false;
  }
  await destinationReceiptFrame(destination,destinationHash,metadata,undefined,opts,envelope);return true;
 }catch{throw new NativeDestinationProviderPendingError("Fixed-provider transaction/receipt evidence is unsupported or temporarily unavailable");}
}
async function authenticatedRoot(tx:Awaited<ReturnType<Client["getTransaction"]>>,destinationHash:Hex){
 if(!/^0x[\da-f]{1,64}$/i.test(tx.r??"")||!/^0x[\da-f]{1,64}$/i.test(tx.s??"")||BigInt(tx.r!)===0n||BigInt(tx.s!)===0n||!Number.isSafeInteger(tx.nonce)||tx.nonce<0||
  typeof tx.gas!=="bigint"||tx.gas<=0n||tx.chainId!==4663)throw new Error("Unsigned or unsupported destination transaction");
 const serialized=serializeTransaction({type:tx.type as "legacy"|"eip2930"|"eip1559",chainId:4663,nonce:tx.nonce,to:tx.to!,value:tx.value,data:tx.input,
  gas:tx.gas,gasPrice:tx.gasPrice,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas,accessList:tx.accessList},
  {r:toHex(BigInt(tx.r!),{size:32}),s:toHex(BigInt(tx.s!),{size:32}),v:tx.v,yParity:tx.yParity});
 if(keccak256(serialized).toLowerCase()!==destinationHash.toLowerCase()||!sameAddress(await recoverTransactionAddress({serializedTransaction:serialized}),tx.from))
  throw new Error("Destination root signature/hash mismatch");
}
// Actual Relay roots may append one opaque tracking word. Solidity's reviewed
// ABI decoder consumes only the canonical prefix; the signed root hash includes
// the entire suffix. It is neither an extra call nor source/order evidence.
function canonicalDestinationRootData(encoded:Hex,input:Hex){return input.toLowerCase()===encoded.toLowerCase()||input.length===encoded.length+64&&input.toLowerCase().startsWith(encoded.toLowerCase())&&/^[\da-f]{64}$/i.test(input.slice(encoded.length));}
/** Offline inspection shares the strict receipt engine but returns explicitly
 * nonfinancial facts. No context reaches API, manifest, or spendable evidence. */
export async function inspectNativeDestinationReceiptStructure(destination:Client,destinationHash:Hex,metadata:Hex|undefined,context:DestinationContext,opts?:NativeDestinationVerificationOptions){
 const frame=await destinationReceiptFrame(destination,destinationHash,metadata,context,opts);
 return{projectPath:false as const,projectFeeCanary:false as const,authorization:"permit2-signed-execution" as const,transactionHash:destinationHash,
  blockNumber:String(frame.receipt.blockNumber),blockHash:frame.receipt.blockHash,timestamp:String(frame.block.timestamp),fundingOwner:context.provider,
  outputToken:context.token,recipient:context.recipient,outputAmount:String(frame.incoming.args.value),transferLogIndex:frame.incoming.log.logIndex!,movementLogIndex:frame.movement.log.logIndex!};
}
async function destinationEnvelope(destination:Client,destinationHash:Hex,retained?:Awaited<ReturnType<typeof canonicalBaseReceipt>>){
 if(!hash(destinationHash))throw new Error("Invalid native destination hash");
 const receipt=retained??await canonicalBaseReceipt(destination,destinationHash,4663);
 if(receipt.status!=="success"||receipt.blockNumber<1n)throw new Error("Native destination reverted or unavailable");
 const tx=await destination.getTransaction({hash:destinationHash});
 if(tx.hash?.toLowerCase()!==destinationHash.toLowerCase()||tx.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase()||tx.blockNumber!==receipt.blockNumber||
  tx.transactionIndex!==receipt.transactionIndex||!receipt.from||!isAddress(receipt.from,{strict:false})||!receipt.to||!isAddress(receipt.to,{strict:false})||!sameAddress(tx.from,receipt.from)||!tx.to||!sameAddress(tx.to,receipt.to)||
  typeof tx.value!=="bigint"||tx.value<0n||!/^0x([\da-f]{2})*$/i.test(tx.input)||tx.input.length>262146||
  !["legacy","eip2930","eip1559"].includes(tx.type)||receipt.logs.length>1024)throw new Error("Unsupported native destination root transaction");
 await authenticatedRoot(tx,destinationHash);
 let previous=-1;
 for(const log of receipt.logs){
  if(log.removed||log.transactionHash?.toLowerCase()!==destinationHash.toLowerCase()||log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase()||
   log.blockNumber!==receipt.blockNumber||log.transactionIndex!==receipt.transactionIndex||!Number.isSafeInteger(log.logIndex)||log.logIndex!<=previous||
   !isAddress(log.address,{strict:false})||log.topics.length>4||!log.topics.every(hash)||!/^0x([\da-f]{2})*$/i.test(log.data)||log.data.length>262146)
   throw new Error("Unsupported or noncanonical native destination log");
  previous=log.logIndex!;
 }
 const [block,parent]=await Promise.all([destination.getBlock({blockNumber:receipt.blockNumber}),destination.getBlock({blockNumber:receipt.blockNumber-1n})]);
 if(block.hash!==receipt.blockHash||!hash(parent.hash)||block.parentHash!==parent.hash||parent.number!==receipt.blockNumber-1n)throw new Error("Native destination canonical parent mismatch");
 return{tx,receipt,block,parent};
}
type DestinationEnvelope=Awaited<ReturnType<typeof destinationEnvelope>>;
const destinationSnapshot=(transaction:DestinationEnvelope["tx"],r:DestinationEnvelope["receipt"])=>JSON.stringify([transaction.hash,transaction.blockHash,String(transaction.blockNumber),transaction.transactionIndex,transaction.from,transaction.to,
 transaction.input,String(transaction.value),transaction.type,transaction.chainId,transaction.nonce,String(transaction.gas),String(transaction.gasPrice),String(transaction.maxFeePerGas),String(transaction.maxPriorityFeePerGas),transaction.accessList,transaction.r,transaction.s,String(transaction.v),transaction.yParity,
 r.transactionHash,r.blockHash,String(r.blockNumber),r.transactionIndex,r.from,r.to,r.status,String(r.gasUsed),String(r.effectiveGasPrice),r.logs.map(log=>[log.address,log.topics,log.data,log.transactionHash,log.blockHash,String(log.blockNumber),log.transactionIndex,log.logIndex,log.removed])]);
async function closeDestinationEnvelope(destination:Client,destinationHash:Hex,envelope:DestinationEnvelope,latest?:{number:bigint;hash:Hex}){
 const {tx,receipt,parent}=envelope;const [freshReceipt,freshTx,finalBlock,finalParent,finalChain]=await Promise.all([destination.getTransactionReceipt({hash:destinationHash}),destination.getTransaction({hash:destinationHash}),
  destination.getBlock({blockNumber:receipt.blockNumber}),destination.getBlock({blockNumber:parent.number!}),destination.getChainId()]);
 if(finalChain!==4663||destinationSnapshot(tx,receipt)!==destinationSnapshot(freshTx,freshReceipt)||finalBlock.hash!==receipt.blockHash||finalParent.hash!==parent.hash||finalBlock.parentHash!==parent.hash)
  throw new Error("Native destination receipt snapshot reorganized or changed during verification");
 if(latest&&((await destination.getBlock({blockNumber:latest.number})).hash!==latest.hash||await destination.getChainId()!==4663))throw new Error("Native destination latest code anchor changed");
}
type DestinationCodeFacts={id:string;protocol:"internal_native_destination_code_v1";version:1;binding:Hex;sourceChainId:8453;destinationChainId:4663;
 parent:{number:string;hash:Hex};target:{number:string;hash:Hex};facts:{address:Address;hash:Hex|"0x"}[];verifiedAt:string};
async function verifyDestinationCodeFacts(destination:Client,envelope:DestinationEnvelope,context:DestinationContext,opts?:NativeDestinationVerificationOptions){
 const {tx,receipt,parent}=envelope;
 const latestHeader=await destination.getBlock({blockTag:"latest"});
 if(typeof latestHeader.number!=="bigint"||latestHeader.number<receipt.blockNumber||!hash(latestHeader.hash))throw new Error("Latest native destination header unavailable");
 const latest={number:latestHeader.number,hash:latestHeader.hash};
 const implementations=[{address:RELAY_ROUTER,expected:context.routerCodeHash},{address:RELAY_APPROVAL_PROXY,expected:context.proxyCodeHash},{address:NATIVE_DESTINATION_PERMIT2,expected:context.permit2CodeHash}];
 // Never infer current authority from historical metadata. Upgrade/empty/RPC
 // failures hold new acceptance even when historical facts remain reusable.
 for(const {address,expected}of implementations){const code=await destination.getCode({address,blockNumber:latest.number});if(!code||code==="0x"||keccak256(code)!==expected)throw new Error("Unreviewed latest native destination implementation");}
 const facts=[...new Set([context.provider.toLowerCase(),tx.from.toLowerCase()])].map(address=>({address:address as Address,hash:"0x" as Hex|"0x"}))
  .concat(implementations.map(({address,expected})=>({address:address.toLowerCase() as Address,hash:expected}))).sort((a,b)=>a.address<b.address?-1:a.address>b.address?1:0);
 const binding=keccak256(stringToHex(JSON.stringify({version:1,policy:BASE_NATIVE_DESTINATION_POLICY,chainId:4663,parent:{number:String(parent.number),hash:parent.hash},target:{number:String(receipt.blockNumber),hash:receipt.blockHash},facts})));
 const id=`internal_native_destination_code:${binding}`,store=opts?.auditStore;let stored:Awaited<ReturnType<BaseAuditStore["getBuybackBatch"]>>=null;
 // Cache availability is advisory; an unavailable record cannot substitute for
 // the complete historical verification below or invalidate verified live data.
 try{stored=store?await store.getBuybackBatch(id):null;}catch{stored=null;}
 const valid=(value:any):value is DestinationCodeFacts=>value?.id===id&&value.protocol==="internal_native_destination_code_v1"&&value.version===1&&value.binding===binding&&
  value.sourceChainId===8453&&value.destinationChainId===4663&&value.parent?.number===String(parent.number)&&value.parent?.hash===parent.hash&&value.target?.number===String(receipt.blockNumber)&&value.target?.hash===receipt.blockHash&&
  Array.isArray(value.facts)&&value.facts.length===facts.length&&value.facts.every((fact:any,index:number)=>fact.address===facts[index].address&&fact.hash===facts[index].hash)&&typeof value.verifiedAt==="string"&&Number.isFinite(Date.parse(value.verifiedAt));
 if(valid(stored)){await closeDestinationEnvelope(destination,tx.hash,envelope,latest);return latest;}
 for(const {address,hash:expected}of facts){const before=await destination.getCode({address,blockNumber:parent.number!}),after=await destination.getCode({address,blockNumber:receipt.blockNumber});
  if(expected==="0x"?!emptyCode(before)||!emptyCode(after):!before||before==="0x"||!after||after==="0x"||before.toLowerCase()!==after.toLowerCase()||keccak256(after)!==expected)throw new Error("Unreviewed historical native destination implementation/provider");}
 // These are code facts only; persist independently of whether the route later
 // passes witness/payment checks. Reorg/receipt changes can never consume them.
 await closeDestinationEnvelope(destination,tx.hash,envelope,latest);
 if(store&&"compareAndSetBuybackAudit"in store&&typeof store.compareAndSetBuybackAudit==="function"){
  const next:DestinationCodeFacts={id,protocol:"internal_native_destination_code_v1",version:1,binding,sourceChainId:8453,destinationChainId:4663,parent:{number:String(parent.number),hash:parent.hash!},
   target:{number:String(receipt.blockNumber),hash:receipt.blockHash},facts,verifiedAt:new Date().toISOString()};
  try{
   // A lost/failed cache write is not a financial-journal conflict. The complete
   // facts were checked live above; no cache success is returned or manufactured.
   await store.compareAndSetBuybackAudit(next,stored??null);
  }catch{/* Optional code-fact cache only; future reuse still requires a valid row. */}
 }
 return latest;
}
async function destinationReceiptFrame(destination:Client,destinationHash:Hex,metadata?:Hex,inspectionContext?:DestinationContext,opts?:NativeDestinationVerificationOptions,retained?:DestinationEnvelope){
 const context=inspectionContext??{...productionDestinationContext,routerCodeHash:BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()]};
 const envelope=retained??await destinationEnvelope(destination,destinationHash),{receipt,tx,block}=envelope;
 if(!sameAddress(tx.to!,RELAY_APPROVAL_PROXY))throw new Error("Destination acceptance requires fixed-owner Permit2 witness; unsupported root wrapper");
 const decoded=decodeFunctionData({abi:nativeDestinationPermitAbi,data:tx.input}),[owner,permit,instructions,refund,nft,tag,signature]=decoded.args;
 if(!sameAddress(owner,context.provider))throw new Error("Destination Permit2 owner is not the fixed solver");
 if(!canonicalDestinationRootData(encodeFunctionData({abi:nativeDestinationPermitAbi,functionName:"permit2TransferAndMulticall",args:decoded.args}),tx.input)||
  tx.value!==0n||permit.permitted.length!==1||permit.permitted[0].amount<=0n||!/^0x[\da-f]{128}([\da-f]{2})?$/i.test(signature))throw new Error("Unsupported native Permit2 funding parameters");
 const latest=await verifyDestinationCodeFacts(destination,envelope,context,opts);
 const signature65=signature.length===130?`${signature.slice(0,66)}${(BigInt(`0x${signature.slice(66)}`)&((1n<<255n)-1n)).toString(16).padStart(64,"0")}${(27+Number(BigInt(`0x${signature.slice(66)}`)>>255n)).toString(16)}` as Hex:signature;
 const ownerRecovered=await recoverTypedDataAddress({domain:{name:"Permit2",chainId:4663,verifyingContract:NATIVE_DESTINATION_PERMIT2},types:nativeDestinationPermitTypes,
  primaryType:"PermitBatchWitnessTransferFrom",message:{...permit,spender:RELAY_APPROVAL_PROXY,witness:{relayer:tx.from,refundTo:refund,nftRecipient:nft,metadata:tag,call3Values:instructions}},signature:signature65});
 if(!sameAddress(ownerRecovered,context.provider))throw new Error("Native Permit2 owner witness signature mismatch");
 if(permit.deadline<block.timestamp)throw new Error("Native destination deadline expired");
 const fundingToken=permit.permitted[0].token,fundingAmount=permit.permitted[0].amount;
 if(metadata&&tag.toLowerCase()!==metadata.toLowerCase()||!/^0x[\da-f]{64}00$/i.test(tag)||!isAddress(refund,{strict:false})||!isAddress(nft,{strict:false})||
  instructions.length<1||instructions.length>8||instructions.some(instruction=>instruction.allowFailure||instruction.value!==0n||instruction.callData.length>131074))
  throw new Error("Native destination provider Router calldata/request mismatch");
 const transfers=decodeTransfers(receipt),incoming=transfers.filter(({log,args})=>sameAddress(log.address,context.token)&&sameAddress(args.from,RELAY_ROUTER)&&sameAddress(args.to,context.recipient));
 const movements=receipt.logs.filter(log=>sameAddress(log.address,RELAY_ROUTER)).flatMap(log=>{try{const event=decodeEventLog({abi:movementAbi,data:log.data,topics:log.topics,strict:true});return sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,context.recipient)&&sameAddress(event.args.currency,context.token)&&event.args.metadata.toLowerCase()===tag.toLowerCase()?[{log,args:event.args}]:[];}catch{return[];}});
 if(incoming.length!==1||movements.length!==1||movements[0].args.amount<=0n||movements[0].args.amount!==incoming[0].args.value)throw new Error("Native destination receipt is missing, partial or ambiguous");
 const selfCalls=instructions.filter(instruction=>sameAddress(instruction.target,RELAY_ROUTER)),last=instructions.at(-1)!;
 if(selfCalls.length!==1||last!==selfCalls[0]||last.callData.slice(0,10)!=="0x9bb43718")throw new Error("Native destination token cleanup is not uniquely bound at the final instruction");
 const cleanup=decodeFunctionData({abi:nativeCleanupErc20Abi,data:last.callData}),[tokens,recipients,amounts,cleanupTag]=cleanup.args;
 if(tokens.length!==1||recipients.length!==1||amounts.length!==1||!sameAddress(tokens[0],context.token)||!sameAddress(recipients[0],context.recipient)||
  amounts[0]!==0n&&amounts[0]!==incoming[0].args.value||cleanupTag.toLowerCase()!==tag.toLowerCase())throw new Error("Native destination token cleanup parameters mismatch");
 if(encodeFunctionData({abi:nativeCleanupErc20Abi,functionName:"cleanupErc20s",args:cleanup.args}).toLowerCase()!==last.callData.toLowerCase())throw new Error("Noncanonical destination cleanup calldata");
 const successes=receipt.logs.filter(log=>sameAddress(log.address,RELAY_ROUTER)).flatMap(log=>{try{return[{log,args:decodeEventLog({abi:nativeSolverExecutionAbi,data:log.data,topics:log.topics,strict:true}).args}];}catch{return[];}});
 if(successes.length!==instructions.length||successes.some((success,index)=>!sameAddress(success.args.to,instructions[index].target)||success.args.data.toLowerCase()!==instructions[index].callData.toLowerCase()||success.args.amount!==instructions[index].value))
  throw new Error("Native destination instruction success witnesses mismatch");
 const previousSuccess=successes.length>1?successes.at(-2)!.log.logIndex!:-1,cleanupSuccess=successes.at(-1)!.log.logIndex!;
 if(!(previousSuccess<incoming[0].log.logIndex!&&incoming[0].log.logIndex!<movements[0].log.logIndex!&&movements[0].log.logIndex!<cleanupSuccess))throw new Error("Native destination payment is outside its authenticated cleanup event window");
 const funded=transfers.filter(({log,args})=>sameAddress(log.address,fundingToken)&&sameAddress(args.from,context.provider));
 if(funded.length!==1||!sameAddress(funded[0].args.to,RELAY_ROUTER)||funded[0].args.value!==fundingAmount||funded[0].log.logIndex!>=incoming[0].log.logIndex!)throw new Error("Native destination owner funding transfer mismatch");
 const deposits=receipt.logs.filter(log=>sameAddress(log.address,RELAY_APPROVAL_PROXY)).flatMap(log=>{try{return[{log,args:decodeEventLog({abi:movementAbi,data:log.data,topics:log.topics,strict:true}).args}];}catch{return[];}});
 if(deposits.length!==1||!sameAddress(deposits[0].args.from,context.provider)||!sameAddress(deposits[0].args.to,RELAY_ROUTER)||!sameAddress(deposits[0].args.currency,fundingToken)||
  deposits[0].args.amount!==fundingAmount||deposits[0].args.metadata.toLowerCase()!==tag.toLowerCase()||!(deposits[0].log.logIndex!<funded[0].log.logIndex!&&funded[0].log.logIndex!<successes[0].log.logIndex!))
  throw new Error("Native destination Proxy funding witness mismatch");
 // The solver authorizes the full conversion. Router dust/extra inflows are not
 // input provenance: only the unique final canonical WETH payment is booked.
 await closeDestinationEnvelope(destination,destinationHash,envelope,latest);
 return{receipt,block,incoming:incoming[0],movement:movements[0]};
}
export async function verifyBaseNativeDestinationReceipt(destination:Client,destinationHash:Hex,frame:BaseNativeSourceFrame,opts?:NativeDestinationVerificationOptions):Promise<BaseNativeRelayEvidence> {
 const {receipt,block,incoming,movement}=await destinationReceiptFrame(destination,destinationHash,frame.metadata,undefined,opts);
 if(block.timestamp<BigInt(frame.sourceTimestamp))throw new Error("Native destination predates source deposit");
 return{...frame,version:2,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,orderParametersVerified:false,treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:String(incoming.args.value),destinationTransactionHash:destinationHash,destinationBlockNumber:String(receipt.blockNumber),destinationBlockHash:receipt.blockHash,destinationTransferLogIndex:incoming.log.logIndex!,destinationMovementLogIndex:movement.log.logIndex!};
}
export async function verifyBaseNativeTraceProof(source:Client,destination:Client,input:Extract<BaseNativeRelayProofInput,{version:2}>,automation:Address,opts?:NativeDestinationVerificationOptions) {
 if(input.protocol!==BASE_NATIVE_BUYBACK_PROTOCOL||!hash(input.sourceHash)||!hash(input.destinationHash))throw new Error("Unsupported native trace proof version");
 const frame=await verifyBaseNativeSourceTrace(source,input.sourceHash,automation),proof=await verifyBaseNativeDestinationReceipt(destination,input.destinationHash,frame,opts);
 const [sb,db]=await Promise.all([source.getBlock({blockNumber:BigInt(frame.sourceBlockNumber)}),destination.getBlock({blockNumber:BigInt(proof.destinationBlockNumber)})]);if(db.timestamp<sb.timestamp)throw new Error("Native destination predates source deposit");return proof;
}
