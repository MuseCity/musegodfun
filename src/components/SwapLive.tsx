import { useEffect,useRef,useState } from "react";
import { chainApi } from "../lib/api";
import { subscribeSwapStream,type LiveStatus } from "../lib/swap-live";
import type { CandleData,ChartInterval,MarketSummary,TradeData } from "../lib/market";
import type { MusegodInfo } from "../lib/musegod";
export type SupplyInfo=Pick<MusegodInfo,"address"|"poolAddress"|"quoteAddress"|"decimals"|"totalSupply">;
type Rest={summary:MarketSummary|null;candles:CandleData|null;trades:TradeData|null};
export type LiveProjection=Rest&{basis:Rest&{interval:ChartInterval;info:SupplyInfo|null};priceAt:string|null;candlesAt:string|null;tradesAt:string|null};
export function liveValuesChanged(a:Rest,b:Rest){const values=(r:Rest)=>[r.summary?.priceUsd,r.summary?.priceQuote,r.candles?.candles,r.trades?.trades];return JSON.stringify(values(a))!==JSON.stringify(values(b));}
/** A committed push invalidates the three independently cached REST sections. One coalesced read also handles reorg removals. */
export default function SwapLive(props:Rest&{chainId:4663|8453;pool:string;path:string;interval:ChartInterval;info:SupplyInfo|null;onUpdate(value:LiveProjection|null):void}){
 const current=useRef(props);current.current=props;const displayed=useRef<LiveProjection|null>(null);
 const [status,setStatus]=useState<LiveStatus>({connected:false,receiving:false,receivedAt:null});
 useEffect(()=>{
  let active=true,running:Promise<boolean>|null=null,dirty=false;const abort=new AbortController();
  async function refresh():Promise<boolean>{
   dirty=true;if(running)return running;
   running=(async()=>{let changed=false;do{dirty=false;const p=current.current;
    const [summary,candles,trades]=await Promise.all([chainApi<MarketSummary>(p.chainId,`${p.path}/summary`,undefined,{retry:false,signal:abort.signal}).catch(()=>p.summary),chainApi<CandleData>(p.chainId,`${p.path}/candles?interval=${p.interval}`,undefined,{retry:false,signal:abort.signal}).catch(()=>p.candles),chainApi<TradeData>(p.chainId,`${p.path}/trades`,undefined,{retry:false,signal:abort.signal}).catch(()=>p.trades)]);
    if(!active)return false;if(p.interval!==current.current.interval){dirty=true;continue;}
    const next={summary,candles,trades};const previous=displayed.current, basis=previous?.basis, c=current.current;
    const visible=previous&&basis?.summary===c.summary&&basis.candles===c.candles&&basis.trades===c.trades&&basis.interval===c.interval?previous:c;
    const valuesChanged=liveValuesChanged(visible,next);changed=valuesChanged||changed;
    const projection:LiveProjection={...next,basis:current.current,priceAt:summary?.source==='On-chain · Alchemy'?summary.lastTradeAt??null:null,candlesAt:candles?.source==='On-chain · Alchemy'?candles.fetchedAt:null,tradesAt:trades?.source==='On-chain · Alchemy'?trades.fetchedAt:null};displayed.current=projection;current.current.onUpdate(projection);
   }while(dirty&&active);return changed;})().finally(()=>{running=null;});return running;
  }
  const off=subscribeSwapStream(props.chainId,props.pool,{status:setStatus,event:refresh});
  return()=>{active=false;abort.abort();off();displayed.current=null;current.current.onUpdate(null);};
 },[props.chainId,props.pool,props.path]);
 useEffect(()=>{if(!status.connected){displayed.current=null;current.current.onUpdate(null);}},[status.connected]);
 if(!status.connected||!status.receiving||status.receivedAt===null)return null;
 const received=new Date(status.receivedAt).toISOString();return <span className="feed-note" role="status">Live · On-chain · Received <time dateTime={received}>{new Date(received).toLocaleTimeString("en-US")}</time></span>;
}
