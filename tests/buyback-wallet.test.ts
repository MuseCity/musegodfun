import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi, hashTypedData, toHex, type Hash } from "viem";
import { assertBuybackStep, assertSameBuybackStep, assertBuybackRequest, transactionClient } from "../src/lib/wallet";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY, buybackAuthorizationTypedData, type BuybackStep, type BuybackBatch } from "../src/lib/buyback";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { STOCKS, type RuntimeConfig } from "../src/lib/config";
import { saveTransaction, transactions, updateTransaction, applyBuybackRecovery } from "../src/lib/transactions";

const treasury = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const config: RuntimeConfig = { mode: "base", chainId: 8453, treasury, writesEnabled: true, blockReason: null, securityProtocol: 1, signingPaused: false, controlRevision: 0 };
const burnConfig: RuntimeConfig = { ...config, mode: "robinhood", chainId: 4663, treasury: other };
const amount = 12345n;
function burn(): BuybackStep {
  return {
    batchId: "test-batch-001", kind: "burn", chainId: 4663, from: treasury,
    to: MUSEGOD_BUYBACK.tokenAddress,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MUSEGOD_BUYBACK.burnAddress, amount] }),
    value: "0", expiresAt: Date.now() + 60_000, amount: amount.toString(), stockAddress: STOCKS[0].address, nonce: 7,
  };
}
function approval(): BuybackStep {
  return { ...burn(), kind: "approval", chainId: 8453, to: STOCKS[0].address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RELAY_APPROVAL_PROXY, amount] }) };
}

test("buyback signing remains mainnet opt-in and requires the configured treasury EOA account", () => {
  const step = burn();
  assert.doesNotThrow(() => assertBuybackStep(step, burnConfig, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep(step, { ...burnConfig, writesEnabled: false }, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep(step, { ...burnConfig, mode: "fork", chainId: 31337 }, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep(step, burnConfig, other, Date.now(), treasury));
  assert.throws(() => assertBuybackStep({ ...step, from: other }, burnConfig, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep(step, { ...burnConfig, treasury: null }, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep({ ...step, expiresAt: 1 }, burnConfig, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep({ ...step, value: "1" }, burnConfig, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep({ ...step, nonce: undefined }, burnConfig, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep({ ...step, nonce: -1 }, burnConfig, treasury, Date.now(), treasury));
});

test("Robinhood signing can only transfer the exact batch amount of MUSEGOD to dead", () => {
  const step = burn();
  for (const changed of [
    { chainId: 8453 as const }, { to: STOCKS[0].address }, { amount: "12346" },
    { data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [other, amount] }) },
    { data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MUSEGOD_BUYBACK.burnAddress, amount] }) },
    { data: `${step.data}00` as const },
  ]) assert.throws(() => assertBuybackStep({ ...step, ...changed }, burnConfig, treasury, Date.now(), treasury));
});

test("Base buyback approvals bind whitelisted stock, exact amount and Relay spender", () => {
  const step = approval();
  assert.doesNotThrow(() => assertBuybackStep(step, config, treasury));
  for (const changed of [
    { to: MUSEGOD_BUYBACK.tokenAddress }, { chainId: 4663 as const }, { amount: "12346" },
    { data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [other, amount] }) },
    { data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RELAY_APPROVAL_PROXY, 2n ** 256n - 1n] }) },
    { data: `${step.data}00` as const },
  ]) assert.throws(() => assertBuybackStep({ ...step, ...changed }, config, treasury));
  const deposit: BuybackStep = { ...step, kind: "deposit", to: RELAY_DEPOSITORY, data: "0x12345678" };
  // Full deposit calldata validation is performed by the server; the wallet
  // adds target limits and exact equality with that freshly validated batch.
  assert.doesNotThrow(() => assertBuybackStep(deposit, config, treasury));
  assert.throws(() => assertBuybackStep({ ...deposit, to: other }, config, treasury));
});

test("fresh batch validation rejects changed destinations, amounts, accounts and calldata", () => {
  const step = burn();
  assert.doesNotThrow(() => assertSameBuybackStep(step, { ...step }));
  for (const changed of [
    { batchId: "different-batch" }, { kind: "deposit" as const }, { chainId: 8453 as const },
    { from: other }, { to: other }, { data: "0x12345678" as const },
    { amount: "1" }, { value: "1" }, { stockAddress: STOCKS[1].address }, { nonce: 8 },
  ] as Partial<BuybackStep>[]) assert.throws(() => assertSameBuybackStep(step, { ...step, ...changed }));
});

test("buyback provider transport rejects messages and any write differing from the fixed step", () => {
  const step = burn();
  const tx = { from: treasury, to: step.to, data: step.data, value: "0x0", chainId: toHex(step.chainId), nonce: toHex(step.nonce!) };
  assert.doesNotThrow(() => assertBuybackRequest({ method: "eth_sendTransaction", params: [tx] }, step));
  assert.doesNotThrow(() => assertBuybackRequest({ method: "eth_chainId" }, step));
  for (const method of ["personal_sign", "eth_sign", "eth_signTypedData_v4", "eth_sendRawTransaction", "wallet_sendCalls"])
    assert.throws(() => assertBuybackRequest({ method, params: [tx] }, step));
  for (const changed of [
    { to: other }, { from: other }, { value: "0x1" }, { data: "0x12345678" },
    { chainId: "0x2105" }, { authorizationList: [] }, { nonce: "0x8" }, { nonce: undefined },
  ]) assert.throws(() => assertBuybackRequest({ method: "eth_sendTransaction", params: [{ ...tx, ...changed }] }, step));
  assert.throws(() => transactionClient(1));
  assert.equal(transactionClient(4663).transport.url, "/api/chains/4663/rpc");
});

test("buyback pending and replacement records retain batch linkage across browser reloads on both chains", () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  try {
    const sourceHash = `0x${"a".repeat(64)}` as Hash;
    const burnHash = `0x${"b".repeat(64)}` as Hash;
    const replacement = `0x${"c".repeat(64)}` as Hash;
    saveTransaction({ hash: sourceHash, chainId: 8453, account: treasury, action: "buyback", batchId: "batch-a", buybackKind: "deposit", status: "pending", at: 1 });
    saveTransaction({ hash: burnHash, chainId: 4663, account: treasury, action: "buyback", batchId: "batch-a", buybackKind: "burn", nonce: 7, status: "pending", at: 2 });
    assert.equal(transactions().length, 2);
    updateTransaction(burnHash, 4663, { status: "replaced", replacement });
    saveTransaction({ hash: replacement, chainId: 4663, account: treasury, action: "buyback", batchId: "batch-a", buybackKind: "burn", nonce: 7, status: "pending", at: 3 });
    assert.equal(transactions().find((t) => t.hash === burnHash)?.replacement, replacement);
    assert.equal(transactions().find((t) => t.hash === burnHash)?.nonce, 7);
    assert.equal(transactions().find((t) => t.hash === replacement)?.batchId, "batch-a");
    assert.equal(transactions().find((t) => t.hash === sourceHash)?.status, "pending");
    saveTransaction({ hash: `0x${"d".repeat(64)}`, chainId: 4663, account: treasury, action: "buyback", batchId: "batch-a", buybackKind: "deposit", status: "pending", at: 4 });
    assert.equal(transactions().length, 3, "Invalid source transaction on Robinhood must not restore");
    const cancellationHash = `0x${"e".repeat(64)}` as Hash;
    const batch = { id: "batch-a", quote: { treasury }, cancellations: [{ kind: "burn", hash: cancellationHash,
      nonce: 7, status: "success", verifiedCanonical: false, blockHash: `0x${"f".repeat(64)}`, blockNumber: "10" }] } as unknown as BuybackBatch;
    assert.equal(applyBuybackRecovery(batch, "burn", cancellationHash), false);
    assert.equal(transactions().find((t) => t.hash === replacement)?.status, "pending", "Unverified cancellation must not release the local pending record");
    batch.cancellations![0].verifiedCanonical = true;
    assert.equal(applyBuybackRecovery(batch, "deposit", cancellationHash), false);
    assert.equal(applyBuybackRecovery(batch, "burn", cancellationHash), true);
    assert.equal(transactions().find((t) => t.hash === replacement)?.status, "cancelled");
    assert.equal(transactions().find((t) => t.hash === replacement)?.replacement, cancellationHash);
    assert.equal(transactions().find((t) => t.hash === sourceHash)?.status, "pending", "Cancellation only updates its original chain, batch, kind and nonce");
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("historical manual Relay burn uses current Robinhood controls and the original Base batch treasury", () => {
  const step = burn();
  assert.doesNotThrow(() => assertBuybackStep(step, burnConfig, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep(step, config, treasury, Date.now(), treasury), /controls/);
  assert.throws(() => assertBuybackStep(step, { ...burnConfig, writesEnabled: false }, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep(step, { ...burnConfig, signingPaused: true }, treasury, Date.now(), treasury));
  assert.throws(() => assertBuybackStep(step, burnConfig, treasury, Date.now(), other), /treasury/);
  assert.throws(() => assertBuybackStep(step, burnConfig, treasury), /treasury/);
  assert.throws(() => assertBuybackStep(step, { ...burnConfig, securityProtocol: undefined }, treasury, Date.now(), treasury), /controls/);
  const sourceStep = approval();
  assert.throws(() => assertBuybackStep(sourceStep, { ...config, writesEnabled: false }, treasury));
  assert.throws(() => assertBuybackStep(sourceStep, burnConfig, treasury));
});
