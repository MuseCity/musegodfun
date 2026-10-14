import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import type { NftVaultBuild } from "../scripts/build-nft-vault";
import * as buildTools from "../scripts/build-nft-vault";
import * as deployTools from "../scripts/deploy-nft-vault";
import {
  MAINNET_ANCHOR, PATHS, REHEARSAL_PATHS, applyVerifiedDeployment, assertLoopbackRpc, expectedFactoryRuntime, factoryRuntimeTemplate, feePlan,
  nodeKind, parseArgs, predictFactoryAddress, preflight, recordTargets, serializeManifest, serializeSafe, verifyDeployment,
  type NodeProbeClient, type PreflightClient, type VerifyClient,
} from "../scripts/deploy-nft-vault";
import { runtimeTemplateFromInitCode } from "../scripts/nft-vault-fork-helpers";
import { ROBINHOOD_CONTRACTS } from "../src/lib/config";
import {
  ERC6551_REGISTRY, MUSES, TOKENBOUND_V3_IMPLEMENTATION, TOKENBOUND_V3_PROXY, treasuryFor, vaultFactory, vaultFor, type NftVaultManifest,
} from "../src/lib/nft-mode";

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
  assert.equal(report.ownerCommand, `CODE="$(cat '${resolve(PATHS.createHex)}')" && [ "$(cast keccak "$CODE")" = ${keccak256(build.factoryBytecode)} ] && `
    + `cast send --rpc-url <their RPC> --chain 4663 --from ${DEPLOYER} --nonce 7 --value 0 --gas-limit 1617412 --priority-gas-price 0 --gas-price 20000000 <their signer flags> --create "$CODE"`);
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

// ---- node identity: only a proven Robinhood mainnet endpoint may record (codex review 1, P1) ---------------------------
function probe({ version, anchorHash, anchorFails }: { version?: string; anchorHash?: Hex; anchorFails?: boolean } = {}): NodeProbeClient {
  return {
    request: async ({ method }: { method: string }) => {
      assert.equal(method, "web3_clientVersion");
      if (version === undefined) throw new Error("the method web3_clientVersion is not available");
      return version;
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      assert.equal(blockNumber, MAINNET_ANCHOR.blockNumber);
      if (anchorFails) throw new Error("block unavailable");
      return { hash: anchorHash ?? MAINNET_ANCHOR.hash };
    },
  } as unknown as NodeProbeClient;
}
const OFFICIAL_RPC = "https://rpc.mainnet.chain.robinhood.com";

test("the mainnet anchor is the recorded launch-guard V2 Robinhood deployment block", () => {
  const record = JSON.parse(readFileSync("docs/evidence/launch-guard-v2-mainnet.json", "utf8")) as {
    deployments: { chainId: number; blockNumber: string; blockHash: string }[];
    validation: { independentMainnetReviews: { chainId: number; receipt: { blockNumber: string; blockHash: string } }[] } };
  const deployment = record.deployments.find((item) => item.chainId === 4663)!;
  const review = record.validation.independentMainnetReviews.find((item) => item.chainId === 4663)!;
  for (const observed of [deployment, review.receipt]) {
    assert.equal(BigInt(observed.blockNumber), MAINNET_ANCHOR.blockNumber);
    assert.equal(observed.blockHash.toLowerCase(), MAINNET_ANCHOR.hash);
  }
});

test("a remote node whose web3_clientVersion is blocked is unproven, even though a later fork shares the mainnet anchor block", async () => {
  // The reviewed path: a non-loopback 4663 fork behind a proxy that blocks web3_clientVersion. A fork taken after the anchor
  // returns the upstream anchor hash, so only the endpoint's identity separates it from mainnet.
  assert.equal((await nodeKind(probe(), "https://fork.example.net/rpc")).kind, "unproven");
  assert.equal((await nodeKind(probe({ version: "Geth/v1.14" }), "https://fork.example.net/rpc")).kind, "unproven");
  for (const url of ["https://robinhood-mainnet.g.alchemy.com.evil.example/v2/x", "http://robinhood-mainnet.g.alchemy.com/v2/x",
    "https://user@rpc.mainnet.chain.robinhood.com", "https://rpc.mainnet.chain.robinhood.com:8443"]) {
    assert.equal((await nodeKind(probe(), url)).kind, "unproven", url);
  }
});

test("the mainnet allowlist matches own entries only: inherited keys and a trailing dot are unproven", async () => {
  // Codex review 1 acceptance: a plain-object lookup returned Object.prototype members for these hostnames, and with the shared
  // anchor matching, a fork served there counted as mainnet.
  for (const host of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "robinhood-mainnet.g.alchemy.com.",
    "rpc.mainnet.chain.robinhood.com."]) {
    assert.equal((await nodeKind(probe(), `https://${host}/v2/x`)).kind, "unproven", host);
  }
  // The URL parser lowercases the host; the exact canonical name is then an own entry.
  assert.equal((await nodeKind(probe(), "https://ROBINHOOD-MAINNET.G.ALCHEMY.COM/v2/x")).kind, "mainnet");
});

test("the parser matches modes and flags by own entries only", () => {
  for (const mode of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => parseArgs([mode]), (error: Error) => /Unknown mode/.test(error.message) && !error.message.includes(mode), mode);
  }
  for (const flag of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => parseArgs(["--rehearse", flag, "x"]), /Unexpected argument/, flag);
    assert.throws(() => parseArgs(["--preflight", "--deployer", DEPLOYER, flag, "x"]), /Unexpected argument/, flag);
  }
});

test("a known mainnet endpoint is refused when its anchor block hash differs or cannot be read", async () => {
  assert.equal((await nodeKind(probe({ anchorHash: `0x${"11".repeat(32)}` }), KEYED_URL)).kind, "unproven");
  assert.equal((await nodeKind(probe({ anchorFails: true }), OFFICIAL_RPC)).kind, "unproven");
});

test("genuine mainnet is a known endpoint with the matching anchor; a development node or loopback is local", async () => {
  for (const url of [KEYED_URL, OFFICIAL_RPC]) {
    const node = await nodeKind(probe(), url);
    assert.equal(node.kind, "mainnet", url);
    assert(!node.proof.includes(KEY) && !/:\/\//.test(node.proof), "the proof names no key or URL");
  }
  assert.equal((await nodeKind(probe({ version: "anvil/v1.0.0" }), KEYED_URL)).kind, "local");
  assert.equal((await nodeKind(probe({ version: "anvil/v1.0.0" }), "https://fork.example.net/rpc")).kind, "local");
  assert.equal((await nodeKind(probe(), "http://127.0.0.1:8545")).kind, "local");
});

test("recording targets: mainnet writes the committed files, local only rehearsal copies, an unproven node nothing", () => {
  assert.deepEqual(recordTargets("mainnet"), { preflight: PATHS.preflight, createHex: PATHS.createHex, manifest: PATHS.manifest, evidence: PATHS.evidence });
  assert.equal(recordTargets("local"), REHEARSAL_PATHS);
  assert.throws(() => recordTargets("unproven"), /proven Robinhood mainnet/);
});

// ---- verify against a fake chain (codex review 1, P2 x2) ----------------------------------------------------------------
const RECEIPT_BLOCK = 88_000_000n;
const RECEIPT_BLOCK_HASH = `0x${"bb".repeat(32)}` as Hex;
const FACTORY = predictFactoryAddress(DEPLOYER, 7n);
const MUSE_1 = { chainId: 4663, contract: MUSES.contract, tokenId: "1" } as const;
type VerifyFake = { heads?: bigint[]; receipt?: Record<string, unknown>; transaction?: Record<string, unknown>;
  chainId?: number; blockHashes?: Hex[]; finalized?: bigint | null; finalizedError?: boolean; code?: Hex; reads?: Record<string, unknown>; calls?: string[] };
function fakeVerifyClient(fake: VerifyFake = {}): VerifyClient {
  const heads = [...(fake.heads ?? [RECEIPT_BLOCK + 1n])];
  const blockHashes = [...(fake.blockHashes ?? [RECEIPT_BLOCK_HASH])];
  const reads: Record<string, unknown> = { VAULT_INIT_CODE_HASH: build.vaultInitCodeHash, vaultFor: vaultFor(MUSE_1, FACTORY, build.vaultInitCodeHash),
    treasuryFor: treasuryFor(MUSE_1), ERC6551_REGISTRY, TOKENBOUND_V3_PROXY, ...fake.reads };
  return {
    getChainId: async () => fake.chainId ?? 4663,
    getBlockNumber: async () => (heads.length > 1 ? heads.shift()! : heads[0]),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", to: null, contractAddress: FACTORY.toLowerCase(),
      blockNumber: RECEIPT_BLOCK, blockHash: RECEIPT_BLOCK_HASH, from: DEPLOYER.toLowerCase(), transactionHash: hash, gasUsed: 1_347_843n,
      effectiveGasPrice: 20_036_000n, ...fake.receipt }),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      fake.calls?.push(blockTag ?? String(blockNumber));
      if (blockTag === "finalized") {
        if (fake.finalizedError) throw new Error("finalized tag unavailable");
        return { number: fake.finalized === undefined ? RECEIPT_BLOCK : fake.finalized, hash: RECEIPT_BLOCK_HASH };
      }
      if (blockNumber === MAINNET_ANCHOR.blockNumber) return { number: blockNumber, hash: MAINNET_ANCHOR.hash };
      return { number: blockNumber, hash: blockHashes.length > 1 ? blockHashes.shift()! : blockHashes[0] };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => ({ hash, from: DEPLOYER.toLowerCase(), nonce: 7, to: null, value: 0n, input: build.factoryBytecode,
      chainId: 4663, gas: 1_639_961n, maxFeePerGas: 40_072_000n, maxPriorityFeePerGas: 0n, ...fake.transaction }),
    getCode: async () => fake.code ?? expectedFactoryRuntime(build).runtime,
    readContract: async ({ functionName }: { functionName: string }) => reads[functionName],
  } as unknown as VerifyClient;
}
const verifyInput = (tx: Hex): Parameters<typeof verifyDeployment>[1] => ({ tx, deployer: DEPLOYER, nonce: 7n, build, manifest: undeployed(),
  node: "mainnet", nodeProof: "test fixture", rpcLabel: "fake client" });

test("verify passes a consistent deployment, re-checks the head last and records the node kind", async () => {
  const result = await verifyDeployment(fakeVerifyClient({ heads: [RECEIPT_BLOCK + 1n, RECEIPT_BLOCK + 3n] }), verifyInput(HASH));
  assert(Object.values(result.evidence.checks).every((passed) => passed === true));
  assert.equal(result.evidence.checks.finalConfirmations, true);
  assert.equal(result.evidence.confirmations, "4");
  assert.equal(result.evidence.node, "mainnet");
  assert.equal(result.evidence.rehearsal, false);
  assert.deepEqual(result.manifestEntry, { status: "deployed_verified", factory: FACTORY, factoryRuntimeHash: expectedFactoryRuntime(build).hash,
    transactionHash: HASH, blockNumber: Number(RECEIPT_BLOCK) });
});

test("verify refuses when the head goes back below two confirmations after the reads, with the receipt block still canonical", async () => {
  await assert.rejects(verifyDeployment(fakeVerifyClient({ heads: [RECEIPT_BLOCK + 1n, RECEIPT_BLOCK] }), verifyInput(HASH)), /1 confirmation/);
  await assert.rejects(verifyDeployment(fakeVerifyClient({ heads: [RECEIPT_BLOCK] }), verifyInput(HASH)), /1 confirmation/);
});

test("verify accepts the winning same-nonce speed-up of the CREATE and refuses a cancel, a revert, other calldata or another nonce", async () => {
  const speedUp = `0x${"56".repeat(32)}` as Hex;
  const replaced = await verifyDeployment(fakeVerifyClient({ transaction: { gas: 2_000_000n, maxFeePerGas: 80_144_000n, maxPriorityFeePerGas: 1n } }),
    verifyInput(speedUp));
  assert.equal(replaced.manifestEntry.transactionHash, speedUp);
  assert.equal(replaced.entry.factory, FACTORY);
  const cancel = { receipt: { to: DEPLOYER.toLowerCase(), contractAddress: null }, transaction: { to: DEPLOYER.toLowerCase(), input: "0x" } };
  await assert.rejects(verifyDeployment(fakeVerifyClient(cancel), verifyInput(speedUp)), /not a contract creation/);
  await assert.rejects(verifyDeployment(fakeVerifyClient({ receipt: { status: "reverted" } }), verifyInput(speedUp)), /reverted/);
  await assert.rejects(verifyDeployment(fakeVerifyClient({ transaction: { input: `${build.factoryBytecode}00` } }), verifyInput(speedUp)), /creation code/);
  await assert.rejects(verifyDeployment(fakeVerifyClient({ transaction: { nonce: 8 } }), verifyInput(speedUp)), /nonce/);
});

test("mainnet verify refuses a receipt that is not finalized, or a missing finalized block", async () => {
  await assert.rejects(verifyDeployment(fakeVerifyClient({ finalized: RECEIPT_BLOCK - 1n }), verifyInput(HASH)), /not finalized/);
  await assert.rejects(verifyDeployment(fakeVerifyClient({ finalized: null }), verifyInput(HASH)), /finalized block/);
  await assert.rejects(verifyDeployment(fakeVerifyClient({ finalizedError: true }), verifyInput(HASH)), /finalized tag unavailable/);
});

test("mainnet records finality and checks canonicality after reading finalized; local needs only two confirmations", async () => {
  const calls: string[] = [];
  const mainnet = await verifyDeployment(fakeVerifyClient({ finalized: RECEIPT_BLOCK + 5n, calls }), verifyInput(HASH));
  assert.equal(mainnet.evidence.finalizedBlockNumber, String(RECEIPT_BLOCK + 5n));
  assert.deepEqual(calls.slice(-2), ["finalized", String(RECEIPT_BLOCK)]);
  const localCalls: string[] = [];
  const local = await verifyDeployment(fakeVerifyClient({ finalizedError: true, calls: localCalls }), { ...verifyInput(HASH), node: "local" });
  assert.equal(local.evidence.finalizedBlockNumber, null);
  assert.equal(local.evidence.confirmations, "2");
  assert(!localCalls.includes("finalized"));
});

const OTHER_ADDRESS = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_HASH = `0x${"12".repeat(32)}` as Hex;
const refusalCases: [string, VerifyFake, RegExp][] = [
  ["runtimeHash", { code: "0x6001600055" }, /runtime hash/],
  ["receiptCanonical", { blockHashes: [OTHER_HASH, RECEIPT_BLOCK_HASH] }, /not canonical/],
  ["stillCanonical", { blockHashes: [RECEIPT_BLOCK_HASH, OTHER_HASH] }, /reorganized during/],
  ["sender transaction", { transaction: { from: OTHER_ADDRESS } }, /sender/],
  ["sender receipt", { receipt: { from: OTHER_ADDRESS } }, /sender/],
  ["vaultInitCodeHash", { reads: { VAULT_INIT_CODE_HASH: OTHER_HASH } }, /VAULT_INIT_CODE_HASH/],
  ["vaultForMuse1", { reads: { vaultFor: OTHER_ADDRESS } }, /TS vaultFor/],
  ["treasuryForMuse1", { reads: { treasuryFor: OTHER_ADDRESS } }, /TS treasuryFor/],
  ["factoryConstants registry", { reads: { ERC6551_REGISTRY: OTHER_ADDRESS } }, /constant differs/],
  ["factoryConstants proxy", { reads: { TOKENBOUND_V3_PROXY: OTHER_ADDRESS } }, /constant differs/],
  ["predictedAddress", { receipt: { contractAddress: OTHER_ADDRESS } }, /not the predicted/],
  ["transactionChainId", { transaction: { chainId: 8453 } }, /signed for another chain/],
  // A later head is sufficient: this isolates the first confirmations check from finalConfirmations.
  ["confirmations", { heads: [RECEIPT_BLOCK, RECEIPT_BLOCK + 2n] }, /1 confirmation/],
  ["zero value", { transaction: { value: 1n } }, /zero value/],
  ["chain-id assert", { chainId: 8453 }, /chain 4663/],
];
for (const [name, fake, message] of refusalCases) test(`verify refuses ${name}`, async () => {
  await assert.rejects(verifyDeployment(fakeVerifyClient(fake), verifyInput(HASH)), message);
});

test("verify cross-checks the report predictedFactory and expectedRuntimeHash, and the manifest/build hash", async () => {
  const report = await preflight(fakeClient(), preflightInput());
  await assert.rejects(verifyDeployment(fakeVerifyClient(), { ...verifyInput(HASH), preflight: { ...report, predictedFactory: OTHER_ADDRESS } }), /not the predicted/);
  await assert.rejects(verifyDeployment(fakeVerifyClient(), { ...verifyInput(HASH), preflight: { ...report, expectedRuntimeHash: OTHER_HASH } }), /expected another runtime/);
  await assert.rejects(verifyDeployment(fakeVerifyClient(), { ...verifyInput(HASH), manifest: { ...undeployed(), vaultInitCodeHash: OTHER_HASH } }), /differs from the build/);
});

// Each filesystem test owns a scratch root. Neither real reports nor committed deployment files are written.
function scratch(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nft-vault-tooling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  put(PATHS.build, build); put(PATHS.compilerInput, compilerInput); put(PATHS.manifest, undeployed());
  return { root, put, read: (path: string) => readFileSync(join(root, path), "utf8") };
}

test("the owner command sends from another cwd only after the file exists and its keccak matches", async (t) => {
  const { root, put } = scratch(t);
  // Include a quote and shell metacharacters to exercise path quoting. All cast calls use a shell stub, never Foundry.
  const file = join(root, "code '$(must-not-run).hex");
  const report = await preflight(fakeClient(), preflightInput({ createHexPath: file }));
  const command = report.ownerCommand!.replace("<their RPC>", "unused").replace("<their signer flags>", "--unused");
  const marker = join(root, "sent");
  const stub = `cast() { if [ "$1" = keccak ]; then if [ "$2" = '${build.factoryBytecode}' ]; then printf '%s' '${keccak256(build.factoryBytecode)}'; else printf '%s' '${OTHER_HASH}'; fi; else printf '%s' sent > '${marker}'; fi; }; `;
  const run = () => childProcess.spawnSync("sh", ["-c", stub + command], { cwd: tmpdir(), encoding: "utf8" });
  assert.notEqual(run().status, 0, "a missing file must stop before cast send");
  assert(!existsSync(marker));
  put("code '$(must-not-run).hex", "0x1234");
  assert.notEqual(run().status, 0, "a mismatching keccak must stop before cast send");
  assert(!existsSync(marker));
  put("code '$(must-not-run).hex", build.factoryBytecode);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(marker, "utf8"), "sent");
});

test("Forge ignores a planted repo .env by spawning in contracts with --root . (spawn simulation only)", (t) => {
  const { root, put } = scratch(t);
  put(".env", "FOUNDRY_OPTIMIZER_RUNS=777\n"); // Never read this fixture or any existing .env.
  mkdirSync(join(root, "contracts"), { recursive: true });
  let captured: { command: string; args: readonly string[]; cwd?: string } | undefined;
  const stop = new Error("captured spawn; no Forge executed");
  const mock = t.mock.method(childProcess, "execFileSync", (command: string, args: readonly string[], options: { cwd?: string }) => {
    captured = { command, args, cwd: options.cwd }; throw stop;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => buildTools.compileNftVault({ root, offline: true, quiet: true }), (error) => error === stop);
    assert.deepEqual(captured, { command: "forge", args: ["build", "--root", ".", "--offline"], cwd: join(root, "contracts") });
    assert(!existsSync(join(captured!.cwd!, ".env")));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("Forge refuses contracts/.env before spawning; rehearsal cast refuses .env in its cwd", (t) => {
  const { root, put } = scratch(t);
  put("contracts/.env", "FOUNDRY_OPTIMIZER_RUNS=777\n");
  const mock = t.mock.method(childProcess, "execFileSync", () => { throw new Error("must not spawn"); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => buildTools.compileNftVault({ root, offline: true }), /contracts.*\.env.*must not exist/);
    assert.equal(mock.mock.callCount(), 0);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  mkdirSync(join(root, PATHS.rehearsal), { recursive: true });
  const options = deployTools.rehearsalCastOptions(root);
  assert.equal(options.cwd, join(root, PATHS.rehearsal));
  assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH"]);
  put(`${PATHS.rehearsal}/.env`, "ETH_RPC_URL=must-not-use\n");
  assert.throws(() => deployTools.rehearsalCastOptions(root), /\.env.*must not exist/);
});

test("a failed preflight preserves the ready report and creation code, and writes a separate failed report", async (t) => {
  const { root, read } = scratch(t);
  const options = { root, compile: () => preflightInput().fresh };
  const first = await deployTools.runPreflight(fakeClient(), DEPLOYER, "mainnet", "fake client", [], options);
  const readyText = read(PATHS.preflight), code = read(PATHS.createHex);
  assert(first.report.ready);
  assert(first.report.ownerCommand?.includes(`cat '${join(root, PATHS.createHex)}'`));
  const failed = await deployTools.runPreflight(fakeClient({ pending: 8 }), DEPLOYER, "mainnet", "fake client", [], options);
  assert.equal(failed.report.ready, false);
  assert.equal(failed.path, PATHS.preflight.replace(".json", ".failed.json"));
  assert.equal(read(PATHS.preflight), readyText);
  assert.equal(read(PATHS.createHex), code);
  assert.equal(JSON.parse(read(failed.path)).ready, false);
});

test("preflight refuses a second CREATE when the previous ready predicted factory is already deployed", async (t) => {
  const { root, read } = scratch(t);
  const options = { root, compile: () => preflightInput().fresh };
  await deployTools.runPreflight(fakeClient(), DEPLOYER, "mainnet", "fake client", [], options);
  const readyText = read(PATHS.preflight), code = read(PATHS.createHex);
  const client = fakeClient({ latest: 8 });
  const getCode = client.getCode;
  client.getCode = (async (args: { address: Address }) => args.address.toLowerCase() === FACTORY.toLowerCase()
    ? expectedFactoryRuntime(build).runtime : getCode(args)) as PreflightClient["getCode"];
  await assert.rejects(deployTools.runPreflight(client, DEPLOYER, "mainnet", "fake client", [], options),
    new RegExp(`the factory is already deployed at ${FACTORY}; run verify with --tx`));
  assert.equal(read(PATHS.preflight), readyText);
  assert.equal(read(PATHS.createHex), code);
  assert.match(read(PATHS.preflight.replace(".json", ".failed.json")), /already deployed/);
});

test("recordVerification writes matching mainnet files, preserves Base, and a same-entry rerun writes nothing", async (t) => {
  const { root, read, put } = scratch(t);
  const result = await verifyDeployment(fakeVerifyClient(), verifyInput(HASH));
  await deployTools.recordVerification(result, build, undeployed(), "mainnet", [], root);
  const recorded = JSON.parse(read(PATHS.manifest)) as NftVaultManifest;
  assert.deepEqual(recorded.chains["4663"], result.manifestEntry);
  assert.deepEqual(recorded.chains["8453"], undeployed().chains["8453"]);
  assert.equal(recorded.vaultInitCodeHash, build.vaultInitCodeHash);
  assert.deepEqual(JSON.parse(read(PATHS.evidence)).manifestEntry, result.manifestEntry);
  // Sentinel formatting and absent evidence detect any unnecessary writes on the already-recorded path.
  put(PATHS.manifest, `${read(PATHS.manifest)}\n`);
  const manifestText = read(PATHS.manifest);
  rmSync(join(root, PATHS.evidence));
  const rerun = await deployTools.recordVerification(result, build, recorded, "mainnet", [], root);
  assert.match(rerun.manifest, /unchanged/);
  assert.equal(read(PATHS.manifest), manifestText);
  assert(!existsSync(join(root, PATHS.evidence)));
  await assert.rejects(deployTools.recordVerification(result, build, { ...recorded, chains: { ...recorded.chains,
    "4663": { ...recorded.chains["4663"], factory: OTHER_ADDRESS } } }, "mainnet", [], root), /already records a different/);
});

function runVerifyFixture(fake: VerifyFake = {}): VerifyClient & NodeProbeClient {
  return { ...fakeVerifyClient(fake), request: probe({ version: "Geth/v1.14" }).request } as VerifyClient & NodeProbeClient;
}

test("runVerify refuses rehearsal, not-ready and wrong-kind/chain reports for mainnet without writing", async (t) => {
  const { root, put, read } = scratch(t);
  const report = await preflight(fakeClient(), preflightInput());
  const manifestText = read(PATHS.manifest);
  for (const changed of [{ rehearsal: true }, { ready: false }, { kind: "other" }, { chainId: 8453 }]) {
    put(PATHS.preflight, { ...report, ...changed });
    await assert.rejects(deployTools.runVerify({ mode: "verify", tx: HASH, rpc: OFFICIAL_RPC }, "", {
      root, client: runVerifyFixture(), log: () => {},
    }), /not a ready Robinhood mainnet preflight report/);
    assert.equal(read(PATHS.manifest), manifestText);
    assert(!existsSync(join(root, PATHS.evidence)));
  }
});

test("runVerify records a finalized mainnet deployment and reruns without rewriting its evidence", async (t) => {
  const { root, put, read } = scratch(t);
  put(PATHS.preflight, await preflight(fakeClient(), preflightInput()));
  const args = { mode: "verify", tx: HASH, rpc: OFFICIAL_RPC } as const;
  const options = { root, client: runVerifyFixture(), log: () => {} };
  await deployTools.runVerify(args, "", options);
  const manifestText = read(PATHS.manifest), evidenceText = read(PATHS.evidence);
  assert.equal(JSON.parse(evidenceText).finalizedBlockNumber, String(RECEIPT_BLOCK));
  await deployTools.runVerify(args, "", options);
  assert.equal(read(PATHS.manifest), manifestText);
  assert.equal(read(PATHS.evidence), evidenceText);
});

test("runVerify refuses unfinalized mainnet before recording any files", async (t) => {
  const { root, read } = scratch(t);
  const manifestText = read(PATHS.manifest);
  await assert.rejects(deployTools.runVerify({ mode: "verify", tx: HASH, rpc: OFFICIAL_RPC, deployer: DEPLOYER, nonce: 7n }, "", {
    root, client: runVerifyFixture({ finalized: RECEIPT_BLOCK - 1n }), log: () => {},
  }), /not finalized/);
  assert.equal(read(PATHS.manifest), manifestText);
  assert(!existsSync(join(root, PATHS.evidence)));
});

test("runVerify on local writes only REHEARSAL_PATHS and refuses a mainnet report there", async (t) => {
  const { root, put, read } = scratch(t);
  const manifestText = read(PATHS.manifest);
  const report = await preflight(fakeClient(), preflightInput({ rehearsal: true }));
  put(REHEARSAL_PATHS.preflight, { ...report, rehearsal: false });
  const args = { mode: "verify", tx: HASH, rpc: "http://127.0.0.1:8545" } as const;
  const options = { root, client: runVerifyFixture({ finalizedError: true }), log: () => {} };
  await assert.rejects(deployTools.runVerify(args, "", options), /not a ready local/);
  put(REHEARSAL_PATHS.preflight, report);
  await deployTools.runVerify(args, "", options);
  assert.equal(read(PATHS.manifest), manifestText);
  assert(!existsSync(join(root, PATHS.evidence)));
  assert.equal(JSON.parse(read(REHEARSAL_PATHS.evidence)).rehearsal, true);
  assert.equal(JSON.parse(read(REHEARSAL_PATHS.manifest)).chains["4663"].factory, FACTORY);
});
