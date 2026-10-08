import type { Address, Hex } from "viem";
import { buybackGraphFingerprint } from "../server/buyback-activation";
import type { BuybackDeployment } from "../server/buyback-engine";
import { ENGINE_MANIFEST } from "../server/launch-policy-registry";

const NODES = ["oracle", "swapper", "executor", "assetOracle", "vault", "engine", "forwarder"] as const;

/** A complete V2 graph with placeholder addresses, its engine created and the
 * graph activated at one block, optionally with a cutover bound to it. */
export function activatedEngineManifest(engine: Address, cutover?: { blockNumber: string; blockHash: Hex; timestamp: number }, activatedAtBlock = "94000000") {
  const contracts = Object.fromEntries(NODES.map((name, index) => [name, {
    address: name === "engine" ? engine : `0x${String(index + 1).repeat(40)}`,
    runtimeHash: `0x${String(index + 1).repeat(64)}`,
    ...(name === "engine" ? { blockNumber: activatedAtBlock } : {}),
  }])) as Record<(typeof NODES)[number], { address: Address; runtimeHash: Hex; blockNumber?: string }>;
  const manifest = { ...ENGINE_MANIFEST, status: "deployed_verified", contracts };
  const fingerprint = buybackGraphFingerprint(manifest as unknown as BuybackDeployment);
  return { ...manifest, activationVerification: { status: "verified", fingerprint, activatedAtBlock },
    ...(cutover ? { engineLaunchCutover: { ...cutover, graphFingerprint: fingerprint } } : {}) };
}
