import { erc20Abi, formatUnits, getAddress, isAddress, keccak256, parseAbi, parseUnits, zeroAddress, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { ROBINHOOD_STOCKS, STOCKS, sameAddress, stockByAddress, type Stock } from "../src/lib/config";
import { FirstBuyPaymentReader, LifiNoRouteError } from "./lifi";
import { firstBuyPaymentAssets, wrappedEther, type FirstBuyPaymentAsset } from "../src/lib/first-buy-payment";
import { assertOpeningValuation, deriveLifiOpeningPrice, deriveBaseWethPrice, openingValuationWarnings, LAUNCH_PRICE_TTL, OPENING_CAP_USD, OPENING_POLICY, BASE_OPENING_POLICY, BASE_WETH_REFERENCE_AMOUNT,
  type LaunchWarning, type BaseOpeningQuote, type LifiOpeningQuote, type LifiOpeningValuation, type OpeningValuation } from "../src/lib/opening-valuation";
import type { StoreBackend } from "./supabase-store";
import buybackDeployment from "../contracts/artifacts/buyback-v2-deployment.json";

export type OpeningPriceDependencies = {
  integrator?: string; apiKey?: string; fetch?: typeof fetch; now?: () => number;
  rpcChainId?: 8453 | 4663 | 31337;
  budget?: Pick<StoreBackend, "reserveBudget" | "blockBudget">;
};
export const LIFI_OPENING_PROBE_ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
// Only the WETH/USDC reference is shared. Per-asset buy/sell probes always run
// again. Scope by budget, transport, integrator and credential without exposing
// any of those values in the public evidence.
const defaultReferenceScope = {};
type ReferenceEntry = { quotedAt: number; expiresAt: number; value: Promise<BaseOpeningQuote> };
const baseReferences = new WeakMap<object, WeakMap<typeof fetch, Map<string, ReferenceEntry>>>();
function referenceCache(deps: OpeningPriceDependencies, integrator: string) {
  const scope = deps.budget ?? defaultReferenceScope, transport = deps.fetch ?? fetch;
  let transports = baseReferences.get(scope);
  if (!transports) { transports = new WeakMap(); baseReferences.set(scope, transports); }
  let entries = transports.get(transport);
  if (!entries) { entries = new Map(); transports.set(transport, entries); }
  const key = JSON.stringify([integrator, deps.apiKey ?? ""]);
  return { entries, key };
}
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
  "function weth() view returns (address)", "function musegod() view returns (address)", "function museWethPool() view returns (address)",
  "function ethUsdFeed() view returns (address)", "function ethMaxAge() view returns (uint32)", "function ethFeedDecimals() view returns (uint8)",
  "function quoteWethToMuse(uint256 amount) view returns (uint256)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)", "function oraclePaused() view returns (bool)",
]);
/** Stock feeds stop while the market is closed: compare with the last close for up to four days. */
export const MARKET_CLOSED_MAX_AGE = 4 * 86_400;
const newYork = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });
/** Whether Robinhood's stock feeds trade at this instant: 24/5, Sunday 20:00 to Friday 20:00 New York time. US market holidays are not
 * modelled, so a holiday that stops a feed for longer than its maxAge still warns. */
export function stockFeedMarketOpen(seconds: number): boolean {
  const parts = newYork.formatToParts(new Date(seconds * 1000));
  const weekday = parts.find((part) => part.type === "weekday")!.value, hour = Number(parts.find((part) => part.type === "hour")!.value);
  return !(weekday === "Sat" || (weekday === "Fri" && hour >= 20) || (weekday === "Sun" && hour < 20));
}
/** Seconds of open market in (from, to]. Sessions change on whole New York hours, which are whole UTC hours. */
export function stockFeedOpenSeconds(from: number, to: number): number {
  let open = 0;
  for (let start = from; start < to;) {
    const end = Math.min(to, (Math.floor(start / 3_600) + 1) * 3_600);
    if (stockFeedMarketOpen(start)) open += end - start;
    start = end;
  }
  return open;
}
/** Other feeds update on a heartbeat equal to their maxAge; allow one late update. */
export const FEED_HEARTBEAT_GRACE = 3_600;
const REFERENCE_TIMEOUT = 3_000;
type IndependentReference = Pick<LifiOpeningValuation, "reference" | "warnings">;
/** The two reads the reference needs, at one block (a viem PublicClient, or a test double). */
type ReferenceClient = { getCode(parameters: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>; readContract(parameters: never): Promise<unknown> };
/** Advisory only. The deployed immutable oracle pins official feed mappings, its ETH/USD feed and its MUSEGOD/WETH TWAP; WETH and
 * MUSEGOD are priced from those, since `assetFeeds` maps neither. RH feeds already incorporate uiMultiplier; never multiply their
 * price again. An asset the oracle has no source for gets no reference and no warning (the LI.FI spread check still applies); a source
 * that exists but cannot be read fresh is reported as unavailable. */
export async function independentReference(client: ReferenceClient, stock: Stock,
  blockNumber: bigint, midpoint: string, now: number,
  oracle: { address: string; runtimeHash: string } = buybackDeployment.contracts.oracle): Promise<IndependentReference> {
  const none: IndependentReference = {};
  const unavailable: IndependentReference = { warnings: [{ code: "reference_price_unavailable",
    message: "An independent fresh price reference is unavailable. Review the opening price and minimum received before continuing." }] };
  if (stock.chainId !== 4663) return none;
  const nowSeconds = BigInt(Math.floor(now / 1000));
  const read = <T,>(address: Address, functionName: string, args?: readonly unknown[]) =>
    client.readContract({ address, abi: referenceAbi, functionName, ...(args ? { args } : {}), blockNumber } as never) as Promise<T>;
  /** A feed's USD price as a WAD and its update time, or null when it is invalid or older than `window` seconds. */
  const feedPrice = async (feed: Address, expectedDecimals: number, window: bigint) => {
    if (sameAddress(feed, zeroAddress) || expectedDecimals > 18) return null;
    const [[roundId, answer, , updatedAt, answeredInRound], decimals] = await Promise.all([
      read<readonly [bigint, bigint, bigint, bigint, bigint]>(feed, "latestRoundData"), read<number>(feed, "decimals")]);
    if (decimals !== expectedDecimals || answer <= 0n || updatedAt <= 0n || updatedAt > nowSeconds ||
      nowSeconds - updatedAt > window || answeredInRound < roundId) return null;
    return { wad: answer * 10n ** BigInt(18 - decimals), updatedAt, age: nowSeconds - updatedAt };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async (): Promise<IndependentReference> => {
      const address = oracle.address as Address;
      const [code, mapped, weth, musegod, pool, ethFeed, ethMaxAge, ethDecimals] = await Promise.all([
        client.getCode({ address, blockNumber }),
        read<readonly [Address, number, number, number, boolean]>(address, "assetFeeds", [stock.address]),
        read<Address>(address, "weth"), read<Address>(address, "musegod"), read<Address>(address, "museWethPool"),
        read<Address>(address, "ethUsdFeed"), read<number>(address, "ethMaxAge"), read<number>(address, "ethFeedDecimals"),
      ]);
      if (!code || keccak256(code) !== oracle.runtimeHash) return unavailable;
      const ethWindow = BigInt(ethMaxAge) + BigInt(FEED_HEARTBEAT_GRACE);
      let reference: { source: "Chainlink" | "TWAP"; feed: Address; wad: bigint; updatedAt: bigint; marketClosed?: true };
      if (sameAddress(stock.address, weth)) {
        const eth = await feedPrice(ethFeed, ethDecimals, ethWindow);
        if (!eth) return unavailable;
        reference = { source: "Chainlink", feed: ethFeed, wad: eth.wad, updatedAt: eth.updatedAt };
      } else if (sameAddress(stock.address, musegod)) {
        // MUSEGOD units per WETH over the pool's last 30 minutes, then ETH/USD: USD per whole MUSEGOD.
        const [eth, musePerWeth] = await Promise.all([feedPrice(ethFeed, ethDecimals, ethWindow), read<bigint>(address, "quoteWethToMuse", [10n ** 18n])]);
        if (!eth || musePerWeth <= 0n) return unavailable;
        reference = { source: "TWAP", feed: pool, wad: eth.wad * 10n ** BigInt(stock.decimals) / musePerWeth, updatedAt: eth.updatedAt };
      } else {
        const [feed, maxAge, tokenDecimals, feedDecimals, checkPaused] = mapped;
        if (sameAddress(feed, zeroAddress)) return none;
        if (tokenDecimals !== stock.decimals || maxAge <= 0) return unavailable;
        // Feeds that check the token's oraclePaused are stock feeds, which stop updating while the market is closed. One older than its
        // maxAge is still the last close when the market was open for at most maxAge since its update; otherwise the feed has failed.
        const window = checkPaused ? BigInt(Math.max(maxAge, MARKET_CLOSED_MAX_AGE)) : BigInt(maxAge) + BigInt(FEED_HEARTBEAT_GRACE);
        const [price, paused] = await Promise.all([feedPrice(feed, feedDecimals, window),
          checkPaused ? read<boolean>(stock.address, "oraclePaused") : Promise.resolve(false)]);
        if (paused || !price) return unavailable;
        const closed = checkPaused && price.age > BigInt(maxAge);
        if (closed && stockFeedOpenSeconds(Number(price.updatedAt), Number(nowSeconds)) > maxAge) return unavailable;
        reference = { source: "Chainlink", feed, wad: price.wad, updatedAt: price.updatedAt, ...(closed ? { marketClosed: true as const } : {}) };
      }
      if (reference.wad <= 0n) return unavailable;
      const midWad = parseUnits(midpoint, 18);
      const difference = midWad > reference.wad ? midWad - reference.wad : reference.wad - midWad;
      const divergenceBps = Number((difference * 10_000n + reference.wad - 1n) / reference.wad);
      const label = reference.marketClosed ? "the last market-close reference" : "its independent reference";
      return { reference: { source: reference.source, feed: reference.feed, priceUsd: formatUnits(reference.wad, 18),
          updatedAt: Number(reference.updatedAt) * 1000, divergenceBps, ...(reference.marketClosed ? { marketClosed: true as const } : {}) },
        warnings: divergenceBps > 500 ? [{ code: "reference_price_divergence", divergenceBps,
          message: `The opening price differs from ${label} by ${(divergenceBps / 100).toFixed(2)}%. Review this difference before continuing.` }] : [] };
    })(), new Promise<IndependentReference>((resolve) => { timer = setTimeout(() => resolve(unavailable), REFERENCE_TIMEOUT); })]);
  } catch { return unavailable; }
  finally { clearTimeout(timer); }
}

/** Chain evidence contradicts a recovered preview. Retrying cannot change
 * the verdict once block `finalAt` is finalized, or at all when it is unset. */
export class RecoveryEvidenceError extends Error {
  constructor(message: string, readonly finalAt?: bigint) { super(message); }
}
/** A recovered preview's price snapshot is unsigned caller JSON. Bind it to a
 * canonical block no later than the creation receipt, and return the
 * divergence from the independent reference at that block (`independentReference`,
 * with the block's timestamp as the time), if the asset has one. The comparison is
 * advisory: an unsigned valuation's provenance comes from the platform
 * attestation, not from a price bound. */
export async function assertRecoveredOpeningValuation(client: Pick<PublicClient<Transport, any>, "getBlock" | "getCode" | "readContract">,
  valuation: OpeningValuation, receiptBlock: bigint, chainId: 8453 | 4663): Promise<{ divergenceBps: number } | null> {
  const blockNumber = BigInt(valuation.blockNumber);
  if (blockNumber > receiptBlock) throw new RecoveryEvidenceError("The recovered opening valuation is newer than its creation receipt.");
  const block = await client.getBlock({ blockNumber });
  if (!block.hash || block.hash.toLowerCase() !== valuation.blockHash.toLowerCase())
    throw new RecoveryEvidenceError("The recovered opening valuation is not anchored to a canonical block.", blockNumber);
  const checked = await independentReference(client, stockByAddress(valuation.quoteAddress, chainId),
    blockNumber, valuation.quotePriceUsd, Number(block.timestamp) * 1000);
  return checked.reference ? { divergenceBps: checked.reference.divergenceBps } : null;
}

/** Unsigned executable probes provide a LI.FI USD reference midpoint. Base
 * exits into WETH and translates it through an independently refreshed
 * WETH/USDC quote. The RPC block proves identity, not quote execution. */
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
  const sellNumeraire: FirstBuyPaymentAsset = chainId === 8453
    ? { chainId, address: wrappedEther(chainId), symbol: "WETH", decimals: 18 } : numeraire;
  await Promise.all([identity(quoteToken), identity(numeraire), ...(chainId === 8453 ? [identity(sellNumeraire)] : [])]);
  let probeAmount = BigInt(chainId === 8453 ? 10 : 100) * 10n ** BigInt(numeraire.decimals);
  let sizingPrice: string | undefined;
  if (numeraire.address === zeroAddress) {
    const raw = token(await http.pricingRequest("token", new URLSearchParams({ chain: String(chainId), token: zeroAddress })), numeraire);
    sizingPrice = price(raw.priceUSD);
    probeAmount = 100n * 10n ** 36n / parseUnits(sizingPrice, 18);
    if (probeAmount <= 0n || probeAmount > UINT256_MAX) return invalidQuote();
  }
  const probe = async (from: FirstBuyPaymentAsset, to: FirstBuyPaymentAsset, input: bigint,
    reference: FirstBuyPaymentAsset | string = numeraire): Promise<LifiOpeningQuote> => {
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
      quotedAt, obtainedAt, expiresAt, numerairePriceUsd: typeof reference === "string" ? reference
        : price(sameAddress(from.address, reference.address) ? fromToken.priceUSD : toToken.priceUSD) };
  };
  const withAssets = (quote: LifiOpeningQuote, fromToken: FirstBuyPaymentAsset, toToken: FirstBuyPaymentAsset): BaseOpeningQuote =>
    ({ ...quote, fromToken: { ...fromToken }, toToken: { ...toToken } });
  let wethUsdReference: BaseOpeningQuote | undefined, wethPrice: string | undefined;
  const readWethReference = async () => {
    const { entries, key } = referenceCache(deps, http.integrator), requestedAt = now();
    let cached = entries.get(key);
    // Leave time for the remaining probes and final identity read. A shared
    // reference near expiry must not create a recurring failed preview window.
    if (!cached || requestedAt < cached.quotedAt || requestedAt + RPC_TIMEOUT >= cached.expiresAt) {
      const value = probe(sellNumeraire, numeraire, BigInt(BASE_WETH_REFERENCE_AMOUNT), numeraire)
        .then((quote) => withAssets(quote, sellNumeraire, numeraire));
      cached = { quotedAt: requestedAt, expiresAt: requestedAt + LAUNCH_PRICE_TTL, value };
      if (entries.size >= 128) entries.delete(entries.keys().next().value!);
      entries.set(key, cached);
    }
    try { wethUsdReference = structuredClone(await cached.value); }
    catch (error) { if (entries.get(key) === cached) entries.delete(key); throw error; }
    if (now() >= wethUsdReference.expiresAt) throw new Error("The LI.FI WETH/USD reference expired. Run a new simulation.");
    wethPrice = deriveBaseWethPrice(wethUsdReference);
  };
  if (chainId === 8453) await readWethReference();
  const readPair = async () => {
    const buy = await probe(numeraire, quoteToken, probeAmount);
    const sell = await probe(quoteToken, sellNumeraire, amount(buy.amountOut), wethPrice ?? numeraire);
    return { buy, sell };
  };
  let pair: Awaited<ReturnType<typeof readPair>>, fallback = false;
  try { pair = await readPair(); }
  catch (error) {
    // Only a classified route absence can justify a larger amount. Capacity,
    // auth, invalid quotes and upstream failures must never fan out retries.
    if (chainId !== 8453 || !(error instanceof LifiNoRouteError)) throw error;
    probeAmount = 100n * 10n ** BigInt(numeraire.decimals); fallback = true;
    pair = await readPair();
  }
  const { buy, sell } = pair;
  if (chainId === 8453) {
    // Slow pair probes can outlive the cached reference. Renew only that leg;
    // preserve each pair's original quantities, timestamps and expiry.
    await readWethReference();
    sell.numerairePriceUsd = wethPrice!;
  }
  const quotes = [buy, sell, ...(wethUsdReference ? [wethUsdReference] : [])];
  const quotedAt = Math.min(...quotes.map((quote) => quote.quotedAt)), expiresAt = Math.min(...quotes.map((quote) => quote.expiresAt));
  if (now() >= expiresAt || quotes.some((quote) => quote.obtainedAt >= expiresAt))
    throw new Error("The LI.FI opening-price snapshot expired during retrieval.");
  const derived = deriveLifiOpeningPrice({ quoteDecimals: asset.decimals, numeraireDecimals: numeraire.decimals,
    sellNumeraireDecimals: sellNumeraire.decimals, numerairePriceUsd: buy.numerairePriceUsd, sellNumerairePriceUsd: sell.numerairePriceUsd,
    buyAmountIn: buy.amountIn, buyAmountOut: buy.amountOut, buyLifiFee: buy.lifiFee,
    sellAmountIn: sell.amountIn, sellAmountOut: sell.amountOut, sellLifiFee: sell.lifiFee });
  const canonical = await identityRead(() => client.getBlock({ blockNumber: block.number! }));
  if (canonical.hash !== block.hash) throw new Error("The opening-price identity block changed during retrieval.");
  const snapshot: LifiOpeningValuation = { policy: chainId === 8453 ? BASE_OPENING_POLICY : OPENING_POLICY, marketCapUsd: OPENING_CAP_USD, chainId, quoteAddress: asset.address,
    quotePriceUsd: derived.aggregateMid, quotedAt, expiresAt, source: "LI.FI", sourceUpdatedAt: quotedAt,
    blockNumber: block.number.toString(), blockHash: block.hash,
    lifi: { numeraire: { ...numeraire, priceUsd: buy.numerairePriceUsd }, probeAmountIn: probeAmount.toString(), buy, sell, ...derived,
      ...(sizingPrice ? { probeUsd: "100", probeSizingPriceUsd: sizingPrice } : {}),
      ...(wethUsdReference ? { evidenceVersion: 2, probeUnits: fallback ? "100" : "10",
        ...(fallback ? { fallbackReason: "no_route" } : {}),
        buy: withAssets(buy, numeraire, quoteToken), sell: withAssets(sell, quoteToken, sellNumeraire),
        sellNumeraire: { ...sellNumeraire, priceUsd: wethPrice! }, wethUsdReference } : {}) } };
  assertOpeningValuation(snapshot, asset.address, chainId, now());
  const reference = await independentReference(client, stock, block.number, snapshot.quotePriceUsd, now());
  snapshot.reference = reference.reference;
  snapshot.warnings = [...warnings, ...openingValuationWarnings(snapshot), ...(reference.warnings ?? [])];
  return snapshot;
}
