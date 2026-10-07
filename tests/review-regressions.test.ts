import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { IngressLimiter, INGRESS_CLASSES } from "../server/abuse";
const SOURCE_CONCURRENCY = INGRESS_CLASSES.read.perSource;
import { LaunchpadService } from "../server/service";
import { Store } from "../server/store";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { createDirectWrapQuote, firstBuyPaymentRefreshInput } from "../src/lib/first-buy-payment";
import { syntheticToken } from "./fixtures";
import type { Address, Hex } from "viem";
import type { LaunchPlan } from "../src/lib/launch-plan";
import { publishCandidate, ReleaseFailure } from "../scripts/release-policy";

const account = "0x1111111111111111111111111111111111111111" as Address;
const hash = `0x${"a".repeat(64)}` as Hex;
const weth = ROBINHOOD_STOCKS.find(a => a.symbol === "WETH")!.address;

async function httpFixture(run: (entry: ReturnType<typeof createApp>, origin: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "review-http-"));
  const runtime = runtimeFromEnv(4663, {NODE_ENV:"test", CHAIN_MODE:"fork", FORK_CHAIN_ID:"4663", DATA_DIR:directory,
    PLATFORM_TREASURY:"0x2222222222222222222222222222222222222222"});
  const entry = createApp(undefined, "loopback", runtime);
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  try { await run(entry, `http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); entry.service.store.close(); rmSync(directory,{recursive:true,force:true}); }
}
async function post(origin: string, path: string, body: unknown) {
  return fetch(origin + path, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)});
}

test("HTTP registration preserves frozen recovery backup and rejects malformed envelopes", async () => {
  await httpFixture(async ({service}, origin) => {
    const backup = {id:hash, creator:account, tokenAddress:account, poolId:hash, data:"0x1234",
      transaction:{to:account,data:"0x1234",value:"0"}, draft:{quoteAddress:weth},
      intentId:"persisted-intent", prepared:{createParams:{recoveryMaterial:"preserve"}}} as unknown as LaunchPlan;
    const received: (LaunchPlan | undefined)[] = [];
    service.register = async (sentHash, plan) => { assert.equal(sentHash,hash); received.push(plan); return syntheticToken(); };
    assert.equal((await post(origin,"/api/launch/register",{hash,recoveryPlan:backup})).status,200);
    assert.deepEqual(received[0],backup);
    assert.equal((await post(origin,"/api/launch/register",{hash})).status,200);
    assert.equal(received[1],undefined);
    for (const body of [{hash,recoveryPlan:[]},{hash,recoveryPlan:{...backup,creator:"invalid"}},
      {hash,recoveryPlan:{...backup,transaction:{...backup.transaction,value:"1"}}},{hash,plan:backup}])
      assert.equal((await post(origin,"/api/launch/register",body)).status,400);
    assert.equal(received.length,2,"invalid backup cannot reach verification or persistence");
  });
});

test("HTTP validation distinguishes previews from actual wallet signing", async () => {
  await httpFixture(async ({service}, origin) => {
    const modes: boolean[] = [];
    service.validateLaunch = async (_creator, _data, signing) => {modes.push(signing === true); return {valid:true} as never;};
    for(const signing of [undefined,false,true]) {
      assert.equal((await post(origin,"/api/launch/validate",{creator:account,data:"0x1234",...(signing===undefined?{}:{signing})})).status,200);
    }
    assert.deepEqual(modes,[false,false,true]);
  });
});

test("legacy near-expiry direct wrap refresh passes the real quote HTTP schema with exact output", async () => {
  await httpFixture(async ({service}, origin) => {
    service.preflightFirstBuyPayment = async () => {};
    Object.assign(service.client,{getChainId:async()=>31337,getBlockNumber:async()=>1n,
      getBlock:async()=>({number:1n,hash}),getCode:async()=>"0x6000"});
    // PaymentReader shares this client and takes its native-wrap branch without LI.FI.
    const old = {...createDirectWrapQuote(4663,account,100n,"0x6000",{number:1n,hash},Date.now()-50_000),slippageBps:1};
    const input = firstBuyPaymentRefreshInput(old);
    const response = await post(origin,"/api/first-buy/quote",input);
    assert.equal(response.status,200,await response.clone().text());
    const quote = await response.json();
    assert.equal(quote.protocol,"wrap"); assert.equal(quote.minimumOut,"100"); assert.equal(quote.expectedOut,"100");
  });
});

test("normal shared-NAT page reads can run in parallel without challenge or 429", async () => {
  await httpFixture(async ({service}, origin) => {
    let entered = 0, release!: () => void;
    const gate = new Promise<void>(resolve => {release=resolve;});
    service.tokens = async () => {entered++; await gate; return [];};
    const work = Array.from({length:12},()=>fetch(origin+"/api/tokens"));
    try {
      for(let attempt=0;attempt<100 && entered<12;attempt++) await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(entered,12,"three ordinary page loads share an ingress source without serializing every API");
    } finally {release();}
    for(const response of await Promise.all(work)) assert.equal(response.status,200);
  });
});

test("concurrent requests release across window rotation, IPv6 normalization and unknown buckets", () => {
  for(const [first,second] of [["192.0.2.7","192.0.2.7"],["2001:db8:1:2::1","2001:db8:1:2::2"],["invalid","also-invalid"]]) {
    const limiter=new IngressLimiter();
    const requests=Array.from({length:SOURCE_CONCURRENCY},()=>limiter.admit(first,"/api/config",1000));
    assert(requests.every(r=>!r.status));
    assert.equal(limiter.admit(second,"/api/config",61_000).status,429);
    requests.forEach(r=>{r.release();r.release();});
    const resumed=limiter.admit(second,"/api/config",61_001);assert.equal(resumed.status,undefined);resumed.release();
    const next=limiter.admit(second,"/api/config",121_001);assert.equal(next.status,undefined);next.release();
  }
});

test("LRU eviction cannot lose active source ownership or strand its later release", () => {
  const limiter=new IngressLimiter();
  const open=Array.from({length:SOURCE_CONCURRENCY},()=>limiter.admit("192.0.2.7","/api/config",1));
  for(let i=0;i<10_100;i++) {
    const next=limiter.admit(`10.${Math.floor(i/65536)}.${Math.floor(i/256)%256}.${i%256}`,"/api/config",2);
    assert.equal(next.status,undefined);next.release();
  }
  assert.equal(limiter.admit("192.0.2.7","/api/config",3).status,429,"evicting the rate row does not evade active concurrency");
  open.forEach(row=>row.release());
  const resumed=limiter.admit("192.0.2.7","/api/config",4);assert.equal(resumed.status,undefined);resumed.release();
});

test("legacy token HTTP array remains complete while paginated callers receive cursors", async () => {
  await httpFixture(async ({service}, origin) => {
    for(let i=0;i<55;i++) await service.store.saveToken(syntheticToken({address:`0x${(i+100).toString(16).padStart(40,"0")}`,
      mode:"fork",deploymentChainId:4663,quoteAddress:weth,createdAt:1000+i,transactionHash:`0x${(i+100).toString(16).padStart(64,"0")}`}));
    const old = await (await fetch(origin+"/api/tokens")).json();assert.equal(old.length,55);
    const page = await (await fetch(origin+"/api/tokens?limit=50")).json();assert.equal(page.items.length,50);assert(page.nextCursor);
    const tail = await (await fetch(origin+"/api/tokens?limit=50&before="+page.nextCursor)).json();assert.equal(tail.items.length,5);assert.equal(tail.nextCursor,null);
  });
});

test("warning stock results are cached with a short expiry and preserve actual observation time", async context => {
  let now=100_000, reads=0; context.mock.method(Date,"now",()=>now);
  const asset=ROBINHOOD_STOCKS.find(a=>a.issuer==="Robinhood")!;
  const service=Object.assign(Object.create(LaunchpadService.prototype), {assertNetwork:async()=>{},client:{getBlockNumber:async()=>10n,
    readContract:async ({functionName}:{functionName:string})=>{reads++;return ({symbol:asset.symbol,decimals:asset.decimals,name:asset.name,totalSupply:100n,
      uiMultiplier:10n**18n,newUIMultiplier:0n,effectiveAt:0n,paused:false,oraclePaused:true} as Record<string,unknown>)[functionName];}}}) as LaunchpadService;
  Object.defineProperty(service,"assets",{value:[asset]});
  const first=await service.stocks();assert(first[0].availabilityWarning);assert.equal(reads,9);
  now+=10_000;assert.deepEqual(await service.stocks(),first);assert.equal(reads,9);
  now+=21_000;await service.stocks();assert.equal(reads,18,"degraded status eventually refreshes instead of staying stale");
});

test("cached guard checks never cache signing pause or inherit an unverified runtime address", async context => {
  let now=100_000, codeReads=0, controls=0, paused=false;context.mock.method(Date,"now",()=>now);
  const runtime={config:{mode:"robinhood",chainId:4663,writesEnabled:true,blockReason:null,treasury:account,launchGuard:null}};
  const service=Object.assign(Object.create(LaunchpadService.prototype),{runtime,guardCandidate:account,assertNetwork:async()=>{},
    store:{runtimeControl:async()=>{controls++;return {paused,revision:controls,reason:"current pause"};}},
    client:{getBlockNumber:async()=>1n,getCode:async()=>{codeReads++;return "0x1234";},readContract:async()=>account}}) as LaunchpadService;
  const first=await service.config();assert.equal(first.launchGuard,null);assert.equal(first.writesEnabled,true);assert.equal(codeReads,2);
  paused=true;const stopped=await service.config();assert.equal(stopped.writesEnabled,false);assert.equal(stopped.controlRevision,2);assert.equal(codeReads,2);
  now+=3_001;await service.config();assert.equal(codeReads,4,"negative identity cache has a bounded retry period");assert.equal(controls,3);
});

test("unsigned validated plans expire but actual signing and unknown transaction backups remain protected", async () => {
  const directory=mkdtempSync(join(tmpdir(),"review-plan-lifetime-"));const store=new Store(directory,31337);
  try {
    for(const id of ["preview","signing","unknown"])store.savePlan({id,creator:account,data:"0x1234",preparedAt:1,
      transaction:{to:account,data:"0x1234",value:"0"}} as unknown as LaunchPlan);
    store.protectPlan("signing");store.trackLaunch(hash,"unknown");
    store.cleanup(Date.now());assert.equal(store.getPlan("preview"),null);assert(store.getPlan("signing"));assert(store.getPlan("unknown"));
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test("automatic release rejects unsafe rollback before upload and rechecks before activation", async () => {
  let uploads=0, activations=0, safe=false;
  const flow={commit:"source",previousVersion:"baseline",currentMaster:async()=>"source",activeVersion:async()=>"baseline",assertFrozen(){},
    upload:async()=>{uploads++;return "candidate";},publishRelease:async()=>{safe=false;},createDeployment:async()=>{},status:async()=>{},
    activate:async()=>{activations++;},verify:async()=>{},verifyRollback:async()=>{},rollbackAllowed:async()=>safe};
  await assert.rejects(publishCandidate(flow),e=>e instanceof ReleaseFailure && e.rollback==="blocked_by_safety");
  assert.equal(uploads,0);assert.equal(activations,0);
  safe=true;await assert.rejects(publishCandidate(flow),e=>e instanceof ReleaseFailure && e.rollback==="not_needed");
  assert.equal(uploads,1);assert.equal(activations,0,"changed rollback safety cancels promotion with old production still active");
});
