import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RobinhoodBuybackSummaryReader } from "../server/buyback";
import { BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT } from "../src/lib/base-buyback";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";

function fixture() {
  let calls=0,headers=0;
  const amounts=[1n,2n,1000000000000000000123456789n,26652000000000000000000n,30000000000000000000000n,1000000000000000000000000n];
  const client={getBlockNumber:async()=>{headers++;return 99n;},multicall:async({contracts,blockNumber,batchSize}:any)=>{
    calls++;assert.equal(blockNumber,99n);assert(batchSize>=65536);assert.equal(contracts.length,6);
    assert.equal(contracts[0].args[0],BASE_BUYBACK_TREASURY);assert.equal(contracts[2].address,BASE_BUYBACK_VAULT);
    assert.equal(contracts[2].functionName,"totalSpent");assert.equal(contracts[3].functionName,"totalBurned");
    assert.equal(contracts[4].address,MUSEGOD_BUYBACK.tokenAddress);assert.equal(contracts[4].args[0],MUSEGOD_BUYBACK.burnAddress);
    return amounts.map(result=>({status:"success",result}));
  },getLogs:async()=>{throw Error("Summary must not scan transfers")},getCode:async()=>{throw Error("Summary must not repeat code validation")},
  getChainId:async()=>{throw Error("Summary must not repeat startup chain checks")}};
  return {client,amounts,metrics:()=>({calls,headers})};
}
test("Robinhood summary reports exact shared counters and global dead balance without Base attribution",async()=>{
  const f=fixture(),value=await new RobinhoodBuybackSummaryReader(f.client as any,()=>1000).read();
  assert.equal(value.available,true);assert.equal(value.scope,"shared_robinhood");assert.equal(value.chainId,4663);
  assert.equal(value.vaultSpentWeth,String(f.amounts[2]));assert.equal(value.vaultMuseToDead,String(f.amounts[3]));
  assert.equal(value.deadTotalMuse,String(f.amounts[4]));assert.equal(value.totalSupply,String(f.amounts[5]));
  assert.equal("baseAttributedMuseToDead" in value,false);assert.deepEqual(f.metrics(),{calls:1,headers:1});
});
test("shared summary singleflight and five-minute cache retain amounts and observation time",async()=>{
  let now=1000;const f=fixture(),reader=new RobinhoodBuybackSummaryReader(f.client as any,()=>now);
  const values=await Promise.all(Array.from({length:8},()=>reader.read()));assert.equal(values.every(value=>value.checkedAt===1000),true);
  assert.deepEqual(f.metrics(),{calls:1,headers:1});values[0].deadTotalMuse="1";assert.equal((await reader.read()).deadTotalMuse,String(f.amounts[4]));
  now+=299999;await reader.read();assert.deepEqual(f.metrics(),{calls:1,headers:1});now++;await reader.read();assert.deepEqual(f.metrics(),{calls:2,headers:2});
});
test("unavailable shared counters remain unknown and prior values are explicitly stale",async()=>{
  let now=1000;const f=fixture(),reader=new RobinhoodBuybackSummaryReader(f.client as any,()=>now);await reader.read();
  f.client.multicall=async()=>{throw Error("provider secret key")};now+=300000;const value=await reader.read();
  assert.equal(value.stale,true);assert.equal(value.checkedAt,1000);assert.equal(value.deadTotalMuse,String(f.amounts[4]));assert(!JSON.stringify(value).includes("provider secret"));
  const unavailable=await new RobinhoodBuybackSummaryReader(f.client as any,()=>now).read();assert.equal(unavailable.available,false);assert.equal(unavailable.deadTotalMuse,null);assert.equal(unavailable.vaultSpentWeth,null);
});
test("impossible global balances never become a successful summary",async()=>{
  const f=fixture();f.amounts[4]=f.amounts[5]+1n;const value=await new RobinhoodBuybackSummaryReader(f.client as any).read();assert.equal(value.available,false);assert.equal(value.deadTotalMuse,null);
});
test("Base and Robinhood buyback pages contain aggregate copy rather than ongoing attribution",()=>{
  const base=readFileSync(new URL("../src/components/BaseBuyback.tsx",import.meta.url),"utf8"),engine=readFileSync(new URL("../src/components/BuybackEngine.tsx",import.meta.url),"utf8");
  for(const source of [base,engine])assert.doesNotMatch(source,/FIFO|vaultLedger|burnIndexCaughtUp|baseAttributedMuseToDead|totalBridgedWeth/);
  assert.match(base,/not a Base-only burn figure/);assert.match(base,/unclassified recovered/);assert.match(engine,/all sources/);
  const app=readFileSync(new URL("../server/app.ts",import.meta.url),"utf8");assert.doesNotMatch(app,/buyback-vault-runtime|buyback-audit-snapshot|readBaseAuditSnapshot|financialRead/);
});
