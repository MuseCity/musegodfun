import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_COLLECTOR_MANIFEST } from "../server/base-collector";
import { baseCanonicalAuditLease, runBaseBuybackKeeper } from "../scripts/base-buyback-keeper";
import { acquireKeeperJournalLock } from "../scripts/buyback-keeper";
import { runVaultLedgerCli } from "../scripts/buyback-vault-ledger";
import { createBaseKeeperAudit, type BaseKeeperAuditDependencies, type BaseKeeperAuditInput } from "../scripts/base-keeper-audit";
import { BaseProcessLeaseLostError } from "../scripts/base-process-lease";
import { BASE_BUYBACK_PROTOCOL, baseCollectorAbi, type BaseFeeBatch } from "../src/lib/base-buyback";
import { CONTRACTS, STOCKS } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { emptyCustodyReport } from "../src/lib/buyback-custody-ledger";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import { unavailableBaseCollectorStatus } from "../server/buyback-audit-snapshot";

/** Execute the unchanged entry point with offline collaborators. The real audit
 * orchestration, task preparation, signature checks, history recovery and paired
 * durable journal writes remain under test; no fixture performs a remote call. */
async function mainLoopFixture(t: TestContext) {
  const directory = await mkdtemp(join(os.tmpdir(), "native-main-loop-"));
  const environment = process.env, oldManifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  const privateTestKey = generatePrivateKey(), keeper = privateKeyToAccount(privateTestKey), collector = "0x1111111111111111111111111111111111111111" as Address;
  const automation = "0x2222222222222222222222222222222222222222" as Address;
  const poolId = `0x${"ab".repeat(32)}` as Hex, blockHash = `0x${"cd".repeat(32)}` as Hex;
  const rows = new Map<string, BaseFeeBatch>(), transactions = new Map<string, any>();
  const calls: string[] = [], snapshots: any[] = [], outputs: any[] = [], signed: Hex[] = [], broadcasts: Hex[] = [];
  let onSign: (() => void) | undefined;
  let authority = false, finalLeaseFailure = false, tailAsserts = 0, leaseArmed = false, stopAfterPublications = Infinity;
  let authorityFailure = "Finalized activation record missing";
  const source = { close() {}, runtimeControl: async () => ({ paused: false, revision: 7 }), tokens: async () => [{
    address: STOCKS[1].address, quoteAddress: STOCKS[0].address, poolId, feePolicy: BASE_AUTOMATION_FEE_POLICY, feeEngine: collector,
  }], custodyLedgerState: async () => null, vaultLedgerState: async () => null,
    buybackBatchPage: async () => [...rows.values()].map((row, index) => ({ ...structuredClone(row), sequence: String(index + 1) })),
    getBuybackBatch: async (id: string) => structuredClone(rows.get(id) ?? null),
    saveBuybackBatch: async (row: BaseFeeBatch) => { calls.push(`persist:${row.status}`); rows.set(row.id, structuredClone(row)); },
    compareAndSetBuybackAudit: async () => { throw new Error("No fixture cache writes are needed"); },
  };
  const claimLogs = [{ address: collector, topics: encodeEventTopics({ abi: baseCollectorAbi, eventName: "FeesClaimed",
    args: { poolId, manager: CONTRACTS.initializer, token: STOCKS[0].address } }), data: encodeAbiParameters([{ type: "uint256" }], [100n]) }];
  const client = { getChainId: async () => 8453, getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 100n, hash: blockHash }),
    getTransactionCount: async () => 7, call: async () => {}, estimateGas: async () => 80_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n }),
    getBalance: async () => { if (finalLeaseFailure && [...rows.values()].some(row => row.status === "unknown" && row.sourceHash)) leaseArmed = true; return 10n ** 18n; },
    readContract: async ({ functionName }: any) => functionName === "getOperatorFee" ? 25n : 500n,
    getTransaction: async ({ hash }: any) => { calls.push("recover:transaction"); assert(transactions.has(hash)); return transactions.get(hash); },
    getTransactionReceipt: async ({ hash }: any) => { calls.push("recover:receipt"); assert(transactions.has(hash)); return {
      transactionHash: hash, from: keeper.address, status: "success", blockHash, blockNumber: 99n, gasUsed: 21_000n,
      effectiveGasPrice: 100n, logs: claimLogs,
    }; },
    request: async ({ method, params }: any) => { assert.equal(method, "eth_getTransactionReceipt"); return {
      transactionHash: params[0], blockHash, blockNumber: "0x63", gasUsed: "0x5208", effectiveGasPrice: "0x64", l1Fee: "0x3e8",
      operatorFeeScalar: "0x0", operatorFeeConstant: "0x19",
    }; }, waitForTransactionReceipt: async () => {},
  };
  const destination = { getChainId: async () => 4663, getBlock: async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 200n, hash: blockHash }) };
  const vault = { ...emptyVaultLedgerReport(200n), initialized: true, fresh: true, attributionReady: true,
    checkpointBlock: "1", indexedThrough: "200", reason: null };
  const custody = { ready: true, reason: null,
    automation: { ...emptyCustodyReport("base_automation", 100n), ready: true, fresh: true },
    treasury: { ...emptyCustodyReport("robinhood_treasury", 200n), ready: true, fresh: true }, vault };
  const graph = { collector, automationReceiver: automation, paused: false, runtimeHash: blockHash, manifestFingerprint: blockHash, initialDeploymentBlock: 1n };
  const maintenanceClient = { ...client }, maintenanceDestination = { ...destination };
  const graphReads: { client: unknown; activation: unknown }[] = [];
  let clientsCreated = 0;
  const verifyCollector = async (checkedClient: any, _address: any, options: any) => {
    graphReads.push({ client: checkedClient, activation: options.requireActivation });
    if (options.requireActivation === false) { assert.equal(options.allowCanary, undefined); calls.push("graph:static"); }
    else { calls.push("authority:live"); if (!authority) throw new Error(authorityFailure); }
    return graph;
  };
  const auditDependencies: BaseKeeperAuditDependencies = {
    verifyCollector: verifyCollector as any, readCollectorStatus: async () => unavailableBaseCollectorStatus(),
    createLedger: ((input: any) => ({ reconcile: async () => { calls.push(`maintain:${input.runtime.config.chainId}`); return vault; },
      custody: async () => custody, read: async () => vault, sourceStatus: async () => ({ ready: true, assets: [], receivedWeth: "0", refundedWeth: "0" }),
      automationPolicy: async () => "unverified", close: async () => {}, initialize: async () => { throw new Error("No checkpoint initialization"); },
    })) as any,
    publishSnapshot: async (_runtime, _store, contents) => { calls.push("publish"); snapshots.push(structuredClone(contents));
      if (snapshots.length === stopAfterPublications) process.emit("SIGTERM"); // Deliver only the local stop event, never an OS signal.
      return contents as any; },
  };
  const wallet = { signTransaction: async (input: any) => { calls.push("sign"); const raw = await keeper.signTransaction({ ...input, chainId: 8453 }); signed.push(raw); onSign?.(); return raw; },
    sendRawTransaction: async ({ serializedTransaction: raw }: { serializedTransaction: Hex }) => {
      calls.push("broadcast"); broadcasts.push(raw); const parsed = parseTransaction(raw), hash = keccak256(raw);
      transactions.set(hash, { hash, type: "eip1559", from: keeper.address, to: parsed.to, nonce: parsed.nonce, input: parsed.data, value: 0n }); return hash;
    } };
  BASE_COLLECTOR_MANIFEST.collector.address = collector; BASE_COLLECTOR_MANIFEST.status = "deployed_verified";
  // A structural legacy acceptance fixture only. The live verifier remains
  // separately mocked and can still reject all financial signatures below.
  BASE_COLLECTOR_MANIFEST.activation = { status: "canary_verified", nativeExecution: {},
    nativeRunAcceptance: {} as any, walletAcceptance: {} as any, pauseRollbackAcceptance: {} as any };
  BASE_COLLECTOR_MANIFEST.canaryAuthorization = {} as any;
  process.env = { PATH: environment.PATH, NODE_ENV: "test", DATA_DIR: directory, BASE_RPC_URL: "https://base.invalid",
    ROBINHOOD_RPC_URL: "https://rh.invalid", BASE_FEE_COLLECTOR_ADDRESS: collector, ENABLE_BASE_TRANSACTIONS: "true",
    BASE_PLATFORM_TREASURY: oldManifest.constants.operationsTreasury!, SUPABASE_URL: "https://offlinefixture.supabase.co",
    SUPABASE_SECRET_KEY: "offline-fixture", MUSEGOD_KEEPER_PRIVATE_KEY: privateTestKey };
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Main-loop regression must remain offline"); });
  t.mock.method(console, "log", (text: string) => outputs.push(JSON.parse(text)));
  const key = `__nativeMainLoop${randomUUID().replaceAll("-", "")}`, entryUrl = new URL("../scripts/base-buyback-keeper.ts", import.meta.url);
  entryUrl.searchParams.set("mainLoopTest", key);
  const overrides: Record<string, Record<string, unknown>> = {
    "viem": { createPublicClient: ({ chain }: any) => (clientsCreated++ % 4) < 2
      ? chain.id === 8453 ? client : destination : chain.id === 8453 ? maintenanceClient : maintenanceDestination,
      createWalletClient: () => wallet },
    "node:os": { homedir: () => directory },
    "../server/base-collector": { verifyBaseCollector: verifyCollector, assertBaseKeeperAuthority: async () => { calls.push("authority:roles"); } },
    "../server/config": { loadEnvironment: () => {} },
    "../server/service": { LaunchpadService: class { store = source; client = client; async fees() { return { lp: { fees0: 1n, fees1: 0n }, trade: { fees0: 0n, fees1: 0n } }; } } },
    "../server/supabase-store": { SupabaseStore: class { constructor() { return source; } } },
    "../server/base-buyback": { readTrustedBaseRecoveryAssets: async () => STOCKS.slice(0, 2) },
    "./base-local-replay": { createLocalReplayClient: (client: any) => client },
    "./base-audit-store": { baseOperatorAuditStore: () => source },
    "./base-keeper-audit": { createBaseKeeperAudit: (input: BaseKeeperAuditInput) => createBaseKeeperAudit({ ...input, destinationStore: source as any }, auditDependencies) },
    "./base-process-lease": { acquireBaseProcessLease: async () => Object.assign(async () => { calls.push("lease:release"); }, { assertHeld() {
      // The two assertions at the gate's tail pass. The final assertion in the
      // actual beforeBroadcast callback loses the lease before transport entry.
      if (leaseArmed && ++tailAsserts === 3) throw new BaseProcessLeaseLostError();
    } }) },
  };
  Reflect.set(globalThis, key, overrides);
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL !== entryUrl.href || !overrides[specifier]) return nextResolve(specifier, context);
    const original = specifier.startsWith(".") ? new URL(`${specifier}.ts`, entryUrl).href : import.meta.resolve(specifier);
    const exports = Object.keys(overrides[specifier]).map(name => `export const ${name}=globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];`).join("\n");
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(original)};\n${exports}`)}` };
  } });
  const oldSignals = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, new Set(process.listeners(signal))]));
  t.after(async () => {
    hooks.deregister(); Reflect.deleteProperty(globalThis, key); process.env = environment;
    Object.assign(BASE_COLLECTOR_MANIFEST, oldManifest);
    for (const [signal, listeners] of oldSignals) for (const listener of process.listeners(signal)) if (!listeners.has(listener)) process.removeListener(signal, listener);
    await rm(directory, { recursive: true, force: true });
  });
  const entry = await import(entryUrl.href) as typeof import("../scripts/base-buyback-keeper");
  return { entry, keeper, collector, automation, poolId, blockHash, rows, transactions, calls, snapshots, outputs, signed, broadcasts,
    client, maintenanceClient, graphReads,
    path: entry.baseCanonicalKeeperLease(collector, keeper.address),
    setAuthority(value: boolean) { authority = value; }, stopAfterPublications(count: number) { stopAfterPublications = count; },
    setAuthorityFailure(value: string) { authorityFailure = value; },
    afterSign(callback: () => void) { onSign = callback; },
    setFinalLeaseFailure(value: boolean) { finalLeaseFailure = value; tailAsserts = 0; leaseArmed = false; } };
}

function installOfflineTrustedAcceptance(f: { collector: Address; automation: Address; keeper: { address: Address }; blockHash: Hex }) {
  const manifest = BASE_COLLECTOR_MANIFEST;
  manifest.constants.automationReceiver = f.automation;
  manifest.activation = { status: "trusted_splits_authorized", trustedSplitsAcceptance: {
    version: 1, sourceChainId: 8453, destinationChainId: 4663, graphFingerprint: f.blockHash,
    collector: f.collector, automationReceiver: f.automation, destinationTreasury: manifest.constants.destinationTreasury,
    destinationWeth: manifest.constants.destinationWeth, destinationVault: manifest.constants.destinationVault,
    keeper: f.keeper.address, ruleId: manifest.nativeRule.ruleId!, configurationSha256: manifest.nativeRule.configurationSha256!,
    trustSplitsNativeExecution: true, signer: manifest.constants.governor!, signature: "0x1234",
  } };
  manifest.canaryAuthorization = null;
  return manifest.activation.trustedSplitsAcceptance!;
}

test("execute main loop keeps maintaining and recovering already broadcast history when live activation is missing", async t => {
  const f = await mainLoopFixture(t), sourceHash = `0x${"ef".repeat(32)}` as Hex;
  const initial: BaseFeeBatch = { id: "retained-broadcast", protocol: BASE_BUYBACK_PROTOCOL, collector: f.collector, kind: "claim", status: "broadcast",
    sourceChainId: 8453, destinationChainId: 4663, createdAt: 1, updatedAt: 1, amountIn: "0", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0",
    claimHashes: [], poolId: f.poolId, sourceHash };
  const tx = f.entry.baseFeeTransaction(initial);
  initial.journal = { caller: f.keeper.address, nonce: 7, to: f.collector, dataHash: keccak256(tx.data), hash: sourceHash, gasLimit: "100000", maxFeePerGas: "100", signedAt: 1 };
  initial.gasReservation = { executionWei: "10000000", l1Wei: "1000", operatorWei: "0", totalWei: "10001000", unsignedHash: sourceHash,
    unsignedBytes: 100, blockNumber: "98", blockHash: f.blockHash };
  f.rows.set(initial.id, structuredClone(initial)); f.transactions.set(sourceHash, { hash: sourceHash, type: "eip1559", from: f.keeper.address, to: f.collector, input: tx.data, nonce: 7, value: 0n });
  await f.entry.writeBasePublicJson(f.path, { version: 2, collector: f.collector, keeper: f.keeper.address, batches: [initial] });
  f.stopAfterPublications(4);
  await f.entry.runBaseBuybackKeeper(["--execute", "--interval=1000", "--max-gas-wei=100000000"]);
  assert.equal(f.calls.filter(call => call.startsWith("maintain:")).length, 6); assert.equal(f.snapshots.length, 4);
  assert(f.snapshots.every(snapshot => snapshot.graph?.activationVerified === false));
  assert.equal(f.calls.filter(call => call === "authority:live").length, 2);
  assert.deepEqual(f.outputs.map(row => row.state), ["signing_deferred", "signing_deferred"]);
  const publicRow = f.rows.get(initial.id)!;
  assert.equal(publicRow.status, "claimed"); assert.equal(publicRow.sourceHash, sourceHash); assert.equal(publicRow.sourceFinalized, true);
  assert.equal(publicRow.actualGas?.totalWei, "2101025"); assert.equal(publicRow.claimCredits?.[0].amount, "100");
  const local = await f.entry.readBasePublicJson<{ batches: BaseFeeBatch[] }>(f.path); assert.deepEqual(local!.batches, JSON.parse(JSON.stringify([publicRow])));
  assert.equal(f.calls.filter(call => call === "recover:receipt").length, 1, "Finalized recovered history is not re-read on the second round");
  assert.equal(f.signed.length, 0); assert.equal(f.broadcasts.length, 0);
});

test("audit-only trusted Splits activation enters the live gate without fabricated execution and cannot bypass a missing activation record", async t => {
  const f = await mainLoopFixture(t), manifest = BASE_COLLECTOR_MANIFEST;
  // The signature below is an offline payload fixture. verifyCollector is the
  // authority boundary: this test never substitutes a provider execution proof.
  installOfflineTrustedAcceptance(f);
  delete process.env.MUSEGOD_KEEPER_PRIVATE_KEY;
  await f.entry.runBaseBuybackKeeper(["--audit-only", "--once"]);
  assert.equal(f.calls.filter(call => call === "authority:live").length, 1);
  assert.equal(f.outputs.at(-1)?.activationVerified, false);
  assert.match(f.outputs.at(-1)?.error ?? "", /Finalized activation record missing/,
    "A failed live gate must report its redacted reason instead of an opaque false readiness flag");
  f.setAuthority(true);
  await f.entry.runBaseBuybackKeeper(["--audit-only", "--once"]);
  assert.equal(f.calls.filter(call => call === "authority:live").length, 2);
  assert.equal(f.outputs.at(-1)?.activationVerified, true);
  assert.equal(f.outputs.at(-1)?.error, undefined);
  const accepted = manifest.activation.trustedSplitsAcceptance!;
  accepted.signature = "0x";
  await f.entry.runBaseBuybackKeeper(["--audit-only", "--once"]);
  assert.equal(f.calls.filter(call => call === "authority:live").length, 2, "An unsigned payload cannot reach the active runtime gate");
  assert.equal(f.outputs.at(-1)?.activationVerified, false);
  accepted.signature = "0x1234";
  manifest.activation.status = "not_run";
  await f.entry.runBaseBuybackKeeper(["--audit-only", "--once"]);
  assert.equal(f.calls.filter(call => call === "authority:live").length, 2, "not_run cannot be authorized by a leftover payload");
  assert.equal(f.outputs.at(-1)?.activationVerified, false);
  assert.equal(f.signed.length, 0); assert.equal(f.broadcasts.length, 0);
});

test("audit-only diagnostics redact RPC credentials while failed authority remains non-signing", async t => {
  const f = await mainLoopFixture(t);
  installOfflineTrustedAcceptance(f);
  const key = "offline-provider-credential";
  process.env.ALCHEMY_API_KEY = key;
  delete process.env.MUSEGOD_KEEPER_PRIVATE_KEY;
  f.setAuthorityFailure(`RPC capacity exceeded at https://rpc.invalid/v2/${key}; credential ${key}`);
  await f.entry.runBaseBuybackKeeper(["--audit-only", "--once"]);
  const output = f.outputs.at(-1);
  assert.equal(output.activationVerified, false);
  assert.match(output.error, /RPC capacity exceeded/);
  assert.match(output.error, /\[upstream\]/);
  assert.match(output.error, /\[redacted\]/);
  assert(!output.error.includes(key)); assert(!output.error.includes("rpc.invalid"));
  assert.equal(f.signed.length, 0); assert.equal(f.broadcasts.length, 0);
});

test("trusted Splits keeper binding is checked again after signing and before transport entry", async t => {
  const f = await mainLoopFixture(t), acceptance = installOfflineTrustedAcceptance(f);
  f.setAuthority(true);
  f.afterSign(() => { acceptance.keeper = STOCKS[2].address; });
  await f.entry.runBaseBuybackKeeper(["--execute", "--once", "--max-gas-wei=100000000"]);
  assert.equal(f.signed.length, 1, "The matching keeper passes the pre-sign authorization gate");
  assert.equal(f.broadcasts.length, 0, "A changed accepted keeper is rejected before broadcast");
  const abandoned = [...f.rows.values()][0];
  assert.equal(abandoned.status, "abandoned"); assert.equal(abandoned.abandonedBeforeBroadcast, true);
  assert.doesNotThrow(() => f.entry.assertBaseNoUnknown([...f.rows.values()], f.keeper.address));
  assert.equal(f.entry.baseCanonicalGasSpent([...f.rows.values()], f.keeper.address), 0n);
  assert(f.graphReads.some(read => read.client === f.maintenanceClient && read.activation === "runtime"),
    "The maintenance round uses its isolated reader");
  assert(f.graphReads.filter(read => read.client === f.client && read.activation === "runtime").length >= 2,
    "Pre-sign and before-broadcast gates independently recheck the original financial reader");
});

test("execute main loop abandons at its last beforeBroadcast lease check, then restart reuses the unused nonce", async t => {
  const f = await mainLoopFixture(t); f.setAuthority(true); f.setFinalLeaseFailure(true);
  await f.entry.runBaseBuybackKeeper(["--execute", "--once", "--max-gas-wei=100000000"]);
  assert.equal(f.signed.length, 1); assert.equal(f.broadcasts.length, 0);
  const abandoned = [...f.rows.values()][0]; assert.equal(abandoned.status, "abandoned"); assert.equal(abandoned.abandonedBeforeBroadcast, true);
  assert.equal(abandoned.sourceHash, keccak256(f.signed[0])); assert.equal(abandoned.journal?.nonce, 7);
  const restored = await f.entry.readBasePublicJson<{ batches: BaseFeeBatch[] }>(f.path); assert.deepEqual(restored!.batches, [abandoned]);
  assert.doesNotThrow(() => f.entry.assertBaseNoUnknown(restored!.batches, f.keeper.address));
  assert.equal(f.entry.baseCanonicalGasSpent(restored!.batches, f.keeper.address), 0n);
  f.setFinalLeaseFailure(false);
  await f.entry.runBaseBuybackKeeper(["--execute", "--once", "--max-gas-wei=100000000"]);
  assert.equal(f.signed.length, 2); assert.equal(f.broadcasts.length, 1); assert.equal(parseTransaction(f.broadcasts[0]).nonce, 7);
  const claimed = [...f.rows.values()].find(row => row.status === "claimed")!; assert(claimed);
  assert.equal(claimed.journal?.nonce, abandoned.journal?.nonce); assert.equal(claimed.actualGas?.totalWei, "2101025");
  assert.equal(f.rows.get(abandoned.id)?.status, "abandoned", "Recovery retains the unused signature's complete durable history");
  assert.equal(f.entry.baseCanonicalGasSpent([...f.rows.values()], f.keeper.address), 2101025n);
});

test("audit-only and execute are rejected before environment, secret or RPC access", async t => {
  const environment = process.env; let secretReads = 0, environmentReads = 0, networkReads = 0, dotenvReads = 0;
  process.env = new Proxy(environment, {
    get(target, name) {
      if (typeof name === "string" && /PRIVATE_KEY|API_KEY|SECRET_KEY|MNEMONIC/.test(name)) {
        secretReads++; throw new Error("Secret access is forbidden before permission parsing");
      }
      return Reflect.get(target, name);
    },
    ownKeys() { environmentReads++; throw new Error("Environment enumeration is forbidden before permission parsing"); },
  });
  t.mock.method(process, "loadEnvFile", () => { dotenvReads++; throw new Error("Unexpected dotenv access"); });
  t.mock.method(globalThis, "fetch", async () => { networkReads++; throw new Error("Unexpected network access"); });
  try {
    await assert.rejects(runBaseBuybackKeeper(["--audit-only", "--execute", "--once"]), /audit-only mode cannot sign or broadcast/);
    assert.equal(secretReads + environmentReads + networkReads + dotenvReads, 0);
  } finally { process.env = environment; }
});

test("undeployed audit-only once is fully offline and does not read signing or storage configuration", async t => {
  const environment = process.env, address = BASE_COLLECTOR_MANIFEST.collector.address, status = BASE_COLLECTOR_MANIFEST.status;
  let environmentReads = 0, networkReads = 0, dotenvReads = 0;
  const output: string[] = [];
  process.env = new Proxy(environment, {
    get(target, name) {
      if (typeof name === "string" && /PRIVATE_KEY|API_KEY|SUPABASE|DATA_DIR/.test(name)) {
        environmentReads++; throw new Error("Undeployed mode cannot construct a wallet or financial store");
      }
      return Reflect.get(target, name);
    },
    ownKeys() { environmentReads++; throw new Error("Undeployed mode cannot load runtime configuration"); },
  });
  BASE_COLLECTOR_MANIFEST.collector.address = null; BASE_COLLECTOR_MANIFEST.status = "not_deployed";
  t.mock.method(process, "loadEnvFile", () => { dotenvReads++; throw new Error("Unexpected dotenv access"); });
  t.mock.method(globalThis, "fetch", async () => { networkReads++; throw new Error("Unexpected network access"); });
  t.mock.method(console, "log", (text: string) => { output.push(text); });
  try {
    await runBaseBuybackKeeper(["--audit-only", "--once"]);
    assert.deepEqual(output.map(text => JSON.parse(text)), [{ mode: "dry_run", state: "not_deployed", chainId: 8453 }]);
    assert.equal(environmentReads + networkReads + dotenvReads, 0);
  } finally { process.env = environment; BASE_COLLECTOR_MANIFEST.collector.address = address; BASE_COLLECTOR_MANIFEST.status = status; }
});

test("manual two-chain reconciliation and the audit keeper compete for the same collector lease before RPC", async t => {
  const directory = await mkdtemp(join(os.tmpdir(), "keeper-audit-cli-lock-"));
  const environment = process.env, address = BASE_COLLECTOR_MANIFEST.collector.address, status = BASE_COLLECTOR_MANIFEST.status;
  const collector = "0x1111111111111111111111111111111111111111" as Address; let networkReads = 0;
  t.mock.method(os, "homedir", () => directory); syncBuiltinESMExports();
  t.mock.method(process, "loadEnvFile", () => {});
  t.mock.method(globalThis, "fetch", async () => { networkReads++; throw new Error("A competing writer cannot reach the RPC"); });
  process.env = { PATH: environment.PATH, NODE_ENV: "test", CHAIN_MODE: "base", DATA_DIR: directory,
    BASE_RPC_URL: "https://base.invalid", ROBINHOOD_RPC_URL: "https://rh.invalid", BASE_FEE_COLLECTOR_ADDRESS: collector,
    BASE_PLATFORM_TREASURY: BASE_COLLECTOR_MANIFEST.constants.operationsTreasury!,
    SUPABASE_URL: "https://offlinefixture.supabase.co", SUPABASE_SECRET_KEY: "public-test-fixture", ENABLE_BASE_TRANSACTIONS: "false" };
  BASE_COLLECTOR_MANIFEST.collector.address = collector; BASE_COLLECTOR_MANIFEST.status = "deployed_verified";
  let unlock: (() => Promise<void>) | undefined;
  try {
    const path = baseCanonicalAuditLease(collector);
    assert.equal(path, baseCanonicalAuditLease(collector.toUpperCase() as Address));
    unlock = await acquireKeeperJournalLock(path);
    for (const chain of [8453, 4663]) await assert.rejects(runVaultLedgerCli([`--chain=${chain}`, "--reconcile"]), /journal lock already exists/);
    await assert.rejects(runBaseBuybackKeeper(["--audit-only", "--once"]), /journal lock already exists/);
    assert.equal(networkReads, 0);
    await unlock(); unlock = undefined;
    const recovered = await acquireKeeperJournalLock(path); await recovered();
  } finally {
    await unlock?.(); process.env = environment; BASE_COLLECTOR_MANIFEST.collector.address = address; BASE_COLLECTOR_MANIFEST.status = status;
    t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true });
  }
});
