import assert from "node:assert/strict";
import {
  decodeAbiParameters, getAddress, keccak256, parseAbi, toEventSelector, toFunctionSelector,
  type Abi, type AbiParameter, type Address, type Hex,
} from "viem";

// Pure helpers for scripts/test-nft-vault-fork.ts. Treasury and vault addresses come only from
// src/lib/nft-mode.ts; nothing here derives an address.

export const registryAbi = parseAbi([
  "function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)",
  "function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)",
]);
export const accountProxyAbi = parseAbi([
  "function initialize(address implementation)",
  "error InvalidImplementation()", "error AlreadyInitialized()",
]);
export const accountV3Abi = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
  "function token() view returns (uint256 chainId, address tokenContract, uint256 tokenId)",
  "function owner() view returns (address)",
  "function isValidSigner(address signer, bytes context) view returns (bytes4)",
  "function upgradeTo(address newImplementation)",
  "error NotAuthorized()", "error AccountLocked()", "error InvalidOperation()", "error InvalidImplementation()",
  "error AlreadyInitialized()", "error OwnershipCycle()",
]);
export const guardianAbi = parseAbi([
  "function owner() view returns (address)",
  "function isTrustedExecutor(address executor) view returns (bool)",
  "function isTrustedImplementation(address implementation) view returns (bool)",
  "function setTrustedExecutor(address executor, bool trusted)",
  "function setTrustedImplementation(address implementation, bool trusted)",
]);
export const feeSourceAbi = parseAbi([
  "function getShares(bytes32 poolId, address beneficiary) view returns (uint256)",
  "function getCumulatedFees0(bytes32 poolId) view returns (uint256)",
  "function getCumulatedFees1(bytes32 poolId) view returns (uint256)",
  "function getLastCumulatedFees0(bytes32 poolId, address beneficiary) view returns (uint256)",
  "function getLastCumulatedFees1(bytes32 poolId, address beneficiary) view returns (uint256)",
  "function getPoolKey(bytes32 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
  "function collectFees(bytes32 poolId) returns (uint128 fees0, uint128 fees1)",
  "function updateBeneficiary(bytes32 poolId, address newBeneficiary)",
  "function getState(address asset) view returns (address numeraire, uint256 totalTokensOnBondingCurve, address dopplerHook, bytes graduationDopplerHookCalldata, uint8 status, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 farTick)",
  "event Release(bytes32 indexed poolId, address indexed beneficiary, uint256 fees0, uint256 fees1)",
  "error CallerNotBeneficiary()", "error InvalidNewBeneficiary()",
]);
export const musesAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function getTransferValidator() view returns (address)",
]);
export const wethAbi = parseAbi(["function deposit() payable"]);
export const factoryAbi = parseAbi([
  "function VAULT_INIT_CODE_HASH() view returns (bytes32)",
  "function ERC6551_REGISTRY() view returns (address)",
  "function TOKENBOUND_V3_PROXY() view returns (address)",
  "function saltFor(uint256 homeChainId, address nft, uint256 tokenId) pure returns (bytes32)",
  "function treasuryFor(uint256 homeChainId, address nft, uint256 tokenId) view returns (address)",
  "function vaultFor(uint256 homeChainId, address nft, uint256 tokenId) view returns (address)",
  "function deploy(uint256 homeChainId, address nft, uint256 tokenId) returns (address vault)",
  "function parameters() view returns (uint256 homeChainId, address nft, uint256 tokenId, address treasury)",
  "event VaultDeployed(uint256 indexed homeChainId, address indexed nft, uint256 indexed tokenId, address vault, address treasury)",
  "error InvalidConfiguration()",
]);
export const vaultAbi = parseAbi([
  "function sweep(bytes32[] poolIds, address[] tokens)",
  "function forward(address token) returns (uint256 amount)",
  "function factory() view returns (address)",
  "function homeChainId() view returns (uint256)",
  "function nft() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function treasury() view returns (address)",
  "function initializer() view returns (address)",
  "function REHYPE() view returns (address)",
  "function BASE_INITIALIZER() view returns (address)",
  "function ROBINHOOD_INITIALIZER() view returns (address)",
  "event FeeClaimFailed(bytes32 indexed poolId, address indexed source, bytes reason)",
  "event Swept(address indexed token, address indexed treasury, uint256 amount)",
  "event SweepFailed(address indexed token, bytes reason)",
  "error InvalidConfiguration()", "error Unauthorized()", "error EtherTransferFailed()",
]);

type Reference = { start: number; length: number };

/** Fills every slot of the factory's single immutable (VAULT_INIT_CODE_HASH) in the compiler runtime template. */
export function patchImmutableRuntime(template: Hex, references: Record<string, Reference[]>, value: Hex): Hex {
  const entries = Object.values(references);
  assert.equal(entries.length, 1, "The NFT factory must have exactly one immutable");
  assert(entries[0].length > 0, "The NFT factory must have exactly one immutable");
  assert.match(value, /^0x[0-9a-fA-F]{64}$/);
  let runtime = template.slice(2);
  const ranges: [number, number][] = [];
  for (const { start, length } of entries[0]) {
    assert(Number.isInteger(start) && start >= 0 && length === 32 && (start + length) * 2 <= runtime.length,
      "Factory immutable offset is out of bounds");
    assert(ranges.every(([from, to]) => start >= to || start + length <= from), "Factory immutable offsets overlap");
    assert.equal(template.slice(2 + start * 2, 2 + (start + length) * 2), "00".repeat(length), "Expected zero placeholder");
    ranges.push([start, start + length]);
    runtime = runtime.slice(0, start * 2) + value.slice(2).toLowerCase() + runtime.slice((start + length) * 2);
  }
  return `0x${runtime}`;
}

/**
 * The compiler runtime template is embedded in the committed init code. Find the one `length`-byte segment
 * starting at a Solidity free-memory prologue whose keccak equals the committed template hash.
 */
export function runtimeTemplateFromInitCode(initCode: Hex, templateHash: Hex, length: number): Hex {
  assert(Number.isInteger(length) && length > 0, "Runtime template length must be positive");
  const code = initCode.slice(2).toLowerCase();
  const matches: Hex[] = [];
  for (let at = code.indexOf("6080604052"); at >= 0; at = code.indexOf("6080604052", at + 1)) {
    if (at % 2 !== 0 || at + length * 2 > code.length) continue;
    const candidate = `0x${code.slice(at, at + length * 2)}` as Hex;
    if (keccak256(candidate) === templateHash.toLowerCase()) matches.push(candidate);
  }
  assert(matches.length > 0, "Runtime template not found in the factory init code");
  assert.equal(matches.length, 1, "Runtime template match is ambiguous");
  return matches[0];
}

function pushPattern(value: bigint) {
  // Solidity pushes a constant with the shortest PUSHn that holds it.
  let bytes = value.toString(16);
  if (bytes.length % 2) bytes = `0${bytes}`;
  return `${(0x5f + bytes.length / 2).toString(16)}${bytes}`;
}

/** Lists ABI functions, events and errors whose selector or topic is not pushed anywhere in `bytecode`. */
export function missingFromBytecode(abi: Abi, bytecode: Hex): string[] {
  const code = bytecode.slice(2).toLowerCase();
  const signature = (item: { name: string; inputs: readonly AbiParameter[] }) =>
    `${item.name}(${item.inputs.map((input) => input.type).join(",")})`;
  const missing: string[] = [];
  for (const item of abi) {
    if (item.type !== "function" && item.type !== "event" && item.type !== "error") continue;
    const text = signature(item);
    const id = BigInt(item.type === "event" ? toEventSelector(text) : toFunctionSelector(text));
    // A revert builds the error word as PUSH(selector >> k), PUSH1 (224 + k), SHL; the optimizer picks k.
    const patterns = item.type !== "error" ? [pushPattern(id)] : Array.from({ length: 32 }, (_, k) => k)
      .filter((k) => (id >> BigInt(k)) << BigInt(k) === id)
      .map((k) => `${pushPattern(id >> BigInt(k))}60${(224 + k).toString(16)}1b`);
    if (!patterns.some((pattern) => code.includes(pattern))) missing.push(`${item.type} ${text}`);
  }
  return missing;
}

/** Reads an address immutable from deployed runtime; every slot must hold the same left-padded address. */
export function immutableAddress(runtime: Hex, references: Reference[]): Address {
  assert(references.length > 0, "There is no immutable reference to read");
  const words = references.map(({ start, length }) => {
    assert.equal(length, 32);
    assert(2 + (start + length) * 2 <= runtime.length, "Immutable offset is out of bounds");
    return runtime.slice(2 + start * 2, 2 + (start + length) * 2).toLowerCase();
  });
  assert(words.every((word) => word === words[0]), "Immutable slots differ");
  assert.match(words[0], /^0{24}[0-9a-f]{40}$/, "Immutable is not an address");
  return getAddress(`0x${words[0].slice(24)}`);
}

type SourcifyImplementation = {
  abi: readonly { type: string; inputs?: readonly { name?: string; type: string }[] }[];
  creationBytecode: { transformationValues: { constructorArguments?: Hex } };
  runtimeBytecode: { immutableReferences: Record<string, Reference[]>; transformationValues: { immutables?: Record<string, Hex> } };
};

/**
 * The AccountV3 guardian is a private immutable. Take it from the verified constructor arguments and find the
 * runtime immutable slots that carry it, so the caller can read the same value from the deployed code.
 */
export function guardianFromSourcify(verified: SourcifyImplementation) {
  const constructor = verified.abi.find((item) => item.type === "constructor");
  const inputs = (constructor?.inputs ?? []) as readonly AbiParameter[];
  const index = inputs.findIndex((input) => input.name === "guardian" || input.name === "_guardian");
  assert(index >= 0, "The verified constructor has no guardian argument");
  const encoded = verified.creationBytecode.transformationValues.constructorArguments;
  assert(encoded, "The verified creation has no constructor arguments");
  const guardian = getAddress(decodeAbiParameters(inputs, encoded)[index] as Address);
  const word = `0x${"0".repeat(24)}${guardian.slice(2).toLowerCase()}`;
  const ids = Object.entries(verified.runtimeBytecode.transformationValues.immutables ?? {})
    .filter(([, value]) => value.toLowerCase() === word).map(([id]) => id);
  assert.equal(ids.length, 1, "Exactly one runtime immutable must carry the guardian");
  const references = verified.runtimeBytecode.immutableReferences[ids[0]];
  assert(references?.length, "The guardian immutable has no runtime references");
  return { guardian, immutableId: ids[0], references };
}

export function bindSourcifyRuntime(verified: {
  match: string; runtimeMatch: string; runtimeBytecode: { onchainBytecode: Hex };
}, actual: Hex): Hex {
  assert.equal(verified.match, "exact_match", "Sourcify source must have an exact match");
  assert.equal(verified.runtimeMatch, "exact_match", "Sourcify runtime must have an exact match");
  assert(actual !== "0x", "Robinhood runtime is missing");
  assert.equal(actual.toLowerCase(), verified.runtimeBytecode.onchainBytecode.toLowerCase(),
    "Robinhood runtime differs from the Sourcify exact-match runtime including immutables");
  return keccak256(actual);
}

// Comments never change control flow. Blank them but keep every offset and newline, so positions found in the
// blanked text map to the raw source lines recorded as evidence.
function blankComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
}

function closingBrace(source: string, start: number) {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return index;
  }
  throw new Error("Incomplete Solidity function body");
}

/** One complete Solidity function: comment-free code for analysis, plus numbered raw lines for evidence. */
export function solidityFunction(source: string, name: string) {
  const clean = blankComments(source);
  const start = clean.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert(start >= 0, `Solidity function ${name} is missing`);
  const open = clean.indexOf("{", start);
  assert(open >= 0, `Solidity function ${name} has no body`);
  const end = closingBrace(clean, open);
  const startLine = source.slice(0, start).split("\n").length;
  const endLine = source.slice(0, end).split("\n").length;
  const lines = source.split("\n").slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${index === 0 ? line.trimStart() : line}`);
  return { code: clean.slice(start, end + 1), startLine, endLine, lines };
}

export function guardianExecutorSource(source: string) {
  const { code: executorFunction, startLine, endLine, lines } = solidityFunction(source, "_isValidExecutor");
  const branch = /if\s*\(\s*chainId\s*!=\s*block\.chainid\s*\)\s*\{/.exec(executorFunction);
  const trusted = [...executorFunction.matchAll(/guardian\s*\.\s*isTrustedExecutor\s*\(/g)];
  const branchOpen = branch ? executorFunction.indexOf("{", branch.index) : -1;
  const branchEnd = branchOpen < 0 ? -1 : closingBrace(executorFunction, branchOpen);
  return { executorFunction, startLine, endLine, lines, guardianTrustOnlyForForeignChain: trusted.length > 0 && branchOpen >= 0 &&
    trusted.every((call) => call.index! > branchOpen && call.index! < branchEnd) };
}

export function robinhoodUpstreamUrl(key: string | undefined) {
  assert(key && /^[A-Za-z0-9_-]{8,}$/.test(key), "ALCHEMY_API_KEY must be set in .env.fork");
  return `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
}

export function isRateLimited(message: string) {
  return /\b429\b|too many requests|rate[ -]?limit|compute units per second/i.test(message);
}

export function safeForkError(error: unknown, secrets: string[] = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join("[redacted]");
  return message.replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi, "[redacted-url]").slice(0, 4000);
}
