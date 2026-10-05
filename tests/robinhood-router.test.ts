import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, type Address } from "viem";
import { CONTRACTS, ROBINHOOD_CONTRACTS } from "../src/lib/config";
import { routerAbi, swapTransaction } from "../src/lib/protocol";

const currency0 = "0x0000000000000000000000000000000000000001" as Address;
const currency1 = "0x0000000000000000000000000000000000000002" as Address;

test("Robinhood router uses its deployed six-field swap ABI with both minimum output guards", () => {
  const poolKey = { currency0, currency1, fee: 8388608, tickSpacing: 10, hooks: ROBINHOOD_CONTRACTS.initializer };
  for (const currencyIn of [currency0, currency1]) {
    const tx = swapTransaction(poolKey, currencyIn, 123456789n, 987654321n, 100, 999n, ROBINHOOD_CONTRACTS);
    const outer = decodeFunctionData({ abi: routerAbi, data: tx.data });
    assert.equal(tx.to, ROBINHOOD_CONTRACTS.router);
    assert.equal(tx.value, 0n);
    assert.equal(outer.args[0], "0x10");
    assert.equal(outer.args[2], 999n);
    const [actions, encoded] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), outer.args[1][0]);
    assert.equal(actions, "0x060c0f");
    const [swap] = decodeAbiParameters(parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)"), encoded[0]);
    assert.deepEqual(swap.poolKey, poolKey);
    assert.equal(swap.zeroForOne, currencyIn === currency0);
    assert.equal(swap.amountIn, 123456789n);
    assert.equal(swap.amountOutMinimum, tx.minOut);
    assert.equal(swap.minHopPriceX36, 0n);
    assert.equal(swap.hookData, "0x");
    assert.deepEqual(decodeAbiParameters(parseAbiParameters("address,uint256"), encoded[1]), [currencyIn, swap.amountIn]);
    assert.deepEqual(decodeAbiParameters(parseAbiParameters("address,uint256"), encoded[2]), [tx.currencyOut, tx.minOut]);
    const base = swapTransaction({ ...poolKey, hooks: CONTRACTS.initializer }, currencyIn, 123456789n, 987654321n, 100, 999n, CONTRACTS);
    const baseOuter = decodeFunctionData({ abi: routerAbi, data: base.data });
    const [, baseEncoded] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), baseOuter.args[1][0]);
    const [baseSwap] = decodeAbiParameters(parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)"), baseEncoded[0]);
    assert.equal(baseSwap.hookData, "0x");
    assert.equal(baseSwap.amountOutMinimum, tx.minOut);
    assert.equal(encoded[0].length, baseEncoded[0].length + 64);
  }
});
