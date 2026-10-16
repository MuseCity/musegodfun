import type { CandleData,ChartInterval,MarketSummary,TradeData } from "../src/lib/market";
import { INTERVAL_SECONDS } from "../src/lib/candle-history";
import { mergeCandles,mergeCandleBuckets,mergeSummary,mergeTrades,priceTrade } from "../src/lib/swap-market";
import type { OnchainTrade,SwapMessage } from "../src/lib/swap-stream";
import { decodeDelivery,NETWORKS,verifySignature,type SwapPool } from "./swap-stream";
import { NotifyClient,reconcileWebhook,NOTIFY_RECONCILE_BUDGET_MS,type NotifyState,type NotifyAttempt } from "./alchemy-webhooks";
import { order,SwapCapacityError,type SwapStore } from "./swap-store";
import {clientBucket} from './abuse';
import { MarketUnavailable } from "./snapshots";
export const WEBHOOK_BODY_LIMIT=1_048_576;
/** A body that never completes holds one of eight pre-read slots for up to 10 s, so two failed reads exhaust a source's 120/min budget. */
export const WEBHOOK_READ_FAILURE_COST=60;
export const SWAP_MAINTENANCE_BUDGET_MS=10_000,SWAP_BLOCK_TIMEOUT_MS=2_000;
export const isWebhookPath=(path:string)=>/^\/api\/(?:chains\/(?:4663|8453)\/)?webhooks\/alchemy$/.test(path.split('?')[0]);
export class SwapService {
 private pending=Promise.resolve();private reconciling?:Promise<void>;private rate={at:0,count:0};private active=0;
 private clients=new Map<string,{at:number;count:number}>();private readers=new Map<string,number>();private reading=0;
 readonly listeners=new Set<(message:SwapMessage)=>void>();
 constructor(readonly chainId:4663|8453,readonly store:SwapStore,private options:{pools():Promise<SwapPool[]>;token?:string;quote?(pool:SwapPool):Promise<OnchainTrade['quoteUsd']>;quoteCached?(pool:SwapPool):OnchainTrade['quoteUsd'];blockHash?(block:number,signal:AbortSignal):Promise<string|null>;broadcast?(message:SwapMessage):void}){}
 status(){const a=this.store.get<NotifyAttempt>('notify-attempt');return {creationStopped:(a?.creationFailures??0)>=5,creationFailures:a?.creationFailures??0,retryAt:a?.nextAt??null,verificationAt:a?.verifyAt??null,...(a?.failures?{error:'Notify reconciliation unavailable'}:{})};}
 async pool(id:string){return (await this.options.pools()).find(p=>p.pool===id.toLowerCase());}
 async reconcile(origin:string){
  if(!this.options.token)return;if(this.reconciling)return this.reconciling;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Notify reconciliation timed out'));},NOTIFY_RECONCILE_BUDGET_MS);});
  this.reconciling=Promise.race([(async()=>{const pools=await this.options.pools();controller.signal.throwIfAborted();await reconcileWebhook(this.store,new NotifyClient(this.options.token!,undefined,controller.signal),this.chainId,pools,`${origin}/api/chains/${this.chainId}/webhooks/alchemy`);})(),expired]);
  try{await this.reconciling;}finally{clearTimeout(timer);controller.abort();this.reconciling=undefined;}
 }
 /** Failed HMAC verification and failed pre-HMAC reads spend a source bucket; signature/length rejections and authenticated schema errors do not. */
 private spend(key:string,cost:number){
  const now=Date.now(),old=this.clients.get(key),row=old&&now-old.at<60_000?old:{at:now,count:0};
  this.clients.delete(key);this.clients.set(key,row);if(this.clients.size>10_000)this.clients.delete(this.clients.keys().next().value!);
  return row.count+=cost;
 }
 private rejectWebhook(ip:string){return this.spend(clientBucket(ip),1)>120?429:401;}
 /** `fail` marks a read that timed out, aborted, errored or differed from its declared length; it is a no-op once released at HMAC. */
 admitWebhook(ip='unknown',signature?:string,length?:string|null,transferEncoding?:string|null){
  const key=clientBucket(ip),row=this.clients.get(key),reject=(status:number)=>({status,release:()=>{},fail:()=>{}});
  if(row&&Date.now()-row.at<60_000&&row.count>=120)return reject(429);
  if(!signature||!/^[\da-f]{64}$/i.test(signature))return reject(401);
  if(length==null)return reject(411);if(!/^\d+$/.test(length)||transferEncoding)return reject(400);
  const size=Number(length);if(!Number.isSafeInteger(size)||size>WEBHOOK_BODY_LIMIT)return reject(413);
  if(this.reading>=8||(this.readers.get(key)??0)>=2)return reject(429);
  this.reading++;this.readers.set(key,(this.readers.get(key)??0)+1);let done=false;
  const release=()=>{if(done)return;done=true;this.reading--;const remaining=this.readers.get(key)!-1;if(remaining)this.readers.set(key,remaining);else this.readers.delete(key);};
  return {status:0,release,fail:()=>{if(done)return;this.spend(key,WEBHOOK_READ_FAILURE_COST);release();}};
 }
 private publish(message:SwapMessage){this.options.broadcast?.(message);for(const listener of this.listeners)listener(message);}
 async ingest(raw:Uint8Array,signature:string|undefined,ip='unknown',release=()=>{}){
  // HMAC raw bytes against at most current + immediately superseded key, before any decoding or JSON parsing.
  const now=Date.now();let binding:NotifyState['bindings'][number]|undefined;
  try{if(raw.byteLength>WEBHOOK_BODY_LIMIT)return {status:413};binding=this.store.get<NotifyState>('notify')?.bindings.filter(k=>k.network===NETWORKS[this.chainId]&&(!k.retireAt||k.retireAt>now)).slice(0,2).find(k=>verifySignature(raw,signature,k.key));if(!binding)return {status:this.rejectWebhook(ip)};}finally{release();}
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
  return mergeCandles(base as CandleData|null,current>lastProvider&&current<to?this.store.window(pool,Math.max(from,current),Math.min(to,current+seconds)):[],coverage,interval,q,before);
 }
}
