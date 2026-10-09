import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { type VaultLedgerState, type VaultLedgerEvent, type VaultLedgerCommit, type VaultBaseFillEvidence, vaultEventId } from "../src/lib/buyback-vault-ledger";
import { type CustodyState, type CustodyCommit, type CustodyEvent } from "../src/lib/buyback-custody-ledger";
import type { Address, Hex } from "viem";
const image="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
let available=false;try{execFileSync("docker",["image","inspect",image],{stdio:"ignore"});available=true}catch{}
const addr=(n:number)=>`0x${n.toString(16).padStart(40,"0")}` as Address,hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as Hex;
const block=(n:number)=>({number:String(n),hash:hash(n+100),parentHash:hash(n+99)});
const quote=(value:unknown)=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
test("actual PostgreSQL migrations enforce ledger CAS, full SQLite parity, source proof, RLS and compatible restore",{skip:!available,timeout:60_000},async()=>{
  let container="";const directory=mkdtempSync(join(tmpdir(),"vault-ledger-pg-parity-"));const store=new Store(directory,31337);
  const sql=(source:string)=>execFileSync("docker",["exec","-i",container,"psql","-U","postgres","-X","-t","-A","-v","ON_ERROR_STOP=1"],{encoding:"utf8",input:source,stdio:["pipe","pipe","pipe"]}).trim();
  try{
    container=execFileSync("docker",["run","--detach","--rm","--network","none","--tmpfs","/var/lib/postgresql/data","--env","POSTGRES_HOST_AUTH_METHOD=trust",image,"-c","listen_addresses="],{encoding:"utf8"}).trim();
    execFileSync("docker",["exec",container,"sh","-c","for i in $(seq 1 100); do test \"$(cat /proc/1/comm)\" = postgres && pg_isready -U postgres >/dev/null && exit 0; sleep 0.1; done; exit 1"],{stdio:"pipe"});
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    for(const migration of ["20261005000537_musegod_store.sql","20261007094402_runtime_safety_controls.sql","20261009050807_buyback_vault_ledger.sql","20261009125045_buyback_native_custody_ledger.sql"])sql(readFileSync(`supabase/migrations/${migration}`,"utf8"));
    const custodyState:CustodyState={version:1,id:"robinhood_treasury",chainId:4663,account:addr(20),revision:1,checkpoint:block(0),cursor:block(1),openingBalances:{[addr(21)]:"0"},observedBalances:{[addr(21)]:"1201"},updatedAt:1,blockedReason:null};
    const custodyEvents:CustodyEvent[]=Array.from({length:1201},(_,i)=>({id:vaultEventId(hash(9000+i),i),blockNumber:"1",blockHash:block(1).hash,transactionHash:hash(9000+i),transactionIndex:i,logIndex:i,asset:addr(21),kind:"in",from:addr(22),to:addr(20),amount:"1"}));
    const custodyCommit:CustodyCommit={expectedRevision:0,state:custodyState,blocks:[block(0),block(1)],events:custodyEvents};
    store.commitCustodyLedger(custodyCommit);sql(`SET ROLE service_role;SELECT public.musegod_commit_custody_ledger('robinhood',${quote(custodyCommit)});`);
    assert.throws(()=>sql(`SET ROLE service_role;SELECT public.musegod_commit_custody_ledger('robinhood',${quote(custodyCommit)});`),/revision/);
    assert.throws(()=>sql(`SET ROLE service_role;SELECT public.musegod_commit_custody_ledger('base',${quote(custodyCommit)});`),/another chain/);
    assert.deepEqual(JSON.parse(sql("SET ROLE service_role;SELECT jsonb_agg(payload ORDER BY block_number,transaction_index,log_index) FROM public.musegod_custody_ledger_events WHERE scope='robinhood';").split("\n").at(-1)!),[...store.custodyLedgerEventPage("robinhood_treasury",1000),...store.custodyLedgerEventPage("robinhood_treasury",1000,custodyEvents[999])]);
    for(const role of ["anon","authenticated"]){assert.throws(()=>sql(`SET ROLE ${role};SELECT * FROM public.musegod_custody_ledger_events;`),/permission denied/);assert.throws(()=>sql(`SET ROLE ${role};SELECT public.musegod_commit_custody_ledger('robinhood',${quote(custodyCommit)});`),/permission denied/);}
    const state:VaultLedgerState={version:1,chainId:4663,vault:addr(1),weth:addr(2),swapper:addr(3),revision:1,
      checkpoint:{...block(0),wethBalance:"0",totalSpent:"7",totalBurned:"21",establishedAt:0},cursor:block(1),
      observedBalance:"1201000000000000000000000000",observedTotalSpent:"7",observedTotalBurned:"21",updatedAt:1,blockedReason:null};
    const events:VaultLedgerEvent[]=Array.from({length:1201},(_,i)=>({id:vaultEventId(hash(i+1000),i),blockNumber:"1",blockHash:block(1).hash,
      transactionHash:hash(i+1000),transactionIndex:i,logIndex:i,kind:"weth_in",from:addr(4),to:addr(1),amount:"1000000000000000000000000",source:"unknown"}));
    const commit:VaultLedgerCommit={expectedRevision:0,state,blocks:[block(0),block(1)],events};
    store.commitVaultLedger(commit);
    assert.deepEqual(JSON.parse(sql(`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('robinhood',${quote(commit)});`).split("\n").at(-1)!),state);
    assert.throws(()=>sql(`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('robinhood',${quote(commit)});`),/revision changed/);
    assert.throws(()=>sql(`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('base',${quote(commit)});`),/Robinhood store/);
    const pgEvents=JSON.parse(sql("SET ROLE service_role;SELECT jsonb_agg(payload ORDER BY block_number,transaction_index,log_index) FROM public.musegod_vault_ledger_events WHERE scope='robinhood';").split("\n").at(-1)!);
    const first=store.vaultLedgerEventPage(1000),remaining=store.vaultLedgerEventPage(1000,first.at(-1));
    assert.deepEqual(pgEvents,[...first,...remaining]);assert.equal(pgEvents.length,1201);
    const e=events[0];const evidence:VaultBaseFillEvidence={batchId:"verified-source",sourceChainId:8453,destinationChainId:4663,sourceTransactionHash:hash(5000),sourceBlockHash:hash(5001),depositId:"8",fillTransactionHash:e.transactionHash,fillBlockHash:e.blockHash,fillLogIndex:1,recipient:addr(1),outputToken:addr(2),outputAmount:e.kind==="weth_in"?e.amount:"0",
      destinationImplementation:{address:addr(9),runtimeHash:hash(6000),blockNumber:e.blockNumber,differsFromReviewed:true}};
    const nativeEvidence={protocol:"splits_native_relay_v1",treasury:addr(4),treasuryEventId:e.id,treasuryRevision:1,fragments:[{batchId:"native-canary",amount:e.kind==="weth_in"?e.amount:"0"}],fillTransactionHash:e.transactionHash,fillBlockHash:e.blockHash,fillLogIndex:e.logIndex,recipient:addr(1),outputToken:addr(2),outputAmount:e.kind==="weth_in"?e.amount:"0"};
    assert.equal(sql(`SET ROLE service_role;SELECT public.musegod_validate_vault_base_fill(${quote(e)},${quote(nativeEvidence)},${quote(state)});`).split("\n").at(-1),"t");
    assert.equal(sql(`SET ROLE service_role;SELECT public.musegod_validate_vault_base_fill(${quote(e)},${quote({...nativeEvidence,fragments:[{batchId:"native-canary",amount:"1"}]})},${quote(state)});`).split("\n").at(-1),"f");
    assert.equal(sql(`SET ROLE service_role;SELECT public.musegod_validate_vault_base_fill(${quote(e)},${quote({...nativeEvidence,fragments:[{batchId:null,amount:nativeEvidence.outputAmount}]})},${quote(state)});`).split("\n").at(-1),"f");
    const custodyClassification:CustodyCommit={expectedRevision:1,state:{...custodyState,revision:2},blocks:[],events:[],classifications:[{eventId:custodyEvents[0].id,fragments:[{batchId:"canonical-base",amount:"1"}],evidence:{kind:"native_relay",relay:{version:2,protocol:"splits_native_relay_v1"} as any,sourceRevision:1,sourceEventId:"source:0"}}]};
    store.commitCustodyLedger(custodyClassification);sql(`SET ROLE service_role;SELECT public.musegod_commit_custody_ledger('robinhood',${quote(custodyClassification)});`);
    const reclassified:CustodyCommit={...custodyClassification,expectedRevision:2,state:{...custodyState,revision:3},classifications:[{...custodyClassification.classifications![0],fragments:[{batchId:null,amount:"1"}]}]};
    assert.throws(()=>store.commitCustodyLedger(reclassified),/already verified/);assert.throws(()=>sql(`SET ROLE service_role;SELECT public.musegod_commit_custody_ledger('robinhood',${quote(reclassified)});`),/already verified/);
    reclassified.classifications![0].revalidate=true;store.commitCustodyLedger(reclassified);sql(`SET ROLE service_role;SELECT public.musegod_commit_custody_ledger('robinhood',${quote(reclassified)});`);
    assert.deepEqual(JSON.parse(sql("SET ROLE service_role;SELECT payload FROM public.musegod_custody_ledger_events WHERE scope='robinhood' ORDER BY block_number,transaction_index,log_index LIMIT 1;").split("\n").at(-1)!),store.custodyLedgerEventPage("robinhood_treasury",1)[0]);
    const classified:VaultLedgerCommit={expectedRevision:1,state:{...state,revision:2},blocks:[],events:[],classifications:[{eventId:e.id,source:"base",baseFill:evidence}]};
    store.commitVaultLedger(classified);sql(`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('robinhood',${quote(classified)});`);
    assert.deepEqual(JSON.parse(sql(`SET ROLE service_role;SELECT payload FROM public.musegod_vault_ledger_events WHERE scope='robinhood' AND id='${e.id}';`).split("\n").at(-1)!),store.vaultLedgerEventPage(1)[0]);
    const bad:VaultLedgerCommit={...classified,expectedRevision:2,state:{...state,revision:3},classifications:[{eventId:events[1].id,source:"base",baseFill:evidence}]};
    assert.throws(()=>sql(`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('robinhood',${quote(bad)});`),/fill evidence/);
    for(const implementation of [null,{...evidence.destinationImplementation,blockNumber:"2"},{...evidence.destinationImplementation,differsFromReviewed:"true"}]){
      const other=events[1];
      const invalidImplementation={...classified,expectedRevision:2,state:{...state,revision:3},classifications:[{eventId:other.id,source:"base",baseFill:{...evidence,fillTransactionHash:other.transactionHash,destinationImplementation:implementation}}]} as unknown as VaultLedgerCommit;
      assert.throws(()=>store.commitVaultLedger(invalidImplementation),/historical destination/);
      assert.throws(()=>sql(`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('robinhood',${quote(invalidImplementation)});`),/fill evidence/);
    }
    sql(`SET ROLE service_role;
      SELECT public.musegod_update_runtime_control('robinhood',false,'fixture',0);
      INSERT INTO public.musegod_plans(scope,id,creator,data,prepared_at,payload,protected_at) VALUES('robinhood','plan','creator','data',1,'{}',10);
      INSERT INTO public.musegod_pending_launches(scope,hash,plan_id,status,updated_at,retry_at,attempts,finalized) VALUES('robinhood','tx','plan','confirmed',1,20,3,true);
      SELECT public.musegod_restore('restore-ledger',public.musegod_backup('robinhood'));
      DO $$ BEGIN
       IF (SELECT count(*) FROM public.musegod_custody_ledger_events WHERE scope='restore-ledger')<>1201 THEN RAISE EXCEPTION 'truncated custody restore'; END IF;
       IF (SELECT count(*) FROM public.musegod_vault_ledger_events WHERE scope='restore-ledger')<>1201 THEN RAISE EXCEPTION 'truncated ledger restore'; END IF;
       IF (SELECT protected_at FROM public.musegod_plans WHERE scope='restore-ledger')<>10 THEN RAISE EXCEPTION 'protected plan lost'; END IF;
       IF NOT (SELECT finalized FROM public.musegod_pending_launches WHERE scope='restore-ledger') THEN RAISE EXCEPTION 'queue state lost'; END IF;
       IF (SELECT revision FROM public.musegod_runtime_controls WHERE scope='restore-ledger')<>1 THEN RAISE EXCEPTION 'control revision lost'; END IF;
      END $$;
      SELECT public.musegod_update_runtime_control('verify-preserve-control',true,'preserve fixture',0);
      SELECT public.musegod_restore('verify-preserve-control',public.musegod_backup('robinhood'));
      DO $$ BEGIN IF NOT (SELECT paused FROM public.musegod_runtime_controls WHERE scope='verify-preserve-control') THEN RAISE EXCEPTION 'existing controls overwritten'; END IF; END $$;
      SELECT public.musegod_restore('restore-old','{"version":2}'::jsonb);`);
    assert.throws(()=>sql("SET ROLE service_role;SELECT public.musegod_restore('restore-ledger',public.musegod_backup('robinhood'));"),/not empty/);
    const rollback:VaultLedgerCommit={expectedRevision:2,state:{...state,revision:3,cursor:block(0),observedBalance:"0"},blocks:[],events:[],rollbackAfterBlock:"0"};
    store.commitVaultLedger(rollback);sql(`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('robinhood',${quote(rollback)});`);
    assert.equal(sql("SET ROLE service_role;SELECT count(*) FROM public.musegod_vault_ledger_events WHERE scope='robinhood';").split("\n").at(-1),"0");
    assert.deepEqual(JSON.parse(sql("SET ROLE service_role;SELECT payload FROM public.musegod_vault_ledger_state WHERE scope='robinhood';").split("\n").at(-1)!),store.vaultLedgerState());
    const race:VaultLedgerCommit={expectedRevision:3,state:{...rollback.state,revision:4},blocks:[],events:[]};
    const query=`SET ROLE service_role;SELECT public.musegod_commit_vault_ledger('robinhood',${quote(race)});`;
    const contenders=await Promise.allSettled([0,1].map(()=>promisify(execFile)("docker",["exec",container,"psql","-U","postgres","-X","-t","-A","-v","ON_ERROR_STOP=1","-c",query])));
    assert.equal(contenders.filter(row=>row.status==="fulfilled").length,1,"Only one concurrent writer commits its revision");
    assert.equal(contenders.filter(row=>row.status==="rejected").length,1);
    store.commitVaultLedger(race);
    assert.deepEqual(JSON.parse(sql("SET ROLE service_role;SELECT payload FROM public.musegod_vault_ledger_state WHERE scope='robinhood';").split("\n").at(-1)!),store.vaultLedgerState());
    for(const role of ["anon","authenticated"]){
      assert.throws(()=>sql(`SET ROLE ${role};SELECT * FROM public.musegod_vault_ledger_events;`),/permission denied/);
      assert.throws(()=>sql(`SET ROLE ${role};SELECT public.musegod_commit_vault_ledger('robinhood',${quote(commit)});`),/permission denied/);
      assert.throws(()=>sql(`SET ROLE ${role};SELECT public.musegod_backup('robinhood');`),/permission denied/);
    }
    assert.equal(sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('musegod_vault_ledger_state','musegod_vault_ledger_blocks','musegod_vault_ledger_events');"),"t");
  }finally{store.close();rmSync(directory,{recursive:true,force:true});if(container)try{execFileSync("docker",["rm","-f",container],{stdio:"ignore"})}catch{}}
});
