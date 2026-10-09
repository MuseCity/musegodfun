import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createDualChainApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { BaseFeeQuoteReader } from "../server/base-buyback";
import { emptyVaultLedgerReport } from "../src/lib/buyback-vault-ledger";
const treasury="0xc4F87C3715374445C4657aa14c47CBB339b59d1A",collector="0x1111111111111111111111111111111111111111";

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),"base-integration-"));
  const environment={CHAIN_MODE:"base",DATA_DIR:directory,BASE_PLATFORM_TREASURY:treasury,ROBINHOOD_PLATFORM_TREASURY:treasury,
    BASE_FEE_COLLECTOR_ADDRESS:collector,ENABLE_BASE_TRANSACTIONS:"true",NODE_ENV:"development",SUPABASE_DATA_SCOPE:"verify-base-canary"};
  const base=runtimeFromEnv(8453,environment),rh=runtimeFromEnv(4663,environment);
  // The private launch scope label is copied here deliberately. It cannot serve as an owner authorization.
  base.dataScope="verify-base-canary";
  const {app,services}=createDualChainApp(undefined,"loopback",[base,rh]);
  const baseService=services.get(8453)!;
  Object.assign(baseService,{client:{getChainId:async()=>8453}});
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const origin=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;
  return{origin,services,base,async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));for(const service of services.values()){await service.vaultLedgerRuntime?.close();await service.store.close()}rmSync(directory,{recursive:true,force:true})}};
}
test("a copied canary scope and enabled flag cannot activate a pending Collector or expose RH signing targets",async()=>{
  const f=await fixture();try{
    const response=await fetch(`${f.origin}/api/chains/8453/config`),config=await response.json();assert.equal(response.status,200);
    assert.equal(config.writesEnabled,false);assert.equal(config.feeEngine,null);
    for(const field of ["buybackVault","buybackExecutor","assetFeedOracle","wethForwarder","automationTreasury","automationReceiver"])assert.equal(config[field],null,field);
    assert.match(config.blockReason,/Base issuance awaits|Awaiting runtime activation/);
  }finally{await f.close()}
});
test("Base quote and manual authorization API endpoints remain retired before accepting arbitrary calldata",async()=>{
  const f=await fixture();try{
    for(const route of ["/buyback/engine/quote","/buyback/quote","/buyback/batches"]){
      const response=await fetch(`${f.origin}/api/chains/8453${route}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({calldata:"0x1234",token:collector,amount:"1",caller:treasury})});
      assert.equal(response.status,410,route);assert.match((await response.json()).error,/Splits native Automation|retired/);
    }
  }finally{await f.close()}
});
test("Base fee status reports unavailable FIFO evidence as zero withheld attribution rather than shared global burns",async()=>{
  const f=await fixture();try{
    const response=await fetch(`${f.origin}/api/chains/8453/buyback/engine`),status=await response.json();assert.equal(response.status,200);
    assert.equal(status.kind,"base_splits_native");assert.equal(status.chainId,8453);assert.equal(status.destinationChainId,4663);
    assert.equal(status.nativeAutomationState,"unverified");assert.equal(status.automation,null);
    assert.equal(status.available,false);assert.equal(status.ledgerComplete,false);assert.equal(status.vaultLedger.attributionReady,false);
    assert.equal(status.vaultLedger.baseAttributedMuseToDead,"0");assert.equal(status.vaultLedger.basePendingWeth,"0");
    assert.equal("vaultBurned"in status,false,"RH Vault's total burns cannot masquerade as a Base amount");
    assert.equal("signed"in(status.batches[0]??{}),false,"Public fee status never publishes quote signatures");
  }finally{await f.close()}
});

test("Base engine completeness requires source/Treasury readiness and a caught-up Vault independently", async () => {
  const original = BaseFeeQuoteReader.prototype.status;
  let sourceReady = false;
  BaseFeeQuoteReader.prototype.status = async function() {
    return { kind: "base_splits_native", protocol: "splits_native_relay_v1", chainId: 8453, available: true, collector: null, automation: null,
      destinationChainId: 4663, destinationTreasury: treasury, destinationVault: collector, paused: false, nativeAutomationState: "configured",
      totalBridgedWeth: "0", totalRefundedWeth: "0", assets: [], assetsComplete: true, batches: [], ledgerComplete: sourceReady, error: undefined };
  };
  const f = await fixture();
  try {
    const ledger = { ...emptyVaultLedgerReport(100n), attributionReady: true, caughtUp: true, baseAttributedMuseToDead: "10" };
    f.services.get(8453)!.vaultLedgerRuntime!.read = async () => ledger;
    const read = async () => (await fetch(`${f.origin}/api/chains/8453/buyback/engine`)).json();
    assert.equal((await read()).ledgerComplete, false, "A verified Vault cannot hide unavailable source/Treasury evidence");
    sourceReady = true; ledger.caughtUp = false;
    const stale = await read(); assert.equal(stale.ledgerComplete, false); assert.equal(stale.vaultLedger.baseAttributedMuseToDead, "10", "Verified indexed history remains visible with its lag");
    ledger.caughtUp = true; assert.equal((await read()).ledgerComplete, true);
  } finally { BaseFeeQuoteReader.prototype.status = original; await f.close(); }
});
