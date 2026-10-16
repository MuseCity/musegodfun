import test from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import type { CandleData } from "../src/lib/market";
const candle = (time: number, close = 1) => ({ time, open: 1, high: Math.max(1, close), low: 1, close, volume: 2 });
test("the chart pages once on demand, preserves history on refresh and stops when the provider is empty", async t => {
  const time = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
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
