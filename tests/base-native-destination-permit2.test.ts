import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, keccak256, parseAbi, parseTransaction,
 type Address, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { inspectNativeDestinationReceiptStructure, nativeDestinationHasFixedProvider, NativeDestinationProviderPendingError, BASE_NATIVE_RELAY_SOLVER,
 nativeCleanupErc20Abi, nativeRelayRouterAbi, nativeSolverExecutionAbi, nativeDestinationPermitAbi, nativeDestinationPermitTypes,
 NATIVE_DESTINATION_PERMIT2, NATIVE_DESTINATION_PROXY_CODE_HASH, NATIVE_DESTINATION_PERMIT2_CODE_HASH } from "../server/base-native-trace";
import { RELAY_APPROVAL_PROXY } from "../src/lib/buyback";
import { RELAY_ROUTER, BUYBACK_CODE_HASHES } from "../server/buyback";
import { BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY } from "../src/lib/base-buyback";
import proxySample from "./fixtures/base-native-permit2-proxy-mainnet.json";
import proxy2Sample from "./fixtures/base-native-permit2-proxy2-mainnet.json";
import directSample from "./fixtures/base-native-permit2-direct-mainnet.json";
import recentSample from "./fixtures/base-native-permit2-recent-mainnet.json";
import evidence from "../docs/evidence/base-native-permit2-runtime.json";
import { Store } from "../server/store";
import { runtimeFromEnv } from "../server/config";
import { openVaultLedgerReadOnlyStore } from "../server/buyback-vault-runtime";
import { readonlyBaseAuditOverlay, readonlyCanonicalBaseAuditSource } from "../scripts/buyback-vault-ledger";
// Deterministic public UNIT TEST keys. They have no relation to any deployed role.
const owner=privateKeyToAccount(`0x${"01".repeat(32)}`),relayer=privateKeyToAccount(`0x${"02".repeat(32)}`);
const h=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const runtime="0x60016000f3" as Hex,metadata=`${h(123)}00` as Hex,amount=123456789012345678n;
const movementAbi=parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
function log(abi:any,address:Address,args:Record<string,unknown>,index:number,txHash:Hex){return{address,topics:encodeEventTopics({abi:[abi],args}),
 data:encodeAbiParameters(abi.inputs.filter((i:any)=>!i.indexed),abi.inputs.filter((i:any)=>!i.indexed).map((i:any)=>args[i.name])),logIndex:index,transactionHash:txHash,blockHash:h(200),blockNumber:200n,transactionIndex:0,removed:false};}
const context={provider:owner.address,token:BASE_BUYBACK_RH_WETH,recipient:BASE_BUYBACK_TREASURY,routerCodeHash:keccak256(runtime),proxyCodeHash:keccak256(runtime),permit2CodeHash:keccak256(runtime),};
async function fixture(direct=false){
 const cleanup={target:RELAY_ROUTER,allowFailure:false,value:0n,callData:encodeFunctionData({abi:nativeCleanupErc20Abi,functionName:"cleanupErc20s",args:[[context.token],[context.recipient],[0n],metadata]})};
 const funding={target:context.token,allowFailure:false,value:0n,callData:encodeFunctionData({abi:erc20Abi,functionName:"transferFrom",args:[owner.address,RELAY_ROUTER,amount]})};
 const calls=direct?[funding,cleanup]:[cleanup];const permit={permitted:[{token:context.token,amount}],nonce:1234n,deadline:2000n};
 const state={chain:4663,head:500n,from:direct?owner.address:relayer.address,refund:context.recipient,nft:context.recipient,tag:metadata,value:0n,signature:"0x" as Hex,
 actualOutput:amount,footer:"",tx:{} as any,receipt:{} as any,changedCode:undefined as Address|undefined,delegated:undefined as Address|undefined,getCodeError:false,reorg:false,reads:0,traces:0};
 async function rebuild(signWitness=true){
  if(!direct&&signWitness)state.signature=await owner.signTypedData({domain:{name:"Permit2",chainId:4663,verifyingContract:NATIVE_DESTINATION_PERMIT2},types:nativeDestinationPermitTypes,
   primaryType:"PermitBatchWitnessTransferFrom",message:{...permit,spender:RELAY_APPROVAL_PROXY,witness:{relayer:state.from,refundTo:state.refund,nftRecipient:state.nft,metadata:state.tag,call3Values:calls}}});
  const canonicalInput=direct?encodeFunctionData({abi:nativeRelayRouterAbi,functionName:"multicall",args:[calls,state.refund,state.nft,state.tag]}):
   encodeFunctionData({abi:nativeDestinationPermitAbi,functionName:"permit2TransferAndMulticall",args:[owner.address,permit,calls,state.refund,state.nft,state.tag,state.signature]});
  const input=`${canonicalInput}${state.footer}` as Hex;
  const account=direct?owner:relayer,serialized=await account.signTransaction({chainId:4663,type:"eip1559",nonce:1,gas:300000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,to:direct?RELAY_ROUTER:RELAY_APPROVAL_PROXY,value:state.value,data:input});
  const txHash=keccak256(serialized);state.tx={...parseTransaction(serialized),hash:txHash,input,value:state.value,from:state.from,blockNumber:200n,blockHash:h(200),transactionIndex:0};
  const logs:any[]=[];const add=(abi:any,address:Address,args:Record<string,unknown>)=>logs.push(log(abi,address,args,logs.length,txHash));
  if(!direct)add(movementAbi[0],RELAY_APPROVAL_PROXY,{from:owner.address,to:RELAY_ROUTER,currency:permit.permitted[0].token,amount:permit.permitted[0].amount,metadata:state.tag});
  add(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),permit.permitted[0].token,{from:owner.address,to:RELAY_ROUTER,value:permit.permitted[0].amount});
  for(const call of calls){if(call===cleanup){add(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),context.token,{from:RELAY_ROUTER,to:context.recipient,value:state.actualOutput});
   add(movementAbi[0],RELAY_ROUTER,{from:RELAY_ROUTER,to:context.recipient,currency:context.token,amount:state.actualOutput,metadata:state.tag});}
   add(nativeSolverExecutionAbi[0],RELAY_ROUTER,{to:call.target,data:call.callData,amount:call.value});}
  state.receipt={status:"success",transactionHash:txHash,from:state.from,to:state.tx.to,blockNumber:200n,blockHash:h(200),transactionIndex:0,gasUsed:100000n,effectiveGasPrice:2n,logs};
 }
 await rebuild();
 const client={getChainId:async()=>state.chain,getBlockNumber:async()=>state.head,getTransactionReceipt:async()=>state.receipt,getTransaction:async()=>state.tx,
  getBlock:async({blockNumber}:{blockNumber?:bigint})=>{const n=blockNumber??state.head;return{number:n,hash:state.reorg?h(999):h(Number(n)),parentHash:h(Number(n)-1),timestamp:1001n};},
  getCode:async({address}:{address:Address})=>{state.reads++;if(state.getCodeError)throw Error("secret endpoint");if(state.delegated?.toLowerCase()===address.toLowerCase())return"0xef0100";
   if([owner.address,relayer.address].some(a=>a.toLowerCase()===address.toLowerCase()))return undefined;return state.changedCode?.toLowerCase()===address.toLowerCase()?"0x60026000fd":runtime;},
  request:async()=>{state.traces++;throw Error("destination must never use trace");}} as unknown as PublicClient<Transport,any>;
 return{client,state,calls,permit,cleanup,funding,rebuild,inspect:()=>inspectNativeDestinationReceiptStructure(client,state.tx.hash,metadata,context)};
}
test("signed Permit2 funding owner survives a rotating root and supplies an explicitly nonfinancial receipt inspection",async()=>{
 const f=await fixture(),r=await f.inspect();assert.equal(r.fundingOwner,owner.address);assert.equal(r.projectPath,false);assert.equal(r.outputAmount,String(amount));assert.equal(f.state.traces,0);
 assert.notEqual(f.state.tx.from,owner.address);assert.equal(r.transferLogIndex,2);
});
test("signed direct Router owner alone lacks required Permit2 witness",async()=>{const f=await fixture(true);await assert.rejects(f.inspect,/Permit2/);});
test("signed canonical Relay calldata accepts one opaque 32-byte footer without treating it as order evidence",async()=>{
 const f=await fixture();f.state.footer="ab".repeat(32);await f.rebuild();const r=await f.inspect();assert.equal(r.projectPath,false);assert.equal(r.outputAmount,String(amount));assert(!("orderId"in r));
});
for(const bytes of[1,31,33,64])test(`signed root rejects ${bytes}-byte noncanonical footer`,async()=>{const f=await fixture();f.state.footer="ab".repeat(bytes);await f.rebuild();await assert.rejects(f.inspect,/parameters/);});
test("footer cannot replace the owner signature over metadata or calls",async()=>{const f=await fixture();f.state.footer="ab".repeat(32);f.state.tag=`${h(555)}00`;await f.rebuild(false);await assert.rejects(f.inspect,/signature/);
 const g=await fixture();g.state.footer="ab".repeat(32);g.calls[0].callData="0x1234";await g.rebuild(false);await assert.rejects(g.inspect,/signature/);
});
test("ABI-decodable noncanonical offsets are rejected despite identical signed owner arguments",async()=>{
 const f=await fixture(),original=f.state.tx.input as Hex,head=original.slice(10,10+7*64).match(/.{64}/g)!;
 for(const i of[1,2,5,6])head[i]=(BigInt(`0x${head[i]}`)+32n).toString(16).padStart(64,"0");
 const input=`${original.slice(0,10)}${head.join("")}${"00".repeat(32)}${original.slice(10+7*64)}` as Hex;
 assert.deepEqual(decodeFunctionData({abi:nativeDestinationPermitAbi,data:input}).args,decodeFunctionData({abi:nativeDestinationPermitAbi,data:original}).args);
 const serialized=await relayer.signTransaction({chainId:4663,type:"eip1559",nonce:1,gas:300000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,to:RELAY_APPROVAL_PROXY,value:0n,data:input}),txHash=keccak256(serialized);
 f.state.tx={...f.state.tx,...parseTransaction(serialized),input,hash:txHash,value:0n};f.state.receipt.transactionHash=txHash;for(const l of f.state.receipt.logs)l.transactionHash=txHash;
 await assert.rejects(f.inspect,/parameters/);
});
const witnessMutations:[string,(f:Awaited<ReturnType<typeof fixture>>)=>void][]=[
 ["root relayer",f=>{f.state.from=owner.address;}],["refund",f=>{f.state.refund=owner.address;}],["nft recipient",f=>{f.state.nft=owner.address;}],
 ["metadata",f=>{f.state.tag=`${h(999)}00`;}],["call target",f=>{f.calls[0].target=owner.address;}],["allowFailure",f=>{f.calls[0].allowFailure=true;}],
 ["call value",f=>{f.calls[0].value=1n;}],["call calldata",f=>{f.calls[0].callData="0x1234";}],["permitted amount",f=>{f.permit.permitted[0].amount++;}],
 ["permitted token",f=>{f.permit.permitted[0].token=owner.address;}],["nonce",f=>{f.permit.nonce++;}],["deadline",f=>{f.permit.deadline++;}],
];
for(const[name,mutate]of witnessMutations)test(`owner witness rejects ${name} changed even with a newly signed root`,async()=>{const f=await fixture();mutate(f);await f.rebuild(false);await assert.rejects(f.inspect);});
for(const signature of["0x",`0x${"00".repeat(65)}`,`0x${"12".repeat(64)}`]as Hex[])test(`missing or forged Permit2 signature ${signature.length} is rejected`,async()=>{
 const f=await fixture();f.state.signature=signature;await f.rebuild(false);await assert.rejects(f.inspect);
});
test("65-byte and EIP2098 signatures recover the same actual owner",async()=>{const f=await fixture(),sig=f.state.signature;
 f.state.signature=`${sig.slice(0,66)}${(BigInt(`0x${sig.slice(66,130)}`)|(BigInt(parseInt(sig.slice(130),16)-27)<<255n)).toString(16).padStart(64,"0")}` as Hex;
 await f.rebuild(false);assert.equal((await f.inspect()).fundingOwner,owner.address);
});
const transactionMutations:[string,(f:Awaited<ReturnType<typeof fixture>>)=>void][]=[
 ["missing r",f=>{f.state.tx.r=undefined;}],["zero r",f=>{f.state.tx.r=h(0);}],["missing s",f=>{f.state.tx.s=undefined;}],["zero s",f=>{f.state.tx.s=h(0);}],
 ["foreign from",f=>{f.state.tx.from=owner.address;f.state.receipt.from=owner.address;}],["unsigned Nitro type",f=>{f.state.tx.type="deposit";}],["7702",f=>{f.state.tx.type="eip7702";}],
 ["EntryPoint root",f=>{f.state.tx.to=owner.address;f.state.receipt.to=owner.address;}],["input suffix",f=>{f.state.tx.input+="00";}],["wrong hash",f=>{f.state.tx.hash=h(999);}],
 ["wrong chain",f=>{f.state.tx.chainId=8453;}],["wrong tx index",f=>{f.state.tx.transactionIndex=1;}],["unbound native value",f=>{f.state.value=1n;}],
];
for(const[name,mutate]of transactionMutations)test(`canonical signed root rejects ${name}`,async()=>{const f=await fixture();mutate(f);if(name==="unbound native value")await f.rebuild();await assert.rejects(f.inspect);});
const receiptMutations:[string,(f:Awaited<ReturnType<typeof fixture>>)=>void][]=[
 ["revert",f=>{f.state.receipt.status="reverted";}],["missing Transfer",f=>{f.state.receipt.logs.splice(2,1);}],["fake token Transfer",f=>{f.state.receipt.logs[2].address=owner.address;}],
 ["funding diverted",f=>{f.state.receipt.logs[1].topics=encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from:owner.address,to:relayer.address}});}],
 ["funding quantity mismatch",f=>{f.state.receipt.logs[1].data=encodeAbiParameters([{type:"uint256"}],[amount-1n]);}],
 ["funding comes after payment",f=>{[f.state.receipt.logs[1],f.state.receipt.logs[2]]=[f.state.receipt.logs[2],f.state.receipt.logs[1]];f.state.receipt.logs.forEach((l:any,i:number)=>l.logIndex=i);}],
 ["missing Proxy movement",f=>{f.state.receipt.logs.shift();}],["wrong Proxy movement emitter",f=>{f.state.receipt.logs[0].address=owner.address;}],
 ["missing success",f=>{f.state.receipt.logs.pop();}],["duplicate success",f=>{f.state.receipt.logs.push({...f.state.receipt.logs.at(-1),logIndex:5});}],
 ["foreign success emitter",f=>{f.state.receipt.logs.at(-1).address=owner.address;}],["success calldata mismatch",f=>{f.state.receipt.logs.at(-1).data=encodeAbiParameters(nativeSolverExecutionAbi[0].inputs,[RELAY_ROUTER,"0x1234",0n]);}],
 ["noncanonical log hash",f=>{f.state.receipt.logs[2].transactionHash=h(999);}],["duplicate log position",f=>{f.state.receipt.logs[3].logIndex=2;}],["removed log",f=>{f.state.receipt.logs[2].removed=true;}],
 ["duplicate Treasury payment",f=>{f.state.receipt.logs.push({...f.state.receipt.logs[2],logIndex:5});}],

];
for(const[name,mutate]of receiptMutations)test(`authenticated funding and receipt reject ${name}`,async()=>{const f=await fixture();mutate(f);await assert.rejects(f.inspect);});
test("second multicall cannot splice a solver funding witness into a different request",async()=>{const f=await fixture();f.calls.unshift({target:RELAY_ROUTER,allowFailure:false,value:0n,
 callData:encodeFunctionData({abi:nativeRelayRouterAbi,functionName:"multicall",args:[[f.cleanup],f.state.refund,f.state.nft,`${h(999)}00`]})});await f.rebuild();await assert.rejects(f.inspect,/uniquely/);});
test("one transaction containing two equal same-tag runs is ambiguous and cannot yield either batch",async()=>{
 const f=await fixture();f.calls.push({...f.cleanup});await f.rebuild();await assert.rejects(f.inspect);
});
for(const address of[RELAY_ROUTER,RELAY_APPROVAL_PROXY,NATIVE_DESTINATION_PERMIT2])test(`changed historical implementation ${address} rejects`,async()=>{const f=await fixture();f.state.changedCode=address;await assert.rejects(f.inspect,/implementation/);});
for(const address of[owner.address,relayer.address])test(`delegated historical owner/root ${address} rejects`,async()=>{const f=await fixture();f.state.delegated=address;await assert.rejects(f.inspect,/provider/);});
test("real viem empty-code reviewed EOA passes the actual signed receipt engine while Router code is nonempty",async()=>{
 const f=await fixture();const viem=createPublicClient({transport:custom({request:async({method,params})=>{assert.equal(method,"eth_getCode");return[owner.address,relayer.address].some(a=>a.toLowerCase()===String(params?.[0]).toLowerCase())?"0x":runtime;}})});
 assert.equal(await viem.getCode({address:owner.address,blockNumber:200n}),undefined);
 const result=await inspectNativeDestinationReceiptStructure({...f.client,getCode:viem.getCode}as typeof f.client,f.state.tx.hash,metadata,context);
 assert.equal(result.projectPath,false);assert.equal(result.outputAmount,String(amount));
});
test("real viem empty-code foreign owner negative requires complete canonical envelope, no history",async()=>{
 const f=await fixture(),[router,proxy,permit2]=await Promise.all([readFile(new URL("./fixtures/base-native-destination-control-mainnet.json",import.meta.url),"utf8").then(x=>JSON.parse(x).codes.target[RELAY_ROUTER.toLowerCase()].code),
 readFile(new URL("../docs/evidence/base-native-permit2/proxy-runtime.hex",import.meta.url),"utf8"),readFile(new URL("../docs/evidence/base-native-permit2/permit2-runtime.hex",import.meta.url),"utf8")]);
 let unavailable=false;const viem=createPublicClient({transport:custom({request:async({params})=>{if(unavailable)throw Error("secret endpoint");const a=String(params?.[0]).toLowerCase();return a===RELAY_ROUTER.toLowerCase()?router:a===RELAY_APPROVAL_PROXY.toLowerCase()?proxy.trim():a===NATIVE_DESTINATION_PERMIT2?permit2.trim():"0x";}})});
 assert.equal(await viem.getCode({address:owner.address}),undefined);const client={...f.client,getCode:viem.getCode}as typeof f.client;
 assert.equal(await nativeDestinationHasFixedProvider(client,f.state.tx.hash,metadata),false);unavailable=true;
 assert.equal(await nativeDestinationHasFixedProvider(client,f.state.tx.hash,metadata),false);
});
for(const kind of["other-token solver Transfer","solver Proxy funding event"]as const)test(`foreign Permit2 D1-b participation classification with ${kind}`,async()=>{
 const f=await fixture(),[router,proxy,permit2]=await Promise.all([readFile(new URL("./fixtures/base-native-destination-control-mainnet.json",import.meta.url),"utf8").then(x=>JSON.parse(x).codes.target[RELAY_ROUTER.toLowerCase()].code),
 readFile(new URL("../docs/evidence/base-native-permit2/proxy-runtime.hex",import.meta.url),"utf8"),readFile(new URL("../docs/evidence/base-native-permit2/permit2-runtime.hex",import.meta.url),"utf8")]);
 f.client.getCode=(async({address}:any)=>address.toLowerCase()===RELAY_ROUTER.toLowerCase()?router:address.toLowerCase()===RELAY_APPROVAL_PROXY.toLowerCase()?proxy.trim():address.toLowerCase()===NATIVE_DESTINATION_PERMIT2?permit2.trim():undefined)as any;
 const extra=kind==="other-token solver Transfer"?log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),relayer.address,{from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,value:1n},5,f.state.tx.hash):
 log(movementAbi[0],RELAY_APPROVAL_PROXY,{from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,currency:relayer.address,amount:1n,metadata},5,f.state.tx.hash);
 f.state.receipt.logs.push(extra);if(kind==="other-token solver Transfer")await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),NativeDestinationProviderPendingError);else assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});
test("real viem eth_getCode RPC throw stays pending and recovers; empty Router is never an EOA",async()=>{
 const f=await fixture();let fail=true;const viem=createPublicClient({transport:custom({request:async({params})=>{if(fail)throw Error("secret endpoint 429");return[owner.address,relayer.address].some(a=>a.toLowerCase()===String(params?.[0]).toLowerCase())?"0x":runtime;}})});
 const client={...f.client,getCode:viem.getCode}as typeof f.client;await assert.rejects(()=>inspectNativeDestinationReceiptStructure(client,f.state.tx.hash,metadata,context));fail=false;
 assert.equal((await inspectNativeDestinationReceiptStructure(client,f.state.tx.hash,metadata,context)).outputAmount,String(amount));
 const empty=createPublicClient({transport:custom({request:async()=>"0x"})});await assert.rejects(()=>inspectNativeDestinationReceiptStructure({...f.client,getCode:empty.getCode}as typeof f.client,f.state.tx.hash,metadata,context),/implementation/);
});
for(const field of["from","status"]as const)for(const value of[undefined,"0x1234"]as const)test(`missing or unsupported receipt ${field}=${String(value)} remains pending and recovers`,async()=>{
 const f=await fixture(),before=f.state.receipt[field];f.state.receipt[field]=value;
 await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),NativeDestinationProviderPendingError);
 f.state.receipt[field]=before;assert.equal((await f.inspect()).outputAmount,String(amount));
});
test("foreign-looking owner with extra fixed solver funding cannot become a conclusive negative",async()=>{
 const f=await fixture(),extra=log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),context.token,{from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,value:1n},2,f.state.tx.hash);
 f.state.receipt.logs.splice(2,0,extra);f.state.receipt.logs.forEach((l:any,i:number)=>l.logIndex=i);
 await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),NativeDestinationProviderPendingError);
});
test("unsupported foreign route is negative, altered root hash remains pending",async()=>{
 const f=await fixture(true);assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
 f.state.tx.to=owner.address;f.state.receipt.to=owner.address;await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),NativeDestinationProviderPendingError);
});
test("temporary snapshot failure/reorg/lag never authorizes and can be retried",async()=>{const f=await fixture();f.state.reorg=true;await assert.rejects(f.inspect);f.state.reorg=false;f.state.head=200n;await assert.rejects(f.inspect);f.state.head=500n;assert.equal((await f.inspect()).outputAmount,String(amount));});
test("all final transaction fields remain stable across the second canonical read",async()=>{const f=await fixture();let reads=0;const original=f.client.getTransaction;
 f.client.getTransaction=(async(a:any)=>({...await original(a),nonce:++reads===1?1:2}))as any;await assert.rejects(f.inspect,/snapshot/);f.client.getTransaction=original;assert.equal((await f.inspect()).outputAmount,String(amount));
});
async function recordedClient(sample:{transaction:Record<string,unknown>;receipt:Record<string,unknown>;block:Record<string,any>;parentBlock:Record<string,any>}){
 const formatter=createPublicClient({transport:custom({request:async({method})=>{if(method==="eth_getTransactionByHash")return sample.transaction;if(method==="eth_getTransactionReceipt")return sample.receipt;throw Error("offline only");}})});
 const tx=await formatter.getTransaction({hash:sample.transaction.hash as Hex}),receipt=await formatter.getTransactionReceipt({hash:sample.transaction.hash as Hex});
 const [router,proxy,permit2]=await Promise.all([readFile(new URL("./fixtures/base-native-destination-control-mainnet.json",import.meta.url),"utf8").then(x=>JSON.parse(x).codes.target[RELAY_ROUTER.toLowerCase()].code),
  readFile(new URL("../docs/evidence/base-native-permit2/proxy-runtime.hex",import.meta.url),"utf8"),readFile(new URL("../docs/evidence/base-native-permit2/permit2-runtime.hex",import.meta.url),"utf8")]);
 const client={getChainId:async()=>4663,getBlockNumber:async()=>receipt.blockNumber+100n,getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,
  getBlock:async({blockNumber}:{blockNumber:bigint})=>{const raw=blockNumber===undefined||blockNumber===receipt.blockNumber?sample.block:sample.parentBlock;return{...raw,number:BigInt(raw.number),timestamp:BigInt(raw.timestamp)};},
  // Offline runtime fixtures explicitly DO NOT prove historical deployment state.
  getCode:async({address}:{address:Address})=>address.toLowerCase()===RELAY_ROUTER.toLowerCase()?router:address.toLowerCase()===RELAY_APPROVAL_PROXY.toLowerCase()?proxy.trim():address.toLowerCase()===NATIVE_DESTINATION_PERMIT2?permit2.trim():undefined,
  request:async()=>{throw Error("No RPC/trace in offline sample tests");}}as unknown as PublicClient<Transport,any>;
 return{client,tx,receipt};
}
for(const[label,sample]of[["PULP",proxySample],["GOLDEN",proxy2Sample],["recent STOX",recentSample]]as const)test(`actual ${label} rotating-root Permit2 signature/funding/ordered receipt passes D3 signed execution structural inspection with a different output/recipient`,async()=>{
 const {client,tx}=await recordedClient(sample);const decoded=decodeFunctionData({abi:nativeDestinationPermitAbi,data:tx.input});const cleanup=decodeFunctionData({abi:nativeCleanupErc20Abi,data:decoded.args[2].at(-1)!.callData});
 const c={provider:BASE_NATIVE_RELAY_SOLVER,token:cleanup.args[0][0],recipient:cleanup.args[1][0],routerCodeHash:BUYBACK_CODE_HASHES[RELAY_ROUTER.toLowerCase()],proxyCodeHash:NATIVE_DESTINATION_PROXY_CODE_HASH,
  permit2CodeHash:NATIVE_DESTINATION_PERMIT2_CODE_HASH};
 const result=await inspectNativeDestinationReceiptStructure(client,tx.hash,decoded.args[5],c);assert.equal(result.projectPath,false);assert.equal(result.projectFeeCanary,false);assert.notEqual(tx.from.toLowerCase(),BASE_NATIVE_RELAY_SOLVER);
 assert.equal(sample.strictAccepted,false);assert.match(sample.historicalCodeStatus,/not_proven/);assert.notEqual(result.outputToken.toLowerCase(),BASE_BUYBACK_RH_WETH.toLowerCase());
 await assert.rejects(()=>nativeDestinationHasFixedProvider(client,tx.hash,decoded.args[5]),NativeDestinationProviderPendingError);
});
test("actual direct rotating root is signed but has no fixed-owner witness and is not project evidence",async()=>{const{client,tx}=await recordedClient(directSample as typeof proxySample);
 assert.equal(await nativeDestinationHasFixedProvider(client,tx.hash),false);assert.equal(directSample.projectFeeCanary,false);assert.notEqual(tx.from.toLowerCase(),BASE_NATIVE_RELAY_SOLVER);
});
test("compiler artifacts reproduce exact runtime sizes/hash and retain honest activation boundaries",async()=>{
 for(const[name,hash]of[["proxy",NATIVE_DESTINATION_PROXY_CODE_HASH],["permit2",NATIVE_DESTINATION_PERMIT2_CODE_HASH]]as const){const code=(await readFile(new URL(`../docs/evidence/base-native-permit2/${name}-runtime.hex`,import.meta.url),"utf8")).trim() as Hex;
  const input=await readFile(new URL(`../docs/evidence/base-native-permit2/${name}-compiler-input.json`,import.meta.url));assert.equal(keccak256(code),hash);assert.equal(evidence[name].fullRuntimeMatch,true);
  assert.equal(createHash("sha256").update(input).digest("hex"),evidence[name].inputSha256);assert.equal((code.length-2)/2,evidence[name].runtimeBytes);}
 assert.equal(evidence.projectFeeCanary,false);assert.match(evidence.activation,/not_run/);
});
async function pureForeignDonation(){
 const f=await fixture(true);f.calls.shift();await f.rebuild();f.state.receipt.logs.shift();f.state.receipt.logs.forEach((l:any,i:number)=>l.logIndex=i);
 const[router,proxy,permit2]=await Promise.all([readFile(new URL("./fixtures/base-native-destination-control-mainnet.json",import.meta.url),"utf8").then(x=>JSON.parse(x).codes.target[RELAY_ROUTER.toLowerCase()].code),
  readFile(new URL("../docs/evidence/base-native-permit2/proxy-runtime.hex",import.meta.url),"utf8"),readFile(new URL("../docs/evidence/base-native-permit2/permit2-runtime.hex",import.meta.url),"utf8")]);
 f.client.getCode=(async({address}:any)=>{if(f.state.getCodeError)throw Error("secret endpoint");if(f.state.changedCode?.toLowerCase()===address.toLowerCase())return undefined;
  if(f.state.delegated?.toLowerCase()===address.toLowerCase())return"0xef0100";return address.toLowerCase()===RELAY_ROUTER.toLowerCase()?router:address.toLowerCase()===RELAY_APPROVAL_PROXY.toLowerCase()?proxy.trim():address.toLowerCase()===NATIVE_DESTINATION_PERMIT2?permit2.trim():undefined;})as any;
 return f;
}
test("fully signed single-cleanup foreign Router dust is negative after fresh canonical closure",async()=>{
 const f=await pureForeignDonation();assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);assert.equal(f.state.traces,0);
});
for(const[name,mutate]of[
 ["solver WETH funding",(f:Awaited<ReturnType<typeof fixture>>)=>{f.state.receipt.logs.unshift(log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),context.token,{from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,value:1n},0,f.state.tx.hash));f.state.receipt.logs.forEach((l:any,i:number)=>l.logIndex=i);} ],
 ["Proxy funds event",(f:Awaited<ReturnType<typeof fixture>>)=>{f.state.receipt.logs.unshift(log(movementAbi[0],RELAY_APPROVAL_PROXY,{from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,currency:context.token,amount:1n,metadata},0,f.state.tx.hash));f.state.receipt.logs.forEach((l:any,i:number)=>l.logIndex=i);} ],
 ["unknown Router code",(f:Awaited<ReturnType<typeof fixture>>)=>{f.state.changedCode=RELAY_ROUTER;} ],
 ["root delegation",(f:Awaited<ReturnType<typeof fixture>>)=>{f.state.delegated=owner.address;} ],
 ["fixed owner delegation",(f:Awaited<ReturnType<typeof fixture>>)=>{f.state.delegated=BASE_NATIVE_RELAY_SOLVER;} ],
 ["historical code RPC outage",(f:Awaited<ReturnType<typeof fixture>>)=>{f.state.getCodeError=true;} ],
 ["actual hash reorg",(f:Awaited<ReturnType<typeof fixture>>)=>{f.state.reorg=true;} ],
]as const)test(`foreign cleanup D1-b classifies ${name}`,async()=>{
 const f=await pureForeignDonation();mutate(f);if(name==="solver WETH funding"||name==="actual hash reorg")await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),error=>error instanceof NativeDestinationProviderPendingError&&!error.message.includes("secret"));else assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});
for(const kind of["native refund","ERC721 Transfer","unknown callback"]as const)test(`foreign canonical cleanup remains negative with unrelated ${kind} log`,async()=>{
 const f=await pureForeignDonation();const extra=kind==="native refund"?log(movementAbi[0],RELAY_ROUTER,{from:RELAY_ROUTER,to:owner.address,currency:"0x0000000000000000000000000000000000000000",amount:1n,metadata},3,f.state.tx.hash):
  kind==="ERC721 Transfer"?{...f.state.receipt.logs[0],address:relayer.address,topics:[f.state.receipt.logs[0].topics[0],`0x${BASE_NATIVE_RELAY_SOLVER.slice(2).padStart(64,"0")}`,`0x${RELAY_ROUTER.slice(2).padStart(64,"0")}`,h(1)],data:"0x",logIndex:3}:
  {...f.state.receipt.logs[0],address:relayer.address,topics:[h(999)],data:"0x",logIndex:3};
 f.state.receipt.logs.push(extra);if(kind==="ERC721 Transfer")await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),NativeDestinationProviderPendingError);else assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});
test("foreign absence classification does not require historical code RPC",async()=>{
 const f=await pureForeignDonation();f.state.getCodeError=true;assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
 f.state.getCodeError=false;assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);assert.equal(f.state.traces,0);
});
test("foreign absence classification accepts an unsupported extra external instruction",async()=>{
 const f=await pureForeignDonation();f.calls.unshift({target:context.token,allowFailure:false,value:0n,callData:encodeFunctionData({abi:erc20Abi,functionName:"balanceOf",args:[RELAY_ROUTER]})});await f.rebuild();
 assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});

// R8 owner-approved D3 cases are intentionally first executed against frozen R7.
function addSignedSwap(f:Awaited<ReturnType<typeof fixture>>){
 f.permit.permitted[0].token="0x5fc5360d0400a0fd4f2af552add042d716f1d168";f.permit.permitted[0].amount=100_000_000n;
 f.calls.unshift({target:f.permit.permitted[0].token,allowFailure:false,value:0n,callData:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[relayer.address,100_000_000n]})},
 {target:relayer.address,allowFailure:false,value:0n,callData:"0xabcdef01"});
}
test("R8 D3 accepts signed USDG approve-swap-cleanup without input/output amount or currency equality",async()=>{
 const f=await fixture();addSignedSwap(f);await f.rebuild();const r=await f.inspect();assert.equal(r.outputAmount,String(amount));assert.equal(r.projectPath,false);
});
test("R8 D3 signed cleanup records actual WETH including dust with full bigint precision",async()=>{
 const f=await fixture();f.state.actualOutput=amount+9007199254740993n;await f.rebuild();assert.equal((await f.inspect()).outputAmount,String(f.state.actualOutput));
});
test("R8 D3 allows extra Router WETH inflow when final signed cleanup payment is unique",async()=>{
 const f=await fixture();f.state.actualOutput=amount+1n;await f.rebuild();const extra=log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),context.token,{from:relayer.address,to:RELAY_ROUTER,value:1n},2,f.state.tx.hash);
 f.state.receipt.logs.splice(2,0,extra);f.state.receipt.logs.forEach((l:any,i:number)=>l.logIndex=i);assert.equal((await f.inspect()).outputAmount,String(amount+1n));
});
test("R8 direct owner root signature without Permit2 witness is not a financial positive",async()=>{const f=await fixture(true);await assert.rejects(f.inspect);});
test("R8 foreign signed two-instruction Router candidate without any solver trace is conclusively negative",async()=>{
 const f=await pureForeignDonation();f.calls.unshift({target:context.token,allowFailure:false,value:0n,callData:encodeFunctionData({abi:erc20Abi,functionName:"balanceOf",args:[RELAY_ROUTER]})});await f.rebuild();
 assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});
test("R8 historical code facts persist and are reused on cold restart beyond ordinary RPC retention",async()=>{
 const f=await fixture();const rows=new Map<string,unknown>();const auditStore={getBuybackBatch:async(id:string)=>rows.get(id)??null,compareAndSetBuybackAudit:async(next:any,expected:any)=>{
  if(JSON.stringify(rows.get(next.id)??null)!==JSON.stringify(expected))return false;rows.set(next.id,structuredClone(next));return true;}};
 await inspectNativeDestinationReceiptStructure(f.client,f.state.tx.hash,metadata,context,{auditStore}as any);assert.equal(rows.size,1);
 const getCode=f.client.getCode;let history=0,latest=0;const cold={...f.client,getCode:async(args:any)=>{if(args.blockNumber===199n||args.blockNumber===200n){history++;throw Error("pruned history");}latest++;return getCode(args);}}as typeof f.client;
 assert.equal((await inspectNativeDestinationReceiptStructure(cold,f.state.tx.hash,metadata,context,{auditStore}as any)).outputAmount,String(amount));assert.equal(history,0);assert.equal(latest,3);
});
for(const name of["before last signed instruction","after cleanup success","movement before Transfer","reordered success sequence"]as const)test(`R8 authenticated final payment window rejects ${name}`,async()=>{
 const f=await fixture();addSignedSwap(f);await f.rebuild();const l=f.state.receipt.logs;
 if(name==="before last signed instruction"){const transfer=l.splice(4,1)[0],movement=l.splice(4,1)[0];l.splice(3,0,transfer,movement);}
 if(name==="after cleanup success"){const success=l.pop();l.splice(4,0,success);}
 if(name==="movement before Transfer"){[l[4],l[5]]=[l[5],l[4]];}
 if(name==="reordered success sequence"){[l[2],l[3]]=[l[3],l[2]];}
 l.forEach((v:any,i:number)=>v.logIndex=i);await assert.rejects(f.inspect,/window|witness/);
});
test("R8 positive fake Transfer emitter is merely an uncertain hint, never owner authentication",async()=>{
 const f=await pureForeignDonation();f.state.receipt.logs.push(log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),relayer.address,{from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,value:1n},3,f.state.tx.hash));
 await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),NativeDestinationProviderPendingError);
});
for(const value of[0n,1n])test(`R8 unrelated emitter Transfer from foreign address amount ${value} remains foreign`,async()=>{
 const f=await pureForeignDonation();f.state.receipt.logs.push(log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),relayer.address,{from:owner.address,to:RELAY_ROUTER,value},3,f.state.tx.hash));
 assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});
test("R8 zero transferFrom solver cannot create a same-tag pending candidate",async()=>{
 const f=await pureForeignDonation();f.state.receipt.logs.push(log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),context.token,{from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,value:0n},3,f.state.tx.hash));
 assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});
function codeFactStore(){
 const rows=new Map<string,any>();let writes=0;
 return{rows,writes:()=>writes,auditStore:{getBuybackBatch:async(id:string)=>structuredClone(rows.get(id)??null),compareAndSetBuybackAudit:async(next:any,expected:any)=>{
  if(JSON.stringify(rows.get(next.id)??null)!==JSON.stringify(expected))return false;rows.set(next.id,structuredClone(next));writes++;return true;}}};
}
const inspectWith=(f:Awaited<ReturnType<typeof fixture>>,auditStore:any)=>inspectNativeDestinationReceiptStructure(f.client,f.state.tx.hash,metadata,context,{auditStore});
function pruneHistory(f:Awaited<ReturnType<typeof fixture>>){const original=f.client.getCode;let history=0,latest=0;
 f.client.getCode=(async(args:any)=>{if(args.blockNumber===199n||args.blockNumber===200n){history++;throw Error("pruned history");}latest++;return original(args);})as any;
 return{history:()=>history,latest:()=>latest};
}
test("R8 code cache stores no funds/calldata/signatures, supports readonly cold consumption, and does not rewrite facts",async()=>{
 const f=await fixture(),s=codeFactStore();await inspectWith(f,s.auditStore);const row=[...s.rows.values()][0],body=JSON.stringify(row);
 assert.match(row.id,/^internal_native_destination_code:0x/);assert.equal(row.protocol,"internal_native_destination_code_v1");assert(!body.includes(f.state.signature));assert(!body.includes(f.state.tx.input));assert(!("outputAmount"in row));
 const counts=pruneHistory(f);const readonly={getBuybackBatch:s.auditStore.getBuybackBatch};assert.equal((await inspectWith(f,readonly)).outputAmount,String(amount));assert.equal(counts.history(),0);assert.equal(counts.latest(),3);assert.equal(s.writes(),1);
});
test("R8 actual Base SQLite facts remain usable after historical pruning through the readonly CLI composition without financial, CAS or lease writes",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"native-signed-readonly-facts-")),source=new Store(join(directory,"base"),8453);
 let peer:Awaited<ReturnType<typeof openVaultLedgerReadOnlyStore>>|undefined;
 try{
  source.saveBuybackBatch({id:"retained-financial-batch",protocol:"splits_native_relay_v1",sourceChainId:8453,destinationChainId:4663,status:"received",marker:"retain-source-evidence"});
  const captured=await fixture();assert.equal((await inspectWith(captured,source)).outputAmount,String(amount));
  const facts=source.listBuybackBatches().filter(row=>row.protocol==="internal_native_destination_code_v1");assert.equal(facts.length,1);
  const before=source.backup(),changesBefore=(source.db.prepare("SELECT total_changes() AS count").get()as{count:number}).count;
  peer=await openVaultLedgerReadOnlyStore(runtimeFromEnv(8453,{CHAIN_MODE:"base",DATA_DIR:directory}));
  let writes=0,leases=0,localReads=0;const canonicalReads:string[]=[];
  const forbidden=new Set(["compareAndSetBuybackAudit","saveBuybackBatch","commitCustodyLedger","commitVaultLedger","savePlan","saveToken","reserveBudget"]);
  const canonical=new Proxy(peer,{get(target,key){
   if(forbidden.has(String(key)))return()=>{writes++;throw Error("Readonly canonical Base cache cannot write");};
   if(String(key).toLowerCase().includes("lease"))return()=>{leases++;throw Error("Readonly canonical Base cache cannot acquire a lease");};
   if(key==="getBuybackBatch")return(id:string)=>{canonicalReads.push(id);return target.getBuybackBatch(id);};
   const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
  const local={getBuybackBatch:async()=>{localReads++;return null;},compareAndSetBuybackAudit:async()=>{writes++;throw Error("Readonly local cache cannot write");},acquireLease:()=>{leases++;throw Error("Readonly local cache cannot acquire a lease");}};
  const auditStore=readonlyBaseAuditOverlay(readonlyCanonicalBaseAuditSource(canonical,local)),cold=await fixture(),counts=pruneHistory(cold);
  assert.equal((await inspectWith(cold,auditStore)).outputAmount,String(amount));
  assert.deepEqual(canonicalReads,[facts[0].id]);assert.equal(localReads,0);assert.equal(counts.history(),0);assert.equal(counts.latest(),3);
  assert.equal(writes,0);assert.equal(leases,0);assert.equal(cold.state.traces,0);assert.deepEqual(source.backup(),before);
  assert.equal((source.db.prepare("SELECT total_changes() AS count").get()as{count:number}).count,changesBefore);
 }finally{await peer?.close();source.close();rmSync(directory,{recursive:true,force:true});}
});
test("R8 historical facts survive an unsupported payment and can later be consumed without historical RPC",async()=>{
 const f=await fixture(),s=codeFactStore(),success=f.state.receipt.logs.pop();await assert.rejects(()=>inspectWith(f,s.auditStore),/witness/);assert.equal(s.rows.size,1);
 f.state.receipt.logs.push(success);const counts=pruneHistory(f);assert.equal((await inspectWith(f,s.auditStore)).outputAmount,String(amount));assert.equal(counts.history(),0);
});
for(const address of[RELAY_ROUTER,RELAY_APPROVAL_PROXY,NATIVE_DESTINATION_PERMIT2])test(`R8 cached historical facts cannot waive latest ${address} upgrade`,async()=>{
 const f=await fixture(),s=codeFactStore();await inspectWith(f,s.auditStore);pruneHistory(f);f.state.changedCode=address;await assert.rejects(()=>inspectWith(f,s.auditStore),/latest/);
});
for(const mutation of["binding","parent","role","scope","protocol"]as const)test(`R8 cached facts reject tampered ${mutation}`,async()=>{
 const f=await fixture(),s=codeFactStore();await inspectWith(f,s.auditStore);const row=[...s.rows.values()][0];
 if(mutation==="binding")row.binding=h(999);if(mutation==="parent")row.parent.hash=h(999);if(mutation==="role")row.facts[0].hash=h(999);if(mutation==="scope")row.destinationChainId=8453;if(mutation==="protocol")row.protocol="lifi_across_weth_v1";
 s.rows.set(row.id,row);pruneHistory(f);await assert.rejects(()=>inspectWith(f,s.auditStore),/pruned/);
});
test("R8 cache cannot waive block reorg, fresh receipt, owner signature or requested tag",async()=>{
 const f=await fixture(),s=codeFactStore();await inspectWith(f,s.auditStore);pruneHistory(f);f.state.reorg=true;await assert.rejects(()=>inspectWith(f,s.auditStore));f.state.reorg=false;
 const original=f.state.receipt.logs;f.state.receipt.logs=original.filter((_:any,i:number)=>i!==2);await assert.rejects(()=>inspectWith(f,s.auditStore));f.state.receipt.logs=original;
 f.permit.nonce++;await f.rebuild(false);await assert.rejects(()=>inspectWith(f,s.auditStore),/signature/);
});
test("R8 code cache CAS contention adopts only the same verified facts and does not discard concurrent canonical reads",async()=>{
 const f=await fixture(),s=codeFactStore();const results=await Promise.all(Array.from({length:4},()=>inspectWith(f,s.auditStore)));
 assert.equal(results.length,4);assert(results.every(r=>r.outputAmount===String(amount)));assert.equal(s.rows.size,1);assert.equal(s.writes(),1);
});
test("R8 optional code cache failure never replaces historical verification",async()=>{
 const f=await fixture();const failed={getBuybackBatch:async()=>null,compareAndSetBuybackAudit:async()=>false};assert.equal((await inspectWith(f,failed)).outputAmount,String(amount));
 assert.equal((await inspectWith(f,{getBuybackBatch:async()=>{throw Error("private store unavailable");}})).outputAmount,String(amount));f.state.getCodeError=true;await assert.rejects(()=>inspectWith(f,codeFactStore().auditStore));
 f.state.getCodeError=false;assert.equal((await inspectWith(f,codeFactStore().auditStore)).outputAmount,String(amount));
});

for(const when of["cache miss","cache hit"]as const)for(const failure of["latest head reorg","latest header missing","latest head RPC","latest chain mismatch"]as const)test(`R8 ${when} rejects ${failure}`,async()=>{
 const f=await fixture(),s=codeFactStore();if(when==="cache hit"){await inspectWith(f,s.auditStore);pruneHistory(f);}
 const original=f.client.getBlock;let latestReads=0;f.client.getBlock=(async(args:any)=>{
  if(args.blockTag==="latest"&&failure==="latest header missing")return{number:null,hash:null};
  if(args.blockNumber===f.state.head){latestReads++;if(failure==="latest head reorg")return{...await original(args),hash:h(999)};
   if(failure==="latest head RPC")throw Error("latest unavailable");if(failure==="latest chain mismatch")f.state.chain=8453;}
  return original(args);
 })as any;
 await assert.rejects(()=>inspectWith(f,s.auditStore));assert(failure==="latest header missing"||latestReads>0);
});
test("R8 latest code queries share a fresh canonical header instead of three unbound latest states",async()=>{
 const f=await fixture(),seen:bigint[]=[];const original=f.client.getCode;f.client.getCode=(async(args:any)=>{if(args.blockNumber===f.state.head)seen.push(args.blockNumber);return original(args);})as any;
 await f.inspect();assert.deepEqual(seen,[f.state.head,f.state.head,f.state.head]);
});

for(const value of[0n,1n])test(`R8 ERC1155 solver quantity ${value} is only a conservative participation hint`,async()=>{
 const f=await pureForeignDonation(),abi=parseAbi(["event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)"]);
 f.state.receipt.logs.push(log(abi[0],relayer.address,{operator:owner.address,from:BASE_NATIVE_RELAY_SOLVER,to:RELAY_ROUTER,id:0n,value},3,f.state.tx.hash));
 if(value>0n)await assert.rejects(()=>nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),NativeDestinationProviderPendingError);else assert.equal(await nativeDestinationHasFixedProvider(f.client,f.state.tx.hash,metadata),false);
});

test("R8 cache read fault with available historical state still validates onsite",async()=>{
 const f=await fixture();assert.equal((await inspectWith(f,{getBuybackBatch:async()=>{throw Error("private unavailable");}})).outputAmount,String(amount));assert(f.state.reads>=13);
});
test("R8 cache write fault does not claim persistence or invalidate independently verified payment",async()=>{
 const f=await fixture();let writes=0;const store={getBuybackBatch:async()=>null,compareAndSetBuybackAudit:async()=>{writes++;throw Error("private write unavailable");}};
 assert.equal((await inspectWith(f,store)).outputAmount,String(amount));assert.equal(writes,1);
});
test("R8 cache read fault plus pruned historical state remains pending, latest code alone is insufficient",async()=>{
 const f=await fixture();pruneHistory(f);await assert.rejects(()=>inspectWith(f,{getBuybackBatch:async()=>{throw Error("private unavailable");}}),/pruned/);
});

// R9 checks use individually coherent signed envelopes so each rejects at its
// named predicate, rather than succeeding because an unrelated guard fires.
test("R9 valid owner and root signatures for a different batch metadata cannot authenticate the requested batch",async()=>{
 const f=await fixture(),otherMetadata=`${h(999)}00`as Hex;f.state.tag=otherMetadata;
 f.cleanup.callData=encodeFunctionData({abi:nativeCleanupErc20Abi,functionName:"cleanupErc20s",args:[[context.token],[context.recipient],[0n],otherMetadata]});
 await f.rebuild();
 assert.equal((await inspectNativeDestinationReceiptStructure(f.client,f.state.tx.hash,otherMetadata,context)).outputAmount,String(amount));
 await assert.rejects(f.inspect,/calldata\/request mismatch/);
});
for(const[address,label]of[[RELAY_ROUTER,"Router"],[RELAY_APPROVAL_PROXY,"ApprovalProxy"],[NATIVE_DESTINATION_PERMIT2,"Permit2"]]as const){
 for(const blockChange of["parent and target","parent only","target only"]as const)test(`R9 ${label} ${blockChange} code differs from pinned latest and cannot authenticate historical execution`,async()=>{
  const f=await fixture(),getCode=f.client.getCode,seen:{block:bigint;code:Hex|undefined}[]=[];
  f.client.getCode=(async(args:any)=>{
   const changed=args.address.toLowerCase()===address.toLowerCase()&&
    (args.blockNumber===199n&&blockChange!=="target only"||args.blockNumber===200n&&blockChange!=="parent only");
   const code=changed?"0x60026000fd"as Hex:await getCode(args);
   if(args.address.toLowerCase()===address.toLowerCase())seen.push({block:args.blockNumber,code});return code;
  })as any;
  await assert.rejects(f.inspect,/historical native destination implementation\/provider/);
  assert.deepEqual(seen.map(value=>value.block),[500n,199n,200n]);assert.equal(seen[0].code,runtime);
  f.client.getCode=getCode;assert.equal((await f.inspect()).outputAmount,String(amount));
 });
}
for(const field of["to","value"]as const)test(`R9 signed instruction success ${field} must equal the corresponding owner-authorized instruction`,async()=>{
 const f=await fixture();f.state.receipt.logs.at(-1).data=encodeAbiParameters(nativeSolverExecutionAbi[0].inputs,[field==="to"?relayer.address:RELAY_ROUTER,f.cleanup.callData,field==="value"?1n:0n]);
 await assert.rejects(f.inspect,/instruction success witnesses mismatch/);
});
test("R9 a second positive solver Transfer of the signed funding token cannot be ignored",async()=>{
 const f=await fixture(),extra=log(erc20Abi.find(i=>i.type==="event"&&i.name==="Transfer"),context.token,{from:owner.address,to:RELAY_ROUTER,value:1n},2,f.state.tx.hash);
 f.state.receipt.logs.splice(2,0,extra);f.state.receipt.logs.forEach((entry:any,index:number)=>entry.logIndex=index);
 await assert.rejects(f.inspect,/owner funding transfer mismatch/);
});
test("R9 owner-signed Permit2 permissions for two assets cannot be truncated to the first witnessed asset",async()=>{
 const f=await fixture();f.permit.permitted.push({token:relayer.address,amount:1n});await f.rebuild();
 // The canonical envelope has a complete payment and funding witness only for
 // the first permission. The additional signed permission must not be ignored.
 await assert.rejects(f.inspect,/Permit2 funding parameters/);
});
test("R9 canonical envelope hash must equal the exact serialized signed root hash",async()=>{
 const f=await fixture(),claimedHash=h(999);f.state.tx.hash=claimedHash;f.state.receipt.transactionHash=claimedHash;
 f.state.receipt.logs.forEach((entry:any)=>entry.transactionHash=claimedHash);
 await assert.rejects(f.inspect,/root signature\/hash mismatch/);
});
test("R9 root recovered sender must match the declared sender even when owner witness binds that declaration",async()=>{
 const f=await fixture();f.state.from=owner.address;await f.rebuild();
 // rebuild signs the root with the relayer and the owner witness with its
 // declared relayer. Every receipt/from field is coherent with the declaration.
 assert.equal(f.state.tx.from,owner.address);assert.equal(f.state.receipt.from,owner.address);
 await assert.rejects(f.inspect,/root signature\/hash mismatch/);
});
test("R9 valid signed and completely witnessed instruction arrays stop at eight instructions",async()=>{
 const f=await fixture(),instruction={target:context.token,allowFailure:false,value:0n,callData:encodeFunctionData({abi:erc20Abi,functionName:"balanceOf",args:[RELAY_ROUTER]})};
 f.calls.unshift(...Array.from({length:7},()=>({...instruction})));await f.rebuild();assert.equal(f.calls.length,8);assert.equal((await f.inspect()).outputAmount,String(amount));
 f.calls.unshift({...instruction});await f.rebuild();assert.equal(f.calls.length,9);await assert.rejects(f.inspect,/calldata\/request mismatch/);
});
