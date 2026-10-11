import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import fixture from "./fixtures/base-local-replay-mainnet.json";
import baseFixture from "./fixtures/base-local-replay-base-mainnet.json";
import { createLocalReplayClient, convertFoundryReplayArena, LOCAL_REPLAY_CAST, LocalReplayPendingError,
  localReplayReceiptFingerprint, replayBaseNativeTransaction, validateLocalReplayEvidence, validateLocalReplaySnapshot,
  type LocalReplaySnapshot } from "../scripts/base-local-replay";
import type { Hex, PublicClient } from "viem";
import type { BaseAuditStore } from "../server/base-audit";

const clone = <T>(v: T): T => structuredClone(v);
const hash = fixture.transaction.hash as Hex, rpcUrl = "https://rpc.invalid/private-test-key";
function isPending(code: string) { return (error: unknown) => error instanceof LocalReplayPendingError && error.code === code; }
// Counterfactual ordinary-prefix snapshots below exercise the strict adapter.
// They are not additional mainnet captures and never alter the actual fixture.
function ordinary(): LocalReplaySnapshot {
  const s = clone(fixture) as unknown as LocalReplaySnapshot;
  s.parentBlock = { number: `0x${(BigInt(s.block.number) - 1n).toString(16)}`, hash: s.block.parentHash };
  s.block.transactions.shift();
  s.block.transactions.forEach((tx: any, i: number) => { tx.transactionIndex = `0x${i.toString(16)}`; });
  s.transaction.transactionIndex = "0x1"; s.receipt.transactionIndex = "0x1";
  s.receipt.logs.forEach((log: any) => { log.transactionIndex = "0x1"; });
  return s;
}
function ordinaryBase(): LocalReplaySnapshot {
  // Synthetic Base model, never a re-labelled live transaction or replay.
  const s = ordinary(); s.chainId = 8453; s.transaction.chainId = "0x2105";
  s.block.transactions.forEach((tx: any) => { tx.chainId = "0x2105"; });
  const root = fixture.rawArena.arena[0].trace; let intrinsic = 21_000;
  for (let i = 2; i < s.transaction.input.length; i += 2) intrinsic += s.transaction.input.slice(i, i + 2) === "00" ? 4 : 16;
  s.transaction.gas = `0x${(root.gas_limit + intrinsic).toString(16)}`;
  s.receipt.gasUsed = `0x${(root.gas_used + intrinsic).toString(16)}`;
  s.block.transactions[1] = clone(s.transaction); return s;
}
function syntheticArena() { const a: any = clone(fixture.rawArena); a.arena[0].trace.gas_refund_counter = 0; return a; }
function mockClient(s = ordinaryBase(), change?: (method: string, params: any[], count: number, after: boolean) => unknown) {
  let calls = 0; const state = { after: false, requests: [] as string[] };
  const client = { transport: { type: "http", url: rpcUrl }, marker: "retained", request: async (request: any) => {
    const { method, params } = request; state.requests.push(method); calls++;
    const changed = change?.(method, params, calls, state.after); if (changed !== undefined) return changed;
    if (method === "eth_chainId") return `0x${s.chainId.toString(16)}`;
    if (method === "eth_getTransactionByHash") return clone(s.transaction);
    if (method === "eth_getTransactionReceipt") return clone(s.receipt);
    if (method === "eth_getBlockByNumber") return clone(params[0] === s.block.number ? s.block : s.parentBlock);
    if (method === "eth_getCode") return "0x60016000";
    if (method === "ordinary_forward") return { forwarded: params };
    throw new Error(`forbidden method ${method}`);
  } } as unknown as PublicClient;
  return { client, state };
}
function fakeEngine(t: TestContext, state: { after: boolean }, options: { version?: string; arena?: unknown; rawText?: string; stderrFailure?: boolean;
  stderrText?: string; zeroExitWarning?: boolean; expectedBinary?: string; stop?: boolean; corruptSha?: boolean } = {}) {
  const seen: { args: string[]; options: any }[] = [];
  const mocks = [t.mock.method(fs, "access", async () => {}), t.mock.method(fs, "readFile", async () => Buffer.from("synthetic engine bytes"))];
  // Digest substitution is limited to the synthetic successful-engine cases.
  // The separate corrupt-binary test uses real SHA256 and exercises the guard.
  if (!options.corruptSha) mocks.push(t.mock.method(crypto, "createHash", (() => {
    const h = { update: () => h, digest: () => LOCAL_REPLAY_CAST.sha256 }; return h;
  }) as any));
  mocks.push(t.mock.method(childProcess, "spawn", ((binary: string, args: string[], spawnOptions: any) => {
    assert.equal(binary, options.expectedBinary ?? "/synthetic/cast"); seen.push({ args, options: spawnOptions });
    const p = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => p.emit("close", null)); return true; } });
    queueMicrotask(() => {
      if (options.stop) return;
      if (args[0] === "--version") p.stdout.write(options.version ?? `cast Version: ${LOCAL_REPLAY_CAST.version}\nCommit SHA: ${LOCAL_REPLAY_CAST.commit}\n`);
      else { state.after = true; p.stdout.write(options.rawText ?? JSON.stringify(options.arena ?? syntheticArena())); }
      if (options.stderrFailure && args[0] !== "--version") p.stderr.write(`request failed ${rpcUrl}`);
      if (options.zeroExitWarning && args[0] !== "--version") p.stderr.write(`Warning: replay gas differs from receipt ${rpcUrl}`);
      if (options.stderrText && args[0] !== "--version") p.stderr.write(options.stderrText);
      p.stdout.end(); p.stderr.end(); p.emit("close", options.stderrFailure && args[0] !== "--version" ? 1 : 0);
    }); return p;
  }) as any));
  syncBuiltinESMExports();
  t.after(() => { mocks.forEach(m => m.mock.restore()); syncBuiltinESMExports(); });
  return seen;
}
function replayStore(rows = new Map<string, any>()) {
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)); let writes = 0;
  const store: BaseAuditStore = { getBuybackBatch: async id => rows.has(id) ? json(rows.get(id)) : null,
    compareAndSetBuybackAudit: async (next, expected) => {
      assert.match(next.id, /^internal_native_source_replay:0x[\da-f]{64}$/);
      assert.equal(next.protocol, "internal_native_source_replay_v1");
      if (!assertionEqual(rows.get(next.id) ?? null, expected)) return false;
      rows.set(next.id, json(next)); writes++; return true;
    } };
  return { store, rows, writes: () => writes };
}
function assertionEqual(a: unknown, b: unknown) { try { assert.deepEqual(a, b); return true; } catch { return false; } }
test("read-only replay cache cannot write a lease or failure backoff into the production store",async t=>{
 const f=mockClient(),cache=replayStore(),seen=fakeEngine(t,f.state),readonly={getBuybackBatch:cache.store.getBuybackBatch};
 const options={chainId:8453 as const,rpcUrl,castPath:"/synthetic/cast",auditStore:readonly};
 const success=await replayBaseNativeTransaction(f.client,hash,options);assert.equal(success.metadata.fullReplay,true);
 assert.equal(cache.writes(),0);assert.equal(cache.rows.size,0);assert.equal(seen.filter(x=>x.args[0]==="run").length,1);
 const s=ordinaryBase();s.receipt.gasUsed="0x1";await assert.rejects(replayBaseNativeTransaction(mockClient(s).client,hash,options),isPending("receipt_mismatch"));
 assert.equal(cache.writes(),0);assert.equal(cache.rows.size,0);
});

test("one successful source replay survives five-minute refresh, restart and concurrent attribution readers", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  const [first, parallel] = await Promise.all([replayBaseNativeTransaction(f.client, hash, options), replayBaseNativeTransaction(f.client, hash, options)]);
  assert.deepEqual(parallel, first); assert.equal(seen.filter(x => x.args[0] === "run").length, 1);
  const persisted = [...cache.rows.values()][0]; assert.equal(persisted.state, "verified"); assert.equal(cache.writes(), 2);
  assert(!JSON.stringify(persisted).includes(rpcUrl)); assert.equal(persisted.metadata.replayGasUsedForBudget, false);
  let clock = Date.now() + 300_001; t.mock.method(Date, "now", () => clock);
  for (let n = 0; n < 3; n++) {
    const restart = replayStore(cache.rows), reader = mockClient();
    const result = await replayBaseNativeTransaction(reader.client, hash, { ...options, auditStore: restart.store });
    assert.deepEqual(result, first); assert.equal(restart.writes(), 0);
    assert(reader.state.requests.includes("eth_getTransactionReceipt")); assert(reader.state.requests.includes("eth_getCode"));
    assert(reader.state.requests.filter(x => x === "eth_getBlockByNumber").length >= 4); clock += 300_001;
  }
  assert.equal(seen.filter(x => x.args[0] === "run").length, 1);
  first.trace.input = "0x"; assert.notEqual(parallel.trace.input, "0x", "Joined readers do not share mutable results");
});
test("a source reorg invalidates the persisted replay and records only a newly canonical successful run", async t => {
  const s = ordinaryBase(), f = mockClient(s), cache = replayStore(), seen = fakeEngine(t, f.state);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  const first = await replayBaseNativeTransaction(f.client, hash, options), newHash = `0x${"bb".repeat(32)}`;
  s.block.hash = newHash; s.transaction.blockHash = newHash; s.receipt.blockHash = newHash;
  s.block.transactions.forEach((tx: any) => { tx.blockHash = newHash; }); s.receipt.logs.forEach((log: any) => { log.blockHash = newHash; });
  const next = await replayBaseNativeTransaction(mockClient(s).client, hash, { ...options, auditStore: replayStore(cache.rows).store });
  assert.notEqual(next.metadata.blockHash, first.metadata.blockHash); assert.equal(next.metadata.blockHash, newHash);
  assert.equal(seen.filter(x => x.args[0] === "run").length, 2);
});
for (const change of ["receipt", "typed input", "ordered predecessor"] as const) test(`cached source proof cannot survive changed ${change}`, async t => {
  const s = ordinaryBase(), f = mockClient(s), cache = replayStore(), seen = fakeEngine(t, f.state);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  const first = await replayBaseNativeTransaction(f.client, hash, options);
  if (change === "receipt") s.receipt.gasUsed = "0x1";
  if (change === "typed input") { s.transaction.nonce = "0x999"; s.block.transactions[1] = clone(s.transaction); }
  if (change === "ordered predecessor") s.block.transactions[0].nonce = "0x999";
  const next = replayBaseNativeTransaction(mockClient(s).client, hash, { ...options, auditStore: replayStore(cache.rows).store });
  if (change === "receipt") await assert.rejects(next, isPending("receipt_mismatch"));
  else assert.notEqual((await next).metadata.snapshotFingerprint, first.metadata.snapshotFingerprint);
  assert.equal(seen.filter(x => x.args[0] === "run").length, 2, "A changed execution input requires a fresh full replay");
});
test("cached replay rechecks every historical code anchor, including a post-read reorg", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state), s = ordinaryBase();
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  const first = await replayBaseNativeTransaction(f.client, hash, options);
  const changed = mockClient(s, method => method === "eth_getCode" ? "0x60026000" : undefined);
  const next = await replayBaseNativeTransaction(changed.client, hash, { ...options, auditStore: replayStore(cache.rows).store });
  assert.notEqual(next.metadata.codeFingerprint, first.metadata.codeFingerprint); assert.equal(seen.filter(x => x.args[0] === "run").length, 2);
  let codeRead = false;
  const reorg = mockClient(s, (method, params) => { if (method === "eth_getCode") { codeRead = true; return "0x60026000"; }
    if (codeRead && method === "eth_getBlockByNumber" && params[0] === s.block.number) return { ...s.block, hash: `0x${"cc".repeat(32)}` }; });
  await assert.rejects(replayBaseNativeTransaction(reorg.client, hash, { ...options, auditStore: replayStore(cache.rows).store }), isPending("noncanonical"));
  assert.equal(seen.filter(x => x.args[0] === "run").length, 2, "A final-anchor failure cannot expose the cached trace");
});
test("temporary cache-validation RPC failure keeps the old proof but cannot return it as ready", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state);
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  await replayBaseNativeTransaction(f.client, hash, options); const persisted = clone([...cache.rows.values()][0]);
  const broken = mockClient(undefined, method => { if (method === "eth_getCode") throw new Error(`archive ${rpcUrl}`); });
  await assert.rejects(replayBaseNativeTransaction(broken.client, hash, { ...options, auditStore: replayStore(cache.rows).store }), isPending("rpc_unavailable"));
  const retained = [...cache.rows.values()][0]; assert.equal(retained.state, "verified"); assert.deepEqual(retained.arena, persisted.arena);
  assert.deepEqual(retained.metadata, persisted.metadata); assert.equal(retained.retryAfter, clock + 30_000);
  assert.equal(seen.filter(x => x.args[0] === "run").length, 1);
  const early = mockClient(); await assert.rejects(replayBaseNativeTransaction(early.client, hash, { ...options, auditStore: replayStore(cache.rows).store }), isPending("retry_backoff"));
  assert.equal(early.state.requests.length, 0); clock += 30_001;
  await replayBaseNativeTransaction(mockClient().client, hash, { ...options, auditStore: replayStore(cache.rows).store });
  assert.equal(seen.filter(x => x.args[0] === "run").length, 1); assert.equal([...cache.rows.values()][0].failures, 0);
  await assert.rejects(replayBaseNativeTransaction(broken.client, hash, { ...options, auditStore: replayStore(cache.rows).store }), isPending("rpc_unavailable"));
  assert.equal([...cache.rows.values()][0].retryAfter, clock + 30_000, "A normal success resets the next isolated failure to the initial interval");
});
test("advisory retry cleanup cannot overwrite a newer cache row or turn fresh canonical evidence into unavailable", async t => {
  const f = mockClient(), cache = replayStore(); fakeEngine(t, f.state); let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  const first = await replayBaseNativeTransaction(f.client, hash, options), row = [...cache.rows.values()][0];
  row.failures = 3; row.retryAfter = clock + 30_000; clock += 30_001;
  const cas = cache.store.compareAndSetBuybackAudit;
  cache.store.compareAndSetBuybackAudit = async (next, expected) => {
    if (next.state === "verified" && next.failures === 0) { cache.rows.set(next.id, { ...row, concurrentWinner: true }); return false; }
    return cas(next, expected);
  };
  const fresh = await replayBaseNativeTransaction(mockClient().client, hash, options);
  assert.deepEqual(fresh, first); assert.equal([...cache.rows.values()][0].concurrentWinner, true);
  assert.equal([...cache.rows.values()][0].failures, 3, "A stale reader cannot erase its concurrent winner's retry data");
});
test("failed full replay has persistent exponential backoff, then succeeds without retaining its retry state", async t => {
  const f = mockClient(), cache = replayStore(); let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  let fail = true, runs = 0; const original = fakeEngine(t, f.state);
  // A receipt mutation causes a full-replay validation failure after the VM.
  const reader = () => mockClient(undefined, method => method === "eth_getTransactionReceipt" && fail ? { ...ordinaryBase().receipt, gasUsed: "0x1" } : undefined).client;
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  for (const delay of [30_000, 60_000, 120_000]) {
    await assert.rejects(replayBaseNativeTransaction(reader(), hash, { ...options, auditStore: replayStore(cache.rows).store }), isPending("receipt_mismatch"));
    runs++; const pending = [...cache.rows.values()][0]; assert.equal(pending.retryAfter - clock, delay); assert.equal(pending.failures, runs);
    await assert.rejects(replayBaseNativeTransaction(reader(), hash, { ...options, auditStore: replayStore(cache.rows).store }), isPending("retry_backoff"));
    assert.equal(original.filter(x => x.args[0] === "run").length, runs); clock += delay + 1;
  }
  fail = false; await replayBaseNativeTransaction(reader(), hash, { ...options, auditStore: replayStore(cache.rows).store });
  assert.equal([...cache.rows.values()][0].state, "verified"); assert.equal([...cache.rows.values()][0].failures, 0);
  assert.equal([...cache.rows.values()][0].retryAfter, undefined); assert.equal(original.filter(x => x.args[0] === "run").length, 4);
});
test("different host clients cannot replay under a live lease or overwrite a newer CAS winner", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  const first = replayBaseNativeTransaction(f.client, hash, options), second = replayBaseNativeTransaction(mockClient().client, hash, { ...options, auditStore: replayStore(cache.rows).store });
  const results = await Promise.allSettled([first, second]); assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(results.filter(x => x.status === "rejected" && isPending("cache_busy")(x.reason)).length, 1);
  assert.equal(seen.filter(x => x.args[0] === "run").length, 1); assert.equal([...cache.rows.values()][0].state, "verified");
});
test("corrupted successful metadata is replaced by a complete replay rather than poisoning recovery", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  await replayBaseNativeTransaction(f.client, hash, options); const row = [...cache.rows.values()][0];
  row.arenaFingerprint = `0x${"dd".repeat(32)}`; row.metadata.receiptFingerprint = `0x${"ee".repeat(32)}`;
  await replayBaseNativeTransaction(mockClient().client, hash, { ...options, auditStore: replayStore(cache.rows).store });
  assert.equal(seen.filter(x => x.args[0] === "run").length, 2);
});
test("the actual debug-request hook used by v1 and operator proof readers reuses the persistent source cache", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  const first = createLocalReplayClient(f.client, options), request = { method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] };
  const trace = await (first.request as any)(request);
  const resumed = mockClient(), second = createLocalReplayClient(resumed.client, { ...options, auditStore: replayStore(cache.rows).store });
  assert.deepEqual(await (second.request as any)(request), trace); assert.equal(seen.filter(x => x.args[0] === "run").length, 1);
  assert([...f.state.requests, ...resumed.state.requests].every(method => !method.startsWith("debug_")));
  assert.equal([...cache.rows.values()][0].state, "verified");
});
test("an expired source replay lease recovers after host failure without releasing any financial reservation", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state); let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const options = { chainId: 8453 as const, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store };
  await replayBaseNativeTransaction(f.client, hash, options); const row = [...cache.rows.values()][0];
  row.state = "running"; row.lease = { token: "crashed-host", until: clock + 90_000 };
  await assert.rejects(replayBaseNativeTransaction(mockClient().client, hash, { ...options, auditStore: replayStore(cache.rows).store }), isPending("cache_busy"));
  assert.equal(seen.filter(x => x.args[0] === "run").length, 1); clock += 90_001;
  await replayBaseNativeTransaction(mockClient().client, hash, { ...options, auditStore: replayStore(cache.rows).store });
  assert.equal([...cache.rows.values()][0].state, "verified"); assert.equal(seen.filter(x => x.args[0] === "run").length, 2);
});
test("late successful replay cannot publish after a different cache owner wins its commit", async t => {
  const f = mockClient(), cache = replayStore(), seen = fakeEngine(t, f.state), cas = cache.store.compareAndSetBuybackAudit;
  cache.store.compareAndSetBuybackAudit = async (next, expected) => {
    if (next.state === "verified") { cache.rows.set(next.id, { ...JSON.parse(JSON.stringify(next)), concurrentWinner: true }); return false; }
    return cas(next, expected);
  };
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast", auditStore: cache.store }), isPending("cache_busy"));
  assert.equal(seen.filter(x => x.args[0] === "run").length, 1); assert.equal([...cache.rows.values()][0].concurrentWinner, true);
  assert.equal([...cache.rows.values()][0].state, "verified", "A missed commit cannot replace the newer row with failure backoff");
});

test("actual no-quick arena preserves delegate context, exact raw log order and all three nodes", () => {
  const out = convertFoundryReplayArena(fixture.rawArena);
  assert.equal(out.nodeCount, 3); assert.equal(out.trace.calls[0].calls[0].type, "DELEGATECALL");
  assert.equal(out.logs[0].address.toLowerCase(), fixture.receipt.logs[0].address.toLowerCase());
  assert.notEqual(out.logs[0].address.toLowerCase(), out.trace.calls[0].calls[0].to.toLowerCase());
  assert.deepEqual(out.logs.map(log => ({ ...log, address: log.address.toLowerCase() })),
    fixture.receipt.logs.map(log => ({ address: log.address.toLowerCase(), topics: log.topics, data: log.data })));
  assert.equal(fixture.engine.quick, false); assert.equal(fixture.strictAccepted, false);
});
test("actual sample is not an accepted replay: parent was not observed and 0x6a prefix is unsupported", () => {
  assert.throws(() => validateLocalReplaySnapshot(fixture as unknown as LocalReplaySnapshot, 4663, hash), isPending("missing_history"));
  const s = clone(fixture) as unknown as LocalReplaySnapshot;
  s.parentBlock = { hash: s.block.parentHash, number: `0x${(BigInt(s.block.number) - 1n).toString(16)}` };
  assert.throws(() => validateLocalReplayEvidence(s, fixture.rawArena, 4663, hash), isPending("unsupported_l2_prefix"));
});
test("ordinary synthetic prefix can match a full tree/receipt, with canonical gas independent of replay call gas", () => {
  const out = validateLocalReplayEvidence(ordinary(), fixture.rawArena, 4663, hash);
  assert.equal(out.canonicalTransactionGasUsed, fixture.receipt.gasUsed);
  assert.equal(out.replayGasUsedForBudget, false); assert.equal(out.trace.gasUsed, "0x9a1a");
  assert.notEqual(out.trace.gasUsed, out.canonicalTransactionGasUsed);
});
for (const [name, mutate, code] of [
  ["wrong chain", (s: LocalReplaySnapshot) => { s.chainId = 8453; }, "wrong_chain"],
  ["transaction hash", (s: LocalReplaySnapshot) => { s.transaction.hash = `0x${"00".repeat(32)}`; }, "noncanonical"],
  ["header reorg", (s: LocalReplaySnapshot) => { s.block.hash = `0x${"00".repeat(32)}`; }, "noncanonical"],
  ["parent reorg", (s: LocalReplaySnapshot) => { s.parentBlock.hash = `0x${"00".repeat(32)}`; }, "noncanonical"],
  ["transaction input", (s: LocalReplaySnapshot) => { s.transaction.input = "0x"; }, "transaction_binding"],
  ["transaction order", (s: LocalReplaySnapshot) => { s.block.transactions.reverse(); }, "transaction_binding"],
  ["foreign log", (s: LocalReplaySnapshot) => { s.receipt.logs[0].transactionHash = `0x${"00".repeat(32)}`; }, "transaction_binding"],
  ["removed log", (s: LocalReplaySnapshot) => { s.receipt.logs[0].removed = true; }, "transaction_binding"],
  ["Base deposit prefix", (s: LocalReplaySnapshot) => { s.block.transactions[0].type = "0x7e"; }, "unsupported_l2_prefix"],
  ["unknown L2 prefix", (s: LocalReplaySnapshot) => { s.block.transactions[0].type = "0x66"; }, "unsupported_l2_prefix"],
] as const) test(`snapshot refuses ${name}`, () => {
  const s = ordinary(); mutate(s); assert.throws(() => validateLocalReplaySnapshot(s, 4663, hash), isPending(code));
});
test("receipt log mutation and root status mutation cannot pass a structurally correct tree", () => {
  const s = ordinary(); s.receipt.logs[0].data = "0x";
  assert.throws(() => validateLocalReplayEvidence(s, fixture.rawArena, 4663, hash), isPending("receipt_mismatch"));
  const reverted = ordinary(); reverted.receipt.status = "0x0";
  assert.throws(() => validateLocalReplayEvidence(reverted, fixture.rawArena, 4663, hash), isPending("receipt_mismatch"));
});
for (const [name, mutate, code] of [
  ["duplicate child", (a: any) => { a.arena[0].children.push(1); a.arena[0].ordering.push({ Call: 1 }); }, "unsupported_arena"],
  ["orphan", (a: any) => { a.arena.push({ ...clone(a.arena[2]), idx: 3 }); }, "unsupported_arena"],
  ["wrong parent", (a: any) => { a.arena[2].parent = 0; }, "unsupported_arena"],
  ["unknown ordering", (a: any) => { a.arena[0].ordering[0] = { Step: 0 }; }, "unsupported_arena"],
  ["hidden child", (a: any) => { a.arena[0].ordering.shift(); a.arena[0].logs[0].position = 0; }, "unsupported_arena"],
  ["fake caller", (a: any) => { a.arena[2].trace.caller = a.arena[0].trace.caller; }, "unsupported_arena"],
  ["excess nodes", (a: any) => { a.arena = Array.from({ length: 4097 }, () => a.arena[0]); }, "resource_limit"],
] as const) test(`arena refuses ${name}`, () => {
  const a = clone(fixture.rawArena); mutate(a); assert.throws(() => convertFoundryReplayArena(a), isPending(code));
});
test("failed subtree logs disappear from the canonical stream while its error and children remain", () => {
  const a = clone(fixture.rawArena); a.arena[1].trace.success = false; a.arena[1].trace.status = "Revert";
  const out = convertFoundryReplayArena(a);
  assert.equal(out.logs.length, 1); assert.equal(out.logs[0].address.toLowerCase(), fixture.transaction.to.toLowerCase());
  assert.equal(out.trace.calls[0].error, "Revert"); assert.equal(out.trace.calls[0].calls.length, 1);
});
test("excess depth is pending without recursively exhausting the host stack", () => {
  const base = clone(fixture.rawArena.arena[0]); const nodes = Array.from({ length: 130 }, (_, i) => ({ ...clone(base), idx: i,
    parent: i ? i - 1 : null, children: i < 129 ? [i + 1] : [], logs: [], ordering: i < 129 ? [{ Call: 0 }] : [],
    trace: { ...clone(base.trace), depth: i, caller: i ? base.trace.address : base.trace.caller } }));
  assert.throws(() => convertFoundryReplayArena({ arena: nodes }), isPending("resource_limit"));
});
test("wrapper forwards ordinary requests and rejects any nonexact tracer without remote fallback", async () => {
  const f = mockClient(), local = createLocalReplayClient(f.client, { chainId: 4663, rpcUrl });
  assert.equal((local as any).marker, "retained");
  assert.deepEqual(await (local.request as any)({ method: "ordinary_forward", params: [7] }), { forwarded: [7] });
  for (const params of [[hash, { tracer: "prestateTracer" }], [hash, { tracer: "callTracer", reexec: 999 }], [hash], ["not_hash", { tracer: "callTracer" }]])
    await assert.rejects((local.request as any)({ method: "debug_traceTransaction", params }), isPending("invalid_request"));
  assert.deepEqual(f.state.requests, ["ordinary_forward"]);
});
test("unreviewed Robinhood Nitro backend stays pending and never reaches remote debug", async () => {
  const s = clone(fixture) as unknown as LocalReplaySnapshot;
  s.parentBlock = { hash: s.block.parentHash, number: `0x${(BigInt(s.block.number) - 1n).toString(16)}` };
  const f = mockClient(s), local = createLocalReplayClient(f.client, { chainId: 4663, rpcUrl, castPath: "/unavailable/cast" });
  await assert.rejects((local.request as any)({ method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] }), isPending("unsupported_vm"));
  assert(!f.state.requests.some(method => method.startsWith("debug_")));
});
test("unknown Base prefix is rejected before spawning a replay", async () => {
  const s = ordinaryBase(); s.block.transactions[0].type = "0x66";
  const f = mockClient(s), local = createLocalReplayClient(f.client, { chainId: 8453, rpcUrl, castPath: "/unavailable/cast" });
  await assert.rejects((local.request as any)({ method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] }), isPending("unsupported_l2_prefix"));
  assert(!f.state.requests.some(method => method.startsWith("debug_")));
});
test("real Base deposit-prefix replay matches all 36 nodes, six logs and canonical net gas", () => {
  const s = clone(baseFixture) as unknown as LocalReplaySnapshot;
  const out = validateLocalReplayEvidence(s, baseFixture.rawArena, 8453, s.transaction.hash);
  assert.equal(out.nodeCount, 36); assert.equal(out.logs.length, 6);
  assert.equal(out.canonicalTransactionGasUsed, "0x52c16");
  assert.notEqual(out.trace.gasUsed, out.canonicalTransactionGasUsed);
  assert.equal(baseFixture.projectFeeClosedLoopAccepted, false);
  assert.equal(baseFixture.engine.sha256, LOCAL_REPLAY_CAST.sha256);
});
test("an unexplained real Base gas or refund difference remains pending", () => {
  const s = clone(baseFixture) as unknown as LocalReplaySnapshot, raw = clone(baseFixture.rawArena);
  raw.arena[0].trace.gas_refund_counter++;
  assert.throws(() => validateLocalReplayEvidence(s, raw, 8453, s.transaction.hash), isPending("receipt_mismatch"));
  const changed = clone(baseFixture) as unknown as LocalReplaySnapshot; changed.receipt.gasUsed = "0x1";
  assert.throws(() => validateLocalReplayEvidence(changed, baseFixture.rawArena, 8453, changed.transaction.hash), isPending("receipt_mismatch"));
});
test("an unreviewed native Base precompile remains pending despite matching receipt logs", () => {
  const s = clone(baseFixture) as unknown as LocalReplaySnapshot, raw = clone(baseFixture.rawArena);
  const leaf = raw.arena.find(node => !node.children.length && !node.logs.length)!;
  leaf.trace.address = "0x0000000000000000000000000000000000000100";
  assert.throws(() => validateLocalReplayEvidence(s, raw, 8453, s.transaction.hash), isPending("unsupported_vm"));
});
test("Base deposits require their real source hash and mint parameters", () => {
  const s = clone(baseFixture) as unknown as LocalReplaySnapshot; delete s.block.transactions[0].sourceHash;
  assert.throws(() => validateLocalReplaySnapshot(s, 8453, s.transaction.hash), isPending("transaction_binding"));
});
test("Base EIP-7702 prefix authorization is validated and bound across replay snapshots", async t => {
  const s = ordinaryBase(), prefix = s.block.transactions[0]; prefix.type = "0x4";
  prefix.authorizationList = [{ address: prefix.to, chainId: "0x2105", nonce: "0x0", yParity: "0x0", r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` }];
  validateLocalReplaySnapshot(s, 8453, hash);
  const f = mockClient(s, (method, params, _count, after) => {
    if (after && method === "eth_getBlockByNumber" && params[0] === s.block.number) {
      const changed = clone(s.block); changed.transactions[0].authorizationList[0].nonce = "0x1"; return changed;
    }
  }); fakeEngine(t, f.state);
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), isPending("noncanonical"));
  prefix.authorizationList[0].yParity = "0x2";
  assert.throws(() => validateLocalReplaySnapshot(s, 8453, hash), isPending("transaction_binding"));
});
for (const field of ["sourceHash", "mint", "isSystemTx"] as const) test(`Base deposit ${field} cannot change after execution`, async t => {
  const s = ordinaryBase(), prefix = s.block.transactions[0]; prefix.type = "0x7e";
  prefix.sourceHash = `0x${"11".repeat(32)}`; prefix.mint = "0x0"; prefix.isSystemTx = false;
  const f = mockClient(s, (method, params, _count, after) => {
    if (after && method === "eth_getBlockByNumber" && params[0] === s.block.number) {
      const changed = clone(s.block); changed.transactions[0][field] = field === "mint" ? "0x1" : field === "isSystemTx" ? true : `0x${"22".repeat(32)}`; return changed;
    }
  }); fakeEngine(t, f.state);
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), isPending("noncanonical"));
});
test("zero-exit replay warnings remain pending without leaking provider credentials", async t => {
  const f = mockClient(); fakeEngine(t, f.state, { zeroExitWarning: true });
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), error =>
    error instanceof LocalReplayPendingError && error.code === "replay_failed" && !error.message.includes("private-test-key"));
});
test("only the pinned engine's exact prefix progress diagnostic is allowed", async t => {
  const f = mockClient(); fakeEngine(t, f.state, { stderrText: "Executing previous transactions from the block.\n" });
  assert.equal((await replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" })).metadata.version, 2);
});
test("the host uses its separately installed versioned tool and never silently picks the old cast", async t => {
  const f = mockClient(), expectedBinary = join((process.env.PATH ?? "").split(":").filter(Boolean)[0], LOCAL_REPLAY_CAST.executable);
  const seen = fakeEngine(t, f.state, { expectedBinary });
  assert.equal((await replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl })).metadata.castVersion, "1.8.5");
  assert.equal(seen.length, 2);
});
test("wrong endpoint or chain cannot start the local subprocess", async () => {
  const f = mockClient(); await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 4663, rpcUrl: "https://other.invalid" }), isPending("configuration"));
  assert.equal(f.state.requests.length, 0);
  await assert.rejects(replayBaseNativeTransaction(mockClient(ordinary()).client, hash, { chainId: 8453, rpcUrl }), isPending("wrong_chain"));
});
test("synthetic full replay binds two snapshots and code, hides keys from argv, and returns explicit canonical-only gas metadata", async t => {
  const f = mockClient(), seen = fakeEngine(t, f.state);
  const out = await replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" });
  assert.equal(out.trace.calls[0].calls[0].type, "DELEGATECALL"); assert.equal(out.metadata.receiptFingerprint, localReplayReceiptFingerprint(ordinaryBase().receipt));
  assert.equal(out.metadata.fullReplay, true); assert.equal(out.metadata.replayGasUsedForBudget, false);
  assert.equal(out.metadata.systemTransactionsReplayed, true); assert.equal(out.metadata.blockAccessListUsed, false);
  assert.equal(seen.length, 2); assert(seen[1].args.includes("--json")); assert(!seen[1].args.includes("--quick"));
  for (const flag of ["--no-bal", "--replay-system-txes", "--disable-external-identification"]) assert(seen[1].args.includes(flag));
  for (const flag of ["--evm-version", "--prestate-tracer", "--debug-trace-transaction"]) assert(!seen[1].args.includes(flag));
  assert(!seen[1].args.some(arg => arg.includes("private-test-key") || arg.includes("rpc.invalid")));
  assert.equal(seen[1].options.env.ETH_RPC_URL, rpcUrl); assert.equal(seen[1].options.shell, false);
  assert.equal(seen[1].options.env.MUSEGOD_KEEPER_PRIVATE_KEY, undefined); assert.equal(seen[1].options.env.SUPABASE_SECRET_KEY, undefined);
  assert.deepEqual(Object.keys(seen[1].options.env).sort(), ["PATH", "LANG", "LC_ALL", "TMPDIR", "ETH_RPC_URL", "FOUNDRY_OFFLINE", "FOUNDRY_FFI", "FOUNDRY_DISABLE_NIGHTLY_WARNING"].sort());
  assert(!f.state.requests.some(method => method.startsWith("debug_")));
});
for (const kind of ["receipt", "reorg", "chain", "code"] as const) test(`a ${kind} change after local execution withholds the complete result`, async t => {
  let codeCalls = 0;
  const f = mockClient(ordinaryBase(), (method, _params, _count, after) => {
    if (!after) return;
    if (kind === "receipt" && method === "eth_getTransactionReceipt") { const r = ordinaryBase().receipt; r.gasUsed = "0x1"; return r; }
    if (kind === "reorg" && method === "eth_getBlockByNumber" && _params[0] === ordinaryBase().block.number) return { ...ordinaryBase().block, hash: `0x${"00".repeat(32)}` };
    if (kind === "chain" && method === "eth_chainId") return "0x1237";
    if (kind === "code" && method === "eth_getCode") { codeCalls++; return codeCalls > 10 ? "0x60026000" : "0x60016000"; }
  }); fakeEngine(t, f.state);
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }),
    error => error instanceof LocalReplayPendingError && ["noncanonical", "wrong_chain", "changed_code"].includes(error.code));
  assert(!f.state.requests.some(method => method.startsWith("debug_")));
});
test("a self-reported pinned version cannot bless different executable bytes", async t => {
  const f = mockClient(), seen = fakeEngine(t, f.state, { corruptSha: true });
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), isPending("unreviewed_engine"));
  assert.equal(seen.length, 0);
});
test("wrong pinned version remains pending without disclosure or fallback", async t => {
  const f = mockClient(); fakeEngine(t, f.state, { version: "cast Version: 9.0.0" });
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), isPending("unreviewed_engine"));
});
test("malformed engine JSON cannot reach the canonical receipt comparison", async t => {
  const f = mockClient(); fakeEngine(t, f.state, { rawText: "{bad-json" });
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), isPending("unsupported_arena"));
});
test("engine and RPC failures never expose provider URLs or signing information", async t => {
  const f = mockClient(); fakeEngine(t, f.state, { stderrFailure: true });
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), error =>
    error instanceof LocalReplayPendingError && error.code === "replay_failed" && !error.message.includes("private-test-key"));
  const unavailable = mockClient(ordinaryBase(), () => { throw new Error(`HTTP error ${rpcUrl}`); });
  await assert.rejects(replayBaseNativeTransaction(unavailable.client, hash, { chainId: 8453, rpcUrl }), error =>
    error instanceof LocalReplayPendingError && error.code === "rpc_unavailable" && !error.message.includes("private-test-key"));
});
test("oversized stdout terminates the process rather than retaining an unbounded trace", async t => {
  const f = mockClient(); fakeEngine(t, f.state, { rawText: "x".repeat(8 * 1024 * 1024 + 1) });
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), isPending("resource_limit"));
});
test("a reorg between the last code read and final anchor checks cannot return ready", async t => {
  let targetReads = 0;
  const f = mockClient(ordinaryBase(), (method, params, _count, after) => {
    if (after && method === "eth_getBlockByNumber" && params[0] === ordinaryBase().block.number && ++targetReads >= 2)
      return { ...ordinaryBase().block, hash: `0x${"00".repeat(32)}` };
  }); fakeEngine(t, f.state);
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" }), isPending("noncanonical"));
});
test("timeout releases the read: a later retry starts fresh and no unfinished subprocess is left", async t => {
  const f = mockClient(), engine = { stop: true }; const seen = fakeEngine(t, f.state, engine);
  await assert.rejects(replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast", timeoutMs: 40 }), isPending("timeout"));
  assert(seen.length <= 1); engine.stop = false;
  assert.equal((await replayBaseNativeTransaction(f.client, hash, { chainId: 8453, rpcUrl, castPath: "/synthetic/cast" })).metadata.fullReplay, true);
  assert(!f.state.requests.some(method => method.startsWith("debug_")));
});
