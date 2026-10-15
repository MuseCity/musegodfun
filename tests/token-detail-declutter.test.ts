import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ROBINHOOD_STOCKS, STOCKS } from "../src/lib/config";
import { buyPresets, ownershipDisclaimer, stockStatusFailure, tokenFeeCardTier } from "../src/lib/token-detail";
import TokenTradeNotes from "../src/components/TokenTradeNotes";
import { TokenFeeDisclosure } from "../src/components/FeeBreakdown";
import { NetworkProvider } from "../src/lib/network";
import { syntheticToken } from "./fixtures";

const asset = (symbol: string) => ROBINHOOD_STOCKS.find(a => a.symbol === symbol)!;

test("D1 crypto pairs have vetted units and no stock ownership or multiplier claims", () => {
  for (const [symbol, values] of [
    ["WETH", ["0.001", "0.005", "0.01"]], ["cbBTC", ["0.0001", "0.0005", "0.001"]],
    ["USDG", ["10", "50", "100"]], ["MUSEGOD", []],
  ] as const) {
    assert.deepEqual(buyPresets(asset(symbol), false), values);
    assert.deepEqual(buyPresets(asset(symbol), true), ["0.001", "0.005", "0.01"]);
    assert.equal(ownershipDisclaimer("COIN", asset(symbol)), "");
    assert.doesNotMatch(stockStatusFailure(asset(symbol)), /stock|multiplier|share equivalent/i);
  }
  assert.deepEqual(buyPresets({ ...asset("WETH"), symbol: "UNKNOWN" }, false), []);
});

test("D1 legacy stocks, penny stocks and ETFs retain their appropriate disclosure", () => {
  for (const stock of [STOCKS[0], ...["STOCK", "PENNY_STOCK", "ETF"].map(category => ({ ...asset("WETH"), category }))]) {
    assert.deepEqual(buyPresets(stock, false), ["1", "5", "10"]);
    assert.equal(ownershipDisclaimer("COIN", stock), `COIN does not represent ownership of ${stock.name}${stock.category === "ETF" ? "" : " stock"}.`);
    assert.match(stockStatusFailure(stock), /stock multiplier.*share equivalent/);
  }
});

test("D2 default trade notes contain only the short state and move guidance into a closed disclosure", () => {
  for (const stock of [asset("WETH"), { ...asset("WETH"), category: "ETF" }, STOCKS[0]]) {
    for (const url of [undefined, "https://doppler.lol/token/verified"]) {
      const html = renderToStaticMarkup(createElement(TokenTradeNotes, { stock, symbol: "COIN", payingEth: false, writesEnabled: false, doppler: url }));
      const outside = html.replace(/<details[\s\S]*?<\/details>/g, "");
      assert.match(outside, /Transactions are disabled; quotes are previews/);
      assert.doesNotMatch(outside, /approval|5 minutes|slippage|pending|Get a quote here/);
      assert.match(html, /<details[^>]*><summary>Trading details<\/summary>/);
      assert.match(html, /approval.*5 minutes/);
      if (url) assert.match(outside, /Trade on Doppler/);
      else { assert.doesNotMatch(html, /verified Doppler link|Trade on Doppler/); assert.match(html, /Doppler trading is pending/); }
      if (stock.category === "OTHERS") assert.doesNotMatch(html, /stock token|ownership/);
      else { assert.match(html, /transfer rules/); assert.match(outside, /ownership/); }
    }
  }
  const html = renderToStaticMarkup(createElement(TokenTradeNotes, { stock: asset("WETH"), symbol: "COIN", payingEth: true, writesEnabled: true, fork: true }));
  assert.match(html, /LI.FI.*fee is included/); assert.doesNotMatch(html, /Doppler|Transactions are disabled/);
});

test("D3 every connected beneficiary can reach fee checks, including catalog mismatches", () => {
  const token = syntheticToken({ feeTreasury: "0x3333333333333333333333333333333333333333" }), other = "0x9999999999999999999999999999999999999999";
  assert.equal(tokenFeeCardTier(token, null), null);
  assert.equal(tokenFeeCardTier(token, token.creator), "token");
  assert.equal(tokenFeeCardTier(token, token.feeTreasury?.toUpperCase()), "token");
  assert.equal(tokenFeeCardTier(token, other), "compact");
  const nft = { ...token, nft: { chainId: 4663 as const, contract: token.address, tokenId: "1" } };
  assert.equal(tokenFeeCardTier(nft, null), "token");
  assert.equal(tokenFeeCardTier(nft, other), "token");
  assert.equal(tokenFeeCardTier(nft, token.feeTreasury), "token");
});

test("D6 the fee split is inside the collapsed token disclosure, retaining its policy link", () => {
  const html = renderToStaticMarkup(createElement(TokenFeeDisclosure, { token: syntheticToken({ tradingFeeBps: 100, feePolicy: "creator-70-musegod-v2" }), children: createElement("a", { href: "/buyback" }, "View the buyback policy and status") }));
  assert.match(html, /^<details class="disclosure boxed"><summary>How fees are distributed<\/summary><div class="fee-split"/);
  assert.match(html, /href="\/buyback"/);
  assert.doesNotMatch(html, /How the buyback works|about-facts/);
});

test("D3 compact fee UI keeps both claims and allocation but omits catalog identity and policy; rewards retain them", async () => {
  const { registerHooks } = await import("node:module"), { pathToFileURL } = await import("node:url");
  const entry = pathToFileURL(`${process.cwd()}/src/App.tsx`); entry.search = `fees=${crypto.randomUUID()}`;
  const key = `__feeWallet${crypto.randomUUID().replaceAll("-", "")}`;
  const token = syntheticToken({ feeTreasury: "0x3333333333333333333333333333333333333333", feePolicy: "creator-70-musegod-swapper-v3", tradingFeeBps: 100 });
  const account = "0x9999999999999999999999999999999999999999";
  const data = { poolKey: { currency0: token.address, currency1: token.quoteAddress }, trade: { fees0: "1000000000000000000", fees1: "2" }, lp: { fees0: "3000000000000000000", fees1: "4" } };
  let state = 0;
  const mock = { useWallet: () => ({ account, chainId: 8453, revision: 0 }), useState(initial: unknown) { return [state++ === 0 ? data : initial, () => {}]; } };
  Reflect.set(globalThis, key, mock);
  Reflect.set(globalThis, "__BUILD_IDENTITY__", { source: "local", commit: "fixture", dirty: true });
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL !== entry.href) return next(specifier, context);
    if (specifier === "./lib/wallet") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve("../src/lib/wallet"))};export const {useWallet}=globalThis[${JSON.stringify(key)}];`)}` };
    if (specifier === "react") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve("react"))};export const {useState}=globalThis[${JSON.stringify(key)}];`)}` };
    return next(specifier, context);
  } });
  try {
    const { FeeCard } = await import(entry.href);
    const config = { mode: "base" as const, chainId: 8453, deploymentChainId: 8453 as const, treasury: null, writesEnabled: false, blockReason: null };
    const compact = renderToStaticMarkup(createElement(NetworkProvider, { children: createElement(FeeCard, { token, config, variant: "compact" }) }));
    for (const label of ["Beneficiary fees", "on-chain fee beneficiaries", "Check fees", "Claim trading fee", "Claim LP fee", "Allocation reference after claiming"]) assert(compact.includes(label), label);
    assert.doesNotMatch(compact, /fee-identity|Synthetic Meme| pair|no second 80\/20 split|Manage in My rewards/);
    state = 0;
    const rewards = renderToStaticMarkup(createElement(NetworkProvider, { children: createElement(FeeCard, { token, config }) }));
    assert.match(rewards, /fee-identity/); assert.match(rewards, /Synthetic Meme/); assert.match(rewards, / pair/); assert.match(rewards, /no second 80\/20 split/);
  } finally { hooks.deregister(); Reflect.deleteProperty(globalThis, key); Reflect.deleteProperty(globalThis, "__BUILD_IDENTITY__"); }
});
