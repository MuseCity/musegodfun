import assert from "node:assert/strict";
import test from "node:test";
import { MUSEGOD } from "../src/lib/musegod";
import { MUSES } from "../src/lib/nft-mode";
import { ROBINHOOD_STOCKS, type RuntimeConfig } from "../src/lib/config";
import { syntheticToken } from "./fixtures";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TokenMarket from "../src/components/TokenMarket";
import { NetworkProvider } from "../src/lib/network";

// Vite supplies this immutable build value in browser bundles.
const previousBuild = Object.getOwnPropertyDescriptor(globalThis, "__BUILD_IDENTITY__");
Object.defineProperty(globalThis, "__BUILD_IDENTITY__", { configurable: true, value: {
  schemaVersion: 1, repository: "https://github.com/test/test", commit: "a".repeat(40),
  source: "local", dirty: true, buildId: null, runUrl: null, releaseUrl: null,
} });
const { exploreTokens, Explore } = await import("../src/App");
if (previousBuild) Object.defineProperty(globalThis, "__BUILD_IDENTITY__", previousBuild);
else Reflect.deleteProperty(globalThis, "__BUILD_IDENTITY__");

const config: RuntimeConfig = {
  mode: "robinhood", chainId: 4663, deploymentChainId: 4663,
  treasury: null, writesEnabled: false, blockReason: "Read-only",
};
const launch = syntheticToken({ name: "AAA launch", symbol: "AAA", mode: "robinhood",
  quoteAddress: MUSEGOD.weth, createdAt: MUSEGOD.createdAt + 10_000 });
const stockLaunch = syntheticToken({ name: "Stock launch", symbol: "STOCK", mode: "robinhood",
  address: "0x3333333333333333333333333333333333333333",
  quoteAddress: ROBINHOOD_STOCKS.find((asset) => asset.ticker === "NVDA")!.address });

test("MUSEGOD is first in the unfiltered view in both sorts without becoming a launch record", () => {
  const records = [launch, stockLaunch];
  for (const order of ["new", "name"] as const) {
    const result = exploreTokens(records, config, "", "all", order);
    assert.equal(result.length, 3);
    assert.equal(result[0].kind, "musegod");
    assert.equal(result[0].address, MUSEGOD.token);
    assert.equal(result[0].quote.ticker, "WETH");
    assert.equal("transactionHash" in result[0], false);
    assert.equal("feePolicy" in result[0], false);
  }
  assert.deepEqual(records, [launch, stockLaunch]);
});

test("search and quote filters include only matches and stop pinning MUSEGOD", () => {
  const records = [launch, stockLaunch];
  const byWeth = exploreTokens(records, config, "", "WETH", "name");
  assert.deepEqual(byWeth.map((entry) => entry.name), [launch.name, MUSEGOD.name]);
  assert.equal(exploreTokens(records, config, "", "NVDA", "new")[0].address, stockLaunch.address);
  assert.equal(exploreTokens(records, config, "MUSEgod", "all", "new")[0].address, MUSEGOD.token);
  assert.equal(exploreTokens(records, config, MUSEGOD.token.toUpperCase(), "all", "new")[0].address, MUSEGOD.token);
  assert.deepEqual(exploreTokens(records, config, "MUSEGOD", "NVDA", "new"), []);
  assert.deepEqual(exploreTokens(records, config, "no match", "all", "new"), []);
  assert.equal(exploreTokens(records, config, "  ", "all", "name")[0].kind, "musegod");
});

test("the featured card survives an empty or unavailable launch catalog and deduplicates its exact address", () => {
  assert.equal(exploreTokens([], config, "", "all", "new").length, 1);
  assert.equal(exploreTokens([], null, "", "all", "new")[0].address, MUSEGOD.token);
  const duplicate = syntheticToken({ ...launch, address: MUSEGOD.token });
  const result = exploreTokens([launch, duplicate], config, "", "all", "new");
  assert.equal(result.length, 2);
  assert.equal(result.filter((entry) => entry.address.toLowerCase() === MUSEGOD.token.toLowerCase()).length, 1);
});

test("MUSEGOD stays within the Robinhood deployment and does not leak into Base views", () => {
  assert.deepEqual(exploreTokens([], { ...config, mode: "base", chainId: 8453, deploymentChainId: 8453 }, "", "all", "new"), []);
  assert.deepEqual(exploreTokens([], { ...config, mode: "fork", chainId: 31337, deploymentChainId: 8453 }, "", "all", "new"), []);
  const result = exploreTokens([], { ...config, mode: "fork", chainId: 31337 }, "", "all", "new");
  assert.equal(result[0].mode, "fork");
});

test("the homepage still renders its local-logo featured card when catalog loading or reads fail", () => {
  for (const state of [{ loading: true, tokenError: "" }, { loading: false, tokenError: "Catalog request failed" }]) {
    const markup = renderToStaticMarkup(createElement(NetworkProvider, null, createElement(Explore, {
      tokens: null, stocks: null, stockError: "", config, refresh: () => {}, ...state,
    })));
    assert.match(markup, /Featured/);
    assert.match(markup, /\/asset-logos\/MUSEGOD.png/);
    assert.match(markup, new RegExp(`/token/robinhood/${MUSEGOD.token}`));
    assert.match(markup, /class="count">1</);
    assert.doesNotMatch(markup, /The first story starts with you/);
    if (state.tokenError) assert.match(markup, /Platform launches could not be loaded: Catalog request failed/);
  }
});

test("Explore counts Muse and NFT coins, leaving out rejected and hidden ones everywhere", () => {
  const musegodQuote = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!.address;
  const nftOf = (contract: `0x${string}`, tokenId: string) => ({ chainId: 4663 as const, contract, tokenId });
  const muse = syntheticToken({ name: "Verified Muse coin", address: "0x5555555555555555555555555555555555555555", mode: "robinhood",
    quoteAddress: musegodQuote, nft: nftOf(MUSES.contract, "1"), nftVerification: { status: "verified" } });
  const rejected = syntheticToken({ name: "Rejected NFT coin", address: "0x6666666666666666666666666666666666666666", mode: "robinhood",
    quoteAddress: MUSEGOD.weth, nft: nftOf("0x9999999999999999999999999999999999999999", "2"), nftVerification: { status: "rejected", reason: "Not an ERC-721" } });
  const hidden = syntheticToken({ name: "Hidden Muse coin", address: "0x7777777777777777777777777777777777777777", mode: "robinhood",
    quoteAddress: musegodQuote, nft: nftOf(MUSES.contract, "3"), nftVerification: { status: "verified" }, hidden: true });
  const markup = renderToStaticMarkup(createElement(NetworkProvider, null, createElement(Explore, {
    tokens: [muse, rejected, hidden], stocks: null, stockError: "", tokenError: "", loading: false, config, refresh: () => {},
  })));
  assert.match(markup, /Muse coins <span class="count">1<\/span>/);
  assert.match(markup, /NFT coins <span class="count">1<\/span>/);
  assert.match(markup, /Verified Muse coin/);
  assert.match(markup, /Rejected NFT coin/, "a rejected coin is still a listed launch, just not an NFT coin");
  assert.doesNotMatch(markup, /Hidden Muse coin/);
  assert.match(markup, /Listed launches<\/dt><dd>2</, "the hidden coin is not counted either");
  assert.match(markup, /Muse #1/);
  assert.doesNotMatch(markup, /Muse #3|NFT #2/);
});

test("MUSEGOD market UI waits for real provenance and preserves minute refresh while launch holders show unavailable", () => {
  const token = { address: MUSEGOD.token, symbol: "MUSEGOD", mode: "robinhood" as const };
  const featured = renderToStaticMarkup(createElement(TokenMarket, { token, kind: "musegod", refreshKey: "" }));
  assert.match(featured, /Source pending/);
  assert.match(featured, /refreshes every minute while visible/);
  assert.doesNotMatch(featured, /Holders/);
  assert.doesNotMatch(featured, /CoinGecko/);
  const native = renderToStaticMarkup(createElement(TokenMarket, { token: launch, refreshKey: "" }));
  assert.match(native, /Holder data unavailable/);
  assert.doesNotMatch(native, /Top 10|indexed holders/);
  assert.match(native, /Source pending/);
  assert.doesNotMatch(native, /CoinGecko/);
});


test("homepage attribution uses row provenance and config loading has its own message", () => {
  for (const selected of [null, config]) {
    const markup = renderToStaticMarkup(createElement(NetworkProvider, null, createElement(Explore, {
      tokens: [launch], stocks: null, stockError: "", tokenError: "", loading: true, config: selected, refresh: () => {},
    })));
    assert.doesNotMatch(markup, /Market data from CoinGecko|shared 15-minute snapshot.*updated/);
    assert.match(markup, selected ? /sources and fetch times appear with each token/ : /Loading market data/);
    if (!selected) assert.doesNotMatch(markup, /Market data is unavailable/);
  }
});

test("Explore list and grid expose per-row states and only attribute displayed provider data", async () => {
  const { registerHooks } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const entry = pathToFileURL(`${process.cwd()}/src/App.tsx`);
  entry.search = `fixture=${crypto.randomUUID()}`;
  const key = `__exploreMarkets${crypto.randomUUID().replaceAll("-", "")}`;
  const fixture: any = { rows: {}, view: "list" };
  const originals = new Map([key, "localStorage", "__BUILD_IDENTITY__"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, key, { configurable: true, value: fixture });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => fixture.view } });
  Object.defineProperty(globalThis, "__BUILD_IDENTITY__", { configurable: true, value: {
    schemaVersion: 1, repository: "https://github.com/test/test", commit: "a".repeat(40), source: "local", dirty: true,
    buildId: null, runUrl: null, releaseUrl: null,
  } });
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier !== "./lib/token-card-market" || context.parentURL !== entry.href) return next(specifier, context);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export const useTokenCardMarkets=()=>globalThis[${JSON.stringify(key)}].rows;`)}` };
  } });
  try {
    const { Explore: View } = await import(entry.href);
    const data = { fetchedAt: "2026-10-15T09:12:00.000Z", source: "CoinGecko", status: "fresh",
      priceUsd: 1, marketCapUsd: null, fdvUsd: 100, liquidityUsd: null, periods: { h24: { change: null, volume: null, buys: null, sells: null } } };
    for (const view of ["list", "grid"]) for (const scenario of ["fresh", "stale", "unavailable", "loading", "bankr"]) {
      fixture.view = view;
      fixture.rows = {
        [launch.address.toLowerCase()]: { data: ["loading", "unavailable"].includes(scenario) ? null
          : { ...data, status: scenario === "stale" ? "stale" : "fresh", source: scenario === "bankr" ? "Bankr" : "CoinGecko" },
          loading: scenario === "loading", error: scenario === "unavailable" ? "Market data unavailable" : "" },
        [MUSEGOD.token.toLowerCase()]: { data: { ...data, source: "Bankr", fetchedAt: "2026-10-15T08:00:00.000Z" }, loading: false, error: "" },
      };
      const markup = renderToStaticMarkup(createElement(NetworkProvider, null, createElement(View, {
        tokens: [launch], stocks: null, stockError: "", tokenError: "", loading: false, config, refresh: () => {},
      })));
      const rows = view === "list" ? markup.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? []
        : markup.match(/<a\b[^>]*class="token-card[^>]*>[\s\S]*?<\/a>/g) ?? [];
      const row = rows.find((row: string) => row.includes(launch.name)) ?? "";
      assert(row, `${view}/${scenario}: ordinary token row exists`);
      const text = row.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      assert.doesNotMatch(text, /\$0|0\.00%/);
      if (scenario === "loading") assert.match(text, /Loading market data/);
      else if (scenario === "unavailable") assert.match(text, /Market data unavailable/);
      else {
        assert.match(row, /datetime="2026-10-15T09:12:00.000Z"/i);
        assert.doesNotMatch(row, /2026-10-15T08:00:00.000Z/);
        assert.match(text, scenario === "stale" ? /Previous snapshot/ : /Fetched/);
        assert.match(text, scenario === "bankr" ? /Bankr \/ Pools/ : /CoinGecko/);
        assert.match(text, /—/); // Fresh null metrics stay unknown, with provenance still visible.
      }
      if (["fresh", "stale"].includes(scenario)) {
        assert.match(markup, /<a href="https:\/\/www.coingecko.com\/en\/api"[^>]*rel="noopener noreferrer"[^>]*>[^<]*CoinGecko/);
      } else assert.doesNotMatch(markup, /www.coingecko.com\/en\/api/);
      assert.doesNotMatch(markup, /shown on each card/);
    }
  } finally {
    hooks.deregister();
    for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); }
  }
});
