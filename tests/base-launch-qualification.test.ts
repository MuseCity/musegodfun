import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "viem";
import evidence from "../docs/evidence/base-jumper-qualification.json";
import qualified from "../src/lib/lifi-launch-assets.json";
import { ADMITTED_BASE_ASSET_COUNT, launchAssetsFor, stockByAddress, STOCKS, ROBINHOOD_STOCKS } from "../src/lib/config";

const addresses = (values: readonly { address: string }[]) => values.map((value) => value.address.toLowerCase()).sort();
const removedPM = "0xb2000000000000000000008fc2a8c23cf5937b66";
test("Base launch eligibility excludes PM while retaining the original Jumper observations", () => {
  assert.equal(STOCKS.length, ADMITTED_BASE_ASSET_COUNT);
  assert.deepEqual(addresses(launchAssetsFor({ mode: "base" })), addresses(STOCKS));
  assert.deepEqual([...qualified[8453]].map((address) => address.toLowerCase()).sort(), addresses(STOCKS));
  assert.deepEqual(addresses(evidence.records).filter(address => address !== removedPM), addresses(STOCKS));
  assert.equal(new Set(addresses(evidence.records)).size, evidence.result.assetCount);
  assert.equal(evidence.records.length, ADMITTED_BASE_ASSET_COUNT + 1);
  assert.equal(evidence.result.transactionsExecuted, 0); assert.equal(evidence.result.walletConnected, false);
  for (const row of evidence.records) {
    const stock = STOCKS.find((item) => item.address.toLowerCase() === row.address.toLowerCase());
    if (row.address.toLowerCase() === removedPM) {
      assert.equal(stock, undefined); assert.equal(row.symbol, "PMc"); assert.equal(row.decimals, 8);
    } else {
      assert(stock); assert.equal(row.symbol, stock.symbol); assert.equal(row.decimals, stock.decimals);
    }
    assert.equal(row.observedAt, null, "no exact per-asset observation timestamp was captured");
    assert.equal(row.buy.amountIn, "10000000"); assert.equal(row.buy.fromToken.symbol, "USDC");
    assert.equal(row.buy.fromToken.decimals, 6); assert.equal(row.sell.toToken.symbol, "WETH");
    assert.equal(row.sell.toToken.decimals, 18); assert.equal(row.sell.amountIn, row.buy.amountOut);
    assert.equal(row.buy.amountOut, parseUnits(row.buy.displayAmountOut, row.decimals).toString());
    assert.equal(row.sell.amountOut, parseUnits(row.sell.displayAmountOut, 18).toString());
    assert.equal(row.buy.minimumOut, null); assert.equal(row.sell.minimumOut, null);
    assert.equal(row.buy.quoteId, null); assert.equal(row.sell.quoteId, null);
    assert(row.buy.visibleRouteCount > 0); assert(row.sell.visibleRouteCount > 0);
    assert(row.buy.firstProviderDisplayName); assert(row.sell.firstProviderDisplayName);
  }
  assert(evidence.failuresAndRetries.some((entry) => entry.status === "http_429"));
  const robinhood = launchAssetsFor({ mode: "robinhood" });
  assert.deepEqual(addresses(robinhood), ROBINHOOD_STOCKS.filter((stock) => qualified[4663].includes(stock.address.toLowerCase())).map((stock) => stock.address.toLowerCase()).sort());
});
test("removed PM cannot be selected from Base or its fork identity/launch registry", () => {
  assert.throws(() => stockByAddress(removedPM, 8453), /Unsupported paired asset/);
  for (const mode of ["base", "fork"] as const) {
    const admitted = launchAssetsFor({ mode, deploymentChainId: 8453 });
    assert.equal(admitted.length, ADMITTED_BASE_ASSET_COUNT);
    assert(!admitted.some(asset => asset.address.toLowerCase() === removedPM));
  }
});
