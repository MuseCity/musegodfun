import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync,mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store";
import { clientBucket,expensiveRoute,IngressLimiter,PreviewQueue,RiskChallenge,SOURCE_CONCURRENCY } from "../server/abuse";
import { runtimeFromEnv } from "../server/config";
import { packPlan,unpackPlan } from "../server/plan-storage";
import { assertSecurityTransition,rollbackPreservesSafety,publishCandidate,ReleaseFailure } from "../scripts/release-policy";
import { syntheticToken } from "./fixtures";
import type { Hex, Address } from "viem";
import type { LaunchPlan } from "../src/lib/launch-plan";

test("explicit native bindings isolate stale process values and clear removed secrets",()=>{
  const env={NODE_ENV:"production",SUPABASE_URL:"https://fixture.supabase.co",SUPABASE_SECRET_KEY:"new-secret",PLATFORM_TREASURY:"0x1111111111111111111111111111111111111111",ENABLE_MAINNET_TRANSACTIONS:"false",LIFI_API_KEY:"new-lifi",PINATA_JWT:"new-pinata"};
  const snapshot=runtimeFromEnv(4663,env);
  assert.equal(snapshot.config.writesEnabled,false);assert.equal(snapshot.lifi.apiKey,"new-lifi");assert.equal(snapshot.secrets?.pinataJwt,"new-pinata");
  const cleared=runtimeFromEnv(4663,{...env,LIFI_API_KEY:undefined,PINATA_JWT:undefined});
  assert.equal(cleared.lifi.apiKey,undefined);assert.equal(cleared.secrets?.pinataJwt,undefined);
  assert.equal(snapshot.lifi.apiKey,"new-lifi","in-flight runtime snapshots are not mutated");
});
test("persistent controls default paused, use revision CAS, and survive reopen",()=>{
  const directory=mkdtempSync(join(tmpdir(),"runtime-control-"));let store=new Store(directory,31337);
  try {
    assert.equal(store.runtimeControl().paused,true);
    assert.equal(store.updateRuntimeControl(false,"local test activation",0).revision,1);
    assert.throws(()=>store.updateRuntimeControl(true,"stale writer",0),/revision/);
    store.updateRuntimeControl(true,"incident",1);store.close();store=new Store(directory,31337);
    assert.equal(store.runtimeControl().paused,true);assert.equal(store.runtimeControl().revision,2);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("both chain stores share persistent provider budget, reserve capacity and circuit",()=>{
  const directory=mkdtempSync(join(tmpdir(),"runtime-budget-"));mkdirSync(join(directory,"base"));mkdirSync(join(directory,"robinhood"));
  const a=new Store(join(directory,"base"),8453),b=new Store(join(directory,"robinhood"),4663),now=1_000_000;
  try {
    for(let i=0;i<64;i++)assert.equal((i%2?a:b).reserveBudget("lifi",now).allowed,true);
    assert.equal(a.reserveBudget("lifi",now).allowed,false);
    for(let i=0;i<16;i++)assert.equal(b.reserveBudget("lifi",now,true).allowed,true);
    assert.equal(a.reserveBudget("lifi",now,true).allowed,false);
    b.blockBudget("lifi",now+90_000);
    assert.equal(a.reserveBudget("lifi",now+61_000,true).allowed,false);
    assert.equal(a.reserveBudget("lifi",now+91_000).allowed,true);
  }finally{a.close();b.close();rmSync(directory,{recursive:true,force:true});}
});
test("IPv6 /64 addresses share limits while other clients retain capacity",()=>{
  assert.equal(clientBucket("2001:db8:abcd:1::1"),clientBucket("2001:0db8:abcd:0001:aaaa::2"));
  assert.equal(clientBucket("::ffff:192.0.2.1"),"192.0.2.1");
  for(const path of ["/api/first-buy/prices?pairedAsset=test","/api/LAUNCH/PREPARE/","/api/chains/4663/token-images"])assert.equal(expensiveRoute(path),true);
  const limiter=new IngressLimiter();
  const active=Array.from({length:SOURCE_CONCURRENCY},()=>limiter.admit("2001:db8:abcd:1::1","/api/rpc",1));
  assert.equal(limiter.admit("2001:db8:abcd:1::2","/api/rpc",1).status,429);
  const other=limiter.admit("192.0.2.2","/api/rpc",1);assert.equal(other.status,undefined);other.release();active.forEach(x=>x.release());
  for(let i=0;i<17;i++){const result=limiter.admit("192.0.2.3","/api/launch/prepare",1);assert.equal(result.challenge,i>=16);result.release();}
  for(let i=0;i<10_100;i++){const result=limiter.admit(`10.${Math.floor(i/65536)}.${Math.floor(i/256)%256}.${i%256}`,"/api/config",1);assert.equal(result.status,undefined);result.release();}
  const result=limiter.admit("192.0.2.4","/api/config",1);assert.equal(result.status,undefined);result.release();
});
test("normal price loads, uploads, approval refresh and funded preparation do not show a challenge",()=>{
  const limiter=new IngressLimiter();
  const normal=["/api/first-buy/prices","/api/first-buy/prices","/api/token-images","/api/first-buy/quote",
    "/api/launch/prepare","/api/first-buy/quote","/api/launch/prepare","/api/launch/prepare",
    "/api/launch/simulate","/api/launch/prepare","/api/launch/simulate","/api/first-buy/prices"];
  normal.forEach((path,i)=>{const row=limiter.admit("192.0.2.20",path,1000+i);assert.equal(row.status,undefined);assert.equal(row.challenge,false);row.release();});
  const sustained=new IngressLimiter();
  for(let i=0;i<41;i++){const row=sustained.admit("192.0.2.21","/api/launch/prepare",1000+i*6000);assert.equal(row.challenge,i===40);row.release();}
  const images=new IngressLimiter();
  for(let i=0;i<7;i++){const row=images.admit("192.0.2.22","/api/token-images",1000+i*1000);assert.equal(row.challenge,i===6);row.release();}
});
test("preview scheduler shares work and never runs more than four tasks",async()=>{
  const queue=new PreviewQueue();let active=0,max=0,calls=0;
  const work=()=>queue.run("same",async()=>{calls++;await new Promise(r=>setTimeout(r,5));return 42;});
  assert.deepEqual(await Promise.all([work(),work(),work()]),[42,42,42]);assert.equal(calls,1);
  await Promise.all(Array.from({length:12},(_,i)=>queue.run(String(i),async()=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,5));active--;})));
  assert.equal(max,4);
});
test("Turnstile checks hostname and action before issuing a short permit",async context=>{
  const check=new RiskChallenge();let calls=0;
  context.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({success:true,hostname:"musegod.fun",action:"expensive_request"});});
  assert.equal(await check.verify("192.0.2.1",undefined,"fixture","musegod.fun",1),false);
  assert.equal(await check.verify("192.0.2.1","token","fixture","other.example",1),false);
  assert.equal(await check.verify("192.0.2.1","token","fixture","musegod.fun",1),true);
  assert.equal(await check.verify("192.0.2.1",undefined,"fixture","musegod.fun",2),true);
  assert.equal(calls,2);
});
test("compact plans round trip without losing recovery calldata; old payloads still read",()=>{
  const transaction={to:"0x1111111111111111111111111111111111111111",data:"0x1234",value:"0"};
  const plan={id:"0x1234",data:transaction.data,transaction,prepared:{transaction:{...transaction}}} as unknown as LaunchPlan;
  assert.deepEqual(unpackPlan(packPlan(plan)),plan);assert.deepEqual(unpackPlan(plan),plan);
});
test("release preserves live emergency overrides and permits intentional committed changes",()=>{
  assert.throws(()=>assertSecurityTransition({ENABLE_MAINNET_TRANSACTIONS:"false"},{ENABLE_MAINNET_TRANSACTIONS:"true"},{ENABLE_MAINNET_TRANSACTIONS:"true"}),/drift/);
  assert.doesNotThrow(()=>assertSecurityTransition({ENABLE_MAINNET_TRANSACTIONS:"false"},{ENABLE_MAINNET_TRANSACTIONS:"true"},{ENABLE_MAINNET_TRANSACTIONS:"false"}));
  assert.throws(()=>assertSecurityTransition({ENABLE_MAINNET_TRANSACTIONS:"TRUE"},{ENABLE_MAINNET_TRANSACTIONS:"true"},{ENABLE_MAINNET_TRANSACTIONS:"true"}),/drift/,"flags use the runtime's exact true semantics");
});
test("an incompatible rollback baseline prevents upload and activation",async()=>{
  let active="previous";const activations:string[]=[];
  await assert.rejects(publishCandidate({commit:"source",previousVersion:"previous",currentMaster:async()=>"source",activeVersion:async()=>active,assertFrozen(){},upload:async()=>"candidate",publishRelease:async()=>{},createDeployment:async()=>{},status:async()=>{},activate:async version=>{active=version;activations.push(version);},verify:async()=>{throw new Error("smoke failed");},verifyRollback:async()=>{},rollbackAllowed:async()=>false}),error=>error instanceof ReleaseFailure && error.rollback==="blocked_by_safety");
  assert.deepEqual(activations,[]);
});

test("prepare leases bound both chain runtimes and renew live work",()=>{
  const directory=mkdtempSync(join(tmpdir(),"prepare-slots-"));
  const a=new Store(join(directory,"base"),8453),b=new Store(join(directory,"robinhood"),4663);
  const ids=Array.from({length:5},(_,i)=>`00000000-0000-0000-0000-${String(i).padStart(12,"0")}`);
  try {
    ids.slice(0,4).forEach((id,i)=>assert.equal((i%2?a:b).reservePrepareSlot(id,1000),true));
    assert.equal(a.reservePrepareSlot(ids[4],1000),false);
    assert.equal(b.reservePrepareSlot(ids[0],200000),true,"renewal retains the same slot");
    assert.equal(a.reservePrepareSlot(ids[4],241001),true,"crashed, unrenewed slots expire");
    b.releasePrepareSlot(ids[0]);
    assert.equal(a.reservePrepareSlot(ids[0],242000),true);
  }finally{a.close();b.close();rmSync(directory,{recursive:true,force:true});}
});
test("logical request retries reuse the completed preview while new requests can refresh",async()=>{
  const queue=new PreviewQueue();let calls=0;
  const work=async()=>({salt:++calls});
  assert.deepEqual(await queue.run("draft",work,"request1:draft"),{salt:1});
  assert.deepEqual(await queue.run("draft",work,"request1:draft"),{salt:1});
  assert.deepEqual(await queue.run("draft",work,"request2:draft"),{salt:2});
});
test("rollback never reenables a flag disabled by the failed candidate",()=>{
  const on={RUNTIME_SECURITY_PROTOCOL:"1",ENABLE_MAINNET_TRANSACTIONS:"true"};
  const off={...on,ENABLE_MAINNET_TRANSACTIONS:"false"};
  assert.equal(rollbackPreservesSafety(on,off),false);
  assert.equal(rollbackPreservesSafety(off,on),true);
  assert.equal(rollbackPreservesSafety(on,on),true);
  assert.equal(rollbackPreservesSafety({...on,RUNTIME_SECURITY_PROTOCOL:"0"},on),false);
});

test("token cursor pages have stable ties and recovery queues skip finalized and deferred rows",()=>{
  const directory=mkdtempSync(join(tmpdir(),"runtime-cursors-"));const store=new Store(directory,31337);
  try {
    for(let i=1;i<=55;i++)store.saveToken(syntheticToken({address:`0x${i.toString(16).padStart(40,"0")}` as Address,transactionHash:`0x${i.toString(16).padStart(64,"0")}` as Hex,createdAt:i<=52 ? 10 : 20}));
    const first=store.tokenPage(50),last=first.at(-1)!;
    const rest=store.tokenPage(50,{createdAt:last.createdAt,address:last.address});
    assert.equal(first.length,50);assert.equal(rest.length,5);assert.equal(new Set([...first,...rest].map(token=>token.address)).size,55);
    const hashes=[1,2,3].map(i=>`0x${String(i).padStart(64,"0")}` as Hex);
    for(const hash of hashes){store.savePlan({id:hash,creator:"creator",data:"0x1234",preparedAt:1} as unknown as LaunchPlan);store.trackLaunch(hash,hash);}
    store.deferLaunch(hashes[0],1000);store.launchStatus(hashes[1],"confirmed","block");store.finalizeLaunch(hashes[1]);
    assert.deepEqual(store.pendingLaunches(999).map(row=>row.hash),[hashes[2]]);
    assert.equal(store.pendingLaunchCount(),2,"deferred pending entries count toward queue admission");
    assert.equal(store.pendingLaunches(1001).find(row=>row.hash===hashes[0])?.attempts,1);
    store.protectPlan(hashes[0]);store.cleanup(100*86400000);assert(store.getPlan(hashes[0]));
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
