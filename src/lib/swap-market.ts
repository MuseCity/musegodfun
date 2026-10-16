import { INTERVAL_SECONDS } from "./candle-history";
import type { Candle,CandleData,ChartInterval,MarketSummary,MarketTrade,TradeData } from "./market";
import type { OnchainTrade } from "./swap-stream";
const source="On-chain · Alchemy" as const;
type Quote=OnchainTrade['quoteUsd'];
export type OwnCandles=NonNullable<CandleData['own']>;
const order=(a:OnchainTrade,b:OnchainTrade)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;
const latest=(rows:OnchainTrade[])=>rows.reduce<OnchainTrade|undefined>((last,t)=>!last||order(t,last)>0?t:last,undefined);
const mark=(t:OnchainTrade)=>({blockNumber:t.blockNumber,logIndex:t.logIndex,txHash:t.hash});
/** fetchedAt is when this response was served; the last own trade's block time is lastTradeAt. */
const meta=(base:{source?:TradeData['source'];fetchedAt:string;historySource?:TradeData['source'];historyFetchedAt?:string}|null,last:OnchainTrade|undefined,coverageStart:string)=>({source,status:"fresh" as const,fetchedAt:new Date().toISOString(),lastTradeAt:last?.at??null,coverageStart,...(base?{historySource:base.source===source?base.historySource:base.source,historyFetchedAt:base.source===source?base.historyFetchedAt:base.fetchedAt}:{})});
/** The server's identity-checked quote-asset USD price, valid for 5 minutes; pushed trades carry it only when it passed. */
export const currentQuote=(q:Quote|undefined)=>q&&q.price>0&&Number.isFinite(q.price)&&Date.now()-Date.parse(q.at)<300_000&&Date.parse(q.at)<=Date.now()+60_000?q:null;
const convert=(priceQuote:string,quoteAmount:string,q:Quote)=>{const price=q?Number(priceQuote)*q.price:null,usd=q?Number(quoteAmount)*q.price:null;return {price:price!==null&&price>0&&Number.isFinite(price)?price:null,usd:usd!==null&&Number.isFinite(usd)?usd:null};};
export function priceTrade(t:OnchainTrade,q:Quote):OnchainTrade{const valid=currentQuote(q),{price,usd}=convert(t.priceQuote,t.quoteAmount,valid);return {...t,quoteUsd:valid,priceUsd:price,usd};}
export function tradeKey(t:MarketTrade){const log=t.logIndex??(/:(\d+)$/.exec(t.id)?.[1]);return log===undefined?t.id.toLowerCase():`${t.hash.toLowerCase()}:${log}`;}
export function mergeTrades(base:TradeData|null,rows:OnchainTrade[],coverageStart:string):TradeData{
 if(!rows.length&&base)return base;
 // Earlier own rows follow the newest rows' quote, as one REST response would; provider rows keep their own values.
 const q=latest(rows)?.quoteUsd??null,reprice=(t:MarketTrade)=>t.source===source&&t.priceQuote!==undefined&&t.quoteAmount!==undefined?{...t,...convert(t.priceQuote,t.quoteAmount,q)}:t;
 const map=new Map<string,MarketTrade>((base?.trades??[]).map(t=>[tradeKey(t),reprice({...t,source:t.source??base?.source})]));
 for(const t of rows){const row:MarketTrade={id:t.id,hash:t.hash,logIndex:t.logIndex,blockNumber:t.blockNumber,account:t.account,at:t.at,side:t.side,amount:Number(t.amount),price:t.priceUsd??null,usd:t.usd??null,priceQuote:t.priceQuote,quoteAmount:t.quoteAmount,quoteSymbol:t.quoteSymbol,source};map.set(tradeKey(row),row);}
 return {...meta(base,latest(rows),coverageStart),quoteUsd:q,trades:[...map.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||(b.blockNumber??0)-(a.blockNumber??0)||(b.logIndex??0)-(a.logIndex??0)).slice(0,30)};
}
/** `current` is a provider summary (REST) or the previously shown summary (push). Both merge against the provider's own summary, which a
 * merged summary keeps as `providerSnapshot`, so a later own swap without USD restores the provider USD headline exactly as REST does. */
export function mergeSummary(current:MarketSummary|null,rows:OnchainTrade[],coverageStart:string):MarketSummary{
 const t=latest(rows);if(!t)return current??{...meta(null,undefined,coverageStart),priceUsd:null,fdvUsd:null,marketCapUsd:null,liquidityUsd:null,periods:{}};
 if(current&&[current.lastTradeAt,current.quotePriceAt].some(at=>at&&Date.parse(at)>Date.parse(t.at)))return current;
 const base=current?.providerSnapshot??(current?.source===source?null:current);
 if(t.priceUsd==null&&base?.priceUsd!=null&&base.priceUsd>0&&Number.isFinite(base.priceUsd)){
  return {...base,priceQuote:t.priceQuote,quoteSymbol:t.quoteSymbol,quotePriceAt:t.at,providerSnapshot:base};
 }
 return {...base,...meta(base,t,coverageStart),priceUsd:t.priceUsd??null,priceQuote:t.priceQuote,quoteSymbol:t.quoteSymbol,quotePriceAt:undefined,quoteUsd:t.quoteUsd??null,marketCapUsd:base?.marketCapUsd??null,fdvUsd:base?.fdvUsd??null,liquidityUsd:base?.liquidityUsd??null,periods:base?.periods??{},providerSnapshot:base??undefined};
}
const scale=(c:Candle,f:number)=>({time:c.time,open:c.open*f,high:c.high*f,low:c.low*f,close:c.close*f,volume:c.volume*f});
/** Provider bars stay the base. Own quote-asset bars after the provider's last returned bar are shown with one current USD quote,
 * or in quote units when no provider bar needs USD. Otherwise only the provider view is shown and the own state is kept. */
export function composeCandles(base:CandleData|null,own:OwnCandles,coverageStart:string,quote:Quote,last?:OnchainTrade):CandleData{
 const q=quote&&quote.price>0&&Number.isFinite(quote.price)?quote:null,provider=own.providerLastBar===null?[]:(base?.candles??[]).filter(c=>c.time<=own.providerLastBar!);
 if(own.candles.length&&(q||!provider.length))return {...meta(base,last,coverageStart),unit:q?'USD':own.quoteSymbol??undefined,quoteUsd:q,
  candles:[...provider,...own.candles.map(c=>q?scale(c,q.price):c)].sort((a,b)=>a.time-b.time).slice(-200),watermark:own.watermark,own};
 if(!base)return {...meta(null,last,coverageStart),unit:own.quoteSymbol??undefined,quoteUsd:null,candles:[],watermark:own.watermark,own};
 if(base.source!==source)return {...base,unit:base.unit??'USD',own};
 const {historySource,historyFetchedAt,coverageStart:_coverage,lastTradeAt:_last,quoteUsd:_quote,watermark:_watermark,...rest}=base;
 return {...rest,source:historySource,fetchedAt:historyFetchedAt??base.fetchedAt,unit:'USD',candles:provider,own};
}
export type SwapCandleBucket={bar:CandleData['candles'][number];last:OnchainTrade};
/** SQL returns one quote-unit aggregate and one metadata payload per bucket. */
export function mergeCandleBuckets(base:CandleData|null,buckets:SwapCandleBucket[],coverageStart:string,q:Quote):CandleData{
 const last=latest(buckets.map(b=>b.last));
 return composeCandles(base,{providerLastBar:null,quoteSymbol:last?.quoteSymbol??null,candles:buckets.map(b=>b.bar),watermark:last?mark(last):null},coverageStart,currentQuote(q),last);
}
/** Streaming accumulation holds at most 200 quote-unit buckets, independent of trades per bucket. */
export function mergeCandles(base:CandleData|null,rows:Iterable<OnchainTrade>,coverageStart:string,interval:ChartInterval,q:Quote,before?:number):CandleData{
 const seconds=INTERVAL_SECONDS[interval],to=before??Date.now()/1000+1,from=Math.max(Date.parse(coverageStart)/1000,(Math.ceil(to/seconds)-200)*seconds);
 const lastProvider=(base?.candles??[]).filter(c=>c.time<to).reduce<number|null>((n,c)=>n===null||c.time>n?c.time:n,null),current=Math.floor(Date.now()/1000/seconds)*seconds;
 const bars=new Map<number,{bar:Candle;first:OnchainTrade;last:OnchainTrade}>();let last:OnchainTrade|undefined;
 for(const t of rows){const at=Date.parse(t.at)/1000,time=Math.floor(at/seconds)*seconds,price=Number(t.priceQuote),volume=Number(t.quoteAmount);
  if(at<from||at>=to||lastProvider!==null&&(time<=lastProvider||time!==current)||!(price>0)||!Number.isFinite(price)||!Number.isFinite(volume))continue;
  const b=bars.get(time);if(b){b.bar.high=Math.max(b.bar.high,price);b.bar.low=Math.min(b.bar.low,price);b.bar.volume+=volume;if(order(t,b.first)<0){b.first=t;b.bar.open=price;}if(order(t,b.last)>0){b.last=t;b.bar.close=price;}}else bars.set(time,{bar:{time,open:price,high:price,low:price,close:price,volume},first:t,last:t});
  if(!last||order(t,last)>0)last=t;
 }
 return composeCandles(base,{providerLastBar:lastProvider,quoteSymbol:last?.quoteSymbol??null,candles:[...bars.values()].map(b=>b.bar).sort((a,b)=>a.time-b.time).slice(-200),watermark:last?mark(last):null},coverageStart,currentQuote(q),last);
}
