import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";

const LEASE_MS = 30_000;
export type BaseProcessLease = (() => Promise<void>) & { assertHeld(): void };
export class BaseProcessLeaseLostError extends Error {
  constructor() { super("Base process lease expired or its kernel guard stopped; signing is stopped"); this.name = "BaseProcessLeaseLostError"; }
}
export function baseProcessStartIdentity(pid: number) {
  try {
    if (process.platform === "linux") {
      // /proc does not depend on busybox ps options or the current locale.
      // The comm field may itself contain spaces and parentheses.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(") ");
      const start = end < 0 ? undefined : stat.slice(end + 2).trim().split(/\s+/)[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return start && /^\d+$/.test(start) && /^[\da-f-]{36}$/i.test(boot) ? `linux:${boot}:${start}` : null;
    }
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000,
      env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" } }).trim();
    return start ? `darwin:${start}` : null;
  }
  catch { return null; }
}
function machineIdentity() {
  try {
    const identity = process.platform === "darwin" ? execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8", timeout: 1_000, env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
    }).match(/"IOPlatformUUID"\s*=\s*"([\da-f-]{36})"/i)?.[1] : readFileSync("/etc/machine-id", "utf8").trim();
    return identity && /^[\da-f-]{32,36}$/i.test(identity) ? createHash("sha256").update(identity.toLowerCase()).digest("hex") : null;
  } catch { return null; }
}
function confirmedDead(record: any, machineId: string) {
  // Legacy same-host PID locks remain supported. A foreign host, damaged
  // record or uncertain process query needs operator investigation.
  if (!record || typeof record !== "object" || Array.isArray(record) ||
    (record.machineId !== undefined ? typeof record.machineId !== "string" || !/^[\da-f]{64}$/i.test(record.machineId) || record.machineId !== machineId : record.host && record.host !== hostname()) ||
    !Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  try { process.kill(record.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  const current = baseProcessStartIdentity(record.pid);
  // Untagged legacy ps records cannot conclusively identify a reused live PID.
  return record.processIdentityVersion === 2 && typeof record.processStart === "string" &&
    /^(?:darwin:.+|linux:[\da-f-]{36}:\d+)$/.test(record.processStart) && !!current && current !== record.processStart;
}

/** Base host only: the kernel guard serializes acquisition and stale recovery.
 * Never unlink the guard inode, or expire a lock held by a live process.
 * Closing the parent's pipe (including SIGKILL/OOM/reboot) releases it. */
export async function acquireBaseProcessLease(path: string): Promise<BaseProcessLease> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`, token = randomUUID();
  const program = "process.stdout.write('held\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
  const darwin = process.platform === "darwin";
  const guard = spawn(darwin ? "/usr/bin/lockf" : "flock", darwin ?
    ["-k", "-t", "0", `${path}.guard`, process.execPath, "-e", program] :
    ["-n", `${path}.guard`, process.execPath, "-e", program], { stdio: ["pipe", "pipe", "pipe"],
      // A process guardian needs no wallet, RPC, storage or dotenv secrets.
      env: { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL } });
  let held = false, released = false, failed: Error | undefined;
  const closed = new Promise<void>(resolve => guard.once("close", () => resolve()));
  const stopGuard = async () => { guard.stdin.end(); await closed; };
  const fail = () => { held = false; failed ??= new Error("Base journal lock already exists or its kernel guard stopped; signing is stopped"); };
  guard.on("error", fail); guard.on("exit", fail);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { guard.kill(); reject(new Error("Base process lease acquisition timed out")); }, 5_000);
      const done = (error?: Error) => { clearTimeout(timer); guard.stdout.removeListener("data", data); guard.removeListener("error", errorEvent); guard.removeListener("exit", exit); error ? reject(error) : resolve(); };
      let output = "";
      const data = (bytes: Buffer) => { output += bytes.toString(); if (output === "held\n") { held = true; done(); } };
      const errorEvent = () => done(new Error("Base kernel lock utility is unavailable; signing is stopped"));
      const exit = () => done(new Error("Base journal lock already exists; a live host writer cannot be displaced"));
      guard.stdout.on("data", data); guard.once("error", errorEvent); guard.once("exit", exit);
    });
    let existing: any, exists = true;
    try { existing = JSON.parse(await readFile(lockPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Base journal lock already exists with unreadable metadata; operator must investigate");
      exists = false;
    }
    const machineId = machineIdentity();
    if (!machineId) throw new Error("Base machine identity is unavailable; signing is stopped");
    if (exists && !confirmedDead(existing, machineId)) throw new Error("Base journal lock already exists; owner is live or uncertain, operator must investigate");
    const acquiredAt = Date.now(), identity = baseProcessStartIdentity(process.pid);
    if (!identity) throw new Error("Base process start identity is unavailable; signing is stopped");
    const writeLease = async () => {
      if (!held || released) throw failed ?? new Error("Base process lease was lost");
      const now = Date.now(), temporary = `${lockPath}.${token}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ token, pid: process.pid, host: hostname(), machineId, processIdentityVersion: 2, processStart: identity, acquiredAt,
          heartbeatAt: now, leaseUntil: now + LEASE_MS }), { mode: 0o600 });
        if (!held || released) throw new Error("Base process lease was lost");
        await rename(temporary, lockPath);
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    };
    await writeLease();
    let heartbeat: Promise<void> = Promise.resolve(), expires = Date.now() + LEASE_MS;
    const interval = setInterval(() => {
      heartbeat = heartbeat.then(writeLease).then(() => { expires = Date.now() + LEASE_MS; }).catch(error => { failed = error; held = false; });
    }, LEASE_MS / 3);
    interval.unref();
    const release = async () => {
      if (released) return;
      clearInterval(interval); await heartbeat; released = true;
      try {
        if (held) {
          const record = JSON.parse(await readFile(lockPath, "utf8"));
          if (record.token === token) await unlink(lockPath);
        }
      } finally { await stopGuard(); }
    };
    return Object.assign(release, { assertHeld() {
      if (!held || released || failed || Date.now() > expires) throw new BaseProcessLeaseLostError();
    } });
  } catch (error) { await stopGuard(); throw error; }
}
