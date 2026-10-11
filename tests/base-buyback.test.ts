import test from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, encodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, parseAbiItem, zeroAddress, type Address, type Hex, type AbiEvent } from "viem";
import { BaseFeeQuoteReader, BASE_RECOVERY_FIXED_ASSETS, readTrustedBaseRecoveryAssets, canonicalBaseReceipt, readCanonicalBaseTransactionFee, collectorClaimEvidence, collectorReleaseEvidence, collectorUntrackedSyncEvidence } from "../server/base-buyback";
import { BASE_BUYBACK_PROTOCOL, baseCollectorAbi } from "../src/lib/base-buyback";
import { CONTRACTS, STOCKS, SUPPLY } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { serializePrepared } from "../src/lib/launch-plan";
import { buildLaunch } from "../src/lib/protocol";
import { syntheticOpeningValuation } from "./fixtures";
import { DopplerSDK, airlockAbi, computePoolId, rehypeDopplerHookInitializerAbi } from "@whetstone-research/doppler-sdk/evm";
const address=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const collector=address(1),automation=address(2),token=address(3),manager="0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544" as Address,pool=hash(4);
function log(event:string,args:any,index:number) {const abi=parseAbiItem(event) as AbiEvent;return{address:collector,logIndex:index,data:encodeAbiParameters(abi.inputs.filter(input=>!("indexed"in input&&input.indexed)),abi.inputs.filter(input=>!("indexed"in input&&input.indexed)).map(input=>args[input.name!]) as any),topics:encodeEventTopics({abi:[abi],args})};}
test("native reader observes balances but exposes no source quote/signing execution",async()=>{
 const client={getChainId:async()=>8453,getBlock:async()=>({number:1n,hash:hash(1)}),readContract:async({functionName}:any)=>functionName==="balanceOf"?999n:3n};
 const reader=new BaseFeeQuoteReader({client:client as any,collector,verifyGraph:async()=>({collector,automationReceiver:automation,paused:false,runtimeHash:hash(3),manifestFingerprint:hash(4),initialDeploymentBlock:1n})});
 const status=await reader.status();assert.equal(status.protocol,BASE_BUYBACK_PROTOCOL);assert.equal(status.kind,"base_splits_native");assert.equal(status.available,true);assert.equal(status.nativeAutomationState,"unverified");assert.equal(status.totalBridgedWeth,"0");assert.equal(status.ledgerComplete,false);assert.ok(status.assets.every(asset=>asset.automationBalance==="999"));
 assert.equal("quoteBridge"in reader,false);assert.equal("quoteConversion"in reader,false);assert.equal("validateForSigning"in reader,false);
});
test("native observed totals come only from the reconciled custody journal, never Treasury balance",async()=>{
 const client={getChainId:async()=>8453,getBlock:async()=>({number:1n,hash:hash(1)}),readContract:async()=>999n};
 const reader=new BaseFeeQuoteReader({client:client as any,collector,verifyGraph:async()=>({collector,automationReceiver:automation,paused:true,runtimeHash:hash(3),manifestFingerprint:hash(4),initialDeploymentBlock:1n}),custodyReport:async()=>({ready:true,assets:[],receivedWeth:"7",refundedWeth:"0"})});
 const status=await reader.status();assert.equal(status.totalBridgedWeth,"7");assert.equal(status.paused,true);assert.equal(status.nativeAutomationState,"unverified");
});
test("unclassified recovery counters remain separate from verified fees and canonical receipt totals",async()=>{
 const amounts:Record<string,bigint>={pendingFees:2n,totalClaimed:3n,totalReleased:1n,untrackedBalance:4n,pendingUntracked:5n,totalUntrackedSynced:12n,totalUntrackedReleased:7n,balanceOf:99n};
 const client={getChainId:async()=>8453,getBlock:async()=>({number:1n,hash:hash(1)}),readContract:async({functionName}:any)=>amounts[functionName]};
 const reader=new BaseFeeQuoteReader({client:client as any,collector,verifyGraph:async()=>({collector,automationReceiver:automation,paused:false,runtimeHash:hash(3),manifestFingerprint:hash(4),initialDeploymentBlock:1n}),
  custodyReport:async()=>({ready:true,assets:[],receivedWeth:"8",refundedWeth:"0"})});
 const status=await reader.status();assert.equal(status.available,true);assert.equal(status.totalBridgedWeth,"8");
 for(const asset of status.assets){assert.equal(asset.pending,"2");assert.equal(asset.totalClaimed,"3");assert.equal(asset.totalReleased,"1");assert.equal(asset.untracked,"4");assert.equal(asset.pendingUntracked,"5");assert.equal(asset.totalUntrackedSynced,"12");assert.equal(asset.totalUntrackedReleased,"7");}
});
test("an asset's failing metadata cannot withhold other fee balances or custody readiness",async()=>{
 const failing=address(8),longSymbol=address(9),brokenDecimals=address(10);
 const client={getChainId:async()=>8453,getBlock:async()=>({number:1n,hash:hash(1)}),readContract:async({address:asset,functionName}:any)=>{
  if(functionName==="symbol"){if(asset.toLowerCase()===failing.toLowerCase())throw new Error("metadata reverted");return "L".repeat(100);}
  if(functionName==="decimals")return asset.toLowerCase()===brokenDecimals.toLowerCase()?999:18;
  return 3n;
 }};
 const reader=new BaseFeeQuoteReader({client:client as any,collector,verifyGraph:async()=>({collector,automationReceiver:automation,paused:false,runtimeHash:hash(3),manifestFingerprint:hash(4),initialDeploymentBlock:1n}),
  custodyReport:async()=>({ready:true,assets:[failing,longSymbol,brokenDecimals].map(asset=>({asset,pending:"0",verifiedClaimed:"1"})),receivedWeth:"7",refundedWeth:"0"})});
 const status=await reader.status();assert.equal(status.available,true);assert.equal(status.ledgerComplete,true);assert.equal(status.totalBridgedWeth,"7");
 assert.ok(status.assets.length>1);assert.ok(status.assets.some(asset=>asset.address===longSymbol));assert.equal(status.assetsComplete,false);
 assert.equal(status.assets.some(asset=>asset.address===brokenDecimals),false);
});
test("canonical zero-fee claim race resolves with no income, while release needs actual unique ERC20 delivery",()=>{
 const zero=log("event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",{poolId:pool,manager,token,amount:0n},0);
 assert.deepEqual(collectorClaimEvidence({status:"success",logs:[zero]} as any,collector,pool),[]);
 const release=log("event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",{token,receiver:automation,amount:5n},1);
 const transfer=log("event Transfer(address indexed from,address indexed to,uint256 value)",{from:collector,to:automation,value:5n},0);transfer.address=token;
 assert.deepEqual(collectorReleaseEvidence({status:"success",logs:[transfer,release]} as any,collector,token,"5",automation),{token,amount:"5",automation});
 assert.throws(()=>collectorReleaseEvidence({status:"success",logs:[release]} as any,collector,token,"5",automation),/actual Automation transfer/);
 assert.throws(()=>collectorReleaseEvidence({status:"success",logs:[transfer,transfer,release]} as any,collector,token,"5",automation),/unique/);
});
test("a provider status, unknown receipt, wrong RPC and changed block never establish arrival",async()=>{
 const client={getChainId:async()=>8453,getTransactionReceipt:async()=>({transactionHash:hash(2),blockNumber:1n,blockHash:hash(1)}),getBlockNumber:async()=>2n,getBlock:async()=>({hash:hash(9)})};
 await assert.rejects(()=>canonicalBaseReceipt(client as any,hash(2),8453),/canonical/);client.getChainId=async()=>4663;await assert.rejects(()=>canonicalBaseReceipt(client as any,hash(2),8453),/another network/);
});
test("canonical fee receipts prove a literal zero scalar exactly; missing fork-specific costs are never guessed",async()=>{
 const receipt={transactionHash:hash(2),blockHash:hash(1),blockNumber:1n,gasUsed:21000n,effectiveGasPrice:100n} as any;
 let raw:any={transactionHash:hash(2),blockHash:hash(1),blockNumber:"0x1",gasUsed:"0x5208",effectiveGasPrice:"0x64",l1Fee:"0x3e8",operatorFeeScalar:"0x0",operatorFeeConstant:"0x19"},reads=0;
 const client={getChainId:async()=>8453,request:async()=>raw,getBlock:async()=>({hash:hash(1)}),readContract:async()=>{reads++;throw Error("historical state unavailable")}} as any;
 const cost=await readCanonicalBaseTransactionFee(client,receipt);assert.equal(cost.operatorWei,"25");assert.equal(cost.totalWei,"2101025");assert.equal(reads,0);
 delete raw.operatorFeeScalar;delete raw.operatorFeeConstant;await assert.rejects(()=>readCanonicalBaseTransactionFee(client,receipt),/canonical Base RPC/);assert.equal(reads,1);
 assert.deepEqual(await readCanonicalBaseTransactionFee(client,receipt,cost),cost,"Previously verified immutable fees are reused only with exact current raw receipt identity and amounts");assert.equal(reads,1);
 for(const changed of [{transactionHash:hash(9)},{blockHash:hash(9)},{blockNumber:"2"},{executionWei:"1"},{l1Wei:"1"},{totalWei:"1"},{operatorWei:"-1"}])await assert.rejects(()=>readCanonicalBaseTransactionFee(client,receipt,{...cost,...changed}),/Retained canonical Base fee/);
 const original=raw;for(const fields of [{operatorFeeScalar:"0x0"},{operatorFeeScalar:"0x100000000",operatorFeeConstant:"0x0"},{operatorFeeScalar:"0x0",operatorFeeConstant:"0x10000000000000000"},{l1Fee:null}]){
  raw={...original,...fields};await assert.rejects(()=>readCanonicalBaseTransactionFee(client,receipt,cost),/protocol bounds|lacks execution/);
 }
 raw={...original,operatorFeeScalar:"0x1",operatorFeeConstant:"0x0"};await assert.rejects(()=>readCanonicalBaseTransactionFee(client,receipt),/canonical Base RPC/,"Nonzero scalar needs the exact historical GPO formula, not a guessed fork");
 raw={...original,operatorFeeScalar:"0x0",operatorFeeConstant:"0x0"};await assert.rejects(()=>readCanonicalBaseTransactionFee(client,receipt,cost),/Retained canonical Base fee/);
 raw=original;client.request=async()=>{throw Error("429")};await assert.rejects(()=>readCanonicalBaseTransactionFee(client,receipt,cost),/canonical Base RPC/);
});
test("unknown synchronization and releases require their own events, never genuine fee credits",()=>{
 const sync=log("event UntrackedSynced(address indexed token,uint256 amount)",{token,amount:9n},0);
 assert.deepEqual(collectorUntrackedSyncEvidence({status:"success",logs:[sync]} as any,collector,token),{token,amount:"9"});
 assert.throws(()=>collectorUntrackedSyncEvidence({status:"success",logs:[sync,sync]} as any,collector,token),/unique/);
 assert.throws(()=>collectorUntrackedSyncEvidence({status:"reverted",logs:[sync]} as any,collector,token),/failed/);
 const unknown=log("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token,receiver:automation,amount:5n},1);
 const transfer=log("event Transfer(address indexed from,address indexed to,uint256 value)",{from:collector,to:automation,value:5n},0);transfer.address=token;
 assert.deepEqual(collectorReleaseEvidence({status:"success",logs:[transfer,unknown]} as any,collector,token,"5",automation,true),{token,amount:"5",automation});
 assert.throws(()=>collectorReleaseEvidence({status:"success",logs:[transfer,unknown]} as any,collector,token,"5",automation),/unique/);
 assert.throws(()=>collectorReleaseEvidence({status:"success",logs:[transfer,unknown]} as any,collector,token,"5",address(88),true),/unique/);
 assert.throws(()=>collectorClaimEvidence({status:"success",logs:[sync,unknown]} as any,collector,pool),/no verified manager credit/);
});
test("zero-credit registered pool assets remain discoverable without being credited as income",async()=>{
 const client={getChainId:async()=>8453,getBlock:async()=>({number:1n,hash:hash(1)}),readContract:async({functionName}:any)=>functionName==="symbol"?"MEME":functionName==="decimals"?18:functionName==="verifiedAssets"?true:0n};
 const reader=new BaseFeeQuoteReader({client:client as any,collector,verifyGraph:async()=>({collector,automationReceiver:automation,paused:false,runtimeHash:hash(3),manifestFingerprint:hash(4),initialDeploymentBlock:1n}),
  batches:async()=>[{protocol:BASE_BUYBACK_PROTOCOL,collector,kind:"claim",status:"claimed",claimAssets:[token],claimCredits:[]} as any]});
 const row=(await reader.status()).assets.find(row=>row.address.toLowerCase()===token.toLowerCase());
 assert.equal(row?.verifiedAsset,true);assert.equal(row?.pending,"0");assert.equal(row?.totalClaimed,"0");
});
test("automatic asset eligibility is exact launch addresses plus a fully verified project issuance, never Collector verifiedAssets",async()=>{
 const creator=address(8),quote=STOCKS[0],sdk=new DopplerSDK<8453|4663>({publicClient:createPublicClient({transport:http("http://127.0.0.1:1")}),chainId:8453});
 const valuation=syntheticOpeningValuation(quote.address),draft={name:"Own Issuance",symbol:"OWN",description:"",image:"",quoteAddress:quote.address,tradingFeeBps:100};
 const params=sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk,draft,creator,creator,creator,valuation,undefined,8453,collector,true,BASE_AUTOMATION_FEE_POLICY));
 const poolKey={currency0:token,currency1:quote.address,fee:8388608,tickSpacing:10,hooks:CONTRACTS.initializer},poolId=computePoolId(poolKey),data=encodeFunctionData({abi:airlockAbi,functionName:"create",args:[params]});
 const prepared={chainId:8453 as const,account:creator,airlock:CONTRACTS.airlock,createParams:params,prediction:{tokenAddress:token,poolOrHookAddress:CONTRACTS.initializer,governanceAddress:creator,timelockAddress:creator,poolKey,poolId,tokenIsCurrency0:true},transaction:{to:CONTRACTS.airlock,data,value:0n},gasEstimate:{status:"unavailable" as const}};
 const plan={id:keccak256(data),creator,data,tokenAddress:token,poolId,draft,preparedAt:Date.now(),gas:null,feePolicy:BASE_AUTOMATION_FEE_POLICY,feeTreasury:creator,feeEngine:collector,openingValuation:valuation,curvePolicy:CURVE_POLICY,prepared:serializePrepared(prepared),transaction:{to:CONTRACTS.airlock,data,value:"0"}};
 const record={...draft,address:token,creator,poolId,transactionHash:hash(22),blockNumber:"1",createdAt:1,openingCap:"",mode:"base",deploymentChainId:8453,feeEngine:collector,feePolicy:BASE_AUTOMATION_FEE_POLICY,openingValuationUnverified:true};
 const receipt={status:"success",from:creator,to:CONTRACTS.airlock,transactionHash:hash(22),blockHash:hash(1),blockNumber:1n,logs:[
  {address:CONTRACTS.airlock,topics:encodeEventTopics({abi:airlockAbi,eventName:"Create",args:{numeraire:quote.address}}),data:encodeAbiParameters([{type:"address"},{type:"address"},{type:"address"}],[token,CONTRACTS.initializer,CONTRACTS.initializer])},
  {address:token,topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from:zeroAddress,to:CONTRACTS.airlock}}),data:encodeAbiParameters([{type:"uint256"}],[SUPPLY])},
  {address:CONTRACTS.rehype,topics:encodeEventTopics({abi:rehypeDopplerHookInitializerAbi,eventName:"FeeScheduleSet",args:{poolId}}),data:encodeAbiParameters([{type:"uint32"},{type:"uint24"},{type:"uint24"},{type:"uint32"}],[1,10000,10000,0])},
 ]};
 let actualDecimals=18,stateReads=0,balance=1n,creationReads=0;
 const client={getChainId:async()=>8453,getBlockNumber:async()=>2n,getBlock:async({blockNumber}:any)=>({number:blockNumber??2n,hash:hash(1)}),getTransactionReceipt:async()=>{creationReads++;return receipt},getTransaction:async()=>({from:creator,to:CONTRACTS.airlock,input:data,value:0n}),readContract:async({functionName}:any)=>functionName==="balanceOf"?balance:actualDecimals};
 const zeroFees={lp:{fees0:0n,fees1:0n},trade:{fees0:0n,fees1:0n}};
 const service={client,store:{tokens:async()=>[record],findPlan:async()=>plan},sdk,contracts:CONTRACTS,state:async()=>{stateReads++;return{}},fees:async()=>zeroFees} as any;
 const assets=await readTrustedBaseRecoveryAssets(service,collector);assert.equal(BASE_RECOVERY_FIXED_ASSETS.length,37);assert.equal(assets.length,38);assert.equal(assets.find(asset=>asset.address===token)?.minimumRaw,"1000000000000000000");assert.equal(stateReads,1,"The real issuance/pool branch must be exercised");
 balance=0n;const reads=creationReads;assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,37);assert.equal(creationReads,reads,"Dormant records do not replay creation evidence");
 assert.equal((await readTrustedBaseRecoveryAssets(service,collector,token)).length,38,"A selected signing asset must get full proof even with zero current balance");assert.equal(creationReads,reads+1);
 service.fees=async()=>({...zeroFees,lp:{fees0:1n,fees1:0n}});assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,38,"Actual pending manager fees also select an asset");balance=1n;
 actualDecimals=8;assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,37);actualDecimals=18;
 record.feeEngine=automation;assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,37);record.feeEngine=collector;
 receipt.logs[0].address=automation;assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,37);receipt.logs[0].address=CONTRACTS.airlock;
 service.store.findPlan=async()=>null;assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,37);
 service.store.findPlan=async()=>plan;const saved=new Map<string,any>();let cacheWrites=0;
 service.store.getBuybackBatch=async(id:string)=>structuredClone(saved.get(id)??null);service.store.compareAndSetBuybackAudit=async(row:any,expected:any)=>{assert.deepEqual(saved.get(row.id)??null,expected);cacheWrites++;saved.set(row.id,structuredClone(row));return true};
 client.readContract=async({functionName,blockNumber}:any)=>{if(functionName==="decimals"&&blockNumber===1n)throw Error("historical state unavailable");return functionName==="balanceOf"?balance:actualDecimals};
 assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,38,"Current precision plus canonical creation identity works without archive state");assert.equal(cacheWrites,1);
 const receipts=creationReads,fetchReceipt=client.getTransactionReceipt;client.getTransactionReceipt=async()=>{creationReads++;throw Error("Creation receipts must not be replayed after finalized private proof caching")};service.store.findPlan=async()=>{throw Error("Cached frozen plan must not be decoded repeatedly")};
 const restarted={...service,client:{...client}};assert.equal((await readTrustedBaseRecoveryAssets(restarted,collector)).length,38);assert.equal((await readTrustedBaseRecoveryAssets(restarted,collector,token)).length,38);assert.equal(creationReads,receipts,"Persistent cache survives a new client and still authenticates selected assets");
 actualDecimals=8;assert.equal((await readTrustedBaseRecoveryAssets(restarted,collector,token)).length,37,"Cache never bypasses fresh selected precision");actualDecimals=18;
 restarted.client.getBlock=async({blockNumber}:any)=>({number:blockNumber??2n,hash:blockNumber===1n?hash(9):hash(1)});assert.equal((await readTrustedBaseRecoveryAssets(restarted,collector,token)).length,37,"A changed creation header invalidates the durable proof");
 saved.clear();client.getTransactionReceipt=fetchReceipt;service.store.findPlan=async()=>plan;service.store.compareAndSetBuybackAudit=async()=>false;
 assert.equal((await readTrustedBaseRecoveryAssets(service,collector,token)).length,37,"Failed proof-cache CAS cannot authorize a selected asset");
});
test("thousands of dormant private issuance records do not replay creation receipts, transactions or frozen plans",async()=>{
 const records=Array.from({length:1200},(_,index)=>({address:address(1000+index),creator:address(8),mode:"base",deploymentChainId:8453,feePolicy:BASE_AUTOMATION_FEE_POLICY,feeEngine:collector,transactionHash:hash(1000+index),blockNumber:"1"}));
 let balances=0,fees=0,creation=0,plans=0;
 const client={getChainId:async()=>8453,readContract:async({functionName,args}:any)=>{assert.equal(functionName,"balanceOf");assert.equal(args[0],collector);balances++;return 0n},getTransactionReceipt:async()=>{creation++;throw Error("Dormant creation RPC should not run")},getTransaction:async()=>{creation++;throw Error("Dormant transaction RPC should not run")}};
 const service={client,store:{tokens:async()=>records,findPlan:async()=>{plans++;throw Error("Dormant plan should not be decoded")}},fees:async()=>{fees++;return{lp:{fees0:0n,fees1:0n},trade:{fees0:0n,fees1:0n}}}} as any;
 assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,37);assert.equal(balances,1200);assert.equal(fees,1200);assert.equal(creation,0);assert.equal(plans,0);
 assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,37);assert.equal(creation,0,"Restart-style scans still do not replay dormant creation evidence");
});
