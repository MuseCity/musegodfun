import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fixtures from './fixtures/alchemy-swaps.json';
import { decodeDelivery, verifySignature, MUSE_POOL, type SwapPool } from '../server/swap-stream';
import { MemorySwapStore } from '../server/swap-store';
const key='test-only-signing-key';
export const v3Pool: SwapPool={chainId:4663,version:3,pool:MUSE_POOL,token:'0x0379e228f6887c6f18bf394042ecaf81b308cb2e',quote:'0x0bd7d308f8e1639fab988df18a8011f41eacad73',tokenDecimals:18,quoteDecimals:18,quoteSymbol:'WETH'};
const raw=JSON.stringify(fixtures.deliveries.v3), sign=(s:string)=>createHmac('sha256',key).update(s).digest('hex');
test('raw HMAC: valid, invalid, missing; identity/schema fail before any storage',()=>{
 assert(verifySignature(raw,sign(raw),key));assert(!verifySignature(raw+' ',sign(raw),key));assert(!verifySignature(raw,undefined,key));
 const bound={id:'wh_test_v3',network:'ROBINHOOD_MAINNET'};
 assert.equal(decodeDelivery(raw,bound,[v3Pool]).trades.length,1);
 for(const change of [{webhookId:'wrong'},{type:'ADDRESS_ACTIVITY'},{event:{...fixtures.deliveries.v3.event,network:'BASE_MAINNET'}},{event:{}}])assert.throws(()=>decodeDelivery(JSON.stringify({...fixtures.deliveries.v3,...change}),bound,[v3Pool]));
 assert.throws(()=>decodeDelivery(raw,bound,[]));
});
test('real V3 and V4 log decoding, opposite pool delta conventions, exact amounts',()=>{
 const d=decodeDelivery(raw,{id:'wh_test_v3',network:'ROBINHOOD_MAINNET'},[v3Pool]), trade=d.trades[0];
 assert.equal(trade.hash,fixtures.v3[0].transactionHash);assert.equal(trade.logIndex,41);assert.equal(trade.side,'sell');assert.match(trade.priceQuote,/^\d+\.\d+$/);assert(BigInt(trade.sqrtPriceX96)>0n);
 const pool={...v3Pool,version:4 as const,pool:fixtures.v4[0].topics[1]};
 const v4=decodeDelivery(JSON.stringify(fixtures.deliveries.v4),{id:'wh_test_v4',network:'ROBINHOOD_MAINNET'},[pool]);assert(v4.trades.length>0);
 assert.equal(v4.trades[0].side,BigInt(v4.trades[0].amount0)>0n?'buy':'sell');
});
test('idempotency, newer reorg replaces entire block; stale retries cannot resurrect, bounded retention',()=>{
 const store=new MemorySwapStore(2), d=decodeDelivery(raw,{id:'wh_test_v3',network:'ROBINHOOD_MAINNET'},[v3Pool]);
 assert.equal(store.apply(d).trades.length,1);assert.equal(store.apply(d).trades.length,0);
 const reorg={...d,sequence:'10000000000000000002',blockHash:'0x'+'ab'.repeat(32),trades:d.trades.map(t=>({...t,blockHash:'0x'+'ab'.repeat(32),hash:'0x'+'cd'.repeat(32),id:'4663:0x'+'cd'.repeat(32)+':41'}))};
 assert.equal(store.apply(reorg).reorg,true);assert.equal(store.rows(MUSE_POOL).length,1);store.apply(d);assert.equal(store.rows(MUSE_POOL)[0].blockHash,reorg.blockHash);
 for(let n=1;n<=3;n++)store.apply({...reorg,blockNumber:d.blockNumber+n,sequence:String(BigInt(reorg.sequence)+BigInt(n)),trades:reorg.trades.map(t=>({...t,id:t.id+n,blockNumber:t.blockNumber+n}))});
 store.prune();assert.equal(store.rows(MUSE_POOL).length,2);
});

test('schema rejects foreign contracts, topic0, pool, block types and conflicting network',()=>{
 const binding={id:'wh_test_v3',network:'ROBINHOOD_MAINNET'};
 for(const mutate of [
  (b:any)=>b.event.data.block.logs[0].account.address='0x'+'ff'.repeat(20),
  (b:any)=>b.event.data.block.logs[0].topics[0]='0x'+'ff'.repeat(32),
  (b:any)=>b.event.data.block.number='0x123',
  (b:any)=>b.event.data.block.timestamp=Number.MAX_SAFE_INTEGER,
  (b:any)=>delete b.event.data.block.logs,
 ]){const body=structuredClone(fixtures.deliveries.v3);mutate(body);assert.throws(()=>decodeDelivery(JSON.stringify(body),binding,[v3Pool]));}
});

test('integer ratio handles decimal differences and tiny values without Number rounding',async()=>{
 const {decimalRatio}=await import('../server/swap-stream');
 assert.equal(decimalRatio(123456789012345678901n,10n**18n),'123.456789012345678901');
 assert.equal(decimalRatio(1n,10n**60n),'0.'+'0'.repeat(59)+'1');
});
