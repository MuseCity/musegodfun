/** Display-only pool state. Raw sqrt price and raw amounts already include both token decimals. */
export type PoolPrice = { sqrtPriceX96: string; blockNumber: string; zeroForOne: boolean; feeBps: number | null };
export type ImpactQuote = { amountIn: string; amountOut: string; poolPrice?: PoolPrice };
export function priceImpact(quote: ImpactQuote | null | undefined) {
  const state = quote?.poolPrice;
  if (!quote || !state || !/^\d{1,78}$/.test(quote.amountIn) || !/^\d{1,78}$/.test(quote.amountOut) ||
    !/^\d{1,49}$/.test(state.sqrtPriceX96) || typeof state.zeroForOne !== "boolean" ||
    (state.feeBps !== null && (!Number.isInteger(state.feeBps) || state.feeBps < 0 || state.feeBps >= 10_000))) return null;
  const amountIn = BigInt(quote.amountIn), amountOut = BigInt(quote.amountOut), sqrt = BigInt(state.sqrtPriceX96);
  if (amountIn <= 0n || amountOut <= 0n || sqrt <= 0n || sqrt >= 2n ** 160n) return null;
  const square = sqrt * sqrt, q192 = 2n ** 192n;
  const numerator = state.zeroForOne ? square : q192, denominator = state.zeroForOne ? q192 : square;
  const expected = amountIn * numerator * BigInt(10_000 - (state.feeBps ?? 0));
  const percentMicros = (expected - amountOut * denominator * 10_000n) * 100_000_000n / expected;
  return { percentMicros, includesFees: state.feeBps === null, warning: percentMicros >= 5_000_000n,
    requiresAcknowledgment: percentMicros >= 15_000_000n };
}
export function impactText(percentMicros: bigint) {
  const hundredths = (percentMicros < 0n ? -percentMicros : percentMicros) / 10_000n;
  return `${percentMicros < 0n && hundredths > 0n ? "-" : ""}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}%`;
}
export function impactAcknowledged<T extends ImpactQuote>(quote: T | null, acknowledged: T | null) {
  return !priceImpact(quote)?.requiresAcknowledgment || quote === acknowledged;
}
