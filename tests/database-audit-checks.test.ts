import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SupabaseStore } from "../server/supabase-store";
import { assertNativeAuditDatabaseMigration } from "../scripts/verify-database";

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
