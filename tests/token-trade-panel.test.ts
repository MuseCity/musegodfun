import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { syntheticToken } from "./fixtures";
import { NetworkProvider } from "../src/lib/network";
import { ROBINHOOD_STOCKS, STOCKS } from "../src/lib/config";

// Exercise the real panel's request closures and rendered controls without a wallet, DOM or network.
async function panel(chainId: 4663 | 8453, connected: boolean, eth = false, confirmed = false) {
  const entry = pathToFileURL(`${process.cwd()}/src/App.tsx`); entry.search = `trade=${crypto.randomUUID()}`;
  const key = `__trade${crypto.randomUUID().replaceAll("-", "")}`, account = connected ? "0x9999999999999999999999999999999999999999" : null;
  const stock = chainId === 8453 ? STOCKS[0] : ROBINHOOD_STOCKS.find(s => s.symbol === "COST")!;
  const token = syntheticToken({ mode: chainId === 8453 ? "base" : "robinhood", deploymentChainId: chainId, quoteAddress: stock.address });
  const poolKey = { currency0: stock.address, currency1: token.address, fee: 8388608, tickSpacing: 10, hooks: token.address };
  let state = 0, callbacks: any, input: any, tree: any, refreshes = 0;
  const writes: { index: number; value: unknown }[] = [];
  const overrides: Record<number, unknown> = { 2: "1", 6: "Wallet rejection still needs attention", 8: confirmed ? `0x${"1".repeat(64)}` : null,
    9: connected ? 123n : null, 12: eth ? "eth" : "pair", 13: connected ? 456n : null, 19: stock.address };
  const mock = {
    useState(initial: unknown) { const index = state++, value = index in overrides ? overrides[index] : typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [value, (next: unknown) => writes.push({ index, value: typeof next === "function" ? (next as (current: unknown) => unknown)(value) : next })]; },
    useResource(path: string) { return { data: path === "/stocks" ? [] : { token, state: { poolKey } }, loading: false, error: "" }; },
    useWallet: () => ({ account, chainId, revision: 0 }),
    useEthBuyRecord: () => ({ record: null }),
    useAutoQuote(next: unknown, cb: unknown) { input = next; callbacks = cb; return { pending: false, manual: false, refresh() { refreshes++; } }; },
  };
  Reflect.set(globalThis, key, mock);
  Reflect.set(globalThis, "__BUILD_IDENTITY__", { source: "local", commit: "fixture", dirty: true });
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://fixture", pathname: "/", search: "" } });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL !== entry.href) return next(specifier, context);
      if (["./components/FirstBuyLock", "./components/TokenMarket"].includes(specifier)) return { shortCircuit: true, url: "data:text/javascript,export default function Fixture(){return null}" };
      const names: Record<string, string> = { react: "useState", "./lib/resource": "useResource", "./lib/wallet": "useWallet", "./lib/use-auto-quote": "useAutoQuote", "./lib/use-eth-buy-record": "useEthBuyRecord" };
      if (!names[specifier]) return next(specifier, context);
      const actual = specifier === "react" ? import.meta.resolve("react") : new URL(specifier + (specifier === "./lib/wallet" ? ".tsx" : ".ts"), entry).href;
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(actual)};export const {${names[specifier]}}=globalThis[${JSON.stringify(key)}];`)}` };
    },
    load(url, context, next) { const result = next(url, context); return url === entry.href ? { ...result, source: `${result.source}\nexport { TokenPage };` } : result; },
  });
  try {
    const { TokenPage } = await import(entry.href);
    function View() { tree = TokenPage({ address: token.address, config: { mode: token.mode, chainId, deploymentChainId: chainId, writesEnabled: false } }); return tree; }
    const html = renderToStaticMarkup(createElement(NetworkProvider, { children: createElement(View) }));
    function find(node: any): any {
      if (!node || typeof node !== "object") return;
      if (node.props?.className === "text-button quote-refresh") return node;
      const children = Array.isArray(node) ? node : [node.props?.children];
      for (const child of children) { const found = find(child); if (found) return found; }
    }
    return { html, callbacks, input, writes, refresh: () => find(tree).props.onClick(), refreshCount: () => refreshes };
  } finally {
    hooks.deregister(); Reflect.deleteProperty(globalThis, key);
    if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation); else Reflect.deleteProperty(globalThis, "location");
  }
}

for (const chainId of [4663, 8453] as const) test(`actual ${chainId} token panel enables automatic guest quotes and keeps Max only inside the amount field`, async () => {
  for (const connected of [false, true]) {
    const f = await panel(chainId, connected);
    assert.equal(f.input.valid, true); assert.equal(f.input.connected, connected);
    assert.doesNotMatch(f.html, /Get on-chain quote|Get a quote here/);
    const field = f.html.match(/<span class="trade-amount-field">([\s\S]*?)<\/span>/)![0];
    assert.equal(field.includes('class="trade-max"'), connected);
    assert.doesNotMatch(f.html.match(/<div class="quick-amounts">([\s\S]*?)<\/div>/)![0], /Max/);
  }
});

for (const eth of [false, true]) test(`actual ${eth ? "LI.FI" : "pair"} automatic requests preserve unrelated errors even when a new quote fails`, async t => {
  const f = await panel(4663, true, eth);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Quote unavailable" }, { status: 503 }));
  await assert.rejects(f.callbacks.request({ challenge: false, retry: false }), /Quote unavailable/);
  assert.equal(f.writes.some(w => w.index === 6 && w.value === ""), false);
  f.callbacks.error(new Error("Quote unavailable"));
  // The failure has its own slot: the unrelated error is neither replaced nor hides it (see token-trade-session.test.ts).
  assert.equal(f.writes.some(w => w.index === 6), false);
  assert.equal(f.writes.at(-1)?.value, "Quote unavailable");
});

test("actual panel exposes a manual repeat after confirmation while keeping automation paused", async () => {
  const f = await panel(4663, true, false, true);
  assert.equal(f.input.completed, true); assert.match(f.html, /Refresh quote/);
  f.refresh(); assert.equal(f.refreshCount(), 1);
  assert.deepEqual(f.writes.filter(w => [6, 8, 16].includes(w.index)), [{ index: 6, value: "" }, { index: 8, value: null }, { index: 16, value: null }]);
  assert.equal(f.writes.some(w => w.index === 2), false);
});


test("the actual LI.FI panel forwards interactive Refresh options to the challenge API", async t => {
  const f = await panel(4663, true, true);
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  let events = 0, requests = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent(event: CustomEvent) {
    events++; assert.equal(event.type, "musegod:challenge"); event.detail.reject(new Error("User closed check")); return true;
  } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ code: "CHALLENGE_REQUIRED" }, { status: 403 }); });
  await assert.rejects(f.callbacks.request({ challenge: true, retry: false }), /User closed check/);
  assert.equal(events, 1); assert.equal(requests, 1);
});
