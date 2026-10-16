import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {readFile} from 'node:fs/promises';import {transform} from 'esbuild';
import {MemorySwapStore,SqlSwapStore} from '../server/swap-store';import {SwapService} from '../server/swap-service';import {NotifyClient,desiredWebhook,reconcileWebhook,webhookDiff} from '../server/alchemy-webhooks';import {decodeDelivery,registeredPools,MUSE_POOL} from '../server/swap-stream';import {mergeCandles} from '../src/lib/swap-market';import fixtures from './fixtures/alchemy-swaps.json';
const pools=registeredPools(4663,[]),url='https://musegod.fun/api/chains/4663/webhooks/alchemy',key='run2b-synthetic-key';
function delivery(){const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000)-180;return decodeDelivery(JSON.stringify(body),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET'},pools);}
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
test('C1b-1: actual Worker alarm finishes launch cleanup/reconcile before isolated swap failure',async()=>{
 const source=(await readFile('worker/index.ts','utf8')).split('\nexport default')[0].replace(/^import .*;\n/gm,'');const compiled=await transform(source,{loader:'ts',format:'cjs'});const module={exports:{} as any};new Function('module','exports','DurableObject','redact',compiled.code)(module,module.exports,class{},()=> 'redacted');
 for(const failure of ['throw','hang']){const calls:string[]=[],instance=Object.create(module.exports.LaunchpadRuntime.prototype);let finish!:()=>void;
  instance.refreshRuntime=()=>{};instance.ctx={storage:{setAlarm:async()=>calls.push('alarm')}};instance.service={runtime:{environment:{}},store:{cleanup:async()=>calls.push('cleanup')},reconcile:async()=>calls.push('launch')};instance.swaps={reconcile:async()=>{},maintain:async()=>{calls.push('swaps');if(failure==='throw')throw Error('synthetic');await new Promise<void>(r=>finish=r);}};
  const pending=instance.alarm();await flush();if(failure==='hang'){assert.deepEqual(calls,['cleanup','launch','swaps']);finish();}await pending;assert.deepEqual(calls,['cleanup','launch','swaps','alarm']);
 }
});
test('C1b-1: hanging block verifications abort per call, stop at the alarm budget and leave work pending',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const store=new MemorySwapStore(),d=delivery();for(let n=0;n<12;n++)store.apply({...d,blockNumber:n+1,trades:[{...d.trades[0],id:'row'+n,blockNumber:n+1}]});const signals:AbortSignal[]=[];
 const service=new SwapService(4663,store,{pools:async()=>pools,blockHash:async(_block:number,signal:AbortSignal)=>{signals.push(signal);return new Promise<string>(()=>{});}});let done=false;const pending=service.maintain().then(()=>done=true);await flush();for(let n=0;n<5;n++){t.mock.timers.tick(2000);await flush();}
 assert(done,'maintenance must return within 10 seconds even if RPC ignores cancellation');await pending;assert.equal(signals.length,5);assert(signals.every(s=>s.aborted));assert.equal(store.pendingBlocks(Math.floor(Date.now()/1000),20).length,12);
 const retry=new SwapService(4663,store,{pools:async()=>pools,blockHash:async()=>d.blockHash});await retry.maintain();assert.equal(store.pendingBlocks(Math.floor(Date.now()/1000),20).length,2);
});
function notifyFixture(mode:'inactive'|'normalised'|'invalid-response'|'delete-fails'='inactive'){
 const store=new MemorySwapStore(),hooks:any[]=[],calls:string[]=[];let creates=0,peak=0;
 const api=new NotifyClient('synthetic',async(input,init)=>{const u=new URL(String(input));calls.push(init?.method??'GET');
  if(init?.method==='POST'){const h={...JSON.parse(String(init.body)),webhook_url:url,id:'created-'+(++creates),is_active:mode==='normalised',signing_key:key};hooks.push(h);peak=Math.max(peak,hooks.length);return Response.json({data:mode==='invalid-response'?{id:h.id}:h});}
  if(init?.method==='DELETE'){if(mode==='delete-fails')throw Error('synthetic delete failure');const i=hooks.findIndex(h=>h.id===u.searchParams.get('webhook_id'));if(i>=0)hooks.splice(i,1);return Response.json({});}
  return Response.json({data:hooks});
 });return {store,hooks,calls,api,get creates(){return creates;},get peak(){return peak;}};
}
for(const mode of ['inactive','invalid-response'] as const)test(`C1b-2: ${mode} creations are recorded before verification, cleaned and stop after five across restarts`,async()=>{
 const f=notifyFixture(mode);let now=1000;
 for(let n=0;n<12;n++){await assert.rejects(reconcileWebhook(f.store,f.api,4663,pools,url,now));const attempt=f.store.get<any>('notify-attempt');assert(f.hooks.length<=1);if(n>=4)assert.equal(attempt.nextAt-now,3600000);now=attempt.nextAt;}
 assert.equal(f.creates,5);assert.equal(f.peak,1);assert.equal(f.hooks.length,0);const a=f.store.get<any>('notify-attempt');assert.equal(a.nextAt-now,0);assert.equal(a.creationFailures,5);
 const status=new SwapService(4663,f.store,{pools:async()=>pools}).status();assert.equal(status.creationStopped,true);assert.equal(status.creationFailures,5);assert(!JSON.stringify(status).includes(key));
 const changed=[...pools,{...pools[0],version:4 as const,pool:'0x'+'ab'.repeat(32)}];await assert.rejects(reconcileWebhook(f.store,f.api,4663,changed,url,now));assert.equal(f.creates,6);
});
test('C1b-2: callback query normalisation succeeds, stored id verifies daily without another creation',async()=>{
 const f=notifyFixture('normalised');await reconcileWebhook(f.store,f.api,4663,pools,url,1000);assert.equal(f.store.get<any>('notify').bindings[0].id,'created-1');await reconcileWebhook(f.store,f.api,4663,pools,url,86401001);assert.equal(f.creates,1);assert.equal(webhookDiff(f.hooks,desiredWebhook(4663,pools,url)).action,'verify-runtime-binding');assert.equal(webhookDiff(f.hooks,desiredWebhook(4663,pools,url),'created-1').action,'keep');
});
test('C1b-2: failed deletion prevents another creation; only exact callback orphans are swept before create',async()=>{
 const f=notifyFixture('delete-fails');await assert.rejects(reconcileWebhook(f.store,f.api,4663,pools,url,1000));await assert.rejects(reconcileWebhook(f.store,f.api,4663,pools,url,61000));assert.equal(f.creates,1);assert.equal(f.peak,1);
 const other=notifyFixture('normalised'),d=desiredWebhook(4663,pools,url);other.hooks.push({...d,id:'orphan',is_active:true,signing_key:key},{...d,id:'other-chain',webhook_url:'https://musegod.fun/api/chains/8453/webhooks/alchemy',is_active:true,signing_key:key},{...d,id:'other-origin',webhook_url:'https://other.invalid/api/chains/4663/webhooks/alchemy',is_active:true,signing_key:key});await reconcileWebhook(other.store,other.api,4663,pools,url,1000);assert(other.calls.indexOf('DELETE')<other.calls.indexOf('POST'));assert.deepEqual(other.hooks.map(h=>h.id).sort(),['created-1','other-chain','other-origin']);
});
test('C1b-2: daily verification of a stored binding clears the creation stop without creating',async()=>{
 const f=notifyFixture('normalised'),desired=desiredWebhook(4663,pools,url);f.store.set('notify',{hash:desired.hash,checkedAt:0,bindings:[{id:'known',network:desired.network,key}]});f.store.set('notify-attempt',{hash:desired.hash,failures:5,creationFailures:5,nextAt:3600000,verifyAt:86400000});f.hooks.push({...desired,id:'known',webhook_url:url,is_active:true,signing_key:key});await reconcileWebhook(f.store,f.api,4663,pools,url,86400001);assert.equal(f.creates,0);assert.equal(f.store.get<any>('notify-attempt').creationFailures,0);
});
test('C1b-3: 1d requests over 40k rows read only the current provider bucket or at most 200 SQL aggregates',async()=>{
 const db=new DatabaseSync(':memory:');let read=0;const sql={exec(q:string,...a:any[]){const rows=db.prepare(q).all(...a);if(/^SELECT|^WITH/i.test(q)&&/swap_trades/.test(q))read+=rows.length;return rows;}};const store=new SqlSwapStore(sql,fn=>fn()),d=delivery(),t=d.trades[0],today=Math.floor(Date.now()/86400000)*86400,start=today-199*86400,all:any[]=[];
 try{const insert=db.prepare('INSERT INTO swap_trades (id,pool,block,hash,at,payload,log_index) VALUES (?,?,?,?,?,?,?)');db.exec('BEGIN');for(let n=0;n<40000;n++){const day=Math.floor(n/200),at=start+day*86400+n%200;const row={...t,id:'row'+n,blockNumber:n+1,logIndex:n%200,at:new Date(at*1000).toISOString(),priceQuote:String(1+n%7),quoteAmount:String(1+n%3)};all.push(row);insert.run(row.id,row.pool,row.blockNumber,row.blockHash,at,JSON.stringify(row),row.logIndex);}db.exec('COMMIT');store.set('coverage:'+MUSE_POOL,new Date(start*1000).toISOString());
 const q={price:2,source:'LI.FI' as const,at:new Date().toISOString()},service=new SwapService(4663,store,{pools:async()=>pools,quote:async()=>q}),bar={time:today-86400,open:9,high:9,low:9,close:9,volume:99};read=0;const withProvider=await service.serve('candles',MUSE_POOL,async()=>({source:'Bankr',fetchedAt:t.at,candles:[bar]}),'1d');assert(read<=200,`provider chart read ${read} rows`);assert.equal(withProvider.candles[0].volume,99);
 read=0;const own=await service.serve('candles',MUSE_POOL,async()=>null,'1d');assert(read<=200,`own chart read ${read} rows instead of SQL buckets`);const expected=mergeCandles(null,all.map(row=>({...row,priceUsd:Number(row.priceQuote)*2,usd:Number(row.quoteAmount)*2,quoteUsd:q})),store.coverage(MUSE_POOL)!,'1d');assert.deepEqual(own.candles,expected.candles);assert.deepEqual(own.watermark,expected.watermark);assert.equal(own.unit,'USD');
 // Aggregation reads live rows, so removing an orphan immediately removes its OHLCV contribution.
 db.prepare('DELETE FROM swap_trades WHERE block>=?').run(39801);read=0;const after=await service.serve('candles',MUSE_POOL,async()=>null,'1d');assert.equal(after.candles.length,199);assert(read<=199);
 }finally{db.close();}
});
test('C1b-4: a saturated unverified source still passes 600 authenticated deliveries and eight processing slots',async()=>{
 const store=new MemorySwapStore();store.set('notify',{bindings:[{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',key}]});let release!:()=>void;const gate=new Promise<void>(r=>release=r),service=new SwapService(4663,store,{pools:async()=>{await gate;return pools;}});const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000);const raw=Buffer.from(JSON.stringify(body)),sig=createHmac('sha256',key).update(raw).digest('hex'),ip='203.0.113.10';
 for(let n=0;n<121;n++)service.admitWebhook(ip,undefined);const accepted=[];for(let n=0;n<8;n++){const admission=service.admitWebhook(ip,sig);assert.equal(admission.status,0);accepted.push(service.ingest(raw,sig,ip));}
 assert.equal((await service.ingest(raw,sig,ip)).status,429);release();assert((await Promise.all(accepted)).every(r=>r.status===200));
 for(let n=8;n<600;n++){assert.equal(service.admitWebhook(ip,sig).status,0);assert.equal((await service.ingest(raw,sig,ip)).status,200);}assert.equal((await service.ingest(raw,sig,ip)).status,429);
});
test('C1b-4: syntactically valid failed HMACs spend only their source bucket',async()=>{
 const service=new SwapService(4663,new MemorySwapStore(),{pools:async()=>pools});for(let n=0;n<121;n++){const admission=service.admitWebhook('192.0.2.1','f'.repeat(64));assert.equal(admission.status,0);const r=await service.ingest(Buffer.from('{'),'f'.repeat(64),'192.0.2.1');assert.equal(r.status,n<120?401:429);}assert.equal(service.admitWebhook('192.0.2.2',undefined).status,401);
});
