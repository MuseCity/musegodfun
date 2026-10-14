import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADMITTED_BASE_ASSET_COUNT, STOCKS, ROBINHOOD_STOCKS, launchAssetsFor, stockByAddress, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { draftAutosave, firstBuyDraft, isBlankDraft, type DraftBasis, launchDraftKey, launchDraftStep, resetLaunchedDraftStep, savedLaunchDraft } from "../src/lib/launch-draft";
import { firstBuyPaymentAssets } from "../src/lib/first-buy-payment";
import { LAUNCH_IDENTITY_FIELDS, launchIdentityIssue, launchSchema, restoreDraft } from "../src/lib/validation";
import { DEFAULT_TRADING_FEE_BPS, TRADING_FEE_BPS } from "../src/lib/trading-fee";
const config = (chain: 8453 | 4663, fork = false): RuntimeConfig => ({ mode: fork ? "fork" : chain === 8453 ? "base" : "robinhood",
  chainId: fork ? 31337 : chain, deploymentChainId: chain, treasury: null, writesEnabled: false, blockReason: null });
function storage(t: { after: (fn: () => void) => void }) {
  const values = new Map<string, string>(), original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  return values;
}
test("drafts preserve intended amounts and locks only within their network, including isolated forks", (t) => {
  const values = storage(t), base = config(8453), rh = config(4663);
  const stock = launchAssetsFor(rh)[0], usd = firstBuyPaymentAssets(4663)[0];
  values.set(launchDraftKey(rh), JSON.stringify({ quoteAddress: stock.address,
    firstBuy: { amount: "10.5", slippageBps: 200, payAddress: usd.address, lockDays: 90 } }));
  assert.deepEqual(firstBuyDraft(rh), { amount: "10.5", slippageBps: 200, payAddress: usd.address, lockDays: 90 });
  assert.equal(firstBuyDraft(base).amount, "0");
  assert.notEqual(launchDraftKey(config(8453, true)), launchDraftKey(config(4663, true)));
  assert.equal(firstBuyDraft(config(4663, true)).amount, "0");
});
test("legacy draft migration chooses the asset network and cannot overwrite a newer scoped draft", (t) => {
  const values = storage(t), base = config(8453), rh = config(4663);
  values.set("musegod.launch.draft", JSON.stringify({ quoteAddress: STOCKS[0].address, firstBuy: { amount: "3", slippageBps: 50 } }));
  assert.equal(savedLaunchDraft(rh), null);
  assert.equal(firstBuyDraft(base).amount, "3");
  assert.equal(firstBuyDraft(base).payAddress, STOCKS[0].address);
  assert(!values.has("musegod.launch.draft"));
  values.set(launchDraftKey(base), JSON.stringify({ quoteAddress: STOCKS[0].address, firstBuy: { amount: "9", slippageBps: 100 } }));
  values.set("musegod.launch.draft", JSON.stringify({ quoteAddress: STOCKS[0].address, firstBuy: { amount: "99", slippageBps: 100 } }));
  assert.equal(firstBuyDraft(base).amount, "9");
});
test("corrupt and foreign payment assets cannot reinterpret an amount as the paired token", (t) => {
  const values = storage(t), rh = config(4663), paired = launchAssetsFor(rh)[0].address;
  for (const payAddress of ["not-an-address", firstBuyPaymentAssets(8453)[0].address]) {
    values.set(launchDraftKey(rh), JSON.stringify({ quoteAddress: paired,
      firstBuy: { amount: "10", slippageBps: 100, payAddress, lockDays: 365 } }));
    const draft = firstBuyDraft(rh);
    assert.equal(draft.payAddress.toLowerCase(), paired.toLowerCase());
    assert.equal(draft.amount, "0"); assert.equal(draft.lockDays, 0);
  }
  values.set(launchDraftKey(rh), "{invalid");
  assert.equal(firstBuyDraft(rh).amount, "0");
});

test("each deployment retains a nonempty new-launch pairing list", () => {
  for (const chain of [8453, 4663] as const) {
    const assets = launchAssetsFor(config(chain));
    assert.ok(assets.length > 0);
    assert.ok(assets.every((asset) => asset.chainId === chain));
    assert.equal(restoreDraft(null, config(chain)).quoteAddress, assets[0].address);
  }
});

test("new-launch lists match the active chain qualification evidence while retaining the older audit", () => {
  const audit = JSON.parse(readFileSync(new URL("../docs/evidence/lifi-opening-price/quotes.json", import.meta.url), "utf8")) as {
    opening: { chainId: number; address: string; initial: { status: string }; retry?: { status: string } }[];
  };
  for (const chain of [8453, 4663] as const) {
    const historicalPassed = audit.opening.filter((row) => row.chainId === chain &&
      (row.initial.status === "verified_snapshot" || row.retry?.status === "verified_snapshot"));
    assert.equal(historicalPassed.length, chain === 8453 ? 15 : 115, "the prior audit remains historical evidence");
    const baseEvidence = JSON.parse(readFileSync(new URL("../docs/evidence/base-jumper-qualification.json", import.meta.url), "utf8")) as {
      records: { address: string; status: string }[];
    };
    const passed = chain === 8453 ? baseEvidence.records.filter((row) => row.status === "quote_observed" &&
      STOCKS.some(asset => sameAddress(asset.address, row.address))) : historicalPassed;
    assert.equal(passed.length, chain === 8453 ? ADMITTED_BASE_ASSET_COUNT : 115);
    for (const fork of [false, true]) {
      const assets = launchAssetsFor(config(chain, fork));
      assert.deepEqual(assets.map((asset) => asset.address.toLowerCase()).sort(), passed.map((row) => row.address.toLowerCase()).sort());
      assert.equal(new Set(assets.map((asset) => asset.address)).size, assets.length);
    }
  }
  assert.equal(STOCKS.length, ADMITTED_BASE_ASSET_COUNT, "current Base identities follow the admitted list");
  assert.equal(ROBINHOOD_STOCKS.length, 198, "historical Robinhood identities remain available");
});

test("changing a restored pair preserves metadata and resets even a still-valid stable payment amount", (t) => {
  const values = storage(t), rh = config(4663), usd = firstBuyPaymentAssets(4663)[0];
  const saved = { name: "Old pair draft", symbol: "OLD", description: "Preserve this description", image: "https://example.com/token.webp",
    website: "https://example.com", twitter: "https://x.com/example", telegram: "https://t.me/example",
    quoteAddress: STOCKS[0].address, firstBuy: { amount: "123.45", slippageBps: 200, payAddress: usd.address, lockDays: 365 } };
  const paymentKey = "musegod.first-buy.payment.4663.4663.0x1111111111111111111111111111111111111111";
  values.set(paymentKey, JSON.stringify({ hash: "original-payment-hash", quote: "frozen-original-asset" }));
  values.set(launchDraftKey(rh), JSON.stringify(saved));
  const draft = restoreDraft(savedLaunchDraft(rh), rh);
  assert.deepEqual(draft, { name: saved.name, symbol: saved.symbol, description: saved.description, image: saved.image,
    website: saved.website, twitter: saved.twitter, telegram: saved.telegram, quoteAddress: launchAssetsFor(rh)[0].address, tradingFeeBps: DEFAULT_TRADING_FEE_BPS });
  assert.deepEqual(firstBuyDraft(rh), { amount: "0", slippageBps: 100, payAddress: draft.quoteAddress, lockDays: 0 });
  assert.equal(values.get(paymentKey), JSON.stringify({ hash: "original-payment-hash", quote: "frozen-original-asset" }),
    "draft migration cannot alter independently saved payment recovery");
});

test("excluded same-chain drafts reset first buys without deleting metadata or pending payment", (t) => {
  const values = storage(t);
  for (const [chain, symbol] of [[4663, "SATS"], [4663, "AAOI"]] as const) {
    const network = config(chain), registry = ROBINHOOD_STOCKS;
    const removed = registry.find((asset) => asset.symbol === symbol)!;
    const fallback = launchAssetsFor(network)[0];
    assert.ok(removed, "the historical identity remains in the full registry");
    assert.equal(stockByAddress(removed.address, chain), removed);
    assert.ok(!launchAssetsFor(network).some((asset) => sameAddress(asset.address, removed.address)), `${symbol} is excluded from new Create`);
    const payments = firstBuyPaymentAssets(chain, fallback.address).filter((asset) => ["ETH", "USDG", "USDC", "USDT"].includes(asset.symbol));
    assert.deepEqual(payments.map((asset) => asset.symbol).sort(), ["ETH", "USDG"]);
    const paymentKey = `musegod.first-buy.payment.${chain}.${chain}.0x1111111111111111111111111111111111111111`;
    for (const payment of payments) {
      const saved = { name: `Saved ${symbol}`, symbol: "SAVED", description: "Keep the original metadata", image: "https://example.com/token.webp",
        website: "https://example.com", twitter: "https://x.com/example", telegram: "https://t.me/example",
        quoteAddress: removed.address, firstBuy: { amount: "50.25", slippageBps: 200, payAddress: payment.address, lockDays: 90 } };
      const pending = JSON.stringify({ hash: `0x${"ab".repeat(32)}`, quote: { chainId: chain,
        fromToken: payment, toToken: { address: removed.address, symbol: removed.symbol, decimals: removed.decimals }, amountIn: "5025" }, actualOutput: null });
      values.set(paymentKey, pending);
      values.set(launchDraftKey(network), JSON.stringify(saved));
      const draft = restoreDraft(savedLaunchDraft(network), network);
      assert.deepEqual(draft, { name: saved.name, symbol: saved.symbol, description: saved.description, image: saved.image,
        website: saved.website, twitter: saved.twitter, telegram: saved.telegram, quoteAddress: fallback.address, tradingFeeBps: DEFAULT_TRADING_FEE_BPS }, payment.symbol);
      assert.deepEqual(firstBuyDraft(network), { amount: "0", slippageBps: 100, payAddress: fallback.address, lockDays: 0 },
        `${payment.symbol} remains a valid currency but its old amount cannot fund the fallback pair`);
      assert.equal(values.get(paymentKey), pending, `${payment.symbol} pending payment stays bound to the original ${symbol} output`);
    }
  }
});

test("newly qualified Base B20 drafts retain their intended first buy and pending-payment recovery", (t) => {
  const values = storage(t), network = config(8453), paired = STOCKS.find((stock) => stock.symbol === "ASTSc")!;
  const usdc = firstBuyPaymentAssets(8453, paired.address).find((asset) => asset.symbol === "USDC")!;
  const saved = { name: "Saved ASTS pair", symbol: "SAVED", description: "Retain qualified pair", image: "", quoteAddress: paired.address,
    firstBuy: { amount: "10", slippageBps: 100, payAddress: usdc.address, lockDays: 90 } };
  const paymentKey = "musegod.first-buy.payment.8453.8453.0x1111111111111111111111111111111111111111";
  values.set(paymentKey, "original pending payment"); values.set(launchDraftKey(network), JSON.stringify(saved));
  assert.equal(restoreDraft(savedLaunchDraft(network), network).quoteAddress, paired.address);
  assert.deepEqual(firstBuyDraft(network), saved.firstBuy);
  assert.equal(values.get(paymentKey), "original pending payment");
});

test("trading fee drafts persist every rate per network, default old or invalid fees and reset when cleared", (t) => {
  const values = storage(t);
  for (const chain of [8453, 4663] as const) {
    const network = config(chain), key = launchDraftKey(network);
    for (const tradingFeeBps of TRADING_FEE_BPS) {
      values.set(key, JSON.stringify({ name: "Saved fee", tradingFeeBps }));
      const restored = restoreDraft(savedLaunchDraft(network), network);
      assert.equal(restored.tradingFeeBps, tradingFeeBps);
      assert.equal(restored.name, "Saved fee");
    }
    for (const invalid of [undefined, 0, 99, 101, 301, 100.5, null, "300", true]) {
      values.set(key, JSON.stringify({ name: "Keep metadata", tradingFeeBps: invalid }));
      const restored = restoreDraft(savedLaunchDraft(network), network);
      assert.equal(restored.tradingFeeBps, DEFAULT_TRADING_FEE_BPS);
      assert.equal(restored.name, "Keep metadata");
    }
    values.delete(key);
    assert.equal(restoreDraft(savedLaunchDraft(network), network).tradingFeeBps, DEFAULT_TRADING_FEE_BPS);
    assert.equal(restoreDraft("{invalid", network).tradingFeeBps, DEFAULT_TRADING_FEE_BPS);
  }
});
test("the two-step launch form resumes only a saved second step and checks identity fields alone", () => {
  for (const raw of [null, "{invalid", "null", "{}", '{"step":1}', '{"step":"2"}', '{"step":3}'])
    assert.equal(launchDraftStep(raw), 1);
  assert.equal(launchDraftStep(JSON.stringify({ name: "Saved", step: 2 })), 2);
  const draft = { ...restoreDraft(null, config(4663)), name: "Cat", symbol: "CAT" };
  // An unsupported pair or fee is a step-two problem and must not block step one.
  assert.equal(launchIdentityIssue({ ...draft, quoteAddress: "0x0000000000000000000000000000000000000001", tradingFeeBps: 7 }), null);
  assert.deepEqual(launchIdentityIssue({ ...draft, name: " " }), { field: "name", message: "Enter a token name" });
  assert.equal(launchIdentityIssue({ ...draft, symbol: "1CAT" })?.field, "symbol");
  assert.equal(launchIdentityIssue({ ...draft, website: "http://example.com" })?.field, "website");
  assert.equal(launchIdentityIssue({ ...draft, image: "javascript:alert(1)" })?.field, "image");
  // Every schema field must belong to a step, or an invalid value would stay hidden on the other one.
  // nft and launchFee are not typed into a step: the NFT picker and the payment step attach them.
  assert.deepEqual([...LAUNCH_IDENTITY_FIELDS, "tradingFeeBps", "quoteAddress", "nft", "launchFee"].sort(), Object.keys(launchSchema.shape).sort());
});
test("a successful launch resets its scoped, shared and migrated anonymous copies only", () => {
  const network = config(4663), draft = { ...restoreDraft(null, network), name: "Launched A", symbol: "TOKENA" };
  const firstBuy = { amount: "0.001", slippageBps: 100, payAddress: draft.quoteAddress, lockDays: 30 };
  const launched = JSON.stringify({ ...draft, firstBuy, intentId: "wallet-intent-a", step: 2 });
  for (const copy of [launched, JSON.stringify({ ...draft, firstBuy, intentId: "anonymous-intent-a", step: 2 }),
    JSON.stringify({ ...draft, name: " Launched A ", symbol: "tokena", firstBuy: { ...firstBuy, payAddress: draft.quoteAddress.toLowerCase() }, intentId: "anonymous-intent-a", step: 2 })]) {
    const reopened = resetLaunchedDraftStep(copy, launched, network)!;
    assert.equal(launchDraftStep(reopened), 1);
    const { step: _beforeStep, ...before } = JSON.parse(copy), { step: _afterStep, ...after } = JSON.parse(reopened);
    assert.deepEqual(after, before, "reset preserves all saved identity and first-buy fields");
  }
  for (const independent of [
    { ...draft, name: "Unlaunched B", symbol: "TOKENB", firstBuy },
    { ...draft, firstBuy: { ...firstBuy, amount: "0.002" } },
    { ...draft, firstBuy: { ...firstBuy, lockDays: 90 } },
    { ...draft, tradingFeeBps: 300, firstBuy },
  ]) {
    const saved = JSON.stringify({ ...independent, intentId: "independent-intent-b", step: 2 });
    assert.equal(resetLaunchedDraftStep(saved, launched, network), saved, "an independent draft stays byte-for-byte unchanged");
    assert.equal(launchDraftStep(saved), 2);
  }
  for (const raw of [null, "{invalid", "null", "[]"])
    assert.equal(resetLaunchedDraftStep(raw, launched, network), raw);
});
test("an autosave never replaces another tab's named draft with a blank draft this tab did not load", () => {
  const network = config(4663, true), blank = restoreDraft(null, network), firstBuy = firstBuyDraft(network, null);
  const save = (fields: object, step = 1) => JSON.stringify({ ...blank, ...fields, firstBuy, intentId: "shared-intent", step, nftMode: false });
  const empty = save({}), named = save({ name: "Named draft", symbol: "NAMED" }), renamed = save({ name: "Renamed draft", symbol: "NAMED" });
  // What this tab last synced: a draft it wrote or loaded (and its form has not changed since), or one it only read (its form was kept).
  const synced = (raw: string): DraftBasis => ({ raw, payload: raw }), read = (raw: string | null): DraftBasis => ({ raw });
  // Blank means the create form's own "untouched" rule: blank identity on step one, no NFT and no paid fee.
  assert.equal(isBlankDraft(empty, network), true);
  assert.equal(isBlankDraft(save({ name: "  " }), network), true, "whitespace is still blank");
  for (const raw of [null, "{invalid", "null"]) assert.equal(isBlankDraft(raw, network), true, String(raw));
  assert.equal(isBlankDraft(named, network), false);
  assert.equal(isBlankDraft(save({}, 2), network), false, "a draft on step two is not blank");
  assert.equal(isBlankDraft(save({ nft: { chainId: 4663, contract: "0x13Ea3072b7215d4C9c2Ec4f498A08c5825129836", tokenId: "1" } }), network), false);
  assert.equal(isBlankDraft(save({ launchFee: { asset: "stable", txHash: `0x${"11".repeat(32)}` } }), network), false, "a paid fee is kept");
  // Nothing (or nothing but a blank draft) is stored: a draft this tab changed, or one it never read, is written.
  for (const stored of [null, empty, save({ name: " " }), "{invalid"])
    for (const payload of [empty, named])
      for (const basis of [undefined, read(null), synced(save({ symbol: "OLD" }))])
        assert.equal(draftAutosave(stored, payload, basis, network), "write", JSON.stringify({ stored, payload, basis }));
  // A second tab that loaded nothing, or a blank draft, before the first tab's named draft landed adopts the named draft and writes nothing.
  for (const basis of [undefined, read(null), read(empty), synced(empty), read(save({ description: " " }))])
    assert.equal(draftAutosave(named, empty, basis, network), "adopt", JSON.stringify(basis));
  assert.equal(draftAutosave(save({}, 2), empty, read(null), network), "adopt", "a stored second step is a draft too");
  // This tab read or wrote the named draft itself, and its creator cleared it here: the clearing is written.
  assert.equal(draftAutosave(named, empty, synced(named), network), "write");
  assert.equal(draftAutosave(named, empty, read(named), network), "write", '"Clear draft" keeps what is stored as read, not as loaded');
  // ...but a named draft another tab wrote since then is adopted, not cleared.
  assert.equal(draftAutosave(renamed, empty, synced(named), network), "adopt");
  // Two tabs with non-blank drafts of the same intent: a tab with real local edits writes, and the last writer wins.
  for (const basis of [undefined, read(null), synced(empty), synced(named)])
    assert.equal(draftAutosave(named, renamed, basis, network), "write", JSON.stringify(basis));
  assert.equal(draftAutosave(named, named, undefined, network), "write", "an identical draft is rewritten harmlessly");
});
test("an autosave holds NFT input and an open review, keeps an unedited tab in sync and never echoes a loaded draft", () => {
  const network = config(4663, true), blank = restoreDraft(null, network), firstBuy = firstBuyDraft(network, null);
  const save = (fields: object, extra: object = {}) => JSON.stringify({ ...blank, ...fields, firstBuy, intentId: "shared-intent", step: 1, nftMode: false, ...extra });
  const empty = save({}), named = save({ name: "Named draft", symbol: "NAMED" }), renamed = save({ name: "Renamed draft", symbol: "NAMED" });
  const edited = save({ name: "Named draft", symbol: "EDIT" });
  const synced = (raw: string, payload = raw): DraftBasis => ({ raw, payload }), read = (raw: string | null): DraftBasis => ({ raw });
  // NFT mode with no NFT yet: the NFT step may hold typed, unconfirmed input. NFT mode alone is not a draft (it never overwrites a named one).
  const nftTyping = save({}, { nftMode: true }), nftNamed = save({ name: "NFT draft" }, { nftMode: true });
  const nftChosen = save({ nft: { chainId: 4663, contract: "0x13Ea3072b7215d4C9c2Ec4f498A08c5825129836", tokenId: "1" } }, { nftMode: true });
  assert.equal(isBlankDraft(nftTyping, network), true);
  assert.equal(draftAutosave(named, nftTyping, read(null), network), "hold", "neither writes the blank draft nor drops the NFT input");
  assert.equal(draftAutosave(named, nftTyping, undefined, network), "hold");
  assert.equal(draftAutosave(renamed, nftNamed, synced(nftNamed), network), "hold", "an unedited tab in NFT mode keeps its input too");
  assert.equal(draftAutosave(null, nftTyping, undefined, network), "write", "its own draft still saves");
  assert.equal(draftAutosave(empty, nftTyping, read(empty), network), "write");
  assert.equal(draftAutosave(named, nftChosen, read(null), network), "write", "a chosen NFT is a draft: the last writer wins");
  // A review, payment or submission in progress holds the form instead of adopting under it; nothing else changes.
  assert.equal(draftAutosave(named, empty, read(null), network, true), "hold");
  assert.equal(draftAutosave(renamed, named, synced(named), network, true), "hold");
  assert.equal(draftAutosave(null, empty, undefined, network, true), "write");
  assert.equal(draftAutosave(named, renamed, read(null), network, true), "write");
  // No local edits since this tab last synced: it follows another tab's newer draft, including a cleared one, so a stale tab can never
  // undo another tab's "Clear draft".
  assert.equal(draftAutosave(renamed, named, synced(named), network), "adopt");
  assert.equal(draftAutosave(empty, named, synced(named), network), "adopt");
  // Real local edits: the last writer wins, over another tab's edit or clear.
  assert.equal(draftAutosave(renamed, edited, synced(named), network), "write");
  assert.equal(draftAutosave(empty, edited, synced(named), network), "write");
  // Nothing new: a tab writes nothing back, whether it wrote the draft or loaded it (its form may serialize the stored draft differently).
  assert.equal(draftAutosave(named, named, synced(named), network), "unchanged");
  const loaded = JSON.stringify({ ...JSON.parse(named), firstBuy: { ...firstBuy, amount: "" } });
  assert.equal(draftAutosave(loaded, named, synced(loaded, named), network), "unchanged");
  assert.equal(draftAutosave(loaded, edited, synced(loaded, named), network), "write");
});
