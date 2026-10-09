import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, RefreshCw } from "lucide-react";
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
import { changeClass } from "../lib/format";
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
  metric,
}: {
  token: MarketToken;
  refreshKey: string;
  kind?: "launch" | "musegod";
  // Replaces the fully diluted valuation tile (MUSEGOD shows its burn share).
  metric?: { label: string; value: string; title?: string };
}) {
  const [chartType, setChartType] = useState<"line" | "candles">(kind === "musegod" ? "line" : "candles");
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
  const chartSnapshot = history.data ?? stats;
  const chartSource = history.data?.source ?? (kind === "musegod" || token.mode === "robinhood" ? "Bankr" : "CoinGecko");
  const chartSourceUrl = chartSource === "Bankr"
    ? kind === "musegod" ? MUSEGOD.sourceUrl : "https://bankr.bot"
    : chartSource === "GeckoTerminal" ? "https://www.geckoterminal.com" : "https://www.coingecko.com/en/api";
  const items =
    trades.data?.trades.filter((t) => filter === "all" || t.side === filter) ??
    [];
  const buys = activity?.buys ?? null, sells = activity?.sells ?? null;
  const flowTotal = (buys ?? 0) + (sells ?? 0);
  const changeKind = changeClass(change);
  return (
    <>
      <section className="card market-panel" aria-label={`${token.symbol} market`}>
        <div className="market-price-row">
          <div>
            <span className="eyebrow">{token.symbol} PRICE</span>
            <div className="market-price">
              <span className="mono">{usd(stats?.priceUsd, true)}</span>
              <span className={`change-chip ${changeKind}`}>
                {changeKind === "positive" ? <ArrowUpRight size={14} /> : changeKind === "negative" ? <ArrowDownRight size={14} /> : null}
                {change == null
                  ? "—"
                  : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`} · 24h
              </span>
            </div>
          </div>
          <button
            type="button"
            className="round-button"
            aria-label="Refresh market data"
            title="Refresh market data"
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={18} />
          </button>
        </div>
        <dl className="stat-grid market-metrics">
          <div>
            <dt>Market cap</dt>
            <dd>{usd(stats?.marketCapUsd)}</dd>
          </div>
          {metric ? <div>
            <dt>{metric.label}</dt>
            <dd title={metric.title}>{metric.value}</dd>
          </div> : <div>
            <dt>Fully diluted valuation</dt>
            <dd>{usd(stats?.fdvUsd)}</dd>
          </div>}
          <div>
            <dt>Liquidity</dt>
            <dd>{usd(stats?.liquidityUsd)}</dd>
          </div>
          <div>
            <dt>24h volume</dt>
            <dd>{usd(stats?.periods.h24.volume)}</dd>
          </div>
        </dl>
        {(summary.error || stats?.status === "stale") && (
          <p className="market-warning" role="status">
            {summary.error || stats?.warning}
          </p>
        )}
        <div className="chart-toolbar">
          <div className="segmented" role="group" aria-label="Chart type">
            <button type="button" aria-pressed={chartType === "line"} onClick={() => setChartType("line")}>Line</button>
            <button type="button" aria-pressed={chartType === "candles"} onClick={() => setChartType("candles")}>Candles</button>
          </div>
          <div className="segmented mono" role="group" aria-label="Chart interval">
            {CHART_INTERVALS.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={interval === value}
                onClick={() => setIntervalValue(value)}
              >
                {value}
              </button>
            ))}
          </div>
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
              type={chartType}
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
          <span>
            <a
              href={chartSourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {kind === "musegod" && chartSource === "Bankr" ? "Bankr / Pools" : chartSource} ↗
            </a>{" "}
            {chartSnapshot
              ? `· ${kind === "musegod" ? "refreshes every minute while visible" : "shared 15-minute snapshot"} · ${new Date(chartSnapshot.fetchedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
              : "· update time appears after market data loads"}
          </span>
        </div>
      </section>
      <section className="card market-feed" aria-label={kind === "launch" ? "Trades and holders" : "Recent trades"}>
        <div className="feed-head">
          {kind === "launch" ? <div className="feed-tabs" role="group" aria-label="Market feed">
            <button
              type="button"
              aria-pressed={tab === "trades"}
              onClick={() => setTab("trades")}
            >
              Recent trades
            </button>
            <button
              type="button"
              aria-pressed={tab === "holders"}
              onClick={() => setTab("holders")}
            >
              Holders
            </button>
          </div> : <h2 className="card-title">Recent trades</h2>}
          {tab === "trades" || kind === "musegod" ? <div className="segmented compact" role="group" aria-label="Trade filter">
            {[
              ["all", "All"],
              ["buy", "Buy"],
              ["sell", "Sell"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div> : <span className="hint">Top 10 of <span className="mono">{holders.data?.indexedCount ?? "—"}</span> indexed holders</span>}
        </div>
        {tab === "trades" || kind === "musegod" ? (
          <>
            <div className="trade-flow">
              <div className="segmented mono compact" role="group" aria-label="Activity period">
                {[
                  ["m5", "5m"],
                  ["h1", "1h"],
                  ["h6", "6h"],
                  ["h24", "24h"],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={period === value}
                    onClick={() => setPeriod(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="mono positive">{buys ?? "—"} buys</span>
              <div className="flow-bar" aria-hidden="true">
                {flowTotal > 0 ? <>
                  <i className="buy" style={{ flex: buys ?? 0 }} />
                  <i className="sell" style={{ flex: sells ?? 0 }} />
                </> : <i className="none" />}
              </div>
              <span className="mono negative">{sells ?? "—"} sells</span>
            </div>
            <p className="flow-stats hint">
              Volume <span className="mono">{usd(activity?.volume)}</span> · Price change{" "}
              <span className={`mono ${(activity?.change ?? 0) < 0 ? "negative" : (activity?.change ?? 0) > 0 ? "positive" : ""}`}>
                {activity?.change == null
                  ? "—"
                  : `${activity.change > 0 ? "+" : ""}${activity.change.toFixed(2)}%`}
              </span>
            </p>
            {items.length ? (
              <div className="table-scroll">
                <table className="data-table market-table">
                  <thead>
                    <tr>
                      <th>Type / time</th>
                      <th className="num">Amount (USD)</th>
                      <th className="num">{token.symbol}</th>
                      <th className="num">Price (USD)</th>
                      <th className="num">Trader</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.slice(0, 30).map((t) => (
                      <tr key={t.id}>
                        <td className="trade-type">
                          <a
                            className={`side-tag ${t.side === "buy" ? "positive" : "negative"}`}
                            href={explorer ? `${explorer}/tx/${t.hash}` : undefined}
                            target="_blank"
                            rel="noreferrer"
                            title="View transaction"
                          >
                            {t.side === "buy" ? "Buy" : "Sell"}
                          </a>{" "}
                          <small className="mono" title={t.at}>
                            {new Date(t.at).toLocaleString("en-US", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </small>
                        </td>
                        <td className="num">{usd(t.usd)}</td>
                        <td className="num" title={String(t.amount)}>{count(t.amount)}</td>
                        <td className="num">{usd(t.price, true)}</td>
                        <td className="num">
                          {t.account ? <a
                            href={explorer ? `${explorer}/address/${t.account}` : undefined}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortAddress(t.account)}
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
              Latest 30 trades · indexing may lag the chain.
            </p>
          </>
        ) : (
          <>
            {holders.data?.holders.length ? (
              <div className="table-scroll">
                <table className="data-table market-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th className="num">{token.symbol} held</th>
                      <th className="num">Share of total supply</th>
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
                            <span className="holder-rank">{index + 1}</span>
                            <a
                              className="mono"
                              href={explorer ? `${explorer}/token/${token.address}?a=${h.address}` : undefined}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shortAddress(h.address)}
                            </a>
                            {h.isContract && <span className="chip sm sunken">Contract</span>}
                          </td>
                          <td className="num" title={formatUnits(BigInt(h.amount), 18)}>
                            {count(Number(formatUnits(BigInt(h.amount), 18)))}
                          </td>
                          <td className="num">
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
                ? `Fetched at ${new Date(holders.data.fetchedAt).toLocaleTimeString("en-US")}. `
                : ""}
              Indexing may be incomplete; pool contracts, burn addresses, or other holders may be missing. This list does not represent all holders.
            </p>
          </>
        )}
      </section>
    </>
  );
}
