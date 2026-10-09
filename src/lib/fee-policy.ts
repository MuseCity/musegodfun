import { getAddress, type Address } from "viem";

// All shares use basis points. The first five fields use gross fees; *Net
// fields use fees after Doppler; platform* fields use the platform's income.
export const FEE_POLICIES = {
  "creator-70-musegod-base-automation-v1": {
    id: "creator-70-musegod-base-automation-v1",
    protocol: 500, creator: 6650, platform: 2850, buyback: 2280, operations: 570,
    creatorNet: 7000, platformNet: 3000, platformBuyback: 8000, platformOperations: 2000,
  },
  "creator-70-musegod-base-collector-v1": {
    id: "creator-70-musegod-base-collector-v1",
    protocol: 500, creator: 6650, platform: 2850, buyback: 2280, operations: 570,
    creatorNet: 7000, platformNet: 3000, platformBuyback: 8000, platformOperations: 2000,
  },
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
  "creator-70-musegod-swapper-v3": {
    id: "creator-70-musegod-swapper-v3",
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
export const ENGINE_FEE_POLICY = "creator-70-musegod-swapper-v3" as const;
export const BASE_AUTOMATION_FEE_POLICY = "creator-70-musegod-base-automation-v1" as const;
// Retained only to explain and recover already frozen Collector plans.
export const BASE_COLLECTOR_FEE_POLICY = "creator-70-musegod-base-collector-v1" as const;
export const isEngineFeePolicy = (policy: string | null | undefined) => policy === ENGINE_FEE_POLICY || policy === BASE_AUTOMATION_FEE_POLICY || policy === BASE_COLLECTOR_FEE_POLICY;

// Native Base processing is opt-in after graph verification. Old Collector
// policies remain readable but cannot select a new launch.
export function launchFeePolicy(config?: { mode?: string; deploymentChainId?: number; feePolicy?: string } | null): FeePolicy {
  if (config?.feePolicy === BASE_AUTOMATION_FEE_POLICY && (config.mode === "base" || config.deploymentChainId === 8453)) return BASE_AUTOMATION_FEE_POLICY;
  return config?.feePolicy === ENGINE_FEE_POLICY && (config.mode === "robinhood" || config.deploymentChainId === 4663)
    ? ENGINE_FEE_POLICY : FEE_POLICY;
}

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
  engine?: Address | null;
}): FeeIncomeAllocation | null {
  if (input.amount < 0n) throw new Error("Fee income cannot be negative");
  const policy = feePolicyFor(input.feePolicy);
  if (!policy) return null;
  const account = input.account.toLowerCase();
  const isCreator = input.creator?.toLowerCase() === account;
  const isPlatform = input.treasury?.toLowerCase() === account;
  if (isEngineFeePolicy(policy.id)) {
    const isEngine = input.engine?.toLowerCase() === account;
    if (isEngine && (isCreator || isPlatform)) throw new Error("The fee engine must be a distinct beneficiary");
    if (isEngine) return { creator: 0n, platform: input.amount, buyback: input.amount, operations: 0n, remainder: 0n };
    if (!isCreator && !isPlatform) return null;
    // Engine receipts have already been split on-chain. The operations
    // beneficiary must not apply the old platform 80/20 split again.
    const both = isCreator && isPlatform;
    const denominator = BigInt(policy.creator + policy.operations);
    const creator = isCreator ? both ? input.amount * BigInt(policy.creator) / denominator : input.amount : 0n;
    const operations = isPlatform ? both ? input.amount * BigInt(policy.operations) / denominator : input.amount : 0n;
    return { creator, platform: operations, buyback: 0n, operations, remainder: input.amount - creator - operations };
  }
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
