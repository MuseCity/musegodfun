import type { StoreBackend } from "./supabase-store";
import type { MarketSource } from "../src/lib/market";
export const SNAPSHOT_TTL = 15 * 60_000;
export const MAX_STALE = 24 * 60 * 60_000;
export class MarketUnavailable extends Error {
  readonly status = "unavailable";
  constructor(
    message: string,
    readonly nextRefreshAt: string,
    readonly source: string = "CoinGecko",
  ) {
    super(message);
  }
}
export class Snapshots {
  private inflight = new Map<string, Promise<unknown>>();
  private retryAt = new Map<string, number>();
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
      ) => ({
        ...data,
        fetchedAt: new Date(at).toISOString(),
        source: data.source ?? source,
        status: stale ? "stale" : "fresh",
        nextRefreshAt: new Date(next).toISOString(),
        warning,
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
            ),
          );
        return Promise.reject(
          new MarketUnavailable(
            "Market data is unavailable. Try again later.",
            new Date(next).toISOString(),
            source,
          ),
        );
      }

      try {
        const data = await read(),
          at = this.now();
        await this.store.saveSnapshot(key, data, at);
        this.retryAt.delete(key);
        return present(data, at, false, at + ttl);
      } catch {
        const retry = this.now() + ttl;
        this.retryAt.set(key, retry);
        if (previous && this.now() - previous.at < MAX_STALE)
          return present(
            previous.data as T,
            previous.at,
            true,
            retry,
            "The provider is unavailable, the pool is not indexed, or the quota is exhausted. Showing a stale snapshot.",
          );
        throw new MarketUnavailable(
          "The provider is unavailable, the pool is not indexed, or the quota is exhausted. No valid snapshot is available.",
          new Date(retry).toISOString(),
          source,
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
