import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, padHex, zeroHash, type Address, type Hex } from "viem";
import { Store } from "../server/store";
import { runtimeFromEnv } from "../server/config";
import { BASE_COLLECTOR_MANIFEST, baseCollectorExpectedRuntime, baseCollectorGraphFingerprint, BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH,
  BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH, BASE_SPLITS_PROXY_HASH } from "../server/base-collector";
import { BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT } from "../src/lib/base-buyback";
import { emptyCustodyReport } from "../src/lib/buyback-custody-ledger";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import { BASE_AUDIT_SNAPSHOT_TTL_MS, createPersistedVaultLedgerRuntime, publishBaseAuditSnapshot, publishBaseAuditFailure, readBaseAuditSnapshot,
  unavailableBaseCollectorStatus, type BaseAuditSnapshotContents } from "../server/buyback-audit-snapshot";

const collector = "0x1111111111111111111111111111111111111111" as Address;
const automation = "0x2222222222222222222222222222222222222222" as Address;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
function fixture(t: TestContext) {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const directory = mkdtempSync(join(tmpdir(), "host-audit-snapshot-")), store = new Store(directory, 8453);
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  // Synthetic reviewed identities exercise the parser. No fixture is a chain
  // deployment, a governor signature or actual production acceptance.
  BASE_COLLECTOR_MANIFEST.collector.address = collector;
  BASE_COLLECTOR_MANIFEST.constants.automationReceiver = automation;
  BASE_COLLECTOR_MANIFEST.status = "deployed_verified";
  Object.assign(BASE_COLLECTOR_MANIFEST.collector, { transactionHash: blockHash, blockNumber: "1" });
  const owner = BASE_COLLECTOR_MANIFEST.constants.governor!;
  const signer = { slot1: padHex(owner, { size: 32 }), slot2: zeroHash };
  BASE_COLLECTOR_MANIFEST.automationAccount = { address: automation, owner, runtimeHash: BASE_SPLITS_PROXY_HASH,
    implementation: { address: BASE_SPLITS_IMPLEMENTATION, runtimeHash: BASE_SPLITS_IMPLEMENTATION_HASH },
    factory: { address: BASE_SPLITS_FACTORY, runtimeHash: BASE_SPLITS_FACTORY_HASH }, threshold: 1, signers: [{ ...signer,index: 0 }],
    initializationHash: blockHash, blockNumber: "1", creation: { owner,threshold: 1,signers: [signer],salt: "8453" } };
  BASE_COLLECTOR_MANIFEST.collector.runtimeHash = keccak256(baseCollectorExpectedRuntime(BASE_COLLECTOR_MANIFEST));
  BASE_COLLECTOR_MANIFEST.activation.status = "canary_verified";
  t.after(() => { Object.assign(BASE_COLLECTOR_MANIFEST, manifest); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const runtime = runtimeFromEnv(8453, { CHAIN_MODE: "base", NODE_ENV: "development", BASE_FEE_COLLECTOR_ADDRESS: collector,
    BASE_PLATFORM_TREASURY: BASE_COLLECTOR_MANIFEST.constants.operationsTreasury!, ENABLE_BASE_TRANSACTIONS: "true", DATA_DIR: directory });
  const ar = { ...emptyCustodyReport("base_automation", 100n), ready: true, fresh: true, caughtUp: true, revision: 1, lagBlocks: "0", checkpointBlock: "1", indexedThrough: "100", reason: null };
  const tr = { ...emptyCustodyReport("robinhood_treasury", 100n), ready: true, fresh: true, caughtUp: true, revision: 2, lagBlocks: "0", checkpointBlock: "1", indexedThrough: "100", reason: null };
  const vault = { ...emptyVaultLedgerReport(100n), initialized: true, attributionReady: true, fresh: true, caughtUp: true, lagBlocks: "0", checkpointBlock: "1", indexedThrough: "100", reason: null };
  const contents = (): BaseAuditSnapshotContents => ({ observedAt: now,
    graph: { collector, automationReceiver: automation, paused: false, activationVerified: true },
    collectorStatus: { ...unavailableBaseCollectorStatus(), available: true, collector, automation, paused: false,
      nativeAutomationState: "configured", ledgerComplete: true, assetsComplete: true, error: undefined },
    custody: { ready: true, reason: null, automation: structuredClone(ar), treasury: structuredClone(tr), vault: structuredClone(vault) },
    vaultLedger: structuredClone(vault), sourceStatus: { ready: true, assets: [], receivedWeth: "0", refundedWeth: "0" },
    anchors: [{ chainId: 8453, number: "164", hash: blockHash }, { chainId: 4663, number: "164", hash: blockHash }], revisions: { automation: 1, treasury: 2, vault: 3 } });
  return { runtime, store, contents, advance: (milliseconds: number) => { now += milliseconds; } };
}

test("private canonical host snapshots round-trip through the existing durable audit CAS and are never journal writers", async t => {
  const f = fixture(t), published = await publishBaseAuditSnapshot(f.runtime, f.store, f.contents());
  assert.equal(published.generation, 1); assert.equal(published.expiresAt - published.publishedAt, 60_000);
  assert.deepEqual(await readBaseAuditSnapshot(f.runtime, f.store), JSON.parse(JSON.stringify(published)));
  assert.equal(f.store.getBuybackBatch(published.id)?.protocol, "internal_native_host_snapshot_v1");
  const runtime = createPersistedVaultLedgerRuntime(f);
  assert.equal((await runtime.custody()).ready, true); assert.equal((await runtime.read()).attributionReady, true);
  assert.equal((await runtime.sourceStatus()).ready, true); assert.equal(await runtime.automationPolicy(), "configured");
  await assert.rejects(runtime.initialize(), /read-only/); await assert.rejects(runtime.reconcile(), /read-only/);
});

test("a slow round gets a display TTL from publication while preserving its original observation and read expiry", async t => {
  const f = fixture(t), contents = f.contents(); f.advance(90_000);
  const published = await publishBaseAuditSnapshot(f.runtime, f.store, contents);
  assert.equal(published.observedAt, 10_000); assert.equal(published.publishedAt, 100_000);
  assert.equal(published.expiresAt, 160_000);
  assert.ok(await readBaseAuditSnapshot(f.runtime, f.store)); f.advance(59_999);
  assert.ok(await readBaseAuditSnapshot(f.runtime, f.store)); f.advance(1);
  assert.equal(await readBaseAuditSnapshot(f.runtime, f.store), null);
  const readonly = createPersistedVaultLedgerRuntime(f);
  assert.equal((await readonly.custody()).ready, false); assert.equal((await readonly.read()).attributionReady, false);
  assert.equal((await readonly.sourceStatus()).ready, false); assert.equal(await readonly.automationPolicy(), "unverified");
  assert.equal(f.store.getBuybackBatch(published.id)?.expiresAt, published.expiresAt);
  await assert.rejects(publishBaseAuditSnapshot(f.runtime, f.store, contents), /older|expired/);
});

test("a failed round downgrades its display without fabricating new anchors or overriding a newer observation", async t => {
  const f = fixture(t), good = await publishBaseAuditSnapshot(f.runtime, f.store, f.contents());
  f.advance(1);
  const failed = await publishBaseAuditFailure(f.runtime, f.store, good.observedAt);
  assert(failed); assert.equal(failed.generation, 2); assert.equal(failed.graph, null); assert.equal(failed.collectorStatus.available, false);
  assert.equal(failed.custody.ready, false); assert.equal(failed.custody.automation.fresh, false); assert.equal(failed.custody.treasury.fresh, false);
  assert.equal(failed.vaultLedger.attributionReady, false); assert.equal(failed.sourceStatus.ready, false);
  assert.deepEqual(failed.anchors, good.anchors); assert.deepEqual(failed.revisions, good.revisions);
  assert.equal(failed.expiresAt - failed.publishedAt, BASE_AUDIT_SNAPSHOT_TTL_MS);
  f.advance(1); const newer = await publishBaseAuditSnapshot(f.runtime, f.store, f.contents());
  assert.equal(await publishBaseAuditFailure(f.runtime, f.store, good.observedAt), null);
  assert.equal((await readBaseAuditSnapshot(f.runtime, f.store))?.generation, newer.generation);
});

test("failed projections preserve the original financial observation and record the failed round separately",async t=>{
  const f=fixture(t),good=await publishBaseAuditSnapshot(f.runtime,f.store,f.contents());
  f.advance(20_000);const failedRoundAt=Date.now(),failed=await publishBaseAuditFailure(f.runtime,f.store,failedRoundAt);
  assert(failed);assert.equal(failed.observedAt,good.observedAt);
  assert.equal((failed as any).failedAt,failedRoundAt);assert.equal(failed.publishedAt,Date.now());
  assert.deepEqual(failed.anchors,good.anchors);assert.deepEqual(failed.revisions,good.revisions);
  assert.equal(failed.custody.ready,false);assert.equal(failed.vaultLedger.attributionReady,false);
  const readonly=createPersistedVaultLedgerRuntime(f),display=await readonly.read() as any;
  assert.equal(display.auditObservedAt,good.observedAt);assert.equal(display.auditFailedAt,failedRoundAt);
  f.advance(10_000);const second=await publishBaseAuditFailure(f.runtime,f.store,Date.now());
  assert(second);assert.equal(second.observedAt,good.observedAt);assert.equal((second as any).failedAt,Date.now());
  assert.equal(await publishBaseAuditFailure(f.runtime,f.store,failedRoundAt),null,"An older failed round cannot override a newer failure");
  await assert.rejects(()=>publishBaseAuditSnapshot(f.runtime,f.store,{...f.contents(),observedAt:failedRoundAt+1}),/older/);
  f.advance(1);const recovered=await publishBaseAuditSnapshot(f.runtime,f.store,f.contents());
  assert.equal((recovered as any).failedAt,undefined);assert.equal(recovered.observedAt,Date.now());
});

test("failure timestamps require a degraded projection and remain bounded by the original observation and publication",async t=>{
  const f=fixture(t),good=await publishBaseAuditSnapshot(f.runtime,f.store,f.contents());
  f.store.saveBuybackBatch({...good,failedAt:good.observedAt});
  assert.equal(await readBaseAuditSnapshot(f.runtime,f.store),null,"A failure marker cannot preserve healthy financial readiness");
  f.store.saveBuybackBatch(good);f.advance(10_000);const failed=await publishBaseAuditFailure(f.runtime,f.store,Date.now());assert(failed);
  for(const failedAt of [good.observedAt-1,failed.publishedAt+1,-1,"20000"]){
    f.store.saveBuybackBatch({...failed,failedAt});assert.equal(await readBaseAuditSnapshot(f.runtime,f.store),null);
  }
  f.store.saveBuybackBatch(failed);assert.ok(await readBaseAuditSnapshot(f.runtime,f.store));
});

test("host and Worker clock skew safely withholds display without altering timestamps or extending the TTL",async t=>{
  const f=fixture(t),published=await publishBaseAuditSnapshot(f.runtime,f.store,f.contents()),retained=f.store.getBuybackBatch(published.id);
  f.advance(-1);assert.equal(await readBaseAuditSnapshot(f.runtime,f.store),null);
  const readonly=createPersistedVaultLedgerRuntime(f);assert.equal((await readonly.read()).attributionReady,false);assert.equal((await readonly.custody()).ready,false);
  assert.equal(await readonly.automationPolicy(),"unverified");assert.deepEqual(f.store.getBuybackBatch(published.id),retained);
  f.advance(1);assert.ok(await readBaseAuditSnapshot(f.runtime,f.store));
  f.advance(BASE_AUDIT_SNAPSHOT_TTL_MS);assert.equal(await readBaseAuditSnapshot(f.runtime,f.store),null);
  assert.deepEqual(f.store.getBuybackBatch(published.id),retained,"Reads cannot rewrite host times, extend expiry or grant execution");
});

test("CAS prevents a late round from replacing newer ready or unavailable evidence", async t => {
  const f = fixture(t), old = f.contents(); await publishBaseAuditSnapshot(f.runtime, f.store, old);
  f.advance(1); const newer = f.contents(); newer.graph!.paused = true; newer.collectorStatus.paused = true;
  const next = await publishBaseAuditSnapshot(f.runtime, f.store, newer);
  await assert.rejects(publishBaseAuditSnapshot(f.runtime, f.store, old), /older/);
  assert.equal((await readBaseAuditSnapshot(f.runtime, f.store))?.graph?.paused, true); assert.equal(next.generation, 2);
  f.advance(1); const rounds = await Promise.allSettled([publishBaseAuditSnapshot(f.runtime, f.store, f.contents()), publishBaseAuditSnapshot(f.runtime, f.store, f.contents())]);
  assert.equal(rounds.filter(row => row.status === "fulfilled").length, 1);
});

test("scope, origin, chain and reviewed artifact changes cannot reuse a ready snapshot", async t => {
  const f = fixture(t); await publishBaseAuditSnapshot(f.runtime, f.store, f.contents());
  for (const changed of [ { ...f.runtime, dataScope: "verify-base-canary" }, { ...f.runtime, canaryOrigin: "http://localhost:3000" },
    { ...f.runtime, config: { ...f.runtime.config, chainId: 4663, mode: "robinhood" as const }, dataScope: "robinhood" } ])
    assert.equal(await readBaseAuditSnapshot(changed, f.store), null);
  BASE_COLLECTOR_MANIFEST.nativeRule.ruleId = "a-new-reviewed-rule";
  assert.equal(await readBaseAuditSnapshot(f.runtime, f.store), null);
});

for (const [name, tamper] of [
  ["wrong chain anchor", (row: any) => { row.anchors[0].chainId = 4663; }],
  ["late anchor", (row: any) => { row.anchors[0].number = "99"; }],
  ["revision mismatch", (row: any) => { row.revisions.treasury++; }],
  ["Treasury mismatch", (row: any) => { row.collectorStatus.destinationTreasury = collector; }],
  ["Vault mismatch", (row: any) => { row.collectorStatus.destinationVault = collector; }],
  ["fake aggregate ready", (row: any) => { row.custody.automation.ready = false; }],
  ["fake fresh lag", (row: any) => { row.custody.automation.lagBlocks = "0"; row.custody.automation.indexedThrough = "99"; }],
  ["expanded lag allowance", (row: any) => { row.custody.automation.maxLagBlocks = "999999"; }],
  ["missing live checkpoint", (row: any) => { row.custody.automation.checkpointBlock = null; }],
  ["different Vault projections", (row: any) => { row.vaultLedger.baseAttributedMuseToDead = "42"; }],
  ["extended TTL", (row: any) => { row.expiresAt += BASE_AUDIT_SNAPSHOT_TTL_MS; }],
  ["future audit", (row: any) => { row.observedAt++; }],
  ["future publication", (row: any) => { row.publishedAt++; }],
  ["malformed display batch", (row: any) => { row.collectorStatus.batches.push({protocol:"splits_native_relay_v1"}); }],
] as const) test(`private snapshot validation rejects ${name}`, async t => {
  const f = fixture(t), row = await publishBaseAuditSnapshot(f.runtime, f.store, f.contents());
  tamper(row); f.store.saveBuybackBatch(row);
  assert.equal(await readBaseAuditSnapshot(f.runtime, f.store), null);
});

test("an incomplete graph cannot become configured from arbitrary status booleans", async t => {
  const f = fixture(t), row = f.contents(); row.graph = null;
  await assert.rejects(publishBaseAuditSnapshot(f.runtime, f.store, row), /inconsistent/);
  assert.equal(BASE_BUYBACK_TREASURY, row.collectorStatus.destinationTreasury); assert.equal(BASE_BUYBACK_VAULT, row.collectorStatus.destinationVault);
});

test("an expired or absent private owner authorization cannot authorize public or canary activation", async t => {
  const f = fixture(t); BASE_COLLECTOR_MANIFEST.activation.status = "not_run";
  await assert.rejects(publishBaseAuditSnapshot(f.runtime, f.store, f.contents()), /inconsistent/);
  f.runtime.dataScope = "verify-base-canary"; f.runtime.canaryOrigin = "http://localhost:3000";
  await assert.rejects(publishBaseAuditSnapshot(f.runtime, f.store, f.contents()), /inconsistent/);
});

test("a host-verified private canary is bound to its exact origin, scope and unexpired reviewed authority", async t => {
  const f = fixture(t); BASE_COLLECTOR_MANIFEST.activation.status = "not_run";
  f.runtime.dataScope = "verify-base-canary"; f.runtime.canaryOrigin = "http://localhost:3000";
  BASE_COLLECTOR_MANIFEST.canaryAuthorization = { version: 2,chainId: 8453,origin: f.runtime.canaryOrigin,collector,automationReceiver: automation,
    graphFingerprint: baseCollectorGraphFingerprint(BASE_COLLECTOR_MANIFEST),keeper: "0x3333333333333333333333333333333333333333",
    releaseBudgets: [],maxBaseGasWei: "1",maxRobinhoodGasWei: "1",expiresAt: "30",signer: BASE_COLLECTOR_MANIFEST.constants.governor!,signature: "0x" };
  // Host verification is the trust boundary. This synthetic authority only
  // exercises the read parser; no signature or transaction is produced here.
  const snapshot=await publishBaseAuditSnapshot(f.runtime,f.store,f.contents());
  assert.equal(snapshot.expiresAt,30_000,"Private owner expiry also bounds public display caching");
  assert.ok(await readBaseAuditSnapshot(f.runtime,f.store));
  assert.equal(await readBaseAuditSnapshot({ ...f.runtime,dataScope: "base" },f.store),null);
  assert.equal(await readBaseAuditSnapshot({ ...f.runtime,canaryOrigin: "http://localhost:3001" },f.store),null);
  f.advance(20_000);assert.equal(await readBaseAuditSnapshot(f.runtime,f.store),null,"Owner expiry invalidates even an otherwise live 60-second snapshot");
});
