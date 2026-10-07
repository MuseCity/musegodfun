import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createDualChainApp, chainApiRoute, knownPage, legacyTokenPath } from "../server/app";
import { runtimeFromEnv, type Runtime } from "../server/config";
import { stockByAddress, STOCKS, ROBINHOOD_STOCKS } from "../src/lib/config";
import { FirstBuyPaymentReader } from "../server/lifi";
import { firstBuyPaymentAssets } from "../src/lib/first-buy-payment";
import { syntheticToken } from "./fixtures";

const treasury = "0x2222222222222222222222222222222222222222";
const guard = "0x3333333333333333333333333333333333333333";
const environmentNames = ["CHAIN_MODE", "FORK_CHAIN_ID", "FORK_RPC_URL", "NODE_ENV", "DATA_DIR", "ALCHEMY_API_KEY",
  "BASE_RPC_URL", "ROBINHOOD_RPC_URL", "PLATFORM_TREASURY", "BASE_PLATFORM_TREASURY", "ROBINHOOD_PLATFORM_TREASURY",
  "ENABLE_MAINNET_TRANSACTIONS", "ENABLE_BASE_TRANSACTIONS", "ENABLE_ROBINHOOD_TRANSACTIONS", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
  "SUPABASE_DATA_SCOPE", "FEE_ENGINE_ADDRESS", "LAUNCH_GUARD_ADDRESS", "FIRST_BUY_GUARD_ADDRESS", "BASE_LAUNCH_GUARD_ADDRESS",
  "BASE_FIRST_BUY_GUARD_ADDRESS", "ROBINHOOD_LAUNCH_GUARD_ADDRESS", "ROBINHOOD_FIRST_BUY_GUARD_ADDRESS", "LIFI_API_KEY", "LIFI_INTEGRATOR"];
function environment(values: Record<string, string>, run: () => void) {
  const previous = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of environmentNames) delete process.env[name];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test("explicit Base runtime cannot inherit Robinhood writing, guard, engine or database scope", () => {
  environment({ CHAIN_MODE: "robinhood", PLATFORM_TREASURY: treasury, ENABLE_MAINNET_TRANSACTIONS: "true",
    LAUNCH_GUARD_ADDRESS: guard, FIRST_BUY_GUARD_ADDRESS: guard, FEE_ENGINE_ADDRESS: guard,
    SUPABASE_DATA_SCOPE: "robinhood", LIFI_API_KEY: "fixture-server-secret", DATA_DIR: ".cache/dualchain-runtime" }, () => {
    const before = { ...process.env };
    const base = runtimeFromEnv(8453), rh = runtimeFromEnv(4663);
    assert.equal(base.config.chainId, 8453);
    assert.equal(base.config.writesEnabled, false);
    assert.equal(base.launchGuardCandidate, null);
    assert.equal(base.firstBuyGuardCandidate, null);
    assert.equal(base.config.feeEngine, null);
    assert.equal(base.dataScope, "base");
    assert.equal(rh.config.chainId, 4663);
    assert.equal(rh.config.writesEnabled, true);
    assert.equal(rh.launchGuardCandidate?.toLowerCase(), guard);
    assert.equal(rh.dataScope, "robinhood");
    assert.notEqual(base.dataDir, rh.dataDir);
    assert.equal(base.lifi.apiKey, "fixture-server-secret");
    assert(!JSON.stringify(base.config).includes("fixture-server-secret"));
    assert.deepEqual({ ...process.env }, before);
  });
});

test("Base signing and first-buy guard require their own configured values", () => {
  environment({ PLATFORM_TREASURY: treasury, ENABLE_BASE_TRANSACTIONS: "true", BASE_FIRST_BUY_GUARD_ADDRESS: guard,
    ENABLE_ROBINHOOD_TRANSACTIONS: "false" }, () => {
    const base = runtimeFromEnv(8453), rh = runtimeFromEnv(4663);
    assert.equal(base.config.writesEnabled, true);
    assert.equal(base.firstBuyGuardCandidate?.toLowerCase(), guard);
    assert.equal(rh.config.writesEnabled, false);
    assert.equal(rh.firstBuyGuardCandidate, null);
  });
});

test("fork endpoints retain deployment identity and reject another deployment", () => {
  environment({ CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", PLATFORM_TREASURY: treasury }, () => {
    const rh = runtimeFromEnv(4663);
    assert.equal(rh.config.chainId, 31337);
    assert.equal(rh.config.deploymentChainId, 4663);
    assert.equal(rh.supabase, undefined);
    assert.throws(() => runtimeFromEnv(8453), /unavailable in this local fork/);
  });
});

test("API and token routes use explicit identities and preserve legacy Robinhood links", () => {
  assert.deepEqual(chainApiRoute("/api/chains/8453/launch/prepare"), { chainId: 8453, path: "/api/launch/prepare" });
  assert.deepEqual(chainApiRoute("/api/chains/4663/rpc"), { chainId: 4663, path: "/api/rpc" });
  assert.equal(chainApiRoute("/api/config"), null);
  for (const path of ["/api/chains/1/config", "/api/chains/31337/rpc", "/api/chains/8453x/config", "/api/chains/0008453/config"])
    assert.throws(() => chainApiRoute(path), /Unsupported deployment network/);
  assert.throws(() => chainApiRoute("/api/chains/8453/rpc/robinhood"), /selected chain RPC/);
  const address = `0x${"1".repeat(40)}`;
  assert.equal(legacyTokenPath(`/token/${address}`), `/token/robinhood/${address}`);
  assert.equal(legacyTokenPath(`/token/base/${address}`), null);
  assert.equal(knownPage(`/token/base/${address}`), true);
  assert.equal(knownPage(`/token/robinhood/${address}`), true);
  assert.equal(knownPage(`/token/ethereum/${address}`), false);
  assert.equal(stockByAddress(STOCKS[0].address, 8453).chainId, 8453);
  assert.equal(stockByAddress(ROBINHOOD_STOCKS[0].address, 4663).chainId, 4663);
  assert.throws(() => stockByAddress(ROBINHOOD_STOCKS[0].address, 8453), /Unsupported paired asset/);
});

function fixtureRuntime(chainId: 8453 | 4663, directory: string, fork = false): Runtime {
  return {
    config: { mode: fork ? "fork" : chainId === 8453 ? "base" : "robinhood", chainId: fork ? 31337 : chainId,
      deploymentChainId: chainId, treasury: null, writesEnabled: false, blockReason: null },
    rpcUrl: "http://127.0.0.1:1", dataDir: join(directory, String(chainId)),
    dataScope: chainId === 8453 ? "base" : "robinhood", launchGuardCandidate: null, firstBuyGuardCandidate: null,
    lifi: { integrator: "musegodfun" },
  };
}

test("HTTP requests with identical token addresses stay in their selected chain and legacy remains Robinhood", async () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-dualchain-"));
  const { app, services } = createDualChainApp(undefined, "loopback", [fixtureRuntime(8453, directory), fixtureRuntime(4663, directory)]);
  for (const [chainId, service] of services) service.tokens = async () => [syntheticToken({ name: String(chainId),
    mode: chainId === 8453 ? "base" : "robinhood", deploymentChainId: chainId })];
  services.get(4663)!.assertNetwork = async () => {};
  services.get(8453)!.assertNetwork = async () => { throw new Error("Base fixture RPC unavailable"); };
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const chainId of [8453, 4663]) {
      const config = await fetch(`${origin}/api/chains/${chainId}/config`).then((response) => response.json());
      assert.equal(config.chainId, chainId);
      const tokens = await fetch(`${origin}/api/chains/${chainId}/tokens?scope=other`).then((response) => response.json());
      assert.equal(tokens[0].name, String(chainId));
    }
    assert.equal((await fetch(`${origin}/api/config`).then((response) => response.json())).chainId, 4663);
    assert.equal((await fetch(`${origin}/api/tokens`).then((response) => response.json()))[0].name, "4663");
    for (const path of ["/readyz", "/api/readyz", "/api/chains/4663/readyz"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ready", chainId: 4663, writesEnabled: false });
    }
    const baseReady = await fetch(`${origin}/api/chains/8453/readyz`);
    assert.equal(baseReady.status, 503);
    assert.deepEqual(await baseReady.json(), { status: "unavailable", chainId: 8453, writesEnabled: false });
    assert.equal((await fetch(`${origin}/api/chains/1/config`)).status, 400);
    assert.equal((await fetch(`${origin}/api/chains/8453/first-buy/quote`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId: 4663 }),
    })).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const service of services.values()) await service.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a fork HTTP service cannot dispatch a request to the other mainnet", async () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-fork-routing-"));
  const { app, services } = createDualChainApp(undefined, "loopback", [fixtureRuntime(8453, directory, true)]);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${origin}/api/chains/8453/config`).then((response) => response.json())).chainId, 31337);
    assert.equal((await fetch(`${origin}/api/chains/4663/config`)).status, 422);
    assert.equal((await fetch(`${origin}/api/chains/4663/first-buy/prices`)).status, 422);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const service of services.values()) await service.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("payment quote preflight blocks identity and LI.FI pricing failures before an executable payment quote", async () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-payment-preflight-"));
  const runtime = fixtureRuntime(8453, directory);
  runtime.config.treasury = treasury;
  const { app, services } = createDualChainApp(undefined, "loopback", [runtime, fixtureRuntime(4663, directory)]);
  const service = services.get(8453)!;
  const asset = STOCKS.find((stock) => stock.ticker === "NVDA")!;
  const numeraire = firstBuyPaymentAssets(8453).find((item) => item.symbol === "USDC")!;
  const reads: string[] = [];
  let pricingRequests = 0;
  let fault = "guard", quotes = 0;
  const originalQuote = FirstBuyPaymentReader.prototype.quote;
  FirstBuyPaymentReader.prototype.quote = async () => { quotes++; throw new Error("LI.FI quote entered"); };
  service.config = async () => ({ ...runtime.config, launchGuard: fault === "guard" ? null : guard });
  Object.assign(service, { client: {
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 1n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) - 5n }),
    getCode: async ({ blockNumber }: { blockNumber: bigint }) => { assert.equal(blockNumber, 1n); return "0xef"; },
    readContract: async ({ address, functionName, blockNumber }: { address: string; functionName: string; blockNumber?: bigint }) => {
      reads.push(functionName);
      if (blockNumber !== undefined) assert.equal(blockNumber, 1n);
      const target = address.toLowerCase() === asset.address.toLowerCase() ? asset : numeraire;
      if (functionName === "symbol") return fault === "identity" ? "WRONG" : target.symbol;
      if (functionName === "decimals") return target.decimals;
      if (functionName === "name") return asset.name;
      if (functionName === "totalSupply") return 1n;
      if (functionName === "multiplier") return 10n ** 18n;
      throw new Error(`Unexpected preflight read ${functionName}`);
    },
  } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === origin) return originalFetch(input, init);
    assert.equal(url.origin, "https://li.quest"); assert.equal(url.pathname, "/v1/quote");
    const params = url.searchParams; pricingRequests++;
    assert.equal(params.get("fromChain"), "8453"); assert.equal(params.get("toChain"), "8453");
    assert.equal(params.get("allowBridges"), "none"); assert.equal(params.get("fee"), "0");
    if (fault === "no_quote") return Response.json({ error: "No same-chain pricing route" }, { status: 404 });
    if (fault === "timeout") throw new DOMException("Synthetic fetch deadline", "TimeoutError");
    const buy = params.get("fromToken")!.toLowerCase() === numeraire.address.toLowerCase();
    const from = buy ? numeraire : asset, to = buy ? asset : numeraire;
    const amountIn = BigInt(params.get("fromAmount")!), fee = amountIn * 25n / 10_000n;
    const amountOut = buy ? (amountIn - fee) * 10n ** 8n / (100n * 10n ** 6n)
      : (amountIn - fee) * 100n * 10n ** 6n / 10n ** 8n;
    const token = (item: typeof numeraire) => ({ ...item, priceUSD: item.symbol === "USDC" ? "1" : "100" });
    const action = { fromChainId: 8453, toChainId: 8453, fromToken: token(from), toToken: token(to),
      fromAddress: params.get("fromAddress"), toAddress: params.get("toAddress"), fromAmount: amountIn.toString(), slippage: Number(params.get("slippage")) };
    if (fault === "quote-mismatch") action.toToken.address = treasury;
    return Response.json({ id: `pricing-${pricingRequests}`, tool: "synthetic-unit-test", action,
      transactionRequest: { chainId: 8453, from: action.fromAddress, to: guard, data: "0x12345678", value: "0x0" },
      estimate: { fromAmount: amountIn.toString(), toAmount: amountOut.toString(), toAmountMin: (amountOut * 99n / 100n).toString(),
        feeCosts: [{ name: "LIFI Fixed Fee", included: true, amount: fee.toString(), token: token(from), feeSplit: { integratorFee: "0", lifiFee: fee.toString() } }] },
      includedSteps: [{ type: "swap", action }] });
  };
  const request = () => fetch(`${origin}/api/chains/8453/first-buy/quote`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: treasury,
      fromToken: "0x0000000000000000000000000000000000000000", toToken: asset.address, amount: "1", slippageBps: 100 }) });
  try {
    const expectedFailures = {
      guard: /guard is configured and verified/, identity: /NVDA contract identity verification failed/,
      no_quote: /LI\.FI pricing or routing is unavailable/, "quote-mismatch": /fixed same-chain price probe/,
      timeout: /LI\.FI pricing or routing is unavailable/,
    };
    for (fault of Object.keys(expectedFailures)) {
      const before = pricingRequests;
      const response = await request(), body = await response.json();
      assert.equal(response.status, 422, fault);
      assert.match(body.error, expectedFailures[fault as keyof typeof expectedFailures], fault);
      assert.equal(quotes, 0, `${fault} cannot request an executable payment`);
      assert.equal(pricingRequests - before, ["guard", "identity"].includes(fault) ? 0 : 1, fault);
    }
    fault = "";
    const before = pricingRequests;
    assert.match((await (await request()).json()).error, /LI.FI quote entered/);
    assert.equal(pricingRequests - before, 2, "both current pricing probes precede the executable quote");
    assert.equal(quotes, 1, "valid LI.FI pricing evidence permits the executable payment quote");
    assert.equal(reads.some((call) => ["latestRoundData", "getOracleParams", "observe"].includes(call)), false);
    assert.equal(runtime.config.writesEnabled, false, "a preview cannot enable signing");
  } finally {
    globalThis.fetch = originalFetch;
    FirstBuyPaymentReader.prototype.quote = originalQuote;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const item of services.values()) await item.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
