import type {SwapPool} from './swap-stream';import {withDeadline} from './deadline';import type {OnchainTrade} from '../src/lib/swap-stream';
/** Display-only token reads: no payment reader, shared LI.FI reservation, or shared backoff. */
export class SwapQuotePrices{
 private cache=new Map<string,{at:number;ttl:number;value:Promise<OnchainTrade['quoteUsd']>;price:OnchainTrade['quoteUsd']}>();private budgets=new Map<number,{at:number;count:number}>();
 // workerd rejects the global fetch called as a method ("Illegal invocation"), so the default calls it unbound.
 constructor(private fetcher:typeof fetch=(input,init)=>fetch(input,init),private now=Date.now,private apiKey?:string){}
 private key(p:SwapPool){return `${p.chainId}:${p.quote}:${p.quoteDecimals}`;}
 peek(p:SwapPool){const c=this.cache.get(this.key(p));return c&&this.now()-c.at<c.ttl?c.price:null;}
 async get(p:SwapPool):Promise<OnchainTrade['quoteUsd']>{
  const now=this.now(),key=this.key(p),cached=this.cache.get(key);if(cached&&now-cached.at<cached.ttl)return cached.value;
  let budget=this.budgets.get(p.chainId);if(!budget||now-budget.at>=60_000){budget={at:now,count:0};this.budgets.set(p.chainId,budget);}if(budget.count>=2)return null;budget.count++;
  const entry={at:now,ttl:300_000,price:null as OnchainTrade['quoteUsd'],value:Promise.resolve(null) as Promise<OnchainTrade['quoteUsd']>};
  entry.value=(async()=>{try{return await withDeadline(3000,async signal=>{
   const r=await this.fetcher(`https://li.quest/v1/token?chain=${p.chainId}&token=${p.quote}`,{redirect:'manual',signal,...(this.apiKey?{headers:{'x-lifi-api-key':this.apiKey}}:{})});
   if(!r.ok||!r.body)return null;const reader=r.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
   try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>16_384){await reader.cancel();return null;}chunks.push(next.value);}}finally{reader.releaseLock();}
   const data=JSON.parse(Buffer.concat(chunks).toString()),price=Number(data.priceUSD);
   if(data.address?.toLowerCase()!==p.quote||data.chainId!==p.chainId||data.decimals!==p.quoteDecimals||!(price>0)||!Number.isFinite(price))return null;
   return entry.price={price,source:'LI.FI' as const,at:new Date(now).toISOString()};
  });}catch{return null;}finally{if(!entry.price)entry.ttl=60_000;}})();
  if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,entry);return entry.value;
 }
}
