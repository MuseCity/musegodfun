import { z } from "zod";
import type { Candle, CandleData, ChartInterval } from "./market";

export const INTERVAL_SECONDS: Record<ChartInterval, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
// Bankr includes the boundary bar in its 200-row limit; 199 slots guarantee forward paging progress.
export const HISTORY_PAGE_SIZE = 199;
export function historyCursor(oldest: number, interval: ChartInterval) {
  const grid = INTERVAL_SECONDS[interval] * HISTORY_PAGE_SIZE;
  return Math.ceil(oldest / grid) * grid;
}
export const HISTORY_TTL = 3_600_000;
export function parseBefore(value: unknown, interval: ChartInterval, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  return z.union([z.number().int().safe(), z.string().regex(/^\d{1,10}$/).transform(Number)])
    .refine(time => Number.isSafeInteger(time) && time % (INTERVAL_SECONDS[interval] * HISTORY_PAGE_SIZE) === 0 &&
      time <= Math.floor(now / 1000) && time >= Math.ceil(now / 1000 - 365 * 86400),
    "before must be page-grid-aligned unix seconds within the past 365 days.").parse(value);
}
/** Latest provider bars win overlaps. No gap filling or interval changes. */
export function mergeCandles(older: Candle[], latest: Candle[]) {
  return [...new Map([...older, ...latest].map(candle => [candle.time, candle])).values()].sort((a, b) => a.time - b.time);
}
export function createHistoryPager(request: (before: number, signal: AbortSignal) => Promise<CandleData>) {
  let inflight = false, done = false, disposed = false;
  const controller = new AbortController();
  return {
    exhausted: () => done,
    dispose() { disposed = true; controller.abort(); },
    async load(before: number): Promise<CandleData | null> {
      if (inflight || done || disposed) return null;
      inflight = true;
      try {
        const data = await request(before, controller.signal);
        if (disposed) return null;
        if (data.source && data.source !== "Bankr" || data.status === "stale") throw new Error("Historical price data could not be refreshed.");
        const candles = data.candles.filter(candle => candle.time < before);
        done = candles.length === 0;
        return { ...data, candles };
      } finally { inflight = false; }
    },
  };
}
