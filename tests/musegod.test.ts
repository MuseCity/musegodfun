import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, keccak256, type Address, type Hash, type PublicClient, type WalletClient } from "viem";
import { MusegodReader } from "../server/musegod";
import type { LaunchpadService } from "../server/service";
import type { RuntimeConfig } from "../src/lib/config";
import {
  MUSEGOD, MUSEGOD_ROUTER_VERIFICATION, assertMusegodQuote, assertMusegodTradingEnabled,
  musegodRouterAbi, musegodSwapTransaction, type MusegodQuote,
} from "../src/lib/musegod";
import { executeMusegodTrade, type MusegodTradeDependencies } from "../src/lib/musegod-trade";
const account = "0x1111111111111111111111111111111111111111" as Address;
const hash = `0x${"a".repeat(64)}` as Hash;
const config: RuntimeConfig = { mode: "robinhood", deploymentChainId: 4663, chainId: 4663,
  treasury: account, writesEnabled: true, blockReason: null };
const quote = (side: "buy" | "sell" = "buy"): MusegodQuote => {
  const now = Date.now();
  return { protocol: "sushi-v3", chainId: 4663, deploymentChainId: 4663, token: MUSEGOD.token,
    poolAddress: MUSEGOD.pool, side, amountIn: "1000", amountOut: "2000", minAmountOut: "1980",
    slippageBps: 100, quotedAt: now, expiresAt: now + 60_000, blockNumber: "10", blockHash: hash };
};
test("MUSEGOD calldata delivers native buy/sell outputs to the intended account and enforces the outer deadline", () => {
  for (const side of ["buy", "sell"] as const) {
    const q = quote(side), tx = musegodSwapTransaction(q, account, config);
    const outer = decodeFunctionData({ abi: musegodRouterAbi, data: tx.data });
    assert.equal(outer.functionName, "multicall");
    if (outer.functionName !== "multicall") throw new Error("wrong calldata");
    assert.equal(outer.args[0], BigInt(Math.floor(q.expiresAt / 1000)));
    assert.equal(tx.value, side === "buy" ? 1000n : 0n);
    assert.equal(tx.to, MUSEGOD.router);
    const swap = decodeFunctionData({ abi: musegodRouterAbi, data: outer.args[1][0] });
    assert.equal(swap.functionName, "exactInputSingle");
    if (swap.functionName !== "exactInputSingle") throw new Error("wrong swap");
    const params = swap.args[0];
    assert.equal(params.tokenIn, side === "buy" ? MUSEGOD.weth : MUSEGOD.token);
    assert.equal(params.tokenOut, side === "buy" ? MUSEGOD.token : MUSEGOD.weth);
    assert.equal(params.recipient, side === "buy" ? account : MUSEGOD.router);
    assert.equal(params.amountOutMinimum, 1980n);
    assert.equal(params.fee, 10000);
    const payment = decodeFunctionData({ abi: musegodRouterAbi, data: outer.args[1][1] });
    assert.equal(payment.functionName, side === "buy" ? "refundETH" : "unwrapWETH9");
    if (payment.functionName === "unwrapWETH9") assert.deepEqual(payment.args, [1980n, account]);
  }
});
test("invalid and expired quotes cannot construct calldata; no source gate override exists in runtime config", () => {
  const q = quote();
  for (const change of [
    { token: account }, { poolAddress: account }, { amountIn: "0" }, { amountOut: "-1" },
    { minAmountOut: "1900" }, { slippageBps: 501 }, { side: "unknown" }, { chainId: 8453 },
    { expiresAt: q.quotedAt + 60_001 }, { blockHash: "0x1234" }, { blockNumber: "-1" },
  ]) assert.throws(() => assertMusegodQuote({ ...q, ...change } as MusegodQuote, config));
  assert.throws(() => assertMusegodQuote(q, config, q.expiresAt), /expired/);
  assert.throws(() => assertMusegodQuote(q, { ...config, mode: "base", chainId: 8453 }), /parameters/);
  if (!MUSEGOD_ROUTER_VERIFICATION.verified) assert.throws(() => assertMusegodTradingEnabled(config), /verification is pending/);
  assert(Object.isFrozen(MUSEGOD_ROUTER_VERIFICATION));
});
function readerFixture() {
  let latestHash = hash, amountOut = 2000n, networkOk = true;
  const reads: { functionName: string; blockNumber?: bigint; args?: unknown[] }[] = [];
  const overrides: Record<string, unknown> = {};
  const client = {
    getBlock: async (args?: { blockNumber?: bigint }) => ({ number: 10n, hash: args?.blockNumber ? latestHash : hash }),
    getCode: async () => "0x1234",
    readContract: async (args: { functionName: string; address: Address; blockNumber?: bigint }) => {
      reads.push(args);
      if (args.functionName in overrides) return overrides[args.functionName];
      switch (args.functionName) {
        case "name": return "MUSEGOD";
        case "symbol": return args.address === MUSEGOD.weth ? "WETH" : "MUSEGOD";
        case "decimals": return 18;
        case "totalSupply": return 10n ** 27n;
        case "token0": return MUSEGOD.token;
        case "token1": case "WETH9": return MUSEGOD.weth;
        case "factory": return MUSEGOD.factory;
        case "getPool": return MUSEGOD.pool;
        case "fee": return 10000;
        case "liquidity": return 100n;
        case "slot0": return [1n, 0, 0, 0, 0, 0, true];
      }
      throw new Error("unknown mock call");
    },
    simulateContract: async (args: { functionName: string; blockNumber: bigint; args: unknown[] }) => {
      reads.push(args); return { result: [amountOut, 1n, 0, 100n] };
    },
  } as unknown as LaunchpadService["client"];
  const reader = new MusegodReader(client, config, async () => { if (!networkOk) throw new Error("wrong network"); });
  return { reader, client, reads, overrides,
    reorg: () => { latestHash = `0x${"b".repeat(64)}`; },
    noOutput: () => { amountOut = 0n; }, wrongNetwork: () => { networkOk = false; } };
}
test("quotes use correct directions, integer amounts and one canonical block, independent of market APIs", async () => {
  const f = readerFixture();
  // Quote previews only require the pinned token, pool and official Quoter.
  for (const side of ["buy", "sell"] as const) {
    const q = await f.reader.quote(side, "0.001", 100);
    assert.equal(q.amountIn, "1000000000000000"); assert.equal(q.minAmountOut, "1980");
    assert.equal(q.expiresAt - q.quotedAt, 60_000);
    assert(f.reads.every((read) => read.blockNumber === 10n));
    const args = f.reads.at(-1)!.args![0] as { tokenIn: Address; tokenOut: Address };
    assert.equal(args.tokenIn, side === "buy" ? MUSEGOD.weth : MUSEGOD.token);
    assert.equal(args.tokenOut, side === "buy" ? MUSEGOD.token : MUSEGOD.weth);
  }
});
test("on-chain identity, amount, liquidity, network and canonical-block failures reject quote previews", async () => {
  for (const [field, value] of Object.entries({ token0: account, token1: account, factory: account,
    fee: 500, liquidity: 0n, decimals: 6, getPool: account, WETH9: account, slot0: [1n, 0, 0, 0, 0, 0, false] })) {
    const f = readerFixture(); f.overrides[field] = value;
    await assert.rejects(() => f.reader.quote("buy", "1", 100));
  }
  for (const amount of ["0", "-1", "0.0000000000000000001", "1e18"]) await assert.rejects(() => readerFixture().reader.quote("buy", amount, 100));
  const reorg = readerFixture(); reorg.reorg(); await assert.rejects(() => reorg.reader.quote("buy", "1", 100), /block changed/);
  const noOutput = readerFixture(); noOutput.noOutput(); await assert.rejects(() => noOutput.reader.quote("buy", "1", 100), /liquidity/);
  const network = readerFixture(); network.wrongNetwork(); await assert.rejects(() => network.reader.quote("buy", "1", 100), /network/);
  const info = await network.reader.info(); assert.equal(info.totalSupply, null); assert.equal(info.tradeEnabled, false);
});
function tradeFixture() {
  const events: string[] = [], requests: Record<string, unknown>[] = [];
  let nativeBalance = 1000000n, tokenBalance = 5000n, allowance = 0n, blockHash = hash, expiry = false, disabled = false;
  const q = quote("sell");
  const client = {
    getBlock: async () => ({ hash: blockHash }), getCode: async () => "0x1234",
    readContract: async ({ functionName }: { functionName: string }) => functionName === "balanceOf" ? tokenBalance : allowance,
    simulateContract: async (request: Record<string, unknown>) => { events.push("simulate approval"); return { request }; },
    estimateContractGas: async () => 10n, estimateGas: async () => 20n,
    getBalance: async () => nativeBalance, estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
    call: async () => { events.push("simulate swap"); },
  } as unknown as PublicClient;
  const wallet = { chain: undefined,
    writeContract: async (request: Record<string, unknown>) => { requests.push(request); events.push("approve"); return hash; },
    sendTransaction: async (request: Record<string, unknown>) => { requests.push(request); events.push("send"); return hash; },
  } as unknown as WalletClient;
  const deps: MusegodTradeDependencies = { account, client, routerCodeHash: keccak256("0x1234"),
    assertEnabled: () => { if (disabled) throw new Error("signing disabled"); },
    signer: async (validate) => { await validate(); events.push("signer"); return wallet; },
    confirmed: async (_hash, action) => { events.push(`confirmed ${action}`); if (action === "approval" && expiry) {
      q.expiresAt = Date.now() - 1; q.quotedAt = q.expiresAt - 60_000;
    } return hash; },
    progress: () => {}, onHash: () => { events.push("onHash"); },
  };
  return { q, deps, events, requests, expireAfterApproval: () => { expiry = true; },
    disable: () => { disabled = true; }, noGas: () => { nativeBalance = 0n; },
    noTokens: () => { tokenBalance = 0n; }, reuseApproval: () => { allowance = 5000n; },
    reorg: () => { blockHash = `0x${"b".repeat(64)}`; } };
}
test("sell authorizes only exact MUSEGOD input, simulates both steps and records swap before UI notification", async () => {
  const f = tradeFixture(); await executeMusegodTrade(f.q, config, f.deps);
  assert.deepEqual(f.requests[0].args, [MUSEGOD.router, 1000n]);
  assert.equal(f.requests[1].value, 0n);
  assert(f.events.indexOf("simulate approval") < f.events.indexOf("approve"));
  assert(f.events.indexOf("confirmed approval") < f.events.indexOf("simulate swap"));
  assert(f.events.indexOf("confirmed swap") < f.events.indexOf("onHash"));
});
test("native buy never approves an ERC20, and enough gas must exist before either wallet submission", async () => {
  const buy = tradeFixture(); buy.q.side = "buy"; await executeMusegodTrade(buy.q, config, buy.deps);
  assert.equal(buy.requests.length, 1); assert.equal(buy.requests[0].value, 1000n);
  for (const change of ["noGas", "noTokens", "disable", "reorg"] as const) {
    const f = tradeFixture(); f[change](); await assert.rejects(() => executeMusegodTrade(f.q, config, f.deps));
    assert.equal(f.requests.length, 0);
  }
});
test("approval expiry stops the swap, existing approval is reused and pending confirmation never resubmits", async () => {
  const expired = tradeFixture(); expired.expireAfterApproval();
  await assert.rejects(() => executeMusegodTrade(expired.q, config, expired.deps), /expired/);
  assert.equal(expired.requests.length, 1);
  const reused = tradeFixture(); reused.reuseApproval(); await executeMusegodTrade(reused.q, config, reused.deps);
  assert.equal(reused.requests.length, 1);
  const pending = tradeFixture(); pending.q.side = "buy";
  pending.deps.confirmed = async () => { throw new Error("still pending"); };
  await assert.rejects(() => executeMusegodTrade(pending.q, config, pending.deps), /pending/);
  assert.equal(pending.requests.length, 1); assert(pending.events.includes("onHash"));
});
test("missing chain state is reported as unavailable and stops before wallet submission", async () => {
  const f = tradeFixture(); f.q.side = "buy";
  f.deps.client = { ...f.deps.client, call: async () => {
    throw Object.assign(new Error("Missing or invalid parameters"), { details: "historical state abc is not available" });
  } } as unknown as PublicClient;
  await assert.rejects(() => executeMusegodTrade(f.q, config, f.deps), /Chain data.*unavailable.*Nothing was submitted/);
  assert.equal(f.requests.length, 0);
});
