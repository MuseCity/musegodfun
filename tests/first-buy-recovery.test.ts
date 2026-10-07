import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { resolveFirstBuyPayment, paymentMatchesLaunch, registeredLaunchConsumesPayment, sameFirstBuyPayment,
  type FirstBuyPaymentAttempt, type FirstBuyRecoveryDependencies } from "../src/lib/first-buy-recovery";
import { FIRST_BUY_PAYMENT_CONTRACTS, firstBuyPairedAsset, firstBuyPaymentAbi, firstBuyPaymentAssets, type FirstBuyPaymentQuote } from "../src/lib/first-buy-payment";
import type { Transaction } from "../src/lib/transactions";
import type { RuntimeConfig } from "../src/lib/config";
import type { LaunchPlan } from "../src/lib/launch-plan";
import { syntheticOpeningValuation, syntheticToken } from "./fixtures";
const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const hash = `0x${"a".repeat(64)}` as Hex, replacement = `0x${"b".repeat(64)}` as Hex, blockHash = `0x${"c".repeat(64)}` as Hex;
const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null };
function fixture() {
  const registry = FIRST_BUY_PAYMENT_CONTRACTS[4663], now = Date.now();
  const fromToken = firstBuyPaymentAssets(4663).find((a) => a.symbol === "ETH")!, toToken = firstBuyPairedAsset(4663, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  const q: FirstBuyPaymentQuote = { protocol: "lifi", id: "recovery-synthetic", transactionId: hash, integrator: "musegodfun", tool: "nordstern",
    chainId: 4663, account, fromToken, toToken, amountIn: "1000", expectedOut: "1000", minimumOut: "990", slippageBps: 100,
    quotedAt: now - 120_000, expiresAt: now - 60_000, router: registry.diamond, facet: registry.facet, facetRuntimeHash: registry.runtimeHash,
    blockNumber: "1", blockHash, transaction: { to: registry.diamond, value: "1000", data: encodeFunctionData({ abi: firstBuyPaymentAbi,
      functionName: "swapTokensSingleV3NativeToERC20", args: [hash, "musegodfun", zeroAddress, account, 990n,
        { callTo: other, approveTo: other, sendingAssetId: zeroAddress, receivingAssetId: toToken.address,
          fromAmount: 1000n, callData: "0x3f0bde25", requiresDeposit: true }] }) }, approval: null, feeAmount: "0", feeUsd: null, gasFeeUsd: null, amountInUsd: null };
  const row: Transaction = { hash, chainId: 4663, account, action: "swap", status: "cancelled", at: now, nonce: 7,
    replacement, firstBuyPayment: q };
  let originalAvailable = false, pending = false, canonical = true, head = 11n;
  const tx = { hash: replacement, from: account, to: account as Address | null, input: "0x" as Hex, value: 0n, nonce: 7 };
  const receipt = { from: account, status: "success" as "success" | "reverted", blockNumber: 10n, blockHash, transactionHash: replacement };
  const deps: FirstBuyRecoveryDependencies = {
    transaction: async (requested) => {
      if (requested === hash) {
        if (!originalAvailable) throw new Error("evicted");
        return { hash, from: account, to: q.router, input: q.transaction.data, value: 1000n, nonce: 7 };
      }
      return tx;
    }, receipt: async () => { if (pending) throw new Error("pending"); return receipt; },
    head: async () => head, block: async () => ({ hash: canonical ? blockHash : hash }),
  };
  return { q, row, tx, receipt, deps, original: () => { originalAvailable = true; }, pending: () => { pending = true; },
    reorg: () => { canonical = false; }, oneBlock: () => { head = 10n; } };
}
test("a canonical same-account same-nonce cancellation permits a new quote without accepting swap output", async () => {
  const f = fixture();
  assert.deepEqual(await resolveFirstBuyPayment(hash, f.q, [f.row], config, f.deps), { hash: replacement, cancelled: true });
  f.receipt.status = "reverted";
  assert.equal((await resolveFirstBuyPayment(hash, f.q, [f.row], config, f.deps)).cancelled, true);
});
test("repricing preserves the exact frozen transaction and only changes the receipt hash", async () => {
  const f = fixture(); f.row.status = "replaced"; f.tx.to = f.q.router; f.tx.input = f.q.transaction.data; f.tx.value = 1000n;
  assert.deepEqual(await resolveFirstBuyPayment(hash, f.q, [f.row], config, f.deps), { hash: replacement, cancelled: false });
});
test("missing nonce, other wallet, changed nonce, one confirmation, reorg and pending never clear recovery", async () => {
  for (const modify of [(f: ReturnType<typeof fixture>) => { f.row.nonce = undefined; },
    (f: ReturnType<typeof fixture>) => { f.tx.from = other; }, (f: ReturnType<typeof fixture>) => { f.tx.nonce = 8; },
    (f: ReturnType<typeof fixture>) => { f.oneBlock(); }, (f: ReturnType<typeof fixture>) => { f.reorg(); },
    (f: ReturnType<typeof fixture>) => { f.pending(); }]) {
    const f = fixture(); modify(f);
    assert.equal((await resolveFirstBuyPayment(hash, f.q, [f.row], config, f.deps)).cancelled, false);
  }
});
test("exact original RPC transaction can recover its nonce; wrong scopes and replacement cycles are ignored", async () => {
  const f = fixture(); f.row.nonce = undefined; f.original();
  assert.equal((await resolveFirstBuyPayment(hash, f.q, [f.row], config, f.deps)).cancelled, true);
  f.row.chainId = 31337; f.row.deploymentChainId = 8453;
  assert.deepEqual(await resolveFirstBuyPayment(hash, f.q, [f.row], config, f.deps), { hash, cancelled: false });
  f.row.chainId = 4663; f.row.deploymentChainId = 4663;
  const reverse: Transaction = { ...f.row, hash: replacement, replacement: hash };
  assert.deepEqual(await resolveFirstBuyPayment(hash, f.q, [f.row, reverse], config, f.deps), { hash, cancelled: false });
  const broken = { ...f.row, firstBuyPayment: { transactionId: hash } as FirstBuyPaymentQuote };
  assert.deepEqual(await resolveFirstBuyPayment(hash, f.q, [broken], config, f.deps), { hash, cancelled: false });
});

function consumptionFixture() {
  const { q } = fixture();
  const attempt: FirstBuyPaymentAttempt = { quote: q, hash, actualOutput: "1000" };
  const plan = { creator: account, draft: { quoteAddress: q.toToken.address },
    openingValuation: syntheticOpeningValuation(q.toToken.address, "1", { chainId: 4663 }),
    firstBuy: { recipient: account, quoteAddress: q.toToken.address, amountIn: "1000" } } as LaunchPlan;
  const token = syntheticToken({ creator: account, quoteAddress: q.toToken.address, transactionHash: replacement,
    mode: "robinhood", deploymentChainId: 4663 });
  const verification = { status: "success" as const, hash, actualOutput: "1000", blockNumber: "10", blockHash };
  return { attempt, plan, token, verification };
}
test("only a first buy that exactly spends the verified conversion output can associate its launch", () => {
  const f = consumptionFixture();
  assert.equal(paymentMatchesLaunch(f.attempt, f.plan), true, "an expired quote remains usable after receipt verification");
  for (const change of [
    (f: ReturnType<typeof consumptionFixture>) => { f.attempt.actualOutput = null; },
    (f: ReturnType<typeof consumptionFixture>) => { f.plan.firstBuy = undefined; },
    (f: ReturnType<typeof consumptionFixture>) => { f.plan.firstBuy!.amountIn = "999"; },
    (f: ReturnType<typeof consumptionFixture>) => { f.plan.creator = other; },
    (f: ReturnType<typeof consumptionFixture>) => { f.plan.firstBuy!.recipient = other; },
    (f: ReturnType<typeof consumptionFixture>) => { f.plan.firstBuy!.quoteAddress = other; },
    (f: ReturnType<typeof consumptionFixture>) => { f.plan.draft.quoteAddress = other; },
    (f: ReturnType<typeof consumptionFixture>) => { f.plan.openingValuation!.chainId = 8453; },
  ]) {
    const changed = consumptionFixture(); change(changed);
    assert.equal(paymentMatchesLaunch(changed.attempt, changed.plan), false);
  }
});
test("registration consumes only its launch marker with matching account, pair and fresh canonical payment proof", () => {
  const f = consumptionFixture();
  assert.equal(registeredLaunchConsumesPayment(f.attempt, f.token, replacement, f.verification), false, "unassociated payment is retained");
  f.attempt.launchHash = replacement;
  assert.equal(registeredLaunchConsumesPayment(f.attempt, f.token, replacement, f.verification), true);
  for (const change of [
    (f: ReturnType<typeof consumptionFixture>) => { f.attempt.launchHash = hash; },
    (f: ReturnType<typeof consumptionFixture>) => { f.token.transactionHash = hash; },
    (f: ReturnType<typeof consumptionFixture>) => { f.token.creator = other; },
    (f: ReturnType<typeof consumptionFixture>) => { f.token.quoteAddress = other; },
    (f: ReturnType<typeof consumptionFixture>) => { f.token.mode = "base"; f.token.deploymentChainId = 8453; },
    (f: ReturnType<typeof consumptionFixture>) => { f.attempt.actualOutput = null; },
    (f: ReturnType<typeof consumptionFixture>) => { f.attempt.actualOutput = "999"; },
    (f: ReturnType<typeof consumptionFixture>) => { f.verification.hash = replacement; },
    (f: ReturnType<typeof consumptionFixture>) => { f.verification.actualOutput = "999"; },
    (f: ReturnType<typeof consumptionFixture>) => { f.verification.blockNumber = ""; },
    (f: ReturnType<typeof consumptionFixture>) => { f.verification.blockHash = "0x"; },
  ]) {
    const changed = consumptionFixture(); changed.attempt.launchHash = replacement; change(changed);
    assert.equal(registeredLaunchConsumesPayment(changed.attempt, changed.token, replacement, changed.verification), false);
  }
  for (const status of ["pending", "reverted"] as const)
    assert.equal(registeredLaunchConsumesPayment(f.attempt, f.token, replacement, { ...f.verification, status }), false);
});
test("launch repricing may change the marker but cannot substitute another payment fingerprint", () => {
  const f = consumptionFixture(), saved = structuredClone(f.attempt);
  saved.launchHash = hash;
  const repriced = { ...saved, launchHash: replacement };
  assert.equal(sameFirstBuyPayment(saved, repriced), true);
  assert.equal(registeredLaunchConsumesPayment(repriced, f.token, replacement, f.verification), true);
  for (const change of [
    (p: FirstBuyPaymentAttempt) => { p.hash = replacement; },
    (p: FirstBuyPaymentAttempt) => { p.actualOutput = "999"; },
    (p: FirstBuyPaymentAttempt) => { p.quote.account = other; },
    (p: FirstBuyPaymentAttempt) => { p.quote.transaction.data = "0x1234"; },
    (p: FirstBuyPaymentAttempt) => { p.quote.transactionId = replacement; },
  ]) {
    const changed = structuredClone(repriced); change(changed);
    assert.equal(sameFirstBuyPayment(saved, changed), false);
  }
});
