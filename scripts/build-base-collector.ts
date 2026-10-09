import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { keccak256, type Hex } from "viem";

execFileSync("forge", ["build", "--root", "contracts"], { stdio: "inherit" });
for (const name of ["MusegodBaseFeeCollector"]) {
const source = `src/${name}.sol`;
const target = "contracts/artifacts/base-collector";
const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, "utf8"));
const builds = await Promise.all((await readdir("contracts/out/build-info")).filter((file) => file.endsWith(".json"))
  .map(async (file) => JSON.parse(await readFile(`contracts/out/build-info/${file}`, "utf8"))));
const build = builds.find((entry) => entry.output.contracts?.[source]?.[name]?.evm?.bytecode?.object === artifact.bytecode.object.replace(/^0x/, ""));
assert(build, "Missing exact Forge compiler input");
const sources = Object.fromEntries(await Promise.all(Object.keys(artifact.metadata.sources).map(async (path) => {
  const content = await readFile(`contracts/${path}`, "utf8");
  assert.equal(build.input.sources[path]?.content, content, `Stale source: ${path}`);
  return [path, { content }];
})));
const settings = { ...artifact.metadata.settings };
delete settings.compilationTarget;
settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"], "": ["ast"] } };
const compilerInput = JSON.stringify({ language: "Solidity", settings, sources }, null, 2) + "\n";
const solc = process.env.SOLC_PATH || join(homedir(), process.platform === "darwin"
  ? "Library/Application Support/svm/0.8.24/solc-0.8.24" : ".svm/0.8.24/solc-0.8.24");
const compilation = spawnSync(solc, ["--standard-json"], { input: compilerInput, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
assert.equal(compilation.status, 0, compilation.stderr);
const verified = JSON.parse(compilation.stdout);
assert(!verified.errors?.some((error: { severity: string }) => error.severity === "error"), JSON.stringify(verified.errors));
const contract = verified.contracts[source][name];
assert.equal(`0x${contract.evm.bytecode.object}`, artifact.bytecode.object, "Compiler input must reproduce creation bytecode");
assert.equal(`0x${contract.evm.deployedBytecode.object}`, artifact.deployedBytecode.object, "Compiler input must reproduce runtime bytecode");
assert(contract.evm.deployedBytecode.object.length / 2 <= 24_576, "Collector runtime exceeds EIP-170");
const immutableASTbindings: Record<string, { name: string; type: string }> = {};
const visit = (node: unknown) => {
  if (!node || typeof node !== "object") return;
  const value = node as Record<string, unknown>;
  if (value.nodeType === "VariableDeclaration" && value.mutability === "immutable") {
    immutableASTbindings[String(value.id)] = { name: String(value.name), type: String((value.typeDescriptions as { typeString: string }).typeString) };
  }
  for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else if (typeof child === "object") visit(child);
};
for (const entry of Object.values(verified.sources) as { ast: unknown }[]) visit(entry.ast);
await mkdir(target, { recursive: true });
await writeFile(`${target}/${name}.compiler-input.json`, compilerInput);
await writeFile(`${target}/${name}.json`, JSON.stringify({
  contractName: name, abi: artifact.abi, bytecode: artifact.bytecode.object, deployedBytecode: artifact.deployedBytecode.object,
  compiler: { version: artifact.metadata.compiler.version }, compilerInputSha256: createHash("sha256").update(compilerInput).digest("hex"),
  creationBytecodeHash: keccak256(artifact.bytecode.object as Hex), immutableReferences: contract.evm.deployedBytecode.immutableReferences, immutableASTbindings,
}, null, 2) + "\n");
console.log(`Verified ${name}: ${contract.evm.deployedBytecode.object.length / 2} runtime bytes; no deployment executed.`);
}
