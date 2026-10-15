import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { syntheticToken } from "./fixtures";
import { emptyCandlesMessage, marketEndpoint } from "../src/components/TokenMarket";
import type { MarketSummary, CandleData } from "../src/lib/market";

const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663 });
const emptySummary: MarketSummary = { fetchedAt: new Date().toISOString(), source: "CoinGecko", status: "fresh", priceUsd: null, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, periods: { h24: { volume: null, buys: null, sells: null, change: null } } };

async function renderMarket({ summary = emptySummary, error = "", candles = {}, kind = "launch", metric }: { summary?: MarketSummary | null; error?: string; candles?: Partial<CandleData>; kind?: "launch" | "musegod"; metric?: { label: string; value: string } } = {}) {
  const entry = pathToFileURL(`${process.cwd()}/src/components/TokenMarket.tsx`); entry.search = `fixture=${crypto.randomUUID()}`;
  const key = `__declutter${crypto.randomUUID().replaceAll("-", "")}`;
  let dataIndex = 0;
  const mock = {
    useState(initial: any) {
      const data = ++dataIndex;
      if (typeof initial !== "object" || initial === null || !("loading" in initial)) { dataIndex--; return [initial, () => {}]; }
      return [{ data: data === 1 ? summary : data === 2 ? { ...emptySummary, candles: [], ...candles } : { ...emptySummary, trades: [] }, error: data === 1 ? error : "", loading: false }, () => {}];
    },
    useRef(initial: any) { return { current: initial === "" ? marketEndpoint(token, kind, "summary").key : initial }; },
  };
  let pathIndex = 0;
  mock.useRef = (initial: any) => ({ current: initial === "" ? ["summary", "candles?interval=1h", "trades"].map(s => marketEndpoint(token, kind, s).key)[pathIndex++] : initial });
  Reflect.set(globalThis, key, mock);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier !== "react" || context.parentURL !== entry.href) return next(specifier, context);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve("react"))};export const {useState,useRef}=globalThis[${JSON.stringify(key)}];`)}` };
  } });
  try { const { default: View } = await import(entry.href); return renderToStaticMarkup(createElement(View, { token, kind, refreshKey: "initial", metric })); }
  finally { hooks.deregister(); Reflect.deleteProperty(globalThis, key); }
}

test("D4/D5 empty market sections show honest statuses without empty controls or holders", async () => {
  for (const kind of ["launch", "musegod"] as const) {
    const html = await renderMarket({ kind, metric: { label: "Burn share", value: "12%" } });
    assert.match(html, /no price for this pool yet.*on-chain quote/i);
    assert.doesNotMatch(html, /Market cap|Fully diluted valuation|24h volume|change-chip|Activity period|Trade filter|Holders|Holder data|Source pending|Source and fetch/);
    assert.match(html, /Burn share.*12%/);
    assert.match(html, /Recent trades/);
    assert.equal((html.match(/class="feed-note"/g) ?? []).length, 2);
    assert.match(html, /Summary.*CoinGecko.*Candles.*CoinGecko/s);
    assert.match(html, /Latest 30 indexed trades.*indexing may lag the chain/);
    if (kind === "musegod") assert.match(html, /refreshes every minute while visible/);
  }
});

test("D4 request errors, stale empty snapshots and partial values remain distinct", async () => {
  const failed = await renderMarket({ summary: null, error: "Request refused by source" });
  assert.match(failed, /Request refused by source/); assert.doesNotMatch(failed, /no price for this pool yet/);
  const stale = await renderMarket({ summary: { ...emptySummary, status: "stale", warning: "Provider unavailable" } });
  assert.match(stale, /Previous snapshot/); assert.match(stale, /Provider unavailable/);
  const partial = await renderMarket({ summary: { ...emptySummary, liquidityUsd: 0, periods: { h24: { volume: 0, buys: 0, sells: 0, change: 0 } } } });
  assert.match(partial, /Market cap/); assert.match(partial, /Activity period/); assert.match(partial, /\$0/);
  const quiet = await renderMarket({ summary: { ...emptySummary, priceUsd: 1 } });
  assert.doesNotMatch(quiet, /Activity period/); assert.match(quiet, /Market cap/);
});

test("D4 empty candles with fallback failure do not mislabel the primary source or suggest interval changes", async () => {
  const html = await renderMarket({ candles: { source: "Bankr", reason: "backoff", causes: [{ source: "GeckoTerminal", reason: "backoff" }] } });
  assert.match(html, /Bankr.*no indexed price records/i);
  assert.match(html, /GeckoTerminal.*backoff/i);
  assert.doesNotMatch(html, /Try a longer interval|Bankr.*unavailable/);
});

test("D7 mounting loads each real market section once and a later trade refresh loads each again", async () => {
  const entry = pathToFileURL(`${process.cwd()}/src/components/TokenMarket.tsx`); entry.search = `hooks=${crypto.randomUUID()}`;
  const key = `__marketHooks${crypto.randomUUID().replaceAll("-", "")}`;
  const cells: any[] = [], pending: (() => void)[] = [], cleanups: (() => void)[] = [];
  let cursor = 0, dirty = false;
  const mock = {
    useState(initial: any) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], (value: any) => { const next = typeof value === "function" ? value(cells[i]) : value; if (!Object.is(next, cells[i])) { cells[i] = next; dirty = true; } }]; },
    useRef(initial: any) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useEffect(fn: () => any, deps: any[]) { const i = cursor++; if (!cells[i] || deps.some((v, j) => !Object.is(v, cells[i][j]))) { cells[i] = deps; pending.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  Reflect.set(globalThis, key, mock);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier !== "react" || context.parentURL !== entry.href) return next(specifier, context);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve("react"))};export const {useState,useRef,useEffect}=globalThis[${JSON.stringify(key)}];`)}` };
  } });
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  Reflect.set(globalThis, "document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  Reflect.set(globalThis, "window", { addEventListener() {}, removeEventListener() {} });
  const previous = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: any) => { requests.push(String(url)); return new Response(JSON.stringify(String(url).endsWith("summary") ? emptySummary : { ...emptySummary, candles: [], trades: [] }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const { default: View } = await import(entry.href);
    async function settle(refreshKey: string) {
      for (let n = 0; n < 8; n++) {
        cursor = 0; dirty = false; renderToStaticMarkup(createElement(View, { token, refreshKey }));
        pending.splice(0).forEach(fn => fn());
        await new Promise(resolve => setImmediate(resolve));
        if (!dirty) return;
      }
      assert.fail("Market effects did not settle");
    }
    await settle("initial"); assert.equal(requests.length, 3, requests.join("\n"));
    await settle("initial"); assert.equal(requests.length, 3);
    await settle("confirmed-trade"); assert.equal(requests.length, 6);
    assert(requests.every(url => !url.includes("holders")));
    for (const section of ["summary", "candles?interval=1h", "trades"]) assert.equal(requests.filter(url => url.endsWith(section)).length, 2);
  } finally { cleanups.forEach(fn => fn?.()); Reflect.set(globalThis, "document", previousDocument); Reflect.set(globalThis, "window", previousWindow); globalThis.fetch = previous; hooks.deregister(); Reflect.deleteProperty(globalThis, key); }
});

test("D4 the longest interval never suggests a longer one and reason codes remain distinguishable", () => {
  assert.match(emptyCandlesMessage(null, "1h"), /Try a longer interval/);
  assert.doesNotMatch(emptyCandlesMessage(null, "1d"), /longer interval/);
  const data = { ...emptySummary, candles: [] };
  assert.match(emptyCandlesMessage({ ...data, reason: "not_indexed" }, "1d"), /pool not indexed/);
  assert.match(emptyCandlesMessage({ ...data, reason: "quota_exhausted" }, "1h"), /quota exhausted/);
  assert.match(emptyCandlesMessage({ ...data, reason: "rate_limited" }, "1h"), /rate limited/);
  assert.doesNotMatch(emptyCandlesMessage({ ...data, reason: "backoff" }, "1h"), /Try a longer interval/);
});
