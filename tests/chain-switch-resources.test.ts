import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

// Run the real hooks with deterministic React hooks and a controlled network/API, no DOM or network.
async function loadHook(t: TestContext, entry: string, exportName: string, fixtureKey: string) {
  const { build } = await import("esbuild");
  const slots: any[] = []; let cursor = 0; const pending: (() => void)[] = [];
  const responses: { chain: number; path: string; resolve: (value: unknown) => void }[] = [];
  const fixture = {
    chainId: 4663,
    hooks: {
      useState(initial: any) { const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[index].value, (value: any) => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }]; },
      useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
      useEffect(fn: () => any, deps: any[]) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => !Object.is(v, old.deps[i]))) pending.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; }); },
    },
    read: (chain: number, path: string) => new Promise((resolve) => responses.push({ chain, path, resolve })),
  };
  Object.defineProperty(globalThis, fixtureKey, { configurable: true, value: fixture });
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); Reflect.deleteProperty(globalThis, fixtureKey); });
  const { outputFiles } = await build({ bundle: true, write: false, format: "esm", platform: "node", entryPoints: [entry],
    plugins: [{ name: "controlled-hooks", setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "fixture" }));
      build.onResolve({ filter: /^\.\/(api|network)$/ }, ({ path }) => ({ path: path.slice(2), namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "react"
        ? `export const {useState,useRef,useEffect} = globalThis.${fixtureKey}.hooks;`
        : path === "network" ? `export const useNetwork = () => ({ chainId: globalThis.${fixtureKey}.chainId, selectChain() {} });`
          : `export const chainApi = (...args) => globalThis.${fixtureKey}.read(...args);` }));
    } }] });
  const hook = (await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`))[exportName];
  // Returns what the component sees during this render, before its effects run.
  const render = (...args: unknown[]) => { cursor = 0; const value = hook(...args); while (pending.length) pending.shift()!(); return value; };
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { fixture, responses, render, settle };
}

test("useResource never returns the previous chain's data after a chain switch", async (t) => {
  const { fixture, responses, render, settle } = await loadHook(t, "src/lib/resource.ts", "useResource", "__resourceChainSwitch");
  render("/config");
  responses.shift()!.resolve({ chainId: 4663, mode: "robinhood" });
  await settle();
  assert.deepEqual(render("/config").data, { chainId: 4663, mode: "robinhood" });

  fixture.chainId = 8453;
  const switched = render("/config");
  assert.equal(switched.data, null, "the first render on the new chain must not show the old chain's config");
  assert.equal(switched.loading, true);
  assert.equal(switched.error, "");
  const request = responses.shift()!;
  assert.equal(request.chain, 8453);
  request.resolve({ chainId: 8453, mode: "base" });
  await settle();
  assert.deepEqual(render("/config").data, { chainId: 8453, mode: "base" });
});

test("useResource keeps the current chain's data during a same-scope refresh", async (t) => {
  const { responses, render, settle } = await loadHook(t, "src/lib/resource.ts", "useResource", "__resourceRefresh");
  render("/stocks", 0);
  responses.shift()!.resolve(["AAPL"]);
  await settle();
  const refreshing = render("/stocks", 1);
  assert.deepEqual(refreshing.data, ["AAPL"], "a refresh on the same chain keeps the confirmed data visible");
  responses.shift()!.resolve(["AAPL", "NVDA"]);
  await settle();
  assert.deepEqual(render("/stocks", 1).data, ["AAPL", "NVDA"]);
});

test("useTokenCatalog never returns the previous chain's tokens or cursor after a chain switch", async (t) => {
  const { fixture, responses, render, settle } = await loadHook(t, "src/lib/token-catalog.ts", "useTokenCatalog", "__catalogChainSwitch");
  render(0);
  responses.shift()!.resolve({ items: [{ address: "0x00000000000000000000000000000000000000aa" }], nextCursor: "rh-cursor" });
  await settle();
  const loaded = render(0);
  assert.equal(loaded.data.length, 1);
  assert.equal(loaded.nextCursor, "rh-cursor");

  fixture.chainId = 8453;
  const switched = render(0);
  assert.equal(switched.data, null, "the first render on the new chain must not list the old chain's tokens");
  assert.equal(switched.nextCursor, null);
  assert.equal(switched.loading, true);
  const request = responses.shift()!;
  assert.equal(request.chain, 8453);
  request.resolve({ items: [], nextCursor: null });
  await settle();
  const base = render(0);
  assert.deepEqual(base.data, []);
  assert.equal(base.loading, false);
});
