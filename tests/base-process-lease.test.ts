import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireBaseProcessLease, baseProcessStartIdentity, BaseProcessLeaseLostError } from "../scripts/base-process-lease";

test("Base live leases cannot be displaced by expiration or concurrent acquisition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "base-lease-live-")), path = join(directory, "audit.json");
  let release: Awaited<ReturnType<typeof acquireBaseProcessLease>> | undefined;
  try {
    release = await acquireBaseProcessLease(path); release.assertHeld();
    const record = JSON.parse(await readFile(`${path}.lock`, "utf8"));
    assert.equal(record.pid, process.pid); assert(record.leaseUntil > record.heartbeatAt);
    await writeFile(`${path}.lock`, JSON.stringify({ ...record, leaseUntil: 0, acquiredAt: 0 }));
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => acquireBaseProcessLease(path)));
    assert(outcomes.every(result => result.status === "rejected")); release.assertHeld();
    await release(); assert.throws(() => release!.assertHeld(), /expired|stopped/); release = undefined;
    const next = await acquireBaseProcessLease(path); await next();
  } finally { await release?.(); await rm(directory, { recursive: true, force: true }); }
});

test("Base stale PID is recoverable, but damaged or foreign-host ownership stays fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "base-lease-stale-")), path = join(directory, "audit.json");
  try {
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 99999999, acquiredAt: 0 }));
    const recovered = await acquireBaseProcessLease(path); recovered.assertHeld(); await recovered();
    for (const record of ["damaged", "null", JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: 0 }),
      JSON.stringify({ pid: 99999999, host: "another-host", leaseUntil: 0 })]) {
      await writeFile(`${path}.lock`, record);
      await assert.rejects(() => acquireBaseProcessLease(path), /operator must investigate/);
      assert.equal(await readFile(`${path}.lock`, "utf8"), record);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("expired heartbeat is a fatal typed lease failure, never an audit-loop retry", async t => {
  const directory = await mkdtemp(join(tmpdir(), "base-lease-expired-")), path = join(directory, "audit.json");
  const release = await acquireBaseProcessLease(path);
  try {
    const now = Date.now(); t.mock.method(Date, "now", () => now + 31_000);
    assert.throws(() => release.assertHeld(), BaseProcessLeaseLostError);
  } finally { t.mock.restoreAll(); await release(); await rm(directory, { recursive: true, force: true }); }
});

test("a renamed network hostname cannot strand a confirmed-dead lease on the same machine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "base-lease-hostname-")), path = join(directory, "audit.json");
  try {
    const release = await acquireBaseProcessLease(path);
    const record = JSON.parse(await readFile(`${path}.lock`, "utf8")); await release();
    await writeFile(`${path}.lock`, JSON.stringify({ ...record, pid: 99999999, host: "former-network-hostname", leaseUntil: 0 }));
    const recovered = await acquireBaseProcessLease(path);
    try { recovered.assertHeld(); } finally { await recovered(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Linux process identity survives busybox ps without lstart and rejects incomplete proc facts", async t => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!, boot = "12345678-1234-1234-1234-123456789abc";
  const stat = `42 (name with ) parentheses) ${["S", ...Array(18).fill("0"), "9001"].join(" ")}`;
  let broken = false, psCalls = 0;
  t.mock.method(childProcess, "execFileSync", (() => { psCalls++; throw new Error("busybox ps: unsupported lstart"); }) as any);
  t.mock.method(fs, "readFileSync", ((path: string) => {
    if (path === "/proc/42/stat") return broken ? "42 incomplete" : stat;
    if (path === "/proc/sys/kernel/random/boot_id") return boot;
    throw new Error("unexpected process identity read");
  }) as any);
  syncBuiltinESMExports(); Object.defineProperty(process, "platform", { ...original, value: "linux" });
  try {
    assert.equal(baseProcessStartIdentity(42), `linux:${boot}:9001`); assert.equal(psCalls, 0);
    broken = true; assert.equal(baseProcessStartIdentity(42), null); assert.equal(psCalls, 0);
  } finally { Object.defineProperty(process, "platform", original); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("corrupt machine identity and uncertain live-PID metadata cannot waive a Base lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "base-lease-identity-")), path = join(directory, "audit.json");
  try {
    const release = await acquireBaseProcessLease(path), original = JSON.parse(await readFile(`${path}.lock`, "utf8")); await release();
    for (const record of [{ ...original, pid: 99999999, machineId: "" }, { ...original, pid: process.pid, processStart: "unrecognized" },
      { ...original, pid: process.pid, processIdentityVersion: undefined, processStart: "an old ps format" }]) {
      await writeFile(`${path}.lock`, JSON.stringify(record));
      await assert.rejects(() => acquireBaseProcessLease(path), /operator must investigate/);
      assert.equal(await readFile(`${path}.lock`, "utf8"), JSON.stringify(record));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real SIGKILL releases the kernel guard and only one concurrent recovery takes the Base lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "base-lease-crash-")), path = join(directory, "audit.json");
  const module = resolve("scripts/base-process-lease.ts");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {acquireBaseProcessLease} from ${JSON.stringify(module)};await acquireBaseProcessLease(${JSON.stringify(path)});process.stdout.write('ready\\n');setInterval(()=>{},1000);`],
    { stdio: ["ignore", "pipe", "pipe"] });
  let winner: Awaited<ReturnType<typeof acquireBaseProcessLease>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lease child did not start")), 5_000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); }); child.once("error", reject);
    });
    await assert.rejects(() => acquireBaseProcessLease(path), /lock already exists/);
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await exited;
    // The guard's child sees pipe EOF; both concurrent contenders use the
    // same persistent kernel inode, preventing stale-unlink/create races.
    let outcomes: PromiseSettledResult<Awaited<ReturnType<typeof acquireBaseProcessLease>>>[] = [];
    for (let attempt = 0; attempt < 10 && !winner; attempt++) {
      outcomes = await Promise.allSettled([acquireBaseProcessLease(path), acquireBaseProcessLease(path)]);
      const winners = outcomes.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBaseProcessLease>>> => result.status === "fulfilled");
      assert(winners.length <= 1); winner = winners[0]?.value;
      if (!winner) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert(winner); winner.assertHeld();
    const liveRecord = await readFile(`${path}.lock`, "utf8");
    await assert.rejects(() => acquireBaseProcessLease(path), /lock already exists/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), liveRecord);
  } finally { child.kill(); await winner?.(); await rm(directory, { recursive: true, force: true }); }
});
