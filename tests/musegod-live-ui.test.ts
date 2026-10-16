import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { MUSEGOD } from "../src/lib/musegod";
import { parseLiveEvent } from "../src/lib/musegod-live";
import { parseMusegodTrades } from "../server/musegod-market";
import { securityHeaders } from "../server/http-security";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("browser validators and live schemas work under strict CSP without attempting code generation", async () => {
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { z } from 'zod';
    globalThis.window = {};
    let attempts = 0;
    globalThis.Function = new Proxy(Function, {apply() {attempts++;throw new EvalError('CSP');}, construct() {attempts++;throw new EvalError('CSP');}});
    const firstImport = /["']([^"']+)["']/.exec(readFileSync('src/main.tsx', 'utf8').split(String.fromCharCode(10))[0])[1];
    await import('./src/' + firstImport.slice(2));
    assert.deepEqual(z.object({early: z.string()}).parse({early: 'before application validators'}), {early: 'before application validators'});
    const {parseBefore} = await import('./src/lib/candle-history.ts');
    const {parseLiveEvent} = await import('./src/lib/musegod-live.ts');
    assert.equal(parseBefore(undefined, '1h'), undefined);
    const {amountSchema} = await import('./src/lib/validation.ts');
    assert.equal(amountSchema.parse('1.25'), '1.25');
    assert.equal(parseLiveEvent('TOKEN_SWAP', {tokenAddress:'0x0379e228f6887c6f18bf394042ecaf81b308cb2e', chain:'robinhood',
      txHash:'0x'+'ab'.repeat(32), blockNumber:100, logIndex:1, timestamp:new Date().toISOString(), side:'buy', tokenAmount:2, totalUsd:6, mcapUsd:600})?.type, 'swap');
    assert.equal(attempts, 0, 'CSP forbids even a caught Function capability probe');
  `;
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source]);
});
test("the browser CSP setting leaves server schema configuration unchanged", async () => {
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict'; import {z} from 'zod';
    const previous = z.config().jitless;
    await import('./src/lib/browser-validation.ts');
    await import('./src/lib/validation.ts');
    assert.equal(z.config().jitless, previous);
  `]);
});

test("production CSP adds only the websocket origin and both runtimes share it", () => {
  const directive = securityHeaders(false, true)["Content-Security-Policy"].split(";").find(value => value.trim().startsWith("connect-src"));
  assert.equal(directive?.trim(), "connect-src 'self' https://challenges.cloudflare.com wss://api.bankr.bot");
  assert.match(readFileSync("worker/index.ts", "utf8"), /securityHeaders/);
});
test("lazy live bridge publishes only while receiving; disconnect and unmount restore REST", async () => {
  let listener: any, closed = false, bridge: any, output: any = null;
  const connection = { subscribe(next: any) { listener = next; next.status({ connected: true, receiving: false, receivedAt: null }); return () => { closed = true; }; } };
  const fetchedAt = new Date(Date.now() - 10000).toISOString();
  const props = { info: null, interval: "1h", summary: { source: "Bankr", fetchedAt, priceUsd: 1, lastTradeAt: fetchedAt, periods: {} },
    candles: null, trades: { source: "Bankr", fetchedAt, trades: [] }, onUpdate(value: any) { output = value; } };
  const runtime = hookRuntime(() => bridge(props));
  ({ default: bridge } = await importFresh("src/components/MusegodLive.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/musegod-live-socket": { file: import.meta.resolve("../src/lib/musegod-live-lifecycle.ts"), bindings: { bankrLive: connection } },
  }));
  try {
    runtime.render(); await settle(); assert.equal(output, null);
    const time = new Date().toISOString();
    const event = { type: "price", tokenAddress: MUSEGOD.token, chain: "robinhood", lastPriceUsd: 4, marketCapUsd: 800, lastTradeAt: time };
    assert.equal(listener.event(event), true);
    listener.status({ connected: true, receiving: true, receivedAt: Date.now() }); await settle();
    assert.equal(listener.event(event), false, "duplicate prices do not renew receipt");
    assert.equal(listener.event({ ...event, lastTradeAt: fetchedAt }), false, "stale prices do not renew receipt");
    assert.equal(listener.event({ type: "volume" }), false, "health-only volume does not renew receipt");
    assert.equal((output as any).summary.priceUsd, 4);
    const markup = renderToStaticMarkup(runtime.output()); assert.match(markup, /Live · Bankr/); assert.match(markup, /<time/);
    listener.status({ connected: true, receiving: false, receivedAt: Date.now() }); await settle();
    assert.equal(listener.event(event), false, "duplicate prices cannot revive an expired receipt window");
    listener.status({ connected: false, receiving: false, receivedAt: null }); await settle();
    assert.equal(output, null); assert.equal(renderToStaticMarkup(runtime.output()), "");
    runtime.unmount(); assert.equal(closed, true); assert.equal(output, null);
  } finally { runtime.unmount(); }
});

test("browser entry configures Zod before any application module can construct schemas", () => {
  assert.match(readFileSync("src/main.tsx", "utf8"), /^import "\.\/lib\/browser-validation";/);
});
test("the market mounts live only for a loaded Robinhood mainnet config", async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document"), priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} } });
  t.mock.method(globalThis, "fetch", async () => Response.json({ candles: [], trades: [], periods: {}, fetchedAt: new Date().toISOString() }));
  let config: any = null, View: any;
  const token = { address: MUSEGOD.token, symbol: "MUSEGOD", mode: "robinhood" };
  const runtime = hookRuntime(() => View({ token, kind: "musegod", refreshKey: "", config }));
  ({ default: View } = await importFresh("src/components/TokenMarket.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  const containsLive = (node: any): boolean => !!node && typeof node === "object" &&
    (node.props?.onUpdate != null || (Array.isArray(node) ? node : [node.props?.children]).some(containsLive));
  try {
    for (const value of [null, { mode: "base", chainId: 8453 }, { mode: "fork", chainId: 31337, deploymentChainId: 4663 }, { mode: "robinhood", chainId: 8453 }]) {
      config = value; runtime.render(); await settle(); assert.equal(containsLive(runtime.output()), false);
    }
    config = { mode: "robinhood", chainId: 4663 }; runtime.render(); await settle(); assert.equal(containsLive(runtime.output()), true);
  } finally { runtime.unmount(); if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); if (prior) Object.defineProperty(globalThis, "document", prior); else Reflect.deleteProperty(globalThis, "document"); }
});

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function liveSwap(n: number, timestamp: string, priceUsd: number, totalUsd = 6) {
  const event = parseLiveEvent("TOKEN_SWAP", { tokenAddress: MUSEGOD.token, chain: "robinhood", txHash: hash(n), blockNumber: 100, logIndex: n,
    timestamp, side: "buy", tokenAmount: 2, totalUsd, priceUsd });
  assert(event?.type === "swap"); return event;
}
const liveSnapshot = (lastTradeAt: string, lastPriceUsd: number) => ({ type: "price" as const, tokenAddress: MUSEGOD.token, chain: "robinhood" as const,
  lastPriceUsd, marketCapUsd: lastPriceUsd * 200, lastTradeAt });
/** The real bridge with a stubbed shared connection; `update` renders new REST props. */
async function mountLive(t: { after(fn: () => void): void }, initial: Record<string, unknown>) {
  let listener: any = null, output: any = null, props: any = { ...initial, onUpdate(value: any) { output = value; } }, bridge: any;
  const connection = { subscribe(next: any) { listener = next; next.status({ connected: true, receiving: false, receivedAt: null }); return () => { listener = null; }; } };
  const runtime = hookRuntime(() => bridge(props));
  ({ default: bridge } = await importFresh("src/components/MusegodLive.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/musegod-live-socket": { file: import.meta.resolve("../src/lib/musegod-live-lifecycle.ts"), bindings: { bankrLive: connection } },
  }));
  t.after(() => runtime.unmount()); runtime.render(); await settle();
  return {
    event: (value: unknown) => listener.event(value) as boolean, output: () => output, markup: () => renderToStaticMarkup(runtime.output()),
    status: async (value: unknown) => { listener.status(value); await settle(); },
    update: async (changes: Record<string, unknown>) => { props = { ...props, ...changes }; runtime.render(); await settle(); },
  };
}
const receiving = () => ({ connected: true, receiving: true, receivedAt: Date.now() });

test("candles advancing before summary and trades keep the live headline and trade, count volume once and dedupe on acknowledgment", async t => {
  const restAt = new Date(Date.now() - 20_000).toISOString(), swapAt = new Date(Date.now() - 1000).toISOString(), bucket = Math.floor(Date.parse(swapAt) / 3_600_000) * 3600;
  const meta = { source: "Bankr", status: "fresh", fetchedAt: restAt };
  const live = await mountLive(t, { info: null, interval: "1h", summary: { ...meta, lastTradeAt: restAt, priceUsd: 2, marketCapUsd: 400, periods: {} },
    candles: { ...meta, watermark: { blockNumber: 100, logIndex: 1, txHash: hash(1) }, candles: [{ time: bucket, open: 2, high: 2, low: 2, close: 2, volume: 10 }] },
    trades: { ...meta, trades: [] } });
  const swap = liveSwap(2, swapAt, 3);
  assert.equal(live.event(swap), true); await live.status(receiving());
  assert.equal(live.output().summary.priceUsd, 3); assert.equal(live.output().trades.trades.length, 1); assert.equal(live.output().candles.candles[0].volume, 16);
  const advanced = { ...meta, fetchedAt: swapAt, watermark: { blockNumber: 100, logIndex: 2, txHash: hash(2) }, candles: [{ time: bucket, open: 2, high: 3, low: 2, close: 3, volume: 16 }] };
  await live.update({ candles: advanced });
  assert.equal(live.output().summary.priceUsd, 3, "the headline is not reverted by a candle-only refresh");
  assert.equal(live.output().priceAt, swapAt); assert.equal(live.output().trades.trades.length, 1); assert.equal(live.output().trades.trades[0].id, swap.id);
  assert.strictEqual(live.output().candles, advanced); assert.equal(live.output().candles.candles[0].volume, 16, "the swap is not added to candles that contain it");
  const summary = { ...meta, fetchedAt: swapAt, lastTradeAt: swapAt, priceUsd: 3, marketCapUsd: 600, periods: {} };
  const trades = { ...meta, fetchedAt: swapAt, trades: [{ id: swap.id, hash: swap.txHash, account: null, at: swapAt, side: "buy", amount: 2, usd: 6, price: 3 }] };
  await live.update({ trades });
  assert.strictEqual(live.output().trades, trades, "the swap now listed by REST is not shown twice"); assert.equal(live.output().summary.priceUsd, 3); assert.equal(live.output().priceAt, swapAt);
  await live.update({ summary });
  assert.equal(live.output(), null, "every section has caught up, so REST is shown as is");
  await live.update({ summary: { ...summary, priceUsd: 2.5, lastTradeAt: new Date(Date.parse(swapAt) + 5000).toISOString() } });
  assert.equal(live.output(), null, "an acknowledged swap is released and cannot return");
});
test("when Live expires the newest known value stays until REST catches up; equal-second discovery prices follow stream order", async t => {
  const restAt = new Date(Date.now() - 20_000).toISOString(), at = new Date(Date.now() - 2000).toISOString(), meta = { source: "Bankr", status: "fresh", fetchedAt: restAt };
  const summary = { ...meta, lastTradeAt: restAt, priceUsd: 2, marketCapUsd: 400, periods: {} };
  const live = await mountLive(t, { info: null, interval: "1h", summary, candles: null, trades: { ...meta, trades: [] } });
  assert.equal(live.event(liveSnapshot(at, 4)), true); await live.status(receiving());
  assert.equal(live.output().summary.priceUsd, 4); assert.match(live.markup(), /Live · Bankr/);
  assert.equal(live.event(liveSnapshot(at, 5)), true, "a different price in the same second follows stream order"); await settle();
  assert.equal(live.output().summary.priceUsd, 5);
  assert.equal(live.event(liveSnapshot(at, 5)), false, "an identical replay changes nothing");
  assert.equal(live.event(liveSnapshot(new Date(Date.parse(at) - 1000).toISOString(), 6)), false, "an older price is ignored");
  await live.status({ connected: true, receiving: false, receivedAt: Date.now() });
  assert.equal(live.markup(), "", "the Live label expires"); assert.equal(live.output().summary.priceUsd, 5, "the newest known value is kept");
  const caught = { ...summary, fetchedAt: at, lastTradeAt: new Date(Date.parse(at) + 1000).toISOString(), priceUsd: 6 };
  await live.update({ summary: caught });
  assert.equal(live.output().summary.priceUsd, 6); assert.equal(live.output().priceAt, null);
  await live.status({ connected: false, receiving: false, receivedAt: null });
  assert.equal(live.output(), null); assert.equal(live.markup(), "");
});

for (const [name, order] of [["in order", false], ["reversed", true]] as const) test(`the bridge keeps the newest acknowledged same-second headline when REST lists only the latest 30 swaps (${name}, with replays)`, async t => {
  const second = new Date(Date.now() - 2000).toISOString(), restAt = new Date(Date.now() - 20_000).toISOString(), meta = { source: "Bankr", status: "fresh", fetchedAt: restAt };
  const priceOf = (log: number) => log === 2 ? 3 : log === 32 ? 4 : 3.5, bucket = Math.floor(Date.parse(second) / 3_600_000) * 3600;
  const crowd = Array.from({ length: 31 }, (_, n) => liveSwap(n + 2, second, priceOf(n + 2), 2 * priceOf(n + 2)));
  const live = await mountLive(t, { info: null, interval: "1h", summary: { ...meta, lastTradeAt: second, priceUsd: 2, marketCapUsd: 400, periods: {} },
    candles: { ...meta, watermark: { blockNumber: 100, logIndex: 1, txHash: hash(1) }, candles: [{ time: bucket, open: 2, high: 2, low: 2, close: 2, volume: 10 }] },
    trades: { ...meta, trades: [] } });
  const arrivals = order ? [...crowd].reverse() : crowd;
  for (const event of arrivals) live.event(event);
  await live.status(receiving());
  assert.equal(live.output().summary.priceUsd, 4); assert.equal(live.output().candles.candles[0].close, 4);
  const trades = { ...parseMusegodTrades({ swaps: crowd.map(({ txHash, blockNumber, logIndex, timestamp, side, tokenAmount, totalUsd }) =>
    ({ txHash, blockNumber, logIndex, timestamp, side, tokenAmount, totalUsd, chain: "robinhood" })) }), source: "Bankr", status: "fresh" };
  assert.equal(trades.trades.length, 30);
  await live.update({ summary: { ...meta, fetchedAt: second, lastTradeAt: second, priceUsd: 4, marketCapUsd: 800, periods: {} }, trades });
  assert.equal(live.output().summary.priceUsd, 4, "REST already shows the newest swap; an older unlisted swap must not replace it");
  assert.equal(live.output().priceAt, null); assert.equal(live.output().candles.candles[0].close, 4); assert.equal(live.output().trades.trades[0].price, 4);
  assert.match(live.markup(), /Live · Bankr/);
  assert.equal(live.event(crowd[0]), false, "a replay of the older swap changes nothing"); assert.equal(live.event(crowd.at(-1)), false);
  await settle(); assert.equal(live.output().summary.priceUsd, 4);
});
