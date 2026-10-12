import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Address } from "viem";
import { monitorKeeperBalance } from "../scripts/keeper-balance-alerts";

const keeper="0x1111111111111111111111111111111111111111" as Address;
const other="0x2222222222222222222222222222222222222222" as Address;
async function fixture(t:TestContext) {
  const directory=await mkdtemp(join(tmpdir(),"keeper-balance-")),path=join(directory,"alerts.jsonl"),outputs:any[]=[];
  t.mock.method(console,"log",(value:string)=>outputs.push(JSON.parse(value)));
  t.mock.method(globalThis,"fetch",async()=>{throw new Error("The monitor must not issue any RPC");});
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const input={path,chainId:8453,keeper,balanceWei:29n,typicalReservationWei:10n,now:1000};
  const alerts=async()=>existsSync(path)?(await readFile(path,"utf8")).trim().split("\n").filter(Boolean).map(row=>JSON.parse(row)):[];
  const state=async()=>JSON.parse(await readFile(`${path}.balance.json`,"utf8"));
  return {directory,path,input,outputs,alerts,state};
}

test("three complete reservations use a strict boundary and zero balance remains a valid low reading",async t=>{
  const f=await fixture(t);
  await monitorKeeperBalance({...f.input,balanceWei:30n});await monitorKeeperBalance({...f.input,balanceWei:31n});
  assert.deepEqual(f.outputs,[]);assert.deepEqual(await f.alerts(),[]);
  await monitorKeeperBalance({...f.input,balanceWei:0n});
  const [alert]=await f.alerts();assert.equal(alert.balanceWei,"0");assert.equal(alert.thresholdWei,"30");
  assert.equal(alert.typicalReservationWei,"10");assert.equal(alert.state,"keeper_balance_low");assert.deepEqual(f.outputs,[alert]);
});
test("one persisted low episode survives a cold import; recovery enables a second notification",async t=>{
  const f=await fixture(t);await monitorKeeperBalance(f.input);await monitorKeeperBalance({...f.input,now:2000});
  const entry=new URL("../scripts/keeper-balance-alerts.ts",import.meta.url);entry.searchParams.set("restart",randomUUID());
  const cold=await import(entry.href) as {monitorKeeperBalance:typeof monitorKeeperBalance};
  await cold.monitorKeeperBalance({...f.input,typicalReservationWei:0n,now:3000});assert.equal((await f.alerts()).length,1);
  await cold.monitorKeeperBalance({...f.input,balanceWei:30n,typicalReservationWei:0n,now:4000});assert.equal((await f.state()).low,false);
  await cold.monitorKeeperBalance({...f.input,balanceWei:29n,typicalReservationWei:0n,now:5000});
  assert.equal((await f.alerts()).length,2);assert.equal(f.outputs.filter(row=>row.state==="keeper_balance_low").length,2);
});
test("idle checks reuse only a positive measured reservation from the same chain and keeper",async t=>{
  const f=await fixture(t);await monitorKeeperBalance({...f.input,balanceWei:0n,typicalReservationWei:0n});
  assert.deepEqual(f.outputs,[]);assert.equal(existsSync(`${f.path}.balance.json`),false);
  await monitorKeeperBalance({...f.input,balanceWei:40n});assert.equal((await f.state()).typicalReservationWei,"10");
  await monitorKeeperBalance({...f.input,balanceWei:29n,typicalReservationWei:0n});assert.equal((await f.alerts()).length,1);
  await monitorKeeperBalance({...f.input,chainId:4663,typicalReservationWei:0n});await monitorKeeperBalance({...f.input,keeper:other,typicalReservationWei:0n});
  assert.equal((await f.alerts()).length,1,"foreign identities cannot supply an idle estimate");
});
test("new real estimates refresh the fallback value without duplicating a still-low episode",async t=>{
  const f=await fixture(t);await monitorKeeperBalance(f.input);
  await monitorKeeperBalance({...f.input,typicalReservationWei:20n});assert.equal((await f.alerts()).length,1);assert.equal((await f.state()).typicalReservationWei,"20");
  await monitorKeeperBalance({...f.input,balanceWei:59n,typicalReservationWei:0n});assert.equal((await f.alerts()).length,1);
  await monitorKeeperBalance({...f.input,balanceWei:60n,typicalReservationWei:0n});
  await monitorKeeperBalance({...f.input,balanceWei:59n,typicalReservationWei:0n});assert.equal((await f.alerts()).length,2);assert.equal((await f.alerts())[1].thresholdWei,"60");
});
test("both chain identities retain their own private state and concurrent task checks share a single notification",async t=>{
  const f=await fixture(t),rhPath=join(f.directory,"rh-alerts.jsonl");
  await Promise.all(Array.from({length:8},()=>monitorKeeperBalance(f.input)));
  await monitorKeeperBalance({...f.input,path:rhPath,chainId:4663});
  assert.equal((await f.alerts()).length,1);assert.equal((await f.state()).chainId,8453);
  assert.equal(JSON.parse(await readFile(`${rhPath}.balance.json`,"utf8")).chainId,4663);
  assert.equal((await stat(f.path)).mode&0o777,0o600);assert.equal((await stat(`${f.path}.balance.json`)).mode&0o777,0o600);
  assert.equal((await stat(rhPath)).mode&0o777,0o600);assert.equal((await stat(`${rhPath}.balance.json`)).mode&0o777,0o600);
  await monitorKeeperBalance({...f.input,chainId:4663,keeper:other});
  assert.equal((await f.alerts()).length,2,"a same-path foreign state does not suppress a new identity");
});
test("an append failure still reaches stdout, never marks delivery and retries from the measured idle cache",async t=>{
  const f=await fixture(t);await mkdir(f.path);
  await assert.doesNotReject(monitorKeeperBalance(f.input));
  assert(f.outputs.some(row=>row.state==="keeper_balance_low"));assert(f.outputs.some(row=>row.state==="keeper_balance_alert_pending"));
  assert.equal((await f.state()).low,false);assert.equal((await f.state()).typicalReservationWei,"10");
  await rm(f.path,{recursive:true});await monitorKeeperBalance({...f.input,typicalReservationWei:0n});
  assert.equal((await f.alerts()).length,1);assert.equal((await f.state()).low,true);
});
test("delivery is appended before its state marker; state IO failure cannot stop work or permanently suppress retry",async t=>{
  const f=await fixture(t);await mkdir(`${f.path}.balance.json`);
  await assert.doesNotReject(monitorKeeperBalance(f.input));
  assert.equal((await f.alerts()).length,1,"the valid alert is written before the failing marker rename");
  assert((await stat(`${f.path}.balance.json`)).isDirectory());assert(f.outputs.some(row=>row.state==="keeper_balance_alert_pending"));
  assert(!(await readdir(f.directory)).some(name=>name.endsWith(".tmp")),"failed state writes clean up their private temporary file");
  await rm(`${f.path}.balance.json`,{recursive:true});await monitorKeeperBalance(f.input);assert.equal((await f.alerts()).length,2);assert.equal((await f.state()).low,true);
});
test("stdout is published before disk work and a stdout failure does not reject financial callers",async t=>{
  const f=await fixture(t);let first=true;
  t.mock.method(console,"log",(value:string)=>{if(first){assert.equal(existsSync(f.path),false);assert.equal(existsSync(`${f.path}.balance.json`),false);first=false;}f.outputs.push(JSON.parse(value));});
  await monitorKeeperBalance(f.input);assert.equal((await f.alerts()).length,1);
  await monitorKeeperBalance({...f.input,balanceWei:30n});t.mock.method(console,"log",()=>{throw new Error("closed stdout");});
  await assert.doesNotReject(monitorKeeperBalance(f.input));assert.equal((await f.alerts()).length,2);
});
test("invalid or absent complete reservations never invent a threshold or use a policy ceiling",async t=>{
  const f=await fixture(t);
  for(const typical of [-1n,0n,undefined,NaN,"10",2n**256n])
    await monitorKeeperBalance({...f.input,typicalReservationWei:typical as bigint});
  for(const balance of [-1n,undefined,NaN,"10",2n**256n])
    await monitorKeeperBalance({...f.input,balanceWei:balance as bigint});
  await monitorKeeperBalance({...f.input,chainId:NaN});await monitorKeeperBalance({...f.input,now:-1});await monitorKeeperBalance({...f.input,keeper:"invalid" as Address});
  assert.deepEqual(f.outputs,[]);assert.deepEqual(await f.alerts(),[]);
});
test("malformed or wrong-identity private observations do not become idle estimates and remain retryable",async t=>{
  const f=await fixture(t);
  for(const state of [{version:1,chainId:8453,keeper,low:true,typicalReservationWei:"0",updatedAt:1},
    {version:1,chainId:8453,keeper,low:true,typicalReservationWei:"10",updatedAt:-1},
    {version:1,chainId:4663,keeper,low:true,typicalReservationWei:"10",updatedAt:1},
    {version:1,chainId:8453,keeper:other,low:true,typicalReservationWei:"10",updatedAt:1}]){
    await writeFile(`${f.path}.balance.json`,JSON.stringify(state));await monitorKeeperBalance({...f.input,typicalReservationWei:0n});
  }
  assert.deepEqual(await f.alerts(),[]);
  await writeFile(`${f.path}.balance.json`,"malformed");await assert.doesNotReject(monitorKeeperBalance(f.input));
  assert.equal((await f.alerts()).length,1);assert.equal((await f.state()).typicalReservationWei,"10");
});
