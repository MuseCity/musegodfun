import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import type { NftVaultBuild } from "../scripts/build-nft-vault";
import {
  PATHS, applyVerifiedDeployment, assertLoopbackRpc, expectedFactoryRuntime, factoryRuntimeTemplate, feePlan, parseArgs,
  predictFactoryAddress, preflight, serializeManifest, serializeSafe, type PreflightClient,
} from "../scripts/deploy-nft-vault";
import { runtimeTemplateFromInitCode } from "../scripts/nft-vault-fork-helpers";
import { ROBINHOOD_CONTRACTS } from "../src/lib/config";
import { ERC6551_REGISTRY, MUSES, TOKENBOUND_V3_IMPLEMENTATION, TOKENBOUND_V3_PROXY, vaultFactory, type NftVaultManifest } from "../src/lib/nft-mode";

// Offline: no RPC, no fork, no Forge. The chain is a fake client; the build is the committed artifact.
const build = JSON.parse(readFileSync("contracts/artifacts/nft-vault-build.json", "utf8")) as NftVaultBuild;
const compilerInput = readFileSync("contracts/artifacts/MusegodNftFeeVaultFactory.compiler-input.json", "utf8");
const forkEvidence = JSON.parse(readFileSync("docs/evidence/nft-vault-fork-robinhood.json", "utf8"));
const forkFactory = forkEvidence.gates["2_factory"] as { runtimeLength: number; onchainRuntimeHash: Hex };
const DEPLOYER = getAddress("0xd5C256e6411a6835543F2bCd763341639e3Cf56f");
const HASH = `0x${"34".repeat(32)}` as Hex;
const KEY = "SeCrEtAlchemyKey_0123456789";
const KEYED_URL = `https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`;
const NOT_DEPLOYED = { status: "not_deployed", factory: null, factoryRuntimeHash: null, transactionHash: null, blockNumber: null } as const;
const undeployed = (): NftVaultManifest => ({ version: 1, vaultInitCodeHash: build.vaultInitCodeHash,
  chains: { "4663": { ...NOT_DEPLOYED }, "8453": { ...NOT_DEPLOYED } } });

test("the parser accepts exactly the documented modes and their flags", () => {
  assert.deepEqual(parseArgs(["--preflight", "--deployer", DEPLOYER.toLowerCase()]), { mode: "preflight", deployer: DEPLOYER });
  assert.deepEqual(parseArgs(["--preflight", "--deployer", DEPLOYER, "--rpc", KEYED_URL]), { mode: "preflight", deployer: DEPLOYER, rpc: KEYED_URL });
  assert.deepEqual(parseArgs(["--verify", "--tx", HASH]), { mode: "verify", tx: HASH });
  assert.deepEqual(parseArgs(["--verify", "--tx", HASH, "--deployer", DEPLOYER, "--nonce", "7", "--rpc", KEYED_URL]),
    { mode: "verify", tx: HASH, deployer: DEPLOYER, nonce: 7n, rpc: KEYED_URL });
  assert.deepEqual(parseArgs(["--deploy-local"]), { mode: "deploy-local" });
  assert.deepEqual(parseArgs(["--deploy-local", "--rpc", "http://127.0.0.1:8545"]), { mode: "deploy-local", rpc: "http://127.0.0.1:8545" });
  assert.deepEqual(parseArgs(["--rehearse"]), { mode: "rehearse" });
  assert.deepEqual(parseArgs(["--sourcify-input"]), { mode: "sourcify-input" });
});

test("the parser rejects unknown, extra, duplicate, misplaced and malformed arguments", () => {
  const cases: [string[], RegExp][] = [
    [[], /Usage/],
    [["--deploy"], /Unknown mode/],
    [["--broadcast"], /Unknown mode/],
    [["--preflight"], /--deployer is required/],
    [["--preflight", "--deployer", DEPLOYER, "--tx", HASH], /--tx is not accepted by --preflight/],
    [["--preflight", "--deployer", DEPLOYER, "--verify"], /--verify is not accepted by --preflight/],
    [["--preflight", "--deployer", DEPLOYER, "--deployer", DEPLOYER], /Duplicate --deployer/],
    [["--preflight", "--deployer"], /Missing value for --deployer/],
    [["--preflight", "--deployer", "--rpc", "http://127.0.0.1:1"], /Missing value for --deployer/],
    [["--preflight", "--deployer", DEPLOYER, "extra"], /Unexpected argument/],
    [["--preflight", `--deployer=${DEPLOYER}`], /Unexpected argument/],
    [["--preflight", "--deployer", "0x1234"], /--deployer must be an address/],
    [["--preflight", "--deployer", DEPLOYER, "--rpc", "ftp://127.0.0.1"], /--rpc must be an http/],
    [["--rehearse", "--rpc", "http://127.0.0.1:8545"], /--rpc is not accepted by --rehearse/],
    [["--sourcify-input", "--deployer", DEPLOYER], /--deployer is not accepted by --sourcify-input/],
    [["--verify"], /--tx is required/],
    [["--verify", "--tx", "0x1234"], /--tx must be a 32-byte transaction hash/],
    [["--verify", "--tx", HASH, "--nonce", "1"], /--deployer and --nonce go together/],
    [["--verify", "--tx", HASH, "--deployer", DEPLOYER], /--deployer and --nonce go together/],
    [["--verify", "--tx", HASH, "--deployer", DEPLOYER, "--nonce", "-1"], /--nonce must be/],
    [["--verify", "--tx", HASH, "--deployer", DEPLOYER, "--nonce", "9007199254740992"], /--nonce must be/],
  ];
  for (const [argv, message] of cases) assert.throws(() => parseArgs(argv), message, argv.join(" "));
});

test("no mode takes a private key, mnemonic or signer, and an unexpected value is never echoed", () => {
  const privateKey = `0x${"ab".repeat(32)}`;
  const phrase = "test test test test test test test test test test test junk";
  const cases = [
    ["--preflight", "--deployer", DEPLOYER, "--private-key", privateKey],
    ["--preflight", "--deployer", DEPLOYER, "--privateKey", privateKey],
    ["--preflight", "--deployer", DEPLOYER, "--key", privateKey],
    ["--verify", "--tx", HASH, "--mnemonic", phrase],
    ["--deploy-local", "--keystore", "/tmp/keystore"],
    ["--deploy-local", "--account", "deployer"],
    ["--preflight", "--deployer", DEPLOYER, "--ledger"],
    ["--preflight", "--deployer", DEPLOYER, "--unlocked"],
    ["--preflight", "--deployer", DEPLOYER, "--interactive"],
    ["--rehearse", privateKey],
    ["--rehearse", privateKey.slice(2)],
    [privateKey],
  ];
  for (const argv of cases) {
    assert.throws(() => parseArgs(argv), (error: Error) => {
      assert.match(error.message, /never takes a private key|signer/i, argv.join(" "));
      for (const secret of [privateKey.slice(2), phrase, "/tmp/keystore"]) assert(!error.message.includes(secret), "the error echoes a secret");
      return true;
    });
  }
  // A non-key positional value is refused without being echoed either.
  assert.throws(() => parseArgs(["--rehearse", "hunter2-password"]), (error: Error) => !error.message.includes("hunter2") && /Unexpected argument/.test(error.message));
});

test("--deploy-local refuses every RPC that is not plain loopback HTTP, without echoing it", () => {
  for (const url of [KEYED_URL, "http://10.0.0.5:8545", "https://127.0.0.1:8545", "http://127.0.0.1.nip.io:8545",
    "http://user:pass@127.0.0.1:8545", "ws://127.0.0.1:8545", "http://localhost.example.com:8545", "not a url"]) {
    assert.throws(() => parseArgs(["--deploy-local", "--rpc", url]), (error: Error) =>
      /loopback HTTP/.test(error.message) && !error.message.includes(url) && !error.message.includes(KEY), url);
    assert.throws(() => assertLoopbackRpc(url), /loopback HTTP/, url);
  }
  for (const url of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"]) assert.doesNotThrow(() => assertLoopbackRpc(url), url);
});

test("the predicted factory address is the deployer's CREATE address at the exact nonce", () => {
  // Real CREATE receipts from docs/evidence/launch-guard-v2-mainnet.json (same deployer), plus the classic Ethereum vector.
  assert.equal(predictFactoryAddress(DEPLOYER, 6n), getAddress("0x531417dD153A72AA780DE27E502618a1F74AA409"));
  assert.equal(predictFactoryAddress(DEPLOYER, 2n), getAddress("0x376DcBb32DF3B033547f3d9024b2e4E88b973BF7"));
  assert.equal(predictFactoryAddress(getAddress("0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0"), 0n), getAddress("0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d"));
  assert.notEqual(predictFactoryAddress(DEPLOYER, 7n), predictFactoryAddress(DEPLOYER, 8n));
  for (const nonce of [-1n, 2n ** 64n]) assert.throws(() => predictFactoryAddress(DEPLOYER, nonce), /nonce/);
});

test("the expected factory runtime is the committed template with every immutable slot set to vaultInitCodeHash", () => {
  assert.equal(forkEvidence.build.vaultInitCodeHash, build.vaultInitCodeHash, "the fork evidence must come from this build");
  const template = factoryRuntimeTemplate(build);
  assert.equal(keccak256(template), build.factoryRuntimeTemplateHash);
  assert.equal(template, runtimeTemplateFromInitCode(build.factoryBytecode, build.factoryRuntimeTemplateHash, forkFactory.runtimeLength));
  const expected = expectedFactoryRuntime(build);
  assert.equal(expected.bytes, forkFactory.runtimeLength);
  assert.equal(expected.hash, forkFactory.onchainRuntimeHash, "the runtime the fork gate actually deployed from this build");
  assert.equal(expected.hash, keccak256(expected.runtime));
  for (const { start, length } of build.immutableReferences.VAULT_INIT_CODE_HASH) {
    assert.equal(expected.runtime.slice(2 + start * 2, 2 + (start + length) * 2), build.vaultInitCodeHash.slice(2));
  }
  assert.throws(() => factoryRuntimeTemplate({ ...build, factoryRuntimeTemplateHash: `0x${"00".repeat(32)}` }), /template/);
  assert.throws(() => expectedFactoryRuntime({ ...build, vaultInitCodeHash: "0x1234" }));
});

test("the manifest writer changes only the Robinhood entry and keeps the file format", () => {
  const before = undeployed();
  const snapshot = structuredClone(before);
  const expected = expectedFactoryRuntime(build).hash;
  const factory = getAddress("0x1111111111111111111111111111111111111111");
  const after = applyVerifiedDeployment(before, { factory, factoryRuntimeHash: expected, transactionHash: HASH, blockNumber: 88_000_000n },
    { vaultInitCodeHash: build.vaultInitCodeHash, factoryRuntimeHash: expected });
  assert.deepEqual(before, snapshot, "the input manifest is not mutated");
  assert.deepEqual(Object.keys(after), ["version", "vaultInitCodeHash", "chains"]);
  assert.deepEqual(Object.keys(after.chains), ["4663", "8453"]);
  assert.equal(after.vaultInitCodeHash, before.vaultInitCodeHash);
  assert.deepEqual(after.chains["8453"], before.chains["8453"]);
  assert.deepEqual(after.chains["4663"], { status: "deployed_verified", factory, factoryRuntimeHash: expected, transactionHash: HASH, blockNumber: 88_000_000 });
  assert.deepEqual(Object.keys(after.chains["4663"]), ["status", "factory", "factoryRuntimeHash", "transactionHash", "blockNumber"]);
  assert.equal(vaultFactory(4663, after), factory);
  assert.equal(vaultFactory(8453, after), null);
  assert.equal(serializeManifest(after), `${JSON.stringify(after, null, 2)}\n`);
});

test("the manifest writer refuses an already deployed chain, a hash mismatch and malformed fields", () => {
  const expected = expectedFactoryRuntime(build).hash;
  const entry = { factory: getAddress("0x1111111111111111111111111111111111111111"), factoryRuntimeHash: expected, transactionHash: HASH, blockNumber: 88_000_000n };
  const hashes = { vaultInitCodeHash: build.vaultInitCodeHash, factoryRuntimeHash: expected };
  const deployed = applyVerifiedDeployment(undeployed(), entry, hashes);
  assert.throws(() => applyVerifiedDeployment(deployed, entry, hashes), /already deployed/);
  assert.throws(() => applyVerifiedDeployment({ ...undeployed(), vaultInitCodeHash: `0x${"56".repeat(32)}` }, entry, hashes), /vaultInitCodeHash/);
  assert.throws(() => applyVerifiedDeployment(undeployed(), { ...entry, factoryRuntimeHash: `0x${"12".repeat(32)}` }, hashes), /runtime hash/);
  assert.throws(() => applyVerifiedDeployment(undeployed(), entry, { ...hashes, factoryRuntimeHash: `0x${"12".repeat(32)}` }), /runtime hash/);
  assert.throws(() => applyVerifiedDeployment(undeployed(), { ...entry, factory: "0x1234" as Address }, hashes), /factory/);
  assert.throws(() => applyVerifiedDeployment(undeployed(), { ...entry, transactionHash: "0x12" as Hex }, hashes), /transaction/);
  assert.throws(() => applyVerifiedDeployment(undeployed(), { ...entry, blockNumber: 0n }, hashes), /block/);
  const noBase = undeployed() as unknown as { chains: Record<string, unknown> };
  delete noBase.chains["8453"];
  assert.throws(() => applyVerifiedDeployment(noBase as unknown as NftVaultManifest, entry, hashes), /manifest/);
});

test("the fee plan buffers gas by 20% and doubles the current fee, and the balance must cover the whole cap", () => {
  assert.deepEqual(feePlan({ estimate: 1_347_843n, baseFeePerGas: 10_000_000n, maxPriorityFeePerGas: 0n }),
    { gas: 1_617_412n, maxPriorityFeePerGas: 0n, maxFeePerGas: 20_000_000n, requiredWei: 1_617_412n * 20_000_000n });
  assert.deepEqual(feePlan({ estimate: 100n, baseFeePerGas: 7n, maxPriorityFeePerGas: 3n }),
    { gas: 120n, maxPriorityFeePerGas: 3n, maxFeePerGas: 20n, requiredWei: 2400n });
  assert.throws(() => feePlan({ estimate: 0n, baseFeePerGas: 1n, maxPriorityFeePerGas: 0n }), /estimate/);
});

// ---- preflight against a fake chain -----------------------------------------------------------------------------------
type Fake = { chainId?: number; latest?: number; pending?: number; balance?: bigint; predictedCode?: Hex; missing?: Address;
  deployerCode?: Hex; estimate?: () => Promise<bigint> };
function fakeClient(fake: Fake = {}): PreflightClient {
  const dependencies = [ERC6551_REGISTRY, TOKENBOUND_V3_PROXY, TOKENBOUND_V3_IMPLEMENTATION, ROBINHOOD_CONTRACTS.rehype,
    ROBINHOOD_CONTRACTS.initializer, MUSES.contract].map((address) => address.toLowerCase());
  return {
    getChainId: async () => fake.chainId ?? 4663,
    getBlock: async () => ({ number: 88_000_000n, hash: `0x${"aa".repeat(32)}`, timestamp: 1_792_000_000n, baseFeePerGas: 10_000_000n }),
    getTransactionCount: async ({ address, blockTag }: { address: Address; blockTag: string }) =>
      address.toLowerCase() !== DEPLOYER.toLowerCase() ? 0 : blockTag === "pending" ? fake.pending ?? fake.latest ?? 7 : fake.latest ?? 7,
    getCode: async ({ address }: { address: Address }) => {
      if (address.toLowerCase() === predictFactoryAddress(DEPLOYER, BigInt(fake.latest ?? 7)).toLowerCase()) return fake.predictedCode;
      if (fake.missing && address.toLowerCase() === fake.missing.toLowerCase()) return undefined;
      if (address.toLowerCase() === DEPLOYER.toLowerCase()) return fake.deployerCode;
      return dependencies.includes(address.toLowerCase()) ? "0x6001600155" : undefined;
    },
    getBalance: async () => fake.balance ?? 10n ** 18n,
    estimateGas: fake.estimate ?? (async () => 1_347_843n),
    estimateMaxPriorityFeePerGas: async () => 0n,
  } as unknown as PreflightClient;
}
const preflightInput = (overrides: Partial<Parameters<typeof preflight>[1]> = {}): Parameters<typeof preflight>[1] => ({
  deployer: DEPLOYER, build, compilerInput, manifest: undeployed(),
  fresh: { build, compilerInput, factoryRuntimeTemplate: factoryRuntimeTemplate(build) },
  rpcLabel: "Alchemy Robinhood mainnet (ALCHEMY_API_KEY from .env.fork)", rehearsal: false, createHexPath: PATHS.createHex,
  secrets: [KEY, KEYED_URL], ...overrides,
});
const textOf = (report: unknown) => serializeSafe(report, [KEY, KEYED_URL]);

test("a ready preflight prints the exact unsigned CREATE and an owner command, with no key or URL", async () => {
  const report = await preflight(fakeClient(), preflightInput());
  assert.equal(report.ready, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.predictedFactory, predictFactoryAddress(DEPLOYER, 7n));
  assert.equal(report.expectedRuntimeHash, forkFactory.onchainRuntimeHash);
  assert.deepEqual(report.unsignedTransaction, {
    type: "eip1559", chainId: 4663, from: DEPLOYER, nonce: 7, to: null, value: "0",
    data: { file: PATHS.createHex, bytes: (build.factoryBytecode.length - 2) / 2, keccak256: keccak256(build.factoryBytecode) },
    gas: "1617412", maxFeePerGas: "20000000", maxPriorityFeePerGas: "0",
  });
  assert.match(report.ownerCommand!, /^cast send --rpc-url <their RPC> --chain 4663 --from 0x[0-9a-fA-F]{40} --nonce 7 --gas-limit 1617412 --priority-gas-price 0 --gas-price 20000000 <their signer flags> --create "\$\(cat \.cache\/nft-vault-factory-4663\.create\.hex\)"$/);
  const text = textOf(report);
  for (const forbidden of [KEY, "alchemy.com", "://"]) assert(!text.includes(forbidden), `the report contains ${forbidden}`);
});

test("a preflight failure is reported redacted and withholds the transaction", async () => {
  const report = await preflight(fakeClient({ estimate: async () => { throw new Error(`HTTP request failed. URL: ${KEYED_URL} Details: execution reverted`); } }), preflightInput());
  assert.equal(report.ready, false);
  assert.equal(report.unsignedTransaction, undefined);
  assert.equal(report.ownerCommand, undefined);
  assert(report.failures.some((failure) => /gas/.test(failure)));
  const text = textOf(report);
  for (const forbidden of [KEY, "alchemy.com", "://"]) assert(!text.includes(forbidden), `the report contains ${forbidden}`);
});

test("the preflight refuses a pending transaction, a used predicted address, a short balance and a missing dependency", async () => {
  const pending = await preflight(fakeClient({ pending: 8 }), preflightInput());
  assert.equal(pending.ready, false);
  assert(pending.failures.some((failure) => /pending/.test(failure)));
  const occupied = await preflight(fakeClient({ predictedCode: "0x00" }), preflightInput());
  assert.equal(occupied.ready, false);
  assert(occupied.failures.some((failure) => /predicted factory address/.test(failure)));
  const poor = await preflight(fakeClient({ balance: 1_617_412n * 20_000_000n - 1n }), preflightInput());
  assert.equal(poor.ready, false);
  assert(poor.failures.some((failure) => /balance/.test(failure)));
  const enough = await preflight(fakeClient({ balance: 1_617_412n * 20_000_000n }), preflightInput());
  assert.equal(enough.ready, true);
  const missing = await preflight(fakeClient({ missing: ROBINHOOD_CONTRACTS.rehype }), preflightInput());
  assert.equal(missing.ready, false);
  assert(missing.failures.some((failure) => /rehype/.test(failure)));
});

test("the deployer must be able to send a CREATE: no code, or only an EIP-7702 delegation", async () => {
  const plain = await preflight(fakeClient(), preflightInput());
  assert.equal(plain.deployerCode, "none");
  const delegate = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
  const delegated = await preflight(fakeClient({ deployerCode: `0xef0100${delegate.slice(2).toLowerCase()}` }), preflightInput());
  assert.equal(delegated.ready, true);
  assert.equal(delegated.deployerCode, `EIP-7702 delegation to ${getAddress(delegate)}`);
  const contract = await preflight(fakeClient({ deployerCode: "0x6080604052" }), preflightInput());
  assert.equal(contract.ready, false);
  assert(contract.failures.some((failure) => /deployer.*contract code/.test(failure)));
});

test("the preflight refuses the wrong chain, a deployed manifest and a build that the compiler does not reproduce", async () => {
  await assert.rejects(preflight(fakeClient({ chainId: 8453 }), preflightInput()), /chain 4663/);
  const deployed = applyVerifiedDeployment(undeployed(), { factory: getAddress("0x1111111111111111111111111111111111111111"),
    factoryRuntimeHash: expectedFactoryRuntime(build).hash, transactionHash: HASH, blockNumber: 1n },
  { vaultInitCodeHash: build.vaultInitCodeHash, factoryRuntimeHash: expectedFactoryRuntime(build).hash });
  await assert.rejects(preflight(fakeClient(), preflightInput({ manifest: deployed })), /not_deployed/);
  const changed = { ...build, factoryBytecode: `${build.factoryBytecode.slice(0, -2)}00` as Hex };
  await assert.rejects(preflight(fakeClient(), preflightInput({ fresh: { build: changed, compilerInput, factoryRuntimeTemplate: factoryRuntimeTemplate(build) } })), /rebuild/);
  await assert.rejects(preflight(fakeClient(), preflightInput({ fresh: { build, compilerInput: `${compilerInput} `, factoryRuntimeTemplate: factoryRuntimeTemplate(build) } })), /compiler input/);
});

test("the safe serializer refuses any secret or URL", () => {
  assert.throws(() => serializeSafe({ rpc: KEYED_URL }, [KEY]), /secret|URL/);
  assert.throws(() => serializeSafe({ note: `key ${KEY}` }, [KEY]), /secret/);
  assert.throws(() => serializeSafe({ link: "http://127.0.0.1:8545" }, []), /URL/);
  assert.equal(serializeSafe({ value: 1n }, [KEY]), `{\n  "value": "1"\n}\n`);
});
