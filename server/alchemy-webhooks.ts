import { createHash } from "node:crypto";
import { z } from "zod";
import { contractsFor } from "../src/lib/config";
import { NETWORKS,V3_TOPIC,V4_TOPIC,type SwapPool } from "./swap-stream";
import type { SwapStore } from "./swap-store";
const hookSchema=z.object({id:z.string(),network:z.string(),webhook_type:z.string(),webhook_url:z.string().url(),is_active:z.boolean(),signing_key:z.string().min(1),name:z.string().optional()});
export type NotifyHook=z.infer<typeof hookSchema>;
export type Binding={id:string;network:string;key:string;retireAt?:number;generation?:number};
export type NotifyState={hash:string;checkedAt:number;bindings:Binding[]};
export class NotifyClient{
 constructor(private token:string,private fetcher:typeof fetch=(input,init)=>fetch(input,init)){}
 private async request(path:string,method="GET",body?:unknown){
  let response:Response;try{response=await this.fetcher(`https://dashboard.alchemy.com/api/${path}`,{method,headers:{"X-Alchemy-Token":this.token,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15_000),redirect:"manual"});}catch{throw Error("Notify request unavailable");}
  if(!response.ok)throw Error(`Notify request rejected (${response.status})`);
  try{return await response.json() as any;}catch{throw Error("Notify response invalid");}
 }
 async list():Promise<NotifyHook[]>{const body=await this.request("team-webhooks");return z.array(hookSchema).parse(body.data);}
 async create(body:ReturnType<typeof desiredWebhook>):Promise<NotifyHook>{return hookSchema.parse((await this.request("create-webhook","POST",body)).data);}
 async remove(id:string){await this.request(`delete-webhook?webhook_id=${encodeURIComponent(id)}`,"DELETE");}
}
export function desiredWebhook(chainId:4663|8453,pools:SwapPool[],url:string){
 const ids=[...new Set(pools.filter(p=>p.version===4).map(p=>p.pool.toLowerCase()))].sort();
 if(ids.some(id=>!/^0x[\da-f]{64}$/.test(id)))throw Error("Invalid registered pool id");
 const fields="index topics data account { address } transaction { hash from { address } }";
 const v4=ids.length?`v4: logs(filter: {addresses: ["${contractsFor({mode:chainId===4663?"robinhood":"base",deploymentChainId:chainId}).poolManager.toLowerCase()}"], topics: [["${V4_TOPIC}"], ${JSON.stringify(ids)}]}) { ${fields} }`:"";
 const v3=pools.filter(p=>p.version===3);if(v3.some(p=>!/^0x[\da-f]{40}$/.test(p.pool)))throw Error("Invalid V3 pool");
 const query=`{ block { hash number timestamp ${v4} ${v3.length?`v3: logs(filter: {addresses: ${JSON.stringify(v3.map(p=>p.pool))}, topics: [["${V3_TOPIC}"]]}) { ${fields} }`:""} } }`;
 const hash=createHash("sha256").update(JSON.stringify({chainId,pools,url,query})).digest("hex");
 return {network:NETWORKS[chainId],webhook_type:"GRAPHQL",webhook_url:`${url}?set=${hash}`,name:`musegod-swaps-${chainId}-${hash.slice(0,24)}`,graphql_query:{query,skip_empty_messages:true},hash};
}
export function webhookDiff(hooks:NotifyHook[],desired:ReturnType<typeof desiredWebhook>){const match=hooks.find(h=>h.network===desired.network&&new URL(h.webhook_url).href===new URL(desired.webhook_url).href&&h.webhook_type==="GRAPHQL"&&h.is_active);return {action:match?"keep":"create",name:desired.name,network:desired.network,url:desired.webhook_url,existingId:match?.id??null};}
/** Compare callback identity independently of the deterministic pool-set query. */
function sameCallback(a:string,b:string){const x=new URL(a),y=new URL(b);return x.origin===y.origin&&x.pathname===y.pathname;}
export async function reconcileWebhook(store:SwapStore,api:NotifyClient,chainId:4663|8453,pools:SwapPool[],url:string,now=Date.now()){
 const desired=desiredWebhook(chainId,pools,url),state=store.get<NotifyState>("notify");
 const attempt=store.get<{hash:string;failures:number;nextAt:number}>("notify-attempt");
 if(attempt?.hash===desired.hash&&now<attempt.nextAt)throw Error("Notify reconciliation retry is pending");
 if(state?.hash===desired.hash&&now-state.checkedAt<86400_000&&!(attempt?.failures))return;
 // Persist a short lease before remote work; eviction or timeout retries after one minute.
 const failures=attempt?.hash===desired.hash?attempt.failures:0;
 store.set("notify-attempt",{hash:desired.hash,failures:failures+1,nextAt:now+Math.min(3600_000,60_000*2**Math.min(failures,6))});
 try{
  const hooks=await api.list();let hook:NotifyHook|undefined;
  if(pools.length){hook=hooks.find(h=>h.id===webhookDiff(hooks,desired).existingId);
   if(!hook){const {hash:_hash,...body}=desired;hook=await api.create(body as typeof desired);}
   if(hook.network!==desired.network||!sameCallback(hook.webhook_url,desired.webhook_url)||new URL(hook.webhook_url).searchParams.get('set')!==desired.hash||hook.webhook_type!=="GRAPHQL"||!hook.is_active)throw Error("Notify identity mismatch");
  }
  const previous=state?.bindings.find(b=>!b.retireAt&&b.id!==hook?.id);
  const bindings:Binding[]=hook?[{id:hook.id,network:hook.network,key:hook.signing_key,generation:state?.bindings.find(b=>b.id===hook!.id)?.generation??now},...(previous?[{...previous,retireAt:now+5*60_000}]:[])]:[];
  // Store and verify the new key before deleting remote destinations. Only one superseded key survives briefly.
  store.set("notify",{hash:desired.hash,checkedAt:now,bindings});
  for(const old of hooks)if(old.id!==hook?.id&&sameCallback(old.webhook_url,url))await api.remove(old.id);
  store.set("notify-attempt",{hash:desired.hash,failures:0,nextAt:0});
 }catch{throw Error("Notify reconciliation unavailable");}
}
