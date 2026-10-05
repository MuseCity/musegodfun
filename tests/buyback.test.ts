import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, encodeFunctionResult, decodeFunctionData, encodeAbiParameters, encodeEventTopics, hashTypedData, parseAbi, erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BuybackError, BuybackReader, validateRelayExecution, approvalProxyAbi, RELAY_ROUTER } from "../server/buyback";
import { BuybackBatchService } from "../server/buyback-batches";
import { buybackAuthorizationTypedData, type BuybackQuote, type BuybackAuthorization } from "../src/lib/buyback";
import { STOCKS } from "../src/lib/config";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";

const treasury = "0x1111111111111111111111111111111111111111";
const stranger = "0x2222222222222222222222222222222222222222";
const stock = STOCKS[0];
const proxy = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
const eth = "0x0000000000000000000000000000000000000000";
const now = 1_800_000_000_000;
const requestId = `0x${"a".repeat(64)}`;
const input = { stockAddress: stock.address, amount: "0.01" };
const kyberTestAbi = parseAbi([
  "function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256 returnAmount,uint256 gasUsed)",
]);

function fixture(): any {
  return {
    requestId,
    details: {
      operation: "swap", sender: treasury, recipient: treasury,
      currencyIn: { currency: { chainId: 8453, address: stock.address, decimals: 8 },
        amount: "1000000", minimumAmount: "1000000" },
      currencyOut: { currency: { chainId: 4663, address: MUSEGOD_BUYBACK.tokenAddress, decimals: 18 },
        amount: "1000000000000000000000", minimumAmount: "990000000000000000000" },
      slippageTolerance: { total: "100" }, totalImpact: { percent: "-2.25" },
    },
    fees: { app: { amount: "0" }, relayer: { amountUsd: "0.03" }, gas: { amountUsd: "0.001" } },
    protocol: { v2: { orderData: {
      version: "v1", solverChainId: "base", fees: [],
      inputs: [{ refunds: [
        { chainId: "base", recipient: treasury, currency: eth, minimumAmount: "0", deadline: now / 1000 + 300 },
        { chainId: "robinhood", recipient: treasury, currency: eth, minimumAmount: "0", deadline: now / 1000 + 300 },
      ] }],
      output: { chainId: "robinhood", calls: [], deadline: now / 1000 + 300,
        payments: [{ recipient: treasury, currency: MUSEGOD_BUYBACK.tokenAddress,
          expectedAmount: "1000000000000000000000", minimumAmount: "990000000000000000000" }] },
    } } },
    steps: [
      { id: "approve", requestId, kind: "transaction", items: [{ data: {
        from: treasury, to: stock.address, chainId: 8453, value: "0",
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, 1000000n] }),
      } }] },
      { id: "deposit", requestId, kind: "transaction", items: [{ data: {
        from: treasury, to: proxy, chainId: 8453, value: "0", data: "0xf9e4bab40000",
      } }] },
    ],
  };
}
function mock(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}
function reader(body = fixture()) {
  return new BuybackReader(treasury, { fetch: mock(body), now: () => now });
}
function hasCode(code: string) {
  return (error: unknown) => error instanceof BuybackError && error.code === code;
}

test("buyback preview fixes treasury, assets, refund, precision and 60s expiry without exposing executable data", async () => {
  let request: any;
  const fetcher: typeof fetch = (async (url, options) => {
    assert.equal(url, "https://api.relay.link/quote/v2");
    request = JSON.parse(options!.body as string);
    return new Response(JSON.stringify(fixture()));
  }) as typeof fetch;
  const quote = await new BuybackReader(treasury, { fetch: fetcher, now: () => now }).quote(input);
  assert.equal(request.user, treasury);
  assert.equal(request.recipient, treasury);
  assert.equal(request.refundTo, treasury);
  assert.equal(request.tradeType, "EXACT_INPUT");
  assert.equal(request.slippageTolerance, "100");
  assert.equal(request.amount, "1000000");
  assert.equal(request.includeProtocolData, true);
  assert.equal(request.referrer, undefined);
  assert.equal(quote.expiresAt - quote.quotedAt, 60_000);
  assert.equal(quote.expectedOutFormatted, "1000");
  assert.equal(quote.minimumOutFormatted, "990");
  assert.equal(quote.destinationRecipient, treasury);
  assert.equal(quote.requiresSeparateBurn, true);
  assert.equal(quote.executionAvailable, false);
  for (const forbidden of ["steps", "data", "protocol", "orderData", "signature"])
    assert.equal(Object.hasOwn(quote, forbidden), false);
  assert.equal(JSON.stringify(quote).includes("f9e4bab4"), false);
});

test("buyback rejects unconfigured treasury, unknown stock, invalid precision and non-positive amounts before fetching", async () => {
  let calls = 0;
  const fetcher: typeof fetch = (async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
  await assert.rejects(new BuybackReader(null, { fetch: fetcher }).quote(input), hasCode("TREASURY_UNAVAILABLE"));
  const service = new BuybackReader(treasury, { fetch: fetcher });
  for (const amount of ["0", "-1", "1e8", "0.000000001", "1.234567891", "Infinity", " 1", "01", "1."])
    await assert.rejects(service.quote({ ...input, amount }), hasCode("INVALID_INPUT"));
  await assert.rejects(service.quote({ ...input, stockAddress: stranger }), hasCode("INVALID_INPUT"));
  assert.equal(calls, 0);
});

const hostile: [string, (body: any) => void][] = [
  ["recipient", (b) => { b.details.recipient = stranger; }],
  ["sender", (b) => { b.details.sender = stranger; }],
  ["source chain", (b) => { b.details.currencyIn.currency.chainId = 1; }],
  ["source token", (b) => { b.details.currencyIn.currency.address = stranger; }],
  ["source precision", (b) => { b.details.currencyIn.currency.decimals = 18; }],
  ["source amount", (b) => { b.details.currencyIn.amount = "1000001"; }],
  ["source minimum", (b) => { b.details.currencyIn.minimumAmount = "999999"; }],
  ["target chain", (b) => { b.details.currencyOut.currency.chainId = 8453; }],
  ["target token", (b) => { b.details.currencyOut.currency.address = stranger; }],
  ["target precision", (b) => { b.details.currencyOut.currency.decimals = 8; }],
  ["zero minimum", (b) => { b.details.currencyOut.minimumAmount = "0"; }],
  ["loose minimum", (b) => { b.details.currencyOut.minimumAmount = "989999999999999999999"; }],
  ["impossible minimum", (b) => { b.details.currencyOut.minimumAmount = "1000000000000000000001"; }],
  ["invalid integer", (b) => { b.details.currencyOut.amount = "1e21"; }],
  ["slippage", (b) => { b.details.slippageTolerance.total = "500"; }],
  ["protocol missing", (b) => { delete b.protocol; }],
  ["output recipient", (b) => { b.protocol.v2.orderData.output.payments[0].recipient = stranger; }],
  ["output asset", (b) => { b.protocol.v2.orderData.output.payments[0].currency = stranger; }],
  ["output minimum", (b) => { b.protocol.v2.orderData.output.payments[0].minimumAmount = "1"; }],
  ["extra recipient", (b) => { b.protocol.v2.orderData.output.payments.push(b.protocol.v2.orderData.output.payments[0]); }],
  ["extra call", (b) => { b.protocol.v2.orderData.output.calls.push({ to: stranger }); }],
  ["expired order", (b) => { b.protocol.v2.orderData.output.deadline = 1; }],
  ["wrong refund chain", (b) => { b.protocol.v2.orderData.inputs[0].refunds[0].chainId = "ethereum"; }],
  ["missing refunds", (b) => { b.protocol.v2.orderData.inputs[0].refunds = []; }],
  ["app fee", (b) => { b.fees.app.amount = "1"; }],
  ["protocol fee", (b) => { b.protocol.v2.orderData.fees.push({ amount: "1" }); }],
  ["approval spender", (b) => { b.steps[0].items[0].data.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [stranger, 1000000n] }); }],
  ["unlimited approval", (b) => { b.steps[0].items[0].data.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, (1n << 256n) - 1n] }); }],
  ["deposit target", (b) => { b.steps[1].items[0].data.to = stranger; }],
  ["deposit sender", (b) => { b.steps[1].items[0].data.from = stranger; }],
  ["deposit chain", (b) => { b.steps[1].items[0].data.chainId = 4663; }],
  ["deposit ETH spend", (b) => { b.steps[1].items[0].data.value = "1"; }],
  ["message signature", (b) => { b.steps[1].kind = "signature"; }],
  ["multiple transactions", (b) => { b.steps[1].items.push(b.steps[1].items[0]); }],
];
test("buyback fails closed when upstream changes accounts, assets, chain, amounts, approvals or execution steps", async (t) => {
  for (const [name, change] of hostile) await t.test(name, async () => {
    const body = fixture(); change(body);
    await assert.rejects(reader(body).quote(input), hasCode("INVALID_ROUTE"));
  });
});
test("all cross-chain refund branches must return to treasury; direct dead refunds are rejected", async () => {
  for (const recipient of [MUSEGOD_BUYBACK.burnAddress, stranger]) {
    const body = fixture(); body.protocol.v2.orderData.inputs[0].refunds[1].recipient = recipient;
    await assert.rejects(reader(body).quote(input), hasCode("UNSAFE_REFUND"));
  }
});
test("existing exact allowance may omit approval; missing fee estimates remain unknown", async () => {
  const body = fixture(); body.steps.shift(); delete body.fees; delete body.details.totalImpact;
  const quote = await reader(body).quote(input);
  assert.equal(quote.relayerFeeUsd, null);
  assert.equal(quote.totalImpactPercent, null);
});
test("buyback maps rate limit, no-route, authentication, malformed response and timeouts without upstream leaks", async () => {
  for (const [status, code] of [[429, "RATE_LIMITED"], [400, "NO_ROUTE"], [404, "NO_ROUTE"], [401, "UPSTREAM_AUTH"], [500, "UPSTREAM_UNAVAILABLE"]] as const)
    await assert.rejects(new BuybackReader(treasury, { fetch: mock({ error: "https://secret.example/key" }, status) }).quote(input), hasCode(code));
  await assert.rejects(new BuybackReader(treasury, { fetch: (async () => new Response("invalid")) as typeof fetch }).quote(input), hasCode("INVALID_RESPONSE"));
  await assert.rejects(new BuybackReader(treasury, { fetch: (async () => { throw new DOMException("secret", "TimeoutError"); }) as typeof fetch }).quote(input), hasCode("TIMEOUT"));
  await assert.rejects(new BuybackReader(treasury, { fetch: (async () => { throw new Error("secret"); }) as typeof fetch }).quote(input), hasCode("UPSTREAM_UNAVAILABLE"));
  let n = 0;
  await assert.rejects(new BuybackReader(treasury, { fetch: mock(fixture()), now: () => now + 60_000 * n++ }).quote(input), hasCode("EXPIRED"));
});

function statsFetch(change?: (values: any[], batch: number) => void): typeof fetch {
  let batch = 0;
  return (async (_url, options) => {
    const request = JSON.parse(options!.body as string);
    const first = batch++ === 0;
    let values: any[] = first ? ["0x1237", "0x4b00000"] : [
      "0x6001600055",
      encodeFunctionResult({ abi: erc20Abi, functionName: "name", result: "MUSEGOD" }),
      encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "MUSEGOD" }),
      encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 18 }),
      encodeFunctionResult({ abi: erc20Abi, functionName: "totalSupply", result: 10n ** 27n }),
      encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 123n * 10n ** 18n }),
    ];
    if (!first) for (const call of request) {
      assert.equal(call.params[1], "0x4b00000");
      if (call.method === "eth_call") assert.equal(call.params[0].to, MUSEGOD_BUYBACK.tokenAddress);
    }
    change?.(values, batch);
    return new Response(JSON.stringify(values.map((result, id) => ({ jsonrpc: "2.0", id, result })).reverse()));
  }) as typeof fetch;
}
test("MUSEGOD global dead balance is verified at one pinned block and is not platform burn accounting", async () => {
  const stats = await new BuybackReader(null, { fetch: statsFetch(), now: () => now }).readMUSEGODStats();
  assert.equal(stats.chainId, 4663);
  assert.equal(stats.deadBalance, "123000000000000000000");
  assert.equal(stats.scope, "global");
  assert.equal(stats.blockNumber, String(0x4b00000));
});
test("MUSEGOD stats reject wrong chain, missing code, fake identity, precision and impossible balance", async () => {
  await assert.rejects(new BuybackReader(null, { fetch: statsFetch((v, b) => { if (b === 1) v[0] = "0x2105"; }) }).readMUSEGODStats(), hasCode("WRONG_CHAIN"));
  for (const [index, value] of [
    [0, "0x"],
    [1, encodeFunctionResult({ abi: erc20Abi, functionName: "name", result: "FAKE" })],
    [3, encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 8 })],
    [5, encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 10n ** 28n })],
  ] as const) {
    await assert.rejects(new BuybackReader(null, { fetch: statsFetch((v, b) => { if (b === 2) v[index] = value; }) }).readMUSEGODStats());
  }
});

// Public, unsubmitted Relay quote used only to test deterministic validation.
const executionFixture = {
  "quote": {
    "source": "Relay",
    "requestId": "0x1791034632b90888954f68759733da438fdecf0376d06bbfc0d08d2f4528d538",
    "quotedAt": 1791034629039,
    "expiresAt": 1791034689039,
    "originChainId": 8453,
    "destinationChainId": 4663,
    "treasury": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
    "destinationRecipient": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
    "burnAddress": "0x000000000000000000000000000000000000dEaD",
    "refundTo": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
    "stockAddress": "0xb20000000000000000000078ee7ce2fE4908108C",
    "stockSymbol": "NVDAc",
    "stockDecimals": 8,
    "amountIn": "1000000",
    "amountInFormatted": "0.01",
    "tokenAddress": "0x0379E228F6887c6F18bf394042ECAF81B308cb2e",
    "tokenDecimals": 18,
    "expectedOut": "4446066043319117656878",
    "minimumOut": "4401605382885926480310",
    "expectedOutFormatted": "4446.066043319117656878",
    "minimumOutFormatted": "4401.60538288592648031",
    "slippageBps": 100,
    "totalImpactPercent": "-4.34",
    "relayerFeeUsd": "0.078584",
    "gasFeeUsd": "0.000401",
    "refundCurrencies": [
      {
        "chainId": 8453,
        "address": "0x0000000000000000000000000000000000000000"
      },
      {
        "chainId": 4663,
        "address": "0x0000000000000000000000000000000000000000"
      }
    ],
    "executionAvailable": false,
    "requiresSeparateBurn": true
  },
  "raw": {
    "requestId": "0x1791034632b90888954f68759733da438fdecf0376d06bbfc0d08d2f4528d538",
    "steps": [
      {
        "id": "approve",
        "action": "Confirm transaction in your wallet",
        "description": "Sign an approval for NVDAc",
        "kind": "transaction",
        "items": [
          {
            "status": "incomplete",
            "data": {
              "from": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
              "to": "0xb20000000000000000000078ee7ce2fe4908108c",
              "data": "0x095ea7b3000000000000000000000000ccc88a9d1b4ed6b0eaba998850414b24f1c315be00000000000000000000000000000000000000000000000000000000000f4240",
              "value": "0",
              "chainId": 8453,
              "gas": "59736",
              "maxFeePerGas": "6500000",
              "maxPriorityFeePerGas": "1000000"
            }
          }
        ],
        "requestId": "0x1791034632b90888954f68759733da438fdecf0376d06bbfc0d08d2f4528d538"
      },
      {
        "id": "deposit",
        "action": "Confirm transaction in your wallet",
        "description": "Depositing funds to the relayer to execute the swap for MUSEGOD",
        "kind": "transaction",
        "items": [
          {
            "status": "incomplete",
            "data": {
              "from": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
              "to": "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be",
              "data": "0xf9e4bab400000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000f70da97812cb96acdf810712aa562db8dfa3dbef000000000000000000000000f70da97812cb96acdf810712aa562db8dfa3dbef00000000000000000000000000000000000000000000000000000000000010a00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000b20000000000000000000078ee7ce2fe4908108c000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000da0000000000000000000000000b20000000000000000000078ee7ce2fe4908108c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b500000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000b84e21fd0e900000000000000000000000000000000000000000000000000000000000000200000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f996000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000008400000000000000000000000000000000000000000000000000000000000000a8000000000000000000000000000000000000000000000000000000000000007744f1423cce26c09fb31d96eafe702fc5e22421f6a000000000000000000000000000f4240000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000004184a66185c1920bdbc7aa93fb58c1b585c51a6297f65bbab0740ed40990dac8d12dc90f1643ba138885ca41915c733b4a02864bda0439a25f4e19da380cb8d1e41b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000660000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f00000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000180000000000000000000000000000e7ef000000000000000000000000000100590000000000000000000000000000f4240000000000000000000031ba1280d1feb00000000000000000000000000000000000000342472c10000000f42400000000000000000000000000000001111110f0f73c0b2ef09ec012eae758b3e03a9020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ac109b80000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000161f598cd00000000000000007b0e2e8300899b647d5ebc66f9d4fa3f16c540610000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002e00000000000000000000000000000000000000000000000000000000000000420000000000000000000000000b20000000000000000000078ee7ce2fe4908108c80000000000000000000000000000001000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000f42403b9d6e0900000000000000015455c918e405a2831fbff8595c0aae35ee3db9d100000000000000000000000000000000000000000000000000000000000000800000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f996000000000000000000000000000000000000000000000000000000000000004000000000000000000000000020e5fad2661ee9eb0c04824524030af31943b62d000000000000000000000000ffb57e36d5b8bf4597abf0bbcfe764cfe8b1211240000000000000000000000000000000000000000000000000000000000f42403b9d6e0900000000000000015455c918e405a2831fbff8595c0aae35ee3db9d100000000000000000000000000000000000000000000000000000000000000800000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f996000000000000000000000000000000000000000000000000000000000000004000000000000000000000000020e5fad2661ee9eb0c04824524030af31943b62d000000000000000000000000ffb57e36d5b8bf4597abf0bbcfe764cfe8b121120000000000000000000000004200000000000000000000000000000000000006800000000000000000000000342472c1000000000000000000031ba1280d1feb00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000031ba1280d1feb0000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee8000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b20000000000000000000078ee7ce2fe4908108c000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000313ac584a6ef40000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000000010000000000000000000000008f10b468b06c6fd214b65f87778827f7d113f996000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a77b22536f75726365223a2272656c6179222c22416d6f756e74496e555344223a22322e3334333931222c22416d6f756e744f7574555344223a22322e333433313336222c22416d6f756e744f7574223a22383734383033393035373635333534222c22526f7574654944223a2233353737356461394934704b66594b673a62343238323334616b76564b5a4c3762222c2254696d657374616d70223a313739313033343633327d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e45d1fe6a200000000000000000000000000000000000000000000000000000000000000000000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004449290c1c000000000000000000000000c4f87c3715374445c4657aa14c47cbb339b59d1aeada616bb1b545930e24ee16b7cc9377ea7078d419f1a3b2f4528cee82224e1100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000021835d8254f2d80d0cfbb60d6730fcedf834ad33795786f45988809b23643019710000000000000000000000000000000000000000000000000000000000000000eada616bb1b545930e24ee16b7cc9377ea7078d419f1a3b2f4528cee82224e11",
              "value": "0",
              "chainId": 8453,
              "maxFeePerGas": "6500000",
              "maxPriorityFeePerGas": "1000000"
            },
            "check": {
              "endpoint": "/intents/status/v3?requestId=0x1791034632b90888954f68759733da438fdecf0376d06bbfc0d08d2f4528d538",
              "method": "GET"
            }
          }
        ],
        "requestId": "0x1791034632b90888954f68759733da438fdecf0376d06bbfc0d08d2f4528d538",
        "depositAddress": ""
      }
    ],
    "fees": {
      "gas": {
        "currency": {
          "chainId": 8453,
          "address": "0x0000000000000000000000000000000000000000",
          "symbol": "ETH",
          "name": "Ether",
          "decimals": 18,
          "metadata": {
            "logoURI": "https://assets.relay.link/icons/1/light.png",
            "verified": true
          }
        },
        "amount": "149755839518",
        "amountFormatted": "0.000000149755839518",
        "amountUsd": "0.000401",
        "minimumAmount": "149755839518"
      },
      "relayer": {
        "currency": {
          "chainId": 8453,
          "address": "0x0000000000000000000000000000000000000000",
          "symbol": "ETH",
          "name": "Ether",
          "decimals": 18,
          "metadata": {
            "logoURI": "https://assets.relay.link/icons/1/light.png",
            "verified": true
          }
        },
        "amount": "29334227669651",
        "amountFormatted": "0.000029334227669651",
        "amountUsd": "0.078584",
        "minimumAmount": "29334227669651"
      },
      "relayerGas": {
        "currency": {
          "chainId": 8453,
          "address": "0x0000000000000000000000000000000000000000",
          "symbol": "ETH",
          "name": "Ether",
          "decimals": 18,
          "metadata": {
            "logoURI": "https://assets.relay.link/icons/1/light.png",
            "verified": true
          }
        },
        "amount": "20386482755520",
        "amountFormatted": "0.00002038648275552",
        "amountUsd": "0.054614",
        "minimumAmount": "20386482755520"
      },
      "relayerService": {
        "currency": {
          "chainId": 8453,
          "address": "0x0000000000000000000000000000000000000000",
          "symbol": "ETH",
          "name": "Ether",
          "decimals": 18,
          "metadata": {
            "logoURI": "https://assets.relay.link/icons/1/light.png",
            "verified": true
          }
        },
        "amount": "8947744914131",
        "amountFormatted": "0.000008947744914131",
        "amountUsd": "0.023970",
        "minimumAmount": "8947744914131"
      },
      "app": {
        "currency": {
          "chainId": 8453,
          "address": "0x0000000000000000000000000000000000000000",
          "symbol": "ETH",
          "name": "Ether",
          "decimals": 18,
          "metadata": {
            "logoURI": "https://assets.relay.link/icons/1/light.png",
            "verified": true
          }
        },
        "amount": "0",
        "amountFormatted": "0.0",
        "amountUsd": "0",
        "minimumAmount": "0"
      },
      "subsidized": {
        "currency": {
          "chainId": 8453,
          "address": "0x0000000000000000000000000000000000000000",
          "symbol": "ETH",
          "name": "Ether",
          "decimals": 18,
          "metadata": {
            "logoURI": "https://assets.relay.link/icons/1/light.png",
            "verified": true
          }
        },
        "amount": "0",
        "amountFormatted": "0.0",
        "amountUsd": "0",
        "minimumAmount": "0"
      }
    },
    "details": {
      "operation": "swap",
      "sender": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
      "recipient": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
      "currencyIn": {
        "currency": {
          "chainId": 8453,
          "address": "0xb20000000000000000000078ee7ce2fe4908108c",
          "symbol": "NVDAc",
          "name": "NVIDIA Corporation",
          "decimals": 8,
          "metadata": {
            "logoURI": "https://coin-images.coingecko.com/coins/images/102175596/large/nvda_200x200.png?1787068801",
            "verified": false
          }
        },
        "amount": "1000000",
        "amountFormatted": "0.01",
        "amountUsd": "2.345500",
        "minimumAmount": "1000000"
      },
      "currencyOut": {
        "currency": {
          "chainId": 4663,
          "address": "0x0379e228f6887c6f18bf394042ecaf81b308cb2e",
          "symbol": "MUSEGOD",
          "name": "MUSEGOD",
          "decimals": 18,
          "metadata": {
            "logoURI": "",
            "verified": false
          }
        },
        "amount": "4446066043319117656878",
        "amountFormatted": "4446.066043319117656878",
        "amountUsd": "2.243792",
        "minimumAmount": "4401605382885926480310"
      },
      "refundCurrency": {
        "currency": {
          "chainId": 8453,
          "address": "0x0000000000000000000000000000000000000000",
          "symbol": "ETH",
          "name": "Ether",
          "decimals": 18,
          "metadata": {
            "logoURI": "https://assets.relay.link/icons/1/light.png",
            "verified": true
          }
        },
        "amount": "874803905765355",
        "amountFormatted": "0.000874803905765355",
        "amountUsd": "2.343542",
        "minimumAmount": "866055866707701"
      },
      "totalImpact": {
        "usd": "-0.101708",
        "percent": "-4.34"
      },
      "swapImpact": {
        "usd": "-0.023124",
        "percent": "-0.99"
      },
      "expandedPriceImpact": {
        "swap": {
          "usd": "-0.023576"
        },
        "execution": {
          "usd": "-0.074614"
        },
        "relay": {
          "usd": "-0.003518"
        },
        "app": {
          "usd": "0"
        },
        "sponsored": {
          "usd": "0"
        }
      },
      "rate": "444606.6043319118",
      "slippageTolerance": {
        "total": "100",
        "origin": {
          "usd": "0.023435",
          "value": "8748039057654",
          "percent": "1.00"
        },
        "destination": {
          "usd": "0.022214",
          "value": "44460660433191176568",
          "percent": "0.99"
        }
      },
      "timeEstimate": 1,
      "userBalance": "0",
      "isFixedRate": false,
      "route": {
        "origin": {
          "inputCurrency": {
            "currency": {
              "chainId": 8453,
              "address": "0xb20000000000000000000078ee7ce2fe4908108c",
              "symbol": "NVDAc",
              "name": "NVIDIA Corporation",
              "decimals": 8,
              "metadata": {
                "logoURI": "https://coin-images.coingecko.com/coins/images/102175596/large/nvda_200x200.png?1787068801",
                "verified": false
              }
            },
            "amount": "1000000",
            "amountFormatted": "0.01",
            "amountUsd": "2.345500",
            "minimumAmount": "1000000"
          },
          "outputCurrency": {
            "currency": {
              "chainId": 8453,
              "address": "0x0000000000000000000000000000000000000000",
              "symbol": "ETH",
              "name": "Ether",
              "decimals": 18,
              "metadata": {
                "logoURI": "https://assets.relay.link/icons/1/light.png",
                "verified": true
              }
            },
            "amount": "874803905765355",
            "amountFormatted": "0.000874803905765355",
            "amountUsd": "2.343542",
            "minimumAmount": "866055866707701"
          },
          "router": "kyberswap"
        },
        "destination": {
          "inputCurrency": {
            "currency": {
              "chainId": 4663,
              "address": "0x0000000000000000000000000000000000000000",
              "symbol": "ETH",
              "name": "Ether",
              "decimals": 18,
              "metadata": {
                "logoURI": "https://assets.relay.link/icons/1/light.png",
                "verified": true
              }
            },
            "amount": "836721639038050",
            "amountFormatted": "0.00083672163903805",
            "amountUsd": "2.241522",
            "minimumAmount": "836721639038050"
          },
          "outputCurrency": {
            "currency": {
              "chainId": 4663,
              "address": "0x0379e228f6887c6f18bf394042ecaf81b308cb2e",
              "symbol": "MUSEGOD",
              "name": "MUSEGOD",
              "decimals": 18,
              "metadata": {
                "logoURI": "",
                "verified": false
              }
            },
            "amount": "4446066043319117656878",
            "amountFormatted": "4446.066043319117656878",
            "amountUsd": "2.243792",
            "minimumAmount": "4401605382885926480310"
          },
          "router": "kyberswap"
        }
      }
    },
    "protocol": {
      "v2": {
        "orderId": "0xeada616bb1b545930e24ee16b7cc9377ea7078d419f1a3b2f4528cee82224e11",
        "hubType": "onchain",
        "orderData": {
          "version": "v1",
          "solverChainId": "base",
          "solver": "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
          "salt": "0x6203e5358b43d1cf60a73b6dc3e0519a765a5a9dfa562091ebe3bfd9496d8cc1",
          "inputs": [
            {
              "payment": {
                "chainId": "base",
                "currency": "0x0000000000000000000000000000000000000000",
                "amount": "874803905765355",
                "weight": "1"
              },
              "refunds": [
                {
                  "chainId": "base",
                  "recipient": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
                  "currency": "0x0000000000000000000000000000000000000000",
                  "minimumAmount": "0",
                  "deadline": 1791639433,
                  "extraData": "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
                },
                {
                  "chainId": "robinhood",
                  "recipient": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
                  "currency": "0x0000000000000000000000000000000000000000",
                  "minimumAmount": "0",
                  "deadline": 1791639433,
                  "extraData": "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
                }
              ]
            }
          ],
          "output": {
            "chainId": "robinhood",
            "payments": [
              {
                "recipient": "0xc4F87C3715374445C4657aa14c47CBB339b59d1A",
                "currency": "0x0379e228f6887c6f18bf394042ecaf81b308cb2e",
                "minimumAmount": "4401605382885926480310",
                "expectedAmount": "4446066043319117656878"
              }
            ],
            "calls": [],
            "deadline": 1791639433,
            "extraData": "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
          },
          "fees": []
        },
        "orderSignature": "0x16ed51d1a2a76c56667a23f060a5d6eb802e2611ba67578d4589f82ce3af5a6b63789298331268806c95ded8d384d84fe0866c499f1d318fd8971883ec35ad491c",
        "paymentDetails": {
          "chainId": "base",
          "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
          "currency": "0x0000000000000000000000000000000000000000",
          "amount": "874803905765355"
        }
      }
    }
  }
};

test("authentic Relay execution binds signed order, exact input and treasury refunds, then tightens native deposit", async () => {
  const q = executionFixture.quote as BuybackQuote;
  const result = await validateRelayExecution(q, executionFixture.raw);
  assert.equal(result.orderId, executionFixture.raw.protocol.v2.orderId);
  const decoded = decodeFunctionData({ abi: approvalProxyAbi, data: result.deposit.data });
  const [tokens, amounts, calls, refund, nftRecipient] = decoded.args;
  assert.equal(tokens[0].toLowerCase(), q.stockAddress.toLowerCase());
  assert.equal(amounts[0].toString(), q.amountIn);
  assert.equal(refund.toLowerCase(), q.treasury.toLowerCase());
  assert.equal(nftRecipient.toLowerCase(), q.treasury.toLowerCase());
  const cleanup = decodeFunctionData({ abi: parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]), data: calls[2].callData });
  assert.equal(cleanup.args[0], BigInt(executionFixture.raw.details.route.origin.outputCurrency.minimumAmount) + 1n);
  assert.equal(result.nativeDepositAmount, cleanup.args[0].toString());
  assert.equal(cleanup.args[0], (BigInt(executionFixture.raw.protocol.v2.paymentDetails.amount) * 9900n + 9999n) / 10000n);
  const swap = decodeFunctionData({ abi: kyberTestAbi, data: calls[1].callData });
  assert.ok(swap.args[0].desc.minReturnAmount >= cleanup.args[0]);
  assert.equal(q.minimumOut, executionFixture.raw.protocol.v2.orderData.output.payments[0].minimumAmount);
  assert.notEqual(result.deposit.data, executionFixture.raw.steps.at(-1)!.items[0].data.data);
});

test("execution rejects altered order signatures, payment commitments and hidden source callees", async (t) => {
  const attacks: [string, (raw: any) => void][] = [
    ["order id", (r) => { r.protocol.v2.orderId = requestId; }],
    ["solver signature", (r) => { r.protocol.v2.orderSignature = `0x${"00".repeat(65)}`; }],
    ["signed output recipient", (r) => { r.protocol.v2.orderData.output.payments[0].recipient = stranger; }],
    ["payment amount", (r) => { r.protocol.v2.paymentDetails.amount = "1"; }],
    ["payment contract", (r) => { r.protocol.v2.paymentDetails.depository = stranger; }],
    ["origin minimum below 1% floor", (r) => { r.details.route.origin.outputCurrency.minimumAmount = (BigInt(r.details.route.origin.outputCurrency.minimumAmount) - 1n).toString(); }],
    ["origin expected differs from signed order", (r) => { r.details.route.origin.outputCurrency.amount = "1"; }],
    ["origin is not native Base ETH", (r) => { r.details.route.origin.outputCurrency.currency.chainId = 4663; }],
    ["destination input is not native ETH", (r) => { r.details.route.destination.inputCurrency.currency.address = stranger; }],
    ["destination input does not equal minimum less fee", (r) => { r.details.route.destination.inputCurrency.amount = (BigInt(r.details.route.destination.inputCurrency.amount) - 1n).toString(); }],
    ["destination input minimum is lowered", (r) => { r.details.route.destination.inputCurrency.minimumAmount = "1"; }],
    ["destination output minimum is discounted twice", (r) => { r.details.route.destination.outputCurrency.minimumAmount = (BigInt(r.details.route.destination.outputCurrency.minimumAmount) * 99n / 100n).toString(); }],
    ["fee amount does not match source/destination equation", (r) => { r.fees.relayer.amount = (BigInt(r.fees.relayer.amount) + 1n).toString(); }],
    ["fee currency is not native Base ETH", (r) => { r.fees.relayer.currency.chainId = 4663; }],
    ["unbound request metadata", (r) => {
      const tx = r.steps.at(-1).items[0].data, args: any = [...decodeFunctionData({ abi: approvalProxyAbi, data: tx.data }).args];
      args[5] = "0x1234"; tx.data = encodeFunctionData({ abi: approvalProxyAbi, functionName: "transferAndMulticall", args });
    }],
    ["source nested target", (r) => mutateCalls(r, (calls) => { calls[1].target = stranger; })],
    ["source optional failure", (r) => mutateCalls(r, (calls) => { calls[1].allowFailure = true; })],
    ["source native spend", (r) => mutateCalls(r, (calls) => { calls[1].value = 1n; })],
    ["source nested minimum is below observed rounding bound", (r) => mutateCalls(r, (calls) => {
      const execution = decodeFunctionData({ abi: kyberTestAbi, data: calls[1].callData }).args[0];
      calls[1].callData = encodeFunctionData({ abi: kyberTestAbi, functionName: "swap", args: [{ ...execution, desc: { ...execution.desc,
        minReturnAmount: BigInt(r.details.route.origin.outputCurrency.minimumAmount) - 2n } }] });
    })],
    ["extra source call", (r) => mutateCalls(r, (calls) => { calls.push(calls[0]); })],
    ["unlimited nested approval", (r) => mutateCalls(r, (calls) => { calls[0].callData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, (1n << 256n) - 1n] }); })],
  ];
  for (const [name, mutate] of attacks) await t.test(name, async () => {
    const raw = structuredClone(executionFixture.raw); mutate(raw);
    await assert.rejects(validateRelayExecution(executionFixture.quote as BuybackQuote, raw), hasCode("UNVERIFIED_EXECUTION"));
  });
});
function mutateCalls(raw: any, mutate: (calls: any[]) => void) {
  const tx = raw.steps.at(-1).items[0].data;
  const decoded = decodeFunctionData({ abi: approvalProxyAbi, data: tx.data });
  const args = structuredClone(decoded.args) as any;
  mutate(args[2]);
  tx.data = encodeFunctionData({ abi: approvalProxyAbi, functionName: "transferAndMulticall", args });
}

const hexHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const sourceHash = hexHash(100), destinationHash = hexHash(101), burnHash = hexHash(102), blockHash = hexHash(103);
const metadata = "0x1234" as Hex;
const fundsAbi = parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
function transferLog(from: string, to: string, amount: bigint) {
  return { address: MUSEGOD_BUYBACK.tokenAddress,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: from as Hex, to: to as Hex } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]) };
}
function destinationLogs(amount: bigint, tag = metadata) {
  return [transferLog(stranger, treasury, amount), { address: RELAY_ROUTER,
    topics: encodeEventTopics({ abi: fundsAbi, eventName: "FundsMovement" }),
    data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [RELAY_ROUTER, treasury, MUSEGOD_BUYBACK.tokenAddress, amount, tag]) }];
}
async function batchHarness() {
  const quote = await reader().quote(input);
  const amount = BigInt(quote.expectedOut), receipts = new Map<string, any>(), transactions = new Map<string, any>();
  let basePendingNonce = 0, rhPendingNonce = 0, baseLatestNonce = 0, rhLatestNonce = 0;
  const batch: any = { id: requestId, quote, status: "deposit_pending", nextStep: null, createdAt: now, updatedAt: now,
    receivedAmount: "0", burnedAmount: "0", hashes: { deposit: sourceHash }, proofs: {},
    steps: { deposit: { batchId: requestId, kind: "deposit", chainId: 8453, from: treasury, to: proxy, data: "0x12345678", value: "0", expiresAt: now + 60000, amount: quote.amountIn, stockAddress: stock.address, nonce: 0 } },
    orderId: hexHash(104), metadata, nonces: { deposit: 0 }, authorizationNonce: hexHash(105), fundingSource: "treasury_allocation", claimHashes: [] };
  const rows = new Map<string, any>([[requestId, batch]]);
  const store = { getBuybackBatch: (id: string) => structuredClone(rows.get(id)), listBuybackBatches: () => Array.from(rows.values()).map((r) => structuredClone(r)),
    saveBuybackBatch: (value: any) => { rows.set(value.id, structuredClone(value)); } };
  const receipt = (hash: Hex, logs: any[] = [], status = "success") => ({ transactionHash: hash, blockHash, blockNumber: 1000n, status, logs });
  receipts.set(sourceHash, receipt(sourceHash)); receipts.set(destinationHash, receipt(destinationHash, destinationLogs(amount)));
  transactions.set(sourceHash, { from: treasury, to: proxy, input: "0x12345678", value: 0n, nonce: 0 });
  const client = (chainId: number): any => ({
    getChainId: async () => chainId,
    getTransactionReceipt: async ({ hash }: any) => { if (!receipts.has(hash)) throw Error("pending"); return receipts.get(hash); },
    getTransaction: async ({ hash }: any) => { if (!transactions.has(hash)) throw Error("not found"); return transactions.get(hash); },
    getBlock: async () => ({ hash: blockHash, timestamp: BigInt(now / 1000) }), getBlockNumber: async () => 1002n,
    getCode: async () => "0x",
    readContract: async ({ functionName }: any) => functionName === "decimals" ? 8 : 10n ** 30n,
    getTransactionCount: async ({ blockTag }: any) => chainId === 8453 ? (blockTag === "pending" ? basePendingNonce : baseLatestNonce) : (blockTag === "pending" ? rhPendingNonce : rhLatestNonce),
    call: async () => ({ data: "0x" }),
    estimateGas: async () => 100000n, getGasPrice: async () => 1n, getBalance: async () => 10n ** 18n,
  });
  const base = client(8453), rh = client(4663);
  const config: any = { mode: "base", chainId: 8453, writesEnabled: true, treasury };
  const statsReader = { readMUSEGODStats: async () => ({}) } as unknown as BuybackReader;
  const fetcher = mock({ status: "success", originChainId: 8453, destinationChainId: 4663, inTxHashes: [sourceHash], txHashes: [destinationHash] });
  const makeService = (customReader = statsReader, customFetch = fetcher) => new BuybackBatchService(customReader, store, base, config, { robinhoodClient: rh, fetch: customFetch, now: () => now });
  return { service: makeService(), makeService, rows, receipts, transactions, batch, amount, config, receipt, base, rh,
    setNonces: (bp: number, bl: number, rp: number, rl: number) => { basePendingNonce = bp; baseLatestNonce = bl; rhPendingNonce = rp; rhLatestNonce = rl; } };
}

test("manual batch independently verifies destination, fixes received burn amount and survives service restart", async () => {
  const h = await batchHarness();
  const received = await h.service.reconcile(requestId);
  assert.equal(received.status, "received"); assert.equal(received.receivedAmount, h.amount.toString());
  const step = await h.service.step(requestId, "burn");
  assert.equal(step.nonce, 0); assert.equal(step.amount, h.amount.toString());
  const transfer = decodeFunctionData({ abi: erc20Abi, data: step.data });
  assert.equal(transfer.functionName, "transfer"); assert.deepEqual(transfer.args, [MUSEGOD_BUYBACK.burnAddress, h.amount]);
  h.transactions.set(burnHash, { from: treasury, to: step.to, input: step.data, value: 0n, nonce: 0 });
  h.receipts.set(burnHash, h.receipt(burnHash, [transferLog(treasury, MUSEGOD_BUYBACK.burnAddress, h.amount)]));
  const done = await h.makeService().track(requestId, "burn", burnHash);
  assert.equal(done.status, "burned"); assert.equal(done.burnedAmount, h.amount.toString());
  const publicBatch: any = (await h.service.list())[0];
  for (const field of ["steps", "proofs", "orderId", "metadata", "nonces", "authorizationNonce", "authorizationDigest"]) assert.equal(publicBatch[field], undefined);
  h.receipts.delete(burnHash);
  const reorg = await h.service.reconcile(requestId);
  assert.equal(reorg.status, "reorg"); assert.equal(reorg.burnedAmount, "0"); assert.equal(reorg.receivedAmount, h.amount.toString());
});

test("destination must match request source, token transfers, metadata, minimum and unique batch ownership", async (t) => {
  for (const [name, change] of [
    ["metadata", (h: any) => h.receipts.set(destinationHash, h.receipt(destinationHash, destinationLogs(h.amount, "0xffff")))],
    ["minimum", (h: any) => h.receipts.set(destinationHash, h.receipt(destinationHash, destinationLogs(1n)))],
    ["wrong recipient", (h: any) => h.receipts.set(destinationHash, h.receipt(destinationHash, [transferLog(stranger, stranger, h.amount)]))],
    ["duplicate destination", (h: any) => h.rows.set(hexHash(200), { ...structuredClone(h.batch), id: hexHash(200), destinationHash })],
    ["historical destination", (h: any) => { h.rh.getBlock = async () => ({ hash: blockHash, timestamp: BigInt(now / 1000) - 10n }); }],
  ] as [string, (h: any) => void][]) await t.test(name, async () => {
    const h = await batchHarness(); change(h);
    const result = await h.service.reconcile(requestId);
    assert.equal(result.nextStep, null); assert.equal(result.receivedAmount, "0"); assert.equal(result.burnedAmount, "0");
  });
  const h = await batchHarness();
  const service = h.makeService(undefined, mock({ status: "success", originChainId: 8453, destinationChainId: 4663, inTxHashes: [hexHash(250)], txHashes: [destinationHash] }));
  assert.equal((await service.reconcile(requestId)).nextStep, null);
});

test("pending and reorganized receipts erase verified accounting without declaring timeout a failure", async () => {
  const h = await batchHarness(); await h.service.reconcile(requestId);
  h.receipts.delete(destinationHash);
  const reorg = await h.service.reconcile(requestId);
  assert.equal(reorg.status, "reorg"); assert.equal(reorg.receivedAmount, "0"); assert.equal(reorg.burnedAmount, "0"); assert.equal(reorg.nextStep, null);
  h.receipts.delete(sourceHash);
  const pending = await h.service.reconcile(requestId);
  assert.notEqual(pending.status, "failed"); assert.equal(pending.nextStep, null);
});

test("switching signing off or treasury never prevents confirmation of already submitted batches", async () => {
  const h = await batchHarness(); h.config.writesEnabled = false; h.config.treasury = stranger;
  const batch = await h.service.reconcile(requestId); assert.equal(batch.status, "received");
  await assert.rejects(h.service.step(requestId, "burn"), hasCode("SIGNING_DISABLED"));
  h.config.writesEnabled = true;
  await assert.rejects(h.service.step(requestId, "burn"), hasCode("TREASURY_CHANGED"));
});

test("first burn nonce cannot be queued behind unrelated pending work and cannot drift on repeated fetch", async () => {
  const h = await batchHarness(); h.setNonces(0, 0, 1, 0);
  await assert.rejects(h.service.step(requestId, "burn"), hasCode("PENDING_TRANSACTION"));
  h.setNonces(0, 0, 0, 0); const first = await h.service.step(requestId, "burn");
  const second = await h.service.step(requestId, "burn"); assert.equal(first.nonce, second.nonce);
  h.setNonces(0, 0, 1, 1); await assert.rejects(h.service.step(requestId, "burn"), hasCode("NONCE_CHANGED"));
});

test("source same-nonce repricing recovers but a late old hash cannot replace a canonical success", async () => {
  const h = await batchHarness(), newHash = hexHash(300);
  h.receipts.delete(sourceHash); h.transactions.set(newHash, h.transactions.get(sourceHash));
  h.receipts.set(newHash, h.receipt(newHash));
  await h.service.track(requestId, "deposit", newHash);
  await assert.rejects(h.service.track(requestId, "deposit", sourceHash), hasCode("TRANSACTION_ALREADY_CONFIRMED"));
  assert.equal(h.rows.get(requestId).hashes.deposit, newHash);
  h.transactions.set(hexHash(301), { ...h.transactions.get(newHash), nonce: 1 });
  await assert.rejects(h.service.track(requestId, "deposit", hexHash(301)), hasCode("TRANSACTION_MISMATCH"));
});

test("canonical zero-value cancellation releases nonce; repeat recovery is idempotent and reorg blocks retry", async () => {
  const h = await batchHarness(); const step = await h.service.step(requestId, "burn"), cancelHash = hexHash(400);
  h.transactions.set(cancelHash, { from: treasury, to: treasury, input: "0x", value: 0n, nonce: step.nonce });
  await assert.rejects(h.service.track(requestId, "burn", cancelHash), hasCode("CANCELLATION_PENDING"));
  h.receipts.set(cancelHash, h.receipt(cancelHash));
  const cancelled = await h.service.track(requestId, "burn", cancelHash);
  assert.equal(cancelled.nextStep, "burn"); assert.equal(cancelled.cancellations?.[0].verifiedCanonical, true);
  assert.equal((await h.service.track(requestId, "burn", cancelHash)).cancellations?.length, 1);
  h.setNonces(0, 0, 1, 1); const next = await h.service.step(requestId, "burn"); assert.equal(next.nonce, 1);
  h.receipts.delete(cancelHash);
  const reorg = await h.service.reconcile(requestId); assert.equal(reorg.status, "reorg");
  assert.equal(reorg.cancellations?.[0].verifiedCanonical, false);
  await assert.rejects(h.service.step(requestId, "burn"), hasCode("STEP_NOT_READY"));
});

test("exact reverted burn can be retried while arbitrary successful replacement is rejected", async () => {
  const h = await batchHarness(), step = await h.service.step(requestId, "burn"), failedHash = hexHash(401);
  h.transactions.set(failedHash, { from: treasury, to: step.to, input: step.data, value: 0n, nonce: 0 });
  h.receipts.set(failedHash, h.receipt(failedHash, [], "reverted"));
  assert.equal((await h.service.track(requestId, "burn", failedHash)).nextStep, "burn");
  h.setNonces(0, 0, 1, 1); await h.service.step(requestId, "burn");
  h.transactions.set(hexHash(402), { from: treasury, to: stranger, input: "0x", value: 0n, nonce: 1 });
  h.receipts.set(hexHash(402), h.receipt(hexHash(402)));
  await assert.rejects(h.service.track(requestId, "burn", hexHash(402)), hasCode("TRANSACTION_MISMATCH"));
});

test("batch preparation rejects anonymous/replayed/altered budget authorization before upstream requests", async () => {
  const h = await batchHarness(); h.rows.clear();
  const account = privateKeyToAccount(hexHash(1)); h.config.treasury = account.address;
  let calls = 0;
  const service = h.makeService({ prepareRoute: async () => { calls++; throw new BuybackError("TEST_REACHED_READER", "mock reader reached"); } } as unknown as BuybackReader);
  await assert.rejects(service.prepare(input), hasCode("AUTHORIZATION_REQUIRED"));
  const nonce = hexHash(501), expiresAt = now + 300_000;
  const authorization: BuybackAuthorization = { nonce, expiresAt, signature: await account.signTypedData(buybackAuthorizationTypedData(input, account.address, nonce, expiresAt)) };
  await assert.rejects(service.prepare({ ...input, amount: "1" }, authorization), hasCode("INVALID_AUTHORIZATION"));
  await assert.rejects(service.prepare({ ...input, claimHashes: [sourceHash] }, authorization), hasCode("INVALID_AUTHORIZATION"));
  await assert.rejects(service.prepare(input, { ...authorization, expiresAt: now }), hasCode("AUTHORIZATION_REQUIRED"));
  await assert.rejects(service.prepare(input, { ...authorization, expiresAt: now + 300_001 }), hasCode("AUTHORIZATION_REQUIRED"));
  assert.equal(calls, 0);
  await assert.rejects(service.prepare(input, authorization), hasCode("TEST_REACHED_READER")); assert.equal(calls, 1);
  const existing = { ...structuredClone(h.batch), quote: { ...h.batch.quote, treasury: account.address }, authorizationNonce: nonce,
    authorizationDigest: hashTypedData(buybackAuthorizationTypedData(input, account.address, nonce, expiresAt)) };
  h.rows.set(existing.id, existing);
  assert.equal((await service.prepare(input, authorization)).id, existing.id); assert.equal(calls, 1);
  const changed = { ...input, amount: "1" };
  const changedAuth = { ...authorization, signature: await account.signTypedData(buybackAuthorizationTypedData(changed, account.address, nonce, expiresAt)) };
  await assert.rejects(service.prepare(changed, changedAuth), hasCode("NONCE_REUSED"));
  h.rows.set(existing.id, { ...existing, createdAt: now - 120_000, status: "expired", hashes: {} });
  const reusedReader = { prepareRoute: async () => ({ quote: existing.quote, raw: {} }) } as unknown as BuybackReader;
  const newNonce = hexHash(502), newAuth = { nonce: newNonce, expiresAt, signature: await account.signTypedData(buybackAuthorizationTypedData(input, account.address, newNonce, expiresAt)) };
  await assert.rejects(h.makeService(reusedReader).prepare(input, newAuth), hasCode("REQUEST_ALREADY_USED"));
});
