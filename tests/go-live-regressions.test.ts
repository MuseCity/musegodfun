import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { PoolIdentityError } from "../server/service";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { syntheticToken } from "./fixtures";
import { engineStatusReason } from "../server/buyback-engine";
import { IngressLimiter, INGRESS_CLASSES, RECOVERY_PER_MINUTE, ingressClass } from "../server/abuse";
import { BODY_READ_DEADLINE_MS, readBoundedBody } from "../server/http-security";
import { BUYBACK_FORWARDER_ALLOWANCE_CAP } from "../src/lib/buyback-engine";
import type { Address } from "viem";

const weth = ROBINHOOD_STOCKS.find(a => a.symbol === "WETH")!.address;

async function httpFixture(run: (entry: ReturnType<typeof createApp>, origin: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "go-live-http-"));
  const runtime = runtimeFromEnv(4663, {NODE_ENV:"test", CHAIN_MODE:"fork", FORK_CHAIN_ID:"4663", DATA_DIR:directory,
    PLATFORM_TREASURY:"0x2222222222222222222222222222222222222222"});
  const entry = createApp(undefined, "loopback", runtime);
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  try { await run(entry, `http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); entry.service.store.close(); rmSync(directory,{recursive:true,force:true}); }
}

test("token detail returns stored metadata when the pool state RPC fails, and 404 only for unregistered tokens", async () => {
  await httpFixture(async ({service}, origin) => {
    const token = syntheticToken({mode:"fork", deploymentChainId:4663, quoteAddress:weth, address:"0x0000000000000000000000000000000000000abc" as Address});
    await service.store.saveToken(token);
    let failure: Error | null = new Error("RPC request timed out");
    service.state = async () => { if (failure) throw failure; return {token, state:{status:2} as never}; };
    const unavailable = await fetch(`${origin}/api/tokens/${token.address}`);
    assert.equal(unavailable.status, 200);
    const body = await unavailable.json();
    assert.equal(body.token.name, token.name); assert.equal(body.state, null); assert.match(body.stateError, /timed out/);
    failure = null;
    assert.deepEqual((await (await fetch(`${origin}/api/tokens/${token.address}`)).json()).state, {status:2});
    const missing = await fetch(`${origin}/api/tokens/0x0000000000000000000000000000000000000def`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "TOKEN_NOT_REGISTERED");
  });
});

test("engine status names pending activation first and leaves source authorization to its own section", () => {
  const over = { sourceDeployed: true, sourceAllowance: String(BUYBACK_FORWARDER_ALLOWANCE_CAP + 1n) };
  assert.match(engineStatusReason({ ...over, activated: false })!, /awaiting activation/);
  assert.equal(engineStatusReason({ ...over, activated: true }), null, "an over-cap allowance is reported once, by sourceAuthorizationError");
  assert.match(engineStatusReason({ sourceDeployed: true, sourceAllowance: "0", activated: false })!, /awaiting activation/);
  assert.match(engineStatusReason({ sourceDeployed: true, sourceAllowance: "0", activated: true })!, /WETH approval/);
  assert.match(engineStatusReason({ sourceDeployed: false, sourceAllowance: "0", activated: false })!, /not deployed/);
});

test("slow workflow sources cannot starve page reads or receipt recovery", () => {
  const limiter = new IngressLimiter(), held: { release(): void }[] = [];
  const workflow = INGRESS_CLASSES.workflow;
  for (let source = 0; source * workflow.perSource < workflow.total; source++)
    for (let i = 0; i < workflow.perSource; i++) {
      const admitted = limiter.admit(`192.0.2.${source + 1}`, "/api/launch/prepare", 1000);
      assert.equal(admitted.status, undefined); held.push(admitted);
    }
  assert.equal(limiter.admit("198.51.100.1", "/api/chains/4663/launch/simulate", 1000).status, 503, "only the full class refuses");
  for (const path of ["/api/config", "/api/tokens", "/api/chains/4663/launch/register", "/api/token-images"]) {
    const admitted = limiter.admit("198.51.100.1", path, 1000);
    assert.equal(admitted.status, undefined, path); assert.equal(admitted.challenge, false, path); admitted.release();
  }
  held.forEach((entry) => entry.release());
  assert.equal(limiter.admit("198.51.100.1", "/api/launch/prepare", 1000).status, undefined);
});

test("page reads need several sources to fill and recovery is bounded without challenges", () => {
  const limiter = new IngressLimiter(), held: { release(): void }[] = [];
  const read = INGRESS_CLASSES.read, fillers = Math.ceil(read.total / read.perSource);
  assert(fillers >= 4, "at least four sources are needed to fill page reads");
  for (let source = 0; source < fillers - 1; source++)
    for (let i = 0; i < read.perSource; i++) held.push(limiter.admit(`192.0.2.${source + 1}`, "/api/stocks", 1000));
  assert.equal(limiter.admit("192.0.2.1", "/api/config", 1000).status, 429, "per-source read cap");
  const other = limiter.admit("198.51.100.9", "/api/config", 1000); assert.equal(other.status, undefined); other.release();
  held.forEach((entry) => entry.release());
  assert.equal(ingressClass("/api/chains/8453/launch/register?x=1"), "recovery");
  assert.equal(ingressClass("/api/buyback/batches/abc/track"), "recovery");
  assert.equal(ingressClass("/api/musegod/quote"), "workflow");
  assert.equal(ingressClass("/api/rpc"), "read");
  const recovery = new IngressLimiter(), open = Array.from({ length: INGRESS_CLASSES.recovery.perSource }, () => recovery.admit("192.0.2.50", "/api/launch/register", 1000));
  const third = recovery.admit("192.0.2.50", "/api/launch/register", 1000);
  assert.equal(third.status, 429); assert.equal(third.challenge, false);
  open.forEach((entry) => entry.release());
  assert(RECOVERY_PER_MINUTE >= 4 * 8 * 3, "a wallet with a dozen unregistered launches stays within its own background polling");
  for (let i = 0; i < RECOVERY_PER_MINUTE; i++) { const row = recovery.admit("192.0.2.51", "/api/launch/register", 2000 + i); assert.equal(row.status, undefined); assert.equal(row.challenge, false); row.release(); }
  const limited = recovery.admit("192.0.2.51", "/api/launch/register", 2000 + RECOVERY_PER_MINUTE);
  assert.equal(limited.status, 429); assert.equal(limited.challenge, false, "recovery is rate-limited without a challenge");
  const later = recovery.admit("192.0.2.51", "/api/launch/register", 63_000); assert.equal(later.status, undefined); later.release();
});

test("a hung pool state read still returns stored metadata well before the client's 35 second deadline", async (context) => {
  await httpFixture(async ({service}) => {
    const token = syntheticToken({mode:"fork", deploymentChainId:4663, quoteAddress:weth, address:"0x0000000000000000000000000000000000000abd" as Address});
    await service.store.saveToken(token);
    service.state = () => new Promise(() => {});
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let settled = false;
    const pending = service.tokenDetail(token.address).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(7_999); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    context.mock.timers.tick(1);
    const detail = await pending;
    assert.equal(detail?.token.name, token.name); assert.equal(detail?.state, null); assert.match(detail!.stateError!, /timed out/);
    context.mock.timers.reset();
  });
});

test("trickled request bodies end as 408 in either cancellation style, oversized ones as 413", async () => {
  const stream = (chunks: Uint8Array[], close: boolean) => new ReadableStream<Uint8Array>({ start(controller) {
    chunks.forEach((chunk) => controller.enqueue(chunk)); if (close) controller.close();
  } });
  const complete = await readBoundedBody(stream([new Uint8Array([1, 2]), new Uint8Array([3])], true), 10, 1000);
  assert.deepEqual("bytes" in complete ? [...complete.bytes] : complete, [1, 2, 3]);
  assert.deepEqual(await readBoundedBody(stream([new Uint8Array(11)], true), 10, 1000), { status: 413 });
  assert.deepEqual(await readBoundedBody(stream([new Uint8Array([1])], false), 10, 20), { status: 408 }, "a pending read resolved by cancellation");
  // workerd rejects a read that is pending when its reader is cancelled.
  const rejecting = { getReader: () => {
    let fail: (error: Error) => void = () => {};
    return { read: () => new Promise<never>((_, reject) => { fail = reject; }), cancel: async () => { fail(new Error("This ReadableStream was canceled")); } };
  } };
  assert.deepEqual(await readBoundedBody(rejecting, 10, 20), { status: 408 });
  const broken = { getReader: () => ({ read: async () => { throw new Error("network reset"); }, cancel: async () => {} }) };
  await assert.rejects(() => readBoundedBody(broken, 10, 1000), /network reset/, "a genuine read failure is not disguised as a timeout");
  assert.equal(BODY_READ_DEADLINE_MS, 10_000, "standard and 256KiB recovery bodies share one short deadline");
});

test("token detail reports a contradicting pool as invalid and shares one state read per token", async () => {
  await httpFixture(async ({service}, origin) => {
    const token = syntheticToken({mode:"fork", deploymentChainId:4663, quoteAddress:weth, address:"0x0000000000000000000000000000000000000abe" as Address});
    await service.store.saveToken(token);
    service.state = async () => { throw new PoolIdentityError("The pool identity or locked state is invalid"); };
    const invalid = await (await fetch(`${origin}/api/tokens/${token.address}`)).json();
    assert.equal(invalid.state, null); assert.equal(invalid.stateInvalid, true); assert.match(invalid.stateError, /pool identity/);
    service.state = async () => { throw new Error("RPC request timed out"); };
    assert.equal((await (await fetch(`${origin}/api/tokens/${token.address}`)).json()).stateInvalid, undefined, "an outage is not an integrity failure");
    let calls = 0, finish!: (value: never) => void;
    service.state = () => { calls++; return new Promise((resolve) => { finish = resolve as never; }); };
    const first = await service.tokenDetail(token.address, 20);
    assert.equal(first?.state, null, "the first viewer times out");
    const [second, third] = await Promise.all([service.tokenDetail(token.address, 20), service.tokenDetail(token.address, 20)]);
    assert.equal(second?.state, null); assert.equal(third?.state, null);
    assert.equal(calls, 1, "abandoned and concurrent requests share the read still in flight");
    finish({ token, state: { status: 1 } } as never);
    await new Promise((resolve) => setImmediate(resolve));
    service.state = async () => { calls++; return { token, state: { status: 2 } } as never; };
    assert.deepEqual((await service.tokenDetail(token.address, 20))?.state, { status: 2 }, "a settled read is not reused; the next request starts fresh");
    assert.equal(calls, 2);
  });
});
