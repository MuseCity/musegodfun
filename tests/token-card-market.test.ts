import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type RuntimeConfig } from "../src/lib/config";
import type { MarketSummary } from "../src/lib/market";
import { MUSEGOD } from "../src/lib/musegod";
import {
  cardMarketPlan, expireCardMarkets, loadCardMarkets, retainCardMarket,
  useTokenCardMarkets, type CardMarketState,
} from "../src/lib/token-card-market";
import { syntheticToken } from "./fixtures";

const NOW = Date.parse("2026-10-05T09:00:00.000Z");
const MAX_AGE = 24 * 60 * 60_000;
const robinhood: RuntimeConfig = {
  mode: "robinhood", chainId: 4663, deploymentChainId: 4663,
  treasury: null, writesEnabled: false, blockReason: null,
};
const base: RuntimeConfig = { ...robinhood, mode: "base", chainId: 8453, deploymentChainId: 8453 };
const summary = (patch: Partial<MarketSummary> = {}): MarketSummary => ({
  fetchedAt: new Date(NOW).toISOString(), source: "Bankr", status: "fresh",
  priceUsd: 0, fdvUsd: null, marketCapUsd: 0, liquidityUsd: null,
  periods: { h24: { change: 0, volume: 0, buys: 0, sells: null } }, ...patch,
});
const state = (data: MarketSummary | null): CardMarketState => ({ data, loading: false, error: "" });
const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;

test("endpoint selection excludes Robinhood launches, forks and unconfirmed runtime", async () => {
  const launch = syntheticToken({ mode: "robinhood", quoteAddress: MUSEGOD.weth });
  const live = cardMarketPlan([launch], robinhood);
  assert.equal(live.musegod, true);
  assert.deepEqual(live.baseAddresses, []);
  assert.equal(live.rows[launch.address.toLowerCase()].error, "Market data unavailable");
  for (const config of [null, { ...robinhood, mode: "fork" as const, chainId: 31337 }]) {
    const plan = cardMarketPlan([launch], config);
    assert.equal(plan.musegod, false);
    assert.deepEqual(plan.baseAddresses, []);
    let requests = 0;
    assert.deepEqual(await loadCardMarkets(plan.baseAddresses, plan.musegod, async () => {
      requests++; throw new Error("Unexpected request");
    }), {});
    assert.equal(requests, 0);
    assert.equal(plan.rows[MUSEGOD.token.toLowerCase()].error, config ? "Fork test" : "");
    assert.equal(plan.rows[MUSEGOD.token.toLowerCase()].loading, config === null);
  }
});

test("Base uses stable deduplicated 30-address batches serially and isolates failed rows", async () => {
  const addresses = Array.from({ length: 31 }, (_, index) => address(index + 1));
  const paths: string[] = [];
  let inFlight = 0;
  const result = await loadCardMarkets([...addresses].reverse().concat(addresses[0].toUpperCase()), false, async <T>(path: string) => {
    assert.equal(inFlight, 0, "batches must run serially");
    inFlight++;
    paths.push(path);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const batch = new URL(`https://local.invalid${path}`).searchParams.get("addresses")!.split(",");
    assert(batch.length <= 30);
    inFlight--;
    return batch.map((value) => ({ address: value.toUpperCase(), summary: value === addresses[4] ? null : summary() })) as T;
  });
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map((path) => new URL(`https://local.invalid${path}`).searchParams.get("addresses")!.split(",").length), [30, 1]);
  assert.equal(Object.keys(result).length, 31);
  assert.equal(result[addresses[4]].data, null);
  assert.equal(result[addresses[4]].error, "Market data unavailable");
  assert.equal(result[addresses[0]].data?.marketCapUsd, 0);
  assert.equal(result[addresses[30]].data?.periods.h24.volume, 0);
});

test("a failed batch leaves later registered pools available and ignores unexpected returned addresses", async () => {
  const addresses = Array.from({ length: 31 }, (_, index) => address(index + 1));
  let calls = 0;
  const result = await loadCardMarkets(addresses, false, async <T>() => {
    if (++calls === 1) throw new Error("Provider unavailable");
    return [{ address: addresses[30], summary: summary() }, { address: address(1000), summary: summary() }] as T;
  });
  assert.equal(calls, 2);
  assert.equal(result[addresses[0]].error, "Provider unavailable");
  assert.equal(result[addresses[30]].data?.marketCapUsd, 0);
  assert.equal(result[address(1000)], undefined);
});

test("cancelling a delayed Base request stops the next batch and discards its late result", async () => {
  const addresses = Array.from({ length: 31 }, (_, index) => address(index + 1));
  let active = true;
  let requests = 0;
  let release: (rows: { address: string; summary: MarketSummary }[]) => void = () => {};
  const delayed = new Promise<{ address: string; summary: MarketSummary }[]>((resolve) => { release = resolve; });
  const loading = loadCardMarkets(addresses, false, async <T>() => {
    requests++;
    return await delayed as T;
  }, () => active);
  assert.equal(requests, 1);
  active = false;
  release(addresses.slice(0, 30).map((value) => ({ address: value, summary: summary() })));
  assert.deepEqual(await loading, {});
  assert.equal(requests, 1, "cancelled scope must not start the second batch");
});

test("MUSEGOD uses the fixed same-origin summary and preserves missing values and true zero", async () => {
  const paths: string[] = [];
  const result = await loadCardMarkets([], true, async <T>(path: string) => {
    paths.push(path);
    return summary() as T;
  });
  assert.deepEqual(paths, ["/musegod/market/summary"]);
  const market = result[MUSEGOD.token.toLowerCase()].data!;
  assert.equal(market.fdvUsd, null);
  assert.equal(market.liquidityUsd, null);
  assert.equal(market.marketCapUsd, 0);
  assert.equal(market.periods.h24.change, 0);
});

test("refresh keeps valid snapshot, failure labels it stale, and the 24-hour boundary clears it", () => {
  const original = state(summary());
  const pending: CardMarketState = { data: null, loading: true, error: "" };
  assert.equal(retainCardMarket(original, pending, NOW + 1).data, original.data);
  const failed: CardMarketState = { data: null, loading: false, error: "Network unavailable" };
  const retained = retainCardMarket(original, failed, NOW + MAX_AGE - 1);
  assert.equal(retained.data?.status, "stale");
  assert.equal(retained.data?.fetchedAt, original.data?.fetchedAt);
  assert.equal(retained.data?.warning, failed.error);
  assert.equal(retainCardMarket(original, failed, NOW + MAX_AGE).data, null);
  assert.equal(retainCardMarket(undefined, failed, NOW).data, null);
  assert.equal(retainCardMarket(state(summary({ fetchedAt: "invalid" })), failed, NOW).data, null);
  const rows = { [MUSEGOD.token.toLowerCase()]: retained };
  assert.equal(expireCardMarkets(rows, NOW + MAX_AGE - 1), rows);
  assert.equal(expireCardMarkets(rows, NOW + MAX_AGE)[MUSEGOD.token.toLowerCase()].data, null);
});

test("runtime scope separates networks and initial hook output never claims an available snapshot", () => {
  const launch = syntheticToken();
  assert.notEqual(cardMarketPlan([launch], base).scope, cardMarketPlan([launch], robinhood).scope);
  assert.notEqual(cardMarketPlan([launch], base).scope, cardMarketPlan([launch], { ...base, mode: "fork", chainId: 31337 }).scope);
  assert.deepEqual(cardMarketPlan([launch], base).baseAddresses, [launch.address.toLowerCase()]);
  assert.deepEqual(cardMarketPlan([launch], { ...base, chainId: 31337 }).baseAddresses, []);
  assert.deepEqual(cardMarketPlan([launch], { ...base, deploymentChainId: 4663 }).baseAddresses, []);
  function View({ config }: { config: RuntimeConfig | null }) {
    const rows = useTokenCardMarkets(null, config, 0);
    return createElement("pre", null, JSON.stringify(rows[MUSEGOD.token.toLowerCase()]));
  }
  const initial = renderToStaticMarkup(createElement(View, { config: null }));
  assert.match(initial, /&quot;data&quot;:null/);
  assert.match(initial, /&quot;loading&quot;:true/);
  const fork = renderToStaticMarkup(createElement(View, { config: { ...robinhood, mode: "fork", chainId: 31337 } }));
  assert.match(fork, /Fork test/);
  assert.match(fork, /&quot;loading&quot;:false/);
});
