import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { Store } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
import { VaultLedgerService } from "../server/buyback-vault-ledger";
import { replayVaultLedger, vaultEventId, type VaultBaseFillEvidence, type VaultLedgerBlock, type VaultLedgerEvent, type VaultLedgerState } from "../src/lib/buyback-vault-ledger";
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
    verify=false;assert.equal((await service.read()).attributionReady,false);verify=true;
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

test("maintenance time budget finishes one canonical page atomically and resumes its exact cursor",async t=>{
  const directory=mkdtempSync(join(tmpdir(),"vault-ledger-deadline-")),store=new Store(directory,31337),fixture=serviceFixture();
  for(let number=0;number<=500;number++)fixture.headers.set(number,block(number));
  let clock=0;
  const client={...fixture.client,getBlock:async(parameters:any)=>{clock++;return fixture.client.getBlock(parameters)}} as unknown as PublicClient;
  const service=new VaultLedgerService(store,client,{vault,weth,swapper,confirmations:1n});
  try{
    fixture.setHead(1n);await service.establishCheckpoint(()=>true);
    t.mock.method(Date,"now",()=>clock);clock=0;fixture.setHead(501n);
    let report=await service.reconcile(10);
    assert.equal(report.indexedThrough,"100");assert.equal(report.confirmedThrough,"500");assert.equal(report.caughtUp,false);
    assert.equal(store.vaultLedgerBlockPage(1000).length,101,"No partial page or unchecked header is committed");
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
  currentSource="B";assert.equal((await ledger.read()).attributionReady,false);await ledger.classifyBaseFill(input.id,{...input.baseFill as any,fragments:[{batchId:"B",amount:"5"}],treasuryRevision:2});assert.equal((await ledger.read()).batches[0].batchId,"B");
  currentSource="unknown";await ledger.invalidateBaseFill(input.id);const report=await ledger.read();assert.equal(report.attributionReady,true);assert.equal(report.baseAttributedMuseToDead,"0");assert.equal(report.totalMuseToDead,"10","Actual global dead transfers are retained");assert.equal(store.vaultLedgerEventPage(1)[0].kind,"weth_in");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
