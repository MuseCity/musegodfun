import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { keccak256, toHex, type Hex } from "viem";

type Reference = { start: number; length: number };
type AstNode = { id?: number; name?: string; mutability?: string };
type ForgeArtifact = {
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex; immutableReferences: Record<string, Reference[]> };
  ast: unknown;
};

execFileSync("forge", ["build", "--root", "contracts"], { stdio: "inherit" });
const artifact = (name: string) => JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8")) as ForgeArtifact;
const vault = artifact("MusegodNftFeeVault");
const factory = artifact("MusegodNftFeeVaultFactory");
const source = (file: string) => keccak256(toHex(readFileSync(`contracts/src/${file}`)));

// Forge keys immutable slots by compiler AST id; the AST gives the stable variable name the deployment verifier fills by.
const immutableNames = new Map<number, string>();
const collectImmutables = (node: unknown) => {
  if (!node || typeof node !== "object") return;
  const { id, name, mutability } = node as AstNode;
  if (mutability === "immutable" && typeof id === "number" && typeof name === "string") immutableNames.set(id, name);
  for (const child of Object.values(node)) collectImmutables(child);
};
collectImmutables(factory.ast);
const immutableReferences = Object.fromEntries(Object.entries(factory.deployedBytecode.immutableReferences).map(([id, references]) => {
  const name = immutableNames.get(Number(id));
  assert(name, `Factory immutable ${id} has no AST name`);
  for (const { start, length } of references) {
    assert.equal(factory.deployedBytecode.object.slice(2 + start * 2, 2 + (start + length) * 2), "00".repeat(length),
      `Factory immutable ${name} must be a zero placeholder in the compiler runtime`);
  }
  return [name, references.map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start)] as const;
}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const build = {
  compiler: "0.8.24",
  vaultInitCodeHash: keccak256(vault.bytecode.object),
  factoryBytecode: factory.bytecode.object,
  // The factory's immutable slots are zero-filled in the compiler runtime, so this is a template hash, never an
  // on-chain code hash. The deployed runtime is this template with every immutableReferences slot set to its value.
  factoryRuntimeTemplateHash: keccak256(factory.deployedBytecode.object),
  immutableReferences,
  sourceHashes: {
    "MusegodNftFeeVault.sol": source("MusegodNftFeeVault.sol"),
    "MusegodNftFeeVaultFactory.sol": source("MusegodNftFeeVaultFactory.sol"),
  },
};

type ChainEntry = {
  status: "not_deployed" | "deployed_verified";
  factory: Hex | null;
  factoryRuntimeHash: Hex | null;
  transactionHash: Hex | null;
  blockNumber: number | null;
};
type Manifest = { version: 1; vaultInitCodeHash: Hex; chains: Record<string, ChainEntry> };
const manifestPath = "contracts/artifacts/nft-vault-deployment.json";
let manifest: Manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
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
writeFileSync("contracts/artifacts/nft-vault-build.json", `${JSON.stringify(build, null, 2)}\n`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`vaultInitCodeHash ${build.vaultInitCodeHash}`);
