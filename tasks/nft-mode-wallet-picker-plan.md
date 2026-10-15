# NFT Wallet Picker (three-step NFT mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Owner's execution choice (2026-10-15):** codex (`gpt-6.1-sol`, reasoning `xhigh`) implements every task in order on branch `feat/nft-wallet-picker`, committing after each task. Claude (Opus 5.5, xhigh) reviews after implementation; codex fixes; Claude accepts.

**Goal:** NFT mode becomes three steps (NFT → Identity → Economics). The NFT step lists the connected wallet's ERC-721 collections and NFTs from the Alchemy NFT API, so a holder picks instead of typing a contract and token number.

**Architecture:**
- **Shared code:** types and pure helpers (ordering, search, image and reserved-name rules) live in `src/lib/nft-holdings.ts`, used by both server and client.
- **Server:** `server/nft-holdings.ts` wraps Alchemy NFT API v3, with paging caps and a 60 s cache. `LaunchpadService` exposes `nftCollections` / `nftTokens`, behind `/api/nft-collections` and `/api/nft-tokens`.
- **Client:**
  - a new `NftPicker` component feeds the existing `NftLaunchStep`, whose check and fee logic is unchanged;
  - `App.tsx` gains step `0` (the NFT step) in NFT mode.

**Tech Stack:** TypeScript, React 19, Express (server) / Cloudflare Worker, viem, zod, `node:test` via `tsx --test`.

**Spec:** `tasks/nft-mode-wallet-picker.md` (read it first; it is the authority). Background: `tasks/nft-mode.md`.

## Global Constraints

- Work only in `/Users/admin/.codex/worktrees/nft-mode-robinhood/musegodfun`, on branch `feat/nft-wallet-picker`.
- Never push, never touch `master`, never run `npm run dev` with a real `.env` (it writes the production database), never install new dependencies (playwright included).
- Never print, log or commit any secret. The Alchemy key appears only inside the server-side request URL.
- **Commands:**
  - `npm test` (`tsx --test tests/*.test.ts`) must pass before every commit;
  - `npm run typecheck` must pass before every commit;
  - run `npm run build` once at the end.
- Chain: Robinhood only (`4663`). Base must keep answering `NFT_MODE_UNAVAILABLE`.
- **Muses:**
  - identified only by address `MUSES.contract` (`0x13Ea3072b7215d4C9c2Ec4f498A08c5825129836`) via `src/lib/nft-mode.ts`, never by name;
  - the free list is `config.nftMode.freeCollections` (strings `"4663:<lowercase address>"`).
- Caps: `HOLDINGS_MAX_PAGES = 3` pages of 100 (300 collections; 300 NFTs per collection). Cache: 60 000 ms, at most 500 entries. Provider timeout: 8 000 ms per call.
- **Error code** `NFT_LIST_UNAVAILABLE`:
  - HTTP 503;
  - message exactly `Your NFTs could not be loaded. Enter the contract and token number instead.`
- **Copy:** use these strings exactly. They are user-facing; keep them in English, like the rest of the UI.
  - "Choose your NFT"
  - "Connect your wallet to see your NFTs."
  - "Loading your NFTs…"
  - "Couldn't load your NFTs."
  - "Retry"
  - "Search your collections"
  - "No NFTs found in this wallet on Robinhood Chain."
  - "Enter a contract and token number instead"
  - "Choose from your wallet instead"
  - "← All collections"
  - "Already launched"
  - "Free"
  - "$10"
  - "Verified on OpenSea"
  - "Change"
  - "Showing the first 300. Use manual entry for others."
  - "Next, give your coin a name and a face."
- Follow the file's existing style: terse doc comments that say *why*, no new abstractions beyond those named here.

## Review Focus

1. A wallet switch while a list is loading must never show the previous account's collections or NFTs. Guard every async result with an `active` flag tied to the account, contract and attempt (Task 5).
2. Two tabs on one draft must not move each other's step. `launchDraftStep` must be exact for saved `0`, `1` and `2`, with no remapping (Task 4 tests).
3. A draft link carrying `nft`, opened before the wallet connects, shows the selected-NFT summary and the "Connect" status, not an empty picker. It is checked after connect (Task 5).
4. A collection named "MUSEGOD Muses" at another address is neither pinned nor free (Task 1 and 2 tests).
5. Prefill never writes a reserved name or symbol (MUSEGOD), for Muses or any other NFT (Task 1 test).

---

### Task 1: Shared holdings types and pure helpers

**Files:**
- Create: `src/lib/nft-holdings.ts`
- Modify: `server/nft-launch.ts` (reserved-name check uses the shared helper)
- Modify: `src/lib/nft-client.ts` (`musePrefill` skips reserved values)
- Test: `tests/nft-holdings.test.ts` (new)

**Interfaces:**
- Produces:
  - `OwnedCollection`, `OwnedCollections`, `OwnedNft`, `OwnedNfts`, `HOLDINGS_MAX_PAGES`;
  - `sortCollections(list)`, `filterCollections(list, query)`, `httpsImage(value)`, `reservedLaunchName(name, symbol)`;
  - and `musePrefill(draft, name)`, now reserved-aware.

- [ ] **Step 1: Write the failing tests** in `tests/nft-holdings.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { filterCollections, httpsImage, reservedLaunchName, sortCollections, type OwnedCollection } from "../src/lib/nft-holdings";
import { musePrefill } from "../src/lib/nft-client";
import { MUSES } from "../src/lib/nft-mode";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const row = (over: Partial<OwnedCollection>): OwnedCollection => ({ contract: at(1), name: "A", held: 1, free: false, openSeaVerified: false, ...over });

test("collections order: Muses by address, then OpenSea-verified, then most held, then name", () => {
  const list = [
    row({ contract: at(2), name: "zeta", held: 9 }),
    row({ contract: at(3), name: "MUSEGOD Muses", held: 50 }), // a copycat name at another address is not pinned
    row({ contract: at(4), name: "Beta", held: 1, openSeaVerified: true }),
    row({ contract: MUSES.contract, name: "MUSEGOD Muses", held: 1, free: true }),
    row({ contract: at(5), name: "alpha", held: 9 }),
  ];
  assert.deepEqual(sortCollections(list).map((c) => c.contract), [MUSES.contract, at(4), at(3), at(5), at(2)]);
});

test("search matches part of the name, case-insensitive, or the start of the address", () => {
  const list = [row({ contract: getAddress("0xabc0000000000000000000000000000000000001"), name: "Bronze Keys" }), row({ contract: at(7), name: "Robin Simpson" })];
  assert.equal(filterCollections(list, "").length, 2);
  assert.deepEqual(filterCollections(list, "  KEY ").map((c) => c.name), ["Bronze Keys"]);
  assert.deepEqual(filterCollections(list, "0xABC").map((c) => c.name), ["Bronze Keys"]);
  assert.deepEqual(filterCollections(list, "abc0").map((c) => c.name), ["Bronze Keys"]);
  assert.deepEqual(filterCollections(list, "nothing"), []);
});

test("only https image URLs of sane length are shown", () => {
  assert.equal(httpsImage("https://nft-cdn.alchemy.com/a.png"), "https://nft-cdn.alchemy.com/a.png");
  for (const bad of ["http://x.test/a.png", "ipfs://bafy", "data:image/png;base64,AA", "javascript:alert(1)", "", null, 7, `https://x.test/${"a".repeat(2050)}`])
    assert.equal(httpsImage(bad), undefined, String(bad).slice(0, 30));
});

test("the reserved name rule compares letters and digits of the name, and the symbol", () => {
  assert.equal(reservedLaunchName("Muse God!", "X"), true);
  assert.equal(reservedLaunchName("x", "musegod"), true);
  assert.equal(reservedLaunchName("MUSEGOD Muses", "MUSES"), false);
});

test("prefill fills only empty fields and never a reserved name or symbol", () => {
  assert.deepEqual(musePrefill({ name: "", symbol: "" }, "Bronze Key #2014"), { name: "Bronze Key #2014", symbol: "BRONZEKEY" });
  assert.deepEqual(musePrefill({ name: "Mine", symbol: "" }, "Sealed Muse"), { symbol: "SEALEDMUSE" });
  assert.deepEqual(musePrefill({ name: "", symbol: "" }, "Muse-God"), {});
  assert.deepEqual(musePrefill({ name: "", symbol: "" }, "Musegod #7"), { name: "Musegod #7" }); // name is not reserved ("MUSEGOD7"); symbol "MUSEGOD" is
});
```

- [ ] **Step 2: Run them and see them fail.** Run `npx tsx --test tests/nft-holdings.test.ts`. Expected: FAIL (module `../src/lib/nft-holdings` not found).

- [ ] **Step 3: Create `src/lib/nft-holdings.ts`:**

```ts
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
```

- [ ] **Step 4: Use the helper in `server/nft-launch.ts`.** In `assertNftDraftRules`, replace the `normalized` lambda and the `if (normalized(draft.name)…)` condition with `if (reservedLaunchName(draft.name, draft.symbol))`. Keep the thrown error unchanged. Import `reservedLaunchName` from `"../src/lib/nft-holdings"`. Keep `MUSEGOD_TICKER`: the Muses pair lookup still uses it.

- [ ] **Step 5: Make `musePrefill` reserved-aware** in `src/lib/nft-client.ts`. Import `reservedLaunchName` from `"./nft-holdings"` and replace the function body:

```ts
/** Fields an NFT's name fills: only empty ones, and never a reserved name or symbol. The symbol is the name's letters, at most 10, in
 * upper case. Used for Muses (their on-chain name) and for any NFT picked from the wallet (its listed name). */
export function musePrefill(draft: Pick<LaunchInput, "name" | "symbol">, museName: string): { name?: string; symbol?: string } {
  const name = museName.trim().slice(0, 32), symbol = name.replace(/[^A-Za-z]/g, "").slice(0, 10).toUpperCase();
  return { ...(!draft.name.trim() && name && !reservedLaunchName(name, "") ? { name } : {}),
    ...(!draft.symbol.trim() && symbol && !reservedLaunchName("", symbol) ? { symbol } : {}) };
}
```

- [ ] **Step 6: Run `npx tsx --test tests/nft-holdings.test.ts`, then `npm test` and `npm run typecheck`.** Expected: all PASS. The existing `NFT_RESERVED_NAME` tests still pass unchanged.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/nft-holdings.ts src/lib/nft-client.ts server/nft-launch.ts tests/nft-holdings.test.ts
git commit -m "feat(nft): shared wallet-holdings types, ordering, search and reserved-name rule"
```

---

### Task 2: Alchemy NFT API client (server)

**Files:**
- Create: `server/nft-holdings.ts`
- Modify: `server/nft-launch.ts` (add `"NFT_LIST_UNAVAILABLE"` to `NftLaunchCode`)
- Test: `tests/nft-holdings-server.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `HOLDINGS_MAX_PAGES`, `httpsImage`, `sortCollections`, `OwnedCollection`.
- Produces:
  - `class AlchemyNftHoldings`, constructed with `{ apiKey?: string; fetch?: typeof fetch; now?: () => number }`;
  - `.collections(owner: Address, isFree: (contract: Address) => boolean): Promise<{ truncated: boolean; collections: OwnedCollection[] }>`;
  - `.tokens(owner: Address, contract: Address): Promise<{ truncated: boolean; tokens: HeldNft[] }>`;
  - `type HeldNft = { tokenId: string; name?: string; image?: string }`;
  - `NFT_LIST_UNAVAILABLE_MESSAGE`.

- [ ] **Step 1: Write the failing tests** in `tests/nft-holdings-server.test.ts`. Use a fake `fetch` that records URLs and returns queued responses:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { AlchemyNftHoldings, NFT_LIST_UNAVAILABLE_MESSAGE } from "../server/nft-holdings";
import { MUSES } from "../src/lib/nft-mode";

const owner = getAddress("0x6e53e8380dc25cc9359e7150b619f51821f6d966");
const other = getAddress("0x00e3d6631ecbcd1848cbec005dc2545533b52b87");
type Reply = { status?: number; body?: unknown; throws?: Error };
function fakeFetch(replies: Reply[]) {
  const urls: string[] = [];
  const fetch = (async (url: string | URL) => {
    urls.push(String(url));
    const next = replies.shift() ?? { status: 500, body: {} };
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}
const contract = (address: string, over: object = {}) => ({ address, name: "Name", tokenType: "ERC721", isSpam: false, numDistinctTokensOwned: "2",
  image: { thumbnailUrl: "https://img.test/t.png" }, openSeaMetadata: { collectionName: "OS Name", imageUrl: "https://os.test/logo.png", safelistRequestStatus: "not_requested" }, ...over });
const isFree = (c: string) => c.toLowerCase() === MUSES.contract.toLowerCase();
const failsUnavailable = async (run: () => Promise<unknown>) => {
  await assert.rejects(run, (e: any) => e.code === "NFT_LIST_UNAVAILABLE" && e.message === NFT_LIST_UNAVAILABLE_MESSAGE && !/alchemy|key/i.test(e.message));
};

test("without an Alchemy key the list is unavailable and nothing is fetched", async () => {
  const { fetch, urls } = fakeFetch([]);
  await failsUnavailable(() => new AlchemyNftHoldings({ fetch }).collections(owner, isFree));
  assert.equal(urls.length, 0);
});

test("collections: ERC-721 only, spam dropped, OpenSea name and logo, verified status, free by address, sorted", async () => {
  const { fetch, urls } = fakeFetch([{ body: { contracts: [
    contract(other, { openSeaMetadata: { collectionName: "Broker App", imageUrl: "http://insecure.test/a.png", safelistRequestStatus: "verified" } }),
    contract("0x1111111111111111111111111111111111111111", { tokenType: "ERC1155" }),
    contract("0x2222222222222222222222222222222222222222", { isSpam: true }),
    contract(MUSES.contract, { openSeaMetadata: { collectionName: "MUSEGOD Muses", safelistRequestStatus: "approved" }, numDistinctTokensOwned: "1" }),
    contract("0x3333333333333333333333333333333333333333", { name: null, openSeaMetadata: null, image: null, numDistinctTokensOwned: "5" }),
  ], pageKey: null } }]);
  const result = await new AlchemyNftHoldings({ apiKey: "k/ey", fetch }).collections(owner, isFree);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.collections.map((c) => [c.contract, c.name, c.image, c.held, c.free, c.openSeaVerified]), [
    [MUSES.contract, "MUSEGOD Muses", "https://img.test/t.png", 1, true, true],
    [other, "Broker App", "https://img.test/t.png", 2, false, true],
    [getAddress("0x3333333333333333333333333333333333333333"), "0x3333…3333", undefined, 5, false, false],
  ]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/robinhood-mainnet\.g\.alchemy\.com\/nft\/v3\/k%2Fey\/getContractsForOwner\?/);
  assert.match(urls[0], new RegExp(`owner=${owner}`)); assert.match(urls[0], /pageSize=100/);
});

test("collections page through pageKey and stop at three pages with truncated", async () => {
  const page = (key: string | null) => ({ body: { contracts: [contract(other)], pageKey: key } });
  const two = fakeFetch([page("p2"), page(null)]);
  assert.equal((await new AlchemyNftHoldings({ apiKey: "k", fetch: two.fetch }).collections(owner, isFree)).truncated, false);
  assert.equal(two.urls.length, 2); assert.match(two.urls[1], /pageKey=p2/);
  const many = fakeFetch([page("a"), page("b"), page("c"), page("d")]);
  assert.equal((await new AlchemyNftHoldings({ apiKey: "k", fetch: many.fetch }).collections(owner, isFree)).truncated, true);
  assert.equal(many.urls.length, 3);
});

test("a non-2xx answer, a malformed body or a network error is NFT_LIST_UNAVAILABLE, and failures are not cached", async () => {
  for (const reply of [{ status: 500, body: {} }, { status: 200, body: { nope: true } }, { throws: new Error("socket https://robinhood-mainnet.g.alchemy.com/nft/v3/k/x") }]) {
    const { fetch } = fakeFetch([reply]);
    await failsUnavailable(() => new AlchemyNftHoldings({ apiKey: "k", fetch }).collections(owner, isFree));
  }
  const { fetch, urls } = fakeFetch([{ status: 500 }, { body: { contracts: [], pageKey: null } }]);
  const holdings = new AlchemyNftHoldings({ apiKey: "k", fetch });
  await failsUnavailable(() => holdings.collections(owner, isFree));
  assert.deepEqual((await holdings.collections(owner, isFree)).collections, []);
  assert.equal(urls.length, 2);
});

test("answers are cached for 60 seconds per owner, then read again", async () => {
  let now = 1_000_000;
  const { fetch, urls } = fakeFetch([{ body: { contracts: [], pageKey: null } }, { body: { contracts: [], pageKey: null } }]);
  const holdings = new AlchemyNftHoldings({ apiKey: "k", fetch, now: () => now });
  await holdings.collections(owner, isFree);
  now += 59_999; await holdings.collections(getAddress(owner.toLowerCase()), isFree);
  assert.equal(urls.length, 1);
  now += 2; await holdings.collections(owner, isFree);
  assert.equal(urls.length, 2);
});

test("tokens: this contract only, valid decimal ids, numeric order, https images, names trimmed", async () => {
  const nft = (tokenId: string, over: object = {}) => ({ tokenId, name: ` Item ${tokenId} `, contract: { address: other }, image: { thumbnailUrl: "https://img.test/n.png" }, ...over });
  const { fetch, urls } = fakeFetch([{ body: { ownedNfts: [nft("10"), nft("9", { name: null, image: { cachedUrl: "ipfs://x" } }), nft("0x1f"), nft("3", { contract: { address: MUSES.contract } })], pageKey: null } }]);
  const result = await new AlchemyNftHoldings({ apiKey: "k", fetch }).tokens(owner, other);
  assert.deepEqual(result, { truncated: false, tokens: [{ tokenId: "9" }, { tokenId: "10", name: "Item 10", image: "https://img.test/n.png" }] });
  assert.match(urls[0], /getNFTsForOwner\?/); assert.match(urls[0], new RegExp(`contractAddresses%5B%5D=${other}`)); assert.match(urls[0], /withMetadata=true/);
});
```

- [ ] **Step 2: Run them and see them fail.** Run `npx tsx --test tests/nft-holdings-server.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Add the code.** In `server/nft-launch.ts`, append `| "NFT_LIST_UNAVAILABLE"` to `NftLaunchCode`. Then create `server/nft-holdings.ts`:

```ts
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { shortAddress } from "../src/lib/config";
import { HOLDINGS_MAX_PAGES, httpsImage, sortCollections, type OwnedCollection } from "../src/lib/nft-holdings";
import { NftLaunchError } from "./nft-launch";

export const NFT_LIST_UNAVAILABLE_MESSAGE = "Your NFTs could not be loaded. Enter the contract and token number instead.";
export type HeldNft = { tokenId: string; name?: string; image?: string };
const TTL_MS = 60_000, MAX_ENTRIES = 500, TIMEOUT_MS = 8_000;
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
    const value = await load();
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), value });
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
```

- [ ] **Step 4: Run `npx tsx --test tests/nft-holdings-server.test.ts`, then `npm test` and `npm run typecheck`.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/nft-holdings.ts server/nft-launch.ts tests/nft-holdings-server.test.ts
git commit -m "feat(nft): Alchemy NFT API client for the wallet picker, with caps and a 60 s cache"
```

---

### Task 3: Service methods and the two endpoints

**Files:**
- Modify: `server/service.ts`:
  - import;
  - a public `nftHoldings` field set in the constructor;
  - `nftCollections`, `nftTokens`, `assertNftListNetwork`, placed after `nftStatus`.
- Modify: `server/app.ts`:
  - two routes after the `/api/nft-status` route;
  - the error handler maps `NFT_LIST_UNAVAILABLE` to 503.
- Test: `tests/nft-api.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `AlchemyNftHoldings`, and Task 1's `OwnedCollections` / `OwnedNfts`.
- Produces:
  - `GET /api/nft-collections?owner=` → `OwnedCollections`;
  - `GET /api/nft-tokens?owner=&contract=` → `OwnedNfts`;
  - both are also served at `/api/chains/4663/…`.

- [ ] **Step 1: Write the failing tests.** Append them to `tests/nft-api.test.ts`; they use the existing `httpFixture`, `get`, `coin`, `nftOf`, `verified` and `rejected` helpers. Also add both new paths to the path loop of the existing test "while NFT mode is off, nft-status and nft-treasury answer 422…" (around line 214):
  - `/api/nft-collections?owner=0x1111111111111111111111111111111111111111`
  - `/api/nft-tokens?owner=0x1111111111111111111111111111111111111111&contract=${MUSES.contract}`

```ts
// ---- the NFT step's wallet lists (tasks/nft-mode-wallet-picker.md §4) ----------------------------------------
const holder = "0x1111111111111111111111111111111111111111";
test("wallet lists: 400 on a bad address, 503 NFT_LIST_UNAVAILABLE without an Alchemy key, never the key", async () => {
  await httpFixture(async (_entry, origin) => {
    for (const path of ["/api/nft-collections?owner=nope", `/api/nft-tokens?owner=${holder}&contract=nope`])
      assert.equal((await get(origin, path)).status, 400, path);
    for (const path of [`/api/nft-collections?owner=${holder}`, `/api/chains/4663/nft-tokens?owner=${holder}&contract=${MUSES.contract}`]) {
      const response = await get(origin, path);
      assert.equal(response.status, 503, path);
      assert.deepEqual(await response.json(), { error: "Your NFTs could not be loaded. Enter the contract and token number instead.", code: "NFT_LIST_UNAVAILABLE" });
    }
  });
});

test("wallet lists answer the §4 shapes; launched marks verified coins only; Muses are free", async () => {
  await httpFixture(async ({ service }, origin) => {
    await service.store.saveToken(coin(1, { nft: nftOf("1"), nftVerification: verified }));
    await service.store.saveToken(coin(2, { nft: nftOf("2"), nftVerification: rejected }));
    const seen: string[] = [];
    service.nftHoldings = {
      collections: async (owner, isFree) => { seen.push(`c:${owner}`); return { truncated: false, collections: [
        { contract: MUSES.contract, name: "MUSEGOD Muses", held: 3, free: isFree(MUSES.contract), openSeaVerified: true }] }; },
      tokens: async (owner, contract) => { seen.push(`t:${owner}:${contract}`); return { truncated: true, tokens: [{ tokenId: "1" }, { tokenId: "2", name: "Two" }, { tokenId: "3" }] }; },
    };
    const collections = await (await get(origin, `/api/chains/4663/nft-collections?owner=${holder}`)).json();
    assert.deepEqual(collections, { owner: getAddress(holder), truncated: false,
      collections: [{ contract: MUSES.contract, name: "MUSEGOD Muses", held: 3, free: true, openSeaVerified: true }] });
    const tokens = await (await get(origin, `/api/nft-tokens?owner=${holder}&contract=${MUSES.contract.toLowerCase()}`)).json();
    assert.deepEqual(tokens, { owner: getAddress(holder), contract: MUSES.contract, truncated: true,
      tokens: [{ tokenId: "1", launched: true }, { tokenId: "2", name: "Two", launched: false }, { tokenId: "3", launched: false }] });
    assert.deepEqual(seen, [`c:${getAddress(holder)}`, `t:${getAddress(holder)}:${MUSES.contract}`]);
  });
});

test("wallet lists stay dark on Base: NFT_MODE_UNAVAILABLE before any read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-base-"));
  const service = new LaunchpadService(runtimeFromEnv(8453, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "8453", DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222", NFT_MODE_ENABLED: "true" }));
  try {
    service.nftHoldings = { collections: async () => assert.fail("no read"), tokens: async () => assert.fail("no read") };
    for (const run of [() => service.nftCollections(holder), () => service.nftTokens(holder, MUSES.contract)])
      await assert.rejects(run, (e: any) => e.code === "NFT_MODE_UNAVAILABLE");
  } finally { service.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
```

If the file lacks `mkdtempSync`, `join`, `tmpdir`, `rmSync`, `getAddress` or `LaunchpadService` imports, add them, following the imports already at the top of the file. `LaunchpadService` and `runtimeFromEnv` are already imported.

- [ ] **Step 2: Run `npx tsx --test tests/nft-api.test.ts` and see the new tests fail** (404, or no `nftHoldings` property).

- [ ] **Step 3: Implement.** In `server/service.ts`:

```ts
import { AlchemyNftHoldings } from "./nft-holdings";
import type { OwnedCollections, OwnedNfts } from "../src/lib/nft-holdings";
```

Add the field next to the other public fields:

```ts
  /** The NFT step's wallet lists (tasks/nft-mode-wallet-picker.md §4). Tests replace it. */
  nftHoldings: Pick<AlchemyNftHoldings, "collections" | "tokens">;
```

At the end of the constructor:

```ts
    this.nftHoldings = new AlchemyNftHoldings({ apiKey: runtime.environment?.ALCHEMY_API_KEY });
```

After `nftStatus`:

```ts
  /** The connected wallet's ERC-721 collections for the NFT step: a convenience only; nft-status and prepare stay the authority. */
  async nftCollections(rawOwner: unknown): Promise<OwnedCollections> {
    await this.assertNftModeAvailable();
    const owner = addressSchema.parse(rawOwner);
    const chainId = this.assertNftListNetwork(), free = new Set(this.runtime.config.nftMode?.freeCollections ?? []);
    const { truncated, collections } = await this.nftHoldings.collections(owner, (contract) => free.has(`${chainId}:${contract.toLowerCase()}`));
    return { owner, truncated, collections };
  }
  /** The wallet's NFTs of one collection; `launched` uses the same rule as nft-status (a verified coin for this NFT). */
  async nftTokens(rawOwner: unknown, rawContract: unknown): Promise<OwnedNfts> {
    await this.assertNftModeAvailable();
    const owner = addressSchema.parse(rawOwner), contract = addressSchema.parse(rawContract), chainId = this.assertNftListNetwork();
    const [{ truncated, tokens }, catalog] = await Promise.all([this.nftHoldings.tokens(owner, contract), this.tokens()]);
    const launched = new Set(catalog.flatMap((coin) => coin.nft && coin.nftVerification?.status === "verified" ? [nftKey(coin.nft)] : []));
    return { owner, contract, truncated, tokens: tokens.map((token) => ({ ...token, launched: launched.has(nftKey({ chainId, contract, tokenId: token.tokenId })) })) };
  }
  private assertNftListNetwork(): 4663 {
    const chainId = deploymentChain(this.runtime.config);
    if (chainId !== 4663) throw new NftLaunchError("NFT_CHAIN_UNSUPPORTED", "Wallet NFT lists are available on Robinhood Chain only.");
    return chainId;
  }
```

`addressSchema` already returns a checksummed `Address` (it ends in `.transform(getAddress)`). `this.tokens()` is the 10-second cached catalog (`listedTokens` over `store.tokens()`); one read covers every token. Do not call `verifiedNftCoin` once per token.

In `server/app.ts`, after the `/api/nft-status` route:

```ts
// The NFT step's wallet lists (tasks/nft-mode-wallet-picker.md §4); nft-status and prepare stay the authority.
app.get("/api/nft-collections", route(async (req, res) => res.json(await service.nftCollections(req.query.owner))));
app.get("/api/nft-tokens", route(async (req, res) => res.json(await service.nftTokens(req.query.owner, req.query.contract))));
```

In the error handler, change the status expression to:

```ts
    const status =
      error instanceof MarketUnavailable || (error instanceof NftLaunchError && error.code === "NFT_LIST_UNAVAILABLE")
        ? 503
        : error instanceof z.ZodError
          ? 400
          : 422;
```

Then check whether `/api/chains/4663/nft-status` reaches the app through an allowlist of paths: run `grep -rn "nft-status" worker server src scripts`. If any list names `nft-status` or `nft-treasury`, add `nft-collections` and `nft-tokens` beside them.

- [ ] **Step 4: Run `npx tsx --test tests/nft-api.test.ts`, then `npm test` and `npm run typecheck`.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/service.ts server/app.ts tests/nft-api.test.ts
git commit -m "feat(nft): nft-collections and nft-tokens endpoints for the NFT step"
```

---

### Task 4: Draft step model with the NFT step

**Files:**
- Modify:
  - `src/lib/launch-draft.ts`: `LaunchStep`, `launchDraftStep`, `resetLaunchedDraftStep`, and new `launchSteps` and `stepHeadingId`.
  - `src/lib/draft-link.ts`: `isPristineDraft`.
- Test: `tests/launch-draft.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type LaunchStep = 0 | 1 | 2` (0 NFT, 1 Identity, 2 Economics);
  - `launchDraftStep(raw)`;
  - `launchSteps(nftMode: boolean): { step: LaunchStep; label: "NFT" | "Identity" | "Economics" }[]`;
  - `stepHeadingId(step: LaunchStep): "nft-heading" | "identity-heading" | "quote-heading"`.

- [ ] **Step 1: Write the failing tests.** Add them to `tests/launch-draft.test.ts`, importing `launchSteps` and `stepHeadingId`:

```ts
test("draft steps restore exactly: 0 is the NFT step in NFT mode only; no saved step opens NFT mode on the NFT step", () => {
  const nft = { chainId: 4663, contract: "0x13Ea3072b7215d4C9c2Ec4f498A08c5825129836", tokenId: "1" };
  const cases: [string | null, number][] = [
    [null, 1], ["{}", 1], ['{"step":0}', 1], ['{"step":1}', 1], ['{"step":2}', 2],
    ['{"nftMode":true}', 0], [JSON.stringify({ nft }), 0], ['{"step":0,"nftMode":true}', 0],
    ['{"step":1,"nftMode":true}', 1], ['{"step":2,"nftMode":true}', 2], ['{"step":"0","nftMode":true}', 0], ["{bad", 1],
  ];
  for (const [raw, expected] of cases) assert.equal(launchDraftStep(raw), expected, String(raw));
});

test("the wizard lists the NFT step only in NFT mode, and each step has its heading", () => {
  assert.deepEqual(launchSteps(false).map((s) => s.label), ["Identity", "Economics"]);
  assert.deepEqual(launchSteps(true).map((s) => [s.step, s.label]), [[0, "NFT"], [1, "Identity"], [2, "Economics"]]);
  assert.deepEqual([0, 1, 2].map((s) => stepHeadingId(s as 0 | 1 | 2)), ["nft-heading", "identity-heading", "quote-heading"]);
});
```

`'{"step":"0","nftMode":true}'` has no numeric saved step, so it falls to "no saved step" and NFT mode opens on the NFT step.

Also add a case to the existing `resetLaunchedDraftStep` test (around line 184): a launched NFT-mode draft, `{ ...draft, firstBuy, intentId: "wallet-intent-a", step: 2, nftMode: true }`, resets to `step: 0`. A normal one still resets to `step: 1`.

- [ ] **Step 2: Run `npx tsx --test tests/launch-draft.test.ts` and see the new tests fail.**

- [ ] **Step 3: Implement in `src/lib/launch-draft.ts`.** Import `savedNftMode` from `"./nft-client"`.

```ts
/** 0: the NFT step (NFT mode only); 1: Identity; 2: Economics (tasks/nft-mode-wallet-picker.md §3.3). */
export type LaunchStep = 0 | 1 | 2;
// The form step is saved with the draft so a reload resumes where the creator left off. A saved 1 or 2 is restored exactly, in both modes,
// so two tabs never move each other's step; a draft with no saved step (a draft link) in NFT mode opens on the NFT step.
export function launchDraftStep(raw: string | null): LaunchStep {
  try {
    const step = JSON.parse(raw || "null")?.step;
    if (step === 1 || step === 2) return step;
    return savedNftMode(raw) ? 0 : 1;
  } catch { return 1; }
}
/** The wizard's steps in order; NFT mode starts with the NFT step. */
export function launchSteps(nftMode: boolean): { step: LaunchStep; label: "NFT" | "Identity" | "Economics" }[] {
  return [...(nftMode ? [{ step: 0 as const, label: "NFT" as const }] : []), { step: 1, label: "Identity" }, { step: 2, label: "Economics" }];
}
/** The heading that takes focus when a step opens. */
export function stepHeadingId(step: LaunchStep): "nft-heading" | "identity-heading" | "quote-heading" {
  return step === 0 ? "nft-heading" : step === 1 ? "identity-heading" : "quote-heading";
}
```

In `resetLaunchedDraftStep`, replace `return JSON.stringify({ ...saved, step: 1 });` with:

```ts
    return JSON.stringify({ ...saved, step: savedNftMode(raw) ? 0 : 1 });
```

In `src/lib/draft-link.ts`, `isPristineDraft` starts with `step <= 1 &&` instead of `step === 1 &&`. A blank NFT-mode draft on the NFT step is still untouched.

- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Both must pass. Widening `LaunchStep` keeps `App.tsx` valid, because it only assigns 1 or 2 today.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/launch-draft.ts src/lib/draft-link.ts tests/launch-draft.test.ts
git commit -m "feat(nft): draft step 0 for the NFT step, restored exactly"
```

---

### Task 5: The wallet picker inside the NFT step

**Files:**
- Modify: `src/lib/nft-client.ts` (two fetchers)
- Create: `src/components/NftPicker.tsx`
- Modify: `src/components/NftLaunchStep.tsx` (picker, manual entry, selected summary, prefill for any picked NFT, connect props)
- Modify: `src/styles.css` (picker styles, next to the `.nft-step` rules)
- Modify: `scripts/test-launch-browser.mjs` (switch to manual entry before using the "Collection contract" and "Token number" inputs)
- Modify: `src/App.tsx` (pass the two new props at the existing `NftLaunchStep` call)

**Interfaces:**
- Consumes:
  - Task 1's types and `filterCollections`;
  - Task 3's endpoints.
- Produces:
  - `readNftCollections(config, owner)` and `readNftTokens(config, owner, contract)`;
  - `NftPicker` props `{ config: RuntimeConfig; account: Address | null; connecting: boolean; onConnect: () => void; onPick: (pick: NftPick) => void; onManual: () => void }`, with `type NftPick = { contract: Address; tokenId: string; name?: string; image?: string }`;
  - `NftLaunchStep` gains the props `connecting: boolean` and `onConnect: () => void`.

- [ ] **Step 1: Add the fetchers** to `src/lib/nft-client.ts`, next to `readNftStatus`:

```ts
/** The NFT step's wallet lists (tasks/nft-mode-wallet-picker.md §4): a convenience; the live check stays the authority. */
export function readNftCollections(config: Pick<RuntimeConfig, "mode" | "deploymentChainId">, owner: Address) {
  return chainApi<OwnedCollections>(deploymentChain(config), `/nft-collections?owner=${owner}`);
}
export function readNftTokens(config: Pick<RuntimeConfig, "mode" | "deploymentChainId">, owner: Address, contract: Address) {
  return chainApi<OwnedNfts>(deploymentChain(config), `/nft-tokens?owner=${owner}&contract=${contract}`);
}
```

Import `OwnedCollections` and `OwnedNfts` as types from `"./nft-holdings"`.

- [ ] **Step 2: Create `src/components/NftPicker.tsx`:**

```tsx
import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { RuntimeConfig } from "../lib/config";
import { filterCollections, type OwnedCollection, type OwnedCollections, type OwnedNfts } from "../lib/nft-holdings";
import { readNftCollections, readNftTokens } from "../lib/nft-client";

export type NftPick = { contract: Address; tokenId: string; name?: string; image?: string };
type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T };
const TRUNCATED = "Showing the first 300. Use manual entry for others.";

function Thumb({ src, size }: { src?: string; size: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span className="nft-thumb nft-thumb-empty" style={{ width: size, height: size }} aria-hidden="true" />;
  return <img className="nft-thumb" src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

/** Step one's list of what the connected wallet holds: its ERC-721 collections, then one collection's NFTs. Every answer is tied to the
 * account, collection and attempt it was asked for, so a wallet switch never shows another account's NFTs. */
export function NftPicker({ config, account, connecting, onConnect, onPick, onManual }: {
  config: RuntimeConfig; account: Address | null; connecting: boolean; onConnect: () => void; onPick: (pick: NftPick) => void; onManual: () => void;
}) {
  const [collections, setCollections] = useState<Load<OwnedCollections>>({ state: "loading" });
  const [open, setOpen] = useState<OwnedCollection | null>(null);
  const [tokens, setTokens] = useState<Load<OwnedNfts>>({ state: "loading" });
  // Separate retry counters: retrying one collection's NFTs must not close that collection or reload the collection list.
  const [query, setQuery] = useState(""), [listAttempt, setListAttempt] = useState(0), [tokenAttempt, setTokenAttempt] = useState(0);
  useEffect(() => { setOpen(null); setQuery(""); }, [account, config.chainId, config.deploymentChainId]);
  useEffect(() => {
    if (!account) return;
    let active = true;
    setCollections({ state: "loading" });
    readNftCollections(config, account).then((value) => { if (active) setCollections({ state: "ready", value }); },
      () => { if (active) setCollections({ state: "error" }); });
    return () => { active = false; };
  }, [account, config.chainId, config.deploymentChainId, listAttempt]);
  useEffect(() => {
    if (!account || !open) return;
    let active = true;
    setTokens({ state: "loading" });
    readNftTokens(config, account, open.contract).then((value) => { if (active) setTokens({ state: "ready", value }); },
      () => { if (active) setTokens({ state: "error" }); });
    return () => { active = false; };
  }, [account, open?.contract, config.chainId, config.deploymentChainId, tokenAttempt]);

  const manual = <button type="button" className="text-button" onClick={onManual}>Enter a contract and token number instead</button>;
  if (!account) return <div className="nft-picker">
    <p>Connect your wallet to see your NFTs.</p>
    <button type="button" className="primary" disabled={connecting} onClick={onConnect}>{connecting ? "Connecting…" : "Connect wallet"}</button>
    {manual}
  </div>;
  const failed = (retry: () => void) => <div className="nft-picker-note" role="alert">
    <p>Couldn't load your NFTs.</p><button type="button" className="secondary" onClick={retry}>Retry</button>{manual}
  </div>;
  if (collections.state === "loading") return <div className="nft-picker"><p role="status">Loading your NFTs…</p>{manual}</div>;
  if (collections.state === "error") return <div className="nft-picker">{failed(() => setListAttempt((n) => n + 1))}</div>;

  if (open) return <div className="nft-picker">
    <button type="button" className="text-button" onClick={() => setOpen(null)}>← All collections</button>
    <h3 className="field-label">{open.name}</h3>
    {tokens.state === "loading" ? <p role="status">Loading your NFTs…</p>
      : tokens.state === "error" ? failed(() => setTokenAttempt((n) => n + 1))
      : <>
        <ul className="nft-token-grid" role="list">
          {tokens.value.tokens.map((token) => <li key={token.tokenId}>
            <button type="button" className="nft-token-tile" disabled={token.launched}
              aria-label={`${token.name ?? `#${token.tokenId}`}${token.launched ? ", already launched" : ""}`}
              onClick={() => onPick({ contract: open.contract, tokenId: token.tokenId, name: token.name, image: token.image })}>
              <Thumb src={token.image} size={120} />
              <span className="nft-token-name">{token.name ?? `#${token.tokenId}`}</span>
              {token.launched && <span className="nft-badge">Already launched</span>}
            </button>
          </li>)}
        </ul>
        {tokens.value.truncated && <p className="hint">{TRUNCATED}</p>}
      </>}
    {manual}
  </div>;

  const shown = filterCollections(collections.value.collections, query);
  return <div className="nft-picker">
    {collections.value.collections.length === 0 ? <p>No NFTs found in this wallet on Robinhood Chain.</p> : <>
      <label className="field">
        <span className="field-label">Search your collections</span>
        <input type="search" aria-label="Search your collections" value={query} autoComplete="off" spellCheck={false}
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ul className="nft-collection-list" role="list">
        {shown.map((collection) => <li key={collection.contract}>
          <button type="button" className="nft-collection-row" onClick={() => setOpen(collection)}>
            <Thumb src={collection.image} size={40} />
            <span className="nft-collection-text">
              <span className="nft-collection-name">{collection.name}</span>
              <span className="hint">{collection.held} held</span>
            </span>
            <span className="nft-badges">
              <span className="nft-badge">{collection.free ? "Free" : "$10"}</span>
              {collection.openSeaVerified && <span className="nft-badge">Verified on OpenSea</span>}
            </span>
          </button>
        </li>)}
      </ul>
      {collections.value.truncated && <p className="hint">{TRUNCATED}</p>}
    </>}
    {manual}
  </div>;
}
```

- [ ] **Step 3: Integrate into `NftLaunchStep`** (`src/components/NftLaunchStep.tsx`).
  - Add the props `connecting: boolean; onConnect: () => void` to the signature and its type.
  - Add state, after the `tokenId` state:

```tsx
  // How the NFT is chosen: from the wallet's list (default), or typed. A draft that already holds an NFT (a reload, another tab, a draft
  // link) opens on its summary, so it is checked again rather than hidden behind an empty list.
  const [manual, setManual] = useState(false), [picking, setPicking] = useState(!nft);
  const picked = useRef(new Map<string, { name?: string; image?: string }>());
  const choose = (pick: NftPick) => {
    const key = nftKey({ chainId: deploymentChain(config), contract: pick.contract, tokenId: pick.tokenId });
    picked.current.set(key, { name: pick.name, image: pick.image });
    edit(() => { setContract(pick.contract); setTokenId(pick.tokenId); });
    setPicking(false); setManual(false);
  };
```

  - **Prefill:** in the check effect, replace the `if (result.free && result.name && prefilled.current !== candidateKey)` block with:

```tsx
        const prefillName = result.free ? result.name : picked.current.get(candidateKey)?.name;
        if (prefillName && prefilled.current !== candidateKey) {
          prefilled.current = candidateKey;
          latest.current.onPrefill?.(prefillName);
        }
```

  - **Rendering**, inside `<fieldset className="nft-step">` after the legend:
    - `manual` true: render the existing contract input, "Use Muses" button and token-number input unchanged, followed by `<button type="button" className="text-button" onClick={() => { setManual(false); setPicking(true); }}>Choose from your wallet instead</button>`.
    - `picking && !manual`: render `<NftPicker config={config} account={account} connecting={connecting} onConnect={onConnect} onPick={choose} onManual={() => setManual(true)} />`.
    - Otherwise (an NFT chosen), render the summary:

```tsx
        <div className="nft-selected">
          <NftSummaryThumb src={candidate ? picked.current.get(candidateKey)?.image : undefined} />
          <div className="nft-collection-text">
            <span className="nft-collection-name">{(candidate && picked.current.get(candidateKey)?.name) ?? `${candidate && isMuse(candidate) ? "Muse" : "NFT"} #${tokenId}`}</span>
            <span className="hint mono">{shortAddress(contract)} · #{tokenId}</span>
          </div>
          <button type="button" className="secondary" onClick={() => setPicking(true)}>Change</button>
        </div>
```

    For `NftSummaryThumb`, export `Thumb` from `NftPicker.tsx` and use `<Thumb src=… size={56} />`. Import `shortAddress` from `"../lib/config"`.
  - Keep the status line (`#nft-launch-status`), Retry, error, fee panel, treasury hint and disclaimers exactly as they are, rendered in every mode.
  - "Change" must not clear the draft's NFT by itself. Only a new pick or a manual edit changes it, through `edit(...)` as today.
  - `statusText` for `!account` stays "Connect the wallet that holds the NFT."

- [ ] **Step 4: Add the CSS** to `src/styles.css`, after the `.nft-step` rule. Use only existing tokens.

```css
.nft-picker { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.nft-picker-note { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nft-collection-list, .nft-token-grid { margin: 0; padding: 0; list-style: none; }
.nft-collection-list { display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
.nft-collection-row, .nft-selected { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; padding: 10px 12px; text-align: left;
  border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface-raised); color: var(--ink); cursor: pointer; }
.nft-selected { cursor: default; }
.nft-collection-row:focus-visible, .nft-token-tile:focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }
.nft-collection-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.nft-collection-name, .nft-token-name { font-weight: 700; overflow-wrap: anywhere; }
.nft-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.nft-badge { padding: 2px 8px; border-radius: 999px; background: var(--surface-sunken); border: 1px solid var(--line); font-size: 12px; font-weight: 600; white-space: nowrap; }
.nft-thumb { flex: none; border-radius: 8px; object-fit: cover; background: var(--surface-sunken); }
.nft-thumb-empty { display: inline-block; }
.nft-token-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; max-height: 520px; overflow-y: auto; }
.nft-token-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%; padding: 8px; border: 1px solid var(--line-strong);
  border-radius: 12px; background: var(--surface-raised); color: var(--ink); cursor: pointer; text-align: left; }
.nft-token-tile .nft-thumb { width: 100%; height: auto; aspect-ratio: 1; }
.nft-token-tile:disabled { cursor: not-allowed; opacity: 0.55; }
@media (max-width: 480px) {
  .nft-token-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nft-collection-row { flex-wrap: wrap; }
  .nft-badges { justify-content: flex-start; width: 100%; padding-left: 52px; }
}
```

On narrow screens the badges wrap below the name and stay visible; "Free" / "$10" must always show.

- [ ] **Step 5: Keep the browser script coherent** (it is not run locally; the owner chose live QA instead of installing playwright).
  - In `scripts/test-launch-browser.mjs`, before each first interaction with `getByLabel('Collection contract'…)` or `getByLabel('Token number'…)` in a scenario that starts with no NFT in the draft, add: `await page.getByRole('button', { name: 'Enter a contract and token number instead' }).click();`
  - Scenarios that restore a draft holding an NFT open on the summary: add a click on "Change", then on "Enter a contract and token number instead", before reading those inputs.
  - Do not run the script.

- [ ] **Step 6: Keep `App.tsx` compiling.** At the existing `<NftLaunchStep …>` call in `src/App.tsx`, add `connecting={wallet.connecting} onConnect={() => void wallet.connect()}`; Task 6 moves that element. Then run `npm test` and `npm run typecheck`. Both must pass.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/nft-client.ts src/components/NftPicker.tsx src/components/NftLaunchStep.tsx src/styles.css scripts/test-launch-browser.mjs src/App.tsx
git commit -m "feat(nft): pick the NFT from the connected wallet, with manual entry as fallback"
```

---

### Task 6: Three-step wizard in the create page

**Files:**
- Modify: `src/App.tsx` (create page only)

**Interfaces:**
- Consumes:
  - Task 4's `LaunchStep`, `launchSteps` and `stepHeadingId`;
  - Task 5's `NftLaunchStep` props.

- [ ] **Step 1: Import** `launchSteps` and `stepHeadingId` from `"./lib/launch-draft"`.

- [ ] **Step 2: Move the launch type cards above the step bar.** Delete `{(config.nftMode?.enabled || nftMode) && <LaunchModeSwitch … />}` from the identity panel. Render the same element as the first child of the `<form id="launch-form">`, before `<ol className="wizard-steps">`.

- [ ] **Step 3: Build the step bar from `launchSteps(nftMode)`:**

```tsx
          <ol className="wizard-steps" role="list" aria-label="Launch steps">
            {launchSteps(nftMode).map(({ step: value, label }, index, all) => <li key={label}>
              <button type="button" className="wizard-step" aria-current={step === value ? "step" : undefined}
                data-done={step > value ? "true" : undefined} onClick={() => openStep(value)}>
                <span className="wizard-step-index" aria-hidden="true">{step > value ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
                <span className="visually-hidden">Step {index + 1} of {all.length}{step > value ? ", completed" : ""}: </span>
                {label}
              </button>
            </li>)}
          </ol>
```

- [ ] **Step 4: Move `<NftLaunchStep …>` out of the identity panel into its own panel,** placed before the identity panel's `wizard-panel`. Keep every existing prop and add the two new ones. The panel uses `hidden`, so the step stays mounted and keeps reporting its status on the other steps.

```tsx
          {nftMode && <div className="wizard-panel" hidden={step !== 0}>
            <section className="card nft-panel" aria-labelledby="nft-heading">
              <div className="card-head"><div>
                <h2 id="nft-heading" className="card-title" tabIndex={-1}>Choose your NFT</h2>
                <p className="card-sub">The coin belongs to this NFT: its creator fees go to the NFT's treasury and follow the NFT when it is sold.</p>
              </div></div>
              <NftLaunchStep key={draftRevision} config={config} account={wallet.account} draft={draft}
                connecting={wallet.connecting} onConnect={() => void wallet.connect()}
                error={invalidField === "nft" ? error : ""} feeRejected={nftFeeRejected} onChange={(nft, user) => update("nft", nft, !user)}
                onCheck={() => { if (invalidField === "nft") { setInvalidField(""); setError(""); } }}
                onFee={(fee) => { update("launchFee", fee, true); setNftFeeRejected(null); if (fee && invalidField === "nft") { setInvalidField(""); setError(""); } }}
                onStatus={setNftStep}
                onPrefill={(name) => { for (const [field, value] of Object.entries(musePrefill(draft, name))) update(field as "name" | "symbol", value, true); }} />
            </section>
          </div>}
```

These are today's props, unchanged, plus `connecting` and `onConnect`.

- [ ] **Step 5: Navigation functions.**
  - Replace `goToStep`'s focus line with `document.getElementById(stepHeadingId(next))?.focus({ preventScroll: true });`.
  - Add, next to `continueToEconomics`:

```tsx
  // The NFT step is complete when the live check passed for this wallet and the fee is settled: the same rule review applies.
  function continueFromNft(): boolean {
    const block = nftReviewBlocker(nftMode, draft, nftStep.status, nftStep.fee, nftStep.checked, wallet.account);
    if (block) {
      setInvalidField("nft"); setError(block);
      const target = nftCheckPassed(draft, nftStep.checked, wallet.account) ? NFT_FEE_ID : NFT_ERROR_ID;
      requestAnimationFrame(() => document.getElementById(target)?.focus());
      return false;
    }
    setInvalidField(""); setError("");
    goToStep(1);
    return true;
  }
  // The step bar: back is always open; forward passes every gate in between, as the Continue buttons do.
  function openStep(target: LaunchStep) {
    if (target === step) return;
    if (target < step) { goToStep(target); return; }
    if (step === 0 && !continueFromNft()) return;
    if (target === 2) continueToEconomics();
  }
```

  `continueToEconomics` reads `draft` from the closure; `continueFromNft` does not change the draft, so calling both in one handler is safe.
  - In `chooseNftMode(next)`, after `setNftMode(next)`:

```tsx
    if (next) goToStep(0);
    else { update("nft", undefined); if (step === 0) goToStep(1); }
```

- [ ] **Step 6: Form submit and actions.**
  - `onSubmit` becomes `if (step === 0) continueFromNft(); else if (step === 1) continueToEconomics(); else preflight();`.
  - In the action area, replace `{step === 1 ? <>…</> : <>…</>}` with three branches. Step 0 shows:

```tsx
            {step === 0 ? <>
              <button type="submit" form="launch-form" className="primary large full">Continue<ArrowRight size={17} /></button>
              <p className="launch-caption">Next, give your coin a name and a face.</p>
            </> : step === 1 ? <>
              {nftMode ? <div className="wizard-actions">
                <button type="button" className="secondary large" onClick={() => goToStep(0)}><ArrowLeft size={17} />Back</button>
                <button type="submit" form="launch-form" className="primary large" disabled={uploadingImage}>Continue<ArrowRight size={17} /></button>
              </div> : <button type="submit" form="launch-form" className="primary large full" disabled={uploadingImage}>Continue<ArrowRight size={17} /></button>}
              <p className="launch-caption">Next, choose what it trades against and an optional first buy.</p>
            </> : <>{/* the existing step-2 block, unchanged */}</>}
```

  The step-2 block keeps its existing JSX unchanged.

- [ ] **Step 7: Retarget the NFT error paths and every hard-coded step.** Run `grep -n "setStep(\|step === \|step !== \|step > \|step < \|identity-heading\|quote-heading" src/App.tsx` and apply:
  - `showNftRejection`: `setStep(1)` → `setStep(0)`. The `NFT_RESERVED_NAME` branch keeps going to the name field (Identity).
  - The focus target `NFT_TOKEN_ID` there becomes `document.getElementById(NFT_TOKEN_ID) ?? document.getElementById(NFT_ERROR_ID)`, because the token input exists only in manual entry.
  - `preflight`'s `nftBlock` branch: `setStep(1)` → `setStep(0)`, with the same focus fallback for `NFT_TOKEN_ID`.
  - Clear draft (`setStep(1)` after "Draft cleared…"): `setStep(nftMode ? 0 : 1)`, using the `nftMode` value the clear leaves. If the clear also resets NFT mode to false, this is `1`.
  - `adoptDraft`, or any place mapping a step to a heading id: use `stepHeadingId(next)`.
  - The link notice condition `step === 1` becomes `step <= 1`.
  - Identity-field errors (`LAUNCH_IDENTITY_FIELDS.includes(field)` → `setStep(1)`) stay `1`.
  - Leave every other `setStep(launchDraftStep(…))` as is.

- [ ] **Step 8: Run `npm test`, `npm run typecheck` and `npm run build`.** Expected: all PASS, with no type errors left anywhere.

- [ ] **Step 9: Commit.**

```bash
git add src/App.tsx
git commit -m "feat(nft): NFT mode is three steps: NFT, Identity, Economics"
```

---

### Task 7: Documentation and final verification

**Files:**
- Modify:
  - `tasks/nft-mode.md` (§6.5 Create, §6.7 cost table);
  - `docs/SPEC.md` (NFT APIs paragraph, around line 184);
  - `public/skill.md` ("What your holder sees when they open it").
- Test: `tests/skill-doc.test.ts` (only if a changed sentence is asserted there)

- [ ] **Step 1: Edit `tasks/nft-mode.md` §6.5.** Replace the "NFT step: 1. Enter the contract and token id (Muses preset)…" sub-list with:

```markdown
  - NFT mode is three steps: NFT → Identity → Economics (`tasks/nft-mode-wallet-picker.md`). The launch type cards sit above the step bar.
  - NFT step: the connected wallet's ERC-721 collections (Alchemy NFT API v3 through `nft-collections`; Muses pinned by address, then OpenSea-verified, then by NFTs held; searchable), then the wallet's NFTs in one collection (`nft-tokens`; already launched NFTs disabled). Manual entry (contract + token number) remains for delegated wallets and unlisted NFTs.
  - Live checks run on the chosen NFT as before: ERC-721, holder or delegate, tier, plus the vault and treasury addresses.
```

  Add this row to the §6.7 table:

```markdown
| NFT step lists | 1–3 Alchemy NFT API calls per uncached request (`getContractsForOwner`, `getNFTsForOwner`, pages of 100, at most 3), cached 60 s per owner; `nft-tokens` adds one catalog read |
```

- [ ] **Step 2: Edit `docs/SPEC.md`.** In the NFT APIs paragraph, add:

```markdown
`nft-collections?owner=` and `nft-tokens?owner=&contract=` list the connected wallet's ERC-721 collections and NFTs for the NFT step (at most 300 each, `truncated` beyond, cached 60 s). They answer 422 `NFT_MODE_UNAVAILABLE` while NFT mode is off (always on Base), 400 for a bad address, and 503 `NFT_LIST_UNAVAILABLE` when the provider fails; the live check and prepare stay the authority.
```

- [ ] **Step 3: Edit `public/skill.md`.** In "What your holder sees when they open it", replace the bullet "A notice says "Imported from a link — check every field." The page stays on step 1." with:

```markdown
- A notice says "Imported from a link — check every field." The page stays on step 1. With an NFT in the link, step 1 is the NFT step: the NFT is already selected, and it is checked as soon as their wallet is connected.
```

  Run `npx tsx --test tests/skill-doc.test.ts`. If a test asserts the old sentence verbatim, update the assertion to the new sentence.

- [ ] **Step 4: Final verification.** Run `npm test`, `npm run typecheck` and `npm run build`. All must pass. Then run `git status --short`; it must be clean after the commit.

- [ ] **Step 5: Commit.**

```bash
git add tasks/nft-mode.md docs/SPEC.md public/skill.md tests/skill-doc.test.ts
git commit -m "docs(nft): three-step NFT mode and the wallet list endpoints"
```

- [ ] **Step 6: Report.** Write `.superpowers/sdd/nft-wallet-picker/codex-report.md` (git-ignored) with:
  - every commit;
  - the test counts;
  - every deviation from this plan, and why;
  - anything not done.
