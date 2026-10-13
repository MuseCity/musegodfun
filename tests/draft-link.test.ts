import test from "node:test";
import assert from "node:assert/strict";
import { encodeDraftLink, decodeDraftFragment, importDraftLink } from "../src/lib/draft-link";
import { MUSES } from "../src/lib/nft-mode";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { restoreDraft, type LaunchInput } from "../src/lib/validation";
import { savedNftMode } from "../src/lib/nft-client";
import { pathChain } from "../src/lib/network";

const draft = { name: "Bard", symbol: "BARD", description: "Epic poetry, now tradable.", nft: { chainId: 4663 as const, contract: MUSES.contract, tokenId: "1" } };
const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!, musegod = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!;
const robinhood = { mode: "robinhood", deploymentChainId: 4663 } as const;
const nftMode = (enabled: boolean) => ({ enabled, vaultFactory: null, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] });
const raw = (value: unknown) => `#draft=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
const decodedDraft = (hash: string) => { const decoded = decodeDraftFragment(hash); return decoded && "draft" in decoded ? decoded.draft : null; };
const errorOf = (hash: string) => { const decoded = decodeDraftFragment(hash); return decoded && "error" in decoded ? decoded.error : null; };

test("round-trips a draft through the fragment", () => {
  const link = encodeDraftLink(draft);
  assert.match(link, /^https:\/\/musegod\.fun\/create\?chainId=4663#draft=[A-Za-z0-9_-]+$/);
  const decoded = decodeDraftFragment(new URL(link).hash);
  assert.deepEqual(decoded && "draft" in decoded ? decoded.draft : null, draft);
});

test("rejects oversized, malformed, unknown-key and launchFee-carrying fragments", () => {
  assert.equal(decodeDraftFragment(""), null);
  assert.ok("error" in (decodeDraftFragment(`#draft=${"A".repeat(4097)}`) ?? {}));
  assert.ok("error" in (decodeDraftFragment("#draft=%%%") ?? {}));
  const raw = (value: object) => `#draft=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  assert.ok("error" in (decodeDraftFragment(raw({ ...draft, v: 1, evil: true })) ?? {}));
  assert.ok("error" in (decodeDraftFragment(raw({ ...draft, v: 1, launchFee: { asset: "stable", txHash: `0x${"11".repeat(32)}` } })) ?? {}));
  assert.ok("error" in (decodeDraftFragment(raw({ ...draft, v: 2 })) ?? {}));
});

test("a fragment that is not a draft link is ignored, and an empty or unreadable one is an error", () => {
  assert.equal(decodeDraftFragment("#top"), null);
  assert.equal(decodeDraftFragment("#drafts=abc"), null);
  for (const hash of ["#draft=", "#draft=abc&x=1", `#draft=${Buffer.from("not json").toString("base64url")}`, `#draft=${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url")}`,
    raw([]), raw("text"), raw(null)])
    assert.ok(errorOf(hash), hash);
  assert.ok(decodeDraftFragment(`#draft=${"A".repeat(4096)}`), "the size limit is 4096 encoded characters");
  assert.equal(errorOf(`#draft=${"A".repeat(4096)}`)?.includes("too long"), false, "4096 is accepted by the size check");
});

test("a link carries identity fields only: never the pair, the launch fee or an unknown key", () => {
  const full = { ...draft, image: "https://example.com/a.png", website: "https://example.com", twitter: "https://x.com/muse", telegram: "https://t.me/muse", tradingFeeBps: 200,
    quoteAddress: weth.address, launchFee: { asset: "stable" as const, txHash: `0x${"11".repeat(32)}` as const } } satisfies Partial<LaunchInput>;
  const link = encodeDraftLink(full);
  const decoded = decodedDraft(new URL(link).hash);
  assert.ok(decoded);
  assert.equal("quoteAddress" in decoded, false);
  assert.equal("launchFee" in decoded, false);
  const { quoteAddress: _pair, launchFee: _fee, ...expected } = full;
  assert.deepEqual(decoded, expected);
  assert.ok(errorOf(raw({ v: 1, name: "Bard", quoteAddress: weth.address })), "a crafted link cannot choose the pair");
});

test("an encoded link is canonical: re-encoding what it decodes gives the same link", () => {
  const link = encodeDraftLink({ nft: draft.nft, description: draft.description, symbol: draft.symbol, name: draft.name });
  assert.equal(encodeDraftLink(decodedDraft(new URL(link).hash)!), link);
  assert.equal(link, encodeDraftLink(draft));
});

test("the link's origin and chain are the caller's", () => {
  assert.match(encodeDraftLink(draft, "http://127.0.0.1:5191", 8453), /^http:\/\/127\.0\.0\.1:5191\/create\?chainId=8453#draft=/);
});

test("a link's chainId is read by the app's existing chain selection, with no fragment involved", () => {
  for (const chainId of [4663, 8453]) {
    const url = new URL(encodeDraftLink(draft, "https://musegod.fun", chainId));
    assert.equal(pathChain(url.pathname, url.search), chainId);
  }
});

test("an absent field stays absent: a partial link gains no defaults", () => {
  assert.deepEqual(decodedDraft(raw({ v: 1, name: "Bard" })), { name: "Bard" });
  assert.deepEqual(decodedDraft(raw({ v: 1 })), {});
});

test("link values pass the launch form's own field checks", () => {
  assert.equal(decodedDraft(raw({ v: 1, symbol: "bard9" }))?.symbol, "BARD9", "the symbol is upper-cased like the form's");
  for (const bad of [{ symbol: "1BARD" }, { symbol: "B".repeat(11) }, { name: "" }, { name: "N".repeat(33) }, { description: "d".repeat(281) },
    { image: "http://example.com/a.png" }, { image: "https://127.0.0.1/a.png" }, { website: "javascript:alert(1)" }, { twitter: "https://example.com/muse" },
    { telegram: "https://example.com/muse" }, { tradingFeeBps: 50 }, { tradingFeeBps: 150.5 }, { tradingFeeBps: "100" },
    { nft: { chainId: 1, contract: MUSES.contract, tokenId: "1" } }, { nft: { ...draft.nft, tokenId: "007" } }, { nft: { ...draft.nft, extra: 1 } }, { nft: { ...draft.nft, contract: "0x1234" } }])
    assert.ok(errorOf(raw({ v: 1, name: "Bard", ...bad })), JSON.stringify(bad));
});

test("a Muse link is restored through restoreDraft: the pair is MUSEGOD and the link never chooses a fee", () => {
  const config = { ...robinhood, nftMode: nftMode(true) };
  const imported = importDraftLink(draft, config);
  const restored = restoreDraft(imported.raw, config);
  assert.equal(restored.quoteAddress, musegod.address);
  assert.deepEqual(restored.nft, draft.nft);
  assert.equal(restored.name, "Bard");
  assert.equal(restored.launchFee, undefined);
  assert.equal(savedNftMode(imported.raw), true, "the form opens in NFT mode");
  assert.equal(imported.notice, "Imported from a link — check every field.");
});

test("importing never takes the pair or the launch fee, even from a draft that carries them", () => {
  const imported = importDraftLink({ name: "Plain", quoteAddress: weth.address, launchFee: { asset: "stable", txHash: `0x${"11".repeat(32)}` } }, { ...robinhood, nftMode: nftMode(true) });
  assert.deepEqual(JSON.parse(imported.raw), { name: "Plain" });
});

test("a link without an NFT imports a normal draft", () => {
  const imported = importDraftLink({ name: "Plain", symbol: "PLAIN" }, { ...robinhood, nftMode: nftMode(true) });
  const restored = restoreDraft(imported.raw, robinhood);
  assert.equal(restored.name, "Plain");
  assert.equal(restored.nft, undefined);
  assert.equal(savedNftMode(imported.raw), false);
  assert.equal(imported.notice, "Imported from a link — check every field.");
});

test("where NFT mode is off the NFT is dropped, the other fields are imported and the notice says so", () => {
  for (const config of [robinhood, { ...robinhood, nftMode: nftMode(false) }, { mode: "base", deploymentChainId: 8453, nftMode: nftMode(false) } as const]) {
    const imported = importDraftLink(draft, config);
    const restored = restoreDraft(imported.raw, config);
    assert.equal(restored.nft, undefined);
    assert.equal(restored.name, "Bard");
    assert.equal(restored.symbol, "BARD");
    assert.equal(restored.description, "Epic poetry, now tradable.");
    assert.equal(savedNftMode(imported.raw), false, "no NFT mode without an NFT");
    assert.equal(imported.notice, "Imported from a link — check every field. NFT mode is not available on this network yet; the NFT was not imported.");
  }
});
