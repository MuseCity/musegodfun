import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type BuybackBatchRecord } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";

test("internal audit CAS prevents late lower progress across SQLite clients and preserves exact JSON expectations",()=>{
 const directory=mkdtempSync(join(tmpdir(),"buyback-audit-cas-")),first=new Store(directory,31337),second=new Store(directory,31337),restored=new Store(join(directory,"restored"),31337);
 const initial={id:"internal_native_releases:fixture",protocol:"internal_native_base_audit_v1",through:"0",entries:[],nested:{a:1,b:2}},high={...initial,through:"100",entries:["canonical-owner-release"]},low={...initial,through:"50"};
 try{
  assert.equal(first.compareAndSetBuybackAudit(initial,null),true);assert.equal(second.compareAndSetBuybackAudit(initial,null),false);
  const stale=second.getBuybackBatch(initial.id)!;assert.equal(first.compareAndSetBuybackAudit(high,{nested:{b:2,a:1},entries:[],through:"0",protocol:initial.protocol,id:initial.id}),true,"Object key order has the same meaning as PostgreSQL JSONB");
  assert.equal(second.compareAndSetBuybackAudit(low,stale),false);assert.deepEqual(second.getBuybackBatch(initial.id),high);
  assert.equal(first.compareAndSetBuybackAudit(low,{...high,nested:{a:1,b:999}}),false,"Expectations compare the complete nested payload");
  assert.throws(()=>first.compareAndSetBuybackAudit({id:"financial-batch",protocol:"splits_native_relay_v1"},null),/internal native/);assert.throws(()=>first.compareAndSetBuybackAudit(high,0 as any),/audit metadata/);
  restored.restore(first.backup());assert.deepEqual(restored.getBuybackBatch(initial.id),high);assert.equal(restored.compareAndSetBuybackAudit({...high,through:"101"},high),true);
 }finally{restored.close();second.close();first.close();rmSync(directory,{recursive:true,force:true});}
});

test("Supabase audit CAS is a scoped typed RPC and never uses the financial upsert",async(t)=>{
 const calls:any[]=[],next={id:"internal_native_modules:fixture",protocol:"internal_native_base_audit_v1",through:"0",entries:[]};let response:unknown=true;
 t.mock.method(globalThis,"fetch",async(url:string,init:RequestInit)=>{calls.push({url,method:init.method,body:JSON.parse(init.body as string)});return Response.json(response);});
 const store=new SupabaseStore("https://fixture.supabase.co","local-test-only","verify-audit-cas");
 assert.equal(await store.compareAndSetBuybackAudit(next,null),true);assert.match(calls[0].url,/rpc\/musegod_compare_and_set_buyback_audit$/);assert.deepEqual(calls[0].body,{p_scope:"verify-audit-cas",p_next:next,p_expected:null});assert.equal(calls[0].method,"POST");
 response=false;assert.equal(await store.compareAndSetBuybackAudit({...next,through:"5"},next),false);response={success:true};await assert.rejects(()=>store.compareAndSetBuybackAudit(next,next),/invalid result/);
 await assert.rejects(()=>store.compareAndSetBuybackAudit({...next,id:"ordinary-financial-id"},null),/internal native/);assert.equal(calls.length,3);
});

test("buyback receipts preserve exact amounts across upsert, restart and snapshot cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-buyback-store-"));
  let store: Store | undefined;
  try {
    store = new Store(directory, 31337);
    const batch: BuybackBatchRecord = {
      id: "batch-1",
      status: "pending",
      amountIn: "123456789012345678901234567890",
      receipts: [{ hash: `0x${"1".repeat(64)}`, blockHash: `0x${"2".repeat(64)}`, amount: "1000000000000000000000001" }],
    };
    assert.equal(store.getBuybackBatch(batch.id), null);
    store.saveBuybackBatch(batch);
    const confirmed = { ...batch, status: "burn_confirmed", burnHash: `0x${"3".repeat(64)}` };
    store.saveBuybackBatch(confirmed);
    assert.deepEqual(store.listBuybackBatches(), [confirmed]);
    store.close();
    store = new Store(directory, 31337);
    assert.deepEqual(store.getBuybackBatch(batch.id), confirmed);
    store.saveSnapshot("expired", { price: 1 }, Date.now() - 90_000_000);
    store.cleanup(Date.now() + 400 * 86_400_000);
    assert.equal(store.snapshot("expired"), null);
    assert.deepEqual(store.getBuybackBatch(batch.id), confirmed, "Accounting evidence is retained independently of snapshot expiry");
    assert.throws(() => store!.saveBuybackBatch({ id: "" }), /batch ID/);
    assert.throws(() => store!.getBuybackBatch("x".repeat(201)), /batch ID/);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("buyback lists contain the latest 1000 updates without deleting older batches", () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-buyback-limit-"));
  const store = new Store(directory, 31337);
  try {
    const insert = store.db.prepare("INSERT INTO buyback_batches VALUES(?,?,?)");
    for (let i = 0; i <= 1000; i++) {
      const batch = { id: `batch-${i}`, amount: String(i) };
      insert.run(batch.id, i, JSON.stringify(batch));
    }
    let rows = store.listBuybackBatches();
    assert.equal(rows.length, 1000);
    assert.equal(rows[0].id, "batch-1000");
    assert.equal(rows.at(-1)?.id, "batch-1");
    assert.deepEqual(store.getBuybackBatch("batch-0"), { id: "batch-0", amount: "0" });
    store.saveBuybackBatch({ id: "batch-0", status: "reconciled" });
    rows = store.listBuybackBatches();
    assert.equal(rows[0].id, "batch-0", "Reconciled old batches return to the top");
    assert.equal(rows.length, 1000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Supabase batch operations scope and encode IDs while preserving opaque receipt payloads", async (t) => {
  const calls: { url: URL; method: string; body: any; prefer: string | null }[] = [];
  const batch = { id: "batch&scope=eq.base", receipt: { amount: "9999999999999999999999999" } };
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input), method = init.method || "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined, prefer: new Headers(init.headers).get("Prefer") });
    if (method === "GET") return new Response(JSON.stringify([{ payload: batch }]));
    return new Response(null, { status: 204 });
  });
  const store = new SupabaseStore("https://fixture.supabase.co", "local-test-only", "verify-batch-test");
  await store.saveBuybackBatch(batch);
  assert.equal(calls[0].url.pathname, "/rest/v1/musegod_buyback_batches");
  assert.equal(calls[0].url.searchParams.get("on_conflict"), "scope,id");
  assert.equal(calls[0].body.scope, "verify-batch-test");
  assert.deepEqual(calls[0].body.payload, batch);
  assert.equal(typeof calls[0].body.updated_at, "number");
  assert.equal(calls[0].prefer, "resolution=merge-duplicates,return=minimal");
  assert.deepEqual(await store.getBuybackBatch(batch.id), batch);
  assert.deepEqual(calls[1].url.searchParams.getAll("scope"), ["eq.verify-batch-test"]);
  assert.equal(calls[1].url.searchParams.get("id"), `eq.${batch.id}`);
  assert.equal(calls[1].url.searchParams.get("limit"), "1");
  assert.deepEqual(await store.listBuybackBatches(), [batch]);
  assert.equal(calls[2].url.searchParams.get("scope"), "eq.verify-batch-test");
  assert.equal(calls[2].url.searchParams.get("order"), "updated_at.desc,id");
  assert.equal(calls[2].url.searchParams.get("limit"), "1000");
  await assert.rejects(() => store.saveBuybackBatch({ id: "" }), /batch ID/);
  assert.equal(calls.length, 3, "Invalid IDs never reach the database");
});

test("Supabase readiness rejects a missing buyback migration", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string) =>
    new URL(input).pathname.endsWith("musegod_buyback_batches")
      ? new Response(null, { status: 404 })
      : new Response("[]"),
  );
  const store = new SupabaseStore("https://fixture.supabase.co", "local-test-only", "verify-batch-test");
  await assert.rejects(() => store.health(), /Database request failed \(404\)/);
});

test("batch keyset pages recover every historical source batch with tied timestamps beyond legacy 1000 display rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-buyback-pages-")), store = new Store(directory, 31337);
  try {
    for (let i = 0; i < 1203; i++) store.saveBuybackBatch({ id: `source-${String(i).padStart(4, "0")}`, updatedAt: Math.floor(i / 3), status: i === 0 ? "unknown" : "bridged", bridgeNonce: String(i) });
    const all = [];
    let before: { sequence: string } | undefined;
    for (;;) {
      const page = store.buybackBatchPage(71, before); all.push(...page);
      if (page.length < 71) break;
      before = page.at(-1)!;
    }
    assert.equal(all.length, 1203); assert.equal(new Set(all.map(row => row.id)).size, 1203);
    assert.equal(all.at(-1)?.status, "unknown", "The oldest unresolved batch is not lost behind a display cap");
    assert.equal(store.listBuybackBatches().length, 1000);
    assert.throws(() => store.buybackBatchPage(101), /page size/);
    assert.throws(() => store.buybackBatchPage(10, { sequence: "-1" }), /history sequence/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Supabase source-batch pagination uses immutable raw sequence beyond safe-integer precision", async (t) => {
  const calls: URL[] = [], id = 'batch,scope.eq.base)"\\&name';
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls.push(new URL(input));
    return new Response(JSON.stringify([{ payload: { id, updatedAt: 2, status: "unknown", amount: "1000000000000000000000001" }, updated_at: 99,sequence:"9007199254740993123" }]));
  });
  const store = new SupabaseStore("https://fixture.supabase.co", "fixture", "base");
  const [row] = await store.buybackBatchPage(37, { sequence:"9007199254740993124" });
  assert.equal(row.updatedAt, 99); assert.equal(row.amount, "1000000000000000000000001");
  assert.equal(calls[0].searchParams.get("scope"), "eq.base"); assert.equal(calls[0].searchParams.get("limit"), "37");
  assert.equal(calls[0].searchParams.get("sequence"),"lt.9007199254740993124");assert.equal(row.sequence,"9007199254740993123");
  assert.equal(calls[0].searchParams.get("name"), null, "Cursor contents cannot introduce another URL parameter");
  await assert.rejects(store.buybackBatchPage(101), /page size/); assert.equal(calls.length, 1);
});

test("batch updates between stable pages do not skip or duplicate records and backup preserves sequence",()=>{
 const directory=mkdtempSync(join(tmpdir(),"stable-pages-")),restoreDirectory=mkdtempSync(join(tmpdir(),"stable-pages-restore-")),store=new Store(directory,31337),restore=new Store(restoreDirectory,31337);
 try{for(let i=0;i<150;i++)store.saveBuybackBatch({id:`batch-${i}`,updatedAt:1});const first=store.buybackBatchPage(100);store.saveBuybackBatch({id:"batch-1",updatedAt:Date.now(),status:"received"});store.saveBuybackBatch({id:"batch-149",updatedAt:0,status:"unknown"});
  const second=store.buybackBatchPage(100,{sequence:first.at(-1)!.sequence});assert.equal(new Set([...first,...second].map(row=>row.id)).size,150);assert.equal(second.length,50);
  restore.restore(store.backup());assert.deepEqual(restore.buybackBatchPage(100,{sequence:first.at(-1)!.sequence}),second);assert.equal(restore.buybackBatchPage(1)[0].sequence,"150");
 }finally{store.close();restore.close();rmSync(directory,{recursive:true,force:true});rmSync(restoreDirectory,{recursive:true,force:true});}
});
