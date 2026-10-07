import { decodeFunctionData, formatUnits, getAddress, isAddress, keccak256, type Hex, type PublicClient, type Transport } from "viem";
import { sameAddress } from "../src/lib/config";
import { FIRST_BUY_PAYMENT_CONTRACTS, FIRST_BUY_PAYMENT_TTL, assertFirstBuyPaymentQuote, firstBuyDiamondAbi,
  firstBuyInteger, firstBuyPaymentAbi, firstBuyPaymentAssets, firstBuyPaymentInput, firstBuyReceiptOutput,
  type FirstBuyPaymentAsset, type FirstBuyPaymentChain, type FirstBuyPaymentQuote, type FirstBuyPaymentQuoteInput,
  type FirstBuyPaymentVerification, type FirstBuyPrices, type FirstBuySwapData } from "../src/lib/first-buy-payment";

export type FirstBuyPaymentDependencies = { client: PublicClient<Transport, any>; chainId: FirstBuyPaymentChain;
  rpcChainId?: FirstBuyPaymentChain | 31337; integrator?: string; apiKey?: string; fetch?: typeof fetch; now?: () => number };
const API = "https://li.quest/v1";
const MAX_RESPONSE = 1_000_000;
const RPC_TIMEOUT = 15_000;
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The payment provider returned invalid data.");
  return value as Record<string, any>;
}
function tokenMatches(value: unknown, asset: FirstBuyPaymentAsset): Record<string, any> {
  const token = record(value);
  if (!isAddress(token.address ?? "", { strict: false }) || !sameAddress(token.address, asset.address) ||
    token.chainId !== asset.chainId || token.decimals !== asset.decimals || token.symbol !== asset.symbol)
    throw new Error("The payment provider token identity did not match the verified asset.");
  return token;
}
function price(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,24})?$/.test(value) || Number(value) <= 0) return null;
  return value;
}
function usd(amount: bigint, decimals: number, value: unknown): string | null {
  const p = price(value);
  if (!p) return null;
  const [whole, fraction = ""] = p.split(".");
  const total = amount * BigInt(whole + fraction) * 1_000_000n / (10n ** BigInt(decimals + fraction.length));
  return formatUnits(total, 6);
}
// RPC and fetch errors may contain URLs or headers with credentials. Only these
// fixed messages cross the API boundary, never upstream exception text or JSON.
async function bounded<T>(work: () => Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), RPC_TIMEOUT);
    })]);
  } catch { throw new Error(message); } finally { if (timer) clearTimeout(timer); }
}
export class FirstBuyPaymentReader {
  readonly client: PublicClient<Transport, any>;
  readonly chainId: FirstBuyPaymentChain;
  readonly rpcChainId: FirstBuyPaymentChain | 31337;
  readonly integrator: string;
  private readonly apiKey?: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(deps: FirstBuyPaymentDependencies) {
    this.client = deps.client;
    this.chainId = deps.chainId;
    this.rpcChainId = deps.rpcChainId ?? deps.chainId;
    this.integrator = deps.integrator ?? "musegodfun";
    this.apiKey = deps.apiKey;
    this.fetcher = deps.fetch ?? fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
    if (![8453, 4663].includes(deps.chainId) || (this.rpcChainId !== deps.chainId && this.rpcChainId !== 31337) ||
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(this.integrator) ||
      (this.apiKey !== undefined && (typeof this.apiKey !== "string" || this.apiKey.length > 512 || /[\r\n]/.test(this.apiKey))))
      throw new Error("Invalid server-side payment provider configuration.");
  }
  private async request(path: string, params: URLSearchParams): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RPC_TIMEOUT);
    try {
      const response = await this.fetcher(`${API}/${path}?${params}`, { redirect: "manual", signal: abort.signal,
        headers: this.apiKey ? { "x-lifi-api-key": this.apiKey, Accept: "application/json" } : { Accept: "application/json" } });
      if (!response.ok || response.status < 200 || response.status >= 300)
        throw new Error("upstream response rejected");
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw new Error("upstream response too large");
      if (!response.body) throw new Error("empty upstream response");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          total += result.value.byteLength;
          if (total > MAX_RESPONSE) { await reader.cancel(); throw new Error("upstream response too large"); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { throw new Error("LI.FI pricing or routing is unavailable. Try again later."); }
    finally { clearTimeout(timer); }
  }
  // Opening-price probes reuse the same bounded, server-only HTTP boundary.
  // These requests only read token/quote data and never expose a transaction
  // as signable calldata or relax payment validation.
  async pricingRequest(path: "token" | "quote", params: URLSearchParams): Promise<unknown> {
    if (path !== "token" && path !== "quote") throw new Error("Invalid LI.FI pricing request.");
    return this.request(path, params);
  }
  async prices(pairedAsset?: string): Promise<FirstBuyPrices> {
    const quotedAt = this.now();
    const assets = firstBuyPaymentAssets(this.chainId, pairedAsset);
    const priced = await Promise.all(assets.map(async (asset) => {
      try {
        const result = tokenMatches(await this.request("token", new URLSearchParams({ chain: String(this.chainId), token: asset.address })), asset);
        return { ...asset, priceUsd: price(result.priceUSD) };
      } catch { return { ...asset, priceUsd: null }; }
    }));
    if (this.now() >= quotedAt + FIRST_BUY_PAYMENT_TTL) throw new Error("The payment prices expired. Refresh prices.");
    return { chainId: this.chainId, quotedAt, expiresAt: quotedAt + FIRST_BUY_PAYMENT_TTL, referenceOnly: true, assets: priced };
  }
  private async identity(selector: Hex, swaps?: FirstBuySwapData[]) {
    const registry = FIRST_BUY_PAYMENT_CONTRACTS[this.chainId];
    if (!registry.sourceVerified) throw new Error("Payment router source verification is pending.");
    const message = "The LI.FI payment router identity could not be verified. Request a new quote.";
    const [chainId, block] = await Promise.all([
      bounded(() => this.client.getChainId(), message), bounded(() => this.client.getBlock({ blockTag: "latest" }), message),
    ]);
    if (chainId !== this.rpcChainId || block.number === null || block.hash === null)
      throw new Error("The payment RPC does not match the active network.");
    const blockNumber = block.number;
    const [facet, code] = await Promise.all([
      bounded(() => this.client.readContract({ address: registry.diamond, abi: firstBuyDiamondAbi,
        functionName: "facetAddress", args: [selector], blockNumber }), message),
      bounded(() => this.client.getCode({ address: registry.facet, blockNumber }), message),
    ]);
    if (!sameAddress(facet, registry.facet) || !code || keccak256(code) !== registry.runtimeHash)
      throw new Error("The LI.FI router implementation changed. Payments are paused for verification.");
    if (swaps) {
      await Promise.all(swaps.map(async (swap) => {
        const callSelector = swap.callData.slice(0, 10) as Hex;
        const allowed = this.chainId === 4663
          ? [await bounded(() => this.client.readContract({ address: registry.diamond, abi: firstBuyDiamondAbi,
            functionName: "isContractSelectorWhitelisted", args: [swap.callTo, callSelector], blockNumber }), message)]
          : await Promise.all([
            bounded(() => this.client.readContract({ address: registry.diamond, abi: firstBuyDiamondAbi,
              functionName: "isAddressWhitelisted", args: [swap.callTo], blockNumber }), message),
            bounded(() => this.client.readContract({ address: registry.diamond, abi: firstBuyDiamondAbi,
              functionName: "isFunctionSelectorWhitelisted", args: [callSelector], blockNumber }), message),
          ]);
        if (swap.approveTo !== swap.callTo) allowed.push(await bounded(() => this.client.readContract({ address: registry.diamond,
          abi: firstBuyDiamondAbi, functionName: this.chainId === 4663 ? "isContractSelectorWhitelisted" : "isAddressWhitelisted",
          args: (this.chainId === 4663 ? [swap.approveTo, "0xffffffff"] : [swap.approveTo]) as never, blockNumber }), message));
        if (allowed.some((item) => item !== true)) throw new Error("The payment route is not allowed by the verified LI.FI router.");
      }));
    }
    if ((await bounded(() => this.client.getBlock({ blockNumber }), message)).hash !== block.hash)
      throw new Error("The payment quote block changed. Request a new quote.");
    return block;
  }
  async quote(input: FirstBuyPaymentQuoteInput): Promise<FirstBuyPaymentQuote> {
    const quotedAt = this.now();
    const normalized = firstBuyPaymentInput(this.chainId, input);
    const params = new URLSearchParams({ fromChain: String(this.chainId), toChain: String(this.chainId),
      fromToken: normalized.fromToken.address, toToken: normalized.toToken.address, fromAmount: normalized.amountIn.toString(),
      fromAddress: normalized.account, toAddress: normalized.account, slippage: String(input.slippageBps / 10_000),
      integrator: this.integrator, fee: "0", allowBridges: "none", skipSimulation: "false" });
    const raw = record(await this.request("quote", params)), action = record(raw.action), estimate = record(raw.estimate), tx = record(raw.transactionRequest);
    const fromToken = tokenMatches(action.fromToken, normalized.fromToken);
    tokenMatches(action.toToken, normalized.toToken);
    const registry = FIRST_BUY_PAYMENT_CONTRACTS[this.chainId];
    if (action.fromChainId !== this.chainId || action.toChainId !== this.chainId ||
      !sameAddress(action.fromAddress ?? "", normalized.account) || !sameAddress(action.toAddress ?? "", normalized.account) ||
      action.fromAmount !== normalized.amountIn.toString() || action.slippage !== input.slippageBps / 10_000 ||
      estimate.fromAmount !== action.fromAmount || !sameAddress(estimate.approvalAddress ?? "", registry.diamond) ||
      tx.chainId !== this.chainId || !sameAddress(tx.from ?? "", normalized.account) || !sameAddress(tx.to ?? "", registry.diamond) ||
      typeof tx.data !== "string" || typeof tx.value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(tx.value) ||
      !Array.isArray(estimate.feeCosts) || !Array.isArray(raw.includedSteps) ||
      raw.includedSteps.some((step: any) => !["swap", "protocol"].includes(step?.type) ||
        step?.action?.fromChainId !== this.chainId || step?.action?.toChainId !== this.chainId))
      throw new Error("LI.FI returned a payment route outside the supported same-chain flow.");
    let feeAmount = 0n;
    for (const value of estimate.feeCosts) {
      const fee = record(value), split = record(fee.feeSplit);
      tokenMatches(fee.token, normalized.fromToken);
      const amount = firstBuyInteger(fee.amount, false);
      if (fee.name !== "LIFI Fixed Fee" || fee.included !== true || split.integratorFee !== "0" ||
        firstBuyInteger(split.lifiFee, false) !== amount || feeAmount > 0n)
        throw new Error("The payment quote contains an unsupported fee.");
      feeAmount += amount;
    }
    const native = normalized.fromToken.address === "0x0000000000000000000000000000000000000000";
    const quote: FirstBuyPaymentQuote = { protocol: "lifi", id: raw.id, transactionId: `0x${"0".repeat(64)}`,
      integrator: this.integrator, tool: raw.tool, chainId: this.chainId, account: normalized.account,
      fromToken: normalized.fromToken, toToken: normalized.toToken, amountIn: normalized.amountIn.toString(),
      expectedOut: estimate.toAmount, minimumOut: estimate.toAmountMin, slippageBps: input.slippageBps,
      quotedAt, expiresAt: quotedAt + FIRST_BUY_PAYMENT_TTL, router: registry.diamond, facet: registry.facet,
      facetRuntimeHash: registry.runtimeHash, blockNumber: "0", blockHash: `0x${"0".repeat(64)}`,
      transaction: { to: getAddress(tx.to), data: tx.data as Hex, value: BigInt(tx.value).toString() },
      approval: native ? null : { token: normalized.fromToken.address, spender: registry.diamond, amount: normalized.amountIn.toString() },
      feeAmount: feeAmount.toString(), feeUsd: usd(feeAmount, normalized.fromToken.decimals, fromToken.priceUSD),
      amountInUsd: usd(normalized.amountIn, normalized.fromToken.decimals, fromToken.priceUSD), gasFeeUsd: null };
    // Decode only the fixed V3 ABI, before RPC checks or any wallet action.
    try { quote.transactionId = decodeFunctionData({ abi: firstBuyPaymentAbi, data: quote.transaction.data }).args[0]; }
    catch { throw new Error("LI.FI returned an unsupported payment transaction."); }
    const swaps = assertFirstBuyPaymentQuote(quote, this.now());
    const block = await this.identity(quote.transaction.data.slice(0, 10) as Hex, swaps);
    quote.blockNumber = block.number!.toString(); quote.blockHash = block.hash!;
    let gasUsd = 0n;
    if (Array.isArray(estimate.gasCosts)) for (const value of estimate.gasCosts) {
      const cost = record(value), gasToken = record(cost.token);
      if (gasToken.chainId !== this.chainId || !sameAddress(gasToken.address ?? "", "0x0000000000000000000000000000000000000000"))
        throw new Error("The payment gas estimate is on the wrong network.");
      const amountUsd = usd(firstBuyInteger(cost.amount, false), 18, gasToken.priceUSD);
      if (amountUsd === null) { quote.gasFeeUsd = null; break; }
      const [whole, fraction = ""] = amountUsd.split(".");
      gasUsd += BigInt(whole + fraction.padEnd(6, "0"));
      quote.gasFeeUsd = formatUnits(gasUsd, 6);
    }
    assertFirstBuyPaymentQuote(quote, this.now());
    // Price fields are display estimates, never the launch opening-price source.
    return quote;
  }
  async verify(input: { quote: FirstBuyPaymentQuote; hash: Hex }): Promise<FirstBuyPaymentVerification> {
    const q = input?.quote;
    if (!q || q.chainId !== this.chainId || !/^0x[\da-fA-F]{64}$/.test(input.hash)) throw new Error("Invalid payment receipt request.");
    assertFirstBuyPaymentQuote(q, this.now(), true);
    const message = "The payment receipt could not be verified. Its status remains unknown.";
    if (await bounded(() => this.client.getChainId(), message) !== this.rpcChainId) throw new Error("The payment receipt RPC is on the wrong network.");
    const receipt = await bounded(async () => {
      try { return await this.client.getTransactionReceipt({ hash: input.hash }); }
      catch (error) {
        if ((error as { name?: string })?.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    }, message);
    if (!receipt) return { status: "pending", hash: input.hash, actualOutput: null, blockNumber: null, blockHash: null };
    const [tx, block, head] = await Promise.all([
      bounded(() => this.client.getTransaction({ hash: input.hash }), message),
      bounded(() => this.client.getBlock({ blockNumber: receipt.blockNumber }), message),
      bounded(() => this.client.getBlockNumber({ cacheTime: 0 }), message),
    ]);
    if (!sameAddress(tx.from, q.account) || !tx.to || !sameAddress(tx.to, q.router) || tx.chainId !== this.rpcChainId ||
      tx.input.toLowerCase() !== q.transaction.data.toLowerCase() || tx.value !== BigInt(q.transaction.value) ||
      tx.hash.toLowerCase() !== input.hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== input.hash.toLowerCase() ||
      block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber ||
      !["success", "reverted"].includes(receipt.status))
      throw new Error("The payment transaction does not match the frozen quote or canonical receipt.");
    // Recovery goes directly through this reader, so the API itself must uphold
    // the same two-confirmation boundary as the initial wallet confirmation.
    if (head < receipt.blockNumber + 1n) return { status: "pending", hash: input.hash, actualOutput: null,
      blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
    if (receipt.status === "reverted") return { status: "reverted", hash: input.hash, actualOutput: null,
      blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
    const actualOutput = firstBuyReceiptOutput(q, receipt.logs).toString();
    // Do not use a newer wallet balance or LI.FI status response as output proof.
    return { status: "success", hash: input.hash, actualOutput, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
  }
}
export const readFirstBuyPrices = (chainId: FirstBuyPaymentChain, pairedAsset: string | undefined, deps: Omit<FirstBuyPaymentDependencies, "chainId">) =>
  new FirstBuyPaymentReader({ ...deps, chainId }).prices(pairedAsset);
export const quoteFirstBuyPayment = (input: FirstBuyPaymentQuoteInput & { chainId: FirstBuyPaymentChain }, deps: Omit<FirstBuyPaymentDependencies, "chainId">) =>
  new FirstBuyPaymentReader({ ...deps, chainId: input.chainId }).quote(input);
export const verifyFirstBuyPayment = (quote: FirstBuyPaymentQuote, hash: Hex, deps: Omit<FirstBuyPaymentDependencies, "chainId">) =>
  new FirstBuyPaymentReader({ ...deps, chainId: quote.chainId }).verify({ quote, hash });
