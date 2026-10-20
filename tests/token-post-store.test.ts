import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
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
