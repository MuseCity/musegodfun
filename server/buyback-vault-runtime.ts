import { createPublicClient, getAddress, http, keccak256, parseAbiItem, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { base, robinhood } from "viem/chains";
import { deploymentChain, sameAddress, STOCKS } from "../src/lib/config";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_BUYBACK_WETH, type BaseFeeBatch } from "../src/lib/base-buyback";
import { convertCustodyFragments, emptyCustodyReport, type CustodyCommit, type CustodyEvent, type CustodyLedgerId, type CustodyReport } from "../src/lib/buyback-custody-ledger";
import { emptyVaultLedgerReport, vaultEventId, type VaultBaseFillEvidence, type VaultEventCursor, type VaultLedgerCommit, type VaultLedgerEvent, type VaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector, type BaseCollectorManifest } from "./base-collector";
import { baseActivationAcceptanceReady } from "./base-activation-record";
import { verifyBaseNativeRelayProof, verifyAdapterRelease, verifyTreasuryForward, nativeRelayFragments, canonicalProofJson } from "./base-native-provenance";
import { verifyFeeEngineRuntime } from "./buyback-engine";
import rhDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { captureNativeRelayDestinations, observeNativeRelayBatches } from "./base-native-observer";
import { prepareNativeCandidateBudget, readAuditedNativeRelay } from "./base-native-candidates";
import type { BaseAuditStore } from "./base-audit";
import type { nativeDestinationHasFixedProvider } from "./base-native-trace";
import { CustodyLedgerService, readAllCustodyEvents, type CustodyLedgerStore } from "./buyback-custody-ledger";
import { VaultLedgerService, type VaultLedgerStore } from "./buyback-vault-ledger";
import { runtimeFromEnv, type Runtime } from "./config";
import { SupabaseStore, type StoreBackend } from "./supabase-store";

type Client=PublicClient<Transport,any>;
type SourceStore=Pick<StoreBackend,"getBuybackBatch"|"saveBuybackBatch"|"compareAndSetBuybackAudit"|"buybackBatchPage"|"close"> & CustodyLedgerStore;
type PeerStore=VaultLedgerStore & SourceStore;
export type NativeCustodyReadiness={ready:boolean;reason:string|null;automation:CustodyReport;treasury:CustodyReport;vault:VaultLedgerReport};
export function assertNativeCustodyReadiness(report:NativeCustodyReadiness) {
  if(!report.ready||!report.automation.ready||!report.automation.fresh||!report.treasury.ready||!report.treasury.fresh||!report.vault.attributionReady||!report.vault.fresh)
    throw new Error(report.reason??"Canonical Base Automation, Robinhood Treasury and Vault checkpoints must all be caught up before fee release");
}
export type VaultLedgerRuntime={read():Promise<VaultLedgerReport>;automationPolicy():Promise<"unverified"|"configured"|"paused">;custody():Promise<NativeCustodyReadiness>;
  sourceStatus():Promise<{ready:boolean;assets:{asset:Address;pending:string;verifiedClaimed:string}[];receivedWeth:string;refundedWeth:string}>;
  reconcile(maxDurationMs?:number):Promise<VaultLedgerReport>;initialize():Promise<VaultLedgerReport>;close():void|Promise<void>};
export type VaultLedgerRuntimeInput={runtime:Runtime;client:Client;store:PeerStore};
export type VaultLedgerRuntimeDependencies={manifest?:BaseCollectorManifest;openPeerStore?:(runtime:Runtime)=>PeerStore|Promise<PeerStore>;
  auditStore?:BaseAuditStore;
  createPeerClient?:(runtime:Runtime)=>Client;verifyCollector?:typeof verifyBaseCollector;
  verifyRobinhoodGraph?:(client:Client)=>Promise<{vault:Address;weth:Address;swapper:Address;engineForwarders?:Address[]}>;
  confirmations?:bigint;maxBlocks?:number;verifyNativeRelay?:typeof verifyBaseNativeRelayProof;verifyRelease?:typeof verifyAdapterRelease;verifyForward?:typeof verifyTreasuryForward;
  verifyNativeDestinationProvider?:typeof nativeDestinationHasFixedProvider};
/** Uses the full keyset journal, never the latest-1000 display list. */
export async function readCanonicalBaseSourceBatches(store:Pick<SourceStore,"buybackBatchPage">,deadline=Infinity):Promise<BaseFeeBatch[]> {
  const result:BaseFeeBatch[]=[];let before:{sequence:string}|undefined;
  for(;;){if(Date.now()>=deadline)throw new Error("Native maintenance budget reached; pending");const page=await store.buybackBatchPage(100,before);for(const row of page)if(row.protocol===BASE_BUYBACK_PROTOCOL&&row.sourceChainId===8453&&row.destinationChainId===4663)result.push(row as unknown as BaseFeeBatch);
    if(page.length<100)return result;const last=page.at(-1)!;if(before?.sequence===last.sequence)throw new Error("Source pagination did not advance");before={sequence:last.sequence};}
}
export async function openVaultLedgerReadOnlyStore(runtime:Runtime):Promise<PeerStore> {
  if(runtime.supabase)return new SupabaseStore(runtime.supabase.url,runtime.supabase.secretKey,runtime.dataScope,"base");
  const [{DatabaseSync},{join}]=await Promise.all([import("node:sqlite"),import("node:path")]);const db=new DatabaseSync(join(runtime.dataDir,"launchpad.sqlite"),{readOnly:true});
  const identity=db.prepare("SELECT value FROM metadata WHERE key='chainId'").get() as {value:string}|undefined;
  if(identity?.value!==String(runtime.config.chainId)){db.close();throw new Error("Peer database chain mismatch");}
  const parsed=(query:string,...values:(string|number|bigint)[]) => (db.prepare(query).all(...values) as {payload:string;updated_at?:number;sequence?:string}[]).map(row=>({...JSON.parse(row.payload),...(row.updated_at===undefined?{}:{updatedAt:row.updated_at}),...(row.sequence===undefined?{}:{sequence:row.sequence})}));
  const size=(limit:number,max=1000)=>{if(!Number.isInteger(limit)||limit<1||limit>max)throw new Error("Invalid journal page size");};
  return {close(){db.close();},vaultLedgerState(){return parsed("SELECT payload FROM vault_ledger_state WHERE id=1")[0]??null;},
    vaultLedgerEventPage(limit=500,after?:VaultEventCursor){size(limit);return after?parsed("SELECT payload FROM vault_ledger_events WHERE (block_number,transaction_index,log_index)>(?,?,?) ORDER BY block_number,transaction_index,log_index LIMIT ?",BigInt(after.blockNumber),after.transactionIndex,after.logIndex,limit):parsed("SELECT payload FROM vault_ledger_events ORDER BY block_number,transaction_index,log_index LIMIT ?",limit);},
    vaultLedgerBlockPage(limit=500,before?:string){size(limit);return before===undefined?parsed("SELECT payload FROM vault_ledger_blocks ORDER BY number DESC LIMIT ?",limit):parsed("SELECT payload FROM vault_ledger_blocks WHERE number<? ORDER BY number DESC LIMIT ?",BigInt(before),limit);},
    commitVaultLedger(_input:VaultLedgerCommit):never{throw new Error("Peer journal is read-only");},
    custodyLedgerState(id){return parsed("SELECT payload FROM custody_ledger_state WHERE id=?",id)[0]??null;},
    custodyLedgerEventPage(id,limit=500,after?:VaultEventCursor){size(limit);return after?parsed("SELECT payload FROM custody_ledger_events WHERE ledger_id=? AND (block_number,transaction_index,log_index)>(?,?,?) ORDER BY block_number,transaction_index,log_index LIMIT ?",id,BigInt(after.blockNumber),after.transactionIndex,after.logIndex,limit):parsed("SELECT payload FROM custody_ledger_events WHERE ledger_id=? ORDER BY block_number,transaction_index,log_index LIMIT ?",id,limit);},
    custodyLedgerBlockPage(id,limit=500,before?:string){size(limit);return before===undefined?parsed("SELECT payload FROM custody_ledger_blocks WHERE ledger_id=? ORDER BY number DESC LIMIT ?",id,limit):parsed("SELECT payload FROM custody_ledger_blocks WHERE ledger_id=? AND number<? ORDER BY number DESC LIMIT ?",id,BigInt(before),limit);},
    commitCustodyLedger(_input:CustodyCommit):never{throw new Error("Peer journal is read-only");},
    saveBuybackBatch():never{throw new Error("Peer audit store is read-only");},
    compareAndSetBuybackAudit():never{throw new Error("Peer audit store is read-only");},
    getBuybackBatch(id){return parsed("SELECT payload FROM buyback_batches WHERE id=?",id)[0]??null;},
    buybackBatchPage(limit=100,before){size(limit,100);return before?parsed("SELECT payload,updated_at,CAST(rowid AS TEXT) AS sequence FROM buyback_batches WHERE rowid<? ORDER BY rowid DESC LIMIT ?",BigInt(before.sequence),limit):parsed("SELECT payload,updated_at,CAST(rowid AS TEXT) AS sequence FROM buyback_batches ORDER BY rowid DESC LIMIT ?",limit);}};
}
const unavailable=(reason:string)=>({ready:false,reason,automation:emptyCustodyReport("base_automation",0n,reason),treasury:emptyCustodyReport("robinhood_treasury",0n,reason),vault:emptyVaultLedgerReport(0n,reason)});
const stable=canonicalProofJson;
function matchingNativeVaultProof(actual:VaultBaseFillEvidence,evidence:VaultBaseFillEvidence) {
  if(!("protocol"in actual)||!("protocol"in evidence))return false;
  const canonical={...actual,treasuryRevision:evidence.treasuryRevision};
  // Older retained proofs omitted the pairing index; the canonical verifier still proves the exact transfer/Forwarded pair.
  if(evidence.forwarderLogIndex===undefined)delete canonical.forwarderLogIndex;
  return stable(canonical)===stable(evidence);
}
export function createVaultLedgerRuntime(input:VaultLedgerRuntimeInput,deps:VaultLedgerRuntimeDependencies={}):VaultLedgerRuntime {
  const auditStore=deps.auditStore??input.store;
  const manifest=deps.manifest??BASE_COLLECTOR_MANIFEST,chain=deploymentChain(input.runtime.config),fork=input.runtime.config.mode==="fork";
  const confirmations=deps.confirmations??64n;const extraStores=new Set<PeerStore>();let closed=false;
  const peers=new Map<number,Promise<{runtime:Runtime;store:PeerStore;client:Client}>>();
  const peer=async(id:8453|4663)=>{
    if(closed||fork)throw new Error("A closed runtime or local fork cannot verify canonical cross-chain custody");
    if(chain===id&&input.runtime.dataScope===(id===8453?"base":"robinhood"))return input;
    if(!peers.has(id))peers.set(id,(async()=>{const runtime=runtimeFromEnv(id,input.runtime.environment??{});runtime.dataScope=id===8453?"base":"robinhood";
      const store=await(deps.openPeerStore??openVaultLedgerReadOnlyStore)(runtime);extraStores.add(store);
      const client=deps.createPeerClient?.(runtime)??createPublicClient({chain:id===8453?base:robinhood,transport:http(runtime.rpcUrl,{batch:{batchSize:20,wait:0},timeout:15_000,retryCount:1}),batch:{multicall:true}});return{runtime,store,client};})().catch(error=>{peers.delete(id);throw error;}));
    return peers.get(id)!;
  };
  const graph=async(source:Awaited<ReturnType<typeof peer>>,destination:Client)=>{
    if(manifest.status!=="deployed_verified"||!manifest.collector.address)throw new Error("Base native fee adapter is not deployed");
    return(deps.verifyCollector??verifyBaseCollector)(source.client,getAddress(manifest.collector.address),{manifest,
      requireActivation:false,robinhoodClient:destination,auditStore});
  };
  const rhGraph=async(client:Client)=>{if(deps.verifyRobinhoodGraph)return deps.verifyRobinhoodGraph(client);
    const verified=await verifyFeeEngineRuntime(client as unknown as Parameters<typeof verifyFeeEngineRuntime>[0],getAddress(rhDeployment.contracts.engine.address!));
    if(!sameAddress(verified.vault,BASE_BUYBACK_VAULT))throw new Error("RH Vault differs from fixed Treasury destination");
    return{vault:verified.vault,weth:BASE_BUYBACK_RH_WETH,swapper:verified.swapper,engineForwarders:[verified.engine,verified.forwarder]};};
  const session=async(deadline=Date.now()+12_000,prewarm=true)=>{
    const checkBudget=()=>{if(Date.now()>=deadline)throw new Error("Native maintenance budget reached; pending");};
    const [source,rh]=await Promise.all([peer(8453),peer(4663)]);checkBudget();const checked=await graph(source,rh.client);checkBudget();const checkedRh=await rhGraph(rh.client);checkBudget();const batches=await readCanonicalBaseSourceBatches(source.store,deadline);checkBudget();
    const relayProofs=batches.filter(batch=>batch.kind==="native_relay"&&batch.proof);
    // Conflicting active proofs withhold attribution, but never stop the observer from recovering retained unknown/reorg rows.
    const identities=new Map<string,string>(),ambiguous=new Set<string>();
    for(const batch of relayProofs.filter(batch=>["received","awaiting_buyback","attributed"].includes(batch.status))){
      const keys=[`source:${batch.proof!.sourceHash.toLowerCase()}`,`request:${(batch.requestId??batch.relay?.requestId??batch.id).toLowerCase()}`,
        ...((batch.orderId??batch.relay?.orderId)?[`order:${(batch.orderId??batch.relay?.orderId)!.toLowerCase()}`]:[]),
        ...(batch.relay?[`destination:${batch.relay.destinationTransactionHash.toLowerCase()}:${batch.relay.destinationTransferLogIndex}`]:[])];
      for(const key of keys){const other=identities.get(key);if(other){ambiguous.add(other);ambiguous.add(batch.id);}else identities.set(key,batch.id);}
    }
    const relayCache=new Map<string,Promise<Awaited<ReturnType<typeof verifyBaseNativeRelayProof>>>>();
    const candidateBudget=await prepareNativeCandidateBudget(auditStore,relayProofs.filter(batch=>["received","awaiting_buyback","attributed"].includes(batch.status)&&!ambiguous.has(batch.id)).map(batch=>batch.id),
      {graph:checked.manifestFingerprint??stable({collector:checked.collector,automation:checked.automationReceiver,runtimeHash:checked.runtimeHash}),checkpoint:(await rh.store.custodyLedgerState("robinhood_treasury"))?.checkpoint},deadline);checkBudget();
    let treasuryEvents:Promise<Awaited<ReturnType<typeof readAllCustodyEvents>>>|undefined;
    const readTreasuryEvents=()=>treasuryEvents??=readAllCustodyEvents(rh.store,"robinhood_treasury",deadline);
    const relay=async(batch:BaseFeeBatch)=>{if(!batch.proof||ambiguous.has(batch.id)||!["received","awaiting_buyback","attributed"].includes(batch.status))throw new Error("Native proof missing, ambiguous or awaiting canonical recovery");
     if(!relayCache.has(batch.id))relayCache.set(batch.id,(async()=>{
      const audited=await readAuditedNativeRelay({source:source.client,destination:rh.client,store:auditStore,batch,
       graphFingerprint:checked.manifestFingerprint??stable({collector:checked.collector,automation:checked.automationReceiver,runtimeHash:checked.runtimeHash}),
       treasuryState:await rh.store.custodyLedgerState("robinhood_treasury"),events:await readTreasuryEvents(),budget:candidateBudget,deadline,
       verify:()=>(deps.verifyNativeRelay??verifyBaseNativeRelayProof)(source.client,rh.client,batch.proof!,checked.automationReceiver,{auditStore}),authenticate:deps.verifyNativeDestinationProvider});
      const proof=audited.proof;const [sh,dh]=await Promise.all([source.client.getBlockNumber(),rh.client.getBlockNumber()]);
      if(sh<BigInt(proof.sourceBlockNumber)+confirmations||dh<BigInt(proof.destinationBlockNumber)+confirmations)throw new Error("Native proof lacks confirmed depth");
      return proof;
     })());return relayCache.get(batch.id)!;};
    // Rotated selected runs get their bounded share before chronological journal
    // projection. A slow old run cannot always be first after a Worker deadline.
    if(prewarm)for(const id of candidateBudget.order??[]){checkBudget();const batch=relayProofs.find(row=>row.id===id)!;try{await relay(batch);}catch{/* Withhold only this run; later selected runs retain their reserved share. */}}
    const automation=new CustodyLedgerService(source.store,source.client as unknown as PublicClient,{id:"base_automation",account:checked.automationReceiver,initialAssets:[...STOCKS.map(stock=>stock.address),BASE_BUYBACK_WETH],confirmations,maxBlocks:deps.maxBlocks,
      discoverAssets:async(from,to,deadline)=>{const assets:Address[]=[];for(let start=from;start<=to;start+=10n){if(Date.now()>=deadline)throw new Error("Native maintenance budget reached; pending");const end=start+9n<to?start+9n:to;
        const groups=await Promise.all([parseAbiItem("event FeesReleased(address indexed token,address indexed receiver,uint256 amount)"),parseAbiItem("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)")].map(event=>source.client.getLogs({address:checked.collector,event,fromBlock:start,toBlock:end,strict:true})));
        for(const log of groups.flat())if(log.args&&"token"in log.args&&"receiver"in log.args&&"amount"in log.args&&sameAddress(log.args.receiver as Address,checked.automationReceiver)&&BigInt(log.args.amount as bigint)>0n)assets.push(log.args.token as Address);
      }return assets;},
      verifyEvidence:async(event,evidence,fragments)=>{try{if(evidence.kind!=="adapter_release"||stable(fragments)!==stable([{batchId:event.id,amount:event.amount}]))return false;
        const actual=await(deps.verifyRelease??verifyAdapterRelease)(source.client,event,checked.collector,checked.automationReceiver);
        const code=await source.client.getCode({address:checked.collector,blockNumber:BigInt(event.blockNumber)});
        return!!code&&code!=="0x"&&keccak256(code)===checked.runtimeHash&&stable(actual)===stable(evidence);
      }catch{return false;}}});
    let sourceReport:Promise<CustodyReport>|undefined;const sourceReady=()=>sourceReport??=automation.read(deadline);
    let evidenceEnabled=prewarm;
    const treasury=new CustodyLedgerService(rh.store,rh.client as unknown as PublicClient,{id:"robinhood_treasury",account:BASE_BUYBACK_TREASURY,initialAssets:[BASE_BUYBACK_RH_WETH],confirmations,maxBlocks:deps.maxBlocks,
      verifyEvidence:async(event,evidence,fragments)=>{try{if(!evidenceEnabled||evidence.kind!=="native_relay")return false;const candidates=relayProofs.filter(batch=>["received","awaiting_buyback","attributed"].includes(batch.status)&&!ambiguous.has(batch.id)&&batch.proof!.sourceHash.toLowerCase()===evidence.relay.sourceTransactionHash.toLowerCase());if(candidates.length!==1)return false;
        const proof=await relay(candidates[0]);if(stable(proof)!==stable(evidence.relay)||event.id!==vaultEventId(proof.destinationTransactionHash,proof.destinationTransferLogIndex)||event.amount!==proof.outputAmount||event.blockHash!==proof.destinationBlockHash)return false;
        const ar=await sourceReady();if(!ar.fresh)return false;const consumed=ar.consumptions.find(row=>row.eventId===vaultEventId(proof.sourceTransactionHash,proof.sourceTransferLogIndex));
        return!!consumed&&consumed.amount===proof.sourceAmount&&evidence.sourceEventId===consumed.eventId&&stable(nativeRelayFragments(consumed.fragments,proof,candidates[0].id))===stable(fragments);
      }catch{return false;}}});
    let treasuryReport:Promise<CustodyReport>|undefined;const treasuryReady=()=>treasuryReport??=treasury.read(deadline);
    const nativeVaultProof=async(event:VaultLedgerEvent):Promise<VaultBaseFillEvidence|null>=>{
      if(event.kind!=="weth_in"||!sameAddress(event.from,BASE_BUYBACK_TREASURY))return null;const tr=await treasuryReady();if(!tr.ready)return null;
      const consumed=tr.consumptions.find(row=>row.eventId===event.id);if(!consumed)return null;
      const actual=(await readTreasuryEvents()).find(row=>row.id===event.id);if(!actual)return null;
      const forward=await(deps.verifyForward??verifyTreasuryForward)(rh.client,actual,event);
      return{protocol:BASE_BUYBACK_PROTOCOL,treasury:BASE_BUYBACK_TREASURY,treasuryEventId:event.id,treasuryRevision:tr.revision,fragments:consumed.fragments,
        ...(forward?{forwarderLogIndex:forward.forwarderLogIndex}:{}),fillTransactionHash:event.transactionHash,fillBlockHash:event.blockHash,fillLogIndex:event.logIndex,recipient:BASE_BUYBACK_VAULT,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:event.amount};};
    const vault=new VaultLedgerService(rh.store,rh.client as unknown as PublicClient,{...checkedRh,confirmations,maxBlocks:deps.maxBlocks,resolveBaseFill:nativeVaultProof,verifyBaseFill:async(event,evidence)=>{
      if(!("protocol"in evidence))return false;try{const actual=await nativeVaultProof(event);return!!actual&&matchingNativeVaultProof(actual,evidence);}catch{return false;}}});
    const readVault=async()=>{const report=await vault.read(deadline);return Date.now()>=deadline?emptyVaultLedgerReport(BigInt(report.confirmedThrough),"Native attribution read budget reached; projection pending"):report;};
    return{source,rh,checked,batches,relayProofs,relay,automation,treasury,vault,readVault,nativeVaultProof,sourceReady,treasuryReady,enableEvidence:()=>{evidenceEnabled=true;treasuryReport=undefined;},refreshTreasury:()=>{treasuryReport=undefined;}};
  };
  const custody=async():Promise<NativeCustodyReadiness>=>{try{const work=await session();const [automation,treasury,vault]=await Promise.all([work.sourceReady(),work.treasuryReady(),work.readVault()]);
    const ready=automation.ready&&automation.fresh&&treasury.ready&&treasury.fresh&&vault.attributionReady&&vault.fresh;
    return{ready,reason:ready?null:automation.reason??treasury.reason??vault.reason??"Canonical journals are catching up",automation,treasury,vault};}catch{return unavailable("Canonical native custody checkpoints or source evidence are unavailable");}};
  const writer=(id:8453|4663)=>{if(fork||chain!==id||input.runtime.dataScope!==(id===8453?"base":"robinhood"))throw new Error("Only this chain's canonical runtime may write its custody journal");};
  const read=async()=>{try{return await(await session()).readVault();}catch{return emptyVaultLedgerReport(0n,"Canonical Robinhood Vault journal or native source evidence unavailable");}};
  return{read,custody,
    async automationPolicy(){
      // This is a reviewed configuration with canonical account/acceptance evidence, not live scheduler health.
      const privateCanary=chain===8453&&!!input.runtime.canaryOrigin&&/^verify-[a-z0-9-]+$/.test(input.runtime.dataScope);
      if(!privateCanary&&!baseActivationAcceptanceReady(manifest))return "unverified";
      try{const source=await peer(8453),rh=await peer(4663);
        const checked=await(deps.verifyCollector??verifyBaseCollector)(source.client,getAddress(manifest.collector.address!),{manifest,
          ...(privateCanary?{requireActivation:false,allowCanary:true,canaryOrigin:input.runtime.canaryOrigin}:{requireActivation:"runtime" as const}),robinhoodClient:rh.client,auditStore});
        return checked.paused?"paused":"configured";
      }catch{return "unverified";}
    },
    async sourceStatus(){const work=await session(),ar=await work.sourceReady(),tr=await work.treasuryReady();if(!ar.ready||!ar.fresh||!tr.ready||!tr.fresh)return{ready:false,assets:[],receivedWeth:"0",refundedWeth:"0"};
      return{ready:ar.assets.every(row=>row.ready)&&tr.assets.every(row=>row.ready)&&!ar.withheldEventIds.length&&!tr.withheldEventIds.length,assets:ar.assets.map(row=>({asset:row.asset,pending:row.basePending,verifiedClaimed:row.baseReceived})),receivedWeth:tr.assets.find(row=>sameAddress(row.asset,BASE_BUYBACK_RH_WETH))?.baseReceived??"0",refundedWeth:"0"};},
    async initialize(){writer(chain as 8453|4663);const work=await session(Date.now()+60_000,false);const guard=async()=>{
      const initial=BigInt(work.checked.initialDeploymentBlock),head=await work.source.client.getBlockNumber(),event=parseAbiItem("event FeesReleased(address indexed token,address indexed receiver,uint256 amount)");
      for(let from=initial;from<=head;from+=10n)if((await work.source.client.getLogs({address:work.checked.collector,event,fromBlock:from,toBlock:from+9n<head?from+9n:head,strict:true})).length)return false;
      return true;};
      if(chain===8453)await work.automation.establishCheckpoint(guard);
      else{await work.treasury.establishCheckpoint(guard);await work.vault.establishCheckpoint(guard);}return work.readVault();},
    async reconcile(maxDurationMs=45_000){writer(chain as 8453|4663);const deadline=Date.now()+maxDurationMs,work=await session(deadline,false);if(Date.now()>=deadline)return emptyVaultLedgerReport(0n,"Native maintenance budget reached; pending");
      if(chain===8453){await work.automation.reconcile(Math.max(0,deadline-Date.now()));if(Date.now()>=deadline)return emptyVaultLedgerReport(0n,"Native maintenance budget reached; pending");const events=await readAllCustodyEvents(work.source.store,"base_automation",deadline);
        for(const event of events)if(event.kind==="in"&&!event.evidence&&sameAddress(event.from,work.checked.collector)&&Date.now()<deadline){try{const evidence=await(deps.verifyRelease??verifyAdapterRelease)(work.source.client,event,work.checked.collector,work.checked.automationReceiver);await work.automation.classify(event.id,[{batchId:event.id,amount:event.amount}],evidence,deadline);}catch{/* Unknown transfers remain unknown. */}}if(Date.now()<deadline)await observeNativeRelayBatches({source:work.source.client,destination:work.rh.client,store:input.store as StoreBackend,
          collector:work.checked.collector,automation:work.checked.automationReceiver,sourceEvents:events,treasuryEvents:await readAllCustodyEvents(work.rh.store,"robinhood_treasury",deadline),batches:work.batches,deadline,auditStore});
        work.enableEvidence();return Date.now()>=deadline?emptyVaultLedgerReport(0n,"Native maintenance budget reached; pending"):work.readVault();}
      await work.treasury.reconcile(Math.max(0,deadline-Date.now()));if(Date.now()>=deadline)return emptyVaultLedgerReport(0n,"Native maintenance budget reached; pending");const events=await readAllCustodyEvents(work.rh.store,"robinhood_treasury",deadline);
      await captureNativeRelayDestinations({destination:work.rh.client,collector:work.checked.collector,treasuryEvents:events,batches:work.batches,deadline,auditStore},{provider:deps.verifyNativeDestinationProvider});
      work.enableEvidence();
      const ar=await work.automation.read(deadline);
      if(ar.ready)for(const batch of work.relayProofs){if(Date.now()>=deadline)break;try{const proof=await work.relay(batch),event=events.find(row=>row.id===vaultEventId(proof.destinationTransactionHash,proof.destinationTransferLogIndex));
        const consumption=ar.consumptions.find(row=>row.eventId===vaultEventId(proof.sourceTransactionHash,proof.sourceTransferLogIndex));
        if(event&&consumption){
          const fragments=nativeRelayFragments(consumption.fragments,proof,batch.id),evidence={kind:"native_relay" as const,relay:proof,sourceRevision:ar.revision,sourceEventId:consumption.eventId};
          const unchanged=event.evidence?.kind==="native_relay"&&stable(event.evidence.relay)===stable(proof)&&stable(event.fragments)===stable(fragments);
          const known=(rows:typeof fragments|undefined)=>rows?.reduce((sum,row)=>sum+(row.batchId?BigInt(row.amount):0n),0n)??0n;
          // Read-time source withholding projects this lot as unknown. It cannot
          // rewrite the retained verified classification merely because a peer
          // was temporarily unable to revalidate one of its funding releases.
          if(event.evidence?.kind==="native_relay"&&ar.withheldEventIds.length&&known(fragments)<known(event.fragments))continue;
          if(!unchanged)await work.treasury.classify(event.id,fragments,evidence,deadline);
        }
      }catch{/* Missing/unsupported/ambiguous provider evidence stays unknown. */}}
      work.refreshTreasury();
      await work.vault.reconcile(Math.max(0,deadline-Date.now()));let after:VaultEventCursor|undefined;
      for(;;){const page=await work.rh.store.vaultLedgerEventPage(500,after);for(const event of page)if(event.kind==="weth_in"&&["unknown","base"].includes(event.source)&&Date.now()<deadline){
          try{const proof=await work.nativeVaultProof(event);
          if(proof){const unchanged=event.source==="base"&&event.baseFill&&"protocol" in event.baseFill&&matchingNativeVaultProof(proof,event.baseFill);
            if(!unchanged)await work.vault.classifyBaseFill(event.id,proof,deadline);
          }else if(event.source==="base"&&sameAddress(event.from,BASE_BUYBACK_TREASURY)&&(await work.treasuryReady()).ready)await work.vault.invalidateBaseFill(event.id,deadline);
          }catch{/* One ambiguous/temporarily unavailable Forwarder receipt withholds that event, not the complete maintenance loop. */}
        }
        if(page.length<500||Date.now()>=deadline)break;const last=page.at(-1)!;after={blockNumber:last.blockNumber,transactionIndex:last.transactionIndex,logIndex:last.logIndex};}return Date.now()>=deadline?emptyVaultLedgerReport(0n,"Native maintenance budget reached; pending"):work.readVault();},
    async close(){closed=true;for(const store of extraStores)await store.close();extraStores.clear();}};
}
export async function readNativeCustodyReadiness(input:VaultLedgerRuntimeInput,deps:VaultLedgerRuntimeDependencies={}) {
  const runtime=createVaultLedgerRuntime(input,deps);try{return await runtime.custody();}finally{await runtime.close();}
}
