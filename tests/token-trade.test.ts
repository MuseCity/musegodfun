import test from "node:test";
import assert from "node:assert/strict";
import { wrappedEther } from "../src/lib/first-buy-payment";
import { ROBINHOOD_STOCKS, STOCKS, type RuntimeConfig } from "../src/lib/config";
import { tradeRoute, tradeAutoQuoteInput } from "../src/lib/token-trade";

const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663 } as RuntimeConfig;
const base = { ...config, mode: "base", chainId: 8453, deploymentChainId: 8453 } as RuntimeConfig;
const weth = wrappedEther(4663), pair = ROBINHOOD_STOCKS.find(s => s.symbol === "COST")!.address;
for (const [side, payWith, pairAddress, network, expected] of [
  ["buy", "eth", weth, config, "native"], ["buy", "pair", weth, config, "permit2"],
  ["buy", "eth", weth.toUpperCase(), config, "native"], ["buy", "eth", pair, config, "lifi"],
  ["buy", "pair", pair, config, "permit2"], ["sell", "eth", weth, config, "permit2"],
  ["sell", "pair", pair, config, "permit2"], ["buy", "eth", weth, base, "permit2"],
  ["buy", "pair", STOCKS[0].address, base, "permit2"], ["buy", "eth", weth, null, "permit2"],
  ["buy", "eth", null, config, "permit2"],
] as const) test(`payment route: ${side}/${payWith}/${pairAddress}/${network?.chainId} -> ${expected}`, () => {
  assert.equal(tradeRoute({ side, payWith, pairAddress, config: network }), expected);
});

const poolKey = { currency0: weth, currency1: pair, fee: 8388608, tickSpacing: 10, hooks: pair };
const fields = { address: pair, side: "buy" as const, payWith: "eth" as const, amount: "0.001", slippage: 100,
  account: null, walletChainId: null, config, poolKey, stateInvalid: false, inputDecimals: 18,
  route: "native" as const, busy: false, confirmed: false, ethHeld: false };
test("auto-quote derivation preserves guests and Base, and every quote identity change supersedes prior work", () => {
  const original = tradeAutoQuoteInput(fields);
  assert.deepEqual({ ...original, key: "identity" }, { key: "identity", lifi: false, valid: true, pool: true, busy: false, completed: false, connected: false });
  for (const change of [{ address: weth }, { side: "sell" as const }, { payWith: "pair" as const }, { amount: "0.002" },
    { slippage: 50 }, { account: pair }, { walletChainId: 8453 }, { config: base },
    { config: { ...config, chainId: 31337 } }, { poolKey: { ...poolKey, fee: 3000 } }]) {
    assert.notEqual(tradeAutoQuoteInput({ ...fields, ...change }).key, original.key, JSON.stringify(change));
  }
  assert.equal(tradeAutoQuoteInput({ ...fields, config: base, route: "permit2" }).valid, true);
  assert.equal(tradeAutoQuoteInput({ ...fields, route: "lifi" }).lifi, true);
  assert.equal(tradeAutoQuoteInput({ ...fields, account: pair }).connected, true);
});
test("auto-quote derivation validates the selected unit and separates completed results from active execution", () => {
  for (const amount of ["", "0", "-1", "NaN", "0.0000001", (2n ** 128n).toString()])
    assert.equal(tradeAutoQuoteInput({ ...fields, amount, inputDecimals: 6 }).valid, false, amount);
  assert.equal(tradeAutoQuoteInput({ ...fields, amount: "0.000001", inputDecimals: 6 }).valid, true);
  for (const change of [{ config: null }, { poolKey: undefined }, { stateInvalid: true }])
    assert.equal(tradeAutoQuoteInput({ ...fields, ...change }).pool, false);
  assert.equal(tradeAutoQuoteInput({ ...fields, busy: true }).busy, true);
  assert.equal(tradeAutoQuoteInput({ ...fields, confirmed: true }).completed, true);
  assert.equal(tradeAutoQuoteInput({ ...fields, route: "lifi", ethHeld: true }).busy, true);
  assert.equal(tradeAutoQuoteInput({ ...fields, ethHeld: true }).busy, false);
});
