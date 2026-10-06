import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveDeploymentManifest, verifyAutomationReceiver, verifyModuleBindings, automationConfiguration, forwarderConfiguration, engineDeploymentAllowed } from "../scripts/deploy-buyback-engine";

test("deployment recovery rejects the same contract code bound to a different graph", async () => {
  const expected = { weth: "0x0000000000000000000000000000000000000001", swapper: "0x0000000000000000000000000000000000000002", automation: "0x0000000000000000000000000000000000000003", ethMaxAge: 86400 };
  await verifyModuleBindings(async (name) => expected[name as keyof typeof expected], expected);
  await assert.rejects(verifyModuleBindings(async (name) => name === "swapper" ? expected.weth : expected[name as keyof typeof expected], expected), /swapper deployment binding differs/);
  await assert.rejects(verifyModuleBindings(async (name) => name === "automation" ? expected.swapper : expected[name as keyof typeof expected], expected), /automation deployment binding differs/);
  await assert.rejects(verifyModuleBindings(async (name) => name === "ethMaxAge" ? 3600 : expected[name as keyof typeof expected], expected), /ethMaxAge deployment binding differs/);
});

test("deployment journal replaces a complete durable file and cleans failed replacements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "musegod-deployment-journal-"));
  try {
    const path = join(directory, "deployment.json");
    await writeFile(path, '{"status":"old"}\n');
    await saveDeploymentManifest(path, { status: "broadcasting", nonce: 3, gasLimit: 12n });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { status: "broadcasting", nonce: 3, gasLimit: "12" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["deployment.json"]);
    const invalidTarget = join(directory, "occupied");
    await mkdir(invalidTarget);
    await writeFile(join(invalidTarget, "retained"), "retain prior evidence");
    await assert.rejects(saveDeploymentManifest(invalidTarget, { status: "new" }));
    assert.equal(await readFile(join(invalidTarget, "retained"), "utf8"), "retain prior evidence");
    assert((await readdir(directory)).every((file) => !file.endsWith(".tmp")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Automation deployment needs a separate deployed smart account before any broadcast", () => {
  const account = "0x0000000000000000000000000000000000000011" as const;
  const operations = "0x0000000000000000000000000000000000000012" as const;
  verifyAutomationReceiver(account, operations, "0x6000");
  assert.throws(() => verifyAutomationReceiver(null, operations, null), /public address before deployment/);
  assert.throws(() => verifyAutomationReceiver(operations, operations, "0x6000"), /separate from operations/);
  assert.throws(() => verifyAutomationReceiver(account, operations, "0x"), /deployed smart account/);
  assert.throws(() => verifyAutomationReceiver(account, operations, "0x6000", {automation:account,swapperFactory:account}), /protocol dependency/);
  assert.throws(() => verifyAutomationReceiver(account, operations, "0x6000", {automation:account}, [account]), /protocol dependency/);
});

test("deployment reverification retains existing native rule evidence only for the same graph", () => {
  const expected = {account:"0x0000000000000000000000000000000000000011" as const,network:4663,outputToken:"0x0000000000000000000000000000000000000012" as const,allocationBps:10000,recipient:"0x0000000000000000000000000000000000000013" as const};
  const configured = {status:"configured",...expected,ruleSignature:{transactionHash:"recorded_public_hash"},nativeExecution:{transactionHash:"observed_receipt"}};
  assert.deepEqual(automationConfiguration(configured,expected),configured);
  const rebound = automationConfiguration(configured,{...expected,recipient:expected.account});
  assert.equal(rebound.status,"pending_rule_signature");
  assert.equal(rebound.ruleSignature,"not_run");
  assert.equal(rebound.nativeExecution,"not_run");
  assert.equal(automationConfiguration(undefined,expected).status,"pending_rule_signature");
});

test("bootstrap can validate a counterfactual address but cannot authorize an Engine with missing code", () => {
  const account="0x0000000000000000000000000000000000000011" as const,operations="0x0000000000000000000000000000000000000012" as const;
  verifyAutomationReceiver(account,operations,"0x",{},[],false);
  assert.throws(() => verifyAutomationReceiver(account,operations,"0x"),/deployed smart account/);
  assert.throws(() => verifyAutomationReceiver(account,operations,"0x",{automation:account,oracle:account},[],false),/protocol dependency/);
});
test("bridge reverification preserves human WETH approval and native receipt evidence for the same graph", () => {
  const expected={source:"0x0000000000000000000000000000000000000011" as const,spender:"0x0000000000000000000000000000000000000012" as const,token:"0x0000000000000000000000000000000000000013" as const,recipient:"0x0000000000000000000000000000000000000014" as const};
  const observed={...expected,approval:{hash:"recorded_approval"},nativeExecution:{hash:"observed_receipt"}};
  assert.deepEqual(forwarderConfiguration(observed,expected),observed);
  assert.equal(forwarderConfiguration(observed,{...expected,spender:expected.source}).approval,"not_granted_by_deployment");
});

test("Engine production permission requires full review, real receiver code and explicit nonfixture evidence", () => {
  const real={accountCodeFixtures:[],policyMetadataFixtureOnly:false};
  assert.equal(engineDeploymentAllowed("passed","0x6000",real),true);
  assert.equal(engineDeploymentAllowed("passed_for_bootstrap","0x6000",real),false);
  assert.equal(engineDeploymentAllowed("passed","0x",real),false);
  assert.equal(engineDeploymentAllowed("passed","0x6000",{...real,policyMetadataFixtureOnly:true}),false);
  assert.equal(engineDeploymentAllowed("passed","0x6000",{accountCodeFixtures:[]}),false);
  assert.equal(engineDeploymentAllowed("passed","0x6000",{...real,accountCodeFixtures:[{address:"fixture"}]}),false);
  assert.equal(engineDeploymentAllowed("passed","0x6000",{policyMetadataFixtureOnly:false}),false);
});
