import test from "node:test";
import assert from "node:assert/strict";
import { MUSEGOD } from "../src/lib/musegod";
import { newerPrice, parseLiveEvent, projectLiveMarket, retainLiveSwaps, verifiedSupply } from "../src/lib/musegod-live";
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
  // The candles contain swap 1, but summary and trades are separate REST sections that still predate it.
  assert.equal(project([swap(1)]).summary?.priceUsd, 3);
  assert.equal(project([swap(1)]).trades?.trades.length, 1);
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

const stamp = new Date(now - 500).toISOString(), tied = (n: number, priceUsd: number, extra = {}) => swap(n, { timestamp: stamp, priceUsd, ...extra });
const ahead = (logIndex: number, close: number, volume: number): CandleData => ({ ...candles, watermark: { blockNumber: 100, logIndex, txHash: hash(logIndex) },
  candles: [{ ...candles.candles[0], close, high: Math.max(2, close), volume }] });
const discovery = (lastTradeAt: string, lastPriceUsd: number) => ({ type: "price" as const, tokenAddress: MUSEGOD.token, chain: "robinhood" as const,
  lastPriceUsd, marketCapUsd: lastPriceUsd * 200, lastTradeAt });

test("the candle watermark releases only candle volume: summary and trades reconcile on their own evidence", () => {
  const rest = ahead(2, 3, 16), caught = { ...summary, priceUsd: 3, lastTradeAt: new Date(now).toISOString() };
  const early = project([swap()], { candles: rest });
  assert.equal(early.candles?.candles[0].volume, 16); assert.equal(early.candles?.candles[0].close, 3);
  assert.equal(early.summary?.priceUsd, 3); assert.equal(early.trades?.trades.length, 1);
  assert.equal(retainLiveSwaps([swap()], null, { candles: rest, summary, trades }, now).length, 1);
  const bySummary = project([swap()], { candles: rest, summary: caught });
  assert.strictEqual(bySummary.summary, caught); assert.equal(bySummary.priceAt, null); assert.equal(bySummary.trades?.trades.length, 1);
  assert.equal(retainLiveSwaps([swap()], null, { candles: rest, summary: caught, trades }, now).length, 1);
  const listed = { ...trades, trades: [early.trades!.trades[0]] };
  const byTrades = project([swap()], { candles: rest, trades: listed });
  assert.equal(byTrades.summary?.priceUsd, 3); assert.equal(byTrades.trades?.trades.length, 1);
  assert.equal(retainLiveSwaps([swap()], null, { candles: rest, summary, trades: listed }, now).length, 1);
  const done = project([swap()], { candles: rest, summary: caught, trades: listed });
  assert.strictEqual(done.trades, listed); assert.equal(done.priceAt, null); assert.equal(done.tradesAt, null);
  assert.equal(retainLiveSwaps([swap()], null, { candles: rest, summary: caught, trades: listed }, now).length, 0);
});
test("sections that are not loaded keep swaps pending, and a full trade list that moved past a swap releases it", () => {
  assert.equal(retainLiveSwaps([], swap(), { candles: null, summary: null, trades: null }, now).length, 1);
  const old = swap(2, { timestamp: new Date(now - 60_000).toISOString() }), rest = { candles: ahead(2, 3, 16), summary: { ...summary, lastTradeAt: new Date(now).toISOString() } };
  const rows = (count: number) => ({ ...trades, trades: Array.from({ length: count }, (_, n) => ({ id: `robinhood:${hash(100 + n)}:${n}`, hash: hash(100 + n),
    account: null, at: new Date(now - 30_000 + n * 1000).toISOString(), side: "buy" as const, amount: 1, usd: 1, price: 1 })) });
  assert.equal(retainLiveSwaps([old], null, { ...rest, trades: rows(30) }, now).length, 0);
  assert.equal(retainLiveSwaps([old], null, { ...rest, trades: rows(29) }, now).length, 1);
});

test("equal-second swaps order by chain position in any arrival order and across replays", () => {
  const a = tied(2, 3), b = tied(3, 4), c = tied(4, 5, { blockNumber: 101, logIndex: 1 }), tiedSummary = { ...summary, lastTradeAt: stamp };
  for (const [events, price, unique] of [[[a], 3, 1], [[a, b], 4, 2], [[b, a], 4, 2], [[a, b, a, b], 4, 2], [[b, a, b], 4, 2]] as const) {
    const result = project([...events], { summary: tiedSummary });
    assert.equal(result.summary?.priceUsd, price); assert.equal(result.priceAt, stamp);
    assert.equal(result.candles?.candles[0].close, price); assert.equal(result.candles?.candles[0].volume, 10 + 6 * unique);
    assert.equal(result.trades?.trades.length, unique); assert.equal(result.trades?.trades[0].id, price === 3 ? a.id : b.id);
  }
  assert.equal(project([b, c, a], { summary: tiedSummary }).summary?.priceUsd, 5);
});
test("at equal seconds REST wins a swap only once another section contains it; a discovery price never outranks a swap or REST", () => {
  const a = tied(2, 3), tiedSummary = { ...summary, priceUsd: 9, lastTradeAt: stamp };
  assert.equal(project([a], { summary: tiedSummary }).summary?.priceUsd, 3);
  const inCandles = project([a], { summary: tiedSummary, candles: ahead(2, 3, 16) });
  assert.equal(inCandles.summary?.priceUsd, 9); assert.equal(inCandles.priceAt, null);
  const listed = project([a], { summary: tiedSummary, trades: { ...trades, trades: [project([a]).trades!.trades[0]] } });
  assert.equal(listed.summary?.priceUsd, 9); assert.equal(listed.priceAt, null);
  assert.equal(project([a], { summary: { ...tiedSummary, lastTradeAt: new Date(now).toISOString() } }).summary?.priceUsd, 9);
  const rest = { candles, summary: tiedSummary, trades, interval: "1h" as const, info };
  assert.equal(projectLiveMarket(rest, [a], discovery(stamp, 7)).summary?.priceUsd, 3);
  assert.equal(projectLiveMarket(rest, [], discovery(stamp, 7)).summary?.priceUsd, 9);
  assert.equal(projectLiveMarket(rest, [a], discovery(new Date(now).toISOString(), 7)).summary?.priceUsd, 7);
});
test("equal-second discovery prices follow stream order, while replays and older prices change nothing", () => {
  assert(newerPrice(null, discovery(stamp, 3)));
  assert(newerPrice(discovery(stamp, 3), discovery(stamp, 4)));
  assert(!newerPrice(discovery(stamp, 3), discovery(stamp, 3)));
  assert(!newerPrice(discovery(stamp, 3), discovery(new Date(now - 2000).toISOString(), 4)));
  assert(newerPrice(discovery(stamp, 3), discovery(new Date(now).toISOString(), 3)));
});
