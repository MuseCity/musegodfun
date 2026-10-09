import test from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, custom, toHex, encodeFunctionData, erc20Abi, type Hash } from "viem";
import { assetsFor, contractsFor, STOCKS, type RuntimeConfig } from "../src/lib/config";
import { assertSigningEnabled, launchSchema, restoreDraft } from "../src/lib/validation";
import { RELAY_APPROVAL_PROXY, type BuybackStep } from "../src/lib/buyback";
import { walletChain, assertBuybackStep } from "../src/lib/wallet";
import { saveTransaction, transactions, transactionMatchesConfig, type Transaction } from "../src/lib/transactions";

const account = "0x1111111111111111111111111111111111111111";
const robinhood: RuntimeConfig = {
  mode: "robinhood", chainId: 4663, deploymentChainId: 4663,
  treasury: account, writesEnabled: true, blockReason: null,
};
const fork: RuntimeConfig = { ...robinhood, mode: "fork", chainId: 31337 };

test("Robinhood signing uses its active chain and existing opt-in gate", async () => {
  assert.doesNotThrow(() => assertSigningEnabled(robinhood));
  assert.doesNotThrow(() => assertSigningEnabled(fork));
  for (const changed of [
    { writesEnabled: false }, { treasury: null }, { chainId: 8453 },
    { deploymentChainId: 8453 as const }, { mode: "base" as const },
  ]) assert.throws(() => walletChain({ ...robinhood, ...changed }));
  assert.equal(walletChain(fork).id, 31337);
  assert.match(walletChain(fork).name, /Robinhood Chain local fork/);

  // This provider records JSON-RPC in memory. No wallet or network is contacted.
  const requests: { method: string; params?: unknown }[] = [];
  let providerChainId = 4663;
  const expectedHash = `0x${"a".repeat(64)}` as Hash;
  const wallet = createWalletClient({
    account,
    chain: walletChain(robinhood),
    transport: custom({ request: async (request) => {
      requests.push(request);
      if (request.method === "eth_chainId") return toHex(providerChainId);
      if (request.method === "eth_sendTransaction") return expectedHash;
      throw new Error(`Unexpected wallet method: ${request.method}`);
    } }),
  });
  assert.equal(await wallet.sendTransaction({ to: contractsFor(robinhood).airlock, data: "0x12345678", value: 0n }), expectedHash);
  const submitted = (requests.find((request) => request.method === "eth_sendTransaction")?.params as Record<string, string>[])[0];
  assert.equal(wallet.chain.id, 4663);
  assert.equal(submitted.to.toLowerCase(), contractsFor(robinhood).airlock.toLowerCase());
  assert.notEqual(submitted.to.toLowerCase(), contractsFor({ mode: "base" }).airlock.toLowerCase());
  providerChainId = 8453;
  await assert.rejects(() => wallet.sendTransaction({ to: contractsFor(robinhood).airlock, data: "0x12345678", value: 0n }));
  assert.equal(requests.filter((request) => request.method === "eth_sendTransaction").length, 1,
    "A provider on Base must not receive the Robinhood transaction");
});

test("draft restoration stays on the active deployment and discards custom opening valuations", () => {
  const asset = assetsFor(robinhood)[0];
  const savedRobinhood = JSON.stringify({ name: "Saved RH draft", quoteAddress: assetsFor(robinhood).find((a) => a.ticker === "NVDA")!.address });
  assert.equal(restoreDraft(savedRobinhood).quoteAddress, JSON.parse(savedRobinhood).quoteAddress, "An initial render before config arrives must not discard the saved Robinhood pair");
  assert.equal(restoreDraft(savedRobinhood, robinhood).quoteAddress, JSON.parse(savedRobinhood).quoteAddress);
  const saved = JSON.stringify({ name: "Saved draft", quoteAddress: STOCKS[0].address, openingCap: "100" });
  assert.equal(restoreDraft(saved, robinhood).quoteAddress, asset.address);
  assert.equal(restoreDraft(saved, robinhood).name, "Saved draft");
  assert.equal("openingCap" in restoreDraft(saved, robinhood), false);
  assert.equal(restoreDraft(saved, { mode: "base" }).quoteAddress, STOCKS[0].address);
  assert.equal(restoreDraft(null, fork).quoteAddress, asset.address);
  const input = { ...restoreDraft(null, robinhood), name: "Test asset", symbol: "TEST" };
  assert.equal(launchSchema.parse(input).quoteAddress, asset.address);
  assert.equal(launchSchema.parse({ ...input, quoteAddress: STOCKS[0].address }).quoteAddress, STOCKS[0].address);
  assert.throws(() => launchSchema.parse({ ...input, quoteAddress: STOCKS[0].address, openingCap: "1.000000001" }));
  assert.throws(() => launchSchema.parse({ ...input, openingCap: `1.${"0".repeat(asset.decimals)}1` }));
});

test("Robinhood actions persist while Base and Robinhood forks keep separate recovery scopes", () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  try {
    for (const [index, action] of (["launch", "approval", "swap", "claim"] as const).entries()) {
      saveTransaction({ hash: `0x${String(index + 1).repeat(64)}`, chainId: 4663, account,
        action, status: "pending", at: index + 1 });
    }
    assert.equal(transactions().length, 4);
    assert(transactions().every((record) => transactionMatchesConfig(record, robinhood)));
    const legacyFork: Transaction = { hash: `0x${"b".repeat(64)}`, chainId: 31337, account, action: "launch", status: "pending", at: 5 };
    const robinhoodFork: Transaction = { ...legacyFork, hash: `0x${"c".repeat(64)}`, deploymentChainId: 4663, at: 6 };
    saveTransaction(legacyFork);
    saveTransaction(robinhoodFork);
    assert.equal(transactions().length, 6);
    assert.equal(transactionMatchesConfig(legacyFork, fork), false);
    assert.equal(transactionMatchesConfig(robinhoodFork, fork), true);
    assert.equal(transactionMatchesConfig(legacyFork, { ...fork, deploymentChainId: 8453 }), true);
    assert.equal(transactionMatchesConfig(robinhoodFork, { ...fork, deploymentChainId: 8453 }), false);
    assert.equal(transactionMatchesConfig(robinhoodFork, robinhood), false);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("legacy Base bridge signing does not become available in Robinhood mode", () => {
  const step: BuybackStep = { batchId: "historical-base-approval", kind: "approval", chainId: 8453, from: account,
    stockAddress: STOCKS[0].address, to: STOCKS[0].address, amount: "100", nonce: 7, value: "0", expiresAt: Date.now() + 60_000,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RELAY_APPROVAL_PROXY, 100n] }) };
  const controls: Pick<RuntimeConfig, "securityProtocol" | "signingPaused" | "controlRevision"> = { securityProtocol: 1, signingPaused: false, controlRevision: 1 };
  assert.throws(() => assertBuybackStep(step, { ...robinhood, ...controls }, account), /transaction chain controls/);
  assert.doesNotThrow(() => assertBuybackStep(step, { ...robinhood, ...controls, mode: "base", chainId: 8453, deploymentChainId: 8453 }, account));
});
