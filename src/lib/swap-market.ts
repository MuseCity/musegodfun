import { INTERVAL_SECONDS } from "./candle-history";
import type { CandleData,ChartInterval,MarketSummary,MarketTrade,TradeData } from "./market";
import type { OnchainTrade } from "./swap-stream";
const source="On-chain · Alchemy" as const;
const order=(a:OnchainTrade,b:OnchainTrade)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;
const latest=(rows:OnchainTrade[])=>rows.reduce<OnchainTrade|undefined>((last,t)=>!last||order(t,last)>0?t:last,undefined);
const meta=(base:{source?:TradeData['source'];fetchedAt:string;historySource?:TradeData['source'];historyFetchedAt?:string}|null,last:OnchainTrade|undefined,coverageStart:string)=>({source,status:"fresh" as const,fetchedAt:last?.at??coverageStart,coverageStart,...(base?{historySource:base.source===source?base.historySource:base.source,historyFetchedAt:base.source===source?base.historyFetchedAt:base.fetchedAt}:{})});
export function priceTrade(t:OnchainTrade,q:OnchainTrade['quoteUsd']):OnchainTrade{
 const valid=q&&q.price>0&&Number.isFinite(q.price)&&Date.now()-Date.parse(q.at)<300_000&&Date.parse(q.at)<=Date.now()+60_000;
 const price=valid?Number(t.priceQuote)*q.price:null,usd=valid?Number(t.quoteAmount)*q.price:null;
 return {...t,quoteUsd:valid?q:null,priceUsd:price!==null&&price>0&&Number.isFinite(price)?price:null,usd:usd!==null&&Number.isFinite(usd)?usd:null};
}
export function tradeKey(t:MarketTrade){const log=t.logIndex??(/:(\d+)$/.exec(t.id)?.[1]);return log===undefined?t.id.toLowerCase():`${t.hash.toLowerCase()}:${log}`;}
export function mergeTrades(base:TradeData|null,rows:OnchainTrade[],coverageStart:string):TradeData{
 if(!rows.length&&base)return base;
 const map=new Map<string,MarketTrade>((base?.trades??[]).map(t=>[tradeKey(t),{...t,source:t.source??base?.source}]));
 for(const t of rows){const row:MarketTrade={id:t.id,hash:t.hash,logIndex:t.logIndex,blockNumber:t.blockNumber,account:t.account,at:t.at,side:t.side,amount:Number(t.amount),price:t.priceUsd??null,usd:t.usd??null,priceQuote:t.priceQuote,quoteAmount:t.quoteAmount,quoteSymbol:t.quoteSymbol,source};map.set(tradeKey(row),row);}
 return {...meta(base,latest(rows),coverageStart),quoteUsd:latest(rows)?.quoteUsd??null,trades:[...map.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||(b.blockNumber??0)-(a.blockNumber??0)||(b.logIndex??0)-(a.logIndex??0)).slice(0,30)};
}
export function mergeSummary(base:MarketSummary|null,rows:OnchainTrade[],coverageStart:string):MarketSummary{
 const t=latest(rows);if(!t)return base??{...meta(null,undefined,coverageStart),priceUsd:null,fdvUsd:null,marketCapUsd:null,liquidityUsd:null,periods:{}};
 if(base?.lastTradeAt&&Date.parse(base.lastTradeAt)>Date.parse(t.at))return base;
 return {...base,...meta(base,t,coverageStart),lastTradeAt:t.at,priceUsd:t.priceUsd??null,priceQuote:t.priceQuote,quoteSymbol:t.quoteSymbol,quoteUsd:t.quoteUsd??null,marketCapUsd:null,fdvUsd:null,liquidityUsd:base?.liquidityUsd??null,periods:base?.periods??{}};
}
export type SwapCandleBucket={bar:CandleData['candles'][number];last:OnchainTrade};
/** SQL returns one quote-unit aggregate and one metadata payload per bucket. */
export function mergeCandleBuckets(base:CandleData|null,buckets:SwapCandleBucket[],coverageStart:string,q:OnchainTrade['quoteUsd']):CandleData{
 const last=latest(buckets.map(b=>b.last));if(!last&&base)return {...base,unit:base.unit??'USD'};
 const priced=last?priceTrade(last,q):undefined,factor=priced?.quoteUsd?.price??1;
 return {...meta(base,priced,coverageStart),unit:priced?.quoteUsd?'USD':last?.quoteSymbol,quoteUsd:priced?.quoteUsd??null,candles:buckets.map(({bar})=>({time:bar.time,open:bar.open*factor,high:bar.high*factor,low:bar.low*factor,close:bar.close*factor,volume:bar.volume*factor})),watermark:last?{blockNumber:last.blockNumber,logIndex:last.logIndex,txHash:last.hash}:null};
}
/** Streaming accumulation holds at most 200 buckets, independent of trades per bucket. */
export function mergeCandles(base:CandleData|null,rows:Iterable<OnchainTrade>,coverageStart:string,interval:ChartInterval,before?:number):CandleData{
 const seconds=INTERVAL_SECONDS[interval],to=before??Date.now()/1000+1,from=Math.max(Date.parse(coverageStart)/1000,(Math.ceil(to/seconds)-200)*seconds);
 const provider=(base?.candles??[]).filter(c=>c.time<to),lastProvider=provider.reduce((n,c)=>Math.max(n,c.time),-1),current=Math.floor(Date.now()/1000/seconds)*seconds;
 const bars=new Map<number,{bar:CandleData['candles'][number];first:OnchainTrade;last:OnchainTrade}>();let last:OnchainTrade|undefined,usd:boolean|undefined;
 for(const t of rows){const at=Date.parse(t.at)/1000,time=Math.floor(at/seconds)*seconds;if(at<from||at>=to||provider.length&&(time<=lastProvider||time!==current))continue;
  const inUsd=t.priceUsd!=null&&t.usd!=null;if(provider.length&&!inUsd)continue;
  // Server reads use one current quote for the entire requested window.
  if(usd===undefined)usd=inUsd;if(usd!==inUsd)continue;
  const price=usd?t.priceUsd!:Number(t.priceQuote),volume=usd?t.usd!:Number(t.quoteAmount);if(!(price>0)||!Number.isFinite(price)||!Number.isFinite(volume))continue;
  const b=bars.get(time);if(b){b.bar.high=Math.max(b.bar.high,price);b.bar.low=Math.min(b.bar.low,price);b.bar.volume+=volume;if(order(t,b.first)<0){b.first=t;b.bar.open=price;}if(order(t,b.last)>0){b.last=t;b.bar.close=price;}}else bars.set(time,{bar:{time,open:price,high:price,low:price,close:price,volume},first:t,last:t});
  if(!last||order(t,last)>0)last=t;
 }
 if(!last&&base)return {...base,unit:base.unit??'USD'};
 return {...meta(base,last,coverageStart),unit:provider.length||usd?'USD':last?.quoteSymbol,quoteUsd:last?.quoteUsd??null,
 candles:[...provider,...[...bars.values()].map(b=>b.bar)].sort((a,b)=>a.time-b.time).slice(-200),watermark:last?{blockNumber:last.blockNumber,logIndex:last.logIndex,txHash:last.hash}:null};
}
