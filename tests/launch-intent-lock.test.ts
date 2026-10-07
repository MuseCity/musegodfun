import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type { RuntimeConfig } from "../src/lib/config";
import { assertLaunchIntentLock, launchIntentStorageKey, withLaunchIntentLock } from "../src/lib/launch-intent";
import { observeServerTime, resetQuoteClock } from "../src/lib/quote-clock";

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
