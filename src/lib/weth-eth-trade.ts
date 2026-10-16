import type { Hash } from "viem";
import { contractsFor, deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import type { SwapQuote } from "./eth-buy";
import { wrapAndSwapTransaction } from "./protocol";

type NativeSwap = ReturnType<typeof wrapAndSwapTransaction>;
/** The native-only wallet flow has no ERC-20 or Permit2 capability. The wallet adapter supplies the existing live signing guards. */
export async function executeWethEthTrade(quote: SwapQuote, config: RuntimeConfig, deps: {
  now: () => number; guard: () => Promise<unknown>; balance: () => Promise<bigint>; blockTimestamp: () => Promise<bigint>;
  simulate: (tx: NativeSwap) => Promise<unknown>; fundedGas: (tx: NativeSwap) => Promise<bigint>;
  send: (tx: NativeSwap, gas: bigint) => Promise<Hash>; confirmed: (hash: Hash) => Promise<Hash>; progress: (message: string) => void;
}) {
  if (config.chainId !== 4663 || deploymentChain(config) !== 4663) throw new Error("Native WETH buys require the Robinhood network");
  if (quote.side !== "buy") throw new Error("Native WETH payments are available for buys only");
  const fresh = () => {
    if (!Number.isFinite(quote.expiresAt) || deps.now() >= quote.expiresAt) throw new Error("The quote has expired. Refresh the quote and try again.");
  };
  fresh(); await deps.guard();
  const amount = BigInt(quote.amountIn);
  const tx = wrapAndSwapTransaction(quote.poolKey, quote.currencyIn, amount, BigInt(quote.amountOut), quote.slippageBps,
    await deps.blockTimestamp() + 300n, contractsFor(config), config.chainId);
  if (!sameAddress(tx.currencyOut, quote.token)) throw new Error("The quote output does not match this coin");
  if (await deps.balance() < tx.value) throw new Error("Insufficient available ETH balance");
  fresh(); await deps.guard();
  await deps.simulate(tx);
  fresh(); await deps.guard();
  const gas = await deps.fundedGas(tx);
  fresh(); await deps.guard();
  deps.progress("Confirm the ETH buy in your wallet");
  const hash = await deps.send(tx, gas);
  deps.progress(`Waiting for onchain confirmation · ${hash}`);
  return deps.confirmed(hash);
}
