import { deploymentChain, type TokenRecord } from "./config";

export function marketSnapshotKey(token: Pick<TokenRecord, "mode" | "deploymentChainId"> & { address: string; poolId: string; quoteAddress: string }, section: string) {
  return `market:v2:${deploymentChain(token)}:${token.mode}:${token.address.toLowerCase()}:${token.poolId.toLowerCase()}:${token.quoteAddress.toLowerCase()}:${section}`;
}
export type MarketSource = "CoinGecko" | "Bankr" | "GeckoTerminal" | "Storage" | "Internal" | "Unavailable";
export type MarketReason = "missing_config" | "quota_exhausted" | "not_indexed" | "rate_limited" | "upstream_http" | "upstream_transport" | "upstream_unclassified" | "invalid_identity" | "invalid_schema" | "source_not_provided" | "history_not_available" | "storage_unavailable" | "internal_error" | "backoff";
export type MarketCause = { source: MarketSource; reason: MarketReason; upstreamStatus?: number };
export type SnapshotMeta = {
  causes?: MarketCause[];
  reason?: MarketReason;
  upstreamStatus?: number;
  source?: MarketSource;
  status?: "fresh" | "stale" | "unavailable";
  nextRefreshAt?: string;
  warning?: string;
};
export const CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];
export type MarketSummary = SnapshotMeta & {
  fetchedAt: string;
  lastTradeAt?: string | null;
  priceUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  periods: Record<
    string,
    {
      change: number | null;
      volume: number | null;
      buys: number | null;
      sells: number | null;
    }
  >;
};
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type CandleData = SnapshotMeta & {
  fetchedAt: string;
  candles: Candle[];
  watermark?: {
    blockNumber: number;
    logIndex: number;
    txHash: string;
  } | null;
};
export type MarketTrade = {
  id: string;
  hash: string;
  account: string | null;
  at: string;
  side: "buy" | "sell";
  amount: number;
  usd: number | null;
  price: number | null;
};
export type TradeData = SnapshotMeta & {
  fetchedAt: string;
  trades: MarketTrade[];
};
export function marketStatusMessage(reason?: MarketReason) {
  return reason === "source_not_provided" ? "Holder data unavailable" : reason === "not_indexed" ? "Market records are not indexed for this pool yet." : "Market data unavailable";
}
