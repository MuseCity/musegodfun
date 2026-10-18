import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { keccak256, zeroAddress, type Address, type Hex } from "viem";
import { ROBINHOOD_STOCKS, STOCKS, sameAddress, type Stock } from "../src/lib/config";
import { openingReferenceText, type LifiOpeningValuation } from "../src/lib/opening-valuation";
import { FEED_HEARTBEAT_GRACE, MARKET_CLOSED_MAX_AGE, independentReference, stockFeedMarketOpen, stockFeedOpenSeconds } from "../server/opening-price";

// Owner, 2026-10-18: "An independent fresh price reference is unavailable…" showed on nearly every launch. The buyback oracle maps no
// feed for WETH or MUSEGOD (the default pairs), and mapped stock feeds stop at the market close. The opening price is now compared with
// the oracle's ETH/USD feed for WETH, its MUSEGOD/WETH TWAP for MUSEGOD, and a stock's last close while its market is closed; an asset
// with no independent source shows no warning (tasks/review-info-tips-price-reference-plan.md).

const asset = (symbol: string) => ROBINHOOD_STOCKS.find((item) => item.symbol === symbol)!;
const weth = asset("WETH"), musegod = asset("MUSEGOD"), usdg = asset("USDG"), nvda = ROBINHOOD_STOCKS.find((item) => item.ticker === "NVDA")!;
const unmapped = ROBINHOOD_STOCKS.find((item) => item.ticker === "ADBE")!;
const ORACLE_CODE: Hex = "0x6001600101", oracle = { address: "0x768c2a29a345ed37202902f8b556d326bab832fd", runtimeHash: keccak256(ORACLE_CODE) };
const ETH_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", POOL = "0x071eE139277688d64B139Af1e44f79a9acf12e53";
const NVDA_FEED = "0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15", USDG_FEED = "0x61b7e5650328764b076a108eff5fa7282a1b9ad2";
const NOW = 1_800_000_000_000, NOW_SECONDS = NOW / 1000, BLOCK = 100n;

type Feed = { answer: bigint; age?: number; at?: number; decimals?: number };
/** A Robinhood client answering the buyback oracle, its feeds and the stock tokens' oraclePaused, at one block. */
function chain(options: { feeds?: Record<string, Feed>; code?: Hex; musePerWeth?: bigint; paused?: boolean; hang?: boolean; fail?: string } = {}) {
  const feeds: Record<string, Feed> = { [ETH_FEED.toLowerCase()]: { answer: 2_000_00000000n, age: 600 },
    [NVDA_FEED]: { answer: 180_00000000n, age: 3_600 }, [USDG_FEED]: { answer: 99_998_000n, age: 3_600 },
    ...Object.fromEntries(Object.entries(options.feeds ?? {}).map(([key, value]) => [key.toLowerCase(), value])) };
  const mapped: Record<string, readonly [Address, number, number, number, boolean]> = {
    [nvda.address.toLowerCase()]: [NVDA_FEED, 86_400, 18, 8, true], [usdg.address.toLowerCase()]: [USDG_FEED, 86_400, 6, 8, false] };
  const reads: string[] = [];
  const client = {
    async getCode({ address, blockNumber }: { address: string; blockNumber: bigint }): Promise<Hex | undefined> {
      assert.equal(blockNumber, BLOCK); assert(sameAddress(address, oracle.address)); return options.code ?? ORACLE_CODE;
    },
    async readContract({ address, functionName, args, blockNumber }: { address: string; functionName: string; args?: readonly unknown[]; blockNumber: bigint }) {
      assert.equal(blockNumber, BLOCK); reads.push(functionName);
      if (options.hang) return new Promise(() => {});
      if (functionName === options.fail) throw new Error("https://rpc.invalid/private-key");
      if (sameAddress(address, oracle.address)) {
        switch (functionName) {
          case "assetFeeds": return mapped[String(args![0]).toLowerCase()] ?? [zeroAddress, 0, 0, 0, false];
          case "weth": return weth.address;
          case "musegod": return musegod.address;
          case "museWethPool": return POOL;
          case "ethUsdFeed": return ETH_FEED;
          case "ethMaxAge": return 86_400;
          case "ethFeedDecimals": return 8;
          case "quoteWethToMuse": assert.equal(args![0], 10n ** 18n); return options.musePerWeth ?? 4_000_000_000n * 10n ** 18n;
        }
      }
      const feed = feeds[address.toLowerCase()];
      const updatedAt = BigInt(feed?.at ?? NOW_SECONDS - (feed?.age ?? 0));
      if (feed && functionName === "latestRoundData") return [7n, feed.answer, updatedAt, updatedAt, 7n];
      if (feed && functionName === "decimals") return feed.decimals ?? 8;
      if (functionName === "oraclePaused") { assert(sameAddress(address, nvda.address)); return options.paused ?? false; }
      throw new Error(`Unexpected read ${functionName} at ${address}`);
    },
  };
  return { client, reads, check: (stock: Stock, midpoint: string, now = NOW) => independentReference(client, stock, BLOCK, midpoint, now, oracle) };
}
const unavailable = [{ code: "reference_price_unavailable", message: "An independent fresh price reference is unavailable. Review the opening price and minimum received before continuing." }];

test("WETH is compared with the oracle's Chainlink ETH/USD feed, which assetFeeds does not map", async () => {
  const result = await chain().check(weth, "2010");
  assert.deepEqual(result, { reference: { source: "Chainlink", feed: ETH_FEED, priceUsd: "2000", updatedAt: (NOW_SECONDS - 600) * 1000, divergenceBps: 50 }, warnings: [] });
});

test("the deployed oracle's own runtime passes the pinned identity check", async () => {
  const runtime = readFileSync(new URL("./fixtures/buyback-oracle.runtime.hex", import.meta.url), "utf8").trim() as Hex;
  const { client } = chain({ code: runtime });
  const result = await independentReference(client, weth, BLOCK, "2000", NOW);
  assert.equal(result.reference?.source, "Chainlink"); assert.deepEqual(result.warnings, []);
});

test("MUSEGOD is compared with the oracle's 30-minute MUSEGOD/WETH TWAP times ETH/USD", async () => {
  const { check, reads } = chain();
  // 4e9 MUSEGOD per WETH at $2,000 per WETH: $0.0000005 per MUSEGOD.
  const result = await check(musegod, "0.0000005");
  assert.deepEqual(result, { reference: { source: "TWAP", feed: POOL, priceUsd: "0.0000005", updatedAt: (NOW_SECONDS - 600) * 1000, divergenceBps: 0 }, warnings: [] });
  assert(reads.includes("quoteWethToMuse"));
  const moved = await check(musegod, "0.0000006");
  assert.equal(moved.warnings?.[0]?.code, "reference_price_divergence");
  assert.equal(moved.warnings?.[0]?.message, "The opening price differs from its independent reference by 20.00%. Review this difference before continuing.");
});

const at = (iso: string) => Date.parse(iso) / 1000;
test("a mapped stock compares with its fresh feed, and with its last close while the market is closed", async () => {
  const open = await chain().check(nvda, "180.9");
  assert.deepEqual(open, { reference: { source: "Chainlink", feed: NVDA_FEED, priceUsd: "180", updatedAt: (NOW_SECONDS - 3_600) * 1000, divergenceBps: 50 }, warnings: [] });
  // Seen on Robinhood, 2026-10-18: NVDA's feed last updated Friday 18:21 UTC, read on Sunday (43.6 hours, maxAge 24 hours).
  const friday = { [NVDA_FEED]: { answer: 180_00000000n, at: at("2026-10-16T18:21:00Z") } };
  const weekend = chain({ feeds: friday }), sunday = Date.parse("2026-10-18T14:00:00Z");
  const closed = await weekend.check(nvda, "181", sunday);
  assert.equal(closed.reference?.marketClosed, true);
  assert.deepEqual(closed.warnings, []);
  const moved = await weekend.check(nvda, "200", sunday);
  assert.equal(moved.warnings?.[0]?.message, "The opening price differs from the last market-close reference by 11.12%. Review this difference before continuing.");
  // The market reopens Sunday 20:00 New York time (Monday 00:00 UTC): 5.65 open hours on Friday, then up to the feed's maxAge.
  assert.equal((await weekend.check(nvda, "181", Date.parse("2026-10-19T18:00:00Z"))).reference?.marketClosed, true);
  assert.deepEqual(await weekend.check(nvda, "181", Date.parse("2026-10-19T19:00:00Z")), { warnings: unavailable }, "silent past a full maxAge of open market");
  assert.deepEqual(await chain({ paused: true }).check(nvda, "180"), { warnings: unavailable }, "a paused token oracle still warns");
});

test("a stock feed that stops while the market is open warns, however recent the weekend", async () => {
  // Updated Monday 15:00 UTC, read Wednesday 15:00 UTC: 48 open hours against a 24-hour maxAge (codex review, round 1).
  const outage = chain({ feeds: { [NVDA_FEED]: { answer: 180_00000000n, at: at("2026-10-19T15:00:00Z") } } });
  assert.deepEqual(await outage.check(nvda, "180", Date.parse("2026-10-21T15:00:00Z")), { warnings: unavailable });
  const tooOld = await chain({ feeds: { [NVDA_FEED]: { answer: 180_00000000n, at: at("2026-10-16T18:21:00Z") } } })
    .check(nvda, "180", Date.parse("2026-10-16T18:21:00Z") + (MARKET_CLOSED_MAX_AGE + 1) * 1000);
  assert.deepEqual(tooOld, { warnings: unavailable }, "never older than four days");
});

test("the 24/5 stock week follows New York time across daylight saving", () => {
  for (const [iso, open] of [["2026-10-16T23:59:00Z", true], ["2026-10-17T00:00:00Z", false], ["2026-10-18T23:59:00Z", false], ["2026-10-19T00:00:00Z", true],
    ["2026-12-19T00:59:00Z", true], ["2026-12-19T01:00:00Z", false], ["2026-12-21T00:59:00Z", false], ["2026-12-21T01:00:00Z", true]] as const)
    assert.equal(stockFeedMarketOpen(at(iso)), open, iso);
  assert.equal(stockFeedOpenSeconds(at("2026-10-16T18:21:00Z"), at("2026-10-18T14:00:00Z")), 20_340);
  assert.equal(stockFeedOpenSeconds(at("2026-10-19T15:00:00Z"), at("2026-10-21T15:00:00Z")), 172_800);
});

test("other feeds get one heartbeat of grace and then warn", async () => {
  const late = await chain({ feeds: { [USDG_FEED]: { answer: 99_998_000n, age: 86_400 + FEED_HEARTBEAT_GRACE } } }).check(usdg, "1");
  assert.equal(late.reference?.source, "Chainlink"); assert.equal(late.reference?.marketClosed, undefined);
  assert.deepEqual(await chain({ feeds: { [USDG_FEED]: { answer: 99_998_000n, age: 86_400 + FEED_HEARTBEAT_GRACE + 1 } } }).check(usdg, "1"), { warnings: unavailable });
  assert.deepEqual(await chain({ feeds: { [ETH_FEED]: { answer: 2_000_00000000n, age: 86_400 + FEED_HEARTBEAT_GRACE + 1 } } }).check(weth, "2000"), { warnings: unavailable });
});

test("an asset with no independent source has no reference and no warning: an unmapped stock, and every Base asset", async () => {
  const { check, reads } = chain();
  assert.deepEqual(await check(unmapped, "100"), {});
  assert(!reads.includes("latestRoundData"));
  const base = STOCKS.find((item) => item.ticker === "NVDA")!;
  const offChain = chain();
  assert.deepEqual(await offChain.check(base, "180"), {});
  assert.deepEqual(offChain.reads, [], "Base reads nothing");
});

test("a source that exists but cannot be trusted or read still warns", async () => {
  assert.deepEqual(await chain({ code: "0x6001600102" }).check(weth, "2000"), { warnings: unavailable }, "changed oracle code");
  assert.deepEqual(await chain({ fail: "quoteWethToMuse" }).check(musegod, "0.0000005"), { warnings: unavailable }, "TWAP read fails");
  assert.deepEqual(await chain({ musePerWeth: 0n }).check(musegod, "0.0000005"), { warnings: unavailable });
  assert.deepEqual(await chain({ feeds: { [ETH_FEED]: { answer: 2_000_00000000n, age: 600, decimals: 18 } } }).check(weth, "2000"), { warnings: unavailable }, "feed decimals changed");
  assert.deepEqual(await chain({ fail: "assetFeeds" }).check(unmapped, "100"), { warnings: unavailable }, "a failed mapping read is not 'no source'");
  assert.deepEqual(await chain({ fail: "oraclePaused" }).check(nvda, "180"), { warnings: unavailable }, "a failed pause read");
  assert.deepEqual(await chain({ feeds: { [ETH_FEED]: { answer: 2_000_00000000n, age: 86_400 + FEED_HEARTBEAT_GRACE + 1 } } }).check(musegod, "0.0000005"),
    { warnings: unavailable }, "the TWAP needs a fresh ETH/USD price");
});

test("slow reads give up after three seconds with the unavailable warning", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = chain({ hang: true }).check(weth, "2000");
  t.mock.timers.tick(2_999); await Promise.resolve();
  let settled = false; void pending.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { warnings: unavailable });
});

test("the review names the reference after a preview, or says why there is none", () => {
  const valuation = (extra: Partial<LifiOpeningValuation>) => ({ ...extra }) as LifiOpeningValuation;
  const reference = { feed: ETH_FEED as Address, priceUsd: "2000", updatedAt: NOW, divergenceBps: 12 };
  assert.equal(openingReferenceText(valuation({ reference: { source: "Chainlink", ...reference } }), "WETH"), "LI.FI buy/sell quotes, 0.12% from Chainlink");
  assert.equal(openingReferenceText(valuation({ reference: { source: "Chainlink", ...reference, marketClosed: true } }), "NVDA"),
    "LI.FI buy/sell quotes, 0.12% from Chainlink's last market close");
  assert.equal(openingReferenceText(valuation({ reference: { source: "TWAP", ...reference } }), "MUSEGOD"),
    "LI.FI buy/sell quotes, 0.12% from the 30-minute MUSEGOD/WETH pool average");
  assert.equal(openingReferenceText(valuation({ warnings: unavailable as LifiOpeningValuation["warnings"] }), "WETH"),
    "LI.FI buy/sell quotes; the independent reference could not be read");
  assert.equal(openingReferenceText(valuation({}), "ADBE"), "LI.FI buy/sell quotes; no independent price feed for ADBE");
});
