import { getAddress, parseAbi, type Address, type Hex } from "viem";

/** An unshipped research protocol identifier. Never authorize new execution with it. */
export const BASE_LEGACY_ACROSS_PROTOCOL = "lifi_across_weth_v1";
export const BASE_RECOVERY_PROTOCOL = 2;
export const BASE_NATIVE_BUYBACK_PROTOCOL = "splits_native_relay_v1";
export const BASE_BUYBACK_PROTOCOL = BASE_NATIVE_BUYBACK_PROTOCOL;
export const BASE_BUYBACK_WETH = getAddress("0x4200000000000000000000000000000000000006");
export const BASE_BUYBACK_RH_WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
export const BASE_BUYBACK_VAULT = getAddress("0x28E6B43525301312084310F31f4C9c9873d7a125");
export const BASE_BUYBACK_TREASURY = getAddress("0xb3C11Aa2148521A3ef6d446672b720A63a2D8349");
export const BASE_BUYBACK_FORWARDER = getAddress("0x808d538f13ce0356E80C7a5ac2798d09206aB8f4");
export const baseCollectorAbi = parseAbi([
  "function claimFees(bytes32 poolId)", "function releaseFees(address token,uint256 amount)",
  "function pendingFees(address token) view returns(uint256)", "function totalClaimed(address token) view returns(uint256)",
  "function totalReleased(address token) view returns(uint256)", "function untrackedBalance(address token) view returns(uint256)",
  "function paused() view returns(bool)", "function automationReceiver() view returns(address)",
  "event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",
  "event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",
]);
export type BaseFeeAsset = { chainId: 8453 | 4663; address: Address; symbol: string; decimals: number };
export type BaseGasReservation = { executionWei: string; l1Wei: string; operatorWei: string; totalWei: string;
  blockNumber: string; blockHash: Hex; unsignedHash: Hex; unsignedBytes: number };
export type BaseTransactionFee = { transactionHash: Hex; blockNumber: string; blockHash: Hex; executionWei: string;
  l1Wei: string; operatorWei: string; totalWei: string };
/** Retained public provider response, not a transaction prepared or signed by the project. */
export type BaseNativeRelayProofInput =
  { version: 1; protocol: typeof BASE_NATIVE_BUYBACK_PROTOCOL; sourceHash: Hex; destinationHash: Hex; raw: Record<string, unknown> } |
  { version: 2; protocol: typeof BASE_NATIVE_BUYBACK_PROTOCOL; sourceHash: Hex; destinationHash: Hex };
/** V2 verifies native request-tag association under the explicitly trusted provider; signed order minima/refunds/deadlines are unavailable. */
export type BaseNativeRelayEvidence = {
  version: 1 | 2; protocol: typeof BASE_NATIVE_BUYBACK_PROTOCOL; orderParametersVerified: boolean; requestId: Hex; orderId: Hex; metadata: Hex;
  sourceTransactionHash: Hex; sourceBlockNumber: string; sourceBlockHash: Hex; sourceTransferLogIndex: number;
  sourceDepositLogIndex: number; sourceAsset: Address; sourceAmount: string; sourceNativeDeposit: string;
  automation: Address; treasury: Address; outputToken: Address; outputAmount: string;
  destinationTransactionHash: Hex; destinationBlockNumber: string; destinationBlockHash: Hex;
  destinationTransferLogIndex: number; destinationMovementLogIndex: number; sourceCalldataHash: Hex;
};
export type BaseFeeBatch = {
  id: string; protocol: typeof BASE_NATIVE_BUYBACK_PROTOCOL; sourceChainId: 8453; destinationChainId: 4663;
  collector: Address; kind: "claim" | "release" | "native_relay";
  status: "broadcast" | "unknown" | "claimed" | "released" | "bridging" | "received" | "awaiting_buyback" |
    "attributed" | "reverted" | "cancelled" | "refunded" | "reorg";
  createdAt: number; updatedAt: number; poolId?: Hex; inputAsset?: BaseFeeAsset; amountIn: string;
  receivedAmount: string; refundedAmount: string; burnedAmount: string; claimHashes: Hex[];
  sourceHash?: Hex; sourceBlockNumber?: string; sourceBlockHash?: Hex; destinationHash?: Hex; destinationScanAfter?: Hex; destinationFromBlock?: string; destinationFromBlockHash?: Hex; destinationMatchHash?: Hex; requestId?: Hex; orderId?: Hex; nativeConflict?: { sourceHash: Hex; requestId: Hex; orderId: Hex };
  claimCredits?: { poolId: Hex; manager: Address; token: Address; amount: string }[];
  release?: { token: Address; amount: string; automation: Address };
  journal?: { caller: Address; nonce: number; to: Address; dataHash: Hex; hash: Hex; gasLimit: string; maxFeePerGas: string; signedAt: number };
  replacements?: { hash: Hex; cancelled: boolean; blockNumber: string; blockHash: Hex }[];
  proof?: BaseNativeRelayProofInput; relay?: BaseNativeRelayEvidence; error?: string;
  gasReservation?: BaseGasReservation; actualGas?: BaseTransactionFee;
};
export type BaseCollectorStatus = {
  kind: "base_splits_native"; protocol: typeof BASE_NATIVE_BUYBACK_PROTOCOL; chainId: 8453;
  available: boolean; collector: Address | null; automation: Address | null; destinationChainId: 4663;
  destinationTreasury: Address; destinationVault: Address; paused: boolean;
  nativeAutomationState: "unverified" | "configured" | "paused";
  totalBridgedWeth: string; totalRefundedWeth: string; assets: (BaseFeeAsset & {
    pending: string; untracked: string; totalClaimed: string; totalReleased: string; automationBalance: string;
  })[]; batches: BaseFeeBatch[]; ledgerComplete: boolean; assetsComplete: boolean; error?: string;
};
export function integer(value: unknown, zero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value)) throw new Error("Invalid raw Base amount");
  const result = BigInt(value);
  if (result >= 2n ** 256n || result < (zero ? 0n : 1n)) throw new Error("Invalid raw Base amount");
  return result;
}
