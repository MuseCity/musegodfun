import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
import { randomUUID } from "node:crypto";
import { exercisePostStore, keyRecord, postRecord, TOKEN, NOW } from "./helpers/post-store-scenarios";

function fixture() {
 const directory=mkdtempSync(join(tmpdir(),"musegod-post-store-"));
 const store=new Store(join(directory,"base"),8453);
 return {directory,store,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
test("SQLite Posts transactions preserve auth, quotas, image leases and idempotent tombstones",async()=>{
 const f=fixture();try{await exercisePostStore(c=>f.store.postAction(c));}finally{f.close();}
});
test("SQLite Posts survive cleanup and restore without reviving credentials or changing the backup",()=>{
 const f=fixture(), restored=new Store(join(f.directory,"restore"),8453);
 try{
  const key=keyRecord();f.store.postAction({action:"keyCreate",row:key});
  f.store.postAction({action:"postCreate",token:TOKEN,keyId:key.id,post:postRecord(),idempotencyKey:"one",requestHash:"a".repeat(64),now:NOW});
  f.store.postAction({action:"postDelete",token:TOKEN,postId:"post-1",now:NOW+1});
  f.store.cleanup(NOW+86_400_000);
  const backup=f.store.backup(), before=JSON.stringify(backup);restored.restore(backup);
  assert.equal(JSON.stringify(backup),before,"restore does not alter its input backup");
  assert.notEqual(restored.postAction({action:"keyGet",token:TOKEN,id:key.id}).key?.revokedAt,null);
  assert.equal(restored.db.prepare("SELECT count(*) AS n FROM posts").get()?.n,1);
  assert.equal(restored.postAction({action:"postsList",token:TOKEN,limit:20}).posts?.length,0);
  assert.equal(restored.postAction({action:"keyCreate",row:key}).error?.code,"POST_KEY_EXISTS","create nonce remains permanently consumed");
  assert.throws(()=>restored.restore(backup),/not empty/);
 }finally{restored.close();f.close();}
});
test("SQLite global post image budget is shared across Base and Robinhood, including failed attempts",()=>{
 const f=fixture(), robinhood=new Store(join(f.directory,"robinhood"),4663);
 try{
  let n=0;
  for(const store of [f.store,robinhood])for(let t=0;t<3;t++){
   const token=`0x${String(100+n).padStart(40,"0")}`,key=keyRecord(`image-${n}`,token);store.postAction({action:"keyCreate",row:key});
   for(let i=0;i<10;i++){
    const result=store.postAction({action:"mediaReserve",token,keyId:key.id,id:String(i).padStart(64,"0"),leaseId:`lease-${i}`,now:NOW});
    if(n<5)assert.equal(result.error,undefined);else assert.equal(result.error?.status,429);
   }n++;
  }
 }finally{robinhood.close();f.close();}
});
test("Supabase PostAction uses the scoped server RPC and sends no unrelated data",async t=>{
 const calls:unknown[]=[];t.mock.method(globalThis,"fetch",async(input:unknown,init?:RequestInit)=>{
  calls.push({input,body:JSON.parse(init?.body as string)});return Response.json({keys:[]});
 });
 const store=new SupabaseStore("https://fixture.supabase.co","fixture-server","robinhood");
 assert.deepEqual(await store.postAction({action:"keysList",token:TOKEN}),{keys:[]});
 assert.deepEqual(calls,[{input:"https://fixture.supabase.co/rest/v1/rpc/musegod_post_action",body:{p_scope:"robinhood",p_command:{action:"keysList",token:TOKEN}}}]);
});
test("SQLite daily create, per-key mutation and owner deletion limits reset only at their own windows",()=>{
 const f=fixture();try{
  const token=`0x${"7".repeat(40)}`,key=keyRecord("daily-key",token);f.store.postAction({action:"keyCreate",row:key});
  const publish=(i:number,now:number)=>f.store.postAction({action:"postCreate",token,keyId:key.id,post:postRecord(`daily-${i}`,token,key.id,now),idempotencyKey:`daily-${i}`,requestHash:"a".repeat(64),now});
  for(let i=0;i<60;i++)assert.equal(publish(i,NOW+i*60_000).error,undefined);
  assert.equal(publish(60,NOW+60*60_000).error?.status,429,"60 daily creates span minute windows");
  const deletesAt=NOW+61*60_000;
  for(let i=0;i<10;i++)assert.equal(f.store.postAction({action:"postDelete",token,keyId:key.id,postId:`daily-${i}`,now:deletesAt}).error,undefined);
  assert.equal(f.store.postAction({action:"postDelete",token,keyId:key.id,postId:"daily-10",now:deletesAt}).error?.status,429,"key mutation window is shared across operations");
  for(let i=10;i<30;i++)assert.equal(f.store.postAction({action:"postDelete",token,postId:`daily-${i}`,now:deletesAt}).error,undefined);
  assert.equal(f.store.postAction({action:"postDelete",token,postId:"daily-30",now:deletesAt}).error?.status,429,"owner requests share the token delete budget");
  assert.equal(f.store.postAction({action:"postDelete",token,postId:"daily-30",now:deletesAt+60_000}).error,undefined);
  assert.equal(publish(61,NOW+86_400_000).error,undefined);
  assert.equal(f.store.postAction({action:"postDelete",token,keyId:key.id,postId:"daily-61",now:key.expiresAt}).error?.status,401,"expiry is exclusive");
 }finally{f.close();}
});

test("SQLite shared image counter survives simulated-time cleanup and merges by maximum on restore", () => {
  const live = Date.now(), source = mkdtempSync(join(tmpdir(), "musegod-post-global-")), target = mkdtempSync(join(tmpdir(), "musegod-post-global-"));
  const store = new Store(join(source, "base"), 8453), first = new Store(join(target, "base"), 8453), second = new Store(join(target, "restore"), 8453);
  const fill = (s: Store, n: number) => { for (let t = 0; t < n; t++) {
    const token = `0x${String(200 + t).padStart(40, "0")}`, key = keyRecord(`fill-${t}`, token, live); s.postAction({ action: "keyCreate", row: key });
    for (let i = 0; i < 10; i++) assert.equal(s.postAction({ action: "mediaReserve", token, keyId: key.id, id: String(i).padStart(64, "0"), leaseId: `l${i}`, now: live }).error, undefined);
  } };
  const refused = (s: Store) => { const token = `0x${"9".repeat(40)}`, key = keyRecord(`probe-${randomUUID()}`, token, live); s.postAction({ action: "keyCreate", row: key });
    return s.postAction({ action: "mediaReserve", token, keyId: key.id, id: "f".repeat(64), leaseId: randomUUID(), now: live }).error?.status === 429; };
  try {
    fill(store, 5);
    assert(refused(store));
    store.cleanup(live + 25 * 3_600_000);
    assert(refused(store), "a simulated future cleanup keeps the live shared window");
    const backup = store.backup();
    first.restore(backup);
    assert(refused(first), "a fresh restore keeps the shared cap");
    second.restore(backup);
    const budget = new DatabaseSync(join(target, "runtime-budgets.sqlite"));
    try { assert.deepEqual(budget.prepare("SELECT count FROM post_global_rates WHERE key LIKE 'images-global:%'").all().map(row => row.count), [50], "two restores count the day once"); }
    finally { budget.close(); }
  } finally { store.close(); first.close(); second.close(); rmSync(source, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("SQLite refund commits never let an interrupted release refund twice", () => {
  const f = fixture(), budget = (f.store as unknown as { budgetDb: DatabaseSync }).budgetDb;
  try {
    const at = Date.now(), media = "e".repeat(64);
    const shared = () => (budget.prepare("SELECT count FROM post_global_rates WHERE key=?").get(`images-global:${Math.floor(at / 86_400_000)}`) as { count: number }).count;
    for (const token of [`0x${"a".repeat(40)}`, `0x${"b".repeat(40)}`]) {
      const key = keyRecord(`refund-${token.slice(2, 4)}`, token, at); f.store.postAction({ action: "keyCreate", row: key });
      assert.equal(f.store.postAction({ action: "mediaReserve", token, keyId: key.id, id: media, leaseId: `lease-${token.slice(2, 4)}`, now: at }).error, undefined);
    }
    assert.equal(shared(), 2);
    // Interrupt one COMMIT of a release, then replay the same lease, as a retry after a crash would.
    const interrupt = (connection: DatabaseSync, run: () => void) => {
      const original = connection.exec.bind(connection);
      connection.exec = (sql: string) => { if (sql === "COMMIT") { connection.exec = original; throw new Error("interrupted commit"); } return original(sql); };
      try { assert.throws(run, /interrupted commit/); } finally { connection.exec = original; }
    };
    const release = (token: string, leaseId: string) => f.store.postAction({ action: "mediaRelease", token, id: media, leaseId, now: at });
    interrupt(f.store.db, () => release(`0x${"a".repeat(40)}`, "lease-aa"));
    assert.equal(release(`0x${"a".repeat(40)}`, "lease-aa").media?.state, "failed");
    assert.equal(shared(), 1, "a failed token-database commit refunds nothing; the replay refunds once");
    interrupt(budget, () => release(`0x${"b".repeat(40)}`, "lease-bb"));
    assert.equal(release(`0x${"b".repeat(40)}`, "lease-bb").media?.state, "failed");
    assert.equal(shared(), 1, "an interrupted shared commit keeps the slot and the replay finds nothing to refund");
  } finally { f.close(); }
});
