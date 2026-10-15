import { getAddress, type Address } from "viem";
import { z } from "zod";
import { shortAddress } from "../src/lib/config";
import { HOLDINGS_MAX_PAGES, httpsImage, sortCollections, type OwnedCollection } from "../src/lib/nft-holdings";
import { NftLaunchError } from "./nft-launch";

export const NFT_LIST_UNAVAILABLE_MESSAGE = "Your NFTs could not be loaded. Enter the contract and token number instead.";
export type HeldNft = { tokenId: string; name?: string; image?: string };
const TTL_MS = 60_000, MAX_ENTRIES = 100, TIMEOUT_MS = 8_000;
const SLUG_TTL_MS = 3_600_000, MAX_SLUGS = 500;
const MAX_LOADS = 6, MAX_CALLS_PER_MINUTE = 120;
type Provider = "alchemy" | "openSea";
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
const openSeaContract = z.object({ collection: z.string().trim().min(1) });
const nftsPage = z.object({
  nfts: z.array(z.object({ identifier: z.string(), contract: z.string(), token_standard: z.string(), name: z.string().nullish(),
    display_image_url: z.string().nullish(), image_url: z.string().nullish() })),
  next: z.string().nullish(),
});
const firstImage = (...candidates: unknown[]) => {
  for (const candidate of candidates) { const url = httpsImage(candidate); if (url) return { image: url }; }
  return {};
};
const TOKEN_ID = /^(0|[1-9]\d{0,77})$/;

/** Robinhood wallet lists: Alchemy collections and OpenSea NFT metadata (§4). Answers share a 60 s cache and load cap;
 * each provider has its own rolling call budget. Failures always become one fixed message and are never cached. */
export class NftHoldings {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly slugs = new Map<string, { at: number; value: string }>();
  private readonly calls: Record<Provider, number[]> = { alchemy: [], openSea: [] };
  constructor(private readonly deps: { alchemyKey?: string; openSeaKey?: string; fetch?: typeof fetch; now?: () => number }) {
    this.fetcher = deps.fetch ?? fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
  }

  collections(owner: Address, isFree: (contract: Address) => boolean): Promise<{ truncated: boolean; collections: OwnedCollection[] }> {
    return this.cached(`c:${owner.toLowerCase()}`, async () => {
      const { items, truncated } = await this.collectionPages({ owner, pageSize: "100", withMetadata: "true" },
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
      const slug = await this.collectionSlug(contract);
      const items: z.infer<typeof nftsPage>["nfts"] = [];
      let next: string | undefined;
      for (let page = 0; page < HOLDINGS_MAX_PAGES; page++) {
        const query = new URLSearchParams({ collection: slug, limit: "100", ...(next ? { next } : {}) });
        const body = await this.openSea(`account/${owner}/nfts?${query}`, (value) => nftsPage.parse(value));
        items.push(...body.nfts);
        next = body.next || undefined;
        if (!next) break;
      }
      const tokens = items.filter((n) => n.contract.toLowerCase() === contract.toLowerCase() && n.token_standard === "erc721" && TOKEN_ID.test(n.identifier))
        .map((n): HeldNft => ({ tokenId: n.identifier, ...(n.name?.trim() ? { name: n.name.trim().slice(0, 80) } : {}),
          ...firstImage(n.display_image_url, n.image_url) }))
        .sort((a, b) => { const x = BigInt(a.tokenId), y = BigInt(b.tokenId); return x < y ? -1 : x > y ? 1 : 0; });
      return { truncated: !!next, tokens };
    });
  }

  private async collectionSlug(contract: Address): Promise<string> {
    const key = contract.toLowerCase(), hit = this.slugs.get(key);
    if (hit && this.now() - hit.at < SLUG_TTL_MS) return hit.value;
    const { collection } = await this.openSea(`contract/${key}`, (body) => openSeaContract.parse(body));
    this.slugs.delete(key);
    this.slugs.set(key, { at: this.now(), value: collection });
    while (this.slugs.size > MAX_SLUGS) this.slugs.delete(this.slugs.keys().next().value!);
    return collection;
  }

  private openSea<T>(path: string, read: (body: unknown) => T): Promise<T> {
    const key = this.deps.openSeaKey?.trim();
    if (!key) return Promise.reject(unavailable());
    return this.request("openSea", `https://api.opensea.io/api/v2/chain/robinhood/${path}`, read,
      { accept: "application/json", "x-api-key": key, "user-agent": "musegod.fun/1 (+https://musegod.fun)" });
  }

  private async collectionPages<T>(params: Record<string, string>, read: (body: unknown) => { items: T[]; pageKey?: string | null })
    : Promise<{ items: T[]; truncated: boolean }> {
    const key = this.deps.alchemyKey?.trim();
    if (!key) throw unavailable();
    const items: T[] = [];
    let pageKey: string | undefined;
    for (let page = 0; page < HOLDINGS_MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...params, ...(pageKey ? { pageKey } : {}) });
      const next = await this.request("alchemy", `https://robinhood-mainnet.g.alchemy.com/nft/v3/${encodeURIComponent(key)}/getContractsForOwner?${query}`, read);
      items.push(...next.items);
      pageKey = next.pageKey || undefined;
      if (!pageKey) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  private async request<T>(provider: Provider, url: string, read: (body: unknown) => T, headers: Record<string, string> = { accept: "application/json" }): Promise<T> {
    try {
      // Slug lookups, pages and failed calls each spend one unit of this provider's budget.
      const now = this.now(), calls = this.calls[provider];
      while (calls.length && calls[0]! <= now - TTL_MS) calls.shift();
      if (calls.length >= MAX_CALLS_PER_MINUTE) throw unavailable();
      calls.push(now);
      const response = await this.fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw unavailable();
      return read(await response.json());
    } catch { throw unavailable(); }
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
