import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex } from "viem";
import { readBaseAudit } from "../server/base-audit";
import { Store } from "../server/store";
import { baseOperatorAuditStore, boundedBaseOperatorAudit } from "../scripts/base-audit-store";

const id = `internal_native_releases:0x${"01".repeat(32)}`;
const hash = (n: bigint): Hex => `0x${n.toString(16).padStart(64,"0")}`;
type Row = { blockNumber: string; value: string };
const validate = (value: unknown): value is Row => !!value && typeof value === "object" && typeof (value as Row).value === "string";
const row = (blockNumber: bigint, value: string): Row => ({blockNumber:String(blockNumber),value});
const client = (finalized = 1_000n) => ({getChainId: async()=>8453, getBlock: async(input:any)=>{
  const number = input.blockNumber ?? finalized; return {number, hash:hash(number)};
}} as any);

test("canonical audit resumes complete pages across cold clients and preserves progress through a failed page", async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-")),store=new Store(directory,31337),ranges:bigint[]=[];
 let clock=0;
 const page=async(from:bigint,to:bigint)=>{ranges.push(from);clock+=5000;return [row(from,`${from}-${to}`)];};
 const budget={now:()=>clock,maxDurationMs:9000};
 try{
  await assert.rejects(()=>readBaseAudit({client:client(),store,id,from:1n,to:1000n,validate,page,...budget}),/coverage is incomplete/);
  assert.equal(store.getBuybackBatch(id)?.through,"400");
  await assert.rejects(()=>readBaseAudit({client:client(),store,id,from:1n,to:1000n,validate,page:async()=>{throw new Error("RPC unavailable");},...budget}),/RPC unavailable/);
  assert.equal(store.getBuybackBatch(id)?.through,"400");
  await assert.rejects(()=>readBaseAudit({client:client(),store,id,from:1n,to:1000n,validate,page,...budget}),/coverage is incomplete/);
  assert.deepEqual(await readBaseAudit({client:client(),store,id,from:1n,to:1000n,validate,page,...budget}),[row(1n,"1-200"),row(201n,"201-400"),row(401n,"401-600"),row(601n,"601-800"),row(801n,"801-1000")]);
  assert.deepEqual(ranges,[1n,201n,401n,601n,801n]);
  await assert.rejects(()=>readBaseAudit({client:client(),store,id,from:1n,to:500n,validate,page}),/behind retained canonical progress/);
  assert.equal(store.getBuybackBatch(id)?.through,"1000");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("two cold audit clients cannot replace a complete high prefix with late lower progress", async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-race-")),store=new Store(directory,31337);
 let entered!:()=>void, resume!:()=>void;
 const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),pause=new Promise<void>(resolve=>{resume=resolve;});
 try{
  const low=readBaseAudit({client:client(),store,id,from:1n,to:5n,validate,page:async()=>{entered();await pause;return [row(5n,"lower")];}});
  const rejected=assert.rejects(low,/changed concurrently/);
  await enteredPromise;
  assert.deepEqual(await readBaseAudit({client:client(),store,id,from:1n,to:10n,validate,page:async()=>[row(8n,"higher including owner release at 8")]}),[row(8n,"higher including owner release at 8")]);
  resume();await rejected;
  assert.equal(store.getBuybackBatch(id)?.through,"10");
  await assert.rejects(()=>readBaseAudit({client:client(),store,id,from:1n,to:7n,validate,page:async()=>[]}),/behind retained canonical progress/);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("audit reorg replays only the provisional suffix of a valid finalized prefix", async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-reorg-")),store=new Store(directory,31337);
 try{
  await readBaseAudit({client:client(200n),store,id,from:1n,to:400n,validate,page:async(from,to)=>[row(from,`${from}-${to}`)]});
  const reorgClient=client(200n),original=reorgClient.getBlock,ranges:bigint[]=[];
  reorgClient.getBlock=async(input:any)=>{const block=await original(input);return block.number>200n?{...block,hash:hash(block.number+1000n)}:block;};
  assert.deepEqual(await readBaseAudit({client:reorgClient,store,id,from:1n,to:400n,validate,page:async(from,to)=>{ranges.push(from);return [row(from,`new-${from}-${to}`)];}}),[row(1n,"1-200"),row(201n,"new-201-400")]);
  assert.deepEqual(ranges,[201n]);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("private operator audit CAS survives restart and rejects stale writes and foreign identities", async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-operator-audit-")),first=baseOperatorAuditStore(directory),second=baseOperatorAuditStore(directory);
 const row={id,protocol:"internal_native_base_audit_v1",through:"0"},higher={...row,through:"10"};
 try{
  assert.equal(await first.compareAndSetBuybackAudit(row,null),true);
  const expected=await second.getBuybackBatch(id);
  assert.equal(await first.compareAndSetBuybackAudit(higher,row),true);
  assert.equal(await second.compareAndSetBuybackAudit({...row,through:"5"},expected),false);
  assert.deepEqual(await baseOperatorAuditStore(directory).getBuybackBatch(id),higher);
  await assert.rejects(async()=>first.compareAndSetBuybackAudit({...row,id:"../escape"},null),/identity/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test("a cold canonical audit covers more than two pages in one time budget",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-time-")),store=new Store(directory,31337),ranges:bigint[]=[];
 let clock=0;
 try{
  const result=await readBaseAudit({client:client(3000n),store,id,from:1n,to:3000n,validate,now:()=>clock,maxDurationMs:9000,
   page:async(from,to)=>{ranges.push(from);clock+=500;return [row(from,`${from}-${to}`)];}});
  assert.equal(ranges.length,15);assert.equal(result.length,15);assert.equal(clock,7500);assert.equal(store.getBuybackBatch(id)?.through,"3000");
  assert.equal(store.getBuybackBatch(id)?.version,2);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("3000 steady tip updates promote finality, so a three-block reorg recovers coverage in the next call",async()=>{
 let stored:any=null,head=1000n,reorgFrom:bigint|undefined;
 const store={getBuybackBatch:async()=>structuredClone(stored),compareAndSetBuybackAudit:async(next:any,expected:any)=>{
  if(JSON.stringify(stored)!==JSON.stringify(expected))return false;stored=structuredClone(next);return true;}};
 const rpc={getChainId:async()=>8453,getBlock:async(input:any)=>{
  const number=input.blockNumber??(input.blockTag==="finalized"?head-64n:head);
  return{number,hash:hash(number+(reorgFrom!==undefined&&number>=reorgFrom?1_000_000n:0n))};}} as any;
 const ranges:{from:bigint;to:bigint}[]=[];
 const page=async(from:bigint,to:bigint)=>{
  ranges.push({from,to});const rows:Row[]=[];
  if(from<=1000n&&to>=1000n)rows.push(row(1000n,"stable fee release"));
  if(from<=180999n&&to>=180999n)rows.push(row(180999n,reorgFrom===undefined?"old tip release":"new canonical release"));
  return rows;
 };
 await readBaseAudit({client:rpc,store,id,from:1n,to:head,validate,page});
 for(let update=0;update<3000;update++){head+=60n;await readBaseAudit({client:rpc,store,id,from:1n,to:head,validate,page});}
 assert.equal(head,181000n);assert.equal(stored.finalized.through,String(head-64n));assert.equal(stored.entries.length,2);
 const priorPrefix=BigInt(stored.finalized.through);reorgFrom=head-2n;ranges.length=0;
 const recovered=await readBaseAudit({client:rpc,store,id,from:1n,to:head,validate,page});
 assert.deepEqual(ranges,[{from:priorPrefix+1n,to:head}],"Only the 64-block provisional suffix is re-read, with no incomplete-coverage turns");
 assert.deepEqual(recovered,[row(1000n,"stable fee release"),row(180999n,"new canonical release")]);assert.equal(stored.through,String(head));
 ranges.length=0;head+=60n;await readBaseAudit({client:rpc,store,id,from:1n,to:head,validate,page});assert.equal(stored.finalized.through,String(head-64n));
});

test("finalized prefixes advance on cache hits, old v1 progress safely rescans, and invalid entry blocks never commit",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-upgrade-")),store=new Store(directory,31337);
 try{
  await readBaseAudit({client:client(10n),store,id,from:1n,to:100n,validate,page:async()=>[row(50n,"release")]});
  assert.equal((store.getBuybackBatch(id)?.finalized as any).through,"10");
  await readBaseAudit({client:client(90n),store,id,from:1n,to:100n,validate,page:async()=>{throw new Error("A cache hit needs no history scan");}});
  assert.equal((store.getBuybackBatch(id)?.finalized as any).through,"90");
  const old={...store.getBuybackBatch(id)!,version:1,entries:[{value:"v1 has no block metadata"}],finalized:{through:"90",hash:hash(90n),entries:[]}};
  store.saveBuybackBatch(old);const ranges:bigint[]=[];
  await assert.rejects(()=>readBaseAudit({client:client(90n),store,id,from:1n,to:99n,validate,page:async()=>[]}),/behind retained/);
  assert.deepEqual(store.getBuybackBatch(id),old,"An upgrade cannot discard a newer high watermark through a lagging provider");
  await readBaseAudit({client:client(90n),store,id,from:1n,to:100n,validate,page:async(from)=>{ranges.push(from);return[row(50n,"canonical release")];}});
  assert.deepEqual(ranges,[1n]);assert.equal(store.getBuybackBatch(id)?.version,2);
  const retained=structuredClone(store.getBuybackBatch(id));
  await assert.rejects(()=>readBaseAudit({client:client(90n),store,id,from:1n,to:101n,validate,page:async()=>[row(102n,"outside page")]}),/page changed/);
  assert.deepEqual(store.getBuybackBatch(id),retained);
  const inconsistent=client(90n),original=inconsistent.getBlock;
  inconsistent.getBlock=async(input:any)=>input.blockTag==="finalized"?{number:90n,hash:hash(9000n)}:original(input);
  await assert.rejects(()=>readBaseAudit({client:inconsistent,store,id,from:1n,to:100n,validate,page:async()=>[]}),/finalized block changed/);
  assert.deepEqual(store.getBuybackBatch(id),retained,"A finalized tag and its by-number hash must agree before promotion");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("corrupt partial astronomical audit watermarks rescan while complete current and legacy higher progress remains intact",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-partial-watermark-")),store=new Store(directory,31337),ranges:bigint[]=[];
 const page=async(from:bigint)=>{ranges.push(from);return[row(from,"canonical release")];};
 try{
  for(const broken of [
   {id,protocol:"internal_native_base_audit_v1",through:"9".repeat(100)},
   {id,protocol:"internal_native_base_audit_v1",version:2,first:"1",through:"1000",hash:hash(1000n),entries:"damaged"},
   {id,protocol:"internal_native_base_audit_v1",version:1,first:"1",through:"1000",hash:"not a block hash",entries:[]},
  ]){
   store.saveBuybackBatch(broken);ranges.length=0;
   assert.deepEqual(await readBaseAudit({client:client(90n),store,id,from:1n,to:100n,validate,page}),[row(1n,"canonical release")]);
   assert.deepEqual(ranges,[1n]);assert.equal(store.getBuybackBatch(id)?.through,"100");
  }
  const complete=structuredClone(store.getBuybackBatch(id)!);
  for(const retained of [complete,{...complete,version:1,entries:[{value:"legacy canonical release"}],finalized:{through:"90",hash:hash(90n),entries:[]}}]){
   store.saveBuybackBatch(retained);ranges.length=0;
   await assert.rejects(()=>readBaseAudit({client:client(80n),store,id,from:1n,to:99n,validate,page}),/behind retained/);
   assert.equal(ranges.length,0);assert.deepEqual(store.getBuybackBatch(id),retained,"A well-formed higher watermark survives a lagging RPC, including old schemas awaiting upgrade");
  }
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("private audit corruption and expired or dead restored cache locks recover without bypassing a live writer",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-corrupt-")),store=baseOperatorAuditStore(directory);
 const path=join(directory,`${id.replace(":","-")}.json`),lock=`${path}.lock`,cacheRow={id,protocol:"internal_native_base_audit_v1",through:"10"};
 try{
  writeFileSync(path,"{interrupted cache");assert.equal(await store.getBuybackBatch(id),null);
  writeFileSync(lock,JSON.stringify({pid:process.pid,host:"restored-foreign-runner",acquiredAt:Date.now()-20_000}));
  assert.equal(await store.compareAndSetBuybackAudit(cacheRow,null),true);assert.deepEqual(JSON.parse(readFileSync(path,"utf8")),cacheRow);
  writeFileSync(lock,JSON.stringify({pid:2_000_000_000,host:hostname(),processStart:"dead",acquiredAt:Date.now()}));
  assert.equal(await store.compareAndSetBuybackAudit({...cacheRow,through:"20"},cacheRow),true,"A demonstrably dead local process needs no extra lease wait");
  writeFileSync(lock,"{damaged lock");const stale=new Date(Date.now()-20_000);utimesSync(lock,stale,stale);
  const current={...cacheRow,through:"20"};assert.equal(await store.compareAndSetBuybackAudit({...cacheRow,through:"30"},current),true);
  for(const processStart of [undefined,null]){
   writeFileSync(lock,JSON.stringify({token:"restored-pid-collision",pid:process.pid,host:hostname(),processStart,acquiredAt:Date.now()-20_000}));
   assert.equal(await store.compareAndSetBuybackAudit({...cacheRow,through:"30"},{...cacheRow,through:"30"}),true,"An expired cache lock needs matching start identity, not only a reused live PID");
  }
  const start=execFileSync("ps",["-p",String(process.pid),"-o","lstart="],{encoding:"utf8"}).trim();
  writeFileSync(lock,JSON.stringify({token:"live",pid:process.pid,host:hostname(),processStart:start,acquiredAt:Date.now()-60_000}));
  await assert.rejects(async()=>store.compareAndSetBuybackAudit({...cacheRow,through:"40"},{...cacheRow,through:"30"}),/busy/);
  assert.equal(JSON.parse(readFileSync(lock,"utf8")).token,"live");assert.equal((await store.getBuybackBatch(id))?.through,"30");unlinkSync(lock);
  writeFileSync(path,"[]");assert.equal(await store.getBuybackBatch(id),null,"Malformed JSON shapes are disposable cache, not financial records");
  const complete=await readBaseAudit({client:client(3000n),store,id,from:1n,to:3000n,validate,page:async(from)=>[row(from,"revalidated")]});
  assert.equal(complete.length,15);assert.equal((await store.getBuybackBatch(id))?.through,"3000");
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test("operator warming retries only exact incomplete coverage with durable progress and preserves CAS on concurrent writers",async context=>{
 const directory=mkdtempSync(join(tmpdir(),"base-audit-warm-")),store=baseOperatorAuditStore(directory);
 const initial={id,protocol:"internal_native_base_audit_v1",through:"0"};let clock=0,calls=0;
 context.mock.method(Date,"now",()=>clock);
 try{
  const result=await boundedBaseOperatorAudit(async tracked=>{
   calls++;const expected=await tracked.getBuybackBatch(id),next={...initial,through:String(calls*400)};
   assert.equal(await tracked.compareAndSetBuybackAudit(next,expected),true);
   if(calls<3)throw new Error("Canonical Base audit coverage is incomplete; persisted progress will resume");return "complete";
  },store,60_000);
  assert.equal(result,"complete");assert.equal(calls,3);
  for(const message of ["RPC unavailable","Canonical Base audit coverage is incomplete; persisted progress will resume"]){
   calls=0;await assert.rejects(()=>boundedBaseOperatorAudit(async()=>{calls++;throw new Error(message);},store),new RegExp(message));assert.equal(calls,1);
  }
  await assert.rejects(()=>boundedBaseOperatorAudit(async tracked=>{
   const expected=await tracked.getBuybackBatch(id);assert.equal(await tracked.compareAndSetBuybackAudit({...initial,through:"1600"},expected),true);clock=60_000;
   throw new Error("Canonical Base audit coverage is incomplete; persisted progress will resume");
  },store),/budget reached/);assert.equal((await store.getBuybackBatch(id))?.through,"1600");
  const expected=await store.getBuybackBatch(id),other=baseOperatorAuditStore(directory);
  const outcomes=await Promise.all([store.compareAndSetBuybackAudit({...initial,through:"3000"},expected),other.compareAndSetBuybackAudit({...initial,through:"2000"},expected)]);
  assert.deepEqual(outcomes,[true,false]);assert.equal((await store.getBuybackBatch(id))?.through,"3000");
 }finally{rmSync(directory,{recursive:true,force:true});}
});
