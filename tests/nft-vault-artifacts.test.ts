import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, toHex, type Hex } from "viem";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources = ["MusegodNftFeeVault.sol", "MusegodNftFeeVaultFactory.sol"] as const;
const buildPath = "contracts/artifacts/nft-vault-build.json";
const manifestPath = "contracts/artifacts/nft-vault-deployment.json";
const compilerInputPath = "contracts/artifacts/MusegodNftFeeVaultFactory.compiler-input.json";
type Reference = { start: number; length: number };
type Build = {
  compiler: string;
  vaultInitCodeHash: Hex;
  factoryBytecode: Hex;
  factoryRuntimeTemplateHash: Hex;
  immutableReferences: Record<string, Reference[]>;
  sourceHashes: Record<(typeof sources)[number], Hex>;
  factoryCompilerInputSha256: string;
};
type AstNode = { id?: number; name?: string; mutability?: string; [key: string]: unknown };
type ForgeArtifact = {
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex; immutableReferences: Record<string, Reference[]> };
  ast: AstNode;
  metadata: { compiler: { version: string }; settings: Record<string, unknown>; sources: Record<string, unknown> };
};
type ChainEntry = { status: string; factory: string | null; factoryRuntimeHash: string | null; transactionHash: string | null; blockNumber: number | null };
type Manifest = { version: number; vaultInitCodeHash: Hex; chains: Record<string, ChainEntry> };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;
const artifact = (name: string) => readJson<ForgeArtifact>(`contracts/out/${name}.sol/${name}.json`);
const slice = (code: Hex, { start, length }: Reference) => code.slice(2 + start * 2, 2 + (start + length) * 2);

function findNode(node: unknown, match: (node: AstNode) => boolean): AstNode | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (!Array.isArray(node) && match(node as AstNode)) return node as AstNode;
  for (const child of Object.values(node)) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return undefined;
}

before(() => execFileSync("forge", ["build", "--root", "contracts"], { cwd: root, stdio: "inherit" }));

test("NFT vault build hashes bind both current Solidity sources", () => {
  const build = readJson<Build>(buildPath);
  assert.equal(build.compiler, "0.8.24");
  assert.deepEqual(Object.keys(build.sourceHashes).sort(), [...sources].sort());
  for (const source of sources) {
    assert.equal(build.sourceHashes[source], keccak256(toHex(readFileSync(join(root, "contracts/src", source)))));
  }
});

test("NFT vault build matches Forge creation code and labels the factory runtime hash as a template", () => {
  const build = readJson<Build>(buildPath);
  const vault = artifact("MusegodNftFeeVault");
  const factory = artifact("MusegodNftFeeVaultFactory");
  assert.deepEqual(Object.keys(build), [
    "compiler", "vaultInitCodeHash", "factoryBytecode", "factoryRuntimeTemplateHash", "immutableReferences", "sourceHashes",
    "factoryCompilerInputSha256",
  ]);
  assert.equal(build.vaultInitCodeHash, keccak256(vault.bytecode.object));
  assert.equal(build.factoryBytecode, factory.bytecode.object);
  // The compiler's runtime still has zero-filled immutable slots, so its hash is never an on-chain code hash.
  assert.equal(build.factoryRuntimeTemplateHash, keccak256(factory.deployedBytecode.object));
  assert.equal("factoryRuntimeHash" in build, false);

  assert.deepEqual(Object.keys(build.immutableReferences), ["VAULT_INIT_CODE_HASH"]);
  const [compilerId, compilerReferences] = Object.entries(factory.deployedBytecode.immutableReferences)[0];
  assert.equal(Object.keys(factory.deployedBytecode.immutableReferences).length, 1);
  assert.equal(findNode(factory.ast, (node) => node.id === Number(compilerId) && node.mutability === "immutable")?.name, "VAULT_INIT_CODE_HASH");
  assert.deepEqual(build.immutableReferences.VAULT_INIT_CODE_HASH, [...compilerReferences].sort((a, b) => a.start - b.start));
  assert(build.immutableReferences.VAULT_INIT_CODE_HASH.length > 0);
  for (const reference of build.immutableReferences.VAULT_INIT_CODE_HASH) {
    assert.equal(reference.length, 32);
    assert.equal(slice(factory.deployedBytecode.object, reference), "00".repeat(32));
  }
});

test("NFT vault immutable fill recipe only changes the declared slots", () => {
  // What Task 13's verifier does: write vaultInitCodeHash into every VAULT_INIT_CODE_HASH slot, then hash.
  const build = readJson<Build>(buildPath);
  const template = artifact("MusegodNftFeeVaultFactory").deployedBytecode.object;
  const slots = build.immutableReferences.VAULT_INIT_CODE_HASH;
  let filled: string = template;
  for (const { start, length } of slots) {
    assert.equal(length, 32);
    filled = `${filled.slice(0, 2 + start * 2)}${build.vaultInitCodeHash.slice(2)}${filled.slice(2 + (start + length) * 2)}`;
  }
  assert.equal(filled.length, template.length);
  assert.notEqual(keccak256(filled as Hex), build.factoryRuntimeTemplateHash);
  for (const reference of slots) assert.equal(slice(filled as Hex, reference), build.vaultInitCodeHash.slice(2));
  const covered = new Set(slots.flatMap(({ start, length }) => Array.from({ length }, (_, offset) => start + offset)));
  for (let byte = 0; byte < (template.length - 2) / 2; byte++) {
    if (!covered.has(byte)) assert.equal(filled.slice(2 + byte * 2, 4 + byte * 2), template.slice(2 + byte * 2, 4 + byte * 2));
  }
});

test("NFT vault Sourcify compiler input reproduces the Forge factory and vault code and its SHA-256 is recorded", () => {
  const build = readJson<Build>(buildPath);
  const text = readFileSync(join(root, compilerInputPath), "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), build.factoryCompilerInputSha256);
  const input = JSON.parse(text) as { language: string; sources: Record<string, { content: string }>; settings: Record<string, unknown> };
  const factory = artifact("MusegodNftFeeVaultFactory");
  assert.equal(input.language, "Solidity");
  // The settings are the compiler metadata's own (Sourcify reproduces the metadata hash from them), minus the target it adds itself.
  const { compilationTarget, ...settings } = factory.metadata.settings;
  assert.deepEqual(compilationTarget, { "src/MusegodNftFeeVaultFactory.sol": "MusegodNftFeeVaultFactory" });
  assert.deepEqual({ ...input.settings, outputSelection: undefined }, { ...settings, outputSelection: undefined });
  assert.deepEqual(Object.keys(input.sources), Object.keys(factory.metadata.sources));
  for (const [path, { content }] of Object.entries(input.sources)) assert.equal(content, readFileSync(join(root, "contracts", path), "utf8"), path);
  const solc = process.env.SOLC_PATH || join(homedir(), process.platform === "darwin"
    ? "Library/Application Support/svm/0.8.24/solc-0.8.24" : ".svm/0.8.24/solc-0.8.24");
  const compiled = spawnSync(solc, ["--standard-json"], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const output = JSON.parse(compiled.stdout) as { errors?: { severity: string }[];
    contracts: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  assert(!output.errors?.some((error) => error.severity === "error"), JSON.stringify(output.errors));
  const compiledFactory = output.contracts["src/MusegodNftFeeVaultFactory.sol"].MusegodNftFeeVaultFactory.evm;
  assert.equal(`0x${compiledFactory.bytecode.object}`, build.factoryBytecode);
  assert.equal(`0x${compiledFactory.deployedBytecode.object}`, factory.deployedBytecode.object);
  assert.equal(keccak256(`0x${output.contracts["src/MusegodNftFeeVault.sol"].MusegodNftFeeVault.evm.bytecode.object}`), build.vaultInitCodeHash);
});

const NOT_DEPLOYED = { status: "not_deployed", factory: null, factoryRuntimeHash: null, transactionHash: null, blockNumber: null };

test("NFT vault manifest keeps Base undeployed and Robinhood undeployed or backed by its verification evidence", () => {
  const build = readJson<Build>(buildPath);
  const manifest = readJson<Manifest>(manifestPath);
  assert.deepEqual(Object.keys(manifest), ["version", "vaultInitCodeHash", "chains"]);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.vaultInitCodeHash, build.vaultInitCodeHash);
  assert.deepEqual(Object.keys(manifest.chains), ["4663", "8453"]);
  assert.deepEqual(manifest.chains["8453"], NOT_DEPLOYED);
  const robinhood = manifest.chains["4663"];
  if (robinhood.status === "not_deployed") {
    assert.deepEqual(robinhood, NOT_DEPLOYED);
    return;
  }
  // Written only by `scripts/deploy-nft-vault.ts --verify` against Robinhood mainnet, together with its evidence.
  assert.deepEqual(Object.keys(robinhood), ["status", "factory", "factoryRuntimeHash", "transactionHash", "blockNumber"]);
  assert.equal(robinhood.status, "deployed_verified");
  assert.equal(robinhood.factory, getAddress(robinhood.factory!));
  assert.match(robinhood.factoryRuntimeHash!, /^0x[0-9a-f]{64}$/);
  assert.match(robinhood.transactionHash!, /^0x[0-9a-f]{64}$/);
  assert(Number.isSafeInteger(robinhood.blockNumber) && robinhood.blockNumber! > 0);
  const evidence = readJson<{ chainId: number; rehearsal: boolean; node: string; factory: string; runtimeHash: string; transactionHash: string;
    blockNumber: string; manifestEntry: ChainEntry; checks: Record<string, boolean> }>("docs/evidence/nft-vault-factory-4663.json");
  assert.equal(evidence.chainId, 4663);
  assert.equal(evidence.rehearsal, false);
  assert.equal(evidence.node, "mainnet", "only a proven Robinhood mainnet endpoint may record the factory");
  assert.equal(evidence.checks.finalConfirmations, true);
  assert.deepEqual(evidence.manifestEntry, robinhood);
  assert.equal(evidence.factory, robinhood.factory);
  assert.equal(evidence.runtimeHash, robinhood.factoryRuntimeHash);
  assert.equal(evidence.transactionHash, robinhood.transactionHash);
  assert.equal(evidence.blockNumber, String(robinhood.blockNumber));
  assert(Object.values(evidence.checks).length > 0 && Object.values(evidence.checks).every((passed) => passed === true));
});

// Each fixture is a throw-away Forge project (current sources, the shared OpenZeppelin lib) in a temp directory,
// so the real contracts/out and the committed artifacts are never written by these tests.
function withFixture(manifest: string | null, check: (fixture: string) => void) {
  const fixture = mkdtempSync(join(tmpdir(), "nft-vault-artifacts-"));
  try {
    mkdirSync(join(fixture, "contracts/src"), { recursive: true });
    mkdirSync(join(fixture, "contracts/artifacts"), { recursive: true });
    copyFileSync(join(root, "contracts/foundry.toml"), join(fixture, "contracts/foundry.toml"));
    symlinkSync(join(root, "contracts/lib"), join(fixture, "contracts/lib"));
    for (const source of sources) copyFileSync(join(root, "contracts/src", source), join(fixture, "contracts/src", source));
    if (manifest !== null) writeFileSync(join(fixture, manifestPath), manifest);
    check(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function runBuild(fixture: string) {
  return spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "scripts/build-nft-vault.ts")], {
    cwd: fixture, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

test("NFT vault build is byte-reproducible from a clean compile and equals the committed artifacts", () => {
  const committed = {
    build: readFileSync(join(root, buildPath), "utf8"),
    manifest: readFileSync(join(root, manifestPath), "utf8"),
    compilerInput: readFileSync(join(root, compilerInputPath), "utf8"),
  };
  withFixture(committed.manifest, (fixture) => {
    const outputs: { build: string; manifest: string; compilerInput: string }[] = [];
    for (const run of [1, 2]) {
      // Run 2 starts without Forge's out/ and cache/, so it recompiles from scratch rather than reusing run 1.
      rmSync(join(fixture, "contracts/out"), { recursive: true, force: true });
      rmSync(join(fixture, "contracts/cache"), { recursive: true, force: true });
      const result = runBuild(fixture);
      assert.equal(result.status, 0, `run ${run}: ${result.stderr}`);
      assert.match(result.stdout, /vaultInitCodeHash 0x[0-9a-f]{64}/);
      outputs.push({
        build: readFileSync(join(fixture, buildPath), "utf8"),
        manifest: readFileSync(join(fixture, manifestPath), "utf8"),
        compilerInput: readFileSync(join(fixture, compilerInputPath), "utf8"),
      });
    }
    assert.equal(outputs[1].build, outputs[0].build);
    assert.equal(outputs[1].manifest, outputs[0].manifest);
    assert.equal(outputs[1].compilerInput, outputs[0].compilerInput);
    assert.equal(outputs[0].build, committed.build, "committed nft-vault-build.json is stale; run npm run build:nft-vault");
    assert.equal(outputs[0].manifest, committed.manifest, "committed nft-vault-deployment.json is stale; run npm run build:nft-vault");
    assert.equal(outputs[0].compilerInput, committed.compilerInput,
      "committed MusegodNftFeeVaultFactory.compiler-input.json is stale; run npm run build:nft-vault");
  });
  assert.equal(readFileSync(join(root, buildPath), "utf8"), committed.build);
  assert.equal(readFileSync(join(root, manifestPath), "utf8"), committed.manifest);
  assert.equal(readFileSync(join(root, compilerInputPath), "utf8"), committed.compilerInput);
});

test("NFT vault build creates the undeployed two-chain manifest when none exists", () => {
  withFixture(null, (fixture) => {
    const result = runBuild(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture, manifestPath), "utf8")), {
      version: 1, vaultInitCodeHash: readJson<Build>(buildPath).vaultInitCodeHash, chains: { "4663": NOT_DEPLOYED, "8453": NOT_DEPLOYED },
    });
  });
});

test("NFT vault build rejects corrupt manifests before writing either artifact", () => {
  const corrupt = "{ broken manifest\n";
  withFixture(corrupt, (fixture) => {
    writeFileSync(join(fixture, buildPath), "existing build must survive rejection\n");
    const result = runBuild(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SyntaxError/);
    assert.equal(readFileSync(join(fixture, buildPath), "utf8"), "existing build must survive rejection\n");
    assert.equal(readFileSync(join(fixture, manifestPath), "utf8"), corrupt);
    assert.equal(existsSync(join(fixture, compilerInputPath)), false);
  });
});

test("NFT vault build preserves deployed entries and refuses changed init code before writes", () => {
  const build = readJson<Build>(buildPath);
  const manifest = readJson<Manifest>(manifestPath);
  manifest.chains["4663"] = {
    status: "deployed_verified", factory: "0x1111111111111111111111111111111111111111",
    factoryRuntimeHash: `0x${"12".repeat(32)}`, transactionHash: `0x${"34".repeat(32)}`, blockNumber: 123,
  };
  withFixture(JSON.stringify(manifest), (fixture) => {
    const result = runBuild(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture, manifestPath), "utf8")), manifest);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture, buildPath), "utf8")), build);
  });
  manifest.vaultInitCodeHash = `0x${"56".repeat(32)}`;
  const stale = JSON.stringify(manifest);
  withFixture(stale, (fixture) => {
    writeFileSync(join(fixture, buildPath), "existing build must survive rejection\n");
    const result = runBuild(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /vault bytecode changed after a factory was deployed/);
    assert.equal(readFileSync(join(fixture, buildPath), "utf8"), "existing build must survive rejection\n");
    assert.equal(readFileSync(join(fixture, manifestPath), "utf8"), stale);
    assert.equal(existsSync(join(fixture, compilerInputPath)), false);
  });
});
