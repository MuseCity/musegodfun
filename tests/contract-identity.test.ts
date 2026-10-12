import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { contractIdentityOnce, type ContractIdentityStore } from "../server/contract-identity";

const code = `0x${"a".repeat(64)}`;
const binding = { chainId: 4663, address: "0x1111111111111111111111111111111111111111", runtimeHash: code };
const validate = (value: unknown) => !!value && typeof value === "object" && (value as {runtimeHash?:string}).runtimeHash === code;

test("identity seals use the existing private SQLite CAS and survive a store/client restart", async () => {
  const directory = mkdtempSync(join(tmpdir(),"contract-identity-"));
  let store = new Store(directory,31337), checks = 0;
  try {
    const initial = await contractIdentityOnce({}, {namespace:"startup",binding,store,validate,verify:async()=>{checks++;return {runtimeHash:code};}});
    assert.deepEqual(initial,{runtimeHash:code});
    const records = store.db.prepare("SELECT payload FROM buyback_batches").all() as {payload:string}[];
    assert.equal(records.length,1);
    const saved = JSON.parse(records[0].payload);
    assert.match(saved.id,/^internal_native_contract_identity_v1:0x[0-9a-f]{64}$/);
    assert.equal(saved.status,"verified");
    store.close(); store = new Store(directory,31337);
    const restored = await contractIdentityOnce({}, {namespace:"startup",binding,store,validate,verify:async()=>{throw new Error("Old state is unavailable");}});
    assert.deepEqual(restored,initial); assert.equal(checks,1);
    await assert.rejects(contractIdentityOnce({}, {namespace:"startup",binding:{...binding,runtimeHash:`0x${"b".repeat(64)}`},store,validate,verify:async()=>{throw new Error("Changed deployment needs verification");}}),/Changed deployment/);
    await assert.rejects(contractIdentityOnce({}, {namespace:"other",binding,store,validate,verify:async()=>{throw new Error("Different identity namespace");}}),/Different identity/);
  } finally {store.close();rmSync(directory,{recursive:true});}
});

test("concurrent identity checks share one verification and return isolated values", async () => {
  const client={},calls: number[]=[];
  const request=()=>contractIdentityOnce(client,{namespace:"parallel",binding,validate,verify:async()=>{calls.push(1);await new Promise<void>(resolve=>setImmediate(resolve));return {runtimeHash:code};}});
  const [a,b]=await Promise.all([request(),request()]);
  assert.equal(calls.length,1);a.runtimeHash="mutated";assert.equal(b.runtimeHash,code);
  assert.equal((await request()).runtimeHash,code);
});

test("failed verification is retryable and is never sealed", async () => {
  const client={};let calls=0;
  const request=()=>contractIdentityOnce(client,{namespace:"retry",binding,validate,verify:async()=>{if(++calls===1)throw new Error("RPC 429");return {runtimeHash:code};}});
  await assert.rejects(request(),/RPC 429/);
  assert.equal((await request()).runtimeHash,code);assert.equal(calls,2);
});

test("corrupt durable identity cannot skip verification, while a valid racing CAS winner is accepted", async () => {
  const directory=mkdtempSync(join(tmpdir(),"identity-corrupt-"));let store=new Store(directory,31337);
  try {
    await contractIdentityOnce({}, {namespace:"corrupt",binding,store,validate,verify:async()=>({runtimeHash:code})});
    const row=JSON.parse((store.db.prepare("SELECT payload FROM buyback_batches").get() as {payload:string}).payload);
    row.value.runtimeHash=`0x${"b".repeat(64)}`;
    store.db.prepare("UPDATE buyback_batches SET payload=? WHERE id=?").run(JSON.stringify(row),row.id);
    store.close();store=new Store(directory,31337);
    await assert.rejects(contractIdentityOnce({}, {namespace:"corrupt",binding,store,validate,verify:async()=>{throw new Error("Must check corrupt seal");}}),/Must check corrupt seal/);
    const racingStore:ContractIdentityStore={getBuybackBatch:id=>store.getBuybackBatch(id),compareAndSetBuybackAudit:async(next,previous)=>{store.compareAndSetBuybackAudit(next,previous);return false;}};
    assert.equal((await contractIdentityOnce({}, {namespace:"race",binding,store:racingStore,validate,verify:async()=>({runtimeHash:code})})).runtimeHash,code);
  } finally {store.close();rmSync(directory,{recursive:true});}
});

test("failed audit CAS remains retryable and never authorizes an unchecked winner", async () => {
  const store:ContractIdentityStore={getBuybackBatch:async()=>null,compareAndSetBuybackAudit:async()=>false};let attempts=0;
  const request=()=>contractIdentityOnce({}, {namespace:"cas",binding,store,validate,verify:async()=>{attempts++;return {runtimeHash:code};}});
  await assert.rejects(request(),/record changed/);await assert.rejects(request(),/record changed/);assert.equal(attempts,2);
});
