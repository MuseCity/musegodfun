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
      tokenByTxHash: async () => null,
      deferLaunch: async () => {},
    },
    client: {
      getBlock: async () => { throw new Error("Finalized block tag is unavailable"); },
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
  return { service, hashes, attempted, advance: (duration: number) => { now += duration; }, remove: (hash: Hex) => { rows = rows.filter((row) => row.hash !== hash); } };
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

test("default bounded Node reconciliation completes a short queue", async (t) => {
  const { service, hashes, attempted } = fixture(t);
  await service.reconcile();
  assert.deepEqual(attempted, hashes);
});

test("empty Base and Robinhood launch queues perform no RPC reads", async t => {
  for(const [mode,chainId] of [["base",8453],["robinhood",4663]] as const){
    const f=fixture(t);f.hashes.forEach(f.remove);let rpc=0;
    Object.assign(f.service,{runtime:{config:{mode,chainId},dataScope:mode},assertNetwork:async()=>{rpc++;}});
    t.mock.method(f.service.client,"getBlock",async()=>{rpc++;throw new Error("Empty queue must not query finalized blocks");});
    await f.service.reconcile(60);await f.service.reconcile(60);
    assert.equal(rpc,0,mode);assert.deepEqual(f.attempted,[]);
  }
});

test("public queue errors propagate and a pending queue read retains singleflight before normal receipt recovery", async t => {
  const f=fixture(t);let reads=0,network=0,release!:()=>void;
  const queued=f.service.store.pendingLaunches.bind(f.service.store),held=new Promise<void>(resolve=>{release=resolve;});
  Object.assign(f.service,{assertNetwork:async()=>{network++;}});
  t.mock.method(f.service.store,"pendingLaunches",async()=>{reads++;if(reads===1)throw new Error("Database unavailable");if(reads===2)await held;return queued();});
  await assert.rejects(f.service.reconcile(60),/Database unavailable/);
  assert.equal(network,0,"Database failure is not an empty or successfully recovered queue");
  const active=f.service.reconcile(60);await Promise.resolve();await f.service.reconcile(60);
  assert.equal(reads,2,"A pending database read cannot start a second maintenance turn");assert.equal(network,0);
  release();await active;
  assert.equal(network,1);assert.deepEqual(f.attempted,f.hashes.slice(0,2),"A recovered nonempty queue keeps the existing RPC, receipt and time-budget behavior");
  f.hashes.forEach(f.remove);await f.service.reconcile(60);assert.equal(network,1,"The settled lease also permits the next empty turn to end without RPC");
});

test("default Node maintenance bounds slow receipt work to sixty seconds", async (t) => {
  const { service, hashes, attempted, advance } = fixture(t);
  const receipt = service.client.getTransactionReceipt;
  t.mock.method(service.client,"getTransactionReceipt",async(parameters:any)=>{advance(40_000);return receipt(parameters)});
  await service.reconcile();
  assert.deepEqual(attempted,hashes.slice(0,2),"The default deadline stops before starting a third slow receipt");
});

test("bounded reconciliation continues when the previous cursor leaves the queue", async (t) => {
  const { service, hashes, attempted, remove } = fixture(t);
  await service.reconcile(40);
  remove(hashes[0]);
  await service.reconcile(40);
  assert.deepEqual(attempted, hashes.slice(0, 2));
});
