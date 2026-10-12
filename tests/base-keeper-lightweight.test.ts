import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, open as fsOpen, appendFile as fsAppend } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction, type Address, type Hex } from "viem";
import { BASE_COLLECTOR_MANIFEST } from "../server/base-collector";
import { BASE_RECOVERY_FIXED_ASSETS } from "../server/base-buyback";
import { BASE_BUYBACK_WETH, baseCollectorAbi, type BaseFeeBatch } from "../src/lib/base-buyback";
import { STOCKS, type TokenRecord } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { baseKeeperPolicies, baseClaimCoversGas, baseClaimValueWeth, readBaseKeeperFeeRound, sortBaseKeeperTasks, assertBaseNoUnknown, updateBaseStuckMonitor, BASE_STUCK_MONITOR_INTERVAL_MS, BASE_STUCK_AFTER_MS } from "../scripts/base-buyback-keeper";
const collector: Address = "0x1111111111111111111111111111111111111111", automation = "0x2222222222222222222222222222222222222222", hash = `0x${"cd".repeat(32)}` as Hex;
function token(index: number): TokenRecord { return { mode: "base", deploymentChainId: 8453, feePolicy: BASE_AUTOMATION_FEE_POLICY, feeEngine: collector, address: `0x${(index + 100).toString(16).padStart(40,"0")}`, quoteAddress: STOCKS[0].address, symbol: "MEME", poolId: `0x${index.toString(16).padStart(64,"0")}`, transactionHash: hash, blockNumber: "5" } as unknown as TokenRecord; }
test("quiet fee round is bounded, fair and does not create zero-fee registration tasks or valuations", async () => {
  const tokens = Array.from({ length: 8 }, (_, index) => token(index)), seen: string[] = []; let calls = 0;
  const reader = { status: async () => { calls++; return { available: true } as any; } }, preview = async (row: TokenRecord) => { seen.push(row.address); return 0n; };
  let cursor = 0;
  for (let round = 0; round < 4; round++) { const result = await readBaseKeeperFeeRound(reader, tokens, collector, cursor, preview); assert.deepEqual(result.claims, []); assert.deepEqual(result.failures, []); cursor = result.poolCursor; }
  assert.equal(calls, 4); assert.equal(seen.length, 8); assert.deepEqual(new Set(seen), new Set(tokens.map(token => token.address)));
  const dirty = [...tokens, { ...token(99), transactionHash: null } as any, { ...token(98), mode: "robinhood" } as any];
  assert.equal(baseKeeperPolicies(dirty, collector).length, BASE_RECOVERY_FIXED_ASSETS.length + tokens.length);
});
test("one pool preview failure remains retryable and other positive genuine fees continue", async () => {
  const tokens = [token(1), token(2), token(3)], calls: string[] = [];
  const result = await readBaseKeeperFeeRound({ status: async () => ({ available: true }) as any }, tokens, collector, 0, async row => { calls.push(row.address); if (row === tokens[0]) throw Error("429"); return row === tokens[1] ? 1n : 0n; });
  assert.equal(result.failures.length, 1); assert.equal(result.claims.length, 1); assert.equal(result.claims[0].token, tokens[1]); assert.equal(calls.length, 2);
});
test("release precedes new claim and claim must strictly exceed complete gas reserve", () => {
  const tasks = ["claim", "sync_untracked", "release", "release_untracked"].map(kind => ({ kind })) as BaseFeeBatch[];
  assert.deepEqual(sortBaseKeeperTasks(tasks).map(task => task.kind), ["release", "release_untracked", "claim", "sync_untracked"]);
  const reservation = { totalWei: "100" } as any; assert.equal(baseClaimCoversGas(100n, reservation), false); assert.equal(baseClaimCoversGas(101n, reservation), true); assert.equal(baseClaimCoversGas(0n, reservation), false);
});
test("claim valuation uses WETH raw units or exact conservative same-chain B20 quote and never quotes zero/meme fees", async () => {
  let quotes = 0, now = 1000; const stock = STOCKS[0], action = { fromChainId: 8453, toChainId: 8453, fromAddress: automation, toAddress: automation, fromAmount: "100", fromToken: { ...stock, chainId: 8453 }, toToken: { address: BASE_BUYBACK_WETH, chainId: 8453, decimals: 18 } }, estimate = { fromAmount: "100", toAmount: "200", toAmountMin: "199" };
  const reader = { integrator: "musegodfun", pricingRequest: async (path: string, params: URLSearchParams) => { quotes++; assert.equal(path, "quote"); assert.equal(params.get("fromAmount"), "100"); assert.equal(params.get("allowBridges"), "none"); return { action, estimate }; } } as any;
  assert.equal(await baseClaimValueWeth(reader, stock, 0n, automation), 0n); assert.equal(await baseClaimValueWeth(reader, { address: BASE_BUYBACK_WETH } as any, 123n, automation), 123n); assert.equal(quotes, 0);
  assert.equal(await baseClaimValueWeth(reader, stock, 100n, automation, () => now), 199n); assert.equal(quotes, 1);
  for (const change of [{ toChainId: 4663 }, { fromAmount: "101" }, { toAddress: collector }]) { const bad = { ...reader, pricingRequest: async () => ({ action: { ...action, ...change }, estimate }) }; await assert.rejects(baseClaimValueWeth(bad, stock, 100n, automation), /changed/); }
  await assert.rejects(baseClaimValueWeth(reader, { address: collector, decimals: 18 } as any, 1n, automation), /unavailable/);
  const old = { ...reader, pricingRequest: async () => { now += 60000; return { action, estimate }; } }; await assert.rejects(baseClaimValueWeth(old, stock, 100n, automation, () => now), /freshness/);
});
test("15-minute amount monitor alerts once after a full stuck duration, survives restart and never moves funds", () => {
  const initial = { version: 1 as const, collector, lastReadAt: 0, poolCursor: 0, balances: {} }, readings = [{ key: "8453:automation:asset", amount: "100", threshold: "100" }];
  let result = updateBaseStuckMonitor(initial, readings, 1); assert.deepEqual(result.alerts, []);
  result = updateBaseStuckMonitor(JSON.parse(JSON.stringify(result.state)), readings, BASE_STUCK_AFTER_MS); assert.deepEqual(result.alerts, []);
  result = updateBaseStuckMonitor(result.state, readings, BASE_STUCK_AFTER_MS + 1); assert.equal(result.alerts.length, 1);
  assert.deepEqual(updateBaseStuckMonitor(JSON.parse(JSON.stringify(result.state)), readings, BASE_STUCK_AFTER_MS + BASE_STUCK_MONITOR_INTERVAL_MS).alerts, []);
  result = updateBaseStuckMonitor(result.state, [{ ...readings[0], amount: "99" }], BASE_STUCK_AFTER_MS + 2); assert.deepEqual(result.state.balances, {});
  awaitUnused(); function awaitUnused() { assert.equal(result.state.poolCursor, 0); }
});
const baseline = process.env.KEEPER_REVIEW_BASELINE_DIR;
async function mainFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "light-base-main-")), environment = process.env, original = structuredClone(BASE_COLLECTOR_MANIFEST);
  const key = generatePrivateKey(), keeper = privateKeyToAccount(key), calls: string[] = [], outputs: any[] = [], rows = new Map<string, BaseFeeBatch>(), transactions = new Map<string, any>();
  let failObservations = false, failAlerts = false, nonce = 7, afterSign: (() => void) | undefined;
  let paused = false, failAuthority = false, balance = 10n ** 18n, startup = true, statusReads = 0, stopAfter = Infinity;
  const graph = { collector, automationReceiver: automation, paused: false, runtimeHash: hash }, assets = STOCKS.slice(0, 2).map(stock => ({ ...stock, chainId: 8453, pending: "100", untracked: "0", pendingUntracked: "0", totalClaimed: "100", totalReleased: "0", automationBalance: "0", verifiedAsset: true }));
  const client = { getChainId: async () => 8453, getBlockNumber: async () => 100n, getBlock: async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 100n, hash }), getTransactionCount: async () => nonce, call: async () => {}, estimateGas: async () => 80000n, estimateFeesPerGas: async () => ({ maxFeePerGas: 100n }), getBalance: async () => balance,
    readContract: async ({ functionName }: any) => functionName === "verifiedAssets" ? true : 1000n,
    getTransaction: async ({ hash: id }: any) => transactions.get(id), getTransactionReceipt: async ({ hash: id }: any) => { const tx = transactions.get(id), asset = assets.find(row => tx.input.toLowerCase().includes(row.address.slice(2).toLowerCase()))!; return { transactionHash: id, from: keeper.address, status: "success", blockHash: hash, blockNumber: 99n, gasUsed: 21000n, effectiveGasPrice: 100n, logs: [{ address: collector, data: encodeAbiParameters([{ type: "uint256" }], [100n]), topics: encodeEventTopics({ abi: baseCollectorAbi, eventName: "FeesReleased", args: { token: asset.address, receiver: automation } }) }, { address: asset.address, data: encodeAbiParameters([{ type: "uint256" }], [100n]), topics: [`0x${"ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"}`, `0x${collector.slice(2).padStart(64, "0")}`, `0x${automation.slice(2).padStart(64, "0")}`] }] }; },
    request: async ({ params }: any) => ({ transactionHash: params[0], blockHash: hash, blockNumber: "0x63", gasUsed: "0x5208", effectiveGasPrice: "0x64", l1Fee: "0x3e8" }), waitForTransactionReceipt: async () => {} };
  const source = { close: async () => {}, runtimeControl: async () => ({ paused, revision: 1 }), tokens: async () => [], buybackBatchPage: async () => [...rows.values()].map((row, index) => ({ ...row, sequence: String(index + 1) })), saveBuybackBatch: async (row: BaseFeeBatch) => { rows.set(row.id, row); } };
  const wallet = { signTransaction: async (input: any) => { calls.push("sign"); const raw = await keeper.signTransaction({ ...input, chainId: 8453 }); afterSign?.(); return raw; }, sendRawTransaction: async ({ serializedTransaction: raw }: any) => { calls.push("broadcast"); const tx = parseTransaction(raw), id = keccak256(raw); nonce++; transactions.set(id, { hash: id, type: "eip1559", from: keeper.address, to: tx.to, nonce: tx.nonce, input: tx.data, value: 0n }); return id; } };
  BASE_COLLECTOR_MANIFEST.collector.address = collector; BASE_COLLECTOR_MANIFEST.status = "deployed_verified"; BASE_COLLECTOR_MANIFEST.activation = { status: "trusted_splits_authorized", trustedSplitsAcceptance: { keeper: keeper.address } as any };
  process.env = { PATH: environment.PATH, HOME: directory, NODE_ENV: "test", DATA_DIR: directory, ALCHEMY_API_KEY: "offline", BASE_FEE_COLLECTOR_ADDRESS: collector, ENABLE_BASE_TRANSACTIONS: "true", BASE_PLATFORM_TREASURY: original.constants.operationsTreasury!, SUPABASE_URL: "https://offline.invalid", SUPABASE_SECRET_KEY: "offline", MUSEGOD_KEEPER_PRIVATE_KEY: key };
  t.mock.method(globalThis, "fetch", async () => { throw Error("No external request is permitted"); }); t.mock.method(console, "log", (raw: string) => outputs.push(JSON.parse(raw)));
  const id = `__light${randomUUID().replaceAll("-", "")}`, entry = baseline ? pathToFileURL(join(baseline, "scripts/base-buyback-keeper.ts")) : new URL("../scripts/base-buyback-keeper.ts", import.meta.url); entry.searchParams.set("offline", id);
  const overrides: Record<string, Record<string, unknown>> = {
    "node:fs/promises": { open: async (path: any, ...args: any[]) => { if (failAlerts && String(path).endsWith("base-keeper-alerts.jsonl")) throw Error("Alert append failed"); if (failObservations && String(path).includes("base-keeper-observations.json.")) throw Error("Schedule write unavailable"); return (fsOpen as any)(path, ...args); }, appendFile: async (path: any, ...args: any[]) => { if (failAlerts && String(path).endsWith("base-keeper-alerts.jsonl")) throw Error("Alert append failed"); return (fsAppend as any)(path, ...args); } },
    viem: { createPublicClient: ({ chain }: any) => chain.id === 8453 ? client : { readContract: async () => 0n }, createWalletClient: () => wallet },
    "node:os": { homedir: () => directory }, "../server/config": { loadEnvironment: () => {} },
    "../server/supabase-store": { SupabaseStore: class { constructor() { return source; } } },
    "../server/base-collector": { BASE_COLLECTOR_MANIFEST, verifyBaseCollectorForKeeperStartup: async () => { calls.push("startup"); if (!startup) throw Error("One-time record pending"); return graph; }, assertBaseKeeperLiveAuthority: async () => { calls.push("live"); if (failAuthority) throw Error("Live owner revoked"); } },
    "../server/base-buyback": { BaseFeeQuoteReader: class { constructor() {} async status() { if (++statusReads >= stopAfter) process.emit("SIGTERM"); return { available: true, assetsComplete: true, paused: false, assets, automation }; } } },
  };
  Reflect.set(globalThis, id, overrides); const hooks = registerHooks({ resolve(specifier, context, next) { if (context.parentURL !== entry.href || !overrides[specifier]) return next(specifier, context); const original = specifier.startsWith(".") ? new URL(`${specifier}.ts`, entry).href : import.meta.resolve(specifier); return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(original)};\n${Object.keys(overrides[specifier]).map(name => `export const ${name}=globalThis[${JSON.stringify(id)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];`).join("\n")}`)}` }; } });
  t.after(async () => { hooks.deregister(); Reflect.deleteProperty(globalThis, id); process.env = environment; Object.assign(BASE_COLLECTOR_MANIFEST, original); await rm(directory, { recursive: true, force: true }); });
  return { entry: await import(entry.href), directory, outputs, calls, rows, assets, keeper, setObservationFailure: (value: boolean) => { failObservations = value; }, setAlertFailure: (value: boolean) => { failAlerts = value; }, afterSign: (callback: () => void) => { afterSign = callback; }, setPaused: (value: boolean) => { paused = value; }, setAuthority: (value: boolean) => { failAuthority = !value; }, setBalance: (value: bigint) => { balance = value; }, setStartup: (value: boolean) => { startup = value; }, stopAfter: (count: number) => { stopAfter = count; } };
}
for (const failure of ["pause", "authority", "balance", "gas"] as const) test(`real lightweight main loop defers ${failure} without exiting or blocking the next task`, async t => {
  const f = await mainFixture(t); if (failure === "pause") f.setPaused(true); if (failure === "authority") f.setAuthority(false); if (failure === "balance") f.setBalance(0n);
  await f.entry.runBaseBuybackKeeper(["--execute", "--once", `--operator-dir=${f.directory}`, `--max-gas-wei=${failure === "gas" ? "1" : "16000000000000"}`]);
  assert.equal(f.calls.filter(call => call === "sign").length, 0); assert.equal(f.calls.filter(call => call === "broadcast").length, 0); assert.equal(f.outputs.filter(row => row.state === "signing_deferred" && row.taskId).length, 2); assert.equal(f.calls.filter(call => call === "startup").length, 1);
});
test("audit-only main loop never creates a wallet and missing startup remains retryable without fee signing", async t => {
  const f = await mainFixture(t); f.setStartup(false); await f.entry.runBaseBuybackKeeper(["--audit-only", "--once", `--operator-dir=${f.directory}`]); assert(f.outputs.some(row => row.state === "signing_deferred")); assert.equal(f.calls.includes("sign"), false); assert.equal(f.calls.includes("live"), false);
});

test("an ongoing audit-only process reuses startup verification on the next retry round", async t => {
  const f = await mainFixture(t); f.stopAfter(2);
  const ordinaryTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((done: () => void, delay: number, ...args: any[]) => { if (delay === 300_000) { queueMicrotask(done); return 1; } return ordinaryTimeout(done, delay, ...args); }) as any);
  await f.entry.runBaseBuybackKeeper(["--audit-only", `--operator-dir=${f.directory}`]);
  assert.equal(f.calls.filter(call => call === "startup").length, 1); assert.equal(f.outputs.filter(row => row.mode === "audit_only" && row.startupVerified).length, 2); assert.equal(f.calls.includes("sign"), false);
});

test("live authority revoked after signing safely abandons before transport and does not fabricate an unknown source spend", async t => {
  const f = await mainFixture(t); f.afterSign(() => f.setAuthority(false));
  await f.entry.runBaseBuybackKeeper(["--execute", "--once", `--operator-dir=${f.directory}`, "--max-gas-wei=16000000000000"]);
  assert.equal(f.calls.filter(call => call === "sign").length, 1, JSON.stringify(f.outputs)); assert.equal(f.calls.includes("broadcast"), false);
  const retained = [...f.rows.values()]; assert.equal(retained.length, 1, JSON.stringify(f.outputs)); assert.equal(retained[0].status, "abandoned"); assert.equal(retained[0].abandonedBeforeBroadcast, true); assert.doesNotThrow(() => assertBaseNoUnknown(retained, f.keeper.address));
  assert.equal(f.outputs.filter(row => row.state === "signing_deferred" && row.taskId).length, 2);
});
test("default zero unknown cap leaves unregistered donations pending and never manufactures a registration claim", async t => {
  const f = await mainFixture(t); for (const row of f.assets) { row.pending = "0"; row.untracked = "100000000"; row.verifiedAsset = false; }
  await f.entry.runBaseBuybackKeeper(["--execute", "--once", `--operator-dir=${f.directory}`, "--max-gas-wei=16000000000000"]);
  assert.equal(f.calls.includes("sign"), false); assert.equal(f.calls.includes("live"), false); assert.deepEqual(f.outputs.find(row => row.mode === "execute" && row.startupVerified).tasks, []);
});

test("successful lightweight tasks keep exact durable hashes, distinct nonces, live gates and actual canonical gas without any custody service", async t => {
  const f = await mainFixture(t);
  await f.entry.runBaseBuybackKeeper(["--execute", "--once", `--operator-dir=${f.directory}`, "--max-gas-wei=16000000000000"]);
  assert.equal(f.calls.filter(call => call === "sign").length, 2); assert.equal(f.calls.filter(call => call === "broadcast").length, 2); assert.equal(f.calls.filter(call => call === "live").length, 4);
  const retained = [...f.rows.values()]; assert.deepEqual(retained.map(row => row.journal!.nonce), [7, 8]); assert(retained.every(row => row.status === "released" && row.sourceHash && row.actualGas?.totalWei)); assert(retained.every(row => !Object.hasOwn(row.inputAsset!, "minimumRaw"))); assert.doesNotThrow(() => assertBaseNoUnknown(retained, f.keeper.address));
});

test("a live permission failure defers one round and the same executing daemon still reaches its next five-minute round", async t => {
  const f = await mainFixture(t); f.setAuthority(false); f.stopAfter(2);
  const ordinaryTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((done: () => void, delay: number, ...args: any[]) => { if (delay === 300_000) { queueMicrotask(done); return 1; } return ordinaryTimeout(done, delay, ...args); }) as any);
  await f.entry.runBaseBuybackKeeper(["--execute", `--operator-dir=${f.directory}`, "--max-gas-wei=16000000000000"]);
  assert.equal(f.calls.filter(call => call === "startup").length, 1); assert.equal(f.outputs.filter(row => row.mode === "execute" && row.startupVerified).length, 2); assert.equal(f.outputs.filter(row => row.state === "signing_deferred" && row.taskId).length, 2); assert.equal(f.calls.includes("sign"), false); assert.equal(f.calls.includes("broadcast"), false);
});

test("round11 B-F1 alert append failure retains the unsent episode and retry publishes stdout before recording success", async t => {
  const f = await mainFixture(t), asset = f.assets[0], key = `8453:automation:${asset.address.toLowerCase()}`, now = Date.now();
  asset.automationBalance = BASE_RECOVERY_FIXED_ASSETS.find(row => row.address.toLowerCase() === asset.address.toLowerCase())!.minimumRaw;
  const path = join(f.directory, "base-keeper-observations.json");
  await writeFile(path, JSON.stringify({version:1,collector,lastReadAt:0,poolCursor:0,balances:{[key]:{amount:asset.automationBalance,overSince:now-BASE_STUCK_AFTER_MS-1000}}}), {mode:0o600});
  f.setAlertFailure(true); await f.entry.runBaseBuybackKeeper(["--audit-only","--once",`--operator-dir=${f.directory}`]);
  assert.equal(JSON.parse(await readFile(path,"utf8")).balances[key].alertedAt,undefined);
  f.setAlertFailure(false); await f.entry.runBaseBuybackKeeper(["--audit-only","--once",`--operator-dir=${f.directory}`]);
  assert(f.outputs.some(row=>row.state==="funds_stuck"&&row.key===key));assert.equal((await readFile(join(f.directory,"base-keeper-alerts.jsonl"),"utf8")).trim().split("\n").length,1);assert(Number.isSafeInteger(JSON.parse(await readFile(path,"utf8")).balances[key].alertedAt));
});
test("round11 B-F2 startup failures back off exponentially across idle rounds and restart without any signing", async t => {
  const f = await mainFixture(t);f.setStartup(false);let clock=1_000_000,waits=0;const ordinary=globalThis.setTimeout;
  t.mock.method(Date,"now",()=>clock);t.mock.method(globalThis,"setTimeout",((done:()=>void,delay:number,...args:any[])=>{if(delay===300_000){clock+=delay;if(++waits===5)process.emit("SIGTERM");queueMicrotask(done);return 1;}return ordinary(done,delay,...args);}) as any);
  await f.entry.runBaseBuybackKeeper(["--audit-only",`--operator-dir=${f.directory}`]);assert.equal(f.calls.filter(call=>call==="startup").length,3);
  const state=JSON.parse(await readFile(join(f.directory,"base-keeper-observations.json"),"utf8"));assert.equal(state.startupRetry.failures,3);assert.equal(state.startupRetry.nextAttemptAt,3_100_000);
  await f.entry.runBaseBuybackKeeper(["--audit-only","--once",`--operator-dir=${f.directory}`]);assert.equal(f.calls.filter(call=>call==="startup").length,3);assert.equal(f.calls.includes("sign"),false);assert.equal(f.calls.includes("live"),false);
  if (!baseline) {let retry;for(let index=0;index<12;index++)retry=f.entry.baseStartupRetry(retry,clock);assert.equal(retry.nextAttemptAt-clock,3_600_000);}
});

test("round11 B-F2 scheduling IO failure after successful verification cannot strand the steady reader",async t=>{
 const f=await mainFixture(t);await writeFile(join(f.directory,"base-keeper-observations.json"),JSON.stringify({version:1,collector,lastReadAt:0,poolCursor:0,balances:{},startupRetry:{failures:1,nextAttemptAt:0}}));f.setObservationFailure(true);
 let waits=0;const ordinary=globalThis.setTimeout;t.mock.method(globalThis,"setTimeout",((done:()=>void,delay:number,...args:any[])=>{if(delay===300_000){if(++waits===2)process.emit("SIGTERM");queueMicrotask(done);return 1;}return ordinary(done,delay,...args);}) as any);
 await f.entry.runBaseBuybackKeeper(["--audit-only",`--operator-dir=${f.directory}`]);assert.equal(f.calls.filter(call=>call==="startup").length,1);assert.equal(f.outputs.filter(row=>row.startupVerified===true).length,2);assert(f.outputs.some(row=>row.mode==="startup_schedule_pending"));
});
