import type { Address, Hex, PublicClient, Transport } from "viem";
import { sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, type BaseFeeBatch } from "../src/lib/base-buyback";
import type { CustodyEvent } from "../src/lib/buyback-custody-ledger";
import type { StoreBackend } from "./supabase-store";
import { redact } from "./config";
import { canonicalBaseReceipt } from "./base-buyback";
import { nativeDestinationTagMatches, verifyBaseNativeDestinationTrace, verifyBaseNativeSourceTrace } from "./base-native-trace";
type Client=PublicClient<Transport,any>;
export type NativeObserverInput={source:Client;destination:Client;store:Pick<StoreBackend,"saveBuybackBatch">;collector:Address;automation:Address;
 sourceEvents:CustodyEvent[];treasuryEvents:CustodyEvent[];batches:BaseFeeBatch[];deadline:number;now?:()=>number};
export type NativeObserverDependencies={sourceFrame?:typeof verifyBaseNativeSourceTrace;destinationFrame?:typeof verifyBaseNativeDestinationTrace;
 receipt?:typeof canonicalBaseReceipt;tagMatches?:typeof nativeDestinationTagMatches};
/** A Base authority records observations only. Provider API status and new quotations play no part. */
export async function observeNativeRelayBatches(input:NativeObserverInput,deps:NativeObserverDependencies={}) {
 const now=input.now??Date.now,sourceHashes=[...new Set(input.sourceEvents.filter(event=>event.kind==="out").map(event=>event.transactionHash))];
 const groups=new Map<string,BaseFeeBatch[]>(),existing=new Map<string,BaseFeeBatch>();
 for(const batch of input.batches)if(batch.kind==="native_relay"&&batch.sourceHash){const key=batch.sourceHash.toLowerCase(),group=groups.get(key)??[];group.push(batch);groups.set(key,group);}
 const active=(batch:BaseFeeBatch)=>["received","awaiting_buyback","attributed"].includes(batch.status);
 for(const [key,group] of groups){
  const activeRows=group.filter(active),stableId=`native-source:${key}`;
  const selected=activeRows.length===1?activeRows[0]:group.find(batch=>batch.id.toLowerCase()===stableId)??activeRows.find(batch=>batch.proof?.version===1)??group[0];
  existing.set(key,selected);
 }
 const activeSources=new Set(sourceHashes.map(hash=>hash.toLowerCase()));
 // Restart-safe backoff and FIFO progress: unresolved tasks are retried after 30s; completed proofs rotate every five minutes to detect reorgs.
 const candidates=sourceHashes.filter(hash=>{const batch=existing.get(hash.toLowerCase());return!batch||now()-batch.updatedAt>=(batch.proof&&!["reorg","unknown","bridging"].includes(batch.status)?300_000:30_000);})
  .sort((left,right)=>(existing.get(left.toLowerCase())?.updatedAt??0)-(existing.get(right.toLowerCase())?.updatedAt??0));
 let attempts=0;const saved:BaseFeeBatch[]=[];
 for(const sourceHash of candidates) {
  if(now()>=input.deadline||attempts++>=2)break;
  const previous=existing.get(sourceHash.toLowerCase());let conflictWith:BaseFeeBatch|undefined,id=previous?.id??`native-source:${sourceHash}`,amountIn=previous?.amountIn??"0",requestId:Hex|undefined,orderId:Hex|undefined;
  // Retained aliases remain reviewable; automatic recovery follows one stable source record and never revives its archives.
  for(const alias of groups.get(sourceHash.toLowerCase())??[])if(alias.id!==id&&active(alias))await input.store.saveBuybackBatch({...alias,status:"unknown",updatedAt:now(),error:`Retained source alias; canonical recovery follows ${id}`} as any);
  const initial:BaseFeeBatch={id,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,collector:input.collector,kind:"native_relay",status:"unknown",
   createdAt:previous?.createdAt??now(),updatedAt:now(),amountIn,receivedAmount:"0",refundedAmount:"0",burnedAmount:"0",claimHashes:[],sourceHash};
  try {
   const frame=await(deps.sourceFrame??verifyBaseNativeSourceTrace)(input.source,sourceHash,input.automation);amountIn=frame.sourceAmount;requestId=frame.requestId;orderId=frame.orderId;
   const conflict=[...existing.values()].find(batch=>batch.sourceHash&&activeSources.has(batch.sourceHash.toLowerCase())&&batch.sourceHash.toLowerCase()!==sourceHash.toLowerCase()&&(
     (batch.requestId??batch.relay?.requestId??batch.nativeConflict?.requestId)?.toLowerCase()===frame.requestId.toLowerCase()||
     (batch.orderId??batch.relay?.orderId??batch.nativeConflict?.orderId)?.toLowerCase()===frame.orderId.toLowerCase()));
   if(conflict){conflictWith=conflict;throw new Error("Native request or order identifier is already linked to another canonical source");}
   if(previous?.relay&&previous.relay.requestId.toLowerCase()!==frame.requestId.toLowerCase())throw new Error("An existing native proof cannot change its request identifier");
   // Timestamp lower bound avoids re-reading every historic Treasury receipt for each new source order.
   let destinationFromBlock=previous?.sourceBlockHash===frame.sourceBlockHash?previous?.destinationFromBlock:undefined,destinationFromBlockHash=previous?.destinationFromBlockHash;
   const oldMatchMissing=!!previous?.destinationMatchHash&&!input.treasuryEvents.some(event=>event.transactionHash.toLowerCase()===previous.destinationMatchHash!.toLowerCase());
   if(destinationFromBlock!==undefined){const anchor=await input.destination.getBlock({blockNumber:BigInt(destinationFromBlock)});if(oldMatchMissing||!destinationFromBlockHash||anchor.hash!==destinationFromBlockHash){destinationFromBlock=undefined;destinationFromBlockHash=undefined;}}
   if(destinationFromBlock===undefined){
    let lower=0n,upper=await input.destination.getBlockNumber();
    while(lower<upper){if(now()>=input.deadline)throw new Error("Native discovery budget reached; pending");const middle=(lower+upper)/2n,block=await input.destination.getBlock({blockNumber:middle});if(block.timestamp<BigInt(frame.sourceTimestamp))lower=middle+1n;else upper=middle;}
    destinationFromBlock=String(lower);destinationFromBlockHash=(await input.destination.getBlock({blockNumber:lower})).hash??undefined;
   }
   const destinationHashes=[...new Set(input.treasuryEvents.filter(event=>event.kind==="in"&&sameAddress(event.asset,BASE_BUYBACK_RH_WETH)&&BigInt(event.blockNumber)>=BigInt(destinationFromBlock!)).map(event=>event.transactionHash))];
   const seededMatch=previous?.sourceBlockHash===frame.sourceBlockHash&&previous.destinationMatchHash&&destinationHashes.some(hash=>hash.toLowerCase()===previous.destinationMatchHash!.toLowerCase())?previous.destinationMatchHash:undefined;
   const matches:Hex[]=seededMatch?[seededMatch]:[];
   // One source observation checks at most twenty newly relevant destination receipts; later rounds resume via persistent last checked IDs.
   const cursor=previous?.sourceBlockHash===frame.sourceBlockHash&&!oldMatchMissing&&previous?.destinationFromBlockHash===destinationFromBlockHash?previous?.destinationScanAfter:undefined;const offset=cursor?destinationHashes.findIndex(hash=>hash.toLowerCase()===cursor.toLowerCase())+1:0;
   const page=destinationHashes.slice(Math.max(0,offset),Math.max(0,offset)+20);
   let scanned:Hex|undefined;
   for(const destinationHash of page) {if(now()>=input.deadline)break;const receipt=await(deps.receipt??canonicalBaseReceipt)(input.destination,destinationHash,4663);scanned=destinationHash;
    if((deps.tagMatches??nativeDestinationTagMatches)(receipt,frame.metadata)&&!matches.some(hash=>hash.toLowerCase()===destinationHash.toLowerCase()))matches.push(destinationHash);}
   if(matches.length>1)throw new Error("Native request tag has ambiguous destination receipts");
   const allScanned=!destinationHashes.length||!!scanned&&scanned===destinationHashes.at(-1)||!page.length;
   if(!matches.length||!allScanned) {
    const batch={...initial,id,amountIn,requestId,orderId,status:"bridging" as const,sourceBlockNumber:frame.sourceBlockNumber,sourceBlockHash:frame.sourceBlockHash,
      ...(previous?.proof?{proof:previous.proof,relay:previous.relay,destinationHash:previous.destinationHash,receivedAmount:previous.receivedAmount}:{}),
      destinationFromBlock,destinationFromBlockHash,destinationMatchHash:matches[0],destinationScanAfter:scanned??cursor,error:"Native destination discovery is pending; amounts and completion are not inferred"};
    await input.store.saveBuybackBatch(batch as any);existing.set(sourceHash.toLowerCase(),batch);saved.push(batch);continue;
   }
   const proof=await(deps.destinationFrame??verifyBaseNativeDestinationTrace)(input.destination,matches[0],frame);
   const reuse=[...existing.values()].some(batch=>batch.sourceHash&&activeSources.has(batch.sourceHash.toLowerCase())&&["received","awaiting_buyback","attributed"].includes(batch.status)&&batch.sourceHash.toLowerCase()!==sourceHash.toLowerCase()&&batch.relay&&
     (batch.relay.requestId.toLowerCase()===proof.requestId.toLowerCase()||batch.relay.orderId.toLowerCase()===proof.orderId.toLowerCase()||
      batch.relay.destinationTransactionHash.toLowerCase()===proof.destinationTransactionHash.toLowerCase()&&batch.relay.destinationTransferLogIndex===proof.destinationTransferLogIndex));
   if(reuse)throw new Error("Native destination/request/order evidence cannot fund two source batches");
   if(previous?.proof?.version===1) {
    // Preserve the retained signed-order interpretation. Never replace it with weaker V2 recovery evidence.
    if(previous.destinationHash?.toLowerCase()!==proof.destinationTransactionHash.toLowerCase())throw new Error("Native original destination changed");
    const batch={...previous,updatedAt:now()};await input.store.saveBuybackBatch(batch as any);existing.set(sourceHash.toLowerCase(),batch);saved.push(batch);continue;
   }
   const batch:BaseFeeBatch={...initial,id,amountIn,requestId,orderId,status:"received",sourceBlockNumber:proof.sourceBlockNumber,sourceBlockHash:proof.sourceBlockHash,
    destinationFromBlock,destinationFromBlockHash,destinationScanAfter:scanned??cursor,destinationMatchHash:proof.destinationTransactionHash,receivedAmount:proof.outputAmount,destinationHash:proof.destinationTransactionHash,proof:{version:2,protocol:BASE_BUYBACK_PROTOCOL,sourceHash,destinationHash:proof.destinationTransactionHash},relay:proof};
   // If a reorg changes the receipt's canonical block, keep the original hashes and derive fresh evidence instead of repeating spending.
   await input.store.saveBuybackBatch(batch as any);existing.set(sourceHash.toLowerCase(),batch);saved.push(batch);
  } catch(error) {
   const message=error instanceof Error?redact(error):"Native canonical observation unavailable";
   if(conflictWith){
    const changed={...conflictWith,status:"unknown" as const,updatedAt:now(),nativeConflict:{sourceHash,requestId:requestId!,orderId:orderId!},error:message};
    await input.store.saveBuybackBatch(changed as any);existing.set(conflictWith.sourceHash!.toLowerCase(),changed);
   }
   const batch={...previous,...initial,id:previous?.id??id,amountIn,requestId:conflictWith?undefined:requestId,orderId:conflictWith?undefined:orderId,status:previous?.proof?"reorg" as const:"unknown" as const,
     ...(previous?.proof?{proof:previous.proof,relay:previous.relay,destinationHash:previous.destinationHash,receivedAmount:previous.receivedAmount}:{}),
     ...(conflictWith?{nativeConflict:{sourceHash:conflictWith.sourceHash!,requestId:requestId!,orderId:orderId!}}:{}),error:message};
   await input.store.saveBuybackBatch(batch as any);existing.set(sourceHash.toLowerCase(),batch);saved.push(batch);
  }
 }
 return saved;
}
