import { memo, useId } from "react";
import type { Address } from "viem";
import { CURVE_POLICY, sampleInitialLaunchCurve } from "../lib/launch-curve";
import type { OpeningValuation } from "../lib/opening-valuation";

function LaunchCurve({ ticker, curvePolicy, openingValuation, quoteDecimals, tokenAddress, quoteAddress }: {
  ticker: string;
  curvePolicy?: string;
  openingValuation?: OpeningValuation;
  quoteDecimals: number;
  tokenAddress?: Address;
  quoteAddress: Address;
}) {
  const fillId = useId().replaceAll(":", "");
  if (curvePolicy !== CURVE_POLICY)
    return <p className="muted">Curve configuration unavailable for this launch. Its original liquidity settings remain unchanged.</p>;
  let model;
  try {
    model = sampleInitialLaunchCurve({
      quotePriceUsd: openingValuation ? Number(openingValuation.quotePriceUsd) : 1,
      quoteDecimals: openingValuation ? quoteDecimals : 18,
      tokenIsCurrency0: tokenAddress ? tokenAddress.toLowerCase() < quoteAddress.toLowerCase() : true,
    });
  } catch {
    return <p className="muted">The launch curve model is unavailable. Refresh the preview to retry.</p>;
  }
  const lower = model.points[0].logFdv;
  const upper = model.points.at(-1)!.logFdv;
  const path = model.points.map((point, index) => `${index ? "L" : "M"}${(40 + point.soldPercent / 97 * 290).toFixed(2)} ${(128 - (point.logFdv - lower) / (upper - lower) * 108).toFixed(2)}`).join(" ");
  const compact = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
  return <figure className="curve launch-curve-model">
    <div className="curve-label"><span>Initial supply curve</span><span>Priced in {ticker}</span></div>
    <svg viewBox="0 0 360 170" role="img" aria-label="Initial launch curve: sold supply from 0 to 97 percent against market cap on a logarithmic scale; excludes fees and added liquidity">
      <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#bcf26b" stopOpacity=".5" /><stop offset="100%" stopColor="#bcf26b" stopOpacity="0" />
      </linearGradient></defs>
      {[20, 47, 74, 101, 128].map((y) => <path key={y} d={`M40 ${y}H330`} stroke="#e4e7df" strokeDasharray="3 5" />)}
      <path d={`${path} L330 128 L40 128 Z`} fill={`url(#${fillId})`} />
      <path d={path} fill="none" stroke="#6c981c" strokeWidth="2.5" />
      <text x="36" y="19" textAnchor="end">{compact(model.mainEndFdvUsd)}</text>
      <text x="36" y="132" textAnchor="end">{compact(model.openingFdvUsd)}</text>
      {[0, 25, 50, 75, 97].map((sold) => <text key={sold} x={40 + sold / 97 * 290} y="146" textAnchor="middle">{sold}%</text>)}
      <text x="185" y="165" textAnchor="middle">Supply sold →</text>
    </svg>
    <figcaption>Initial curve model · Logarithmic market cap · No fees or added liquidity</figcaption>
    <p className="curve-tail-note">97% across 18 price doublings. The remaining 3% extends above the chart to a finite price limit.</p>
  </figure>;
}

export default memo(LaunchCurve);
