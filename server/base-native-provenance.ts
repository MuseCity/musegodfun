import { verifyBaseNativeTraceProof } from "./base-native-trace";
import { decodeEventLog, decodeFunctionData, erc20Abi, getAddress, isAddress, keccak256, parseAbi, recoverMessageAddress, zeroAddress, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_FORWARDER, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_NATIVE_BUYBACK_PROTOCOL, baseCollectorAbi, integer,
  type BaseNativeRelayEvidence, type BaseNativeRelayProofInput } from "../src/lib/base-buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import { approvalProxyAbi, BUYBACK_CODE_HASHES, RELAY_ROUTER, relayOrderId, relayRequestMetadata } from "./buyback";
import { canonicalBaseReceipt } from "./base-buyback";
import { assertCustodyFragments, convertCustodyFragments, replayCustodyLedger, type CustodyEvent, type CustodyFragment, type CustodyState } from "../src/lib/buyback-custody-ledger";
import { replayVaultLedger, vaultEventId, type VaultLedgerEvent, type VaultLedgerState } from "../src/lib/buyback-vault-ledger";

type Client=PublicClient<Transport,any>;
const relayNativeAbi=parseAbi(["event RelayNativeDeposit(address from,uint256 amount,bytes32 id)"]);
const movementAbi=parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
const forwardAbi=parseAbi(["event Forwarded(address indexed caller,uint256 amount)"]);
const SOLVER="0xf70da97812cb96acdf810712aa562db8dfa3dbef" as Address;
const object=(value:unknown):Record<string,any>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Unsupported native Relay evidence");return value as Record<string,any>;};
const hash=(value:unknown):value is Hex=>typeof value==="string"&&/^0x[\da-f]{64}$/i.test(value);
const requireAddress=(value:unknown,expected?:Address)=>{if(typeof value!=="string"||!isAddress(value,{strict:false})||expected&&!sameAddress(value,expected))throw new Error("Native Relay address mismatch");return getAddress(value);};
function decodedLogs<T extends ReturnType<typeof parseAbi>>(receipt: Awaited<ReturnType<typeof canonicalBaseReceipt>>,address:Address,abi:T) {
  return receipt.logs.filter(log=>sameAddress(log.address,address)).flatMap(log=>{try{return [{log,event:decodeEventLog({abi,data:log.data,topics:log.topics,strict:true}) as any}];}catch{return [];}});
}
function traceMatches(value:unknown,from:Address,to:Address,input:Hex):number {
  const trace=object(value);let count=0;
  if(typeof trace.from==="string"&&typeof trace.to==="string"&&typeof trace.input==="string"&&sameAddress(trace.from,from)&&sameAddress(trace.to,to)&&trace.input.toLowerCase()===input.toLowerCase()) {
    if(trace.error||trace.revertReason)throw new Error("Native source call reverted");count++;
  }
  if(Array.isArray(trace.calls))for(const call of trace.calls)count+=traceMatches(call,from,to,input);
  return count;
}
/** Only retained, solver-signed Relay v1 native-payment orders with a uniquely executed exact source call are supported.
 * Status/UI/amount coincidence are never proof. Missing historical trace/code/receipts fails closed. */
export async function verifyBaseNativeRelayProof(source:Client,destination:Client,input:BaseNativeRelayProofInput,automation:Address):Promise<BaseNativeRelayEvidence> {
  if(input.version===2)return verifyBaseNativeTraceProof(source,destination,input,automation);
  if(input.version!==1||input.protocol!==BASE_NATIVE_BUYBACK_PROTOCOL||!hash(input.sourceHash)||!hash(input.destinationHash))throw new Error("Unsupported native provenance version");
  const raw=object(input.raw),protocol=object(object(raw.protocol).v2),order=object(protocol.orderData),details=object(raw.details);
  if(!hash(raw.requestId)||protocol.hubType!=="onchain"||order.version!=="v1"||order.solverChainId!=="base"||!Array.isArray(order.inputs)||order.inputs.length!==1||!Array.isArray(order.fees)||order.fees.length)throw new Error("Unsupported native Relay order");
  requireAddress(order.solver,SOLVER);const orderId=relayOrderId(order),metadata=relayRequestMetadata(raw.requestId);
  if(!hash(protocol.orderId)||protocol.orderId.toLowerCase()!==orderId.toLowerCase()||typeof protocol.orderSignature!=="string"||
    !sameAddress(await recoverMessageAddress({message:{raw:orderId},signature:protocol.orderSignature as Hex}),SOLVER))throw new Error("Native Relay solver signature mismatch");
  requireAddress(details.sender,automation);requireAddress(details.recipient,BASE_BUYBACK_TREASURY);
  const payment=object(order.inputs[0].payment),output=object(order.output);
  if(payment.chainId!=="base"||payment.weight!=="1"||output.chainId!=="robinhood"||!Array.isArray(output.payments)||output.payments.length!==1||!Array.isArray(output.calls)||output.calls.length||!Number.isSafeInteger(output.deadline))throw new Error("Unsupported native Relay order parameters");
  requireAddress(payment.currency,zeroAddress);const nativeExpected=integer(payment.amount);
  const destinationPayment=object(output.payments[0]);requireAddress(destinationPayment.recipient,BASE_BUYBACK_TREASURY);requireAddress(destinationPayment.currency,BASE_BUYBACK_RH_WETH);
  const minimum=integer(destinationPayment.minimumAmount),expected=integer(destinationPayment.expectedAmount);if(minimum>expected)throw new Error("Invalid native output amounts");
  const pd=object(protocol.paymentDetails);if(pd.chainId!=="base"||integer(pd.amount)!==nativeExpected)throw new Error("Native Relay payment mismatch");requireAddress(pd.currency,zeroAddress);requireAddress(pd.depository,RELAY_DEPOSITORY);
  const refunds=order.inputs[0].refunds;if(!Array.isArray(refunds)||refunds.length!==2||new Set(refunds.map((row:any)=>row.chainId)).size!==2)throw new Error("Unsupported native refunds");
  const routerData=`0x${"0".repeat(24)}${RELAY_ROUTER.slice(2)}`.toLowerCase();if(typeof output.extraData!=="string"||output.extraData.toLowerCase()!==routerData)throw new Error("Unsupported native output router");
  for(const refund of refunds){if(!["base","robinhood"].includes(refund.chainId)||refund.deadline!==output.deadline||integer(refund.minimumAmount,true)!==0n||typeof refund.extraData!=="string"||refund.extraData.toLowerCase()!==routerData)throw new Error("Unsupported native refund path");requireAddress(refund.currency,zeroAddress);requireAddress(refund.recipient,refund.chainId==="base"?automation:BASE_BUYBACK_TREASURY);}
  const steps=raw.steps;if(!Array.isArray(steps))throw new Error("Native source request missing");const depositSteps=steps.filter((step:any)=>step.id==="deposit");
  if(depositSteps.length!==1||!Array.isArray(depositSteps[0].items)||depositSteps[0].items.length!==1)throw new Error("Ambiguous native source request");
  const tx=object(depositSteps[0].items[0].data);if(tx.chainId!==8453||integer(tx.value,true)!==0n)throw new Error("Unsupported native source transaction");requireAddress(tx.from,automation);requireAddress(tx.to,RELAY_APPROVAL_PROXY);
  const decoded=decodeFunctionData({abi:approvalProxyAbi,data:tx.data});const [tokens,amounts,,, ,tag]=decoded.args;
  if(decoded.functionName!=="transferAndMulticall"||tokens.length!==1||amounts.length!==1||amounts[0]===0n||tag.toLowerCase()!==metadata)throw new Error("Unsupported native source layout");
  const sourceAsset=requireAddress(tokens[0]),sourceAmount=amounts[0];const currencyIn=object(details.currencyIn),currencyOut=object(details.currencyOut);
  if(object(currencyIn.currency).chainId!==8453||object(currencyOut.currency).chainId!==4663||integer(currencyIn.amount)!==sourceAmount||integer(currencyOut.minimumAmount)!==minimum||integer(currencyOut.amount)!==expected)throw new Error("Native source/destination quantities mismatch");
  requireAddress(object(currencyIn.currency).address,sourceAsset);requireAddress(object(currencyOut.currency).address,BASE_BUYBACK_RH_WETH);
  const [sr,dr]=await Promise.all([canonicalBaseReceipt(source,input.sourceHash,8453),canonicalBaseReceipt(destination,input.destinationHash,4663)]);
  if(sr.status!=="success"||dr.status!=="success")throw new Error("Native Relay receipt reverted");
  const [sb,db]=await Promise.all([source.getBlock({blockNumber:sr.blockNumber}),destination.getBlock({blockNumber:dr.blockNumber})]);
  if(sb.timestamp>BigInt(output.deadline)||db.timestamp>BigInt(output.deadline)||db.timestamp<sb.timestamp)throw new Error("Native Relay receipt outside order interval");
  for(const address of [RELAY_APPROVAL_PROXY,RELAY_DEPOSITORY,RELAY_ROUTER]) {
    const code=await source.getCode({address,blockNumber:sr.blockNumber});if(!code||code==="0x"||keccak256(code)!==BUYBACK_CODE_HASHES[address.toLowerCase()])throw new Error("Unreviewed native source implementation");
  }
  const destinationCode=await destination.getCode({address:RELAY_ROUTER,blockNumber:dr.blockNumber});
  if(!destinationCode||destinationCode==="0x"||keccak256(destinationCode)!==BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()])throw new Error("Unreviewed native destination implementation");
  // Imported traces are not trusted. Query the canonical RPC; unsupported tracing leaves this task unknown.
  const trace=await source.request({method:"debug_traceTransaction" as any,params:[input.sourceHash,{tracer:"callTracer"}] as any});
  if(traceMatches(trace,automation,RELAY_APPROVAL_PROXY,tx.data)!==1)throw new Error("Native Automation exact source call is not uniquely traced");
  const sourceTransfers=decodedLogs(sr,sourceAsset,erc20Abi).filter(({event})=>event.eventName==="Transfer"&&sameAddress(event.args.from,automation));
  if(sourceTransfers.length!==1||!sameAddress(sourceTransfers[0].event.args.to,RELAY_APPROVAL_PROXY)||sourceTransfers[0].event.args.value!==sourceAmount)throw new Error("Native source spending is ambiguous");
  const deposits=decodedLogs(sr,RELAY_DEPOSITORY,relayNativeAbi).filter(({event})=>sameAddress(event.args.from,automation));
  if(deposits.length!==1||deposits[0].event.args.id.toLowerCase()!==orderId.toLowerCase()||deposits[0].event.args.amount<=0n)throw new Error("Native source deposit is not bound to its signed order");
  const movements=decodedLogs(dr,RELAY_ROUTER,movementAbi).filter(({event})=>sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,BASE_BUYBACK_TREASURY)&&sameAddress(event.args.currency,BASE_BUYBACK_RH_WETH)&&event.args.metadata.toLowerCase()===metadata);
  const transfers=decodedLogs(dr,BASE_BUYBACK_RH_WETH,erc20Abi).filter(({event})=>event.eventName==="Transfer"&&sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,BASE_BUYBACK_TREASURY));
  if(movements.length!==1||transfers.length!==1||movements[0].event.args.amount!==transfers[0].event.args.value||transfers[0].event.args.value<minimum)throw new Error("Native destination order and actual WETH receipt are not a unique match");
  if((await source.getBlock({blockNumber:sr.blockNumber})).hash!==sr.blockHash||(await destination.getBlock({blockNumber:dr.blockNumber})).hash!==dr.blockHash)throw new Error("Native proof reorganized during validation");
  return {version:1,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,orderParametersVerified:true,requestId:raw.requestId,orderId,metadata,sourceTransactionHash:sr.transactionHash,sourceBlockNumber:String(sr.blockNumber),sourceBlockHash:sr.blockHash,
    sourceTransferLogIndex:sourceTransfers[0].log.logIndex!,sourceDepositLogIndex:deposits[0].log.logIndex!,sourceAsset,sourceAmount:String(sourceAmount),sourceNativeDeposit:String(deposits[0].event.args.amount),automation,
    treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:String(transfers[0].event.args.value),destinationTransactionHash:dr.transactionHash,destinationBlockNumber:String(dr.blockNumber),destinationBlockHash:dr.blockHash,
    destinationTransferLogIndex:transfers[0].log.logIndex!,destinationMovementLogIndex:movements[0].log.logIndex!,sourceCalldataHash:keccak256(tx.data)};
}
export async function verifyAdapterRelease(client:Client,event:CustodyEvent,collector:Address,automation:Address) {
  const receipt=await canonicalBaseReceipt(client,event.transactionHash,8453);
  if(receipt.blockHash!==event.blockHash||event.kind!=="in"||!sameAddress(event.from,collector)||!sameAddress(event.to,automation))throw new Error("Adapter funding identity mismatch");
  const releases=decodedLogs(receipt,collector,baseCollectorAbi).filter(({event:row})=>row.eventName==="FeesReleased"&&sameAddress(row.args.token,event.asset)&&sameAddress(row.args.receiver,automation)&&String(row.args.amount)===event.amount);
  const transfers=decodedLogs(receipt,event.asset,erc20Abi).filter(({log,event:row})=>row.eventName==="Transfer"&&log.logIndex===event.logIndex&&sameAddress(row.args.from,collector)&&sameAddress(row.args.to,automation)&&String(row.args.value)===event.amount);
  if(releases.length!==1||transfers.length!==1)throw new Error("Adapter release does not prove actual isolated fees");
  return {kind:"adapter_release" as const,collector,releaseLogIndex:releases[0].log.logIndex!,transactionHash:event.transactionHash,blockHash:event.blockHash};
}
/** The fixed Forwarder event and Treasury->Vault WETH transfer must be in one successful canonical receipt. */
export async function verifyTreasuryForward(client:Client,event:CustodyEvent,vaultEvent:VaultLedgerEvent) {
  if(event.kind!=="out"||vaultEvent.kind!=="weth_in"||!sameAddress(event.asset,BASE_BUYBACK_RH_WETH)||!sameAddress(event.from,BASE_BUYBACK_TREASURY)||!sameAddress(event.to,BASE_BUYBACK_VAULT)||event.id!==vaultEvent.id||event.amount!==vaultEvent.amount||event.blockHash!==vaultEvent.blockHash)throw new Error("Treasury propagation transfer mismatch");
  const receipt=await canonicalBaseReceipt(client,event.transactionHash,4663);
  const forward=decodedLogs(receipt,BASE_BUYBACK_FORWARDER,forwardAbi);
  const matching=decodedLogs(receipt,BASE_BUYBACK_RH_WETH,erc20Abi).filter(({log,event:row})=>row.eventName==="Transfer"&&log.logIndex===event.logIndex&&sameAddress(row.args.from,BASE_BUYBACK_TREASURY)&&sameAddress(row.args.to,BASE_BUYBACK_VAULT)&&String(row.args.value)===event.amount);
  if(receipt.status!=="success"||receipt.blockHash!==event.blockHash||forward.length!==1||String(forward[0].event.args.amount)!==event.amount||matching.length!==1)throw new Error("Treasury Forwarder lacks unique canonical event and actual transfer");
}
export function nativeRelayFragments(input:CustodyFragment[],relay:BaseNativeRelayEvidence,batchId=relay.requestId as string):CustodyFragment[] {
  return convertCustodyFragments(input,relay.sourceAmount,relay.outputAmount).map(fragment=>({...fragment,batchId:fragment.batchId?batchId:null}));
}
export type BaseNativeExecutionAcceptance = {version:1;batchId?:string;protocol:typeof BASE_NATIVE_BUYBACK_PROTOCOL;proof:BaseNativeRelayProofInput;
  automation:{state:CustodyState;events:CustodyEvent[]};treasury:{state:CustodyState;events:CustodyEvent[]};vault:{state:VaultLedgerState;events:VaultLedgerEvent[]}};
const transferEvent=parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"])[0];
const executedAbi=parseAbi(["function totalSpent() view returns(uint256)","function totalBurned() view returns(uint256)","event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)"]);
/** Independent ten-block RPC reads use bounded batches, preserving the provider's range limit and all results. */
async function scanCanonicalLogs(client:Client,from:bigint,to:bigint,queries:{address?:Address;event:any;args?:any}[]):Promise<any[][]> {
 const output:any[][]=queries.map(()=>[]),rangesPerBatch=Math.max(1,Math.floor(20/queries.length));
 for(let start=from;start<=to;start+=BigInt(rangesPerBatch*10)) {
  const groups=await Promise.all(Array.from({length:Math.min(rangesPerBatch,Number((to-start)/10n)+1)},(_,index)=>{
   const lower=start+BigInt(index*10),upper=lower+9n<to?lower+9n:to;
   return Promise.all(queries.map(query=>client.getLogs({...query,fromBlock:lower,toBlock:upper,strict:true})));
  }));
  for(const group of groups)group.forEach((logs,index)=>output[index].push(...logs));
 }
 return output;
}
async function completeTransfers(client:Client,account:Address,from:bigint,to:bigint,asset?:Address) {
  const events:CustodyEvent[]=[];
  const groups=await scanCanonicalLogs(client,from,to,[{...(asset?{address:asset}:{}),event:transferEvent,args:{from:account}},{...(asset?{address:asset}:{}),event:transferEvent,args:{to:account}}]);
    for(const log of groups.flat()) {
      if(log.removed||!log.transactionHash||!log.blockHash||log.blockNumber===null||log.logIndex===null||log.transactionIndex===null)throw new Error("Noncanonical acceptance transfer log");
      const event=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics,strict:true});
      if(sameAddress(event.args.from,event.args.to))throw new Error("Ambiguous acceptance self-transfer");
      events.push({id:vaultEventId(log.transactionHash,log.logIndex),blockNumber:String(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,
        transactionIndex:log.transactionIndex,logIndex:log.logIndex,asset:log.address,kind:sameAddress(event.args.to,account)?"in":"out",from:event.args.from,to:event.args.to,amount:String(event.args.value)});
    }
  return events;
}
export function canonicalProofJson(value:unknown):string {
 const normalize=(value:any):any=>Array.isArray(value)?value.map(normalize):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):typeof value==="string"&&/^0x[\da-f]*$/i.test(value)?value.toLowerCase():value;
 return JSON.stringify(normalize(value));
}
const custodyRaw=(event:CustodyEvent)=>{const{fragments:_f,evidence:_e,nativeRequestMetadata:_m,...raw}=event;return raw;};
function equalJournal(actual:CustodyEvent[],provided:CustodyEvent[]) {
  const a=new Map(actual.map(event=>[event.id,canonicalProofJson(event)]));if(a.size!==actual.length||provided.length!==actual.length)throw new Error("Acceptance journal omitted or duplicated canonical movements");
  for(const event of provided)if(a.get(event.id)!==canonicalProofJson(custodyRaw(event)))throw new Error("Acceptance journal movement differs from canonical logs");
}
async function verifyCanonicalCustodyJournal(client:Client,journal:BaseNativeExecutionAcceptance["automation"],id:"base_automation"|"robinhood_treasury",account:Address) {
  const state=journal.state,chain=id==="base_automation"?8453:4663;
  if(state.id!==id||state.chainId!==chain||!sameAddress(state.account,account)||await client.getChainId()!==chain)throw new Error("Acceptance custody graph/chain mismatch");
  const head=await client.getBlockNumber();if(head<BigInt(state.cursor.number)+64n)throw new Error("Acceptance custody cursor lacks confirmed depth");
  for(const block of [state.checkpoint,state.cursor])if((await client.getBlock({blockNumber:BigInt(block.number)})).hash!==block.hash)throw new Error("Acceptance custody checkpoint/cursor reorg");
  const actual=await completeTransfers(client,account,BigInt(state.checkpoint.number)+1n,BigInt(state.cursor.number),id==="robinhood_treasury"?BASE_BUYBACK_RH_WETH:undefined);equalJournal(actual,journal.events);
  const assets=new Set([...Object.keys(state.openingBalances),...Object.keys(state.observedBalances),...actual.map(event=>event.asset.toLowerCase())]);
  if(id==="robinhood_treasury"&&(assets.size!==1||!assets.has(BASE_BUYBACK_RH_WETH.toLowerCase())))throw new Error("Acceptance Treasury journal must cover all canonical WETH");
  const list=[...assets];for(let index=0;index<list.length;index+=10)await Promise.all(list.slice(index,index+10).map(async asset=>{
    const [opening,end]=await Promise.all([client.readContract({address:asset as Address,abi:erc20Abi,functionName:"balanceOf",args:[account],blockNumber:BigInt(state.checkpoint.number)}),client.readContract({address:asset as Address,abi:erc20Abi,functionName:"balanceOf",args:[account],blockNumber:BigInt(state.cursor.number)})]);
    if(state.openingBalances[asset]!==String(opening)||state.observedBalances[asset]!==String(end))throw new Error("Acceptance custody opening/current balance is fabricated");}));
  return actual;
}
async function verifyCanonicalVaultJournal(client:Client,journal:BaseNativeExecutionAcceptance["vault"],swapper:Address) {
  const state=journal.state;if(state.chainId!==4663||!sameAddress(state.vault,BASE_BUYBACK_VAULT)||!sameAddress(state.weth,BASE_BUYBACK_RH_WETH)||!sameAddress(state.swapper,swapper)||await client.getChainId()!==4663)throw new Error("Acceptance Vault graph mismatch");
  const head=await client.getBlockNumber();if(head<BigInt(state.cursor.number)+64n)throw new Error("Acceptance Vault cursor lacks confirmed depth");
  for(const block of [state.checkpoint,state.cursor])if((await client.getBlock({blockNumber:BigInt(block.number)})).hash!==block.hash)throw new Error("Acceptance Vault checkpoint/cursor reorg");
  for(const [block,opening] of [[state.checkpoint,true],[state.cursor,false]] as const) {
    const [balance,spent,burned]=await Promise.all([client.readContract({address:state.weth,abi:erc20Abi,functionName:"balanceOf",args:[state.vault],blockNumber:BigInt(block.number)}),client.readContract({address:state.vault,abi:executedAbi,functionName:"totalSpent",blockNumber:BigInt(block.number)}),client.readContract({address:state.vault,abi:executedAbi,functionName:"totalBurned",blockNumber:BigInt(block.number)})]);
    if(String(balance)!==(opening?state.checkpoint.wethBalance:state.observedBalance)||String(spent)!==(opening?state.checkpoint.totalSpent:state.observedTotalSpent)||String(burned)!==(opening?state.checkpoint.totalBurned:state.observedTotalBurned))throw new Error("Acceptance Vault balances/counters are fabricated");
  }
  const transfers=await completeTransfers(client,state.vault,BigInt(state.checkpoint.number)+1n,BigInt(state.cursor.number),state.weth);
  const provided=journal.events.filter(event=>event.kind!=="executed").map(event=>{return{...event,asset:state.weth,kind:event.kind==="weth_in"?"in" as const:"out" as const};});
  // Vault's source labels/proofs are excluded from raw movement comparison.
  equalJournal(transfers,provided.map(event=>{const {source:_s,baseFill:_b,...raw}=event as any;return raw;}));
  const actualExecutions:VaultLedgerEvent[]=[];
  const [logs]=await scanCanonicalLogs(client,BigInt(state.checkpoint.number)+1n,BigInt(state.cursor.number),[{address:state.vault,event:executedAbi[2]}]);
    for(const log of logs){if(log.removed||!log.transactionHash||!log.blockHash||log.logIndex===null||log.transactionIndex===null||log.blockNumber===null)throw new Error("Noncanonical Vault Executed log");
      const event=decodeEventLog({abi:executedAbi,data:log.data,topics:log.topics,strict:true});if(event.eventName!=="Executed")throw new Error("Invalid Vault event");
      actualExecutions.push({id:vaultEventId(log.transactionHash,log.logIndex),blockNumber:String(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,transactionIndex:log.transactionIndex,logIndex:log.logIndex,kind:"executed",caller:event.args.caller,wethAmount:String(event.args.wethAmount),museToDead:String(event.args.museToDead),profit:String(event.args.profit)});}
  const executions=journal.events.filter(event=>event.kind==="executed"),map=new Map(actualExecutions.map(event=>[event.id,canonicalProofJson(event)]));
  if(executions.length!==actualExecutions.length||executions.some(event=>map.get(event.id)!==canonicalProofJson(event)))throw new Error("Acceptance Executed events are fabricated/omitted");
}
/** Acceptance is reconstructed from all canonical movements, balances and executions. Documents carry evidence; they do not assert money. */
export async function verifyBaseNativeActivation(source:Client,destination:Client,manifest:any,head:bigint,deps:{relay?:typeof verifyBaseNativeRelayProof}={}) {
  const execution=object(manifest.activation?.nativeExecution) as BaseNativeExecutionAcceptance;
  if(execution.version!==1||execution.protocol!==BASE_NATIVE_BUYBACK_PROTOCOL)throw new Error("Native closed-loop acceptance missing");
  const automation=requireAddress(manifest.constants.automationReceiver),collector=requireAddress(manifest.collector.address),swapper=requireAddress("0xE8834943A4eD3758f3b5930E3EEfb43568B222b3");
  const relay=await(deps.relay??verifyBaseNativeRelayProof)(source,destination,execution.proof,automation);
  if(BigInt(relay.sourceBlockNumber)>head||BigInt(relay.outputAmount)>10n**16n)throw new Error("Native canary outside acceptance budget/head");
  await Promise.all([verifyCanonicalCustodyJournal(source,execution.automation,"base_automation",automation),verifyCanonicalCustodyJournal(destination,execution.treasury,"robinhood_treasury",BASE_BUYBACK_TREASURY),verifyCanonicalVaultJournal(destination,execution.vault,swapper)]);
  const released=new Map<string,bigint>(),releaseReceipts=new Set<Hex>(),releaseEvent=parseAbi(["event FeesReleased(address indexed token,address indexed receiver,uint256 amount)"])[0],claimEvent=parseAbi(["event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)"])[0];
  const initial=integer(manifest.collector.blockNumber);
  // Global Adapter release history proves pre-funding checkpoints and cumulative principal budgets, including assets not used by the selected Relay order.
  const [logs,claims]=await scanCanonicalLogs(source,initial,BigInt(execution.automation.state.cursor.number),[{address:collector,event:releaseEvent},{address:collector,event:claimEvent}]);
    // Canonical zero-credit races still spend gas. Include every Collector claim, independently of Automation transfers.
    for(const claim of claims){if(!claim.transactionHash||!claim.blockHash||claim.blockNumber===null||claim.removed)throw new Error("Unverified canary claim receipt");const block=await source.getBlock({blockNumber:claim.blockNumber});if(block.hash!==claim.blockHash||block.timestamp>integer(manifest.canaryAuthorization.expiresAt))throw new Error("Canary fee claim outside authorization");releaseReceipts.add(claim.transactionHash);}
    for(const log of logs) {const event=decodeEventLog({abi:[releaseEvent],data:log.data,topics:log.topics,strict:true});if(!sameAddress(event.args.receiver,automation)||!log.transactionHash||!log.blockHash||log.blockNumber===null)throw new Error("Unverified canary fee release");
      if(log.blockNumber<=BigInt(execution.automation.state.checkpoint.number))throw new Error("Acceptance Automation checkpoint was established after Base funding");
      const block=await source.getBlock({blockNumber:log.blockNumber});if(block.hash!==log.blockHash||block.timestamp>integer(manifest.canaryAuthorization.expiresAt))throw new Error("Canary fee release outside authorization");
      const key=event.args.token.toLowerCase();released.set(key,(released.get(key)??0n)+event.args.amount);releaseReceipts.add(log.transactionHash);
    }
  for(const [token,amount] of released){const budget=manifest.canaryAuthorization?.releaseBudgets?.find((row:any)=>sameAddress(row.token,token));if(!budget||amount>integer(budget.maxAmount))throw new Error("Cumulative canary release budget exceeded");}
  const arEvents=execution.automation.events.map(event=>({...event}));
  for(const event of arEvents) {
    if(event.kind!=="in")continue;
    if(sameAddress(event.from,collector)) {const proof=await verifyAdapterRelease(source,event,collector,automation),code=await source.getCode({address:collector,blockNumber:BigInt(event.blockNumber)});
      if(!code||code==="0x"||keccak256(code)!==manifest.collector.runtimeHash)throw new Error("Unreviewed historical fee adapter implementation");
      const expected=[{batchId:event.id,amount:event.amount}];if(canonicalProofJson(event.evidence)!==canonicalProofJson(proof)||canonicalProofJson(event.fragments)!==canonicalProofJson(expected))throw new Error("Source fee fragments are fabricated");
    } else if(event.fragments||event.evidence)throw new Error("Opening/donation/unknown source funds cannot declare Base provenance");
  }
  const ar=replayCustodyLedger(execution.automation.state,arEvents,BigInt(execution.automation.state.cursor.number));
  const sourceConsumption=ar.consumptions.find(row=>row.eventId===vaultEventId(relay.sourceTransactionHash,relay.sourceTransferLogIndex));
  if(!ar.ready||!sourceConsumption||sourceConsumption.amount!==relay.sourceAmount||sourceConsumption.fragments.some(row=>row.batchId===null))throw new Error("Native canary consumes unverified/unknown funds");
  const batchId=execution.batchId??relay.requestId;if(batchId!==relay.requestId&&batchId!==`native-source:${relay.sourceTransactionHash}`)throw new Error("Native acceptance batch identity mismatch");
  const expectedFragments=nativeRelayFragments(sourceConsumption.fragments,relay,batchId);
  const treasuryInId=vaultEventId(relay.destinationTransactionHash,relay.destinationTransferLogIndex);
  const trEvents=execution.treasury.events.map(event=>({...event}));
  for(const event of trEvents)if(event.kind==="in") {
    if(event.id===treasuryInId){if(event.blockHash!==relay.destinationBlockHash||event.amount!==relay.outputAmount||event.evidence?.kind!=="native_relay"||canonicalProofJson(event.evidence.relay)!==canonicalProofJson(relay)||event.evidence.sourceEventId!==sourceConsumption.eventId||canonicalProofJson(event.fragments)!==canonicalProofJson(expectedFragments))throw new Error("Canary Treasury fragments do not match verified source FIFO");}
    else if(event.fragments||event.evidence)throw new Error("Other Treasury funding is unknown in this canary acceptance");
  }
  if(!trEvents.some(event=>event.id===treasuryInId))throw new Error("Canary destination receipt not indexed");
  const tr=replayCustodyLedger(execution.treasury.state,trEvents,BigInt(execution.treasury.state.cursor.number));if(!tr.ready)throw new Error("Canary Treasury does not reconcile");
  for(const event of execution.vault.events)if(event.kind==="weth_in") {
    if(sameAddress(event.from,BASE_BUYBACK_TREASURY)){const treasuryOut=trEvents.find(row=>row.id===event.id),consumed=tr.consumptions.find(row=>row.eventId===event.id);if(!treasuryOut||!consumed)throw new Error("Canary forwarding journal missing");await verifyTreasuryForward(destination,treasuryOut,event);
      const known=consumed.fragments.some(fragment=>fragment.batchId);if(known&&(event.source!=="base"||!event.baseFill||!("protocol"in event.baseFill)||canonicalProofJson(event.baseFill.fragments)!==canonicalProofJson(consumed.fragments)))throw new Error("Vault provenance differs from canonical Treasury FIFO");
      if(!known&&event.source==="base")throw new Error("Unknown Treasury funds cannot declare Base provenance");
    } else if(event.source==="base")throw new Error("Non-Treasury Vault input cannot declare native Base provenance");
  }
  const vr=replayVaultLedger(execution.vault.state,execution.vault.events,BigInt(execution.vault.state.cursor.number)),batch=vr.batches.find(row=>row.batchId===batchId);
  if(!vr.attributionReady||!batch||batch.receivedWeth!==relay.outputAmount||batch.pendingWeth!=="0"||BigInt(batch.attributedMuseToDead)===0n)throw new Error("This native canary is not completely consumed and actually burned");
  const muse=requireAddress("0x0379E228F6887c6F18bf394042ECAF81B308cb2e"),dead=requireAddress("0x000000000000000000000000000000000000dEaD"),executor=requireAddress("0x787b6a964C3e86A005B8Fda87991e088178A8455");
  const rhHashes=new Set<Hex>([relay.destinationTransactionHash]);
  for(const event of execution.vault.events)if(event.kind==="executed") {
    const receipt=await canonicalBaseReceipt(destination,event.transactionHash,4663),actual=decodedLogs(receipt,muse,erc20Abi).filter(({event:row})=>row.eventName==="Transfer"&&sameAddress(row.args.from,executor)&&sameAddress(row.args.to,dead));
    if(actual.reduce((sum,{event:row})=>sum+row.args.value,0n)!==BigInt(event.museToDead))throw new Error("Canary actual MUSEGOD dead transfer mismatch");
    if(vr.allocations.some(row=>row.executionId===event.id&&row.batchId===batchId))rhHashes.add(event.transactionHash);
  }
  for(const event of trEvents)if(event.kind==="out"&&sameAddress(event.to,BASE_BUYBACK_VAULT))rhHashes.add(event.transactionHash);
  const sourceHashes=new Set<Hex>([...arEvents.map(event=>event.transactionHash),...releaseReceipts]);
  const {readCanonicalBaseTransactionFee}=await import("./base-buyback");let baseGas=0n,rhGas=0n;
  for(const tx of sourceHashes){const receipt=await canonicalBaseReceipt(source,tx,8453);baseGas+=BigInt((await readCanonicalBaseTransactionFee(source,receipt)).totalWei);}
  for(const tx of rhHashes){const receipt=await canonicalBaseReceipt(destination,tx,4663);rhGas+=receipt.gasUsed*receipt.effectiveGasPrice;}
  if(baseGas>integer(manifest.canaryAuthorization.maxBaseGasWei)||rhGas>integer(manifest.canaryAuthorization.maxRobinhoodGasWei))throw new Error("Canary actual gas budget exceeded");
  return {sourceHash:relay.sourceTransactionHash,destinationHash:relay.destinationTransactionHash,receivedWeth:relay.outputAmount,museToDead:batch.attributedMuseToDead,
    sourceSpentAmount:relay.sourceAmount,sourceAsset:relay.sourceAsset,baseGasWei:String(baseGas),robinhoodGasWei:String(rhGas)};
}
