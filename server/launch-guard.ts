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

/** The guard at an address is not the pinned runtime, or its official
 * dependencies differ: not a transient read failure. */
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
  const [guardCode, bundlerCode, boundBundler, airlock, poolManager, rehypeBundler] = await Promise.all([
    client.getCode({ address, blockNumber: block }),
    client.getCode({ address: bundler, blockNumber: block }),
    client.readContract({ address, abi: launchGuardAbi, functionName: "bundler", blockNumber: block }),
    client.readContract({ address: bundler, abi: dependenciesAbi, functionName: "airlock", blockNumber: block }),
    client.readContract({ address: bundler, abi: dependenciesAbi, functionName: "poolManager", blockNumber: block }),
    client.readContract({ address: contracts.rehype, abi: rehypeAbi, functionName: "bundler", blockNumber: block }),
  ]);
  const version = identifyGuardVersion(guardCode, chainId);
  if (!version || (requiredVersion && version !== requiredVersion) ||
      !bundlerCode || keccak256(bundlerCode) !== bundlerCodeHash ||
      !sameAddress(boundBundler, bundler) || !sameAddress(airlock, contracts.airlock) ||
      !sameAddress(poolManager, contracts.poolManager) || !sameAddress(rehypeBundler, bundler))
    throw new LaunchGuardMismatch("The launch guard runtime or official dependencies do not match the pinned deployment.");
  return { address, blockNumber: String(block), runtimeHash: keccak256(guardCode!), bundler: boundBundler,
    version, supportsLock: version === "vesting" };
}
