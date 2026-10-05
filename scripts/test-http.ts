import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { assetsFor, networkName, type TokenRecord } from "../src/lib/config";
import { FEE_POLICY } from "../src/lib/fee-policy";

const origin = process.env.TEST_APP_URL || "http://127.0.0.1:5188";
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  "HTTP checks are local only",
);
const checks: string[] = [];
const skipped: { check: string; reason: string }[] = [];
async function call(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(35000),
  });
  return { status: response.status, body: await response.json() };
}
const config = await call("/config");
assert.equal(config.status, 200);
assert(["base", "robinhood"].includes(config.body.mode));
const STOCKS = assetsFor(config.body), chainId = config.body.chainId;
assert.equal(config.body.writesEnabled, process.env.ENABLE_MAINNET_TRANSACTIONS === "true");
checks.push(`${networkName(config.body)} runtime: browser signing ${config.body.writesEnabled ? "enabled" : "disabled"}`);
const stocks = await call("/stocks");
assert.equal(stocks.status, 200);
assert.equal(stocks.body.length, STOCKS.length);
for (const stock of stocks.body) {
  assert(STOCKS.some((s) => s.address === stock.address));
  const expected = STOCKS.find((s) => s.address === stock.address)!;
  assert.equal(stock.issuer, expected.issuer);
  assert.equal(stock.standard, expected.standard);
  assert.equal(stock.chainId, chainId);
  assert.equal(stock.decimals, expected.decimals);
  assert.equal(stock.verified, true);
  if (stock.standard === "B20") assert(BigInt(stock.multiplierWad) > 0n);
  else assert.equal(stock.multiplierWad, null);
  assert(BigInt(stock.totalSupply) >= 0n);
  assert(BigInt(stock.blockNumber) > 0n);
}
checks.push(
  `${STOCKS.length} paired assets verified with native precision, supply and block metadata`,
);
assert.equal((await call("/does-not-exist")).status, 404, "Unknown APIs must return 404");
assert.equal((await fetch(`${origin}/does-not-exist`)).status, 404);
checks.push("Unknown pages and APIs return 404");
const tokens = await call("/tokens");
assert.equal(tokens.status, 200);
assert(Array.isArray(tokens.body));
assert(tokens.body.every((t: TokenRecord) => t.mode === config.body.mode && t.transactionHash &&
  STOCKS.some((stock) => stock.address.toLowerCase() === t.quoteAddress.toLowerCase())));
assert(tokens.body.every((t: TokenRecord) => t.address.toLowerCase() !== "0x908b1d6b6c12bfdfcaaeb658b365ce39c21e679c"));
checks.push("Catalog contains only registered active-chain paired assets and no preloaded project");
if (tokens.body.length === 0) {
  skipped.push({ check: "live registered-pool state and swap quote", reason: "Catalog is empty; no deployed stock-paired pool exists to verify" });
} else {
  const token = tokens.body[0] as TokenRecord;
  const state = await call(`/tokens/${token.address}`);
  assert.equal(state.status, 200);
  assert.equal(state.body.token.poolId.toLowerCase(), token.poolId.toLowerCase());
  const quote = await call("/quote", { address: token.address, side: "buy", amount: "0.01", slippageBps: 100 });
  assert.equal(quote.status, 200);
  assert(BigInt(quote.body.amountOut) > 0n);
  checks.push("Actual registered stock-paired pool identity and read-only buy quote verified");
}
const chain = await call("/rpc", {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_chainId",
  params: [],
});
assert.equal(Number(chain.body.result), chainId);
checks.push(`Read-only RPC resolves to chain ${chainId}`);
const send = await call("/rpc", {
  jsonrpc: "2.0",
  id: 2,
  method: "eth_sendTransaction",
  params: [],
});
assert.equal(send.status, 403);
checks.push("Transaction-sending RPC method blocked");
const crossSite = await call(
  "/launch/register",
  { hash: `0x${"0".repeat(64)}` },
  { origin: "https://example.com" },
);
assert.equal(crossSite.status, 403);
checks.push("Cross-origin mutation rejected");
const badQuote = await call("/quote", {
  address: STOCKS[0].address,
  side: "buy",
  amount: "1",
  slippageBps: 10000,
});
assert.equal(badQuote.status, 400);
checks.push("Unsafe slippage rejected before RPC work");
const badHash = await call("/launch/register", { hash: "0x1234" });
assert.equal(badHash.status, 400);
checks.push("Malformed registration rejected");
const invalidPlan = await call("/launch/prepare", {
  draft: {
    name: "Test",
    symbol: "TEST",
    description: "",
    image: "",
    quoteAddress: STOCKS[0].address,
    openingCap: "100",
  },
  creator: "0x0000000000000000000000000000000000000001",
});
assert.equal(invalidPlan.status, 200);
assert(invalidPlan.body.data.startsWith("0x"));
assert.equal(invalidPlan.body.feePolicy, FEE_POLICY);
assert.equal(invalidPlan.body.feeTreasury.toLowerCase(), config.body.treasury.toLowerCase());
checks.push("Mainnet launch simulation with current fee policy and configured treasury; no signature");
if (config.body.mode === "robinhood") {
  for (const quoteAddress of [
    "0xce24439f2d9c6a2289f741120fe202248b666666",
    "0x6b1d42927b1a84ec28fa88d4fc6fa7af404966be",
  ]) {
    const removed = await call("/launch/prepare", {
      draft: { name: "Removed pair", symbol: "REMOVED", description: "", image: "", quoteAddress, openingCap: "100" },
      creator: "0x0000000000000000000000000000000000000001",
    });
    assert.equal(removed.status, 400, "Removed U/PAIR must be rejected before simulation");
  }
  checks.push("Removed U and PAIR are rejected by production issuance API");
  const musegod = STOCKS.find((asset) => asset.symbol === "MUSEGOD")!;
  assert(musegod);
  const simulation = await call("/launch/prepare", {
    draft: { name: "MUSEGOD pair check", symbol: "MGCHECK", description: "", image: "",
      quoteAddress: musegod.address, openingCap: "1.000000000000000001" },
    creator: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(simulation.status, 200);
  assert.equal(simulation.body.draft.quoteAddress, musegod.address);
  assert.equal(simulation.body.feePolicy, FEE_POLICY);
  assert.equal(simulation.body.feeTreasury.toLowerCase(), config.body.treasury.toLowerCase());
  checks.push("MUSEGOD production issuance simulation preserves 18 decimals and existing fee policy; no signature");
}
const deferred = await call("/buyback/quote", { stockAddress: STOCKS[0].address, amount: "1" });
assert.equal(deferred.body.code, "CROSS_CHAIN_DEFERRED");
checks.push("Base fee bridging cannot prepare a transaction in this release");
const missing = await call("/not-found");
assert.equal(missing.status, 404);
checks.push("Unknown API returns JSON 404");
const report = {
  scope: `HTTP checks against local ${networkName(config.body)} service; tests only read and simulate, no mainnet transactions`,
  observedAt: new Date().toISOString(),
  origin,
  checks,
  skipped,
};
await writeFile(
  "docs/evidence/http-checks.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`PASS: ${checks.length} HTTP checks; ${skipped.length} explicitly skipped checks`);
