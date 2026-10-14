/**
 * Robinhood (4663) MusegodNftFeeVaultFactory deployment: owner preparation, a local rehearsal and read-only verification.
 * This script intentionally has no production broadcast mode or private-key input. The owner signs and sends the single
 * plain CREATE with their own tool; this script prints it unsigned beforehand and verifies the result afterwards.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import {
  createPublicClient, formatEther, getAddress, getContractAddress, http, isAddress, keccak256,
  type Address, type Hex, type PublicClient,
} from "viem";
import { robinhood } from "viem/chains";
import { FACTORY_CONTRACT, NFT_VAULT_PATHS, compileNftVault, type NftVaultBuild, type NftVaultCompilation } from "./build-nft-vault";
import { factoryAbi, isRateLimited, patchImmutableRuntime, robinhoodUpstreamUrl, runtimeTemplateFromInitCode, safeForkError } from "./nft-vault-fork-helpers";
import { startChainFork } from "./robinhood-fork";
import { ROBINHOOD_CONTRACTS, sameAddress } from "../src/lib/config";
import {
  ERC6551_REGISTRY, MUSES, TOKENBOUND_V3_IMPLEMENTATION, TOKENBOUND_V3_PROXY, treasuryFor, vaultFor,
  type NftRef, type NftVaultChainEntry, type NftVaultManifest,
} from "../src/lib/nft-mode";

export const CHAIN_ID = 4663;
export const PATHS = {
  ...NFT_VAULT_PATHS,
  preflight: ".cache/nft-vault-preflight-4663.json",
  createHex: ".cache/nft-vault-factory-4663.create.hex",
  evidence: "docs/evidence/nft-vault-factory-4663.json",
  rehearsal: ".cache/nft-vault-rehearsal-4663",
} as const;
/** Everything a rehearsal (or any local node) writes; never the committed manifest or evidence. */
export const REHEARSAL_PATHS = {
  preflight: `${PATHS.rehearsal}/preflight.json`, createHex: `${PATHS.rehearsal}/factory.create.hex`,
  manifest: `${PATHS.rehearsal}/nft-vault-deployment.json`, evidence: `${PATHS.rehearsal}/nft-vault-factory-4663.json`,
  summary: `${PATHS.rehearsal}/summary.json`,
} as const;
const GAS_BUFFER_PERCENT = 120n;
const FEE_MULTIPLIER = 2n;
const MIN_CONFIRMATIONS = 2n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Contracts the factory and its vaults call; each must already have code on Robinhood. */
export const DEPENDENCIES = {
  erc6551Registry: ERC6551_REGISTRY, tokenboundV3Proxy: TOKENBOUND_V3_PROXY, tokenboundV3Implementation: TOKENBOUND_V3_IMPLEMENTATION,
  rehype: ROBINHOOD_CONTRACTS.rehype, robinhoodInitializer: ROBINHOOD_CONTRACTS.initializer, muses: MUSES.contract,
} as const;
const MUSE_1: NftRef = { chainId: 4663, contract: MUSES.contract, tokenId: "1" };
const ALCHEMY_LABEL = "Alchemy Robinhood mainnet (ALCHEMY_API_KEY from .env.fork; URL not recorded)";

// ---- arguments --------------------------------------------------------------------------------------------------------
export type CliArgs =
  | { mode: "preflight"; deployer: Address; rpc?: string }
  | { mode: "verify"; tx: Hex; rpc?: string; deployer?: Address; nonce?: bigint }
  | { mode: "deploy-local"; rpc?: string }
  | { mode: "rehearse" }
  | { mode: "sourcify-input" };
export const USAGE = [
  "Usage: scripts/deploy-nft-vault.ts <mode>. It never signs, never broadcasts on a production network and never takes a private key.",
  "  --preflight --deployer <address> [--rpc <url>]                   read-only Robinhood checks; writes the unsigned CREATE",
  "  --verify --tx <hash> [--rpc <url>] [--deployer <a> --nonce <n>]  read-only deployment checks; records the 4663 manifest entry",
  "  --deploy-local [--rpc <loopback Anvil fork>]                     rehearsal on a local fork with a fork-unlocked deployer",
  "  --rehearse                                                       starts one fork from .env.fork: preflight, deploy-local, verify, stop",
  "  --sourcify-input                                                 writes the factory's standard JSON compiler input; never submits it",
].join("\n");
const MODE_FLAGS: Record<string, readonly string[]> = {
  "--preflight": ["--deployer", "--rpc"], "--verify": ["--tx", "--rpc", "--deployer", "--nonce"],
  "--deploy-local": ["--rpc"], "--rehearse": [], "--sourcify-input": [],
};
const KNOWN_FLAGS = new Set(Object.values(MODE_FLAGS).flat());
const SIGNER_FLAG = /^-{1,2}(private[-_]?keys?|keys?|mnemonics?|mnemonic-[a-z-]+|keystore|account|ledger|trezor|aws|gcp|interactive|unlocked|password(-file)?|seed|signer|sk)(=|$)/i;
const KEY_LIKE = /^(0x)?[0-9a-fA-F]{64}$/;
const NO_KEY = "This script never takes a private key or signer: the owner signs the CREATE with their own tool.";
const refuseSecret = (arg: string) => { if (SIGNER_FLAG.test(arg) || KEY_LIKE.test(arg)) throw new Error(NO_KEY); };

export function parseArgs(argv: readonly string[]): CliArgs {
  const [mode, ...rest] = argv;
  if (mode === undefined) throw new Error(USAGE);
  refuseSecret(mode);
  const allowed = MODE_FLAGS[mode];
  if (!allowed) throw new Error(`Unknown mode${/^--[a-z][a-z-]*$/.test(mode) ? ` ${mode}` : ""}.\n${USAGE}`);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    refuseSecret(flag);
    // Values are never echoed: a mistyped argument may be a secret.
    if (!KNOWN_FLAGS.has(flag) && !MODE_FLAGS[flag]) throw new Error(`Unexpected argument at position ${index + 2}.\n${USAGE}`);
    if (!allowed.includes(flag)) throw new Error(`${flag} is not accepted by ${mode}`);
    if (values.has(flag)) throw new Error(`Duplicate ${flag}`);
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag !== "--tx") refuseSecret(value);
    values.set(flag, value);
  }
  const rpc = values.get("--rpc");
  const address = (flag: string) => {
    const value = values.get(flag)!;
    if (!isAddress(value)) throw new Error(`${flag} must be an address`);
    return getAddress(value);
  };
  if (mode === "--deploy-local") {
    if (rpc !== undefined) assertLoopbackRpc(rpc);
    return { mode: "deploy-local", ...(rpc !== undefined ? { rpc } : {}) };
  }
  if (rpc !== undefined) assertHttpUrl(rpc);
  if (mode === "--preflight") {
    if (!values.has("--deployer")) throw new Error("--deployer is required");
    return { mode: "preflight", deployer: address("--deployer"), ...(rpc !== undefined ? { rpc } : {}) };
  }
  if (mode === "--verify") {
    const tx = values.get("--tx");
    if (tx === undefined) throw new Error("--tx is required");
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error("--tx must be a 32-byte transaction hash");
    if (values.has("--deployer") !== values.has("--nonce")) throw new Error("--deployer and --nonce go together");
    let explicit: { deployer: Address; nonce: bigint } | undefined;
    if (values.has("--deployer")) {
      const nonce = values.get("--nonce")!;
      if (!/^\d+$/.test(nonce) || BigInt(nonce) > MAX_SAFE) throw new Error("--nonce must be a non-negative safe integer");
      explicit = { deployer: address("--deployer"), nonce: BigInt(nonce) };
    }
    return { mode: "verify", tx: tx.toLowerCase() as Hex, ...(rpc !== undefined ? { rpc } : {}), ...explicit };
  }
  return mode === "--rehearse" ? { mode: "rehearse" } : { mode: "sourcify-input" };
}

function assertHttpUrl(url: string) {
  let protocol = "";
  try { protocol = new URL(url).protocol; } catch { /* reported below without echoing the value */ }
  if (protocol !== "http:" && protocol !== "https:") throw new Error("--rpc must be an http(s) URL");
}
export function isLoopbackRpc(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && !parsed.username && !parsed.password;
  } catch { return false; }
}
export function assertLoopbackRpc(url: string) {
  if (!isLoopbackRpc(url)) throw new Error("--deploy-local requires a loopback HTTP RPC: plain http on 127.0.0.1, localhost or [::1]");
}

// ---- pure deployment math ---------------------------------------------------------------------------------------------
export function predictFactoryAddress(deployer: Address, nonce: bigint): Address {
  assert(nonce >= 0n && nonce <= MAX_SAFE, "The deployment nonce must be a non-negative safe integer");
  return getContractAddress({ from: getAddress(deployer), nonce });
}

/**
 * The factory's compiler runtime (immutables zero-filled), cut from the committed creation code without knowing its
 * length: the one segment from a Solidity prologue to the end of a CBOR metadata trailer whose hash is the committed
 * template hash. Cross-checked with the fork gates' own extractor at that length.
 */
export function factoryRuntimeTemplate(build: Pick<NftVaultBuild, "factoryBytecode" | "factoryRuntimeTemplateHash">): Hex {
  const code = build.factoryBytecode.slice(2).toLowerCase();
  const starts: number[] = [];
  for (let at = code.indexOf("6080604052"); at >= 0; at = code.indexOf("6080604052", at + 1)) if (at % 2 === 0) starts.push(at);
  const ends = [...code.matchAll(/a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033/g)]
    .filter((match) => match.index! % 2 === 0).map((match) => match.index! + match[0].length);
  const matches = new Set<Hex>();
  for (const start of starts) for (const end of ends) {
    if (end <= start) continue;
    const candidate = `0x${code.slice(start, end)}` as Hex;
    if (keccak256(candidate) === build.factoryRuntimeTemplateHash.toLowerCase()) matches.add(candidate);
  }
  assert.equal(matches.size, 1, "The committed runtime template must occur exactly once in the committed factory creation code");
  const [template] = matches;
  return runtimeTemplateFromInitCode(build.factoryBytecode, build.factoryRuntimeTemplateHash, (template.length - 2) / 2);
}

/** The exact runtime a correct deployment has: the template with every VAULT_INIT_CODE_HASH slot set to vaultInitCodeHash. */
export function expectedFactoryRuntime(build: NftVaultBuild, template: Hex = factoryRuntimeTemplate(build)) {
  assert.equal(keccak256(template), build.factoryRuntimeTemplateHash.toLowerCase(), "The runtime template does not match the committed template hash");
  const runtime = patchImmutableRuntime(template.toLowerCase() as Hex, build.immutableReferences, build.vaultInitCodeHash);
  return { runtime, hash: keccak256(runtime), bytes: (runtime.length - 2) / 2 };
}

/** Gas limit = estimate + 20%; maxFeePerGas = 2 × (base fee + priority fee); the balance must cover gas limit × maxFeePerGas. */
export function feePlan({ estimate, baseFeePerGas, maxPriorityFeePerGas }: { estimate: bigint; baseFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  assert(estimate > 0n, "The gas estimate must be positive");
  assert(baseFeePerGas >= 0n && maxPriorityFeePerGas >= 0n, "Fees must be non-negative");
  const gas = (estimate * GAS_BUFFER_PERCENT + 99n) / 100n;
  const maxFeePerGas = FEE_MULTIPLIER * (baseFeePerGas + maxPriorityFeePerGas);
  return { gas, maxPriorityFeePerGas, maxFeePerGas, requiredWei: gas * maxFeePerGas };
}

export type UnsignedCreate = {
  type: "eip1559"; chainId: 4663; from: Address; nonce: number; to: null; value: "0";
  data: { file: string; bytes: number; keccak256: Hex }; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
};
/** cast 1.x parses `--create` as a subcommand, so every option must come before it. */
export function castSendArgs(tx: UnsignedCreate, rpc: string, signer: readonly string[], data: string): string[] {
  return ["send", "--rpc-url", rpc, "--chain", String(tx.chainId), "--from", tx.from, "--nonce", String(tx.nonce),
    "--gas-limit", tx.gas, "--priority-gas-price", tx.maxPriorityFeePerGas, "--gas-price", tx.maxFeePerGas, ...signer, "--create", data];
}
export function ownerCommand(tx: UnsignedCreate) {
  return ["cast", ...castSendArgs(tx, "<their RPC>", ["<their signer flags>"], `"$(cat ${tx.data.file})"`)].join(" ");
}

/** JSON for every file or console output: refuses any secret and any URL, so no keyed RPC can leak into evidence. */
export function serializeSafe(value: unknown, secrets: readonly string[]): string {
  const text = `${JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
  for (const secret of secrets) if (secret && text.includes(secret)) throw new Error("Refusing to write output that contains a secret");
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw new Error("Refusing to write output that contains a URL");
  return text;
}

function assertManifest(manifest: NftVaultManifest) {
  assert(manifest && manifest.version === 1 && /^0x[0-9a-fA-F]{64}$/.test(manifest.vaultInitCodeHash ?? "") && manifest.chains
    && manifest.chains["4663"] && manifest.chains["8453"], "Invalid NFT vault deployment manifest");
}
function assertRobinhoodUndeployed(manifest: NftVaultManifest) {
  assertManifest(manifest);
  const entry = manifest.chains["4663"];
  assert(entry.status === "not_deployed" && [entry.factory, entry.factoryRuntimeHash, entry.transactionHash, entry.blockNumber].every((value) => value === null),
    "Robinhood 4663 is already deployed in the manifest; the entry must be not_deployed with a null factory");
}

export type VerifiedEntry = { factory: Address; factoryRuntimeHash: Hex; transactionHash: Hex; blockNumber: bigint };
/** Returns a new manifest in which only "4663" becomes deployed_verified; vaultInitCodeHash and every other chain are kept. */
export function applyVerifiedDeployment(manifest: NftVaultManifest, entry: VerifiedEntry,
  expected: { vaultInitCodeHash: Hex; factoryRuntimeHash: Hex }): NftVaultManifest {
  assertRobinhoodUndeployed(manifest);
  assert.equal(manifest.vaultInitCodeHash.toLowerCase(), expected.vaultInitCodeHash.toLowerCase(),
    "The manifest vaultInitCodeHash differs from the build; refusing to record the factory");
  assert(typeof entry.factory === "string" && isAddress(entry.factory, { strict: false }), "Invalid factory address");
  assert(/^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash), "Invalid transaction hash");
  assert(entry.blockNumber > 0n && entry.blockNumber <= MAX_SAFE, "Invalid block number");
  assert(/^0x[0-9a-fA-F]{64}$/.test(entry.factoryRuntimeHash) && /^0x[0-9a-fA-F]{64}$/.test(expected.factoryRuntimeHash)
    && entry.factoryRuntimeHash.toLowerCase() === expected.factoryRuntimeHash.toLowerCase(),
  "The factory runtime hash differs from the expected runtime hash; refusing to record the factory");
  const robinhoodEntry: NftVaultChainEntry = {
    status: "deployed_verified", factory: getAddress(entry.factory), factoryRuntimeHash: entry.factoryRuntimeHash.toLowerCase() as Hex,
    transactionHash: entry.transactionHash.toLowerCase() as Hex, blockNumber: Number(entry.blockNumber),
  };
  const chains = Object.fromEntries(Object.entries(manifest.chains).map(([id, chain]) => [id, id === "4663" ? robinhoodEntry : chain]));
  return { ...manifest, chains: chains as NftVaultManifest["chains"] };
}
export const serializeManifest = (manifest: NftVaultManifest) => `${JSON.stringify(manifest, null, 2)}\n`;

// ---- preflight --------------------------------------------------------------------------------------------------------
export type PreflightClient = Pick<PublicClient, "getChainId" | "getBlock" | "getTransactionCount" | "getCode" | "getBalance"
  | "estimateGas" | "estimateMaxPriorityFeePerGas">;
export type PreflightInput = {
  deployer: Address; build: NftVaultBuild; compilerInput: string; manifest: NftVaultManifest;
  fresh: Pick<NftVaultCompilation, "build" | "compilerInput" | "factoryRuntimeTemplate">;
  rpcLabel: string; rehearsal: boolean; createHexPath: string; secrets: readonly string[];
};
export type PreflightReport = {
  schemaVersion: 1; kind: "nft-vault-factory-preflight"; rehearsal: boolean; rpc: string; observedAt: string; chainId: number;
  block: { number: string; hash: Hex; timestamp: string; baseFeePerGas: string };
  ready: boolean; failures: string[]; checks: Record<string, boolean>;
  deployer: Address; deployerCode: string; nonce: number; pendingNonce: number; predictedFactory: Address;
  expectedRuntimeHash: Hex; expectedRuntimeBytes: number;
  build: { vaultInitCodeHash: Hex; factoryRuntimeTemplateHash: Hex; creationCodeKeccak256: Hex; creationCodeBytes: number; factoryCompilerInputSha256: string };
  dependencies: Record<string, { address: Address; runtimeHash: Hex | null; runtimeBytes: number }>;
  gas: { estimate: string | null; limit: string | null; bufferPercent: number };
  fees: { baseFeePerGas: string; maxPriorityFeePerGas: string | null; maxFeePerGas: string | null; rule: string };
  balance: { wei: string; requiredWei: string | null; rule: string };
  unsignedTransaction?: UnsignedCreate; ownerCommand?: string; ownerNotes?: string[];
  mainnetTransactionsSubmitted: false;
};
const isEmptyCode = (code: Hex | undefined) => !code || code === "0x";
/** An EOA may carry an EIP-7702 delegation (0xef0100 ++ address) and still originate transactions; other code cannot. */
function describeDeployerCode(code: Hex | undefined) {
  if (isEmptyCode(code)) return { canSend: true, description: "none" };
  const delegation = /^0xef0100([0-9a-fA-F]{40})$/.exec(code!);
  return delegation ? { canSend: true, description: `EIP-7702 delegation to ${getAddress(`0x${delegation[1]}`)}` }
    : { canSend: false, description: `contract code (${(code!.length - 2) / 2} bytes)` };
}

/** Read-only. Throws for a wrong chain, a deployed manifest or a build the compiler does not reproduce; reports the rest. */
export async function preflight(client: PreflightClient, input: PreflightInput): Promise<PreflightReport> {
  const { build, deployer } = input;
  const chainId = await client.getChainId();
  assert.equal(chainId, CHAIN_ID, `The RPC must be Robinhood chain 4663 (got ${chainId})`);
  assertRobinhoodUndeployed(input.manifest);
  assert.equal(input.manifest.vaultInitCodeHash, build.vaultInitCodeHash, "The manifest vaultInitCodeHash differs from the build");
  assert(isDeepStrictEqual(input.fresh.build, build), "nft-vault-build.json differs from a fresh rebuild; run npm run build:nft-vault and review");
  assert(input.fresh.compilerInput === input.compilerInput, "The committed factory compiler input differs from a fresh compile; run npm run build:nft-vault");
  assert.equal(input.fresh.factoryRuntimeTemplate.toLowerCase(), factoryRuntimeTemplate(build),
    "The compiler runtime differs from the template embedded in the committed creation code");
  const expected = expectedFactoryRuntime(build, input.fresh.factoryRuntimeTemplate);

  const failures: string[] = [];
  const checks: Record<string, boolean> = { chainId: true, manifestUndeployed: true, buildReproduced: true, compilerInputReproduced: true };
  const check = (name: string, ok: boolean, failure: string) => { checks[name] = ok; if (!ok) failures.push(failure); };
  const redact = (error: unknown) => safeForkError(error, [...input.secrets]).slice(0, 600);

  const block = await client.getBlock({ blockTag: "latest" });
  assert(block.number !== null && block.hash && typeof block.baseFeePerGas === "bigint", "The latest block has no EIP-1559 base fee");
  const nonce = await client.getTransactionCount({ address: deployer, blockTag: "latest" });
  const pendingNonce = await client.getTransactionCount({ address: deployer, blockTag: "pending" });
  check("nonceSettled", nonce === pendingNonce,
    `The deployer has a pending transaction (latest nonce ${nonce}, pending ${pendingNonce}); let it settle, then rerun --preflight`);
  const deployerCode = describeDeployerCode(await client.getCode({ address: deployer, blockNumber: block.number }));
  check("deployerCanSend", deployerCode.canSend, `The deployer has ${deployerCode.description}; a CREATE must come from an externally owned account`);
  const predictedFactory = predictFactoryAddress(deployer, BigInt(nonce));
  const predictedCode = await client.getCode({ address: predictedFactory, blockNumber: block.number });
  const predictedNonce = await client.getTransactionCount({ address: predictedFactory, blockTag: "latest" });
  check("predictedAddressUnused", isEmptyCode(predictedCode) && predictedNonce === 0,
    `The predicted factory address ${predictedFactory} already has code or a nonce`);
  const dependencies: PreflightReport["dependencies"] = {};
  const missing: string[] = [];
  for (const [name, address] of Object.entries(DEPENDENCIES)) {
    const code = await client.getCode({ address, blockNumber: block.number });
    dependencies[name] = { address, runtimeHash: isEmptyCode(code) ? null : keccak256(code!), runtimeBytes: isEmptyCode(code) ? 0 : (code!.length - 2) / 2 };
    if (isEmptyCode(code)) missing.push(`${name} (${address}) has no code`);
  }
  check("dependenciesHaveCode", missing.length === 0, missing.join("; "));
  const balance = await client.getBalance({ address: deployer });
  let estimate: bigint | null = null;
  try { estimate = await client.estimateGas({ account: deployer, data: build.factoryBytecode, value: 0n }); }
  catch (error) { failures.push(`The gas estimate for the CREATE failed: ${redact(error)}`); }
  checks.gasEstimated = estimate !== null;
  let priority: bigint | null = null;
  try { priority = await client.estimateMaxPriorityFeePerGas(); }
  catch (error) { failures.push(`The priority fee could not be read: ${redact(error)}`); }
  checks.feesRead = priority !== null;
  const plan = estimate !== null && priority !== null ? feePlan({ estimate, baseFeePerGas: block.baseFeePerGas, maxPriorityFeePerGas: priority }) : null;
  check("balanceSufficient", plan !== null && balance >= plan.requiredWei, plan
    ? `The deployer balance ${formatEther(balance)} ETH is below the ${formatEther(plan.requiredWei)} ETH cap (gas limit × maxFeePerGas)`
    : "The balance cannot be checked without a gas estimate and fee caps");

  const ready = failures.length === 0;
  const unsignedTransaction: UnsignedCreate | undefined = ready && plan ? {
    type: "eip1559", chainId: CHAIN_ID, from: deployer, nonce, to: null, value: "0",
    data: { file: input.createHexPath, bytes: (build.factoryBytecode.length - 2) / 2, keccak256: keccak256(build.factoryBytecode) },
    gas: plan.gas.toString(), maxFeePerGas: plan.maxFeePerGas.toString(), maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(),
  } : undefined;
  return {
    schemaVersion: 1, kind: "nft-vault-factory-preflight", rehearsal: input.rehearsal, rpc: input.rpcLabel, observedAt: new Date().toISOString(),
    chainId, block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString(), baseFeePerGas: block.baseFeePerGas.toString() },
    ready, failures, checks, deployer, deployerCode: deployerCode.description, nonce, pendingNonce, predictedFactory, expectedRuntimeHash: expected.hash, expectedRuntimeBytes: expected.bytes,
    build: { vaultInitCodeHash: build.vaultInitCodeHash, factoryRuntimeTemplateHash: build.factoryRuntimeTemplateHash,
      creationCodeKeccak256: keccak256(build.factoryBytecode), creationCodeBytes: (build.factoryBytecode.length - 2) / 2,
      factoryCompilerInputSha256: build.factoryCompilerInputSha256 },
    dependencies,
    gas: { estimate: estimate?.toString() ?? null, limit: plan?.gas.toString() ?? null, bufferPercent: Number(GAS_BUFFER_PERCENT - 100n) },
    fees: { baseFeePerGas: block.baseFeePerGas.toString(), maxPriorityFeePerGas: priority?.toString() ?? null,
      maxFeePerGas: plan?.maxFeePerGas.toString() ?? null, rule: "maxFeePerGas = 2 x (latest base fee + suggested priority fee)" },
    balance: { wei: balance.toString(), requiredWei: plan?.requiredWei.toString() ?? null, rule: "balance >= gas limit x maxFeePerGas" },
    ...(unsignedTransaction ? {
      unsignedTransaction, ownerCommand: ownerCommand(unsignedTransaction),
      ownerNotes: [
        "The owner chooses the signer (a keystore with --keystore or --account, a Ledger with --ledger, or a wallet) and replaces <their signer flags>. This tool never sees a key.",
        `The nonce MUST be ${nonce}: the factory address ${predictedFactory} is derived from it. If the deployer sends any other transaction first, do not deploy; rerun --preflight.`,
        "Send it exactly once. If it is stuck, replace it only with the same nonce, the same data and zero value.",
        "--chain 4663 signs for Robinhood only. <their RPC> is the owner's own Robinhood RPC.",
        "After two confirmations run: npm run verify:nft-vault -- --tx <transaction hash>",
      ],
    } : {}),
    mainnetTransactionsSubmitted: false,
  };
}

// ---- verify -----------------------------------------------------------------------------------------------------------
export type VerifyClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "getBlock" | "getTransactionReceipt" | "getTransaction"
  | "getCode" | "readContract">;
export type VerifyInput = {
  tx: Hex; deployer: Address; nonce: bigint; build: NftVaultBuild; manifest: NftVaultManifest;
  preflight?: Pick<PreflightReport, "predictedFactory" | "expectedRuntimeHash" | "observedAt" | "block">;
  rehearsal: boolean; rpcLabel: string;
};

/** Read-only. Every check must pass; the result carries the manifest entry and the evidence to record. */
export async function verifyDeployment(client: VerifyClient, input: VerifyInput) {
  const { build, manifest } = input;
  assert.equal(await client.getChainId(), CHAIN_ID, "The RPC must be Robinhood chain 4663");
  assertManifest(manifest);
  assert.equal(manifest.vaultInitCodeHash, build.vaultInitCodeHash, "The manifest vaultInitCodeHash differs from the build");
  const expected = expectedFactoryRuntime(build);
  if (input.preflight) assert.equal(input.preflight.expectedRuntimeHash, expected.hash, "The preflight expected another runtime than the committed build");
  const checks: Record<string, boolean> = {};
  const need = (name: string, ok: boolean, message: string) => { assert(ok, message); checks[name] = true; };

  const head = await client.getBlockNumber({ cacheTime: 0 });
  const receipt = await client.getTransactionReceipt({ hash: input.tx });
  need("receiptSuccess", receipt.status === "success", "The deployment transaction reverted");
  need("contractCreation", receipt.to === null && !!receipt.contractAddress, "The transaction is not a contract creation");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  need("receiptCanonical", block.hash === receipt.blockHash, "The receipt's block is not canonical (reorganized); wait and rerun");
  const confirmations = head - receipt.blockNumber + 1n;
  need("confirmations", confirmations >= MIN_CONFIRMATIONS, `The transaction has ${confirmations} confirmation(s); wait for ${MIN_CONFIRMATIONS} and rerun`);
  const transaction = await client.getTransaction({ hash: input.tx });
  need("sender", sameAddress(transaction.from, input.deployer) && sameAddress(receipt.from, input.deployer),
    `The sender ${transaction.from} is not the preflight deployer ${input.deployer}`);
  need("nonce", BigInt(transaction.nonce) === input.nonce, `The transaction nonce ${transaction.nonce} is not the preflight nonce ${input.nonce}`);
  need("creationCode", transaction.to === null && transaction.value === 0n && transaction.input.toLowerCase() === build.factoryBytecode.toLowerCase(),
    "The transaction is not the committed factory creation code with zero value and no constructor arguments");
  need("transactionChainId", transaction.chainId === undefined || transaction.chainId === CHAIN_ID, "The transaction was signed for another chain");
  const factory = getAddress(receipt.contractAddress!);
  const predicted = predictFactoryAddress(input.deployer, input.nonce);
  need("predictedAddress", factory === predicted && (!input.preflight || factory === getAddress(input.preflight.predictedFactory)),
    `The factory ${factory} is not the predicted ${predicted}`);
  const code = await client.getCode({ address: factory, blockNumber: head });
  assert(!isEmptyCode(code), "The factory has no code");
  const runtimeHash = keccak256(code!);
  need("runtimeHash", runtimeHash === expected.hash, `The factory runtime hash ${runtimeHash} is not the expected ${expected.hash}`);
  const at = { address: factory, abi: factoryAbi, blockNumber: head } as const;
  const muse1 = [BigInt(CHAIN_ID), MUSES.contract, 1n] as const;
  const onchain = {
    VAULT_INIT_CODE_HASH: await client.readContract({ ...at, functionName: "VAULT_INIT_CODE_HASH" }),
    vaultForMuse1: getAddress(await client.readContract({ ...at, functionName: "vaultFor", args: muse1 })),
    treasuryForMuse1: getAddress(await client.readContract({ ...at, functionName: "treasuryFor", args: muse1 })),
    ERC6551_REGISTRY: getAddress(await client.readContract({ ...at, functionName: "ERC6551_REGISTRY" })),
    TOKENBOUND_V3_PROXY: getAddress(await client.readContract({ ...at, functionName: "TOKENBOUND_V3_PROXY" })),
  };
  const library = { vaultForMuse1: vaultFor(MUSE_1, factory, manifest.vaultInitCodeHash), treasuryForMuse1: treasuryFor(MUSE_1) };
  need("vaultInitCodeHash", onchain.VAULT_INIT_CODE_HASH.toLowerCase() === manifest.vaultInitCodeHash.toLowerCase(),
    "factory.VAULT_INIT_CODE_HASH() differs from the manifest vaultInitCodeHash");
  need("vaultForMuse1", onchain.vaultForMuse1 === library.vaultForMuse1, "factory.vaultFor(4663, MUSES, 1) differs from the TS vaultFor");
  need("treasuryForMuse1", onchain.treasuryForMuse1 === library.treasuryForMuse1, "factory.treasuryFor(4663, MUSES, 1) differs from the TS treasuryFor");
  need("factoryConstants", onchain.ERC6551_REGISTRY === ERC6551_REGISTRY && onchain.TOKENBOUND_V3_PROXY === TOKENBOUND_V3_PROXY,
    "The factory's registry or Tokenbound proxy constant differs");
  need("stillCanonical", (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash,
    "The receipt's block reorganized during verification; rerun");

  const entry: VerifiedEntry = { factory, factoryRuntimeHash: runtimeHash, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  const manifestEntry: NftVaultChainEntry = { status: "deployed_verified", factory, factoryRuntimeHash: runtimeHash,
    transactionHash: receipt.transactionHash.toLowerCase() as Hex, blockNumber: Number(receipt.blockNumber) };
  const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const evidence = {
    schemaVersion: 1, kind: "nft-vault-factory-deployment", chainId: CHAIN_ID, rehearsal: input.rehearsal, rpc: input.rpcLabel,
    verifiedAt: new Date().toISOString(), verifiedAtBlock: head.toString(),
    factory, deployer: getAddress(input.deployer), nonce: Number(input.nonce), transactionHash: receipt.transactionHash.toLowerCase(),
    blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, confirmations: confirmations.toString(),
    gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), costWei: costWei.toString(), costEth: formatEther(costWei),
    runtimeHash, runtimeBytes: (code!.length - 2) / 2,
    expected: { runtimeHash: expected.hash, runtimeBytes: expected.bytes, vaultInitCodeHash: build.vaultInitCodeHash,
      factoryRuntimeTemplateHash: build.factoryRuntimeTemplateHash, creationCodeKeccak256: keccak256(build.factoryBytecode),
      factoryCompilerInputSha256: build.factoryCompilerInputSha256 },
    onchain, library, checks, manifestEntry,
    preflight: input.preflight ? { observedAt: input.preflight.observedAt, blockNumber: input.preflight.block.number,
      predictedFactory: input.preflight.predictedFactory } : "explicit --deployer and --nonce",
    toolSha256: createHash("sha256").update(await readFile(new URL(import.meta.url), "utf8")).digest("hex"),
    signedOrBroadcastByThisTool: false,
  };
  return { entry, manifestEntry, expected, evidence };
}

// ---- command line -----------------------------------------------------------------------------------------------------
function rpcClient(rpc: string) {
  return createPublicClient({ chain: robinhood, pollingInterval: 250, transport: http(rpc, { timeout: 60_000, retryCount: 0 }) });
}
async function isDevNode(client: ReturnType<typeof rpcClient>) {
  try { return /anvil|hardhat|ganache/i.test(String(await client.request({ method: "web3_clientVersion" }))); } catch { return false; }
}
async function localRpc(rpc: string, method: string, params: unknown[] = []) {
  assertLoopbackRpc(rpc);
  const response = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(120_000) });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  assert(!body.error, `Local ${method} failed: ${body.error?.message ?? ""}`);
  return body.result;
}
async function loadCommitted() {
  return {
    build: JSON.parse(await readFile(PATHS.build, "utf8")) as NftVaultBuild,
    compilerInput: existsSync(PATHS.compilerInput) ? await readFile(PATHS.compilerInput, "utf8") : "",
    manifest: JSON.parse(await readFile(PATHS.manifest, "utf8")) as NftVaultManifest,
  };
}
async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function runPreflight(client: ReturnType<typeof rpcClient>, deployer: Address, local: boolean, rpcLabel: string, secrets: string[]) {
  const paths = local ? REHEARSAL_PATHS : { preflight: PATHS.preflight, createHex: PATHS.createHex };
  const committed = await loadCommitted();
  const fresh = compileNftVault({ offline: true, quiet: true });
  const report = await preflight(client, { deployer, ...committed, fresh, rpcLabel, rehearsal: local, createHexPath: paths.createHex, secrets });
  const text = serializeSafe(report, secrets);
  if (report.ready) await write(paths.createHex, committed.build.factoryBytecode);
  await write(paths.preflight, text);
  return { report, text, path: paths.preflight };
}

async function recordVerification(result: Awaited<ReturnType<typeof verifyDeployment>>, build: NftVaultBuild, manifest: NftVaultManifest,
  local: boolean, secrets: string[]) {
  const paths = local ? REHEARSAL_PATHS : { manifest: PATHS.manifest, evidence: PATHS.evidence };
  if (manifest.chains["4663"]?.status === "deployed_verified") {
    assert(isDeepStrictEqual(manifest.chains["4663"], result.manifestEntry), "The manifest already records a different Robinhood factory; refusing to overwrite it");
    return { manifest: "unchanged (this deployment is already recorded)", paths };
  }
  const next = applyVerifiedDeployment(manifest, result.entry, { vaultInitCodeHash: build.vaultInitCodeHash, factoryRuntimeHash: result.expected.hash });
  assert(isDeepStrictEqual(next.chains["4663"], result.manifestEntry), "The manifest entry differs from the verified evidence");
  await write(paths.evidence, serializeSafe(result.evidence, secrets));
  await write(paths.manifest, serializeManifest(next));
  return { manifest: local ? "temporary copy written (the committed manifest is unchanged)" : "contracts/artifacts/nft-vault-deployment.json updated for 4663 only", paths };
}

async function runVerify(args: Extract<CliArgs, { mode: "verify" }>, key: string) {
  const rpc = args.rpc ?? robinhoodUpstreamUrl(key);
  const secrets = [key, rpc].filter(Boolean);
  const client = rpcClient(rpc);
  const local = isLoopbackRpc(rpc) || await isDevNode(client);
  const committed = await loadCommitted();
  let report: PreflightReport | undefined;
  let deployer = args.deployer, nonce = args.nonce;
  if (deployer === undefined || nonce === undefined) {
    const path = local ? REHEARSAL_PATHS.preflight : PATHS.preflight;
    assert(existsSync(path), `No preflight report at ${path}; run --preflight first, or pass --deployer and --nonce`);
    report = JSON.parse(await readFile(path, "utf8")) as PreflightReport;
    assert(report.kind === "nft-vault-factory-preflight" && report.chainId === CHAIN_ID && report.ready === true && report.rehearsal === local,
      `${path} is not a ready ${local ? "local" : "Robinhood mainnet"} preflight report`);
    deployer = report.deployer; nonce = BigInt(report.nonce);
  }
  const rpcLabel = args.rpc ? (local ? "local node (loopback)" : "explicit --rpc (URL not recorded)") : ALCHEMY_LABEL;
  const result = await verifyDeployment(client, { tx: args.tx, deployer, nonce, build: committed.build, manifest: committed.manifest,
    preflight: report, rehearsal: local, rpcLabel });
  const recorded = await recordVerification(result, committed.build, committed.manifest, local, secrets);
  console.log(serializeSafe({ status: "verified", factory: result.entry.factory, transactionHash: result.evidence.transactionHash,
    blockNumber: result.evidence.blockNumber, costEth: result.evidence.costEth, checks: result.evidence.checks, ...recorded }, secrets).trimEnd());
}

/** One loopback Anvil fork (its own, or a given one): preflight for a fork-unlocked deployer, the owner's cast command, verify. */
async function rehearse(rpcGiven: string | undefined, key: string) {
  const secrets = [key].filter(Boolean);
  const summary: Record<string, unknown> = { kind: "nft-vault-factory-rehearsal", status: "running", startedAt: new Date().toISOString(),
    scope: "Loopback Anvil fork of Robinhood keeping chain id 4663. The upstream proxy forwards reads only. No mainnet transaction, committed manifest or committed evidence is written.",
    mainnetTransactionsSubmitted: false };
  let fork: Awaited<ReturnType<typeof startChainFork>> | undefined;
  try {
    let rpc = rpcGiven;
    if (rpc === undefined) {
      if (!process.env.ANVIL_BIN?.trim() && !existsSync(".cache/bin/base-anvil-v1.1.1/anvil"))
        process.env.ANVIL_BIN = execFileSync("which", ["anvil"], { encoding: "utf8" }).trim();
      fork = await startChainFork(robinhoodUpstreamUrl(key), CHAIN_ID, CHAIN_ID);
      rpc = fork.rpc;
      summary.forkBlockNumber = fork.blockNumber.toString();
    }
    assertLoopbackRpc(rpc);
    const client = rpcClient(rpc);
    assert(await isDevNode(client), "--deploy-local requires an Anvil node");
    const nodeInfo = await localRpc(rpc, "anvil_nodeInfo") as { forkConfig?: { forkBlockNumber?: number } };
    assert(nodeInfo?.forkConfig?.forkBlockNumber, "--deploy-local requires an Anvil fork of Robinhood");
    summary.forkBlockNumber ??= String(nodeInfo.forkConfig.forkBlockNumber);
    // Anvil's default accounts are live on Robinhood and carry code there (EIP-7702 delegations), so, as in the fork gates, the
    // rehearsal deployer is a fresh random address (no key exists) that the fork alone funds and unlocks.
    const deployer = getAddress(`0x${randomBytes(20).toString("hex")}`);
    assert(isEmptyCode(await client.getCode({ address: deployer })), "The fresh rehearsal deployer must have no code");
    await localRpc(rpc, "anvil_setBalance", [deployer, "0x56bc75e2d63100000"]);
    await localRpc(rpc, "anvil_impersonateAccount", [deployer]);
    const { report } = await runPreflight(client, deployer, true, "local Anvil fork (loopback)", secrets);
    summary.preflight = { ready: report.ready, failures: report.failures, deployer, nonce: report.nonce, predictedFactory: report.predictedFactory,
      expectedRuntimeHash: report.expectedRuntimeHash, gas: report.gas, fees: report.fees, dependencies: report.dependencies, ownerCommand: report.ownerCommand };
    assert(report.ready && report.unsignedTransaction, `The rehearsal preflight is not ready: ${report.failures.join("; ")}`);
    // The owner's exact cast command; only the signer flags differ (--unlocked: the fork signs for the impersonated deployer).
    const committed = await loadCommitted();
    const output = execFileSync("cast", castSendArgs(report.unsignedTransaction, rpc, ["--unlocked"], committed.build.factoryBytecode),
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
    let tx = /transactionHash\s+(0x[0-9a-fA-F]{64})/.exec(output)?.[1]?.toLowerCase() as Hex | undefined;
    if (!tx) {
      // Another cast output format: find the mined transaction by its sender and nonce instead.
      const latest = await client.getBlock({ blockTag: "latest", includeTransactions: true });
      tx = latest.transactions.find((item) => sameAddress(item.from, deployer) && item.nonce === report.nonce)?.hash;
    }
    assert(tx, "cast send did not produce a transaction from the rehearsal deployer at the preflight nonce");
    summary.castCommandAccepted = true;
    await localRpc(rpc, "anvil_stopImpersonatingAccount", [deployer]);
    await localRpc(rpc, "anvil_mine", ["0x1"]);
    const result = await verifyDeployment(client, { tx, deployer, nonce: BigInt(report.nonce), build: committed.build, manifest: committed.manifest,
      preflight: report, rehearsal: true, rpcLabel: "local Anvil fork (loopback)" });
    const recorded = await recordVerification(result, committed.build, committed.manifest, true, secrets);
    Object.assign(summary, { status: "passed", deployment: { factory: result.entry.factory, transactionHash: tx, blockNumber: result.evidence.blockNumber,
      gasUsed: result.evidence.gasUsed, costEth: result.evidence.costEth, runtimeHash: result.evidence.runtimeHash },
    verification: result.evidence.checks, onchain: result.evidence.onchain, wouldWriteManifestEntry: result.manifestEntry, recorded });
  } catch (error) {
    const message = safeForkError(error, [...secrets, rpcGiven ?? ""]);
    Object.assign(summary, { status: isRateLimited(message) ? "blocked_rate_limited" : "failed", error: message });
  } finally {
    if (fork) {
      summary.blockedUpstreamWrites = fork.blockedUpstreamWrites();
      await fork.stop();
    }
  }
  if (summary.status === "passed" && summary.blockedUpstreamWrites) Object.assign(summary, { status: "failed", error: "An upstream write was attempted" });
  summary.completedAt = new Date().toISOString();
  const text = serializeSafe(summary, secrets);
  await write(REHEARSAL_PATHS.summary, text);
  console.log(text.trimEnd());
  if (summary.status !== "passed") process.exitCode = 1;
}

async function sourcifyInput() {
  const fresh = compileNftVault({ offline: true, quiet: true });
  const committed = JSON.parse(await readFile(PATHS.build, "utf8")) as NftVaultBuild;
  assert(isDeepStrictEqual(fresh.build, committed), "nft-vault-build.json differs from a fresh rebuild; run npm run build:nft-vault and review");
  await write(PATHS.compilerInput, fresh.compilerInput);
  console.log(serializeSafe({ file: PATHS.compilerInput, sha256: fresh.build.factoryCompilerInputSha256, compilerVersion: fresh.compilerVersion,
    contractIdentifier: `${FACTORY_CONTRACT.source}:${FACTORY_CONTRACT.name}`, chainId: CHAIN_ID, submitted: false,
    note: "Not submitted. After the deployment, and with owner approval, submit this input with the factory address and its creation transaction." }, []).trimEnd());
}

async function main(argv: string[]) {
  const key = process.env.ALCHEMY_API_KEY?.trim() ?? "";
  let explicitRpc = "";
  try {
    const args = parseArgs(argv);
    explicitRpc = "rpc" in args && args.rpc ? args.rpc : "";
    if (args.mode === "sourcify-input") return await sourcifyInput();
    if (args.mode === "rehearse" || args.mode === "deploy-local") return await rehearse(args.mode === "deploy-local" ? args.rpc : undefined, key);
    if (args.mode === "verify") return await runVerify(args, key);
    const rpc = args.rpc ?? robinhoodUpstreamUrl(key);
    const secrets = [key, rpc].filter(Boolean);
    const client = rpcClient(rpc);
    const local = isLoopbackRpc(rpc) || await isDevNode(client);
    const { report, text, path } = await runPreflight(client, args.deployer, local,
      args.rpc ? (local ? "local node (loopback)" : "explicit --rpc (URL not recorded)") : ALCHEMY_LABEL, secrets);
    console.log(text.trimEnd());
    console.error(report.ready ? `READY: wrote ${path}` : `NOT READY: ${report.failures.join("; ")}`);
    if (!report.ready) process.exitCode = 1;
  } catch (error) {
    const message = safeForkError(error, [key, explicitRpc]);
    console.error(isRateLimited(message) ? `BLOCKED_RATE_LIMITED: ${message}` : message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
