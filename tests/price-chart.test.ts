import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import type { Candle, ChartInterval } from "../src/lib/market";
const nodes = (node: any): any[] => node && typeof node === "object" ? [node, ...(Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).flatMap(nodes)] : [];
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const chartTokens = Object.fromEntries([...css.matchAll(/(--chart-[\w-]+):\s*(#[\da-f]{6})/gi)].map(match => [match[1], match[2]]));

test("empty and populated candle, line and volume charts keep the same dark options across site themes", async t => {
  let theme = "light", View: any, candles: Candle[] = [], refIndex = 0;
  const previousStyle = globalThis.getComputedStyle, previousDocument = globalThis.document;
  Reflect.set(globalThis, "getComputedStyle", () => ({ getPropertyValue: (name: string) => chartTokens[name] ?? ({
    "--surface-raised": theme === "light" ? "#ffffff" : "#1d1a14", "--ink-faint": theme === "light" ? "#706757" : "#9a907b",
    "--line": theme === "light" ? "#e6ddca" : "#2e2920", "--up": theme === "light" ? "#00777a" : "#4fd1c5",
    "--down": theme === "light" ? "#b73510" : "#ff8a5e",
  }[name] ?? "") }));
  Reflect.set(globalThis, "document", { documentElement: {} });
  t.after(() => { Reflect.set(globalThis, "document", previousDocument); Reflect.set(globalThis, "getComputedStyle", previousStyle); });
  const frames: any[] = [];
  for (const type of ["candles", "line"]) for (const populated of [false, true]) for (const initialTheme of ["light", "dark"]) {
    theme = initialTheme; candles = populated ? [{ time: 1800000000, open: 2, high: 4, low: 1, close: 3, volume: 5 },
      { time: 1800003600, open: 3, high: 4, low: 1, close: 2, volume: 6 }] : [];
    const created: any[] = [];
    const runtime = hookRuntime(() => { refIndex = 0; return View({ candles, type, symbol: "TEST", emptyMessage: "No indexed records." }); });
    ({ default: View } = await importFresh("src/components/PriceChart.tsx", {
      react: { file: import.meta.resolve("react"), bindings: { ...runtime.hooks,
        useRef(initial: any) { return runtime.hooks.useRef(refIndex++ === 0 ? {} : initial); } } },
      "../lib/theme": { file: new URL("../src/lib/theme.ts", import.meta.url).href, bindings: { useTheme: () => ({ theme }) } },
      "lightweight-charts": { file: import.meta.resolve("lightweight-charts"), bindings: { createChart(_element: any, options: any) {
        const frame = { options, series: [] as any[] }; created.push(frame);
        return { addSeries(_kind: any, seriesOptions: any) { const record = { options: seriesOptions, data: [] as any[] }; frame.series.push(record);
          return { setData(data: any[]) { record.data = data; }, priceScale: () => ({ applyOptions() {} }) }; },
          timeScale: () => ({ subscribeVisibleLogicalRangeChange() {}, getVisibleLogicalRange: () => null, setVisibleLogicalRange() {}, fitContent() {} }),
          subscribeCrosshairMove() {}, remove() {} };
      } } },
    }));
    runtime.render();
    const frame = created[0];
    assert.equal(frame.options.layout.background.color, "#0b0e11", "all chart states use the near-black panel");
    theme = theme === "light" ? "dark" : "light"; runtime.render();
    assert.equal(created.length, 1, "switching the site theme preserves the chart and its viewport");
    if (populated) assert.notEqual(frame.series[1].data[0].color, frame.series[1].data[1].color, "up and down volumes remain distinct");
    frames.push({ type, populated, theme: initialTheme, options: JSON.parse(JSON.stringify(frame.options)),
      series: frame.series.map((entry: any) => entry.options), volumeColors: frame.series[1].data.map((entry: any) => entry.color) });
    runtime.unmount();
  }
  for (const frame of frames) {
    assert.deepEqual(frame.options, frames[0].options, "layout, grid and crosshair options are independent of theme, data and chart type");
    assert.deepEqual(frame.series, frames.find(other => other.type === frame.type)!.series);
    if (frame.populated) assert.deepEqual(frame.volumeColors, frames.find(other => other.populated)!.volumeColors);
  }
  assert.equal(frames[0].options.layout.textColor, chartTokens["--chart-text"]);
  assert.equal(frames[0].options.grid.horzLines.color, chartTokens["--chart-grid"]);
  assert.equal(frames[0].options.crosshair.vertLine.color, chartTokens["--chart-crosshair"]);
});

test("chart axis, overlay, legend and credit text meet AA against their fixed dark panel", () => {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  assert(chartTokens["--chart-background"], "the chart owns a theme-independent palette");
  const background = luminance(chartTokens["--chart-background"]);
  for (const token of ["--chart-text", "--chart-strong", "--chart-link"]) {
    const text = luminance(chartTokens[token]), ratio = (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
    assert(ratio >= 4.5, `${token} contrast ${ratio.toFixed(2)}:1 must meet AA for small text`);
  }
  assert.match(css, /\.chart-empty-status\s*\{[^}]*color: var\(--chart-text\)/);
  assert.match(css, /\.chart-empty-status > span\s*\{[^}]*background: var\(--chart-background\)/);
  assert.match(css, /\.chart-ohlc\s*\{[^}]*color: var\(--chart-text\)/);
  assert.match(css, /\.chart-credit a\s*\{[^}]*color: var\(--chart-link\)/);
});

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
