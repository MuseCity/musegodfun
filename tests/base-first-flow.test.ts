import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, parseAbiItem, type AbiEvent, type Address, type Hex } from "viem";
import baseDeployment from "../contracts/artifacts/base-collector-deployment.json";
import rhDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { CONTRACTS, STOCKS } from "../src/lib/config";
import { BASE_BUYBACK_FORWARDER, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT } from "../src/lib/base-buyback";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { RELAY_ROUTER } from "../server/buyback";
import { parseBaseFirstFlowArguments, verifyBaseFirstFlow, writeBaseFirstFlowReport, type BaseFirstFlowHashes, type FirstFlowClient } from "../scripts/verify-base-first-flow";

const address=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const collector=baseDeployment.collector.address as Address,automation=baseDeployment.constants.automationReceiver as Address,token=STOCKS[0].address;
const executor=rhDeployment.contracts.executor.address as Address,swapper=rhDeployment.contracts.swapper.address as Address;
function event(contract:Address,text:string,args:Record<string,unknown>,index:number,tx:Hex,block:bigint) {
  const abi=parseAbiItem(text) as AbiEvent;
  return{address:contract,topics:encodeEventTopics({abi:[abi],args}),data:encodeAbiParameters(abi.inputs.filter(input=>!input.indexed),abi.inputs.filter(input=>!input.indexed).map(input=>args[input.name!]) as any),
    logIndex:index,transactionHash:tx,blockNumber:block,blockHash:hash(Number(block)),transactionIndex:0,removed:false};
}
const transfer=(contract:Address,from:Address,to:Address,value:bigint,index:number,tx:Hex,block:bigint)=>event(contract,"event Transfer(address indexed from,address indexed to,uint256 value)",{from,to,value},index,tx,block);
function fixture() {
  const hashes:BaseFirstFlowHashes={claim:hash(1),release:hash(2),baseTransfer:hash(3),arrival:hash(4),forward:hash(5),execute:hash(6)};
  const amounts={fee:100n,arrived:99n,forwarded:99n,spent:99n,muse:123456789123456789123456789n,profit:7n};
  const rows=new Map<Hex,any>();
  const receipt=(tx:Hex,number:bigint,logs:any[])=>{const value={status:"success",transactionHash:tx,blockHash:hash(Number(number)),blockNumber:number,transactionIndex:0,logs};rows.set(tx,value);return value;};
  receipt(hashes.claim,10n,[transfer(token,CONTRACTS.initializer,collector,amounts.fee,0,hashes.claim,10n),
    event(collector,"event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",{poolId:hash(55),manager:CONTRACTS.initializer,token,amount:amounts.fee},1,hashes.claim,10n)]);
  receipt(hashes.release,20n,[transfer(token,collector,automation,amounts.fee,0,hashes.release,20n),
    event(collector,"event FeesReleased(address indexed token,address indexed receiver,uint256 amount)",{token,receiver:automation,amount:amounts.fee},1,hashes.release,20n)]);
  receipt(hashes.baseTransfer,30n,[transfer(token,automation,RELAY_ROUTER,amounts.fee,0,hashes.baseTransfer,30n)]);
  receipt(hashes.arrival,40n,[transfer(BASE_BUYBACK_RH_WETH,address(99),BASE_BUYBACK_TREASURY,amounts.arrived,0,hashes.arrival,40n)]);
  receipt(hashes.forward,50n,[transfer(BASE_BUYBACK_RH_WETH,BASE_BUYBACK_TREASURY,BASE_BUYBACK_VAULT,amounts.forwarded,0,hashes.forward,50n),
    event(BASE_BUYBACK_FORWARDER,"event Forwarded(address indexed caller,uint256 amount)",{caller:address(99),amount:amounts.forwarded},1,hashes.forward,50n)]);
  receipt(hashes.execute,60n,[transfer(BASE_BUYBACK_RH_WETH,BASE_BUYBACK_VAULT,swapper,amounts.spent,0,hashes.execute,60n),
    transfer(MUSEGOD_BUYBACK.tokenAddress,executor,MUSEGOD_BUYBACK.burnAddress,amounts.muse,1,hashes.execute,60n),
    event(BASE_BUYBACK_VAULT,"event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)",{caller:address(99),wethAmount:amounts.spent,museToDead:amounts.muse,profit:amounts.profit},2,hashes.execute,60n)]);
  const reads:Hex[]=[],changed=new Set<bigint>();let sourceChain=8453,destinationChain=4663,finalized=100n;
  const client=(source:boolean):FirstFlowClient=>({getChainId:async()=>source?sourceChain:destinationChain,getTransactionReceipt:async({hash:tx})=>{reads.push(tx);return structuredClone(rows.get(tx));},
    getBlock:async args=>{const number="blockNumber" in args?args.blockNumber:finalized;return{number,hash:changed.has(number)?hash(999):hash(Number(number))};}});
  return{hashes,rows,amounts,reads,changed,clients:{base:client(true),robinhood:client(false)},wrongChain:()=>{destinationChain=8453;},unfinalized:()=>{finalized=59n;}};
}
test("manual first-flow report checks real-address event legs without trace, FIFO or Base burn attribution",async()=>{
  const f=fixture(),report=await verifyBaseFirstFlow(f.hashes,f.clients,()=>123);
  assert.equal(report.status,"manual_receipts_checked");assert.equal(report.checkedAt,123);assert.equal(report.baseAttributedMuseToDead,null);
  assert.equal(report.claim.credits[0].amount,"100");assert.equal(report.release.releases[0].amount,"100");assert.equal(report.baseTransfer.router,RELAY_ROUTER);
  assert.equal(report.arrival.actualWethReceived,"99");assert.equal(report.forward.actualWethDelivered,"99");assert.equal(report.sharedVaultExecution.actualMuseToDead,String(f.amounts.muse));
  assert.equal(report.sharedVaultExecution.callerProfit,"7");assert.equal(report.erc20SupplyReductionClaimed,false);assert.equal(f.reads.length,6);
  assert.match(report.scope,/Owner-selected/);assert.match(report.limitations.join(" "),/equal amounts do not prove origin/);
});
test("a shared-Vault spend may differ from arrival; amounts remain explicit rather than invented source allocation",async()=>{
  const f=fixture(),row=f.rows.get(f.hashes.execute);row.logs[0]=transfer(BASE_BUYBACK_RH_WETH,BASE_BUYBACK_VAULT,swapper,25n,0,f.hashes.execute,60n);
  row.logs[2]=event(BASE_BUYBACK_VAULT,"event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)",{caller:address(99),wethAmount:25n,museToDead:f.amounts.muse,profit:7n},2,f.hashes.execute,60n);
  const report=await verifyBaseFirstFlow(f.hashes,f.clients);assert.equal(report.amountComparisons.forwardEqualsVaultSpend,false);assert.equal(report.sharedVaultExecution.actualWethSpent,"25");assert.equal(report.baseAttributedMuseToDead,null);
});
test("forward and execution in the same transaction share the receipt and retain actual event order",async()=>{
  const f=fixture(),forward=f.rows.get(f.hashes.forward),execute=f.rows.get(f.hashes.execute);f.hashes.execute=f.hashes.forward;
  forward.logs.push(...execute.logs.map((log:any,index:number)=>({...log,transactionHash:forward.transactionHash,blockNumber:50n,blockHash:hash(50),logIndex:index+2})));
  const report=await verifyBaseFirstFlow(f.hashes,f.clients);assert.equal(report.sharedVaultExecution.transactionHash,f.hashes.forward);assert.equal(f.reads.length,5);
});
test("failed, wrong-chain, unfinalized, changed-header and malformed log receipts cannot produce a completed report",async t=>{
  for(const[scenario,change]of Object.entries({failed:(f:ReturnType<typeof fixture>):void=>{f.rows.get(f.hashes.claim).status="reverted";},wrongChain:(f:ReturnType<typeof fixture>)=>f.wrongChain(),
    unfinalized:(f:ReturnType<typeof fixture>)=>f.unfinalized(),reorg:(f:ReturnType<typeof fixture>)=>f.changed.add(20n),
    logIdentity:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.execute).logs[0].transactionHash=hash(99),duplicateLog:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.claim).logs.push({...f.rows.get(f.hashes.claim).logs[0]})})){
    await t.test(scenario,async()=>{const f=fixture();change(f);await assert.rejects(()=>verifyBaseFirstFlow(f.hashes,f.clients));});
  }
});
test("donations, unknown recovery, foreign Router and misleading execution events do not replace actual required transfers",async t=>{
  const cases={donation:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.claim).logs[0].address=address(66),
    noGenuineClaim:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.claim).logs.splice(1),wrongManager:(f:ReturnType<typeof fixture>)=>{
      const row=f.rows.get(f.hashes.claim);row.logs[1]=event(collector,"event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",{poolId:hash(55),manager:address(66),token,amount:100n},1,f.hashes.claim,10n);},
    unknownRelease:(f:ReturnType<typeof fixture>)=>{const row=f.rows.get(f.hashes.release);row.logs[1]=event(collector,"event UntrackedReleased(address indexed token,address indexed receiver,uint256 amount)",{token,receiver:automation,amount:100n},1,f.hashes.release,20n);},
    wrongRouter:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.baseTransfer).logs.splice(0,1,transfer(token,automation,address(66),100n,0,f.hashes.baseTransfer,30n)),
    zeroArrival:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.arrival).logs.splice(0,1,transfer(BASE_BUYBACK_RH_WETH,address(99),BASE_BUYBACK_TREASURY,0n,0,f.hashes.arrival,40n)),
    wrongForwarder:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.forward).logs[1].address=address(66),
    wrongVault:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.execute).logs[2].address=address(66),
    wrongDeadSender:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.execute).logs.splice(1,1,transfer(MUSEGOD_BUYBACK.tokenAddress,address(66),MUSEGOD_BUYBACK.burnAddress,f.amounts.muse,1,f.hashes.execute,60n)),
    wrongBurnAmount:(f:ReturnType<typeof fixture>)=>f.rows.get(f.hashes.execute).logs.splice(1,1,transfer(MUSEGOD_BUYBACK.tokenAddress,executor,MUSEGOD_BUYBACK.burnAddress,1n,1,f.hashes.execute,60n))};
  for(const[scenario,change]of Object.entries(cases))await t.test(scenario,async()=>{const f=fixture();change(f);await assert.rejects(()=>verifyBaseFirstFlow(f.hashes,f.clients));});
});
test("a finalized checkpoint changing after stage reads is rejected",async()=>{
  const f=fixture(),original=f.clients.base.getBlock;f.clients.base.getBlock=async args=>"blockNumber" in args&&args.blockNumber===100n?{number:100n,hash:hash(999)}:original(args);
  await assert.rejects(()=>verifyBaseFirstFlow(f.hashes,f.clients),/checkpoint changed/);
});
test("manual CLI requires all explicit hashes and writes a new private JSON report without overwriting evidence",async()=>{
  const f=fixture(),directory=mkdtempSync(join(tmpdir(),"base-first-flow-")),output=join(directory,"report.json");
  try{
    const args=Object.entries({"--claim":f.hashes.claim,"--release":f.hashes.release,"--base-transfer":f.hashes.baseTransfer,"--arrival":f.hashes.arrival,"--forward":f.hashes.forward,"--execute":f.hashes.execute,"--out":output}).flat();
    assert.deepEqual(parseBaseFirstFlowArguments(args),{hashes:f.hashes,output});assert.throws(()=>parseBaseFirstFlowArguments(args.slice(2)));assert.throws(()=>parseBaseFirstFlowArguments([...args,"--trace","true"]));
    assert.throws(()=>parseBaseFirstFlowArguments([...args,"--claim",f.hashes.claim]));
    const report=await verifyBaseFirstFlow(f.hashes,f.clients,()=>123);writeBaseFirstFlowReport(output,report);
    assert.deepEqual(JSON.parse(readFileSync(output,"utf8")),report);assert.equal(statSync(output).mode&0o777,0o600);assert.throws(()=>writeBaseFirstFlowReport(output,report));
  }finally{rmSync(directory,{recursive:true});}
});
