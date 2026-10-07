import { STOCKS, stockByAddress, type TokenRecord } from "../src/lib/config";
import { OPENING_CAP_USD, OPENING_POLICY, LAUNCH_PRICE_TTL, deriveLifiOpeningPrice, type LifiOpeningValuation, type OpeningValuation } from "../src/lib/opening-valuation";
import { firstBuyPaymentAssets } from "../src/lib/first-buy-payment";
import { parseUnits, type Address } from "viem";

// A controlled USD price for unit tests, never a source for issuance.
export function syntheticOpeningValuation(
  quoteAddress: Address = STOCKS[0].address,
  quotePriceUsd = "100",
  overrides: Partial<OpeningValuation> = {},
): LifiOpeningValuation {
  const quotedAt = overrides.quotedAt ?? Date.now();
  const chainId = overrides.chainId ?? 8453;
  const stock = stockByAddress(quoteAddress);
  const symbol = chainId === 4663 && stock.symbol === "USDG" ? "ETH" : chainId === 8453 ? "USDC" : "USDG";
  const numeraire = firstBuyPaymentAssets(chainId).find((asset) => asset.symbol === symbol)!;
  // A synthetic 1:1 route isolates the requested USD price in curve tests.
  // Its numeraire USD reference is controlled test input, not a live stable/ETH price.
  const reference = /^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/.test(quotePriceUsd) && Number(quotePriceUsd) > 0 ? quotePriceUsd : "1";
  const probeAmountIn = symbol === "ETH" ? 100n * 10n ** 36n / parseUnits(reference, 18) : 100n * 10n ** BigInt(numeraire.decimals);
  const amountOut = probeAmountIn * 10n ** BigInt(stock.decimals) / 10n ** BigInt(numeraire.decimals);
  const buy = { id: "synthetic-buy", tool: "synthetic-unit-test", amountIn: probeAmountIn.toString(), amountOut: amountOut.toString(),
    lifiFee: "0", quotedAt, obtainedAt: quotedAt, expiresAt: quotedAt + LAUNCH_PRICE_TTL, numerairePriceUsd: reference };
  const sell = { ...buy, id: "synthetic-sell", amountIn: amountOut.toString(), amountOut: probeAmountIn.toString() };
  const calculated = deriveLifiOpeningPrice({ quoteDecimals: stock.decimals, numeraireDecimals: numeraire.decimals,
    numerairePriceUsd: reference, sellNumerairePriceUsd: reference,
    buyAmountIn: buy.amountIn, buyAmountOut: buy.amountOut, buyLifiFee: buy.lifiFee,
    sellAmountIn: sell.amountIn, sellAmountOut: sell.amountOut, sellLifiFee: sell.lifiFee });
  return {
    policy: OPENING_POLICY, marketCapUsd: OPENING_CAP_USD,
    chainId, quoteAddress, quotePriceUsd,
    quotedAt, expiresAt: quotedAt + LAUNCH_PRICE_TTL,
    source: "LI.FI", sourceUpdatedAt: quotedAt,
    blockNumber: "1", blockHash: `0x${"a".repeat(64)}`,
    lifi: { numeraire: { ...numeraire, priceUsd: reference }, probeAmountIn: probeAmountIn.toString(),
      ...(symbol === "ETH" ? { probeUsd: "100" as const, probeSizingPriceUsd: reference } : {}), buy, sell, ...calculated },
    ...overrides,
  } as LifiOpeningValuation;
}

// Synthetic records are unit-test input only. They are not deployed assets,
// verified listings, live market pools, or fixtures for the mainnet database.
export function syntheticToken(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    address: "0x1111111111111111111111111111111111111111",
    name: "Synthetic Meme",
    symbol: "SYNTH",
    description: "Synthetic stock-paired unit-test fixture; never deployed",
    image: "",
    quoteAddress: STOCKS[0].address,
    creator: "0x2222222222222222222222222222222222222222",
    poolId: `0x${"a".repeat(64)}`,
    transactionHash: `0x${"b".repeat(64)}`,
    blockNumber: "1",
    createdAt: 1_800_000_000_000,
    openingCap: "100",
    mode: "base",
    ...overrides,
  };
}
