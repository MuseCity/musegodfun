import { encodeFunctionData, getAddress, parseAbi, type Address, type Hash } from "viem";
import { deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import { minimumOutput } from "./validation";

export const MUSEGOD = {
  token: getAddress("0x0379e228f6887c6f18bf394042ecaf81b308cb2e"),
  weth: getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73"),
  pool: getAddress("0x071ee139277688d64b139af1e44f79a9acf12e53"),
  factory: getAddress("0xe51960f1b45f1c9fb6d166e6a884f866fc70433b"),
  quoter: getAddress("0x3e290e5e01818002a0b672148bdc7514d861c7b3"),
  // Executable runtime reconstructed from official SwapRouter02 source;
  // immutable Sushi addresses and native buy/sell fork receipts are retained.
  router: getAddress("0xb2d8ed81e79eb64a0751352459ec215fbafad669"),
  fee: 10_000,
  name: "MUSEGOD",
  symbol: "MUSEGOD",
  image: "/asset-logos/MUSEGOD.png",
  createdAt: Date.parse("2026-09-23T18:15:40.000Z"),
  description: "The MUSEGOD community token on Robinhood Chain. Trade ETH and MUSEGOD through its existing SushiSwap v3 pool.",
  sourceUrl: "https://pools.fun/token/0x0379e228f6887c6f18bf394042ecaf81b308cb2e",
} as const;

export const MUSEGOD_ROUTER_VERIFICATION = Object.freeze({
  verified: true,
  runtimeHash: "0xfc74a488f09061ac920441cff14bbda46c9202680572881ccd9e12ac019ee406",
  reason: "MUSEGOD trading is unavailable while the SushiSwap router deployment and source verification is pending. On-chain quote previews remain available.",
} as { verified: boolean; runtimeHash: Hash; reason: string });
export const MUSEGOD_QUOTE_TTL = 60_000;
export type MusegodQuote = {
  protocol: "sushi-v3";
  chainId: number;
  deploymentChainId: 4663;
  token: Address;
  poolAddress: Address;
  side: "buy" | "sell";
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  slippageBps: number;
  quotedAt: number;
  expiresAt: number;
  blockNumber: string;
  blockHash: Hash;
};
export type MusegodInfo = {
  name: string;
  symbol: string;
  address: Address;
  image: string;
  description: string;
  quoteAddress: Address;
  poolAddress: Address;
  decimals: 18;
  totalSupply: string | null;
  tradeEnabled: boolean;
  tradeBlockReason: string | null;
};
export function musegodNetwork(config: Pick<RuntimeConfig, "mode" | "chainId" | "deploymentChainId">) {
  return deploymentChain(config) === 4663 &&
    ((config.mode === "robinhood" && config.chainId === 4663) || (config.mode === "fork" && config.chainId === 31337));
}
export function assertMusegodTradingEnabled(config: RuntimeConfig) {
  if (!musegodNetwork(config)) throw new Error("MUSEGOD trading requires the active Robinhood Chain network.");
  if (!MUSEGOD_ROUTER_VERIFICATION.verified) throw new Error(MUSEGOD_ROUTER_VERIFICATION.reason);
}

export const musegodPoolAbi = parseAbi([
  "function token0() view returns (address)", "function token1() view returns (address)",
  "function factory() view returns (address)", "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
]);
export const musegodFactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
export const musegodPeripheryAbi = parseAbi([
  "function factory() view returns (address)", "function WETH9() view returns (address)",
]);
export const musegodQuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
export const musegodRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
]);

export function assertMusegodQuote(quote: MusegodQuote, config: RuntimeConfig, now = Date.now()) {
  const raw = (x: unknown) => typeof x === "string" && /^[1-9]\d{0,77}$/.test(x) && BigInt(x) < 2n ** 256n;
  if (!musegodNetwork(config) || quote.protocol !== "sushi-v3" || quote.chainId !== config.chainId ||
    quote.deploymentChainId !== 4663 || !sameAddress(quote.token, MUSEGOD.token) || !sameAddress(quote.poolAddress, MUSEGOD.pool) ||
    !["buy", "sell"].includes(quote.side) || !raw(quote.amountIn) || !raw(quote.amountOut) || !raw(quote.minAmountOut) ||
    !Number.isInteger(quote.slippageBps) || quote.slippageBps < 1 || quote.slippageBps > 500 ||
    BigInt(quote.minAmountOut) !== minimumOutput(BigInt(quote.amountOut), quote.slippageBps) ||
    !Number.isSafeInteger(quote.quotedAt) || !Number.isSafeInteger(quote.expiresAt) ||
    quote.quotedAt > now + 5000 || quote.expiresAt <= quote.quotedAt || quote.expiresAt - quote.quotedAt > MUSEGOD_QUOTE_TTL ||
    !/^\d{1,20}$/.test(quote.blockNumber) || !/^0x[0-9a-fA-F]{64}$/.test(quote.blockHash))
    throw new Error("The MUSEGOD quote parameters do not match the verified pool. Request a new quote.");
  if (now >= quote.expiresAt) throw new Error("The quote has expired. Request a new quote. Existing approvals can still be reused.");
}

// Pure calldata construction; the wallet independently enforces the source gate.
export function musegodSwapTransaction(quote: MusegodQuote, recipient: Address, config: RuntimeConfig, now = Date.now()) {
  assertMusegodQuote(quote, config, now);
  const calls = [encodeFunctionData({ abi: musegodRouterAbi, functionName: "exactInputSingle", args: [{
    tokenIn: quote.side === "buy" ? MUSEGOD.weth : MUSEGOD.token,
    tokenOut: quote.side === "buy" ? MUSEGOD.token : MUSEGOD.weth,
    fee: MUSEGOD.fee,
    recipient: quote.side === "buy" ? recipient : MUSEGOD.router,
    amountIn: BigInt(quote.amountIn), amountOutMinimum: BigInt(quote.minAmountOut), sqrtPriceLimitX96: 0n,
  }] })];
  calls.push(quote.side === "buy"
    ? encodeFunctionData({ abi: musegodRouterAbi, functionName: "refundETH" })
    : encodeFunctionData({ abi: musegodRouterAbi, functionName: "unwrapWETH9", args: [BigInt(quote.minAmountOut), recipient] }));
  return { to: MUSEGOD.router,
    data: encodeFunctionData({ abi: musegodRouterAbi, functionName: "multicall", args: [BigInt(Math.floor(quote.expiresAt / 1000)), calls] }),
    value: quote.side === "buy" ? BigInt(quote.amountIn) : 0n };
}
