import { useEffect, useRef, useState } from "react";
import { chainApi } from "./api";
import { deploymentChain, type RuntimeConfig, type TokenRecord } from "./config";
import { marketSnapshotKey, marketStatusMessage, type MarketSummary, type MarketReason } from "./market";
import { MUSEGOD } from "./musegod";
import { errorMessage } from "./validation";

export type CardMarketState = {
  data: MarketSummary | null;
  loading: boolean;
  error: string;
  reason?: MarketReason;
};
type CardMarkets = Record<string, CardMarketState>;
type MarketStore = { scope: string | null; rows: CardMarkets; identities: Record<string, string> };
type MarketPlan = {
  scope: string | null;
  rows: CardMarkets;
  addresses: string[];
  musegod: boolean;
  identities: Record<string, string>;
};
type SummaryReader = typeof chainApi;
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
  const identities = Object.fromEntries(tokens.map(token => [token.address.toLowerCase(), marketSnapshotKey(token, "summary")]));
  const scope = config ? `${config.mode}:${config.chainId}:${deploymentChain(config)}` : null;
  const rows: CardMarkets = {};
  const addresses: string[] = [];
  for (const token of tokens) {
    const address = token.address.toLowerCase();
    if (config && config.mode !== "fork" && token.mode === config.mode && config.chainId === deploymentChain(config)
      && deploymentChain(token) === deploymentChain(config)) {
      rows[address] = waiting();
      addresses.push(address);
    } else {
      rows[address] = config === null ? waiting()
        : unavailable(config.mode === "fork" ? "Fork test" : undefined);
    }
  }
  const featured = config === null || deploymentChain(config) === 4663;
  const musegod = config?.mode === "robinhood" && config.chainId === 4663;
  if (featured) identities[MUSEGOD_ADDRESS] = `musegod:4663:${MUSEGOD.pool}:${MUSEGOD.weth}`;
  if (featured) rows[MUSEGOD_ADDRESS] = config === null || musegod ? waiting()
    : unavailable(config.mode === "fork" ? "Fork test" : undefined);
  return { scope, rows, identities, addresses: [...new Set(addresses)].sort(), musegod };
}

// The existing endpoint admits at most 30 registered addresses per request.
export async function loadCardMarkets(
  chainId: 8453 | 4663, addresses: string[], musegod: boolean, read: SummaryReader = chainApi,
  isActive: () => boolean = () => true,
): Promise<CardMarkets> {
  const rows: CardMarkets = {};
  if (!isActive()) return rows;
  if (musegod && chainId !== 4663)
    throw new Error("The market request does not match the selected network");
  if (musegod) {
    try {
      const data = await read<MarketSummary>(4663, "/musegod/market/summary");
      if (!isActive()) return rows;
      rows[MUSEGOD_ADDRESS] = { data, loading: false, error: "" };
    } catch (error) {
      if (!isActive()) return rows;
      rows[MUSEGOD_ADDRESS] = unavailable(errorMessage(error));
    }
  }
  const uniqueAddresses = [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
  for (let offset = 0; offset < uniqueAddresses.length; offset += 30) {
    if (!isActive()) return rows;
    const batch = uniqueAddresses.slice(offset, offset + 30);
    try {
      const result = await read<{ address: string; summary: MarketSummary | null; reason?: MarketReason }[]>(
        chainId,
        `/market/summaries?addresses=${encodeURIComponent(batch.join(","))}`,
      );
      if (!isActive()) return rows;
      const received = new Map(result.map((row) => [row.address.toLowerCase(), row]));
      for (const address of batch) {
        const row = received.get(address), data = row?.summary;
        rows[address] = data ? { data, loading: false, error: "" } : { ...unavailable(marketStatusMessage(row?.reason)), reason: row?.reason };
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
  const [store, setStore] = useState<MarketStore>(() => ({ scope: plan.scope, rows: plan.rows, identities: plan.identities }));
  const [batchRevision, setBatchRevision] = useState(0);
  const [featuredRevision, setFeaturedRevision] = useState(0);
  const scope = plan.scope;
  const identityKey = Object.entries(plan.identities).sort().map(([address, identity]) => `${address}:${identity}`).join(",");
  const addressKey = config !== null && tokens !== null ? plan.addresses.join(",") : "";
  const requestMusegod = config !== null && plan.musegod;

  useEffect(() => {
    setStore((previous) => ({ scope, identities: plan.identities, rows: Object.fromEntries(Object.entries(plan.rows).map(([address, state]) => [
      address, state.loading && previous.scope === scope && previous.identities[address] === plan.identities[address]
        ? previous.rows[address] ?? state : state,
    ])) }));
  }, [scope, identityKey]);

  // Registered batches and the fixed featured asset have independent request lifecycles.
  useEffect(() => {
    if (!addressKey) return;
    let active = true;
    const addresses = addressKey.split(",");
    setStore(previous => ({ ...previous, rows: Object.fromEntries(Object.entries(previous.rows).map(([address, state]) => [
      address, addresses.includes(address) ? retainCardMarket(state, waiting()) : state,
    ])) }));
    void loadCardMarkets(deploymentChain(config!), addresses, false, chainApi, () => active).then(result => {
      if (!active) return;
      setStore(previous => {
        if (previous.scope !== scope) return previous;
        const rows = { ...previous.rows };
        for (const [address, state] of Object.entries(result)) {
          if (previous.identities[address] === plan.identities[address]) rows[address] = retainCardMarket(rows[address], state);
        }
        return { ...previous, rows };
      });
    });
    return () => { active = false; };
  }, [scope, identityKey, addressKey, refreshVersion, batchRevision]);

  useEffect(() => {
    if (!requestMusegod) return;
    let active = true;
    setStore(previous => ({ ...previous, rows: { ...previous.rows,
      [MUSEGOD_ADDRESS]: retainCardMarket(previous.rows[MUSEGOD_ADDRESS], waiting()),
    } }));
    void loadCardMarkets(4663, [], true, chainApi, () => active).then(result => {
      if (!active) return;
      setStore(previous => previous.scope !== scope ? previous : { ...previous, rows: { ...previous.rows,
        [MUSEGOD_ADDRESS]: retainCardMarket(previous.rows[MUSEGOD_ADDRESS], result[MUSEGOD_ADDRESS]),
      } });
    });
    return () => { active = false; };
  }, [scope, requestMusegod, refreshVersion, featuredRevision]);

  useEffect(() => {
    if (!config || !addressKey) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setBatchRevision(value => value + 1);
    }, 15 * 60_000);
    return () => clearInterval(timer);
  }, [config !== null, scope, addressKey]);

  useEffect(() => {
    if (!requestMusegod) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setFeaturedRevision(value => value + 1);
    }, 60_000);
    return () => clearInterval(timer);
  }, [scope, requestMusegod]);

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
    address, state.loading && store.identities[address] === plan.identities[address] ? store.rows[address] ?? state : state,
  ]));
}
