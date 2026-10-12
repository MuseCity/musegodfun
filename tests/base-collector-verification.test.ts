import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeDeployData, encodeEventTopics, getAddress, keccak256, padHex, parseAbiItem, zeroHash,
  type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import splitsCode from "../contracts/artifacts/base-collector/splits-base-code.json";
import collectorArtifact from "../contracts/artifacts/base-collector/MusegodBaseFeeCollector.json";
import robinhoodDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import buybackConfig from "../contracts/buyback.config.json";
import { BASE_COLLECTOR_MANIFEST, baseCollectorExpectedRuntime, baseCollectorGraphFingerprint,
  verifyBaseCollectorForOperator, verifyBaseAutomationAccount, assertBaseKeeperLiveAuthority,
  verifyBaseCollectorForKeeperStartup,
  BASE_SPLITS_FACTORY, BASE_SPLITS_FACTORY_HASH, BASE_SPLITS_IMPLEMENTATION, BASE_SPLITS_IMPLEMENTATION_HASH,
  BASE_SPLITS_PROXY_HASH, type BaseCollectorClient, type BaseCollectorManifest, type BaseTrustedSplitsAcceptance,
  baseSplitsSignerAuthority, baseTrustedSplitsMessage, verifyBaseTrustedSplitsAuthority } from "../server/base-collector";
import { CONTRACTS } from "../src/lib/config";
import { prepareBaseCollectorDeploymentSequence } from "../scripts/deploy-base-collector";
import { contractIdentityOnce, type ContractIdentityStore } from "../server/contract-identity";
const address = (value: number) => getAddress(`0x${value.toString(16).padStart(40, "0")}`);
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const governor = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const collector = address(10), automation = address(11), implementation = BASE_SPLITS_IMPLEMENTATION, keeper = address(13), automationSigner = address(14);
const runtime = "0x6001600055" as Hex, implementationCode = splitsCode.implementationCode as Hex, proxyCode = splitsCode.proxyCode as Hex, factoryCode = splitsCode.factoryCode as Hex;
function fixture() {
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  // Each offline scenario chooses its own acceptance; never inherit a live owner signature.
  manifest.activation = { status: "not_run" };
  manifest.canaryAuthorization = null;
  manifest.status = "deployed_verified";
  manifest.constants.governor = governor.address; manifest.constants.automationReceiver = automation;
  manifest.collector = { address: collector, runtimeHash: hash(0), transactionHash: hash(1), blockNumber: "100" };
  for (const entry of Object.values(manifest.dependencies)) Object.assign(entry, { runtimeHash: keccak256(runtime), proxyImplementation: null, proxyCheck: "direct" });
  manifest.automationAccount = { address: automation, runtimeHash: BASE_SPLITS_PROXY_HASH,
    factory: { address: BASE_SPLITS_FACTORY, runtimeHash: BASE_SPLITS_FACTORY_HASH }, creation: { owner: governor.address, threshold: 1, signers: [{ slot1: padHex(automationSigner, { size: 32 }), slot2: zeroHash }], salt: "8453" }, implementation: { address: implementation, runtimeHash: keccak256(implementationCode) },
    owner: governor.address, threshold: 1, signers: [{ index: 7, slot1: padHex(automationSigner, { size: 32 }), slot2: zeroHash }], initializationHash: hash(2), blockNumber: "90" };
  manifest.nativeRule.ruleId = "reviewed-dedicated-base-rule"; manifest.nativeRule.configurationSha256 = hash(6);
  const code = baseCollectorExpectedRuntime(manifest); manifest.collector.runtimeHash = keccak256(code);
  const getters: Record<string, unknown> = { initializer: CONTRACTS.initializer, rehype: CONTRACTS.rehype, governor: governor.address,
    automationReceiver: automation, paused: false, SOURCE_CHAIN_ID: 8453n, LP_SHARE: 228n * 10n ** 15n, HOOK_SHARE: 24n * 10n ** 16n };
  const accountGetters: Record<string, unknown> = { owner: governor.address, getThreshold: 1, getSignerCount: 1, getSigner: manifest.automationAccount.signers[0] };
  const initialEvent = parseAbiItem("event InitializedSigners((bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold)");
  const initializationLog = { address: automation, topics: encodeEventTopics({ abi: [initialEvent], eventName: "InitializedSigners" }),
    data: encodeAbiParameters([{ type: "tuple[]", components: [{ name: "slot1", type: "bytes32" }, { name: "slot2", type: "bytes32" }] }, { type: "uint8" }],
      [[{ slot1: padHex(automationSigner, { size: 32 }), slot2: zeroHash }], 1]), logIndex: 0 };
  const ownershipEvent = parseAbiItem("event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)");
  const factoryEvent = parseAbiItem("event SmartVaultCreated(address indexed smartVault,address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt)");
  const ownerLog = { address: automation, topics: encodeEventTopics({ abi: [ownershipEvent], eventName: "OwnershipTransferred", args: { previousOwner: address(0), newOwner: governor.address } }), data: "0x", logIndex: 1 };
  const factoryLog = { address: BASE_SPLITS_FACTORY, topics: encodeEventTopics({ abi: [factoryEvent], eventName: "SmartVaultCreated", args: { smartVault: automation } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "tuple[]", components: [{ name: "slot1", type: "bytes32" }, { name: "slot2", type: "bytes32" }] }, { type: "uint8" }, { type: "uint256" }],
      [governor.address, [{ slot1: padHex(automationSigner, { size: 32 }), slot2: zeroHash }], 1, 8453n]), logIndex: 2 };
  const creationData = encodeDeployData({ abi: collectorArtifact.abi as Abi, bytecode: collectorArtifact.bytecode as Hex,
    args: [CONTRACTS.initializer, CONTRACTS.rehype, governor.address, automation] });
  let calls = 0, changedCode: Address | undefined, wrongProxy = false, reorg = false, chainId = 8453, missingInit = false, wrongConstructor = false, wrongPrediction = false, fakeFactoryEvent = false, fakeOwner = false, fakeInitialSigner = false;
  const moduleLogs: any[] = []; let enabledModule = false;
  const client = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => moduleLogs.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
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
        if (functionName === "isModuleEnabled") return enabledModule;
        if (functionName === "FACTORY") return BASE_SPLITS_FACTORY;
        if (functionName === "getImplementation") return implementation;
        if (blockNumber === 90n) return functionName === "owner" ? governor.address : functionName === "getThreshold" || functionName === "getSignerCount" ? 1 :
          args?.[0] === 0 ? { slot1: fakeInitialSigner ? hash(66) : padHex(automationSigner, { size: 32 }), slot2: zeroHash } : { slot1: zeroHash, slot2: zeroHash };
        return functionName === "getSigner" ? args?.[0] === 7 ? accountGetters.getSigner : { slot1: zeroHash, slot2: zeroHash } : accountGetters[functionName];
      }
      return getters[functionName]; },
    getTransactionReceipt: async ({ hash: transactionHash }: { hash: Hex }) => { calls++; const initialization = transactionHash === hash(2);
      return { status: "success", transactionHash, contractAddress: initialization ? null : collector, blockNumber: initialization ? 90n : 100n,
        blockHash: hash(initialization ? 90 : 100), logs: initialization && !missingInit ? [initializationLog, fakeOwner ? { ...ownerLog, topics: encodeEventTopics({ abi: [ownershipEvent], eventName: "OwnershipTransferred", args: { previousOwner: address(0), newOwner: address(999) } }) } : ownerLog, fakeFactoryEvent ? { ...factoryLog, address: address(998) } : factoryLog] : [] }; },
    getTransaction: async () => { calls++; return { to: null, input: wrongConstructor ? "0x1234" : creationData, value: 0n, from: governor.address }; },
  } as unknown as BaseCollectorClient;
  return { manifest, client, getters, accountGetters, moduleLogs, moduleEnabled: (value: boolean) => { enabledModule = value; }, calls: () => calls, mutate: (value: { changedCode?: Address; wrongProxy?: boolean; reorg?: boolean; chainId?: number; missingInit?: boolean; wrongConstructor?: boolean; wrongPrediction?: boolean; fakeFactoryEvent?: boolean; fakeOwner?: boolean; fakeInitialSigner?: boolean }) => {
    changedCode = value.changedCode; wrongProxy = value.wrongProxy ?? false; reorg = value.reorg ?? false; chainId = value.chainId ?? 8453; missingInit = value.missingInit ?? false; wrongConstructor = value.wrongConstructor ?? false; wrongPrediction = value.wrongPrediction ?? false; fakeFactoryEvent = value.fakeFactoryEvent ?? false; fakeOwner = value.fakeOwner ?? false; fakeInitialSigner = value.fakeInitialSigner ?? false;
  } };
}
const readOnly = { requireActivation: false };
test("graph fingerprint excludes activation/auth proofs but binds the native rule and all receiver signers", () => {
  const f = fixture(), before = baseCollectorGraphFingerprint(f.manifest);
  f.manifest.activation.status = "canary_verified"; assert.equal(baseCollectorGraphFingerprint(f.manifest), before);
  f.manifest.nativeRule.configurationSha256 = hash(333); assert.notEqual(baseCollectorGraphFingerprint(f.manifest), before);
  f.manifest.nativeRule.configurationSha256 = hash(6); f.manifest.automationAccount.signers[0].slot1 = hash(44);
  assert.notEqual(baseCollectorGraphFingerprint(f.manifest), before);
});
test("unsigned native Collector deployment has one CREATE and no module or role enabling", async () => {
  const pending = structuredClone(BASE_COLLECTOR_MANIFEST);
  pending.activation = { status: "not_run" };
  pending.canaryAuthorization = null;
  pending.status = "not_deployed";
  Object.assign(pending.collector, { address: null, runtimeHash: null, transactionHash: null, blockNumber: null });
  pending.constants.automationReceiver = null;
  Object.assign(pending.automationAccount, { address: null, runtimeHash: null, implementation: null, owner: null, ownerRuntimeHash: null,
    threshold: null, signers: [], initializationHash: null, blockNumber: null, creation: null });
  await assert.rejects(() => prepareBaseCollectorDeploymentSequence(pending, governor.address, 2n), /dedicated Base/);
  const f = fixture(); f.manifest.collector.address = null;
  const proposal = await prepareBaseCollectorDeploymentSequence(f.manifest, governor.address, 2n);
  assert.equal(proposal.transactions.length, 1); assert.equal(proposal.initiallyPaused, true);
  assert(!("executionModule" in proposal)); assert(!("nonceMustRemainConsecutive" in proposal));
});

test("official factory origin rejects forged factory events, wrong CREATE2 address and initial owner/signers", async () => {
  for (const field of ["wrongPrediction", "fakeFactoryEvent", "fakeOwner", "fakeInitialSigner"] as const) {
    const f = fixture(); f.mutate({ [field]: true }); await assert.rejects(() => verifyBaseCollectorForOperator(f.client, collector, { manifest: f.manifest, ...readOnly }));
  }
  const implementation = fixture(); implementation.manifest.automationAccount.implementation!.runtimeHash = keccak256(runtime);
  await assert.rejects(() => verifyBaseCollectorForOperator(implementation.client, collector, { manifest: implementation.manifest, ...readOnly }), /official Base Splits/);
  const factory = fixture(); factory.manifest.automationAccount.factory.address = address(999);
  await assert.rejects(() => verifyBaseCollectorForOperator(factory.client, collector, { manifest: factory.manifest, ...readOnly }), /official Base Splits/);
  assert.equal(keccak256(factoryCode), BASE_SPLITS_FACTORY_HASH); assert.equal(keccak256(implementationCode), BASE_SPLITS_IMPLEMENTATION_HASH);
});

test("canonical initialization and exact constructor required, counterfactual account never enough", async () => {
  for (const field of ["missingInit", "wrongConstructor", "reorg"] as const) {
    const f = fixture(); f.mutate({ [field]: true }); await assert.rejects(() => verifyBaseCollectorForOperator(f.client, collector, { manifest: f.manifest, ...readOnly }));
  }
  const f = fixture(); f.manifest.automationAccount.initializationHash = null;
  await assert.rejects(() => verifyBaseCollectorForOperator(f.client, collector, { manifest: f.manifest, ...readOnly }), /initialized Splits/); assert.equal(f.calls(), 0);
});
test("wrong chain, recipient, policy and share never enable Base", async () => {
  const wrongChain = fixture(); wrongChain.mutate({ chainId: 4663 }); await assert.rejects(() => verifyBaseCollectorForOperator(wrongChain.client, collector, { manifest: wrongChain.manifest, ...readOnly }), /chain 8453/);
  for (const [name, value] of [["automationReceiver", address(66)], ["LP_SHARE", 1n], ["HOOK_SHARE", 2n]] as const) {
    const f = fixture(); f.getters[name] = value; await assert.rejects(() => verifyBaseCollectorForOperator(f.client, collector, { manifest: f.manifest, ...readOnly }), /economic shares differ/);
  }
  const f = fixture(); f.manifest.nativeRule.recipient = collector;
  await assert.rejects(() => verifyBaseCollectorForOperator(f.client, collector, { manifest: f.manifest, ...readOnly }), /route.*changed/); assert.equal(f.calls(), 0);
});async function trustedAcceptance(f: ReturnType<typeof fixture>) {
  const acceptance: BaseTrustedSplitsAcceptance = { version:1,sourceChainId:8453,destinationChainId:4663,
    graphFingerprint:baseCollectorGraphFingerprint(f.manifest),collector,automationReceiver:automation,
    destinationTreasury:f.manifest.constants.destinationTreasury,destinationWeth:f.manifest.constants.destinationWeth,
    destinationVault:f.manifest.finalSettlement.vault,keeper,ruleId:f.manifest.nativeRule.ruleId!,
    configurationSha256:f.manifest.nativeRule.configurationSha256!,trustSplitsNativeExecution:true,signer:governor.address,signature:"0x" };
  acceptance.signature=await governor.signMessage({message:baseTrustedSplitsMessage(acceptance)});
  f.manifest.activation={status:"trusted_splits_authorized",trustedSplitsAcceptance:acceptance};f.manifest.canaryAuthorization=null;
  return acceptance;
}

test("trusted Splits acceptance authenticates the configured project path without inventing any execution proof",async()=>{
  const f=fixture();const acceptance=await trustedAcceptance(f);let receipts=0;
  f.client.getTransactionReceipt=async()=>{receipts++;throw new Error("There is no manufactured fee, wallet or provider-run receipt");};
  assert.equal(await verifyBaseTrustedSplitsAuthority(f.client,f.manifest,1000n),acceptance);
  assert.equal(f.manifest.activation.nativeExecution,undefined);assert.equal(f.manifest.canaryAuthorization,null);assert.equal(receipts,0);
  f.mutate({chainId:4663});await assert.rejects(()=>verifyBaseTrustedSplitsAuthority(f.client,f.manifest,1000n),/Base RPC/);
});

test("trusted acceptance signature binds chains, graph, assets, accounts, rule, keeper and the explicit trust decision",async()=>{
  const mutations: [string,unknown][]=[["version",2],["sourceChainId",4663],["destinationChainId",8453],["graphFingerprint",hash(777)],
    ["collector",address(777)],["automationReceiver",address(777)],["destinationTreasury",address(777)],["destinationWeth",address(777)],
    ["destinationVault",address(777)],["keeper",address(777)],["ruleId","another-rule"],["configurationSha256",hash(777)],
    ["trustSplitsNativeExecution",false],["signer",keeper],["signature","0x"]];
  for(const [field,value] of mutations){const f=fixture();await trustedAcceptance(f);(f.manifest.activation.trustedSplitsAcceptance as any)[field]=value;
    await assert.rejects(()=>verifyBaseTrustedSplitsAuthority(f.client,f.manifest,1000n),Error,field);}
  const other=fixture();const acceptance=await trustedAcceptance(other);
  acceptance.signature=await privateKeyToAccount(hash(2)).signMessage({message:baseTrustedSplitsMessage(acceptance)});
  await assert.rejects(()=>verifyBaseTrustedSplitsAuthority(other.client,other.manifest,1000n),/governor|signature/);
});


test("manual graph verification preserves exact immutable shares and does not scan modules", async()=>{
 const f=fixture();f.client.getLogs=async()=>{throw new Error('NO_MODULE_HISTORY');};
 const graph=await verifyBaseCollectorForOperator(f.client,collector,{manifest:f.manifest,requireActivation:false});
 assert.equal(graph.runtimeHash,keccak256(baseCollectorExpectedRuntime(f.manifest)));assert.equal(graph.automationReceiver,automation);
 for(const field of ['LP_SHARE','HOOK_SHARE']){const g=fixture();g.getters[field]=0n;await assert.rejects(()=>verifyBaseCollectorForOperator(g.client,collector,{manifest:g.manifest,requireActivation:false}),/economic/);}
});
test("per-transaction permissions fit a multicall and slot read; mutable changes defer signing",async()=>{
 const f=fixture();let rpc=0;
 f.client.multicall=(async({contracts}:any)=>{rpc++;return Promise.all(contracts.map((call:any)=>f.client.readContract(call)));}) as typeof f.client.multicall;
 const storage=f.client.getStorageAt;f.client.getStorageAt=async(args:any)=>{rpc++;return storage(args);};
 await assertBaseKeeperLiveAuthority(f.client,f.manifest,keeper);assert.equal(rpc,2);
 for(const mutate of [()=>f.getters.paused=true,()=>f.getters.governor=keeper,()=>f.accountGetters.owner=keeper,()=>f.accountGetters.getThreshold=2,()=>f.accountGetters.getSignerCount=2,()=>f.moduleEnabled(true),()=>f.accountGetters.getSigner={slot1:padHex(keeper,{size:32}),slot2:zeroHash},()=>f.mutate({wrongProxy:true})]){
  mutate();await assert.rejects(()=>assertBaseKeeperLiveAuthority(f.client,f.manifest,keeper));
  f.getters.paused=false;f.getters.governor=governor.address;f.accountGetters.owner=governor.address;f.accountGetters.getThreshold=1;f.accountGetters.getSignerCount=1;f.accountGetters.getSigner=f.manifest.automationAccount.signers[0];f.moduleEnabled(false);f.mutate({});
 }
});

async function sealedStartupFixture() {
  const f = fixture(), rows = new Map<string, any>();
  const store = (): ContractIdentityStore => ({
    getBuybackBatch: async id => structuredClone(rows.get(id) ?? null),
    compareAndSetBuybackAudit: async (row, previous) => {
      assert.deepEqual(rows.get(row.id) ?? null, previous);
      rows.set(row.id, structuredClone(row)); return true;
    },
  });
  const immutable = { collector, automationReceiver: automation, runtimeHash: f.manifest.collector.runtimeHash!,
    manifestFingerprint: baseCollectorGraphFingerprint(f.manifest), initialDeploymentBlock: "100",
    currentSettlementGraph: { vault: f.manifest.finalSettlement.vault, weth: f.manifest.constants.destinationWeth,
      swapper: robinhoodDeployment.contracts.swapper.address, engineForwarders: [robinhoodDeployment.contracts.engine.address, f.manifest.finalSettlement.forwarder] } };
  await contractIdentityOnce({}, { namespace: "base_collector_startup", store: store(),
    binding: { manifest: f.manifest, runtimeHash: f.manifest.collector.runtimeHash,
      expectedRuntime: keccak256(baseCollectorExpectedRuntime(f.manifest)), settlement: robinhoodDeployment },
    validate: () => true, verify: async () => immutable });
  return { f, store, rows };
}
test("startup reuses a durable immutable seal across clients while checking both networks and live pause", async () => {
  const { f, store } = await sealedStartupFixture(); let sourceNetwork = 0, destinationNetwork = 0, codeReads = 0;
  f.client.getChainId = async () => { sourceNetwork++; return 8453; };
  f.client.getCode = async () => { codeReads++; throw Error("Immutable code must not be re-read"); };
  const destination = { getChainId: async () => { destinationNetwork++; return 4663; } } as unknown as BaseCollectorClient;
  const first = await verifyBaseCollectorForKeeperStartup(f.client, destination, { manifest: f.manifest, auditStore: store() });
  assert.equal(first.paused, false); f.getters.paused = true;
  const second = await verifyBaseCollectorForKeeperStartup(f.client, destination, { manifest: f.manifest, auditStore: store() });
  assert.equal(second.paused, true); assert.equal(sourceNetwork, 2); assert.equal(destinationNetwork, 2); assert.equal(codeReads, 0);
  await assert.rejects(() => verifyBaseCollectorForKeeperStartup(f.client,
    { getChainId: async () => 8453 } as unknown as BaseCollectorClient, { manifest: f.manifest, auditStore: store() }), /RPC networks/);
});
test("changed startup manifests cannot reuse the prior private seal", async () => {
  const { f, store } = await sealedStartupFixture();
  f.manifest.nativeRule.configurationSha256 = hash(777);
  f.client.getCode = async () => { throw Error("Changed manifest requires verification"); };
  await assert.rejects(() => verifyBaseCollectorForKeeperStartup(f.client,
    { getChainId: async () => 4663 } as unknown as BaseCollectorClient,
    { manifest: f.manifest, auditStore: store() }), /Changed manifest requires verification/);
});
