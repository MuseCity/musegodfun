import { z } from "zod";
import { INTERVAL_SECONDS } from "./candle-history";
import type { CandleData, ChartInterval, MarketSummary, MarketTrade, TradeData } from "./market";
import { MUSEGOD, type MusegodInfo } from "./musegod";

const finite = z.number().finite().nonnegative(), integer = finite.int().safe();
const address = z.string().regex(/^0x[\da-f]{40}$/i), hash = z.string().regex(/^0x[\da-f]{64}$/i);
const identity = { tokenAddress: address.refine(value => value.toLowerCase() === MUSEGOD.token.toLowerCase()), chain: z.literal("robinhood") };
const swapSchema = z.object({ ...identity, txHash: hash, blockNumber: integer, logIndex: integer, timestamp: z.iso.datetime(),
  traderAddress: address.nullish(), side: z.enum(["buy", "sell"]), tokenAmount: finite.positive(), totalUsd: finite.nullable(),
  mcapUsd: finite.nullish(), priceUsd: finite.positive().nullish() });
const priceSchema = z.object({ ...identity, lastPriceUsd: finite.positive(), marketCapUsd: finite.nullable(), lastTradeAt: z.iso.datetime() });
const volumeSchema = z.object({ ...identity, vol1m: finite, priceChange1m: z.number().finite(), vol5m: finite, priceChange5m: z.number().finite(),
  vol1h: finite, priceChange1h: z.number().finite(), vol6h: finite, priceChange6h: z.number().finite(), vol24h: finite,
  priceChange24h: z.number().finite(), txCount24h: integer });
export type LiveSwap = z.infer<typeof swapSchema> & { type: "swap"; id: string; priceUsd: number | null };
export type LiveEvent = LiveSwap | (z.infer<typeof priceSchema> & { type: "price" }) | (z.infer<typeof volumeSchema> & { type: "volume" });
/** Unknown fields are discarded; all consumed fields, token and chain are validated without coercion. */
export function parseLiveEvent(name: string, payload: unknown, now = Date.now()): LiveEvent | null {
  if (name === "TOKEN_SWAP") {
    const result = swapSchema.safeParse(payload);
    if (!result.success || !validTime(result.data.timestamp, now)) return null;
    const row = result.data;
    return { ...row, type: "swap", id: `robinhood:${row.txHash.toLowerCase()}:${row.logIndex}`, priceUsd: row.priceUsd ?? null };
  }
  if (name === "DISCOVER_PRICE_UPDATE") {
    const result = priceSchema.safeParse(payload);
    return result.success && validTime(result.data.lastTradeAt, now) ? { ...result.data, type: "price" } : null;
  }
  if (name === "DISCOVER_VOLUME_UPDATE") {
    const result = volumeSchema.safeParse(payload);
    return result.success ? { ...result.data, type: "volume" } : null;
  }
  return null;
}
function validTime(value: string, now: number) { const time = Date.parse(value); return time <= now + 60_000 && time >= now - 86_400_000; }
export type SupplyInfo = Pick<MusegodInfo, "address" | "poolAddress" | "quoteAddress" | "decimals" | "totalSupply">;
export function verifiedSupply(info: SupplyInfo | null): number | null {
  if (!info || typeof info.address !== "string" || typeof info.poolAddress !== "string" || typeof info.quoteAddress !== "string" ||
    info.address.toLowerCase() !== MUSEGOD.token.toLowerCase() || info.poolAddress.toLowerCase() !== MUSEGOD.pool.toLowerCase() ||
    info.quoteAddress.toLowerCase() !== MUSEGOD.weth.toLowerCase() || info.decimals !== 18 || typeof info.totalSupply !== "string" ||
    !/^[1-9]\d{0,77}$/.test(info.totalSupply) || BigInt(info.totalSupply) >= 2n ** 256n) return null;
  const supply = Number(info.totalSupply) / 10 ** info.decimals;
  return Number.isFinite(supply) && supply > 0 ? supply : null;
}
/** A discovery price carries no chain position: within the same second the stream order decides, an identical replay changes nothing. */
export function newerPrice(previous: Extract<LiveEvent, { type: "price" }> | null, next: Extract<LiveEvent, { type: "price" }>) {
  if (!previous) return true;
  const a = Date.parse(next.lastTradeAt), b = Date.parse(previous.lastTradeAt);
  return a > b || a === b && (next.lastPriceUsd !== previous.lastPriceUsd || next.marketCapUsd !== previous.marketCapUsd);
}
type RestMarket = { summary: MarketSummary | null; candles: CandleData | null; trades: TradeData | null };
export function liveValuesChanged(previous: RestMarket, next: RestMarket) {
  const values = (market: RestMarket) => [market.summary?.priceUsd, market.summary?.marketCapUsd, market.candles?.candles, market.trades?.trades];
  return JSON.stringify(values(previous)) !== JSON.stringify(values(next));
}
export type LiveProjection = RestMarket & { basis: RestMarket & { interval: ChartInterval; info: SupplyInfo | null };
  priceAt: string | null; candlesAt: string | null; tradesAt: string | null };
const order = (a: LiveSwap, b: LiveSwap) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.txHash.localeCompare(b.txHash);
function included(event: LiveSwap, watermark: NonNullable<CandleData["watermark"]>) {
  return event.blockNumber < watermark.blockNumber || event.blockNumber === watermark.blockNumber && event.logIndex <= watermark.logIndex;
}
function swapPrice(event: LiveSwap, supply: number | null) {
  const price = event.priceUsd ?? (event.mcapUsd != null && supply !== null ? event.mcapUsd / supply : null);
  return price !== null && Number.isFinite(price) && price > 0 ? price : null;
}
/** Summary, candles and trades are fetched and cached independently, so each REST section is reconciled on its own evidence and a swap
 * stays pending while any section lacks it. Candles prove inclusion by chain position; trades by id (or by having moved past a full list);
 * the summary only carries a trade time: a later time supersedes the swap, and within the same second REST wins only once candles or
 * trades also show the swap, because an equal timestamp cannot order two trades. A section that is not loaded still lacks everything. */
function sections({ summary, candles, trades }: RestMarket) {
  const listed = new Set(trades?.trades.map(row => row.id.toLowerCase())), oldest = Math.min(...(trades?.trades ?? []).map(row => Date.parse(row.at)));
  const restTime = Date.parse(summary?.lastTradeAt ?? summary?.fetchedAt ?? "");
  return (event: LiveSwap) => {
    const time = Date.parse(event.timestamp), inCandles = !!candles?.watermark && included(event, candles.watermark), inTrades = listed.has(event.id);
    return {
      candle: !inCandles,
      trade: !trades || trades.source === "Bankr" && !inTrades && !(trades.trades.length >= 30 && time < oldest),
      headline: !summary || summary.source === "Bankr" && !(restTime > time || restTime === time && (inCandles || inTrades)),
    };
  };
}
/** Retain events some REST section still lacks, including across interval changes. A full buffer pauses admission instead of losing dedupe history. */
export function retainLiveSwaps(events: LiveSwap[], next: LiveSwap | null, rest: RestMarket, now: number) {
  const lacking = sections(rest), pending = (event: LiveSwap) => Date.parse(event.timestamp) >= now - 86_400_000 && Object.values(lacking(event)).some(Boolean);
  const rows = events.filter(pending);
  return next && pending(next) && rows.length < 500 && !rows.some(row => row.id === next.id) ? [...rows, next] : rows;
}
/** Rebuild from REST plus unique pending events each time; never add volume to a previous optimistic result. */
export function projectLiveMarket(rest: RestMarket & { interval: ChartInterval; info: SupplyInfo | null }, events: LiveSwap[], discovery: Extract<LiveEvent, { type: "price" }> | null = null): LiveProjection {
  let { summary, candles, trades } = rest;
  let priceAt: string | null = null, candlesAt: string | null = null, tradesAt: string | null = null;
  const supply = verifiedSupply(rest.info), lacking = sections(rest), rows = [...new Map(events.map(event => [event.id, event])).values()].sort(order);
  const positions = new Map(rows.map((item, index) => [item.id, index]));
  for (const event of rows) {
    const price = swapPrice(event, supply), need = lacking(event);
    if (price !== null && need.headline && summary?.source === "Bankr") {
      summary = { ...summary, priceUsd: price, marketCapUsd: event.mcapUsd ?? (supply !== null && Number.isFinite(price * supply) ? price * supply : summary.marketCapUsd), lastTradeAt: event.timestamp }; priceAt = event.timestamp;
    }
    // A missing/null watermark cannot prove whether REST already contains this swap.
    if (price !== null && event.totalUsd !== null && need.candle && candles?.source === "Bankr" && candles.status === "fresh" && candles.watermark) {
      const time = Math.floor(Date.parse(event.timestamp) / 1000 / INTERVAL_SECONDS[rest.interval]) * INTERVAL_SECONDS[rest.interval];
      const existing = candles.candles.find(row => row.time === time);
      // Events older than the indexed first page do not fabricate historical bars.
      if (!candles.candles.length || time >= candles.candles[0].time) {
        const volume = (existing?.volume ?? 0) + event.totalUsd;
        if (Number.isFinite(volume)) {
          const updated = existing ? { ...existing, high: Math.max(existing.high, price), low: Math.min(existing.low, price), close: price, volume }
            : { time, open: price, high: price, low: price, close: price, volume };
          candles = { ...candles, candles: [...candles.candles.filter(row => row.time !== time), updated].sort((a, b) => a.time - b.time).slice(-200) };
          candlesAt = event.timestamp;
        }
      }
    }
    if (need.trade && trades?.source === "Bankr") {
      const row: MarketTrade = { id: event.id, hash: event.txHash, account: event.traderAddress ?? null, at: event.timestamp,
        side: event.side, amount: event.tokenAmount, usd: event.totalUsd, price };
      trades = { ...trades, trades: [row, ...trades.trades].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) ||
        (positions.get(b.id) ?? -1) - (positions.get(a.id) ?? -1)).slice(0, 30) };
      tradesAt = event.timestamp;
    }
  }
  // Position-less: a swap or REST summary from the same second outranks a discovery price.
  if (discovery && summary?.source === "Bankr" && Date.parse(discovery.lastTradeAt) > Date.parse(summary.lastTradeAt ?? summary.fetchedAt)) {
    summary = { ...summary, priceUsd: discovery.lastPriceUsd, marketCapUsd: discovery.marketCapUsd, lastTradeAt: discovery.lastTradeAt };
    priceAt = discovery.lastTradeAt;
  }
  return { summary, candles, trades, priceAt, candlesAt, tradesAt, basis: rest };
}
