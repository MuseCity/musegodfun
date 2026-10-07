import { quoteNow } from "./quote-clock";
import { decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, isAddress, parseAbi,
  parseUnits, formatUnits, zeroAddress, toEventSelector, keccak256, type Address, type Hex } from "viem";
import { ROBINHOOD_STOCKS, STOCKS, sameAddress } from "./config";

export const FIRST_BUY_PAYMENT_TTL = 60_000;
export const FIRST_BUY_SLIPPAGE_BPS = [50, 100, 200, 500] as const;
export type FirstBuyPaymentChain = 8453 | 4663;
export type FirstBuyPaymentAsset = { chainId: FirstBuyPaymentChain; address: Address; symbol: string; decimals: number };
export const FIRST_BUY_PAYMENT_CONTRACTS = Object.freeze({
  8453: Object.freeze({ diamond: getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"),
    facet: getAddress("0x31a9b1835864706Af10103b31Ea2b79bdb995F5F"),
    runtimeHash: "0xc207f6fc07b111370c4d536c8c36de974367fd8876c867e390a5535cb120dbd7" as Hex,
    feeForwarder: getAddress("0xCE40449B773a3E6E5e769ADb4e567179d4828cbd"),
    sourceVerified: true, sourceMatch: "exact_match", sourceMatchId: "4331115",
    source: "https://sourcify.dev/server/v2/contract/8453/0x31a9b1835864706Af10103b31Ea2b79bdb995F5F?fields=all" }),
  4663: Object.freeze({ diamond: getAddress("0xB477751B76CF82d00a686A1232f5fCD772414Af3"),
    facet: getAddress("0xB129ce9C3fCD55726Ff314a2764d3937FA496071"),
    runtimeHash: "0xdb3f706ca7f78237a197ccab9300628db168f0bc6c509835771200f9c163daa5" as Hex,
    feeForwarder: getAddress("0xF4BFFE4dfC693f37715A47c15BdA8af9ed8f7Cf1"),
    sourceVerified: true, sourceMatch: "match", sourceMatchId: "51550570",
    source: "https://sourcify.dev/server/v2/contract/4663/0xB129ce9C3fCD55726Ff314a2764d3937FA496071?fields=all" }),
});
// Source records read 2026-10-06; their onchainBytecode hashes equal independently
// fetched RPC runtime bytes. Robinhood's match excludes metadata differences.
const STABLE_ASSETS: Record<FirstBuyPaymentChain, FirstBuyPaymentAsset[]> = {
  8453: [{ chainId: 8453, address: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), symbol: "USDC", decimals: 6 },
    { chainId: 8453, address: getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"), symbol: "USDT", decimals: 6 }],
  4663: [{ chainId: 4663, address: getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"), symbol: "USDG", decimals: 6 }],
};
export function firstBuyPairedAsset(chainId: FirstBuyPaymentChain, address: string): FirstBuyPaymentAsset {
  if (![8453, 4663].includes(chainId) || !isAddress(address, { strict: false })) throw new Error("Invalid payment network or asset.");
  const assets = chainId === 4663 ? ROBINHOOD_STOCKS : STOCKS;
  const wrapped: FirstBuyPaymentAsset = { chainId, address: wrappedEther(chainId), symbol: "WETH", decimals: 18 };
  const asset = [...assets, ...STABLE_ASSETS[chainId], wrapped].find((item) => sameAddress(item.address, address));
  if (!asset) throw new Error("Select a verified paired asset on the active network.");
  return { chainId, address: getAddress(asset.address), symbol: asset.symbol, decimals: asset.decimals };
}
export function firstBuyPaymentAssets(chainId: FirstBuyPaymentChain, pairedAsset?: string): FirstBuyPaymentAsset[] {
  if (![8453, 4663].includes(chainId)) throw new Error("Unsupported payment network.");
  const paired = pairedAsset ? firstBuyPairedAsset(chainId, pairedAsset) : undefined;
  return [...(paired ? [paired] : []), ...STABLE_ASSETS[chainId],
    { chainId, address: zeroAddress, symbol: "ETH", decimals: 18 } as FirstBuyPaymentAsset]
    .filter((asset, i, all) => all.findIndex((other) => sameAddress(other.address, asset.address)) === i)
    .map((asset) => ({ ...asset }));
}
const swapTuple = "(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)";
export const firstBuyPaymentAbi = parseAbi([
  `function swapTokensSingleV3NativeToERC20(bytes32 transactionId,string integrator,string referrer,address receiver,uint256 minAmountOut,${swapTuple} swapData) payable`,
  `function swapTokensMultipleV3NativeToERC20(bytes32 transactionId,string integrator,string referrer,address receiver,uint256 minAmountOut,${swapTuple}[] swapData) payable`,
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId,string integrator,string referrer,address receiver,uint256 minAmountOut,${swapTuple} swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(bytes32 transactionId,string integrator,string referrer,address receiver,uint256 minAmountOut,${swapTuple}[] swapData)`,
  "event LiFiGenericSwapCompleted(bytes32 indexed transactionId,string integrator,string referrer,address receiver,address fromAssetId,address toAssetId,uint256 fromAmount,uint256 toAmount)",
]);
export const firstBuyFeeAbi = parseAbi([
  "function forwardNativeFees((address recipient,uint256 amount)[] distributions) payable",
  "function forwardERC20Fees(address token,(address recipient,uint256 amount)[] distributions)",
]);
export const firstBuyDiamondAbi = parseAbi([
  "function facetAddress(bytes4 selector) view returns (address)",
  "function isContractSelectorWhitelisted(address target,bytes4 selector) view returns (bool)",
  "function isAddressWhitelisted(address target) view returns (bool)",
  "function isFunctionSelectorWhitelisted(bytes4 selector) view returns (bool)",
]);
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
export type FirstBuySwapData = { callTo: Address; approveTo: Address; sendingAssetId: Address; receivingAssetId: Address;
  fromAmount: bigint; callData: Hex; requiresDeposit: boolean };
export type FirstBuyPrices = { chainId: FirstBuyPaymentChain; quotedAt: number; expiresAt: number; serverTime?: number; referenceOnly: true;
  assets: (FirstBuyPaymentAsset & { priceUsd: string | null })[] };
export type FirstBuyPaymentQuoteInput = { account: string; fromToken: string; toToken: string; amount: string; slippageBps: number };
export type FirstBuyPaymentQuote = { protocol: "lifi" | "wrap"; id: string; transactionId: Hex; integrator: string; tool: string;
  chainId: FirstBuyPaymentChain; account: Address; fromToken: FirstBuyPaymentAsset; toToken: FirstBuyPaymentAsset;
  amountIn: string; expectedOut: string; minimumOut: string; slippageBps: number; quotedAt: number; expiresAt: number; serverTime?: number; intentId?: string; warnings?: string[];
  router: Address; facet: Address; facetRuntimeHash: Hex; blockNumber: string; blockHash: Hex;
  transaction: { to: Address; data: Hex; value: string }; approval: { token: Address; spender: Address; amount: string } | null;
  feeAmount: string; feeUsd: string | null; gasFeeUsd: string | null; amountInUsd: string | null };
export type FirstBuyPaymentVerification = { status: "success" | "pending" | "reverted"; hash: Hex;
  actualOutput: string | null; blockNumber: string | null; blockHash: Hex | null };
function invalid(): never { throw new Error("The first-buy payment parameters could not be verified. Request a new quote."); }
export function firstBuyInteger(value: unknown, positive = true): bigint {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return invalid();
  const n = BigInt(value);
  if ((positive ? n <= 0n : n < 0n) || n >= 2n ** 256n) return invalid();
  return n;
}
export function firstBuyPaymentInput(chainId: FirstBuyPaymentChain, input: FirstBuyPaymentQuoteInput) {
  if (!input || typeof input.fromToken !== "string" || typeof input.toToken !== "string" ||
    !isAddress(input.account, { strict: false }) || sameAddress(input.account, zeroAddress) ||
    !FIRST_BUY_SLIPPAGE_BPS.some((bps) => bps === input.slippageBps)) return invalid();
  const toToken = firstBuyPairedAsset(chainId, input.toToken);
  const fromToken = firstBuyPaymentAssets(chainId, input.toToken).find((a) => sameAddress(a.address, input.fromToken));
  if (!fromToken || sameAddress(fromToken.address, toToken.address) || typeof input.amount !== "string" ||
    !/^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/.test(input.amount) ||
    (input.amount.split(".")[1]?.length ?? 0) > fromToken.decimals) return invalid();
  const amountIn = parseUnits(input.amount, fromToken.decimals);
  if (amountIn <= 0n || amountIn >= 2n ** 256n) return invalid();
  return { account: getAddress(input.account), fromToken, toToken, amountIn };
}
function assetMatches(actual: FirstBuyPaymentAsset, expected: FirstBuyPaymentAsset) {
  return actual?.chainId === expected.chainId && sameAddress(actual?.address ?? "", expected.address) &&
    actual.symbol === expected.symbol && actual.decimals === expected.decimals;
}
/** Static checks shared by backend and wallet. The inner aggregator remains a
 * LI.FI trust boundary; only the fixed facet's onchain whitelist may call it. */
export function assertFirstBuyPaymentQuote(q: FirstBuyPaymentQuote, now = quoteNow(q), allowExpired = false): FirstBuySwapData[] {
  if (q?.protocol === "wrap") {
    const wrapped = [8453, 4663].includes(q.chainId) ? firstBuyPairedAsset(q.chainId, wrappedEther(q.chainId)) : null;
    if (!wrapped || !assetMatches(q.toToken, wrapped) || q.fromToken.address !== zeroAddress || q.fromToken.chainId !== q.chainId ||
      q.fromToken.decimals !== 18 || q.fromToken.symbol !== "ETH" || !isAddress(q.account, { strict: false }) || sameAddress(q.account, zeroAddress) ||
      !sameAddress(q.router, wrapped.address) || !sameAddress(q.facet, wrapped.address) || !/^0x[\da-f]{64}$/i.test(q.facetRuntimeHash) ||
      !/^0x[\da-f]{64}$/i.test(q.blockHash) || !/^\d{1,24}$/.test(q.blockNumber) ||
      !Number.isSafeInteger(q.quotedAt) || q.quotedAt > now || !Number.isSafeInteger(q.expiresAt) ||
      q.expiresAt <= q.quotedAt || q.expiresAt - q.quotedAt > FIRST_BUY_PAYMENT_TTL || !allowExpired && now >= q.expiresAt ||
      !sameAddress(q.transaction.to, wrapped.address) || q.transaction.data !== encodeFunctionData({ abi: wrapAbi, functionName: "deposit" }) ||
      q.approval !== null || q.feeAmount !== "0" || q.amountIn !== q.expectedOut || q.amountIn !== q.minimumOut || q.transaction.value !== q.amountIn)
      return invalid();
    firstBuyInteger(q.amountIn); return [];
  }
  if (!q || q.protocol !== "lifi" || ![8453, 4663].includes(q.chainId)) return invalid();
  const registry = FIRST_BUY_PAYMENT_CONTRACTS[q.chainId];
  const toToken = firstBuyPairedAsset(q.chainId, q.toToken?.address);
  const fromToken = firstBuyPaymentAssets(q.chainId, toToken.address).find((a) => sameAddress(a.address, q.fromToken?.address ?? ""));
  if (!fromToken || !assetMatches(q.toToken, toToken) || !assetMatches(q.fromToken, fromToken) ||
    sameAddress(fromToken.address, toToken.address) || !isAddress(q.account, { strict: false }) || sameAddress(q.account, zeroAddress) ||
    !registry.sourceVerified || !sameAddress(q.router, registry.diamond) || !sameAddress(q.facet, registry.facet) ||
    q.facetRuntimeHash !== registry.runtimeHash || !Number.isSafeInteger(q.quotedAt) || q.quotedAt <= 0 ||
    q.quotedAt > now || !Number.isSafeInteger(q.expiresAt) || q.expiresAt <= q.quotedAt ||
    q.expiresAt - q.quotedAt > FIRST_BUY_PAYMENT_TTL || (!allowExpired && now >= q.expiresAt) ||
    !Number.isInteger(q.slippageBps) || q.slippageBps < 1 || q.slippageBps > 500 ||
    !/^[a-zA-Z0-9_.-]{1,64}$/.test(q.integrator) || typeof q.tool !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(q.tool) ||
    typeof q.id !== "string" || q.id.length > 160 || !q.id || !/^0x[\da-fA-F]{64}$/.test(q.transactionId) ||
    !/^0x[\da-fA-F]{64}$/.test(q.blockHash) || !/^\d{1,24}$/.test(q.blockNumber) ||
    !q.transaction || !sameAddress(q.transaction.to, registry.diamond) ||
    !/^0x(?:[\da-fA-F]{2}){4,32768}$/.test(q.transaction.data)) return invalid();
  const amountIn = firstBuyInteger(q.amountIn), expectedOut = firstBuyInteger(q.expectedOut), minimumOut = firstBuyInteger(q.minimumOut);
  const lowerBound = expectedOut * BigInt(10_000 - q.slippageBps) / 10_000n;
  if (minimumOut < lowerBound || minimumOut > expectedOut) return invalid();
  const native = sameAddress(fromToken.address, zeroAddress);
  if (firstBuyInteger(q.transaction.value, false) !== (native ? amountIn : 0n)) return invalid();
  if (native ? q.approval !== null : !q.approval || !sameAddress(q.approval.token, fromToken.address) ||
    !sameAddress(q.approval.spender, registry.diamond) || firstBuyInteger(q.approval.amount) !== amountIn) return invalid();
  let decoded: ReturnType<typeof decodeFunctionData<typeof firstBuyPaymentAbi>>;
  try { decoded = decodeFunctionData({ abi: firstBuyPaymentAbi, data: q.transaction.data }); } catch { return invalid(); }
  if ((native ? !decoded.functionName.includes("NativeToERC20") : !decoded.functionName.includes("ERC20ToERC20"))) return invalid();
  const args = decoded.args as unknown as [Hex, string, string, Address, bigint, FirstBuySwapData | FirstBuySwapData[]];
  const [transactionId, integrator, referrer, receiver, minOut, data] = args;
  if (transactionId.toLowerCase() !== q.transactionId.toLowerCase() || integrator !== q.integrator ||
    !sameAddress(referrer, zeroAddress) || !sameAddress(receiver, q.account) || minOut !== minimumOut)
    return invalid();
  // Canonical re-encoding prevents trailing or ambiguously encoded calldata.
  const canonical = encodeFunctionData({ abi: firstBuyPaymentAbi, functionName: decoded.functionName, args: decoded.args as never });
  if (canonical.toLowerCase() !== q.transaction.data.toLowerCase()) return invalid();
  const swaps = (Array.isArray(data) ? data : [data]) as FirstBuySwapData[];
  if (swaps.length < 1 || swaps.length > 2) return invalid();
  const dex = swaps[swaps.length - 1];
  if (!sameAddress(dex.sendingAssetId, fromToken.address) || !sameAddress(dex.receivingAssetId, toToken.address) ||
    !isAddress(dex.callTo, { strict: false }) || sameAddress(dex.callTo, zeroAddress) || sameAddress(dex.callTo, registry.diamond) ||
    sameAddress(dex.callTo, registry.feeForwarder) || !isAddress(dex.approveTo, { strict: false }) ||
    !/^0x(?:[\da-fA-F]{2}){4,16384}$/.test(dex.callData) || dex.fromAmount <= 0n) return invalid();
  const feeAmount = firstBuyInteger(q.feeAmount, false);
  if (feeAmount >= amountIn || dex.fromAmount !== amountIn - feeAmount || dex.requiresDeposit !== (swaps.length === 1)) return invalid();
  if (swaps.length === 1) { if (feeAmount !== 0n) return invalid(); }
  else {
    const fee = swaps[0];
    if (!sameAddress(fee.callTo, registry.feeForwarder) || !sameAddress(fee.approveTo, registry.feeForwarder) ||
      !sameAddress(fee.sendingAssetId, fromToken.address) || !sameAddress(fee.receivingAssetId, fromToken.address) ||
      fee.fromAmount !== amountIn || !fee.requiresDeposit || feeAmount !== amountIn * 25n / 10_000n || feeAmount === 0n) return invalid();
    try {
      const feeCall = decodeFunctionData({ abi: firstBuyFeeAbi, data: fee.callData });
      if (feeCall.functionName !== (native ? "forwardNativeFees" : "forwardERC20Fees")) return invalid();
      const distributions = feeCall.functionName === "forwardNativeFees" ? feeCall.args[0] : feeCall.args[1];
      if (feeCall.functionName === "forwardERC20Fees" && !sameAddress(feeCall.args[0], fromToken.address)) return invalid();
      // Standard LI.FI fee only; adding app or arbitrary recipient fees requires a new spec.
      if (distributions.length !== 1 || !sameAddress(distributions[0].recipient, "0xC06EbBeFd94032b85424D51906E2A335efae264b") ||
        distributions[0].amount !== feeAmount || encodeFunctionData({ abi: firstBuyFeeAbi, functionName: feeCall.functionName,
          args: feeCall.args as never }).toLowerCase() !== fee.callData.toLowerCase()) return invalid();
    } catch { return invalid(); }
  }
  return swaps;
}
export type FirstBuyReceiptLog = { address: Address; topics: readonly Hex[]; data: Hex };
export function firstBuyReceiptOutput(q: FirstBuyPaymentQuote, logs: readonly FirstBuyReceiptLog[]): bigint {
  if (q.protocol === "wrap") {
    const deposits: bigint[] = [];
    for (const log of logs) {
      if (!sameAddress(log.address, wrappedEther(q.chainId))) continue;
      try {
        const event = decodeEventLog({ abi: wrapAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
        if (event.eventName === "Deposit") {
          if (!sameAddress(event.args.dst, q.account)) return invalid();
          deposits.push(event.args.wad);
        }
      } catch { if (log.topics[0]?.toLowerCase() === toEventSelector("Deposit(address,uint256)").toLowerCase()) return invalid(); }
    }
    if (deposits.length !== 1 || deposits[0] !== BigInt(q.amountIn)) return invalid();
    return deposits[0];
  }
  const completed: bigint[] = [];
  let netTransfers = 0n;
  for (const log of logs) {
    if (sameAddress(log.address, q.router)) {
      try {
        const event = decodeEventLog({ abi: firstBuyPaymentAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
        if (event.eventName !== "LiFiGenericSwapCompleted") continue;
        const args = event.args;
        if (args.transactionId.toLowerCase() !== q.transactionId.toLowerCase() || args.integrator !== q.integrator ||
          !sameAddress(args.receiver, q.account) || !sameAddress(args.fromAssetId, q.fromToken.address) ||
          !sameAddress(args.toAssetId, q.toToken.address) || args.fromAmount !== BigInt(q.amountIn)) return invalid();
        completed.push(args.toAmount);
      } catch {
        // A malformed completion event must not be mistaken for an absent event.
        if (log.topics[0]?.toLowerCase() === toEventSelector("LiFiGenericSwapCompleted(bytes32,string,string,address,address,address,uint256,uint256)").toLowerCase()) return invalid();
      }
    }
    if (sameAddress(log.address, q.toToken.address)) {
      try {
        const event = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
        if (sameAddress(event.args.to, q.account)) netTransfers += event.args.value;
        if (sameAddress(event.args.from, q.account)) netTransfers -= event.args.value;
      } catch { /* Other output-token events do not alter ERC20 net transfers. */ }
    }
  }
  if (completed.length !== 1 || completed[0] !== netTransfers || netTransfers < BigInt(q.minimumOut)) return invalid();
  return netTransfers;
}


export const wrapAbi = parseAbi(["function deposit() payable", "event Deposit(address indexed dst,uint256 wad)"]);
export function wrappedEther(chainId: FirstBuyPaymentChain) {
  return getAddress(chainId === 4663 ? "0x0bd7d308f8e1639fab988df18a8011f41eacad73" : "0x4200000000000000000000000000000000000006");
}
/** Historical wrap quotes used 1 bps as metadata. A wrap still receives exactly
 * the input amount; refresh requests use the same supported API choices as UI. */
export function firstBuyPaymentRefreshInput(previous: FirstBuyPaymentQuote): FirstBuyPaymentQuoteInput {
  return { account: previous.account, fromToken: previous.fromToken.address, toToken: previous.toToken.address,
    amount: formatUnits(BigInt(previous.amountIn), previous.fromToken.decimals),
    slippageBps: previous.protocol === "wrap" ? 100 : previous.slippageBps };
}
export function createDirectWrapQuote(chainId: FirstBuyPaymentChain, account: Address, amountIn: bigint, code: Hex,
  block: { number: bigint; hash: Hex }, now = Date.now()): FirstBuyPaymentQuote {
  const address = wrappedEther(chainId), data = encodeFunctionData({ abi: wrapAbi, functionName: "deposit" });
  const q: FirstBuyPaymentQuote = { protocol: "wrap", id: `wrap-${now}`, transactionId: keccak256(data), integrator: "musegodfun", tool: "WETH",
    chainId, account, fromToken: { chainId, address: zeroAddress, symbol: "ETH", decimals: 18 }, toToken: firstBuyPairedAsset(chainId, address),
    amountIn: amountIn.toString(), expectedOut: amountIn.toString(), minimumOut: amountIn.toString(), slippageBps: 100,
    quotedAt: now, expiresAt: now + FIRST_BUY_PAYMENT_TTL, serverTime: now, router: address, facet: address, facetRuntimeHash: keccak256(code),
    blockNumber: block.number.toString(), blockHash: block.hash, transaction: { to: address, data, value: amountIn.toString() }, approval: null,
    feeAmount: "0", feeUsd: "0", gasFeeUsd: null, amountInUsd: null };
  assertFirstBuyPaymentQuote(q, now); return q;
}
