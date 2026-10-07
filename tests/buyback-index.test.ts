import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from "viem";
import { scanBuybackBurnIndex, type BuybackBurnIndexStore } from "../server/buyback-engine";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";

const engine = "0x1111111111111111111111111111111111111111" as Address;
const swapper = "0x2222222222222222222222222222222222222222" as Address;
const hash = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
function fixture() {
  let snapshot: { at: number; data: unknown } | null = null;
  let reorg = false, failPage = false, duplicate = false;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const store: BuybackBurnIndexStore = {
    snapshot: () => snapshot,
    saveSnapshot: (key, data, at) => { assert.match(key, /^buyback:index:4663:/); snapshot = { at, data }; },
  };
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hash(blockNumber + (reorg ? 10_000n : 0n)) }),
    getLogs: async ({ fromBlock, toBlock, address }: { fromBlock: bigint; toBlock: bigint; address: Address }) => {
      ranges.push({ fromBlock, toBlock });
      if (failPage && fromBlock >= 11n) throw new Error("provider unavailable");
      if (address === swapper || fromBlock > 3n || toBlock < 3n) return [];
      return (duplicate ? [1, 2] : [1]).map(() => ({ transactionHash: hash(999n) }));
    },
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 3n, blockHash: hash(3n + (reorg ? 10_000n : 0n)), logs: [{
      address: MUSEGOD_BUYBACK.tokenAddress,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: engine, to: MUSEGOD_BUYBACK.burnAddress } }),
      data: encodeAbiParameters([{ type: "uint256" }], [77n]),
    }] }),
  } as unknown as Parameters<typeof scanBuybackBurnIndex>[0];
  return { client, store, ranges, state: () => snapshot?.data as { to: string; burns: unknown[] },
    setReorg: () => { reorg = true; }, setFailure: (value: boolean) => { failPage = value; }, setDuplicate: () => { duplicate = true; } };
}

test("burn index commits bounded pages, continues beyond 500 blocks and uses 64 confirmations", async () => {
  const f = fixture(); f.setDuplicate();
  const input = { engine, swapper, deploymentBlock: 1n, head: 764n };
  const first = await scanBuybackBurnIndex(f.client, f.store, input);
  assert.equal(first.to, "500"); assert.equal(first.caughtUp, false); assert.equal(first.burns.length, 1);
  assert.equal(first.burns[0].amount, "77");
  f.ranges.length = 0;
  const second = await scanBuybackBurnIndex(f.client, f.store, input);
  assert.equal(second.to, "700"); assert.equal(second.caughtUp, true); assert.equal(second.burns.length, 1);
  assert(f.ranges.every((r) => r.fromBlock >= 501n && r.toBlock <= 700n && r.toBlock - r.fromBlock < 10n));
});

test("an interrupted index round retains only its completed checkpoint and resumes the failed page", async () => {
  const f = fixture(); f.setFailure(true);
  const input = { engine, swapper, deploymentBlock: 1n, head: 100n };
  await assert.rejects(() => scanBuybackBurnIndex(f.client, f.store, input), /provider unavailable/);
  assert.equal(f.state().to, "10");
  f.setFailure(false); f.ranges.length = 0;
  const resumed = await scanBuybackBurnIndex(f.client, f.store, input);
  assert.equal(resumed.to, "36"); assert.equal(resumed.burns.length, 1);
  assert(f.ranges.every((r) => r.fromBlock >= 11n));
});

test("a changed canonical checkpoint rebuilds receipts and never retains orphaned history", async () => {
  const f = fixture(), input = { engine, swapper, deploymentBlock: 1n, head: 100n };
  await scanBuybackBurnIndex(f.client, f.store, input);
  f.setReorg(); f.ranges.length = 0;
  const rebuilt = await scanBuybackBurnIndex(f.client, f.store, input);
  assert.equal(f.ranges[0].fromBlock, 1n); assert.equal(rebuilt.burns.length, 1); assert.equal(rebuilt.to, "36");
});

test("missing deployment provenance never manufactures an index start or total", async () => {
  const f = fixture();
  const result = await scanBuybackBurnIndex(f.client, f.store, { engine, swapper, deploymentBlock: null, head: 1000n });
  assert.deepEqual(result, { burns: [], from: null, to: null, caughtUp: false }); assert.equal(f.ranges.length, 0);
});
