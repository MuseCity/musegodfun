import type { Address } from "viem";
import { MUSES } from "./nft-mode";

/** A collection the connected wallet holds, as the NFT step lists it (tasks/nft-mode-wallet-picker.md §4.1). */
export type OwnedCollection = { contract: Address; name: string; image?: string; held: number; free: boolean; openSeaVerified: boolean };
export type OwnedCollections = { owner: Address; truncated: boolean; collections: OwnedCollection[] };
/** One NFT of a collection the wallet holds (§4.2). `launched`: it already has a verified coin, so it cannot launch another. */
export type OwnedNft = { tokenId: string; name?: string; image?: string; launched: boolean };
export type OwnedNfts = { owner: Address; contract: Address; truncated: boolean; tokens: OwnedNft[] };

/** Provider pages of 100 read per answer: at most 300 collections, or 300 NFTs of one collection; more sets `truncated`. */
export const HOLDINGS_MAX_PAGES = 3;

/** An earlier wallet or collection's answer must stay hidden while the current list loads. */
export function nftTokensMatch(value: OwnedNfts, owner: Address, contract: Address): boolean {
  return value.owner.toLowerCase() === owner.toLowerCase() && value.contract.toLowerCase() === contract.toLowerCase();
}

const isMusesContract = (contract: string) => contract.toLowerCase() === MUSES.contract.toLowerCase();

/** §3.2 order. Muses are pinned by address only, so a copycat name never rises to the top. */
export function sortCollections(list: readonly OwnedCollection[]): OwnedCollection[] {
  const rank = (c: OwnedCollection) => (isMusesContract(c.contract) ? 0 : c.openSeaVerified ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.held - a.held
    || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.contract.toLowerCase().localeCompare(b.contract.toLowerCase()));
}

/** The search box: part of the name (any case), or the start of the contract address, with or without 0x. */
export function filterCollections(list: readonly OwnedCollection[], query: string): OwnedCollection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const prefix = q.startsWith("0x") ? q : `0x${q}`;
  const byAddress = /^0x[0-9a-f]+$/.test(prefix);
  return list.filter((c) => c.name.toLowerCase().includes(q) || (byAddress && c.contract.toLowerCase().startsWith(prefix)));
}

/** An image the page may load: an https URL of at most 2048 characters, else nothing. */
export function httpsImage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048) return undefined;
  try { return new URL(value).protocol === "https:" ? value : undefined; } catch { return undefined; }
}

/** D8: MUSEGOD is reserved for the official token. Letters and digits of the name are compared, so spacing and punctuation cannot get
 * around it; the symbol is compared as typed. Shared by the server's refusal and the form's prefill. */
export function reservedLaunchName(name: string, symbol: string): boolean {
  return name.replace(/[^a-z0-9]/gi, "").toUpperCase() === "MUSEGOD" || symbol.toUpperCase() === "MUSEGOD";
}
