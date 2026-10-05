import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../src/lib/config";
import { MUSEGOD } from "../src/lib/musegod";
import {
  MUSEGOD_MARKET_TTL,
  MusegodMarketReader,
  parseMusegodCandles,
  parseMusegodSummary,
  parseMusegodTrades,
} from "../server/musegod-market";
import { MAX_STALE, MarketUnavailable, SNAPSHOT_TTL, Snapshots } from "../server/snapshots";
import type { StoreBackend } from "../server/supabase-store";

const NOW = Date.parse("2026-10-05T09:00:00.000Z");
const TIME = NOW / 1000 - 3600;
const config: RuntimeConfig = {
  mode: "robinhood", chainId: 4663, writesEnabled: false, treasury: null, blockReason: null,
};
const discovery = () => ({ token: {
  tokenAddress: MUSEGOD.token, poolId: MUSEGOD.pool, chain: "robinhood",
  name: "MUSEGOD", symbol: "MUSEGOD", pairedAsset: "weth",
  decimals: null, totalSupply: null, lastPriceUsd: 0.0003, marketCapUsd: 300000,
  lastTradeAt: "2026-10-05T08:37:57.000Z", priceChange5m: 0,
  priceChange1h: -6.5, priceChange6h: "3.2", priceChange24h: -46,
} });
const stats = () => ({ liquidityUsd: 135000, windows: {
  "5m": { buys: 0, sells: 0, totalVolumeUsd: 0 },
  "24h": { buys: 301, sells: 198, totalVolumeUsd: 79000 },
} });
const candles = () => ({
  ohlcv: [[TIME + 300, 2, 3, 1, 2.5, 12], [TIME, 1, 2, 0.5, 1.5, 0]],
  pool: { address: MUSEGOD.pool, network: "robinhood" },
  pair: { baseSymbol: "MUSEGOD", quoteSymbol: "WETH" },
  watermark: { blockNumber: 80650177, logIndex: 75, txHash: `0x${"a".repeat(64)}` },
});
const swap = (logIndex = 1, timestamp = "2026-10-05T08:37:57.000Z") => ({
  txHash: `0x${"b".repeat(64)}`, blockNumber: 80650177, logIndex, timestamp,
  side: "buy", tokenAmount: 10, totalUsd: 2, traderAddress: MUSEGOD.weth,
  chain: "robinhood",
});
function memoryStore() {
  const rows = new Map<string, { at: number; data: unknown }>();
  const store = {
    snapshot: (key: string) => rows.get(key) ?? null,
    saveSnapshot: (key: string, data: unknown, at: number) => { rows.set(key, { at, data }); },
    reserveMarketCall: () => { throw new Error("Bankr must not consume the CoinGecko quota"); },
  } as unknown as StoreBackend;
  return { store, rows };
}
function readerFixture() {
  const { store, rows } = memoryStore();
  let now = NOW;
  const calls: string[] = [];
  let fault: "stats" | "all" | "rate" | "redirect" | "invalid" | "timeout" | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(new URL(url).origin, "https://api.bankr.bot");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, { accept: "application/json" });
    if (fault === "timeout") throw new DOMException("timeout", "TimeoutError");
    if (fault === "invalid") return new Response("invalid JSON");
    if (fault === "rate") return new Response("rate limited", { status: 429 });
    if (fault === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } });
    if (fault === "all" || (fault === "stats" && url.includes("/stats?")))
      return new Response("unavailable", { status: 502 });
    const data = url.includes("/ohlcv?") ? candles()
      : url.includes("/stats?") ? stats()
      : url.includes("/swaps?") ? { swaps: [swap()] } : discovery();
    return Response.json(data);
  };
  return {
    reader: new MusegodMarketReader(config, store, { fetch: fetcher, now: () => now }),
    store, rows, calls,
    advance: (milliseconds: number) => { now += milliseconds; },
    fault: (value: typeof fault) => { fault = value; },
    now: () => now,
  };
}

test("MUSEGOD summary retains unknown supply/FDV, signed changes and valid zero values", () => {
  const result = parseMusegodSummary(discovery(), stats(), NOW);
  assert.equal(result.priceUsd, 0.0003);
  assert.equal(result.marketCapUsd, 300000);
  assert.equal(result.fdvUsd, null);
  assert.equal(result.lastTradeAt, "2026-10-05T08:37:57.000Z");
  assert.deepEqual(result.periods.m5, { change: 0, volume: 0, buys: 0, sells: 0 });
  assert.deepEqual(result.periods.h1, { change: -6.5, volume: null, buys: null, sells: null });
  assert.equal(result.periods.h6.change, 3.2);
  const sparse = parseMusegodSummary({ token: {
    ...discovery().token, lastPriceUsd: null, marketCapUsd: "NaN", lastTradeAt: null,
    priceChange5m: undefined,
  } }, { liquidityUsd: -1 }, NOW);
  assert.equal(sparse.priceUsd, null);
  assert.equal(sparse.marketCapUsd, null);
  assert.equal(sparse.liquidityUsd, null);
  assert.equal(sparse.lastTradeAt, null);
  assert.equal(sparse.periods.m5.change, null);
});

test("MUSEGOD summary fails closed for missing or mismatched token, pool, network and orientation", () => {
  for (const patch of [
    { tokenAddress: MUSEGOD.weth }, { tokenAddress: null }, { poolId: MUSEGOD.weth },
    { poolId: `0x${"a".repeat(64)}` }, { chain: "base" }, { chain: null },
    { symbol: "WETH" }, { name: "Other" }, { pairedAsset: "usdc" }, { decimals: 6 },
    { lastTradeAt: "2026-10-05T09:10:00.000Z" },
  ]) assert.throws(() => parseMusegodSummary({ token: { ...discovery().token, ...patch } }, stats(), NOW));
  assert.throws(() => parseMusegodSummary(discovery(), { windows: [] }, NOW));
});

test("provider candles keep real trade gaps, sort/deduplicate, preserve watermark and zero volume", () => {
  const raw = candles();
  raw.ohlcv.push([TIME, 1, 2, 0.5, 1.75, 0]);
  const result = parseMusegodCandles(raw, NOW);
  assert.deepEqual(result.candles.map((candle) => candle.time), [TIME, TIME + 300]);
  assert.equal(result.candles[0].close, 1.75);
  assert.equal(result.candles[0].volume, 0);
  assert.deepEqual(result.watermark, raw.watermark);
  assert.deepEqual(parseMusegodCandles({ ...raw, ohlcv: [], watermark: null }, NOW).candles, []);
});

test("MUSEGOD candles reject the wrong pool/pair/network, malformed prices and future timestamps", () => {
  const original = candles();
  for (const raw of [
    { ...original, pool: { address: MUSEGOD.weth, network: "robinhood" } },
    { ...original, pool: { address: MUSEGOD.pool, network: "base" } },
    { ...original, pair: { baseSymbol: "WETH", quoteSymbol: "MUSEGOD" } },
    { ...original, ohlcv: [[TIME, null, 2, 0.5, 1, 10]] },
    { ...original, ohlcv: [[TIME, 3, 2, 1, 1, 10]] },
    { ...original, ohlcv: [[TIME, 1, 2, 3, 1, 10]] },
    { ...original, ohlcv: [[NOW / 1000 + 61, 1, 2, 0.5, 1, 10]] },
    { ...original, watermark: { ...original.watermark, txHash: "0x1" } },
  ]) assert.throws(() => parseMusegodCandles(raw, NOW));
});

test("MUSEGOD trades sort by time/block/log, deduplicate event IDs and preserve unknown traders/USD", () => {
  const older = swap(1, "2026-10-05T08:30:00.000Z");
  const latest = { ...swap(4), side: "sell", traderAddress: null, totalUsd: 0 };
  const other = { ...swap(3), totalUsd: null };
  const raw = { swaps: [older, other, latest, older] };
  const result = parseMusegodTrades(raw, NOW);
  assert.equal(result.trades.length, 3);
  assert.deepEqual(result.trades.map((trade) => trade.id.split(":").at(-1)), ["4", "3", "1"]);
  assert.equal(result.trades[0].side, "sell");
  assert.equal(result.trades[0].account, null);
  assert.equal(result.trades[0].usd, 0);
  assert.equal(result.trades[0].price, 0);
  assert.equal(result.trades[1].usd, null);
  assert.equal(result.trades[1].price, null);
  assert.equal(result.trades[2].price, 0.2);
  assert.deepEqual(parseMusegodTrades({ swaps: [] }, NOW).trades, []);
  assert.equal(parseMusegodTrades({ swaps: Array.from({ length: 40 }, (_, i) => swap(i)) }, NOW).trades.length, 30);
});

test("MUSEGOD trades reject wrong networks, malformed event identity, invalid amounts and future time", () => {
  for (const patch of [
    { chain: "base" }, { chain: null }, { txHash: null }, { txHash: "0x1" },
    { traderAddress: "not-an-address" }, { side: "unknown" }, { tokenAmount: 0 },
    { tokenAmount: -1 }, { tokenAmount: null }, { logIndex: -1 },
    { timestamp: "2026-10-05T09:01:01.000Z" },
  ]) assert.throws(() => parseMusegodTrades({ swaps: [{ ...swap(), ...patch }] }, NOW));
});

test("MUSEGOD reader shares a 60-second persistent snapshot and fixed GETs without CoinGecko quota", async () => {
  const f = readerFixture();
  const [first, duplicate, history, trades] = await Promise.all([
    f.reader.summary(), f.reader.summary(), f.reader.candles("5m"), f.reader.trades(),
  ]);
  assert.equal(first.source, "Bankr");
  assert.equal(first.status, "fresh");
  assert.equal(first.nextRefreshAt, new Date(NOW + MUSEGOD_MARKET_TTL).toISOString());
  assert.equal(first, duplicate);
  assert.equal(history.candles.length, 2);
  assert.equal(trades.trades.length, 1);
  assert.equal(f.calls.length, 4);
  assert(f.calls.includes(`https://api.bankr.bot/discover/${MUSEGOD.token.toLowerCase()}/ohlcv?aggregate=5&limit=200&timeframe=minute&chain=robinhood`));
  assert([...f.rows.keys()].every((key) => key.startsWith(`bankr:robinhood:${MUSEGOD.token.toLowerCase()}:${MUSEGOD.pool.toLowerCase()}:`)));
  f.advance(MUSEGOD_MARKET_TTL - 1);
  await f.reader.summary();
  assert.equal(f.calls.length, 4);
  // A new reader also uses the stored snapshot, including the same source/time.
  const restarted = new MusegodMarketReader(config, f.store, {
    now: f.now, fetch: async () => { throw new Error("Cached data should not fetch"); },
  });
  assert.equal((await restarted.summary()).fetchedAt, first.fetchedAt);
  f.advance(1);
  await f.reader.summary();
  assert.equal(f.calls.length, 6);
});

test("all six chart intervals use only the fixed MUSEGOD URL and correct timeframe/aggregate", async () => {
  const f = readerFixture();
  for (const [interval, timeframe, aggregate] of [
    ["1m", "minute", 1], ["5m", "minute", 5], ["15m", "minute", 15],
    ["1h", "hour", 1], ["4h", "hour", 4], ["1d", "day", 1],
  ] as const) {
    await f.reader.candles(interval);
    const url = new URL(f.calls.at(-1)!);
    assert.equal(url.searchParams.get("timeframe"), timeframe);
    assert.equal(url.searchParams.get("aggregate"), String(aggregate));
    assert.equal(url.searchParams.get("chain"), "robinhood");
  }
  assert.throws(() => f.reader.candles("bad" as never), /Invalid chart interval/);
  assert.equal(f.calls.length, 6);
});

test("summary/chart/trades failures remain independent, retry after 60s and never renew stale age", async () => {
  const f = readerFixture();
  const first = await f.reader.summary();
  f.advance(MUSEGOD_MARKET_TTL);
  f.fault("stats");
  const [stale, history, trades] = await Promise.all([
    f.reader.summary(), f.reader.candles("1h"), f.reader.trades(),
  ]);
  assert.equal(stale.status, "stale");
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.equal(stale.nextRefreshAt, new Date(NOW + 2 * MUSEGOD_MARKET_TTL).toISOString());
  assert.equal(history.status, "fresh");
  assert.equal(trades.status, "fresh");
  const calls = f.calls.length;
  await f.reader.summary();
  assert.equal(f.calls.length, calls, "Manual refresh cannot bypass failure backoff");
  f.advance(MUSEGOD_MARKET_TTL);
  f.fault(null);
  const recovered = await f.reader.summary();
  assert.equal(recovered.status, "fresh");
  assert.equal(recovered.fetchedAt, new Date(f.now()).toISOString());
  f.advance(MAX_STALE);
  f.fault("all");
  await assert.rejects(() => f.reader.summary(), (error: unknown) =>
    error instanceof MarketUnavailable && error.source === "Bankr" && error.status === "unavailable",
  );
});

test("redirects, 429/502, invalid JSON and network timeout cannot create a valid market snapshot", async () => {
  for (const failure of ["all", "rate", "redirect", "invalid", "timeout"] as const) {
    const f = readerFixture();
    f.fault(failure);
    await assert.rejects(() => f.reader.candles("1h"), MarketUnavailable);
    assert.equal(f.rows.size, 0);
    const calls = f.calls.length;
    await assert.rejects(() => f.reader.candles("1h"), MarketUnavailable);
    assert.equal(f.calls.length, calls);
  }
});

test("bad discover identity cannot mark newly fetched stats or swaps fresh", async () => {
  const { store } = memoryStore();
  const reader = new MusegodMarketReader(config, store, { now: () => NOW, fetch: async (input) => {
    const url = String(input);
    return Response.json(url.includes("/stats?") ? stats()
      : url.includes("/swaps?") ? { swaps: [swap()] }
      : { token: { ...discovery().token, tokenAddress: MUSEGOD.weth } });
  } });
  await assert.rejects(() => reader.summary(), MarketUnavailable);
  await assert.rejects(() => reader.trades(), MarketUnavailable);
});

test("a stale discover identity only permits the prior valid summary/trades snapshot", async () => {
  const { store } = memoryStore();
  let now = NOW, wrongToken = false, swaps = 0;
  const reader = new MusegodMarketReader(config, store, { now: () => now, fetch: async (input) => {
    const url = String(input);
    if (url.includes("/swaps?")) { swaps++; return Response.json({ swaps: [swap()] }); }
    if (url.includes("/stats?")) return Response.json(stats());
    if (url.includes("/ohlcv?")) return Response.json(candles());
    return Response.json({ token: { ...discovery().token,
      tokenAddress: wrongToken ? MUSEGOD.weth : MUSEGOD.token,
    } });
  } });
  const [firstSummary, firstTrades] = await Promise.all([reader.summary(), reader.trades()]);
  now += MUSEGOD_MARKET_TTL;
  wrongToken = true;
  const [oldSummary, oldTrades, chart] = await Promise.all([
    reader.summary(), reader.trades(), reader.candles("1h"),
  ]);
  assert.equal(oldSummary.status, "stale");
  assert.equal(oldSummary.fetchedAt, firstSummary.fetchedAt);
  assert.equal(oldTrades.status, "stale");
  assert.equal(oldTrades.fetchedAt, firstTrades.fetchedAt);
  assert.equal(swaps, 1, "Invalid discovery must block newly fetched swaps");
  assert.equal(chart.status, "fresh", "The exact candle pool is validated independently");
});

test("fork/Base/wrong-chain readers refuse before accessing storage or any mainnet provider", () => {
  for (const runtime of [
    { ...config, mode: "fork", chainId: 31337 },
    { ...config, mode: "base", chainId: 8453 },
    { ...config, chainId: 8453 },
  ] as RuntimeConfig[]) {
    const reader = new MusegodMarketReader(runtime, {
      snapshot: () => { throw new Error("Wrong network must not read cached mainnet data"); },
    } as unknown as StoreBackend, { fetch: async () => { throw new Error("Wrong network must not fetch"); }, now: () => NOW });
    assert.throws(() => reader.summary(), MarketUnavailable);
    assert.throws(() => reader.candles("1h"), MarketUnavailable);
    assert.throws(() => reader.trades(), MarketUnavailable);
  }
});

test("Snapshots retains its original 15-minute default when the caller omits TTL", async () => {
  const { store } = memoryStore();
  let now = NOW, calls = 0;
  const cache = new Snapshots(store, () => now);
  const read = async () => { calls++; return { fetchedAt: "", price: 1 }; };
  const first = await cache.get("legacy", "CoinGecko", read);
  assert.equal((first as typeof first & SnapshotExtra).nextRefreshAt, new Date(NOW + SNAPSHOT_TTL).toISOString());
  now += MUSEGOD_MARKET_TTL;
  await cache.get("legacy", "CoinGecko", read);
  assert.equal(calls, 1);
  now = NOW + SNAPSHOT_TTL;
  await cache.get("legacy", "CoinGecko", read);
  assert.equal(calls, 2);
});
type SnapshotExtra = { nextRefreshAt: string };
