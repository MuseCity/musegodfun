import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { STOCKS, type TokenRecord } from "../src/lib/config";
import { CHART_INTERVALS } from "../src/lib/market";

const origin = process.env.TEST_APP_URL || "http://127.0.0.1:5188";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname));
const read = async (path: string) => {
  const response = await fetch(origin + "/api" + path, { signal: AbortSignal.timeout(35000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
};
const tokens = await read("/tokens") as TokenRecord[];
assert(Array.isArray(tokens));
for (const token of tokens) {
  assert.equal(token.mode, "base");
  assert(token.transactionHash, "Live market checks require a registered asset");
  assert(STOCKS.some((stock) => stock.address.toLowerCase() === token.quoteAddress.toLowerCase()));
}
let report: Record<string, unknown>;
if (tokens.length === 0) {
  report = {
    observedAt: new Date().toISOString(), status: "skipped", liveMarketVerified: false,
    scope: "Actual local Base catalog was read; no CoinGecko or holder verification was attempted",
    catalogCount: 0,
    reason: "No registered stock-paired mainnet pool is available. Synthetic fixtures are used only in unit tests.",
    skipped: ["summary", ...CHART_INTERVALS.map((interval) => `candles:${interval}`), "trades", "batch/cache reuse", "holders"],
  };
  console.log("SKIP: live market checks require a real registered stock-paired pool; catalog is empty");
} else {
  const token = tokens[0];
  const summary = await read(`/tokens/${token.address}/market/summary`);
  assert.equal(summary.source, "CoinGecko");
  assert.equal(summary.status, "fresh");
  assert(summary.priceUsd > 0);
  const intervals = [];
  for (const interval of CHART_INTERVALS) {
    const data = await read(`/tokens/${token.address}/market/candles?interval=${interval}`);
    assert.equal(data.source, "CoinGecko");
    assert(data.candles.length > 0);
    intervals.push({ interval, count: data.candles.length, updatedAt: data.fetchedAt, nextRefreshAt: data.nextRefreshAt });
  }
  const trades = await read(`/tokens/${token.address}/market/trades`);
  assert(trades.trades.length > 0);
  assert(trades.trades.every((trade: { side: string }) => ["buy", "sell"].includes(trade.side)));
  const batch = await read(`/market/summaries?addresses=${token.address}`);
  assert.equal(batch[0].summary.fetchedAt, summary.fetchedAt);
  assert.equal((await read(`/tokens/${token.address}/market/summary`)).fetchedAt, summary.fetchedAt);
  const holders = await read(`/tokens/${token.address}/market/holders`);
  assert.equal(holders.source, "Blockscout");
  report = {
    observedAt: new Date().toISOString(), status: "passed", liveMarketVerified: true,
    scope: "Live CoinGecko Demo for an actual registered stock-paired pool through local server snapshots",
    catalogCount: tokens.length, tokenAddress: token.address, poolId: token.poolId, summary, intervals,
    tradeCount: trades.trades.length,
    tradeSides: [...new Set(trades.trades.map((trade: { side: string }) => trade.side))],
    holders: { source: holders.source, indexedCount: holders.indexedCount },
    sharedSnapshotVerified: true,
  };
  console.log("PASS: actual pool Demo summary, six intervals, trades, batch/cache reuse and Blockscout holders");
}
await writeFile("docs/evidence/coingecko-demo.json", JSON.stringify(report, null, 2) + "\n");
