import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

type Quote = { expires: number };
const base = { key: "buy:eth:0.001:100", lifi: false, valid: true, pool: true, busy: false, completed: false, connected: false };

// The real hook inside a minimal hooks runtime: effects re-run only when their deps change, as React does.
async function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
  let input = { ...base }, useAutoQuote: (input: typeof base, callbacks: any) => { pending: boolean; manual: boolean; refresh: () => void };
  const requests: { resolve: (quote: Quote) => void }[] = [];
  const callbacks = { request: () => new Promise<Quote>(resolve => requests.push({ resolve })), remaining: (q: Quote) => q.expires - Date.now(), result: () => {}, error: () => {} };
  const runtime = hookRuntime(() => useAutoQuote(input, callbacks));
  ({ useAutoQuote } = await importFresh("src/lib/use-auto-quote.ts", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  runtime.render(); await settle();
  t.after(() => {
    runtime.unmount();
    if (prior) Object.defineProperty(globalThis, "document", prior); else Reflect.deleteProperty(globalThis, "document");
  });
  return {
    requests, out: () => runtime.output(), tick: (ms: number) => t.mock.timers.tick(ms),
    async set(change: Partial<typeof base>) { input = { ...input, ...change }; runtime.render(); await settle(); },
    async answer(index: number) { requests[index].resolve({ expires: Date.now() + 10_000 }); await settle(); },
  };
}

test("after a post-trade Refresh the hook resumes automatic expiry refreshes", async t => {
  const f = await harness(t);
  f.tick(600); assert.equal(f.requests.length, 1); await f.answer(0);
  await f.set({ completed: true });
  f.tick(120_000); assert.equal(f.requests.length, 1);
  f.out().refresh(); assert.equal(f.requests.length, 2);
  // The panel's Refresh handler also clears the confirmation, so the next render has the same key and `completed: false`.
  await f.set({ completed: false });
  await f.answer(1);
  f.tick(10_000); assert.equal(f.requests.length, 3);
});

test("Refresh quote stays hidden through the debounce after a confirmed trade and an amount edit", async t => {
  const f = await harness(t);
  f.tick(600); await f.answer(0);
  await f.set({ completed: true }); assert.equal(f.out().manual, true);
  // The edit renders first with the old confirmation, then the reset effect clears it.
  await f.set({ key: "buy:eth:0.002:100" });
  await f.set({ completed: false });
  assert.equal(f.out().manual, false);
  f.tick(599); assert.equal(f.out().manual, false); assert.equal(f.requests.length, 1);
  f.tick(1); assert.equal(f.requests.length, 2); assert.equal(f.out().manual, false);
});
