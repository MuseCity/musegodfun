import { keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import artifact from "../contracts/artifacts/MusegodLaunchGuard.json";
import { ROBINHOOD_BUNDLER, ROBINHOOD_BUNDLER_CODE_HASH, ROBINHOOD_CONTRACTS, sameAddress } from "../src/lib/config";
import { launchGuardAbi } from "../src/lib/launch-guard";

const dependenciesAbi = parseAbi(["function airlock() view returns(address)", "function poolManager() view returns(address)"]);
const rehypeAbi = parseAbi(["function bundler() view returns(address)"]);

export function expectedGuardRuntime(): Hex {
  let code = artifact.deployedBytecode.replace(/^0x/, "");
  const references = Object.values(artifact.immutableReferences).flat();
  if (!references.length) throw new Error("The guard compiler artifact has no immutable references.");
  for (const reference of references) {
    if (reference.length !== 32) throw new Error("The guard immutable compiler layout changed.");
    const value = ROBINHOOD_BUNDLER.slice(2).toLowerCase().padStart(reference.length * 2, "0");
    code = code.slice(0, reference.start * 2) + value + code.slice((reference.start + reference.length) * 2);
  }
  return `0x${code}`;
}

export async function verifyLaunchGuard(client: Pick<PublicClient, "getBlockNumber" | "getCode" | "readContract">, address: Address) {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const [guardCode, bundlerCode, boundBundler, airlock, poolManager, rehypeBundler] = await Promise.all([
    client.getCode({ address, blockNumber: block }),
    client.getCode({ address: ROBINHOOD_BUNDLER, blockNumber: block }),
    client.readContract({ address, abi: launchGuardAbi, functionName: "bundler", blockNumber: block }),
    client.readContract({ address: ROBINHOOD_BUNDLER, abi: dependenciesAbi, functionName: "airlock", blockNumber: block }),
    client.readContract({ address: ROBINHOOD_BUNDLER, abi: dependenciesAbi, functionName: "poolManager", blockNumber: block }),
    client.readContract({ address: ROBINHOOD_CONTRACTS.rehype, abi: rehypeAbi, functionName: "bundler", blockNumber: block }),
  ]);
  if (!guardCode || guardCode.toLowerCase() !== expectedGuardRuntime().toLowerCase() ||
      !bundlerCode || keccak256(bundlerCode) !== ROBINHOOD_BUNDLER_CODE_HASH ||
      !sameAddress(boundBundler, ROBINHOOD_BUNDLER) || !sameAddress(airlock, ROBINHOOD_CONTRACTS.airlock) ||
      !sameAddress(poolManager, ROBINHOOD_CONTRACTS.poolManager) || !sameAddress(rehypeBundler, ROBINHOOD_BUNDLER))
    throw new Error("The launch guard runtime or official dependencies do not match the pinned deployment.");
  return { address, blockNumber: String(block), runtimeHash: keccak256(guardCode), bundler: boundBundler };
}
