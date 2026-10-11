import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, type AbiEvent, type Address, type Hex } from "viem";
import { verifyBaseNativeActivation, verifyAdapterRelease, verifyTreasuryForward, readCanonicalBaseCollectorReleaseHistory, canonicalProofJson, nativeRelayFragments } from "../server/base-native-provenance";
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
  return {getChainId:async()=>chain,getBlockNumber:async()=>68n,getBlock:async({blockNumber}:any)=>({...block(Number(blockNumber)),number:blockNumber,timestamp:1000n+blockNumber}),getCode:async()=>"0x1234",readContract:async({address,functionName,args,blockNumber}:any):Promise<bigint>=>{
   if(functionName==="getOperatorFee")return 0n;if(functionName==="totalSpent")return blockNumber===0n?0n:8n;if(functionName==="totalBurned")return blockNumber===0n?0n:16n;
   if(functionName==="balanceOf")return chain===4663&&args[0]===BASE_BUYBACK_TREASURY&&blockNumber===0n?3n:0n;throw new Error(`Unsupported fixture read ${address} ${functionName}`);},
   getLogs:async({address,event,args,fromBlock,toBlock}:any)=>logs.filter(log=>(!address||(Array.isArray(address)?address:[address]).some((asset:string)=>log.address.toLowerCase()===asset.toLowerCase()))&&log.eventName===event.name&&log.blockNumber>=fromBlock&&log.blockNumber<=toBlock&&(!args?.from||log.args.from===args.from)&&(!args?.to||log.args.to===args.to)),
   getTransactionReceipt:async({hash:tx}:any)=>{const events=logs.filter(log=>log.transactionHash===tx);if(!events.length)throw new Error("Receipt missing");return{status:"success",from:address(6),transactionHash:tx,transactionIndex:events[0].transactionIndex,blockNumber:events[0].blockNumber,blockHash:events[0].blockHash,gasUsed:1n,effectiveGasPrice:1n,logs:events};},
   request:async({params}:any)=>{const events=logs.filter(log=>log.transactionHash===params[0]);return{transactionHash:params[0],blockHash:events[0].blockHash,blockNumber:`0x${events[0].blockNumber.toString(16)}`,gasUsed:"0x1",effectiveGasPrice:"0x1",l1Fee:"0x1"};}};
 }
 const manifest:any={collector:{address:collector,runtimeHash:keccak256("0x1234"),blockNumber:"1"},constants:{automationReceiver:automation},canaryAuthorization:{keeper:address(6),expiresAt:"2000",releaseBudgets:[{token:asset,maxAmount:"50"}],maxBaseGasWei:"100",maxRobinhoodGasWei:"100"},activation:{nativeExecution:{version:1,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,proof:{version:1,protocol:BASE_NATIVE_BUYBACK_PROTOCOL,sourceHash:hash(2),destinationHash:hash(3),raw:{}},automation:{state:state("base_automation"),events:sourceEvents},treasury:{state:state("robinhood_treasury"),events:treasuryEvents},vault:{state:vault,events:vaultEvents}}}};
 return {source:client(8453,sourceLogs),destination:client(4663,destinationLogs),manifest,relay,deps:{relay:async()=>relay},sourceLogs,destinationLogs};
}
test("full canonical native acceptance consumes this batch's actual fees through mixed Treasury FIFO and actual dead transfer",async()=>{
 const f=fixture(),result=await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any);assert.equal(result.receivedWeth,"5");assert.equal(result.museToDead,"10");assert.equal(result.sourceSpentAmount,"50");assert.equal(result.baseGasWei,"4");
});
test("one-time activation verification forwards the exact canonical code-fact audit store to its relay verifier",async()=>{
 const f=fixture(),auditStore={getBuybackBatch:async()=>null,compareAndSetBuybackAudit:async()=>{throw new Error("Spy store cannot write financial state");}};let called=0;
 const result=await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,{auditStore,relay:async(...args)=>{
  called++;assert.equal(args[0],f.source);assert.equal(args[1],f.destination);assert.equal(args[2],f.manifest.activation.nativeExecution.proof);assert.equal(args[3],automation);assert.equal(args[4]?.auditStore,auditStore);return f.relay;
 }});
 assert.equal(called,1);assert.equal(result.receivedWeth,"5");assert.equal(result.museToDead,"10");
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
test("permissionless third-party claim/release gas never exhausts the authorized keeper budget",async()=>{
 const f=fixture();f.sourceLogs.push(chainLog("event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",{poolId:hash(44),manager:address(45),token:asset,amount:0n},collector,6,0,1));
 const receipt=f.source.getTransactionReceipt;
 f.source.getTransactionReceipt=async(params:any)=>({...await receipt(params),from:params.hash===hash(1)||params.hash===hash(6)?address(77):address(6),gasUsed:params.hash===hash(6)?10n**18n:1n});
 f.manifest.canaryAuthorization.maxBaseGasWei="2";
 const result=await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any);
 assert.equal(result.baseGasWei,"2");
 f.manifest.canaryAuthorization.releaseBudgets[0].maxAmount="1";
 assert.equal((await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any)).sourceSpentAmount,"50");
});
test("unknown-bucket recovery cannot counterfeit genuine Collector fee acceptance",async()=>{
 const f=fixture(),replacement=chainLog("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:50n},collector,1,1,1);
 Object.assign(f.sourceLogs[1],replacement);
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/Unknown balances/);
});
test("private genuine-fee authorization rejects its keeper's unknown synchronization even alongside valid fees",async()=>{
 const f=fixture();f.sourceLogs.push(chainLog("event UntrackedSynced(address indexed token,uint256 amount)",{token:asset,amount:1n},collector,6,0,1));
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/genuine-fee-only private canary authorization/);
 const receipt=f.source.getTransactionReceipt;f.source.getTransactionReceipt=async(params:any)=>({...await receipt(params),from:params.hash===hash(6)?address(77):address(6)});
 const result=await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any);assert.equal(result.sourceSpentAmount,"50");
});
test("equal repeated Collector releases map to their own preceding transfer and keep unknown releases separate",async()=>{
 const f=fixture(),second=transfer(collector,automation,50n,asset,1,2,1);
 f.sourceLogs.push(second,chainLog("event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:50n},collector,1,3,1));
 for(const [log,index] of [[f.sourceLogs[0],1],[second,3]] as const){
  const proof=await verifyAdapterRelease(f.source as any,custodyEvent(log,automation),collector,automation);assert.equal(proof.releaseLogIndex,index);
 }
 Object.assign(f.sourceLogs[f.sourceLogs.length-1],chainLog("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:50n},collector,1,3,1));
 assert.equal((await verifyAdapterRelease(f.source as any,custodyEvent(f.sourceLogs[0],automation),collector,automation)).releaseLogIndex,1);
 await assert.rejects(()=>verifyAdapterRelease(f.source as any,custodyEvent(second,automation),collector,automation),/Unknown balances/);
});
test("equal repeated Treasury forwards map one-to-one and cannot label a later direct transfer",async()=>{
 const f=fixture(),first=f.destinationLogs[1],second=transfer(BASE_BUYBACK_TREASURY,BASE_BUYBACK_VAULT,8n,BASE_BUYBACK_RH_WETH,4,2,3);
 f.destinationLogs.push(second,chainLog("event Forwarded(address indexed caller,uint256 amount)",{caller:address(6),amount:8n},BASE_BUYBACK_FORWARDER,4,3,3));
 const asVault=(log:ReturnType<typeof transfer>)=>({...custodyEvent(log,BASE_BUYBACK_VAULT),kind:"weth_in",source:"unknown"});
 for(const [log,index] of [[first,1],[second,3]] as const){const proof=await verifyTreasuryForward(f.destination as any,custodyEvent(log,BASE_BUYBACK_TREASURY),asVault(log) as any);assert.deepEqual(proof,{forwarderLogIndex:index,transferLogIndex:log.logIndex});}
 const direct=transfer(BASE_BUYBACK_TREASURY,BASE_BUYBACK_VAULT,8n,BASE_BUYBACK_RH_WETH,4,4,3);f.destinationLogs.push(direct);
 await assert.rejects(()=>verifyTreasuryForward(f.destination as any,custodyEvent(direct,BASE_BUYBACK_TREASURY),asVault(direct) as any),/not this Forwarder/);
});
test("zero/self movements and unsolicited unsupported tokens do not change the canonical fee loop",async()=>{
 const f=fixture();f.sourceLogs.push(transfer(automation,address(77),0n,asset,7,0,3),transfer(automation,automation,999n,asset,8,0,3),transfer(address(77),automation,999n,address(333),9,0,3));
 f.destinationLogs.push(transfer(BASE_BUYBACK_TREASURY,BASE_BUYBACK_TREASURY,999n,BASE_BUYBACK_RH_WETH,10,0,3),transfer(BASE_BUYBACK_VAULT,address(77),0n,BASE_BUYBACK_RH_WETH,11,0,3));
 const result=await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any);assert.equal(result.sourceSpentAmount,"50");assert.equal(result.museToDead,"10");
});
test("a newly released meme asset has zero opening balance before its actual deployment",async()=>{
 const f=fixture(),read=f.source.readContract;
 f.source.readContract=async(params:any)=>{if(params.address===asset&&params.blockNumber===0n)throw new Error("No deployed token");return read(params);};
 f.source.getCode=async(params?:any)=>params?.address===asset&&params.blockNumber===0n?"0x":"0x1234";
 assert.equal((await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any)).sourceSpentAmount,"50");
 f.manifest.activation.nativeExecution.automation.state.openingBalances[asset]="1";
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/balance is fabricated/);
});
test("a canonically discovered bad asset is isolated and its fragments cannot publish a source consumption",async()=>{
 const f=fixture(),bad=address(334),incoming=transfer(collector,automation,10n,bad,7,0,3);
 f.sourceLogs.push(incoming,chainLog("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token:bad,receiver:automation,amount:10n},collector,7,1,3));
 const journal=f.manifest.activation.nativeExecution.automation,unknown=custodyEvent(incoming,automation);journal.events.push({...unknown,fragments:[{batchId:"forged-bad-token-fees",amount:"10"}],evidence:{kind:"adapter_release",collector,releaseLogIndex:1,transactionHash:hash(7),blockHash:block(3).hash}});
 journal.state.openingBalances[bad]="0";journal.state.observedBalances[bad]="10";
 const read=f.source.readContract,receipt=f.source.getTransactionReceipt;
 f.source.readContract=async(params:any)=>{if(params.address.toLowerCase()===bad.toLowerCase())throw new Error("Bad token balance implementation");return read(params);};
 f.source.getTransactionReceipt=async(params:any)=>({...await receipt(params),from:params.hash===hash(7)?address(77):address(6)});
 assert.equal((await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any)).receivedWeth,"5");
 f.relay.sourceAsset=bad;
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/input asset is not verified/);
});
test("partial asset backfill stays withheld without blocking a different complete input",async()=>{
 const f=fixture(),bad=address(335),incoming=transfer(collector,automation,10n,bad,7,0,3);
 f.sourceLogs.push(incoming,chainLog("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token:bad,receiver:automation,amount:10n},collector,7,1,3));
 const journal=f.manifest.activation.nativeExecution.automation;journal.events.push(custodyEvent(incoming,automation));journal.state.openingBalances[bad]="0";journal.state.observedBalances[bad]="10";journal.state.assetCursors={[bad]:block(2)};
 const read=f.source.readContract,receipt=f.source.getTransactionReceipt;
 f.source.readContract=async(params:any)=>params.address.toLowerCase()===bad.toLowerCase()?(params.blockNumber===0n?0n:10n):read(params);
 f.source.getTransactionReceipt=async(params:any)=>({...await receipt(params),from:params.hash===hash(7)?address(77):address(6)});
 assert.equal((await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any)).receivedWeth,"5");
 f.relay.sourceAsset=bad;
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/backfill is incomplete/);
});
test("an unknown Collector recovery remains FIFO unknown while a different genuine fee spend can complete",async()=>{
 const f=fixture(),incoming=transfer(collector,automation,10n,asset,7,0,3),outgoing=transfer(automation,address(77),10n,asset,8,0,4);
 f.sourceLogs.push(incoming,chainLog("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:10n},collector,7,1,3),outgoing);
 f.manifest.activation.nativeExecution.automation.events.push(custodyEvent(incoming,automation),custodyEvent(outgoing,automation));
 const receipt=f.source.getTransactionReceipt;f.source.getTransactionReceipt=async(params:any)=>({...await receipt(params),from:[hash(7),hash(8)].includes(params.hash)?address(77):address(6)});
 assert.equal((await verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any)).sourceSpentAmount,"50");
 const g=fixture();Object.assign(g.sourceLogs[1],chainLog("event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:50n},collector,1,1,1));
 const gReceipt=g.source.getTransactionReceipt;g.source.getTransactionReceipt=async(params:any)=>({...await gReceipt(params),from:params.hash===hash(1)?address(77):address(6)});
 delete g.manifest.activation.nativeExecution.automation.events[0].fragments;delete g.manifest.activation.nativeExecution.automation.events[0].evidence;
 await assert.rejects(()=>verifyBaseNativeActivation(g.source as any,g.destination as any,g.manifest,68n,g.deps as any),/consumes unverified\/unknown funds/);
});
test("foreign fee releases still invalidate a checkpoint established after actual funding",async()=>{
 const f=fixture();f.manifest.activation.nativeExecution.automation.state.checkpoint=block(1);
 const receipt=f.source.getTransactionReceipt;f.source.getTransactionReceipt=async(params:any)=>({...await receipt(params),from:address(77)});
 await assert.rejects(()=>verifyBaseNativeActivation(f.source as any,f.destination as any,f.manifest,68n,f.deps as any),/checkpoint was established after Base funding/);
});
test("complete canonical mined release history binds actual payer, repeated log positions and the latest block",async()=>{
 const f=fixture();f.sourceLogs.push(transfer(collector,automation,50n,asset,7,0,4),chainLog("event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:50n},collector,7,1,4),transfer(collector,automation,50n,asset,7,2,4),chainLog("event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",{token:asset,receiver:automation,amount:50n},collector,7,3,4));
 const receipt=f.source.getTransactionReceipt;f.source.getTransactionReceipt=async(params:any)=>({...await receipt(params),from:params.hash===hash(1)?address(77):address(6)});
 f.source.getBlockNumber=async()=>4n; // Latest mined owner release is reserved even without a second confirmation.
 const rows=await readCanonicalBaseCollectorReleaseHistory(f.source as any,collector,automation,1n,4n);
 assert.equal(rows.length,3);assert.equal(rows.filter(row=>row.from===address(6)).reduce((sum,row)=>sum+row.amount,0n),100n);assert.deepEqual(rows.filter(row=>row.from===address(6)).map(row=>row.logIndex),[1,3]);
 const getBlock=f.source.getBlock;let tips=0;f.source.getBlock=async(params:any)=>{const result=await getBlock(params);return params.blockNumber===4n&&++tips>1?{...result,hash:hash(999)}:result;};
 await assert.rejects(()=>readCanonicalBaseCollectorReleaseHistory(f.source as any,collector,automation,1n,4n),/canonical successful receipt|reorganized|Canonical Base audit endpoint changed/);
});
