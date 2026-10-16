import type {SwapPool} from './swap-stream';import type {OnchainTrade} from '../src/lib/swap-stream';
/** Display-only token reads: no payment reader, shared LI.FI reservation, or shared backoff. */
export class SwapQuotePrices{
 private cache=new Map<string,{at:number;value:Promise<OnchainTrade['quoteUsd']>;price:OnchainTrade['quoteUsd']}>();private budget={at:0,count:0};
 constructor(private fetcher:typeof fetch=fetch,private now=Date.now){}
 private key(p:SwapPool){return `${p.chainId}:${p.quote}:${p.quoteDecimals}`;}
 peek(p:SwapPool){const c=this.cache.get(this.key(p));return c&&this.now()-c.at<300_000?c.price:null;}
 async get(p:SwapPool):Promise<OnchainTrade['quoteUsd']>{
  const now=this.now(),key=this.key(p),cached=this.cache.get(key);if(cached&&now-cached.at<300_000)return cached.value;
  if(now-this.budget.at>=60_000)this.budget={at:now,count:0};if(this.budget.count>=2)return null;this.budget.count++;
  const entry={at:now,price:null as OnchainTrade['quoteUsd'],value:Promise.resolve(null) as Promise<OnchainTrade['quoteUsd']>};
  entry.value=(async()=>{try{
   const r=await this.fetcher(`https://li.quest/v1/token?chain=${p.chainId}&token=${p.quote}`,{redirect:'manual',signal:AbortSignal.timeout(3000)});
   if(!r.ok||!r.body)return null;const reader=r.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
   try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>16_384){await reader.cancel();return null;}chunks.push(next.value);}}finally{reader.releaseLock();}
   const data=JSON.parse(Buffer.concat(chunks).toString()),price=Number(data.priceUSD);
   if(data.address?.toLowerCase()!==p.quote||data.chainId!==p.chainId||data.decimals!==p.quoteDecimals||!(price>0)||!Number.isFinite(price))return null;
   return entry.price={price,source:'LI.FI' as const,at:new Date(now).toISOString()};
  }catch{return null;}})();
  if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,entry);return entry.value;
 }
}
