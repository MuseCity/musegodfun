import {INTERVAL_SECONDS} from './candle-history';
import {afterWatermark,composeCandles,mergeSummary,mergeTrades,type OwnCandles} from './swap-market';
import type {CandleData,ChartInterval,MarketSummary,TradeData} from './market';import type {SwapMessage} from './swap-stream';
export type SwapSections={summary:MarketSummary|null;candles:CandleData|null;trades:TradeData|null};
/** Apply each log once per section: rows at or below a section's own-trade watermark are already reflected there (a REST snapshot may
 * carry a better USD conversion of the same trade, or a later log of the same block), so they never overwrite it. Own candles accumulate
 * in quote units after the provider's last returned bar, independent of any provider watermark, and the whole own portion is shown with
 * the push's current quote, exactly as the REST merge would serve it. */
export function applySwapPush(current:SwapSections,message:SwapMessage,interval:ChartInterval):SwapSections{
 const rows=[...message.trades].sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex),last=rows.at(-1);if(!last)return current;
 const summaryRows=rows.filter(t=>afterWatermark(t,current.summary?.watermark)),tradeRows=rows.filter(t=>afterWatermark(t,current.trades?.watermark));
 const summary=summaryRows.length?mergeSummary(current.summary,summaryRows,message.coverageStart):current.summary;
 const trades=tradeRows.length?mergeTrades(current.trades,tradeRows,message.coverageStart):current.trades,old=current.candles;
 // A response served before coverage began carries provider bars only.
 const own:OwnCandles=old?.own??{providerLastBar:old?.candles.length?old.candles.reduce((n,c)=>Math.max(n,c.time),-Infinity):null,quoteSymbol:null,candles:[],watermark:null};
 const w=own.watermark,fresh=rows.filter(t=>!w||t.blockNumber>w.blockNumber||t.blockNumber===w.blockNumber&&t.logIndex>w.logIndex);
 if(!fresh.length)return summary===current.summary&&trades===current.trades?current:{...current,summary,trades};
 const seconds=INTERVAL_SECONDS[interval],bucket=Math.floor(Date.now()/1000/seconds)*seconds,candles=own.candles.map(c=>({...c}));
 for(const t of fresh){const time=Math.floor(Date.parse(t.at)/1000/seconds)*seconds,price=Number(t.priceQuote),volume=Number(t.quoteAmount);
  if(own.providerLastBar!==null&&(time<=own.providerLastBar||time!==bucket)||!(price>0)||!Number.isFinite(price)||!Number.isFinite(volume))continue;
  const bar=candles.find(c=>c.time===time);if(bar){bar.high=Math.max(bar.high,price);bar.low=Math.min(bar.low,price);bar.close=price;bar.volume+=volume;}else candles.push({time,open:price,high:price,low:price,close:price,volume});
 }
 const next:OwnCandles={...own,quoteSymbol:own.quoteSymbol??last.quoteSymbol,candles:candles.sort((a,b)=>a.time-b.time).slice(-200),watermark:{blockNumber:last.blockNumber,logIndex:last.logIndex,txHash:last.hash}};
 return {summary,trades,candles:composeCandles(old,next,message.coverageStart,last.quoteUsd??null,last)};
}
