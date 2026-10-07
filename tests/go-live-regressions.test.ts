import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { syntheticToken } from "./fixtures";
import { engineStatusReason } from "../server/buyback-engine";
import { IngressLimiter, INGRESS_CLASSES, ingressClass } from "../server/abuse";
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
  for (let i = 0; i < 30; i++) { const row = recovery.admit("192.0.2.51", "/api/launch/register", 2000 + i); assert.equal(row.status, undefined); assert.equal(row.challenge, false); row.release(); }
  const limited = recovery.admit("192.0.2.51", "/api/launch/register", 2100);
  assert.equal(limited.status, 429); assert.equal(limited.challenge, false, "recovery is rate-limited without a challenge");
  const later = recovery.admit("192.0.2.51", "/api/launch/register", 63_000); assert.equal(later.status, undefined); later.release();
});
