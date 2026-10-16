import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import fixtures from './fixtures/alchemy-swaps.json';
import {MUSE_POOL} from '../server/swap-stream';
test('real Worker: mocked Notify lifecycle, hibernating same-origin socket, signed ingestion and SQLite REST survive reload', {timeout:60_000},async()=>{
 const bundled=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'node',target:'es2022',external:['node:*','cloudflare:*'],banner:{js:'import {createRequire} from "node:module";const require=createRequire("/fixture.js");'}});
 let hook:any=null;let creates=0;const key='worker-synthetic-signing-key',calls:string[]=[];
 const options=(suffix="")=>convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-04',compatibilityFlags:['nodejs_compat'],script:bundled.outputFiles[0].text+suffix,durableObjects:{LAUNCHPAD:{className:'LaunchpadRuntime',useSQLite:true}},bindings:{CHAIN_MODE:'robinhood',NODE_ENV:'production',SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'fixture',ALCHEMY_API_KEY:'synthetic-rpc',ALCHEMY_NOTIFY_API_KEY:'synthetic-notify'},serviceBindings:{ASSETS:async()=>new Response('fixture')},outboundService:async request=>{
 const u=new URL(request.url);calls.push(request.method+' '+u.hostname+u.pathname);
 if(u.hostname==='fixture.supabase.co')return Response.json([]);
 if(u.hostname==='dashboard.alchemy.com'){
  if(u.pathname.endsWith('team-webhooks'))return Response.json({data:hook?[hook]:[]});
  if(u.pathname.endsWith('create-webhook')){creates++;hook={...await request.json() as any,id:'wh_test_v3',is_active:true,signing_key:key};return Response.json({data:hook});}
 }
 if(u.hostname==='li.quest')return Response.json({});
 if(u.hostname==='api.bankr.bot'||u.hostname.includes('coingecko')||u.hostname.includes('geckoterminal'))return Response.json({error:'Fixture unavailable'},{status:404});
 throw Error('Unexpected upstream '+u.hostname);
 }});
 const mf=new Miniflare(options());try{
 const initial=await mf.dispatchFetch('https://musegod.fun/api/config');assert.equal(initial.status,200,await initial.text());
 const sync=await mf.dispatchFetch('https://musegod.fun/api/chains/4663/webhooks/alchemy/reconcile',{method:'POST',headers:{Authorization:'Bearer synthetic-notify'}});assert.equal(sync.status,200,(await sync.text())+JSON.stringify(calls));
 for(let i=0;i<100&&!hook;i++)await new Promise(r=>setTimeout(r,10));assert(hook,JSON.stringify(calls));assert.equal(creates,1);
 const denied=await mf.dispatchFetch(`https://musegod.fun/api/chains/4663/market/stream?pool=${MUSE_POOL}`,{headers:{Upgrade:'websocket',Origin:'https://evil.invalid'}});assert.equal(denied.status,403);
 const upgrade=await mf.dispatchFetch(`https://musegod.fun/api/chains/4663/market/stream?pool=${MUSE_POOL}`,{headers:{Upgrade:'websocket',Origin:'https://musegod.fun'}});assert.equal(upgrade.status,101);const socket=upgrade.webSocket!;socket.accept();
 const next=new Promise<any>(resolve=>socket.addEventListener('message',e=>resolve(JSON.parse(e.data as string))));
 const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000);const raw=JSON.stringify(body),signature=createHmac('sha256',key).update(raw).digest('hex');
 const deliver=()=>mf.dispatchFetch('https://musegod.fun/api/chains/4663/webhooks/alchemy',{method:'POST',headers:{'Content-Type':'application/json','X-Alchemy-Signature':signature,Origin:'https://alchemy.com'},body:raw});
 assert.equal((await deliver()).status,200);assert.equal((await next).trades[0].hash,fixtures.v3[0].transactionHash);
 const result=await mf.dispatchFetch('https://musegod.fun/api/chains/4663/musegod/market/trades');assert.equal(result.status,200);assert.equal((await result.json() as any).trades.length,1);
 await mf.setOptions(options("\n// Reload fixture"));
 assert.equal((await deliver()).status,200);const restored=await mf.dispatchFetch('https://musegod.fun/api/chains/4663/musegod/market/trades');assert.equal((await restored.json() as any).trades.length,1);assert.equal(creates,1);
 socket.close();
 }finally{await mf.dispose();}
});
