import type { StoreBackend } from "./supabase-store";
import { MarketUnavailable, Snapshots } from "./snapshots";
import { z } from "zod";
import { sameAddress, type TokenRecord } from "../src/lib/config";
import type {
  CandleData,
  ChartInterval,
  HolderData,
  MarketSummary,
  TradeData,
} from "../src/lib/market";

const finite = z.number().finite().nonnegative();
const numeric = z
  .union([z.number(), z.string().regex(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i)])
  .transform(Number)
  .pipe(finite);
const optionalNumber = z
  .union([z.string().min(1), z.number()])
  .nullable()
  .optional()
  .transform((v) =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v),
  );
const optionalPositive = optionalNumber.transform((v) =>
  v !== null && v < 0 ? null : v,
);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const poolSchema = z.object({
  data: z.object({
    attributes: z.object({
      address: hash,
      base_token_price_usd: optionalPositive,
      fdv_usd: optionalPositive,
      market_cap_usd: optionalPositive,
      reserve_in_usd: optionalPositive,
      price_change_percentage: z.record(z.string(), optionalNumber).default({}),
      volume_usd: z.record(z.string(), optionalPositive).default({}),
      transactions: z
        .record(
          z.string(),
          z.object({ buys: optionalPositive, sells: optionalPositive }),
        )
        .default({}),
    }),
    relationships: z.object({
      base_token: z.object({ data: z.object({ id: z.string() }) }),
      quote_token: z.object({ data: z.object({ id: z.string() }) }),
    }),
  }),
});
export function parseMarketSummary(
  raw: unknown,
  token: TokenRecord,
): MarketSummary {
  const { attributes: a, relationships: r } = poolSchema.parse(raw).data;
  // Avoid accidentally showing the stock's price or another pool's statistics.
  if (
    !sameAddress(a.address, token.poolId) ||
    r.base_token.data.id.toLowerCase() !==
      `base_${token.address.toLowerCase()}` ||
    r.quote_token.data.id.toLowerCase() !==
      `base_${token.quoteAddress.toLowerCase()}`
  )
    throw new Error("The market provider returned a different trading pair. Data is not displayed.");
  return {
    fetchedAt: new Date().toISOString(),
    priceUsd: a.base_token_price_usd,
    fdvUsd: a.fdv_usd,
    marketCapUsd: a.market_cap_usd,
    liquidityUsd: a.reserve_in_usd,
    periods: Object.fromEntries(
      ["m5", "h1", "h6", "h24"].map((period) => [
        period,
        {
          change: a.price_change_percentage[period] ?? null,
          volume: a.volume_usd[period] ?? null,
          buys: a.transactions[period]?.buys ?? null,
          sells: a.transactions[period]?.sells ?? null,
        },
      ]),
    ),
  };
}
export function parseCandles(raw: unknown, token: TokenRecord): CandleData {
  const data = z
    .object({
      data: z.object({
        attributes: z.object({
          ohlcv_list: z
            .array(
              z.tuple([finite.int(), finite, finite, finite, finite, finite]),
            )
            .max(200),
        }),
      }),
      meta: z.object({
        base: z.object({ address }),
        quote: z.object({ address }),
      }),
    })
    .parse(raw);
  if (
    !sameAddress(data.meta.base.address, token.address) ||
    !sameAddress(data.meta.quote.address, token.quoteAddress)
  )
    throw new Error("The candle trading pair does not match");
  const candles = data.data.attributes.ohlcv_list.map(
    ([time, open, high, low, close, volume]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    }),
  );
  if (
    candles.some(
      (c) =>
        c.low > Math.min(c.open, c.close) ||
        c.high < Math.max(c.open, c.close) ||
        c.time > Date.now() / 1000 + 60,
    )
  )
    throw new Error("Invalid candle data");
  return {
    fetchedAt: new Date().toISOString(),
    candles: [...new Map(candles.map((c) => [c.time, c])).values()].sort(
      (a, b) => a.time - b.time,
    ),
  };
}
export function parseTrades(raw: unknown, token: TokenRecord): TradeData {
  const rows = z
    .object({
      data: z
        .array(
          z.object({
            id: z.string(),
            attributes: z.object({
              tx_hash: hash,
              tx_from_address: address,
              block_timestamp: z.iso.datetime(),
              kind: z.enum(["buy", "sell"]),
              from_token_address: address,
              to_token_address: address,
              from_token_amount: numeric,
              to_token_amount: numeric,
              price_from_in_usd: optionalPositive,
              price_to_in_usd: optionalPositive,
              volume_in_usd: optionalPositive,
            }),
          }),
        )
        .max(500),
    })
    .parse(raw).data;
  return {
    fetchedAt: new Date().toISOString(),
    trades: rows.map(({ id, attributes: a }) => {
      const buy = sameAddress(a.to_token_address, token.address);
      if (
        !sameAddress(
          buy ? a.from_token_address : a.to_token_address,
          token.quoteAddress,
        ) ||
        !sameAddress(
          buy ? a.to_token_address : a.from_token_address,
          token.address,
        )
      )
        throw new Error("The trade assets do not match");
      return {
        id,
        hash: a.tx_hash,
        account: a.tx_from_address,
        at: a.block_timestamp,
        side: buy ? ("buy" as const) : ("sell" as const),
        amount: buy ? a.to_token_amount : a.from_token_amount,
        usd: a.volume_in_usd,
        price: buy ? a.price_to_in_usd : a.price_from_in_usd,
      };
    }),
  };
}
export class MarketReader {
  private snapshots?: Snapshots;
  constructor(
    private readonly options: {
      store?: StoreBackend;
      apiKey?: string;
      fetch?: typeof fetch;
      now?: () => number;
      daily?: number;
      monthly?: number;
    } = {},
  ) {
    if (options.store)
      this.snapshots = new Snapshots(options.store, options.now);
  }
  private cached<T extends { fetchedAt: string }>(
    key: string,
    read: () => Promise<T>,
  ): Promise<T> {
    if (!this.snapshots) throw new Error("Persistent market storage is not configured");
    return this.snapshots.get(
      key,
      key.endsWith(":holders") ? "Blockscout" : "CoinGecko",
      read,
    );
  }
  private assertLive(token: TokenRecord, source = "CoinGecko") {
    if (token.mode === "fork")
      throw new Error("Local forks do not display mainnet market or holder data. Local onchain quotes remain available.");
    if (token.mode !== "base")
      throw new MarketUnavailable(
        "Market and holder data for Robinhood Chain are not configured. Onchain quotes remain available.",
        new Date((this.options.now || Date.now)() + 15 * 60_000).toISOString(),
        source,
      );
  }
  private async json(url: string) {
    const isMarket = new URL(url).hostname === "api.coingecko.com";
    if (isMarket && !this.options.apiKey)
      throw new Error("The CoinGecko Demo API key is not configured");
    if (
      isMarket &&
      !(await this.options.store?.reserveMarketCall(
        (this.options.now || Date.now)(),
        this.options.daily,
        this.options.monthly,
      ))
    )
      throw new Error("The free market data quota for this period has been exhausted");
    const response = await (this.options.fetch || fetch)(url, {
      headers: {
        accept: "application/json",
        ...(isMarket ? { "x-cg-demo-api-key": this.options.apiKey! } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? "This pool is not yet indexed by the market provider."
          : "The market provider is unavailable. Try refreshing later.",
      );
    return response.json();
  }
  private pool(token: TokenRecord) {
    return `https://api.coingecko.com/api/v3/onchain/networks/base/pools/${token.poolId}`;
  }
  summary(token: TokenRecord) {
    this.assertLive(token);
    return this.cached(`${token.address}:summary`, async () =>
      parseMarketSummary(await this.json(this.pool(token)), token),
    );
  }
  summaries(tokens: TokenRecord[]) {
    tokens.forEach((token) => this.assertLive(token));
    if (tokens.length > 30) throw new Error("You can query up to 30 pools at a time");
    let batch: Promise<unknown> | undefined;
    const read = () =>
      (batch ??= this.json(
        `https://api.coingecko.com/api/v3/onchain/networks/base/pools/multi/${tokens.map((t) => t.poolId).join(",")}`,
      ));
    return Promise.all(
      tokens.map(async (token) => {
        try {
          const summary = await this.cached(
            `${token.address}:summary`,
            async () => {
              const raw = z
                .object({
                  data: z.array(
                    z
                      .object({
                        attributes: z.object({ address: hash }).passthrough(),
                      })
                      .passthrough(),
                  ),
                })
                .parse(await read());
              const entry = raw.data.find((d) =>
                sameAddress(d.attributes.address, token.poolId),
              );
              return parseMarketSummary({ data: entry }, token);
            },
          );
          return { address: token.address, summary };
        } catch {
          return {
            address: token.address,
            summary: null,
            status: "unavailable",
          };
        }
      }),
    );
  }
  candles(token: TokenRecord, interval: ChartInterval) {
    this.assertLive(token);
    const [frame, aggregate] = (
      {
        "1m": ["minute", 1],
        "5m": ["minute", 5],
        "15m": ["minute", 15],
        "1h": ["hour", 1],
        "4h": ["hour", 4],
        "1d": ["day", 1],
      } as const
    )[interval];
    return this.cached(`${token.address}:${interval}`, async () =>
      parseCandles(
        await this.json(
          `${this.pool(token)}/ohlcv/${frame}?aggregate=${aggregate}&limit=200&currency=usd&token=${token.address}`,
        ),
        token,
      ),
    );
  }
  trades(token: TokenRecord) {
    this.assertLive(token);
    return this.cached(`${token.address}:trades`, async () =>
      parseTrades(await this.json(`${this.pool(token)}/trades`), token),
    );
  }
  holders(token: TokenRecord): Promise<HolderData> {
    this.assertLive(token, "Blockscout");
    return this.cached(`${token.address}:holders`, async () => {
      const root = `https://base.blockscout.com/api/v2/tokens/${token.address}`;
      const [rawInfo, rawHolders] = await Promise.all([
        this.json(root),
        this.json(`${root}/holders`),
      ]);
      const info = z
        .object({
          address_hash: address,
          decimals: z.literal("18"),
          total_supply: z.string().regex(/^\d+$/),
          holders_count: optionalNumber,
        })
        .parse(rawInfo);
      if (!sameAddress(info.address_hash, token.address))
        throw new Error("The holder data asset does not match");
      const holders = z
        .object({
          items: z
            .array(
              z.object({
                address: z.object({ hash: address, is_contract: z.boolean() }),
                value: z.string().regex(/^\d+$/),
              }),
            )
            .max(100),
        })
        .parse(rawHolders).items;
      return {
        fetchedAt: new Date().toISOString(),
        indexedCount: info.holders_count,
        totalSupply: info.total_supply,
        holders: holders.slice(0, 10).map((h) => ({
          address: h.address.hash,
          amount: h.value,
          isContract: h.address.is_contract,
        })),
      };
    });
  }
}
