import { formatUnits, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { quoteAsset, sameAddress, type TokenRecord } from "../src/lib/config";
import { ETH_BUY_CHAIN, FIRST_BUY_SLIPPAGE_BPS, wrappedEther } from "../src/lib/first-buy-payment";
import type { EthBuyQuoteResponse, SwapQuote } from "../src/lib/eth-buy";
import { addressSchema, minimumOutput } from "../src/lib/validation";
import { BudgetUnavailable } from "./runtime-policy";
import type { FirstBuyPaymentReader } from "./lifi";

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
  /** Null when the runtime has no LI.FI configuration. */
  payments: Pick<FirstBuyPaymentReader, "quote" | "coinQuote"> | null;
  /** A listed platform coin of this chain; throws for anything else. */
  token: (address: Address) => Promise<TokenRecord>;
  /** The existing v4 buy quote of `amount` (decimal, pair-asset units). */
  swapQuote: (token: Address, amount: string, slippageBps: number) => Promise<SwapQuote>;
  now?: () => number;
};
/** One quote for buying a pair-asset coin with ETH: a direct LI.FI route when one passes every check; otherwise (no route, an
 * unindexed or thin coin, a route the checks refuse) the strict ETH → pair conversion plus the v4 quote of that conversion's
 * guaranteed minimum. A refused direct quote is discarded, never returned; only provider capacity stops the fallback. */
export async function quoteEthBuy(raw: unknown, deps: EthBuyDependencies): Promise<EthBuyQuoteResponse> {
  const input = ethBuyRequestSchema.parse(raw), now = deps.now ?? Date.now;
  if (deps.chainId !== ETH_BUY_CHAIN || !deps.payments)
    throw new EthBuyError("ETH_BUY_UNAVAILABLE", "Buying a coin with ETH is available on Robinhood Chain only.");
  const record = await deps.token(input.token), pair = quoteAsset(record);
  if (sameAddress(pair.address, wrappedEther(ETH_BUY_CHAIN)))
    throw new EthBuyError("ETH_BUY_NOT_NEEDED", "This coin is paired with WETH, so it needs no ETH conversion.");
  try {
    const quote = await deps.payments.coinQuote({ account: input.account, amount: input.amountIn,
      coin: { address: record.address, symbol: record.symbol, decimals: 18 }, slippageBps: input.slippageBps });
    return { mode: "direct", quote, serverTime: now() };
  } catch (error) {
    if (error instanceof BudgetUnavailable) throw error;
  }
  const conversion = await deps.payments.quote({ account: input.account, fromToken: zeroAddress, toToken: pair.address,
    amount: input.amountIn, slippageBps: input.slippageBps });
  const swapPreview = await deps.swapQuote(record.address, formatUnits(BigInt(conversion.minimumOut), pair.decimals), input.slippageBps);
  minimumOutput(BigInt(swapPreview.amountOut), input.slippageBps);
  return { mode: "two-step", conversion, swapPreview, serverTime: now() };
}
