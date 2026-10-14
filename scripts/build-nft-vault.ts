import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { keccak256, toHex, type Hex } from "viem";

type Reference = { start: number; length: number };
type AstNode = { id?: number; name?: string; mutability?: string };
type ForgeArtifact = {
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex; immutableReferences: Record<string, Reference[]> };
  ast: unknown;
  metadata: { compiler: { version: string }; settings: Record<string, unknown>; sources: Record<string, unknown> };
};
export type NftVaultBuild = {
  compiler: string;
  vaultInitCodeHash: Hex;
  factoryBytecode: Hex;
  factoryRuntimeTemplateHash: Hex;
  immutableReferences: Record<string, Reference[]>;
  sourceHashes: Record<string, Hex>;
  factoryCompilerInputSha256: string;
};
export type NftVaultCompilation = {
  build: NftVaultBuild;
  /** Standard JSON input for Sourcify, exactly as committed. */
  compilerInput: string;
  /** The factory's compiler runtime, immutable slots zero-filled. */
  factoryRuntimeTemplate: Hex;
  /** Full solc version, e.g. 0.8.24+commit.e11b9ed9. */
  compilerVersion: string;
};
export const NFT_VAULT_PATHS = {
  build: "contracts/artifacts/nft-vault-build.json",
  manifest: "contracts/artifacts/nft-vault-deployment.json",
  compilerInput: "contracts/artifacts/MusegodNftFeeVaultFactory.compiler-input.json",
} as const;
export const FACTORY_CONTRACT = { source: "src/MusegodNftFeeVaultFactory.sol", name: "MusegodNftFeeVaultFactory" } as const;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export function solcPath() {
  return process.env.SOLC_PATH || join(homedir(), process.platform === "darwin"
    ? "Library/Application Support/svm/0.8.24/solc-0.8.24" : ".svm/0.8.24/solc-0.8.24");
}

/** Forge keys immutable slots by compiler AST id; the AST gives the stable variable name the deployment verifier fills by. */
function namedImmutableReferences(factory: ForgeArtifact) {
  const immutableNames = new Map<number, string>();
  const collectImmutables = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const { id, name, mutability } = node as AstNode;
    if (mutability === "immutable" && typeof id === "number" && typeof name === "string") immutableNames.set(id, name);
    for (const child of Object.values(node)) collectImmutables(child);
  };
  collectImmutables(factory.ast);
  return Object.fromEntries(Object.entries(factory.deployedBytecode.immutableReferences).map(([id, references]) => {
    const name = immutableNames.get(Number(id));
    assert(name, `Factory immutable ${id} has no AST name`);
    for (const { start, length } of references) {
      assert.equal(factory.deployedBytecode.object.slice(2 + start * 2, 2 + (start + length) * 2), "00".repeat(length),
        `Factory immutable ${name} must be a zero placeholder in the compiler runtime`);
    }
    return [name, references.map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start)] as const;
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The factory's standard JSON input: its own compiler metadata settings and source closure, as the launch guard exports it. */
export function factoryCompilerInput(factory: ForgeArtifact, readSource: (path: string) => string): string {
  const settings: Record<string, unknown> = { ...factory.metadata.settings };
  assert.deepEqual(settings.compilationTarget, { [FACTORY_CONTRACT.source]: FACTORY_CONTRACT.name }, "Unexpected factory compilation target");
  delete settings.compilationTarget;
  settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"], "": ["ast"] } };
  const sources = Object.fromEntries(Object.keys(factory.metadata.sources).map((path) => [path, { content: readSource(path) }]));
  return `${JSON.stringify({ language: "Solidity", sources, settings }, null, 2)}\n`;
}

/** Compiles the standard JSON input with the pinned solc and requires it to reproduce Forge's factory and vault code exactly. */
function assertCompilerInputReproduces(input: string, factory: ForgeArtifact, vault: ForgeArtifact) {
  const result = spawnSync(solcPath(), ["--standard-json"], { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || "solc --standard-json failed");
  const output = JSON.parse(result.stdout) as { errors?: { severity: string }[];
    contracts: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  assert(!output.errors?.some((error) => error.severity === "error"), JSON.stringify(output.errors));
  const compiled = output.contracts[FACTORY_CONTRACT.source]?.[FACTORY_CONTRACT.name]?.evm;
  assert.equal(`0x${compiled?.bytecode.object}`, factory.bytecode.object, "The compiler input must reproduce the factory creation code");
  assert.equal(`0x${compiled?.deployedBytecode.object}`, factory.deployedBytecode.object, "The compiler input must reproduce the factory runtime");
  assert.equal(`0x${output.contracts["src/MusegodNftFeeVault.sol"]?.MusegodNftFeeVault?.evm.bytecode.object}`, vault.bytecode.object,
    "The compiler input must reproduce the vault creation code");
}

/** Runs Forge (writing only the ignored contracts/out and cache), then derives every committed build artifact in memory. */
export function compileNftVault(options: { root?: string; offline?: boolean; quiet?: boolean } = {}): NftVaultCompilation {
  const root = options.root ?? process.cwd();
  execFileSync("forge", ["build", "--root", "contracts", ...(options.offline ? ["--offline"] : [])],
    { cwd: root, stdio: options.quiet ? ["ignore", 2, 2] : "inherit" });
  const artifact = (name: string) => JSON.parse(readFileSync(join(root, `contracts/out/${name}.sol/${name}.json`), "utf8")) as ForgeArtifact;
  const vault = artifact("MusegodNftFeeVault");
  const factory = artifact(FACTORY_CONTRACT.name);
  const source = (file: string) => keccak256(toHex(readFileSync(join(root, "contracts/src", file))));
  const compilerInput = factoryCompilerInput(factory, (path) => readFileSync(join(root, "contracts", path), "utf8"));
  assertCompilerInputReproduces(compilerInput, factory, vault);
  const build: NftVaultBuild = {
    compiler: "0.8.24",
    vaultInitCodeHash: keccak256(vault.bytecode.object),
    factoryBytecode: factory.bytecode.object,
    // The factory's immutable slots are zero-filled in the compiler runtime, so this is a template hash, never an
    // on-chain code hash. The deployed runtime is this template with every immutableReferences slot set to its value.
    factoryRuntimeTemplateHash: keccak256(factory.deployedBytecode.object),
    immutableReferences: namedImmutableReferences(factory),
    sourceHashes: {
      "MusegodNftFeeVault.sol": source("MusegodNftFeeVault.sol"),
      "MusegodNftFeeVaultFactory.sol": source("MusegodNftFeeVaultFactory.sol"),
    },
    factoryCompilerInputSha256: sha256(compilerInput),
  };
  return { build, compilerInput, factoryRuntimeTemplate: factory.deployedBytecode.object, compilerVersion: factory.metadata.compiler.version };
}

type ChainEntry = {
  status: "not_deployed" | "deployed_verified";
  factory: Hex | null;
  factoryRuntimeHash: Hex | null;
  transactionHash: Hex | null;
  blockNumber: number | null;
};
type Manifest = { version: 1; vaultInitCodeHash: Hex; chains: Record<string, ChainEntry> };

function main() {
  const { build, compilerInput } = compileNftVault();
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(NFT_VAULT_PATHS.manifest, "utf8")) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manifest = {
      version: 1,
      vaultInitCodeHash: build.vaultInitCodeHash,
      chains: Object.fromEntries(["4663", "8453"].map((id) => [id, {
        status: "not_deployed", factory: null, factoryRuntimeHash: null, transactionHash: null, blockNumber: null,
      }])) as Record<string, ChainEntry>,
    };
  }
  assert(manifest && manifest.version === 1 && /^0x[0-9a-fA-F]{64}$/.test(manifest.vaultInitCodeHash)
    && manifest.chains && typeof manifest.chains === "object" && !Array.isArray(manifest.chains)
    && manifest.chains["4663"] && manifest.chains["8453"], "Invalid NFT vault deployment manifest");
  for (const entry of Object.values(manifest.chains)) {
    assert(entry && (entry.status === "not_deployed" || entry.status === "deployed_verified"), "Invalid NFT vault deployment status");
    if (entry.status === "not_deployed") {
      assert([entry.factory, entry.factoryRuntimeHash, entry.transactionHash, entry.blockNumber].every((value) => value === null),
        "Undeployed NFT vault entries must have null deployment fields");
    } else {
      assert(typeof entry.factory === "string" && /^0x[0-9a-fA-F]{40}$/.test(entry.factory)
        && typeof entry.factoryRuntimeHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(entry.factoryRuntimeHash),
      "Verified NFT vault entries must retain their factory and runtime hash");
    }
  }
  if (manifest.vaultInitCodeHash !== build.vaultInitCodeHash && Object.values(manifest.chains).some((entry) => entry.status !== "not_deployed")) {
    throw new Error("The vault bytecode changed after a factory was deployed; a new factory deployment and manifest are required.");
  }
  manifest.vaultInitCodeHash = build.vaultInitCodeHash;
  mkdirSync("contracts/artifacts", { recursive: true });
  writeFileSync(NFT_VAULT_PATHS.build, `${JSON.stringify(build, null, 2)}\n`);
  writeFileSync(NFT_VAULT_PATHS.compilerInput, compilerInput);
  writeFileSync(NFT_VAULT_PATHS.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`vaultInitCodeHash ${build.vaultInitCodeHash}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
