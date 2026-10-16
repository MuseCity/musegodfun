import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {MUSEGOD} from '../src/lib/musegod';
test('X6-1: real workerd runs the display price reader with its default fetch, reaches LI.FI and forwards a configured key',{timeout:60_000},async()=>{
 // The actual reader under the production runtime flags; LI.FI is an outbound fixture, never a live call.
 const {outputFiles}=await build({bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
  import {SwapQuotePrices} from './server/swap-prices';import {MUSEGOD} from './src/lib/musegod';
  const pool={chainId:4663,version:3,pool:MUSEGOD.pool.toLowerCase(),token:MUSEGOD.token.toLowerCase(),quote:MUSEGOD.weth.toLowerCase(),tokenDecimals:18,quoteDecimals:18,quoteSymbol:'WETH'};
  export default {async fetch(request){const key=new URL(request.url).searchParams.get('key')??undefined,reader=new SwapQuotePrices(undefined,undefined,key);
   const price=await reader.get(pool);return Response.json({price,peek:reader.peek(pool)});}};`}});
 const seen:{url:URL;key:string|null;redirect:string}[]=[];
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-04',compatibilityFlags:['nodejs_compat'],script:outputFiles[0].text,outboundService:async(request:Request)=>{
  const url=new URL(request.url);seen.push({url,key:request.headers.get('x-lifi-api-key'),redirect:request.redirect});
  return Response.json({address:MUSEGOD.weth,chainId:4663,decimals:18,symbol:'WETH',priceUSD:'2460.5'});}}));
 try{
  for(const key of [null,'synthetic-lifi-key']){
   const response=await runtime.dispatchFetch('https://local.test/'+(key?`?key=${key}`:'')),result=await response.json() as any;
   assert.equal(response.status,200);assert.equal(result.price?.price,2460.5,`workerd must return a price (key ${key?'configured':'absent'})`);assert.equal(result.price.source,'LI.FI');assert.deepEqual(result.peek,result.price);
   const call=seen.at(-1)!;assert.equal(call.url.origin+call.url.pathname,'https://li.quest/v1/token');assert.equal(call.url.searchParams.get('chain'),'4663');assert.equal(call.url.searchParams.get('token'),MUSEGOD.weth.toLowerCase());assert.equal(call.key,key);
  }
  assert.equal(seen.length,2,'one LI.FI read per fresh reader');
 }finally{await runtime.dispose();}
});
