import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, formatUnits, parseAbi, zeroAddress,
  type Address, type Hash, type Hex, type PublicClient, type Transport } from "viem";
import { FirstBuyPaymentReader, LifiNoRouteError } from "../server/lifi";
import { EthBuyError, quoteEthBuy } from "../server/eth-buy";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { IngressLimiter, expensiveRoute, ingressClass } from "../server/abuse";
import { FIRST_BUY_PAYMENT_CONTRACTS, assertEthBuyQuote, assertFirstBuyPaymentQuote, ethBuyCoin, firstBuyFeeAbi, firstBuyPairedAsset, firstBuyPaymentAbi,
  type FirstBuyPaymentAsset, type FirstBuyPaymentQuote, type FirstBuySwapData } from "../src/lib/first-buy-payment";
import { EthBuyIncomplete, assertEthBuyResponse, defaultPayWith, ethBuyAvailable, ethBuyDisclosure, executeEthBuy, executeLifiTrade, pairShortfall,
  pendingOutcome, receivedFromLogs, resolvePayWith, twoStepLabels, twoStepMinimum, type EthBuyQuoteResponse, type SwapQuote } from "../src/lib/eth-buy";
import { BudgetUnavailable } from "../server/runtime-policy";
import { ROBINHOOD_STOCKS, type RuntimeConfig } from "../src/lib/config";
import { resetQuoteClock } from "../src/lib/quote-clock";
import { syntheticToken } from "./fixtures";

// Synthetic LI.FI responses and receipts only: no request leaves the process.
const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const dex = "0x603206D6105217DD972E4Ab30676A220CA393346" as Address;
const lifiFeeReceiver = "0xc06ebbefd94032b85424d51906e2a335efae264b" as Address;
// MVADER, the MUSEGOD-paired coin the controller quoted live (read-only) on 2026-10-14.
const coin: FirstBuyPaymentAsset = { chainId: 4663, address: "0xB60E817D8E6F72013701aC447fd1D92Caa561c7c", symbol: "MVADER", decimals: 18 };
const otherCoin: FirstBuyPaymentAsset = { chainId: 4663, address: "0x5555555555555555555555555555555555555555", symbol: "BARD", decimals: 18 };
const musegod = firstBuyPairedAsset(4663, "0x0379E228F6887c6F18bf394042ECAF81B308cb2e");
const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
const eth = { chainId: 4663, address: zeroAddress, symbol: "ETH", decimals: 18 } as const;
const registry = FIRST_BUY_PAYMENT_CONTRACTS[4663];
const transactionId = `0x${"c".repeat(64)}` as Hex, blockHash = `0x${"b".repeat(64)}` as Hex;
const at = 1_780_000_000_000;
const runtimeCode = JSON.parse(readFileSync(new URL("./fixtures/lifi-4663-runtime.json", import.meta.url), "utf8")).onchainBytecode as Hex;
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

/** A LI.FI V3 native swap of `amountIn` ETH into `target`, with the standard LIFI fixed fee step. */
function lifiQuote(target: FirstBuyPaymentAsset, now = at, amountIn = 10n ** 15n, expectedOut = 5_000n * 10n ** 18n) {
  const feeAmount = amountIn * 25n / 10_000n, minimumOut = expectedOut * 99n / 100n;
  const swaps: FirstBuySwapData[] = [
    { callTo: registry.feeForwarder, approveTo: registry.feeForwarder, sendingAssetId: zeroAddress, receivingAssetId: zeroAddress,
      fromAmount: amountIn, requiresDeposit: true,
      callData: encodeFunctionData({ abi: firstBuyFeeAbi, functionName: "forwardNativeFees", args: [[{ recipient: lifiFeeReceiver, amount: feeAmount }]] }) },
    { callTo: dex, approveTo: dex, sendingAssetId: zeroAddress, receivingAssetId: target.address, fromAmount: amountIn - feeAmount,
      callData: "0x3f0bde251234", requiresDeposit: false }];
  const encode = (steps = swaps, recipient = account, min = minimumOut) => encodeFunctionData({ abi: firstBuyPaymentAbi,
    functionName: "swapTokensMultipleV3NativeToERC20", args: [transactionId, "musegodfun", zeroAddress, recipient, min, steps] });
  const q: FirstBuyPaymentQuote = { protocol: "lifi", id: "synthetic-eth-buy", transactionId, integrator: "musegodfun", tool: "bitget",
    chainId: 4663, account, fromToken: { ...eth }, toToken: { ...target }, amountIn: amountIn.toString(), expectedOut: expectedOut.toString(),
    minimumOut: minimumOut.toString(), slippageBps: 100, quotedAt: now, expiresAt: now + 60_000, router: registry.diamond, facet: registry.facet,
    facetRuntimeHash: registry.runtimeHash, blockNumber: "10", blockHash, transaction: { to: registry.diamond, data: encode(), value: amountIn.toString() },
    approval: null, feeAmount: feeAmount.toString(), feeUsd: null, gasFeeUsd: null, amountInUsd: null };
  return { q, swaps, encode };
}
/** The raw LI.FI `/quote` body for a quote, so each test can corrupt one field. */
function rawQuote(q: FirstBuyPaymentQuote): any {
  return { id: q.id, tool: q.tool, integrator: q.integrator,
    action: { fromToken: { ...q.fromToken, priceUSD: "3000" }, toToken: { ...q.toToken, priceUSD: "0.0001" }, fromChainId: 4663, toChainId: 4663,
      fromAddress: account, toAddress: account, fromAmount: q.amountIn, slippage: 0.01 },
    estimate: { fromAmount: q.amountIn, toAmount: q.expectedOut, toAmountMin: q.minimumOut, approvalAddress: q.router,
      feeCosts: [{ name: "LIFI Fixed Fee", included: true, token: q.fromToken, amount: q.feeAmount, feeSplit: { lifiFee: q.feeAmount, integratorFee: "0" } }],
      gasCosts: [] },
    transactionRequest: { to: q.router, from: account, chainId: 4663, value: `0x${BigInt(q.transaction.value).toString(16)}`, data: q.transaction.data },
    includedSteps: ["protocol", "swap"].map((type) => ({ type, action: { fromChainId: 4663, toChainId: 4663 } })) };
}
const noRouteBody = { code: 1002, message: "No available quotes for the requested transfer" };
function readerFixture(rpcChainId: 4663 | 31337 = 4663) {
  const { q, swaps, encode } = lifiQuote(coin);
  const raw = rawQuote(q), requests: URL[] = [];
  let facet: Address = registry.facet, white = true, noRoute = false;
  const client = {
    getChainId: async () => rpcChainId,
    getBlock: async () => ({ number: 10n, hash: blockHash }),
    getCode: async () => runtimeCode,
    readContract: async ({ functionName }: { functionName: string }) => functionName === "facetAddress" ? facet : white,
  } as unknown as PublicClient<Transport, any>;
  const fetcher = (async (url: string) => {
    requests.push(new URL(url));
    return noRoute ? Response.json(noRouteBody, { status: 404 }) : Response.json(raw);
  }) as typeof fetch;
  const reader = new FirstBuyPaymentReader({ client, chainId: 4663, rpcChainId, now: () => at, fetch: fetcher });
  const input = { account, amount: "0.001", coin: { address: coin.address, symbol: coin.symbol }, slippageBps: 100 };
  return { reader, raw, q, swaps, encode, requests, input, client,
    foreignFacet: () => { facet = dex; }, noWhitelist: () => { white = false; }, noRoute: () => { noRoute = true; } };
}

test("a direct ETH → coin LI.FI quote keeps every first-buy check, with the coin as the only accepted output", async () => {
  const f = readerFixture(), quote = await f.reader.coinQuote(f.input);
  assert.equal(quote.toToken.address, coin.address);
  assert.equal(quote.fromToken.address, zeroAddress);
  assert.equal(quote.transaction.value, "1000000000000000");
  assert.equal(quote.approval, null);
  assert.equal(quote.feeAmount, f.q.feeAmount);
  const url = f.requests[0];
  assert.equal(url.pathname, "/v1/quote");
  for (const [key, value] of [["fromChain", "4663"], ["toChain", "4663"], ["fromToken", zeroAddress], ["toToken", coin.address],
    ["fromAddress", account], ["toAddress", account], ["fee", "0"], ["allowBridges", "none"], ["fromAmount", "1000000000000000"]])
    assert.equal(url.searchParams.get(key), value, key);
  assert.equal(assertEthBuyQuote(quote, coin, at).length, 2);
  // The first-buy path itself is unchanged: a coin is still not an accepted first-buy output.
  assert.throws(() => assertFirstBuyPaymentQuote(quote, at));
  // Nor does the coin path accept another coin, or a first-buy asset as a "coin".
  assert.throws(() => assertEthBuyQuote(quote, otherCoin, at), /ETH buy quote could not be verified/);
  for (const reserved of [musegod, weth, ROBINHOOD_STOCKS.find((asset) => asset.symbol === "USDG")!, ROBINHOOD_STOCKS.find((asset) => asset.symbol === "TSLA")!,
    { address: registry.diamond, symbol: "LIFI" }, { address: zeroAddress, symbol: "ETH" }]) {
    assert.throws(() => ethBuyCoin(4663, { address: reserved.address, symbol: reserved.symbol }), /ETH buy quote could not be verified/, reserved.symbol);
    await assert.rejects(f.reader.coinQuote({ ...f.input, coin: { address: reserved.address, symbol: reserved.symbol } }));
  }
  // A strict ETH → pair conversion can never pass as an "ETH buy" of the pair asset itself.
  const conversion = lifiQuote(musegod).q;
  assertFirstBuyPaymentQuote(conversion, at);
  assert.throws(() => assertEthBuyQuote(conversion, musegod, at), /ETH buy quote could not be verified/);
});

test("every strictness check rejects a malformed ETH-buy quote", async () => {
  const cases: [string, (f: ReturnType<typeof readerFixture>) => void][] = [
    ["wrong toToken in the route", (f) => { f.raw.action.toToken = { ...otherCoin, priceUSD: "1" }; }],
    ["wrong toToken in the calldata", (f) => { f.raw.transactionRequest.data = lifiQuote(otherCoin).q.transaction.data; }],
    ["coin decimals other than 18", (f) => { f.raw.action.toToken.decimals = 6; }],
    ["wrong toAddress", (f) => { f.raw.action.toAddress = other; }],
    ["calldata receiver is not the account", (f) => { f.raw.transactionRequest.data = f.encode(f.swaps, other); }],
    ["calldata minimum below the quoted minimum", (f) => { f.raw.transactionRequest.data = f.encode(f.swaps, account, 1n); }],
    ["non-zero integrator fee", (f) => { f.raw.estimate.feeCosts[0].feeSplit.integratorFee = "1"; }],
    ["a second fee", (f) => { f.raw.estimate.feeCosts.push({ ...f.raw.estimate.feeCosts[0], name: "Integrator Fee" }); }],
    ["foreign diamond as the target", (f) => { f.raw.transactionRequest.to = dex; }],
    ["foreign diamond as the approval address", (f) => { f.raw.estimate.approvalAddress = dex; }],
    ["changed facet", (f) => f.foreignFacet()],
    ["swap target not whitelisted", (f) => f.noWhitelist()],
    ["bridge step", (f) => { f.raw.includedSteps.push({ type: "cross", action: { fromChainId: 4663, toChainId: 8453 } }); }],
    ["other destination chain", (f) => { f.raw.action.toChainId = 8453; }],
    ["native value differs from the amount", (f) => { f.raw.transactionRequest.value = "0x38d7ea4c68001"; }],
    ["fromAddress is not the account", (f) => { f.raw.action.fromAddress = other; }],
  ];
  for (const [name, corrupt] of cases) {
    const f = readerFixture(); corrupt(f);
    await assert.rejects(f.reader.coinQuote(f.input), Error, name);
  }
  // The same quote with nothing corrupted passes, so each rejection above is caused by its one change.
  const f = readerFixture(); await f.reader.coinQuote(f.input);
  // On the trade path only, LI.FI may spell a new coin's symbol differently: address, chain and decimals identify it.
  const renamed = readerFixture(); renamed.raw.action.toToken.symbol = "MVADER-unindexed";
  assert.equal((await renamed.reader.coinQuote(renamed.input)).toToken.symbol, "MVADER", "the quote keeps the catalog symbol");
  // A first-buy conversion still requires LI.FI's symbol for the paired asset to match exactly.
  const conversion = lifiQuote(musegod).q, firstBuyRaw = rawQuote(conversion);
  const firstBuy = (raw: unknown) => new FirstBuyPaymentReader({ client: f.client, chainId: 4663, now: () => at, fetch: async () => Response.json(raw) })
    .quote({ account, fromToken: zeroAddress, toToken: musegod.address, amount: "0.001", slippageBps: 100 });
  await firstBuy(firstBuyRaw);
  await assert.rejects(firstBuy({ ...firstBuyRaw, action: { ...firstBuyRaw.action, toToken: { ...firstBuyRaw.action.toToken, symbol: "MUSE" } } }),
    /token identity did not match/);
  // ETH buys run on Robinhood Chain only.
  const base = new FirstBuyPaymentReader({ client: f.client, chainId: 8453, now: () => at, fetch: async () => Response.json(f.raw) });
  await assert.rejects(base.coinQuote(f.input), /ETH buy quote could not be verified/);
});

test("LI.FI 'no route' for the coin surfaces as LifiNoRouteError, never as a verified quote", async () => {
  const f = readerFixture(); f.noRoute();
  await assert.rejects(f.reader.coinQuote(f.input), LifiNoRouteError);
});

const pairedCoin = syntheticToken({ address: coin.address, symbol: coin.symbol, quoteAddress: musegod.address, mode: "robinhood", deploymentChainId: 4663 });
function swapPreview(amountIn: bigint, amountOut = amountIn * 2n, now = at): SwapQuote {
  return { token: coin.address, side: "buy", amountIn: amountIn.toString(), amountOut: amountOut.toString(), currencyIn: musegod.address,
    poolKey: { currency0: musegod.address, currency1: coin.address, fee: 8388608, tickSpacing: 10, hooks: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544" },
    slippageBps: 100, quotedAt: now, expiresAt: now + 60_000 };
}
function serverDeps(overrides: Partial<Parameters<typeof quoteEthBuy>[1]> = {}) {
  const calls: string[] = [];
  const direct = lifiQuote(coin).q, conversion = lifiQuote(musegod, at, 10n ** 15n, 25n * 10n ** 18n).q;
  const deps: Parameters<typeof quoteEthBuy>[1] = {
    chainId: 4663,
    payments: {
      coinQuote: async (input) => { calls.push(`coin:${input.coin.address}:${input.amount}`); return direct; },
      quote: async (input) => { calls.push(`convert:${input.fromToken}:${input.toToken}:${input.amount}`); return conversion; },
    },
    token: async (address) => { calls.push(`token:${address}`); return pairedCoin; },
    swapQuote: async (token, amount, slippageBps) => { calls.push(`swap:${token}:${amount}:${slippageBps}`); return swapPreview(BigInt(conversion.minimumOut)); },
    now: () => at,
    ...overrides,
  };
  return { deps, calls, direct, conversion };
}
const request = { token: coin.address, amountIn: "0.001", account, slippageBps: 100 };

test("eth-quote returns a direct LI.FI route when one exists", async () => {
  const { deps, calls, direct } = serverDeps();
  const response = await quoteEthBuy(request, deps);
  assert.equal(response.mode, "direct");
  assert.deepEqual(response.mode === "direct" && response.quote, direct);
  assert.deepEqual(calls, [`token:${coin.address}`, `coin:${coin.address}:0.001`]);
});

test("LI.FI 'no route' turns into the two-step plan: a strict ETH → pair conversion plus the v4 quote of its minimum output", async () => {
  const { deps, calls, conversion } = serverDeps();
  deps.payments!.coinQuote = async () => { calls.push("coin"); throw new LifiNoRouteError(); };
  const response = await quoteEthBuy(request, deps);
  assert.equal(response.mode, "two-step");
  if (response.mode !== "two-step") return;
  assert.deepEqual(response.conversion, conversion);
  assert.equal(response.swapPreview.amountIn, conversion.minimumOut);
  assert.deepEqual(calls, [`token:${coin.address}`, "coin", `convert:${zeroAddress}:${musegod.address}:0.001`,
    `swap:${coin.address}:${formatUnits(BigInt(conversion.minimumOut), 18)}:100`]);
});

test("any refused direct quote falls back to the two-step plan; only provider capacity stops the quote", async () => {
  for (const failure of [new LifiNoRouteError(), new Error("LI.FI pricing or routing is unavailable. Try again later."),
    new Error("The payment provider token identity did not match the verified asset."),
    new Error("The payment route is not allowed by the verified LI.FI router."), new Error("The ETH buy quote could not be verified. Request a new quote.")]) {
    const { deps, calls, conversion } = serverDeps();
    deps.payments!.coinQuote = async () => { calls.push("coin"); throw failure; };
    const response = await quoteEthBuy(request, deps);
    assert.equal(response.mode, "two-step", failure.message);
    assert.deepEqual(response.mode === "two-step" && response.conversion, conversion, "the rejected direct quote is never returned");
    assert(calls.includes(`convert:${zeroAddress}:${musegod.address}:0.001`));
  }
  const capped = serverDeps();
  capped.deps.payments!.coinQuote = async () => { throw new BudgetUnavailable(30); };
  await assert.rejects(quoteEthBuy(request, capped.deps), BudgetUnavailable);
  assert(!capped.calls.some((call) => call.startsWith("convert") || call.startsWith("swap")));
  // A conversion that fails too surfaces its own error: there is no third path.
  const down = serverDeps();
  down.deps.payments!.coinQuote = async () => { throw new LifiNoRouteError(); };
  down.deps.payments!.quote = async () => { throw new Error("LI.FI pricing or routing is unavailable. Try again later."); };
  await assert.rejects(quoteEthBuy(request, down.deps), /routing is unavailable/);
});

test("unlisted, WETH-paired, Base and unconfigured requests are refused before any LI.FI request", async () => {
  const unlisted = serverDeps({ token: async () => { throw new Error("Platform token not found"); } });
  await assert.rejects(quoteEthBuy(request, unlisted.deps), /Platform token not found/);
  const wethPaired = serverDeps({ token: async () => ({ ...pairedCoin, quoteAddress: weth.address }) });
  await assert.rejects(quoteEthBuy(request, wethPaired.deps), (error: unknown) => error instanceof EthBuyError && error.code === "ETH_BUY_NOT_NEEDED");
  const base = serverDeps({ chainId: 8453 });
  await assert.rejects(quoteEthBuy(request, base.deps), (error: unknown) => error instanceof EthBuyError && error.code === "ETH_BUY_UNAVAILABLE");
  const unconfigured = serverDeps({ payments: null });
  await assert.rejects(quoteEthBuy(request, unconfigured.deps), (error: unknown) => error instanceof EthBuyError && error.code === "ETH_BUY_UNAVAILABLE");
  for (const { calls } of [unlisted, wethPaired, base, unconfigured]) assert(!calls.some((call) => /^(coin|convert|swap)/.test(call)), calls.join());
  for (const body of [{ ...request, slippageBps: 150 }, { ...request, amountIn: 1 }, { ...request, token: "0x123" }, { ...request, extra: true }])
    await assert.rejects(quoteEthBuy(body, serverDeps().deps), { name: "ZodError" });
});

async function httpFixture(chain: 4663 | 8453, run: (entry: ReturnType<typeof createApp>, post: (body: unknown) => Promise<Response>) => Promise<void>,
  lifi: (url: URL) => Response) {
  const realFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "eth-buy-http-"));
  // The reader binds the global fetch when the app is created; LI.FI is answered here and nothing leaves the process.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === "https://li.quest") return lifi(url);
    if (url.hostname !== "127.0.0.1") throw new Error(`Unexpected request ${url.href}`);
    return realFetch(input, init);
  }) as typeof fetch;
  const runtime = runtimeFromEnv(chain, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: String(chain), DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222" });
  const entry = createApp(undefined, "loopback", runtime);
  globalThis.fetch = realFetch;
  Object.assign(entry.service.client, { getChainId: async () => 31337, getBlock: async () => ({ number: 10n, hash: blockHash }),
    getCode: async () => runtimeCode, readContract: async ({ functionName }: { functionName: string }) => functionName === "facetAddress" ? registry.facet : true });
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const post = (body: unknown) => realFetch(`http://127.0.0.1:${address.port}/api/trade/eth-quote`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try { await run(entry, post); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); entry.service.store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("POST /api/trade/eth-quote: direct, two-step and 4xx refusals over HTTP with mocked LI.FI", async () => {
  const direct = lifiQuote(coin, Date.now()), conversion = lifiQuote(musegod, Date.now(), 2n * 10n ** 16n, 25n * 10n ** 18n);
  const lifiCalls: string[] = [];
  await httpFixture(4663, async ({ service }, post) => {
    service.token = async (address) => {
      if (address.toLowerCase() === coin.address.toLowerCase()) return pairedCoin;
      if (address.toLowerCase() === otherCoin.address.toLowerCase()) return { ...pairedCoin, address: otherCoin.address, quoteAddress: weth.address };
      throw new Error("Platform token not found");
    };
    service.quote = async (address, side, amount, slippageBps) => swapPreview(BigInt(conversion.q.minimumOut), undefined, Date.now()) as never;
    const ok = await post(request);
    assert.equal(ok.status, 200, await ok.clone().text());
    const body = await ok.json() as EthBuyQuoteResponse;
    assert.equal(body.mode, "direct");
    assert.equal(body.mode === "direct" && body.quote.toToken.address, coin.address);
    const routeless = await post({ ...request, amountIn: "0.02" });
    assert.equal(routeless.status, 200, await routeless.clone().text());
    const plan = await routeless.json() as EthBuyQuoteResponse;
    assert.equal(plan.mode, "two-step");
    assert.equal(plan.mode === "two-step" && plan.conversion.toToken.address, musegod.address);
    // A thin pool's mixed tool errors (not a clean "no route") still fall back.
    const thin = await post({ ...request, amountIn: "0.03" });
    assert.equal(thin.status, 200, await thin.clone().text());
    assert.equal((await thin.json() as EthBuyQuoteResponse).mode, "two-step");
    const unlisted = await post({ ...request, token: other });
    assert.equal(unlisted.status, 422);
    const wethPaired = await post({ ...request, token: otherCoin.address });
    assert.equal(wethPaired.status, 422);
    assert.equal((await wethPaired.json()).code, "ETH_BUY_NOT_NEEDED");
    assert.equal((await post({ ...request, slippageBps: 7 })).status, 400);
  }, (url) => {
    lifiCalls.push(`${url.searchParams.get("toToken")}:${url.searchParams.get("fromAmount")}`);
    const amount = url.searchParams.get("fromAmount");
    if (url.searchParams.get("toToken") === coin.address)
      return amount === "1000000000000000" ? Response.json(rawQuote(direct.q))
        : amount === "20000000000000000" ? Response.json(noRouteBody, { status: 404 })
        : Response.json({ ...noRouteBody, errors: { failed: [{ errorType: "NO_QUOTE", code: "INSUFFICIENT_LIQUIDITY" }, { errorType: "UNKNOWN_ERROR", code: "TOOL_TIMEOUT" }] } }, { status: 404 });
    return Response.json(rawQuote(amount === "30000000000000000" ? lifiQuote(musegod, Date.now(), 3n * 10n ** 16n, 25n * 10n ** 18n).q : conversion.q));
  });
  assert.deepEqual(lifiCalls, [`${coin.address}:1000000000000000`, `${coin.address}:20000000000000000`, `${musegod.address}:20000000000000000`,
    `${coin.address}:30000000000000000`, `${musegod.address}:30000000000000000`],
    "direct; no route then the conversion; mixed errors then the conversion; the unlisted, WETH-paired and malformed requests never reach LI.FI");
  await httpFixture(8453, async (_entry, post) => {
    const refused = await post(request);
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).code, "ETH_BUY_UNAVAILABLE");
  }, () => { throw new Error("Base never asks LI.FI for an ETH buy"); });
});

test("eth-quote is in the first-buy quote's ingress class, rate-limited and challenged like it", () => {
  for (const path of ["/api/trade/eth-quote", "/api/chains/4663/trade/eth-quote", "/api/chains/4663/trade/eth-quote/"]) {
    assert.equal(ingressClass(path), ingressClass("/api/chains/4663/first-buy/quote"), path);
    assert.equal(ingressClass(path), "workflow", path);
    assert.equal(expensiveRoute(path), true, path);
  }
  const limiter = new IngressLimiter();
  for (let i = 0; i < 17; i++) {
    const row = limiter.admit("192.0.2.30", "/api/chains/4663/trade/eth-quote", 1000 + i);
    assert.equal(row.status, undefined); assert.equal(row.challenge, i >= 16); row.release();
  }
  const capped = new IngressLimiter();
  for (let i = 0; i < 21; i++) { const row = capped.admit("192.0.2.31", "/api/trade/eth-quote", 1000 + i); assert.equal(row.status, i >= 20 ? 429 : undefined); row.release(); }
});

test("Pay with: the empty-field default, a typed amount that never changes unit, and the shortfall hint", () => {
  assert.equal(defaultPayWith(false, null), "pair", "no wallet: the read-only pair quote works");
  assert.equal(defaultPayWith(true, null), "eth", "balance not known yet");
  assert.equal(defaultPayWith(true, 0n), "eth", "no pair asset");
  assert.equal(defaultPayWith(true, 1n), "pair", "a holder");
  // The field is empty: the default follows the wallet. Typed: the default from when typing began, whatever the balance does.
  assert.equal(resolvePayWith({ choice: null, frozen: null, amount: "", fallback: "eth" }), "eth");
  assert.equal(resolvePayWith({ choice: null, frozen: "pair", amount: "", fallback: "eth" }), "eth", "clearing the field re-evaluates");
  assert.equal(resolvePayWith({ choice: null, frozen: "pair", amount: "5", fallback: "eth" }), "pair", "typed MUSEGOD stays MUSEGOD");
  assert.equal(resolvePayWith({ choice: null, frozen: "eth", amount: "5", fallback: "pair" }), "eth", "typed ETH stays ETH");
  assert.equal(resolvePayWith({ choice: "eth", frozen: "pair", amount: "5", fallback: "pair" }), "eth", "an explicit pick wins");
  assert.equal(pairShortfall(1n, 5n), true);
  assert.equal(pairShortfall(5n, 5n), false);
  assert.equal(pairShortfall(null, 5n), false, "no hint while the balance is unknown");
  assert.equal(pairShortfall(1n, null), false, "no hint for an empty or invalid amount");
  const robinhood = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663 } as RuntimeConfig;
  assert.equal(ethBuyAvailable(robinhood, musegod.address), true);
  assert.equal(ethBuyAvailable(robinhood, weth.address), false, "WETH-paired coins keep the plain panel");
  assert.equal(ethBuyAvailable({ mode: "base", chainId: 8453, deploymentChainId: 8453 } as RuntimeConfig, musegod.address), false, "Base is unchanged");
  assert.equal(ethBuyAvailable(null, musegod.address), false);
});

function transfer(token: Address, from: Address, to: Address, value: bigint) {
  return { address: token, topics: encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}
test("the received amount is the account's net Transfer of exactly that token in the receipt", () => {
  const logs = [transfer(coin.address, dex, account, 700n), transfer(coin.address, registry.diamond, account, 300n),
    transfer(coin.address, account, other, 50n), transfer(otherCoin.address, dex, account, 9_999n), transfer(coin.address, dex, other, 9_999n),
    { address: coin.address, topics: [`0x${"1".repeat(64)}`] as Hex[], data: "0x" as Hex }];
  assert.equal(receivedFromLogs(logs, coin.address, account), 950n);
  assert.equal(receivedFromLogs(logs, musegod.address, account), 0n);
  assert.equal(receivedFromLogs([], coin.address, account), 0n);
});

const pairCtx = { coin, pair: musegod, account, slippageBps: 100 };
function buyDeps(options: { pairReceived?: bigint | null; tradeError?: Error; requoteOut?: (amountIn: bigint) => bigint; swapLogs?: "fail" | bigint } = {}) {
  const calls: string[] = [], progress: string[] = [], sentQuotes: SwapQuote[] = [];
  const deps: Parameters<typeof executeEthBuy>[2] = {
    lifi: async (quote, target, step, onHash) => {
      calls.push(`lifi:${target.kind}:${quote.toToken.symbol}`); step("Confirm in your wallet"); onHash("0x02"); step("Waiting for on-chain confirmation · 0xabc");
      if (target.kind === "coin") return { hash: "0x01" as Hash, received: 4_990n * 10n ** 18n };
      return { hash: "0x02" as Hash, received: options.pairReceived === undefined ? 25_123_456_789_000_000_000n : options.pairReceived };
    },
    requote: async (amountIn) => { calls.push(`requote:${amountIn}`); return swapPreview(amountIn, (options.requoteOut ?? ((x) => x * 2n))(amountIn), Date.now()); },
    trade: async (quote) => {
      calls.push(`trade:${quote.amountIn}`); sentQuotes.push(quote);
      if (options.tradeError) throw options.tradeError;
      return "0x03" as Hash;
    },
    logs: async (hash) => {
      calls.push(`logs:${hash}`);
      if (options.swapLogs === "fail") throw new Error("receipt unavailable");
      return [transfer(coin.address, dex, account, options.swapLogs ?? 49n * 10n ** 18n)];
    },
    progress: (message) => progress.push(message),
  };
  return { deps, calls, progress, sentQuotes };
}
function twoStepPlan(now = Date.now()): EthBuyQuoteResponse & { mode: "two-step" } {
  const conversion = lifiQuote(musegod, now, 10n ** 15n, 25n * 10n ** 18n).q;
  return { mode: "two-step", conversion, swapPreview: swapPreview(BigInt(conversion.minimumOut), undefined, now) };
}

test("a direct buy is one verified LI.FI transaction and reports the coin received", async () => {
  const { deps, calls } = buyDeps();
  const result = await executeEthBuy({ mode: "direct", quote: lifiQuote(coin, Date.now()).q }, pairCtx, deps);
  assert.deepEqual(calls, ["lifi:coin:MVADER"]);
  assert.deepEqual(result, { mode: "direct", hash: "0x01", received: 4_990n * 10n ** 18n });
});

test("a two-step buy swaps exactly the pair amount the conversion delivered, re-quoted, numbered Step 1 of 3 …", async () => {
  const plan = twoStepPlan(), { deps, calls, progress, sentQuotes } = buyDeps();
  const result = await executeEthBuy(plan, pairCtx, deps);
  const received = 25_123_456_789_000_000_000n;
  assert.notEqual(BigInt(plan.swapPreview.amountIn), received, "the preview used the conversion minimum");
  assert.deepEqual(calls, ["lifi:conversion:MUSEGOD", `requote:${received}`, `trade:${received}`, "logs:0x03"]);
  assert.equal(sentQuotes[0].amountIn, received.toString());
  assert.deepEqual(result, { mode: "two-step", conversionHash: "0x02", pairReceived: received, hash: "0x03", received: 49n * 10n ** 18n });
  assert.deepEqual(progress, ["Step 1 of 3 · Confirm in your wallet", "Step 1 of 3 · Waiting for on-chain confirmation · 0xabc"]);
});

test("an unexpired preview of exactly the received amount is used as it is", async () => {
  const plan = twoStepPlan(), { deps, calls } = buyDeps({ pairReceived: BigInt(plan.swapPreview.amountIn) });
  await executeEthBuy(plan, pairCtx, deps);
  assert.deepEqual(calls, ["lifi:conversion:MUSEGOD", `trade:${plan.swapPreview.amountIn}`, "logs:0x03"]);
  const expired = twoStepPlan(Date.now() - 61_000), again = buyDeps({ pairReceived: BigInt(expired.swapPreview.amountIn) });
  await executeEthBuy(expired, pairCtx, again.deps);
  assert.deepEqual(again.calls.slice(0, 2), ["lifi:conversion:MUSEGOD", `requote:${expired.swapPreview.amountIn}`], "an expired preview is re-quoted");
});

test("the two-step minimum shown before confirming is what the swap can never go below", async () => {
  // Preview 50 coins at 1%: step 2 refuses a fresh quote under 49.5, and that quote's own swap minimum is 1% under it.
  assert.equal(twoStepMinimum(50n * 10n ** 18n, 100), 49_005n * 10n ** 15n);
  const plan = twoStepPlan(), floor = BigInt(plan.swapPreview.amountOut) * 9_900n / 10_000n;
  const worst = buyDeps({ requoteOut: () => floor });
  await executeEthBuy(plan, pairCtx, worst.deps);
  assert.equal(worst.sentQuotes.length, 1, "the floor itself is accepted");
  // That swap's own minimum (1% under the floor) is exactly the minimum shown.
  assert.equal(BigInt(worst.sentQuotes[0].amountOut) * 9_900n / 10_000n, twoStepMinimum(BigInt(plan.swapPreview.amountOut), 100));
  const below = buyDeps({ requoteOut: () => floor - 1n });
  await assert.rejects(executeEthBuy(plan, pairCtx, below.deps), EthBuyIncomplete);
  assert.equal(below.sentQuotes.length, 0);
});
test("a failed or rejected step 2 keeps the pair asset and says how to finish; a pending one says to check history", async () => {
  const rejected = buyDeps({ tradeError: new Error("User rejected the request.") });
  const failure = await executeEthBuy(twoStepPlan(), pairCtx, rejected.deps).then(() => null, (error: unknown) => error);
  assert(failure instanceof EthBuyIncomplete);
  assert.equal(failure.pairReceived, 25_123_456_789_000_000_000n);
  assert.equal(failure.pending, false);
  assert.equal(failure.message, "You received 25.12345678 MUSEGOD. Buy MVADER with MUSEGOD to finish.");
  assert.equal(rejected.calls.filter((call) => call.startsWith("trade")).length, 1, "no automatic retry");
  const pending = buyDeps({ tradeError: new Error("The transaction is still pending. Check it again in your wallet transaction history: 0x03") });
  const waiting = await executeEthBuy(twoStepPlan(), pairCtx, pending.deps).then(() => null, (error: unknown) => error);
  assert(waiting instanceof EthBuyIncomplete && waiting.pending && waiting.stage === "swap");
  assert.equal(waiting.message, "You received 25.12345678 MUSEGOD. A MUSEGOD → MVADER transaction is still pending: check your wallet transaction history before you buy again.");
  // A confirmation that changed under a reorg is pending too, never a failure to finish with the pair asset.
  const changed = buyDeps({ tradeError: new Error("The transaction confirmation changed. Check its pending status in transaction history.") });
  const reorged = await executeEthBuy(twoStepPlan(), pairCtx, changed.deps).then(() => null, (error: unknown) => error);
  assert(reorged instanceof EthBuyIncomplete && reorged.pending);
  // The price moved beyond the accepted slippage: no swap is sent.
  const moved = buyDeps({ requoteOut: (amountIn) => amountIn });
  const stopped = await executeEthBuy(twoStepPlan(), pairCtx, moved.deps).then(() => null, (error: unknown) => error);
  assert(stopped instanceof EthBuyIncomplete && !stopped.pending);
  assert(!moved.calls.some((call) => call.startsWith("trade")));
  // A conversion whose output could not be read still tells the user to finish with the pair asset, without an amount.
  const unread = buyDeps({ pairReceived: null });
  const unknown = await executeEthBuy(twoStepPlan(), pairCtx, unread.deps).then(() => null, (error: unknown) => error);
  assert(unknown instanceof EthBuyIncomplete && unknown.pairReceived === null);
  assert.equal(unknown.message, "Your ETH → MUSEGOD conversion is confirmed. Buy MVADER with MUSEGOD to finish.");
  assert(!unread.calls.some((call) => call.startsWith("trade") || call.startsWith("requote")));
});

test("a failed step 1 is a plain error, a pending one points at its hash, and an unreadable swap receipt is still a success", async () => {
  const { deps } = buyDeps();
  deps.lifi = async () => { throw new Error("User rejected the request."); };
  await assert.rejects(executeEthBuy(twoStepPlan(), pairCtx, deps), (error: unknown) => !(error instanceof EthBuyIncomplete) && /User rejected/.test(String(error)));
  const timedOut = buyDeps(), conversionHash = `0x${"4".repeat(64)}` as Hash;
  timedOut.deps.lifi = async (_quote, _target, _step, onHash) => {
    onHash(conversionHash);
    throw new Error(`The transaction is still pending. Check it again in your wallet transaction history: ${conversionHash}`);
  };
  const stuck = await executeEthBuy(twoStepPlan(), pairCtx, timedOut.deps).then(() => null, (error: unknown) => error);
  assert(stuck instanceof EthBuyIncomplete && stuck.stage === "conversion" && stuck.pending && stuck.conversionHash === conversionHash);
  assert.equal(stuck.message, "Your ETH → MUSEGOD conversion is still pending. Check it in your wallet transaction history; once it confirms, buy MVADER with MUSEGOD.");
  assert(!timedOut.calls.some((call) => /^(requote|trade)/.test(call)));
  // Pending before anything reached the wallet has no hash to point at: a plain error.
  const early = buyDeps();
  early.deps.lifi = async () => { throw new Error("The wallet request is still unresolved."); };
  await assert.rejects(executeEthBuy(twoStepPlan(), pairCtx, early.deps), (error: unknown) => !(error instanceof EthBuyIncomplete));
  const unreadable = buyDeps({ swapLogs: "fail" });
  const result = await executeEthBuy(twoStepPlan(), pairCtx, unreadable.deps);
  assert.equal(result.received, null);
  assert.equal(result.hash, "0x03");
});

test("a re-quote that does not match the received amount, coin or pair never reaches the swap", async () => {
  for (const tamper of [(q: SwapQuote) => ({ ...q, amountIn: (BigInt(q.amountIn) + 1n).toString() }), (q: SwapQuote) => ({ ...q, token: otherCoin.address }),
    (q: SwapQuote) => ({ ...q, currencyIn: weth.address }), (q: SwapQuote) => ({ ...q, side: "sell" as const }), (q: SwapQuote) => ({ ...q, slippageBps: 500 })]) {
    const { deps, calls } = buyDeps(), requote = deps.requote;
    deps.requote = async (amountIn) => tamper(await requote(amountIn));
    await assert.rejects(executeEthBuy(twoStepPlan(), pairCtx, deps), EthBuyIncomplete);
    assert(!calls.some((call) => call.startsWith("trade")));
  }
});

test("the two-step disclosure, distinct prompt labels and pending detection", () => {
  assert.equal(ethBuyDisclosure("MUSEGOD", "MVADER"),
    "No one-step route right now. This buy takes 3 steps (3 or 4 wallet confirmations): ETH → MUSEGOD, then MUSEGOD → MVADER.");
  const labels = twoStepLabels("MUSEGOD", "MVADER");
  assert.deepEqual(labels, { approve: "Step 2 of 3 · Approval 1 of 2 · Approve this MUSEGOD amount",
    router: "Step 2 of 3 · Approval 2 of 2 · Approve the trading router for MUSEGOD; it expires in 5 minutes",
    swap: "Step 3 of 3 · Confirm in your wallet: MUSEGOD → MVADER", waiting: "Step 3 of 3 · Waiting for on-chain confirmation" });
  assert.equal(new Set(Object.values(labels)).size, 4, "every wallet prompt has its own label");
  for (const message of ["The transaction is still pending. Check it again in your wallet transaction history: 0x1",
    "The transaction confirmation changed. Check its pending status in transaction history.",
    "The wallet request is still unresolved. Your saved request will not be resent."]) assert.equal(pendingOutcome(new Error(message)), true, message);
  for (const message of ["User rejected the request.", "The transaction failed. Check your transaction history."])
    assert.equal(pendingOutcome(new Error(message)), false, message);
});

function tradeDeps(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] = [transfer(coin.address, dex, account, 77n)]) {
  const calls: string[] = [];
  const deps: Parameters<typeof executeLifiTrade>[3] = {
    verify: async (quote, swaps) => { calls.push(`verify:${swaps.length}`); },
    balance: async () => { calls.push("balance"); return 10n ** 18n; },
    simulate: async () => { calls.push("simulate"); return 200_000n; },
    submit: async (quote, gas) => { calls.push(`submit:${quote.transaction.to}:${quote.transaction.value}:${gas}`); return "0x0a" as Hash; },
    logs: async () => { calls.push("logs"); return logs; },
    progress: (message) => calls.push(`progress:${message}`),
  };
  return { deps, calls };
}
test("the LI.FI trade executor verifies the frozen quote on-chain before simulating and again before the wallet request", async () => {
  const { q } = lifiQuote(coin, Date.now()), { deps, calls } = tradeDeps();
  const result = await executeLifiTrade(q, { kind: "coin", coin }, account, deps, "Confirm in your wallet: ETH → MVADER");
  assert.deepEqual(result, { hash: "0x0a", received: 77n });
  assert.deepEqual(calls, ["verify:2", "balance", "simulate", "verify:2", "progress:Confirm in your wallet: ETH → MVADER",
    `submit:${registry.diamond}:${q.transaction.value}:200000`, "logs"]);
  const empty = tradeDeps([]);
  assert.equal((await executeLifiTrade(q, { kind: "coin", coin }, account, empty.deps, "Confirm")).received, null, "nothing received is unknown, not zero");
});

test("the LI.FI trade executor refuses tampered, foreign or mismatched quotes before any wallet or RPC step", async () => {
  const now = Date.now(), { q, swaps, encode } = lifiQuote(coin, now), conversion = lifiQuote(musegod, now).q;
  const refused: [string, FirstBuyPaymentQuote, Parameters<typeof executeLifiTrade>[1], Address][] = [
    ["receiver", { ...q, transaction: { ...q.transaction, data: encode(swaps, other) } }, { kind: "coin", coin }, account],
    ["another coin", q, { kind: "coin", coin: otherCoin }, account],
    ["another account", q, { kind: "coin", coin }, other],
    ["a coin quote as a conversion", q, { kind: "conversion", pair: musegod }, account],
    ["a conversion as a coin buy", conversion, { kind: "coin", coin }, account],
    ["a conversion into another pair", conversion, { kind: "conversion", pair: firstBuyPairedAsset(4663, ROBINHOOD_STOCKS.find((asset) => asset.symbol === "USDG")!.address) }, account],
    ["expired", { ...q, quotedAt: now - 70_000, expiresAt: now - 10_000 }, { kind: "coin", coin }, account],
  ];
  for (const [name, quote, target, wallet] of refused) {
    const { deps, calls } = tradeDeps();
    await assert.rejects(executeLifiTrade(quote, target, wallet, deps, "Confirm"), Error, name);
    assert.deepEqual(calls, [], name);
  }
  const poor = tradeDeps(); poor.deps.balance = async () => 1n;
  await assert.rejects(executeLifiTrade(q, { kind: "coin", coin }, account, poor.deps, "Confirm"), /Not enough ETH/);
  assert(!poor.calls.includes("simulate"));
  const converted = tradeDeps([transfer(musegod.address, dex, account, 12n)]);
  assert.equal((await executeLifiTrade(conversion, { kind: "conversion", pair: musegod }, account, converted.deps, "Confirm")).received, 12n);
});

test("the client accepts only a quote response for this coin, pair, wallet, amount and slippage", () => {
  resetQuoteClock();
  const now = Date.now(), expected = { coin, pair: musegod, account, amountIn: 10n ** 15n, slippageBps: 100 };
  const direct: EthBuyQuoteResponse = { mode: "direct", quote: lifiQuote(coin, now).q };
  assert.deepEqual(assertEthBuyResponse(direct, expected), direct);
  const plan = twoStepPlan(now);
  assert.deepEqual(assertEthBuyResponse(plan, expected), plan);
  for (const [name, value, overrides] of [
    ["another coin", { mode: "direct", quote: lifiQuote(otherCoin, now).q }, {}],
    ["another account", direct, { account: other }],
    ["another amount", direct, { amountIn: 2n * 10n ** 15n }],
    ["another slippage", direct, { slippageBps: 200 }],
    ["preview of another amount", { ...plan, swapPreview: { ...plan.swapPreview, amountIn: "1" } }, {}],
    ["preview of another coin", { ...plan, swapPreview: { ...plan.swapPreview, token: otherCoin.address } }, {}],
    ["conversion into another pair", { ...plan, conversion: lifiQuote(firstBuyPairedAsset(4663, ROBINHOOD_STOCKS.find((asset) => asset.symbol === "USDG")!.address), now).q }, {}],
    ["unknown mode", { mode: "bridge", quote: direct.quote }, {}],
  ] as [string, unknown, Partial<typeof expected>][])
    assert.throws(() => assertEthBuyResponse(value, { ...expected, ...overrides }), Error, name);
});
