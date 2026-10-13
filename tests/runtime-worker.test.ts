import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare,convertV4MiniflareOptions } from "miniflare";
import { firstBuyPaymentAssets } from "../src/lib/first-buy-payment";
import { decodeFunctionData, encodeFunctionResult, erc20Abi, multicall3Abi, type Hex } from "viem";
import { baseCollectorAbi } from "../src/lib/base-buyback";
import baseDeployment from "../contracts/artifacts/base-collector-deployment.json";
import { ADMITTED_BASE_ASSET_COUNT } from "../src/lib/config";

test("real Worker routes refresh native secrets and flags while persistent pause survives code updates",{timeout:60_000},async()=>{
  const bundled=await build({entryPoints:["worker/index.ts"],bundle:true,write:false,format:"esm",platform:"node",target:"es2022",external:["node:*","cloudflare:*"],banner:{js:'import {createRequire} from "node:module";const require=createRequire("/fixture.js");'}});
  let paused=false;const keys:string[]=[];
  const legacyBatchId = `0x${"ab".repeat(32)}`;
  const bindings={CHAIN_MODE:"robinhood",NODE_ENV:"production",PLATFORM_TREASURY:"0x1111111111111111111111111111111111111111",ENABLE_MAINNET_TRANSACTIONS:"true",SUPABASE_URL:"https://fixture.supabase.co",SUPABASE_SECRET_KEY:"fixture-db",LIFI_API_KEY:"fixture-old",ALCHEMY_API_KEY:"worker-runtime-fake-key",TURNSTILE_SITE_KEY:"fixture-public",TURNSTILE_SECRET_KEY:"fixture-private"};
  const options=(env:Record<string,string>,suffix="")=>convertV4MiniflareOptions({modules:true,compatibilityDate:"2026-10-04",compatibilityFlags:["nodejs_compat"],script:bundled.outputFiles[0].text+suffix,durableObjects:{LAUNCHPAD:{className:"LaunchpadRuntime",useSQLite:true}},bindings:env,serviceBindings:{ASSETS:async()=>new Response("asset fixture")},outboundService:async request=>{
    const url=new URL(request.url);
    if(url.hostname==="fixture.supabase.co") {
      assert.equal(request.headers.get("apikey"),"fixture-db");
      if(url.pathname.endsWith("musegod_runtime_controls"))return Response.json([{paused,revision:4,updated_at:1,reason:"fixture"}]);
      if(url.pathname.endsWith("musegod_reserve_runtime_budget"))return Response.json({allowed:true,retryAfter:0});
      if(url.pathname.endsWith("musegod_buyback_batches") && url.searchParams.get("id") === `eq.${legacyBatchId}`)
        return Response.json([{payload:{id:legacyBatchId,quote:{stockAddress:"0x1111111111111111111111111111111111111111",treasury:bindings.PLATFORM_TREASURY},hashes:{},steps:{}}}]);
      return Response.json([]);
    }
    if(url.hostname==="li.quest") {
      keys.push(request.headers.get("x-lifi-api-key")??"");
      const asset=firstBuyPaymentAssets(Number(url.searchParams.get("chain")) as 4663|8453).find(a=>a.address.toLowerCase()===url.searchParams.get("token")?.toLowerCase());
      assert(asset);return Response.json({...asset,priceUSD:"1"});
    }
    if(url.hostname.endsWith(".g.alchemy.com")) {
      const body=await request.json() as {method:string;id:number};
      assert.equal(body.method,"eth_chainId");
      return Response.json({jsonrpc:"2.0",id:body.id,result:url.hostname.startsWith("base")?"0x2105":"0x1237"});
    }
    throw new Error(`Real upstream forbidden in Worker test: ${url.hostname}`);
  }});
  const mf=new Miniflare(options(bindings));
  const get=async(path:string)=>{const response=await mf.dispatchFetch(`https://musegod.fun${path}`,{headers:{"cf-connecting-ip":"192.0.2.10","x-forwarded-for":"spoofed"}});assert.equal(response.status,200);return response.json() as Promise<any>;};
  try {
    assert.equal((await get("/api/config")).writesEnabled,true);
    assert.equal((await get("/api/chains/8453/config")).writesEnabled,false);
    // Continuous custody/FIFO display paths no longer exist in production.
    for(const chain of [8453,4663])for(const path of ["vault-ledger","custody"]){
      const response=await mf.dispatchFetch(`https://musegod.fun/api/chains/${chain}/buyback/${path}`,{headers:{"cf-connecting-ip":"192.0.2.12","cache-control":"no-cache"}});
      assert.equal(response.status,404);
    }
    const baseCounters=await get("/api/chains/8453/buyback/engine");assert.equal(baseCounters.available,false);assert.equal("vaultLedger" in baseCounters,false);
    const burnRecovery = async () => {
      const response = await mf.dispatchFetch(`https://musegod.fun/api/chains/8453/buyback/batches/${legacyBatchId}/step?kind=burn`, {headers:{"cf-connecting-ip":"192.0.2.90"}});
      return (await response.json() as {code:string}).code;
    };
    assert.equal(await burnRecovery(), "AUTHORIZATION_REQUIRED", "Base is paused but a historical destination step consults enabled RH through real DO RPC; the missing original batch authorization still blocks signing");
    await get("/api/first-buy/prices");assert(keys.every(key=>key==="fixture-old"));
    await mf.setOptions(options({...bindings,ENABLE_MAINNET_TRANSACTIONS:"false",LIFI_API_KEY:"fixture-new"}));
    assert.equal((await get("/api/config")).writesEnabled,false);
    assert.equal(await burnRecovery(), "SIGNING_DISABLED", "Current RH binding updates block destination recovery independently of Base");
    keys.length=0;await get("/api/first-buy/prices");assert(keys.length>0 && keys.every(key=>String(key)==="fixture-new"));
    paused=true;
    await mf.setOptions(options(bindings,"\n// New version, same persisted safety control\n"));
    const controlled=await get("/api/config");assert.equal(controlled.writesEnabled,false);assert.equal(controlled.signingPaused,true);assert.equal(controlled.controlRevision,4);
    const tooLarge=await mf.dispatchFetch("https://musegod.fun/api/launch/prepare",{method:"POST",headers:{"cf-connecting-ip":"192.0.2.11","content-type":"application/json"},body:"x".repeat(65537)});
    assert.equal(tooLarge.status,413);
    const recoveryBody = JSON.stringify({hash:`0x${"a".repeat(64)}`,recoveryPlan:{padding:"x".repeat(70_000)}});
    const recovery = await mf.dispatchFetch("https://musegod.fun/api/launch/register",{method:"POST",headers:{"cf-connecting-ip":"192.0.2.12","content-type":"application/json"},body:recoveryBody});
    assert.equal(recovery.status,400,"valid JSON over64KiB reaches recovery schema, which rejects malformed backup");
    const recoveryTooLarge = await mf.dispatchFetch("https://musegod.fun/api/chains/4663/launch/register",{method:"POST",headers:{"cf-connecting-ip":"192.0.2.13","content-type":"application/json"},body:"x".repeat(262_145)});
    assert.equal(recoveryTooLarge.status,413,"chain-specific recovery also enforces the256KiB stream bound");
    const withoutKey={...bindings};delete (withoutKey as Partial<typeof bindings>).LIFI_API_KEY;
    await mf.setOptions(options(withoutKey));
    keys.length=0;await get("/api/first-buy/prices");assert(keys.length>0 && keys.every(key=>String(key)===""),"removed native secret does not fall back to the previous process snapshot");
    const ordinary=["/api/first-buy/prices","/api/first-buy/prices","/api/token-images","/api/first-buy/quote",
      "/api/launch/prepare","/api/first-buy/quote","/api/launch/prepare","/api/launch/prepare",
      "/api/launch/simulate","/api/launch/prepare","/api/launch/simulate","/api/first-buy/prices"];
    for(const path of ordinary) {
      const prices=path.endsWith("/prices");
      const response=await mf.dispatchFetch(`https://musegod.fun${path}`,{method:prices?"GET":"POST",
        headers:{"cf-connecting-ip":"192.0.2.42",...(prices?{}:{"content-type":"application/json"})},...(prices?{}:{body:"{}"})});
      assert.notEqual(response.status,403,"ordinary workflow admission does not request a visible challenge");
      assert.notEqual(response.status,429,"ordinary workflow admission preserves capacity");
    }
    for(let i=0;i<17;i++) {
      const response=await mf.dispatchFetch("https://musegod.fun/api/launch/prepare",{method:"POST",
        headers:{"cf-connecting-ip":"192.0.2.43","content-type":"application/json"},body:JSON.stringify({intentId:`distinct-${i}`})});
      if(i<16)assert.notEqual(response.status,403);
      else {assert.equal(response.status,403);assert.equal((await response.json() as {code:string}).code,"CHALLENGE_REQUIRED");}
    }
    for(let i=0;i<181;i++) {
      const response=await mf.dispatchFetch("https://musegod.fun/api/not-found",{headers:{"cf-connecting-ip":"2001:db8:1234:abcd::1","x-forwarded-for":`192.0.2.${i%250}`,"x-runtime-risk":"normal"}});
      assert.equal(response.status,i<180?404:429,"caller-controlled proxy headers cannot bypass the ingress limiter");
    }
    const other=await mf.dispatchFetch("https://musegod.fun/api/not-found",{headers:{"cf-connecting-ip":"192.0.2.99"}});assert.equal(other.status,404);
    // A body that never finishes ends as a timeout, not an adapter error, and frees its slot.
    const trickle=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode("{"));}});
    const started=Date.now();
    const slow=await mf.dispatchFetch("https://musegod.fun/api/rpc",{method:"POST",headers:{"cf-connecting-ip":"192.0.2.77","content-type":"application/json"},body:trickle,duplex:"half"} as never);
    assert.equal(slow.status,408);assert(Date.now()-started<15_000,"the standard body deadline is ten seconds");
    const after=await mf.dispatchFetch("https://musegod.fun/api/not-found",{headers:{"cf-connecting-ip":"192.0.2.77"}});assert.equal(after.status,404);
  }finally{await mf.dispose();}
});

test("real Worker Base counters share one multicall across anonymous forced refreshes",{timeout:60_000},async()=>{
  const bundled=await build({entryPoints:["worker/index.ts"],bundle:true,write:false,format:"esm",platform:"node",target:"es2022",external:["node:*","cloudflare:*"],banner:{js:'import {createRequire} from "node:module";const require=createRequire("/fixture.js");'}});
  const methods:string[]=[],bindings={CHAIN_MODE:"robinhood",NODE_ENV:"production",PLATFORM_TREASURY:baseDeployment.constants.operationsTreasury,
    BASE_FEE_COLLECTOR_ADDRESS:baseDeployment.collector.address,ENABLE_BASE_TRANSACTIONS:"true",ENABLE_ROBINHOOD_TRANSACTIONS:"true",
    SUPABASE_URL:"https://counterfixture.supabase.co",SUPABASE_SECRET_KEY:"private-unit-fixture",ALCHEMY_API_KEY:"counter-worker-unit-key"};
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:"2026-10-04",compatibilityFlags:["nodejs_compat"],script:bundled.outputFiles[0].text,
    durableObjects:{LAUNCHPAD:{className:"LaunchpadRuntime",useSQLite:true}},bindings,serviceBindings:{ASSETS:async()=>new Response("asset fixture")},
    outboundService:async request=>{
      const url=new URL(request.url);
      if(url.hostname==="counterfixture.supabase.co") {
        if(url.pathname.endsWith("musegod_reserve_runtime_budget"))return Response.json({allowed:true,retryAfter:0});
        return Response.json([]);
      }
      assert.equal(url.hostname,"base-mainnet.g.alchemy.com");
      const raw=await request.json() as any,results=(Array.isArray(raw)?raw:[raw]).map((body:any)=>{
        methods.push(body.method);let result:Hex;
        if(body.method==="eth_blockNumber") result="0x2710";
        else {
          assert.equal(body.method,"eth_call");assert.equal(body.params[1],"0x2710");
          const decoded=decodeFunctionData({abi:multicall3Abi,data:body.params[0].data});assert.equal(decoded.functionName,"aggregate3");
          const calls=(decoded.args as any)[0].map((call:any)=>{
            const abi=call.target.toLowerCase()===baseDeployment.collector.address.toLowerCase()?baseCollectorAbi:erc20Abi;
            const inner=decodeFunctionData({abi,data:call.callData});
            const value=inner.functionName==="paused"?false:inner.functionName==="totalClaimed"?8n:inner.functionName==="totalReleased"?3n:2n;
            return{success:true,returnData:encodeFunctionResult({abi,functionName:inner.functionName as any,result:value})};
          });
          assert.equal(calls.length,(ADMITTED_BASE_ASSET_COUNT+1)*4+1);result=encodeFunctionResult({abi:multicall3Abi,functionName:"aggregate3",result:calls});
        }
        return{jsonrpc:"2.0",id:body.id,result};
      });
      return Response.json(Array.isArray(raw)?results:results[0]);
    }}));
  try {
    const read=async()=>{const response=await mf.dispatchFetch("https://musegod.fun/api/chains/8453/buyback/engine",{headers:{"cf-connecting-ip":"192.0.2.50","cache-control":"no-cache","pragma":"no-cache"}});assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<any>;};
    const first=await read();assert.equal(first.available,true,JSON.stringify({first,methods}));assert.equal(first.assets.length,ADMITTED_BASE_ASSET_COUNT+1);assert.equal(first.assets[0].totalClaimed,"8");assert.equal(first.assets[0].totalReleased,"3");
    const cold=[...methods];assert.deepEqual(cold,["eth_blockNumber","eth_call"]);
    const repeat=await Promise.all(Array.from({length:4},read));assert(repeat.every(value=>value.checkedAt===first.checkedAt));assert.deepEqual(methods,cold,"Repeated Worker display requests make zero RPC calls");
  }finally{await mf.dispose();}
});
