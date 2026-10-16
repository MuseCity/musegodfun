import test from "node:test";
import assert from "node:assert/strict";
import { parseBefore, beyondHistoryWindow, historyCursor, INTERVAL_SECONDS, HISTORY_PAGE_SIZE, mergeCandles, createHistoryPager } from "../src/lib/candle-history";
const now = Date.parse("2026-10-16T03:00:00Z"), before = Math.floor((now / 1000 - 3600) / (199 * 3600)) * 199 * 3600;
const candle = (time: number, close = 1) => ({ time, open: 1, high: Math.max(1, close), low: 1, close, volume: 2 });
test("before accepts page-grid-aligned unix seconds only within the past 365 days", () => {
  assert.equal(parseBefore(undefined, "1h", now), undefined); assert.equal(parseBefore(String(before), "1h", now), before);
  for (const value of ["", null, [], [String(before)], "1e9", `${before}.0`, ` ${before}`, before + 1, now / 1000 + 3600, before - 365 * 86400])
    assert.throws(() => parseBefore(value, "1h", now));
  for (const interval of ["1m", "5m", "15m", "1h", "4h", "1d"] as const) {
    const grid = INTERVAL_SECONDS[interval] * HISTORY_PAGE_SIZE, aligned = Math.floor((now / 1000 - 86400) / grid) * grid;
    assert.equal(parseBefore(aligned, interval, now), aligned);
  }
});
test("the 365-day window boundary is shared by validation and the chart's window-limit message", () => {
  const edge = Math.ceil(now / 1000 - 365 * 86400);
  assert.equal(beyondHistoryWindow(edge, now), false); assert.equal(beyondHistoryWindow(edge - 1, now), true);
  assert.equal(beyondHistoryWindow(before, now), false);
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

test("history rejects interval-aligned cursors outside the fixed inclusive-provider page grid", () => {
  const grid = 199 * 3600, cursor = Math.floor(before / grid) * grid;
  assert.equal(parseBefore(cursor, "1h", now), cursor);
  for (const offset of [3600, 7200, 198 * 3600]) assert.throws(() => parseBefore(cursor + offset, "1h", now));
});

test("inclusive 200-row pages advance on the fixed 199-slot grid with no skipped candles", () => {
  const grid = 199 * 60, cursor = Math.floor((now / 1000 - grid) / grid) * grid;
  const inclusive = Array.from({ length: 200 }, (_, n) => candle(cursor - n * 60));
  const first = inclusive.filter(row => row.time < cursor);
  const nextCursor = historyCursor(Math.min(...first.map(row => row.time)), "1m");
  assert.equal(nextCursor, cursor - grid);
  assert.equal(historyCursor(cursor - 60, "1m"), cursor);
  const next = Array.from({ length: 200 }, (_, n) => candle(nextCursor - n * 60)).filter(row => row.time < nextCursor);
  const merged = mergeCandles(next, first);
  assert.equal(merged.length, 398);
  assert(merged.slice(1).every((row, index) => row.time - merged[index].time === 60));
});
