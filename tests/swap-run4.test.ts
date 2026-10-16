import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {readFile} from 'node:fs/promises';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer,request as httpRequest,type IncomingMessage,type ClientRequest} from 'node:http';import {once} from 'node:events';import {transform} from 'esbuild';import {renderToStaticMarkup} from 'react-dom/server';
import {MemorySwapStore,SqlSwapStore,SwapCapacityError,type SwapStore} from '../server/swap-store';import {SwapService,isWebhookPath} from '../server/swap-service';import {NotifyClient,desiredWebhook,reconcileWebhook} from '../server/alchemy-webhooks';import {decodeDelivery,registeredPools,MUSE_POOL,type Delivery} from '../server/swap-stream';import {readBoundedBody,requestBodyLimitForPath,BODY_READ_DEADLINE_MS} from '../server/http-security';import {MarketUnavailable} from '../server/snapshots';import {createApp} from '../server/app';import {runtimeFromEnv} from '../server/config';
import {priceTrade} from '../src/lib/swap-market';import {applySwapPush} from '../src/lib/swap-projection';import type {OnchainTrade,SwapMessage} from '../src/lib/swap-stream';import type {CandleData} from '../src/lib/market';import {MUSEGOD} from '../src/lib/musegod';import {hookRuntime,importFresh,settle} from './hook-runtime';import {syntheticToken} from './fixtures';import fixtures from './fixtures/alchemy-swaps.json';
const pools=registeredPools(4663,[]),key='run4-synthetic-key',path='/api/webhooks/alchemy',url='https://musegod.fun/api/chains/4663/webhooks/alchemy',junk='f'.repeat(64);
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
const A='0x'+'a1'.repeat(32),B='0x'+'b2'.repeat(32),C='0x'+'c3'.repeat(32);
function delivery(age=600){const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000)-age;return decodeDelivery(JSON.stringify(body),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const},pools);}
/** The same transaction/log delivered in block `number + offset` with its own hash, sequence and time. */
function block(d:Delivery,offset:number,hash:string,sequence:number,trades=true):Delivery{const n=d.blockNumber+offset,time=d.timestamp+offset*2;return {...d,blockNumber:n,blockHash:hash,sequence:String(sequence),timestamp:time,trades:trades?d.trades.map(t=>({...t,blockNumber:n,blockHash:hash,at:new Date(time*1000).toISOString()})):[]};}
type Adapter={name:string;store:SwapStore;lose(id:string):void;consistent():void;dump():unknown};
function adapters(t:{after(fn:()=>void):void},limit=50_000):(()=>Adapter)[]{
 return [()=>{const store=new MemorySwapStore(limit);return {name:'memory',store,lose:id=>(store as any).trades.delete(id),consistent(){},dump:()=>JSON.parse(JSON.stringify(['trades','alternates','blocks','state'].map(k=>[...(store as any)[k].entries()])))};},
  ()=>{const db=new DatabaseSync(':memory:');t.after(()=>db.close());const store=new SqlSwapStore({exec:(q:string,...a:any[])=>db.prepare(q).all(...a)},fn=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},limit);
   return {name:'sqlite',store,lose(id){db.prepare('DELETE FROM swap_trades WHERE id=?').run(id);store.set('trade-count',store.get<number>('trade-count')!-1);},consistent(){assert.equal(store.get('trade-count'),(db.prepare('SELECT COUNT(*) AS n FROM swap_trades').get() as any).n,'persisted trade count');},
    dump:()=>['swap_trades','swap_alternates','swap_blocks','swap_state'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())};}];
}
const placed=(s:SwapStore)=>s.rows(MUSE_POOL).map(t=>`${t.blockNumber}:${t.blockHash}`);
const volume=(s:SwapStore)=>s.buckets(MUSE_POOL,0,2**31,3600).reduce((n,b)=>n+b.bar.volume,0);
test('X2-1: a log reincluded in another block survives the orphan block\'s finality or replacement in both adapters',t=>{
 for(const make of adapters(t))for(const removal of ['finality','replacement'] as const){
  const f=make(),d=delivery(),orphan=block(d,0,A,10),canonical=block(d,1,B,12),label=`${f.name}/${removal}`,expected=[`${canonical.blockNumber}:${B}`];
  assert.equal(f.store.apply(orphan).trades.length,1);
  const moved=f.store.apply(canonical);assert.equal(moved.trades.length,1,label);assert.equal(moved.reorg,true,label+': clients must refresh the moved row');assert.deepEqual(moved.removedPools,[MUSE_POOL]);assert.deepEqual(placed(f.store),expected,label);f.consistent();
  if(removal==='finality')f.store.verifyBlock(orphan.blockNumber,A,C);else assert.equal(f.store.apply(block(d,0,C,13,false)).reorg,true);
  assert.deepEqual(placed(f.store),expected,label+': removing the orphan keeps the canonical occurrence');assert.equal(volume(f.store),Number(d.trades[0].quoteAmount),label+': one bucket contribution');f.consistent();
  for(const b of f.store.pendingBlocks(Math.floor(Date.now()/1000),10))f.store.verifyBlock(b.block,b.hash,b.block===canonical.blockNumber?B:C);
  assert.equal(f.store.apply(canonical).trades.length,0,label+': a retry after finality never double-counts');assert.deepEqual(placed(f.store),expected);assert.deepEqual(f.store.pendingBlocks(Math.floor(Date.now()/1000),10),[]);f.consistent();
 }
});
test('X2-1: canonical-first, late orphan and flip-back orders keep exactly the surviving occurrence in both adapters',t=>{
 for(const make of adapters(t)){
  for(const sequence of [11,14]){// An older retry of the orphan stays hidden; a newer view moves the row until finality restores it.
   const f=make(),d=delivery(),orphan=block(d,0,A,sequence),canonical=block(d,1,B,12),label=`${f.name}/late orphan ${sequence}`;
   f.store.apply(canonical);assert.equal(f.store.apply(orphan).trades.length,sequence>12?1:0,label);
   assert.deepEqual(f.store.verifyBlock(orphan.blockNumber,A,C),sequence>12?[MUSE_POOL]:[],label);assert.deepEqual(placed(f.store),[`${canonical.blockNumber}:${B}`],label);assert.equal(volume(f.store),Number(d.trades[0].quoteAmount));f.consistent();
  }
  const f=make(),d=delivery(),first=block(d,0,A,10),second=block(d,1,B,12);f.store.apply(first);f.store.apply(second);
  assert.deepEqual(f.store.verifyBlock(second.blockNumber,B,C),[MUSE_POOL],f.name+': the first fork won after all');f.store.verifyBlock(first.blockNumber,A,A);
  assert.deepEqual(placed(f.store),[`${first.blockNumber}:${A}`],f.name);assert.deepEqual(f.store.pendingBlocks(Math.floor(Date.now()/1000),10),[]);f.consistent();
 }
});
test('X2-1: an exact retry after finality restores a canonical row missing from storage in both adapters',t=>{
 for(const make of adapters(t)){
  const f=make(),d=delivery(),canonical=block(d,1,B,12);f.store.apply(canonical);f.store.verifyBlock(canonical.blockNumber,B,B);
  f.lose(canonical.trades[0].id);assert.deepEqual(placed(f.store),[]);// The state reproduced on the pre-fix code.
  assert.equal(f.store.apply(canonical).trades.length,1,f.name);assert.deepEqual(placed(f.store),[`${canonical.blockNumber}:${B}`]);assert.equal(f.store.apply(canonical).trades.length,0);f.consistent();
  assert.equal(f.store.apply(block(d,1,C,12)).trades.length,0,f.name+': a verified block still rejects another hash');
 }
});
test('X2b-1: restoring a surviving alternate counts toward the hard ceiling; rejection leaves rows, alternates and counts unchanged',t=>{
 for(const make of adapters(t,2))for(const fill of [2001,2000]){// Limit 2 gives a hard ceiling of 2,002 displayed rows.
  const f=make(),d=delivery(),orphan=block(d,0,A,10),canonical=block(d,1,B,12),label=`${f.name}/${fill}`;f.store.apply(orphan);f.store.apply(canonical);
  const fillers=(offset:number,count:number,first:number)=>{const b=block(d,offset,'0x'+(offset+16).toString(16).padStart(64,'0'),20+offset,false);return {...b,trades:Array.from({length:count},(_,n)=>{const hash='0x'+(first+n+1).toString(16).padStart(64,'0');return {...d.trades[0],id:`4663:${hash}:0`,hash,logIndex:0,blockNumber:b.blockNumber,blockHash:b.blockHash,at:new Date(b.timestamp*1000).toISOString()};})};};
  f.store.apply(fillers(10,2000,0));f.store.apply(fillers(11,fill-2000,2000));assert.equal(f.store.rows(MUSE_POOL).length,1+fill);
  const u='0x'+'ee'.repeat(32),replacement={...block(d,1,C,13),trades:[{...canonical.trades[0],id:`4663:${u}:0`,hash:u,logIndex:0,blockHash:C}]},before=f.dump();
  if(fill===2001){assert.throws(()=>f.store.apply(replacement),SwapCapacityError,label+': 2,002 - 1 + 1 new + 1 restored exceeds the ceiling');assert.deepEqual(f.dump(),before,label+': no observable mutation');}
  else{assert.deepEqual(f.store.apply(replacement).trades.map(r=>r.id),[`4663:${u}:0`]);assert.equal(f.store.rows(MUSE_POOL).length,2002,label+': exactly the ceiling');assert(placed(f.store).includes(`${orphan.blockNumber}:${A}`),label+': the alternate is restored');}
  f.consistent();
 }
});
test('X2-2: a quiet pool keeps freshly served on-chain history through the actual market hook, a refresh and Explore cards',async t=>{
 const store=new MemorySwapStore(),d=delivery(2*86400),last=new Date(d.timestamp*1000).toISOString();store.apply(d);
 const service=new SwapService(4663,store,{pools:async()=>pools}),unavailable=async()=>{throw new MarketUnavailable('synthetic provider outage','','Bankr');},served:Record<string,any>={};
 for(const section of ['summary','trades','candles'] as const){const r=JSON.parse(JSON.stringify(await service.serve(section,MUSE_POOL,unavailable)));assert.equal(r.source,'On-chain · Alchemy');assert(Math.abs(Date.now()-Date.parse(r.fetchedAt))<5000,section+': fetchedAt is response freshness');assert.equal(r.lastTradeAt,last,section+': the last trade time is its own field');served[section]=r;}
 const {MarketProvenance}=await import('../src/components/TokenMarket');assert.match(renderToStaticMarkup(MarketProvenance({label:'Candles',data:served.candles})),new RegExp(`Block <time dateTime="${last}"`));
 const provider={source:'Bankr',status:'fresh',fetchedAt:new Date(Date.now()-25*3600_000).toISOString(),priceUsd:1,fdvUsd:null,marketCapUsd:null,liquidityUsd:null,periods:{},candles:[],trades:[]};
 for(const section of ['summary','trades','candles']){
  let revision=0,reads=0,response:any=served[section],hook:any;const runtime=hookRuntime(()=>hook(syntheticToken({mode:'robinhood',deploymentChainId:4663}),'launch',section,revision));
  ({useMarket:hook}=await importFresh('src/components/TokenMarket.tsx',{react:{file:import.meta.resolve('react'),bindings:runtime.hooks},'../lib/api':{file:import.meta.resolve('../src/lib/api.ts'),bindings:{chainApi:async()=>{reads++;return response;}}}},['useMarket']));
  try{runtime.render();await settle();assert.equal(runtime.output().data?.lastTradeAt,last,section);assert.equal(runtime.output().error,'');
   response=JSON.parse(JSON.stringify(await service.serve(section as 'summary',MUSE_POOL,unavailable)));revision++;runtime.render();await settle();assert.equal(reads,2);assert.equal(runtime.output().data?.fetchedAt,response.fetchedAt,section+': refresh keeps the new response');
   response=provider;revision++;runtime.render();await settle();assert.equal(runtime.output().data,null,section+': a provider snapshot older than 24 h still expires');assert.match(runtime.output().error,/more than 24 hours old/);
  }finally{runtime.unmount();}
 }
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'visible'}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');});
 let refresh=0,reads=0,cards:any;const runtime=hookRuntime(()=>cards([],{mode:'robinhood',chainId:4663,deploymentChainId:4663,treasury:null,writesEnabled:false,blockReason:null},refresh));
 ({useTokenCardMarkets:cards}=await importFresh('src/lib/token-card-market.ts',{react:{file:import.meta.resolve('react'),bindings:runtime.hooks},'./api':{file:import.meta.resolve('../src/lib/api.ts'),bindings:{chainApi:async(chainId:number,route:string)=>{reads++;assert.equal(chainId,4663);assert.equal(route,'/musegod/market/summary');return JSON.parse(JSON.stringify(await service.serve('summary',MUSE_POOL,unavailable)));}}}}));
 try{runtime.render();await settle();await settle();const card=runtime.output()[MUSEGOD.token.toLowerCase()];assert.equal(card.data?.lastTradeAt,last,'Explore retains the quiet pool');refresh++;runtime.render();await settle();await settle();assert.equal(reads,2);assert.equal(runtime.output()[MUSEGOD.token.toLowerCase()].data?.lastTradeAt,last);}
 finally{runtime.unmount();}
});
// Synthetic own trades in the middle of a fixed hour; one per block, priced in WETH.
function clock(t:{mock:any}){const hour=Math.floor(Date.now()/3600_000)*3600-3600;t.mock.timers.enable({apis:['Date'],now:(hour+1800)*1000});return hour;}
function market(hour:number){
 const store=new MemorySwapStore(),template=delivery(0).trades[0],quote=(price:number|null)=>price===null?null:{price,source:'LI.FI' as const,at:new Date().toISOString()};let q=quote(2000),provider:CandleData|null=null,n=0;
 const service=new SwapService(4663,store,{pools:async()=>pools,quote:async()=>q,quoteCached:()=>q});
 const coverage=new Date((hour+60)*1000).toISOString();
 function trade(priceQuote='1',quoteAmount='1'):OnchainTrade{n++;const hash='0x'+n.toString(16).padStart(64,'0');return {...template,id:`4663:${hash}:0`,hash,logIndex:0,blockNumber:1000+n,blockHash:'0x'+(n+1).toString(16).padStart(64,'0'),at:new Date((hour+60+n)*1000).toISOString(),priceQuote,quoteAmount};}
 function store1(t:OnchainTrade){store.apply({webhookId:'wh_test_v3',kind:'v3',sequence:String(t.blockNumber),blockNumber:t.blockNumber,blockHash:t.blockHash,timestamp:Date.parse(t.at)/1000,trades:[t]});}
 const rest=async()=>JSON.parse(JSON.stringify(await service.serve('candles',MUSE_POOL,async()=>provider,'1h'))) as CandleData;
 function push(current:CandleData|null,t:OnchainTrade){store1(t);const priced=priceTrade(t,q),message:SwapMessage={type:'trades',chainId:4663,pool:MUSE_POOL,trades:[priced],reorg:false,blockNumber:t.blockNumber,blockHash:t.blockHash,coverageStart:coverage};return applySwapPush({summary:null,trades:null,candles:current},message,'1h').candles!;}
 return {hour,store,trade,store1,rest,push,setQuote:(price:number|null)=>{q=quote(price);},setProvider:(value:CandleData|null)=>{provider=value;}};
}
const bar=(time:number,price:number,volume:number)=>({time,open:price,high:price,low:price,close:price,volume});
test('X2-3: pushes and REST add own trades only after the provider\'s last returned bar, whatever the provider watermark',async t=>{
 const hour=clock(t);
 for(const shape of ['current provider bar','older provider bar','provider-only response'] as const){
  const m=market(hour),current=shape==='current provider bar',providerBars=[bar(m.hour-3600,9,99),...(current?[bar(m.hour,9,99)]:[])];
  m.setProvider({source:'Bankr',status:'fresh',fetchedAt:new Date().toISOString(),candles:providerBars,watermark:{blockNumber:shape==='provider-only response'?1_000_000_000:1001,logIndex:0,txHash:'0x'+'99'.repeat(32)}});
  if(shape!=='provider-only response')m.store1(m.trade('2','3'));
  const before=await m.rest(),projected=m.push(before,m.trade('4','5')),after=await m.rest();
  assert.deepEqual(projected.candles.slice(0,providerBars.length),current?providerBars:providerBars.slice(0,1),shape+': provider bars are never mutated');
  assert.deepEqual(projected.candles,after.candles,shape+': push projection follows the REST boundary');
  if(current)assert.deepEqual(projected.candles,providerBars);else assert.equal(projected.candles.at(-1)!.time,m.hour,shape+': the newer bucket gets the own bar');
 }
});
test('X2-4: one current USD quote converts the whole own portion; provider bars stay untouched through quote refresh, expiry and recovery',async t=>{
 const hour=clock(t);
 for(const withProvider of [false,true]){
  const m=market(hour),providerBar=bar(m.hour-3600,9,99),label=withProvider?'provider chart':'own chart';
  if(withProvider)m.setProvider({source:'Bankr',status:'fresh',fetchedAt:new Date().toISOString(),candles:[providerBar],watermark:null});
  m.store1(m.trade());let chart=await m.rest();assert.deepEqual(chart.candles.at(-1),bar(m.hour,2000,2000),label);
  m.setQuote(3000);chart=m.push(chart,m.trade());assert.deepEqual(chart.candles.at(-1),bar(m.hour,3000,6000),label+': a refreshed quote rescales earlier own trades');assert.equal(chart.quoteUsd?.price,3000);assert.deepEqual(chart.candles,(await m.rest()).candles);
  m.setQuote(null);chart=m.push(chart,m.trade());assert.deepEqual(chart.candles,withProvider?[providerBar]:[bar(m.hour,1,3)],label+': without a current quote');assert.equal(chart.unit,withProvider?'USD':'WETH');assert.deepEqual(chart.candles,(await m.rest()).candles);
  m.setQuote(4000);chart=m.push(chart,m.trade());assert.deepEqual(chart.candles,[...(withProvider?[providerBar]:[]),bar(m.hour,4000,16000)],label+': recovery converts every own trade, including those pushed during expiry');assert.deepEqual(chart.candles,(await m.rest()).candles);
 }
 const m=market(hour),first=m.trade(),second=m.trade();let sections=applySwapPush({summary:null,candles:null,trades:null},{type:'trades',chainId:4663,pool:MUSE_POOL,trades:[priceTrade(first,{price:2000,source:'LI.FI',at:new Date().toISOString()})],reorg:false,blockNumber:first.blockNumber,blockHash:first.blockHash,coverageStart:first.at},'1h');
 sections=applySwapPush(sections,{type:'trades',chainId:4663,pool:MUSE_POOL,trades:[priceTrade(second,{price:3000,source:'LI.FI',at:new Date().toISOString()})],reorg:false,blockNumber:second.blockNumber,blockHash:second.blockHash,coverageStart:first.at},'1h');
 assert.deepEqual(sections.trades!.trades.map(r=>[r.usd,r.price]),[[3000,3000],[3000,3000]],'Recent trades share the current quote too');
});
// Worker harness from Run 2c: the compiled actual fetch method with synthetic streams and storage.
function fixture(options:Partial<ConstructorParameters<typeof SwapService>[2]>={}){const store=new MemorySwapStore();store.set('notify-v3',{bindings:[{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const,key}]});return {store,swaps:new SwapService(4663,store,{pools:async()=>pools,...options})};}
function signed(){const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000);const raw=Buffer.from(JSON.stringify(body));return {raw,sig:createHmac('sha256',key).update(raw).digest('hex')};}
async function worker(swaps:any){const source=(await readFile('worker/index.ts','utf8')).split('\nexport default')[0].replace(/^import .*;\n/gm,'');const compiled=await transform(source,{loader:'ts',format:'cjs'}),module={exports:{} as any};new Function('module','exports','DurableObject','redact','isWebhookPath','readBoundedBody','requestBodyLimitForPath','BODY_READ_DEADLINE_MS',compiled.code)(module,module.exports,class{},()=> 'redacted',isWebhookPath,readBoundedBody,requestBodyLimitForPath,BODY_READ_DEADLINE_MS);const instance=Object.create(module.exports.LaunchpadRuntime.prototype);instance.refreshRuntime=()=>{};instance.swaps=swaps;instance.ctx={storage:{getAlarm:async()=>1,setAlarm:async()=>{}}};return instance;}
function slow(ip:string,length='1048576'){let reads=0,finish!:()=>void;const controller=new AbortController(),waiting=new Promise<{done:boolean}>(r=>finish=()=>r({done:true}));const body={getReader(){reads++;return {read:()=>waiting,cancel:async()=>{finish();}};}};const headers=new Headers({'x-forwarded-for':ip,'x-alchemy-signature':junk,'content-length':length});return {request:{url:'https://musegod.fun'+path,method:'POST',headers,body,signal:controller.signal} as unknown as Request,controller,finish:()=>finish(),get reads(){return reads;}};}
function valid(ip='198.51.100.1'){const {raw,sig}=signed();return new Request('https://musegod.fun'+path,{method:'POST',headers:{'x-forwarded-for':ip,'x-alchemy-signature':sig,'content-length':String(raw.length)},body:raw});}
test('C1d-1: repeated 10 s slow holds from four sources cannot keep the eight pre-read slots full',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const {swaps,store}=fixture(),instance=await worker(swaps),attack=()=>Array.from({length:8},(_,n)=>slow(`192.0.2.${Math.floor(n/2)+1}`));
 for(let round=0;round<3;round++){
  const first=attack(),pending=first.map(r=>instance.fetch(r.request));await flush();assert.equal(first.reduce((n,r)=>n+r.reads,0),8,`round ${round}: the attack fills the pool`);assert.equal((await instance.fetch(valid())).status,429);
  t.mock.timers.tick(BODY_READ_DEADLINE_MS);await flush();assert((await Promise.all(pending)).every((r:Response)=>r.status===408));
  const second=attack(),again=second.map(r=>instance.fetch(r.request));await flush();assert.equal(second.reduce((n,r)=>n+r.reads,0),0,`round ${round}: a full hold costs 60, so two block the source before reading`);assert((await Promise.all(again)).every((r:Response)=>r.status===429));
  assert.equal((await instance.fetch(valid())).status,200,`round ${round}: valid deliveries proceed for the rest of the minute`);t.mock.timers.tick(60_001);
 }
 assert.equal(store.rows(MUSE_POOL).length,1);
});
test('C1d-1: fast transport failures cost 5 and never block a valid same-source delivery; held failures cost in proportion',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const {swaps}=fixture(),instance=await worker(swaps);
 for(const [ip,mode] of [['203.0.113.21','abort'],['203.0.113.22','short'],['203.0.113.23','long'],['203.0.113.24','error']] as const){
  for(let n=0;n<2;n++){
   if(mode==='abort'){const r=slow(ip),p=instance.fetch(r.request);await flush();r.controller.abort();assert.equal((await p).status,408);}
   else if(mode==='error'){const r=slow(ip);r.request.body!.getReader=()=>({read:async()=>{throw Error('synthetic connection reset');},cancel:async()=>{}}) as any;await assert.rejects(instance.fetch(r.request),/synthetic connection reset/);}
   else assert.equal((await instance.fetch(new Request('https://musegod.fun'+path,{method:'POST',headers:{'x-forwarded-for':ip,'x-alchemy-signature':junk,'content-length':'100'},body:'x'.repeat(mode==='short'?10:200)}))).status,mode==='short'?400:413);
  }
  assert.equal((await instance.fetch(valid(ip))).status,200,mode+': two immediate failures then a valid delivery from the same source');
 }
 const short=(ip:string)=>instance.fetch(new Request('https://musegod.fun'+path,{method:'POST',headers:{'x-forwarded-for':ip,'x-alchemy-signature':junk,'content-length':'100'},body:'x'}));
 for(let n=0;n<23;n++)assert.equal((await short('203.0.113.25')).status,400);assert.equal((await instance.fetch(valid('203.0.113.25'))).status,200,'23 fast failures stay below 120');
 assert.equal((await short('203.0.113.25')).status,400);assert.equal((await instance.fetch(valid('203.0.113.25'))).status,429,'the 24th reaches the budget');
 for(let n=0;n<4;n++){const r=slow('203.0.113.26'),p=instance.fetch(r.request);await flush();t.mock.timers.tick(5_000);r.controller.abort();assert.equal((await p).status,408);}
 const fifth=slow('203.0.113.26'),p=instance.fetch(fifth.request);await flush();assert.equal(fifth.reads,0,'four 5 s holds cost 30 each');fifth.finish();assert.equal((await p).status,429);
});
test('C1d-1: Alchemy\'s documented sender IPs skip only the read-failure charge; HMAC and slot caps still apply',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const {swaps}=fixture(),instance=await worker(swaps);
 for(const ip of ['54.236.136.17','34.237.24.169','198.51.100.77']){const alchemy=ip!=='198.51.100.77';
  const held=[slow(ip),slow(ip)],pending=held.map(r=>instance.fetch(r.request));await flush();
  const third=slow(ip),capped=instance.fetch(third.request);await flush();assert.equal(third.reads,0,ip+': per-source slot cap still applies');assert.equal((await capped).status,429);
  t.mock.timers.tick(BODY_READ_DEADLINE_MS);await flush();assert((await Promise.all(pending)).every((r:Response)=>r.status===408));
  assert.equal((await instance.fetch(valid(ip))).status,alchemy?200:429,ip+(alchemy?': exempt from the read-failure charge':': control source is charged'));
  if(alchemy){const forged=valid(ip);forged.headers.set('x-alchemy-signature',junk);assert.equal((await instance.fetch(forged)).status,401,ip+': still needs a valid HMAC');}
  t.mock.timers.tick(60_001);
 }
});
test('C1d-1: the Node route charges full holds, lets fast aborts recover and exempts Alchemy sender IPs',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'swap-run4-')),{app,service}=createApp(undefined,'loopback',runtimeFromEnv(4663,{NODE_ENV:'test',CHAIN_MODE:'fork',FORK_CHAIN_ID:'4663',DATA_DIR:directory}),{swapStore:fixture().store}),seen:IncomingMessage[]=[];
 const server=createServer((req,res)=>{seen.push(req);app(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const clients:ClientRequest[]=[],timers:(()=>void)[]=[],realTimeout=setTimeout;let shift=0;const realNow=Date.now.bind(Date);
 t.mock.method(Date,'now',()=>realNow()+shift);t.mock.method(globalThis,'setTimeout',((fn:any,ms:number,...args:any[])=>{if(ms===BODY_READ_DEADLINE_MS){timers.push(fn);return realTimeout(fn,60_000,...args);}return realTimeout(fn,ms,...args);}) as typeof setTimeout);
 function post(from?:string){const req=httpRequest({hostname:'127.0.0.1',port:(address as any).port,path,method:'POST',headers:{'x-alchemy-signature':junk,'content-length':'1048576',...(from?{'x-forwarded-for':from}:{})}});clients.push(req);req.on('error',()=>{});const response=new Promise<number>(r=>req.once('response',res=>{res.resume();r(res.statusCode!);}));req.write('{');return {req,response};}
 const signedPost=(from?:string)=>{const {raw,sig}=signed();return fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST',headers:{'x-alchemy-signature':sig,...(from?{'x-forwarded-for':from}:{})},body:raw}).then(r=>r.status);};
 const turn=()=>new Promise<void>(r=>setImmediate(r));async function waitFor(n:number){for(let i=0;i<200&&seen.length<n;i++)await turn();assert.equal(seen.length,n);}
 async function hold(from?:string){const count=seen.length,pair=[post(from),post(from)];await waitFor(count+2);shift+=BODY_READ_DEADLINE_MS;timers.splice(0).slice(-2).forEach(fn=>fn());assert.deepEqual(await Promise.all(pair.map(p=>p.response)),[408,408]);}
 try{await hold();const third=post(),count=seen.length;await waitFor(count+1);assert.equal(seen.at(-1)!.listenerCount('data'),0,'two full holds block before reading');assert.equal(await third.response,429);shift+=60_001;
  for(let n=0;n<2;n++){const count=seen.length,r=post();await waitFor(count+1);r.req.destroy();for(let i=0;i<20;i++)await turn();}
  assert.equal(await signedPost(),200,'two immediate aborts then a valid delivery from the same source');
  await hold('54.236.136.17');assert.equal(await signedPost('54.236.136.17'),200,'Alchemy sender IP is exempt from the read-failure charge');
 }finally{clients.forEach(r=>r.destroy());server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await service.store.close();rmSync(directory,{recursive:true,force:true});}
});
function notify(reached:boolean,createDelay:number){
 const store=new MemorySwapStore(),hooks:any[]=[];let creates=0,peak=0;
 const api=new NotifyClient('synthetic',async(input,init)=>{const method=init?.method??'GET';
  if(method==='POST'){creates++;const hook={...JSON.parse(String(init!.body)),webhook_url:url+'?kind=v3',id:'created-'+creates,is_active:true,signing_key:key};if(reached){hooks.push(hook);peak=Math.max(peak,hooks.length);}await new Promise(r=>setTimeout(r,createDelay));return Response.json({data:hook});}
  if(method==='DELETE'){const i=hooks.findIndex(h=>h.id===new URL(String(input)).searchParams.get('webhook_id'));if(i>=0)hooks.splice(i,1);return Response.json({});}
  return Response.json({data:hooks});});
 return {store,hooks,api,get creates(){return creates;},get peak(){return peak;}};
}
async function run(t:{mock:any},work:Promise<unknown>,seconds:number){let settled=false;void work.then(()=>settled=true,()=>settled=true);for(let n=0;n<seconds*2&&!settled;n++){t.mock.timers.tick(500);await flush();}return work;}
test('C1d-2: create has a 15 s deadline inside a 30 s reconcile budget while list and delete keep 2 s',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 const f=notify(true,5_000);await run(t,reconcileWebhook(f.store,f.api,4663,pools,url,1000),10);assert.equal(f.store.get<any>('notify-v3').bindings[0].id,'created-1','a 5 s create binds without a retry');assert.equal(f.creates,1);
 const hanging=notify(false,60_000);let rejected=false;const pending=hanging.api.create(desiredWebhook(4663,pools,url,'v3')).catch(()=>{rejected=true;});t.mock.timers.tick(14_999);await flush();assert.equal(rejected,false);t.mock.timers.tick(1);await flush();assert.equal(rejected,true,'create is bounded at 15 s');await pending;
 const list=new NotifyClient('synthetic',()=>new Promise<Response>(()=>{}));let listed=false;const listing=list.list().catch(()=>{listed=true;});t.mock.timers.tick(2_000);await flush();assert.equal(listed,true,'list keeps its 2 s deadline');await listing;
 const desired=desiredWebhook(4663,pools,url,'v3'),orphans=Array.from({length:30},(_,n)=>({...desired,id:'orphan-'+n,is_active:true,signing_key:key})),calls:string[]=[];
 t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{calls.push(init?.method??'GET');await new Promise<void>(r=>setTimeout(r,1_500));return Response.json({data:orphans});});
 const {swaps,store}=fixture({token:'synthetic'}),started=Date.now();let done=false;const reconcile=swaps.reconcile('https://musegod.fun').catch(()=>{}).then(()=>{done=true;});
 for(let n=0;n<59;n++){t.mock.timers.tick(500);await flush();}assert.equal(done,false,'the reconcile budget is 30 s');t.mock.timers.tick(500);await flush();assert.equal(done,true);await reconcile;assert.equal(Date.now()-started,30_000);assert(!calls.includes('POST'));assert(store.get<any>('notify-attempt-v3').failures>0);
});
test('C1d-2: a timed-out creation is resolved by the orphan sweep instead of counting toward the creation stop',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const reached of [true,false]){// The timed-out request did or did not create the hook at Alchemy.
  const f=notify(reached,60_000);let now=1000;
  for(let n=0;n<8;n++){await assert.rejects(run(t,reconcileWebhook(f.store,f.api,4663,pools,url,now),20));now=f.store.get<any>('notify-attempt-v3').nextAt;}
  const attempt=f.store.get<any>('notify-attempt-v3'),status=new SwapService(4663,f.store,{pools:async()=>pools}).status();
  if(reached){assert.equal(f.creates,8,'slow successful creations never stop creation');assert.equal(attempt.creationFailures,0);assert.equal(status.kinds.v3.creationStopped,false);assert.equal(f.peak,1,'the sweep leaves at most one uncertain hook');}
  else{assert.equal(f.creates,5,'unreached creations still stop after five');assert.equal(attempt.creationFailures,5);assert.equal(status.kinds.v3.creationStopped,true);}
 }
});
