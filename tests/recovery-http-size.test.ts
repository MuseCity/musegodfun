import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DopplerSDK, airlockAbi, computePoolId } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, encodeFunctionData, http, keccak256, type Address, type Hex } from "viem";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { ROBINHOOD_CONTRACTS, ROBINHOOD_STOCKS } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { buildLaunch } from "../src/lib/protocol";
import { launchSchema } from "../src/lib/validation";
import { syntheticOpeningValuation, syntheticToken } from "./fixtures";

const creator = "0x1111111111111111111111111111111111111111" as Address;
const treasury = "0x2222222222222222222222222222222222222222" as Address;
const token = "0x4444444444444444444444444444444444444444" as Address;
const hash = `0x${"a".repeat(64)}` as Hex;
const stock = ROBINHOOD_STOCKS.find(asset => asset.symbol === "WETH")!;
const publicLink = (host: string) => {
  const prefix = `https://${host}/`;
  return prefix + "a".repeat(500 - prefix.length);
};

// The SDK really encodes the production curve and metadata. Prediction and
// HTTP registration results are fixtures; no RPC, wallet or settlement claim.
function completeRecoveryPlan(): LaunchPlan {
  const sdk = new DopplerSDK<4663>({ chainId: 4663,
    publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }) });
  const now = Date.now();
  const draft = launchSchema.parse({ name: "Maximum metadata recovery", symbol: "RECOVER", description: "中".repeat(280),
    image: publicLink("example.com"), website: publicLink("example.org"),
    twitter: publicLink("x.com"), telegram: publicLink("t.me"), quoteAddress: stock.address, tradingFeeBps: 100 });
  const openingValuation = syntheticOpeningValuation(stock.address, "3000", { chainId: 4663, quotedAt: now });
  const createParams = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, treasury,
    openingValuation, hash, 4663));
  const data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [createParams] });
  const transaction = { to: ROBINHOOD_CONTRACTS.airlock, data, value: 0n };
  const poolKey = { currency0: stock.address, currency1: token, fee: 8388608,
    tickSpacing: 10, hooks: ROBINHOOD_CONTRACTS.initializer };
  const poolId = computePoolId(poolKey);
  const prepared = serializePrepared({ chainId: 4663, account: creator, airlock: ROBINHOOD_CONTRACTS.airlock, createParams,
    prediction: { tokenAddress: token, poolOrHookAddress: token, governanceAddress: treasury, timelockAddress: treasury,
      poolKey, poolId, tokenIsCurrency0: false }, transaction, gasEstimate: { status: "unavailable" } });
  return { id: keccak256(data), creator, tokenAddress: token, poolId, data, draft, prepared,
    transaction: { ...transaction, value: "0" }, preparedAt: now, finalizedAt: now,
    signingExpiresAt: now + 300_000, serverTime: now, validityVersion: 2, intentId: "large-http-recovery-intent",
    gas: null, feePolicy: FEE_POLICY, feeTreasury: treasury, curvePolicy: CURVE_POLICY, openingValuation };
}

test("real SDK recovery envelopes above 64 KiB reach registration intact while both route limits stay bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "large-recovery-http-"));
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663",
    DATA_DIR: directory, PLATFORM_TREASURY: treasury });
  const { app, service } = createApp(undefined, "loopback", runtime);
  const received: LaunchPlan[] = [];
  service.register = async (sentHash, backup) => {
    assert.equal(sentHash, hash); assert(backup); received.push(backup);
    return syntheticToken();
  };
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(origin + path, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const recoveryPlan = completeRecoveryPlan(), body = { hash, recoveryPlan };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    assert(bytes > 65_536 && bytes < 262_144, `Expected a real bounded large backup, received ${bytes} bytes`);
    const response = await post("/api/launch/register", body);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(received.at(-1), recoveryPlan, "all CreateParams and repeated calldata survive the wire unchanged");
    const calls = received.length;
    const invalid = await post("/api/launch/register", { hash, recoveryPlan: { ...recoveryPlan, creator: "invalid" } });
    assert.equal(invalid.status, 400); assert.equal(received.length, calls);
    const oversized = await post("/api/launch/register", { hash,
      recoveryPlan: { ...recoveryPlan, excessive: "x".repeat(262_144) } });
    assert.equal(oversized.status, 413); assert.equal(received.length, calls);
    const unrelated = await post("/api/launch/validate", { creator, data: recoveryPlan.data, excessive: "x".repeat(65_536) });
    assert.equal(unrelated.status, 413, "ordinary endpoints retain the original 64 KiB cap");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
