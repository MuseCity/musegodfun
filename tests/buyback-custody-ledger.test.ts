import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { readAllCustodyEvents } from "../server/buyback-custody-ledger";
import { convertCustodyFragments, replayCustodyLedger, type CustodyEvent, type CustodyState } from "../src/lib/buyback-custody-ledger";
import { vaultEventId } from "../src/lib/buyback-vault-ledger";
import type { Address, Hex } from "viem";
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
