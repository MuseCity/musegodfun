import test from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import type { CandleData } from "../src/lib/market";
import { ApiError } from "../src/lib/api";
const candle = (time: number, close = 1) => ({ time, open: 1, high: Math.max(1, close), low: 1, close, volume: 2 });
test("the chart pages once on demand, preserves history on refresh and stops when the provider is empty", async t => {
  const time = Math.floor((Date.now() / 1000 - 3600) / (199 * 3600)) * 199 * 3600;
  let data: CandleData = { candles: [candle(time), candle(time + 3600)], fetchedAt: new Date().toISOString(), source: "Bankr", status: "fresh" };
  const calls: string[] = [], replies: ((data: CandleData) => void)[] = [];
  const request = async (_chain: number, path: string) => { calls.push(path); return new Promise<CandleData>(done => replies.push(done)); };
  let View: any;
  const runtime = hookRuntime(() => View({ data, interval: "1h", endpoint: { chainId: 4663, path: "/musegod/market/candles?interval=1h", key: "fixture" }, symbol: "MUSEGOD", type: "line" }));
  ({ default: View } = await importFresh("src/components/MarketChart.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/api": { file: new URL("../src/lib/api.ts", import.meta.url).href, bindings: { chainApi: request } },
  }));
  const chart = () => runtime.output().props.children[0];
  t.after(() => runtime.unmount()); runtime.render();
  await Promise.all([chart().props.onLoadOlder(), chart().props.onLoadOlder()]); await settle();
  assert.equal(calls.length, 1); assert(calls[0].endsWith(`&before=${time}`));
  const historyTime = new Date(Date.parse(data.fetchedAt) - 120_000).toISOString();
  replies[0]({ ...data, fetchedAt: historyTime, candles: [candle(time - 3600), candle(time)] }); await settle();
  assert.deepEqual(chart().props.candles.map((c: any) => c.time), [time - 3600, time, time + 3600]);
  data = { ...data, candles: [candle(time + 3600, 2), candle(time + 7200)] }; runtime.render(); await settle();
  assert.equal(chart().props.candles.length, 4); assert.equal(chart().props.candles[2].close, 2);
  chart().props.onLoadOlder(); await settle();
  const secondTime = new Date(Date.parse(historyTime) + 60_000).toISOString();
  replies[1]({ ...data, fetchedAt: secondTime, candles: [candle(time - 7200)] }); await settle();
  chart().props.onLoadOlder(); await settle(); replies[2]({ ...data, candles: [] }); await settle();
  chart().props.onLoadOlder(); await settle(); assert.equal(calls.length, 3);
  assert(JSON.stringify(runtime.output()).includes(secondTime), "history pages retain their fetch time range");
  assert.match(JSON.stringify(runtime.output()), /Beginning of indexed history/);
  assert(JSON.stringify(runtime.output()).includes(historyTime), "an empty boundary request does not replace the historical bars fetch time");
});

test("disposing the actual chart aborts its in-flight chain API fetch", async t => {
  const time = Math.floor((Date.now() / 1000 - 3600) / (199 * 3600)) * 199 * 3600;
  const data = { candles: [candle(time)], fetchedAt: new Date().toISOString(), source: "Bankr", status: "fresh" };
  let signal: AbortSignal | undefined, aborted = false, View: any;
  t.mock.method(globalThis, "fetch", async (_input: any, init: any) => {
    signal = init.signal;
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => { aborted = true; reject(signal!.reason); }));
  });
  const runtime = hookRuntime(() => View({ data, interval: "1h", endpoint: { chainId: 4663, path: "/musegod/market/candles?interval=1h", key: "abort" }, symbol: "MUSEGOD", type: "line" }));
  ({ default: View } = await importFresh("src/components/MarketChart.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  runtime.render(); runtime.output().props.children[0].props.onLoadOlder(); await settle();
  assert(signal instanceof AbortSignal); assert.equal(signal.aborted, false);
  runtime.unmount(); await settle(); assert.equal(aborted, true); assert.equal(signal.aborted, true);
});

const unavailable = () => new ApiError("History paging is not available for this source.", 503, undefined, undefined, "history_not_available");
async function mountChart(t: { after(fn: () => void): void }, data: CandleData, request: (chain: number, path: string) => Promise<CandleData>, interval = "1h") {
  let View: any;
  const runtime = hookRuntime(() => View({ data, interval, endpoint: { chainId: 4663, path: "/tokens/0xabc/market/candles?interval=" + interval, key: "fixture" }, symbol: "TOKEN", type: "line" }));
  ({ default: View } = await importFresh("src/components/MarketChart.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/api": { file: new URL("../src/lib/api.ts", import.meta.url).href, bindings: { chainApi: request } },
  }));
  t.after(() => runtime.unmount()); runtime.render();
  return { chart: () => runtime.output().props.children[0], text: () => JSON.stringify(runtime.output()) };
}

test("a Bankr chart whose server lost its source memory re-teaches it with one first-page read, then pages", async t => {
  const time = Math.floor((Date.now() / 1000 - 3600) / (199 * 3600)) * 199 * 3600;
  const data: CandleData = { candles: [candle(time), candle(time + 3600)], fetchedAt: new Date().toISOString(), source: "Bankr", status: "fresh" };
  const calls: string[] = []; let primed = false;
  const view = await mountChart(t, data, async (_chain, path) => {
    calls.push(path.includes("&before=") ? "history" : "first");
    if (!path.includes("&before=")) { primed = true; return data; }
    if (!primed) throw unavailable();
    return { ...data, candles: [candle(time - 3600), candle(time)] };
  });
  view.chart().props.onLoadOlder(); await settle();
  assert.deepEqual(calls, ["history", "first", "history"]);
  assert.deepEqual(view.chart().props.candles.map((c: any) => c.time), [time - 3600, time, time + 3600]);
  assert.doesNotMatch(view.text(), /not available/); assert.doesNotMatch(view.text(), /Beginning of indexed history/);
});
test("history that stays unavailable after the source was re-taught is final", async t => {
  const time = Math.floor((Date.now() / 1000 - 3600) / (199 * 3600)) * 199 * 3600;
  const data: CandleData = { candles: [candle(time)], fetchedAt: new Date().toISOString(), source: "Bankr", status: "fresh" };
  const calls: string[] = [];
  const view = await mountChart(t, data, async (_chain, path) => {
    calls.push(path.includes("&before=") ? "history" : "first");
    if (path.includes("&before=")) throw unavailable();
    return data;
  });
  view.chart().props.onLoadOlder(); await settle();
  assert.deepEqual(calls, ["history", "first", "history"]); assert.match(view.text(), /History paging is not available for this source\./);
  view.chart().props.onLoadOlder(); await settle(); assert.equal(calls.length, 3);
});
test("the 365-day request limit is reported as a window limit, not as the start of the index", async t => {
  const old = Math.floor((Date.now() / 1000 - 380 * 86400) / 3600) * 3600, calls: string[] = [];
  const view = await mountChart(t, { candles: [candle(old), candle(old + 3600)], fetchedAt: new Date().toISOString(), source: "Bankr", status: "fresh" },
    async (_chain, path) => { calls.push(path); throw new Error("unexpected request"); });
  view.chart().props.onLoadOlder(); await settle();
  assert.equal(calls.length, 0); assert.match(view.text(), /365 days/); assert.doesNotMatch(view.text(), /Beginning of indexed history/);
});
