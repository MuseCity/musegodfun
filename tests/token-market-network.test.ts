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
  assert.doesNotMatch(missing,/Bankr|CoinGecko|GeckoTerminal/);assert.match(missing,/Source and fetch time/);
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
    else if(req.url?.endsWith('/holders')){res.statusCode=holderFails?503:200;body=holderFails?{reason:'upstream_http',source:'Blockscout',upstreamStatus:403}:{...data,source:'Blockscout',holders:[],indexedCount:null,totalSupply:'0'}}
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
