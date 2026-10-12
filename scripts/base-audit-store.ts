import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ContractIdentityStore as BaseAuditStore } from "../server/contract-identity";

const CACHE_LOCK_LEASE_MS = 10_000;
const lockObservations = new Map<string, { inode: number; firstSeen: number }>();
const processStart = (pid: number) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000 }).trim() || null; }
  catch { return null; }
};
const ownProcessStart = processStart(process.pid);
/** Cache writers hold a short local lock. A restored/dead lock is disposable;
 * a live local process with the same start identity is never evicted by age. */
async function acquireAuditCacheLock(path: string): Promise<{ assertHeld(): void; release(): void }> {
  const lockPath = `${path}.lock`, token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), processStart: ownProcessStart, acquiredAt: Date.now() }));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      lockObservations.delete(lockPath);
      return {
        assertHeld() { if (JSON.parse(readFileSync(lockPath, "utf8")).token !== token) throw new Error("Private Base audit cache lease changed; retry"); },
        release() {
          try { if (JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        },
      };
    } catch (error) {
      if (fd !== undefined) { closeSync(fd); unlinkSync(lockPath); throw error; }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = statSync(lockPath), now = Date.now();
        let record: any;
        try { record = JSON.parse(readFileSync(lockPath, "utf8")); } catch { record = null; }
        const observed = lockObservations.get(lockPath);
        if (!observed || observed.inode !== stat.ino) lockObservations.set(lockPath, { inode: stat.ino, firstSeen: now });
        const created = Number.isSafeInteger(record?.acquiredAt) && record.acquiredAt >= 0 && record.acquiredAt <= now ? record.acquiredAt :
          stat.mtimeMs <= now ? stat.mtimeMs : lockObservations.get(lockPath)!.firstSeen;
        let alive: boolean | undefined;
        if (record?.host === hostname() && Number.isSafeInteger(record.pid) && record.pid > 0) {
          try { process.kill(record.pid, 0); alive = true; } catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
          if (alive) {
            const actual = record.pid === process.pid ? ownProcessStart : processStart(record.pid);
            // PID existence alone cannot authenticate a restored lock: PID reuse
            // and unavailable start metadata must follow the finite cache lease.
            alive = typeof record.processStart === "string" && actual ? actual === record.processStart : undefined;
          }
        }
        if (alive === false || alive !== true && now - created >= CACHE_LOCK_LEASE_MS) {
          const current = statSync(lockPath);
          if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) unlinkSync(lockPath);
          continue;
        }
      } catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") continue; throw failure; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error("Private Base audit cache is busy; retry after the live writer finishes");
}

/** Private operator/master-CI audit progress. Public runtime uses its existing server-only persistent store. */
export function baseOperatorAuditStore(directory = resolve(".cache/base-native-audit")): BaseAuditStore {
  const path = (id: string) => {
    if (!/^internal_native_[a-z0-9_]+:0x[\da-f]{64}$/i.test(id)) throw new Error("Invalid private Base audit identity");
    return join(directory, `${id.replace(":", "-")}.json`);
  };
  const read = (id: string) => {
    try {
      const row = JSON.parse(readFileSync(path(id), "utf8"));
      return row && typeof row === "object" && !Array.isArray(row) && row.id === id && /^internal_native_[a-z0-9_]+$/.test(String(row.protocol)) ? row : null;
    } catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  return {
    async getBuybackBatch(id) { return read(id); },
    async compareAndSetBuybackAudit(row, expected) {
      if (!/^internal_native_[a-z0-9_]+$/.test(String(row.protocol)) || expected !== null && (expected.id !== row.id || !/^internal_native_[a-z0-9_]+$/.test(String(expected.protocol))))
        throw new Error("Invalid private Base audit payload");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(row.id), lock = await acquireAuditCacheLock(destination);
      try {
        lock.assertHeld();
        if (!isDeepStrictEqual(read(row.id), expected === null ? null : JSON.parse(JSON.stringify(expected)))) return false;
        const temporary = `${destination}.${process.pid}.tmp`, fd = openSync(temporary, "w", 0o600);
        try { writeFileSync(fd, JSON.stringify(row)); fsyncSync(fd); } finally { closeSync(fd); }
        lock.assertHeld(); renameSync(temporary, destination);
        const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
        return true;
      } finally { lock.release(); }
    },
  };
}
