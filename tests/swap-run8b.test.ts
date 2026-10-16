import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {renderToStaticMarkup} from 'react-dom/server';
import {registeredPools,decodeDelivery} from '../server/swap-stream';import {MemorySwapStore} from '../server/swap-store';import {SwapService} from '../server/swap-service';import {runWebhookCli} from '../scripts/alchemy-webhooks';import {mergeSummary,priceTrade} from '../src/lib/swap-market';import {applySwapPush} from '../src/lib/swap-projection';import type {MarketSummary} from '../src/lib/market';import {syntheticToken} from './fixtures';import {hookRuntime,importFresh,settle} from './hook-runtime';import fixtures from './fixtures/alchemy-swaps.json';
const pool=registeredPools(4663,[])[0];
function sample(){const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000)-10;return decodeDelivery(JSON.stringify(body),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3'},[pool]);}
const provider=(at:string,usd:boolean):MarketSummary=>({source:'Bankr',fetchedAt:new Date(Date.parse(at)+1000).toISOString(),lastTradeAt:at,status:'fresh',priceUsd:usd?0.000158:null,marketCapUsd:158000,fdvUsd:200000,liquidityUsd:9000,periods:{m5:{change:1,volume:5,buys:2,sells:1},h24:{change:2,volume:1234,buys:44,sells:15}}});
async function summaries(base:MarketSummary|null,usd:boolean){
 const delivery=sample(),trade=delivery.trades[0],quote=usd?{price:2460,source:'LI.FI' as const,at:new Date().toISOString()}:null,store=new MemorySwapStore();store.apply(delivery);
 const service=new SwapService(4663,store,{pools:async()=>[pool],quote:async()=>quote}),priced=priceTrade(trade,quote),message={type:'trades' as const,chainId:4663 as const,pool:pool.pool,trades:[priced],blockNumber:trade.blockNumber,blockHash:trade.blockHash,reorg:false,coverageStart:trade.at};
 const rest:MarketSummary=await service.serve('summary',pool.pool,async()=>base),push=applySwapPush({summary:base,candles:null,trades:null},message,'1h');assert(push.summary);
 const {fetchedAt:_rest,...restValues}=rest,{fetchedAt:_push,...pushValues}=push.summary;assert.deepEqual(pushValues,restValues);return {rest,push:push.summary,trade:priced,message};
}
for(const providerUsd of [true,false])for(const ownUsd of [true,false])test(`C5-1: provider USD ${providerUsd}, own USD ${ownUsd} retains all provider statistics and their fetch time in REST and push`,async()=>{
 const trade=sample().trades[0],base=provider(new Date(Date.parse(trade.at)-2000).toISOString(),providerUsd),result=await summaries(base,ownUsd);
 for(const summary of [result.rest,result.push]){
  assert.equal(summary.marketCapUsd,base.marketCapUsd);assert.equal(summary.fdvUsd,base.fdvUsd);assert.equal(summary.liquidityUsd,base.liquidityUsd);assert.deepEqual(summary.periods,base.periods);
  if(ownUsd||!providerUsd){assert.equal(summary.source,'On-chain · Alchemy');assert.equal(summary.priceUsd,ownUsd?Number(result.trade.priceQuote)*2460:null);assert.equal(summary.lastTradeAt,result.trade.at);assert.equal(summary.historySource,'Bankr');assert.equal(summary.historyFetchedAt,base.fetchedAt);}
  else {assert.equal(summary.source,'Bankr');assert.equal(summary.priceUsd,base.priceUsd);assert.equal(summary.fetchedAt,base.fetchedAt);assert.equal(summary.quotePriceAt,result.trade.at);}
 }
});
for(const usd of [true,false])test(`C5-1: no provider summary leaves statistics unavailable with own USD ${usd}`,async()=>{
 const {rest,push}=await summaries(null,usd);for(const summary of [rest,push]){assert.equal(summary.marketCapUsd,null);assert.equal(summary.fdvUsd,null);assert.equal(summary.liquidityUsd,null);assert.deepEqual(summary.periods,{});assert.equal(summary.historySource,undefined);assert.equal(summary.historyFetchedAt,undefined);}
});
test('C5-1: repeated pushes retain the original provider statistics and time while advancing the headline',async()=>{
 const trade=sample().trades[0],base=provider(new Date(Date.parse(trade.at)-2000).toISOString(),true),first=await summaries(base,true),next={...first.trade,blockNumber:first.trade.blockNumber+1,at:new Date(Date.parse(first.trade.at)+1000).toISOString(),priceUsd:0.0002};
 const push=applySwapPush({summary:first.push,candles:null,trades:null},{...first.message,trades:[next],blockNumber:next.blockNumber},'1h').summary;assert(push);assert.equal(push.priceUsd,next.priceUsd);assert.equal(push.marketCapUsd,base.marketCapUsd);assert.equal(push.fdvUsd,base.fdvUsd);assert.equal(push.liquidityUsd,base.liquidityUsd);assert.deepEqual(push.periods,base.periods);assert.equal(push.historySource,'Bankr');assert.equal(push.historyFetchedAt,base.fetchedAt);
});
test('C5-1: zero provider statistics remain available when the own USD headline wins',()=>{
 const trade=priceTrade(sample().trades[0],{price:2460,source:'LI.FI',at:new Date().toISOString()}),base={...provider(new Date(Date.parse(trade.at)-2000).toISOString(),true),marketCapUsd:0,fdvUsd:0,liquidityUsd:0},summary=mergeSummary(base,[trade],trade.at);assert.equal(summary.marketCapUsd,0);assert.equal(summary.fdvUsd,0);assert.equal(summary.liquidityUsd,0);
});
test('C5-1: the own USD headline renders retained caps, liquidity and volume with provider attribution',async t=>{
 const trade=sample().trades[0],base=provider(new Date(Date.parse(trade.at)-2000).toISOString(),true),{rest:summary}=await summaries(base,true),previous=['document','window'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
 for(const name of ['document','window'])Object.defineProperty(globalThis,name,{configurable:true,value:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}});
 let View:any;const runtime=hookRuntime(()=>View({token:syntheticToken({mode:'robinhood',deploymentChainId:4663}),kind:'musegod',refreshKey:'run8b'}));
 t.after(()=>{runtime.unmount();for(const [name,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}});
 ({default:View}=await importFresh('src/components/TokenMarket.tsx',{react:{file:import.meta.resolve('react'),bindings:runtime.hooks},'../lib/api':{file:import.meta.resolve('../src/lib/api.ts'),bindings:{chainApi:async(_id:number,path:string)=>path.endsWith('/summary')?summary:path.endsWith('/trades')?{source:'Bankr',fetchedAt:base.fetchedAt,trades:[]}:{source:'Bankr',fetchedAt:base.fetchedAt,candles:[]}}}}));
 runtime.render();await settle();const html=renderToStaticMarkup(runtime.output());assert.match(html,/Market cap.*\$158K/s);assert.match(html,/Fully diluted valuation.*\$200K/s);assert.match(html,/Liquidity.*\$9K/s);assert.match(html,/24h volume.*\$1\.23K/s);assert.match(html,/Summary · On-chain · Alchemy/);assert(html.includes(`Provider statistics: Bankr · Fetched ${new Date(base.fetchedAt).toLocaleTimeString('en-US')}`));
});
for(const chainId of [4663,8453,null] as const)test(`C5-2: ${chainId??'empty'} catalog skips every absent-chain kind without a plan and preserves present-chain plans`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'swap-run8b-cli-'));try{const tokens=chainId===null?[]:[syntheticToken(chainId===4663?{mode:'robinhood',deploymentChainId:4663,quoteAddress:pool.quote as `0x${string}`}:{})],file=join(directory,'tokens.json');await writeFile(file,JSON.stringify(tokens));let reads=0;
  const result=await runWebhookCli(['--tokens',file],{ALCHEMY_NOTIFY_API_KEY:'synthetic'},async(_input,init)=>{assert.equal(init?.method,'GET');reads++;return Response.json({data:[]});});assert.equal(reads,1);assert.equal(result.diff.length,3);
  for(const entry of result.diff){if(entry.chainId!==chainId){assert.equal(entry.action,'skipped (not in catalog)');assert.equal(entry.poolCount,0);assert(!('query' in entry));assert(!('url' in entry));}else{assert.equal(entry.action,'create');assert.equal(entry.poolCount,1);assert('query' in entry&&entry.query);assert.equal((entry.query.query.match(/\blogs\s*\(/g)??[]).length,1);assert('url' in entry&&entry.url);assert.equal(new URL(entry.url).pathname,`/api/chains/${chainId}/webhooks/alchemy/${entry.kind}`);}}
 }finally{await rm(directory,{recursive:true,force:true});}
});
