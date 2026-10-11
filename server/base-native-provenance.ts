import { verifyBaseNativeDestinationReceipt, verifyBaseNativeSourceTrace, verifyBaseNativeTraceProof, type NativeDestinationVerificationOptions } from "./base-native-trace";
import { decodeEventLog, decodeFunctionData, erc20Abi, getAddress, isAddress, keccak256, parseAbi, recoverMessageAddress, zeroAddress, type Address, type Hex, type PublicClient, type Transport, type TransactionReceipt } from "viem";
import { sameAddress, STOCKS } from "../src/lib/config";
import { BASE_BUYBACK_FORWARDER, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_NATIVE_BUYBACK_PROTOCOL, baseCollectorAbi, integer,
  BASE_BUYBACK_WETH, type BaseNativeRelayEvidence, type BaseNativeRelayProofInput } from "../src/lib/base-buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import { approvalProxyAbi, BUYBACK_CODE_HASHES, RELAY_ROUTER, relayOrderId, relayRequestMetadata } from "./buyback";
import { canonicalBaseReceipt } from "./base-buyback";
import { readBaseAudit, type BaseAuditStore } from "./base-audit";
import { stringToHex } from "viem";
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
/** Only retained, solver-signed Relay v1 native-payment orders with a uniquely executed exact source call are supported.
 * Status/UI/amount coincidence are never proof. Missing historical trace/code/receipts fails closed. */
export async function verifyBaseNativeRelayProof(source:Client,destination:Client,input:BaseNativeRelayProofInput,automation:Address,options?:NativeDestinationVerificationOptions):Promise<BaseNativeRelayEvidence> {
  if(input.version===2)return verifyBaseNativeTraceProof(source,destination,input,automation,options);
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
  const actualSource=await verifyBaseNativeSourceTrace(source,input.sourceHash,automation);
  await verifyBaseNativeDestinationReceipt(destination,input.destinationHash,actualSource,options);
  if(actualSource.requestId.toLowerCase()!==raw.requestId.toLowerCase()||actualSource.orderId.toLowerCase()!==orderId.toLowerCase()||actualSource.sourceCalldataHash!==keccak256(tx.data)||
    !sameAddress(actualSource.sourceAsset,sourceAsset)||actualSource.sourceAmount!==String(sourceAmount))throw new Error("Signed native order differs from the actual Router source graph");
  const sourceTransfers=decodedLogs(sr,sourceAsset,erc20Abi).filter(({event})=>event.eventName==="Transfer"&&event.args.value>0n&&!sameAddress(event.args.from,event.args.to)&&sameAddress(event.args.from,automation));
  if(sourceTransfers.length!==1||!sameAddress(sourceTransfers[0].event.args.to,RELAY_ROUTER)||sourceTransfers[0].event.args.value!==sourceAmount)throw new Error("Native source spending is ambiguous");
  const deposits=decodedLogs(sr,RELAY_DEPOSITORY,relayNativeAbi).filter(({event})=>sameAddress(event.args.from,automation));
  if(deposits.length!==1||deposits[0].event.args.id.toLowerCase()!==orderId.toLowerCase()||deposits[0].event.args.amount<=0n)throw new Error("Native source deposit is not bound to its signed order");
  const movements=decodedLogs(dr,RELAY_ROUTER,movementAbi).filter(({event})=>sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,BASE_BUYBACK_TREASURY)&&sameAddress(event.args.currency,BASE_BUYBACK_RH_WETH)&&event.args.metadata.toLowerCase()===metadata);
  const transfers=decodedLogs(dr,BASE_BUYBACK_RH_WETH,erc20Abi).filter(({event})=>event.eventName==="Transfer"&&event.args.value>0n&&sameAddress(event.args.from,RELAY_ROUTER)&&sameAddress(event.args.to,BASE_BUYBACK_TREASURY));
  if(movements.length!==1||transfers.length!==1||movements[0].event.args.amount!==transfers[0].event.args.value||transfers[0].event.args.value<minimum)throw new Error("Native destination order and actual WETH receipt are not a unique match");
  if((await source.getBlock({blockNumber:sr.blockNumber})).hash!==sr.blockHash||(await destination.getBlock({blockNumber:dr.blockNumber})).hash!==dr.blockHash)throw new Error("Native proof reorganized during validation");
  return {version:1,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,orderParametersVerified:true,requestId:raw.requestId,orderId,metadata,sourceTransactionHash:sr.transactionHash,sourceBlockNumber:String(sr.blockNumber),sourceBlockHash:sr.blockHash,
    sourceTransferLogIndex:sourceTransfers[0].log.logIndex!,sourceDepositLogIndex:deposits[0].log.logIndex!,sourceAsset,sourceAmount:String(sourceAmount),sourceNativeDeposit:String(deposits[0].event.args.amount),automation,
    treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:String(transfers[0].event.args.value),destinationTransactionHash:dr.transactionHash,destinationBlockNumber:String(dr.blockNumber),destinationBlockHash:dr.blockHash,
    destinationTransferLogIndex:transfers[0].log.logIndex!,destinationMovementLogIndex:movements[0].log.logIndex!,sourceCalldataHash:keccak256(tx.data)};
}
async function adapterReleaseMatch(client:Client,event:CustodyEvent,collector:Address,automation:Address) {
  const receipt=await canonicalBaseReceipt(client,event.transactionHash,8453);
  if(receipt.blockHash!==event.blockHash||event.kind!=="in"||!sameAddress(event.from,collector)||!sameAddress(event.to,automation))throw new Error("Adapter funding identity mismatch");
  const releases=decodedLogs(receipt,collector,baseCollectorAbi).filter(({event:row})=>["FeesReleased","UntrackedReleased"].includes(row.eventName)&&sameAddress(row.args.token,event.asset)&&sameAddress(row.args.receiver,automation)).sort((a,b)=>a.log.logIndex!-b.log.logIndex!);
  const transfers=decodedLogs(receipt,event.asset,erc20Abi).filter(({log,event:row})=>row.eventName==="Transfer"&&log.logIndex===event.logIndex&&sameAddress(row.args.from,collector)&&sameAddress(row.args.to,automation)&&String(row.args.value)===event.amount);
  if(transfers.length!==1)throw new Error("Adapter release does not prove actual isolated fees");
  const actualTransfers=decodedLogs(receipt,event.asset,erc20Abi).filter(({event:row})=>row.eventName==="Transfer"&&sameAddress(row.args.from,collector)&&sameAddress(row.args.to,automation));
  let previous=-1,matched:typeof releases[number]|undefined;
  for(const release of releases){
    // The immutable adapter emits its release after transfer/balance checks. Match each call's preceding transfer
    // independently, including an unknown-bucket release, so equal amounts in one multicall cannot alias.
    const eligible=actualTransfers.filter(row=>row.log.logIndex!>previous&&row.log.logIndex!<release.log.logIndex!&&String(row.event.args.value)===String(release.event.args.amount)).sort((a,b)=>b.log.logIndex!-a.log.logIndex!);
    if(!eligible.length)throw new Error("Adapter release has no corresponding actual transfer");
    if(eligible[0].log.logIndex===event.logIndex)matched=release;
    previous=release.log.logIndex!;
  }
  if(!matched||String(matched.event.args.amount)!==event.amount)throw new Error("Adapter release does not prove an actual transfer");
  return{genuine:matched.event.eventName==="FeesReleased",proof:{kind:"adapter_release" as const,collector,releaseLogIndex:matched.log.logIndex!,transactionHash:event.transactionHash,blockHash:event.blockHash}};
}
export async function verifyAdapterRelease(client:Client,event:CustodyEvent,collector:Address,automation:Address) {
  const match=await adapterReleaseMatch(client,event,collector,automation);
  if(!match.genuine)throw new Error("Unknown balances cannot declare verified fee provenance");
  return match.proof;
}
/** The fixed Forwarder event and Treasury->Vault WETH transfer must be in one successful canonical receipt. */
export async function verifyTreasuryForward(client:Client,event:CustodyEvent,vaultEvent:VaultLedgerEvent) {
  if(event.kind!=="out"||vaultEvent.kind!=="weth_in"||!sameAddress(event.asset,BASE_BUYBACK_RH_WETH)||!sameAddress(event.from,BASE_BUYBACK_TREASURY)||!sameAddress(event.to,BASE_BUYBACK_VAULT)||event.id!==vaultEvent.id||event.amount!==vaultEvent.amount||event.blockHash!==vaultEvent.blockHash)throw new Error("Treasury propagation transfer mismatch");
  const receipt=await canonicalBaseReceipt(client,event.transactionHash,4663);
  const forward=decodedLogs(receipt,BASE_BUYBACK_FORWARDER,forwardAbi).sort((a,b)=>a.log.logIndex!-b.log.logIndex!);
  const matching=decodedLogs(receipt,BASE_BUYBACK_RH_WETH,erc20Abi).filter(({log,event:row})=>row.eventName==="Transfer"&&log.logIndex===event.logIndex&&sameAddress(row.args.from,BASE_BUYBACK_TREASURY)&&sameAddress(row.args.to,BASE_BUYBACK_VAULT)&&String(row.args.value)===event.amount);
  if(receipt.status!=="success"||receipt.blockHash!==event.blockHash||matching.length!==1)throw new Error("Treasury Forwarder lacks canonical event and actual transfer");
  const movements=decodedLogs(receipt,BASE_BUYBACK_RH_WETH,erc20Abi).filter(({event:row})=>row.eventName==="Transfer"&&sameAddress(row.args.from,BASE_BUYBACK_TREASURY)&&sameAddress(row.args.to,BASE_BUYBACK_VAULT));
  let previous=-1,matched:typeof forward[number]|undefined;
  for(const row of forward){
    const eligible=movements.filter(transfer=>transfer.log.logIndex!>previous&&transfer.log.logIndex!<row.log.logIndex!&&String(transfer.event.args.value)===String(row.event.args.amount)).sort((a,b)=>b.log.logIndex!-a.log.logIndex!);
    if(!eligible.length)throw new Error("Treasury Forwarder event has no corresponding WETH transfer");
    if(eligible[0].log.logIndex===event.logIndex)matched=row;
    previous=row.log.logIndex!;
  }
  if(!matched||String(matched.event.args.amount)!==event.amount)throw new Error("Treasury transfer is not this Forwarder execution");
  return {forwarderLogIndex:matched.log.logIndex!,transferLogIndex:event.logIndex};
}
export function nativeRelayFragments(input:CustodyFragment[],relay:BaseNativeRelayEvidence,batchId=relay.requestId as string):CustodyFragment[] {
  return convertCustodyFragments(input,relay.sourceAmount,relay.outputAmount).map(fragment=>({...fragment,batchId:fragment.batchId?batchId:null}));
}
export type BaseNativeExecutionAcceptance = {version:1;batchId?:string;protocol:typeof BASE_NATIVE_BUYBACK_PROTOCOL;proof:BaseNativeRelayProofInput;
  automation:{state:CustodyState;events:CustodyEvent[]};treasury:{state:CustodyState;events:CustodyEvent[]};vault:{state:VaultLedgerState;events:VaultLedgerEvent[]}};
const transferEvent=parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"])[0];
const executedAbi=parseAbi(["function totalSpent() view returns(uint256)","function totalBurned() view returns(uint256)","event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)"]);
/** Independent ten-block RPC reads use bounded batches, preserving the provider's range limit and all results. */
async function scanCanonicalLogs(client:Client,from:bigint,to:bigint,queries:{address?:Address|Address[];event:any;args?:any}[]):Promise<any[][]> {
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
/** Complete mined release history at a captured canonical head. This is a budget reservation read, not finality
 * or fee-loop acceptance: a latest-block owner transaction must already count before another release is signed. */
export async function readCanonicalBaseCollectorReleaseHistory(client:Client,collector:Address,automation:Address,fromBlock:bigint,toBlock:bigint,auditStore?:BaseAuditStore) {
  type Row={token:Address;amount:string;from:Address;transactionHash:Hex;logIndex:number;blockNumber:string};
  const event=parseAbi(["event FeesReleased(address indexed token,address indexed receiver,uint256 amount)"])[0];
  const id=`internal_native_releases:${keccak256(stringToHex(`${collector.toLowerCase()}:${automation.toLowerCase()}:${fromBlock}`))}`;
  const rows=await readBaseAudit<Row>({client,store:auditStore,id,from:fromBlock,to:toBlock,
    validate:(value):value is Row=>!!value&&typeof value==="object"&&isAddress(String((value as any).token),{strict:false})&&isAddress(String((value as any).from),{strict:false})&&
      typeof (value as any).amount==="string"&&/^[1-9]\d*$/.test((value as any).amount)&&hash((value as any).transactionHash)&&Number.isSafeInteger((value as any).logIndex)&&(value as any).logIndex>=0,
    page:async(first,last)=>{
      const [logs]=await scanCanonicalLogs(client,first,last,[{address:collector,event}]);
      const receipts=new Map<Hex,TransactionReceipt>(),seen=new Set<string>(),output:Row[]=[];
      for(const log of logs){
        if(log.removed||!log.transactionHash||!log.blockHash||log.blockNumber===null||log.transactionIndex===null||log.logIndex===null||log.blockNumber<first||log.blockNumber>last||!sameAddress(log.address,collector))throw new Error("Noncanonical Collector release history log");
        const key=vaultEventId(log.transactionHash,log.logIndex);if(seen.has(key))throw new Error("Duplicate canonical Collector release history log");seen.add(key);
        const decoded=decodeEventLog({abi:[event],data:log.data,topics:log.topics,strict:true});if(!sameAddress(decoded.args.receiver,automation)||decoded.args.amount<=0n)throw new Error("Collector release history receiver/amount mismatch");
        const receipt:TransactionReceipt=receipts.get(log.transactionHash)??await client.getTransactionReceipt({hash:log.transactionHash});receipts.set(log.transactionHash,receipt);
        if(receipt.status!=="success"||receipt.transactionHash.toLowerCase()!==log.transactionHash.toLowerCase()||receipt.blockNumber!==log.blockNumber||receipt.blockHash!==log.blockHash||receipt.transactionIndex!==log.transactionIndex||
          (await client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash||!receipt.logs.some(row=>row.logIndex===log.logIndex&&sameAddress(row.address,collector)&&row.data===log.data&&canonicalProofJson(row.topics)===canonicalProofJson(log.topics)))throw new Error("Collector release history lacks a canonical successful receipt");
        output.push({token:requireAddress(decoded.args.token),amount:String(decoded.args.amount),from:requireAddress(receipt.from),transactionHash:log.transactionHash,logIndex:log.logIndex,blockNumber:String(log.blockNumber)});
      }
      return output;
    }});
  return rows.map(({blockNumber:_blockNumber,...row})=>({...row,amount:BigInt(row.amount)}));
}

async function completeTransfers(client:Client,account:Address,from:bigint,to:bigint,assets:Address|Address[],assetErrors?:Record<string,string>) {
  const events:CustodyEvent[]=[];
  const allowed=new Set((Array.isArray(assets)?assets:[assets]).map(asset=>asset.toLowerCase()));
  const receipts=new Map<Hex,Promise<Awaited<ReturnType<typeof canonicalBaseReceipt>>>>();
  const groups=await scanCanonicalLogs(client,from,to,[{address:assets,event:transferEvent,args:{from:account}},{address:assets,event:transferEvent,args:{to:account}}]);
    for(const log of groups.flat()) {
      if(!allowed.has(log.address.toLowerCase()))continue;
      try {
      if(log.removed||!log.transactionHash||!log.blockHash||log.blockNumber===null||log.logIndex===null||log.transactionIndex===null)throw new Error("Noncanonical acceptance transfer log");
      const event=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics,strict:true});
      if(event.args.value===0n||sameAddress(event.args.from,event.args.to))continue;
      let pending=receipts.get(log.transactionHash);if(!pending){pending=canonicalBaseReceipt(client,log.transactionHash,(await client.getChainId()) as 8453|4663);receipts.set(log.transactionHash,pending);}
      const receipt=await pending;
      if(receipt.status!=="success"||receipt.blockHash!==log.blockHash||receipt.blockNumber!==log.blockNumber||receipt.transactionIndex!==log.transactionIndex||
        !receipt.logs.some(row=>row.logIndex===log.logIndex&&sameAddress(row.address,log.address)&&row.data===log.data&&canonicalProofJson(row.topics)===canonicalProofJson(log.topics)))throw new Error("Acceptance transfer lacks a canonical successful receipt");
      events.push({id:vaultEventId(log.transactionHash,log.logIndex),blockNumber:String(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,
        transactionIndex:log.transactionIndex,logIndex:log.logIndex,asset:log.address,kind:sameAddress(event.args.to,account)?"in":"out",from:event.args.from,to:event.args.to,amount:String(event.args.value)});
      }catch(error){if(!assetErrors)throw error;assetErrors[log.address.toLowerCase()]="Acceptance asset transfer is not canonically verified; attribution withheld";}
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
async function verifyCanonicalCustodyJournal(client:Client,journal:BaseNativeExecutionAcceptance["automation"],id:"base_automation"|"robinhood_treasury",account:Address,requiredAssets:Address[]) {
  const state=journal.state,chain=id==="base_automation"?8453:4663;
  if(state.id!==id||state.chainId!==chain||!sameAddress(state.account,account)||await client.getChainId()!==chain)throw new Error("Acceptance custody graph/chain mismatch");
  const head=await client.getBlockNumber();if(head<BigInt(state.cursor.number)+64n)throw new Error("Acceptance custody cursor lacks confirmed depth");
  for(const block of [state.checkpoint,state.cursor])if((await client.getBlock({blockNumber:BigInt(block.number)})).hash!==block.hash)throw new Error("Acceptance custody checkpoint/cursor reorg");
  // The asset universe comes from the protocol whitelist and canonical immutable-Collector releases, never this document.
  const list=[...new Set(requiredAssets.map(asset=>asset.toLowerCase()))],assetErrors:Record<string,string>={},accepted:CustodyEvent[]=[];
  const openingBalances:Record<string,string>={},observedBalances:Record<string,string>={};
  const actual=await completeTransfers(client,account,BigInt(state.checkpoint.number)+1n,BigInt(state.cursor.number),list as Address[],assetErrors);
  for(let index=0;index<list.length;index+=10)await Promise.all(list.slice(index,index+10).map(async asset=>{
    if(assetErrors[asset])return;
    try{
      const provided=journal.events.filter(event=>sameAddress(event.asset,asset)&&event.amount!=="0"&&!sameAddress(event.from,event.to));
      equalJournal(actual.filter(event=>sameAddress(event.asset,asset)),provided);
      const cursor=state.assetCursors?.[asset];
      if(cursor&&BigInt(cursor.number)<BigInt(state.cursor.number))throw new Error("Acceptance asset transfer backfill is incomplete; attribution withheld");
      const balance=async(number:bigint,opening:boolean)=>{
        try{const value=await client.readContract({address:asset as Address,abi:erc20Abi,functionName:"balanceOf",args:[account],blockNumber:number});
          if(typeof value!=="bigint"||value<0n)throw new Error("Invalid token balance");return value;
        }catch(error){if(opening){const code=await client.getCode({address:asset as Address,blockNumber:number});if(!code||code==="0x")return 0n;}throw error;}
      };
      const [opening,end]=await Promise.all([balance(BigInt(state.checkpoint.number),true),balance(BigInt(state.cursor.number),false)]);
      if(state.openingBalances[asset]!==String(opening)||state.observedBalances[asset]!==String(end))throw new Error("Acceptance custody opening/current balance is fabricated");
      openingBalances[asset]=String(opening);observedBalances[asset]=String(end);accepted.push(...provided);
    }catch(error){const message=error instanceof Error?error.message:"";
      assetErrors[asset]=/^(Acceptance journal|Acceptance custody|Acceptance asset)/.test(message)?message:"Canonical token balance unavailable; asset attribution withheld";
    }
  }));
  // Bad/unsupported assets retain their original journal outside this proof. This reconstructed replay cannot
  // publish their fragments or let caller-selected errors hide an incomplete selected input asset.
  return{state:{...state,openingBalances,observedBalances,assetErrors,assetCursors:undefined},events:accepted};
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
export async function verifyBaseNativeActivation(source:Client,destination:Client,manifest:any,head:bigint,deps:{relay?:typeof verifyBaseNativeRelayProof;auditStore?:NativeDestinationVerificationOptions["auditStore"]}={}) {
  const execution=object(manifest.activation?.nativeExecution) as BaseNativeExecutionAcceptance;
  if(execution.version!==1||execution.protocol!==BASE_NATIVE_BUYBACK_PROTOCOL)throw new Error("Native closed-loop acceptance missing");
  const automation=requireAddress(manifest.constants.automationReceiver),collector=requireAddress(manifest.collector.address),swapper=requireAddress("0xE8834943A4eD3758f3b5930E3EEfb43568B222b3");
  const relay=await(deps.relay??verifyBaseNativeRelayProof)(source,destination,execution.proof,automation,{auditStore:deps.auditStore});
  if(BigInt(relay.sourceBlockNumber)>head||BigInt(relay.outputAmount)>10n**16n)throw new Error("Native canary outside acceptance budget/head");
  const released=new Map<string,bigint>(),releaseReceipts=new Set<Hex>(),releaseEvent=parseAbi(["event FeesReleased(address indexed token,address indexed receiver,uint256 amount)"])[0],unknownEvent=parseAbi(["event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)"])[0],syncEvent=parseAbi(["event UntrackedSynced(address indexed token,uint256 amount)"])[0],claimEvent=parseAbi(["event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)"])[0];
  const requiredAssets=new Set<Address>([...STOCKS.map(stock=>stock.address),BASE_BUYBACK_WETH]);
  const keeper=requireAddress(manifest.canaryAuthorization.keeper);
  const keeperPays=async(client:Client,tx:Hex,chain:8453|4663)=>{
    const receipt=await canonicalBaseReceipt(client,tx,chain);
    const sender=requireAddress(receipt.from);return{receipt,owned:sameAddress(sender,keeper)};
  };
  const initial=integer(manifest.collector.blockNumber);
  // Complete immutable-Adapter history establishes the asset universe and every real-fee pre-funding guard.
  // Owner-signed principal/gas budgets authorize this keeper's transactions; outsiders pay/use their own allowance.
  const [logs,unknownLogs,claims,syncs]=await scanCanonicalLogs(source,initial,BigInt(execution.automation.state.cursor.number),[{address:collector,event:releaseEvent},{address:collector,event:unknownEvent},{address:collector,event:claimEvent},{address:collector,event:syncEvent}]);
    // Zero-credit races still cost the keeper gas. Third-party permissionless calls are canonical evidence,
    // but their gas is paid by their own sender and cannot exhaust this keeper's human-authorized budget.
    for(const claim of claims){if(!claim.transactionHash||!claim.blockHash||claim.blockNumber===null||claim.removed)throw new Error("Unverified canary claim receipt");const block=await source.getBlock({blockNumber:claim.blockNumber});if(block.hash!==claim.blockHash)throw new Error("Canary fee claim reorg");const payer=await keeperPays(source,claim.transactionHash,8453);if(payer.owned&&block.timestamp>integer(manifest.canaryAuthorization.expiresAt))throw new Error("Canary keeper claim outside authorization");if(payer.owned)releaseReceipts.add(claim.transactionHash);}
    for(const log of logs) {const event=decodeEventLog({abi:[releaseEvent],data:log.data,topics:log.topics,strict:true});if(log.removed||!sameAddress(event.args.receiver,automation)||!log.transactionHash||!log.blockHash||log.blockNumber===null||event.args.amount<=0n)throw new Error("Unverified canary fee release");
      if(log.blockNumber<=BigInt(execution.automation.state.checkpoint.number))throw new Error("Acceptance Automation checkpoint was established after Base funding");
      const block=await source.getBlock({blockNumber:log.blockNumber});if(block.hash!==log.blockHash)throw new Error("Canary fee release reorg");const payer=await keeperPays(source,log.transactionHash,8453);if(payer.owned&&block.timestamp>integer(manifest.canaryAuthorization.expiresAt))throw new Error("Canary keeper release outside authorization");
      if(payer.receipt.blockHash!==log.blockHash||!payer.receipt.logs.some(row=>row.logIndex===log.logIndex&&sameAddress(row.address,collector)&&row.data===log.data&&canonicalProofJson(row.topics)===canonicalProofJson(log.topics)))throw new Error("Canary fee release lacks its canonical receipt log");
      requiredAssets.add(requireAddress(event.args.token));
      if(payer.owned){const key=event.args.token.toLowerCase();released.set(key,(released.get(key)??0n)+event.args.amount);releaseReceipts.add(log.transactionHash);}
    }
  for(const log of unknownLogs){const event=decodeEventLog({abi:[unknownEvent],data:log.data,topics:log.topics,strict:true});
    if(log.removed||!sameAddress(event.args.receiver,automation)||!log.transactionHash||!log.blockHash||log.blockNumber===null)throw new Error("Unverified unknown Collector release");
    const payer=await keeperPays(source,log.transactionHash,8453);
    if(payer.receipt.blockHash!==log.blockHash||!payer.receipt.logs.some(row=>row.logIndex===log.logIndex&&sameAddress(row.address,collector)&&row.data===log.data&&canonicalProofJson(row.topics)===canonicalProofJson(log.topics)))throw new Error("Unknown Collector release is not canonical");
    if(payer.owned)throw new Error("Unknown balances cannot satisfy the genuine-fee-only private canary authorization");
    requiredAssets.add(requireAddress(event.args.token));
  }
  for(const log of syncs){
    if(log.removed||!log.transactionHash||!log.blockHash||log.blockNumber===null)throw new Error("Unknown Collector synchronization is not canonical");
    const payer=await keeperPays(source,log.transactionHash,8453);
    if(payer.receipt.blockHash!==log.blockHash||!payer.receipt.logs.some(row=>row.logIndex===log.logIndex&&sameAddress(row.address,collector)&&row.data===log.data&&canonicalProofJson(row.topics)===canonicalProofJson(log.topics)))throw new Error("Unknown Collector synchronization lacks a canonical receipt");
    if(payer.owned)throw new Error("Unknown balances cannot satisfy the genuine-fee-only private canary authorization");
  }
  for(const [token,amount] of released){const budget=manifest.canaryAuthorization?.releaseBudgets?.find((row:any)=>sameAddress(row.token,token));if(!budget||amount>integer(budget.maxAmount))throw new Error("Cumulative canary release budget exceeded");}
  const [canonicalAutomation,canonicalTreasury]=await Promise.all([verifyCanonicalCustodyJournal(source,execution.automation,"base_automation",automation,[...requiredAssets]),verifyCanonicalCustodyJournal(destination,execution.treasury,"robinhood_treasury",BASE_BUYBACK_TREASURY,[BASE_BUYBACK_RH_WETH]),verifyCanonicalVaultJournal(destination,execution.vault,swapper)]);
  const arEvents=canonicalAutomation.events.map(event=>({...event}));
  for(const event of arEvents) {
    if(event.kind!=="in")continue;
    try{
    if(sameAddress(event.from,collector)) {const match=await adapterReleaseMatch(source,event,collector,automation);
      if(!match.genuine){if(event.fragments||event.evidence)throw new Error("Unknown balances cannot declare verified fee provenance");continue;}
      const proof=match.proof,code=await source.getCode({address:collector,blockNumber:BigInt(event.blockNumber)});
      if(!code||code==="0x"||keccak256(code)!==manifest.collector.runtimeHash)throw new Error("Unreviewed historical fee adapter implementation");
      const expected=[{batchId:event.id,amount:event.amount}];if(canonicalProofJson(event.evidence)!==canonicalProofJson(proof)||canonicalProofJson(event.fragments)!==canonicalProofJson(expected))throw new Error("Source fee fragments are fabricated");
    } else if(event.fragments||event.evidence)throw new Error("Opening/donation/unknown source funds cannot declare Base provenance");
    }catch(error){
      // Collector transfers with no matching known release remain unknown. A false classification quarantines
      // only its asset; it cannot publish fragments or disable another asset's fully proved fee loop.
      if(event.fragments||event.evidence){const message=error instanceof Error?error.message:"";canonicalAutomation.state.assetErrors![event.asset.toLowerCase()]=/^(Unknown balances|Source fee|Opening\/donation|Unreviewed historical)/.test(message)?message:"Canonical Collector fee provenance unavailable; attribution withheld";}
      delete event.fragments;delete event.evidence;
    }
  }
  const ar=replayCustodyLedger(canonicalAutomation.state,arEvents,BigInt(execution.automation.state.cursor.number));
  const sourceAsset=ar.assets.find(row=>sameAddress(row.asset,relay.sourceAsset));if(!sourceAsset?.ready)throw new Error(`Native canary input asset is not verified: ${canonicalAutomation.state.assetErrors?.[relay.sourceAsset.toLowerCase()]??sourceAsset?.reason??"asset is outside canonical custody"}`);
  const sourceConsumption=ar.consumptions.find(row=>row.eventId===vaultEventId(relay.sourceTransactionHash,relay.sourceTransferLogIndex));
  if(!ar.ready||!sourceConsumption||sourceConsumption.amount!==relay.sourceAmount||sourceConsumption.fragments.some(row=>row.batchId===null))throw new Error("Native canary consumes unverified/unknown funds");
  const batchId=execution.batchId??relay.requestId;if(batchId!==relay.requestId&&batchId!==`native-source:${relay.sourceTransactionHash}`)throw new Error("Native acceptance batch identity mismatch");
  const expectedFragments=nativeRelayFragments(sourceConsumption.fragments,relay,batchId);
  const treasuryInId=vaultEventId(relay.destinationTransactionHash,relay.destinationTransferLogIndex);
  const trEvents=canonicalTreasury.events.map(event=>({...event}));
  for(const event of trEvents)if(event.kind==="in") {
    if(event.id===treasuryInId){if(event.blockHash!==relay.destinationBlockHash||event.amount!==relay.outputAmount||event.evidence?.kind!=="native_relay"||canonicalProofJson(event.evidence.relay)!==canonicalProofJson(relay)||event.evidence.sourceEventId!==sourceConsumption.eventId||canonicalProofJson(event.fragments)!==canonicalProofJson(expectedFragments))throw new Error("Canary Treasury fragments do not match verified source FIFO");}
    else if(event.fragments||event.evidence)throw new Error("Other Treasury funding is unknown in this canary acceptance");
  }
  if(!trEvents.some(event=>event.id===treasuryInId))throw new Error("Canary destination receipt not indexed");
  const tr=replayCustodyLedger(canonicalTreasury.state,trEvents,BigInt(execution.treasury.state.cursor.number));if(!tr.ready)throw new Error("Canary Treasury does not reconcile");
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
  for(const tx of sourceHashes){const payer=await keeperPays(source,tx,8453);if(payer.owned)baseGas+=BigInt((await readCanonicalBaseTransactionFee(source,payer.receipt)).totalWei);}
  for(const tx of rhHashes){const payer=await keeperPays(destination,tx,4663);if(payer.owned)rhGas+=payer.receipt.gasUsed*payer.receipt.effectiveGasPrice;}
  if(baseGas>integer(manifest.canaryAuthorization.maxBaseGasWei)||rhGas>integer(manifest.canaryAuthorization.maxRobinhoodGasWei))throw new Error("Canary actual gas budget exceeded");
  return {sourceHash:relay.sourceTransactionHash,destinationHash:relay.destinationTransactionHash,receivedWeth:relay.outputAmount,museToDead:batch.attributedMuseToDead,
    sourceSpentAmount:relay.sourceAmount,sourceAsset:relay.sourceAsset,baseGasWei:String(baseGas),robinhoodGasWei:String(rhGas)};
}
