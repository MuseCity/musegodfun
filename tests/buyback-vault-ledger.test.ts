import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { Store } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
import { VaultLedgerService } from "../server/buyback-vault-ledger";
import { replayVaultLedger, vaultEventId, type VaultBaseFillEvidence, type VaultLedgerBlock, type VaultLedgerCommit, type VaultLedgerEvent, type VaultLedgerState } from "../src/lib/buyback-vault-ledger";
const addr = (n: number) => `0x${n.toString(16).padStart(40,"0")}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64,"0")}` as Hex;
const vault=addr(1),weth=addr(2),swapper=addr(3),caller=addr(4),source=addr(5);
const block=(number:number,branch=0):VaultLedgerBlock=>({number:String(number),hash:hash(number+100+branch),parentHash:hash(number+99+branch)});
function state(balance="0",spent="0",burned="0"):VaultLedgerState {
  return {version:1,chainId:4663,vault,weth,swapper,revision:1,checkpoint:{...block(0),wethBalance:"0",totalSpent:"0",totalBurned:"0",establishedAt:0},
    cursor:block(1),observedBalance:balance,observedTotalSpent:spent,observedTotalBurned:burned,updatedAt:1,blockedReason:null};
}
const position=(tx:number,index:number,transactionIndex=tx)=>({id:vaultEventId(hash(tx),index),blockNumber:"1",blockHash:block(1).hash,transactionHash:hash(tx),transactionIndex,logIndex:index});
const funding=(tx:number,amount:string,sourceKind:"unknown"|"robinhood_engine"|"base"="unknown",batchId=`base-${tx}`):VaultLedgerEvent=>{
  const event:VaultLedgerEvent={...position(tx,tx*10),kind:"weth_in",from:source,to:vault,amount,source:sourceKind};
  if(sourceKind==="base")event.baseFill={batchId,sourceChainId:8453,destinationChainId:4663,sourceTransactionHash:hash(tx+500),sourceBlockHash:hash(tx+600),depositId:String(tx),fillTransactionHash:event.transactionHash,fillBlockHash:event.blockHash,fillLogIndex:event.logIndex+1,recipient:vault,outputToken:weth,outputAmount:amount};
  return event;
};
const execute=(tx:number,amount:string,muse:string,profit="0"):VaultLedgerEvent[]=>[
  {...position(tx,tx*10),kind:"weth_out",from:vault,to:swapper,amount},
  {...position(tx,tx*10+1),kind:"executed",caller,wethAmount:amount,museToDead:muse,profit},
];

test("mixed canonical funding uses FIFO, tracks partial batches and excludes caller profit from burn",()=>{
  const checkpoint=state("3","9","101");checkpoint.checkpoint.wethBalance="3";
  const events=[funding(1,"4","base","A"),funding(2,"2","robinhood_engine"),funding(3,"3","base","B"),...execute(4,"5","50","9"),...execute(5,"4","51","7")];
  const report=replayVaultLedger(checkpoint,events.reverse(),1n);
  assert.equal(report.attributionReady,true);
  assert.equal(report.baseReceivedWeth,"7");assert.equal(report.baseSpentWeth,"4");assert.equal(report.basePendingWeth,"3");
  assert.equal(report.baseAttributedMuseToDead,"45");assert.equal(report.totalMuseToDead,"101");assert.equal(report.totalCallerProfit,"16");
  assert.deepEqual(report.batches,[{batchId:"A",receivedWeth:"4",spentWeth:"4",pendingWeth:"0",attributedMuseToDead:"45",status:"consumed"},
    {batchId:"B",receivedWeth:"3",spentWeth:"0",pendingWeth:"3",attributedMuseToDead:"0",status:"pending_vault"}]);
  assert.equal(report.lots[0].source,"unknown","Opening legacy balance has no assumed Base source");
  const allocations=report.allocations.reduce((sum,a)=>sum+BigInt(a.museToDead),0n);assert.equal(allocations,101n);
});
test("same-block transaction/log order and integer remainder allocate each burn unit once",()=>{
  const events=[funding(1,"1","base","A"),funding(2,"1"),funding(3,"1","base","B"),...execute(4,"3","5","100")];
  const report=replayVaultLedger(state("0","3","5"),events,1n);
  assert.equal(report.attributionReady,true);assert.equal(report.baseAttributedMuseToDead,"3");
  assert.deepEqual(report.allocations.map(a=>a.museToDead),["1","2","2"]);
  assert.equal(report.allocations.reduce((s,a)=>s+BigInt(a.wethAmount),0n),3n,"WETH out and Executed do not debit twice");
  assert.equal(report.totalCallerProfit,"100");
  assert.deepEqual(replayVaultLedger(state("0","3","5"),[...events].reverse(),1n),report);
});
test("new blocks retain verified indexed attribution while unknown shortfall, unmatched outflow and observed mismatch withhold it",()=>{
  const events=[funding(1,"3","base"),...execute(2,"3","5")];
  const lagged=replayVaultLedger(state("0","3","5"),events,2n);
  assert.equal(lagged.caughtUp,false);assert.equal(lagged.indexedThrough,"1");assert.equal(lagged.confirmedThrough,"2");
  assert.equal(lagged.attributionReady,true);assert.equal(lagged.baseAttributedMuseToDead,"5");assert.equal(lagged.reason,null);
  const shortfall=replayVaultLedger(state("0","4","5"),[funding(1,"3","base"),...execute(2,"4","5")],1n);
  assert.match(shortfall.reason!,/shortfall/);assert.equal(shortfall.baseAttributedMuseToDead,"0");assert.deepEqual(shortfall.allocations,[]);
  const out=execute(2,"3","5")[0];assert.match(replayVaultLedger(state("0","0","0"),[funding(1,"3","base"),out],1n).reason!,/Unmatched/);
  assert.match(replayVaultLedger(state("1","3","5"),events,1n).reason!,/reconcile/);
  assert.throws(()=>replayVaultLedger(state(),[funding(1,"1"),funding(1,"1")],1n),/Duplicate/);
});

test("SQLite persists the complete >1000-event journal, CAS, classification, rollback and backup restore",()=>{
  const directory=mkdtempSync(join(tmpdir(),"vault-ledger-")),restoredDirectory=mkdtempSync(join(tmpdir(),"vault-ledger-restore-"));
  let store=new Store(directory,31337);let restored:Store|undefined;let concurrent:Store|undefined;
  try{
    const initial=state("1201");const events=Array.from({length:1201},(_,i)=>funding(i+1,"1"));
    store.commitVaultLedger({expectedRevision:0,state:initial,blocks:[block(0),block(1)],events});
    const all:VaultLedgerEvent[]=[];let after;
    for(;;){const page=store.vaultLedgerEventPage(97,after);all.push(...page);if(page.length<97)break;after=page.at(-1)!;}
    assert.equal(all.length,1201);assert.equal(all.at(-1)!.id,events.at(-1)!.id);
    store.close();store=new Store(directory,31337);assert.deepEqual(store.vaultLedgerState(),initial);
    assert.throws(()=>store.commitVaultLedger({expectedRevision:0,state:initial,blocks:[],events:[]}),/revision changed/);
    const evidence=(funding(1,"1","base") as VaultLedgerEvent&{kind:"weth_in"}).baseFill!;
    const classified={...initial,revision:2};store.commitVaultLedger({expectedRevision:1,state:classified,blocks:[],events:[],classifications:[{eventId:events[0].id,source:"base",baseFill:evidence}]});
    assert.equal(store.vaultLedgerEventPage(1)[0].kind,"weth_in");
    assert.throws(()=>store.commitVaultLedger({expectedRevision:2,state:{...classified,revision:3},blocks:[],events:[],classifications:[{eventId:events[1].id,source:"base",baseFill:evidence}]}),/fill evidence/);
    concurrent=new Store(directory,31337);
    const next={...classified,revision:3};store.commitVaultLedger({expectedRevision:2,state:next,blocks:[],events:[]});
    assert.throws(()=>concurrent!.commitVaultLedger({expectedRevision:2,state:next,blocks:[],events:[]}),/revision changed/);
    store.updateRuntimeControl(false,"isolated fixture",0);
    const backup=JSON.parse(JSON.stringify(store.backup()));restored=new Store(restoredDirectory,31337);restored.restore(backup);
    assert.deepEqual(restored.vaultLedgerState(),next);assert.equal(restored.runtimeControl().paused,false);
    assert.equal(restored.vaultLedgerEventPage(1000).length,1000);
    assert.equal(restored.vaultLedgerEventPage(1000,restored.vaultLedgerEventPage(1000).at(-1)).length,201);
    assert.throws(()=>restored!.restore(backup),/not empty/);
    const rollback={...next,cursor:block(0),observedBalance:"0",revision:4};
    store.commitVaultLedger({expectedRevision:3,state:rollback,blocks:[],events:[],rollbackAfterBlock:"0"});
    assert.deepEqual(store.vaultLedgerEventPage(),[]);assert.equal(store.vaultLedgerBlockPage().length,1);
    assert.equal(restored.vaultLedgerEventPage(1).length,1,"Rollback cannot erase independent backup");
  }finally{store.close();concurrent?.close();restored?.close();rmSync(directory,{recursive:true,force:true});rmSync(restoredDirectory,{recursive:true,force:true});}
});
test("Base-scoped stores cannot create a second Vault ledger",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"vault-ledger-base-")),store=new Store(directory,8453);
  try{assert.throws(()=>store.vaultLedgerState(),/Robinhood store/);}finally{store.close();rmSync(directory,{recursive:true,force:true});}
  await assert.rejects(new SupabaseStore("https://fixture.supabase.co","fixture","base").vaultLedgerState(),/Robinhood store/);
});
test("Supabase wire storage preserves raw strings, scoped keyset pagination and atomic CAS RPC",async t=>{
  const calls:{url:URL;method:string;body:any}[]=[];const s=state("1000000000000000000000001");
  t.mock.method(globalThis,"fetch",async(input:string,init:RequestInit)=>{
    const call={url:new URL(input),method:init.method||"GET",body:init.body?JSON.parse(String(init.body)):undefined};calls.push(call);
    if(call.url.pathname.endsWith("musegod_commit_vault_ledger"))return new Response(JSON.stringify(call.body.p_commit.state));
    if(call.url.pathname.endsWith("musegod_vault_ledger_state"))return new Response(JSON.stringify([{payload:s}]));
    return new Response(JSON.stringify([{payload:funding(1,"7")}]))
  });
  const store=new SupabaseStore("https://fixture.supabase.co","fixture","robinhood");
  assert.deepEqual(await store.vaultLedgerState(),s);
  await store.vaultLedgerEventPage(13,{blockNumber:"11",transactionIndex:2,logIndex:9});
  assert.equal(calls[1].url.searchParams.get("scope"),"eq.robinhood");assert.equal(calls[1].url.searchParams.get("limit"),"13");
  assert.match(calls[1].url.searchParams.get("or")!,/transaction_index.eq.2,log_index.gt.9/);
  assert.deepEqual(await store.commitVaultLedger({expectedRevision:0,state:s,blocks:[block(1)],events:[]}),s);
  assert.equal(calls[2].body.p_scope,"robinhood");assert.equal(calls[2].body.p_commit.state.observedBalance,"1000000000000000000000001");
});

function serviceFixture(){
  let head=2n;const headers=new Map<number,VaultLedgerBlock>([0,1,2,3].map(n=>[n,block(n)]));
  const journal:VaultLedgerEvent[]=[];
  const transfer=parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
  const execution=parseAbiItem("event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)");
  const log=(event:VaultLedgerEvent)=>({address:event.kind==="executed"?vault:weth,blockNumber:BigInt(event.blockNumber),blockHash:event.blockHash,transactionHash:event.transactionHash,transactionIndex:event.transactionIndex,logIndex:event.logIndex,removed:false,
    topics:event.kind==="executed"?encodeEventTopics({abi:[execution],eventName:"Executed",args:{caller:event.caller}}):encodeEventTopics({abi:[transfer],eventName:"Transfer",args:{from:event.from,to:event.to}}),
    data:event.kind==="executed"?encodeAbiParameters([{type:"uint256"},{type:"uint256"},{type:"uint256"}],[BigInt(event.wethAmount),BigInt(event.museToDead),BigInt(event.profit)]):encodeAbiParameters([{type:"uint256"}],[BigInt(event.amount)])});
  const client={
    getBlockNumber:async()=>head,
    getBlock:async({blockNumber}:{blockNumber:bigint})=>{const b=headers.get(Number(blockNumber))!;return {...b,number:blockNumber}},
    getLogs:async({address,args,fromBlock,toBlock}:any)=>journal.filter(e=>BigInt(e.blockNumber)>=fromBlock&&BigInt(e.blockNumber)<=toBlock&&
      (address===vault?e.kind==="executed":args.to?e.kind==="weth_in":e.kind==="weth_out")).map(log),
    getTransactionReceipt:async({hash:h}:{hash:Hex})=>{const events=journal.filter(e=>e.transactionHash===h);return {status:"success",transactionIndex:events[0].transactionIndex,blockHash:events[0].blockHash,logs:events.map(log)}},
    readContract:async({functionName,blockNumber}:any)=>{const events=journal.filter(e=>BigInt(e.blockNumber)<=blockNumber);const ins=events.reduce((s,e)=>s+(e.kind==="weth_in"?BigInt(e.amount):0n),0n);const spent=events.reduce((s,e)=>s+(e.kind==="executed"?BigInt(e.wethAmount):0n),0n);
      return functionName==="balanceOf"?ins-spent:functionName==="totalSpent"?spent:events.reduce((s,e)=>s+(e.kind==="executed"?BigInt(e.museToDead):0n),0n)},
  } as unknown as PublicClient;
  return{client,journal,headers,setHead:(n:bigint)=>{head=n}};
}

async function fastRangeFixture(t:TestContext,options:{fastEmptyRanges?:boolean;maxBlocks?:number}={},head=1000){
 const directory=mkdtempSync(join(tmpdir(),"vault-empty-range-")),store=new Store(directory,31337),fixture=serviceFixture();
 for(let number=0;number<=head;number++)fixture.headers.set(number,block(number));
 const calls={headers:[] as bigint[],logs:[] as {fromBlock:bigint;toBlock:bigint}[],receipts:0};
 const client={...fixture.client,
  getBlock:async(parameters:any)=>{calls.headers.push(parameters.blockNumber);return fixture.client.getBlock(parameters);},
  getLogs:async(parameters:any)=>{calls.logs.push({fromBlock:parameters.fromBlock,toBlock:parameters.toBlock});return fixture.client.getLogs(parameters);},
  getTransactionReceipt:async(parameters:any)=>{calls.receipts++;return fixture.client.getTransactionReceipt(parameters);},
  readContract:async(parameters:any)=>fixture.client.readContract(parameters),
 } as unknown as PublicClient;
 const service=new VaultLedgerService(store,client,{vault,weth,swapper,confirmations:1n,...options});
 fixture.setHead(1n);await service.establishCheckpoint(()=>true);fixture.setHead(BigInt(head)+1n);calls.headers.length=0;
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 return{directory,store,fixture,client,service,calls};
}

test("host empty ranges advance at most a thousand canonical blocks with exact unchanged totals and only boundary anchors",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1500);
 const report=await f.service.reconcile();
 assert.equal(report.indexedThrough,"1000");assert.equal(report.caughtUp,false);assert.equal(report.attributionReady,true);
 assert.deepEqual(f.calls.logs,Array.from({length:3},()=>({fromBlock:1n,toBlock:1000n})));
 assert.deepEqual(f.store.vaultLedgerBlockPage().map(header=>header.number),["1000","1","0"]);
 assert.equal(f.calls.headers.some(number=>number>1n&&number<1000n),false);assert.equal(f.calls.receipts,0);assert.deepEqual(f.store.vaultLedgerEventPage(),[]);
 assert.deepEqual([f.store.vaultLedgerState()!.observedBalance,f.store.vaultLedgerState()!.observedTotalSpent,f.store.vaultLedgerState()!.observedTotalBurned],["0","0","0"]);
});

test("host scan ceilings allow ten thousand blocks only with an explicit empty-range option and retain the default thousand-block ceiling",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true,maxBlocks:10_000},10_000);
 assert.equal((await f.service.reconcile()).indexedThrough,"10000");assert.equal(f.calls.logs.length,30);
 assert.ok(f.calls.logs.every(range=>range.toBlock-range.fromBlock===999n));
 assert.ok(f.store.vaultLedgerBlockPage().length<20,"Checkpoint plus recent sparse boundaries stay bounded under the existing anchor pruning");
 for(const options of [{maxBlocks:1001},{fastEmptyRanges:false,maxBlocks:1001},{fastEmptyRanges:true,maxBlocks:10_001},{fastEmptyRanges:true,maxBlocks:0}])
  assert.throws(()=>new VaultLedgerService(f.store,f.client,{vault,weth,swapper,confirmations:1n,...options}),/scan bound/);
});

test("host empty ranges clip their final page to both confirmed head and remaining scan allowance",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true,maxBlocks:1200},1300);
 assert.equal((await f.service.reconcile()).indexedThrough,"1200");assert.deepEqual(f.calls.logs.slice(3),Array.from({length:3},()=>({fromBlock:1001n,toBlock:1200n})));
 f.calls.logs.length=0;assert.equal((await f.service.reconcile()).indexedThrough,"1300");assert.deepEqual(f.calls.logs,Array.from({length:3},()=>({fromBlock:1201n,toBlock:1300n})));
});

test("ordinary empty journals retain all hundred-page headers and narrow log queries",async t=>{
 const f=await fastRangeFixture(t,{},1000);
 assert.equal((await f.service.reconcile()).indexedThrough,"1000");assert.equal(f.calls.logs.length,300);
 assert.ok(f.calls.logs.every(range=>range.toBlock-range.fromBlock<=9n));assert.equal(f.store.vaultLedgerBlockPage(1000).length,1000);
});

test("an unsupported wide log query falls back to full canonical headers without skipping a real execution",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),getLogs=f.fixture.client.getLogs;
 f.fixture.journal.push({...funding(1,"3"),blockNumber:"500",blockHash:block(500).hash},...execute(2,"3","7","2").map(event=>({...event,blockNumber:"501",blockHash:block(501).hash})));
 f.fixture.client.getLogs=(async(parameters:any)=>{if(parameters.toBlock-parameters.fromBlock>9n)throw new Error("Provider range unavailable");return getLogs(parameters);}) as any;
 const report=await f.service.reconcile();assert.equal(report.indexedThrough,"1000");assert.equal(report.attributionReady,true);assert.equal(report.totalMuseToDead,"7");assert.equal(report.totalCallerProfit,"2");
 assert.equal(f.store.vaultLedgerEventPage().length,3);assert.equal(f.calls.receipts,2);assert.ok(f.calls.headers.includes(499n));assert.ok(f.calls.headers.includes(502n));
});

for(const at of [1,500,1000])test(`a nonempty raw log at range position ${at} retains full header and receipt collection even when net WETH is unchanged`,async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000);
 f.fixture.journal.push({...funding(1,"3"),blockNumber:String(at),blockHash:block(at).hash},...execute(2,"3","7").map(event=>({...event,blockNumber:String(at),blockHash:block(at).hash})));
 const report=await f.service.reconcile();assert.equal(report.indexedThrough,"1000");assert.equal(report.attributionReady,true);assert.equal(report.totalMuseToDead,"7");
 assert.equal(f.store.vaultLedgerEventPage().length,3);assert.ok(f.store.vaultLedgerBlockPage(1000).some(header=>header.number===String(at)));assert.equal(f.calls.receipts,2);
});

test("zero-value raw transfers cannot qualify a range as empty before the ordinary validator discards them",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000);
 f.fixture.journal.push({...funding(1,"0"),blockNumber:"50",blockHash:block(50).hash});
 assert.equal((await f.service.reconcile()).indexedThrough,"1000");assert.ok(f.calls.headers.includes(50n));assert.ok(f.calls.headers.includes(51n));
 assert.deepEqual(f.store.vaultLedgerEventPage(),[]);assert.equal(f.calls.receipts,0);
});

for(const changed of ["balanceOf","totalSpent","totalBurned"])test(`empty logs with a changed ${changed} cannot use sparse empty-range commits or create ready accounting`,async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),read=f.fixture.client.readContract;
 f.fixture.client.readContract=(async(parameters:any)=>parameters.functionName===changed&&parameters.blockNumber>0n?1n:read(parameters)) as any;
 const report=await f.service.reconcile();assert.ok(f.calls.headers.includes(50n));assert.ok(f.calls.logs.some(range=>range.toBlock-range.fromBlock===9n));
 assert.equal(report.attributionReady,false);assert.deepEqual(f.store.vaultLedgerEventPage(),[]);
});

for(const invalid of ["0",undefined,-1n])test(`an invalid ${String(invalid)} historical state value cannot prove an empty range`,async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),before=structuredClone(f.store.vaultLedgerState()),read=f.fixture.client.readContract;
 f.fixture.client.readContract=(async(parameters:any)=>parameters.functionName==="balanceOf"&&parameters.blockNumber>0n?invalid:read(parameters)) as any;
 await assert.rejects(f.service.reconcile(),/Invalid canonical Vault balance/);assert.deepEqual(f.store.vaultLedgerState(),before);assert.equal(f.store.vaultLedgerBlockPage().length,1);
});

test("an empty-range state RPC failure stays retryable with no cursor mutation or synthetic zero",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),before=structuredClone(f.store.vaultLedgerState()),read=f.fixture.client.readContract;let unavailable=true;
 f.fixture.client.readContract=(async(parameters:any)=>{if(unavailable&&parameters.blockNumber>0n)throw new Error("Historical state RPC unavailable");return read(parameters);}) as any;
 await assert.rejects(f.service.reconcile(),/Historical state RPC unavailable/);assert.deepEqual(f.store.vaultLedgerState(),before);assert.deepEqual(f.store.vaultLedgerEventPage(),[]);
 unavailable=false;assert.equal((await f.service.reconcile()).indexedThrough,"1000");
});

for(const boundary of [0,1,1000])test(`a changed empty-range ${boundary===0?"cursor":boundary===1?"start":"end"} boundary cannot be committed`,async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),before=structuredClone(f.store.vaultLedgerState()),getBlock=f.fixture.client.getBlock;let reads=0;
 f.fixture.client.getBlock=(async(parameters:any)=>{const header=await getBlock(parameters);if(parameters.blockNumber===BigInt(boundary)&&++reads>=(boundary===0?3:2))return{...header,hash:hash(90000+boundary)};return header;}) as any;
 await assert.rejects(f.service.reconcile(),/empty range changed/);assert.deepEqual(f.store.vaultLedgerState(),before);assert.equal(f.store.vaultLedgerBlockPage().length,1);
});

test("a start header disconnected from the indexed cursor refuses empty-range log collection",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),getBlock=f.fixture.client.getBlock;
 f.fixture.client.getBlock=(async(parameters:any)=>({...await getBlock(parameters),...(parameters.blockNumber===1n?{parentHash:hash(99999)}:{})})) as any;
 await assert.rejects(f.service.reconcile(),/empty range anchor changed/);assert.equal(f.calls.logs.length,0);assert.equal(f.store.vaultLedgerState()!.cursor.number,"0");
});

test("an overdue wide log request cannot commit a partial empty range and the next turn resumes its original cursor",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),before=structuredClone(f.store.vaultLedgerState()),getLogs=f.fixture.client.getLogs;let now=0,slow=true;
 t.mock.method(Date,"now",()=>now);f.fixture.client.getLogs=(async(parameters:any)=>{if(slow)now=20_001;return getLogs(parameters);}) as any;
 const pending=await f.service.reconcile(20_000);assert.equal(pending.attributionReady,false);assert.deepEqual(f.store.vaultLedgerState(),before);assert.equal(f.store.vaultLedgerBlockPage().length,1);
 slow=false;now=0;assert.equal((await f.service.reconcile(20_000)).indexedThrough,"1000");
});

test("even a complete empty-range proof returned after its deadline cannot begin a financial commit",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),before=structuredClone(f.store.vaultLedgerState()),getBlock=f.fixture.client.getBlock;let now=0,endReads=0;
 t.mock.method(Date,"now",()=>now);f.fixture.client.getBlock=(async(parameters:any)=>{const header=await getBlock(parameters);if(parameters.blockNumber===1000n&&++endReads===2)now=20_001;return header;}) as any;
 assert.equal((await f.service.reconcile(20_000)).attributionReady,false);assert.equal(endReads,2);assert.deepEqual(f.store.vaultLedgerState(),before);assert.equal(f.store.vaultLedgerBlockPage().length,1);
});

test("empty-range CAS loss preserves the winning state and requires a fresh canonical retry",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true},1000),commit=f.store.commitVaultLedger.bind(f.store);let conflict=true;
 t.mock.method(f.store,"commitVaultLedger",(input:VaultLedgerCommit)=>{if(conflict){conflict=false;const previous=f.store.vaultLedgerState()!;commit({expectedRevision:previous.revision,state:{...previous,revision:previous.revision+1},blocks:[],events:[]});}return commit(input);});
 await assert.rejects(f.service.reconcile(),/revision changed/);assert.equal(f.store.vaultLedgerState()!.cursor.number,"0");assert.equal(f.store.vaultLedgerState()!.revision,2);assert.equal(f.store.vaultLedgerBlockPage().length,1);
 assert.equal((await f.service.reconcile()).indexedThrough,"1000");
});

test("sparse empty-range anchors survive a new store instance and preserve actual financial events through a shallow reorg",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true,maxBlocks:10_000},3000);
 f.fixture.journal.push({...funding(1,"9"),blockNumber:"100",blockHash:block(100).hash});
 assert.equal((await f.service.reconcile()).indexedThrough,"3000");const events=structuredClone(f.store.vaultLedgerEventPage()),before=structuredClone(f.store.vaultLedgerState());
 const reopened=new Store(f.directory,31337);try{
  assert.deepEqual(reopened.vaultLedgerState(),before);assert.deepEqual(reopened.vaultLedgerEventPage(),events);
  const service=new VaultLedgerService(reopened,f.client,{vault,weth,swapper,confirmations:1n,fastEmptyRanges:true,maxBlocks:10_000});
  for(let number=2500;number<=3000;number++)f.fixture.headers.set(number,block(number,10_000));f.fixture.headers.set(2500,{...block(2500,10_000),parentHash:block(2499).hash});
  const rollbacks:string[]=[];const commit=reopened.commitVaultLedger.bind(reopened);t.mock.method(reopened,"commitVaultLedger",(input:VaultLedgerCommit)=>{if(input.rollbackAfterBlock!==undefined)rollbacks.push(input.rollbackAfterBlock);return commit(input);});
  const report=await service.reconcile();assert.deepEqual(rollbacks,["2101"]);assert.equal(report.indexedThrough,"3000");assert.equal(report.attributionReady,true);
  assert.equal(reopened.vaultLedgerState()!.cursor.hash,block(3000,10_000).hash);assert.deepEqual(reopened.vaultLedgerEventPage(),events);
 }finally{reopened.close();}
});

test("a lagging RPC cannot reinterpret sparse empty-range anchors as a reorg or reset retained financial history",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true,maxBlocks:10_000},5000);assert.equal((await f.service.reconcile()).indexedThrough,"5000");
 const before=structuredClone(f.store.vaultLedgerState()),anchors=f.store.vaultLedgerBlockPage();f.calls.logs.length=0;f.fixture.setHead(1001n);
 const pending=await f.service.reconcile();assert.match(pending.reason!,/RPC is behind/);assert.equal(pending.attributionReady,false);assert.deepEqual(f.store.vaultLedgerState(),before);assert.deepEqual(f.store.vaultLedgerBlockPage(),anchors);assert.equal(f.calls.logs.length,0);
});

test("a reorg before every retained sparse anchor replays from the immutable checkpoint without losing or double-counting real funding",async t=>{
 const f=await fastRangeFixture(t,{fastEmptyRanges:true,maxBlocks:10_000},10_000);
 f.fixture.journal.push({...funding(1,"9"),blockNumber:"100",blockHash:block(100).hash});assert.equal((await f.service.reconcile()).indexedThrough,"10000");
 const events=structuredClone(f.store.vaultLedgerEventPage()),rollbacks:string[]=[],commit=f.store.commitVaultLedger.bind(f.store);
 t.mock.method(f.store,"commitVaultLedger",(input:VaultLedgerCommit)=>{if(input.rollbackAfterBlock!==undefined)rollbacks.push(input.rollbackAfterBlock);return commit(input);});
 for(let number=5000;number<=10_000;number++)f.fixture.headers.set(number,block(number,20_000));f.fixture.headers.set(5000,{...block(5000,20_000),parentHash:block(4999).hash});
 const report=await f.service.reconcile();assert.deepEqual(rollbacks,["0"]);assert.equal(report.indexedThrough,"10000");assert.equal(report.attributionReady,true);
 assert.deepEqual(f.store.vaultLedgerEventPage(),events);assert.equal(f.store.vaultLedgerState()!.observedBalance,"9");assert.equal(f.store.vaultLedgerState()!.cursor.hash,block(10_000,20_000).hash);
});

test("service establishes pre-deposit checkpoint, indexes third-party Executed and rolls back source attribution on reorg",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"vault-ledger-service-")),store=new Store(directory,31337),fixture=serviceFixture();
  fixture.setHead(1n);let verify=true;
  const service=new VaultLedgerService(store,fixture.client,{vault,weth,swapper,confirmations:1n,maxBlocks:10,verifyBaseFill:async()=>verify});
  try{
    await assert.rejects(service.establishCheckpoint(()=>false),/pre-Base/);
    const initial=await service.establishCheckpoint(()=>true);assert.equal(initial.attributionReady,true);
    const entry=funding(1,"6");fixture.journal.push(entry,...execute(2,"4","9","2"));fixture.setHead(2n);
    let report=await service.reconcile();assert.equal(report.totalMuseToDead,"9");assert.equal(report.baseAttributedMuseToDead,"0");
    const evidence=(funding(1,"6","base","base-source") as VaultLedgerEvent&{kind:"weth_in"}).baseFill!;
    report=await service.classifyBaseFill(entry.id,evidence);assert.equal(report.baseAttributedMuseToDead,"9");assert.equal(report.basePendingWeth,"2");
    verify=false;const withheld=await service.read();assert.equal(withheld.attributionReady,true);assert.equal(withheld.baseAttributedMuseToDead,"0");assert.equal(withheld.totalMuseToDead,"9");verify=true;
    fixture.headers.set(1,{number:"1",hash:hash(999),parentHash:block(0).hash});fixture.journal.splice(0,fixture.journal.length);
    assert.equal((await service.read()).attributionReady,false);
    report=await service.reconcile();assert.equal(report.attributionReady,true);assert.equal(report.baseAttributedMuseToDead,"0");
    assert.equal(store.vaultLedgerEventPage().length,0);assert.equal(store.vaultLedgerState()!.cursor.hash,hash(999));
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("default maintenance catches a growing 10-block-per-second backlog with 100-block pages and at most 20 concurrent headers",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"vault-ledger-catchup-")),store=new Store(directory,31337),fixture=serviceFixture();
  for(let number=0;number<=3000;number++)fixture.headers.set(number,block(number));
  let active=0,peak=0,logCalls=0,activeLogs=0,peakLogs=0;
  const client={...fixture.client,
    getBlock:async(parameters:any)=>{active++;peak=Math.max(peak,active);try{await new Promise<void>(resolve=>setImmediate(resolve));return await fixture.client.getBlock(parameters)}finally{active--}},
    getLogs:async(parameters:any)=>{logCalls++;activeLogs++;peakLogs=Math.max(peakLogs,activeLogs);try{assert.ok(parameters.toBlock-parameters.fromBlock<10n,"Existing Alchemy plan accepts only ten-block log ranges");await new Promise<void>(resolve=>setImmediate(resolve));return fixture.client.getLogs(parameters)}finally{activeLogs--}},
  } as unknown as PublicClient;
  const service=new VaultLedgerService(store,client,{vault,weth,swapper,confirmations:1n});
  try{
    fixture.setHead(1n);await service.establishCheckpoint(()=>true);
    const incoming={...funding(1,"3"),blockNumber:"300",blockHash:block(300).hash};
    const execution=execute(2,"3","5").map(event=>({...event,blockNumber:"900",blockHash:block(900).hash}));
    fixture.journal.push(incoming,...execution);
    fixture.setHead(1501n);let report=await service.reconcile();
    assert.equal(report.indexedThrough,"1000");assert.equal(report.confirmedThrough,"1500");assert.equal(report.caughtUp,false);
    assert.equal(report.totalMuseToDead,"5");assert.equal(logCalls,300);assert.equal(peak,20);assert.equal(peakLogs,18);
    // A 60-second completed-maintenance interval can add 600 RH blocks.
    fixture.setHead(2101n);report=await service.reconcile();assert.equal(report.indexedThrough,"2000");
    fixture.setHead(2701n);report=await service.reconcile();assert.equal(report.indexedThrough,"2700");assert.equal(report.caughtUp,true);
    fixture.setHead(3001n);report=await service.reconcile();assert.equal(report.indexedThrough,"3000");assert.equal(report.caughtUp,true);
    assert.equal(store.vaultLedgerEventPage().length,3);assert.equal(report.totalMuseToDead,"5","Repeated maintenance never recounts a historical execution");
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("maintenance never begins a journal commit after its absolute deadline and resumes the prior cursor",async t=>{
  const directory=mkdtempSync(join(tmpdir(),"vault-ledger-deadline-")),store=new Store(directory,31337),fixture=serviceFixture();
  for(let number=0;number<=500;number++)fixture.headers.set(number,block(number));
  let clock=0;
  const client={...fixture.client,getBlock:async(parameters:any)=>{clock++;return fixture.client.getBlock(parameters)}} as unknown as PublicClient;
  const service=new VaultLedgerService(store,client,{vault,weth,swapper,confirmations:1n});
  try{
    fixture.setHead(1n);await service.establishCheckpoint(()=>true);
    t.mock.method(Date,"now",()=>clock);clock=0;fixture.setHead(501n);
    let report=await service.reconcile(10);
    assert.equal(report.indexedThrough,null);assert.equal(store.vaultLedgerState()!.cursor.number,"0");assert.equal(report.confirmedThrough,"500");assert.equal(report.caughtUp,false);
    assert.equal(store.vaultLedgerBlockPage(1000).length,1,"No partial page or unchecked header is committed");
    clock=0;report=await service.reconcile();assert.equal(report.indexedThrough,"500");assert.equal(report.caughtUp,true);
    assert.equal(store.vaultLedgerBlockPage(1000).length,501);
    await assert.rejects(service.reconcile(60_001),/time budget/);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("parallel catch-up preserves prior canonical pages and refuses an ancestry change before committing the next page",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"vault-ledger-catchup-reorg-")),store=new Store(directory,31337),fixture=serviceFixture();
  for(let number=0;number<=200;number++)fixture.headers.set(number,block(number));
  const service=new VaultLedgerService(store,fixture.client,{vault,weth,swapper,confirmations:1n});
  try{
    fixture.setHead(1n);await service.establishCheckpoint(()=>true);fixture.setHead(201n);
    fixture.headers.set(150,{...block(150),parentHash:hash(999)});
    await assert.rejects(service.reconcile(),/ancestry changed/);
    assert.equal(store.vaultLedgerState()!.cursor.number,"100");assert.equal(store.vaultLedgerBlockPage(1000).length,101);
    fixture.headers.set(150,block(150));const report=await service.reconcile();assert.equal(report.indexedThrough,"200");assert.equal(report.caughtUp,true);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("Treasury source reorg invalidates prior Base attribution only after canonical replacement is verified",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-vault-revalidate-")),store=new Store(directory,31337);
 const input=funding(1,"5","base","A") as VaultLedgerEvent&{kind:"weth_in"};input.baseFill={protocol:"splits_native_relay_v1",treasury:source,treasuryEventId:input.id,treasuryRevision:1,fragments:[{batchId:"A",amount:"5"}],fillTransactionHash:input.transactionHash,fillBlockHash:input.blockHash,fillLogIndex:input.logIndex,recipient:vault,outputToken:weth,outputAmount:"5"};
 const s=state("0","5","10");store.commitVaultLedger({expectedRevision:0,state:s,blocks:[block(0),block(1)],events:[input,...execute(2,"5","10")]});let currentSource="A";
 const client={getBlockNumber:async()=>2n,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),number:blockNumber})} as any;
 const ledger=new VaultLedgerService(store,client,{vault,weth,swapper,confirmations:1n,verifyBaseFill:async(_event,evidence)=>"protocol" in evidence&&evidence.fragments.every(fragment=>fragment.batchId===currentSource)});
 try{assert.equal((await ledger.read()).baseAttributedMuseToDead,"10");await assert.rejects(()=>ledger.invalidateBaseFill(input.id),/cannot be invalidated/);
  currentSource="B";const withheld=await ledger.read();assert.equal(withheld.attributionReady,true);assert.equal(withheld.baseAttributedMuseToDead,"0");assert.equal(withheld.totalMuseToDead,"10");await ledger.classifyBaseFill(input.id,{...input.baseFill as any,fragments:[{batchId:"B",amount:"5"}],treasuryRevision:2});assert.equal((await ledger.read()).batches[0].batchId,"B");
  currentSource="unknown";await ledger.invalidateBaseFill(input.id);const report=await ledger.read();assert.equal(report.attributionReady,true);assert.equal(report.baseAttributedMuseToDead,"0");assert.equal(report.totalMuseToDead,"10","Actual global dead transfers are retained");assert.equal(store.vaultLedgerEventPage(1)[0].kind,"weth_in");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("zero/self WETH logs are no-ops in Vault scans and retained historical replay",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"vault-noops-")),store=new Store(directory,31337),f=serviceFixture(),service=new VaultLedgerService(store,f.client,{vault,weth,swapper,confirmations:1n});
 try{f.setHead(1n);await service.establishCheckpoint(()=>true);f.journal.push(funding(1,"5"),{...position(2,20),amount:"0",kind:"weth_out",from:vault,to:source},{...position(3,30),amount:"99",kind:"weth_in",source:"unknown",from:vault,to:vault});
  // The mocked balance tracks actual economic effects, so a self transfer adds nothing.
  const read=f.client.readContract;f.client.readContract=(async (input:any)=>{const functionName=input.functionName;return functionName==="balanceOf"?5n:read(input as any);}) as any;
  const receipt=f.client.getTransactionReceipt;let receipts=0;f.client.getTransactionReceipt=(async(input:any)=>{receipts++;assert.equal(input.hash,hash(1),"No-op logs never request receipt RPC");return receipt(input);}) as any;
  f.setHead(2n);const report=await service.reconcile();assert.equal(receipts,1);assert.equal(report.attributionReady,true);assert.equal(store.vaultLedgerEventPage().length,1);assert.equal(report.totalExecutionWeth,"0");
  assert.equal(replayVaultLedger(state("5"),f.journal,1n).attributionReady,true);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("rolling ancestry is bounded while all financial events and checkpoint remain available for a deep-reorg replay",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"vault-anchor-window-")),store=new Store(directory,31337),f=serviceFixture();
 for(let number=0;number<=5000;number++)f.headers.set(number,block(number));
 const service=new VaultLedgerService(store,f.client,{vault,weth,swapper,confirmations:1n});
 try{const s={...state("5"),cursor:block(5000)};store.commitVaultLedger({expectedRevision:0,state:s,blocks:Array.from({length:5001},(_,number)=>block(number)),events:[funding(1,"5")]});
  const anchors=(store.backup() as any).tables.vault_ledger_blocks;assert.equal(anchors.length,4097);assert.equal(store.vaultLedgerEventPage().length,1);assert.ok(anchors.some((row:any)=>row.number===0));
  f.setHead(5001n);for(let number=905;number<=5000;number++)f.headers.set(number,block(number,10000));f.headers.set(905,{...block(905,10000),parentHash:block(904).hash});
  // All retained recent anchors are orphaned; the immutable canonical checkpoint is sufficient to replay the full financial interval.
  f.journal.push(funding(1,"5"));const report=await service.reconcile();assert.equal(report.indexedThrough,"1000");assert.equal(report.attributionReady,true);assert.equal(store.vaultLedgerEventPage().length,1);assert.equal(store.vaultLedgerState()!.cursor.hash,block(1000,10000).hash);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("Vault freshness expires beyond six hundred confirmed blocks while historical attribution stays intact",()=>{
 const s=state("5"),events=[funding(1,"5","base","A")];assert.equal(replayVaultLedger(s,events,601n).fresh,true);const stale=replayVaultLedger(s,events,602n);assert.equal(stale.fresh,false);assert.equal(stale.baseReceivedWeth,"5");assert.equal(stale.caughtUp,false);
});

test("one invalid source proof withholds only its FIFO lots and recovers without losing actual burns",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"vault-lot-isolation-")),store=new Store(directory,31337),events=[funding(1,"4","base","A"),funding(2,"6","base","B"),funding(3,"3","base","C"),...execute(4,"9","90","7")],s=state("4","9","90");let validBad=false;
 store.commitVaultLedger({expectedRevision:0,state:s,blocks:[block(0),block(1)],events});
 const client={getBlockNumber:async()=>2n,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),number:blockNumber})} as any;
 const ledger=new VaultLedgerService(store,client,{vault,weth,swapper,confirmations:1n,verifyBaseFill:async(e)=>e.id!==events[1].id||validBad});
 try{
  let report=await ledger.read();assert.equal(report.attributionReady,true);assert.equal(report.totalMuseToDead,"90");assert.equal(report.totalCallerProfit,"7");assert.equal(report.baseAttributedMuseToDead,"40");assert.equal(report.basePendingWeth,"3");assert.equal(report.baseReceivedWeth,"7");assert.equal(report.lots.reduce((sum,lot)=>sum+BigInt(lot.remaining),0n),4n);assert.equal(report.allocations.reduce((sum,row)=>sum+BigInt(row.museToDead),0n),90n);assert.deepEqual(report.allocations.map(row=>[row.batchId,row.wethAmount]),[["A","4"],[null,"5"]]);
  const persisted=store.vaultLedgerEventPage()[1];assert.equal(persisted.kind==="weth_in"&&persisted.source,"base","Withheld proof remains persisted for recovery");
  validBad=true;report=await ledger.read();assert.equal(report.baseAttributedMuseToDead,"90");assert.equal(report.baseReceivedWeth,"13");validBad=false;report=await ledger.read();assert.equal(report.baseAttributedMuseToDead,"40");assert.equal(report.attributionReady,true);
  const current=store.vaultLedgerState()!;store.commitVaultLedger({expectedRevision:current.revision,state:{...current,revision:current.revision+1,observedBalance:"999"},blocks:[],events:[]});assert.equal((await ledger.read()).attributionReady,false,"Accounting errors still stop attribution");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

for(const lag of [50n,4100n])test(`Vault RPC behind cursor by ${lag} blocks never rolls back canonical financial events`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),"vault-provider-lag-")),store=new Store(directory,31337);let head=5001n-lag,reorganized=false,logReads=0;const events=[funding(1,"5")],s={...state("5"),cursor:block(5000)};
 store.commitVaultLedger({expectedRevision:0,state:s,blocks:Array.from({length:5001},(_,n)=>block(n)),events});
 const client={getBlockNumber:async()=>head,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),...(reorganized&&blockNumber===5000n?{hash:hash(9000)}:{}),number:blockNumber}),readContract:async({functionName}:any)=>functionName==="balanceOf"?5n:0n,getLogs:async()=>{logReads++;return[];}} as any;
 const ledger=new VaultLedgerService(store,client,{vault,weth,swapper,confirmations:1n,maxBlocks:1});
 try{
  const snapshot=store.vaultLedgerEventPage(),report=await ledger.reconcile();assert.equal(report.attributionReady,false);assert.match(report.reason!,/RPC is behind/);assert.deepEqual(store.vaultLedgerState(),s);assert.deepEqual(store.vaultLedgerEventPage(),snapshot);assert.equal(logReads,0);
  head=5001n;assert.equal((await ledger.reconcile()).attributionReady,true);assert.equal(store.vaultLedgerState()!.revision,1);
  reorganized=true;assert.equal((await ledger.reconcile()).attributionReady,true);assert.equal(store.vaultLedgerState()!.cursor.hash,hash(9000));assert.deepEqual(store.vaultLedgerEventPage(),snapshot,"Real recent reorg preserves earlier canonical financial rows");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
