import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, zeroAddress,
  type Address, type Hex } from "viem";
import { base, robinhood } from "viem/chains";
import { runtimeFromEnv } from "../server/config";
import { FirstBuyPaymentReader } from "../server/lifi";
import { assertFirstBuyPaymentQuote, firstBuyPaymentAbi, firstBuyPaymentAssets, type FirstBuyPaymentQuote } from "../src/lib/first-buy-payment";
import { startChainFork } from "./robinhood-fork";

// Run through scripts/run.ts. Both writes and funding exist only on a fresh
// loopback Anvil fork; the helper blocks upstream writes and hides RPC keys.
const evidence: Record<string, unknown>[] = [];
for (const chainId of [8453, 4663] as const) {
  const runtime = runtimeFromEnv(chainId);
  assert.notEqual(runtime.config.mode, "fork", "Supply mainnet read-only providers for the isolated test forks");
  const fork = await startChainFork(runtime.rpcUrl, chainId);
  try {
    assert.equal(new URL(fork.rpc).hostname, "127.0.0.1");
    const chain = { ...(chainId === 8453 ? base : robinhood), id: 31337, name: "Isolated first-buy payment fork" };
    const client = createPublicClient({ chain, transport: http(fork.rpc, { retryCount: 0, timeout: 30_000 }) });
    const accounts: Address[] = await fork.rpcCall("eth_accounts"), account = accounts[0];
    assert(account);
    const wallet = createWalletClient({ chain, account, transport: http(fork.rpc, { retryCount: 0, timeout: 30_000 }) });
    await fork.rpcCall("anvil_setBalance", [account, `0x${parseEther("100").toString(16)}`]);
    const reader = new FirstBuyPaymentReader({ client, chainId, rpcChainId: 31337, ...runtime.lifi });
    const stable = firstBuyPaymentAssets(chainId).find((asset) => asset.symbol === (chainId === 8453 ? "USDC" : "USDG"))!;
    const output = chainId === 8453 ? firstBuyPaymentAssets(chainId).find((asset) => asset.symbol === "USDT")!
      : firstBuyPaymentAssets(4663, "0x0bd7d308f8e1639fab988df18a8011f41eacad73")[0];
    const balance = (token: Address, holder = account) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    async function send(q: FirstBuyPaymentQuote) {
      assertFirstBuyPaymentQuote(q);
      if (q.approval) {
        await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: q.approval.token, abi: erc20Abi,
          functionName: "approve", args: [q.approval.spender, BigInt(q.approval.amount)] }) });
        assert.equal(await client.readContract({ address: q.approval.token, abi: erc20Abi, functionName: "allowance",
          args: [account, q.approval.spender] }), BigInt(q.approval.amount));
      }
      const before = await balance(q.toToken.address);
      const hash = await wallet.sendTransaction({ to: q.transaction.to, data: q.transaction.data, value: BigInt(q.transaction.value), gas: 2_000_000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        const trace = await fork.rpcCall("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
        await mkdir(".cache", { recursive: true });
        await writeFile(`.cache/lifi-${chainId}-swap-failure.json`, JSON.stringify({ quote: q, hash, trace }, null, 2));
        throw new Error(`LI.FI ${chainId} local fork swap reverted; inspect .cache/lifi-${chainId}-swap-failure.json`);
      }
      assert.equal(receipt.status, "success");
      await fork.rpcCall("anvil_mine", [1]);
      const verified = await reader.verify({ quote: q, hash });
      assert.equal(verified.status, "success");
      assert.equal(await balance(q.toToken.address) - before, BigInt(verified.actualOutput!));
      assert(BigInt(verified.actualOutput!) >= BigInt(q.minimumOut));
      evidence.push({ deploymentChainId: chainId, executionChainId: 31337, forkBlockNumber: String(fork.blockNumber),
        from: q.fromToken.symbol, to: q.toToken.symbol, tool: q.tool, feeAmount: q.feeAmount, feeUsd: q.feeUsd,
        selector: q.transaction.data.slice(0, 10), hash, actualOutput: verified.actualOutput, minimumOut: q.minimumOut,
        routerSourceAndRuntimeMatched: true, matchedCompletionAndNetTransfer: true });
    }
    const native = await reader.quote({ account, fromToken: zeroAddress, toToken: stable.address, amount: "0.01", slippageBps: 100 });
    await send(native);
    const erc20 = await reader.quote({ account, fromToken: stable.address, toToken: output.address, amount: "10", slippageBps: 100 });
    await send(erc20);
    // Raise only the outer minOut to force a real atomic revert. No balance or
    // contract-code replacement is used to manufacture an ERC20 success.
    const failing = await reader.quote({ account, fromToken: zeroAddress, toToken: stable.address, amount: "0.01", slippageBps: 100 });
    const swaps = assertFirstBuyPaymentQuote(failing);
    const minOut = 2n ** 128n;
    const functionName = "swapTokensMultipleV3NativeToERC20";
    const data = encodeFunctionData({ abi: firstBuyPaymentAbi, functionName,
      args: [failing.transactionId, failing.integrator, zeroAddress, account, minOut, swaps] });
    const before = await balance(stable.address);
    const hash = await wallet.sendTransaction({ to: failing.router, data, value: BigInt(failing.transaction.value), gas: 2_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "reverted");
    assert.equal(await balance(stable.address), before);
    assert.equal(receipt.logs.length, 0, "Fee and swap events must roll back together");
    await fork.rpcCall("anvil_mine", [1]);
    await assert.rejects(reader.verify({ quote: failing, hash }), /frozen quote/);
    evidence.push({ deploymentChainId: chainId, executionChainId: 31337, outerMinOutReverted: true,
      feeAndOutputEventsRolledBack: true, hash });
    assert.equal(fork.blockedUpstreamWrites(), 0);
  } finally { await fork.stop(); }
}
await mkdir(".cache", { recursive: true });
await writeFile(".cache/first-buy-payment-fork-evidence.json", JSON.stringify({
  scope: "isolated localhost forks; LI.FI HTTP and upstream RPC were read-only; no mainnet transaction", checkedAt: Date.now(), evidence,
}, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, chains: [8453, 4663], successfulLocalSwaps: 4,
  minOutAtomicReverts: 2, evidence: ".cache/first-buy-payment-fork-evidence.json" }));
