import test from "node:test";
import assert from "node:assert/strict";
import {
  listedTokens,
  sortTokens,
  quoteAsset,
  poolCurrency,
  STOCKS,
} from "../src/lib/config";
import { launchSchema } from "../src/lib/validation";
import { syntheticToken } from "./fixtures";
import {
  MarketReader,
  parseCandles,
  parseMarketSummary,
  parseTrades,
} from "../server/market";
const token = syntheticToken();
const other = syntheticToken({
  address: "0x3333333333333333333333333333333333333333",
  name: "AAA",
  createdAt: token.createdAt + 1000,
  quoteAddress: STOCKS[1].address,
});
test("catalog never injects a pinned asset and both sorts use only registered records", () => {
  const records = [token, other];
  const listed = listedTokens(records, "base");
  assert.equal(listed.length, 2);
  for (const order of ["name", "new"] as const)
    assert.equal(sortTokens(listed, order)[0].address, other.address);
  assert.equal(records[0].address, token.address);
  assert.deepEqual(listedTokens([], "base"), []);
  assert.deepEqual(listedTokens([], "fork"), []);
});
test("catalog filters unsupported quotes, unregistered records and cross-mode assets", () => {
  const fork = syntheticToken({ mode: "fork" });
  const unregistered = syntheticToken({ transactionHash: null });
  const unsupported = syntheticToken({ quoteAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
  assert.deepEqual(listedTokens([token, fork, unregistered, unsupported], "base"), [token]);
  assert.deepEqual(listedTokens([token, fork, unregistered, unsupported], "fork"), [fork]);
});
test("empty catalog does not issue external market requests", async () => {
  let calls = 0;
  const market = new MarketReader({ fetch: async () => { calls++; throw new Error("No pool to request"); } });
  assert.deepEqual(await market.summaries([]), []);
  assert.equal(calls, 0);
});
test("all catalog assets require stock quotes with 8/18 precision and no stablecoin exception", () => {
  const unsupported = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  assert.equal(quoteAsset(token).decimals, 8);
  assert.equal(poolCurrency(token.quoteAddress, token).decimals, 8);
  assert.equal(poolCurrency(token.address, token).decimals, 18);
  assert.throws(() => quoteAsset({ ...other, quoteAddress: unsupported }));
  assert.equal(
    launchSchema.safeParse({
      name: "No",
      symbol: "NO",
      quoteAddress: unsupported,
      description: "",
      image: "",
    }).success,
    false,
  );
});
const pool = {
  data: {
    attributes: {
      address: token.poolId,
      base_token_price_usd: "0.0004",
      fdv_usd: "400000",
      market_cap_usd: null,
      reserve_in_usd: "300000",
      price_change_percentage: { h24: "0" },
      volume_usd: { h24: "10" },
      transactions: { h24: { buys: 0, sells: 1 } },
    },
    relationships: {
      base_token: { data: { id: `base_${token.address.toLowerCase()}` } },
      quote_token: { data: { id: `base_${token.quoteAddress.toLowerCase()}` } },
    },
  },
};
test("market identity checks reject mismatched pools; missing data stays unknown, valid zero survives", () => {
  const stats = parseMarketSummary(pool, token);
  assert.equal(stats.marketCapUsd, null);
  assert.equal(stats.periods.h24.change, 0);
  assert.equal(stats.periods.h24.buys, 0);
  assert.equal(stats.periods.m5.volume, null);
  assert.throws(() =>
    parseMarketSummary(pool, { ...token, poolId: `0x${"0".repeat(64)}` }),
  );
  assert.throws(() =>
    parseMarketSummary(pool, { ...token, quoteAddress: STOCKS[1].address }),
  );
});
const candleData = (rows: number[][]) => ({
  data: { attributes: { ohlcv_list: rows } },
  meta: { base: { address: token.address }, quote: { address: token.quoteAddress } },
});
test("candles sort and deduplicate timestamps, reject impossible OHLC and incorrect asset orientation", () => {
  const rows = [
    [200, 2, 3, 1, 2, 0],
    [100, 1, 2, 0.5, 1.5, 10],
    [100, 1, 2, 0.5, 1.5, 10],
  ];
  assert.deepEqual(
    parseCandles(candleData(rows), token).candles.map((c) => c.time),
    [100, 200],
  );
  assert.equal(parseCandles(candleData(rows), token).candles[1].volume, 0);
  assert.throws(() => parseCandles(candleData([[100, 5, 2, 1, 1, 10]]), token));
  assert.throws(() =>
    parseCandles(candleData(rows), { ...token, address: token.quoteAddress }),
  );
  const missing = candleData(rows);
  (missing.data.attributes.ohlcv_list[0] as unknown[])[1] = null;
  assert.throws(() => parseCandles(missing, token));
});
test("trade side and token amount derive from asset addresses, not provider labels", () => {
  const trade = {
    data: [
      {
        id: "event-1",
        attributes: {
          tx_hash: `0x${"1".repeat(64)}`,
          tx_from_address: STOCKS[0].address,
          block_timestamp: "2026-09-21T12:00:00Z",
          kind: "sell",
          from_token_address: token.quoteAddress,
          to_token_address: token.address,
          from_token_amount: "1",
          to_token_amount: "2500",
          price_from_in_usd: "1",
          price_to_in_usd: "0.0004",
          volume_in_usd: "1",
        },
      },
    ],
  };
  const parsed = parseTrades(trade, token).trades[0];
  assert.equal(parsed.side, "buy");
  assert.equal(parsed.amount, 2500);
  assert.equal(parsed.price, 0.0004);
  assert.throws(() =>
    parseTrades(trade, { ...token, quoteAddress: STOCKS[1].address }),
  );
});
test("fork mode refuses all external mainnet market data before making requests", () => {
  const market = new MarketReader(),
    fork = syntheticToken({ mode: "fork" });
  assert.throws(() => market.summary(fork), /Local forks/);
  assert.throws(() => market.trades(fork), /Local forks/);
  assert.throws(() => market.candles(fork, "1h"), /Local forks/);
  assert.throws(() => market.holders(fork), /Local forks/);
});

test("Robinhood assets cannot fetch or reuse Base market and holder data", () => {
  let reads = 0;
  const reader = new MarketReader({
    store: { snapshot: () => { reads++; throw new Error("Base cache must not be read"); } } as never,
    fetch: async () => { reads++; throw new Error("Base providers must not be queried"); },
    now: () => 1_800_000_000_000,
  });
  const robinhoodToken = syntheticToken({ mode: "robinhood", deploymentChainId: 4663 });
  const unavailable = (error: unknown) => {
    const value = error as { message: string; status: string; nextRefreshAt: string };
    return value.status === "unavailable" && /Robinhood Chain/.test(value.message) &&
      value.nextRefreshAt === new Date(1_800_000_900_000).toISOString();
  };
  assert.throws(() => reader.summary(robinhoodToken), unavailable);
  assert.throws(() => reader.summaries([robinhoodToken]), unavailable);
  assert.throws(() => reader.trades(robinhoodToken), unavailable);
  assert.throws(() => reader.candles(robinhoodToken, "1h"), unavailable);
  assert.throws(() => reader.holders(robinhoodToken), unavailable);
  assert.equal(reads, 0);
});

test("missing summary sections stay unknown while identity remains mandatory", () => {
  const sparse = {
    ...pool,
    data: { ...pool.data, attributes: { address: token.poolId } },
  };
  const result = parseMarketSummary(sparse, token);
  assert.equal(result.priceUsd, null);
  assert.equal(result.periods.h24.volume, null);
  assert.equal(result.periods.h24.buys, null);
});

test("a cold batch preserves market fields, merges duplicate requests and shares single-pool snapshots", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../server/store");
  const dir = mkdtempSync(join(tmpdir(), "musegod-batch-")),
    store = new Store(dir, 8453);
  let calls = 0;
  const reader = new MarketReader({
    store,
    apiKey: "test",
    fetch: async (url) => {
      calls++;
      assert(String(url).includes("/pools/multi/"));
      return new Response(JSON.stringify({ data: [pool.data] }));
    },
  });
  try {
    const result = await reader.summaries([token]);
    assert.equal(result[0].summary?.priceUsd, 0.0004);
    assert.equal(result[0].summary?.periods.h24.volume, 10);
    assert.equal((await reader.summary(token)).priceUsd, 0.0004);
    assert.equal(calls, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
