import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, getAddress, http, keccak256,
  padHex, parseAbi, parseAbiItem, parseEther, parseUnits, toHex, zeroAddress, zeroHash, type Address, type Hex, type Abi } from "viem";
import { base } from "viem/chains";
import { DopplerSDK, type V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import { CONTRACTS, STOCKS, SUPPLY, sameAddress } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { buildLaunch, assertEngineFeeCalldata, permit2Abi, swapTransaction } from "../src/lib/protocol";
import { readOpeningValuation } from "../server/opening-price";
import artifact from "../contracts/artifacts/base-collector/MusegodBaseFeeCollector.json";
import { startChainFork } from "./robinhood-fork";
import { mainnetRpcUrl, redact } from "../server/config";
import guardArtifact from "../contracts/artifacts/MusegodLaunchGuard.json";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { chainLaunchDependencies } from "../server/launch-guard";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector, type BaseCollectorManifest } from "../server/base-collector";

// Every signature/transaction is bound to unlocked local Anvil accounts. The upstream proxy only forwards reads.
const fork=await startChainFork(mainnetRpcUrl(8453),8453,8453);
assert.equal(new URL(fork.rpc).hostname,"127.0.0.1");
const client=createPublicClient({chain:base,transport:http(fork.rpc,{timeout:120_000,retryCount:0})});
assert.equal(await client.getChainId(),8453);assert.match(await fork.rpcCall("web3_clientVersion"),/anvil/i);
const accounts:Address[]=(await fork.rpcCall("eth_accounts") as Address[]).map(account=>getAddress(account));const[creator,governor]=accounts;
assert(creator !== governor);
const wallet=createWalletClient({chain:base,account:creator,transport:http(fork.rpc,{timeout:120_000})});
const governorWallet=createWalletClient({chain:base,account:governor,transport:http(fork.rpc,{timeout:120_000})});
const snapshot=await fork.rpcCall("evm_snapshot");
const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
const serialize=(_key:string,value:unknown)=>typeof value==="bigint"?value.toString():value;
const proof:Record<string,unknown>={version:3,scope:"Actual Base Splits factory/implementation and Doppler managers on isolated Anvil fork; fee claim/release to locally initialized native account only",
  upstreamChainId:8453,executionChainId:8453,forkBlockNumber:String(fork.blockNumber),sourceHash:sha256(await readFile(new URL(import.meta.url),"utf8")),
  artifactCreationHash:artifact.creationBytecodeHash,architecture:"splits-treasury-native-automation",existingAdAInitialization:"not_run",mainnetTransactionsSubmitted:false,crossChainFill:"not_run",robinhoodSettlement:"not_run",walletProductionAcceptance:"not_run",
  nativeAutomationScheduling:"not_run",nativeRelayCrossChain:"not_run",status:"running",stage:"initializing",snapshotRestored:false,blockedUpstreamWrites:0};
const abi=artifact.abi as Abi;
const balance=(token:Address,account:Address)=>client.readContract({address:token,abi:erc20Abi,functionName:"balanceOf",args:[account]});
const allowance=(token:Address,owner:Address,spender:Address)=>client.readContract({address:token,abi:erc20Abi,functionName:"allowance",args:[owner,spender]});
async function nowBlock(){const last=await client.getBlock();await fork.rpcCall("evm_setNextBlockTimestamp",[Number(last.timestamp+1n>BigInt(Math.floor(Date.now()/1000))?last.timestamp+1n:BigInt(Math.floor(Date.now()/1000)))]);await fork.rpcCall("anvil_mine",[1]);}
async function sent(hash:Hex){const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,"success",`Fork transaction ${hash} reverted`);return{hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,gasUsed:receipt.gasUsed,receipt};}
async function send(to:Address,data:Hex,signer=wallet,value=0n){
  await nowBlock(); const estimate=await client.estimateGas({account:signer.account.address,to,data,value});
  return sent(await signer.sendTransaction({to,data,value,gas:estimate*150n/100n+100_000n}));
}
async function read<T>(collector:Address,name:string,args?:readonly unknown[]){return await client.readContract({address:collector,abi,functionName:name,args})as T;}
let collector:Address|undefined;
let executionAccount:Address|undefined;
try{
  proof.stage="initialize_official_Base_Splits_fixture";console.log("Base fork: initialize_official_Base_Splits_fixture");
  const factory=getAddress("0x8E6Af8Ed94E87B4402D0272C5D6b0D47F0483e7C");
  const factoryAbi=parseAbi(["function getAddress(address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt) view returns(address)",
    "function createAccount(address owner,(bytes32 slot1,bytes32 slot2)[] signers,uint8 threshold,uint256 salt) returns(address)","function IMPLEMENTATION() view returns(address)"]);
  const accountAbi=parseAbi(["function owner() view returns(address)","function getThreshold() view returns(uint8)","function getSignerCount() view returns(uint8)",
    "function getSigner(uint8 index) view returns((bytes32 slot1,bytes32 slot2))","function isModuleEnabled(address) view returns(bool)",
    "function enableModule(address)","function execute((address target,uint256 value,bytes data) call)"]);
  const factoryCode=await client.getCode({address:factory});assert(factoryCode&&factoryCode!=="0x");
  const implementation=await client.readContract({address:factory,abi:factoryAbi,functionName:"IMPLEMENTATION"});
  const implementationCode=await client.getCode({address:implementation});assert(implementationCode&&implementationCode!=="0x");
  const signers=[{slot1:padHex(governor,{size:32}),slot2:zeroHash}];const fixtureSalt=8453n;
  executionAccount=await client.readContract({address:factory,abi:factoryAbi,functionName:"getAddress",args:[governor,signers,1,fixtureSalt]});
  assert(!sameAddress(executionAccount,getAddress("0xAdA3348D6fC8EcF7cc2DbCA931D038b4B2913E3a")));
  const initialization=await send(factory,encodeFunctionData({abi:factoryAbi,functionName:"createAccount",args:[governor,signers,1,fixtureSalt]}),governorWallet);
  const accountCode=await client.getCode({address:executionAccount});assert(accountCode&&accountCode!=="0x");
  assert.equal(await client.readContract({address:executionAccount,abi:accountAbi,functionName:"owner"}),governor);
  assert.equal(await client.readContract({address:executionAccount,abi:accountAbi,functionName:"getThreshold"}),1);
  proof.splitsFixture={scope:"Official actual Base factory and implementation; local fixture owner/signer/salt only",factory,factoryRuntimeHash:keccak256(factoryCode),
    implementation,implementationRuntimeHash:keccak256(implementationCode),account:executionAccount,accountRuntimeHash:keccak256(accountCode),owner:governor,signers,threshold:1,salt:fixtureSalt,initialization};
  proof.stage="deploy_collector";console.log("Base fork: deploy_collector");
  const deployment=await sent(await governorWallet.deployContract({abi,bytecode:artifact.bytecode as Hex,args:[CONTRACTS.initializer,CONTRACTS.rehype,governor,executionAccount]}));
  assert(deployment.receipt.contractAddress);collector=getAddress(deployment.receipt.contractAddress);proof.collector=collector;proof.deployment=deployment;
  assert.equal(await read(collector,"paused"),true);assert.equal(await read(collector,"governor"),governor);
  assert.equal(await read(collector,"automationReceiver"),executionAccount);
  proof.stage="actual_execution_graph_verification";console.log("Base fork: actual_execution_graph_verification");
  const actualManifest=structuredClone(BASE_COLLECTOR_MANIFEST) as BaseCollectorManifest;
  actualManifest.status="deployed_verified";
  actualManifest.constants.governor=governor;actualManifest.constants.automationReceiver=executionAccount;
  const collectorCode=await client.getCode({address:collector});assert(collectorCode&&collectorCode!=="0x");
  actualManifest.collector={address:collector,runtimeHash:keccak256(collectorCode),transactionHash:deployment.hash,blockNumber:deployment.blockNumber.toString()};
  actualManifest.automationAccount={address:executionAccount,runtimeHash:keccak256(accountCode),factory:{address:factory,runtimeHash:keccak256(factoryCode)},creation:{owner:governor,threshold:1,signers,salt:fixtureSalt.toString()},implementation:{address:implementation,runtimeHash:keccak256(implementationCode)},
    owner:governor,threshold:1,signers:signers.map((signer,index)=>({index,...signer})),initializationHash:initialization.hash,blockNumber:initialization.blockNumber.toString()};
  const implementationSlot="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
  for(const [name,entry]of Object.entries(actualManifest.dependencies)){
    const code=await client.getCode({address:entry.address});assert(code&&code!=="0x",`Missing actual fork dependency ${name}`);
    entry.runtimeHash=keccak256(code);entry.proxyImplementation=null;entry.proxyCheck="direct";
    const slot=await client.getStorageAt({address:entry.address,slot:implementationSlot});
    if(slot&&BigInt(slot)!==0n){const address=getAddress(`0x${slot.slice(-40)}`),implCode=await client.getCode({address});assert(implCode&&implCode!=="0x");entry.proxyImplementation={address,runtimeHash:keccak256(implCode)};entry.proxyCheck="erc1967";}
  }
  actualManifest.activation={status:"not_run"};actualManifest.canaryAuthorization=null;
  await fork.rpcCall("anvil_mine",[toHex(65)]);
  const confirmedGraph=await verifyBaseCollector(client,collector,{manifest:actualManifest,requireActivation:false});
  proof.actualExecutionGraphVerification="passed";proof.actualExecutionGraph={manifest:actualManifest,verified:confirmedGraph,
    scope:"Actual local Base factory, initialized account and immutable fee adapter; no native scheduling/cross-chain/public authority proof"};
  const stock=STOCKS.find(asset=>asset.ticker==="NVDA")!;const buyAmount=parseUnits("10",stock.decimals);const fundAmount=buyAmount*4n;
  proof.stage="fund_existing_B20_inventory";console.log("Base fork: fund_existing_B20_inventory");
  const candidates:Address[]=[CONTRACTS.poolManager];
  if(await balance(stock.address,CONTRACTS.poolManager)<fundAmount){
    const transfers=[];for(let fromBlock=fork.blockNumber-100n;fromBlock<=fork.blockNumber;fromBlock+=10n){
      const toBlock=fromBlock+9n<fork.blockNumber?fromBlock+9n:fork.blockNumber;
      transfers.push(...await fork.upstream.getLogs({address:stock.address,event:parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)"),fromBlock,toBlock,strict:true}));
    }
    candidates.push(...transfers.flatMap(log=>[log.args.from,log.args.to]).filter((a):a is Address=>!!a&&!sameAddress(a,zeroAddress)));
  }
  let funding:unknown;
  for(const donor of [...new Set(candidates.map(a=>getAddress(a)))]){
    const before=await balance(stock.address,donor);if(before<fundAmount||sameAddress(donor,creator))continue;
    await fork.rpcCall("anvil_setBalance",[donor,toHex(parseEther("10"))]);await fork.rpcCall("anvil_impersonateAccount",[donor]);
    try{const donorWallet=createWalletClient({chain:base,account:donor,transport:http(fork.rpc,{timeout:120_000})});const funded=await send(stock.address,encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[creator,fundAmount]}),donorWallet);
      assert.equal(await balance(stock.address,creator),fundAmount);funding={kind:"existing Base token inventory impersonated only on isolated fork",donor,amount:fundAmount,...funded};break;
    }catch{/* Try another genuine holder; no synthetic B20 balance or contract patch. */}finally{await fork.rpcCall("anvil_stopImpersonatingAccount",[donor]);}
  }
  assert(funding,"No genuine transferable B20 inventory found in bounded discovery");proof.funding=funding;
  proof.stage="actual_B20_issuance_and_trading";console.log("Base fork: actual_B20_issuance_and_trading");
  const sdk=new DopplerSDK<8453>({chainId:8453,publicClient:client});const owner=await sdk.getAirlockOwner();
  const valuation=await readOpeningValuation(client,stock,8453,{integrator:"musegodfun",rpcChainId:8453,apiKey:process.env.LIFI_API_KEY});
  const operations=getAddress("0xc4F87C3715374445C4657aa14c47CBB339b59d1A");
  const input={name:"Base fee Collector fork",symbol:"BFC",description:"Local Base fork only; no production release",image:"",quoteAddress:stock.address};
  const params=buildLaunch(sdk,input,creator,operations,owner,valuation,undefined,8453,collector);
  const prepared=await sdk.factory.prepareCreateMulticurve(params,{account:creator});
  assertEngineFeeCalldata({feePolicy:BASE_AUTOMATION_FEE_POLICY,feeEngine:collector,creator,feeTreasury:operations},prepared.createParams.poolInitializerData);
  const guardDeployment=await sent(await governorWallet.deployContract({abi:guardArtifact.abi as Abi,bytecode:guardArtifact.bytecode as Hex,args:[chainLaunchDependencies(8453).bundler]}));
  assert(guardDeployment.receipt.contractAddress);const guard=getAddress(guardDeployment.receipt.contractAddress);const firstAmount=parseUnits("1",stock.decimals);
  await send(stock.address,encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[guard,firstAmount]}));await nowBlock();
  const firstDeadline=(await client.getBlock()).timestamp+60n;
  const firstPreview=await client.simulateContract({address:guard,abi:launchGuardAbi,functionName:"createAndBuy",args:[prepared.createParams,firstAmount,1n,firstDeadline],account:creator});
  const firstMinimum=firstPreview.result[4]*99n/100n;assert(firstMinimum>0n);
  const launch=await send(guard,encodeFunctionData({abi:launchGuardAbi,functionName:"createAndBuy",args:[prepared.createParams,firstAmount,firstMinimum,firstDeadline]}));
  assert.equal(await allowance(stock.address,guard,chainLaunchDependencies(8453).bundler),0n);assert.equal(await balance(stock.address,guard),0n);
  proof.firstBuy={guard,amount:firstAmount,quotedOutput:firstPreview.result[4],minimumOutput:firstMinimum,deadline:firstDeadline,guardResidualBalance:"0",guardToBundlerAllowance:"0",hash:launch.hash};
  const token=prepared.prediction.tokenAddress,poolId=prepared.prediction.poolId;
  assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:"totalSupply"}),SUPPLY);
  const state=await(await sdk.getMulticurvePool(token)).getState();
  async function trade(key:V4PoolKey,currencyIn:Address,amount:bigint){
    const quote=await sdk.quoter.quoteExactInputV4({poolKey:key,zeroForOne:sameAddress(currencyIn,key.currency0),exactAmount:amount,hookData:"0x"});assert(quote.amountOut>0n);
    if(await allowance(currencyIn,creator,CONTRACTS.permit2)<amount)await send(currencyIn,encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[CONTRACTS.permit2,amount]}));
    await nowBlock();const deadline=(await client.getBlock()).timestamp+300n;
    await send(CONTRACTS.permit2,encodeFunctionData({abi:permit2Abi,functionName:"approve",args:[currencyIn,CONTRACTS.router,amount,Number(deadline)]}));
    const tx=swapTransaction(key,currencyIn,amount,quote.amountOut,100,deadline,CONTRACTS);const before=await balance(tx.currencyOut,creator);const execution=await send(tx.to,tx.data);
    const output=await balance(tx.currencyOut,creator)-before;assert(output>=tx.minOut);return{...execution,amountIn:amount,amountOut:output,minOut:tx.minOut};
  }
  const buy=await trade(state.poolKey,stock.address,buyAmount);const sell=await trade(state.poolKey,token,(await balance(token,creator))/2n);
  proof.launch={...launch,token,poolId,valuation};proof.buy=buy;proof.sell=sell;
  proof.stage="actual_manager_fee_claim";console.log("Base fork: actual_manager_fee_claim");
  const sharesAbi=parseAbi(["function getShares(bytes32,address) view returns(uint256)"]);
  assert.equal(await client.readContract({address:CONTRACTS.initializer,abi:sharesAbi,functionName:"getShares",args:[poolId,collector]}),228n*10n**15n);
  assert.equal(await client.readContract({address:CONTRACTS.rehype,abi:sharesAbi,functionName:"getShares",args:[poolId,collector]}),24n*10n**16n);
  // Paused claims remain safe and permissionless; no module, quote signer or bridge transaction is involved.
  const beforeClaim=await balance(stock.address,collector);
  const claim=await send(collector,encodeFunctionData({abi,functionName:"claimFees",args:[poolId]}));
  const pending=await read<bigint>(collector,"pendingFees",[stock.address]);assert(pending>0n);
  assert.equal(await balance(stock.address,collector)-beforeClaim,pending);assert.equal(await read(collector,"totalClaimed",[stock.address]),pending);
  const memePending=await read<bigint>(collector,"pendingFees",[token]);proof.claim={...claim,pairedPending:pending,memePending};
  await send(stock.address,encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[collector,42n]}));
  assert.equal(await read(collector,"untrackedBalance",[stock.address]),42n);
  await assert.rejects(()=>client.simulateContract({address:collector!,abi,functionName:"releaseFees",args:[stock.address,pending],account:creator}));
  await send(collector,encodeFunctionData({abi,functionName:"resume"}),governorWallet);
  proof.stage="actual_fee_release_to_initialized_native_account";
  const beforeReceiver=await balance(stock.address,executionAccount);
  const released=await send(collector,encodeFunctionData({abi,functionName:"releaseFees",args:[stock.address,pending]}));
  assert.equal(await balance(stock.address,executionAccount)-beforeReceiver,pending);
  assert.equal(await read(collector,"pendingFees",[stock.address]),0n);
  assert.equal(await read(collector,"totalReleased",[stock.address]),pending);
  assert.equal(await read(collector,"untrackedBalance",[stock.address]),42n);
  proof.release={...released,asset:stock.address,amount:pending,receiver:executionAccount,donationExcluded:"42"};
  if(memePending>0n){const before=await balance(token,executionAccount);const memeRelease=await send(collector,encodeFunctionData({abi,functionName:"releaseFees",args:[token,memePending]}));
    assert.equal(await balance(token,executionAccount)-before,memePending);proof.memeRelease={...memeRelease,amount:memePending};}
  else proof.memeRelease={status:"not_run",reason:"No meme-token fee accrued in this bounded actual-fork trade fixture; nonzero meme fee release is covered by contract unit tests only"};
  await send(collector,encodeFunctionData({abi,functionName:"pause"}),governorWallet);
  assert.equal(await read(collector,"paused"),true);
  proof.status="passed";proof.sourceClaimReleaseFlowPassed=true;proof.stage="completed";console.log("Base fork: source claim/release completed; native scheduler and cross-chain execution not run");
}catch(error){proof.status="failed";proof.error=redact(error);console.error(`Base source fork failed at ${proof.stage}`);}
finally{
  try{proof.snapshotRestored=await fork.rpcCall("evm_revert",[snapshot]);}finally{proof.blockedUpstreamWrites=fork.blockedUpstreamWrites();await fork.stop();}
  assert.equal(proof.blockedUpstreamWrites,0);
  // A failed attempt is separate evidence and must never replace the last successful baseline.
  const evidenceFile=proof.status==="passed"?"docs/evidence/base-collector-native-source-fork.json":`docs/evidence/base-collector-native-source-fork-failed-${Date.now()}.json`;
  await mkdir("docs/evidence",{recursive:true});await writeFile(evidenceFile,JSON.stringify(proof,serialize,2)+"\n");
}
console.log(JSON.stringify({status:proof.status,stage:proof.stage,sourceClaimReleaseFlowPassed:proof.sourceClaimReleaseFlowPassed??false,nativeRelayCrossChain:"not_run",mainnetTransactionsSubmitted:false,crossChainFill:"not_run",snapshotRestored:proof.snapshotRestored}));
if(proof.status!=="passed")process.exitCode=1;