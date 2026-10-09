import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeDeployData, encodeEventTopics, getAddress, keccak256, padHex, parseAbiItem, zeroHash,
  type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import splitsCode from "../contracts/artifacts/base-collector/splits-base-code.json";
import collectorArtifact from "../contracts/artifacts/base-collector/MusegodBaseFeeCollector.json";
import { BASE_COLLECTOR_MANIFEST, baseCollectorExpectedRuntime, baseCollectorGraphFingerprint, baseCollectorCanaryMessage,
  verifyBaseCollector, BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH, BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH, BASE_SPLITS_PROXY_HASH, type BaseCollectorClient, type BaseCollectorManifest, type BaseCollectorCanaryAuthorization } from "../server/base-collector";
import { baseCollectorFinalizedEvidence, verifyBaseCanaryAuthorization, baseNativeExecutionSha256, baseNativeRunAcceptanceMessage, verifyBaseNativeRunAuthority, type BaseNativeRunAcceptance } from "../server/base-collector";
import { CONTRACTS, STOCKS } from "../src/lib/config";
import { prepareBaseCollectorDeploymentSequence } from "../scripts/deploy-base-collector";
const address = (value: number) => getAddress(`0x${value.toString(16).padStart(40, "0")}`);
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const governor = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const collector = address(10), automation = address(11), implementation = BASE_SPLITS_IMPLEMENTATION, keeper = address(13);
const runtime = "0x6001600055" as Hex, implementationCode = splitsCode.implementationCode as Hex, proxyCode = splitsCode.proxyCode as Hex, factoryCode = splitsCode.factoryCode as Hex;
function fixture() {
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  manifest.status = "deployed_verified";
  manifest.constants.governor = governor.address; manifest.constants.automationReceiver = automation;
  manifest.collector = { address: collector, runtimeHash: hash(0), transactionHash: hash(1), blockNumber: "100" };
  for (const entry of Object.values(manifest.dependencies)) Object.assign(entry, { runtimeHash: keccak256(runtime), proxyImplementation: null, proxyCheck: "direct" });
  manifest.automationAccount = { address: automation, runtimeHash: BASE_SPLITS_PROXY_HASH,
    factory: { address: BASE_SPLITS_FACTORY, runtimeHash: BASE_SPLITS_FACTORY_HASH }, creation: { owner: governor.address, threshold: 1, signers: [{ slot1: padHex(keeper, { size: 32 }), slot2: zeroHash }], salt: "8453" }, implementation: { address: implementation, runtimeHash: keccak256(implementationCode) },
    owner: governor.address, threshold: 1, signers: [{ index: 7, slot1: padHex(keeper, { size: 32 }), slot2: zeroHash }], initializationHash: hash(2), blockNumber: "90" };
  manifest.nativeRule.ruleId = "reviewed-dedicated-base-rule"; manifest.nativeRule.configurationSha256 = hash(6);
  const code = baseCollectorExpectedRuntime(manifest); manifest.collector.runtimeHash = keccak256(code);
  const getters: Record<string, unknown> = { initializer: CONTRACTS.initializer, rehype: CONTRACTS.rehype, governor: governor.address,
    automationReceiver: automation, paused: false, SOURCE_CHAIN_ID: 8453n, LP_SHARE: 228n * 10n ** 15n, HOOK_SHARE: 24n * 10n ** 16n };
  const accountGetters: Record<string, unknown> = { owner: governor.address, getThreshold: 1, getSignerCount: 1, getSigner: manifest.automationAccount.signers[0] };
  const initialEvent = parseAbiItem("event InitializedSigners((bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold)");
  const initializationLog = { address: automation, topics: encodeEventTopics({ abi: [initialEvent], eventName: "InitializedSigners" }),
    data: encodeAbiParameters([{ type: "tuple[]", components: [{ name: "slot1", type: "bytes32" }, { name: "slot2", type: "bytes32" }] }, { type: "uint8" }],
      [[{ slot1: padHex(keeper, { size: 32 }), slot2: zeroHash }], 1]), logIndex: 0 };
  const ownershipEvent = parseAbiItem("event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)");
  const factoryEvent = parseAbiItem("event SmartVaultCreated(address indexed smartVault,address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt)");
  const ownerLog = { address: automation, topics: encodeEventTopics({ abi: [ownershipEvent], eventName: "OwnershipTransferred", args: { previousOwner: address(0), newOwner: governor.address } }), data: "0x", logIndex: 1 };
  const factoryLog = { address: BASE_SPLITS_FACTORY, topics: encodeEventTopics({ abi: [factoryEvent], eventName: "SmartVaultCreated", args: { smartVault: automation } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "tuple[]", components: [{ name: "slot1", type: "bytes32" }, { name: "slot2", type: "bytes32" }] }, { type: "uint8" }, { type: "uint256" }],
      [governor.address, [{ slot1: padHex(keeper, { size: 32 }), slot2: zeroHash }], 1, 8453n]), logIndex: 2 };
  const creationData = encodeDeployData({ abi: collectorArtifact.abi as Abi, bytecode: collectorArtifact.bytecode as Hex,
    args: [CONTRACTS.initializer, CONTRACTS.rehype, governor.address, automation] });
  let calls = 0, changedCode: Address | undefined, wrongProxy = false, reorg = false, chainId = 8453, missingInit = false, wrongConstructor = false, wrongPrediction = false, fakeFactoryEvent = false, fakeOwner = false, fakeInitialSigner = false;
  const client = {
    getChainId: async () => { calls++; return chainId; },
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => { calls++; const number = blockNumber ?? 1000n;
      return { number, hash: reorg && blockTag !== "latest" && number === 1000n ? hash(555) : hash(Number(number)), parentHash: hash(Number(number) - 1), timestamp: 1000n }; },
    getCode: async ({ address: candidate, blockNumber }: { address: Address; blockNumber?: bigint }) => { calls++;
      if (candidate.toLowerCase() === changedCode?.toLowerCase()) return "0x60056000fd";
      if (candidate === governor.address || candidate === automation && blockNumber === 89n) return "0x";
      if (candidate === collector) return code; if (candidate === implementation) return implementationCode; if (candidate === automation) return proxyCode; if (candidate === BASE_SPLITS_FACTORY) return factoryCode; return runtime; },
    getStorageAt: async ({ address: candidate }: { address: Address }) => { calls++; return candidate === automation ? padHex(wrongProxy ? address(666) : implementation, { size: 32 }) : zeroHash; },
    readContract: async ({ address: candidate, functionName, args, blockNumber }: { address: Address; functionName: string; args?: unknown[]; blockNumber?: bigint }) => { calls++;
      if (candidate === BASE_SPLITS_FACTORY) return functionName === "IMPLEMENTATION" ? implementation : wrongPrediction ? address(999) : automation;
      if (candidate === automation) {
        if (functionName === "FACTORY") return BASE_SPLITS_FACTORY;
        if (functionName === "getImplementation") return implementation;
        if (blockNumber === 90n) return functionName === "owner" ? governor.address : functionName === "getThreshold" || functionName === "getSignerCount" ? 1 :
          args?.[0] === 0 ? { slot1: fakeInitialSigner ? hash(66) : padHex(keeper, { size: 32 }), slot2: zeroHash } : { slot1: zeroHash, slot2: zeroHash };
        return functionName === "getSigner" ? args?.[0] === 7 ? accountGetters.getSigner : { slot1: zeroHash, slot2: zeroHash } : accountGetters[functionName];
      }
      return getters[functionName]; },
    getTransactionReceipt: async ({ hash: transactionHash }: { hash: Hex }) => { calls++; const initialization = transactionHash === hash(2);
      return { status: "success", transactionHash, contractAddress: initialization ? null : collector, blockNumber: initialization ? 90n : 100n,
        blockHash: hash(initialization ? 90 : 100), logs: initialization && !missingInit ? [initializationLog, fakeOwner ? { ...ownerLog, topics: encodeEventTopics({ abi: [ownershipEvent], eventName: "OwnershipTransferred", args: { previousOwner: address(0), newOwner: address(999) } }) } : ownerLog, fakeFactoryEvent ? { ...factoryLog, address: address(998) } : factoryLog] : [] }; },
    getTransaction: async () => { calls++; return { to: null, input: wrongConstructor ? "0x1234" : creationData, value: 0n, from: governor.address }; },
  } as unknown as BaseCollectorClient;
  return { manifest, client, getters, accountGetters, calls: () => calls, mutate: (value: { changedCode?: Address; wrongProxy?: boolean; reorg?: boolean; chainId?: number; missingInit?: boolean; wrongConstructor?: boolean; wrongPrediction?: boolean; fakeFactoryEvent?: boolean; fakeOwner?: boolean; fakeInitialSigner?: boolean }) => {
    changedCode = value.changedCode; wrongProxy = value.wrongProxy ?? false; reorg = value.reorg ?? false; chainId = value.chainId ?? 8453; missingInit = value.missingInit ?? false; wrongConstructor = value.wrongConstructor ?? false; wrongPrediction = value.wrongPrediction ?? false; fakeFactoryEvent = value.fakeFactoryEvent ?? false; fakeOwner = value.fakeOwner ?? false; fakeInitialSigner = value.fakeInitialSigner ?? false;
  } };
}
const readOnly = { requireActivation: false };
function evidenceFixture() {
  let finalized = true, finalizedNumber = 150n, reorg: number | undefined, reads = 0;
  const makeClient = () => ({ getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
    reads++;
    if (blockTag === "finalized" && !finalized) throw new Error("unsupported finalized");
    const number = blockTag === "finalized" ? finalizedNumber : blockNumber!;
    return { number, hash: hash(reorg === Number(number) ? 999 : Number(number)) };
  } }) as unknown as BaseCollectorClient;
  const source = makeClient(), destination = makeClient();
  const heads = (number = 300n) => ({ source: { number, hash: hash(Number(number)) }, destination: { number, hash: hash(Number(number)) } });
  const anchors = { source: [{ number: 100n, hash: hash(100) }, { number: 101n, hash: hash(101) }],
    destination: [{ number: 120n, hash: hash(120) }, { number: 121n, hash: hash(121) }] };
  return { source, destination, makeClient, heads, anchors, reads: () => reads,
    mutate: (value: { finalized?: boolean; finalizedNumber?: bigint; reorg?: number }) => { finalized = value.finalized ?? true; finalizedNumber = value.finalizedNumber ?? 150n; reorg = value.reorg; } };
}
test("finalized static Base evidence is reused across heads while every canonical anchor remains live", async () => {
  const f = evidenceFixture(); let replays = 0;
  const replay = async () => { replays++; };
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, replay);
  const reads = f.reads();
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(301n), f.anchors, replay);
  assert.equal(replays, 1); assert(f.reads() > reads);
  for (const reorg of [100, 101, 120, 121, 301]) {
    f.mutate({ reorg });
    await assert.rejects(() => baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(301n), f.anchors, replay), /anchor/);
  }
  assert.equal(replays, 1);
});
test("unsupported or incomplete finalized evidence never persists and concurrent reuse binds both head hashes", async () => {
  for (const finalized of [false, true]) {
    const f = evidenceFixture(); f.mutate({ finalized, finalizedNumber: 120n }); let replays = 0;
    const replay = async () => { replays++; };
    await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, replay);
    await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, replay);
    assert.equal(replays, 2);
  }
  const f = evidenceFixture(); f.mutate({ finalized: false }); let replays = 0;
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const replay = async () => { replays++; entered(); await pending; };
  const first = baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, replay); await started;
  const same = baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, replay);
  // A different destination head cannot join unfinalized replay from the older head pair.
  const changed = { ...f.heads(), destination: f.heads(301n).destination };
  const other = baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), changed, f.anchors, replay);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(replays, 2);
  finish(); await Promise.all([first, same, other]);
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, async () => { replays++; });
  assert.equal(replays, 3);
});
test("proof or destination-client changes and replay failures cannot reuse a completed Base acceptance", async () => {
  const f = evidenceFixture(); let replays = 0;
  const replay = async () => { replays++; };
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, replay);
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(2), f.heads(), f.anchors, replay);
  await baseCollectorFinalizedEvidence(f.source, f.makeClient(), hash(2), f.heads(), f.anchors, replay);
  assert.equal(replays, 3);
  const reIncluded = { ...f.anchors, source: [{ number: 102n, hash: hash(102) }] };
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), reIncluded, replay);
  assert.equal(replays, 4);
  for (let i = 0; i < 2; i++) await assert.rejects(() => baseCollectorFinalizedEvidence(f.source, f.destination, hash(3), f.heads(), f.anchors,
    async () => { replays++; throw new Error("invalid journal"); }), /invalid journal/);
  assert.equal(replays, 6);
});
test("static Base proof cache retains at most sixteen entries", async () => {
  const f = evidenceFixture(); let replays = 0;
  const replay = async () => { replays++; };
  for (let i = 1; i <= 17; i++) await baseCollectorFinalizedEvidence(f.source, f.destination, hash(i), f.heads(), f.anchors, replay);
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(17), f.heads(), f.anchors, replay);
  assert.equal(replays, 17);
  await baseCollectorFinalizedEvidence(f.source, f.destination, hash(1), f.heads(), f.anchors, replay);
  assert.equal(replays, 18);
});
async function authorize(f: ReturnType<typeof fixture>) {
  const authorization: BaseCollectorCanaryAuthorization = { version: 2, chainId: 8453, origin: "https://base-canary.musegod.local", collector, automationReceiver: automation,
    graphFingerprint: baseCollectorGraphFingerprint(f.manifest), keeper, releaseBudgets: [{ token: STOCKS[0].address, decimals: 8, maxAmount: "42" }],
    maxBaseGasWei: "1000000000000000", maxRobinhoodGasWei: "1000000000000000", expiresAt: "1100", signer: governor.address, signature: "0x" };
  authorization.signature = await governor.signMessage({ message: baseCollectorCanaryMessage(authorization) }); f.manifest.canaryAuthorization = authorization;
  return authorization;
}
test("a finalized static replay never replaces fresh EIP-1271 governor authorization", async () => {
  const f = fixture(), proof = evidenceFixture(); const authorization = await authorize(f); let authority = true, signatures = 0, replays = 0;
  const getCode = f.client.getCode, readContract = f.client.readContract;
  f.client.getCode = (async (parameters: Parameters<typeof getCode>[0]) => parameters.address === governor.address ? "0x1234" : getCode(parameters)) as typeof getCode;
  f.client.readContract = (async (parameters: Parameters<typeof readContract>[0]) => {
    if (parameters.functionName === "isValidSignature") { signatures++; return authority ? "0x1626ba7e" : "0x00000000"; }
    return readContract(parameters);
  }) as typeof readContract;
  const verify = async () => {
    await verifyBaseCanaryAuthorization(f.client, f.manifest, 1000n, authorization.origin, true);
    await baseCollectorFinalizedEvidence(proof.source, proof.destination, hash(1), proof.heads(), proof.anchors, async () => { replays++; });
  };
  await verify(); await verify(); assert.equal(replays, 1); assert.equal(signatures, 2);
  authority = false; await assert.rejects(verify, /signature|governor|authority/i);
  assert.equal(replays, 1); assert.equal(signatures, 3);
});
test("native pending manifest never claims deployment or invokes RPC", async () => {
  let calls = 0; const client = { getChainId: async () => { calls++; return 8453; } } as unknown as BaseCollectorClient;
  await assert.rejects(() => verifyBaseCollector(client, collector, { manifest: BASE_COLLECTOR_MANIFEST, ...readOnly }), /deployment has not been verified/);
  assert.equal(calls, 0); assert.equal(BASE_COLLECTOR_MANIFEST.constants.automationReceiver, null);
  assert.equal(BASE_COLLECTOR_MANIFEST.activation.status, "not_run");
});
test("exact native graph reconstructs every immutable and keeps fresh pause state", async () => {
  const f = fixture(); const result = await verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly });
  assert.equal(result.automationReceiver, automation); assert.equal(result.runtimeHash, f.manifest.collector.runtimeHash);
  assert.equal(result.initialDeploymentBlock, 100n); assert.equal(result.manifestFingerprint, baseCollectorGraphFingerprint(f.manifest));
  f.getters.paused = true; assert.equal((await verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly })).paused, true);
  assert(!("quoteSigner" in result)); assert(!("gasKeeper" in result)); assert(!("executionModule" in result));
});
test("receiver, governor and manager bytecode changes fail closed", async () => {
  for (const changedCode of [collector, automation, implementation, BASE_SPLITS_FACTORY, CONTRACTS.initializer, CONTRACTS.rehype]) {
    const f = fixture(); f.mutate({ changedCode }); await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }));
  }
  const f = fixture(); f.manifest.collector.runtimeHash = hash(999);
  await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }), /compiler output/);
});
test("proxy, sparse signer, threshold and owner checks reject unreviewed native account authority", async () => {
  assert.equal((await verifyBaseCollector(fixture().client, collector, { manifest: fixture().manifest, ...readOnly })).automationReceiver, automation);
  for (const [name, value] of [["owner", address(99)], ["getThreshold", 2], ["getSignerCount", 2], ["getSigner", { slot1: hash(55), slot2: zeroHash }]] as const) {
    const f = fixture(); f.accountGetters[name] = value; await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }), /Automation.*(changed|threshold)|signer changed/i);
  }
  const proxy = fixture(); proxy.mutate({ wrongProxy: true }); await assert.rejects(() => verifyBaseCollector(proxy.client, collector, { manifest: proxy.manifest, ...readOnly }), /proxy implementation changed/);
});
test("canonical initialization and exact constructor required, counterfactual account never enough", async () => {
  for (const field of ["missingInit", "wrongConstructor", "reorg"] as const) {
    const f = fixture(); f.mutate({ [field]: true }); await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }));
  }
  const f = fixture(); f.manifest.automationAccount.initializationHash = null;
  await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }), /initialized Splits/); assert.equal(f.calls(), 0);
});
test("wrong chain, recipient, policy and share never enable Base", async () => {
  const wrongChain = fixture(); wrongChain.mutate({ chainId: 4663 }); await assert.rejects(() => verifyBaseCollector(wrongChain.client, collector, { manifest: wrongChain.manifest, ...readOnly }), /chain 8453/);
  for (const [name, value] of [["automationReceiver", address(66)], ["LP_SHARE", 1n], ["HOOK_SHARE", 2n]] as const) {
    const f = fixture(); f.getters[name] = value; await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }), /economic shares changed/);
  }
  const f = fixture(); f.manifest.nativeRule.recipient = collector;
  await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }), /route.*changed/); assert.equal(f.calls(), 0);
});
test("public activation rejects flags, fork records and missing native closed loop", async () => {
  const f = fixture(); await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest }), /genuine-fee native/);
  f.manifest.activation.status = "canary_verified"; await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest }), /status flag is insufficient/);
  await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, allowCanary: true }), /human governor/);
});
test("isolated canary verifies exact origin, receiver, keeper, per-token amounts and actual human signature", async () => {
  const f = fixture(), authorization = await authorize(f);
  const options = { manifest: f.manifest, allowCanary: true, canaryOrigin: authorization.origin };
  assert.deepEqual((await verifyBaseCollector(f.client, collector, options)).canaryAuthorization, authorization);
  await assert.rejects(() => verifyBaseCollector(f.client, collector, { ...options, canaryOrigin: "https://musegod.fun" }), /human governor/);
  for (const [name, value] of [["keeper", address(66)], ["collector", address(67)], ["expiresAt", "999"], ["maxBaseGasWei", "1"]] as const) {
    const old = authorization[name]; (authorization as unknown as Record<string, unknown>)[name] = value;
    await assert.rejects(() => verifyBaseCollector(f.client, collector, options)); (authorization as unknown as Record<string, unknown>)[name] = old;
  }
  authorization.releaseBudgets[0].maxAmount = "43"; await assert.rejects(() => verifyBaseCollector(f.client, collector, options));
});
test("public origin, absent native rule and paused collector block even signed private canary", async () => {
  const f = fixture(), authorization = await authorize(f); const options = { manifest: f.manifest, allowCanary: true, canaryOrigin: authorization.origin };
  f.getters.paused = true; await assert.rejects(() => verifyBaseCollector(f.client, collector, options), /paused/); f.getters.paused = false;
  f.manifest.nativeRule.ruleId = null; await assert.rejects(() => verifyBaseCollector(f.client, collector, options), /human governor/);
  f.manifest.nativeRule.ruleId = "reviewed-dedicated-base-rule"; authorization.origin = "https://musegod.fun";
  authorization.signature = await governor.signMessage({ message: baseCollectorCanaryMessage(authorization) });
  await assert.rejects(() => verifyBaseCollector(f.client, collector, { ...options, canaryOrigin: authorization.origin }), /isolated/);
});
test("graph fingerprint excludes activation/auth proofs but binds the native rule and all receiver signers", () => {
  const f = fixture(), before = baseCollectorGraphFingerprint(f.manifest);
  f.manifest.activation.status = "canary_verified"; assert.equal(baseCollectorGraphFingerprint(f.manifest), before);
  f.manifest.nativeRule.configurationSha256 = hash(333); assert.notEqual(baseCollectorGraphFingerprint(f.manifest), before);
  f.manifest.nativeRule.configurationSha256 = hash(6); f.manifest.automationAccount.signers[0].slot1 = hash(44);
  assert.notEqual(baseCollectorGraphFingerprint(f.manifest), before);
});
test("unsigned native Collector deployment has one CREATE and no module or role enabling", async () => {
  const pending = structuredClone(BASE_COLLECTOR_MANIFEST);
  await assert.rejects(() => prepareBaseCollectorDeploymentSequence(pending, governor.address, 2n), /dedicated Base/);
  const f = fixture(); f.manifest.collector.address = null;
  const proposal = await prepareBaseCollectorDeploymentSequence(f.manifest, governor.address, 2n);
  assert.equal(proposal.transactions.length, 1); assert.equal(proposal.initiallyPaused, true);
  assert(!("executionModule" in proposal)); assert(!("nonceMustRemainConsecutive" in proposal));
});

test("official factory origin rejects forged factory events, wrong CREATE2 address and initial owner/signers", async () => {
  for (const field of ["wrongPrediction", "fakeFactoryEvent", "fakeOwner", "fakeInitialSigner"] as const) {
    const f = fixture(); f.mutate({ [field]: true }); await assert.rejects(() => verifyBaseCollector(f.client, collector, { manifest: f.manifest, ...readOnly }));
  }
  const implementation = fixture(); implementation.manifest.automationAccount.implementation!.runtimeHash = keccak256(runtime);
  await assert.rejects(() => verifyBaseCollector(implementation.client, collector, { manifest: implementation.manifest, ...readOnly }), /official Base Splits/);
  const factory = fixture(); factory.manifest.automationAccount.factory.address = address(999);
  await assert.rejects(() => verifyBaseCollector(factory.client, collector, { manifest: factory.manifest, ...readOnly }), /official Base Splits/);
  assert.equal(keccak256(factoryCode), BASE_SPLITS_FACTORY_HASH); assert.equal(keccak256(implementationCode), BASE_SPLITS_IMPLEMENTATION_HASH);
});

test("native scheduled run acceptance binds the entire journal and both hashes, not just a completion flag", async () => {
  const f = fixture();
  f.manifest.activation.nativeExecution = { version: 1, proof: { version: 2, sourceHash: hash(100), destinationHash: hash(101) }, journal: { amount: "42", hash: hash(99) } };
  const proof: BaseNativeRunAcceptance = { version: 1, graphFingerprint: baseCollectorGraphFingerprint(f.manifest), sourceHash: hash(100), destinationHash: hash(101),
    nativeExecutionSha256: await baseNativeExecutionSha256(f.manifest.activation.nativeExecution), jobId: "actual-native-job", evidenceUri: "reviewed-evidence/native-run.json", evidenceSha256: hash(102), signer: governor.address, signature: "0x" };
  await assert.rejects(() => verifyBaseNativeRunAuthority(f.client, f.manifest, 1000n), /scheduled job/);
  proof.signature = await governor.signMessage({ message: baseNativeRunAcceptanceMessage(proof) }); f.manifest.activation.nativeRunAcceptance = proof;
  assert.deepEqual(await verifyBaseNativeRunAuthority(f.client, f.manifest, 1000n), proof);
  for (const [field, value] of [["sourceHash", hash(5)], ["destinationHash", hash(5)], ["graphFingerprint", hash(5)], ["nativeExecutionSha256", hash(5)], ["jobId", ""], ["evidenceSha256", hash(5)], ["evidenceUri", "changed"], ["signer", keeper]] as const) {
    const mutated = structuredClone(f.manifest); (mutated.activation.nativeRunAcceptance as any)[field] = value;
    await assert.rejects(() => verifyBaseNativeRunAuthority(f.client, mutated, 1000n));
  }
  const mutated = structuredClone(f.manifest); (mutated.activation.nativeExecution as any).journal.amount = "43";
  await assert.rejects(() => verifyBaseNativeRunAuthority(f.client, mutated, 1000n), /scheduled job/);
  assert.equal(await baseNativeExecutionSha256({ b: hash(7).toUpperCase().replace("0X", "0x"), a: "42" }), await baseNativeExecutionSha256({ a: "42", b: hash(7) }));
});
test("native completed-run acceptance rechecks current governor EIP-1271 authority", async () => {
  const f = fixture(); f.manifest.activation.nativeExecution = { proof: { sourceHash: hash(100), destinationHash: hash(101) } };
  const proof: BaseNativeRunAcceptance = { version: 1, graphFingerprint: baseCollectorGraphFingerprint(f.manifest), sourceHash: hash(100), destinationHash: hash(101),
    nativeExecutionSha256: await baseNativeExecutionSha256(f.manifest.activation.nativeExecution), jobId: "native-job", evidenceUri: "native-run.json", evidenceSha256: hash(102), signer: governor.address, signature: "0x1234" };
  f.manifest.activation.nativeRunAcceptance = proof; let live = true, calls = 0;
  f.client.getCode = async () => "0x1234";
  f.client.readContract = (async ({ functionName }: { functionName: string }) => {
    assert.equal(functionName, "isValidSignature"); calls++; return live ? "0x1626ba7e" : "0x00000000";
  }) as typeof f.client.readContract;
  await verifyBaseNativeRunAuthority(f.client, f.manifest, 1000n); live = false;
  await assert.rejects(() => verifyBaseNativeRunAuthority(f.client, f.manifest, 1001n), /signature|authority|governor/i); assert.equal(calls, 2);
});
