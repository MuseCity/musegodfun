#!/usr/bin/env node
import { readFile, realpath, stat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { inspectKeeperRelease, KEEPER_LAUNCHD_POLICY } from "./base-keeper-wrapper.mjs";
const executeFile = promisify(execFile);
export const RH_KEEPER_ADDRESS = "0xd3f11a4DDcED57aC4E41F8CE7fD323959667e278";
export const RH_KEEPER_MANUAL_EXIT_CODE = 78;
export { KEEPER_LAUNCHD_POLICY };
export const RH_KEEPER_API_ORIGINS = ["https://musegod.fun", "https://www.musegod.fun"];
const FIELDS = ["nodePath", "checkout", "environmentFile", "operatorDirectory", "releaseTag", "expectedCommit", "executeWhenReady", "apiOrigin"];
class ManualIntervention extends Error { constructor(message) { super(message); this.manual = true; } }
export function validateRhKeeperWrapperConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key)) || FIELDS.some(key => !Object.hasOwn(value,key))) throw new ManualIntervention("Private RH keeper configuration has invalid fields");
  for (const name of ["nodePath", "checkout", "environmentFile", "operatorDirectory"]) if (typeof value[name] !== "string" || !isAbsolute(value[name])) throw new ManualIntervention("Keeper paths must be private absolute paths");
  if (!/^build-[0-9]+-[0-9]+$/.test(value.releaseTag) || !/^[a-f0-9]{40}$/.test(value.expectedCommit) || typeof value.executeWhenReady !== "boolean") throw new ManualIntervention("An exact published build and explicit owner switch are required");
  if (!RH_KEEPER_API_ORIGINS.includes(value.apiOrigin)) throw new ManualIntervention("The RH keeper API must use an existing production origin");
  if (/(?:\.codex|\.claude)\/worktrees(?:\/|$)/.test(value.checkout) || resolve(value.environmentFile).startsWith(`${resolve(value.checkout)}/`) || resolve(value.operatorDirectory).startsWith(`${resolve(value.checkout)}/`) || resolve(value.operatorDirectory) === resolve(value.checkout)) throw new ManualIntervention("Private operator paths must be separate from the release checkout");
  return value;
}
export function rhKeeperChildEnvironment(text, inherited = {}) {
  const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap(name => inherited[name] ? [[name,inherited[name]]] : []));
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?ALCHEMY_API_KEY\s*=\s*(.*?)\s*$/); if (!match) continue;
    let value = match[1]; if (/^(['"]).*\1$/.test(value)) value = value.slice(1,-1); else value = value.replace(/\s+#.*$/,""); environment.ALCHEMY_API_KEY = value;
  }
  return { ...environment, NODE_ENV: "production" };
}
export async function prepareRhKeeperWrapper(path) {
  if (!isAbsolute(path)) throw new ManualIntervention("Select one absolute private configuration path");
  let config; try { config = validateRhKeeperWrapperConfig(JSON.parse(await readFile(path,"utf8"))); } catch (error) { throw new ManualIntervention(error.manual ? error.message : "The private RH configuration could not be read"); }
  let inspected; try { inspected = await inspectKeeperRelease(config,path,"scripts/buyback-keeper.ts"); } catch (error) { throw new ManualIntervention(error.message); }
  const text = await readFile(config.environmentFile,"utf8"), environment = rhKeeperChildEnvironment(text,process.env);
  if (!environment.ALCHEMY_API_KEY) throw new ManualIntervention("The existing Alchemy credential is required");
  const require = createRequire(join(inspected.checkout,"package.json")), loader = require.resolve("tsx");
  const args = ["--import",loader,join(inspected.checkout,"scripts/buyback-keeper.ts"),`--api=${config.apiOrigin}`];
  if (config.executeWhenReady) {
    const key = text.split(/\r?\n/).map(line => line.match(/^\s*(?:export\s+)?MUSEGOD_KEEPER_PRIVATE_KEY\s*=\s*["']?(0x[\da-fA-F]{64})["']?\s*$/)).find(Boolean)?.[1];
    if (!key) throw new ManualIntervention("Execution requires the dedicated D3 keeper key");
    const account = await import(pathToFileURL(require.resolve("viem/accounts")).href); let address;
    try { address = account.privateKeyToAccount(key).address; } catch { throw new ManualIntervention("The dedicated keeper key is invalid"); }
    if (address.toLowerCase() !== RH_KEEPER_ADDRESS.toLowerCase()) throw new ManualIntervention("The signer is not the fixed D3 keeper");
    environment.MUSEGOD_KEEPER_PRIVATE_KEY = key; args.push("--execute");
  }
  const journalDirectory = join(inspected.operator,".cache/buyback-keeper"), stem = join(journalDirectory,`4663-${RH_KEEPER_ADDRESS.toLowerCase()}.json`);
  return {config,environment,command:config.nodePath,args,cwd:inspected.operator,journal:stem,tasks:`${stem}.tasks.json`,loader};
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
/** Explicit operator handoff only. Never called by --run or --check. Source
 * stays fenced and original public bytes stay as the operator's backup. */
export async function migrateRhKeeperJournal(prepared, sourceDirectory) {
  if (prepared.config.executeWhenReady) throw new ManualIntervention("Keep execution disabled during explicit financial handoff");
  if (!isAbsolute(sourceDirectory) || await realpath(sourceDirectory) !== resolve(sourceDirectory)) throw new ManualIntervention("Select the canonical existing journal directory");
  const source = join(sourceDirectory,`4663-${RH_KEEPER_ADDRESS.toLowerCase()}.json`), sourceTasks=`${source}.tasks.json`;
  if (source === prepared.journal) throw new ManualIntervention("Source and destination journals must differ");
  try { for (const path of [source,sourceTasks]) if (!(await stat(path)).isFile()) throw new Error("Not a file"); } catch { throw new ManualIntervention("Both existing public financial files are required"); }
  for (const path of [prepared.journal,prepared.tasks,`${source}.lock`,`${prepared.journal}.lock`]) if (await exists(path)) throw new ManualIntervention("Existing financial files or locks require manual inspection; nothing is overwritten");
  await mkdir(resolve(prepared.journal,".."),{recursive:true,mode:0o700});
  const marker=JSON.stringify({pid:process.pid,handoff:true,target:prepared.journal,token:randomUUID()})+"\n";
  const hold = async path => { const file=await open(path,"wx",0o600);try{await file.writeFile(marker);await file.sync();}finally{await file.close();} };
  try {
    await hold(`${source}.lock`); await hold(`${prepared.journal}.lock`);
    const code=`const m=await import(${JSON.stringify(pathToFileURL(join(prepared.config.checkout,"scripts/buyback-keeper.ts")).href)});await m.readKeeperJournal(${JSON.stringify(source)},4663,${JSON.stringify(RH_KEEPER_ADDRESS)});await m.readKeeperTaskState(${JSON.stringify(sourceTasks)},4663,${JSON.stringify(RH_KEEPER_ADDRESS)});`;
    await executeFile(prepared.command,["--import",prepared.loader,"--input-type=module","-e",code],{cwd:prepared.cwd,env:rhKeeperChildEnvironment("",process.env),timeout:15000});
    const pairs = [[source,prepared.journal],[sourceTasks,prepared.tasks]], hashes=[];
    for (const [from,to] of pairs) { const bytes=await readFile(from),file=await open(to,"wx",0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}if(!(await readFile(to)).equals(bytes))throw new Error("Migration readback differs");hashes.push({name:to,sha256:createHash("sha256").update(bytes).digest("hex")}); }
    const directory=await open(resolve(prepared.journal,".."),"r");try{await directory.sync();}finally{await directory.close();}
    await unlink(`${prepared.journal}.lock`);
    console.log(JSON.stringify({state:"journal_handoff_prepared",sourceFenced:true,files:hashes}));
  } catch { throw new ManualIntervention("Journal handoff was not completed; retain all files and locks for manual inspection"); }
}
export async function runRhKeeperWrapper(args=process.argv.slice(2)) {
  if(args.length!==2||args.filter(a=>a.startsWith("--config=")).length!==1||args.filter(a=>["--check","--run"].includes(a)||a.startsWith("--migrate-journal=")).length!==1)throw new ManualIntervention("Use --config=/private/config.json with --check, --run or explicit --migrate-journal=/existing/directory");
  const prepared=await prepareRhKeeperWrapper(args.find(a=>a.startsWith("--config=")).slice(9));
  console.log(JSON.stringify({state:"prepared",mode:prepared.config.executeWhenReady?"execute":"dry_run",releaseTag:prepared.config.releaseTag,expectedCommit:prepared.config.expectedCommit,keeper:RH_KEEPER_ADDRESS,throttleInterval:300}));
  const migration=args.find(a=>a.startsWith("--migrate-journal="));if(migration){await migrateRhKeeperJournal(prepared,migration.slice(18));return;}if(args.includes("--check"))return;
  if(prepared.config.executeWhenReady) {
    if(!await exists(prepared.journal)||!await exists(prepared.tasks))throw new ManualIntervention("Existing RH journal and tasks must be explicitly handed off before execution");
    if(await exists(`${prepared.journal}.lock`))throw new ManualIntervention("A retained keeper lock needs manual inspection");
  }
  let stopping=false;const child=spawn(prepared.command,prepared.args,{cwd:prepared.cwd,env:prepared.environment,stdio:"inherit"});const stop=()=>{stopping=true;child.kill("SIGTERM");};process.once("SIGINT",stop);process.once("SIGTERM",stop);
  try{await new Promise((done,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{if(stopping||code===0){done();return;}if(code===RH_KEEPER_MANUAL_EXIT_CODE){reject(new ManualIntervention("Keeper financial journal or lock requires manual intervention"));return;}reject(new Error(`Restartable keeper exit (${signal??code})`));});});}finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await runRhKeeperWrapper().catch(error=>{console.log(JSON.stringify({state:error.manual?"manual_intervention_required":"restartable_failure",reason:error.message,throttleInterval:300}));process.exitCode=error.manual?0:1;});
