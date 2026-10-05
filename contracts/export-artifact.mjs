import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { keccak256, stringToHex } from "viem";

const root = dirname(fileURLToPath(import.meta.url));
const built = JSON.parse(await readFile(join(root, "out/MusegodLaunchGuard.sol/MusegodLaunchGuard.json"), "utf8"));
const settings = { ...built.metadata.settings };
delete settings.compilationTarget;
settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } };
const sources = {};
for (const [path, entry] of Object.entries(built.metadata.sources)) {
  const content = await readFile(join(root, path), "utf8");
  assert.equal(keccak256(stringToHex(content)), entry.keccak256, `Stale compiled source: ${path}; run forge build first`);
  sources[path] = { content };
}
const input = { language: "Solidity", sources, settings };
const inputJson = JSON.stringify(input, null, 2) + "\n";
const solc = process.env.SOLC_PATH || join(homedir(), process.platform === "darwin"
  ? "Library/Application Support/svm/0.8.24/solc-0.8.24" : ".svm/0.8.24/solc-0.8.24");
const result = spawnSync(solc, ["--standard-json"], { input: inputJson, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
assert.equal(result.status, 0, result.stderr || "Solc compilation failed");
const output = JSON.parse(result.stdout);
assert(!output.errors?.some((error) => error.severity === "error"), JSON.stringify(output.errors));
const contract = output.contracts["src/MusegodLaunchGuard.sol"].MusegodLaunchGuard;
assert.equal("0x" + contract.evm.bytecode.object, built.bytecode.object, "Standard compiler input must reproduce Forge creation bytecode");
assert.equal("0x" + contract.evm.deployedBytecode.object, built.deployedBytecode.object, "Standard compiler input must reproduce Forge runtime bytecode");
const artifact = {
  contractName: "MusegodLaunchGuard",
  compiler: { version: built.metadata.compiler.version, evmVersion: settings.evmVersion, optimizer: settings.optimizer },
  abi: contract.abi,
  bytecode: "0x" + contract.evm.bytecode.object,
  deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
  immutableReferences: contract.evm.deployedBytecode.immutableReferences,
  compilerInputSha256: createHash("sha256").update(inputJson).digest("hex"),
  creationBytecodeHash: keccak256("0x" + contract.evm.bytecode.object),
  runtimeTemplateHash: keccak256("0x" + contract.evm.deployedBytecode.object),
  dependency: JSON.parse(await readFile(join(root, "lib/openzeppelin-contracts/dependency-lock.json"), "utf8")),
};
await writeFile(join(root, "artifacts/MusegodLaunchGuard.compiler-input.json"), inputJson);
await writeFile(join(root, "artifacts/MusegodLaunchGuard.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify({ artifact: resolve(root, "artifacts/MusegodLaunchGuard.json"), compilerInputSha256: artifact.compilerInputSha256,
  bytecodeBytes: contract.evm.bytecode.object.length / 2, runtimeBytes: contract.evm.deployedBytecode.object.length / 2,
  immutableReferences: artifact.immutableReferences }, null, 2));
