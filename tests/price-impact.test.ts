import test from "node:test";
import assert from "node:assert/strict";
import { priceImpact, impactAcknowledged, impactText } from "../src/lib/price-impact";

const q96 = 2n ** 96n;
const state = (sqrt = q96, feeBps: number | null = 100) => ({ sqrtPriceX96: String(sqrt), blockNumber: "123", zeroForOne: true, feeBps });
test("impact removes verified fees and retains exact tiny and uint128-sized amounts", () => {
  for (const amount of [100n, 10n ** 18n, 10n ** 36n]) {
    const impact = priceImpact({ amountIn: String(amount), amountOut: String(amount * 99n / 100n), poolPrice: state() });
    assert.equal(impact?.percentMicros, 0n); assert.equal(impact?.includesFees, false);
  }
  assert.equal(priceImpact({ amountIn: "10000", amountOut: "9405", poolPrice: state() })?.percentMicros, 5_000_000n);
  assert.equal(priceImpact({ amountIn: "10000", amountOut: "8415", poolPrice: state() })?.requiresAcknowledgment, true);
  assert.equal(priceImpact({ amountIn: "10000", amountOut: "8416", poolPrice: state() })?.requiresAcknowledgment, false);
});
test("raw sqrt price and raw amounts cancel decimals in both directions", () => {
  const poolPrice = state(q96 * 10n ** 6n, 0);
  assert.equal(priceImpact({ amountIn: "1000000", amountOut: "950000000000000000", poolPrice })?.percentMicros, 5_000_000n);
  assert.equal(priceImpact({ amountIn: "1000000000000000000", amountOut: "950000", poolPrice: { ...poolPrice, zeroForOne: false } })?.percentMicros, 5_000_000n);
  assert.equal(priceImpact({ amountIn: "10000", amountOut: "20000", poolPrice: state() })?.warning, false);
});
test("unknown fees are labelled; missing or invalid state never invents an impact", () => {
  const impact = priceImpact({ amountIn: "10000", amountOut: "9900", poolPrice: state(q96, null) });
  assert.equal(impact?.percentMicros, 1_000_000n); assert.equal(impact?.includesFees, true);
  for (const input of [{}, { amountIn: "0", amountOut: "1", poolPrice: state() },
    { amountIn: "1", amountOut: "1", poolPrice: state(0n) }, { amountIn: "wat", amountOut: "1", poolPrice: state() }])
    assert.equal(priceImpact(input as any), null);
  assert.equal(impactText(5_123_456n), "5.12%");
});
test("15% acknowledgment binds to the exact quote object and resets on replacement", () => {
  const q = { amountIn: "10000", amountOut: "8415", poolPrice: state() };
  assert.equal(impactAcknowledged(q, null), false);
  assert.equal(impactAcknowledged(q, q), true);
  assert.equal(impactAcknowledged({ ...q }, q), false);
  assert.equal(impactAcknowledged({ ...q, amountOut: "9800" }, null), true);
  assert.equal(impactAcknowledged(null, null), true);
});
