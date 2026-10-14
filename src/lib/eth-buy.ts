import { decodeEventLog, erc20Abi, formatUnits, isAddress, zeroAddress, type Address, type Hash, type Hex } from "viem";
import type { V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import { quoteNow } from "./quote-clock";
import { deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import { ETH_BUY_CHAIN, assertEthBuyQuote, assertFirstBuyPaymentQuote, wrappedEther,
  type FirstBuyPaymentAsset, type FirstBuyPaymentQuote, type FirstBuySwapData } from "./first-buy-payment";
import { minimumOutput } from "./validation";

/** The existing v4 buy quote (`/quote`), the same shape as the wallet's `Quote`. */
export type SwapQuote = { token: Address; side: "buy" | "sell"; amountIn: string; amountOut: string; currencyIn: Address;
  poolKey: V4PoolKey; slippageBps: number; quotedAt: number; expiresAt: number };
export type EthBuyQuoteResponse =
  | { mode: "direct"; quote: FirstBuyPaymentQuote; serverTime?: number }
  | { mode: "two-step"; conversion: FirstBuyPaymentQuote; swapPreview: SwapQuote; serverTime?: number };
export type PayWith = "eth" | "pair";
export type ReceiptLog = { address: Address; topics: readonly Hex[]; data: Hex };
/** What a LI.FI trade may deliver: exactly the page's coin, or exactly its pair asset (the first of two steps). */
export type LifiTradeTarget = { kind: "coin"; coin: FirstBuyPaymentAsset } | { kind: "conversion"; pair: FirstBuyPaymentAsset };

/** The "Pay with" control exists on Robinhood, for coins whose pair asset is not WETH. */
export function ethBuyAvailable(config: Pick<RuntimeConfig, "mode" | "deploymentChainId"> | null, pairAddress: string) {
  return !!config && deploymentChain(config) === ETH_BUY_CHAIN && !sameAddress(pairAddress, wrappedEther(ETH_BUY_CHAIN));
}
/** The default while the amount field is empty: the pair asset without a wallet (its read-only quote needs no account) or when
 * the wallet holds some of it; otherwise ETH. */
export function defaultPayWith(connected: boolean, pairBalance: bigint | null): PayWith {
  return !connected || (pairBalance !== null && pairBalance > 0n) ? "pair" : "eth";
}
/** A typed amount never changes unit: the user's pick wins; otherwise the default follows the wallet only while the field is
 * empty, and the first character freezes it (`frozen`, the default when typing began). */
export function resolvePayWith({ choice, frozen, amount, fallback }: { choice: PayWith | null; frozen: PayWith | null; amount: string; fallback: PayWith }): PayWith {
  return choice ?? (amount !== "" && frozen !== null ? frozen : fallback);
}
/** Paying with the pair asset, the wallet holds less than the amount entered: the panel offers ETH, never converts the amount. */
export function pairShortfall(pairBalance: bigint | null, amount: bigint | null) {
  return pairBalance !== null && amount !== null && pairBalance < amount;
}
/** A wallet request whose outcome is not known yet: never treat it as failed, never offer to buy again. */
export function pendingOutcome(error: unknown) {
  return /still pending|pending status|still unresolved/i.test(error instanceof Error ? error.message : String(error));
}
/** The account's net ERC-20 Transfer of `token` in one receipt: transfers in, minus transfers out. */
export function receivedFromLogs(logs: readonly ReceiptLog[], token: Address, account: Address): bigint {
  let net = 0n;
  for (const log of logs) {
    if (!sameAddress(log.address, token)) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
      if (event.eventName !== "Transfer") continue;
      if (sameAddress(event.args.to, account)) net += event.args.value;
      if (sameAddress(event.args.from, account)) net -= event.args.value;
    } catch { /* Other token events do not move balances. */ }
  }
  return net;
}
/** At most eight decimals, rounded down, for sentences; inputs keep the exact amount. */
export function amountWords(raw: bigint, decimals: number) {
  const [whole, fraction = ""] = formatUnits(raw, decimals).split(".");
  const cut = fraction.slice(0, 8).replace(/0+$/, "");
  const text = cut ? `${whole}.${cut}` : whole;
  return text === "0" && raw > 0n ? "less than 0.00000001" : text;
}
export const ETH_BUY_ROUTE = { direct: "One step via LI.FI", twoStep: "Two steps" } as const;
/** The least coin a two-step buy can deliver: step 2 never swaps below the preview's slippage floor, and its own swap
 * minimum is that quote's output less slippage again. */
export function twoStepMinimum(previewOut: bigint, slippageBps: number) {
  return minimumOutput(minimumOutput(previewOut, slippageBps), slippageBps);
}
export function ethBuyDisclosure(pair: string, coin: string) {
  return `No one-step route right now. This buy takes 3 steps (3 or 4 wallet confirmations): ETH → ${pair}, then ${pair} → ${coin}.`;
}
/** Every wallet prompt of a two-step buy has its own label; step 1 is prefixed by `executeEthBuy`. */
export function twoStepLabels(pair: string, coin: string) {
  return { approve: `Step 2 of 3 · Approval 1 of 2 · Approve this ${pair} amount`,
    router: `Step 2 of 3 · Approval 2 of 2 · Approve the trading router for ${pair}; it expires in 5 minutes`,
    swap: `Step 3 of 3 · Confirm in your wallet: ${pair} → ${coin}`, waiting: "Step 3 of 3 · Waiting for on-chain confirmation" };
}
/** A two-step buy that did not finish. Nothing is retried automatically, and the pair asset stays in the wallet:
 * - stage "conversion": the ETH → pair transaction is still pending;
 * - stage "swap": the conversion confirmed (`pairReceived`, or null if its receipt could not be read) and step 2 did not. */
export class EthBuyIncomplete extends Error {
  readonly pending: boolean;
  constructor(public readonly stage: "conversion" | "swap", public readonly pairReceived: bigint | null, pair: FirstBuyPaymentAsset,
    coin: FirstBuyPaymentAsset, public readonly conversionHash: Hash, cause: unknown) {
    const pending = stage === "conversion" || pendingOutcome(cause);
    super(stage === "conversion"
      ? `Your ETH → ${pair.symbol} conversion is still pending. Check it in your wallet transaction history; once it confirms, buy ${coin.symbol} with ${pair.symbol}.`
      : pairReceived === null
        ? `Your ETH → ${pair.symbol} conversion is confirmed. Buy ${coin.symbol} with ${pair.symbol} to finish.`
        : pending
          ? `You received ${amountWords(pairReceived, pair.decimals)} ${pair.symbol}. A ${pair.symbol} → ${coin.symbol} transaction is still pending: check your wallet transaction history before you buy again.`
          : `You received ${amountWords(pairReceived, pair.decimals)} ${pair.symbol}. Buy ${coin.symbol} with ${pair.symbol} to finish.`);
    this.name = "EthBuyIncomplete";
    this.pending = pending;
  }
}

function invalidResponse(): never { throw new Error("The ETH buy quote does not match this coin, wallet or amount. Request a new quote."); }
const isEth = (asset: FirstBuyPaymentAsset) => sameAddress(asset?.address ?? "", zeroAddress) && asset.symbol === "ETH" && asset.decimals === 18;
/** The conversion of a two-step buy: a first-buy-strict LI.FI quote from ETH into exactly this pair asset. */
function assertConversion(q: FirstBuyPaymentQuote, pair: FirstBuyPaymentAsset, now?: number): FirstBuySwapData[] {
  const swaps = assertFirstBuyPaymentQuote(q, now);
  if (q.protocol !== "lifi" || q.chainId !== ETH_BUY_CHAIN || !isEth(q.fromToken) || !sameAddress(q.toToken.address, pair.address) ||
    q.toToken.decimals !== pair.decimals) invalidResponse();
  return swaps;
}
export function assertSwapQuote(q: SwapQuote, expected: { coin: FirstBuyPaymentAsset; pair: FirstBuyPaymentAsset; amountIn: bigint; slippageBps: number }) {
  const currencies = [q?.poolKey?.currency0, q?.poolKey?.currency1];
  if (!q || q.side !== "buy" || !sameAddress(q.token ?? "", expected.coin.address) || !sameAddress(q.currencyIn ?? "", expected.pair.address) ||
    typeof q.amountIn !== "string" || !/^[1-9]\d{0,77}$/.test(q.amountIn) || BigInt(q.amountIn) !== expected.amountIn ||
    typeof q.amountOut !== "string" || !/^[1-9]\d{0,77}$/.test(q.amountOut) || q.slippageBps !== expected.slippageBps ||
    !Number.isSafeInteger(q.quotedAt) || !Number.isSafeInteger(q.expiresAt) || q.expiresAt <= q.quotedAt ||
    !currencies.every((currency) => typeof currency === "string" && isAddress(currency, { strict: false })) ||
    !currencies.some((currency) => sameAddress(currency, expected.coin.address)) || !currencies.some((currency) => sameAddress(currency, expected.pair.address)))
    invalidResponse();
  return q;
}
/** The client's check of an `/trade/eth-quote` response before showing it. */
export function assertEthBuyResponse(value: unknown, expected: { coin: FirstBuyPaymentAsset; pair: FirstBuyPaymentAsset; account: Address;
  amountIn: bigint; slippageBps: number }): EthBuyQuoteResponse {
  const response = value as EthBuyQuoteResponse;
  const quote = response?.mode === "direct" ? response.quote : response?.mode === "two-step" ? response.conversion : invalidResponse();
  if (response.mode === "direct") assertEthBuyQuote(quote, expected.coin);
  else {
    assertConversion(quote, expected.pair);
    assertSwapQuote(response.swapPreview, { ...expected, amountIn: BigInt(quote.minimumOut) });
  }
  if (!sameAddress(quote.account, expected.account) || BigInt(quote.amountIn) !== expected.amountIn || quote.slippageBps !== expected.slippageBps ||
    quote.approval !== null) invalidResponse();
  return response;
}
export function assertLifiTradeQuote(q: FirstBuyPaymentQuote, target: LifiTradeTarget, account: Address, now?: number): FirstBuySwapData[] {
  const swaps = target.kind === "coin" ? assertEthBuyQuote(q, target.coin, now) : assertConversion(q, target.pair, now);
  if (!sameAddress(q.account, account) || !isEth(q.fromToken) || q.approval !== null || q.transaction.value !== q.amountIn)
    throw new Error("The ETH buy quote belongs to another wallet. Request a new quote.");
  return swaps;
}

export type LifiTradeDependencies = {
  /** The LI.FI diamond's facet and swap whitelist, read on-chain for this frozen quote. */
  verify: (quote: FirstBuyPaymentQuote, swaps: FirstBuySwapData[]) => Promise<void>;
  balance: () => Promise<bigint>;
  /** Simulates the exact transaction and returns its gas estimate. */
  simulate: (quote: FirstBuyPaymentQuote) => Promise<bigint>;
  /** Sends the exact transaction (re-verifying before the wallet request) and resolves with its confirmed hash. */
  submit: (quote: FirstBuyPaymentQuote, gas: bigint) => Promise<Hash>;
  logs: (hash: Hash) => Promise<readonly ReceiptLog[]>;
  progress: (message: string) => void;
};
/** One verified LI.FI transaction paid in native ETH: the static checks, the on-chain router identity, a simulation and the
 * same checks again before the wallet request. `received` is the target asset's net receipt Transfer, or null if unreadable. */
export async function executeLifiTrade(quote: FirstBuyPaymentQuote, target: LifiTradeTarget, account: Address, deps: LifiTradeDependencies,
  confirmMessage: string): Promise<{ hash: Hash; received: bigint | null }> {
  const frozen = structuredClone(quote);
  const check = async () => deps.verify(frozen, assertLifiTradeQuote(frozen, target, account));
  await check();
  if (await deps.balance() < BigInt(frozen.amountIn)) throw new Error("Not enough ETH for this buy.");
  const gas = await deps.simulate(frozen);
  await check();
  deps.progress(confirmMessage);
  const hash = await deps.submit(frozen, gas);
  let received: bigint | null = null;
  try { received = receivedFromLogs(await deps.logs(hash), frozen.toToken.address, account); } catch { /* Shown as unknown. */ }
  return { hash, received: received !== null && received > 0n ? received : null };
}

export type EthBuyResult = { mode: "direct"; hash: Hash; received: bigint | null }
  | { mode: "two-step"; conversionHash: Hash; pairReceived: bigint; hash: Hash; received: bigint | null };
export type EthBuyDependencies = {
  /** The wallet's verified LI.FI executor; `progress` carries this step's messages, `onHash` reports the submitted hash. */
  lifi: (quote: FirstBuyPaymentQuote, target: LifiTradeTarget, progress: (message: string) => void,
    onHash: (hash: Hash) => void) => Promise<{ hash: Hash; received: bigint | null }>;
  /** A fresh v4 buy quote for exactly `amountIn` pair-asset units. */
  requote: (amountIn: bigint) => Promise<SwapQuote>;
  /** The existing pair → coin flow (approvals and swap); resolves with the confirmed swap hash. */
  trade: (quote: SwapQuote) => Promise<Hash>;
  logs: (hash: Hash) => Promise<readonly ReceiptLog[]>;
  progress: (message: string) => void;
};
/** "Buy with ETH": a direct buy is one LI.FI transaction. A two-step buy converts ETH to the pair asset, measures exactly what
 * arrived, and swaps exactly that through the existing flow; if that second step does not finish, EthBuyIncomplete says what
 * the wallet now holds. */
export async function executeEthBuy(plan: EthBuyQuoteResponse, context: { coin: FirstBuyPaymentAsset; pair: FirstBuyPaymentAsset;
  account: Address; slippageBps: number }, deps: EthBuyDependencies): Promise<EthBuyResult> {
  const { coin, pair, account, slippageBps } = context;
  if (plan.mode === "direct") {
    const { hash, received } = await deps.lifi(plan.quote, { kind: "coin", coin }, deps.progress, () => {});
    return { mode: "direct", hash, received };
  }
  let submitted: Hash | null = null, step1: { hash: Hash; received: bigint | null };
  try {
    step1 = await deps.lifi(plan.conversion, { kind: "conversion", pair }, (message) => deps.progress(`Step 1 of 3 · ${message}`),
      (hash) => { submitted = hash; });
  } catch (cause) {
    // A submitted conversion whose outcome is unknown: point at it, never at buying again.
    if (submitted && pendingOutcome(cause)) throw new EthBuyIncomplete("conversion", null, pair, coin, submitted, cause);
    throw cause;
  }
  const { hash: conversionHash, received: pairReceived } = step1;
  let hash: Hash;
  try {
    if (pairReceived === null) throw new Error("The converted amount could not be read from the receipt.");
    let quote = plan.swapPreview;
    if (BigInt(quote.amountIn) !== pairReceived || quoteNow(quote) >= quote.expiresAt - 5_000) quote = await deps.requote(pairReceived);
    assertSwapQuote(quote, { coin, pair, amountIn: pairReceived, slippageBps });
    // The accepted price holds across both steps: never swap below the previewed output's slippage floor.
    if (BigInt(quote.amountOut) < minimumOutput(BigInt(plan.swapPreview.amountOut), slippageBps))
      throw new Error(`The ${pair.symbol} → ${coin.symbol} price moved beyond your slippage.`);
    hash = await deps.trade(quote);
  } catch (cause) {
    throw new EthBuyIncomplete("swap", pairReceived, pair, coin, conversionHash, cause);
  }
  let received: bigint | null = null;
  try { received = receivedFromLogs(await deps.logs(hash), coin.address, account); } catch { /* Shown as unknown. */ }
  return { mode: "two-step", conversionHash, pairReceived: pairReceived!, hash, received: received !== null && received > 0n ? received : null };
}
