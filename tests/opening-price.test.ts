import assert from "node:assert/strict";
import test from "node:test";
import { zeroAddress, type PublicClient, type Transport } from "viem";
import { ROBINHOOD_STOCKS, STOCKS, sameAddress, type Stock } from "../src/lib/config";
import { firstBuyPaymentAssets, firstBuyPairedAsset, wrappedEther, type FirstBuyPaymentAsset } from "../src/lib/first-buy-payment";
import { LAUNCH_PRICE_TTL, OPENING_POLICY, BASE_OPENING_POLICY, assertOpeningValuation, assertHistoricalOpeningValuation, type BaseLifiOpeningEvidence } from "../src/lib/opening-valuation";
import { assertLaunchPlanValidity, LAUNCH_SIGNING_TTL, type LaunchPlan } from "../src/lib/launch-plan";
import { LIFI_OPENING_PROBE_ACCOUNT, readOpeningValuation } from "../server/opening-price";

const NOW = 1_800_000_000_000, BLOCK = 100n, HASH = `0x${"ab".repeat(32)}` as const;
const baseStock = STOCKS.find((asset) => asset.ticker === "NVDA")!;
const rhStock = ROBINHOOD_STOCKS.find((asset) => asset.ticker === "NVDA")!;
const usd = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "USDG")!;
function fixture(stock: Stock = baseStock) {
  const chainId = stock.chainId as 8453 | 4663;
  const assets = firstBuyPaymentAssets(chainId, stock.address);
  const stable = assets.find((asset) => asset.symbol === (chainId === 8453 ? "USDC" : "USDG"))!;
  const numeraire = sameAddress(stable.address, stock.address) ? assets.find((asset) => asset.address === zeroAddress)! : stable;
  const weth = firstBuyPairedAsset(chainId, wrappedEther(chainId));
  const source = { ...numeraire }, paired: FirstBuyPaymentAsset = { chainId, address: stock.address, symbol: stock.symbol, decimals: stock.decimals };
  const requests: URL[] = [], rpc: string[] = [];
  const state = { now: NOW, rpcChainId: chainId as number, canonicalHash: HASH as string, code: "0xef", symbol: stock.symbol,
    sizingPrice: "2500", buyReference: source.symbol === "ETH" ? "2500" : "0.98", sellReference: source.symbol === "ETH" ? "2500" : "0.98",
    quoteDelay: 0, rpcError: false };
  let mutate: (quote: any, leg: "buy" | "sell" | "reference") => void = () => {};
  const client = {
    async getChainId() { return state.rpcChainId; },
    async getBlock(options: { blockTag?: string; blockNumber?: bigint }) {
      rpc.push("getBlock");
      if (state.rpcError) throw new Error("https://rpc.invalid/private-server-key");
      return { number: BLOCK, hash: options.blockNumber === undefined ? HASH : state.canonicalHash, timestamp: BigInt(NOW / 1000) };
    },
    async getCode(options: { blockNumber?: bigint }) { assert.equal(options.blockNumber, BLOCK); rpc.push("getCode"); return state.code; },
    async readContract(options: { address: string; functionName: string; blockNumber: bigint }) {
      assert.equal(options.blockNumber, BLOCK); rpc.push(options.functionName);
      const asset = sameAddress(options.address, paired.address) ? paired : sameAddress(options.address, weth.address) ? weth : source;
      if (options.functionName === "symbol") return sameAddress(options.address, paired.address) ? state.symbol : asset.symbol;
      if (options.functionName === "decimals") return asset.decimals;
      throw new Error("Retired oracle entry must not be read");
    },
  } as unknown as PublicClient<Transport, any>;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url);
    assert.equal(url.origin, "https://li.quest"); assert.equal(init?.redirect, "manual");
    if (url.pathname.endsWith("/token")) {
      assert.equal(source.address, zeroAddress);
      return new Response(JSON.stringify({ ...source, priceUSD: state.sizingPrice }));
    }
    assert.equal(url.pathname, "/v1/quote");
    assert.equal(url.searchParams.get("fromChain"), String(chainId)); assert.equal(url.searchParams.get("toChain"), String(chainId));
    assert.equal(url.searchParams.get("fromAddress"), LIFI_OPENING_PROBE_ACCOUNT);
    assert.equal(url.searchParams.get("toAddress"), LIFI_OPENING_PROBE_ACCOUNT);
    assert.equal(url.searchParams.get("allowBridges"), "none"); assert.equal(url.searchParams.get("skipSimulation"), "false");
    assert.equal(url.searchParams.get("fee"), "0"); assert.equal(url.searchParams.get("slippage"), "0.01");
    const leg = sameAddress(url.searchParams.get("fromToken")!, source.address) ? "buy"
      : sameAddress(url.searchParams.get("fromToken")!, weth.address) ? "reference" : "sell";
    const from = leg === "buy" ? source : leg === "reference" ? weth : paired;
    const to = leg === "buy" ? paired : chainId === 8453 && leg === "sell" ? weth : source;
    assert(sameAddress(url.searchParams.get("toToken")!, to.address));
    const inputAmount = BigInt(url.searchParams.get("fromAmount")!), feeAmount = inputAmount / 400n, net = inputAmount - feeAmount;
    const pairedPrice = source.symbol === "ETH" ? 1n : 300n;
    const assetPrice = (asset: FirstBuyPaymentAsset) => sameAddress(asset.address, source.address)
      ? source.symbol === "ETH" ? 2500n : 1n : sameAddress(asset.address, weth.address) ? 2500n : pairedPrice;
    const output = net * assetPrice(from) * 10n ** BigInt(to.decimals) / (assetPrice(to) * 10n ** BigInt(from.decimals));
    const reference = leg === "buy" ? state.buyReference : state.sellReference;
    const metadata = (asset: FirstBuyPaymentAsset) => ({ ...asset,
      priceUSD: sameAddress(asset.address, source.address) ? reference : sameAddress(asset.address, weth.address) ? "999999" : String(pairedPrice) });
    const action = { fromChainId: chainId, toChainId: chainId, fromToken: metadata(from), toToken: metadata(to),
      fromAddress: LIFI_OPENING_PROBE_ACCOUNT, toAddress: LIFI_OPENING_PROBE_ACCOUNT, fromAmount: inputAmount.toString(), slippage: 0.01 };
    const raw = { id: `opening-${leg}`, tool: "nordstern", action,
      estimate: { fromAmount: inputAmount.toString(), toAmount: output.toString(), toAmountMin: (output * 9900n / 10000n).toString(),
        feeCosts: [{ name: "LIFI Fixed Fee", included: true, amount: feeAmount.toString(), token: metadata(from),
          feeSplit: { integratorFee: "0", lifiFee: feeAmount.toString() } }], gasCosts: [{ amountUSD: "1000000" }] },
      includedSteps: [{ type: "swap", action: structuredClone(action) }], transactionRequest: {
        chainId, from: LIFI_OPENING_PROBE_ACCOUNT, to: "0x2222222222222222222222222222222222222222",
        data: "0x12345678", value: from.address === zeroAddress ? `0x${inputAmount.toString(16)}` : "0x0" } };
    mutate(raw, leg); state.now += state.quoteDelay;
    return new Response(JSON.stringify(raw));
  };
  return { stock, source, paired, chainId, state, requests, rpc, client, fetcher,
    setMutate(value: typeof mutate) { mutate = value; },
    read(extra: Parameters<typeof readOpeningValuation>[3] = {}) { return readOpeningValuation(client, stock, chainId, { fetch: fetcher, now: () => state.now, ...extra }); } };
}

test("Base uses USDC/B20/WETH with executable shared USD reference and RH retains its 100-unit probes", async () => {
  for (const stock of [baseStock, rhStock]) {
    const f = fixture(stock), result = await f.read();
    assert.equal(result.policy, stock.chainId === 8453 ? BASE_OPENING_POLICY : OPENING_POLICY); assert.equal(result.source, "LI.FI"); assert.equal(result.marketCapUsd, 5000);
    assert(Math.abs(Number(result.quotePriceUsd) - 294) < 1e-9); assert.equal(result.lifi.numeraire.priceUsd, "0.98", "stable is not forced to USD1");
    assert.equal(result.lifi.askNumerairePerQuoteToken, "300"); assert(Math.abs(Number(result.lifi.bidNumerairePerQuoteToken) - (stock.chainId === 8453 ? 0.12 : 300)) < 1e-12);
    assert.equal(result.lifi.probeAmountIn, stock.chainId === 8453 ? "10000000" : "100000000"); assert.equal(result.lifi.sell.amountIn, result.lifi.buy.amountOut);
    assert.equal(result.lifi.buy.lifiFee, stock.chainId === 8453 ? "25000" : "250000"); assert.equal(result.lifi.divergenceBps, 0);
    assert.equal(result.quotedAt, NOW); assert.equal(result.sourceUpdatedAt, NOW); assert.equal(result.expiresAt, NOW + LAUNCH_PRICE_TTL);
    assert.equal(result.blockNumber, String(BLOCK)); assert.equal(result.blockHash, HASH); assert.equal(f.requests.length, stock.chainId === 8453 ? 3 : 2);
    assert(!JSON.stringify(result).includes("transactionRequest")); assert(!JSON.stringify(result).includes("gasCosts"));
    assert(f.rpc.every((name) => ["getBlock", "getCode", "symbol", "decimals", "assetFeeds"].includes(name)), "independent reference stays advisory");
  }
});

test("USDG self-pair uses ETH token API sizing near USD100 and native-token quote references", async () => {
  const f = fixture(usd), result = await f.read();
  assert.equal(result.lifi.numeraire.address, zeroAddress); assert.equal(result.lifi.numeraire.decimals, 18);
  assert.equal(result.lifi.probeUsd, "100"); assert.equal(result.lifi.probeSizingPriceUsd, "2500");
  assert.equal(result.lifi.probeAmountIn, "40000000000000000"); assert.equal(result.quotePriceUsd, "1");
  assert.equal(f.requests.length, 3); assert.equal(f.requests[0].pathname, "/v1/token");
  const absent = fixture(usd); absent.state.sizingPrice = "0";
  await assert.rejects(absent.read(), /fixed same-chain price probe/); assert.equal(absent.requests.length, 1);
});

test("minOut and gas do not determine price; each quote's own numeraire USD reference is retained", async () => {
  const f = fixture(rhStock); f.state.sellReference = "0.99";
  f.setMutate((quote) => { quote.estimate.toAmountMin = quote.estimate.toAmount; });
  const result = await f.read();
  assert.equal(result.quotePriceUsd, "295.5"); assert.equal(result.lifi.buy.numerairePriceUsd, "0.98");
  assert.equal(result.lifi.sell.numerairePriceUsd, "0.99"); assert.equal(result.lifi.divergenceBps, 102);
});

test("small crossed quotes pass; wide divergence is disclosed without rejecting valid evidence", async () => {
  const small = fixture(); small.setMutate((quote, leg) => { if (leg === "sell") { quote.estimate.toAmount = (BigInt(quote.estimate.toAmount) * 1001n / 1000n).toString(); quote.estimate.toAmountMin = (BigInt(quote.estimate.toAmount) * 9900n / 10000n).toString(); } });
  const price = await small.read(); assert(price.lifi.divergenceBps > 0 && price.lifi.divergenceBps < 20);
  const wide = fixture(); wide.setMutate((quote, leg) => { if (leg === "sell") { quote.estimate.toAmount = (BigInt(quote.estimate.toAmount) * 110n / 100n).toString(); quote.estimate.toAmountMin = (BigInt(quote.estimate.toAmount) * 9900n / 10000n).toString(); } });
  const widePrice = await wide.read(); assert(widePrice.lifi.divergenceBps > 500);
  assert.equal(widePrice.warnings?.[0]?.code, "opening_spread");
});

test("token identity, exact quantities, actors, slippage and same-chain paths reject tampered provider data", async () => {
  const mutations = [
    (q: any) => { q.action.fromChainId = 8453; }, (q: any) => { q.action.toChainId = 8453; },
    (q: any) => { q.action.fromToken.chainId = 8453; }, (q: any) => { q.action.toToken.decimals++; },
    (q: any) => { q.action.toToken.symbol = "wrong"; }, (q: any) => { q.action.toToken.address = zeroAddress; },
    (q: any) => { q.action.fromAddress = zeroAddress; }, (q: any) => { q.action.toAddress = zeroAddress; },
    (q: any) => { q.action.fromAmount = "1"; }, (q: any) => { q.estimate.fromAmount = "1"; },
    (q: any) => { q.action.slippage = 0.05; }, (q: any) => { q.includedSteps[0].type = "bridge"; },
    (q: any) => { q.includedSteps[0].action.toChainId = 8453; },
    (q: any) => { q.includedSteps[0].action.toToken.chainId = 8453; },
    (q: any) => { q.estimate.toAmount = "0"; }, (q: any) => { q.estimate.toAmountMin = "0"; },
    (q: any) => { q.estimate.toAmountMin = (BigInt(q.estimate.toAmount) + 1n).toString(); },
    (q: any) => { q.estimate.toAmountMin = (BigInt(q.estimate.toAmount) / 2n).toString(); },
    (q: any) => { q.action.fromToken.priceUSD = "0"; }, (q: any) => { q.action.fromToken.priceUSD = undefined; },
    (q: any) => { q.action.fromToken.priceUSD = "0.1234567890123456789"; },
    (q: any) => { q.transactionRequest.chainId = 8453; },
    (q: any) => { q.transactionRequest.from = zeroAddress; },
    (q: any) => { q.transactionRequest.to = zeroAddress; },
    (q: any) => { q.transactionRequest.data = "0x"; },
    (q: any) => { q.transactionRequest.data = "0x123456"; },
    (q: any) => { q.transactionRequest.value = "0x1"; },
    (q: any) => { q.includedSteps[0].action.fromToken.symbol = "Other"; },
    (q: any) => { q.includedSteps[0].action.toToken.address = zeroAddress; },
  ];
  for (const mutate of mutations) { const f = fixture(rhStock); f.setMutate((q, leg) => { if (leg === "buy") mutate(q); }); await assert.rejects(f.read(), /fixed same-chain price probe/); assert.equal(f.requests.length, 1); }
  const sell = fixture(rhStock); sell.setMutate((q, leg) => { if (leg === "sell") q.action.toToken.priceUSD = "0"; });
  await assert.rejects(sell.read(), /fixed same-chain price probe/);
});

test("unknown, non-source, commission, duplicate and excessive fee costs fail closed", async () => {
  const mutations = [
    (f: any) => { f.name = "Other Fee"; }, (f: any) => { f.included = false; },
    (f: any) => { f.token.address = zeroAddress; }, (f: any) => { f.token.chainId = 4663; },
    (f: any) => { f.feeSplit.integratorFee = "1"; }, (f: any) => { f.feeSplit.lifiFee = "1"; },
    (f: any) => { f.amount = "100000000"; f.feeSplit.lifiFee = f.amount; },
  ];
  for (const change of mutations) { const f = fixture(); f.setMutate((q) => change(q.estimate.feeCosts[0])); await assert.rejects(f.read(), /fixed same-chain price probe/); }
  const duplicate = fixture(); duplicate.setMutate((q) => q.estimate.feeCosts.push(structuredClone(q.estimate.feeCosts[0])));
  await assert.rejects(duplicate.read(), /fixed same-chain price probe/);
});

test("earliest request limits both probes, including network and final identity-read delays", async () => {
  const f = fixture(rhStock); f.state.quoteDelay = 20_000; const result = await f.read();
  assert.equal(result.lifi.buy.quotedAt, NOW); assert.equal(result.lifi.sell.quotedAt, NOW + 20_000);
  assert.equal(result.expiresAt, NOW + 60_000); assert.equal(result.lifi.sell.obtainedAt, NOW + 40_000);
  const slow = fixture(rhStock); slow.state.quoteDelay = 30_000;
  await assert.rejects(slow.read(), /expired/);
  const final = fixture(); const getBlock = final.client.getBlock;
  final.client.getBlock = (async (options: any) => { if (options.blockNumber !== undefined) final.state.now += LAUNCH_PRICE_TTL; return getBlock(options); }) as any;
  await assert.rejects(final.read(), /expired/);
});

test("fork identity RPC requires explicit31337 and canonical token metadata; no mainnet fallback", async () => {
  const f = fixture(); f.state.rpcChainId = 31337;
  await assert.rejects(f.read(), /RPC does not match/); assert.equal(f.requests.length, 0);
  const result = await f.read({ rpcChainId: 31337 }); assert.equal(result.chainId, 8453); assert.equal(result.blockHash, HASH);
  const wrong = fixture(); wrong.state.rpcChainId = 4663;
  await assert.rejects(wrong.read(), /RPC does not match/); assert.equal(wrong.requests.length, 0);
  const code = fixture(); code.state.code = "0x"; await assert.rejects(code.read(), /token identity/);
  const name = fixture(); name.state.symbol = "unknown"; await assert.rejects(name.read(), /token identity/);
  const reorg = fixture(); reorg.state.canonicalHash = `0x${"cd".repeat(32)}`;
  await assert.rejects(reorg.read(), /identity block changed/);
});

test("HTTP failures never fall back to retired sources or expose key/redirect response data", async () => {
  const secret = "TEST_SERVER_KEY_ONLY";
  for (const status of [307, 401, 404, 429, 503]) {
    const f = fixture(); let calls = 0;
    await assert.rejects(f.read({ apiKey: secret, fetch: async (_input, init) => { calls++; assert.equal(init?.redirect, "manual"); assert.equal(new Headers(init?.headers).get("x-lifi-api-key"), secret); return new Response(secret, { status, headers: { location: "https://other.invalid" } }); } }), (error: unknown) => error instanceof Error && /routing is unavailable|capacity is temporarily limited/.test(error.message) && !error.message.includes(secret));
    assert.equal(calls, 1); assert(!f.rpc.some((name) => name.includes("oracle")));
  }
  const rawError = fixture(); await assert.rejects(rawError.read({ apiKey: secret, fetch: async () => { throw new Error(`https://private.invalid/${secret}`); } }), (error: unknown) => error instanceof Error && !error.message.includes(secret));
  const reflected = fixture(); reflected.setMutate((q) => { q.id = secret; });
  await assert.rejects(reflected.read({ apiKey: secret }), /fixed same-chain price probe/);
  const noKey = fixture(); await noKey.read({ apiKey: "" });
});


test("Base v2 records all three token identities and rejects currency, reference and derived-price tampering", async () => {
  const f = fixture(), snapshot = await f.read(), e = snapshot.lifi as BaseLifiOpeningEvidence;
  assert.equal(e.evidenceVersion, 2); assert.equal(e.probeUnits, "10"); assert.equal(e.fallbackReason, undefined);
  assert.equal(e.buy.fromToken.symbol, "USDC"); assert.equal(e.buy.fromToken.decimals, 6);
  assert.equal(e.buy.toToken.symbol, baseStock.symbol); assert.equal(e.sell.fromToken.decimals, 8);
  assert.equal(e.sell.toToken.symbol, "WETH"); assert.equal(e.sell.toToken.decimals, 18);
  assert.equal(e.sellNumeraire.priceUsd, "2450", "derived from executable USDC output and its 0.98 USD reference, ignoring metadata WETH=999999");
  assert.equal(e.wethUsdReference.amountIn, "10000000000000000");
  for (const mutate of [
    (value: BaseLifiOpeningEvidence) => { value.buy.fromToken.decimals = 18; },
    (value: BaseLifiOpeningEvidence) => { value.sell.toToken.address = zeroAddress; },
    (value: BaseLifiOpeningEvidence) => { value.sellNumeraire.priceUsd = "999999"; },
    (value: BaseLifiOpeningEvidence) => { value.sell.numerairePriceUsd = "999999"; },
    (value: BaseLifiOpeningEvidence) => { value.wethUsdReference.toToken.symbol = "USDG"; },
    (value: BaseLifiOpeningEvidence) => { value.wethUsdReference.amountIn = "1000000000000000"; },
    (value: BaseLifiOpeningEvidence) => { value.wethUsdReference.amountOut = "1"; },
    (value: BaseLifiOpeningEvidence) => { value.wethUsdReference.lifiFee = value.wethUsdReference.amountIn; },
    (value: BaseLifiOpeningEvidence) => { value.wethUsdReference.expiresAt++; },
    (value: BaseLifiOpeningEvidence) => { value.probeUnits = "100"; },
    (value: BaseLifiOpeningEvidence) => { value.fallbackReason = "no_route"; },
  ]) {
    const copy = structuredClone(snapshot); mutate(copy.lifi as BaseLifiOpeningEvidence);
    assert.throws(() => assertOpeningValuation(copy, baseStock.address, 8453, NOW), /evidence/);
  }
  assert.throws(() => assertOpeningValuation({ ...snapshot, chainId: 4663 }, baseStock.address, 4663, NOW), /evidence/);
  assert.throws(() => assertOpeningValuation(snapshot, baseStock.address, 8453, snapshot.expiresAt), /expired/);
  assert.doesNotThrow(() => assertHistoricalOpeningValuation(snapshot, baseStock.address, 8453, NOW + 86_400_000));
});

test("Base retries the full 100-USDC round trip only after a classified genuine no-route buy or sell", async () => {
  for (const failedLeg of ["buy", "sell"] as const) {
    const f = fixture(), calls: URL[] = []; let failed = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      const leg = sameAddress(url.searchParams.get("fromToken")!, f.source.address) ? "buy"
        : sameAddress(url.searchParams.get("fromToken")!, f.paired.address) ? "sell" : "reference";
      if (leg === failedLeg && !failed) {
        failed = true;
        return new Response(JSON.stringify({ code: 1002, errors: [{ errorType: "NO_QUOTE", code: "NO_POSSIBLE_ROUTE" }] }), { status: 404 });
      }
      return f.fetcher(input, init);
    };
    const result = await f.read({ fetch: fetcher }), evidence = result.lifi as BaseLifiOpeningEvidence;
    assert.equal(evidence.probeUnits, "100"); assert.equal(evidence.fallbackReason, "no_route");
    assert.equal(evidence.probeAmountIn, "100000000"); assert.equal(evidence.sell.amountIn, evidence.buy.amountOut);
    const buys = calls.filter((url) => sameAddress(url.searchParams.get("fromToken")!, f.source.address));
    assert.deepEqual(buys.map((url) => url.searchParams.get("fromAmount")), ["10000000", "100000000"]);
  }
});

test("Base capacity, authorization, transient tool and malformed failures never trigger 100-USDC probes", async () => {
  for (const [status, body] of [
    [429, { code: 1005 }], [401, { code: 1010 }], [400, { code: 1011 }], [404, { code: 1003 }],
    [503, { code: 1002 }], [404, { code: 1002, errors: [{ errorType: "NO_QUOTE", code: "TOOL_TIMEOUT" }] }],
    [404, { code: 1002, errors: [{ errorType: "NO_QUOTE", code: "RPC_ERROR" }] }],
    [404, { code: 1002, errors: [{ errorType: "NO_QUOTE", code: "NO_POSSIBLE_ROUTE" }, { errorType: "NO_QUOTE", code: "UNKNOWN_ERROR" }] }],
  ] as const) {
    const f = fixture(), buys: string[] = [];
    await assert.rejects(f.read({ fetch: async (input, init) => {
      const url = new URL(String(input));
      if (sameAddress(url.searchParams.get("fromToken")!, f.source.address)) {
        buys.push(url.searchParams.get("fromAmount")!);
        return new Response(JSON.stringify(body), { status, headers: { "retry-after": "12" } });
      }
      return f.fetcher(input, init);
    } }));
    assert.deepEqual(buys, ["10000000"]);
  }
  const malformed = fixture(); malformed.setMutate((quote, leg) => { if (leg === "sell") quote.estimate.toAmount = "0"; });
  await assert.rejects(malformed.read(), /fixed same-chain price probe/);
  assert.equal(malformed.requests.length, 3);
});

test("Base WETH reference is single-flight, immutable to callers, and bounds snapshot expiry without refreshing its time", async () => {
  const f = fixture();
  const [first, parallel] = await Promise.all([f.read(), f.read()]);
  assert.equal(f.requests.filter((url) => sameAddress(url.searchParams.get("fromToken")!, wrappedEther(8453))).length, 1);
  assert.equal(f.requests.length, 5, "only USD reference is shared; both complete paired-asset routes are fresh");
  const firstEvidence = first.lifi as BaseLifiOpeningEvidence;
  firstEvidence.wethUsdReference.amountOut = "1";
  f.state.now += 5_000;
  const next = await f.read(), e = next.lifi as BaseLifiOpeningEvidence;
  assert.notEqual(e.wethUsdReference.amountOut, "1"); assert.notEqual((parallel.lifi as BaseLifiOpeningEvidence).wethUsdReference.amountOut, "1");
  assert.equal(e.buy.quotedAt, NOW + 5_000); assert.equal(e.wethUsdReference.quotedAt, NOW);
  assert.equal(next.quotedAt, NOW); assert.equal(next.expiresAt, NOW + LAUNCH_PRICE_TTL);
  assert.equal(f.requests.length, 7);
  f.state.now = NOW + LAUNCH_PRICE_TTL;
  const renewed = await f.read(); assert.equal(f.requests.length, 10); assert.equal(renewed.quotedAt, NOW + LAUNCH_PRICE_TTL);
  const slow = fixture(); slow.state.quoteDelay = 20_000;
  await assert.rejects(slow.read(), /expired/);
});


test("Base v2 freezes a fresh three-leg price for the existing five-minute signing window", async () => {
  const f = fixture(), openingValuation = await f.read();
  const finalizedAt = NOW + 1_000;
  const plan = { draft: { quoteAddress: baseStock.address }, openingValuation,
    preparedAt: finalizedAt, finalizedAt, validityVersion: 2, signingExpiresAt: finalizedAt + LAUNCH_SIGNING_TTL,
    serverTime: finalizedAt, intentId: "base-v2-test-intent" } as LaunchPlan;
  assert.doesNotThrow(() => assertLaunchPlanValidity(plan, 8453, NOW + 120_000));
  assert.doesNotThrow(() => assertLaunchPlanValidity(plan, 8453, plan.signingExpiresAt! - 1));
  assert.throws(() => assertLaunchPlanValidity(plan, 8453, plan.signingExpiresAt!), /signing window expired/);
  assert.throws(() => assertLaunchPlanValidity({ ...plan, finalizedAt: openingValuation.expiresAt, preparedAt: openingValuation.expiresAt,
    signingExpiresAt: openingValuation.expiresAt + LAUNCH_SIGNING_TTL, serverTime: openingValuation.expiresAt }, 8453, openingValuation.expiresAt), /price expired/);
});
