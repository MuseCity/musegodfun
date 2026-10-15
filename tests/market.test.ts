import test from "node:test";
import assert from "node:assert/strict";
import {
  listedTokens,
  sortTokens,
  quoteAsset,
  poolCurrency,
  STOCKS,
} from "../src/lib/config";
import { launchSchema } from "../src/lib/validation";
import { syntheticToken } from "./fixtures";
import {
  MarketReader,
  parseCandles,
  parseMarketSummary,
  parseTrades,
} from "../server/market";
const token = syntheticToken();
const other = syntheticToken({
  address: "0x3333333333333333333333333333333333333333",
  name: "AAA",
  createdAt: token.createdAt + 1000,
  quoteAddress: STOCKS[1].address,
});
test("catalog never injects a pinned asset and both sorts use only registered records", () => {
  const records = [token, other];
  const listed = listedTokens(records, "base");
  assert.equal(listed.length, 2);
  for (const order of ["name", "new"] as const)
    assert.equal(sortTokens(listed, order)[0].address, other.address);
  assert.equal(records[0].address, token.address);
  assert.deepEqual(listedTokens([], "base"), []);
  assert.deepEqual(listedTokens([], "fork"), []);
});
test("catalog filters unsupported quotes, unregistered records and cross-mode assets", () => {
  const fork = syntheticToken({ mode: "fork" });
  const unregistered = syntheticToken({ transactionHash: null });
  const unsupported = syntheticToken({ quoteAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
  assert.deepEqual(listedTokens([token, fork, unregistered, unsupported], "base"), [token]);
  assert.deepEqual(listedTokens([token, fork, unregistered, unsupported], "fork"), [fork]);
});
test("empty catalog does not issue external market requests", async () => {
  let calls = 0;
  const market = new MarketReader({ fetch: async () => { calls++; throw new Error("No pool to request"); } });
  assert.deepEqual(await market.summaries([]), []);
  assert.equal(calls, 0);
});
test("all catalog assets require stock quotes with 8/18 precision and no stablecoin exception", () => {
  const unsupported = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  assert.equal(quoteAsset(token).decimals, 8);
  assert.equal(poolCurrency(token.quoteAddress, token).decimals, 8);
  assert.equal(poolCurrency(token.address, token).decimals, 18);
  assert.throws(() => quoteAsset({ ...other, quoteAddress: unsupported }));
  assert.equal(
    launchSchema.safeParse({
      name: "No",
      symbol: "NO",
      quoteAddress: unsupported,
      description: "",
      image: "",
    }).success,
    false,
  );
});
const pool = {
  data: {
    attributes: {
      address: token.poolId,
      base_token_price_usd: "0.0004",
      fdv_usd: "400000",
      market_cap_usd: null,
      reserve_in_usd: "300000",
      price_change_percentage: { h24: "0" },
      volume_usd: { h24: "10" },
      transactions: { h24: { buys: 0, sells: 1 } },
    },
    relationships: {
      base_token: { data: { id: `base_${token.address.toLowerCase()}` } },
      quote_token: { data: { id: `base_${token.quoteAddress.toLowerCase()}` } },
    },
  },
};
test("market identity checks reject mismatched pools; missing data stays unknown, valid zero survives", () => {
  const stats = parseMarketSummary(pool, token);
  assert.equal(stats.marketCapUsd, null);
  assert.equal(stats.periods.h24.change, 0);
  assert.equal(stats.periods.h24.buys, 0);
  assert.equal(stats.periods.m5.volume, null);
  assert.throws(() =>
    parseMarketSummary(pool, { ...token, poolId: `0x${"0".repeat(64)}` }),
  );
  assert.throws(() =>
    parseMarketSummary(pool, { ...token, quoteAddress: STOCKS[1].address }),
  );
});
const candleData = (rows: number[][]) => ({
  data: { attributes: { ohlcv_list: rows } },
  meta: { base: { address: token.address }, quote: { address: token.quoteAddress } },
});
test("candles sort and deduplicate timestamps, reject impossible OHLC and incorrect asset orientation", () => {
  const rows = [
    [200, 2, 3, 1, 2, 0],
    [100, 1, 2, 0.5, 1.5, 10],
    [100, 1, 2, 0.5, 1.5, 10],
  ];
  assert.deepEqual(
    parseCandles(candleData(rows), token).candles.map((c) => c.time),
    [100, 200],
  );
  assert.equal(parseCandles(candleData(rows), token).candles[1].volume, 0);
  assert.throws(() => parseCandles(candleData([[100, 5, 2, 1, 1, 10]]), token));
  assert.throws(() =>
    parseCandles(candleData(rows), { ...token, address: token.quoteAddress }),
  );
  const missing = candleData(rows);
  (missing.data.attributes.ohlcv_list[0] as unknown[])[1] = null;
  assert.throws(() => parseCandles(missing, token));
});
test("trade side and token amount derive from asset addresses, not provider labels", () => {
  const trade = {
    data: [
      {
        id: "event-1",
        attributes: {
          log_index: 1,
          tx_hash: `0x${"1".repeat(64)}`,
          tx_from_address: STOCKS[0].address,
          block_timestamp: "2026-09-21T12:00:00Z",
          kind: "sell",
          from_token_address: token.quoteAddress,
          to_token_address: token.address,
          from_token_amount: "1",
          to_token_amount: "2500",
          price_from_in_usd: "1",
          price_to_in_usd: "0.0004",
          volume_in_usd: "1",
        },
      },
    ],
  };
  const parsed = parseTrades(trade, token).trades[0];
  assert.equal(parsed.side, "buy");
  assert.equal(parsed.amount, 2500);
  assert.equal(parsed.price, 0.0004);
  assert.throws(() =>
    parseTrades(trade, { ...token, quoteAddress: STOCKS[1].address }),
  );
});
test("fork mode refuses all external mainnet market data before making requests", () => {
  const market = new MarketReader(),
    fork = syntheticToken({ mode: "fork" });
  assert.throws(() => market.summary(fork), /Local forks/);
  assert.throws(() => market.trades(fork), /Local forks/);
  assert.throws(() => market.candles(fork, "1h"), /Local forks/);
  assert.throws(() => market.holders(fork), /Local forks/);
});

test("missing summary sections stay unknown while identity remains mandatory", () => {
  const sparse = {
    ...pool,
    data: { ...pool.data, attributes: { address: token.poolId } },
  };
  const result = parseMarketSummary(sparse, token);
  assert.equal(result.priceUsd, null);
  assert.equal(result.periods.h24.volume, null);
  assert.equal(result.periods.h24.buys, null);
});

test("a cold batch preserves market fields, merges duplicate requests and shares single-pool snapshots", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../server/store");
  const dir = mkdtempSync(join(tmpdir(), "musegod-batch-")),
    store = new Store(dir, 8453);
  let calls = 0;
  const reader = new MarketReader({
    store,
    apiKey: "test",
    fetch: async (url) => {
      calls++;
      assert(String(url).includes("/pools/multi/"));
      return new Response(JSON.stringify({ data: [pool.data] }));
    },
  });
  try {
    const result = await reader.summaries([token]);
    assert.equal(result[0].summary?.priceUsd, 0.0004);
    assert.equal(result[0].summary?.periods.h24.volume, 10);
    assert.equal((await reader.summary(token)).priceUsd, 0.0004);
    assert.equal(calls, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("missing Demo configuration remains diagnosable in single and batch snapshots without leaking errors", async () => {
  const { Store } = await import("../server/store");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "market-reasons-")), store = new Store(dir, 8453);
  let calls = 0;
  try {
    const reader = new MarketReader({ store, fetch: async () => { calls++; throw new Error("secret-url"); } });
    await assert.rejects(reader.summary(token), (e: any) => e.reason === "missing_config" && !e.message.includes("secret-url"));
    const batch = await reader.summaries([token]);
    assert.equal((batch[0] as any).reason, "missing_config");
    assert.equal((batch[0] as any).source, "CoinGecko");
    assert.equal((batch[0] as any).status, "unavailable");
    assert.equal(calls, 0);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test("upstream HTTP causes survive stale snapshots, retry suppression and batch rows", async () => {
  const { Store } = await import("../server/store");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  for (const status of [401, 403, 404, 429]) {
    const dir = mkdtempSync(join(tmpdir(), "market-http-")), store = new Store(dir, 8453);
    let now = Date.now(), failed = false, calls = 0;
    const reader = new MarketReader({ store, apiKey: "fixture", now: () => now, fetch: async () => {
      calls++; return failed ? new Response("private-provider-body", { status, headers: { "retry-after": "3600" } }) : Response.json(pool);
    } });
    try {
      const fresh = await reader.summary(token);
      failed = true; now += 900_001;
      const stale = await reader.summary(token);
      assert.equal(stale.status, "stale"); assert.equal(stale.fetchedAt, fresh.fetchedAt);
      assert.equal((stale as any).reason, status === 429 ? "rate_limited" : status === 404 ? "not_indexed" : "upstream_http");
      assert.equal((stale as any).upstreamStatus, status);
      assert(!JSON.stringify(stale).includes("private-provider-body"));
      assert.equal((await reader.summary(token) as any).reason, (stale as any).reason);
      assert.equal(calls, 2);
      if (status === 429) assert(Date.parse(stale.nextRefreshAt!) >= now + 3_600_000);
    } finally { store.close(); rmSync(dir, { recursive: true }); }
  }
});

test("Robinhood summary validates chain/pool/pair and reverse prices keep token metrics unknown", () => {
  const rh = syntheticToken({ mode: "robinhood", deploymentChainId: 4663 });
  const raw = structuredClone(pool);
  raw.data.relationships.base_token.data.id = `robinhood_${rh.address}`;
  raw.data.relationships.quote_token.data.id = `robinhood_${rh.quoteAddress}`;
  assert.equal(parseMarketSummary(raw, rh).priceUsd, 0.0004);
  assert.throws(() => parseMarketSummary(raw, token));
  [raw.data.relationships.base_token, raw.data.relationships.quote_token] = [raw.data.relationships.quote_token, raw.data.relationships.base_token];
  Object.assign(raw.data.attributes, { quote_token_price_usd: "0.003" });
  const reverse = parseMarketSummary(raw, rh);
  assert.equal(reverse.priceUsd, 0.003); assert.equal(reverse.fdvUsd, null);
  assert.equal(reverse.marketCapUsd, null); assert.equal(reverse.periods.h24.change, null);
  assert.equal(reverse.periods.h24.buys, null); assert.equal(reverse.periods.h24.sells, null);
  assert.equal(reverse.liquidityUsd, 300000); assert.equal(reverse.periods.h24.volume, 10);
  delete (raw.data.attributes as any).quote_token_price_usd;
  assert.equal(parseMarketSummary(raw, rh).priceUsd, null);
});

test("Robinhood summary/trades/holders use their own endpoints and fail independently", async () => {
  const rh = syntheticToken({ mode: "robinhood", deploymentChainId: 4663 });
  const raw = structuredClone(pool);
  raw.data.relationships.base_token.data.id = `robinhood_${rh.address}`;
  raw.data.relationships.quote_token.data.id = `robinhood_${rh.quoteAddress}`;
  const rows = new Map(); const calls: string[] = [];
  const store = { snapshot: (key: string) => rows.get(key), saveSnapshot: (k: string,data: unknown,at: number)=>rows.set(k,{data,at}), reserveMarketCall: ()=>true };
  const reader = new MarketReader({store:store as never, apiKey:"fixture",fetch:async input=>{
    const url=String(input);calls.push(url);assert(!url.includes('/networks/base/'));

    return Response.json(url.endsWith('/trades')?{data:[]}:url.includes('/multi/')?{data:[raw.data]}:raw);
  }});
  const batch=await reader.summaries([rh]); assert.equal(batch[0].summary?.priceUsd,0.0004);
  assert.equal((await reader.summary(rh)).fetchedAt,batch[0].summary?.fetchedAt);
  assert.deepEqual((await reader.trades(rh)).trades,[]);
  await assert.rejects(reader.holders(rh),(e:any)=>e.reason==='source_not_provided');
  assert.equal((await reader.summary(rh)).priceUsd,0.0004);
  assert.equal(calls.length, 2);
});

test("normalized trade amounts are not scaled twice and repeated chain/transaction/log events deduplicate", () => {
  const attributes={tx_hash:`0x${'1'.repeat(64)}`,tx_from_address:token.quoteAddress,block_timestamp:'2026-10-08T09:00:00Z',kind:'sell',from_token_address:token.quoteAddress,to_token_address:token.address,from_token_amount:'0.12345678',to_token_amount:'12.123456789012345678',volume_in_usd:'1',log_index:7};
  const raw={data:[{id:'first',attributes},{id:'duplicate',attributes},{id:'second',attributes:{...attributes,log_index:8}}]};
  const result=parseTrades(raw,token);
  assert.equal(result.trades.length,2); assert.equal(result.trades[0].amount,12.123456789012345678);
  assert.notEqual(result.trades[0].id,result.trades[1].id);
});

test("snapshot identities isolate pool/quote/version and preserve legacy records", async () => {
  const rows=new Map<string,any>([[`${token.address}:summary`,{data:{priceUsd:99},at:Date.now()}]]);
  let calls=0;
  const reader=new MarketReader({store:{snapshot:(k:string)=>rows.get(k),saveSnapshot:(k:string,data:unknown,at:number)=>rows.set(k,{data,at}),reserveMarketCall:()=>true} as never,apiKey:'fixture',fetch:async()=>{calls++;return Response.json(pool)}});
  await reader.summary(token);
  await assert.rejects(reader.summary({...token,poolId:`0x${'c'.repeat(64)}`}));
  await assert.rejects(reader.summary({...token,quoteAddress:STOCKS[1].address}));
  assert.equal(calls,3);assert(rows.has(`${token.address}:summary`));
  const key=[...rows.keys()].find(k=>k!==`${token.address}:summary`)!;
  assert(key.includes('v2')&&key.includes('8453')&&key.includes(token.poolId.toLowerCase())&&key.includes(token.quoteAddress.toLowerCase()));
});

test("30-pool homepage batches coalesce with concurrent detail reads and cache hits cost no quota", async () => {
  const tokens=Array.from({length:30},(_,i)=>syntheticToken({address:`0x${(i+1).toString(16).padStart(40,'0')}`,poolId:`0x${(i+1).toString(16).padStart(64,'0')}`}));
  const rows=new Map();let calls=0,quota=0;
  const reader=new MarketReader({store:{snapshot:(k:string)=>rows.get(k),saveSnapshot:(k:string,data:unknown,at:number)=>rows.set(k,{data,at}),reserveMarketCall:()=>{quota++;return true}} as never,apiKey:'fixture',fetch:async url=>{
    calls++;assert(String(url).includes('/multi/'));return Response.json({data:tokens.map(t=>({...pool.data,attributes:{...pool.data.attributes,address:t.poolId},relationships:{...pool.data.relationships,base_token:{data:{id:`base_${t.address}`}}}}))});
  }});
  const [batch,duplicate]=await Promise.all([reader.summaries(tokens),reader.summaries(tokens)]);
  assert.equal(batch.length,30);assert(batch.every(r=>r.summary?.priceUsd===0.0004));assert.deepEqual(batch,duplicate);
  await Promise.all(tokens.map(t=>reader.summary(t)));
  assert.equal(calls,1);assert.equal(quota,1);
});

test("quota, schema and transport errors remain failures while holders bypass Demo quota", async () => {
  for(const [kind,fetcher] of [['invalid_schema',async()=>new Response('not-json')],['upstream_transport',async()=>{throw new Error('private-token-in-url')}]] as const){
    const rows=new Map();const reader=new MarketReader({store:{snapshot:(k:string)=>rows.get(k),saveSnapshot:(k:string,data:unknown,at:number)=>rows.set(k,{data,at}),reserveMarketCall:()=>true} as never,apiKey:'fixture',fetch:fetcher});
    await assert.rejects(reader.summary(token),(e:any)=>e.reason===kind&&!JSON.stringify(e).includes('private-token-in-url'));
    assert.equal(rows.size,0);
  }
  let fetches=0;const reader=new MarketReader({store:{snapshot:()=>null,saveSnapshot:()=>{},reserveMarketCall:()=>false} as never,apiKey:'fixture',fetch:async()=>{fetches++;return new Response(null,{status:403})}});
  await assert.rejects(reader.summary(token),(e:any)=>e.reason==='quota_exhausted');assert.equal(fetches,0);
  await assert.rejects(reader.holders(token),(e:any)=>e.reason==='source_not_provided');assert.equal(fetches,0);
});

test("a missing multi-pool row preserves not-indexed state without inventing an upstream 404", async () => {
  const reader=new MarketReader({store:{snapshot:()=>null,saveSnapshot:()=>{},reserveMarketCall:()=>true} as never,apiKey:'fixture',fetch:async()=>Response.json({data:[]})});
  const [row]=await reader.summaries([token]);assert.equal(row.reason,'not_indexed');assert.equal(row.upstreamStatus,undefined);assert.equal(row.summary,null);
});

test("Robinhood WETH 18-decimal quotes keep normalized sell amounts and exact asset direction", () => {
  const rh=syntheticToken({mode:'robinhood',deploymentChainId:4663,quoteAddress:'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'});
  const attributes={tx_hash:`0x${'2'.repeat(64)}`,log_index:12,tx_from_address:rh.quoteAddress,block_timestamp:'2026-10-08T09:00:00Z',kind:'buy',from_token_address:rh.address,to_token_address:rh.quoteAddress,from_token_amount:'0.123456789012345678',to_token_amount:'0.000000000000000001',volume_in_usd:null};
  const [trade]=parseTrades({data:[{id:'fixture-sell',attributes}]},rh).trades;
  assert.equal(trade.side,'sell');assert.equal(trade.amount,0.123456789012345678);assert.equal(trade.usd,null);assert.match(trade.id,/^4663:/);
});


test("unknown target USD prices suppress placeholder valuations; zero volume requires confirmed zero trades", () => {
  // R1 reverse / R2 forward response shape from Run 1 cg-4663 summaries.
  for (const reverse of [false, true]) {
    const raw = structuredClone(pool);
    Object.assign(raw.data.attributes, { base_token_price_usd: null, quote_token_price_usd: null,
      reserve_in_usd: "0.0", fdv_usd: "0", price_change_percentage: { h24: "0" },
      volume_usd: { h24: "0", h1: "0", m5: "2" },
      transactions: { h24: { buys: 0, sells: 0 }, h1: { buys: 1, sells: 0 } } });
    if (reverse) [raw.data.relationships.base_token, raw.data.relationships.quote_token] = [raw.data.relationships.quote_token, raw.data.relationships.base_token];
    const stats = parseMarketSummary(raw, token);
    assert.equal(stats.priceUsd, null); assert.equal(stats.liquidityUsd, null); assert.equal(stats.fdvUsd, null);
    assert.equal(stats.periods.h24.change, null); assert.equal(stats.periods.h24.volume, 0);
    assert.equal(stats.periods.h1.volume, null); assert.equal(stats.periods.m5.volume, null);
  }
});

test("provider ids decode the observed Base trade shape and unknown RH ids retain distinct events", () => {
  // Source: Run 2 evidence/run2-base-trades.json, observed 2026-10-15T10:47:57.321Z.
  // Nonregistered KAI/NVDAc parser fixture; the id segment is inferred, not receipt-verified logIndex.
  const base = syntheticToken({ address: "0xca18a528ea897040f715edc92e6e4572780c5ca1", quoteAddress: "0xb20000000000000000000078ee7ce2fe4908108c" });
  const attributes = { tx_hash: "0x52688c9c63de8fad9c1e022252690fea0ca5bf7e59f89254e0577e0e08dab415",
    tx_from_address: "0x75cddbbbec8794f90ec75900501cfbe24da32714", block_timestamp: "2026-10-15T10:45:37Z", kind: "sell",
    from_token_address: base.quoteAddress, to_token_address: base.address, from_token_amount: "0.36782377", to_token_amount: "150458.486958072",
    price_from_in_usd: "223.929238307085", price_to_in_usd: "0.000512397420179925", volume_in_usd: "82.3664966473405" };
  const row = { id: `base_52635895_${attributes.tx_hash}_811_1792061150`, attributes };
  const parsed = parseTrades({ data: [row, row, { ...row, attributes: { ...attributes, log_index: 811 } }] }, base).trades;
  assert.equal(parsed.length, 1); assert.match(parsed[0].id, /:811$/); assert.equal(parsed[0].side, "buy");
  assert.equal(parsed[0].amount, 150458.486958072);
  const rh = { ...base, mode: "robinhood" as const, deploymentChainId: 4663 as const };
  const rhRow = { ...row, id: row.id.replace("base_", "robinhood_") };
  const events = parseTrades({ data: [rhRow, { ...row, id: "unknown-provider-event-a" }, { ...row, id: "unknown-provider-event-b" }, { ...row, id: "unknown-provider-event-a" }] }, rh).trades;
  assert.equal(events.length, 3); assert.equal(new Set(events.map(t => t.id)).size, 3);
});

test("holders on both mainnets bypass fetch, snapshot reads/writes and quota while preserving history", async () => {
  const history = new Map([["old:holders", { holders: ["historical"] }]]);
  let calls = 0;
  const touch = () => { calls++; throw new Error("holders must not touch dependencies"); };
  const reader = new MarketReader({ store: { snapshot: touch, saveSnapshot: touch, reserveMarketCall: touch } as never, fetch: touch as typeof fetch });
  for (const mode of ["base", "robinhood"] as const) {
    await assert.rejects(reader.holders(syntheticToken({ mode, deploymentChainId: mode === "base" ? 8453 : 4663 })), (e: any) => e.reason === "source_not_provided" && e.status === "unavailable" && !('holders' in e));
  }
  assert.equal(calls, 0); assert.equal(history.size, 1);
});

test("candles reserve the 100/day 3000/month subquota before shared quota on both chains", async () => {
  for (const mode of ["base", "robinhood"] as const) {
    for (const reject of ["candles", "shared", "none"]) {
      const quotas: unknown[][] = []; let cg = 0;
      const reader = new MarketReader({ apiKey: "fixture", store: { snapshot: () => null, saveSnapshot: () => {},
        reserveMarketCall: (...args: unknown[]) => { quotas.push(args.slice(1)); return (args[3] ?? "shared") !== reject; } } as never,
        fetch: async input => { if (new URL(String(input)).hostname !== "api.coingecko.com") return new Response(null, { status: 404 }); cg++; return Response.json(candleData([])); } });
      const t = { ...token, mode, deploymentChainId: mode === "base" ? 8453 as const : 4663 as const };
      if (reject === "none") await reader.candles(t, "1h");
      else await assert.rejects(reader.candles(t, "1h"), (e: any) => e.reason === "quota_exhausted");
      assert.deepEqual(quotas[0], [100, 3000, "candles"]);
      assert.equal(quotas.length, reject === "candles" ? 1 : 2); assert.equal(cg, reject === "none" ? 1 : 0);
    }
  }
});

test("storage and unexpected program errors are distinct from provider transport failures", async () => {
  const touch = () => { throw new Error("private storage details"); };
  const reader = new MarketReader({ store: { snapshot: touch } as never });
  await assert.rejects(reader.summary(token), (e: any) => e.reason === "storage_unavailable" && e.source === "Storage" && !JSON.stringify(e).includes("private storage"));
  assert.equal((await reader.summaries([token]))[0].reason, "storage_unavailable");
  let saves = 0;
  const fresh = await new MarketReader({ store: { snapshot: () => null, saveSnapshot: () => { saves++; touch(); }, reserveMarketCall: () => true } as never,
    apiKey: "fixture", fetch: async () => Response.json(pool) }).summary(token);
  assert.equal(fresh.priceUsd, 0.0004); assert.equal(fresh.reason, "storage_unavailable"); assert.equal(saves, 1);
  const { Snapshots } = await import("../server/snapshots");
  await assert.rejects(new Snapshots({ snapshot: () => null } as never).get("program", "CoinGecko", async () => { throw new ReferenceError("private parser bug"); }), (e: any) => e.reason === "internal_error" && e.source === "CoinGecko" && e.causes[0].source === "Internal");
});

test("failed snapshot writes retain fetched data for one TTL without repeating upstream or quota calls", async () => {
  const { SNAPSHOT_TTL } = await import("../server/snapshots");
  let now = Date.now(), calls = 0, quota = 0, writes = 0, reads = 0;
  const reader = new MarketReader({ apiKey: "fixture", now: () => now,
    store: { snapshot: () => { reads++; return null; }, saveSnapshot: () => { writes++; throw new Error("private storage"); },
      reserveMarketCall: () => { quota++; return true; } } as never,
    fetch: async () => { calls++; return Response.json(pool); } });
  const first = await reader.summary(token);
  for (let i = 0; i < 5; i++) assert.deepEqual(await reader.summary(token), first);
  assert.deepEqual((await reader.summaries([token]))[0].summary, first);
  assert.deepEqual({ calls, quota, writes, reads }, { calls: 1, quota: 1, writes: 1, reads: 1 });
  assert.equal(first.reason, "storage_unavailable");
  now += SNAPSHOT_TTL;
  const next = await reader.summary(token);
  assert.equal(calls, 2); assert.equal(quota, 2); assert.notEqual(next.fetchedAt, first.fetchedAt);
});

test("network failures and unclassified errors do not masquerade as internal program errors", async () => {
  const { marketFailure } = await import("../server/snapshots");
  for (const error of [new TypeError("private fetch details"), new DOMException("private", "AbortError"), new DOMException("private", "TimeoutError")]) {
    const failure = marketFailure(error, "Bankr");
    assert.equal(failure.reason, "upstream_transport"); assert.equal(failure.source, "Bankr");
    assert.doesNotMatch(JSON.stringify(failure), /private|Internal/);
  }
  assert.equal(marketFailure(new Error("unclassified"), "Bankr").reason, "upstream_unclassified");
});
