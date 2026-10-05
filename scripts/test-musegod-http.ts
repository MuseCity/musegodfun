import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { MUSEGOD, assertMusegodQuote, type MusegodQuote } from "../src/lib/musegod";
import type { RuntimeConfig } from "../src/lib/config";
const origin = process.env.TEST_APP_URL || "http://127.0.0.1:5192";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname));
const checks: Record<string, unknown>[] = [];
async function read(path: string, data?: unknown, expectedStatus = 200) {
  const response = await fetch(`${origin}/api${path}`, {
    ...(data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(40_000),
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(body)}`);
  checks.push({ path, method: data === undefined ? "GET" : "POST", status: response.status });
  return body;
}
const config = await read("/config") as RuntimeConfig;
assert.equal(config.mode, "robinhood"); assert.equal(config.chainId, 4663);
assert.equal(config.writesEnabled, false, "This acceptance server must remain read-only.");
const tokens = await read("/tokens");
assert(!tokens.some((t: { address: string }) => t.address.toLowerCase() === MUSEGOD.token.toLowerCase()), "Featured token must not become a registered launch.");
const info = await read("/musegod");
assert.equal(info.address, MUSEGOD.token); assert.equal(info.poolAddress, MUSEGOD.pool);
assert.equal(info.decimals, 18); assert.equal(info.tradeEnabled, false);
assert(BigInt(info.totalSupply) > 0n);
const [summary, candles, trades] = await Promise.all([
  read("/musegod/market/summary"), read("/musegod/market/candles?interval=1h"), read("/musegod/market/trades"),
]);
assert.equal(summary.source, "Bankr"); assert(summary.priceUsd > 0); assert.equal(summary.fdvUsd, null);
assert(candles.candles.length > 0); assert(trades.trades.length > 0);
assert.equal(Date.parse(summary.nextRefreshAt) - Date.parse(summary.fetchedAt), 60_000);
assert.equal((await read("/musegod/market/summary")).fetchedAt, summary.fetchedAt);
const quotes: MusegodQuote[] = [];
for (const [side, amount] of [["buy", "0.001"], ["sell", "1000"]] as const) {
  const q = await read("/musegod/quote", { side, amount, slippageBps: 100 }) as MusegodQuote;
  assertMusegodQuote(q, config); assert.equal(q.side, side); quotes.push(q);
}
await read("/musegod/quote", { side: "buy", amount: "0.001", router: MUSEGOD.router }, 400);
await read("/musegod/quote", { side: "buy", amount: "1", slippageBps: 501 }, 400);
await read("/musegod/market/holders", undefined, 400);
await writeFile("docs/evidence/musegod-http.json", JSON.stringify({
  observedAt: new Date().toISOString(), status: "passed", origin,
  scope: "Real read-only Robinhood quotes and Bankr market data through the specified local Node server.",
  mainnetSigning: "not_run", mainnetBroadcast: "not_run", snapshotStorageBackend: "not_identified_by_http",
  checks, info, quotes, market: { source: summary.source, fetchedAt: summary.fetchedAt,
    priceUsd: summary.priceUsd, candleCount: candles.candles.length, tradeCount: trades.trades.length,
    candleWatermark: candles.watermark, sharedSnapshotVerified: true },
}, null, 2) + "\n");
console.log(`PASS: ${checks.length} local HTTP checks, real read-only quotes, Bankr candles/trades and shared snapshots`);
