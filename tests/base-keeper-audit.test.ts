import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { types } from "node:util";
import type { Address, Hex, PublicClient, Transport } from "viem";
import { createBaseKeeperAudit, type BaseKeeperAuditDependencies } from "../scripts/base-keeper-audit";
import { BASE_COLLECTOR_MANIFEST, type VerifiedBaseCollector } from "../server/base-collector";
import { BASE_BUYBACK_VAULT, BASE_BUYBACK_RH_WETH } from "../src/lib/base-buyback";
import { BaseFeeQuoteReader } from "../server/base-buyback";
import { runtimeFromEnv } from "../server/config";
import { publishBaseAuditSnapshot, readBaseAuditSnapshot, unavailableBaseCollectorStatus } from "../server/buyback-audit-snapshot";
import type { LaunchpadService } from "../server/service";
import type { StoreBackend } from "../server/supabase-store";
import type { BuybackBatchRecord } from "../server/store";
import type { NativeCustodyReadiness, VaultLedgerRuntime } from "../server/buyback-vault-runtime";
import { emptyCustodyReport } from "../src/lib/buyback-custody-ledger";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";

const collector = "0x1111111111111111111111111111111111111111" as Address;
const automation = "0x2222222222222222222222222222222222222222" as Address;
const blockHash = (chain: number) => `0x${chain.toString(16).padStart(64, "0")}` as Hex;
type Client = PublicClient<Transport, any>;
const clone = <T>(value: T): T => structuredClone(value);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, options: { scope?: string; defaultDestination?: boolean; exerciseGraphs?: boolean; dependencies?: BaseKeeperAuditDependencies } = {}) {
  let now = 10_000, sourceChain = 8453, destinationChain = 4663, httpReads = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => { httpReads++; throw new Error("Public HTTP must not authorize host fee work"); });
  const originalAddress = BASE_COLLECTOR_MANIFEST.collector.address;
  // Only an offline address fixture: no deployment, activation or financial
  // acceptance is created. Ready financial evidence is never synthesized here.
  BASE_COLLECTOR_MANIFEST.collector.address = collector;
  t.after(() => { BASE_COLLECTOR_MANIFEST.collector.address = originalAddress; });
  const runtime = runtimeFromEnv(8453, { CHAIN_MODE: "base", NODE_ENV: "test", DATA_DIR: "/tmp/offline-host-audit-fixture",
    BASE_FEE_COLLECTOR_ADDRESS: collector, BASE_PLATFORM_TREASURY: BASE_COLLECTOR_MANIFEST.constants.operationsTreasury!,
    ENABLE_BASE_TRANSACTIONS: "true", BASE_RPC_URL: "https://base.invalid", ROBINHOOD_RPC_URL: "https://rh.invalid" });
  runtime.dataScope = options.scope ?? "base";
  const calls: string[] = [], creates: { input: any; dependencies: any }[] = [];
  const source = { ready: false, assets: [], receivedWeth: "0", refundedWeth: "0" };
  let status = unavailableBaseCollectorStatus(), control = { paused: false, revision: 7, updatedAt: now, reason: "offline" };
  let sourceState: any = null, treasuryState: any = null, vaultState: any = null;
  let onCustody: ((maintenance: boolean) => void | NativeCustodyReadiness | Promise<void | NativeCustodyReadiness>) | undefined,
    onSource: ((maintenance: boolean) => Promise<typeof source>) | undefined,
    onReconcile: ((chain: number, budget: number) => Promise<void>) | undefined;
  function store(scope: string) {
    const rows = new Map<string, BuybackBatchRecord>();
    const counts = { closes: 0, financialWrites: 0, auditWrites: 0, snapshotReads: 0 };
    const value = { scope, close() { counts.closes++; }, runtimeControl: async () => clone(control),
      custodyLedgerState: async (id: string) => clone(id === "base_automation" ? sourceState : treasuryState), vaultLedgerState: async () => clone(vaultState),
      custodyLedgerEventPage: async () => [], custodyLedgerBlockPage: async () => [], vaultLedgerEventPage: async () => [], vaultLedgerBlockPage: async () => [],
      buybackBatchPage: async () => [],
      getBuybackBatch: async (id: string) => { counts.snapshotReads++; return clone(rows.get(id) ?? null); },
      compareAndSetBuybackAudit: async (next: BuybackBatchRecord, expected: BuybackBatchRecord | null) => {
        assert.match(next.id, /^internal_native_/); assert.match(String(next.protocol), /^internal_native_/);
        if (JSON.stringify(rows.get(next.id) ?? null) !== JSON.stringify(expected)) return false;
        rows.set(next.id, clone(next)); counts.auditWrites++; return true;
      },
      commitCustodyLedger: async () => { counts.financialWrites++; throw new Error("Unexpected fixture financial write"); },
      commitVaultLedger: async () => { counts.financialWrites++; throw new Error("Unexpected fixture financial write"); },
      saveBuybackBatch: async () => { counts.financialWrites++; throw new Error("Unexpected fixture financial write"); },
    } as unknown as StoreBackend;
    return { value, rows, counts };
  }
  const baseStore = store("base"), rhStore = store("robinhood"), displayStore = runtime.dataScope === "base" ? baseStore : store(runtime.dataScope);
  const baseClient = { getChainId: async () => sourceChain, getBlock: async () => ({ number: 100n, hash: blockHash(8453) }) } as unknown as Client;
  const rhClient = { getChainId: async () => destinationChain, getBlock: async () => ({ number: 200n, hash: blockHash(4663) }) } as unknown as Client;
  const custodyReport = (): NativeCustodyReadiness => ({ ready: false, reason: "Explicit checkpoints remain pending",
    automation: { ...emptyCustodyReport("base_automation", 100n), revision: sourceState?.revision ?? 0 },
    treasury: { ...emptyCustodyReport("robinhood_treasury", 200n), revision: treasuryState?.revision ?? 0 }, vault: emptyVaultLedgerReport(200n) });
  const ledgers = new Map<number, VaultLedgerRuntime>();
  const createLedger = ((input: any, dependencies: any) => {
    creates.push({ input, dependencies }); const chain = input.runtime.config.chainId;
    const inspectGraphs = async () => {
      if (!options.exerciseGraphs) return;
      await dependencies.verifyCollector(baseClient, collector, { requireActivation: false, robinhoodClient: rhClient, auditStore: baseStore.value });
      await dependencies.verifyRobinhoodGraph(rhClient);
    };
    const ledger: VaultLedgerRuntime = {
      async initialize() { calls.push(`initialize:${chain}`); throw new Error("An ordinary host round must not initialize checkpoints"); },
      async reconcile(budget) { calls.push(`reconcile:${chain}:${budget}`); await inspectGraphs(); await onReconcile?.(chain, budget!); return emptyVaultLedgerReport(200n); },
      async custody() { calls.push(`custody:${chain}`); await inspectGraphs(); return await onCustody?.(dependencies.fairMaintenance === true) ?? custodyReport(); },
      async read() { calls.push(`vault:${chain}`); await inspectGraphs(); return emptyVaultLedgerReport(200n); },
      async sourceStatus() { calls.push(`source:${chain}`); await inspectGraphs(); return onSource ? onSource(dependencies.fairMaintenance === true) : clone(source); },
      async automationPolicy() { calls.push(`policy:${chain}`); return "unverified"; },
      async close() { calls.push(`close:${chain}`); for (const id of [8453, 4663]) {
        const peer = await dependencies.openPeerStore({ config: { chainId: id } }); await peer.close();
      } },
    };
    if (!ledgers.has(chain)) ledgers.set(chain, ledger); return ledger;
  }) as BaseKeeperAuditDependencies["createLedger"];
  const verified: VerifiedBaseCollector = { collector, automationReceiver: BASE_COLLECTOR_MANIFEST.constants.automationReceiver!, paused: false, runtimeHash: blockHash(1),
    manifestFingerprint: blockHash(2), initialDeploymentBlock: 1n };
  const service = { store: displayStore.value, config: async () => { throw new Error("Public-style config cannot replace local control reads"); } } as unknown as LaunchpadService;
  const audit = createBaseKeeperAudit({ runtime, service, source: baseStore.value, sourceClient: baseClient,
    destinationClient: options.defaultDestination ? undefined : rhClient, destinationStore: rhStore.value },
    { createLedger, now: () => now, readCollectorStatus: async () => { calls.push("engine:8453"); return clone(status); },
      verifyCollector: (async (client: Client, address: Address, options: any) => {
        assert.equal(client, baseClient); assert.equal(address, collector); assert.equal(options.robinhoodClient, rhClient); assert.equal(options.auditStore, baseStore.value);
        assert.equal(options.requireActivation, false);
        calls.push("graph:8453"); return clone(verified);
      }) as any, verifyRobinhoodGraph: async client => {
        assert.equal(client, rhClient); calls.push("graph:4663");
        return { vault: BASE_BUYBACK_VAULT, weth: BASE_COLLECTOR_MANIFEST.constants.destinationWeth, swapper: collector, engineForwarders: [automation] };
      }, ...options.dependencies });
  t.after(() => audit.close());
  return { audit, runtime, service, baseStore, rhStore, displayStore, baseClient, rhClient, creates, calls, ledgers, verified,
    advance(ms: number) { now += ms; }, now: () => now, httpReads: () => httpReads,
    setChains(base: number, rh: number) { sourceChain = base; destinationChain = rh; },
    setControl(value: Partial<typeof control>) { control = { ...control, ...value }; },
    setStatus(value: typeof status) { status = value; },
    setSourceState(value: any) { sourceState = value; },
    setTreasuryState(value: any) { treasuryState = value; },
    onCustody(work: NonNullable<typeof onCustody>) { onCustody = work; },
    onSource(work: NonNullable<typeof onSource>) { onSource = work; },
    onReconcile(work: (chain: number, budget: number) => Promise<void>) { onReconcile = work; },
  };
}

/** Offline source projection with the Vault deliberately pending. It is not a
 * financial-ready checkpoint or an authorization to sign any transaction. */
function sourceProjectionFixture(received: string): NativeCustodyReadiness {
  const asset = { asset: collector, ready: true, reason: null, received: "20", pending: "19", baseReceived: "20", basePending: "19" };
  return { ready: false, reason: "Vault still pending", vault: emptyVaultLedgerReport(200n),
    automation: { ...emptyCustodyReport("base_automation", 100n), ready: true, fresh: true, revision: 1, checkpointBlock: "1", indexedThrough: "100", lagBlocks: "0", assets: [asset] },
    treasury: { ...emptyCustodyReport("robinhood_treasury", 200n), ready: true, fresh: true, revision: 1, checkpointBlock: "1", indexedThrough: "200", lagBlocks: "0",
      assets: [{ ...asset, asset: BASE_BUYBACK_RH_WETH, received, pending: received, baseReceived: received, basePending: received }] } };
}

test("host explicitly binds each chain's runtime, primary store, peers and RPC without shared-handle ownership", async t => {
  const f = fixture(t); assert.equal(f.creates.length, 2);
  for (const [index, chain, scope, store, client] of [[0, 8453, "base", f.baseStore.value, f.baseClient], [1, 4663, "robinhood", f.rhStore.value, f.rhClient]] as const) {
    const created = f.creates[index]; assert.equal(created.input.runtime.config.chainId, chain); assert.equal(created.input.runtime.dataScope, scope);
    assert.equal(created.input.store, store); assert.equal(created.input.client, client); assert.equal(created.dependencies.auditStore, f.baseStore.value);
    assert.equal(created.dependencies.readDurationMs, 30_000, "Only the private host grants its two canonical ledgers the longer read budget");
    assert.equal(created.dependencies.createPeerClient({ config: { chainId: chain } }), client);
    const peer = await created.dependencies.openPeerStore(created.input.runtime);
    for (const method of ["commitCustodyLedger", "commitVaultLedger", "saveBuybackBatch", "compareAndSetBuybackAudit"])
      assert.throws(() => peer[method]({}), /read-only/);
    await peer.close(); assert.equal(f.baseStore.counts.closes + f.rhStore.counts.closes, 0);
  }
  await f.audit.close(); assert.deepEqual(f.calls, ["close:8453", "close:4663"]);
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
  assert.equal(f.baseStore.counts.closes + f.rhStore.counts.closes, 0);
});

test("the default host destination is an ordinary Robinhood RPC client without a local replay proxy", async t => {
  const f = fixture(t, { defaultDestination: true }), destination = f.creates[1].input.client;
  assert.equal(destination.chain.id, 4663);
  assert.equal(destination.transport.url, "https://rh.invalid");
  assert.equal(types.isProxy(destination), false);
  assert.equal(f.creates[0].dependencies.createPeerClient({ config: { chainId: 4663 } }), destination);
  assert.equal(f.creates[0].input.client, f.baseClient, "The supplied Base source client is retained");
  assert.equal(f.httpReads(), 0);
});

test("canonical journal scopes stay separate from a private canary's launch/control namespace", async t => {
  const f = fixture(t, { scope: "verify-base-canary" });
  assert.equal(f.creates[0].input.runtime.dataScope, "base"); assert.equal(f.creates[1].input.runtime.dataScope, "robinhood");
  assert.notEqual(f.service.store, f.baseStore.value); assert.equal(f.runtime.dataScope, "verify-base-canary");
  await f.audit.publish(); assert.equal(f.displayStore.counts.auditWrites, 1); assert.equal(f.baseStore.counts.auditWrites, 0); assert.equal(f.rhStore.counts.auditWrites, 0);
});

test("the ordered round catches RH incoming funds, then Base source evidence, then RH FIFO without initializing checkpoints", async t => {
  const f = fixture(t); f.onReconcile(async () => { f.advance(20); }); await f.audit.reconcile(100);
  assert.deepEqual(f.calls.filter(call => call.startsWith("reconcile:")), ["reconcile:4663:34", "reconcile:8453:33", "reconcile:4663:33"]);
  assert(!f.calls.some(call => call.startsWith("initialize"))); assert.equal((await f.audit.custody()).ready, false);
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
});

test("sixty-second host maintenance reserves finite RH/Base/RH shares even when earlier RPCs overrun", async t => {
  const f = fixture(t); f.onReconcile(async () => { f.advance(18_000); });
  await f.audit.reconcile(60_000);
  assert.deepEqual(f.calls.filter(call => call.startsWith("reconcile:")), ["reconcile:4663:20000", "reconcile:8453:20000", "reconcile:4663:20000"]);
  f.calls.length = 0; f.onReconcile(async () => { f.advance(70_000); });
  await f.audit.reconcile(60_000);
  assert.deepEqual(f.calls.filter(call => call.startsWith("reconcile:")), ["reconcile:4663:20000", "reconcile:8453:20000", "reconcile:4663:20000"], "Soft-deadline overruns cannot consume another journal's reserved opportunity");
  assert(!f.calls.some(call => call.startsWith("initialize:")));
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
});

test("one unavailable phase does not block the remaining chain phases or invent checkpoint readiness", async t => {
  const f = fixture(t); let count = 0; f.onReconcile(async chain => { if (++count === 1 || chain === 8453) throw new Error("Transient archive unavailable"); });
  await f.audit.reconcile(100); assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, 3);
  assert.equal((await f.audit.vault()).initialized, false); assert(!f.calls.some(call => call.startsWith("initialize:")));
});

test("a late still-running audit retains singleflight after its deadline; restart of work waits for the original completion", async t => {
  const f = fixture(t), entered = deferred(), release = deferred(); let first = true;
  f.onReconcile(async () => { if (first) { first = false; entered.resolve(); await release.promise; } });
  const initial = f.audit.reconcile(100); await entered.promise; f.advance(101);
  const concurrent = f.audit.reconcile(100); await Promise.resolve(); assert.equal(f.calls.length, 1);
  release.resolve(); await Promise.all([initial, concurrent]); assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, 3);
  await f.audit.reconcile(100); assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, 6);
});

test("zero starts no ledger and maximum/remainder budgets never overallocate the total logical quota", async t => {
  const f = fixture(t); await f.audit.reconcile(0); assert(!f.calls.some(call => call.startsWith("reconcile:")));
  for (const value of [-1, Infinity, NaN, 1.1, 180_001]) await assert.rejects(f.audit.reconcile(value), /time budget/);
  for (const budget of [1, 2, 100, 60_000, 180_000]) {
    f.calls.length = 0; f.onReconcile(async () => { f.advance(100_000); }); await f.audit.reconcile(budget);
    const allocated = f.calls.filter(call => call.startsWith("reconcile:")).map(call => Number(call.split(":")[2]));
    assert.equal(allocated.reduce((sum, value) => sum + value, 0), budget); assert(allocated.every(value => value > 0 && value <= 60_000));
  }
});

test("wrong RPC chains cannot read, reconcile or publish a healthy projection", async t => {
  const f = fixture(t);
  for (const chains of [[4663, 4663], [8453, 8453]]) {
    f.setChains(...chains as [number, number]);
    for (const action of [() => f.audit.custody(), () => f.audit.vault(), () => f.audit.engine(), () => f.audit.reconcile(), () => f.audit.publish()])
      await assert.rejects(action(), /financial scopes/);
  }
  assert(!f.calls.some(call => !call.startsWith("close:"))); assert.equal(f.displayStore.counts.auditWrites, 0);
});

test("fresh local control/config and authority reads have no Worker HTTP dependency", async t => {
  const f = fixture(t); assert.deepEqual(await f.audit.graph(), f.verified);
  f.setControl({ paused: true, revision: 42 }); const stopped = await f.audit.configuration();
  assert.equal(stopped.chainId, 8453); assert.equal(stopped.treasury, f.runtime.config.treasury); assert.equal(stopped.feeEngine, collector);
  assert.equal(stopped.writesEnabled, false); assert.equal(stopped.signingPaused, true); assert.equal(stopped.controlRevision, 42);
  f.setControl({ paused: false, revision: 43 }); assert.equal((await f.audit.configuration()).writesEnabled, true);
  f.runtime.config.writesEnabled = false; assert.equal((await f.audit.configuration()).writesEnabled, false); assert.equal(f.httpReads(), 0);
});

test("persisted display booleans never replace fresh custody, Vault or Collector spending evidence", async t => {
  const f = fixture(t); f.displayStore.rows.set("internal_native_host_snapshot:forged-display", { id: "internal_native_host_snapshot:forged-display", protocol: "internal_native_host_snapshot_v1", ready: true, attributionReady: true });
  assert.equal((await f.audit.custody()).ready, false); assert.equal((await f.audit.vault()).attributionReady, false);
  const current = { ...unavailableBaseCollectorStatus(), error: "Fresh canonical evidence is unavailable" }; f.setStatus(current);
  assert.deepEqual(await f.audit.engine(), current); assert.equal(f.displayStore.counts.snapshotReads, 0);
  assert.deepEqual(f.calls, ["custody:8453", "vault:4663", "engine:8453"]); assert.equal(f.httpReads(), 0);
});

test("the default Collector reader retains the host's persistent graph audit and peer RPC while activation remains independently gated", async t => {
  const f = fixture(t, { dependencies: { readCollectorStatus: undefined } });
  t.mock.method(BaseFeeQuoteReader.prototype, "status", async function(this: BaseFeeQuoteReader) {
    const graph = await this.graph();
    return { ...unavailableBaseCollectorStatus(), collector: graph.collector, automation: graph.automationReceiver,
      nativeAutomationState: await this.deps.automationPolicy!() };
  });
  assert.equal((await f.audit.engine()).nativeAutomationState, "unverified");
  f.audit.setVerifiedGraph({ ...f.verified, paused: true }, false); assert.equal((await f.audit.engine()).nativeAutomationState, "paused");
  f.audit.setVerifiedGraph(f.verified, false); assert.equal((await f.audit.engine()).nativeAutomationState, "unverified");
  f.audit.setVerifiedGraph(f.verified, true); assert.equal((await f.audit.engine()).nativeAutomationState, "configured");
  assert.deepEqual(f.calls, ["graph:8453", "graph:8453", "graph:8453", "graph:8453"]); assert.equal(f.httpReads(), 0);
});

test("live spending authority requires acceptance while display and index graph verification stay independent", async t => {
  const originalActivation = clone(BASE_COLLECTOR_MANIFEST.activation), originalCanary = BASE_COLLECTOR_MANIFEST.canaryAuthorization;
  // Structural offline acceptance; the live verification boundary remains
  // independently rejected until its private record is available.
  BASE_COLLECTOR_MANIFEST.activation = { status: "canary_verified", nativeExecution: {},
    nativeRunAcceptance: {} as any, walletAcceptance: {} as any, pauseRollbackAcceptance: {} as any };
  BASE_COLLECTOR_MANIFEST.canaryAuthorization = {} as any;
  t.after(() => { BASE_COLLECTOR_MANIFEST.activation = originalActivation; BASE_COLLECTOR_MANIFEST.canaryAuthorization = originalCanary; });
  let retained = false; const checks: unknown[] = [];
  const f = fixture(t, { dependencies: { readCollectorStatus: undefined, publishSnapshot: async(_runtime,_store,contents)=>contents as any, verifyCollector: (async (client: Client, address: Address, options: any) => {
    assert.equal(client, f.baseClient); assert.equal(address, collector); assert.equal(options.robinhoodClient, f.rhClient); assert.equal(options.auditStore, f.baseStore.value);
    checks.push(options.requireActivation);
    if (options.requireActivation === "runtime" && !retained) throw new Error("Finalized activation record missing; no historical fallback");
    return clone(f.verified);
  }) as any } });
  await assert.rejects(f.audit.graph(), /activation record missing/);
  assert.equal((await f.audit.engine()).available, true);
  f.audit.setVerifiedGraph(f.verified,false);
  const publication = await f.audit.publish(f.verified); assert.equal(publication.graph?.activationVerified, false);
  assert.deepEqual(checks, ["runtime", false], "A display seeded with the same round's checked graph does not repeat its static check");
  retained = true;
  assert.deepEqual(await f.audit.graph(), f.verified);
  t.mock.method(BaseFeeQuoteReader.prototype, "status", async function(this: BaseFeeQuoteReader) {
    const verified = await this.graph(); return { ...unavailableBaseCollectorStatus(), collector: verified.collector };
  });
  assert.equal((await f.audit.engine()).collector, collector);
  assert.deepEqual(checks, ["runtime", false, "runtime", false]); assert.equal(f.httpReads(), 0);
});

test("host audit uses live activation verification for trusted Splits without a fee-execution proof", async t => {
  const originalActivation = clone(BASE_COLLECTOR_MANIFEST.activation);
  t.after(() => { BASE_COLLECTOR_MANIFEST.activation = originalActivation; });
  const checks: unknown[] = []; let retained = false;
  const f = fixture(t, { dependencies: { verifyCollector: (async (client: Client, address: Address, options: any) => {
    assert.equal(client, f.baseClient); assert.equal(address, collector); assert.equal(options.auditStore, f.baseStore.value);
    checks.push(options.requireActivation);
    if (options.requireActivation === "runtime" && !retained) throw new Error("Finalized activation record missing");
    return clone(f.verified);
  }) as any } });
  const manifest = BASE_COLLECTOR_MANIFEST;
  manifest.activation = { status: "trusted_splits_authorized", trustedSplitsAcceptance: {
    version: 1, sourceChainId: 8453, destinationChainId: 4663, graphFingerprint: blockHash(2), collector,
    automationReceiver: manifest.constants.automationReceiver!, destinationTreasury: manifest.constants.destinationTreasury,
    destinationWeth: manifest.constants.destinationWeth, destinationVault: manifest.constants.destinationVault,
    keeper: "0x3333333333333333333333333333333333333333", ruleId: manifest.nativeRule.ruleId!,
    configurationSha256: manifest.nativeRule.configurationSha256!, trustSplitsNativeExecution: true,
    signer: manifest.constants.governor!, signature: "0x1234",
  } };
  await assert.rejects(f.audit.graph(), /activation record missing/);
  assert.deepEqual(checks, ["runtime"]);
  assert.equal(manifest.activation.nativeExecution, undefined, "No genuine-fee receipt or scheduler run is fabricated");
  retained = true;
  assert.deepEqual(await f.audit.graph(), f.verified);
  assert.deepEqual(checks, ["runtime", "runtime"]);
  f.verified.automationReceiver = manifest.constants.automationReceiver!;
  const round = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 0,
    verifyAuthority: async () => { await f.audit.graph(); return true; } });
  assert.equal(round.activationVerified, true, "An applicable trusted snapshot cannot downgrade the verified host runtime gate");
  assert.equal(round.snapshot?.graph?.activationVerified, true); assert.equal(round.error, undefined);
  assert.equal(f.baseStore.counts.auditWrites, 1); assert.equal(f.rhStore.counts.auditWrites, 1);
  checks.length = 0;
  manifest.activation.trustedSplitsAcceptance!.signature = "0x";
  await f.audit.graph();
  manifest.activation.status = "not_run";
  await f.audit.graph();
  assert.deepEqual(checks, [false, false], "Unsigned and not_run configurations remain graph-only reads");
  assert.equal(f.httpReads(), 0); assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
});

for (const failure of ["activation record missing", "acceptance not finalized", "EIP-1271 authorization revoked"]) test(`maintenance indexes and publishes when ${failure}`, async t => {
  const writes: { chain: number; contents: any }[] = [];
  const f = fixture(t, { dependencies: { publishSnapshot: async (runtime, _store, contents) => {
    writes.push({ chain: runtime.config.chainId, contents: clone(contents) }); return contents as any;
  } } });
  const result = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 100,
    verifyGraph: async () => f.verified, verifyAuthority: async () => { throw new Error(failure); } });
  assert.deepEqual(f.calls.filter(call => call.startsWith("reconcile:")), ["reconcile:4663:34", "reconcile:8453:33", "reconcile:4663:33"]);
  assert.equal(result.graph?.collector, collector); assert.equal(result.activationVerified, false); assert.match(String(result.error), new RegExp(failure));
  assert(result.snapshot); assert.equal(result.snapshot.graph?.activationVerified, false); assert.equal(writes.length, 2);
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
});

test("a round without an authority gate never marks execution approved, and a failed publication writes a degraded display", async t => {
  let failPublication = false;
  const f = fixture(t, { dependencies: { publishSnapshot: async (_runtime, _store, contents) => {
    if (failPublication) throw new Error("Projection read failed"); return contents as any;
  } } });
  const first = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 100, verifyGraph: async () => f.verified });
  assert.equal(first.activationVerified, false); assert(first.snapshot);
  // Seed the real private CAS projection through the ordinary publisher.
  const seed = await f.audit.publish(); await publishBaseAuditSnapshot(f.runtime, f.displayStore.value, seed);
  f.advance(1); failPublication = true;
  const result = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 100, verifyGraph: async () => f.verified, verifyAuthority: async () => true });
  assert.equal(result.activationVerified, false); assert.match(String(result.error), /Projection read failed/);
  assert(result.snapshot); assert.equal(result.snapshot.collectorStatus.available, false); assert.equal(result.snapshot.graph, null);
  assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, 6);
});

test("an unrecoverable maintenance-round failure downgrades an existing display without retrying successful readiness", async t => {
  const f = fixture(t); await f.audit.publish(); const before = f.baseStore.counts.auditWrites; f.advance(1); f.setChains(4663, 4663);
  const result = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 100, verifyGraph: async () => f.verified, verifyAuthority: async () => true });
  assert.equal(result.activationVerified, false); assert.equal(result.snapshot?.graph, null);
  assert.equal(result.snapshot?.custody.ready, false); assert.match(String(result.error), /financial scopes/);
  assert.equal(f.baseStore.counts.auditWrites, before + 1); assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, 0);
});

test("public display publication uses bound per-scope CAS rows and cannot authorize spending", async t => {
  const f = fixture(t), published = await f.audit.publish();
  assert.equal(published.graph, null); assert.equal(published.custody.ready, false); assert.equal(published.sourceStatus.ready, false);
  assert.equal(f.baseStore.counts.auditWrites, 1); assert.equal(f.rhStore.counts.auditWrites, 1);
  const baseRow = [...f.baseStore.rows.values()][0], rhRow = [...f.rhStore.rows.values()][0];
  assert.equal(baseRow.scope, "base"); assert.equal(baseRow.runtimeChainId, 8453); assert.equal(rhRow.scope, "robinhood"); assert.equal(rhRow.runtimeChainId, 4663);
  assert.notEqual(baseRow.id, rhRow.id); assert.ok(await readBaseAuditSnapshot(f.runtime, f.baseStore.value));
  assert.equal(await readBaseAuditSnapshot({ ...f.runtime, dataScope: "verify-base-canary" }, f.baseStore.value), null);
  assert.equal((await f.audit.custody()).ready, false); assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
});

test("one display custody projection supplies both source status and the default Collector reader without a second source session", async t => {
  const f = fixture(t, { dependencies: { readCollectorStatus: undefined } }); let custodyReads = 0, sourceReads = 0;
  f.setSourceState({ revision: 1 }); f.setTreasuryState({ revision: 1 });
  f.onCustody(async () => sourceProjectionFixture(String(++custodyReads)));
  f.onSource(async () => { sourceReads++; assert.fail("Display must not start another source custody session"); });
  t.mock.method(BaseFeeQuoteReader.prototype, "status", async function(this: BaseFeeQuoteReader) {
    await this.graph(); const source = await this.deps.custodyReport!();
    return { ...unavailableBaseCollectorStatus(), totalBridgedWeth: source.receivedWeth };
  });
  const published = await f.audit.publish(f.verified);
  assert.equal(custodyReads, 1); assert.equal(sourceReads, 0); assert.equal(published.sourceStatus.receivedWeth, "1");
  assert.equal(published.collectorStatus.totalBridgedWeth, published.sourceStatus.receivedWeth);
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0); assert.equal(f.httpReads(), 0);
});

test("a concurrent spending read stays fresh while a display source projection is pending", async t => {
  const f = fixture(t, { dependencies: { readCollectorStatus: undefined } }), entered = deferred(), release = deferred(); let sourceReads = 0;
  f.setSourceState({ revision: 1 }); f.setTreasuryState({ revision: 1 });
  f.onCustody(async () => {
    const reading = ++sourceReads;
    if (reading === 1) { entered.resolve(); await release.promise; }
    return sourceProjectionFixture(String(10 + reading));
  });
  f.onSource(async () => ({ ready: false, assets: [], receivedWeth: String(10 + ++sourceReads), refundedWeth: "0" }));
  t.mock.method(BaseFeeQuoteReader.prototype, "status", async function(this: BaseFeeQuoteReader) {
    await this.graph(); const source = await this.deps.custodyReport!();
    return { ...unavailableBaseCollectorStatus(), totalBridgedWeth: source.receivedWeth };
  });
  const publication = f.audit.publish(f.verified); await entered.promise;
  assert.equal((await f.audit.engine()).totalBridgedWeth, "12"); assert.equal(sourceReads, 2);
  release.resolve(); const published = await publication;
  assert.equal(published.sourceStatus.receivedWeth, "11"); assert.equal(published.collectorStatus.totalBridgedWeth, "11");
  assert.equal((await f.audit.engine()).totalBridgedWeth, "13");
  f.advance(1);
  assert.equal((await f.audit.publish(f.verified)).sourceStatus.receivedWeth, "14"); assert.equal(sourceReads, 4);
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0); assert.equal(f.httpReads(), 0);
});

test("moving-head Vault publication uses the custody round's coherent projection instead of a second unrelated read", async t => {
  const f = fixture(t); let extraReads = 0;
  t.mock.method(f.ledgers.get(4663)!, "read", async () => { extraReads++; return emptyVaultLedgerReport(201n); });
  const published = await f.audit.publish();
  assert.equal(extraReads, 0); assert.equal(published.vaultLedger.confirmedThrough, "200");
  assert.deepEqual(published.vaultLedger, published.custody.vault);
  assert.equal(f.baseStore.counts.auditWrites, 1); assert.equal(f.rhStore.counts.auditWrites, 1);
});

test("final canonical anchors cover advancing confirmation heads without renewing the round observation TTL", async t => {
  const f = fixture(t), observedAt = f.now();
  for (const [client, chain, first, final] of [[f.baseClient, 8453, 100n, 110n], [f.rhClient, 4663, 200n, 210n]] as const) {
    let heads = 0;
    t.mock.method(client, "getBlock", async ({ blockTag, blockNumber }: any) => {
      const number = blockTag === "latest" ? ++heads === 1 ? first : final : blockNumber;
      return { number, hash: blockHash(chain + Number(number)) } as any;
    });
  }
  f.onCustody(async () => {
    f.advance(2000);
    return { ready: false, reason: "Still pending source attribution", automation: emptyCustodyReport("base_automation", 101n),
      treasury: emptyCustodyReport("robinhood_treasury", 201n), vault: emptyVaultLedgerReport(201n) };
  });
  const published = await f.audit.publish();
  assert.deepEqual(published.anchors.map(anchor => anchor.number), ["110", "210"]);
  assert.equal(published.custody.automation.confirmedThrough, "101"); assert.equal(published.vaultLedger.confirmedThrough, "201");
  for (const store of [f.baseStore, f.rhStore]) {
    const row = [...store.rows.values()][0]; assert.equal(row.observedAt, observedAt); assert.equal(row.publishedAt, f.now()); assert.equal(row.expiresAt, f.now() + 60_000);
  }
  assert.ok(await readBaseAuditSnapshot(f.runtime, f.baseStore.value));
});

test("publication preserves old observation time with a new display TTL and rejects future observations", async t => {
  const f = fixture(t); const observedAt = f.now(); f.advance(60_000);
  await f.audit.publish(undefined, observedAt);
  await assert.rejects(f.audit.publish(undefined, f.now() + 1), /expired|inconsistent/);
  assert.equal(f.displayStore.counts.auditWrites + f.rhStore.counts.auditWrites, 2);
});

test("a journal revision changing during projection prevents either namespace from publishing", async t => {
  const f = fixture(t); f.setSourceState({ revision: 1 }); f.onCustody(() => { f.setSourceState({ revision: 2 }); });
  await assert.rejects(f.audit.publish(), /revision changed/); assert.equal(f.baseStore.counts.auditWrites + f.rhStore.counts.auditWrites, 0);
});

test("a canonical anchor changing after projection prevents publication instead of retaining a fresh-looking row", async t => {
  const f = fixture(t); let reads = 0;
  t.mock.method(f.baseClient, "getBlock", async () => ({ number: 100n, hash: ++reads > 1 ? blockHash(999) : blockHash(8453) } as any));
  await assert.rejects(f.audit.publish(), /reorganized/); assert.equal(f.baseStore.counts.auditWrites + f.rhStore.counts.auditWrites, 0);
});

test("closing an active round waits for it and cannot close caller-owned canonical handles", async t => {
  const f = fixture(t), entered = deferred(), finish = deferred(); let first = true;
  f.onReconcile(async () => { if (first) { first = false; entered.resolve(); await finish.promise; } });
  const operation = f.audit.reconcile(100); await entered.promise; let closed = false;
  const closing = f.audit.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(f.audit.custody(), /closed/); finish.resolve(); await Promise.all([operation, closing]);
  assert.equal(f.baseStore.counts.closes + f.rhStore.counts.closes, 0); assert.equal(closed, true);
});

test("one maintenance cycle checks each current graph once across all phases and display, then refreshes next round", async t => {
  // This exercises orchestration, not receipt acceptance: the publication spy
  // cannot persist an approval or manufacture financial-ready journal rows.
  const f = fixture(t, { exerciseGraphs: true, dependencies: { readCollectorStatus: undefined, publishSnapshot: async (_runtime, _store, contents) => contents as any } });
  t.mock.method(BaseFeeQuoteReader.prototype, "status", async function(this: BaseFeeQuoteReader) {
    await this.graph(); await this.deps.custodyReport!(); return unavailableBaseCollectorStatus();
  });
  for (let round = 1; round <= 2; round++) {
    const result = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyAuthority: async () => true });
    assert.equal(result.error, undefined); assert(result.snapshot); assert.equal(result.activationVerified, true);
    assert.equal(f.calls.filter(call => call === "graph:8453").length, round);
    assert.equal(f.calls.filter(call => call === "graph:4663").length, round);
    assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, round * 3);
    const scoped = f.creates.slice(-2);
    assert(scoped.every(created => created.dependencies.fairMaintenance === true));
    assert.notEqual(scoped[0].dependencies.verifyCollector, f.creates[0].dependencies.verifyCollector);
    assert.notEqual(scoped[0].dependencies.verifyRobinhoodGraph, f.creates[0].dependencies.verifyRobinhoodGraph);
    f.advance(1);
  }
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
});

test("the completed runtime settlement graph supplies the same maintenance cycle without repeating RH verification", async t => {
  const f = fixture(t, { exerciseGraphs: true });
  // The real runtime verifier's field-production constraints are covered in
  // base-collector-verification. This is only its internal orchestration output.
  f.verified.currentSettlementGraph = { vault: BASE_BUYBACK_VAULT, weth: BASE_COLLECTOR_MANIFEST.constants.destinationWeth,
    swapper: collector, engineForwarders: [automation] };
  await f.audit.reconcile(60_000); const unseeded = f.calls.filter(call => call === "graph:4663").length;
  assert.equal(unseeded, 1);
  await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyGraph: async () => clone(f.verified) });
  assert.equal(f.calls.filter(call => call === "graph:4663").length, unseeded, "A fully checked runtime graph must not be rechecked inside every journal/display reader");
  await f.audit.custody();
  assert.equal(f.calls.filter(call => call === "graph:4663").length, unseeded + 1, "A concurrent/outside-round financial read must recheck the destination graph");
  f.advance(1); await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyGraph: async () => clone(f.verified) });
  assert.equal(f.calls.filter(call => call === "graph:4663").length, unseeded + 1);
});

test("concurrent graph, custody and engine spending reads observe current account changes independently of the maintenance memo", async t => {
  let revoked = false, freshChecks = 0;
  const f = fixture(t, { exerciseGraphs: true, dependencies: { readCollectorStatus: undefined,
    publishSnapshot: async (_runtime, _store, contents) => contents as any,
    verifyCollector: (async () => { freshChecks++; if (revoked) throw new Error("Current Automation owner changed"); return clone(f.verified); }) as any } });
  t.mock.method(BaseFeeQuoteReader.prototype, "status", async function(this: BaseFeeQuoteReader) {
    await this.graph(); return unavailableBaseCollectorStatus();
  });
  const entered = deferred(), release = deferred(); let first = true;
  f.onReconcile(async () => { if (first) { first = false; entered.resolve(); await release.promise; } });
  const operation = f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyAuthority: async () => true });
  await entered.promise; assert.equal(freshChecks, 1); revoked = true;
  await assert.rejects(f.audit.graph(), /Current Automation owner changed/);
  await assert.rejects(f.audit.custody(), /Current Automation owner changed/);
  await assert.rejects(f.audit.engine(), /Current Automation owner changed/);
  assert.equal(freshChecks, 4, "Concurrent financial readers must never borrow the cycle's earlier successful check");
  release.resolve(); const completed = await operation;
  assert(completed.snapshot, "Only this display/maintenance cycle may reuse its earlier graph"); assert.equal(freshChecks, 4);
  f.advance(1); const next = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyAuthority: async () => true });
  assert.match(String(next.error), /Current Automation owner changed/); assert.equal(next.activationVerified, false);
  assert.equal(next.snapshot?.graph ?? null, null); assert(freshChecks > 4);
  revoked = false; f.advance(1);
  const recovered = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyAuthority: async () => true });
  assert.equal(recovered.error, undefined); assert.equal(recovered.activationVerified, true);
});

test("revoked runtime authority permits static receipt recovery but never authorizes another fee signature", async t => {
  const f = fixture(t, { exerciseGraphs: true });
  const result = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000,
    verifyGraph: async () => { throw new Error("EIP-1271 live authority revoked"); }, verifyAuthority: async () => { assert.fail("No authority callback without a runtime graph"); } });
  assert.equal(result.activationVerified, false); assert.match(String(result.error), /authority revoked/);
  assert.equal(result.graph?.collector, collector); assert.equal(result.snapshot?.graph?.activationVerified, false);
  assert.equal(f.calls.filter(call => call === "graph:8453").length, 1);
  assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, 3);
});

test("whole-round singleflight covers initial checks, reconciliation and publication without another writer", async t => {
  const publications: number[] = [];
  const f = fixture(t, { dependencies: { publishSnapshot: async (runtime, _store, contents) => { publications.push(runtime.config.chainId); return contents as any; } } }),
    entered = deferred(), release = deferred(); let graphReads = 0;
  const options = { observedAt: f.now(), maxDurationMs: 60_000, verifyGraph: async () => {
    graphReads++; entered.resolve(); await release.promise; return f.verified;
  }, verifyAuthority: async () => true };
  const first = f.audit.maintainRound(options); await entered.promise;
  const second = f.audit.maintainRound(options), third = f.audit.reconcile(60_000);
  await Promise.resolve(); assert.equal(graphReads, 1); assert.equal(f.creates.length, 2);
  release.resolve(); const [a, b] = await Promise.all([first, second, third]);
  assert.equal(a, b); assert.equal(f.calls.filter(call => call.startsWith("reconcile:")).length, 3);
  assert.deepEqual(publications, [8453, 4663]); assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
  f.advance(1); await f.audit.maintainRound({ ...options, observedAt: f.now() }); assert.equal(graphReads, 2);
});

test("a failed per-cycle destination graph is retried next round and never resets financial journals", async t => {
  let fail = true, reads = 0;
  const f = fixture(t, { exerciseGraphs: true, dependencies: { publishSnapshot: async (_runtime, _store, contents) => contents as any, verifyRobinhoodGraph: async () => {
    reads++; if (fail) throw new Error("Temporary RH graph RPC failure");
    return { vault: BASE_BUYBACK_VAULT, weth: BASE_COLLECTOR_MANIFEST.constants.destinationWeth, swapper: collector };
  } } });
  const first = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyAuthority: async () => true });
  assert.equal(reads, 1); assert.match(String(first.error), /Temporary RH graph RPC failure/); assert.equal(first.activationVerified, false);
  assert.equal(first.snapshot?.graph ?? null, null, "A first failed round cannot fabricate a completed snapshot");
  fail = false; f.advance(1);
  const recovered = await f.audit.maintainRound({ observedAt: f.now(), maxDurationMs: 60_000, verifyAuthority: async () => true });
  assert.equal(reads, 2); assert.equal(recovered.error, undefined); assert.equal(recovered.activationVerified, true);
  assert.equal(f.baseStore.counts.financialWrites + f.rhStore.counts.financialWrites, 0);
  assert(!f.calls.some(call => call.startsWith("initialize:")));
});
