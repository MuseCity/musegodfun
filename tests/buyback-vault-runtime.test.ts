import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { BASE_COLLECTOR_MANIFEST } from "../server/base-collector";
import { runtimeFromEnv } from "../server/config";
import { assertNativeCustodyReadiness, createVaultLedgerRuntime, openVaultLedgerReadOnlyStore, readCanonicalBaseSourceBatches } from "../server/buyback-vault-runtime";
import { BASE_BUYBACK_PROTOCOL } from "../src/lib/base-buyback";
import { sameAddress } from "../src/lib/config";
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
test("readiness requires canonical bounded-fresh Automation, Treasury and Vault independently",()=>{
 const report={ready:true,reason:null,automation:{...emptyCustodyReport("base_automation"),ready:true,caughtUp:false,fresh:true},treasury:{...emptyCustodyReport("robinhood_treasury"),ready:true,caughtUp:false,fresh:true},vault:{...emptyVaultLedgerReport(1n),attributionReady:true,caughtUp:false,fresh:true}};
 assert.doesNotThrow(()=>assertNativeCustodyReadiness(report));
 for(const changed of [{ready:false},{automation:{...report.automation,fresh:false}},{treasury:{...report.treasury,ready:false}},{vault:{...report.vault,attributionReady:false}}])assert.throws(()=>assertNativeCustodyReadiness({...report,...changed}),/checkpoints/);
});
test("undeployed and fork runtime remain unavailable and perform no implicit peer/mainnet journal writes",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-fork-")),runtime=runtimeFromEnv(8453,{CHAIN_MODE:"fork",FORK_CHAIN_ID:"8453",DATA_DIR:directory}),store=new Store(runtime.dataDir,31337);
 let peers=0;const ledger=createVaultLedgerRuntime({runtime,store,client:{} as any},{openPeerStore:async()=>{peers++;throw new Error("no peer");}});
 try{assert.equal((await ledger.custody()).ready,false);assert.equal((await ledger.read()).attributionReady,false);assert.equal(peers,0);await assert.rejects(()=>ledger.initialize(),/canonical runtime/);await assert.rejects(()=>ledger.reconcile(),/canonical runtime/);}finally{await ledger.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

function checkpointRuntimeFixture(t:TestContext,chain:8453|4663,graphDelay=13_000,releasedAt?:bigint){
 const directory=mkdtempSync(join(tmpdir(),"native-checkpoint-operator-")),source=new Store(join(directory,"base"),8453),rh=new Store(join(directory,"robinhood"),4663);
 const runtime=runtimeFromEnv(chain,{CHAIN_MODE:chain===8453?"base":"robinhood",DATA_DIR:directory}),collector=addr(30),automation=addr(31);
 let now=0,sourceGraphs=0,destinationGraphs=0,nativeVerifications=0;t.mock.method(Date,"now",()=>now);
 const scans:{from:bigint;to:bigint}[]=[];
 const client=(chainId:8453|4663)=>({getChainId:async()=>chainId,getBlockNumber:async()=>100n,
  getBlock:async({blockNumber}:any)=>({number:blockNumber,hash:hash(Number(blockNumber)+1000),parentHash:hash(Number(blockNumber)+999)}),
  getCode:async()=>"0x6000",readContract:async()=>0n,getLogs:async({address,event,fromBlock,toBlock}:any)=>{
   assert.equal(chainId,8453);assert.equal(address,collector);assert.equal(event.name,"FeesReleased");scans.push({from:fromBlock,to:toBlock});
   return releasedAt!==undefined&&releasedAt>=fromBlock&&releasedAt<=toBlock?[{blockNumber:releasedAt}]:[];
  }});
 const sourceClient=client(8453),rhClient=client(4663),store=chain===8453?source:rh;
 // This retained unverified row is used only to prove that checkpoint creation
 // never prewarms unrelated native candidates or pretends they are income.
 source.saveBuybackBatch({id:"retained-provider-proof",protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,
  kind:"native_relay",status:"received",updatedAt:1,proof:{sourceHash:hash(7),destinationHash:hash(8)}});
 const ledger=createVaultLedgerRuntime({runtime,store,client:(chain===8453?sourceClient:rhClient) as any},{
  manifest:{status:"deployed_verified",collector:{address:collector},activation:{status:"not_run"}} as any,confirmations:1n,
  openPeerStore:async(peer)=>peer.config.chainId===8453?source:rh,createPeerClient:(peer)=>(peer.config.chainId===8453?sourceClient:rhClient) as any,
  verifyCollector:async()=>{sourceGraphs++;now+=graphDelay;return{collector,automationReceiver:automation,runtimeHash:hash(2),manifestFingerprint:hash(3),initialDeploymentBlock:1n,paused:true};},
  verifyRobinhoodGraph:async()=>{destinationGraphs++;return{vault:BASE_BUYBACK_VAULT,weth:BASE_BUYBACK_RH_WETH,swapper:addr(32)};},
  verifyNativeRelay:async()=>{nativeVerifications++;throw new Error("Checkpoint creation must not prewarm financial execution proofs");},
 });
 t.after(async()=>{await ledger.close();try{source.close();}catch{}try{rh.close();}catch{}rmSync(directory,{recursive:true,force:true});});
 return{ledger,source,rh,scans,counts:()=>({sourceGraphs,destinationGraphs,nativeVerifications})};
}

for(const chain of [8453,4663] as const)test(`offline operator initializes canonical ${chain} checkpoints after a >12-second graph read without enlarging normal read gates`,async t=>{
 const f=checkpointRuntimeFixture(t,chain);
 assert.equal((await f.ledger.read()).attributionReady,false);assert.equal((await f.ledger.custody()).ready,false);
 assert.equal(f.counts().destinationGraphs,0,"Ordinary read/custody stop at their original 12-second deadline");
 assert.equal(f.source.custodyLedgerState("base_automation"),null);assert.equal(f.rh.custodyLedgerState("robinhood_treasury"),null);assert.equal(f.rh.vaultLedgerState(),null);
 await f.ledger.initialize();
 const expectedScan=Array.from({length:10},(_,index)=>({from:BigInt(index*10+1),to:BigInt(index*10+10)}));
 assert.deepEqual(f.scans,Array.from({length:chain===8453?2:4},()=>expectedScan).flat(),"Every deployment-to-head log page remains guarded before and after checkpoint collection");
 assert.equal(f.counts().destinationGraphs,1);assert.equal(f.counts().nativeVerifications,0,"Only operator preparation skips irrelevant provider prewarming");
 const source=f.source.custodyLedgerState("base_automation"),treasury=f.rh.custodyLedgerState("robinhood_treasury"),vault=f.rh.vaultLedgerState();
 if(chain===8453){assert.equal(source?.chainId,8453);assert.equal(source?.revision,1);assert.equal(source?.checkpoint.number,"99");assert.equal(treasury,null);assert.equal(vault,null);}
 else{assert.equal(source,null);assert.equal(treasury?.chainId,4663);assert.equal(treasury?.checkpoint.number,"99");assert.equal(vault?.chainId,4663);assert.equal(vault?.checkpoint.number,"99");}
 assert.equal((await f.ledger.read()).attributionReady,false);assert.equal((await f.ledger.custody()).ready,false);
 assert.equal(f.counts().destinationGraphs,1,"Established checkpoints do not enlarge subsequent read/custody deadlines");
 assert.deepEqual(f.source.custodyLedgerState("base_automation"),source);assert.deepEqual(f.rh.custodyLedgerState("robinhood_treasury"),treasury);assert.deepEqual(f.rh.vaultLedgerState(),vault);
});

for(const chain of [8453,4663] as const)test(`the ${chain} initialization budget cannot bypass a genuine first-release guard`,async t=>{
 const f=checkpointRuntimeFixture(t,chain,13_000,25n);
 await assert.rejects(f.ledger.initialize(),/pre-Base-funding/);
 assert.deepEqual(f.scans,[{from:1n,to:10n},{from:11n,to:20n},{from:21n,to:30n}],"The actual complete-range guard stops on the first recorded release");
 assert.equal(f.source.custodyLedgerState("base_automation"),null);assert.equal(f.rh.custodyLedgerState("robinhood_treasury"),null);assert.equal(f.rh.vaultLedgerState(),null);
 assert.equal(f.counts().nativeVerifications,0);
});

test("operator graph preparation that exceeds its 60-second budget cannot write any checkpoint",async t=>{
 const f=checkpointRuntimeFixture(t,8453,60_001);
 await assert.rejects(f.ledger.initialize(),/maintenance budget reached/);
 assert.equal(f.source.custodyLedgerState("base_automation"),null);assert.equal(f.rh.custodyLedgerState("robinhood_treasury"),null);assert.equal(f.rh.vaultLedgerState(),null);
 assert.deepEqual(f.scans,[]);assert.equal(f.counts().destinationGraphs,0);
});

import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, stringToHex } from "viem";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_BUYBACK_WETH, BASE_NATIVE_DESTINATION_POLICY } from "../src/lib/base-buyback";
import { BASE_NATIVE_RELAY_SOLVER, NativeDestinationProviderPendingError } from "../server/base-native-trace";
import { nativeCandidateBudget, prepareNativeCandidateBudget, readAuditedNativeRelay } from "../server/base-native-candidates";
import { baseOperatorAuditStore } from "../scripts/base-audit-store";
import { readonlyBaseAuditOverlay, readonlyCanonicalBaseAuditSource, destinationCodeAuditStore } from "../scripts/buyback-vault-ledger";
import { BUYBACK_CODE_HASHES, RELAY_ROUTER, relayRequestMetadata } from "../server/buyback";
import { canonicalProofJson } from "../server/base-native-provenance";
import type { CustodyEvent } from "../src/lib/buyback-custody-ledger";
import { vaultEventId, type VaultLedgerState, type VaultLedgerEvent, type VaultBaseFillEvidence } from "../src/lib/buyback-vault-ledger";
function nativeRuntimeFixture(){
 const directory=mkdtempSync(join(tmpdir(),"native-runtime-snapshot-")),runtime=runtimeFromEnv(4663,{CHAIN_MODE:"robinhood",DATA_DIR:directory}),rh=new Store(runtime.dataDir,4663),source=new Store(join(directory,"source"),8453);
 const collector=addr(30),automation=addr(31),token=BASE_BUYBACK_WETH,swapper=addr(32),b=(n:number)=>({number:String(n),hash:hash(n+1000),parentHash:hash(n+999)});
 const movement=(tx:number,index:number,asset:Address,from:Address,to:Address,amount:string):CustodyEvent=>({id:vaultEventId(hash(tx),index),transactionHash:hash(tx),blockNumber:"100",blockHash:b(100).hash,transactionIndex:tx,logIndex:index,asset,from,to,kind:to===automation||to===BASE_BUYBACK_TREASURY?"in":"out",amount});
 const release=movement(1,1,token,collector,automation,"10"),spend=movement(2,2,token,automation,RELAY_ROUTER,"10"),received=movement(3,3,BASE_BUYBACK_RH_WETH,RELAY_ROUTER,BASE_BUYBACK_TREASURY,"10"),out1=movement(4,20,BASE_BUYBACK_RH_WETH,BASE_BUYBACK_TREASURY,BASE_BUYBACK_VAULT,"5"),out2=movement(4,22,BASE_BUYBACK_RH_WETH,BASE_BUYBACK_TREASURY,BASE_BUYBACK_VAULT,"5");
 release.evidence={kind:"adapter_release",collector,releaseLogIndex:2,transactionHash:release.transactionHash,blockHash:release.blockHash};release.fragments=[{batchId:release.id,amount:"10"}];
 const sourceState:CustodyState={version:1,id:"base_automation",chainId:8453,account:automation,revision:1,checkpoint:b(0),cursor:b(100),openingBalances:{[token.toLowerCase()]:"0"},observedBalances:{[token.toLowerCase()]:"0"},updatedAt:1,blockedReason:null};
 const relay:any={version:2,protocol:BASE_BUYBACK_PROTOCOL,orderParametersVerified:false,sourceTransactionHash:spend.transactionHash,sourceBlockNumber:"100",sourceBlockHash:spend.blockHash,sourceTransferLogIndex:spend.logIndex,sourceDepositLogIndex:3,sourceTimestamp:"100",sourceAsset:token,sourceAmount:"10",sourceNativeDeposit:"10",requestId:hash(40),orderId:hash(41),metadata:relayRequestMetadata(hash(40)),automation,sourceCalldataHash:hash(42),treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"10",destinationTransactionHash:received.transactionHash,destinationBlockNumber:"100",destinationBlockHash:received.blockHash,destinationTransferLogIndex:received.logIndex,destinationMovementLogIndex:4};
 const batchId=`native-source:${spend.transactionHash}`;
 const treasuryState:CustodyState={...sourceState,id:"robinhood_treasury",chainId:4663,account:BASE_BUYBACK_TREASURY,openingBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"0"},observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"0"}};
 received.evidence={kind:"native_relay",relay,sourceRevision:1,sourceEventId:spend.id};received.fragments=[{batchId,amount:"10"}];
 const vaultIn=(event:CustodyEvent):VaultLedgerEvent=>({...event,kind:"weth_in",source:"unknown"});
 const vaultState:VaultLedgerState={version:1,chainId:4663,vault:BASE_BUYBACK_VAULT,weth:BASE_BUYBACK_RH_WETH,swapper,revision:1,checkpoint:{...b(0),wethBalance:"0",totalSpent:"0",totalBurned:"0",establishedAt:1},cursor:b(100),observedBalance:"10",observedTotalSpent:"0",observedTotalBurned:"0",updatedAt:1,blockedReason:null};
 source.commitCustodyLedger({expectedRevision:0,state:sourceState,blocks:[b(0),b(100)],events:[release,spend]});rh.commitCustodyLedger({expectedRevision:0,state:treasuryState,blocks:[b(0),b(100)],events:[received,out1,out2]});rh.commitVaultLedger({expectedRevision:0,state:vaultState,blocks:[b(0),b(100)],events:[vaultIn(out1),vaultIn(out2)]});
 source.saveBuybackBatch({id:batchId,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,collector,kind:"native_relay",status:"received",createdAt:1,updatedAt:1,amountIn:"10",receivedAmount:"10",refundedAmount:"0",burnedAmount:"0",claimHashes:[],sourceHash:spend.transactionHash,destinationHash:received.transactionHash,relay,proof:{version:2,protocol:BASE_BUYBACK_PROTOCOL,sourceHash:spend.transactionHash,destinationHash:received.transactionHash}});
 const client=(chainId:number)=>({getChainId:async()=>chainId,getBlockNumber:async()=>101n,getBlock:async({blockNumber}:any)=>({...b(Number(blockNumber)),number:blockNumber}),getCode:async()=>"0x6000",getLogs:async()=>[],readContract:async({functionName,address}:any)=>functionName==="balanceOf"&&address===BASE_BUYBACK_VAULT?10n:0n});
 const sourceClient=client(8453),rhClient=client(4663),manifest:any={status:"deployed_verified",collector:{address:collector},activation:{status:"not_run"}};
 const deps:any={manifest,confirmations:1n,openPeerStore:async()=>source,createPeerClient:()=>sourceClient,verifyCollector:async()=>({collector,automationReceiver:automation,runtimeHash:keccak256("0x6000"),initialDeploymentBlock:"0"}),verifyRobinhoodGraph:async()=>({vault:BASE_BUYBACK_VAULT,weth:BASE_BUYBACK_RH_WETH,swapper}),verifyNativeRelay:async()=>relay,verifyRelease:async()=>release.evidence,verifyForward:async()=>({forwarderLogIndex:21,transferLogIndex:20})};
 return{directory,runtime,rh,source,sourceClient,rhClient,deps,out1,out2,create:()=>createVaultLedgerRuntime({runtime,store:rh,client:rhClient as any},deps),close:()=>{rh.close();try{source.close();}catch{}rmSync(directory,{recursive:true,force:true});}};
}
function nativeRuntimeDustFixture(count=120,sender?:Address){
 const f=nativeRuntimeFixture(),proof=(f.source.getBuybackBatch(`native-source:${hash(2)}`) as any).relay;
 const state=f.rh.custodyLedgerState("robinhood_treasury")!,events:CustodyEvent[]=[];
 const movement=parseAbiItem("event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)");
 for(let index=0;index<count;index++){
  const tx=500+index,event:CustodyEvent={id:vaultEventId(hash(tx),0),transactionHash:hash(tx),blockNumber:"100",blockHash:state.cursor.hash,transactionIndex:tx,logIndex:0,
   asset:BASE_BUYBACK_RH_WETH,from:RELAY_ROUTER,to:BASE_BUYBACK_TREASURY,kind:"in",amount:"1",...(sender?{nativeTransactionFrom:sender,nativeTransactionTo:RELAY_ROUTER}:{})};events.push(event);
 }
 f.rh.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:String(count)}},blocks:[],events});
 let receipts=0,traces=0,proofs=0;
 const logs=(tx:Hex)=>[{address:RELAY_ROUTER,logIndex:1,transactionHash:tx,blockNumber:100n,blockHash:state.cursor.hash,
  topics:encodeEventTopics({abi:[movement],eventName:"FundsMovement"}),data:encodeAbiParameters([{type:"address"},{type:"address"},{type:"address"},{type:"uint256"},{type:"bytes"}],
   [RELAY_ROUTER,BASE_BUYBACK_TREASURY,BASE_BUYBACK_RH_WETH,1n,proof.metadata])}];
 Object.assign(f.rhClient,{getTransactionReceipt:async({hash:tx}:any)=>{receipts++;return{status:"success",from:addr(99),transactionHash:tx,blockNumber:100n,blockHash:state.cursor.hash,logs:logs(tx)};},
  getTransaction:async({hash:tx}:any)=>({hash:tx,from:addr(99),to:RELAY_ROUTER,blockHash:state.cursor.hash,blockNumber:100n}),
  request:async()=>{traces++;return{from:addr(99),to:RELAY_ROUTER,input:"0x",calls:[]};},getCode:async({address}:any)=>sameAddress(address,BASE_NATIVE_RELAY_SOLVER)?"0x":"0x6000"});
 const verify=f.deps.verifyNativeRelay;f.deps.verifyNativeRelay=async(...args:any[])=>{proofs++;return verify(...args);};
 // Paging fixtures intentionally inject foreign-funding authentication. These
 // unsigned rows test bounded scheduling/CAS, never actual payment provenance.
 f.deps.verifyNativeDestinationProvider=async()=>false;
 return{...f,events,proof,counters:()=>({receipts,traces,proofs})};
}
test("one unresolved candidate retains the already authenticated proof and cannot stop later candidate authentication",async()=>{
 const f=nativeRuntimeDustFixture(2),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,seen:Hex[]=[];
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.source,batch,graphFingerprint:"pending-isolation",
  treasuryState:f.rh.custodyLedgerState("robinhood_treasury"),events:f.events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,
  authenticate:async(_client,tx)=>{seen.push(tx);if(tx===hash(500))throw new NativeDestinationProviderPendingError();return false;}});
 try{const first=await read();assert.deepEqual(first.proof,f.proof);assert.equal(first.pending,true);assert.deepEqual(seen,[hash(500),hash(501)]);
  const second=await read();assert.deepEqual(second.proof,f.proof);assert.equal(second.pending,true);assert.equal(seen.length,2,"Durable candidate backoff does not invalidate the immutable accepted proof");
 }finally{f.close();}
});
test("a pending candidate cannot hide a later actually authenticated duplicate receipt",async()=>{
 const f=nativeRuntimeDustFixture(2),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,seen:Hex[]=[];
 try{await assert.rejects(()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.source,batch,graphFingerprint:"pending-conflict",
  treasuryState:f.rh.custodyLedgerState("robinhood_treasury"),events:f.events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,
  authenticate:async(_client,tx)=>{seen.push(tx);if(tx===hash(500))throw new NativeDestinationProviderPendingError();return true;}}),/multiple canonical/);
  assert.deepEqual(seen,[hash(500),hash(501)]);
 }finally{f.close();}
});
for(const failure of ["activation record missing","acceptance not finalized","EIP-1271 authorization revoked"])test(`financial journals advance while live authorization rejects ${failure}`,async()=>{
 const f=nativeRuntimeFixture(),verify=f.deps.verifyCollector,checks:unknown[]=[];
 f.deps.manifest.activation={status:"canary_verified",nativeExecution:{},nativeRunAcceptance:{},walletAcceptance:{},pauseRollbackAcceptance:{}};
 f.deps.manifest.canaryAuthorization={};
 f.deps.verifyCollector=async(...args:any[])=>{
  checks.push(args[2].requireActivation);
  if(args[2].requireActivation!==false)throw new Error(failure);
  return verify(...args);
 };
 Object.assign(f.rhClient,{getBlockNumber:async()=>102n,readContract:async({functionName,args}:any)=>functionName==="balanceOf"&&sameAddress(args[0],BASE_BUYBACK_VAULT)?10n:0n});
 const ledger=f.create();try{
  assert.equal(await ledger.automationPolicy(),"unverified");
  await ledger.reconcile();
  assert.equal(f.rh.custodyLedgerState("robinhood_treasury")!.cursor.number,"101");
  assert.equal(f.rh.vaultLedgerState()!.cursor.number,"101");
  assert.equal(f.source.custodyLedgerState("base_automation")!.cursor.number,"100","Peer maintenance remains read-only");
  assert.deepEqual(checks,["runtime",false],"Only live execution authorization uses the activation gate");
 }finally{await ledger.close();f.close();}
});
test("trusted Splits Automation configuration still requires the live activation record and accepts no unsigned or not_run shortcut",async()=>{
 const f=nativeRuntimeFixture(),verify=f.deps.verifyCollector,checks:unknown[]=[];
 const manifest=structuredClone(BASE_COLLECTOR_MANIFEST);manifest.collector.address=f.deps.manifest.collector.address;
 manifest.constants.automationReceiver=addr(31);
 manifest.activation={status:"trusted_splits_authorized",trustedSplitsAcceptance:{version:1,sourceChainId:8453,destinationChainId:4663,
  graphFingerprint:hash(300),collector:manifest.collector.address!,automationReceiver:manifest.constants.automationReceiver,
  destinationTreasury:manifest.constants.destinationTreasury,destinationWeth:manifest.constants.destinationWeth,
  destinationVault:manifest.finalSettlement.vault,keeper:addr(33),ruleId:manifest.nativeRule.ruleId!,
  configurationSha256:manifest.nativeRule.configurationSha256!,trustSplitsNativeExecution:true,signer:manifest.constants.governor!,signature:"0x1234"}};
 manifest.canaryAuthorization=null;f.deps.manifest=manifest;
 let authorized=false;
 f.deps.verifyCollector=async(...args:any[])=>{checks.push(args[2].requireActivation);
  if(args[2].requireActivation!==false&&!authorized)throw new Error("activation record missing");
  return{...await verify(...args),paused:false};};
 const ledger=f.create();try{
  assert.equal(await ledger.automationPolicy(),"unverified");assert.deepEqual(checks,["runtime"]);
  authorized=true;assert.equal(await ledger.automationPolicy(),"configured");assert.deepEqual(checks,["runtime","runtime"]);
  assert.equal(manifest.activation.nativeExecution,undefined,"Configuration acceptance is not a fabricated fee or destruction receipt");
  manifest.activation.trustedSplitsAcceptance!.signature="0x";
  assert.equal(await ledger.automationPolicy(),"unverified");assert.deepEqual(checks,["runtime","runtime"]);
  manifest.activation.trustedSplitsAcceptance!.signature="0x1234";manifest.activation.status="not_run";
  assert.equal(await ledger.automationPolicy(),"unverified");assert.deepEqual(checks,["runtime","runtime"]);
 }finally{await ledger.close();f.close();}
});
test("an old destination-policy audit cannot skip the new verifier or erase retained history",async()=>{
 const f=nativeRuntimeDustFixture(0),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!;
 const digest=(value:unknown)=>keccak256(stringToHex(canonicalProofJson(value)));
 const oldBinding=canonicalProofJson({proof:batch.proof,graph:"destination-policy",checkpoint:state.checkpoint,
  provider:BASE_NATIVE_RELAY_SOLVER,router:RELAY_ROUTER,codes:BUYBACK_CODE_HASHES,validationPolicy:"relay-fixed-router-canonical-receipt-v1"});
 const old={id:`internal_native_destination:${digest(oldBinding)}`,protocol:"internal_native_destination_audit_v1",version:1,binding:oldBinding,
  updatedAt:1,proof:f.proof,proofHash:digest(f.proof),checkpointHash:state.checkpoint.hash};
 const rows=new Map<string,any>([[old.id,structuredClone(old)]]);let verifies=0,unavailable=true;
 const store={getBuybackBatch:(id:string)=>structuredClone(rows.get(id)??null),compareAndSetBuybackAudit:(next:any,expected:any)=>{
  if(canonicalProofJson(rows.get(next.id)??null)!==canonicalProofJson(expected))return false;rows.set(next.id,structuredClone(next));return true;}};
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store,batch,graphFingerprint:"destination-policy",treasuryState:state,
  events:[],budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>{verifies++;if(unavailable)throw new Error("New receipt policy is not verified");return f.proof;}});
 try{
  await assert.rejects(read,/New receipt policy is not verified/);assert.equal(verifies,1);assert.equal(rows.size,1);assert.deepEqual(rows.get(old.id),old);
  unavailable=false;assert.equal((await read()).pending,false);assert.equal(verifies,2);assert.equal(rows.size,2);
  const current=[...rows.values()].find(row=>row.id!==old.id)!;assert.equal(JSON.parse(current.binding).validationPolicy,BASE_NATIVE_DESTINATION_POLICY);
  assert.deepEqual(rows.get(old.id),old);await read();assert.equal(verifies,2,"Only the new policy's canonical proof can be reused");
 }finally{f.close();}
});
test("foreign Router dust discovery uses bounded RPC work and never repeats all history on each custody read",async()=>{
 const f=nativeRuntimeDustFixture(),ledger=f.create();
 try{const report=await ledger.custody();assert.equal(report.ready,true);assert.equal(report.treasury.assets[0].baseReceived,"10");
  const first=f.counters();assert(first.receipts<=20,`Expected a bounded candidate page, not ${first.receipts} receipt reads`);
  await ledger.custody();const second=f.counters();assert(second.receipts-first.receipts<=20,"A second read must resume a bounded durable cursor instead of replaying every dust transaction");
 }finally{await ledger.close();f.close();}
});
for(const dust of [0,120])test(`four cold concurrent custody sessions all preserve healthy provenance with ${dust} foreign candidates`,async()=>{
 const f=nativeRuntimeDustFixture(dust);f.deps.openPeerStore=async()=>new Store(join(f.directory,"source"),8453);const ledgers=Array.from({length:4},()=>f.create());
 try{const reports=await Promise.all(ledgers.map(ledger=>ledger.custody()));assert.deepEqual(reports.map(row=>row.ready),[true,true,true,true]);assert.deepEqual(reports.map(row=>row.treasury.assets[0].baseReceived),["10","10","10","10"]);assert(f.counters().receipts<=32,"Four sessions each retain their eight-candidate canonical-receipt upper bound with the injected verifier");}
 finally{await Promise.all(ledgers.map(ledger=>ledger.close()));f.close();}
});
test("unchanged read/signing gates do not rewrite advisory rotation or an identical proof snapshot",async()=>{
 const f=nativeRuntimeDustFixture(0),ledger=f.create();let writes=0;const compare=f.rh.compareAndSetBuybackAudit.bind(f.rh);
 try{
  assert.equal((await ledger.custody()).ready,true);const before=structuredClone(f.rh.listBuybackBatches());
  f.rh.compareAndSetBuybackAudit=(next,expected)=>{writes++;return compare(next,expected);};
  for(let index=0;index<3;index++){assert.equal((await ledger.custody()).ready,true);assert.equal((await ledger.read()).attributionReady,true);}
  assert.equal(writes,0,"Unchanged timestamps are not reasons to contend on a persisted CAS");assert.deepEqual(f.rh.listBuybackBatches(),before);
 }finally{await ledger.close();f.close();}
});
test("an advisory scheduling CAS loss or RPC error retains local allocation while proof-store failure remains closed",async()=>{
 const f=nativeRuntimeDustFixture(120),ledger=f.create(),get=f.rh.getBuybackBatch.bind(f.rh),compare=f.rh.compareAndSetBuybackAudit.bind(f.rh);let scheduleFailures=0,proofWrites=0;
 try{
  f.rh.getBuybackBatch=(id)=>{if(id.startsWith("internal_native_destination_schedule:")){scheduleFailures++;throw new Error("advisory scheduling RPC unavailable");}return get(id);};
  f.rh.compareAndSetBuybackAudit=(next,expected)=>{if(next.protocol==="internal_native_destination_schedule_v1"){scheduleFailures++;throw new Error("advisory write unavailable");}proofWrites++;return compare(next,expected);};
  assert.equal((await ledger.custody()).ready,true);assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert(scheduleFailures>=4);assert(proofWrites>0);assert.equal(f.counters().receipts,16,"Each ordinary/signing gate keeps its own total-eight RPC bound even when advisory persistence fails");
  f.rh.getBuybackBatch=get;f.rh.compareAndSetBuybackAudit=(next,expected)=>next.protocol==="internal_native_destination_schedule_v1"?false:compare(next,expected);
  assert.equal((await ledger.custody()).ready,true);assert.equal(f.counters().receipts,24,"A lost advisory CAS is equally harmless to canonical proof checks");
  f.rh.getBuybackBatch=(id)=>{if(id.startsWith("internal_native_destination:"))throw new Error("financial proof snapshot unavailable");return get(id);};
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"0","Actual proof-store availability never uses the advisory fallback");
 }finally{await ledger.close();f.close();}
});
test("native proof snapshots and foreign candidate cursors survive runtime restart with exact bounded RPC counts",async()=>{
 const f=nativeRuntimeDustFixture();let ledger=f.create();
 try{
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert.deepEqual(f.counters(),{receipts:8,traces:0,proofs:1});
  await ledger.close();f.deps.openPeerStore=async()=>new Store(join(f.directory,"source"),8453);ledger=f.create();
  for(let page=1;page<15;page++){const before=f.counters();assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");const after=f.counters();assert.equal(after.receipts-before.receipts,8);assert.equal(after.proofs,1);assert.equal(after.traces,0);}
  assert.deepEqual(f.counters(),{receipts:120,traces:0,proofs:1});
  await ledger.custody();assert.deepEqual(f.counters(),{receipts:120,traces:0,proofs:1},"Completed dust never costs another historical receipt or call trace");
  const audits=f.rh.listBuybackBatches().filter(row=>row.protocol==="internal_native_destination_audit_v1");assert.equal(audits.length,1,"120 foreign transactions create one audit for the real fee batch");
 }finally{await ledger.close();f.close();}
});
test("operator private audit progress persists while read-only financial journals reject every write",async()=>{
 const f=nativeRuntimeDustFixture(120),auditDirectory=join(f.directory,"operator-audits"),before=f.rh.backup();let financialWrites=0;
 const readonly=new Proxy(f.rh,{get(target,key){if(["saveBuybackBatch","compareAndSetBuybackAudit","commitCustodyLedger","commitVaultLedger"].includes(String(key)))return()=>{financialWrites++;throw new Error("Financial journal is read-only");};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 let ledger=createVaultLedgerRuntime({runtime:f.runtime,store:readonly,client:f.rhClient as any},{...f.deps,auditStore:baseOperatorAuditStore(auditDirectory)});
 try{
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert.deepEqual(f.counters(),{receipts:8,traces:0,proofs:1});
  await ledger.close();f.deps.openPeerStore=async()=>new Store(join(f.directory,"source"),8453);
  ledger=createVaultLedgerRuntime({runtime:f.runtime,store:readonly,client:f.rhClient as any},{...f.deps,auditStore:baseOperatorAuditStore(auditDirectory)});
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert.deepEqual(f.counters(),{receipts:16,traces:0,proofs:1},"A new operator instance resumes its private cursor without rebuilding the full proof");
  assert.equal(financialWrites,0);assert.deepEqual(f.rh.backup(),before,"Native proof/candidate cache writes cannot mutate financial evidence or FIFO source fragments");
 }finally{await ledger.close();f.close();}
});
test("canonical foreign sender hints still authenticate each candidate within bounded durable pages",async()=>{
 const f=nativeRuntimeDustFixture(120,addr(99));
 const ledger=f.create();try{
  for(let page=0;page<16;page++)assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");
  assert.deepEqual(f.counters(),{receipts:120,traces:0,proofs:1},"A foreign root sender is only a scheduling hint; each candidate still invokes the injected funding verifier before advancing its cursor");
  assert.equal(f.rh.listBuybackBatches().filter(row=>row.protocol==="internal_native_destination_audit_v1").length,1);
 }finally{await ledger.close();f.close();}
});
test("a rotated root sender hint cannot skip authentication of fixed-solver funding or its conflict",async()=>{
 const f=nativeRuntimeDustFixture(1,addr(99)),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!;let authenticated=0;
 try{
  await assert.rejects(()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:"rotated-funded-root",treasuryState:state,
   events:f.events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate:async(_client,tx,metadata)=>{
    authenticated++;assert.equal(tx,f.events[0].transactionHash);assert.equal(metadata,f.proof.metadata);return true;
   }}),/multiple canonical destination receipts/);
  const audit=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;
  assert.equal(authenticated,1);assert.equal((audit.conflict as any).eventId,f.events[0].id);assert.equal(audit.after,undefined);assert.equal(audit.pending,undefined);
  assert.equal(f.counters().traces,0);
 }finally{f.close();}
});
test("unsupported solver candidates persist bounded backoff across reads and restart without skipping later proof",async()=>{
 const f=nativeRuntimeDustFixture(1,BASE_NATIVE_RELAY_SOLVER),event=f.events[0];
 const receipt=(f.rhClient as any).getTransactionReceipt;(f.rhClient as any).getTransactionReceipt=async(args:any)=>({...await receipt(args),from:BASE_NATIVE_RELAY_SOLVER});
 let authenticated=0;f.deps.verifyNativeDestinationProvider=async()=>{authenticated++;throw new NativeDestinationProviderPendingError("Unsupported fixed-provider trace");};
 let ledger=f.create();try{
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10","An unverified candidate does not revoke the authenticated arrival");assert.deepEqual(f.counters(),{receipts:1,traces:0,proofs:1});
  assert.equal((await ledger.sourceStatus()).ready,true,"Candidate discovery is separate from healthy fee-release readiness");
  const pending=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;
  assert.equal(pending.after,undefined);assert.equal((pending.pendingCandidates as any[])[0].eventId,event.id);
  await ledger.custody();assert.equal(authenticated,1);assert.equal(f.counters().receipts,1);
  await ledger.close();f.deps.openPeerStore=async()=>new Store(join(f.directory,"source"),8453);ledger=f.create();await ledger.custody();assert.equal(authenticated,1);assert.equal(f.counters().receipts,1,"Durable backoff survives a new runtime");
  const retained=f.rh.getBuybackBatch(pending.id)!;assert.equal(f.rh.compareAndSetBuybackAudit({...retained,pendingCandidates:(retained.pendingCandidates as any[]).map(row=>({...row,retryAfter:0}))},retained),true);
  f.deps.verifyNativeDestinationProvider=async()=>{authenticated++;return true;};
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"0","Recovered authentication discovers the actual same-tag conflict instead of forgetting the skipped candidate");
  const conflict=f.rh.getBuybackBatch(pending.id)!;assert.equal((conflict.conflict as any).eventId,event.id);assert.equal(conflict.pending,undefined);assert.equal(authenticated,2);assert.equal(f.counters().receipts,2);
 }finally{await ledger.close();f.close();}
});
// These cases test cursor/backoff behavior with the verifier's public pending
// contract. Signed root/funding authentication is exercised by the dedicated
// destination engine tests; no unsigned scheduling row is a real payment.
for(const missing of ["missing_from","invalid_from","missing_status","unknown_status"] as const)test(`candidate ${missing} verifier outcome stays pending then recovers without skipping a conflict`,async t=>{
 const f=nativeRuntimeDustFixture(2),foreign=f.events[0],candidate=f.events[1],batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any;
 const state=f.rh.custodyLedgerState("robinhood_treasury")!,originalReceipt=(f.rhClient as any).getTransactionReceipt;let now=10_000,recovered=false,authenticated=0;
 t.mock.method(Date,"now",()=>now);
 (f.rhClient as any).getTransactionReceipt=async(args:any)=>{
  const original=await originalReceipt(args);if(args.hash!==candidate.transactionHash)return original;
  return{...original,from:!recovered&&missing==="missing_from"?undefined:!recovered&&missing==="invalid_from"?"invalid":BASE_NATIVE_RELAY_SOLVER,
   status:!recovered&&missing==="missing_status"?undefined:!recovered&&missing==="unknown_status"?"unknown":"success"};
 };
 const authenticate=async(_client:any,tx:Hex)=>{
  authenticated++;const receipt=await (f.rhClient as any).getTransactionReceipt({hash:tx});
  if(receipt.status!=="success"||!/^0x[\da-f]{40}$/i.test(String(receipt.from)))throw new NativeDestinationProviderPendingError("Verifier requires a canonical sender and status");
  return tx===candidate.transactionHash;
 };
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:`receipt-${missing}`,treasuryState:state,
  events:f.events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate});
 try{
  assert.equal((await read()).pending,true);
  const audit=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;
  assert.equal((audit.after as any).eventId,foreign.id);assert.equal((audit.pendingCandidates as any[])[0].eventId,candidate.id);assert.equal(audit.priorityAfter,undefined);assert.equal(audit.conflict,undefined);
  const before=f.counters().receipts;assert.equal((await read()).pending,true);assert.equal(f.counters().receipts,before);assert.equal(authenticated,2);
  now+=30_001;recovered=true;await assert.rejects(read,/multiple canonical destination receipts/);
  const conflict=f.rh.getBuybackBatch(audit.id)!;assert.equal((conflict.conflict as any).eventId,candidate.id);assert.equal(conflict.pending,undefined);
  assert.equal((conflict.after as any).eventId,foreign.id);assert.equal(authenticated,3);assert.equal(f.counters().traces,0);
 }finally{f.close();}
});
for(const unavailable of ["rpc_error","delegated_code"] as const)test(`candidate verifier ${unavailable} withholds its cursor until canonical authentication recovers`,async t=>{
 const f=nativeRuntimeDustFixture(1,addr(99)),event=f.events[0],batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!;
 let now=10_000,recovered=false,codeReads=0;t.mock.method(Date,"now",()=>now);
 const authenticate=async()=>{
  codeReads++;
  if(!recovered)throw new NativeDestinationProviderPendingError(unavailable==="rpc_error"?"Historical code RPC 429":"Historical account delegation is unsupported");
  return false;
 };
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:`foreign-${unavailable}`,treasuryState:state,
  events:f.events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate});
 try{
  assert.equal((await read()).pending,true);
  const audit=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;
  assert.equal(audit.after,undefined);assert.equal(audit.priorityAfter,undefined);assert.equal((audit.pendingCandidates as any[])[0].eventId,event.id);
  const before=f.counters().receipts,beforeCode=codeReads;assert.equal((await read()).pending,true);assert.equal(codeReads,beforeCode);assert.equal(f.counters().receipts,before);
  now+=30_001;recovered=true;assert.equal((await read()).pending,false);
  const current=f.rh.getBuybackBatch(audit.id)!;assert.equal((current.after as any).eventId,event.id);assert.equal(current.pending,undefined);assert.equal(current.conflict,undefined);assert.equal(codeReads,beforeCode+1);
  assert.equal(f.counters().traces,0);
 }finally{f.close();}
});
test("fixed-sender priority pages persist separately from foreign dust and still check a new solver conflict first",async()=>{
 const f=nativeRuntimeDustFixture(20,addr(99)),state=f.rh.custodyLedgerState("robinhood_treasury")!,solverRows:CustodyEvent[]=Array.from({length:9},(_,index)=>{
  const transactionHash=hash(7000+index);return{...f.events[0],id:vaultEventId(transactionHash,0),transactionHash,transactionIndex:7000+index,nativeTransactionFrom:BASE_NATIVE_RELAY_SOLVER,nativeTransactionTo:RELAY_ROUTER};
 });
 f.rh.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"29"}},blocks:[],events:solverRows});
 const receipts:Hex[]=[],receipt=(f.rhClient as any).getTransactionReceipt;
 (f.rhClient as any).getTransactionReceipt=async(args:any)=>{receipts.push(args.hash);const result=await receipt(args);return solverRows.some(event=>event.transactionHash===args.hash)?{...result,from:BASE_NATIVE_RELAY_SOLVER,logs:[]}:result;};
 let ledger=f.create();try{
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10","Unexamined candidates cannot revoke an authenticated immutable arrival");
  assert.deepEqual(receipts,solverRows.slice(0,8).map(event=>event.transactionHash));
  let audit=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;
  assert.equal(audit.after,undefined,"Priority processing does not silently skip earlier foreign dust");assert.equal((audit.priorityAfter as any).eventId,solverRows[7].id);
  await ledger.close();f.deps.openPeerStore=async()=>new Store(join(f.directory,"source"),8453);ledger=f.create();
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert.equal(receipts.length,16);assert.equal(receipts[8],solverRows[8].transactionHash,"Restart resumes the ninth candidate instead of replaying the first eight, then authenticates seven foreign rows");
  audit=f.rh.getBuybackBatch(audit.id)!;assert.equal((audit.after as any).eventId,f.events[6].id,"Seven remaining work slots advanced only seven earlier dust rows");
  assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert.equal(receipts.length,24);audit=f.rh.getBuybackBatch(audit.id)!;assert.equal((audit.after as any).eventId,f.events[14].id);
  const current=f.rh.custodyLedgerState("robinhood_treasury")!,transactionHash=hash(7010),conflict:CustodyEvent={...solverRows[0],id:vaultEventId(transactionHash,0),transactionHash,transactionIndex:7010,blockNumber:"101",blockHash:hash(1101),nativeRequestMetadata:f.proof.metadata};
  f.rh.commitCustodyLedger({expectedRevision:current.revision,state:{...current,revision:current.revision+1,cursor:{number:"101",hash:hash(1101),parentHash:hash(1100)},observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"30"}},blocks:[{number:"101",hash:hash(1101),parentHash:hash(1100)}],events:[conflict]});
  Object.assign(f.rhClient,{getBlockNumber:async()=>102n});const prior=(f.rhClient as any).getTransactionReceipt;
  (f.rhClient as any).getTransactionReceipt=async(args:any)=>args.hash===transactionHash?{...await prior(args),from:BASE_NATIVE_RELAY_SOLVER,blockNumber:101n,blockHash:hash(1101)}:prior(args);
  f.deps.verifyNativeDestinationProvider=async(_client:any,tx:Hex)=>tx===transactionHash;
  const held=await ledger.custody();assert.equal(held.ready,true);assert.equal(held.treasury.assets[0].baseReceived,"0");assert.equal(receipts.at(-1),transactionHash);assert.equal(receipts.length,25);audit=f.rh.getBuybackBatch(audit.id)!;assert.equal((audit.conflict as any).eventId,conflict.id,"The new tenth solver candidate is checked ahead of the five remaining old foreign rows");
 }finally{await ledger.close();f.close();}
});
test("new canonical solver candidates jump ahead of dust, persist their conflict, and recover after its genuine reorg",async()=>{
 const f=nativeRuntimeDustFixture(),ledger=f.create();
 try{
  await ledger.custody();const state=f.rh.custodyLedgerState("robinhood_treasury")!,tx=hash(9000),conflict:CustodyEvent={...f.events[0],id:vaultEventId(tx,0),transactionHash:tx,transactionIndex:9000,blockNumber:"101",blockHash:hash(1101),
   nativeTransactionFrom:BASE_NATIVE_RELAY_SOLVER,nativeTransactionTo:RELAY_ROUTER,nativeRequestMetadata:f.proof.metadata};
  Object.assign(f.rhClient,{getBlockNumber:async()=>102n});
  f.rh.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,cursor:{number:"101",hash:hash(1101),parentHash:hash(1100)},observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"121"}},blocks:[{number:"101",hash:hash(1101),parentHash:hash(1100)}],events:[conflict]});
  const receipt=(f.rhClient as any).getTransactionReceipt;(f.rhClient as any).getTransactionReceipt=async(args:any)=>args.hash===tx?{...await receipt(args),from:BASE_NATIVE_RELAY_SOLVER,blockNumber:101n,blockHash:hash(1101)}:receipt(args);
  f.deps.verifyNativeDestinationProvider=async(_client:any,hash:Hex)=>hash===tx;
  const before=f.counters(),held=await ledger.custody();assert.equal(held.ready,true,"Balanced accounts still let unrelated fees run");assert.equal(held.treasury.assets[0].baseReceived,"0");assert.equal(held.treasury.withheldEventIds.length,1);assert.equal(f.counters().receipts-before.receipts,1,"New solver conflict cannot wait behind 112 dust candidates");
  await ledger.custody();assert.equal(f.counters().receipts-before.receipts,1,"A stored canonical conflict is checked by anchors, without replaying its receipt");
  const current=f.rh.custodyLedgerState("robinhood_treasury")!;
  f.rh.commitCustodyLedger({expectedRevision:current.revision,state:{...current,revision:current.revision+1,cursor:{number:"100",hash:hash(1100),parentHash:hash(1099)},observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"120"}},blocks:[],events:[],rollbackAfterBlock:"100"});
  Object.assign(f.rhClient,{getBlockNumber:async()=>101n});const recovered=await ledger.custody();assert.equal(recovered.ready,true);assert.equal(recovered.treasury.assets[0].baseReceived,"10");assert.equal(recovered.treasury.withheldEventIds.length,0);assert.equal(f.counters().proofs,1);
 }finally{await ledger.close();f.close();}
});
test("proof-snapshot RPC failures and source anchor changes withhold their lot instead of accepting stale arrival",async()=>{
 const f=nativeRuntimeDustFixture(0),ledger=f.create();
 try{await ledger.custody();assert.equal(f.counters().proofs,1);const block=f.sourceClient.getBlock;
  f.sourceClient.getBlock=async()=>{throw new Error("RPC unavailable");};const unavailable=await ledger.custody();assert.equal(unavailable.ready,false);assert.equal(unavailable.treasury.assets.length,0);assert.equal(f.counters().proofs,1);
  f.sourceClient.getBlock=block;assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert.equal(f.counters().proofs,1);
  f.sourceClient.getBlock=async args=>args.blockNumber===100n?{...await block(args),hash:hash(999)}:block(args);assert.equal((await ledger.custody()).ready,false);assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"0","A changed source journal anchor remains unresolved; old snapshots do not prove new-chain facts");
 }finally{await ledger.close();f.close();}
});
test("a lost candidate-audit CAS withholds its lot and cannot publish a stale cursor snapshot",async()=>{
 const f=nativeRuntimeDustFixture(),ledger=f.create();
 try{await ledger.custody();const retained=structuredClone(f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!);
  const compare=f.rh.compareAndSetBuybackAudit.bind(f.rh);let lost=0;f.rh.compareAndSetBuybackAudit=(next,expected)=>{if(next.protocol==="internal_native_destination_audit_v1"){lost++;return false;}return compare(next,expected);};
  const report=await ledger.custody();assert.equal(report.ready,true);assert.equal(report.treasury.assets[0].baseReceived,"0");assert.equal(lost,1);assert.deepEqual(f.rh.getBuybackBatch(retained.id),retained);
  f.rh.compareAndSetBuybackAudit=compare;assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");assert.equal(f.counters().proofs,1);
 }finally{await ledger.close();f.close();}
});
test("candidate RPC shares and durable round rotation prevent one dusty run from starving another",async()=>{
 const f=nativeRuntimeDustFixture(120,addr(99)),original=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any;
 const second={...original,id:"new-run",proof:{...original.proof,destinationHash:hash(44)}},secondProof={...f.proof,destinationTransactionHash:hash(44),metadata:relayRequestMetadata(hash(45))};
 const solver:CustodyEvent={...f.events[0],id:vaultEventId(hash(9999),0),transactionHash:hash(9999),transactionIndex:9999,nativeTransactionFrom:BASE_NATIVE_RELAY_SOLVER};
 const state=f.rh.custodyLedgerState("robinhood_treasury")!,binding={test:"fair-rotation",checkpoint:state.checkpoint};let receipts=0;
 (f.rhClient as any).getTransactionReceipt=async({hash:tx}:any)=>{receipts++;return{status:"success",from:BASE_NATIVE_RELAY_SOLVER,transactionHash:tx,blockNumber:100n,blockHash:state.cursor.hash,logs:[]};};
 const read=(batch:any,proof:any,events:CustodyEvent[],budget:ReturnType<typeof nativeCandidateBudget>)=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:"fair",treasuryState:state,events,budget,deadline:Infinity,verify:async()=>proof});
 try{
  const budget=await prepareNativeCandidateBudget(f.rh,[original.id,second.id],binding,Infinity);
  assert.equal(budget.allocations!.get(original.id),4);assert.equal(budget.allocations!.get(second.id),4);
  assert.equal((await read(original,f.proof,f.events,budget)).pending,true);assert.equal(budget.remaining,4);
  const healthy=await read(second,secondProof,[solver],budget);assert.equal(healthy.pending,false);assert.equal(healthy.proof.outputAmount,"10");assert.equal(receipts,5,"Four authenticated older candidates cannot consume the newer run's reserved RPC share");
  const firstOrder=budget.order!.slice();const reopened=new Store(f.runtime.dataDir,4663);
  try{const next=await prepareNativeCandidateBudget(reopened,[original.id,second.id],binding,Infinity);assert.deepEqual(next.order,[firstOrder[1],firstOrder[0]],"The slow-first run changes across process restart");}finally{reopened.close();}
  const ids=Array.from({length:100},(_,index)=>`run-${String(index).padStart(3,"0")}`),many=await prepareNativeCandidateBudget(f.rh,ids,{test:"many-runs"},Infinity);
  assert.equal(many.order!.length,8);assert.equal([...many.allocations!.values()].reduce((sum,n)=>sum+n,0),8,"100 runs still reserve only eight candidate RPC operations, never 800");
  const next=await prepareNativeCandidateBudget(f.rh,ids,{test:"many-runs"},Infinity);assert.deepEqual(next.order,ids.slice(1,9),"Previously unselected ninth run is eligible next turn");
 }finally{f.close();}
});
test("stale candidate cursor hashes are discarded rather than suppressing canonical candidate rechecks",async()=>{
 const f=nativeRuntimeDustFixture(10),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!;
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:"anchor-mutation",treasuryState:state,events:f.events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate:f.deps.verifyNativeDestinationProvider});
 try{
  await read();const stored=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;assert.equal((stored.after as any).eventId,f.events[7].id);assert.equal(f.counters().receipts,8);
  assert.equal(f.rh.compareAndSetBuybackAudit({...stored,after:{...(stored.after as object),blockHash:hash(9090)}},stored),true);
  await read();assert.equal(f.counters().receipts,16,"A corrupt cursor anchor must restart the eight-event canonical page, not skip to the last two events");
  const current=f.rh.getBuybackBatch(stored.id)!;assert.equal((current.after as any).blockHash,state.cursor.hash);
 }finally{f.close();}
});
for(const field of ["priorityAfter","conflict","pendingCandidates"] as const)test(`candidate ${field} anchor mutations cannot bypass canonical revalidation`,async()=>{
 const f=nativeRuntimeDustFixture(field==="priorityAfter"?9:1,BASE_NATIVE_RELAY_SOLVER),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!,receipt=(f.rhClient as any).getTransactionReceipt;
 (f.rhClient as any).getTransactionReceipt=async(args:any)=>({...await receipt(args),from:BASE_NATIVE_RELAY_SOLVER,...(field==="priorityAfter"?{logs:[]}:{})});
 const authenticate=async()=>{if(field==="pendingCandidates")throw new NativeDestinationProviderPendingError("Receipt pending");return true;};
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:`${field}-mutation`,treasuryState:state,events:f.events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate});
 try{
  if(field==="conflict")await assert.rejects(read,/multiple canonical/);else await read();
  const stored=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;assert.ok(stored[field]);const before=f.counters().receipts;
  const changed=field==="pendingCandidates"?(stored[field] as any[]).map(row=>({...row,blockHash:hash(999999)})):{...(stored[field] as object),blockHash:hash(999999)};
  assert.equal(f.rh.compareAndSetBuybackAudit({...stored,[field]:changed},stored),true);
  if(field==="conflict")await assert.rejects(read,/multiple canonical/);else await read();
  assert.equal(f.counters().receipts-before,field==="priorityAfter"?8:1,"A changed retained point must be authenticated again instead of trusting stale cursor, conflict, or retry window");
  const current=f.rh.getBuybackBatch(stored.id)!;assert.equal(field==="pendingCandidates"?(current[field] as any[])[0].blockHash:(current[field] as any).blockHash,state.cursor.hash);
 }finally{f.close();}
});
test("one ambiguous forward receipt cannot freeze later canonical Treasury-to-Vault propagation",async()=>{
 const f=nativeRuntimeFixture();f.deps.verifyForward=async(_client:any,actual:CustodyEvent)=>{if(actual.id===f.out1.id)throw new Error("Unsupported/ambiguous first Forwarded");return{forwarderLogIndex:23,transferLogIndex:22};};const ledger=f.create();
 try{await ledger.reconcile();const events=f.rh.vaultLedgerEventPage();assert.equal(events[0].kind==="weth_in"&&events[0].source,"unknown");assert.equal(events[1].kind==="weth_in"&&events[1].source,"base");assert.equal(events[1].kind==="weth_in"&&events[1].baseFill&&"protocol"in events[1].baseFill?events[1].baseFill.forwarderLogIndex:null,23);
 }finally{await ledger.close();f.close();}
});
test("a temporarily unavailable cached Treasury snapshot cannot erase a previously valid Vault Base fill",async()=>{
 const f=nativeRuntimeFixture();const first=f.rh.vaultLedgerEventPage(1)[0];if(first.kind!=="weth_in")throw new Error("fixture");
 const s=f.rh.vaultLedgerState()!;f.rh.commitVaultLedger({expectedRevision:1,state:{...s,revision:2},blocks:[],events:[],classifications:[{eventId:first.id,source:"base",baseFill:{protocol:BASE_BUYBACK_PROTOCOL,treasury:BASE_BUYBACK_TREASURY,treasuryEventId:first.id,treasuryRevision:1,fragments:[{batchId:`native-source:${hash(2)}`,amount:"5"}],fillTransactionHash:first.transactionHash,fillBlockHash:first.blockHash,fillLogIndex:first.logIndex,recipient:BASE_BUYBACK_VAULT,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"5"}}]});
 let nativeDepthReads=0;const original=f.rhClient.getBlockNumber;f.rhClient.getBlockNumber=async()=>{nativeDepthReads++;return nativeDepthReads===8?0n:original();};const ledger=f.create();
 try{await ledger.reconcile();const preserved=f.rh.vaultLedgerEventPage(1)[0];assert.equal(preserved.kind==="weth_in"&&preserved.source,"base");assert.ok(nativeDepthReads>=8);f.rhClient.getBlockNumber=original;await ledger.reconcile();const report=await ledger.read();assert.equal(report.attributionReady,true);assert.equal(report.baseReceivedWeth,"10","The next maintenance turn completes the temporarily withheld forward without erasing the retained valid fill");
 }finally{await ledger.close();f.close();}
});
test("a late partial attribution projection cannot report readiness and recovers on the next bounded read",async(t)=>{
 const f=nativeRuntimeFixture(),ledger=f.create();let now=0;t.mock.method(Date,"now",()=>now);
 try{
  await ledger.reconcile();const stored=structuredClone(f.rh.vaultLedgerEventPage()),forward=f.deps.verifyForward;let slow=true;
  f.deps.verifyForward=async(...args:any[])=>{if(slow){slow=false;now+=12_001;throw new Error("Forward receipt RPC completed after this session deadline");}return forward(...args);};
  const incomplete=await ledger.read();assert.equal(incomplete.attributionReady,false);assert.match(incomplete.reason!,/budget|pending/i);assert.deepEqual(f.rh.vaultLedgerEventPage(),stored,"Timeout changes this read's completion, never retained financial evidence");
  f.deps.verifyForward=forward;const recovered=await ledger.read();assert.equal(recovered.attributionReady,true);assert.equal(recovered.baseReceivedWeth,"10");
 }finally{await ledger.close();f.close();}
});
test("temporary Base release verification failure cannot replace retained Treasury classification with unknown fragments",async()=>{
 const f=nativeRuntimeFixture(),ledger=f.create(),id=vaultEventId(hash(3),3),retained=structuredClone(f.rh.custodyLedgerEventPage("robinhood_treasury").find(event=>event.id===id)!);
 const verify=f.deps.verifyRelease;
 try{
  await ledger.reconcile();assert.equal((await ledger.read()).baseReceivedWeth,"10");
  f.deps.verifyRelease=async()=>{throw new Error("Temporary Base receipt RPC failure");};
  await ledger.reconcile();const withheld=await ledger.custody();assert.equal(withheld.automation.withheldEventIds.length,1);assert.equal(withheld.treasury.assets[0].baseReceived,"0");
  const actual=f.rh.custodyLedgerEventPage("robinhood_treasury").find(event=>event.id===id)!;
  assert.deepEqual(actual.fragments,retained.fragments,"A temporary read projection cannot destroy independently retained canonical funding fragments");assert.deepEqual(actual.evidence,retained.evidence);
  f.deps.verifyRelease=verify;assert.equal((await ledger.custody()).treasury.assets[0].baseReceived,"10");await ledger.reconcile();assert.equal((await ledger.read()).baseReceivedWeth,"10");
 }finally{await ledger.close();f.close();}
});

test("source completeness is false for a quarantined asset while verified balances and received WETH remain visible",async()=>{
 const f=nativeRuntimeFixture(),bad=addr(90),state=f.source.custodyLedgerState("base_automation")!;
 f.source.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,openingBalances:{...state.openingBalances,[bad]:"0"},observedBalances:{...state.observedBalances,[bad]:"0"},assetErrors:{[bad]:"Token RPC unavailable; asset attribution withheld"}},blocks:[],events:[]});
 const ledger=f.create();try{const report=await ledger.sourceStatus();assert.equal(report.ready,false);assert.equal(report.receivedWeth,"10");assert.equal(report.assets.find(row=>row.asset.toLowerCase()===BASE_BUYBACK_WETH.toLowerCase())!.verifiedClaimed,"10");assert.equal(report.assets.find(row=>row.asset===bad)!.pending,"0");assert.equal((await ledger.custody()).automation.ready,true,"Other verified assets remain usable; completeness does not disable their keeper gate");}finally{await ledger.close();f.close();}
});

test("a bridged bad source lot cannot poison healthy WETH lots sharing Treasury, Vault and one execution",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-mixed-source-isolation-")),runtime=runtimeFromEnv(4663,{CHAIN_MODE:"robinhood",DATA_DIR:directory}),rh=new Store(runtime.dataDir,4663),source=new Store(join(directory,"source"),8453);
 const collector=addr(60),automation=addr(61),swapper=addr(62),assets=[BASE_BUYBACK_WETH,addr(63),addr(64)],b=(n:number)=>({number:String(n),hash:hash(n+2000),parentHash:hash(n+1999)});
 const movement=(tx:number,index:number,asset:Address,from:Address,to:Address,amount:string):CustodyEvent=>({id:vaultEventId(hash(tx),index),transactionHash:hash(tx),blockNumber:"100",blockHash:b(100).hash,transactionIndex:tx,logIndex:index,asset,from,to,kind:to===automation||to===BASE_BUYBACK_TREASURY?"in":"out",amount});
 const releases:CustodyEvent[]=[],sourceEvents:CustodyEvent[]=[],treasuryEvents:CustodyEvent[]=[],proofs=new Map<Hex,any>(),batchIds:string[]=[];
 for(let i=0;i<3;i++){
  const release=movement(i*3+1,1,assets[i],collector,automation,"10"),spend=movement(i*3+2,2,assets[i],automation,RELAY_ROUTER,"10"),received=movement(i*3+3,3,BASE_BUYBACK_RH_WETH,RELAY_ROUTER,BASE_BUYBACK_TREASURY,"10"),requestId=hash(300+i);
  release.evidence={kind:"adapter_release",collector,releaseLogIndex:2,transactionHash:release.transactionHash,blockHash:release.blockHash};release.fragments=[{batchId:release.id,amount:"10"}];releases.push(release);sourceEvents.push(release,spend);
  const proof:any={version:2,protocol:BASE_BUYBACK_PROTOCOL,orderParametersVerified:false,sourceTransactionHash:spend.transactionHash,sourceBlockNumber:"100",sourceBlockHash:spend.blockHash,sourceTransferLogIndex:2,sourceDepositLogIndex:3,sourceTimestamp:"100",sourceAsset:assets[i],sourceAmount:"10",sourceNativeDeposit:"10",requestId,orderId:hash(400+i),metadata:relayRequestMetadata(requestId),automation,sourceCalldataHash:hash(500+i),treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"10",destinationTransactionHash:received.transactionHash,destinationBlockNumber:"100",destinationBlockHash:received.blockHash,destinationTransferLogIndex:3,destinationMovementLogIndex:4};
  const id=`native-source:${spend.transactionHash}`;batchIds.push(id);proofs.set(spend.transactionHash,proof);received.evidence={kind:"native_relay",relay:proof,sourceRevision:1,sourceEventId:spend.id};received.fragments=[{batchId:id,amount:"10"}];received.nativeRequestMetadata=proof.metadata;treasuryEvents.push(received);
  source.saveBuybackBatch({id,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,collector,kind:"native_relay",status:"received",createdAt:1,updatedAt:1,amountIn:"10",receivedAmount:"10",refundedAmount:"0",burnedAmount:"0",claimHashes:[],sourceHash:spend.transactionHash,destinationHash:received.transactionHash,relay:proof,proof:{version:2,protocol:BASE_BUYBACK_PROTOCOL,sourceHash:spend.transactionHash,destinationHash:received.transactionHash}});
 }
 const out=movement(10,10,BASE_BUYBACK_RH_WETH,BASE_BUYBACK_TREASURY,BASE_BUYBACK_VAULT,"25");treasuryEvents.push(out);
 const sourceState:CustodyState={version:1,id:"base_automation",chainId:8453,account:automation,revision:1,checkpoint:b(0),cursor:b(100),openingBalances:Object.fromEntries(assets.map(asset=>[asset.toLowerCase(),"0"])),observedBalances:Object.fromEntries(assets.map(asset=>[asset.toLowerCase(),"0"])),assetErrors:{[assets[1].toLowerCase()]:"Token balance unavailable; source asset quarantined"},updatedAt:1,blockedReason:null};
 const treasuryState:CustodyState={...sourceState,id:"robinhood_treasury",chainId:4663,account:BASE_BUYBACK_TREASURY,openingBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"0"},observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"5"},assetErrors:{}};
 const vaultState:VaultLedgerState={version:1,chainId:4663,vault:BASE_BUYBACK_VAULT,weth:BASE_BUYBACK_RH_WETH,swapper,revision:1,checkpoint:{...b(0),wethBalance:"0",totalSpent:"0",totalBurned:"0",establishedAt:1},cursor:b(100),observedBalance:"5",observedTotalSpent:"20",observedTotalBurned:"2000",updatedAt:1,blockedReason:null};
 const fill:VaultBaseFillEvidence={protocol:BASE_BUYBACK_PROTOCOL,treasury:BASE_BUYBACK_TREASURY,treasuryEventId:out.id,treasuryRevision:1,forwarderLogIndex:11,fragments:[{batchId:batchIds[0],amount:"10"},{batchId:batchIds[1],amount:"10"},{batchId:batchIds[2],amount:"5"}],fillTransactionHash:out.transactionHash,fillBlockHash:out.blockHash,fillLogIndex:10,recipient:BASE_BUYBACK_VAULT,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"25"};
 const vaultEvents:VaultLedgerEvent[]=[{...out,kind:"weth_in",source:"base",baseFill:fill},{...movement(11,20,BASE_BUYBACK_RH_WETH,BASE_BUYBACK_VAULT,swapper,"20"),kind:"weth_out"},{...movement(11,21,BASE_BUYBACK_RH_WETH,BASE_BUYBACK_VAULT,swapper,"20"),kind:"executed",caller:addr(65),wethAmount:"20",museToDead:"2000",profit:"3"}];
 source.commitCustodyLedger({expectedRevision:0,state:sourceState,blocks:[b(0),b(100)],events:sourceEvents});rh.commitCustodyLedger({expectedRevision:0,state:treasuryState,blocks:[b(0),b(100)],events:treasuryEvents});rh.commitVaultLedger({expectedRevision:0,state:vaultState,blocks:[b(0),b(100)],events:vaultEvents});
 const client=(chainId:number)=>({getChainId:async()=>chainId,getBlockNumber:async()=>101n,getBlock:async({blockNumber}:any)=>({...b(Number(blockNumber)),number:blockNumber}),getCode:async()=>"0x6000",getLogs:async()=>[],readContract:async({functionName}:any)=>functionName==="totalSpent"?20n:functionName==="totalBurned"?2000n:5n});
 const deps:any={manifest:{status:"deployed_verified",collector:{address:collector},activation:{status:"not_run"}},confirmations:1n,openPeerStore:async()=>source,createPeerClient:()=>client(8453),verifyCollector:async()=>({collector,automationReceiver:automation,runtimeHash:keccak256("0x6000"),initialDeploymentBlock:"0"}),verifyRobinhoodGraph:async()=>({vault:BASE_BUYBACK_VAULT,weth:BASE_BUYBACK_RH_WETH,swapper}),verifyNativeRelay:async(_source:any,_rh:any,proof:any)=>proofs.get(proof.sourceHash),verifyRelease:async(_client:any,event:CustodyEvent)=>releases.find(release=>release.id===event.id)!.evidence,verifyForward:async()=>({forwarderLogIndex:11,transferLogIndex:10})};
 const ledger=createVaultLedgerRuntime({runtime,store:rh,client:client(4663) as any},deps);
 try{
  const assertHealthy=async()=>{const custody=await ledger.custody();assert.doesNotThrow(()=>assertNativeCustodyReadiness(custody));assert.equal(custody.treasury.assets[0].baseReceived,"20");assert.equal(custody.treasury.withheldEventIds.length,1);assert.equal((await ledger.sourceStatus()).ready,false,"Display completeness stays false without poisoning spend readiness");const report=await ledger.read();assert.equal(report.attributionReady,true);assert.equal(report.totalMuseToDead,"2000");assert.equal(report.totalCallerProfit,"3");assert.equal(report.baseAttributedMuseToDead,"1000");assert.equal(report.basePendingWeth,"5");assert.equal(report.batches.some(row=>row.batchId===batchIds[1]),false);assert.equal(report.lots.reduce((sum,lot)=>sum+BigInt(lot.remaining),0n),5n);assert.equal(report.allocations.reduce((sum,row)=>sum+BigInt(row.museToDead),0n),2000n);};
  await assertHealthy();assert.equal((rh.vaultLedgerEventPage(1)[0] as any).baseFill.fragments[1].batchId,batchIds[1],"Read projection preserves original proof for recovery");await ledger.reconcile();await assertHealthy();
  let state=source.custodyLedgerState("base_automation")!;source.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,assetErrors:{}},blocks:[],events:[]});await ledger.reconcile();assert.equal((await ledger.read()).baseAttributedMuseToDead,"2000");
  const bad=source.getBuybackBatch(batchIds[1])!;source.saveBuybackBatch({...bad,status:"reorg",updatedAt:2});await assertHealthy();await ledger.reconcile();await assertHealthy();source.saveBuybackBatch({...bad,status:"received",updatedAt:3});await ledger.reconcile();assert.equal((await ledger.read()).baseAttributedMuseToDead,"2000");
  const stateRh=rh.custodyLedgerState("robinhood_treasury")!;rh.commitCustodyLedger({expectedRevision:stateRh.revision,state:{...stateRh,revision:stateRh.revision+1,observedBalances:{[BASE_BUYBACK_RH_WETH.toLowerCase()]:"999"}},blocks:[],events:[]});assert.equal((await ledger.custody()).ready,false,"Actual Treasury balance mismatch remains a spend blocker");
 }finally{await ledger.close();rh.close();try{source.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});

test("manual read overlay leaves real production audit files, retry clocks and financial journals byte-for-byte unchanged",async()=>{
 const f=nativeRuntimeDustFixture(1),directory=join(f.directory,"production-audits"),production=baseOperatorAuditStore(directory),before=f.rh.backup();let writes=0;
 const sentinel={id:`internal_native_destination_capture:${hash(888)}`,protocol:"internal_native_destination_capture_v1",retryAfter:12345};assert(await production.compareAndSetBuybackAudit(sentinel,null));
 const files=()=>Object.fromEntries(readdirSync(directory).map(name=>[name,readFileSync(join(directory,name),"utf8")])),beforeFiles=files();
 const privateReadonly=new Proxy(production,{get(target,key){if(key==="compareAndSetBuybackAudit")return()=>{writes++;throw new Error("Production private audits are read-only");};return Reflect.get(target,key,target);}});
 const financialReadonly=new Proxy(f.rh,{get(target,key){if(["saveBuybackBatch","compareAndSetBuybackAudit","commitCustodyLedger","commitVaultLedger"].includes(String(key)))return()=>{writes++;throw new Error("Financial journals are read-only");};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 f.deps.verifyNativeDestinationProvider=async()=>{throw new NativeDestinationProviderPendingError();};
 const ledger=createVaultLedgerRuntime({runtime:f.runtime,store:financialReadonly,client:f.rhClient as any},{...f.deps,auditStore:readonlyBaseAuditOverlay(privateReadonly)});
 try{const report=await ledger.custody();assert.equal(report.ready,true);assert.equal(report.treasury.assets[0].baseReceived,"10");assert.equal(writes,0);assert.deepEqual(files(),beforeFiles);assert.deepEqual(f.rh.backup(),before);assert.deepEqual(await production.getBuybackBatch(sentinel.id),sentinel);}
 finally{await ledger.close();f.close();}
});
test("Treasury code capture runs after canonical indexing and before source verification even when its funding asset is withheld",async()=>{
 const f=nativeRuntimeDustFixture(0),order:string[]=[];const sourceVerify=f.deps.verifyNativeRelay;
 f.deps.verifyNativeDestinationProvider=async()=>{order.push("capture");return true;};
 f.deps.verifyNativeRelay=async(...args:any[])=>{order.push("source-proof");return sourceVerify(...args);};
 f.deps.verifyRelease=async()=>{order.push("source-release");throw new Error("Source asset is temporarily quarantined");};
 const ledger=f.create();try{await ledger.reconcile();assert.equal(order[0],"capture");assert(order.includes("source-release"));assert.equal(f.rh.custodyLedgerState("robinhood_treasury")!.cursor.number,"100");}
 finally{await ledger.close();f.close();}
});

test("more than 512 sustained pending candidates remain bounded and a later new authenticated duplicate is still found",async t=>{
 const f=nativeRuntimeDustFixture(520),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!;let now=10000;t.mock.method(Date,"now",()=>now);
 const authenticate=async(_client:any,tx:Hex)=>{if(tx===hash(9999))return true;throw new NativeDestinationProviderPendingError("Unverified fake-positive hint");};
 const read=(events=f.events)=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:"bounded-pending-overflow",treasuryState:state,events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate});
 try{for(let turn=0;turn<65;turn++){const result=await read();assert.equal(result.pending,true);assert.deepEqual(result.proof,f.proof);}
  const audit=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;assert.equal((audit.pendingCandidates as any[]).length,512);assert.ok(audit.overflowStart);assert.equal(f.counters().receipts,520);assert.equal(audit.after,undefined);
  const actual={...f.events[0],id:vaultEventId(hash(9999),0),transactionHash:hash(9999),transactionIndex:9999};
  await assert.rejects(()=>read([...f.events,actual]),/multiple canonical/);const current=f.rh.getBuybackBatch(audit.id)!;
  assert.equal((current.pendingCandidates as any[]).length,512);assert.equal((current.conflict as any).eventId,actual.id);assert.equal(f.events.length,520,"Overflow never deletes financial events or treats them as conclusive");
 }finally{f.close();}
});
test("overflow and retained pending retries keep a fair share during continued new pending arrivals",async t=>{
 const f=nativeRuntimeDustFixture(520),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!,events=[...f.events],seen:Hex[]=[];let now=10000;t.mock.method(Date,"now",()=>now);
 let conflict:Hex|undefined;
 const authenticate=async(_client:any,tx:Hex)=>{seen.push(tx);if(tx===conflict)return true;throw new NativeDestinationProviderPendingError();};
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:"fair-pending-overflow",treasuryState:state,events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate});
 try{for(let turn=0;turn<65;turn++)await read();seen.length=0;now+=30001;
  for(let turn=0;turn<3;turn++){for(let index=0;index<8;index++){const tx=hash(10000+turn*8+index);events.push({...f.events[0],id:vaultEventId(tx,0),transactionHash:tx,transactionIndex:10000+turn*8+index});}
   await read();assert(seen.includes(f.events[turn].transactionHash),"Old retained pending work keeps a reserved retry slot");assert(seen.includes(f.events[512+turn].transactionHash),"Old overflow rows are revisited instead of being silently lost");now+=30001;
  }
  conflict=f.events[515].transactionHash;await assert.rejects(read,/multiple canonical/);
  const audit=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;assert.equal((audit.pendingCandidates as any[]).length,512);assert.equal((audit.conflict as any).eventId,f.events[515].id);
 }finally{f.close();}
});

test("read-only audit composition prefers the actual canonical Base scope and falls back to local facts without a production write",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-read-source-facts-")),source=new Store(join(directory,"base"),8453),other=new Store(join(directory,"robinhood"),4663),local=baseOperatorAuditStore(join(directory,"operator"));
 const id=`internal_native_destination_code:${hash(700)}`,row={id,protocol:"internal_native_destination_code_v1",verifiedAt:"2026-10-11T00:00:00.000Z",marker:"canonical"},fallback={...row,marker:"local"};let writes=0,localReads=0;
 source.compareAndSetBuybackAudit(row,null);other.compareAndSetBuybackAudit({...row,marker:"wrong-scope"},null);await local.compareAndSetBuybackAudit(fallback,null);
 const before=source.backup(),beforeRh=other.backup(),canonicalReadonly=await openVaultLedgerReadOnlyStore(runtimeFromEnv(8453,{CHAIN_MODE:"base",DATA_DIR:directory}));
 const baseReadSpy=new Proxy(canonicalReadonly,{get(target,key){if(["compareAndSetBuybackAudit","saveBuybackBatch","commitCustodyLedger","commitVaultLedger"].includes(String(key)))return()=>{writes++;throw new Error("Canonical production store is readonly");};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 const localReadSpy={getBuybackBatch:async(id:string)=>{localReads++;return local.getBuybackBatch(id);}},combined=readonlyCanonicalBaseAuditSource(baseReadSpy,localReadSpy),overlay=readonlyBaseAuditOverlay(combined);
 try{assert.deepEqual(await overlay.getBuybackBatch(id),row);assert.equal(localReads,0);assert(await overlay.compareAndSetBuybackAudit({...row,temporary:"display-only"},row));assert.deepEqual(await source.getBuybackBatch(id),row);
  const missingId=`internal_native_destination_code:${hash(701)}`,localOnly={...fallback,id:missingId};await local.compareAndSetBuybackAudit(localOnly,null);
  assert.deepEqual(await combined.getBuybackBatch(missingId),localOnly);assert.equal(localReads,1);
  assert.deepEqual(await readonlyCanonicalBaseAuditSource({getBuybackBatch:async()=>{throw new Error("Canonical cache temporarily unavailable");}},localReadSpy).getBuybackBatch(id),fallback);
  assert.equal(writes,0);assert.deepEqual(source.backup(),before);assert.deepEqual(other.backup(),beforeRh);assert(!readdirSync(join(directory,"operator")).some(name=>name.endsWith(".lock")));
 }finally{await canonicalReadonly.close();source.close();other.close();rmSync(directory,{recursive:true,force:true});}
});

test("import/reconcile reuse canonical destination code facts while all other progress and CAS stay in the actual local audit store",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-cli-code-source-")),source=new Store(join(directory,"base"),8453),local=baseOperatorAuditStore(join(directory,"operator"));
 const codeId=`internal_native_destination_code:${hash(710)}`,candidateId=`internal_native_destination:${hash(711)}`,code={id:codeId,protocol:"internal_native_destination_code_v1",verifiedAt:"2026-10-11T00:00:00.000Z",marker:"keeper-code"},localProgress={id:candidateId,protocol:"internal_native_destination_audit_v1",marker:"local-cursor"};
 source.compareAndSetBuybackAudit(code,null);source.compareAndSetBuybackAudit({...localProgress,marker:"canonical-cursor"},null);await local.compareAndSetBuybackAudit(localProgress,null);
 const before=source.backup(),canonicalReadonly=await openVaultLedgerReadOnlyStore(runtimeFromEnv(8453,{CHAIN_MODE:"base",DATA_DIR:directory})),gets:string[]=[];let canonicalWrites=0,localWrites=0;
 const canonical={getBuybackBatch:(id:string)=>{gets.push(id);return canonicalReadonly.getBuybackBatch(id);},compareAndSetBuybackAudit:async()=>{canonicalWrites++;throw new Error("Canonical peer cannot write");}},localSpy={getBuybackBatch:local.getBuybackBatch,compareAndSetBuybackAudit:async(...args:Parameters<typeof local.compareAndSetBuybackAudit>)=>{localWrites++;return local.compareAndSetBuybackAudit(...args);}};
 const joined=destinationCodeAuditStore(localSpy,canonical);
 try{assert.deepEqual(await joined.getBuybackBatch(codeId),code);assert.deepEqual(await joined.getBuybackBatch(candidateId),localProgress);assert.deepEqual(gets,[codeId],"Candidate cursor/financial progress never comes from a different CAS backend");
  assert(await joined.compareAndSetBuybackAudit({...localProgress,marker:"new-local-cursor"},localProgress));assert.equal(localWrites,1);assert.equal(canonicalWrites,0);assert.deepEqual(source.backup(),before);
  assert.equal((await local.getBuybackBatch(candidateId))!.marker,"new-local-cursor");assert.equal((await source.getBuybackBatch(candidateId))!.marker,"canonical-cursor");
 }finally{await canonicalReadonly.close();source.close();rmSync(directory,{recursive:true,force:true});}
});

test("R9 a previously scanned overflow candidate retries after recovery while new pending dust continues",async t=>{
 const f=nativeRuntimeDustFixture(520),batch=f.source.getBuybackBatch(`native-source:${hash(2)}`) as any,state=f.rh.custodyLedgerState("robinhood_treasury")!,events=[...f.events],seen:Hex[]=[];let recovered=false;t.mock.method(Date,"now",()=>10000);
 const old=f.events[512],authenticate=async(_client:any,tx:Hex)=>{seen.push(tx);if(recovered&&tx===old.transactionHash)return true;throw new NativeDestinationProviderPendingError();};
 const read=()=>readAuditedNativeRelay({source:f.sourceClient as any,destination:f.rhClient as any,store:f.rh,batch,graphFingerprint:"fixed-overflow-cycle",treasuryState:state,events,budget:nativeCandidateBudget(),deadline:Infinity,verify:async()=>f.proof,authenticate});
 const append=(turn:number)=>{for(let index=0;index<8;index++){const tx=hash(20000+turn*8+index);events.push({...old,id:vaultEventId(tx,0),transactionHash:tx,transactionIndex:20000+turn*8+index});}};
 try{for(let turn=0;turn<65;turn++)await read();seen.length=0;append(0);await read();assert(seen.includes(old.transactionHash));recovered=true;let conflict=false;
  for(let turn=1;turn<=6;turn++){append(turn);try{await read();}catch(error){assert.match(String(error),/multiple canonical/);conflict=true;break;}}
  assert.equal(conflict,true,"A fixed cycle upper bound revisits old recovery; continued new arrivals cannot extend it forever");
  const audit=f.rh.listBuybackBatches().find(row=>row.protocol==="internal_native_destination_audit_v1")!;assert.equal((audit.pendingCandidates as any[]).length,512);assert.equal((audit.conflict as any).eventId,old.id);
 }finally{f.close();}
});
