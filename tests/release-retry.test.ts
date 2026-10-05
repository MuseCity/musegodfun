import test from "node:test";
import assert from "node:assert/strict";
import { verifyProductionCandidate } from "../scripts/release";
import { publishCandidate, ReleaseFailure } from "../scripts/release-policy";

const candidate = "22222222-2222-4222-8222-222222222222", previous = "11111111-1111-4111-8111-111111111111";
const origins = ["https://musegod.fun", "https://www.musegod.fun"];

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
  assert.deepEqual(c.waits, [10_000]);
  assert.match(c.messages[0], /attempt 1\/3 failed.*HTTP 404/);
});

test("CI retry budget permits exactly three failed attempts and two ten-second waits", async () => {
  const c = checks();
  c.verifyOrigin = async origin => { c.visited.push(origin); throw new Error("persistent file hash mismatch"); };
  await assert.rejects(() => verifyProductionCandidate(candidate, c), /failed after 3 complete attempts/);
  assert.deepEqual(c.visited, [origins[0], origins[0], origins[0]]);
  assert.deepEqual(c.waits, [10_000, 10_000]);
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
  assert.deepEqual(c.waits, [10_000, 10_000]);
});
