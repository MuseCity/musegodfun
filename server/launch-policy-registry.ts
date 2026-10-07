import { getAddress, type Address } from "viem";
import engineV1 from "../contracts/artifacts/buyback-deployment.json";
import engineV2 from "../contracts/artifacts/buyback-v2-deployment.json";
import { deploymentChain, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY, type FeePolicy } from "../src/lib/fee-policy";
import type { LaunchPlan } from "../src/lib/launch-plan";

/** One fee routing the platform approved for new launches. `fromBlock` is
 * inclusive and `toBlock` exclusive; both refer to the creation receipt block. */
export type TrustedLaunchPolicy = { feePolicy: FeePolicy; treasury: Address; feeEngine: Address | null; fromBlock?: bigint; toBlock?: bigint };

type EngineManifest = { chainId: number; status: string; constants: { treasury: string };
  contracts: { engine: { address: string | null; blockNumber?: number } } };

// Treasuries replaced after launches used them. Append the retired address and
// its last receipt block here before changing PLATFORM_TREASURY; overwriting it
// would make every launch that paid the previous treasury unrecoverable.
const RETIRED_TREASURIES: Record<8453 | 4663, readonly { treasury: Address; toBlock: bigint }[]> = { 8453: [], 4663: [] };
// Engines cannot have received a launch's fees before their creation block
// (V1: docs/SPEC.md, transaction 0x44ced0…ba2a45). Later manifests carry it.
const ENGINE_CREATION_BLOCKS: Record<string, bigint> = { "0x2f1fd06e3b6dd81123629d08a74a6279ea03797f": 81_459_143n };

/** Recovery decides which fee routing is listed from this registry alone. A
 * caller's preview proves only that it encodes its own transaction; it can
 * never nominate a treasury or engine. Signing state is deliberately ignored
 * so verified historical launches stay recoverable after a pause or upgrade. */
export function trustedLaunchPolicies(config: RuntimeConfig, manifests: readonly EngineManifest[] = [engineV1, engineV2]): TrustedLaunchPolicy[] {
  const chainId = deploymentChain(config);
  const policies: TrustedLaunchPolicy[] = [];
  const add = (policy: TrustedLaunchPolicy) => {
    if (!policies.some((known) => known.feePolicy === policy.feePolicy && sameAddress(known.treasury, policy.treasury) &&
      (known.feeEngine === null ? policy.feeEngine === null : policy.feeEngine !== null && sameAddress(known.feeEngine, policy.feeEngine)) &&
      known.fromBlock === policy.fromBlock && known.toBlock === policy.toBlock)) policies.push(policy);
  };
  const engineFrom = (engine: Address) => ENGINE_CREATION_BLOCKS[engine.toLowerCase()];
  if (config.treasury) add({ feePolicy: FEE_POLICY, treasury: getAddress(config.treasury), feeEngine: null });
  for (const retired of RETIRED_TREASURIES[chainId]) add({ feePolicy: FEE_POLICY, treasury: retired.treasury, feeEngine: null, toBlock: retired.toBlock });
  if (chainId !== 4663) return policies;
  for (const manifest of manifests) {
    if (manifest.chainId !== 4663) continue;
    const treasury = getAddress(manifest.constants.treasury);
    // The operations treasury also received the full platform share before the engine existed.
    add({ feePolicy: FEE_POLICY, treasury, feeEngine: null });
    const address = manifest.contracts.engine.address;
    if (manifest.status !== "deployed_verified" || !address) continue;
    const engine = getAddress(address);
    const fromBlock = manifest.contracts.engine.blockNumber !== undefined ? BigInt(manifest.contracts.engine.blockNumber) : engineFrom(engine);
    add({ feePolicy: ENGINE_FEE_POLICY, treasury, feeEngine: engine, ...(fromBlock !== undefined ? { fromBlock } : {}) });
  }
  // The operator-configured engine is used for new launches only after the
  // service verifies its graph against this same treasury.
  if (config.treasury && config.feeEngine) {
    const engine = getAddress(config.feeEngine), fromBlock = engineFrom(engine);
    add({ feePolicy: ENGINE_FEE_POLICY, treasury: getAddress(config.treasury), feeEngine: engine, ...(fromBlock !== undefined ? { fromBlock } : {}) });
  }
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
