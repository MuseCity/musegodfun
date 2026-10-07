import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import { ENGINE_FEE_POLICY, MUSEGOD_BUYBACK } from "./fee-policy";

export const BUYBACK_WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
export const LEGACY_FEE_ENGINE = getAddress("0x2f1FD06e3b6Dd81123629d08a74A6279Ea03797f");
export const BUYBACK_WINDOW_CAP = 10n ** 16n;
export const BUYBACK_FORWARDER_ALLOWANCE_CAP = 288n * BUYBACK_WINDOW_CAP;
export function buybackAmountCandidates(balance: bigint): bigint[] {
  const result: bigint[] = [];
  for (let amount = balance > BUYBACK_WINDOW_CAP ? BUYBACK_WINDOW_CAP : balance; amount > 0n && result.length < 20; amount /= 2n) result.push(amount);
  return result;
}
export const feeEngineAbi = parseAbi([
  "function initializer() view returns(address)", "function rehype() view returns(address)",
  "function oracle() view returns(address)", "function swapper() view returns(address)",
  "function assetOracle() view returns(address)", "function settlementVault() view returns(address)",
  "function weth() view returns(address)", "function muse() view returns(address)",
  "function automation() view returns(address)", "function isUnpriced(address token) view returns(bool)",
  "function router() view returns(address)", "function routerCodeHash() view returns(bytes32)",
  "function routerExecutor() view returns(address)", "function routerExecutorCodeHash() view returns(bytes32)",
  "function pending(address) view returns(uint256)",
  "function window(address) view returns(uint256 startsAt,uint256 limit,uint256 used)",
  "function totalClaimed(address) view returns(uint256)",
  "function totalSynced(address) view returns(uint256)",
  "function totalForwarded(address) view returns(uint256)",
  "function totalConverted(address) view returns(uint256)", "function totalConvertedWeth() view returns(uint256)",
  "function totalDirectBurned() view returns(uint256)",
  "function totalAutomationForwarded(address token) view returns(uint256)",
  "function claimFees(bytes32 poolId)", "function claimAndForward(bytes32 poolId)",
  "function syncUntracked(bytes32 poolId)",
  "function forwardWeth(uint256 amount)", "function burnMuse(uint256 amount)",
  "function releaseUnpriced(address token,uint256 amount)",
  "function convertToWeth(address token,uint256 amount,bytes routeData,uint256 minWethOut,uint256 deadline)",
]);
export const buybackExecutorAbi = parseAbi([
  "function swapper() view returns(address)", "function weth() view returns(address)",
  "function musegod() view returns(address)", "function router() view returns(address)",
  "function execute(uint256 amount,uint256 minProfit,uint256 deadline) returns(uint256 museToDead,uint256 profit)",
]);
export const wethForwarderAbi = parseAbi([
  "function source() view returns(address)", "function weth() view returns(address)",
  "function swapper() view returns(address)", "function totalForwarded() view returns(uint256)",
  "function vault() view returns(address)",
  "function MAX_ALLOWANCE() view returns(uint256)",
  "function forward(uint256 amount)",
]);
export const buybackVaultAbi = parseAbi([
  "event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)",
  "function weth() view returns(address)", "function musegod() view returns(address)",
  "function oracle() view returns(address)", "function swapper() view returns(address)",
  "function executor() view returns(address)", "function pool() view returns(address)",
  "function WINDOW_SECONDS() view returns(uint256)", "function WINDOW_CAP() view returns(uint256)",
  "function MAX_DEVIATION_BPS() view returns(uint256)", "function rollingSpent() view returns(uint256)",
  "function available() view returns(uint256)", "function totalSpent() view returns(uint256)",
  "function totalBurned() view returns(uint256)", "function checkPrices() view returns(uint256,uint256,uint256)",
  "function execute(uint256 amount,uint256 minProfit,uint256 deadline) returns(uint256,uint256)",
]);
export const assetFeedOracleAbi = parseAbi([
  "function governor() view returns(address)", "function weth() view returns(address)",
  "function FEED_CHANGE_DELAY() view returns(uint256)",
  "function descriptionHash(address) view returns(bytes32)",
  "function assetFeeds(address) view returns(address,uint32,uint8,uint8,bool)",
  "function proposals(address) view returns(address,uint64,bytes32)",
  "function quoteToWeth(address,uint256) view returns(uint256)",
  "function proposeFeed(address token,address feed)", "function cancelFeed(address token)", "function activateFeed(address token)",
]);
export type EngineAction =
  | { kind: "claim"; poolId: Hex }
  | { kind: "sync"; poolId: Hex }
  | { kind: "forward" | "forward_source" | "burn"; amount: string }
  | { kind: "execute"; amount: string; minProfit: string; deadline: number }
  | { kind: "release_unpriced"; token: Address; amount: string }
  | { kind: "convert"; token: Address; amount: string; routeData: Hex; minWethOut: string; deadline: number };
export type EngineTransaction = { to: Address; data: Hex; value: 0n };
export function engineTransaction(action: EngineAction, config: RuntimeConfig, now = Date.now()): EngineTransaction {
  const sources = [config.treasury, config.automationReceiver, config.automationTreasury, config.wethForwarder, config.buybackVault, config.assetFeedOracle];
  if (deploymentChain(config) !== 4663 || config.feePolicy !== ENGINE_FEE_POLICY || !config.feeEngine ||
    sameAddress(config.feeEngine, LEGACY_FEE_ENGINE) ||
    sources.some((address) => !address || sameAddress(address, "0x0000000000000000000000000000000000000000")) ||
    new Set(sources.map((address) => address?.toLowerCase())).size !== sources.length)
    throw new Error("The public buyback engine is not configured and verified on this network");
  const amount = (raw: string, zeroAllowed = false) => {
    if (!/^(?:0|[1-9]\d{0,77})$/.test(raw) || BigInt(raw) >= 2n ** 256n || (!zeroAllowed && BigInt(raw) === 0n))
      throw new Error("Invalid buyback amount");
    return BigInt(raw);
  };
  if (action.kind === "forward_source")
    return { to: config.wethForwarder!, data: encodeFunctionData({ abi: wethForwarderAbi, functionName: "forward", args: [amount(action.amount)] }), value: 0n };
  if (action.kind === "claim" || action.kind === "sync") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(action.poolId)) throw new Error("Invalid pool identity");
    return { to: config.feeEngine, data: encodeFunctionData({ abi: feeEngineAbi, functionName: action.kind === "sync" ? "syncUntracked" : "claimAndForward", args: [action.poolId] }), value: 0n };
  }
  if (action.kind === "execute") {
    if (!config.buybackExecutor || !config.buybackVault) throw new Error("The public buyback vault could not be verified");
    if (!Number.isSafeInteger(action.deadline) || action.deadline * 1000 <= now || action.deadline * 1000 > now + 60_000)
      throw new Error("The buyback execution preview has expired");
    if (amount(action.amount) > BUYBACK_WINDOW_CAP) throw new Error("The buyback amount exceeds the shared rolling budget");
    return { to: config.buybackVault, data: encodeFunctionData({ abi: buybackVaultAbi, functionName: "execute", args: [amount(action.amount), amount(action.minProfit, true), BigInt(action.deadline)] }), value: 0n };
  }
  if (action.kind === "release_unpriced") {
    const token = getAddress(action.token);
    if ([BUYBACK_WETH, MUSEGOD_BUYBACK.tokenAddress, "0x0000000000000000000000000000000000000000"].some((address) => sameAddress(address, token)))
      throw new Error("This asset must use its fixed buyback or burn path");
    return { to: config.feeEngine, data: encodeFunctionData({ abi: feeEngineAbi, functionName: "releaseUnpriced", args: [token, amount(action.amount)] }), value: 0n };
  }
  if (action.kind === "convert") {
    if (!Number.isSafeInteger(action.deadline) || action.deadline * 1000 <= now || action.deadline * 1000 > now + 300_000 ||
      !/^0x(?:[0-9a-fA-F]{2}){4,100000}$/.test(action.routeData) || sameAddress(action.token, BUYBACK_WETH))
      throw new Error("The conversion route has expired or is invalid");
    return { to: config.feeEngine, data: encodeFunctionData({ abi: feeEngineAbi, functionName: "convertToWeth", args: [getAddress(action.token), amount(action.amount), action.routeData, amount(action.minWethOut), BigInt(action.deadline)] }), value: 0n };
  }
  return { to: config.feeEngine, data: encodeFunctionData({ abi: feeEngineAbi, functionName: action.kind === "burn" ? "burnMuse" : "forwardWeth", args: [amount(action.amount)] }), value: 0n };
}

export type EngineAssetStatus = {
  address: Address; symbol: string; decimals: number;
  pending: string; claimed: string; forwarded: string; converted: string;
  pricing: "supported" | "unsupported_static" | "unknown";
  automationForwarded: string;
  available: string; referenceWeth: string | null; error: string | null;
  synced?: string; untracked?: string;
  // Recorded pending minus actual balance; positive only during a deficit.
  shortfall?: string;
};
export type EngineBurn = { hash: Hex; blockNumber: string; amount: string; source: "swapper" | "engine" };
export type EngineClaimPreview = { address: Address; symbol: string; decimals: number; lp: string | null; hook: string | null }[];
export type FeedProposalStatus = { token: Address; symbol: string; currentFeed: Address; proposedFeed: Address; executableAt: string };
export type BuybackEngineStatus = {
  available: boolean; reason: string | null; blockNumber: string | null;
  engine: Address | null; swapper: Address | null; executor: Address | null;
  operationsTreasury: Address | null; automationReceiver: Address | null;
  automationTreasury: Address | null; wethForwarder: Address | null;
  sourceDeployed: boolean; sourceWeth: string | null; sourceAllowance: string | null;
  sourceForwarded: string | null; sourceAvailable: string | null; sourceAuthorizationError?: string | null;
  assets: EngineAssetStatus[];
  pools: { address: Address; poolId: Hex; symbol: string; claimable: EngineClaimPreview | null; currencies?: Address[] | null }[];
  swapperWeth: string | null; directBurned: string | null; convertedWeth: string | null;
  burns: EngineBurn[]; burnScanFrom: string | null;
  vault?: string | null; assetOracle?: string | null; vaultWeth?: string | null; vaultAvailable?: string | null;
  vaultSpent?: string | null; vaultBurned?: string | null; buybackWaitReason?: string | null;
  burnScanTo?: string | null; burnIndexCaughtUp?: boolean;
  feedProposals?: FeedProposalStatus[];
};
export type EngineConversionQuote = { action: Extract<EngineAction, { kind: "convert" }>; quotedWeth: string; expiresAt: number };
