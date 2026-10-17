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
async function liveFixture(options:{read:(path:string)=>Promise<any>;initialResumed?:boolean}){
 let listener:any,output:any,bridge:any,requested=0;const reads:string[]=[];const trade=decodeDelivery(JSON.stringify(fixtures.deliveries.v3),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const},registeredPools(4663,[])).trades[0];
 const props:any={summary:null,candles:null,trades:null,chainId:4663,pool:trade.pool,path:'/musegod/market',interval:'1h',info:null,onUpdate:(v:any)=>{output=v;}};
 const runtime=hookRuntime(()=>bridge(props));({default:bridge}=await importFresh('src/components/SwapLive.tsx',{
  react:{file:import.meta.resolve('react'),bindings:runtime.hooks},
  '../lib/api':{file:import.meta.resolve('../src/lib/api.ts'),bindings:{chainApi:async(_chain:number,path:string)=>{reads.push(path);return options.read(path);}}},
  '../lib/swap-live':{file:import.meta.resolve('../src/lib/swap-live.ts'),bindings:{
   subscribeSwapStream:(_id:number,_pool:string,next:any)=>{listener=next;next.status({connected:true,receiving:false,receivedAt:null,resumed:options.initialResumed??false});return()=>{};},
   createGapRefresh:(work:()=>Promise<void>)=>({request(){requested++;void work();},stop(){}}),
  }}}));
 runtime.render();await settle();
 const message=(t:any)=>({type:'trades',chainId:4663,pool:t.pool,trades:[t],blockNumber:t.blockNumber,blockHash:t.blockHash,reorg:false,coverageStart:trade.at});
 const later={...trade,id:`4663:0x${'b'.repeat(64)}:0`,hash:`0x${'b'.repeat(64)}`,logIndex:0,blockNumber:trade.blockNumber+1,blockHash:`0x${'c'.repeat(64)}`};
 return {runtime,get listener(){return listener;},get output(){return output;},get requested(){return requested;},reads,trade,later,message};
}
test('a synchronous initial resumed status skips recovery, while the same status delivered later requests it',async t=>{
 const f=await liveFixture({read:async()=>null,initialResumed:true});t.after(()=>f.runtime.unmount());
 assert.equal(f.requested,0);assert.deepEqual(f.reads,[]);
 f.listener.status({connected:true,receiving:false,receivedAt:null,resumed:true});await settle();assert.equal(f.requested,1);assert.equal(f.reads.length,3);
});
test('a resumed connection requests the gated recovery; a plain connection and pushes do not',async t=>{
 const f=await liveFixture({read:async()=>null});t.after(()=>f.runtime.unmount());
 assert.equal(f.requested,0);f.listener.status({connected:true,receiving:false,receivedAt:null});await settle();assert.equal(f.requested,0);
 f.listener.status({connected:false,receiving:false,receivedAt:null});f.listener.status({connected:true,receiving:false,receivedAt:null,resumed:true});await settle();assert.equal(f.requested,1);
 assert.deepEqual([...f.reads].sort(),['/musegod/market/candles?interval=1h','/musegod/market/summary','/musegod/market/trades']);
 await f.listener.event(f.message(f.trade));await settle();assert.equal(f.reads.length,3,'pushes never read REST');
});
test('a push received while a recovery is in flight survives a snapshot that lacks it',async t=>{
 const {applySwapPush}=await import('../src/lib/swap-projection');
 let resolve!:(value:any)=>void;const pending=new Promise<any>(r=>{resolve=r;});let stale:any;
 const f=await liveFixture({read:async(path)=>{await pending;return path.endsWith('/trades')?stale.trades:path.endsWith('/summary')?stale.summary:stale.candles;}});t.after(()=>f.runtime.unmount());
 assert.equal(await f.listener.event(f.message(f.trade)),true);await settle();assert.equal(f.output.trades.trades.length,1);
 f.listener.status({connected:true,receiving:false,receivedAt:null,resumed:true});await settle();assert.equal(f.requested,1);
 assert.equal(await f.listener.event(f.message(f.later)),true);await settle();assert.equal(f.output.trades.trades.length,2);
 // The snapshot was served before the later trade was stored.
 stale=applySwapPush({summary:null,candles:null,trades:null},f.message(f.trade) as any,'1h');
 resolve(null);await settle();await settle();await settle();
 assert.deepEqual(f.output.trades.trades.map((t:any)=>t.hash).sort(),[f.trade.hash,f.later.hash].sort(),'the newer push is replayed over the older snapshot');
 assert.equal(f.output.summary.priceQuote,f.later.priceQuote);
 assert.equal(f.output.candles.candles.reduce((n:number,c:any)=>n+c.volume,0),Number(f.trade.quoteAmount)+Number(f.later.quoteAmount));
});
test('a push already contained in the recovery snapshot adds no row and no volume, and a reorg during recovery is not replayed',async t=>{
 const {applySwapPush}=await import('../src/lib/swap-projection');
 let resolve!:(value:any)=>void;const pending=new Promise<any>(r=>{resolve=r;});let snapshot:any;
 const f=await liveFixture({read:async(path)=>{await pending;return path.endsWith('/trades')?snapshot.trades:path.endsWith('/summary')?snapshot.summary:snapshot.candles;}});t.after(()=>f.runtime.unmount());
 snapshot=applySwapPush(applySwapPush({summary:null,candles:null,trades:null},f.message(f.trade) as any,'1h'),f.message(f.later) as any,'1h');
 f.listener.status({connected:true,receiving:false,receivedAt:null,resumed:true});await settle();assert.equal(f.requested,1);
 assert.equal(await f.listener.event(f.message(f.later)),true);
 assert.equal(await f.listener.event({...f.message(f.later),reorg:true}),false);assert.equal(f.requested,2,'a reorg still asks for another recovery');
 resolve(null);await settle();await settle();await settle();
 assert.equal(f.output.trades.trades.length,2);
 assert.equal(f.output.candles.candles.reduce((n:number,c:any)=>n+c.volume,0),Number(f.trade.quoteAmount)+Number(f.later.quoteAmount),'replaying a contained push counts nothing twice');
 assert.equal(f.output.summary.priceQuote,f.later.priceQuote);
});
test('C1 replaying a push the snapshot already holds keeps the snapshot price and USD values; an older same-block log never overwrites a newer one',async t=>{
 const {applySwapPush}=await import('../src/lib/swap-projection');
 let resolve!:(value:any)=>void;const pending=new Promise<any>(r=>{resolve=r;});let snapshot:any;
 const f=await liveFixture({read:async(path)=>{await pending;return path.endsWith('/trades')?snapshot.trades:path.endsWith('/summary')?snapshot.summary:snapshot.candles;}});t.after(()=>f.runtime.unmount());
 // The push carried no USD quote; the recovery snapshot priced the same trade (log 2 of its block) through REST.
 const later={...f.later,id:`4663:${f.later.hash}:2`,logIndex:2};
 const unpriced={...later,priceUsd:null,usd:null,quoteUsd:null};
 const priced={...later,priceUsd:Number(later.priceQuote)*2460,usd:Number(later.quoteAmount)*2460,quoteUsd:{price:2460,source:'LI.FI' as const,at:new Date().toISOString()}};
 snapshot=applySwapPush(applySwapPush({summary:null,candles:null,trades:null},f.message(f.trade) as any,'1h'),f.message(priced) as any,'1h');
 f.listener.status({connected:true,receiving:false,receivedAt:null,resumed:true});await settle();assert.equal(f.requested,1);
 assert.equal(await f.listener.event(f.message(unpriced)),true);
 // An earlier log of the same block arrives late: it is at or below the watermark, so only a server gap signal (a recovery) can add it.
 const earlier={...later,id:`4663:0x${'e'.repeat(64)}:1`,hash:`0x${'e'.repeat(64)}`,logIndex:1,priceQuote:'0.000001',priceUsd:null,usd:null,quoteUsd:null};
 assert.equal(await f.listener.event(f.message(earlier)),false);
 resolve(null);await settle();await settle();await settle();
 assert.equal(f.output.summary.priceUsd,priced.priceUsd,'the snapshot USD headline survives the unpriced replay');
 assert.equal(f.output.summary.priceQuote,later.priceQuote,'a later log in the same block keeps the headline');
 const row=f.output.trades.trades.find((row:any)=>row.hash===later.hash);assert.equal(row.usd,priced.usd);assert.equal(row.price,priced.priceUsd);
 assert.equal(f.output.trades.trades.length,2);
 assert.equal(f.output.candles.candles.reduce((n:number,c:any)=>n+c.volume,0),(Number(f.trade.quoteAmount)+Number(later.quoteAmount))*2460,'USD candles keep the snapshot quote');
});
/** One deferred REST response set per recovery, resolved by the test in any order. */
function staggered(){const batches:{resolve:(snapshot:any)=>void;promise:Promise<any>}[]=[];let calls=0;
 const read=(path:string)=>{const index=Math.floor(calls++/3);if(!batches[index]){let resolve!:(snapshot:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});batches[index]={resolve,promise};}
  return batches[index].promise.then(snapshot=>path.endsWith('/trades')?snapshot.trades:path.endsWith('/summary')?snapshot.summary:snapshot.candles);};
 return {read,resolve:(index:number,snapshot:any)=>batches[index].resolve(snapshot)};}
test('C2 a recovery started before a reorg never publishes, even when its pre-reorg snapshot arrives after the clean follow-up',async t=>{
 const {applySwapPush}=await import('../src/lib/swap-projection');const rest=staggered();
 const f=await liveFixture({read:rest.read});t.after(()=>f.runtime.unmount());
 const empty={summary:null,candles:null,trades:null};
 f.listener.status({connected:true,receiving:false,receivedAt:null,resumed:true});await settle();assert.equal(f.requested,1);
 assert.equal(await f.listener.event(f.message(f.later)),true);await settle();assert.equal(f.output.trades.trades.length,1);
 // The block holding `later` is orphaned: the reorg requests a second recovery.
 assert.equal(await f.listener.event({...f.message(f.later),trades:[],reorg:true}),false);assert.equal(f.requested,2);
 const after={...f.later,id:`4663:0x${'f'.repeat(64)}:0`,hash:`0x${'f'.repeat(64)}`,logIndex:0,blockNumber:f.later.blockNumber+1,blockHash:`0x${'a'.repeat(64)}`};
 assert.equal(await f.listener.event(f.message(after)),true);
 // The follow-up's snapshot (served after the reorg) arrives first.
 rest.resolve(1,applySwapPush(empty,f.message(f.trade) as any,'1h'));await settle();await settle();await settle();
 assert.deepEqual(f.output.trades.trades.map((row:any)=>row.hash).sort(),[f.trade.hash,after.hash].sort(),'the orphaned trade is gone; the post-reorg push is replayed');
 // The first recovery's snapshot was served before the reorg and still holds the orphaned trade: it must not publish.
 rest.resolve(0,applySwapPush(applySwapPush(empty,f.message(f.trade) as any,'1h'),f.message(f.later) as any,'1h'));await settle();await settle();await settle();
 assert.deepEqual(f.output.trades.trades.map((row:any)=>row.hash).sort(),[f.trade.hash,after.hash].sort(),'a stale recovery cannot bring the orphaned trade back');
 assert.equal(f.output.candles.candles.reduce((n:number,c:any)=>n+c.volume,0),Number(f.trade.quoteAmount)+Number(after.quoteAmount));
});
test('C2 recoveries that complete out of order never let an older snapshot overwrite a newer one',async t=>{
 const {applySwapPush}=await import('../src/lib/swap-projection');const rest=staggered();
 const f=await liveFixture({read:rest.read});t.after(()=>f.runtime.unmount());
 const empty={summary:null,candles:null,trades:null};
 f.listener.status({connected:true,receiving:false,receivedAt:null,resumed:true});await settle();assert.equal(f.requested,1);
 // A gap signal: the server stored a row the stream had not delivered; the second recovery's snapshot carries it.
 assert.equal(await f.listener.event({...f.message(f.later),trades:[],gap:true}),false);assert.equal(f.requested,2);
 rest.resolve(1,applySwapPush(applySwapPush(empty,f.message(f.trade) as any,'1h'),f.message(f.later) as any,'1h'));await settle();await settle();await settle();
 assert.equal(f.output.trades.trades.length,2);
 rest.resolve(0,applySwapPush(empty,f.message(f.trade) as any,'1h'));await settle();await settle();await settle();
 assert.equal(f.output.trades.trades.length,2,'the older first recovery is discarded');
 assert.equal(f.output.summary.priceQuote,f.later.priceQuote);
});
