import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {transform} from 'esbuild';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';import {once} from 'node:events';
import {MemorySwapStore} from '../server/swap-store';import {SwapService} from '../server/swap-service';import {registeredPools,decodeDelivery,MUSE_POOL} from '../server/swap-stream';import {NotifyClient,desiredWebhook,reconcileWebhook} from '../server/alchemy-webhooks';import {createApp} from '../server/app';import {runtimeFromEnv} from '../server/config';import fixtures from './fixtures/alchemy-swaps.json';

const pools=registeredPools(4663,[]),url='https://musegod.fun/api/chains/4663/webhooks/alchemy';
/** The Worker entry compiled the way the alarm regressions compile it: imports stripped, a fixed scope injected. */
async function compiledWorker(){const source=(await readFile('worker/index.ts','utf8')).split('\nexport default')[0].replace(/^import .*;\n/gm,'');const code=await transform(source,{loader:'ts',format:'cjs'});const module={exports:{} as any};new Function('module','exports','DurableObject','redact',code.code)(module,module.exports,class{},()=>'redacted');return module.exports;}
function delivery(){const body=structuredClone(fixtures.deliveries.v3);body.event.data.block.timestamp=Math.floor(Date.now()/1000)-180;return decodeDelivery(JSON.stringify(body),{id:'wh_test_v3',network:'ROBINHOOD_MAINNET',kind:'v3' as const},pools);}

test('each alarm logs one maintenance line with four timed phases, work counts and an idle flag, and totals accumulate',async t=>{
 const exports=await compiledWorker();const instance=Object.create(exports.LaunchpadRuntime.prototype);instance.chainId=4663;instance.refreshRuntime=()=>{};instance.ctx={storage:{setAlarm:async()=>{}}};
 const lines:any[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(JSON.parse(line));});t.mock.method(console,'error',()=>{});
 // A fake clock makes the measured phase durations exact instead of timer-granularity dependent.
 let now=1_760_000_000_000;t.mock.method(Date,'now',()=>now);
 let cleanupFails=false;
 instance.service={runtime:{environment:{}},store:{cleanup:async()=>{now+=5;if(cleanupFails)throw Error('synthetic');}},reconcile:async()=>({pending:2,processed:1})};
 instance.swaps={reconcile:async()=>({v4:'fresh',v3:'checked'}),maintain:async()=>({pruned:3,blocks:1,verified:1,reorgs:0})};
 await instance.alarm();
 const busy=lines.at(-1);assert.equal(busy.event,'launchpad_maintenance');assert.equal(busy.chainId,4663);assert.equal(busy.idle,false);assert.equal(busy.ms,5);assert.equal(busy.at,new Date(now-5).toISOString());
 assert.deepEqual(Object.keys(busy.phases),['cleanup','launches','webhooks','finality']);
 assert.equal(busy.phases.cleanup.ms,5);assert.equal(busy.phases.cleanup.ok,true);assert.equal(busy.phases.launches.ms,0);assert.deepEqual(busy.phases.launches.work,{pending:2,processed:1});assert.deepEqual(busy.phases.webhooks.work,{remote:1});assert.deepEqual(busy.phases.finality.work,{pruned:3,blocks:1,verified:1,reorgs:0});
 instance.service.reconcile=async()=>({pending:0,processed:0});instance.swaps={reconcile:async()=>({v3:'fresh'}),maintain:async()=>({pruned:0,blocks:0,verified:0,reorgs:0})};
 await instance.alarm();assert.equal(lines.at(-1).idle,true);
 cleanupFails=true;await instance.alarm();const failed=lines.at(-1);assert.equal(failed.idle,false);assert.equal(failed.phases.cleanup.ok,false);assert.equal(failed.phases.launches,undefined,'a failed cleanup still skips launch work');assert.equal(failed.phases.finality.ok,true);
 // Stubs or older runtimes that return no counts are recorded as no work.
 cleanupFails=false;instance.swaps={reconcile:async()=>{},maintain:async()=>{}};instance.service.reconcile=async()=>5;await instance.alarm();assert.equal(lines.at(-1).idle,true);assert.deepEqual(lines.at(-1).phases.launches.work,{pending:0,processed:0});
 const report=instance.maintenance.report();assert.equal(report.runs,4);assert.equal(report.idle,2);assert.equal(report.phases.cleanup.errors,1);assert.equal(report.phases.launches.runs,3);assert.deepEqual(report.phases.finality.work,{pruned:3,blocks:1,verified:1,reorgs:0});assert.equal(report.phases.webhooks.work.remote,1);assert.equal(report.last.idle,true);assert.equal(report.ms,20);assert.equal(report.phases.cleanup.ms,20);assert.match(report.since,/^\d{4}-/);
 const expected=structuredClone(report);report.phases.cleanup.ms=0;report.phases.finality.work.pruned=0;delete report.phases.webhooks;
 assert.deepEqual(instance.maintenance.report(),expected,'mutating a returned report leaves the recorded phase totals unchanged');
 assert.equal(exports.MaintenanceMetrics.idle({cleanup:{ms:0,ok:true,work:{}},launches:{ms:0,ok:true,work:{pending:0,processed:0}},webhooks:{ms:0,ok:true,work:{remote:0}}}),false,'a missing phase is never idle');
});

test('swap maintenance and Notify reconciliation report their work',async()=>{
 const store=new MemorySwapStore();assert.equal(store.prune(),0);
 const canonical=delivery().blockHash;const swaps=new SwapService(4663,store,{pools:async()=>pools,blockHash:async()=>canonical});
 assert.deepEqual(await swaps.maintain(),{pruned:0,blocks:0,verified:0,reorgs:0});
 store.apply(delivery());assert.equal(store.rows(MUSE_POOL).length,1);
 assert.deepEqual(await swaps.maintain(),{pruned:0,blocks:1,verified:1,reorgs:0});
 assert.deepEqual(await swaps.maintain(),{pruned:0,blocks:0,verified:0,reorgs:0},'a verified block leaves the pending queue');
 const reorg=new MemorySwapStore();reorg.apply(delivery());const reorgSwaps=new SwapService(4663,reorg,{pools:async()=>pools,blockHash:async()=>'0x'+'d'.repeat(64)});
 assert.deepEqual(await reorgSwaps.maintain(),{pruned:0,blocks:1,verified:1,reorgs:1});
 assert.equal(store.prune(Date.now()+500*86400_000),1,'pruning reports removed rows');
 const desired=desiredWebhook(4663,pools,url,'v3');store.set('notify-v3',{hash:desired.hash,checkedAt:Date.now(),bindings:[{id:'wh',network:'ROBINHOOD_MAINNET',kind:'v3',key:'k'}]});
 let calls=0;const api=new NotifyClient('token',async()=>{calls++;throw Error('unexpected');});
 assert.deepEqual(await reconcileWebhook(store,api,4663,pools,url),{v3:'fresh'});assert.equal(calls,0);
 assert.deepEqual(await new SwapService(4663,store,{pools:async()=>pools,token:'token'}).reconcile('https://musegod.fun'),{v3:'fresh'});
 assert.equal(await new SwapService(4663,store,{pools:async()=>pools}).reconcile('https://musegod.fun'),undefined);
});

test('readiness carries the maintenance report only when the runtime provides one',async()=>{
 for(const provided of [false,true]){
  const directory=mkdtempSync(join(tmpdir(),'maintenance-')),report={since:'2026-10-17T00:00:00.000Z',runs:3,idle:1,ms:120,phases:{},last:null};
  const {app,service}=createApp(undefined,'loopback',runtimeFromEnv(4663,{NODE_ENV:'test',CHAIN_MODE:'fork',FORK_CHAIN_ID:'4663',DATA_DIR:directory}),provided?{maintenance:()=>report}:{});
  service.assertNetwork=async()=>{};
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as any;
  try{const status=await (await fetch(`http://127.0.0.1:${address.port}/readyz`)).json();if(provided)assert.deepEqual(status.maintenance,report);else assert.equal('maintenance' in status,false);}
  finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await service.store.close();rmSync(directory,{recursive:true,force:true});}
 }
});
