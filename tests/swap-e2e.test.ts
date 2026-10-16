import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {createHmac} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app';import {runtimeFromEnv} from '../server/config';import {SqlSwapStore} from '../server/swap-store';import {attachSwapSockets} from '../server/swap-node';import {MUSE_POOL,NETWORKS} from '../server/swap-stream';import {MusegodMarketReader} from '../server/musegod-market';import {FirstBuyPaymentReader} from '../server/lifi';import {MarketUnavailable} from '../server/snapshots';import fixtures from './fixtures/alchemy-swaps.json';
import {securityHeaders,requestBodyLimitForPath} from '../server/http-security';
const key='test-only-hmac-key';
export function syntheticDelivery(){const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000);return body;}
test('signed real-log delivery → SQLite → REST merge → actual Node WebSocket; rejected deliveries leave no rows',async t=>{
 const db=new DatabaseSync(':memory:'),sql={exec(query:string,...args:any[]){return db.prepare(query).all(...args);}},store=new SqlSwapStore(sql,fn=>{db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}});
 store.set('notify',{hash:'fixture',checkedAt:Date.now(),bindings:[{id:'wh_test_v3',network:NETWORKS[4663],key}]});
 const unavailable=async()=>{throw new MarketUnavailable('Fixture unavailable','', 'Bankr');};
 const originals=[MusegodMarketReader.prototype.summary,MusegodMarketReader.prototype.trades,MusegodMarketReader.prototype.candles,FirstBuyPaymentReader.prototype.prices];
 MusegodMarketReader.prototype.summary=unavailable;MusegodMarketReader.prototype.trades=unavailable;MusegodMarketReader.prototype.candles=unavailable;
 FirstBuyPaymentReader.prototype.prices=async()=>({chainId:4663,quotedAt:Date.now(),expiresAt:Date.now()+60000,referenceOnly:true,assets:[]});
 t.after(()=>{[MusegodMarketReader.prototype.summary,MusegodMarketReader.prototype.trades,MusegodMarketReader.prototype.candles,FirstBuyPaymentReader.prototype.prices]=originals as any;});
 const directory=mkdtempSync(join(tmpdir(),'swap-e2e-'));const runtime=runtimeFromEnv(4663,{NODE_ENV:'test',CHAIN_MODE:'fork',FORK_CHAIN_ID:'4663',DATA_DIR:directory});const {app,service,swaps}=createApp(undefined,'loopback',runtime,{swapStore:store});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`,stop=attachSwapSockets(server,new Map([[4663,swaps]]));
 t.after(async()=>{stop();await new Promise<void>(r=>server.close(()=>r()));await service.store.close();db.close();rmSync(directory,{recursive:true,force:true});});
 const ws=new WebSocket(origin.replace('http:','ws:')+`/api/chains/4663/market/stream?pool=${MUSE_POOL}`);await once(ws,'open');
 const raw=JSON.stringify(syntheticDelivery()),signature=createHmac('sha256',key).update(raw).digest('hex');
 const post=(sig?:string,body=raw)=>fetch(origin+'/api/webhooks/alchemy',{method:'POST',headers:{'content-type':'application/json',origin:'https://alchemy.com',...(sig?{'x-alchemy-signature':sig}:{})},body});
 assert.equal((await post()).status,401);assert.equal((await post('f'.repeat(64))).status,401);assert.equal(store.rows(MUSE_POOL).length,0);
 const push=once(ws,'message');assert.equal((await post(signature)).status,200);const [event]=await push;const message=JSON.parse((event as MessageEvent).data);assert.equal(message.trades.length,1);assert.equal(message.trades[0].hash,fixtures.v3[0].transactionHash);
 for(const section of ['trades','summary','candles']){const r=await fetch(origin+`/api/musegod/market/${section}`);assert.equal(r.status,200);const data=await r.json();assert.equal(data.source,'On-chain · Alchemy');if(section==='trades')assert.equal(data.trades[0].id,message.trades[0].id);if(section==='summary')assert.equal(data.priceUsd,null);if(section==='candles')assert.equal(data.unit,'WETH');}
 assert.equal((await post(signature)).status,200);assert.equal(store.rows(MUSE_POOL).length,1);assert.equal((await post(signature,'x'.repeat(1_048_577))).status,413);ws.close();
});
test('CSP permits only same-origin stream and Alchemy body bound applies only to exact receiver',()=>{
 const csp=securityHeaders(true)['Content-Security-Policy'];assert.equal(csp.split(';').find(x=>x.trim().startsWith('connect-src'))?.trim(),"connect-src 'self' https://challenges.cloudflare.com");assert(!csp.includes('api.bankr.bot'));
 assert.equal(requestBodyLimitForPath('/api/chains/4663/webhooks/alchemy'),1_048_576);assert.equal(requestBodyLimitForPath('/api/chains/4663/webhooks/alchemy/no'),65_536);
});

test('SQLite and memory agree on block reorgs, empty replacements, stale retries and age retention',async()=>{
 const {decodeDelivery,registeredPools}=await import('../server/swap-stream'),{MemorySwapStore}=await import('../server/swap-store');
 const db=new DatabaseSync(':memory:'),sql={exec(q:string,...a:any[]){return db.prepare(q).all(...a);}},sqlite=new SqlSwapStore(sql,fn=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}),memory=new MemorySwapStore();
 try{const first=decodeDelivery(JSON.stringify(syntheticDelivery()),{id:'wh_test_v3',network:NETWORKS[4663]},registeredPools(4663,[]));const empty={...first,sequence:String(BigInt(first.sequence)+1n),blockHash:'0x'+'ab'.repeat(32),trades:[]};
 for(const store of [sqlite,memory]){store.apply(first);assert.equal(store.apply(empty).reorg,true);assert.equal(store.rows(MUSE_POOL).length,0);store.apply(first);assert.equal(store.rows(MUSE_POOL).length,0);store.apply({...first,blockNumber:1,timestamp:1});assert.equal(store.rows(MUSE_POOL).length,0);}
 assert.deepEqual(sqlite.rows(MUSE_POOL),memory.rows(MUSE_POOL));
 }finally{db.close();}
});

test('Base binding is isolated; verified fresh quote enriches USD, stale quote stays unavailable; receiver admission is bounded',async()=>{
 const {SwapService}=await import('../server/swap-service'),{MemorySwapStore}=await import('../server/swap-store');
 const pool={chainId:8453 as const,version:4 as const,pool:fixtures.v4[0].topics[1],token:'0x0379e228f6887c6f18bf394042ecaf81b308cb2e',quote:'0x0bd7d308f8e1639fab988df18a8011f41eacad73',tokenDecimals:18,quoteDecimals:18,quoteSymbol:'WETH'};
 // Synthetic Base identity around a real V4 control log tests isolation; this is not a Base receipt claim.
 const body=structuredClone(fixtures.deliveries.v4);body.event.data.block.timestamp=Math.floor(Date.now()/1000);body.event.data.block.logs.forEach(log=>log.account.address='0x498581ff718922c3f8e6a244956af099b2652b2b');const raw=Buffer.from(JSON.stringify(body)),sig=createHmac('sha256',key).update(raw).digest('hex');
 for(const fresh of [true,false]){const store=new MemorySwapStore();store.set('notify',{bindings:[{id:'wh_test_v4',network:'BASE_MAINNET',key}]});const service=new SwapService(8453,store,{pools:async()=>[pool],quote:async()=>({price:2000,source:'LI.FI',at:fresh?new Date().toISOString():new Date(0).toISOString()})});assert.equal((await service.ingest(raw,sig)).status,200);const row=store.rows(pool.pool)[0];assert(row);assert.equal(row.chainId,8453);assert.equal(row.priceUsd!==null,fresh);assert.equal(fresh?row.quoteUsd?.source:row.quoteUsd,fresh?'LI.FI':null);}
 const service=new SwapService(8453,new MemorySwapStore(),{pools:async()=>[pool]});const leases=Array.from({length:8},()=>service.admitWebhook());assert(leases.every(x=>x.status===0));assert.equal(service.admitWebhook().status,429);leases.forEach(x=>x.release());assert.equal(service.admitWebhook().status,0);
 const limited=new SwapService(8453,new MemorySwapStore(),{pools:async()=>[pool]});for(let n=0;n<=600;n++){const lease=limited.admitWebhook();assert.equal(lease.status,n<600?0:429);lease.release();}
});

test('large verified blocks broadcast bounded batches without dropping any trade',async()=>{
 const {SwapService}=await import('../server/swap-service'),{MemorySwapStore}=await import('../server/swap-store'),{registeredPools}=await import('../server/swap-stream'),{parseSwapMessage}=await import('../src/lib/swap-stream');
 const body=syntheticDelivery(),original=body.event.data.block.logs[0];body.event.data.block.logs=Array.from({length:500},(_,index)=>({...original,index}));const raw=Buffer.from(JSON.stringify(body)),sig=createHmac('sha256',key).update(raw).digest('hex'),store=new MemorySwapStore();store.set('notify',{bindings:[{id:'wh_test_v3',network:NETWORKS[4663],key}]});const messages:any[]=[];
 const service=new SwapService(4663,store,{pools:async()=>registeredPools(4663,[]),broadcast:m=>messages.push(m)});assert.equal((await service.ingest(raw,sig)).status,200);assert.deepEqual(messages.map(m=>m.trades.length),[200,200,100]);assert.equal(store.rows(MUSE_POOL).length,500);assert(messages.every(m=>parseSwapMessage(JSON.stringify(m),4663,MUSE_POOL)));
});
