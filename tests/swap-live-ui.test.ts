import test from 'node:test';import assert from 'node:assert/strict';import {renderToStaticMarkup} from 'react-dom/server';import {hookRuntime,importFresh,settle} from './hook-runtime';
import fixtures from './fixtures/alchemy-swaps.json';import {decodeDelivery,registeredPools} from '../server/swap-stream';
test('C1-2: client applies 100 validated pushes with zero REST, dedupes replay, updates price/trades/candle, disconnect falls back',async t=>{
 let listener:any,output:any,bridge:any,reads=0;const trade=decodeDelivery(JSON.stringify(fixtures.deliveries.v3),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const},registeredPools(4663,[])).trades[0];
 const initial={summary:null,candles:null,trades:null};const props:any={...initial,chainId:4663,pool:trade.pool,path:'/musegod/market',interval:'1h',info:null,onUpdate:(v:any)=>{output=v;}};
 const runtime=hookRuntime(()=>bridge(props));({default:bridge}=await importFresh('src/components/SwapLive.tsx',{
 react:{file:import.meta.resolve('react'),bindings:runtime.hooks},'../lib/api':{file:import.meta.resolve('../src/lib/api.ts'),bindings:{chainApi:async()=>{reads++;return null;}}},'../lib/swap-live':{file:import.meta.resolve('../src/lib/swap-live.ts'),bindings:{subscribeSwapStream:(_id:number,_pool:string,next:any)=>{listener=next;next.status({connected:true,receiving:false,receivedAt:null});return()=>{};}}}}));
 t.after(()=>runtime.unmount());runtime.render();await settle();assert.equal(renderToStaticMarkup(runtime.output()),'');
 const message={type:'trades',chainId:4663,pool:trade.pool,trades:[trade],blockNumber:trade.blockNumber,blockHash:trade.blockHash,reorg:false,coverageStart:trade.at};assert.equal(await listener.event(message),true);await settle();assert.equal(output.summary.priceQuote,trade.priceQuote);assert.equal(output.trades.trades.length,1);assert.equal(output.candles.candles.length,1);
 for(let n=0;n<100;n++)assert.equal(await listener.event(message),false);assert.equal(reads,0);assert.equal(output.candles.candles[0].volume,Number(trade.quoteAmount));
 listener.status({connected:true,receiving:true,receivedAt:Date.now()});await settle();assert.match(renderToStaticMarkup(runtime.output()),/Live · On-chain/);listener.status({connected:false,receiving:false,receivedAt:null});await settle();assert.equal(output,null);
});
test('C1-2: explicit reorg/gap signals debounce with jitter and refresh at most every 30s',async()=>{
 const {createGapRefresh}=await import('../src/lib/swap-live');let now=0,calls=0;const jobs:{at:number;run:()=>void}[]=[];const refresh=createGapRefresh(async()=>{calls++;},{now:()=>now,random:()=>0.5,schedule:(run,ms)=>{const job={at:now+ms,run};jobs.push(job);return()=>{jobs.splice(jobs.indexOf(job),1);};}});
 for(let n=0;n<100;n++)refresh.request();assert.equal(jobs.length,1);assert(jobs[0].at>=5000&&jobs[0].at<10000);now=jobs[0].at;jobs.shift()!.run();await settle();assert.equal(calls,1);for(let n=0;n<100;n++)refresh.request();assert.equal(jobs.length,1);assert(jobs[0].at>=now+30000);refresh.stop();
});
