import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildInfo } from "../src/lib/build-info";
import { assertBuildManifest, assertCandidateRuntimeBindings, assertFrozenBuild, assertLaunchRuntime, assertReleaseCheckout, publishCandidate, ReleaseFailure, requireSingleActiveVersion, rollbackPreservesSafety, runtimeVarsFromBindings, sha256, snapshotBuild, type ReleaseLifecycle } from "../scripts/release-policy";
import { FEE_POLICY, ENGINE_FEE_POLICY, BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { checkRuntime, checkFunctionalSmoke, baseRollbackCompatible, supportsBaseRecovery, supportsBuybackSummary, baseAssetCountFromSource, nftModeRuntime, nftRollbackCompatible, rollbackBlockReason, supportsNftMode } from "../scripts/release";
import { NFT_VAULT_MANIFEST, type NftVaultManifest } from "../src/lib/nft-mode";
import { BASE_COLLECTOR_MANIFEST, BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH, BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH, BASE_SPLITS_PROXY_HASH, type BaseCollectorManifest } from "../server/base-collector";
import { BASE_NATIVE_DESTINATION_POLICY } from "../src/lib/base-buyback";
import { ADMITTED_BASE_ASSET_COUNT, STOCKS, type RuntimeConfig } from "../src/lib/config";
import { LaunchpadService } from "../server/service";

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
    if(path.endsWith("/stocks"))return Response.json(Array.from({length:path.includes("8453")?ADMITTED_BASE_ASSET_COUNT:1},()=>({verified:true})));
    if(path.endsWith("/buyback/engine"))return Response.json(path.includes("8453")?{kind:"base_splits_native",destinationChainId:4663}:{});
    if(path.endsWith("/buyback/summary"))return Response.json({chainId:4663,scope:"shared_robinhood",available:true,vaultMuseToDead:"0",deadTotalMuse:"0"});
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

test("round13 candidate smoke requires the current admitted Base asset count, not the previous 36",async context=>{
  let baseCount=ADMITTED_BASE_ASSET_COUNT;
  context.mock.method(globalThis,"fetch",async(url:string)=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/first-buy/prices"))return Response.json({assets:[{priceUsd:"1"},{priceUsd:"2500"}]});
    if(path.endsWith("/stocks"))return Response.json(Array.from({length:path.includes("8453")?baseCount:1},()=>({verified:true})));
    if(path.endsWith("/buyback/engine"))return Response.json(path.includes("8453")?{kind:"base_splits_native",destinationChainId:4663}:{});
    assert(path.endsWith("/tokens"));return Response.json([]);
  });
  await checkFunctionalSmoke(releaseOrigin,true,false);
  for(const count of [ADMITTED_BASE_ASSET_COUNT-1,36]){baseCount=count;await assert.rejects(checkFunctionalSmoke(releaseOrigin,true,false),/Base pairing identity count/);}
});

test("round13 rollback smoke uses its immutable source list of 36 and does not change candidate expectations",async context=>{
  const pm={ticker:"PM",symbol:"PMc",name:"Philip Morris",address:"0xB2000000000000000000008FC2A8C23cf5937b66",decimals:8};
  const targetStocks=[...STOCKS.filter(stock=>stock.address.toLowerCase()!==pm.address.toLowerCase()),pm];
  const rollbackCount=baseAssetCountFromSource(JSON.stringify(targetStocks));assert.equal(rollbackCount,36);
  let baseCount=rollbackCount;
  context.mock.method(globalThis,"fetch",async(url:string)=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/first-buy/prices"))return Response.json({assets:[{priceUsd:"1"},{priceUsd:"2500"}]});
    if(path.endsWith("/stocks"))return Response.json(Array.from({length:path.includes("8453")?baseCount:1},()=>({verified:true})));
    if(path.endsWith("/buyback/engine"))return Response.json(path.includes("8453")?{kind:"base_splits_native",destinationChainId:4663}:{});
    assert(path.endsWith("/tokens"));return Response.json([]);
  });
  await checkFunctionalSmoke(releaseOrigin,true,false,rollbackCount);
  await assert.rejects(checkFunctionalSmoke(releaseOrigin,true,false),/Base pairing identity count/);
  baseCount=ADMITTED_BASE_ASSET_COUNT;await checkFunctionalSmoke(releaseOrigin,true,false);
  await assert.rejects(checkFunctionalSmoke(releaseOrigin,true,false,rollbackCount),/Base pairing identity count/);
});

test("round13 malformed or missing rollback asset lists never manufacture a usable count",async context=>{
  const stock=STOCKS[0];
  for(const source of [undefined,"", "not JSON","null","{}","[]",JSON.stringify([{}]),JSON.stringify([stock,stock]),
    JSON.stringify([{...stock,address:"0x0000000000000000000000000000000000000000"}]),JSON.stringify([{...stock,decimals:-1}])])
    assert.throws(()=>baseAssetCountFromSource(source as string),/locked rollback target's Base asset list/);
  let calls=0;context.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("Invalid expected counts must be rejected before HTTP");});
  for(const count of [0,-1,NaN,Infinity,1.5])await assert.rejects(checkFunctionalSmoke(releaseOrigin,true,false,count),/Base pairing identity count is unavailable/);
  assert.equal(calls,0);
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

test("a deployed Collector rejects pre-Collector rollback and requires the same reviewed recovery graph", async () => {
  const candidateManifest = deployedCollectorManifest(), candidateVars = { ENABLE_BASE_TRANSACTIONS:"false", BASE_FEE_COLLECTOR_ADDRESS:candidateManifest.collector.address! };
  const input = { previousVars:{ENABLE_BASE_TRANSACTIONS:"false"},candidateVars,candidateManifest,previousRecoveryProtocol:false };
  assert.equal(await baseRollbackCompatible(input),false,"unused-Collector bootstrap scanning is retired");
  const prior=structuredClone(candidateManifest),compatible={...input,previousVars:candidateVars,previousManifest:prior,previousRecoveryProtocol:true};
  assert.equal(await baseRollbackCompatible(compatible),true);
  prior.constants.operationsTreasury="0x6666666666666666666666666666666666666666";
  assert.equal(await baseRollbackCompatible(compatible),false,"same address cannot waive graph differences");
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
    previousRecoveryProtocol: false };
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
  const input = { previousVars: {}, candidateVars, candidateManifest, previousRecoveryProtocol: false };
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

test("a compatible native rollback baseline permits Robinhood hotfixes using only the matching graph",async()=>{
 const manifest=deployedCollectorManifest();manifest.nativeRule.ruleId="live-native-rule";manifest.nativeRule.configurationSha256=`0x${"aa".repeat(32)}`;
 const vars={ENABLE_BASE_TRANSACTIONS:"false",ENABLE_ROBINHOOD_TRANSACTIONS:"true",BASE_FEE_COLLECTOR_ADDRESS:manifest.collector.address!};
 const flow=lifecycle().flow;flow.rollbackAllowed=()=>baseRollbackCompatible({previousVars:vars,candidateVars:vars,previousManifest:manifest,candidateManifest:manifest ,previousRecoveryProtocol:true});
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
 assert.equal(await baseRollbackCompatible({previousVars:vars,candidateVars:vars,previousManifest:manifest,candidateManifest:manifest,
  previousRecoveryProtocol:supportsBaseRecovery("export const BASE_RECOVERY_PROTOCOL = 3;")}),false);
});


test("summary capability is read from locked app source, never from HTTP failure or a comment",()=>{
 assert.equal(supportsBuybackSummary('app.get("/api/buyback/summary", route(async () => {}));'),true);
 assert.equal(supportsBuybackSummary('app.get("/api/buyback/engine", route(async () => {}));'),false);
 assert.equal(supportsBuybackSummary('// app.get("/api/buyback/summary", route(async () => {}));'),false);
 assert.equal(supportsBuybackSummary(readFileSync(new URL("../server/app.ts",import.meta.url),"utf8")),true);
});

// ---- NFT mode (plan Task 12 Step 4) ------------------------------------------------------------------------------------------
const nftFactory = "0x5555555555555555555555555555555555555555";
const deployedNftManifest: NftVaultManifest = { ...NFT_VAULT_MANIFEST, chains: { ...NFT_VAULT_MANIFEST.chains,
  "4663": { status: "deployed_verified", factory: nftFactory, factoryRuntimeHash: `0x${"aa".repeat(32)}`, transactionHash: `0x${"bb".repeat(32)}`, blockNumber: 1 } } };
const nftConfig = (chainId: 4663 | 8453, enabled: boolean, vaultFactory: string | null = enabled ? nftFactory : null) =>
  ({ enabled, vaultFactory, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] });

test("checkRuntime records the Robinhood runtime's NFT mode; a runtime without nftMode (pre-NFT) counts as disabled", async context => {
  const responses = runtimeResponses(), paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string) => { const path = new URL(url).pathname; paths.push(path); return Response.json(responses[path as keyof typeof responses]); });
  assert.deepEqual(await checkRuntime(releaseOrigin, { vars: runtimeVars }), { nftMode: { enabled: false, vaultFactory: null } });
  assert.deepEqual(paths, Object.keys(responses), "no extra request: nftMode is read from the configs already checked");
  for (const [path, response] of Object.entries(responses)) if (path.endsWith("/config")) Object.assign(response, { nftMode: nftConfig(path.includes("8453") ? 8453 : 4663, false) });
  assert.deepEqual(await checkRuntime(releaseOrigin, { vars: { ...runtimeVars, NFT_MODE_ENABLED: "false" } }), { nftMode: { enabled: false, vaultFactory: null } });
  // An older rollback target answers only the legacy endpoints, without nftMode.
  const { nftMode: _nft, curvePolicy: _curve, launchGuard: _guard, launchLockAvailable: _lock, ...older } = responses["/api/config"] as Record<string, unknown>;
  context.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url).pathname;
    return path === "/readyz" ? Response.json(responses["/readyz"]) : path === "/api/config" ? Response.json(older) : new Response(null, { status: 404 });
  });
  assert.deepEqual(await checkRuntime(releaseOrigin, { vars: { PLATFORM_TREASURY: runtimeVars.PLATFORM_TREASURY, ENABLE_MAINNET_TRANSACTIONS: "true" } }, false),
    { nftMode: { enabled: false, vaultFactory: null } });
});

test("an enabled NFT runtime must follow the exact committed flag and expose the committed verified vault factory", async context => {
  const responses = runtimeResponses();
  const set = (enabled: boolean, vaultFactory?: string | null) => {
    for (const path of ["/api/config", "/api/chains/4663/config"] as const) Object.assign(responses[path], { nftMode: nftConfig(4663, enabled, vaultFactory) });
    Object.assign(responses["/api/chains/8453/config"], { nftMode: nftConfig(8453, false) });
  };
  context.mock.method(globalThis, "fetch", async (url: string) => Response.json(responses[new URL(url).pathname as keyof typeof responses]));
  const on = { vars: { ...runtimeVars, NFT_MODE_ENABLED: "true" } };
  set(true);
  assert.deepEqual(await checkRuntime(releaseOrigin, on, true, deployedNftManifest), { nftMode: { enabled: true, vaultFactory: nftFactory } });
  await assert.rejects(checkRuntime(releaseOrigin, on), /without the committed verified vault factory/, "the committed manifest is not deployed yet");
  set(true, null);
  await assert.rejects(checkRuntime(releaseOrigin, on, true, deployedNftManifest), /without the committed verified vault factory/);
  set(true, "0x6666666666666666666666666666666666666666");
  await assert.rejects(checkRuntime(releaseOrigin, on, true, deployedNftManifest), /without the committed verified vault factory/);
  set(false);
  await assert.rejects(checkRuntime(releaseOrigin, on, true, deployedNftManifest), /NFT mode runtime differs/, "the committed flag is on but the runtime is off");
  set(true);
  await assert.rejects(checkRuntime(releaseOrigin, { vars: { ...runtimeVars, NFT_MODE_ENABLED: "TRUE" } }, true, deployedNftManifest), /NFT mode runtime differs/,
    "only the exact string true enables NFT mode");
  Object.assign(responses["/api/chains/8453/config"], { nftMode: nftConfig(8453, true) });
  await assert.rejects(checkRuntime(releaseOrigin, on, true, deployedNftManifest), /NFT mode runtime differs.*8453/, "Base stays locked");
  for (const malformed of [null, { enabled: "true", vaultFactory: null }, { enabled: true, vaultFactory: "factory" }, { enabled: false }])
    assert.throws(() => nftModeRuntime(malformed), /NFT mode runtime configuration is malformed/);
  assert.deepEqual(nftModeRuntime(undefined), { enabled: false, vaultFactory: null });
});

test("a flag-on release whose database lacks the NFT single-use indexes fails the runtime check: the runtime reports NFT mode off", async context => {
  // The real /config of a Robinhood runtime with the flag on and the verified factory, over a store with or without the guards.
  const runtimeNftMode = async (guards: boolean) => {
    const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: runtimeVars.PLATFORM_TREASURY, writesEnabled: true,
      blockReason: null, nftMode: nftConfig(4663, true) } as RuntimeConfig;
    const service = Object.assign(Object.create(LaunchpadService.prototype), {
      runtime: { config, nftVaultManifest: deployedNftManifest }, assertNetwork: async () => {}, verifiedVaultFactory: async () => nftFactory,
      store: { nftGuardsReady: async () => guards, runtimeControl: async () => ({ revision: 1, paused: false, reason: "" }) },
    }) as LaunchpadService;
    return (await service.config(true)).nftMode;
  };
  let responses = runtimeResponses();
  context.mock.method(globalThis, "fetch", async (url: string) => Response.json(responses[new URL(url).pathname as keyof typeof responses]));
  const on = { vars: { ...runtimeVars, NFT_MODE_ENABLED: "true" } };
  for (const guards of [true, false]) {
    responses = runtimeResponses();
    const nftMode = await runtimeNftMode(guards);
    for (const path of ["/api/config", "/api/chains/4663/config"] as const) Object.assign(responses[path], { nftMode });
    Object.assign(responses["/api/chains/8453/config"], { nftMode: nftConfig(8453, false) });
    if (guards) assert.deepEqual(await checkRuntime(releaseOrigin, on, true, deployedNftManifest), { nftMode: { enabled: true, vaultFactory: nftFactory } });
    else await assert.rejects(checkRuntime(releaseOrigin, on, true, deployedNftManifest), /NFT mode runtime differs from the committed release .*\(4663\)/,
      "the committed flag is on, but without migration 20261014120000 the runtime reports NFT mode off");
  }
});

test("the functional smoke lists NFT coins only for an enabled runtime and keeps the flag-off smoke unchanged", async context => {
  context.mock.method(console, "log", () => {}); // the smoke's own "not_run" notes for this empty catalog
  let listing: unknown = [{ address: runtimeVars.PLATFORM_TREASURY, nft: { chainId: 4663, contract: nftFactory, tokenId: "1" } }], status = 200;
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string) => {
    const target = new URL(url); paths.push(`${target.pathname}${target.search}`);
    if (target.pathname.endsWith("/first-buy/prices")) return Response.json({ assets: [{ priceUsd: "1" }, { priceUsd: "2500" }] });
    if (target.pathname.endsWith("/stocks")) return Response.json([{ verified: true }]);
    if (target.pathname.endsWith("/tokens") && target.search === "?nft=any") return status === 200 ? Response.json(listing) : new Response(null, { status });
    if (target.pathname.endsWith("/tokens")) return Response.json({ items: [], nextCursor: null });
    return new Response(null, { status: 404 });
  });
  const disabled = await checkFunctionalSmoke(releaseOrigin, false);
  assert.equal(paths.some(path => path.includes("nft=")), false, "a disabled or pre-NFT runtime gets exactly the earlier smoke");
  assert.equal(disabled[0].nftListing, "not_run");
  paths.length = 0;
  const enabled = await checkFunctionalSmoke(releaseOrigin, false, true, ADMITTED_BASE_ASSET_COUNT, true);
  assert(paths.includes("/api/chains/4663/tokens?nft=any"));
  assert.equal(enabled[0].nftListing, "passed"); assert.equal(enabled[0].nftCoins, 1);
  listing = [];
  assert.equal((await checkFunctionalSmoke(releaseOrigin, false, true, ADMITTED_BASE_ASSET_COUNT, true))[0].nftCoins, 0, "an empty listing is valid");
  for (const bad of [{ items: [] }, [{ address: runtimeVars.PLATFORM_TREASURY }], [{ nft: { chainId: 8453 } }], [null]]) {
    listing = bad;
    await assert.rejects(checkFunctionalSmoke(releaseOrigin, false, true, ADMITTED_BASE_ASSET_COUNT, true), /malformed NFT coin listing/);
  }
  status = 404;
  await assert.rejects(checkFunctionalSmoke(releaseOrigin, false, true, ADMITTED_BASE_ASSET_COUNT, true), /HTTP 404/);
});

test("supportsNftMode reads the rollback target's marker; a target without it counts as NFT mode disabled", () => {
  assert.equal(supportsNftMode(readFileSync(new URL("../src/lib/nft-mode.ts", import.meta.url), "utf8")), true, "this release carries the marker");
  assert.equal(supportsNftMode("export const NFT_MODE_PROTOCOL = 1;\n"), true);
  for (const source of [undefined, "", "export const NFT_LAUNCH_RIGHTS = 1;", "// export const NFT_MODE_PROTOCOL = 1;", "export const NFT_MODE_PROTOCOL = 2;",
    "export const NFT_MODE_PROTOCOL = 10;"])
    assert.equal(supportsNftMode(source), false);
});

test("the NFT rollback floor applies only when the candidate enables NFT mode, so the first flag-off release is not blocked", async () => {
  for (const candidateVars of [{}, { NFT_MODE_ENABLED: "false" }, { NFT_MODE_ENABLED: "TRUE" }] as Record<string, string>[])
    assert.equal(nftRollbackCompatible({ candidateVars, previousNftMode: false }), true, `flag off: ${JSON.stringify(candidateVars)}`);
  assert.equal(nftRollbackCompatible({ candidateVars: { NFT_MODE_ENABLED: "true" }, previousNftMode: false }), false, "no enabling over a pre-NFT rollback target");
  assert.equal(nftRollbackCompatible({ candidateVars: { NFT_MODE_ENABLED: "true" }, previousNftMode: true }), true);
  // In the pipeline, an incompatible floor stops the release before anything is uploaded.
  const { flow, events } = lifecycle();
  flow.rollbackAllowed = async () => nftRollbackCompatible({ candidateVars: { NFT_MODE_ENABLED: "true" }, previousNftMode: supportsNftMode("export const BASE_RECOVERY_PROTOCOL = 7;") });
  await assert.rejects(publishCandidate(flow), (error: unknown) => error instanceof ReleaseFailure && error.rollback === "blocked_by_safety");
  assert.equal(events.includes("upload"), false);
  const compatible = lifecycle().flow;
  compatible.rollbackAllowed = async () => nftRollbackCompatible({ candidateVars: { NFT_MODE_ENABLED: "true" }, previousNftMode: true });
  assert.equal(await publishCandidate(compatible), "success");
});

test("a blocked release names the NFT rollback floor when that is what fails, and keeps the earlier message otherwise", async () => {
  const pending = structuredClone(BASE_COLLECTOR_MANIFEST);
  pending.activation = { status: "not_run" }; pending.canaryAuthorization = null; pending.status = "not_deployed";
  Object.assign(pending.collector, { address: null, runtimeHash: null, transactionHash: null, blockNumber: null });
  const base = { previousVars: { RUNTIME_SECURITY_PROTOCOL: "1" } as Record<string, string>, candidateVars: {} as Record<string, string>,
    candidateManifest: pending, previousRecoveryProtocol: false, previousNftMode: false };
  const earlier = "Base rollback source or Collector graph is incompatible; production was not changed.";
  assert.equal(await rollbackBlockReason(base), null, "the first flag-off NFT release over a pre-NFT target is compatible");
  assert.match(await rollbackBlockReason({ ...base, candidateVars: { NFT_MODE_ENABLED: "true" } }) ?? "",
    /^NFT mode cannot be enabled while the rollback target lacks NFT support \(NFT_MODE_PROTOCOL\)/);
  assert.equal(await rollbackBlockReason({ ...base, candidateVars: { NFT_MODE_ENABLED: "true" }, previousNftMode: true }), null);
  assert.equal(await rollbackBlockReason({ ...base, previousVars: {} }), earlier, "the runtime-safety baseline keeps its message");
  assert.equal(await rollbackBlockReason({ ...base, candidateVars: { ENABLE_BASE_TRANSACTIONS: "true" } }), earlier, "the Base graph keeps its message");
});

test("a rollback never re-enables NFT mode that the candidate turned off, like the chain signing flags", async () => {
  const on = { RUNTIME_SECURITY_PROTOCOL: "1", NFT_MODE_ENABLED: "true" }, off = { RUNTIME_SECURITY_PROTOCOL: "1", NFT_MODE_ENABLED: "false" };
  assert.equal(rollbackPreservesSafety(on, off), false, "the live version has NFT mode on and the candidate turns it off");
  assert.equal(rollbackPreservesSafety(on, { RUNTIME_SECURITY_PROTOCOL: "1" }), false, "an absent flag is off");
  assert.equal(rollbackPreservesSafety(on, { ...on, NFT_MODE_ENABLED: "TRUE" }), false, "only the exact string true is on");
  assert.equal(rollbackPreservesSafety(off, on), true, "rolling back to NFT mode off is always safe");
  assert.equal(rollbackPreservesSafety(on, on), true);
  assert.equal(rollbackPreservesSafety(off, off), true);
  assert.equal(rollbackPreservesSafety({ ...on, NFT_MODE_ENABLED: "TRUE" }, off), true, "a previous version whose flag is not exactly true has NFT mode off");
  // The chain flags keep their rule beside the NFT flag.
  assert.equal(rollbackPreservesSafety({ ...on, ENABLE_ROBINHOOD_TRANSACTIONS: "true" }, { ...on, ENABLE_ROBINHOOD_TRANSACTIONS: "false" }), false);
  assert.equal(rollbackPreservesSafety({ ...on, ENABLE_BASE_TRANSACTIONS: "false" }, { ...on, ENABLE_BASE_TRANSACTIONS: "true" }), true);
  assert.equal(rollbackPreservesSafety({ ...on, RUNTIME_SECURITY_PROTOCOL: "0" }, on), false);

  const pending = structuredClone(BASE_COLLECTOR_MANIFEST);
  pending.activation = { status: "not_run" }; pending.canaryAuthorization = null; pending.status = "not_deployed";
  Object.assign(pending.collector, { address: null, runtimeHash: null, transactionHash: null, blockNumber: null });
  const input = { previousVars: on as Record<string, string>, candidateVars: off as Record<string, string>, candidateManifest: pending,
    previousRecoveryProtocol: false, previousNftMode: true };
  assert.equal(await rollbackBlockReason(input),
    "A rollback would re-enable NFT mode, which this release turns off (NFT_MODE_ENABLED); turn it off on the live version first. Production was not changed.",
    "the NFT kill switch is named");
  assert.equal(await rollbackBlockReason({ ...input, previousVars: off }), null, "turning NFT mode on, or keeping it off, is not blocked by it");
  assert.equal(await rollbackBlockReason({ ...input, candidateVars: on }), null, "keeping NFT mode on is not blocked by it");
  assert.equal(await rollbackBlockReason({ ...input, previousVars: { ...off, ENABLE_BASE_TRANSACTIONS: "true" } }),
    "Base rollback source or Collector graph is incompatible; production was not changed.", "a lost chain flag keeps its message");

  // In the pipeline the release stops before upload, so a later verification failure can never roll back to NFT mode on.
  const { flow, events } = lifecycle();
  flow.rollbackAllowed = async () => await rollbackBlockReason(input) === null;
  flow.verify = async () => { events.push("verify"); throw new Error("unrelated verification failure"); };
  await assert.rejects(publishCandidate(flow), (error: unknown) => error instanceof ReleaseFailure && error.rollback === "blocked_by_safety");
  assert.equal(events.includes("upload"), false);
  assert.equal(events.some((event) => event.startsWith("activate:")), false);
});
