import test from "node:test";
import assert from "node:assert/strict";
import { createLiveConnection } from "../src/lib/musegod-live-lifecycle";
import { MUSEGOD } from "../src/lib/musegod";

function harness(t: any) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-16T04:00:00Z") });
  const sockets: any[] = [], changes = new Set<() => void>(), snapshots: any[] = [], events: any[] = [];
  let hidden = false;
  const connection = createLiveConnection({ createSocket: () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const socket = { closed: false, on(name: string, fn: any) { handlers.set(name, fn); }, removeAllListeners() { handlers.clear(); },
      disconnect() { socket.closed = true; }, fire(name: string, ...args: any[]) { handlers.get(name)?.(...args); } };
    sockets.push(socket); return socket;
  }, visible: () => !hidden, watchVisibility: fn => { changes.add(fn); return () => { changes.delete(fn); }; } });
  const off = connection.subscribe({ status: x => snapshots.push(x), event: e => events.push(e) });
  return { sockets, snapshots, events, connection, off, hide(value: boolean) { hidden = value; for (const fn of changes) fn(); }, changes };
}
const price = () => ({ tokenAddress: MUSEGOD.token, chain: "robinhood", lastPriceUsd: 3, marketCapUsd: 600, lastTradeAt: new Date().toISOString() });
test("one shared socket; connection alone and unrelated/invalid events never claim Live", t => {
  const h = harness(t), off2 = h.connection.subscribe({ status() {}, event() {} });
  assert.equal(h.sockets.length, 1); h.sockets[0].fire("connect"); assert.equal(h.snapshots.at(-1).receiving, false);
  h.sockets[0].fire("DISCOVER_PRICE_UPDATE", { ...price(), chain: "base" }); assert.equal(h.events.length, 0);
  h.sockets[0].fire("DISCOVER_PRICE_UPDATE", [price(), { ...price(), tokenAddress: MUSEGOD.weth }]);
  assert.equal(h.events.length, 1); assert.equal(h.snapshots.at(-1).receiving, true);
  t.mock.timers.tick(30_000); assert.equal(h.snapshots.at(-1).receiving, false);
  h.off(); assert.equal(h.sockets[0].closed, false); off2(); assert.equal(h.sockets[0].closed, true); assert.equal(h.changes.size, 0);
});
test("hidden disconnects, cancels retry, visible resumes once, late callbacks cannot revive it", t => {
  const h = harness(t); h.sockets[0].fire("connect"); h.hide(true);
  assert.equal(h.sockets[0].closed, true); assert.equal(h.snapshots.at(-1).connected, false);
  t.mock.timers.tick(120_000); assert.equal(h.sockets.length, 1);
  h.hide(false); h.hide(false); assert.equal(h.sockets.length, 2);
  h.sockets[0].fire("DISCOVER_PRICE_UPDATE", price()); assert.equal(h.events.length, 0);
  h.off(); t.mock.timers.tick(120_000); assert.equal(h.sockets.length, 2);
});
test("failed and flapping connections retry exponentially with a sixty second cap", t => {
  const h = harness(t);
  for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const count = h.sockets.length, socket = h.sockets.at(-1); socket.fire("connect"); socket.fire("disconnect"); socket.fire("connect_error");
    assert.equal(socket.closed, true); assert.equal(h.snapshots.at(-1).receiving, false);
    t.mock.timers.tick(delay - 1); assert.equal(h.sockets.length, count);
    t.mock.timers.tick(1); assert.equal(h.sockets.length, count + 1);
  }
  h.hide(true); t.mock.timers.tick(120_000); assert.equal(h.sockets.at(-1).closed, true); h.off();
});
