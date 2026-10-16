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
 if(u.hostname.endsWith('.g.alchemy.com')){const raw=await request.json() as any,results=(Array.isArray(raw)?raw:[raw]).map((rpc:any)=>{assert.equal(rpc.method,'eth_chainId');return {jsonrpc:'2.0',id:rpc.id,result:'0x1237'};});return Response.json(Array.isArray(raw)?results:results[0]);}
 if(u.hostname==='api.bankr.bot'||u.hostname.includes('coingecko')||u.hostname.includes('geckoterminal'))return Response.json({error:'Fixture unavailable'},{status:404});
 throw Error('Unexpected upstream '+u.hostname);
 }});
 const mf=new Miniflare(options());try{
 const initial=await mf.dispatchFetch('https://musegod.fun/api/config');assert.equal(initial.status,200,await initial.text());assert.equal(creates,0,'ordinary requests only schedule the alarm');
 const sync=await mf.dispatchFetch('https://musegod.fun/api/chains/4663/webhooks/alchemy/reconcile',{method:'POST',headers:{Authorization:'Bearer synthetic-notify'}});assert.equal(sync.status,404,(await sync.text())+JSON.stringify(calls));
 for(let i=0;i<3500&&!hook;i++)await new Promise(r=>setTimeout(r,10));assert(hook,JSON.stringify(calls));assert.equal(creates,1);
 const ready=await mf.dispatchFetch('https://musegod.fun/readyz'),status=await ready.json() as any;assert.equal(ready.status,200);assert.equal(status.swapStream.kinds.v3.creationStopped,false);assert(!JSON.stringify(status).includes(key));
 const denied=await mf.dispatchFetch(`https://musegod.fun/api/chains/4663/market/stream?pool=${MUSE_POOL}`,{headers:{Upgrade:'websocket',Origin:'https://evil.invalid'}});assert.equal(denied.status,403);
 const upgrade=await mf.dispatchFetch(`https://musegod.fun/api/chains/4663/market/stream?pool=${MUSE_POOL}`,{headers:{Upgrade:'websocket',Origin:'https://musegod.fun'}});assert.equal(upgrade.status,101);const socket=upgrade.webSocket!;socket.accept();
 const next=new Promise<any>(resolve=>socket.addEventListener('message',e=>resolve(JSON.parse(e.data as string))));
 const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000);const raw=JSON.stringify(body),signature=createHmac('sha256',key).update(raw).digest('hex');
 const deliver=()=>mf.dispatchFetch('https://musegod.fun/api/chains/4663/webhooks/alchemy/v3',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(raw)),'X-Alchemy-Signature':signature,Origin:'https://alchemy.com'},body:raw});
 assert.equal((await deliver()).status,200);assert.equal((await next).trades[0].hash,fixtures.v3[0].transactionHash);
 for(let n=0;n<125;n++)assert.equal((await deliver()).status,200,'verified Worker deliveries bypass the 120/min source bucket');
 const result=await mf.dispatchFetch('https://musegod.fun/api/chains/4663/musegod/market/trades');assert.equal(result.status,200);assert.equal((await result.json() as any).trades.length,1);
 const candles=await mf.dispatchFetch('https://musegod.fun/api/chains/4663/musegod/market/candles?interval=1d');assert.equal(candles.status,200);assert.equal((await candles.json() as any).candles.length,1,'Worker SQLite executes the per-bucket aggregate query');
 await mf.setOptions(options("\n// Reload fixture"));
 assert.equal((await deliver()).status,200);const restored=await mf.dispatchFetch('https://musegod.fun/api/chains/4663/musegod/market/trades');assert.equal((await restored.json() as any).trades.length,1);assert.equal(creates,1);
 const ipv6=[];for(let n=0;n<8;n++){const r=await mf.dispatchFetch(`https://musegod.fun/api/chains/4663/market/stream?pool=${MUSE_POOL}`,{headers:{Upgrade:'websocket',Origin:'https://musegod.fun','CF-Connecting-IP':`2001:db8:1:2::${n+1}`}});assert.equal(r.status,101);r.webSocket!.accept();ipv6.push(r.webSocket!);}
 const same=await mf.dispatchFetch(`https://musegod.fun/api/chains/4663/market/stream?pool=${MUSE_POOL}`,{headers:{Upgrade:'websocket','CF-Connecting-IP':'2001:db8:1:2::abcd'}});assert.equal(same.status,429);
 const separate=await mf.dispatchFetch(`https://musegod.fun/api/chains/4663/market/stream?pool=${MUSE_POOL}`,{headers:{Upgrade:'websocket','CF-Connecting-IP':'2001:db8:3:4::1'}});assert.equal(separate.status,101);separate.webSocket!.accept();separate.webSocket!.close();ipv6.forEach(s=>s.close());
 socket.close();
 }finally{await mf.dispose();}
});
