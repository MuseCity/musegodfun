import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { NftHoldings, NFT_LIST_UNAVAILABLE_MESSAGE } from "../server/nft-holdings";
import { MUSES } from "../src/lib/nft-mode";

const owner = getAddress("0x6e53e8380dc25cc9359e7150b619f51821f6d966");
const other = getAddress("0x00e3d6631ecbcd1848cbec005dc2545533b52b87");
type Reply = { status?: number; body?: unknown; raw?: string; throws?: Error };
function fakeFetch(replies: Reply[]) {
  const urls: string[] = [];
  const requests: RequestInit[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    requests.push(init ?? {});
    const next = replies.shift() ?? { status: 500, body: {} };
    if (next.throws) throw next.throws;
    return new Response(next.raw ?? JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, urls, requests };
}
const contract = (address: string, over: object = {}) => ({ address, name: "Name", tokenType: "ERC721", isSpam: false, numDistinctTokensOwned: "2",
  image: { thumbnailUrl: "https://img.test/t.png" }, openSeaMetadata: { collectionName: "OS Name", imageUrl: "https://os.test/logo.png", safelistRequestStatus: "not_requested" }, ...over });
const isFree = (c: string) => c.toLowerCase() === MUSES.contract.toLowerCase();
const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const failsUnavailable = async (run: () => Promise<unknown>) => {
  await assert.rejects(run, (e: any) => e.code === "NFT_LIST_UNAVAILABLE" && e.message === NFT_LIST_UNAVAILABLE_MESSAGE && !/alchemy|opensea|key/i.test(e.message));
};

test("without an Alchemy key the list is unavailable and nothing is fetched", async () => {
  const { fetch, urls } = fakeFetch([]);
  await failsUnavailable(() => new NftHoldings({ fetch }).collections(owner, isFree));
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
  const result = await new NftHoldings({ alchemyKey: "k/ey", fetch }).collections(owner, isFree);
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
  assert.equal((await new NftHoldings({ alchemyKey: "k", fetch: two.fetch }).collections(owner, isFree)).truncated, false);
  assert.equal(two.urls.length, 2); assert.match(two.urls[1], /pageKey=p2/);
  const many = fakeFetch([page("a"), page("b"), page("c"), page("d")]);
  assert.equal((await new NftHoldings({ alchemyKey: "k", fetch: many.fetch }).collections(owner, isFree)).truncated, true);
  assert.equal(many.urls.length, 3);
});

test("a non-2xx answer, a malformed body or a network error is NFT_LIST_UNAVAILABLE, and failures are not cached", async () => {
  for (const reply of [{ status: 500, body: {} }, { status: 200, body: { nope: true } }, { throws: new Error("socket https://robinhood-mainnet.g.alchemy.com/nft/v3/k/x") }]) {
    const { fetch } = fakeFetch([reply]);
    await failsUnavailable(() => new NftHoldings({ alchemyKey: "k", fetch }).collections(owner, isFree));
  }
  const { fetch, urls } = fakeFetch([{ status: 500 }, { body: { contracts: [], pageKey: null } }]);
  const holdings = new NftHoldings({ alchemyKey: "k", fetch });
  await failsUnavailable(() => holdings.collections(owner, isFree));
  assert.deepEqual((await holdings.collections(owner, isFree)).collections, []);
  assert.equal(urls.length, 2);
});

test("answers are cached for 60 seconds per owner, then read again", async () => {
  let now = 1_000_000;
  const { fetch, urls } = fakeFetch([{ body: { contracts: [], pageKey: null } }, { body: { contracts: [], pageKey: null } }]);
  const holdings = new NftHoldings({ alchemyKey: "k", fetch, now: () => now });
  await holdings.collections(owner, isFree);
  now += 59_999; await holdings.collections(getAddress(owner.toLowerCase()), isFree);
  assert.equal(urls.length, 1);
  now += 2; await holdings.collections(owner, isFree);
  assert.equal(urls.length, 2);
});

const slugReply = { body: { address: other.toLowerCase(), chain: "robinhood", collection: "revealed-muses", contract_standard: "erc721", name: "Muses" } };
const emptyNfts = { body: { nfts: [], next: null } };
const nft = (identifier: string, over: object = {}) => ({ identifier, contract: other.toLowerCase(), token_standard: "erc721", name: ` Item ${identifier} `,
  display_image_url: "https://display.test/n.png", image_url: "https://original.test/n.png", ...over });
const json = (body: unknown) => new Response(JSON.stringify(body));

test("without an OpenSea key tokens are unavailable without fetching, even with an Alchemy key", async () => {
  for (const openSeaKey of [undefined, "   "]) {
    const { fetch, urls } = fakeFetch([]);
    await failsUnavailable(() => new NftHoldings({ alchemyKey: "alchemy-only", openSeaKey, fetch }).tokens(owner, other));
    assert.equal(urls.length, 0);
  }
});

test("tokens look up the slug and send the OpenSea key only in headers on every request", async () => {
  const key = "private-opensea/key?secret=1";
  const { fetch, urls, requests } = fakeFetch([slugReply, { body: { nfts: [nft("631", { name: " Dimple " })], next: "cursor+/=" } }, emptyNfts]);
  const result = await new NftHoldings({ openSeaKey: ` ${key} `, fetch }).tokens(owner, other);
  assert.equal(result.tokens[0]!.name, "Dimple");
  assert.equal(urls[0], `https://api.opensea.io/api/v2/chain/robinhood/contract/${other.toLowerCase()}`);
  for (let i = 0; i < urls.length; i++) {
    assert.equal(urls[i]!.includes(key), false);
    assert.equal(urls[i]!.includes(encodeURIComponent(key)), false);
    const headers = new Headers(requests[i]!.headers);
    assert.equal(headers.get("x-api-key"), key);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("user-agent"), "musegod.fun/1 (+https://musegod.fun)");
    assert.equal(requests[i]!.redirect, "manual");
    assert(requests[i]!.signal instanceof AbortSignal);
    if (i) {
      const url = new URL(urls[i]!);
      assert.equal(url.pathname, `/api/v2/chain/robinhood/account/${owner}/nfts`);
      assert.equal(url.searchParams.get("collection"), "revealed-muses");
      assert.equal(url.searchParams.get("limit"), "100");
    }
  }
  assert.equal(new URL(urls[2]!).searchParams.get("next"), "cursor+/=");
});

test("tokens filter by case-insensitive contract, erc721 and decimal ids, sort numerically, trim names and keep https images", async () => {
  const large = "9".repeat(77);
  const { fetch } = fakeFetch([slugReply, { body: { nfts: [
    nft("10"), nft("9", { display_image_url: "http://insecure.test/n.png" }),
    nft("0", { name: "   ", display_image_url: "ipfs://sealed", image_url: "http://insecure.test/n.png" }),
    nft("2", { contract: other.toUpperCase(), name: ` ${"N".repeat(90)} `, display_image_url: null }),
    nft(large, { name: null, display_image_url: "not a URL", image_url: "https://fallback.test/n.png" }),
    nft("3", { contract: MUSES.contract }), nft("4", { token_standard: "erc1155" }), nft("5", { token_standard: "ERC721" }),
    ...["", "01", "0x1f", "-1", "1.5", "1e3", "9".repeat(79)].map((id) => nft(id)),
  ] } }]);
  const result = await new NftHoldings({ openSeaKey: "k", fetch }).tokens(owner, other);
  assert.deepEqual(result, { truncated: false, tokens: [
    { tokenId: "0" }, { tokenId: "2", name: "N".repeat(80), image: "https://original.test/n.png" },
    { tokenId: "9", name: "Item 9", image: "https://original.test/n.png" },
    { tokenId: "10", name: "Item 10", image: "https://display.test/n.png" },
    { tokenId: large, image: "https://fallback.test/n.png" },
  ] });
});

test("tokens stop after three pages (300 NFTs) and report whether next remains", async () => {
  for (const more of [false, true]) {
    const { fetch, urls } = fakeFetch([slugReply, ...Array.from({ length: 4 }, (_, index) => ({ body: {
      nfts: Array.from({ length: 100 }, (_, token) => nft(String(index * 100 + token))),
      next: index < 2 || more ? `page-${index + 1}` : null,
    } }))]);
    const result = await new NftHoldings({ openSeaKey: "k", fetch }).tokens(owner, other);
    assert.equal(result.truncated, more);
    assert.equal(result.tokens.length, 300);
    assert.equal(result.tokens[0]!.tokenId, "0"); assert.equal(result.tokens[299]!.tokenId, "299");
    assert.equal(urls.length, 4, "one slug lookup and three NFT pages");
    assert.equal(new URL(urls[3]!).searchParams.get("next"), "page-2");
  }
});

test("slug cache is per lowercase contract, shared across owners, and expires at exactly one hour", async () => {
  let now = 0;
  const { fetch, urls } = fakeFetch([slugReply, emptyNfts, emptyNfts, emptyNfts, slugReply, emptyNfts,
    { body: { collection: "another-collection" } }, emptyNfts]);
  const holdings = new NftHoldings({ openSeaKey: "k", fetch, now: () => now });
  await holdings.tokens(owner, other);
  now = 60_000;
  await holdings.tokens(at(1), other.toLowerCase() as typeof other);
  now = 3_599_999;
  await holdings.tokens(owner, other);
  assert.equal(urls.filter((url) => url.includes("/contract/")).length, 1);
  now = 3_600_000;
  await holdings.tokens(at(2), other);
  assert.equal(urls.filter((url) => url.includes("/contract/")).length, 2);
  await holdings.tokens(owner, MUSES.contract);
  assert.equal(urls.filter((url) => url.includes("/contract/")).length, 3);
  assert.equal(new URL(urls.at(-1)!).searchParams.get("collection"), "another-collection");
});

test("an unknown contract's synthetic slug can return an empty NFT list", async () => {
  const { fetch, urls } = fakeFetch([{ body: { collection: `${other.toLowerCase()}-170968457` } }, emptyNfts]);
  assert.deepEqual(await new NftHoldings({ openSeaKey: "k", fetch }).tokens(owner, other), { truncated: false, tokens: [] });
  assert.equal(urls.length, 2);
});

test("OpenSea lookup and page errors become a fixed unavailable message, never cache failures or leak the key", async () => {
  const key = "private-opensea-secret";
  for (const stage of ["slug", "page"]) {
    const malformed = stage === "slug"
      ? [{}, { collection: null }, { collection: " " }, { collection: 12 }]
      : [{}, { nfts: null }, { nfts: [{}] }, { nfts: [], next: 12 }, { nfts: [nft("1", { identifier: 1 })] }];
    const failures: Reply[] = [{ status: 503 }, { status: 302 }, { raw: "invalid JSON" }, ...malformed.map((body) => ({ body })),
      { throws: new Error(`upstream ${key}`) }, { throws: new DOMException(key, "TimeoutError") }];
    for (const failure of failures) {
      const { fetch, urls } = fakeFetch([...(stage === "page" ? [slugReply] : []), failure, ...(stage === "slug" ? [slugReply] : []), emptyNfts]);
      const holdings = new NftHoldings({ openSeaKey: key, fetch });
      await failsUnavailable(() => holdings.tokens(owner, other));
      assert.deepEqual(await holdings.tokens(owner, other), { truncated: false, tokens: [] });
      assert.equal(urls.length, 3, `${stage}: failed lookup or answer retried; successful slug reused`);
    }
  }
});

test("each provider call uses an eight-second timeout and maps aborts to NFT_LIST_UNAVAILABLE", async (t) => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return AbortSignal.abort(new DOMException("timeout", "TimeoutError")); });
  const fetch = (async (_url: unknown, init?: RequestInit) => { init!.signal!.throwIfAborted(); assert.fail("must abort"); }) as typeof globalThis.fetch;
  const holdings = new NftHoldings({ alchemyKey: "a", openSeaKey: "o", fetch });
  await failsUnavailable(() => holdings.collections(owner, isFree));
  await failsUnavailable(() => holdings.tokens(owner, other));
  assert.deepEqual(deadlines, [8_000, 8_000]);
});

test("identical in-flight lists share one load, including token pages; failed shared loads can retry", async () => {
  const releases: ((response: Response) => void)[] = [], urls: string[] = [];
  const fetch = ((url: string | URL) => {
    urls.push(String(url));
    return new Promise<Response>((resolve) => releases.push(resolve));
  }) as typeof globalThis.fetch;
  const holdings = new NftHoldings({ alchemyKey: "a", openSeaKey: "o", fetch, now: () => 0 });
  const first = holdings.collections(owner, isFree), second = holdings.collections(owner.toLowerCase() as typeof owner, isFree);
  assert.equal(urls.length, 1);
  releases.shift()!(json({ contracts: [contract(other)] }));
  assert.deepEqual(await first, await second);
  const tokens = holdings.tokens(owner, other), same = holdings.tokens(owner.toLowerCase() as typeof owner, other.toLowerCase() as typeof other);
  assert.equal(urls.length, 2, "one shared slug lookup");
  const failed = Promise.all([failsUnavailable(() => tokens), failsUnavailable(() => same)]);
  releases.shift()!(json(slugReply.body));
  // Let the successful lookup hand off to its NFT page.
  while (!releases.length) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 3, "one shared NFT page");
  releases.shift()!(new Response("{}", { status: 503 }));
  await failed;
  const retry = holdings.tokens(owner, other);
  while (!releases.length) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 4, "successful slug retained; failed answer neither cached nor left in flight");
  releases.shift()!(json(emptyNfts.body));
  assert.deepEqual(await retry, { truncated: false, tokens: [] });
});

test("six uncached loads are shared across providers; token in-flight sharing and cache hits still work", async () => {
  const releases: (() => void)[] = [];
  let calls = 0, held = false;
  const fetch = (async (url: string | URL) => {
    calls++;
    if (held) await new Promise<void>((resolve) => releases.push(resolve));
    return json(String(url).includes("/contract/") ? slugReply.body : { contracts: [], nfts: [] });
  }) as typeof globalThis.fetch;
  const holdings = new NftHoldings({ alchemyKey: "a", openSeaKey: "o", fetch, now: () => 0 });
  await holdings.collections(owner, isFree); await holdings.tokens(owner, other);
  held = true;
  const loads = Array.from({ length: 6 }, (_, i) => i % 2 ? holdings.tokens(at(i + 1), other) : holdings.collections(at(i + 1), isFree));
  const shared = holdings.tokens(at(2), other.toLowerCase() as typeof other);
  try {
    await failsUnavailable(() => holdings.collections(at(7), isFree));
    await failsUnavailable(() => holdings.tokens(at(7), other));
    await holdings.collections(owner, isFree); await holdings.tokens(owner, other);
    assert.equal(calls, 9, "three warmup calls and six loads; shared and cached requests spend no calls");
  } finally { held = false; releases.splice(0).forEach((release) => release()); await Promise.all([...loads, shared]); }
  await holdings.tokens(at(7), other);
  assert.equal(calls, 10, "refusal not cached, and completed loads release capacity");
});

test("each provider has its own 120-call budget; neither spends the other's allowance", async () => {
  for (const firstProvider of ["alchemy", "openSea"]) {
    const counts = { alchemy: 0, openSea: 0 };
    const fetch = (async (url: string | URL) => {
      counts[String(url).includes("opensea.io") ? "openSea" : "alchemy"]++;
      return json(String(url).includes("/contract/") ? slugReply.body : { contracts: [], nfts: [] });
    }) as typeof globalThis.fetch;
    const holdings = new NftHoldings({ alchemyKey: "a", openSeaKey: "o", fetch, now: () => 0 });
    const exhaustAlchemy = async () => { for (let i = 1; i <= 120; i++) await holdings.collections(at(i), isFree); };
    const exhaustOpenSea = async () => { for (let i = 1; i <= 119; i++) await holdings.tokens(at(i), other); };
    if (firstProvider === "alchemy") { await exhaustAlchemy(); await exhaustOpenSea(); }
    else { await exhaustOpenSea(); await exhaustAlchemy(); }
    await failsUnavailable(() => holdings.collections(at(121), isFree));
    await failsUnavailable(() => holdings.tokens(at(120), other));
    if (firstProvider === "alchemy") await holdings.tokens(at(119), other);
    else await holdings.collections(at(120), isFree);
    assert.deepEqual(counts, { alchemy: 120, openSea: 120 }, "slug lookup counts; denials and cache hits do not");
  }
});

test("provider budgets expire by individual call time at the exact rolling-minute boundary", async () => {
  for (const provider of ["alchemy", "openSea"]) {
    let now = 0, calls = 0;
    const fetch = (async (url: string | URL) => { calls++; return json(String(url).includes("/contract/") ? slugReply.body : { contracts: [], nfts: [] }); }) as typeof globalThis.fetch;
    const holdings = new NftHoldings({ alchemyKey: "a", openSeaKey: "o", fetch, now: () => now });
    const load = (id: number) => provider === "alchemy" ? holdings.collections(at(id), isFree) : holdings.tokens(at(id), other);
    const initial = provider === "alchemy" ? 60 : 59;
    for (let i = 1; i <= initial; i++) await load(i);
    assert.equal(calls, 60);
    now = 30_000;
    for (let i = initial + 1; i <= initial + 60; i++) await load(i);
    now = 59_999;
    await load(initial + 60);
    await failsUnavailable(() => load(200));
    assert.equal(calls, 120);
    now = 60_000;
    for (let i = 200; i < 260; i++) await load(i);
    await failsUnavailable(() => load(260));
    assert.equal(calls, 180, "only the first sixty calls expired");
    now = 90_000;
    await load(260);
    assert.equal(calls, 181, "earlier refusal was not cached");
  }
});

test("OpenSea slug lookup and each page spend budget; partial lists never enter the answer cache", async () => {
  let now = 0;
  const page = (next: string | null) => ({ body: { nfts: [nft("1")], next } });
  const { fetch, urls } = fakeFetch([slugReply, ...Array.from({ length: 117 }, () => emptyNfts), page("p2"), page("p3"),
    page("p2"), page("p3"), page(null)]);
  const holdings = new NftHoldings({ openSeaKey: "o", fetch, now: () => now });
  for (let i = 1; i <= 117; i++) await holdings.tokens(at(i), other);
  await failsUnavailable(() => holdings.tokens(owner, other));
  assert.equal(urls.length, 120, "page three is denied before fetching");
  now = 60_000;
  assert.equal((await holdings.tokens(owner, other)).tokens.length, 3);
  assert.equal(urls.length, 123, "all three pages fetched again; successful slug still cached");
  assert.equal(new URL(urls[120]!).searchParams.has("next"), false);
  assert.equal(new URL(urls[122]!).searchParams.get("next"), "p3");
});

test("failed calls still spend each provider's rolling-minute budget", async () => {
  for (const provider of ["alchemy", "openSea"]) {
    let now = 0, calls = 0;
    const fetch = (async () => { calls++; return new Response("{}", { status: 503 }); }) as typeof globalThis.fetch;
    const holdings = new NftHoldings({ alchemyKey: "a", openSeaKey: "o", fetch, now: () => now });
    const load = () => provider === "alchemy" ? holdings.collections(owner, isFree) : holdings.tokens(owner, other);
    for (let i = 0; i < 121; i++) await failsUnavailable(load);
    assert.equal(calls, 120);
    now = 60_000; await failsUnavailable(load);
    assert.equal(calls, 121);
  }
});

test("token answer cache includes owner and contract, normalizes case, and expires at sixty seconds", async () => {
  let now = 0;
  const page = (address: string, id: string) => ({ body: { nfts: [nft(id, { contract: address, name: null, display_image_url: null, image_url: null })] } });
  const { fetch, urls } = fakeFetch([slugReply, page(other, "1"), { body: { collection: "muses" } }, page(MUSES.contract, "2"), page(other, "3"), page(other, "4")]);
  const holdings = new NftHoldings({ openSeaKey: "o", fetch, now: () => now });
  assert.deepEqual((await holdings.tokens(owner, other)).tokens, [{ tokenId: "1" }]);
  assert.deepEqual((await holdings.tokens(owner, MUSES.contract)).tokens, [{ tokenId: "2" }]);
  assert.deepEqual((await holdings.tokens(at(1), other)).tokens, [{ tokenId: "3" }]);
  now = 59_999;
  assert.deepEqual((await holdings.tokens(owner.toLowerCase() as typeof owner, other.toLowerCase() as typeof other)).tokens, [{ tokenId: "1" }]);
  assert.equal(urls.length, 5);
  now = 60_000;
  assert.deepEqual((await holdings.tokens(owner, other)).tokens, [{ tokenId: "4" }]);
  assert.equal(urls.length, 6);
});

test("the shared answer cache keeps only the most recent hundred successful entries", async () => {
  let calls = 0;
  const fetch = (async (url: string | URL) => { calls++; return json(String(url).includes("/contract/") ? slugReply.body : { contracts: [], nfts: [] }); }) as typeof globalThis.fetch;
  const holdings = new NftHoldings({ alchemyKey: "a", openSeaKey: "o", fetch, now: () => 0 });
  const load = (id: number) => id % 2 ? holdings.collections(at(id), isFree) : holdings.tokens(at(id), other);
  for (let i = 1; i <= 101; i++) await load(i);
  await load(2);
  assert.equal(calls, 102, "second entry remains cached, plus one slug lookup");
  await load(1);
  assert.equal(calls, 103, "oldest entry evicted within its TTL");
});

test("the slug cache keeps at most five hundred successful contracts", async () => {
  let now = 0, lookups = 0;
  const fetch = (async (url: string | URL) => {
    if (String(url).includes("/contract/")) { lookups++; return json(slugReply.body); }
    return json(emptyNfts.body);
  }) as typeof globalThis.fetch;
  const holdings = new NftHoldings({ openSeaKey: "o", fetch, now: () => now });
  for (let i = 1; i <= 501; i++) { now = Math.floor((i - 1) / 50) * 60_000; await holdings.tokens(owner, at(i)); }
  assert.equal(lookups, 501);
  await holdings.tokens(at(1), at(2));
  assert.equal(lookups, 501, "an entry in the newest five hundred remains cached");
  await holdings.tokens(at(1), at(1));
  assert.equal(lookups, 502, "oldest slug evicted before the hour elapsed");
});
