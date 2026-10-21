import test from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { syntheticToken } from "./fixtures";
import { MusegodMarketReader } from "../server/musegod-market";
import { MUSEGOD } from "../src/lib/musegod";
import type { StoreBackend } from "../server/supabase-store";

test("MUSEGOD actual candle reader reuses and refreshes the snapshot at fifteen seconds", async () => {
  let now = 1_800_000_000_000, calls = 0;
  const rows = new Map<string, { data: unknown; at: number }>();
  const reader = new MusegodMarketReader({ mode: "robinhood", chainId: 4663 } as any, {
    snapshot: key => rows.get(key) ?? null, saveSnapshot: (key, data, at) => { rows.set(key, { data, at }); },
  } as StoreBackend, { now: () => now, fetch: async () => {
    calls++; return Response.json({ ohlcv: [[Math.floor(now / 1000) - 60, 1, 1, 1, 1, calls]],
      pool: { address: MUSEGOD.pool, network: "robinhood" }, pair: { baseSymbol: "MUSEGOD", quoteSymbol: "WETH" } });
  } });
  const first = await reader.candles("1m");
  now += 14_999; assert.deepEqual(await reader.candles("1m"), first); assert.equal(calls, 1);
  now++; const fresh = await reader.candles("1m"); assert.equal(calls, 2);
  assert.equal(fresh.candles[0].volume, 2); assert.notEqual(fresh.fetchedAt, first.fetchedAt);
});
for (const kind of ["musegod", "launch"] as const) test(`${kind} polls only while visible at its own interval`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const previous = ["document", "window"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: any) => { calls.push(String(path)); return Response.json({
    fetchedAt: new Date().toISOString(), source: "Bankr", status: "fresh", candles: [], trades: [], periods: {},
    priceUsd: null, fdvUsd: null, marketCapUsd: null, liquidityUsd: null,
  }); });
  let View: any;
  const runtime = hookRuntime(() => kind === "musegod" ? View({ token: syntheticToken({ mode: "robinhood", deploymentChainId: 4663 }), refreshKey: "" }) : View(syntheticToken({ mode: "robinhood", deploymentChainId: 4663 }), null));
  const module = await importFresh("src/components/TokenMarket.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } });
  View = kind === "musegod" ? module.default : module.useLaunchMarket;
  try {
    runtime.render(); await settle(); const reads = kind === "musegod" ? 3 : 1; assert.equal(calls.length, reads);
    if (kind === "launch") assert(calls.every(path => path.endsWith("/market/summary")), `the token page reads only the summary, never the trade list: ${calls}`);
    const interval = kind === "musegod" ? 15_000 : 15 * 60_000;
    t.mock.timers.tick(interval - 1); await settle(); assert.equal(calls.length, reads);
    t.mock.timers.tick(1); await settle(); assert.equal(calls.length, reads * 2);
    document.visibilityState = "hidden"; t.mock.timers.tick(interval); await settle(); assert.equal(calls.length, reads * 2);
  } finally {
    runtime.unmount();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});

// tasks/token-ip-detail-plan.md §17: the token page's summary recovers on its own, without a refresh button.
test("a failed or stale launch summary is read again after 1, 2, 4 and 8 minutes while visible, and only the summary", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const previous = ["document", "window"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const listeners = new Set<() => void>();
  const document = { visibilityState: "visible", addEventListener: (_: string, run: () => void) => listeners.add(run),
    removeEventListener: (_: string, run: () => void) => listeners.delete(run) };
  const show = (state: "visible" | "hidden") => { document.visibilityState = state; listeners.forEach(run => run()); };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  const calls: string[] = [];
  let answer: "fail" | "stale" | "fresh" = "fail";
  t.mock.method(globalThis, "fetch", async (path: any) => {
    calls.push(String(path));
    if (answer === "fail") return Response.json({ error: "Upstream failed" }, { status: 500 });
    return Response.json({ fetchedAt: new Date().toISOString(), source: "Bankr", status: answer, periods: {},
      priceUsd: answer === "fresh" ? 0.5 : null, fdvUsd: null, marketCapUsd: 1000, liquidityUsd: null });
  });
  let View: any;
  const runtime = hookRuntime(() => View(syntheticToken({ mode: "robinhood", deploymentChainId: 4663 }), null));
  View = (await importFresh("src/components/TokenMarket.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } })).useLaunchMarket;
  const minutes = async (n: number) => { t.mock.timers.tick(n * 60_000); await settle(); await settle(); };
  try {
    runtime.render(); await settle(); await settle();
    assert.equal(calls.length, 1); assert.match(runtime.output().summary.error, /Upstream failed/);
    await minutes(0.99); assert.equal(calls.length, 1, "no retry before a minute");
    answer = "fresh"; await minutes(0.01);
    assert.equal(calls.length, 2, "the first retry comes a minute after the failure");
    assert.equal(runtime.output().summary.data?.priceUsd, 0.5, "a retry restores the summary without a page reload");
    assert(calls.every(path => path.endsWith("/market/summary")), `only the summary is read: ${calls}`);
    await minutes(14.99); assert.equal(calls.length, 2, "a fresh answer schedules the next read in 15 minutes");
    answer = "stale"; await minutes(0.01); assert.equal(calls.length, 3, "the regular read answers a stale snapshot");
    for (const [wait, total] of [[1, 4], [2, 5], [4, 6], [8, 7]] as const) {
      await minutes(wait - 0.01); assert.equal(calls.length, total - 1, `no retry before ${wait} min`);
      await minutes(0.01); assert.equal(calls.length, total, `a retry after ${wait} min`);
    }
    await minutes(14.99); assert.equal(calls.length, 7, "after four retries the 15-minute cadence resumes, with no extra read");
    answer = "fresh"; await minutes(0.01); assert.equal(calls.length, 8);
    await minutes(14.99); assert.equal(calls.length, 8, "a fresh answer resets the backoff");
    answer = "fail"; await minutes(0.01); assert.equal(calls.length, 9);
    show("hidden"); await minutes(30);
    assert.equal(calls.length, 9, "a hidden tab neither retries nor polls");
    answer = "fresh"; show("visible"); await settle(); t.mock.timers.tick(0); await settle(); await settle();
    assert.equal(calls.length, 10, "an overdue retry reads at once on return");
    assert.equal(runtime.output().summary.data?.status, "fresh");
    assert(calls.every(path => path.endsWith("/market/summary")), `only the summary is read: ${calls}`);
  } finally {
    runtime.unmount();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});

test("a launch summary read that never answers, the first one included, is followed by another after 15 minutes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const previous = ["document", "window"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  const calls: string[] = [];
  let hang = true;
  t.mock.method(globalThis, "fetch", async (path: any) => {
    calls.push(String(path));
    if (hang) return new Promise<Response>(() => {});
    return Response.json({ fetchedAt: new Date().toISOString(), source: "Bankr", status: "fresh", periods: {}, priceUsd: 0.5, fdvUsd: null, marketCapUsd: null, liquidityUsd: null });
  });
  let View: any;
  const runtime = hookRuntime(() => View(syntheticToken({ mode: "robinhood", deploymentChainId: 4663 }), null));
  View = (await importFresh("src/components/TokenMarket.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } })).useLaunchMarket;
  const minutes = async (n: number) => { t.mock.timers.tick(n * 60_000); await settle(); await settle(); };
  try {
    runtime.render(); await settle(); await settle(); assert.equal(calls.length, 1, "the first read never answers");
    await minutes(14.99); assert.equal(calls.length, 1);
    hang = false; await minutes(0.01); assert.equal(calls.length, 2, "a hung first read is followed by another after 15 minutes");
    assert.equal(runtime.output().summary.data?.priceUsd, 0.5);
    hang = true; await minutes(15); assert.equal(calls.length, 3, "the regular read starts and never answers");
    hang = false; await minutes(14.99); assert.equal(calls.length, 3);
    await minutes(0.01); assert.equal(calls.length, 4, "another read follows 15 minutes later");
    assert.equal(runtime.output().summary.data?.priceUsd, 0.5);
  } finally {
    runtime.unmount();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
