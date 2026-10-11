import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, stringToHex, type Hex } from "viem";
import manifestData from "../contracts/artifacts/base-collector-deployment.json";
import type { BaseCollectorManifest } from "../server/base-collector";
import type { BaseAuditStore } from "../server/base-audit";
import { BASE_NATIVE_DESTINATION_POLICY } from "../src/lib/base-buyback";
import { canonicalProofJson } from "../server/base-native-provenance";
import { activationRecordIdentity, assertBaseActivationRecord, baseActivationAcceptanceReady, hasBaseLaunchActivationRecord, persistBaseActivationRecord,
  type BaseActivationAnchors, type BaseActivationHeads } from "../server/base-activation-record";

const hash = (number: bigint | number): Hex => `0x${BigInt(number).toString(16).padStart(64, "0")}`;
const graph = hash(999);
const unavailable = /finalized Base activation record is unavailable or changed/;
function fixture() {
  const manifest = structuredClone(manifestData) as unknown as BaseCollectorManifest;
  manifest.activation = { status: "canary_verified", nativeExecution: { proof: { sourceHash: hash(10), destinationHash: hash(20) }, amounts: ["100", "200"] },
    nativeRunAcceptance: { signature: "0x1234", jobId: "fixed-native-job" } as any,
    walletAcceptance: { signature: "0x2345", desktop: { launchHash: hash(11) }, mobile: { launchHash: hash(12) } } as any,
    pauseRollbackAcceptance: { signature: "0x3456", pauseHash: hash(13), resumeHash: hash(14) } as any };
  manifest.canaryAuthorization = { signature: "0x4567", expiresAt: "1" } as any;
  const anchors: BaseActivationAnchors = { source: [{ number: 100n, hash: hash(100) }, { number: 101n, hash: hash(101) }],
    destination: [{ number: 120n, hash: hash(120) }] };
  const heads: BaseActivationHeads = { source: { number: 300n, hash: hash(300) }, destination: { number: 400n, hash: hash(400) } };
  const records = new Map<string, { id: string; [key: string]: any }>();
  let casCalls = 0, rpcReads = 0, casMiss = false, storeFailure = false;
  const store: BaseAuditStore = {
    getBuybackBatch: id => { if (storeFailure) throw new Error("provider 404"); return structuredClone(records.get(id) ?? null); },
    compareAndSetBuybackAudit: (next, expected) => {
      casCalls++;
      if (storeFailure) throw new Error("storage unavailable");
      if (casMiss || JSON.stringify(records.get(next.id) ?? null) !== JSON.stringify(expected)) return false;
      records.set(next.id, structuredClone(next)); return true;
    },
  };
  const client = (initialChainId: number) => {
    const state = { chainId: initialChainId, finalized: 200n, finalizedHash: undefined as Hex | undefined, badBlock: undefined as bigint | undefined,
      wrongNumber: undefined as bigint | undefined, failed: false, unsupportedFinalized: false, reorgOnHeadRead: 0, headReads: 0 };
    const mock = { state, getChainId: async () => state.chainId, getBlock: async (input: { blockNumber?: bigint; blockTag?: string }) => {
      rpcReads++;
      if (state.failed || input.blockTag === "finalized" && state.unsupportedFinalized) throw new Error("RPC unavailable with secret URL");
      const number = input.blockNumber ?? state.finalized;
      if (number === (initialChainId === 8453 ? heads.source.number : heads.destination.number)) state.headReads++;
      const changedHead = state.reorgOnHeadRead > 0 && state.headReads >= state.reorgOnHeadRead && number === (initialChainId === 8453 ? heads.source.number : heads.destination.number);
      return { number: state.wrongNumber === number ? number + 1n : number,
        hash: input.blockTag === "finalized" && state.finalizedHash ? state.finalizedHash : changedHead || state.badBlock === number ? hash(888) : hash(number) };
    }, getTransactionReceipt: async () => { throw new Error("must not replay historical receipts"); },
      getLogs: async () => { throw new Error("must not rescan historical events"); }, request: async () => { throw new Error("must not request debug trace"); } };
    return mock as unknown as Parameters<typeof assertBaseActivationRecord>[0] & { state: typeof state };
  };
  const source = client(8453), destination = client(4663);
  return { manifest, anchors, heads, store, records, source, destination, client, reads: () => rpcReads, casCalls: () => casCalls,
    mutateStore: (value: { casMiss?: boolean; failure?: boolean }) => { casMiss = value.casMiss ?? false; storeFailure = value.failure ?? false; } };
}

function trustedFixture() {
  const f = fixture(), manifest = f.manifest;
  manifest.canaryAuthorization = null;
  manifest.activation = { status: "trusted_splits_authorized", trustedSplitsAcceptance: {
    version: 1, sourceChainId: 8453, destinationChainId: 4663, graphFingerprint: graph,
    collector: manifest.collector.address!, automationReceiver: manifest.constants.automationReceiver!,
    destinationTreasury: manifest.constants.destinationTreasury, destinationWeth: manifest.constants.destinationWeth,
    destinationVault: manifest.finalSettlement.vault, keeper: "0xd3f11a4DDcED57aC4E41F8CE7fD323959667e278",
    ruleId: manifest.nativeRule.ruleId!, configurationSha256: manifest.nativeRule.configurationSha256!,
    trustSplitsNativeExecution: true, signer: manifest.constants.governor!, signature: "0x1234",
  } };
  return f;
}

test("trusted Splits acceptance can persist exact finalized wiring without creating canary fee, native execution, wallet or burn proof", async () => {
  const f = trustedFixture();
  assert.equal(baseActivationAcceptanceReady(f.manifest), true);
  assert.equal(await hasBaseLaunchActivationRecord(f.store, f.manifest, graph), false);
  assert.equal(f.manifest.canaryAuthorization, null);
  for (const key of ["nativeExecution", "nativeRunAcceptance", "walletAcceptance", "pauseRollbackAcceptance"])
    assert.equal((f.manifest.activation as Record<string, unknown>)[key], undefined);
  await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  assert.equal(await hasBaseLaunchActivationRecord(f.store, f.manifest, graph), true);
  await assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads);
  const record = [...f.records.values()][0];
  assert.equal(record.protocol, "internal_native_activation_v1");
  assert.equal(record.version, 1);
  assert.equal(record.graphFingerprint, graph);
  assert(!JSON.stringify(record).includes("canary_verified"));
  assert(!JSON.stringify(record).includes("nativeExecution"));
  const reads = f.reads(), writes = f.casCalls();
  f.source.state.failed = true; f.destination.state.failed = true;
  assert.equal(await hasBaseLaunchActivationRecord(f.store, f.manifest, graph), true);
  assert.equal(f.reads(), reads); assert.equal(f.casCalls(), writes);
});

test("trusted status alone, missing signature, wrong governor or altered configured wiring cannot grant activation", async () => {
  const other = "0x1111111111111111111111111111111111111111";
  const changes: ((m: BaseCollectorManifest) => void)[] = [
    m => { delete m.activation.trustedSplitsAcceptance; },
    m => { m.activation.trustedSplitsAcceptance!.signature = undefined as any; },
    m => { m.activation.trustedSplitsAcceptance!.signature = "0x"; },
    m => { m.activation.trustedSplitsAcceptance!.signature = "0x123"; },
    m => { m.activation.trustedSplitsAcceptance!.signature = "not-hex" as Hex; },
    m => { m.activation.trustedSplitsAcceptance!.signer = other; },
    m => { m.activation.trustedSplitsAcceptance!.keeper = "0x0000000000000000000000000000000000000000"; },
    m => { m.activation.trustedSplitsAcceptance!.version = 2 as any; },
    m => { m.activation.trustedSplitsAcceptance!.sourceChainId = 4663 as any; },
    m => { m.activation.trustedSplitsAcceptance!.destinationChainId = 8453 as any; },
    m => { m.activation.trustedSplitsAcceptance!.trustSplitsNativeExecution = false as any; },
    m => { delete (m.activation.trustedSplitsAcceptance as any).trustSplitsNativeExecution; },
    m => { m.activation.trustedSplitsAcceptance!.graphFingerprint = "0x"; },
    m => { m.activation.trustedSplitsAcceptance!.collector = other; },
    m => { m.activation.trustedSplitsAcceptance!.automationReceiver = other; },
    m => { m.activation.trustedSplitsAcceptance!.destinationTreasury = other; },
    m => { m.activation.trustedSplitsAcceptance!.destinationWeth = other; },
    m => { m.activation.trustedSplitsAcceptance!.destinationVault = other; },
    m => { m.activation.trustedSplitsAcceptance!.ruleId = ""; },
    m => { m.activation.trustedSplitsAcceptance!.ruleId += "-changed"; },
    m => { m.activation.trustedSplitsAcceptance!.configurationSha256 = hash(777); },
    m => { m.activation.trustedSplitsAcceptance!.configurationSha256 = "0x"; },
    m => { m.activation.status = "not_run"; },
  ];
  for (const change of changes) {
    const f = trustedFixture(); change(f.manifest);
    assert.equal(baseActivationAcceptanceReady(f.manifest), false);
    await assert.rejects(() => persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads), unavailable);
    assert.equal(await hasBaseLaunchActivationRecord(f.store, f.manifest, graph), false);
    assert.equal(f.casCalls(), 0); assert.equal(f.records.size, 0);
  }
});

test("trusted activation record binds the full signed acceptance, graph and any retained historical canary authorization", async () => {
  const f = trustedFixture();
  await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  const identity = activationRecordIdentity(f.manifest, graph);
  for (const change of [
    (m: BaseCollectorManifest) => { m.activation.trustedSplitsAcceptance!.signature = "0x5678"; },
    (m: BaseCollectorManifest) => { m.activation.trustedSplitsAcceptance!.keeper = "0x1111111111111111111111111111111111111111"; },
    (m: BaseCollectorManifest) => { m.canaryAuthorization = { signature: "0x4567", expiresAt: "1" } as any; },
  ]) {
    const changed = structuredClone(f.manifest); change(changed);
    assert.notEqual(activationRecordIdentity(changed, graph).id, identity.id);
    assert.equal(await hasBaseLaunchActivationRecord(f.store, changed, graph), false);
    await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, changed, graph, f.heads), unavailable);
  }
  const changedGraph = structuredClone(f.manifest);
  changedGraph.activation.trustedSplitsAcceptance!.graphFingerprint = hash(998);
  assert.equal(baseActivationAcceptanceReady(changedGraph), true, "The new graph requires its own explicit finalized record");
  await assert.rejects(() => persistBaseActivationRecord(f.source, f.destination, f.store, changedGraph, graph, f.anchors, f.heads), unavailable);
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, changedGraph, hash(998), f.heads), unavailable);
  assert.equal(await hasBaseLaunchActivationRecord(f.store, changedGraph, hash(998)), false);
  assert.equal(f.casCalls(), 1);
});

test("trusted acceptance remains pending on unavailable RPC, missing finality, shallow anchors or an operator CAS conflict", async () => {
  for (const cause of ["rpc", "finalized", "depth", "cas"] as const) {
    const f = trustedFixture();
    if (cause === "rpc") f.source.state.failed = true;
    if (cause === "finalized") f.destination.state.finalized = 119n;
    if (cause === "depth") f.heads.source = { number: 164n, hash: hash(164) };
    if (cause === "cas") f.mutateStore({ casMiss: true });
    await assert.rejects(() => persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads), unavailable);
    assert.equal(f.records.size, 0);
    assert.equal(await hasBaseLaunchActivationRecord(f.store, f.manifest, graph), false);
  }
});

test("historical canary acceptance still requires every original proof and cannot be silently upgraded to trusted Splits", () => {
  const f = fixture();
  assert.equal(baseActivationAcceptanceReady(f.manifest), true);
  for (const field of ["nativeExecution", "nativeRunAcceptance", "walletAcceptance", "pauseRollbackAcceptance"] as const) {
    const changed = structuredClone(f.manifest); delete changed.activation[field];
    assert.equal(baseActivationAcceptanceReady(changed), false, field);
  }
  const missingAuthorization = structuredClone(f.manifest); missingAuthorization.canaryAuthorization = null;
  assert.equal(baseActivationAcceptanceReady(missingAuthorization), false);
  f.manifest.activation.status = "trusted_splits_authorized";
  assert.equal(baseActivationAcceptanceReady(f.manifest), false);
});

test("finalized activation is reused across cold clients without receipts, logs, traces, writes, or a TTL", async () => {
  const f = fixture();
  await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  const id = activationRecordIdentity(f.manifest, graph).id, record = f.records.get(id)!;
  assert.equal(record.protocol, "internal_native_activation_v1");
  assert.equal(record.destinationPolicy, BASE_NATIVE_DESTINATION_POLICY);
  assert.equal(record.sourceChainId, 8453); assert.equal(record.destinationChainId, 4663);
  record.verifiedAt = 1; // Old but still finalized acceptance remains reusable.
  const before = f.casCalls();
  await assertBaseActivationRecord(f.client(8453), f.client(4663), f.store, f.manifest, graph, f.heads);
  await assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads);
  assert.equal(f.casCalls(), before); assert(f.reads() > 0);
});

test("issuance reads one matching completed private record without keeper freshness, current RPCs or another audit", async () => {
  const f = fixture();
  assert.equal(await hasBaseLaunchActivationRecord(f.store, f.manifest, graph), false);
  await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  const reads = f.reads(), writes = f.casCalls(); let databaseReads = 0;
  const store = { getBuybackBatch: (id: string) => { databaseReads++; return f.store.getBuybackBatch(id); } };
  f.source.state.failed = true; f.destination.state.failed = true;
  assert.equal(await hasBaseLaunchActivationRecord(store, f.manifest, graph), true);
  assert.equal(databaseReads, 1); assert.equal(f.reads(), reads); assert.equal(f.casCalls(), writes);
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  assert.equal(await hasBaseLaunchActivationRecord(store, f.manifest, hash(998)), false);
  f.mutateStore({ failure: true }); assert.equal(await hasBaseLaunchActivationRecord(store, f.manifest, graph), false);
});

test("activation records accepted under an older destination policy cannot authorize the new validator", async () => {
  const f = fixture();
  await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  const identity = activationRecordIdentity(f.manifest, graph), valid = structuredClone(f.records.get(identity.id)!);
  const legacyBinding = keccak256(stringToHex(canonicalProofJson({ protocol: "internal_native_activation_v1", version: 1,
    sourceChainId: 8453, destinationChainId: 4663, graphFingerprint: graph,
    activation: f.manifest.activation, canaryAuthorization: f.manifest.canaryAuthorization })));
  const legacy: typeof valid = { ...valid, id: `internal_native_activation:${legacyBinding}`, binding: legacyBinding };
  delete legacy.destinationPolicy;
  assert.notEqual(legacy.id, identity.id);
  f.records.clear(); f.records.set(legacy.id, legacy);
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  assert.deepEqual(f.records.get(legacy.id), legacy, "Old acceptance stays historical rather than being silently upgraded");
  for (const destinationPolicy of [undefined, "specific-provider-router-cleanup-weth-v1", "relay-fixed-router-canonical-receipt-v1"]) {
    f.records.set(identity.id, { ...valid, destinationPolicy });
    await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  }
  f.records.set(identity.id, valid);
  await assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads);
});

test("identity canonically binds the full activation, authorization and exact graph", () => {
  const f = fixture(), identity = activationRecordIdentity(f.manifest, graph);
  const reordered = structuredClone(f.manifest);
  reordered.activation = Object.fromEntries(Object.entries(reordered.activation).reverse()) as BaseCollectorManifest["activation"];
  assert.deepEqual(activationRecordIdentity(reordered, graph.toUpperCase().replace("0X", "0x") as Hex), identity);
  const fields = ["nativeExecution", "nativeRunAcceptance", "walletAcceptance", "pauseRollbackAcceptance"] as const;
  for (const field of fields) {
    const changed = structuredClone(f.manifest); (changed.activation as Record<string, unknown>)[field] = { changed: true };
    assert.notEqual(activationRecordIdentity(changed, graph).id, identity.id);
  }
  const changed = structuredClone(f.manifest); changed.canaryAuthorization!.expiresAt = "2";
  assert.notEqual(activationRecordIdentity(changed, graph).id, identity.id);
  assert.notEqual(activationRecordIdentity(f.manifest, hash(998)).id, identity.id);
});

test("private activation records contain proof hashes and bounded metadata, never wallet plans, journals, or human evidence bodies", async () => {
  const f = fixture(), body = "artifact-only wallet plan, journal and human evidence body";
  (f.manifest.activation.nativeExecution as any).journal = { events: [{ evidenceBody: body.repeat(100) }] };
  (f.manifest.activation.walletAcceptance!.desktop as any).plan = { name: body, exactPlan: body.repeat(100) };
  (f.manifest.activation.pauseRollbackAcceptance as any).humanEvidenceBody = body;
  const identity = activationRecordIdentity(f.manifest, graph);
  assert.match(identity.binding, /^0x[\da-f]{64}$/);
  assert.equal(identity.id, `internal_native_activation:${identity.binding}`);
  await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  const record = f.records.get(identity.id)!, serialized = JSON.stringify(record);
  assert.equal(record.binding, identity.binding);
  for (const raw of [body, "walletAcceptance", "nativeExecution", "canaryAuthorization", "journal", "exactPlan", "humanEvidenceBody"])
    assert(!serialized.includes(raw), `raw proof body was retained: ${raw}`);
  assert(serialized.length < 2000);
  await assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads);
  (f.manifest.activation.nativeExecution as any).journal.events[0].evidenceBody += " changed";
  assert.notEqual(activationRecordIdentity(f.manifest, graph).id, identity.id);
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
});

test("missing or changed acceptance never falls back to a status flag or full replay", async () => {
  const f = fixture();
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  const changed = structuredClone(f.manifest); (changed.activation.nativeExecution as any).amounts[0] = "101";
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, changed, graph, f.heads), unavailable);
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, hash(998), f.heads), unavailable);
  f.records.clear(); f.manifest.activation.status = "not_run";
  await assert.rejects(() => persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads), unavailable);
  assert.equal(f.casCalls(), 1);
});

test("both real finalized heads and 64 block anchor depth are required before a record is written", async () => {
  for (const mutation of ["not_finalized", "wrong_finalized_hash", "unsupported_finalized", "shallow", "head_behind_finalized"] as const) {
    const f = fixture();
    if (mutation === "not_finalized") f.destination.state.finalized = 119n;
    if (mutation === "wrong_finalized_hash") f.source.state.finalizedHash = hash(800);
    if (mutation === "unsupported_finalized") f.source.state.unsupportedFinalized = true;
    if (mutation === "shallow") f.heads.source = { number: 164n, hash: hash(164) };
    if (mutation === "head_behind_finalized") f.source.state.finalized = 301n;
    await assert.rejects(() => persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads), unavailable);
    assert.equal(f.casCalls(), 0, mutation); assert.equal(f.records.size, 0);
  }
});

for(const failure of ["rpc","reorg"] as const)test(`the final activation ${failure} check cannot leave an incomplete record that enables issuance`,async t=>{
  const f=fixture();let finalizedReads=0,fail=true;
  if(failure==="reorg")f.source.state.reorgOnHeadRead=3;
  else{
    const read=f.source.getBlock;
    t.mock.method(f.source,"getBlock",async(input: Parameters<typeof read>[0])=>{
      if(input?.blockTag==="finalized"&&++finalizedReads===2&&fail)throw new Error("Final canonical read RPC 429");
      return read(input);
    });
  }
  await assert.rejects(()=>persistBaseActivationRecord(f.source,f.destination,f.store,f.manifest,graph,f.anchors,f.heads),unavailable);
  assert.equal(f.records.size,0);assert.equal(f.casCalls(),0);
  assert.equal(await hasBaseLaunchActivationRecord(f.store,f.manifest,graph),false);
  fail=false;f.source.state.reorgOnHeadRead=0;
  await persistBaseActivationRecord(f.source,f.destination,f.store,f.manifest,graph,f.anchors,f.heads);
  const retained=structuredClone([...f.records.values()][0]);
  fail=true;finalizedReads=0;f.source.state.headReads=0;
  if(failure==="reorg")f.source.state.reorgOnHeadRead=3;
  await assert.rejects(()=>persistBaseActivationRecord(f.source,f.destination,f.store,f.manifest,graph,f.anchors,f.heads),unavailable);
  assert.deepEqual([...f.records.values()],[retained]);assert.equal(f.casCalls(),1,"A failed re-verification cannot replace or delete completed acceptance");
  assert.equal(await hasBaseLaunchActivationRecord(f.store,f.manifest,graph),true);
});

test("stored scope, shape, exact proof binding, anchor counts and finality evidence are strictly validated", async () => {
  const f = fixture(); await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  const id = activationRecordIdentity(f.manifest, graph).id, valid = structuredClone(f.records.get(id)!);
  const mutations = [
    (r: any) => { r.id = "other"; }, (r: any) => { r.protocol = "base-fee-release"; }, (r: any) => { r.version = 2; },
    (r: any) => { r.binding += " "; }, (r: any) => { r.graphFingerprint = hash(997); }, (r: any) => { r.sourceChainId = 4663; },
    (r: any) => { r.destinationChainId = 8453; }, (r: any) => { r.verifiedAt = 0; }, (r: any) => { r.verifiedAt = "1"; },
    (r: any) => { r.anchors.source = []; }, (r: any) => { r.anchors.source[0].number = "0100"; },
    (r: any) => { r.anchors.source[0].hash = "0x"; }, (r: any) => { r.anchors.source.push(r.anchors.source[0]); },
    (r: any) => { r.anchors.source = Array.from({ length: 160 }, (_, index) => ({ number: String(index), hash: hash(index) })); },
    (r: any) => { r.finalized.destination.number = "119"; }, (r: any) => { r.finalized.source.hash = hash(201); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(valid); mutate(changed); f.records.set(id, changed);
    await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  }
  f.records.set(id, valid);
  await assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads);
});

test("every source/destination anchor and the captured heads remain fresh, including a mid-read reorg", async () => {
  for (const chain of ["source", "destination"] as const) {
    const f = fixture(); await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
    for (const number of [...f.anchors[chain].map(anchor => anchor.number), f.heads[chain].number, 200n]) {
      f[chain].state.badBlock = number;
      await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
      f[chain].state.badBlock = undefined;
    }
    f[chain].state.headReads = 0; f[chain].state.reorgOnHeadRead = 2;
    await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  }
});

test("RPC chain mismatch, wrong returned block, unavailable storage, 404, and lagging finalized head fail closed then recover", async () => {
  const f = fixture(); await persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads);
  f.source.state.chainId = 4663;
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  f.source.state.chainId = 8453; f.destination.state.wrongNumber = 120n;
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  f.destination.state.wrongNumber = undefined; f.source.state.failed = true;
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), error => {
    assert.match(String(error), unavailable); assert(!String(error).includes("secret URL")); return true;
  });
  f.source.state.failed = false; f.mutateStore({ failure: true });
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  f.mutateStore({}); f.destination.state.finalized = 199n;
  await assert.rejects(() => assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads), unavailable);
  f.destination.state.finalized = 200n;
  await assertBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.heads);
});

test("an operator CAS conflict cannot grant acceptance and malformed or excessive anchors cannot be persisted", async () => {
  const f = fixture(); f.mutateStore({ casMiss: true });
  await assert.rejects(() => persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, f.anchors, f.heads), unavailable);
  assert.equal(f.records.size, 0); assert.equal(f.casCalls(), 1);
  f.mutateStore({});
  for (const anchors of [{ source: [], destination: f.anchors.destination },
    { source: Array.from({ length: 160 }, (_, index) => ({ number: BigInt(index), hash: hash(index) })), destination: f.anchors.destination },
    { source: [f.anchors.source[0], f.anchors.source[0]], destination: f.anchors.destination }])
    await assert.rejects(() => persistBaseActivationRecord(f.source, f.destination, f.store, f.manifest, graph, anchors, f.heads), unavailable);
  assert.equal(f.casCalls(), 1);
});

test("simultaneous explicit operator acceptances use private atomic CAS, with exactly one winner", async () => {
  const f = fixture();
  const result = await Promise.allSettled(Array.from({ length: 4 }, () => persistBaseActivationRecord(f.client(8453), f.client(4663), f.store, f.manifest, graph, f.anchors, f.heads)));
  assert.equal(result.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(result.filter(row => row.status === "rejected").length, 3);
  assert.equal(f.records.size, 1);
  await assertBaseActivationRecord(f.client(8453), f.client(4663), f.store, f.manifest, graph, f.heads);
});
