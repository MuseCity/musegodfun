import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
const wrapperUrl = new URL("../scripts/base-keeper-wrapper.mjs", import.meta.url), wrapper = await import(wrapperUrl.href);
const runFile = promisify(execFile);
test("K-3 Base launchd policy preserves a 120-second keeper shutdown window", () => {
  assert.deepEqual(wrapper.KEEPER_LAUNCHD_POLICY, { KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 300, ExitTimeOut: 120 });
});
async function fixture(t: TestContext, armed = false, seal = true, sealDelay = 0) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "light-keeper-wrapper-"))), checkout = join(directory, "release"), operator = join(directory, "operator"), env = join(directory, "host.env"), cfg = join(directory, "host.json");
  await mkdir(join(checkout, "scripts"), { recursive: true }); await mkdir(join(checkout, "contracts/artifacts"), { recursive: true }); await mkdir(operator, { mode: 0o700 });
  const key = generatePrivateKey();
  await writeFile(join(checkout, "package.json"), '{"type":"module"}');
  await symlink(resolve("node_modules"), join(checkout, "node_modules"));
  await writeFile(join(checkout, ".gitignore"), "node_modules/\n");
  await writeFile(join(checkout, "contracts/artifacts/base-collector-deployment.json"), JSON.stringify({ activation: { trustedSplitsAcceptance: { keeper: privateKeyToAccount(key).address } } }));
  await writeFile(join(checkout, "scripts/base-buyback-keeper.ts"), `import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),execute=args.includes('--execute');
if(execute&&!process.env.MUSEGOD_KEEPER_PRIVATE_KEY)throw Error('missing wallet');
if(!execute&&process.env.MUSEGOD_KEEPER_PRIVATE_KEY)throw Error('wallet leaked');
if(process.env.MUSEGOD_DEPLOY_PRIVATE_KEY||process.env.EVM_DY)throw Error('role secret leaked');
appendFileSync('invocations.jsonl',JSON.stringify({args,hasWallet:!!process.env.MUSEGOD_KEEPER_PRIVATE_KEY,enabled:process.env.ENABLE_BASE_TRANSACTIONS,home:process.env.HOME})+'\\n');
if(args.includes('--once'))await new Promise(done=>setTimeout(done,${sealDelay}));
if(args.includes('--once')&&${seal})console.log(JSON.stringify({mode:'startup_verified'}));`);
  const git = async (...args: string[]) => (await runFile("git", ["-C", checkout, ...args])).stdout.trim();
  await git("init", "--quiet"); await git("add", "."); await git("-c", "user.name=Offline", "-c", "user.email=offline@example.invalid", "commit", "--quiet", "-m", "fixture");
  const expectedCommit = await git("rev-parse", "HEAD"); await git("tag", "build-123456789-1"); await git("checkout", "--quiet", "--detach", expectedCommit);
  await writeFile(env, `ALCHEMY_API_KEY=offline\nSUPABASE_URL=https://offline.invalid\nSUPABASE_SECRET_KEY=fixture\nMUSEGOD_KEEPER_PRIVATE_KEY=${key}\nMUSEGOD_DEPLOY_PRIVATE_KEY=never-inherit\nHOME=/attacker/reset-journal\n`, { mode: 0o600 });
  const config = { nodePath: process.execPath, checkout, environmentFile: env, operatorDirectory: operator, releaseTag: "build-123456789-1", expectedCommit, executeWhenReady: armed, enableBaseTransactions: armed };
  await writeFile(cfg, JSON.stringify(config), { mode: 0o600 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { config, cfg, operator, checkout, git, run: () => runFile(process.execPath, [wrapperUrl.pathname, `--config=${cfg}`, "--run"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, MUSEGOD_DEPLOY_PRIVATE_KEY: "inherited-never" }, timeout: 20_000 }), rows: async () => (await readFile(join(operator, "invocations.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row)) };
}
test("private switches remain explicit, paths reject developer checkouts and env loading strips all wallet roles", () => {
  const cfg = { nodePath: "/node", checkout: "/release", environmentFile: "/private/env", operatorDirectory: "/private/operator", releaseTag: "build-123456789-1", expectedCommit: "a".repeat(40), executeWhenReady: false, enableBaseTransactions: false };
  assert.equal(wrapper.validateBaseKeeperWrapperConfig(cfg), cfg);
  for (const change of [{ executeWhenReady: "false" }, { checkout: "/Users/me/.codex/worktrees/release" }, { releaseTag: "master" }, { releaseTag: "base-keeper-v1" }, { releaseTag: "build-not-a-number-1" }, { releaseTag: "build-123-1-extra" }, { environmentFile: "/release/.env" }, { unknown: true }]) assert.throws(() => wrapper.validateBaseKeeperWrapperConfig({ ...cfg, ...change }));
  const env = wrapper.baseKeeperChildEnvironment("MUSEGOD_KEEPER_PRIVATE_KEY=wallet\nEVM_DY=other\nALCHEMY_API_KEY=api\nHOME=/changed\nENABLE_BASE_TRANSACTIONS=true", { HOME: "/canonical-home", MUSEGOD_KEEPER_PRIVATE_KEY: "inherited" });
  assert.equal(env.HOME, "/canonical-home"); assert.equal(env.ENABLE_BASE_TRANSACTIONS, "false"); assert.equal(env.ALCHEMY_API_KEY, "api"); assert.equal(env.MUSEGOD_KEEPER_PRIVATE_KEY, undefined); assert.equal(env.EVM_DY, undefined);
});
test("actual tagged audit-only child has no signing key and no automatic arming", async t => {
  const f = await fixture(t); const result = await f.run(); assert.match(result.stdout, /audit_only/);
  const rows = await f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].hasWallet, false); assert.equal(rows[0].enabled, "false"); assert(rows[0].args.includes("--audit-only")); assert(rows[0].args.includes("--interval=300000")); assert.equal(rows[0].home, process.env.HOME);
});
test("round12 owner switches and startup seal launch the dedicated signer without a lifetime gas ceiling or unknown recovery", async t => {
  const f = await fixture(t, true); await f.run(); const rows = await f.rows(); assert.equal(rows.length, 2);
  assert(rows[0].args.includes("--once")); assert.equal(rows[0].hasWallet, false); assert.equal(rows[1].hasWallet, true); assert.equal(rows[1].enabled, "true"); assert(rows[1].args.includes("--execute"));
  assert(rows.every(row=>!row.args.some((arg:string)=>arg.startsWith("--max-gas-wei"))),"Neither startup nor execution injects the superseded lifetime ceiling");
  assert(rows.every(row=>!row.args.some((arg:string)=>arg.startsWith("--max-untracked"))),"Unknown recovery remains disabled in both children");
});
test("a missing startup seal never starts execution even if its read-only CLI exits zero", async t => {
  const f = await fixture(t, true, false); await assert.rejects(f.run(), /seal is pending/); const rows = await f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].hasWallet, false);
});
test("one owner switch false continues audit-only and canonical release edits fail closed", async t => {
  const f = await fixture(t, true); f.config.enableBaseTransactions = false; await writeFile(f.cfg, JSON.stringify(f.config), { mode: 0o600 }); await f.run(); assert.equal((await f.rows())[0].hasWallet, false);
  await writeFile(join(f.checkout, "package.json"), '{"type":"module","changed":true}'); await assert.rejects(f.run(), /clean detached/);
});
test("dotenv in the isolated operator cwd is rejected before any child can reload a wallet", async t => {
  const f = await fixture(t); await writeFile(join(f.operator, ".env"), "MUSEGOD_KEEPER_PRIVATE_KEY=never"); await assert.rejects(f.run(), /must not contain a dotenv/);
});

async function startWrapper(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, [wrapperUrl.pathname, `--config=${f.cfg}`, "--run"], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const completion = new Promise<void>((done, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? done() : reject(Error(stderr))); });
  const untilStartup = async () => { for (let index = 0; index < 100; index++) { try { if ((await f.rows()).length) return; } catch {} await new Promise(done => setTimeout(done, 20)); } throw Error("Offline startup never began"); };
  return { child, completion, untilStartup };
}
test("SIGTERM during explicit startup does not launch the signer", async t => {
  const f = await fixture(t, true, true, 500), run = await startWrapper(f); await run.untilStartup(); run.child.kill("SIGTERM"); await run.completion;
  const rows = await f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].hasWallet, false);
});
test("owner disarm during explicit startup is reread and cannot be overwritten by a stale execute choice", async t => {
  const f = await fixture(t, true, true, 500), run = await startWrapper(f); await run.untilStartup(); f.config.executeWhenReady = false; await writeFile(f.cfg, JSON.stringify(f.config), { mode: 0o600 }); await run.completion;
  const rows = await f.rows(); assert.equal(rows.length, 2); assert(rows.every(row => !row.hasWallet)); assert.equal(JSON.parse(await readFile(f.cfg, "utf8")).executeWhenReady, false);
});

test("shared release guard refuses a publicly accessible operator directory before any Base child",async t=>{const f=await fixture(t);await chmod(f.operator,0o755);await assert.rejects(f.run(),/0700/);});
