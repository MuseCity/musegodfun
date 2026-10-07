import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, zeroAddress,
  type Address, type Hex, type PublicClient, type Transport } from "viem";
import { FirstBuyPaymentReader } from "../server/lifi";
import { FIRST_BUY_PAYMENT_CONTRACTS, assertFirstBuyPaymentQuote, firstBuyFeeAbi, firstBuyPairedAsset,
  firstBuyPaymentAbi, firstBuyPaymentAssets, firstBuyPaymentInput, firstBuyReceiptOutput,
  type FirstBuyPaymentChain, type FirstBuyPaymentQuote, type FirstBuySwapData } from "../src/lib/first-buy-payment";
// Synthetic quotes/receipts exercise validation. Runtime snapshots are verified
// Sourcify bytecode, not a funded transaction or fork-execution test.
const account = "0x1111111111111111111111111111111111111111" as Address;
const dex = "0x603206D6105217DD972E4Ab30676A220CA393346" as Address;
const receiver = "0xc06ebbefd94032b85424d51906e2a335efae264b" as Address;
const hash = `0x${"a".repeat(64)}` as Hex;
const transactionId = `0x${"c".repeat(64)}` as Hex;
const blockHash = `0x${"b".repeat(64)}` as Hex;
const at = 1_780_000_000_000;
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
function runtime(chain: FirstBuyPaymentChain) {
  return JSON.parse(readFileSync(new URL(`./fixtures/lifi-${chain}-runtime.json`, import.meta.url), "utf8")).onchainBytecode as Hex;
}
function fixture(chainId: FirstBuyPaymentChain = 4663, native = true, fee = true, single = false) {
  const registry = FIRST_BUY_PAYMENT_CONTRACTS[chainId];
  const fromToken = firstBuyPaymentAssets(chainId).find((a) => native ? a.address === zeroAddress : a.symbol === (chainId === 4663 ? "USDG" : "USDC"))!;
  const toToken = firstBuyPairedAsset(chainId, chainId === 4663 ? "0x0bd7d308f8e1639fab988df18a8011f41eacad73" : "0xb20000000000000000000078ee7ce2fE4908108C");
  const amountIn = native ? 10n ** 16n : 10n ** 7n, feeAmount = fee ? amountIn / 400n : 0n;
  const swaps: FirstBuySwapData[] = [];
  if (fee) swaps.push({ callTo: registry.feeForwarder, approveTo: registry.feeForwarder,
    sendingAssetId: fromToken.address, receivingAssetId: fromToken.address, fromAmount: amountIn, requiresDeposit: true,
    callData: native ? encodeFunctionData({ abi: firstBuyFeeAbi, functionName: "forwardNativeFees", args: [[{ recipient: receiver, amount: feeAmount }]] })
      : encodeFunctionData({ abi: firstBuyFeeAbi, functionName: "forwardERC20Fees", args: [fromToken.address, [{ recipient: receiver, amount: feeAmount }]] }) });
  swaps.push({ callTo: dex, approveTo: dex, sendingAssetId: fromToken.address, receivingAssetId: toToken.address,
    fromAmount: amountIn - feeAmount, callData: "0x3f0bde251234", requiresDeposit: !fee });
  const functionName = single ? native ? "swapTokensSingleV3NativeToERC20" : "swapTokensSingleV3ERC20ToERC20"
    : native ? "swapTokensMultipleV3NativeToERC20" : "swapTokensMultipleV3ERC20ToERC20";
  const encode = (steps = swaps, recipient = account, min = 9_900_000n) => encodeFunctionData({ abi: firstBuyPaymentAbi,
    functionName, args: [transactionId, "musegodfun", zeroAddress, recipient, min, single ? steps[0] : steps] as never });
  const q: FirstBuyPaymentQuote = { protocol: "lifi", id: "synthetic:0", transactionId, integrator: "musegodfun", tool: "nordstern",
    chainId, account, fromToken, toToken, amountIn: amountIn.toString(), expectedOut: "10000000", minimumOut: "9900000",
    slippageBps: 100, quotedAt: at, expiresAt: at + 60_000, router: registry.diamond, facet: registry.facet,
    facetRuntimeHash: registry.runtimeHash, blockNumber: "10", blockHash,
    transaction: { to: registry.diamond, data: encode(), value: native ? amountIn.toString() : "0" },
    approval: native ? null : { token: fromToken.address, spender: registry.diamond, amount: amountIn.toString() },
    feeAmount: feeAmount.toString(), feeUsd: null, gasFeeUsd: null, amountInUsd: null };
  return { q, swaps, encode };
}
test("fixed payment assets are chain-specific and duplicate paired assets are merged", () => {
  assert.deepEqual(firstBuyPaymentAssets(8453).map((a) => a.symbol), ["USDC", "USDT", "ETH"]);
  const usd = firstBuyPaymentAssets(4663)[0];
  assert.deepEqual(firstBuyPaymentAssets(4663, usd.address).map((a) => a.symbol), ["USDG", "ETH"]);
  assert.throws(() => firstBuyPairedAsset(8453, usd.address));
  assert.throws(() => firstBuyPaymentInput(4663, { account, fromToken: usd.address, toToken: usd.address, amount: "10", slippageBps: 100 }));
  assert.throws(() => firstBuyPaymentInput(4663, { account, fromToken: usd.address, toToken: fixture().q.toToken.address,
    amount: "1.0000001", slippageBps: 100 }));
  const assets = firstBuyPaymentAssets(8453), original = assets[0].address;
  assets[0].address = account;
  assert.equal(firstBuyPaymentAssets(8453)[0].address, original, "Returned UI data cannot mutate the fixed asset registry");
});
test("four supported V3 selectors enforce native value or exact ERC20 approval", () => {
  for (const native of [true, false]) for (const single of [true, false]) {
    const { q } = fixture(4663, native, !single, single);
    assertFirstBuyPaymentQuote(q, at + 1);
    assert.throws(() => assertFirstBuyPaymentQuote({ ...q, transaction: { ...q.transaction, value: native ? "1" : "100" } }, at));
    if (!native) assert.throws(() => assertFirstBuyPaymentQuote({ ...q, approval: { ...q.approval!, amount: "9999999" } }, at));
  }
});
test("recipient, minOut, implementation, calldata trailing bytes, fee destinations, and extra deposits fail closed", () => {
  const { q, swaps, encode } = fixture();
  for (const patch of [{ chainId: 8453 }, { facetRuntimeHash: hash }, { expectedOut: "20000000" },
    { expiresAt: at + 60_001 }, { account: dex }])
    assert.throws(() => assertFirstBuyPaymentQuote({ ...q, ...patch } as FirstBuyPaymentQuote, at));
  assert.throws(() => assertFirstBuyPaymentQuote({ ...q, transaction: { ...q.transaction, data: encode(swaps, dex) } }, at));
  assert.throws(() => assertFirstBuyPaymentQuote({ ...q, transaction: { ...q.transaction, data: encode(swaps, account, 1n) } }, at));
  assert.throws(() => assertFirstBuyPaymentQuote({ ...q, transaction: { ...q.transaction, data: `${q.transaction.data}00` } }, at));
  const extra = structuredClone(swaps); extra[1].requiresDeposit = true;
  assert.throws(() => assertFirstBuyPaymentQuote({ ...q, transaction: { ...q.transaction, data: encode(extra) } }, at));
  const fee = structuredClone(swaps);
  fee[0].callData = encodeFunctionData({ abi: firstBuyFeeAbi, functionName: "forwardNativeFees",
    args: [[{ recipient: account, amount: BigInt(q.feeAmount) }]] });
  assert.throws(() => assertFirstBuyPaymentQuote({ ...q, transaction: { ...q.transaction, data: encode(fee) } }, at));
  assert.throws(() => assertFirstBuyPaymentQuote(q, q.expiresAt));
  assertFirstBuyPaymentQuote(q, q.expiresAt + 1, true);
});
function receiptLogs(q: FirstBuyPaymentQuote, amount = 10_000_000n) {
  return [{ address: q.router,
    topics: encodeEventTopics({ abi: firstBuyPaymentAbi, eventName: "LiFiGenericSwapCompleted", args: { transactionId } }) as Hex[],
    data: encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [q.integrator, zeroAddress, account, q.fromToken.address, q.toToken.address, BigInt(q.amountIn), amount]) },
  { address: q.toToken.address, topics: encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: q.router, to: account } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]) }];
}
test("receipt output requires one matched completion and net ERC20 receipt, independent of wallet balance", () => {
  const { q } = fixture(), logs = receiptLogs(q);
  assert.equal(firstBuyReceiptOutput(q, logs), 10_000_000n);
  assert.throws(() => firstBuyReceiptOutput(q, [logs[0]]));
  assert.throws(() => firstBuyReceiptOutput(q, [logs[0], logs[0], logs[1]]));
  assert.throws(() => firstBuyReceiptOutput(q, receiptLogs(q, 9_800_000n)));
  const moved = [...logs, { address: q.toToken.address,
    topics: encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: account, to: dex } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [1n]) }];
  assert.throws(() => firstBuyReceiptOutput(q, moved));
});
function readerFixture(chainId: FirstBuyPaymentChain = 4663, native = true, rpcChainId: FirstBuyPaymentChain | 31337 = chainId) {
  const { q, swaps } = fixture(chainId, native);
  const requests: { url: string; init?: RequestInit }[] = [];
  let now = at, badFacet = false, badCode = false, white = true, changedBlock = false, delayed = false;
  let receiptStatus = "success", input = q.transaction.data, tokenOutput = 10_000_000n, head = 11n;
  const raw: any = { id: q.id, tool: q.tool, integrator: q.integrator,
    action: { fromToken: { ...q.fromToken, priceUSD: "1" }, toToken: { ...q.toToken, priceUSD: "1" },
      fromChainId: chainId, toChainId: chainId, fromAddress: account, toAddress: account,
      fromAmount: q.amountIn, slippage: .01 },
    estimate: { fromAmount: q.amountIn, toAmount: q.expectedOut, toAmountMin: q.minimumOut, approvalAddress: q.router,
      feeCosts: [{ name: "LIFI Fixed Fee", included: true, token: q.fromToken, amount: q.feeAmount,
        feeSplit: { lifiFee: q.feeAmount, integratorFee: "0" } }], gasCosts: [] },
    transactionRequest: { to: q.router, from: account, chainId, value: `0x${BigInt(q.transaction.value).toString(16)}`, data: q.transaction.data },
    includedSteps: ["protocol", "swap"].map((type) => ({ type, action: { fromChainId: chainId, toChainId: chainId } })) };
  const client = {
    getChainId: async () => rpcChainId,
    getBlockNumber: async () => head,
    getBlock: async () => ({ number: 10n, hash: changedBlock ? hash : blockHash }),
    getCode: async () => badCode ? "0x1234" : runtime(chainId),
    readContract: async ({ functionName }: { functionName: string }) => functionName === "facetAddress" ? badFacet ? dex : q.facet : white,
    getTransactionReceipt: async () => {
      if (receiptStatus === "pending") throw Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" });
      return { transactionHash: hash, blockNumber: 10n, blockHash, status: receiptStatus, logs: receiptLogs(q, tokenOutput) };
    },
    getTransaction: async () => ({ hash, from: account, to: q.router, chainId: rpcChainId, input, value: BigInt(q.transaction.value), blockNumber: 10n, blockHash }),
  } as unknown as PublicClient<Transport, any>;
  let status = 200, fetchError = false;
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (delayed) now += 60_000;
    if (fetchError) throw new Error("SECRET_VALUE in upstream URL");
    return new Response(JSON.stringify(raw), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const reader = new FirstBuyPaymentReader({ client, chainId, rpcChainId, now: () => now, fetch: fetcher, apiKey: "SECRET_VALUE" });
  const body = { account, fromToken: q.fromToken.address, toToken: q.toToken.address, amount: native ? "0.01" : "10", slippageBps: 100 };
  return { reader, client, body, raw, requests, q, swaps,
    stale: () => { now += 60_000; }, delayed: () => { delayed = true; }, badFacet: () => { badFacet = true; }, badCode: () => { badCode = true; },
    noWhitelist: () => { white = false; }, reorg: () => { changedBlock = true; },
    badTx: () => { input = "0x1234"; }, badOutput: () => { tokenOutput = 1n; },
    setHead: (value: bigint) => { head = value; }, setStatus: (value: string) => { receiptStatus = value; },
    redirect: () => { status = 302; }, error: () => { fetchError = true; } };
}
test("router runtime fixtures equal fixed independently checked source hashes", () => {
  for (const chain of [8453, 4663] as const) assert.equal(keccak256(runtime(chain)), FIRST_BUY_PAYMENT_CONTRACTS[chain].runtimeHash);
});
test("default native fetch keeps the global receiver for token prices and executable quotes", async (context) => {
  const f = readerFixture(), assets = firstBuyPaymentAssets(4663, f.q.toToken.address), paths: string[] = [];
  context.mock.method(globalThis, "fetch", async function (this: typeof globalThis, input: string | URL | Request, init?: RequestInit) {
    assert.equal(this, globalThis, "Workers native fetch rejects an unrelated receiver before sending HTTP");
    const url = new URL(String(input)); assert.equal(url.origin, "https://li.quest"); paths.push(url.pathname);
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("x-lifi-api-key"), "receiver-test-key");
    if (url.pathname === "/v1/quote") return Response.json(f.raw);
    assert.equal(url.pathname, "/v1/token");
    const asset = assets.find((item) => item.address.toLowerCase() === url.searchParams.get("token")?.toLowerCase());
    assert(asset); return Response.json({ ...asset, priceUSD: "1" });
  });
  const reader = new FirstBuyPaymentReader({ client: f.client, chainId: 4663, now: () => at, apiKey: "receiver-test-key" });
  const token = await reader.pricingRequest("token", new URLSearchParams({ chain: "4663", token: assets[0].address }));
  assert.equal((token as { priceUSD: string }).priceUSD, "1");
  const prices = await reader.prices(f.q.toToken.address);
  assert(prices.assets.every((asset) => asset.priceUsd === "1"));
  const quote = await reader.quote(f.body);
  assert.equal(quote.expectedOut, f.q.expectedOut);
  assert.equal(paths.filter((path) => path === "/v1/token").length, assets.length + 1);
  assert.equal(paths.filter((path) => path === "/v1/quote").length, 1);
  assert(!JSON.stringify({ prices, quote }).includes("receiver-test-key"));
});
test("reader scopes both networks, requests fee=0, validates runtime and whitelist, keeps key in header only", async () => {
  for (const chain of [8453, 4663] as const) for (const native of [true, false]) {
    const f = readerFixture(chain, native), q = await f.reader.quote(f.body);
    assert.equal(q.feeAmount, f.q.feeAmount);
    assert.equal(q.integrator, "musegodfun");
    const url = new URL(f.requests[0].url);
    assert.equal(url.searchParams.get("fromChain"), String(chain));
    assert.equal(url.searchParams.get("toChain"), String(chain));
    assert.equal(url.searchParams.get("fee"), "0");
    assert.equal(url.searchParams.get("allowBridges"), "none");
    assert.equal(f.requests[0].init?.redirect, "manual");
    assert.equal((f.requests[0].init?.headers as Record<string, string>)["x-lifi-api-key"], "SECRET_VALUE");
    assert(!JSON.stringify(q).includes("SECRET_VALUE"));
  }
});
test("reader rejects tampered network, provider fee, old facet/code, whitelist, TTL, redirect and upstream secret text", async () => {
  for (const action of ["badFacet", "badCode", "noWhitelist", "delayed", "redirect", "error"] as const) {
    const f = readerFixture(); f[action]();
    await assert.rejects(f.reader.quote(f.body), (e: Error) => !e.message.includes("SECRET_VALUE"));
  }
  const wrongChain = readerFixture(); wrongChain.raw.action.toChainId = 8453;
  await assert.rejects(wrongChain.reader.quote(wrongChain.body));
  const extraFee = readerFixture(); extraFee.raw.estimate.feeCosts[0].feeSplit.integratorFee = "1";
  await assert.rejects(extraFee.reader.quote(extraFee.body), /unsupported fee/);
});
test("receipt recovery permits quote expiry but rejects changed tx and reorg; distinguishes pending/reverted", async () => {
  const f = readerFixture(); f.stale();
  assert.equal((await f.reader.verify({ quote: f.q, hash })).actualOutput, "10000000");
  f.setStatus("pending"); assert.equal((await f.reader.verify({ quote: f.q, hash })).status, "pending");
  f.setStatus("reverted"); assert.equal((await f.reader.verify({ quote: f.q, hash })).status, "reverted");
  f.setStatus("success"); f.badTx(); await assert.rejects(f.reader.verify({ quote: f.q, hash }), /frozen quote/);
  const reorg = readerFixture(); reorg.reorg(); await assert.rejects(reorg.reader.verify({ quote: reorg.q, hash }), /canonical receipt/);
});
test("recovery treats one confirmation as pending for successful and reverted receipts; two confirmations establish terminal status", async () => {
  for (const status of ["success", "reverted"]) {
    const f = readerFixture(); f.stale(); f.setStatus(status); f.setHead(10n);
    const pending = await f.reader.verify({ quote: f.q, hash });
    assert.equal(pending.status, "pending"); assert.equal(pending.actualOutput, null);
    f.setHead(11n);
    const confirmed = await f.reader.verify({ quote: f.q, hash });
    assert.equal(confirmed.status, status);
    assert.equal(confirmed.actualOutput, status === "success" ? "10000000" : null);
  }
});
test("canonical mismatch remains unknown even when a receipt has only one confirmation", async () => {
  const f = readerFixture(); f.setHead(10n); f.reorg();
  await assert.rejects(f.reader.verify({ quote: f.q, hash }), /canonical receipt/);
});
test("fork verification requires explicit 31337 configuration and retains fixed deployment assets", async () => {
  const f = readerFixture(8453, true, 31337), q = await f.reader.quote(f.body);
  assert.equal(q.chainId, 8453);
  assert.equal(q.router, FIRST_BUY_PAYMENT_CONTRACTS[8453].diamond);
  assert.equal((await f.reader.verify({ quote: q, hash })).status, "success");
  const implicit = new FirstBuyPaymentReader({ client: f.client, chainId: 8453, now: () => at });
  await assert.rejects(implicit.verify({ quote: q, hash }), /wrong network/);
  assert.throws(() => new FirstBuyPaymentReader({ client: f.client, chainId: 8453, rpcChainId: 4663 }));
});
