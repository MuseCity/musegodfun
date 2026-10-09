import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type AbiEvent } from "viem";
import { BaseFeeQuoteReader, canonicalBaseReceipt, collectorClaimEvidence, collectorReleaseEvidence } from "../server/base-buyback";
import { BASE_BUYBACK_PROTOCOL, baseCollectorAbi } from "../src/lib/base-buyback";
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
