import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { ApiError, chainApi } from "../lib/api";
import { deploymentChain, explorerFor, shortAddress, type TokenRecord } from "../lib/config";
import { MUSEGOD } from "../lib/musegod";
import {
  CHART_INTERVALS,
  marketSnapshotKey,
  marketStatusMessage,
  type SnapshotMeta,
  type CandleData,
  type ChartInterval,
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
export type MarketToken = Pick<TokenRecord, "address" | "symbol" | "mode" | "deploymentChainId"> & Partial<Pick<TokenRecord, "poolId" | "quoteAddress">>;
export function marketEndpoint(token: MarketToken, kind: "launch" | "musegod", section: string) {
  const chainId = kind === "musegod" ? 4663 : deploymentChain(token);
  const path = kind === "musegod" ? `/musegod/market/${section}` : `/tokens/${token.address}/market/${section}`;
  const identity = kind === "musegod"
    ? { ...token, address: MUSEGOD.token, poolId: MUSEGOD.pool, quoteAddress: MUSEGOD.weth, deploymentChainId: 4663 as const }
    : { ...token, poolId: token.poolId ?? "unknown", quoteAddress: token.quoteAddress ?? "unknown" };
  return { chainId, path, key: `${kind}:${marketSnapshotKey(identity, section)}` };
}
export function MarketProvenance({ label, data, error, kind }: { label: string; data: (SnapshotMeta & { fetchedAt: string }) | null; error?: string; kind?: "launch" | "musegod" }) {
  if (!data) return error ? <span>{label} · Request failed: {error}</span> : null;
  return <span>{label} · {data.status === "stale" ? "Previous snapshot · " : ""}{data.source === "Bankr" ? kind === "musegod"
    ? <a href={MUSEGOD.sourceUrl} target="_blank" rel="noopener noreferrer">Bankr / Pools ↗</a> : "Bankr / Pools"
    : data.source === "CoinGecko" ? <a href="https://www.coingecko.com/en/api" target="_blank" rel="noopener noreferrer">Data provided by CoinGecko</a>
      : data.source ?? "Source unspecified"} · Fetched <time dateTime={data.fetchedAt} title={data.fetchedAt}>{new Date(data.fetchedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</time></span>;
}
export function emptyCandlesMessage(data: CandleData | null, interval: ChartInterval) {
  if (data?.reason) {
    const reasons = {
      missing_config: "configuration unavailable", quota_exhausted: "quota exhausted", not_indexed: "pool not indexed", rate_limited: "rate limited",
      upstream_http: "request failed", upstream_transport: "connection failed", upstream_unclassified: "request failed for an unclassified reason",
      invalid_identity: "pool identity not verified", invalid_schema: "response not usable", source_not_provided: "data not provided",
      storage_unavailable: "snapshot storage unavailable", internal_error: "internal error", backoff: "temporarily in backoff",
    };
    const causes = data.causes?.length ? data.causes : [{ source: undefined, reason: data.reason }];
    return `${data.source === "Bankr" ? "Bankr / Pools" : data.source ?? "The source"} returned no indexed price records for this interval. Source checks: ${causes.map(c => `${c.source ?? "upstream"}: ${reasons[c.reason]}`).join("; ")}. Use the on-chain quote for a price preview.`;
  }
  return `No indexed price records for this interval.${interval !== CHART_INTERVALS[CHART_INTERVALS.length - 1] ? " Try a longer interval." : " Use the on-chain quote for a price preview."}`;
}
function useMarket<
  T extends { fetchedAt: string; status?: string; warning?: string },
>(token: MarketToken, kind: "launch" | "musegod", section: string, revision: number) {
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
      loading: true,
    }));
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
              Number.isFinite(Date.parse(previous.data.fetchedAt)) &&
              Date.now() - Date.parse(previous.data.fetchedAt) < 86400000
                ? {
                    ...previous.data,
                    status: "stale",
                    warning: "Network unavailable. Showing the previous snapshot.",
                  }
                : null,
            error: e instanceof ApiError && e.reason ? marketStatusMessage(e.reason) : errorMessage(e),
            loading: false,
          }));
      });
    return () => {
      active = false;
    };
  }, [key, chainId, path, revision]);
  useEffect(() => {
    if (!result.data) return;
    const remaining = Date.parse(result.data.fetchedAt) + 86400000 - Date.now();
    const expire = () => setResult({data:null,error:"The market snapshot is more than 24 hours old. Refresh to update.",loading:false});
    if (remaining <= 0) { expire(); return; }
    const timer=setTimeout(expire,remaining);
    return () => clearTimeout(timer);
  },[result.data?.fetchedAt]);
  return previousPath.current === key ? result : { data: null, error: "", loading: true };
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
    [filter, setFilter] = useState("all");
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
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
  );
  const explorer = explorerFor(token);
  const stats = summary.data,
    activity = stats?.periods[period],
    change = stats?.periods.h24?.change;
  const hasValues = !!stats && [stats.priceUsd, stats.marketCapUsd, stats.fdvUsd, stats.liquidityUsd, stats.periods.h24?.volume].some(value => value != null);
  const hasActivity = !!stats && Object.values(stats.periods).some(value => [value.buys, value.sells, value.volume, value.change].some(n => n != null));
  const emptySummary = stats?.status === "stale"
    ? `Previous snapshot has no displayable market values. ${summary.error || stats.warning || "Refresh to update."}`
    : summary.error || (summary.loading ? "Loading market data…" : "The source has no price for this pool yet. Use the on-chain quote for a price preview.");

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
            {hasValues ? <div className="market-price">
              <span className="mono">{usd(stats?.priceUsd, true)}</span>
              <span className={`change-chip ${changeKind}`}>
                {changeKind === "positive" ? <ArrowUpRight size={14} /> : changeKind === "negative" ? <ArrowDownRight size={14} /> : null}
                {change == null
                  ? "—"
                  : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`} · 24h
              </span>
            </div> : <p className="hint" role="status">{emptySummary}</p>}
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
        {(hasValues || metric) && <dl className="stat-grid market-metrics">
          {hasValues && <div>
            <dt>Market cap</dt>
            <dd>{usd(stats?.marketCapUsd)}</dd>
          </div>}
          {metric ? <div>
            <dt>{metric.label}</dt>
            <dd title={metric.title}>{metric.value}</dd>
          </div> : hasValues && <div>
            <dt>Fully diluted valuation</dt>
            <dd>{usd(stats?.fdvUsd)}</dd>
          </div>}
          {hasValues && <><div>
            <dt>Liquidity</dt>
            <dd>{usd(stats?.liquidityUsd)}</dd>
          </div>
          <div>
            <dt>24h volume</dt>
            <dd>{usd(stats?.periods.h24?.volume)}</dd>
          </div></>}
        </dl>}
        {hasValues && (summary.error || stats?.status === "stale") && (
          <p className="market-warning" role="status">
            {summary.error || stats?.warning || "Previous snapshot. Refresh to update."}
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
            {history.error || history.data.warning || "Previous chart snapshot. Refresh to update."}
          </p>
        )}
        {history.data?.candles.length ? (
          <Suspense fallback={<Message loading error="" empty="" />}>
            <PriceChart
              key={marketEndpoint(token, kind, `candles?interval=${interval}`).key}
              candles={history.data.candles}
              symbol={token.symbol}
              type={chartType}
            />
          </Suspense>
        ) : (
          <Message
            loading={history.loading}
            error={history.error}
            empty={emptyCandlesMessage(history.data, interval)}
          />
        )}
        {(summary.data || summary.error || history.data || history.error || kind === "musegod") && <p className="feed-note">
          <MarketProvenance label="Summary" data={summary.data} error={summary.error} kind={kind} />
          {(summary.data || summary.error) && (history.data || history.error) ? " · " : ""}
          <MarketProvenance label="Candles" data={history.data} error={history.error} kind={kind} />
          {kind === "musegod" && " · refreshes every minute while visible"}
        </p>}
      </section>
      <section className="card market-feed" aria-label="Recent trades">
        <div className="feed-head">
          <h2 className="card-title">Recent trades</h2>
          {!!trades.data?.trades.length && <div className="segmented compact" role="group" aria-label="Trade filter">
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
          </div>}
        </div>
        {hasActivity && <>
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
        </>}
        {items.length ? (
          <div className="table-scroll">
            <table className="data-table market-table">
              <thead>
                <tr>
                  <th>Type / time</th>
                  <th className="num">Amount (USD)</th>
                  <th className="num">{token.symbol}</th>
                  <th className="num">Price (USD)</th>
                  <th className="num">Transaction sender</th>
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
        {(trades.data?.trades.length && (trades.error || trades.data.status === "stale")) ? <p className="market-warning" role="status">{trades.error || trades.data.warning || "Previous trades snapshot. Refresh to update."}</p> : null}
        <p className="feed-note">
          <MarketProvenance label="Trades" data={trades.data} error={trades.error} kind={kind} />{trades.data || trades.error ? " · " : ""}
          Latest 30 indexed trades · indexing may lag the chain.
        </p>
      </section>
    </>
  );
}
