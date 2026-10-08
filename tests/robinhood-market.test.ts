import test from "node:test";
import assert from "node:assert/strict";
import { MarketReader, parseBankrCandles, parseCandles } from "../server/market";
import { MAX_STALE, SNAPSHOT_TTL } from "../server/snapshots";
import type { StoreBackend } from "../server/supabase-store";
import { CHART_INTERVALS } from "../src/lib/market";
import { quoteAsset, ROBINHOOD_STOCKS } from "../src/lib/config";
import { syntheticToken } from "./fixtures";

const NOW = Date.parse("2026-10-08T14:00:00Z"), TIME = NOW / 1000 - 3600;
const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: ROBINHOOD_STOCKS[0].address });
const rows = [[TIME, 1, 2, 0.5, 1.5, 10]];
const bankr = () => ({ ohlcv: rows, pool: { address: token.poolId, network: "robinhood" },
  pair: { baseSymbol: token.symbol, quoteSymbol: quoteAsset(token).symbol } });
const gecko = (record = token) => ({ data: { attributes: { ohlcv_list: rows } },
  meta: { base: { address: record.address }, quote: { address: record.quoteAddress } } });
function fixture(fetcher: typeof fetch) {
  let now = NOW;
  const snapshots = new Map<string, { data: unknown; at: number }>();
  const store = { snapshot: (key: string) => snapshots.get(key) ?? null,
    saveSnapshot: (key: string, data: unknown, at: number) => snapshots.set(key, { data, at }),
    reserveMarketCall: () => { throw new Error("Public providers must not consume CoinGecko Demo quota"); },
  } as unknown as StoreBackend;
  const options = { store, fetch: fetcher, now: () => now };
  return { reader: new MarketReader(options), options, snapshots, advance: (ms: number) => { now += ms; } };
}

test("Robinhood prefers Bankr, merges requests and persists the actual source without API keys", async () => {
  const calls: string[] = [];
  const f = fixture(async (input, init) => {
    const url = new URL(String(input)); calls.push(url.href);
    assert.equal(url.origin, "https://api.bankr.bot");
    assert.equal(url.searchParams.get("chain"), "robinhood");
    assert.equal(url.searchParams.get("timeframe"), "hour");
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "manual");
    assert.deepEqual(init?.headers, { accept: "application/json" });
    assert(init?.signal instanceof AbortSignal);
    return Response.json(bankr());
  });
  const [first, duplicate] = await Promise.all([f.reader.candles(token, "1h"), f.reader.candles(token, "1h")]);
  assert.equal(first, duplicate); assert.equal(first.source, "Bankr"); assert.equal(first.status, "fresh");
  assert.equal(first.nextRefreshAt, new Date(NOW + SNAPSHOT_TTL).toISOString());
  assert.equal((await new MarketReader(f.options).candles(token, "1h")).source, "Bankr");
  assert.equal(calls.length, 1);
  assert([...f.snapshots.keys()].every(key => key.includes(`robinhood:${token.address}:${token.poolId}:`)));
});

test("all six intervals keep the existing aggregation and real empty histories", async () => {
  const requests: URL[] = [];
  const f = fixture(async input => { requests.push(new URL(String(input))); return Response.json({ ...bankr(), ohlcv: [] }); });
  const expected = [["minute", "1"], ["minute", "5"], ["minute", "15"], ["hour", "1"], ["hour", "4"], ["day", "1"]];
  for (const [index, interval] of CHART_INTERVALS.entries()) {
    const data = await f.reader.candles(token, interval);
    assert.deepEqual(data.candles, []); assert.equal(data.source, "Bankr");
    const url = requests[index * 2];
    assert.equal(url.searchParams.get("timeframe"), expected[index][0]);
    assert.equal(url.searchParams.get("aggregate"), expected[index][1]);
  }
});

test("Bankr HTTP errors, redirects, timeout, malformed data and wrong identities trigger Gecko fallback", async () => {
  const failures = [
    () => new Response(null, { status: 429 }), () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 502 }),
    () => new Response(null, { status: 302, headers: { location: "https://other.invalid" } }),
    () => { throw new DOMException("timeout", "TimeoutError"); },
    () => new Response("not JSON"),
    () => Response.json({ ...bankr(), pool: { address: `0x${"0".repeat(64)}`, network: "robinhood" } }),
    () => Response.json({ ...bankr(), pool: { address: token.poolId, network: "base" } }),
    () => Response.json({ ...bankr(), pair: { baseSymbol: "COST", quoteSymbol: token.symbol } }),
    () => Response.json({ ...bankr(), ohlcv: [[TIME, 1, 2, 0.5, null, 10]] }),
    () => Response.json({ ...bankr(), ohlcv: [[NOW / 1000 + 61, 1, 2, 0.5, 1.5, 10]] }),
  ];
  for (const failure of failures) {
    const calls: URL[] = [];
    const f = fixture(async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      assert.equal(init?.redirect, "manual");
      if (url.hostname === "api.bankr.bot") return failure();
      assert.equal(url.origin, "https://api.geckoterminal.com");
      assert.equal(url.pathname, `/api/v2/networks/robinhood/pools/${token.poolId}/ohlcv/hour`);
      assert.equal(url.searchParams.get("token"), token.address);
      assert.equal(url.searchParams.get("currency"), "usd");
      return Response.json(gecko());
    });
    const result = await f.reader.candles(token, "1h");
    assert.equal(result.source, "GeckoTerminal"); assert.equal(result.candles.length, 1);
    assert.equal((await new MarketReader(f.options).candles(token, "1h")).source, "GeckoTerminal");
    assert.equal(calls.length, 2);
  }
});

test("empty Bankr candles try Gecko, while valid empty Bankr survives an unavailable fallback", async () => {
  for (const succeeds of [true, false]) {
    const f = fixture(async input => new URL(String(input)).hostname === "api.bankr.bot"
      ? Response.json({ ...bankr(), ohlcv: [] }) : succeeds ? Response.json(gecko()) : new Response(null, { status: 503 }));
    const data = await f.reader.candles(token, "1h");
    assert.equal(data.source, succeeds ? "GeckoTerminal" : "Bankr");
    assert.equal(data.candles.length, succeeds ? 1 : 0);
  }
});

test("both-provider failures retain the previous source with stale/backoff and expire after 24 hours", async () => {
  let failed = false, calls = 0;
  const f = fixture(async input => {
    calls++;
    if (failed || new URL(String(input)).hostname === "api.bankr.bot") return new Response(null, { status: 503 });
    return Response.json(gecko());
  });
  const fresh = await f.reader.candles(token, "1h");
  failed = true; f.advance(SNAPSHOT_TTL + 1);
  const stale = await f.reader.candles(token, "1h");
  assert.equal(stale.status, "stale"); assert.equal(stale.source, "GeckoTerminal");
  assert.equal(stale.fetchedAt, fresh.fetchedAt); assert.equal(calls, 4);
  assert.equal((await f.reader.candles(token, "1h")).status, "stale"); assert.equal(calls, 4);
  f.advance(MAX_STALE);
  await assert.rejects(f.reader.candles(token, "1h"), { status: "unavailable" });
});

test("wrong Gecko token/quote and ambiguous duplicate candles fail closed without a snapshot", async () => {
  for (const data of [gecko({ ...token, address: token.quoteAddress }), gecko({ ...token, quoteAddress: token.address }),
    { ...gecko(), data: { attributes: { ohlcv_list: [rows[0], [TIME, 1, 2, 0.5, 1.8, 10]] } } }]) {
    const f = fixture(async input => new URL(String(input)).hostname === "api.bankr.bot"
      ? new Response(null, { status: 503 }) : Response.json(data));
    await assert.rejects(f.reader.candles(token, "1h"), { status: "unavailable" });
    assert.equal(f.snapshots.size, 0);
  }
});

test("complete duplicate candles win over contained fragments without adding volume or losing wicks", () => {
  const full = [TIME, 1, 2, 0.5, 1.5, 10], fragment = [TIME, 1.5, 1.5, 1.5, 1.5, 2];
  for (const data of [[full, fragment], [fragment, full], [full, full]]) {
    const parsed = parseBankrCandles({ ...bankr(), ohlcv: data }, token, NOW);
    assert.deepEqual(parsed.candles, [{ time: TIME, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
    assert.deepEqual(parseCandles({ ...gecko(), data: { attributes: { ohlcv_list: data } } }, token, NOW).candles, parsed.candles);
  }
  assert.throws(() => parseBankrCandles({ ...bankr(), ohlcv: [full, [TIME, 1.25, 2, 0.5, 1.5, 10]] }, token, NOW),
    /Conflicting duplicate candle/);
});

test("Robinhood cache is isolated from Base, pool changes and forks", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return Response.json(bankr()); });
  f.snapshots.set(`${token.address}:1h`, { data: { fetchedAt: new Date(NOW).toISOString(), candles: [], source: "CoinGecko" }, at: NOW });
  assert.equal((await f.reader.candles(token, "1h")).source, "Bankr"); assert.equal(calls, 1);
  assert.throws(() => f.reader.candles({ ...token, mode: "fork" }, "1h"), /Local forks/);
  assert.throws(() => f.reader.candles({ ...token, deploymentChainId: 8453 }, "1h"), /Robinhood Chain mainnet/);
  await assert.rejects(f.reader.candles({ ...token, poolId: `0x${"c".repeat(64)}` }, "1h"));
  assert.equal(calls, 3);
});

test("Gecko fallback caps outbound calls at 30 per rolling minute per reader", async () => {
  let geckoCalls = 0;
  const f = fixture(async input => {
    const url = new URL(String(input));
    if (url.hostname === "api.bankr.bot") return new Response(null, { status: 503 });
    geckoCalls++;
    return Response.json(gecko({ ...token, address: url.searchParams.get("token") as typeof token.address }));
  });
  const record = (n: number) => ({ ...token, address: `0x${n.toString(16).padStart(40, "0")}` as typeof token.address });
  for (let n = 1; n <= 30; n++) await f.reader.candles(record(n), "1h");
  await assert.rejects(f.reader.candles(record(31), "1h"), { status: "unavailable" });
  assert.equal(geckoCalls, 30);
  f.advance(60_000);
  await f.reader.candles(record(32), "1h"); assert.equal(geckoCalls, 31);
});
