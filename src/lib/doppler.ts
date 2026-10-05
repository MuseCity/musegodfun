import { sameAddress, type TokenRecord } from "./config";
// Release-reviewed entries only. A new entry requires matching pool identity,
// a visible Doppler listing, and working buy/sell quotes recorded in docs/evidence.
const reviewed: Pick<TokenRecord, "address" | "poolId" | "quoteAddress">[] = [];
export function dopplerUrl(token: TokenRecord): string | null {
  if (
    token.mode !== "base" ||
    !reviewed.some(
      (p) =>
        sameAddress(p.address, token.address) &&
        sameAddress(p.poolId, token.poolId) &&
        sameAddress(p.quoteAddress, token.quoteAddress),
    )
  )
    return null;
  return `https://app.doppler.lol/tokens/base/${token.address.toLowerCase()}`;
}
