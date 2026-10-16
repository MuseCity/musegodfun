import { INTERVAL_SECONDS } from "./candle-history";
import type { CandleData,ChartInterval,MarketSummary,MarketTrade,TradeData } from "./market";
import type { OnchainTrade } from "./swap-stream";
const source="On-chain · Alchemy" as const;
const order=(a:OnchainTrade,b:OnchainTrade)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;
const latest=(rows:OnchainTrade[])=>[...rows].sort(order).at(-1);
const meta=(base:{source?:TradeData['source'];fetchedAt:string}|null,rows:OnchainTrade[],coverageStart:string)=>({source,status:"fresh" as const,fetchedAt:latest(rows)?.at??coverageStart,coverageStart,...(base?{historySource:base.source,historyFetchedAt:base.fetchedAt}:{})});
export function tradeKey(t:MarketTrade){const log=t.logIndex??(/:(\d+)$/.exec(t.id)?.[1]);return log===undefined?t.id.toLowerCase():`${t.hash.toLowerCase()}:${log}`;}
export function mergeTrades(base:TradeData|null,rows:OnchainTrade[],coverageStart:string):TradeData{
 const map=new Map((base?.trades??[]).filter(t=>Date.parse(t.at)<Date.parse(coverageStart)).map(t=>[tradeKey(t),t]));
 for(const t of rows){const row:MarketTrade={id:t.id,hash:t.hash,logIndex:t.logIndex,blockNumber:t.blockNumber,account:t.account,at:t.at,side:t.side,amount:Number(t.amount),price:t.priceUsd??null,usd:t.usd??null,priceQuote:t.priceQuote,quoteAmount:t.quoteAmount,quoteSymbol:t.quoteSymbol,source};map.set(tradeKey(row),row);}
 return {...meta(base,rows,coverageStart),trades:[...map.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||(b.blockNumber??0)-(a.blockNumber??0)||(b.logIndex??0)-(a.logIndex??0)).slice(0,30)};
}
export function mergeSummary(base:MarketSummary|null,rows:OnchainTrade[],coverageStart:string):MarketSummary{
 const t=latest(rows);if(!t)return base&&(!base.lastTradeAt||Date.parse(base.lastTradeAt)<Date.parse(coverageStart))?base:{...meta(null,rows,coverageStart),priceUsd:null,fdvUsd:null,marketCapUsd:null,liquidityUsd:null,periods:{}};
 // fetchedAt is not a trade watermark; only a provider's explicit later trade proves a newer price.
 if(base?.lastTradeAt&&Date.parse(base.lastTradeAt)>Date.parse(t.at))return base;
 return {...base,...meta(base,rows,coverageStart),lastTradeAt:t.at,priceUsd:t.priceUsd??null,priceQuote:t.priceQuote,quoteSymbol:t.quoteSymbol,quoteUsd:t.quoteUsd??null,marketCapUsd:null,fdvUsd:null,liquidityUsd:base?.liquidityUsd??null,periods:base?.periods??{}};
}
export function mergeCandles(base:CandleData|null,rows:OnchainTrade[],coverageStart:string,interval:ChartInterval,before?:number):CandleData{
 const seconds=INTERVAL_SECONDS[interval],boundary=Math.floor(Date.parse(coverageStart)/1000/seconds)*seconds;
 const own=rows.filter(t=>Date.parse(t.at)>=Date.parse(coverageStart)&&(!before||Date.parse(t.at)/1000<before)).sort(order);
 const usd=own.every(t=>t.priceUsd!=null&&t.usd!=null),older=(base?.candles??[]).filter(c=>c.time<boundary);
 const bars=new Map<number,CandleData['candles'][number]>();
 for(const t of own){const time=Math.floor(Date.parse(t.at)/1000/seconds)*seconds,price=usd?t.priceUsd!:Number(t.priceQuote),volume=usd?t.usd!:Number(t.quoteAmount);if(!(price>0)||!Number.isFinite(price)||!Number.isFinite(volume))continue;
 const c=bars.get(time);bars.set(time,c?{...c,high:Math.max(c.high,price),low:Math.min(c.low,price),close:price,volume:c.volume+volume}:{time,open:price,high:price,low:price,close:price,volume});}
 const last=latest(own);
 return {...meta(base,own,coverageStart),unit:usd?'USD':own[0]?.quoteSymbol,quoteUsd:last?.quoteUsd??null,
 candles:[...(usd?older:[]),...bars.values()].sort((a,b)=>a.time-b.time).slice(-200),watermark:last?{blockNumber:last.blockNumber,logIndex:last.logIndex,txHash:last.hash}:null,
 ...(!usd&&older.length&&base?{history:{...base,candles:older}}:{})};
}
