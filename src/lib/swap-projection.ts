import {INTERVAL_SECONDS} from './candle-history';
import {mergeSummary,mergeTrades} from './swap-market';
import type {CandleData,ChartInterval,MarketSummary,TradeData} from './market';import type {SwapMessage} from './swap-stream';
export type SwapSections={summary:MarketSummary|null;candles:CandleData|null;trades:TradeData|null};
/** Apply each log once, retaining a candle watermark instead of a growing trade history. */
export function applySwapPush(current:SwapSections,message:SwapMessage,interval:ChartInterval):SwapSections{
 const rows=[...message.trades].sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex),last=rows.at(-1);if(!last)return current;
 const summary=mergeSummary(current.summary,rows,message.coverageStart),trades=mergeTrades(current.trades,rows,message.coverageStart),old=current.candles;
 const provider=old&&old.source!=='On-chain · Alchemy'||!!old?.historySource;
 const watermark=old?.watermark,seconds=INTERVAL_SECONDS[interval],fresh=rows.filter(t=>!watermark||t.blockNumber>watermark.blockNumber||t.blockNumber===watermark.blockNumber&&t.logIndex>watermark.logIndex);
 if(!fresh.length)return {...current,summary,trades};
 const usd=last.priceUsd!=null&&last.usd!=null,unit=usd?'USD':last.quoteSymbol;
 let candles=(old?.candles??[]).map(c=>({...c}));
 if(old?.unit&&old.unit!==unit){if(provider)return {...current,summary,trades};const ratio=(usd?last.quoteUsd?.price??1:1)/(old.unit==='USD'?old.quoteUsd?.price??1:1);candles=candles.map(c=>({...c,open:c.open*ratio,high:c.high*ratio,low:c.low*ratio,close:c.close*ratio,volume:c.volume*ratio}));}
 const providerEnd=provider?Math.max(-1,...(old?.candles??[]).filter(c=>!watermark||c.time<Math.floor(Date.parse(old!.fetchedAt)/1000/seconds)*seconds).map(c=>c.time)):-1;
 let applied=false;
 for(const t of fresh){const time=Math.floor(Date.parse(t.at)/1000/seconds)*seconds;if(provider&&(time<=providerEnd||time!==Math.floor(Date.now()/1000/seconds)*seconds||!usd))continue;
  const price=usd?t.priceUsd:Number(t.priceQuote),volume=usd?t.usd:Number(t.quoteAmount);if(price==null||volume==null||!(price>0)||!Number.isFinite(price)||!Number.isFinite(volume))continue;
  const bar=candles.find(c=>c.time===time);if(bar){bar.high=Math.max(bar.high,price);bar.low=Math.min(bar.low,price);bar.close=price;bar.volume+=volume;}else candles.push({time,open:price,high:price,low:price,close:price,volume});applied=true;
 }
 const result:CandleData|null=applied?{source:'On-chain · Alchemy',status:'fresh',fetchedAt:last.at,coverageStart:message.coverageStart,unit,quoteUsd:last.quoteUsd??null,candles:candles.sort((a,b)=>a.time-b.time).slice(-200),watermark:{blockNumber:last.blockNumber,logIndex:last.logIndex,txHash:last.hash},...(provider?{historySource:old?.historySource??old?.source,historyFetchedAt:old?.historyFetchedAt??old?.fetchedAt}:{})}:old;
 return {summary,trades,candles:result};
}
