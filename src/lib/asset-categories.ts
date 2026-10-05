import type { Stock } from "./config";

export const ASSET_CATEGORIES = [
  { id: "STOCK", label: "Stocks" },
  { id: "ETF", label: "ETFs" },
  { id: "PENNY_STOCK", label: "Penny stocks" },
  { id: "OTHERS", label: "Crypto assets" },
] as const;

export type AssetCategory = "all" | typeof ASSET_CATEGORIES[number]["id"];

// Legacy Base B20 assets have no category field and remain stock pairs.
export function assetCategory(asset: Pick<Stock, "category">) {
  return asset.category ?? "STOCK";
}
