import { getAddress, type Address } from "viem";
import stockData from "./stocks.json";
import robinhoodData from "./robinhood-assets.json";
import type { FeePolicy } from "./fee-policy";
import type { OpeningValuation } from "./opening-valuation";

export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const WAD = 10n ** 18n;
export const COINBASE_STOCKS_SOURCE = "https://www.base.org/stocks";
export const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
// Official Doppler Deployments.json + docs, checked 2026-09-21.
export const CONTRACTS = {
  airlock: getAddress("0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12"),
  tokenFactory: getAddress("0x89c261c05b5f9b6bcba07c199b8dee7cfad45292"),
  tokenImplementation: getAddress("0xdb7b520bb5c3a2c5d4871198081911359f93be87"),
  initializer: getAddress("0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"),
  rehype: getAddress("0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215"),
  noOpGovernance: getAddress("0xe7dfbd5b0a2c3b4464653a9becdc489229ef090e"),
  noOpMigrator: getAddress("0x6ddfed58d238ca3195e49d8ac3d4cea6386e5c33"),
  poolManager: getAddress("0x498581ff718922c3f8e6a244956af099b2652b2b"),
  router: getAddress("0x6ff5693b99212da76ad316178a184ab56d299b43"),
  quoter: getAddress("0x0d5e0f971ed27fbff6c2837bf31316121532048d"),
  permit2: getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3"),
} as const;
// Canonical Doppler deployments verified on Robinhood Mainnet, 2026-10-04.
// SDK 1.0.43 has stale token factory/implementation and Rehype entries.
export const ROBINHOOD_CONTRACTS = {
  airlock: getAddress("0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862"),
  tokenFactory: getAddress("0x1b37d3a72082029c44b35b604ea473617580b69a"),
  tokenImplementation: getAddress("0x3be8b97fd0e713b5abe0649fa830223b6b4bc599"),
  initializer: getAddress("0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"),
  rehype: getAddress("0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215"),
  noOpGovernance: getAddress("0x85f37f74ef2478a770318bc810177a9835911ad7"),
  noOpMigrator: getAddress("0xba2f330edb16cd8056f5988d8ce19bbc63475a0e"),
  poolManager: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  router: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"),
  quoter: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
  permit2: CONTRACTS.permit2,
};
export const ROBINHOOD_BUNDLER = getAddress("0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c");
export const ROBINHOOD_BUNDLER_CODE_HASH = "0x8d7c135bd087b74d2f2d1362593f23b824d5752bebe6a3c8bc6db0a6fa75e066" as const;
export type ContractRegistry = typeof CONTRACTS;
export type Stock = {
  ticker: string;
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  chainId: 8453 | 4663;
  issuer: string;
  standard: "B20" | "ERC20";
  category?: string;
  sourceUrl: string;
};
export const STOCKS: Stock[] = stockData.map((s) => ({
  ...s,
  address: getAddress(s.address),
  chainId: 8453,
  issuer: "Coinbase",
  standard: "B20",
  sourceUrl: COINBASE_STOCKS_SOURCE,
}));
export const ROBINHOOD_STOCKS: Stock[] = robinhoodData.map((s) => ({
  ...s, address: getAddress(s.address), chainId: 4663,
  issuer: s.category === "OTHERS" ? "Token issuer" : "Robinhood",
  standard: "ERC20", sourceUrl: s.sourceUrl ?? "https://pair.fund/launch",
}));
export function deploymentChain(config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">): 8453 | 4663 {
  return config?.mode === "robinhood" || config?.deploymentChainId === 4663 ? 4663 : 8453;
}
export function assetsFor(config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">) {
  return deploymentChain(config) === 4663 ? ROBINHOOD_STOCKS : STOCKS;
}
export function contractsFor(config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">): ContractRegistry {
  return deploymentChain(config) === 4663 ? ROBINHOOD_CONTRACTS : CONTRACTS;
}
export function networkName(config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">) {
  const name = deploymentChain(config) === 4663 ? "Robinhood Chain" : "Base";
  return config?.mode === "fork" ? `${name} local fork` : name;
}
export function explorerFor(config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">) {
  return config?.mode === "fork" ? undefined : deploymentChain(config) === 4663
    ? "https://robinhoodchain.blockscout.com" : "https://basescan.org";
}
export function stockByAddress(address: string): Stock {
  const stock = [...STOCKS, ...ROBINHOOD_STOCKS].find(
    (s) => s.address.toLowerCase() === address.toLowerCase(),
  );
  if (!stock) throw new Error("Unsupported paired asset. Select an asset from the verified list.");
  return stock;
}
export const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export type RuntimeConfig = {
  chainId: number;
  mode: "base" | "robinhood" | "fork";
  deploymentChainId?: 8453 | 4663;
  treasury: Address | null;
  writesEnabled: boolean;
  blockReason: string | null;
  curvePolicy?: string;
  launchGuard?: Address | null;
  feePolicy?: FeePolicy;
  feeEngine?: Address | null;
  buybackExecutor?: Address | null;
  automationReceiver?: Address | null;
  automationTreasury?: Address | null;
  wethForwarder?: Address | null;
};
export type StockStatus = Stock & {
  verified: boolean;
  error?: string;
  blockNumber: string;
  onchainName?: string;
  totalSupply: string | null;
  multiplierWad: string | null;
};
export type TokenRecord = {
  address: Address;
  name: string;
  symbol: string;
  description: string;
  image: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  quoteAddress: Address;
  creator: Address | null;
  poolId: `0x${string}`;
  transactionHash: `0x${string}` | null;
  blockNumber: string | null;
  createdAt: number;
  openingCap: string;
  // Absent on historical launches, whose openingCap remains in paired units.
  openingValuation?: OpeningValuation;
  curvePolicy?: string;
  mode: "base" | "robinhood" | "fork";
  deploymentChainId?: 8453 | 4663;
  // Absent for older launches. Never backfill
  // these from current policy/config: deployed beneficiary shares are fixed.
  feePolicy?: FeePolicy;
  feeTreasury?: Address;
  feeEngine?: Address;
};

// Currency ordering changes with the deployed meme address; never assume the
// stock is currency0 or that both assets have the same decimal precision.
export function poolCurrency(
  currency: Address,
  token: Pick<TokenRecord, "address" | "symbol" | "quoteAddress">,
) {
  if (sameAddress(currency, token.quoteAddress)) return quoteAsset(token);
  if (sameAddress(currency, token.address))
    return { address: token.address, symbol: token.symbol, decimals: 18 };
  throw new Error("The asset does not belong to this pool");
}

export function quoteAsset(
  token: Pick<TokenRecord, "address" | "quoteAddress">,
) {
  return stockByAddress(token.quoteAddress);
}
export function listedTokens(
  tokens: TokenRecord[],
  mode: RuntimeConfig["mode"],
  deploymentChainId?: 8453 | 4663,
) {
  return tokens.filter(
    (token) =>
      token.mode === mode &&
      token.transactionHash !== null &&
      (mode !== "fork" || (token.deploymentChainId ?? 8453) === (deploymentChainId ?? 8453)) &&
      assetsFor({ mode, deploymentChainId }).some((stock) => sameAddress(stock.address, token.quoteAddress)),
  );
}
export function sortTokens(tokens: TokenRecord[], order: "new" | "name") {
  return [...tokens].sort(
    (a, b) =>
      order === "name"
        ? a.name.localeCompare(b.name)
        : b.createdAt - a.createdAt,
  );
}

// Presentation only: keep all allowances, curve prices and swaps in raw units.
export function shareEquivalent(raw: bigint, multiplierWad: bigint): bigint {
  if (raw < 0n || multiplierWad <= 0n) throw new Error("Invalid stock quantity or multiplier");
  return (raw * multiplierWad) / WAD;
}
