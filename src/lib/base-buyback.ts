import { getAddress, parseAbi, type Address, type Hex } from "viem";

/** An unshipped research protocol identifier. Never authorize new execution with it. */
export const BASE_LEGACY_ACROSS_PROTOCOL = "lifi_across_weth_v1";
/** V7 separates issuance from host maintenance and binds destination funding; V1-V6 remain readable. */
export const BASE_RECOVERY_PROTOCOL = 7;
export const BASE_NATIVE_BUYBACK_PROTOCOL = "splits_native_relay_v1";
export const BASE_NATIVE_DESTINATION_POLICY = "relay-v3-permit2-signed-execution-receipt-v3";
export const BASE_BUYBACK_PROTOCOL = BASE_NATIVE_BUYBACK_PROTOCOL;
export const BASE_BUYBACK_WETH = getAddress("0x4200000000000000000000000000000000000006");
export const BASE_BUYBACK_RH_WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
export const BASE_BUYBACK_VAULT = getAddress("0x28E6B43525301312084310F31f4C9c9873d7a125");
export const BASE_BUYBACK_TREASURY = getAddress("0xb3C11Aa2148521A3ef6d446672b720A63a2D8349");
export const BASE_BUYBACK_FORWARDER = getAddress("0x808d538f13ce0356E80C7a5ac2798d09206aB8f4");
export const baseCollectorAbi = parseAbi([
  "function claimFees(bytes32 poolId)", "function releaseFees(address token,uint256 amount)",
  "function pendingFees(address token) view returns(uint256)", "function totalClaimed(address token) view returns(uint256)",
  "function verifiedAssets(address token) view returns(bool)", "function syncUntracked(address token)", "function releaseUntracked(address token,uint256 amount)",
  "function pendingUntracked(address token) view returns(uint256)", "function totalUntrackedSynced(address token) view returns(uint256)", "function totalUntrackedReleased(address token) view returns(uint256)",
  "function totalReleased(address token) view returns(uint256)", "function untrackedBalance(address token) view returns(uint256)",
  "function paused() view returns(bool)", "function automationReceiver() view returns(address)",
  "event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",
  "event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",
  "event UntrackedSynced(address indexed token,uint256 amount)", "event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",
]);
export type BaseFeeAsset = { chainId: 8453 | 4663; address: Address; symbol: string; decimals: number };
export type BaseGasReservation = { executionWei: string; l1Wei: string; operatorWei: string; totalWei: string;
  blockNumber: string; blockHash: Hex; unsignedHash: Hex; unsignedBytes: number };
export type BaseTransactionFee = { transactionHash: Hex; blockNumber: string; blockHash: Hex; executionWei: string;
  l1Wei: string; operatorWei: string; totalWei: string };
export type BaseFeeBatch = {
  id: string; protocol: typeof BASE_NATIVE_BUYBACK_PROTOCOL; sourceChainId: 8453; destinationChainId: 4663;
  collector: Address; kind: "claim" | "release" | "sync_untracked" | "release_untracked" | "native_relay";
  status: "broadcast" | "unknown" | "claimed" | "synced" | "released" | "bridging" | "received" | "awaiting_buyback" |
    "reverted" | "cancelled" | "refunded" | "reorg" | "asset_failed" | "evidence_pending" | "abandoned";
  createdAt: number; updatedAt: number; poolId?: Hex; inputAsset?: BaseFeeAsset; amountIn: string;
  receivedAmount: string; refundedAmount: string; burnedAmount: string; claimHashes: Hex[];
  sourceHash?: Hex; sourceBlockNumber?: string; sourceBlockHash?: Hex; destinationHash?: Hex;
  claimCredits?: { poolId: Hex; manager: Address; token: Address; amount: string }[];
  /** Verified pool identities, including canonical zero-credit registration. Never fee income. */
  claimAssets?: Address[];
  /** A zero-fee pool-registration attempt for unknown recovery uses the separate operator-authorized recovery gas ceiling. */
  recoveryRegistration?: boolean;
  /** Set only after the exact canonical receipt and actual gas were verified at/below a captured finalized head. */
  sourceFinalized?: boolean;
  /** Already-mined asset evidence is rechecked at this time, never by repeating its source spend. */
  evidenceRetryAt?: number;
  /** Current local signer proved broadcast was never invoked. Unlock only after both journals retain the complete abandoned marker. */
  abandonedBeforeBroadcast?: true;
  untrackedSync?: { token: Address; amount: string };
  release?: { token: Address; amount: string; automation: Address };
  journal?: { caller: Address; nonce: number; to: Address; dataHash: Hex; hash: Hex; gasLimit: string; maxFeePerGas: string; signedAt: number };
  replacements?: { hash: Hex; cancelled: boolean; blockNumber: string; blockHash: Hex }[];
  error?: string;
  gasReservation?: BaseGasReservation; actualGas?: BaseTransactionFee;
};
export type BaseCollectorStatus = {
  kind: "base_splits_native"; protocol: typeof BASE_NATIVE_BUYBACK_PROTOCOL; chainId: 8453;
  available: boolean; collector: Address | null; automation: Address | null; destinationChainId: 4663;
  destinationTreasury: Address; destinationVault: Address; paused: boolean;
  nativeAutomationState: "unverified" | "configured" | "paused";
  checkedAt: number; blockNumber: string | null; stale?: boolean; assets: (BaseFeeAsset & {
    pending: string; untracked?: string; totalClaimed: string; totalReleased: string; automationBalance: string;
    pendingUntracked?: string; totalUntrackedSynced?: string; totalUntrackedReleased?: string; verifiedAsset?: boolean;
  })[]; assetsComplete: boolean; error?: string;
};
export type RobinhoodBuybackSummary = {
  chainId: 4663; scope: "shared_robinhood"; available: boolean; checkedAt: number; blockNumber: string | null; stale?: boolean;
  treasury: Address; vault: Address; tokenAddress: Address; burnAddress: Address;
  treasuryWeth: string | null; vaultWeth: string | null; vaultSpentWeth: string | null; vaultMuseToDead: string | null;
  deadTotalMuse: string | null; totalSupply: string | null; error?: string;
};
export function integer(value: unknown, zero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value)) throw new Error("Invalid raw Base amount");
  const result = BigInt(value);
  if (result >= 2n ** 256n || result < (zero ? 0n : 1n)) throw new Error("Invalid raw Base amount");
  return result;
}
