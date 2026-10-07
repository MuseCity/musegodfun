import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData, erc20Abi, toHex, zeroAddress, type Address, type Hash } from "viem";
import { assertFirstBuyLaunchConfig, executeFirstBuyPayment } from "../src/lib/first-buy-wallet";
import { FIRST_BUY_PAYMENT_CONTRACTS, assertFirstBuyPaymentQuote, firstBuyPairedAsset, firstBuyPaymentAbi, firstBuyPaymentAssets,
  type FirstBuyPaymentQuote } from "../src/lib/first-buy-payment";
import { launchAssetsFor, ROBINHOOD_STOCKS, type RuntimeConfig } from "../src/lib/config";
import { assertLaunchRequest } from "../src/lib/launch-wallet";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const hash = `0x${"a".repeat(64)}` as Hash;
const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663,
  treasury: other, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY, feePolicy: FEE_POLICY,
  launchGuard: "0x3333333333333333333333333333333333333333", launchLockAvailable: true };
const engineConfig: RuntimeConfig = { ...config, feePolicy: ENGINE_FEE_POLICY,
  feeEngine: "0x7777777777777777777777777777777777777777",
  automationReceiver: "0x4444444444444444444444444444444444444444",
  automationTreasury: "0x5555555555555555555555555555555555555555",
  wethForwarder: "0x6666666666666666666666666666666666666666" };
const launchChanges: { name: string; expected: RuntimeConfig; patch: Partial<RuntimeConfig> }[] = [
  { name: "guard removed", expected: config, patch: { launchGuard: null } },
  { name: "guard replaced", expected: config, patch: { launchGuard: other } },
  { name: "lock capability revoked", expected: config, patch: { launchLockAvailable: false } },
  { name: "curve changed", expected: config, patch: { curvePolicy: "old-curve" } },
  { name: "fee policy changed", expected: config, patch: { feePolicy: ENGINE_FEE_POLICY } },
  { name: "engine removed", expected: engineConfig, patch: { feeEngine: null } },
  { name: "engine replaced", expected: engineConfig, patch: { feeEngine: other } },
  { name: "receiver replaced", expected: engineConfig, patch: { automationReceiver: other } },
  { name: "automation treasury replaced", expected: engineConfig, patch: { automationTreasury: other } },
  { name: "forwarder replaced", expected: engineConfig, patch: { wethForwarder: other } },
];
function quote(native = false, pairedAddress = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"): FirstBuyPaymentQuote {
  const registry = FIRST_BUY_PAYMENT_CONTRACTS[4663], now = Date.now();
  const fromToken = firstBuyPaymentAssets(4663).find((asset) => native ? asset.address === zeroAddress : asset.symbol === "USDG")!;
  const toToken = firstBuyPairedAsset(4663, pairedAddress), amountIn = native ? "10000000000000000" : "10000000";
  const swap = { callTo: other, approveTo: other, sendingAssetId: fromToken.address, receivingAssetId: toToken.address,
    fromAmount: BigInt(amountIn), callData: "0x3f0bde25" as const, requiresDeposit: true };
  return { protocol: "lifi", id: "synthetic-wallet", transactionId: hash, integrator: "musegodfun", tool: "nordstern",
    chainId: 4663, account, fromToken, toToken, amountIn, expectedOut: "10000000", minimumOut: "9900000", slippageBps: 100,
    quotedAt: now, expiresAt: now + 60_000, router: registry.diamond, facet: registry.facet, facetRuntimeHash: registry.runtimeHash,
    blockNumber: "10", blockHash: hash, transaction: { to: registry.diamond, value: native ? amountIn : "0",
      data: encodeFunctionData({ abi: firstBuyPaymentAbi,
        functionName: native ? "swapTokensSingleV3NativeToERC20" : "swapTokensSingleV3ERC20ToERC20",
        args: [hash, "musegodfun", zeroAddress, account, 9_900_000n, swap] }) },
    approval: native ? null : { token: fromToken.address, spender: registry.diamond, amount: amountIn },
    feeAmount: "0", feeUsd: null, gasFeeUsd: null, amountInUsd: null };
}
function dependencies(q: FirstBuyPaymentQuote, allowance = 0n) {
  const calls: string[] = [], approvals: { to: Address; spender: Address; amount: bigint; value: string }[] = [];
  const sent: FirstBuyPaymentQuote[] = [];
  const deps: Parameters<typeof executeFirstBuyPayment>[3] = {
    validate: async () => { calls.push("validate"); }, balance: async () => { calls.push("balance"); return BigInt(q.amountIn); },
    allowance: async () => { calls.push("allowance"); return allowance; },
    approve: async (tx) => {
      calls.push("approve"); const data = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      assert.equal(data.functionName, "approve");
      if (data.functionName !== "approve") throw new Error("wrong approval");
      approvals.push({ to: tx.to, spender: data.args[0], amount: data.args[1], value: tx.value });
    },
    simulate: async () => { calls.push("simulate"); return 100_000n; },
    submit: async (frozen, gas) => { calls.push("submit"); assert.equal(gas, 100_000n); sent.push(frozen); return hash; }, progress: () => {},
  };
  return { deps, calls, approvals, sent };
}
test("removed paired assets retain full historical quote decoding but cannot start a new payment", async () => {
  for (const symbol of ["BND", "SATS"]) {
    const asset = ROBINHOOD_STOCKS.find((item) => item.symbol === symbol)!;
    assert(asset); assert(!launchAssetsFor(config).some((item) => item.address === asset.address));
    for (const native of [false, true]) {
      const q = quote(native, asset.address), f = dependencies(q);
      assertFirstBuyPaymentQuote(q);
      const now = Date.now();
      assertFirstBuyPaymentQuote({ ...q, quotedAt: now - 120_000, expiresAt: now - 60_000 }, now, true);
      await assert.rejects(executeFirstBuyPayment(q, config, account, f.deps), /new launch.*verified LI\.FI route/);
      assert.deepEqual(f.calls, [], "the new-entry policy rejects before RPC and signing dependencies");
      assert.equal(f.approvals.length, 0); assert.equal(f.sent.length, 0);
    }
  }
  const allowed = quote(), f = dependencies(allowed);
  assert(launchAssetsFor(config).some((asset) => asset.address === allowed.toToken.address));
  await executeFirstBuyPayment(allowed, config, account, f.deps);
  assert.equal(f.approvals.length, 1); assert.equal(f.sent.length, 1);
});
test("payment requires an available first-buy launch and preserves its complete reviewed fee graph", async () => {
  for (const expected of [config, engineConfig, { ...config, launchLockAvailable: false }]) {
    assertFirstBuyLaunchConfig(expected, { ...expected });
    const q = quote(), f = dependencies(q, BigInt(q.amountIn));
    f.deps.validate = async () => assertFirstBuyLaunchConfig(expected, { ...expected });
    await executeFirstBuyPayment(q, expected, account, f.deps);
    assert.equal(f.sent.length, 1);
  }
  for (const unavailable of [{ ...config, launchGuard: null }, { ...config, curvePolicy: "old-curve" },
    { ...engineConfig, feeEngine: null }, { ...engineConfig, automationReceiver: null },
    { ...engineConfig, automationReceiver: engineConfig.automationTreasury }]) {
    const f = dependencies(quote());
    await assert.rejects(executeFirstBuyPayment(quote(), unavailable, account, f.deps), /launch/);
    assert.equal(f.calls.length, 0); assert.equal(f.approvals.length, 0); assert.equal(f.sent.length, 0);
  }
});
test("launch configuration changes before approval stop both token approvals and payment", async () => {
  for (const { name, expected, patch } of launchChanges) {
    const q = quote(), f = dependencies(q);
    f.deps.validate = async () => assertFirstBuyLaunchConfig(expected, { ...expected, ...patch });
    await assert.rejects(executeFirstBuyPayment(q, expected, account, f.deps), /launch/, name);
    assert.equal(f.approvals.length, 0, name); assert.equal(f.sent.length, 0, name);
    assert(!f.calls.includes("simulate"), name);
  }
});
test("changes after token approval or native simulation stop payment without another approval or automatic retry", async () => {
  for (const { name, expected, patch } of launchChanges) {
    for (const native of [false, true]) {
      const q = quote(native), f = dependencies(q);
      let current = { ...expected };
      f.deps.validate = async () => assertFirstBuyLaunchConfig(expected, current);
      if (native) f.deps.simulate = async () => { f.calls.push("simulate"); current = { ...expected, ...patch }; return 100_000n; };
      else {
        const approve = f.deps.approve;
        f.deps.approve = async (tx, frozen) => { await approve(tx, frozen); current = { ...expected, ...patch }; };
      }
      await assert.rejects(executeFirstBuyPayment(q, expected, account, f.deps), /launch/, name);
      assert.equal(f.approvals.length, native ? 0 : 1, name); assert.equal(f.sent.length, 0, name);
      assert.equal(f.calls.filter((call) => call === "simulate").length, native ? 1 : 0, name);
    }
  }
});
test("token payment submits exactly one frozen conversion and resets oversized allowance to the exact amount", async () => {
  const q = quote(), f = dependencies(q, 999_999_999n);
  assert.equal(await executeFirstBuyPayment(q, config, account, f.deps), hash);
  assert.deepEqual(f.approvals.map((a) => a.amount), [0n, BigInt(q.amountIn)]);
  assert(f.approvals.every((a) => a.to === q.fromToken.address && a.spender === q.router && a.value === "0"));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], q);
  assert(f.calls.indexOf("simulate") > f.calls.lastIndexOf("approve"));
});
test("native payments and already exact allowances cannot create token approvals", async () => {
  for (const native of [true, false]) {
    const q = quote(native), f = dependencies(q, BigInt(q.amountIn));
    await executeFirstBuyPayment(q, config, account, f.deps);
    assert.equal(f.approvals.length, 0); assert.equal(f.sent.length, 1);
    if (native) assert(!f.calls.includes("allowance"));
  }
});
test("the final wallet guard permits the exact native payment and rejects added value or unrelated signing", () => {
  const q = quote(true), step = { ...q.transaction, from: account, chainId: 4663 };
  const tx = { from: account, to: step.to, data: step.data, value: toHex(BigInt(step.value)), chainId: "0x1237" };
  // The guard is shared with zero-value launch calls, but this payment must
  // carry exactly the frozen native amount through the wallet transport.
  assertLaunchRequest({ method: "eth_sendTransaction", params: [tx] }, step);
  assert.throws(() => assertLaunchRequest({ method: "eth_sendTransaction", params: [{ ...tx, value: toHex(BigInt(step.value) + 1n) }] }, step));
  assert.throws(() => assertLaunchRequest({ method: "personal_sign", params: [q.transaction.data, account] }, step));
});
test("insufficient balance and changed authorization prevent any approval or conversion", async () => {
  const q = quote(), poor = dependencies(q);
  poor.deps.balance = async () => BigInt(q.amountIn) - 1n;
  await assert.rejects(executeFirstBuyPayment(q, config, account, poor.deps), /balance/);
  assert.equal(poor.approvals.length, 0); assert.equal(poor.sent.length, 0); assert(!poor.calls.includes("simulate"));
  for (const change of [{ cfg: { ...config, writesEnabled: false }, wallet: account },
    { cfg: config, wallet: other }, { cfg: { ...config, mode: "base" as const, chainId: 8453, deploymentChainId: 8453 as const }, wallet: account }]) {
    const f = dependencies(q);
    await assert.rejects(executeFirstBuyPayment(q, change.cfg, change.wallet, f.deps));
    assert.equal(f.calls.length, 0);
  }
});
test("expiry after approval or simulation stops the conversion and never retries it automatically", async (t) => {
  const initial = Date.now(); let now = initial;
  t.mock.method(Date, "now", () => now);
  const q = quote(), f = dependencies(q);
  f.deps.approve = async () => { f.calls.push("approve"); now += 60_000; };
  await assert.rejects(executeFirstBuyPayment(q, config, account, f.deps));
  assert.equal(f.calls.filter((c) => c === "approve").length, 1);
  assert(!f.calls.includes("simulate")); assert.equal(f.sent.length, 0);
  now = initial;
  const simulated = dependencies(quote(), BigInt(q.amountIn));
  simulated.deps.simulate = async () => { simulated.calls.push("simulate"); now += 60_000; return 100_000n; };
  await assert.rejects(executeFirstBuyPayment(q, config, account, simulated.deps));
  assert.equal(simulated.sent.length, 0);
});
test("a caller mutating its quote while approval waits cannot redirect the frozen conversion", async () => {
  const q = quote(), original = structuredClone(q), f = dependencies(q);
  const approve = f.deps.approve;
  f.deps.approve = async (tx, frozen) => { await approve(tx, frozen); q.transaction.to = other; q.amountIn = "1"; q.account = other; };
  await executeFirstBuyPayment(q, config, account, f.deps);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0], original);
  const failed = dependencies(original, BigInt(original.amountIn));
  failed.deps.submit = async () => { failed.calls.push("submit"); throw new Error("wallet rejected"); };
  await assert.rejects(executeFirstBuyPayment(original, config, account, failed.deps), /wallet rejected/);
  assert.equal(failed.calls.filter((c) => c === "submit").length, 1);
});
