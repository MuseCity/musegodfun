import { keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import artifact from "../contracts/artifacts/MusegodLaunchGuard.json";
import legacyArtifact from "../contracts/artifacts/MusegodLaunchGuardLegacy.json";
import { BASE_BUNDLER_CODE_HASH, contractsFor, ROBINHOOD_BUNDLER, ROBINHOOD_BUNDLER_CODE_HASH, sameAddress } from "../src/lib/config";
import { launchGuardAbi } from "../src/lib/launch-guard";

const dependenciesAbi = parseAbi(["function airlock() view returns(address)", "function poolManager() view returns(address)"]);
const rehypeAbi = parseAbi(["function bundler() view returns(address)"]);
export type LaunchGuardVersion = "legacy" | "vesting";

export function chainLaunchDependencies(chainId: 8453 | 4663) {
  return {
    bundler: ROBINHOOD_BUNDLER,
    bundlerCodeHash: chainId === 4663 ? ROBINHOOD_BUNDLER_CODE_HASH : BASE_BUNDLER_CODE_HASH,
    contracts: contractsFor({ mode: chainId === 4663 ? "robinhood" : "base" }),
  };
}

export function expectedGuardRuntime(chainId: 8453 | 4663 = 4663, version: LaunchGuardVersion = "vesting"): Hex {
  const selected = version === "legacy" ? legacyArtifact : artifact;
  let code = selected.deployedBytecode.replace(/^0x/, "");
  const references = Object.values(selected.immutableReferences).flat();
  if (!references.length) throw new Error("The guard compiler artifact has no immutable references.");
  for (const reference of references) {
    if (reference.length !== 32) throw new Error("The guard immutable compiler layout changed.");
    const value = chainLaunchDependencies(chainId).bundler.slice(2).toLowerCase().padStart(reference.length * 2, "0");
    code = code.slice(0, reference.start * 2) + value + code.slice((reference.start + reference.length) * 2);
  }
  return `0x${code}`;
}

/** Nonempty code at the guard address is not either pinned runtime. Empty
 * code and dependency/read failures do not prove a fake guard. */
export class LaunchGuardMismatch extends Error {}
export function identifyGuardVersion(code: Hex | undefined, chainId: 8453 | 4663): LaunchGuardVersion | null {
  return code?.toLowerCase() === expectedGuardRuntime(chainId, "vesting").toLowerCase() ? "vesting"
    : code?.toLowerCase() === expectedGuardRuntime(chainId, "legacy").toLowerCase() ? "legacy" : null;
}

export async function verifyLaunchGuard(
  client: Pick<PublicClient, "getBlockNumber" | "getCode" | "readContract">,
  address: Address,
  chainId: 8453 | 4663 = 4663,
  requiredVersion?: LaunchGuardVersion,
) {
  const { bundler, bundlerCodeHash, contracts } = chainLaunchDependencies(chainId);
  const block = await client.getBlockNumber({ cacheTime: 0 });
  // Inspect the guard itself first: foreign nonempty code is sufficient
  // proof, even when its getters would revert. Missing code may be an
  // incomplete RPC view and must remain retryable.
  const guardCode = await client.getCode({ address, blockNumber: block });
  if (!guardCode || guardCode === "0x")
    throw new Error("The launch guard code is temporarily unavailable. Try again shortly.");
  const version = identifyGuardVersion(guardCode, chainId);
  if (!version)
    throw new LaunchGuardMismatch("The launch guard runtime or official dependencies do not match the pinned deployment.");
  if (requiredVersion && version !== requiredVersion)
    throw new Error("The pinned launch guard does not support the required version.");
  const [bundlerCode, boundBundler, airlock, poolManager, rehypeBundler] = await Promise.all([
    client.getCode({ address: bundler, blockNumber: block }),
    client.readContract({ address, abi: launchGuardAbi, functionName: "bundler", blockNumber: block }),
    client.readContract({ address: bundler, abi: dependenciesAbi, functionName: "airlock", blockNumber: block }),
    client.readContract({ address: bundler, abi: dependenciesAbi, functionName: "poolManager", blockNumber: block }),
    client.readContract({ address: contracts.rehype, abi: rehypeAbi, functionName: "bundler", blockNumber: block }),
  ]);
  if (!bundlerCode || keccak256(bundlerCode) !== bundlerCodeHash ||
      !sameAddress(boundBundler, bundler) || !sameAddress(airlock, contracts.airlock) ||
      !sameAddress(poolManager, contracts.poolManager) || !sameAddress(rehypeBundler, bundler))
    throw new Error("The launch guard official dependencies cannot be verified. Try again shortly.");
  return { address, blockNumber: String(block), runtimeHash: keccak256(guardCode!), bundler: boundBundler,
    version, supportsLock: version === "vesting" };
}
