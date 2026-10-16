import test from 'node:test';import assert from 'node:assert/strict';
import { NotifyClient, desiredWebhook, reconcileWebhook } from '../server/alchemy-webhooks';
import { MemorySwapStore } from '../server/swap-store';
import { registeredPools } from '../server/swap-stream';
test('Notify uses documented create/list/delete shapes, narrow aliased filters, replacement deletes old hook and briefly retains both keys, daily verification',async()=>{
 const calls:{path:string;method:string;body:any}[]=[],hooks:any[]=[];
 const api=new NotifyClient('synthetic',async(input,init)=>{const path=new URL(String(input)).pathname;const body=init?.body?JSON.parse(String(init.body)):null;calls.push({path,method:init?.method??'GET',body});
 if(path.endsWith('team-webhooks'))return Response.json({data:hooks});
 if(path.endsWith('create-webhook')){const row={...body,id:'wh_'+hooks.length,is_active:true,signing_key:'synthetic_'+hooks.length};hooks.push(row);return Response.json({data:row});}
 return Response.json({});});
 const store=new MemorySwapStore(),pools=registeredPools(4663,[]),url='https://musegod.fun/api/chains/4663/webhooks/alchemy';
 await reconcileWebhook(store,api,4663,pools,url,1000);assert.equal(calls.filter(c=>c.path.endsWith('create-webhook')).length,1);
 const d=desiredWebhook(4663,pools,url);assert(d.graphql_query.skip_empty_messages);assert(d.graphql_query.query.includes('v3: logs'));assert(!d.graphql_query.query.includes('v4: logs'));
 await reconcileWebhook(store,api,4663,pools,url,2000);assert.equal(calls.length,2);
 await reconcileWebhook(store,api,4663,[...pools,{...pools[0],version:4,pool:'0x'+'ab'.repeat(32)}],url,3000);
 assert.equal(store.get<any>('notify').bindings.length,2);assert.equal(calls.filter(c=>c.path.endsWith('delete-webhook')).length,1);
});

test('restart verifies the stored id with a normalised callback at most daily and redacts failures',async()=>{
 const pools=registeredPools(4663,[]),desired=desiredWebhook(4663,pools,'https://musegod.fun/api/chains/4663/webhooks/alchemy');let calls=0;
 const hook={id:'wh_existing',network:desired.network,webhook_type:'GRAPHQL',webhook_url:desired.webhook_url.split('?')[0],is_active:true,signing_key:'synthetic-secret'};
 const api=new NotifyClient('synthetic-token',async()=>{calls++;return Response.json({data:[hook]});});const store=new MemorySwapStore();
 store.set('notify',{hash:desired.hash,checkedAt:-86400000,bindings:[{id:hook.id,network:hook.network,key:hook.signing_key}]});
 await reconcileWebhook(store,api,4663,pools,'https://musegod.fun/api/chains/4663/webhooks/alchemy',1);assert.equal(calls,1);assert.equal(store.get<any>('notify').bindings[0].id,'wh_existing');
 await reconcileWebhook(store,api,4663,pools,'https://musegod.fun/api/chains/4663/webhooks/alchemy',2);assert.equal(calls,1);
 await reconcileWebhook(store,api,4663,pools,'https://musegod.fun/api/chains/4663/webhooks/alchemy',86400002);assert.equal(calls,2);
 const rejected=new NotifyClient('synthetic-token',async()=>new Response('synthetic-secret',{status:302,headers:{Location:'https://untrusted.invalid'}}));await assert.rejects(rejected.list(),/^Error: Notify request rejected \(302\)$/);
});
