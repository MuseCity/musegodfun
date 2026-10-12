import { join } from "node:path";
import { createPublicClient, http, type Address, type PublicClient, type Transport } from "viem";
import { robinhood } from "viem/chains";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector, type VerifiedBaseCollector } from "../server/base-collector";
import { baseActivationAcceptanceReady } from "../server/base-activation-record";
import { BaseFeeQuoteReader, type BaseFeeDependencies } from "../server/base-buyback";
import { publishBaseAuditSnapshot, publishBaseAuditFailure, type BaseAuditSnapshotContents } from "../server/buyback-audit-snapshot";
import { createVaultLedgerRuntime, readCanonicalBaseSourceBatches, nativeSourceStatusFromCustody, type VaultLedgerRuntime, type VaultLedgerRuntimeDependencies } from "../server/buyback-vault-runtime";
import { runtimeFromEnv, type Runtime } from "../server/config";
import type { LaunchpadService } from "../server/service";
import { SupabaseStore, type StoreBackend } from "../server/supabase-store";
import { Store } from "../server/store";
import type { BaseCollectorStatus } from "../src/lib/base-buyback";
import { canonicalProofJson } from "../server/base-native-provenance";
import { verifyFeeEngineRuntime } from "../server/buyback-engine";
import robinhoodDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { BASE_BUYBACK_VAULT } from "../src/lib/base-buyback";
import { sameAddress } from "../src/lib/config";

type Client = PublicClient<Transport, any>;
type SourceStatus = Awaited<ReturnType<VaultLedgerRuntime["sourceStatus"]>>;
type MaintenanceRound = { graph: VerifiedBaseCollector | undefined; activationVerified: boolean;
  snapshot: BaseAuditSnapshotContents | undefined; error: unknown };
export type BaseKeeperAuditInput = { runtime: Runtime; service: LaunchpadService; source: StoreBackend; sourceClient: Client;
  destinationClient?: Client; destinationStore?: StoreBackend; };
export type BaseKeeperAuditDependencies = { createLedger?: typeof createVaultLedgerRuntime;
  verifyCollector?: typeof verifyBaseCollector; publishSnapshot?: typeof publishBaseAuditSnapshot;
  verifyRobinhoodGraph?: VaultLedgerRuntimeDependencies["verifyRobinhoodGraph"];
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
  // Host readiness reads include both live graphs and canonical journals. Keep
  // their finite budget separate from the ordinary twelve-second API reads.
  const dependencies = { openPeerStore: peers, createPeerClient: clients, auditStore: input.source, readDurationMs: 30_000,
    verifyCollector: deps.verifyCollector, verifyRobinhoodGraph: deps.verifyRobinhoodGraph };
  const baseLedger = create({ runtime: baseRuntime, client: input.sourceClient, store: input.source }, dependencies);
  const rhLedger = create({ runtime: rhRuntime, client: destinationClient, store: destinationStore }, dependencies);
  let closed = false, maintenance: Promise<void> | undefined, activeRound: Promise<MaintenanceRound> | undefined;
  const check = async () => {
    if (closed) throw new Error("Host audit is closed");
    const [sourceChain, destinationChain] = await Promise.all([input.sourceClient.getChainId(), destinationClient.getChainId()]);
    if (sourceChain !== 8453 || destinationChain !== 4663) throw new Error("Host audit RPCs differ from their financial scopes");
  };
  const activationRequirement = () => baseActivationAcceptanceReady(BASE_COLLECTOR_MANIFEST) ? "runtime" as const : false;
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
  // A maintenance cycle owns separate readers. Never let its memo enter the
  // fresh custody/engine/graph methods used by signing, even concurrently.
  function cycle(initial?: VerifiedBaseCollector) {
    const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
    let checked = initial, staticGraph = initial ? Promise.resolve(initial) : undefined;
    const verifyStatic: typeof verifyBaseCollector = async (client, address, options) => {
      if (client !== input.sourceClient || !sameAddress(address, manifest.collector.address!) || options?.requireActivation !== false ||
        options.recordActivation || options.allowCanary || options.canaryOrigin)
        throw new Error("Maintenance memo is limited to its exact static Base graph");
      return staticGraph ??= (deps.verifyCollector ?? verifyBaseCollector)(client, address,
        { ...options, manifest, robinhoodClient: destinationClient, auditStore: input.source }).then(value => { checked = value; return value; });
    };
    let destinationGraph: Promise<{ vault: Address; weth: Address; swapper: Address; engineForwarders: Address[] }> | undefined =
      initial?.currentSettlementGraph ? Promise.resolve(initial.currentSettlementGraph) : undefined;
    const verifyDestination = () => destinationGraph ??= (async () => {
      if (deps.verifyRobinhoodGraph) {
        const result = await deps.verifyRobinhoodGraph(destinationClient);
        if (!sameAddress(result.vault, BASE_BUYBACK_VAULT)) throw new Error("RH Vault differs from fixed Treasury destination");
        return { ...result, engineForwarders: result.engineForwarders ?? [] };
      }
      const verified = await verifyFeeEngineRuntime(destinationClient as unknown as Parameters<typeof verifyFeeEngineRuntime>[0], robinhoodDeployment.contracts.engine.address! as `0x${string}`);
      if (!sameAddress(verified.vault, BASE_BUYBACK_VAULT)) throw new Error("RH Vault differs from fixed Treasury destination");
      return { vault: verified.vault, weth: robinhoodDeployment.constants.weth as `0x${string}`,
        swapper: verified.swapper, engineForwarders: [verified.engine, verified.forwarder] };
    })();
    const scopedDependencies = { ...dependencies, manifest, verifyCollector: verifyStatic,
      verifyRobinhoodGraph: verifyDestination, fairMaintenance: true };
    const base = create({ runtime: baseRuntime, client: input.sourceClient, store: input.source }, scopedDependencies);
    const rh = create({ runtime: rhRuntime, client: destinationClient, store: destinationStore }, scopedDependencies);
    return { base, rh, verifyStatic, getChecked: () => checked,
      async close() { await base.close(); await rh.close(); } };
  }
  type Cycle = ReturnType<typeof cycle>;
  function maintenanceBudget(maxDurationMs: number) {
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > 180_000) throw new Error("Invalid host audit time budget");
  }
  async function reconcileCycle(readers: Cycle, maxDurationMs: number) {
    maintenanceBudget(maxDurationMs);
    if (maintenance) return maintenance;
    const operation = (async () => {
      await check();
      // These are finite logical quotas, not a hard wall-clock timeout. An RPC
      // may overrun its soft deadline; wait for its real completion and still
      // give later journals their reserved share, without background writers.
      const stages = [readers.rh, readers.base, readers.rh];
      for (let index = 0; index < stages.length; index++) {
        const budget = Math.floor(maxDurationMs / 3) + (index < maxDurationMs % 3 ? 1 : 0);
        if (budget) await stages[index].reconcile(budget).catch(() => {});
      }
    })(); maintenance = operation;
    try { await operation; } finally { if (maintenance === operation) maintenance = undefined; }
  }
  async function reconcile(maxDurationMs = 60_000) {
    maintenanceBudget(maxDurationMs);
    if (activeRound) { await activeRound; return; }
    if (maintenance) return maintenance;
    const readers = cycle();
    try { await reconcileCycle(readers, maxDurationMs); } finally { await readers.close(); }
  }
  async function publishCycle(readers: Cycle, verified?: VerifiedBaseCollector, observedAt = now()) {
    await check(); acceptedGraph = verified;
    const headers = await Promise.all([input.sourceClient.getBlock({ blockTag: "latest" }), destinationClient.getBlock({ blockTag: "latest" })]);
    if (headers.some(block => block.number === null || !block.hash)) throw new Error("Host display audit has no canonical heads");
    const states = await Promise.all([input.source.custodyLedgerState("base_automation"), destinationStore.custodyLedgerState("robinhood_treasury"), destinationStore.vaultLedgerState()]);
    const custodyProjection = readers.base.custody();
    const sourceProjection = custodyProjection.then(report => nativeSourceStatusFromCustody(report.automation, report.treasury));
    // Sharing is local to this display projection. A concurrent signing gate
    // retains the original reader and always starts its own fresh custody read.
    const displayCollector = new BaseFeeQuoteReader({ ...collectorDependencies, verifyGraph: readers.verifyStatic, custodyReport: () => sourceProjection });
    const displayStatus = async () => { await check(); return deps.readCollectorStatus ? deps.readCollectorStatus() : displayCollector.status(); };
    const [report, status, source] = await Promise.all([custodyProjection, displayStatus(), sourceProjection]);
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
  async function publish(verified?: VerifiedBaseCollector, observedAt = now()) {
    const readers = cycle(verified);
    try { return await publishCycle(readers, verified, observedAt); } finally { await readers.close(); }
  }
  async function publishFailure(observedAt = now()) {
    acceptedGraph = undefined; activationVerified = false;
    const snapshot = await publishBaseAuditFailure(input.runtime, input.service.store, observedAt);
    if (input.runtime.dataScope === "base") await publishBaseAuditFailure(rhRuntime, destinationStore, observedAt);
    return snapshot;
  }
  async function runRound(options: { observedAt: number; maxDurationMs: number;
    verifyGraph?: () => Promise<VerifiedBaseCollector>; verifyAuthority?: (graph: VerifiedBaseCollector) => Promise<boolean> }) {
    let verified: VerifiedBaseCollector | undefined, gateVerified = false, error: unknown, snapshot: BaseAuditSnapshotContents | undefined;
    try { verified = await (options.verifyGraph ?? (() => (deps.verifyCollector ?? verifyBaseCollector)(input.sourceClient, BASE_COLLECTOR_MANIFEST.collector.address!,
      { requireActivation: false, robinhoodClient: destinationClient, auditStore: input.source })))(); } catch (failure) { error = failure; }
    if (verified && options.verifyAuthority) {
      try { gateVerified = await options.verifyAuthority(verified) === true; } catch (failure) { error ??= failure; }
    }
    acceptedGraph = verified; activationVerified = gateVerified;
    const readers = cycle(verified);
    let maintenanceFailed = false;
    try {
      try { await reconcileCycle(readers, options.maxDurationMs); } catch (failure) { error ??= failure; maintenanceFailed = true; gateVerified = false; }
      // Revoked signing authority never prevents static receipt recovery. The
      // cycle can obtain a current static graph without replaying acceptance.
      verified ??= readers.getChecked();
      if (!verified) {
        try { verified = await readers.verifyStatic(input.sourceClient, BASE_COLLECTOR_MANIFEST.collector.address!, { requireActivation: false }); }
        catch (failure) { error ??= failure; }
      }
      try { snapshot = maintenanceFailed ? await publishFailure(options.observedAt) ?? undefined : await publishCycle(readers, verified, options.observedAt); }
      catch (failure) { error ??= failure; gateVerified = false; snapshot = await publishFailure(options.observedAt).catch(failure => { error ??= failure; }) ?? undefined; }
    } finally { await readers.close(); }
    return { graph: verified, activationVerified: gateVerified, snapshot, error };
  }
  async function maintainRound(options: Parameters<typeof runRound>[0]) {
    maintenanceBudget(options.maxDurationMs);
    if (activeRound) return activeRound;
    const operation = runRound(options); activeRound = operation;
    try { return await operation; } finally { if (activeRound === operation) activeRound = undefined; }
  }
  return { reconcile, custody, vault, engine, configuration, graph, publish,
    maintainRound, publishFailure,
    setVerifiedGraph(verified: VerifiedBaseCollector | undefined, gateVerified: boolean) { acceptedGraph = verified; activationVerified = !!verified && gateVerified; },
    async close() { closed = true; if (activeRound) await activeRound.catch(() => {}); if (maintenance) await maintenance.catch(() => {});
      await baseLedger.close(); await rhLedger.close(); if (!input.destinationStore) await destinationStore.close(); },
  };
}
