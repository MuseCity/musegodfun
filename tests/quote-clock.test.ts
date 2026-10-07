import test from "node:test";
import assert from "node:assert/strict";
import { inheritQuoteClock, observeServerTime, quoteNow, resetQuoteClock } from "../src/lib/quote-clock";

const server = 1_800_000_000_000;
test("slow server work does not consume the new signing window twice", (t) => {
  resetQuoteClock(); t.after(resetQuoteClock);
  let monotonic = 120_000;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(Date, "now", () => server + 600_000);
  observeServerTime(new Date(server).toUTCString(), server, 0, monotonic);
  const plan = { id: "slow-plan", finalizedAt: server, signingExpiresAt: server + 300_000 };
  assert.equal(quoteNow(plan), server, "serverTime was produced after the 120 second request");
  monotonic += 120_000;
  assert.equal(plan.signingExpiresAt - quoteNow(plan), 180_000);
  observeServerTime(null, server + 120_000, monotonic - 50, monotonic);
  assert.equal(quoteNow(), server + 120_000, "a fast response does not inherit a spurious RTT offset");
});

test("system time jumps in either direction do not renew or prematurely expire a received quote", (t) => {
  resetQuoteClock(); t.after(resetQuoteClock);
  let monotonic = 10, wall = server;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(Date, "now", () => wall);
  observeServerTime(null, server, monotonic, monotonic);
  const quote = { id: "payment", quotedAt: server, expiresAt: server + 60_000 };
  assert.equal(quoteNow(quote), server);
  for (const jump of [600_000, -600_000]) {
    wall = server + jump; monotonic += 20_000;
    assert.equal(quoteNow(quote), server + monotonic - 10);
  }
  monotonic += 20_000;
  assert.equal(quoteNow(quote), quote.expiresAt);
});

test("new response anchors correct clock skew without extending any existing or cloned window", (t) => {
  resetQuoteClock(); t.after(resetQuoteClock);
  let monotonic = 100;
  t.mock.method(performance, "now", () => monotonic);
  observeServerTime(null, server + 120_000, 0, monotonic);
  const plan = { id: "accepted", finalizedAt: server, signingExpiresAt: server + 300_000 };
  assert.equal(quoteNow(plan), server + 120_000);
  monotonic += 10_000;
  observeServerTime(null, server + 10_000, monotonic - 10, monotonic);
  assert.equal(quoteNow(), server + 10_000);
  assert.equal(quoteNow(plan), server + 130_000);
  assert.equal(quoteNow(structuredClone(plan)), server + 130_000);
  const inherited = inheritQuoteClock(plan, { changedShape: true });
  assert.equal(quoteNow(inherited), server + 130_000);
  assert.equal(quoteNow({ ...plan, id: "fresh" }), server + 10_000);
  monotonic += 170_000;
  assert.equal(quoteNow(plan), plan.signingExpiresAt);
});

test("HTTP Date provides a conservative fallback and malformed timestamps cannot reset it", (t) => {
  resetQuoteClock(); t.after(resetQuoteClock);
  t.mock.method(performance, "now", () => 100);
  observeServerTime(new Date(server).toUTCString(), server + 600_000, 0, 100);
  assert.equal(quoteNow(), server + 1_000);
  observeServerTime(null, "bad", 0, 100);
  assert.equal(quoteNow(), server + 1_000);
});
