import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/market";

export default function PriceChart({
  candles,
  symbol,
}: {
  candles: Candle[];
  symbol: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fitted = useRef(false);
  const [hover, setHover] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const c = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#7b8175",
        fontFamily: "DM Sans, sans-serif",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#f3f4ef" },
        horzLines: { color: "#f0f2eb" },
      },
      rightPriceScale: {
        borderColor: "#e4e7dc",
        scaleMargins: { top: 0.12, bottom: 0.25 },
      },
      timeScale: {
        borderColor: "#e4e7dc",
        timeVisible: true,
        secondsVisible: false,
      },
      localization: {
        locale: "en-US",
        priceFormatter: (v: number) =>
          v.toLocaleString("en-US", { maximumSignificantDigits: 6 }),
      },
      handleScroll: { vertTouchDrag: false },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: "#5b9135",
      downColor: "#d36954",
      wickUpColor: "#5b9135",
      wickDownColor: "#d36954",
      borderVisible: false,
      priceFormat: { type: "price", precision: 10, minMove: 0.0000000001 },
    });
    const v = c.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    v.priceScale().applyOptions({ scaleMargins: { top: 0.83, bottom: 0 } });
    chart.current = c;
    series.current = s;
    volume.current = v;
    c.subscribeCrosshairMove((event) => {
      const data = event.seriesData.get(s);
      setHover(data && "open" in data ? data : null);
    });
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      volume.current = null;
      fitted.current = false;
    };
  }, []);
  useEffect(() => {
    series.current?.setData(
      candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })),
    );
    volume.current?.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? "#90b97066" : "#d98d7c66",
      })),
    );
    if (!fitted.current && candles.length) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [candles]);
  const bar = hover ?? candles.at(-1);
  return (
    <>
      <div className="chart-ohlc" aria-live="off">
        <span>{symbol} / USD</span>
        {bar && (
          <>
            {[
              ["O", bar.open],
              ["H", bar.high],
              ["L", bar.low],
              ["C", bar.close],
            ].map(([key, value]) => (
              <span key={key}>
                {key} <b>{Number(value).toPrecision(5)}</b>
              </span>
            ))}
          </>
        )}
      </div>
      <div
        className="price-chart"
        ref={container}
        role="img"
        aria-label={`${symbol} USD candlestick chart and volume with ${candles.length} candles. Drag, zoom, and hover to inspect prices.`}
      />
      <div className="chart-credit">
        <span>UTC · USD price / volume</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™ · © 2025 TradingView, Inc.
        </a>
      </div>
    </>
  );
}
