import { formatUnits, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { networkName, quoteAsset, sameAddress, type TokenRecord } from "../src/lib/config";
import { isEthBuyChain, FIRST_BUY_SLIPPAGE_BPS, wrappedEther } from "../src/lib/first-buy-payment";
import type { EthBuyQuoteResponse, SwapQuote } from "../src/lib/eth-buy";
import { addressSchema, minimumOutput } from "../src/lib/validation";
import { BudgetUnavailable } from "./runtime-policy";
import type { FirstBuyPaymentReader } from "./lifi";
import { redact, type RuntimeEnvironment } from "./config";

export class EthBuyError extends Error {
  constructor(public code: "ETH_BUY_UNAVAILABLE" | "ETH_BUY_NOT_NEEDED", message: string) { super(message); this.name = "EthBuyError"; }
}
export const ethBuyRequestSchema = z.object({
  token: addressSchema,
  amountIn: z.string().max(40),
  account: addressSchema,
  slippageBps: z.number().int().refine((value) => FIRST_BUY_SLIPPAGE_BPS.some((preset) => preset === value)),
}).strict();
export type EthBuyDependencies = {
  chainId: 8453 | 4663;
  /** The runtime's mode; a local fork never quotes ETH buys, whatever chain it forks. */
  mode?: "base" | "robinhood" | "fork";
  /** Null when the runtime has no LI.FI configuration. */
  payments: Pick<FirstBuyPaymentReader, "quote" | "coinQuote"> | null;
  /** A listed platform coin of this chain; throws for anything else. */
  token: (address: Address) => Promise<TokenRecord>;
  /** The existing v4 buy quote of `amount` (decimal, pair-asset units). */
  swapQuote: (token: Address, amount: string, slippageBps: number) => Promise<SwapQuote>;
  now?: () => number;
  /** Secrets that `redact` removes from the operator log line. */
  environment?: RuntimeEnvironment;
  log?: (line: string) => void;
};
/** One quote for buying a pair-asset coin with ETH: a direct LI.FI route when one passes every check; otherwise (no route, an
 * unindexed or thin coin, a route the checks refuse) the strict ETH → pair conversion plus the v4 quote of that conversion's
 * guaranteed minimum. A refused direct quote is discarded, never returned; only provider capacity stops the fallback. */
export async function quoteEthBuy(raw: unknown, deps: EthBuyDependencies): Promise<EthBuyQuoteResponse> {
  const input = ethBuyRequestSchema.parse(raw), now = deps.now ?? Date.now;
  if (deps.mode === "fork" || !isEthBuyChain(deps.chainId) || !deps.payments)
    throw new EthBuyError("ETH_BUY_UNAVAILABLE", `Buying a coin with ETH is unavailable on ${networkName({
      mode: deps.mode ?? (deps.chainId === 4663 ? "robinhood" : "base"), deploymentChainId: deps.chainId })}.`);
  const record = await deps.token(input.token);
  if (sameAddress(record.quoteAddress, wrappedEther(deps.chainId)))
    throw new EthBuyError("ETH_BUY_NOT_NEEDED", "This coin is paired with WETH, so it needs no ETH conversion.");
  const pair = quoteAsset(record);
  try {
    const quote = await deps.payments.coinQuote({ account: input.account, amount: input.amountIn,
      coin: { address: record.address, symbol: record.symbol, decimals: 18 }, slippageBps: input.slippageBps });
    return { mode: "direct", quote, serverTime: now() };
  } catch (error) {
    if (error instanceof BudgetUnavailable) throw error;
    // One structured, redacted line, so a lasting LI.FI regression behind the quiet fallback stays visible to operators.
    (deps.log ?? console.warn)(JSON.stringify({ event: "eth_buy_direct_refused", token: record.address,
      reason: redact(error, deps.environment ?? process.env) }));
  }
  const conversion = await deps.payments.quote({ account: input.account, fromToken: zeroAddress, toToken: pair.address,
    amount: input.amountIn, slippageBps: input.slippageBps });
  const swapPreview = await deps.swapQuote(record.address, formatUnits(BigInt(conversion.minimumOut), pair.decimals), input.slippageBps);
  minimumOutput(BigInt(swapPreview.amountOut), input.slippageBps);
  return { mode: "two-step", conversion, swapPreview, serverTime: now() };
}
