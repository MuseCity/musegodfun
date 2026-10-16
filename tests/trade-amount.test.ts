import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { ethGasReserve, maxTradeAmount } from "../src/lib/trade-amount";

test("Max spends the entire ERC-20 balance without a gas-price dependency", () => {
  assert.equal(maxTradeAmount(123456789n, false), 123456789n);
  assert.equal(maxTradeAmount(0n, false), 0n);
});
test("ETH Max reserves the greater of the floor and double 500,000 gas at maxFeePerGas", () => {
  assert.equal(ethGasReserve({ maxFeePerGas: 1n }), parseEther("0.0002"));
  assert.equal(ethGasReserve({ maxFeePerGas: 2_000_000_000n, gasPrice: 1n }), parseEther("0.002"));
  assert.equal(ethGasReserve({ gasPrice: 1_000_000_000n }), parseEther("0.001"));
  assert.equal(maxTradeAmount(parseEther("1"), true, { maxFeePerGas: 2_000_000_000n }), parseEther("0.998"));
  assert.equal(maxTradeAmount(parseEther("0.0003"), true, { gasPrice: 1n }), parseEther("0.0001"));
  for (const balance of [0n, parseEther("0.0001"), parseEther("0.0002")])
    assert.equal(maxTradeAmount(balance, true, { gasPrice: 1n }), null);
  assert.throws(() => maxTradeAmount(1n, true), /fee estimate/);
});
