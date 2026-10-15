import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { quoteAsset, ROBINHOOD_STOCKS } from "../src/lib/config";
import { syntheticToken } from "./fixtures";

test("Workerd executes Bankr-first Robinhood candles and manual-redirect Gecko fallback with persistent provenance", async () => {
  // Real Worker runtime; provider data is controlled input, not mainnet proof.
  const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: ROBINHOOD_STOCKS[0].address });
  const now = Date.parse("2026-10-08T14:00:00Z");
  const { outputFiles } = await build({ bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
      import { MarketReader } from './server/market';
      const rows = new Map();
      const store = { snapshot: key => rows.get(key) ?? null,
        saveSnapshot: (key, data, at) => rows.set(key, { data, at }) };
      const token = ${JSON.stringify(token)};
      const options = { store, now: () => ${now} };
      const reader = new MarketReader(options);
      export default { async fetch() {
        try {
          const primary = await reader.candles(token, '1h');
          const fallback = await reader.candles(token, '5m');
          const cached = await new MarketReader(options).candles(token, '5m');
          return Response.json({ primary, fallback, cached, rows: rows.size });
        } catch (error) { return Response.json({ message: error.message }, { status: 503 }); }
      } };` },
  });
  const calls: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-10-04", script: outputFiles[0].text,
    outboundService: async request => {
      calls.push(request.url);
      const url = new URL(request.url);
      assert.equal(request.method, "GET"); assert.equal(request.headers.get("x-cg-demo-api-key"), null);
      const ohlcv = [[now / 1000 - 3600, 1, 2, 0.5, 1.5, 10]];
      if (url.hostname === "api.bankr.bot") {
        if (url.searchParams.get("timeframe") === "minute")
          return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } });
        return Response.json({ ohlcv, pool: { address: token.poolId, network: "robinhood" },
          pair: { baseSymbol: token.symbol, quoteSymbol: quoteAsset(token).symbol } });
      }
      assert.equal(url.origin, "https://api.geckoterminal.com");
      return Response.json({ data: { attributes: { ohlcv_list: ohlcv } },
        meta: { base: { address: token.address }, quote: { address: token.quoteAddress } } });
    },
  }));
  try {
    const response = await runtime.dispatchFetch("https://local.test/");
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.primary.source, "Bankr"); assert.equal(result.primary.candles.length, 1);
    assert.equal(result.fallback.source, "GeckoTerminal"); assert.equal(result.fallback.status, "fresh");
    assert.deepEqual(result.cached, result.fallback); assert.equal(result.rows, 2);
    assert.equal(calls.length, 3, "Neither cache reuse nor the rejected redirect makes an outbound request");
  } finally { await runtime.dispose(); }
});

test("Workerd runs configured Robinhood CoinGecko, preserves HTTP/schema failures and bounds backoff", async () => {
  const token=syntheticToken({mode:'robinhood',deploymentChainId:4663,quoteAddress:ROBINHOOD_STOCKS[0].address});
  const {outputFiles}=await build({bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
    import { MarketReader } from './server/market';
    const rows=new Map();let quota=0;
    const store={snapshot:k=>rows.get(k),saveSnapshot:(k,data,at)=>rows.set(k,{data,at}),reserveMarketCall:()=>{quota++;return true}};
    let now=1800000000000;const reader=new MarketReader({store,apiKey:'fixture-only',now:()=>now});
    export default {async fetch(request){const token=${JSON.stringify(token)},path=new URL(request.url).pathname;
      if(path==='/advance')now+=3600001;
      try { if(path==='/timeout'){const timeoutReader=new MarketReader({store,apiKey:'fixture-only',fetch:async()=>{throw new DOMException('controlled timeout','TimeoutError')}});await timeoutReader.summary(token);}
        const result=path==='/summary'?await reader.summary(token):(path==='/trades'||path==='/advance')?await reader.trades(token):await reader.holders(token);return Response.json({result,quota}); }
      catch(e){return Response.json({reason:e.reason,status:e.status,source:e.source,upstreamStatus:e.upstreamStatus,nextRefreshAt:e.nextRefreshAt,quota},{status:503});}
    }};`}});
  const calls:string[]=[];
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-04',script:outputFiles[0].text,outboundService:async request=>{
    calls.push(request.url);const url=new URL(request.url);

    assert.equal(url.hostname,'api.coingecko.com');assert(url.pathname.includes('/networks/robinhood/'));assert.equal(request.headers.get('x-cg-demo-api-key'),'fixture-only');
    return url.pathname.endsWith('/trades')?new Response('invalid-json'):new Response(null,{status:429,headers:{'retry-after':'3600'}});
  }}));
  try{
    const first=await runtime.dispatchFetch('https://fixture.test/summary');const a=await first.json() as any;
    assert.equal(first.status,503);assert.equal(a.reason,'rate_limited');assert.equal(a.upstreamStatus,429);assert.equal(a.quota,1);
    const next=await runtime.dispatchFetch('https://fixture.test/trades');const suppressed=await next.json() as any;assert.equal(suppressed.reason,'backoff');assert.equal(suppressed.upstreamStatus,undefined);
    assert.equal(calls.length,1,'A different section cannot immediately retry a throttled provider');
    const malformed=await runtime.dispatchFetch('https://fixture.test/advance');assert.equal((await malformed.json() as any).reason,'invalid_schema');
    const holders=await runtime.dispatchFetch('https://fixture.test/holders');const h=await holders.json() as any;
    assert.equal(h.reason,'source_not_provided');assert.equal(h.upstreamStatus,undefined);assert.equal(calls.length,2);
    const timeout=await runtime.dispatchFetch('https://fixture.test/timeout');assert.equal((await timeout.json() as any).reason,'upstream_transport');
  }finally{await runtime.dispose()}
});
