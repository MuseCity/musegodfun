/** Owner review preparation and read-only verification. This file has no signer or broadcast API. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, encodeDeployData, getAddress, getContractAddress, http, keccak256, parseAbi, zeroAddress,
  type Abi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { loadEnvironment, mainnetRpcUrl, redact } from "../server/config";
import type { BaseCollectorCanaryAuthorization, BaseWalletAcceptance, BasePauseRollbackAcceptance, BaseNativeRunAcceptance } from "../server/base-collector";

export const BASE_COLLECTOR_FIXED = {
  initializer: getAddress("0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"), rehype: getAddress("0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215"),
  weth: getAddress("0x4200000000000000000000000000000000000006"), destinationWeth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  destinationTreasury: getAddress("0xb3C11Aa2148521A3ef6d446672b720A63a2D8349"), destinationVault: getAddress("0x28E6B43525301312084310F31f4C9c9873d7a125"),
} as const;
export type BaseCollectorDependency = { address: Address; runtimeHash: Hex | null;
  proxyImplementation: { address: Address; runtimeHash: Hex } | null; proxyCheck: "erc1967" | "direct" | "unresolved" };
export type BaseAutomationAccount = { address: Address | null; runtimeHash: Hex | null;
  factory: { address: Address; runtimeHash: Hex }; creation: { owner: Address; threshold: number; signers: { slot1: Hex; slot2: Hex }[]; salt: string } | null;
  implementation: { address: Address; runtimeHash: Hex } | null; owner: Address | null; ownerRuntimeHash?: Hex | null;
  threshold: number | null; signers: { index: number; slot1: Hex; slot2: Hex }[]; initializationHash: Hex | null; blockNumber: string | null };
export type BaseCollectorDeployment = {
  schemaVersion: 2; chainId: 8453; architecture: "splits-treasury-native-automation"; status: "not_deployed" | "deployed_verified";
  feePolicy: "creator-70-musegod-base-automation-v1";
  collector: { address: Address | null; runtimeHash: Hex | null; transactionHash: Hex | null; blockNumber: string | null };
  constants: { initializer: Address; rehype: Address; weth: Address; destinationWeth: Address; destinationTreasury: Address; destinationVault: Address;
    operationsTreasury: Address; governor: Address | null; automationReceiver: Address | null };
  automationAccount: BaseAutomationAccount;
  dependencies: Record<"initializer" | "rehype", BaseCollectorDependency>;
  nativeRule: { protocol: "splits-native-automation"; bridgeProvider: "relay"; sourceChainId: 8453; destinationChainId: 4663;
    outputToken: Address; recipient: Address; allocationBps: 10000; ruleId: string | null; configurationSha256: Hex | null };
  finalSettlement: { forwarder: Address; vault: Address; chainId: 4663; permissionsChanged: boolean };
  canaryAuthorization?: BaseCollectorCanaryAuthorization | null;
  activation: { status: "not_run" | "canary_verified"; nativeExecution?: unknown; nativeRunAcceptance?: BaseNativeRunAcceptance | null; walletAcceptance?: BaseWalletAcceptance | null;
    pauseRollbackAcceptance?: BasePauseRollbackAcceptance | null };
};
type Artifact = { abi: Abi; bytecode: Hex; deployedBytecode: Hex; compilerInputSha256: string; creationBytecodeHash: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]> };
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export async function loadBaseCollectorArtifact() {
  const directory = "contracts/artifacts/base-collector";
  const artifact = JSON.parse(await readFile(`${directory}/MusegodBaseFeeCollector.json`, "utf8")) as Artifact;
  const input = await readFile(`${directory}/MusegodBaseFeeCollector.compiler-input.json`, "utf8");
  assert.equal(sha256(input), artifact.compilerInputSha256, "Stale compiler input");
  assert.equal(keccak256(artifact.bytecode), artifact.creationBytecodeHash, "Stale creation bytecode");
  for (const [path, entry] of Object.entries((JSON.parse(input) as { sources: Record<string, { content: string }> }).sources)) {
    const file = resolve("contracts", path);
    assert(file.startsWith(resolve("contracts") + sep) && path.endsWith(".sol"), "Source escapes contract closure");
    assert.equal(await readFile(file, "utf8"), entry.content, `Stale source: ${path}`);
  }
  const lock = JSON.parse(await readFile("contracts/lib/openzeppelin-contracts/dependency-lock.json", "utf8")) as { version: string; files: Record<string, string> };
  assert.equal(lock.version, "5.7.0");
  for (const [path, hash] of Object.entries(lock.files)) assert.equal(sha256(await readFile(`contracts/lib/openzeppelin-contracts/${path}`, "utf8")), hash, `Unpinned dependency: ${path}`);
  return artifact;
}
/** Unsigned CREATE proposal; no nonce reservation, account initialization or transaction submission. */
export async function prepareBaseCollectorDeploymentSequence(manifest: BaseCollectorDeployment, deployer: Address, nonce: bigint) {
  assert(nonce >= 0n && nonce <= BigInt(Number.MAX_SAFE_INTEGER), "Invalid deployment nonce");
  const governor = manifest.constants.governor, receiver = manifest.constants.automationReceiver;
  assert(governor && receiver && governor !== zeroAddress && receiver !== zeroAddress && governor.toLowerCase() !== receiver.toLowerCase(), "Missing reviewed governor or dedicated Base native Automation receiver");
  assert.equal(manifest.automationAccount.address?.toLowerCase(), receiver.toLowerCase(), "Automation account binding differs");
  assert(manifest.automationAccount.runtimeHash && manifest.automationAccount.initializationHash && manifest.automationAccount.implementation, "The dedicated Base Automation must be initialized and reviewed first");
  const collector = getContractAddress({ from: deployer, nonce });
  if (manifest.collector.address) assert.equal(collector.toLowerCase(), manifest.collector.address.toLowerCase(), "Predicted Collector differs from reviewed binding");
  const artifact = await loadBaseCollectorArtifact();
  return { deployer, chainId: 8453, collector, automationReceiver: receiver,
    automationInitializationRequiredBeforeDeployment: true, initiallyPaused: true,
    transactions: [{ nonce: nonce.toString(), creates: collector, value: "0", data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
      args: [BASE_COLLECTOR_FIXED.initializer, BASE_COLLECTOR_FIXED.rehype, governor, receiver] }) }] };
}
export async function inspectBaseCollector(manifest: BaseCollectorDeployment, rpcUrl: string, verifyDeployed: boolean, deployer?: Address) {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }) });
  assert.equal(await client.getChainId(), 8453, "Wrong RPC chain");
  assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.chainId, 8453);
  assert.equal(manifest.architecture, "splits-treasury-native-automation"); assert.equal(manifest.feePolicy, "creator-70-musegod-base-automation-v1");
  for (const key of Object.keys(BASE_COLLECTOR_FIXED) as (keyof typeof BASE_COLLECTOR_FIXED)[])
    assert.equal(manifest.constants[key].toLowerCase(), BASE_COLLECTOR_FIXED[key].toLowerCase(), `Changed fixed constant: ${key}`);
  await loadBaseCollectorArtifact();
  const block = await client.getBlock({ blockTag: "finalized" });
  assert(block.number !== null && block.hash, "Missing finalized Base block");
  const observed: Record<string, BaseCollectorDependency> = {};
  for (const key of ["initializer", "rehype"] as const) {
    const address = BASE_COLLECTOR_FIXED[key], code = await client.getCode({ address, blockNumber: block.number });
    assert(code && code !== "0x", `Missing actual Base manager ${key}`);
    const slot = await client.getStorageAt({ address, slot: implementationSlot, blockNumber: block.number });
    let proxyImplementation: BaseCollectorDependency["proxyImplementation"] = null;
    if (slot && BigInt(slot) !== 0n) {
      const implementation = getAddress(`0x${slot.slice(-40)}`), code = await client.getCode({ address: implementation, blockNumber: block.number });
      assert(code && code !== "0x", `Missing ${key} implementation`); proxyImplementation = { address: implementation, runtimeHash: keccak256(code) };
    }
    observed[key] = { address, runtimeHash: keccak256(code), proxyImplementation, proxyCheck: proxyImplementation ? "erc1967" : "direct" };
    if (manifest.dependencies[key].runtimeHash) assert.deepEqual(manifest.dependencies[key], observed[key], `Changed reviewed ${key} dependency`);
  }
  const { verifyBaseAutomationAccount, verifyBaseCollector } = await import("../server/base-collector");
  let accountVerification: "not_initialized" | "verified" = "not_initialized";
  if (manifest.constants.automationReceiver) {
    assert.equal(manifest.automationAccount.address?.toLowerCase(), manifest.constants.automationReceiver.toLowerCase());
    // No code-only/counterfactual shortcut: requires initialization receipt, proxy implementation and complete live signer identities.
    await verifyBaseAutomationAccount(client, manifest, block.number); accountVerification = "verified";
  }
  let deploymentSequence: Awaited<ReturnType<typeof prepareBaseCollectorDeploymentSequence>> | null = null;
  if (deployer && accountVerification === "verified") deploymentSequence = await prepareBaseCollectorDeploymentSequence(manifest, deployer, BigInt(await client.getTransactionCount({ address: deployer, blockTag: "pending" })));
  let verifiedCollector = null;
  if (verifyDeployed) {
    assert(manifest.collector.address, "Collector is not deployed");
    verifiedCollector = await verifyBaseCollector(client, manifest.collector.address, { manifest, requireActivation: false });
  }
  assert.equal((await client.getBlock({ blockNumber: block.number })).hash, block.hash, "The preflight Base block reorganized");
  return { schemaVersion: 2, chainId: 8453, architecture: manifest.architecture, mode: verifyDeployed ? "verify" : "preflight", observedAt: new Date().toISOString(),
    finalizedBlockNumber: block.number.toString(), finalizedBlockHash: block.hash, dependencies: observed, automationAccountVerification: accountVerification,
    dedicatedBaseAutomationMissing: !manifest.constants.automationReceiver, nativeRuleConfigured: !!manifest.nativeRule.ruleId && !!manifest.nativeRule.configurationSha256,
    deploymentSequence, verifiedCollector, mainnetDeployment: "not_run", nativeCrossChainExecution: "not_run", publicBaseActivation: "not_run",
    ownerReviewRequired: ["dedicated Base native Automation initialization, owner, signers and implementation", "native 100% Relay rule to canonical Robinhood WETH and the existing Treasury",
      "immutable Collector constructor and source manager fingerprints", "deployment wallet and Base gas budget", "isolated origin, per-token actual-fee release budgets, and keeper gas authorization",
      "existing Robinhood Treasury finite Forwarder allowance and final keeper gas budget", "genuine fee native cross-chain closure, full journals/FIFO, desktop/mobile recovery and pause/rollback proof"],
    trustBoundary: "Collector immutable recipient and exact fee receipts do not make the native Automation account, parent owner or route providers immutable. Native rule changes remain owner-controlled." };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    loadEnvironment();
    const mode = process.argv[2]; assert(mode === "--preflight" || mode === "--verify", "Usage: tsx scripts/deploy-base-collector.ts --preflight|--verify [manifest.json] [deployer]. This script never signs or broadcasts.");
    const manifest = JSON.parse(await readFile(process.argv[3] || "contracts/artifacts/base-collector-deployment.json", "utf8")) as BaseCollectorDeployment;
    console.log(JSON.stringify(await inspectBaseCollector(manifest, mainnetRpcUrl(8453), mode === "--verify", process.argv[4] ? getAddress(process.argv[4]) : undefined),
      (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
  } catch (error) { console.error(redact(error)); process.exitCode = 1; }
}
