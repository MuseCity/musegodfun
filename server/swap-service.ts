import { timingSafeEqual } from "node:crypto";
import type { CandleData,ChartInterval,MarketSummary,TradeData } from "../src/lib/market";
import { mergeCandles,mergeSummary,mergeTrades } from "../src/lib/swap-market";
import type { OnchainTrade,SwapMessage } from "../src/lib/swap-stream";
import { decodeDelivery,NETWORKS,verifySignature,type SwapPool } from "./swap-stream";
import { NotifyClient,reconcileWebhook,type NotifyState } from "./alchemy-webhooks";
import type { SwapStore } from "./swap-store";
import { MarketUnavailable } from "./snapshots";
export const WEBHOOK_BODY_LIMIT=1_048_576;
export const isWebhookPath=(path:string)=>/^\/api\/(?:chains\/(?:4663|8453)\/)?webhooks\/alchemy$/.test(path.split('?')[0]);
export class SwapService {
 private pending=Promise.resolve();private reconciling?:Promise<void>;private rate={at:0,count:0};private active=0;
 readonly listeners=new Set<(message:SwapMessage)=>void>();
 constructor(readonly chainId:4663|8453,readonly store:SwapStore,private options:{pools():Promise<SwapPool[]>;token?:string;quote?(pool:SwapPool):Promise<OnchainTrade['quoteUsd']>;broadcast?(message:SwapMessage):void}){}
 async pool(id:string){return (await this.options.pools()).find(p=>p.pool===id.toLowerCase());}
 authorized(value:string|undefined){const token=this.options.token;return !!token&&!!value&&Buffer.byteLength(value)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));}
 async reconcile(origin:string){
  if(!this.options.token)return;
  if(this.reconciling)return this.reconciling;
  const run=async()=>reconcileWebhook(this.store,new NotifyClient(this.options.token!),this.chainId,await this.options.pools(),`${origin}/api/chains/${this.chainId}/webhooks/alchemy`);
  this.reconciling=run();try{await this.reconciling;}finally{this.reconciling=undefined;}
 }
 admitWebhook(){
  const now=Date.now();if(now-this.rate.at>=60_000)this.rate={at:now,count:0};
  if(++this.rate.count>600||this.active>=8)return {status:429,release:()=>{}};
  this.active++;let released=false;return {status:0,release:()=>{if(!released){released=true;this.active--;}}};
 }
 async ingest(raw:Uint8Array,signature:string|undefined){
  if(raw.byteLength>WEBHOOK_BODY_LIMIT)return {status:413};
  const now=Date.now();
  let binding;try{const b=JSON.parse(new TextDecoder().decode(raw));binding=this.store.get<NotifyState>('notify')?.bindings.find(k=>k.id===b.webhookId&&k.network===NETWORKS[this.chainId]&&(!k.retireAt||k.retireAt>now));}catch{return {status:400};}
  if(!binding||!verifySignature(raw,signature,binding.key))return {status:401};
  let delivery,pools:SwapPool[];try{pools=await this.options.pools();delivery=decodeDelivery(new TextDecoder().decode(raw),binding,pools);delivery.generation=binding.generation??0;}catch{return {status:400};}
  // Read quote identities through the existing cached payment-price boundary. Old receipts never borrow today's USD price.
  const prices=new Map<string,OnchainTrade['quoteUsd']>();
  await Promise.all([...new Set(delivery.trades.map(t=>t.pool))].map(async id=>{try{prices.set(id,await this.options.quote?.(pools.find(p=>p.pool===id)!));}catch{prices.set(id,null);}}));
  for(const t of delivery.trades){const q=prices.get(t.pool),valid=q&&Math.abs(Date.parse(q.at)-Date.parse(t.at))<=60_000&&q.price>0&&Number.isFinite(q.price);const price=valid?Number(t.priceQuote)*q.price:null,usd=valid?Number(t.quoteAmount)*q.price:null;
   Object.assign(t,{quoteUsd:valid?q:null,priceUsd:price&&Number.isFinite(price)?price:null,usd:usd!==null&&Number.isFinite(usd)?usd:null});}
  const commit=()=>{const result=this.store.apply(delivery);for(const pool of new Set([...result.trades.map(t=>t.pool),...result.removedPools])){
   const rows=result.trades.filter(t=>t.pool===pool);
   for(let offset=0;offset<Math.max(1,rows.length);offset+=200){
   const message:SwapMessage={type:'trades',chainId:this.chainId,pool,trades:rows.slice(offset,offset+200),reorg:result.reorg,blockNumber:delivery.blockNumber,blockHash:delivery.blockHash,coverageStart:this.store.coverage(pool)??new Date(delivery.timestamp*1000).toISOString()};
   this.options.broadcast?.(message);for(const listener of this.listeners)listener(message);
  }}};
  const done=this.pending.then(commit);this.pending=done.catch(()=>{});await done;return {status:200};
 }
 async serve(section:'summary'|'trades'|'candles',pool:string,provider:()=>Promise<any>,interval:ChartInterval='1h',before?:number):Promise<any>{
  let base:any=null;try{base=await provider();}catch(e){if(!(e instanceof MarketUnavailable)||!this.store.coverage(pool))throw e;}
  const coverage=this.store.coverage(pool);if(!coverage)return base;const rows=this.store.rows(pool);
  if(section==='summary')return mergeSummary(base as MarketSummary|null,rows,coverage);
  if(section==='trades')return mergeTrades(base as TradeData|null,rows,coverage);
  return mergeCandles(base as CandleData|null,rows,coverage,interval,before);
 }
}
