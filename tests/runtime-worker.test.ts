import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare,convertV4MiniflareOptions } from "miniflare";
import { firstBuyPaymentAssets } from "../src/lib/first-buy-payment";

test("real Worker routes refresh native secrets and flags while persistent pause survives code updates",{timeout:60_000},async()=>{
  const bundled=await build({entryPoints:["worker/index.ts"],bundle:true,write:false,format:"esm",platform:"node",target:"es2022",external:["node:*","cloudflare:*"],banner:{js:'import {createRequire} from "node:module";const require=createRequire("/fixture.js");'}});
  let paused=false;const keys:string[]=[];
  const bindings={CHAIN_MODE:"robinhood",NODE_ENV:"production",PLATFORM_TREASURY:"0x1111111111111111111111111111111111111111",ENABLE_MAINNET_TRANSACTIONS:"true",SUPABASE_URL:"https://fixture.supabase.co",SUPABASE_SECRET_KEY:"fixture-db",LIFI_API_KEY:"fixture-old",ROBINHOOD_RPC_URL:"https://rh-rpc.fake.test",BASE_RPC_URL:"https://base-rpc.fake.test",TURNSTILE_SITE_KEY:"fixture-public",TURNSTILE_SECRET_KEY:"fixture-private"};
  const options=(env:Record<string,string>,suffix="")=>convertV4MiniflareOptions({modules:true,compatibilityDate:"2026-10-04",compatibilityFlags:["nodejs_compat"],script:bundled.outputFiles[0].text+suffix,durableObjects:{LAUNCHPAD:{className:"LaunchpadRuntime",useSQLite:true}},bindings:env,serviceBindings:{ASSETS:async()=>new Response("asset fixture")},outboundService:async request=>{
    const url=new URL(request.url);
    if(url.hostname==="fixture.supabase.co") {
      assert.equal(request.headers.get("apikey"),"fixture-db");
      if(url.pathname.endsWith("musegod_runtime_controls"))return Response.json([{paused,revision:4,updated_at:1,reason:"fixture"}]);
      if(url.pathname.endsWith("musegod_reserve_runtime_budget"))return Response.json({allowed:true,retryAfter:0});
      return Response.json([]);
    }
    if(url.hostname==="li.quest") {
      keys.push(request.headers.get("x-lifi-api-key")??"");
      const asset=firstBuyPaymentAssets(Number(url.searchParams.get("chain")) as 4663|8453).find(a=>a.address.toLowerCase()===url.searchParams.get("token")?.toLowerCase());
      assert(asset);return Response.json({...asset,priceUSD:"1"});
    }
    if(url.hostname.endsWith("-rpc.fake.test")) {
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
    await get("/api/first-buy/prices");assert(keys.every(key=>key==="fixture-old"));
    await mf.setOptions(options({...bindings,ENABLE_MAINNET_TRANSACTIONS:"false",LIFI_API_KEY:"fixture-new"}));
    assert.equal((await get("/api/config")).writesEnabled,false);
    keys.length=0;await get("/api/first-buy/prices");assert(keys.length>0 && keys.every(key=>String(key)==="fixture-new"));
    paused=true;
    await mf.setOptions(options(bindings,"\n// New version, same persisted safety control\n"));
    const controlled=await get("/api/config");assert.equal(controlled.writesEnabled,false);assert.equal(controlled.signingPaused,true);assert.equal(controlled.controlRevision,4);
    const tooLarge=await mf.dispatchFetch("https://musegod.fun/api/launch/prepare",{method:"POST",headers:{"cf-connecting-ip":"192.0.2.11","content-type":"application/json"},body:"x".repeat(65537)});
    assert.equal(tooLarge.status,413);
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
  }finally{await mf.dispose();}
});
