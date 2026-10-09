import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, type AbiEvent, type Address, type Hex } from "viem";
import { verifyBaseNativeActivation, canonicalProofJson, nativeRelayFragments } from "../server/base-native-provenance";
import { BASE_BUYBACK_FORWARDER, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_NATIVE_BUYBACK_PROTOCOL, type BaseNativeRelayEvidence } from "../src/lib/base-buyback";
import { vaultEventId, type VaultLedgerEvent, type VaultLedgerState } from "../src/lib/buyback-vault-ledger";
import { type CustodyEvent, type CustodyState } from "../src/lib/buyback-custody-ledger";
import { RELAY_ROUTER } from "../server/buyback";
const address=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const collector=address(1),automation=address(2),asset=address(3),swapper="0xE8834943A4eD3758f3b5930E3EEfb43568B222b3" as Address;
const executor="0x787b6a964C3e86A005B8Fda87991e088178A8455" as Address,muse="0x0379E228F6887c6F18bf394042ECAF81B308cb2e" as Address,dead="0x000000000000000000000000000000000000dEaD" as Address;
const block=(number:number)=>({number:String(number),hash:hash(100+number),parentHash:hash(99+number)});
function chainLog(event:string,args:any,contract:Address,tx:number,index:number,number:number) {
 const abi=parseAbiItem(event) as AbiEvent,nonIndexed=abi.inputs.filter(input=>!input.indexed);
 return {address:contract,transactionHash:hash(tx),transactionIndex:tx,logIndex:index,blockNumber:BigInt(number),blockHash:block(number).hash,removed:false,
  data:encodeAbiParameters(nonIndexed,nonIndexed.map(input=>args[input.name!]) as any),topics:encodeEventTopics({abi:[abi],args}),args,eventName:abi.name};
}
const transfer=(from:Address,to:Address,value:bigint,token:Address,tx:number,index:number,number:number)=>chainLog("event Transfer(address indexed from,address indexed to,uint256 value)",{from,to,value},token,tx,index,number);
function custodyEvent(log:ReturnType<typeof transfer>,account:Address):CustodyEvent {return{id:vaultEventId(log.transactionHash,log.logIndex),blockNumber:String(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,transactionIndex:log.transactionIndex,logIndex:log.logIndex,asset:log.address,kind:log.args.to===account?"in":"out",from:log.args.from,to:log.args.to,amount:String(log.args.value)};}
function fixture() {
 const sourceLogs=[transfer(collector,automation,50n,asset,1,0,1),chainLog("event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:50n},collector,1,1,1),transfer(automation,address(4),50n,asset,2,0,2)];
 const destinationLogs=[transfer(RELAY_ROUTER,BASE_BUYBACK_TREASURY,5n,BASE_BUYBACK_RH_WETH,3,0,2),transfer(BASE_BUYBACK_TREASURY,BASE_BUYBACK_VAULT,8n,BASE_BUYBACK_RH_WETH,4,0,3),chainLog("event Forwarded(address indexed caller,uint256 amount)",{caller:address(6),amount:8n},BASE_BUYBACK_FORWARDER,4,1,3),transfer(BASE_BUYBACK_VAULT,swapper,8n,BASE_BUYBACK_RH_WETH,5,0,4),chainLog("event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)",{caller:address(6),wethAmount:8n,museToDead:16n,profit:2n},BASE_BUYBACK_VAULT,5,1,4),transfer(executor,dead,16n,muse,5,2,4)];
 const relay:BaseNativeRelayEvidence={version:1,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,orderParametersVerified:true,requestId:hash(90),orderId:hash(91),metadata:"0x1234",sourceTransactionHash:hash(2),sourceBlockNumber:"2",sourceBlockHash:block(2).hash,sourceTransferLogIndex:0,sourceDepositLogIndex:1,sourceAsset:asset,sourceAmount:"50",sourceNativeDeposit:"6",automation,treasury:BASE_BUYBACK_TREASURY,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"5",destinationTransactionHash:hash(3),destinationBlockNumber:"2",destinationBlockHash:block(2).hash,destinationTransferLogIndex:0,destinationMovementLogIndex:1,sourceCalldataHash:hash(92)};
 const sourceEvents=sourceLogs.filter(log=>log.eventName==="Transfer").map(log=>custodyEvent(log,automation));sourceEvents[0].fragments=[{batchId:sourceEvents[0].id,amount:"50"}];sourceEvents[0].evidence={kind:"adapter_release",collector,releaseLogIndex:1,transactionHash:hash(1),blockHash:block(1).hash};
 const treasuryEvents=destinationLogs.filter(log=>log.eventName==="Transfer"&&log.address===BASE_BUYBACK_RH_WETH&&(log.args.from===BASE_BUYBACK_TREASURY||log.args.to===BASE_BUYBACK_TREASURY)).map(log=>custodyEvent(log,BASE_BUYBACK_TREASURY));treasuryEvents[0].fragments=nativeRelayFragments([{batchId:sourceEvents[0].id,amount:"50"}],relay);treasuryEvents[0].evidence={kind:"native_relay",relay,sourceRevision:1,sourceEventId:sourceEvents[1].id};
 const vaultEvents:VaultLedgerEvent[]=destinationLogs.filter(log=>log.address===BASE_BUYBACK_RH_WETH&&(log.args.from===BASE_BUYBACK_VAULT||log.args.to===BASE_BUYBACK_VAULT)||log.eventName==="Executed").map(log=>{
 const position={id:vaultEventId(log.transactionHash,log.logIndex),blockNumber:String(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,transactionIndex:log.transactionIndex,logIndex:log.logIndex};
 return log.eventName==="Executed"?{...position,kind:"executed",caller:log.args.caller,wethAmount:String(log.args.wethAmount),museToDead:String(log.args.museToDead),profit:String(log.args.profit)}:
 log.args.to===BASE_BUYBACK_VAULT?{...position,kind:"weth_in",from:log.args.from,to:log.args.to,amount:String(log.args.value),source:"base",baseFill:{protocol:BASE_NATIVE_BUYBACK_PROTOCOL,treasury:BASE_BUYBACK_TREASURY,treasuryEventId:position.id,treasuryRevision:1,fragments:[{batchId:null,amount:"3"},{batchId:relay.requestId,amount:"5"}],fillTransactionHash:log.transactionHash,fillBlockHash:log.blockHash,fillLogIndex:log.logIndex,recipient:BASE_BUYBACK_VAULT,outputToken:BASE_BUYBACK_RH_WETH,outputAmount:"8"}}:
 {...position,kind:"weth_out",from:log.args.from,to:log.args.to,amount:String(log.args.value)};
 });
 const state=(id:"base_automation"|"robinhood_treasury"):CustodyState=>({version:1,id,chainId:id==="base_automation"?8453:4663,account:id==="base_automation"?automation:BASE_BUYBACK_TREASURY,revision:1,checkpoint:block(0),cursor:block(4),openingBalances:{[id==="base_automation"?asset:BASE_BUYBACK_RH_WETH.toLowerCase()]:id==="base_automation"?"0":"3"},observedBalances:{[id==="base_automation"?asset:BASE_BUYBACK_RH_WETH.toLowerCase()]:"0"},updatedAt:1,blockedReason:null});
 const vault:VaultLedgerState={version:1,chainId:4663,vault:BASE_BUYBACK_VAULT,weth:BASE_BUYBACK_RH_WETH,swapper,revision:1,checkpoint:{...block(0),wethBalance:"0",totalSpent:"0",totalBurned:"0",establishedAt:1},cursor:block(4),observedBalance:"0",observedTotalSpent:"8",observedTotalBurned:"16",updatedAt:1,blockedReason:null};
 function client(chain:8453|4663,logs:typeof sourceLogs) {
  return {getChainId:async()=>chain,getBlockNumber:async()=>68n,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),number:blockNumber,timestamp:1000n+blockNumber}),getCode:async()=>"0x1234",readContract:async({address,functionName,args,blockNumber}:any)=>{
   if(functionName==="getOperatorFee")return 0n;if(functionName==="totalSpent")return blockNumber===0n?0n:8n;if(functionName==="totalBurned")return blockNumber===0n?0n:16n;
   if(functionName==="balanceOf")return chain===4663&&args[0]===BASE_BUYBACK_TREASURY&&blockNumber===0n?3n:0n;throw new Error(`Unsupported fixture read ${address} ${functionName}`);},
   getLogs:async({address,event,args,fromBlock,toBlock}:any)=>logs.filter(log=>(!address||log.address.toLowerCase()===address.toLowerCase())&&log.eventName===event.name&&log.blockNumber>=fromBlock&&log.blockNumber<=toBlock&&(!args?.from||log.args.from===args.from)&&(!args?.to||log.args.to===args.to)),
   getTransactionReceipt:async({hash:tx}:any)=>{const events=logs.filter(log=>log.transactionHash===tx);if(!events.length)throw new Error("Receipt missing");return{status:"success",transactionHash:tx,blockNumber:events[0].blockNumber,blockHash:events[0].blockHash,gasUsed:1n,effectiveGasPrice:1n,logs:events};},
   request:async({params}:any)=>{const events=logs.filter(log=>log.transactionHash===params[0]);return{transactionHash:params[0],blockHash:events[0].blockHash,blockNumber:`0x${events[0].blockNumber.toString(16)}`,gasUsed:"0x1",effectiveGasPrice:"0x1",l1Fee:"0x1"};}};
 }
 const manifest:any={collector:{address:collector,runtimeHash:keccak256("0x1234"),blockNumber:"1"},constants:{automationReceiver:automation},canaryAuthorization:{expiresAt:"2000",releaseBudgets:[{token:asset,maxAmount:"50"}],maxBaseGasWei:"100",maxRobinhoodGasWei:"100"},activation:{nativeExecution:{version:1,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,proof:{version:1,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,sourceHash:hash(2),destinationHash:hash(3),raw:{}},automation:{state:state("base_automation"),events:sourceEvents},treasury:{state:state("robinhood_treasury"),events:treasuryEvents},vault:{state:vault,events:vaultEvents}}}};
 return {source:client(8453,sourceLogs),destination:client(4663,destinationLogs),manifest,relay,deps:{relay:async()=>relay},sourceLogs,destinationLogs};
}
test("full canonical native acceptance consumes this batch's actual fees through mixed Treasury FIFO and actual dead transfer",async()=>{
 const f=fixture(),result=await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any);assert.equal(result.receivedWeth,"5");assert.equal(result.museToDead,"10");assert.equal(result.sourceSpentAmount,"50");assert.equal(result.baseGasWei,"4");
});
test("canonical activation refuses invented observed balances and omitted net-zero movements",async()=>{
 const f=fixture();f.manifest.activation.nativeExecution.automation.state.observedBalances[asset]="999";
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/balance is fabricated/);
 const g=fixture();g.manifest.activation.nativeExecution.automation.events=[];g.manifest.activation.nativeExecution.automation.state.observedBalances[asset]="0";
 await assert.rejects(()=>verifyBaseNativeActivation(g.source as any,g.destination as any,g.manifest,68n,g.deps as any),/omitted/);
});
test("Base fragments cannot be invented at source, Treasury, Vault, or counted from another batch",async()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>{f.manifest.activation.nativeExecution.automation.events[0].fragments[0].batchId="invented";},(f:ReturnType<typeof fixture>)=>{f.manifest.activation.nativeExecution.treasury.events[0].fragments[0].amount="6";},(f:ReturnType<typeof fixture>)=>{f.manifest.activation.nativeExecution.vault.events[0].baseFill.fragments=[{batchId:f.relay.requestId,amount:"8"}];},(f:ReturnType<typeof fixture>)=>{f.manifest.activation.nativeExecution.vault.events[0].baseFill.fragments[1].batchId=hash(99);}]){
 const f=fixture();change(f);await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/fragments|provenance|Source fee/);}
});
test("actual Executed fields, matching dead sender/amount, cumulative principal and separate gas budgets are necessary",async()=>{
 const f=fixture();f.manifest.activation.nativeExecution.vault.events[2].museToDead="99";await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/Executed.*fabricated/);
 const g=fixture();g.destinationLogs[g.destinationLogs.length-1].args.from=address(88);const forged=transfer(address(88),dead,16n,muse,5,2,4);Object.assign(g.destinationLogs[g.destinationLogs.length-1],forged);await assert.rejects(()=>verifyBaseNativeActivation(g.source as any,g.destination as any,g.manifest,68n,g.deps as any),/dead transfer/);
 const h=fixture();h.manifest.canaryAuthorization.releaseBudgets[0].maxAmount="49";await assert.rejects(()=>verifyBaseNativeActivation(h.source as any,h.destination as any,h.manifest,68n,h.deps as any),/release budget/);
 const i=fixture();i.manifest.canaryAuthorization.maxBaseGasWei="3";await assert.rejects(()=>verifyBaseNativeActivation(i.source as any,i.destination as any,i.manifest,68n,i.deps as any),/gas budget/);
});
test("proof comparison uses normalized immutable values without losing raw precision",()=>{
 assert.equal(canonicalProofJson({amount:"100000000000000000000001",hash:"0xAB"}),canonicalProofJson({hash:"0xab",amount:"100000000000000000000001"}));
});
test("a separate zero-credit Collector claim still counts against the complete Base gas budget",async()=>{
 const f=fixture();f.sourceLogs.push(chainLog("event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",{poolId:hash(44),manager:address(45),token:asset,amount:0n},collector,6,0,1));f.manifest.canaryAuthorization.maxBaseGasWei="5";
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/gas budget/);
});
