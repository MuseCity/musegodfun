import test from "node:test";
import assert from "node:assert/strict";
import {
  keccak256, TransactionReceiptNotFoundError, TransactionNotFoundError,
  type Address, type Hash, type PublicClient,
} from "viem";
import { MUSEGOD } from "../src/lib/musegod";
import { recoverMusegodTransaction } from "../src/lib/musegod-recovery";
import { transactions, transactionMatchesConfig, validMusegodRecovery, type Transaction } from "../src/lib/transactions";

const account = "0x1111111111111111111111111111111111111111" as Address;
const oldHash = `0x${"a".repeat(64)}` as Hash;
const newHash = `0x${"b".repeat(64)}` as Hash;
const blockHash = (number: bigint) => `0x${number.toString(16).padStart(64, "0")}` as Hash;
const pending = (): Transaction => ({
  hash: oldHash, chainId: 4663, account, action: "swap", status: "pending", at: 1,
  nonce: 7, musegodRecovery: {
    to: MUSEGOD.router, dataHash: keccak256("0x1234"), value: "5", fromBlock: "10",
  },
});
const chainTransaction = (hash = newHash, at = 12n) => ({
  hash, from: account, to: MUSEGOD.router, input: "0x1234", value: 5n, nonce: 7,
  type: "eip1559", authorizationList: undefined as unknown[] | undefined,
  blockNumber: at, blockHash: blockHash(at),
});
function fixture() {
  const row = pending();
  const rows = new Map<Hash, Transaction>([[oldHash, row]]), saved: Transaction[] = [];
  const scanBlocks: bigint[] = [];
  let replacement = chainTransaction();
  let oldTransaction: ReturnType<typeof chainTransaction> | null = null;
  let originalReceipt = false, rpcError = false, receiptMissing = false, reorg = false;
  let head = 30n, minedNonce = 8, chainId = 4663, code: `0x${string}` | undefined = undefined;
  let active = 0, maxActive = 0, transactionCountReads = 0, includeReplacement = true;
  const client = {
    getChainId: async () => chainId,
    getTransaction: async ({ hash }: { hash: Hash }) => {
      if (hash === oldHash && oldTransaction) return oldTransaction;
      if (hash === newHash) return replacement;
      throw new TransactionNotFoundError({ hash });
    },
    getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
      if (rpcError) throw new Error("RPC network timeout");
      if ((hash === oldHash && !originalReceipt) || receiptMissing) throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: hash, blockNumber: replacement.blockNumber,
        blockHash: blockHash(replacement.blockNumber), status: "success" };
    },
    getTransactionCount: async (args: { blockTag: string }) => {
      transactionCountReads++; assert.equal(args.blockTag, "latest"); return minedNonce;
    },
    getBlockNumber: async () => head,
    getCode: async () => code,
    getBlock: async ({ blockNumber, includeTransactions }: { blockNumber: bigint; includeTransactions?: boolean }) => {
      if (includeTransactions) {
        active++; maxActive = Math.max(maxActive, active); scanBlocks.push(blockNumber);
        await Promise.resolve(); active--;
      }
      return { number: blockNumber,
        hash: !includeTransactions && reorg && blockNumber === replacement.blockNumber ? blockHash(999n) : blockHash(blockNumber),
        parentHash: blockHash(blockNumber - 1n),
        transactions: includeTransactions && includeReplacement && blockNumber === replacement.blockNumber ? [replacement] : [],
      };
    },
  } as unknown as PublicClient;
  const persist = (next: Transaction) => { rows.set(next.hash, next); saved.push(next); };
  return { row, rows, saved, client, persist, scanBlocks,
    replacement: (patch: Partial<typeof replacement>) => { replacement = { ...replacement, ...patch }; },
    oldTransaction: (value: typeof oldTransaction) => { oldTransaction = value; },
    originalReceipt: () => { originalReceipt = true; },
    rpcError: () => { rpcError = true; }, missingReceipt: () => { receiptMissing = true; },
    reorg: () => { reorg = true; }, head: (value: bigint) => { head = value; },
    minedNonce: (value: number) => { minedNonce = value; }, wrongChain: () => { chainId = 8453; },
    code: (value: typeof code) => { code = value; }, noReplacement: () => { includeReplacement = false; },
    maxActive: () => maxActive, countReads: () => transactionCountReads,
  };
}

test("a canonical exact same-nonce repricing links the old hash and retains the MUSEGOD action", async () => {
  const f = fixture();
  await recoverMusegodTransaction(f.row, f.client, f.persist);
  assert.equal(f.rows.get(oldHash)?.status, "replaced");
  assert.equal(f.rows.get(oldHash)?.replacement, newHash);
  assert.equal(f.rows.get(newHash)?.status, "success");
  assert.equal(f.rows.get(newHash)?.action, "swap");
  assert.equal(f.rows.get(newHash)?.nonce, 7);
  assert.equal(f.rows.get(newHash)?.musegodRecovery?.checkedBlock, "12");
  const writes = f.saved.length;
  await recoverMusegodTransaction(f.rows.get(oldHash)!, f.client, f.persist);
  await recoverMusegodTransaction(f.rows.get(newHash)!, f.client, f.persist);
  assert.equal(f.rows.size, 2, "Restarted checks cannot create duplicate records");
  assert.equal(f.rows.get(oldHash)?.status, "replaced");
  assert.equal(f.saved.length, writes + 1, "The original link remains settled and only the receipt row is rechecked");
});

test("only a canonical ordinary empty zero-value self transfer is classified as cancelled", async () => {
  const f = fixture();
  f.replacement({ to: account, input: "0x", value: 0n });
  await recoverMusegodTransaction(f.row, f.client, f.persist);
  assert.equal(f.rows.get(oldHash)?.status, "cancelled");
  assert.equal(f.rows.get(newHash)?.action, "recovered");
  assert.equal(f.rows.get(newHash)?.musegodRecovery, undefined);
  const delegated = fixture();
  delegated.replacement({ to: account, input: "0x", value: 0n });
  delegated.code("0xef01001111");
  await recoverMusegodTransaction(delegated.row, delegated.client, delegated.persist);
  assert.equal(delegated.rows.get(oldHash)?.status, "replaced", "An existing delegation is not an ordinary cancellation");
});

test("changed calldata/value/destination or new authorization cannot be credited as a MUSEGOD repricing", async () => {
  for (const patch of [
    { input: "0xabcd" }, { value: 6n }, { to: MUSEGOD.token },
    { authorizationList: [{}] },
  ]) {
    const f = fixture(); f.replacement(patch);
    await recoverMusegodTransaction(f.row, f.client, f.persist);
    assert.equal(f.rows.get(oldHash)?.status, "replaced");
    assert.equal(f.rows.get(newHash)?.action, "recovered");
    assert.equal(f.rows.get(newHash)?.musegodRecovery, undefined);
  }
  const authorizationCancel = fixture();
  authorizationCancel.replacement({ to: account, input: "0x", value: 0n, type: "eip7702", authorizationList: [{}] });
  await recoverMusegodTransaction(authorizationCancel.row, authorizationCancel.client, authorizationCancel.persist);
  assert.equal(authorizationCancel.rows.get(oldHash)?.status, "replaced");
});

test("wrong sender or nonce never matches the tracked MUSEGOD transaction", async () => {
  for (const patch of [{ from: MUSEGOD.weth }, { nonce: 8 }]) {
    const f = fixture(); f.replacement(patch);
    await recoverMusegodTransaction(f.row, f.client, f.persist);
    assert.equal(f.rows.size, 1);
    assert.equal(f.rows.get(oldHash)?.status, "pending");
  }
});

test("missing nonce is learned only from the actual old transaction and is never guessed from account counts", async () => {
  const unavailable = fixture(); delete unavailable.row.nonce;
  await recoverMusegodTransaction(unavailable.row, unavailable.client, unavailable.persist);
  assert.equal(unavailable.saved.length, 0);
  assert.equal(unavailable.countReads(), 0);
  assert.equal(unavailable.scanBlocks.length, 0);
  const known = fixture(); delete known.row.nonce;
  known.oldTransaction(chainTransaction(oldHash));
  await recoverMusegodTransaction(known.row, known.client, known.persist);
  assert.equal(known.saved[0].nonce, 7);
  assert.equal(known.rows.get(oldHash)?.replacement, newHash);
  const mismatch = fixture(); delete mismatch.row.nonce;
  mismatch.oldTransaction({ ...chainTransaction(oldHash), input: "0xabcd" });
  await recoverMusegodTransaction(mismatch.row, mismatch.client, mismatch.persist);
  assert.equal(mismatch.saved.length, 0);
});

test("scans require a missing original receipt and an already mined account nonce", async () => {
  const notMined = fixture(); notMined.minedNonce(7);
  await recoverMusegodTransaction(notMined.row, notMined.client, notMined.persist);
  assert.equal(notMined.scanBlocks.length, 0);
  const receipt = fixture(); receipt.originalReceipt();
  await recoverMusegodTransaction(receipt.row, receipt.client, receipt.persist);
  assert.equal(receipt.rows.get(oldHash)?.status, "success");
  assert.equal(receipt.scanBlocks.length, 0);
  const rpc = fixture(); rpc.rpcError();
  await assert.rejects(() => recoverMusegodTransaction(rpc.row, rpc.client, rpc.persist), /timeout/);
  assert.equal(rpc.scanBlocks.length, 0);
  assert.equal(rpc.saved.length, 0);
});

test("replacement receipt needs two blocks and a canonical hash before any link or success is persisted", async () => {
  const unconfirmed = fixture(); unconfirmed.head(12n);
  await recoverMusegodTransaction(unconfirmed.row, unconfirmed.client, unconfirmed.persist);
  assert.equal(unconfirmed.rows.size, 1);
  assert.equal(unconfirmed.rows.get(oldHash)?.status, "pending");
  const reorg = fixture(); reorg.reorg();
  await recoverMusegodTransaction(reorg.row, reorg.client, reorg.persist);
  assert.equal(reorg.rows.size, 1);
  assert.equal(reorg.rows.get(oldHash)?.replacement, undefined);
  assert.equal(reorg.rows.get(oldHash)?.status, "pending");
  const lagging = fixture(); lagging.missingReceipt();
  await recoverMusegodTransaction(lagging.row, lagging.client, lagging.persist);
  assert.equal(lagging.rows.size, 1);
  assert.equal(lagging.rows.get(oldHash)?.status, "pending");
});

test("a reorg of the original receipt clears scan progress and retains a pending record", async () => {
  const f = fixture(); f.originalReceipt(); f.reorg();
  f.row.status = "success"; f.row.musegodRecovery!.checkedBlock = "12";
  await recoverMusegodTransaction(f.row, f.client, f.persist);
  assert.equal(f.rows.get(oldHash)?.status, "pending");
  assert.equal(f.rows.get(oldHash)?.musegodRecovery?.checkedBlock, undefined);
  assert.equal(f.scanBlocks.length, 0);
});

test("each round scans at most 16 blocks in four-call batches and restart resumes the stored cursor", async () => {
  const f = fixture(); f.noReplacement(); f.head(50n);
  await recoverMusegodTransaction(f.row, f.client, f.persist);
  assert.deepEqual(f.scanBlocks, Array.from({ length: 16 }, (_, index) => 10n + BigInt(index)));
  assert.equal(f.maxActive(), 4);
  assert.equal(f.rows.get(oldHash)?.musegodRecovery?.checkedBlock, "25");
  const restarted = JSON.parse(JSON.stringify(f.rows.get(oldHash))) as Transaction;
  f.replacement({ blockNumber: 28n, blockHash: blockHash(28n) });
  // A restarted pass has no in-memory state; discovery is driven by the row.
  const nextScans: bigint[] = [];
  const restartedClient = { ...f.client, getBlock: async (args: { blockNumber: bigint; includeTransactions?: boolean }) => {
    if (args.includeTransactions) nextScans.push(args.blockNumber);
    return { number: args.blockNumber, hash: blockHash(args.blockNumber), parentHash: blockHash(args.blockNumber - 1n),
      transactions: args.includeTransactions && args.blockNumber === 28n ? [chainTransaction(newHash, 28n)] : [] };
  } } as unknown as PublicClient;
  await recoverMusegodTransaction(restarted, restartedClient, f.persist);
  assert.equal(nextScans[0], 26n);
  assert(nextScans.length <= 16);
  assert.equal(f.rows.get(oldHash)?.replacement, newHash);
});

test("a finished unsuccessful scan resets its cursor so later canonical reorg data can be found", async () => {
  const f = fixture(); f.noReplacement(); f.head(12n);
  await recoverMusegodTransaction(f.row, f.client, f.persist);
  assert.equal(f.rows.get(oldHash)?.musegodRecovery?.checkedBlock, "11");
  await recoverMusegodTransaction(f.rows.get(oldHash)!, f.client, f.persist);
  assert.equal(f.rows.get(oldHash)?.musegodRecovery?.checkedBlock, undefined);
  assert.equal(f.rows.get(oldHash)?.status, "pending");
});

test("recovery is read-only, respects the RPC chain and cannot reinterpret legacy/buyback metadata", async () => {
  const wrong = fixture(); wrong.wrongChain();
  await assert.rejects(() => recoverMusegodTransaction(wrong.row, wrong.client, wrong.persist), /wrong network/);
  assert.equal(wrong.saved.length, 0);
  for (const action of ["launch", "buyback", "recovered"] as const) {
    const f = fixture(); f.row.action = action;
    await recoverMusegodTransaction(f.row, f.client, f.persist);
    assert.equal(f.saved.length, 0);
    assert.equal(f.scanBlocks.length, 0);
  }
  const fork = { ...pending(), chainId: 31337, deploymentChainId: 4663 as const };
  assert(validMusegodRecovery(fork));
  assert(!transactionMatchesConfig(fork, { mode: "fork", chainId: 31337, deploymentChainId: 8453 }));
});

test("browser parsing preserves legacy rows and discards only malformed MUSEGOD recovery metadata", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const legacy = { ...pending(), action: "launch" as const, musegodRecovery: undefined };
  const invalidRows = [
    { to: MUSEGOD.token }, { dataHash: "0x1" }, { value: -1 }, { value: "-1" },
    { fromBlock: 10 }, { fromBlock: "-1" }, { checkedBlock: "9" }, { checkedBlock: "bad" },
  ].map((patch, index) => ({ ...pending(), hash: blockHash(BigInt(index + 100)),
    musegodRecovery: { ...pending().musegodRecovery!, ...patch },
  }));
  const good = pending(), badNonce = { ...pending(), hash: blockHash(500n), nonce: "7" };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => JSON.stringify([legacy, good, badNonce, ...invalidRows]),
  } });
  try {
    const loaded = transactions();
    assert.equal(loaded.length, 3 + invalidRows.length);
    assert.equal(loaded[0].action, "launch");
    assert.equal(loaded[0].musegodRecovery, undefined);
    assert.deepEqual(loaded[1].musegodRecovery, good.musegodRecovery);
    assert.equal(loaded[2].nonce, undefined);
    assert(loaded.slice(3).every((row) => row.musegodRecovery === undefined));
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
