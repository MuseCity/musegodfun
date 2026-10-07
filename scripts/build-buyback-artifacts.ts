import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { keccak256, type Hex } from "viem";

execFileSync("forge", ["build", "--root", "contracts"], { stdio: "inherit" });
const target = "contracts/artifacts/buyback-v2";
await mkdir(target, { recursive: true });
const builds = await Promise.all((await readdir("contracts/out/build-info")).filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(`contracts/out/build-info/${f}`, "utf8"))));
for (const name of ["MusegodAssetFeedOracle", "MusegodBuybackBudgetVault", "MusegodFeeEngine", "MusegodWethForwarder"]) {
  const source = `src/${name}.sol`;
  const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, "utf8"));
  const build = builds.find((b) => b.output.contracts?.[source]?.[name]?.evm?.bytecode?.object === artifact.bytecode.object.replace(/^0x/, "") && b.input.sources[source]?.content !== undefined);
  if (!build) throw new Error(`Missing exact compiler input for ${name}`);
  const dependencies = Object.keys(artifact.metadata.sources);
  const settings = { ...artifact.metadata.settings };
  delete settings.compilationTarget;
  settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"], "": ["ast"] } };
  const input = { language: "Solidity", settings, sources: Object.fromEntries(dependencies.map((key) => [key, { content: build.input.sources[key].content }])) };
  for (const key of dependencies) if (input.sources[key]?.content !== await readFile(`contracts/${key}`, "utf8")) throw new Error(`Stale compiler input: ${key}`);
  const compilerInput = JSON.stringify(input, null, 2) + "\n";
  const solc = process.env.SOLC_PATH || join(homedir(), process.platform === "darwin"
    ? "Library/Application Support/svm/0.8.24/solc-0.8.24" : ".svm/0.8.24/solc-0.8.24");
  const compiled = spawnSync(solc, ["--standard-json"], { input: compilerInput, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const verified = JSON.parse(compiled.stdout);
  assert(!verified.errors?.some((error: { severity: string }) => error.severity === "error"), JSON.stringify(verified.errors));
  const contract = verified.contracts[source][name];
  assert.equal("0x" + contract.evm.bytecode.object, artifact.bytecode.object, "Compiler input must reproduce Forge creation bytecode");
  assert.equal("0x" + contract.evm.deployedBytecode.object, artifact.deployedBytecode.object, "Compiler input must reproduce Forge runtime bytecode");
  const bindings: Record<string, { name: string; type: string }> = {};
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") bindings[String(node.id)] = { name: node.name, type: node.typeDescriptions.typeString };
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (typeof value === "object") visit(value);
  };
  visit(verified.sources[source].ast);
  const output = { contractName: name, abi: artifact.abi, bytecode: artifact.bytecode.object, deployedBytecode: artifact.deployedBytecode.object,
    compiler: { version: artifact.metadata.compiler.version }, compilerInputSha256: createHash("sha256").update(compilerInput).digest("hex"),
    creationBytecodeHash: keccak256(artifact.bytecode.object as Hex), immutableReferences: contract.evm.deployedBytecode.immutableReferences, immutableASTbindings: bindings };
  await writeFile(`${target}/${name}.compiler-input.json`, compilerInput);
  await writeFile(`${target}/${name}.json`, JSON.stringify(output, null, 2) + "\n");
}
