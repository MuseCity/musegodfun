import test from 'node:test';import assert from 'node:assert/strict';import crypto,{createHmac} from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';import {transform} from 'esbuild';
import {NotifyClient,desiredWebhook,reconcileWebhook,webhookDiff,type NotifyState} from '../server/alchemy-webhooks';import {SwapService,isWebhookPath} from '../server/swap-service';import * as security from '../server/http-security';import {MemorySwapStore} from '../server/swap-store';import {registeredPools,NETWORKS,type SwapPool,type WebhookKind} from '../server/swap-stream';import {createApp} from '../server/app';import {runtimeFromEnv} from '../server/config';import {runWebhookCli} from '../scripts/alchemy-webhooks';import {syntheticToken} from './fixtures';import fixtures from './fixtures/alchemy-swaps.json';
const url='https://musegod.fun/api/chains/4663/webhooks/alchemy',v3=registeredPools(4663,[])[0],v4:SwapPool={...v3,version:4,pool:fixtures.v4[0].topics[1]},pools=[v3,v4],key='run6b-synthetic';
function remote(mode:'strip'|'replace'|'list-only'='strip'){
 const hooks:any[]=[],calls:{method:string;id?:string}[]=[];let creates=0;
 const normalise=(h:any)=>({...h,webhook_url:h.webhook_url.split('?')[0]+(mode==='replace'?'?kind=ignored&set=normalised':'')});
 const api=new NotifyClient('synthetic',async(input,init)=>{const method=init?.method??'GET',id=new URL(String(input)).searchParams.get('webhook_id')??undefined;calls.push({method,id});
  if(method==='POST'){const h={...JSON.parse(String(init!.body)),id:'created-'+(++creates),is_active:true,signing_key:key+creates};hooks.push(mode==='list-only'?h:normalise(h));return Response.json({data:hooks.at(-1)});}
  if(method==='DELETE'){const i=hooks.findIndex(h=>h.id===id);if(i>=0)hooks.splice(i,1);return Response.json({});}
  return Response.json({data:hooks.map(normalise)});
 });return {hooks,calls,api,get creates(){return creates;}};
}
for(const [chainId,kind] of [[4663,'v4'],[4663,'v3'],[8453,'v4']] as const)test(`C3-1: ${chainId}/${kind} callback kind is in the exact path, independent of query strings`,()=>{
 const d=desiredWebhook(chainId,pools.map(p=>({...p,chainId})),url.replace('4663',String(chainId)),kind),path=`/api/chains/${chainId}/webhooks/alchemy/${kind}`;
 assert.equal(new URL(d.webhook_url).pathname,path);assert.equal(new URL(d.webhook_url).searchParams.get('kind'),null);
 for(const query of ['', '?set=normalised','?kind=wrong&set=ignored']){const h={...d,id:'bound',is_active:true,signing_key:key,webhook_url:'https://musegod.fun'+path+query};assert.equal(webhookDiff([h],d,'bound').action,'keep');}
 assert(isWebhookPath(path));assert.equal(security.requestBodyLimitForPath(path),1_048_576);assert(!isWebhookPath(path+'/'));assert(!isWebhookPath(path+'/extra'));
 assert(!isWebhookPath(`/api/chains/${chainId}/webhooks/alchemy?kind=${kind}`));assert.equal(security.requestBodyLimitForPath(`/api/chains/${chainId}/webhooks/alchemy?kind=${kind}`),65_536);
});
for(const mode of ['strip','replace','list-only'] as const)test(`C3-1/C1b-2: ${mode} callback queries bind once and daily verification preserves both kinds`,async()=>{
 const store=new MemorySwapStore(),f=remote(mode);await reconcileWebhook(store,f.api,4663,pools,url,1000);const ids=['v3','v4'].map(k=>store.get<NotifyState>('notify-'+k)!.bindings[0].id);
 for(let day=1;day<=3;day++)await reconcileWebhook(store,f.api,4663,pools,url,1000+day*86400_000);
 assert.equal(f.creates,2);assert.equal(f.hooks.length,2);assert.deepEqual(['v3','v4'].map(k=>store.get<NotifyState>('notify-'+k)!.bindings[0].id),ids);assert(!f.calls.some(c=>c.method==='DELETE'));
});
for(const target of ['v3','v4'] as const)test(`C3-1: ${target} orphan sweep never deletes any sibling binding and stays on its exact callback`,async()=>{
 const store=new MemorySwapStore(),f=remote(),sibling=target==='v3'?'v4':'v3',desired=desiredWebhook(4663,pools,url,target),dSibling=desiredWebhook(4663,pools,url,sibling);
 store.set('notify-'+sibling,{hash:dSibling.hash,checkedAt:1000,bindings:[{id:'sibling-current',network:NETWORKS[4663],kind:sibling,key},{id:'sibling-previous',network:NETWORKS[4663],kind:sibling,key,retireAt:5000}]});
 const h=(id:string,path:string)=>({...desired,id,is_active:true,signing_key:key,webhook_url:path});
 // Even inconsistent remote callback metadata must not turn a stored sibling id into an orphan.
 f.hooks.push(h('sibling-current',url+'/'+target),h('sibling-previous',url+'/'+target+'?set=old'),h('own-orphan',url+'/'+target+'?kind=wrong'),h('other-kind',url+'/'+sibling),h('old-query',url+'?kind='+target),h('other-chain',url.replace('4663','8453')+'/'+target),h('other-origin',url.replace('musegod.fun','other.invalid')+'/'+target),h('other-path',url+'/'+target+'/extra'));
 await reconcileWebhook(store,f.api,4663,pools,url,1001);assert.deepEqual(f.calls.filter(c=>c.method==='DELETE').map(c=>c.id),['own-orphan']);assert(f.hooks.some(h=>h.id==='sibling-current'));assert(f.hooks.some(h=>h.id==='sibling-previous'));
});
function signed(kind:WebhookKind,id=kind+'-current',signingKey=id){const body=structuredClone(fixtures.deliveries[kind]);body.webhookId=id;body.event.data.block.timestamp=Math.floor(Date.now()/1000);const raw=Buffer.from(JSON.stringify(body));return {raw,sig:createHmac('sha256',signingKey).update(raw).digest('hex')};}
function bindings(store:MemorySwapStore){for(const kind of ['v3','v4'] as const)store.set('notify-'+kind,{bindings:[{id:kind+'-current',network:NETWORKS[4663],kind,key:kind+'-current'},{id:kind+'-previous',network:NETWORKS[4663],kind,key:kind+'-previous',retireAt:Date.now()+10000},{id:kind+'-ancient',network:NETWORKS[4663],kind,key:kind+'-ancient'}]});}
test('C3-3: raw authentication checks at most the path kind\'s current and predecessor keys',async t=>{
 const store=new MemorySwapStore();bindings(store);const service=new SwapService(4663,store,{pools:async()=>pools}),hmacs:string[]=[],original=crypto.createHmac;
 t.mock.method(crypto,'createHmac',((algorithm:any,k:any,...rest:any[])=>{hmacs.push(String(k));return (original as any)(algorithm,k,...rest);}) as typeof createHmac);syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 for(const kind of ['v3','v4'] as const){hmacs.length=0;assert.equal((await service.ingest(Buffer.from('{'),'f'.repeat(64),kind)).status,401);assert.deepEqual(hmacs,[kind+'-current',kind+'-previous']);}
});
test('C3-3: selected kind rejects sibling signatures and mismatched binding kind before parsing or pool lookup',async()=>{
 const store=new MemorySwapStore();bindings(store);let reads=0;const service=new SwapService(4663,store,{pools:async()=>{reads++;return pools;}});
 for(const kind of ['v3','v4'] as const){const other=kind==='v3'?'v4':'v3',s=signed(other);assert.equal((await service.ingest(s.raw,s.sig,kind)).status,401);}
 assert.equal(reads,0);const s=signed('v3');store.set('notify-v3',{bindings:[{id:'v3-current',network:NETWORKS[4663],kind:'v4',key:'v3-current'}]});assert.equal((await service.ingest(s.raw,s.sig,'v3')).status,401);assert.equal(reads,0);
});
async function worker(swaps:any,chainId=4663){
 const source=(await readFile('worker/index.ts','utf8')).split('\nexport default')[0].replace(/^import .*;\n/gm,''),compiled=await transform(source,{loader:'ts',format:'cjs'}),module={exports:{} as any};
 const scope={DurableObject:class{},redact:()=> 'redacted',isWebhookPath,...security,createServer:()=>({listen(){},address:()=>({port:1234}),close(){}}),httpServerHandler:()=>({fetch:async()=>Response.json({ok:true})})};
 new Function('module','exports',...Object.keys(scope),compiled.code)(module,module.exports,...Object.values(scope));const instance=Object.create(module.exports.LaunchpadRuntime.prototype);
 instance.refreshRuntime=()=>{};instance.chainId=chainId;instance.swaps=swaps;instance.ingress={admit:()=>({release(){}})};return instance;
}
test('C3-2: ordinary Worker API requests never reconcile, with bound, partially bound, missing or stopped per-kind state',async()=>{
 for(const state of ['bound','partial','missing','stopped']){const store=new MemorySwapStore();if(state==='bound'||state==='partial')store.set('notify-v3',{bindings:[]});if(state==='bound')store.set('notify-v4',{bindings:[]});if(state==='stopped')store.set('notify-attempt-v4',{creationFailures:5});
  let calls=0,scheduled=0,alarm:number|null=null;const instance=await worker({store,reconcile:async()=>{calls++;}});instance.ctx={storage:{getAlarm:async()=>alarm,setAlarm:async(n:number)=>{alarm=n;}},waitUntil:()=>{scheduled++;}};
  for(const path of ['/api/config','/api/tokens','/readyz','/api/not-found'])assert.equal((await instance.fetch(new Request('https://musegod.fun'+path))).status,200);
  assert(alarm);assert.equal(calls,0,state);assert.equal(scheduled,0,state);
 }
});
test('C3-1/C3-3: actual Worker receiver selects only the callback path kind and returns 404 for legacy or unsupported paths',async()=>{
 const store=new MemorySwapStore();bindings(store);const instance=await worker(new SwapService(4663,store,{pools:async()=>pools}));instance.ctx={storage:{getAlarm:async()=>1}};
 const post=(path:string,s:{raw:Buffer;sig:string})=>instance.fetch(new Request('https://musegod.fun'+path,{method:'POST',headers:{'x-alchemy-signature':s.sig,'content-length':String(s.raw.length)},body:new Uint8Array(s.raw)}));
 for(const kind of ['v3','v4'] as const){assert.equal((await post('/api/webhooks/alchemy/'+kind,signed(kind))).status,200);assert.equal((await post('/api/webhooks/alchemy/'+kind,signed(kind==='v3'?'v4':'v3'))).status,401);}
 for(const path of ['/api/webhooks/alchemy?kind=v3','/api/webhooks/alchemy/v3/','/api/webhooks/alchemy/v5','/api/chains/8453/webhooks/alchemy/v3'])assert.equal((await post(path,signed('v3'))).status,404,path);
});
test('C3-1/C3-3: real Node receiver accepts current/predecessor keys by path and rejects query-only callbacks',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'swap-run6b-node-')),store=new MemorySwapStore();bindings(store);const {app,service,swaps}=createApp(undefined,'loopback',runtimeFromEnv(4663,{NODE_ENV:'test',CHAIN_MODE:'fork',FORK_CHAIN_ID:'4663',DATA_DIR:directory}),{swapStore:store});
 (swaps as any).options.pools=async()=>pools;const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await service.store.close();await rm(directory,{recursive:true,force:true});});
 const post=(path:string,s:{raw:Buffer;sig:string})=>fetch(origin+path,{method:'POST',headers:{origin:'https://alchemy.com','x-alchemy-signature':s.sig},body:new Uint8Array(s.raw)});
 for(const kind of ['v3','v4'] as const){for(const suffix of ['current','previous'])assert.equal((await post('/api/webhooks/alchemy/'+kind,signed(kind,kind+'-'+suffix))).status,200);assert.equal((await post('/api/webhooks/alchemy/'+kind,signed(kind==='v3'?'v4':'v3'))).status,401);}
 for(const path of ['/api/webhooks/alchemy?kind=v3','/api/webhooks/alchemy/v3/','/api/webhooks/alchemy/v5'])assert.equal((await post(path,signed('v3'))).status,404,path);
});
test('C3-1: read-only CLI dry run shows three path callbacks using one GET and no mutations',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'swap-run6b-cli-'));try{const file=join(directory,'tokens.json');await writeFile(file,JSON.stringify([syntheticToken({mode:'robinhood',quoteAddress:v3.quote as `0x${string}`}),syntheticToken()]));let reads=0;
  const result=await runWebhookCli(['--tokens',file],{ALCHEMY_NOTIFY_API_KEY:'synthetic'},async(_input,init)=>{assert.equal(init?.method,'GET');reads++;return Response.json({data:[]});});assert.equal(reads,1);
  assert.deepEqual(result.diff.map((d:any)=>new URL(d.url).pathname),['/api/chains/4663/webhooks/alchemy/v4','/api/chains/4663/webhooks/alchemy/v3','/api/chains/8453/webhooks/alchemy/v4']);
 }finally{await rm(directory,{recursive:true,force:true});}
});
