import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createDualChainApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { BASE_COLLECTOR_MANIFEST, baseCollectorExpectedRuntime, baseCollectorGraphFingerprint, BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH,
  BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH, BASE_SPLITS_PROXY_HASH } from "../server/base-collector";
import { keccak256, padHex, zeroHash, type Address } from "viem";
import { persistBaseActivationRecord } from "../server/base-activation-record";
const treasury="0xc4F87C3715374445C4657aa14c47CBB339b59d1A",collector="0x1111111111111111111111111111111111111111";
const automationReceiver="0x2222222222222222222222222222222222222222" as Address;

async function fixture(publicScope=false){
  const directory=mkdtempSync(join(tmpdir(),"base-integration-"));
  const environment={CHAIN_MODE:"base",DATA_DIR:directory,BASE_PLATFORM_TREASURY:treasury,ROBINHOOD_PLATFORM_TREASURY:treasury,
    BASE_FEE_COLLECTOR_ADDRESS:collector,ENABLE_BASE_TRANSACTIONS:"true",NODE_ENV:"development",ALCHEMY_API_KEY:"offline-test-key",SUPABASE_DATA_SCOPE:"verify-base-canary"};
  const base=runtimeFromEnv(8453,environment),rh=runtimeFromEnv(4663,environment);
  // The private launch scope label is copied here deliberately. It cannot serve as an owner authorization.
  base.dataScope=publicScope?"base":"verify-base-canary";
  const {app,services}=createDualChainApp(undefined,"loopback",[base,rh]);
  const baseService=services.get(8453)!;
  baseService.assertNetwork=async()=>{};
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const origin=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;
  return{origin,services,base,async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));for(const service of services.values()){await service.store.close()}rmSync(directory,{recursive:true,force:true})}};
}
function reviewedFixture(t: import("node:test").TestContext) {
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  BASE_COLLECTOR_MANIFEST.collector.address = collector;
  BASE_COLLECTOR_MANIFEST.constants.automationReceiver = automationReceiver;
  BASE_COLLECTOR_MANIFEST.status = "deployed_verified";
  const owner = BASE_COLLECTOR_MANIFEST.constants.governor!,hash = `0x${"12".repeat(32)}` as const;
  Object.assign(BASE_COLLECTOR_MANIFEST.collector,{transactionHash:hash,blockNumber:"1"});
  const signer={slot1:padHex(owner,{size:32}),slot2:zeroHash};
  BASE_COLLECTOR_MANIFEST.automationAccount={address:automationReceiver,owner,runtimeHash:BASE_SPLITS_PROXY_HASH,
    implementation:{address:BASE_SPLITS_IMPLEMENTATION,runtimeHash:BASE_SPLITS_IMPLEMENTATION_HASH},factory:{address:BASE_SPLITS_FACTORY,runtimeHash:BASE_SPLITS_FACTORY_HASH},
    threshold:1,signers:[{...signer,index:0}],initializationHash:hash,blockNumber:"1",creation:{owner,threshold:1,signers:[signer],salt:"8453"}};
  BASE_COLLECTOR_MANIFEST.collector.runtimeHash=keccak256(baseCollectorExpectedRuntime(BASE_COLLECTOR_MANIFEST));
  // Complete legacy payload presence for isolated display fixtures; cryptographic and receipt verification has separate tests.
  BASE_COLLECTOR_MANIFEST.activation = {status:"canary_verified",nativeExecution:{},nativeRunAcceptance:{} as any,
    walletAcceptance:{} as any,pauseRollbackAcceptance:{} as any};BASE_COLLECTOR_MANIFEST.canaryAuthorization={} as any;
  t.after(() => Object.assign(BASE_COLLECTOR_MANIFEST, manifest));
}
async function seedLaunchAcceptance(store: Parameters<typeof persistBaseActivationRecord>[2]) {
  const hash = `0x${"12".repeat(32)}` as const, manifest = BASE_COLLECTOR_MANIFEST;
  // Only a private-store unit fixture, never actual governor or wallet acceptance.
  manifest.activation.nativeExecution = { proof: { sourceHash: hash, destinationHash: hash } };
  manifest.activation.nativeRunAcceptance = { signature: "0x1234" } as any;
  manifest.activation.walletAcceptance = { signature: "0x2345" } as any;
  manifest.activation.pauseRollbackAcceptance = { signature: "0x3456" } as any;
  manifest.canaryAuthorization = { signature: "0x4567" } as any;
  const client = (chainId: number) => ({ getChainId: async () => chainId,
    getBlock: async ({ blockNumber, blockTag }: any) => ({ number: blockNumber ?? (blockTag === "finalized" ? 2n : 100n), hash }) });
  await persistBaseActivationRecord(client(8453) as any, client(4663) as any, store, manifest, baseCollectorGraphFingerprint(manifest),
    { source: [{ number: 1n, hash }], destination: [{ number: 1n, hash }] },
    { source: { number: 100n, hash }, destination: { number: 100n, hash } });
}
test("a copied canary scope and enabled flag cannot activate a pending Collector or expose RH signing targets",async t=>{
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  t.after(() => Object.assign(BASE_COLLECTOR_MANIFEST, manifest));
  BASE_COLLECTOR_MANIFEST.status = "not_deployed";
  Object.assign(BASE_COLLECTOR_MANIFEST.collector, { address: null, runtimeHash: null, transactionHash: null, blockNumber: null });
  BASE_COLLECTOR_MANIFEST.constants.automationReceiver = null;
  Object.assign(BASE_COLLECTOR_MANIFEST.automationAccount, { address: null, runtimeHash: null, implementation: null, owner: null, ownerRuntimeHash: null,
    threshold: null, signers: [], initializationHash: null, blockNumber: null, creation: null });
  const f=await fixture();try{
    const response=await fetch(`${f.origin}/api/chains/8453/config`),config=await response.json();assert.equal(response.status,200);
    assert.equal(config.writesEnabled,false);assert.equal(config.feeEngine,null);
    for(const field of ["buybackVault","buybackExecutor","assetFeedOracle","wethForwarder","automationTreasury","automationReceiver"])assert.equal(config[field],null,field);
    assert.match(config.blockReason,/Base issuance awaits|Awaiting runtime activation/);
  }finally{await f.close()}
});

test("Base quote and manual authorization API endpoints remain retired before accepting arbitrary calldata",async()=>{
  const f=await fixture();try{
    for(const route of ["/buyback/engine/quote","/buyback/quote","/buyback/batches"]){
      const response=await fetch(`${f.origin}/api/chains/8453${route}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({calldata:"0x1234",token:collector,amount:"1",caller:treasury})});
      assert.equal(response.status,410,route);assert.match((await response.json()).error,/Splits native Automation|retired/);
    }
  }finally{await f.close()}
});

test("public batch pagination omits internal native audits and still advances through an internal-only page",async()=>{
 const f=await fixture();try{
  const store=f.services.get(8453)!.store;
  await store.saveBuybackBatch({id:"visible",protocol:"splits_native_relay_v1",sourceChainId:8453,destinationChainId:4663,collector,kind:"native_relay",status:"unknown",createdAt:1,updatedAt:1,amountIn:"0",receivedAmount:"0",refundedAmount:"0",burnedAmount:"0",claimHashes:[]});
  await store.saveBuybackBatch({id:"internal-native-proof",protocol:"internal_native_module_audit_v1",updatedAt:2,internalProof:"retained-audit-details"});
  const page=(before?:{sequence:string})=>fetch(`${f.origin}/api/chains/8453/buyback/batches?limit=1${before?`&before=${encodeURIComponent(JSON.stringify(before))}`:""}`).then(response=>response.json());
  const first=await page();assert.deepEqual(first.items,[]);assert.ok(first.nextCursor);assert.equal(JSON.stringify(first).includes("retained-audit-details"),false);const second=await page(first.nextCursor);assert.equal(second.items[0].id,"visible");
 }finally{await f.close();}
});


test("historical batch API pages use immutable sequence when an unseen row is updated mid-scan", async () => {
  const f=await fixture();
  try {
    const store=f.services.get(8453)!.store;

    const row=(id:string,updatedAt:number)=>({id,protocol:"splits_native_relay_v1",sourceChainId:8453,destinationChainId:4663,
      collector,kind:"native_relay",status:"unknown",createdAt:1,updatedAt,amountIn:"1",receivedAmount:"0",refundedAmount:"0",burnedAmount:"0",claimHashes:[]});
    for(const id of ["first","second","third"])await store.saveBuybackBatch(row(id,1));
    const page=async(before?:{sequence:string})=>(await fetch(`${f.origin}/api/chains/8453/buyback/batches?limit=1${before?`&before=${encodeURIComponent(JSON.stringify(before))}`:""}`)).json();
    const first=await page();assert.equal(first.items[0].id,"third");assert.match(first.nextCursor.sequence,/^[1-9]\d*$/);
    await store.saveBuybackBatch(row("first",99_999));
    const second=await page(first.nextCursor),third=await page(second.nextCursor);
    assert.deepEqual([first.items[0].id,second.items[0].id,third.items[0].id],["third","second","first"]);
  } finally { await f.close(); }
});


test("trusted Splits issuance needs a completed wiring record, flag and CAS resume while financial execution stays unperformed",async t=>{
  reviewedFixture(t);let now=1000;t.mock.method(Date,"now",()=>now);const manifest=BASE_COLLECTOR_MANIFEST,hash=`0x${"12".repeat(32)}` as const;
  manifest.activation={status:"trusted_splits_authorized",trustedSplitsAcceptance:{version:1,sourceChainId:8453,destinationChainId:4663,
    graphFingerprint:baseCollectorGraphFingerprint(manifest),collector:manifest.collector.address!,automationReceiver:manifest.constants.automationReceiver!,
    destinationTreasury:manifest.constants.destinationTreasury,destinationWeth:manifest.constants.destinationWeth,destinationVault:manifest.finalSettlement.vault,
    keeper:"0xd3f11a4DDcED57aC4E41F8CE7fD323959667e278",ruleId:manifest.nativeRule.ruleId!,configurationSha256:manifest.nativeRule.configurationSha256!,
    trustSplitsNativeExecution:true,signer:manifest.constants.governor!,signature:"0x1234"}};manifest.canaryAuthorization=null;
  const f=await fixture(true),service=f.services.get(8453)!;let rpcReads=0;
  Object.assign(service,{client:{getChainId:async()=>{rpcReads++;throw new Error("Issuance uses a previously verified private wiring record");}}});
  const read=()=>fetch(`${f.origin}/api/chains/8453/config`).then(response=>response.json());
  try{
    await service.store.updateRuntimeControl(false,"isolated owner control",0);assert.equal((await read()).writesEnabled,false,"A trust flag alone is insufficient");
    const client=(chainId:number)=>({getChainId:async()=>chainId,getBlock:async({blockNumber,blockTag}:any)=>({number:blockNumber??(blockTag==="finalized"?2n:100n),hash})});
    // Private operator-result fixture only: signature verification is tested at the actual authority boundary separately.
    await persistBaseActivationRecord(client(8453) as any,client(4663) as any,service.store,manifest,baseCollectorGraphFingerprint(manifest),
      {source:[{number:1n,hash}],destination:[{number:1n,hash}]},{source:{number:100n,hash},destination:{number:100n,hash}});
    now+=60001;const ready=await read();assert.equal(ready.writesEnabled,true);assert.equal(ready.feeEngine,collector);assert.equal(rpcReads,0);
    assert.equal(manifest.activation.nativeExecution,undefined);assert.equal(manifest.activation.walletAcceptance,undefined);
    f.base.config.writesEnabled=false;now+=60001;assert.equal((await read()).writesEnabled,false);f.base.config.writesEnabled=true;
    await service.store.updateRuntimeControl(true,"isolated pause",1);now+=60001;assert.equal((await read()).writesEnabled,false);
  }finally{await f.close();}
});

test("Base counter GETs retain five-minute cache even with no-cache; removed ledger routes are absent",async t=>{
 reviewedFixture(t);let now=1000;t.mock.method(Date,"now",()=>now);const f=await fixture(true),service=f.services.get(8453)!;let blockReads=0,multicalls=0;
 t.mock.method(service.client,"getBlockNumber",async()=>{blockReads++;return 100n;});
 t.mock.method(service.client,"multicall",async({contracts,blockNumber,batchSize}:any)=>{multicalls++;assert.equal(blockNumber,100n);assert(batchSize>=65536);return contracts.map((row:any)=>({status:"success",result:row.functionName==="paused"?false:row.functionName==="totalClaimed"?8n:row.functionName==="totalReleased"?3n:1n}));});
 t.mock.method(service.client,"getLogs",async()=>{throw Error("Public counters must not scan history");});
 t.mock.method(service.client,"getCode",async()=>{throw Error("Public counters must not redo launch validation");});
 const read=async()=>{const response=await fetch(`${f.origin}/api/chains/8453/buyback/engine`,{headers:{"cache-control":"no-cache"}});assert.equal(response.status,200);return response.json();};
 try {
  const values=await Promise.all(Array.from({length:4},read));for(const value of values){assert.equal(value.available,true);assert.equal(value.assets.length,37);assert.equal(value.assets[0].totalClaimed,"8");assert.equal("vaultLedger" in value,false);assert.equal("totalBridgedWeth" in value,false);assert.equal("batches" in value,false);}
  assert.equal(blockReads,1);assert.equal(multicalls,1);now+=299999;await read();assert.equal(multicalls,1);now++;await read();assert.equal(multicalls,2);
  for(const chain of [8453,4663])for(const path of ["custody","vault-ledger"]){const response=await fetch(`${f.origin}/api/chains/${chain}/buyback/${path}`);assert.equal(response.status,404);}
 }finally{await f.close();}
});
test("Base issuance remains independent of fee counters, keeper availability and its paused Collector",async t=>{
 reviewedFixture(t);let now=1000;t.mock.method(Date,"now",()=>now);const f=await fixture(true),service=f.services.get(8453)!;let calls=0;
 Object.assign(service,{client:{getChainId:async()=>{calls++;throw Error("Public issuance must not access fee RPC")},readContract:async()=>{calls++;throw Error("Collector forwarding does not control issuance")}}});
 try{await service.store.updateRuntimeControl(false,"isolated activation",0);await seedLaunchAcceptance(service.store);
  const read=()=>fetch(`${f.origin}/api/chains/8453/config`).then(response=>response.json());let ready=await read();assert.equal(ready.writesEnabled,true);assert.equal(ready.feeEngine,collector);assert.equal(calls,0);
  f.base.config.writesEnabled=false;now+=60001;assert.equal((await read()).writesEnabled,false);f.base.config.writesEnabled=true;
  await service.store.updateRuntimeControl(true,"isolated pause",1);now+=60001;ready=await read();assert.equal(ready.writesEnabled,false);assert.equal(ready.controlRevision,2);assert.equal(calls,0);
 }finally{await f.close();}
});
