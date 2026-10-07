import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, zeroAddress, type Address } from "viem";
import { bundlerAbi } from "@whetstone-research/doppler-sdk/evm";
import { ROBINHOOD_BUNDLER, ROBINHOOD_STOCKS, STOCKS } from "../src/lib/config";
import { assertLaunchPlanValidity, LAUNCH_SIGNING_TTL, type LaunchPlan } from "../src/lib/launch-plan";
import { assertStock, readStockStatus } from "../src/lib/protocol";
import { firstBuyLockStatusFromPosition } from "../server/first-buy-lock-status";
import { syntheticOpeningValuation } from "./fixtures";

const creator = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const now = 1_800_000_000_000;
test("finalized v2 signing lasts five minutes while price freshness is checked only at finalization", () => {
  const stock = STOCKS[0];
  const plan = { draft: { quoteAddress: stock.address }, preparedAt: now, finalizedAt: now,
    signingExpiresAt: now + LAUNCH_SIGNING_TTL, serverTime: now, validityVersion: 2, intentId: "independent-draft-1",
    openingValuation: syntheticOpeningValuation(stock.address, "100", { quotedAt: now - 59_000 }) } as LaunchPlan;
  assert.doesNotThrow(() => assertLaunchPlanValidity(plan, 8453, now + 240_000));
  assert.throws(() => assertLaunchPlanValidity(plan, 8453, now + 300_000), /expired/);
  assert.throws(() => assertLaunchPlanValidity({ ...plan, signingExpiresAt: now + 600_000 }, 8453, now), /changed|invalid/);
  assert.throws(() => assertLaunchPlanValidity({ ...plan, openingValuation: syntheticOpeningValuation(stock.address, "100", { quotedAt: now - 60_000 }) }, 8453, now), /expired/);
  assert.throws(() => assertLaunchPlanValidity({ ...plan, validityVersion: undefined }, 8453, now + 61_000), /expired/);
});

test("RH multiplier schedules are display-only; unknown metadata is advisory and known transfer pause blocks", async () => {
  const stock = ROBINHOOD_STOCKS.find((asset) => asset.issuer === "Robinhood")!;
  const values: Record<string, unknown> = { symbol: stock.symbol, decimals: stock.decimals, name: stock.name,
    totalSupply: 42n, uiMultiplier: 2n * 10n ** 18n, newUIMultiplier: 3n * 10n ** 18n, effectiveAt: 1_900_000_000n,
    paused: false, oraclePaused: false };
  const calls: string[] = [];
  const client = { readContract: async ({ functionName }: { functionName: string }) => {
    calls.push(functionName); if (!(functionName in values)) throw new Error("unavailable"); return values[functionName];
  } } as unknown as Parameters<typeof readStockStatus>[0];
  const full = await readStockStatus(client, stock.address);
  assert.equal(full.multiplierWad, 2n * 10n ** 18n); assert.equal(full.newMultiplierWad, 3n * 10n ** 18n);
  assert.equal(full.multiplierEffectiveAt, 1_900_000_000); assert(!calls.includes("multiplier"));
  delete values.uiMultiplier;
  const unknown = await readStockStatus(client, stock.address);
  assert.equal(unknown.identityVerified, true); assert.equal(unknown.multiplierWad, null); assert(unknown.warnings.length > 0);
  await assert.doesNotReject(() => assertStock(client, stock.address));
  values.oraclePaused = true;
  assert((await readStockStatus(client, stock.address)).warnings.some((warning) => warning.code === "asset_oracle_paused"));
  values.paused = true; await assert.rejects(() => readStockStatus(client, stock.address), /transfers are paused/);
  values.paused = false; values.symbol = "wrong";
  await assert.rejects(() => readStockStatus(client, stock.address), /identity/);
  delete values.symbol; assert.equal((await readStockStatus(client, stock.address)).identityVerified, false);
  await assert.rejects(() => assertStock(client, stock.address), /identity/);
});

test("independent lock status supports full cliffs, post-claim recovery and optional catalog records", () => {
  for (const days of [30, 90, 365] as const) {
    const start = 1_800_000_000n, duration = BigInt(days) * 86400n;
    const position = [creator, false, start, duration, duration, 1000n, 0n] as const;
    const locked = firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, position, 0n)!;
    assert.equal(locked.recordVerified, false); assert.equal(locked.claimTransaction, undefined);
    assert.equal(locked.unlockAt, Number(start + duration)); assert.equal(locked.lockDays, days);
    const unlocked = firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, position, 1000n, locked)!;
    assert.equal(unlocked.recordVerified, true);
    const call = decodeFunctionData({ abi: bundlerAbi, data: unlocked.claimTransaction!.data });
    assert.equal(call.functionName, "claim"); assert.deepEqual(call.args, [token]);
    const claimed = firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, [...position.slice(0, 6), 1000n] as any, 0n)!;
    assert.equal(claimed.claimedAmount, "1000"); assert.equal(claimed.claimTransaction, undefined);
    assert.equal(firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, position, 0n,
      { ...locked, recipient: token })!.recordVerified, false, "catalog mismatch cannot block chain custody recovery");
    assert.equal(firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, position, 0n, { ...locked, totalAmount: "corrupt" })!.recordVerified, false);
    assert.throws(() => firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, position, 1001n), /supported/);
    assert.throws(() => firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, [creator, true, start, duration, duration, 1000n, 0n], 0n), /supported/);
  }
  assert.equal(firstBuyLockStatusFromPosition(token, 4663, ROBINHOOD_BUNDLER, [zeroAddress, false, 0n, 0n, 0n, 0n, 0n], 0n), null);
});
