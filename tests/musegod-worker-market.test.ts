import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { MUSEGOD } from "../src/lib/musegod";

test("real Workerd fetch accepts Bankr requests, persists snapshots and refuses redirects", async () => {
  // Wrangler's locked runtime and bundler execute the actual reader. Provider
  // responses are fixtures; this test does not claim live market data.
  const now = Date.parse("2026-10-05T09:00:00.000Z");
  const { outputFiles } = await build({ bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
      import { MusegodMarketReader } from './server/musegod-market';
      const rows = new Map();
      const store = { snapshot: key => rows.get(key) ?? null,
        saveSnapshot: (key, data, at) => rows.set(key, { data, at }) };
      const config = { mode: 'robinhood', chainId: 4663, writesEnabled: false, treasury: null, blockReason: null };
      const reader = new MusegodMarketReader(config, store, { now: () => ${now} });
      export default { async fetch(request) {
        const redirectTest = new URL(request.url).pathname === '/redirect';
        try {
          if (redirectTest) { await reader.candles('1d'); return Response.json({ unexpected: true }); }
          const [summary, candles, trades] = await Promise.all([reader.summary(), reader.candles('1h'), reader.trades()]);
          const restarted = new MusegodMarketReader(config, store, { now: () => ${now} });
          const cached = await restarted.summary();
          return Response.json({ summary, candles, trades, cached, rows: rows.size });
        } catch (error) { return Response.json({ name: error.name, message: error.message, status: error.status, rows: rows.size }, { status: 503 }); }
      } };` },
  });
  let calls = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-10-04", script: outputFiles[0].text,
    outboundService: async (request) => {
      calls++;
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.bankr.bot");
      assert.equal(request.method, "GET");
      if (url.searchParams.get("timeframe") === "day") return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } });
      if (url.pathname.endsWith("/ohlcv")) return Response.json({
        pool: { address: MUSEGOD.pool, network: "robinhood" }, pair: { baseSymbol: "MUSEGOD", quoteSymbol: "WETH" },
        ohlcv: [[now / 1000 - 3600, 1, 2, 0.5, 1.5, 0]], watermark: null,
      });
      if (url.pathname.endsWith("/stats")) return Response.json({ liquidityUsd: 100, windows: {} });
      if (url.pathname.endsWith("/swaps")) return Response.json({ swaps: [{
        txHash: `0x${"a".repeat(64)}`, blockNumber: 123, logIndex: 1, timestamp: "2026-10-05T08:30:00.000Z",
        side: "buy", tokenAmount: 10, totalUsd: 2, traderAddress: null, chain: "robinhood",
      }] });
      return Response.json({ token: { tokenAddress: MUSEGOD.token, poolId: MUSEGOD.pool, chain: "robinhood",
        name: "MUSEGOD", symbol: "MUSEGOD", pairedAsset: "weth", decimals: 18, lastPriceUsd: 0.3,
        marketCapUsd: null, lastTradeAt: null, priceChange5m: null, priceChange1h: null,
        priceChange6h: null, priceChange24h: null } });
    },
  }));
  try {
    const response = await runtime.dispatchFetch("https://local.test/");
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify({ result, calls }));
    assert.equal(result.summary.status, "fresh"); assert.equal(result.summary.source, "Bankr");
    assert.equal(result.candles.candles.length, 1); assert.equal(result.trades.trades.length, 1);
    assert.equal(result.cached.fetchedAt, result.summary.fetchedAt); assert.equal(result.rows, 4);
    assert.equal(calls, 4);
    const rejected = await runtime.dispatchFetch("https://local.test/redirect");
    assert.equal(rejected.status, 503);
    const failure = await rejected.json() as any;
    assert.equal(failure.status, "unavailable"); assert.equal(failure.rows, 4);
    assert.equal(calls, 5, "Redirect destination must never be requested");
  } finally { await runtime.dispose(); }
});
