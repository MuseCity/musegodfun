import { buybackGraphFingerprint, verifyBuybackActivation } from "../server/buyback-activation";
import type { BuybackDeployment } from "../server/buyback-engine";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, encodeFunctionData,
  getAddress, keccak256, parseAbi, zeroAddress,
  type Abi, type Address, type Hex, type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";
import buybackConfig from "../contracts/buyback.config.json";
import { MUSEGOD, MUSEGOD_ROUTER_VERIFICATION } from "../src/lib/musegod";

loadEnvironment();
const path = "contracts/artifacts/buyback-v2-deployment.json";
const serialize = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
type Constants = Record<Exclude<keyof typeof buybackConfig.constants, "automation">, Address> & { automation: Address | null };
const constants = Object.fromEntries(Object.entries(buybackConfig.constants).map(([name,value]) => [name,value === null ? null : getAddress(value)])) as Constants;
type Artifact = {
  contractName: string; abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  compiler: { version: string }; compilerInputSha256: string; creationBytecodeHash: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
  immutableASTbindings: Record<string,{ name: string; type: string }>;
};
type Entry = { address: Address | null; runtimeHash: Hex | null; creationHash?: Hex; compilerInputSha256?: string; sourceVerification?: unknown; blockNumber?: string };
type Deployment = {
  schemaVersion: number; chainId: number; status: string; configHash: string;
  constants: typeof constants; contracts: Record<"oracle"|"swapper"|"engine"|"executor"|"forwarder"|"assetOracle"|"vault",Entry>;
  assetFeedDescriptions: Record<string, { description: string; descriptionHash: string }>;
  transactions: Record<string,unknown>[]; [name:string]: unknown;
};
const modules = { oracle:"MusegodBuybackOracle", engine:"MusegodFeeEngine", executor:"MusegodBuybackExecutor", forwarder:"MusegodWethForwarder", assetOracle:"MusegodAssetFeedOracle", vault:"MusegodBuybackBudgetVault" } as const;
const artifactDirectory = (name:string) => ["MusegodFeeEngine","MusegodWethForwarder","MusegodAssetFeedOracle","MusegodBuybackBudgetVault"].includes(name) ? "contracts/artifacts/buyback-v2" : "contracts/artifacts";
const factoryAbi = parseAbi([
  "function swapperImpl() view returns(address)",
  "function createSwapper((address owner,bool paused,address beneficiary,address tokenToBeneficiary,(address oracle,(address factory,bytes data) createOracleParams) oracleParams,uint32 defaultScaledOfferFactor,((address base,address quote) quotePair,uint32 scaledOfferFactor)[] pairScaledOfferFactors) params) returns(address)",
  "event CreateSwapper(address indexed swapper,(address owner,bool paused,address beneficiary,address tokenToBeneficiary,address oracle,uint32 defaultScaledOfferFactor,((address base,address quote) quotePair,uint32 scaledOfferFactor)[] pairScaledOfferFactors) params)",
]);
const swapperAbi = parseAbi([
  "function owner() view returns(address)", "function paused() view returns(bool)",
  "function beneficiary() view returns(address)", "function tokenToBeneficiary() view returns(address)",
  "function oracle() view returns(address)", "function defaultScaledOfferFactor() view returns(uint32)",
  "function getPairScaledOfferFactors((address base,address quote)[] pairs) view returns(uint32[])",
]);
const bindingAbi = parseAbi([
  "function factory() view returns(address)", "function WETH9() view returns(address)",
  "function token0() view returns(address)", "function token1() view returns(address)",
  "function fee() view returns(uint24)", "function description() view returns(string)",
]);
const client = createPublicClient({ chain:robinhood, transport: (await import("viem")).http(runtimeFromEnv().rpcUrl,{timeout:30_000,retryCount:1}) });
let manifest: Deployment;
try { manifest = JSON.parse(await readFile(path,"utf8")); }
catch { throw new Error("Prepare the reviewed buyback deployment manifest first"); }
const artifacts = {} as Record<keyof typeof modules,Artifact>;
for (const [name,contractName] of Object.entries(modules)) {
  const artifact = JSON.parse(await readFile(`${artifactDirectory(contractName)}/${contractName}.json`,"utf8")) as Artifact;
  const input = await readFile(`${artifactDirectory(contractName)}/${contractName}.compiler-input.json`,"utf8");
  assert.equal(sha256(input),artifact.compilerInputSha256,"Compiler input changed after review");
  assert.equal(keccak256(artifact.bytecode),artifact.creationBytecodeHash,"Creation artifact changed");
  const sources = (JSON.parse(input) as { sources: Record<string,{content:string}> }).sources;
  for (const [source,entry] of Object.entries(sources)) {
    const file = resolve("contracts",source);
    assert(file.startsWith(resolve("contracts")+sep) && source.endsWith(".sol"),"Compiler source escapes the contract source closure");
    assert.equal(await readFile(file,"utf8"),entry.content,`Stale compiler artifact for ${source}; rebuild before any broadcast`);
  }
  artifacts[name as keyof typeof modules] = artifact;
}
export function deploymentPrivateKey() {
  const raw = (process.env.MUSEGOD_DEPLOY_PRIVATE_KEY || process.env.EVM_DY)?.trim();
  return raw && /^[0-9a-fA-F]{64}$/.test(raw) ? `0x${raw}` : raw;
}

export async function saveDeploymentManifest(path:string,value:unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary,"wx",0o600);
    await file.writeFile(JSON.stringify(value,serialize,2)+"\n");
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary,path);
    const directory = await open(dirname(path),"r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
const save = () => saveDeploymentManifest(path,manifest);

// Code presence excludes an ordinary EOA; verify Splits identity and rules separately.
export function verifyAutomationReceiver(receiver:Address|null,operations:Address,code:Hex|null|undefined,dependencies:Record<string,Address|null> = {},deployedModules:(Address|null)[] = [],requireDeployed = true) {
  assert(receiver,"Configure the dedicated Robinhood Splits Automation public address before deployment");
  assert.notEqual(receiver.toLowerCase(),zeroAddress,"The Automation receiver cannot be zero");
  assert.notEqual(receiver.toLowerCase(),operations.toLowerCase(),"Automation buyback funds must be separate from operations treasury");
  assert.notEqual(receiver.toLowerCase(),constants.beneficiary.toLowerCase(),"The Automation receiver cannot be the burn destination");
  assert(!Object.entries(dependencies).some(([name,address]) => name !== "automation" && address?.toLowerCase() === receiver.toLowerCase())
    && !deployedModules.some((address) => address?.toLowerCase() === receiver.toLowerCase()),"The Automation receiver cannot be a protocol dependency");
  if (requireDeployed) assert(code && code !== "0x","The Automation receiver must be a deployed smart account on Robinhood Chain");
}

// Reverification preserves signed-rule evidence for the same deployment graph.
export function automationConfiguration(previous:unknown,expected:{account:Address;network:number;outputToken:Address;allocationBps:number;recipient:Address}) {
  if (previous && typeof previous === "object" && !Array.isArray(previous)) {
    const existing = previous as Record<string,unknown>;
    if (Object.entries(expected).every(([name,value]) => typeof value === "string"
      ? typeof existing[name] === "string" && (existing[name] as string).toLowerCase() === value.toLowerCase()
      : existing[name] === value)) return existing;
  }
  return {status:"pending_rule_signature",...expected,ruleSignature:"not_run",nativeExecution:"not_run"};
}

export function forwarderConfiguration(previous:unknown,expected:{source:Address;spender:Address;token:Address;recipient:Address}) {
  if (previous && typeof previous === "object" && !Array.isArray(previous)) {
    const existing = previous as Record<string,unknown>;
    if (Object.entries(expected).every(([name,value]) => typeof existing[name] === "string" && (existing[name] as string).toLowerCase() === value.toLowerCase())) return existing;
  }
  return {...expected,approval:"not_granted_by_deployment",nativeExecution:"not_run"};
}

export function engineDeploymentAllowed(reviewStatus:string,receiverCode:Hex|undefined|null,acceptance:{accountCodeFixtures?:unknown;policyMetadataFixtureOnly?:unknown}) {
  return reviewStatus === "passed" && !!receiverCode && receiverCode !== "0x" &&
    acceptance.policyMetadataFixtureOnly === false && Array.isArray(acceptance.accountCodeFixtures) && acceptance.accountCodeFixtures.length === 0;
}

export async function verifyModuleBindings(read:(name:string)=>Promise<unknown>,expected:Record<string,string|number>) {
  for (const [name,value] of Object.entries(expected)) {
    const actual = await read(name);
    if (typeof value === "string") {
      assert.equal(String(actual).toLowerCase(),value.toLowerCase(),`The ${name} deployment binding differs from the reviewed configuration`);
    } else assert.equal(Number(actual),value,`The ${name} deployment binding differs from the reviewed configuration`);
  }
}

async function ownRuntime(name:keyof typeof modules,address:Address,bindings:Record<string,string|number>) {
  const artifact = artifacts[name];
  const blockNumber = await client.getBlockNumber({cacheTime:0});
  const actual = await client.getCode({address,blockNumber});
  assert(actual && actual !== "0x",`${name} has no deployed code`);
  await verifyModuleBindings((functionName) => client.readContract({address,abi:artifact.abi,functionName,blockNumber}),bindings);
  let expected = artifact.deployedBytecode.slice(2);
  for (const [id,refs] of Object.entries(artifact.immutableReferences)) {
    const binding = artifact.immutableASTbindings[id];
    assert(binding,`Missing immutable compiler binding ${id}`);
    const value = await client.readContract({address,abi:artifact.abi,functionName:binding.name,blockNumber}) as string|number|bigint;
    const encoded = typeof value === "string" ? value.replace(/^0x/,"").toLowerCase().padStart(64,"0")
      : BigInt(value).toString(16).padStart(64,"0");
    assert.equal(encoded.length,64);
    for (const ref of refs) {
      assert.equal(ref.length,32);
      expected = expected.slice(0,ref.start*2)+encoded+expected.slice((ref.start+ref.length)*2);
    }
  }
  assert.equal(actual.toLowerCase(),"0x"+expected.toLowerCase(),`${name} runtime differs from reviewed compiler output`);
  return {address,runtimeHash:keccak256(actual),compilerInputSha256:artifact.compilerInputSha256};
}

async function sourceVerify(name:keyof typeof modules,address:Address,creationHash:Hex,submit = true) {
  const artifact = artifacts[name];
  const url = `https://sourcify.dev/server/v2/contract/4663/${address}`;
  const check = async () => {
    const r = await fetch(url,{signal:AbortSignal.timeout(20_000)});
    if (!r.ok) return null;
    const body = await r.json() as {creationMatch?:string;runtimeMatch?:string;verifiedAt?:string};
    return body.creationMatch === "exact_match" && body.runtimeMatch === "exact_match" ? body : null;
  };
  const existing = await check(); if (existing) return existing;
  if (!submit) return {status:"not_submitted",url};
  const response = await fetch(`https://sourcify.dev/server/v2/verify/4663/${address}`,{
    method:"POST",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(30_000),
    body:JSON.stringify({stdJsonInput:JSON.parse(await readFile(`${artifactDirectory(artifact.contractName)}/${artifact.contractName}.compiler-input.json`,"utf8")),
      compilerVersion:artifact.compiler.version,contractIdentifier:`src/${artifact.contractName}.sol:${artifact.contractName}`,creationTransactionHash:creationHash}),
  });
  assert(response.ok,`Source verification submission failed for ${name}`);
  const job = await response.json() as {verificationId:string};
  for (let attempt=0;attempt<8;++attempt) {
    await new Promise((resolve) => setTimeout(resolve,2000));
    const verified = await check();
    if (verified) return {verificationId:job.verificationId,...verified};
  }
  return {verificationId:job.verificationId,status:"pending",url};
}

async function main(args=process.argv.slice(2)) {
  const deploy = args.includes("--deploy");
  assert(args.every((arg) => ["--deploy", "--verify-only"].includes(arg)), "Use --deploy or --verify-only");
  assert(!(deploy && args.includes("--verify-only")), "Choose one deployment mode");
  assert.equal(await client.getChainId(),4663,"Deployment requires Robinhood mainnet 4663");
  assert.equal(manifest.chainId,4663);
  assert.equal(manifest.schemaVersion,2,"Legacy deployment records must never be overwritten");
  assert.equal(buybackConfig.unpricedFeePolicy,"splits-automation","Unsupported fees require the reviewed Splits Automation route");
  const automation = constants.automation;
  const receiverCode = automation ? await client.getCode({address:automation}) : null;
  if (deploy || automation) verifyAutomationReceiver(automation,constants.treasury,receiverCode,constants,Object.values(manifest.contracts).map((entry) => entry.address),false);
  let reviewedStatus = "not_reviewed";
  let acceptedFork: {accountCodeFixtures?:unknown;policyMetadataFixtureOnly?:unknown} = {};
  let fullDeploymentApproved = false;
  if (deploy) {
    const review = JSON.parse(await readFile("docs/evidence/buyback-v2-review.json","utf8")) as {
      status: string; sourceHashes: Record<string,string>;
    };
    assert(["passed","passed_for_bootstrap"].includes(review.status),"The fixed WETH bridge must pass independent review before any deployment");
    reviewedStatus = review.status;
    for (const [source,expected] of Object.entries(review.sourceHashes))
      assert.equal(sha256(await readFile(source,"utf8")),expected,"Production source changed after review");
    const acceptance = JSON.parse(await readFile("docs/evidence/buyback-v2-fork.json","utf8"));
    acceptedFork = acceptance;
    fullDeploymentApproved = review.status === "passed";
    assert(acceptance.snapshotRestored === true && acceptance.snapshotContractRemovalVerified === true
      && acceptance.blockedUpstreamWrites === 0 && acceptance.fullWethSettlementSafetyPassed === true
      && acceptance.fullUnpricedFeeAutomationTransferPassed === true
      && acceptance.fullSourceWethForwarderFlowPassed === true
      && !acceptance.failure && !acceptance.cleanupFailure,
      "A completed isolated fork acceptance is required before deployment");
    if (fullDeploymentApproved) assert(acceptance.policyMetadataFixtureOnly === false && Array.isArray(acceptance.accountCodeFixtures) && acceptance.accountCodeFixtures.length === 0,"Production Engine deployment needs real receiver code proof, not account code fixtures");
    assert.equal(getAddress(acceptance.sourceWethFlow?.source),constants.automationTreasury,"The WETH bridge fork proof belongs to another source Treasury");
    assert.equal(getAddress(acceptance.unpricedAutomationFlow?.fixedAutomation),automation,"The unpriced fee fork proof belongs to another Automation account");
    assert.equal(acceptance.configHash,sha256(await readFile("contracts/buyback.config.json","utf8")),"Fork evidence belongs to another fixed deployment configuration");
    assert.equal(acceptance.sourceHash,sha256(await readFile("scripts/test-buyback-engine-fork.ts","utf8")),"Fork evidence belongs to another acceptance script");
    for (const contractName of Object.values(modules))
      assert.equal(acceptance.artifactHashes[contractName],sha256(await readFile(`${artifactDirectory(contractName)}/${contractName}.json`,"utf8")),"Fork evidence belongs to another compiler artifact");
  }
  const configText = await readFile("contracts/buyback.config.json","utf8");
  assert.notEqual(constants.treasury,zeroAddress,"The operations treasury must be configured");
  assert.notEqual(constants.automationTreasury,constants.treasury,"The WETH source must be separate from operations");
  assert.notEqual(constants.automationTreasury,automation,"The native sweep source must be separate from Automation");
  if (Object.values(manifest.contracts).some((entry) => entry.address))
    assert.equal(manifest.configHash,sha256(configText),"Fixed config changed after a deployment; do not redeploy blindly");
  manifest.configHash = sha256(configText); manifest.constants = constants;
  const blockNumber = await client.getBlockNumber({cacheTime:0});
  const block = await client.getBlock({blockNumber});
  const dependencyEvidence: Record<string,unknown>[] = [];
  for (const [name,expected] of Object.entries(buybackConfig.expectedRuntimeHashes)) {
    if (name === "swapperClone") continue;
    const address = constants[name as keyof typeof constants];
    assert(address,`Missing dependency ${name}`);
    const runtime = await client.getCode({address,blockNumber});
    assert(runtime && runtime !== "0x",`Missing dependency code: ${name}`);
    assert.equal(keccak256(runtime),expected,`The reviewed ${name} dependency changed`);
    dependencyEvidence.push({name,address,runtimeHash:expected});
  }
  assert.equal(await client.readContract({address:constants.swapperFactory,abi:factoryAbi,functionName:"swapperImpl",blockNumber}),constants.swapperImpl);
  const [factory,routerWeth,routerFactory] = await Promise.all([
    client.readContract({address:constants.museWethPool,abi:bindingAbi,functionName:"factory",blockNumber}),
    client.readContract({address:constants.swapRouter,abi:bindingAbi,functionName:"WETH9",blockNumber}),
    client.readContract({address:constants.swapRouter,abi:bindingAbi,functionName:"factory",blockNumber}),
  ]);
  assert.equal(routerWeth,constants.weth); assert.equal(routerFactory,factory);
  assert.equal(constants.swapRouter,MUSEGOD.router); assert.equal(factory,MUSEGOD.factory);
  const swapRouterCode = await client.getCode({address:constants.swapRouter,blockNumber});
  assert(swapRouterCode && keccak256(swapRouterCode) === MUSEGOD_ROUTER_VERIFICATION.runtimeHash,"The verified Router02 runtime changed");
  manifest.preflight = {blockNumber:String(blockNumber),blockHash:block.hash,dependencies:dependencyEvidence,feedCount:buybackConfig.feeds.length,
    unsupportedAssets:buybackConfig.unsupported.length,automationReceiver:!automation ? "not_configured" : receiverCode && receiverCode !== "0x" ? "deployed_contract_observed" : "counterfactual_not_deployed",automationNativeExecution:"not_run",initialMainnetFeeExecution:"not_run"};
  await save();

  const rawKey = deploymentPrivateKey();
  const account = deploy && rawKey && /^0x[0-9a-fA-F]{64}$/.test(rawKey) ? privateKeyToAccount(rawKey as Hex) : null;
  if (deploy) assert(account,"Configure the local deployment signer (MUSEGOD_DEPLOY_PRIVATE_KEY or EVM_DY); never send it in chat");
  const wallet = account ? createWalletClient({chain:robinhood,account,transport:(await import("viem")).http(runtimeFromEnv().rpcUrl,{timeout:30_000,retryCount:0})}) : null;
  if (account && !Object.values(manifest.contracts).some((entry) => entry.address)) {
    const [balance,gasPrice] = await Promise.all([client.getBalance({address:account.address}),client.getGasPrice()]);
    assert(balance >= 12_000_000n*gasPrice*2n,"The deployer needs enough native ETH for all deployment steps with the fee buffer");
    console.log(JSON.stringify({deployer:account.address,chainId:4663,balance:String(balance),reservedGasBudget:String(12_000_000n*gasPrice*2n)}));
  }
  async function broadcast(stage:string,to:Address|undefined,data:Hex):Promise<TransactionReceipt> {
    assert(wallet && account,"Deployment signature is required");
    const prior = manifest.transactions.find((transaction) => transaction.stage === stage);
    if (prior) {
      assert.equal(prior.dataHash,keccak256(data),"A recorded deployment step has different calldata; do not repeat it");
      assert.equal(prior.to,to??null,"A recorded deployment step has another recipient");
      const known = await client.getTransactionReceipt({hash:prior.hash as Hex});
      assert.equal(known.status,"success","The recorded deployment did not succeed; review before any retry");
      const transaction = await client.getTransaction({hash:prior.hash as Hex});
      assert.equal(transaction.from.toLowerCase(),account.address.toLowerCase(),"The recorded deployment belongs to another signer");
      assert.equal(transaction.nonce,prior.nonce,"The recorded deployment has another nonce");
      assert.equal(transaction.to?.toLowerCase()??null,to?.toLowerCase()??null,"The recorded deployment has another on-chain recipient");
      assert.equal(keccak256(transaction.input),keccak256(data),"The recorded deployment has another on-chain payload");
      assert.equal(transaction.value,0n,"The recorded deployment has an unexpected native-token value");
      const receipt = await client.waitForTransactionReceipt({hash:prior.hash as Hex,confirmations:2,timeout:120_000});
      assert.equal(receipt.status,"success","The recorded deployment did not succeed; review before any retry");
      assert.equal((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash,"The recorded deployment receipt is no longer canonical");
      prior.status = "confirmed"; await save();
      return receipt; // Recover its address/event; never send the confirmed step twice.
    }
    const [estimated,quotedGasPrice,nonce] = await Promise.all([
      client.estimateGas({account:account.address,to,data,value:0n}),client.getGasPrice(),client.getTransactionCount({address:account.address,blockTag:"pending"}),
    ]);
    const gas = estimated*130n/100n+50_000n;
    const gasPrice = quotedGasPrice*2n; // A new block can raise the Robinhood base fee before broadcast.
    const signed = await wallet.signTransaction({account,chain:robinhood,to,data,value:0n,gas,gasPrice,nonce,type:"legacy"});
    const hash = keccak256(signed);
    const transaction:Record<string,unknown> = {stage,status:"broadcasting",hash,deployer:account.address,nonce,to:to??null,dataHash:keccak256(data),gasLimit:String(gas),gasPrice:String(gasPrice)};
    manifest.transactions.push(transaction); await save();
    const sent = await client.sendRawTransaction({serializedTransaction:signed}); assert.equal(sent,hash);
    console.log(JSON.stringify({stage,hash,estimatedGas:String(estimated)}));
    const receipt = await client.waitForTransactionReceipt({hash,confirmations:2,timeout:120_000});
    transaction.status = receipt.status === "success" ? "confirmed" : "reverted";
    Object.assign(transaction,{blockNumber:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed),gasCost:String(receipt.gasUsed*receipt.effectiveGasPrice)});
    await save(); assert.equal(receipt.status,"success",`${stage} reverted`); return receipt;
  }
  async function ensureModule(name:keyof typeof modules,args:readonly unknown[],bindings:Record<string,string|number>) {
    let entry = manifest.contracts[name];
    if (!entry.address) {
      if (!deploy) return null;
      const r = await broadcast(name,undefined,encodeDeployData({abi:artifacts[name].abi,bytecode:artifacts[name].bytecode,args}));
      assert(r.contractAddress); entry = {...await ownRuntime(name,r.contractAddress,bindings),creationHash:r.transactionHash,blockNumber:String(r.blockNumber)};
      manifest.contracts[name] = entry; manifest.status = "partially_deployed"; await save();
    } else Object.assign(entry,await ownRuntime(name,entry.address,bindings));
    return entry.address;
  }
  const oracle = await ensureModule("oracle",[constants.weth,constants.muse,constants.museWethPool,constants.ethUsdFeed,buybackConfig.ethMaxAge,
    buybackConfig.feeds.map((f) => ({token:getAddress(f.token),feed:getAddress(f.feed),maxAge:f.maxAge,checkOraclePaused:f.checkOraclePaused}))],
    {weth:constants.weth,musegod:constants.muse,museWethPool:constants.museWethPool,ethUsdFeed:constants.ethUsdFeed,
      ethMaxAge:buybackConfig.ethMaxAge,ethFeedDecimals:8,TWAP_SECONDS:buybackConfig.twapSeconds});
  if (!oracle) { console.log(JSON.stringify({status:receiverCode && receiverCode !== "0x" ? "preflight_passed" : "dependency_preflight_passed",automation:!automation ? "not_configured" : receiverCode && receiverCode !== "0x" ? "contract_receiver_verified" : "counterfactual_not_deployed",deployment:"not_run",configHash:manifest.configHash})); return; }
  let swapper = manifest.contracts.swapper.address;
  if (!swapper) {
    assert(deploy,"The Oracle exists but Swapper creation has not completed");
    const data = encodeFunctionData({abi:factoryAbi,functionName:"createSwapper",args:[{owner:zeroAddress,paused:false,beneficiary:constants.beneficiary,tokenToBeneficiary:constants.muse,
      oracleParams:{oracle,createOracleParams:{factory:zeroAddress,data:"0x"}},defaultScaledOfferFactor:985000,pairScaledOfferFactors:[]}]});
    const receipt = await broadcast("swapper",constants.swapperFactory,data);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== constants.swapperFactory.toLowerCase()) continue;
      try { const event = decodeEventLog({abi:factoryAbi,data:log.data,topics:log.topics});
        if (event.eventName === "CreateSwapper") swapper = event.args.swapper;
      } catch {}
    }
    assert(swapper,"Missing factory CreateSwapper event");
    manifest.contracts.swapper = {address:swapper,runtimeHash:null,creationHash:receipt.transactionHash}; await save();
  }
  const code = await client.getCode({address:swapper}); assert(code);
  assert.equal(keccak256(code),buybackConfig.expectedRuntimeHashes.swapperClone,"Swapper clone runtime differs from the verified factory template");
  manifest.contracts.swapper.runtimeHash = keccak256(code);
  const read = (functionName:"owner"|"paused"|"beneficiary"|"tokenToBeneficiary"|"oracle"|"defaultScaledOfferFactor") =>
    client.readContract({address:swapper,abi:swapperAbi,functionName});
  assert.equal(await read("owner"),zeroAddress); assert.equal(await read("paused"),false);
  assert.equal(await read("beneficiary"),constants.beneficiary); assert.equal(await read("tokenToBeneficiary"),constants.muse);
  assert.equal(String(await read("oracle")).toLowerCase(),oracle.toLowerCase()); assert.equal(await read("defaultScaledOfferFactor"),985000);
  assert.deepEqual(await client.readContract({address:swapper,abi:swapperAbi,functionName:"getPairScaledOfferFactors",args:[[{base:constants.weth,quote:constants.muse}]]}),[0]);
  assert(automation,"Configure the dedicated Splits Automation account before deployment");
  const executor = await ensureModule("executor",[swapper,constants.swapRouter,constants.weth,constants.muse],
    {swapper,router:constants.swapRouter,weth:constants.weth,musegod:constants.muse});
  const assetOracle = await ensureModule("assetOracle",[constants.treasury,constants.weth,constants.ethUsdFeed,buybackConfig.ethMaxAge,
    buybackConfig.feeds.map((f) => ({token:getAddress(f.token),feed:getAddress(f.feed),maxAge:f.maxAge,checkOraclePaused:f.checkOraclePaused}))],
    {governor:constants.treasury,weth:constants.weth,FEED_CHANGE_DELAY:604800});
  if (!executor || !assetOracle) { console.log(JSON.stringify({status:manifest.status,deployment:"not_run",reason:"Asset oracle deployment pending"})); return; }
  for (const f of [{token:constants.weth,feed:constants.ethUsdFeed,maxAge:buybackConfig.ethMaxAge,checkOraclePaused:false,symbol:"WETH"}, ...buybackConfig.feeds]) {
    const token = getAddress(f.token), pinned = manifest.assetFeedDescriptions[token.toLowerCase()];
    assert(pinned && pinned.descriptionHash === keccak256(new TextEncoder().encode(pinned.description)), "Missing reviewed initial feed metadata");
    const [mapping, label] = await Promise.all([
      client.readContract({address:assetOracle,abi:artifacts.assetOracle.abi,functionName:"assetFeeds",args:[token]}),
      client.readContract({address:assetOracle,abi:artifacts.assetOracle.abi,functionName:"descriptionHash",args:[token]}),
    ]) as [readonly unknown[], unknown];
    assert.equal(label,pinned.descriptionHash,`The immutable ${f.symbol} feed label changed`);
    assert.equal(mapping[1],f.maxAge); assert.equal(mapping[2],f.symbol === "USDG" ? 6 : f.symbol === "cbBTC" ? 8 : 18);
    assert.equal(mapping[3],8); assert.equal(mapping[4],f.checkOraclePaused);
    if (deploy && !manifest.contracts.engine.address) assert.equal(String(mapping[0]).toLowerCase(),f.feed.toLowerCase(),"Initial feeds must match reviewed deployment arguments");
  }
  const vault = await ensureModule("vault",[constants.weth,constants.muse,oracle,swapper,executor],
    {weth:constants.weth,musegod:constants.muse,oracle,swapper,executor,pool:constants.museWethPool,WINDOW_SECONDS:300,WINDOW_CAP:"10000000000000000",MAX_DEVIATION_BPS:200});
  if (!vault) { console.log(JSON.stringify({status:manifest.status,deployment:"not_run",reason:"Budget vault deployment pending"})); return; }
  const forwarder = await ensureModule("forwarder",[constants.automationTreasury,constants.weth,swapper,vault],
    {source:constants.automationTreasury,weth:constants.weth,swapper,vault,MAX_ALLOWANCE:"2880000000000000000"});
  if (!forwarder) { console.log(JSON.stringify({status:manifest.status,deployment:"not_run",reason:"Forwarder deployment pending"})); return; }
  const verificationBlock = await client.getBlockNumber({cacheTime:0});
  for (const f of buybackConfig.feeds) {
    const values = await client.readContract({address:oracle,abi:artifacts.oracle.abi,functionName:"assetFeeds",args:[getAddress(f.token)],blockNumber:verificationBlock}) as readonly unknown[];
    assert.deepEqual(values,[getAddress(f.feed),f.maxAge,f.symbol === "USDG" ? 6 : f.symbol === "cbBTC" ? 8 : 18,8,f.checkOraclePaused],`The immutable ${f.symbol} price source differs`);
  }
  const currentReceiverCode = await client.getCode({address:automation});
  if (!currentReceiverCode || currentReceiverCode === "0x" || (deploy && !engineDeploymentAllowed(reviewedStatus,currentReceiverCode,acceptedFork)) || (!deploy && !manifest.contracts.engine.address)) {
    // These stages grant no allowance and cannot enable pools without the Engine.
    for (const name of ["oracle","forwarder","executor","assetOracle","vault"] as const) {
      const entry = manifest.contracts[name]; assert(entry.address && entry.creationHash);
      entry.sourceVerification = await sourceVerify(name,entry.address,entry.creationHash,deploy); await save();
    }
    manifest.status = !currentReceiverCode || currentReceiverCode === "0x" ? "bootstrap_deployed_pending_automation_initialization" : "bootstrap_deployed_pending_final_review";
    manifest.automation = automationConfiguration(manifest.automation,{account:automation,network:4663,outputToken:constants.weth,allocationBps:10000,recipient:constants.automationTreasury});
    manifest.forwarderSetup = forwarderConfiguration(manifest.forwarderSetup,{source:constants.automationTreasury,spender:forwarder,token:constants.weth,recipient:vault});
    await save();
    console.log(JSON.stringify({status:manifest.status,contracts:manifest.contracts,forwarderSetup:manifest.forwarderSetup},serialize,2));
    return;
  }
  verifyAutomationReceiver(automation,constants.treasury,currentReceiverCode,constants,Object.values(manifest.contracts).map((entry) => entry.address));
  const engine = await ensureModule("engine",[constants.initializer,constants.rehype,oracle,swapper,constants.weth,constants.muse,constants.router,constants.routerExecutor,automation,assetOracle,vault],
    {initializer:constants.initializer,rehype:constants.rehype,oracle,assetOracle,settlementVault:vault,swapper,weth:constants.weth,muse:constants.muse,
      router:constants.router,routerExecutor:constants.routerExecutor,automation,routerCodeHash:buybackConfig.expectedRuntimeHashes.router,
      routerExecutorCodeHash:buybackConfig.expectedRuntimeHashes.routerExecutor});
  assert(engine);
  manifest.status = "deployed_runtime_verified"; await save();
  for (const name of Object.keys(modules) as (keyof typeof modules)[]) {
    const entry = manifest.contracts[name]; assert(entry.address && entry.creationHash);
    entry.sourceVerification = await sourceVerify(name,entry.address,entry.creationHash,deploy); await save();
  }
  const complete = Object.keys(modules).every((key) => (manifest.contracts[key as keyof typeof modules].sourceVerification as {runtimeMatch?:string})?.runtimeMatch === "exact_match");
  manifest.status = complete ? "deployed_verified" : "deployed_runtime_verified";
  manifest.verifiedAt = new Date().toISOString(); manifest.verificationBlock = String(verificationBlock);
  manifest.graphFingerprint = buybackGraphFingerprint(manifest as unknown as BuybackDeployment);
  try {
    manifest.activationVerification = { status: "verified", ...await verifyBuybackActivation(client, manifest as unknown as BuybackDeployment, verificationBlock) };
  } catch {
    manifest.activationVerification = { status: "pending", reason: "Runtime/source verification does not activate the graph. Supply canonical funding/settlement receipts and governor-signed control and native scheduler attestations." };
  }
  manifest.mainnetFeeExecution ??= "not_run";
  manifest.automation = automationConfiguration(manifest.automation,{account:automation,network:4663,outputToken:constants.weth,allocationBps:10000,recipient:constants.automationTreasury});
  manifest.forwarderSetup = forwarderConfiguration(manifest.forwarderSetup,{source:constants.automationTreasury,spender:forwarder,token:constants.weth,recipient:vault});
  await save();
  console.log(JSON.stringify({status:manifest.status,contracts:manifest.contracts,activation:manifest.activationVerification,graphFingerprint:manifest.graphFingerprint,verificationBlock:String(verificationBlock)},serialize,2));
  assert(complete,"Deployment is recorded; finish pending source verification before enabling new pools");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
try { await main(); }
catch (error) {
  const failure = error as {shortMessage?:string;details?:string;message?:string};
  const diagnostic = failure.shortMessage ? `${failure.shortMessage}\n${failure.details ?? ""}` : failure.message ?? String(error);
  let message = redact(diagnostic.replace(/0x[0-9a-f]{128,}/gi,"[transaction payload redacted]"));
  for (const name of ["MUSEGOD_DEPLOY_PRIVATE_KEY","EVM_DY"]) {
    const key = process.env[name];
    if (key) message = message.split(key).join("[redacted]");
  }
  console.error(message); process.exitCode = 1;
}
}
