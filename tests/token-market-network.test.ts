import test from "node:test";
import assert from "node:assert/strict";
import { marketEndpoint } from "../src/components/TokenMarket";
import { syntheticToken } from "./fixtures";

test("token market identities include their chain even for identical addresses", () => {
  const base = syntheticToken(), rh = { ...base, mode: "robinhood" as const, deploymentChainId: 4663 as const };
  const a = marketEndpoint(base, "launch", "summary"), b = marketEndpoint(rh, "launch", "summary");
  assert.equal(a.chainId, 8453);
  assert.equal(b.chainId, 4663);
  assert.notEqual(a.key, b.key);
  assert.equal(a.path, `/tokens/${base.address}/market/summary`);
  assert.equal(b.path, a.path);
});

test("MUSEGOD always reads Robinhood while fork launch identity retains its deployment", () => {
  const token = syntheticToken({ mode: "fork", deploymentChainId: 4663 });
  assert.equal(marketEndpoint(token, "launch", "summary").chainId, 4663);
  const featured = marketEndpoint(syntheticToken(), "musegod", "candles?interval=1h");
  assert.equal(featured.chainId, 4663);
  assert.equal(featured.path, "/musegod/market/candles?interval=1h");
  assert.notEqual(marketEndpoint(token, "launch", "summary").key,
    marketEndpoint({ ...token, mode: "robinhood" }, "launch", "summary").key);
});

test("market keys bind pool, quote, section, interval and parser version", () => {
  const token=syntheticToken();
  const original=marketEndpoint(token,'launch','summary');
  assert.notEqual(original.key,marketEndpoint({...token,poolId:`0x${'c'.repeat(64)}`},'launch','summary').key);
  assert.notEqual(original.key,marketEndpoint({...token,quoteAddress:token.address},'launch','summary').key);
  assert.notEqual(original.key,marketEndpoint(token,'launch','trades').key);
  assert.notEqual(marketEndpoint(token,'launch','candles?interval=1h').key,marketEndpoint(token,'launch','candles?interval=4h').key);
  assert.match(original.key,/v2/);
});

test("section provenance never borrows another section's source or time", async () => {
  const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
  const {MarketProvenance}=await import('../src/components/TokenMarket');
  const text=renderToStaticMarkup(createElement(MarketProvenance,{label:'Trades',data:{source:'GeckoTerminal',fetchedAt:'2026-10-08T09:00:00Z',status:'stale'}}));
  assert.match(text,/GeckoTerminal/);assert.match(text,/2026-10-08T09:00:00Z/);assert.match(text,/Previous snapshot/);assert.doesNotMatch(text,/CoinGecko/);
  const missing=renderToStaticMarkup(createElement(MarketProvenance,{label:'Candles',data:null}));
  assert.doesNotMatch(missing,/Bankr|CoinGecko|GeckoTerminal/);assert.equal(missing, "");
  const cg = renderToStaticMarkup(createElement(MarketProvenance, { label: "Summary", data: { source: "CoinGecko", fetchedAt: "2026-10-15T09:00:00Z" } }));
  assert.match(cg, /<a href="https:\/\/www.coingecko.com\/en\/api"[^>]*rel="noopener noreferrer"[^>]*>[^<]*CoinGecko/);
});

test("read-only HTTP acceptance targets explicit identities and reports empty fixtures without skipping", async () => {
  const {createServer}=await import('node:http');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const token=syntheticToken();let holderFails=false;const seen:string[]=[];
  const data={fetchedAt:'2026-10-15T09:00:00Z',source:'CoinGecko',status:'fresh',priceUsd:null,marketCapUsd:null,fdvUsd:null,liquidityUsd:0,periods:{}};
  const server=createServer((req,res)=>{seen.push(req.url!);res.setHeader('content-type','application/json');let body:unknown;
    if(req.url===`/api/chains/8453/tokens`)body=[token];
    else if(req.url?.includes('/market/summaries'))body=[{address:token.address,summary:data}];
    else if(req.url?.endsWith('/summary'))body=data;
    else if(req.url?.includes('/candles?'))body={...data,candles:[]};
    else if(req.url?.endsWith('/trades'))body={...data,trades:[]};
    else if(req.url?.endsWith('/holders')){res.statusCode=503;body={status:'unavailable',reason:holderFails?'upstream_http':'source_not_provided',source:'Unavailable'}}
    else {res.statusCode=404;body={error:'fixture route missing'}}res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
  const dir=await mkdtemp(join(tmpdir(),'market-http-')),output=join(dir,'report.json');
  const args=['--import','tsx','scripts/test-market-http.ts','--origin',`http://127.0.0.1:${port}`,'--chain','8453','--token',token.address,'--pool',token.poolId,'--evidence','fixture','--output',output];
  try{
    await promisify(execFile)(process.execPath,args);
    const report=JSON.parse(await readFile(output,'utf8'));
    assert.equal(report.status,'passed_contract');assert.equal(report.evidenceKind,'fixture');assert.equal(report.chainEvidenceVerified,false);
    assert.equal(report.sections['candles?interval=1h'].indexedEmpty,true);assert.equal(report.sections.trades.count,0);
    assert(seen.every(path=>path.startsWith('/api/chains/8453/')));assert.equal(seen.length,12);
    holderFails=true;
    await assert.rejects(promisify(execFile)(process.execPath,args),(e:any)=>e.code===2);
    const failure=JSON.parse(await readFile(output,'utf8'));assert.equal(failure.status,'incomplete');assert.deepEqual(failure.failures,['holders']);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});


test("Bankr provenance maps Pools consistently and preserves the MUSEGOD external link", async () => {
  const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { MarketProvenance } = await import("../src/components/TokenMarket");
  const { MUSEGOD } = await import("../src/lib/musegod");
  const data = { source: "Bankr" as const, fetchedAt: "2026-10-08T09:00:00Z" };
  const markup = renderToStaticMarkup(createElement(MarketProvenance, { label: "Summary", data, kind: "musegod" }));
  assert.match(markup, /Bankr \/ Pools/); assert(markup.includes(MUSEGOD.sourceUrl)); assert.match(markup, /↗/);
});

test("refreshing populated summaries hide initial loading banners and empty charts describe price records", async () => {
  const { registerHooks } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { MUSEGOD } = await import("../src/lib/musegod");
  const entry = pathToFileURL(`${process.cwd()}/src/components/TokenMarket.tsx`);
  entry.search = `fixture=${crypto.randomUUID()}`;
  const key = `__marketRefresh${crypto.randomUUID().replaceAll("-", "")}`;
  const token = { ...syntheticToken(), mode: "robinhood" as const, deploymentChainId: 4663 as const };
  const endpoints = ["summary", "candles?interval=1h", "trades", "holders"].map(section => marketEndpoint(token, "musegod", section).key);
  let refIndex = 0, dataIndex = 0;
  const data = { fetchedAt: new Date().toISOString(), status: "fresh", source: "Bankr", priceUsd: 1,
    marketCapUsd: null, fdvUsd: null, liquidityUsd: 1, periods: { h24: { change: null, volume: null, buys: null, sells: null } } };
  const mock = {
    useState(initial: any) {
      return [typeof initial === "object" && initial !== null && "loading" in initial
        ? ++dataIndex === 1 ? { data, error: "", loading: true } : { data: { ...data, candles: [], trades: [] }, error: "", loading: false }
        : initial, () => {}];
    },
    useRef(initial: any) { return { current: refIndex++ === 0 ? initial : endpoints[refIndex - 2] }; },
  };
  Reflect.set(globalThis, key, mock);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier !== "react" || context.parentURL !== entry.href) return next(specifier, context);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve("react"))};export const {useState,useRef}=globalThis[${JSON.stringify(key)}];`)}` };
  } });
  try {
    const { default: View } = await import(entry.href);
    const markup = renderToStaticMarkup(createElement(View, { token, refreshKey: "" }));
    assert.doesNotMatch(markup, /Loading market data/);
    assert.match(markup, /No indexed price records for this interval/);
    assert.doesNotMatch(markup, /No indexed trades for this interval/);
    assert(markup.includes(MUSEGOD.sourceUrl)); assert.match(markup, /refreshes every 15 seconds while visible/);
  } finally { hooks.deregister(); Reflect.deleteProperty(globalThis, key); }
});

test("holders HTTP contract keeps registered-token validation and a long retry delay without upstream access", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { once } = await import("node:events");
  const { createApp } = await import("../server/app"), { runtimeFromEnv } = await import("../server/config");
  const { MUSEGOD } = await import("../src/lib/musegod");
  const read = globalThis.fetch;
  let external = 0;
  t.mock.method(globalThis, "fetch", (async (input: any, init: any) => {
    if (!String(input).startsWith("http://127.0.0.1:")) { external++; throw new Error("External access forbidden in fixture"); }
    return read(input, init);
  }) as typeof fetch);
  for (const chain of [8453, 4663] as const) {
    const directory = await mkdtemp(join(tmpdir(), "holders-contract-")), mode = chain === 8453 ? "base" : "robinhood";
    const entry = createApp(undefined, "loopback", runtimeFromEnv(chain, { NODE_ENV: "test", CHAIN_MODE: mode, DATA_DIR: directory, ALCHEMY_API_KEY: "fixture-no-network" }));
    const token = syntheticToken({ mode, deploymentChainId: chain, ...(chain === 4663 ? { quoteAddress: MUSEGOD.weth } : {}) });
    await entry.service.store.saveToken(token);
    let storage = 0;
    entry.service.store.snapshot = () => { storage++; throw new Error("No holders snapshot reads"); };
    entry.service.store.saveSnapshot = () => { storage++; throw new Error("No holders snapshot writes"); };
    const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/tokens/${token.address}/market/holders`);
      const body = await response.json() as any;
      assert.equal(response.status, 503); assert.equal(body.status, "unavailable"); assert.equal(body.reason, "source_not_provided");
      assert.equal(body.holders, undefined); assert(Number(response.headers.get("retry-after")) >= 86_399);
      const missing = await fetch(`http://127.0.0.1:${port}/api/tokens/0x${"9".repeat(40)}/market/holders`);
      assert([404, 422].includes(missing.status)); assert.notEqual((await missing.json() as any).reason, "source_not_provided");
      assert.equal(storage, 0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); entry.service.store.close(); await rm(directory, { recursive: true, force: true }); }
  }
  assert.equal(external, 0);
});

test("MUSEGOD HTTP route classifies real fetch-boundary failures without modifying its dedicated reader", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { once } = await import("node:events");
  const { createApp } = await import("../server/app"), { runtimeFromEnv } = await import("../server/config");
  const nativeFetch = globalThis.fetch;
  let httpFailure = true, calls = 0;
  t.mock.method(globalThis, "fetch", (async (input: any, init: any) => {
    if (String(input).startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
    assert.equal(new URL(String(input)).origin, "https://api.bankr.bot"); calls++;
    if (httpFailure) return new Response("private upstream body", { status: 503 });
    throw new TypeError("private upstream URL");
  }) as typeof fetch);
  for (const failure of [true, false]) {
    httpFailure = failure;
    const directory = await mkdtemp(join(tmpdir(), "musegod-failure-"));
    const entry = createApp(undefined, "loopback", runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "robinhood", DATA_DIR: directory, ALCHEMY_API_KEY: "fixture-no-network" }));
    const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const response = await nativeFetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/musegod/market/candles?interval=1h`);
      const body = await response.json() as any;
      assert.equal(response.status, 503); assert.equal(body.source, "Bankr");
      assert.equal(body.reason, failure ? "upstream_http" : "upstream_transport");
      assert.equal(body.upstreamStatus, failure ? 503 : undefined);
      assert.doesNotMatch(JSON.stringify(body), /private|Internal/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); entry.service.store.close(); await rm(directory, { recursive: true, force: true }); }
  }
  assert.equal(calls, 2);
});
