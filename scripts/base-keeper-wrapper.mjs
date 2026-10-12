#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const executeFile = promisify(execFile);
export const KEEPER_LAUNCHD_POLICY = Object.freeze({ KeepAlive: Object.freeze({ SuccessfulExit: false }), ThrottleInterval: 300, ExitTimeOut: 120 });
const FIELDS = ["nodePath", "checkout", "environmentFile", "operatorDirectory", "releaseTag", "expectedCommit", "executeWhenReady", "enableBaseTransactions"];
const ENVIRONMENT = ["PATH", "HOME", "TMPDIR", "NODE_ENV", "ALCHEMY_API_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "LI_FI_API_KEY", "LIFI_API_KEY", "LIFI_INTEGRATOR", "BASE_FEE_COLLECTOR_ADDRESS", "BASE_PLATFORM_TREASURY"];
export function validateBaseKeeperWrapperConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key)) || FIELDS.some(key => !Object.hasOwn(value, key))) throw new Error("Private keeper configuration has invalid fields");
  for (const key of ["nodePath", "checkout", "environmentFile", "operatorDirectory"]) if (typeof value[key] !== "string" || !isAbsolute(value[key])) throw new Error("Keeper paths must be private absolute paths");
  if (!/^build-[0-9]+-[0-9]+$/.test(value.releaseTag) || !/^[a-f0-9]{40}$/.test(value.expectedCommit)) throw new Error("The published build tag and exact commit are required");
  if (typeof value.executeWhenReady !== "boolean" || typeof value.enableBaseTransactions !== "boolean") throw new Error("Owner execution switches must be explicit booleans");
  if (/(?:\.codex|\.claude)\/worktrees(?:\/|$)/.test(value.checkout)) throw new Error("A development worktree cannot run the keeper");
  if (resolve(value.operatorDirectory) === resolve(value.checkout) || resolve(value.environmentFile).startsWith(`${resolve(value.checkout)}/`)) throw new Error("Private operator paths must stay outside the release checkout");
  return value;
}
export function baseKeeperChildEnvironment(text, inherited = {}) {
  const environment = Object.fromEntries(ENVIRONMENT.flatMap(key => inherited[key] ? [[key, inherited[key]]] : []));
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (!match || !ENVIRONMENT.includes(match[1]) || ["HOME", "PATH", "TMPDIR"].includes(match[1])) continue;
    let value = match[2]; if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1); else value = value.replace(/\s+#.*$/, "");
    environment[match[1]] = value;
  }
  return { ...environment, CHAIN_MODE: "base", SUPABASE_DATA_SCOPE: "base", ENABLE_BASE_TRANSACTIONS: "false", NODE_ENV: "production" };
}
export async function inspectKeeperRelease(config, configurationPath, entrypoint) {
  for (const item of [configurationPath, config.environmentFile]) { const info = await stat(item); if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Private keeper files must deny group and other access"); }
  const checkout = await realpath(config.checkout), operator = await realpath(config.operatorDirectory);
  if (checkout !== resolve(config.checkout) || operator !== resolve(config.operatorDirectory) || operator.startsWith(`${checkout}/`)) throw new Error("Canonical private paths differ from the reviewed configuration");
  if (/(?:\.codex|\.claude)\/worktrees(?:\/|$)/.test(checkout)) throw new Error("A development worktree cannot run the keeper");
  const privacy = await stat(operator); if (!privacy.isDirectory() || (privacy.mode & 0o777) !== 0o700) throw new Error("The private operator directory must have mode 0700");
  const git = async (...args) => (await executeFile("git", ["-C", checkout, ...args])).stdout.trim();
  if (await git("rev-parse", "HEAD") !== config.expectedCommit || await git("rev-parse", `${config.releaseTag}^{commit}`) !== config.expectedCommit) throw new Error("Release tag, checkout and expected commit differ");
  let branch; try { branch = await git("symbolic-ref", "--quiet", "HEAD"); } catch { branch = ""; }
  if (branch || await git("status", "--porcelain")) throw new Error("The keeper must run a clean detached release checkout");
  for (const item of [config.nodePath, join(checkout, entrypoint)]) if (!(await stat(item)).isFile()) throw new Error("The keeper runtime or entry point is missing");
  try { await stat(join(operator, ".env")); throw new Error("The private operator directory must not contain a dotenv file"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { checkout, operator };
}
export async function prepareBaseKeeperWrapper(path) {
  if (!isAbsolute(path)) throw new Error("Select one absolute private configuration path");
  let rawConfig; try { rawConfig = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("The private keeper configuration could not be parsed"); }
  const config = validateBaseKeeperWrapperConfig(rawConfig);
  const { checkout, operator } = await inspectKeeperRelease(config, path, "scripts/base-buyback-keeper.ts");
  const text = await readFile(config.environmentFile, "utf8"), environment = baseKeeperChildEnvironment(text, process.env);
  if (!environment.ALCHEMY_API_KEY || !environment.SUPABASE_URL || !environment.SUPABASE_SECRET_KEY) throw new Error("The existing Alchemy and storage credentials are required");
  const loader = createRequire(join(checkout, "package.json")).resolve("tsx");
  const args = ["--import", loader, join(checkout, "scripts/base-buyback-keeper.ts"), "--audit-only", "--interval=300000", `--operator-dir=${operator}`];
  let executionEnvironment;
  if (config.executeWhenReady && config.enableBaseTransactions) {
    const key = text.split(/\r?\n/).map(line => line.match(/^\s*(?:export\s+)?MUSEGOD_KEEPER_PRIVATE_KEY\s*=\s*["']?(0x[\da-fA-F]{64})["']?\s*$/)).find(Boolean)?.[1];
    if (!key) throw new Error("Owner-authorized execution requires the dedicated keeper key");
    const accountModule = await import(pathToFileURL(createRequire(join(checkout, "package.json")).resolve("viem/accounts")).href);
    let keeper; try { keeper = accountModule.privateKeyToAccount(key).address; } catch { throw new Error("The dedicated keeper key is invalid"); }
    const manifest = JSON.parse(await readFile(join(checkout, "contracts/artifacts/base-collector-deployment.json"), "utf8"));
    if (keeper.toLowerCase() !== manifest.activation?.trustedSplitsAcceptance?.keeper?.toLowerCase()) throw new Error("The dedicated keeper key differs from the fixed owner acceptance");
    executionEnvironment = { ...environment, MUSEGOD_KEEPER_PRIVATE_KEY: key, ENABLE_BASE_TRANSACTIONS: "true" };
  }
  return { config, environment, executionEnvironment, command: config.nodePath, args, cwd: operator };
}
export async function runBaseKeeperWrapper(args = process.argv.slice(2)) {
  if (args.length !== 2 || args.filter(arg => arg.startsWith("--config=")).length !== 1 || args.filter(arg => ["--check", "--run"].includes(arg)).length !== 1) throw new Error("Use --config=/private/config.json with --check or --run");
  const prepared = await prepareBaseKeeperWrapper(args.find(arg => arg.startsWith("--config=")).slice(9));
  const armed = !!prepared.executionEnvironment;
  console.log(JSON.stringify({ state: "prepared", mode: armed ? "owner_authorized_execute" : "audit_only", releaseTag: prepared.config.releaseTag,
    expectedCommit: prepared.config.expectedCommit, executeWhenReady: prepared.config.executeWhenReady, enableBaseTransactions: prepared.config.enableBaseTransactions }));
  if (args.includes("--check")) return;
  let stopping = false, child;
  const stop = () => { stopping = true; child?.kill("SIGTERM"); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const launch = (arguments_, environment, seal = false) => new Promise((done, reject) => {
    if (stopping) { done(false); return; }
    child = spawn(prepared.command, arguments_, { cwd: prepared.cwd, env: environment, stdio: seal ? ["ignore", "pipe", "inherit"] : "inherit" });
    let output = "";
    if (seal) child.stdout.on("data", data => { output += data.toString(); if (output.length > 1_048_576) child.kill("SIGTERM"); });
    child.once("error", reject); child.once("exit", (code, signal) => {
      if (stopping) { done(false); return; }
      if (code !== 0 || output.length > 1_048_576) { reject(new Error(`Keeper startup failed (${signal ?? code})`)); return; }
      const verified = !seal || output.split(/\r?\n/).some(line => { try { return JSON.parse(line).mode === "startup_verified"; } catch { return false; } });
      if (!verified) { reject(new Error("The explicit one-time startup seal is pending; no execution was started")); return; }
      done(true);
    });
  });
  try {
    if (armed) {
      if (!await launch([...prepared.args, "--once"], prepared.environment, true) || stopping) return;
      // Re-read the private switches and release pin after startup. A stop or
      // owner disarm while the read-only check ran must never launch a signer.
      const fresh = await prepareBaseKeeperWrapper(args.find(arg => arg.startsWith("--config=")).slice(9));
      if (stopping) return;
      for (const key of ["nodePath", "checkout", "environmentFile", "operatorDirectory", "releaseTag", "expectedCommit"]) if (fresh.config[key] !== prepared.config[key]) throw new Error("The release or private journal binding changed during startup; restart explicitly");
      if (!fresh.executionEnvironment) { await launch(fresh.args, fresh.environment); return; }
      const executionArgs = fresh.args.map(arg => arg === "--audit-only" ? "--execute" : arg);
      executionArgs.push("--max-gas-wei=16000000000000"); // Unknown recovery remains disabled.
      await launch(executionArgs, fresh.executionEnvironment);
    } else await launch(prepared.args, prepared.environment);
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }

}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runBaseKeeperWrapper().catch(error => { console.error(error.message); process.exitCode = 1; });
