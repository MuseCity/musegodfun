import test from 'node:test';import assert from 'node:assert/strict';
import fixtures from './fixtures/alchemy-swaps.json';
import { decodeDelivery,registeredPools } from '../server/swap-stream';
import { mergeTrades,mergeCandles,mergeSummary } from '../src/lib/swap-market';
const trade=decodeDelivery(JSON.stringify(fixtures.deliveries.v3),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const},registeredPools(4663,[])).trades[0];
test('own trade wins exact transaction/log overlap while different logs survive; USD never inferred',()=>{
 const base={source:'Bankr' as const,fetchedAt:trade.at,trades:[{id:`robinhood:${trade.hash}:${trade.logIndex}`,hash:trade.hash,at:trade.at,account:null,side:'buy' as const,amount:1,usd:5,price:5},{id:`robinhood:${trade.hash}:99`,hash:trade.hash,at:trade.at,account:null,side:'buy' as const,amount:1,usd:1,price:1}]};
 const result=mergeTrades(base,[trade],new Date(Date.parse(trade.at)+1).toISOString());assert.equal(result.trades.length,2);assert.equal(result.trades.find(t=>t.id===trade.id)?.price,null);assert.equal(result.trades.find(t=>t.id===trade.id)?.priceQuote,trade.priceQuote);
 const summary=mergeSummary({source:'Bankr',fetchedAt:new Date(Date.parse(trade.at)-1000).toISOString(),priceUsd:1,marketCapUsd:5,fdvUsd:5,liquidityUsd:5,periods:{}},[trade],trade.at);assert.equal(summary.priceUsd,1);assert.equal(summary.priceQuote,trade.priceQuote);assert.equal(summary.quotePriceAt,trade.at);
});
test('provider bars remain authoritative; own OHLCV covers only newer current bar or provider-unavailable pools',()=>{
 const bucket=Math.floor(Date.now()/3600000)*3600,coverage=new Date((bucket-3600)*1000).toISOString();
 const t={...trade,at:new Date((bucket+1)*1000).toISOString(),priceQuote:'1',quoteAmount:'2'},q={price:2,source:'LI.FI' as const,at:new Date().toISOString()};
 const provider={source:'Bankr' as const,fetchedAt:trade.at,candles:[{time:bucket-3600,open:9,high:9,low:9,close:9,volume:99}]};
 const result=mergeCandles(provider,[t,{...t,id:t.id+'2',logIndex:42,priceQuote:'1.5',quoteAmount:'3'}],coverage,'1h',q);
 assert.equal(result.candles.length,2);assert.equal(result.candles[0].volume,99);assert.equal(result.candles[1].volume,10);assert.equal(result.candles[1].open,2);assert.equal(result.candles[1].close,3);assert.equal(result.historySource,'Bankr');
 const quote=mergeCandles(null,[t],coverage,'1h',null);assert.equal(quote.unit,'WETH');assert.equal(quote.candles.length,1);
});

test('history paging accepts mixed on-chain/provider USD bars and refuses quote-unit bars',async()=>{
 const {createHistoryPager}=await import('../src/lib/candle-history');
 const base={fetchedAt:trade.at,source:'On-chain · Alchemy' as const,historySource:'Bankr' as const,unit:'USD',candles:[{time:1,open:2,high:2,low:2,close:2,volume:4}]};
 const page=await createHistoryPager(async()=>base).load(2);assert.equal(page?.candles.length,1);
 await assert.rejects(createHistoryPager(async()=>({...base,unit:'WETH'})).load(2));
});

test('C1 own-trade watermarks guard every section: rows at or below a section watermark are not re-applied',async()=>{
 const {applySwapPush}=await import('../src/lib/swap-projection');
 const {decodeDelivery,registeredPools}=await import('../server/swap-stream');const fixtures=(await import('./fixtures/alchemy-swaps.json')).default;
 const trade=decodeDelivery(JSON.stringify(fixtures.deliveries.v3),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const},registeredPools(4663,[])).trades[0];
 const message=(t:any)=>({type:'trades' as const,chainId:4663 as const,pool:t.pool,trades:[t],blockNumber:t.blockNumber,blockHash:t.blockHash,reorg:false,coverageStart:trade.at});
 const priced={...trade,priceUsd:Number(trade.priceQuote)*2460,usd:Number(trade.quoteAmount)*2460,quoteUsd:{price:2460,source:'LI.FI' as const,at:new Date().toISOString()}};
 const first=applySwapPush({summary:null,candles:null,trades:null},message(priced),'1h');
 for(const section of [first.summary,first.trades,first.candles])assert.deepEqual(section?.watermark,{blockNumber:trade.blockNumber,logIndex:trade.logIndex,txHash:trade.hash});
 const replayed=applySwapPush(first,message({...trade,priceUsd:null,usd:null,quoteUsd:null}),'1h');
 assert.equal(replayed.summary,first.summary);assert.equal(replayed.trades,first.trades);assert.equal(replayed.candles,first.candles);
 const older={...trade,id:`4663:0x${'1'.repeat(64)}:0`,hash:`0x${'1'.repeat(64)}`,logIndex:trade.logIndex-1,priceQuote:'0.5'};
 const stale=applySwapPush(first,message(older),'1h');
 assert.equal(stale.summary!.priceQuote,trade.priceQuote);assert.equal(stale.trades!.trades.length,1);
});
