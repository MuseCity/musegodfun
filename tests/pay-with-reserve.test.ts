import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { syntheticToken } from "./fixtures";
import { ROBINHOOD_STOCKS, STOCKS, type RuntimeConfig } from "../src/lib/config";
import { buyPresets } from "../src/lib/token-detail";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

const src = (path: string) => new URL(`../src/${path}`, import.meta.url).href;
type Options = { chain?: 4663 | 8453; fork?: boolean; pair?: string; connected?: boolean; balance?: bigint | Promise<bigint>; listed?: boolean };
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

test("an unknown pair balance reserves the share slot without inventing a zero-share claim", async t => {
  const never = new Promise<bigint>(() => {});
  for (const [name, options] of [["guest", { connected: false }], ["pending balance", { connected: true, balance: never }]] as const) {
    const p = await panel(t, options); await p.load(); await p.verify();
    const slot = p.byClass("trade-share-slot"); assert(slot, name);
    assert.equal(slot.props["aria-hidden"], true, name);
    assert.equal(renderToStaticMarkup(slot), '<span class="trade-share-slot" aria-hidden="true"></span>', `${name}: no hidden share text or title`);
  }
});
test("paying with ETH keeps the share slot empty even when the pair balance is known", async t => {
  const p = await panel(t, { connected: true, balance: 5n }); await p.load(); await p.verify();
  assert.match(renderToStaticMarkup(p.byClass("trade-share-slot")), /Approximately/, "a real pair balance renders its share line");
  await p.click("ETH");
  assert.equal(renderToStaticMarkup(p.byClass("trade-share-slot")), '<span class="trade-share-slot" aria-hidden="true"></span>');
});

const comment = /\/\*[\s\S]*?\*\//g, markup = (node: unknown) => renderToStaticMarkup(node as any).replaceAll("<!-- -->", "");
test("a long pair balance arriving later stays inside the amount header: label intact, exact value in the title", async t => {
  let release!: (value: bigint) => void;
  const p = await panel(t, { connected: true, balance: new Promise<bigint>(resolve => { release = resolve; }) });
  await p.load(); await p.verify(); await p.click("COST");
  assert.equal(markup(p.byClass("trade-box-head")),
    '<span class="trade-box-head"><span>You pay <b>COST</b></span><span class="balance">Balance: <b>—</b></span></span>');
  release(123456789012345678901234567890123456789n); await settle();
  assert.equal(markup(p.byClass("trade-box-head")),
    '<span class="trade-box-head"><span>You pay <b>COST</b></span><span class="balance">Balance: <b><span title="123456789012345678901.234567890123456789">123,456,789,012,345,680,000</span></b></span></span>');
  assert.equal(markup(p.byClass("trade-box receive").props.children[0]), '<span class="trade-box-head"><span>You receive (estimated) <b>' + p.token.symbol + '</b></span></span>');
  const css = readFileSync("src/styles.css", "utf8").replace(comment, "");
  const balance = css.match(/\.trade-box-head \.balance\s*\{([^}]+)\}/)?.[1] ?? "";
  for (const property of [/flex:\s*1 1 0\s*;/, /min-width:\s*0\s*;/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/]) assert.match(balance, property);
});

// Layout arithmetic for the one-row preset contract. IBM Plex Mono advances 0.6em per character (font metric).
const mediaBlock = (css: string, query: string) => {
  const open = css.indexOf("{", css.indexOf(`@media (${query})`)); let depth = 0;
  for (let i = open; i < css.length; i++) if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  throw new Error(`Missing @media (${query})`);
};
const ruleFor = (css: string, selector: string) => css.match(new RegExp(`(?:^|[}\\s])${selector.replaceAll(".", "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
const declared = (property: string, ...rules: string[]) => rules.map(rule => rule.match(new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+)`))?.[1].trim()).find(Boolean)!;
const presetRowWidth = (labels: readonly string[], rules: string[], gap: number) => {
  const font = parseFloat(declared("font-size", ...rules)), padding = parseFloat(declared("padding", ...rules).split(/\s+/)[1]);
  return labels.reduce((sum, label) => sum + label.length * font * 0.6 + 2 * padding + 2, 0) + gap * (labels.length - 1);
};
test("every buy preset set fits one row in the 296px panel of a 360px viewport and in the 360px desktop column", () => {
  const css = readFileSync("src/styles.css", "utf8").replace(comment, ""), narrow = mediaBlock(css, "max-width: 640px");
  const base = [ruleFor(css, ".quick-amounts button")], gap = parseFloat(declared("gap", ruleFor(css, ".quick-amounts")));
  const mobile = [ruleFor(narrow, ".quick-amounts.trade-presets button"), ruleFor(narrow, ".quick-amounts button"), ...base];
  const sets = new Map<string, string[]>();
  for (const stock of [...ROBINHOOD_STOCKS, ...STOCKS]) for (const eth of [false, true])
    sets.set(`${stock.symbol}/${eth}`, buyPresets(stock, eth).map(value => `${value} ${eth ? "ETH" : stock.symbol}`));
  const widest = [...sets.entries()].sort(([, a], [, b]) => b.join("").length - a.join("").length)[0];
  assert.deepEqual(widest[1], ["0.0001 cbBTC", "0.0005 cbBTC", "0.001 cbBTC"], "cbBTC is the longest set");
  for (const [name, labels] of sets) {
    const mobileWidth = presetRowWidth(labels, mobile, gap), desktopWidth = presetRowWidth(labels, base, gap);
    assert(mobileWidth <= 296 - 16, `${name}: ${mobileWidth}px must leave slack inside the 296px panel`);
    assert(desktopWidth <= 360, `${name}: ${desktopWidth}px must fit the 360px desktop column`);
  }
  const button = mobile[0];
  assert.match(button, /flex:\s*1 1 0\s*;/); assert.match(button, /min-width:\s*max-content/); assert.match(button, /white-space:\s*nowrap/);
  assert.doesNotMatch(button, /overflow|text-overflow|(?:^|[\s;])height:/, "values are never clipped and the 32px height is not overridden");
  assert.match(ruleFor(css, ".quick-amounts button"), /height:\s*32px/);
});
test("the token panel preset row carries the one-row modifier on both sides and nothing else uses it", async t => {
  const p = await panel(t, { pair: "cbBTC", connected: false });
  await p.load();
  const row = p.byClass("quick-amounts trade-presets"); assert(row, "buy presets");
  assert.deepEqual(row.props.children.map((b: any) => b.props.children.join("")), ["0.0001 cbBTC", "0.0005 cbBTC", "0.001 cbBTC"]);
  await p.click("Sell"); assert(p.byClass("quick-amounts trade-presets"), "sell percentages keep the same row layout");
  for (const file of ["src/components/FirstBuy.tsx", "src/components/MusegodTradePanel.tsx"]) assert.doesNotMatch(readFileSync(file, "utf8"), /trade-presets/);
});
