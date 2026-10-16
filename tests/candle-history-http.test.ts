import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { MUSEGOD } from "../src/lib/musegod";
import { quoteAsset } from "../src/lib/config";
import { syntheticToken } from "./fixtures";

test("actual candle routes validate before and forward it to the isolated historical readers", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "candle-routes-"));
  const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: MUSEGOD.weth });
  const entry = createApp(undefined, "loopback", runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "robinhood", DATA_DIR: scratch }));
  entry.service.token = async () => token;
  const native = globalThis.fetch, calls: URL[] = [], before = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return native(input, init);
    assert.equal(url.hostname, "api.bankr.bot"); calls.push(url);
    const musegod = url.pathname.includes(MUSEGOD.token.toLowerCase());
    return Response.json({ ohlcv: [[before, 1, 1, 1, 1, 1], [before - 3600, 1, 1, 1, 1, 2]],
      pool: { address: musegod ? MUSEGOD.pool : token.poolId, network: "robinhood" },
      pair: { baseSymbol: musegod ? "MUSEGOD" : token.symbol, quoteSymbol: musegod ? "WETH" : quoteAsset(token).symbol } });
  });
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const path of ["/api/musegod/market/candles", `/api/tokens/${token.address}/market/candles`]) {
      const invalid = await fetch(`${origin}${path}?interval=1h&before=${before + 1}`); assert.equal(invalid.status, 400);
      const valid = await fetch(`${origin}${path}?interval=1h&before=${before}`); assert.equal(valid.status, 200);
      const data = await valid.json() as any; assert.deepEqual(data.candles.map((c: any) => c.time), [before - 3600]);
      assert.equal(data.source, "Bankr"); assert.equal(data.nextRefreshAt, new Date(Date.parse(data.fetchedAt) + 3_600_000).toISOString());
    }
    assert.equal(calls.length, 2); assert(calls.every(url => url.searchParams.get("before_timestamp") === String(before)));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); (entry.service.store as any).close(); await rm(scratch, { recursive: true, force: true }); }
});
