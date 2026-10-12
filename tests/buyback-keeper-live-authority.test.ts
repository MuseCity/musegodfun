import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import deployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { BUYBACK_FORWARDER_ALLOWANCE_CAP } from "../src/lib/buyback-engine";
import { ENGINE_FEE_POLICY } from "../src/lib/fee-policy";
const baseline=process.env.KEEPER_REVIEW_BASELINE_DIR;
async function fixture(t: TestContext, revokeAt: number, failure = "Current ERC1271/7702 governor authority revoked", pricing?: string) {
  const directory = await mkdtemp(join(tmpdir(), "rh-live-gate-")), cwd = process.cwd(), environment = process.env, oldExit = process.exitCode;
  const key = generatePrivateKey(), account = privateKeyToAccount(key), calls: string[] = [], output: any[] = [];
  let verifications = 0, walletBalance = 10n ** 18n;
  const contracts = deployment.contracts, constants = deployment.constants;
  const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, writesEnabled: false, signingPaused: true, blockReason: "Issuance paused independently", treasury: constants.treasury, feePolicy: ENGINE_FEE_POLICY, feeEngine: contracts.engine.address, buybackVault: contracts.vault.address, assetFeedOracle: contracts.assetOracle.address, buybackExecutor: contracts.executor.address, automationReceiver: constants.automation, automationTreasury: constants.automationTreasury, wethForwarder: contracts.forwarder.address };
  const status = { available: true, reason: null, blockNumber: "100", engine: config.feeEngine, vault: config.buybackVault, assetOracle: config.assetFeedOracle, swapper: contracts.swapper.address, executor: config.buybackExecutor, operationsTreasury: config.treasury, automationReceiver: config.automationReceiver, automationTreasury: config.automationTreasury, wethForwarder: config.wethForwarder, sourceDeployed: true, sourceWeth: "100", sourceAvailable: "100", sourceForwarded: "0", sourceAllowance: String(BUYBACK_FORWARDER_ALLOWANCE_CAP), assets: [], pools: [], swapperWeth: "0", vaultWeth: "0", vaultAvailable: "0", directBurned: "0", convertedWeth: "0", burns: [], burnScanFrom: "90" };
  if (pricing) {status.sourceWeth="0";status.sourceAvailable="0";status.vaultAvailable="10000000000000000";}
  const providerError=()=>Object.assign(new Error("RPC 429 pricing unavailable"),{code:429});
  const client = { simulateContract:async()=>{calls.push("simulate");if(pricing==="revert"||pricing==="mixed")throw Object.assign(new Error("Confirmed EVM revert"),{name:"ContractFunctionRevertedError"});if(pricing==="rpc")throw providerError();return{result:[1n,pricing==="unprofitable"?0n:10n]};},estimateContractGas:async()=>21000n,readContract:async()=>1n, chain: robinhood, getChainId: async () => 4663, call: async () => {}, estimateGas: async () => 21000n, getGasPrice: async () => { if(pricing==="mixed")throw providerError();return 10000n; }, getTransactionCount: async () => 7, getBalance: async () => { calls.push("balance"); return walletBalance; }, sendRawTransaction: async () => { calls.push("broadcast"); throw Error("The revoked authority must never reach transport"); } };
  const wallet = { signTransaction: async (input: any) => { calls.push("sign"); return account.signTransaction({ ...input, chainId: 4663 }); } };
  const graph = { engine: config.feeEngine, vault: config.buybackVault, oracle: contracts.oracle.address, blockNumber: 100n };
  process.chdir(directory); process.env = { PATH: environment.PATH, NODE_ENV: "test", ALCHEMY_API_KEY: "offline", MUSEGOD_KEEPER_PRIVATE_KEY: key };
  t.mock.method(globalThis, "fetch", async (url: any) => { const path = new URL(String(url)).pathname; calls.push(path); if (path.endsWith("/config")) return Response.json(config); if (path.endsWith("/buyback/engine")) return Response.json(status); throw Error("Offline fixture rejects every other endpoint"); });
  t.mock.method(console, "log", (raw: string) => output.push(JSON.parse(raw)));
  const id = `__rhFinancial${randomUUID().replaceAll("-", "")}`, entry = baseline ? pathToFileURL(join(baseline,"scripts/buyback-keeper.ts")) : new URL("../scripts/buyback-keeper.ts", import.meta.url); entry.searchParams.set("offline", id);
  const overrides: Record<string, Record<string, unknown>> = { viem: { createPublicClient: () => client, createWalletClient: () => wallet }, "../server/buyback-engine": { verifyFeeEngine: async (_client: any, candidate: any, _manifest: any, options: any) => { assert.equal(candidate, config.feeEngine); verifications++; if (verifications > 1) assert.equal(options?.fresh ?? true, true); if (verifications >= revokeAt) throw Error(failure); return graph; } } };
  Reflect.set(globalThis, id, overrides); const hooks = registerHooks({ resolve(specifier, context, next) { if (context.parentURL !== entry.href || !overrides[specifier]) return next(specifier, context); const original = specifier.startsWith(".") ? new URL(`${specifier}.ts`, entry).href : import.meta.resolve(specifier); return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(original)};\n${Object.keys(overrides[specifier]).map(name => `export const ${name}=globalThis[${JSON.stringify(id)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];`).join("\n")}`)}` }; } });
  t.after(async () => { hooks.deregister(); Reflect.deleteProperty(globalThis, id); process.chdir(cwd); process.env = environment; process.exitCode = oldExit; await rm(directory, { recursive: true, force: true }); });
  return { entry: await import(entry.href), directory, account, calls, output, config, verifications: () => verifications, setBalance:(value:bigint)=>{walletBalance=value;}, clearTasks:()=>{status.sourceWeth="0";status.sourceAvailable="0";status.vaultAvailable="0";} };
}
test("cached issuance-paused display config cannot authorize signing after current governor authority is revoked", async t => {
  const f = await fixture(t, 2); await f.entry.runKeeper(["--execute", "--once"]);
  assert.equal(f.verifications(), 2); assert.equal(f.calls.filter(call => call === "/api/config").length, 2); assert.equal(f.calls.includes("sign"), false); assert.equal(f.calls.includes("broadcast"), false); assert(f.output.some(row => /governor authority revoked/.test(row.reason)));
});
test("a transient fresh authority RPC failure is retryable before signing and identical cached config cannot substitute", async t => {
  const f = await fixture(t, 2, "RPC 429 current authority pending"); await f.entry.runKeeper(["--execute", "--once"]);
  assert.equal(f.verifications(), 2); assert.equal(f.calls.filter(call => call === "/api/config").length, 2);
  assert.equal(f.calls.includes("sign"), false); assert.equal(f.calls.includes("broadcast"), false);
  // No signature exists, so a read outage/authority change is a retryable task
  // decision rather than a new signed-transaction global barrier.
  assert(f.output.some(row => row.state === "skipped" && /RPC 429 current authority pending/.test(row.reason)));
  assert(!f.output.some(row => row.state === "signing_stopped"));
});

test("round11 RH-L1 corrupt and mismatched profitability schedules reset visibly while financial records stay strict",async t=>{
 const f=await fixture(t,Infinity),path=join(f.directory,"schedule.json"),empty={version:1,chainId:4663,caller:f.account.address,misses:0,nextAttemptAt:0,sizeCursor:0};
 for(const text of ["broken json",JSON.stringify({...empty,chainId:8453}),JSON.stringify({...empty,nextAttemptAt:-1})]){await writeFile(path,text);assert.deepEqual(await f.entry.readKeeperProfitState(path,4663,f.account.address),empty);}
 assert.equal(f.output.filter(row=>row.state==="profitability_state_reset").length,3);
 await writeFile(path,"broken financial json");await assert.rejects(f.entry.readKeeperJournal(path,4663,f.account.address),/malformed/);await assert.rejects(f.entry.readKeeperTaskState(path,4663,f.account.address),/malformed/);
});
for(const pricing of ["rpc","mixed"] as const)test(`round11 RH-L2 ${pricing} availability failure does not count as unprofitable or stop the process`,async t=>{
 const f=await fixture(t,Infinity,"",pricing);await f.entry.runKeeper(["--once"]);const path=join(f.directory,".cache/buyback-keeper",`4663-${f.account.address.toLowerCase()}.profit.json`);
 await assert.rejects(stat(path),/ENOENT/);assert(f.output.some(row=>row.state==="skipped"&&/RPC 429/.test(row.reason)));assert.equal(f.calls.filter(call=>call==="simulate").length,1);assert.equal(f.calls.includes("sign"),false);assert(f.output.some(row=>row.state==="keeper_rpc_metrics"));
});
for(const pricing of ["revert","unprofitable"] as const)test(`round11 RH-L2 genuine ${pricing} evidence records exactly one scheduling miss`,async t=>{
 const f=await fixture(t,Infinity,"",pricing);await f.entry.runKeeper(["--once"]);const path=join(f.directory,".cache/buyback-keeper",`4663-${f.account.address.toLowerCase()}.profit.json`);assert.equal(JSON.parse(await readFile(path,"utf8")).misses,1);assert.equal(f.calls.filter(call=>call==="simulate").length,3);assert.equal(f.calls.includes("sign"),false);
});

test("a genuine financial journal/lock failure emits final round metrics and manual exit 78 without resetting finance",async t=>{
 const f=await fixture(t,Infinity),directory=join(f.directory,".cache/buyback-keeper"),path=join(directory,`4663-${f.account.address.toLowerCase()}.json`);
 await (await import("node:fs/promises")).mkdir(directory,{recursive:true});await writeFile(`${path}.lock`,"retained manual lock");await f.entry.runKeeper(["--execute","--once"]);
 assert.equal(process.exitCode,78);assert(f.output.some(row=>row.state==="signing_stopped"));assert(f.output.some(row=>row.state==="keeper_rpc_metrics"));assert.equal(await readFile(`${path}.lock`,"utf8"),"retained manual lock");assert.equal(f.calls.includes("sign"),false);assert.equal(f.calls.includes("broadcast"),false);
});

test("round12 RH low balance is written to stdout and alerts while the existing funding gate still defers",async t=>{
  const f=await fixture(t,Infinity);f.setBalance(1n);
  await f.entry.runKeeper(["--execute","--once"]);
  const alert=f.output.find(row=>row.state==="keeper_balance_low");assert(alert);
  assert.equal(alert.chainId,4663);assert.equal(alert.balanceWei,"1");
  assert.equal(BigInt(alert.thresholdWei),3n*BigInt(alert.typicalReservationWei));
  const path=join(f.directory,".cache/buyback-keeper",`4663-${f.account.address.toLowerCase()}.alerts.jsonl`);
  assert.equal(JSON.parse((await readFile(path,"utf8")).trim()).state,"keeper_balance_low");
  assert.equal(f.calls.filter(call=>call==="balance").length,1,"Reuse the existing financial balance read");
  assert.equal(f.calls.includes("sign"),false);assert.equal(f.calls.includes("broadcast"),false);
  assert(f.output.some(row=>row.state==="skipped"&&/insufficient gas funds/.test(row.reason)));
});

test("round12 RH idle dry-run reuses its measured gas reserve for a balance alert without signing",async t=>{
  const f=await fixture(t,Infinity);await f.entry.runKeeper(["--once"]);
  f.setBalance(1n);f.clearTasks();await f.entry.runKeeper(["--once"]);
  const alert=f.output.find(row=>row.state==="keeper_balance_low");assert(alert);
  assert.equal(alert.keeper.toLowerCase(),f.account.address.toLowerCase());
  assert(f.output.some(row=>row.mode==="dry_run"&&row.tasks===0));
  assert.equal(f.calls.filter(call=>call==="balance").length,2,"One monitored balance per round, even without a current task");
  assert.equal(f.calls.includes("sign"),false);assert.equal(f.calls.includes("broadcast"),false);
});
