import test from "node:test";
import assert from "node:assert/strict";
import { MUSEGOD } from "../src/lib/musegod";
import { parseLiveEvent, projectLiveMarket, retainLiveSwaps, verifiedSupply } from "../src/lib/musegod-live";
import type { CandleData, MarketSummary, TradeData } from "../src/lib/market";

const now = Date.parse("2026-10-16T04:12:30Z"), time = Math.floor(now / 1000 / 3600) * 3600;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const raw = (n = 2, extra = {}) => ({ tokenAddress: MUSEGOD.token, chain: "robinhood", txHash: hash(n), blockNumber: 100,
  logIndex: n, timestamp: new Date(now - 1000).toISOString(), traderAddress: MUSEGOD.weth, side: "buy", tokenAmount: 2, totalUsd: 6, mcapUsd: 600, ...extra });
const swap = (n = 2, extra = {}) => { const e = parseLiveEvent("TOKEN_SWAP", raw(n, extra), now); assert(e?.type === "swap"); return e; };
const info = { address: MUSEGOD.token, poolAddress: MUSEGOD.pool, quoteAddress: MUSEGOD.weth, decimals: 18 as const, totalSupply: "200000000000000000000" };
const candles: CandleData = { source: "Bankr", status: "fresh", fetchedAt: new Date(now - 2000).toISOString(),
  watermark: { blockNumber: 100, logIndex: 1, txHash: hash(1) }, candles: [{ time, open: 2, high: 2, low: 2, close: 2, volume: 10 }] };
const summary: MarketSummary = { source: "Bankr", status: "fresh", fetchedAt: candles.fetchedAt, lastTradeAt: candles.fetchedAt,
  priceUsd: 2, marketCapUsd: 400, fdvUsd: null, liquidityUsd: null, periods: {} };
const trades: TradeData = { source: "Bankr", status: "fresh", fetchedAt: candles.fetchedAt, trades: [] };
const project = (events = [swap()], changes = {}) => projectLiveMarket({ candles, summary, trades, interval: "1h", info, ...changes }, events);

test("live schema binds token and chain, rejects malformed numbers, dates and identities", () => {
  assert.equal(swap().priceUsd, null);
  for (const extra of [{ chain: "base" }, { tokenAddress: MUSEGOD.weth }, { txHash: "0x1" }, { logIndex: -1 }, { blockNumber: 1.1 },
    { timestamp: new Date(now + 60_001).toISOString() }, { timestamp: "bad" }, { tokenAmount: 0 }, { totalUsd: Infinity }, { mcapUsd: -1 }, { priceUsd: "3" }, { side: "BUY" }])
    assert.equal(parseLiveEvent("TOKEN_SWAP", raw(2, extra), now), null);
  assert.equal(parseLiveEvent("UNKNOWN", raw(), now), null);
  assert.equal(parseLiveEvent("TOKEN_SWAP", null, now), null);
});
test("observed discovery volume and bundle price contracts are validated independently", () => {
  const volume = { tokenAddress: MUSEGOD.token, chain: "robinhood", vol1m: 0, priceChange1m: 0, vol5m: 0, priceChange5m: 0,
    vol1h: 0, priceChange1h: 0, vol6h: 3629.82, priceChange6h: 15.35, vol24h: 6519.79, priceChange24h: 20.05, txCount24h: 55 };
  assert.equal(parseLiveEvent("DISCOVER_VOLUME_UPDATE", volume, now)?.type, "volume");
  assert.equal(parseLiveEvent("DISCOVER_VOLUME_UPDATE", { ...volume, vol24h: -1 }, now), null);
  assert.equal(parseLiveEvent("DISCOVER_PRICE_UPDATE", { tokenAddress: MUSEGOD.token, chain: "robinhood", lastPriceUsd: 4,
    marketCapUsd: 800, lastTradeAt: new Date(now).toISOString() }, now)?.type, "price");
});
test("verified supply uses page info and has no default", () => {
  assert.equal(verifiedSupply(info), 200);
  for (const value of [null, { ...info, totalSupply: null }, { ...info, totalSupply: "0" }, { ...info, address: MUSEGOD.weth },
    { ...info, poolAddress: MUSEGOD.weth }, { ...info, decimals: 6 }, { ...info, totalSupply: "1e9" }, { ...info, totalSupply: 200 },
    { ...info, totalSupply: (2n ** 256n).toString() }]) assert.equal(verifiedSupply(value as any), null);
  assert.equal(project().summary?.priceUsd, 3);
  assert.equal(project(undefined, { info: null }).summary?.priceUsd, 2);
  assert.equal(project([swap(2, { priceUsd: 7 })], { info: null }).summary?.priceUsd, 7);
});
test("reducer updates bucket OHLCV once, preserves gaps and REST input", () => {
  const before = structuredClone(candles), result = project([swap(), swap(), swap(3, { priceUsd: 1 })]);
  assert.deepEqual(result.candles?.candles, [{ time, open: 2, high: 3, low: 1, close: 1, volume: 22 }]);
  assert.deepEqual(candles, before);
  assert.equal(result.trades?.trades.length, 2);
  assert.equal(result.trades?.trades[0].id, `robinhood:${hash(3)}:3`);
  const later = swap(4, { timestamp: new Date(now).toISOString(), priceUsd: 4 });
  const minute = project([later], { interval: "1m" });
  assert.equal(minute.candles?.candles.at(-1)?.time, Math.floor(now / 60000) * 60);
  assert.equal(minute.candles?.candles.at(-1)?.volume, 6);
});
test("out of order swaps use chain order for close and selected interval reprojects", () => {
  const events = [swap(4, { priceUsd: 4 }), swap(2, { priceUsd: 5 }), swap(3, { priceUsd: 1 })];
  assert.equal(project(events).candles?.candles[0].close, 4);
  assert.equal(project(events).summary?.priceUsd, 4);
  assert.equal(project(events, { interval: "4h", candles: { ...candles, candles: [] } }).candles?.candles[0].time, Math.floor(now / 1000 / 14400) * 14400);
});
test("REST watermark replaces included events without counting their volume again", () => {
  const next = { ...candles, watermark: { blockNumber: 100, logIndex: 2, txHash: hash(2) }, candles: [{ ...candles.candles[0], close: 3, high: 3, volume: 16 }] };
  assert.equal(project([swap()], { candles: next }).candles?.candles[0].volume, 16);
  assert.equal(project([swap(1)]).candles?.candles[0].volume, 10);
  assert.equal(project([swap(1)]).summary?.priceUsd, 2);
  assert.equal(project([swap(1)]).trades?.trades.length, 0);
  for (const watermark of [undefined, null]) assert.strictEqual(project(undefined, { candles: { ...candles, watermark } }).candles?.candles, candles.candles);
  assert.strictEqual(project(undefined, { candles: { ...candles, status: "stale" } }).candles?.candles, candles.candles);
  const row = project().trades!.trades[0];
  assert.equal(project(undefined, { trades: { ...trades, trades: [row] } }).trades?.trades.length, 1);
  assert.equal(project([swap(2, { priceUsd: 9 })], { summary: { ...summary, lastTradeAt: new Date(now).toISOString() } }).summary?.priceUsd, 2);
});
test("pending swaps and recent trades stay bounded and acknowledged events can be released", () => {
  let pending: ReturnType<typeof swap>[] = [];
  for (let n = 2; n < 505; n++) pending = retainLiveSwaps(pending, swap(n), { candles, summary, trades }, now);
  assert.equal(pending.length, 500);
  assert.equal(project(pending).trades?.trades.length, 30);
  assert.equal(retainLiveSwaps([swap()], swap(), { candles, summary, trades }, now).length, 1);
  const acknowledged = { ...candles, watermark: { blockNumber: 100, logIndex: 2, txHash: hash(2) } };
  const restTrade = project().trades!;
  assert.equal(retainLiveSwaps([swap()], swap(3), { candles: acknowledged, trades: restTrade, summary: { ...summary, lastTradeAt: new Date(now).toISOString() } }, now).length, 1);
});

test("swaps without market cap derive it from verified supply or retain the dated REST value", () => {
  assert.equal(project([swap(2, { priceUsd: 7, mcapUsd: undefined })]).summary?.marketCapUsd, 1400);
  const result = project([swap(2, { priceUsd: 7, mcapUsd: undefined })], { info: null });
  assert.equal(result.summary?.priceUsd, 7); assert.equal(result.summary?.marketCapUsd, 400);
  assert.equal(result.summary?.fetchedAt, summary.fetchedAt);
});
