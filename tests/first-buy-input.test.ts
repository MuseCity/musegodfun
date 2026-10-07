import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { firstBuyUsdReference, usdFirstBuyAmount } from "../src/lib/first-buy-input";
test("USD buttons preserve token precision and never round above the selected dollar budget", () => {
  for (const dollars of [10, 20, 50, 100]) for (const decimals of [6, 8, 18]) {
    const amount = usdFirstBuyAmount(dollars, "3.00123456789", decimals);
    const raw = parseUnits(amount, decimals), reference = Number(firstBuyUsdReference(raw, "3.00123456789", decimals));
    assert(reference <= dollars); assert(reference > dollars - 0.00001);
    assert((amount.split(".")[1]?.length ?? 0) <= decimals);
  }
  assert.equal(usdFirstBuyAmount(10, "2719.06", 18), "0.003677741572455186");
  assert.equal(firstBuyUsdReference(10_000_000n, "1.0011537782", 6), "10.011537");
});
test("missing, zero, hostile and out-of-range prices cannot generate a payment shortcut", () => {
  for (const price of ["", "0", "-1", "NaN", "Infinity", "1e8", "1;console.log(1)", "0.000000000000000000000000000000000001"])
    assert.throws(() => usdFirstBuyAmount(10, price, 18));
  for (const decimals of [-1, 1.5, 19]) assert.throws(() => usdFirstBuyAmount(10, "1", decimals));
  assert.throws(() => usdFirstBuyAmount(11, "1", 6));
});
