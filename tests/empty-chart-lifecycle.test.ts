import test from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { marketEndpoint } from "../src/components/TokenMarket";
import { syntheticToken } from "./fixtures";
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...(Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).flatMap(nodes)] : [];

test("changing activity period preserves an empty chart's data and user viewport", async t => {
  const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663 });
  const fetchedAt = new Date().toISOString(), summary = { fetchedAt, priceUsd: 1, periods: { h24: { buys: 2 } } };
  let snapshot = { fetchedAt, candles: [] }, snapshotIndex = 0, pathIndex = 0, Market: any, Chart: any, chartProps: any, refIndex = 0;
  const parent = hookRuntime(() => { snapshotIndex = 0; pathIndex = 0; return Market({ token, refreshKey: "initial" }); });
  ({ default: Market } = await importFresh("src/components/TokenMarket.tsx", { react: { file: import.meta.resolve("react"), bindings: {
    ...parent.hooks, useEffect() {}, useRef(initial: any) { return parent.hooks.useRef(initial === "" ? marketEndpoint(token, "musegod", ["summary", "candles?interval=1h", "trades"][pathIndex++]).key : initial); }, useState(initial: any) {
      return initial && typeof initial === "object" && "loading" in initial
        ? [{ data: [summary, snapshot, { fetchedAt, trades: [] }][snapshotIndex++], loading: false, error: "" }, () => {}]
        : parent.hooks.useState(initial);
    },
  } } }));
  let writes = 0, range = { from: 0, to: 0 };
  const previousStyle = globalThis.getComputedStyle;
  Reflect.set(globalThis, "getComputedStyle", () => ({ getPropertyValue: () => "" }));
  const child = hookRuntime(() => { refIndex = 0; return Chart(chartProps); });
  ({ default: Chart } = await importFresh("src/components/PriceChart.tsx", {
    react: { file: import.meta.resolve("react"), bindings: { ...child.hooks,
      useRef(initial: any) { return child.hooks.useRef(refIndex++ === 0 ? {} : initial); } } },
    "lightweight-charts": { file: import.meta.resolve("lightweight-charts"), bindings: { createChart: () => ({
      addSeries: () => ({ setData() { writes++; }, priceScale: () => ({ applyOptions() {} }) }),
      timeScale: () => ({ applyOptions() {}, getVisibleLogicalRange: () => range, setVisibleLogicalRange(next: typeof range) { range = next; },
        subscribeVisibleLogicalRangeChange() {}, fitContent() {} }), subscribeCrosshairMove() {}, remove() {},
    }) } },
  }));
  t.after(() => { parent.unmount(); child.unmount(); Reflect.set(globalThis, "getComputedStyle", previousStyle); });
  const renderChart = () => { chartProps = nodes(parent.output()).find(node => Array.isArray(node.props?.candles))!.props; child.render(); };
  parent.render(); renderChart();
  const initialWrites = writes;
  range = { from: 12, to: 42 };
  const activity = nodes(parent.output()).find(node => node.props?.["aria-label"] === "Activity period");
  nodes(activity).filter(node => node.type === "button")[0].props.onClick(); await settle(); renderChart();
  assert.equal(writes, initialWrites, "an unrelated parent render must not replace whitespace data");
  assert.deepEqual(range, { from: 12, to: 42 }, "the user's zoom/pan survives activity changes");
  snapshot = { fetchedAt: new Date(Date.now() + 3600_000).toISOString(), candles: [] };
  parent.render(); renderChart();
  assert(writes > initialWrites, "a new candle snapshot may advance the whitespace axis");
});
