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
import type { Candle, ChartInterval } from "../lib/market";
import PriceChartFrame, { type ChartStatus } from "./PriceChartFrame";

// Price charts keep their own dark palette in both site themes.
function palette(element: HTMLElement) {
  const css = getComputedStyle(element);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--chart-background", "#0b0e11"),
    text: token("--chart-text", "#a9b4c2"),
    line: token("--chart-grid", "#202833"),
    up: token("--chart-up", "#26a69a"),
    down: token("--chart-down", "#ef5350"),
    crosshair: token("--chart-crosshair", "#7b8ba2"),
    label: token("--chart-label", "#263445"),
    font: token("--font-mono", "IBM Plex Mono, monospace"),
  };
}
const alpha = (color: string, hex: string) => /^#[0-9a-f]{6}$/i.test(color) ? `${color}${hex}` : color;

export default function PriceChart({
  candles,
  symbol,
  unit,
  type = "candles",
  interval = "1h",
  status,
  onLoadOlder,
}: {
  candles: Candle[];
  symbol: string;
  unit?: string;
  type?: "candles" | "line";
  interval?: ChartInterval;
  status?: ChartStatus;
  onLoadOlder?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fitted = useRef(false);
  const interacted = useRef(false), loadOlder = useRef(onLoadOlder);
  loadOlder.current = onLoadOlder;
  const previousCandles = useRef<Candle[]>([]);
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
    const colors = palette(container.current);
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
        vertLines: { visible: false, color: colors.line },
        horzLines: { color: colors.line },
      },
      crosshair: {
        vertLine: { color: colors.crosshair, labelBackgroundColor: colors.label },
        horzLine: { color: colors.crosshair, labelBackgroundColor: colors.label },
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
      ? c.addSeries(LineSeries, { color: colors.up, lineWidth: 2, priceLineColor: colors.up, priceFormat })
      : c.addSeries(CandlestickSeries, {
        upColor: colors.up,
        downColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
        priceLineColor: colors.crosshair,
        borderVisible: false,
        priceFormat,
      });
    const v = c.addSeries(HistogramSeries, {
      color: alpha(colors.up, "59"),
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
    c.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (candlesRef.current.length && interacted.current && fitted.current && range && range.from < 20) loadOlder.current?.();
    });
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
  }, [type]);
  useEffect(() => {
    if (!container.current) return;
    const colors = palette(container.current);
    const range = chart.current?.timeScale().getVisibleLogicalRange();
    const first = previousCandles.current[0]?.time;
    const prepended = first === undefined ? 0 : candles.filter(candle => candle.time < first).length;
    previousCandles.current = candles;
    const points = candles.map((c) => ({ ...c, time: c.time as UTCTimestamp }));
    const step = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[interval];
    const end = Math.floor(Date.now() / 1000 / step) * step;
    const whitespace = () => Array.from({ length: 60 }, (_, index) => ({ time: (end - (59 - index) * step) as UTCTimestamp }));
    if (type === "line") (series.current as ISeriesApi<"Line"> | null)?.setData(points.length ? points.map((c) => ({ time: c.time, value: c.close })) : whitespace());
    else (series.current as ISeriesApi<"Candlestick"> | null)?.setData(points.length ? points : whitespace());
    volume.current?.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: alpha(c.close >= c.open ? colors.up : colors.down, "59"),
      })),
    );
    if (range && prepended) chart.current?.timeScale().setVisibleLogicalRange({ from: range.from + prepended, to: range.to + prepended });
    chart.current?.timeScale().applyOptions({ fixLeftEdge: !candles.length });
    if (!candles.length) {
      fitted.current = false;
      setHover(null);
      // fitContent anchors at the first timestamp when every point is whitespace.
      chart.current?.timeScale().setVisibleLogicalRange({ from: 0, to: 59 });
    } else if (!fitted.current) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [candles, type, interval]);
  const bar = candles.length ? hover ?? candles.at(-1) : undefined;
  return <PriceChartFrame ref={container} symbol={symbol} unit={unit} type={type} count={candles.length} bar={bar}
    status={status} onInteract={() => { interacted.current = true; }} />;
}
