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
import { allBaseFeeBatches, assertBaseNoUnknown, assertBaseOperationalControl, assertBaseVaultCheckpoint, assertBaseCanaryStorage, baseSourceStore,
  baseCanonicalKeeperLease, writeBasePublicJson, readBasePublicJson, baseFeeTransaction, submitBaseFeeBatch, reconcileBaseFeeBatch, reserveBaseGas,
  assertBaseGasReservationCurrent, assertCanonicalBaseCanaryBudget, assertBaseRoleSecrets, type BaseKeeperJournal } from "../scripts/base-buyback-keeper";
import { runtimeFromEnv } from "../server/config";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";
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
async function signed(prepared = batch()) { return account.signTransaction({ ...baseFeeTransaction(prepared),chainId:8453,nonce:7,gas:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,type:"eip1559" }); }
test("exact native fee hash is fsynced locally and saved publicly before broadcast without raw signed data", async () => {
  const prepared=batch(), raw=await signed(prepared), events:string[]=[], saved:BaseFeeBatch[]=[];
  const result=await submitBaseFeeBatch(prepared,{sign:async()=>{events.push("sign");return raw},persistLocal:async value=>{events.push("local");saved.push(value)},persistPublic:async()=>{events.push("public")},broadcast:async value=>{events.push("broadcast");assert.equal(value,raw);assert.equal(saved[0].sourceHash,keccak256(raw));return keccak256(raw)}});
  assert.deepEqual(events,["sign","local","public","broadcast","local","public"]);assert.equal(result.status,"broadcast");assert(!JSON.stringify(saved).includes(raw));assert.throws(()=>assertBaseNoUnknown(saved),/unresolved/);
  const directory=await mkdtemp(join(tmpdir(),"native-public-"));try{const path=join(directory,"journal.json");await writeBasePublicJson(path,{version:2,batches:saved});assert.deepEqual(await readBasePublicJson(path),JSON.parse(await readFile(path,"utf8")));await assert.rejects(writeBasePublicJson(path,{privateKey:"forbidden"}),/public/)}finally{await rm(directory,{recursive:true,force:true})}
});
test("persistence failure cannot broadcast; a timeout or changed last gate retains unknown hash and reservation",async()=>{
  const raw=await signed();let broadcasts=0,retained:BaseFeeBatch|undefined;
  const deps={sign:async()=>raw,persistLocal:async(value:BaseFeeBatch)=>{retained=value},persistPublic:async()=>{},broadcast:async()=>{broadcasts++;return keccak256(raw)}};
  await assert.rejects(submitBaseFeeBatch(batch(),{...deps,persistPublic:async()=>{throw new Error("DB failed")}}));assert.equal(broadcasts,0);assert.equal(retained?.sourceHash,keccak256(raw));
  await assert.rejects(submitBaseFeeBatch(batch(),{...deps,beforeBroadcast:async()=>{throw new Error("paused")}}),/unresolved/);assert.equal(broadcasts,0);
  await assert.rejects(submitBaseFeeBatch(batch(),{...deps,broadcast:async()=>{throw new Error("timeout")}}),/unresolved/);assert.equal(retained?.status,"unknown");assert.equal(retained?.gasReservation?.totalWei,"10001000");
});
test("the local signer rejects swap/bridge tasks and altered signed chain, calldata or destination",async()=>{
  assert.throws(()=>baseFeeTransaction({...batch(),kind:"native_relay"}),/Automation/);
  let broadcasts=0;const raw=await account.signTransaction({...baseFeeTransaction(batch()),chainId:4663,nonce:7,gas:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,type:"eip1559"});
  await assert.rejects(submitBaseFeeBatch(batch(),{sign:async()=>raw,persistLocal:async()=>{},persistPublic:async()=>{},broadcast:async()=>{broadcasts++;return hash}}),/differs/);assert.equal(broadcasts,0);
  const excess = await account.signTransaction({...baseFeeTransaction(batch()),chainId:8453,nonce:7,gas:200000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,type:"eip1559"});
  await assert.rejects(submitBaseFeeBatch(batch(),{sign:async()=>excess,persistLocal:async()=>{},persistPublic:async()=>{},broadcast:async()=>{broadcasts++;return hash}}),/differs/);assert.equal(broadcasts,0);
});
function clientFor(prepared:BaseFeeBatch, status:"success"|"reverted"="reverted") {
  const transaction=baseFeeTransaction(prepared);let canonical=true, l1:string|null="0x3e8", cancellation=false, useReplacement=false, delegated=false, auth=false, logs:any[]=[];
  const client={async getChainId(){return 8453},async getBlockNumber(){return 100n},async getBlock(){return {hash:canonical?hash:replacement}},async getCode(){return delegated?"0xef0100":"0x"},
    async getTransactionReceipt(){return {transactionHash:cancellation||useReplacement?replacement:hash,status,blockHash:hash,blockNumber:99n,gasUsed:21000n,effectiveGasPrice:100n,logs}},
    async getTransaction(){return {hash:cancellation||useReplacement?replacement:hash,type:"eip1559",authorizationList:auth?[{}]:undefined,from:account.address,to:cancellation?account.address:collector,nonce:7,input:cancellation?"0x":transaction.data,value:0n}},
    async request(){return {transactionHash:cancellation||useReplacement?replacement:hash,blockHash:hash,blockNumber:"0x63",gasUsed:"0x5208",effectiveGasPrice:"0x64",l1Fee:l1}},async readContract(){return 25n}} as unknown as PublicClient<Transport,any>;
  return {client, set(options:{canonical?:boolean;l1?:string|null;cancellation?:boolean;useReplacement?:boolean;delegated?:boolean;auth?:boolean;logs?:any[]}){if(options.canonical!==undefined)canonical=options.canonical;if(options.l1!==undefined)l1=options.l1;if(options.cancellation!==undefined)cancellation=options.cancellation;if(options.useReplacement!==undefined)useReplacement=options.useReplacement;if(options.delegated!==undefined)delegated=options.delegated;if(options.auth!==undefined)auth=options.auth;if(options.logs!==undefined)logs=options.logs}};
}
test("canonical reverted source receipt consumes its nonce and includes L1/operator costs; reorg or missing L1 stays reserved",async()=>{
  const prepared={...batch(),sourceHash:hash};const mock=clientFor(prepared);
  const result=await reconcileBaseFeeBatch(prepared,mock.client);assert.equal(result.status,"reverted");assert.equal(result.actualGas?.totalWei,"2101025");
  mock.set({l1:null});assert.equal((await reconcileBaseFeeBatch(prepared,mock.client)).status,"unknown");
  mock.set({l1:"0x3e8",canonical:false});assert.equal((await reconcileBaseFeeBatch({...prepared,sourceBlockHash:hash},mock.client)).status,"reorg");
});
test("success claim requires actual manager credit, and cancellation requires an empty undelegated same-nonce self transfer",async()=>{
  const prepared={...batch(),sourceHash:hash};const mock=clientFor(prepared,"success");
  assert.equal((await reconcileBaseFeeBatch(prepared,mock.client)).status,"unknown");
  mock.set({logs:[{address:collector,data:encodeAbiParameters([{type:"uint256"}],[100n]),topics:encodeEventTopics({abi:baseCollectorAbi,eventName:"FeesClaimed",args:{poolId:hash,manager:CONTRACTS.initializer,token:STOCKS[0].address}})}]});
  const claimed=await reconcileBaseFeeBatch(prepared,mock.client);assert.equal(claimed.status,"claimed");assert.equal(claimed.claimCredits?.[0].amount,"100");
  mock.set({useReplacement:true});const replaced=await reconcileBaseFeeBatch(prepared,mock.client,replacement);assert.equal(replaced.status,"claimed");assert.equal(replaced.sourceHash,replacement);assert.equal(replaced.replacements?.[0].cancelled,false);
  mock.set({cancellation:true,logs:[]});assert.equal((await reconcileBaseFeeBatch(prepared,mock.client,replacement)).status,"cancelled");
  for(const option of [{delegated:true},{auth:true},{logs:[{}]}]){mock.set({delegated:false,auth:false,logs:[],...option});assert.equal((await reconcileBaseFeeBatch(prepared,mock.client,replacement)).status,"unknown")}
});
test("complete pagination sees unresolved older than 1000, and journal paths cannot reset canonical gas or token ceilings",async()=>{
  const prior={...batch(),id:"old",status:"reverted" as const,sourceHash:hash};let calls=0;
  const rows=Array.from({length:1101},(_,index)=>({...prior,id:`row-${index}`,updatedAt:1101-index,status:index===1100?"unknown":"reverted"}));
  const store={buybackBatchPage:async(limit=100,before?:{updatedAt:number;id:string})=>{calls++;return rows.filter(row=>!before||row.updatedAt<before.updatedAt).slice(0,limit)}};
  const all=await allBaseFeeBatches(store);assert.equal(all.length,1101);assert.equal(calls,12);assert.throws(()=>assertBaseNoUnknown(all),/unresolved/);
  const journal:BaseKeeperJournal={version:2,collector,keeper:account.address,batches:[]};const simple={buybackBatchPage:async()=>[prior]};const rpc={async readContract(){return 100n}} as unknown as PublicClient<Transport,any>;
  await assert.rejects(assertCanonicalBaseCanaryBudget(journal,{...batch(),id:"new"},simple,rpc,10001000n),/cumulative/);
  assert.equal(baseCanonicalKeeperLease(collector,account.address),baseCanonicalKeeperLease(collector,account.address));
  const authorization={keeper:account.address,releaseBudgets:[{token:STOCKS[0].address,decimals:8,maxAmount:"100"}]} as any;
  await assert.rejects(assertCanonicalBaseCanaryBudget(journal,batch("release"),{buybackBatchPage:async()=>[]},rpc,100000000n,authorization),/ceiling/);
});
test("fresh Base GPO reservation includes signed-size L1 upper bound and operator margin, and increased fees stop execution",async()=>{
  let l1=1000n;const rpc={async getChainId(){return 8453},async getBlock(){return {number:100n,hash}},async readContract(input:{functionName:string;args:any[]}){if(input.functionName==="getL1Fee"){assert.match(input.args[0],/^0x02/);return l1-100n}if(input.functionName==="getL1FeeUpperBound"){assert(input.args[0]>65n);return l1}return 20n}} as unknown as PublicClient<Transport,any>;
  const transaction=baseFeeTransaction(batch()), reservation=await reserveBaseGas(rpc,transaction,7,100000n,100n);assert.equal(reservation.totalWei,"10002040");
  await assertBaseGasReservationCurrent(rpc,transaction,7,100000n,100n,reservation);l1=2000n;await assert.rejects(assertBaseGasReservationCurrent(rpc,transaction,7,100000n,100n,reservation),/increased/);
});
test("runtime controls, canonical checkpoint, exact canary scope and isolated key environment all fail closed",async()=>{
  const runtime={config:{mode:"base" as const,chainId:8453,writesEnabled:true,treasury:collector,feeEngine:collector,feePolicy:BASE_AUTOMATION_FEE_POLICY,blockReason:null}};let paused=true;
  const control={runtimeControl:async()=>({paused,revision:0,updatedAt:1,reason:"test"})};await assert.rejects(assertBaseOperationalControl(control,runtime),/persistent/);paused=false;await assertBaseOperationalControl(control,runtime);
  await assert.rejects(assertBaseVaultCheckpoint(async()=>emptyVaultLedgerReport(100n)),/checkpoint/);
  const env={NODE_ENV:"test",CHAIN_MODE:"base",SUPABASE_DATA_SCOPE:"verify-base-canary",DATA_DIR:"/tmp/fixture",SUPABASE_URL:"https://reviewed.supabase.co",SUPABASE_SECRET_KEY:"fixture"};assertBaseCanaryStorage(runtimeFromEnv(undefined,env));
  assert.throws(()=>assertBaseCanaryStorage(runtimeFromEnv(undefined,{...env,SUPABASE_SECRET_KEY:undefined})),/Canary/);
  assert.throws(()=>assertBaseRoleSecrets({MUSEGOD_KEEPER_PRIVATE_KEY:"own",MUSEGOD_DEPLOY_PRIVATE_KEY:"other"}),/only/);
  const old=globalThis.fetch,reads:string[]=[];globalThis.fetch=async url=>{reads.push(String(url));return Response.json([])};try{for(const directory of ["/tmp/a","/tmp/b"]){const store=baseSourceStore(runtimeFromEnv(undefined,{...env,DATA_DIR:directory}));await allBaseFeeBatches(store);await store.close()}assert.equal(reads[0],reads[1]);assert.match(reads[0],/scope=eq.base/)}finally{globalThis.fetch=old}
});
test("an undeployed execute entry point cannot load a shared env file or create a signing wallet",async()=>{
  const source=`process.loadEnvFile=()=>{throw new Error('UNSAFE_SHARED_ENV_LOAD')};const {runBaseBuybackKeeper}=await import(${JSON.stringify(new URL("../scripts/base-buyback-keeper.ts",import.meta.url).href)});try{await runBaseBuybackKeeper(['--execute','--once']);throw new Error('unexpected execution')}catch(error){if(!/not deployed/.test(error.message))throw error;console.log('blocked_without_env')}`;
  const result=await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",source],{env:{PATH:process.env.PATH,NODE_ENV:"test"},timeout:15000});assert.match(result.stdout,/blocked_without_env/);
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
  assert.equal(resolved.actualGas?.totalWei, "2101025"); assert.doesNotThrow(() => assertBaseNoUnknown([resolved]));
  const failedAbi = parseAbi(["event ClaimFailed(bytes32 indexed poolId,address indexed manager,bytes reason)"]);
  const failed = { address: collector, data: encodeAbiParameters([{type:"bytes"}],["0x1234"]),
    topics: encodeEventTopics({abi:failedAbi,eventName:"ClaimFailed",args:{poolId:hash,manager:CONTRACTS.rehype}}) };
  mock.set({logs:[zero(),zero(CONTRACTS.initializer,token1),failed]});
  assert.equal((await reconcileBaseFeeBatch(prepared,mock.client,undefined,runtimeHash)).status,"claimed","One successful zero manager pair plus the other recognized failure consumes the nonce without income");
  for (const logs of [[], [zero()], [...complete, zero()], [zero(), zero(CONTRACTS.initializer, token1, replacement)],
    [zero("0x3333333333333333333333333333333333333333" as Address), ...complete.slice(1)], [{...zero(), data:"0x"}, ...complete.slice(1)]]) {
    mock.set({logs}); assert.equal((await reconcileBaseFeeBatch(prepared, mock.client, undefined, runtimeHash)).status, "unknown");
  }
  mock.set({logs:complete}); assert.equal((await reconcileBaseFeeBatch(prepared, mock.client, undefined, hash)).status, "unknown");
});
