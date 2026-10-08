import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";

// A preview's id is keccak256 of its exact creation calldata, which embeds the
// opening valuation, curve and fee routing. An attestation over the id proves
// the platform itself prepared that calldata, without a wallet signature.
const DOMAIN = "musegod.plan-attestation.v1";
export const PLAN_ATTESTATION_MIN_KEY_LENGTH = 32;

export function planAttestation(key: string, chainId: 8453 | 4663, planId: Hex): Hex {
  return `0x${createHmac("sha256", key).update(`${DOMAIN}:${chainId}:${planId.toLowerCase()}`).digest("hex")}`;
}

/** Accepts the current key and retained previous keys, so a rotation keeps
 * earlier backups verifiable. Malformed input is simply unattested. */
export function verifyPlanAttestation(keys: readonly string[], chainId: 8453 | 4663, planId: Hex, attestation: unknown): boolean {
  if (typeof attestation !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(attestation)) return false;
  const supplied = Buffer.from(attestation.slice(2), "hex");
  return keys.some((key) => timingSafeEqual(Buffer.from(planAttestation(key, chainId, planId).slice(2), "hex"), supplied));
}
