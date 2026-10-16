import { useEffect, useRef, useState } from "react";
import { chainApi } from "../lib/api";
import { createHistoryPager, INTERVAL_SECONDS, mergeCandles, parseBefore } from "../lib/candle-history";
import type { Candle, CandleData, ChartInterval } from "../lib/market";
import PriceChart from "./PriceChart";

export default function MarketChart({ data, endpoint, interval, symbol, type }: {
  data: CandleData; endpoint: { chainId: 8453 | 4663; path: string; key: string }; interval: ChartInterval;
  symbol: string; type: "candles" | "line";
}) {
  const [older, setOlder] = useState<Candle[]>([]), [fetchedAt, setFetchedAt] = useState<{ first: string; last: string } | null>(null);
  const [loading, setLoading] = useState(false), [exhausted, setExhausted] = useState(false), [error, setError] = useState("");
  const pager = useRef<ReturnType<typeof createHistoryPager> | null>(null), retryAt = useRef(0), pending = useRef(false);
  useEffect(() => {
    const current = createHistoryPager(before => chainApi<CandleData>(endpoint.chainId, `${endpoint.path}&before=${before}`, undefined, { retry: false }));
    pager.current = current;
    return () => { pager.current = null; current.dispose(); };
  }, [endpoint.key]);
  const previousFirst = useRef(data.candles);
  useEffect(() => {
    const displaced = data.candles.length ? previousFirst.current.filter(candle => candle.time < data.candles[0].time) : [];
    previousFirst.current = data.candles;
    if (older.length && displaced.length) setOlder(previous => mergeCandles(displaced, previous));
  }, [data]);
  const candles = mergeCandles(older, data.candles);
  function loadOlder() {
    const current = pager.current;
    if (!current || pending.current || exhausted || data.source !== "Bankr" || data.status === "stale" || !candles.length || Date.now() < retryAt.current) return;
    const before = Math.floor(candles[0].time / INTERVAL_SECONDS[interval]) * INTERVAL_SECONDS[interval];
    try { parseBefore(before, interval); }
    catch { setExhausted(true); return; }
    pending.current = true; setLoading(true); setError("");
    void current.load(before).then(page => {
      if (!page || pager.current !== current) return;
      setOlder(previous => mergeCandles(page.candles, previous)); setExhausted(current.exhausted());
      if (page.candles.length) setFetchedAt(previous => {
        const times = [...(previous ? [previous.first, previous.last] : []), page.fetchedAt].sort((a, b) => Date.parse(a) - Date.parse(b));
        return { first: times[0], last: times.at(-1)! };
      });
    }).catch(() => {
      if (pager.current !== current) return;
      retryAt.current = Date.now() + 30_000; setError("Historical price data is unavailable. Scroll again to retry.");
    }).finally(() => { if (pager.current === current) { pending.current = false; setLoading(false); } });
  }
  const separateTime = fetchedAt && [fetchedAt.first, fetchedAt.last].some(time => Math.abs(Date.parse(time) - Date.parse(data.fetchedAt)) >= 60_000);
  return <>
    <PriceChart candles={candles} symbol={symbol} type={type} onLoadOlder={loadOlder} />
    {(loading || exhausted || error || separateTime) && <p className="feed-note chart-history" role="status">
      {loading ? "Loading older history…" : exhausted ? "Beginning of indexed history" : error}
      {separateTime && <>{loading || exhausted || error ? " · " : ""}History pages · Bankr · Fetched <time dateTime={fetchedAt!.first}>{new Date(fetchedAt!.first).toLocaleTimeString("en-US")}</time>
        {fetchedAt!.last !== fetchedAt!.first && <>–<time dateTime={fetchedAt!.last}>{new Date(fetchedAt!.last).toLocaleTimeString("en-US")}</time></>}</>}
    </p>}
  </>;
}
