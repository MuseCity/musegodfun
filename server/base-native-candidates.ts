import { keccak256, stringToHex, type Hex, type PublicClient, type Transport } from "viem";
import { sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_RH_WETH, BASE_NATIVE_DESTINATION_POLICY, type BaseFeeBatch, type BaseNativeRelayEvidence } from "../src/lib/base-buyback";
import type { CustodyEvent, CustodyState } from "../src/lib/buyback-custody-ledger";
import { compareVaultEvents, vaultEventId } from "../src/lib/buyback-vault-ledger";
import type { StoreBackend } from "./supabase-store";
import { BUYBACK_CODE_HASHES, RELAY_ROUTER } from "./buyback";
import { BASE_NATIVE_RELAY_SOLVER, nativeDestinationHasFixedProvider, nativeDestinationTagMatches } from "./base-native-trace";
import { canonicalBaseReceipt } from "./base-buyback";
import { canonicalProofJson } from "./base-native-provenance";

type Client=PublicClient<Transport,any>;
type AuditStore=Pick<StoreBackend,"getBuybackBatch"|"compareAndSetBuybackAudit">;
type Point={eventId:string;blockNumber:string;blockHash:Hex;transactionIndex:number;logIndex:number};
type PendingPoint=Point&{retryAfter:number};
type Audit={id:string;protocol:"internal_native_destination_audit_v1";version:1;binding:string;updatedAt:number;
 proof:BaseNativeRelayEvidence;proofHash:Hex;checkpointHash:Hex;after?:Point;scanAfter?:Point;priorityAfter?:Point;conflict?:Point;pending?:PendingPoint;pendingCandidates?:PendingPoint[];
 overflowStart?:Point;overflowAfter?:Point;overflowThrough?:Point;overflowPending?:boolean;retryFirst?:boolean;overflowFirst?:boolean};
export type NativeCandidateBudget={remaining:number;allocations?:Map<string,number>;order?:string[];blocks:Map<string,Promise<Hex|null>>};
export function nativeCandidateBudget():NativeCandidateBudget{return{remaining:8,blocks:new Map()};}
const digest=(value:unknown)=>keccak256(stringToHex(canonicalProofJson(value)));
const point=(event:CustodyEvent):Point=>({eventId:event.id,blockNumber:event.blockNumber,blockHash:event.blockHash,transactionIndex:event.transactionIndex,logIndex:event.logIndex});
/** Share eight RPC candidates fairly, with durable rotation before any slow run can consume this turn. */
export async function prepareNativeCandidateBudget(store:AuditStore,batchIds:string[],binding:unknown,deadline:number):Promise<NativeCandidateBudget>{
 const budget=nativeCandidateBudget(),ids=[...new Set(batchIds)].sort();budget.allocations=new Map();budget.order=[];
 if(!ids.length)return budget;
 const key=canonicalProofJson(binding),id=`internal_native_destination_schedule:${digest(key)}`;
 // The schedule is advisory. Its store can be busy/offline without changing a
 // receipt, proof, or financial cursor; this turn retains its local eight slots.
 let previous:Awaited<ReturnType<AuditStore["getBuybackBatch"]>>=null;
 try{previous=await store.getBuybackBatch(id);}catch{/* Only advisory scheduling can fall back to its local allocation. */}
 const start=previous?.protocol==="internal_native_destination_schedule_v1"&&previous.binding===key&&typeof previous.nextBatchId==="string"?Math.max(0,ids.indexOf(previous.nextBatchId)):0;
 const ordered=[...ids.slice(start),...ids.slice(0,start)];
 for(let index=0;index<budget.remaining;index++){const batchId=ordered[index%ordered.length];if(!budget.allocations.has(batchId))budget.order.push(batchId);budget.allocations.set(batchId,(budget.allocations.get(batchId)??0)+1);}
 if(Date.now()>=deadline)throw new Error("Native candidate scheduling budget reached; pending");
 const next={id,protocol:"internal_native_destination_schedule_v1",version:1,binding:key,nextBatchId:ids[(start+1)%ids.length],updatedAt:Date.now()};
 if(previous?.protocol!==next.protocol||previous.version!==next.version||previous.binding!==next.binding||previous.nextBatchId!==next.nextBatchId)
  try{await store.compareAndSetBuybackAudit(next,previous);}catch{/* A failed advisory write cannot invalidate canonical custody evidence. */}
 return budget;
}
/** One durable audit per real source proof, never one row or an unbounded array per foreign dust receipt. */
export async function readAuditedNativeRelay(input:{source:Client;destination:Client;store:AuditStore;batch:BaseFeeBatch;graphFingerprint:string;
 treasuryState:CustodyState|null;events:CustodyEvent[];budget:NativeCandidateBudget;deadline:number;
 verify():Promise<BaseNativeRelayEvidence>;authenticate?:typeof nativeDestinationHasFixedProvider}):Promise<{proof:BaseNativeRelayEvidence;pending:boolean}>{
 if(!input.batch.proof||!input.treasuryState)throw new Error("Native candidate audit requires the canonical proof and Treasury checkpoint");
 const binding=canonicalProofJson({proof:input.batch.proof,graph:input.graphFingerprint,checkpoint:input.treasuryState.checkpoint,
  provider:BASE_NATIVE_RELAY_SOLVER,router:RELAY_ROUTER,codes:BUYBACK_CODE_HASHES,validationPolicy:BASE_NATIVE_DESTINATION_POLICY});
 const id=`internal_native_destination:${digest(binding)}`,stored=await input.store.getBuybackBatch(id);
 let expected=stored;
 let audit:Audit|undefined;
 if(stored?.protocol==="internal_native_destination_audit_v1"&&stored.version===1&&stored.binding===binding&&stored.checkpointHash===input.treasuryState.checkpoint.hash&&
  stored.proof&&stored.proofHash===digest(stored.proof))audit=structuredClone(stored) as unknown as Audit;
 const block=async(client:Client,chain:number,number:string)=>{const key=`${chain}:${number}`;if(!input.budget.blocks.has(key))input.budget.blocks.set(key,client.getBlock({blockNumber:BigInt(number)}).then(row=>row.hash));return input.budget.blocks.get(key)!;};
 const canonicalProof=async(proof:BaseNativeRelayEvidence,fresh=false)=>proof.sourceTransactionHash.toLowerCase()===input.batch.proof!.sourceHash.toLowerCase()&&proof.destinationTransactionHash.toLowerCase()===input.batch.proof!.destinationHash.toLowerCase()&&
  (await(fresh?input.source.getBlock({blockNumber:BigInt(proof.sourceBlockNumber)}).then(row=>row.hash):block(input.source,8453,proof.sourceBlockNumber)))?.toLowerCase()===proof.sourceBlockHash.toLowerCase()&&
  (await(fresh?input.destination.getBlock({blockNumber:BigInt(proof.destinationBlockNumber)}).then(row=>row.hash):block(input.destination,4663,proof.destinationBlockNumber)))?.toLowerCase()===proof.destinationBlockHash.toLowerCase();
 if(audit&&!await canonicalProof(audit.proof))audit=undefined;
 if(!audit){const proof=await input.verify();if(!await canonicalProof(proof))throw new Error("Native proof snapshot changed canonical anchors");
  audit={id,protocol:"internal_native_destination_audit_v1",version:1,binding,updatedAt:Date.now(),proof,proofHash:digest(proof),checkpointHash:input.treasuryState.checkpoint.hash};}
 const candidates=input.events.filter(event=>event.kind==="in"&&BigInt(event.amount)>0n&&!sameAddress(event.from,event.to)&&sameAddress(event.from,RELAY_ROUTER)&&sameAddress(event.asset,BASE_BUYBACK_RH_WETH)&&
  event.id!==vaultEventId(audit!.proof.destinationTransactionHash,audit!.proof.destinationTransferLogIndex)&&(!input.batch.destinationFromBlock||BigInt(event.blockNumber)>=BigInt(input.batch.destinationFromBlock))&&
  (!event.nativeRequestMetadata||event.nativeRequestMetadata.toLowerCase()===audit!.proof.metadata.toLowerCase())).sort(compareVaultEvents);
 const content=(value:Record<string,unknown>|Audit|null)=>{if(!value)return null;const {updatedAt:_,...rest}=value;return canonicalProofJson(rest);};
 const validPoint=async(value:Point|undefined,priority=false)=>{
  if(!value)return true;const event=candidates.find(row=>row.id===value.eventId);
  return!!event&&event.blockNumber===value.blockNumber&&event.transactionIndex===value.transactionIndex&&event.logIndex===value.logIndex&&event.blockHash===value.blockHash&&
   (!priority||!!event.nativeTransactionFrom&&sameAddress(event.nativeTransactionFrom,BASE_NATIVE_RELAY_SOLVER))&&(await block(input.destination,4663,event.blockNumber))===event.blockHash;};
 const save=async()=>{
  if(Date.now()>=input.deadline)throw new Error("Native candidate audit budget reached; pending");
  let winner:Awaited<ReturnType<AuditStore["getBuybackBatch"]>>;
  if(content(audit!)===content(expected)){
   winner=await input.store.getBuybackBatch(id);
   if(content(winner)===content(expected)){audit!.updatedAt=expected!.updatedAt as number;return;}
  }else{
   audit!.updatedAt=Date.now();const next=structuredClone(audit!) as unknown as Record<string,unknown>&{id:string};
   if(await input.store.compareAndSetBuybackAudit(next,expected)){expected=next;return;}
   winner=await input.store.getBuybackBatch(id);
  }
  // Identical readers may have committed the same immutable proof or a newer
  // conclusive prefix. Re-read and authenticate that winner; never fall back on
  // a lost proof/conflict write or overwrite a newer cursor with a stale one.
  const forward=(desired:Point|undefined,actual:Point|undefined)=>!desired||!!actual&&compareVaultEvents(actual,desired)>=0;
  if(!winner||winner.id!==id||winner.protocol!=="internal_native_destination_audit_v1"||winner.version!==1||winner.binding!==binding||winner.checkpointHash!==input.treasuryState!.checkpoint.hash||
   winner.proofHash!==audit!.proofHash||digest(winner.proof)!==winner.proofHash||!await canonicalProof(winner.proof as BaseNativeRelayEvidence,true)||
   winner.conflict||audit!.conflict||!forward(audit!.after,winner.after as Point|undefined)||!forward(audit!.scanAfter,winner.scanAfter as Point|undefined)||!forward(audit!.priorityAfter,winner.priorityAfter as Point|undefined)||
   !await validPoint(winner.after as Point|undefined)||!await validPoint(winner.scanAfter as Point|undefined)||!await validPoint(winner.priorityAfter as Point|undefined,true))
   throw new Error("Native candidate audit changed concurrently; retry its canonical snapshot");
  audit=structuredClone(winner) as unknown as Audit;audit.pendingCandidates??=[];expected=winner;
 };
 const proof=audit.proof;
 await save(); // Later candidate RPC failures cannot erase a verified immutable proof snapshot.
 if(audit.conflict){const event=candidates.find(row=>row.id===audit!.conflict!.eventId);
  if(event?.blockHash===audit.conflict.blockHash&&(await block(input.destination,4663,event.blockNumber))===event.blockHash)throw new Error("Native provider request tag has multiple canonical destination receipts; attribution withheld");
  audit.conflict=undefined;}
 if(audit.after){const event=candidates.find(row=>row.id===audit!.after!.eventId);
  if(!event||event.blockHash!==audit.after.blockHash||(await block(input.destination,4663,event.blockNumber))!==event.blockHash){audit.after=undefined;audit.scanAfter=undefined;audit.priorityAfter=undefined;}}
 if(audit.scanAfter){const event=candidates.find(row=>row.id===audit!.scanAfter!.eventId);
  if(!event||event.blockHash!==audit.scanAfter.blockHash||(await block(input.destination,4663,event.blockNumber))!==event.blockHash)audit.scanAfter=undefined;}
 if(audit.priorityAfter){const event=candidates.find(row=>row.id===audit!.priorityAfter!.eventId);
  if(!event||!event.nativeTransactionFrom||!sameAddress(event.nativeTransactionFrom,BASE_NATIVE_RELAY_SOLVER)||event.blockHash!==audit.priorityAfter.blockHash||(await block(input.destination,4663,event.blockNumber))!==event.blockHash){audit.priorityAfter=undefined;audit.scanAfter=undefined;audit.after=undefined;}}
 if(audit.pendingCandidates!==undefined&&!Array.isArray(audit.pendingCandidates)){audit.scanAfter=undefined;audit.after=undefined;audit.priorityAfter=undefined;}
 const unresolved=[...(Array.isArray(audit.pendingCandidates)?audit.pendingCandidates:[]),...(audit.pending?[audit.pending]:[])];
 audit.pending=undefined;audit.pendingCandidates=[];
 for(const value of unresolved){const event=candidates.find(row=>row.id===value.eventId);
  if(event&&event.blockHash===value.blockHash&&event.blockNumber===value.blockNumber&&Number.isSafeInteger(value.retryAfter)&&!audit.pendingCandidates.some(row=>row.eventId===value.eventId)){
   if(audit.pendingCandidates.length<512)audit.pendingCandidates.push(value);
   else if(!audit.overflowStart||compareVaultEvents(event,audit.overflowStart)<0){audit.overflowStart=point(event);audit.overflowAfter=undefined;audit.overflowThrough=undefined;}}
  else{audit.scanAfter=undefined;audit.after=undefined;}}
 if(audit.overflowStart&&!await validPoint(audit.overflowStart)){audit.overflowStart=undefined;audit.overflowAfter=undefined;audit.overflowThrough=undefined;audit.overflowPending=undefined;audit.scanAfter=undefined;audit.after=undefined;}
 if(audit.overflowThrough&&(!audit.overflowStart||compareVaultEvents(audit.overflowThrough,audit.overflowStart)<0||!audit.scanAfter||compareVaultEvents(audit.overflowThrough,audit.scanAfter)>0||!await validPoint(audit.overflowThrough))){audit.overflowThrough=undefined;audit.overflowAfter=undefined;audit.overflowPending=undefined;}
 if(audit.overflowAfter&&(!audit.overflowStart||compareVaultEvents(audit.overflowAfter,audit.overflowStart)<0||!audit.overflowThrough||compareVaultEvents(audit.overflowAfter,audit.overflowThrough)>0||!await validPoint(audit.overflowAfter))){audit.overflowAfter=undefined;audit.overflowPending=undefined;}
 if(audit.overflowStart&&audit.scanAfter&&!audit.overflowThrough)audit.overflowThrough=audit.scanAfter;
 const outstanding=candidates.filter(event=>!(audit!.scanAfter??audit!.after)||compareVaultEvents(event,(audit!.scanAfter??audit!.after)!)>0);
 // Root sender is a scheduling hint only. A rotating EOA can submit a fill
 // funded by the fixed solver; every candidate still authenticates its funding.
 const fixedSender=(event:CustodyEvent)=>!!event.nativeTransactionFrom&&sameAddress(event.nativeTransactionFrom,BASE_NATIVE_RELAY_SOLVER);
 const priority=outstanding.filter(event=>fixedSender(event)&&(!audit!.priorityAfter||compareVaultEvents(event,audit!.priorityAfter)>0));
 const checked=new Set<string>(),attempted=new Set<string>();
 const available=()=>Math.min(input.budget.remaining,input.budget.allocations?.get(input.batch.id)??input.budget.remaining);
 const retryDue=audit.pendingCandidates.some(row=>!Number.isSafeInteger(row.retryAfter)||row.retryAfter<=Date.now()||row.retryAfter>audit!.updatedAt+120_000);
 const oldWork=!!audit.overflowStart||retryDue;
 // A one-slot batch alternates discovery and retry. Larger allocations reserve
 // up to two of their existing slots; sustained new dust cannot starve either
 // the bounded pending queue or its overflow range.
 const oldReserve=oldWork&&available()>0?(available()===1?Number(!!audit.retryFirst):Math.min(2,Math.max(1,Math.floor(available()/2)))):0;
 if(oldWork&&available()===1)audit.retryFirst=!audit.retryFirst;
 const scanOverflow=!(retryDue&&oldReserve===1&&audit.overflowFirst);
 if(audit.overflowStart&&retryDue&&oldReserve===1)audit.overflowFirst=!audit.overflowFirst;
 const inspect=async(event:CustodyEvent,reserve=0)=>{
  const retained=audit!.pendingCandidates!.find(row=>row.eventId===event.id);
  if(retained&&Number.isSafeInteger(retained.retryAfter)&&retained.retryAfter<=audit!.updatedAt+120_000&&Date.now()<retained.retryAfter){attempted.add(event.id);return false;}
  const allocated=input.budget.allocations?.get(input.batch.id);
  if(Date.now()>=input.deadline||available()<=reserve||allocated!==undefined&&allocated<=0||input.budget.allocations&&!input.budget.allocations.has(input.batch.id))return undefined;
  input.budget.remaining--;if(allocated!==undefined)input.budget.allocations!.set(input.batch.id,allocated-1);
  attempted.add(event.id);
  try{const receipt=await canonicalBaseReceipt(input.destination,event.transactionHash,4663);
   if(receipt.blockHash!==event.blockHash||String(receipt.blockNumber)!==event.blockNumber)throw new Error("Native candidate journal receipt reorganized");
   if(nativeDestinationTagMatches(receipt,proof.metadata)&&await(input.authenticate??nativeDestinationHasFixedProvider)(input.destination,event.transactionHash,proof.metadata,{auditStore:input.store})){
    audit!.conflict=point(event);await save();throw new Error("Native provider request tag has multiple canonical destination receipts; attribution withheld");}
  }catch(error){if(audit!.conflict)throw error;
   audit!.pendingCandidates=audit!.pendingCandidates!.filter(row=>row.eventId!==event.id);
   if(audit!.pendingCandidates.length<512)audit!.pendingCandidates.push({...point(event),retryAfter:Date.now()+30_000});
   else if(!audit!.overflowStart||compareVaultEvents(event,audit!.overflowStart)<0){audit!.overflowStart=point(event);audit!.overflowAfter=undefined;audit!.overflowThrough=undefined;}
   await save();return false;}
  audit!.pendingCandidates=audit!.pendingCandidates!.filter(row=>row.eventId!==event.id);
  checked.add(event.id);return true;
 };
 // This cursor covers only the fixed-sender subsequence. Advancing it never
 // skips earlier foreign rows on the independent, chronological scan cursor.
 let priorityBlocked=false;
 for(const event of priority){if(audit.priorityAfter&&compareVaultEvents(event,audit.priorityAfter)<=0){checked.add(event.id);continue;}const result=await inspect(event,oldReserve);if(result===undefined)break;
  if(!result)priorityBlocked=true;else if(!priorityBlocked){audit.priorityAfter=point(event);await save();}}
 // A scanned point may advance past a separately persisted pending candidate.
 // The conclusive prefix advances only when every queued earlier point clears.
 for(const event of outstanding){
  if(audit.after&&compareVaultEvents(event,audit.after)<=0){checked.add(event.id);continue;}
  if(fixedSender(event)&&audit.priorityAfter&&compareVaultEvents(event,audit.priorityAfter)<=0)checked.add(event.id);
  if(!checked.has(event.id)&&!attempted.has(event.id)){const result=await inspect(event,oldReserve);if(result===undefined)break;}
  if(attempted.has(event.id)||checked.has(event.id)){audit.scanAfter=point(event);
   if(!audit.overflowStart&&!audit.pendingCandidates!.some(row=>compareVaultEvents(row,event)<=0))audit.after=point(event);
   await save();}}
 // Overflow is a bounded scheduling range, never conclusive coverage. Keep its
 // full canonical events in the journal and rotate two of the existing eight
 // slots through old unresolved rows while new arrivals retain their share.
 if(scanOverflow&&audit.overflowStart&&audit.scanAfter){
  audit.overflowThrough??=audit.scanAfter;
  const range=candidates.filter(event=>compareVaultEvents(event,audit!.overflowStart!)>=0&&compareVaultEvents(event,audit!.overflowThrough!)<=0&&
   (!audit!.overflowAfter||compareVaultEvents(event,audit!.overflowAfter)>0)&&!audit!.pendingCandidates!.some(row=>row.eventId===event.id));
  let inspected=0;
  for(const event of range){if(inspected>=(retryDue?1:Math.max(1,oldReserve)))break;
   if(attempted.has(event.id)){audit.overflowPending=true;audit.overflowAfter=point(event);continue;}
   const result=await inspect(event);if(result===undefined)break;inspected++;audit.overflowPending=!!audit.overflowPending||!result;audit.overflowAfter=point(event);await save();}
  if(!range.length||audit.overflowAfter&&range.at(-1)?.id===audit.overflowAfter.eventId){
   if(!audit.overflowPending){const tail=candidates.find(event=>compareVaultEvents(event,audit!.overflowThrough!)>0&&compareVaultEvents(event,audit!.scanAfter!)<=0&&!audit!.pendingCandidates!.some(row=>row.eventId===event.id));audit.overflowStart=tail?point(tail):undefined;}
   audit.overflowAfter=undefined;audit.overflowThrough=undefined;audit.overflowPending=undefined;}
 }
 for(const retained of [...audit.pendingCandidates!]){const event=candidates.find(row=>row.id===retained.eventId);
  if(event&&!attempted.has(event.id)){const result=await inspect(event);if(result===undefined)break;}}
 if(audit.scanAfter&&!audit.overflowStart&&!audit.pendingCandidates!.some(row=>compareVaultEvents(row,audit!.scanAfter!)<=0))audit.after=audit.scanAfter;
 const pending=!!audit.pendingCandidates!.length||!!audit.overflowStart||outstanding.some(event=>!attempted.has(event.id)&&!checked.has(event.id));
 await save();return{proof,pending};
}
