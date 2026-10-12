import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { CustodyLedgerService, readAllCustodyEvents, type CustodyOptions } from "../server/buyback-custody-ledger";
import { convertCustodyFragments, replayCustodyLedger, type CustodyCommit, type CustodyEvent, type CustodyState } from "../src/lib/buyback-custody-ledger";
import { vaultEventId } from "../src/lib/buyback-vault-ledger";
import type { Address, Hex } from "viem";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_WETH } from "../src/lib/base-buyback";
import { STOCKS } from "../src/lib/config";
const addr=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const block=(n:number)=>({number:String(n),hash:hash(100+n),parentHash:hash(99+n)}),account=addr(1),asset=addr(2);
const state=(balance="0"):CustodyState=>({version:1,id:"base_automation",chainId:8453,account,revision:1,checkpoint:block(0),cursor:block(1),openingBalances:{[asset]:"3"},observedBalances:{[asset]:balance},updatedAt:1,blockedReason:null});
function event(n:number,kind:"in"|"out",amount:string,base=false):CustodyEvent {const e:CustodyEvent={id:vaultEventId(hash(n),n),blockNumber:"1",blockHash:block(1).hash,transactionHash:hash(n),transactionIndex:n,logIndex:n,asset,kind,from:kind==="in"?addr(3):account,to:kind==="in"?account:addr(4),amount};
 if(base){e.fragments=[{batchId:e.id,amount}];e.evidence={kind:"adapter_release",collector:addr(3),releaseLogIndex:n+1,transactionHash:e.transactionHash,blockHash:e.blockHash};}return e;}
test("all Automation outflows consume FIFO across unknown opening, actual fee releases and donations",()=>{
 const events=[event(1,"in","5",true),event(2,"in","2"),event(3,"out","5"),event(4,"out","3")];const report=replayCustodyLedger(state("2"),events.reverse(),1n);
 assert.equal(report.ready,true);assert.deepEqual(report.consumptions.map(row=>row.fragments),[[{batchId:null,amount:"3"},{batchId:events.find(row=>row.transactionIndex===1)!.id,amount:"2"}],[{batchId:events.find(row=>row.transactionIndex===1)!.id,amount:"3"}]]);
 assert.equal(report.assets[0].basePending,"0");assert.equal(report.assets[0].pending,"2");
 assert.deepEqual(convertCustodyFragments(report.consumptions[0].fragments,"5","7"),[{batchId:null,amount:"4"},{batchId:events.find(row=>row.transactionIndex===1)!.id,amount:"3"}]);
});
test("shortfall, absent opening precision/balance and non-conserving fragments never create Base provenance",()=>{
 assert.equal(replayCustodyLedger(state(),[event(1,"out","4")],1n).ready,false);
 assert.throws(()=>replayCustodyLedger(state(),[{...event(1,"in","5",true),fragments:[{batchId:"invented",amount:"6"}]}],1n),/conserve/);
 const mismatch=replayCustodyLedger(state("999"),[],1n);assert.equal(mismatch.ready,false);assert.equal(mismatch.assets[0].basePending,"0");
});
test("full persistent custody journal >1000 events survives restart, backup, CAS and reorg rollback",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-custody-")),restore=mkdtempSync(join(tmpdir(),"native-custody-restore-"));let store=new Store(directory,8453),restored:Store|undefined;
 try {const events=Array.from({length:1201},(_,index)=>event(index+1,"in","1",true)),s=state("1204");store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1)],events});
  assert.equal((await readAllCustodyEvents(store,"base_automation")).length,1201);store.close();store=new Store(directory,8453);assert.equal((await readAllCustodyEvents(store,"base_automation")).length,1201);
  assert.throws(()=>store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[],events:[]}),/revision/);
  restored=new Store(restore,8453);restored.restore(store.backup());assert.deepEqual(restored.custodyLedgerState("base_automation"),s);assert.equal((await readAllCustodyEvents(restored,"base_automation")).length,1201);
  store.commitCustodyLedger({expectedRevision:1,state:{...s,revision:2,cursor:block(0),observedBalances:{[asset]:"3"}},rollbackAfterBlock:"0",blocks:[],events:[]});assert.equal((await readAllCustodyEvents(store,"base_automation")).length,0);
  assert.throws(()=>store.custodyLedgerState("robinhood_treasury"),/another chain/);
 }finally{restored?.close();store.close();rmSync(directory,{recursive:true,force:true});rmSync(restore,{recursive:true,force:true});}
});
test("canonical source revalidation replaces invalidated provenance; temporary RPC loss cannot erase it",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger");
 const directory=mkdtempSync(join(tmpdir(),"native-revalidate-")),store=new Store(directory,8453);let sourceIsBase=true,rpcAvailable=true;
 const incoming=event(1,"in","5",true),s=state("8");store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1)],events:[incoming]});
 const client={getChainId:async()=>8453,getBlockNumber:async()=>2n,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),number:blockNumber}),readContract:async()=>8n} as any;
 const ledger=new CustodyLedgerService(store,client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n,verifyEvidence:async(_event,_evidence,fragments)=>rpcAvailable&&fragments.every(fragment=>sourceIsBase?fragment.batchId!==null:fragment.batchId===null)});
 try{
  assert.equal((await ledger.read()).assets[0].basePending,"5");rpcAvailable=false;
  await assert.rejects(()=>ledger.classify(incoming.id,[{batchId:null,amount:"5"}],incoming.evidence!),/not canonically verified/);
  assert.equal(store.custodyLedgerEventPage("base_automation",1)[0].fragments![0].batchId,incoming.id);const withheld=await ledger.read();assert.equal(withheld.ready,true);assert.equal(withheld.assets[0].basePending,"0");assert.equal(withheld.assets[0].pending,"8");
  rpcAvailable=true;sourceIsBase=false;await ledger.classify(incoming.id,[{batchId:null,amount:"5"}],incoming.evidence!);assert.equal((await ledger.read()).ready,true);assert.equal((await ledger.read()).assets[0].basePending,"0");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("an unverified shared-WETH lot remains in FIFO without poisoning healthy source attribution",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-lot-isolation-")),store=new Store(directory,4663);
 const incoming=[event(1,"in","5",true),event(2,"in","7",true),event(3,"in","3",true)],outgoing=event(4,"out","10"),s:CustodyState={...state("5"),id:"robinhood_treasury",chainId:4663,openingBalances:{[asset]:"0"}};let validBad=false;
 store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1)],events:[...incoming,outgoing]});
 const client={getChainId:async()=>4663,getBlockNumber:async()=>2n,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),number:blockNumber})} as any;
 const ledger=new CustodyLedgerService(store,client,{id:"robinhood_treasury",account,initialAssets:[asset],confirmations:1n,verifyEvidence:async(e)=>e.id!==incoming[1].id||validBad});
 try{
  let report=await ledger.read();assert.equal(report.ready,true);assert.deepEqual(report.withheldEventIds,[incoming[1].id]);assert.equal(report.assets[0].pending,"5");assert.equal(report.assets[0].baseReceived,"8");assert.equal(report.assets[0].basePending,"3");assert.deepEqual(report.consumptions[0].fragments,[{batchId:incoming[0].id,amount:"5"},{batchId:null,amount:"5"}]);
  assert.equal(store.custodyLedgerEventPage("robinhood_treasury")[1].fragments![0].batchId,incoming[1].id,"Original proof remains available for restart/recovery");
  validBad=true;report=await ledger.read();assert.deepEqual(report.withheldEventIds,[]);assert.equal(report.assets[0].baseReceived,"15");assert.equal(report.assets[0].basePending,"5");assert.deepEqual(report.consumptions[0].fragments,[{batchId:incoming[0].id,amount:"5"},{batchId:incoming[1].id,amount:"5"}]);
  validBad=false;report=await ledger.read();assert.equal(report.ready,true);assert.equal(report.assets[0].basePending,"3");
  const stored=store.custodyLedgerState("robinhood_treasury")!;store.commitCustodyLedger({expectedRevision:stored.revision,state:{...stored,revision:stored.revision+1,observedBalances:{[asset]:"999"}},blocks:[],events:[]});assert.equal((await ledger.read()).ready,false,"Actual balance inconsistency remains fail closed");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

for(const lag of [50n,4100n])test(`custody RPC behind cursor by ${lag} blocks never rolls back canonical financial events`,async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-provider-lag-")),store=new Store(directory,4663);
 let head=5001n-lag,reorganized=false,logReads=0;const incoming=event(1,"in","5"),s:CustodyState={...state("5"),id:"robinhood_treasury",chainId:4663,cursor:block(5000),openingBalances:{[asset]:"0"}};
 store.commitCustodyLedger({expectedRevision:0,state:s,blocks:Array.from({length:5001},(_,n)=>block(n)),events:[incoming]});
 const client={getChainId:async()=>4663,getBlockNumber:async()=>head,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),...(reorganized&&blockNumber===5000n?{hash:hash(9000)}:{}),number:blockNumber}),readContract:async()=>5n,getLogs:async()=>{logReads++;return[];}} as any;
 const ledger=new CustodyLedgerService(store,client,{id:"robinhood_treasury",account,initialAssets:[asset],confirmations:1n,maxBlocks:1});
 try{
  const snapshot=store.custodyLedgerEventPage("robinhood_treasury"),report=await ledger.reconcile();assert.equal(report.ready,false);assert.match(report.reason!,/RPC is behind/);assert.deepEqual(store.custodyLedgerState("robinhood_treasury"),s);assert.deepEqual(store.custodyLedgerEventPage("robinhood_treasury"),snapshot);assert.equal(logReads,0);
  head=5001n;assert.equal((await ledger.reconcile()).ready,true);assert.equal(store.custodyLedgerState("robinhood_treasury")!.revision,1);
  reorganized=true;assert.equal((await ledger.reconcile()).ready,true);assert.equal(store.custodyLedgerState("robinhood_treasury")!.cursor.hash,hash(9000));assert.deepEqual(store.custodyLedgerEventPage("robinhood_treasury"),snapshot,"Real recent reorg preserves earlier canonical financial rows");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

function custodyFixture(id:"base_automation"|"robinhood_treasury"="base_automation"){
 let head=1n;const events:CustodyEvent[]=[],known=[asset],fail=new Set<string>(),undeployed=new Set<string>(),queries:any[]=[];
 const client={getChainId:async()=>id==="base_automation"?8453:4663,getBlockNumber:async()=>head,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),number:blockNumber}),
  getCode:async({address,blockNumber}:any)=>blockNumber===0n&&undeployed.has(address.toLowerCase())?"0x":"0x6000",
  readContract:async({address,blockNumber}:any)=>{if(fail.has(address.toLowerCase()))throw new Error("balanceOf RPC unavailable");
   if(blockNumber===0n&&undeployed.has(address.toLowerCase()))throw new ContractFunctionZeroDataError({functionName:"balanceOf"});
   return events.filter(event=>event.asset.toLowerCase()===address.toLowerCase()&&BigInt(event.blockNumber)<=blockNumber&&event.from!==event.to).reduce((sum,event)=>sum+(event.kind==="in"?1n:-1n)*BigInt(event.amount),0n);},
  getLogs:async(input:any)=>{queries.push(input);const addresses=Array.isArray(input.address)?input.address:[input.address];return events.filter(event=>BigInt(event.blockNumber)>=input.fromBlock&&BigInt(event.blockNumber)<=input.toBlock&&addresses.some((address:string)=>address.toLowerCase()===event.asset.toLowerCase())&&(input.args.to?event.kind==="in"||event.from===event.to:event.kind==="out"||event.from===event.to)).map(log);},
  getTransactionReceipt:async({hash:h}:any)=>{const rows=events.filter(event=>event.transactionHash===h);return{status:"success",blockHash:rows[0].blockHash,transactionIndex:rows[0].transactionIndex,logs:rows.map(log)};}
 } as any;
 return{client,events,known,fail,undeployed,queries,setHead:(value:bigint)=>head=value};
}
import { AbiDecodingZeroDataError, BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, encodeEventTopics, encodeAbiParameters, erc20Abi, parseAbiItem } from "viem";
const transferEvent=parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
function log(event:CustodyEvent){return{address:event.asset,blockNumber:BigInt(event.blockNumber),blockHash:event.blockHash,transactionHash:event.transactionHash,transactionIndex:event.transactionIndex,logIndex:event.logIndex,removed:false,
 topics:encodeEventTopics({abi:[transferEvent],eventName:"Transfer",args:{from:event.from,to:event.to}}),data:encodeAbiParameters([{type:"uint256"}],[BigInt(event.amount)])};}

test("Automation scans only initial or actual-released assets; arbitrary spam cannot poison its cursor",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-spam-")),store=new Store(directory,8453),f=custodyFixture(),spam=addr(999);
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n});
 try{await service.establishCheckpoint(async()=>true);f.events.push(event(1,"in","5"),{...event(2,"in","1"),asset:spam});f.fail.add(spam);f.setHead(2n);
  const report=await service.reconcile();assert.equal(report.ready,true);assert.equal(report.indexedThrough,"1");assert.equal(report.assets.length,1);assert.equal((await readAllCustodyEvents(store,"base_automation")).length,1);
  assert.ok(f.queries.every(query=>query.address.length===1&&query.address[0]===asset));
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("a token deployed after checkpoint has zero opening; discovering a real release replays its earlier unknown donations",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-late-token-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(33);f.undeployed.add(meme);
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n,discoverAssets:async(from,to)=>from<=2n&&to>=2n?[meme]:[]});
 try{await service.establishCheckpoint(async()=>true);f.events.push({...event(1,"in","3"),asset:meme});f.setHead(2n);await service.reconcile();
  f.events.push({...event(2,"in","5"),asset:meme,blockNumber:"2",blockHash:block(2).hash});f.setHead(3n);const report=await service.reconcile();
  assert.equal(report.ready,true);assert.equal(store.custodyLedgerState("base_automation")!.openingBalances[meme],"0");assert.equal(report.assets.find(row=>row.asset===meme)!.pending,"8");assert.equal(report.assets.find(row=>row.asset===meme)!.basePending,"0");
  assert.equal((await readAllCustodyEvents(store,"base_automation")).filter(row=>row.asset===meme).length,2);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("opening RPC errors and empty code never commit a false zero balance; retry restores existing principal",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-opening-rpc-")),store=new Store(directory,8453),f=custodyFixture();
 let failed=true;const read=f.client.readContract;
 f.client.readContract=async(input:any)=>{
  if(input.address.toLowerCase()===asset&&input.blockNumber===0n){if(failed)throw new Error("RPC 429 archive state unavailable");return 7n;}
  return 7n+await read(input);
 };
 f.client.getCode=async()=>failed?"0x":"0x6000";
 const options={id:"base_automation" as const,account,initialAssets:[asset],confirmations:1n};
 let service=new CustodyLedgerService(store,f.client,options);
 try{
  const held=await service.establishCheckpoint(async()=>true);assert.equal(held.assets.find(row=>row.asset===asset)?.ready,false);
  assert.equal(store.custodyLedgerState("base_automation")!.openingBalances[asset],undefined,"Unverified empty code cannot permanently record a real token as unborn");
  failed=false;service=new CustodyLedgerService(store,f.client,options);const recovered=await service.reconcile();
  assert.equal(store.custodyLedgerState("base_automation")!.openingBalances[asset],"7");assert.equal(recovered.assets.find(row=>row.asset===asset)!.ready,true);assert.equal(recovered.assets.find(row=>row.asset===asset)!.pending,"7");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("a newly discovered asset with zero-data and empty current code stays pending without an irreversible opening zero",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-opening-discovery-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(84);
 let failed=true;const read=f.client.readContract,code=f.client.getCode;
 f.client.readContract=async(input:any)=>{
  if(input.address===meme&&input.blockNumber===0n){if(failed)throw new ContractFunctionZeroDataError({functionName:"balanceOf"});return 7n;}
  return (input.address===meme?7n:0n)+await read(input);
 };
 f.client.getCode=async(input:any)=>input.address===meme&&failed?"0x":code(input);
 const options={id:"base_automation" as const,account,initialAssets:[asset],confirmations:1n,discoverAssets:async()=>[meme]};
 try{
  let service=new CustodyLedgerService(store,f.client,options);await service.establishCheckpoint(async()=>true);f.setHead(2n);
  let held=await service.reconcile();assert.equal(held.assets.find(row=>row.asset===meme)!.ready,false);assert.equal(store.custodyLedgerState("base_automation")!.openingBalances[meme],undefined);
  failed=false;service=new CustodyLedgerService(store,f.client,options);held=await service.reconcile();assert.equal(store.custodyLedgerState("base_automation")!.openingBalances[meme],"7");assert.equal(held.assets.find(row=>row.asset===meme)!.pending,"7");assert.equal(held.assets.find(row=>row.asset===meme)!.ready,true);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("only a genuine viem zero-data cause chain can establish a discovered post-checkpoint token's zero opening",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-opening-zero-data-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(85);
 f.undeployed.add(meme);const read=f.client.readContract;
 let failure:Error=new Error("HTTP 429 Retry-After");
 f.client.readContract=async(input:any)=>{if(input.address===meme&&input.blockNumber===0n)throw failure;return read(input);};
 const options={id:"base_automation" as const,account,initialAssets:[asset],confirmations:1n,discoverAssets:async()=>[meme]};
 const service=new CustodyLedgerService(store,f.client,options);
 try{
  await service.establishCheckpoint(async()=>true);f.events.push({...event(1,"in","3"),asset:meme});f.setHead(2n);
  for(const error of [new Error("HTTP 429 Retry-After"),new Error("Archive historical state unavailable"),new BaseError("transport timeout"),
   new ContractFunctionRevertedError({abi:erc20Abi,functionName:"balanceOf",message:"execution reverted"})]){
   failure=error;const held=await service.reconcile();assert.equal(held.assets.find(row=>row.asset===meme)!.ready,false);assert.equal(store.custodyLedgerState("base_automation")!.openingBalances[meme],undefined);
  }
  failure=new ContractFunctionExecutionError(new ContractFunctionZeroDataError({functionName:"balanceOf",cause:new AbiDecodingZeroDataError()}),
   {abi:erc20Abi,functionName:"balanceOf",args:[account],contractAddress:meme});
  const recovered=await service.reconcile();assert.equal(store.custodyLedgerState("base_automation")!.openingBalances[meme],"0");assert.equal(recovered.assets.find(row=>row.asset===meme)!.pending,"3");assert.equal(recovered.assets.find(row=>row.asset===meme)!.ready,true);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("one token balance failure withholds only that asset and recovers without erasing other fee provenance",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-asset-failure-")),store=new Store(directory,8453),f=custodyFixture(),bad=addr(34);
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset,bad],confirmations:1n,verifyEvidence:async()=>true});
 try{await service.establishCheckpoint(async()=>true);f.events.push(event(1,"in","5"),{...event(2,"in","3"),asset:bad});f.fail.add(bad);f.setHead(2n);const report=await service.reconcile();
  assert.equal(report.ready,true);assert.equal(report.assets.find(row=>row.asset===asset)!.pending,"5");assert.equal(report.assets.find(row=>row.asset===bad)!.ready,false);
  f.fail.delete(bad);f.setHead(3n);const recovered=await service.reconcile();assert.equal(recovered.assets.find(row=>row.asset===bad)!.ready,true);assert.equal(recovered.assets.find(row=>row.asset===bad)!.pending,"3");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
for(const id of ["base_automation","robinhood_treasury"] as const)test(`${id} ignores zero/self transfers while preserving all economic FIFO movements`,async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-noops-")),store=new Store(directory,id==="base_automation"?8453:4663),f=custodyFixture(id);
 const service=new CustodyLedgerService(store,f.client,{id,account,initialAssets:[asset],confirmations:1n});
 try{await service.establishCheckpoint(async()=>true);f.events.push(event(1,"in","5"),event(2,"out","0"),{...event(3,"in","99"),from:account,to:account});f.setHead(2n);const receipt=f.client.getTransactionReceipt;let receipts=0;f.client.getTransactionReceipt=async(input:any)=>{receipts++;assert.equal(input.hash,hash(1),"No-op logs never request receipt RPC");return receipt(input);};
  const report=await service.reconcile();assert.equal(report.ready,true);assert.equal(report.assets[0].pending,"5");assert.equal((await readAllCustodyEvents(store,id)).length,1);assert.equal(receipts,1);
  const prior=state("8");const replay=replayCustodyLedger({...prior,id,chainId:id==="base_automation"?8453:4663},f.events,1n);assert.equal(replay.ready,true);assert.equal(replay.assets[0].pending,"8");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("custody freshness is finite confirmed-block lag; exact caughtUp remains truthful",()=>{
 assert.equal(replayCustodyLedger(state("3"),[],31n).fresh,true);assert.equal(replayCustodyLedger(state("3"),[],32n).fresh,false);
 const rh={...state("3"),id:"robinhood_treasury" as const,chainId:4663 as const};assert.equal(replayCustodyLedger(rh,[],601n).fresh,true);assert.equal(replayCustodyLedger(rh,[],602n).fresh,false);assert.equal(replayCustodyLedger(rh,[],2n).caughtUp,false);
});

test("a new meme release after long history backfills only its deployment interval and never rewinds existing assets",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-independent-backfill-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(40);
 f.client.getCode=async({address,blockNumber}:any)=>address===meme&&blockNumber<99999n?"0x":"0x6000";
 const incoming=event(1,"in","5"),s:CustodyState={...state("5"),openingBalances:{[asset]:"0"},cursor:block(100000)};
 store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1),block(100000)],events:[incoming]});f.events.push(incoming,
  {...event(2,"in","3"),asset:meme,blockNumber:"100000",blockHash:block(100000).hash},
  {...event(3,"in","5"),asset:meme,blockNumber:"100001",blockHash:block(100001).hash});f.setHead(100002n);
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n,discoverAssets:async()=>[meme]});
 try{const report=await service.reconcile();assert.equal(report.ready,true);assert.equal(report.fresh,true);assert.equal(report.indexedThrough,"100001");
  assert.equal(report.assets.find(row=>row.asset===asset)!.pending,"5");assert.equal(report.assets.find(row=>row.asset===meme)!.pending,"8");assert.equal(report.assets.find(row=>row.asset===meme)!.basePending,"0");
  assert.ok(f.queries.every(query=>query.fromBlock>=99999n));assert.ok(f.queries.length<=6);assert.equal(store.custodyLedgerEventPage("base_automation").length,3);assert.equal(store.custodyLedgerState("base_automation")!.assetCursors![meme].number,"100001");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("independent backfill rotates old queues and a nearby new meme can finish without waiting for their long histories",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-fair-backfill-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(50),oldAssets=[addr(60),addr(61),addr(62)];
 f.client.getCode=async({address,blockNumber}:any)=>address===meme&&blockNumber<9999n?"0x":"0x6000";
 const s:CustodyState={...state("0"),openingBalances:Object.fromEntries([asset,...oldAssets].map(token=>[token,"0"])),observedBalances:Object.fromEntries([asset,...oldAssets].map(token=>[token,"0"])),cursor:block(10000),releasedAssets:oldAssets,assetCursors:Object.fromEntries(oldAssets.map(token=>[token,block(0)])),assetBackfillAt:Object.fromEntries(oldAssets.map(token=>[token,1000]))};
 store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(10000)],events:[]});f.events.push({...event(1,"in","3"),asset:meme,blockNumber:"10000",blockHash:block(10000).hash},{...event(2,"in","5"),asset:meme,blockNumber:"10001",blockHash:block(10001).hash});f.setHead(10002n);
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n,maxBlocks:100,discoverAssets:async()=>[meme]});
 try{const first=await service.reconcile();assert.equal(first.indexedThrough,"10001");assert.equal(first.fresh,true);assert.equal(first.assets.find(row=>row.asset===meme)!.ready,true);assert.equal(first.assets.find(row=>row.asset===meme)!.pending,"8");
  let cursors=store.custodyLedgerState("base_automation")!.assetCursors!;assert.equal(cursors[oldAssets[0]].number,"97");assert.equal(cursors[oldAssets[1]].number,"0");await service.reconcile();cursors=store.custodyLedgerState("base_automation")!.assetCursors!;assert.equal(cursors[oldAssets[0]].number,"97");assert.equal(cursors[oldAssets[1]].number,"100");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("a reorg after the initial cursor check cannot append a new branch to retained orphaned custody events",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-cursor-race-")),store=new Store(directory,8453),f=custodyFixture();
 const incoming=event(1,"in","5"),s={...state("5"),openingBalances:{[asset]:"0"}};store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1)],events:[incoming]});f.events.push(incoming);f.setHead(3n);let reads=0;
 f.client.getBlock=async({blockNumber}:any)=>blockNumber===1n?{...block(1),number:blockNumber,hash:++reads===1?block(1).hash:hash(9001)}:blockNumber===2n?{...block(2),number:blockNumber,hash:hash(9002),parentHash:hash(9001)}:{...block(Number(blockNumber)),number:blockNumber};
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n});
 try{await assert.rejects(()=>service.reconcile(),/ancestry changed/);assert.equal(store.custodyLedgerState("base_automation")!.cursor.hash,block(1).hash);assert.equal(store.custodyLedgerEventPage("base_automation").length,1);assert.equal((await service.read()).ready,false);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("historical asset backfill is bound to its persisted asset cursor through the same reorg race",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-backfill-race-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(70);
 const s:CustodyState={...state("0"),openingBalances:{[asset]:"0",[meme]:"0"},observedBalances:{[asset]:"0",[meme]:"0"},cursor:block(100),releasedAssets:[meme],assetCursors:{[meme]:block(20)}};store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(20),block(100)],events:[]});f.setHead(101n);let reads=0;
 f.client.getBlock=async({blockNumber}:any)=>blockNumber===20n?{...block(20),number:blockNumber,hash:++reads===1?block(20).hash:hash(9020)}:blockNumber===21n?{...block(21),number:blockNumber,hash:hash(9021),parentHash:hash(9020)}:{...block(Number(blockNumber)),number:blockNumber};
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n});
 try{const report=await service.reconcile();assert.equal(report.ready,true);assert.equal(report.assets.find(row=>row.asset===meme)!.ready,false);assert.equal(store.custodyLedgerState("base_automation")!.cursor.number,"100");assert.equal(store.custodyLedgerState("base_automation")!.assetCursors![meme].number,"20");assert.equal(store.custodyLedgerEventPage("base_automation").length,0);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("a slow asset backfill cannot discard the independently committed current global page",async(t)=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-global-first-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(80);let now=0;t.mock.method(Date,"now",()=>now);
 const s:CustodyState={...state("0"),openingBalances:{[asset]:"0",[meme]:"0"},observedBalances:{[asset]:"0",[meme]:"0"},cursor:block(100),releasedAssets:[meme],assetCursors:{[meme]:block(0)}};
 store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(100)],events:[]});f.setHead(201n);const getLogs=f.client.getLogs;f.client.getLogs=async(input:any)=>{if(input.address.length===1&&input.address[0]===meme)now+=31;return getLogs(input);};
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n,maxBlocks:100});
 try{await service.reconcile(30);assert.equal(store.custodyLedgerState("base_automation")!.cursor.number,"200","The completed global page survives a later historical timeout");assert.equal(store.custodyLedgerState("base_automation")!.assetCursors![meme].number,"0");const report=await service.read();assert.equal(report.fresh,true);assert.equal(report.ready,true);assert.equal(report.assets.find(row=>row.asset===meme)!.ready,false);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("a bad asset cursor is independently reset and replayed while healthy global accounting advances",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-cursor-isolation-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(81);let failing=true;
 const incoming=event(1,"in","5"),other={...event(2,"in","3"),asset:meme},s:CustodyState={...state("5"),openingBalances:{[asset]:"0",[meme]:"0"},observedBalances:{[asset]:"5",[meme]:"3"},cursor:block(100),releasedAssets:[meme],assetCursors:{[meme]:{...block(10),hash:hash(90010)}}};
 store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1),block(100)],events:[incoming]});f.events.push(incoming,other);f.setHead(102n);const getBlock=f.client.getBlock;f.client.getBlock=async(input:any)=>{if(failing&&input.blockNumber===10n)throw new Error("This historical asset page is unavailable");return getBlock(input);};
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n});
 try{let report=await service.reconcile();assert.equal(report.indexedThrough,"101");assert.equal(report.ready,true);assert.equal(report.assets.find(row=>row.asset===asset)!.pending,"5");assert.equal(report.assets.find(row=>row.asset===meme)!.ready,false);
  failing=false;report=await service.reconcile();assert.equal(report.indexedThrough,"101");assert.equal(report.assets.find(row=>row.asset===meme)!.ready,false,"The first bounded recovery page stays withheld until its own cursor catches up");report=await service.reconcile();assert.equal(report.assets.find(row=>row.asset===meme)!.ready,true);assert.equal(report.assets.find(row=>row.asset===meme)!.pending,"3");assert.equal(store.custodyLedgerEventPage("base_automation").length,2,"Reset/backfill preserves earlier healthy financial history without duplicate credit");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("empty deployment-code RPC responses retain an invalid asset's history origin and recover automatically",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-empty-code-retry-")),store=new Store(directory,8453),f=custodyFixture(),meme=addr(82);let empty=true;
 const incoming=event(1,"in","5"),old={...event(2,"in","3"),asset:meme,blockNumber:"20",blockHash:block(20).hash};
 const s:CustodyState={...state("5"),openingBalances:{[asset]:"0",[meme]:"0"},observedBalances:{[asset]:"5",[meme]:"3"},cursor:block(100),releasedAssets:[meme],assetCursors:{[meme]:{...block(10),hash:hash(90010)}}};
 store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1),block(100)],events:[incoming]});f.events.push(incoming,old);f.setHead(102n);
 const getCode=f.client.getCode;f.client.getCode=async(input:any)=>input.address===meme&&(empty||input.blockNumber<20n)?"0x":getCode(input);
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n});
 try{
  const held=await service.reconcile();assert.equal(held.ready,true);assert.equal(held.indexedThrough,"101");assert.equal(held.assets.find(row=>row.asset===meme)!.ready,false);
  assert.deepEqual(store.custodyLedgerState("base_automation")!.assetCursors![meme],s.assetCursors![meme],"Empty current code is not proof that history can jump to the global cursor");
  assert.equal(store.custodyLedgerEventPage("base_automation").some(event=>event.id===old.id),false);
  empty=false;const recovered=await service.reconcile();assert.equal(recovered.assets.find(row=>row.asset===meme)!.ready,true);assert.equal(recovered.assets.find(row=>row.asset===meme)!.pending,"3");assert.equal(store.custodyLedgerEventPage("base_automation").filter(event=>event.id===old.id).length,1);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("new asset discovery preserves a pending origin through empty code and retries after restart",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-new-empty-code-"));let store=new Store(directory,8453);const f=custodyFixture(),meme=addr(83);let empty=true;
 const incoming=event(1,"in","5"),old={...event(2,"in","3"),asset:meme,blockNumber:"20",blockHash:block(20).hash};
 const s:CustodyState={...state("5"),openingBalances:{[asset]:"0"},cursor:block(100)};store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1),block(100)],events:[incoming]});f.events.push(incoming,old);f.setHead(102n);
 const getCode=f.client.getCode;f.client.getCode=async(input:any)=>input.address===meme&&(empty||input.blockNumber<20n)?"0x":getCode(input);
 const options={id:"base_automation" as const,account,initialAssets:[asset],confirmations:1n,discoverAssets:async()=>[meme]};
 try{
  let service=new CustodyLedgerService(store,f.client,options);let report=await service.reconcile();assert.equal(report.assets.find(row=>row.asset===meme)!.ready,false);assert.equal(store.custodyLedgerState("base_automation")!.assetCursors![meme].number,"0");assert.match(store.custodyLedgerState("base_automation")!.assetErrors![meme],/Asset discovery/);
  store.close();store=new Store(directory,8453);service=new CustodyLedgerService(store,f.client,options);empty=false;report=await service.reconcile();assert.equal(report.assets.find(row=>row.asset===meme)!.ready,true);assert.equal(report.assets.find(row=>row.asset===meme)!.pending,"3");assert.equal(store.custodyLedgerEventPage("base_automation").filter(event=>event.id===old.id).length,1);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("duplicate suppression reads the full prior journal once per turn instead of once for every page",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-page-index-")),store=new Store(directory,8453),f=custodyFixture();
 const historical=Array.from({length:1201},(_,n)=>event(n+1,"in","1")),s:CustodyState={...state("1201"),openingBalances:{[asset]:"0"},cursor:block(1000)};store.commitCustodyLedger({expectedRevision:0,state:s,blocks:[block(0),block(1),block(1000)],events:historical});f.events.push(...historical);
 for(let n=0;n<10;n++){const number=1001+n*100;f.events.push({...event(2000+n,"in","1"),blockNumber:String(number),blockHash:block(number).hash});}f.setHead(2001n);
 let reads=0;const page=store.custodyLedgerEventPage.bind(store);store.custodyLedgerEventPage=(...args:any[])=>{reads++;return(page as any)(...args);};
 const service=new CustodyLedgerService(store,f.client,{id:"base_automation",account,initialAssets:[asset],confirmations:1n});
 try{const report=await service.reconcile();assert.equal(report.indexedThrough,"2000");assert.equal(report.assets[0].pending,"1211");assert.equal(reads,6,"One three-page duplicate index plus one three-page final report, independent of ten scan pages");assert.equal(store.custodyLedgerEventPage("base_automation",1000).length,1000);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("new Treasury events capture transaction context only from their canonical successful receipt",async()=>{
 const {CustodyLedgerService}=await import("../server/buyback-custody-ledger"),directory=mkdtempSync(join(tmpdir(),"custody-receipt-context-")),store=new Store(directory,4663),f=custodyFixture("robinhood_treasury");let legacy:Store|undefined;
 const receipt=f.client.getTransactionReceipt;f.client.getTransactionReceipt=async(input:any)=>({...await receipt(input),from:addr(700),to:addr(701)});const service=new CustodyLedgerService(store,f.client,{id:"robinhood_treasury",account,initialAssets:[asset],confirmations:1n});
 try{await service.establishCheckpoint(async()=>true);f.events.push(event(1,"in","5"));f.setHead(2n);await service.reconcile();const row=store.custodyLedgerEventPage("robinhood_treasury",1)[0];assert.equal(row.nativeTransactionFrom,addr(700));assert.equal(row.nativeTransactionTo,addr(701));assert.notEqual(row.nativeTransactionFrom,row.from,"Transaction caller and token-transfer sender have separate identities");
  const backup=store.backup() as any,old=JSON.parse(backup.tables.custody_ledger_events[0].payload);delete old.nativeTransactionFrom;delete old.nativeTransactionTo;backup.tables.custody_ledger_events[0].payload=JSON.stringify(old);
  legacy=new Store(join(directory,"legacy"),4663);legacy.restore(backup);const state=legacy.custodyLedgerState("robinhood_treasury")!;legacy.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,assetCursors:{[asset]:block(0)}},blocks:[],events:[]});
  const movement=parseAbiItem("event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)");const currentReceipt=f.client.getTransactionReceipt;
  f.client.getTransactionReceipt=async(input:any)=>{const result=await currentReceipt(input);return{...result,logs:[...result.logs,{address:addr(3),logIndex:2,topics:encodeEventTopics({abi:[movement],eventName:"FundsMovement"}),data:encodeAbiParameters([{type:"address"},{type:"address"},{type:"address"},{type:"uint256"},{type:"bytes"}],[addr(3),account,asset,5n,hash(777)])}]};};
  const recovered=await new CustodyLedgerService(legacy,f.client,{id:"robinhood_treasury",account,initialAssets:[asset],confirmations:1n}).reconcile();assert.equal(recovered.ready,true);assert.equal(legacy.custodyLedgerEventPage("robinhood_treasury").length,1,"Canonical reobservation tolerates absent legacy context without duplicating or rewriting financial rows");
 }finally{legacy?.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

const treasuryWeth = BASE_BUYBACK_RH_WETH.toLowerCase() as Address;
async function emptyTreasuryFixture(t: TestContext, scan: Partial<Pick<CustodyOptions, "fastEmptyRanges" | "maxBlocks">> = { fastEmptyRanges: true }) {
  const directory = mkdtempSync(join(tmpdir(), "custody-empty-treasury-")), f = custodyFixture("robinhood_treasury");
  let store = new Store(directory, 4663);
  const options: CustodyOptions = { id: "robinhood_treasury", account, initialAssets: [treasuryWeth], confirmations: 1n, ...scan };
  const headers: bigint[] = [], balances: bigint[] = [], receipts: Hex[] = [], commits: { cursor: string; events: number; blocks: string[] }[] = [];
  const getBlock = f.client.getBlock, readContract = f.client.readContract, receipt = f.client.getTransactionReceipt;
  f.client.getBlock = async (input: any) => { headers.push(input.blockNumber); return getBlock(input); };
  f.client.readContract = async (input: any) => { balances.push(input.blockNumber); return readContract(input); };
  f.client.getTransactionReceipt = async (input: any) => { receipts.push(input.hash); return receipt(input); };
  const observe = () => {
    const commit = store.commitCustodyLedger.bind(store);
    t.mock.method(store, "commitCustodyLedger", (input: CustodyCommit) => {
      commits.push({ cursor: input.state.cursor.number, events: input.events.length, blocks: input.blocks.map(row => row.number) });
      return commit(input);
    });
  };
  observe();
  const service = new CustodyLedgerService(store, f.client, options);
  await service.establishCheckpoint(async () => true);
  const reset = () => { headers.length = 0; balances.length = 0; receipts.length = 0; commits.length = 0; f.queries.length = 0; };
  reset();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...f, service, options, headers, balances, receipts, commits, reset,
    get store() { return store; },
    blocks() {
      const rows: ReturnType<Store["custodyLedgerBlockPage"]> = []; let before: string | undefined;
      for (;;) {
        const page = store.custodyLedgerBlockPage("robinhood_treasury", 500, before); rows.push(...page);
        if (page.length < 500) return rows;
        before = page.at(-1)!.number;
      }
    },
    reopen() { store.close(); store = new Store(directory, 4663); observe(); return new CustodyLedgerService(store, f.client, options); },
    movement(n: number, kind: "in" | "out", amount: string, height: number, overrides: Partial<CustodyEvent> = {}) {
      const row = { ...event(n, kind, amount), asset: treasuryWeth, blockNumber: String(height), blockHash: block(height).hash, ...overrides };
      f.events.push(row); return row;
    } };
}

test("fixed RH WETH fast empty Treasury pages retain only first/end anchors for 1000 real blocks", async t => {
  const f = await emptyTreasuryFixture(t); f.setHead(1001n);
  const report = await f.service.reconcile();
  assert.equal(report.ready, true); assert.equal(report.caughtUp, true); assert.equal(report.indexedThrough, "1000");
  assert.deepEqual(f.store.custodyLedgerBlockPage("robinhood_treasury").map(row => row.number).sort((a, b) => Number(a) - Number(b)), ["0", "1", "1000"]);
  assert.deepEqual(f.commits, [{ cursor: "1000", events: 0, blocks: ["1", "1000"] }]);
  assert.equal(f.queries.length, 2);
  for (const query of f.queries) {
    assert.equal(query.address.toLowerCase(), treasuryWeth); assert.equal(query.fromBlock, 1n); assert.equal(query.toBlock, 1000n);
    assert.equal(query.strict, true);
  }
  assert(f.headers.every(number => [0n, 1n, 1000n].includes(number)), "no synthetic interior header is stored or queried");
  assert.deepEqual(f.balances, [1000n]); assert.equal(f.receipts.length, 0);
  const reopened = f.reopen(); assert.equal((await reopened.read()).ready, true);
  assert.equal(f.store.custodyLedgerState("robinhood_treasury")!.cursor.number, "1000");
});

for (const fastEmptyRanges of [undefined, false]) {
  test(`Treasury ${fastEmptyRanges === false ? "explicit false" : "default"} keeps complete headers and ten-block log ranges`, async t => {
    const f = await emptyTreasuryFixture(t, { fastEmptyRanges }); f.setHead(1001n);
    const report = await f.service.reconcile();
    assert.equal(report.indexedThrough, "1000"); assert.equal(report.ready, true);
    assert.equal(f.blocks().length, 1001);
    assert.equal(new Set(f.headers.filter(number => number > 0n)).size, 1000);
    assert.equal(f.commits.length, 10);
    assert(f.commits.every(commit => commit.blocks.length === 100));
    assert(f.queries.every(query => query.toBlock - query.fromBlock < 10n));
  });
}

test("Treasury fast mode defaults to 1000 per turn and only explicit host fast mode admits 10000", async t => {
  const normal = await emptyTreasuryFixture(t); normal.setHead(20001n);
  assert.equal((await normal.service.reconcile()).indexedThrough, "1000");
  const fast = await emptyTreasuryFixture(t, { fastEmptyRanges: true, maxBlocks: 10_000 }); fast.setHead(20001n);
  assert.equal((await fast.service.reconcile()).indexedThrough, "10000"); assert.equal(fast.commits.length, 10);
  assert(fast.queries.every(query => BigInt(query.toBlock) - BigInt(query.fromBlock) === 999n));
  for (const options of [{ ...fast.options, maxBlocks: 10001 }, { ...fast.options, fastEmptyRanges: false, maxBlocks: 1001 },
    { ...fast.options, fastEmptyRanges: undefined, maxBlocks: 1001 }])
    assert.throws(() => new CustodyLedgerService(fast.store, fast.client, options), /Invalid custody scan bound/);
  for (const options of [{ ...normal.options, id: "base_automation" as const }, { ...normal.options, initialAssets: [asset] },
    { ...normal.options, initialAssets: [] }, { ...normal.options, initialAssets: [treasuryWeth, asset] }])
    assert.throws(() => new CustodyLedgerService(normal.store, normal.client, options), /fixed Robinhood WETH|exact 36 B20 and WETH/);
});

for (const movement of ["positive", "zero", "self", "equal-in-out"] as const) {
  test(`a ${movement} WETH log disables the sparse shortcut and preserves normal receipts/FIFO`, async t => {
    const f = await emptyTreasuryFixture(t); f.setHead(1001n);
    if (movement === "positive") f.movement(1001, "in", "5", 25);
    if (movement === "zero") f.movement(1001, "out", "0", 25);
    if (movement === "self") f.movement(1001, "in", "7", 25, { from: account, to: account });
    if (movement === "equal-in-out") { f.movement(1001, "in", "5", 25); f.movement(1002, "out", "5", 26); }
    const report = await f.service.reconcile();
    assert.equal(report.ready, true); assert.equal(report.indexedThrough, "1000");
    assert.equal(f.commits[0].cursor, "100"); assert.equal(f.commits[0].blocks.length, 100);
    for (let height = 1n; height <= 100n; height++) assert(f.headers.includes(height));
    assert(f.queries.some(query => query.fromBlock === 1n && query.toBlock === 1000n));
    assert(f.queries.some(query => query.fromBlock === 1n && query.toBlock === 10n));
    const rows = f.store.custodyLedgerEventPage("robinhood_treasury");
    assert.equal(rows.length, movement === "positive" ? 1 : movement === "equal-in-out" ? 2 : 0);
    assert.equal(f.receipts.length, rows.length, "zero/self logs still obey the existing no-receipt policy");
    assert.equal(report.assets[0].pending, movement === "positive" ? "5" : "0");
    if (movement === "equal-in-out") assert.deepEqual(report.consumptions[0].fragments, [{ batchId: null, amount: "5" }]);
  });
}

test("nonempty Treasury fallback still rejects a forged receipt before any financial commit", async t => {
  const f = await emptyTreasuryFixture(t); f.setHead(1001n); f.movement(1001, "in", "5", 25);
  const receipt = f.client.getTransactionReceipt;
  f.client.getTransactionReceipt = async (input: any) => ({ ...await receipt(input), blockHash: hash(99999) });
  await assert.rejects(f.service.reconcile(), /canonical successful receipt/);
  assert.equal(f.store.custodyLedgerState("robinhood_treasury")!.cursor.number, "0");
  assert.equal(f.store.custodyLedgerEventPage("robinhood_treasury").length, 0);
});

test("a provider that refuses broad WETH logs falls back to the unchanged bounded scan", async t => {
  const f = await emptyTreasuryFixture(t); f.setHead(1001n);
  const logs = f.client.getLogs;
  let broadFailures = 0;
  f.client.getLogs = async (input: any) => {
    if (input.toBlock - input.fromBlock >= 10n) { broadFailures++; throw new Error("range exceeds provider limit"); }
    return logs(input);
  };
  const report = await f.service.reconcile();
  assert.equal(report.ready, true); assert.equal(report.indexedThrough, "1000"); assert(broadFailures > 0);
  assert(f.queries.every(query => query.toBlock - query.fromBlock < 10n));
  assert.equal(f.blocks().length, 1001);
  assert(f.commits.every(commit => commit.blocks.length === 100));
});

test("a balance change without matching logs cannot fast-forward a Treasury range", async t => {
  const f = await emptyTreasuryFixture(t); f.setHead(1001n);
  const read = f.client.readContract;
  f.client.readContract = async (input: any) => input.blockNumber === 1000n ? 1n : read(input);
  const report = await f.service.reconcile();
  assert.equal(report.ready, false); assert.equal(report.assets[0].basePending, "0");
  assert.equal(f.commits.length, 10); assert(f.commits.every(commit => commit.blocks.length === 100));
  assert.equal(f.blocks().length, 1001);
});

test("empty-range balance RPC failure retains the funded cursor/events and is retryable", async t => {
  const f = await emptyTreasuryFixture(t); f.setHead(1001n); const incoming = f.movement(1001, "in", "5", 25);
  await f.service.reconcile(); f.reset(); f.setHead(2001n);
  const before = f.store.custodyLedgerState("robinhood_treasury")!, rows = f.store.custodyLedgerEventPage("robinhood_treasury");
  const read = f.client.readContract;
  f.client.readContract = async (input: any) => { if (input.blockNumber === 2000n) throw new Error("archive capacity unavailable"); return read(input); };
  await assert.rejects(f.service.reconcile(), /empty range state unavailable/);
  assert.deepEqual(f.store.custodyLedgerState("robinhood_treasury"), before); assert.deepEqual(f.store.custodyLedgerEventPage("robinhood_treasury"), rows);
  f.client.readContract = read;
  const recovered = await f.reopen().reconcile();
  assert.equal(recovered.ready, true); assert.equal(recovered.assets[0].pending, "5");
  assert.equal(f.store.custodyLedgerEventPage("robinhood_treasury")[0].id, incoming.id);
});

for (const race of ["cursor", "first-parent", "first-hash", "end-hash"] as const) {
  test(`empty Treasury ${race} changes cannot append an unverified sparse page`, async t => {
    const f = await emptyTreasuryFixture(t); f.setHead(1001n);
    const before = f.store.custodyLedgerState("robinhood_treasury")!, getBlock = f.client.getBlock;
    const seen = new Map<bigint, number>();
    f.client.getBlock = async (input: any) => {
      const height = input.blockNumber as bigint, count = (seen.get(height) ?? 0) + 1; seen.set(height, count);
      const row = await getBlock(input);
      if (race === "cursor" && height === 0n && count > 1) return { ...row, hash: hash(99000) };
      if (race === "first-parent" && height === 1n) return { ...row, parentHash: hash(99000) };
      if (race === "first-hash" && height === 1n && count > 1) return { ...row, hash: hash(99001) };
      if (race === "end-hash" && height === 1000n && count > 1) return { ...row, hash: hash(991000) };
      return row;
    };
    await assert.rejects(f.service.reconcile(), /empty range ancestry changed|empty range changed during collection/);
    assert.deepEqual(f.store.custodyLedgerState("robinhood_treasury"), before);
    assert.equal(f.store.custodyLedgerBlockPage("robinhood_treasury").length, 1);
    assert.equal(f.commits.length, 0);
  });
}

test("empty-range deadline expires before commit without changing persistent financial state", async t => {
  const f = await emptyTreasuryFixture(t); let now = 1000; t.mock.method(Date, "now", () => now);
  f.setHead(1001n); const before = f.store.custodyLedgerState("robinhood_treasury")!, logs = f.client.getLogs;
  f.client.getLogs = async (input: any) => { const rows = await logs(input); now += 60; return rows; };
  const report = await f.service.reconcile(50);
  assert.equal(report.ready, false); assert.match(report.reason!, /budget reached/);
  assert.deepEqual(f.store.custodyLedgerState("robinhood_treasury"), before); assert.equal(f.commits.length, 0);
});

test("a completed sparse page survives a later empty-range deadline", async t => {
  const f = await emptyTreasuryFixture(t, { fastEmptyRanges: true, maxBlocks: 2000 });
  let now = 1000; t.mock.method(Date, "now", () => now); f.setHead(2001n);
  const logs = f.client.getLogs;
  f.client.getLogs = async (input: any) => { const rows = await logs(input); if (input.fromBlock > 1000n) now += 60; return rows; };
  const report = await f.service.reconcile(50);
  assert.equal(report.ready, false); assert.match(report.reason!, /budget reached/);
  assert.equal(f.store.custodyLedgerState("robinhood_treasury")!.cursor.number, "1000");
  assert.deepEqual(f.commits.map(commit => commit.cursor), ["1000"]);
});

test("a sparse-page CAS conflict cannot overwrite another revision or erase prior real funds", async t => {
  const f = await emptyTreasuryFixture(t); f.setHead(1001n); f.movement(1001, "in", "5", 25);
  await f.service.reconcile(); f.reset(); f.setHead(2001n);
  const before = f.store.custodyLedgerState("robinhood_treasury")!, rows = f.store.custodyLedgerEventPage("robinhood_treasury");
  const commit = f.store.commitCustodyLedger.bind(f.store); let conflicted = false;
  t.mock.method(f.store, "commitCustodyLedger", (input: CustodyCommit) => {
    if (!conflicted) { conflicted = true; commit({ expectedRevision: before.revision, state: { ...before, revision: before.revision + 1, updatedAt: Date.now() }, blocks: [], events: [] }); }
    return commit(input);
  });
  await assert.rejects(f.service.reconcile(), /revision/);
  assert.equal(f.store.custodyLedgerState("robinhood_treasury")!.revision, before.revision + 1);
  assert.equal(f.store.custodyLedgerState("robinhood_treasury")!.cursor.number, before.cursor.number);
  assert.deepEqual(f.store.custodyLedgerEventPage("robinhood_treasury"), rows);
  assert.equal((await f.service.read()).assets[0].pending, "5");
});

for (const forkAt of [2500n, 1500n]) {
  test(`restart replays a ${forkAt === 2500n ? "shallow" : "deep"} sparse-anchor reorg without losing canonical money`, async t => {
    const f = await emptyTreasuryFixture(t, { fastEmptyRanges: true, maxBlocks: 6000 });
    f.setHead(6001n); const incoming = f.movement(1001, "in", "5", 25);
    await f.service.reconcile();
    const cursor = f.store.custodyLedgerState("robinhood_treasury")!.cursor.number;
    assert.equal(cursor, "6000"); const rows = f.store.custodyLedgerEventPage("robinhood_treasury");
    const getBlock = f.client.getBlock;
    f.client.getBlock = async (input: any) => {
      const height = input.blockNumber as bigint, row = await getBlock(input);
      return height >= forkAt ? { ...row, hash: hash(100000 + Number(height)), parentHash: height === forkAt ? block(Number(height - 1n)).hash : hash(99999 + Number(height)) } : row;
    };
    const reopened = f.reopen(), recovered = await reopened.reconcile();
    assert.equal(recovered.ready, true); assert.equal(recovered.assets[0].pending, "5"); assert.equal(recovered.indexedThrough, "6000");
    assert.deepEqual(f.store.custodyLedgerEventPage("robinhood_treasury"), rows);
    assert.equal(f.store.custodyLedgerEventPage("robinhood_treasury").filter(row => row.id === incoming.id).length, 1);
    assert.equal(f.store.custodyLedgerState("robinhood_treasury")!.cursor.hash, hash(106000));
  });
}

for (const lag of [50n, 4100n]) {
  test(`a restarted sparse Treasury ledger with RPC lag ${lag} preserves all funds and anchors`, async t => {
    const f = await emptyTreasuryFixture(t, { fastEmptyRanges: true, maxBlocks: 6000 });
    f.setHead(6001n); f.movement(1001, "in", "5", 25); await f.service.reconcile();
    const before = f.store.custodyLedgerState("robinhood_treasury")!, rows = f.store.custodyLedgerEventPage("robinhood_treasury"), anchors = f.store.custodyLedgerBlockPage("robinhood_treasury");
    f.setHead(6001n - lag); f.reset();
    const reopened = f.reopen(), report = await reopened.reconcile();
    assert.equal(report.ready, false); assert.match(report.reason!, /RPC is behind/);
    assert.deepEqual(f.store.custodyLedgerState("robinhood_treasury"), before);
    assert.deepEqual(f.store.custodyLedgerEventPage("robinhood_treasury"), rows);
    assert.deepEqual(f.store.custodyLedgerBlockPage("robinhood_treasury"), anchors); assert.equal(f.queries.length, 0);
    f.setHead(6001n); assert.equal((await reopened.read()).assets[0].pending, "5");
  });
}

const baseProofAssets = [...STOCKS.map(stock => stock.address), BASE_BUYBACK_WETH].map(asset => asset.toLowerCase()) as Address[];
async function emptyBaseFixture(t: TestContext, scan: Partial<Pick<CustodyOptions, "fastEmptyRanges" | "maxBlocks">> = { fastEmptyRanges: true }, opening: Record<string, bigint> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "custody-empty-base-")), f = custodyFixture();
  let store = new Store(directory, 8453), discover: CustodyOptions["discoverAssets"] = async () => [];
  const discoveries: { from: bigint; to: bigint }[] = [], headers: bigint[] = [], balances: { asset: string; height: bigint }[] = [];
  const receipts: Hex[] = [], commits: CustodyCommit[] = [];
  const options: CustodyOptions = { id: "base_automation", account, initialAssets: baseProofAssets, confirmations: 1n, ...scan,
    discoverAssets: async (from, to, deadline) => { discoveries.push({ from, to }); return discover!(from, to, deadline); } };
  const getBlock = f.client.getBlock, read = f.client.readContract, receipt = f.client.getTransactionReceipt;
  f.client.getBlock = async (input: any) => { headers.push(input.blockNumber); return getBlock(input); };
  f.client.readContract = async (input: any) => { balances.push({ asset: input.address.toLowerCase(), height: input.blockNumber }); return await read(input) + (opening[input.address.toLowerCase()] ?? 0n); };
  f.client.getTransactionReceipt = async (input: any) => { receipts.push(input.hash); return receipt(input); };
  const observe = () => {
    const commit = store.commitCustodyLedger.bind(store);
    t.mock.method(store, "commitCustodyLedger", (input: CustodyCommit) => { commits.push(structuredClone(input)); return commit(input); });
  };
  observe();
  const service = new CustodyLedgerService(store, f.client, options);
  await service.establishCheckpoint(async () => true);
  const reset = () => { discoveries.length = 0; headers.length = 0; balances.length = 0; receipts.length = 0; commits.length = 0; f.queries.length = 0; };
  reset(); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...f, service, options, discoveries, headers, balances, receipts, commits, reset,
    get store() { return store; },
    discoverWith(callback: NonNullable<CustodyOptions["discoverAssets"]>) { discover = callback; },
    reopen() { store.close(); store = new Store(directory, 8453); observe(); return new CustodyLedgerService(store, f.client, options); },
    movement(n: number, token: Address, amount: string, height: number, kind: "in" | "out" = "in", overrides: Partial<CustodyEvent> = {}) {
      const row = { ...event(n, kind, amount), asset: token.toLowerCase() as Address, blockNumber: String(height), blockHash: block(height).hash, ...overrides };
      f.events.push(row); return row;
    } };
}

test("Base fast proof requires the exact unique 36 B20/WETH set and an actual discovery callback", async t => {
  const f = await emptyBaseFixture(t);
  assert.equal(baseProofAssets.length, 37);
  for (const initialAssets of [baseProofAssets.slice(0, 36), [...baseProofAssets, asset],
    [...baseProofAssets.slice(0, 36), baseProofAssets[0]], [...baseProofAssets.slice(0, 36), treasuryWeth],
    [asset, ...baseProofAssets.slice(1)]])
    assert.throws(() => new CustodyLedgerService(f.store, f.client, { ...f.options, initialAssets }), /exact 36 B20 and WETH/);
  assert.throws(() => new CustodyLedgerService(f.store, f.client, { ...f.options, discoverAssets: undefined }), /release discovery/);
  assert.throws(() => new CustodyLedgerService(f.store, f.client, { ...f.options, maxBlocks: 1001 }), /Invalid custody scan bound/);
  assert.doesNotThrow(() => new CustodyLedgerService(f.store, f.client, { ...f.options, initialAssets: [...baseProofAssets].reverse().map(asset => `0x${asset.slice(2).toUpperCase()}` as Address) }));
  assert.doesNotThrow(() => new CustodyLedgerService(f.store, f.client, { ...f.options, fastEmptyRanges: false, initialAssets: [asset], discoverAssets: undefined }));
});

test("Base empty100 proof reads all37 balances and all20 directional log ranges, storing only real boundary headers", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n);
  const report = await f.service.reconcile();
  assert.equal(report.ready, true); assert.equal(report.caughtUp, true); assert.equal(report.indexedThrough, "100");
  assert.deepEqual(f.discoveries, [{ from: 1n, to: 100n }]); assert.equal(f.queries.length, 20);
  assert.equal(f.balances.length, 37); assert.equal(new Set(f.balances.map(row => row.asset)).size, 37);
  assert(f.balances.every(row => row.height === 100n));
  for (const query of f.queries) {
    assert.deepEqual(new Set(query.address), new Set(baseProofAssets)); assert(query.toBlock - query.fromBlock < 10n);
    assert.equal(query.strict, true);
  }
  assert.deepEqual(f.commits.map(input => input.blocks.map(row => row.number)), [["1", "100"]]);
  assert.equal(f.commits[0].events.length, 0); assert(f.headers.every(height => [0n, 1n, 100n].includes(height)));
  assert.deepEqual(f.store.custodyLedgerBlockPage("base_automation").map(row => row.number).sort((a, b) => Number(a) - Number(b)), ["0", "1", "100"]);
  assert.equal((await f.reopen().read()).ready, true);
});

for (const fastEmptyRanges of [undefined, false]) test(`Base ${fastEmptyRanges === false ? "false" : "default"} scan still keeps100 complete headers`, async t => {
  const f = await emptyBaseFixture(t, { fastEmptyRanges }); f.setHead(101n);
  assert.equal((await f.service.reconcile()).ready, true);
  assert.deepEqual(f.discoveries, [{ from: 1n, to: 100n }]); assert.equal(f.commits[0].blocks.length, 100);
  assert.equal(new Set(f.headers.filter(height => height > 0n)).size, 100);
});

test("Base fast mode retains the1000-per-turn bound and discovers each separate100 page exactly once", async t => {
  const f = await emptyBaseFixture(t); f.setHead(2001n);
  assert.equal((await f.service.reconcile()).indexedThrough, "1000"); assert.equal(f.commits.length, 10);
  assert.deepEqual(f.discoveries, Array.from({ length: 10 }, (_, index) => ({ from: BigInt(index * 100 + 1), to: BigInt((index + 1) * 100) })));
  assert(f.commits.every(input => input.blocks.length === 2 && input.events.length === 0));
});

test("failed or malformed Base discovery never becomes an empty proof and remains retryable", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); const before = f.store.custodyLedgerState("base_automation")!;
  for (const callback of [async () => { throw new Error("release logs RPC unavailable"); }, async () => undefined as any]) {
    f.reset(); f.discoverWith(callback);
    await assert.rejects(f.service.reconcile(), /RPC unavailable|release discovery unavailable/);
    assert.equal(f.discoveries.length, 1); assert.equal(f.queries.length, 0); assert.equal(f.commits.length, 0);
    assert.deepEqual(f.store.custodyLedgerState("base_automation"), before);
  }
  f.discoverWith(async () => []); assert.equal((await f.service.reconcile()).ready, true);
});

for (const name of ["meme fee", "untracked release"]) test(`a newly discovered ${name} preserves the full path and actual transfer`, async t => {
  const f = await emptyBaseFixture(t), meme = addr(name === "meme fee" ? 4001 : 4002); f.setHead(101n); f.undeployed.add(meme);
  f.discoverWith(async () => [meme]); const row = f.movement(1001, meme, "7", 25);
  await f.service.reconcile();
  assert.equal(f.discoveries.length, 1); assert.equal(f.commits[0].blocks.length, 100);
  assert(f.queries.every(query => query.address.includes(meme)), "discovered token participates in the ordinary canonical scan");
  assert.equal(f.store.custodyLedgerEventPage("base_automation").filter(event => event.id === row.id).length, 1);
  assert(f.store.custodyLedgerState("base_automation")!.releasedAssets!.includes(meme));
});

for (const height of [1, 55, 100]) for (const noop of [false, true]) test(`Base raw ${noop ? "zero" : "positive"} log at${height} disables empty proof and reuses discovery`, async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); f.movement(1001, baseProofAssets[0], noop ? "0" : "5", height);
  const report = await f.service.reconcile();
  assert.equal(report.ready, true); assert.equal(f.discoveries.length, 1); assert.equal(f.commits[0].blocks.length, 100);
  assert.equal(f.store.custodyLedgerEventPage("base_automation").length, noop ? 0 : 1); assert.equal(f.receipts.length, noop ? 0 : 1);
  assert.equal(report.assets.find(row => row.asset === baseProofAssets[0])!.pending, noop ? "0" : "5");
});

test("Base self-transfers also force the complete scan while remaining economic noops", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); f.movement(1001, baseProofAssets[0], "8", 55, "in", { from: account, to: account });
  assert.equal((await f.service.reconcile()).ready, true); assert.equal(f.discoveries.length, 1);
  assert.equal(f.commits[0].blocks.length, 100); assert.equal(f.store.custodyLedgerEventPage("base_automation").length, 0);
});

for (const tokenIndex of [0, 18, 36]) test(`Base asset${tokenIndex} balance difference forces complete headers and withholds only that asset`, async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); const read = f.client.readContract;
  f.client.readContract = async (input: any) => input.address.toLowerCase() === baseProofAssets[tokenIndex] && input.blockNumber === 100n ? 1n : read(input);
  const report = await f.service.reconcile();
  assert.equal(f.discoveries.length, 1); assert.equal(f.commits[0].blocks.length, 100);
  assert.equal(report.assets.find(row => row.asset === baseProofAssets[tokenIndex])!.ready, false);
  assert.equal(report.assets.find(row => row.asset === baseProofAssets[(tokenIndex + 1) % 37])!.ready, true);
});

for (const { tokenIndex, invalid } of [
  { tokenIndex: 0, invalid: "rpc" }, { tokenIndex: 18, invalid: "rpc" }, { tokenIndex: 36, invalid: "rpc" },
  { tokenIndex: 18, invalid: 0 }, { tokenIndex: 18, invalid: "0" }, { tokenIndex: 18, invalid: -1n },
]) test(`Base asset${tokenIndex} ${typeof invalid}:${String(invalid)} proof failure falls back to complete isolated accounting and recovers`, async t => {
  const bad = baseProofAssets[tokenIndex], healthy = baseProofAssets[(tokenIndex + 1) % 37];
  const f = await emptyBaseFixture(t, { fastEmptyRanges: true }, { [bad]: 3n, [healthy]: 7n }); f.setHead(101n);
  const read = f.client.readContract;
  // Genuine offline opening lots, not transfers hidden in the page: the proof
  // reaches all37 balance reads before the bad result forces the full scan.
  const failedRead = (reader: typeof read) => async (input: any) => {
    if (input.address.toLowerCase() === bad && input.blockNumber === 100n) {
      if (invalid === "rpc") throw new Error("one archive state unavailable"); return invalid;
    }
    return reader(input);
  };
  f.client.readContract = failedRead(read);
  const report = await f.service.reconcile(), stored = f.store.custodyLedgerState("base_automation")!;
  assert.equal(report.ready, true); assert.equal(report.indexedThrough, "100"); assert.equal(f.discoveries.length, 1);
  assert.equal(f.commits[0].blocks.length, 100); assert.equal(f.queries.length, 40, "proof logs then complete canonical fallback, with no repeated discovery");
  assert.equal(report.assets.filter(row => row.ready).length, 36); assert.equal(report.assets.find(row => row.asset === bad)!.ready, false);
  assert.equal(report.assets.find(row => row.asset === healthy)!.pending, "7"); assert.equal(report.assets.find(row => row.asset === bad)!.pending, "3");
  assert.deepEqual(Object.keys(stored.assetErrors!), [bad]); assert.equal(stored.openingBalances[bad], "3");
  assert.equal(stored.observedBalances[bad], undefined, "invalid/RPC output is never stored as zero");
  assert.equal(report.assets.reduce((sum, row) => sum + BigInt(row.pending), 0n), 10n);
  const ordinary = await emptyBaseFixture(t, { fastEmptyRanges: false }, { [bad]: 3n, [healthy]: 7n }); ordinary.setHead(101n);
  ordinary.client.readContract = failedRead(ordinary.client.readContract);
  const control = await ordinary.service.reconcile();
  assert.deepEqual(report.assets, control.assets, "the optimization failure has the exact same per-asset accounting as the complete scan");
  assert.equal(report.ready, control.ready); assert.deepEqual(report.consumptions, control.consumptions);
  f.client.readContract = read;
  const recovered = await f.service.reconcile(), recoveredState = f.store.custodyLedgerState("base_automation")!;
  assert.equal(recovered.assets.filter(row => row.ready).length, 37); assert.deepEqual(recoveredState.assetErrors, {});
  assert.equal(recoveredState.observedBalances[bad], "3");
  assert.equal(recovered.assets.reduce((sum, row) => sum + BigInt(row.pending), 0n), 10n);
  f.reset(); f.setHead(201n);
  const normal = await f.service.reconcile();
  assert.equal(normal.ready, true); assert.equal(normal.indexedThrough, "200");
  assert.deepEqual(f.commits[0].blocks.map(row => row.number), ["101", "200"], "successful canonical balances permit the normal empty proof again");
  assert.equal(normal.assets.reduce((sum, row) => sum + BigInt(row.pending), 0n), 10n);
});

test("Base proof awaits every directional query before reporting a single log RPC failure", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n);
  let release!: () => void, started!: () => void, calls = 0, finished = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), allStarted = new Promise<void>(resolve => { started = resolve; });
  const logs = f.client.getLogs;
  f.client.getLogs = async (input: any) => {
    const number = ++calls; if (calls === 20) started();
    if (number === 2) await held;
    finished++; if (number === 1) throw new Error("first range temporarily unavailable"); return logs(input);
  };
  let settled = false;
  const rejected = assert.rejects(f.service.reconcile().finally(() => { settled = true; }), /empty range logs unavailable/);
  await allStarted; await Promise.resolve(); assert.equal(settled, false);
  release(); await rejected;
  assert.equal(finished, 20); assert.equal(f.commits.length, 0); assert.equal(f.store.custodyLedgerState("base_automation")!.cursor.number, "0");
});

for (const dirty of ["released", "cursor", "backfill", "extra-opening", "missing-observed"] as const) test(`Base ${dirty} state cannot use the initial37-only shortcut`, async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); const before = f.store.custodyLedgerState("base_automation")!;
  const next: CustodyState = { ...before, revision: before.revision + 1 };
  if (dirty === "released") next.releasedAssets = [baseProofAssets[0]];
  if (dirty === "cursor") next.assetCursors = { [baseProofAssets[0]]: block(0) };
  if (dirty === "backfill") next.assetBackfillAt = { [baseProofAssets[0]]: 1 };
  if (dirty === "extra-opening") next.openingBalances = { ...before.openingBalances, [asset]: "0" };
  if (dirty === "missing-observed") { next.observedBalances = { ...before.observedBalances }; delete next.observedBalances[baseProofAssets[0]]; }
  f.store.commitCustodyLedger({ expectedRevision: before.revision, state: next, blocks: [], events: [] }); f.reset();
  await f.service.reconcile(); assert.equal(f.discoveries.length, 1); assert.equal(f.commits[0].blocks.length, 100);
});

for (const discovered of [false, true]) test(`Base reorg during ${discovered ? "new-asset" : "empty"} discovery cannot advance or reuse old evidence on the new branch`, async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); const before = f.store.custodyLedgerState("base_automation")!, getBlock = f.client.getBlock;
  let forked = false;
  f.client.getBlock = async (input: any) => {
    const row = await getBlock(input), height = Number(input.blockNumber);
    return forked && height > 0 ? { ...row, hash: hash(80000 + height), parentHash: height === 1 ? block(0).hash : hash(79999 + height) } : row;
  };
  f.discoverWith(async () => { forked = true; return discovered ? [baseProofAssets[0]] : []; });
  await assert.rejects(f.service.reconcile(), /empty range changed during collection|page anchor changed before commit/);
  assert.equal(f.discoveries.length, 1); assert.equal(f.commits.length, 0);
  assert.deepEqual(f.store.custodyLedgerState("base_automation"), before);
});

for (const race of ["cursor", "first-parent", "first-hash", "end-hash"] as const) test(`Base empty-proof ${race} race cannot commit boundary shortcuts`, async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); const before = f.store.custodyLedgerState("base_automation")!, getBlock = f.client.getBlock;
  const reads = new Map<bigint, number>();
  f.client.getBlock = async (input: any) => {
    const height = input.blockNumber as bigint, count = (reads.get(height) ?? 0) + 1; reads.set(height, count); const row = await getBlock(input);
    if (race === "cursor" && height === 0n && count > 1) return { ...row, hash: hash(99000) };
    if (race === "first-parent" && height === 1n) return { ...row, parentHash: hash(99000) };
    if (race === "first-hash" && height === 1n && count > 1) return { ...row, hash: hash(99001) };
    if (race === "end-hash" && height === 100n && count > 1) return { ...row, hash: hash(99100) };
    return row;
  };
  await assert.rejects(f.service.reconcile(), /empty range ancestry changed|empty range changed during collection/);
  assert.deepEqual(f.store.custodyLedgerState("base_automation"), before); assert.equal(f.commits.length, 0);
});

test("Base discovery deadline retains the prior state without starting Transfer or balance work", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); let now = 1000; t.mock.method(Date, "now", () => now);
  const before = f.store.custodyLedgerState("base_automation")!;
  f.discoverWith(async () => { now += 60; return []; });
  const report = await f.service.reconcile(50);
  assert.equal(report.ready, false); assert.match(report.reason!, /budget reached/);
  assert.deepEqual(f.store.custodyLedgerState("base_automation"), before); assert.equal(f.commits.length, 0); assert.equal(f.queries.length, 0);
});

test("Base empty-proof CAS collision preserves prior actual token funds", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); f.movement(1001, baseProofAssets[0], "5", 25); await f.service.reconcile();
  f.reset(); f.setHead(201n); const before = f.store.custodyLedgerState("base_automation")!, rows = f.store.custodyLedgerEventPage("base_automation");
  const commit = f.store.commitCustodyLedger.bind(f.store); let conflicted = false;
  t.mock.method(f.store, "commitCustodyLedger", (input: CustodyCommit) => {
    if (!conflicted) { conflicted = true; commit({ expectedRevision: before.revision, state: { ...before, revision: before.revision + 1 }, blocks: [], events: [] }); }
    return commit(input);
  });
  await assert.rejects(f.service.reconcile(), /revision/);
  assert.equal(f.store.custodyLedgerState("base_automation")!.cursor.number, "100");
  assert.deepEqual(f.store.custodyLedgerEventPage("base_automation"), rows);
  assert.equal((await f.service.read()).assets.find(row => row.asset === baseProofAssets[0])!.pending, "5");
});

for (const lag of [50n, 4100n]) test(`Base sparse restart with RPC lag${lag} never rolls back actual fees`, async t => {
  const f = await emptyBaseFixture(t); f.setHead(5001n); f.movement(1001, baseProofAssets[0], "5", 25);
  for (let turn = 0; turn < 5; turn++) await f.service.reconcile();
  const before = f.store.custodyLedgerState("base_automation")!, rows = f.store.custodyLedgerEventPage("base_automation"), anchors = f.store.custodyLedgerBlockPage("base_automation");
  assert.equal(before.cursor.number, "5000"); f.setHead(5001n - lag); f.reset();
  const report = await f.reopen().reconcile();
  assert.equal(report.ready, false); assert.match(report.reason!, /RPC is behind/);
  assert.deepEqual(f.store.custodyLedgerState("base_automation"), before); assert.deepEqual(f.store.custodyLedgerEventPage("base_automation"), rows);
  assert.deepEqual(f.store.custodyLedgerBlockPage("base_automation"), anchors); assert.equal(f.discoveries.length, 0); assert.equal(f.queries.length, 0);
});

test("Base proof cannot commit partial37-asset balances when the maintenance deadline expires", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); let now = 1000; t.mock.method(Date, "now", () => now);
  const before = f.store.custodyLedgerState("base_automation")!, read = f.client.readContract;
  f.client.readContract = async (input: any) => { const result = await read(input); now += 5; return result; };
  const report = await f.service.reconcile(50);
  assert.equal(report.ready, false); assert.match(report.reason!, /budget reached/);
  assert.deepEqual(f.store.custodyLedgerState("base_automation"), before); assert.equal(f.commits.length, 0);
});

test("Base existing asset errors remain on the complete isolated accounting path", async t => {
  const f = await emptyBaseFixture(t); f.setHead(101n); const before = f.store.custodyLedgerState("base_automation")!;
  f.store.commitCustodyLedger({ expectedRevision: before.revision, state: { ...before, revision: before.revision + 1,
    assetErrors: { [baseProofAssets[0]]: "Canonical token balance unavailable" } }, blocks: [], events: [] });
  f.fail.add(baseProofAssets[0]); f.reset();
  const report = await f.service.reconcile();
  assert.equal(f.discoveries.length, 1); assert.equal(f.commits.find(input => input.blocks.length)!.blocks.length, 100);
  assert.equal(report.assets.find(row => row.asset === baseProofAssets[0])!.ready, false);
  assert.equal(report.assets.find(row => row.asset === baseProofAssets[1])!.ready, true);
});

for (const forkAt of [4900n, 500n]) test(`Base ${forkAt === 4900n ? "shallow" : "deep"} sparse reorg after restart replays actual funds without duplication`, async t => {
  const f = await emptyBaseFixture(t); f.setHead(5001n); const incoming = f.movement(1001, baseProofAssets[0], "5", 25);
  for (let turn = 0; turn < 5; turn++) await f.service.reconcile();
  const rows = f.store.custodyLedgerEventPage("base_automation"), getBlock = f.client.getBlock;
  f.client.getBlock = async (input: any) => {
    const row = await getBlock(input), height = input.blockNumber as bigint;
    return height >= forkAt ? { ...row, hash: hash(100000 + Number(height)), parentHash: height === forkAt ? block(Number(height - 1n)).hash : hash(99999 + Number(height)) } : row;
  };
  const reopened = f.reopen();
  for (let turn = 0; turn < 5; turn++) await reopened.reconcile();
  const report = await reopened.read();
  assert.equal(report.ready, true); assert.equal(report.caughtUp, true); assert.equal(report.indexedThrough, "5000");
  assert.equal(report.assets.find(row => row.asset === baseProofAssets[0])!.pending, "5");
  assert.deepEqual(f.store.custodyLedgerEventPage("base_automation"), rows);
  assert.equal(f.store.custodyLedgerEventPage("base_automation").filter(row => row.id === incoming.id).length, 1);
  assert.equal(f.store.custodyLedgerState("base_automation")!.cursor.hash, hash(105000));
});
