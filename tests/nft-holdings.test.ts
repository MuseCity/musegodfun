import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { filterCollections, httpsImage, nftTokensMatch, reservedLaunchName, sortCollections, type OwnedCollection } from "../src/lib/nft-holdings";
import { musePrefill } from "../src/lib/nft-client";
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
  assert.deepEqual(musePrefill({ name: "", symbol: "" }, "Bronze Key #2014"), { name: "Bronze Key #2014", symbol: "BRONZEKEY" });
  assert.deepEqual(musePrefill({ name: "Mine", symbol: "" }, "Sealed Muse"), { symbol: "SEALEDMUSE" });
  assert.deepEqual(musePrefill({ name: "", symbol: "" }, "Muse-God"), {});
  assert.deepEqual(musePrefill({ name: "", symbol: "" }, "Musegod #7"), { name: "Musegod #7" }); // name is not reserved ("MUSEGOD7"); symbol "MUSEGOD" is
});
