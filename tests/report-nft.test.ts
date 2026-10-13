import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { ROBINHOOD_STOCKS, type TokenRecord } from "../src/lib/config";
import { MUSES } from "../src/lib/nft-mode";
import { Store } from "../server/store";
import { GECKO_ORIGIN, REPORT_ORIGIN, nftReport, rateLimiter, readLocalTokens, volumeFromCandles, type Clock } from "../scripts/report-nft";
import { syntheticToken } from "./fixtures";

const musegod = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!;
const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 86_400;
const other = getAddress("0x7777777777777777777777777777777777777777");

/** A fake clock: `sleep` advances time instead of waiting. */
function fakeClock(start = NOW): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return { slept, now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; } };
}
function coin(n: number, over: Partial<TokenRecord>): TokenRecord {
  const hex = n.toString(16).padStart(2, "0");
  return syntheticToken({ address: getAddress(`0x${hex.repeat(20)}`), symbol: `C${n}`, poolId: `0x${hex.repeat(32)}` as Hex, transactionHash: `0x${"ab".repeat(31)}${hex}`,
    mode: "robinhood", deploymentChainId: 4663, quoteAddress: musegod.address, createdAt: NOW - n * 1000, ...over });
}
const muse = (tokenId: string) => ({ chainId: 4663 as const, contract: MUSES.contract, tokenId });
const plain = (tokenId: string) => ({ chainId: 4663 as const, contract: other, tokenId });
const fee = (n: number) => ({ asset: "stable" as const, txHash: `0x${"fe".repeat(31)}${n.toString(16).padStart(2, "0")}` as Hex });
const catalog = [
  coin(1, { nft: muse("1"), nftVerification: { status: "verified" } }),
  coin(2, { nft: muse("1"), nftVerification: { status: "rejected", reason: "already_launched" } }),
  coin(3, { nft: muse("2") }), // a record from before verification existed counts as unverified
  coin(4, { nft: plain("7"), nftVerification: { status: "verified" }, launchFee: fee(4), quoteAddress: weth.address, hidden: true }),
  coin(5, { nft: plain("8"), nftVerification: { status: "rejected", reason: "fee" }, quoteAddress: weth.address }),
  coin(6, { nft: plain("9"), nftVerification: { status: "unverified", reason: "rpc" }, launchFee: fee(6), quoteAddress: weth.address }),
  coin(7, {}), // a normal coin is not part of the report
  coin(8, { nft: { chainId: 8453, contract: other, tokenId: "1" }, mode: "base", deploymentChainId: 8453 }), // another chain
];
/** Daily candles for `token`: day d (0 = today) has volume 100 + d. */
function candles(token: TokenRecord, days = 30) {
  const today = Math.floor(NOW / 1000 / DAY) * DAY;
  return { data: { attributes: { ohlcv_list: Array.from({ length: days }, (_, d) => [today - d * DAY, 1, 1, 1, 1, 100 + d]) } },
    meta: { base: { address: token.address }, quote: { address: token.quoteAddress } } };
}
type Route = (url: URL) => Response | undefined;
function fakeFetch(clock: Clock, route: Route = () => undefined) {
  const calls: { url: URL; at: number }[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push({ url, at: clock.now() });
    assert([new URL(REPORT_ORIGIN).host, new URL(GECKO_ORIGIN).host].includes(url.host), `unexpected host ${url.host}`);
    const routed = route(url);
    if (routed) return routed;
    if (url.pathname === "/api/chains/4663/tokens") return Response.json(catalog);
    if (url.pathname === "/api/chains/4663/buyback/stats")
      return Response.json({ chainId: 4663, symbol: "MUSEGOD", decimals: 18, deadBalance: "123456780000000000000000", blockNumber: "87700000" });
    const pool = /^\/api\/v2\/networks\/robinhood\/pools\/(0x[0-9a-f]{64})\/ohlcv\/day$/.exec(url.pathname);
    const token = pool && catalog.find((row) => row.poolId === pool[1]);
    if (token && url.searchParams.get("token") === token.address) return Response.json(candles(token));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("the GeckoTerminal limiter allows at most 30 calls in any rolling minute and waits on a fake clock", async () => {
  const clock = fakeClock(0), limit = rateLimiter(clock), at: number[] = [];
  for (let i = 0; i < 75; i++) { await limit(); at.push(clock.now()); }
  for (const start of at) assert(at.filter((time) => time >= start && time < start + 60_000).length <= 30, `more than 30 calls in the minute from ${start}`);
  assert.deepEqual([at[29], at[30], at[59], at[60], at[74]], [0, 60_000, 60_000, 120_000, 120_000]);
  assert.equal(clock.slept.reduce((sum, ms) => sum + ms, 0), 120_000, "it sleeps only as long as the window requires");
});

test("7- and 30-day volume count UTC days with today included", () => {
  const today = Math.floor(NOW / 1000 / DAY) * DAY;
  const rows = Array.from({ length: 40 }, (_, d) => ({ time: today - d * DAY, volume: 1 }));
  assert.deepEqual(volumeFromCandles(rows, NOW), { sevenDay: 7, thirtyDay: 30 });
  assert.deepEqual(volumeFromCandles([], NOW), { sevenDay: 0, thirtyDay: 0 });
});

test("the report counts launches by status and collection, paid launches and USD, volumes and the MUSEGOD burn", async () => {
  const clock = fakeClock(), { fetcher, calls } = fakeFetch(clock);
  const report = await nftReport({ fetch: fetcher, clock });
  assert.match(report, /^# NFT mode report: Robinhood Chain \(4663\)/);
  assert.match(report, /\| Verified \| 2 \|\n\| Unverified \| 2 \|\n\| Rejected \| 2 \|\n\| Total \| 6 \|/);
  assert.match(report, /Rejected by reason: already_launched 1, fee 1\./);
  assert.match(report, /\| Muses `0x13Ea…9836` \| verified collection \| 1 \| 1 \| 1 \|/);
  assert.match(report, /\| `0x7777…7777` \| unverified collection \| 1 \| 1 \| 1 \|/);
  assert.match(report, /\| 2 \| \$20\.00 \|/, "two records carry a launch fee: $20");
  // 7 days: 100+101+…+106 = 721; 30 days: 100+…+129 = 3435, per coin.
  assert.match(report, /\| C1 `0x0101…0101` \| Muse #1 \| verified \| \$721\.00 \| \$3,435\.00 \|/);
  assert.match(report, /\| C4 `0x0404…0404` \(hidden\) \| `0x7777…7777` #7 \| verified \| \$721\.00 \| \$3,435\.00 \|/);
  assert.match(report, /Totals over 6 of 6 coins with data: 7-day \$4,326\.00, 30-day \$20,610\.00/);
  assert.match(report, /Dead-address balance: 123,456\.78 MUSEGOD at block 87700000\./);
  assert.doesNotMatch(report, /C7|C8/, "normal coins and other chains' coins are not reported");
  const gecko = calls.filter((call) => call.url.origin === GECKO_ORIGIN);
  assert.equal(gecko.length, 6, "one OHLCV request per NFT coin");
  assert(gecko.every((call) => call.url.searchParams.get("currency") === "usd" && call.url.searchParams.get("aggregate") === "1"));
  assert.equal(calls.filter((call) => call.url.origin === REPORT_ORIGIN).length, 2, "the catalog and the burn statistics");
});

test("the report keeps to 30 GeckoTerminal requests a minute however many NFT coins there are", async () => {
  const many = Array.from({ length: 70 }, (_, i) => coin(10 + i, { nft: muse(String(100 + i)), nftVerification: { status: "verified" } }));
  const clock = fakeClock(), { fetcher, calls } = fakeFetch(clock, (url) => url.pathname.endsWith("/tokens") ? Response.json(many)
    : url.origin === GECKO_ORIGIN ? new Response("not found", { status: 404 }) : undefined);
  const report = await nftReport({ fetch: fetcher, clock });
  const gecko = calls.filter((call) => call.url.origin === GECKO_ORIGIN).map((call) => call.at);
  assert.equal(gecko.length, 70);
  for (const start of gecko) assert(gecko.filter((at) => at >= start && at < start + 60_000).length <= 30);
  assert(clock.now() - NOW >= 120_000, "70 requests need at least two waits of a minute");
  assert.match(report, /\| not indexed \| not indexed \|/);
});

test("a provider failure marks only that row or line unavailable", async () => {
  const clock = fakeClock(), { fetcher } = fakeFetch(clock, (url) => {
    if (url.origin === GECKO_ORIGIN && url.pathname.includes("0101010101")) return new Response("busy", { status: 500 });
    if (url.origin === GECKO_ORIGIN && url.pathname.includes("0202020202")) return Response.json({ data: { attributes: { ohlcv_list: [] } }, meta: { base: { address: other }, quote: { address: other } } });
    if (url.pathname.endsWith("/buyback/stats")) return new Response("down", { status: 503 });
    return undefined;
  });
  const report = await nftReport({ fetch: fetcher, clock });
  assert.match(report, /\| C1 [^\n]*\| unavailable \| unavailable \|/);
  assert.match(report, /\| C2 [^\n]*\| unavailable \| unavailable \|/, "candles for another pair are refused");
  assert.match(report, /\| C3 [^\n]*\| \$721\.00 \| \$3,435\.00 \|/);
  assert.match(report, /Dead-address balance: unavailable\./);
  await assert.rejects(nftReport({ fetch: fakeFetch(clock, (url) => url.pathname.endsWith("/tokens") ? Response.json({ items: [] }) : undefined).fetcher, clock }),
    /not a JSON array/);
});

test("--local reads an isolated SQLite store read-only and never asks the public catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "report-nft-")), directory = join(root, "robinhood");
  try {
    const store = new Store(directory, 4663);
    for (const row of catalog) store.saveToken(row);
    store.close();
    assert.equal(readLocalTokens(directory).length, catalog.length);
    assert.equal(readLocalTokens(join(directory, "launchpad.sqlite")).length, catalog.length, "the file path works too");
    const clock = fakeClock(), { fetcher, calls } = fakeFetch(clock);
    const report = await nftReport({ fetch: fetcher, clock, local: directory });
    assert.match(report, /from a local store \(read-only\)/);
    assert.match(report, /\| Total \| 6 \|/);
    assert.equal(calls.some((call) => call.url.pathname.endsWith("/tokens")), false);
    assert.throws(() => readLocalTokens(join(root, "missing")), /local store was not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("report-nft never runs on import and names only the two public hosts", async () => {
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../scripts/report-nft.ts", import.meta.url), "utf8"));
  const hosts = [...source.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(hosts)].sort(), ["api.geckoterminal.com", "musegod.fun"]);
  assert.match(source, /import\.meta\.url === pathToFileURL\(resolve\(process\.argv\[1\]\)\)\.href/);
});
