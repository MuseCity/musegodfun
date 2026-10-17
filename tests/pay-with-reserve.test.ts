import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { syntheticToken } from "./fixtures";
import { ROBINHOOD_STOCKS, STOCKS, type RuntimeConfig } from "../src/lib/config";
import { ethBuyAvailable } from "../src/lib/eth-buy";

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
  const find = (match: (n: any) => boolean) => all(runtime.output(), match)[0];
  const byClass = (name: string) => find(n => n.props?.className === name);
  const button = (text: string) => find(n => n.type === "button" && n.props.children === text);
  runtime.render(); await settle();
  return { byClass, button, token, stock, input: () => input, reads: () => ({ nativeReads, feeReads }),
    async load(overrides: Partial<RuntimeConfig> = {}) { config = { mode: token.mode, chainId: fork ? 31337 : chain, deploymentChainId: chain, writesEnabled: true, blockReason: null, treasury: null, ...overrides }; runtime.render(); await settle(); },
    async verify() { status = [{ address: stock.address, verified: true }]; runtime.render(); await settle(); },
    async disconnect() { wallet.account = null; runtime.render(); await settle(); },
    async click(text: string) { button(text).props.onClick(); await settle(); },
    async type(value: string) { find(n => n.type === "input" && n.props["aria-label"] === "Trade input amount").props.onChange({ target: { value } }); await settle(); },
  };
}

for (const fork of [false, true]) test(`Robinhood ${fork ? "fork" : "mainnet"}: pay row is reserved, busy and disabled until config`, async t => {
  const p = await panel(t, { fork, connected: true });
  assert(p.byClass("pay-with"), "the row exists on the first token render");
  assert.equal(p.byClass("pay-with").props["aria-busy"], true);
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
  assert.equal(badge.props["aria-hidden"], true); await p.verify();
  assert.equal(p.byClass("chip sm up quote-verification").props["aria-hidden"], false);
});
test("a typed pair amount keeps its unit when the wallet default changes", async t => {
  const p = await panel(t, { connected: true, balance: 0n });
  await p.type("2"); await p.load();
  assert.equal(p.button("ETH").props["aria-pressed"], true, "the existing config-ready default is retained");
  await p.click("COST"); await p.type("2"); await p.disconnect();
  assert.equal(p.button("COST").props["aria-pressed"], true);
  assert.equal(p.input().valid, true);
});
test("the projection uses the same deployment-chain availability for all supported modes", () => {
  for (const [config, expected] of [
    [{ mode: "robinhood" }, true], [{ mode: "robinhood", deploymentChainId: 4663 }, true],
    [{ mode: "base" }, false], [{ mode: "base", deploymentChainId: 8453 }, false],
    [{ mode: "fork" }, false], [{ mode: "fork", deploymentChainId: 4663 }, true], [{ mode: "fork", deploymentChainId: 8453 }, false],
  ] as const) assert.equal(ethBuyAvailable(config), expected);
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
