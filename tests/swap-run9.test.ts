import test from 'node:test';import assert from 'node:assert/strict';
import {registeredPools,decodeDelivery} from '../server/swap-stream';import {MemorySwapStore} from '../server/swap-store';import {SwapService} from '../server/swap-service';import {priceTrade} from '../src/lib/swap-market';import {applySwapPush} from '../src/lib/swap-projection';import type {MarketSummary} from '../src/lib/market';import type {OnchainTrade} from '../src/lib/swap-stream';import fixtures from './fixtures/alchemy-swaps.json';
const pool=registeredPools(4663,[])[0];
const template=()=>{const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000)-100;return decodeDelivery(JSON.stringify(body),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3'},[pool]).trades[0];};
const provider=(at:string):MarketSummary=>({source:'Bankr',fetchedAt:new Date(Date.parse(at)+1000).toISOString(),lastTradeAt:at,status:'fresh',priceUsd:0.000158,marketCapUsd:158000,fdvUsd:200000,liquidityUsd:9000,periods:{h24:{change:2,volume:1234,buys:44,sells:15}}});
const values=({fetchedAt:_,...rest}:MarketSummary)=>rest;
/** Each step stores one newer own swap; REST serves it with the provider summary, the push applies the broadcast to the client's previous summary. */
function market(base:MarketSummary|null){
 const first=template(),store=new MemorySwapStore();let quote:OnchainTrade['quoteUsd']=null,n=0,client:MarketSummary|null=base;
 const service=new SwapService(4663,store,{pools:async()=>[pool],quote:async()=>quote});
 return {first,async step(usd:boolean,mode:'rest'|'push'){
  n++;quote=usd?{price:2000+n,source:'LI.FI',at:new Date().toISOString()}:null;const hash='0x'+n.toString(16).padStart(64,'0'),t={...first,id:`4663:${hash}:0`,hash,logIndex:0,blockNumber:first.blockNumber+n,blockHash:'0x'+(n+16).toString(16).padStart(64,'0'),at:new Date(Date.parse(first.at)+n*1000).toISOString()};
  store.apply({webhookId:'wh_test_v3',kind:'v3',sequence:String(n),blockNumber:t.blockNumber,blockHash:t.blockHash,timestamp:Date.parse(t.at)/1000,trades:[t]});
  const priced=priceTrade(t,quote),rest:MarketSummary=JSON.parse(JSON.stringify(await service.serve('summary',pool.pool,async()=>base)));
  const pushed=applySwapPush({summary:client,candles:null,trades:null},{type:'trades',chainId:4663,pool:pool.pool,trades:[priced],reorg:false,blockNumber:t.blockNumber,blockHash:t.blockHash,coverageStart:store.coverage(pool.pool)!},'1h').summary!;
  // Both sides as they cross the wire, so absent and undefined fields compare equal.
  const push:MarketSummary=JSON.parse(JSON.stringify(pushed));client=mode==='rest'?rest:push;return {rest,push,trade:priced};
 }};
}
function expectHeadline(summary:MarketSummary,base:MarketSummary|null,trade:OnchainTrade,label:string){
 if(trade.priceUsd!=null){assert.equal(summary.source,'On-chain · Alchemy',label);assert.equal(summary.priceUsd,trade.priceUsd,label);assert.equal(summary.quotePriceAt,undefined,label);assert.equal(summary.lastTradeAt,trade.at,label);}
 else if(base){assert.equal(summary.source,'Bankr',label+': the provider USD headline returns');assert.equal(summary.priceUsd,base.priceUsd,label);assert.equal(summary.fetchedAt,base.fetchedAt,label+': with its own fetch time');assert.equal(summary.quotePriceAt,trade.at,label+': our quote price keeps its own time');}
 else {assert.equal(summary.source,'On-chain · Alchemy',label);assert.equal(summary.priceUsd,null,label);}
 assert.equal(summary.priceQuote,trade.priceQuote,label);assert.equal(summary.marketCapUsd,base?.marketCapUsd??null,label);assert.deepEqual(summary.periods,base?.periods??{},label);
}
for(const start of ['own-priced REST response','converted push'] as const)for(const withProvider of [true,false])test(`X5-1: available, missing, available conversions from a${start==='converted push'?'':'n'} ${start}${withProvider?'':' without a provider'}: push equals REST at every step`,async()=>{
 const base=withProvider?provider(new Date(Date.parse(template().at)-2000).toISOString()):null,m=market(base);
 const steps=[true,false,true,false,false,true];for(const [index,usd] of steps.entries()){const label=`step ${index} (${usd?'USD':'no USD'})`,mode=index===0&&start==='own-priced REST response'?'rest':'push',{rest,push,trade}=await m.step(usd,mode);
  assert.deepEqual(values(push),values(rest),label+': push and REST agree');expectHeadline(rest,base,trade,label+' REST');expectHeadline(push,base,trade,label+' push');}
});
