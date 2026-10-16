import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAutoQuoteScheduler } from "../src/lib/auto-quote";

const input = { key: "buy:eth:0.001:100", lifi: false, valid: true, pool: true, visible: true, busy: false, connected: false };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(t: TestContext, lifi = false) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const requests: { resolve: (q: { expires: number }) => void; reject: (error: Error) => void }[] = [];
  const results: { expires: number }[] = [], pending: boolean[] = [], manual: boolean[] = [], errors: string[] = [];
  const scheduler = createAutoQuoteScheduler({
    request: () => new Promise<{ expires: number }>((resolve, reject) => requests.push({ resolve, reject })),
    remaining: q => q.expires - Date.now(), result: q => results.push(q), error: e => errors.push(String(e)),
    pending: value => pending.push(value), manual: value => manual.push(value),
  });
  scheduler.update({ ...input, lifi, connected: lifi });
  t.after(() => scheduler.dispose());
  return { scheduler, requests, results, pending, manual, errors, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("auto quotes debounce the latest input, supersede in-flight responses and never overlap for one input", async t => {
  const f = fixture(t);
  f.tick(599); assert.equal(f.requests.length, 0);
  f.scheduler.update({ ...input, key: "buy:eth:0.002:100" });
  f.tick(599); assert.equal(f.requests.length, 0);
  f.tick(1); assert.equal(f.requests.length, 1); assert.equal(f.pending.at(-1), true);
  f.scheduler.update({ ...input, key: "buy:eth:0.003:100" });
  f.requests[0].resolve({ expires: Date.now() + 60_000 }); await flush(); assert.equal(f.results.length, 0);
  f.tick(600); assert.equal(f.requests.length, 2);
  f.tick(600); assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ expires: Date.now() + 60_000 }); await flush();
  assert.equal(f.results.length, 1); assert.equal(f.pending.at(-1), false);
});

test("pair and native quotes need no wallet; hidden, busy, invalid and missing pools cancel pending work", async t => {
  const f = fixture(t);
  for (const change of [{ visible: false }, { busy: true }, { valid: false }, { pool: false }]) {
    f.scheduler.update({ ...input, ...change }); f.tick(5_000); assert.equal(f.requests.length, 0);
    f.scheduler.update(input); f.tick(599); assert.equal(f.requests.length, 0);
  }
  f.tick(1); assert.equal(f.requests.length, 1);
  f.scheduler.update({ ...input, visible: false });
  f.requests[0].resolve({ expires: Date.now() + 60_000 }); await flush(); assert.equal(f.results.length, 0);
  f.tick(120_000); assert.equal(f.requests.length, 1);
});

for (const lifi of [false, true]) test(`${lifi ? "LI.FI" : "pair/native"} timing, expiry cap and user-change reset`, async t => {
  const f = fixture(t, lifi), delay = lifi ? 1_000 : 600, cap = lifi ? 1 : 3;
  f.tick(delay - 1); assert.equal(f.requests.length, 0); f.tick(1);
  for (let i = 0; i <= cap; i++) {
    assert.equal(f.requests.length, i + 1);
    f.requests[i].resolve({ expires: Date.now() + 10_000 }); await flush();
    f.tick(9_999); assert.equal(f.requests.length, i + 1); f.tick(1);
  }
  assert.equal(f.requests.length, cap + 1); assert.equal(f.manual.at(-1), true);
  f.tick(120_000); assert.equal(f.requests.length, cap + 1);
  f.scheduler.refresh(); assert.equal(f.requests.length, cap + 2);
  f.requests[cap + 1].resolve({ expires: Date.now() + 10_000 }); await flush();
  f.tick(10_000); assert.equal(f.requests.length, cap + 2);
  f.scheduler.update({ ...input, lifi, connected: lifi, key: "sell:pair:2:50" });
  f.tick(delay); assert.equal(f.requests.length, cap + 3);
});

test("LI.FI quotes wait for a wallet and do not retry a rejected request automatically", async t => {
  const f = fixture(t, true);
  f.scheduler.update({ ...input, lifi: true }); f.tick(10_000); assert.equal(f.requests.length, 0);
  f.scheduler.update({ ...input, lifi: true, connected: true }); f.tick(1_000); assert.equal(f.requests.length, 1);
  f.requests[0].reject(new Error("Route unavailable")); await flush();
  f.tick(120_000); assert.equal(f.requests.length, 1); assert.match(f.errors[0], /Route unavailable/);
  assert.equal(f.manual.at(-1), true);
});

test("expired quotes pause while hidden and resume within the same refresh budget", async t => {
  const f = fixture(t); f.tick(600);
  f.requests[0].resolve({ expires: Date.now() + 10_000 }); await flush();
  f.scheduler.update({ ...input, visible: false }); f.tick(20_000); assert.equal(f.requests.length, 1);
  f.scheduler.update(input); f.tick(0); assert.equal(f.requests.length, 2);
  f.scheduler.dispose(); f.requests[1].resolve({ expires: Date.now() + 10_000 }); await flush();
  assert.equal(f.results.length, 1);
});

test("automatic quote calls do not multiply POSTs through the shared API retry loop", async () => {
  const { api } = await import("../src/lib/api");
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ error: "Quote capacity unavailable" }, { status: 503 }); };
  try {
    await assert.rejects(api("/quote", { amount: "1" }, { challenge: false, retry: false }), /Quote capacity unavailable/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});
