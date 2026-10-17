import { useEffect,useRef,useState } from "react";
import { chainApi } from "../lib/api";
import { subscribeSwapStream,createGapRefresh,type LiveStatus } from "../lib/swap-live";
import {applySwapPush,type SwapSections} from '../lib/swap-projection';
import type { SwapMessage } from "../lib/swap-stream";
import type { ChartInterval } from "../lib/market";
import type { MusegodInfo } from "../lib/musegod";
export type SupplyInfo=Pick<MusegodInfo,"address"|"poolAddress"|"quoteAddress"|"decimals"|"totalSupply">;
type Rest=SwapSections;
export type LiveProjection=Rest&{basis:Rest&{interval:ChartInterval;info:SupplyInfo|null};priceAt:string|null;candlesAt:string|null;tradesAt:string|null};
export function liveValuesChanged(a:Rest,b:Rest){const values=(r:Rest)=>[r.summary?.priceUsd,r.summary?.priceQuote,r.candles?.candles,r.trades?.trades];return JSON.stringify(values(a))!==JSON.stringify(values(b));}
export default function SwapLive(props:Rest&{chainId:4663|8453;pool:string;path:string;interval:ChartInterval;info:SupplyInfo|null;onUpdate(value:LiveProjection|null):void}){
 const current=useRef(props);current.current=props;const displayed=useRef<LiveProjection|null>(null);
 const [status,setStatus]=useState<LiveStatus>({connected:false,receiving:false,receivedAt:null});
 useEffect(()=>{
  let active=true;const abort=new AbortController();
  function publish(next:Rest){const c=current.current,projection:LiveProjection={...next,basis:c,priceAt:next.summary?.source==='On-chain · Alchemy'?next.summary.lastTradeAt??null:null,candlesAt:next.candles?.source==='On-chain · Alchemy'?next.candles.lastTradeAt??null:null,tradesAt:next.trades?.source==='On-chain · Alchemy'?next.trades.lastTradeAt??null:null};displayed.current=projection;c.onUpdate(projection);}
  // Pushes applied while a recovery's REST reads are in flight are replayed over that snapshot, which may have been served before
  // they were stored; applySwapPush skips rows at or below each section's watermark, so nothing is listed, repriced or counted twice.
  // Each in-flight recovery keeps its own buffer. A recovery is stale, and publishes nothing, once a reorg signal arrived after it
  // started (its snapshot or buffer may hold orphaned rows; the recovery the signal requests supersedes it) or once a later recovery
  // has published (reads can complete out of order).
  const replays=new Set<SwapMessage[]>();let generation=0,sequence=0,published=0;
  const recovery=createGapRefresh(async()=>{
   const p=current.current,replay:SwapMessage[]=[],seq=++sequence,gen=generation;replays.add(replay);
   try{
    const [summary,candles,trades]=await Promise.all([chainApi<Rest['summary']>(p.chainId,`${p.path}/summary`,undefined,{retry:false,signal:abort.signal}),chainApi<Rest['candles']>(p.chainId,`${p.path}/candles?interval=${p.interval}`,undefined,{retry:false,signal:abort.signal}),chainApi<Rest['trades']>(p.chainId,`${p.path}/trades`,undefined,{retry:false,signal:abort.signal})]);
    if(!active||p.interval!==current.current.interval||gen!==generation||seq<published)return;
    let next:Rest={summary,candles,trades};for(const message of replay)next=applySwapPush(next,message,p.interval);
    published=seq;publish(next);
   }finally{replays.delete(replay);}
  });
  // A socket reopened after a failure, a close or a hidden tab missed every push broadcast meanwhile: one gated recovery catches up.
  // The synchronous initial status describes the shared socket; this consumer already has a fresh REST basis.
  let ready=false;
  const off=subscribeSwapStream(props.chainId,props.pool,{status:value=>{setStatus(value);if(ready&&value.connected&&value.resumed)recovery.request();},event:async message=>{
   if(message.reorg)generation++;
   if(message.reorg||message.gap){recovery.request();return false;}
   for(const replay of replays)replay.push(message);
   const c=current.current,previous=displayed.current,b=previous?.basis,visible=previous&&b?.summary===c.summary&&b.candles===c.candles&&b.trades===c.trades&&b.interval===c.interval?previous:c;
   const next=applySwapPush(visible,message,c.interval);const changed=liveValuesChanged(visible,next);if(changed&&active)publish(next);return changed;
  }});
  ready=true;
  return()=>{active=false;abort.abort();recovery.stop();off();displayed.current=null;current.current.onUpdate(null);};
 },[props.chainId,props.pool,props.path]);
 useEffect(()=>{if(!status.connected){displayed.current=null;current.current.onUpdate(null);}},[status.connected]);
 if(!status.connected||!status.receiving||status.receivedAt===null)return null;
 const received=new Date(status.receivedAt).toISOString();return <span className="feed-note" role="status">Live · On-chain · Received <time dateTime={received}>{new Date(received).toLocaleTimeString("en-US")}</time></span>;
}
