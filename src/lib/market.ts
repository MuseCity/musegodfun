export type MarketSource = "CoinGecko" | "Blockscout" | "Bankr" | "GeckoTerminal";
export type SnapshotMeta = {
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
export type HolderData = SnapshotMeta & {
  fetchedAt: string;
  indexedCount: number | null;
  totalSupply: string;
  holders: { address: string; amount: string; isContract: boolean }[];
};
