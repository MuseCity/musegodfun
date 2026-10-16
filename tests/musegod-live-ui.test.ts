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
    import { z } from 'zod';
    globalThis.window = {};
    let attempts = 0;
    globalThis.Function = new Proxy(Function, {apply() {attempts++;throw new EvalError('CSP');}, construct() {attempts++;throw new EvalError('CSP');}});
    const {parseLiveEvent} = await import('./src/lib/musegod-live.ts');
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
    listener.event({ type: "price", tokenAddress: MUSEGOD.token, chain: "robinhood", lastPriceUsd: 4, marketCapUsd: 800, lastTradeAt: time });
    listener.status({ connected: true, receiving: true, receivedAt: Date.now() }); await settle();
    assert.equal((output as any).summary.priceUsd, 4);
    const markup = renderToStaticMarkup(runtime.output()); assert.match(markup, /Live · Bankr/); assert.match(markup, /<time/);
    listener.status({ connected: false, receiving: false, receivedAt: null }); await settle();
    assert.equal(output, null); assert.equal(renderToStaticMarkup(runtime.output()), "");
    runtime.unmount(); assert.equal(closed, true); assert.equal(output, null);
  } finally { runtime.unmount(); }
});
