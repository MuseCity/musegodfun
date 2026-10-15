import test from "node:test";
import assert from "node:assert/strict";
import { api, chainApi, ApiError } from "../src/lib/api";

for (const scoped of [false, true]) test(`non-interactive ${scoped ? "chainApi" : "api"} rejects challenges without dispatching a modal event`, async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  let events = 0, requests = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent() { events++; throw new Error("unexpected challenge"); } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => {
    requests++; assert.equal(path, scoped ? "/api/chains/4663/token-images" : "/api/token-images");
    return new Response(JSON.stringify({ code: "CHALLENGE_REQUIRED", error: "Verification required", siteKey: "fixture" }), { status: 403 });
  });
  const pending = scoped ? chainApi(4663, "/token-images", { image: "fixture" }, { challenge: false }) : api("/token-images", { image: "fixture" }, { challenge: false });
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "CHALLENGE_REQUIRED");
  assert.equal(events, 0); assert.equal(requests, 1);
});

test("interactive uploads still dispatch the challenge and retry with the token", async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  let events = 0, requests = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent(event: CustomEvent) {
    events++; assert.equal(event.type, "musegod:challenge"); event.detail.resolve("fixture-token"); return true;
  } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async (_path: string | URL | Request, init?: RequestInit) => {
    requests++;
    if (requests === 1) return new Response(JSON.stringify({ code: "CHALLENGE_REQUIRED" }), { status: 403 });
    assert.equal(new Headers(init?.headers).get("x-turnstile-token"), "fixture-token");
    return new Response(JSON.stringify({ image: "https://pin.test/manual" }));
  });
  assert.deepEqual(await api("/token-images", { image: "fixture" }), { image: "https://pin.test/manual" });
  assert.equal(events, 1); assert.equal(requests, 2);
});
