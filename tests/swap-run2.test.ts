import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHmac} from 'node:crypto';
import {MemorySwapStore,SqlSwapStore} from '../server/swap-store';import {SwapService} from '../server/swap-service';import {NotifyClient,desiredWebhook,reconcileWebhook} from '../server/alchemy-webhooks';import {decodeDelivery,registeredPools,MUSE_POOL} from '../server/swap-stream';import {mergeTrades,mergeCandles,mergeSummary} from '../src/lib/swap-market';import fixtures from './fixtures/alchemy-swaps.json';
const pools=registeredPools(4663,[]),url='https://musegod.fun/api/chains/4663/webhooks/alchemy',key='run2-test-key';
const delivery=()=>{const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000)-180;return decodeDelivery(JSON.stringify(body),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET'},pools);};
const hook=(desired:any,id='current')=>({...desired,id,is_active:true,signing_key:key});
test('C1-1: large SQLite table reads latest 1/30 and candle range only; ingestion never prunes',async()=>{
 const db=new DatabaseSync(':memory:');let returned=0;const queries:string[]=[];const sql={exec(q:string,...a:any[]){queries.push(q);const rows=db.prepare(q).all(...a);if(q.startsWith('SELECT payload'))returned+=rows.length;return rows;}};const store=new SqlSwapStore(sql,fn=>fn()),d=delivery(),t=d.trades[0];
 try{store.set('coverage:'+MUSE_POOL,new Date((d.timestamp-12000)*1000).toISOString());const insert=db.prepare('INSERT INTO swap_trades (id,pool,block,hash,at,payload) VALUES (?,?,?,?,?,?)');for(let n=0;n<12000;n++){const row={...t,id:'row'+n,blockNumber:n+1,at:new Date((d.timestamp-12000+n)*1000).toISOString()};insert.run(row.id,row.pool,row.blockNumber,row.blockHash,Date.parse(row.at)/1000,JSON.stringify(row));}
 const service=new SwapService(4663,store,{pools:async()=>pools});returned=0;await service.serve('summary',MUSE_POOL,async()=>null);assert.equal(returned,1);
 returned=0;await service.serve('trades',MUSE_POOL,async()=>null);assert.equal(returned,30);
 returned=0;const before=d.timestamp-11990;await service.serve('candles',MUSE_POOL,async()=>null,'1m',before);assert(returned<=10,`read ${returned} rows outside candle range`);
 const plan=db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM swap_trades WHERE pool=? AND at>=? AND at<? ORDER BY at,block,log_index').all(MUSE_POOL,0,1);assert(plan.some(r=>String(r.detail).includes('INDEX swap_pool_time')));
 queries.length=0;store.apply({...d,blockNumber:20000,trades:[{...t,id:'new',blockNumber:20000}]});assert(!queries.some(q=>/OFFSET|DELETE FROM swap_trades WHERE at/.test(q)));
 }finally{db.close();}
});
test('C1-4: failure backs off exponentially, pool changes reset, success clears failures',async()=>{
 const store=new MemorySwapStore();let calls=0,fail=true;const api=new NotifyClient('test',async(_u,init)=>{calls++;if(fail)throw Error('timeout');return Response.json({data:init?.method==='POST'?hook(desiredWebhook(4663,pools,url)):[]});});
 await assert.rejects(reconcileWebhook(store,api,4663,pools,url,1000));await assert.rejects(reconcileWebhook(store,api,4663,pools,url,2000));assert.equal(calls,1);
 fail=false;await reconcileWebhook(store,api,4663,pools,url,61000);assert.equal(calls,3);assert.equal(store.get<any>('notify-attempt').failures,0);
 fail=true;const changed=[...pools,{...pools[0],version:4 as const,pool:'0x'+'ab'.repeat(32)}];await assert.rejects(reconcileWebhook(store,api,4663,changed,url,62000));assert.equal(calls,4);
});
for(const scenario of ['timeout-after-create','eviction-after-create','verify-failure'])test(`C1-5/C1-10: ${scenario} sweeps same-callback orphans and immediately deletes superseded hooks`,async()=>{
 const store=new MemorySwapStore(),desired=desiredWebhook(4663,pools,url),hooks:any[]=[hook({...desired,webhook_url:url+'?set=obsolete'},'old'),hook({...desired,webhook_url:'https://other.invalid/api/chains/4663/webhooks/alchemy'},'other')];let first=true;const removed:string[]=[];
 const api=new NotifyClient('test',async(input,init)=>{const u=new URL(String(input));if(init?.method==='DELETE'){const id=u.searchParams.get('webhook_id')!;removed.push(id);hooks.splice(hooks.findIndex(h=>h.id===id),1);return Response.json({});}if(init?.method==='POST'){const created=hook(JSON.parse(String(init.body)),'new');hooks.push(created);if(first){first=false;if(scenario==='timeout-after-create')throw Error('timeout');if(scenario==='verify-failure')return Response.json({data:{...created,network:'BASE_MAINNET'}});if(scenario==='eviction-after-create')throw Error('evicted');}return Response.json({data:created});}return Response.json({data:hooks});});
 await assert.rejects(reconcileWebhook(store,api,4663,pools,url,1000));await reconcileWebhook(store,api,4663,pools,url,61000);assert(removed.includes('old'));assert(!removed.includes('other'));assert.equal(hooks.filter(h=>new URL(h.webhook_url).origin==='https://musegod.fun').length,1);assert.equal(store.get<any>('notify').bindings[0].id,'new');
});
test('C1-6/C1-7: reject raw invalid JSON before parse; junk never spends valid rate; delivery never fetches USD',async()=>{
 const store=new MemorySwapStore();store.set('notify',{bindings:[{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',key}]});let prices=0;const service=new SwapService(4663,store,{pools:async()=>pools,quote:async()=>{prices++;return null;}});
 assert.equal((await service.ingest(Buffer.from('{'),undefined)).status,401);
 for(let n=0;n<650;n++){service.admitWebhook('203.0.113.1',undefined);await service.ingest(Buffer.from('{'),undefined);}
 const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000);const raw=Buffer.from(JSON.stringify(body));assert.equal((await service.ingest(raw,createHmac('sha256',key).update(raw).digest('hex'))).status,200);assert.equal(prices,0);assert.equal(store.rows(MUSE_POOL)[0].priceUsd,undefined);
});
test('C1-8/C1-13: union retains provider rows after coverage and empty own summary preserves provider',()=>{
 const t=delivery().trades[0],base={source:'Bankr' as const,fetchedAt:t.at,trades:[{id:t.hash+':99',hash:t.hash,logIndex:99,at:t.at,account:null,side:'buy' as const,amount:1,usd:1,price:1}]};assert.equal(mergeTrades(base,[t],t.at).trades.length,2);
 const summary={source:'Bankr' as const,fetchedAt:t.at,lastTradeAt:t.at,priceUsd:7,fdvUsd:null,marketCapUsd:null,liquidityUsd:null,periods:{}};assert.deepEqual(mergeSummary(summary,[],t.at),summary);
});
test('C1-8/C1-12: provider candles remain authoritative and quote-only old rows cannot change window unit',()=>{
 const t=delivery().trades[0],bucket=Math.floor(Date.parse(t.at)/3600000)*3600,bar={time:bucket,open:7,high:7,low:7,close:7,volume:99},base={source:'Bankr' as const,fetchedAt:t.at,candles:[bar]};
 assert.deepEqual(mergeCandles(base,[t],t.at,'1h',null).candles,[bar]);
 const recent={...t,blockNumber:t.blockNumber+1,at:new Date((bucket+3601)*1000).toISOString()};const result=mergeCandles(base,[t,recent],t.at,'1h',{price:2,source:'LI.FI',at:new Date().toISOString()});assert.equal(result.unit,'USD');assert.equal(result.candles[0].volume,99);
});
test('C1-9: finality verifies each stored swap block once, removes empty canonical replacement; caps alarm RPC',async()=>{
 const store=new MemorySwapStore(),d=delivery();for(let n=0;n<12;n++)store.apply({...d,blockNumber:n+1,trades:[{...d.trades[0],id:'row'+n,blockNumber:n+1}]});let rpc=0;const messages:any[]=[];
 const service=new SwapService(4663,store,{pools:async()=>pools,blockHash:async()=>{rpc++;return '0x'+'ab'.repeat(32);},broadcast:m=>messages.push(m)});await service.maintain();assert.equal(rpc,10);assert.equal(store.rows(MUSE_POOL).length,2);await service.maintain();assert.equal(rpc,12);await service.maintain();assert.equal(rpc,12);assert(messages.every(m=>m.reorg));
});
test('C1-11: IPv6 /64 shares cap; pending upgrades reserve global cap before awaits',async()=>{
 const {StreamAdmission}=await import('../server/swap-limits');const admission=new StreamAdmission();const leases=Array.from({length:8},(_,n)=>admission.reserve(`2001:db8:1:2::${n}`,[]));assert(leases.every(Boolean));assert.equal(admission.reserve('2001:db8:1:2::abcd',[]),null);leases.forEach(l=>l?.());
 const all=Array.from({length:128},(_,n)=>admission.reserve(`10.0.${Math.floor(n/255)}.${n%255}`,[]));assert(all.every(Boolean));assert.equal(admission.reserve('192.0.2.1',[]),null);all.forEach(l=>l?.());assert(admission.reserve('192.0.2.1',[]));
});
test('C1-3: CLI refuses apply before sending any token over HTTP; operator endpoint is absent',async()=>{
 const {runWebhookCli}=await import('../scripts/alchemy-webhooks');let calls=0;await assert.rejects(runWebhookCli(['--apply'],{ALCHEMY_NOTIFY_API_KEY:'synthetic'},async()=>{calls++;return Response.json({data:[]});}));assert.equal(calls,0);
 const {readFile}=await import('node:fs/promises');assert(!(await readFile('server/app.ts','utf8')).includes('app.post("/api/webhooks/alchemy/reconcile"'));
});
test('C1-7/C1-12: independent display USD cache refreshes once per 5m/asset, limits own budget, retries unit per response',async()=>{
 const {SwapQuotePrices}=await import('../server/swap-prices');let calls=0,now=Date.now();const reader=new SwapQuotePrices(async()=>{calls++;return Response.json({address:pools[0].quote,chainId:4663,decimals:18,priceUSD:'2000'});},()=>now);
 const q=await reader.get(pools[0]);assert.equal(q?.price,2000);for(let n=0;n<100;n++)assert.equal((await reader.get(pools[0]))?.price,2000);assert.equal(calls,1);now+=300001;await reader.get(pools[0]);assert.equal(calls,2);
 const store=new MemorySwapStore(),d=delivery();store.apply(d);let available=false;const service=new SwapService(4663,store,{pools:async()=>pools,quote:async()=>available?{price:2000,source:'LI.FI',at:new Date().toISOString()}:null});
 assert.equal((await service.serve('candles',MUSE_POOL,async()=>null)).unit,'WETH');available=true;assert.equal((await service.serve('candles',MUSE_POOL,async()=>null)).unit,'USD');assert.equal(store.rows(MUSE_POOL)[0].priceUsd,undefined);
});
test('C1-1/C1-9: SQLite pruning is bounded and finality survives adapter reload without rechecking',async()=>{
 const db=new DatabaseSync(':memory:'),queries:string[]=[],sql={exec(q:string,...a:any[]){queries.push(q);return db.prepare(q).all(...a);}},store=new SqlSwapStore(sql,fn=>fn(),2),d=delivery();
 try{for(let n=0;n<5;n++)store.apply({...d,blockNumber:n+1,trades:[{...d.trades[0],id:'row'+n,blockNumber:n+1}]});queries.length=0;store.prune(Date.now(),1);assert.equal(store.rows(MUSE_POOL).length,4);assert(!queries.some(q=>q.includes('COUNT(*)')),'alarm should use persisted counts, not scan the table');
 const block=store.pendingBlocks(Math.floor(Date.now()/1000)-120,1)[0];assert(block);store.verifyBlock(block.block,block.hash,'0x'+'ab'.repeat(32));const restored=new SqlSwapStore(sql,fn=>fn(),2);assert(!restored.pendingBlocks(Math.floor(Date.now()/1000),10).some(b=>b.block===block.block));
 }finally{db.close();}
});
test('C1-6: only current and immediately superseded keys authenticate; invalid raw bytes never parse',async()=>{
 const store=new MemorySwapStore();store.set('notify',{bindings:[{id:'current',network:'ROBINHOOD_MAINNET',key:'a'},{id:'previous',network:'ROBINHOOD_MAINNET',key:'b',retireAt:Date.now()+10000},{id:'ancient',network:'ROBINHOOD_MAINNET',key:'c'}]});const service=new SwapService(4663,store,{pools:async()=>pools});const raw=Buffer.from('{');
 assert.equal((await service.ingest(raw,createHmac('sha256','a').update(raw).digest('hex'))).status,400);assert.equal((await service.ingest(raw,createHmac('sha256','c').update(raw).digest('hex'))).status,401);
});
test('C1-8: union keeps each provider row source; provider-only result retains provider provenance',()=>{
 const t=delivery().trades[0],base={source:'Bankr' as const,fetchedAt:t.at,trades:[{id:t.hash+':99',hash:t.hash,logIndex:99,at:t.at,account:null,side:'buy' as const,amount:1,usd:1,price:1}]};assert.equal(mergeTrades(base,[t],t.at).trades.find(r=>r.logIndex===99)?.source,'Bankr');assert.equal(mergeTrades(base,[],t.at).source,'Bankr');
});
test('C1-4: repeated failure delay doubles to 1h and a different pool set ignores old backoff',async()=>{
 const store=new MemorySwapStore();let now=1000,calls=0;const api=new NotifyClient('test',async()=>{calls++;throw Error('timeout');});
 for(let n=0;n<9;n++){await assert.rejects(reconcileWebhook(store,api,4663,pools,url,now));const a=store.get<any>('notify-attempt');assert.equal(a.nextAt-now,Math.min(3600000,60000*2**n));now=a.nextAt;}
 const changed=[...pools,{...pools[0],version:4 as const,pool:'0x'+'ab'.repeat(32)}];await assert.rejects(reconcileWebhook(store,api,4663,changed,url,now-1));assert.equal(calls,10);assert.equal(store.get<any>('notify-attempt').failures,1);
});
test('C1-1: alarm backlog has a hard ceiling and overload cannot partially commit',()=>{
 const db=new DatabaseSync(':memory:'),sql={exec(q:string,...a:any[]){return db.prepare(q).all(...a);}},sqlite=new SqlSwapStore(sql,fn=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},2),d=delivery();
 try{for(const store of [new MemorySwapStore(2),sqlite]){const rows=Array.from({length:2003},(_,n)=>({...d.trades[0],id:'row'+n,logIndex:n}));assert.throws(()=>store.apply({...d,trades:rows}),/capacity/);assert.equal(store.rows(MUSE_POOL).length,0);}}
 finally{db.close();}
});
test('C1-2: late delivery emits an explicit gap instead of silently corrupting incremental candle volume',async()=>{
 const store=new MemorySwapStore(),messages:any[]=[],service=new SwapService(4663,store,{pools:async()=>pools,broadcast:m=>messages.push(m)});store.set('notify',{bindings:[{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',key}]});
 for(const offset of [2,1]){const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.number+=offset;body.event.data.block.logs[0].transaction.hash='0x'+String(offset).repeat(64);body.event.data.block.timestamp=Math.floor(Date.now()/1000);const raw=Buffer.from(JSON.stringify(body));assert.equal((await service.ingest(raw,createHmac('sha256',key).update(raw).digest('hex'))).status,200);}
 assert.equal(messages[0].gap,undefined);assert.equal(messages[1].gap,true);
});
test('C1-2/C1-8: repeated own price merges retain the original provider statistics source',()=>{
 const t=delivery().trades[0],base={source:'Bankr' as const,fetchedAt:t.at,priceUsd:7,fdvUsd:null,marketCapUsd:null,liquidityUsd:null,periods:{}};const first=mergeSummary(base,[t],t.at);assert.equal(mergeSummary(first,[{...t,logIndex:t.logIndex+1}],t.at).historySource,'Bankr');
});
