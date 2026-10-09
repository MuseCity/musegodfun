import { bytesToHex, decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeDeployData, encodeFunctionData,
  erc20Abi, getAddress, hexToBytes, keccak256, padHex, parseAbi, sha256, stringToHex, zeroAddress,
  type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt, type Transport } from "viem";
import manifestData from "../contracts/artifacts/base-collector-deployment.json";
import collectorArtifact from "../contracts/artifacts/base-collector/MusegodBaseFeeCollector.json";
import { CONTRACTS, STOCKS, sameAddress } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { verifyGovernorSignature } from "./buyback-activation";
import { verifyFeeEngineRuntime } from "./buyback-engine";
import robinhoodDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { BUYBACK_CODE_HASHES, RELAY_ROUTER } from "./buyback";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY } from "../src/lib/buyback";
import type { BaseNativeExecutionAcceptance } from "./base-native-provenance";
import { airlockAbi, bundlerAbi, DopplerSDK, computePoolId } from "@whetstone-research/doppler-sdk/evm";
import { assertRecoveryPlan, verifyCreationAccounting, verifyGuardedReceipt, verifiedFirstBuyLock } from "./launch-verification";
import { verifyLaunchGuard } from "./launch-guard";
import { tradingFeeBpsFor } from "../src/lib/trading-fee";
import { routerAbi, swapTransaction } from "../src/lib/protocol";
import type { LaunchPlan } from "../src/lib/launch-plan";
import type { BaseCollectorDeployment, BaseCollectorDependency } from "../scripts/deploy-base-collector";

export type BaseCollectorManifest = BaseCollectorDeployment;
export const BASE_COLLECTOR_MANIFEST = manifestData as unknown as BaseCollectorManifest;
export type BaseCollectorClient = Pick<PublicClient<Transport, any>, "getChainId" | "getBlockNumber" | "getBlock" | "getCode" | "getStorageAt" | "readContract" |
  "getTransaction" | "getTransactionReceipt" | "getLogs" | "request">;
export type BaseCollectorCanaryAuthorization = { version: 2; chainId: 8453; origin: string; collector: Address; automationReceiver: Address;
  graphFingerprint: Hex; keeper: Address; releaseBudgets: { token: Address; decimals: number; maxAmount: string }[];
  maxBaseGasWei: string; maxRobinhoodGasWei: string; expiresAt: string; signer: Address; signature: Hex };
export type BaseWalletFlowProof = { creator: Address; token: Address; quoteAsset: Address; poolId: Hex; launchHash: Hex; firstBuyHash: Hex;
  buyHash: Hex; sellHash: Hex; feeClaimHashes: Hex[]; recoveryEvidenceUri: string; recoveryEvidenceSha256: Hex; plan: LaunchPlan };
export type BaseWalletAcceptance = { version: 1; chainId: 8453; graphFingerprint: Hex; desktop: BaseWalletFlowProof; mobile: BaseWalletFlowProof; signer: Address; signature: Hex };
export type BaseNativeRunAcceptance = { version: 1; graphFingerprint: Hex; sourceHash: Hex; destinationHash: Hex;
  nativeExecutionSha256: Hex; jobId: string; evidenceUri: string; evidenceSha256: Hex; signer: Address; signature: Hex };
export type BasePauseRollbackAcceptance = { version: 1; graphFingerprint: Hex; pauseHash: Hex; resumeHash: Hex;
  evidenceUri: string; evidenceSha256: Hex; signer: Address; signature: Hex };
export type VerifiedBaseCollector = { collector: Address; paused: boolean; automationReceiver: Address; runtimeHash: Hex;
  manifestFingerprint: Hex; initialDeploymentBlock: bigint; canaryAuthorization?: BaseCollectorCanaryAuthorization };
export const BASE_SPLITS_FACTORY = getAddress("0x8E6Af8Ed94E87B4402D0272C5D6b0D47F0483e7C");
export const BASE_SPLITS_IMPLEMENTATION = getAddress("0x15ec0Fa66A0D96a64d67C58368641fBE9325F3FA");
export const BASE_SPLITS_FACTORY_HASH = "0x7320f2779f3b27b8dac66bdbfd7063345cee66aca9aa2d56f1b46ba5a9dcab05" as Hex;
export const BASE_SPLITS_IMPLEMENTATION_HASH = "0x8d790f1df78f070d2202718db467e6ee141274c7010372d93dc27d183bc1e446" as Hex;
export const BASE_SPLITS_PROXY_HASH = "0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d" as Hex;
const factoryAbi = parseAbi(["function IMPLEMENTATION() view returns(address)",
  "function getAddress(address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt) view returns(address)",
  "event SmartVaultCreated(address indexed smartVault,address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt)"]);
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const abi = collectorArtifact.abi as Abi;
const accountAbi = parseAbi(["function owner() view returns(address)", "function getThreshold() view returns(uint8)",
  "function getSignerCount() view returns(uint8)", "function getSigner(uint8) view returns((bytes32 slot1,bytes32 slot2))",
  "event InitializedSigners((bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold)",
  "function FACTORY() view returns(address)", "function getImplementation() view returns(address)", "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)"]);
const poolIdentityAbi = parseAbi(["function getPoolKey(bytes32) view returns((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))", "function getShares(bytes32,address) view returns(uint256)"]);
const poolSwapAbi = parseAbi(["event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"]);
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
function transfers(receipt: TransactionReceipt, token: Address, from: Address | null, to: Address | null) {
  return events(receipt, token, erc20Abi).filter(event => event.eventName === "Transfer" && (!from || sameAddress(String(event.args.from), from)) && (!to || sameAddress(String(event.args.to), to)))
    .reduce((sum, event) => sum + BigInt(String(event.args.value)), 0n);
}
export async function verifyBaseAutomationAccount(client: BaseCollectorClient, manifest: BaseCollectorManifest, head: bigint) {
  const account = manifest.automationAccount;
  reviewedAccount(account);
  const creation = account.creation!;
  const read = <T>(functionName: string, args?: readonly unknown[], blockNumber = head) => client.readContract({ address: account.address!, abi: accountAbi as Abi, functionName, args, blockNumber }) as Promise<T>;
  const readFactory = <T>(functionName: string, args?: readonly unknown[], blockNumber = head) => client.readContract({ address: BASE_SPLITS_FACTORY, abi: factoryAbi as Abi, functionName, args, blockNumber }) as Promise<T>;
  const initialBlock = BigInt(account.blockNumber!);
  // Check provenance at both the original initialization and the current head.
  // Factory receipt plus official CREATE2 prediction supports EntryPoint/internal creation without trusting a caller-supplied trace.
  for (const blockNumber of [...new Set([initialBlock, head])]) {
    const factoryCode = await client.getCode({ address: BASE_SPLITS_FACTORY, blockNumber });
    if (!factoryCode || factoryCode === "0x" || keccak256(factoryCode) !== BASE_SPLITS_FACTORY_HASH ||
      !sameAddress(await readFactory<Address>("IMPLEMENTATION", undefined, blockNumber), BASE_SPLITS_IMPLEMENTATION))
      throw new Error("The official Base Splits factory runtime or implementation changed");
    await verifyDependency(client, { address: account.address!, runtimeHash: BASE_SPLITS_PROXY_HASH,
      proxyImplementation: { address: BASE_SPLITS_IMPLEMENTATION, runtimeHash: BASE_SPLITS_IMPLEMENTATION_HASH }, proxyCheck: "erc1967" }, blockNumber, "Splits native Automation");
    const [factory, implementation] = await Promise.all([read<Address>("FACTORY", undefined, blockNumber), read<Address>("getImplementation", undefined, blockNumber)]);
    if (!sameAddress(factory, BASE_SPLITS_FACTORY) || !sameAddress(implementation, BASE_SPLITS_IMPLEMENTATION)) throw new Error("The account is not bound to the official Base Splits deployment");
  }
  const predicted = await readFactory<Address>("getAddress", [creation.owner, creation.signers, creation.threshold, BigInt(creation.salt)], initialBlock);
  if (!sameAddress(predicted, account.address!)) throw new Error("The native Automation address differs from the official CREATE2 creation prediction");
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

export function baseCollectorCanaryMessage(value: Omit<BaseCollectorCanaryAuthorization, "signer" | "signature">) {
  return `MUSEGOD BASE NATIVE AUTOMATION CANARY V2\n${JSON.stringify({ chainId: 8453, origin: value.origin,
    collector: value.collector.toLowerCase(), automationReceiver: value.automationReceiver.toLowerCase(), graphFingerprint: value.graphFingerprint.toLowerCase(), keeper: value.keeper.toLowerCase(),
    releaseBudgets: value.releaseBudgets.map(entry => ({ token: entry.token.toLowerCase(), decimals: entry.decimals, maxAmount: entry.maxAmount })),
    maxBaseGasWei: value.maxBaseGasWei, maxRobinhoodGasWei: value.maxRobinhoodGasWei, expiresAt: value.expiresAt })}\nI authorize this exact isolated origin and keeper to claim actual validated fees and release only the listed cumulative token amounts. I understand native Splits Automation has mutable signer and provider authority. This does not authorize public Base activation.`;
}
async function signedAuthority(client: BaseCollectorClient, manifest: BaseCollectorManifest, signer: Address, signature: Hex, message: string, head: bigint) {
  const governor = getAddress(manifest.constants.governor!), code = await client.getCode({ address: governor, blockNumber: head });
  const authorityClient = { ...client, getBlock: async (parameters: { blockNumber: bigint } | { blockTag: "finalized" }) => {
    const block = await client.getBlock(parameters); return { number: block.number as bigint | null, hash: block.hash as Hex | null };
  } };
  await verifyGovernorSignature(authorityClient, governor, signer, signature, message, head, code);
}
export async function verifyBaseCanaryAuthorization(client: BaseCollectorClient, manifest: BaseCollectorManifest, head: bigint,
  origin: string | undefined, historical = false) {
  const authorization = manifest.canaryAuthorization;
  if (!authorization || authorization.version !== 2 || authorization.chainId !== 8453 || !origin || origin !== authorization.origin ||
    authorization.graphFingerprint !== baseCollectorGraphFingerprint(manifest) || !sameAddress(authorization.collector, manifest.collector.address!) ||
    !sameAddress(authorization.automationReceiver, manifest.constants.automationReceiver!) || !authorization.keeper || sameAddress(authorization.keeper, zeroAddress) ||
    !Array.isArray(authorization.releaseBudgets) || !authorization.releaseBudgets.length || authorization.releaseBudgets.length > 72 ||
    new Set(authorization.releaseBudgets.map(entry => entry.token.toLowerCase())).size !== authorization.releaseBudgets.length ||
    !manifest.nativeRule.ruleId || !hash(manifest.nativeRule.configurationSha256)) throw new Error("An exact origin and human governor authorization are required for the isolated native canary");
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || ["musegod.fun", "www.musegod.fun"].includes(url.hostname)) throw new Error("The native canary origin must be isolated from public production");
  for (const entry of authorization.releaseBudgets) {
    if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 36 || sameAddress(getAddress(entry.token), zeroAddress)) throw new Error("The canary release budget asset is invalid");
    amount(entry.maxAmount);
  }
  amount(authorization.maxBaseGasWei); amount(authorization.maxRobinhoodGasWei); amount(authorization.expiresAt);
  if (!historical && (await client.getBlock({ blockNumber: head })).timestamp >= BigInt(authorization.expiresAt)) throw new Error("The isolated native canary authorization expired");
  await signedAuthority(client, manifest, authorization.signer, authorization.signature, baseCollectorCanaryMessage(authorization), head);
  return authorization;
}
export async function verifyBaseCollector(client: BaseCollectorClient, candidate: Address, options: {
  manifest?: BaseCollectorManifest; requireActivation?: boolean; allowCanary?: boolean; canaryOrigin?: string; robinhoodClient?: BaseCollectorClient;
} = {}): Promise<VerifiedBaseCollector> {
  // Async verification must bind one immutable copy, including full proof bytes.
  const manifest = structuredClone(options.manifest ?? BASE_COLLECTOR_MANIFEST);
  reviewedManifest(manifest, candidate);
  if ((await client.getChainId()) !== 8453) throw new Error("Base Collector verification requires chain 8453 RPC");
  const tip = await client.getBlock({ blockTag: "latest" });
  if (tip.number === null || !tip.hash) throw new Error("The Base canonical head is unavailable");
  const head = tip.number;
  await Promise.all([verifyDependency(client, manifest.dependencies.initializer, head, "Base initializer"), verifyDependency(client, manifest.dependencies.rehype, head, "Base Rehype"), verifyBaseAutomationAccount(client, manifest, head)]);
  const expected = baseCollectorExpectedRuntime(manifest), code = await client.getCode({ address: candidate, blockNumber: head });
  if (keccak256(expected) !== manifest.collector.runtimeHash || !code || code.toLowerCase() !== expected.toLowerCase()) throw new Error("The Base Collector runtime differs from exact compiler output and immutable bindings");
  const getters = <T>(functionName: string) => client.readContract({ address: candidate, abi, functionName, blockNumber: head }) as Promise<T>;
  const [initializer, rehype, governor, receiver, paused, sourceChainId, lpShare, hookShare] = await Promise.all([
    getters<Address>("initializer"), getters<Address>("rehype"), getters<Address>("governor"), getters<Address>("automationReceiver"), getters<boolean>("paused"),
    getters<bigint>("SOURCE_CHAIN_ID"), getters<bigint>("LP_SHARE"), getters<bigint>("HOOK_SHARE")]);
  if (!sameAddress(initializer, fixed.initializer) || !sameAddress(rehype, fixed.rehype) || !sameAddress(governor, manifest.constants.governor!) ||
    !sameAddress(receiver, manifest.constants.automationReceiver!) || sourceChainId !== 8453n || lpShare !== 228n * 10n ** 15n || hookShare !== 24n * 10n ** 16n || typeof paused !== "boolean")
    throw new Error("The Collector fixed fee recipient, governor or economic shares changed");
  const receipt = await canonicalReceipt(client, manifest.collector.transactionHash!, head);
  const transaction = await client.getTransaction({ hash: receipt.transactionHash });
  if (receipt.blockNumber !== BigInt(manifest.collector.blockNumber!) || !receipt.contractAddress || !sameAddress(receipt.contractAddress, candidate) ||
    BigInt(manifest.automationAccount.blockNumber!) > receipt.blockNumber || transaction.to !== null || transaction.value !== 0n ||
    transaction.input.toLowerCase() !== encodeDeployData({ abi, bytecode: collectorArtifact.bytecode as Hex,
      args: [fixed.initializer, fixed.rehype, governor, receiver] }).toLowerCase()) throw new Error("The Collector canonical constructor deployment differs from the reviewed native graph");
  const result: VerifiedBaseCollector = { collector: candidate, paused, automationReceiver: receiver, runtimeHash: keccak256(code), initialDeploymentBlock: receipt.blockNumber,
    manifestFingerprint: baseCollectorGraphFingerprint(manifest) };
  if (options.allowCanary) {
    if (paused) throw new Error("The Collector is paused");
    result.canaryAuthorization = await verifyBaseCanaryAuthorization(client, manifest, head, options.canaryOrigin);
  } else if (options.requireActivation !== false) {
    if (paused) throw new Error("The Collector is paused");
    await verifyBaseNativeActivationAcceptance(client, options.robinhoodClient, manifest, head);
  }
  if ((await client.getBlock({ blockNumber: head })).hash !== tip.hash) throw new Error("The Base verification head was reorganized");
  return result;
}
/** Bind the complete canonical financial acceptance, independent of JSON field ordering. */
export async function baseNativeExecutionSha256(value: unknown): Promise<Hex> {
  const { canonicalProofJson } = await import("./base-native-provenance");
  return sha256(stringToHex(canonicalProofJson(value)));
}
export function baseNativeRunAcceptanceMessage(value: Omit<BaseNativeRunAcceptance, "signer" | "signature">) {
  return `MUSEGOD BASE NATIVE SCHEDULED RUN ACCEPTANCE V1\n${JSON.stringify({ graphFingerprint: value.graphFingerprint.toLowerCase(),
    sourceHash: value.sourceHash.toLowerCase(), destinationHash: value.destinationHash.toLowerCase(),
    nativeExecutionSha256: value.nativeExecutionSha256.toLowerCase(), jobId: value.jobId,
    evidenceUri: value.evidenceUri, evidenceSha256: value.evidenceSha256.toLowerCase() })}\nI reviewed the identified Splits native scheduled job and its completed run against these exact transactions and financial journals. Transaction receipts and request tags alone cannot prove the native scheduler ran or that the provider completed the entire intended job. This is a human acceptance statement, not an on-chain provider guarantee.`;
}
export async function verifyBaseNativeRunAuthority(source: BaseCollectorClient, manifest: BaseCollectorManifest, head: bigint) {
  const proof = manifest.activation.nativeRunAcceptance;
  const execution = manifest.activation.nativeExecution as BaseNativeExecutionAcceptance | undefined;
  if (!proof || proof.version !== 1 || proof.graphFingerprint !== baseCollectorGraphFingerprint(manifest) || !execution?.proof ||
    !hash(proof.sourceHash) || !hash(proof.destinationHash) || !hash(proof.nativeExecutionSha256) || !hash(proof.evidenceSha256) ||
    proof.sourceHash.toLowerCase() !== execution.proof.sourceHash.toLowerCase() || proof.destinationHash.toLowerCase() !== execution.proof.destinationHash.toLowerCase() ||
    typeof proof.jobId !== "string" || !proof.jobId.trim() || proof.jobId.length > 256 ||
    typeof proof.evidenceUri !== "string" || !proof.evidenceUri.trim() || proof.evidenceUri.length > 2048 ||
    !sameAddress(proof.signer, manifest.constants.governor!) || proof.nativeExecutionSha256.toLowerCase() !== await baseNativeExecutionSha256(execution))
    throw new Error("The exact native scheduled job and completed-run human acceptance are required for public Base activation");
  await signedAuthority(source, manifest, proof.signer, proof.signature, baseNativeRunAcceptanceMessage(proof), head);
  return proof;
}
export function baseCollectorWalletAcceptanceMessage(value: Omit<BaseWalletAcceptance, "signer" | "signature">) {
  const flow = (entry: BaseWalletFlowProof) => ({ creator: entry.creator.toLowerCase(), token: entry.token.toLowerCase(), quoteAsset: entry.quoteAsset.toLowerCase(),
    poolId: entry.poolId.toLowerCase(), launchHash: entry.launchHash.toLowerCase(), firstBuyHash: entry.firstBuyHash.toLowerCase(), buyHash: entry.buyHash.toLowerCase(),
    sellHash: entry.sellHash.toLowerCase(), feeClaimHashes: entry.feeClaimHashes.map(hash => hash.toLowerCase()), recoveryEvidenceUri: entry.recoveryEvidenceUri,
    recoveryEvidenceSha256: entry.recoveryEvidenceSha256.toLowerCase(), frozenPlanId: entry.plan.id.toLowerCase() });
  return `MUSEGOD BASE GO LIVE WALLET ACCEPTANCE V1\n${JSON.stringify({ chainId: 8453, graphFingerprint: value.graphFingerprint.toLowerCase(),
    desktop: flow(value.desktop), mobile: flow(value.mobile) })}\nI attest that both flows were executed with actual desktop and mobile wallets and that the identified broadcast recovery evidence was reviewed. This is a human wallet and UI acceptance statement; on-chain receipts alone do not prove the browser or recovery experience.`;
}
export async function verifyBaseWalletAcceptance(source: BaseCollectorClient, manifest: BaseCollectorManifest, proof: BaseWalletAcceptance | undefined, fingerprint: Hex, head: bigint) {
  const accepted = await verifyBaseWalletAuthority(source, manifest, proof, fingerprint, head);
  await verifyBaseWalletReceipts(source, manifest, accepted, head);
}
async function verifyBaseWalletAuthority(source: BaseCollectorClient, manifest: BaseCollectorManifest, proof: BaseWalletAcceptance | undefined, fingerprint: Hex, head: bigint) {
  if ((await source.getChainId()) !== 8453 || !proof || proof.version !== 1 || proof.chainId !== 8453 || proof.graphFingerprint !== fingerprint || !proof.desktop || !proof.mobile || !sameAddress(proof.signer, manifest.constants.governor!))
    throw new Error("Both desktop and mobile wallet acceptance proofs are required for public Base activation");
  if (proof.desktop.launchHash.toLowerCase() === proof.mobile.launchHash.toLowerCase()) throw new Error("Desktop and mobile acceptance require distinct actual issuance flows");
  await signedAuthority(source, manifest, proof.signer, proof.signature, baseCollectorWalletAcceptanceMessage(proof), head);
  return proof;
}
async function verifyBaseWalletReceipts(source: BaseCollectorClient, manifest: BaseCollectorManifest, proof: BaseWalletAcceptance, head: bigint) {
  for (const flow of [proof.desktop, proof.mobile]) {
    if (!STOCKS.some(asset => sameAddress(asset.address, flow.quoteAsset)) || !hash(flow.poolId) || flow.firstBuyHash !== flow.launchHash ||
      !hash(flow.recoveryEvidenceSha256) || typeof flow.recoveryEvidenceUri !== "string" || !flow.recoveryEvidenceUri.trim() || flow.recoveryEvidenceUri.length > 1024 ||
      !Array.isArray(flow.feeClaimHashes) || !flow.feeClaimHashes.length || flow.feeClaimHashes.length > 10 || new Set(flow.feeClaimHashes).size !== flow.feeClaimHashes.length)
      throw new Error("The wallet flow lacks first-buy, creator-fee or broadcast-recovery evidence");
    const [launch, buy, sell, claims] = await Promise.all([canonicalReceipt(source, flow.launchHash, head), canonicalReceipt(source, flow.buyHash, head),
      canonicalReceipt(source, flow.sellHash, head), Promise.all(flow.feeClaimHashes.map(hash => canonicalReceipt(source, hash, head)))]);
    const plan = flow.plan;
    if (!plan?.firstBuy || plan.prepared?.chainId !== 8453 || plan.feePolicy !== BASE_AUTOMATION_FEE_POLICY || !plan.feeEngine || !sameAddress(plan.feeEngine, manifest.collector.address!) ||
      !plan.feeTreasury || !sameAddress(plan.feeTreasury, manifest.constants.operationsTreasury) || !sameAddress(plan.creator, flow.creator) ||
      !sameAddress(plan.tokenAddress, flow.token) || !sameAddress(plan.draft.quoteAddress, flow.quoteAsset) || plan.poolId !== flow.poolId || !plan.transaction)
      throw new Error("The actual wallet flow is not bound to its frozen Base issuance plan");
    const launchTransaction = await source.getTransaction({ hash: launch.transactionHash });
    if (!launchTransaction.to || !sameAddress(launchTransaction.to, plan.firstBuy.guard) || !sameAddress(plan.transaction.to, plan.firstBuy.guard) ||
      launchTransaction.input.toLowerCase() !== plan.data.toLowerCase() || launchTransaction.value !== BigInt(plan.transaction.value))
      throw new Error("The actual guard calldata differs from the frozen wallet preview");
    assertRecoveryPlan(plan, CONTRACTS, new DopplerSDK<8453>({ chainId: 8453, publicClient: source as PublicClient<Transport, any> }));
    if (!await verifyLaunchGuard(source, plan.firstBuy.guard, 8453)) throw new Error("The wallet first-buy guard is not the pinned Base implementation");
    verifyCreationAccounting(plan, launch, CONTRACTS, tradingFeeBpsFor(plan.draft.tradingFeeBps));
    const bundled = events(launch, plan.firstBuy.bundler, bundlerAbi).filter(event => event.eventName === "Bundled" &&
      sameAddress(String(event.args.recipient), flow.creator) && BigInt(String(event.args.amountIn)) === BigInt(plan.firstBuy!.amountIn));
    if (bundled.length !== 1) throw new Error("The canonical wallet Bundler first buy is missing");
    verifyGuardedReceipt(plan, launch, BigInt(String(bundled[0].args.amountOut)));
    const firstLock = verifiedFirstBuyLock(plan, launch, (await source.getBlock({ blockNumber: launch.blockNumber })).timestamp);
    for (const receipt of [launch, buy, sell, ...claims]) {
      const transaction = await source.getTransaction({ hash: receipt.transactionHash });
      if (!sameAddress(transaction.from, flow.creator)) throw new Error("The wallet receipt was sent by another creator");
    }
    const creations = events(launch, CONTRACTS.airlock, airlockAbi).filter(event => event.eventName === "Create" &&
      sameAddress(String(event.args.asset), flow.token) && sameAddress(String(event.args.numeraire), flow.quoteAsset) && sameAddress(String(event.args.initializer), CONTRACTS.initializer));
    if (creations.length !== 1 || launch.blockNumber < BigInt(manifest.collector.blockNumber!) ||
      transfers(launch, flow.quoteAsset, flow.creator, null) <= 0n || transfers(launch, flow.token, null, firstLock?.bundler ?? flow.creator) < BigInt(String(bundled[0].args.amountOut)) ||
      transfers(buy, flow.quoteAsset, flow.creator, null) <= 0n || transfers(buy, flow.token, null, flow.creator) <= 0n ||
      transfers(sell, flow.token, flow.creator, null) <= 0n || transfers(sell, flow.quoteAsset, null, flow.creator) <= 0n)
      throw new Error("The wallet issuance, first-buy and two-way trade receipts are incomplete");
    const key = await source.readContract({ address: CONTRACTS.initializer, abi: poolIdentityAbi, functionName: "getPoolKey", args: [flow.poolId], blockNumber: launch.blockNumber });
    if (computePoolId(key) !== flow.poolId || !sameAddress(key.hooks, CONTRACTS.initializer) || key.fee !== 0x800000 || key.tickSpacing !== 10 ||
      ![key.currency0, key.currency1].some(asset => sameAddress(asset, flow.token)) || ![key.currency0, key.currency1].some(asset => sameAddress(asset, flow.quoteAsset)))
      throw new Error("The wallet flow references another pool");
    for (const [receipt, inputAsset, outputAsset] of [[buy, flow.quoteAsset, flow.token], [sell, flow.token, flow.quoteAsset]] as const) {
      const transaction = await source.getTransaction({ hash: receipt.transactionHash });
      if (!transaction.to || !sameAddress(transaction.to, CONTRACTS.router) || transaction.value !== 0n) throw new Error("The wallet trade did not call the Base Universal Router");
      const decoded = decodeFunctionData({ abi: routerAbi, data: transaction.input });
      if (decoded.args[0] !== "0x10" || decoded.args[1].length !== 1) throw new Error("The wallet trade has unreviewed router commands");
      const [actions, parameters] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], decoded.args[1][0]);
      if (actions !== "0x060c0f" || parameters.length !== 3) throw new Error("The wallet trade has unreviewed swap actions");
      const [swap] = decodeAbiParameters([{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }], parameters[0]);
      if (computePoolId(swap.poolKey) !== flow.poolId || swap.zeroForOne !== sameAddress(inputAsset, key.currency0) || swap.amountIn <= 0n || swap.amountOutMinimum <= 0n || swap.hookData !== "0x" ||
        swapTransaction(key, inputAsset, swap.amountIn, swap.amountOutMinimum, 0, decoded.args[2], CONTRACTS).data.toLowerCase() !== transaction.input.toLowerCase())
        throw new Error("The wallet trade calldata does not bind the verified pool and protected output");
      const swaps = events(receipt, CONTRACTS.poolManager, poolSwapAbi).filter(event => event.eventName === "Swap" && event.args.id === flow.poolId && sameAddress(String(event.args.sender), CONTRACTS.router));
      const event = swaps[0]; if (swaps.length !== 1 || !event) throw new Error("The wallet trade lacks an actual PoolManager swap");
      const inputDelta = BigInt(String(event.args[swap.zeroForOne ? "amount0" : "amount1"])), outputDelta = BigInt(String(event.args[swap.zeroForOne ? "amount1" : "amount0"]));
      if (inputDelta !== -swap.amountIn || outputDelta <= 0n || transfers(receipt, inputAsset, flow.creator, null) !== swap.amountIn || transfers(receipt, outputAsset, null, flow.creator) < swap.amountOutMinimum)
        throw new Error("The actual wallet pool swap and asset receipts do not reconcile");
    }
    const protocolOwner = await source.readContract({ address: CONTRACTS.airlock, abi: parseAbi(["function owner() view returns(address)"]), functionName: "owner", blockNumber: launch.blockNumber });
    for (const [manager, configured] of [[CONTRACTS.initializer, [[protocolOwner, 5n * 10n ** 16n], [flow.creator, 665n * 10n ** 15n], [manifest.constants.operationsTreasury, 57n * 10n ** 15n], [manifest.collector.address!, 228n * 10n ** 15n]]],
      [CONTRACTS.rehype, [[flow.creator, 7n * 10n ** 17n], [manifest.constants.operationsTreasury, 6n * 10n ** 16n], [manifest.collector.address!, 24n * 10n ** 16n]]]] as const) {
      const expected = new Map<string, { account: Address; shares: bigint }>();
      for (const [account, shares] of configured) expected.set(account.toLowerCase(), { account, shares: (expected.get(account.toLowerCase())?.shares ?? 0n) + shares });
      await Promise.all([...expected.values()].map(async ({ account, shares }) => {
        const actual = await source.readContract({ address: manager, abi: poolIdentityAbi, functionName: "getShares", args: [flow.poolId, account], blockNumber: launch.blockNumber });
        if (actual !== shares) throw new Error("The wallet launch does not route the fixed fee shares");
      }));
    }
    let paid = 0n;
    for (const receipt of claims) {
      if (!receipt.to || ![CONTRACTS.initializer, CONTRACTS.rehype].some(manager => sameAddress(receipt.to!, manager))) throw new Error("The creator fee claim targets another manager");
      const transaction = await source.getTransaction({ hash: receipt.transactionHash });
      if (transaction.input.toLowerCase() !== encodeFunctionData({ abi: parseAbi(["function collectFees(bytes32)"]), functionName: "collectFees", args: [flow.poolId] }).toLowerCase())
        throw new Error("The creator fee claim targets another pool");
      paid += transfers(receipt, flow.quoteAsset, null, flow.creator) + transfers(receipt, flow.token, null, flow.creator);
    }
    if (paid === 0n) throw new Error("The wallet creator did not receive actual fees");
  }
}

export function basePauseRollbackAcceptanceMessage(proof: Omit<BasePauseRollbackAcceptance, "signer" | "signature">) {
  return `MUSEGOD BASE NATIVE AUTOMATION PAUSE AND ROLLBACK V1\n${JSON.stringify({ graphFingerprint: proof.graphFingerprint.toLowerCase(),
    pauseHash: proof.pauseHash.toLowerCase(), resumeHash: proof.resumeHash.toLowerCase(), evidenceUri: proof.evidenceUri, evidenceSha256: proof.evidenceSha256.toLowerCase() })}\nI reviewed the isolated native Automation execution-authority revocation, paused Collector, compatible paused release rollback, preserved in-flight recovery and database replay. These off-chain operational checks are a human attestation, not proved by Collector pause events alone.`;
}
async function verifyBasePauseRollbackAuthority(client: BaseCollectorClient, manifest: BaseCollectorManifest, head: bigint) {
  const proof = manifest.activation.pauseRollbackAcceptance;
  if (!proof || proof.version !== 1 || proof.graphFingerprint !== baseCollectorGraphFingerprint(manifest) || !hash(proof.pauseHash) || !hash(proof.resumeHash) ||
    proof.pauseHash === proof.resumeHash || !hash(proof.evidenceSha256) || !proof.evidenceUri?.trim() || proof.evidenceUri.length > 1024)
    throw new Error("Native execution-authority pause and compatible rollback acceptance are required");
  await signedAuthority(client, manifest, proof.signer, proof.signature, basePauseRollbackAcceptanceMessage(proof), head);
  return proof;
}
async function verifyBasePauseRollbackReceipts(client: BaseCollectorClient, manifest: BaseCollectorManifest, proof: BasePauseRollbackAcceptance, head: bigint) {
  const paused = await canonicalReceipt(client, proof.pauseHash, head), resumed = await canonicalReceipt(client, proof.resumeHash, head);
  if (paused.blockNumber >= resumed.blockNumber) throw new Error("The accepted Collector pause and resume sequence is invalid");
  for (const [receipt, method, state] of [[paused, "pause", true], [resumed, "resume", false]] as const) {
    const transaction = await client.getTransaction({ hash: receipt.transactionHash });
    const transitions = events(receipt, manifest.collector.address!, abi).filter(event => event.eventName === "PausedChanged" && event.args.paused === state);
    if (!transaction.to || !sameAddress(transaction.to, manifest.collector.address!) || transaction.value !== 0n || transitions.length !== 1 ||
      transaction.input.toLowerCase() !== encodeFunctionData({ abi, functionName: method }).toLowerCase())
      throw new Error("The accepted pause or resume lacks the canonical fixed Collector call");
  }
}
type EvidenceBlock = { number: bigint; hash: Hex };
type EvidenceAnchors = { source: EvidenceBlock[]; destination: EvidenceBlock[] };
type EvidenceHeads = { source: EvidenceBlock; destination: EvidenceBlock };
const finalizedBaseEvidence = new WeakMap<object, Map<string, { destination: object; anchorKey: Hex; complete?: boolean; headPair?: string; inFlight?: Promise<void> }>>();

/** Only static receipt/journal replay belongs here. The caller rechecks current authority and signatures first. */
export async function baseCollectorFinalizedEvidence(source: BaseCollectorClient, destination: BaseCollectorClient, key: Hex,
  heads: EvidenceHeads, anchors: EvidenceAnchors, replay: () => Promise<void>): Promise<void> {
  const canonical = async () => {
    await Promise.all((["source", "destination"] as const).flatMap(chain => {
      const client = chain === "source" ? source : destination;
      return [...anchors[chain], heads[chain]].map(async block => {
        if (block.number < 0n || !hash(block.hash) || block.number > heads[chain].number ||
          block !== heads[chain] && block.number + 64n > heads[chain].number ||
          (await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
          throw new Error("The Base activation canonical evidence anchor was reorganized or is unconfirmed");
      });
    }));
  };
  await canonical();
  let cache = finalizedBaseEvidence.get(source);
  if (!cache) { cache = new Map(); finalizedBaseEvidence.set(source, cache); }
  let entry = cache.get(key);
  const anchorKey = keccak256(stringToHex(JSON.stringify((["source", "destination"] as const).map(chain => anchors[chain].map(block => [String(block.number), block.hash])))));
  // A transaction re-included in a new canonical block must replay, even if its tx/proof hash is unchanged.
  if (entry && (entry.destination !== destination || entry.anchorKey !== anchorKey)) { cache.delete(key); entry = undefined; }
  const headPair = `${heads.source.number}:${heads.source.hash}:${heads.destination.number}:${heads.destination.hash}`;
  // A proof that has not reached finalized cannot be shared with a different head pair.
  if (entry?.inFlight && entry.headPair !== headPair && !entry.complete) {
    await replay(); await canonical(); return;
  }
  if (!entry) {
    for (const [oldKey, old] of cache) if (cache.size >= 16 && !old.inFlight) cache.delete(oldKey);
    // Keep the bound even when sixteen distinct proofs are currently replaying.
    if (cache.size >= 16) { await replay(); await canonical(); return; }
    entry = { destination, anchorKey }; cache.set(key, entry);
  }
  if (!entry.complete && !entry.inFlight) {
    const selected = entry;
    selected.headPair = headPair;
    selected.inFlight = (async () => {
      await replay();
      await canonical();
      const finalized = await Promise.all([source, destination].map(client => client.getBlock({ blockTag: "finalized" }).catch(() => null)));
      const covered = (["source", "destination"] as const).every((chain, index) => {
        const block = finalized[index];
        return block?.number !== null && block?.number !== undefined && hash(block.hash) && block.number <= heads[chain].number &&
          anchors[chain].every(anchor => anchor.number <= block.number!);
      });
      if (covered) selected.complete = true;
    })().finally(() => {
      selected.inFlight = undefined;
      if (!selected.complete && cache!.get(key) === selected) cache!.delete(key);
    });
  }
  if (!entry.complete) await entry.inFlight!;
  // Cache hits and in-flight waiters independently check their captured heads and anchors.
  await canonical();
}

async function baseAcceptanceAnchors(source: BaseCollectorClient, destination: BaseCollectorClient, manifest: BaseCollectorManifest, heads: EvidenceHeads): Promise<EvidenceAnchors> {
  const wallet = manifest.activation.walletAcceptance!, pause = manifest.activation.pauseRollbackAcceptance!;
  const native = manifest.activation.nativeExecution as BaseNativeExecutionAcceptance;
  const sourceHashes = new Set<Hex>([native.proof.sourceHash, pause.pauseHash, pause.resumeHash,
    ...[wallet.desktop, wallet.mobile].flatMap(flow => [flow.launchHash, flow.buyHash, flow.sellHash, ...flow.feeClaimHashes])]);
  const destinationHashes = new Set<Hex>([native.proof.destinationHash,
    ...native.vault.events.filter(event => event.kind === "executed").map(event => event.transactionHash)]);
  const receipts = await Promise.all([Promise.all([...sourceHashes].map(tx => canonicalReceipt(source, tx, heads.source.number))),
    Promise.all([...destinationHashes].map(tx => canonicalReceipt(destination, tx, heads.destination.number)))]);
  const journals = [[native.automation.state], [native.treasury.state, native.vault.state]];
  return Object.fromEntries((["source", "destination"] as const).map((chain, index) => {
    const blocks = [...receipts[index].map(receipt => ({ number: receipt.blockNumber, hash: receipt.blockHash })),
      ...journals[index].flatMap(state => [state.checkpoint, state.cursor]).map(block => ({ number: amount(block.number, true), hash: block.hash }))];
    const unique = new Map<string, EvidenceBlock>();
    for (const block of blocks) unique.set(`${block.number}:${block.hash}`, block);
    return [chain, [...unique.values()]];
  })) as EvidenceAnchors;
}

async function currentBaseSettlementGraph(source: BaseCollectorClient, destination: BaseCollectorClient, sourceHead: bigint): Promise<EvidenceBlock> {
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
  return { number: graph.blockNumber, hash: tip.hash };
}
async function verifyBaseNativeActivationAcceptance(source: BaseCollectorClient, destination: BaseCollectorClient | undefined, manifest: BaseCollectorManifest, head: bigint) {
  if (manifest.activation.status !== "canary_verified" || !manifest.activation.nativeExecution || !destination || (await destination.getChainId()) !== 4663)
    throw new Error("A complete genuine-fee native cross-chain canary activation proof is required; a status flag is insufficient");
  const fingerprint = baseCollectorGraphFingerprint(manifest);
  const authorization = await verifyBaseCanaryAuthorization(source, manifest, head, manifest.canaryAuthorization?.origin, true);
  // Governor/EIP-1271 authority remains live, including when all historical receipts are finalized.
  const wallet = await verifyBaseWalletAuthority(source, manifest, manifest.activation.walletAcceptance ?? undefined, fingerprint, head);
  const pause = await verifyBasePauseRollbackAuthority(source, manifest, head);
  await verifyBaseNativeRunAuthority(source, manifest, head);
  const [sourceTip, destinationTip] = await Promise.all([source.getBlock({ blockNumber: head }), currentBaseSettlementGraph(source, destination, head)]);
  if (!hash(sourceTip.hash)) throw new Error("The Base canonical activation head is unavailable");
  const heads: EvidenceHeads = { source: { number: head, hash: sourceTip.hash }, destination: destinationTip };
  const anchors = await baseAcceptanceAnchors(source, destination, manifest, heads);
  const key = keccak256(stringToHex(JSON.stringify([fingerprint, manifest.canaryAuthorization, manifest.activation])));
  await baseCollectorFinalizedEvidence(source, destination, key, heads, anchors, async () => {
    await verifyBaseWalletReceipts(source, manifest, wallet, head);
    await verifyBasePauseRollbackReceipts(source, manifest, pause, head);
    const { verifyBaseNativeActivation } = await import("./base-native-provenance");
    const native = await verifyBaseNativeActivation(source as PublicClient<Transport, any>, destination as PublicClient<Transport, any>, manifest, head);
    if (amount(native.receivedWeth) > 10n ** 16n || amount(native.museToDead) === 0n) throw new Error("The genuine native canary must settle within its 0.01 WETH ceiling");
    const sourceReceipt = await canonicalReceipt(source, native.sourceHash, head);
    if ((await source.getBlock({ blockNumber: sourceReceipt.blockNumber })).timestamp > BigInt(authorization.expiresAt))
      throw new Error("The native source execution occurred after its human authorization expired");
  });
}
