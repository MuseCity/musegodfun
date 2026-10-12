import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
import { BaseFeeQuoteReader } from "../server/base-buyback";
import { checkFunctionalSmoke } from "../scripts/release";

test("REL-1: a source-locked pre-summary rollback skips only aggregate counters, retaining both chains' existing smoke", async t => {
  const paths: string[] = [];let failedPath:string|undefined;
  t.mock.method(globalThis,"fetch",async (url:string) => {
    const path=new URL(url).pathname;paths.push(path);
    if(path===failedPath)return new Response(null,{status:503});
    if(path.endsWith("/first-buy/prices"))return Response.json({assets:[{priceUsd:"1"},{priceUsd:null}]});
    if(path.endsWith("/stocks"))return Response.json(Array.from({length:path.includes("8453")?36:1},()=>({verified:true})));
    if(path.endsWith("/buyback/engine"))return Response.json(path.includes("8453")?{kind:"base_splits_native",destinationChainId:4663}:{});
    if(path.endsWith("/tokens"))return Response.json({items:[]});
    return new Response(null,{status:404});
  });
  await (checkFunctionalSmoke as (...args:any[])=>Promise<unknown>)("https://release.test",true,false);
  assert(paths.some(path=>path.includes("/8453/buyback/engine")));
  assert(paths.some(path=>path.includes("/4663/buyback/engine")));
  assert(paths.some(path=>path.includes("/4663/stocks")));
  assert(!paths.some(path=>path.endsWith("/buyback/summary")));
  await assert.rejects(checkFunctionalSmoke("https://release.test"),/HTTP 404/);
  for (failedPath of ["/api/chains/4663/stocks","/api/chains/4663/buyback/engine","/api/chains/8453/buyback/engine"])
    await assert.rejects((checkFunctionalSmoke as (...args:any[])=>Promise<unknown>)("https://release.test",true,false),/HTTP 503/);
});
test("normal SQLite startup omits removed ledger schemas and backups tolerate their absence",()=>{
  const directory=mkdtempSync(join(tmpdir(),"round11-new-store-"));const store=new Store(directory,31337);
  try {
    const tables=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
    assert(!tables.some(row=>/^(vault|custody)_ledger_/.test(row.name)));
    const backup=store.backup() as {tables:Record<string,unknown>};
    assert(!Object.keys(backup.tables).some(name=>/^(vault|custody)_ledger_/.test(name)));
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test("existing historical ledger rows survive startup, backup and explicit empty-target restore",()=>{
  const directory=mkdtempSync(join(tmpdir(),"round11-old-store-")),restoreDirectory=mkdtempSync(join(tmpdir(),"round11-restored-"));
  let store=new Store(directory,31337);const restore=new Store(restoreDirectory,31337);
  try {
    store.db.exec("CREATE TABLE IF NOT EXISTS vault_ledger_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL)");
    store.db.prepare("INSERT INTO vault_ledger_state VALUES(1,7,?)").run('{"historical":"unchanged"}');
    store.close();store=new Store(directory,31337);
    const before=store.db.prepare("SELECT * FROM vault_ledger_state").all();restore.restore(store.backup());
    assert.deepEqual(restore.db.prepare("SELECT * FROM vault_ledger_state").all(),before);
    assert.deepEqual(store.db.prepare("SELECT * FROM vault_ledger_state").all(),before);
    assert.throws(()=>restore.restore(store.backup()),/not empty/);
  }finally{store.close();restore.close();rmSync(directory,{recursive:true,force:true});rmSync(restoreDirectory,{recursive:true,force:true});}
});
test("Supabase health requires active storage while omitted legacy ledger tables remain optional",async t=>{
  const paths:string[]=[];t.mock.method(globalThis,"fetch",async(url:string)=>{
    const path=new URL(url).pathname;paths.push(path);return /ledger/.test(path)?new Response(null,{status:404}):Response.json([]);
  });
  await new SupabaseStore("https://fixture.supabase.co","test-only","verify-round11").health();
  assert.equal(paths.length,3);assert(!paths.some(path=>/ledger/.test(path)));
});
test("database verification no longer probes or mutates retired custody tables",()=>{
  const source=readFileSync(new URL("../scripts/verify-database.ts",import.meta.url),"utf8");
  assert(!source.includes("musegod_custody_ledger_${table}"));
  assert(!source.includes('"custody_ledger_events",\n      "custody_ledger_blocks"'));
});
test("the display reader has no unused graph accessor or hardcoded pause claim",()=>{
  assert.equal("graph" in BaseFeeQuoteReader.prototype,false);
  const source=readFileSync(new URL("../server/app.ts",import.meta.url),"utf8");
  assert(!/verifiedGraph:\s*\{[^}]*paused:\s*false/.test(source));
});
test("live publication has no obsolete pristine scanner or CI progress cache",()=>{
  const release=readFileSync(new URL("../scripts/release.ts",import.meta.url),"utf8"),workflow=readFileSync(new URL("../.github/workflows/deploy.yml",import.meta.url),"utf8");
  assert(!release.includes("pristineBaseCollector"));assert(!release.includes("base-pristine-audit"));
  assert(!workflow.includes("pristine-audit"));assert(!workflow.includes("actions/cache/"));
  assert(workflow.includes("forge test --root contracts"));assert(workflow.includes("git diff --exit-code -- contracts/artifacts/buyback-v2"));
});

test("the deployed Robinhood Vault's manual fork tool and evidence retain their original review hashes",()=>{
  const review=JSON.parse(readFileSync(new URL("../docs/evidence/buyback-v2-review.json",import.meta.url),"utf8"));
  const paths=["scripts/test-buyback-vault-fork.ts","docs/evidence/buyback-v2-vault-fixture.json"];
  const pins={...review.sourceHashes,...review.evidenceHashes};
  for(const path of paths)assert.equal(createHash("sha256").update(readFileSync(new URL(`../${path}`,import.meta.url))).digest("hex"),pins[path]);
  const fixture=JSON.parse(readFileSync(new URL(`../${paths[1]}`,import.meta.url),"utf8"));
  assert.equal(fixture.chainId,31337);assert.equal(fixture.upstreamChainId,4663);
  assert.equal(fixture.mainnetWrites,false);assert.equal(fixture.mainnetExecutableProof,false);
  assert.equal(fixture.sourceSha256,review.sourceHashes[paths[0]]);
  const acceptance=JSON.parse(readFileSync(new URL("../docs/evidence/base-splits-review.json",import.meta.url),"utf8"));
  for(const retired of [acceptance.historicalDesignCleanup.retiredFiles,acceptance.round11.cleanup.retiredDesignFiles])
    for(const path of paths)assert(!retired.includes(path),`${path} belongs to the retained deployed Vault evidence`);
});
