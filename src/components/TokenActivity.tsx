import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { explorerFor, shortAddress, type TokenRecord } from "../lib/config";
import { emptyText, formatCount, formatUsd, MarketProvenance, type LaunchMarket } from "./TokenMarket";

const PERIODS = [["m5", "5m"], ["h1", "1h"], ["h6", "6h"], ["h24", "24h"]] as const;
const FILTERS = [["all", "All"], ["buy", "Buy"], ["sell", "Sell"]] as const;

/** The Activity tab: buy and sell flow by period, then the latest indexed trades from any venue, updated live by the swap stream. */
export default function TokenActivity({ token, market }: { token: TokenRecord; market: LaunchMarket }) {
  const [period, setPeriod] = useState<(typeof PERIODS)[number][0]>("h24");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const { stats, tradeData, trades, currentLive } = market;
  const explorer = explorerFor(token);
  const activity = stats?.periods[period];
  const hasActivity = !!stats && Object.values(stats.periods).some((value) => [value.buys, value.sells, value.volume, value.change].some((n) => n != null));
  const buys = activity?.buys ?? null, sells = activity?.sells ?? null, flowTotal = (buys ?? 0) + (sells ?? 0);
  const items = tradeData?.trades.filter((t) => filter === "all" || t.side === filter) ?? [];
  return (
    <div className="tab-stack">
      {hasActivity && <section className="card" aria-labelledby="flow-title">
        <div className="card-head">
          <h2 id="flow-title" className="card-title">Buys and sells</h2>
          <div className="segmented mono compact" role="group" aria-label="Activity period">
            {PERIODS.map(([value, label]) => <button type="button" key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}
          </div>
        </div>
        <div className="trade-flow">
          <span className="mono positive">{buys ?? "—"} buys</span>
          <div className="flow-bar" aria-hidden="true">
            {flowTotal > 0 ? <><i className="buy" style={{ flex: buys ?? 0 }} /><i className="sell" style={{ flex: sells ?? 0 }} /></> : <i className="none" />}
          </div>
          <span className="mono negative">{sells ?? "—"} sells</span>
        </div>
        <p className="flow-stats hint">
          Volume <span className="mono">{formatUsd(activity?.volume)}</span> · Price change{" "}
          <span className={`mono ${(activity?.change ?? 0) < 0 ? "negative" : (activity?.change ?? 0) > 0 ? "positive" : ""}`}>
            {activity?.change == null ? "—" : `${activity.change > 0 ? "+" : ""}${activity.change.toFixed(2)}%`}
          </span>
        </p>
      </section>}
      <section className="card market-feed" aria-labelledby="trades-title">
        <div className="feed-head">
          <h2 id="trades-title" className="card-title">Recent trades</h2>
          <div className="button-row">
            {!!tradeData?.trades.length && <div className="segmented compact" role="group" aria-label="Trade filter">
              {FILTERS.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
            </div>}
            <button type="button" className="round-button small" aria-label="Refresh trades" title="Refresh trades" onClick={market.refresh}><RefreshCw size={16} /></button>
          </div>
        </div>
        {items.length ? (
          <div className="table-scroll">
            <table className="data-table market-table">
              <thead><tr><th>Type / time</th><th className="num">Value</th><th className="num">{token.symbol}</th><th className="num">Price</th><th className="num">Transaction sender</th></tr></thead>
              <tbody>
                {items.slice(0, 30).map((t) => (
                  <tr key={t.id} title={t.source ? `${t.source} · ${t.at}` : undefined}>
                    <td className="trade-type">
                      <a className={`side-tag ${t.side === "buy" ? "positive" : "negative"}`} href={explorer ? `${explorer}/tx/${t.hash}` : undefined}
                        target="_blank" rel="noreferrer" title="View transaction">{t.side === "buy" ? "Buy" : "Sell"}</a>{" "}
                      <small className="mono" title={t.at}>{new Date(t.at).toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small>
                    </td>
                    <td className="num">{t.usd != null ? formatUsd(t.usd) : t.quoteAmount ? `${Number(t.quoteAmount).toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${t.quoteSymbol}` : "—"}</td>
                    <td className="num" title={String(t.amount)}>{formatCount(t.amount)}</td>
                    <td className="num">{t.price != null ? formatUsd(t.price, true) : t.priceQuote ? `${Number(t.priceQuote).toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${t.quoteSymbol}` : "—"}</td>
                    <td className="num">{t.account ? <a href={explorer ? `${explorer}/address/${t.account}` : undefined} target="_blank" rel="noreferrer">{shortAddress(t.account)}</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="market-empty" role="status">
            {trades.loading && !trades.data ? "Loading trades…" : emptyText(trades.data, trades.error,
              trades.data?.trades.length ? "No indexed trades match this filter."
                : trades.data?.reason === "not_indexed" ? "Market records are not indexed for this pool yet." : "No indexed trades in this snapshot.",
              "Previous trades snapshot. Refresh to update.")}
          </div>
        )}
        {items.length && (trades.error || trades.data?.status === "stale") ? <p className="market-warning" role="status">{trades.error || trades.data?.warning || "Previous trades snapshot. Refresh to update."}</p> : null}
        <p className="feed-note">
          <MarketProvenance label="Trades" data={tradeData} kind="launch" />{tradeData ? " · " : ""}
          {currentLive?.tradesAt && <>Live trades · On-chain · Alchemy · Trade <time dateTime={currentLive.tradesAt}>{new Date(currentLive.tradesAt).toLocaleTimeString("en-US")}</time> · </>}
          Latest 30 indexed trades from any venue · indexing may lag the chain.
        </p>
      </section>
    </div>
  );
}
