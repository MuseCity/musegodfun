import test from "node:test";
import assert from "node:assert/strict";
import { STOCKS, ROBINHOOD_STOCKS, launchAssetsFor, stockByAddress, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { firstBuyDraft, launchDraftKey, savedLaunchDraft } from "../src/lib/launch-draft";
import { firstBuyPaymentAssets } from "../src/lib/first-buy-payment";
import { restoreDraft } from "../src/lib/validation";
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
    website: saved.website, twitter: saved.twitter, telegram: saved.telegram, quoteAddress: launchAssetsFor(rh)[0].address });
  assert.deepEqual(firstBuyDraft(rh), { amount: "0", slippageBps: 100, payAddress: draft.quoteAddress, lockDays: 0 });
  assert.equal(values.get(paymentKey), JSON.stringify({ hash: "original-payment-hash", quote: "frozen-original-asset" }),
    "draft migration cannot alter independently saved payment recovery");
});

test("a removed same-chain SATS draft resets ETH and USDG first buys without deleting metadata or pending payment", (t) => {
  const values = storage(t), rh = config(4663);
  const removed = ROBINHOOD_STOCKS.find((asset) => asset.ticker === "SATS")!;
  const fallback = launchAssetsFor(rh)[0];
  assert.ok(removed, "the historical SATS identity remains in the full registry");
  assert.equal(stockByAddress(removed.address, 4663), removed);
  assert.ok(!launchAssetsFor(rh).some((asset) => sameAddress(asset.address, removed.address)), "SATS is excluded from new Create");
  const payments = firstBuyPaymentAssets(4663, fallback.address).filter((asset) => ["ETH", "USDG"].includes(asset.symbol));
  assert.deepEqual(payments.map((asset) => asset.symbol).sort(), ["ETH", "USDG"]);
  const paymentKey = "musegod.first-buy.payment.4663.4663.0x1111111111111111111111111111111111111111";
  for (const payment of payments) {
    const saved = { name: "Saved SATS", symbol: "SAVED", description: "Keep the original SATS metadata", image: "https://example.com/sats.webp",
      website: "https://example.com", twitter: "https://x.com/example", telegram: "https://t.me/example",
      quoteAddress: removed.address, firstBuy: { amount: "50.25", slippageBps: 200, payAddress: payment.address, lockDays: 90 } };
    const pending = JSON.stringify({ hash: `0x${"ab".repeat(32)}`, quote: { chainId: 4663,
      fromToken: payment, toToken: { address: removed.address, symbol: removed.symbol, decimals: removed.decimals }, amountIn: "5025" }, actualOutput: null });
    values.set(paymentKey, pending);
    values.set(launchDraftKey(rh), JSON.stringify(saved));
    const draft = restoreDraft(savedLaunchDraft(rh), rh);
    assert.deepEqual(draft, { name: saved.name, symbol: saved.symbol, description: saved.description, image: saved.image,
      website: saved.website, twitter: saved.twitter, telegram: saved.telegram, quoteAddress: fallback.address }, payment.symbol);
    assert.deepEqual(firstBuyDraft(rh), { amount: "0", slippageBps: 100, payAddress: fallback.address, lockDays: 0 },
      `${payment.symbol} remains a valid currency but its old amount cannot fund the fallback pair`);
    assert.equal(values.get(paymentKey), pending, `${payment.symbol} pending payment stays bound to the original SATS output`);
  }
});
