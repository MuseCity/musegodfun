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
  assert.equal(store.custodyLedgerEventPage("base_automation",1)[0].fragments![0].batchId,incoming.id);assert.equal((await ledger.read()).ready,false);
  rpcAvailable=true;sourceIsBase=false;await ledger.classify(incoming.id,[{batchId:null,amount:"5"}],incoming.evidence!);assert.equal((await ledger.read()).ready,true);assert.equal((await ledger.read()).assets[0].basePending,"0");
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
