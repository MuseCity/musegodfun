import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { captureNativeRelayDestinations, observeNativeRelayBatches } from "../server/base-native-observer";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, type BaseFeeBatch } from "../src/lib/base-buyback";
import type { CustodyEvent } from "../src/lib/buyback-custody-ledger";
import { BASE_NATIVE_RELAY_SOLVER, NativeDestinationProviderPendingError, nativeDestinationHasFixedProvider, type BaseNativeSourceFrame } from "../server/base-native-trace";
import { RELAY_ROUTER, relayRequestMetadata } from "../server/buyback";
import { vaultEventId } from "../src/lib/buyback-vault-ledger";
const addr=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const automation=addr(1),collector=addr(2),asset=addr(3);
function event(tx:number,kind:"in"|"out"):CustodyEvent{return{id:vaultEventId(hash(tx),0),transactionHash:hash(tx),blockNumber:"10",blockHash:hash(10),transactionIndex:tx,logIndex:0,kind,asset:kind==="in"?BASE_BUYBACK_RH_WETH:asset,from:kind==="in"?RELAY_ROUTER:automation,to:kind==="in"?BASE_BUYBACK_TREASURY:RELAY_ROUTER,amount:"50"};}
function fixture(count=1){
 const records=new Map<string,BaseFeeBatch>();let clock=1000,calls:Hex[]=[];
 const frames=new Map<Hex,BaseNativeSourceFrame>(),destinations=new Map<Hex,Hex>();
 for(let n=1;n<=count;n++){const id=hash(n+100);frames.set(hash(n),{sourceTransactionHash:hash(n),sourceBlockNumber:"1",sourceBlockHash:hash(1),sourceTransferLogIndex:0,sourceDepositLogIndex:1,sourceTimestamp:"1001",sourceAsset:asset,sourceAmount:"50",sourceNativeDeposit:"6",requestId:id,orderId:hash(n+200),metadata:relayRequestMetadata(id),automation,sourceCalldataHash:hash(n+300)});destinations.set(hash(n+10),relayRequestMetadata(id));}
 const deps={provider:async()=>true,sourceFrame:async(_source:any,tx:Hex)=>{calls.push(tx);return frames.get(tx)!;},receipt:async(_dest:any,tx:Hex)=>({transactionHash:tx,metadata:destinations.get(tx)}) as any,tagMatches:(receipt:any,metadata:Hex)=>receipt.metadata===metadata,
  destinationFrame:async(_dest:any,tx:Hex,frame:BaseNativeSourceFrame)=>({...frame,version:2 as const,protocol:BASE_BUYBACK_PROTOCOL as typeof BASE_BUYBACK_PROTOCOL,orderParametersVerified:false,treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"5",destinationTransactionHash:tx,destinationBlockNumber:"10",destinationBlockHash:hash(10),destinationTransferLogIndex:0,destinationMovementLogIndex:1})};
 const input=()=>({source:{} as any,destination:{getBlockNumber:async()=>100n,getBlock:async({blockNumber}:any)=>({hash:hash(Number(blockNumber)+500),timestamp:1000n+blockNumber})} as any,store:{saveBuybackBatch:async(record:any)=>{records.set(record.id,record);}},collector,automation,sourceEvents:Array.from({length:count},(_,i)=>event(i+1,"out")),treasuryEvents:Array.from(destinations.keys()).map(tx=>event(Number(BigInt(tx)),"in")),batches:[...records.values()],deadline:clock+45_000,now:()=>clock});
 return{records,frames,destinations,deps,input,advance:(ms=30_001)=>{clock+=ms;},calls};
}
test("automatic observer persists v2 trace proof with stable source identity and no quote API or new source spending",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const record=[...f.records.values()][0];assert.equal(record.id,`native-source:${hash(1)}`);assert.equal(record.status,"received");assert.equal(record.proof?.version,2);assert.equal(record.relay?.orderParametersVerified,false);assert.equal(record.receivedAmount,"5");
 await observeNativeRelayBatches(f.input(),f.deps);assert.equal(f.calls.length,1,"Restart respects persisted backoff");assert.equal(f.records.size,1);
});
test("new Treasury candidate code is captured immediately even during retained thirty-minute source replay backoff",async()=>{
 const f=fixture(),rows=new Map<string,any>(),seen:Hex[]=[];await observeNativeRelayBatches(f.input(),f.deps);
 const id=`native-source:${hash(1)}`,accepted=f.records.get(id)!;
 f.records.set(id,{...accepted,status:"unknown",nativeRetryAfter:accepted.updatedAt+1_800_000,nativeRetryAttempts:16});
 f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);
 const input={...f.input(),auditStore:{getBuybackBatch:async(id:string)=>structuredClone(rows.get(id)??null),compareAndSetBuybackAudit:async(row:any)=>{rows.set(row.id,structuredClone(row));return true;}}};
 await observeNativeRelayBatches(input,{...f.deps,provider:async(_client,tx)=>{seen.push(tx);return tx===hash(11);}});
 assert(seen.includes(hash(21)));assert.equal(f.calls.length,1,"Capture cannot wait for another source VM attempt");
 assert.equal(f.records.get(id)!.status,"unknown","Code capture is not financial acceptance");assert(rows.size>0);
});
test("source finalized discovery stops the recurring five-minute full source proof while new receipts remain observable",async()=>{
 const f=fixture();let blockReads=0;const input=()=>({...f.input(),source:{getChainId:async()=>8453,getBlock:async({blockNumber,blockTag}:any)=>{blockReads++;return blockTag==="finalized"?{number:100n,hash:hash(100)}:{number:blockNumber,hash:hash(Number(blockNumber)),timestamp:1000n+blockNumber};}} as any});
 await observeNativeRelayBatches(input(),f.deps);const accepted=f.records.get(`native-source:${hash(1)}`)!;
 assert.equal(accepted.sourceFinalized,true);for(let n=0;n<3;n++){f.advance(300_001);await observeNativeRelayBatches(input(),f.deps);}
 assert.equal(f.calls.length,1);assert(blockReads>0);assert.equal(f.records.get(accepted.id)!.status,"received");
});
test("pending source proof backs off exponentially across observer restarts and clears only after canonical success",async()=>{
 const f=fixture(),original=f.deps.sourceFrame;let unavailable=true;
 const deps={...f.deps,sourceFrame:async(client:any,tx:Hex)=>{if(unavailable){f.calls.push(tx);throw new Error("Local replay pending: timeout");}return original(client,tx);}};
 for(const delay of [30_000,60_000,120_000]){
  await observeNativeRelayBatches(f.input(),deps);const record=f.records.get(`native-source:${hash(1)}`)!;
  assert.equal(record.nativeRetryAfter!-record.updatedAt,delay);const calls=f.calls.length;
  f.advance(delay-1);await observeNativeRelayBatches(f.input(),deps);assert.equal(f.calls.length,calls);
  f.advance(2);
 }
 unavailable=false;await observeNativeRelayBatches(f.input(),deps);const received=f.records.get(`native-source:${hash(1)}`)!;
 assert.equal(received.status,"received");assert.equal(received.nativeRetryAfter,undefined);assert.equal(received.nativeRetryAttempts,undefined);
 assert.equal(received.amountIn,"50");assert.equal(received.receivedAmount,"5");assert.equal(received.refundedAmount,"0");
});
test("a canonical source awaiting destination evidence does not poll forever every thirty seconds",async()=>{
 const f=fixture();f.destinations.clear();
 for(const delay of [30_000,60_000,120_000]){
  await observeNativeRelayBatches(f.input(),f.deps);const row=f.records.get(`native-source:${hash(1)}`)!;
  assert.equal(row.status,"bridging");assert.equal(row.nativeRetryAfter!-row.updatedAt,delay);assert.equal(row.receivedAmount,"0");
  f.advance(delay+1);
 }
 f.destinations.set(hash(11),f.frames.get(hash(1))!.metadata);await observeNativeRelayBatches(f.input(),f.deps);
 const recovered=f.records.get(`native-source:${hash(1)}`)!;assert.equal(recovered.status,"received");assert.equal(recovered.nativeRetryAfter,undefined);
});
test("new canonical destination page progress resets backoff without claiming an incomplete fill",async()=>{
 const f=fixture();f.destinations.clear();await observeNativeRelayBatches(f.input(),f.deps);f.advance();await observeNativeRelayBatches(f.input(),f.deps);
 let row=f.records.get(`native-source:${hash(1)}`)!;assert.equal(row.nativeRetryAfter!-row.updatedAt,60_000);f.advance(60_001);
 for(let n=40;n<65;n++)f.destinations.set(hash(n),relayRequestMetadata(hash(n+1000)));
 await observeNativeRelayBatches(f.input(),f.deps);row=f.records.get(row.id)!;assert.equal(row.nativeRetryAfter!-row.updatedAt,30_000);
 assert.equal(row.destinationScanAfter,hash(59));assert.equal(row.receivedAmount,"0");assert.equal(row.proof,undefined);
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
test("bounded destination pagination accepts the first complete proof and withholds a later authenticated duplicate",async()=>{
 const f=fixture();f.destinations.clear();for(let n=10;n<32;n++)f.destinations.set(hash(n),n===10||n===31?f.frames.get(hash(1))!.metadata:relayRequestMetadata(hash(n+1000)));
 await observeNativeRelayBatches(f.input(),f.deps);let record=f.records.get(`native-source:${hash(1)}`)!;assert.equal(record.status,"received");assert.equal(record.proof?.destinationHash,hash(10));assert.equal(record.destinationScanAfter,hash(29));
 f.advance();await observeNativeRelayBatches(f.input(),f.deps);record=f.records.get(`native-source:${hash(1)}`)!;assert.equal(record.status,"unknown");assert.match(record.error!,/ambiguous/);assert.equal(record.proof?.destinationHash,hash(10));
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
test("deadline after reorg anchor reset retains the old journal until a canonical recovery turn completes",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const row=f.records.get(`native-source:${hash(1)}`)!;
 f.advance(300_001);const tag=f.destinations.get(hash(11))!;f.destinations.delete(hash(11));f.destinations.set(hash(21),tag);f.destinations.set(hash(31),relayRequestMetadata(hash(301)));
 row.destinationScanAfter=hash(31);let expired=false,anchorReads=0;const input=f.input(),baseNow=input.now();input.now=()=>expired?input.deadline:baseNow;
 input.destination={getBlockNumber:async()=>100n,getBlock:async({blockNumber}:any)=>{if(blockNumber===1n&&++anchorReads===3)expired=true;return{hash:hash(Number(blockNumber)+1000),timestamp:1000n+blockNumber};}} as any;
 const retained=structuredClone(row);
 await observeNativeRelayBatches(input,f.deps);assert.deepEqual(f.records.get(row.id),retained,"Expired observation does not bind the old cursor to a new unverified anchor");
 f.advance();await observeNativeRelayBatches(f.input(),f.deps);assert.equal(f.records.get(row.id)!.status,"received");assert.equal(f.records.get(row.id)!.destinationHash,hash(21));
});

test("zero-value, self and non-Relay outflows cannot create native tasks or displace a genuine run", async () => {
 const f=fixture(),input=f.input();
 input.sourceEvents=[{...event(91,"out"),amount:"0"},{...event(92,"out"),to:automation},{...event(93,"out"),to:addr(99)},...input.sourceEvents];
 await observeNativeRelayBatches(input,f.deps);
 assert.deepEqual(f.calls,[hash(1)]);assert.equal(f.records.size,1);
 assert.equal(f.records.get(`native-source:${hash(1)}`)!.status,"received");
});

test("an unauthenticated same-tag one-wei Router donation cannot make a provider arrival ambiguous", async () => {
 const f=fixture();f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);
 const input=f.input();input.treasuryEvents.find(row=>row.transactionHash===hash(21))!.amount="1";
 const providerCalls:Hex[]=[];
 await observeNativeRelayBatches(input,{...f.deps,provider:async(_client,tx)=>{providerCalls.push(tx);return tx!==hash(21);}});
 assert.deepEqual(providerCalls,[hash(11),hash(21)]);
 const received=f.records.get(`native-source:${hash(1)}`)!;
 assert.equal(received.status,"received");assert.equal(received.destinationHash,hash(11));assert.equal(received.receivedAmount,"5");
});

test("an old cached attacker match and exhausted scan cursor recover to the genuine provider receipt", async () => {
 const f=fixture();f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);
 const id=`native-source:${hash(1)}`;
 f.records.set(id,{id,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,collector,kind:"native_relay",status:"bridging",
  createdAt:1,updatedAt:1,amountIn:"50",receivedAmount:"0",refundedAmount:"0",burnedAmount:"0",claimHashes:[],sourceHash:hash(1),sourceBlockHash:hash(1),
  destinationFromBlock:"1",destinationFromBlockHash:hash(501),destinationMatchHash:hash(21),destinationScanAfter:hash(21)});
 f.advance();
 await observeNativeRelayBatches(f.input(),{...f.deps,provider:async(_client,tx)=>tx!==hash(21)});
 const row=f.records.get(id)!;assert.equal(row.status,"received");assert.equal(row.destinationHash,hash(11));
 assert.equal(row.destinationMatchHash,hash(11));
});

test("zero or self destination transfers cannot become matching native evidence", async () => {
 const f=fixture();f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);f.destinations.set(hash(31),f.frames.get(hash(1))!.metadata);
 const input=f.input();input.treasuryEvents.find(row=>row.transactionHash===hash(21))!.amount="0";
 input.treasuryEvents.find(row=>row.transactionHash===hash(31))!.to=RELAY_ROUTER;
 await observeNativeRelayBatches(input,f.deps);
 const row=f.records.get(`native-source:${hash(1)}`)!;assert.equal(row.status,"received");assert.equal(row.destinationHash,hash(11));
});

for(const status of ["bridging","reorg"] as const)test(`retained v1 ${status} recovers only after its original signed-order evidence is revalidated`,async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const previous=f.records.get(`native-source:${hash(1)}`)!;
 const proof={version:1 as const,protocol:BASE_BUYBACK_PROTOCOL as typeof BASE_BUYBACK_PROTOCOL,sourceHash:hash(1),destinationHash:hash(11),raw:{signature:"retained-order-evidence"}};
 f.records.set(previous.id,{...previous,status,proof,error:"prior canonical receipt was unavailable"});f.advance();let verified=0;
 const retained={...previous.relay!,version:1 as const,orderParametersVerified:true,sourceBlockHash:hash(901)};
 f.frames.set(hash(1),{...f.frames.get(hash(1))!,sourceBlockHash:hash(901)});
 await observeNativeRelayBatches(f.input(),{...f.deps,verifyV1:async(_source,_destination,input)=>{verified++;assert.deepEqual(input,proof);return retained;}});
 const recovered=f.records.get(previous.id)!;
 assert.equal(verified,1);assert.equal(recovered.status,"received");assert.deepEqual(recovered.proof,proof);
 assert.equal(recovered.relay?.orderParametersVerified,true);assert.equal(recovered.sourceBlockHash,hash(901));assert.equal(recovered.error,undefined);
});

test("failed v1 signed-order revalidation cannot downgrade a retained job to a received v2 proof",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const prior=f.records.get(`native-source:${hash(1)}`)!;
 f.records.set(prior.id,{...prior,status:"reorg",proof:{version:1,protocol:BASE_BUYBACK_PROTOCOL,sourceHash:hash(1),destinationHash:hash(11),raw:{signature:"bad-order"}}});f.advance();
 await observeNativeRelayBatches(f.input(),{...f.deps,verifyV1:async()=>{throw new Error("Original signed order fails validation");}});
 const current=f.records.get(prior.id)!;assert.equal(current.status,"reorg");assert.equal(current.proof?.version,1);
});

for(const status of ["received","awaiting_buyback","attributed"] as const)test(`ongoing 21-plus foreign dust receipts cannot downgrade an accepted ${status} run`,async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`,accepted=f.records.get(id)!;
 f.records.set(id,{...accepted,status,burnedAmount:"77"});let last=20;
 for(let round=0;round<3;round++){
  for(let n=0;n<25;n++)f.destinations.set(hash(++last),f.frames.get(hash(1))!.metadata);
  f.advance(300_001);const input=f.input();for(const row of input.treasuryEvents)if(row.transactionHash!==hash(11))row.amount="1";
  const durable:BaseFeeBatch[]=[];input.store.saveBuybackBatch=async row=>{durable.push(structuredClone(row));f.records.set(row.id,row);};
  await observeNativeRelayBatches(input,{...f.deps,provider:async(_client,tx)=>tx===hash(11)});
  const current=f.records.get(id)!;assert.equal(current.status,status);assert.equal(current.receivedAmount,"5");assert.equal(current.burnedAmount,"77");assert.deepEqual(current.proof,accepted.proof);
  assert.equal(current.destinationScanAfter,hash(40+round*20));assert.equal(durable.length,21,"Each conclusive candidate commits its own progress before the page finishes");
  assert.ok(durable.every(row=>row.status===status),"No transient write downgrades the accepted run");
 }
});
test("a conclusively authenticated foreign candidate is scheduled once and cannot repeatedly revoke an accepted proof",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`,accepted=f.records.get(id)!;
 f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);let attackerChecks=0;
 // Observer scheduling consumes a conclusive provider result. The independent
 // destination engine tests prove signed roots/funding and distinguish pending;
 // an unsigned/incomplete transaction is never a negative production proof.
 const provider=async(_client:any,tx:Hex)=>{if(tx===hash(11))return true;attackerChecks++;return false;};
 for(let round=0;round<2;round++){f.advance(300_001);await observeNativeRelayBatches(f.input(),{...f.deps,provider});assert.equal(f.records.get(id)!.status,"received");assert.deepEqual(f.records.get(id)!.proof,accepted.proof);}
 assert.equal(attackerChecks,1);assert.equal(f.records.get(id)!.destinationScanAfter,hash(21));
});
test("temporary candidate RPC failure preserves accepted proof and resumes after the last individually committed receipt",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`,accepted=f.records.get(id)!;
 f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);f.destinations.set(hash(22),f.frames.get(hash(1))!.metadata);f.advance(300_001);
 const input=f.input();input.source={getBlock:async()=>({hash:hash(1)})} as any;
 const block=input.destination.getBlock;input.destination.getBlock=async(args:any)=>args.blockNumber===10n?{hash:hash(10),timestamp:1010n} as any:block(args);
 await observeNativeRelayBatches(input,{...f.deps,provider:async(_client,tx)=>{if(tx===hash(22))throw new Error("RPC temporarily unavailable");return tx===hash(11);}});
 let current=f.records.get(id)!;assert.equal(current.status,"received");assert.equal(current.destinationScanAfter,hash(22));assert.deepEqual(current.destinationPendingHashes,[hash(22)]);assert.deepEqual(current.proof,accepted.proof);
 f.advance(300_001);const seen:Hex[]=[];await observeNativeRelayBatches(f.input(),{...f.deps,provider:async(_client,tx)=>{seen.push(tx);return tx===hash(11);}});
 current=f.records.get(id)!;assert.equal(current.status,"received");assert.equal(current.destinationScanAfter,hash(22));assert.equal(current.error,undefined);assert.deepEqual(seen,[hash(11),hash(22)]);
});
test("a temporary source RPC failure does not masquerade as canonical reorg",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`,accepted=f.records.get(id)!;f.advance(300_001);
 const input=f.input();input.source={getBlock:async()=>{throw new Error("source RPC unavailable");}} as any;input.destination.getBlock=async()=>{throw new Error("destination RPC unavailable");};
 await observeNativeRelayBatches(input,{...f.deps,sourceFrame:async()=>{throw new Error("source RPC unavailable");}});
 const current=f.records.get(id)!;assert.equal(current.status,"received");assert.deepEqual(current.proof,accepted.proof);assert.equal(current.receivedAmount,"5");
});
test("confirmed destination hash reorg with unavailable replacement evidence quarantines only that retained batch",async()=>{
 const f=fixture(2);await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`;f.advance(300_001);
 const input=f.input();input.source={getBlock:async({blockNumber}:any)=>({hash:hash(Number(blockNumber))})} as any;
 const block=input.destination.getBlock;input.destination.getBlock=async(args:any)=>args.blockNumber===10n?{hash:hash(999),timestamp:1010n} as any:block(args);
 const verify=f.deps.destinationFrame;
 await observeNativeRelayBatches(input,{...f.deps,destinationFrame:async(client,tx,frame)=>{if(tx===hash(11))throw new Error("replacement canonical proof unavailable");return verify(client,tx,frame);}});
 assert.equal(f.records.get(id)!.status,"reorg");assert.ok(f.records.get(id)!.proof);assert.equal(f.records.get(`native-source:${hash(2)}`)!.status,"received");
});
test("a later authenticated duplicate destination quarantines its batch while foreign or unrelated receipts do not",async()=>{
 const f=fixture(2);await observeNativeRelayBatches(f.input(),f.deps);f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);f.advance(300_001);
 await observeNativeRelayBatches(f.input(),f.deps);
 const current=f.records.get(`native-source:${hash(1)}`)!;assert.equal(current.status,"unknown");assert.match(current.error!,/ambiguous/);assert.ok(current.proof);assert.equal(current.receivedAmount,"5");
 assert.equal(f.records.get(`native-source:${hash(2)}`)!.status,"received");
});
test("direct Treasury dust and canonically identified unrelated request tags do not consume native discovery pages",async()=>{
 const f=fixture();for(let n=21;n<=80;n++)f.destinations.set(hash(n),f.frames.get(hash(1))!.metadata);
 const input=f.input();for(const row of input.treasuryEvents){const n=Number(BigInt(row.transactionHash));if(n>=21&&n<=50)row.from=addr(99);if(n>50)row.nativeRequestMetadata=relayRequestMetadata(hash(n+1000));}
 const receipts:Hex[]=[];const receipt=f.deps.receipt;
 await observeNativeRelayBatches(input,{...f.deps,receipt:async(client,tx)=>{receipts.push(tx);return receipt(client,tx);}});
 assert.deepEqual(receipts,[hash(11)]);assert.equal(f.records.get(`native-source:${hash(1)}`)!.status,"received");
});
for(const status of ["received","awaiting_buyback","attributed"] as const)test(`unavailable seeded provider receipt retains ${status} identity across rounds and recovers when canonical evidence returns`,async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`,accepted=f.records.get(id)!;
 f.records.set(id,{...accepted,status,burnedAmount:"77"});f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);
 const checks:Hex[]=[];
 for(let round=0;round<2;round++){
  f.advance(300_001);
  const provider=async(_client:any,tx:Hex)=>{checks.push(tx);if(round===0)return false;
   const client={getChainId:async()=>4663,getBlockNumber:async()=>100n,getTransactionReceipt:async()=>({status:"success",from:BASE_NATIVE_RELAY_SOLVER,transactionHash:tx,blockNumber:10n,blockHash:hash(10)}),getBlock:async()=>({hash:hash(10)}),
    getTransaction:async()=>{throw new Error("canonical transaction temporarily unavailable");}};
   return nativeDestinationHasFixedProvider(client as any,tx);
  };
  const input=f.input();input.source={getBlock:async()=>({hash:hash(1)})} as any;const block=input.destination.getBlock;input.destination.getBlock=async(args:any)=>args.blockNumber===10n?{hash:hash(10),timestamp:1010n} as any:block(args);
  await observeNativeRelayBatches(input,{...f.deps,provider});
  const current=f.records.get(id)!;assert.equal(current.status,status);assert.equal(current.destinationMatchHash,hash(11));assert.equal(current.destinationHash,hash(11));assert.equal(current.destinationScanAfter,hash(21));
  assert.equal(current.receivedAmount,"5");assert.equal(current.burnedAmount,"77");assert.deepEqual(current.proof,accepted.proof);assert.deepEqual(current.relay,accepted.relay);assert.match(current.error!,/revalidation|transaction\/receipt evidence/);
 }
 assert.deepEqual(checks,[hash(11),hash(21),hash(11)],"Known receipt is retried, while a rejected foreign candidate stays behind the cursor");
 f.advance(300_001);await observeNativeRelayBatches(f.input(),{...f.deps,provider:async(_client,tx)=>tx===hash(11)});
 const recovered=f.records.get(id)!;assert.equal(recovered.status,status);assert.equal(recovered.error,undefined);assert.deepEqual(recovered.proof,accepted.proof);assert.equal(recovered.receivedAmount,"5");assert.equal(recovered.burnedAmount,"77");
});
test("a changed canonical seeded receipt is quarantined even when provider evidence is unsupported, then recovers only with a fresh proof",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`;f.advance(300_001);
 const receipt=f.deps.receipt;const changedReceipt=async(client:any,tx:Hex)=>({...await receipt(client,tx),blockHash:hash(999)});
 await observeNativeRelayBatches(f.input(),{...f.deps,receipt:changedReceipt,provider:async()=>false});
 const held=f.records.get(id)!;assert.equal(held.status,"reorg");assert.equal(held.destinationMatchHash,hash(11));assert.equal(held.relay?.destinationBlockHash,hash(10));
 f.advance();const destinationFrame=f.deps.destinationFrame;
 await observeNativeRelayBatches(f.input(),{...f.deps,receipt:changedReceipt,destinationFrame:async(client,tx,frame)=>({...await destinationFrame(client,tx,frame),destinationBlockHash:hash(999)})});
 const recovered=f.records.get(id)!;assert.equal(recovered.status,"received");assert.equal(recovered.relay?.destinationBlockHash,hash(999));assert.equal(recovered.destinationMatchHash,hash(11));assert.equal(recovered.error,undefined);
});
test("retained accepted v1 proof rehydrates missing discovery cache without losing its receipt on unavailable canonical provider receipts",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`,row=f.records.get(id)!;
 const relay={...row.relay!,version:1 as const,orderParametersVerified:true},proof={version:1 as const,protocol:BASE_BUYBACK_PROTOCOL as typeof BASE_BUYBACK_PROTOCOL,sourceHash:hash(1),destinationHash:hash(11),raw:{signature:"retained-native-order"}};
 f.records.set(id,{...row,relay,proof,sourceBlockHash:undefined,destinationMatchHash:undefined,destinationScanAfter:undefined,destinationFromBlock:undefined,destinationFromBlockHash:undefined});f.advance(300_001);
 await observeNativeRelayBatches(f.input(),{...f.deps,provider:async()=>false});
 const held=f.records.get(id)!;assert.equal(held.status,"received");assert.equal(held.destinationMatchHash,hash(11));assert.deepEqual(held.proof,proof);assert.deepEqual(held.relay,relay);
 f.advance(300_001);let v1Reads=0;await observeNativeRelayBatches(f.input(),{...f.deps,verifyV1:async()=>{v1Reads++;return relay;}});
 const recovered=f.records.get(id)!;assert.equal(v1Reads,1);assert.equal(recovered.status,"received");assert.deepEqual(recovered.proof,proof);assert.equal(recovered.relay?.orderParametersVerified,true);assert.equal(recovered.error,undefined);
});
test("a new complete canonical proof is independent of another pending candidate and only authenticated duplication withholds it",async()=>{
 const f=fixture();f.destinations.set(hash(21),f.frames.get(hash(1))!.metadata);const seen:Hex[]=[];let recovered=false;
 const provider=async(_client:any,tx:Hex)=>{seen.push(tx);if(tx===hash(21))return true;if(!recovered)throw new NativeDestinationProviderPendingError("Fake positive solver Transfer is not authenticated");return true;};
 await observeNativeRelayBatches(f.input(),{...f.deps,provider});let row=f.records.get(`native-source:${hash(1)}`)!;
 assert.equal(row.status,"received");assert.equal(row.proof?.destinationHash,hash(21));assert.equal(row.receivedAmount,"5");assert.deepEqual(row.destinationPendingHashes,[hash(11)]);assert.equal(row.nativeRetryAfter!-row.updatedAt,30000);
 assert.deepEqual(seen,[hash(11),hash(21)]);f.advance();await observeNativeRelayBatches(f.input(),{...f.deps,provider});row=f.records.get(row.id)!;
 assert.equal(row.status,"received");assert.equal(row.proof?.destinationHash,hash(21));assert.deepEqual(row.destinationPendingHashes,[hash(11)]);assert.equal(row.nativeRetryAfter!-row.updatedAt,60000);
 recovered=true;f.advance(60001);await observeNativeRelayBatches(f.input(),{...f.deps,provider});row=f.records.get(row.id)!;
 assert.equal(row.status,"unknown");assert.match(row.error!,/ambiguous/);assert.equal(row.proof?.destinationHash,hash(21),"Conflict preserves recovery identity; it does not erase canonical evidence");
});
test("alias persistence failure is local, diagnosable, and cannot expose infrastructure exception secrets",async(t)=>{
 const diagnostics:unknown[][]=[];t.mock.method(console,"warn",(...args:unknown[])=>diagnostics.push(args));
 const f=fixture(2),input=f.input();input.sourceEvents=input.sourceEvents.slice(0,1);input.treasuryEvents=input.treasuryEvents.slice(0,1);await observeNativeRelayBatches(input,f.deps);
 const first=f.records.get(`native-source:${hash(1)}`)!;f.records.set("retained-alias",{...first,id:"retained-alias",status:"received",updatedAt:1});f.advance(300_001);
 const next=f.input(),save=next.store.saveBuybackBatch;next.store.saveBuybackBatch=async row=>{if(row.id==="retained-alias")throw new Error("https://private-provider.example/v2/secret-api-key database-password");return save(row);};
 await assert.doesNotReject(()=>observeNativeRelayBatches(next,f.deps));assert.equal(f.records.get(first.id)!.status,"received");assert.equal(f.records.get(`native-source:${hash(2)}`)!.status,"received");
 assert.deepEqual(diagnostics,[["native_observation_persistence_unavailable",hash(1)]]);assert.equal(JSON.stringify(diagnostics).includes("secret-api-key"),false);
});

test("capture rotates more than its 512 scheduling entries without discarding independent verified code facts",async()=>{
 const rows=new Map<string,any>(),factsId=`internal_native_destination_code:${hash(900)}`,seen=new Set<Hex>();rows.set(factsId,{id:factsId,protocol:"internal_native_destination_code_v1",facts:["retained"]});
 const auditStore={getBuybackBatch:async(id:string)=>structuredClone(rows.get(id)??null),compareAndSetBuybackAudit:async(row:any,expected:any)=>{assert.deepEqual(rows.get(row.id)??null,expected);rows.set(row.id,structuredClone(row));return true;}};
 const treasuryEvents=Array.from({length:520},(_,i)=>event(i+1000,"in")),destination={getBlockNumber:async()=>100n} as any;
 for(let turn=0;turn<65;turn++){let calls=0;await captureNativeRelayDestinations({destination,collector,treasuryEvents,batches:[],deadline:Infinity,auditStore},{provider:async(_client,tx)=>{calls++;seen.add(tx);return false;}});assert.equal(calls,8);}
 assert.equal(seen.size,520);const schedule=[...rows.values()].find(row=>row.protocol==="internal_native_destination_capture_v1")!;assert.equal(schedule.entries.length,512);
 assert.deepEqual(rows.get(factsId).facts,["retained"]);assert.equal(treasuryEvents.length,520,"All canonical events remain available for later pages");
});
test("capture prioritizes a newly known request while old unseen candidates keep their fair share",async()=>{
 const f=fixture(),rows=new Map<string,any>(),seen:Hex[]=[];let now=1000;
 const auditStore={getBuybackBatch:async(id:string)=>structuredClone(rows.get(id)??null),compareAndSetBuybackAudit:async(row:any)=>{rows.set(row.id,structuredClone(row));return true;}};
 const old=Array.from({length:64},(_,i)=>event(i+1000,"in")),events=[...old],batches=[{requestId:hash(101)} as BaseFeeBatch];
 for(let turn=0;turn<16;turn++){const recent=event(3000+turn,"in");recent.nativeRequestMetadata=relayRequestMetadata(hash(101));events.push(recent);const before=seen.length;
  await captureNativeRelayDestinations({destination:f.input().destination,collector,treasuryEvents:events,batches,deadline:Infinity,auditStore,now:()=>now},{provider:async(_client,tx)=>{seen.push(tx);if(tx===recent.transactionHash)throw new NativeDestinationProviderPendingError();return false;}});
  assert(seen.slice(before).includes(recent.transactionHash),"A legitimate new tag is not trapped behind old dust or source backoff");now+=120001;
 }
 assert(old.every(row=>seen.includes(row.transactionHash)));const schedule=[...rows.values()].find(row=>row.protocol==="internal_native_destination_capture_v1")!;
 assert(schedule.entries.filter((row:any)=>!row.complete).every((row:any)=>row.retryAfter<=schedule.updatedAt+120000));
});

function fullPendingFixture(){
 const f=fixture();f.destinations.clear();const tag=f.frames.get(hash(1))!.metadata;
 for(let tx=1000;tx<1512;tx++)f.destinations.set(hash(tx),tag);
 const pending=Array.from(f.destinations.keys());
 f.records.set(`native-source:${hash(1)}`,{id:`native-source:${hash(1)}`,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,collector,kind:"native_relay",status:"bridging",createdAt:1,updatedAt:1,
  amountIn:"50",receivedAmount:"0",refundedAmount:"0",burnedAmount:"0",claimHashes:[],sourceHash:hash(1),sourceBlockNumber:"1",sourceBlockHash:hash(1),requestId:f.frames.get(hash(1))!.requestId,
  destinationFromBlock:"1",destinationFromBlockHash:hash(501),destinationScanAfter:pending.at(-1),destinationPendingHashes:pending});
 return{...f,tag,pending};
}
test("R9 a full 512 pending queue cannot veto a newly complete healthy arrival before the first proof exists",async()=>{
 const f=fullPendingFixture(),seen:Hex[]=[];f.destinations.set(hash(2000),f.tag);
 await observeNativeRelayBatches(f.input(),{...f.deps,provider:async(_client,tx)=>{seen.push(tx);if(tx===hash(2000))return true;throw new NativeDestinationProviderPendingError("Unverified hint");}});
 const row=f.records.get(`native-source:${hash(1)}`)!;assert.equal(row.status,"received");assert.equal(row.proof?.destinationHash,hash(2000));assert.equal(row.receivedAmount,"5");assert.equal(row.destinationPendingHashes?.length,512);assert(seen.length<=20);assert(seen.includes(hash(2000)));
});

test("R9 old overflow revisits a recovered real fill despite continued new pending arrivals and rejects a real duplicate",async()=>{
 const f=fullPendingFixture(),old=Array.from({length:8},(_,i)=>hash(6000+i));for(const tx of old)f.destinations.set(tx,f.tag);let healthy:Hex|undefined,duplicate:Hex|undefined;
 const seen:Hex[]=[];const provider=async(_client:any,tx:Hex)=>{seen.push(tx);if(tx===healthy||tx===duplicate)return true;throw new NativeDestinationProviderPendingError("Temporary or unverified candidate");};
 await observeNativeRelayBatches(f.input(),{...f.deps,provider});let row=f.records.get(`native-source:${hash(1)}`)!;assert.equal(row.destinationOverflowFrom,old[0]);assert.equal(row.destinationPendingHashes?.length,512);
 for(let turn=0;turn<5&&row.status!=="received";turn++){
  for(let index=0;index<16;index++)f.destinations.set(hash(7000+turn*16+index),f.tag);f.advance(120001);const before=seen.length;await observeNativeRelayBatches(f.input(),{...f.deps,provider});assert(seen.length-before<=20);row=f.records.get(row.id)!;
  if(turn===0){assert(seen.slice(before).includes(old[0]));healthy=old[0];}
 }
 assert.equal(row.status,"received");assert.equal(row.proof?.destinationHash,old[0]);assert.equal(row.receivedAmount,"5");assert.equal(row.destinationPendingHashes?.length,512,"Unknown hints remain scheduled instead of being declared foreign");
 duplicate=hash(9000);f.destinations.set(duplicate,f.tag);f.advance(120001);await observeNativeRelayBatches(f.input(),{...f.deps,provider});row=f.records.get(row.id)!;
 assert.equal(row.status,"unknown");assert.match(row.error!,/ambiguous/);assert.equal(row.proof?.destinationHash,old[0]);
});
test("R9 removed canonical overflow markers reset discovery rather than silently dropping remaining candidates",async()=>{
 const f=fullPendingFixture();for(let tx=6000;tx<6004;tx++)f.destinations.set(hash(tx),f.tag);
 await observeNativeRelayBatches(f.input(),{...f.deps,provider:async()=>{throw new NativeDestinationProviderPendingError();}});
 let row=f.records.get(`native-source:${hash(1)}`)!;assert.equal(row.destinationOverflowFrom,hash(6000));f.destinations.delete(hash(6000));f.advance(120001);
 await observeNativeRelayBatches(f.input(),{...f.deps,provider:async()=>false});row=f.records.get(row.id)!;
 assert.equal(row.destinationOverflowFrom,undefined);assert.equal(row.destinationOverflowAfter,undefined);assert.equal(row.destinationOverflowThrough,undefined);assert.equal(row.proof,undefined);assert.equal(row.receivedAmount,"0");
 assert.equal(row.destinationScanAfter,hash(1015),"A missing canonical marker restarts at the complete journal, not at the end of the lost range");
});
test("R9 quiet finalized discovery builds first-transaction positions once with bounded event reads",async()=>{
 const f=fixture();await observeNativeRelayBatches(f.input(),f.deps);const id=`native-source:${hash(1)}`,row=f.records.get(id)!;
 f.records.set(id,{...row,sourceFinalized:true,destinationScanAfter:hash(10999)});f.advance(300001);
 const events=[event(11,"in"),...Array.from({length:10000},(_,i)=>event(i+1000,"in"))];let eventReads=0;
 const counted=new Proxy(events,{get(target,key,receiver){if(typeof key==="string"&&/^\d+$/.test(key))eventReads++;return Reflect.get(target,key,receiver);}});
 await observeNativeRelayBatches({...f.input(),treasuryEvents:counted},f.deps);
 assert.equal(f.calls.length,1);assert(eventReads<=events.length*4,`A quiet finalized run used ${eventReads} event reads for ${events.length} events`);
});
