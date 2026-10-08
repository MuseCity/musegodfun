import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../src/lib/api";
import { clearRecoveryBackoff, nextRecoveryAttempt, recordRecoveryFailure, recoveryDue, recoveryKey, RECOVERY_MAX_BACKOFF_MS, RECOVERY_POLL_MS } from "../src/lib/recovery-backoff";

test("api returns a long server-requested wait to the caller instead of retrying after three seconds", async (context) => {
  let calls = 0, retryAfter = "60";
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ error: "Service capacity is temporarily limited.", code: "CAPACITY_LIMITED" }),
      { status: 429, headers: { "retry-after": retryAfter, "content-type": "application/json" } });
  });
  const error = await api("/launch/register", { hash: "0x" }).catch((caught: unknown) => caught);
  assert(error instanceof ApiError); assert.equal(error.status, 429); assert.equal(error.retryAfter, 60);
  assert.equal(calls, 1, "no automatic retry against a 60 second Retry-After");
  calls = 0; retryAfter = "0";
  const short = await api("/launch/register", { hash: "0x" }).catch((caught: unknown) => caught);
  assert(short instanceof ApiError); assert.equal(calls, 3, "short capacity waits are still retried automatically");
});

test("background recovery backs off per record, honours Retry-After, and a success or manual check clears it", () => {
  const now = 1_000_000;
  let state = nextRecoveryAttempt(undefined, new Error("rejected"), now);
  assert.deepEqual(state, { failures: 1, nextAt: now + RECOVERY_POLL_MS });
  state = nextRecoveryAttempt(state, new Error("rejected"), now);
  assert.equal(state.nextAt, now + 2 * RECOVERY_POLL_MS);
  for (let i = 0; i < 30; i++) state = nextRecoveryAttempt(state, new Error("rejected"), now);
  assert.equal(state.nextAt, now + RECOVERY_MAX_BACKOFF_MS, "the wait is capped");
  assert.equal(nextRecoveryAttempt(undefined, new ApiError("busy", 429, "CAPACITY_LIMITED", 120), now).nextAt, now + 120_000);
  const key = recoveryKey(4663, `0x${"AB".repeat(32)}`);
  assert.equal(recoveryDue(key, now), true);
  recordRecoveryFailure(key, new Error("rejected"), now);
  assert.equal(recoveryDue(key, now + RECOVERY_POLL_MS - 1), false);
  assert.equal(recoveryDue(key, now + RECOVERY_POLL_MS), true);
  recordRecoveryFailure(key, new Error("rejected"), now);
  clearRecoveryBackoff(key);
  assert.equal(recoveryDue(key, now), true);
});
