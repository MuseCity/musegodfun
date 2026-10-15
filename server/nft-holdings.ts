import { getAddress, type Address } from "viem";
import { z } from "zod";
import { shortAddress } from "../src/lib/config";
import { HOLDINGS_MAX_PAGES, httpsImage, sortCollections, type OwnedCollection } from "../src/lib/nft-holdings";
import { NftLaunchError } from "./nft-launch";

export const NFT_LIST_UNAVAILABLE_MESSAGE = "Your NFTs could not be loaded. Enter the contract and token number instead.";
export type HeldNft = { tokenId: string; name?: string; image?: string };
const TTL_MS = 60_000, MAX_ENTRIES = 100, TIMEOUT_MS = 8_000;
const MAX_LOADS = 6, MAX_CALLS_PER_MINUTE = 120;
const unavailable = () => new NftLaunchError("NFT_LIST_UNAVAILABLE", NFT_LIST_UNAVAILABLE_MESSAGE);
const image = z.object({ thumbnailUrl: z.string().nullish(), cachedUrl: z.string().nullish() }).partial().nullish();
const contractsPage = z.object({
  contracts: z.array(z.object({
    address: z.string(), name: z.string().nullish(), tokenType: z.string().nullish(), isSpam: z.boolean().nullish(),
    numDistinctTokensOwned: z.union([z.string(), z.number()]).nullish(), image,
    openSeaMetadata: z.object({ collectionName: z.string().nullish(), imageUrl: z.string().nullish(), safelistRequestStatus: z.string().nullish() })
      .partial().nullish(),
  })),
  pageKey: z.string().nullish(),
});
const nftsPage = z.object({
  ownedNfts: z.array(z.object({ tokenId: z.string(), name: z.string().nullish(), contract: z.object({ address: z.string() }), image })),
  pageKey: z.string().nullish(),
});
const firstImage = (...candidates: unknown[]) => {
  for (const candidate of candidates) { const url = httpsImage(candidate); if (url) return { image: url }; }
  return {};
};
const TOKEN_ID = /^(0|[1-9]\d{0,77})$/;

/** The connected wallet's NFTs on Robinhood Chain, from the Alchemy NFT API v3 (tasks/nft-mode-wallet-picker.md §4). The key stays in the
 * request URL here; any failure becomes one fixed message. A full answer is kept 60 seconds per owner (and contract); a failure never is. */
export class AlchemyNftHoldings {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly calls: number[] = [];
  constructor(private readonly deps: { apiKey?: string; fetch?: typeof fetch; now?: () => number }) {
    this.fetcher = deps.fetch ?? fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
  }

  collections(owner: Address, isFree: (contract: Address) => boolean): Promise<{ truncated: boolean; collections: OwnedCollection[] }> {
    return this.cached(`c:${owner.toLowerCase()}`, async () => {
      const { items, truncated } = await this.pages("getContractsForOwner", { owner, pageSize: "100", withMetadata: "true" },
        (body) => { const page = contractsPage.parse(body); return { items: page.contracts, pageKey: page.pageKey }; });
      const collections = items.filter((c) => c.tokenType === "ERC721" && c.isSpam !== true).flatMap((c): OwnedCollection[] => {
        let contract: Address;
        try { contract = getAddress(c.address); } catch { return []; }
        const held = Number(c.numDistinctTokensOwned ?? 1), status = c.openSeaMetadata?.safelistRequestStatus;
        return [{ contract, name: (c.openSeaMetadata?.collectionName || c.name || "").trim().slice(0, 80) || shortAddress(contract),
          ...firstImage(c.openSeaMetadata?.imageUrl, c.image?.thumbnailUrl, c.image?.cachedUrl),
          held: Number.isSafeInteger(held) && held > 0 ? held : 1, free: isFree(contract), openSeaVerified: status === "verified" || status === "approved" }];
      });
      return { truncated, collections: sortCollections(collections) };
    });
  }

  tokens(owner: Address, contract: Address): Promise<{ truncated: boolean; tokens: HeldNft[] }> {
    return this.cached(`t:${owner.toLowerCase()}:${contract.toLowerCase()}`, async () => {
      const { items, truncated } = await this.pages("getNFTsForOwner",
        { owner, "contractAddresses[]": contract, withMetadata: "true", pageSize: "100" },
        (body) => { const page = nftsPage.parse(body); return { items: page.ownedNfts, pageKey: page.pageKey }; });
      const tokens = items.filter((n) => n.contract.address.toLowerCase() === contract.toLowerCase() && TOKEN_ID.test(n.tokenId))
        .map((n): HeldNft => ({ tokenId: n.tokenId, ...(n.name?.trim() ? { name: n.name.trim().slice(0, 80) } : {}),
          ...firstImage(n.image?.thumbnailUrl, n.image?.cachedUrl) }))
        .sort((a, b) => { const x = BigInt(a.tokenId), y = BigInt(b.tokenId); return x < y ? -1 : x > y ? 1 : 0; });
      return { truncated, tokens };
    });
  }

  private async pages<T>(method: string, params: Record<string, string>, read: (body: unknown) => { items: T[]; pageKey?: string | null })
    : Promise<{ items: T[]; truncated: boolean }> {
    const key = this.deps.apiKey?.trim();
    if (!key) throw unavailable();
    const items: T[] = [];
    let pageKey: string | undefined;
    for (let page = 0; page < HOLDINGS_MAX_PAGES; page++) {
      let next: { items: T[]; pageKey?: string | null };
      try {
        // Every page and failed call spends budget shared by both list endpoints.
        const now = this.now();
        while (this.calls.length && this.calls[0]! <= now - TTL_MS) this.calls.shift();
        if (this.calls.length >= MAX_CALLS_PER_MINUTE) throw unavailable();
        this.calls.push(now);
        const query = new URLSearchParams({ ...params, ...(pageKey ? { pageKey } : {}) });
        const response = await this.fetcher(`https://robinhood-mainnet.g.alchemy.com/nft/v3/${encodeURIComponent(key)}/${method}?${query}`,
          { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) throw unavailable();
        next = read(await response.json());
      } catch { throw unavailable(); }
      items.push(...next.items);
      pageKey = next.pageKey || undefined;
      if (!pageKey) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value as T;
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    if (this.inFlight.size >= MAX_LOADS) throw unavailable();
    const loading = (async () => {
      try {
        const value = await load();
        this.cache.delete(key);
        this.cache.set(key, { at: this.now(), value });
        while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        return value;
      } finally { this.inFlight.delete(key); }
    })();
    this.inFlight.set(key, loading);
    return loading;
  }
}
