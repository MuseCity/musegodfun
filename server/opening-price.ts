import { getSqrtRatioAtTick } from "@whetstone-research/doppler-sdk/evm";
import { erc20Abi, formatUnits, parseAbi, type Address, type PublicClient, type Transport } from "viem";
import { ROBINHOOD_STOCKS, sameAddress, type Stock } from "../src/lib/config";
import {
  LAUNCH_PRICE_TTL,
  OPENING_CAP_USD,
  OPENING_POLICY,
  type OpeningValuation,
} from "../src/lib/opening-valuation";

const ETH_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as Address;
const USDG_FEED = "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2" as Address;
const CBBTC_FEED = "0x0009cD492adf8167f9eEBf1293556A673530a21a" as Address;
const MUSEGOD = "0x0379E228F6887c6F18bf394042ECAF81B308cb2e" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const MUSEGOD_POOL = "0x071eE139277688d64B139Af1e44f79a9acf12e53" as Address;
const SUSHI_FACTORY = "0xE51960f1B45f1C9FB6D166E6a884F866fC70433B" as Address;
const SOURCE_MAX_AGE = 60_000;
const FEED_HEARTBEAT = 86_400_000;
const TWAP_SECONDS = 300 as const;
const WAD = 10n ** 18n;
const Q192 = 1n << 192n;

const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
]);
const stockAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function oraclePaused() view returns (bool)",
]);
const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
]);
const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);

type Dependencies = { fetch?: typeof fetch; now?: () => number };
type Decimal = { value: bigint; scale: bigint };
function decimal(value: unknown): Decimal {
  if (typeof value !== "string" || value.length > 160 || !/^\d+(?:\.\d+)?$/.test(value))
    throw new Error("The opening price provider returned an invalid decimal value.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 80)
    throw new Error("The opening price provider returned unsupported precision.");
  const result = { value: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) };
  if (result.value <= 0n) throw new Error("The paired asset USD price must be positive.");
  return result;
}
function priceString(numerator: bigint, denominator: bigint): string {
  if (numerator <= 0n || denominator <= 0n)
    throw new Error("The paired asset USD price must be positive.");
  const amount = numerator * WAD / denominator;
  if (amount <= 0n) throw new Error("The paired asset USD price is below supported precision.");
  return formatUnits(amount, 18);
}
function timestamp(seconds: bigint): number {
  const ms = seconds * 1000n;
  if (ms <= 0n || ms > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The opening price source timestamp is invalid.");
  return Number(ms);
}
function recent(at: number, now: number, age: number, message: string) {
  if (!Number.isSafeInteger(at) || at <= 0 || at > now || now - at > age)
    throw new Error(message);
}
// Never propagate upstream exceptions: RPC URLs can contain provider credentials.
async function bounded<T>(work: () => Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000);
      }),
    ]);
  } catch {
    throw new Error(message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Capture one USD reference valuation for the existing five-minute launch preview. */
export async function readOpeningValuation(
  client: PublicClient<Transport, any>,
  stock: Stock,
  chainId: 8453 | 4663,
  deps: Dependencies = {},
): Promise<OpeningValuation> {
  if (chainId !== 4663 || stock.chainId !== 4663)
    throw new Error("Fixed USD opening prices are only configured for Robinhood Chain.");
  const asset = ROBINHOOD_STOCKS.find((item) => sameAddress(item.address, stock.address));
  if (!asset || asset.symbol !== stock.symbol || asset.decimals !== stock.decimals)
    throw new Error("The paired asset does not match the verified Robinhood asset list.");
  const now = deps.now ?? Date.now;
  const block = await bounded(() => client.getBlock({ blockTag: "latest" }),
    "The opening price block is unavailable. Try preparing the launch again.");
  if (block.number === null || block.hash === null)
    throw new Error("The opening price block is incomplete.");
  const blockTime = timestamp(block.timestamp);
  recent(blockTime, now(), SOURCE_MAX_AGE, "The opening price block is stale. Try preparing the launch again.");
  const read = <T>(work: () => Promise<T>) => bounded(work,
    "The paired asset opening price could not be verified onchain. Try preparing the launch again.");
  const identity = async (address: Address, symbol: string, decimals: number) => {
    const [actualSymbol, actualDecimals] = await Promise.all([
      read(() => client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber: block.number! })),
      read(() => client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber: block.number! })),
    ]);
    if (actualSymbol !== symbol || actualDecimals !== decimals)
      throw new Error("The paired asset contract identity does not match the verified asset.");
  };
  const feedPrice = async (feed: Address) => {
    const [round, decimals] = await Promise.all([
      read(() => client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData", blockNumber: block.number! })),
      read(() => client.readContract({ address: feed, abi: feedAbi, functionName: "decimals", blockNumber: block.number! })),
    ]);
    if (round[0] <= 0n || round[1] <= 0n || round[4] < round[0] || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
      throw new Error("The Chainlink opening price is invalid or incomplete.");
    const updatedAt = timestamp(round[3]);
    recent(updatedAt, blockTime, FEED_HEARTBEAT, "The Chainlink opening price is stale. Try preparing the launch again.");
    return { numerator: round[1], denominator: 10n ** BigInt(decimals), updatedAt };
  };
  await identity(asset.address, asset.symbol, asset.decimals);
  let details: Pick<OpeningValuation, "quotePriceUsd" | "source" | "sourceUpdatedAt" | "feed" | "pool" | "twapSeconds">;
  const cryptoFeed = asset.symbol === "WETH" ? ETH_FEED : asset.symbol === "USDG" ? USDG_FEED
    : asset.symbol === "cbBTC" ? CBBTC_FEED : undefined;
  if (cryptoFeed) {
    const price = await feedPrice(cryptoFeed);
    details = { quotePriceUsd: priceString(price.numerator, price.denominator), source: "Chainlink",
      sourceUpdatedAt: price.updatedAt, feed: cryptoFeed };
  } else if (sameAddress(asset.address, MUSEGOD)) {
    const [token0, token1, factory, fee, liquidity, slot0, observations, ethPrice] = await Promise.all([
      read(() => client.readContract({ address: MUSEGOD_POOL, abi: poolAbi, functionName: "token0", blockNumber: block.number! })),
      read(() => client.readContract({ address: MUSEGOD_POOL, abi: poolAbi, functionName: "token1", blockNumber: block.number! })),
      read(() => client.readContract({ address: MUSEGOD_POOL, abi: poolAbi, functionName: "factory", blockNumber: block.number! })),
      read(() => client.readContract({ address: MUSEGOD_POOL, abi: poolAbi, functionName: "fee", blockNumber: block.number! })),
      read(() => client.readContract({ address: MUSEGOD_POOL, abi: poolAbi, functionName: "liquidity", blockNumber: block.number! })),
      read(() => client.readContract({ address: MUSEGOD_POOL, abi: poolAbi, functionName: "slot0", blockNumber: block.number! })),
      read(() => client.readContract({ address: MUSEGOD_POOL, abi: poolAbi, functionName: "observe", args: [[TWAP_SECONDS, 0]], blockNumber: block.number! })),
      feedPrice(ETH_FEED), identity(WETH, "WETH", 18),
    ]);
    if (!sameAddress(token0, MUSEGOD) || !sameAddress(token1, WETH) || !sameAddress(factory, SUSHI_FACTORY) || fee !== 10_000)
      throw new Error("The MUSEGOD price pool identity does not match the verified SushiSwap pool.");
    if (liquidity <= 0n || slot0[0] <= 0n || !slot0[6])
      throw new Error("The MUSEGOD price pool has no usable liquidity.");
    const canonical = await read(() => client.readContract({ address: SUSHI_FACTORY, abi: factoryAbi,
      functionName: "getPool", args: [MUSEGOD, WETH, 10_000], blockNumber: block.number! }));
    if (!sameAddress(canonical, MUSEGOD_POOL))
      throw new Error("The MUSEGOD price pool could not be confirmed by its factory.");
    if (observations[0].length !== 2 || observations[1].length !== 2 || observations[1][1] <= observations[1][0])
      throw new Error("The MUSEGOD pool does not have a complete five-minute price observation.");
    const delta = observations[0][1] - observations[0][0];
    const seconds = BigInt(TWAP_SECONDS);
    // Solidity division truncates toward zero; Uniswap mean ticks round down.
    const meanTick = delta / seconds - (delta < 0n && delta % seconds !== 0n ? 1n : 0n);
    if (meanTick < -887272n || meanTick > 887272n)
      throw new Error("The MUSEGOD pool returned an invalid average price tick.");
    const sqrtRatio = getSqrtRatioAtTick(Number(meanTick));
    details = { quotePriceUsd: priceString(sqrtRatio * sqrtRatio * ethPrice.numerator, Q192 * ethPrice.denominator),
      source: "SushiSwap V3 TWAP", sourceUpdatedAt: ethPrice.updatedAt, feed: ETH_FEED,
      pool: MUSEGOD_POOL, twapSeconds: TWAP_SECONDS };
  } else {
    const get = async (url: string): Promise<unknown> => {
      try {
        const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
        if (!response.ok) throw new Error();
        return await response.json();
      } catch {
        throw new Error("The Robinhood opening price is unavailable. Try preparing the launch again.");
      }
    };
    const [rawQuotes, rawRegistry, multiplier, paused] = await Promise.all([
      get(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(asset.symbol)}`),
      get("https://api.robinhood.com/rhj/assets/"),
      read(() => client.readContract({ address: asset.address, abi: stockAbi, functionName: "uiMultiplier", blockNumber: block.number! })),
      read(() => client.readContract({ address: asset.address, abi: stockAbi, functionName: "oraclePaused", blockNumber: block.number! })),
    ]);
    if (paused !== false || multiplier <= 0n)
      throw new Error("The Robinhood paired asset oracle is paused or its multiplier is unavailable.");
    const quoteRows = (rawQuotes as { quotes?: unknown[] } | null)?.quotes;
    const assetRows = (rawRegistry as { assets?: unknown[] } | null)?.assets;
    type Row = { tokenSymbol?: string; deployments?: { chainId?: number; contractAddress?: string }[];
      currency?: string; bid?: string; ask?: string; generatedAt?: string; isTradingHalt?: boolean;
      currentMultiplier?: string; status?: string };
    const matches = (row: Row) => row.tokenSymbol === asset.symbol && Array.isArray(row.deployments)
      && row.deployments.some((deployment) => deployment !== null && typeof deployment === "object" && deployment.chainId === chainId
        && typeof deployment.contractAddress === "string" && sameAddress(deployment.contractAddress, asset.address));
    const quotes = Array.isArray(quoteRows) ? quoteRows.filter((row) => row !== null && typeof row === "object" && matches(row as Row)) as Row[] : [];
    const registry = Array.isArray(assetRows) ? assetRows.filter((row) => row !== null && typeof row === "object" && matches(row as Row)) as Row[] : [];
    if (quotes.length !== 1 || registry.length !== 1 || quotes[0].currency !== "USD" || quotes[0].isTradingHalt !== false
      || registry[0].status !== "ASSET_STATUS_ACTIVE")
      throw new Error("The Robinhood opening price does not match an active verified paired asset.");
    const quote = quotes[0];
    const updatedAt = typeof quote.generatedAt === "string" ? Date.parse(quote.generatedAt) : NaN;
    recent(updatedAt, now(), SOURCE_MAX_AGE, "The Robinhood opening price is stale. Try preparing the launch again.");
    const registryMultiplier = decimal(registry[0].currentMultiplier);
    if (registryMultiplier.value * WAD !== multiplier * registryMultiplier.scale)
      throw new Error("The Robinhood asset multiplier changed. Try preparing the launch again.");
    const bid = decimal(quote.bid), ask = decimal(quote.ask);
    if (bid.value * ask.scale > ask.value * bid.scale)
      throw new Error("The Robinhood opening price bid and ask are invalid.");
    details = { quotePriceUsd: priceString((bid.value * ask.scale + ask.value * bid.scale) * multiplier,
      2n * bid.scale * ask.scale * WAD), source: "Robinhood", sourceUpdatedAt: updatedAt };
  }
  const confirmedBlock = await bounded(() => client.getBlock({ blockNumber: block.number! }),
    "The opening price block could not be confirmed. Try preparing the launch again.");
  if (confirmedBlock.number !== block.number || confirmedBlock.hash?.toLowerCase() !== block.hash.toLowerCase())
    throw new Error("The opening price block changed. Try preparing the launch again.");
  const quotedAt = now();
  recent(blockTime, quotedAt, SOURCE_MAX_AGE, "The opening price block is stale. Try preparing the launch again.");
  recent(details.sourceUpdatedAt, quotedAt, details.source === "Robinhood" ? SOURCE_MAX_AGE : FEED_HEARTBEAT,
    "The paired asset USD price is stale. Try preparing the launch again.");
  return { policy: OPENING_POLICY, marketCapUsd: OPENING_CAP_USD, chainId, quoteAddress: asset.address,
    quotedAt, expiresAt: quotedAt + LAUNCH_PRICE_TTL, blockNumber: block.number.toString(), blockHash: block.hash, ...details };
}
