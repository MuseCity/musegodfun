import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256,
  parseAbi, type Abi, type Address, type Hex } from "viem";
import { ROBINHOOD_CONTRACTS, sameAddress } from "../src/lib/config";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";

// This script intentionally has no production broadcast mode or private-key input.
const OFFICIAL_BUNDLER = getAddress("0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c");
const BUNDLER_CODE_HASH = "0x8d7c135bd087b74d2f2d1362593f23b824d5752bebe6a3c8bc6db0a6fa75e066";
const bindingsAbi = parseAbi([
  "function airlock() view returns (address)", "function poolManager() view returns (address)",
  "function bundler() view returns (address)",
]);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; ++i) {
  assert(["--rpc", "--output", "--deploy-local"].includes(args[i]), `Unknown argument: ${args[i]}`);
  if (args[i] !== "--deploy-local") assert(args[++i], "Missing argument value");
}
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
loadEnvironment();
try {
const rpcUrl = option("--rpc") || runtimeFromEnv().rpcUrl;
const deployLocal = args.includes("--deploy-local");
const url = new URL(rpcUrl);
if (deployLocal) assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  && url.protocol === "http:", "Local deployment requires a loopback HTTP Anvil RPC");
const transport = http(rpcUrl, { timeout: 40_000, retryCount: 0 });
const client = createPublicClient({ transport });
const chainId = await client.getChainId();
assert.equal(chainId, deployLocal ? 31337 : 4663,
  "Default verification is Robinhood Chain; local deployment requires isolated chain 31337");
const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
const block = await client.getBlock({ blockNumber });
const bundlerCode = await client.getCode({ address: OFFICIAL_BUNDLER, blockNumber });
assert(bundlerCode && bundlerCode !== "0x", "Official Bundler is not deployed");
assert.equal(keccak256(bundlerCode), BUNDLER_CODE_HASH, "Official Bundler runtime changed; review before any deployment");
const [airlock, poolManager] = await Promise.all([
  client.readContract({ address: OFFICIAL_BUNDLER, abi: bindingsAbi, functionName: "airlock", blockNumber }),
  client.readContract({ address: OFFICIAL_BUNDLER, abi: bindingsAbi, functionName: "poolManager", blockNumber }),
]);
assert(sameAddress(airlock, ROBINHOOD_CONTRACTS.airlock), "Bundler Airlock mismatch");
assert(sameAddress(poolManager, ROBINHOOD_CONTRACTS.poolManager), "Bundler PoolManager mismatch");
const dependencies = [];
for (const [name, address] of Object.entries({ bundler: OFFICIAL_BUNDLER, airlock, poolManager })) {
  const code = await client.getCode({ address, blockNumber });
  assert(code && code !== "0x", `${name} is missing code`);
  dependencies.push({ name, address, runtimeBytes: (code.length - 2) / 2, runtimeHash: keccak256(code) });
}
const artifact = JSON.parse(await readFile(new URL("../contracts/artifacts/MusegodLaunchGuard.json", import.meta.url), "utf8")) as {
  abi: Abi; bytecode: Hex; deployedBytecode: Hex; compilerInputSha256: string;
  immutableReferences: Record<string, { start: number; length: number }[]>;
};
const evidence: Record<string, unknown> = { chainId, blockNumber: blockNumber.toString(),
  blockHash: block.hash, blockTimestamp: block.timestamp.toString(), dependencies,
  compilerInputSha256: artifact.compilerInputSha256, productionDeployment: "not_run",
  localDeployment: "not_run" };
if (deployLocal) {
  const nodeInfo = await (client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<unknown>)(
    { method: "anvil_nodeInfo", params: [] });
  assert(nodeInfo && typeof nodeInfo === "object", "Local node must expose Anvil identity");
  const localChain = defineChain({ id: 31337, name: "Isolated Robinhood fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const wallet = createWalletClient({ chain: localChain, transport });
  const [account] = await wallet.getAddresses();
  assert(account, "Local Anvil must expose an unlocked test account");
  const transactionHash = await wallet.deployContract({ account, abi: artifact.abi,
    bytecode: artifact.bytecode, args: [OFFICIAL_BUNDLER] });
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });
  assert.equal(receipt.status, "success");
  const guardAddress = receipt.contractAddress as Address;
  assert(guardAddress, "Local deployment did not return an address");
  const actualCode = await client.getCode({ address: guardAddress, blockNumber: receipt.blockNumber });
  let expectedCode = artifact.deployedBytecode.slice(2);
  const encodedBundler = OFFICIAL_BUNDLER.slice(2).toLowerCase().padStart(64, "0");
  for (const references of Object.values(artifact.immutableReferences)) for (const ref of references) {
    assert.equal(ref.length, 32);
    expectedCode = expectedCode.slice(0, ref.start * 2) + encodedBundler + expectedCode.slice((ref.start + ref.length) * 2);
  }
  assert.equal(actualCode?.toLowerCase(), "0x" + expectedCode.toLowerCase(), "Guard runtime does not match compiler output and immutable Bundler");
  assert(sameAddress(await client.readContract({ address: guardAddress, abi: bindingsAbi,
    functionName: "bundler", blockNumber: receipt.blockNumber }), OFFICIAL_BUNDLER));
  evidence.localDeployment = { guardAddress, deployer: account, transactionHash,
    blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
    runtimeHash: keccak256(actualCode!), runtimeVerified: true, bundlerVerified: true };
}
const json = JSON.stringify(evidence, null, 2) + "\n";
if (option("--output")) await writeFile(option("--output")!, json);
console.log(json);
} catch (error) {
  console.error(redact(error));
  process.exitCode = 1;
}
