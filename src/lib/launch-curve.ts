import {
  getMaxLiquiditySafeMulticurveTickUpper,
  getSqrtRatioAtTick,
  marketCapToTicksForMulticurve,
  tickToMarketCap,
  type MulticurveMarketCapRangeCurve,
} from "@whetstone-research/doppler-sdk/evm";
import { SUPPLY, WAD } from "./config";
import { OPENING_CAP_USD } from "./opening-valuation";

export const CURVE_POLICY = "multicurve-97-3-v1";
export type CurvePolicy = typeof CURVE_POLICY;
export const LAUNCH_CURVE_SHARES_BPS = [
  2067, 1473, 1050, 748, 533, 380, 271, 293, 325,
  353, 346, 323, 302, 282, 264, 246, 230, 214,
] as const;
export const LAUNCH_CURVE_TAIL_BPS = 300;
export const LAUNCH_CURVE_MAIN_END_USD = OPENING_CAP_USD * 2 ** LAUNCH_CURVE_SHARES_BPS.length;
export const LAUNCH_CURVE_TICK_SPACING = 10;
export const LAUNCH_CURVE_CONFIG: readonly MulticurveMarketCapRangeCurve[] = Object.freeze([
  ...LAUNCH_CURVE_SHARES_BPS.map((bps, index) => ({
    marketCap: Object.freeze({ start: OPENING_CAP_USD * 2 ** index, end: OPENING_CAP_USD * 2 ** (index + 1) }),
    numPositions: 1,
    shares: WAD * BigInt(bps) / 10_000n,
  })),
  {
    marketCap: Object.freeze({ start: LAUNCH_CURVE_MAIN_END_USD, end: "max" as const }),
    numPositions: 1,
    shares: WAD * BigInt(LAUNCH_CURVE_TAIL_BPS) / 10_000n,
  },
].map((curve) => Object.freeze(curve)));

export function buildLaunchCurves(): MulticurveMarketCapRangeCurve[] {
  return LAUNCH_CURVE_CONFIG.map((curve) => ({ ...curve, marketCap: { ...curve.marketCap } }));
}

export type InitialLaunchCurveInput = {
  quotePriceUsd: number;
  quoteDecimals: number;
  tokenIsCurrency0?: boolean;
};
export type InitialLaunchCurvePoint = {
  tick: number;
  soldAmount: bigint;
  soldPercent: number;
  fdvUsd: number;
  logFdv: number;
};
export type InitialLaunchCurve = {
  points: InitialLaunchCurvePoint[];
  openingFdvUsd: number;
  mainEndFdvUsd: number;
  tailEndFdvUsd: number;
};

const Q96 = 1n << 96n;

// SDK 1.0.43 truncates Q96 prices. v4 TickMath rounds up; zero is exact.
function sqrtPriceAtTick(tick: number): bigint {
  return getSqrtRatioAtTick(tick) + (tick === 0 ? 0n : 1n);
}

/**
 * Initial locked-position model, excluding fees and other LPs. Points cover
 * the 97% main range; the finite 3% tail is disclosed separately in the UI.
 * Uses the same SDK ticks/tail bound as issuance and Multicurve's supply-minus-
 * one mint rule, Solidity LiquidityAmounts rounding and token-order inversion.
 */
export function sampleInitialLaunchCurve(input: InitialLaunchCurveInput): InitialLaunchCurve {
  if (!Number.isFinite(input.quotePriceUsd) || input.quotePriceUsd <= 0 ||
    !Number.isInteger(input.quoteDecimals) || input.quoteDecimals < 0 || input.quoteDecimals > 18)
    throw new Error("A valid paired asset price and decimals are required for the launch curve");
  const tokenIsCurrency0 = input.tokenIsCurrency0 ?? true;
  const positions = LAUNCH_CURVE_CONFIG.map((curve) => {
    const ticks = marketCapToTicksForMulticurve({
      marketCapLower: curve.marketCap.start,
      marketCapUpper: curve.marketCap.end,
      tokenSupply: SUPPLY,
      numerairePriceUSD: input.quotePriceUsd,
      tickSpacing: LAUNCH_CURVE_TICK_SPACING,
      tokenDecimals: 18,
      numeraireDecimals: input.quoteDecimals,
    });
    const curveSupply = SUPPLY * curve.shares / WAD;
    const upper = curve.marketCap.end === "max" ? getMaxLiquiditySafeMulticurveTickUpper({
      ...ticks, tickSpacing: LAUNCH_CURVE_TICK_SPACING, numPositions: 1, curveSupply,
    }) : ticks.tickUpper;
    const tickLower = (tokenIsCurrency0 ? ticks.tickLower : -upper) || 0;
    const tickUpper = (tokenIsCurrency0 ? upper : -ticks.tickLower) || 0;
    const lowerSqrt = sqrtPriceAtTick(tickLower), upperSqrt = sqrtPriceAtTick(tickUpper);
    const liquidity = tokenIsCurrency0
      ? (curveSupply - 1n) * (lowerSqrt * upperSqrt / Q96) / (upperSqrt - lowerSqrt)
      : (curveSupply - 1n) * Q96 / (upperSqrt - lowerSqrt);
    return { tickLower, tickUpper, lowerSqrt, upperSqrt, liquidity };
  });
  const fdvAt = (tick: number) => tickToMarketCap({
    tick, tokenIsToken0: tokenIsCurrency0, tokenSupply: SUPPLY,
    numerairePriceUSD: input.quotePriceUsd, tokenDecimals: 18, numeraireDecimals: input.quoteDecimals,
  });
  const points: InitialLaunchCurvePoint[] = [];
  let completedAmount = 0n;
  for (const position of positions.slice(0, LAUNCH_CURVE_SHARES_BPS.length)) {
    const startTick = tokenIsCurrency0 ? position.tickLower : position.tickUpper;
    const endTick = tokenIsCurrency0 ? position.tickUpper : position.tickLower;
    for (let sample = points.length === 0 ? 0 : 1; sample <= 8; sample++) {
      const tick = startTick + Math.trunc((endTick - startTick) * sample / 8);
      const sqrt = sqrtPriceAtTick(tick);
      // SqrtPriceMath output deltas round down, as in an exact-input buy.
      const soldInPosition = tokenIsCurrency0
        ? position.liquidity * Q96 * (sqrt - position.lowerSqrt) / (sqrt * position.lowerSqrt)
        : position.liquidity * (position.upperSqrt - sqrt) / Q96;
      const soldAmount = completedAmount + soldInPosition;
      const fdvUsd = fdvAt(tick);
      points.push({ tick, soldAmount, soldPercent: Number(soldAmount) * 100 / Number(SUPPLY), fdvUsd, logFdv: Math.log2(fdvUsd) });
    }
    completedAmount = points.at(-1)!.soldAmount;
  }
  const tail = positions.at(-1)!;
  return {
    points,
    openingFdvUsd: points[0].fdvUsd,
    mainEndFdvUsd: points.at(-1)!.fdvUsd,
    tailEndFdvUsd: fdvAt(tokenIsCurrency0 ? tail.tickUpper : tail.tickLower),
  };
}
