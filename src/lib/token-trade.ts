import type { V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import { deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import { ethBuyAvailable, type PayWith } from "./eth-buy";
import { wrappedEther } from "./first-buy-payment";
import { parseAmount } from "./validation";
import type { AutoQuoteInput } from "./auto-quote";

export type TradeRoute = "native" | "lifi" | "permit2";
/** Only an ETH pick on a supported buy can carry native value; explicit pair picks always use Permit2. */
export function tradeRoute({ side, payWith, pairAddress, config }: {
  side: "buy" | "sell"; payWith: PayWith; pairAddress: string | null; config: RuntimeConfig | null;
}): TradeRoute {
  if (side !== "buy" || payWith !== "eth" || !pairAddress || !config || !ethBuyAvailable(config)) return "permit2";
  return sameAddress(pairAddress, wrappedEther(deploymentChain(config))) ? "native" : "lifi";
}
/** Quote identity includes the selected unit, wallet, network and pool, even when the quoted amounts happen to match. */
export function tradeAutoQuoteInput(input: {
  address: string; side: "buy" | "sell"; payWith: PayWith; amount: string; slippage: number;
  account: string | null; walletChainId: number | null; config: RuntimeConfig | null; poolKey?: V4PoolKey;
  stateInvalid: boolean; inputDecimals: number; route: TradeRoute; busy: boolean; confirmed: boolean; ethHeld: boolean;
}): Omit<AutoQuoteInput, "visible"> {
  const { address, side, payWith, amount, slippage, account, walletChainId, config, poolKey, route } = input;
  let valid = false;
  try { const value = parseAmount(amount, input.inputDecimals); valid = value > 0n && value < 2n ** 128n; } catch { /* Incomplete input has no quote. */ }
  return {
    key: JSON.stringify([address, side, payWith, amount, slippage, account, walletChainId, config?.chainId, config?.deploymentChainId, poolKey]),
    lifi: route === "lifi", valid, pool: !!config && !!poolKey && !input.stateInvalid,
    busy: input.busy || route === "lifi" && input.ethHeld, completed: input.confirmed, connected: !!account,
  };
}
