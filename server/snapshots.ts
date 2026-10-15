import type { StoreBackend } from "./supabase-store";
import type { MarketCause, MarketReason, MarketSource } from "../src/lib/market";
export const SNAPSHOT_TTL = 15 * 60_000;
export const MAX_STALE = 24 * 60 * 60_000;
export class MarketFailure extends Error {
  constructor(readonly reason: MarketReason, readonly source: MarketSource,
    readonly upstreamStatus?: number, readonly retryAt?: number, readonly causes?: MarketCause[]) {
    super("Market data is temporarily unavailable. Try again later.");
  }
}
export function marketFailure(error: unknown, source: MarketSource): MarketFailure {
  if (error instanceof MarketFailure) return error;
  if (error instanceof Error && (error.name === "ZodError" || error.name === "SyntaxError"))
    return new MarketFailure("invalid_schema", source);
  if (error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name))
    return new MarketFailure("upstream_transport", source);
  // Preserve provider identity; an unknown exception alone does not prove a program bug.
  if (error instanceof Error && ["AssertionError", "ReferenceError", "RangeError"].includes(error.name))
    return new MarketFailure("internal_error", source, undefined, undefined,
      [{ source: "Internal", reason: "internal_error" }]);
  return new MarketFailure("upstream_unclassified", source);
}
/** Classify at the fetch boundary before legacy readers discard HTTP status. */
export function marketFetch(source: MarketSource, fetcher: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  return async (...args) => {
    let response: Response;
    try { response = await fetcher(...args); }
    catch { throw new MarketFailure("upstream_transport", source); }
    if (!response.ok) throw new MarketFailure("upstream_http", source, response.status);
    return response;
  };
}
export class MarketUnavailable extends Error {
  readonly status = "unavailable";
  constructor(
    message: string,
    readonly nextRefreshAt: string,
    readonly source: string = "CoinGecko",
    readonly reason?: MarketReason,
    readonly upstreamStatus?: number,
    readonly causes?: MarketCause[],
  ) {
    super(message);
  }
}
export class Snapshots {
  private inflight = new Map<string, Promise<unknown>>();
  private retryAt = new Map<string, number>();
  private failures = new Map<string, MarketFailure>();
  private unpersisted = new Map<string, { at: number; data: unknown }>();
  constructor(
    readonly store: StoreBackend,
    readonly now = Date.now,
  ) {}
  get<T extends { fetchedAt: string; source?: MarketSource }>(
    key: string,
    source: MarketSource,
    read: (previous?: T) => Promise<T>,
    ttl = SNAPSHOT_TTL,
  ): Promise<T> {
    const inflight = this.inflight.get(key);
    if (inflight) return inflight as Promise<T>;
    const result = (async () => {
      const now = this.now();
      const local = this.unpersisted.get(key);
      if (local && now - local.at < ttl) return local.data as T;
      this.unpersisted.delete(key);
      let previous: Awaited<ReturnType<StoreBackend["snapshot"]>>;
      try { previous = await this.store.snapshot(key); }
      catch {
        throw new MarketUnavailable("Market storage is temporarily unavailable.", new Date(now + ttl).toISOString(), "Storage", "storage_unavailable");
      }
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
        ...(failure ? { reason: failure.reason, upstreamStatus: failure.upstreamStatus, causes: failure.causes } : {}),
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
            this.failures.get(key)?.causes,
          ),
        );
      }

      try {
        const data = await read(previous && now - previous.at < MAX_STALE ? previous.data as T : undefined),
          at = this.now();
        try { await this.store.saveSnapshot(key, data, at); }
        catch {
          // The provider data is valid even if persistence fails; keep its actual fetch time.
          const result = { ...present(data, at, false, at + ttl), reason: "storage_unavailable" as const,
            warning: "Snapshot storage is unavailable.", causes: [{ source: "Storage" as const, reason: "storage_unavailable" as const }] };
          this.unpersisted.set(key, { at, data: result });
          this.retryAt.delete(key);
          this.failures.delete(key);
          return result;
        }
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
          failure.causes,
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
