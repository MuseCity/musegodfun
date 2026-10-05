import assert from "node:assert/strict";
import test from "node:test";
import { MUSEGOD } from "../src/lib/musegod";
import { ROBINHOOD_STOCKS, type RuntimeConfig } from "../src/lib/config";
import { syntheticToken } from "./fixtures";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TokenMarket from "../src/components/TokenMarket";

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
    const markup = renderToStaticMarkup(createElement(Explore, {
      tokens: null, stocks: null, stockError: "", config, refresh: () => {}, ...state,
    }));
    assert.match(markup, /Featured/);
    assert.match(markup, /\/asset-logos\/MUSEGOD.png/);
    assert.match(markup, new RegExp(`/token/${MUSEGOD.token}`));
    assert.match(markup, /class="count">1</);
    assert.doesNotMatch(markup, /The first story starts with you/);
    if (state.tokenError) assert.match(markup, /Platform launches could not be loaded: Catalog request failed/);
  }
});

test("MUSEGOD market UI credits Bankr and hides holders while launch markets retain holders", () => {
  const token = { address: MUSEGOD.token, symbol: "MUSEGOD", mode: "robinhood" as const };
  const featured = renderToStaticMarkup(createElement(TokenMarket, { token, kind: "musegod", refreshKey: "" }));
  assert.match(featured, /Bankr \/ Pools/);
  assert.doesNotMatch(featured, /Holders/);
  assert.doesNotMatch(featured, /CoinGecko/);
  const native = renderToStaticMarkup(createElement(TokenMarket, { token: launch, refreshKey: "" }));
  assert.match(native, /Holders/);
  assert.match(native, /CoinGecko/);
});
