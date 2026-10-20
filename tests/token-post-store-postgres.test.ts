import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { exercisePostStore, keyRecord, postRecord, TOKEN, NOW } from "./helpers/post-store-scenarios";
import type { PostCommand, PostResult } from "../server/post-store";
const execAsync=promisify(execFile), enabled=process.env.POSTS_TEST_POSTGRES==="1";
// Explicit opt-in: isolated throwaway PostgreSQL, no project env, no production credentials or network connection.
test("Posts migration and RPC run against isolated PostgreSQL with parity, RLS and concurrency",{skip:!enabled,timeout:120_000},async()=>{
 const provided=process.env.POSTS_TEST_PG_CONTAINER, container=provided||`musegod-posts-test-${randomUUID()}`;
 const sql=(input:string)=>execFileSync("docker",["exec","-i",container,"psql","-h","127.0.0.1","-U","postgres","-qAt","-v","ON_ERROR_STOP=1"],{input,encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim();
 const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
 const scope=`verify-posts-${randomUUID()}`,restored=`restore-posts-${randomUUID()}`;
 const query=(command:PostCommand,s=scope)=>`SELECT public.musegod_post_action(${quote(s)},${quote(JSON.stringify(command))}::jsonb);`;
 const run=(command:PostCommand,s=scope):PostResult=>JSON.parse(sql(`SET ROLE service_role;${query(command,s)}`));
 try{
  if(!provided){
   execFileSync("docker",["run","-d","--rm","--name",container,"-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17-alpine"],{stdio:"pipe"});
   let ready=false;for(let i=0;i<20;i++){try{sql("SELECT 1;");ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,200));}}assert(ready,"isolated Postgres started");
   sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;");
   for(const filename of readdirSync("supabase/migrations").filter(x=>x.endsWith(".sql")).sort())sql(readFileSync(`supabase/migrations/${filename}`,"utf8"));
  }
  await exercisePostStore(c=>run(c));
  assert.equal(sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('musegod_post_api_keys','musegod_posts','musegod_post_media','musegod_post_rates');"),"t");
  assert.equal(sql("SELECT has_function_privilege('anon','public.musegod_post_action(text,jsonb)','EXECUTE');"),"f");
  assert.equal(sql("SELECT has_function_privilege('authenticated','public.musegod_post_action(text,jsonb)','EXECUTE');"),"f");
  assert.equal(sql("SELECT prosecdef FROM pg_proc WHERE oid='public.musegod_post_action(text,jsonb)'::regprocedure;"),"f");
  assert.throws(()=>sql("SET ROLE anon;SELECT count(*) FROM public.musegod_post_api_keys;"),/permission denied/);
  const backup=JSON.parse(sql(`SET ROLE service_role;SELECT public.musegod_backup(${quote(scope)});`));
  sql(`SET ROLE service_role;SELECT public.musegod_restore(${quote(restored)},${quote(JSON.stringify(backup))}::jsonb);`);
  const keys=run({action:"keysList",token:TOKEN},restored).keys!;assert(keys.length>0);assert(keys.every(k=>k.revokedAt!==null));
  assert.equal(run({action:"keyCreate",row:keyRecord()},restored).error?.code,"POST_KEY_EXISTS");
  assert.equal(run({action:"postsList",token:TOKEN,limit:50},restored).posts?.length,3);
  assert.throws(()=>sql(`SELECT public.musegod_restore(${quote(restored)},${quote(JSON.stringify(backup))}::jsonb);`),/not empty/);
  const concurrentScope=`verify-posts-${randomUUID()}`,concurrentKey=keyRecord("concurrent-key");run({action:"keyCreate",row:concurrentKey},concurrentScope);
  const results=await Promise.all(Array.from({length:8},async(_,i)=>{
   const command:PostCommand={action:"postCreate",token:TOKEN,keyId:concurrentKey.id,post:postRecord(`concurrent-${i}`,TOKEN,concurrentKey.id),idempotencyKey:`concurrent-${i}`,requestHash:"a".repeat(64),now:NOW};
   const {stdout}=await execAsync("docker",["exec",container,"psql","-h","127.0.0.1","-U","postgres","-qAt","-v","ON_ERROR_STOP=1","-c",`SET ROLE service_role;${query(command,concurrentScope)}`]);return JSON.parse(stdout.trim()) as PostResult;
  }));
  assert.equal(results.filter(r=>!r.error).length,2,"parallel writers share one atomic token budget");
  assert.equal(results.filter(r=>r.error?.status===429).length,6);
  // The all-site image cap is one counter, spanning both runtime scopes.
  sql("DELETE FROM public.musegod_post_rates WHERE scope='global';");
  for(let t=0;t<6;t++){
   const imageScope=t<3?"base":"robinhood",token=`0x${String(t+100).padStart(40,'0')}`,key=keyRecord(`global-${t}`,token);run({action:"keyCreate",row:key},imageScope);
   for(let i=0;i<10;i++){
    const result=run({action:"mediaReserve",token,keyId:key.id,id:String(i).padStart(64,'0'),leaseId:`lease-${i}`,now:NOW},imageScope);
    assert.equal(result.error?.status,t<5?undefined:429);
   }
  }
 }finally{if(!provided)execFileSync("docker",["rm","-f",container],{stdio:"pipe"});}
});
