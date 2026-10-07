import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { RefreshCw, TrendingUp, Users } from "lucide-react";
import { formatUnits } from "viem";
import { chainApi } from "../lib/api";
import { deploymentChain, explorerFor, shortAddress, type TokenRecord } from "../lib/config";
import { MUSEGOD } from "../lib/musegod";
import {
  CHART_INTERVALS,
  type CandleData,
  type ChartInterval,
  type HolderData,
  type MarketSummary,
  type TradeData,
} from "../lib/market";
import { errorMessage } from "../lib/validation";
const PriceChart = lazy(() => import("./PriceChart"));
const usd = (n: number | null | undefined, precise = false) =>
  n == null
    ? "—"
    : `$${n.toLocaleString("en-US", precise ? { maximumSignificantDigits: 6 } : { notation: "compact", maximumFractionDigits: 2 })}`;
const count = (n: number) =>
  n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
export type MarketToken = Pick<TokenRecord, "address" | "symbol" | "mode" | "deploymentChainId">;
export function marketEndpoint(token: MarketToken, kind: "launch" | "musegod", section: string) {
  const chainId = kind === "musegod" ? 4663 : deploymentChain(token);
  const path = kind === "musegod" ? `/musegod/market/${section}` : `/tokens/${token.address}/market/${section}`;
  return { chainId, path, key: `${chainId}:${token.mode}:${path}` };
}
function useMarket<
  T extends { fetchedAt: string; status?: string; warning?: string },
>(token: MarketToken, kind: "launch" | "musegod", section: string, revision: number, enabled = true) {
  const [result, setResult] = useState<{
    data: T | null;
    error: string;
    loading: boolean;
  }>({ data: null, error: "", loading: true });
  const previousPath = useRef("");
  const { chainId, path, key } = marketEndpoint(token, kind, section);
  useEffect(() => {
    let active = true;
    const samePath = previousPath.current === key;
    previousPath.current = key;
    setResult((previous) => ({
      data: samePath ? previous.data : null,
      error: "",
      loading: enabled,
    }));
    if (!enabled) return;
    if (token.mode === "fork") {
      setResult({
        data: null,
        error: "The local fork does not show mainnet market data. Use the on-chain quote panel on the right.",
        loading: false,
      });
      return;
    }
    chainApi<T>(chainId, path)
      .then((data) => {
        if (active) setResult({ data, error: "", loading: false });
      })
      .catch((e) => {
        if (active)
          setResult((previous) => ({
            data:
              previous.data &&
              Date.now() - Date.parse(previous.data.fetchedAt) < 86400000
                ? {
                    ...previous.data,
                    status: "stale",
                    warning: "Network unavailable. Showing the previous snapshot.",
                  }
                : null,
            error: errorMessage(e),
            loading: false,
          }));
      });
    return () => {
      active = false;
    };
  }, [key, chainId, path, revision, enabled]);
  useEffect(() => {
    if (!result.data) return;
    const remaining = Date.parse(result.data.fetchedAt) + 86400000 - Date.now();
    const expire = () => setResult({data:null,error:"The market snapshot is more than 24 hours old. Refresh to update.",loading:false});
    if (remaining <= 0) { expire(); return; }
    const timer=setTimeout(expire,remaining);
    return () => clearTimeout(timer);
  },[result.data?.fetchedAt]);
  return previousPath.current === key ? result : { data: null, error: "", loading: enabled };
}
function Message({
  loading,
  error,
  empty,
}: {
  loading: boolean;
  error: string;
  empty: string;
}) {
  return (
    <div className="market-empty" role="status">
      {loading ? "Loading market data…" : error || empty}
    </div>
  );
}
export default function TokenMarket({
  token,
  refreshKey,
  kind = "launch",
}: {
  token: MarketToken;
  refreshKey: string;
  kind?: "launch" | "musegod";
}) {
  const [interval, setIntervalValue] = useState<ChartInterval>("1h"),
    [revision, setRevision] = useState(0);
  const [period, setPeriod] = useState("h24"),
    [tab, setTab] = useState<"trades" | "holders">("trades"),
    [filter, setFilter] = useState("all");
  useEffect(() => {
    setRevision((n) => n + 1);
  }, [refreshKey]);
  useEffect(() => {
    let lastRefresh = Date.now();
    const refreshVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh > 1000) {
        lastRefresh = Date.now();
        setRevision((n) => n + 1);
      }
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRevision((n) => n + 1);
    }, kind === "musegod" ? 60_000 : 15 * 60_000);
    if (kind === "musegod") {
      document.addEventListener("visibilitychange", refreshVisible);
      window.addEventListener("focus", refreshVisible);
    }
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [kind]);
  const summary = useMarket<MarketSummary>(token, kind, "summary", revision);
  const history = useMarket<CandleData>(
    token,
    kind,
    `candles?interval=${interval}`,
    revision,
  );
  const trades = useMarket<TradeData>(
    token,
    kind,
    "trades",
    revision,
    tab === "trades" || kind === "musegod",
  );
  const holders = useMarket<HolderData>(
    token,
    kind,
    "holders",
    revision,
    kind === "launch" && tab === "holders",
  );
  const explorer = explorerFor(token);
  const stats = summary.data,
    activity = stats?.periods[period],
    change = stats?.periods.h24.change;
  const items =
    trades.data?.trades.filter((t) => filter === "all" || t.side === filter) ??
    [];
  return (
    <>
      <section className="panel market-panel">
        <div className="market-price-row">
          <div>
            <span className="eyebrow">{token.symbol} PRICE</span>
            <div className="market-price">
              {usd(stats?.priceUsd, true)}
              <span className={(change ?? 0) < 0 ? "negative" : "positive"}>
                {change == null
                  ? "—"
                  : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}{" "}
                <small>24h</small>
              </span>
            </div>
          </div>
          <button
            className="icon-button"
            aria-label="Refresh market data"
            title="Refresh market data"
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="market-metrics">
          <div>
            <span>Market cap</span>
            <b>{usd(stats?.marketCapUsd)}</b>
          </div>
          <div>
            <span>Fully diluted valuation</span>
            <b>{usd(stats?.fdvUsd)}</b>
          </div>
          <div>
            <span>Liquidity</span>
            <b>{usd(stats?.liquidityUsd)}</b>
          </div>
          <div>
            <span>24h volume</span>
            <b>{usd(stats?.periods.h24.volume)}</b>
          </div>
        </div>
        {(summary.error || stats?.status === "stale") && (
          <p className="market-warning" role="status">
            {summary.error || stats?.warning}
          </p>
        )}
        <div className="chart-toolbar">
          <div className="intervals" aria-label="Chart interval">
            {CHART_INTERVALS.map((value) => (
              <button
                key={value}
                aria-pressed={interval === value}
                className={interval === value ? "active" : ""}
                onClick={() => setIntervalValue(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <span>Price · USD</span>
        </div>
        {history.data?.status === "stale" && (
          <p className="market-warning">
            Previous chart snapshot · {history.data.fetchedAt}
          </p>
        )}
        {history.data?.candles.length ? (
          <Suspense fallback={<Message loading error="" empty="" />}>
            <PriceChart
              key={`${token.address}:${interval}`}
              candles={history.data.candles}
              symbol={token.symbol}
            />
          </Suspense>
        ) : (
          <Message
            loading={history.loading}
            error={history.error}
            empty="No indexed trades for this interval. Try a longer interval."
          />
        )}
        <div className="market-attribution">
          <a
            href={kind === "musegod" ? MUSEGOD.sourceUrl : "https://www.coingecko.com/en/api"}
            target="_blank"
            rel="noreferrer"
          >
            {kind === "musegod" ? "Bankr / Pools" : "CoinGecko"} ↗
          </a>
          <span>
            {stats
              ? `Fetched at ${new Date(stats.fetchedAt).toLocaleTimeString("en-US")} · ${kind === "musegod" ? "Refreshes every minute while visible" : "Shared 15-minute snapshot"}`
              : "Update time appears after market data loads"}
          </span>
        </div>
      </section>
      <section className="panel market-activity">
        <div className="section-heading">
          <h2>
            <TrendingUp size={17} /> Trading activity
          </h2>
          <div className="intervals">
            {[
              ["m5", "5m"],
              ["h1", "1h"],
              ["h6", "6h"],
              ["h24", "24h"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={period === value ? "active" : ""}
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="activity-values">
          <div>
            <span>Buys</span>
            <b className="positive">{activity?.buys ?? "—"}</b>
          </div>
          <div>
            <span>Sells</span>
            <b className="negative">{activity?.sells ?? "—"}</b>
          </div>
          <div>
            <span>Volume</span>
            <b>{usd(activity?.volume)}</b>
          </div>
          <div>
            <span>Price change</span>
            <b
              className={(activity?.change ?? 0) < 0 ? "negative" : "positive"}
            >
              {activity?.change == null
                ? "—"
                : `${activity.change > 0 ? "+" : ""}${activity.change.toFixed(2)}%`}
            </b>
          </div>
        </div>
      </section>
      <section className="panel market-feed">
        <div className="feed-tabs">
          <button
            className={tab === "trades" ? "active" : ""}
            aria-pressed={tab === "trades"}
            onClick={() => setTab("trades")}
          >
            <TrendingUp size={16} /> Recent trades
          </button>
          {kind === "launch" && <button
            className={tab === "holders" ? "active" : ""}
            aria-pressed={tab === "holders"}
            onClick={() => setTab("holders")}
          >
            <Users size={16} /> Holders
          </button>}
        </div>
        {tab === "trades" || kind === "musegod" ? (
          <>
            <div className="feed-filter">
              <div className="intervals">
                {[
                  ["all", "All"],
                  ["buy", "Buy"],
                  ["sell", "Sell"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={filter === value ? "active" : ""}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span>Recently indexed trades</span>
            </div>
            {items.length ? (
              <div className="market-table-scroll">
                <table className="market-table">
                  <thead>
                    <tr>
                      <th>Type / time</th>
                      <th>Amount (USD)</th>
                      <th>{token.symbol}</th>
                      <th>Price (USD)</th>
                      <th>Trader</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.slice(0, 30).map((t) => (
                      <tr key={t.id}>
                        <td>
                          <a
                            className={
                              t.side === "buy" ? "positive" : "negative"
                            }
                            href={explorer ? `${explorer}/tx/${t.hash}` : undefined}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t.side === "buy" ? "Buy" : "Sell"} ↗
                          </a>
                          <small title={t.at}>
                            {new Date(t.at).toLocaleString("en-US", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </small>
                        </td>
                        <td>{usd(t.usd)}</td>
                        <td title={String(t.amount)}>{count(t.amount)}</td>
                        <td>{usd(t.price, true)}</td>
                        <td>
                          {t.account ? <a
                            href={explorer ? `${explorer}/address/${t.account}` : undefined}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortAddress(t.account)} ↗
                          </a> : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Message
                loading={trades.loading}
                error={trades.error}
                empty="No indexed trades match this filter."
              />
            )}
            <p className="feed-note">
              {trades.data?.status === "stale" ? "Previous snapshot · " : ""}{kind === "musegod" ? "Bankr / Pools" : "CoinGecko"} ·
              Shows up to the latest 30 trades. Indexing may be delayed.
            </p>
          </>
        ) : (
          <>
            {holders.data?.holders.length ? (
              <>
                <div className="feed-filter">
                  <b>Indexed addresses {holders.data.indexedCount ?? "—"}</b>
                  <span>Top 10 indexed holders</span>
                </div>
                <div className="market-table-scroll">
                  <table className="market-table">
                    <thead>
                      <tr>
                        <th>Address</th>
                        <th>{token.symbol} held</th>
                        <th>Share of total supply</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holders.data.holders.map((h, index) => {
                        const percent =
                          BigInt(holders.data!.totalSupply) > 0n
                            ? Number(
                                (BigInt(h.amount) * 1_000_000n) /
                                  BigInt(holders.data!.totalSupply),
                              ) / 10000
                            : null;
                        return (
                          <tr key={h.address}>
                            <td>
                              <a
                                href={explorer ? `${explorer}/token/${token.address}?a=${h.address}` : undefined}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <span className="holder-rank">{index + 1}</span>
                                {shortAddress(h.address)} ↗
                              </a>
                              {h.isContract && <small>Contract</small>}
                            </td>
                            <td title={formatUnits(BigInt(h.amount), 18)}>
                              {count(Number(formatUnits(BigInt(h.amount), 18)))}
                            </td>
                            <td>
                              {percent == null
                                ? "—"
                                : `${percent < 0.0001 ? "<0.0001" : percent.toFixed(4)}%`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <Message
                loading={holders.loading}
                error={holders.error}
                empty="No indexed holders yet."
              />
            )}
            <p className="feed-note">
              {holders.data?.status === "stale" ? "Previous snapshot · " : ""}Blockscout ·{" "}
              {holders.data
                ? `Fetched at ${new Date(holders.data.fetchedAt).toLocaleTimeString("en-US")}.`
                : ""}
              Indexing may be incomplete; pool contracts, burn addresses, or other holders may be missing. This list does not represent all holders.
            </p>
          </>
        )}
      </section>
    </>
  );
}
