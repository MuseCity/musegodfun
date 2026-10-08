import { erc20Abi, formatUnits, getAddress, isAddress, keccak256, parseAbi, parseUnits, zeroAddress, type Address, type PublicClient, type Transport } from "viem";
import { ROBINHOOD_STOCKS, STOCKS, sameAddress, stockByAddress, type Stock } from "../src/lib/config";
import { FirstBuyPaymentReader } from "./lifi";
import { firstBuyPaymentAssets, type FirstBuyPaymentAsset } from "../src/lib/first-buy-payment";
import { assertOpeningValuation, deriveLifiOpeningPrice, openingValuationWarnings, LAUNCH_PRICE_TTL, OPENING_CAP_USD, OPENING_POLICY,
  type LaunchWarning, type LifiOpeningQuote, type LifiOpeningValuation, type OpeningValuation } from "../src/lib/opening-valuation";
import type { StoreBackend } from "./supabase-store";
import buybackDeployment from "../contracts/artifacts/buyback-v2-deployment.json";

export type OpeningPriceDependencies = {
  integrator?: string; apiKey?: string; fetch?: typeof fetch; now?: () => number;
  rpcChainId?: 8453 | 4663 | 31337;
  budget?: Pick<StoreBackend, "reserveBudget" | "blockBudget">;
};
export const LIFI_OPENING_PROBE_ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const SLIPPAGE = 0.01;
const UINT256_MAX = (1n << 256n) - 1n;
const RPC_TIMEOUT = 15_000;
const PRICE = /^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/;
function invalidQuote(): never { throw new Error("The LI.FI opening quote does not match the fixed same-chain price probe."); }
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidQuote();
  return value as Record<string, any>;
}
function amount(value: unknown, allowZero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value)) return invalidQuote();
  const result = BigInt(value);
  if ((!allowZero && result === 0n) || result > UINT256_MAX) return invalidQuote();
  return result;
}
function price(value: unknown): string {
  if (typeof value !== "string" || !PRICE.test(value) || parseUnits(value, 18) <= 0n) return invalidQuote();
  return formatUnits(parseUnits(value, 18), 18);
}
function token(value: unknown, expected: FirstBuyPaymentAsset) {
  const actual = record(value);
  if (actual.chainId !== expected.chainId || !isAddress(actual.address ?? "", { strict: false }) ||
    !sameAddress(actual.address, expected.address) || actual.symbol !== expected.symbol || actual.decimals !== expected.decimals)
    return invalidQuote();
  return actual;
}
function intermediateToken(value: unknown, chainId: 8453 | 4663) {
  const actual = record(value);
  if (actual.chainId !== chainId || !isAddress(actual.address ?? "", { strict: false }) ||
    typeof actual.symbol !== "string" || !actual.symbol || actual.symbol.length > 64 ||
    !Number.isInteger(actual.decimals) || actual.decimals < 0 || actual.decimals > 36) return invalidQuote();
}
// RPC exceptions can contain credential-bearing URLs. Preserve only a fixed
// identity failure, as with the shared LI.FI HTTP boundary.
async function identityRead<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("identity timeout")), RPC_TIMEOUT);
    })]);
  } catch { throw new Error("The opening-price asset identity could not be verified on the selected RPC."); }
  finally { clearTimeout(timer); }
}


const referenceAbi = parseAbi([
  "function assetFeeds(address asset) view returns (address feed,uint32 maxAge,uint8 tokenDecimals,uint8 feedDecimals,bool checkOraclePaused)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)", "function oraclePaused() view returns (bool)",
]);
/** Advisory only. The deployed immutable oracle pins official feed mappings.
 * RH feeds already incorporate uiMultiplier; never multiply their price again. */
async function independentReference(client: PublicClient<Transport, any>, stock: Stock, blockNumber: bigint,
  midpoint: string, now: number): Promise<Pick<LifiOpeningValuation, "reference" | "warnings">> {
  const unavailable = { warnings: [{ code: "reference_price_unavailable" as const,
    message: "An independent fresh price reference is unavailable. Review the opening price and minimum received before continuing." }] };
  if (stock.chainId !== 4663) return unavailable;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      const oracle = buybackDeployment.contracts.oracle;
      const [code, config] = await Promise.all([
        client.getCode({ address: oracle.address as Address, blockNumber }),
        client.readContract({ address: oracle.address as Address, abi: referenceAbi, functionName: "assetFeeds", args: [stock.address], blockNumber }),
      ]);
      if (!code || keccak256(code) !== oracle.runtimeHash) return unavailable;
      const [feed, maxAge, tokenDecimals, feedDecimals, checkPaused] = config;
      if (sameAddress(feed, zeroAddress) || tokenDecimals !== stock.decimals || maxAge <= 0 || feedDecimals > 18) return unavailable;
      const [round, decimals, paused] = await Promise.all([
        client.readContract({ address: feed, abi: referenceAbi, functionName: "latestRoundData", blockNumber }),
        client.readContract({ address: feed, abi: referenceAbi, functionName: "decimals", blockNumber }),
        checkPaused ? client.readContract({ address: stock.address, abi: referenceAbi, functionName: "oraclePaused", blockNumber }) : Promise.resolve(false),
      ]);
      const [roundId, answer, , updatedAt, answeredInRound] = round, nowSeconds = BigInt(Math.floor(now / 1000));
      if (paused || decimals !== feedDecimals || answer <= 0n || updatedAt <= 0n || updatedAt > nowSeconds ||
        nowSeconds - updatedAt > BigInt(maxAge) || answeredInRound < roundId) return unavailable;
      const referenceWad = answer * 10n ** BigInt(18 - decimals), midWad = parseUnits(midpoint, 18);
      const difference = midWad > referenceWad ? midWad - referenceWad : referenceWad - midWad;
      const divergenceBps = Number((difference * 10_000n + referenceWad - 1n) / referenceWad);
      return { reference: { source: "Chainlink" as const, feed, priceUsd: formatUnits(referenceWad, 18), updatedAt: Number(updatedAt) * 1000, divergenceBps },
        warnings: divergenceBps > 500 ? [{ code: "reference_price_divergence" as const, divergenceBps,
          message: `The opening price differs from its independent reference by ${(divergenceBps / 100).toFixed(2)}%. Review this difference before continuing.` }] : [] };
    })(), new Promise<typeof unavailable>((resolve) => { timer = setTimeout(() => resolve(unavailable), 2_000); })]);
  } catch { return unavailable; }
  finally { clearTimeout(timer); }
}

/** A recovered preview's price snapshot is unsigned caller JSON. Bind it to a
 * canonical block no later than the creation receipt, and return the
 * divergence from the immutable oracle's independent feed at that block, if
 * one is mapped. The comparison is advisory: an unsigned valuation's
 * provenance comes from the platform attestation, not from a price bound. */
/** Chain evidence contradicts a recovered preview; retrying cannot change it. */
export class RecoveryEvidenceError extends Error {}
export async function assertRecoveredOpeningValuation(client: Pick<PublicClient<Transport, any>, "getBlock" | "getCode" | "readContract">,
  valuation: OpeningValuation, receiptBlock: bigint, chainId: 8453 | 4663): Promise<{ divergenceBps: number } | null> {
  const blockNumber = BigInt(valuation.blockNumber);
  if (blockNumber > receiptBlock) throw new RecoveryEvidenceError("The recovered opening valuation is newer than its creation receipt.");
  const block = await client.getBlock({ blockNumber });
  if (!block.hash || block.hash.toLowerCase() !== valuation.blockHash.toLowerCase())
    throw new RecoveryEvidenceError("The recovered opening valuation is not anchored to a canonical block.");
  const checked = await independentReference(client as PublicClient<Transport, any>, stockByAddress(valuation.quoteAddress, chainId),
    blockNumber, valuation.quotePriceUsd, Number(block.timestamp) * 1000);
  return checked.reference ? { divergenceBps: checked.reference.divergenceBps } : null;
}

/** Two unsigned probes provide a LI.FI USD reference midpoint. The recorded
 * canonical RPC block proves token identity; it is not a quote execution block. */
export async function readOpeningValuation(client: PublicClient<Transport, any>, stock: Stock,
  chainId: 8453 | 4663, deps: OpeningPriceDependencies = {}): Promise<LifiOpeningValuation> {
  const asset = (chainId === 4663 ? ROBINHOOD_STOCKS : STOCKS).find((item) => sameAddress(item.address, stock.address));
  if (![8453, 4663].includes(chainId) || stock.chainId !== chainId || !asset ||
    asset.symbol !== stock.symbol || asset.decimals !== stock.decimals) throw new Error("The opening-price asset does not match the selected issuer registry.");
  const rpcChainId = deps.rpcChainId ?? chainId;
  if (rpcChainId !== chainId && rpcChainId !== 31337) throw new Error("Invalid opening-price RPC network.");
  const [actualChain, block] = await Promise.all([
    identityRead(() => client.getChainId()), identityRead(() => client.getBlock({ blockTag: "latest" })),
  ]);
  if (actualChain !== rpcChainId || block.number === null || block.hash === null ||
    !/^0x[\da-fA-F]{64}$/.test(block.hash)) throw new Error("The opening-price identity RPC does not match the selected network.");
  const now = deps.now ?? Date.now;
  const protectedKey = deps.apiKey;
  const http = new FirstBuyPaymentReader({ client, chainId, ...deps, rpcChainId });
  const stable = firstBuyPaymentAssets(chainId).find((item) => item.symbol === (chainId === 8453 ? "USDC" : "USDG"))!;
  const numeraire = sameAddress(asset.address, stable.address)
    ? firstBuyPaymentAssets(chainId).find((item) => item.address === zeroAddress)! : stable;
  const quoteToken: FirstBuyPaymentAsset = { chainId, address: asset.address, symbol: asset.symbol, decimals: asset.decimals };
  const warnings: LaunchWarning[] = [];
  const identity = async (expected: FirstBuyPaymentAsset) => {
    if (expected.address === zeroAddress) return;
    const [symbol, decimals, code] = await Promise.allSettled([
      identityRead(() => client.readContract({ address: expected.address, abi: erc20Abi, functionName: "symbol", blockNumber: block.number! })),
      identityRead(() => client.readContract({ address: expected.address, abi: erc20Abi, functionName: "decimals", blockNumber: block.number! })),
      identityRead(() => client.getCode({ address: expected.address, blockNumber: block.number! })),
    ]);
    // Base B20 tokens legitimately have the native initialization marker 0xef.
    if ((symbol.status === "fulfilled" && symbol.value !== expected.symbol) ||
      (decimals.status === "fulfilled" && decimals.value !== expected.decimals) ||
      (code.status === "fulfilled" && (!code.value || code.value === "0x")))
      throw new Error("The opening-price token identity does not match its verified address and decimals.");
    if ([symbol, decimals, code].some((result) => result.status === "rejected"))
      warnings.push({ code: "asset_status_unavailable", message: `${expected.symbol} live identity reads are incomplete. Pricing uses its pinned address and decimals; review the final simulation.` });
  };
  await Promise.all([identity(quoteToken), identity(numeraire)]);
  let probeAmount = 100n * 10n ** BigInt(numeraire.decimals);
  let sizingPrice: string | undefined;
  if (numeraire.address === zeroAddress) {
    const raw = token(await http.pricingRequest("token", new URLSearchParams({ chain: String(chainId), token: zeroAddress })), numeraire);
    sizingPrice = price(raw.priceUSD);
    probeAmount = 100n * 10n ** 36n / parseUnits(sizingPrice, 18);
    if (probeAmount <= 0n || probeAmount > UINT256_MAX) return invalidQuote();
  }
  const probe = async (from: FirstBuyPaymentAsset, to: FirstBuyPaymentAsset, input: bigint): Promise<LifiOpeningQuote> => {
    const quotedAt = now();
    const params = new URLSearchParams({ fromChain: String(chainId), toChain: String(chainId),
      fromToken: from.address, toToken: to.address, fromAmount: input.toString(),
      fromAddress: LIFI_OPENING_PROBE_ACCOUNT, toAddress: LIFI_OPENING_PROBE_ACCOUNT,
      integrator: http.integrator, fee: "0", slippage: String(SLIPPAGE), skipSimulation: "false", allowBridges: "none" });
    const raw = record(await http.pricingRequest("quote", params)), action = record(raw.action), estimate = record(raw.estimate), transaction = record(raw.transactionRequest);
    const obtainedAt = now(), expiresAt = quotedAt + LAUNCH_PRICE_TTL;
    if (obtainedAt >= expiresAt || obtainedAt < quotedAt) throw new Error("The LI.FI opening-price probe expired during retrieval.");
    const fromToken = token(action.fromToken, from), toToken = token(action.toToken, to);
    if (action.fromChainId !== chainId || action.toChainId !== chainId ||
      !sameAddress(action.fromAddress ?? "", LIFI_OPENING_PROBE_ACCOUNT) || !sameAddress(action.toAddress ?? "", LIFI_OPENING_PROBE_ACCOUNT) ||
      action.fromAmount !== input.toString() || estimate.fromAmount !== input.toString() || action.slippage !== SLIPPAGE ||
      typeof raw.id !== "string" || !raw.id || raw.id.length > 160 || typeof raw.tool !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(raw.tool) ||
      (protectedKey !== undefined && protectedKey.length > 0 && [raw.id, raw.tool].some((field) => field.includes(protectedKey))) ||
      !Array.isArray(raw.includedSteps) || raw.includedSteps.length === 0 || raw.includedSteps.length > 12 ||
      !Array.isArray(estimate.feeCosts) || estimate.feeCosts.length > 1) return invalidQuote();
    if (transaction.chainId !== chainId || !isAddress(transaction.from ?? "", { strict: false }) ||
      !sameAddress(transaction.from, LIFI_OPENING_PROBE_ACCOUNT) || !isAddress(transaction.to ?? "", { strict: false }) ||
      sameAddress(transaction.to, zeroAddress) || typeof transaction.data !== "string" || !/^0x(?:[\da-fA-F]{2}){4,}$/.test(transaction.data) ||
      typeof transaction.value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(transaction.value) ||
      BigInt(transaction.value) !== (from.address === zeroAddress ? input : 0n)) return invalidQuote();
    for (const value of raw.includedSteps) {
      const step = record(value), stepAction = record(step.action);
      if (!["swap", "protocol"].includes(step.type) || stepAction.fromChainId !== chainId || stepAction.toChainId !== chainId) return invalidQuote();
      intermediateToken(stepAction.fromToken, chainId); intermediateToken(stepAction.toToken, chainId);
    }
    token(raw.includedSteps[0].action.fromToken, from);
    token(raw.includedSteps[raw.includedSteps.length - 1].action.toToken, to);
    const output = amount(estimate.toAmount), minimum = amount(estimate.toAmountMin);
    if (minimum > output || minimum < output * 9900n / 10000n) return invalidQuote();
    // Minimum output protects swaps; it is never the price numerator/denominator.
    let lifiFee = 0n;
    for (const value of estimate.feeCosts) {
      const fee = record(value), split = record(fee.feeSplit);
      token(fee.token, from);
      const cost = amount(fee.amount, true);
      if (fee.name !== "LIFI Fixed Fee" || fee.included !== true || split.integratorFee !== "0" ||
        amount(split.lifiFee, true) !== cost || lifiFee > 0n) return invalidQuote();
      lifiFee += cost;
    }
    if (lifiFee >= input) return invalidQuote();
    return { id: raw.id, tool: raw.tool, amountIn: input.toString(), amountOut: output.toString(), lifiFee: lifiFee.toString(),
      quotedAt, obtainedAt, expiresAt, numerairePriceUsd: price(sameAddress(from.address, numeraire.address) ? fromToken.priceUSD : toToken.priceUSD) };
  };
  const buy = await probe(numeraire, quoteToken, probeAmount);
  const sell = await probe(quoteToken, numeraire, amount(buy.amountOut));
  const quotedAt = Math.min(buy.quotedAt, sell.quotedAt), expiresAt = Math.min(buy.expiresAt, sell.expiresAt);
  if (now() >= expiresAt || sell.obtainedAt >= expiresAt) throw new Error("The LI.FI opening-price snapshot expired during its two probes.");
  const derived = deriveLifiOpeningPrice({ quoteDecimals: asset.decimals, numeraireDecimals: numeraire.decimals,
    numerairePriceUsd: buy.numerairePriceUsd, sellNumerairePriceUsd: sell.numerairePriceUsd,
    buyAmountIn: buy.amountIn, buyAmountOut: buy.amountOut, buyLifiFee: buy.lifiFee,
    sellAmountIn: sell.amountIn, sellAmountOut: sell.amountOut, sellLifiFee: sell.lifiFee });
  const canonical = await identityRead(() => client.getBlock({ blockNumber: block.number! }));
  if (canonical.hash !== block.hash) throw new Error("The opening-price identity block changed during retrieval.");
  const snapshot: LifiOpeningValuation = { policy: OPENING_POLICY, marketCapUsd: OPENING_CAP_USD, chainId, quoteAddress: asset.address,
    quotePriceUsd: derived.aggregateMid, quotedAt, expiresAt, source: "LI.FI", sourceUpdatedAt: quotedAt,
    blockNumber: block.number.toString(), blockHash: block.hash,
    lifi: { numeraire: { ...numeraire, priceUsd: buy.numerairePriceUsd }, probeAmountIn: probeAmount.toString(), buy, sell, ...derived,
      ...(sizingPrice ? { probeUsd: "100", probeSizingPriceUsd: sizingPrice } : {}) } };
  assertOpeningValuation(snapshot, asset.address, chainId, now());
  const reference = await independentReference(client, stock, block.number, snapshot.quotePriceUsd, now());
  snapshot.reference = reference.reference;
  snapshot.warnings = [...warnings, ...openingValuationWarnings(snapshot), ...(reference.warnings ?? [])];
  return snapshot;
}
