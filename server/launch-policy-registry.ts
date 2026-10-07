import { getAddress, type Address } from "viem";
import engineDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { deploymentChain, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY, type FeePolicy } from "../src/lib/fee-policy";
import type { LaunchPlan } from "../src/lib/launch-plan";

/** One fee routing the platform approved for new launches. `fromBlock` is
 * inclusive and `toBlock` exclusive; both refer to the creation receipt block. */
export type TrustedLaunchPolicy = { feePolicy: FeePolicy; treasury: Address; feeEngine: Address | null; fromBlock?: bigint; toBlock?: bigint };

type EngineManifest = { chainId: number; status: string; constants: { treasury: string };
  contracts: { engine: { address: string | null; blockNumber?: number | string } } };

// Treasuries replaced after launches used them. Append the retired address and
// its last receipt block here before changing PLATFORM_TREASURY; overwriting it
// would make every launch that paid the previous treasury unrecoverable.
const RETIRED_TREASURIES: Record<8453 | 4663, readonly { treasury: Address; toBlock: bigint }[]> = { 8453: [], 4663: [] };
/** The only fee engine deployment approved for new launches, trusted from its
 * creation block once deployed and verified. Before a later engine replaces
 * it, give this one a `toBlock` at the replacement's activation block so new
 * launches cannot keep routing fees to a retired engine. */
export const ENGINE_MANIFEST: EngineManifest = engineDeployment;

/** Recovery decides which fee routing is listed from this registry alone. A
 * caller's preview proves only that it encodes its own transaction; it can
 * never nominate a treasury or engine. Signing state is deliberately ignored
 * so verified historical launches stay recoverable after a pause or upgrade. */
export function trustedLaunchPolicies(config: RuntimeConfig, manifest: EngineManifest = ENGINE_MANIFEST): TrustedLaunchPolicy[] {
  const chainId = deploymentChain(config);
  const policies: TrustedLaunchPolicy[] = [];
  const add = (policy: TrustedLaunchPolicy) => {
    if (!policies.some((known) => known.feePolicy === policy.feePolicy && sameAddress(known.treasury, policy.treasury) &&
      (known.feeEngine === null ? policy.feeEngine === null : policy.feeEngine !== null && sameAddress(known.feeEngine, policy.feeEngine)) &&
      known.fromBlock === policy.fromBlock && known.toBlock === policy.toBlock)) policies.push(policy);
  };
  if (config.treasury) add({ feePolicy: FEE_POLICY, treasury: getAddress(config.treasury), feeEngine: null });
  for (const retired of RETIRED_TREASURIES[chainId]) add({ feePolicy: FEE_POLICY, treasury: retired.treasury, feeEngine: null, toBlock: retired.toBlock });
  if (chainId !== 4663 || manifest.chainId !== 4663) return policies;
  const treasury = getAddress(manifest.constants.treasury);
  // The operations treasury also receives the full platform share without an engine.
  add({ feePolicy: FEE_POLICY, treasury, feeEngine: null });
  const { address, blockNumber } = manifest.contracts.engine;
  if (manifest.status === "deployed_verified" && address)
    add({ feePolicy: ENGINE_FEE_POLICY, treasury, feeEngine: getAddress(address), ...(blockNumber !== undefined ? { fromBlock: BigInt(blockNumber) } : {}) });
  // Production engines are trusted only through the committed manifest. A
  // local fork deploys its own engine, configured by the operator.
  if (config.mode === "fork" && config.treasury && config.feeEngine)
    add({ feePolicy: ENGINE_FEE_POLICY, treasury: getAddress(config.treasury), feeEngine: getAddress(config.feeEngine) });
  return policies;
}

export function assertTrustedLaunchPolicy(plan: Pick<LaunchPlan, "feePolicy" | "feeTreasury" | "feeEngine">, config: RuntimeConfig,
  receiptBlock: bigint, policies = trustedLaunchPolicies(config)) {
  const engine = plan.feeEngine ?? null;
  const trusted = !!plan.feeTreasury && policies.some((policy) => policy.feePolicy === plan.feePolicy &&
    sameAddress(policy.treasury, plan.feeTreasury!) &&
    (policy.feeEngine === null ? engine === null : engine !== null && sameAddress(policy.feeEngine, engine)) &&
    (policy.fromBlock === undefined || receiptBlock >= policy.fromBlock) && (policy.toBlock === undefined || receiptBlock < policy.toBlock));
  if (!trusted) throw new Error("The recovered launch does not pay a platform-approved treasury and fee engine.");
}
