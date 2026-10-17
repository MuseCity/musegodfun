import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { syntheticToken } from "./fixtures";
import { ROBINHOOD_STOCKS, STOCKS, type RuntimeConfig } from "../src/lib/config";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

const src = (path: string) => new URL(`../src/${path}`, import.meta.url).href;
type Options = { chain?: 4663 | 8453; fork?: boolean; pair?: string; connected?: boolean; balance?: bigint; listed?: boolean };
async function panel(t: TestContext, { chain = 4663, fork = false, pair = "COST", connected = false, balance = 1n, listed = true }: Options = {}) {
  const stock = (chain === 4663 ? ROBINHOOD_STOCKS : STOCKS).find(s => chain === 8453 || s.symbol === pair)!;
  const token = syntheticToken({ mode: fork ? "fork" : chain === 4663 ? "robinhood" : "base", deploymentChainId: chain, quoteAddress: stock.address });
  const detail = listed ? { token, state: { poolKey: {} } } : null;
  let config: RuntimeConfig | null = null, status: unknown[] = [], nativeReads = 0, feeReads = 0;
  const wallet = { account: connected ? token.address : null, chainId: chain, revision: 0, balance: async () => balance,
    balanceNative: async () => { nativeReads++; return 10n; } };
  let input: any;
  const runtime = hookRuntime(() => TokenPage({ address: token.address, config }));
  const prior = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://fixture", pathname: "/", search: "" } });
  Reflect.set(globalThis, "__BUILD_IDENTITY__", { source: "local", commit: "fixture", dirty: true });
  const { TokenPage } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "./lib/resource": { file: src("lib/resource.ts"), bindings: { useResource: (path: string) => ({ loading: false, error: "", data: path === "/stocks" ? status : detail }) } },
    "./lib/wallet": { file: src("lib/wallet.tsx"), bindings: { useWallet: () => wallet, transactionClient: () => { feeReads++; throw new Error("Unexpected fee read"); } } },
    "./lib/use-eth-buy-record": { file: src("lib/use-eth-buy-record.ts"), bindings: { useEthBuyRecord: () => ({ record: null }) } },
    "./lib/use-auto-quote": { file: src("lib/use-auto-quote.ts"), bindings: { useAutoQuote: (value: unknown) => { input = value; return { pending: false, manual: false }; } } },
  }, ["TokenPage"]);
  t.after(() => { runtime.unmount(); if (prior) Object.defineProperty(globalThis, "location", prior); else Reflect.deleteProperty(globalThis, "location"); });
  const all = (node: any, match: (n: any) => boolean): any[] => !node || typeof node !== "object" ? [] : [
    ...(!Array.isArray(node) && match(node) ? [node] : []), ...(Array.isArray(node) ? node : [node.props?.children]).flatMap(child => all(child, match)),
  ];
  const text = (node: any): string => node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : (Array.isArray(node) ? node : [node.props?.children]).map(text).join("");
  const find = (match: (n: any) => boolean) => all(runtime.output(), match)[0];
  const byClass = (name: string) => find(n => n.props?.className === name);
  const button = (text: string) => find(n => n.type === "button" && n.props.children === text);
  runtime.render(); await settle();
  return { byClass, button, text: () => text(runtime.output()), token, stock, input: () => input, reads: () => ({ nativeReads, feeReads }),
    async load(overrides: Partial<RuntimeConfig> = {}) { config = { mode: token.mode, chainId: fork ? 31337 : chain, deploymentChainId: chain, writesEnabled: true, blockReason: null, treasury: null, ...overrides }; runtime.render(); await settle(); },
    async verify() { status = [{ address: stock.address, verified: true, multiplierWad: "1000000000000000000" }]; runtime.render(); await settle(); },
    async disconnect() { wallet.account = null; runtime.render(); await settle(); },
    async click(text: string) { button(text).props.onClick(); await settle(); },
    async type(value: string) { find(n => n.type === "input" && n.props["aria-label"] === "Trade input amount").props.onChange({ target: { value } }); await settle(); },
  };
}

for (const fork of [false, true]) test(`Robinhood ${fork ? "fork" : "mainnet"}: pay row is reserved, busy and disabled until config`, async t => {
  const p = await panel(t, { fork, connected: true });
  assert(p.byClass("pay-with"), "the row exists on the first token render");
  assert.equal(p.byClass("pay-with").props["aria-busy"], true);
  assert.equal(p.button("ETH").props["aria-pressed"], false); assert.equal(p.button("COST").props["aria-pressed"], false);
  assert.equal(p.button("ETH").props.disabled, true); assert.equal(p.button("COST").props.disabled, true);
  await p.type("1");
  assert.equal(p.input().pool, false, "config still gates quote scheduling");
  assert.deepEqual(p.reads(), { nativeReads: 0, feeReads: 0 });
  await p.load();
  assert.equal(p.byClass("pay-with").props["aria-busy"], false);
  assert.equal(p.button("ETH").props.disabled, false); assert.equal(p.button("COST").props.disabled, false);
  assert.equal(p.input().pool, true); assert.equal(p.input().lifi, false);
  assert.deepEqual(p.reads(), { nativeReads: 1, feeReads: 0 });
  await p.click("Sell"); assert.equal(p.byClass("pay-with"), undefined);
});

test("Base and Base forks never reserve an ETH payment row", async t => {
  for (const fork of [false, true]) {
    const p = await panel(t, { chain: 8453, fork });
    assert.equal(p.byClass("pay-with"), undefined); await p.load(); assert.equal(p.byClass("pay-with"), undefined);
  }
});
test("without a loaded token and pair, no provisional ETH row is offered", async t => {
  const p = await panel(t, { listed: false }); assert.equal(p.byClass("pay-with"), undefined);
  await p.load(); assert.equal(p.byClass("pay-with"), undefined);
});
test("a contradictory config hides the provisional Robinhood row", async t => {
  const p = await panel(t); assert(p.byClass("pay-with"));
  await p.load({ mode: "base", chainId: 8453, deploymentChainId: 8453 }); assert.equal(p.byClass("pay-with"), undefined);
});
for (const [pair, connected, balance, expected] of [
  ["WETH", false, 0n, "eth"], ["WETH", true, 1n, "eth"], ["COST", false, 0n, "pair"], ["COST", true, 0n, "eth"], ["COST", true, 1n, "pair"],
] as const) test(`${pair}, connected=${connected}, balance=${balance}: settled defaults and explicit choices are preserved`, async t => {
  const p = await panel(t, { pair, connected, balance }); await p.load();
  assert.equal(p.button(expected === "eth" ? "ETH" : pair).props["aria-pressed"], true);
  await p.type("2"); await p.click(expected === "eth" ? pair : "ETH");
  assert.equal(p.button(expected === "eth" ? pair : "ETH").props["aria-pressed"], true);
  assert.equal(p.input().valid, false, "a unit change clears the typed amount");
});
test("the stock verification badge reserves its space before stock status resolves", async t => {
  const p = await panel(t);
  const badge = p.byClass("chip sm up quote-verification"); assert(badge);
  assert.equal(badge.props["aria-hidden"], true); assert.equal(badge.props.children, undefined);
  assert.doesNotMatch(p.text(), /Verified quote asset/); await p.verify();
  assert.match(p.text(), /Verified quote asset/);
  assert.equal(p.byClass("chip sm up quote-verification").props["aria-hidden"], false);
});
for (const [pair, connected, balance] of [["WETH", false, 0n], ["WETH", true, 0n], ["COST", true, 0n]] as const) test(`${pair}, connected=${connected}: typing before config freezes the displayed pair unit`, async t => {
  const p = await panel(t, { pair, connected, balance });
  assert.equal(p.button(pair).props["aria-pressed"], false);
  await p.type("2"); assert.equal(p.input().pool, false);
  await p.load(); assert.equal(p.button(pair).props["aria-pressed"], true);
  assert.equal(p.input().valid, true); assert.equal(p.input().lifi, false);
  await p.disconnect(); assert.equal(p.button(pair).props["aria-pressed"], true);
  await p.type("");
  assert.equal(p.button(pair === "WETH" ? "ETH" : pair).props["aria-pressed"], true, "empty input resumes the existing guest default");
});
for (const tokenChain of [4663, 8453] as const) for (const configChain of [4663, 8453] as const) for (const fork of [false, true]) test(`post-config row uses config availability: token=${tokenChain}, config=${configChain}, fork=${fork}`, async t => {
  const p = await panel(t, { chain: tokenChain, fork });
  await p.load({ mode: fork ? "fork" : configChain === 4663 ? "robinhood" : "base", chainId: fork ? 31337 : configChain, deploymentChainId: configChain });
  assert.equal(!!p.byClass("pay-with"), configChain === 4663);
  await p.click("Sell"); assert.equal(p.byClass("pay-with"), undefined);
});
test("the rendered 16px share line exposes the exact full value and ellipsizes its block container", async t => {
  const p = await panel(t, { connected: true, balance: 123456789012345678901234567890123456789n });
  await p.load(); await p.verify();
  const slot = p.byClass("trade-share-slot"); assert.equal(slot.props["aria-hidden"], false);
  const html = renderToStaticMarkup(slot);
  assert.match(html, /class="share-equivalent" title="Approximately 123456789012345678901\.234567890123456789 COST shares"/);
  const css = readFileSync("src/styles.css", "utf8");
  const rule = css.match(/\.trade-share-slot\s*\{([^}]+)\}/)?.[1] ?? "";
  for (const property of [/white-space:\s*nowrap/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/]) assert.match(rule, property);
  assert.doesNotMatch(rule, /overflow-x:\s*auto/);
});
test("a Base share-equivalent line has a slot before the wallet balance arrives", async t => {
  const p = await panel(t, { chain: 8453 });
  assert(p.byClass("trade-share-slot")); assert.equal(p.byClass("trade-share-slot").props["aria-hidden"], true);
});
test("a Robinhood stock reserves its share line before multiplier, wallet and payment defaults resolve", async t => {
  const p = await panel(t, { connected: true, balance: 0n });
  assert(p.byClass("trade-share-slot"));
  await p.load(); assert.equal(p.button("ETH").props["aria-pressed"], true);
  assert(p.byClass("trade-share-slot")); assert.equal(p.byClass("trade-share-slot").props["aria-hidden"], true);
  const weth = await panel(t, { pair: "WETH" }); assert.equal(weth.byClass("trade-share-slot"), undefined);
});
