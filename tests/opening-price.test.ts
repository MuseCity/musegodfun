import assert from "node:assert/strict";
import test from "node:test";
import { type PublicClient } from "viem";
import { ROBINHOOD_STOCKS, STOCKS, type Stock } from "../src/lib/config";
import { LAUNCH_PRICE_TTL, OPENING_CAP_USD, OPENING_POLICY } from "../src/lib/opening-valuation";
import { readOpeningValuation } from "../server/opening-price";

const NOW = Date.UTC(2026, 9, 5, 3, 0, 30);
const BLOCK = 80453001n;
const HASH = `0x${"ab".repeat(32)}` as const;
const ETH_FEED = "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9";
const USDG_FEED = "0x61b7e5650328764b076a108eff5fa7282a1b9ad2";
const CBBTC_FEED = "0x0009cd492adf8167f9eebf1293556a673530a21a";
const POOL = "0x071ee139277688d64b139af1e44f79a9acf12e53";
const FACTORY = "0xe51960f1b45f1c9fb6d166e6a884f866fc70433b";
const asset = (symbol: string) => ROBINHOOD_STOCKS.find((row) => row.symbol === symbol)!;
const WETH = asset("WETH").address;
const MUSEGOD = asset("MUSEGOD").address;
type Call = { address: string; functionName: string; blockNumber: bigint; args?: readonly unknown[] };

function fixture(selected: Stock = asset("NVDA")) {
  const calls: Call[] = [];
  const blockCalls: { blockTag?: string; blockNumber?: bigint }[] = [];
  const overrides = new Map<string, unknown>();
  const seconds = BigInt(NOW / 1000);
  const state = { now: NOW, blockTime: seconds - 9n, multiplier: 1_250_000_000_000_000_000n, confirmedHash: HASH as string };
  const quote = { tokenSymbol: selected.symbol, deployments: [{ chainId: 4663, contractAddress: selected.address }],
    currency: "USD", bid: "12.345678901234567890", ask: "12.345678901234567892",
    generatedAt: new Date(NOW - 15_000).toISOString(), isTradingHalt: false };
  const registry = { tokenSymbol: selected.symbol, deployments: [{ chainId: 4663, contractAddress: selected.address }],
    status: "ASSET_STATUS_ACTIVE", currentMultiplier: "1.250000000000000000" };
  const set = (address: string, name: string, value: unknown) => overrides.set(`${address.toLowerCase()}:${name}`, value);
  const client = {
    async getBlock(options: { blockTag?: string; blockNumber?: bigint }) {
      blockCalls.push(options);
      if (options.blockNumber !== undefined) assert.equal(options.blockNumber, BLOCK);
      else assert.equal(options.blockTag, "latest");
      return { number: BLOCK, hash: options.blockNumber !== undefined ? state.confirmedHash : HASH, timestamp: state.blockTime };
    },
    async readContract(call: Call) {
      assert.equal(call.blockNumber, BLOCK, "every contract read must use the locked block");
      calls.push(call);
      const overrideKey = `${call.address.toLowerCase()}:${call.functionName}`;
      if (overrides.has(overrideKey)) {
        const value = overrides.get(overrideKey);
        if (value instanceof Error) throw value;
        return value;
      }
      if (call.functionName === "symbol") return ROBINHOOD_STOCKS.find((item) => item.address.toLowerCase() === call.address.toLowerCase())!.symbol;
      if (call.functionName === "decimals") return [ETH_FEED, USDG_FEED, CBBTC_FEED].includes(call.address.toLowerCase())
        ? 8 : ROBINHOOD_STOCKS.find((item) => item.address.toLowerCase() === call.address.toLowerCase())!.decimals;
      if (call.functionName === "uiMultiplier") return state.multiplier;
      if (call.functionName === "oraclePaused") return false;
      if (call.functionName === "latestRoundData") return [10n, 300_000_000_000n, seconds - 30n, seconds - 30n, 10n];
      if (call.functionName === "token0") return MUSEGOD;
      if (call.functionName === "token1") return WETH;
      if (call.functionName === "factory") return FACTORY;
      if (call.functionName === "fee") return 10_000;
      if (call.functionName === "liquidity") return 123n;
      if (call.functionName === "slot0") return [1n << 96n, -1, 5, 1000, 1000, 0, true];
      if (call.functionName === "getPool") {
        assert.deepEqual(call.args, [MUSEGOD, WETH, 10_000]);
        return POOL;
      }
      if (call.functionName === "observe") {
        assert.deepEqual(call.args, [[300, 0]]);
        return [[0n, -1n], [10n, 20n]];
      }
      throw new Error(`Unexpected contract function ${call.functionName}`);
    },
  } as unknown as PublicClient;
  const fetched: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    fetched.push(url);
    assert.ok(options?.signal, "upstream REST requests must have a timeout signal");
    return Response.json(url.includes("/prices/") ? { quotes: [quote] } : { assets: [registry] });
  };
  return { client, calls, blockCalls, fetched, state, quote, registry, set,
    deps: { fetch: fetcher, now: () => state.now } };
}

test("Robinhood locks the exact adjusted midpoint without losing decimal precision", async () => {
  const f = fixture();
  const result = await readOpeningValuation(f.client, asset("NVDA"), 4663, f.deps);
  assert.equal(result.quotePriceUsd, "15.432098626543209863");
  assert.equal(result.policy, OPENING_POLICY);
  assert.equal(result.marketCapUsd, OPENING_CAP_USD);
  assert.equal(result.quotedAt, NOW);
  assert.equal(result.expiresAt, NOW + LAUNCH_PRICE_TTL);
  assert.equal(result.blockNumber, BLOCK.toString());
  assert.equal(result.blockHash, HASH);
  assert.equal(result.sourceUpdatedAt, NOW - 15_000);
  assert.equal(result.source, "Robinhood");
  assert.equal(result.quoteAddress, asset("NVDA").address);
  assert.equal(f.fetched.length, 2);
  assert.deepEqual(f.blockCalls, [{ blockTag: "latest" }, { blockNumber: BLOCK }]);
});

test("a same-height reorganization cannot return the old block hash with newly read prices", async () => {
  for (const symbol of ["NVDA", "WETH", "MUSEGOD"]) {
    const f = fixture(asset(symbol));
    f.state.confirmedHash = `0x${"cd".repeat(32)}`;
    await assert.rejects(() => readOpeningValuation(f.client, asset(symbol), 4663, f.deps), /opening price block changed/);
    assert.deepEqual(f.blockCalls, [{ blockTag: "latest" }, { blockNumber: BLOCK }]);
    assert.ok(f.calls.every((call) => call.blockNumber === BLOCK));
  }
});

test("opening valuation refuses Base issuance and altered whitelist identities before making requests", async () => {
  const f = fixture();
  await assert.rejects(() => readOpeningValuation(f.client, STOCKS[0], 8453, f.deps), /only configured for Robinhood/);
  await assert.rejects(() => readOpeningValuation(f.client, { ...asset("NVDA"), symbol: "AAPL" }, 4663, f.deps), /verified Robinhood asset list/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.fetched.length, 0);
});

test("Robinhood rejects cross-chain or cross-address quotes and inactive source assets", async () => {
  for (const fault of ["chain", "address", "symbol", "inactive", "currency", "halt"] as const) {
    const f = fixture();
    if (fault === "chain") f.quote.deployments[0].chainId = 8453;
    if (fault === "address") f.quote.deployments[0].contractAddress = asset("AAPL").address;
    if (fault === "symbol") f.quote.tokenSymbol = "AAPL";
    if (fault === "inactive") f.registry.status = "ASSET_STATUS_INACTIVE";
    if (fault === "currency") f.quote.currency = "EUR";
    if (fault === "halt") f.quote.isTradingHalt = true;
    await assert.rejects(() => readOpeningValuation(f.client, asset("NVDA"), 4663, f.deps), /active verified paired asset/, fault);
  }
});

test("Robinhood rejects stale or future quotes, multiplier mismatches, pauses and reversed spreads", async () => {
  for (const fault of ["stale", "future", "multiplier", "paused", "spread", "zero", "scientific"] as const) {
    const f = fixture();
    if (fault === "stale") f.quote.generatedAt = new Date(NOW - 60_001).toISOString();
    if (fault === "future") f.quote.generatedAt = new Date(NOW + 1).toISOString();
    if (fault === "multiplier") f.registry.currentMultiplier = "1.25";
    if (fault === "multiplier") f.state.multiplier += 1n;
    if (fault === "paused") f.set(asset("NVDA").address, "oraclePaused", true);
    if (fault === "spread") f.quote.ask = "1";
    if (fault === "zero") f.quote.bid = "0";
    if (fault === "scientific") f.quote.bid = "1e2";
    await assert.rejects(() => readOpeningValuation(f.client, asset("NVDA"), 4663, f.deps),
      /stale|multiplier changed|paused|bid and ask|positive|invalid decimal/, fault);
  }
});

test("the latest block must be fresh when captured and when the final snapshot is locked", async () => {
  const stale = fixture();
  stale.state.blockTime = BigInt((NOW - 61_000) / 1000);
  await assert.rejects(() => readOpeningValuation(stale.client, asset("NVDA"), 4663, stale.deps), /block is stale/);
  assert.equal(stale.calls.length, 0);
  const delayed = fixture();
  const fetcher: typeof fetch = async (input, options) => {
    const response = await delayed.deps.fetch(input, options);
    delayed.state.now = NOW + 55_000;
    delayed.quote.generatedAt = new Date(delayed.state.now).toISOString();
    return String(input).includes("/prices/") ? Response.json({ quotes: [delayed.quote] }) : response;
  };
  await assert.rejects(() => readOpeningValuation(delayed.client, asset("NVDA"), 4663,
    { ...delayed.deps, fetch: fetcher }), /block is stale/);
});

test("a source that expires while being read cannot produce a fresh five-minute preview", async () => {
  const stock = fixture();
  let stockClockReads = 0;
  await assert.rejects(() => readOpeningValuation(stock.client, asset("NVDA"), 4663,
    { ...stock.deps, now: () => ++stockClockReads <= 2 ? NOW : NOW + 50_000 }), /USD price is stale/);
  const crypto = fixture(asset("WETH"));
  const updatedAt = BigInt(NOW / 1000 - 86_400 + 10);
  crypto.set(ETH_FEED, "latestRoundData", [10n, 1n, updatedAt, updatedAt, 10n]);
  let cryptoClockReads = 0;
  await assert.rejects(() => readOpeningValuation(crypto.client, asset("WETH"), 4663,
    { ...crypto.deps, now: () => ++cryptoClockReads === 1 ? NOW : NOW + 20_000 }), /USD price is stale/);
});

test("crypto prices use their own pinned feed, actual decimals and no stablecoin one-dollar assumption", async () => {
  for (const [symbol, feed] of [["WETH", ETH_FEED], ["USDG", USDG_FEED], ["cbBTC", CBBTC_FEED]]) {
    const f = fixture(asset(symbol));
    f.set(feed, "decimals", 6);
    f.set(feed, "latestRoundData", [11n, 1_000_148n, BigInt(NOW / 1000 - 20), BigInt(NOW / 1000 - 20), 11n]);
    const price = await readOpeningValuation(f.client, asset(symbol), 4663, f.deps);
    assert.equal(price.quotePriceUsd, "1.000148");
    assert.equal(price.feed!.toLowerCase(), feed);
    assert.equal(price.source, "Chainlink");
    assert.equal(f.fetched.length, 0);
  }
});

test("Chainlink rejects stale, incomplete, nonpositive and future rounds", async () => {
  const seconds = BigInt(NOW / 1000);
  for (const round of [
    [10n, 1n, 1n, seconds - 86_410n, 10n],
    [10n, 1n, seconds, seconds - 9n, 9n],
    [10n, 0n, seconds, seconds - 9n, 10n],
    [10n, -1n, seconds, seconds - 9n, 10n],
    [10n, 1n, seconds, seconds, 10n],
  ]) {
    const f = fixture(asset("WETH"));
    f.set(ETH_FEED, "latestRoundData", round);
    await assert.rejects(() => readOpeningValuation(f.client, asset("WETH"), 4663, f.deps), /Chainlink opening price/);
  }
});

test("MUSEGOD reads the canonical pool at the locked block and floors negative fractional TWAP ticks", async () => {
  const f = fixture(asset("MUSEGOD"));
  const price = await readOpeningValuation(f.client, asset("MUSEGOD"), 4663, f.deps);
  assert.equal(price.quotePriceUsd, "2999.70002999700029997");
  assert.equal(price.source, "SushiSwap V3 TWAP");
  assert.equal(price.pool!.toLowerCase(), POOL);
  assert.equal(price.feed!.toLowerCase(), ETH_FEED);
  assert.equal(price.twapSeconds, 300);
  assert.equal(price.sourceUpdatedAt, NOW - 30_000);
  assert.equal(f.fetched.length, 0);
  assert.ok(f.calls.some((call) => call.functionName === "getPool" && call.address.toLowerCase() === FACTORY));
});

test("MUSEGOD refuses pool substitution, no liquidity, locked pools and missing historical observations", async () => {
  const cases: [string, string, unknown][] = [
    [POOL, "token0", asset("AAPL").address],
    [POOL, "token1", asset("USDG").address],
    [POOL, "factory", asset("USDG").address],
    [POOL, "fee", 500],
    [FACTORY, "getPool", asset("USDG").address],
    [POOL, "liquidity", 0n],
    [POOL, "slot0", [1n << 96n, 0, 0, 1, 1, 0, false]],
    [POOL, "observe", [[0n], [0n]]],
    [POOL, "observe", [[0n, -1n], [0n, 0n]]],
    [POOL, "observe", new Error("OLD: not enough pool observation history")],
    [WETH, "decimals", 6],
  ];
  for (const [address, fn, value] of cases) {
    const f = fixture(asset("MUSEGOD"));
    f.set(address, fn, value);
    await assert.rejects(() => readOpeningValuation(f.client, asset("MUSEGOD"), 4663, f.deps),
      /pool identity|confirmed by its factory|usable liquidity|price observation|verified onchain|contract identity/, fn);
  }
});

test("upstream RPC and REST exceptions cannot expose provider credentials", async () => {
  const secret = "https://rpc.example/v2/private-provider-secret";
  const rpc = fixture(asset("WETH"));
  rpc.set(ETH_FEED, "latestRoundData", new Error(secret));
  await assert.rejects(() => readOpeningValuation(rpc.client, asset("WETH"), 4663, rpc.deps),
    (error: Error) => !error.message.includes(secret) && /verified onchain/.test(error.message));
  const rest = fixture();
  await assert.rejects(() => readOpeningValuation(rest.client, asset("NVDA"), 4663,
    { ...rest.deps, fetch: async () => { throw new Error(secret); } }),
    (error: Error) => !error.message.includes(secret) && /Robinhood opening price is unavailable/.test(error.message));
});
