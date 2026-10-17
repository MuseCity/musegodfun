import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MUSEGOD } from "../src/lib/musegod";
import type { RuntimeConfig } from "../src/lib/config";
import { syntheticToken } from "./fixtures";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: "Read-only" };
const launch = syntheticToken({ name: "AAA launch", symbol: "AAA", mode: "robinhood", quoteAddress: MUSEGOD.weth, createdAt: MUSEGOD.createdAt + 10_000 });

/** Depth-first search of a React element tree for the first element matching `match`. Nested components stay unexpanded. */
function find(node: any, match: (element: any) => boolean): any {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return null; }
  if (match(node)) return node;
  return find(node.props?.children, match);
}
function text(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text(node.props?.children);
}

test("an empty filtered list offers one primary action that restores the full list and keeps creation secondary", async () => {
  const originals = new Map(["localStorage", "__BUILD_IDENTITY__"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
  Object.defineProperty(globalThis, "__BUILD_IDENTITY__", { configurable: true, value: {
    schemaVersion: 1, repository: "https://github.com/test/test", commit: "a".repeat(40), source: "local", dirty: true, buildId: null, runUrl: null, releaseUrl: null,
  } });
  let bridge: any;
  const props: any = { tokens: [launch], stocks: null, stockError: "", tokenError: "", loading: false, config, refresh: () => {} };
  const runtime = hookRuntime(() => bridge(props));
  try {
    ({ Explore: bridge } = await importFresh("src/App.tsx", {
      react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
      "./lib/network": { file: import.meta.resolve("../src/lib/network.tsx"), bindings: { useNetwork: () => ({ chainId: 4663, selectChain() {} }) } },
      "./lib/token-card-market": { file: import.meta.resolve("../src/lib/token-card-market.ts"), bindings: { useTokenCardMarkets: () => ({}) } },
    }));
    runtime.render(); await settle();
    const markup = () => renderToStaticMarkup(runtime.output());
    const button = (label: string) => find(runtime.output(), element => element.type === "button" && text(element).startsWith(label));
    const search = () => find(runtime.output(), element => element.type === "input" && element.props.type === "search");
    const quote = () => find(runtime.output(), element => element.type === "select" && element.props["aria-label"] === "Filter by quote asset");
    assert.match(markup(), /AAA launch/);
    assert.doesNotMatch(markup(), /Show all launches/);

    button("New in 24h").props.onClick(); await settle();
    let html = markup();
    assert.match(html, /No matching tokens/);
    assert.doesNotMatch(html, /AAA launch/);
    assert.match(html, /<button type="button" class="primary"[^>]*>Show all launches<\/button>/);
    assert.match(html, /<a href="\/create\?chainId=4663" class="secondary"/);
    assert(html.indexOf("Show all launches") < html.indexOf("Create your meme"), "restoring the list comes before creating a token");

    button("Show all launches").props.onClick(); await settle();
    html = markup();
    assert.match(html, /AAA launch/);
    assert.doesNotMatch(html, /Show all launches|No matching tokens/);
    assert.match(html, /<button type="button" class="filter-chip" aria-pressed="true"[^>]*>All launches<\/button>/);

    search().props.onChange({ target: { value: "zzz" } });
    quote().props.onChange({ target: { value: "NVDA" } });
    button("Locked first buy").props.onClick(); await settle();
    assert.match(markup(), /No matching tokens/);
    button("Show all launches").props.onClick(); await settle();
    html = markup();
    assert.match(html, /AAA launch/);
    assert.equal(search().props.value, "");
    assert.equal(quote().props.value, "all");
    assert.match(html, /aria-pressed="true"[^>]*>All launches</);

    // Robinhood always lists the featured MUSEGOD row, so an empty catalog is a Base view.
    props.tokens = []; props.config = { ...config, mode: "base", chainId: 8453, deploymentChainId: 8453 }; runtime.render(); await settle();
    html = markup();
    assert.match(html, /The first story starts with you/);
    assert.doesNotMatch(html, /Show all launches/);
    assert.match(html, /href="\/create\?chainId=4663" class="secondary"/);
  } finally {
    runtime.unmount();
    for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); }
  }
});
