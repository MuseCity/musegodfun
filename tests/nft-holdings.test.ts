import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { filterCollections, httpsImage, nftTokensMatch, reservedLaunchName, sortCollections, type OwnedCollection } from "../src/lib/nft-holdings";
import { nftPrefill } from "../src/lib/nft-client";
import { MUSES } from "../src/lib/nft-mode";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const row = (over: Partial<OwnedCollection>): OwnedCollection => ({ contract: at(1), name: "A", held: 1, free: false, openSeaVerified: false, ...over });

test("picker token answers match both the current wallet and collection, ignoring address case", () => {
  const answer = { owner: at(1), contract: MUSES.contract, truncated: false, tokens: [] };
  assert.equal(nftTokensMatch(answer, at(1), MUSES.contract.toLowerCase() as typeof MUSES.contract), true);
  assert.equal(nftTokensMatch(answer, at(2), MUSES.contract), false, "a previous wallet's NFTs stay hidden");
  assert.equal(nftTokensMatch(answer, at(1), at(3)), false, "a previous collection's NFTs stay hidden");
});

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
  assert.deepEqual(nftPrefill({ image: "", name: "", symbol: "" }, { name: "Bronze Key #2014" }), { name: "Bronze Key #2014", symbol: "BRONZEKEY" });
  assert.deepEqual(nftPrefill({ image: "", name: "Mine", symbol: "" }, { name: "Sealed Muse" }), { symbol: "SEALEDMUSE" });
  assert.deepEqual(nftPrefill({ image: "", name: "", symbol: "" }, { name: "Muse-God" }), {});
  assert.deepEqual(nftPrefill({ image: "", name: "", symbol: "" }, { name: "Musegod #7" }), { name: "Musegod #7" }); // name is not reserved ("MUSEGOD7"); symbol "MUSEGOD" is
});

test("prefilled identity follows a new NFT while typed and uploaded fields stay untouched", () => {
  const previous = { name: "Bard", symbol: "BARD", image: "https://gateway.pinata.cloud/ipfs/old" };
  const next = { name: "Dimple", image: "https://gateway.pinata.cloud/ipfs/new" };
  assert.deepEqual(nftPrefill(previous, next, previous), { ...next, symbol: "DIMPLE" });
  assert.deepEqual(nftPrefill({ name: "My name", symbol: "MINE", image: "https://mine.test/upload" }, next, previous), {});
  assert.deepEqual(nftPrefill({ ...previous, symbol: "MINE" }, next, previous), next);
  assert.deepEqual(nftPrefill({ name: "", symbol: "", image: "" }, next, previous), { ...next, symbol: "DIMPLE" });
});

test("missing or reserved NFT values clear only the previous prefill's fields", () => {
  const previous = { name: "Bard", symbol: "BARD", image: "https://gateway.pinata.cloud/ipfs/old" };
  assert.deepEqual(nftPrefill(previous, {}, previous), { name: "", symbol: "", image: "" });
  assert.deepEqual(nftPrefill({ ...previous, image: "https://mine.test/upload" }, {}, previous), { name: "", symbol: "" });
  assert.deepEqual(nftPrefill(previous, { name: "Muse-God" }, previous), { name: "", symbol: "", image: "" });
  assert.deepEqual(nftPrefill(previous, { name: "Musegod #7" }, previous), { name: "Musegod #7", symbol: "", image: "" });
  assert.deepEqual(nftPrefill(previous, { name: "123" }, previous), { name: "123", symbol: "", image: "" });
  assert.deepEqual(nftPrefill({ name: "Mine", symbol: "MINE", image: "https://mine.test/upload" }, {}, previous), {});
});

test("prefill ownership uses exact values and may be relinquished even when a manual value matches", () => {
  const previous = { name: "Bard", symbol: "BARD", image: "https://gateway.pinata.cloud/ipfs/old" };
  assert.deepEqual(nftPrefill({ ...previous, name: " Bard " }, { name: "Dimple" }, previous), { symbol: "DIMPLE", image: "" });
  assert.deepEqual(nftPrefill(previous, { name: "Dimple", image: "https://next.test/image" }, {}), {});
  const current = { ...previous, image: "https://mine.test/upload" };
  assert.equal(nftPrefill(current, { image: "https://gateway.pinata.cloud/ipfs/new" }, previous).image, undefined,
    "the completion check reads the latest image, not the draft captured before the upload");
});

test("a prefilled name is trimmed again after the 32-character bound", () => {
  const result = nftPrefill({ name: "", symbol: "", image: "" }, { name: "Pudgy Penguins Lil Pudgy Club o #42" });
  assert.equal(result.name, "Pudgy Penguins Lil Pudgy Club o");
  assert.equal(result.name?.trim(), result.name);
});
