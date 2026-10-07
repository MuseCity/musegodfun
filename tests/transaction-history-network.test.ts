import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Hash } from "viem";
import { bundlerAbi } from "@whetstone-research/doppler-sdk/evm";
import { checkHistoryTransaction } from "../src/components/TransactionHistory";
import type { Transaction } from "../src/lib/transactions";
import { isUnresolvedFirstBuyClaim, saveTransaction, transactions, updateTransaction } from "../src/lib/transactions";
import { ROBINHOOD_BUNDLER } from "../src/lib/config";
import type { FirstBuyPaymentQuote, FirstBuyPaymentVerification } from "../src/lib/first-buy-payment";
import type { chainApi } from "../src/lib/api";
import type { RuntimeConfig } from "../src/lib/config";

const hash = `0x${"a".repeat(64)}` as Hash;
const blockHash = `0x${"b".repeat(64)}` as Hash;
function row(chainId = 8453, deploymentChainId?: 8453 | 4663): Transaction {
  return { hash, chainId, deploymentChainId, account: "0x1111111111111111111111111111111111111111",
    action: "launch", status: "pending", at: 1 };
}
function reader(chainId: number, patch: Record<string, unknown> = {}) {
  return {
    getChainId: async () => chainId,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 10n, blockHash }),
    getBlockNumber: async () => 11n,
    getBlock: async () => ({ number: 10n, hash: blockHash }),
    ...patch,
  } as unknown as NonNullable<Parameters<typeof checkHistoryTransaction>[1]>["client"];
}

test("a first-buy claim stays blocked until its cancellation or replacement is verified on the same network", () => {
  const token = "0x2222222222222222222222222222222222222222";
  const claim: Transaction = { ...row(31337, 4663), action: "claim", firstBuyClaim: { token, bundler: ROBINHOOD_BUNDLER,
    data: encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [token] }) } };
  const config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId"> = { chainId: 31337, mode: "fork", deploymentChainId: 4663 };
  for (const registered of [undefined, false, true]) {
    assert.equal(isUnresolvedFirstBuyClaim({ ...claim, status: "pending", registered }, token, claim.account, config), true);
    for (const status of ["cancelled", "replaced"] as const)
      assert.equal(isUnresolvedFirstBuyClaim({ ...claim, status, registered }, token, claim.account, config), registered !== true);
    for (const status of ["success", "failed"] as const)
      assert.equal(isUnresolvedFirstBuyClaim({ ...claim, status, registered }, token, claim.account, config), false);
  }
  assert.equal(isUnresolvedFirstBuyClaim(claim, token, claim.account, { ...config, deploymentChainId: 8453 }), false,
    "a same-address claim on another fork cannot block this network");
  assert.equal(isUnresolvedFirstBuyClaim({ ...claim, chainId: 4663 }, token, claim.account, config), false);
  assert.equal(isUnresolvedFirstBuyClaim(claim, ROBINHOOD_BUNDLER, claim.account, config), false);
  assert.equal(isUnresolvedFirstBuyClaim(claim, token, token, config), false);
  assert.equal(isUnresolvedFirstBuyClaim({ ...claim, firstBuyClaim: undefined }, token, claim.account, config), false);
});

test("history registration uses each row's chain rather than the displayed network", async () => {
  for (const [actual, deployment] of [[8453, undefined], [4663, undefined], [31337, 4663]] as const) {
    const calls: { chainId: number; path: string; body: unknown }[] = [], updates: Partial<Transaction>[] = [];
    await checkHistoryTransaction(row(actual, deployment), {
      client: reader(actual), read: async <T>(chainId: 8453 | 4663, path: string, body?: unknown) => {
        calls.push({ chainId, path, body }); return {} as T;
      }, update: (patch) => updates.push(patch),
    });
    assert.deepEqual(calls, [{ chainId: deployment ?? actual, path: "/launch/register", body: { hash } }]);
    assert.deepEqual(updates, [{ status: "success" }, { registered: true }]);
  }
});

test("wrong RPC, missing receipt and reorgs never register or submit a replacement launch", async () => {
  const calls: string[] = [], updates: Partial<Transaction>[] = [];
  const read: typeof chainApi = async <T>(_chainId: 8453 | 4663, path: string) => { calls.push(path); return {} as T; };
  const update = (patch: Partial<Transaction>) => updates.push(patch);
  await assert.rejects(checkHistoryTransaction(row(4663), { client: reader(8453), read, update }), /wrong network/);
  await assert.rejects(checkHistoryTransaction(row(), { client: reader(8453, {
    getTransactionReceipt: async () => { throw new Error("receipt unavailable"); },
  }), read, update }), /receipt unavailable/);
  assert.deepEqual(updates, []);
  for (const patch of [{ getBlockNumber: async () => 10n }, { getBlock: async () => ({ hash }) }]) {
    await checkHistoryTransaction(row(), { client: reader(8453, patch), read, update });
  }
  assert.deepEqual(updates, [{ status: "pending" }, { status: "pending" }]);
  assert.deepEqual(calls, []);
});

test("saved expired payment metadata is sent only to receipt verification after two confirmations", async () => {
  // This is a transport fixture; the API reader owns complete quote validation.
  const quote = Object.freeze({ chainId: 8453, expiresAt: 1 }) as FirstBuyPaymentQuote;
  const saved = { ...row(), action: "swap" as const, firstBuyPayment: quote };
  const calls: string[] = [], updates: Partial<Transaction>[] = [];
  const read: typeof chainApi = async <T>(chainId: 8453 | 4663, path: string, body?: unknown) => {
    assert.equal(chainId, 8453);
    assert.deepEqual(body, { quote, hash });
    calls.push(path);
    return { status: "success", hash, actualOutput: "100", blockNumber: "10", blockHash } as T;
  };
  await checkHistoryTransaction(saved, { client: reader(8453, { getBlockNumber: async () => 10n }),
    read, update: (patch) => updates.push(patch) });
  assert.deepEqual(calls, []);
  await checkHistoryTransaction(saved, { client: reader(8453), read, update: (patch) => updates.push(patch) });
  assert.deepEqual(calls, ["/first-buy/verify"]);
  assert.deepEqual(updates, [{ status: "pending", registered: false }, { status: "success", registered: true }]);
  assert.equal(quote.expiresAt, 1);
});

const claimToken = "0x2222222222222222222222222222222222222222";
const claimBundler = ROBINHOOD_BUNDLER;
const replacementHash = `0x${"c".repeat(64)}` as Hash;
function claimRow(): Transaction {
  return { ...row(), action: "claim", nonce: 7, firstBuyClaim: { token: claimToken, bundler: claimBundler,
    data: encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [claimToken] }) } };
}
function claimClient(saved: Transaction, patch: Record<string, unknown> = {}) {
  const log = { address: claimToken,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: claimBundler, to: saved.account } }),
    data: encodeAbiParameters([{ type: "uint256" }], [100n]) };
  return reader(saved.chainId, {
    getTransactionReceipt: async () => ({ transactionHash: saved.hash, status: "success", blockNumber: 10n, blockHash, logs: [log] }),
    getTransaction: async () => ({ hash: saved.hash, from: saved.account, to: claimBundler,
      input: saved.firstBuyClaim!.data, value: 0n, chainId: saved.chainId, nonce: 7, blockNumber: 10n, blockHash }),
    ...patch,
  });
}

test("lock claim recovery binds its scoped position, calldata and positive net Bundler transfer", async () => {
  const saved = claimRow(), updates: Partial<Transaction>[] = [];
  const read: typeof chainApi = async <T>(chainId: 8453 | 4663, path: string) => {
    assert.equal(chainId, 8453);
    assert.equal(path, `/first-buy-lock/${claimToken}`);
    return { recipient: saved.account, bundler: claimBundler, claimedAmount: "100" } as T;
  };
  await checkHistoryTransaction(saved, { client: claimClient(saved), read, update: (patch) => updates.push(patch) });
  assert.deepEqual(updates, [{ status: "success", registered: true }]);
  assert.equal(saved.status, "pending", "the captured input is not mutated");
});

test("a successful claim receipt without matching calldata, position or Transfer stays unresolved", async () => {
  const saved = claimRow(), updates: Partial<Transaction>[] = [];
  const read: typeof chainApi = async <T>() => ({ recipient: saved.account, bundler: claimBundler, claimedAmount: "100" }) as T;
  const update = (patch: Partial<Transaction>) => updates.push(patch);
  await assert.rejects(checkHistoryTransaction(saved, { client: claimClient(saved, {
    getTransaction: async () => ({ hash, from: saved.account, to: claimBundler, input: "0x12345678", value: 0n,
      chainId: 8453, nonce: 7, blockNumber: 10n, blockHash }),
  }), read, update }), /saved recipient and calldata/);
  await assert.rejects(checkHistoryTransaction(saved, { client: claimClient(saved, {
    getTransactionReceipt: async () => ({ transactionHash: hash, status: "success", blockNumber: 10n, blockHash, logs: [] }),
  }), read, update }), /net token receipt/);
  await assert.rejects(checkHistoryTransaction(saved, { client: claimClient(saved),
    read: async <T>() => ({ recipient: claimToken, bundler: claimBundler, claimedAmount: "100" }) as T, update }), /verified position/);
  assert.deepEqual(updates, []);
});

test("a claim cancellation releases its original nonce only after a canonical empty self-transfer", async () => {
  const saved = { ...claimRow(), status: "cancelled" as const, replacement: replacementHash };
  const updates: Partial<Transaction>[] = [];
  const client = reader(8453, {
    getTransactionReceipt: async () => ({ transactionHash: replacementHash, status: "success", blockNumber: 10n, blockHash, logs: [] }),
    getTransaction: async () => ({ hash: replacementHash, from: saved.account, to: saved.account, input: "0x", value: 0n,
      chainId: 8453, nonce: 7, blockNumber: 10n, blockHash }),
    getCode: async () => undefined,
  });
  const read: typeof chainApi = async () => { throw new Error("A cancellation cannot count as a claim"); };
  await checkHistoryTransaction(saved, { client: reader(8453, {
    getTransactionReceipt: async () => ({ transactionHash: replacementHash, status: "success", blockNumber: 10n, blockHash, logs: [] }),
    getBlockNumber: async () => 10n,
  }), read, update: (patch) => updates.push(patch) });
  assert.deepEqual(updates, [{ status: "cancelled", registered: false }]);
  await checkHistoryTransaction(saved, { client, read, update: (patch) => updates.push(patch) });
  assert.deepEqual(updates[1], { registered: true, nonce: 7 });
});

test("a replaced claim cannot clear pending proof using a different sender, nonce or delegated cancellation", async () => {
  const saved = { ...claimRow(), status: "cancelled" as const, replacement: replacementHash };
  const updates: Partial<Transaction>[] = [];
  const baseTx = { hash: replacementHash, from: saved.account, to: saved.account, input: "0x", value: 0n,
    chainId: 8453, nonce: 7, blockNumber: 10n, blockHash };
  const read: typeof chainApi = async () => { throw new Error("No claim request expected"); };
  const update = (patch: Partial<Transaction>) => updates.push(patch);
  for (const patch of [{ from: claimToken }, { nonce: 8 }]) {
    await assert.rejects(checkHistoryTransaction(saved, { client: reader(8453, {
      getTransactionReceipt: async () => ({ transactionHash: replacementHash, status: "success", blockNumber: 10n, blockHash, logs: [] }),
      getTransaction: async () => ({ ...baseTx, ...patch }),
    }), read, update }), /original nonce/);
  }
  await assert.rejects(checkHistoryTransaction(saved, { client: reader(8453, {
    getTransactionReceipt: async () => ({ transactionHash: replacementHash, status: "success", blockNumber: 10n, blockHash, logs: [] }),
    getTransaction: async () => baseTx, getCode: async () => "0xef0100",
  }), read, update }), /account code/);
  assert.deepEqual(updates, []);
});

test("an old RPC lookup cannot overwrite a newer wallet replacement or confirmed claim", async () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  try {
    for (const newer of [{ status: "cancelled" as const, replacement: replacementHash },
      { status: "success" as const, registered: true }]) {
      values.clear();
      const saved = claimRow();
      saveTransaction(saved);
      let release!: (value: unknown) => void, start!: () => void;
      const waiting = new Promise<unknown>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { start = resolve; });
      const checking = checkHistoryTransaction(saved, { client: reader(8453, {
        getTransactionReceipt: async () => { start(); return await waiting; },
        getBlock: async () => ({ hash }),
      }) });
      await started;
      updateTransaction(hash, 8453, newer);
      release({ transactionHash: hash, status: "success", blockNumber: 10n, blockHash, logs: [] });
      await checking;
      const final = transactions()[0];
      assert.equal(final.status, newer.status);
      if ("replacement" in newer) assert.equal(final.replacement, replacementHash);
      else assert.equal(final.registered, true);
      assert.deepEqual(final.firstBuyClaim, saved.firstBuyClaim);
    }
    values.clear();
    const launch = row();
    saveTransaction(launch);
    await checkHistoryTransaction(launch, { client: reader(8453), read: async <T>() => ({} as T) });
    assert.equal(transactions()[0].status, "success");
    assert.equal(transactions()[0].registered, true, "the lookup can advance its own successive verified updates");
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor); else Reflect.deleteProperty(globalThis, "localStorage");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("payment verification failure or changed canonical identity preserves its prior pending status", async () => {
  const saved = { ...row(4663), action: "swap" as const,
    firstBuyPayment: { chainId: 4663 } as FirstBuyPaymentQuote };
  const updates: Partial<Transaction>[] = [];
  const update = (patch: Partial<Transaction>) => updates.push(patch);
  await assert.rejects(checkHistoryTransaction(saved, { client: reader(4663),
    read: async () => { throw new Error("payment verification unavailable"); }, update }), /verification unavailable/);
  const read: typeof chainApi = async <T>() => ({ status: "success", hash, actualOutput: "100", blockNumber: "10",
    blockHash: hash } satisfies FirstBuyPaymentVerification) as T;
  await assert.rejects(checkHistoryTransaction(saved, { client: reader(4663), read, update }), /receipt changed/);
  assert.deepEqual(updates, []);
});
