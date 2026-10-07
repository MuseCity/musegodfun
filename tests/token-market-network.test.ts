import test from "node:test";
import assert from "node:assert/strict";
import { marketEndpoint } from "../src/components/TokenMarket";
import { syntheticToken } from "./fixtures";

test("token market identities include their chain even for identical addresses", () => {
  const base = syntheticToken(), rh = { ...base, mode: "robinhood" as const, deploymentChainId: 4663 as const };
  const a = marketEndpoint(base, "launch", "summary"), b = marketEndpoint(rh, "launch", "summary");
  assert.equal(a.chainId, 8453);
  assert.equal(b.chainId, 4663);
  assert.notEqual(a.key, b.key);
  assert.equal(a.path, `/tokens/${base.address}/market/summary`);
  assert.equal(b.path, a.path);
});

test("MUSEGOD always reads Robinhood while fork launch identity retains its deployment", () => {
  const token = syntheticToken({ mode: "fork", deploymentChainId: 4663 });
  assert.equal(marketEndpoint(token, "launch", "summary").chainId, 4663);
  const featured = marketEndpoint(syntheticToken(), "musegod", "candles?interval=1h");
  assert.equal(featured.chainId, 4663);
  assert.equal(featured.path, "/musegod/market/candles?interval=1h");
  assert.notEqual(marketEndpoint(token, "launch", "summary").key,
    marketEndpoint({ ...token, mode: "robinhood" }, "launch", "summary").key);
});
