import test from 'node:test';import assert from 'node:assert/strict';
import { createSwapConnection } from '../src/lib/swap-live';
import fixtures from './fixtures/alchemy-swaps.json';
import { decodeDelivery,registeredPools } from '../server/swap-stream';
const trade=decodeDelivery(JSON.stringify(fixtures.deliveries.v3),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const},registeredPools(4663,[])).trades[0];
test('shared same-origin socket, hidden disconnect, invalid events ignored; only changed values mark Live',async t=>{
 let visible=true,watch=()=>{},created=0;const sockets:any[]=[];const statuses:any[]=[];let changed=false;
 const live=createSwapConnection({chainId:4663,pool:trade.pool,visible:()=>visible,watchVisibility:fn=>{watch=fn;return()=>{};},createSocket:()=>{created++;const events=new Map();const socket={addEventListener:(n:string,fn:any)=>events.set(n,fn),close:()=>{},emit:(n:string,data?:string)=>events.get(n)?.({data})};sockets.push(socket);return socket;}});
 const unsub=live.subscribe({status:s=>statuses.push(s),event:async()=>changed});t.after(unsub);assert.equal(created,1);const off=live.subscribe({status:()=>{},event:async()=>false});assert.equal(created,1);off();
 sockets[0].emit('open');assert.equal(statuses.at(-1).receiving,false);sockets[0].emit('message','{}');await Promise.resolve();assert.equal(statuses.at(-1).receiving,false);
 const data=JSON.stringify({type:'trades',chainId:4663,pool:trade.pool,trades:[trade],blockNumber:trade.blockNumber,blockHash:trade.blockHash,reorg:false,coverageStart:trade.at});sockets[0].emit('message',data);await new Promise(r=>setImmediate(r));assert.equal(statuses.at(-1).receiving,false);
 changed=true;sockets[0].emit('message',data);await new Promise(r=>setImmediate(r));assert.equal(statuses.at(-1).receiving,true);
 visible=false;watch();assert.equal(statuses.at(-1).connected,false);visible=true;watch();assert.equal(created,2);
});

test('browser stream schemas never attempt Function under strict CSP',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`
 import assert from 'node:assert/strict';globalThis.window={};let attempts=0;
 globalThis.Function=new Proxy(Function,{apply(){attempts++;throw new EvalError('CSP')},construct(){attempts++;throw new EvalError('CSP')}});
 await import('./src/lib/browser-validation.ts');
 const {parseSwapMessage}=await import('./src/lib/swap-stream.ts');
 assert.equal(parseSwapMessage('{}',4663,'0x'+ 'ab'.repeat(20)),null);assert.equal(attempts,0);
 `]);
});

test('a reopened socket publishes resumed after a hidden cycle, a close or a failed attempt; the first clean open does not',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let visible=true,watch=()=>{};const sockets:any[]=[],statuses:any[]=[];
 const live=createSwapConnection({chainId:4663,pool:trade.pool,visible:()=>visible,watchVisibility:fn=>{watch=fn;return()=>{};},createSocket:()=>{const events=new Map();const socket={addEventListener:(n:string,fn:any)=>events.set(n,fn),close:()=>{},emit:(n:string,data?:string)=>events.get(n)?.({data})};sockets.push(socket);return socket;}});
 const unsub=live.subscribe({status:s=>statuses.push(s),event:async()=>true});t.after(unsub);
 sockets[0].emit('open');assert.equal(statuses.at(-1).connected,true);assert.equal(statuses.at(-1).resumed,false);
 visible=false;watch();assert.equal(statuses.at(-1).connected,false);visible=true;watch();assert.equal(sockets.length,2);
 sockets[1].emit('open');assert.equal(statuses.at(-1).connected,true);assert.equal(statuses.at(-1).resumed,true);
 sockets[1].emit('close');assert.equal(statuses.at(-1).connected,false);t.mock.timers.tick(2000);assert.equal(sockets.length,3);
 sockets[2].emit('open');assert.equal(statuses.at(-1).resumed,true);
 const data=JSON.stringify({type:'trades',chainId:4663,pool:trade.pool,trades:[trade],blockNumber:trade.blockNumber,blockHash:trade.blockHash,reorg:false,coverageStart:trade.at});
 sockets[2].emit('message',data);await new Promise(r=>setImmediate(r));assert.equal(statuses.at(-1).receiving,true);assert(!statuses.at(-1).resumed,'only the open status carries resumed');
 unsub();
 const again=createSwapConnection({chainId:4663,pool:trade.pool,visible:()=>true,watchVisibility:()=>()=>{},createSocket:()=>{const events=new Map();const socket={addEventListener:(n:string,fn:any)=>events.set(n,fn),close:()=>{},emit:(n:string,data?:string)=>events.get(n)?.({data})};sockets.push(socket);return socket;}});
 const later:any[]=[];const off=again.subscribe({status:s=>later.push(s),event:async()=>true});t.after(off);
 sockets.at(-1).emit('close');t.mock.timers.tick(2000);sockets.at(-1).emit('open');assert.equal(later.at(-1).connected,true);assert.equal(later.at(-1).resumed,true,'a failed first attempt means pushes may have been missed');
});

test('a page mounted in a hidden tab connects when shown and that first open is resumed',async t=>{
 let visible=false,watch=()=>{};const sockets:any[]=[],statuses:any[]=[];
 const live=createSwapConnection({chainId:4663,pool:trade.pool,visible:()=>visible,watchVisibility:fn=>{watch=fn;return()=>{};},createSocket:()=>{const events=new Map();const socket={addEventListener:(n:string,fn:any)=>events.set(n,fn),close:()=>{},emit:(n:string,data?:string)=>events.get(n)?.({data})};sockets.push(socket);return socket;}});
 const unsub=live.subscribe({status:s=>statuses.push(s),event:async()=>true});t.after(unsub);
 assert.equal(sockets.length,0,'hidden pages hold no socket');visible=true;watch();assert.equal(sockets.length,1);
 sockets[0].emit('open');assert.equal(statuses.at(-1).connected,true);assert.equal(statuses.at(-1).resumed,true,'the REST basis predates the first connection');
});
