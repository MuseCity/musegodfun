import { keccak256, stringToHex, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, BASE_NATIVE_DESTINATION_POLICY, type BaseFeeBatch } from "../src/lib/base-buyback";
import type { CustodyEvent } from "../src/lib/buyback-custody-ledger";
import type { StoreBackend } from "./supabase-store";
import { redact } from "./config";
import { RELAY_ROUTER, relayRequestMetadata } from "./buyback";
import { RELAY_APPROVAL_PROXY } from "../src/lib/buyback";
import type { BaseAuditStore } from "./base-audit";
import { verifyBaseNativeRelayProof } from "./base-native-provenance";
import { canonicalBaseReceipt } from "./base-buyback";
import { nativeDestinationHasFixedProvider, nativeDestinationTagMatches, verifyBaseNativeDestinationReceipt, verifyBaseNativeSourceTrace } from "./base-native-trace";
type Client=PublicClient<Transport,any>;
export type NativeObserverInput={source:Client;destination:Client;store:Pick<StoreBackend,"saveBuybackBatch">;collector:Address;automation:Address;
 sourceEvents:CustodyEvent[];treasuryEvents:CustodyEvent[];batches:BaseFeeBatch[];deadline:number;now?:()=>number;auditStore?:BaseAuditStore};
export type NativeObserverDependencies={sourceFrame?:typeof verifyBaseNativeSourceTrace;destinationFrame?:typeof verifyBaseNativeDestinationReceipt;
 receipt?:typeof canonicalBaseReceipt;tagMatches?:typeof nativeDestinationTagMatches;provider?:typeof nativeDestinationHasFixedProvider;verifyV1?:typeof verifyBaseNativeRelayProof};
class NativeObservationPersistenceError extends Error {}
/** Capture is scheduling only. The verifier persists independently canonical
 * historical code facts; these queue entries never grant financial credit. */
export async function captureNativeRelayDestinations(input:Pick<NativeObserverInput,"destination"|"collector"|"treasuryEvents"|"batches"|"deadline"|"auditStore"|"now">,deps:NativeObserverDependencies={},now=input.now??Date.now){
 const store=input.auditStore;if(!store)return;
 const binding=keccak256(stringToHex(JSON.stringify([input.collector.toLowerCase(),BASE_NATIVE_DESTINATION_POLICY,8453,4663]))),id=`internal_native_destination_capture:${binding}`;
 let old:any;try{old=await store.getBuybackBatch(id);}catch{return;}
 let head:bigint;try{head=await input.destination.getBlockNumber();}catch{return;}
 const all=input.treasuryEvents.filter(event=>event.kind==="in"&&BigInt(event.amount)>0n&&!sameAddress(event.from,event.to)&&sameAddress(event.from,RELAY_ROUTER)&&sameAddress(event.asset,BASE_BUYBACK_RH_WETH)&&BigInt(event.blockNumber)+6000n>=head);
 const known=new Set(input.batches.flatMap(batch=>batch.relay?[batch.relay.metadata.toLowerCase()]:batch.requestId?[relayRequestMetadata(batch.requestId)]:[]));
 const ordered=[...new Map(all.map(event=>[event.transactionHash,event])).values()].sort((a,b)=>
  Number(known.has(b.nativeRequestMetadata?.toLowerCase()??""))-Number(known.has(a.nativeRequestMetadata?.toLowerCase()??""))||
  Number(sameAddress(b.nativeTransactionTo??"",RELAY_APPROVAL_PROXY))-Number(sameAddress(a.nativeTransactionTo??"",RELAY_APPROVAL_PROXY))||Number(BigInt(b.blockNumber)-BigInt(a.blockNumber))||b.transactionIndex-a.transactionIndex);
 type Entry={hash:Hex;blockHash:Hex;blockNumber:string;complete:boolean;retryAfter:number};
 const entries:Entry[]=old?.id===id&&old.protocol==="internal_native_destination_capture_v1"&&old.binding===binding&&Array.isArray(old.entries)?old.entries.filter((row:any)=>
  typeof row.hash==="string"&&typeof row.blockHash==="string"&&typeof row.blockNumber==="string"&&typeof row.complete==="boolean"&&Number.isSafeInteger(row.retryAfter)&&
  ordered.some(event=>event.transactionHash===row.hash&&event.blockHash===row.blockHash)):[];
 const entry=(event:CustodyEvent)=>entries.find(row=>row.hash===event.transactionHash&&row.blockHash===event.blockHash);
 const rotate=(events:CustodyEvent[],after:unknown)=>{const index=events.findIndex(event=>event.transactionHash===after);return index<0?events:[...events.slice(index+1),...events.slice(0,index+1)];};
 // Rotate against the complete ledger order: the previous point itself is
 // already captured, so filtering it out before rotation would restart at the
 // newest dust on every turn and starve older unseen transactions.
 const fresh=rotate(ordered,old?.newAfter).filter(event=>!entry(event)),retry=rotate(ordered,old?.retryAfterHash).filter(event=>entry(event)&&!entry(event)!.complete&&entry(event)!.retryAfter<=now());
 const urgent=fresh.filter(event=>known.has(event.nativeRequestMetadata?.toLowerCase()??"")).slice(0,2),fairFresh=fresh.filter(event=>!urgent.includes(event));
 const selected=[...urgent,...fairFresh.slice(0,4-urgent.length),...retry.slice(0,4),...fairFresh.slice(4-urgent.length),...retry.slice(4)].slice(0,8);
 let newAfter=old?.newAfter,retryAfterHash=old?.retryAfterHash;
 for(const event of selected){if(now()>=input.deadline)break;let complete=false;
  try{await(deps.provider??nativeDestinationHasFixedProvider)(input.destination,event.transactionHash,event.nativeRequestMetadata,{auditStore:store});complete=true;}catch{/* Preserve only a bounded retry marker; unsupported proof is never credit. */}
  const previous=entry(event);if(previous)entries.splice(entries.indexOf(previous),1);
  entries.push({hash:event.transactionHash,blockHash:event.blockHash,blockNumber:event.blockNumber,complete,retryAfter:complete?0:now()+120_000});
  if(fresh.includes(event))newAfter=event.transactionHash;else retryAfterHash=event.transactionHash;
 }
 if(!selected.length)return;
 // Discarding a scheduling marker is safe: its ledger event remains and will
 // re-enter the fair scan. Verified code facts themselves are never pruned here.
 const next={id,protocol:"internal_native_destination_capture_v1",version:1,binding,updatedAt:now(),newAfter,retryAfterHash,entries:entries.slice(-512)};
 try{await store.compareAndSetBuybackAudit(next,old??null);}catch{/* The next canonical ledger turn retries capture. */}
}
/** A Base authority records observations only. Provider API status and new quotations play no part. */
export async function observeNativeRelayBatches(input:NativeObserverInput,deps:NativeObserverDependencies={}) {
 const now=input.now??Date.now;
 await captureNativeRelayDestinations(input,deps,now); // Before source replay or its 30-minute retry clock.
 const persist=async(batch:any)=>{if(now()>=input.deadline)throw new Error("Native discovery budget reached; pending");try{await input.store.saveBuybackBatch(batch);}catch{
   // Infrastructure exception text may contain provider URLs or credentials.
   // Emit only the public transaction identity and a stable diagnostic code.
   console.warn("native_observation_persistence_unavailable",/^0x[\da-f]{64}$/i.test(batch.sourceHash??"")?batch.sourceHash:"source_identity_unavailable");
   throw new NativeObservationPersistenceError("Native observation persistence is temporarily unavailable; retry this source");}};
 const sourceHashes=[...new Set(input.sourceEvents.filter(event=>event.kind==="out"&&BigInt(event.amount)>0n&&!sameAddress(event.from,event.to)&&sameAddress(event.to,RELAY_ROUTER)).map(event=>event.transactionHash))];
 const groups=new Map<string,BaseFeeBatch[]>(),existing=new Map<string,BaseFeeBatch>();
 for(const batch of input.batches)if(batch.kind==="native_relay"&&batch.sourceHash){const key=batch.sourceHash.toLowerCase(),group=groups.get(key)??[];group.push(batch);groups.set(key,group);}
 const active=(batch:BaseFeeBatch)=>["received","awaiting_buyback","attributed"].includes(batch.status);
 for(const [key,group] of groups){
  const activeRows=group.filter(active),stableId=`native-source:${key}`;
  const selected=activeRows.length===1?activeRows[0]:group.find(batch=>batch.id.toLowerCase()===stableId)??activeRows.find(batch=>batch.proof?.version===1)??group[0];
  existing.set(key,selected);
 }
 const activeSources=new Set(sourceHashes.map(hash=>hash.toLowerCase()));
 // Completed proofs use the source adapter's durable replay cache. Discovery
 // failures back off exponentially across restarts; successful page progress
 // remains eligible after 30s instead of being delayed behind an old failure.
 const firstPosition=new Map<Hex,number>();input.treasuryEvents.forEach((event,index)=>{if(!firstPosition.has(event.transactionHash))firstPosition.set(event.transactionHash,index);});
 const arrivalCache=new Map<string,boolean>();
 const newArrival=(batch:BaseFeeBatch)=>{if(arrivalCache.has(batch.id))return arrivalCache.get(batch.id)!;const found=input.treasuryEvents.some(event=>event.kind==="in"&&sameAddress(event.from,RELAY_ROUTER)&&sameAddress(event.asset,BASE_BUYBACK_RH_WETH)&&BigInt(event.amount)>0n&&
  event.transactionHash!==batch.destinationScanAfter&&(!batch.relay?.metadata||!event.nativeRequestMetadata||event.nativeRequestMetadata.toLowerCase()===batch.relay.metadata.toLowerCase())&&
  (!batch.destinationFromBlock||BigInt(event.blockNumber)>=BigInt(batch.destinationFromBlock))&&(!batch.destinationScanAfter||firstPosition.get(event.transactionHash)!>(firstPosition.get(batch.destinationScanAfter)??-1)));arrivalCache.set(batch.id,found);return found;};
 const candidates=sourceHashes.filter(hash=>{const batch=existing.get(hash.toLowerCase());
  if(batch?.sourceFinalized&&active(batch)&&!batch.destinationPendingHashes?.length&&!batch.destinationOverflowFrom&&!newArrival(batch))return false;
  if(batch?.sourceBlockHash&&(active(batch)||!batch.proof)&&newArrival(batch))return true;
  if(batch&&Number.isSafeInteger(batch.nativeRetryAfter)&&batch.nativeRetryAfter!<=batch.updatedAt+1_800_000)return now()>=batch.nativeRetryAfter!;
  return!batch||now()-batch.updatedAt>=(batch.proof&&!["reorg","unknown","bridging"].includes(batch.status)?300_000:30_000);})
  .sort((left,right)=>(existing.get(left.toLowerCase())?.updatedAt??0)-(existing.get(right.toLowerCase())?.updatedAt??0));
 let attempts=0;const saved:BaseFeeBatch[]=[];
 for(const sourceHash of candidates) {
  if(now()>=input.deadline||attempts++>=2)break;
  const previous=existing.get(sourceHash.toLowerCase());let conflictWith:BaseFeeBatch|undefined,id=previous?.id??`native-source:${sourceHash}`,amountIn=previous?.amountIn??"0",requestId:Hex|undefined,orderId:Hex|undefined;
  let canonicalChanged=false,conflictingEvidence=false,latest=previous;
  const save=async(batch:BaseFeeBatch)=>{await persist(batch);latest=batch;existing.set(sourceHash.toLowerCase(),batch);const index=saved.findIndex(row=>row.id===batch.id);if(index<0)saved.push(batch);else saved[index]=batch;};
  const retry=(progress=false)=>{const oldAttempts=Number.isSafeInteger(previous?.nativeRetryAttempts)&&previous!.nativeRetryAttempts!>=0&&previous!.nativeRetryAttempts!<=16?previous!.nativeRetryAttempts!:0;
   const attempts=progress?1:Math.min(16,oldAttempts+1);
   return{nativeRetryAttempts:attempts,nativeRetryAfter:now()+Math.min(requestId?120_000:1_800_000,30_000*2**(attempts-1))};};
  const finalize=async(frame:{sourceBlockNumber:string;sourceBlockHash:Hex})=>{try{if(await input.source.getChainId()!==8453)return false;const stable=await input.source.getBlock({blockTag:"finalized"});if(stable.number===null||stable.number<BigInt(frame.sourceBlockNumber)||!stable.hash)return false;
    const [block,check]=await Promise.all([input.source.getBlock({blockNumber:BigInt(frame.sourceBlockNumber)}),input.source.getBlock({blockNumber:stable.number})]);
    return block.hash===frame.sourceBlockHash&&check.hash===stable.hash&&await input.source.getChainId()===8453;}catch{return false;}};
  // Retained aliases remain reviewable; automatic recovery follows one stable source record and never revives its archives.
  const initial:BaseFeeBatch={id,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,collector:input.collector,kind:"native_relay",status:"unknown",
   createdAt:previous?.createdAt??now(),updatedAt:now(),amountIn,receivedAmount:"0",refundedAmount:"0",burnedAmount:"0",claimHashes:[],sourceHash};
  try {
   for(const alias of groups.get(sourceHash.toLowerCase())??[])if(alias.id!==id&&active(alias))await persist({...alias,status:"unknown",updatedAt:now(),error:`Retained source alias; canonical recovery follows ${id}`} as any);
   let frame:Awaited<ReturnType<typeof verifyBaseNativeSourceTrace>>;
   if(previous?.sourceFinalized&&previous.relay&&previous.proof&&active(previous)){
    const block=await input.source.getBlock({blockNumber:BigInt(previous.relay.sourceBlockNumber)});
    if(block.hash===previous.relay.sourceBlockHash){if(typeof block.timestamp!=="bigint")throw new Error("Canonical finalized source timestamp is unavailable; pending");frame={...previous.relay,sourceTimestamp:String(block.timestamp)};}
    else{canonicalChanged=true;frame=await(deps.sourceFrame??verifyBaseNativeSourceTrace)(input.source,sourceHash,input.automation);}
   }else frame=await(deps.sourceFrame??verifyBaseNativeSourceTrace)(input.source,sourceHash,input.automation);
   amountIn=frame.sourceAmount;requestId=frame.requestId;orderId=frame.orderId;
   canonicalChanged=!!previous?.relay&&previous.relay.sourceBlockHash.toLowerCase()!==frame.sourceBlockHash.toLowerCase();
   const conflict=[...existing.values()].find(batch=>batch.sourceHash&&activeSources.has(batch.sourceHash.toLowerCase())&&batch.sourceHash.toLowerCase()!==sourceHash.toLowerCase()&&(
     (batch.requestId??batch.relay?.requestId??batch.nativeConflict?.requestId)?.toLowerCase()===frame.requestId.toLowerCase()||
     (batch.orderId??batch.relay?.orderId??batch.nativeConflict?.orderId)?.toLowerCase()===frame.orderId.toLowerCase()));
   if(conflict){conflictWith=conflict;conflictingEvidence=true;throw new Error("Native request or order identifier is already linked to another canonical source");}
   if(previous?.relay&&previous.relay.requestId.toLowerCase()!==frame.requestId.toLowerCase()){conflictingEvidence=true;throw new Error("An existing native proof cannot change its request identifier");}
   // Timestamp lower bound avoids re-reading every historic Treasury receipt for each new source order.
   const previousSourceBlockHash=previous?.sourceBlockHash??previous?.relay?.sourceBlockHash;
   const previousDestination=previous?.destinationMatchHash??previous?.relay?.destinationTransactionHash??previous?.proof?.destinationHash;
   let destinationFromBlock=previousSourceBlockHash===frame.sourceBlockHash?previous?.destinationFromBlock:undefined,destinationFromBlockHash=previous?.destinationFromBlockHash;
   const oldMatchMissing=!!previousDestination&&!input.treasuryEvents.some(event=>event.transactionHash.toLowerCase()===previousDestination.toLowerCase());
   if(destinationFromBlock!==undefined){const anchor=await input.destination.getBlock({blockNumber:BigInt(destinationFromBlock)});if(oldMatchMissing||!destinationFromBlockHash||anchor.hash!==destinationFromBlockHash){destinationFromBlock=undefined;destinationFromBlockHash=undefined;}}
   if(destinationFromBlock===undefined){
    let lower=0n,upper=await input.destination.getBlockNumber();
    while(lower<upper){if(now()>=input.deadline)throw new Error("Native discovery budget reached; pending");const middle=(lower+upper)/2n,block=await input.destination.getBlock({blockNumber:middle});if(block.timestamp<BigInt(frame.sourceTimestamp))lower=middle+1n;else upper=middle;}
    destinationFromBlock=String(lower);destinationFromBlockHash=(await input.destination.getBlock({blockNumber:lower})).hash??undefined;
   }
   const destinationHashes=[...new Set(input.treasuryEvents.filter(event=>event.kind==="in"&&BigInt(event.amount)>0n&&!sameAddress(event.from,event.to)&&sameAddress(event.from,RELAY_ROUTER)&&sameAddress(event.asset,BASE_BUYBACK_RH_WETH)&&BigInt(event.blockNumber)>=BigInt(destinationFromBlock!)&&
     (!event.nativeRequestMetadata||event.nativeRequestMetadata.toLowerCase()===frame.metadata.toLowerCase())).map(event=>event.transactionHash))];
   const destinationPosition=new Map(destinationHashes.map((hash,index)=>[hash.toLowerCase(),index]));
   const position=(hash:Hex|undefined)=>hash?destinationPosition.get(hash.toLowerCase())??-1:-1;
   const seededMatch=previousSourceBlockHash===frame.sourceBlockHash&&previousDestination&&destinationHashes.some(hash=>hash.toLowerCase()===previousDestination.toLowerCase())?previousDestination:undefined;
   let validSeed:Hex|undefined;
   if(seededMatch){try{const receipt=await(deps.receipt??canonicalBaseReceipt)(input.destination,seededMatch,4663);
    if(previous?.relay&&receipt.blockHash&&receipt.blockHash.toLowerCase()!==previous.relay.destinationBlockHash.toLowerCase())canonicalChanged=true;
    if((deps.tagMatches??nativeDestinationTagMatches)(receipt,frame.metadata)&&await(deps.provider??nativeDestinationHasFixedProvider)(input.destination,seededMatch,frame.metadata,{auditStore:input.auditStore}))validSeed=seededMatch;
   }catch{/* Retained financial evidence is revalidated independently; an unavailable seed cannot stop later candidates. */}}
   // A conclusively foreign *new* candidate can be skipped. An already proved
   // receipt keeps its identity when today's canonical evidence is unavailable: every
   // attributed read separately revalidates it before consuming that lot.
   const retainedSeed=seededMatch&&previous?.proof&&previous.relay&&previous.proof.destinationHash.toLowerCase()===seededMatch.toLowerCase()&&
     previous.relay.destinationTransactionHash.toLowerCase()===seededMatch.toLowerCase()&&!canonicalChanged?seededMatch:undefined;
   // Accepted funds and the scan for later conflicts are separate facts. Revalidate
   // supported accepted receipts before preserving them through a discovery page.
   let retained:BaseFeeBatch["relay"];
   if(previous?.proof&&active(previous)&&validSeed&&!canonicalChanged){
    retained=previous.proof.version===1?await(deps.verifyV1??verifyBaseNativeRelayProof)(input.source,input.destination,previous.proof,input.automation,{auditStore:input.auditStore}):await(deps.destinationFrame??verifyBaseNativeDestinationReceipt)(input.destination,validSeed,frame,{auditStore:input.auditStore});
    canonicalChanged=retained.sourceBlockHash.toLowerCase()!==previous.relay?.sourceBlockHash.toLowerCase()||retained.destinationBlockHash.toLowerCase()!==previous.relay?.destinationBlockHash.toLowerCase();
   }
   const accepted=!!(retained??retainedSeed)&&!canonicalChanged&&!!previous&&active(previous);
   const matches:Hex[]=validSeed?[validSeed]:retainedSeed?[retainedSeed]:[];
   // One source observation checks at most twenty newly relevant destination receipts; later rounds resume via persistent last checked IDs.
   let cursor=(!seededMatch||!!validSeed||!!retainedSeed)&&previousSourceBlockHash===frame.sourceBlockHash&&!oldMatchMissing&&previous?.destinationFromBlockHash===destinationFromBlockHash?previous?.destinationScanAfter:undefined;
   let overflowFrom=previousSourceBlockHash===frame.sourceBlockHash?previous?.destinationOverflowFrom:undefined,overflowAfter=previousSourceBlockHash===frame.sourceBlockHash?previous?.destinationOverflowAfter:undefined,overflowThrough=previousSourceBlockHash===frame.sourceBlockHash?previous?.destinationOverflowThrough:undefined,overflowPending=previousSourceBlockHash===frame.sourceBlockHash?previous?.destinationOverflowPending:undefined;
   if(overflowFrom&&!destinationHashes.includes(overflowFrom)){overflowFrom=undefined;overflowAfter=undefined;overflowThrough=undefined;overflowPending=undefined;cursor=undefined;}
   const offset=cursor?position(cursor)+1:0;
   if(overflowThrough&&(!overflowFrom||!destinationHashes.includes(overflowThrough)||position(overflowThrough)<position(overflowFrom)||position(overflowThrough)>=offset)){overflowThrough=undefined;overflowAfter=undefined;overflowPending=undefined;}
   if(overflowFrom&&!overflowThrough&&cursor)overflowThrough=cursor;
   if(overflowAfter&&(!overflowFrom||!destinationHashes.includes(overflowAfter)||position(overflowAfter)<position(overflowFrom)||!overflowThrough||position(overflowAfter)>position(overflowThrough))){overflowAfter=undefined;overflowPending=undefined;}
   const pending=previousSourceBlockHash===frame.sourceBlockHash?[...new Set(previous?.destinationPendingHashes??[])].filter(hash=>destinationHashes.includes(hash)):[];
   // The capped retry list cannot veto new financial evidence. Overflow stays a
   // scalar range in the complete journal, with two of the four old-work slots.
   const freshPage=destinationHashes.slice(Math.max(0,offset),Math.max(0,offset)+(pending.length||overflowFrom?16:20));
   const overflowRange=overflowFrom&&overflowThrough?destinationHashes.slice(position(overflowFrom),position(overflowThrough)+1).filter(hash=>!pending.includes(hash)&&(!overflowAfter||position(hash)>position(overflowAfter))):[];
   const overflowPage=overflowRange.slice(0,pending.length?2:4),retryPage=pending.slice(0,4-overflowPage.length);
   const page=[...new Set([...freshPage,...retryPage,...overflowPage])].slice(0,20);
   let scanned:Hex|undefined;
   const progress=():BaseFeeBatch=>({...initial,...(previous?.proof?previous:{}),id,amountIn,requestId,orderId,
    status:accepted?previous!.status:canonicalChanged?"reorg":"bridging",sourceBlockNumber:frame.sourceBlockNumber,sourceBlockHash:frame.sourceBlockHash,
    destinationFromBlock,destinationFromBlockHash,destinationMatchHash:matches[0]??(previous?.proof?previousDestination:undefined),destinationScanAfter:scanned??cursor,
    ...(retained?{relay:retained}:{}),destinationPendingHashes:pending.length?pending:undefined,destinationOverflowFrom:overflowFrom,destinationOverflowAfter:overflowAfter,destinationOverflowThrough:overflowThrough,destinationOverflowPending:overflowPending,...retry(!!scanned&&scanned!==cursor),updatedAt:now(),error:accepted?validSeed?undefined:"Accepted native receipt retained; current provider evidence is unsupported; this lot awaits canonical revalidation":"Native destination discovery is pending; amounts and completion are not inferred"});
   for(const destinationHash of page) {if(now()>=input.deadline)break;
    let unresolved=false;
    try{const receipt=await(deps.receipt??canonicalBaseReceipt)(input.destination,destinationHash,4663);
     if((deps.tagMatches??nativeDestinationTagMatches)(receipt,frame.metadata)&&await(deps.provider??nativeDestinationHasFixedProvider)(input.destination,destinationHash,frame.metadata,{auditStore:input.auditStore})&&!matches.some(hash=>hash.toLowerCase()===destinationHash.toLowerCase()))matches.push(destinationHash);
     const index=pending.indexOf(destinationHash);if(index>=0)pending.splice(index,1);
    }catch{unresolved=true;const index=pending.indexOf(destinationHash);if(index>=0)pending.splice(index,1);
     if(pending.length<512)pending.push(destinationHash);
     else if(!overflowFrom||position(destinationHash)<position(overflowFrom)){overflowFrom=destinationHash;overflowAfter=undefined;overflowThrough=undefined;overflowPending=undefined;}}
    if(overflowPage.includes(destinationHash)){overflowAfter=destinationHash;overflowPending=!!overflowPending||unresolved;}
    // Separately retained pending identities can retry without blocking later
    // discovery. Only fresh chronological work advances this scan cursor.
    if(freshPage.includes(destinationHash))scanned=destinationHash;
    if(matches.length>1){conflictingEvidence=true;throw new Error("Native request tag has ambiguous destination receipts");}
    await save(progress());
   }
   if(overflowFrom&&overflowThrough&&(!overflowRange.length||overflowAfter===overflowRange.at(-1))){
    if(!overflowPending){const tail=destinationHashes.slice(position(overflowThrough)+1,Math.max(0,position(scanned??cursor!)+1)).find(hash=>!pending.includes(hash));overflowFrom=tail;}
    overflowAfter=undefined;overflowThrough=undefined;overflowPending=undefined;}
   if(matches.length>1){conflictingEvidence=true;throw new Error("Native request tag has ambiguous destination receipts");}
   // One complete source/payment proof stands independently of later receipts
   // awaiting authentication. Only another positively authenticated same-tag
   // payment revokes its unique identity; a pending hint cannot veto first credit.
   if(!matches.length||!!retainedSeed&&!validSeed) {
    await save(progress());continue;
   }
   const proof=retained??await(deps.destinationFrame??verifyBaseNativeDestinationReceipt)(input.destination,matches[0],frame,{auditStore:input.auditStore});
   const scheduling={destinationPendingHashes:pending.length?pending:undefined,destinationOverflowFrom:overflowFrom,destinationOverflowAfter:overflowAfter,destinationOverflowThrough:overflowThrough,destinationOverflowPending:overflowPending};
   const discoveryRetry=pending.length||overflowFrom||(scanned??cursor)!==destinationHashes.at(-1)?retry(!!scanned&&scanned!==cursor):{nativeRetryAttempts:undefined,nativeRetryAfter:undefined};
   const reuse=[...existing.values()].some(batch=>batch.sourceHash&&activeSources.has(batch.sourceHash.toLowerCase())&&["received","awaiting_buyback","attributed"].includes(batch.status)&&batch.sourceHash.toLowerCase()!==sourceHash.toLowerCase()&&batch.relay&&
     (batch.relay.requestId.toLowerCase()===proof.requestId.toLowerCase()||batch.relay.orderId.toLowerCase()===proof.orderId.toLowerCase()||
      batch.relay.destinationTransactionHash.toLowerCase()===proof.destinationTransactionHash.toLowerCase()&&batch.relay.destinationTransferLogIndex===proof.destinationTransferLogIndex));
   if(reuse){conflictingEvidence=true;throw new Error("Native destination/request/order evidence cannot fund two source batches");}
   if(previous?.proof?.version===1) {
    // Preserve the retained signed-order interpretation. Never replace it with weaker V2 recovery evidence.
    if(previous.destinationHash?.toLowerCase()!==proof.destinationTransactionHash.toLowerCase()){conflictingEvidence=true;throw new Error("Native original destination changed");}
    const v1=retained??await(deps.verifyV1??verifyBaseNativeRelayProof)(input.source,input.destination,previous.proof,input.automation,{auditStore:input.auditStore});
    const batch={...previous,status:accepted?previous.status:"received" as const,relay:v1,receivedAmount:v1.outputAmount,sourceBlockNumber:v1.sourceBlockNumber,sourceBlockHash:v1.sourceBlockHash,
     destinationHash:v1.destinationTransactionHash,destinationMatchHash:v1.destinationTransactionHash,destinationFromBlock,destinationFromBlockHash,destinationScanAfter:scanned??cursor,...scheduling,error:undefined,...discoveryRetry,sourceFinalized:await finalize(v1),updatedAt:now()};await save(batch);continue;
   }
   const batch:BaseFeeBatch={...initial,...(accepted?previous:{}),id,amountIn,requestId,orderId,status:accepted?previous!.status:"received",updatedAt:now(),error:undefined,...discoveryRetry,sourceBlockNumber:proof.sourceBlockNumber,sourceBlockHash:proof.sourceBlockHash,
    destinationFromBlock,destinationFromBlockHash,destinationScanAfter:scanned??cursor,...scheduling,destinationMatchHash:proof.destinationTransactionHash,receivedAmount:proof.outputAmount,destinationHash:proof.destinationTransactionHash,sourceFinalized:await finalize(proof),proof:{version:2,protocol:BASE_BUYBACK_PROTOCOL,sourceHash,destinationHash:proof.destinationTransactionHash},relay:proof};
   // If a reorg changes the receipt's canonical block, keep the original hashes and derive fresh evidence instead of repeating spending.
   await save(batch);
  } catch(error) {
   if(now()>=input.deadline)break;
   if(error instanceof NativeObservationPersistenceError)continue;
   const message=error instanceof Error?redact(error):"Native canonical observation unavailable";
   // Infrastructure/unsupported-proof errors are not evidence of a reorg. Only
   // an observed mismatch against retained block hashes can revoke that fact.
   if(previous?.relay&&!canonicalChanged&&!conflictingEvidence){for(const [client,number,expected] of [[input.source,previous.relay.sourceBlockNumber,previous.relay.sourceBlockHash],[input.destination,previous.relay.destinationBlockNumber,previous.relay.destinationBlockHash]] as const){
     if(now()>=input.deadline)break;try{const block=await client.getBlock({blockNumber:BigInt(number)});if(block.hash&&block.hash.toLowerCase()!==expected.toLowerCase())canonicalChanged=true;}catch{/* An unavailable/lagging peer retains the accepted receipt; it does not prove another hash. */}
    }}
   if(conflictWith){
    const changed={...conflictWith,status:"unknown" as const,updatedAt:now(),nativeConflict:{sourceHash,requestId:requestId!,orderId:orderId!},error:message};
    try{await persist(changed as any);existing.set(conflictWith.sourceHash!.toLowerCase(),changed);}catch(failure){if(failure instanceof NativeObservationPersistenceError)continue;throw failure;}
   }
   const retainAccepted=!!previous&&active(previous)&&!!previous.proof&&!canonicalChanged&&!conflictingEvidence;
   const batch={...previous,...initial,...latest,id:previous?.id??id,amountIn,requestId:conflictWith?undefined:requestId??previous?.requestId,orderId:conflictWith?undefined:orderId??previous?.orderId,
     status:conflictingEvidence?"unknown" as const:canonicalChanged?"reorg" as const:retainAccepted?previous!.status:previous?.status==="reorg"?"reorg" as const:"unknown" as const,updatedAt:now(),...retry(),
     ...(previous?.proof?{proof:previous.proof,relay:previous.relay,destinationHash:previous.destinationHash,receivedAmount:previous.receivedAmount}:{}),
     ...(conflictWith?{nativeConflict:{sourceHash:conflictWith.sourceHash!,requestId:requestId!,orderId:orderId!}}:{}),error:message};
   try{await save(batch);}catch(failure){if(failure instanceof NativeObservationPersistenceError)continue;throw failure;}
  }
 }
 return saved;
}
