import { getAddress, type Address, type Hex } from "viem";
import engineDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { buybackGraphFingerprint } from "./buyback-activation";
import type { BuybackDeployment } from "./buyback-engine";
import { deploymentChain, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY, type FeePolicy } from "../src/lib/fee-policy";
import { LAUNCH_SIGNING_TTL, type LaunchPlan } from "../src/lib/launch-plan";

/** One fee routing the platform approved for new launches. `fromBlock` is
 * inclusive and `toBlock` exclusive; both refer to the creation receipt block. */
export type TrustedLaunchPolicy = { feePolicy: FeePolicy; treasury: Address; feeEngine: Address | null; fromBlock?: bigint; toBlock?: bigint;
  // Exclusive bound on the creation receipt's block timestamp, in seconds.
  toTimestamp?: bigint };

/** The fixed point from which Robinhood launches route platform fees through
 * the engine. scripts/record-engine-cutover.ts records it in the deployment
 * manifest once the engine is verified and activated on chain, bound to that
 * activated graph; prepare() and recovery both read it, and recovery checks
 * it is canonical. */
export type EngineLaunchCutover = { blockNumber: string; blockHash: Hex; timestamp: number; graphFingerprint: Hex };
type EngineManifest = { chainId: number; status: string; constants: { treasury: string };
  contracts: { engine: { address: string | null; blockNumber?: number | string } };
  activationVerification?: { status?: string; fingerprint?: string; activatedAtBlock?: string };
  engineLaunchCutover?: EngineLaunchCutover };

// A no-engine preview accepted just before the cutover can still be signed
// within its window and mined shortly after; allow modest clock skew too.
const CUTOVER_GRACE_SECONDS = BigInt(LAUNCH_SIGNING_TTL / 1000) + 60n;

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
      known.fromBlock === policy.fromBlock && known.toBlock === policy.toBlock && known.toTimestamp === policy.toTimestamp)) policies.push(policy);
  };
  // From the engine cutover, prepare() issues only engine launches on
  // Robinhood; a later treasury-only launch would bypass the buyback. Such
  // routing stays trusted for receipts up to the cutover plus the signing
  // window, never by a backup's own preparedAt.
  const cutover = engineLaunchCutover(config, manifest);
  const bound = cutover ? { toTimestamp: BigInt(cutover.timestamp) + CUTOVER_GRACE_SECONDS } : {};
  if (config.treasury) add({ feePolicy: FEE_POLICY, treasury: getAddress(config.treasury), feeEngine: null, ...bound });
  for (const retired of RETIRED_TREASURIES[chainId]) add({ feePolicy: FEE_POLICY, treasury: retired.treasury, feeEngine: null, toBlock: retired.toBlock, ...bound });
  if (chainId !== 4663 || manifest.chainId !== 4663) return policies;
  const treasury = getAddress(manifest.constants.treasury);
  // The operations treasury also received the full platform share without an engine.
  add({ feePolicy: FEE_POLICY, treasury, feeEngine: null, ...bound });
  const { address, blockNumber } = manifest.contracts.engine;
  if (manifest.status === "deployed_verified" && address)
    add({ feePolicy: ENGINE_FEE_POLICY, treasury, feeEngine: getAddress(address), ...(blockNumber !== undefined ? { fromBlock: BigInt(blockNumber) } : {}) });
  // Engines are trusted only through the committed manifest, in every mode:
  // an operator-configured address (even on a local fork) is never enough.
  return policies;
}

/** The engine cutover for this deployment chain, if one has been recorded. */
export function engineLaunchCutover(config: Pick<RuntimeConfig, "mode" | "deploymentChainId">, manifest: EngineManifest = ENGINE_MANIFEST) {
  return deploymentChain(config) === 4663 && manifest.chainId === 4663 ? assertEngineLaunchCutover(manifest) : undefined;
}

/** A recorded cutover is honoured only for the verified deployment whose
 * activation it was recorded after. Anything else (no verified activation, a
 * redeployed graph, a cutover before activation) fails closed: Robinhood
 * previews stop and treasury-only recoveries are refused until it is fixed. */
export function assertEngineLaunchCutover(manifest: EngineManifest): EngineLaunchCutover | undefined {
  const cutover = manifest.engineLaunchCutover;
  if (!cutover) return undefined;
  const activation = manifest.activationVerification;
  let graph: string | undefined;
  try { graph = buybackGraphFingerprint(manifest as unknown as BuybackDeployment).toLowerCase(); } catch { graph = undefined; }
  const block = typeof cutover.blockNumber === "string" && /^(?:0|[1-9]\d{0,19})$/.test(cutover.blockNumber) ? BigInt(cutover.blockNumber) : null;
  const activatedAt = typeof activation?.activatedAtBlock === "string" && /^(?:0|[1-9]\d{0,19})$/.test(activation.activatedAtBlock) ? BigInt(activation.activatedAtBlock) : null;
  if (manifest.status !== "deployed_verified" || !manifest.contracts.engine.address || !graph || activation?.status !== "verified" ||
    activation.fingerprint?.toLowerCase() !== graph || cutover.graphFingerprint?.toLowerCase() !== graph ||
    block === null || activatedAt === null || block < activatedAt || !/^0x[0-9a-fA-F]{64}$/.test(cutover.blockHash ?? "") ||
    !Number.isSafeInteger(cutover.timestamp) || cutover.timestamp <= 0)
    throw new Error("The recorded engine launch cutover does not belong to the verified, activated buyback deployment. Record it again with scripts/record-engine-cutover.ts.");
  return cutover;
}

export function assertTrustedLaunchPolicy(plan: Pick<LaunchPlan, "feePolicy" | "feeTreasury" | "feeEngine">, config: RuntimeConfig,
  receipt: { blockNumber: bigint; timestamp: bigint }, policies = trustedLaunchPolicies(config)) {
  const engine = plan.feeEngine ?? null;
  const trusted = !!plan.feeTreasury && policies.some((policy) => policy.feePolicy === plan.feePolicy &&
    sameAddress(policy.treasury, plan.feeTreasury!) &&
    (policy.feeEngine === null ? engine === null : engine !== null && sameAddress(policy.feeEngine, engine)) &&
    (policy.fromBlock === undefined || receipt.blockNumber >= policy.fromBlock) && (policy.toBlock === undefined || receipt.blockNumber < policy.toBlock) &&
    (policy.toTimestamp === undefined || receipt.timestamp < policy.toTimestamp));
  if (!trusted) throw new Error("The recovered launch does not pay a platform-approved treasury and fee engine.");
}
