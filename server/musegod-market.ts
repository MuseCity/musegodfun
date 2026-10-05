import { z } from "zod";
import { sameAddress, type RuntimeConfig } from "../src/lib/config";
import { MUSEGOD } from "../src/lib/musegod";
import type {
  CandleData,
  ChartInterval,
  MarketSummary,
  SnapshotMeta,
  TradeData,
} from "../src/lib/market";
import type { StoreBackend } from "./supabase-store";
import { MarketUnavailable, Snapshots } from "./snapshots";

export const MUSEGOD_MARKET_TTL = 60_000;
const TOKEN = MUSEGOD.token.toLowerCase();
const POOL = MUSEGOD.pool.toLowerCase();
const API_ROOT = "https://api.bankr.bot";
const KEY = `bankr:robinhood:${TOKEN}:${POOL}`;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const nonnegative = z.number().finite().nonnegative();
const integer = nonnegative.int().safe();
const datetime = z.iso.datetime();
const nullableNumber = (signed = false) =>
  z.unknown().transform((value) => {
    if (
      typeof value !== "number" &&
      !(typeof value === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))
    ) return null;
    const number = Number(value);
    return Number.isFinite(number) && (signed || number >= 0) ? number : null;
  });
const nullableCount = nullableNumber().transform((value) =>
  value !== null && Number.isSafeInteger(value) ? value : null,
);
const discoverySchema = z.object({
  token: z.object({
    tokenAddress: address,
    poolId: address,
    chain: z.literal("robinhood"),
    name: z.literal("MUSEGOD"),
    symbol: z.literal("MUSEGOD"),
    pairedAsset: z.literal("weth"),
    decimals: z.literal(18).nullish(),
    lastPriceUsd: nullableNumber(),
    marketCapUsd: nullableNumber(),
    lastTradeAt: datetime.nullish(),
    priceChange5m: nullableNumber(true),
    priceChange1h: nullableNumber(true),
    priceChange6h: nullableNumber(true),
    priceChange24h: nullableNumber(true),
  }),
});
type DiscoveryData = SnapshotMeta & {
  fetchedAt: string;
  token: z.infer<typeof discoverySchema>["token"];
};
function parseDiscovery(raw: unknown, now: number): DiscoveryData {
  const { token } = discoverySchema.parse(raw);
  if (!sameAddress(token.tokenAddress, TOKEN) || !sameAddress(token.poolId, POOL))
    throw new Error("The MUSEGOD market provider returned a different token or pool.");
  if (token.lastTradeAt && Date.parse(token.lastTradeAt) > now + 60_000)
    throw new Error("The market provider returned a future trade timestamp.");
  return { fetchedAt: new Date(now).toISOString(), token };
}
const statsSchema = z.object({
  liquidityUsd: nullableNumber(),
  windows: z.record(z.string(), z.object({
    buys: nullableCount,
    sells: nullableCount,
    totalVolumeUsd: nullableNumber(),
  })).default({}),
});
function summary(discovery: DiscoveryData, rawStats: unknown, now: number): MarketSummary {
  const stats = statsSchema.parse(rawStats), token = discovery.token;
  const periods = [
    ["m5", "5m", token.priceChange5m],
    ["h1", "1h", token.priceChange1h],
    ["h6", "6h", token.priceChange6h],
    ["h24", "24h", token.priceChange24h],
  ] as const;
  return {
    fetchedAt: new Date(now).toISOString(),
    lastTradeAt: token.lastTradeAt ?? null,
    priceUsd: token.lastPriceUsd,
    marketCapUsd: token.marketCapUsd,
    // Discover currently has no FDV and reports an unknown total supply.
    fdvUsd: null,
    liquidityUsd: stats.liquidityUsd,
    periods: Object.fromEntries(periods.map(([period, window, change]) => [
      period,
      {
        change,
        volume: stats.windows[window]?.totalVolumeUsd ?? null,
        buys: stats.windows[window]?.buys ?? null,
        sells: stats.windows[window]?.sells ?? null,
      },
    ])),
  };
}
export function parseMusegodSummary(rawDiscovery: unknown, rawStats: unknown, now = Date.now()): MarketSummary {
  return summary(parseDiscovery(rawDiscovery, now), rawStats, now);
}
export function parseMusegodCandles(raw: unknown, now = Date.now()): CandleData {
  const data = z.object({
    ohlcv: z.array(z.tuple([
      integer, nonnegative, nonnegative, nonnegative, nonnegative, nonnegative,
    ])).max(200),
    pool: z.object({ address, network: z.literal("robinhood") }),
    pair: z.object({ baseSymbol: z.literal("MUSEGOD"), quoteSymbol: z.literal("WETH") }),
    watermark: z.object({ blockNumber: integer, logIndex: integer, txHash: hash }).nullish(),
  }).parse(raw);
  if (!sameAddress(data.pool.address, POOL))
    throw new Error("The MUSEGOD candle pool does not match.");
  const candles = data.ohlcv.map(([time, open, high, low, close, volume]) => ({
    time, open, high, low, close, volume,
  }));
  if (candles.some((candle) =>
    candle.low > Math.min(candle.open, candle.close) ||
    candle.high < Math.max(candle.open, candle.close) ||
    candle.time > now / 1000 + 60,
  )) throw new Error("Invalid MUSEGOD candle data.");
  // Keep only provider candles: periods without indexed trades remain gaps.
  return {
    fetchedAt: new Date(now).toISOString(),
    candles: [...new Map(candles.map((candle) => [candle.time, candle])).values()]
      .sort((a, b) => a.time - b.time),
    watermark: data.watermark ?? null,
  };
}
export function parseMusegodTrades(raw: unknown, now = Date.now()): TradeData {
  const rows = z.object({
    swaps: z.array(z.object({
      txHash: hash,
      blockNumber: integer,
      logIndex: integer,
      timestamp: datetime,
      side: z.enum(["buy", "sell"]),
      tokenAmount: nonnegative.positive(),
      totalUsd: nullableNumber(),
      traderAddress: address.nullish(),
      chain: z.literal("robinhood"),
    })).max(500),
  }).parse(raw).swaps;
  if (rows.some((row) => Date.parse(row.timestamp) > now + 60_000))
    throw new Error("The market provider returned a future trade timestamp.");
  const unique = [...new Map(rows.map((row) => [
    `robinhood:${row.txHash.toLowerCase()}:${row.logIndex}`, row,
  ])).entries()].sort(([, a], [, b]) =>
    Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
    b.blockNumber - a.blockNumber || b.logIndex - a.logIndex,
  );
  return {
    fetchedAt: new Date(now).toISOString(),
    trades: unique.slice(0, 30).map(([id, row]) => {
      const price = row.totalUsd === null ? null : row.totalUsd / row.tokenAmount;
      return {
        id,
        hash: row.txHash,
        account: row.traderAddress ?? null,
        at: row.timestamp,
        // Pools reports side in the requested MUSEGOD token's perspective.
        side: row.side,
        amount: row.tokenAmount,
        usd: row.totalUsd,
        price: price !== null && Number.isFinite(price) ? price : null,
      };
    }),
  };
}
const intervals: Record<ChartInterval, readonly [string, number]> = {
  "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15],
  "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1],
};
export class MusegodMarketReader {
  private readonly snapshots: Snapshots;
  constructor(
    private readonly config: RuntimeConfig,
    store: StoreBackend,
    private readonly options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.snapshots = new Snapshots(store, options.now);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private assertMainnet() {
    if (this.config.mode !== "robinhood" || this.config.chainId !== 4663)
      throw new MarketUnavailable(
        this.config.mode === "fork"
          ? "Local forks do not display mainnet MUSEGOD market data."
          : "MUSEGOD market data requires Robinhood Chain mainnet.",
        new Date(this.now() + MUSEGOD_MARKET_TTL).toISOString(), "Bankr",
      );
  }
  private async json(path: string) {
    const response = await (this.options.fetch ?? fetch)(`${API_ROOT}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("The Bankr market provider is unavailable.");
    return response.json();
  }
  private cached<T extends { fetchedAt: string }>(section: string, read: () => Promise<T>) {
    return this.snapshots.get(`${KEY}:${section}`, "Bankr", read, MUSEGOD_MARKET_TTL);
  }
  private async discovery(): Promise<DiscoveryData> {
    const data = await this.cached("discover", async () =>
      parseDiscovery(await this.json(`/discover/${TOKEN}`), this.now()),
    );
    // Swaps/stats omit token and pool addresses. Require a current validated
    // discovery response before displaying newly fetched data from those URLs.
    if (data.status === "stale") throw new Error("MUSEGOD identity could not be refreshed.");
    return data;
  }
  summary(): Promise<MarketSummary> {
    this.assertMainnet();
    return this.cached("summary", async () => {
      const [discovery, stats] = await Promise.all([
        this.discovery(), this.json(`/pools-fun/stats?tokenAddress=${TOKEN}`),
      ]);
      return summary(discovery, stats, this.now());
    });
  }
  candles(interval: ChartInterval): Promise<CandleData> {
    this.assertMainnet();
    if (!Object.hasOwn(intervals, interval)) throw new Error("Invalid chart interval.");
    const [frame, aggregate] = intervals[interval];
    return this.cached(`candles:${interval}`, async () => parseMusegodCandles(
      await this.json(`/discover/${TOKEN}/ohlcv?aggregate=${aggregate}&limit=200&timeframe=${frame}&chain=robinhood`),
      this.now(),
    ));
  }
  trades(): Promise<TradeData> {
    this.assertMainnet();
    return this.cached("trades", async () => {
      await this.discovery();
      return parseMusegodTrades(
        await this.json(`/pools-fun/swaps?tokenAddress=${TOKEN}&limit=30&offset=0`), this.now(),
      );
    });
  }
}
