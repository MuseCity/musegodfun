import { forwardRef } from "react";
import type { Candle } from "../lib/market";

export default forwardRef<HTMLDivElement, {
  symbol: string; unit?: string; type?: "candles" | "line"; count?: number;
  bar?: Pick<Candle, "open" | "high" | "low" | "close">; emptyMessage?: string; onInteract?: () => void;
}>(function PriceChartFrame({ symbol, unit, type = "candles", count = 0, bar, emptyMessage, onInteract }, ref) {
  return <div className="price-chart-wrap">
    <div className="chart-ohlc" aria-live="off">
      <span>{symbol}{unit && ` / ${unit}`}</span>
      {bar && [["O", bar.open], ["H", bar.high], ["L", bar.low], ["C", bar.close]].map(([key, value]) => (
        <span key={key}>{key} <b>{Number(value).toPrecision(5)}</b></span>
      ))}
    </div>
    <div className="chart-frame">
      <div className={`price-chart${count ? "" : " is-empty"}`} ref={ref} onPointerDown={onInteract} onWheel={onInteract} role="img"
        aria-label={`${symbol}${unit ? ` ${unit}` : ""} ${type === "line" ? "line" : "candlestick"} chart and volume with ${count} ${type === "line" ? "points" : "candles"}. ${count ? "Drag, zoom, and hover to inspect prices." : "No price records."}`} />
      {!count && emptyMessage && <div className="chart-empty-status" role="status"><span>{emptyMessage}</span></div>}
    </div>
    <div className="chart-credit">
      <span>UTC · {unit && `${unit} `}price / volume</span>
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™ · © 2025 TradingView, Inc.</a>
    </div>
  </div>;
});
