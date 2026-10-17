import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ROBINHOOD_STOCKS, STOCKS } from "../src/lib/config";
import { ownershipDisclaimer, stockStatusFailure, tokenFeeCardTier } from "../src/lib/token-detail";
import { TokenFeeDisclosure } from "../src/components/FeeBreakdown";
import { NetworkProvider } from "../src/lib/network";
import { syntheticToken } from "./fixtures";

const asset = (symbol: string) => ROBINHOOD_STOCKS.find(a => a.symbol === symbol)!;

test("D1 crypto pairs make no stock ownership or multiplier claims", () => {
  for (const symbol of ["WETH", "cbBTC", "USDG", "MUSEGOD"]) {
    assert.equal(ownershipDisclaimer("COIN", asset(symbol)), "");
    assert.doesNotMatch(stockStatusFailure(asset(symbol)), /stock|multiplier|share equivalent/i);
  }
});

test("D1 legacy stocks, penny stocks and ETFs retain their appropriate disclosure", () => {
  for (const stock of [STOCKS[0], ...["STOCK", "PENNY_STOCK", "ETF"].map(category => ({ ...asset("WETH"), category }))]) {
    assert.equal(ownershipDisclaimer("COIN", stock), `COIN does not represent ownership of ${stock.name}${stock.category === "ETF" ? "" : " stock"}.`);
    assert.match(stockStatusFailure(stock), /stock multiplier.*share equivalent/);
  }
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
});

test("C1-5 the On-chain contract card lists the launch record, links mainnet addresses only, and keeps the fee split collapsed", async () => {
  const { default: TokenContract } = await import("../src/components/TokenContract");
  for (const mode of ["base", "fork"] as const) {
    const token = syntheticToken({ mode, tradingFeeBps: 100, feePolicy: "creator-70-musegod-v2", openingValuationUnverified: true,
      feeTreasury: "0x3333333333333333333333333333333333333333" });
    const html = renderToStaticMarkup(createElement(TokenContract, { token, stock: STOCKS[0], children: createElement(TokenFeeDisclosure, { token, children: createElement("a", { href: "/buyback" }, "View the buyback policy and status") }) }));
    assert.match(html, /Contract and launch record/);
    assert.match(html, /Token contract.*Quote asset.*Creator.*Operations · 5.7%.*Pool ID.*Supply.*1,000,000,000.*Opening valuation.*Unverified.*Created/);
    assert(html.includes(token.poolId));
    assert.equal((html.match(/href="\/buyback"/g) ?? []).length, 1);
    const outsideDetails = html.replace(/<details[\s\S]*<\/details>/g, "");
    assert.doesNotMatch(outsideDetails, /fee-split/);
    if (mode === "base") assert.match(html, /https:\/\/basescan.org\/token\//);
    else assert.doesNotMatch(html, /https:/);
  }
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
