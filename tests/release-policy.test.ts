import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildInfo } from "../src/lib/build-info";
import { assertBuildManifest, assertCandidateRuntimeBindings, assertFrozenBuild, assertLaunchRuntime, assertReleaseCheckout, publishCandidate, ReleaseFailure, requireSingleActiveVersion, runtimeVarsFromBindings, snapshotBuild, type ReleaseLifecycle } from "../scripts/release-policy";
import { FEE_POLICY, ENGINE_FEE_POLICY, BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { checkRuntime, checkFunctionalSmoke, baseRollbackCompatible } from "../scripts/release";
import { BASE_COLLECTOR_MANIFEST, BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH, BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH, BASE_SPLITS_PROXY_HASH, type BaseCollectorManifest } from "../server/base-collector";

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
  manifest.status = "deployed_verified";
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
  let pristineCalls = 0, pristine = true;
  const input = { previousVars: { ENABLE_BASE_TRANSACTIONS: "false" }, candidateVars, candidateManifest,
    previousRecoveryProtocol: false, pristine: async () => { pristineCalls++; return pristine; } };
  assert.equal(await baseRollbackCompatible(input), true);
  pristine = false;
  assert.equal(await baseRollbackCompatible(input), false, "recheck before activation and rollback catches intervening financial activity");
  assert.equal(pristineCalls, 2);
  assert.equal(await baseRollbackCompatible({ ...input, previousRecoveryProtocol: true, previousManifest: BASE_COLLECTOR_MANIFEST }), false,
    "pending manifest and code marker alone cannot recover a deployed Collector");
  assert.equal(await baseRollbackCompatible({ ...input, candidateVars: { ...candidateVars, ENABLE_BASE_TRANSACTIONS: "true" } }), false);
  candidateManifest.activation.nativeExecution = {} as NonNullable<BaseCollectorManifest["activation"]["nativeExecution"]>;
  assert.equal(await baseRollbackCompatible(input), false, "a canary record makes the pristine bootstrap unavailable");
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
