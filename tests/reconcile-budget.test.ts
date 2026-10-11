import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { LaunchpadService } from "../server/service";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";

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

for (const [mode, chainId] of [["robinhood",4663],["base",8453]] as const) test(`a busy ${mode} receipt queue cannot starve its canonical ledger's bounded first turn`, async (t) => {
  const { service, hashes, attempted, advance } = fixture(t);
  Object.assign(service,{runtime:{config:{mode,chainId},dataScope:mode}});
  const turns: number[] = [],order: string[] = [];
  const receipt = service.client.getTransactionReceipt;
  t.mock.method(service.client,"getTransactionReceipt",async(parameters:any)=>{order.push("receipt");return receipt(parameters)});
  service.vaultLedgerRuntime={automationPolicy:async()=>"unverified",custody:async()=>{throw new Error("unused in receipt budget test")},sourceStatus:async()=>({ready:false,assets:[],receivedWeth:"0",refundedWeth:"0"}),read:async()=>emptyVaultLedgerReport(0n),initialize:async()=>emptyVaultLedgerReport(0n),close:()=>{},
    reconcile:async duration=>{turns.push(duration!);order.push("ledger");advance(duration!);return emptyVaultLedgerReport(0n)}};
  await service.reconcile(60);await service.reconcile(60);
  assert.deepEqual(turns,[30,30]);assert.deepEqual(order,["ledger","receipt","ledger","receipt"]);
  assert.deepEqual(attempted,hashes.slice(0,2),"Each round finishes its current receipt and then resumes the queue");
});

test("private canary maintenance cannot write the shared financial scope", async (t) => {
  const { service, attempted } = fixture(t);
  let writes = 0;
  Object.assign(service, {runtime:{config:{mode:"base",chainId:8453},dataScope:"verify-base-canary"},
    vaultLedgerRuntime:{reconcile:async()=>{writes++;throw new Error("Unexpected financial write");}}});
  await service.reconcile(60);
  assert.equal(writes,0); assert.equal(attempted.length,2,"private launch receipt recovery continues independently");
});

test("a stalled peer-chain financial session cannot delay Robinhood pending launch receipts", async (t) => {
  const { service, hashes, attempted } = fixture(t);
  Object.assign(service, { runtime: { config: { mode: "robinhood", chainId: 4663 }, dataScope: "robinhood" },
    vaultLedgerRuntime: { reconcile: async () => new Promise(() => {}) } });
  await service.reconcile(60);
  assert.deepEqual(attempted, hashes.slice(0, 2));
});

for (const [mode, chainId] of [["base",8453],["robinhood",4663]] as const) test(`public ${mode} maintenance never audits or writes financial journals`, async t => {
  const { service, attempted } = fixture(t); let audits = 0;
  Object.assign(service, { financialAuditReadOnly: true, runtime: { config: { mode,chainId }, dataScope: mode },
    vaultLedgerRuntime: { reconcile: async () => { audits++; throw new Error("Public financial maintenance is forbidden"); } } });
  await service.reconcile(60);
  assert.equal(audits, 0); assert.equal(attempted.length, 2, "Launch receipt recovery still gets its own bounded turn");
});

test("empty public Base and Robinhood launch queues perform no network or finalized-block reads", async t => {
  for (const [mode,chainId] of [["base",8453],["robinhood",4663]] as const) {
    const f=fixture(t);f.hashes.forEach(f.remove);let rpc=0,financial=0;
    Object.assign(f.service,{financialAuditReadOnly:true,runtime:{config:{mode,chainId},dataScope:mode},
      assertNetwork:async()=>{rpc++;},vaultLedgerRuntime:{reconcile:async()=>{financial++;}}});
    t.mock.method(f.service.client,"getBlock",async()=>{rpc++;throw new Error("An empty public queue must not query finalized blocks");});
    await f.service.reconcile(60);await f.service.reconcile(60);
    assert.equal(rpc,0,mode);assert.equal(financial,0,mode);assert.deepEqual(f.attempted,[]);
  }
});

test("empty launch queues do not skip either private chain's financial maintenance", async t => {
  for (const [mode,chainId] of [["base",8453],["robinhood",4663]] as const) {
    const f=fixture(t);f.hashes.forEach(f.remove);let network=0,financial=0;
    Object.assign(f.service,{financialAuditReadOnly:false,runtime:{config:{mode,chainId},dataScope:mode},assertNetwork:async()=>{network++;},
      vaultLedgerRuntime:{reconcile:async()=>{financial++;return emptyVaultLedgerReport(0n);}}});
    await f.service.reconcile(60);
    assert.equal(network,1,mode);assert.equal(financial,1,mode);assert.deepEqual(f.attempted,[]);
  }
});

test("public queue errors propagate and a pending queue read retains singleflight before normal receipt recovery", async t => {
  const f=fixture(t);let reads=0,network=0,release!:()=>void;
  const queued=f.service.store.pendingLaunches.bind(f.service.store),held=new Promise<void>(resolve=>{release=resolve;});
  Object.assign(f.service,{financialAuditReadOnly:true,assertNetwork:async()=>{network++;}});
  t.mock.method(f.service.store,"pendingLaunches",async()=>{reads++;if(reads===1)throw new Error("Database unavailable");if(reads===2)await held;return queued();});
  await assert.rejects(f.service.reconcile(60),/Database unavailable/);
  assert.equal(network,0,"Database failure is not an empty or successfully recovered queue");
  const active=f.service.reconcile(60);await Promise.resolve();await f.service.reconcile(60);
  assert.equal(reads,2,"A pending database read cannot start a second maintenance turn");assert.equal(network,0);
  release();await active;
  assert.equal(network,1);assert.deepEqual(f.attempted,f.hashes.slice(0,2),"A recovered nonempty queue keeps the existing RPC, receipt and time-budget behavior");
  f.hashes.forEach(f.remove);await f.service.reconcile(60);assert.equal(network,1,"The settled lease also permits the next empty turn to end without RPC");
});

test("financial maintenance stays single flight after receipt deadlines until its background work settles",async(t)=>{
 const {service,attempted}=fixture(t);let calls=0,finish!:()=>void;const held=new Promise<void>(resolve=>{finish=resolve;});
 Object.assign(service,{runtime:{config:{mode:"robinhood",chainId:4663},dataScope:"robinhood"},vaultLedgerRuntime:{reconcile:async()=>{calls++;if(calls===1)await held;return emptyVaultLedgerReport(0n);}}});
 await service.reconcile(60);await service.reconcile(60);assert.equal(calls,1,"An unfinished turn cannot start another journal writer");assert.equal(attempted.length,4,"Launch receipts continue across those deadlines");
 finish();await new Promise<void>(resolve=>setImmediate(resolve));await service.reconcile(60);assert.equal(calls,2,"Only the settled maintenance lease admits another turn");
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
