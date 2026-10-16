import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { MUSEGOD } from "../src/lib/musegod";
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
