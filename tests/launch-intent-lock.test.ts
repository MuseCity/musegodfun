import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import type { RuntimeConfig } from "../src/lib/config";
import { assertLaunchIntentLock, launchIntentStorageKey, withLaunchIntentLock } from "../src/lib/launch-intent";
import { observeServerTime, resetQuoteClock } from "../src/lib/quote-clock";
import { signingRequest } from "../src/lib/wallet-signing";
import { SEND_LEASE_LOST, recordAtBroadcast } from "../src/lib/send-record";
import { ETH_BUY_LOCK, ETH_BUY_TAKEN, ethBuyStorageKey, parseEthBuyRecord, type EthBuyRecord } from "../src/lib/eth-buy-record";
import { FEE_TAKEN, LAUNCH_FEE_LOCK, launchFeeStorageKey, parseLaunchFeeRecord } from "../src/lib/nft-client";

const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, treasury: null, writesEnabled: false, blockReason: null };
const account = "0x1111111111111111111111111111111111111111" as Address;
const intent = "shared-intent", server = 1_800_000_000_000;
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function globalValue(t: TestContext, key: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
}
// A minimal IndexedDB transaction model. Read/write transactions are queued,
// including across connections, matching the browser's atomicity boundary.
function indexedDbFixture() {
  const rows = new Map<string, { key: string; owner: string; expires: number }>();
  let queue = Promise.resolve();
  const database = {
    objectStoreNames: { contains: () => true }, close() {},
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null, objectStore: () => store } as unknown as IDBTransaction;
      const store = {
        get(key: string) {
          const request = {} as IDBRequest;
          queue = queue.then(() => {
            Object.defineProperty(request, "result", { value: rows.get(key), configurable: true });
            request.onsuccess?.call(request, new Event("success"));
            tx.oncomplete?.call(tx, new Event("complete"));
          });
          return request;
        },
        put(row: { key: string; owner: string; expires: number }) { rows.set(row.key, structuredClone(row)); },
        delete(key: string) { rows.delete(key); },
      };
      return tx;
    },
  };
  return { rows, factory: { open() {
    const request = { result: database } as unknown as IDBOpenDBRequest;
    queueMicrotask(() => request.onsuccess?.call(request, new Event("success")));
    return request;
  } }, flush: () => queue };
}
function setup(t: TestContext) {
  let monotonic = 0, wall = server;
  resetQuoteClock(); t.after(resetQuoteClock);
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(Date, "now", () => wall);
  observeServerTime(null, server, 0, 0);
  const values = new Map<string, string>();
  globalValue(t, "localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  globalValue(t, "navigator", {});
  const idb = indexedDbFixture(); globalValue(t, "indexedDB", idb.factory);
  return { ...idb, values, advance: (ms: number) => { monotonic += ms; }, jump: (ms: number) => { wall += ms; } };
}

test("two tabs cannot hold one intent, while an independent draft remains usable", async (t) => {
  const f = setup(t), started = deferred(), release = deferred();
  const secondTab = await import(new URL("../src/lib/launch-intent.ts?tab=atomic", import.meta.url).href) as typeof import("../src/lib/launch-intent");
  const first = withLaunchIntentLock(config, account, intent, async (assertHeld) => { await assertHeld(); started.resolve(); await release.promise; });
  await started.promise;
  await assert.rejects(() => secondTab.withLaunchIntentLock(config, account, intent, async () => {}), /another tab/);
  await withLaunchIntentLock(config, account, "independent-draft", async (assertHeld) => { await assertHeld(); });
  release.resolve(); await first;
  await secondTab.withLaunchIntentLock(config, account, intent, async () => {});
  assert.equal(f.rows.size, 0);
});

test("lease renewal keeps a long approval exclusive after ten minutes despite wall-clock jumps", async (t) => {
  const f = setup(t), started = deferred(), release = deferred();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const secondTab = await import(new URL("../src/lib/launch-intent.ts?tab=renewal", import.meta.url).href) as typeof import("../src/lib/launch-intent");
  const first = withLaunchIntentLock(config, account, intent, async () => { started.resolve(); await release.promise; });
  await started.promise;
  for (let step = 0; step < 24; step++) {
    f.advance(30_000); f.jump(step % 2 ? -600_000 : 600_000);
    t.mock.timers.tick(30_000); await f.flush(); await Promise.resolve(); await Promise.resolve();
  }
  await assertLaunchIntentLock(config, account, intent);
  await assert.rejects(() => secondTab.withLaunchIntentLock(config, account, intent, async () => {}), /another tab/);
  release.resolve(); await first;
});

test("a suspended holder cannot resume sending after an expired lease was acquired elsewhere", async (t) => {
  const f = setup(t), firstStarted = deferred(), secondStarted = deferred(), firstRelease = deferred(), secondRelease = deferred();
  const secondTab = await import(new URL("../src/lib/launch-intent.ts?tab=expired", import.meta.url).href) as typeof import("../src/lib/launch-intent");
  const first = withLaunchIntentLock(config, account, intent, async () => { firstStarted.resolve(); await firstRelease.promise; });
  await firstStarted.promise;
  f.advance(120_001);
  const second = secondTab.withLaunchIntentLock(config, account, intent, async () => { secondStarted.resolve(); await secondRelease.promise; });
  await secondStarted.promise;
  await assert.rejects(() => assertLaunchIntentLock(config, account, intent), /expired or changed/);
  firstRelease.resolve(); await first;
  assert.equal(f.rows.size, 1, "the stale owner's release must preserve the replacement lease");
  await secondTab.assertLaunchIntentLock(config, account, intent);
  secondRelease.resolve(); await second;
});

test("unavailable reliable storage fails before the operation; a durable unknown-send marker outlives leases", async (t) => {
  const f = setup(t); let sends = 0;
  f.values.set(launchIntentStorageKey(config, account, intent, "submission"), "unknown-send");
  await assert.rejects(() => withLaunchIntentLock(config, account, intent, async () => { sends++; }), /needs recovery/);
  assert.equal(f.rows.size, 0);
  f.values.clear(); globalValue(t, "indexedDB", undefined);
  await assert.rejects(() => withLaunchIntentLock(config, account, intent, async () => { sends++; }), /reliable cross-tab launch lock is unavailable/);
  assert.equal(sends, 0);
});

test("native Web Locks remain preferred when IndexedDB is unavailable", async (t) => {
  setup(t); globalValue(t, "indexedDB", undefined);
  let requests = 0;
  globalValue(t, "navigator", { locks: { request: async (_key: string, options: { ifAvailable: boolean }, operation: (lock: object) => Promise<unknown>) => {
    requests++; assert.equal(options.ifAvailable, true); return operation({});
  } } });
  await withLaunchIntentLock(config, account, intent, async (assertHeld) => { await assertHeld(); });
  assert.equal(requests, 1);
});

// ---- round 5 P1: a recorded payment re-verifies its lease and the stored record at the wallet request itself -------------------
const buyer = getAddress(account), diamond = getAddress("0x2222222222222222222222222222222222222222");
const buyTx = { from: buyer, to: diamond, data: "0xabcdef" as Hex, value: "0x38d7ea4c68000", chainId: "0x1237" };
const buyRecord = (at: number, nonce = 0): EthBuyRecord => ({ state: "sending", from: buyer, nonce, block: "100", at, quoteId: `quote-${at}`,
  tx: { to: diamond, data: "0xabcdef", value: "1000000000000000" },
  target: { kind: "coin", token: getAddress("0x5555555555555555555555555555555555555555"), symbol: "BARD", decimals: 18, coin: "BARD" } });
/** One tab's ETH buy: its lock, then the signing transport with the round-5 beforeSend. `hold` keeps it inside async signing validation;
 * `answer` is when its wallet answers. */
function buyInTab(lock: typeof withLaunchIntentLock, tab: string, record: EthBuyRecord, wallet: string[], hold: Promise<void> = Promise.resolve(),
  answer: Promise<void> = Promise.resolve()) {
  const key = ethBuyStorageKey(config, buyer);
  return lock(config, buyer, ETH_BUY_LOCK, async (assertHeld) => {
    await assertHeld();
    const request = signingRequest({ request: async () => { wallet.push(tab); await answer; return `0x${"ab".repeat(32)}`; } }, {
      validate: () => hold,
      beforeSend: () => recordAtBroadcast(record, { assertHeld, read: () => parseEthBuyRecord(localStorage.getItem(key)),
        write: (next) => localStorage.setItem(key, JSON.stringify(next)), taken: ETH_BUY_TAKEN }),
    });
    return request({ method: "eth_sendTransaction", params: [buyTx] });
  });
}
/** Tab A passes its lease check, then is suspended in async signing validation for longer than the lease (no Web Locks: the IndexedDB
 * lease). Tab B takes the expired lease over: when A resumes, B has finished its buy, is still waiting for its wallet, or is still in its
 * own signing validation (no record yet). */
async function suspendedTakeover(t: TestContext, takeover: "finished" | "still sending" | "validating") {
  const f = setup(t), suspended = deferred(), walletB = deferred(), validatingB = deferred(), wallet: string[] = [];
  const secondTab = await import(new URL(`../src/lib/launch-intent.ts?tab=broadcast-${takeover.replace(" ", "-")}`, import.meta.url).href) as typeof import("../src/lib/launch-intent");
  const key = ethBuyStorageKey(config, buyer), first = buyRecord(1_000), second = buyRecord(2_000);
  const settle = (work: Promise<unknown>) => work.then(() => "sent", (error: Error) => error.message);
  const a = settle(buyInTab(withLaunchIntentLock, "A", first, wallet, suspended.promise));
  for (let i = 0; i < 5; i++) { await f.flush(); await Promise.resolve(); }
  assert.equal(f.rows.size, 1, "tab A holds the lease");
  f.advance(120_001);
  const b = settle(buyInTab(secondTab.withLaunchIntentLock, "B", second, wallet, takeover === "validating" ? validatingB.promise : Promise.resolve(),
    takeover === "still sending" ? walletB.promise : Promise.resolve()));
  if (takeover === "finished") assert.equal(await b, "sent");
  else for (let i = 0; i < 20; i++) { await f.flush(); await Promise.resolve(); }
  if (takeover !== "finished") assert.equal(f.rows.size, 1, `${takeover}: tab B holds the lease`);
  assert.deepEqual(wallet, takeover === "validating" ? [] : ["B"], `${takeover}: tab B's buy`);
  assert.deepEqual(JSON.parse(localStorage.getItem(key) ?? "null"), takeover === "validating" ? null : second, `${takeover}: tab B's record`);
  // Tab A resumes: its broadcast step finds the lease gone (released, or held by tab B) and refuses before the wallet.
  suspended.resolve();
  assert.equal(await a, SEND_LEASE_LOST, takeover);
  assert.deepEqual(wallet, takeover === "validating" ? [] : ["B"], `${takeover}: the wallet never received tab A's buy`);
  // Tab B finishes as if tab A had never resumed: one buy, and its record.
  validatingB.resolve(); walletB.resolve();
  assert.equal(await b, "sent");
  assert.deepEqual(wallet, ["B"]);
  assert.deepEqual(JSON.parse(localStorage.getItem(key)!), second, `${takeover}: tab B's record is never overwritten`);
}
test("a tab suspended in signing past its lease sends nothing once another tab took over and finished its buy", (t) => suspendedTakeover(t, "finished"));
test("a tab suspended in signing past its lease sends nothing while another tab that took over is still sending", (t) => suspendedTakeover(t, "still sending"));
test("a tab suspended in signing past its lease sends nothing while another tab that took over is still validating, which then sends once", (t) =>
  suspendedTakeover(t, "validating"));

test("with the lease held, the broadcast step never overwrites another attempt's record, yet allows its own resend", async (t) => {
  const f = setup(t), key = ethBuyStorageKey(config, buyer), mine = buyRecord(1_000, 4);
  // Another attempt's record (another time, or the same time with another nonce) stands: nothing reaches the wallet.
  for (const other of [buyRecord(2_000, 4), buyRecord(1_000, 5)]) {
    localStorage.setItem(key, JSON.stringify(other));
    const wallet: string[] = [];
    await assert.rejects(buyInTab(withLaunchIntentLock, "A", mine, wallet), (error: Error) => error.message === ETH_BUY_TAKEN);
    assert.deepEqual(wallet, []);
    assert.deepEqual(JSON.parse(localStorage.getItem(key)!), other);
  }
  // A paid launch fee is never overwritten by a new fee attempt either.
  const feeKey = launchFeeStorageKey(config, buyer), paid = { state: "paid", from: buyer, fee: { asset: "stable", txHash: `0x${"cd".repeat(32)}` } };
  localStorage.setItem(feeKey, JSON.stringify(paid));
  await assert.rejects(withLaunchIntentLock(config, buyer, LAUNCH_FEE_LOCK, (assertHeld) => recordAtBroadcast(
    { state: "sending", asset: "stable", from: buyer, nonce: 0, block: "1", at: 3_000 }, { assertHeld, read: () => parseLaunchFeeRecord(localStorage.getItem(feeKey)),
      write: (next) => localStorage.setItem(feeKey, JSON.stringify(next)), taken: FEE_TAKEN })), (error: Error) => error.message === FEE_TAKEN);
  assert.deepEqual(JSON.parse(localStorage.getItem(feeKey)!), paid);
  // The same attempt, resent by viem after the wallet refused the method unprocessed, passes the lease and the record check again.
  localStorage.removeItem(key);
  const requests: string[] = [], records: string[] = [];
  await withLaunchIntentLock(config, buyer, ETH_BUY_LOCK, async (assertHeld) => {
    const request = signingRequest({ request: async ({ method }) => {
      requests.push(method);
      if (method === "eth_sendTransaction") throw Object.assign(new Error("Method not supported"), { code: -32004 });
      return `0x${"ab".repeat(32)}`;
    } }, { validate: async () => {}, beforeSend: async (resend) => {
      records.push(`${resend}`);
      await recordAtBroadcast(mine, { assertHeld, read: () => parseEthBuyRecord(localStorage.getItem(key)), write: (next) => localStorage.setItem(key, JSON.stringify(next)), taken: ETH_BUY_TAKEN });
    } });
    await assert.rejects(request({ method: "eth_sendTransaction", params: [buyTx] }), /Method not supported/);
    assert.equal(await request({ method: "wallet_sendTransaction", params: [buyTx] }), `0x${"ab".repeat(32)}`);
  });
  assert.deepEqual([requests, records], [["eth_sendTransaction", "wallet_sendTransaction"], ["false", "true"]]);
  assert.deepEqual(JSON.parse(localStorage.getItem(key)!), mine);
  assert.equal(f.rows.size, 0);
});
