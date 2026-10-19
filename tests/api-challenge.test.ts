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

// A plain launch's prepare (`once`) sends one request per Confirm click: a security check the server asks for is completed, kept for the
// next click and not resent; capacity answers are not retried (tasks/plain-launch-one-click-plan.md).
test("once: a requested security check is completed but not resent; the next call sends its token in one request", async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  let events = 0;
  const tokens = ["first-token", "second-token"];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent(event: CustomEvent) {
    assert.equal(event.type, "musegod:challenge"); event.detail.resolve(tokens[events++]); return true;
  } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window"); });
  const sent: (string | null)[] = [];
  let answers: Response[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get("x-turnstile-token")); return answers.shift()!;
  });
  const challenged = () => new Response(JSON.stringify({ code: "CHALLENGE_REQUIRED", siteKey: "fixture" }), { status: 403 });
  answers = [challenged()];
  await assert.rejects(chainApi(4663, "/launch/prepare", { draft: {} }, { once: true }),
    (error: unknown) => error instanceof ApiError && error.code === "CHALLENGE_COMPLETED" && /Confirm again/.test(error.message));
  assert.deepEqual(sent, [null], "one request, no resend");
  // The kept token was refused (expired): the check runs again and its new token is kept, still without a resend.
  answers = [challenged()];
  await assert.rejects(chainApi(4663, "/launch/prepare", { draft: {} }, { once: true }), (error: unknown) => error instanceof ApiError && error.code === "CHALLENGE_COMPLETED");
  assert.deepEqual(sent, [null, "first-token"]);
  answers = [new Response(JSON.stringify({ id: "plan" }))];
  assert.deepEqual(await chainApi(4663, "/launch/prepare", { draft: {} }, { once: true }), { id: "plan" });
  assert.deepEqual(sent, [null, "first-token", "second-token"]);
  assert.equal(events, 2);
});

test("once: capacity answers are not retried", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(JSON.stringify({ error: "Capacity is temporarily limited" }), { status: 503, headers: { "retry-after": "0" } }); });
  await assert.rejects(chainApi(4663, "/launch/prepare", { draft: {} }, { once: true }), (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.equal(requests, 1);
});
