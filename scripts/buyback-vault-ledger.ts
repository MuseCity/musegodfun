import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { base, robinhood } from "viem/chains";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";
import { createVaultLedgerRuntime, openVaultLedgerReadOnlyStore, readCanonicalBaseSourceBatches } from "../server/buyback-vault-runtime";
import { BASE_COLLECTOR_MANIFEST } from "../server/base-collector";
import { verifyBaseCollectorForOperator } from "./verify-base";
import { baseOperatorAuditStore } from "./base-audit-store";
import { verifyBaseNativeRelayProof } from "../server/base-native-provenance";
import { BASE_BUYBACK_PROTOCOL, type BaseFeeBatch, type BaseNativeRelayProofInput } from "../src/lib/base-buyback";
import { SupabaseStore, type StoreBackend } from "../server/supabase-store";
import { Store } from "../server/store";
import { createLocalReplayClient } from "./base-local-replay";
import { baseCanonicalAuditLease } from "./base-buyback-keeper";
import { acquireBaseProcessLease, type BaseProcessLease } from "./base-process-lease";
import { isDeepStrictEqual } from "node:util";
import type { BaseAuditStore } from "../server/base-audit";
/** Keeper code facts live in the canonical Base scope. Local verified operator
 * facts remain a read fallback; neither backend can be mutated by this getter. */
export function readonlyCanonicalBaseAuditSource(canonicalBase:Pick<BaseAuditStore,"getBuybackBatch">,local:Pick<BaseAuditStore,"getBuybackBatch">):Pick<BaseAuditStore,"getBuybackBatch">{
 return{async getBuybackBatch(id){try{const row=await canonicalBase.getBuybackBatch(id);if(row!=null)return row;}catch{/* Optional cache read only; live validation or a valid local cache is still required. */}
  return local.getBuybackBatch(id);}};
}
/** Mutating CLI progress remains local. Only independently verified historical
 * destination code facts can be read from the keeper's canonical Base cache. */
export function destinationCodeAuditStore(local:BaseAuditStore,canonicalBase:Pick<BaseAuditStore,"getBuybackBatch">):BaseAuditStore{
 const codes=readonlyCanonicalBaseAuditSource(canonicalBase,local);
 return{getBuybackBatch:id=>id.startsWith("internal_native_destination_code:")?codes.getBuybackBatch(id):local.getBuybackBatch(id),
  compareAndSetBuybackAudit:(next,expected)=>local.compareAndSetBuybackAudit(next,expected)};
}
/** Read commands can compute temporary verified progress without touching the
 * production private cache, financial journals, retry clocks, or host lease. */
export function readonlyBaseAuditOverlay(source:Pick<BaseAuditStore,"getBuybackBatch">):BaseAuditStore{
 const rows=new Map<string,Awaited<ReturnType<BaseAuditStore["getBuybackBatch"]>>>();
 const get=async(id:string)=>{if(!rows.has(id))rows.set(id,structuredClone(await source.getBuybackBatch(id)));return structuredClone(rows.get(id)??null);};
 return{getBuybackBatch:get,async compareAndSetBuybackAudit(next,expected){
  if(!next.id.startsWith("internal_native_")||!String(next.protocol).startsWith("internal_native_"))throw new Error("Readonly overlay accepts audit metadata only");
  if(!isDeepStrictEqual(await get(next.id),JSON.parse(JSON.stringify(expected))))return false;
  rows.set(next.id,JSON.parse(JSON.stringify(next)));return true;
 }};
}
export function vaultLedgerCliOperation(args:string[]):"read"|"reconcile"|"initialize"|"import"|"help" {
  const actions=args.filter(arg=>!arg.startsWith("--chain="));
  if(!actions.length||actions.length===1&&actions[0]==="--read")return"read";
  if(actions.length!==1)throw new Error("Use exactly one custody operation: --read, --reconcile, --initialize or --import-proof=path");
  if(actions[0]==="--help")return"help";if(actions[0]==="--reconcile")return"reconcile";if(actions[0]==="--initialize")return"initialize";
  if(actions[0].startsWith("--import-proof=")&&actions[0].slice(15))return"import";throw new Error("Unknown custody operation");
}
export async function runVaultLedgerCli(args:string[]) {
  const operation=vaultLedgerCliOperation(args),chains=args.filter(arg=>arg.startsWith("--chain="));
  if(chains.length>1||chains.some(arg=>!["--chain=8453","--chain=4663"].includes(arg)))throw new Error("Use one explicit Base 8453 or Robinhood 4663 chain");
  const chain=chains[0]==="--chain=8453"?8453:4663;
  if(operation==="help") {console.log("Usage: ledger:buyback -- [--chain=8453|4663] [--read|--initialize|--reconcile|--import-proof=path]\nDefault read is read-only. Initialization/reconciliation write only this chain's canonical journal. Initialize Base Automation and Robinhood Treasury/Vault before releasing fees. Import accepts retained public Relay response + source/destination hashes on Base only, verifies canonical order/calls/receipts, and never signs or broadcasts transactions.");return;}
  loadEnvironment();const runtime=runtimeFromEnv(chain);if(runtime.config.mode==="fork")throw new Error("Native cross-chain journal CLI requires canonical RPCs, never a fork");runtime.dataScope=chain===8453?"base":"robinhood";
  const productionAuditStore=baseOperatorAuditStore();
  const replayAuditStore=operation==="read"?{getBuybackBatch:productionAuditStore.getBuybackBatch}:productionAuditStore;
  const proofClient=(peer:typeof runtime)=>{
    const client=createPublicClient({chain:peer.config.chainId===8453?base:robinhood,transport:http(peer.rpcUrl,{timeout:15_000,retryCount:1})});
    return peer.config.chainId===8453?createLocalReplayClient(client,{chainId:8453,rpcUrl:peer.rpcUrl,auditStore:replayAuditStore}):client;
  };
  const client=proofClient(runtime);
  const store=operation==="read"?await openVaultLedgerReadOnlyStore(runtime):runtime.supabase?new SupabaseStore(runtime.supabase.url,runtime.supabase.secretKey,runtime.dataScope,"base"):new Store(runtime.dataDir,chain);
  let canonicalBaseRead:ReturnType<typeof openVaultLedgerReadOnlyStore>|undefined;
  const canonicalAuditSource={async getBuybackBatch(id:string){
    if(chain===8453)return store.getBuybackBatch(id);
    const source=runtimeFromEnv(8453);source.dataScope="base";
    const backend=await(canonicalBaseRead??=openVaultLedgerReadOnlyStore(source));return backend.getBuybackBatch(id);
  }};
  const privateAuditStore=operation==="read"?readonlyBaseAuditOverlay(readonlyCanonicalBaseAuditSource(canonicalAuditSource,productionAuditStore)):destinationCodeAuditStore(productionAuditStore,canonicalAuditSource);
  const ledger=createVaultLedgerRuntime({runtime,client,store},{auditStore:privateAuditStore,createPeerClient:proofClient});
  let unlock:BaseProcessLease|undefined;
  try {
    if(operation!=="read") {
      if(!BASE_COLLECTOR_MANIFEST.collector.address)throw new Error("Deploy and verify the Base Collector before initializing native custody");
      unlock=await acquireBaseProcessLease(baseCanonicalAuditLease(BASE_COLLECTOR_MANIFEST.collector.address));
    }
    unlock?.assertHeld();
    if(operation==="import") {
      if(chain!==8453||!("saveBuybackBatch"in store))throw new Error("Native public proof imports belong to the canonical Base store");
      const path=args.find(arg=>arg.startsWith("--import-proof="))!.slice(15),text=await readFile(resolve(path),"utf8");if(text.length>1_000_000)throw new Error("Native public proof exceeds import bound");
      const proof=JSON.parse(text) as BaseNativeRelayProofInput;
      const graph=await verifyBaseCollectorForOperator(client,BASE_COLLECTOR_MANIFEST.collector.address!,{requireActivation:false});
      const rhRuntime=runtimeFromEnv(4663),destination=proofClient(rhRuntime);
      const evidence=await verifyBaseNativeRelayProof(client,destination,proof,graph.automationReceiver,{auditStore:privateAuditStore}),batches=await readCanonicalBaseSourceBatches(store);
      if(batches.some(batch=>batch.kind==="native_relay"&&batch.id!==evidence.requestId&&(batch.relay?.orderId===evidence.orderId||batch.sourceHash===evidence.sourceTransactionHash||batch.destinationHash===evidence.destinationTransactionHash)))throw new Error("Native source/order/destination proof is already linked to another batch");
      const prior=await store.getBuybackBatch(evidence.requestId);if(prior&&(prior.protocol!==BASE_BUYBACK_PROTOCOL||JSON.stringify(prior.proof)!==JSON.stringify(proof)))throw new Error("Native proof cannot replace an existing protocol/order record");
      const now=Date.now(),record:BaseFeeBatch={id:evidence.requestId,protocol:BASE_BUYBACK_PROTOCOL,sourceChainId:8453,destinationChainId:4663,collector:graph.collector,kind:"native_relay",status:"received",createdAt:(prior?.createdAt as number|undefined)??now,updatedAt:now,amountIn:evidence.sourceAmount,receivedAmount:evidence.outputAmount,refundedAmount:"0",burnedAmount:"0",claimHashes:[],sourceHash:evidence.sourceTransactionHash,sourceBlockNumber:evidence.sourceBlockNumber,sourceBlockHash:evidence.sourceBlockHash,destinationHash:evidence.destinationTransactionHash,proof,relay:evidence};
      await (store as StoreBackend).saveBuybackBatch(record as unknown as Parameters<Store["saveBuybackBatch"]>[0]);console.log(JSON.stringify({imported:evidence.requestId,canonicalActualReceivedWeth:evidence.outputAmount,note:"Custody reconciliation must still establish source fee FIFO and final actual burn"},null,2));
    } else {if(operation!=="read")await ledger[operation]();console.log(JSON.stringify(await ledger.custody(),null,2));}
  } finally {try{await ledger.close();await store.close();}finally{try{const source=await canonicalBaseRead?.catch(()=>undefined);await source?.close();}finally{await unlock?.();}}}
}
const direct=process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url;
const runner=process.argv[2]&&pathToFileURL(resolve(process.argv[2])).href===import.meta.url&&process.argv[1]?.endsWith("run.ts");
if(direct||runner){try{await runVaultLedgerCli(process.argv.slice(runner?3:2));}catch(error){console.error(redact(error));process.exitCode=1;}}
