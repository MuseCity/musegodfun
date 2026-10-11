import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, parseAbiParameters } from "viem";
import type { BuildInfo } from "../src/lib/build-info";
import { assertBuildManifest, assertCandidateRuntimeBindings, assertFrozenBuild, assertLaunchRuntime, assertReleaseCheckout, publishCandidate, ReleaseFailure, requireSingleActiveVersion, runtimeVarsFromBindings, sha256, snapshotBuild, type ReleaseLifecycle } from "../scripts/release-policy";
import { FEE_POLICY, ENGINE_FEE_POLICY, BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { checkRuntime, checkFunctionalSmoke, baseRollbackCompatible, pristineBaseCollector, basePristineAuditStore, supportsBaseRecovery, type BasePristineAudit } from "../scripts/release";
import { BASE_COLLECTOR_MANIFEST, BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH, BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH, BASE_SPLITS_PROXY_HASH, type BaseCollectorManifest } from "../server/base-collector";
import { readBaseAudit } from "../server/base-audit";
import { BASE_BUYBACK_WETH, BASE_NATIVE_DESTINATION_POLICY } from "../src/lib/base-buyback";
import { Store } from "../server/store";

const commit = "a".repeat(40), newerCommit = "b".repeat(40);
const previousVersion = "11111111-1111-4111-8111-111111111111", candidateVersion = "22222222-2222-4222-8222-222222222222";

function lifecycle() {
  const events: string[] = [], statuses: { state: string; description: string }[] = [];
  let active = previousVersion;
  const flow: ReleaseLifecycle = {
    commit, previousVersion,
    currentMaster: async () => { events.push("master"); return commit; },
    activeVersion: async () => { events.push(`active:${active}`); return active; },
    assertFrozen: () => { events.push("frozen"); },
    upload: async () => { events.push("upload"); return candidateVersion; },
    publishRelease: async () => { events.push("publish"); },
    createDeployment: async () => { events.push("deployment"); },
    status: async (state, description) => { events.push(`status:${state}`); statuses.push({ state, description }); },
    activate: async version => { events.push(`activate:${version}`); active = version; },
    verify: async () => { events.push("verify"); },
    verifyRollback: async () => { events.push("rollback-check"); },
  };
  return { flow, events, statuses, getActive: () => active, setActive: (value: string) => { active = value; } };
}

test("release checkout rejects dirty or non-event source", () => {
  assert.doesNotThrow(() => assertReleaseCheckout(commit, commit, ""));
  assert.throws(() => assertReleaseCheckout(commit, commit, " M src/App.tsx\n"), /clean/);
  assert.throws(() => assertReleaseCheckout(commit, newerCommit, ""), /event commit/);
  assert.throws(() => assertReleaseCheckout(commit.slice(0, 7), commit, ""), /full event commit/);
});

test("rollback keeps previous runtime expectations and excludes secret bindings", () => {
  const vars = { CHAIN_MODE: "robinhood", ENABLE_MAINNET_TRANSACTIONS: "true" };
  const bindings = Object.entries(vars).map(([name, text]) => ({ name, text, type: "plain_text" }));
  assert.deepEqual(runtimeVarsFromBindings([...bindings, { name: "TOKEN", type: "secret_text", text: "" }]), vars);
  const candidateVars = { ...vars, ENABLE_MAINNET_TRANSACTIONS: "false" };
  assert.notDeepEqual(runtimeVarsFromBindings(bindings), candidateVars, "Rollback must retain old expectations when candidate vars changed");
  assert.throws(() => runtimeVarsFromBindings([{ name: "CHAIN_MODE", type: "plain_text" }]), /Cannot inspect/);
});

test("publication verifies the curve and configured guard, while legacy rollback remains available", () => {
  const guard = "0x1111111111111111111111111111111111111111";
  assertLaunchRuntime({ curvePolicy: CURVE_POLICY, launchGuard: guard }, { LAUNCH_GUARD_ADDRESS: guard });
  assertLaunchRuntime({ curvePolicy: CURVE_POLICY, launchGuard: null }, {});
  for (const runtime of [{ curvePolicy: CURVE_POLICY, launchGuard: null },
    { curvePolicy: CURVE_POLICY, launchGuard: "0x2222222222222222222222222222222222222222" },
    { curvePolicy: "old", launchGuard: guard }, {}])
    assert.throws(() => assertLaunchRuntime(runtime, { LAUNCH_GUARD_ADDRESS: guard }), /does not match/);
  assert.throws(() => assertLaunchRuntime({ curvePolicy: CURVE_POLICY }, {}), /does not match/);
  assertLaunchRuntime({}, {}, false);
  assert.throws(() => assertLaunchRuntime({}, { LAUNCH_GUARD_ADDRESS: guard }, false), /does not match/);
});

test("guard selection isolates Base and requires vesting only for the selected first-buy candidate", () => {
  const legacy = "0x1111111111111111111111111111111111111111", vesting = "0x2222222222222222222222222222222222222222";
  const vars = { LAUNCH_GUARD_ADDRESS: legacy, FIRST_BUY_GUARD_ADDRESS: vesting };
  const current = { curvePolicy: CURVE_POLICY, launchGuard: vesting, launchLockAvailable: true };
  assertLaunchRuntime(current, vars);
  assert.throws(() => assertLaunchRuntime({ ...current, launchLockAvailable: false }, vars), /does not match/);
  assert.throws(() => assertLaunchRuntime({ ...current, launchGuard: legacy }, vars), /does not match/);
  assertLaunchRuntime({ curvePolicy: CURVE_POLICY, launchGuard: null, launchLockAvailable: false }, vars, true, 8453);
  assert.throws(() => assertLaunchRuntime(current, vars, true, 8453), /does not match/);
  assertLaunchRuntime(current, { BASE_FIRST_BUY_GUARD_ADDRESS: vesting }, true, 8453);
  assert.throws(() => assertLaunchRuntime({ ...current, launchLockAvailable: false }, { BASE_FIRST_BUY_GUARD_ADDRESS: vesting }, true, 8453), /does not match/);
  // An explicit empty override suppresses the generic candidate as in runtimeFromEnv.
  assertLaunchRuntime({ curvePolicy: CURVE_POLICY, launchGuard: legacy, launchLockAvailable: false },
    { ...vars, ROBINHOOD_FIRST_BUY_GUARD_ADDRESS: "" });
  assertLaunchRuntime({ curvePolicy: CURVE_POLICY, launchGuard: vesting, launchLockAvailable: false },
    { ...vars, ROBINHOOD_FIRST_BUY_GUARD_ADDRESS: "", ROBINHOOD_LAUNCH_GUARD_ADDRESS: vesting });
});

const releaseOrigin = "https://release-runtime.test";
const runtimeVars = { PLATFORM_TREASURY: "0x1111111111111111111111111111111111111111", ENABLE_MAINNET_TRANSACTIONS: "true",
  LAUNCH_GUARD_ADDRESS: "0x2222222222222222222222222222222222222222" };
function runtimeResponses() {
  const rh = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: runtimeVars.PLATFORM_TREASURY,
    writesEnabled: true, curvePolicy: CURVE_POLICY, launchGuard: runtimeVars.LAUNCH_GUARD_ADDRESS, launchLockAvailable: false };
  const base = { mode: "base", chainId: 8453, deploymentChainId: 8453, treasury: runtimeVars.PLATFORM_TREASURY,
    writesEnabled: false, curvePolicy: CURVE_POLICY, launchGuard: null, launchLockAvailable: false };
  return {
    "/readyz": { status: "ready", chainId: 4663, writesEnabled: true }, "/api/config": rh,
    "/api/chains/4663/readyz": { status: "ready", chainId: 4663, writesEnabled: true }, "/api/chains/4663/config": rh,
    "/api/chains/8453/readyz": { status: "ready", chainId: 8453, writesEnabled: false }, "/api/chains/8453/config": base,
  };
}

test("candidate publication checks both scoped read-only runtimes and retains the legacy Robinhood ingress", async (context) => {
  const responses = runtimeResponses(), paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const target = new URL(url); assert.equal(target.origin, releaseOrigin); assert.equal(init?.method, undefined);
    paths.push(target.pathname); assert(target.pathname in responses, "No quote, transaction or unrelated request is allowed");
    return Response.json(responses[target.pathname as keyof typeof responses]);
  });
  await checkRuntime(releaseOrigin, { vars: runtimeVars });
  assert.deepEqual(paths, Object.keys(responses));
  const base = responses["/api/chains/8453/config"];
  base.writesEnabled = true;
  await assert.rejects(() => checkRuntime(releaseOrigin, { vars: runtimeVars }), /configuration check failed.*8453/);
  base.writesEnabled = false;
  responses["/api/chains/8453/readyz"].status = "unavailable";
  await assert.rejects(() => checkRuntime(releaseOrigin, { vars: runtimeVars }), /configuration check failed.*8453/);
  responses["/api/chains/8453/readyz"].status = "ready";
  base.chainId = 4663;
  await assert.rejects(() => checkRuntime(releaseOrigin, { vars: runtimeVars }), /configuration check failed.*8453/);
});

test("release runtime checks respect per-chain treasury and Robinhood signing overrides", async (context) => {
  const responses = runtimeResponses(), rhTreasury = "0x3333333333333333333333333333333333333333", baseTreasury = "0x4444444444444444444444444444444444444444";
  responses["/api/config"].treasury = rhTreasury; responses["/api/config"].writesEnabled = false;
  responses["/readyz"].writesEnabled = false; responses["/api/chains/4663/readyz"].writesEnabled = false;
  responses["/api/chains/8453/config"].treasury = baseTreasury;
  context.mock.method(globalThis, "fetch", async (url: string) => Response.json(responses[new URL(url).pathname as keyof typeof responses]));
  const vars = { ...runtimeVars, ROBINHOOD_PLATFORM_TREASURY: rhTreasury, BASE_PLATFORM_TREASURY: baseTreasury,
    ENABLE_ROBINHOOD_TRANSACTIONS: "false" };
  await checkRuntime(releaseOrigin, { vars });
  await assert.rejects(() => checkRuntime(releaseOrigin, { vars: runtimeVars }), /configuration check failed.*4663/);
});

test("older rollback checks only legacy Robinhood endpoints and does not require scoped or lock capabilities", async (context) => {
  const responses = runtimeResponses(), paths: string[] = [];
  const { curvePolicy: _curve, launchGuard: _guard, launchLockAvailable: _lock, ...older } = responses["/api/config"];
  context.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === "/readyz") return Response.json(responses["/readyz"]);
    if (path === "/api/config") return Response.json(older);
    return new Response(null, { status: 404 });
  });
  await checkRuntime(releaseOrigin, { vars: { PLATFORM_TREASURY: runtimeVars.PLATFORM_TREASURY, ENABLE_MAINNET_TRANSACTIONS: "true" } }, false);
  assert.deepEqual(paths, ["/readyz", "/api/config"]);
});

test("frozen inventory detects replacements and additions, and manifest covers encoded paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-policy-test-"));
  try {
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<html>build</html>");
    writeFileSync(join(directory, "assets", "image name.png"), "image");
    writeFileSync(join(directory, "build-info.json"), "manifest bytes");
    const frozen = snapshotBuild(directory);
    const files = { ...frozen };
    delete files["/build-info.json"];
    const info: BuildInfo = {
      schemaVersion: 1, repository: "https://github.com/MuseCity/musegodfun", commit,
      source: "github-actions", dirty: false, buildId: "build-1-1",
      runUrl: "https://github.com/MuseCity/musegodfun/actions/runs/1/attempts/1",
      releaseUrl: "https://github.com/MuseCity/musegodfun/releases/tag/build-1-1", files,
    };
    assert.ok(files["/assets/image%20name.png"]);
    assert.doesNotThrow(() => assertBuildManifest(info, frozen));
    assert.doesNotThrow(() => assertFrozenBuild(directory, frozen));
    assert.throws(() => assertBuildManifest({ ...info, files: { "/index.html": files["/index.html"] } }, frozen), /every frozen/);
    writeFileSync(join(directory, "index.html"), "<html>replacement</html>");
    assert.throws(() => assertFrozenBuild(directory, frozen), /changed/);
    writeFileSync(join(directory, "index.html"), "<html>build</html>");
    writeFileSync(join(directory, "extra.js"), "extra");
    assert.throws(() => assertFrozenBuild(directory, frozen), /changed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a rollback point must be an existing single version at 100 percent", () => {
  assert.equal(requireSingleActiveVersion({ versions: [{ version_id: previousVersion, percentage: 100 }] }), previousVersion);
  assert.throws(() => requireSingleActiveVersion(undefined), /one existing Worker/);
  assert.throws(() => requireSingleActiveVersion({ versions: [{ version_id: previousVersion, percentage: 50 }, { version_id: candidateVersion, percentage: 50 }] }), /100%/);
  assert.throws(() => requireSingleActiveVersion({ versions: [{ version_id: previousVersion, percentage: 99 }] }), /100%/);
});

test("a stale push cannot upload or activate a candidate", async () => {
  const f = lifecycle();
  f.flow.currentMaster = async () => newerCommit;
  assert.equal(await publishCandidate(f.flow), "skipped");
  assert.deepEqual(f.events, ["frozen"]);
  assert.equal(f.getActive(), previousVersion);
});

test("a push that becomes stale while publishing leaves the public candidate inactive", async () => {
  const f = lifecycle();
  let reads = 0;
  f.flow.currentMaster = async () => ++reads === 1 ? commit : newerCommit;
  assert.equal(await publishCandidate(f.flow), "skipped");
  assert.ok(f.events.includes("publish"));
  assert.equal(f.events.includes("deployment"), false);
  assert.equal(f.events.some(event => event.startsWith("activate:")), false);
  assert.equal(f.getActive(), previousVersion);
});

test("a push arriving during deployment status IO is rechecked immediately before activation", async () => {
  const f = lifecycle();
  let reads = 0;
  f.flow.currentMaster = async () => ++reads <= 2 ? commit : newerCommit;
  assert.equal(await publishCandidate(f.flow), "skipped");
  assert.deepEqual(f.statuses.map(status => status.state), ["in_progress", "inactive"]);
  assert.equal(f.events.some(event => event.startsWith("activate:")), false);
  assert.equal(f.getActive(), previousVersion);
});

test("success is recorded only after immutable publication, activation read-back and online verification", async () => {
  const f = lifecycle();
  assert.equal(await publishCandidate(f.flow), "success");
  assert.ok(f.events.indexOf("publish") < f.events.indexOf(`activate:${candidateVersion}`));
  assert.ok(f.events.indexOf(`active:${candidateVersion}`) < f.events.indexOf("verify"));
  assert.ok(f.events.indexOf("verify") < f.events.indexOf("status:success"));
  assert.deepEqual(f.statuses.map(status => status.state), ["in_progress", "success"]);
});

test("failed online verification restores and verifies the previous version before recording failure", async () => {
  const f = lifecycle();
  f.flow.verify = async () => { throw new Error("file hash mismatch"); };
  await assert.rejects(() => publishCandidate(f.flow), error => error instanceof ReleaseFailure && error.rollback === "verified");
  assert.equal(f.getActive(), previousVersion);
  assert.ok(f.events.indexOf("rollback-check") < f.events.indexOf("status:failure"));
  assert.match(f.statuses.at(-1)!.description, /rollback=verified/);
  assert.equal(f.statuses.some(status => status.state === "success"), false);
});

test("activation that succeeded remotely before CLI failure still rolls back", async () => {
  const f = lifecycle(), activate = f.flow.activate;
  f.flow.activate = async version => {
    await activate(version);
    if (version === candidateVersion) throw new Error("CLI lost its response");
  };
  await assert.rejects(() => publishCandidate(f.flow), error => error instanceof ReleaseFailure && error.rollback === "verified");
  assert.equal(f.getActive(), previousVersion);
  assert.match(f.statuses.at(-1)!.description, /rollback=verified/);
});

test("rollback failure is explicit and never recorded as success", async () => {
  const f = lifecycle(), activate = f.flow.activate;
  f.flow.verify = async () => { throw new Error("wrong Worker header"); };
  f.flow.activate = async version => {
    if (version === previousVersion) throw new Error("rollback API rejected");
    await activate(version);
  };
  await assert.rejects(() => publishCandidate(f.flow), error => error instanceof ReleaseFailure && error.rollback === "failed" && error.rollbackError instanceof Error);
  assert.equal(f.getActive(), candidateVersion);
  assert.match(f.statuses.at(-1)!.description, /rollback=failed/);
});

test("an unrelated manual deployment after activation is not overwritten during failure recovery", async () => {
  const f = lifecycle(), external = "33333333-3333-4333-8333-333333333333";
  f.flow.verify = async () => { f.setActive(external); throw new Error("unexpected active version"); };
  await assert.rejects(() => publishCandidate(f.flow), error => error instanceof ReleaseFailure && error.rollback === "external_change");
  assert.equal(f.getActive(), external);
  assert.equal(f.events.includes(`activate:${previousVersion}`), false);
  assert.match(f.statuses.at(-1)!.description, /rollback=external_change/);
});

test("a frozen build mismatch after upload stops before public release or activation", async () => {
  const f = lifecycle();
  let checks = 0;
  f.flow.assertFrozen = () => { if (++checks === 2) throw new Error("artifact changed"); };
  await assert.rejects(() => publishCandidate(f.flow), /artifact changed/);
  assert.equal(f.events.includes("publish"), false);
  assert.equal(f.events.some(event => event.startsWith("activate:")), false);
});

test("release verifies persisted signing controls and the committed fee engine policy",async context=>{
  const responses=runtimeResponses();
  for(const [path,response] of Object.entries(responses)) {
    response.writesEnabled=false;
    if(path.endsWith("/config"))Object.assign(response,{securityProtocol:1,signingPaused:true,controlRevision:2,feeEngine:null,feePolicy:FEE_POLICY});
  }
  context.mock.method(globalThis,"fetch",async(url:string)=>Response.json(responses[new URL(url).pathname as keyof typeof responses]));
  const vars={...runtimeVars,RUNTIME_SECURITY_PROTOCOL:"1"};
  await checkRuntime(releaseOrigin,{vars});
  Object.assign(responses["/api/chains/8453/config"],{controlRevision:undefined});
  await assert.rejects(checkRuntime(releaseOrigin,{vars}),/safety controls/);
  Object.assign(responses["/api/chains/8453/config"],{controlRevision:2});
  Object.assign(responses["/api/config"],{feePolicy:ENGINE_FEE_POLICY});
  await assert.rejects(checkRuntime(releaseOrigin,{vars}),/Fee engine runtime/);
});
test("functional release smoke covers prices, verified assets and a read-only catalog trade quote",async context=>{
  let quoteSeen=false,prices:(string|null)[]=["1","2500"];
  context.mock.method(globalThis,"fetch",async(url:string,init?:RequestInit)=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/first-buy/prices"))return Response.json({assets:prices.map(priceUsd=>({priceUsd}))});
    if(path.endsWith("/stocks"))return Response.json(Array.from({length:path.includes("8453")?36:1},()=>({verified:true})));
    if(path.endsWith("/buyback/engine"))return Response.json(path.includes("8453")?{kind:"base_splits_native",destinationChainId:4663}:{});
    if(path.endsWith("/buyback/vault-ledger"))return Response.json({version:1,initialized:false});
    if(path.endsWith("/tokens"))return Response.json({items:[{address:runtimeVars.PLATFORM_TREASURY}],nextCursor:null});
    assert(path.endsWith("/quote"));assert.equal(init?.method,"POST");
    const body=JSON.parse(String(init?.body));assert.equal(body.amount,"1");assert.equal(body.side,"buy");
    quoteSeen=true;return Response.json({amountOut:"100"});
  });
  await checkFunctionalSmoke(releaseOrigin);assert.equal(quoteSeen,true);
  for(const references of [["1",null],[null,null]]) {
    prices=references;
    assert((await checkFunctionalSmoke(releaseOrigin)).every(result=>result.auxiliaryPrices==="degraded"),
      "auxiliary references do not disable valid transaction/identity checks");
  }
  prices=["1","NaN"];await assert.rejects(checkFunctionalSmoke(releaseOrigin),/malformed payment price/);
});

function deployedCollectorManifest(): BaseCollectorManifest {
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  // Pristine rollout fixtures represent their own unsigned state, regardless of the deployed owner's later acceptance.
  manifest.activation = { status: "not_run" };
  manifest.canaryAuthorization = null;
  manifest.status = "deployed_verified";
  manifest.nativeRule.ruleId = null;
  manifest.nativeRule.configurationSha256 = null;
  Object.assign(manifest.collector, { address: "0x4444444444444444444444444444444444444444", runtimeHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"22".repeat(32)}`, blockNumber: "100" });
  for (const entry of Object.values(manifest.dependencies)) Object.assign(entry, { runtimeHash: `0x${"33".repeat(32)}`, proxyCheck: "direct" });
  const automation = "0x7777777777777777777777777777777777777777" as const;
  manifest.constants.automationReceiver = automation;
  manifest.automationAccount = { address: automation, runtimeHash: BASE_SPLITS_PROXY_HASH,
    factory: { address: BASE_SPLITS_FACTORY, runtimeHash: BASE_SPLITS_FACTORY_HASH },
    creation: { owner: "0x9999999999999999999999999999999999999999", threshold: 1,
      signers: [{ slot1: `0x${"99".repeat(32)}`, slot2: `0x${"00".repeat(32)}` }], salt: "1" },
    implementation: { address: BASE_SPLITS_IMPLEMENTATION, runtimeHash: BASE_SPLITS_IMPLEMENTATION_HASH },
    owner: "0x9999999999999999999999999999999999999999", threshold: 1,
    signers: [{ index: 7, slot1: `0x${"99".repeat(32)}`, slot2: `0x${"00".repeat(32)}` }],
    initializationHash: `0x${"aa".repeat(32)}`, blockNumber: "90" };
  return manifest;
}

test("first deployed paused baseline requires a fresh pristine check, then rollback carries the same Collector graph", async () => {
  const candidateManifest = deployedCollectorManifest(), candidateVars = { ENABLE_BASE_TRANSACTIONS: "false", BASE_FEE_COLLECTOR_ADDRESS: candidateManifest.collector.address! };
  const pending = structuredClone(BASE_COLLECTOR_MANIFEST);
  pending.activation = { status: "not_run" };
  pending.canaryAuthorization = null;
  pending.status = "not_deployed";
  Object.assign(pending.collector, { address: null, runtimeHash: null, transactionHash: null, blockNumber: null });
  let pristineCalls = 0, pristine = true;
  const input = { previousVars: { ENABLE_BASE_TRANSACTIONS: "false" }, candidateVars, candidateManifest,
    previousRecoveryProtocol: false, pristine: async () => { pristineCalls++; return pristine; } };
  assert.equal(await baseRollbackCompatible(input), true);
  pristine = false;
  assert.equal(await baseRollbackCompatible(input), false, "recheck before activation and rollback catches intervening financial activity");
  assert.equal(pristineCalls, 2);
  assert.equal(await baseRollbackCompatible({ ...input, previousRecoveryProtocol: true, previousManifest: pending }), false,
    "pending manifest and code marker alone cannot recover a deployed Collector");
  pristine = true;
  const blockedCalls = pristineCalls;
  assert.equal(await baseRollbackCompatible({ ...input, candidateVars: { ...candidateVars, ENABLE_BASE_TRANSACTIONS: "true" } }), false);
  candidateManifest.activation.nativeExecution = {} as NonNullable<BaseCollectorManifest["activation"]["nativeExecution"]>;
  assert.equal(await baseRollbackCompatible(input), false, "a canary record makes the pristine bootstrap unavailable");
  assert.equal(pristineCalls, blockedCalls, "each incompatible signing/canary case must block before the pristine callback");
  delete candidateManifest.activation.nativeExecution;
  const prior = structuredClone(candidateManifest);
  const compatible = { ...input, previousVars: candidateVars, previousManifest: prior, previousRecoveryProtocol: true };
  assert.equal(await baseRollbackCompatible(compatible), true);
  prior.constants.operationsTreasury = "0x6666666666666666666666666666666666666666";
  assert.equal(await baseRollbackCompatible(compatible), false, "same address but changed reviewed graph is not a recovery baseline");
});

test("pre-Collector rollback smoke uses only the existing Robinhood functional endpoints", async context => {
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url).pathname; paths.push(path);
    if (path.endsWith("/first-buy/prices")) return Response.json({ assets: [{ priceUsd: null }, { priceUsd: "1" }] });
    if (path.endsWith("/stocks")) return Response.json([{ verified: true }]);
    if (path.endsWith("/tokens")) return Response.json({ items: [], nextCursor: null });
    return new Response(null, { status: 404 });
  });
  await checkFunctionalSmoke(releaseOrigin, false);
  assert(paths.every(path => path.startsWith("/api/chains/4663/") && !path.includes("/buyback/")));
});

test("uploaded runtime flags must equal the frozen source even while persistent Base control is paused", () => {
  const vars = { ENABLE_BASE_TRANSACTIONS: "false", BASE_FEE_COLLECTOR_ADDRESS: "0x4444444444444444444444444444444444444444" };
  const bindings = Object.entries(vars).map(([name, text]) => ({ name, text, type: "plain_text" }));
  assert.doesNotThrow(() => assertCandidateRuntimeBindings(bindings, vars));
  const drift = bindings.map(binding => binding.name === "ENABLE_BASE_TRANSACTIONS" ? { ...binding, text: "true" } : binding);
  assert.throws(() => assertCandidateRuntimeBindings(drift, vars), /activation is blocked/);
  assert.throws(() => assertCandidateRuntimeBindings(bindings.slice(0, 1), vars), /activation is blocked/);
});

test("a pending Collector release cannot introduce the Base signing flag or a canary record", async () => {
  const input = { previousVars: {}, candidateVars: {}, candidateManifest: structuredClone(BASE_COLLECTOR_MANIFEST),
    previousRecoveryProtocol: false, pristine: async () => true };
  input.candidateManifest.activation = { status: "not_run" };
  input.candidateManifest.canaryAuthorization = null;
  input.candidateManifest.status = "not_deployed";
  Object.assign(input.candidateManifest.collector, { address: null, runtimeHash: null, transactionHash: null, blockNumber: null });
  assert.equal(await baseRollbackCompatible(input), true);
  assert.equal(await baseRollbackCompatible({ ...input, candidateVars: { ENABLE_BASE_TRANSACTIONS: "true" } }), false);
  input.candidateManifest.activation.status = "canary_verified";
  assert.equal(await baseRollbackCompatible(input), false);
});

test("native Automation activation and destination changes require a matching recovery baseline", async () => {
  const candidateManifest = deployedCollectorManifest(), candidateVars = { ENABLE_BASE_TRANSACTIONS: "false", BASE_FEE_COLLECTOR_ADDRESS: candidateManifest.collector.address! };
  candidateManifest.nativeRule.ruleId = "base-native-rule";
  candidateManifest.nativeRule.configurationSha256 = `0x${"aa".repeat(32)}`;
  const input = { previousVars: {}, candidateVars, candidateManifest, previousRecoveryProtocol: false, pristine: async () => true };
  assert.equal(await baseRollbackCompatible(input), false, "an initialized native rule cannot bootstrap against pre-native code");
  const previousManifest = structuredClone(candidateManifest);
  const compatible = { ...input, previousVars: candidateVars, previousManifest, previousRecoveryProtocol: true };
  assert.equal(await baseRollbackCompatible(compatible), true);
  previousManifest.nativeRule.recipient = "0x6666666666666666666666666666666666666666";
  assert.equal(await baseRollbackCompatible(compatible), false, "a changed native recipient is not a compatible rollback");
});

test("release requires the new Base native policy without exposing an unactivated fee adapter for signing", async context => {
  const responses = runtimeResponses();
  for (const [path, response] of Object.entries(responses)) {
    response.writesEnabled = false;
    if (path.endsWith("/config")) Object.assign(response, { securityProtocol: 1, signingPaused: true, controlRevision: 0, feeEngine: null, feePolicy: FEE_POLICY });
  }
  const collector = "0x4444444444444444444444444444444444444444";
  const base = responses["/api/chains/8453/config"];
  Object.assign(base, { feePolicy: BASE_AUTOMATION_FEE_POLICY });
  const vars = { ...runtimeVars, RUNTIME_SECURITY_PROTOCOL: "1", BASE_FEE_COLLECTOR_ADDRESS: collector };
  context.mock.method(globalThis, "fetch", async (url: string) => Response.json(responses[new URL(url).pathname as keyof typeof responses]));
  await checkRuntime(releaseOrigin, { vars });
  Object.assign(base, { feePolicy: "creator-70-musegod-base-collector-v1" });
  await assert.rejects(checkRuntime(releaseOrigin, { vars }), /Fee engine runtime/);
  Object.assign(base, { feePolicy: BASE_AUTOMATION_FEE_POLICY, signingPaused: false, writesEnabled: true });
  responses["/api/chains/8453/readyz"].writesEnabled = true;
  await assert.rejects(checkRuntime(releaseOrigin, { vars: { ...vars, ENABLE_BASE_TRANSACTIONS: "true" } }), /Fee engine runtime/);
  Object.assign(base, { feeEngine: collector });
  await checkRuntime(releaseOrigin, { vars: { ...vars, ENABLE_BASE_TRANSACTIONS: "true" } });
});

test("a paused Robinhood runtime must still expose its exact committed fee engine",async context=>{
 const responses=runtimeResponses(),engine="0x4444444444444444444444444444444444444444";
 for(const[path,response]of Object.entries(responses)){response.writesEnabled=false;if(path.endsWith("/config"))Object.assign(response,{securityProtocol:1,signingPaused:true,controlRevision:0,feeEngine:null,feePolicy:path.includes("8453")?FEE_POLICY:ENGINE_FEE_POLICY});}
 const vars={...runtimeVars,RUNTIME_SECURITY_PROTOCOL:"1",FEE_ENGINE_ADDRESS:engine};
 context.mock.method(globalThis,"fetch",async(url:string)=>Response.json(responses[new URL(url).pathname as keyof typeof responses]));
 await assert.rejects(checkRuntime(releaseOrigin,{vars}),/Fee engine runtime/);
 for(const path of ["/api/config","/api/chains/4663/config"] as const)Object.assign(responses[path],{feeEngine:engine});
 await checkRuntime(releaseOrigin,{vars});
});

test("a pristine baseline scans complete adapter and native-account history in bounded ten-block RPC pages",async()=>{
 const manifest=deployedCollectorManifest(),collector=manifest.collector.address!,automation=manifest.automationAccount.address!;
 let active=0,peak=0,logs=false,reorg=false,rpcFailure=false,clock=0;
 const ranges:{to?:string;address?:string;fromBlock:bigint;toBlock:bigint}[]=[];
 const client={getBlock:async()=>({number:250n,hash:reorg?"changed":"stable"}),getBalance:async()=>0n,
  readContract:async({functionName}:any)=>functionName==="paused"?true:0n,
  getLogs:async(input:any)=>{active++;peak=Math.max(peak,active);ranges.push({...input,to:input.args?.to});await new Promise(resolve=>setImmediate(resolve));active--;
   if(rpcFailure)throw new Error("RPC unavailable");return logs&&input.args?.to===automation?[{}]:[];}};
 const verifyGraph=async()=>({collector,automationReceiver:automation,paused:true,runtimeHash:manifest.collector.runtimeHash!,manifestFingerprint:"0x11" as const,initialDeploymentBlock:100n});
 const deps={client:client as any,verifyGraph:verifyGraph as any,now:()=>clock++,auditStore:{load:()=>null,save:()=>{}}};
 assert.equal(await pristineBaseCollector(manifest,deps),true);assert(peak>1&&peak<=18);
 for(const holder of [collector,automation]){
  const received=ranges.filter(row=>row.to===holder).sort((a,b)=>Number(a.fromBlock-b.fromBlock));let expected=holder===collector?100n:90n;
  for(const row of received){assert.equal(row.fromBlock,expected);assert(row.toBlock-row.fromBlock<=9n);expected=row.toBlock+1n;}assert.equal(expected,251n);
 }
 logs=true;assert.equal(await pristineBaseCollector(manifest,deps),false,"any token arrival blocks a pre-recovery rollback");logs=false;
 rpcFailure=true;assert.equal(await pristineBaseCollector(manifest,deps),false,"unavailable evidence cannot authorize the bootstrap");rpcFailure=false;
 let blockReads=0;client.getBlock=async()=>({number:250n,hash:++blockReads>1?"reorg":"stable"});
 assert.equal(await pristineBaseCollector(manifest,deps),false,"the final canonical head must match the frozen snapshot");
 client.getBlock=async()=>({number:250n,hash:"stable"});
 let expired=false;assert.equal(await pristineBaseCollector(manifest,{...deps,now:()=>expired?45_000:(expired=true,0)}),false);
});

function pristineAuditFixture() {
 const manifest=deployedCollectorManifest(),collector=manifest.collector.address!,automation=manifest.automationAccount.address!;
 let head=60_000n,clock=0,latency=2500,activity=false,rpcFailure=false,reorgAt:bigint|null=null;
 let saved:BasePristineAudit|null=null;
 const receiptLogs = new Map<string, any>();
 const ranges:{fromBlock:bigint;toBlock:bigint}[]=[];
 const blockHash=(number:bigint)=>`0x${(number+(reorgAt!==null&&number>=reorgAt?1_000_000n:0n)).toString(16).padStart(64,"0")}`;
 const transferLog=(input:any,value=1n,self=false)=>{
  const to=input.args.to,from=self?to:"0x2222222222222222222222222222222222222222",number=input.toBlock;
  const log={address:BASE_BUYBACK_WETH,blockNumber:number,blockHash:blockHash(number),transactionHash:`0x${(number+2_000_000n).toString(16).padStart(64,"0")}`,
   transactionIndex:0,logIndex:0,removed:false,topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from,to}}),data:encodeAbiParameters(parseAbiParameters("uint256"),[value])};
  receiptLogs.set(log.transactionHash,{status:"success",transactionHash:log.transactionHash,blockNumber:number,blockHash:log.blockHash,transactionIndex:0,logs:[log]});return log;
 };
 const client={getChainId:async()=>8453,getBlock:async(input?:{blockNumber?:bigint})=>{const number=input?.blockNumber??head;return {number,hash:blockHash(number)};},getBalance:async()=>0n,
  getTransactionReceipt:async({hash}:any)=>{const receipt=receiptLogs.get(hash);if(!receipt)throw new Error("Unknown fixture receipt");return receipt;},
  readContract:async({functionName}:any)=>functionName==="paused"?true:0n,
  getLogs:async(input:any)=>{ranges.push({fromBlock:input.fromBlock,toBlock:input.toBlock});clock+=latency;if(rpcFailure)throw new Error("RPC failed");return activity&&input.toBlock>=head&&input.args?.to===automation?[transferLog(input)]:[];}};
 const deps={client:client as any,verifyGraph:async()=>({collector,automationReceiver:automation,paused:true,runtimeHash:manifest.collector.runtimeHash!,manifestFingerprint:"0x11",initialDeploymentBlock:100n}) as any,
  now:()=>clock,auditStore:{load:()=>saved&&structuredClone(saved),save:(value:BasePristineAudit)=>{saved=structuredClone(value);}}};
 return {manifest,deps,ranges,transferLog,get saved(){return saved;},set saved(value:BasePristineAudit|null){saved=value;},set head(value:bigint){head=value;},set clock(value:number){clock=value;},
  set latency(value:number){latency=value;},set activity(value:boolean){activity=value;},set rpcFailure(value:boolean){rpcFailure=value;},set reorgAt(value:bigint|null){reorgAt=value;}};
}

test("old pristine history survives deadline and process restart; activation rechecks only the anchored increment",async()=>{
 const work=pristineAuditFixture();
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),false);
 const retained=structuredClone(work.saved!);assert(BigInt(retained.through)>89n&&BigInt(retained.through)<60_000n);assert.equal(retained.activityObserved,false);
 work.clock=0;work.latency=0;work.ranges.length=0;
 // Reconstruct the store to model a later CI run, including an existing Robinhood hotfix candidate.
 const restarted={...work.deps,auditStore:{load:()=>structuredClone(work.saved),save:(value:BasePristineAudit)=>{work.saved=value;}}};
 const input={previousVars:{ENABLE_BASE_TRANSACTIONS:"false",ENABLE_ROBINHOOD_TRANSACTIONS:"true"},candidateVars:{ENABLE_BASE_TRANSACTIONS:"false",ENABLE_ROBINHOOD_TRANSACTIONS:"true",BASE_FEE_COLLECTOR_ADDRESS:work.manifest.collector.address!},candidateManifest:work.manifest,
  previousRecoveryProtocol:false,pristine:()=>pristineBaseCollector(work.manifest,restarted)};
 assert.equal(await baseRollbackCompatible(input),true,"complete resumable coverage permits the paused Base migration and same-release Robinhood hotfix");
 assert.equal(work.ranges[0].fromBlock,BigInt(retained.through)+1n,"completed older ranges are not rescanned");assert.equal(work.saved?.through,"60000");
 work.head=60_003n;work.ranges.length=0;assert.equal(await baseRollbackCompatible(input),true);
 assert(work.ranges.length>0&&work.ranges.every(range=>range.fromBlock===60_001n&&range.toBlock===60_003n));
 work.head=60_004n;work.activity=true;assert.equal(await baseRollbackCompatible(input),false,"new activity still blocks unsafe pre-recovery rollback");
 assert.equal(work.saved?.activityObserved,true);
});

test("pristine audit never advances through RPC failures, rolls forward on restart, and rejects stale or mismatched evidence",async()=>{
 const work=pristineAuditFixture();work.head=250n;work.latency=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);const completed=structuredClone(work.saved!);
 work.head=260n;work.rpcFailure=true;assert.equal(await pristineBaseCollector(work.manifest,work.deps),false);assert.deepEqual(work.saved,completed);
 work.rpcFailure=false;assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);assert.equal(work.saved?.through,"260");
 const newer=structuredClone(work.saved!);work.head=200n;work.ranges.length=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),false);assert.deepEqual(work.saved,newer);assert.equal(work.ranges.length,0,"a lagging provider does not erase audit progress");
 work.head=260n;work.reorgAt=200n;work.ranges.length=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);assert.equal(work.ranges[0].fromBlock,90n,"canonical anchor conflict requires full coverage replay");
 work.saved={...work.saved!,graphFingerprint:`0x${"ff".repeat(32)}`};work.ranges.length=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);assert.equal(work.ranges[0].fromBlock,90n,"foreign graph cannot authorize skipped history");
 work.saved={...work.saved!,through:"-1"};work.ranges.length=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);assert.equal(work.ranges[0].fromBlock,90n,"malformed progress cannot authorize skipped history");
});

test("a compatible native rollback baseline permits Robinhood hotfixes without any pristine scan",async()=>{
 const manifest=deployedCollectorManifest();manifest.nativeRule.ruleId="live-native-rule";manifest.nativeRule.configurationSha256=`0x${"aa".repeat(32)}`;
 const vars={ENABLE_BASE_TRANSACTIONS:"false",ENABLE_ROBINHOOD_TRANSACTIONS:"true",BASE_FEE_COLLECTOR_ADDRESS:manifest.collector.address!};
 const flow=lifecycle().flow;flow.rollbackAllowed=()=>baseRollbackCompatible({previousVars:vars,candidateVars:vars,previousManifest:manifest,candidateManifest:manifest,previousRecoveryProtocol:true,
  pristine:async()=>{throw new Error("must not scan a live native baseline");}});
 assert.equal(await publishCandidate(flow),"success");
});

test("rollback requires recovery version 7; older maintenance and destination policies cannot qualify",async()=>{
 assert.equal(supportsBaseRecovery(`export const BASE_RECOVERY_PROTOCOL = 7;\nexport const BASE_NATIVE_DESTINATION_POLICY = "${BASE_NATIVE_DESTINATION_POLICY}";\n`),true);
 assert.equal(supportsBaseRecovery('export const BASE_RECOVERY_PROTOCOL = 7;\nexport const BASE_NATIVE_DESTINATION_POLICY = "relay-v3-permit2-owner-receipt-v2";\n'),false);
 assert.equal(supportsBaseRecovery("export const BASE_RECOVERY_PROTOCOL = 7;\n"),false);
 for(const source of ["export const BASE_RECOVERY_PROTOCOL = 2;", "export const BASE_RECOVERY_PROTOCOL = 3;", "export const BASE_RECOVERY_PROTOCOL = 4;", "export const BASE_RECOVERY_PROTOCOL = 5;", "export const BASE_RECOVERY_PROTOCOL = 6;", "// export const BASE_RECOVERY_PROTOCOL = 7;", "export const BASE_RECOVERY_PROTOCOL = 70;"])
  assert.equal(supportsBaseRecovery(source),false);
 const manifest=deployedCollectorManifest();manifest.nativeRule.ruleId="live-native-rule";manifest.nativeRule.configurationSha256=`0x${"aa".repeat(32)}`;
 const vars={ENABLE_BASE_TRANSACTIONS:"false",BASE_FEE_COLLECTOR_ADDRESS:manifest.collector.address!};
 let scans=0;
 assert.equal(await baseRollbackCompatible({previousVars:vars,candidateVars:vars,previousManifest:manifest,candidateManifest:manifest,
  previousRecoveryProtocol:supportsBaseRecovery("export const BASE_RECOVERY_PROTOCOL = 3;"),pristine:async()=>{scans++;return true;}}),false);
 assert.equal(scans,0,"a live v3 baseline cannot recover the new internal audit state; no pristine scan can waive recovery compatibility");
});

test("external zero-value or self Transfer histories never poison the pristine bootstrap; positive dust still does",async()=>{
 const work=pristineAuditFixture();work.head=250n;work.latency=0;
 let value=0n,self=false;
 const holder=work.manifest.automationAccount.address!;
 const client={...work.deps.client,getLogs:async(input:any)=>{
  if(input.args?.to!==holder)return [];
  return [work.transferLog(input,value,self)];
 }};
 const deps={...work.deps,client:client as any};
 assert.equal(await pristineBaseCollector(work.manifest,deps),true);assert.equal(work.saved?.activityObserved,false);
 work.head=251n;value=1n;self=true;assert.equal(await pristineBaseCollector(work.manifest,deps),true);
 assert.equal(work.saved?.activityObserved,false,"self-transfers do not create asset movement");
 work.head=252n;self=false;assert.equal(await pristineBaseCollector(work.manifest,deps),false);
 assert.equal(work.saved?.activityObserved,true,`positive historical transfers to ${holder} still require a compatible recovery baseline`);
});

test("older operator audits are discarded and fully rechecked under dependency-bound version 3",async()=>{
 const work=pristineAuditFixture();work.head=250n;work.latency=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);
 assert.equal(work.saved?.dependencySha256,sha256(readFileSync("package-lock.json")),"the audit binds the actual frozen dependency lock bytes");
 work.saved={...work.saved!,version:2,activityObserved:true} as unknown as BasePristineAudit;
 work.ranges.length=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);
 assert.equal(work.ranges[0].fromBlock,90n);assert.equal(work.saved?.version,3);assert.equal(work.saved?.activityObserved,false);
 work.saved={...work.saved!,dependencySha256:"ff".repeat(32),activityObserved:true};work.ranges.length=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);
 assert.equal(work.ranges[0].fromBlock,90n,"a foreign package-lock hash cannot retain skipped history or sticky activity");
 assert.notEqual(work.saved?.dependencySha256,"ff".repeat(32));
});

test("private pristine audit progress is fsynced and survives store recreation without relaxing graph identities",()=>{
 const directory=mkdtempSync(join(tmpdir(),"musegod-pristine-audit-"));try{
  const value:BasePristineAudit={version:3,chainId:8453,graphFingerprint:`0x${"aa".repeat(32)}`,dependencySha256:"dd".repeat(32),collectorStart:"100",automationStart:"90",through:"250",blockHash:`0x${"bb".repeat(32)}`,activityObserved:false};
  basePristineAuditStore(directory).save(value);assert.deepEqual(basePristineAuditStore(directory).load(value.graphFingerprint,value.dependencySha256),value);
  assert.equal(basePristineAuditStore(directory).load(`0x${"cc".repeat(32)}`,value.dependencySha256),null);
  assert.equal(basePristineAuditStore(directory).load(value.graphFingerprint,"ee".repeat(32)),null,"dependency SHA is part of the persistent file key");
  assert.throws(()=>basePristineAuditStore(directory).save({...value,graphFingerprint:"../escape"}),/fingerprint/);
  assert.throws(()=>basePristineAuditStore(directory).save({...value,dependencySha256:"../escape"}),/dependency hash/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test("pristine graph verification warms complete cold module pages within its existing deadline and resumes persisted progress",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"pristine-module-warm-")),store=new Store(directory,31337);
 const work=pristineAuditFixture();work.head=1200n;work.latency=0;
 const id=`internal_native_modules:0x${"45".repeat(32)}`,pages:bigint[]=[];
 let calls=0,ticks=0,pageLatency=3000;
 const verifyGraph=async(client:any,_address:any,options:any)=>{
  calls++;
  await readBaseAudit({client,store:options.auditStore,id,from:90n,to:1200n,now:()=>ticks,maxDurationMs:5000,
   validate:(value):value is {blockNumber:string}=>typeof (value as any)?.blockNumber==="string",
   page:async(from,to)=>{pages.push(from);ticks+=pageLatency;return [{blockNumber:String(to)}];}});
  return work.deps.verifyGraph();
 };
 const deps={...work.deps,verifyGraph:verifyGraph as any,graphAuditStore:store,now:()=>ticks,maxDurationMs:5000};
 try{
  assert.equal(await pristineBaseCollector(work.manifest,deps),false,"deadline stops after complete durable pages, without granting pristine status");
  assert.equal(calls,1);assert.equal(store.getBuybackBatch(id)?.through,"489");assert.equal(work.saved,null);
  ticks=0;pageLatency=0;calls=0;pages.length=0;
  assert.equal(await pristineBaseCollector(work.manifest,deps),true,"cold audit coverage can finish in one bounded release attempt");
  assert.equal(calls,1);assert.deepEqual(pages,[490n,690n,890n,1090n]);assert.equal(store.getBuybackBatch(id)?.through,"1200");
  calls=0;
  assert.equal(await pristineBaseCollector(work.manifest,deps),true);assert.equal(calls,1,"an anchored full module history skips warming on activation recheck");
  for(const reason of ["Canonical Base audit coverage is incomplete; persisted progress will resume", "Canonical Base audit coverage is incomplete; persisted progress will resume later", "RPC unavailable"]){
   calls=0;
   assert.equal(await pristineBaseCollector(work.manifest,{...deps,verifyGraph:async()=>{calls++;throw new Error(reason);}}),false);
   assert.equal(calls,1,"only the exact incomplete-coverage error with newly committed progress can retry");
  }
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("phantom, malformed or reverted positive logs fail closed without poisoning persistent pristine activity",async()=>{
 const work=pristineAuditFixture();work.head=250n;work.latency=0;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true);
 const completed=structuredClone(work.saved!);
 work.head=251n;work.activity=true;
 const receipt=work.deps.client.getTransactionReceipt;
 for(const invalid of ["phantom","reverted","wrongHash","malformed"]){
  const client={...work.deps.client,
   getTransactionReceipt:async(input:any)=>{
    const actual=await receipt(input);
    return invalid==="phantom"?{...actual,logs:[]}:invalid==="reverted"?{...actual,status:"reverted"}:invalid==="wrongHash"?{...actual,blockHash:`0x${"ff".repeat(32)}`}:actual;
   },
   getLogs:async(input:any)=>{
    const logs=await work.deps.client.getLogs(input);
    return invalid==="malformed"?logs.map((log:any)=>({...log,data:"0x"})):logs;
   },
  };
  assert.equal(await pristineBaseCollector(work.manifest,{...work.deps,client:client as any}),false);
  assert.deepEqual(work.saved,completed,`${invalid} evidence cannot create a sticky activity flag or advance this page`);
 }
 work.activity=false;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),true,"a later canonical read recovers without erasing private cache files");
 assert.equal(work.saved?.activityObserved,false);assert.equal(work.saved?.through,"251");
 work.head=252n;work.activity=true;
 assert.equal(await pristineBaseCollector(work.manifest,work.deps),false);
 assert.equal(work.saved?.activityObserved,true,"actual receipt membership and a successful canonical block still retain activity");
});
