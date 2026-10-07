import { getAddress, type Address } from "viem";
import engineDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { deploymentChain, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY, type FeePolicy } from "../src/lib/fee-policy";
import type { LaunchPlan } from "../src/lib/launch-plan";

/** One fee routing the platform approved for new launches. `fromBlock` is
 * inclusive and `toBlock` exclusive; both refer to the creation receipt block. */
export type TrustedLaunchPolicy = { feePolicy: FeePolicy; treasury: Address; feeEngine: Address | null; fromBlock?: bigint; toBlock?: bigint };

type EngineManifest = { chainId: number; status: string; constants: { treasury: string };
  contracts: { engine: { address: string | null; blockNumber?: number | string } };
  activationVerification?: { status?: string; activatedAtBlock?: string } };

// Treasuries replaced after launches used them. Before changing
// PLATFORM_TREASURY, append the retired address with its exclusive `toBlock`:
// the first block from which it is no longer accepted, i.e. one past the last
// creation receipt that paid it. Overwriting it instead would make every
// launch that paid the previous treasury unrecoverable.
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
  // Once the Robinhood engine is activated, prepare() issues only engine
  // launches; a later no-engine launch would bypass the buyback, so treasury-
  // only routing is trusted only for receipts before the activation block.
  // (A no-engine launch signed after activation but before the service
  // switched to engine launches still registers through its saved preview.)
  const verified = manifest.activationVerification;
  const activated = chainId === 4663 && manifest.chainId === 4663 && verified?.status === "verified" && verified.activatedAtBlock
    ? BigInt(verified.activatedAtBlock) : undefined;
  const beforeActivation = (toBlock?: bigint) => {
    const limit = toBlock === undefined ? activated : activated === undefined || toBlock < activated ? toBlock : activated;
    return limit === undefined ? {} : { toBlock: limit };
  };
  if (config.treasury) add({ feePolicy: FEE_POLICY, treasury: getAddress(config.treasury), feeEngine: null, ...beforeActivation() });
  for (const retired of RETIRED_TREASURIES[chainId]) add({ feePolicy: FEE_POLICY, treasury: retired.treasury, feeEngine: null, ...beforeActivation(retired.toBlock) });
  if (chainId !== 4663 || manifest.chainId !== 4663) return policies;
  const treasury = getAddress(manifest.constants.treasury);
  // The operations treasury also received the full platform share without an engine.
  add({ feePolicy: FEE_POLICY, treasury, feeEngine: null, ...beforeActivation() });
  const { address, blockNumber } = manifest.contracts.engine;
  if (manifest.status === "deployed_verified" && address)
    add({ feePolicy: ENGINE_FEE_POLICY, treasury, feeEngine: getAddress(address), ...(blockNumber !== undefined ? { fromBlock: BigInt(blockNumber) } : {}) });
  // Engines are trusted only through the committed manifest, in every mode:
  // an operator-configured address (even on a local fork) is never enough.
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
