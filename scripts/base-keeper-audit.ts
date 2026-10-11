import { join } from "node:path";
import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import { robinhood } from "viem/chains";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector, type VerifiedBaseCollector } from "../server/base-collector";
import { BaseFeeQuoteReader, type BaseFeeDependencies } from "../server/base-buyback";
import { publishBaseAuditSnapshot, publishBaseAuditFailure, type BaseAuditSnapshotContents } from "../server/buyback-audit-snapshot";
import { createVaultLedgerRuntime, readCanonicalBaseSourceBatches, type VaultLedgerRuntime } from "../server/buyback-vault-runtime";
import { runtimeFromEnv, type Runtime } from "../server/config";
import type { LaunchpadService } from "../server/service";
import { SupabaseStore, type StoreBackend } from "../server/supabase-store";
import { Store } from "../server/store";
import type { BaseCollectorStatus } from "../src/lib/base-buyback";
import { canonicalProofJson } from "../server/base-native-provenance";

type Client = PublicClient<Transport, any>;
type SourceStatus = Awaited<ReturnType<VaultLedgerRuntime["sourceStatus"]>>;
export type BaseKeeperAuditInput = { runtime: Runtime; service: LaunchpadService; source: StoreBackend; sourceClient: Client;
  destinationClient?: Client; destinationStore?: StoreBackend; };
export type BaseKeeperAuditDependencies = { createLedger?: typeof createVaultLedgerRuntime;
  verifyCollector?: typeof verifyBaseCollector; publishSnapshot?: typeof publishBaseAuditSnapshot;
  now?: () => number; readCollectorStatus?: () => Promise<BaseCollectorStatus>; };
/** Peers are projections, never journal writers or owners of a shared handle. */
function readOnlyPeer(store: StoreBackend): StoreBackend {
  const prohibited = new Set(["commitCustodyLedger", "commitVaultLedger", "saveBuybackBatch", "compareAndSetBuybackAudit"]);
  return new Proxy(store, { get(target, key) {
    if (key === "close") return () => {};
    if (typeof key === "string" && prohibited.has(key)) return () => { throw new Error("Peer financial scope is read-only"); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}
export function createBaseKeeperAudit(input: BaseKeeperAuditInput, deps: BaseKeeperAuditDependencies = {}) {
  if (input.runtime.config.mode !== "base" || input.runtime.config.chainId !== 8453) throw new Error("Host audit requires an explicit Base runtime");
  const now = deps.now ?? Date.now, environment = input.runtime.environment ?? {};
  const baseRuntime = { ...input.runtime, dataScope: "base", dataDir: join(input.runtime.dataDir, "canonical-base") };
  const rhRuntime = runtimeFromEnv(4663, environment); rhRuntime.dataScope = "robinhood";
  const destinationStore = input.destinationStore ?? (rhRuntime.supabase
    ? new SupabaseStore(rhRuntime.supabase.url, rhRuntime.supabase.secretKey, "robinhood", "base")
    : new Store(rhRuntime.dataDir, 4663));
  const destinationClient = input.destinationClient ?? createPublicClient({ chain: robinhood,
    transport: http(rhRuntime.rpcUrl, { timeout: 30_000, retryCount: 0 }) });
  const create = deps.createLedger ?? createVaultLedgerRuntime;
  const peers = async (runtime: Runtime) => runtime.config.chainId === 8453 ? readOnlyPeer(input.source) : readOnlyPeer(destinationStore);
  const clients = (runtime: Runtime) => runtime.config.chainId === 8453 ? input.sourceClient : destinationClient;
  const dependencies = { openPeerStore: peers, createPeerClient: clients, auditStore: input.source };
  const baseLedger = create({ runtime: baseRuntime, client: input.sourceClient, store: input.source }, dependencies);
  const rhLedger = create({ runtime: rhRuntime, client: destinationClient, store: destinationStore }, dependencies);
  let closed = false, maintenance: Promise<void> | undefined;
  const check = async () => {
    if (closed) throw new Error("Host audit is closed");
    const [sourceChain, destinationChain] = await Promise.all([input.sourceClient.getChainId(), destinationClient.getChainId()]);
    if (sourceChain !== 8453 || destinationChain !== 4663) throw new Error("Host audit RPCs differ from their financial scopes");
  };
  const activationRequirement = () => BASE_COLLECTOR_MANIFEST.activation.status === "canary_verified" ? "runtime" as const : false;
  const graph = () => (deps.verifyCollector ?? verifyBaseCollector)(input.sourceClient, BASE_COLLECTOR_MANIFEST.collector.address!,
    { requireActivation: activationRequirement(), robinhoodClient: destinationClient, auditStore: input.source });
  const configuration = async () => {
    // Fee signing has its own local graph gate below. Never obtain controls or
    // readiness from a public HTTP snapshot or the Worker display cache.
    const control = await input.service.store.runtimeControl();
    return { ...input.runtime.config, writesEnabled: input.runtime.config.writesEnabled && !control.paused,
      signingPaused: control.paused, controlRevision: control.revision };
  };
  const custody = async () => { await check(); return baseLedger.custody(); };
  const vault = async () => { await check(); return rhLedger.read(); };
  const sourceStatus = async (): Promise<SourceStatus> => { await check(); return baseLedger.sourceStatus(); };
  let acceptedGraph: VerifiedBaseCollector | undefined, activationVerified = false;
  const collectorDependencies: BaseFeeDependencies = { client: input.sourceClient, collector: BASE_COLLECTOR_MANIFEST.collector.address!,
    verifyGraph: (client, address, options) => (deps.verifyCollector ?? verifyBaseCollector)(client, address,
      { ...options, requireActivation: false, robinhoodClient: destinationClient, auditStore: input.source }),
    batches: () => readCanonicalBaseSourceBatches(input.source), custodyReport: sourceStatus,
    automationPolicy: async () => acceptedGraph?.paused ? "paused" : acceptedGraph && activationVerified ? "configured" : "unverified" };
  const collector = new BaseFeeQuoteReader(collectorDependencies);
  const engine = async () => { await check(); return deps.readCollectorStatus ? deps.readCollectorStatus() : collector.status(); };
  async function reconcile(maxDurationMs = 60_000) {
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > 180_000) throw new Error("Invalid host audit time budget");
    if (maintenance) return maintenance;
    const operation = (async () => {
      await check(); const deadline = now() + maxDurationMs;
      // A missing checkpoint stays pending; ordinary maintenance never invents
      // an opening balance or initializes either chain's financial journal.
      for (const ledger of [rhLedger, baseLedger, rhLedger]) {
        const remaining = Math.max(0, deadline - now()); if (!remaining) break;
        await ledger.reconcile(remaining).catch(() => {});
      }
    })(); maintenance = operation;
    try { await operation; } finally { if (maintenance === operation) maintenance = undefined; }
  }
  async function publish(verified?: VerifiedBaseCollector, observedAt = now()) {
    await check(); acceptedGraph = verified;
    const headers = await Promise.all([input.sourceClient.getBlock({ blockTag: "latest" }), destinationClient.getBlock({ blockTag: "latest" })]);
    if (headers.some(block => block.number === null || !block.hash)) throw new Error("Host display audit has no canonical heads");
    const states = await Promise.all([input.source.custodyLedgerState("base_automation"), destinationStore.custodyLedgerState("robinhood_treasury"), destinationStore.vaultLedgerState()]);
    const sourceProjection = sourceStatus();
    // Sharing is local to this display projection. A concurrent signing gate
    // retains the original reader and always starts its own fresh custody read.
    const displayCollector = new BaseFeeQuoteReader({ ...collectorDependencies, custodyReport: () => sourceProjection });
    const displayStatus = async () => { await check(); return deps.readCollectorStatus ? deps.readCollectorStatus() : displayCollector.status(); };
    const [report, status, source] = await Promise.all([custody(), displayStatus(), sourceProjection]);
    // One custody projection owns its Vault view. A second moving-head read
    // would manufacture inconsistent lag/confirmation fields in the snapshot.
    const ledger = report.vault;
    const after = await Promise.all([input.source.custodyLedgerState("base_automation"), destinationStore.custodyLedgerState("robinhood_treasury"), destinationStore.vaultLedgerState()]);
    if (canonicalProofJson(states) !== canonicalProofJson(after)) throw new Error("Host projection journal revision changed; retry");
    for (let index = 0; index < headers.length; index++) {
      const client = index === 0 ? input.sourceClient : destinationClient;
      if ((await client.getBlock({ blockNumber: headers[index].number! })).hash !== headers[index].hash) throw new Error("Host projection reorganized; retry");
    }
    // Reports can advance beyond the first sampled heads while ordinary reads
    // run. Bind final heads as well; publication TTL is for display only.
    const finalHeaders = await Promise.all([input.sourceClient.getBlock({ blockTag: "latest" }), destinationClient.getBlock({ blockTag: "latest" })]);
    if (finalHeaders.some(block => block.number === null || !block.hash)) throw new Error("Host display audit has no final canonical heads");
    for (let index = 0; index < finalHeaders.length; index++) {
      const client = index === 0 ? input.sourceClient : destinationClient;
      if ((await client.getBlock({ blockNumber: finalHeaders[index].number! })).hash !== finalHeaders[index].hash) throw new Error("Host final projection reorganized; retry");
    }
    const contents: BaseAuditSnapshotContents = { observedAt, graph: verified ? { collector: verified.collector,
      automationReceiver: verified.automationReceiver, paused: verified.paused, activationVerified } : null,
      collectorStatus: status, custody: report, vaultLedger: ledger, sourceStatus: source,
      anchors: [{ chainId: 8453, number: String(finalHeaders[0].number!), hash: finalHeaders[0].hash! }, { chainId: 4663, number: String(finalHeaders[1].number!), hash: finalHeaders[1].hash! }],
      revisions: { automation: states[0]?.revision ?? 0, treasury: states[1]?.revision ?? 0, vault: states[2]?.revision ?? 0 } };
    const write = deps.publishSnapshot ?? publishBaseAuditSnapshot;
    await write(input.runtime, input.service.store, contents);
    // Shared destination display gets its own explicitly bound row. A private
    // canary can never publish an activated public financial projection.
    if (input.runtime.dataScope === "base") await write(rhRuntime, destinationStore, contents);
    return contents;
  }
  async function publishFailure(observedAt = now()) {
    acceptedGraph = undefined; activationVerified = false;
    const snapshot = await publishBaseAuditFailure(input.runtime, input.service.store, observedAt);
    if (input.runtime.dataScope === "base") await publishBaseAuditFailure(rhRuntime, destinationStore, observedAt);
    return snapshot;
  }
  async function maintainRound(options: { observedAt: number; maxDurationMs: number;
    verifyGraph?: () => Promise<VerifiedBaseCollector>; verifyAuthority?: (graph: VerifiedBaseCollector) => Promise<boolean> }) {
    let verified: VerifiedBaseCollector | undefined, gateVerified = false, error: unknown, snapshot: BaseAuditSnapshotContents | undefined;
    try { verified = await (options.verifyGraph ?? (() => (deps.verifyCollector ?? verifyBaseCollector)(input.sourceClient, BASE_COLLECTOR_MANIFEST.collector.address!,
      { requireActivation: false, robinhoodClient: destinationClient, auditStore: input.source })))(); } catch (failure) { error = failure; }
    if (verified && options.verifyAuthority) {
      try { gateVerified = await options.verifyAuthority(verified) === true; } catch (failure) { error ??= failure; }
    }
    acceptedGraph = verified; activationVerified = gateVerified;
    let maintenanceFailed = false;
    try { await reconcile(options.maxDurationMs); } catch (failure) { error ??= failure; maintenanceFailed = true; gateVerified = false; }
    try { snapshot = maintenanceFailed ? await publishFailure(options.observedAt) ?? undefined : await publish(verified, options.observedAt); }
    catch (failure) { error ??= failure; gateVerified = false; snapshot = await publishFailure(options.observedAt).catch(failure => { error ??= failure; }) ?? undefined; }
    return { graph: verified, activationVerified: gateVerified, snapshot, error };
  }
  return { reconcile, custody, vault, engine, configuration, graph, publish,
    maintainRound, publishFailure,
    setVerifiedGraph(verified: VerifiedBaseCollector | undefined, gateVerified: boolean) { acceptedGraph = verified; activationVerified = !!verified && gateVerified; },
    async close() { closed = true; if (maintenance) await maintenance.catch(() => {});
      await baseLedger.close(); await rhLedger.close(); if (!input.destinationStore) await destinationStore.close(); },
  };
}
