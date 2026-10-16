import test from "node:test";
import assert from "node:assert/strict";
import { LaunchpadService } from "../server/service";
import { ROBINHOOD_CONTRACTS } from "../src/lib/config";
import { MUSEGOD } from "../src/lib/musegod";
import { syntheticToken } from "./fixtures";

const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: MUSEGOD.weth, tradingFeeBps: 100 });
const poolKey = { currency0: token.address, currency1: MUSEGOD.weth, fee: 500, tickSpacing: 10, hooks: ROBINHOOD_CONTRACTS.initializer };
test("real V4 quote pins pool slot0 and quoter to one block with only one additional state read", async () => {
  const reads: any[] = [], simulations: any[] = [];
  const client = { getBlockNumber: async () => 123n,
    readContract: async (p: any) => { reads.push(p); return p.functionName === "symbol" ? "WETH" : p.functionName === "decimals" ? 18
      : p.functionName === "extsload" ? `0x${((500n << 208n) | (2n ** 96n)).toString(16).padStart(64, "0")}` : false; },
    simulateContract: async (p: any) => { simulations.push(p); return { result: [1234n, 100n] }; } };
  const service = { client, contracts: ROBINHOOD_CONTRACTS, runtime: { config: { mode: "robinhood", chainId: 4663 } },
    assertNetwork: async () => {}, state: async () => ({ token, state: { poolKey } }) };
  const q = await LaunchpadService.prototype.quote.call(service as any, token.address, "buy", "1", 100);
  assert.deepEqual(q.poolPrice, { sqrtPriceX96: String(2n ** 96n), blockNumber: "123", zeroForOne: false, feeBps: 105 });
  assert.equal(simulations.length, 1); assert.equal(simulations[0].blockNumber, 123n);
  assert.equal(simulations[0].args[0].exactAmount, 10n ** 18n); assert.equal(q.amountOut, "1234");
  const poolReads = reads.filter(p => p.functionName === "extsload");
  assert.equal(poolReads.length, 1); assert.equal(poolReads[0].address, ROBINHOOD_CONTRACTS.poolManager);
  assert.equal(poolReads[0].blockNumber, 123n);
  assert(reads.every(p => p.blockNumber === 123n));
});
