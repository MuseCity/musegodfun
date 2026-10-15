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

test("endpoint selection batches ordinary Robinhood launches while forks stay isolated", async () => {
  const launch = syntheticToken({ mode: "robinhood", quoteAddress: MUSEGOD.weth });
  const live = cardMarketPlan([launch], robinhood);
  assert.equal(live.musegod, true);
  assert.deepEqual(live.addresses, [launch.address.toLowerCase()]);
  assert.equal(live.rows[launch.address.toLowerCase()].loading, true);
  for (const config of [null, { ...robinhood, mode: "fork" as const, chainId: 31337 }]) {
    const plan = cardMarketPlan([launch], config);
    assert.equal(plan.musegod, false);
    assert.deepEqual(plan.addresses, []);
    let requests = 0;
    assert.deepEqual(await loadCardMarkets(4663, plan.addresses, plan.musegod, async () => {
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
  const result = await loadCardMarkets(8453, [...addresses].reverse().concat(addresses[0].toUpperCase()), false, async <T>(chainId: 8453 | 4663, path: string) => {
    assert.equal(chainId, 8453);
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
  const result = await loadCardMarkets(8453, addresses, false, async <T>() => {
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
  const loading = loadCardMarkets(8453, addresses, false, async <T>() => {
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
  const result = await loadCardMarkets(4663, [], true, async <T>(chainId: 8453 | 4663, path: string) => {
    assert.equal(chainId, 4663);
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

test("market loaders reject requests whose tokens or featured token belong to another chain", async () => {
  let requests = 0;
  const read = async <T>() => { requests++; return summary() as T; };
  await assert.rejects(loadCardMarkets(8453, [], true, read), /selected network/);
  assert.equal((await loadCardMarkets(4663, [address(1)], false, async <T>() => [{address:address(1),summary:summary()}] as T))[address(1)].data?.priceUsd, 0);
  assert.equal(requests, 0);
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
  assert.deepEqual(cardMarketPlan([launch], base).addresses, [launch.address.toLowerCase()]);
  assert.deepEqual(cardMarketPlan([launch], { ...base, chainId: 31337 }).addresses, []);
  assert.deepEqual(cardMarketPlan([launch], { ...base, deploymentChainId: 4663 }).addresses, []);
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


test("card row identity changes on pool/quote while scope stays stable and Robinhood batches preserve row diagnostics", async () => {
  const token=syntheticToken({mode:'robinhood',deploymentChainId:4663});
  assert.equal(cardMarketPlan([token],robinhood).scope,cardMarketPlan([{...token,poolId:`0x${'c'.repeat(64)}`}],robinhood).scope);
  assert.equal(cardMarketPlan([token],robinhood).scope,cardMarketPlan([{...token,quoteAddress:token.address}],robinhood).scope);
  let calls=0;
  const rows=await loadCardMarkets(4663,[token.address],false,async <T>(chain: 8453 | 4663,path: string)=>{calls++;assert.equal(chain,4663);assert(path.startsWith('/market/summaries?'));return [{address:token.address,summary:null,status:'unavailable',reason:'missing_config',source:'CoinGecko'}] as T});
  assert.equal(calls,1);assert.equal(rows[token.address.toLowerCase()].reason,'missing_config');
  assert.equal(rows[token.address.toLowerCase()].error,'Market data unavailable');
});


test("card list changes preserve scope while per-row identities track replaced pools", () => {
  const one = syntheticToken(), two = syntheticToken({ address: address(2) as `0x${string}` });
  const initial = cardMarketPlan([one], base), added = cardMarketPlan([one, two], base);
  assert.equal(initial.scope, added.scope);
  assert.equal(initial.identities[one.address.toLowerCase()], added.identities[one.address.toLowerCase()]);
  assert.notEqual(initial.identities[one.address.toLowerCase()], cardMarketPlan([{ ...one, poolId: `0x${"c".repeat(64)}` }], base).identities[one.address.toLowerCase()]);
});

test("live card hook separates one-minute featured refresh from 15-minute batches and retains rows on additions", async (t) => {
  // Run the actual hook with deterministic React hooks/timers and a controlled API, no DOM or network.
  const { build } = await import("esbuild");
  const slots: any[] = []; let cursor = 0; const pending: (() => void)[] = [];
  const hooks = {
    useState(initial: any) { const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[index].value, (value: any) => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }]; },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(fn: () => any, deps: any[]) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => !Object.is(v, old.deps[i]))) pending.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; }); },
  };
  const requests: string[] = [];
  const launch = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: MUSEGOD.weth });
  let tokens = [launch];
  const fixture = { hooks, read: async (_chain: number, path: string) => {
    requests.push(path);
    const data = summary({ fetchedAt: new Date().toISOString() });
    return path.includes("/musegod/") ? data : tokens.map(token => ({ address: token.address, summary: data }));
  } };
  const fixtureKey = "__cardMarketRun3";
  for (const [key, value] of [[fixtureKey, fixture], ["document", { visibilityState: "visible" }]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const timers = new Map<number, { fn: () => void; ms: number }>(); let timerId = 0;
  t.mock.method(globalThis, "setInterval", ((fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId; }) as never);
  t.mock.method(globalThis, "clearInterval", ((id: number) => timers.delete(id)) as never);
  t.mock.method(globalThis, "setTimeout", (() => 0) as never);
  const { outputFiles } = await build({ bundle: true, write: false, format: "esm", platform: "node", entryPoints: ["src/lib/token-card-market.ts"],
    plugins: [{ name: "controlled-hooks", setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "fixture" }));
      build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: "api", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "react"
        ? `export const {useState,useRef,useEffect} = globalThis.${fixtureKey}.hooks;`
        : `export const chainApi = (...args) => globalThis.${fixtureKey}.read(...args);` }));
    } }] });
  const { useTokenCardMarkets: hook } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
  const render = () => { cursor = 0; const rows = hook(tokens, robinhood, 0); while (pending.length) pending.shift()!(); return rows; };
  try {
    render(); await Promise.resolve(); await Promise.resolve(); render();
    const baseline = requests.length;
    assert.equal(baseline, 2); assert.deepEqual([...timers.values()].map(t => t.ms).sort((a,b)=>a-b), [60_000, 900_000]);
    [...timers.values()].find(t => t.ms === 60_000)!.fn(); render(); await Promise.resolve(); await Promise.resolve(); render();
    assert.deepEqual(requests.slice(baseline), ["/musegod/market/summary"]);
    const before = render()[launch.address.toLowerCase()].data;
    tokens = [launch, syntheticToken({ ...launch, address: address(3) as `0x${string}` })];
    const added = render(); assert.equal(added[launch.address.toLowerCase()].data, before);
    await Promise.resolve(); await Promise.resolve(); render();
    const index = requests.length; [...timers.values()].find(t => t.ms === 900_000)!.fn(); render();
    await Promise.resolve(); await Promise.resolve(); render();
    assert.equal(requests.length, index + 1); assert(requests.at(-1)!.startsWith("/market/summaries"));
    tokens = [{ ...launch, poolId: `0x${"c".repeat(64)}` }];
    assert.equal(render()[launch.address.toLowerCase()].data, null, "only the changed identity resets immediately");
  } finally { for (const slot of slots) slot?.cleanup?.(); }
});
