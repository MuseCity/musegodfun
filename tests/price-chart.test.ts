import test from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import type { Candle, ChartInterval } from "../src/lib/market";
const nodes = (node: any): any[] => node && typeof node === "object" ? [node, ...(Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).flatMap(nodes)] : [];

test("the chart uses time-only whitespace for each empty interval, never pages, and replaces it with real prices", async t => {
  let candles: Candle[] = [], interval: ChartInterval = "1h", type = "candles", View: any, pages = 0;
  let rangeChanged: (range: { from: number; to: number }) => void, crosshair: (event: any) => void;
  const datasets: any[][] = [], fits: number[] = [], ranges: { from: number; to: number }[] = [];
  const timeScale = { subscribeVisibleLogicalRangeChange(fn: typeof rangeChanged) { rangeChanged = fn; },
    getVisibleLogicalRange: () => null, setVisibleLogicalRange(range: { from: number; to: number }) { ranges.push(range); }, fitContent() { fits.push(1); } };
  const chart = { addSeries() { const index = datasets.length; datasets.push([]);
    return { setData(data: any[]) { datasets[index] = data; }, priceScale: () => ({ applyOptions() {} }) }; },
    timeScale: () => timeScale, subscribeCrosshairMove(fn: typeof crosshair) { crosshair = fn; }, remove() {} };
  const previousStyle = globalThis.getComputedStyle, previousDocument = globalThis.document;
  Reflect.set(globalThis, "getComputedStyle", () => ({ getPropertyValue: () => "" }));
  Reflect.set(globalThis, "document", { documentElement: {} });
  t.after(() => { Reflect.set(globalThis, "document", previousDocument); Reflect.set(globalThis, "getComputedStyle", previousStyle); });
  let refIndex = 0;
  const runtime = hookRuntime(() => { refIndex = 0; return View({ candles, interval, type, symbol: "TEST", emptyMessage: "No indexed records.", onLoadOlder: () => pages++ }); });
  ({ default: View } = await importFresh("src/components/PriceChart.tsx", {
    react: { file: import.meta.resolve("react"), bindings: { ...runtime.hooks,
      useRef(initial: any) { return runtime.hooks.useRef(refIndex++ === 0 ? {} : initial); } } },
    "../lib/theme": { file: new URL("../src/lib/theme.ts", import.meta.url).href, bindings: { useTheme: () => ({ theme: "light" }) } },
    "lightweight-charts": { file: import.meta.resolve("lightweight-charts"), bindings: { createChart: () => chart } },
  }));
  t.after(() => runtime.unmount());
  for (const [value, step] of [["1m", 60], ["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400], ["1d", 86400]] as const) {
    interval = value; runtime.render();
    assert(datasets[0].length > 1, "empty chart has enough timestamps to lay out its time axis");
    assert(datasets[0].every(point => Object.keys(point).join() === "time"), "no synthetic price or volume values");
    assert.equal(datasets[0][1].time - datasets[0][0].time, step);
    assert.equal(datasets[0].at(-1).time % step, 0);
    assert.deepEqual(datasets[1], []);
    const find = (node: any): any => node?.props?.className?.split(" ").includes("price-chart") ? node
      : (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).filter(Boolean).map(find).find(Boolean);
    find(runtime.output()).props.onPointerDown(); rangeChanged!({ from: -10, to: 10 });
    assert.equal(pages, 0);
  }
  assert.equal(ranges.length, 6, "each empty interval lays out the whole time axis");
  assert(ranges.every(range => range.from === 0 && range.to === datasets[0].length - 1));
  candles = [{ time: 1800000000, open: 2, high: 4, low: 1, close: 3, volume: 5 }]; runtime.render();
  assert.deepEqual(datasets[0], candles); assert.equal(datasets[1][0].value, 5);
  assert.equal(fits.length, 1, "real candles are fitted when they replace whitespace");
  rangeChanged!({ from: 0, to: 10 }); assert.equal(pages, 1);
  crosshair!({ time: candles[0].time }); await settle();
  candles = []; runtime.render();
  assert.equal(nodes(runtime.output()).filter(node => node.type === "b").length, 0, "old hover values disappear when the chart empties");
  type = "line"; runtime.render();
  assert(datasets.at(-2)!.every(point => Object.keys(point).join() === "time"));
  assert.deepEqual(datasets.at(-1), []);
});
