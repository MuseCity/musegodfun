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
  contracts: { engine: { address: string | null; blockNumber?: number | string } } };
export type EngineTrustWindow = { fromBlock?: bigint; toBlock?: bigint } | null;

// Treasuries replaced after launches used them. Append the retired address and
// its last receipt block here before changing PLATFORM_TREASURY; overwriting it
// would make every launch that paid the previous treasury unrecoverable.
const RETIRED_TREASURIES: Record<8453 | 4663, readonly { treasury: Address; toBlock: bigint }[]> = { 8453: [], 4663: [] };
// Each deployed engine's trust window over creation receipt blocks. `null`
// means the engine never served new launches, so no launch may route fees to
// it. V1 (buyback-deployment.json, creation block 81459143) was deployed but
// never activated for new pools (docs/SPEC.md). Before a later engine
// replaces the current one, record the current engine's `toBlock` here: the
// replacement's activation block. An engine without an entry is trusted from
// its manifest creation block, which only the newest deployment may rely on.
export const ENGINE_TRUST_WINDOWS: Readonly<Record<string, EngineTrustWindow>> = {
  "0x2f1fd06e3b6dd81123629d08a74a6279ea03797f": null,
};
export const ENGINE_MANIFESTS: readonly EngineManifest[] = [engineV1, engineV2];

/** Recovery decides which fee routing is listed from this registry alone. A
 * caller's preview proves only that it encodes its own transaction; it can
 * never nominate a treasury or engine. Signing state is deliberately ignored
 * so verified historical launches stay recoverable after a pause or upgrade. */
export function trustedLaunchPolicies(config: RuntimeConfig, manifests: readonly EngineManifest[] = ENGINE_MANIFESTS,
  windows: Readonly<Record<string, EngineTrustWindow>> = ENGINE_TRUST_WINDOWS): TrustedLaunchPolicy[] {
  const chainId = deploymentChain(config);
  const policies: TrustedLaunchPolicy[] = [];
  const add = (policy: TrustedLaunchPolicy) => {
    if (!policies.some((known) => known.feePolicy === policy.feePolicy && sameAddress(known.treasury, policy.treasury) &&
      (known.feeEngine === null ? policy.feeEngine === null : policy.feeEngine !== null && sameAddress(known.feeEngine, policy.feeEngine)) &&
      known.fromBlock === policy.fromBlock && known.toBlock === policy.toBlock)) policies.push(policy);
  };
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
    const engine = getAddress(address), key = engine.toLowerCase();
    const window = Object.hasOwn(windows, key) ? windows[key] : {};
    if (window === null) continue;
    const created = manifest.contracts.engine.blockNumber;
    const fromBlock = window.fromBlock ?? (created !== undefined ? BigInt(created) : undefined);
    add({ feePolicy: ENGINE_FEE_POLICY, treasury, feeEngine: engine,
      ...(fromBlock !== undefined ? { fromBlock } : {}), ...(window.toBlock !== undefined ? { toBlock: window.toBlock } : {}) });
  }
  // Production engines are trusted only through committed manifests and
  // windows. A local fork deploys its own engine, configured by the operator.
  if (config.mode === "fork" && config.treasury && config.feeEngine && windows[config.feeEngine.toLowerCase()] !== null)
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
