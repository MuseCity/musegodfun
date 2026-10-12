import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAddress, type Address, type Hex } from "viem";
import { LaunchpadService } from "../server/service";
import { MusegodReader } from "../server/musegod";
import { BuybackEngineReader, verifyFeeEngineRuntime, type BuybackDeployment } from "../server/buyback-engine";
import { contractIdentityOnce } from "../server/contract-identity";
import { Store } from "../server/store";
import { MUSEGOD, MUSEGOD_ROUTER_VERIFICATION } from "../src/lib/musegod";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import { ROBINHOOD_STOCKS, sameAddress, type RuntimeConfig } from "../src/lib/config";
import deployment from "../contracts/artifacts/buyback-v2-deployment.json";
import buybackConfig from "../contracts/buyback.config.json";

const account="0x1111111111111111111111111111111111111111" as Address;
const hash=`0x${"a".repeat(64)}` as Hex;
const changedHash=`0x${"b".repeat(64)}` as Hex;

test("W-F1 display RPC fields remain cached, but every request sees one live signing control read", async t=>{
  let paused=false,revision=1,controls=0,codes=0,controlError=false;
  const service=Object.assign(Object.create(LaunchpadService.prototype),{
    runtime:{config:{mode:"robinhood",chainId:4663,writesEnabled:true,blockReason:null,treasury:account}},
    guardCandidate:account,assertNetwork:async()=>{},
    store:{getBuybackBatch:async()=>null,compareAndSetBuybackAudit:async()=>true,runtimeControl:async()=>{controls++;if(controlError)throw new Error("Storage unavailable");return {paused,revision,reason:paused?"Owner pause":null};}},
    client:{getBlockNumber:async()=>100n,getCode:async()=>{codes++;return "0x1234";},readContract:async()=>{throw new Error("Foreign runtime must not reach getters");}},
  }) as LaunchpadService;
  const initial=await service.config();assert.equal(initial.writesEnabled,true);assert.equal(controls,1);assert.equal(codes,1);
  paused=true;revision=2;
  const stopped=await service.config();assert.equal(stopped.signingPaused,true);assert.equal(stopped.writesEnabled,false);assert.equal(stopped.controlRevision,2);assert.equal(controls,2);assert.equal(codes,1);
  controlError=true;const unavailable=await service.config();assert.equal(unavailable.signingPaused,true);assert.equal(unavailable.writesEnabled,false);assert.equal(controls,3);assert.equal(codes,1);
  controlError=false;paused=false;revision=3;
  const resumed=await Promise.all([service.config(),service.config()]);
  assert(resumed.every(value=>value.writesEnabled&&value.controlRevision===3));assert.equal(controls,5,"One storage read per caller, including concurrent display requests");assert.equal(codes,1,"A live control read never repeats RPC identity work");
  await service.config(true);assert.equal(controls,6,"The financial path reads control once as well");
});

async function marketFixture(t: TestContext) {
  const directory=mkdtempSync(join(tmpdir(),"round11-market-")),store=new Store(directory,31337);
  let now=1_000,latest=0,canonical=0,mutable=0,network=0,supply=123n,conflict=false;
  const config:RuntimeConfig={mode:"robinhood",chainId:4663,deploymentChainId:4663,writesEnabled:true,blockReason:null,treasury:account};
  const client={getBlock:async(parameters?:{blockNumber?:bigint})=>{if(parameters?.blockNumber!==undefined)canonical++;else latest++;return {number:100n,hash:parameters?.blockNumber!==undefined&&conflict?changedHash:hash};},
    getCode:async()=>{throw new Error("A sealed immutable proof must not repeat its code read");},
    readContract:async({functionName}:{functionName:string})=>{mutable++;if(functionName==="totalSupply")return supply;if(functionName==="liquidity")return 1n;if(functionName==="slot0")return [1n,0,0,0,0,0,true];throw new Error(`Unexpected mutable getter ${functionName}`);},
    simulateContract:async()=>({result:[1_000n,1n,0,1n]}),
  } as unknown as LaunchpadService["client"];
  // Simulated already-verified private startup seals. These are fixture state,
  // not actual deployment evidence; mutable reads and canonical quotes remain real code paths.
  await contractIdentityOnce(client,{namespace:"musegod_market",store,binding:{chainId:4663,mode:"robinhood",market:MUSEGOD},validate:()=>true,
    verify:async()=>({token:MUSEGOD.token,pool:MUSEGOD.pool,quoter:MUSEGOD.quoter,quoterRuntimeHash:hash})});
  await contractIdentityOnce(client,{namespace:"musegod_router",store,binding:{chainId:4663,mode:"robinhood",router:MUSEGOD.router,factory:MUSEGOD.factory,weth:MUSEGOD.weth,runtimeHash:MUSEGOD_ROUTER_VERIFICATION.runtimeHash},validate:()=>true,
    verify:async()=>({router:MUSEGOD.router,runtimeHash:MUSEGOD_ROUTER_VERIFICATION.runtimeHash})});
  const reader=new MusegodReader(client,config,async()=>{network++;},()=>now,store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true});});
  return {reader,counts:()=>({latest,canonical,mutable,network}),advance:(delta:number)=>{now+=delta;},supply:(value:bigint)=>{supply=value;},conflict:()=>{conflict=true;}};
}

test("W-F2 concurrent MUSEGOD information shares a sixty-second mutable snapshot and never checks quote canonicality",async t=>{
  const f=await marketFixture(t);
  const [a,b]=await Promise.all([f.reader.info(),f.reader.info()]);
  assert.equal(a.totalSupply,"123");assert.equal(a.tradeEnabled,true);assert.deepEqual(a,b);
  assert.deepEqual(f.counts(),{latest:1,canonical:0,mutable:3,network:1});
  a.totalSupply="tampered";assert.equal((await f.reader.info()).totalSupply,"123");
  f.supply(456n);f.advance(59_999);assert.equal((await f.reader.info()).totalSupply,"123");assert.equal(f.counts().latest,1);
  f.advance(2);assert.equal((await f.reader.info()).totalSupply,"456");assert.equal(f.counts().latest,2);
  f.conflict();await assert.rejects(f.reader.quote("buy","1",100),/block changed/);
  assert.equal(f.counts().canonical,1,"A financial quote independently checks its pinned block even while info is cached");
});

test("W-F3 engine reader failures are shared, back off from sixty seconds, and a useful response resets the exponent",async t=>{
  let now=1_000,calls=0,failure=true;t.mock.method(Date,"now",()=>now);
  const config:RuntimeConfig={mode:"base",chainId:8453,writesEnabled:false,blockReason:null,treasury:account,feePolicy:FEE_POLICY};
  const reader=new BuybackEngineReader({} as any,async()=>{calls++;if(failure)throw new Error("RPC unavailable at https://private.invalid/key");return config;},async()=>[],async()=>[]);
  const [a,b]=await Promise.all([reader.read(),reader.read()]);assert.equal(a.available,false);assert.deepEqual(a,b);assert.equal(calls,1);assert(!a.reason?.includes("private.invalid"));
  now+=59_999;await reader.read();assert.equal(calls,1);
  now+=2;await reader.read();assert.equal(calls,2);
  now+=119_999;await reader.read();assert.equal(calls,2);
  now+=2;failure=false;await reader.read();assert.equal(calls,3,"A resolved unavailable configuration is still a useful bounded status");
  now+=120_001;failure=true;await reader.read();assert.equal(calls,4);
  now+=60_001;await reader.read();assert.equal(calls,5,"Recovery resets the next RPC failure to one minute");
});

test("W-F3 display graph failure backoff never suppresses a financial fresh verification",async t=>{
  let now=1_000,calls=0;t.mock.method(Date,"now",()=>now);
  const client={getChainId:async()=>{calls++;throw new Error("RPC 429");},getBlockNumber:async()=>100n} as unknown as Parameters<typeof verifyFeeEngineRuntime>[0];
  const engine=deployment.contracts.engine.address as Address;
  const display=()=>verifyFeeEngineRuntime(client,engine,undefined,{fresh:false});
  await assert.rejects(display(),/RPC 429/);await assert.rejects(display(),/RPC 429/);assert.equal(calls,1);
  await assert.rejects(verifyFeeEngineRuntime(client,engine),/RPC 429/);assert.equal(calls,2,"Financial verification bypasses display backoff");
  now+=60_001;await assert.rejects(display(),/RPC 429/);assert.equal(calls,3);
  now+=119_999;await assert.rejects(display(),/RPC 429/);assert.equal(calls,3);
  now+=2;await assert.rejects(display(),/RPC 429/);assert.equal(calls,4);
});

async function recoveringEngineFixture(t: TestContext) {
  const directory=mkdtempSync(join(tmpdir(),"round11-engine-recovery-")),store=new Store(directory,4663);
  const manifest=deployment as BuybackDeployment,c=manifest.constants,engine=getAddress(manifest.contracts.engine.address!);
  const addresses=Object.fromEntries(Object.entries(manifest.contracts).map(([name,entry])=>[name,getAddress(entry.address!)]));
  const identity={...addresses,operationsTreasury:getAddress(c.treasury),automationReceiver:getAddress(c.automation!),automationTreasury:getAddress(c.automationTreasury!)};
  const finalized=deployment.activationVerification.finalized,head=BigInt(finalized.number)+100n;
  let fault=true,graphReads=0,controls=0,nextFailure:Promise<never>|undefined;
  const client={
    getChainId:async()=>4663,
    getBlockNumber:async()=>{graphReads++;if(nextFailure){const pending=nextFailure;nextFailure=undefined;return pending;}if(fault)throw Error("RPC 429");return head;},
    getCode:async({address}:{address:Address})=>{
      if(sameAddress(address,c.treasury))return "0x";
      if(sameAddress(address,c.automationTreasury!))return "0x1234";
      throw Error("A sealed immutable graph must not repeat runtime reads");
    },
    getBlock:async({blockNumber}:{blockNumber:bigint})=>{assert.equal(blockNumber,BigInt(finalized.number));return {number:blockNumber,hash:finalized.hash,timestamp:1n};},
    readContract:async({functionName,args=[]}:{functionName:string;args?:Address[]})=>{
      if(functionName==="owner")return "0x0000000000000000000000000000000000000000";
      if(functionName==="paused")return false;
      if(functionName==="beneficiary")return c.beneficiary;
      if(functionName==="tokenToBeneficiary")return c.muse;
      if(functionName==="oracle")return addresses.oracle;
      if(functionName==="defaultScaledOfferFactor")return 985000;
      if(functionName==="getPairScaledOfferFactors")return [0];
      if(["balanceOf","allowance","totalForwarded"].includes(functionName))return 0n;
      if(functionName==="assetFeeds"){
        const weth=sameAddress(args[0],c.weth),feed=buybackConfig.feeds.find(value=>sameAddress(value.token,args[0]));
        assert(weth||feed);return [weth?c.ethUsdFeed:feed!.feed,weth?buybackConfig.ethMaxAge:feed!.maxAge,
          weth?18:ROBINHOOD_STOCKS.find(value=>sameAddress(value.address,args[0]))!.decimals,8,weth?false:feed!.checkOraclePaused];
      }
      throw Error(`Unexpected mutable getter ${functionName}`);
    },
  } as unknown as Parameters<typeof verifyFeeEngineRuntime>[0];
  // Synthetic previously verified private identity; actual mutable graph,
  // public governor signatures and finalized record validation run below.
  await contractIdentityOnce(client,{namespace:"robinhood_fee_engine",store,
    binding:{chainId:4663,candidate:engine.toLowerCase(),contracts:manifest.contracts,constants:c,automation:manifest.automation,assetFeedDescriptions:manifest.assetFeedDescriptions,policy:buybackConfig},
    validate:()=>true,verify:async()=>identity});
  const service=Object.assign(Object.create(LaunchpadService.prototype),{client,store,feeEngineCandidate:engine,
    runtime:{config:{mode:"robinhood",chainId:4663,deploymentChainId:4663,writesEnabled:true,blockReason:null,treasury:c.treasury,feeEngine:engine,feePolicy:ENGINE_FEE_POLICY}}}) as LaunchpadService;
  t.mock.method(store,"runtimeControl",async()=>{controls++;return {paused:false,revision:1,reason:null,updatedAt:1};});
  t.after(()=>{store.close();rmSync(directory,{recursive:true});});
  return {client,store,service,engine,setFault:(value:boolean)=>{fault=value;},graphReads:()=>graphReads,controls:()=>controls,
    deferFailure:()=>{let reject!:(reason:Error)=>void;nextFailure=new Promise<never>((_,fail)=>{reject=fail;});return ()=>reject(Error("Older display RPC 429"));}};
}

test("N1 a recovered financial config immediately replaces both failed display caches",async t=>{
  let now=1_000;t.mock.method(Date,"now",()=>now);const f=await recoveringEngineFixture(t);
  assert.equal((await f.service.config()).feeEngine,null);assert.equal(f.graphReads(),1);
  now+=1;f.setFault(false);
  assert.equal((await f.service.config(true)).feeEngine,f.engine,"The financial path independently verifies the recovered graph and activation");
  const reads=f.graphReads();assert.equal((await f.service.config()).feeEngine,f.engine,"The next display read must not retain feeEngine=null for sixty seconds");
  const graph=await verifyFeeEngineRuntime(f.client,f.engine,undefined,{identityStore:f.store,fresh:false});assert.equal(graph.engine,f.engine);
  assert.equal(f.graphReads(),reads,"Financial success publishes its same-binding graph to display without another RPC");assert.equal(f.controls(),3);
});

test("N1 display graph failures retry within five minutes and financial success resets their exponent",async t=>{
  let now=1_000;t.mock.method(Date,"now",()=>now);const f=await recoveringEngineFixture(t);
  const display=()=>verifyFeeEngineRuntime(f.client,f.engine,undefined,{identityStore:f.store,fresh:false});
  for(const delay of [60_000,120_000,240_000,300_000,300_000]){
    const before=f.graphReads();await assert.rejects(display(),/RPC 429/);assert.equal(f.graphReads(),before+1);
    now+=delay-1;await assert.rejects(display(),/RPC 429/);assert.equal(f.graphReads(),before+1);now+=2;
  }
  f.setFault(false);await verifyFeeEngineRuntime(f.client,f.engine,undefined,{identityStore:f.store});
  const recovered=f.graphReads();await display();assert.equal(f.graphReads(),recovered,"Fresh success clears display backoff");
  now+=120_001;f.setFault(true);await assert.rejects(display(),/RPC 429/);const failed=f.graphReads();
  now+=59_999;await assert.rejects(display(),/RPC 429/);assert.equal(f.graphReads(),failed);
  now+=2;await assert.rejects(display(),/RPC 429/);assert.equal(f.graphReads(),failed+1,"The next failure restarts at sixty seconds");
});

test("N1 a delayed earlier display failure cannot overwrite a newer financial success",async t=>{
  const f=await recoveringEngineFixture(t),reject=f.deferFailure(),oldDisplay=f.service.config();
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.graphReads(),1);
  f.setFault(false);assert.equal((await f.service.config(true)).feeEngine,f.engine);reject();
  assert.equal((await oldDisplay).feeEngine,null,"The earlier failed caller remains fail closed");
  const reads=f.graphReads();assert.equal((await f.service.config()).feeEngine,f.engine);
  await verifyFeeEngineRuntime(f.client,f.engine,undefined,{identityStore:f.store,fresh:false});assert.equal(f.graphReads(),reads);
});
