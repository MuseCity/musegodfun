import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { encodeAbiParameters, getAddress, keccak256, pad, type Hex } from "viem";
import {
  bindSourcifyRuntime, factoryAbi, guardianExecutorSource, guardianFromSourcify, immutableAddress, isRateLimited,
  missingFromBytecode, patchImmutableRuntime, robinhoodUpstreamUrl, runtimeTemplateFromInitCode, safeForkError,
  solidityFunction, vaultAbi,
} from "../scripts/nft-vault-fork-helpers";

type Build = { factoryBytecode: Hex; vaultInitCodeHash: Hex; factoryRuntimeTemplateHash: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]> };
const build = JSON.parse(readFileSync("contracts/artifacts/nft-vault-build.json", "utf8")) as Build;
// Deployed factory runtime length; equals the compiler runtime length (immutables keep their size).
const FACTORY_RUNTIME_LENGTH = 4609;

test("fork gate code has no address formula of its own and uses the Task 3 library", () => {
  for (const file of ["scripts/nft-vault-fork-helpers.ts", "scripts/test-nft-vault-fork.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /getContractAddress|3d60ad80600a3d3981f3/, `${file} must not re-derive CREATE2 addresses`);
  }
  assert.match(readFileSync("scripts/test-nft-vault-fork.ts", "utf8"), /from "\.\.\/src\/lib\/nft-mode"/);
});

test("factory runtime patch binds repeated compiler immutable offsets without changing other bytes", () => {
  const hash = keccak256("0x01");
  const template = `0x60${"00".repeat(32)}61${"00".repeat(32)}00` as Hex;
  assert.equal(patchImmutableRuntime(template, { "42": [{ start: 1, length: 32 }, { start: 34, length: 32 }] }, hash),
    `0x60${hash.slice(2)}61${hash.slice(2)}00`);
  assert.throws(() => patchImmutableRuntime(template, {}, hash), /one immutable/);
  assert.throws(() => patchImmutableRuntime(template, { "42": [{ start: 1, length: 32 }], "43": [{ start: 34, length: 32 }] }, hash), /one immutable/);
  assert.throws(() => patchImmutableRuntime("0x6000", { "42": [{ start: 1, length: 32 }] }, hash), /out of bounds/);
  assert.throws(() => patchImmutableRuntime(`0x60${"ff".repeat(32)}` as Hex, { "42": [{ start: 1, length: 32 }] }, hash), /zero placeholder/);
});

test("the committed factory init code yields the committed runtime template and its fill recipe", () => {
  const template = runtimeTemplateFromInitCode(build.factoryBytecode, build.factoryRuntimeTemplateHash, FACTORY_RUNTIME_LENGTH);
  assert.equal(keccak256(template), build.factoryRuntimeTemplateHash);
  const runtime = patchImmutableRuntime(template, build.immutableReferences, build.vaultInitCodeHash);
  assert.equal(runtime.length, template.length);
  const slots = build.immutableReferences.VAULT_INIT_CODE_HASH;
  assert.deepEqual(slots.map(({ start }) => start), [190, 1115]);
  let unpatched = runtime.slice(2);
  for (const { start, length } of slots) {
    assert.equal(`0x${runtime.slice(2 + start * 2, 2 + (start + length) * 2)}`, build.vaultInitCodeHash);
    unpatched = unpatched.slice(0, start * 2) + "00".repeat(length) + unpatched.slice((start + length) * 2);
  }
  assert.equal(`0x${unpatched}`, template, "only the declared immutable slots change");
});

test("runtime template extraction requires exactly one hash-bound match", () => {
  const runtime = "0x6080604052aabbcc" as Hex;
  const initCode = `0x6001600255${runtime.slice(2)}ffff` as Hex;
  assert.equal(runtimeTemplateFromInitCode(initCode, keccak256(runtime), 8), runtime);
  assert.throws(() => runtimeTemplateFromInitCode(initCode, keccak256("0x01"), 8), /not found/);
  assert.throws(() => runtimeTemplateFromInitCode(`0x${runtime.slice(2)}${runtime.slice(2)}` as Hex, keccak256(runtime), 8), /ambiguous/);
  assert.throws(() => runtimeTemplateFromInitCode(initCode, keccak256(runtime), 0), /length/);
});

test("hand-written factory and vault ABIs match selectors, events and errors in the committed bytecode", () => {
  assert.deepEqual(missingFromBytecode([...factoryAbi, ...vaultAbi], build.factoryBytecode), []);
  assert.deepEqual(missingFromBytecode([{ type: "function", name: "notInTheVault", inputs: [], outputs: [], stateMutability: "view" }],
    build.factoryBytecode), ["function notInTheVault()"]);
});

test("immutable address reads require every slot to hold the same left-padded address", () => {
  const guardian = getAddress("0x2fe5ccb0d7ea195feb87987d3573f9fcce2b5d57");
  const word = pad(guardian, { size: 32 }).slice(2);
  const runtime = `0x60${word}61${word}00` as Hex;
  assert.equal(immutableAddress(runtime, [{ start: 1, length: 32 }, { start: 34, length: 32 }]), guardian);
  assert.throws(() => immutableAddress(`0x60${word}61${"11".repeat(32)}00` as Hex, [{ start: 1, length: 32 }, { start: 34, length: 32 }]), /differ/);
  assert.throws(() => immutableAddress(`0x60${"11".repeat(32)}` as Hex, [{ start: 1, length: 32 }]), /address/);
  assert.throws(() => immutableAddress(runtime, []), /no immutable/);
});

test("the guardian comes from the verified constructor arguments and its runtime immutable slots", () => {
  const guardian = getAddress("0x2fe5ccb0d7ea195feb87987d3573f9fcce2b5d57");
  const args = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
    ["0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", "0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD",
      "0x000000006551c19487814612e58FE06813775758", guardian]);
  const verified = {
    abi: [{ type: "constructor", inputs: ["entryPoint_", "multicallForwarder", "erc6551Registry", "guardian"].map((name) => ({ name, type: "address" })) }],
    creationBytecode: { transformationValues: { constructorArguments: args } },
    runtimeBytecode: { immutableReferences: { "4442": [{ start: 6800, length: 32 }, { start: 7787, length: 32 }], "1": [{ start: 3, length: 32 }] },
      transformationValues: { immutables: { "4442": pad(guardian, { size: 32 }), "1": pad("0x01", { size: 32 }) } } },
  };
  assert.deepEqual(guardianFromSourcify(verified), { guardian, immutableId: "4442", references: [{ start: 6800, length: 32 }, { start: 7787, length: 32 }] });
  assert.throws(() => guardianFromSourcify({ ...verified, abi: [{ type: "constructor", inputs: [] }] }), /guardian/);
  assert.throws(() => guardianFromSourcify({ ...verified, runtimeBytecode: { ...verified.runtimeBytecode, transformationValues: { immutables: {} } } }), /immutable/);
});

test("Sourcify binding rejects unverified sources and any deployed runtime difference", () => {
  const verified = { match: "exact_match", runtimeMatch: "exact_match", runtimeBytecode: { onchainBytecode: "0x60016000" as Hex } };
  assert.equal(bindSourcifyRuntime(verified, "0x60016000"), keccak256("0x60016000"));
  assert.throws(() => bindSourcifyRuntime({ ...verified, match: "match" }, "0x60016000"), /exact/);
  assert.throws(() => bindSourcifyRuntime(verified, "0x60026000"), /runtime/);
  assert.throws(() => bindSourcifyRuntime(verified, "0x"), /runtime/);
});

test("guardian source extraction includes the entire executor decision and cross-chain boundary", () => {
  const source = `contract AccountV3 { function _isValidExecutor(address executor) internal view returns (bool) {
    if (chainId != block.chainid) { if (guardian.isTrustedExecutor(executor)) return true; }
    if (executor == _owner) return true; return false;
  } function another() external {} }`;
  const review = guardianExecutorSource(source);
  assert.equal(review.guardianTrustOnlyForForeignChain, true);
  assert.match(review.executorFunction, /executor == _owner/);
  assert.doesNotMatch(review.executorFunction, /another/);
  const unsafe = source.replace("if (chainId != block.chainid)", "if (true)");
  assert.equal(guardianExecutorSource(unsafe).guardianTrustOnlyForForeignChain, false);
  assert.equal(guardianExecutorSource(source.replace("return false;", "if (guardian.isTrustedExecutor(executor)) return true; return false;")).guardianTrustOnlyForForeignChain, false);
  // A commented-out guard does not count as code.
  const commented = source.replace("if (chainId != block.chainid) {", "// if (chainId != block.chainid) {\n {");
  assert.equal(guardianExecutorSource(commented).guardianTrustOnlyForForeignChain, false);
});

test("Solidity function extraction keeps raw source lines and numbers for evidence", () => {
  const source = "contract A {\n  // note } brace in a comment\n  function f(uint x) internal {\n    if (x > 0) { x = 1; } // keep\n  }\n  function g() external {}\n}";
  const f = solidityFunction(source, "f");
  assert.equal(f.startLine, 3);
  assert.equal(f.endLine, 5);
  assert.deepEqual(f.lines, ["3: function f(uint x) internal {", "4:     if (x > 0) { x = 1; } // keep", "5:   }"]);
  assert.doesNotMatch(f.code, /keep/);
  assert.throws(() => solidityFunction(source, "missing"), /missing/);
});

test("failure evidence excludes provider URLs and secret values, and rate limits are recognised", () => {
  const secret = "unitTestSecretValue123";
  const message = safeForkError(new Error(`RPC ${robinhoodUpstreamUrl(secret)} failed ${secret}`), [secret]);
  assert.doesNotMatch(message, /alchemy|unitTestSecretValue123|https:/);
  assert.match(message, /redacted/);
  assert.throws(() => robinhoodUpstreamUrl(""), /ALCHEMY_API_KEY/);
  assert.throws(() => robinhoodUpstreamUrl("a/b?c"), /ALCHEMY_API_KEY/);
  for (const text of ["HTTP request failed. Status: 429", "Your app has exceeded its compute units per second capacity", "Too Many Requests", "rate limit exceeded"])
    assert.equal(isRateLimited(text), true, text);
  assert.equal(isRateLimited("execution reverted: NotAuthorized()"), false);
});
