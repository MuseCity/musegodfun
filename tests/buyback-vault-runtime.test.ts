import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { runtimeFromEnv } from "../server/config";
import { assertNativeCustodyReadiness, createVaultLedgerRuntime, openVaultLedgerReadOnlyStore, readCanonicalBaseSourceBatches } from "../server/buyback-vault-runtime";
import { BASE_BUYBACK_PROTOCOL } from "../src/lib/base-buyback";
import { emptyCustodyReport, type CustodyState } from "../src/lib/buyback-custody-ledger";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import type { Address, Hex } from "viem";
const addr=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const block={number:"0",hash:hash(1),parentHash:hash(0)};
test("canonical native source pagination retains >1000 batches and excludes the old protocol",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-batches-")),store=new Store(directory,8453);
 try {for(let index=0;index<1201;index++)store.saveBuybackBatch({id:`native-${index}`,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,updatedAt:1});
  store.saveBuybackBatch({id:"old-across",protocol:"lifi_across_weth_v1",sourceChainId:8453,destinationChainId:4663,updatedAt:1});
  assert.equal((await readCanonicalBaseSourceBatches(store)).length,1201);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("peer custody reads cannot initialize, classify or reconcile another chain",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-peer-")),runtime=runtimeFromEnv(8453,{CHAIN_MODE:"base",DATA_DIR:directory});const store=new Store(runtime.dataDir,8453);
 const state:CustodyState={version:1,id:"base_automation",chainId:8453,account:addr(5),revision:1,checkpoint:block,cursor:block,openingBalances:{},observedBalances:{},updatedAt:1,blockedReason:null};
 try {store.commitCustodyLedger({expectedRevision:0,state,blocks:[block],events:[]});const peer=await openVaultLedgerReadOnlyStore(runtime);
  try {assert.deepEqual(await peer.custodyLedgerState("base_automation"),state);assert.throws(()=>peer.commitCustodyLedger({expectedRevision:1,state:{...state,revision:2},blocks:[],events:[]}),/read-only/);}finally{await peer.close();}
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("readiness requires canonical caught-up Automation, Treasury and Vault independently",()=>{
 const report={ready:true,reason:null,automation:{...emptyCustodyReport("base_automation"),ready:true,caughtUp:true},treasury:{...emptyCustodyReport("robinhood_treasury"),ready:true,caughtUp:true},vault:{...emptyVaultLedgerReport(1n),attributionReady:true,caughtUp:true}};
 assert.doesNotThrow(()=>assertNativeCustodyReadiness(report));
 for(const changed of [{ready:false},{automation:{...report.automation,caughtUp:false}},{treasury:{...report.treasury,ready:false}},{vault:{...report.vault,attributionReady:false}}])assert.throws(()=>assertNativeCustodyReadiness({...report,...changed}),/checkpoints/);
});
test("undeployed and fork runtime remain unavailable and perform no implicit peer/mainnet journal writes",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-fork-")),runtime=runtimeFromEnv(8453,{CHAIN_MODE:"fork",FORK_CHAIN_ID:"8453",DATA_DIR:directory}),store=new Store(runtime.dataDir,31337);
 let peers=0;const ledger=createVaultLedgerRuntime({runtime,store,client:{} as any},{openPeerStore:async()=>{peers++;throw new Error("no peer");}});
 try{assert.equal((await ledger.custody()).ready,false);assert.equal((await ledger.read()).attributionReady,false);assert.equal(peers,0);await assert.rejects(()=>ledger.initialize(),/canonical runtime/);await assert.rejects(()=>ledger.reconcile(),/canonical runtime/);}finally{await ledger.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
