import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {MemorySwapStore,SqlSwapStore,type SwapStore} from '../server/swap-store';import {SwapService} from '../server/swap-service';import {decodeDelivery,registeredPools,NETWORKS,type SwapPool,type WebhookKind} from '../server/swap-stream';import fixtures from './fixtures/alchemy-swaps.json';
const v3=registeredPools(4663,[])[0],v4:SwapPool={...v3,version:4,pool:fixtures.v4[0].topics[1]},pools=[v3,v4],N=90_000_000;
const A='0x'+'a1'.repeat(32),B='0x'+'b2'.repeat(32),C='0x'+'c3'.repeat(32);
/** Retained real V3/V4 logs wrapped in one synthetic height with the given block hash, webhook generation and sequence. */
function body(kind:WebhookKind,hash:string,sequence:number){const b=structuredClone(fixtures.deliveries[kind]);b.webhookId=kind;b.event.data.block.number=N;b.event.data.block.hash=hash;b.event.data.block.timestamp=Math.floor(Date.now()/1000)-600;b.event.sequenceNumber=String(sequence);return b;}
const delivery=(kind:WebhookKind,hash:string,generation:number,sequence:number)=>({...decodeDelivery(JSON.stringify(body(kind,hash,sequence)),{id:kind,network:NETWORKS[4663],kind},pools),generation});
type Fixture={name:string;store:SwapStore;sql?:{exec(q:string,...a:any[]):any[]};consistent():void};
function adapters(t:{after(fn:()=>void):void}):(()=>Fixture)[]{
 return [()=>({name:'memory',store:new MemorySwapStore(),consistent(){}}),
  ()=>{const db=new DatabaseSync(':memory:');t.after(()=>db.close());const sql={exec:(q:string,...a:any[])=>db.prepare(q).all(...a)},store=new SqlSwapStore(sql,fn=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}});
   return {name:'sqlite',store,sql,consistent(){assert.equal(store.get('trade-count'),(db.prepare('SELECT COUNT(*) AS n FROM swap_trades').get() as any).n,'persisted trade count');}};}];
}
const hashes=(s:SwapStore,pool:SwapPool)=>s.rows(pool.pool).map(t=>t.blockHash);
const volume=(s:SwapStore,pool:SwapPool)=>s.buckets(pool.pool,0,2**31,3600).reduce((n,b)=>n+b.bar.volume,0);
/** Runs the scheduled finality check for height N with the given canonical hash, exactly as maintenance would. */
function finalize(s:SwapStore,canonical:string){const pending=s.pendingBlocks(Math.floor(Date.now()/1000),10).find(b=>b.block===N);assert(pending,'height N is pending verification');return s.verifyBlock(N,pending.hash,canonical);}
test('X4-1: a delayed sibling-kind orphan never erases an acknowledged canonical row; finality keeps it in both adapters',t=>{
 for(const make of adapters(t))for(const [canonicalKind,orphanKind] of [['v4','v3'],['v3','v4']] as const){
  const f=make(),label=`${f.name}: canonical ${canonicalKind}, delayed ${orphanKind}`,keep=canonicalKind==='v4'?v4:v3,gone=canonicalKind==='v4'?v3:v4;
  // Independent webhooks: generations and sequences of different kinds are never compared.
  assert.equal(f.store.apply(delivery(canonicalKind,B,canonicalKind==='v4'?2000:1000,20)).trades.length,1);
  const late=f.store.apply(delivery(orphanKind,A,orphanKind==='v4'?2000:1000,1));assert.equal(late.reorg,false,label+': no cross-kind replacement');assert.deepEqual(late.removedPools,[]);
  assert.deepEqual(hashes(f.store,keep),[B],label);assert.deepEqual(hashes(f.store,gone),[A],label+': rows of different kinds coexist until finality');f.consistent();
  assert.deepEqual(finalize(f.store,B),[gone.pool],label);assert.deepEqual(hashes(f.store,keep),[B],label+': the canonical row survives');assert.deepEqual(hashes(f.store,gone),[],label+': the orphan is removed');
  assert.equal(volume(f.store,gone),0);assert(volume(f.store,keep)>0);assert.deepEqual(f.store.pendingBlocks(Math.floor(Date.now()/1000),10),[]);f.consistent();
 }
});
test('X4-1: reversed delivery order, shared canonical hash and an orphaned shared hash resolve per row in both adapters',t=>{
 for(const make of adapters(t)){
  for(const [orphanKind,canonicalKind] of [['v3','v4'],['v4','v3']] as const){const f=make(),keep=canonicalKind==='v4'?v4:v3,gone=canonicalKind==='v4'?v3:v4;
   f.store.apply(delivery(orphanKind,A,orphanKind==='v4'?2000:1000,1));assert.equal(f.store.apply(delivery(canonicalKind,B,canonicalKind==='v4'?2000:1000,20)).reorg,false);
   assert.deepEqual(hashes(f.store,gone),[A]);finalize(f.store,B);assert.deepEqual(hashes(f.store,keep),[B],f.name);assert.deepEqual(hashes(f.store,gone),[]);f.consistent();}
  for(const canonical of [B,C]){const f=make();f.store.apply(delivery('v4',B,2000,20));f.store.apply(delivery('v3',B,1000,1));
   finalize(f.store,canonical);const expected=canonical===B?[B]:[];assert.deepEqual(hashes(f.store,v4),expected,f.name);assert.deepEqual(hashes(f.store,v3),expected,f.name);f.consistent();}
 }
});
test('X4-1: same-kind newer replacement still replaces only that kind; older same-kind deliveries stay stale in both adapters',t=>{
 for(const make of adapters(t)){
  const f=make();f.store.apply(delivery('v3',A,1000,1));f.store.apply(delivery('v4',A,2000,1));
  const replaced=f.store.apply(delivery('v4',B,2000,2));assert.equal(replaced.reorg,true,f.name);assert.deepEqual(replaced.removedPools,[v4.pool]);
  assert.deepEqual(hashes(f.store,v4),[B]);assert.deepEqual(hashes(f.store,v3),[A],f.name+': the sibling kind is untouched');
  assert.equal(f.store.apply(delivery('v4',A,2000,1)).trades.length,0,f.name+': an older same-kind delivery is stale');assert.deepEqual(hashes(f.store,v4),[B]);
  assert.equal(f.store.apply(delivery('v4',C,1999,9)).trades.length,0,f.name+': an older same-kind generation is stale');f.consistent();
  finalize(f.store,B);assert.deepEqual(hashes(f.store,v4),[B]);assert.deepEqual(hashes(f.store,v3),[]);
  assert.equal(f.store.apply(delivery('v3',A,1000,5)).trades.length,0,f.name+': after finality another hash is stale for every kind');f.consistent();
 }
});
test('X4-1: per-kind hashes and cursors survive an SQLite restart',()=>{
 const db=new DatabaseSync(':memory:'),sql={exec:(q:string,...a:any[])=>db.prepare(q).all(...a)},open=()=>new SqlSwapStore(sql,fn=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}});
 try{const first=open();first.apply(delivery('v4',B,2000,20));first.apply(delivery('v3',A,1000,1));
  const restored=open();assert.equal(restored.apply(delivery('v3',A,1000,1)).trades.length,0,'an exact retry stays idempotent');assert.equal(restored.apply(delivery('v4',C,2000,19)).trades.length,0,'an older V4 delivery stays stale');
  assert.equal(restored.apply(delivery('v3',C,1000,0)).trades.length,0,'an older V3 delivery stays stale');assert.deepEqual(hashes(restored,v4),[B]);assert.deepEqual(hashes(restored,v3),[A]);
  finalize(restored,B);const reopened=open();assert.deepEqual(hashes(reopened,v4),[B]);assert.deepEqual(hashes(reopened,v3),[]);assert.equal(reopened.get('trade-count'),1);
 }finally{db.close();}
});
test('X4-1: through SwapService both deliveries are acknowledged and scheduled finality keeps the canonical V4 row',async()=>{
 const store=new MemorySwapStore();for(const [kind,generation] of [['v3',1000],['v4',2000]] as const)store.set('notify-'+kind,{bindings:[{id:kind,network:NETWORKS[4663],kind,key:kind+'-key',generation}]});
 const service=new SwapService(4663,store,{pools:async()=>pools,blockHash:async()=>B}),post=(kind:WebhookKind,hash:string,sequence:number)=>{const raw=Buffer.from(JSON.stringify(body(kind,hash,sequence)));return service.ingest(raw,createHmac('sha256',kind+'-key').update(raw).digest('hex'),kind);};
 assert.equal((await post('v4',B,20)).status,200);assert.equal((await post('v3',A,1)).status,200);await service.maintain();
 assert.deepEqual(hashes(store,v4),[B]);assert.deepEqual(hashes(store,v3),[]);
});
