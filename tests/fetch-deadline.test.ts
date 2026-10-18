import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { SupabaseStore } from "../server/supabase-store";
import { RiskChallenge } from "../server/abuse";
import { SwapQuotePrices } from "../server/swap-prices";
import { MUSEGOD } from "../src/lib/musegod";

/** Replaces the global timer functions with a ledger: every armed timer is recorded and stays live until it is cleared or fired by hand.
 * A Durable Object cannot hibernate while a timer is live, and an idle object that cannot hibernate is billed for duration. */
function timerLedger(t: TestContext) {
  const live = new Map<object, () => void>(), armed: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms = 0) => {
    const id = {};
    armed.push(ms);
    live.set(id, () => { live.delete(id); callback(); });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id: object) => { live.delete(id); });
  return { armed, live, fireAll() { for (const fire of [...live.values()]) fire(); } };
}
const realFetch = globalThis.fetch;
function stubFetch(t: TestContext, fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  globalThis.fetch = fetcher as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
}
/** A body whose read records how many timers are live at that moment. A zero high-water mark keeps the stream from pulling before the
 * caller reads, so the record is taken during the body read itself. */
function body(text: string, onRead: () => void) {
  return new ReadableStream<Uint8Array>({ pull(controller) { onRead(); controller.enqueue(new TextEncoder().encode(text)); controller.close(); } },
    { highWaterMark: 0 });
}
/** Settles like a real fetch whose server never answers: only the signal can end it. */
const stalled = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
  init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
});
/** Answers headers at once, then never sends the body; like a real fetch body, it errors with the signal's reason on abort. `reading`
 * resolves once the caller starts reading the body. */
function stalledBody() {
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const fetcher = async (_url: string, init: RequestInit) => {
    const signal = init.signal!;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        started();
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => { controller.error(signal.reason); resolve(); }, { once: true }));
      },
    }, { highWaterMark: 0 }));
  };
  return { fetcher, reading };
}
const store = () => new SupabaseStore("https://fixture.supabase.co", "test-only");

test("a Supabase request keeps its 15 s deadline through the body read and leaves no timer once it answers", async (t) => {
  const ledger = timerLedger(t), during: number[] = [];
  let signal: AbortSignal | undefined;
  stubFetch(t, async (_url, init) => { signal = init.signal!; return new Response(body('[{"key":"a"}]', () => during.push(ledger.live.size))); });
  assert.deepEqual(await store().request("musegod_quota?select=key"), [{ key: "a" }]);
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(ledger.armed, [15_000], "one 15 s deadline per request");
  assert.deepEqual(during, [1], "the deadline still covers the body read");
  assert.equal(ledger.live.size, 0, "no timer outlives the answered request");
});

test("a failed Supabase request keeps its error and leaves no timer, for an HTTP failure and a transport failure", async (t) => {
  const ledger = timerLedger(t);
  stubFetch(t, async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(store().request("musegod_quota"), /^Error: Database request failed \(503\)\. Check the server configuration and migrations\.$/);
  assert.equal(ledger.live.size, 0);
  stubFetch(t, async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(store().request("musegod_quota"), { name: "TypeError", message: "fetch failed" });
  assert.deepEqual(ledger.armed, [15_000, 15_000]);
  assert.equal(ledger.live.size, 0);
});

test("a stalled Supabase request still ends at its deadline with the same TimeoutError as AbortSignal.timeout", async (t) => {
  const ledger = timerLedger(t);
  stubFetch(t, stalled);
  const pending = store().request("musegod_quota");
  assert.equal(ledger.live.size, 1);
  ledger.fireAll();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
  assert.equal(ledger.live.size, 0);
});

test("a Supabase answer whose body stalls after the headers still ends at the same deadline", async (t) => {
  const ledger = timerLedger(t), { fetcher, reading } = stalledBody();
  stubFetch(t, fetcher);
  const pending = store().request("musegod_quota");
  await reading;
  assert.equal(ledger.live.size, 1, "the deadline is still armed after the headers arrive");
  ledger.fireAll();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
  assert.deepEqual(ledger.armed, [15_000]);
  assert.equal(ledger.live.size, 0);
});

test("the Turnstile check clears its 10 s deadline after a pass and after a transport failure", async (t) => {
  const ledger = timerLedger(t);
  stubFetch(t, async () => Response.json({ success: true, hostname: "musegod.fun", action: "expensive_request" }));
  assert.equal(await new RiskChallenge().verify("203.0.113.7", "token", "secret", "musegod.fun"), true);
  stubFetch(t, async () => { throw new TypeError("fetch failed"); });
  assert.equal(await new RiskChallenge().verify("203.0.113.8", "token", "secret", "musegod.fun"), false);
  assert.deepEqual(ledger.armed, [10_000, 10_000]);
  assert.equal(ledger.live.size, 0);
});

test("the LI.FI display price read clears its 3 s deadline after the body is read, and still ends a stalled read", async (t) => {
  const ledger = timerLedger(t), during: number[] = [];
  const pool = { chainId: 4663, version: 3, pool: MUSEGOD.pool.toLowerCase(), token: MUSEGOD.token.toLowerCase(), quote: MUSEGOD.weth.toLowerCase(),
    tokenDecimals: 18, quoteDecimals: 18, quoteSymbol: "WETH" } as Parameters<SwapQuotePrices["get"]>[0];
  const answer = JSON.stringify({ address: MUSEGOD.weth, chainId: 4663, decimals: 18, symbol: "WETH", priceUSD: "2460.5" });
  const prices = new SwapQuotePrices(async () => new Response(body(answer, () => during.push(ledger.live.size))));
  assert.equal((await prices.get(pool))?.price, 2460.5);
  assert.deepEqual(during, [1], "the deadline still covers the body read");
  const stalledPrices = new SwapQuotePrices(stalled as typeof fetch), pending = stalledPrices.get(pool);
  ledger.fireAll();
  assert.equal(await pending, null, "a timed-out read stays a missing price");
  assert.deepEqual(ledger.armed, [3_000, 3_000]);
  assert.equal(ledger.live.size, 0);
});

test("no server or Worker code arms AbortSignal.timeout, whose timer outlives the request and keeps a Durable Object billable", () => {
  const offenders = ["server", "worker"].flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => `${dir}/${name}`))
    .filter((path) => /AbortSignal\.timeout\(/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, [], "use withDeadline (server/deadline.ts) instead");
});
