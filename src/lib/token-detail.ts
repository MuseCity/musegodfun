import { assetCategory } from "./asset-categories";
import { sameAddress, type Stock, type TokenRecord } from "./config";

export function buyPresets(stock: Stock, payingEth: boolean): readonly string[] {
  if (payingEth) return ["0.001", "0.005", "0.01"];
  if (assetCategory(stock) !== "OTHERS") return ["1", "5", "10"];
  return ({ WETH: ["0.001", "0.005", "0.01"], cbBTC: ["0.0001", "0.0005", "0.001"], USDG: ["10", "50", "100"] } as Record<string, string[]>)[stock.symbol] ?? [];
}
export function ownershipDisclaimer(symbol: string, stock: Stock) {
  const category = assetCategory(stock);
  return category === "OTHERS" ? "" : `${symbol} does not represent ownership of ${stock.name}${category === "ETF" ? "" : " stock"}.`;
}
export function stockStatusFailure(stock: Stock) {
  return assetCategory(stock) === "OTHERS" ? "Could not load quote asset status." : "Could not load the stock multiplier. The share equivalent is unavailable.";
}
export function tokenFeeCardTier(token: Pick<TokenRecord, "nft" | "creator" | "feeTreasury">, account: string | null | undefined): "token" | "compact" | null {
  const treasury = !!account && !!token.feeTreasury && sameAddress(token.feeTreasury, account);
  if (token.nft && !treasury) return "token";
  if (!account) return null;
  return treasury || !!token.creator && sameAddress(token.creator, account) ? "token" : "compact";
}
