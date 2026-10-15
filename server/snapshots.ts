import type { StoreBackend } from "./supabase-store";
import type { MarketReason, MarketSource } from "../src/lib/market";
export const SNAPSHOT_TTL = 15 * 60_000;
export const MAX_STALE = 24 * 60 * 60_000;
export class MarketFailure extends Error {
  constructor(readonly reason: MarketReason, readonly source: MarketSource,
    readonly upstreamStatus?: number, readonly retryAt?: number) {
    super("Market data is temporarily unavailable. Try again later.");
  }
}
export function marketFailure(error: unknown, source: MarketSource): MarketFailure {
  if (error instanceof MarketFailure) return error;
  return new MarketFailure(error instanceof Error && (error.name === "ZodError" || error.name === "SyntaxError")
    ? "invalid_schema" : "upstream_transport", source);
}
export class MarketUnavailable extends Error {
  readonly status = "unavailable";
  constructor(
    message: string,
    readonly nextRefreshAt: string,
    readonly source: string = "CoinGecko",
    readonly reason?: MarketReason,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}
export class Snapshots {
  private inflight = new Map<string, Promise<unknown>>();
  private retryAt = new Map<string, number>();
  private failures = new Map<string, MarketFailure>();
  constructor(
    readonly store: StoreBackend,
    readonly now = Date.now,
  ) {}
  get<T extends { fetchedAt: string; source?: MarketSource }>(
    key: string,
    source: MarketSource,
    read: () => Promise<T>,
    ttl = SNAPSHOT_TTL,
  ): Promise<T> {
    const inflight = this.inflight.get(key);
    if (inflight) return inflight as Promise<T>;
    const result = (async () => {
      const now = this.now(),
        previous = await this.store.snapshot(key);
      const present = (
        data: T,
        at: number,
        stale: boolean,
        next: number,
        warning?: string,
        failure?: MarketFailure,
      ) => ({
        ...data,
        fetchedAt: new Date(at).toISOString(),
        source: data.source ?? source,
        status: stale ? "stale" : "fresh",
        nextRefreshAt: new Date(next).toISOString(),
        warning,
        ...(failure ? { reason: failure.reason, upstreamStatus: failure.upstreamStatus } : {}),
      });
      if (previous && now - previous.at < ttl)
        return Promise.resolve(
          present(
            previous.data as T,
            previous.at,
            false,
            previous.at + ttl,
          ),
        );
      const next = this.retryAt.get(key) || 0;
      if (next > now) {
        if (previous && now - previous.at < MAX_STALE)
          return Promise.resolve(
            present(
              previous.data as T,
              previous.at,
              true,
              next,
              "Refresh is unavailable. Showing a stale snapshot.",
              this.failures.get(key),
            ),
          );
        return Promise.reject(
          new MarketUnavailable(
            "Market data is unavailable. Try again later.",
            new Date(next).toISOString(),
            this.failures.get(key)?.source ?? source,
            this.failures.get(key)?.reason,
            this.failures.get(key)?.upstreamStatus,
          ),
        );
      }

      try {
        const data = await read(),
          at = this.now();
        await this.store.saveSnapshot(key, data, at);
        this.retryAt.delete(key);
        this.failures.delete(key);
        return present(data, at, false, at + ttl);
      } catch (error) {
        const failure = marketFailure(error, source);
        const retry = Math.max(this.now() + ttl, failure.retryAt ?? 0);
        this.failures.set(key, failure);
        this.retryAt.set(key, retry);
        if (previous && this.now() - previous.at < MAX_STALE)
          return present(
            previous.data as T,
            previous.at,
            true,
            retry,
            "Refresh is unavailable. Showing a stale snapshot.",
            failure,
          );
        throw new MarketUnavailable(
          "Market data is temporarily unavailable. Try again later.",
          new Date(retry).toISOString(),
          failure.source,
          failure.reason,
          failure.upstreamStatus,
        );
      } finally {
        this.inflight.delete(key);
      }
    })();
    void result.finally(() => this.inflight.delete(key)).catch(() => {});
    this.inflight.set(key, result);
    return result;
  }
}
