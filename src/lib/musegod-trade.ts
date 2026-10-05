import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import type { RuntimeConfig } from "./config";
import { errorMessage } from "./validation";
import {
  MUSEGOD, assertMusegodQuote, musegodSwapTransaction, type MusegodQuote,
} from "./musegod";

export type MusegodTradeDependencies = {
  account: Address;
  client: PublicClient;
  assertEnabled: () => void;
  routerCodeHash: Hash;
  signer: (validate: () => Promise<void>) => Promise<WalletClient>;
  confirmed: (hash: Hash, action: "approval" | "swap", request: { to: Address; data: Hex; value: bigint; fromBlock: string }) => Promise<Hash>;
  progress: (message: string) => void;
  onHash?: (hash: Hash) => void;
};

export async function executeMusegodTrade(quote: MusegodQuote, config: RuntimeConfig, deps: MusegodTradeDependencies) {
  const { client, account, progress } = deps;
  const validate = async () => {
    deps.assertEnabled();
    assertMusegodQuote(quote, config);
    const [block, code] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(quote.blockNumber) }), client.getCode({ address: MUSEGOD.router }),
    ]);
    if (block.hash !== quote.blockHash || !code || keccak256(code) !== deps.routerCodeHash)
      throw new Error("The quote block or SushiSwap router changed. Request a new quote.");
  };
  deps.assertEnabled();
  const wallet = await deps.signer(validate);
  const amountIn = BigInt(quote.amountIn);
  if (quote.side === "sell") {
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: MUSEGOD.token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: MUSEGOD.token, abi: erc20Abi, functionName: "allowance", args: [account, MUSEGOD.router] }),
    ]);
    if (balance < amountIn) throw new Error("Insufficient available MUSEGOD balance.");
    if (allowance < amountIn) {
      progress("1/2 · Approve this MUSEGOD amount");
      await validate();
      const approval = { address: MUSEGOD.token, abi: erc20Abi, functionName: "approve" as const,
        args: [MUSEGOD.router, amountIn] as const, account };
      const { request } = await client.simulateContract(approval).catch((e: unknown) => { throw simulationFailure(e); });
      const gas = await client.estimateContractGas(approval);
      await gasBalance(0n, gas);
      await deps.signer(validate);
      await deps.confirmed(await wallet.writeContract({ ...request, gas: gas + gas / 4n, chain: wallet.chain, account }), "approval", {
        to: MUSEGOD.token, data: encodeFunctionData(approval), value: 0n, fromBlock: quote.blockNumber,
      });
      await validate();
    }
  }
  await validate();
  const tx = musegodSwapTransaction(quote, account, config);
  const request = { ...tx, account };
  await client.call(request).catch((e: unknown) => { throw simulationFailure(e); });
  const estimatedGas = await client.estimateGas(request);
  await gasBalance(tx.value, estimatedGas);
  await deps.signer(validate);
  progress(quote.side === "buy" ? "Confirm the ETH buy in your wallet" : "2/2 · Confirm the MUSEGOD sale in your wallet");
  const hash = await wallet.sendTransaction({ ...tx, gas: estimatedGas + estimatedGas / 4n, chain: wallet.chain, account });
  // The history must be written before the page callback can throw or unmount.
  const confirmation = deps.confirmed(hash, "swap", { ...tx, fromBlock: quote.blockNumber });
  try { deps.onHash?.(hash); } catch { /* Receipt recovery continues independently. */ }
  progress(`Waiting for on-chain confirmation · ${hash}`);
  return confirmation;

  async function gasBalance(value: bigint, gas: bigint) {
    const [balance, fees] = await Promise.all([client.getBalance({ address: account }), client.estimateFeesPerGas()]);
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice;
    // Reserve the buffered estimate used on the request, including native input.
    const gasLimit = gas + gas / 4n;
    if (maxFee === undefined || balance < value + gasLimit * maxFee)
      throw new Error("Insufficient ETH for the input amount and transaction gas.");
  }
}

function simulationFailure(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const detail = current as { details?: string; message?: string; cause?: unknown };
    if (/historical state.*not available|failed to get storage|missing trie node/i.test(`${detail.details ?? ""} ${detail.message ?? ""}`))
      return new Error("Chain data needed to simulate this trade is unavailable. Nothing was submitted. Refresh the quote and try again.");
    current = detail.cause;
  }
  return new Error(`Trade simulation failed. Nothing was submitted. Check your balances and minimum received, then request a new quote. ${errorMessage(error)}`);
}
