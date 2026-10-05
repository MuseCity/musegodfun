import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi, type Hash } from "viem";
import { BuybackBatchService } from "../server/buyback-batches";
import { BuybackError, BuybackReader } from "../server/buyback";
import { STOCKS, type RuntimeConfig } from "../src/lib/config";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";

const treasury = "0x1111111111111111111111111111111111111111";
const config: RuntimeConfig = { mode: "base", chainId: 8453, treasury, writesEnabled: true, blockReason: null };
const hash = (character: string) => `0x${character.repeat(64)}` as Hash;
const id = hash("a"), oldHash = hash("b"), newHash = hash("c"), sourceHash = hash("d"), destinationHash = hash("e"), blockHash = hash("f");
const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MUSEGOD_BUYBACK.burnAddress, 100n] });
function fixture() {
  const batch: any = {
    id, quote: { treasury, stockAddress: STOCKS[0].address, minimumOut: "99", amountIn: "1000000", expiresAt: Date.now() + 60_000 },
    status: "burned", nextStep: null, createdAt: Date.now(), updatedAt: Date.now(),
    receivedAmount: "100", burnedAmount: "100", hashes: { burn: newHash },
    steps: { burn: { batchId: id, kind: "burn", chainId: 4663, from: treasury, to: MUSEGOD_BUYBACK.tokenAddress,
      data, value: "0", expiresAt: Date.now() + 60_000, amount: "100", stockAddress: STOCKS[0].address, nonce: 7 } },
    nonces: { burn: 7 }, proofs: {}, orderId: hash("1"), metadata: hash("2"),
    fundingSource: "treasury_allocation", claimHashes: [],
  };
  const rows = [batch];
  const saves: any[] = [];
  const transactions = new Map<string, any>();
  const receipts = new Map<string, any>();
  let networkReads = 0;
  let accountCode: Hash | "0x" = "0x";
  const codeReads: any[] = [];
  for (const txHash of [oldHash, newHash]) transactions.set(txHash, {
    hash: txHash, from: treasury, to: MUSEGOD_BUYBACK.tokenAddress, input: data, value: 0n, nonce: 7,
  });
  const receipt = (txHash: Hash) => ({ transactionHash: txHash, status: "success", blockHash, blockNumber: 10n, logs: [] });
  receipts.set(newHash, receipt(newHash));
  const client = (chain: number) => ({
    getChainId: async () => { networkReads++; return chain; },
    getTransaction: async ({ hash }: { hash: string }) => transactions.get(hash),
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const value = receipts.get(hash); if (!value) throw new Error("receipt unavailable"); return value;
    },
    getBlock: async () => ({ hash: blockHash }),
    getBlockNumber: async () => 11n,
    getCode: async (request: any) => { codeReads.push(request); return accountCode; },
  });
  const base = client(8453), robinhood = client(4663);
  const store = {
    getBuybackBatch: async (batchId: string) => structuredClone(rows.find((row) => row.id === batchId)),
    listBuybackBatches: async () => structuredClone(rows),
    saveBuybackBatch: async (value: any) => {
      saves.push(structuredClone(value));
      const index = rows.findIndex((row) => row.id === value.id);
      if (index < 0) rows.push(structuredClone(value)); else rows[index] = structuredClone(value);
    },
  };
  const service = new BuybackBatchService({} as BuybackReader, store, base as any, config, {
    robinhoodClient: robinhood as any,
    fetch: async () => { throw new Error("No live network in a security regression test"); },
  });
  return { batch, rows, saves, transactions, receipts, receipt, service, networkReads: () => networkReads,
    setCode: (code: Hash | "0x") => { accountCode = code; }, codeReads };
}
const hasCode = (code: string) => (error: unknown) => error instanceof BuybackError && error.code === code;

test("unsigned public preparation cannot reach chain/quote reads or create an active batch", async () => {
  const f = fixture();
  await assert.rejects(f.service.prepare({ stockAddress: STOCKS[0].address, amount: "0.01" }), hasCode("AUTHORIZATION_REQUIRED"));
  assert.equal(f.saves.length, 0);
  assert.equal(f.networkReads(), 0);
});

test("a late original transaction hash cannot replace a canonical confirmed repriced hash", async () => {
  const f = fixture();
  await assert.rejects(f.service.track(id, "burn", oldHash), hasCode("TRANSACTION_ALREADY_CONFIRMED"));
  assert.equal(f.rows[0].hashes.burn, newHash);
  assert.equal(f.saves.length, 0, "Do not persist the stale hash before canonical replacement checks");
});

test("a transaction already attributed to another batch cannot increase this batch's accounting", async () => {
  const f = fixture();
  f.batch.hashes = {};
  f.rows.push({ ...structuredClone(f.batch), id: hash("3"), hashes: { burn: oldHash } });
  await assert.rejects(f.service.track(id, "burn", oldHash), hasCode("HASH_ALREADY_USED"));
  assert.equal(f.saves.length, 0);
});

test("a destination reorg clears currently verified received and burned amounts and disables another burn", async () => {
  const f = fixture();
  f.batch.hashes = { deposit: sourceHash, burn: newHash };
  f.batch.destinationHash = destinationHash;
  f.batch.proofs.destination = { hash: destinationHash, blockHash, blockNumber: "10" };
  f.receipts.set(sourceHash, f.receipt(sourceHash));
  // The once-confirmed destination receipt is absent from the canonical chain.
  const result = await f.service.reconcile(id);
  assert.equal(result.status, "reorg");
  assert.equal(result.nextStep, null);
  assert.equal(result.receivedAmount, "0");
  assert.equal(result.burnedAmount, "0");
});

test("zero-value self-transfers with delegated code cannot release the batch nonce as cancellation", async () => {
  const f = fixture();
  f.batch.hashes = {};
  f.transactions.set(oldHash, { from: treasury, to: treasury, input: "0x", value: 0n, nonce: 7 });
  f.receipts.set(oldHash, f.receipt(oldHash));
  f.setCode(`0xef0100${"2".repeat(40)}`);
  await assert.rejects(f.service.track(id, "burn", oldHash), hasCode("UNVERIFIED_CANCELLATION"));
  assert.deepEqual(f.codeReads, [{ address: treasury, blockNumber: 10n }], "Cancellation checks historical receipt-block code, not only current code");
  assert.equal(f.saves.length, 0);
});

test("self-transfer cancellations reject EIP-7702 authorizations and any emitted receipt logs", async () => {
  for (const modification of ["type", "authorizationList", "logs"]) {
    const f = fixture();
    f.batch.hashes = {};
    const transaction: any = { from: treasury, to: treasury, input: "0x", value: 0n, nonce: 7 };
    const receipt: any = f.receipt(oldHash);
    if (modification === "type") transaction.type = "eip7702";
    if (modification === "authorizationList") transaction.authorizationList = [{ address: treasury }];
    if (modification === "logs") receipt.logs = [{ address: STOCKS[0].address, topics: [], data: "0x" }];
    f.transactions.set(oldHash, transaction); f.receipts.set(oldHash, receipt);
    await assert.rejects(f.service.track(id, "burn", oldHash), hasCode("UNVERIFIED_CANCELLATION"));
    assert.equal(f.saves.length, 0);
  }
});
