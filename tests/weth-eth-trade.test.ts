import test from "node:test";
import assert from "node:assert/strict";
import { ROBINHOOD_CONTRACTS, type RuntimeConfig } from "../src/lib/config";
import { wrappedEther } from "../src/lib/first-buy-payment";
import { executeWethEthTrade } from "../src/lib/weth-eth-trade";
import { wrapAndSwapTransaction } from "../src/lib/protocol";
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
  const f = fixture(); await assert.rejects(executeWethEthTrade(quote, { ...config, chainId: 8453 }, f.deps), /Robinhood/);
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
