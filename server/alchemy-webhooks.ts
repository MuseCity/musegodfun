import { createHash } from "node:crypto";
import { z } from "zod";
import { contractsFor } from "../src/lib/config";
import { NETWORKS,V3_TOPIC,V4_TOPIC,type SwapPool,type WebhookKind } from "./swap-stream";
import type { SwapStore } from "./swap-store";
const hookSchema=z.object({id:z.string(),network:z.string(),webhook_type:z.string(),webhook_url:z.string().url(),is_active:z.boolean(),signing_key:z.string().min(1),name:z.string().optional()});
export type NotifyHook=z.infer<typeof hookSchema>;
export type Binding={id:string;network:string;kind:WebhookKind;key:string;retireAt?:number;generation?:number};
export type NotifyState={hash:string;checkedAt:number;bindings:Binding[]};
/** `uncertain` marks a creation whose outcome is unknown (timeout, transport failure or eviction); the next orphan sweep resolves it. */
export type NotifyAttempt={hash:string;failures:number;nextAt:number;creationFailures?:number;createdId?:string;verifyAt?:number;uncertain?:boolean};
/** List/delete get 8 s; creation gets 15 s, all within the existing 30 s reconcile budget. */
export const NOTIFY_REQUEST_TIMEOUT_MS=8_000,NOTIFY_CREATE_TIMEOUT_MS=15_000,NOTIFY_RECONCILE_BUDGET_MS=30_000;
/** A deadline, cancellation or transport failure: the request may still have reached Alchemy. */
export class NotifyUnavailable extends Error{constructor(){super('Notify request unavailable');}}
export class NotifyClient{
 constructor(private token:string,private fetcher:typeof fetch=(input,init)=>fetch(input,init),private signal?:AbortSignal){}
 private async request(path:string,method="GET",body?:unknown,timeout=NOTIFY_REQUEST_TIMEOUT_MS){
  const controller=new AbortController();let fail!:()=>void;
  const expired=new Promise<never>((_,reject)=>{fail=()=>{controller.abort();reject(new NotifyUnavailable());};});
  const timer=setTimeout(fail,timeout);this.signal?.addEventListener('abort',fail,{once:true});if(this.signal?.aborted)fail();
  try{return await Promise.race([(async()=>{
   controller.signal.throwIfAborted();let response:Response;try{response=await this.fetcher(`https://dashboard.alchemy.com/api/${path}`,{method,headers:{"X-Alchemy-Token":this.token,"Content-Type":"application/json","User-Agent":"Musegod-Swap-Stream/1.0"},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:"manual"});}catch{throw new NotifyUnavailable();}
   controller.signal.throwIfAborted();if(!response.ok)throw Error(`Notify request rejected (${response.status})`);
   try{const data=await response.json() as any;controller.signal.throwIfAborted();return data;}catch{throw Error("Notify response invalid");}
  })(),expired]);}finally{clearTimeout(timer);this.signal?.removeEventListener('abort',fail);controller.abort();}
 }
 async list():Promise<NotifyHook[]>{const body=await this.request("team-webhooks");return z.array(hookSchema).parse(body.data);}
 async create(desired:ReturnType<typeof desiredWebhook>,created?:(id:string)=>void):Promise<NotifyHook>{const {network,webhook_type,webhook_url,name,graphql_query}=desired;const data=(await this.request("create-webhook","POST",{network,webhook_type,webhook_url,name,graphql_query},NOTIFY_CREATE_TIMEOUT_MS)).data;created?.(z.object({id:z.string().min(1)}).parse(data).id);return hookSchema.parse(data);}
 async remove(id:string){await this.request(`delete-webhook?webhook_id=${encodeURIComponent(id)}`,"DELETE");}
}
export const webhookKinds=(chainId:4663|8453):WebhookKind[]=>chainId===4663?['v4','v3']:['v4'];
export function desiredWebhook(chainId:4663|8453,pools:SwapPool[],url:string,kind:WebhookKind){
 if(!webhookKinds(chainId).includes(kind))throw Error('Unsupported webhook kind');
 const ids=[...new Set(pools.filter(p=>p.chainId===chainId&&p.version===(kind==='v4'?4:3)).map(p=>p.pool.toLowerCase()))].sort();
 if(ids.some(id=>!(kind==='v4'?/^0x[\da-f]{64}$/:/^0x[\da-f]{40}$/).test(id)))throw Error("Invalid registered pool id");
 const fields="index topics data account { address } transaction { hash from { address } }";
 const filter=kind==='v4'?`addresses: ["${contractsFor({mode:chainId===4663?"robinhood":"base",deploymentChainId:chainId}).poolManager.toLowerCase()}"], topics: [["${V4_TOPIC}"], ${JSON.stringify(ids)}]`:`addresses: ${JSON.stringify(ids)}, topics: [["${V3_TOPIC}"]]`;
 const query=`{ block { hash number timestamp logs(filter: {${filter}}) { ${fields} } } }`;
 const callback=new URL(url);callback.pathname+=`/${kind}`;callback.search='';callback.hash='';
 const hash=createHash("sha256").update(JSON.stringify({chainId,kind,url:callback.toString(),query})).digest("hex");
 callback.searchParams.set('set',hash);
 return {network:NETWORKS[chainId],webhook_type:"GRAPHQL",webhook_url:callback.toString(),name:`musegod-swaps-${chainId}-${kind}-${hash.slice(0,24)}`,graphql_query:{query,skip_empty_messages:true},hash};
}
export function webhookDiff(hooks:NotifyHook[],desired:ReturnType<typeof desiredWebhook>,storedId?:string){const match=hooks.find(h=>h.id===storedId&&validHook(h,desired));return {action:match?"keep":!storedId&&hooks.some(h=>sameCallback(h.webhook_url,desired.webhook_url))?"verify-runtime-binding":"create",name:desired.name,network:desired.network,url:desired.webhook_url,existingId:match?.id??null};}
/** Compare callback identity independently of the deterministic pool-set query. */
function sameCallback(a:string,b:string){const x=new URL(a),y=new URL(b);return x.origin===y.origin&&x.pathname===y.pathname;}
function validHook(h:NotifyHook,d:ReturnType<typeof desiredWebhook>){return h.network===d.network&&sameCallback(h.webhook_url,d.webhook_url)&&h.webhook_type==='GRAPHQL'&&h.is_active;}
export async function reconcileWebhook(store:SwapStore,api:NotifyClient,chainId:4663|8453,pools:SwapPool[],url:string,now=Date.now()){
 // The failed single-webhook production state has no binding. Its legacy counters never gate the new kinds.
 const active=webhookKinds(chainId).filter(kind=>pools.some(p=>p.chainId===chainId&&p.version===(kind==='v4'?4:3))||store.get<NotifyState>('notify-'+kind)||store.get<NotifyAttempt>('notify-attempt-'+kind));
 const results=await Promise.allSettled(active.map(kind=>reconcileKind(store,api,chainId,pools,url,kind,now)));
 if(results.some(r=>r.status==='rejected'))throw Error('Notify reconciliation unavailable');
}
async function reconcileKind(store:SwapStore,api:NotifyClient,chainId:4663|8453,pools:SwapPool[],url:string,kind:WebhookKind,now:number){
 const desired=desiredWebhook(chainId,pools,url,kind),stateKey='notify-'+kind,attemptKey='notify-attempt-'+kind,state=store.get<NotifyState>(stateKey);
 const attempt=store.get<NotifyAttempt>(attemptKey),hasPools=pools.some(p=>p.chainId===chainId&&p.version===(kind==='v4'?4:3));
 const bound=(id:string,otherOnly=false)=>webhookKinds(chainId).some(k=>(!otherOnly||k!==kind)&&store.get<NotifyState>('notify-'+k)?.bindings.some(b=>b.id===id));
 if(attempt?.hash===desired.hash&&now<attempt.nextAt)throw Error("Notify reconciliation retry is pending");
 if(state?.hash===desired.hash&&now-state.checkedAt<86400_000&&!(attempt?.failures))return;
 const same=attempt?.hash===desired.hash,failures=same?attempt.failures:0;
 const next:NotifyAttempt={hash:desired.hash,failures:failures+1,nextAt:now+Math.min(3600_000,60_000*2**Math.min(failures,6)),creationFailures:same?attempt.creationFailures??0:0,...(same&&attempt.createdId?{createdId:attempt.createdId}:{}),...(same&&attempt.verifyAt?{verifyAt:attempt.verifyAt}:{}),...(same&&attempt.uncertain?{uncertain:true}:{})};
 const stopped=(next.creationFailures??0)>=5;
 if(stopped&&now<(next.verifyAt??0)){next.nextAt=now+3600_000;store.set(attemptKey,next);throw Error('Notify creation stopped; daily verification is pending');}
 // Persist the lease before remote work; a pending uncertain creation is carried until the sweep below resolves it.
 if(stopped)next.verifyAt=now+86400_000;
 store.set(attemptKey,next);
 let createdId:string|undefined;
 try{
  const hooks=await api.list(),removed=new Set<string>();let hook:NotifyHook|undefined;
  if(hasPools){const storedId=next.createdId??(state?.hash===desired.hash?state.bindings.find(b=>!b.retireAt)?.id:undefined);
   hook=hooks.find(h=>h.id===webhookDiff(hooks,desired,storedId).existingId);
   if(!hook){
    // Never create while an uncertain orphan still exists. Other origins/chains and bound hooks are untouched.
    for(const old of hooks)if(sameCallback(old.webhook_url,desired.webhook_url)&&!bound(old.id)){await api.remove(old.id);removed.add(old.id);}
    if(next.createdId&&!hooks.some(h=>h.id===next.createdId)&&!bound(next.createdId))await api.remove(next.createdId);
    // An uncertain creation that reached Alchemy was just swept as an orphan and does not count; one that never arrived does.
    if(next.uncertain&&!removed.size)next.creationFailures=(next.creationFailures??0)+1;
    delete next.uncertain;delete next.createdId;store.set(attemptKey,next);
    if((next.creationFailures??0)>=5)throw Error('Notify creation stopped');
    // Persisted before the call, so an eviction is resolved like a timeout. A received response settles the attempt as a failure until it binds.
    next.uncertain=true;store.set(attemptKey,next);
    const settle=()=>{delete next.uncertain;next.creationFailures=(next.creationFailures??0)+1;store.set(attemptKey,next);};
    try{hook=await api.create(desired,id=>{createdId=id;next.createdId=id;store.set(attemptKey,next);});}catch(error){if(!(error instanceof NotifyUnavailable))settle();throw error;}settle();
   }
   if(hook.id!==(createdId??storedId)||!validHook(hook,desired))throw Error("Notify identity mismatch");
  }
  const previous=state?.bindings.find(b=>!b.retireAt&&b.id!==hook?.id);
  const bindings:Binding[]=hook?[{id:hook.id,network:hook.network,kind,key:hook.signing_key,generation:state?.bindings.find(b=>b.id===hook!.id)?.generation??now},...(previous?[{...previous,retireAt:now+5*60_000}]:[])]:[];
  // Store and verify the new key before deleting remote destinations. Only one superseded key survives briefly.
  store.set(stateKey,{hash:desired.hash,checkedAt:now,bindings});
  createdId=undefined;
  // Retire this kind's superseded destination explicitly; orphan sweeps never touch any stored binding.
  for(const old of state?.bindings??[])if(old.id!==hook?.id&&!removed.has(old.id)&&hooks.some(h=>h.id===old.id)&&!bound(old.id,true)){await api.remove(old.id);removed.add(old.id);}
  for(const old of hooks)if(!removed.has(old.id)&&sameCallback(old.webhook_url,desired.webhook_url)&&!bound(old.id))await api.remove(old.id);
  store.set(attemptKey,{hash:desired.hash,failures:0,creationFailures:0,nextAt:0});
 }catch{
  if(createdId&&!bound(createdId))try{await api.remove(createdId);delete next.createdId;}catch{}
  if((next.creationFailures??0)>=5){next.nextAt=now+3600_000;next.verifyAt??=now+86400_000;}
  store.set(attemptKey,next);throw Error("Notify reconciliation unavailable");
 }
}
