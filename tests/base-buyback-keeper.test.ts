import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, type Hex, type Address, type PublicClient, type Transport } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_BUYBACK_PROTOCOL, baseCollectorAbi, type BaseFeeBatch } from "../src/lib/base-buyback";
import { CONTRACTS, STOCKS } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { allBaseFeeBatches, assertBaseNoUnknown, assertBaseOperationalControl, baseSourceStore,
  baseCanonicalKeeperLease, writeBasePublicJson, readBasePublicJson, baseFeeTransaction, submitBaseFeeBatch, reconcileBaseFeeBatch, reserveBaseGas,
  assertBaseGasReservationCurrent, assertCanonicalBaseTaskGasPolicy, baseKeeperTaskKey, baseKeeperTaskState, baseKeeperTaskWait, baseKeeperAttemptWait, KEEPER_TASK_RETRY_POLICY, assertBaseRoleSecrets, assertBaseKeeperRoles, assertBaseSelectedReleaseReadiness, baseUntrackedRecoveryTasks, BASE_UNTRACKED_COOLDOWN_MS, baseCanonicalGasSpent, baseUntrackedWalletHasReserve, assertCanonicalBaseUntrackedBudget, baseTaskIsolated, prepareBaseFeeTask, reconcileBaseKeeperHistory, type BaseKeeperJournal } from "../scripts/base-buyback-keeper";
import { KEEPER_TASK_RETRY_POLICY as RH_KEEPER_TASK_RETRY_POLICY } from "../scripts/buyback-keeper";
import { runtimeFromEnv } from "../server/config";
import { BASE_RECOVERY_FIXED_ASSETS } from "../server/base-buyback";
import { acquireBaseProcessLease } from "../scripts/base-process-lease";
const account = privateKeyToAccount(generatePrivateKey()), collector = getAddress("0x1111111111111111111111111111111111111111"), automation = getAddress("0x2222222222222222222222222222222222222222");
const hash = `0x${"ab".repeat(32)}` as Hex, replacement = `0x${"cd".repeat(32)}` as Hex;
function batch(kind: "claim" | "release" = "claim"): BaseFeeBatch {
  const initial: BaseFeeBatch = { id: "base-native-test", protocol: BASE_BUYBACK_PROTOCOL, kind, status: "unknown", sourceChainId: 8453, destinationChainId: 4663, collector,
    createdAt: 1, updatedAt: 1, amountIn: kind === "release" ? "100" : "0", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0", claimHashes: [],
    ...(kind === "claim" ? {poolId: hash} : {inputAsset: STOCKS[0], release: {token:STOCKS[0].address,amount:"100",automation}}),
    gasReservation: { executionWei: "10000000", l1Wei: "1000", operatorWei: "0", totalWei: "10001000", unsignedBytes: 100, unsignedHash: hash, blockNumber: "98", blockHash: hash } };
  const tx = baseFeeTransaction(initial);
  return { ...initial, journal: {caller:account.address,nonce:7,to:collector,dataHash:keccak256(tx.data),hash,gasLimit:"100000",maxFeePerGas:"100",signedAt:1} };
}
function settledTask(at: number, nonce: number, gasWei: bigint, status: "reverted" | "claimed" | "released" = "reverted", task = batch()): BaseFeeBatch {
  const sourceHash = `0x${(nonce + 1000).toString(16).padStart(64, "0")}` as Hex;
  return { ...task, id: `settled-${nonce}`, status, createdAt: at - 1000, updatedAt: at, sourceHash, sourceBlockNumber: String(nonce + 1),
    sourceBlockHash: hash, sourceFinalized: true, journal: { ...task.journal!, nonce, hash: sourceHash },
    actualGas: { transactionHash: sourceHash, blockNumber: String(nonce + 1), blockHash: hash,
      executionWei: String(gasWei - 150n), l1Wei: "100", operatorWei: "50", totalWei: String(gasWei) } };
}
test("round12 both keepers use the same policy and complete L1/operator reservation determines the single-attempt limit", () => {
  assert.equal(KEEPER_TASK_RETRY_POLICY, RH_KEEPER_TASK_RETRY_POLICY);
  const task = batch(), cap = KEEPER_TASK_RETRY_POLICY.maximumAttemptGasWei;
  task.gasReservation = { ...task.gasReservation!, executionWei: String(cap - 150n), l1Wei: "100", operatorWei: "50", totalWei: String(cap) };
  assert.equal(baseKeeperTaskWait([], task, account.address, 1000), null);
  task.gasReservation.operatorWei = "51"; task.gasReservation.totalWei = String(cap + 1n);
  assert.match(baseKeeperTaskWait([], task, account.address, 1000)!.reason, /single-attempt cap/);
  assert.match(baseKeeperAttemptWait(task.gasReservation,account.address,1000)!.reason,/single-attempt cap/,"An explicit unknown task must pass the same complete-cost ceiling first");
  assert.throws(() => baseKeeperTaskWait([], { ...task, gasReservation: { ...task.gasReservation!, totalWei: "1" } }, account.address), /incomplete/);
});
test("round12 stable pool and asset keys retain failed gas across restart and expire within the shared 24-hour window", async () => {
  const now = 100_000_000, task = batch(), cap = KEEPER_TASK_RETRY_POLICY.maximumFailedGasWei;
  const first = settledTask(now - 7_200_000, 1, cap / 2n), second = settledTask(now - 5_400_000, 2, cap / 2n);
  assert.equal(baseKeeperTaskKey(task), `claim:${hash}`);
  assert.equal(baseKeeperTaskKey(batch("release")), `release:${STOCKS[0].address.toLowerCase()}`);
  const history = JSON.parse(JSON.stringify([first, second])) as BaseFeeBatch[];
  const wait = baseKeeperTaskWait(history, { ...task, id: "new-random-id" }, account.address, now)!;
  assert.match(wait.reason, /24-hour failed-gas/); assert.equal(wait.nextAttemptAt, first.updatedAt + KEEPER_TASK_RETRY_POLICY.gasWindowMs);
  assert.equal(baseKeeperTaskWait(history, { ...task, poolId: replacement }, account.address, now), null);
  assert.equal(baseKeeperTaskWait(history, batch("release"), account.address, now), null);
  assert.equal(baseKeeperTaskWait(history, task, account.address, now + KEEPER_TASK_RETRY_POLICY.gasWindowMs), null);
  const journal: BaseKeeperJournal = { version: 2, collector, keeper: account.address, batches: [] };
  await assert.rejects(assertCanonicalBaseTaskGasPolicy(journal, task, {buybackBatchPage:async()=>history.map((row,index)=>({...row,sequence:String(index+1)}))}, now), /24-hour failed-gas/);
});
test("round12 own canonical failures are deduplicated and other callers or unknown recovery cannot spend the genuine budget", () => {
  const now = 100_000_000, first = settledTask(now - 7_200_000, 1, 500_000_000_000_000n), duplicate = { ...first, id: "canonical-alias", updatedAt: first.updatedAt + 1000 };
  const other = { ...settledTask(now - 5_400_000, 2, 500_000_000_000_000n), journal: {...batch().journal!, caller: automation, nonce: 2} };
  const recovery = { ...settledTask(now - 5_400_000, 3, 500_000_000_000_000n), recoveryRegistration: true };
  const state = baseKeeperTaskState([first, duplicate, other, recovery], account.address, now);
  assert.equal(state.tasks[baseKeeperTaskKey(first)].failures.length, 1);
  assert.equal(state.tasks[baseKeeperTaskKey(first)].failures[0].at, first.updatedAt);
  assert.equal(baseKeeperTaskWait([first, duplicate, other, recovery], batch(), account.address, now), null);
  assert.throws(() => baseKeeperTaskState([{...first, actualGas:{...first.actualGas!,operatorWei:"0"}}], account.address, now), /complete actual gas/);
  assert.throws(() => baseKeeperTaskState([{...first, sourceBlockHash:replacement}], account.address, now), /complete actual gas/);
  assert.throws(() => baseKeeperTaskState([first, {...duplicate, sourceHash:replacement, actualGas:{...first.actualGas!,transactionHash:replacement}}], account.address, now), /conflicting/);
});
test("round12 legacy aliases merge their earliest canonical time before crossing the rolling expiry boundary", () => {
  const at = 100_000_000, original = settledTask(at,1,KEEPER_TASK_RETRY_POLICY.maximumFailedGasWei);
  const alias = { ...original,id:"later-legacy-alias",updatedAt:at+1000 }, expiry = at+KEEPER_TASK_RETRY_POLICY.gasWindowMs;
  assert.match(baseKeeperTaskWait([original,alias],batch(),account.address,expiry-1)!.reason,/24-hour failed-gas/);
  assert.equal(baseKeeperTaskWait([original,alias],batch(),account.address,expiry),null,"A late legacy alias cannot add a thousand milliseconds to the original failure window");
  assert.equal(baseKeeperTaskWait([alias,original],batch(),account.address,expiry),null,"Input ordering cannot reset canonical expiry");
});
test("round12 expired incomplete or different-tuple records never freeze a healthy current task", () => {
  const at=100_000_000,now=at+KEEPER_TASK_RETRY_POLICY.gasWindowMs;
  const old=settledTask(at-1000,1,1000n),current=settledTask(now-600_000,1,1000n,"claimed");
  const partial={...old,actualGas:undefined},otherTuple={...old,sourceHash:replacement,actualGas:{...old.actualGas!,transactionHash:replacement}};
  const mismatchedOld={...old,sourceBlockHash:replacement};
  assert.equal(baseKeeperTaskWait([partial,otherTuple,mismatchedOld,current],batch(),account.address,now),null);
});
test("round12 successful fees have no lifetime cap while canonical revert count and exponential task backoff remain active", () => {
  const now = 100_000_000, success = settledTask(now - 1000, 1, 17_000_000_001_000n, "claimed");
  assert.equal(baseKeeperTaskWait([success], batch(), account.address, now), null);
  const failures = [1,2,3].map((nonce,index)=>settledTask(now-1_000_000+index*1000,nonce,1000n));
  assert.match(baseKeeperTaskWait(failures, batch(), account.address, now)!.reason,/repeated canonical reverts/);
  assert.match(baseKeeperTaskWait([settledTask(now-1000,1,1000n)], batch(), account.address, now)!.reason,/backing off/);
  const recovered = settledTask(now-500, 4, 1000n, "claimed");
  assert.equal(baseKeeperTaskState([failures[0], recovered],account.address,now).tasks[baseKeeperTaskKey(recovered)].consecutiveReverts,0);
});
async function signed(prepared = batch()) { return account.signTransaction({ ...baseFeeTransaction(prepared),chainId:8453,nonce:7,gas:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,type:"eip1559" }); }
test("a lost Base lease before transport abandons safely; loss after broadcaster entry retains unknown reservations", async () => {
  const directory=await mkdtemp(join(tmpdir(),"native-lease-submit-")),path=join(directory,"audit.json"),raw=await signed();
  let unlock=await acquireBaseProcessLease(path),broadcasts=0;
  const rows:BaseFeeBatch[]=[];
  try {
    const abandoned=await submitBaseFeeBatch(batch(),{sign:async()=>raw,persistLocal:async row=>{rows.push(row)},persistPublic:async()=>{},
      beforeBroadcast:async()=>{await unlock();unlock.assertHeld();},broadcast:async()=>{broadcasts++;return keccak256(raw)}});
    assert.equal(abandoned.status,"abandoned");assert.equal(broadcasts,0);assert.doesNotThrow(()=>assertBaseNoUnknown([abandoned],account.address));
    unlock=await acquireBaseProcessLease(path);
    await assert.rejects(()=>submitBaseFeeBatch(batch(),{sign:async()=>raw,persistLocal:async row=>{rows.push(row)},persistPublic:async()=>{},
      beforeBroadcast:async()=>{unlock.assertHeld();},broadcast:async()=>{broadcasts++;await unlock();unlock.assertHeld();return keccak256(raw)}}),/Submission outcome unresolved/);
    assert.equal(broadcasts,1);assert.equal(rows.at(-1)!.status,"unknown");assert(rows.at(-1)!.gasReservation);
    assert.throws(()=>assertBaseNoUnknown([rows.at(-1)!],account.address),/unresolved/);
  } finally {await unlock();await rm(directory,{recursive:true,force:true});}
});
test("exact native fee hash is fsynced locally and saved publicly before broadcast without raw signed data", async () => {
  const prepared=batch(), raw=await signed(prepared), events:string[]=[], saved:BaseFeeBatch[]=[];
  const result=await submitBaseFeeBatch(prepared,{sign:async()=>{events.push("sign");return raw},persistLocal:async value=>{events.push("local");saved.push(value)},persistPublic:async()=>{events.push("public")},broadcast:async value=>{events.push("broadcast");assert.equal(value,raw);assert.equal(saved[0].sourceHash,keccak256(raw));return keccak256(raw)}});
  assert.deepEqual(events,["sign","local","public","broadcast","local","public"]);assert.equal(result.status,"broadcast");assert(!JSON.stringify(saved).includes(raw));assert.throws(()=>assertBaseNoUnknown(saved,account.address),/unresolved/);
  const directory=await mkdtemp(join(tmpdir(),"native-public-"));try{const path=join(directory,"journal.json");await writeBasePublicJson(path,{version:2,batches:saved});assert.deepEqual(await readBasePublicJson(path),JSON.parse(await readFile(path,"utf8")));await assert.rejects(writeBasePublicJson(path,{privateKey:"forbidden"}),/public/)}finally{await rm(directory,{recursive:true,force:true})}
});
test("persistence failure cannot broadcast; an unused signature is abandoned while a broadcast timeout remains unknown",async()=>{
  const raw=await signed();let broadcasts=0,retained:BaseFeeBatch|undefined;
  const deps={sign:async()=>raw,persistLocal:async(value:BaseFeeBatch)=>{retained=value},persistPublic:async()=>{},broadcast:async()=>{broadcasts++;return keccak256(raw)}};
  await assert.rejects(submitBaseFeeBatch(batch(),{...deps,persistPublic:async()=>{throw new Error("DB failed")}}));assert.equal(broadcasts,0);assert.equal(retained?.sourceHash,keccak256(raw));
  const abandoned=await submitBaseFeeBatch(batch(),{...deps,beforeBroadcast:async()=>{throw new Error("paused")}});assert.equal(abandoned.status,"abandoned");assert.equal(broadcasts,0);
  await assert.rejects(submitBaseFeeBatch(batch(),{...deps,broadcast:async()=>{throw new Error("timeout")}}),/unresolved/);assert.equal(retained?.status,"unknown");assert.equal(retained?.gasReservation?.totalWei,"10001000");
});
test("a beforeBroadcast failure durably abandons an unsubmitted signature and permits the same nonce after restart",async()=>{
 const first=batch(),raw=await signed(first),local:BaseFeeBatch[]=[],publicRows=new Map<string,BaseFeeBatch>();let broadcasts=0;
 const deps={sign:async()=>raw,persistLocal:async(row:BaseFeeBatch)=>{local.push(structuredClone(row))},persistPublic:async(row:BaseFeeBatch)=>{publicRows.set(row.id,structuredClone(row))},broadcast:async()=>{broadcasts++;return keccak256(raw)}};
 const abandoned=await submitBaseFeeBatch(first,{...deps,beforeBroadcast:async()=>{throw Error("read-only custody CAS or RPC temporarily unavailable")}});
 assert.equal(abandoned.status,"abandoned");assert.equal(broadcasts,0);assert.equal(abandoned.sourceHash,keccak256(raw));assert.equal(abandoned.journal?.nonce,7);assert.equal(abandoned.gasReservation?.totalWei,first.gasReservation?.totalWei);assert.equal(abandoned.actualGas,undefined);
 assert.deepEqual(local.at(-1),publicRows.get(first.id));assert(!JSON.stringify(abandoned).includes(raw));assert.doesNotThrow(()=>assertBaseNoUnknown([abandoned],account.address));assert.equal(baseCanonicalGasSpent([abandoned],account.address),0n);
 const directory=await mkdtemp(join(tmpdir(),"base-abandoned-restart-"));try{
  const path=join(directory,"journal.json");await writeBasePublicJson(path,{version:2,collector,keeper:account.address,batches:[abandoned]});
  const restored=(await readBasePublicJson(path)) as BaseKeeperJournal,next={...batch(),id:"same-nonce-next"},store={buybackBatchPage:async()=>[{...publicRows.get(first.id)!,sequence:"1"}]};
  await assertCanonicalBaseTaskGasPolicy(restored,next,store);
  const noRpc={getBlock:async()=>{throw Error("An abandoned task has no chain outcome to reconcile")},getTransactionReceipt:async()=>{throw Error("An abandoned hash must never get revived")}} as any;
  assert.deepEqual(await reconcileBaseFeeBatch(restored.batches[0],noRpc),abandoned);assert.deepEqual(await reconcileBaseKeeperHistory(restored,restored.batches,noRpc,hash),[]);
  const submitted=await submitBaseFeeBatch(next,deps);assert.equal(submitted.status,"broadcast");assert.equal(submitted.journal?.nonce,7);assert.equal(broadcasts,1);assert.equal(submitted.sourceHash,abandoned.sourceHash,"A later intentional submission may sign identical bytes without resurrecting the abandoned task");
  const rpc=clientFor(submitted,"success");rpc.set({useReplacement:true,replacementHash:submitted.sourceHash,logs:[{address:collector,data:encodeAbiParameters([{type:"uint256"}],[100n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesClaimed",args:{poolId:hash,manager:CONTRACTS.initializer,token:STOCKS[0].address}})}]});
  const settled=await reconcileBaseFeeBatch(submitted,rpc.client);assert.equal(settled.status,"claimed");assert.equal(baseCanonicalGasSpent([abandoned,settled],account.address),BigInt(settled.actualGas!.totalWei));
 }finally{await rm(directory,{recursive:true,force:true})}
});
test("half-written abandonment and legacy signed unknown remain reserved after restart; only complete paired markers unlock",async()=>{
 const first=batch(),raw=await signed(first),cap=BigInt(first.gasReservation!.totalWei),next={...batch(),id:"next-after-fault"};
 for(const phase of ["intent","public_complete","local_complete"] as const){
  let local:BaseFeeBatch|undefined,canonical:BaseFeeBatch|undefined,broadcasts=0;
  await assert.rejects(submitBaseFeeBatch(first,{sign:async()=>raw,beforeBroadcast:async()=>{throw Error("gate unavailable")},
   persistLocal:async row=>{if(phase==="intent"&&row.abandonedBeforeBroadcast&&row.status==="unknown"||phase==="local_complete"&&row.status==="abandoned")throw Error("local durability failed");local=structuredClone(row)},
   persistPublic:async row=>{if(phase==="public_complete"&&row.status==="abandoned")throw Error("public durability failed");canonical=structuredClone(row)},broadcast:async()=>{broadcasts++;return keccak256(raw)}}),/durability failed/);
  assert.equal(broadcasts,0);assert.equal(local!.status,"unknown");assert.equal(local!.sourceHash,keccak256(raw));assert.throws(()=>assertBaseNoUnknown([local!],account.address),/unresolved/);
  const journal:BaseKeeperJournal=JSON.parse(JSON.stringify({version:2,collector,keeper:account.address,batches:[local]})),store={buybackBatchPage:async()=>[{...canonical!,sequence:"1"}]};
  await assert.rejects(assertCanonicalBaseTaskGasPolicy(journal,next,store),/unresolved/);
 }
 let failedOnce=false,local:BaseFeeBatch|undefined,canonical:BaseFeeBatch|undefined;
 const recovered=await submitBaseFeeBatch(first,{sign:async()=>raw,persistLocal:async row=>{local=structuredClone(row)},persistPublic:async row=>{if(!failedOnce){failedOnce=true;throw Error("one-shot initial persistence failure")};canonical=structuredClone(row)},broadcast:async()=>{throw Error("broadcast must not run")}});
 assert.equal(recovered.status,"abandoned");assert.deepEqual(local,canonical);assert.doesNotThrow(()=>assertBaseNoUnknown([recovered],account.address));
 const legacy={...recovered,status:"unknown" as const,abandonedBeforeBroadcast:undefined};assert.throws(()=>assertBaseNoUnknown([legacy,recovered],account.address),/unresolved/);
 const incomplete={...recovered,abandonedBeforeBroadcast:undefined};assert.throws(()=>assertBaseNoUnknown([incomplete],account.address),/unresolved/);assert.throws(()=>baseCanonicalGasSpent([incomplete],account.address),/not durably proven/);
 let signs=0;await assert.rejects(submitBaseFeeBatch(recovered,{sign:async()=>{signs++;return raw},persistLocal:async()=>{},persistPublic:async()=>{},broadcast:async()=>hash}),/cannot be signed again/);assert.equal(signs,0);
 const recovery={...batch(),id:"unused-unknown-recovery",kind:"sync_untracked" as const,poolId:undefined,inputAsset:STOCKS[0]};recovery.journal={...recovery.journal!,dataHash:keccak256(baseFeeTransaction(recovery).data)};const recoveryRaw=await signed(recovery);
 const unused=await submitBaseFeeBatch(recovery,{sign:async()=>recoveryRaw,persistLocal:async()=>{},persistPublic:async()=>{},beforeBroadcast:async()=>{throw Error("gate unavailable")},broadcast:async()=>{throw Error("No broadcast")}});
 assert.equal(baseCanonicalGasSpent([unused],account.address,true),0n);assert.equal(baseCanonicalGasSpent([unused],account.address),0n);
 const restored:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[unused]},recoveryStore={buybackBatchPage:async()=>[{...unused,sequence:"1"}]};
 assert.equal(await assertCanonicalBaseUntrackedBudget(restored,{...recovery,id:"fresh-recovery"},recoveryStore,cap),true);
 const row={...STOCKS[0],pending:"0",pendingUntracked:"0",untracked:BASE_RECOVERY_FIXED_ASSETS[0].minimumRaw,verifiedAsset:true},status={available:true,paused:false,automation,assets:[row]} as any;
 assert.equal(baseUntrackedRecoveryTasks(status,()=>({...recovery,id:"retry-unknown"}),{policies:BASE_RECOVERY_FIXED_ASSETS,history:[unused],keeper:account.address,now:10}).length,1,"An unused recovery signature does not start a one-hour spending cooldown");
});
test("the local signer rejects swap/bridge tasks and altered signed chain, calldata or destination",async()=>{
  assert.throws(()=>baseFeeTransaction({...batch(),kind:"native_relay"}),/Automation/);
  let broadcasts=0;const raw=await account.signTransaction({...baseFeeTransaction(batch()),chainId:4663,nonce:7,gas:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,type:"eip1559"});
  await assert.rejects(submitBaseFeeBatch(batch(),{sign:async()=>raw,persistLocal:async()=>{},persistPublic:async()=>{},broadcast:async()=>{broadcasts++;return hash}}),/differs/);assert.equal(broadcasts,0);
  const excess = await account.signTransaction({...baseFeeTransaction(batch()),chainId:8453,nonce:7,gas:200000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,type:"eip1559"});
  await assert.rejects(submitBaseFeeBatch(batch(),{sign:async()=>excess,persistLocal:async()=>{},persistPublic:async()=>{},broadcast:async()=>{broadcasts++;return hash}}),/differs/);assert.equal(broadcasts,0);
});
function clientFor(prepared:BaseFeeBatch, status:"success"|"reverted"="reverted") {
  const transaction=baseFeeTransaction(prepared);let canonical=true, l1:string|null="0x3e8", cancellation=false, useReplacement=false, delegated=false, auth=false, logs:any[]=[], replacementHash=replacement;
  const client={async getChainId(){return 8453},async getBlockNumber(){return 100n},async getBlock(){return {hash:canonical?hash:replacement}},async getCode(){return delegated?"0xef0100":"0x"},
    async getTransactionReceipt(){return {transactionHash:cancellation||useReplacement?replacementHash:hash,status,blockHash:hash,blockNumber:99n,gasUsed:21000n,effectiveGasPrice:100n,logs}},
    async getTransaction(){return {hash:cancellation||useReplacement?replacementHash:hash,type:"eip1559",authorizationList:auth?[{}]:undefined,from:account.address,to:cancellation?account.address:collector,nonce:prepared.journal!.nonce,input:cancellation?"0x":transaction.data,value:0n}},
    async request(){return {transactionHash:cancellation||useReplacement?replacementHash:hash,blockHash:hash,blockNumber:"0x63",gasUsed:"0x5208",effectiveGasPrice:"0x64",l1Fee:l1}},async readContract(){return 25n}} as unknown as PublicClient<Transport,any>;
  return {client, set(options:{canonical?:boolean;l1?:string|null;cancellation?:boolean;useReplacement?:boolean;delegated?:boolean;auth?:boolean;logs?:any[];replacementHash?:Hex}){if(options.canonical!==undefined)canonical=options.canonical;if(options.l1!==undefined)l1=options.l1;if(options.cancellation!==undefined)cancellation=options.cancellation;if(options.useReplacement!==undefined)useReplacement=options.useReplacement;if(options.delegated!==undefined)delegated=options.delegated;if(options.auth!==undefined)auth=options.auth;if(options.logs!==undefined)logs=options.logs;if(options.replacementHash!==undefined)replacementHash=options.replacementHash}};
}
test("canonical reverted source receipt consumes its nonce and includes L1/operator costs; reorg or missing L1 stays reserved",async()=>{
  const prepared={...batch(),sourceHash:hash};const mock=clientFor(prepared);
  const result=await reconcileBaseFeeBatch(prepared,mock.client);assert.equal(result.status,"reverted");assert.equal(result.actualGas?.totalWei,"2101025");
  mock.set({l1:null});assert.equal((await reconcileBaseFeeBatch(prepared,mock.client)).status,"unknown");
  mock.set({l1:"0x3e8",canonical:false});assert.equal((await reconcileBaseFeeBatch({...prepared,sourceBlockHash:hash},mock.client)).status,"reorg");
});
test("round12 canonical rechecks, transient errors and restart preserve the original failed-gas window time", async t => {
  let now = 100_000_000; t.mock.method(Date,"now",()=>now);
  const prepared = { ...batch(), sourceHash: hash }, rpc = clientFor(prepared,"reverted");
  const first = await reconcileBaseFeeBatch(prepared,rpc.client);
  assert.equal(first.updatedAt, now);
  now += 3_600_000;
  const restored = JSON.parse(JSON.stringify(first)) as BaseFeeBatch;
  const rechecked = await reconcileBaseFeeBatch(restored,rpc.client);
  assert.equal(rechecked.sourceOutcome!.at,first.updatedAt);assert(rechecked.updatedAt>first.updatedAt);
  const receipt = rpc.client.getTransactionReceipt; rpc.client.getTransactionReceipt = async () => { throw Error("RPC 429"); };
  const pending = await reconcileBaseFeeBatch(restored,rpc.client); assert.equal(pending.status,"reorg"); assert(pending.updatedAt>first.updatedAt);assert.equal(pending.sourceOutcome!.at,first.updatedAt);
  const local:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[pending]};
  await assert.rejects(assertCanonicalBaseTaskGasPolicy(local,{...batch(),id:"fresh"},{buybackBatchPage:async()=>[{...first,sequence:"1"}]},now),/unresolved/);
  rpc.client.getTransactionReceipt = receipt;
  const retried = await reconcileBaseFeeBatch(JSON.parse(JSON.stringify(pending)),rpc.client);
  assert(retried.updatedAt>pending.updatedAt);assert.equal(retried.sourceOutcome!.at,first.updatedAt);
  assert.equal(baseKeeperTaskState([retried],account.address,now).tasks[baseKeeperTaskKey(retried)].failures[0].at,first.updatedAt);
  const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[retried]};
  const finalized = await reconcileBaseKeeperHistory(journal,[retried],rpc.client,hash,undefined,64,now);
  assert(finalized.every(row => row.sourceOutcome!.at === first.updatedAt));
  const legacy={...first,sourceOutcome:undefined},legacyFailure=await reconcileBaseFeeBatch(legacy,rpc.client);
  assert.equal(legacyFailure.sourceOutcome!.at,first.updatedAt,"Legacy payloads bind their original complete outcome without a migration");
  rpc.client.getTransactionReceipt=async()=>{throw Error("RPC 429");};
  const legacyPending=await reconcileBaseFeeBatch(legacy,rpc.client);assert.equal(legacyPending.sourceOutcome!.at,first.updatedAt);
  rpc.client.getTransactionReceipt=receipt;now+=1000;rpc.set({useReplacement:true});
  const moved=await reconcileBaseFeeBatch(retried,rpc.client,replacement);
  assert.equal(moved.sourceOutcome!.transactionHash,replacement);assert.equal(moved.sourceOutcome!.at,now,"A new canonical tuple starts its own conservative window");
  const invalid={...first,sourceOutcome:{...first.sourceOutcome!,blockHash:replacement}};
  assert.throws(()=>baseKeeperTaskState([invalid],account.address,now),/not bound/);
});
test("success claim requires actual manager credit, and cancellation requires an empty undelegated same-nonce self transfer",async()=>{
  const prepared={...batch(),sourceHash:hash};const mock=clientFor(prepared,"success");
  assert.equal((await reconcileBaseFeeBatch(prepared,mock.client)).status,"asset_failed");
  mock.set({logs:[{address:collector,data:encodeAbiParameters([{type:"uint256"}],[100n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesClaimed",args:{poolId:hash,manager:CONTRACTS.initializer,token:STOCKS[0].address}})}]});
  const claimed=await reconcileBaseFeeBatch(prepared,mock.client);assert.equal(claimed.status,"claimed");assert.equal(claimed.claimCredits?.[0].amount,"100");
  mock.set({useReplacement:true});const replaced=await reconcileBaseFeeBatch(prepared,mock.client,replacement);assert.equal(replaced.status,"claimed");assert.equal(replaced.sourceHash,replacement);assert.equal(replaced.replacements?.[0].cancelled,false);
  mock.set({cancellation:true,logs:[]});assert.equal((await reconcileBaseFeeBatch(prepared,mock.client,replacement)).status,"cancelled");
  for(const option of [{delegated:true},{auth:true},{logs:[{}]}]){mock.set({delegated:false,auth:false,logs:[],...option});assert.equal((await reconcileBaseFeeBatch(prepared,mock.client,replacement)).status,"unknown")}
});
test("complete pagination sees unresolved older than 1000, and settled gas history has no lifetime ceiling",async()=>{
  const prior={...batch(),id:"old",status:"reverted" as const,sourceHash:hash};let calls=0;
  const rows=Array.from({length:1101},(_,index)=>({...prior,id:`row-${index}`,sequence:String(1101-index),updatedAt:1101-index,status:index===1100?"unknown":"reverted"}));
  const store={buybackBatchPage:async(limit=100,before?:{sequence:string})=>{calls++;rows.at(-1)!.updatedAt=Date.now();return rows.filter(row=>!before||BigInt(row.sequence)<BigInt(before.sequence)).slice(0,limit)}};
  const all=await allBaseFeeBatches(store);assert.equal(all.length,1101);assert.equal(calls,12);assert.throws(()=>assertBaseNoUnknown(all,account.address),/unresolved/);
  const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[]};const simple={buybackBatchPage:async()=>[{...prior,sequence:"1"}]};const rpc={async readContract(){return 100n}} as unknown as PublicClient<Transport,any>;
  await assertCanonicalBaseTaskGasPolicy(journal,{...batch(),id:"new"},simple);
  assert.equal(baseCanonicalKeeperLease(collector,account.address),baseCanonicalKeeperLease(collector,account.address));
});
test("fresh Base GPO reservation includes signed-size L1 upper bound and operator margin, and increased fees stop execution",async()=>{
  let l1=1000n;const rpc={async getChainId(){return 8453},async getBlock(){return {number:100n,hash}},async readContract(input:{functionName:string;args:any[]}){if(input.functionName==="getL1Fee"){assert.match(input.args[0],/^0x02/);return l1-100n}if(input.functionName==="getL1FeeUpperBound"){assert(input.args[0]>65n);return l1}return 20n}} as unknown as PublicClient<Transport,any>;
  const transaction=baseFeeTransaction(batch()), reservation=await reserveBaseGas(rpc,transaction,7,100000n,100n);assert.equal(reservation.totalWei,"10002040");
  await assertBaseGasReservationCurrent(rpc,transaction,7,100000n,100n,reservation);l1=2000n;await assert.rejects(assertBaseGasReservationCurrent(rpc,transaction,7,100000n,100n,reservation),/increased/);
});
test("runtime controls and isolated key environment all fail closed",async()=>{
  const runtime={config:{mode:"base" as const,chainId:8453,writesEnabled:true,treasury:collector,feeEngine:collector,feePolicy:BASE_AUTOMATION_FEE_POLICY,blockReason:null}};let paused=true;
  const control={runtimeControl:async()=>({paused,revision:0,updatedAt:1,reason:"test"})};await assert.rejects(assertBaseOperationalControl(control,runtime),/persistent/);paused=false;await assertBaseOperationalControl(control,runtime);
  assert.throws(()=>assertBaseRoleSecrets({MUSEGOD_KEEPER_PRIVATE_KEY:"own",MUSEGOD_DEPLOY_PRIVATE_KEY:"other"}),/only/);
  const env={NODE_ENV:"test",CHAIN_MODE:"base",SUPABASE_DATA_SCOPE:"base",DATA_DIR:"/tmp/fixture",SUPABASE_URL:"https://reviewed.supabase.co",SUPABASE_SECRET_KEY:"fixture"};
  const old=globalThis.fetch,reads:string[]=[];globalThis.fetch=async url=>{reads.push(String(url));return Response.json([])};try{for(const directory of ["/tmp/a","/tmp/b"]){const store=baseSourceStore(runtimeFromEnv(undefined,{...env,DATA_DIR:directory}));await allBaseFeeBatches(store);await store.close()}assert.equal(reads[0],reads[1]);assert.match(reads[0],/scope=eq.base/)}finally{globalThis.fetch=old}
});
test("an undeployed execute entry point cannot load a shared env file or create a signing wallet",async()=>{
  const source=`process.loadEnvFile=()=>{throw new Error('UNSAFE_SHARED_ENV_LOAD')};const {runBaseBuybackKeeper}=await import(${JSON.stringify(new URL("../scripts/base-buyback-keeper.ts",import.meta.url).href)});const {BASE_COLLECTOR_MANIFEST}=await import(${JSON.stringify(new URL("../server/base-collector.ts",import.meta.url).href)});BASE_COLLECTOR_MANIFEST.status='not_deployed';BASE_COLLECTOR_MANIFEST.collector.address=null;try{await runBaseBuybackKeeper(['--execute','--once']);throw new Error('unexpected execution')}catch(error){if(!/not deployed/.test(error.message))throw error;console.log('blocked_without_env')}`;
  const result=await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",source],{env:{PATH:process.env.PATH,NODE_ENV:"test"},timeout:15000});assert.match(result.stdout,/blocked_without_env/);
});

test("foreign native recovery and other callers cannot halt this keeper's fee tasks", () => {
  const own = batch(), foreign = {...own, id:"foreign",journal:{...own.journal!,caller:automation}};
  const native = {...own,id:"native",kind:"native_relay" as const};
  assert.doesNotThrow(() => assertBaseNoUnknown([foreign,native],account.address));
  for(const kind of ["claim","release"] as const) for(const status of ["unknown","broadcast","reorg"] as const)
    assert.throws(() => assertBaseNoUnknown([{...own,kind,status},foreign,native],account.address),/unresolved/);
});

test("retained canonical cancellations survive a restart without another replacement hint", async () => {
  const prepared={...batch(),sourceHash:hash},mock=clientFor(prepared,"success");mock.set({cancellation:true});
  const cancelled=await reconcileBaseFeeBatch(prepared,mock.client,replacement);assert.equal(cancelled.status,"cancelled");
  const restored=await reconcileBaseFeeBatch(JSON.parse(JSON.stringify(cancelled)),mock.client);
  assert.equal(restored.status,"cancelled");assert.equal(restored.sourceHash,replacement);assert.equal(restored.journal?.nonce,7);
  assert.equal(restored.actualGas?.totalWei,"2101025");assert.deepEqual(restored.replacements,cancelled.replacements);
  mock.set({canonical:false});assert.equal((await reconcileBaseFeeBatch(restored,mock.client)).status,"reorg");
});

test("multiple retained cancellations preserve separate nonces and cumulative actual gas after restart",async()=>{
 const cancelled:BaseFeeBatch[]=[];
 for(let index=0;index<2;index++){
  const original=batch(),prepared={...original,id:`cancel-${index}`,sourceHash:hash,journal:{...original.journal!,nonce:7+index}};
  const cancelledHash=`0x${(index?"ef":"cd").repeat(32)}` as Hex,mock=clientFor(prepared,"success");mock.set({cancellation:true,replacementHash:cancelledHash});
  const result=await reconcileBaseFeeBatch(prepared,mock.client,cancelledHash);
  const restored=await reconcileBaseFeeBatch(JSON.parse(JSON.stringify(result)),mock.client);
  assert.equal(restored.status,"cancelled");assert.equal(restored.journal?.nonce,7+index);assert.equal(restored.sourceHash,cancelledHash);cancelled.push(restored);
 }
 assert.doesNotThrow(()=>assertBaseNoUnknown(cancelled,account.address));
 const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:cancelled},next={...batch(),id:"next"};
 const store={buybackBatchPage:async()=>cancelled.map((row,index)=>({...row,sequence:String(index+1)}))};
 await assert.rejects(assertCanonicalBaseTaskGasPolicy(journal,next,store),/backing off/);
 await assertCanonicalBaseTaskGasPolicy(journal,{...batch("release"),id:"healthy-other-task"},store);
 assert.equal(baseCanonicalGasSpent(cancelled,account.address),4202050n);
});

test("keeper execution rejects governance, treasury and Automation role reuse",()=>{
 const constants={governor:collector,operationsTreasury:automation,automationReceiver:STOCKS[0].address};
 assert.doesNotThrow(()=>assertBaseKeeperRoles(account.address,{constants} as any));
 for(const role of ["governor","operationsTreasury","automationReceiver"] as const)
  assert.throws(()=>assertBaseKeeperRoles(account.address,{constants:{...constants,[role]:account.address}} as any),/separate/);
 assert.throws(()=>assertBaseKeeperRoles(account.address,{constants} as any,account.address),/separate/);
});
test("trusted Splits execution binds the actual keeper to owner acceptance without changing legacy role checks",()=>{
 const constants={governor:collector,operationsTreasury:automation,automationReceiver:STOCKS[0].address};
 const activation={status:"trusted_splits_authorized",trustedSplitsAcceptance:{keeper:account.address}};
 assert.doesNotThrow(()=>assertBaseKeeperRoles(account.address,{constants,activation} as any));
 activation.trustedSplitsAcceptance.keeper=STOCKS[1].address;
 assert.throws(()=>assertBaseKeeperRoles(account.address,{constants,activation} as any),/governor-authorized.*keeper/);
 assert.throws(()=>assertBaseKeeperRoles(account.address,{constants,activation:{status:"trusted_splits_authorized"}} as any),/governor-authorized.*keeper/);
 for(const status of ["not_run","canary_verified"])
  assert.doesNotThrow(()=>assertBaseKeeperRoles(account.address,{constants,activation:{...activation,status}} as any));
});
test("unknown recovery progresses independently over repeated sync/release cycles and never consumes genuine principal",async()=>{
 const asset={...STOCKS[0],chainId:8453 as const,pending:"7",untracked:"1000000",pendingUntracked:"0",totalClaimed:"7",totalReleased:"0",automationBalance:"0",verifiedAsset:true};
 const status={available:true,paused:false,automation,assets:[asset]} as any;
 const ctx={policies:BASE_RECOVERY_FIXED_ASSETS,history:[] as BaseFeeBatch[],keeper:account.address,now:10_000};
 const seed=(kind:"sync_untracked"|"release_untracked"):BaseFeeBatch=>({...batch("release"),kind,id:kind,amountIn:kind==="sync_untracked"?"0":"1000000",inputAsset:asset,release:kind==="release_untracked"?{token:asset.address,amount:"1000000",automation}:undefined});
 let tasks=baseUntrackedRecoveryTasks(status,seed,ctx);assert.deepEqual(tasks.map(row=>row.kind),["sync_untracked"]);
 const sync={...tasks[0],sourceHash:hash};sync.journal={...sync.journal!,dataHash:keccak256(baseFeeTransaction(sync).data)};
 const syncMock=clientFor(sync,"success");syncMock.set({logs:[{address:collector,data:encodeAbiParameters([{type:"uint256"}],[1000000n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"UntrackedSynced",args:{token:asset.address}})}]});
 const synced=await reconcileBaseFeeBatch(sync,syncMock.client);assert.equal(synced.status,"synced");assert.equal(synced.untrackedSync?.amount,"1000000");assert.equal(synced.claimCredits,undefined);assert.equal(synced.actualGas?.totalWei,"2101025");
 asset.untracked="0";asset.pendingUntracked="1000000";
 tasks=baseUntrackedRecoveryTasks(status,seed,ctx);assert.deepEqual(tasks.map(row=>row.kind),["release_untracked"]);assert.equal(tasks[0].amountIn,"1000000");assert.equal(asset.pending,"7");
 const released={...tasks[0],sourceHash:hash};released.journal={...released.journal!,nonce:8,dataHash:keccak256(baseFeeTransaction(released).data)};
 const releaseMock=clientFor(released,"success"),transfer={address:asset.address,data:encodeAbiParameters([{type:"uint256"}],[1000000n]),topics:encodeEventTopics({abi:parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]),eventName:"Transfer",args:{from:collector,to:automation}})};
 const event={address:collector,data:encodeAbiParameters([{type:"uint256"}],[1000000n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"UntrackedReleased",args:{token:asset.address,receiver:automation}})};
 releaseMock.set({logs:[transfer,event]});const receipt=await reconcileBaseFeeBatch(released,releaseMock.client);assert.equal(receipt.status,"released");assert.equal(receipt.claimCredits,undefined);assert.equal(receipt.burnedAmount,"0");
 const restored=await reconcileBaseFeeBatch(JSON.parse(JSON.stringify(receipt)),releaseMock.client);assert.equal(restored.status,"released");assert.equal(restored.sourceHash,receipt.sourceHash);assert.deepEqual(restored.release,receipt.release);
 const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[synced,receipt]},store={buybackBatchPage:async()=>[]};
 await assertCanonicalBaseTaskGasPolicy(journal,{...batch(),id:"fresh"},store);
 assert.equal(await assertCanonicalBaseUntrackedBudget(journal,{...released,id:"fresh-recovery"},store,BigInt(released.gasReservation!.totalWei)+4202050n-1n),false);
 await assertCanonicalBaseTaskGasPolicy(journal,{...batch(),id:"fresh"},store);
 for(const next of [sync,released]) await assert.rejects(assertCanonicalBaseTaskGasPolicy(journal,next,store),/does not permit unknown recovery/);
 asset.pendingUntracked="0";asset.untracked="1000000";assert.deepEqual(baseUntrackedRecoveryTasks(status,seed,ctx).map(row=>row.kind),["sync_untracked"]);
 assert.deepEqual(baseUntrackedRecoveryTasks({...status,paused:true},seed,ctx),[]);assert.deepEqual(baseUntrackedRecoveryTasks({...status,paused:true},seed,ctx),[]);
 asset.verifiedAsset=false;assert.deepEqual(baseUntrackedRecoveryTasks(status,seed,ctx),[]);
});
test("unknown source tasks retain their own unresolved nonce, reservation, receipt and reorg protections",async()=>{
 for(const kind of ["sync_untracked","release_untracked"] as const){
  const initial=batch("release"),prepared={...initial,kind,amountIn:kind==="sync_untracked"?"0":initial.amountIn,sourceHash:hash};prepared.journal={...prepared.journal!,dataHash:keccak256(baseFeeTransaction(prepared).data)};
  assert.throws(()=>assertBaseNoUnknown([prepared],account.address),/unresolved/);assert.doesNotThrow(()=>assertBaseNoUnknown([prepared],automation));
  const mock=clientFor(prepared,"reverted"),resolved=await reconcileBaseFeeBatch(prepared,mock.client);assert.equal(resolved.status,"reverted");assert.equal(resolved.actualGas?.totalWei,"2101025");
  mock.set({canonical:false});assert.equal((await reconcileBaseFeeBatch({...resolved,sourceBlockHash:hash},mock.client)).status,"reorg");
  const tampered={...prepared,amountIn:"99"};if(kind==="sync_untracked")assert.throws(()=>baseFeeTransaction(tampered),/Automation/);else assert.throws(()=>baseFeeTransaction({...prepared,release:{...prepared.release!,amount:"99"}}),/Automation/);
 }
});

test("a raced zero-fee claim resolves only complete recognized delta pairs under the exact runtime", async () => {
  const prepared = { ...batch(), sourceHash: hash }, mock = clientFor(prepared, "success");
  const runtimeHash = keccak256("0x1234");
  mock.client.getCode = async () => "0x1234";
  const token0 = "0x0000000000000000000000000000000000000001", token1 = "0x0000000000000000000000000000000000000002";
  const zero = (manager = CONTRACTS.initializer, token = token0, poolId = hash) => ({ address: collector,
    data: encodeAbiParameters([{type:"uint256"}],[0n]), topics: encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesClaimed",args:{poolId,manager,token:token as Address}}) });
  const complete = [zero(), zero(CONTRACTS.initializer, token1), zero(CONTRACTS.rehype), zero(CONTRACTS.rehype, token1)];
  mock.set({ logs: complete });
  const resolved = await reconcileBaseFeeBatch(prepared, mock.client, undefined, runtimeHash);
  assert.equal(resolved.status, "claimed"); assert.deepEqual(resolved.claimCredits, []); assert.equal(resolved.receivedAmount, "0");
  assert.equal(resolved.actualGas?.totalWei, "2101025"); assert.doesNotThrow(() => assertBaseNoUnknown([resolved],account.address));
  const failedAbi = parseAbi(["event ClaimFailed(bytes32 indexed poolId,address indexed manager,bytes reason)"]);
  const failed = { address: collector, data: encodeAbiParameters([{type:"bytes"}],["0x1234"]),
    topics: encodeEventTopics({abi:failedAbi,eventName:"ClaimFailed",args:{poolId:hash,manager:CONTRACTS.rehype}}) };
  mock.set({logs:[zero(),zero(CONTRACTS.initializer,token1),failed]});
  assert.equal((await reconcileBaseFeeBatch(prepared,mock.client,undefined,runtimeHash)).status,"claimed","One successful zero manager pair plus the other recognized failure consumes the nonce without income");
  for (const logs of [[], [zero()], [...complete, zero()], [zero(), zero(CONTRACTS.initializer, token1, replacement)],
    [zero("0x3333333333333333333333333333333333333333" as Address), ...complete.slice(1)], [{...zero(), data:"0x"}, ...complete.slice(1)]]) {
    mock.set({logs}); assert.equal((await reconcileBaseFeeBatch(prepared, mock.client, undefined, runtimeHash)).status, "asset_failed");
  }
  mock.set({logs:complete}); assert.equal((await reconcileBaseFeeBatch(prepared, mock.client, undefined, hash)).status, "evidence_pending");
});
test("one runtime RPC 429 retries the already-mined zero registration and never quarantines its shared B20 releases",async()=>{
 const original={...batch(),sourceHash:hash,inputAsset:STOCKS[0],recoveryRegistration:true},mock=clientFor(original,"success"),runtimeHash=keccak256("0x1234");
 const zero=(manager:Address,token:Address)=>({address:collector,data:encodeAbiParameters([{type:"uint256"}],[0n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesClaimed",args:{poolId:hash,manager,token}})});
 const t0="0x0000000000000000000000000000000000000001" as Address,t1="0x0000000000000000000000000000000000000002" as Address;
 mock.set({logs:[zero(CONTRACTS.initializer,t0),zero(CONTRACTS.initializer,t1),zero(CONTRACTS.rehype,t0),zero(CONTRACTS.rehype,t1)]});let calls=0;
 mock.client.getCode=async()=>{if(++calls===1)throw Error("429 Retry-After");return"0x1234"};
 const pending=await reconcileBaseFeeBatch(original,mock.client,undefined,runtimeHash);
 assert.equal(pending.status,"evidence_pending");assert.equal(pending.actualGas?.totalWei,"2101025");assert.equal(pending.claimCredits,undefined);
 assert.equal(baseTaskIsolated({...batch(),id:"same-pool"},[pending],account.address),true);assert.equal(baseTaskIsolated(batch("release"),[pending],account.address),false,"Registration evidence only withholds that pool, never the common B20");
 assert.doesNotThrow(()=>assertBaseNoUnknown([pending],account.address));
 const restored=await reconcileBaseFeeBatch(JSON.parse(JSON.stringify(pending)),mock.client,undefined,runtimeHash);
 assert.equal(restored.status,"claimed");assert.deepEqual(restored.claimCredits,[]);assert.equal(restored.sourceHash,hash);assert.equal(restored.actualGas?.totalWei,"2101025");assert.equal(baseTaskIsolated(batch("release"),[restored],account.address),false);
 const releaseBatch={...batch("release"),id:"healthy-real-fee-release",sourceHash:replacement,journal:{...batch("release").journal!,nonce:8}},releaseRpc=clientFor(releaseBatch,"success");
 const released={address:collector,data:encodeAbiParameters([{type:"uint256"}],[100n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesReleased",args:{token:STOCKS[0].address,receiver:automation}})};
 const delivered={address:STOCKS[0].address,data:encodeAbiParameters([{type:"uint256"}],[100n]),topics:encodeEventTopics({abi:parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]),eventName:"Transfer",args:{from:collector,to:automation}})};
 releaseRpc.set({useReplacement:true,logs:[delivered,released]});const healthy=await reconcileBaseFeeBatch(releaseBatch,releaseRpc.client);
 assert.equal(healthy.status,"released");assert.deepEqual(healthy.release,{token:STOCKS[0].address,amount:"100",automation});assert.doesNotThrow(()=>assertBaseNoUnknown([restored,healthy],account.address));
 for(const code of ["0x","0x1235","0xnothex"]){mock.client.getCode=async()=>code as Hex;assert.equal((await reconcileBaseFeeBatch(original,mock.client,undefined,runtimeHash)).status,"evidence_pending","RPC/runtime identity problems are never deterministic receipt faults");}
});
test("historical finalized asset_failed automatically rechecks its original mined source, preserves gas and cannot repeat spending",async()=>{
 const original={...batch(),sourceHash:hash,inputAsset:STOCKS[0],recoveryRegistration:true},mock=clientFor(original,"success"),runtimeHash=keccak256("0x1234");
 const zero=(manager:Address,token:Address)=>({address:collector,data:encodeAbiParameters([{type:"uint256"}],[0n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesClaimed",args:{poolId:hash,manager,token}})});
 const t0="0x0000000000000000000000000000000000000001" as Address,t1="0x0000000000000000000000000000000000000002" as Address;
 const valid=[zero(CONTRACTS.initializer,t0),zero(CONTRACTS.initializer,t1),zero(CONTRACTS.rehype,t0),zero(CONTRACTS.rehype,t1)];mock.set({logs:valid});mock.client.getCode=async()=>"0x1234";mock.client.getBlock=async()=>({number:100n,hash}) as any;
 const complete=await reconcileBaseFeeBatch(original,mock.client,undefined,runtimeHash),old={...complete,status:"asset_failed" as const,sourceFinalized:true,claimCredits:undefined,claimAssets:undefined,evidenceRetryAt:5000};
 const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[old]};let receipts=0;const read=mock.client.getTransactionReceipt;mock.client.getTransactionReceipt=async(args:any)=>{receipts++;assert.equal(args.hash,hash);return read(args)};
 assert.deepEqual(await reconcileBaseKeeperHistory(journal,[old],mock.client,runtimeHash,undefined,64,4999),[]);assert.equal(receipts,0);
 const recovered=await reconcileBaseKeeperHistory(journal,[old],mock.client,runtimeHash,undefined,64,5000);assert.equal(recovered[0].status,"claimed");assert.equal(recovered[0].sourceHash,hash);assert.deepEqual(recovered[0].actualGas,old.actualGas);assert.equal(recovered[0].journal?.nonce,old.journal?.nonce);assert.equal(receipts,1);
 assert.equal(baseTaskIsolated({...batch(),id:"same-pool"},recovered,account.address),false);assert.equal(baseCanonicalGasSpent([old],account.address,true),baseCanonicalGasSpent(recovered,account.address,true));
 mock.client.getTransactionReceipt=async()=>{throw Error("temporary nonarchive receipt timeout")};const waiting=await reconcileBaseKeeperHistory(journal,[old],mock.client,runtimeHash,undefined,64,5000);
 assert.equal(waiting[0].status,"evidence_pending");assert.equal(waiting[0].actualGas?.totalWei,old.actualGas?.totalWei);assert.doesNotThrow(()=>assertBaseNoUnknown(waiting,account.address));assert.equal(baseTaskIsolated(batch("release"),waiting,account.address),false);
 mock.client.getTransactionReceipt=read;mock.set({logs:valid.slice(0,1)});const stillBad=await reconcileBaseKeeperHistory(journal,[old],mock.client,runtimeHash,undefined,64,5000);assert.equal(stillBad[0].status,"asset_failed");assert(stillBad[0].evidenceRetryAt!>5000);assert.equal(stillBad[0].claimCredits,undefined);
 const missingGas={...old,sourceFinalized:undefined,actualGas:undefined};mock.client.getTransactionReceipt=async()=>{throw Error("timeout")};const uncertain=await reconcileBaseKeeperHistory({...journal,batches:[missingGas]},[missingGas],mock.client,runtimeHash,undefined,64,5000);assert.equal(uncertain[0].status,"reorg");assert.throws(()=>assertBaseNoUnknown(uncertain,account.address),/unresolved/);
});
test("settled evidence retries rotate within the 64-row bound while real nonce uncertainty takes priority",async()=>{
 const original={...batch(),sourceHash:hash},mock=clientFor(original,"success"),settled=await reconcileBaseFeeBatch(original,mock.client);
 const old=Array.from({length:80},(_,index)=>{const sourceHash=`0x${(index+1).toString(16).padStart(64,"0")}` as Hex;return{...settled,id:`legacy-fault-${index}`,sourceHash,status:"asset_failed" as const,evidenceRetryAt:undefined,sourceFinalized:true,journal:{...settled.journal!,nonce:index},actualGas:{...settled.actualGas!,transactionHash:sourceHash}}});
 mock.client.getBlock=async()=>({number:100n,hash}) as any;let reads=0;mock.client.getTransactionReceipt=async()=>{reads++;throw Error("429")};
 const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:old},first=await reconcileBaseKeeperHistory(journal,old,mock.client,hash,undefined,64,5000);
 assert.equal(first.length,64);assert.equal(reads,64);assert(first.every(row=>row.status==="evidence_pending"));assert.equal(baseCanonicalGasSpent(old,account.address),baseCanonicalGasSpent([...first,...old.slice(64)],account.address));
 const history=[...first,...old.slice(64)],second=await reconcileBaseKeeperHistory({...journal,batches:history},history,mock.client,hash,undefined,64,35_000);
 assert(second.slice(0,16).every(row=>Number(row.id.slice("legacy-fault-".length))>=64),"Deferred older faults run before recently attempted ones");
 const unresolved={...batch(),id:"unresolved-source",sourceHash:replacement,journal:{...batch().journal!,nonce:81}},mixed=[...history,unresolved];
 const next=await reconcileBaseKeeperHistory({...journal,batches:mixed},mixed,mock.client,hash,undefined,64,35_000);assert.equal(next[0].id,unresolved.id);assert.equal(next[0].status,"unknown");assert.throws(()=>assertBaseNoUnknown(next,account.address),/unresolved/);
});
test("one-raw donations and Collector-blessed unregistered assets create no automatic recovery; cooldown survives restart",()=>{
 const seed=(kind:"sync_untracked"|"release_untracked")=>({...batch("release"),kind,amountIn:"0"}),ctx={policies:BASE_RECOVERY_FIXED_ASSETS,history:[] as BaseFeeBatch[],keeper:account.address,now:10_000};
 const rows=BASE_RECOVERY_FIXED_ASSETS.map(asset=>({...asset,pending:"0",untracked:"1",pendingUntracked:"1",verifiedAsset:true}));
 const attacker={...rows[0],address:automation,untracked:"999999999999999999999",pendingUntracked:"999999999999999999999"};
 const status={available:true,paused:false,automation,assets:[...rows,attacker]} as any;
 assert.deepEqual(baseUntrackedRecoveryTasks(status,seed,ctx),[]);
 rows[0].untracked=rows[0].minimumRaw;rows[0].pendingUntracked="0";assert.equal(baseUntrackedRecoveryTasks(status,seed,ctx).length,1);
 const task=baseUntrackedRecoveryTasks(status,seed,ctx)[0];task.createdAt=ctx.now;task.journal={...batch().journal!};task.status="reverted";
 const restored=JSON.parse(JSON.stringify(task));ctx.history=[restored];ctx.now+=BASE_UNTRACKED_COOLDOWN_MS-1;
 assert.deepEqual(baseUntrackedRecoveryTasks(status,seed,ctx),[]);ctx.now++;
 assert.equal(baseUntrackedRecoveryTasks(status,seed,ctx).length,1);
 rows[0].decimals=18;assert.deepEqual(baseUntrackedRecoveryTasks(status,seed,ctx),[]);
});
test("an exhausted unknown-only gas ceiling and recovery registration never consume the genuine fee ceiling",async()=>{
 const old={...batch("release"),kind:"release_untracked" as const,id:"old-unknown",status:"reverted" as const,actualGas:{totalWei:"99999999"} as any};
 const registration={...batch(),id:"zero-registration",recoveryRegistration:true,status:"reverted" as const};registration.journal={...registration.journal!,nonce:8};
 const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[old,registration]},store={buybackBatchPage:async()=>[]},next={...batch("release"),kind:"release_untracked" as const,id:"new-unknown"};
 assert.equal(baseCanonicalGasSpent(journal.batches,account.address),0n);assert.equal(baseCanonicalGasSpent(journal.batches,account.address,true),110000999n);
 assert.equal(await assertCanonicalBaseUntrackedBudget(journal,next,store,110000999n),false);
 const genuineReserve=KEEPER_TASK_RETRY_POLICY.maximumAttemptGasWei,unknownReservation=next.gasReservation!.totalWei;
 assert.equal(baseUntrackedWalletHasReserve(BigInt(unknownReservation)+genuineReserve-1n,unknownReservation),false,"Unknown recovery cannot consume one genuine task's gas reservation");
 assert.equal(baseUntrackedWalletHasReserve(BigInt(unknownReservation)+genuineReserve,unknownReservation),true);
 const genuineSpent={...batch(),id:"genuine-spent",status:"reverted" as const,actualGas:{totalWei:"4000"} as any};genuineSpent.journal={...genuineSpent.journal!,nonce:9};
 assert.equal(baseUntrackedWalletHasReserve(BigInt(unknownReservation)+genuineReserve-4000n,unknownReservation),false,"Historical genuine spending never releases the unknown-only protected wallet reserve");
 await assertCanonicalBaseTaskGasPolicy(journal,{...batch("release"),id:"genuine"},store);
 await assert.rejects(assertCanonicalBaseTaskGasPolicy(journal,registration,store),/does not permit unknown recovery/);
 const unsignedPending={...next,status:"unknown" as const};assert.throws(()=>assertBaseNoUnknown([unsignedPending],account.address),/unresolved/);
});
test("canonical mined asset-event failure consumes its nonce and gas without poisoning healthy assets or counterfeiting income",async()=>{
 const original={...batch("release"),sourceHash:hash},mock=clientFor(original,"success");
 const release={address:collector,data:encodeAbiParameters([{type:"uint256"}],[100n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesReleased",args:{token:STOCKS[0].address,receiver:automation}})};
 // A token may update balances yet emit an inconsistent ERC20 transfer. The canonical transaction itself is known.
 const transfer={address:STOCKS[0].address,data:encodeAbiParameters([{type:"uint256"}],[99n]),topics:encodeEventTopics({abi:parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]),eventName:"Transfer",args:{from:collector,to:automation}})};
 mock.set({logs:[release,transfer]});const failed=await reconcileBaseFeeBatch(original,mock.client);
 assert.equal(failed.status,"asset_failed");assert.equal(failed.actualGas?.totalWei,"2101025");assert.equal(failed.sourceHash,hash);assert.equal(failed.claimCredits,undefined);assert.equal(failed.burnedAmount,"0");assert.doesNotThrow(()=>assertBaseNoUnknown([failed],account.address));
 assert.equal(baseTaskIsolated(batch("release"),[failed],account.address),true);
 const healthy={...batch("release"),inputAsset:STOCKS[1],release:{...batch("release").release!,token:STOCKS[1].address}};assert.equal(baseTaskIsolated(healthy,[failed],account.address),false);
 mock.set({canonical:false});const reorg=await reconcileBaseFeeBatch(failed,mock.client);assert.equal(reorg.status,"reorg");assert.throws(()=>assertBaseNoUnknown([reorg],account.address),/unresolved/);
 mock.set({canonical:true,l1:null});assert.equal((await reconcileBaseFeeBatch(original,mock.client)).status,"unknown");
});
test("unsigned simulation failure skips one pool while pending nonces and persisted signed hashes remain global blockers",async()=>{
 const client={getTransactionCount:async()=>7,call:async({data}:any)=>{if(data===baseFeeTransaction(batch()).data)throw new Error("Pool simulation reverted");},estimateGas:async()=>100000n,estimateFeesPerGas:async()=>({maxFeePerGas:100n}),getChainId:async()=>8453,getBlock:async()=>({number:100n,hash}),readContract:async()=>1000n} as any;
 assert.equal(await prepareBaseFeeTask(batch(),client,account.address),null);
 assert.ok(await prepareBaseFeeTask(batch("release"),client,account.address));
 client.getTransactionCount=async({blockTag}:any)=>blockTag==="latest"?7:8;
 await assert.rejects(()=>prepareBaseFeeTask(batch("release"),client,account.address),/nonce|unresolved|pending/i);
 const raw=await signed();let saved:BaseFeeBatch|undefined;
 const abandoned=await submitBaseFeeBatch(batch(),{sign:async()=>raw,persistLocal:async row=>{saved=row},persistPublic:async()=>{},beforeBroadcast:async()=>{throw new Error("asset became unavailable")},broadcast:async()=>hash});
 assert.equal(abandoned.status,"abandoned");assert.doesNotThrow(()=>assertBaseNoUnknown([saved!],account.address));
});
test("thousands of finalized source outcomes require no repeated canonical history and cannot flip on receipt/code timeouts",async()=>{
 const h=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
 const history=Array.from({length:1200},(_,index)=>{const value={...batch(),id:`terminal-${index}`,status:"claimed" as const,sourceHash:h(index+10_000),sourceBlockNumber:String(index+1),sourceBlockHash:h(index+1),sourceFinalized:true};return{...value,actualGas:{transactionHash:value.sourceHash,blockNumber:value.sourceBlockNumber,blockHash:value.sourceBlockHash,executionWei:"1",l1Wei:"1",operatorWei:"1",totalWei:"3"}}});
 let blocks=0,receipts=0;const client={getChainId:async()=>8453,getBlockNumber:async()=>2001n,getBlock:async({blockNumber}:any)=>{blocks++;const number=blockNumber??2000n;return{number,hash:h(Number(number))};},getTransactionReceipt:async()=>{receipts++;throw new Error("transient receipt timeout")},getCode:async()=>{throw new Error("transient code timeout")}} as any;
 const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:history};
 assert.deepEqual(await reconcileBaseKeeperHistory(journal,history,client,hash),[]);assert.equal(receipts,0);assert.equal(blocks,0);assert(history.every(row=>row.status==="claimed"));
 const unmarked=history.map(row=>({...row,sourceFinalized:undefined}));blocks=0;
 const results=await reconcileBaseKeeperHistory({...journal,batches:unmarked},unmarked,client,hash);assert.equal(results.length,64);assert(results.every(row=>row.sourceFinalized&&row.status==="claimed"));assert.equal(receipts,0);assert.equal(blocks,66);
 const pending={...batch(),id:"still-unresolved",sourceHash:hash};const candidates=[...history,pending];
 const unresolved=await reconcileBaseKeeperHistory(journal,candidates,client,hash);assert.equal(unresolved.length,1);assert.equal(unresolved[0].status,"unknown");assert.throws(()=>assertBaseNoUnknown(unresolved,account.address),/unresolved/);
});

test("release gates read only the selected canonical fee bucket, preserving quarantine and unknown isolation",async()=>{
 const task=batch("release");let registered=true,pending=1000n;const reads:string[]=[];
 const rpc={readContract:async({address:to,functionName,args}:any)=>{assert.equal(to,collector);assert.deepEqual(args,[task.release!.token]);reads.push(functionName);
   if(functionName==="verifiedAssets")return registered;if(functionName==="pendingFees"||functionName==="pendingUntracked")return pending;throw new Error("The signing gate cannot read display counters or another asset");}} as any;
 await assertBaseSelectedReleaseReadiness(rpc,task);assert.deepEqual(reads,["verifiedAssets","pendingFees"]);
 registered=false;await assert.rejects(assertBaseSelectedReleaseReadiness(rpc,task),/unavailable|insufficient/);registered=true;
 pending=BigInt(task.amountIn)-1n;await assert.rejects(assertBaseSelectedReleaseReadiness(rpc,task),/insufficient/);
 const unknown={...task,kind:"release_untracked" as const};reads.length=0;
 await assert.rejects(assertBaseSelectedReleaseReadiness(rpc,unknown),/insufficient/);assert.deepEqual(reads,["verifiedAssets","pendingUntracked"],"Unknown cannot borrow the genuine bucket");

});
