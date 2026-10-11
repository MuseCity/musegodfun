import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createDualChainApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { BaseFeeQuoteReader } from "../server/base-buyback";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import { emptyCustodyReport } from "../src/lib/buyback-custody-ledger";
import { BASE_COLLECTOR_MANIFEST, baseCollectorExpectedRuntime, baseCollectorGraphFingerprint, BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH,
  BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH, BASE_SPLITS_PROXY_HASH } from "../server/base-collector";
import { keccak256, padHex, zeroHash, type Address } from "viem";
import { publishBaseAuditSnapshot, publishBaseAuditFailure, readBaseAuditSnapshot, unavailableBaseCollectorStatus, type BaseAuditSnapshotContents } from "../server/buyback-audit-snapshot";
import { persistBaseActivationRecord } from "../server/base-activation-record";
import { baseCanonicalAuditLease } from "../scripts/base-buyback-keeper";
const treasury="0xc4F87C3715374445C4657aa14c47CBB339b59d1A",collector="0x1111111111111111111111111111111111111111";
const automationReceiver="0x2222222222222222222222222222222222222222" as Address;

async function fixture(publicScope=false){
  const directory=mkdtempSync(join(tmpdir(),"base-integration-"));
  const environment={CHAIN_MODE:"base",DATA_DIR:directory,BASE_PLATFORM_TREASURY:treasury,ROBINHOOD_PLATFORM_TREASURY:treasury,
    BASE_FEE_COLLECTOR_ADDRESS:collector,ENABLE_BASE_TRANSACTIONS:"true",NODE_ENV:"development",SUPABASE_DATA_SCOPE:"verify-base-canary"};
  const base=runtimeFromEnv(8453,environment),rh=runtimeFromEnv(4663,environment);
  // The private launch scope label is copied here deliberately. It cannot serve as an owner authorization.
  base.dataScope=publicScope?"base":"verify-base-canary";
  const {app,services}=createDualChainApp(undefined,"loopback",[base,rh]);
  const baseService=services.get(8453)!;
  Object.assign(baseService,{client:{getChainId:async()=>8453}});
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const origin=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;
  return{origin,services,base,async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));for(const service of services.values()){await service.vaultLedgerRuntime?.close();await service.store.close()}rmSync(directory,{recursive:true,force:true})}};
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
function hostContents(observedAt: number, sourceReady = true, fresh = true): BaseAuditSnapshotContents {
  const automation = { ...emptyCustodyReport("base_automation",100n), ready:true, fresh:true, caughtUp:true, lagBlocks:"0", checkpointBlock:"1", indexedThrough:"100", revision:1, reason:null };
  const treasuryReport = { ...emptyCustodyReport("robinhood_treasury",100n), ready:true, fresh:true, caughtUp:true, lagBlocks:"0", checkpointBlock:"1", indexedThrough:"100", revision:2, reason:null };
  const vault = { ...emptyVaultLedgerReport(100n), initialized:true, attributionReady:true, fresh, caughtUp:true, lagBlocks:"0", checkpointBlock:"1", indexedThrough:"100", reason:null, baseAttributedMuseToDead:"10", totalMuseToDead:"10" };
  return { observedAt, graph:{collector,automationReceiver,paused:false,activationVerified:true},
    collectorStatus:{...unavailableBaseCollectorStatus(),collector,automation:automationReceiver,available:true,paused:false,nativeAutomationState:"configured",assetsComplete:true,ledgerComplete:sourceReady},
    custody:{ready:fresh,reason:null,automation,treasury:treasuryReport,vault},vaultLedger:vault,
    sourceStatus:{ready:sourceReady,assets:[],receivedWeth:"0",refundedWeth:"0"},revisions:{automation:1,treasury:2,vault:3},
    anchors:[{chainId:8453,number:"164",hash:`0x${"12".repeat(32)}`},{chainId:4663,number:"164",hash:`0x${"34".repeat(32)}`}] };
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
test("Base fee status reports unavailable FIFO evidence as zero withheld attribution rather than shared global burns",async()=>{
  const f=await fixture();try{
    const response=await fetch(`${f.origin}/api/chains/8453/buyback/engine`),status=await response.json();assert.equal(response.status,200);
    assert.equal(status.kind,"base_splits_native");assert.equal(status.chainId,8453);assert.equal(status.destinationChainId,4663);
    assert.equal(status.nativeAutomationState,"unverified");assert.equal(status.automation,null);
    assert.equal(status.available,false);assert.equal(status.ledgerComplete,false);assert.equal(status.vaultLedger.attributionReady,false);
    assert.equal(status.vaultLedger.baseAttributedMuseToDead,"0");assert.equal(status.vaultLedger.basePendingWeth,"0");
    assert.equal("vaultBurned"in status,false,"RH Vault's total burns cannot masquerade as a Base amount");
  }finally{await f.close()}
});

test("Base engine completeness requires source/Treasury readiness and a caught-up Vault independently", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  reviewedFixture(t);
  let sourceReady = false;
  const f = await fixture(true);
  try {
    let fresh = true;
    const read = async () => { now += 5_001; await publishBaseAuditSnapshot(f.base,f.services.get(8453)!.store,hostContents(now,sourceReady,fresh)); return (await fetch(`${f.origin}/api/chains/8453/buyback/engine`)).json(); };
    assert.equal((await read()).ledgerComplete, false, "A verified Vault cannot hide unavailable source/Treasury evidence");
    sourceReady = true; fresh = false;
    const stale = await read(); assert.equal(stale.ledgerComplete, false); assert.equal(stale.vaultLedger.baseAttributedMuseToDead, "10", "Verified indexed history remains visible with its lag");
    fresh = true;
    assert.equal((await read()).ledgerComplete, true, "A bounded fresh journal need not coincide with the moving head");
  } finally { await f.close(); }
});

test("public Base financial reads share in-flight database reads and expire their display snapshot", async (t) => {
  let now = 1_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  reviewedFixture(t);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(true);
  try {
    const store = f.services.get(8453)!.store;
    await publishBaseAuditSnapshot(f.base,store,hostContents(now));
    const get = store.getBuybackBatch.bind(store);
    t.mock.method(store,"getBuybackBatch",async (id:string) => { calls++; await wait; return get(id); });
    t.mock.method(BaseFeeQuoteReader.prototype,"status",async()=>{throw new Error("Public request must not audit the Collector");});
    const read = async () => (await fetch(`${f.origin}/api/chains/8453/buyback/engine`)).json();
    const responses = Promise.all(Array.from({ length: 6 }, read));
    await new Promise<void>(resolve => setImmediate(resolve));
    release(); await responses; assert.equal(calls, 1);
    await read(); assert.equal(calls, 1);
    now += 5_001; await read(); assert.equal(calls, 2);
  } finally { release(); await f.close(); }
});

test("nonempty public native batches omit retained signer/order and local execution evidence", async () => {
  const f = await fixture();
  try {
    await f.services.get(8453)!.store.saveBuybackBatch({
      id: "native-private-fixture", protocol: "splits_native_relay_v1", sourceChainId: 8453, destinationChainId: 4663,
      collector, kind: "native_relay", status: "unknown", createdAt: 1, updatedAt: 1,
      amountIn: "1", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0", claimHashes: [],
      signed: "private-signed-bytes", signature: "private-signature", authorization: { signature: "private-signature" },
      journal: { hash: "retained-local-hash" }, proof: { raw: { signature: "private-order-signature" } },
    });
    const response = await fetch(`${f.origin}/api/chains/8453/buyback/engine`);
    const status = await response.json();
    assert.equal(status.batches.length, 1);
    assert.equal(status.batches[0].id, "native-private-fixture");
    for (const field of ["signed", "signature", "authorization", "journal", "proof"])
      assert.equal(field in status.batches[0], false, field);
    assert.equal(JSON.stringify(status).includes("private-signature"), false);
  } finally { await f.close(); }
});

test("Vault and custody display caches recover from transient failures and remain chain scoped", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const f = await fixture();
  try {
    let vaultCalls=0,custodyCalls=0,rhCalls=0;
    const baseRuntime=f.services.get(8453)!.vaultLedgerRuntime!;
    baseRuntime.read=async()=>{vaultCalls++;if(vaultCalls===1)throw new Error("Transient display RPC failure");return emptyVaultLedgerReport(BigInt(vaultCalls));};
    baseRuntime.custody=async()=>{custodyCalls++;return {ready:false,reason:"fixture",automation:{},treasury:{},vault:{}} as any;};
    f.services.get(4663)!.vaultLedgerRuntime!.read=async()=>{rhCalls++;return emptyVaultLedgerReport(999n);};
    const read=(chain:number,path:string)=>fetch(`${f.origin}/api/chains/${chain}/buyback/${path}`);
    assert.equal((await read(8453,"vault-ledger")).status,422);
    assert.equal((await read(8453,"vault-ledger")).status,200);
    await read(8453,"vault-ledger");assert.equal(vaultCalls,2,"Rejected reads are retried; successful ones share the snapshot");
    await Promise.all(Array.from({length:4},()=>read(8453,"custody")));assert.equal(custodyCalls,1);
    const rh=await(await read(4663,"vault-ledger")).json();assert.equal(rh.confirmedThrough,"999");assert.equal(rhCalls,1);
    now+=5_001;await read(8453,"vault-ledger");await read(8453,"custody");
    assert.equal(vaultCalls,3);assert.equal(custodyCalls,2);
  } finally { await f.close(); }
});

test("a stuck display read expires and its late completion cannot overwrite a newer snapshot",{timeout:5_000},async(t)=>{
 const f=await fixture();let calls=0,finish!:()=>void;const held=new Promise<void>(resolve=>{finish=resolve;}),originalTimeout=globalThis.setTimeout;
 t.mock.method(globalThis,"setTimeout",((callback:any,delay:any,...args:any[])=>originalTimeout(callback,delay===15_000?1:delay,...args)) as typeof setTimeout);
 f.services.get(8453)!.vaultLedgerRuntime!.read=async()=>{const call=++calls;if(call===1)await held;return emptyVaultLedgerReport(BigInt(call));};
 const read=()=>fetch(`${f.origin}/api/chains/8453/buyback/vault-ledger`,{signal:t.signal});
 try{
  const failed=await read();assert.equal(failed.status,422);assert.match(JSON.stringify(await failed.json()),/timed out/);
  const current=await read();assert.equal(current.status,200);assert.equal((await current.json()).confirmedThrough,"2");
  finish();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await(await read()).json()).confirmedThrough,"2");assert.equal(calls,2,"An abandoned request neither blocks retry nor writes stale cache");
 }finally{finish();await f.close();}
});

test("public batch pagination omits internal native audits and still advances through an internal-only page",async()=>{
 const f=await fixture();try{
  const store=f.services.get(8453)!.store;f.services.get(8453)!.vaultLedgerRuntime!.read=async()=>emptyVaultLedgerReport(0n);
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
    f.services.get(8453)!.vaultLedgerRuntime!.read=async()=>emptyVaultLedgerReport(0n);
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

test("public no-cache rereads persisted host evidence and never requests a Collector or trace audit", async t => {
  let now=1_000; t.mock.method(Date,"now",()=>now); reviewedFixture(t);
  const f=await fixture(true); let audits=0;
  t.mock.method(BaseFeeQuoteReader.prototype,"status",async()=>{audits++;throw new Error("Public audit is forbidden");});
  try {
    const store=f.services.get(8453)!.store; await publishBaseAuditSnapshot(f.base,store,hostContents(now));
    const read=(path:string,canonical=false)=>fetch(`${f.origin}/api/chains/8453/buyback/${path}`,{headers:canonical?{"cache-control":"no-cache"}:{}}).then(response=>response.json());
    await read("engine");await read("vault-ledger");await read("custody");now++;
    const unavailable=hostContents(now,false,false); unavailable.collectorStatus.nativeAutomationState="unverified";
    unavailable.vaultLedger.attributionReady=false;unavailable.custody.vault.attributionReady=false;
    await publishBaseAuditSnapshot(f.base,store,unavailable);
    assert.equal((await read("engine")).nativeAutomationState,"configured","Display may share its short snapshot");
    assert.equal((await read("engine",true)).nativeAutomationState,"unverified");
    assert.equal((await read("vault-ledger",true)).attributionReady,false);
    assert.equal((await read("custody",true)).ready,false);
    assert.equal(audits,0);
  } finally { await f.close(); }
});

test("Base issuance uses its completed acceptance and CAS controls without keeper snapshots or per-request Collector RPC", async t => {
  let now=1_000;t.mock.method(Date,"now",()=>now);reviewedFixture(t);
  const f=await fixture(true);let calls=0,recordReads=0;
  const service=f.services.get(8453)!;
  Object.assign(service,{client:{getChainId:async()=>{calls++;throw new Error("Issuance activation cannot contact the keeper RPC");},
    readContract:async()=>{calls++;throw new Error("Collector pause controls fee forwarding, not issuance");}}});
  try{
    await service.store.updateRuntimeControl(false,"isolated test activation",0);
    await seedLaunchAcceptance(service.store);
    const display=hostContents(now);display.graph!.paused=true;display.collectorStatus.paused=true;display.collectorStatus.nativeAutomationState="paused";
    await publishBaseAuditSnapshot(f.base,service.store,display);
    const get=service.store.getBuybackBatch.bind(service.store);
    t.mock.method(service.store,"getBuybackBatch",(id:string)=>{recordReads++;assert.match(id,/^internal_native_activation:/);return get(id);});
    const read=()=>fetch(`${f.origin}/api/chains/8453/config`).then(response=>response.json());
    const ready=await read();assert.equal(ready.writesEnabled,true);assert.equal(ready.feeEngine,collector);assert.equal(ready.automationReceiver,automationReceiver);
    assert.equal(recordReads,1);assert.equal(calls,0);
    // A stopped fee keeper and a paused Collector affect batching/statistics only.
    now+=60_001;assert.equal(await readBaseAuditSnapshot(f.base,{getBuybackBatch:get}),null);
    assert.equal((await read()).writesEnabled,true);
    f.base.config.writesEnabled=false;assert.equal((await read()).writesEnabled,false);f.base.config.writesEnabled=true;
    await service.store.updateRuntimeControl(true,"isolated test pause",1);
    const controlled=await read();assert.equal(controlled.writesEnabled,false);assert.equal(controlled.signingPaused,true);assert.equal(controlled.controlRevision,2);
    await service.store.updateRuntimeControl(false,"isolated test resume",2);now+=60_000;
    const expired=await read();assert.equal(expired.writesEnabled,true);assert.equal(expired.feeEngine,collector);
    assert.equal(calls,0,"Neither keeper downtime nor stale statistics can invoke chain checks or disable issuance");
  }finally{await f.close();}
});

test("trusted Splits issuance needs a completed wiring record, flag and CAS resume while financial execution stays unperformed",async t=>{
  reviewedFixture(t);const manifest=BASE_COLLECTOR_MANIFEST,hash=`0x${"12".repeat(32)}` as const;
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
    const ready=await read();assert.equal(ready.writesEnabled,true);assert.equal(ready.feeEngine,collector);assert.equal(rpcReads,0);
    assert.equal(manifest.activation.nativeExecution,undefined);assert.equal(manifest.activation.walletAcceptance,undefined);
    f.base.config.writesEnabled=false;assert.equal((await read()).writesEnabled,false);f.base.config.writesEnabled=true;
    await service.store.updateRuntimeControl(true,"isolated pause",1);assert.equal((await read()).writesEnabled,false);
  }finally{await f.close();}
});

test("Base issuance ignores residual host lease metadata in an isolated home without accessing the fee host",async t=>{
  reviewedFixture(t);const f=await fixture(true),service=f.services.get(8453)!,home=join(f.base.dataDir,"isolated-host-home");let hostReads=0,rpcReads=0;
  t.mock.method(os,"homedir",()=>{hostReads++;return home;});syncBuiltinESMExports();
  const lease=baseCanonicalAuditLease(collector),lock=`${lease}.lock`;
  assert(lease.startsWith(`${home}/`));mkdirSync(dirname(lock),{recursive:true});
  const residue=JSON.stringify({token:"offline-residual-lease",pid:99999999,host:os.hostname(),acquiredAt:0,heartbeatAt:0,leaseUntil:0});
  writeFileSync(lock,residue,{mode:0o600});hostReads=0;
  Object.assign(service,{client:{getChainId:async()=>{rpcReads++;throw new Error("Public issuance must not access the fee host");},readContract:async()=>{rpcReads++;throw new Error("Public issuance must not audit Collector state");}}});
  try{
    await service.store.updateRuntimeControl(false,"isolated residual-lock test",0);await seedLaunchAcceptance(service.store);
    const config=await fetch(`${f.origin}/api/chains/8453/config`).then(response=>response.json());
    assert.equal(config.writesEnabled,true);assert.equal(config.feeEngine,collector);
    assert.equal(hostReads,0);assert.equal(rpcReads,0);assert.equal(readFileSync(lock,"utf8"),residue);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await f.close();}
});

test("the short financial display cache cannot extend a private snapshot past its expiry", async t => {
  let now=1_000;t.mock.method(Date,"now",()=>now);reviewedFixture(t);
  const f=await fixture(true);try{
    await publishBaseAuditSnapshot(f.base,f.services.get(8453)!.store,hostContents(now));now+=59_999;
    const read=()=>fetch(`${f.origin}/api/chains/8453/buyback/engine`).then(response=>response.json());
    const live=await read();assert.equal(live.ledgerComplete,true);assert.equal(live.auditExpiresAt,61_000);
    now++;const expired=await read();assert.equal(expired.available,false);assert.equal(expired.ledgerComplete,false);
  }finally{await f.close();}
});

test("failed financial APIs retain their original observation time and expose the failed round independently",async t=>{
  let now=1_000;t.mock.method(Date,"now",()=>now);reviewedFixture(t);const f=await fixture(true);
  try{
    const store=f.services.get(8453)!.store;await publishBaseAuditSnapshot(f.base,store,hostContents(now));now+=20_000;
    await publishBaseAuditFailure(f.base,store,now);
    for(const endpoint of ["engine","vault-ledger","custody"]){
      const body=await fetch(`${f.origin}/api/chains/8453/buyback/${endpoint}`,{headers:{"cache-control":"no-cache"}}).then(response=>response.json());
      assert.equal(body.auditObservedAt,1_000);assert.equal(body.auditFailedAt,21_000);assert.equal(body.auditExpiresAt,81_000);
      if(endpoint==="engine")assert.equal(body.available,false);
      else if(endpoint==="custody")assert.equal(body.ready,false);
      else assert.equal(body.attributionReady,false);
    }
  }finally{await f.close();}
});

test("display clock skew withholds statistics while completed acceptance and CAS still permit issuance",async t=>{
  let now=1_000;t.mock.method(Date,"now",()=>now);reviewedFixture(t);const f=await fixture(true),service=f.services.get(8453)!;let rpcReads=0;
  Object.assign(service,{client:{getChainId:async()=>{rpcReads++;throw new Error("Display skew cannot request a chain audit");},readContract:async()=>{rpcReads++;throw new Error("Display skew cannot gate issuance");}}});
  const read=(path:string)=>fetch(`${f.origin}/api/chains/8453/${path}`,{headers:{"cache-control":"no-cache"}}).then(response=>response.json());
  try{
    await service.store.updateRuntimeControl(false,"isolated clock-skew test",0);await seedLaunchAcceptance(service.store);
    const snapshot=await publishBaseAuditSnapshot(f.base,service.store,hostContents(now));
    for(const workerNow of [999,61_000]){
      now=workerNow;assert.equal((await read("buyback/engine")).available,false);assert.equal((await read("config")).writesEnabled,true);
      const retained=await service.store.getBuybackBatch(snapshot.id);assert.equal(retained?.observedAt,1_000);assert.equal(retained?.expiresAt,61_000);
    }
    now=1_000;assert.equal((await read("buyback/engine")).available,true);assert.equal(rpcReads,0);
  }finally{await f.close();}
});
