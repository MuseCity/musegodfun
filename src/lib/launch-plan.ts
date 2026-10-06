import type { PreparedMulticurveCreate } from "@whetstone-research/doppler-sdk/evm";
import type { Address, Hex } from "viem";
import type { LaunchInput } from "./validation";
import type { FeePolicy } from "./fee-policy";
import type { OpeningValuation } from "./opening-valuation";

export type Serialized<T> = T extends bigint ? string : T extends readonly unknown[]
  ? { [K in keyof T]: Serialized<T[K]> } : T extends object
    ? { [K in keyof T]: Serialized<T[K]> } : T;
export type LaunchTransaction = { to: Address; data: Hex; value: string };
export type FirstBuyPlan = {
  amount: string;
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut: string;
  slippageBps: number;
  deadline: number;
  recipient: Address;
  quoteAddress: Address;
  guard: Address;
  bundler: Address;
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
};

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
