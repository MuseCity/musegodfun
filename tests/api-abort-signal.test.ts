import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/lib/api";

test("caller abort, pre-aborted signals and the timeout still cancel the request where AbortSignal.any is unavailable (Safari < 17.4)", async t => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, "any", original));
  let sent: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    sent = init.signal!; if (sent.aborted) reject(sent.reason); else sent.addEventListener("abort", () => reject(sent!.reason));
  }));
  const caller = new AbortController(), pending = api("/x", undefined, { signal: caller.signal });
  assert.equal(sent!.aborted, false); caller.abort(new Error("caller")); await assert.rejects(pending, /caller/); assert.equal(sent!.aborted, true);
  await assert.rejects(api("/x", undefined, { signal: AbortSignal.abort(new Error("already")) }), /already/);
  const timer = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timer.signal);
  const slow = api("/x", undefined, { signal: new AbortController().signal });
  timer.abort(new DOMException("timeout", "TimeoutError")); await assert.rejects(slow, { name: "TimeoutError" });
});
