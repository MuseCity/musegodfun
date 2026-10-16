import type { CandleData,ChartInterval,MarketSummary,TradeData } from "../src/lib/market";
import { INTERVAL_SECONDS } from "../src/lib/candle-history";
import { mergeCandles,mergeCandleBuckets,mergeSummary,mergeTrades,priceTrade } from "../src/lib/swap-market";
import type { OnchainTrade,SwapMessage } from "../src/lib/swap-stream";
import { decodeDelivery,NETWORKS,verifySignature,type SwapPool } from "./swap-stream";
import { NotifyClient,reconcileWebhook,type NotifyState,type NotifyAttempt } from "./alchemy-webhooks";
import { order,SwapCapacityError,type SwapStore } from "./swap-store";
import {clientBucket} from './abuse';
import { MarketUnavailable } from "./snapshots";
export const WEBHOOK_BODY_LIMIT=1_048_576;
export const SWAP_MAINTENANCE_BUDGET_MS=10_000,SWAP_BLOCK_TIMEOUT_MS=2_000;
export const isWebhookPath=(path:string)=>/^\/api\/(?:chains\/(?:4663|8453)\/)?webhooks\/alchemy$/.test(path.split('?')[0]);
export class SwapService {
 private pending=Promise.resolve();private reconciling?:Promise<void>;private rate={at:0,count:0};private active=0;
 private clients=new Map<string,{at:number;count:number}>();
 readonly listeners=new Set<(message:SwapMessage)=>void>();
 constructor(readonly chainId:4663|8453,readonly store:SwapStore,private options:{pools():Promise<SwapPool[]>;token?:string;quote?(pool:SwapPool):Promise<OnchainTrade['quoteUsd']>;quoteCached?(pool:SwapPool):OnchainTrade['quoteUsd'];blockHash?(block:number,signal:AbortSignal):Promise<string|null>;broadcast?(message:SwapMessage):void}){}
 status(){const a=this.store.get<NotifyAttempt>('notify-attempt');return {creationStopped:(a?.creationFailures??0)>=5,creationFailures:a?.creationFailures??0,retryAt:a?.nextAt??null,verificationAt:a?.verifyAt??null,...(a?.failures?{error:'Notify reconciliation unavailable'}:{})};}
 async pool(id:string){return (await this.options.pools()).find(p=>p.pool===id.toLowerCase());}
 async reconcile(origin:string){
  if(!this.options.token)return;if(this.reconciling)return this.reconciling;
  this.reconciling=(async()=>reconcileWebhook(this.store,new NotifyClient(this.options.token!),this.chainId,await this.options.pools(),`${origin}/api/chains/${this.chainId}/webhooks/alchemy`))();
  try{await this.reconciling;}finally{this.reconciling=undefined;}
 }
 /** Only rejected, unverified requests spend a source bucket. HMAC is synchronous, before any processing await. */
 rejectWebhook(ip:string,status:number){
  const now=Date.now(),key=clientBucket(ip),old=this.clients.get(key),row=old&&now-old.at<60_000?old:{at:now,count:0};
  this.clients.delete(key);this.clients.set(key,row);if(this.clients.size>10_000)this.clients.delete(this.clients.keys().next().value!);
  return ++row.count>120?429:status;
 }
 admitWebhook(ip='unknown',signature?:string){
  return {status:signature&&/^[\da-f]{64}$/i.test(signature)?0:this.rejectWebhook(ip,401)};
 }
 private publish(message:SwapMessage){this.options.broadcast?.(message);for(const listener of this.listeners)listener(message);}
 async ingest(raw:Uint8Array,signature:string|undefined,ip='unknown'){
  if(raw.byteLength>WEBHOOK_BODY_LIMIT)return {status:this.rejectWebhook(ip,413)};
  // HMAC raw bytes against at most current + immediately superseded key, before any decoding or JSON parsing.
  const now=Date.now(),binding=this.store.get<NotifyState>('notify')?.bindings.filter(k=>k.network===NETWORKS[this.chainId]&&(!k.retireAt||k.retireAt>now)).slice(0,2).find(k=>verifySignature(raw,signature,k.key));
  if(!binding)return {status:this.rejectWebhook(ip,401)};
  if(now-this.rate.at>=60_000)this.rate={at:now,count:0};if(this.rate.count>=600||this.active>=8)return {status:429};this.rate.count++;this.active++;
  try{
   let delivery,pools:SwapPool[];try{pools=await this.options.pools();delivery=decodeDelivery(new TextDecoder().decode(raw),binding,pools);delivery.generation=binding.generation??0;}catch{return {status:400};}
   const commit=()=>{const previous=new Map([...new Set(delivery.trades.map(t=>t.pool))].map(pool=>[pool,this.store.rows(pool,1)[0]]));const result=this.store.apply(delivery);for(const pool of new Set([...result.trades.map(t=>t.pool),...result.removedPools])){
    const descriptor=pools.find(p=>p.pool===pool),q=descriptor?this.options.quoteCached?.(descriptor):null,rows=result.trades.filter(t=>t.pool===pool).sort(order).map(t=>priceTrade(t,q)),last=previous.get(pool),gap=!!last&&rows.some(t=>order(t,last)<=0);
    for(let offset=0;offset<Math.max(1,rows.length);offset+=200)this.publish({type:'trades',chainId:this.chainId,pool,trades:rows.slice(offset,offset+200),reorg:result.reorg,...(gap?{gap:true}:{}),blockNumber:delivery.blockNumber,blockHash:delivery.blockHash,coverageStart:this.store.coverage(pool)??new Date(delivery.timestamp*1000).toISOString()});
   }};
   const done=this.pending.then(commit);this.pending=done.catch(()=>{});try{await done;}catch(error){if(!(error instanceof SwapCapacityError))throw error;
    for(const pool of new Set(delivery.trades.map(t=>t.pool)))this.publish({type:'trades',chainId:this.chainId,pool,trades:[],reorg:false,gap:true,blockNumber:delivery.blockNumber,blockHash:delivery.blockHash,coverageStart:this.store.coverage(pool)??new Date(delivery.timestamp*1000).toISOString()});
    return {status:503};
   }return {status:200};
  }finally{this.active--;}
 }
 async maintain(now=Date.now()){
  const deadline=Date.now()+SWAP_MAINTENANCE_BUDGET_MS;
  this.store.prune(now,500);
  if(!this.options.blockHash)return;
  for(const b of this.store.pendingBlocks(Math.floor(now/1000)-120,10)){
   const remaining=deadline-Date.now();if(remaining<=0)break;
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   let hash:string|null;try{hash=await Promise.race([this.options.blockHash(b.block,controller.signal),new Promise<null>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},Math.min(remaining,SWAP_BLOCK_TIMEOUT_MS));})]);}catch{continue;}finally{clearTimeout(timer);controller.abort();}if(!hash||!/^0x[\da-f]{64}$/i.test(hash))continue;
   hash=hash.toLowerCase();for(const pool of this.store.verifyBlock(b.block,b.hash,hash))this.publish({type:'trades',chainId:this.chainId,pool,trades:[],reorg:true,blockNumber:b.block,blockHash:hash,coverageStart:this.store.coverage(pool)??new Date(now).toISOString()});
  }
 }
 async serve(section:'summary'|'trades'|'candles',pool:string,provider:()=>Promise<any>,interval:ChartInterval='1h',before?:number):Promise<any>{
  let base:any=null;try{base=await provider();}catch(e){if(!(e instanceof MarketUnavailable)||!this.store.coverage(pool))throw e;}
  const coverage=this.store.coverage(pool);if(!coverage)return base;
  const descriptor=await this.pool(pool);let q:OnchainTrade['quoteUsd']=null;try{if(descriptor)q=await this.options.quote?.(descriptor);}catch{}
  if(section==='summary')return mergeSummary(base as MarketSummary|null,this.store.rows(pool,1).map(t=>priceTrade(t,q)),coverage);
  if(section==='trades')return mergeTrades(base as TradeData|null,this.store.rows(pool,30).map(t=>priceTrade(t,q)),coverage);
  const seconds=INTERVAL_SECONDS[interval],to=before??Date.now()/1000+1,from=Math.max(Date.parse(coverage)/1000,(Math.ceil(to/seconds)-200)*seconds);
  const providerBars=(base?.candles??[]).filter((c:CandleData['candles'][number])=>c.time<to);
  if(!providerBars.length)return mergeCandleBuckets(base,this.store.buckets(pool,from,to,seconds),coverage,q);
  const current=Math.floor(Date.now()/1000/seconds)*seconds,lastProvider=Math.max(...providerBars.map((c:CandleData['candles'][number])=>c.time));
  const raw=current>lastProvider&&current<to?this.store.window(pool,Math.max(from,current),Math.min(to,current+seconds)):[];function* priced(){for(const t of raw)yield priceTrade(t,q);}
  return mergeCandles(base as CandleData|null,priced(),coverage,interval,before);
 }
}
