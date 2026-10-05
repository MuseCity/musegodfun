import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi, parseUnits, toHex, type Address, type Hash } from "viem";
import { assetsFor, contractsFor, type RuntimeConfig } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import type { LaunchPlan } from "../src/lib/launch-plan";
import { OPENING_CAP_USD, OPENING_POLICY, type OpeningValuation } from "../src/lib/opening-valuation";
import { assertLaunchRequest, assertLaunchWalletPlan, bufferedLaunchGas, executeLaunchPlan, freezeLaunchPlan, pendingLaunchResolution, terminalLaunchIsCanonical, type LaunchSimulation } from "../src/lib/launch-wallet";
import type { Transaction } from "../src/lib/transactions";

const account: Address = "0x1111111111111111111111111111111111111111";
const other: Address = "0x2222222222222222222222222222222222222222";
const guard: Address = "0x3333333333333333333333333333333333333333";
const bundler: Address = "0x4444444444444444444444444444444444444444";
const hash: Hash = `0x${"a".repeat(64)}`;
const config: RuntimeConfig = { mode: "base", chainId: 8453, treasury: account, writesEnabled: true,
  blockReason: null, curvePolicy: CURVE_POLICY, launchGuard: guard };
const quote = assetsFor(config)[0];

function plan(firstBuy = true): LaunchPlan {
  const now = Date.now();
  const deadline = Math.floor((now + 300_000) / 1000);
  const amountIn = parseUnits("0.01", quote.decimals);
  const expectedAmountOut = parseUnits("100", 18);
  const minAmountOut = expectedAmountOut * 9900n / 10000n;
  const openingValuation: OpeningValuation = {
    policy: OPENING_POLICY, marketCapUsd: OPENING_CAP_USD, chainId: 8453,
    quoteAddress: quote.address, quotePriceUsd: "1", quotedAt: now, expiresAt: now + 300_000,
    source: "Chainlink", blockNumber: "10", blockHash: hash, sourceUpdatedAt: now, feed: other,
  };
  const createData = {
    initialSupply: parseUnits("1000000000", 18), numTokensToSell: parseUnits("1000000000", 18),
    numeraire: quote.address, tokenFactory: other, tokenFactoryData: "0x" as const,
    governanceFactory: other, governanceFactoryData: "0x" as const,
    poolInitializer: other, poolInitializerData: "0x" as const,
    liquidityMigrator: other, liquidityMigratorData: "0x" as const, integrator: account, salt: hash,
  };
  const data = firstBuy ? encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuy",
    args: [createData, amountIn, minAmountOut, BigInt(deadline)] }) : "0x12345678" as const;
  return {
    id: hash, creator: account, data, tokenAddress: other, poolId: hash,
    draft: { name: "Test", symbol: "TEST", image: "", description: "", quoteAddress: quote.address },
    preparedAt: now, gas: null, curvePolicy: CURVE_POLICY, openingValuation,
    transaction: { to: firstBuy ? guard : contractsFor(config).airlock, data, value: "0" },
    ...(firstBuy ? {
      firstBuy: { amount: "0.01", amountIn: amountIn.toString(), expectedAmountOut: expectedAmountOut.toString(),
        minAmountOut: minAmountOut.toString(), slippageBps: 100, deadline, recipient: account,
        quoteAddress: quote.address, guard, bundler },
      approval: { token: quote.address, spender: guard, amount: amountIn.toString(), required: true,
        transaction: { to: quote.address, value: "0", data: encodeFunctionData({ abi: erc20Abi,
          functionName: "approve", args: [guard, amountIn] }) } },
    } : {}),
  };
}

test("launch wallet binds current curve, network, account, quote and frozen transaction", () => {
  const value = plan();
  assert.doesNotThrow(() => assertLaunchWalletPlan(value, config, account));
  assert.doesNotThrow(() => assertLaunchWalletPlan(plan(false), config, account));
  for (const changed of [
    { curvePolicy: undefined }, { curvePolicy: "old" }, { transaction: undefined }, { creator: other },
    { transaction: { ...value.transaction!, to: other } },
    { transaction: { ...value.transaction!, value: "1" } },
    { firstBuy: { ...value.firstBuy!, quoteAddress: other } },
    { firstBuy: { ...value.firstBuy!, recipient: other } },
    { firstBuy: { ...value.firstBuy!, amountIn: "1" } },
    { firstBuy: { ...value.firstBuy!, slippageBps: 123 } },
    { firstBuy: { ...value.firstBuy!, deadline: 1 } },
  ] as Partial<LaunchPlan>[]) assert.throws(() => assertLaunchWalletPlan({ ...value, ...changed }, config, account));
  for (const changed of [{ writesEnabled: false }, { curvePolicy: "old" }, { launchGuard: other }, { chainId: 4663 }])
    assert.throws(() => assertLaunchWalletPlan(value, { ...config, ...changed }, account));
});

test("launch approval is exact and cannot grant another spender or unlimited allowance", () => {
  const value = plan();
  for (const args of [[other, BigInt(value.firstBuy!.amountIn)], [guard, 2n ** 256n - 1n]] as const) {
    const changed = { ...value, approval: { ...value.approval!, transaction: { ...value.approval!.transaction,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args }) } } };
    assert.throws(() => assertLaunchWalletPlan(changed, config, account));
  }
  assert.throws(() => assertLaunchWalletPlan({ ...value, approval: undefined }, config, account));
  const ordinary = plan(false);
  assert.throws(() => assertLaunchWalletPlan({ ...ordinary, approval: value.approval }, config, account));
});

test("launch provider transport permits only the frozen approval or launch transaction", () => {
  const value = plan();
  for (const transaction of [value.transaction!, value.approval!.transaction]) {
    const step = { ...transaction, from: account, chainId: config.chainId };
    const tx = { from: account, to: step.to, data: step.data, value: "0x0", chainId: toHex(step.chainId), gas: "0x100000" };
    assert.doesNotThrow(() => assertLaunchRequest({ method: "eth_chainId" }, step));
    assert.doesNotThrow(() => assertLaunchRequest({ method: "eth_sendTransaction", params: [tx] }, step));
    for (const method of ["personal_sign", "eth_sign", "eth_signTypedData_v4", "eth_sendRawTransaction", "wallet_sendCalls"])
      assert.throws(() => assertLaunchRequest({ method, params: [tx] }, step));
    for (const changed of [{ from: other }, { to: other }, { data: "0x12345678" }, { value: "0x1" },
      { chainId: "0x1" }, { authorizationList: [] }])
      assert.throws(() => assertLaunchRequest({ method: "eth_sendTransaction", params: [{ ...tx, ...changed }] }, step));
  }
});

test("launch execution skips a sufficient allowance and simulates the full transaction before submission", async () => {
  const value = plan();
  const calls: string[] = [];
  const result = await executeLaunchPlan(value, config, account, {
    validate: async (frozen) => { assert.equal(Object.isFrozen(frozen.firstBuy), true); calls.push("validate"); },
    balance: async () => BigInt(value.firstBuy!.amountIn),
    allowance: async () => 2n ** 256n - 1n,
    approve: async () => { calls.push("approve"); },
    simulate: async () => { calls.push("simulate"); return { valid: true, gas: "1000000", amountOut: value.firstBuy!.expectedAmountOut, simulatedAt: Date.now() }; },
    submit: async (transaction, gas) => { calls.push("submit"); assert.deepEqual(transaction, value.transaction); assert.equal(gas, 1000000n); return hash; },
    progress: () => {},
  });
  assert.equal(result, hash);
  assert.deepEqual(calls.filter((call) => call !== "validate"), ["simulate", "submit"]);
});

test("launch execution revalidates after approval and stops on changed draft or expired policy", async () => {
  const value = plan();
  let approved = false, simulated = false, submitted = false;
  await assert.rejects(executeLaunchPlan(value, config, account, {
    validate: async () => { if (approved) throw new Error("The draft or wallet has changed"); },
    balance: async () => BigInt(value.firstBuy!.amountIn), allowance: async () => 0n,
    approve: async () => { approved = true; },
    simulate: async () => { simulated = true; throw new Error("Must not simulate"); },
    submit: async () => { submitted = true; return hash; }, progress: () => {},
  }), /changed/);
  assert.equal(approved, true); assert.equal(simulated, false); assert.equal(submitted, false);
  const frozen = freezeLaunchPlan(value);
  assert.throws(() => assertLaunchWalletPlan(frozen, config, account, value.openingValuation!.expiresAt));
});

test("first buy submission requires confirmed allowance and the same net quote after full simulation", async () => {
  for (const allowanceConfirmed of [false, true]) {
    const value = plan();
    let approved = false, submitted = false;
    await assert.rejects(executeLaunchPlan(value, config, account, {
      validate: async () => {}, balance: async () => BigInt(value.firstBuy!.amountIn),
      allowance: async () => approved && allowanceConfirmed ? BigInt(value.firstBuy!.amountIn) : 0n,
      approve: async () => { approved = true; },
      simulate: async () => ({ valid: true, gas: "1000000", amountOut: "1", simulatedAt: Date.now() }),
      submit: async () => { submitted = true; return hash; }, progress: () => {},
    }), allowanceConfirmed ? /changed/ : /approval is not sufficient/);
    assert.equal(submitted, false);
  }
});

test("ordinary launch needs no balance or approval and keeps a null first buy result", async () => {
  const value = plan(false);
  const forbidden = async (): Promise<never> => { throw new Error("No first buy balance or approval required"); };
  assert.equal(await executeLaunchPlan(value, config, account, {
    validate: async () => {}, balance: forbidden, allowance: forbidden, approve: forbidden,
    simulate: async (): Promise<LaunchSimulation> => ({ valid: true, gas: "1000000", amountOut: null, simulatedAt: Date.now() }),
    submit: async () => hash, progress: () => {},
  }), hash);
});

test("launch and approval gas reserves add 25 percent and respect a safe block ceiling", () => {
  assert.equal(bufferedLaunchGas(1000001n, 30000000n), 1250002n);
  assert.throws(() => bufferedLaunchGas(0n, 30000000n));
  assert.throws(() => bufferedLaunchGas(20000000n, 30000000n));
});

test("pending launch recovery follows repriced hashes but preserves unknown replacements", () => {
  const replacement = `0x${"b".repeat(64)}` as Hash;
  const first: Transaction = { hash, account, chainId: 8453, action: "launch", at: Date.now(),
    status: "replaced", replacement, planId: hash, nonce: 4 };
  const next: Transaction = { ...first, hash: replacement, status: "pending", replacement: undefined };
  assert.deepEqual(pendingLaunchResolution(hash, [first, next], config), { hash: replacement, terminal: null });
  assert.deepEqual(pendingLaunchResolution(hash, [first], config), { hash: replacement, terminal: null });
  assert.equal(pendingLaunchResolution(hash, [first, { ...next, status: "failed" }], config).terminal, "failed");
  assert.equal(pendingLaunchResolution(hash, [{ ...first, status: "cancelled" }], config).proofHash, replacement);
  assert.deepEqual(pendingLaunchResolution(hash, [first, { ...next, status: "replaced", replacement: hash }], config), { hash, terminal: null });
});

test("failed or cancelled launch previews are released only after canonical two-block proof", async () => {
  const replacement = `0x${"b".repeat(64)}` as Hash;
  const failed = { hash, terminal: "failed" as const, proofHash: hash, account, nonce: 4 };
  const deps = {
    receipt: async () => ({ status: "reverted" as const, from: account, blockNumber: 10n, blockHash: hash }),
    transaction: async () => ({ from: account, nonce: 4 }),
    head: async () => 11n, block: async () => ({ hash }),
  };
  assert.equal(await terminalLaunchIsCanonical(failed, deps), true);
  assert.equal(await terminalLaunchIsCanonical(failed, { ...deps, head: async () => 10n }), false);
  assert.equal(await terminalLaunchIsCanonical(failed, { ...deps, block: async () => ({ hash: replacement }) }), false);
  assert.equal(await terminalLaunchIsCanonical(failed, { ...deps, receipt: async () => ({ status: "success", from: account, blockNumber: 10n, blockHash: hash }) }), false);
  const cancelled = { ...failed, terminal: "cancelled" as const, proofHash: replacement };
  assert.equal(await terminalLaunchIsCanonical(cancelled, deps), true);
  assert.equal(await terminalLaunchIsCanonical(cancelled, { ...deps, transaction: async () => ({ from: account, nonce: 5 }) }), false);
  assert.equal(await terminalLaunchIsCanonical({ ...cancelled, nonce: undefined }, deps), false);
  assert.equal(await terminalLaunchIsCanonical({ hash, terminal: null }, deps), false);
  assert.equal(await terminalLaunchIsCanonical(failed, { ...deps, receipt: async () => { throw new Error("RPC unavailable"); } }), false);
});
