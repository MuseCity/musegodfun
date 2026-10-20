import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SupabaseStore } from "../server/supabase-store";
import { POST_SCHEMA, POST_GLOBAL_SCHEMA, sqlitePostAction, type PostCommand } from "../server/post-store";
import { assertNativeAuditDatabaseMigration, assertTokenPostsDatabaseMigration } from "../scripts/verify-database";

test("verification cleanup includes launch claims even when a probe throws before releasing them", () => {
  const source = readFileSync(new URL("../scripts/verify-database.ts", import.meta.url), "utf8");
  const cleanup = source.slice(source.lastIndexOf("} finally {"));
  assert.match(cleanup, /for \(const table of \[[\s\S]*?"runtime_controls",\s*"launch_claims",\s*"post_api_keys",\s*"posts",\s*"post_media",\s*"post_rates",\s*\]\)/,
    "launch claims and Posts records are cleaned in every disposable scope");
  assert.match(cleanup, /assert\(\/\^\(verify\|restore\)-\/\.test\(db\.scope\)\)/, "cleanup retains its disposable-scope guard");
  assert.match(cleanup, /table === "launch_claims" && error instanceof Error &&\s*error\.message === "Database request failed \(404\)\. Check the server configuration and migrations\."\) continue/,
    "only a 404 for launch_claims is tolerated, so absent migration cleanup continues to the next scope");
  assert.match(source, /catch \(error\) \{\s*verificationFailed = true;\s*throw error;\s*\} finally \{/,
    "the original verification failure is rethrown");
  assert.match(cleanup, /cleanupError \?\?= error/, "other cleanup failures are retained without stopping cleanup");
  assert.match(cleanup, /if \(!verificationFailed\) throw cleanupError/, "cleanup failures cannot mask the original assertion");
});

test("database operator verification checks actual audit CAS and missing legacy RPCs in isolated scopes",async(t)=>{
 const calls:any[]=[],url="https://fixture.supabase.co",key="isolated-test-key",store=new SupabaseStore(url,key,"verify-round-four");let saved:any=null;
 t.mock.method(globalThis,"fetch",async(raw:string,init:RequestInit)=>{
  const body=init.body&&JSON.parse(init.body as string);calls.push({raw,method:init.method,body});
  if(raw.endsWith("musegod_compare_and_set_buyback_audit")){const matches=JSON.stringify(saved)===JSON.stringify(body.p_expected);if(matches)saved=body.p_next;return Response.json(matches);}
  if(init.method==="DELETE"){saved=null;return new Response(null,{status:204});}
  return Response.json({code:"PGRST202"},{status:404});
 });
 await assertNativeAuditDatabaseMigration(store,url,key);assert.equal(calls.length,5);assert.equal(saved,null);
 assert(calls.filter(row=>row.body).every(row=>row.body.p_scope==="verify-round-four"));
 await assert.rejects(()=>assertNativeAuditDatabaseMigration(new SupabaseStore(url,key,"base"),url,key),/isolated verify scope/);
});

test("missing CAS, callable unbounded helpers and transient RPC failures cannot pass migration verification",async(t)=>{
 const url="https://fixture.supabase.co",key="test-only",store=new SupabaseStore(url,key,"verify-rpc-check");let mode="cas-missing",count=0;
 t.mock.method(globalThis,"fetch",async(raw:string,init:RequestInit)=>{
  if(raw.endsWith("musegod_compare_and_set_buyback_audit")){if(mode==="cas-missing")return Response.json({code:"PGRST202"},{status:404});return Response.json(count++%2===0);}
  if(init.method==="DELETE")return new Response(null,{status:204});
  return mode==="legacy-exists"?Response.json({code:"P0001"},{status:400}):Response.json({code:"temporary"},{status:503});
 });
 await assert.rejects(()=>assertNativeAuditDatabaseMigration(store,url,key),/Database request failed/);
 for(mode of ["legacy-exists","transient"]){count=0;await assert.rejects(()=>assertNativeAuditDatabaseMigration(store,url,key),/absence could not be verified/);}
});

test("Posts database verification rejects stale release commands and incomplete refunds in its own scope",async(t)=>{
 for(const mode of ["current","missing-release","pending","not-persisted","token-counter","shared-counter","missing-counter"])await t.test(mode,async(t)=>{
  const db=new DatabaseSync(":memory:"),shared=new DatabaseSync(":memory:"),scope="verify-posts-release",commands:PostCommand[]=[];
  db.exec(POST_SCHEMA);shared.exec(POST_GLOBAL_SCHEMA);t.after(()=>{db.close();shared.close();});
  let reads=0;
  t.mock.method(globalThis,"fetch",async(raw:string,init:RequestInit)=>{
   const url=new URL(raw);assert.equal(url.origin,"https://fixture.supabase.co");
   if(url.pathname==="/rest/v1/rpc/musegod_post_action"){
    const body=JSON.parse(init.body as string);assert.equal(body.p_scope,scope);const command=body.p_command as PostCommand;commands.push(command);
    if(command.action==="mediaRelease"){
     if(mode==="missing-release")return Response.json({message:"Unknown Posts command"},{status:400});
     if(mode==="pending"||mode==="not-persisted"){
      const result=sqlitePostAction(db,shared,{action:"mediaGet",token:command.token,id:command.id});
      return Response.json(mode==="not-persisted"?{media:{...result.media,state:"failed"}}:result);
     }
    }
    const result=sqlitePostAction(db,shared,command);
    if(command.action==="mediaRelease"){
     if(mode==="token-counter")db.exec("UPDATE post_rates SET count=1 WHERE key LIKE 'images:%'");
     if(mode==="shared-counter")shared.exec("UPDATE post_global_rates SET count=1");
    }
    return Response.json(result);
   }
   assert.equal(init.method,"GET");assert.equal(url.pathname,"/rest/v1/musegod_post_rates");assert.equal(url.searchParams.get("scope"),`eq.${scope}`);
   const reservation=commands.find(c=>c.action==="mediaReserve");assert(reservation?.action==="mediaReserve");
   const day=Math.floor(reservation.now/86_400_000);
   assert.equal(url.searchParams.get("key"),`in.(images:${reservation.token}:${day},images-global:${day})`);reads++;
   return Response.json(mode==="missing-counter"?[]:[...db.prepare("SELECT key,count FROM post_rates WHERE key LIKE 'images:%'").all(),...shared.prepare("SELECT key,count FROM post_global_rates").all()]);
  });
  const verify=()=>assertTokenPostsDatabaseMigration(new SupabaseStore("https://fixture.supabase.co","test-only",scope));
  if(mode==="current"){
   const fixture=await verify();assert.equal(reads,1);
   const release=commands.findIndex(c=>c.action==="mediaRelease"),revoke=commands.findIndex(c=>c.action==="keyRevoke");
   assert(release>0&&release<revoke);const released=commands[release];assert(released.action==="mediaRelease");assert.equal(released.token,fixture.token);
  }else await assert.rejects(verify,mode==="missing-release"?/Database request failed \(400\)/:mode==="pending"||mode==="not-persisted"?/A released image is marked failed/:/Released media refunds/);
 });
});

test("Posts database verification refuses live and restore scopes before making requests",async(t)=>{
 let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("Unexpected request");});
 for(const scope of ["base","robinhood","restore-posts-release"])await assert.rejects(()=>assertTokenPostsDatabaseMigration(new SupabaseStore("https://fixture.supabase.co","test-only",scope)),/isolated verify scope/);
 assert.equal(calls,0);
});
