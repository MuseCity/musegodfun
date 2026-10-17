import test from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters } from "viem";
import { CONTRACTS, ROBINHOOD_CONTRACTS, type RuntimeConfig } from "../src/lib/config";
import { wrappedEther } from "../src/lib/first-buy-payment";
import { executeWethEthTrade } from "../src/lib/weth-eth-trade";
import { routerAbi, wrapAndSwapTransaction } from "../src/lib/protocol";
import type { SwapQuote } from "../src/lib/eth-buy";

const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663 } as RuntimeConfig;
const coin = "0x1111111111111111111111111111111111111111", weth = wrappedEther(4663);
const quote: SwapQuote = { token: coin, side: "buy", amountIn: "100", amountOut: "1000", currencyIn: weth,
  poolKey: { currency0: weth, currency1: coin, fee: 8388608, tickSpacing: 10, hooks: ROBINHOOD_CONTRACTS.initializer },
  slippageBps: 100, quotedAt: 1_000, expiresAt: 61_000 };
function fixture() {
  const calls: string[] = [], transactions: unknown[] = [];
  let now = 1_000, balance = 1_000n, changed = false;
  const deps = {
    now: () => now, guard: async () => { calls.push("guard"); if (changed) throw new Error("Account changed"); },
    balance: async () => balance, blockTimestamp: async () => 500n,
    simulate: async (tx: unknown) => { calls.push("simulate"); transactions.push(tx); },
    fundedGas: async (tx: unknown) => { calls.push("fundedGas"); transactions.push(tx); return 500_000n; },
    send: async (tx: unknown, gas: bigint) => { calls.push("send"); transactions.push(tx); assert.equal(gas, 500_000n); return `0x${"1".repeat(64)}` as const; },
    confirmed: async (hash: `0x${string}`) => { calls.push("confirmed"); return hash; }, progress: (_message: string) => {},
  };
  return { deps, calls, transactions, expire: () => { now = quote.expiresAt; }, short: () => { balance = 99n; }, change: () => { changed = true; } };
}

test("native WETH wallet flow simulates, funds and sends the identical builder transaction once without approvals", async () => {
  const f = fixture(); await executeWethEthTrade(quote, config, f.deps);
  const tx = wrapAndSwapTransaction(quote.poolKey, weth, 100n, 1_000n, 100, 800n);
  assert.deepEqual(f.transactions, [tx, tx, tx]);
  assert.deepEqual(f.calls.filter(c => c !== "guard"), ["simulate", "fundedGas", "send", "confirmed"]);
});

test("native WETH wallet flow refuses expired quotes, wrong side, coin, network and insufficient ETH before sending", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.expire(), (f: ReturnType<typeof fixture>) => f.short()]) {
    const f = fixture(); mutate(f); await assert.rejects(executeWethEthTrade(quote, config, f.deps)); assert(!f.calls.includes("send"));
  }
  for (const changed of [{ side: "sell" as const }, { token: weth }]) {
    const f = fixture(); await assert.rejects(executeWethEthTrade({ ...quote, ...changed }, config, f.deps)); assert(!f.calls.includes("send"));
  }
  const f = fixture(); await assert.rejects(executeWethEthTrade(quote, { ...config, chainId: 8453 }, f.deps), /network/i);
});

const baseConfig = { ...config, mode: "base", chainId: 8453, deploymentChainId: 8453 } as RuntimeConfig;
const baseWeth = wrappedEther(8453);
const baseQuote: SwapQuote = { ...quote, currencyIn: baseWeth,
  poolKey: { ...quote.poolKey, currency0: baseWeth, hooks: CONTRACTS.initializer } };
test("Base native WETH buys simulate, fund and send the Base builder transaction", async () => {
  const f = fixture();
  await executeWethEthTrade(baseQuote, baseConfig, f.deps);
  const tx = wrapAndSwapTransaction(baseQuote.poolKey, baseWeth, 100n, 1_000n, 100, 800n, CONTRACTS, 8453);
  assert.equal(tx.to, CONTRACTS.router);
  assert.deepEqual(f.transactions, [tx, tx, tx]);
  assert.deepEqual(f.calls.filter(c => c !== "guard"), ["simulate", "fundedGas", "send", "confirmed"]);
});

test("native WETH buys refuse forks and wrong wallet chains before any wallet work", async () => {
  for (const runtime of [config, baseConfig]) for (const invalid of [{ ...runtime, mode: "fork" as const },
    { ...runtime, chainId: 31337 }, { ...runtime, chainId: runtime.chainId === 4663 ? 8453 : 4663 }]) {
    const f = fixture();
    await assert.rejects(executeWethEthTrade(runtime.chainId === 4663 ? quote : baseQuote, invalid, f.deps));
    assert.deepEqual(f.calls, []);
  }
});

test("Base wrap-and-swap uses native value, Base WETH and the same commands and actions as Robinhood", () => {
  const build = (chainId: 4663 | 8453) => {
    const contracts = chainId === 4663 ? ROBINHOOD_CONTRACTS : CONTRACTS, currencyIn = wrappedEther(chainId);
    return wrapAndSwapTransaction({ ...quote.poolKey, currency0: currencyIn }, currencyIn, 100n, 1_000n, 100, 800n, contracts, chainId);
  };
  const base = build(8453), robinhood = build(4663);
  assert.equal(base.to, CONTRACTS.router); assert.equal(base.value, 100n); assert.equal(base.minOut, 990n);
  const decode = (tx: typeof base) => {
    const outer = decodeFunctionData({ abi: routerAbi, data: tx.data });
    assert.equal(outer.functionName, "execute");
    const [commands, inputs, deadline] = outer.args!;
    const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[1]);
    return { commands, inputs, deadline, actions, params };
  };
  const b = decode(base), r = decode(robinhood);
  assert.equal(b.commands, "0x0b10"); assert.equal(b.commands, r.commands);
  assert.equal(b.actions, "0x060b0f"); assert.equal(b.actions, r.actions);
  assert.equal(b.deadline, r.deadline); assert.equal(b.inputs[0], r.inputs[0]);
  assert.deepEqual(decodeAbiParameters(parseAbiParameters("address,uint256"), b.inputs[0]),
    ["0x0000000000000000000000000000000000000002", 100n]);
  assert.deepEqual(decodeAbiParameters(parseAbiParameters("address,uint256,bool"), b.params[1]),
    ["0x4200000000000000000000000000000000000006", 100n, false]);
  assert.equal(b.params[2], r.params[2]);
  // Base retains its deployed five-field exact-input ABI; Robinhood includes minHopPriceX36.
  const [swap] = decodeAbiParameters(parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)"), b.params[0]);
  assert.equal(swap.poolKey.currency0, baseWeth); assert.equal(swap.amountIn, 100n);
  assert.equal(swap.amountOutMinimum, 990n); assert.equal(swap.zeroForOne, true); assert.equal(swap.hookData, "0x");
  assert.throws(() => wrapAndSwapTransaction(baseQuote.poolKey, baseWeth, 100n, 1_000n, 100, 800n, ROBINHOOD_CONTRACTS, 8453), /router/i);
  assert.throws(() => wrapAndSwapTransaction(baseQuote.poolKey, coin, 100n, 1_000n, 100, 800n, CONTRACTS, 8453), /WETH/);
});

test("native WETH wallet flow rechecks expiry and live account after funding and stops on simulation failure", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.expire(), (f: ReturnType<typeof fixture>) => f.change()]) {
    const f = fixture(), funded = f.deps.fundedGas;
    f.deps.fundedGas = async tx => { const gas = await funded(tx); mutate(f); return gas; };
    await assert.rejects(executeWethEthTrade(quote, config, f.deps)); assert(!f.calls.includes("send"));
  }
  const f = fixture(); f.deps.simulate = async () => { throw new Error("Simulation reverted"); };
  await assert.rejects(executeWethEthTrade(quote, config, f.deps), /Simulation reverted/); assert(!f.calls.includes("send"));
});


test("expired native quotes direct the user to Refresh even after the automatic cap", async () => {
  const f = fixture(); f.expire();
  await assert.rejects(executeWethEthTrade(quote, config, f.deps), /The quote has expired\. Refresh the quote and try again\./);
});
