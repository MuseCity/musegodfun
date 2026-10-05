import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildInfo } from "../src/lib/build-info";
import { assertBuildManifest, assertFrozenBuild, assertReleaseCheckout, publishCandidate, ReleaseFailure, requireSingleActiveVersion, runtimeVarsFromBindings, snapshotBuild, type ReleaseLifecycle } from "../scripts/release-policy";

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
