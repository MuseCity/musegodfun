import test from "node:test";
import assert from "node:assert/strict";
import { parseBefore, mergeCandles, createHistoryPager } from "../src/lib/candle-history";
const now = Date.parse("2026-10-16T03:00:00Z"), before = now / 1000 - 3600;
const candle = (time: number, close = 1) => ({ time, open: 1, high: Math.max(1, close), low: 1, close, volume: 2 });
test("before accepts aligned unix seconds only within the past 365 days", () => {
  assert.equal(parseBefore(undefined, "1h", now), undefined); assert.equal(parseBefore(String(before), "1h", now), before);
  for (const value of ["", null, [], [String(before)], "1e9", `${before}.0`, ` ${before}`, before + 1, now / 1000 + 3600, before - 365 * 86400])
    assert.throws(() => parseBefore(value, "1h", now));
  for (const interval of ["1m", "5m", "15m", "1h", "4h", "1d"] as const) {
    const aligned = Math.floor(before / 86400) * 86400;
    assert.equal(parseBefore(aligned, interval, now), aligned);
  }
});
test("merge is ordered, unique, gap preserving and favors the latest snapshot on overlap", () => {
  const first = [candle(120, 2), candle(240)], older = [candle(60), candle(120)];
  assert.deepEqual(mergeCandles(older, first), [candle(60), candle(120, 2), candle(240)]);
  assert.equal(first.length, 2); assert.equal(older.length, 2);
});
test("pager allows one request, discards reset responses, and stops on empty or non-progress pages", async () => {
  let resolve!: (value: any) => void, calls = 0;
  const pager = createHistoryPager(async () => { calls++; return new Promise<any>(done => { resolve = done; }); });
  const pending = pager.load(before);
  assert.equal(await pager.load(before), null); assert.equal(calls, 1);
  pager.dispose(); resolve({ candles: [candle(before - 3600)] }); assert.equal(await pending, null);
  const empty = createHistoryPager(async () => ({ candles: [], fetchedAt: "now", source: "Bankr" }));
  assert((await empty.load(before))?.candles.length === 0); assert.equal(empty.exhausted(), true);
  assert.equal(await empty.load(before), null);
  const overlapping = createHistoryPager(async () => ({ candles: [candle(before)], fetchedAt: "now", source: "Bankr" }));
  assert.equal((await overlapping.load(before))?.candles.length, 0); assert.equal(overlapping.exhausted(), true);
});
