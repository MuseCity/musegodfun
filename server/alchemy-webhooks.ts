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
export function webhookDiff(hooks:NotifyHook[],desired:ReturnType<typeof desiredWebhook>){const match=hooks.find(h=>h.network===desired.network&&h.webhook_url===desired.webhook_url&&h.webhook_type==="GRAPHQL"&&h.is_active);return {action:match?"keep":"create",name:desired.name,network:desired.network,url:desired.webhook_url,existingId:match?.id??null};}
/** The API does not document GraphQL query updates; replacement overlaps signing keys for 24 hours. */
export async function reconcileWebhook(store:SwapStore,api:NotifyClient,chainId:4663|8453,pools:SwapPool[],url:string,now=Date.now()){
 const desired=desiredWebhook(chainId,pools,url),state=store.get<NotifyState>("notify");
 if(state?.hash===desired.hash&&now-state.checkedAt<86400_000)return;
 const attempt=store.get<{hash:string;at:number}>("notify-attempt");if(attempt?.hash===desired.hash&&now-attempt.at<86400_000)throw Error("Notify reconciliation retry is pending");
 store.set("notify-attempt",{hash:desired.hash,at:now});
 const hooks=await api.list();
 // Empty Base registry must never install an unfiltered block webhook.
 if(!pools.length){store.set("notify",{hash:desired.hash,checkedAt:now,bindings:state?.bindings??[]});return;}
 const diff=webhookDiff(hooks,desired);
 let hook=hooks.find(h=>h.id===diff.existingId);
 if(!hook){const {hash:_hash,...body}=desired;hook=await api.create(body as typeof desired);}
 if(hook.network!==desired.network||hook.webhook_url!==desired.webhook_url||hook.webhook_type!=="GRAPHQL"||!hook.is_active)throw Error("Notify identity mismatch");
 const bindings:Binding[]=[{id:hook.id,network:hook.network,key:hook.signing_key,generation:state?.bindings.find(b=>b.id===hook.id)?.generation??now},...(state?.bindings??[]).filter(b=>b.id!==hook.id).map(b=>({...b,retireAt:b.retireAt??now+86400_000}))];
 // Persist the new key before retiring any old destination; early deliveries can retry safely.
 store.set("notify",{hash:desired.hash,checkedAt:now,bindings});
 let remaining=bindings;
 for(const b of bindings.filter(b=>b.retireAt&&b.retireAt<=now)){await api.remove(b.id);remaining=remaining.filter(x=>x.id!==b.id);store.set("notify",{hash:desired.hash,checkedAt:now,bindings:remaining});}
}
