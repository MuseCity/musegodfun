import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { LaunchpadService } from "../server/service";

function fixture(t: TestContext) {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const hashes = [1, 2, 3, 4].map((n) => `0x${String(n).padStart(64, "0")}` as Hex);
  let rows = hashes.map((hash, index) => ({
    hash, planId: hash, status: index === 0 ? "confirmed" : "pending", blockHash: null,
  }));
  const attempted: Hex[] = [];
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    assertNetwork: async () => {},
    store: {
      pendingLaunches: async () => [...rows],
      tokens: async () => [],
    },
    client: {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        attempted.push(hash);
        now += 40;
        if (hash !== hashes[0]) throw new Error("Receipt RPC timed out");
        return { status: "success" };
      },
    },
    register: async (hash: Hex) => {
      // Successful registration refreshes updated_at, moving the confirmed row
      // behind unresolved rows in the database's next ordered queue snapshot.
      const row = rows.find((candidate) => candidate.hash === hash)!;
      rows = [...rows.filter((candidate) => candidate.hash !== hash), row];
    },
  }) as LaunchpadService;
  return { service, hashes, attempted, remove: (hash: Hex) => { rows = rows.filter((row) => row.hash !== hash); } };
}

test("bounded reconciliation finishes the current row and resumes past slow pending receipts", async (t) => {
  const { service, hashes, attempted } = fixture(t);
  await service.reconcile(60);
  assert.deepEqual(attempted, hashes.slice(0, 2), "Stop starting new rows when the budget expires");
  await service.reconcile(60);
  assert.deepEqual(attempted, hashes, "An unresolved earlier receipt must not starve the remaining queue");
  await service.reconcile(60);
  assert.deepEqual(attempted.slice(4), [hashes[0], hashes[1]], "Continue checking earlier rows on the following pass");
});

test("reconciliation without a budget retains the complete Node queue pass", async (t) => {
  const { service, hashes, attempted } = fixture(t);
  await service.reconcile();
  assert.deepEqual(attempted, hashes);
});

test("bounded reconciliation continues when the previous cursor leaves the queue", async (t) => {
  const { service, hashes, attempted, remove } = fixture(t);
  await service.reconcile(40);
  remove(hashes[0]);
  await service.reconcile(40);
  assert.deepEqual(attempted, hashes.slice(0, 2));
});
