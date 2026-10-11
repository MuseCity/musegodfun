import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readUploadedCandidate, verifyProductionCandidate } from "../scripts/release";
import { publishCandidate, ReleaseFailure } from "../scripts/release-policy";

const candidate = "22222222-2222-4222-8222-222222222222", previous = "11111111-1111-4111-8111-111111111111";
const origins = ["https://musegod.fun", "https://www.musegod.fun"];

function candidateReads(t: TestContext, responses: (number | Response | Error)[]) {
  const requests: string[] = [], waits: number[] = [];
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  t.after(() => { if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = previousToken; });
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests.push(url);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
    const response = responses.shift();
    assert.notEqual(response, undefined, "unexpected extra version read");
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response;
    return response === 200
      ? Response.json({ success: true, result: { id: candidate, annotations: { "workers/tag": "a".repeat(40) }, resources: { bindings: [] } } })
      : new Response(null, { status: response });
  });
  return {
    requests, waits,
    read: () => readUploadedCandidate("test-account", candidate, async milliseconds => { waits.push(milliseconds); }),
    assertSingleVersion: () => assert.deepEqual(requests, Array(requests.length).fill(`https://api.cloudflare.com/client/v4/accounts/test-account/workers/scripts/musegod-fun/versions/${candidate}`)),
  };
}

test("fresh uploaded candidate metadata retries only its exact version through two pending 404s", async t => {
  const reads = candidateReads(t, [404, 404, 200]);
  const metadata = await reads.read();
  assert.equal(metadata.id, candidate);
  assert.equal(metadata.annotations?.["workers/tag"], "a".repeat(40));
  assert.equal(reads.requests.length, 3);
  assert.deepEqual(reads.waits, [10_000, 10_000]);
  reads.assertSingleVersion();
});

test("exhausted candidate metadata propagation leaves the unique upload unpublished and inactive", async t => {
  const reads = candidateReads(t, [404, 404, 404]);
  const operations: string[] = [], commit = "a".repeat(40);
  await assert.rejects(() => publishCandidate({
    commit, previousVersion: previous, currentMaster: async () => commit, activeVersion: async () => previous,
    assertFrozen: () => {},
    upload: async () => { operations.push("upload"); return (await reads.read()).id; },
    publishRelease: async () => { operations.push("release"); }, createDeployment: async () => { operations.push("deployment"); },
    status: async () => { operations.push("status"); }, activate: async () => { operations.push("activate"); },
    verify: async () => { operations.push("verify"); }, verifyRollback: async () => { operations.push("rollback"); },
  }), /HTTP 404/);
  assert.deepEqual(operations, ["upload"]);
  assert.equal(reads.requests.length, 3);
  assert.deepEqual(reads.waits, [10_000, 10_000]);
  reads.assertSingleVersion();
});

for (const status of [401, 403, 429, 500]) {
  test(`candidate metadata HTTP ${status} fails immediately without retry`, async t => {
    const reads = candidateReads(t, [status]);
    await assert.rejects(() => reads.read(), new RegExp(`HTTP ${status}`));
    assert.equal(reads.requests.length, 1);
    assert.deepEqual(reads.waits, []);
    reads.assertSingleVersion();
  });
}

for (const [name, response, message] of [
  ["network failure", new Error("network unavailable"), /network unavailable/],
  ["invalid JSON", new Response("{", { status: 200 }), /JSON/],
  ["Cloudflare unsuccessful result", Response.json({ success: false }), /Cloudflare read-back failed/],
] as const) {
  test(`candidate metadata ${name} fails immediately without retry`, async t => {
    const reads = candidateReads(t, [response]);
    await assert.rejects(() => reads.read(), message);
    assert.equal(reads.requests.length, 1);
    assert.deepEqual(reads.waits, []);
    reads.assertSingleVersion();
  });
}

test("candidate metadata propagation never uploads again or activates before the read-back succeeds", async t => {
  const reads = candidateReads(t, [404, 200]), operations: string[] = [];
  const commit = "a".repeat(40);
  let active = previous;
  assert.equal(await publishCandidate({
    commit, previousVersion: previous, currentMaster: async () => commit, activeVersion: async () => active,
    assertFrozen: () => {},
    upload: async () => { operations.push("upload"); const result = await reads.read(); assert.deepEqual(operations, ["upload"]); return result.id; },
    publishRelease: async version => { assert.equal(version, candidate); operations.push("release"); },
    createDeployment: async version => { assert.equal(version, candidate); operations.push("deployment"); },
    status: async state => { operations.push(state); },
    activate: async version => { assert.equal(version, candidate); active = version; operations.push("activate"); },
    verify: async version => { assert.equal(version, candidate); operations.push("verify"); },
    verifyRollback: async () => { assert.fail("unexpected rollback"); },
  }), "success");
  assert.deepEqual(operations, ["upload", "release", "deployment", "in_progress", "activate", "verify", "success"]);
  assert.equal(reads.requests.length, 2);
  assert.deepEqual(reads.waits, [10_000]);
  reads.assertSingleVersion();
});

function checks() {
  const visited: string[] = [], waits: number[] = [], messages: string[] = [];
  return {
    visited, waits, messages,
    activeVersion: async () => candidate,
    assertFrozen: () => {},
    verifyOrigin: async (origin: string) => { visited.push(origin); },
    describe: (message: string) => { messages.push(message); },
    wait: async (milliseconds: number) => { waits.push(milliseconds); },
  };
}

test("a transient second-origin failure restarts both domains and only succeeds when one full attempt passes", async () => {
  const c = checks();
  c.verifyOrigin = async origin => {
    c.visited.push(origin);
    if (c.visited.length === 2) throw new Error("HTTP 404 for new CSS during propagation");
  };
  await verifyProductionCandidate(candidate, c);
  assert.deepEqual(c.visited, [...origins, ...origins]);
  assert.deepEqual(c.waits, [60_000]);
  assert.match(c.messages[0], /attempt 1\/3 failed.*HTTP 404/);
});

test("CI retry budget permits exactly three failed attempts and two sixty-second waits", async () => {
  const c = checks();
  c.verifyOrigin = async origin => { c.visited.push(origin); throw new Error("persistent file hash mismatch"); };
  await assert.rejects(() => verifyProductionCandidate(candidate, c), /failed after 3 complete attempts/);
  assert.deepEqual(c.visited, [origins[0], origins[0], origins[0]]);
  assert.deepEqual(c.waits, [60_000, 60_000]);
  assert.match(c.messages.at(-1)!, /retry budget exhausted/);
});

test("a frozen artifact change during a failed check terminates immediately without retry", async () => {
  const c = checks();
  let changed = false;
  c.assertFrozen = () => { if (changed) throw new Error("Frozen artifact changed"); };
  c.verifyOrigin = async () => { changed = true; throw new Error("HTTP 404"); };
  await assert.rejects(() => verifyProductionCandidate(candidate, c), /Frozen artifact changed/);
  assert.deepEqual(c.waits, []);
});

test("an external activation during verification terminates immediately without retry", async () => {
  const c = checks();
  let active = candidate;
  c.activeVersion = async () => active;
  c.verifyOrigin = async () => { active = previous; throw new Error("wrong Worker version"); };
  await assert.rejects(() => verifyProductionCandidate(candidate, c), /Candidate changed during/);
  assert.deepEqual(c.waits, []);
});

test("a persistent failure after the bounded CI retries still uses the existing verified rollback path", async () => {
  const c = checks(), states: string[] = [], activations: string[] = [];
  let active = previous, rollbackChecked = false;
  c.activeVersion = async () => active;
  c.verifyOrigin = async origin => { c.visited.push(origin); throw new Error("persistent CSS 404"); };
  const commit = "a".repeat(40);
  await assert.rejects(() => publishCandidate({
    commit, previousVersion: previous, currentMaster: async () => commit, activeVersion: async () => active,
    assertFrozen: c.assertFrozen, upload: async () => candidate, publishRelease: async () => {}, createDeployment: async () => {},
    status: async state => { states.push(state); },
    activate: async version => { active = version; activations.push(version); },
    verify: version => verifyProductionCandidate(version, c),
    verifyRollback: async version => { assert.equal(version, previous); rollbackChecked = true; },
  }), error => error instanceof ReleaseFailure && error.rollback === "verified");
  assert.equal(active, previous);
  assert.equal(rollbackChecked, true);
  assert.deepEqual(activations, [candidate, previous]);
  assert.deepEqual(states, ["in_progress", "failure"]);
  assert.deepEqual(c.waits, [60_000, 60_000]);
});
