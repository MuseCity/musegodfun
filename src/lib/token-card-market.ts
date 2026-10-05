import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { deploymentChain, type RuntimeConfig, type TokenRecord } from "./config";
import type { MarketSummary } from "./market";
import { MUSEGOD } from "./musegod";
import { errorMessage } from "./validation";

export type CardMarketState = {
  data: MarketSummary | null;
  loading: boolean;
  error: string;
};
type CardMarkets = Record<string, CardMarketState>;
type MarketStore = { scope: string | null; rows: CardMarkets };
type MarketPlan = {
  scope: string | null;
  rows: CardMarkets;
  baseAddresses: string[];
  musegod: boolean;
};
type SummaryReader = <T>(path: string) => Promise<T>;
const MAX_AGE = 24 * 60 * 60_000;
const MUSEGOD_ADDRESS = MUSEGOD.token.toLowerCase();
const unavailable = (error = "Market data unavailable"): CardMarketState => ({
  data: null, loading: false, error,
});
const waiting = (): CardMarketState => ({ data: null, loading: true, error: "" });
const validSnapshot = (data: MarketSummary | null, now: number) =>
  data !== null && data.status !== "unavailable" &&
  Number.isFinite(Date.parse(data.fetchedAt)) && now - Date.parse(data.fetchedAt) < MAX_AGE;

// Keep endpoint selection separate from presentation and from launch records.
export function cardMarketPlan(tokens: TokenRecord[], config: RuntimeConfig | null): MarketPlan {
  const scope = config ? `${config.mode}:${config.chainId}:${deploymentChain(config)}` : null;
  const rows: CardMarkets = {};
  const baseAddresses: string[] = [];
  for (const token of tokens) {
    const address = token.address.toLowerCase();
    if (config?.mode === "base" && config.chainId === 8453 && deploymentChain(config) === 8453 && token.mode === "base") {
      rows[address] = waiting();
      baseAddresses.push(address);
    } else {
      rows[address] = config === null ? waiting()
        : unavailable(config.mode === "fork" ? "Fork test" : undefined);
    }
  }
  const featured = config === null || deploymentChain(config) === 4663;
  const musegod = config?.mode === "robinhood" && config.chainId === 4663;
  if (featured) rows[MUSEGOD_ADDRESS] = config === null || musegod ? waiting()
    : unavailable(config.mode === "fork" ? "Fork test" : undefined);
  return { scope, rows, baseAddresses: [...new Set(baseAddresses)].sort(), musegod };
}

// The existing endpoint admits at most 30 registered addresses per request.
export async function loadCardMarkets(
  baseAddresses: string[], musegod: boolean, read: SummaryReader = api,
  isActive: () => boolean = () => true,
): Promise<CardMarkets> {
  const rows: CardMarkets = {};
  if (!isActive()) return rows;
  if (musegod) {
    try {
      const data = await read<MarketSummary>("/musegod/market/summary");
      if (!isActive()) return rows;
      rows[MUSEGOD_ADDRESS] = { data, loading: false, error: "" };
    } catch (error) {
      if (!isActive()) return rows;
      rows[MUSEGOD_ADDRESS] = unavailable(errorMessage(error));
    }
  }
  const addresses = [...new Set(baseAddresses.map((address) => address.toLowerCase()))].sort();
  for (let offset = 0; offset < addresses.length; offset += 30) {
    if (!isActive()) return rows;
    const batch = addresses.slice(offset, offset + 30);
    try {
      const result = await read<{ address: string; summary: MarketSummary | null }[]>(
        `/market/summaries?addresses=${encodeURIComponent(batch.join(","))}`,
      );
      if (!isActive()) return rows;
      const received = new Map(result.map((row) => [row.address.toLowerCase(), row.summary]));
      for (const address of batch) {
        const data = received.get(address);
        rows[address] = data ? { data, loading: false, error: "" } : unavailable();
      }
    } catch (error) {
      if (!isActive()) return rows;
      for (const address of batch) rows[address] = unavailable(errorMessage(error));
    }
  }
  return rows;
}

export function retainCardMarket(
  previous: CardMarketState | undefined, next: CardMarketState, now = Date.now(),
): CardMarketState {
  if (validSnapshot(next.data, now)) return next;
  if (validSnapshot(previous?.data ?? null, now)) {
    return {
      ...next,
      data: next.loading ? previous!.data : {
        ...previous!.data!, status: "stale", warning: next.error || "Market data unavailable",
      },
    };
  }
  return { ...next, data: null, error: next.loading ? "" : next.error || "Market data unavailable" };
}

export function expireCardMarkets(rows: CardMarkets, now = Date.now()): CardMarkets {
  let changed = false;
  const expired = Object.fromEntries(Object.entries(rows).map(([address, state]) => {
    if (state.data && !validSnapshot(state.data, now)) {
      changed = true;
      return [address, { ...state, data: null, error: state.error || "Market data unavailable" }];
    }
    return [address, state];
  }));
  return changed ? expired : rows;
}

export function useTokenCardMarkets(
  tokens: TokenRecord[] | null, config: RuntimeConfig | null, refreshVersion: number,
): CardMarkets {
  const confirmedConfig = useRef<RuntimeConfig | null>(null);
  const knownTokens = useRef<TokenRecord[]>([]);
  if (config !== null) confirmedConfig.current = config;
  if (tokens !== null) knownTokens.current = tokens;
  const displayConfig = config ?? confirmedConfig.current;
  const plan = cardMarketPlan(tokens ?? knownTokens.current, displayConfig);
  const [store, setStore] = useState<MarketStore>(() => ({ scope: plan.scope, rows: plan.rows }));
  const [revision, setRevision] = useState(0);
  const scope = plan.scope;
  const targetKey = Object.keys(plan.rows).sort().join(",");
  const baseKey = config !== null && tokens !== null ? plan.baseAddresses.join(",") : "";
  const requestMusegod = config !== null && plan.musegod;

  useEffect(() => {
    let active = true;
    setStore((previous) => ({ scope, rows: Object.fromEntries(Object.entries(plan.rows).map(([address, state]) => [
      address, state.loading && previous.scope === scope
        ? retainCardMarket(previous.rows[address], state) : state,
    ])) }));
    if (baseKey || requestMusegod) {
      void loadCardMarkets(baseKey ? baseKey.split(",") : [], requestMusegod, api, () => active).then((result) => {
        if (!active) return;
        setStore((previous) => {
          if (previous.scope !== scope) return previous;
          const rows = { ...previous.rows };
          for (const [address, state] of Object.entries(result)) {
            rows[address] = retainCardMarket(rows[address], state);
          }
          return { scope, rows };
        });
      });
    }
    return () => { active = false; };
  }, [scope, targetKey, baseKey, requestMusegod, refreshVersion, revision]);

  useEffect(() => {
    if (!config || (!baseKey && !requestMusegod)) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    }, requestMusegod ? 60_000 : 15 * 60_000);
    return () => clearInterval(timer);
  }, [config !== null, scope, baseKey, requestMusegod]);

  useEffect(() => {
    const expiries = Object.values(store.rows).flatMap((state) =>
      state.data ? [Date.parse(state.data.fetchedAt) + MAX_AGE] : [],
    );
    if (!expiries.length) return;
    const timer = setTimeout(() => setStore((previous) => ({
      ...previous, rows: expireCardMarkets(previous.rows),
    })), Math.max(0, Math.min(...expiries) - Date.now()));
    return () => clearTimeout(timer);
  }, [store]);

  // A deployment switch must not expose even one render of the previous network.
  if (store.scope !== scope) return plan.rows;
  return Object.fromEntries(Object.entries(plan.rows).map(([address, state]) => [
    address, state.loading ? store.rows[address] ?? state : state,
  ]));
}
