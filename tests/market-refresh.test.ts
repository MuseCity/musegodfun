import test from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { syntheticToken } from "./fixtures";
import { MUSEGOD_MARKET_TTL } from "../server/musegod-market";

test("MUSEGOD server cache is fifteen seconds", () => assert.equal(MUSEGOD_MARKET_TTL, 15_000));
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
