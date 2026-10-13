import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, parseAbiItem, type Address, type Hex, type AbiEvent } from "viem";
import { BaseFeeQuoteReader, BASE_RECOVERY_FIXED_ASSETS, readTrustedBaseRecoveryAssets, canonicalBaseReceipt, readCanonicalBaseTransactionFee, collectorClaimEvidence, collectorReleaseEvidence, collectorUntrackedSyncEvidence } from "../server/base-buyback";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_WETH, baseCollectorAbi } from "../src/lib/base-buyback";
import { ADMITTED_BASE_ASSET_COUNT, STOCKS } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
const address=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const collector=address(1),automation=address(2),token=address(3),manager="0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544" as Address,pool=hash(4);
function log(event:string,args:any,index:number) {const abi=parseAbiItem(event) as AbiEvent;return{address:collector,logIndex:index,data:encodeAbiParameters(abi.inputs.filter(input=>!("indexed"in input&&input.indexed)),abi.inputs.filter(input=>!("indexed"in input&&input.indexed)).map(input=>args[input.name!]) as any),topics:encodeEventTopics({abi:[abi],args})};}
const fixedGraph = {collector,automationReceiver:automation,paused:false,runtimeHash:hash(3),manifestFingerprint:hash(4),initialDeploymentBlock:1n};
function counterClient(values: Record<string,bigint|boolean> = {},fail?: Address) {
 let headers=0,calls=0;
 return {getBlockNumber:async()=>{headers++;return 1n;},multicall:async({contracts,blockNumber,batchSize}:any)=>{
  calls++;assert.equal(blockNumber,1n);assert(batchSize>=65536);
  return contracts.map((contract:any)=>fail&&contract.args?.[0]===fail?{status:"failure",error:Error("asset unavailable")}:
   {status:"success",result:values[contract.functionName]??(contract.functionName==="paused"?false:contract.functionName==="verifiedAssets"?true:3n)});
 },getChainId:async()=>{throw Error("Display must not reread chain identity")},readContract:async()=>{throw Error("Display must use multicall")},
 getLogs:async()=>{throw Error("Display must not scan history")},getBlock:async()=>{throw Error("Display must not check historical anchors")},
 metrics:()=>({headers,calls})};
}
test("Base counters use a single same-block multicall without source history or attribution",async()=>{
 const client=counterClient({totalClaimed:9n,totalReleased:3n,totalUntrackedReleased:2n,balanceOf:999n});
 const reader=new BaseFeeQuoteReader({client:client as any,collector,verifiedGraph:fixedGraph});
 const status=await reader.status();assert.equal(status.available,true);assert.equal(status.protocol,BASE_BUYBACK_PROTOCOL);assert.equal(status.kind,"base_splits_native");
 assert.equal(status.assets.length,ADMITTED_BASE_ASSET_COUNT+1);for(const row of status.assets){assert.equal(row.totalClaimed,"9");assert.equal(row.totalReleased,"3");assert.equal(row.pending,"6");assert.equal(row.totalUntrackedReleased,"2");assert.equal(row.automationBalance,"999");}
 assert.equal("totalBridgedWeth" in status,false);assert.equal("ledgerComplete" in status,false);assert.equal("batches" in status,false);
 assert.deepEqual(client.metrics(),{headers:1,calls:1});assert.equal("quoteConversion" in reader,false);assert.equal("validateForSigning" in reader,false);
});
test("Base summary cache deduplicates concurrent reads and cannot be forced below five minutes",async()=>{
 let now=1000;const client=counterClient(),reader=new BaseFeeQuoteReader({client:client as any,collector,verifiedGraph:fixedGraph,now:()=>now});
 const values=await Promise.all(Array.from({length:12},()=>reader.status()));assert.equal(values.every(value=>value.checkedAt===1000),true);
 assert.deepEqual(client.metrics(),{headers:1,calls:1});values[0].assets.length=0;assert.equal((await reader.status()).assets.length,ADMITTED_BASE_ASSET_COUNT+1);
 now+=299999;await reader.status();assert.deepEqual(client.metrics(),{headers:1,calls:1});now++;await reader.status();assert.deepEqual(client.metrics(),{headers:2,calls:2});
});
test("task reads retain independent pending and unknown buckets; paused Collector is observed",async()=>{
 const amounts={paused:true,pendingFees:2n,totalClaimed:8n,totalReleased:1n,untrackedBalance:4n,pendingUntracked:5n,totalUntrackedSynced:12n,totalUntrackedReleased:7n,balanceOf:99n};
 const reader=new BaseFeeQuoteReader({client:counterClient(amounts) as any,collector,verifiedGraph:fixedGraph,includeTaskState:true});
 const status=await reader.status();assert.equal(status.paused,true);assert.equal(status.nativeAutomationState,"paused");
 for(const row of status.assets){assert.equal(row.pending,"2");assert.equal(row.untracked,"4");assert.equal(row.pendingUntracked,"5");assert.equal(row.totalUntrackedSynced,"12");assert.equal(row.totalUntrackedReleased,"7");assert.equal(row.verifiedAsset,true);}
});
test("one failed or inconsistent asset never fabricates zero totals or removes healthy counters",async()=>{
 const failing=STOCKS[0].address,client=counterClient({totalClaimed:5n,totalReleased:3n},failing);
 const status=await new BaseFeeQuoteReader({client:client as any,collector,verifiedGraph:fixedGraph}).status();assert.equal(status.available,true);assert.equal(status.assetsComplete,false);assert.equal(status.assets.length,ADMITTED_BASE_ASSET_COUNT);assert(!status.assets.some(row=>row.address===failing));
 const broken=await new BaseFeeQuoteReader({client:counterClient({totalClaimed:2n,totalReleased:3n}) as any,collector,verifiedGraph:fixedGraph}).status();assert.equal(broken.assetsComplete,false);assert.equal(broken.assets.length,0);
});
test("counter failure retains a labeled previous sample without extending its observation time",async()=>{
 let now=1000;const client=counterClient(),reader=new BaseFeeQuoteReader({client:client as any,collector,verifiedGraph:fixedGraph,now:()=>now});
 await reader.status();now+=300000;client.multicall=async()=>{throw Error("429 secret provider")};const delayed=await reader.status();
 assert.equal(delayed.available,true);assert.equal(delayed.stale,true);assert.equal(delayed.checkedAt,1000);assert.match(delayed.error!,/previous sample/);assert(!JSON.stringify(delayed).includes("secret provider"));
 const unavailable=await new BaseFeeQuoteReader({client:client as any,collector,verifiedGraph:fixedGraph,now:()=>now}).status();assert.equal(unavailable.available,false);assert.equal(unavailable.assets.length,0);
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
test("the private official registry can add an issued token without scanning receipts or metadata",async()=>{
 const client=counterClient({totalClaimed:0n,totalReleased:0n,totalUntrackedReleased:0n,balanceOf:0n}),reader=new BaseFeeQuoteReader({client:client as any,collector,verifiedGraph:fixedGraph,
  assets:async()=>[{chainId:8453,address:token,symbol:"MEME",decimals:18}],includeTaskState:true});
 const row=(await reader.status()).assets.find(row=>row.address===token);assert.equal(row?.totalClaimed,"0");assert.equal(row?.verifiedAsset,true);
});
test("automatic assets use exact fixed addresses and complete private registrations without historical RPC",async()=>{
 const quote=STOCKS[0],record={address:token,symbol:"OWN",creator:address(8),poolId:pool,quoteAddress:quote.address,mode:"base",deploymentChainId:8453,
  feePolicy:BASE_AUTOMATION_FEE_POLICY,feeEngine:collector,transactionHash:hash(22),blockNumber:"1"};
 const service={store:{tokens:async()=>[record]},client:new Proxy({}, {get(){throw Error("Registry reuse cannot perform RPC")}})} as any;
 const rows=await readTrustedBaseRecoveryAssets(service,collector);assert.equal(rows.length,ADMITTED_BASE_ASSET_COUNT+2);assert.equal(rows.find(row=>row.address===token)?.decimals,18);
 for(const change of [{creator:null},{poolId:"0x"},{quoteAddress:automation},{transactionHash:null},{blockNumber:null},{blockNumber:"0"},{feeEngine:automation},{feePolicy:"other"},{mode:"robinhood"},{deploymentChainId:4663}]) {
  service.store.tokens=async()=>[{...record,...change}];assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,ADMITTED_BASE_ASSET_COUNT+1,JSON.stringify(change));
 }
 service.store.tokens=async()=>[{...record,symbol:"L".repeat(100)}];assert.equal((await readTrustedBaseRecoveryAssets(service,collector))[ADMITTED_BASE_ASSET_COUNT+1].symbol.length,64);
 assert.equal((await readTrustedBaseRecoveryAssets(service,collector,automation)).length,ADMITTED_BASE_ASSET_COUNT+1);
});
test("thousands of dormant registered issuances require no per-token balance or creation calls",async()=>{
 const records=Array.from({length:1200},(_,index)=>({address:address(1000+index),symbol:"OWN",creator:address(8),poolId:pool,quoteAddress:STOCKS[0].address,mode:"base",deploymentChainId:8453,
  feePolicy:BASE_AUTOMATION_FEE_POLICY,feeEngine:collector,transactionHash:hash(1000+index),blockNumber:"1"}));
 const service={store:{tokens:async()=>records},client:new Proxy({}, {get(){throw Error("Dormant identity must not use RPC")}})} as any;
 assert.equal((await readTrustedBaseRecoveryAssets(service,collector)).length,1200+ADMITTED_BASE_ASSET_COUNT+1);
});
test("round13 Base quote policies read every admitted B20 plus WETH and never query PM, even from a removed-pair registry row",async()=>{
 const pm="0xB2000000000000000000008FC2A8C23cf5937b66" as Address,removedMeme=address(999),seen:string[]=[];
 const record={address:removedMeme,symbol:"PMMEME",creator:address(8),poolId:pool,quoteAddress:pm,mode:"base",deploymentChainId:8453,
  feePolicy:BASE_AUTOMATION_FEE_POLICY,feeEngine:collector,transactionHash:hash(22),blockNumber:"1"};
 const service={store:{tokens:async()=>[record]}} as any;
 const policies=await readTrustedBaseRecoveryAssets(service,collector);
 assert.equal(policies.length,ADMITTED_BASE_ASSET_COUNT+1);
 assert.deepEqual(new Set(policies.map(row=>row.address.toLowerCase())),new Set([...STOCKS.map(row=>row.address),BASE_BUYBACK_WETH].map(value=>value.toLowerCase())));
 assert(!policies.some(row=>[pm,removedMeme].some(value=>row.address.toLowerCase()===value.toLowerCase())));
 const client=counterClient(),multicall=client.multicall;
 client.multicall=async(input:any)=>{for(const row of input.contracts)seen.push(row.address.toLowerCase(),...((row.args??[]) as string[]).map(value=>value.toLowerCase()));return multicall(input);};
 const reader=new BaseFeeQuoteReader({client:client as any,collector,verifiedGraph:fixedGraph,assets:()=>readTrustedBaseRecoveryAssets(service,collector),includeTaskState:true});
 const status=await reader.status();assert.equal(status.assets.length,ADMITTED_BASE_ASSET_COUNT+1);assert(!seen.includes(pm.toLowerCase()));
});
