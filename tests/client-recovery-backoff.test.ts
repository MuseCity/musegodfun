import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../src/lib/api";
import { bestEffort, clearRecoveryBackoff, nextRecoveryAttempt, recordRecoveryFailure, recordServerWait, recoveryDue, recoveryKey, RECOVERY_MAX_BACKOFF_MS, RECOVERY_POLL_MS, settleRecovery } from "../src/lib/recovery-backoff";
import { checkHistoryTransaction } from "../src/components/TransactionHistory";
import type { Transaction } from "../src/lib/transactions";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const account = "0x1111111111111111111111111111111111111111" as const;
const blockHash = `0x${"ab".repeat(32)}` as const;
function receiptClient(row: Transaction, head: bigint) {
  return { getChainId: async () => row.chainId,
    getTransactionReceipt: async () => ({ status: "success" as const, from: account, transactionHash: row.hash, blockNumber: 10n, blockHash }),
    getBlockNumber: async () => head, getBlock: async () => ({ hash: blockHash }) };
}

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

test("a launch's queueing request that asks for Retry-After 60 holds the whole record for 60 seconds", async (context) => {
  let status = 429;
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "Service capacity is temporarily limited.", code: "CAPACITY_LIMITED" }),
    { status, headers: { ...(status === 429 ? { "retry-after": "60" } : {}), "content-type": "application/json" } }));
  const key = recoveryKey(4663, `0x${"CD".repeat(32)}`);
  let checked = 0;
  const backgroundPass = () => settleRecovery(key, async () => {
    await bestEffort(() => api("/chains/4663/launch/track", { hash: "0x", planId: "0x" }));
    checked++;
  });
  const before = Date.now();
  await assert.rejects(backgroundPass, (error: unknown) => error instanceof ApiError && error.retryAfter === 60);
  const after = Date.now();
  assert.equal(checked, 0, "the record's check waits with it");
  assert.equal(recoveryDue(key, before + RECOVERY_POLL_MS), false, "not retried on the next 15 second poll");
  assert.equal(recoveryDue(key, before + 59_999), false);
  assert.equal(recoveryDue(key, after + 60_000), true);
  // Other failures of the best-effort request are still ignored.
  status = 400; clearRecoveryBackoff(key);
  await backgroundPass();
  assert.equal(checked, 1); assert.equal(recoveryDue(key), true);
});

test("a check that completes, even finding the transaction still pending, clears the record's backoff; a failure extends it", async () => {
  const key = recoveryKey(4663, `0x${"EF".repeat(32)}`), now = Date.now();
  recordRecoveryFailure(key, new ApiError("busy", 429, "CAPACITY_LIMITED", 600), now);
  assert.equal(recoveryDue(key, now + 599_000), false);
  await settleRecovery(key, async () => { /* receipt found with one confirmation: still pending */ });
  assert.equal(recoveryDue(key, now), true, "a manual Check again that returns pending resets the wait");
  await assert.rejects(() => settleRecovery(key, async () => { throw new ApiError("busy", 429, "CAPACITY_LIMITED", 120); }), /busy/);
  assert.equal(recoveryDue(key, Date.now() + 119_000), false, "a failed manual check still respects the server's wait");
  clearRecoveryBackoff(key);
});

test("a failed manual check never lengthens the background wait, except to honour a wait the server asked for", async () => {
  const key = recoveryKey(4663, `0x${"AC".repeat(32)}`), now = Date.now();
  recordRecoveryFailure(key, new Error("not mined yet"), now);
  const due = now + RECOVERY_POLL_MS;
  // The transaction is still unmined: a manual check fails without the server asking for a wait.
  for (let i = 0; i < 3; i++) await assert.rejects(() => settleRecovery(key, async () => { throw new Error("receipt not found"); }, true), /receipt not found/);
  assert.equal(recoveryDue(key, due), true, "pressing Check again does not push the background poll back");
  await assert.rejects(() => settleRecovery(key, async () => { throw new ApiError("busy", 429, "CAPACITY_LIMITED", 45); }, true), /busy/);
  assert.equal(recoveryDue(key, Date.now() + 44_000), false, "the server's own wait is kept");
  assert.equal(recoveryDue(key, Date.now() + 46_000), true, "without counting another failure");
  await settleRecovery(key, async () => {}, true);
  assert.equal(recoveryDue(key, now), true, "a completed manual check clears it");
});

for (const oldManual of [false, true]) {
  test(`an older ${oldManual ? "manual" : "background"} receipt check cannot clear a newer server wait`, async context => {
    const now = 1_000_000;
    context.mock.method(Date, "now", () => now);
    const row: Transaction = { hash: `0x${(oldManual ? "a1" : "a2").repeat(32)}`, chainId: 4663, account,
      action: "launch", status: "pending", at: now };
    const key = recoveryKey(row.chainId, row.hash), block = deferred<{ hash: typeof blockHash }>(), readingBlock = deferred<void>();
    const client = { ...receiptClient(row, 10n), getBlock: () => { readingBlock.resolve(); return block.promise; } };
    const updates: Partial<Transaction>[] = [];
    const older = settleRecovery(key, () => checkHistoryTransaction(row, {
      client: client as never, update: patch => updates.push(patch),
    }), oldManual);
    await readingBlock.promise;
    const busy = new ApiError("busy", 429, "CAPACITY_LIMITED", 60);
    try {
      if (oldManual) {
        // A newer background track response holds the whole record before its receipt check.
        await assert.rejects(() => settleRecovery(key, () => bestEffort(async () => { throw busy; })), /busy/);
      } else {
        // A newer manual check sees two confirmations, then registration asks it to wait.
        await assert.rejects(() => settleRecovery(key, () => checkHistoryTransaction(row, {
          client: receiptClient(row, 11n) as never, update: patch => updates.push(patch),
          read: async () => { throw busy; },
        }), true), /busy/);
      }
      assert.equal(recoveryDue(key, now + 59_999), false);
      block.resolve({ hash: blockHash }); await older;
      assert(updates.some(patch => patch.status === "pending"), "the old one-confirmation check completed normally");
      assert.equal(recoveryDue(key, now + 59_999), false, "its completion cannot erase the newer Retry-After");
      assert.equal(recoveryDue(key, now + 60_000), true);
    } finally { block.resolve({ hash: blockHash }); await older; clearRecoveryBackoff(key); }
  });
}

test("an old receipt failure cannot recreate backoff after a newer manual pending check cleared it", async context => {
  const now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  const row: Transaction = { hash: `0x${"a3".repeat(32)}`, chainId: 4663, account, action: "launch", status: "pending", at: now };
  const key = recoveryKey(row.chainId, row.hash), receipt = deferred<never>(), readingReceipt = deferred<void>();
  recordRecoveryFailure(key, new ApiError("busy", 429, "CAPACITY_LIMITED", 600), now);
  const older = settleRecovery(key, () => checkHistoryTransaction(row, {
    client: { ...receiptClient(row, 10n), getTransactionReceipt: () => { readingReceipt.resolve(); return receipt.promise; } } as never,
    update: () => {},
  }));
  const rejected = assert.rejects(older, /old RPC failure/);
  await readingReceipt.promise;
  try {
    await settleRecovery(key, () => checkHistoryTransaction(row, { client: receiptClient(row, 10n) as never, update: () => {} }), true);
    assert.equal(recoveryDue(key, now), true);
    receipt.reject(new Error("old RPC failure")); await rejected;
    assert.equal(recoveryDue(key, now), true, "the stale failure is returned but cannot reinstate the cleared wait");
  } finally { receipt.reject(new Error("old RPC failure")); await rejected; clearRecoveryBackoff(key); }
});

test("a shorter ordinary failure or server wait cannot shorten an existing Retry-After", () => {
  const now = 1_000_000, key = recoveryKey(4663, `0x${"a4".repeat(32)}`);
  const previous = nextRecoveryAttempt(undefined, new ApiError("busy", 429, "CAPACITY_LIMITED", 120), now);
  const next = nextRecoveryAttempt(previous, new Error("receipt not found"), now + 1_000);
  assert.equal(next.nextAt, now + 120_000); assert.equal(next.failures, 2);
  try {
    recordRecoveryFailure(key, new ApiError("busy", 429, "CAPACITY_LIMITED", 120), now);
    recordRecoveryFailure(key, new Error("receipt not found"), now + 1_000);
    recordServerWait(key, new ApiError("busy", 429, "CAPACITY_LIMITED", 30), now + 2_000);
    assert.equal(recoveryDue(key, now + 119_999), false);
    assert.equal(recoveryDue(key, now + 120_000), true);
    recordServerWait(key, new ApiError("busy", 429, "CAPACITY_LIMITED", 180), now + 3_000);
    assert.equal(recoveryDue(key, now + 182_999), false);
    assert.equal(recoveryDue(key, now + 183_000), true, "a genuinely longer server wait still extends it");
  } finally { clearRecoveryBackoff(key); }
});

for (const directFailure of [false, true]) {
  test(`a directly recorded ${directFailure ? "failure" : "server wait"} cannot be cleared by an earlier check`, async context => {
    const now = 1_000_000;
    context.mock.method(Date, "now", () => now);
    const key = recoveryKey(4663, `0x${(directFailure ? "a5" : "a6").repeat(32)}`), check = deferred<void>();
    const older = settleRecovery(key, () => check.promise);
    const busy = new ApiError("busy", 429, "CAPACITY_LIMITED", 60);
    if (directFailure) recordRecoveryFailure(key, busy); else recordServerWait(key, busy);
    try {
      assert.equal(recoveryDue(key, now + 59_999), false);
      check.resolve(); await older;
      assert.equal(recoveryDue(key, now + 59_999), false, "a wait recorded since the check started remains intact");
      assert.equal(recoveryDue(key, now + 60_000), true);
    } finally { check.resolve(); await older; clearRecoveryBackoff(key); }
  });
}

test("a direct clear invalidates an earlier check's later failure", async context => {
  const now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  const key = recoveryKey(4663, `0x${"a7".repeat(32)}`), check = deferred<void>();
  recordRecoveryFailure(key, new ApiError("busy", 429, "CAPACITY_LIMITED", 60));
  const older = settleRecovery(key, () => check.promise), rejected = assert.rejects(older, /old RPC failure/);
  clearRecoveryBackoff(key);
  try {
    assert.equal(recoveryDue(key, now), true);
    check.reject(new Error("old RPC failure")); await rejected;
    assert.equal(recoveryDue(key, now), true, "a stale failure cannot undo an explicit clear");
  } finally { check.reject(new Error("old RPC failure")); await rejected; clearRecoveryBackoff(key); }
});
