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
