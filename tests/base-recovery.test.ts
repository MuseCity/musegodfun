import test from "node:test";
import assert from "node:assert/strict";
import { BuybackBatchService } from "../server/buyback-batches";
import { BuybackReader } from "../server/buyback";
import { baseCanaryRuntimes } from "../scripts/base-canary-server";
import type { RuntimeEnvironment } from "../server/config";
const treasury = "0x2222222222222222222222222222222222222222", to = "0x3333333333333333333333333333333333333333";
const hash = `0x${"aa".repeat(32)}`;
test("submitted Relay requests preserve original nonce/calldata/expiry for review without new preparation", async () => {
  const step = { batchId: hash, kind: "deposit", chainId:8453, from:treasury,to,data:"0x1234",value:"0",amount:"10",stockAddress:to,expiresAt:1,nonce:7 };
  const record = { id:hash,quote:{stockAddress:to},steps:{deposit:step},hashes:{deposit:hash} };
  const base = {getChainId:async()=>8453,getTransaction:async()=>({from:treasury,to,input:"0x1234",value:0n,nonce:7})};
  const service = new BuybackBatchService(new BuybackReader(treasury),{getBuybackBatch:async()=>record,listBuybackBatches:async()=>[],saveBuybackBatch:()=>{throw new Error("Review cannot write");}},base as any,
    {mode:"base",chainId:8453,treasury,writesEnabled:false,blockReason:"paused"});
  const restored = await service.submittedStep(hash,"deposit");
  assert.equal(restored.recoveryOnly,true);assert.equal(restored.originalHash,hash);assert.equal(restored.nonce,7);assert.equal(restored.expiresAt,1);
  base.getTransaction=async()=>({from:treasury,to,input:"0xbeef",value:0n,nonce:7});
  await assert.rejects(()=>service.submittedStep(hash,"deposit"),/does not match/);
});
test("private canary startup explicitly separates its control scope from readonly RH authority", () => {
  const environment:RuntimeEnvironment={NODE_ENV:"canary",CHAIN_MODE:"base",SUPABASE_DATA_SCOPE:"verify-base-canary",DATA_DIR:".cache/private-canary",SUPABASE_URL:"https://example.supabase.co",SUPABASE_SECRET_KEY:"fixture",BASE_RPC_URL:"https://rpc.invalid",ROBINHOOD_RPC_URL:"https://rpc.invalid"};
  const [rh,base]=baseCanaryRuntimes(environment,"https://base-canary.example");
  assert.equal(base.dataScope,"verify-base-canary");assert.equal(rh.dataScope,"robinhood");assert.equal(rh.config.writesEnabled,false);
  assert.notEqual(base.dataDir,rh.dataDir);
  for(const changed of [{NODE_ENV:"production"},{SUPABASE_DATA_SCOPE:"base"},{DATA_DIR:""},{SUPABASE_SECRET_KEY:""}])assert.throws(()=>baseCanaryRuntimes({...environment,...changed},"https://base-canary.example"),/Canary serving requires/);
});

test("canary origin must be isolated and explicit",()=>{
 const environment:RuntimeEnvironment={NODE_ENV:"canary",CHAIN_MODE:"base",SUPABASE_DATA_SCOPE:"verify-base-canary",DATA_DIR:".cache/private-canary",SUPABASE_URL:"https://example.supabase.co",SUPABASE_SECRET_KEY:"fixture",BASE_RPC_URL:"https://rpc.invalid",ROBINHOOD_RPC_URL:"https://rpc.invalid"};
 for(const origin of ["", "https://musegod.fun", "https://www.musegod.fun", "http://base-canary.example"])assert.throws(()=>baseCanaryRuntimes(environment,origin),/origin|HTTPS|Canary/);
});
