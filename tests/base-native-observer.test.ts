import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { observeNativeRelayBatches } from "../server/base-native-observer";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, type BaseFeeBatch } from "../src/lib/base-buyback";
import type { CustodyEvent } from "../src/lib/buyback-custody-ledger";
import type { BaseNativeSourceFrame } from "../server/base-native-trace";
import { RELAY_ROUTER, relayRequestMetadata } from "../server/buyback";
import { vaultEventId } from "../src/lib/buyback-vault-ledger";
const addr=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const automation=addr(1),collector=addr(2),asset=addr(3);
function event(tx:number,kind:"in"|"out"):CustodyEvent{return{id:vaultEventId(hash(tx),0),transactionHash:hash(tx),blockNumber:"10",blockHash:hash(10),transactionIndex:tx,logIndex:0,kind,asset:kind==="in"?BASE_BUYBACK_RH_WETH:asset,from:kind==="in"?RELAY_ROUTER:automation,to:kind==="in"?BASE_BUYBACK_TREASURY:addr(4),amount:"50"};}
function fixture(count=1){
 const records=new Map<string,BaseFeeBatch>();let clock=1000,calls:Hex[]=[];
 const frames=new Map<Hex,BaseNativeSourceFrame>(),destinations=new Map<Hex,Hex>();
 for(let n=1;n<=count;n++){const id=hash(n+100);frames.set(hash(n),{sourceTransactionHash:hash(n),sourceBlockNumber:"1",sourceBlockHash:hash(1),sourceTransferLogIndex:0,sourceDepositLogIndex:1,sourceTimestamp:"1001",sourceAsset:asset,sourceAmount:"50",sourceNativeDeposit:"6",requestId:id,orderId:hash(n+200),metadata:relayRequestMetadata(id),automation,sourceCalldataHash:hash(n+300)});destinations.set(hash(n+10),relayRequestMetadata(id));}
 const deps={sourceFrame:async(_source:any,tx:Hex)=>{calls.push(tx);return frames.get(tx)!;},receipt:async(_dest:any,tx:Hex)=>({transactionHash:tx,metadata:destinations.get(tx)}) as any,tagMatches:(receipt:any,metadata:Hex)=>receipt.metadata===metadata,
  destinationFrame:async(_dest:any,tx:Hex,frame:BaseNativeSourceFrame)=>({...frame,version:2 as const,protocol:BASE_BUYBACK_PROTOCOL as typeof BASE_BUYBACK_PROTOCOL,orderParametersVerified:false,treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"5",destinationTransactionHash:tx,destinationBlockNumber:"10",destinationBlockHash:hash(10),destinationTransferLogIndex:0,destinationMovementLogIndex:1})};
 const input=()=>({source:{} as any,destination:{getBlockNumber:async()=>100n,getBlock:async({blockNumber}:any)=>({hash:hash(Number(blockNumber)+500),timestamp:1000n+blockNumber})} as any,store:{saveBuybackBatch:async(record:any)=>{records.set(record.id,record);}},collector,automation,sourceEvents:Array.from({length:count},(_,i)=>event(i+1,"out")),treasuryEvents:Array.from(destinations.keys()).map(tx=>event(Number(BigInt(tx)),"in")),batches:[...records.values()],deadline:clock+45_000,now:()=>clock});
 return{records,frames,destinations,deps,input,advance:(ms=30_001)=>{clock+=ms;},calls};
}
test("automatic observer persists v2 trace proof with stable source identity and no quote API or new source spending",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const record=[...f.records.values()][0];assert.equal(record.id,`native-source:${hash(1)}`);assert.equal(record.status,"received");assert.equal(record.proof?.version,2);assert.equal(record.relay?.orderParametersVerified,false);assert.equal(record.receivedAmount,"5");
 await observeNativeRelayBatches(f.input(),f.deps);assert.equal(f.calls.length,1,"Restart respects persisted backoff");assert.equal(f.records.size,1);
});
test("same-round duplicate request/order never creates two received observations or a permanently occupied second identity",async()=>{
 const f=fixture(2);f.frames.set(hash(2),{...f.frames.get(hash(1))!,sourceTransactionHash:hash(2)});f.destinations.delete(hash(12));
 await observeNativeRelayBatches(f.input(),f.deps);assert.equal([...f.records.values()].filter(row=>row.status==="received").length,0);const second=f.records.get(`native-source:${hash(2)}`)!;assert.equal(second.status,"unknown");assert.equal(second.requestId,undefined);assert.ok(second.nativeConflict);
 // A source reorg removes the conflicting second actual input; the retained first canonical job recovers without spending again.
 f.advance();const next=f.input();next.sourceEvents=next.sourceEvents.slice(0,1);await observeNativeRelayBatches(next,f.deps);assert.equal(f.records.get(`native-source:${hash(1)}`)!.status,"received");
});
test("destination reorg drops stale matched hash and recovers the actual replacement receipt after restart",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);f.advance(300_001);const tag=f.destinations.get(hash(11))!;f.destinations.delete(hash(11));f.destinations.set(hash(21),tag);
 await observeNativeRelayBatches(f.input(),f.deps);const record=f.records.get(`native-source:${hash(1)}`)!;assert.equal(record.status,"received");assert.equal(record.destinationHash,hash(21));assert.equal(record.sourceHash,hash(1));assert.equal(f.records.size,1);
});
test("unsupported early candidates cannot starve later canonical source jobs",async()=>{
 const f=fixture(3),sourceFrame=f.deps.sourceFrame;f.deps.sourceFrame=async(client,tx)=>{if(tx===hash(1)||tx===hash(2)){f.calls.push(tx);throw new Error("Unsupported route");}return sourceFrame(client,tx);};
 await observeNativeRelayBatches(f.input(),f.deps);f.advance();await observeNativeRelayBatches(f.input(),f.deps);assert.ok(f.calls.includes(hash(3)));assert.equal(f.records.get(`native-source:${hash(3)}`)!.status,"received");
});
test("bounded destination pagination detects a duplicate request tag beyond the first page instead of prematurely receiving",async()=>{
 const f=fixture();f.destinations.clear();for(let n=10;n<32;n++)f.destinations.set(hash(n),n===10||n===31?f.frames.get(hash(1))!.metadata:relayRequestMetadata(hash(n+1000)));
 await observeNativeRelayBatches(f.input(),f.deps);let record=f.records.get(`native-source:${hash(1)}`)!;assert.equal(record.status,"bridging");assert.equal(record.proof,undefined);assert.equal(record.destinationScanAfter,hash(29));
 f.advance();await observeNativeRelayBatches(f.input(),f.deps);record=f.records.get(`native-source:${hash(1)}`)!;assert.equal(record.status,"unknown");assert.match(record.error!,/ambiguous/);assert.equal(record.proof,undefined);
});
test("late or partial provider evidence stays pending/unknown and never releases source input or claims complete fill",async()=>{
 const f=fixture();f.destinations.clear();await observeNativeRelayBatches(f.input(),f.deps);assert.equal([...f.records.values()][0].status,"bridging");
 f.advance();f.destinations.set(hash(11),f.frames.get(hash(1))!.metadata);f.deps.destinationFrame=async()=>{throw new Error("partial actual Transfer does not match request movement");};await observeNativeRelayBatches(f.input(),f.deps);const record=[...f.records.values()][0];assert.equal(record.status,"unknown");assert.equal(record.receivedAmount,"0");assert.equal(record.sourceHash,hash(1));
});
test("a retained same-source archive never replaces or revives the active stable identity",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const active=f.records.get(`native-source:${hash(1)}`)!;
 f.records.set("retained-old-import",{...active,id:"retained-old-import",status:"unknown",updatedAt:1});f.advance(300_001);await observeNativeRelayBatches(f.input(),f.deps);
 assert.equal(f.records.get("retained-old-import")!.status,"unknown");assert.equal(f.records.get(active.id)!.status,"received");assert.equal([...f.records.values()].filter(row=>row.status==="received").length,1);
 // Previously bad duplicate active rows are retained but quarantined instead of permanently occupying the identity.
 f.records.set("retained-old-import",{...active,id:"retained-old-import",status:"received",updatedAt:1});f.advance(300_001);await observeNativeRelayBatches(f.input(),f.deps);
 assert.equal(f.records.get("retained-old-import")!.status,"unknown");assert.equal([...f.records.values()].filter(row=>row.status==="received").length,1);
});
test("a later conflicting source quarantines a previous received proof even while its five-minute refresh is ineligible",async()=>{
 const f=fixture(2);const first=f.input();first.sourceEvents=first.sourceEvents.slice(0,1);first.treasuryEvents=first.treasuryEvents.slice(0,1);await observeNativeRelayBatches(first,f.deps);
 f.advance();f.frames.set(hash(2),{...f.frames.get(hash(1))!,sourceTransactionHash:hash(2)});f.destinations.delete(hash(12));await observeNativeRelayBatches(f.input(),f.deps);
 assert.equal(f.records.get(`native-source:${hash(1)}`)!.status,"unknown");assert.equal(f.records.get(`native-source:${hash(2)}`)!.status,"unknown");assert.ok(f.records.get(`native-source:${hash(1)}`)!.proof);assert.equal([...f.records.values()].filter(row=>row.status==="received").length,0);
});
test("RH reorg invalidates the cached timestamp lower bound so an earlier-height canonical replacement is discoverable",async()=>{
 const f=fixture();f.frames.set(hash(1),{...f.frames.get(hash(1))!,sourceTimestamp:"1010"});await observeNativeRelayBatches(f.input(),f.deps);const row=f.records.get(`native-source:${hash(1)}`)!;assert.equal(row.destinationFromBlock,"10");
 f.advance(300_001);const tag=f.destinations.get(hash(11))!;f.destinations.delete(hash(11));f.destinations.set(hash(21),tag);const changed=f.input();changed.treasuryEvents[0].blockNumber="9";
 changed.destination={getBlockNumber:async()=>100n,getBlock:async({blockNumber}:any)=>({hash:hash(Number(blockNumber)+1000),timestamp:1001n+blockNumber})} as any;
 await observeNativeRelayBatches(changed,f.deps);const recovered=f.records.get(row.id)!;assert.equal(recovered.status,"received");assert.equal(recovered.destinationFromBlock,"9");assert.equal(recovered.destinationHash,hash(21));
});
test("deadline after reorg anchor reset never rebinds an invalid prior receipt cursor to the new lower bound",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const row=f.records.get(`native-source:${hash(1)}`)!;
 f.advance(300_001);const tag=f.destinations.get(hash(11))!;f.destinations.delete(hash(11));f.destinations.set(hash(21),tag);f.destinations.set(hash(31),relayRequestMetadata(hash(301)));
 row.destinationScanAfter=hash(31);let expired=false,anchorReads=0;const input=f.input(),baseNow=input.now();input.now=()=>expired?input.deadline:baseNow;
 input.destination={getBlockNumber:async()=>100n,getBlock:async({blockNumber}:any)=>{if(blockNumber===1n&&++anchorReads===3)expired=true;return{hash:hash(Number(blockNumber)+1000),timestamp:1000n+blockNumber};}} as any;
 await observeNativeRelayBatches(input,f.deps);const pending=f.records.get(row.id)!;assert.equal(pending.status,"bridging");assert.equal(pending.destinationScanAfter,undefined);
 f.advance();await observeNativeRelayBatches(f.input(),f.deps);assert.equal(f.records.get(row.id)!.status,"received");assert.equal(f.records.get(row.id)!.destinationHash,hash(21));
});
