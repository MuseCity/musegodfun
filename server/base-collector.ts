import { bytesToHex, decodeEventLog, encodeDeployData, getAddress, hexToBytes, keccak256, padHex, parseAbi, stringToHex, zeroAddress,
  type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt, type Transport } from "viem";
import manifestData from "../contracts/artifacts/base-collector-deployment.json";
import collectorArtifact from "../contracts/artifacts/base-collector/MusegodBaseFeeCollector.json";
import { CONTRACTS, sameAddress } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { verifyGovernorSignature } from "./buyback-activation";
import { verifyFeeEngineRuntime } from "./buyback-engine";
import { baseActivationAcceptanceReady } from "./base-activation-record";
import { contractIdentityOnce, type ContractIdentityStore } from "./contract-identity";
import robinhoodDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { BUYBACK_CODE_HASHES, RELAY_ROUTER } from "./buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import type { BaseCollectorDeployment, BaseCollectorDependency } from "../scripts/deploy-base-collector";
import type { LaunchPlan } from "../src/lib/launch-plan";
export type BaseCollectorManifest = BaseCollectorDeployment;
export const BASE_COLLECTOR_MANIFEST = manifestData as unknown as BaseCollectorManifest;
export type BaseCollectorClient = Pick<PublicClient<Transport, any>, "getChainId" | "getBlockNumber" | "getBlock" | "getCode" | "getStorageAt" | "readContract" |
  "getTransaction" | "getTransactionReceipt" | "getLogs" | "request" | "multicall">;
export type BaseCollectorCanaryAuthorization = { version: 2; chainId: 8453; origin: string; collector: Address; automationReceiver: Address;
  graphFingerprint: Hex; keeper: Address; releaseBudgets: { token: Address; decimals: number; maxAmount: string }[];
  maxBaseGasWei: string; maxRobinhoodGasWei: string; expiresAt: string; signer: Address; signature: Hex };
/** Owner accepts the native provider and exact project wiring; this is not a claim that any fee or burn has occurred. */
export type BaseTrustedSplitsAcceptance = { version: 1; sourceChainId: 8453; destinationChainId: 4663; graphFingerprint: Hex;
  collector: Address; automationReceiver: Address; destinationTreasury: Address; destinationWeth: Address; destinationVault: Address;
  keeper: Address; ruleId: string; configurationSha256: Hex; trustSplitsNativeExecution: true; signer: Address; signature: Hex };
export type BaseWalletFlowProof = { creator: Address; token: Address; quoteAsset: Address; poolId: Hex; launchHash: Hex; firstBuyHash: Hex;
  buyHash: Hex; sellHash: Hex; feeClaimHashes: Hex[]; recoveryEvidenceUri: string; recoveryEvidenceSha256: Hex; plan: LaunchPlan };
export type BaseWalletAcceptance = { version: 1; chainId: 8453; graphFingerprint: Hex; desktop: BaseWalletFlowProof; mobile: BaseWalletFlowProof; signer: Address; signature: Hex };
export type BaseNativeRunAcceptance = { version: 1; graphFingerprint: Hex; sourceHash: Hex; destinationHash: Hex;
  nativeExecutionSha256: Hex; jobId: string; evidenceUri: string; evidenceSha256: Hex; signer: Address; signature: Hex };
export type BasePauseRollbackAcceptance = { version: 1; graphFingerprint: Hex; pauseHash: Hex; resumeHash: Hex;
  evidenceUri: string; evidenceSha256: Hex; signer: Address; signature: Hex };
export type VerifiedBaseCollector = { collector: Address; paused: boolean; automationReceiver: Address; runtimeHash: Hex;
  manifestFingerprint: Hex; initialDeploymentBlock: bigint; canaryAuthorization?: BaseCollectorCanaryAuthorization;
  currentSettlementGraph?: { vault: Address; weth: Address; swapper: Address; engineForwarders: Address[] } };
export const BASE_SPLITS_FACTORY = getAddress("0x8E6Af8Ed94E87B4402D0272C5D6b0D47F0483e7C");
export const BASE_SPLITS_IMPLEMENTATION = getAddress("0x15ec0Fa66A0D96a64d67C58368641fBE9325F3FA");
export const BASE_SPLITS_FACTORY_HASH = "0x7320f2779f3b27b8dac66bdbfd7063345cee66aca9aa2d56f1b46ba5a9dcab05" as Hex;
export const BASE_SPLITS_IMPLEMENTATION_HASH = "0x8d790f1df78f070d2202718db467e6ee141274c7010372d93dc27d183bc1e446" as Hex;
export const BASE_SPLITS_PROXY_HASH = "0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d" as Hex;
/** Official SmartVault Signer.sol: slot2=0 is an address signer (EOA or ERC-1271); nonzero is a P256/WebAuthn key. */
export function baseSplitsSignerAuthority(signer: { slot1: Hex; slot2: Hex }): { kind: "account"; address: Address } | { kind: "passkey"; x: Hex; y: Hex } {
  if (!/^0x[\da-f]{64}$/i.test(signer.slot1) || !/^0x[\da-f]{64}$/i.test(signer.slot2)) throw new Error("Unknown Splits signer authority encoding");
  const x = BigInt(signer.slot1), y = BigInt(signer.slot2);
  if (y === 0n) {
    if (x === 0n || x >= 2n ** 160n) throw new Error("Unknown Splits account signer authority");
    return { kind: "account", address: getAddress(`0x${signer.slot1.slice(-40)}`) };
  }
  const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  if (x >= p || y >= p || (y * y - x * x * x + 3n * x - b) % p !== 0n) throw new Error("Unknown or invalid Splits P256 signer authority");
  return { kind: "passkey", x: signer.slot1, y: signer.slot2 };
}
const factoryAbi = parseAbi(["function IMPLEMENTATION() view returns(address)",
  "function getAddress(address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt) view returns(address)",
  "event SmartVaultCreated(address indexed smartVault,address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt)"]);
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const abi = collectorArtifact.abi as Abi;
const accountAbi = parseAbi(["function owner() view returns(address)", "function getThreshold() view returns(uint8)",
  "function getSignerCount() view returns(uint8)", "function getSigner(uint8) view returns((bytes32 slot1,bytes32 slot2))",
  "function isModuleEnabled(address module) view returns(bool)", "event EnabledModule(address indexed module)",
  "event InitializedSigners((bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold)",
  "function FACTORY() view returns(address)", "function getImplementation() view returns(address)", "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)"]);
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const amount = (value: unknown, allowZero = false): bigint => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n || !allowZero && BigInt(value) === 0n)
    throw new Error("Base Automation evidence requires an exact finite raw amount");
  return BigInt(value);
};
const fixed = { initializer: CONTRACTS.initializer, rehype: CONTRACTS.rehype,
  weth: getAddress("0x4200000000000000000000000000000000000006"), destinationWeth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  destinationTreasury: getAddress("0xb3C11Aa2148521A3ef6d446672b720A63a2D8349"), destinationVault: getAddress("0x28E6B43525301312084310F31f4C9c9873d7a125") };

function reviewedManifest(manifest: BaseCollectorManifest, candidate: Address) {
  if (!manifest || manifest.schemaVersion !== 2 || manifest.chainId !== 8453 || manifest.architecture !== "splits-treasury-native-automation" ||
    manifest.status !== "deployed_verified" || manifest.feePolicy !== BASE_AUTOMATION_FEE_POLICY || !manifest.collector?.address ||
    !sameAddress(manifest.collector.address, candidate) || !hash(manifest.collector.runtimeHash) || !hash(manifest.collector.transactionHash) || !manifest.collector.blockNumber)
    throw new Error("The native Base Collector deployment has not been verified");
  amount(manifest.collector.blockNumber, true);
  for (const [name, expected] of Object.entries(fixed))
    if (!sameAddress(String(manifest.constants?.[name as keyof typeof fixed] ?? ""), expected)) throw new Error(`The fixed Base Automation ${name} changed`);
  const c = manifest.constants, account = manifest.automationAccount;
  if (!c.governor || sameAddress(c.governor, zeroAddress) || !c.operationsTreasury || sameAddress(c.operationsTreasury, zeroAddress) ||
    !c.automationReceiver || !account?.address || !sameAddress(account.address, c.automationReceiver) ||
    new Set([candidate, c.automationReceiver, c.governor].map(value => value.toLowerCase())).size !== 3)
    throw new Error("The fixed Base Automation receiver and governor are not reviewed");
  for (const name of ["initializer", "rehype"] as const) {
    const dependency = manifest.dependencies[name];
    if (!dependency || !sameAddress(dependency.address, fixed[name]) || !hash(dependency.runtimeHash) || dependency.proxyCheck === "unresolved")
      throw new Error("The Base manager dependency graph is incomplete");
  }
  reviewedAccount(account);
  const rule = manifest.nativeRule;
  if (!rule || rule.protocol !== "splits-native-automation" || rule.bridgeProvider !== "relay" || rule.sourceChainId !== 8453 || rule.destinationChainId !== 4663 ||
    rule.allocationBps !== 10000 || !sameAddress(rule.outputToken, fixed.destinationWeth) || !sameAddress(rule.recipient, fixed.destinationTreasury) ||
    manifest.finalSettlement.chainId !== 4663 || !sameAddress(manifest.finalSettlement.forwarder, "0x808d538f13ce0356E80C7a5ac2798d09206aB8f4") ||
    !sameAddress(manifest.finalSettlement.vault, fixed.destinationVault)) throw new Error("The native Automation route or final settlement graph changed");
}
function reviewedAccount(account: BaseCollectorDeployment["automationAccount"]) {
  if (!account.address || !hash(account.runtimeHash) || !account.implementation || !hash(account.implementation.runtimeHash) ||
    sameAddress(account.implementation.address, zeroAddress) || !account.owner || sameAddress(account.owner, zeroAddress) ||
    !hash(account.initializationHash) || !account.blockNumber || !Number.isInteger(account.threshold) || account.threshold! < 1 ||
    account.threshold! > account.signers.length || !account.signers.length || account.signers.length > 256 ||
    new Set(account.signers.map(signer => signer.index)).size !== account.signers.length ||
    account.signers.some(signer => !Number.isInteger(signer.index) || signer.index < 0 || signer.index > 255 || !hash(signer.slot1) || !hash(signer.slot2) ||
      BigInt(signer.slot1) === 0n && BigInt(signer.slot2) === 0n)) throw new Error("The initialized Splits native Automation account graph is incomplete");
  amount(account.blockNumber, true);
  const creation = account.creation;
  if (!account.factory || !sameAddress(account.factory.address, BASE_SPLITS_FACTORY) || account.factory.runtimeHash !== BASE_SPLITS_FACTORY_HASH ||
    !sameAddress(account.implementation.address, BASE_SPLITS_IMPLEMENTATION) || account.implementation.runtimeHash !== BASE_SPLITS_IMPLEMENTATION_HASH ||
    account.runtimeHash !== BASE_SPLITS_PROXY_HASH || !creation || !creation.owner || sameAddress(creation.owner, zeroAddress) ||
    !Array.isArray(creation.signers) || creation.signers.length === 0 || creation.signers.length > 256 ||
    !Number.isInteger(creation.threshold) || creation.threshold < 1 || creation.threshold > creation.signers.length ||
    creation.signers.some(signer => !hash(signer.slot1) || !hash(signer.slot2) || BigInt(signer.slot1) === 0n && BigInt(signer.slot2) === 0n) ||
    new Set(creation.signers.map(signer => `${signer.slot1.toLowerCase()}:${signer.slot2.toLowerCase()}`)).size !== creation.signers.length)
    throw new Error("The official Base Splits factory, implementation or original creation identity is not reviewed");
  amount(creation.salt, true);
}
export function baseCollectorGraphFingerprint(manifest: BaseCollectorManifest): Hex {
  if (!manifest.collector.address) throw new Error("The native Base graph is incomplete");
  reviewedManifest(manifest, manifest.collector.address);
  const c = manifest.constants, account = manifest.automationAccount;
  return keccak256(stringToHex(JSON.stringify(["musegod-base-native-automation-v1", manifest.feePolicy,
    [manifest.collector.address.toLowerCase(), manifest.collector.runtimeHash, manifest.collector.transactionHash, manifest.collector.blockNumber],
    // This locale ordering participates in an already signed fingerprint/binding;
    // do not replace it with code-point sorting.
    Object.entries(c).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value?.toLowerCase()]),
    ["initializer", "rehype"].map(key => { const entry = manifest.dependencies[key as "initializer" | "rehype"]; return [key, entry.address.toLowerCase(), entry.runtimeHash, entry.proxyCheck,
      entry.proxyImplementation && [entry.proxyImplementation.address.toLowerCase(), entry.proxyImplementation.runtimeHash]]; }),
    [account.address!.toLowerCase(), account.runtimeHash, account.implementation!.address.toLowerCase(), account.implementation!.runtimeHash,
      account.owner!.toLowerCase(), account.ownerRuntimeHash ?? null, account.threshold,
      account.factory.address.toLowerCase(), account.factory.runtimeHash, [account.creation!.owner.toLowerCase(), account.creation!.threshold, account.creation!.salt, account.creation!.signers.map(signer => [signer.slot1.toLowerCase(), signer.slot2.toLowerCase()])], [...account.signers].sort((a, b) => a.index - b.index).map(signer => [signer.index, signer.slot1, signer.slot2]), account.initializationHash, account.blockNumber],
    [manifest.nativeRule.protocol, manifest.nativeRule.bridgeProvider, 8453, 4663, manifest.nativeRule.outputToken.toLowerCase(), manifest.nativeRule.recipient.toLowerCase(),
      10000, manifest.nativeRule.ruleId, manifest.nativeRule.configurationSha256],
    [manifest.finalSettlement.forwarder.toLowerCase(), manifest.finalSettlement.vault.toLowerCase()], { lpShare: "228000000000000000", hookShare: "240000000000000000" }])));
}
export function baseCollectorExpectedRuntime(manifest: Pick<BaseCollectorManifest, "constants" | "dependencies" | "automationAccount">): Hex {
  const bindings: Record<string, Hex> = { initializer: padHex(manifest.constants.initializer, { size: 32 }), rehype: padHex(manifest.constants.rehype, { size: 32 }),
    governor: padHex(manifest.constants.governor!, { size: 32 }), automationReceiver: padHex(manifest.constants.automationReceiver!, { size: 32 }),
    initializerCodeHash: manifest.dependencies.initializer.runtimeHash!, rehypeCodeHash: manifest.dependencies.rehype.runtimeHash!, automationReceiverCodeHash: manifest.automationAccount.runtimeHash! };
  const bytes = hexToBytes(collectorArtifact.deployedBytecode as Hex);
  for (const [id, ranges] of Object.entries(collectorArtifact.immutableReferences)) {
    const binding = (collectorArtifact.immutableASTbindings as Record<string, { name: string }>)[id], value = binding && bindings[binding.name];
    if (!value) throw new Error("Unknown Base native Collector immutable binding");
    for (const range of ranges) { if (range.length !== 32) throw new Error("Invalid immutable width"); bytes.set(hexToBytes(value), range.start); }
  }
  return bytesToHex(bytes);
}
async function verifyDependency(client: BaseCollectorClient, entry: BaseCollectorDependency, blockNumber: bigint, label: string) {
  const code = await client.getCode({ address: entry.address, blockNumber });
  if (!code || code === "0x" || keccak256(code) !== entry.runtimeHash) throw new Error(`${label} runtime changed`);
  const slot = await client.getStorageAt({ address: entry.address, slot: implementationSlot, blockNumber });
  if (entry.proxyCheck === "direct") {
    if (slot && BigInt(slot) !== 0n || entry.proxyImplementation) throw new Error(`${label} has an unreviewed proxy implementation`);
  } else if (entry.proxyCheck === "erc1967") {
    const implementation = entry.proxyImplementation;
    if (!implementation || !hash(implementation.runtimeHash) || !slot || BigInt(slot) === 0n || !sameAddress(`0x${slot.slice(-40)}`, implementation.address))
      throw new Error(`${label} proxy implementation changed`);
    const implementationCode = await client.getCode({ address: implementation.address, blockNumber });
    if (!implementationCode || implementationCode === "0x" || keccak256(implementationCode) !== implementation.runtimeHash) throw new Error(`${label} implementation runtime changed`);
  } else throw new Error(`${label} proxy graph is unresolved`);
}
export async function baseCollectorCanonicalReceipt(client: BaseCollectorClient, transactionHash: Hex, head: bigint): Promise<TransactionReceipt> {
  if (!hash(transactionHash)) throw new Error("Missing canonical Base receipt hash");
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || !receipt.blockHash || receipt.blockNumber + 64n > head ||
    (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error("The Base evidence receipt is not canonical and confirmed");
  return receipt;
}
const canonicalReceipt = baseCollectorCanonicalReceipt;
function events(receipt: TransactionReceipt, address: Address, eventAbi: Abi) {
  const found: { eventName: string; args: Record<string, unknown>; logIndex: number }[] = [];
  for (const log of receipt.logs) if (sameAddress(log.address, address)) {
    try { const decoded = decodeEventLog({ abi: eventAbi, topics: log.topics, data: log.data, strict: true }); found.push({ eventName: decoded.eventName!, args: decoded.args as unknown as Record<string, unknown>, logIndex: log.logIndex }); } catch { }
  }
  return found;
}
export async function verifyBaseAutomationAccount(client: BaseCollectorClient, manifest: BaseCollectorManifest, head: bigint, _auditStore?: ContractIdentityStore, verifyInitialization = true) {
  const account = manifest.automationAccount;
  reviewedAccount(account);
  const creation = account.creation!;
  const read = <T>(functionName: string, args?: readonly unknown[], blockNumber = head) => client.readContract({ address: account.address!, abi: accountAbi as Abi, functionName, args, blockNumber }) as Promise<T>;
  const readFactory = <T>(functionName: string, args?: readonly unknown[], blockNumber = head) => client.readContract({ address: BASE_SPLITS_FACTORY, abi: factoryAbi as Abi, functionName, args, blockNumber }) as Promise<T>;
  const initialBlock = BigInt(account.blockNumber!);
  // Check provenance at both the original initialization and the current head.
  // Factory receipt plus official CREATE2 prediction supports EntryPoint/internal creation without trusting a caller-supplied trace.
  for (const blockNumber of [...new Set(verifyInitialization ? [initialBlock, head] : [head])]) {
    const factoryCode = await client.getCode({ address: BASE_SPLITS_FACTORY, blockNumber });
    if (!factoryCode || factoryCode === "0x" || keccak256(factoryCode) !== BASE_SPLITS_FACTORY_HASH ||
      !sameAddress(await readFactory<Address>("IMPLEMENTATION", undefined, blockNumber), BASE_SPLITS_IMPLEMENTATION))
      throw new Error("The official Base Splits factory runtime or implementation changed");
    await verifyDependency(client, { address: account.address!, runtimeHash: BASE_SPLITS_PROXY_HASH,
      proxyImplementation: { address: BASE_SPLITS_IMPLEMENTATION, runtimeHash: BASE_SPLITS_IMPLEMENTATION_HASH }, proxyCheck: "erc1967" }, blockNumber, "Splits native Automation");
    const [factory, implementation] = await Promise.all([read<Address>("FACTORY", undefined, blockNumber), read<Address>("getImplementation", undefined, blockNumber)]);
    if (!sameAddress(factory, BASE_SPLITS_FACTORY) || !sameAddress(implementation, BASE_SPLITS_IMPLEMENTATION)) throw new Error("The account is not bound to the official Base Splits deployment");
  }
  if (verifyInitialization) {
    const predicted = await readFactory<Address>("getAddress", [creation.owner, creation.signers, creation.threshold, BigInt(creation.salt)], initialBlock);
    if (!sameAddress(predicted, account.address!)) throw new Error("The native Automation address differs from the official CREATE2 creation prediction");
  }
  const [owner, threshold, count] = await Promise.all([read<Address>("owner"), read<number>("getThreshold"), read<number>("getSignerCount")]);
  if (!sameAddress(owner, account.owner!) || threshold !== account.threshold || count !== account.signers.length) throw new Error("The Splits native Automation owner or signer threshold changed");
  await Promise.all(account.signers.map(async signer => {
    const value = await read<{ slot1: Hex; slot2: Hex }>("getSigner", [signer.index]);
    if (value.slot1.toLowerCase() !== signer.slot1.toLowerCase() || value.slot2.toLowerCase() !== signer.slot2.toLowerCase()) throw new Error("The native Automation signer changed");
  }));
  if (account.ownerRuntimeHash) {
    const ownerCode = await client.getCode({ address: account.owner!, blockNumber: head });
    if (!ownerCode || ownerCode === "0x" || keccak256(ownerCode) !== account.ownerRuntimeHash) throw new Error("The reviewed Automation owner runtime changed");
  }
  if (verifyInitialization) {
  const receipt = await canonicalReceipt(client, account.initializationHash!, head);
  const initialization = events(receipt, account.address!, accountAbi).filter(event => event.eventName === "InitializedSigners");
  const factories = events(receipt, BASE_SPLITS_FACTORY, factoryAbi).filter(event => event.eventName === "SmartVaultCreated" && sameAddress(String(event.args.smartVault), account.address!));
  const ownership = events(receipt, account.address!, accountAbi).filter(event => event.eventName === "OwnershipTransferred" && sameAddress(String(event.args.previousOwner), zeroAddress) && sameAddress(String(event.args.newOwner), creation.owner));
  const sameSigners = (value: unknown) => Array.isArray(value) && value.length === creation.signers.length && value.every((raw, index) => {
    const signer = raw as { slot1?: string; slot2?: string };
    return typeof signer.slot1 === "string" && typeof signer.slot2 === "string" && signer.slot1.toLowerCase() === creation.signers[index].slot1.toLowerCase() && signer.slot2.toLowerCase() === creation.signers[index].slot2.toLowerCase();
  });
  if (receipt.blockNumber !== initialBlock || initialization.length !== 1 || initialization[0].args.threshold !== creation.threshold ||
    !sameSigners(initialization[0].args.signers) || ownership.length !== 1 || factories.length !== 1 ||
    !sameAddress(String(factories[0].args.owner), creation.owner) || factories[0].args.threshold !== creation.threshold ||
    factories[0].args.salt !== BigInt(creation.salt) || !sameSigners(factories[0].args.signers)) throw new Error("Canonical official Splits creation, owner and complete initial signer events are missing");
  const [initialOwner, initialThreshold, initialCount] = await Promise.all([read<Address>("owner", undefined, initialBlock), read<number>("getThreshold", undefined, initialBlock), read<number>("getSignerCount", undefined, initialBlock)]);
  if (!sameAddress(initialOwner, creation.owner) || initialThreshold !== creation.threshold || initialCount !== creation.signers.length) throw new Error("The initial Splits owner or threshold differs from its factory creation");
  await Promise.all(creation.signers.map(async (signer, index) => {
    const actual = await read<{ slot1: Hex; slot2: Hex }>("getSigner", [index], initialBlock);
    if (actual.slot1.toLowerCase() !== signer.slot1.toLowerCase() || actual.slot2.toLowerCase() !== signer.slot2.toLowerCase()) throw new Error("The complete initial Splits signer state differs from factory creation");
  }));
  const earlierCode = initialBlock > 0n ? await client.getCode({ address: account.address!, blockNumber: initialBlock - 1n }) : undefined;
  if (earlierCode && earlierCode !== "0x") throw new Error("The native Automation initialization does not establish its original deployment");
  }
}

export function baseTrustedSplitsMessage(value: Omit<BaseTrustedSplitsAcceptance, "signer" | "signature">) {
  return `MUSEGOD BASE TRUSTED SPLITS CONFIGURATION V1\n${JSON.stringify({ version: value.version, sourceChainId: value.sourceChainId,
    destinationChainId: value.destinationChainId, graphFingerprint: value.graphFingerprint.toLowerCase(), collector: value.collector.toLowerCase(),
    automationReceiver: value.automationReceiver.toLowerCase(), destinationTreasury: value.destinationTreasury.toLowerCase(),
    destinationWeth: value.destinationWeth.toLowerCase(), destinationVault: value.destinationVault.toLowerCase(), keeper: value.keeper.toLowerCase(),
    ruleId: value.ruleId, configurationSha256: value.configurationSha256.toLowerCase(), trustSplitsNativeExecution: value.trustSplitsNativeExecution })}\nI accept Splits native Automation and its mutable signer, owner and provider authority for this exact configuration. I authorize the fixed project fee path without requiring manufactured fees, a completed cross-chain canary, or native scheduling evidence before launch. Actual arrivals and MUSEGOD transfers to dead must still be accounted from canonical receipts. This configuration acceptance does not resume the Collector or public Base controls, authorize any transaction gas budget, or attest that a fee, bridge or burn has occurred.`;
}

export async function verifyBaseTrustedSplitsAuthority(client: BaseCollectorClient, manifest: BaseCollectorManifest, head: bigint) {
  if (await client.getChainId() !== 8453) throw new Error("Trusted Splits configuration requires the canonical Base RPC");
  const acceptance = manifest.activation.trustedSplitsAcceptance;
  if (manifest.activation.status !== "trusted_splits_authorized" || !baseActivationAcceptanceReady(manifest) || !acceptance ||
    acceptance.graphFingerprint.toLowerCase() !== baseCollectorGraphFingerprint(manifest).toLowerCase() || sameAddress(acceptance.keeper, zeroAddress) ||
    [manifest.constants.governor,manifest.constants.operationsTreasury,manifest.constants.automationReceiver,manifest.constants.destinationTreasury,manifest.automationAccount.owner]
      .some(role => role && sameAddress(role,acceptance.keeper)) || manifest.automationAccount.signers.some(signer => {
        const authority = baseSplitsSignerAuthority(signer); return authority.kind === "account" && sameAddress(authority.address,acceptance.keeper);
      })) throw new Error("Exact trusted Splits configuration and governor acceptance are required");
  await signedAuthority(client, manifest, acceptance.signer, acceptance.signature, baseTrustedSplitsMessage(acceptance), head);
  return acceptance;
}
async function signedAuthority(client: BaseCollectorClient, manifest: BaseCollectorManifest, signer: Address, signature: Hex, message: string, head: bigint) {
  const governor = getAddress(manifest.constants.governor!), code = await client.getCode({ address: governor, blockNumber: head });
  const authorityClient = { ...client, getBlock: async (parameters: { blockNumber: bigint } | { blockTag: "finalized" }) => {
    const block = await client.getBlock(parameters); return { number: block.number as bigint | null, hash: block.hash as Hex | null };
  } };
  await verifyGovernorSignature(authorityClient, governor, signer, signature, message, head, code);
}
async function currentBaseSettlementGraph(source: BaseCollectorClient, destination: BaseCollectorClient, sourceHead: bigint,
  onVerified?: (graph: NonNullable<VerifiedBaseCollector["currentSettlementGraph"]>) => void): Promise<{ number: bigint; hash: Hex }> {
  if (await destination.getChainId() !== 4663) throw new Error("Base final settlement requires Robinhood RPC");
  const graph = await verifyFeeEngineRuntime(destination as unknown as Parameters<typeof verifyFeeEngineRuntime>[0], getAddress(robinhoodDeployment.contracts.engine.address));
  const tip = await destination.getBlock({ blockNumber: graph.blockNumber });
  if (tip.number === null || !hash(tip.hash)) throw new Error("The Robinhood canonical settlement head is unavailable");
  await Promise.all((["forwarder", "vault", "executor", "swapper", "oracle"] as const).map(async name => {
    const contract = robinhoodDeployment.contracts[name];
    const code = await destination.getCode({ address: getAddress(contract.address), blockNumber: graph.blockNumber });
    if (!code || keccak256(code) !== contract.runtimeHash) throw new Error("The latest Robinhood settlement runtime changed");
  }));
  const implementation = robinhoodDeployment.preflight.dependencies.find(entry => entry.name === "swapperImpl");
  if (!implementation || !sameAddress(implementation.address, robinhoodDeployment.constants.swapperImpl)) throw new Error("The Robinhood Swapper implementation graph is incomplete");
  const implementationCode = await destination.getCode({ address: getAddress(implementation.address), blockNumber: graph.blockNumber });
  if (!implementationCode || keccak256(implementationCode) !== implementation.runtimeHash) throw new Error("The latest Robinhood Swapper implementation changed");
  await Promise.all([...[RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY, RELAY_ROUTER].map(async address => {
    const code = await source.getCode({ address, blockNumber: sourceHead });
    if (!code || keccak256(code) !== BUYBACK_CODE_HASHES[address.toLowerCase()]) throw new Error("The latest Base native Relay endpoint changed");
  }), (async () => {
    const code = await destination.getCode({ address: RELAY_ROUTER, blockNumber: graph.blockNumber });
    if (!code || keccak256(code) !== BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()]) throw new Error("The latest Robinhood Relay endpoint changed");
  })()]);
  onVerified?.({ vault: graph.vault, weth: getAddress(robinhoodDeployment.constants.weth), swapper: graph.swapper,
    engineForwarders: [graph.engine, graph.forwarder] });
  return { number: graph.blockNumber, hash: tip.hash };
}


export async function assertBaseKeeperLiveAuthority(source: BaseCollectorClient, manifest: BaseCollectorManifest, keeper: Address) {
  reviewedManifest(manifest, manifest.collector.address!);
  const account = manifest.automationAccount;
  if ([manifest.constants.governor, manifest.constants.operationsTreasury, manifest.constants.automationReceiver,
    manifest.constants.destinationTreasury, account.owner].some(address => address && sameAddress(address, keeper)) ||
    account.signers.some(signer => { const decoded = baseSplitsSignerAuthority(signer); return decoded.kind === "account" && sameAddress(decoded.address, keeper); }))
    throw new Error("The keeper must remain separate from the reviewed custody and governance authority");
  const calls = [
    { address: manifest.collector.address!, abi, functionName: "paused" },
    { address: manifest.collector.address!, abi, functionName: "governor" },
    ...["owner", "getThreshold", "getSignerCount"].map(functionName => ({ address: account.address!, abi: accountAbi, functionName })),
    { address: account.address!, abi: accountAbi, functionName: "isModuleEnabled", args: [keeper] },
    ...account.signers.map(signer => ({ address: account.address!, abi: accountAbi, functionName: "getSigner", args: [signer.index] })),
  ];
  const [values, slot] = await Promise.all([
    source.multicall({ contracts: calls as any, allowFailure: false, batchSize: 65536 }),
    source.getStorageAt({ address: account.address!, slot: implementationSlot }),
  ]);
  if (values[0] !== false || !sameAddress(String(values[1]), manifest.constants.governor!)) throw new Error("Collector paused or governor differs");
  if (!sameAddress(String(values[2]), account.owner!) || values[3] !== account.threshold || values[4] !== account.signers.length || values[5] !== false ||
    !slot || BigInt(slot) !== BigInt(account.implementation!.address)) throw new Error("Automation implementation or live permissions differ");
  for (let index = 0; index < account.signers.length; index++) {
    const actual = values[index + 6] as { slot1: Hex; slot2: Hex }, expected = account.signers[index];
    if (actual.slot1.toLowerCase() !== expected.slot1.toLowerCase() || actual.slot2.toLowerCase() !== expected.slot2.toLowerCase()) throw new Error("Automation known signer differs");
  }
}
export type BaseCollectorVerificationOptions = { manifest?: BaseCollectorManifest; requireActivation?: boolean | "runtime";
  robinhoodClient?: BaseCollectorClient; auditStore?: ContractIdentityStore };
/** Explicit manual verification: constructor, official factory origin, exact
 * code, fixed economics and optionally signed configuration. No trace/ledger. */
export async function verifyBaseCollectorForOperator(client: BaseCollectorClient, candidate: Address,
  options: BaseCollectorVerificationOptions = {}): Promise<VerifiedBaseCollector> {
  const manifest = structuredClone(options.manifest ?? BASE_COLLECTOR_MANIFEST);
  reviewedManifest(manifest, candidate);
  if (await client.getChainId() !== 8453) throw new Error("Base Collector verification requires chain 8453 RPC");
  const tip = await client.getBlock({ blockTag: "latest" });
  if (tip.number === null || !tip.hash) throw new Error("Base verification head unavailable");
  const head = tip.number, expected = baseCollectorExpectedRuntime(manifest);
  await Promise.all([verifyDependency(client, manifest.dependencies.initializer, head, "Base initializer"),
    verifyDependency(client, manifest.dependencies.rehype, head, "Base Rehype"), verifyBaseAutomationAccount(client, manifest, head)]);
  const code = await client.getCode({ address: candidate, blockNumber: head });
  if (keccak256(expected) !== manifest.collector.runtimeHash || !code || code.toLowerCase() !== expected.toLowerCase())
    throw new Error("Collector runtime differs from compiler output and immutable bindings");
  const getter = (functionName: string) => client.readContract({ address: candidate, abi, functionName, blockNumber: head });
  const [initializer, rehype, governor, receiver, paused, chainId, lpShare, hookShare] = await Promise.all(
    ["initializer", "rehype", "governor", "automationReceiver", "paused", "SOURCE_CHAIN_ID", "LP_SHARE", "HOOK_SHARE"].map(getter));
  if (!sameAddress(String(initializer), fixed.initializer) || !sameAddress(String(rehype), fixed.rehype) ||
    !sameAddress(String(governor), manifest.constants.governor!) || !sameAddress(String(receiver), manifest.constants.automationReceiver!) ||
    chainId !== 8453n || lpShare !== 228n * 10n ** 15n || hookShare !== 24n * 10n ** 16n || typeof paused !== "boolean")
    throw new Error("Collector fixed recipient, governor or economic shares differ");
  const receipt = await canonicalReceipt(client, manifest.collector.transactionHash!, head);
  const transaction = await client.getTransaction({ hash: receipt.transactionHash });
  if (receipt.blockNumber !== BigInt(manifest.collector.blockNumber!) || !receipt.contractAddress || !sameAddress(receipt.contractAddress, candidate) ||
    BigInt(manifest.automationAccount.blockNumber!) > receipt.blockNumber || transaction.to !== null || transaction.value !== 0n ||
    transaction.input.toLowerCase() !== encodeDeployData({ abi, bytecode: collectorArtifact.bytecode as Hex,
      args: [fixed.initializer, fixed.rehype, manifest.constants.governor!, manifest.constants.automationReceiver!] }).toLowerCase())
    throw new Error("Collector canonical constructor deployment differs");
  let currentSettlementGraph: VerifiedBaseCollector["currentSettlementGraph"];
  if (options.requireActivation !== false) {
    if (!options.robinhoodClient) throw new Error("Canonical Robinhood settlement RPC required");
    await verifyBaseTrustedSplitsAuthority(client, manifest, head);
    await currentBaseSettlementGraph(client, options.robinhoodClient, head, graph => { currentSettlementGraph = graph; });
  }
  if ((await client.getBlock({ blockNumber: head })).hash !== tip.hash) throw new Error("Base startup verification reorganized");
  return { collector: candidate, paused, automationReceiver: manifest.constants.automationReceiver!, runtimeHash: keccak256(code),
    initialDeploymentBlock: BigInt(manifest.collector.blockNumber!), manifestFingerprint: baseCollectorGraphFingerprint(manifest),
    ...(currentSettlementGraph ? { currentSettlementGraph } : {}) };
}
/** Immutable startup seal is persisted once for its complete manifest and code
 * hashes. Pause/permissions are deliberately absent from that seal. */
export async function verifyBaseCollectorForKeeperStartup(source: BaseCollectorClient, destination: BaseCollectorClient,
  options: { auditStore: ContractIdentityStore; collector?: Address; manifest?: BaseCollectorManifest }): Promise<VerifiedBaseCollector> {
  const manifest = structuredClone(options.manifest ?? BASE_COLLECTOR_MANIFEST), collector = options.collector ?? manifest.collector.address!;
  reviewedManifest(manifest, collector);
  const [sourceChain, destinationChain] = await Promise.all([source.getChainId(), destination.getChainId()]);
  if (sourceChain !== 8453 || destinationChain !== 4663) throw new Error("Startup RPC networks differ from the exact fee path");
  const fingerprint = baseCollectorGraphFingerprint(manifest);
  const seal = await contractIdentityOnce<{ collector: Address; automationReceiver: Address; runtimeHash: Hex; manifestFingerprint: Hex;
    initialDeploymentBlock: string; currentSettlementGraph?: VerifiedBaseCollector["currentSettlementGraph"] }>(source, {
    namespace: "base_collector_startup", binding: { manifest, runtimeHash: manifest.collector.runtimeHash, expectedRuntime: keccak256(baseCollectorExpectedRuntime(manifest)), settlement: robinhoodDeployment },
    store: options.auditStore,
    validate: value => { const v = value as any; return !!v && sameAddress(v.collector ?? "", collector) && sameAddress(v.automationReceiver ?? "", manifest.constants.automationReceiver!) &&
      v.runtimeHash === manifest.collector.runtimeHash && v.manifestFingerprint === fingerprint && v.initialDeploymentBlock === manifest.collector.blockNumber &&
      !!v.currentSettlementGraph && sameAddress(v.currentSettlementGraph.vault ?? "", fixed.destinationVault) &&
      sameAddress(v.currentSettlementGraph.weth ?? "", fixed.destinationWeth) &&
      sameAddress(v.currentSettlementGraph.swapper ?? "", robinhoodDeployment.contracts.swapper.address) &&
      Array.isArray(v.currentSettlementGraph.engineForwarders) && v.currentSettlementGraph.engineForwarders.length === 2 &&
      sameAddress(v.currentSettlementGraph.engineForwarders[0] ?? "", robinhoodDeployment.contracts.engine.address) &&
      sameAddress(v.currentSettlementGraph.engineForwarders[1] ?? "", manifest.finalSettlement.forwarder); },
    verify: async () => { const verified = await verifyBaseCollectorForOperator(source, collector, { manifest, robinhoodClient: destination });
      const { paused: _paused, initialDeploymentBlock, ...immutable } = verified; return { ...immutable, initialDeploymentBlock: String(initialDeploymentBlock) }; },
  });
  const paused = await source.readContract({ address: collector, abi, functionName: "paused" });
  if (typeof paused !== "boolean") throw new Error("Collector pause state unavailable");
  return { ...seal, paused, initialDeploymentBlock: BigInt(seal.initialDeploymentBlock) };
}
export async function verifyBaseCollector(client: BaseCollectorClient, candidate: Address, options: BaseCollectorVerificationOptions = {}) {
  if (!options.auditStore || !options.robinhoodClient) throw new Error("Persistent startup verification and exact settlement RPC are required");
  return verifyBaseCollectorForKeeperStartup(client, options.robinhoodClient, { auditStore: options.auditStore, collector: candidate, manifest: options.manifest });
}
