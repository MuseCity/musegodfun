import assert from "node:assert/strict";
import { test } from "node:test";
import { DopplerSDK, tickToMarketCap } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, decodeAbiParameters, http, parseAbiParameters, type Address } from "viem";
import { base } from "viem/chains";
import { ROBINHOOD_STOCKS, SUPPLY, WAD } from "../src/lib/config";
import { OPENING_CAP_USD } from "../src/lib/opening-valuation";
import { buildLaunch, tokenMetadata } from "../src/lib/protocol";
import {
  CURVE_POLICY, LAUNCH_CURVE_CONFIG, LAUNCH_CURVE_MAIN_END_USD,
  LAUNCH_CURVE_SHARES_BPS, LAUNCH_CURVE_TAIL_BPS,
  buildLaunchCurves, sampleInitialLaunchCurve,
} from "../src/lib/launch-curve";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { syntheticOpeningValuation } from "./fixtures";

const creator = "0x0000000000000000000000000000000000000001" as Address;
const treasury = "0x0000000000000000000000000000000000000002" as Address;
const owner = "0x0000000000000000000000000000000000000003" as Address;
const sdk = new DopplerSDK<4663>({
  publicClient: createPublicClient({ chain: { ...base, id: 4663 }, transport: http() }),
  chainId: 4663,
});
const fixtures = [
  ["USDG", "1"], ["cbBTC", "100000"], ["WETH", "3000"],
  ["NVDA", "150"], ["MUSEGOD", "0.000005"],
] as const;

test("the immutable 19-range policy allocates the exact 97/3 weights over contiguous doublings", () => {
  assert.equal(CURVE_POLICY, "multicurve-97-3-v1");
  assert.deepEqual(LAUNCH_CURVE_SHARES_BPS, [
    2067, 1473, 1050, 748, 533, 380, 271, 293, 325,
    353, 346, 323, 302, 282, 264, 246, 230, 214,
  ]);
  assert.equal(LAUNCH_CURVE_SHARES_BPS.reduce((sum, bps) => sum + bps, 0), 9700);
  assert.equal(LAUNCH_CURVE_TAIL_BPS, 300);
  assert.equal(LAUNCH_CURVE_MAIN_END_USD, 1_310_720_000);
  assert.equal(LAUNCH_CURVE_CONFIG.length, 19);
  assert.equal(LAUNCH_CURVE_CONFIG.reduce((sum, curve) => sum + curve.shares, 0n), WAD);
  for (const [index, curve] of LAUNCH_CURVE_CONFIG.entries()) {
    assert.equal(curve.numPositions, 1);
    assert.equal(curve.marketCap.start, OPENING_CAP_USD * 2 ** index);
    assert.equal(curve.marketCap.end, index === 18 ? "max" : OPENING_CAP_USD * 2 ** (index + 1));
    assert.equal(curve.shares, WAD * BigInt(index === 18 ? 300 : LAUNCH_CURVE_SHARES_BPS[index]) / 10_000n);
    if (index) assert.equal(LAUNCH_CURVE_CONFIG[index - 1].marketCap.end, curve.marketCap.start);
  }
  const copy = buildLaunchCurves();
  copy[0].marketCap.start = 1;
  copy[0].shares = 1n;
  assert.equal(buildLaunchCurves()[0].marketCap.start, OPENING_CAP_USD);
  assert.equal(buildLaunchCurves()[0].shares, WAD * 2067n / 10_000n);
});

for (const [ticker, quotePriceUsd] of fixtures) {
  const stock = ROBINHOOD_STOCKS.find((candidate) => candidate.ticker === ticker)!;
  test(`${ticker} (${stock.decimals} decimals) encodes all 19 actual SDK ranges and keeps fee settings`, () => {
    const valuation = syntheticOpeningValuation(stock.address, quotePriceUsd, { chainId: 4663 });
    const draft = { name: "Curve Test", symbol: "CURVE", description: "", image: "", quoteAddress: stock.address };
    const params = buildLaunch(sdk, draft, creator, treasury, owner, valuation, undefined, 4663);
    const encoded = sdk.factory.encodeCreateMulticurveParams(params);
    const [pool] = decodeAbiParameters(parseAbiParameters("(uint24 fee, int24 tickSpacing, int24 farTick, (int24 tickLower, int24 tickUpper, uint16 numPositions, uint256 shares)[] curves, (address beneficiary, uint96 shares)[] beneficiaries, address dopplerHook, bytes onInitializationDopplerHookCalldata, bytes graduationDopplerHookCalldata)"), encoded.poolInitializerData);
    assert.deepEqual(pool.curves, params.pool.curves.map((curve) => ({
      ...curve, tickLower: curve.tickLower || 0, tickUpper: curve.tickUpper || 0,
    })));
    assert.equal(pool.curves.length, 19);
    assert.equal(pool.curves.reduce((sum, curve) => sum + curve.shares, 0n), WAD);
    assert.equal(pool.fee, 500);
    assert.equal(pool.tickSpacing, 10);
    assert.equal(params.dopplerHook?.startFee, 10000);
    assert.equal(params.dopplerHook?.endFee, 10000);
    assert.equal(params.dopplerHook?.durationSeconds, 0);
    for (const [index, curve] of pool.curves.entries()) {
      assert(curve.tickLower < curve.tickUpper);
      assert(curve.tickLower % 10 === 0);
      assert(curve.tickUpper % 10 === 0);
      if (index) assert.equal(pool.curves[index - 1].tickUpper, curve.tickLower);
      const cap = tickToMarketCap({
        tick: curve.tickLower, tokenIsToken0: true, tokenSupply: SUPPLY,
        numerairePriceUSD: Number(quotePriceUsd), tokenDecimals: 18, numeraireDecimals: stock.decimals,
      });
      assert(cap >= OPENING_CAP_USD * 2 ** index);
      assert(cap < OPENING_CAP_USD * 2 ** index * 1.0001 ** 10);
    }
    const metadata = tokenMetadata(draft, valuation, 4663);
    assert.equal(metadata.properties.curvePolicy, CURVE_POLICY);
    assert.equal(metadata.properties.feePolicy, FEE_POLICY);
    assert.deepEqual(metadata.properties.openingValuation, valuation);

    for (const tokenIsCurrency0 of [true, false]) {
      const model = sampleInitialLaunchCurve({ quotePriceUsd: Number(quotePriceUsd), quoteDecimals: stock.decimals, tokenIsCurrency0 });
      assert.equal(model.points.length, 145);
      assert.equal(model.points[0].soldAmount, 0n);
      assert.equal(model.points[0].tick, (tokenIsCurrency0 ? pool.curves[0].tickLower : -pool.curves[0].tickLower) || 0);
      assert.equal(model.points.at(-1)!.tick, tokenIsCurrency0 ? pool.curves[17].tickUpper : -pool.curves[17].tickUpper);
      assert(model.tailEndFdvUsd > model.mainEndFdvUsd);
      const nominalMainAmount = SUPPLY * 97n / 100n;
      const dust = nominalMainAmount - model.points.at(-1)!.soldAmount;
      assert(dust > 0n, "Model must account for Multicurve's supply-minus-one mint rule and integer rounding");
      assert(dust < SUPPLY / 1_000_000_000n, "Rounding leaves less than one token of dust for supported decimal/price fixtures");
      let completedPercent = 0;
      for (let index = 0; index < 18; index++) {
        const start = model.points[index * 8], end = model.points[(index + 1) * 8];
        const rangePercent = LAUNCH_CURVE_SHARES_BPS[index] / 100;
        assert.equal(start.tick, (tokenIsCurrency0 ? pool.curves[index].tickLower : -pool.curves[index].tickLower) || 0);
        assert.equal(end.tick, tokenIsCurrency0 ? pool.curves[index].tickUpper : -pool.curves[index].tickUpper);
        for (let sample = 0; sample <= 8; sample++) {
          const point = model.points[index * 8 + sample];
          // Independent single-position constant-product formula at the SDK's
          // rounded FDV boundaries; integer mint dust is bounded above.
          const fraction = (1 / Math.sqrt(start.fdvUsd) - 1 / Math.sqrt(point.fdvUsd)) /
            (1 / Math.sqrt(start.fdvUsd) - 1 / Math.sqrt(end.fdvUsd));
          const expectedPercent = completedPercent + rangePercent * fraction;
          assert(Math.abs(point.soldPercent - expectedPercent) < 0.000001);
          assert.equal(point.logFdv, Math.log2(point.fdvUsd));
          assert(Number.isFinite(point.logFdv));
        }
        completedPercent += rangePercent;
      }
      for (let index = 1; index < model.points.length; index++) {
        assert(model.points[index].soldAmount > model.points[index - 1].soldAmount);
        assert(model.points[index].fdvUsd > model.points[index - 1].fdvUsd);
      }
    }
    const zero = sampleInitialLaunchCurve({ quotePriceUsd: Number(quotePriceUsd), quoteDecimals: stock.decimals });
    const one = sampleInitialLaunchCurve({ quotePriceUsd: Number(quotePriceUsd), quoteDecimals: stock.decimals, tokenIsCurrency0: false });
    assert.deepEqual(zero.points.map((point) => point.fdvUsd), one.points.map((point) => point.fdvUsd));
  });
}

test("initial curve rejects an unavailable price or invalid asset decimals", () => {
  for (const quotePriceUsd of [0, -1, NaN, Infinity])
    assert.throws(() => sampleInitialLaunchCurve({ quotePriceUsd, quoteDecimals: 18 }), /valid paired asset/);
  for (const quoteDecimals of [-1, 6.5, 19, NaN])
    assert.throws(() => sampleInitialLaunchCurve({ quotePriceUsd: 1, quoteDecimals }), /valid paired asset/);
});
