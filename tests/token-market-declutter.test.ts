import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { syntheticToken } from "./fixtures";
import { emptyCandlesMessage, marketEndpoint } from "../src/components/TokenMarket";
import type { MarketSummary, CandleData, TradeData } from "../src/lib/market";

const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663 });
const emptySummary: MarketSummary = { fetchedAt: new Date().toISOString(), source: "CoinGecko", status: "fresh", priceUsd: null, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, periods: { h24: { volume: null, buys: null, sells: null, change: null } } };

async function renderMarket({ summary = emptySummary, error = "", candles = {}, historyError = "", trades = {}, tradesError = "", loading = false, filter = "all", kind = "launch", metric }: { summary?: MarketSummary | null; error?: string; candles?: Partial<CandleData> | null; historyError?: string; trades?: Partial<TradeData> | null; tradesError?: string; loading?: boolean; filter?: string; kind?: "launch" | "musegod"; metric?: { label: string; value: string } } = {}) {
  const entry = pathToFileURL(`${process.cwd()}/src/components/TokenMarket.tsx`); entry.search = `fixture=${crypto.randomUUID()}`;
  const key = `__declutter${crypto.randomUUID().replaceAll("-", "")}`;
  let dataIndex = 0;
  const mock = {
    useState(initial: any) {
      const data = ++dataIndex;
      if (typeof initial !== "object" || initial === null || !("loading" in initial)) { dataIndex--; return [initial === "all" ? filter : initial, () => {}]; }
      return [{ data: data === 1 ? summary : data === 2 ? candles === null ? null : { ...emptySummary, candles: [], ...candles } : trades === null ? null : { ...emptySummary, trades: [], ...trades }, error: data === 1 ? error : data === 2 ? historyError : tradesError, loading }, () => {}];
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
    assert.match(html, /no price for this pool yet.*on-chain price preview/i);
    assert.doesNotMatch(html, /Market cap|Fully diluted valuation|24h volume|change-chip|Activity period|Trade filter|Holders|Holder data|Source pending|Source and fetch/);
    assert.match(html, /Burn share.*12%/);
    assert.match(html, /Recent trades/);
    assert.equal((html.match(/class="feed-note"/g) ?? []).length, 2);
    assert.match(html, /Summary.*CoinGecko.*Candles.*CoinGecko/s);
    assert.match(html, /Latest 30 indexed trades.*indexing may lag the chain/);
    if (kind === "musegod") assert.match(html, /refreshes every 15 seconds while visible/);
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
  assert.match(html, /No indexed price records.*provider.*pausing updates/i);
  assert.match(html, /Candles.*Bankr \/ Pools/);
  assert.doesNotMatch(html, /Try a longer interval|Bankr.*unavailable|Source checks|GeckoTerminal:/);
});

test("C1-1 missing sections retain errors in each section and the chart's tooltip and description", async () => {
  for (const error of ["Market data unavailable", "Market records are not indexed for this pool yet.", "The market snapshot is more than 24 hours old. Refresh to update.", "The local fork does not show mainnet market data. Use the on-chain quote panel on the right."]) {
    for (const kind of ["launch", "musegod"] as const) {
      const html = await renderMarket({ summary: null, error, candles: null, historyError: error, trades: null, tradesError: error, kind });
      assert.doesNotMatch(html, /Request failed:/);
      const [market, feed] = html.split('<section class="card market-feed"');
      assert.equal(market.split(error).length - 1, 3, error);
      assert.equal(feed.split(error).length - 1, 1, error);
      assert.doesNotMatch(html, /CoinGecko|Fetched/);
    }
  }
});

test("C1-1 stale empty sections retain their own warnings, with the chart reason in both accessible channels", async () => {
  const html = await renderMarket({
    summary: { ...emptySummary, status: "stale", warning: "Summary refresh failed" },
    candles: { status: "stale", source: "Bankr", fetchedAt: "2026-10-15T10:01:00Z", warning: "Chart refresh failed" },
    trades: { status: "stale", source: "GeckoTerminal", fetchedAt: "2026-10-15T10:02:00Z", warning: "Trades refresh failed" },
    historyError: "Chart refresh failed", tradesError: "Trades refresh failed",
  });
  for (const warning of ["Summary refresh failed", "Chart refresh failed", "Trades refresh failed"]) assert.equal(html.split(warning).length - 1, warning === "Chart refresh failed" ? 2 : 1, warning);
  assert.match(html, /Summary.*Previous snapshot.*CoinGecko/);
  assert.match(html, /Candles.*Previous snapshot.*Bankr.*2026-10-15T10:01:00Z/);
  assert.match(html, /Trades.*Previous snapshot.*GeckoTerminal.*2026-10-15T10:02:00Z/);
});

test("C1-3 loading or failed MUSEGOD sections never leave a leading provenance separator", async () => {
  for (const loading of [true, false]) {
    const html = await renderMarket({ summary: null, candles: null, trades: null, loading, kind: "musegod" });
    assert.match(html, /<p class="feed-note">refreshes every 15 seconds while visible<\/p>/);
    assert.doesNotMatch(html, /<p class="feed-note"> ·/);
  }
});

test("C1-4 filter copy appears only when the snapshot contains trades", async () => {
  const empty = await renderMarket();
  assert.match(empty, /No indexed trades in this snapshot\./);
  assert.doesNotMatch(empty, /Trade filter|match this filter/);
  const filtered = await renderMarket({ filter: "sell", trades: { trades: [{ id: "buy", hash: "0x123", account: null, at: emptySummary.fetchedAt, side: "buy", amount: 1, usd: 1, price: 1 }] } });
  assert.match(filtered, /Trade filter/);
  assert.match(filtered, /No indexed trades match this filter\./);
});

test("C1-1 a stale trade snapshot with no filter matches shows its warning once", async () => {
  const html = await renderMarket({ filter: "sell", tradesError: "Trade refresh failed", trades: { status: "stale", trades: [{ id: "buy", hash: "0x123", account: null, at: emptySummary.fetchedAt, side: "buy", amount: 1, usd: 1, price: 1 }] } });
  assert.equal(html.split("Trade refresh failed").length - 1, 1);
  assert.match(html, /Trade filter/);
  assert.match(html, /Trades.*Previous snapshot/);
});

test("C1-7 empty market cards give one quote pointer and buyer-readable provider causes", async () => {
  for (const reason of [undefined, "backoff", "rate_limited", "not_indexed"] as const) {
    for (const summary of [emptySummary, { ...emptySummary, priceUsd: 1 }]) {
      const html = await renderMarket({ summary, candles: { source: "Bankr", reason, ...(reason ? { causes: [{ source: "GeckoTerminal", reason }] } : {}) } });
      const market = html.split('<section class="card market-feed"')[0];
      assert.equal(market.split("Enter an amount in the trade panel for an on-chain price preview.").length - 1, 1);
      assert.doesNotMatch(market, /Source checks|temporarily in backoff|GeckoTerminal:/);
      if (reason === "not_indexed") assert.match(market, /pool is not indexed yet/);
      if (reason === "rate_limited") assert.match(market, /provider is rate limited/);
      if (reason === "backoff") assert.match(market, /provider is temporarily pausing updates/);
    }
  }
});

const cards = (html: string) => html.split('<section class="card market-feed"') as [string, string];
const activitySummary = (kind: "launch" | "musegod", over: Partial<MarketSummary> = {}): MarketSummary => ({
  ...emptySummary, source: kind === "musegod" ? "Bankr" : "CoinGecko", fetchedAt: "2026-10-16T01:00:00Z", priceUsd: 1,
  periods: { h24: { volume: 123, buys: 7, sells: 2, change: 4 } }, ...over,
});
const summaryProvenance = (kind: "launch" | "musegod", stale: boolean) => new RegExp(`Summary · ${stale ? "Previous snapshot · " : "(?!Previous snapshot)"}${kind === "musegod" ? '<a href="[^"]*"[^>]*>Bankr / Pools' : '<a href="https://www.coingecko.com/en/api"[^>]*>Data provided by CoinGecko'}[^<]*</a> · Fetched <time dateTime="2026-10-16T01:00:00Z"`);

test("X2-1 activity sits in the market card with the summary's own source, time and stale state", async () => {
  for (const kind of ["launch", "musegod"] as const) {
    const staleSummary = activitySummary(kind, { status: "stale", warning: "Summary-only refresh failed" });
    const staleMixed = await renderMarket({ kind, summary: staleSummary, trades: { source: "GeckoTerminal", fetchedAt: "2026-10-16T01:02:00Z" } });
    const [market, feed] = cards(staleMixed);
    assert(market.indexOf("24h volume") < market.indexOf("Activity period") && market.indexOf("Activity period") < market.indexOf("Chart type"), kind);
    assert.match(market, /Activity period.*7 buys.*2 sells.*Volume.*\$123.*Price change.*\+4\.00%/s);
    assert.equal(market.split("Summary-only refresh failed").length - 1, 1);
    assert.match(market, summaryProvenance(kind, true));
    assert.doesNotMatch(feed, /Activity period|buys|sells|Volume|Price change|Summary-only refresh failed|Previous snapshot|2026-10-16T01:00:00Z/);
    assert.match(feed, /Trades · GeckoTerminal · Fetched <time dateTime="2026-10-16T01:02:00Z"/);
    assert.doesNotMatch(market, /2026-10-16T01:02:00Z/);

    const staleTrades = await renderMarket({ kind, summary: activitySummary(kind), trades: { status: "stale", source: "GeckoTerminal", fetchedAt: "2026-10-16T01:02:00Z", warning: "Trades refresh failed" }, tradesError: "Trades refresh failed" });
    const [freshMarket, staleFeed] = cards(staleTrades);
    assert.match(freshMarket, /Activity period.*7 buys/s);
    assert.match(freshMarket, summaryProvenance(kind, false));
    assert.doesNotMatch(freshMarket, /Trades refresh failed|2026-10-16T01:02:00Z/);
    assert.doesNotMatch(staleFeed, /Activity period|buys|Volume|Price change/);
    assert.match(staleFeed, /Trades · Previous snapshot · GeckoTerminal · Fetched <time dateTime="2026-10-16T01:02:00Z"/);

    const noTrades = await renderMarket({ kind, summary: activitySummary(kind), trades: null, tradesError: "Market data unavailable" });
    const [shownMarket, emptyFeed] = cards(noTrades);
    assert.match(shownMarket, /Activity period.*7 buys.*Volume/s);
    assert.match(shownMarket, summaryProvenance(kind, false));
    assert.doesNotMatch(emptyFeed, /Activity period|buys|Volume|Price change|CoinGecko|Bankr|Fetched/);
    assert.equal(emptyFeed.split("Market data unavailable").length - 1, 1);
  }
});

test("X2-1 activity keeps its visibility rule without summary activity values", async () => {
  for (const kind of ["launch", "musegod"] as const) {
    const none = await renderMarket({ kind, summary: activitySummary(kind, { periods: { h24: { volume: null, buys: null, sells: null, change: null } } }) });
    assert.doesNotMatch(none, /Activity period|buys|sells|Price change/);
    const zero = await renderMarket({ kind, summary: activitySummary(kind, { periods: { h24: { volume: 0, buys: 0, sells: 0, change: 0 } } }) });
    assert.match(cards(zero)[0], /Activity period.*0 buys.*0 sells/s);
    assert.doesNotMatch(cards(zero)[1], /Activity period|buys/);
  }
});

test("C1b-1 a stale empty chart or trade list keeps its empty statement beside the stale note", async () => {
  const note = "Refresh is unavailable. Showing a stale snapshot.";
  const html = await renderMarket({ candles: { status: "stale", warning: note, source: "Bankr", reason: "backoff" }, trades: { status: "stale", warning: note } });
  const [market, feed] = cards(html);
  assert.match(market, /No indexed price records for this interval\..*pausing updates\. Try again later\. Refresh is unavailable\. Showing a stale snapshot\./);
  assert.match(feed, /No indexed trades in this snapshot\. Refresh is unavailable\. Showing a stale snapshot\./);
  assert.equal(market.split(note).length - 1, 2); assert.equal(feed.split(note).length - 1, 1);
  const plain = await renderMarket({ candles: { status: "stale", warning: note } });
  assert.match(cards(plain)[0], /No indexed price records for this interval\. Try a longer interval\. Refresh is unavailable/);
  const failed = await renderMarket({ candles: { status: "stale", warning: "Network unavailable. Showing the previous snapshot." }, historyError: "Chart refresh failed", trades: { status: "stale", warning: "Network unavailable. Showing the previous snapshot." }, tradesError: "Trades refresh failed" });
  assert.match(cards(failed)[0], /No indexed price records for this interval\..*Chart refresh failed/);
  assert.match(cards(failed)[1], /No indexed trades in this snapshot\. Trades refresh failed/);
  assert.equal(failed.split("Network unavailable").length - 1, 0);
  const filtered = await renderMarket({ filter: "sell", trades: { status: "stale", warning: "Trade refresh failed", trades: [{ id: "buy", hash: "0x123", account: null, at: emptySummary.fetchedAt, side: "buy", amount: 1, usd: 1, price: 1 }] }, tradesError: "Trade refresh failed" });
  assert.match(filtered, /No indexed trades match this filter\. Trade refresh failed/);
  const fresh = await renderMarket();
  assert.doesNotMatch(fresh, /stale snapshot|Refresh to update/);
});

test("C1b-2 combined transient causes say to try again later once", () => {
  const data = { ...emptySummary, candles: [] };
  const retries = (message: string) => message.split("Try again later.").length - 1;
  const both = emptyCandlesMessage({ ...data, reason: "rate_limited", causes: [{ source: "Bankr", reason: "rate_limited" }, { source: "GeckoTerminal", reason: "backoff" }] }, "1h");
  assert.equal(retries(both), 1); assert.match(both, /rate limited.*pausing updates/);
  for (const reason of ["rate_limited", "backoff"] as const) assert.equal(retries(emptyCandlesMessage({ ...data, reason }, "1h")), 1, reason);
  const mixed = emptyCandlesMessage({ ...data, reason: "not_indexed", causes: [{ source: "CoinGecko", reason: "not_indexed" }, { source: "GeckoTerminal", reason: "backoff" }] }, "1h");
  assert.equal(retries(mixed), 1); assert.match(mixed, /not indexed yet.*pausing updates/);
  for (const reason of ["not_indexed", "upstream_http", "quota_exhausted"] as const) assert.equal(retries(emptyCandlesMessage({ ...data, reason }, "1h")), 0, reason);
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
  assert.match(emptyCandlesMessage({ ...data, reason: "not_indexed" }, "1d"), /pool is not indexed/);
  assert.match(emptyCandlesMessage({ ...data, reason: "quota_exhausted" }, "1h"), /data limit/);
  assert.match(emptyCandlesMessage({ ...data, reason: "rate_limited" }, "1h"), /rate limited/);
  assert.doesNotMatch(emptyCandlesMessage({ ...data, reason: "backoff" }, "1h"), /Try a longer interval/);
});

test("empty, loading, failed and stale-empty charts share the real frame and retain their status", async () => {
  for (const kind of ["launch", "musegod"] as const) {
    for (const [options, status] of [
      [{}, "No indexed price records for this interval."],
      [{ candles: null, loading: true }, "Loading market data…"],
      [{ candles: null, historyError: "The price request failed." }, "The price request failed."],
      [{ candles: { reason: "not_indexed" } }, "The pool is not indexed yet."],
      [{ candles: { reason: "rate_limited" } }, "The price provider is rate limited."],
      [{ candles: { status: "stale", reason: "backoff", warning: "Previous chart snapshot. Refresh to update." } }, "Previous chart snapshot. Refresh to update."],
    ] as const) {
      const [market] = cards(await renderMarket({ ...options, kind }));
      assert.match(market, /class="price-chart-wrap"/);
      assert.match(market, /class="price-chart[^\"]*"[^>]*role="img"[^>]*with 0/);
      assert.match(market, /class="chart-status" role="status" title=/);
      assert(market.includes(status));
      assert.match(market, /TradingView Lightweight Charts/);
      assert.doesNotMatch(market, /class="market-empty"|<b>/);
      if (!("loading" in options)) assert.match(market, /Enter an amount in the trade panel for an on-chain price preview/);
    }
  }
});

test("chart frames omit an unknown unit and empty labels never invite price inspection", async () => {
  for (const options of [{ candles: null, loading: true }, { candles: null, historyError: "Chart request failed." }, { candles: {} }] as const) {
    const [market] = cards(await renderMarket(options));
    const frame = market.slice(market.indexOf('class="price-chart-wrap"'), market.indexOf('class="chart-credit"'));
    assert.doesNotMatch(frame, /USD|hover to inspect prices/);
    assert.match(frame, /with 0 (?:candles|points)\. (?:Loading market data…|No price history yet|Chart data temporarily unavailable)/);
  }
  const [known] = cards(await renderMarket({ candles: { unit: "WETH" } }));
  assert.match(known, /WETH price \/ volume/);
});

test("chart status maps loading, empty, every reason and client failures to buyer copy with precise descriptions", async () => {
  const reasons = ["missing_config", "quota_exhausted", "not_indexed", "rate_limited", "upstream_http", "upstream_transport", "upstream_unclassified", "invalid_identity", "invalid_schema", "source_not_provided", "history_not_available", "storage_unavailable", "internal_error", "backoff"] as const;
  for (const kind of ["launch", "musegod"] as const) {
    for (const [options, text, reason] of [
      [{ candles: null, loading: true }, "Loading market data…", "Loading market data…"],
      [{}, "No price history yet", emptyCandlesMessage({ ...emptySummary, candles: [] }, "1h")],
      ...reasons.map(reason => [{ candles: { reason } }, "Chart data temporarily unavailable", emptyCandlesMessage({ ...emptySummary, candles: [], reason }, "1h")] as const),
      [{ candles: null, historyError: "Client price request failed." }, "Chart data temporarily unavailable", "Client price request failed."],
      [{ candles: null }, "Chart data temporarily unavailable", emptyCandlesMessage(null, "1h")],
      [{ candles: { status: "unavailable" } }, "Chart data temporarily unavailable", emptyCandlesMessage(null, "1h")],
      [{ candles: { status: "stale", warning: "Chart refresh failed." } }, "Chart data temporarily unavailable", `${emptyCandlesMessage(null, "1h")} Chart refresh failed.`],
    ] as const) {
      const [market] = cards(await renderMarket({ ...options, kind }));
      assert.match(market, new RegExp(`<p class="chart-status" role="status" title="[^"]*">${text}</p>`));
      assert(market.includes(`title="${reason}"`), `tooltip must retain ${reason}`);
      assert(market.includes(`aria-description="${reason}"`), "chart description retains the precise reason");
      const frame = market.split('<div class="chart-frame">')[1].split('<div class="chart-credit">')[0];
      assert.doesNotMatch(frame.replace(/<[^>]*>/g, ""), /Loading|No price|unavailable|indexed|request|provider/);
      assert.match(frame, /class="chart-watermark" aria-hidden="true"/);
      if (text.startsWith("Loading")) assert.match(frame, /aria-label="[^"]*Loading market data…/);
      assert.doesNotMatch(market, /chart-empty-status|No trades/);
    }
  }
});

test("loading chart chunks show the final populated unit and loading label, including known quote units", async () => {
  const candle = { time: 1800000000, open: 1, high: 2, low: 1, close: 2, volume: 3 };
  for (const unit of [undefined, "WETH"]) {
    const [market] = cards(await renderMarket({ candles: { candles: [candle], unit } }));
    assert.match(market, new RegExp(`class="chart-ohlc"[^>]*><span>${token.symbol} / ${unit ?? "USD"}</span>`));
    assert.match(market, /aria-label="[^"]*Loading market data…/);
    assert.doesNotMatch(market, /No price records/);
    assert.match(market, />Loading market data…<\/p>/);
  }
});
