import { getAddress, type Address } from "viem";

// All shares use basis points. The first five fields use gross fees; *Net
// fields use fees after Doppler; platform* fields use the platform's income.
export const FEE_POLICIES = {
  "musegod-80-v1": {
    id: "musegod-80-v1",
    protocol: 500,
    creator: 1900,
    platform: 7600,
    buyback: 7600,
    operations: 0,
    creatorNet: 2000,
    platformNet: 8000,
    platformBuyback: 10_000,
    platformOperations: 0,
  },
  "creator-70-musegod-v2": {
    id: "creator-70-musegod-v2",
    protocol: 500,
    creator: 6650,
    platform: 2850,
    buyback: 2280,
    operations: 570,
    creatorNet: 7000,
    platformNet: 3000,
    platformBuyback: 8000,
    platformOperations: 2000,
  },
} as const;
export type FeePolicy = keyof typeof FEE_POLICIES;
export type FeePolicyConfig = (typeof FEE_POLICIES)[FeePolicy];
export const FEE_POLICY = "creator-70-musegod-v2" as const;
export const FEE_SHARES = FEE_POLICIES[FEE_POLICY];

export function feePolicyFor(policy: string | null | undefined): FeePolicyConfig | null {
  return policy && Object.hasOwn(FEE_POLICIES, policy)
    ? FEE_POLICIES[policy as FeePolicy]
    : null;
}

export type FeeIncomeAllocation = {
  creator: bigint;
  // Intermediate subtotal, not another payment to add to the leaf amounts.
  platform: bigint;
  buyback: bigint;
  operations: bigint;
  // Unallocated smallest units from either rounding step remain in the wallet.
  remainder: bigint;
};

// `amount` is this beneficiary account's income in one token's raw units,
// never pool-wide gross fees or a wallet balance of unverified provenance.
// This is an allocation reference; it does not transfer or reserve funds.
export function allocateFeeIncome(input: {
  feePolicy: string | null | undefined;
  amount: bigint;
  account: Address;
  creator: Address | null;
  treasury?: Address | null;
}): FeeIncomeAllocation | null {
  if (input.amount < 0n) throw new Error("Fee income cannot be negative");
  const policy = feePolicyFor(input.feePolicy);
  if (!policy) return null;
  const account = input.account.toLowerCase();
  const isCreator = input.creator?.toLowerCase() === account;
  const isPlatform = input.treasury?.toLowerCase() === account;
  if (!isCreator && !isPlatform) return null;
  const both = isCreator && isPlatform;
  const creator = isCreator
    ? both ? input.amount * BigInt(policy.creatorNet) / 10_000n : input.amount
    : 0n;
  const platform = isPlatform
    ? both ? input.amount * BigInt(policy.platformNet) / 10_000n : input.amount
    : 0n;
  const buyback = platform * BigInt(policy.platformBuyback) / 10_000n;
  const operations = platform * BigInt(policy.platformOperations) / 10_000n;
  return {
    creator,
    platform,
    buyback,
    operations,
    remainder: input.amount - creator - buyback - operations,
  };
}

// These fields identify the intended use of the Base fee beneficiary's funds.
// The launch hook itself cannot perform a cross-chain purchase or transfer.
export const MUSEGOD_BUYBACK = {
  chainId: 4663,
  tokenAddress: getAddress("0x0379e228f6887c6f18bf394042ecaf81b308cb2e"),
  burnAddress: getAddress("0x000000000000000000000000000000000000dead"),
} as const;
