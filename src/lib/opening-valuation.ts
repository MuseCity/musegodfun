import { formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";
import { sameAddress, stockByAddress } from "./config";
import { firstBuyPaymentAssets, wrappedEther, type FirstBuyPaymentAsset } from "./first-buy-payment";

export const OPENING_CAP_USD = 5_000;
export const OPENING_POLICY = "fixed-usd-5000-lifi-v1";
export const BASE_OPENING_POLICY = "fixed-usd-5000-lifi-base-v2";
// Fixed raw quantity, independent of token-directory USD prices.
export const BASE_WETH_REFERENCE_AMOUNT = "10000000000000000";
export const LAUNCH_PRICE_TTL = 60_000;
export const LIFI_OPENING_MAX_DIVERGENCE_BPS = 500;
export type LaunchWarning = { code: "opening_spread" | "asset_status_unavailable" | "asset_oracle_paused" | "reference_price_divergence" | "reference_price_unavailable"; message: string; divergenceBps?: number };

type OpeningSnapshot = {
  marketCapUsd: typeof OPENING_CAP_USD;
  chainId: 8453 | 4663;
  quoteAddress: Address;
  quotePriceUsd: string;
  quotedAt: number;
  expiresAt: number;
  blockNumber: string;
  blockHash: Hex;
  sourceUpdatedAt: number;
};
export type LifiOpeningQuote = {
  id: string;
  tool: string;
  amountIn: string;
  amountOut: string;
  lifiFee: string;
  // These are HTTP request/response times, not the underlying price's update time.
  quotedAt: number;
  obtainedAt: number;
  expiresAt: number;
  // USD reference for this leg's numeraire. Base WETH uses the recorded
  // executable WETH/USDC reference; legacy snapshots retain API references.
  numerairePriceUsd: string;
};
export type LifiOpeningEvidence = {
  numeraire: FirstBuyPaymentAsset & { priceUsd: string };
  probeAmountIn: string;
  // Native ETH is sized to approximately $100 using this separate /token reference.
  probeUsd?: "100";
  probeSizingPriceUsd?: string;
  buy: LifiOpeningQuote;
  sell: LifiOpeningQuote;
  askNumerairePerQuoteToken: string;
  bidNumerairePerQuoteToken: string;
  aggregateMid: string;
  divergenceBps: number;
};
export type BaseOpeningQuote = LifiOpeningQuote & {
  fromToken: FirstBuyPaymentAsset;
  toToken: FirstBuyPaymentAsset;
};
export type BaseLifiOpeningEvidence = LifiOpeningEvidence & {
  evidenceVersion: 2;
  probeUnits: "10" | "100";
  fallbackReason?: "no_route";
  sellNumeraire: FirstBuyPaymentAsset & { priceUsd: string };
  wethUsdReference: BaseOpeningQuote;
  buy: BaseOpeningQuote;
  sell: BaseOpeningQuote;
};
export type LifiOpeningValuation = OpeningSnapshot & {
  policy: typeof OPENING_POLICY | typeof BASE_OPENING_POLICY;
  source: "LI.FI";
  lifi: LifiOpeningEvidence | BaseLifiOpeningEvidence;
  warnings?: LaunchWarning[];
  reference?: { source: "Chainlink"; feed: Address; priceUsd: string; updatedAt: number; divergenceBps: number };
};
export type HistoricalOpeningValuation = OpeningSnapshot & {
  policy: "fixed-usd-5000-v1";
  source: "Robinhood" | "Chainlink" | "SushiSwap V3 TWAP";
  feed?: Address;
  pool?: Address;
  twapSeconds?: 300;
};
export type OpeningValuation = LifiOpeningValuation | HistoricalOpeningValuation;

const decimalPrice = /^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/;
const WAD = 10n ** 18n;
const UINT256_MAX = (1n << 256n) - 1n;

function decimalWad(value: unknown): bigint {
  if (
    typeof value !== "string" || !decimalPrice.test(value)
  ) throw new Error("The paired asset USD price is invalid. Run a new simulation.");
  const price = parseUnits(value, 18);
  if (price <= 0n)
    throw new Error("The paired asset USD price is unavailable. Run a new simulation.");
  return price;
}
function priceWad(snapshot: OpeningValuation): bigint { return decimalWad(snapshot.quotePriceUsd); }
function invalidEvidence(): never {
  throw new Error("The opening valuation price evidence is invalid. Run a new simulation.");
}
function rawAmount(value: unknown, zero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value)) return invalidEvidence();
  const amount = BigInt(value);
  if ((!zero && amount === 0n) || amount > UINT256_MAX) return invalidEvidence();
  return amount;
}
export function deriveLifiOpeningPrice(input: {
  quoteDecimals: number; numeraireDecimals: number; sellNumeraireDecimals?: number;
  numerairePriceUsd: string; sellNumerairePriceUsd: string;
  buyAmountIn: string; buyAmountOut: string; buyLifiFee: string;
  sellAmountIn: string; sellAmountOut: string; sellLifiFee: string;
}) {
  if (![input.quoteDecimals, input.numeraireDecimals, input.sellNumeraireDecimals ?? input.numeraireDecimals].every((decimals) => Number.isInteger(decimals) && decimals >= 0 && decimals <= 18))
    return invalidEvidence();
  const buyIn = rawAmount(input.buyAmountIn), buyOut = rawAmount(input.buyAmountOut), buyFee = rawAmount(input.buyLifiFee, true);
  const sellIn = rawAmount(input.sellAmountIn), sellOut = rawAmount(input.sellAmountOut), sellFee = rawAmount(input.sellLifiFee, true);
  if (buyFee >= buyIn || sellFee >= sellIn || sellIn !== buyOut) return invalidEvidence();
  const quoteUnit = 10n ** BigInt(input.quoteDecimals), numeraireUnit = 10n ** BigInt(input.numeraireDecimals);
  const sellNumeraireUnit = 10n ** BigInt(input.sellNumeraireDecimals ?? input.numeraireDecimals);
  // Remove only the explicitly known LI.FI input fee. DEX fees and impact remain in each rate.
  const ask = (buyIn - buyFee) * quoteUnit * WAD / (buyOut * numeraireUnit);
  const bid = sellOut * quoteUnit * WAD / ((sellIn - sellFee) * sellNumeraireUnit);
  const askUsd = ask * decimalWad(input.numerairePriceUsd) / WAD;
  const bidUsd = bid * decimalWad(input.sellNumerairePriceUsd) / WAD;
  const mid = (askUsd + bidUsd) / 2n;
  if (ask <= 0n || bid <= 0n || mid <= 0n) return invalidEvidence();
  const spread = askUsd >= bidUsd ? askUsd - bidUsd : bidUsd - askUsd;
  const divergence = (spread * 10_000n + mid - 1n) / mid;
  return { askNumerairePerQuoteToken: formatUnits(ask, 18), bidNumerairePerQuoteToken: formatUnits(bid, 18),
    aggregateMid: formatUnits(mid, 18), divergenceBps: Number(divergence) };
}

/** Executable WETH/USDC quantity relationship, with USDC's quoted USD reference. */
export function deriveBaseWethPrice(reference: LifiOpeningQuote): string {
  const input = rawAmount(reference.amountIn), fee = rawAmount(reference.lifiFee, true);
  const output = rawAmount(reference.amountOut);
  if (fee >= input) return invalidEvidence();
  const result = output * 10n ** 18n * decimalWad(reference.numerairePriceUsd) / ((input - fee) * 10n ** 6n);
  if (result <= 0n) return invalidEvidence();
  return formatUnits(result, 18);
}
function assertQuoteTime(quote: LifiOpeningQuote, value: LifiOpeningValuation, now: number) {
  if (typeof quote.id !== "string" || !quote.id.length || quote.id.length > 200 ||
    typeof quote.tool !== "string" || !quote.tool.length || quote.tool.length > 80 ||
    !Number.isSafeInteger(quote.quotedAt) || quote.quotedAt <= 0 || quote.quotedAt > now ||
    !Number.isSafeInteger(quote.obtainedAt) || quote.obtainedAt < quote.quotedAt || quote.obtainedAt > now ||
    quote.expiresAt !== quote.quotedAt + LAUNCH_PRICE_TTL || quote.obtainedAt >= value.expiresAt)
    return invalidEvidence();
}
function assertAsset(actual: FirstBuyPaymentAsset, expected: FirstBuyPaymentAsset) {
  if (!actual || actual.chainId !== expected.chainId || !isAddress(actual.address, { strict: false }) ||
    !sameAddress(actual.address, expected.address) || actual.symbol !== expected.symbol || actual.decimals !== expected.decimals)
    return invalidEvidence();
}
function assertBaseEvidence(value: LifiOpeningValuation, now: number) {
  if (value.chainId !== 8453) return invalidEvidence();
  const evidence = value.lifi as BaseLifiOpeningEvidence;
  const stock = stockByAddress(value.quoteAddress, 8453);
  const stable = firstBuyPaymentAssets(8453).find((asset) => asset.symbol === "USDC")!;
  const weth: FirstBuyPaymentAsset = { chainId: 8453, address: wrappedEther(8453), symbol: "WETH", decimals: 18 };
  const paired: FirstBuyPaymentAsset = { chainId: 8453, address: stock.address, symbol: stock.symbol, decimals: stock.decimals };
  if (evidence.evidenceVersion !== 2 || !["10", "100"].includes(evidence.probeUnits) ||
    evidence.fallbackReason !== (evidence.probeUnits === "100" ? "no_route" : undefined) ||
    evidence.probeUsd !== undefined || evidence.probeSizingPriceUsd !== undefined ||
    evidence.probeAmountIn !== (BigInt(evidence.probeUnits) * 10n ** 6n).toString() ||
    evidence.buy.amountIn !== evidence.probeAmountIn || evidence.numeraire.priceUsd !== evidence.buy.numerairePriceUsd)
    return invalidEvidence();
  assertAsset(evidence.numeraire, stable); assertAsset(evidence.sellNumeraire, weth);
  if (!evidence.wethUsdReference) return invalidEvidence();
  const reference = evidence.wethUsdReference;
  for (const [quote, from, to] of [[evidence.buy, stable, paired], [evidence.sell, paired, weth], [reference, weth, stable]] as const) {
    assertQuoteTime(quote, value, now); assertAsset(quote.fromToken, from); assertAsset(quote.toToken, to);
  }
  if (reference.amountIn !== BASE_WETH_REFERENCE_AMOUNT) return invalidEvidence();
  const wethPrice = deriveBaseWethPrice(reference);
  if (evidence.sellNumeraire.priceUsd !== wethPrice || evidence.sell.numerairePriceUsd !== wethPrice) return invalidEvidence();
  const quotes = [evidence.buy, evidence.sell, reference];
  if (value.quotedAt !== Math.min(...quotes.map((quote) => quote.quotedAt)) ||
    value.expiresAt !== Math.min(...quotes.map((quote) => quote.expiresAt)) || value.sourceUpdatedAt !== value.quotedAt)
    return invalidEvidence();
  const calculated = deriveLifiOpeningPrice({ quoteDecimals: paired.decimals, numeraireDecimals: stable.decimals,
    sellNumeraireDecimals: weth.decimals, numerairePriceUsd: evidence.buy.numerairePriceUsd, sellNumerairePriceUsd: wethPrice,
    buyAmountIn: evidence.buy.amountIn, buyAmountOut: evidence.buy.amountOut, buyLifiFee: evidence.buy.lifiFee,
    sellAmountIn: evidence.sell.amountIn, sellAmountOut: evidence.sell.amountOut, sellLifiFee: evidence.sell.lifiFee });
  assertDerived(value, calculated);
}
function assertDerived(value: LifiOpeningValuation, calculated: ReturnType<typeof deriveLifiOpeningPrice>) {
  const evidence = value.lifi;
  if (evidence.askNumerairePerQuoteToken !== calculated.askNumerairePerQuoteToken ||
    evidence.bidNumerairePerQuoteToken !== calculated.bidNumerairePerQuoteToken ||
    evidence.aggregateMid !== calculated.aggregateMid || evidence.divergenceBps !== calculated.divergenceBps ||
    value.quotePriceUsd !== calculated.aggregateMid) return invalidEvidence();
}

export function openingValuationWarnings(snapshot: LifiOpeningValuation): LaunchWarning[] {
  return snapshot.lifi.divergenceBps > LIFI_OPENING_MAX_DIVERGENCE_BPS ? [{ code: "opening_spread",
    divergenceBps: snapshot.lifi.divergenceBps,
    message: `The opening-price buy and sell references differ by ${(snapshot.lifi.divergenceBps / 100).toFixed(2)}%. Review the price and minimum received before continuing.` }] : [];
}

function assertIdentity(value: OpeningValuation, quoteAddress: Address, chainId: 8453 | 4663) {
  if (value.chainId !== chainId || !isAddress(value.quoteAddress, { strict: false }) || !sameAddress(value.quoteAddress, quoteAddress))
    throw new Error("The opening valuation does not match this paired asset or network. Run a new simulation.");
  priceWad(value);
  if (typeof value.blockNumber !== "string" || !/^(?:0|[1-9]\d*)$/.test(value.blockNumber) ||
    typeof value.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)) return invalidEvidence();
}
function assertLifiEvidence(value: LifiOpeningValuation, now: number, allowExpired: boolean) {
  if (!Number.isSafeInteger(value.quotedAt) || value.quotedAt <= 0 || value.quotedAt > now ||
    !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.quotedAt ||
    (!allowExpired && now >= value.expiresAt))
    throw new Error("The opening valuation price expired. Run a new simulation.");
  const evidence = value.lifi;
  if (value.source !== "LI.FI" || !evidence || !evidence.numeraire || !evidence.buy || !evidence.sell) return invalidEvidence();
  if (value.policy === BASE_OPENING_POLICY) return assertBaseEvidence(value, now);
  const stock = stockByAddress(value.quoteAddress, value.chainId);
  const expectedSymbol = value.chainId === 4663 && stock.symbol === "USDG" ? "ETH" : value.chainId === 8453 ? "USDC" : "USDG";
  const expected = firstBuyPaymentAssets(value.chainId).find((asset) => asset.symbol === expectedSymbol)!;
  const numeraire = evidence.numeraire;
  if (numeraire.chainId !== value.chainId || !isAddress(numeraire.address, { strict: false }) ||
    !sameAddress(numeraire.address, expected.address) || numeraire.symbol !== expected.symbol || numeraire.decimals !== expected.decimals ||
    numeraire.priceUsd !== evidence.buy.numerairePriceUsd || evidence.probeAmountIn !== evidence.buy.amountIn)
    return invalidEvidence();
  if (expectedSymbol === "ETH") {
    if (evidence.probeUsd !== "100" || evidence.probeAmountIn !== (100n * WAD * WAD / decimalWad(evidence.probeSizingPriceUsd)).toString())
      return invalidEvidence();
  } else if (evidence.probeAmountIn !== (100n * 10n ** BigInt(expected.decimals)).toString() ||
    evidence.probeUsd !== undefined || evidence.probeSizingPriceUsd !== undefined) return invalidEvidence();
  for (const quote of [evidence.buy, evidence.sell]) assertQuoteTime(quote, value, now);
  if (value.quotedAt !== Math.min(evidence.buy.quotedAt, evidence.sell.quotedAt) ||
    value.expiresAt !== Math.min(evidence.buy.expiresAt, evidence.sell.expiresAt) || value.sourceUpdatedAt !== value.quotedAt)
    return invalidEvidence();
  const calculated = deriveLifiOpeningPrice({ quoteDecimals: stock.decimals, numeraireDecimals: numeraire.decimals,
    numerairePriceUsd: evidence.buy.numerairePriceUsd, sellNumerairePriceUsd: evidence.sell.numerairePriceUsd,
    buyAmountIn: evidence.buy.amountIn, buyAmountOut: evidence.buy.amountOut, buyLifiFee: evidence.buy.lifiFee,
    sellAmountIn: evidence.sell.amountIn, sellAmountOut: evidence.sell.amountOut, sellLifiFee: evidence.sell.lifiFee });
  assertDerived(value, calculated);
}

export function assertOpeningValuation(
  snapshot: unknown,
  quoteAddress: Address,
  chainId: 8453 | 4663,
  now = Date.now(),
): asserts snapshot is LifiOpeningValuation {
  const value = snapshot as LifiOpeningValuation | null | undefined;
  if (!value || ![OPENING_POLICY, BASE_OPENING_POLICY].includes(value.policy) || value.marketCapUsd !== OPENING_CAP_USD)
    throw new Error("The opening market cap policy has changed. Run a new simulation.");
  assertIdentity(value, quoteAddress, chainId);
  assertLifiEvidence(value, now, false);
}

// For already broadcast transactions and historical records only. This does
// not authorize an expired/current or retired-policy preview for new signing.
export function assertHistoricalOpeningValuation(snapshot: unknown, quoteAddress: Address, chainId: 8453 | 4663,
  now = Date.now()): asserts snapshot is OpeningValuation {
  const value = snapshot as OpeningValuation | null | undefined;
  if (!value || value.marketCapUsd !== OPENING_CAP_USD || ![OPENING_POLICY, BASE_OPENING_POLICY, "fixed-usd-5000-v1"].includes(value.policy))
    throw new Error("The opening market cap policy is unrecognized.");
  assertIdentity(value, quoteAddress, chainId);
  if (value.policy === OPENING_POLICY || value.policy === BASE_OPENING_POLICY) return assertLifiEvidence(value, now, true);
  if (!Number.isSafeInteger(value.quotedAt) || value.quotedAt <= 0 || value.quotedAt > now ||
    value.expiresAt !== value.quotedAt + 300_000 ||
    !Number.isSafeInteger(value.sourceUpdatedAt) || value.sourceUpdatedAt <= 0 || value.sourceUpdatedAt > value.quotedAt + 60_000 ||
    !["Robinhood", "Chainlink", "SushiSwap V3 TWAP"].includes(value.source) ||
    (value.source === "Chainlink" && (!value.feed || !isAddress(value.feed, { strict: false }))) ||
    (value.source === "SushiSwap V3 TWAP" && (!value.pool || !isAddress(value.pool, { strict: false }) || value.twapSeconds !== 300)))
    return invalidEvidence();
}

// This is a valuation, not an ERC20 transfer amount. Retain 18 decimal places
// even when the paired asset itself has only 6 or 8 transaction decimals.
export function openingCapInQuote(snapshot: OpeningValuation): string {
  const cap = BigInt(OPENING_CAP_USD) * 10n ** 36n / priceWad(snapshot);
  if (cap <= 0n)
    throw new Error("The opening valuation is below the supported precision.");
  return formatUnits(cap, 18);
}
