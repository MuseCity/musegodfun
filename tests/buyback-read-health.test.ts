import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { LaunchpadService, PoolIdentityError } from "../server/service";
import { BuybackEngineReader, FeePreviewReadError, feePreviewFailure } from "../server/buyback-engine";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { ENGINE_FEE_POLICY } from "../src/lib/fee-policy";
import { computePoolId } from "@whetstone-research/doppler-sdk/evm";

const coin=getAddress("0x1111111111111111111111111111111111111111"),engine=getAddress("0x2222222222222222222222222222222222222222");
const quote=ROBINHOOD_STOCKS.find(asset=>asset.symbol==="WETH")!;
function previewFixture() {
  const token={address:coin,symbol:"MV2C",quoteAddress:quote.address,poolId:`0x${"ab".repeat(32)}`,feePolicy:ENGINE_FEE_POLICY,feeEngine:engine};
  return {
    poolState:async()=>({token,state:{poolKey:{currency0:coin,currency1:quote.address}},pool:{getPendingFees:async()=>({fees0:0n,fees1:12n})}}),
    contracts:{rehype:engine},
    sdk:{getMulticurvePool:async()=>{throw new Error("The verified pool must be reused");},
      getRehypeDopplerHookInitializer:async()=>({getPendingFees:async()=>({fees0:0n,fees1:0n})})},
  };
}
test("pending preview keeps true hook zero and reports an LP failure instead of fabricating LP zero",async()=>{
  const service=previewFixture();
  const state=service.poolState;
  service.poolState=async()=>({...await state(),pool:{getPendingFees:async()=>{throw Object.assign(new Error("HTTP request failed https://private.invalid/secret"),{cause:new Error("429 rate limited")});}}});
  const rows=await LaunchpadService.prototype.engineClaimPreview.call(service as any,coin,engine);
  assert.equal(rows.length,2);
  for(const row of rows){assert.equal(row.lp,null);assert.equal(row.hook,"0");assert.match(row.lpError!,/LP preview unavailable: RPC rate limit/);assert.equal(row.hookError,undefined);}
  assert.doesNotMatch(JSON.stringify(rows),/private.invalid|secret/);
});
test("a budget-failed LP preview retries with the verified pool and clears its errors after recovery",async()=>{
  const service=previewFixture(), state=service.poolState;
  let failures=true,reads=0;
  service.poolState=async()=>({...await state(),pool:{getPendingFees:async()=>{
    reads++;if(failures)throw new Error("Too many API requests by single worker invocation.");
    return {fees0:7n,fees1:11n};
  }}});
  const failed=await LaunchpadService.prototype.engineClaimPreview.call(service as any,coin,engine);
  assert.deepEqual(failed.map(row=>row.lp),[null,null]);
  assert.deepEqual(failed.map(row=>row.hook),["0","0"]);
  assert(failed.every(row=>row.lpError?.includes("runtime request budget exceeded")));
  failures=false;
  const recovered=await LaunchpadService.prototype.engineClaimPreview.call(service as any,coin,engine);
  assert.equal(reads,2);assert.deepEqual(recovered.map(row=>row.lp),["7","11"]);
  assert.deepEqual(recovered.map(row=>row.hook),["0","0"]);
  assert(recovered.every(row=>row.lpError===undefined&&row.hookError===undefined));
});
test("pending preview preserves usable LP values when hook setup fails",async()=>{
  const service=previewFixture();service.sdk.getRehypeDopplerHookInitializer=async()=>{throw new Error("request timed out");};
  const rows=await LaunchpadService.prototype.engineClaimPreview.call(service as any,coin,engine);
  assert.deepEqual(rows.map(row=>row.lp),["0","12"]);
  for(const row of rows){assert.equal(row.hook,null);assert.match(row.hookError!,/Hook preview unavailable: RPC timeout/);assert.equal(row.lpError,undefined);}
});
test("catalog records remove the duplicate store read without skipping live pool identity checks",async()=>{
  const state={status:2,numeraire:quote.address,poolKey:{currency0:coin,currency1:quote.address,fee:0x800000,tickSpacing:10,hooks:engine}};
  const record={address:coin,symbol:"MV2C",mode:"robinhood",transactionHash:`0x${"11".repeat(32)}`,quoteAddress:quote.address,poolId:computePoolId(state.poolKey),feePolicy:ENGINE_FEE_POLICY,feeEngine:engine};
  let storeReads=0,stateReads=0;
  const fixture:any={runtime:{config:{mode:"robinhood",chainId:4663}},assertNetwork:async()=>{},
    token:async()=>{storeReads++;return record;},contracts:{rehype:engine},
    sdk:{getMulticurvePool:async()=>({getState:async()=>{stateReads++;return state;},getPendingFees:async()=>({fees0:7n,fees1:11n})}),
      getRehypeDopplerHookInitializer:async()=>({getPendingFees:async()=>({fees0:0n,fees1:0n})})}};
  fixture.poolState=(address:any,token:any)=>(LaunchpadService.prototype as any).poolState.call(fixture,address,token);
  const optimized=await LaunchpadService.prototype.engineClaimPreview.call(fixture,coin,engine,record as any);
  assert.equal(storeReads,0);assert.equal(stateReads,1);
  const ordinary=await LaunchpadService.prototype.engineClaimPreview.call(fixture,coin,engine);
  assert.equal(storeReads,1);assert.equal(stateReads,2);assert.deepEqual(optimized,ordinary);
  await assert.rejects(()=>LaunchpadService.prototype.engineClaimPreview.call(fixture,coin,engine,{...record,mode:"base"} as any),PoolIdentityError);
  await assert.rejects(()=>LaunchpadService.prototype.engineClaimPreview.call(fixture,coin,engine,{...record,poolId:`0x${"ab".repeat(32)}`} as any),FeePreviewReadError);
  assert.equal(storeReads,1);assert.equal(stateReads,3);
});
test("pool identity and unavailable state remain failed previews with safe diagnostic stages",async()=>{
  const service=previewFixture();service.poolState=async()=>{throw new PoolIdentityError("The pool identity or locked state is invalid");};
  await assert.rejects(()=>LaunchpadService.prototype.engineClaimPreview.call(service as any,coin,engine),error=>{
    assert(error instanceof FeePreviewReadError);assert.match(error.message,/Pool state unavailable: pool identity/);return true;
  });
  const safe=feePreviewFailure(new FeePreviewReadError("Pool state",new Error("timeout with key=secret")),"Pending-fee preview");
  assert.match(safe,/^Pool state unavailable: RPC timeout/);assert.doesNotMatch(safe,/secret/);
  assert.match(feePreviewFailure({cause:{code:-32005}},"LP preview"),/rate limit/);
});
test("runtime request-budget and I/O-context failures have distinct fixed safe categories",()=>{
  for(const message of ["Too many subrequests.","Too many API requests by single worker invocation."]){
    const error=new Error("HTTP request failed at https://private.invalid/secret",{cause:new Error(message)});
    assert.equal(feePreviewFailure(error,"LP preview"),"LP preview unavailable: runtime request budget exceeded. No zero balance is assumed.");
  }
  for(const message of ["Cannot perform I/O on behalf of a different request.","I/O objects from a different Durable Object cannot be used here."]){
    assert.equal(feePreviewFailure(new Error(message+" https://private.invalid/secret"),"LP preview"),"LP preview unavailable: runtime I/O context mismatch. No zero balance is assumed.");
  }
});
test("SDK pending-fee subcall, checkpoint and aggregate failures remain distinguishable without raw diagnostics",()=>{
  for(const name of ["collectFees","getShares","getCumulatedFees0","getCumulatedFees1","getLastCumulatedFees0","getLastCumulatedFees1"]){
    const error=new Error("Provider failed https://private.invalid/secret",{cause:new Error(`${name} call failed`)});
    assert.equal(feePreviewFailure(error,"LP preview"),`LP preview unavailable: ${name} fee-preview subcall failed. No zero balance is assumed.`);
  }
  assert.equal(feePreviewFailure(new Error("Accumulated fees are below beneficiary checkpoint"),"LP preview"),"LP preview unavailable: pending-fee counters below beneficiary checkpoint. No zero balance is assumed.");
  for(const result of ["pool result","initializer discovery result","pending fee breakdown result"]){
    assert.equal(feePreviewFailure(new Error(`Multicall3 aggregate3 returned an incomplete ${result}`),"LP preview"),"LP preview unavailable: incomplete fee-preview aggregate response. No zero balance is assumed.");
  }
  assert.equal(feePreviewFailure(new Error("unknownFunction call failed https://private.invalid/secret"),"LP preview"),"LP preview unavailable: upstream read unavailable. No zero balance is assumed.");
});
test("engine cache retains its sample time and failures never inherit a successful checkedAt or zero balances",async t=>{
  let now=1000,reads=0,failure=false;t.mock.method(Date,"now",()=>now);
  const reader=new BuybackEngineReader({} as any,async()=>({} as any),async()=>[],async()=>[]);
  // Isolate status caching from contract-graph verification, covered by buyback-engine.test.ts.
  (reader as any).readFresh=async()=>{reads++;if(failure)throw new Error("private RPC URL");return {available:true,blockNumber:String(reads),assets:[],pools:[]};};
  const first=await reader.read();assert.equal(first.checkedAt,1000);assert.equal(first.cacheExpiresAt,121000);
  assert.match(first.readId!,/^[a-f0-9-]{36}$/);
  now+=119999;assert.equal((await reader.read()).checkedAt,1000);assert.equal(reads,1);
  assert.equal((await reader.read()).readId,first.readId);
  now++;const next=await reader.read();assert.equal(next.blockNumber,"2");assert.equal(next.checkedAt,121000);
  assert.notEqual(next.readId,first.readId);
  now+=120000;failure=true;const failed=await reader.read();
  assert.equal(failed.available,false);assert.equal(failed.checkedAt,undefined);assert.equal(failed.blockNumber,null);assert.equal(failed.vaultWeth,undefined);
  assert.match(failed.readId!,/^[a-f0-9-]{36}$/);assert.notEqual(failed.readId,next.readId);
  assert.equal(failed.sourceWeth,null);assert.equal(failed.swapperWeth,null);assert.equal(failed.cacheExpiresAt,301000);
});
test("concurrent readers share the diagnostic id of the same in-flight snapshot",async()=>{
  let release!:()=>void,reads=0;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const reader=new BuybackEngineReader({} as any,async()=>({} as any),async()=>[],async()=>[]);
  (reader as any).readFresh=async()=>{reads++;await pending;return {available:true,blockNumber:"7",assets:[],pools:[]};};
  const first=reader.read(),second=reader.read();release();
  const [a,b]=await Promise.all([first,second]);assert.equal(reads,1);assert.equal(a.readId,b.readId);
  assert.equal((await reader.read()).readId,a.readId);
});
