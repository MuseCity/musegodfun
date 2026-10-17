import { forwardRef } from "react";
import type { Candle } from "../lib/market";

export type ChartStatus = { text: "Loading market data…" | "No price history yet" | "Chart data temporarily unavailable"; reason: string };

export default forwardRef<HTMLDivElement, {
  symbol: string; unit?: string; type?: "candles" | "line"; count?: number;
  bar?: Pick<Candle, "open" | "high" | "low" | "close">; status?: ChartStatus; onInteract?: () => void;
}>(function PriceChartFrame({ symbol, unit, type = "candles", count = 0, bar, status, onInteract }, ref) {
  return <><div className="price-chart-wrap">
    <div className="chart-ohlc" aria-live="off">
      <span>{symbol}{unit && ` / ${unit}`}</span>
      {bar && [["O", bar.open], ["H", bar.high], ["L", bar.low], ["C", bar.close]].map(([key, value]) => (
        <span key={key}>{key} <b>{Number(value).toPrecision(5)}</b></span>
      ))}
    </div>
    <div className="chart-frame">
      <div className={`price-chart${count ? "" : " is-empty"}`} ref={ref} onPointerDown={onInteract} onWheel={onInteract} role="img"
        aria-label={`${symbol}${unit ? ` ${unit}` : ""} ${type === "line" ? "line" : "candlestick"} chart and volume with ${count} ${type === "line" ? "points" : "candles"}. ${count ? "Drag, zoom, and hover to inspect prices." : status?.text ?? "No prices shown."}`}
        aria-description={!count ? status?.reason : undefined} />
      {!count && <div className="chart-watermark" aria-hidden="true">{symbol}{unit && ` / ${unit}`}</div>}
    </div>
    <div className="chart-credit">
      <span>UTC · {unit && `${unit} `}price / volume</span>
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™ · © 2025 TradingView, Inc.</a>
    </div>
  </div>
    {!count && status && <p className="chart-status" role="status" title={status.reason}>{status.text}</p>}
  </>;
});
