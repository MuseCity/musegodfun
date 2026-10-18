import { useEffect, useState, type CSSProperties } from "react";
import { ArrowDownRight, ArrowUpRight, Check, Copy, RefreshCw } from "lucide-react";
import { formatUnits } from "viem";
import type { Stock, TokenRecord } from "../lib/config";
import { changeClass, feePercent } from "../lib/format";
import { summaryHasValues } from "../lib/market";
import { dopplerUrl, fomoInviteUrl, LP_FEE_PERCENT, ownershipDisclaimer, poolFeeOn100 } from "../lib/token-detail";
import { errorMessage } from "../lib/validation";
import { formatUsd, MarketProvenance, type LaunchMarket } from "./TokenMarket";

/** A pool quote older than this is labelled expired; it is never refreshed automatically. */
export const POOL_QUOTE_TTL_MS = 60_000;
const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The page's only trading surface (tasks/token-ip-detail-plan.md §3–4): the market price block, then the venues. Nothing here signs. */
export default function TokenVenues({ token, stock, market, fomoHandle, stateUnavailable = false, quoteProbe }: {
  token: TokenRecord;
  stock: Stock;
  market: LaunchMarket;
  fomoHandle: string | null | undefined;
  /** The server could not read the pool state just now: no pool quote until it can (the page retries on its own). */
  stateUnavailable?: boolean;
  /** One on-chain quote buying with 1 unit of the pair asset; asked for only when the user presses the button. */
  quoteProbe: () => Promise<{ amountOut: string }>;
}) {
  const doppler = dopplerUrl(token), fomo = fomoInviteUrl(token, fomoHandle);
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  // The last pool quote and its read time stay after a failed refresh, labelled as not current (tasks/ip-page-improvements-2026-10-18-plan.md §3).
  // `failed` marks a quote whose later refresh failed; it stays until a refresh succeeds, even while another one is pending.
  const [probe, setProbe] = useState<{ busy: boolean; quote: { price: string; at: number; failed?: true } | null; error: string }>({ busy: false, quote: null, error: "" });
  // The read time of the quote whose expiry timer fired, so a newer quote never inherits the label.
  const [expiredAt, setExpiredAt] = useState(0);
  useEffect(() => {
    const at = probe.quote?.at;
    if (!at) return;
    const timer = setTimeout(() => setExpiredAt(at), Math.max(0, at + POOL_QUOTE_TTL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [probe.quote?.at]);
  const { stats, summary } = market;
  // Metrics show whenever the summary holds any value; the price line needs a price, otherwise the pool quote fallback is offered.
  const hasValues = summaryHasValues(stats), hasPrice = stats?.priceUsd != null || !!stats?.priceQuote;
  const change = stats?.periods.h24?.change, changeKind = changeClass(change);
  const priceText = stats?.priceUsd != null ? formatUsd(stats.priceUsd, true)
    : stats?.priceQuote ? Number(stats.priceQuote).toLocaleString("en-US", { maximumSignificantDigits: 6 }) : "—";
  const poolFee = poolFeeOn100(token), disclaimer = ownershipDisclaimer(token.symbol, stock);
  async function readProbe() {
    setProbe((current) => ({ ...current, busy: true, error: "" }));
    try {
      const tokens = Number(formatUnits(BigInt((await quoteProbe()).amountOut), 18));
      if (!(tokens > 0)) throw new Error("The pool returned no tokens for this amount.");
      setProbe({ busy: false, quote: { price: (1 / tokens).toLocaleString("en-US", { maximumSignificantDigits: 6 }), at: Date.now() }, error: "" });
    } catch (cause) {
      setProbe((current) => ({ busy: false, quote: current.quote && { ...current.quote, failed: true }, error: errorMessage(cause) }));
    }
  }
  const quote = probe.quote, expired = !!quote && expiredAt === quote.at, quoteCurrent = !!quote && !expired && !quote.failed;
  return (
    <section className="card venue-card" id="trade" tabIndex={-1} aria-labelledby="trade-title">
      <div className="card-head">
        <h2 id="trade-title" className="card-title">Trade ${token.symbol}</h2>
        <span className="pill">{stock.symbol} pair</span>
      </div>
      <div className="venue-price">
        <div className="venue-price-head">
          <span className="eyebrow">{token.symbol} price{stats?.status === "stale" && <small className="market-snapshot" title="Previous snapshot"> Prev.</small>}</span>
          {doppler && <a className="text-button" href={doppler} target="_blank" rel="noopener noreferrer">Chart on Doppler <ArrowUpRight size={14} /></a>}
        </div>
        {hasPrice ? <div className="market-price">
          <span className="mono" style={{ "--price-characters": priceText.length } as CSSProperties}>{priceText}</span>
          <span className="market-price-detail">
            {stats?.priceUsd == null && stats?.priceQuote && <small className="market-price-unit">{stats.quoteSymbol}</small>}
            <span className={`change-chip ${changeKind}`}>
              {changeKind === "positive" ? <ArrowUpRight size={14} /> : changeKind === "negative" ? <ArrowDownRight size={14} /> : null}
              {change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`} · 24h
            </span>
          </span>
        </div> : <div className="venue-probe">
          <p className="hint" role="status">{summary.loading ? "Loading price…" : summary.error || stats?.status === "stale" || stats?.status === "unavailable"
            ? "Market data temporarily unavailable" : "No market price yet"}</p>
          {stateUnavailable && <p className="hint" role="status">On-chain pool state is unavailable, so the pool quote is paused. Retrying automatically.</p>}
          {token.mode !== "fork" && !summary.loading && !stateUnavailable && <>
            {/* Mounted before the result arrives, so screen readers announce it. */}
            <div role="status">{quote && <p className={`venue-probe-result${quoteCurrent ? "" : " stale"}`}>Average price: <span className="mono">≈ {quote.price}</span> {stock.symbol} per {token.symbol}
              <small className="hint"> · average for a 1-unit buy with 1 {stock.symbol}, fees included</small>
              <small className="hint venue-probe-time">{quote.failed ? "Previous quote, read" : "Read"} at <time dateTime={new Date(quote.at).toISOString()}>{clock(quote.at)}</time>
                {quote.failed ? " · not current" : expired ? " · expired, refresh for a current quote" : ""}</small></p>}</div>
            <button type="button" className="secondary" disabled={probe.busy} onClick={() => void readProbe()}>
              <RefreshCw size={14} className={probe.busy ? "spin" : undefined} />{probe.busy ? "Reading the pool…" : quote ? "Refresh pool quote" : "Get pool quote"}</button>
            {probe.error && <p className="field-error" role="alert">{probe.error}</p>}
          </>}
        </div>}
        {hasValues && <dl className="stat-grid venue-metrics">
          <div><dt>Market cap</dt><dd>{formatUsd(stats?.marketCapUsd)}</dd></div>
          <div><dt>Liquidity</dt><dd>{formatUsd(stats?.liquidityUsd)}</dd></div>
          <div><dt>24h volume</dt><dd>{formatUsd(stats?.periods.h24?.volume)}</dd></div>
        </dl>}
        {(summary.error || stats?.status === "stale") && hasValues && <p className="market-warning" role="status">
          {summary.error || stats?.warning || "Previous snapshot. Refresh to update."}</p>}
      </div>
      {doppler ? <div className="venue">
        <div className="venue-head"><b>Doppler</b><span className="hint">Your own wallet · pool fee only · network gas extra</span></div>
        <a className="primary large full" href={doppler} target="_blank" rel="noopener noreferrer">Trade on Doppler <ArrowUpRight size={16} /></a>
      </div> : <p className="hint">Local fork coins trade on the fork only; mainnet venues do not list them.</p>}
      {fomo && <div className="venue">
        <div className="venue-head"><b>Fomo</b><span className="hint">Fomo adds its own app fee</span></div>
        <a className="secondary large full" href={fomo} target="_blank" rel="noopener noreferrer">Open Fomo with invite <ArrowUpRight size={16} /></a>
        <span className="hint">Fomo has no direct coin link. Search this contract in Fomo:</span>
        <button type="button" className="copy-chip venue-contract" aria-label={copied === "done" ? "Contract address copied" : "Copy contract address"}
          onClick={() => void navigator.clipboard.writeText(token.address).then(() => setCopied("done")).catch(() => setCopied("failed"))}>
          {copied === "done" ? <Check size={14} /> : <Copy size={14} />}<span className="mono">{token.address}</span>
        </button>
        {copied === "failed" && <p className="field-error" role="alert">Copy failed. Select the address and copy it manually.</p>}
      </div>}
      {poolFee !== null && <dl className="rows boxed" aria-label="What a $100 buy pays">
        <div><dt>Pool fee on any venue, per $100</dt><dd>${poolFee.toFixed(2)}</dd></div>
        <div><dt>Trading fee + LP fee</dt><dd>{feePercent(token.tradingFeeBps!)} + {LP_FEE_PERCENT}</dd></div>
      </dl>}
      <p className="hint">musegod.fun adds no fee of its own and signs nothing here. The pool fee pays this coin's beneficiaries whichever venue you use.</p>
      {disclaimer && <p className="hint">{disclaimer}</p>}
      <p className="feed-note"><MarketProvenance label="Summary" data={stats} kind="launch" />{market.liveNode && <> {market.liveNode}</>}</p>
    </section>
  );
}
