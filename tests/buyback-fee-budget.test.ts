import assert from "node:assert/strict";
import test from "node:test";
import {
  DopplerSDK, airlockAbi, computePoolId, dopplerHookInitializerAbi,
  feesManagerAbi, getAddresses,
} from "@whetstone-research/doppler-sdk/evm";
import {
  createPublicClient, decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi,
  zeroAddress, type Address, type Hex,
} from "viem";
import { base } from "viem/chains";
import { alchemyRpcTransport } from "../server/alchemy-rpc";
import { readFeeFeedProposals } from "../server/buyback-engine";
import { assetFeedOracleAbi } from "../src/lib/buyback-engine";
import buybackConfig from "../contracts/buyback.config.json";
import deployment from "../contracts/artifacts/buyback-v2-deployment.json";

const coin = getAddress("0x1111111111111111111111111111111111111111");
const quote = getAddress("0x2222222222222222222222222222222222222222");
const beneficiary = getAddress("0x3333333333333333333333333333333333333333");
const addresses = getAddresses(4663);
const initializer = getAddress(addresses.dopplerHookInitializer!);
const hook = getAddress("0x4444444444444444444444444444444444444444");
const poolKey = { currency0: coin, currency1: quote, fee: 0x800000, tickSpacing: 10, hooks: initializer };
const poolId = computePoolId(poolKey);
const stateSelector = encodeFunctionData({ abi: dopplerHookInitializerAbi, functionName: "getState", args: [coin] }).slice(0, 10);
const feeOrder = ["collectFees", "getShares", "getCumulatedFees0", "getCumulatedFees1", "getLastCumulatedFees0", "getLastCumulatedFees1"];

type Counters = { shares: bigint; current0: bigint; current1: bigint; last0: bigint; last1: bigint };
type RpcCall = { method: string; id: number; params?: [{ to: Address; data: Hex }] };

/** Real SDK and viem scheduling over controlled RPC replies. Counts are HTTP
 * fetches, including a rejected budget attempt, rather than EVM subcalls. */
function rpcFixture(counters: Counters) {
  let fetches = 0, budget = Infinity;
  const methods: string[] = [], feeReads: string[][] = [];
  function contractResult(target: Address, data: Hex, order: string[]): Hex {
    if (target.toLowerCase() === addresses.airlock.toLowerCase()) {
      const call = decodeFunctionData({ abi: airlockAbi, data });
      assert.equal(call.functionName, "getAssetData");
      assert.deepEqual(call.args, [coin]);
      return encodeFunctionResult({ abi: airlockAbi, functionName: "getAssetData", result: [
        quote, zeroAddress, zeroAddress, zeroAddress, initializer, zeroAddress, zeroAddress, 1n, 2n, zeroAddress,
      ] });
    }
    if (data.startsWith(stateSelector)) {
      assert.equal(target.toLowerCase(), initializer.toLowerCase());
      const call = decodeFunctionData({ abi: dopplerHookInitializerAbi, data });
      assert.equal(call.functionName, "getState");
      assert.deepEqual(call.args, [coin]);
      return encodeFunctionResult({ abi: dopplerHookInitializerAbi, functionName: "getState", result: [
        quote, 1n, zeroAddress, "0x", 2, poolKey, 0,
      ] });
    }
    const isHook = target.toLowerCase() === hook.toLowerCase();
    assert(isHook || target.toLowerCase() === initializer.toLowerCase());
    const call = decodeFunctionData({ abi: feesManagerAbi, data });
    assert.equal(call.args?.[0], poolId);
    order.push(call.functionName);
    assert.equal(call.functionName, feeOrder[order.length - 1], "collectFees and checkpoint reads must remain in SDK order");
    if (["getShares", "getLastCumulatedFees0", "getLastCumulatedFees1"].includes(call.functionName))
      assert.equal(call.args?.[1], beneficiary);
    // Fresh simulated collection must precede every counter read. Its return
    // values deliberately differ from the beneficiary's pending payout.
    if (call.functionName === "collectFees")
      return encodeFunctionResult({ abi: feesManagerAbi, functionName: "collectFees", result: [17n, 29n] });
    const values = {
      getShares: counters.shares, getCumulatedFees0: isHook ? 0n : counters.current0, getCumulatedFees1: isHook ? 0n : counters.current1,
      getLastCumulatedFees0: isHook ? 0n : counters.last0, getLastCumulatedFees1: isHook ? 0n : counters.last1,
    };
    return encodeFunctionResult({ abi: feesManagerAbi, functionName: call.functionName as keyof typeof values, result: values[call.functionName as keyof typeof values] });
  }
  const fetch = async (_input: unknown, init?: RequestInit) => {
    fetches++;
    if (fetches > budget) throw new Error("Too many subrequests.");
    const input = JSON.parse(String(init?.body)) as RpcCall | RpcCall[];
    const rows = Array.isArray(input) ? input : [input];
    const results = rows.map(row => {
      methods.push(row.method);
      if (row.method === "eth_chainId") return { jsonrpc: "2.0", id: row.id, result: "0x1237" };
      assert.equal(row.method, "eth_call", "fee previews may only issue read-only RPC methods");
      const request = row.params![0];
      assert.equal(request.to.toLowerCase(), base.contracts.multicall3.address.toLowerCase());
      const aggregate = decodeFunctionData({ abi: multicall3Abi, data: request.data });
      assert.equal(aggregate.functionName, "aggregate3");
      const order: string[] = [];
      const calls = aggregate.args[0].map(call => ({ success: true, returnData: contractResult(call.target, call.callData, order) }));
      if (order.length) { assert.deepEqual(order, feeOrder); feeReads.push(order); }
      return { jsonrpc: "2.0", id: row.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls }) };
    });
    return Response.json(Array.isArray(input) ? results : results[0]);
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    reset(limit = Infinity) { fetches = 0; budget = limit; methods.length = 0; feeReads.length = 0; },
    snapshot: () => ({ fetches, methods: [...methods], feeReads: [...feeReads] }),
  };
}

async function clients() {
  const client = createPublicClient({
    chain: { ...base, id: 4663 }, batch: { multicall: true },
    transport: alchemyRpcTransport(4663, { ALCHEMY_API_KEY: "offline-test-key" }, { maxRetries: 0 }),
  });
  // Both paths start with the same successful chain handshake, as after the
  // unchanged pool-state validation in engineClaimPreview.
  await client.getChainId();
  return new DopplerSDK<4663>({ publicClient: client, chainId: 4663 });
}

async function preview(sdk: DopplerSDK<4663>, reusePool: boolean) {
  const pool = await sdk.getMulticurvePool(coin);
  const state = await pool.getState();
  assert.equal(state.status, 2);
  assert.equal(state.numeraire, quote);
  assert.equal(computePoolId(state.poolKey), poolId);
  return reusePool ? pool.getPendingFees(beneficiary) : sdk.getMulticurvePool(coin).then(next => next.getPendingFees(beneficiary));
}

test("reusing the state-verified SDK pool reduces LP-path HTTP requests and preserves payouts and rounding", async t => {
  const fixtures = [
    { shares: 228_000_000_000_000_000n, current0: 101n, current1: 205n, last0: 3n, last1: 7n, expected: { fees0: 22n, fees1: 45n } },
    { shares: 228_000_000_000_000_000n, current0: 10n, current1: 8n, last0: 9n, last1: 3n, expected: { fees0: 0n, fees1: 1n } },
  ];
  for (const counters of fixtures) {
    const rpc = rpcFixture(counters);
    t.mock.method(globalThis, "fetch", rpc.fetch);
    const sdk = await clients();
    rpc.reset();
    const previous = await preview(sdk, false);
    assert.deepEqual(previous, counters.expected);
    assert.deepEqual(rpc.snapshot(), { fetches: 5, methods: Array(5).fill("eth_call"), feeReads: [feeOrder] });
    rpc.reset();
    const next = await preview(sdk, true);
    assert.deepEqual(next, previous);
    assert.deepEqual(rpc.snapshot(), { fetches: 4, methods: Array(4).fill("eth_call"), feeReads: [feeOrder] });
    rpc.reset();
    assert.deepEqual(await (await sdk.getRehypeDopplerHookInitializer(hook)).getPendingFees(poolId, beneficiary), { fees0: 0n, fees1: 0n });
    assert.deepEqual(rpc.snapshot(), { fetches: 1, methods: ["eth_call"], feeReads: [feeOrder] });
    t.mock.restoreAll();
  }
});

test("reused SDK pool succeeds with a four-fetch remainder that rejects repeated factory lookup", async t => {
  const rpc = rpcFixture({ shares: 228_000_000_000_000_000n, current0: 101n, current1: 205n, last0: 3n, last1: 7n });
  t.mock.method(globalThis, "fetch", rpc.fetch);
  const sdk = await clients();
  rpc.reset(4);
  await assert.rejects(() => preview(sdk, false), /Too many subrequests/);
  assert.equal(rpc.snapshot().fetches, 5);
  rpc.reset();
  const recovered = await clients();
  rpc.reset(4);
  assert.deepEqual(await preview(recovered, true), { fees0: 22n, fees1: 45n });
  assert.equal(rpc.snapshot().fetches, 4);
  assert.deepEqual(rpc.snapshot().methods, Array(4).fill("eth_call"));
});

test("all configured feed proposals fit two bounded HTTP fetches when no proposal is pending", async t => {
  let fetches = 0;
  const seen: string[] = [];
  const assetOracle = getAddress(deployment.contracts.assetOracle.address);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    fetches++;
    const input = JSON.parse(String(init?.body)) as RpcCall | RpcCall[];
    const rows = Array.isArray(input) ? input : [input];
    const results = rows.map(row => {
      assert.equal(row.method, "eth_call");
      const request = row.params![0];
      const aggregate = decodeFunctionData({ abi: multicall3Abi, data: request.data });
      assert.equal(aggregate.functionName, "aggregate3");
      const calls = aggregate.args[0].map(call => {
        assert.equal(call.target.toLowerCase(), assetOracle.toLowerCase());
        const proposal = decodeFunctionData({ abi: assetFeedOracleAbi, data: call.callData });
        assert.equal(proposal.functionName, "proposals");
        seen.push(String(proposal.args?.[0]).toLowerCase());
        return { success: true, returnData: encodeFunctionResult({ abi: assetFeedOracleAbi, functionName: "proposals", result: [zeroAddress, 0n, `0x${"00".repeat(32)}`] }) };
      });
      return { jsonrpc: "2.0", id: row.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls }) };
    });
    return Response.json(Array.isArray(input) ? results : results[0]);
  });
  const client = createPublicClient({
    chain: { ...base, id: 4663 }, batch: { multicall: true },
    transport: alchemyRpcTransport(4663, { ALCHEMY_API_KEY: "offline-test-key" }, { maxRetries: 0 }),
  });
  assert.deepEqual(await readFeeFeedProposals(client, { assetOracle, blockNumber: 100_000_000n }), []);
  assert.equal(fetches, 2);
  assert.deepEqual(seen.sort(), [deployment.constants.weth, ...buybackConfig.feeds.map(feed => feed.token)].map(address => address.toLowerCase()).sort());
  assert.equal(new Set(seen).size, 38);
});
