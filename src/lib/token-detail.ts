import { assetCategory } from "./asset-categories";
import { sameAddress, type Stock, type TokenRecord } from "./config";
import { feePolicyFor } from "./fee-policy";
import { LP_FEE_PPM } from "./trading-fee";

export function ownershipDisclaimer(symbol: string, stock: Stock) {
  const category = assetCategory(stock);
  return category === "OTHERS" ? "" : `${symbol} does not represent ownership of ${stock.name}${category === "ETF" ? "" : " stock"}.`;
}
export function stockStatusFailure(stock: Stock) {
  return assetCategory(stock) === "OTHERS" ? "Could not load quote asset status." : "Could not load the stock multiplier. The share equivalent is unavailable.";
}
export function tokenFeeCardTier(token: Pick<TokenRecord, "nft" | "creator" | "feeTreasury">, account: string | null | undefined): "token" | "compact" | null {
  const treasury = !!account && !!token.feeTreasury && sameAddress(token.feeTreasury, account);
  // An NFT coin's creator fees are swept on its treasury card, so only the platform treasury needs a fee card (plan §12).
  if (token.nft) return treasury ? "token" : null;
  if (!account) return null;
  return treasury || !!token.creator && sameAddress(token.creator, account) ? "token" : "compact";
}

/** The token page's tabs. The selected one is the `tab` query parameter (none for Overview), so a copied link opens it
 * (tasks/ip-page-improvements-2026-10-18-plan.md §4). Since 2026-10-20 Posts lead Overview, On-chain is About (tasks/token-ip-detail-plan.md
 * §11) and Activity is gone (§13): shared `tab=onchain` links open About; `tab=posts` and `tab=activity` links open Overview. */
export type TokenTab = "overview" | "about";
export function tokenTabFromSearch(search: string): TokenTab {
  const tab = new URLSearchParams(search).get("tab");
  return tab === "about" || tab === "onchain" ? "about" : "overview";
}
/** `search` with the tab parameter for `tab` (removed for Overview); other parameters stay as they are. */
export function searchWithTokenTab(search: string, tab: TokenTab): string {
  const params = new URLSearchParams(search);
  if (tab === "overview") params.delete("tab"); else params.set("tab", tab);
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** The coin's page on Doppler's app (tasks/token-ip-detail-plan.md §4). Every registered launch is a Doppler pool whose identity the
 * server verified against the canonical contracts at registration; a local fork never links to mainnet. */
export function dopplerUrl(token: Pick<TokenRecord, "address" | "mode">): string | null {
  if (token.mode === "fork") return null;
  return `https://app.doppler.lol/tokens/${token.mode === "robinhood" ? "robinhood" : "base"}/${token.address.toLowerCase()}`;
}
/** The owner's Fomo invite link (FOMO_INVITE_HANDLE), or null when it is not configured or the coin is a fork test asset. */
export function fomoInviteUrl(token: Pick<TokenRecord, "mode">, handle: string | null | undefined): string | null {
  if (token.mode === "fork" || !handle || !/^[A-Za-z0-9_-]{1,40}$/.test(handle)) return null;
  return `https://fomo.family/r/${handle}`;
}
/** The bound NFT on OpenSea (NFT coins only; v1 binds NFTs on Robinhood Chain). */
export function openSeaUrl(token: Pick<TokenRecord, "nft" | "mode">): string | null {
  if (!token.nft || token.mode === "fork" || token.nft.chainId !== 4663) return null;
  return `https://opensea.io/item/robinhood/${token.nft.contract.toLowerCase()}/${token.nft.tokenId}`;
}

/** Shares of every trading fee as percentages of the gross fee, from the launch's recorded fee policy; null for a launch
 * without one (older launches), which the page then does not describe. */
export function feeShares(token: Pick<TokenRecord, "feePolicy">): { creator: number; buyback: number; operations: number; protocol: number } | null {
  const policy = feePolicyFor(token.feePolicy);
  if (!policy) return null;
  const operations = policy.operations || (policy.platform - policy.buyback);
  return { creator: policy.creator / 100, buyback: policy.buyback / 100, operations: operations / 100, protocol: policy.protocol / 100 };
}
/** The creator fee as a share of every trade (the trading fee times the creator's share of it, e.g. 1% × 66.5% = "0.665%"), or null
 * when the trading fee or the fee policy is unknown. An NFT coin's creator fee goes to the NFT's treasury. */
export function creatorFeePercent(token: Pick<TokenRecord, "feePolicy" | "tradingFeeBps">): string | null {
  const shares = feeShares(token);
  return !shares || token.tradingFeeBps === undefined ? null : `${Number((token.tradingFeeBps * shares.creator / 10_000).toFixed(4))}%`;
}
/** What a $100 buy pays the pool on any venue: the trading fee plus the LP fee, in dollars; null when the trading fee is unknown. */
export function poolFeeOn100(token: Pick<TokenRecord, "tradingFeeBps">): number | null {
  return token.tradingFeeBps === undefined ? null : token.tradingFeeBps / 100 + LP_FEE_PPM / 10_000;
}
export const LP_FEE_PERCENT = `${LP_FEE_PPM / 10_000}%`;
