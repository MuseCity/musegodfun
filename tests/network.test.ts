import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NetworkProvider, pathChain, tokenPath, useNetwork } from "../src/lib/network";
import { chainApi } from "../src/lib/api";
import { launchDraftKey } from "../src/lib/launch-draft";
import type { RuntimeConfig } from "../src/lib/config";
import { syntheticToken } from "./fixtures";

const token = syntheticToken();

test("canonical and legacy token URLs choose a network independently of the wallet or query", () => {
  assert.equal(pathChain(`/token/base/${token.address}`, "?chainId=4663"), 8453);
  assert.equal(pathChain(`/token/robinhood/${token.address}`, "?chainId=8453"), 4663);
  assert.equal(pathChain(`/token/${token.address}`, "?chainId=8453"), 4663);
  assert.equal(pathChain("/buyback", "?chainId=8453"), 4663);
  assert.equal(tokenPath(token), `/token/base/${token.address}`);
  assert.equal(tokenPath({ ...token, mode: "robinhood" }), `/token/robinhood/${token.address}`);
  assert.equal(tokenPath({ ...token, mode: "fork", deploymentChainId: 4663 }), `/token/robinhood/${token.address}`);
});

test("Create selects only supported deployment chains from its query", () => {
  assert.equal(pathChain("/create", "?chainId=8453"), 8453);
  assert.equal(pathChain("/create", "?chainId=4663"), 4663);
  assert.equal(pathChain("/create", ""), null);
  for (const query of ["?chainId=1", "?chainId=31337", "?chainId=8453x", "?chainId=0008453"])
    assert.equal(pathChain("/create", query), null);
});

test("initial NetworkProvider defaults to Robinhood and honors an explicit URL", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  function View() { return createElement("span", null, String(useNetwork().chainId)); }
  try {
    for (const [path, expected] of [["/", 4663], ["/create", 4663], ["/create?chainId=8453", 8453]] as const) {
      const url = new URL(path, "https://local.invalid");
      Object.defineProperty(globalThis, "location", { configurable: true, value: url });
      const rendered = renderToStaticMarkup(createElement(NetworkProvider, null, createElement(View)));
      assert.equal(rendered, `<span>${expected}</span>`);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous); else Reflect.deleteProperty(globalThis, "location");
  }
});

test("fork draft keys distinguish the deployment behind the shared runtime 31337", () => {
  const base: RuntimeConfig = { mode: "fork", chainId: 31337, deploymentChainId: 8453,
    treasury: null, writesEnabled: false, blockReason: null };
  const rh = { ...base, deploymentChainId: 4663 as const };
  assert.equal(launchDraftKey(base), "musegod.launch.draft.31337.8453");
  assert.equal(launchDraftKey(rh), "musegod.launch.draft.31337.4663");
  assert.notEqual(launchDraftKey(base), launchDraftKey(rh));
  assert.equal(pathChain("/create", "?chainId=8453"), base.deploymentChainId);
  assert.equal(pathChain("/create", "?chainId=4663"), rh.deploymentChainId);
});

test("API calls capture the selected deployment and cannot normalize into another chain", async () => {
  const previous = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ valid: true });
  };
  try {
    await chainApi(8453, "/config");
    await chainApi(4663, "/launch/prepare", { amount: "0", lockDays: 0 });
    assert.deepEqual(calls, [
      { url: "/api/chains/8453/config", method: "GET", body: null },
      { url: "/api/chains/4663/launch/prepare", method: "POST", body: { amount: "0", lockDays: 0 } },
    ]);
    assert.throws(() => chainApi(1 as 8453, "/config"), /Unsupported/);
    for (const path of ["//remote.invalid/config", "https://remote.invalid/config", "/../4663/config", "/%2e%2e/4663/config"])
      assert.throws(() => chainApi(8453, path), /Unsupported/);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = previous; }
});
