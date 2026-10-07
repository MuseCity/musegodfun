import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  parseAbi,
  hashStruct,
  recoverMessageAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { sameAddress, stockByAddress } from "../src/lib/config";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { validTreasury } from "../src/lib/validation";
import type {
  BuybackQuote,
  BuybackQuoteInput,
  MUSEGODStats,
  BuybackStep,
} from "../src/lib/buyback";

const RELAY = "https://api.relay.link/quote/v2";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const APPROVAL_PROXY = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
const UINT_MAX = (1n << 256n) - 1n;
const TTL_MS = 60_000;

export class BuybackError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BuybackError";
  }
}
const invalid = () => {
  throw new BuybackError("INVALID_ROUTE", "The buyback quote assets, amounts, or route could not be verified");
};
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, any>;
}
function address(value: unknown, expected?: string): Address {
  if (
    typeof value !== "string" ||
    !isAddress(value, { strict: false }) ||
    (expected && !sameAddress(value, expected))
  ) invalid();
  return getAddress(value as string);
}
function uint(value: unknown, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) invalid();
  const n = BigInt(value as string);
  if (n > UINT_MAX || (positive && n === 0n)) invalid();
  return n;
}
function decimal(value: unknown): string | null {
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) &&
    value.length <= 50 && Number.isFinite(Number(value)) ? value : null;
}
function currency(value: unknown, chainId: number, token: string, decimals: number) {
  const c = object(value);
  if (c.chainId !== chainId || c.decimals !== decimals) invalid();
  address(c.address, token);
}

type Options = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export class BuybackReader {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly treasury: Address | null;

  constructor(treasury: string | null, options: Options = {}) {
    this.treasury = validTreasury(treasury ?? undefined);
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async request(url: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
        throw new BuybackError("TIMEOUT", "The buyback data request timed out. Try again later.");
      throw new BuybackError("UPSTREAM_UNAVAILABLE", "The buyback data provider is unavailable");
    }
    if (response.status === 429)
      throw new BuybackError("RATE_LIMITED", "The buyback data provider is rate limiting requests. Try again later.");
    if (response.status === 400 || response.status === 404)
      throw new BuybackError("NO_ROUTE", "No buyback route is available for this asset or amount");
    if (response.status === 401 || response.status === 403)
      throw new BuybackError("UPSTREAM_AUTH", "The buyback data provider denied access. Check the server configuration.");
    if (!response.ok)
      throw new BuybackError("UPSTREAM_UNAVAILABLE", "The buyback data provider is unavailable");
    try {
      const text = await response.text();
      if (text.length > 1_000_000) invalid();
      return JSON.parse(text);
    } catch {
      throw new BuybackError("INVALID_RESPONSE", "The buyback data provider returned invalid data");
    }
  }

  async quote(input: BuybackQuoteInput): Promise<BuybackQuote> {
    return (await this.prepareRoute(input)).quote;
  }

  // Server-internal only. Public preview handlers must call quote(), which strips calldata.
  async prepareRoute(input: BuybackQuoteInput): Promise<{ quote: BuybackQuote; raw: Record<string, any> }> {
    if (!this.treasury)
      throw new BuybackError("TREASURY_UNAVAILABLE", "The platform buyback treasury is not configured");
    let stock;
    let amount: bigint;
    try {
      stock = stockByAddress(input.stockAddress);
      if (stock.decimals !== 8 || !/^(0|[1-9]\d{0,20})(?:\.\d{1,8})?$/.test(input.amount))
        throw new Error();
      amount = parseUnits(input.amount, 8);
      if (amount <= 0n || amount > UINT_MAX) throw new Error();
    } catch {
      throw new BuybackError("INVALID_INPUT", "Select a supported stock token and enter a positive amount with up to 8 decimal places");
    }
    const quotedAt = this.now();
    const raw = object(await this.request(RELAY, {
      user: this.treasury,
      // Receive MUSEGOD first; a separate confirmed transfer to dead is required.
      // Direct-to-dead also directs some Relay fallback refunds to dead.
      recipient: this.treasury,
      refundTo: this.treasury,
      originChainId: 8453,
      destinationChainId: MUSEGOD_BUYBACK.chainId,
      originCurrency: stock.address,
      destinationCurrency: MUSEGOD_BUYBACK.tokenAddress,
      amount: amount.toString(),
      tradeType: "EXACT_INPUT",
      slippageTolerance: "100",
      usePermit: false,
      includeProtocolData: true,
      enableTrueExactOutput: false,
    }));
    if (this.now() >= quotedAt + TTL_MS)
      throw new BuybackError("EXPIRED", "The buyback quote has expired. Request a new quote.");
    const details = object(raw.details);
    address(details.sender, this.treasury);
    address(details.recipient, this.treasury);
    if (details.operation !== "swap") invalid();
    const incoming = object(details.currencyIn);
    const outgoing = object(details.currencyOut);
    currency(incoming.currency, 8453, stock.address, 8);
    currency(outgoing.currency, MUSEGOD_BUYBACK.chainId, MUSEGOD_BUYBACK.tokenAddress, 18);
    if (uint(incoming.amount, true) !== amount || uint(incoming.minimumAmount, true) !== amount)
      invalid();
    const expectedOut = uint(outgoing.amount, true);
    const minimumOut = uint(outgoing.minimumAmount, true);
    if (minimumOut > expectedOut || minimumOut < expectedOut * 9900n / 10000n)
      invalid();
    if (object(details.slippageTolerance).total !== "100") invalid();
    if (typeof raw.requestId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.requestId)) invalid();

    const protocol = object(object(raw.protocol).v2);
    const order = object(protocol.orderData);
    const output = object(order.output);
    if (order.version !== "v1" || order.solverChainId !== "base" ||
      output.chainId !== "robinhood" || !Array.isArray(output.payments) ||
      output.payments.length !== 1 || !Array.isArray(output.calls) || output.calls.length !== 0)
      invalid();
    const payment = object(output.payments[0]);
    address(payment.recipient, this.treasury);
    address(payment.currency, MUSEGOD_BUYBACK.tokenAddress);
    if (uint(payment.expectedAmount, true) !== expectedOut ||
      uint(payment.minimumAmount, true) !== minimumOut) invalid();
    if (!Number.isSafeInteger(output.deadline) || output.deadline * 1000 <= quotedAt) invalid();
    if (!Array.isArray(order.inputs) || order.inputs.length !== 1) invalid();
    const refunds = object(order.inputs[0]).refunds;
    if (!Array.isArray(refunds) || refunds.length === 0 || refunds.length > 4) invalid();
    const refundCurrencies = refunds.map((value: unknown) => {
      const refund = object(value);
      if (typeof refund.recipient !== "string" || !sameAddress(refund.recipient, this.treasury!))
        throw new BuybackError("UNSAFE_REFUND", "Not all refund paths lead to the platform treasury. This buyback route was rejected.");
      if (!["base", "robinhood"].includes(refund.chainId)) invalid();
      if (!Number.isSafeInteger(refund.deadline) || refund.deadline * 1000 <= quotedAt ||
        refund.deadline * 1000 > quotedAt + 8 * 86_400_000) invalid();
      return { chainId: refund.chainId === "base" ? 8453 : 4663, address: address(refund.currency, zeroAddress),
        minimumAmount: uint(refund.minimumAmount).toString(), deadline: refund.deadline * 1000 };
    });
    if (!Array.isArray(order.fees) || order.fees.length !== 0) invalid();
    if (raw.fees?.app && uint(raw.fees.app.amount) !== 0n) invalid();

    // Validate the proposed source transactions, then discard all executable data.
    if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 2) invalid();
    let deposits = 0;
    for (const [index, value] of raw.steps.entries()) {
      const step = object(value);
      if (step.kind !== "transaction" || step.requestId !== raw.requestId ||
        !Array.isArray(step.items) || step.items.length !== 1) invalid();
      const tx = object(step.items[0].data);
      address(tx.from, this.treasury);
      if (tx.chainId !== 8453 || uint(tx.value) !== 0n || typeof tx.data !== "string" ||
        !/^0x(?:[0-9a-fA-F]{2}){4,100000}$/.test(tx.data)) invalid();
      if (step.id === "approve" && index === 0 && raw.steps.length === 2) {
        address(tx.to, stock.address);
        try {
          const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
          if (decoded.functionName !== "approve" || decoded.args[1] !== amount ||
            ![APPROVAL_PROXY, DEPOSITORY].some((a) => sameAddress(decoded.args[0], a))) invalid();
        } catch { invalid(); }
      } else if (step.id === "deposit" && index === raw.steps.length - 1) {
        address(tx.to);
        if (![APPROVAL_PROXY, DEPOSITORY].some((a) => sameAddress(tx.to, a))) invalid();
        deposits++;
      } else invalid();
    }
    if (deposits !== 1) invalid();
    return { raw, quote: {
      source: "Relay", requestId: raw.requestId, quotedAt, expiresAt: quotedAt + TTL_MS,
      originChainId: 8453, destinationChainId: 4663,
      treasury: this.treasury, destinationRecipient: this.treasury,
      burnAddress: MUSEGOD_BUYBACK.burnAddress, refundTo: this.treasury,
      stockAddress: stock.address, stockSymbol: stock.symbol, stockDecimals: 8,
      amountIn: amount.toString(), amountInFormatted: formatUnits(amount, 8),
      tokenAddress: MUSEGOD_BUYBACK.tokenAddress, tokenDecimals: 18,
      expectedOut: expectedOut.toString(), minimumOut: minimumOut.toString(),
      expectedOutFormatted: formatUnits(expectedOut, 18), minimumOutFormatted: formatUnits(minimumOut, 18),
      slippageBps: 100, totalImpactPercent: decimal(details.totalImpact?.percent),
      relayerFeeUsd: decimal(raw.fees?.relayer?.amountUsd), gasFeeUsd: decimal(raw.fees?.gas?.amountUsd),
      refundCurrencies, executionAvailable: false, requiresSeparateBurn: true,
    } };
  }

  private async rpcBatch(calls: { method: string; params: unknown[] }[]) {
    const raw = await this.request(RPC, calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call })));
    if (!Array.isArray(raw) || raw.length !== calls.length)
      throw new BuybackError("INVALID_RPC", "Robinhood onchain data verification failed");
    return calls.map((_, id) => {
      const matches = raw.filter((r) => r?.id === id);
      if (matches.length !== 1 || matches[0].error || matches[0].jsonrpc !== "2.0" ||
        typeof matches[0].result !== "string" || !/^0x[0-9a-fA-F]+$/.test(matches[0].result))
        throw new BuybackError("INVALID_RPC", "Robinhood onchain data verification failed");
      return matches[0].result as Hex;
    });
  }

  async readMUSEGODStats(): Promise<MUSEGODStats> {
    const [chain, block] = await this.rpcBatch([
      { method: "eth_chainId", params: [] }, { method: "eth_blockNumber", params: [] },
    ]);
    if (BigInt(chain) !== BigInt(MUSEGOD_BUYBACK.chainId))
      throw new BuybackError("WRONG_CHAIN", "The MUSEGOD RPC network does not match");
    const names = ["name", "symbol", "decimals", "totalSupply", "balanceOf"] as const;
    const values = await this.rpcBatch([
      { method: "eth_getCode", params: [MUSEGOD_BUYBACK.tokenAddress, block] },
      ...names.map((functionName) => ({ method: "eth_call", params: [{
        to: MUSEGOD_BUYBACK.tokenAddress,
        data: functionName === "balanceOf"
          ? encodeFunctionData({ abi: erc20Abi, functionName, args: [MUSEGOD_BUYBACK.burnAddress] })
          : encodeFunctionData({ abi: erc20Abi, functionName }),
      }, block] })),
    ]);
    try {
      if (values[0].length <= 2) throw new Error();
      const decoded = names.map((functionName, index) => decodeFunctionResult({
        abi: erc20Abi, functionName, data: values[index + 1],
      }));
      const [name, symbol, decimals, totalSupply, deadBalance] = decoded;
      if (name !== "MUSEGOD" || symbol !== "MUSEGOD" || decimals !== 18 ||
        typeof totalSupply !== "bigint" || typeof deadBalance !== "bigint" ||
        totalSupply <= 0n || deadBalance > totalSupply) throw new Error();
      return { source: "Robinhood Chain RPC", chainId: 4663,
        tokenAddress: MUSEGOD_BUYBACK.tokenAddress, burnAddress: MUSEGOD_BUYBACK.burnAddress,
        symbol: "MUSEGOD", decimals: 18, totalSupply: totalSupply.toString(),
        deadBalance: deadBalance.toString(), blockNumber: BigInt(block).toString(),
        checkedAt: this.now(), scope: "global" };
    } catch {
      throw new BuybackError("INVALID_TOKEN", "The MUSEGOD contract identity or balance could not be verified");
    }
  }
}

export const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f" as Address;
const KYBER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5" as Address;
const KYBER_EXECUTOR = "0x8f10b468b06c6fd214b65f87778827f7d113f996";
const SOLVER = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
export const BUYBACK_CODE_HASHES: Record<string, Hex> = {
  [APPROVAL_PROXY]: "0xa3b36a6aa3c2fb588b92336d88b0735b40dea0282c110d2034edf688ca661b5b",
  [RELAY_ROUTER]: "0xde894e5c12e9513d50613c8fff375ecbf19b5d9a53bec0662e2b9667e3ec8f15",
  [KYBER]: "0x99590941aab8e1eaf2ceb825abf64b6956e82ce41e8966d7e320846905db85e3",
  [DEPOSITORY]: "0x77df38a47ee0c4453bc1bdc5f322712f0104ba1d97c4798dd49f16d4ed2e6256",
  [KYBER_EXECUTOR]: "0xc3fe18bd9e1e31adecfcaba58177f3d796c3028e7d53a628e321e18295e10682",
};
export const approvalProxyAbi = parseAbi([
  "function transferAndMulticall(address[] tokens,uint256[] amounts,(address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata)",
]);
const cleanupAbi = parseAbi(["function cleanupNativeViaCall(uint256 amount,address to,bytes data)"]);
const depositAbi = parseAbi(["function depositNative(address depositor,bytes32 id)"]);
const kyberAbi = parseAbi([
  "function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256 returnAmount,uint256 gasUsed)",
]);

// Relay v1 EIP-712 Order schema, checked against settlement-sdk 0.0.144.
// This integration accepts EVM Base/Robinhood only, whose addresses encode as 20 bytes.
// https://docs.relay.link/references/api/api_core_concepts/input-validation
const orderTypes = {
  Order: [{ name: "version", type: "string" }, { name: "solverChainId", type: "string" }, { name: "solver", type: "address" }, { name: "salt", type: "uint256" }, { name: "inputs", type: "Input[]" }, { name: "output", type: "Output" }, { name: "fees", type: "Fee[]" }],
  Input: [{ name: "payment", type: "InputPayment" }, { name: "refunds", type: "InputRefund[]" }],
  InputPayment: [{ name: "chainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }, { name: "weight", type: "uint256" }],
  InputRefund: [{ name: "chainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "deadline", type: "uint32" }, { name: "extraData", type: "bytes" }],
  Output: [{ name: "chainId", type: "string" }, { name: "payments", type: "OutputPayment[]" }, { name: "deadline", type: "uint32" }, { name: "calls", type: "bytes[]" }, { name: "extraData", type: "bytes" }],
  OutputPayment: [{ name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "expectedAmount", type: "uint256" }],
  Fee: [{ name: "recipientChainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currencyChainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }],
} as const;
export function relayOrderId(order: Record<string, any>): Hex {
  return hashStruct({ types: orderTypes, primaryType: "Order", data: order as any });
}

// Relay's current EVM request tag reverses the 64 hexadecimal characters and
// appends the operation suffix 00. Verified against public completed Robinhood
// token receipts; it is not the signed protocol order hash.
export function relayRequestMetadata(requestId: string): Hex {
  if (!/^0x[0-9a-f]{64}$/i.test(requestId)) invalid();
  return `0x${requestId.slice(2).toLowerCase().split("").reverse().join("")}00`;
}

// Only the inspected Base stock -> Kyber ETH -> canonical Relay deposit layout is supported.
// Unknown routes fail closed; upstream executable bytes are never blindly forwarded.
export async function validateRelayExecution(quote: BuybackQuote, raw: Record<string, any>): Promise<{ approval: BuybackStep; deposit: BuybackStep; orderId: Hex; metadata: Hex; nativeDepositAmount: string }> {
  try {
    const p = object(object(raw.protocol).v2), order = object(p.orderData);
    const orderId = relayOrderId(order);
    if (p.hubType !== "onchain" || orderId.toLowerCase() !== p.orderId?.toLowerCase() ||
      order.version !== "v1" || order.solverChainId !== "base") invalid();
    address(order.solver, SOLVER);
    address(await recoverMessageAddress({ message: { raw: orderId }, signature: p.orderSignature }), SOLVER);
    if (!Array.isArray(order.inputs) || order.inputs.length !== 1) invalid();
    const payment = object(order.inputs[0].payment);
    if (payment.chainId !== "base" || payment.weight !== "1") invalid();
    address(payment.currency, zeroAddress);
    const paymentAmount = uint(payment.amount, true);
    const pd = object(p.paymentDetails);
    if (pd.chainId !== "base" || uint(pd.amount, true) !== paymentAmount) invalid();
    address(pd.currency, zeroAddress); address(pd.depository, DEPOSITORY);
    // Protocol input.amount is expected input, not an exact-fill requirement.
    // The published Oracle accepts input shortage but keeps the signed output
    // minimum unscaled. Relay quotes destination input from the origin minimum
    // minus its fee. Verify this complete equation before allowing a shortfall.
    // https://docs.relay.link/references/api/api_core_concepts/surplus-and-shortage
    // relay-protocol-oracle 55b22de: attestSolverFill L906-936, _getDepositsDetails L1886-1900.
    const route = object(object(raw.details).route);
    const originOutput = object(object(route.origin).outputCurrency);
    const destinationInput = object(object(route.destination).inputCurrency);
    const destinationOutput = object(object(route.destination).outputCurrency);
    currency(originOutput.currency, 8453, zeroAddress, 18);
    currency(destinationInput.currency, 4663, zeroAddress, 18);
    currency(destinationOutput.currency, 4663, MUSEGOD_BUYBACK.tokenAddress, 18);
    const quotedSourceMinimum = paymentAmount * 9900n / 10000n;
    const sourceMinimum = (paymentAmount * 9900n + 9999n) / 10000n;
    if (uint(originOutput.amount, true) !== paymentAmount || uint(originOutput.minimumAmount, true) !== quotedSourceMinimum ||
      uint(destinationOutput.amount, true) !== BigInt(quote.expectedOut) ||
      uint(destinationOutput.minimumAmount, true) !== BigInt(quote.minimumOut) ||
      uint(order.output.payments[0].minimumAmount, true) !== BigInt(quote.minimumOut)) invalid();
    const relayerFee = object(object(raw.fees).relayer);
    currency(relayerFee.currency, 8453, zeroAddress, 18);
    const feeAmount = uint(relayerFee.amount);
    if (feeAmount >= quotedSourceMinimum || uint(destinationInput.amount, true) !== quotedSourceMinimum - feeAmount ||
      uint(destinationInput.minimumAmount, true) !== quotedSourceMinimum - feeAmount) invalid();
    const routerData = `0x${"0".repeat(24)}${RELAY_ROUTER.slice(2)}`;
    if (order.output.extraData.toLowerCase() !== routerData.toLowerCase()) invalid();
    if (order.inputs[0].refunds.length !== 2 ||
      new Set(order.inputs[0].refunds.map((r: any) => r.chainId)).size !== 2) invalid();
    for (const refund of order.inputs[0].refunds) {
      if (refund.extraData.toLowerCase() !== routerData.toLowerCase() ||
        !["base", "robinhood"].includes(refund.chainId) || uint(refund.minimumAmount) !== 0n ||
        refund.deadline !== order.output.deadline || refund.deadline * 1000 <= quote.quotedAt ||
        refund.deadline * 1000 > quote.quotedAt + 8 * 86_400_000) invalid();
      address(refund.recipient, quote.treasury);
      address(refund.currency, zeroAddress);
    }
    const depositStep = raw.steps.find((s: any) => s.id === "deposit");
    const tx = object(depositStep.items[0].data);
    address(tx.to, APPROVAL_PROXY);
    const decoded = decodeFunctionData({ abi: approvalProxyAbi, data: tx.data });
    const [tokens, amounts, calls, , , metadata] = decoded.args;
    if (tokens.length !== 1 || amounts.length !== 1 || calls.length !== 3 ||
      amounts[0] !== BigInt(quote.amountIn) || metadata.toLowerCase() !== relayRequestMetadata(quote.requestId)) invalid();
    address(tokens[0], quote.stockAddress);
    for (const call of calls) if (call.allowFailure || call.value !== 0n) invalid();
    address(calls[0].target, quote.stockAddress);
    const approval = decodeFunctionData({ abi: erc20Abi, data: calls[0].callData });
    if (approval.functionName !== "approve" || approval.args[1] !== amounts[0]) invalid();
    address(approval.args[0], KYBER);
    address(calls[1].target, KYBER);
    const swap = decodeFunctionData({ abi: kyberAbi, data: calls[1].callData });
    const execution = swap.args[0], desc = execution.desc;
    address(execution.callTarget, KYBER_EXECUTOR);
    address(execution.approveTarget, zeroAddress);
    address(desc.srcToken, quote.stockAddress);
    address(desc.dstToken, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    address(desc.dstReceiver, RELAY_ROUTER);
    if (desc.amount !== amounts[0] || desc.flags !== 512n || desc.permit !== "0x" ||
      desc.srcReceivers.length !== 1 || desc.srcAmounts.length !== 1 || desc.srcAmounts[0] !== amounts[0] ||
      desc.feeReceivers.length !== 0 || desc.feeAmounts.length !== 0 ||
      desc.minReturnAmount < quotedSourceMinimum - 1n || desc.minReturnAmount > paymentAmount)
      invalid();
    address(desc.srcReceivers[0], KYBER_EXECUTOR);
    address(calls[2].target, RELAY_ROUTER);
    const cleanup = decodeFunctionData({ abi: cleanupAbi, data: calls[2].callData });
    address(cleanup.args[1], DEPOSITORY);
    const deposit = decodeFunctionData({ abi: depositAbi, data: cleanup.args[2] });
    address(deposit.args[0], quote.treasury);
    if (deposit.args[1].toLowerCase() !== orderId.toLowerCase()) invalid();
    // Tighten (never loosen) source min to ceil(expected * 99%), accounting for
    // the API's floor and Kyber's observed one-wei-lower rounding. Deposit this minimum;
    // any additional native output returns to treasury via Router.multicall.
    // The solver-signed MUSEGOD output minimum is never scaled down or rewritten.
    const safeCalls = [...calls];
    safeCalls[1] = { ...calls[1], callData: encodeFunctionData({ abi: kyberAbi, functionName: "swap", args: [{
      ...execution, desc: { ...desc, minReturnAmount: desc.minReturnAmount > sourceMinimum ? desc.minReturnAmount : sourceMinimum },
    }] }) };
    safeCalls[2] = { ...calls[2], callData: encodeFunctionData({ abi: cleanupAbi, functionName: "cleanupNativeViaCall", args: [sourceMinimum, DEPOSITORY as Address, cleanup.args[2]] }) };
    const common = { batchId: quote.requestId, chainId: 8453 as const, from: quote.treasury,
      value: "0", expiresAt: quote.expiresAt, amount: quote.amountIn, stockAddress: quote.stockAddress };
    return { orderId, metadata, nativeDepositAmount: sourceMinimum.toString(),
      approval: { ...common, kind: "approval", to: quote.stockAddress, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [APPROVAL_PROXY as Address, amounts[0]] }) },
      deposit: { ...common, kind: "deposit", to: APPROVAL_PROXY as Address,
        data: encodeFunctionData({ abi: approvalProxyAbi, functionName: "transferAndMulticall", args: [tokens, amounts, safeCalls, quote.treasury, quote.treasury, metadata] }) },
    };
  } catch {
    throw new BuybackError("UNVERIFIED_EXECUTION", "The buyback route could not be bound to its funds and order. Signing preparation is blocked.");
  }
}
