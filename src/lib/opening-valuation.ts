import { formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";

export const OPENING_CAP_USD = 5_000;
export const OPENING_POLICY = "fixed-usd-5000-v1";
export const LAUNCH_PRICE_TTL = 300_000;

export type OpeningValuation = {
  policy: typeof OPENING_POLICY;
  marketCapUsd: typeof OPENING_CAP_USD;
  chainId: 8453 | 4663;
  quoteAddress: Address;
  quotePriceUsd: string;
  quotedAt: number;
  expiresAt: number;
  source: "Robinhood" | "Chainlink" | "SushiSwap V3 TWAP";
  blockNumber: string;
  blockHash: Hex;
  sourceUpdatedAt: number;
  feed?: Address;
  pool?: Address;
  twapSeconds?: 300;
};

const decimalPrice = /^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/;

function priceWad(snapshot: OpeningValuation): bigint {
  if (
    typeof snapshot.quotePriceUsd !== "string" ||
    !decimalPrice.test(snapshot.quotePriceUsd) ||
    !Number.isFinite(Number(snapshot.quotePriceUsd))
  ) throw new Error("The paired asset USD price is invalid. Run a new simulation.");
  const price = parseUnits(snapshot.quotePriceUsd, 18);
  if (price <= 0n)
    throw new Error("The paired asset USD price is unavailable. Run a new simulation.");
  return price;
}

export function assertOpeningValuation(
  snapshot: unknown,
  quoteAddress: Address,
  chainId: 8453 | 4663,
  now = Date.now(),
): asserts snapshot is OpeningValuation {
  const value = snapshot as OpeningValuation | null | undefined;
  if (!value || value.policy !== OPENING_POLICY || value.marketCapUsd !== OPENING_CAP_USD)
    throw new Error("The opening market cap policy has changed. Run a new simulation.");
  if (
    value.chainId !== chainId ||
    !isAddress(value.quoteAddress, { strict: false }) ||
    value.quoteAddress.toLowerCase() !== quoteAddress.toLowerCase()
  ) throw new Error("The opening valuation does not match this paired asset or network. Run a new simulation.");
  priceWad(value);
  if (
    !Number.isSafeInteger(value.quotedAt) || value.quotedAt <= 0 || value.quotedAt > now ||
    !Number.isSafeInteger(value.expiresAt) || value.expiresAt !== value.quotedAt + LAUNCH_PRICE_TTL ||
    now >= value.expiresAt
  ) throw new Error("The opening valuation price expired. Run a new simulation.");
  if (
    !["Robinhood", "Chainlink", "SushiSwap V3 TWAP"].includes(value.source) ||
    typeof value.blockNumber !== "string" || !/^(?:0|[1-9]\d*)$/.test(value.blockNumber) ||
    typeof value.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash) ||
    !Number.isSafeInteger(value.sourceUpdatedAt) || value.sourceUpdatedAt <= 0 ||
    value.sourceUpdatedAt > now + 60_000 ||
    (value.source === "Chainlink" && (!value.feed || !isAddress(value.feed, { strict: false }))) ||
    (value.source === "SushiSwap V3 TWAP" && (
      !value.pool || !isAddress(value.pool, { strict: false }) || value.twapSeconds !== 300
    ))
  ) throw new Error("The opening valuation price evidence is invalid. Run a new simulation.");
}

// This is a valuation, not an ERC20 transfer amount. Retain 18 decimal places
// even when the paired asset itself has only 6 or 8 transaction decimals.
export function openingCapInQuote(snapshot: OpeningValuation): string {
  const cap = BigInt(OPENING_CAP_USD) * 10n ** 36n / priceWad(snapshot);
  if (cap <= 0n)
    throw new Error("The opening valuation is below the supported precision.");
  return formatUnits(cap, 18);
}
