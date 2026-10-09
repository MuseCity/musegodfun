import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/market";
import { useTheme } from "../lib/theme";

// Chart colors follow the page tokens so both themes stay legible.
function palette() {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--surface-raised", "#ffffff"),
    text: token("--ink-faint", "#706757"),
    line: token("--line", "#e6ddca"),
    up: token("--up", "#00777a"),
    down: token("--down", "#b73510"),
    font: token("--font-mono", "IBM Plex Mono, monospace"),
  };
}
const alpha = (color: string, hex: string) => /^#[0-9a-f]{6}$/i.test(color) ? `${color}${hex}` : color;

export default function PriceChart({
  candles,
  symbol,
  type = "candles",
}: {
  candles: Candle[];
  symbol: string;
  type?: "candles" | "line";
}) {
  const { theme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fitted = useRef(false);
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const [hover, setHover] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const colors = palette();
    const c = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: colors.font,
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: colors.line },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.25 },
      },
      timeScale: {
        borderVisible: false,
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
    const priceFormat = { type: "price" as const, precision: 10, minMove: 0.0000000001 };
    const s = type === "line"
      ? c.addSeries(LineSeries, { color: colors.up, lineWidth: 2, priceFormat })
      : c.addSeries(CandlestickSeries, {
        upColor: colors.up,
        downColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
        borderVisible: false,
        priceFormat,
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
    fitted.current = false;
    c.subscribeCrosshairMove((event) => {
      const time = event.time;
      const candle = time === undefined ? undefined : candlesRef.current.find((entry) => entry.time === time);
      setHover(candle ?? null);
    });
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      volume.current = null;
      fitted.current = false;
    };
  }, [type, theme]);
  useEffect(() => {
    const colors = palette();
    const points = candles.map((c) => ({ ...c, time: c.time as UTCTimestamp }));
    if (type === "line") (series.current as ISeriesApi<"Line"> | null)?.setData(points.map((c) => ({ time: c.time, value: c.close })));
    else (series.current as ISeriesApi<"Candlestick"> | null)?.setData(points);
    volume.current?.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: alpha(c.close >= c.open ? colors.up : colors.down, "59"),
      })),
    );
    if (!fitted.current && candles.length) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [candles, type, theme]);
  const bar = hover ?? candles.at(-1);
  return (
    <div className="price-chart-wrap">
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
        aria-label={`${symbol} USD ${type === "line" ? "line" : "candlestick"} chart and volume with ${candles.length} ${type === "line" ? "points" : "candles"}. Drag, zoom, and hover to inspect prices.`}
      />
      <div className="chart-credit">
        <span>UTC · USD price / volume</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™ · © 2025 TradingView, Inc.
        </a>
      </div>
    </div>
  );
}
