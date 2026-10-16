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
  const runtime = hookRuntime(() => View({ token: syntheticToken({ mode: "robinhood", deploymentChainId: 4663 }), kind, refreshKey: "" }));
  ({ default: View } = await importFresh("src/components/TokenMarket.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  try {
    runtime.render(); await settle(); assert.equal(calls.length, 3);
    const interval = kind === "musegod" ? 15_000 : 15 * 60_000;
    t.mock.timers.tick(interval - 1); await settle(); assert.equal(calls.length, 3);
    t.mock.timers.tick(1); await settle(); assert.equal(calls.length, 6);
    document.visibilityState = "hidden"; t.mock.timers.tick(interval); await settle(); assert.equal(calls.length, 6);
  } finally {
    runtime.unmount();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
