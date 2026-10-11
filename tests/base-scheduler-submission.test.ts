import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareNativeCandidateBudget } from "../server/base-native-candidates";
import { submitBaseFeeBatch, baseFeeTransaction, assertBaseNoUnknown, baseCanonicalGasSpent } from "../scripts/base-buyback-keeper";
import { BASE_BUYBACK_PROTOCOL, type BaseFeeBatch } from "../src/lib/base-buyback";

// Local deterministic signing only. No network or production wallet is used.
const account = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const collector = "0x1111111111111111111111111111111111111111";
const hash = `0x${"12".repeat(32)}` as Hex;
function prepared(id: string): BaseFeeBatch {
  const task: BaseFeeBatch = { id, protocol: BASE_BUYBACK_PROTOCOL, kind: "claim", status: "unknown", sourceChainId: 8453,
    destinationChainId: 4663, collector, poolId: hash, amountIn: "0", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0",
    claimHashes: [], createdAt: 1, updatedAt: 1 };
  return { ...task, journal: { caller: account.address, nonce: 7, to: collector, hash, dataHash: keccak256(baseFeeTransaction(task).data),
      gasLimit: "100000", maxFeePerGas: "100", signedAt: 1 },
    gasReservation: { executionWei: "10000000", l1Wei: "1000", operatorWei: "0", totalWei: "10001000",
      unsignedHash: hash, unsignedBytes: 100, blockNumber: "1", blockHash: hash } };
}
const sign = (task: BaseFeeBatch) => account.signTransaction({ ...baseFeeTransaction(task), chainId: 8453, nonce: 7,
  gas: 100000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, type: "eip1559" });

test("four advisory scheduling races during the actual before-broadcast boundary still allow one source submission", async () => {
  let winners = 0, broadcasts = 0, stored: any = null;
  const store = { getBuybackBatch: async () => null, compareAndSetBuybackAudit: async (row: any) => {
    if (stored) return false; stored = row; winners++; return true;
  } };
  const task = prepared("composed-cas-race");
  const result = await submitBaseFeeBatch(task, { sign: () => sign(task), persistLocal: async () => {}, persistPublic: async () => {},
    beforeBroadcast: async () => {
      const reads = await Promise.all(Array.from({ length: 4 }, () => prepareNativeCandidateBudget(store, ["old-dust", "new-fees"], {}, Date.now() + 10000)));
      assert(reads.every(budget => [...budget.allocations!.values()].reduce((sum, value) => sum + value, 0) === 8));
    }, broadcast: async raw => { broadcasts++; return keccak256(raw); } });
  assert.equal(winners, 1); assert.equal(broadcasts, 1); assert.equal(result.status, "broadcast");
  assert.throws(() => assertBaseNoUnknown([result], account.address), /unresolved/, "actual attempted submission still reserves the nonce until canonical reconciliation");
  assert.equal(baseCanonicalGasSpent([result], account.address), 10001000n);
});

test("a real pre-broadcast gate failure durably abandons only that signature; the next task can submit the same nonce", async () => {
  const local = new Map<string, BaseFeeBatch>(), canonical = new Map<string, BaseFeeBatch>(); let broadcasts = 0;
  const persistLocal = async (row: BaseFeeBatch) => { local.set(row.id, structuredClone(row)); };
  const persistPublic = async (row: BaseFeeBatch) => { canonical.set(row.id, structuredClone(row)); };
  const first = prepared("composed-gate-failure");
  const abandoned = await submitBaseFeeBatch(first, { sign: () => sign(first), persistLocal, persistPublic,
    beforeBroadcast: async () => { throw new Error("Canonical custody evidence temporarily unavailable"); },
    broadcast: async raw => { broadcasts++; return keccak256(raw); } });
  assert.equal(broadcasts, 0); assert.equal(abandoned.status, "abandoned");
  assert.deepEqual(local.get(first.id), canonical.get(first.id));
  assert.doesNotThrow(() => assertBaseNoUnknown([...local.values()], account.address));
  assert.equal(baseCanonicalGasSpent([...local.values()], account.address), 0n);
  const next = prepared("composed-next-task");
  const submitted = await submitBaseFeeBatch(next, { sign: () => sign(next), persistLocal, persistPublic,
    broadcast: async raw => { broadcasts++; return keccak256(raw); } });
  assert.equal(broadcasts, 1); assert.equal(submitted.journal!.nonce, abandoned.journal!.nonce);
  assert.equal(submitted.sourceHash, abandoned.sourceHash, "even identical replacement bytes are tracked under the new submitted task");
  assert.equal(baseCanonicalGasSpent([...local.values()], account.address), 10001000n, "the never-submitted signature cannot double-charge its later submitted counterpart");
});
