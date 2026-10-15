import { marketSnapshotKey } from "../src/lib/market";
import type { StoreBackend } from "./supabase-store";
import { MarketFailure, MarketUnavailable, Snapshots } from "./snapshots";
import { z } from "zod";
import { quoteAsset, sameAddress, type TokenRecord } from "../src/lib/config";
import type {
  CandleData,
  ChartInterval,
  HolderData,
  MarketSummary,
  MarketSource,
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
const candleRows = z.array(z.tuple([finite.int().safe(), finite, finite, finite, finite, finite])).max(200);

function normalizeCandles(rows: z.infer<typeof candleRows>, now: number, source: MarketSource = "CoinGecko"): CandleData {
  const unique = new Map<number, CandleData["candles"][number]>();
  for (const [time, open, high, low, close, volume] of rows) {
    if (low > Math.min(open, close) || high < Math.max(open, close) || time > now / 1000 + 60)
      throw new MarketFailure("invalid_schema", source);
    const candle = { time, open, high, low, close, volume }, previous = unique.get(time);
    if (previous) {
      // Providers may append a last-trade fragment after the complete candle.
      // Keep the containing row; summing or last-write wins corrupts volume/OHLC.
      const contains = (a: typeof candle, b: typeof candle) =>
        a.close === b.close && a.high >= b.high && a.low <= b.low &&
        (a.volume > b.volume || (a.volume === b.volume && a.open === b.open && a.high === b.high && a.low === b.low));
      if (contains(previous, candle)) continue;
      if (!contains(candle, previous)) throw new MarketFailure("invalid_schema", source);
    }
    unique.set(time, candle);
  }
  return { fetchedAt: new Date(now).toISOString(), candles: [...unique.values()].sort((a, b) => a.time - b.time) };
}
const poolSchema = z.object({
  data: z.object({
    attributes: z.object({
      address: hash,
      base_token_price_usd: optionalPositive,
      quote_token_price_usd: optionalPositive,
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
  const network = token.mode === "robinhood" ? "robinhood" : "base";
  const meme = `${network}_${token.address.toLowerCase()}`, quote = `${network}_${token.quoteAddress.toLowerCase()}`;
  const baseId = r.base_token.data.id.toLowerCase(), quoteId = r.quote_token.data.id.toLowerCase();
  const forward = baseId === meme && quoteId === quote;
  if (!sameAddress(a.address, token.poolId) || !(forward || baseId === quote && quoteId === meme))
    throw new MarketFailure("invalid_identity", "CoinGecko");
  return {
    fetchedAt: new Date().toISOString(),
    priceUsd: forward ? a.base_token_price_usd : a.quote_token_price_usd,
    fdvUsd: forward ? a.fdv_usd : null,
    marketCapUsd: forward ? a.market_cap_usd : null,
    liquidityUsd: a.reserve_in_usd,
    periods: Object.fromEntries(
      ["m5", "h1", "h6", "h24"].map((period) => [
        period,
        {
          change: forward ? a.price_change_percentage[period] ?? null : null,
          volume: a.volume_usd[period] ?? null,
          buys: forward ? a.transactions[period]?.buys ?? null : null,
          sells: forward ? a.transactions[period]?.sells ?? null : null,
        },
      ]),
    ),
  };
}
export function parseCandles(raw: unknown, token: TokenRecord, now = Date.now(), source: MarketSource = "CoinGecko"): CandleData {
  const data = z
    .object({
      data: z.object({
        attributes: z.object({
          ohlcv_list: candleRows,
        }),
      }),
      meta: z.object({
        base: z.object({ address }),
        quote: z.object({ address }),
      }),
    })
    .safeParse(raw);
  if (!data.success) throw new MarketFailure("invalid_schema", source);
  const value = data.data;
  if (
    !sameAddress(value.meta.base.address, token.address) ||
    !sameAddress(value.meta.quote.address, token.quoteAddress)
  )
    throw new MarketFailure("invalid_identity", source);
  return normalizeCandles(value.data.attributes.ohlcv_list, now, source);
}
export function parseBankrCandles(raw: unknown, token: TokenRecord, now = Date.now()): CandleData {
  const data = z.object({
    ohlcv: candleRows,
    pool: z.object({ address: hash, network: z.literal("robinhood") }),
    pair: z.object({ baseSymbol: z.string(), quoteSymbol: z.string() }),
    watermark: z.object({ blockNumber: finite.int().safe(), logIndex: finite.int().safe(), txHash: hash }).nullish(),
  }).parse(raw);
  if (!sameAddress(data.pool.address, token.poolId) || data.pair.baseSymbol !== token.symbol ||
    data.pair.quoteSymbol !== quoteAsset(token).symbol)
    throw new MarketFailure("invalid_identity", "Bankr");
  return { ...normalizeCandles(data.ohlcv, now, "Bankr"), source: "Bankr", watermark: data.watermark ?? null };
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
              log_index: finite.int().safe().optional(),
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
  const seen = new Set<string>();
  return {
    fetchedAt: new Date().toISOString(),
    trades: rows.flatMap(({ id, attributes: a }) => {
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
        throw new MarketFailure("invalid_identity", "CoinGecko");
      // Demo amounts already use human token units, for both 8 and 18 decimals.
      // The provider event id encodes network_block_txHash_logIndex_timestamp.
      const encoded = new RegExp(`^${token.mode === "robinhood" ? "robinhood" : "base"}_\\d+_${a.tx_hash}_(\\d+)_\\d+$`, "i").exec(id);
      const logIndex = a.log_index ?? (encoded ? Number(encoded[1]) : undefined);
      if (logIndex === undefined || !Number.isSafeInteger(logIndex)) throw new MarketFailure("invalid_schema", "CoinGecko");
      const eventKey = `${token.mode === "robinhood" ? 4663 : 8453}:${a.tx_hash.toLowerCase()}:${logIndex}`;
      if (seen.has(eventKey)) return [];
      seen.add(eventKey);
      return [{
        id: eventKey,
        hash: a.tx_hash,
        account: a.tx_from_address,
        at: a.block_timestamp,
        side: buy ? ("buy" as const) : ("sell" as const),
        amount: buy ? a.to_token_amount : a.from_token_amount,
        usd: a.volume_in_usd,
        price: buy ? a.price_to_in_usd : a.price_from_in_usd,
      }];
    }),
  };
}
export class MarketReader {
  private snapshots?: Snapshots;
  private geckoCalls: number[] = [];
  private backoff = new Map<string, number>();
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
  private cached<T extends { fetchedAt: string; source?: MarketSource }>(
    key: string,
    read: () => Promise<T>,
    source?: MarketSource,
  ): Promise<T> {
    if (!this.snapshots) throw new MarketFailure("missing_config", source ?? "CoinGecko");
    return this.snapshots.get(
      key,
      source ?? (key.endsWith(":holders") ? "Blockscout" : "CoinGecko"),
      read,
    );
  }
  private assertLive(token: TokenRecord) {
    if (token.mode === "fork")
      throw new Error("Local forks do not display mainnet market or holder data. Local onchain quotes remain available.");
    const expected = token.mode === "robinhood" ? 4663 : 8453;
    if (token.deploymentChainId !== undefined && token.deploymentChainId !== expected)
      throw new Error(token.mode === "robinhood" ? "Robinhood Chain mainnet is required" : "Base mainnet is required");
  }
  private async json(url: string) {
    const host = new URL(url).hostname, now = (this.options.now || Date.now)();
    const isMarket = host === "api.coingecko.com";
    const source: MarketSource = isMarket ? "CoinGecko" : host === "api.geckoterminal.com" ? "GeckoTerminal"
      : host === "api.bankr.bot" ? "Bankr" : "Blockscout";
    const retryAt = this.backoff.get(host) ?? 0;
    if (retryAt > now) throw new MarketFailure("rate_limited", source, 429, retryAt);
    if (isMarket && !this.options.apiKey) throw new MarketFailure("missing_config", source);
    if (isMarket && !(await this.options.store?.reserveMarketCall(now, this.options.daily, this.options.monthly)))
      throw new MarketFailure("quota_exhausted", source);
    if (source === "GeckoTerminal") {
      this.geckoCalls = this.geckoCalls.filter(at => now - at < 60_000);
      if (this.geckoCalls.length >= 30) throw new MarketFailure("rate_limited", source, undefined, now + 60_000);
      this.geckoCalls.push(now);
    }
    let response: Response;
    try {
      response = await (this.options.fetch || fetch)(url, {
        method: "GET", headers: { accept: "application/json", ...(isMarket ? { "x-cg-demo-api-key": this.options.apiKey! } : {}) },
        signal: AbortSignal.timeout(15_000), redirect: "manual",
      });
    } catch { throw new MarketFailure("upstream_transport", source); }
    if (!response.ok) {
      let retry: number | undefined;
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        retry = Math.max(now + 60_000, header && /^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(header ?? "") || 0);
        this.backoff.set(host, retry);
      }
      throw new MarketFailure(response.status === 404 ? "not_indexed" : response.status === 429 ? "rate_limited" : "upstream_http", source, response.status, retry);
    }
    try { return await response.json(); }
    catch { throw new MarketFailure("invalid_schema", source); }
  }
  private pool(token: TokenRecord) {
    return `https://api.coingecko.com/api/v3/onchain/networks/${token.mode === "robinhood" ? "robinhood" : "base"}/pools/${token.poolId}`;
  }
  summary(token: TokenRecord) {
    this.assertLive(token);
    return this.cached(marketSnapshotKey(token, "summary"), async () =>
      parseMarketSummary(await this.json(this.pool(token)), token),
    );
  }
  summaries(tokens: TokenRecord[]) {
    tokens.forEach((token) => this.assertLive(token));
    if (tokens.some(token => token.mode !== tokens[0].mode)) throw new Error("Market batches require a single network");
    if (tokens.length > 30) throw new Error("You can query up to 30 pools at a time");
    let batch: Promise<unknown> | undefined;
    const read = () =>
      (batch ??= this.json(
        `https://api.coingecko.com/api/v3/onchain/networks/${tokens[0].mode === "robinhood" ? "robinhood" : "base"}/pools/multi/${tokens.map((t) => t.poolId).join(",")}`,
      ));
    return Promise.all(
      tokens.map(async (token) => {
        try {
          const summary = await this.cached(
            marketSnapshotKey(token, "summary"),
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
              if (!entry) throw new MarketFailure("not_indexed", "CoinGecko");
              return parseMarketSummary({ data: entry }, token);
            },
          );
          return { address: token.address, summary };
        } catch (error) {
          const failure = error instanceof MarketUnavailable ? error : undefined;
          return {
            address: token.address,
            summary: null,
            status: "unavailable",
            source: failure?.source ?? "CoinGecko",
            reason: failure?.reason ?? "upstream_transport",
            upstreamStatus: failure?.upstreamStatus,
            nextRefreshAt: failure?.nextRefreshAt,
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
    if (token.mode === "robinhood") {
      const key = marketSnapshotKey(token, `candles:${interval}`);
      return this.cached(key, async (): Promise<CandleData> => {
        const now = () => (this.options.now || Date.now)();
        try {
          return { ...parseCandles(await this.json(`${this.pool(token)}/ohlcv/${frame}?aggregate=${aggregate}&limit=200&currency=usd&token=${token.address}`), token, now()), source: "CoinGecko" };
        } catch { /* Bounded existing Bankr -> GeckoTerminal path, with no retry of CoinGecko. */ }
        let empty: CandleData | undefined;
        try {
          const data = parseBankrCandles(await this.json(
            `https://api.bankr.bot/discover/${token.address.toLowerCase()}/ohlcv?aggregate=${aggregate}&limit=200&timeframe=${frame}&chain=robinhood`,
          ), token, now());
          if (data.candles.length) return data;
          empty = data;
        } catch { /* Try the registered pool directly through GeckoTerminal. */ }
        try {
          const data = parseCandles(await this.json(
            `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${token.poolId}/ohlcv/${frame}?aggregate=${aggregate}&limit=200&currency=usd&token=${token.address}`,
          ), token, now(), "GeckoTerminal");
          return data.candles.length || !empty ? { ...data, source: "GeckoTerminal" } : empty;
        } catch (error) {
          if (empty) return empty;
          throw error;
        }
      }, "CoinGecko");
    }
    return this.cached(marketSnapshotKey(token, `candles:${interval}`), async () =>
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
    return this.cached(marketSnapshotKey(token, "trades"), async () =>
      parseTrades(await this.json(`${this.pool(token)}/trades`), token),
    );
  }
  holders(token: TokenRecord): Promise<HolderData> {
    this.assertLive(token);
    return this.cached(marketSnapshotKey(token, "holders"), async () => {
      const root = `https://${token.mode === "robinhood" ? "robinhoodchain" : "base"}.blockscout.com/api/v2/tokens/${token.address}`;
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
        throw new MarketFailure("invalid_identity", "Blockscout");
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
