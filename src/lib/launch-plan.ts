import type { PreparedMulticurveCreate } from "@whetstone-research/doppler-sdk/evm";
import type { Address, Hex } from "viem";
import type { LaunchInput } from "./validation";
import type { FeePolicy } from "./fee-policy";
import { assertOpeningValuation, LAUNCH_PRICE_TTL, type OpeningValuation, type LaunchWarning } from "./opening-valuation";

export const LAUNCH_SIGNING_TTL = 300_000;
export type LaunchPrepareOptions = { intentId?: string; previousPlanId?: Hex; acceptedMinAmountOut?: string;
  reconfirmPrice?: boolean; reconfirmedMinimumOut?: string };

export type Serialized<T> = T extends bigint ? string : T extends readonly unknown[]
  ? { [K in keyof T]: Serialized<T[K]> } : T extends object
    ? { [K in keyof T]: Serialized<T[K]> } : T;
export type LaunchTransaction = { to: Address; data: Hex; value: string };
export type FirstBuyLockDays = 0 | 30 | 90 | 365;
export type FirstBuyLockRecord = {
  bundler: Address;
  recipient: Address;
  totalAmount: string;
  start: number;
  cliffDuration: number;
  vestingDuration: number;
  lockDays: Exclude<FirstBuyLockDays, 0>;
};
export type FirstBuyLockStatus = FirstBuyLockRecord & {
  tokenAddress?: Address;
  deploymentChainId?: 8453 | 4663;
  recordVerified?: boolean;
  decimals?: number;
  symbol?: string;
  claimedAmount: string;
  claimableAmount: string;
  unlockAt: number;
  claimTransaction?: LaunchTransaction;
};
export type FirstBuyPlan = {
  amount: string;
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut: string;
  // A refresh never lowers the minimum already accepted by the creator.
  acceptedMinAmountOut?: string;
  slippageBps: number;
  deadline: number;
  recipient: Address;
  quoteAddress: Address;
  guard: Address;
  bundler: Address;
  // Absent in historical previews, where no purchase was locked.
  lockDays?: FirstBuyLockDays;
};
export type LaunchPlan = {
  id: Hex;
  creator: Address;
  // The original lookup key stays the outer transaction's calldata.
  data: Hex;
  tokenAddress: Address;
  poolId: Hex;
  draft: LaunchInput & { openingCap?: string };
  preparedAt: number;
  validityVersion?: 2;
  finalizedAt?: number;
  signingExpiresAt?: number;
  serverTime?: number;
  intentId?: string;
  previousPlanId?: Hex;
  requiresReconfirmation?: boolean;
  warnings?: LaunchWarning[];
  gas: string | null;
  feePolicy?: FeePolicy;
  feeTreasury?: Address;
  feeEngine?: Address;
  openingValuation?: OpeningValuation;
  // Historical plans remain recoverable without these new signing fields.
  curvePolicy?: string;
  prepared?: Serialized<PreparedMulticurveCreate<8453 | 4663>>;
  transaction?: LaunchTransaction;
  firstBuy?: FirstBuyPlan;
  approval?: {
    token: Address;
    spender: Address;
    amount: string;
    required: boolean;
    transaction: LaunchTransaction;
  };
  // Platform HMAC over the deployment chain and id, set when the server is
  // configured with an attestation key; it travels with the local backup.
  attestation?: Hex;
};

/** Fresh at creation, then a fixed signing window. Historical plans retain
 * their original pricing expiry; validation never renews either deadline. */
export function assertLaunchPlanValidity(plan: LaunchPlan, chainId: 8453 | 4663, now = Date.now()) {
  if (plan.validityVersion === 2) {
    if (!Number.isSafeInteger(plan.finalizedAt) || plan.finalizedAt! <= 0 || plan.finalizedAt !== plan.preparedAt ||
      plan.signingExpiresAt !== plan.finalizedAt! + LAUNCH_SIGNING_TTL ||
      !Number.isSafeInteger(plan.serverTime) || plan.serverTime! < plan.finalizedAt! ||
      !plan.intentId || !/^[a-zA-Z0-9_-]{8,100}$/.test(plan.intentId) ||
      now >= plan.signingExpiresAt! || now < plan.finalizedAt!)
      throw new Error("The launch signing window expired or changed. Refresh the preview.");
    assertOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, chainId, plan.finalizedAt);
  } else {
    if (now - plan.preparedAt > LAUNCH_PRICE_TTL)
      throw new Error("The issuance preview expired. Refresh the preview.");
    assertOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, chainId, now);
  }
}

export function serializePrepared(prepared: PreparedMulticurveCreate<8453 | 4663>): NonNullable<LaunchPlan["prepared"]> {
  return JSON.parse(JSON.stringify(prepared, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

export function restorePrepared(value: NonNullable<LaunchPlan["prepared"]>): PreparedMulticurveCreate<8453 | 4663> {
  return {
    ...value,
    createParams: { ...value.createParams, initialSupply: BigInt(value.createParams.initialSupply), numTokensToSell: BigInt(value.createParams.numTokensToSell) },
    transaction: { ...value.transaction, value: BigInt(value.transaction.value) },
    approvalTransaction: value.approvalTransaction ? { ...value.approvalTransaction, value: BigInt(value.approvalTransaction.value) } : undefined,
    gasEstimate: value.gasEstimate.status === "estimated" ? { status: "estimated", gas: BigInt(value.gasEstimate.gas) } : { status: "unavailable" },
    devBuy: value.devBuy ? {
      ...value.devBuy,
      exactAmountIn: BigInt(value.devBuy.exactAmountIn),
      simulatedAmountOut: BigInt(value.devBuy.simulatedAmountOut),
      vesting: { ...value.devBuy.vesting, cliffDuration: BigInt(value.devBuy.vesting.cliffDuration), vestingDuration: BigInt(value.devBuy.vesting.vestingDuration) },
    } : undefined,
  };
}
