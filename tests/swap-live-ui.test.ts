import test from 'node:test';import assert from 'node:assert/strict';import {renderToStaticMarkup} from 'react-dom/server';import {hookRuntime,importFresh,settle} from './hook-runtime';
test('live bridge refreshes committed sections, ignores replay, hides label and falls back on disconnect',async t=>{
 let listener:any,output:any,bridge:any;const at=new Date().toISOString();const meta={source:'On-chain · Alchemy',status:'fresh',fetchedAt:at};
 const initial={summary:null,candles:null,trades:null};let props:any={...initial,chainId:4663,pool:'0x'+'ab'.repeat(20),path:'/musegod/market',interval:'1h',info:null,onUpdate:(v:any)=>{output=v;}};
 const response:any={summary:{...meta,priceUsd:2,periods:{},fdvUsd:null,marketCapUsd:null,liquidityUsd:null,lastTradeAt:at},candles:{...meta,candles:[{time:1,open:2,high:2,low:2,close:2,volume:1}]},trades:{...meta,trades:[]}};
 const runtime=hookRuntime(()=>bridge(props));({default:bridge}=await importFresh('src/components/SwapLive.tsx',{
 react:{file:import.meta.resolve('react'),bindings:runtime.hooks},'../lib/api':{file:import.meta.resolve('../src/lib/api.ts'),bindings:{chainApi:async(_id:number,path:string)=>response[path.split('/').at(-1)!.split('?')[0]]}},'../lib/swap-live':{file:import.meta.resolve('../src/lib/swap-live.ts'),bindings:{subscribeSwapStream:(_id:number,_pool:string,next:any)=>{listener=next;next.status({connected:true,receiving:false,receivedAt:null});return()=>{};}}}}));
 t.after(()=>runtime.unmount());runtime.render();await settle();assert.equal(renderToStaticMarkup(runtime.output()),'');assert.equal(await listener.event({}),true);await settle();assert.equal(output.summary.priceUsd,2);
 listener.status({connected:true,receiving:true,receivedAt:Date.now()});await settle();assert.match(renderToStaticMarkup(runtime.output()),/Live · On-chain/);assert.equal(await listener.event({}),false,'identical committed values never renew Live');
 listener.status({connected:true,receiving:false,receivedAt:Date.now()});await settle();assert.equal(renderToStaticMarkup(runtime.output()),'');assert.equal(output.summary.priceUsd,2);
 listener.status({connected:false,receiving:false,receivedAt:null});await settle();assert.equal(output,null);
});
